"""Bounded, public-only image-post retrieval, isolated from speech recognition.

The TikTok adapter intentionally targets the raw-data helper in the pinned
2026.10.21 yt-dlp dependency. Keep that dependency and its fixture tests together.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
from local_processes import start as start_local_process
import sys
import tempfile
import time
from itertools import islice
from urllib.parse import parse_qs, urljoin, urlsplit

MAX_IMAGES = 35
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_POST_BYTES = 80 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
IMAGE_POST_TIMEOUT = 180
TIKTOK_HOSTS = {"tiktok.com", "www.tiktok.com", "m.tiktok.com", "vt.tiktok.com", "vm.tiktok.com"}
INSTAGRAM_HOSTS = {"instagram.com", "www.instagram.com", "m.instagram.com"}
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"}
CDN_DOMAINS = {
    "tiktok": ("tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokv.com", "byteoversea.com", "ibytedtos.com", "muscdn.com"),
    "instagram": ("cdninstagram.com", "fbcdn.net"),
}


class ImagePostError(ValueError):
    """Safe, user-visible error that never embeds upstream URLs or headers."""


class _QuietLogger:
    def debug(self, *_): pass
    def info(self, *_): pass
    def warning(self, *_): pass
    def error(self, *_): pass


def _url_parts(value: str):
    try:
        if (not isinstance(value, str) or not value or len(value) > 2048
                or re.search(r"[\x00-\x20\x7f\\]", value)
                or re.search(r"%(?![0-9a-f]{2})", value, re.I)):
            raise ValueError()
        parsed = urlsplit(value)
        if (parsed.scheme != "https" or parsed.username is not None or parsed.password is not None
                or parsed.port not in (None, 443)):
            raise ValueError()
        return parsed
    except (ValueError, TypeError):
        raise ImagePostError("Use an HTTPS link to one supported post.") from None


def normalize_post_url(value: str) -> tuple[str, str]:
    """Validate a single post before following any short-link redirects."""
    parsed = _url_parts(value)
    host, path = (parsed.hostname or "").lower(), parsed.path
    if re.search(r"(?:^|/)(?:\.|%2e){1,2}(?:/|$)|%2f|%5c|%25", path, re.I):
        raise ImagePostError("Use a direct link to one supported post.")
    if host in TIKTOK_HOSTS:
        if host in {"vt.tiktok.com", "vm.tiktok.com"}:
            valid = re.fullmatch(r"/[A-Za-z0-9_-]{4,80}/?", path)
        else:
            valid = re.fullmatch(r"/@[^/]+/(?:photo|video)/\d{10,25}/?|/t/[A-Za-z0-9_-]{4,80}/?", path)
        if valid:
            return "tiktok", "https://" + host + path
    elif host in INSTAGRAM_HOSTS:
        if match := re.fullmatch(r"/(p|reel|reels)/([A-Za-z0-9_-]{5,64})/?", path):
            return "instagram", f"https://www.instagram.com/{'p' if match[1] == 'p' else 'reel'}/{match[2]}/"
    elif host in YOUTUBE_HOSTS:
        video_id = None
        if host in {"youtu.be", "www.youtu.be"}:
            match = re.fullmatch(r"/([A-Za-z0-9_-]{11})/?", path)
            video_id = match[1] if match else None
        elif path in {"/watch", "/watch/"}:
            values = parse_qs(parsed.query, keep_blank_values=True).get("v", [])
            video_id = values[0] if len(values) == 1 else None
        elif match := re.fullmatch(r"/shorts/([A-Za-z0-9_-]{11})/?", path):
            video_id = match[1]
        if video_id and re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            return "youtube", "https://www.youtube.com/watch?v=" + video_id
    raise ImagePostError("Use a TikTok post, Instagram post, or YouTube video link. Profiles and playlists are not supported.")


def _cdn_url(value: str, platform: str) -> str:
    parsed = _url_parts(value)
    host = (parsed.hostname or "").lower()
    if parsed.fragment or not any(host == domain or host.endswith("." + domain) for domain in CDN_DOMAINS[platform]):
        raise ImagePostError("The post returned an unsupported image source.")
    return value


def _resolve_tiktok_share(url: str) -> str:
    import requests

    with requests.Session() as session:
        session.trust_env = False
        for _ in range(5):
            platform, url = normalize_post_url(url)
            if platform != "tiktok":
                raise ImagePostError("The shared link redirected outside TikTok.")
            parsed = urlsplit(url)
            if re.fullmatch(r"/@[^/]+/(?:photo|video)/\d{10,25}/?", parsed.path):
                return "https://www.tiktok.com" + parsed.path
            # No browser credentials, automatic redirects, or response body.
            with session.head(url, headers={"User-Agent": "facebookexternalhit/1.1"},
                              allow_redirects=False, timeout=(5, 10)) as response:
                if response.status_code not in {301, 302, 303, 307, 308} or not response.headers.get("Location"):
                    raise ImagePostError("TikTok did not resolve this shared post. Try its full post link.")
                target = urljoin(url, response.headers["Location"])
                try:
                    target_platform, target = normalize_post_url(target)
                except ImagePostError:
                    raise ImagePostError("TikTok did not resolve this shared post. Try its full post link.") from None
                if target_platform != "tiktok":
                    raise ImagePostError("The shared link redirected outside TikTok.")
                url = target
    raise ImagePostError("The TikTok share link redirected too many times.")


def _ordered_candidates(items: list[dict], platform: str) -> list[str]:
    """Prefer resolution; yt-dlp lists Instagram candidates low-to-high.

    Some API responses omit dimensions. Later candidates must win those ties,
    otherwise the first 150-pixel square thumbnail becomes the OCR source.
    """
    def area(item):
        try:
            return max(0, int(item.get("width") or 0)) * max(0, int(item.get("height") or 0))
        except (ValueError, TypeError):
            return 0
    ordered = sorted(enumerate(items), key=lambda pair: (area(pair[1]), pair[0]), reverse=True)
    urls = []
    for _, item in ordered:
        value = item.get("url")
        if not value:
            continue
        value = _cdn_url(value, platform)
        if value not in urls:
            urls.append(value)
    if not urls:
        raise ImagePostError("One of the post's images is unavailable. No slides were omitted.")
    return urls[:3]


def _post_images(url: str, platform: str, cache_dir: Path | None = None) -> dict | None:
    from yt_dlp import YoutubeDL

    options = {"ignoreconfig": True, "cachedir": False, "quiet": True, "no_warnings": True,
               "logger": _QuietLogger(), "socket_timeout": 10, "retries": 0, "extractor_retries": 0,
               "noplaylist": True, "ignore_no_formats_error": True, "proxy": "", "usenetrc": False,
               "cookiefile": None, "cookiesfrombrowser": None}
    with YoutubeDL(options) as extractor:
        if platform == "tiktok":
            url = _resolve_tiktok_share(url)
            post_id = url.rstrip("/").rsplit("/", 1)[-1]
            ie = extractor.get_info_extractor("TikTok")
            ie.initialize()
            # Isolated private API dependency; do not route to a generic extractor.
            raw, status = ie._extract_web_data_and_status(url.replace("/photo/", "/video/", 1), post_id)
            if status or not isinstance(raw, dict):
                raise ImagePostError("TikTok did not provide this public post. It may require sign-in or be unavailable.")
            if "imagePost" not in raw:
                # Classify only. The video downloader must extract metadata in
                # its own live session so TikTok's challenge cookies accompany
                # its media request; serialized format URLs are insufficient.
                return None
            images = raw.get("imagePost", {}).get("images")
            if not isinstance(images, list) or not images:
                raise ImagePostError("This TikTok image post contains no accessible images.")
            if len(images) > MAX_IMAGES:
                raise ImagePostError("This post exceeds the 35-image limit.")
            slides = []
            for image in images:
                urls = image.get("imageURL", {}).get("urlList") if isinstance(image, dict) else None
                if not isinstance(urls, list) or not urls:
                    raise ImagePostError("One of the post's images is unavailable. No slides were omitted.")
                # TikTok supplies equivalent originals; retain its preference order.
                slides.append(list(dict.fromkeys(_cdn_url(value, platform) for value in urls))[:3])
            author = raw.get("author") or {}
            return {"slides": slides, "metadata": {"title": str(raw.get("desc") or "TikTok image post")[:500],
                    "creator": str(author.get("uniqueId") or author.get("nickname") or "")[:200],
                    "postId": post_id, "canonicalUrl": url}}

        raw = extractor.extract_info(url, download=False, process=False)
        if not isinstance(raw, dict) or str(raw.get("extractor_key", "")).lower() != "instagram":
            raise ImagePostError("The link did not resolve to a single Instagram post.")
        if raw.get("availability") in {"private", "needs_auth", "premium_only", "subscriber_only"}:
            raise ImagePostError("This Instagram post requires sign-in. Only public posts are supported.")
        if raw.get("_type", "video") not in {"video", "playlist"}:
            raise ImagePostError("The link did not resolve to a single Instagram post.")
        entries = list(islice(raw.get("entries") or [], MAX_IMAGES + 1)) if raw.get("_type") == "playlist" else [raw]
        if not entries:
            raise ImagePostError("This Instagram post contains no accessible images.")
        if len(entries) > MAX_IMAGES:
            raise ImagePostError("This post exceeds the 35-image limit.")
        videos = 0
        slides = []
        for entry in entries:
            if (not isinstance(entry, dict) or entry.get("_type", "video") != "video"
                    or str(entry.get("extractor_key", "instagram")).lower() != "instagram"):
                raise ImagePostError("The Instagram post returned an unsupported slide.")
            if entry.get("formats") or entry.get("duration") is not None:
                videos += 1
            else:
                slides.append(_ordered_candidates(entry.get("thumbnails") or [], platform))
        if videos and slides:
            raise ImagePostError("Mixed image-and-video carousels are not supported yet. Share an image-only post or a single video.")
        if videos:
            if cache_dir:
                from checkpoints import atomic_json
                atomic_json(cache_dir / "video-info.json", raw)
            return None
        return {"slides": slides, "metadata": {"title": str(raw.get("description") or raw.get("title") or "Instagram image post")[:500],
                "creator": str(raw.get("channel") or raw.get("uploader") or "")[:200],
                "postId": url.rstrip("/").rsplit("/", 1)[-1], "canonicalUrl": url}}


def _download_image(url: str, destination: Path, platform: str, budget: dict) -> None:
    import requests

    url = _cdn_url(url, platform)
    limit = min(MAX_IMAGE_BYTES, budget["remaining"])
    if limit <= 0:
        raise ImagePostError("This image post exceeds the 80 MB download limit.")
    started = time.monotonic()
    with requests.Session() as session:
        session.trust_env = False
        with session.get(url, stream=True, allow_redirects=False, timeout=(5, 10)) as response:
            if response.status_code != 200:
                raise ImagePostError("One of the post's images could not be retrieved.")
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
            if content_type not in {"image/jpeg", "image/jpg", "image/png", "image/webp"}:
                raise ImagePostError("The post returned an unsupported image format.")
            length = response.headers.get("Content-Length")
            if length and int(length) > limit:
                raise ImagePostError("A post image exceeds the 10 MB image or 80 MB post limit.")
            total = 0
            with destination.open("wb") as output:
                while True:
                    if time.monotonic() - started > 25:
                        raise ImagePostError("Image retrieval timed out. Try the post again.")
                    chunk = response.raw.read(min(64 * 1024, limit - total + 1), decode_content=True)
                    if not chunk:
                        break
                    total += len(chunk)
                    budget["remaining"] -= len(chunk)
                    if total > limit:
                        raise ImagePostError("A post image exceeds the 10 MB image or 80 MB post limit.")
                    output.write(chunk)
            if not total:
                raise ImagePostError("The post returned an empty image.")


def _validate_image(path: Path) -> str:
    with path.open("rb") as source:
        header = source.read(12)
    if header.startswith(b"\xff\xd8\xff"):
        expected, extension = "mjpeg", ".jpg"
    elif header.startswith(b"\x89PNG\r\n\x1a\n"):
        expected, extension = "png", ".png"
    elif header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        expected, extension = "webp", ".webp"
    else:
        raise ImagePostError("The downloaded file was not a supported image.")
    executable = shutil.which("ffprobe")
    if not executable:
        raise ImagePostError("ffprobe is required to read image posts.")
    result = subprocess.run([executable, "-v", "error", "-max_alloc", "100000000", "-protocol_whitelist", "file,pipe",
                             "-show_entries", "stream=codec_name,width,height", "-of", "json", str(path)],
                            check=True, capture_output=True, text=True, timeout=15)
    streams = json.loads(result.stdout).get("streams") or []
    if len(streams) != 1:
        raise ImagePostError("The downloaded file was not a single image.")
    image = streams[0]
    width, height = int(image.get("width") or 0), int(image.get("height") or 0)
    if (image.get("codec_name") != expected or width <= 0 or height <= 0
            or width > 16000 or height > 16000 or width * height > MAX_IMAGE_PIXELS):
        raise ImagePostError("The image dimensions are unsupported or exceed the 40-megapixel limit.")
    return extension


def _retrieve(url: str, directory: Path, *, cover_only=False) -> dict | None:
    platform, url = normalize_post_url(url)
    if platform == "youtube":
        return None
    post = _post_images(url, platform, directory)
    if post is None:
        return None
    budget = {"remaining": MAX_POST_BYTES}
    paths = []
    for index, candidates in enumerate(post["slides"][:1] if cover_only else post["slides"], 1):
        path = directory / f"slide-{index:02d}.image"
        cached = next((candidate for extension in (".jpg", ".png", ".webp")
                       if (candidate := path.with_suffix(extension)).is_file()), None)
        if cached and not cached.is_symlink():
            _validate_image(cached)
            budget["remaining"] -= cached.stat().st_size
            if budget["remaining"] < 0:
                raise ImagePostError("This image post exceeds the 80 MB download limit.")
            paths.append(cached.name)
            continue
        last_error = None
        for candidate in candidates:
            try:
                _download_image(candidate, path, platform, budget)
                extension = _validate_image(path)
                final = path.with_suffix(extension)
                path.rename(final)
                paths.append(final.name)
                break
            except Exception as error:
                path.unlink(missing_ok=True)
                last_error = error
        else:
            if isinstance(last_error, ImagePostError):
                raise last_error
            raise ImagePostError("One of the post's images could not be read. No slides were omitted.") from None
    return {"paths": paths, "metadata": post["metadata"], "contentKind": "image" if len(paths) == 1 else "carousel"}


def retrieve_image_post(url: str, directory: Path, *, cover_only=False) -> dict | None:
    """Return original ordered images, or None for a normal video/YouTube URL.

    A separate process gives metadata, HTTP, and decoding one hard wall-clock
    deadline. It receives only the public URL and scratch directory, not the
    worker's in-memory Site credentials or browser/account cookies.
    """
    platform, url = normalize_post_url(url)
    if platform == "youtube":
        return None
    directory = Path(directory).resolve()
    scratch = directory / ("image-cover" if cover_only else "image-post")
    scratch.mkdir(exist_ok=True, mode=0o700)
    if scratch.is_symlink():
        raise ImagePostError("Invalid local image directory.")
    process = None
    try:
        environment = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL") if key in os.environ}
        process = start_local_process([sys.executable, str(Path(__file__).resolve()), "--cover" if cover_only else "--retrieve", url, str(scratch)],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   env=environment, start_new_session=True)
        try:
            code = process.wait(timeout=IMAGE_POST_TIMEOUT)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
            raise ImagePostError("Image retrieval timed out. Try the post again.") from None
        result = scratch / "result.json"
        if code or not result.is_file() or result.stat().st_size > 20000:
            raise ImagePostError("This post could not be retrieved. It may require sign-in or currently block automatic access.")
        payload = json.loads(result.read_text())
        if payload.get("error"):
            raise ImagePostError(payload["error"])
        value = payload.get("post")
        if value is None:
            cached = scratch / "video-info.json"
            if cached.is_file() and cached.stat().st_size <= 4_000_000:
                os.replace(cached, directory / "video-info.json")
            shutil.rmtree(scratch)
            return None
        if value.get("contentKind") not in {"image", "carousel"} or not 1 <= len(value.get("paths", [])) <= MAX_IMAGES:
            raise ImagePostError("The post returned an invalid image list.")
        paths = [scratch / name for name in value["paths"]]
        if any(path.parent != scratch or path.is_symlink() or not path.is_file() for path in paths):
            raise ImagePostError("The post returned an invalid image file.")
        result.unlink()
        return {**value, "paths": paths}
    except BaseException:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        # Successfully retrieved slides survive network interruption and retry.
        raise


def _main():
    if len(sys.argv) != 4 or sys.argv[1] not in {"--retrieve", "--cover"}:
        raise SystemExit(2)
    target = Path(sys.argv[3])
    try:
        payload = {"post": _retrieve(sys.argv[2], target, cover_only=sys.argv[1] == "--cover")}
    except ImagePostError as error:
        payload = {"error": str(error)}
    except Exception:
        payload = {"error": "This post could not be retrieved. It may require sign-in or currently block automatic access."}
    (target / "result.json").write_text(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    _main()
