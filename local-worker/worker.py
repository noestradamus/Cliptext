#!/usr/bin/env python3
"""Cliptext's local, credential-in-memory media retrieval, speech and OCR worker."""
from __future__ import annotations

import argparse
import contextlib
import gc
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
import threading
import time
from urllib.parse import parse_qs, urlsplit

from checkpoints import atomic_json, read_json, job_directory, local_file


DEFAULT_MODEL = "mlx-community/whisper-large-v3-mlx"
MAX_DURATION = 20 * 60
MAX_BYTES = 80 * 1024 * 1024
MAX_PREVIEW_BYTES = 150 * 1024
MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024
MAX_FRAME_SOURCE_BYTES = 12 * 1024 * 1024
PREVIEW_TIMEOUT = 90
PREVIEW_CDN_DOMAINS = {
    "youtube": ("ytimg.com", "ggpht.com", "googlevideo.com"),
    "tiktok": ("tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokv.com", "byteoversea.com", "ibytedtos.com", "muscdn.com"),
    "instagram": ("cdninstagram.com", "fbcdn.net"),
}
TIKTOK_HOSTS = {"tiktok.com", "www.tiktok.com", "vt.tiktok.com", "vm.tiktok.com", "m.tiktok.com"}
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"}
INSTAGRAM_HOSTS = {"instagram.com", "www.instagram.com", "m.instagram.com"}
PLATFORM_NAMES = {"tiktok": "TikTok", "youtube": "YouTube", "instagram": "Instagram"}
STOP = threading.Event()


def stop_worker(*_):
    STOP.set()
    from local_processes import stop_all
    stop_all()


def log(event: str, **metadata) -> None:
    print(json.dumps({"event": event, **metadata}, ensure_ascii=False), flush=True)


def validate_video_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("Paste a TikTok, YouTube video, or Instagram reel/post link.")
    value = value.strip()
    try:
        if re.search(r"[\x00-\x20\x7f]", value) or "\\" in value or re.search(r"%(?![0-9a-f]{2})", value, re.IGNORECASE):
            raise ValueError("Invalid URL characters")
        parsed = urlsplit(value)
        host, path = (parsed.hostname or "").lower(), parsed.path
        if parsed.scheme.lower() != "https" or parsed.username is not None or parsed.password is not None or parsed.port not in (None, 443):
            raise ValueError("Invalid URL authority")
        # Reject before canonicalization, including encoded separators and
        # nested encodings, so traversal cannot become a supported path later.
        if re.search(r"(?:^|/)(?:\.|%2e){1,2}(?:/|$)|%2f|%5c|%25", path, re.IGNORECASE):
            raise ValueError("Invalid URL path")
        if host in TIKTOK_HOSTS:
            if host in {"vt.tiktok.com", "vm.tiktok.com"}:
                valid = re.fullmatch(r"/[A-Za-z0-9_-]{4,80}/?", path)
            else:
                valid = re.fullmatch(r"/@[^/]+/(?:video|photo)/\d{10,25}/?|/t/[A-Za-z0-9_-]{4,80}/?", path)
            if valid:
                return "https://" + host + path
        elif host in YOUTUBE_HOSTS:
            video_id = None
            if host in {"youtu.be", "www.youtu.be"}:
                match = re.fullmatch(r"/([A-Za-z0-9_-]{11})/?", path)
                video_id = match.group(1) if match else None
            elif path in {"/watch", "/watch/"}:
                values = parse_qs(parsed.query, keep_blank_values=True).get("v", [])
                video_id = values[0] if len(values) == 1 else None
            else:
                match = re.fullmatch(r"/shorts/([A-Za-z0-9_-]{11})/?", path)
                video_id = match.group(1) if match else None
            if video_id and re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
                return "https://www.youtube.com/watch?v=" + video_id
        elif host in INSTAGRAM_HOSTS:
            match = re.fullmatch(r"/(reel|reels|p)/([A-Za-z0-9_-]{5,64})/?", path)
            if match:
                kind = "p" if match.group(1) == "p" else "reel"
                return "https://www.instagram.com/" + kind + "/" + match.group(2) + "/"
    except (ValueError, TypeError):
        pass
    raise ValueError("Use an HTTPS TikTok video/photo post, YouTube watch/Shorts link, or Instagram reel/post. Profiles and playlists are not supported.")


def video_platform(url: str) -> str:
    host = urlsplit(validate_video_url(url)).hostname
    if host in TIKTOK_HOSTS:
        return "tiktok"
    return "youtube" if host in YOUTUBE_HOSTS else "instagram"


def canonical_identity(url: str) -> dict | None:
    url = validate_video_url(url)
    platform = video_platform(url)
    path = urlsplit(url).path
    if platform == "youtube":
        post_id = parse_qs(urlsplit(url).query)["v"][0]
    elif platform == "instagram":
        post_id = path.strip("/").split("/")[1]
    else:
        match = re.fullmatch(r"/@[^/]+/(?:photo|video)/(\d{10,25})/?", path)
        if not match:
            return None
        post_id = match[1]
        url = "https://www.tiktok.com" + path
    return {"platform": platform, "postId": post_id, "canonicalUrl": url}


def validate_tiktok_url(value: str) -> str:
    """Compatibility alias for callers that intentionally accept TikTok only."""
    normalized = validate_video_url(value)
    if video_platform(normalized) != "tiktok":
        raise ValueError("Use a TikTok video link.")
    return normalized


def safe_error(error: BaseException, secrets=()) -> str:
    value = str(error)
    for secret in secrets:
        if secret:
            value = value.replace(secret, "[redacted]")
    value = re.sub(r"https?://\S+", "[media address]", value)
    value = re.sub(r"Bearer\s+\S+", "Bearer [redacted]", value)
    value = re.sub(r"\x1b\[[0-9;]*m", "", value)
    return value[:700]


def runtime_path(value=None) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    # This default stays inside the originating task, separate from published source.
    return Path(__file__).resolve().parents[3] / "work" / "cliptext-engine"


def configure_cache(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(root / "huggingface"))
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def model_directory(root: Path, repository: str) -> Path:
    # Only a public model repository name, never Python source or remote code.
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Invalid local speech model repository.")
    return root / "models" / repository.replace("/", "--")


def prepare_model(root: Path, repository: str) -> Path:
    configure_cache(root)
    from huggingface_hub import snapshot_download

    target = model_directory(root, repository)
    if (target / "config.json").is_file() and any((target / name).is_file() for name in ("weights.npz", "weights.safetensors")):
        return target
    snapshot_download(repository, local_dir=str(target), allow_patterns=["config.json", "weights.safetensors", "weights.npz"])
    if not (target / "config.json").is_file():
        raise RuntimeError("The local speech model could not be downloaded.")
    return target


