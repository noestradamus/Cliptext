"""Local Apple Vision OCR with an inspectable main-text selection heuristic.

Main text is ranked by typography and neighboring lines across the whole image.
It is not semantic screenshot detection; all recognized text is retained too.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import platform
import signal
import statistics
import subprocess
from local_processes import start as start_local_process
import tempfile
import time

MAX_IMAGES = 35
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_BLOCKS = 1000
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_PAGE_TEXT_BYTES = 200_000
MAX_TOTAL_TEXT_CHARS = 250_000
# Vision can compete with the speech model and other Mac work. Keep a hard
# deadline, while allowing a loaded machine more than the warm benchmark time.
IMAGE_TIMEOUT = 60
TOTAL_TIMEOUT = 420
COMPILE_TIMEOUT = 60
OCR_ENGINE = "Apple Vision"


class OCRError(ValueError):
    """Safe error without image paths, environment values, or native diagnostics."""


def _environment(root: Path) -> dict[str, str]:
    temporary = root / "tmp"
    cache = root / "swift-module-cache"
    temporary.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    # Do not pass worker keys, browser settings, proxies, or the ambient environment.
    return {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
            "LC_ALL": "en_US.UTF-8", "TMPDIR": str(temporary),
            "CLANG_MODULE_CACHE_PATH": str(cache), "SWIFT_MODULECACHE_PATH": str(cache)}


def _run(command: list[str], root: Path, timeout: float) -> bytes:
    if timeout <= 0:
        raise OCRError("Image text extraction timed out. Try a smaller post.")
    environment = _environment(root)
    with tempfile.TemporaryFile(dir=root / "tmp") as output:
        try:
            process = start_local_process(command, stdin=subprocess.DEVNULL, stdout=output,
                                       stderr=subprocess.DEVNULL, env=environment,
                                       start_new_session=True)
        except OSError:
            raise OCRError("The local image recognition tool could not start.") from None
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            raise OCRError("Image text extraction timed out. Try a smaller post.") from None
        if code:
            raise OCRError("The local image recognition tool could not read this image.")
        if output.tell() > MAX_OUTPUT_BYTES:
            raise OCRError("This image contains too much text to extract safely.")
        output.seek(0)
        return output.read(MAX_OUTPUT_BYTES + 1)


def _helper(root: Path, deadline: float) -> Path:
    if platform.system() != "Darwin":
        raise OCRError("Image text extraction currently requires the Mac worker.")
    # Packaged engines ship a precompiled helper. An explicit override must
    # never fall back to a developer compiler when the package is incomplete.
    supplied = os.environ.get("CLIPTEXT_VISION_OCR_HELPER")
    if supplied is not None:
        binary = Path(supplied)
        if not binary.is_absolute() or not binary.is_file() or not os.access(binary, os.X_OK):
            raise OCRError("The packaged image recognition tool is missing or not executable.")
        return binary.resolve()
    source = Path(__file__).with_name("vision-ocr.swift")
    try:
        source_bytes = source.read_bytes()
    except OSError:
        raise OCRError("The local image recognition source is missing. Update the worker.") from None
    identity = source_bytes + platform.mac_ver()[0].encode() + platform.machine().encode()
    digest = hashlib.sha256(identity).hexdigest()[:20]
    directory = root / "bin"
    directory.mkdir(parents=True, exist_ok=True)
    binary = directory / f"vision-ocr-{digest}"
    if binary.is_file() and os.access(binary, os.X_OK):
        return binary
    fd, name = tempfile.mkstemp(prefix="vision-ocr-build-", dir=directory)
    os.close(fd)
    temporary = Path(name)
    try:
        _run(["/usr/bin/xcrun", "swiftc", "-O", "-module-cache-path", str(root / "swift-module-cache"),
              str(source), "-o", str(temporary)], root, min(COMPILE_TIMEOUT, deadline - time.monotonic()))
        temporary.chmod(0o700)
        os.replace(temporary, binary)
    finally:
        temporary.unlink(missing_ok=True)
    return binary


def _object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate key")
        value[key] = item
    return value


def _parse(data: bytes) -> list[dict]:
    try:
        if len(data) > MAX_OUTPUT_BYTES:
            raise ValueError()
        result = json.loads(data, object_pairs_hook=_object,
                            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if not isinstance(result, dict) or set(result) != {"blocks"}:
            raise ValueError()
        blocks = result["blocks"]
        if not isinstance(blocks, list) or len(blocks) > MAX_BLOCKS:
            raise ValueError()
        total = 0
        accepted = []
        for block in blocks:
            if not isinstance(block, dict) or set(block) != {"text", "confidence", "x", "y", "width", "height"}:
                raise ValueError()
            text = block["text"]
            if not isinstance(text, str) or len(text.encode("utf-8")) > 16384:
                raise ValueError()
            total += len(text.encode("utf-8"))
            if total > MAX_PAGE_TEXT_BYTES or any(ord(char) < 32 and char not in "\n\r\t" for char in text):
                raise ValueError()
            for key in ("confidence", "x", "y", "width", "height"):
                number = block[key]
                if type(number) not in (int, float) or not math.isfinite(number) or not 0 <= number <= 1:
                    raise ValueError()
            if block["width"] <= 0 or block["height"] <= 0:
                raise ValueError()
            if block["x"] + block["width"] > 1.00001 or block["y"] + block["height"] > 1.00001:
                raise ValueError()
            if text.strip():
                accepted.append(block)
        return accepted
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise OCRError("The local image recognition tool returned invalid text data.") from None


def _groups(blocks: list[dict]) -> list[list[dict]]:
    """Connect nearby lines with comparable type sizes and overlapping columns."""
    parents = list(range(len(blocks)))

    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for i, a in enumerate(blocks):
        for j, b in enumerate(blocks[:i]):
            height = max(a["height"], b["height"])
            if height > min(a["height"], b["height"]) * 1.7:
                continue
            gap = max(a["y"] - b["y"] - b["height"], b["y"] - a["y"] - a["height"], 0)
            if gap > height * 2:
                continue
            overlap = min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"])
            aligned = (overlap >= min(a["width"], b["width"]) * 0.35
                       or abs(a["x"] - b["x"]) < height * 1.2
                       or abs(a["x"] + a["width"] - b["x"] - b["width"]) < height * 1.2)
            if aligned:
                parents[find(i)] = find(j)
    groups: dict[int, list[dict]] = {}
    for i, block in enumerate(blocks):
        groups.setdefault(find(i), []).append(block)
    return list(groups.values())


def _score(group: list[dict]) -> float:
    return sum(min(len(block["text"]), 120) * block["height"] ** 2 for block in group)


def _reading_order(blocks: list[dict]) -> list[dict]:
    rows: list[list[dict]] = []
    for block in sorted(blocks, key=lambda b: (b["y"], b["x"])):
        if rows and abs(block["y"] - rows[-1][0]["y"]) < min(block["height"], rows[-1][0]["height"]) * 0.4:
            rows[-1].append(block)
        else:
            rows.append([block])
    return [block for row in rows for block in sorted(row, key=lambda b: b["x"])]


def _main_blocks(blocks: list[dict]) -> list[dict]:
    if len(blocks) <= 1:
        return blocks
    strong = [block for block in blocks if block["confidence"] >= 0.45
              and any(char.isalnum() for char in block["text"])]
    if not strong:
        return blocks
    heights = sorted(block["height"] for block in strong)
    # Uniformly sized text has no credible foreground/background size distinction.
    if heights[int((len(heights) - 1) * 0.9)] <= heights[int((len(heights) - 1) * 0.1)] * 1.55:
        return strong
    best = max(_groups(strong), key=_score)
    clusters: list[list[dict]] = []
    for block in sorted(best, key=lambda b: -b["height"]):
        if not clusters or clusters[-1][0]["height"] > block["height"] * 1.55:
            clusters.append([])
        clusters[-1].append(block)
    dominant = max(clusters, key=_score)
    reference = statistics.median(block["height"] for block in dominant)
    candidates = [block for block in strong if block["height"] >= reference * 0.78]
    groups = _groups(candidates)
    best = max(groups, key=_score)
    # Preserve other substantial caption groups, but avoid isolated small logos.
    return [block for group in groups
            if group is best or _score(group) >= _score(best) * (0.25 if len(group) >= 2 else 0.5)
            for block in group]


def page_from_blocks(blocks: list[dict], index: int) -> dict:
    """Select existing OCR strings; never summarize, correct, or invent words."""
    return {"index": index,
            "text": "\n".join(block["text"] for block in _reading_order(_main_blocks(blocks))),
            "allText": "\n".join(block["text"] for block in _reading_order(blocks))}


def ocr_images(paths: list[Path], runtime_root: Path, checkpoint_dir: Path | None = None) -> list[dict]:
    if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_IMAGES:
        raise OCRError("Send a post containing between 1 and 35 images.")
    deadline = time.monotonic() + TOTAL_TIMEOUT
    root = Path(runtime_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    _environment(root)
    validated = []
    for path in paths:
        try:
            path = Path(path).resolve(strict=True)
            if not path.is_file() or not 0 < path.stat().st_size <= MAX_IMAGE_BYTES:
                raise ValueError()
        except (OSError, ValueError, TypeError):
            raise OCRError("One of the post's images is missing or too large.") from None
        validated.append(path)
    helper = _helper(root, deadline)
    helper_identity = helper.name
    if os.environ.get("CLIPTEXT_VISION_OCR_HELPER") is not None:
        # Packaged helpers keep a stable filename across upgrades, so include
        # their content identity when deciding whether observations are reusable.
        try:
            helper_identity += ":" + hashlib.sha256(helper.read_bytes()).hexdigest()
        except OSError:
            raise OCRError("The packaged image recognition tool could not be read.") from None
    pages = []
    total = 0
    for index, path in enumerate(validated, 1):
        from checkpoints import atomic_json, read_json
        fingerprint = hashlib.sha256(path.read_bytes()).hexdigest()
        cache_path = checkpoint_dir / f"ocr-{index:02d}.json" if checkpoint_dir else None
        cached = read_json(cache_path) if cache_path else None
        # Cache native observations, not typography decisions: improvements to
        # the main-text heuristic remain effective without repeating OCR.
        if isinstance(cached, dict) and cached.get("image") == fingerprint and cached.get("helper") == helper_identity:
            blocks = _parse(json.dumps({"blocks": cached.get("blocks")}).encode())
        else:
            blocks = _parse(_run([str(helper), str(path)], root, min(IMAGE_TIMEOUT, deadline - time.monotonic())))
            if cache_path:
                atomic_json(cache_path, {"image": fingerprint, "helper": helper_identity, "blocks": blocks})
        page = page_from_blocks(blocks, index)
        # Match JavaScript string-length limits at the Site boundary.
        total += len(page["allText"].encode("utf-16-le")) // 2
        if total > MAX_TOTAL_TEXT_CHARS:
            raise OCRError("This post contains too much text to extract safely.")
        pages.append(page)
        if time.monotonic() > deadline:
            raise OCRError("Image text extraction timed out. Try a smaller post.")
    return pages