def transcribe_file(path: Path, model: Path) -> dict:
    import mlx_whisper

    result = mlx_whisper.transcribe(
        str(path),
        path_or_hf_repo=str(model),
        verbose=None,
        word_timestamps=False,
        condition_on_previous_text=False,
    )
    segments = [
        {"start": round(float(item["start"]), 3), "end": round(float(item["end"]), 3), "text": str(item["text"]).strip()}
        for item in result.get("segments", [])
        if str(item.get("text", "")).strip()
    ]
    return {"transcript": str(result.get("text", "")).strip(), "language": result.get("language") or "unknown", "segments": segments}


def ffmpeg_executable(name: str) -> str:
    executable = shutil.which(name)
    if not executable:
        raise RuntimeError(f"{name} is required by the local transcription engine.")
    return executable


def audio_from_media(media: Path, directory: Path) -> tuple[Path, float]:
    probe = subprocess.run(
        [ffmpeg_executable("ffprobe"), "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", str(media)],
        check=True, capture_output=True, text=True, timeout=20,
    )
    info = json.loads(probe.stdout)
    duration = float(info.get("format", {}).get("duration", 0))
    if duration <= 0 or duration > MAX_DURATION:
        raise ValueError("This clip must be shorter than 20 minutes.")
    if not any(stream.get("codec_type") == "audio" for stream in info.get("streams", [])):
        raise ValueError("This video does not contain an audio track.")
    audio = directory / "speech.wav"
    subprocess.run(
        [ffmpeg_executable("ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-y", "-i", str(media), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio)],
        check=True, capture_output=True, text=True, timeout=180,
    )
    return audio, duration


class QuietExtractorLogger:
    def debug(self, _message):
        pass

    def warning(self, _message):
        pass

    def error(self, _message):
        pass


def extractor_matches(platform: str, key: str) -> bool:
    key = str(key or "").lower()
    return (platform == "tiktok" and key.startswith("tiktok")) or (platform == "youtube" and key == "youtube") or (platform == "instagram" and key.startswith("instagram"))


def media_limit_reason(info: dict) -> str | None:
    if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming"}:
        return "Live streams and upcoming broadcasts are not supported. Use a finished video."
    duration = info.get("duration")
    if duration is not None and float(duration) > MAX_DURATION:
        return "This clip must be shorter than 20 minutes."
    size = info.get("filesize") or info.get("filesize_approx")
    if size is not None and float(size) > MAX_BYTES:
        return "This video exceeds the 80 MB download limit."
    return None


def has_usable_media(info: dict) -> bool:
    if str(info.get("ext", "")).lower() in {"jpg", "jpeg", "png", "webp", "gif", "avif"}:
        return False
    formats = info.get("formats") or []
    if formats:
        return any(isinstance(item, dict) and item.get("url") and item.get("acodec") != "none" for item in formats)
    return bool(info.get("url")) and info.get("acodec") != "none"


class UnusableVideoError(ValueError):
    """A trusted post entry has no eligible audio, access, or resource budget."""


def resolve_single_video(extractor, info: dict, platform: str, *, depth=0) -> dict:
    if depth > 4 or not isinstance(info, dict) or not extractor_matches(platform, info.get("extractor_key")):
        raise ValueError("The link did not resolve to a supported video on the expected platform.")
    kind = info.get("_type", "video")
    if kind in {"url", "url_transparent"}:
        target = validate_video_url(info.get("url", ""))
        if video_platform(target) != platform or (info.get("ie_key") and not extractor_matches(platform, info["ie_key"])):
            raise ValueError("Cross-platform or generic video redirects are not supported.")
        resolved = extractor.extract_info(target, download=False, process=False)
        return resolve_single_video(extractor, resolved, platform, depth=depth + 1)
    if kind == "playlist":
        # Instagram represents a single carousel post as a playlist internally.
        # Input URLs already exclude profiles/collections. Only that exact post
        # extractor may contribute its first usable video; never download all.
        if platform != "instagram" or str(info.get("extractor_key", "")).lower() != "instagram":
            raise ValueError("Profiles and playlists are not supported. Share one video instead.")
        from itertools import islice
        for entry in islice(info.get("entries") or [], 20):
            if not isinstance(entry, dict):
                continue
            candidate = dict(entry)
            candidate.setdefault("extractor_key", info["extractor_key"])
            if candidate.get("_type") not in {"url", "url_transparent"} and not has_usable_media(candidate):
                continue
            try:
                selected = resolve_single_video(extractor, candidate, platform, depth=depth + 1)
            except UnusableVideoError:
                # A single post can mix images, silent clips, and videos that
                # exceed our budget. Select its first eligible video only.
                # Extractor/redirect trust failures still fail the entire post.
                continue
            selected.setdefault("title", info.get("title"))
            selected.setdefault("uploader", info.get("uploader"))
            return selected
        raise UnusableVideoError("This Instagram post does not contain a usable video with audio within the 20-minute/80 MB limits.")
    if kind != "video":
        raise ValueError("This link does not contain a usable video/audio track.")
    if info.get("availability") in {"private", "needs_auth", "premium_only", "subscriber_only"}:
        raise UnusableVideoError("This video requires authorized access. Only publicly accessible videos are supported.")
    if reason := media_limit_reason(info):
        raise UnusableVideoError(reason)
    if not has_usable_media(info):
        formats = info.get("formats") or []
        if formats and all(isinstance(item, dict) and item.get("acodec") == "none" for item in formats):
            raise UnusableVideoError("This video does not contain an audio track to transcribe.")
        raise UnusableVideoError("This link does not contain a usable video/audio track.")
    return info


def public_access_error(error: BaseException, platform: str) -> str:
    message = str(error).lower()
    name = PLATFORM_NAMES[platform]
    if "not a bot" in message or "bot detection" in message or "confirm you’re not" in message:
        return f"{name} blocked automatic access from this connection. This public link could not be retrieved."
    if any(item in message for item in ("too many requests", "429", "rate limit")):
        return f"{name} temporarily limited automatic requests. Try this link again later."
    if any(item in message for item in ("login", "log in", "sign in", "sign-in", "private", "authentication", "cookies", "authorized")):
        return f"{name} requires a signed-in or otherwise authorized session for this video. This worker currently processes publicly accessible links only."
    if any(item in message for item in ("deleted", "removed", "unavailable", "not available", "not found", "404", "no video")):
        return f"The {name} video is unavailable, removed, or not a video post."
    if any(item in message for item in ("timed out", "timeout", "network", "connection", "unable to download webpage", "http error 5")):
        return f"Could not reach {name}. Check the connection or try this link again later."
    return f"{name} did not provide a usable public video/audio stream for this link. It may require login or currently block automatic access."


def retrieve_media(url: str, directory: Path) -> tuple[Path, dict]:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError

    url = validate_video_url(url)
    platform = video_platform(url)

    def duration_filter(info, *, incomplete=False):
        return media_limit_reason(info)

    def check_progress(progress):
        if STOP.is_set():
            raise RuntimeError("Local transcription engine is stopping.")
        if (progress.get("downloaded_bytes") or 0) > MAX_BYTES:
            raise ValueError("This video exceeds the 80 MB download limit.")

    options = {
        "outtmpl": str(directory / "%(id)s.%(ext)s"),
        "noplaylist": True,
        "ignoreconfig": True,
        "cachedir": False,
        "quiet": True,
        "noprogress": True,
        "logger": QuietExtractorLogger(),
        "socket_timeout": 20,
        "retries": 1,
        "extractor_retries": 1,
        "fragment_retries": 1,
        "max_filesize": MAX_BYTES,
        "format": "bestaudio/best" if platform == "youtube" else "best",
        "match_filter": duration_filter,
        "progress_hooks": [check_progress],
        "restrictfilenames": True,
    }
    if platform == "youtube" and (node := shutil.which("node")):
        options["js_runtimes"] = {"node": {"path": node}}
    try:
        with YoutubeDL(options) as extractor:
            # TikTok's media URLs depend on the temporary cookies established
            # while extracting the post. Classification runs in another process;
            # its metadata cannot carry that session into this downloader. Also
            # refresh older checkpoints, which may contain expired signed URLs.
            cached = None if platform == "tiktok" else read_json(directory / "video-info.json")
            raw = cached if isinstance(cached, dict) else extractor.extract_info(url, download=False, process=False)
            selected = resolve_single_video(extractor, raw, platform)
            # Process a validated, fully resolved video result, not an input URL
            # that could re-resolve through an unchecked generic extractor.
            info = extractor.process_ie_result(dict(selected), download=True)
            if not isinstance(info, dict) or not extractor_matches(platform, info.get("extractor_key")):
                raise ValueError("The downloaded result did not match the expected video platform.")
            media = Path(extractor.prepare_filename(info)).resolve()
    except DownloadError as error:
        raise ValueError(public_access_error(error, platform)) from None
    if directory.resolve() not in media.parents:
        raise ValueError("The downloaded media was not stored in its temporary directory.")
    if not media.is_file() or not 0 < media.stat().st_size <= MAX_BYTES:
        raise ValueError("The platform did not return usable media within the 80 MB limit.")
    # Retain only data needed for the independent cover lane, not extractor state.
    atomic_json(directory / "preview-info.json", {key: selected[key] for key in
                ("thumbnail", "thumbnails", "formats", "url", "ext", "vcodec", "protocol", "http_headers") if key in selected})
    metadata = {
        "title": str(info.get("title") or (PLATFORM_NAMES[platform] + " video"))[:500],
        "creator": str(info.get("uploader") or info.get("creator") or "")[:200],
    }
    return media, metadata


def retrieve_image_post(url: str, directory: Path, *, cover_only=False) -> dict | None:
    # Keep native OCR and post-specific dependencies out of audio-only imports.
    from image_posts import retrieve_image_post as retrieve

    return retrieve(url, directory, cover_only=cover_only)


def recognize_image_post(paths: list[Path], root: Path, checkpoint_dir: Path | None = None) -> tuple[list[dict], str]:
    from ocr import OCR_ENGINE, ocr_images

    return ocr_images(paths, root, checkpoint_dir=checkpoint_dir), OCR_ENGINE


def image_post_title(pages: list[dict], fallback: str | None) -> str | None:
    """Use the cover's main OCR text, with no generated wording or later pages."""
    title = " ".join(pages[0]["text"].split()) if pages else ""
    if not title:
        return fallback
    if len(title) <= 160:
        return title
    boundary = title.rfind(" ", 0, 161)
    # Unspaced scripts or a single long token still need a bounded title.
    return title[:boundary if boundary > 0 else 160]


def preview_source_url(value: str, platform: str) -> str:
    """Only trusted public platform CDNs may supply preview bytes."""
    if not isinstance(value, str) or re.search(r"[\x00-\x20\x7f\\]", value):
        raise ValueError("Invalid preview source.")
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower()
    if (parsed.scheme != "https" or parsed.username is not None or parsed.password is not None
            or parsed.port not in (None, 443) or parsed.fragment
            or not any(host == domain or host.endswith("." + domain) for domain in PREVIEW_CDN_DOMAINS[platform])):
        raise ValueError("The preview source is not an eligible public platform CDN.")
    return value


def download_preview_source(url: str, destination: Path, platform: str, limit: int, *, prefix=False, headers=None) -> None:
    import requests

    url = preview_source_url(url, platform)
    if limit <= 0:
        raise ValueError("No preview retrieval budget remains.")
    request_headers = {key: value for key, value in (headers or {}).items()
                       if key.lower() in {"user-agent", "referer", "accept", "accept-language"} and isinstance(value, str)}
    if prefix:
        request_headers["Range"] = f"bytes=0-{limit - 1}"
    started = time.monotonic()
    # Disable ambient netrc credentials/proxies. Preview requests never use the
    # private Site bearer, browser cookies, or a signed-in platform session.
    with requests.Session() as session:
        session.trust_env = False
        with session.get(url, headers=request_headers, stream=True, timeout=(5, 10), allow_redirects=False) as response:
            if response.status_code not in ({200, 206} if prefix else {200}):
                raise ValueError("The preview source could not be retrieved.")
            if not prefix:
                content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
                if not content_type.startswith("image/"):
                    raise ValueError("The thumbnail source was not an image.")
                length = response.headers.get("Content-Length")
                if length and int(length) > limit:
                    raise ValueError("The thumbnail exceeded its download limit.")
            total = 0
            with destination.open("wb") as output:
                while total < limit:
                    if STOP.is_set() or time.monotonic() - started > 25:
                        raise ValueError("Preview retrieval timed out.")
                    chunk = response.raw.read(min(64 * 1024, limit - total), decode_content=True)
                    if not chunk:
                        break
                    if total + len(chunk) > limit:
                        raise ValueError("The preview exceeded its download limit.")
                    output.write(chunk)
                    total += len(chunk)
            if not total:
                raise ValueError("The preview source was empty.")


def encode_preview(media: Path, directory: Path, *, first_frame=False) -> Path:
    """Decode locally, without seeking; video input uses its first real frame."""
    preview = directory / "preview.jpg"
    for edge, quality in ((640, 5), (640, 12), (480, 18)):
        preview.unlink(missing_ok=True)
        subprocess.run(
            [ffmpeg_executable("ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
             "-max_alloc", "100000000", "-protocol_whitelist", "file,pipe",
             *([] if first_frame else ["-f", "image2pipe"]), "-i", str(media),
             "-map", "0:V:0" if first_frame else "0:v:0", "-frames:v", "1", "-an",
             "-vf", f"scale=w='min({edge},iw)':h='min({edge},ih)':force_original_aspect_ratio=decrease",
             "-q:v", str(quality), "-update", "1", str(preview)],
            check=True, capture_output=True, timeout=10,
        )
        if preview.is_file() and 0 < preview.stat().st_size <= MAX_PREVIEW_BYTES:
            data = preview.read_bytes()
            if data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9"):
                return preview
    raise ValueError("The preview could not be encoded within its size limit.")


def valid_slide(path: Path) -> bool:
    try:
        if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 500 * 1024:
            return False
        data = path.read_bytes()
        if not data.startswith(b"\xff\xd8\xff") or not data.endswith(b"\xff\xd9"):
            return False
        probe = subprocess.run([ffmpeg_executable("ffprobe"), "-v", "error", "-max_alloc", "100000000",
                                "-protocol_whitelist", "file,pipe", "-show_entries", "stream=codec_name,width,height",
                                "-of", "json", str(path)], check=True, capture_output=True, text=True, timeout=10)
        streams = json.loads(probe.stdout).get("streams") or []
        return (len(streams) == 1 and streams[0].get("codec_name") == "mjpeg"
                and 0 < int(streams[0].get("width") or 0) <= 1600
                and 0 < int(streams[0].get("height") or 0) <= 1600)
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        return False


def encode_slide(image: Path, directory: Path, index: int) -> Path:
    destination = directory / f"viewer-{index:02d}.jpg"
    if valid_slide(destination):
        return destination
    destination.unlink(missing_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".viewer-{index:02d}-", suffix=".jpg", dir=directory)
    os.close(descriptor)
    temporary = Path(name)
    try:
        for edge, quality in ((1600, 3), (1600, 8), (1280, 12), (1000, 18)):
            subprocess.run([ffmpeg_executable("ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                            "-max_alloc", "100000000", "-protocol_whitelist", "file,pipe", "-f", "image2pipe", "-i", str(image),
                            "-frames:v", "1", "-an", "-vf", f"scale=w='min({edge},iw)':h='min({edge},ih)':force_original_aspect_ratio=decrease",
                            "-q:v", str(quality), "-update", "1", str(temporary)],
                           check=True, capture_output=True, timeout=15)
            if valid_slide(temporary):
                with temporary.open("rb") as encoded:
                    os.fsync(encoded.fileno())
                os.replace(temporary, destination)
                return destination
        raise ValueError("The slide image could not be encoded within its limit.")
    finally:
        temporary.unlink(missing_ok=True)


def create_preview(url: str, directory: Path, media: Path | None, budget: int) -> str:
    """Child-process implementation: platform thumbnail, then actual first frame."""
    from yt_dlp import YoutubeDL

    url = validate_video_url(url)
    platform = video_platform(url)
    if media is None:
        # Retry/backfill has no original in memory. Resolve the post again and
        # cover image-only posts with their first original, without running OCR.
        post = retrieve_image_post(url, directory, cover_only=True)
        if post:
            encode_preview(post["paths"][0], directory)
            return "thumbnail"
    selected = read_json(directory / "preview-info.json")
    try:
        options = {"noplaylist": True, "ignoreconfig": True, "cachedir": False, "quiet": True,
                   "noprogress": True, "logger": QuietExtractorLogger(), "socket_timeout": 8,
                   "retries": 0, "extractor_retries": 0, "fragment_retries": 0}
        if platform == "youtube" and (node := shutil.which("node")):
            options["js_runtimes"] = {"node": {"path": node}}
        if not selected:
            with YoutubeDL(options) as extractor:
                selected = resolve_single_video(extractor, extractor.extract_info(url, download=False, process=False), platform)
    except Exception:
        # Existing downloaded video can still provide its true first frame.
        pass
    if selected:
        thumbnails = [selected.get("thumbnail")]
        thumbnails.extend(item.get("url") for item in reversed(selected.get("thumbnails") or []) if isinstance(item, dict))
        for source in list(dict.fromkeys(value for value in thumbnails if isinstance(value, str)))[:3]:
            temporary = directory / "thumbnail-source"
            try:
                allowance = min(MAX_THUMBNAIL_BYTES, budget)
                # Reserve the entire bounded attempt, including failures that
                # downloaded bytes before returning an unusable image.
                budget -= allowance
                download_preview_source(source, temporary, platform, allowance, headers=selected.get("http_headers"))
                encode_preview(temporary, directory)
                return "thumbnail"
            except Exception:
                pass
            finally:
                temporary.unlink(missing_ok=True)
    if media and media.is_file():
        try:
            encode_preview(media, directory, first_frame=True)
            return "first_frame"
        except Exception:
            pass
    if not selected or budget <= 0:
        raise ValueError("No preview is available for this video.")
    candidates = []
    for item in selected.get("formats") or [selected]:
        if not isinstance(item, dict) or item.get("vcodec") in (None, "none") or item.get("has_drm"):
            continue
        if item.get("protocol") not in (None, "http", "https") or item.get("ext") not in {"mp4", "webm", "mov"}:
            continue
        try:
            preview_source_url(item.get("url"), platform)
        except (TypeError, ValueError):
            continue
        candidates.append(item)
    if not candidates:
        raise ValueError("No bounded video preview source is available.")
    source = min(candidates, key=lambda item: (float(item.get("height") or 100000), float(item.get("tbr") or 100000)))
    temporary = directory / "frame-source"
    try:
        download_preview_source(source["url"], temporary, platform, min(MAX_FRAME_SOURCE_BYTES, budget), prefix=True,
                                headers=source.get("http_headers") or selected.get("http_headers"))
        # A non-decodable prefix is unavailable; never fetch the remaining video.
        encode_preview(temporary, directory, first_frame=True)
        return "first_frame"
    finally:
        temporary.unlink(missing_ok=True)


def retrieve_preview(url: str, directory: Path, media: Path | None = None, budget: int = MAX_BYTES) -> tuple[Path, str]:
    url = validate_video_url(url)
    command = [sys.executable, str(Path(__file__).resolve()), "--preview-url", url,
               "--preview-directory", str(directory), "--preview-budget", str(max(0, min(MAX_BYTES, budget)))]
    if media:
        command.extend(["--preview-media", str(media)])
    process = start_local_process(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        code = process.wait(timeout=PREVIEW_TIMEOUT)
    except BaseException:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise
    preview, kind_file = directory / "preview.jpg", directory / "preview-kind"
    if code or not preview.is_file() or not 0 < preview.stat().st_size <= MAX_PREVIEW_BYTES:
        raise ValueError("A preview could not be retrieved for this video.")
    kind = kind_file.read_text()
    if kind not in {"thumbnail", "first_frame"}:
        raise ValueError("The preview type was invalid.")
    return preview, kind


class SiteError(RuntimeError):
    def __init__(self, status: int, message="The private webpage could not be reached."):
        self.status = status
        super().__init__(message)


class SiteClient:
    def __init__(self, origin: str, bearer: str, engine_key: str):
        from urllib.parse import urlunsplit

        parsed = urlsplit(origin)
        local = parsed.hostname in {"127.0.0.1", "localhost"}
        if parsed.scheme != "https" and not (local and parsed.scheme == "http"):
            raise ValueError("The Site must use HTTPS.")
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("Use only the Site origin, without a path, credentials, query, or fragment.")
        if not parsed.hostname:
            raise ValueError("The Site origin is missing.")
        self.origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
        if not isinstance(bearer, str) or not bearer.strip():
            raise ValueError("Private Site service access is required.")
        if not isinstance(engine_key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", engine_key):
            raise ValueError("A valid Mac-only engine key is required.")
        if engine_key == bearer:
            raise ValueError("The engine key must be separate from the Site service credential.")
        self._bearer = bearer
        self._engine_key = engine_key
        self._connections = threading.local()

    def session(self):
        # One pooled connection per lane. A shared requests.Session is not
        # thread-safe, and public media sessions must never share these headers.
        import requests
        if not getattr(self._connections, "session", None):
            session = requests.Session()
            session.trust_env = False
            self._connections.session = session
        return self._connections.session

    def upload_slide(self, job: dict, index: int, image: Path) -> dict:
        data = image.read_bytes()
        if not 1 <= index <= 35 or not 0 < len(data) <= 500 * 1024 or not data.startswith(b"\xff\xd8\xff") or not data.endswith(b"\xff\xd9"):
            raise ValueError("The slide does not meet the upload limits.")
        return self._request("PUT", f"/api/worker/jobs/{job['id']}/slides/{index}", {"data": data}, 3,
                             {"Content-Type": "image/jpeg", "X-Cliptext-Lease-Token": job["leaseToken"]})

    def request(self, method: str, path: str, payload: dict, attempts: int = 3) -> dict:
        # Literal UTF-8 avoids six-character escapes inflating Japanese OCR
        # results beyond the Site's request-size limit.
        return self._request(method, path, {"data": json.dumps(payload, ensure_ascii=False).encode("utf-8")}, attempts)

    def upload_preview(self, job: dict, preview: Path, kind: str) -> dict:
        data = preview.read_bytes()
        if kind not in {"thumbnail", "first_frame"} or not 0 < len(data) <= MAX_PREVIEW_BYTES:
            raise ValueError("The preview does not meet the upload limits.")
        if not data.startswith(b"\xff\xd8\xff") or not data.endswith(b"\xff\xd9"):
            raise ValueError("The preview must be a decoded JPEG image.")
        return self._request("PUT", "/api/worker/frames/" + job["id"], {"data": data}, 2, {
            "Content-Type": "image/jpeg", "X-Cliptext-Frame-Lease": job["leaseToken"], "X-Cliptext-Preview-Kind": kind,
        })

    def _request(self, method: str, path: str, body: dict, attempts: int, extra_headers=None) -> dict:
        import requests

        if not path.startswith("/api/worker/") or "?" in path or "#" in path or ".." in path:
            raise ValueError("Worker requests must stay on the same private Site.")
        for attempt in range(attempts):
            try:
                response = self.session().request(
                    method, self.origin + path,
                    headers={"OAI-Sites-Authorization": "Bearer " + self._bearer, "X-Cliptext-Engine": "1", "X-Cliptext-Engine-Key": self._engine_key, "Content-Type": "application/json", **(extra_headers or {})},
                    **body, timeout=(10, 35), allow_redirects=False,
                )
                if 200 <= response.status_code < 300:
                    return response.json() if response.content else {}
                if response.status_code in {408, 425, 429} or response.status_code >= 500:
                    if attempt + 1 < attempts:
                        STOP.wait(min(2 ** attempt, 20))
                        continue
                # Never follow redirects with the service credential.
                raise SiteError(response.status_code)
            except requests.RequestException:
                if attempt + 1 >= attempts:
                    raise SiteError(0) from None
                STOP.wait(min(2 ** attempt, 20))
        raise SiteError(0)


class Worker:
    def __init__(self, config: dict, *, client=None):
        self.root = runtime_path(config.get("runtime_dir"))
        configure_cache(self.root)
        self.repository = config.get("model_repo") or DEFAULT_MODEL
        self.client = client if client is not None else SiteClient(config.get("site_url", ""), config.get("site_bearer", ""), config.get("engine_key", ""))
        self.speech_model_path = None
        if config.get("speech_model_path") is not None:
            supplied = Path(config["speech_model_path"]).expanduser()
            if not supplied.is_absolute():
                raise ValueError("The speech model must be an absolute local directory.")
            supplied = supplied.resolve(strict=True)
            if (not supplied.is_dir() or not (supplied / "config.json").is_file()
                    or not any((supplied / name).is_file() for name in ("weights.npz", "weights.safetensors"))):
                raise ValueError("The explicit local speech model is incomplete.")
            self.speech_model_path = supplied
        self.poll_seconds = min(30, max(2, float(config.get("poll_seconds", 5))))
        self.lock = threading.Lock()
        self.state = {"status": "loading", "activeJobId": None, "activeLeaseToken": None}
        self.model = None
        self.insights_model = Path(config.get("insights_model_path") or self.root / "models" / "insights")
        self.preview_thread = None
        self.preview_wake = threading.Event()
        self._resume_after = {}

    def set_state(self, status, job=None):
        with self.lock:
            self.state = {"status": status, "activeJobId": job.get("id") if job else None, "activeLeaseToken": job.get("leaseToken") if job else None}

    def heartbeat(self):
        while not STOP.is_set():
            with self.lock:
                payload = {"engine": self.repository, **self.state}
            try:
                self.client.request("POST", "/api/worker/heartbeat", payload, attempts=1)
            except SiteError:
                pass
            STOP.wait(15)

    def update(self, job: dict, body: dict, *, final=False):
        payload = {"leaseToken": job["leaseToken"], **body}
        try:
            self.client.request("PATCH", "/api/worker/jobs/" + job["id"], payload)
        except SiteError as error:
            if final or error.status in {400, 403, 404, 409, 413, 422}:
                raise

    def identify(self, job: dict, url: str):
        identity = canonical_identity(url)
        if not identity:
            return False
        response = self.client.request("POST", "/api/worker/jobs/" + job["id"] + "/identity",
                                       {"leaseToken": job["leaseToken"], **identity})
        return bool(response.get("duplicateJobId"))

    def process(self, job: dict):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", str(job.get("id", ""))) or not isinstance(job.get("leaseToken"), str):
            raise ValueError("The Site returned an invalid job.")
        self.set_state("busy", job)
        log("job_started", job_id=job["id"])
        started = time.monotonic()
        directory = job_directory(self.root, job["id"])
        state = read_json(directory / "state.json", {})
        state["job"] = job
        state.pop("failed", None)
        state.pop("waitingForClaim", None)
        atomic_json(directory / "state.json", state)
        try:
            if not state.get("result"):
                self.update(job, {"status": "downloading", "progress": 10})
                post = state.get("post")
                paths = [local_file(directory, name) for name in post.get("paths", [])] if isinstance(post, dict) else []
                cached_post = bool(paths) and all(path is not None for path in paths) and post.get("contentKind") in {"image", "carousel"}
                cached_media = local_file(directory, state.get("media"))
                cached_video = cached_media is not None and isinstance(state.get("metadata"), dict)
                url = validate_video_url(state.get("resolvedUrl") or job.get("url", ""))
                if video_platform(url) != video_platform(job.get("url", "")):
                    raise ValueError("The saved post platform is invalid.")
                # The authenticated update above validates the current lease.
                # Completed retrieval is self-contained: never revisit the
                # original platform merely to resume OCR or speech recognition.
                if cached_post:
                    state["classification"] = post["contentKind"]
                elif cached_video:
                    post = None
                    state.pop("post", None)
                    state["classification"] = "video"
                else:
                    if video_platform(url) == "tiktok" and not canonical_identity(url):
                        from image_posts import _resolve_tiktok_share
                        url = _resolve_tiktok_share(url)
                    state["resolvedUrl"] = url
                    atomic_json(directory / "state.json", state)
                    if self.identify(job, url):
                        log("job_duplicate", job_id=job["id"])
                        shutil.rmtree(directory)
                        return
                    # Classification persists even if the later media download
                    # is interrupted; its validated metadata cache is reusable.
                    post = None if state.get("classification") == "video" else retrieve_image_post(url, directory)
                    state["classification"] = post["contentKind"] if post else "video"
                    if post:
                        paths = []
                        for index, path in enumerate(post["paths"], 1):
                            path = Path(path)
                            if directory.resolve() not in path.resolve().parents:
                                copied = directory / f"original-{index:02d}{path.suffix}"
                                shutil.copyfile(path, copied)
                                path = copied
                            paths.append(path)
                        post = {**post, "paths": [str(path.relative_to(directory)) for path in paths]}
                        state["post"] = post
                    else:
                        state.pop("post", None)
                    atomic_json(directory / "state.json", state)
                if post:
                    metadata = {key: value for key, value in post["metadata"].items() if key in {"title", "creator"}}
                    self.update(job, {"status": "transcribing", "progress": 45, "contentKind": post["contentKind"], **metadata})
                    pages, ocr_engine = recognize_image_post(paths, self.root, checkpoint_dir=directory)
                    metadata["title"] = image_post_title(pages, metadata.get("title"))
                    result = {"status": "completed", "progress": 100, "contentKind": post["contentKind"],
                              "pages": pages, "ocrEngine": ocr_engine, **metadata}
                else:
                    media = local_file(directory, state.get("media"))
                    metadata = state.get("metadata")
                    if media is None or not isinstance(metadata, dict):
                        media, metadata = retrieve_media(url, directory)
                        if directory.resolve() not in media.resolve().parents:
                            copied = directory / ("media" + media.suffix)
                            shutil.copyfile(media, copied)
                            media = copied
                        state.update({"media": str(media.relative_to(directory)), "metadata": metadata})
                        atomic_json(directory / "state.json", state)
                    audio, duration = audio_from_media(media, directory)
                    self.update(job, {"status": "transcribing", "progress": 45, "contentKind": "video", "durationSeconds": duration, **metadata})
                    if self.model is None:
                        log("model_loading", model=self.repository)
                        self.model = self.speech_model_path or prepare_model(self.root, self.repository)
                    speech = transcribe_file(audio, self.model)
                    if not speech["transcript"]:
                        raise ValueError("No speech was detected in this clip.")
                    result = {"status": "completed", "progress": 100, "contentKind": "video", "durationSeconds": duration, **metadata, **speech}
                state["result"] = result
                # Commit the expensive result BEFORE its first network upload.
                atomic_json(directory / "state.json", state)
            # Store slide images before completing the job, so the reader can
            # display every page when the result becomes visible. A retry skips
            # acknowledged images and never reruns recognition.
            if state.get("post"):
                for index, name in enumerate(state["post"]["paths"], 1):
                    if index in state.get("slidesUploaded", []):
                        continue
                    original = local_file(directory, name)
                    if original is None:
                        raise ValueError("A saved slide is missing. Retry the post to retrieve it again.")
                    encoded = encode_slide(original, directory, index)
                    self.client.upload_slide(job, index, encoded)
                    state.setdefault("slidesUploaded", []).append(index)
                    atomic_json(directory / "state.json", state)
            self.update(job, state["result"], final=True)
            state["finished"] = True
            atomic_json(directory / "state.json", state)
            self.preview_wake.set()
            if (directory / "preview-done.json").is_file():
                shutil.rmtree(directory, ignore_errors=True)
            log("job_completed", job_id=job["id"], content_kind=state["result"]["contentKind"], seconds=round(time.monotonic() - started, 2))
        except Exception as error:
            message = safe_error(error, (self.client._bearer, self.client._engine_key, job.get("leaseToken")))
            if STOP.is_set():
                log("job_interrupted", job_id=job["id"])
                return
            if isinstance(error, SiteError):
                if error.status in {0, 408, 425, 429} or error.status >= 500:
                    log("job_upload_deferred", job_id=job["id"], http_status=error.status)
                    self._resume_after[job["id"]] = time.monotonic() + 30
                    return
                if error.status in {404, 409}:
                    log("job_lease_lost", job_id=job["id"])
                    # The next valid claim can reuse expensive local results.
                    state["waitingForClaim"] = True
                    atomic_json(directory / "state.json", state)
                    return
                log("job_failed", job_id=job["id"], http_status=error.status)
            else:
                log("job_failed", job_id=job["id"], error=message)
            state["failed"] = True
            atomic_json(directory / "state.json", state)
            with contextlib.suppress(SiteError):
                self.update(job, {"status": "failed", "progress": 0, "error": message}, final=True)
        finally:
            self.set_state("idle")

    def resume_one(self):
        for path in sorted((self.root / "jobs").glob("*/state.json")):
            state = read_json(path, {})
            job = state.get("job")
            if not job or state.get("finished") or state.get("failed") or state.get("waitingForClaim"):
                continue
            if time.monotonic() < self._resume_after.get(job.get("id"), 0):
                continue
            try:
                remote = self.client.request("GET", "/api/worker/jobs/" + job["id"], {}).get("job", {})
            except SiteError as error:
                if error.status == 404:
                    shutil.rmtree(path.parent, ignore_errors=True)
                    continue
                raise
            if remote.get("trashedAt") or remote.get("duplicateOf") or remote.get("status") == "failed":
                continue
            if remote.get("status") == "completed" and not state.get("result"):
                continue
            self.process(job)
            return True
        return False

    def preview_loop(self):
        delay = self.poll_seconds
        while not STOP.is_set():
            try:
                claimed = self.client.request("POST", "/api/worker/frames/claim", {}, attempts=1).get("job")
                if claimed:
                    directory = job_directory(self.root, claimed["id"])
                    state = read_json(directory / "state.json", {})
                    kwargs = {}
                    if state.get("finished"):
                        media = local_file(directory, state.get("media"))
                        paths = (state.get("post") or {}).get("paths", [])
                        image = local_file(directory, paths[0]) if paths else None
                        kwargs = {"directory": directory, "media": media, "image": image,
                                  "budget": max(0, MAX_BYTES - media.stat().st_size) if media else MAX_BYTES}
                    self.process_preview(claimed, **kwargs)
                    if STOP.is_set():
                        break
                    atomic_json(directory / "preview-done.json", {"done": True})
                    latest = read_json(directory / "state.json", {})
                    if latest.get("finished") or not latest.get("job"):
                        shutil.rmtree(directory, ignore_errors=True)
                    delay = self.poll_seconds
                else:
                    delay = min(60, delay * 1.5)
            except Exception:
                delay = min(60, delay * 1.5)
            self.preview_wake.wait(delay)
            self.preview_wake.clear()

    def process_insights(self, claimed):
        from insights import generate_insights, has_current_title
        job = claimed["job"]
        self.set_state("busy")
        try:
            # Whisper stays loaded across consecutive audio jobs, but releases
            # its weights before the separate local language model process.
            if self.model is not None:
                from mlx_whisper.transcribe import ModelHolder
                import mlx.core as mx
                ModelHolder.model = None
                ModelHolder.model_path = None
                gc.collect()
                mx.clear_cache()
            directory = self.root / "insights-outbox"
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", str(job.get("id", ""))):
                raise ValueError("Invalid insight job")
            checkpoint = directory / (job["id"] + ".json")
            cached = read_json(checkpoint, {})
            if cached.get("sourceRevision") == claimed["sourceRevision"] and has_current_title(cached.get("result")):
                result = cached["result"]
            else:
                result = generate_insights(claimed, self.root, self.insights_model)
                if STOP.is_set():
                    return
            # Always retain the current lease, including when reusing a result
            # computed under an earlier lease for the same source revision.
            atomic_json(checkpoint, {"sourceRevision": claimed["sourceRevision"], "result": result, "claim": claimed})
            self.client.request("PATCH", "/api/worker/insights/" + job["id"], {
                "leaseToken": claimed["leaseToken"], "sourceRevision": claimed["sourceRevision"], "status": "completed", **result})
            checkpoint.unlink(missing_ok=True)
            log("insights_completed", job_id=job["id"], engine=result["engine"])
        except Exception as error:
            log("insights_deferred", job_id=job["id"], **({"http_status": error.status} if isinstance(error, SiteError) else {}))
            self._resume_after["insights:" + job["id"]] = time.monotonic() + 30
        finally:
            self.set_state("idle")

    def replay_insights(self):
        from insights import has_current_title
        for checkpoint in (self.root / "insights-outbox").glob("*.json"):
            cached = read_json(checkpoint, {})
            claim, result = cached.get("claim"), cached.get("result")
            if not isinstance(claim, dict) or not isinstance(result, dict):
                continue
            job_id = (claim.get("job") or {}).get("id", "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", job_id) or time.monotonic() < self._resume_after.get("insights:" + job_id, 0):
                continue
            if not has_current_title(result):
                # An older outbox has no generated title (or retained a long
                # caption). Regenerate locally from its saved source claim.
                self.process_insights(claim)
                continue
            try:
                self.client.request("PATCH", "/api/worker/insights/" + job_id,
                                    {"leaseToken": claim["leaseToken"], "sourceRevision": claim["sourceRevision"], "status": "completed", **result})
                checkpoint.unlink(missing_ok=True)
            except SiteError as error:
                if error.status in {400, 403, 404, 409, 413, 422}:
                    # A changed transcript or lease must not receive old insights.
                    checkpoint.unlink(missing_ok=True)
                else:
                    self._resume_after["insights:" + job_id] = time.monotonic() + 30

    def process_slide_backfill(self, job):
        # This lease cannot modify text. Old library items gain slide imagery
        # without repeating OCR or overwriting the owner's later corrections.
        directory = job_directory(self.root / "slide-backfill", job["id"])
        self.set_state("busy")
        state = read_json(directory / "state.json", {})
        try:
            state["job"] = job
            state.pop("failed", None)
            state.pop("waitingForClaim", None)
            atomic_json(directory / "state.json", state)
            post = state.get("post")
            paths = [local_file(directory, name) for name in post.get("paths", [])] if isinstance(post, dict) else []
            if not paths or any(path is None for path in paths):
                post = retrieve_image_post(job["url"], directory)
                if not post:
                    raise ValueError("The original image post is no longer available.")
                paths = post["paths"]
                post = {**post, "paths": [str(path.relative_to(directory)) for path in paths]}
                state["post"] = post
                atomic_json(directory / "state.json", state)
            # A changed upstream carousel must not attach images to wrong pages.
            remote = self.client.request("GET", "/api/worker/jobs/" + job["id"], {}).get("job", {})
            if remote.get("pageCount") != len(paths):
                raise ValueError("The post's slide count has changed; existing text was preserved.")
            for index, original in enumerate(paths, 1):
                if index in state.get("uploaded", []):
                    continue
                self.client.upload_slide(job, index, encode_slide(original, directory, index))
                state.setdefault("uploaded", []).append(index)
                atomic_json(directory / "state.json", state)
            self.client.request("PATCH", "/api/worker/slides/" + job["id"], {"leaseToken": job["leaseToken"], "status": "completed"})
            shutil.rmtree(directory)
            log("slides_completed", job_id=job["id"])
        except Exception as error:
            if STOP.is_set():
                return
            if isinstance(error, SiteError) and (error.status in {0, 408, 425, 429} or error.status >= 500):
                log("slides_upload_deferred", job_id=job["id"])
                self._resume_after["slides:" + job["id"]] = time.monotonic() + 30
                return
            log("slides_unavailable", job_id=job["id"])
            state["waitingForClaim" if isinstance(error, SiteError) and error.status == 409 else "failed"] = True
            atomic_json(directory / "state.json", state)
            with contextlib.suppress(SiteError):
                self.client.request("PATCH", "/api/worker/slides/" + job["id"], {"leaseToken": job["leaseToken"], "status": "unavailable"}, attempts=1)
        finally:
            self.set_state("idle")

    def resume_slide_backfill(self):
        for path in (self.root / "slide-backfill" / "jobs").glob("*/state.json"):
            state = read_json(path, {})
            job = state.get("job")
            if not job or state.get("failed") or state.get("waitingForClaim") or time.monotonic() < self._resume_after.get("slides:" + job.get("id", ""), 0):
                continue
            self.process_slide_backfill(job)
            return True
        return False

    def process_preview(self, job: dict, *, directory: Path | None = None, media: Path | None = None, image: Path | None = None, budget=MAX_BYTES):
        if (not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", str(job.get("id", "")))
                or not isinstance(job.get("leaseToken"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", job["leaseToken"])):
            log("preview_job_invalid")
            return
        # This background lane must never replace the active transcript lease.
        try:
            with contextlib.ExitStack() as stack:
                if directory is None:
                    directory = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="preview-", dir=self.root)))
                if image is not None:
                    preview, kind = encode_preview(image, directory), "thumbnail"
                else:
                    preview, kind = retrieve_preview(job.get("url", ""), directory, media=media, budget=budget)
                self.client.upload_preview(job, preview, kind)
                log("preview_completed", job_id=job["id"], kind=kind)
        except Exception as error:
            # Log only safe HTTP status, never extractor URLs or lease headers.
            log("preview_unavailable", job_id=job["id"], **({"http_status": error.status} if isinstance(error, SiteError) else {}))
            if STOP.is_set():
                return
            if not isinstance(error, SiteError) or error.status != 409:
                with contextlib.suppress(Exception):
                    self.client.request("PATCH", "/api/worker/frames/" + job["id"],
                                        {"leaseToken": job["leaseToken"], "status": "unavailable"}, attempts=1)

    def run(self):
        heartbeat_thread = threading.Thread(target=self.heartbeat, name="cliptext-heartbeat", daemon=True)
        heartbeat_thread.start()
        self.preview_thread = threading.Thread(target=self.preview_loop, name="cliptext-previews", daemon=True)
        self.preview_thread.start()
        self.set_state("idle")
        log("worker_ready", engine=self.repository)
        delay = self.poll_seconds
        while not STOP.is_set():
            try:
                if self.resume_one():
                    delay = self.poll_seconds
                    continue
                response = self.client.request("POST", "/api/worker/claim", {})
                job = response.get("job")
                if job:
                    self.process(job)
                    delay = self.poll_seconds
                    continue
                self.replay_insights()
                claimed = self.client.request("POST", "/api/worker/insights/claim", {}, attempts=1)
                if claimed.get("job"):
                    self.process_insights(claimed)
                    delay = self.poll_seconds
                    continue
                if self.resume_slide_backfill():
                    continue
                slides = self.client.request("POST", "/api/worker/slides/claim", {}, attempts=1)
                if slides.get("job"):
                    self.process_slide_backfill(slides["job"])
                    delay = self.poll_seconds
                    continue
                STOP.wait(delay)
                delay = min(60, delay * 1.5)
            except SiteError as error:
                log("site_connection_unavailable", status=error.status)
                STOP.wait(min(60, max(15, delay)))
                delay = min(60, delay * 1.5)
        self.preview_wake.set()
        self.preview_thread.join(timeout=1)
        log("worker_stopped")


def read_secret_config() -> dict:
    terminal = None
    old_settings = None
    if sys.stdin.isatty():
        import termios
        terminal = termios
        old_settings = termios.tcgetattr(sys.stdin.fileno())
        updated = termios.tcgetattr(sys.stdin.fileno())
        updated[3] &= ~termios.ECHO
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, updated)
    try:
        print("Ready for Cliptext worker configuration JSON on stdin (input hidden).", flush=True)
        raw = sys.stdin.readline()
    finally:
        if terminal and old_settings:
            terminal.tcsetattr(sys.stdin.fileno(), terminal.TCSADRAIN, old_settings)
    try:
        config = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        raise ValueError("A valid worker configuration JSON object is required on stdin.") from None
    if not isinstance(config, dict):
        raise ValueError("A worker configuration JSON object is required.")
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--transcribe-file", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--runtime-dir", type=Path)
    parser.add_argument("--model-repo", default=DEFAULT_MODEL)
    parser.add_argument("--preview-url", help=argparse.SUPPRESS)
    parser.add_argument("--preview-directory", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--preview-media", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--preview-budget", type=int, default=MAX_BYTES, help=argparse.SUPPRESS)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, stop_worker)
    signal.signal(signal.SIGINT, stop_worker)
    if args.preview_url:
        if not args.preview_directory or not args.preview_directory.is_dir():
            raise ValueError("A temporary preview directory is required.")
        kind = create_preview(args.preview_url, args.preview_directory, args.preview_media, max(0, min(MAX_BYTES, args.preview_budget)))
        (args.preview_directory / "preview-kind").write_text(kind)
        return
    if args.check or args.transcribe_file:
        root = runtime_path(args.runtime_dir)
        model = prepare_model(root, args.model_repo)
        if args.check:
            import mlx.core as mx
            from mlx_whisper.transcribe import ModelHolder
            loaded = ModelHolder.get_model(str(model), dtype=mx.float16)
            mx.eval(loaded.parameters())
            print(json.dumps({"ready": True, "model": args.model_repo, "model_directory": str(model), "ffmpeg": bool(shutil.which("ffmpeg"))}))
        else:
            if not args.transcribe_file.is_file():
                raise ValueError("The input media file is missing.")
            with tempfile.TemporaryDirectory(prefix="speech-test-", dir=root) as directory:
                audio, duration = audio_from_media(args.transcribe_file, Path(directory))
                result = transcribe_file(audio, model)
                print(json.dumps({"durationSeconds": duration, **result}, ensure_ascii=False, indent=2))
        return
    Worker(read_secret_config()).run()


if __name__ == "__main__":
    try:
        main()
    except Exception as failure:
        log("worker_error", error=safe_error(failure))
        sys.exit(1)
