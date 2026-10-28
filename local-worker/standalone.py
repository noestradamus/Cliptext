#!/usr/bin/env python3
"""Offline, file-based Cliptext engine entry point; no Site or service setup."""
from __future__ import annotations

import argparse
import contextlib
import gc
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import sys
import time

from checkpoints import atomic_json

VERSION = "0.1.0"
DEPENDENCIES = {
    "mlx": "mlx", "mlx_whisper": "mlx-whisper", "mlx_lm": "mlx-lm",
    "yt_dlp": "yt-dlp", "requests": "requests", "huggingface_hub": "huggingface-hub",
    "transformers": "transformers", "curl_cffi": "curl-cffi",
}


def offline_environment() -> None:
    # Deliberately overwrite ambient values. This command never prepares models
    # or resolves media URLs; callers must provide existing files and weights.
    os.environ.update({
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1", "HF_HUB_DISABLE_PROGRESS_BARS": "1",
        "TOKENIZERS_PARALLELISM": "false", "DO_NOT_TRACK": "1",
    })


def _file(value: str | Path) -> Path:
    if "://" in str(value):
        raise ValueError("This command accepts a local file, not a URL.")
    path = Path(value).expanduser().resolve(strict=True)
    if not path.is_file():
        raise ValueError("The input must be an existing local file.")
    return path


def _model(value: str | Path, label: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(f"The {label} model must be an absolute local directory.")
    path = path.resolve(strict=True)
    if not path.is_dir() or not (path / "config.json").is_file():
        raise ValueError(f"The local {label} model is missing config.json.")
    if not (any(path.glob("*.safetensors")) or (path / "weights.npz").is_file()):
        raise ValueError(f"The local {label} model weights are missing.")
    return path


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root)
        return True
    except ValueError:
        return False


def doctor(args) -> dict:
    bundle_value = os.environ.get("CLIPTEXT_BUNDLE_ROOT")
    bundle = Path(bundle_value).resolve(strict=True) if bundle_value else None
    strict = bool(bundle or args.require_bundle)
    tools = {}
    for name in ("ffmpeg", "ffprobe", "node"):
        found = shutil.which(name)
        tools[name] = {"path": found, "bundled": bool(found and bundle and _inside(Path(found), bundle))}
    helper = os.environ.get("CLIPTEXT_VISION_OCR_HELPER")
    helper_ok = bool(helper and Path(helper).is_absolute() and Path(helper).is_file() and os.access(helper, os.X_OK))
    tools["vision-ocr"] = {"path": helper, "precompiled": helper_ok,
                           "bundled": bool(helper_ok and bundle and _inside(Path(helper), bundle))}
    dependencies = {}
    for module, distribution in DEPENDENCIES.items():
        version = None
        try:
            spec = importlib.util.find_spec(module)
            locations = ([spec.origin] if spec and spec.origin else
                         list(spec.submodule_search_locations or []) if spec else [])
            installed = bool(spec)
            with contextlib.suppress(importlib.metadata.PackageNotFoundError):
                version = importlib.metadata.version(distribution)
            dependencies[distribution] = {"version": version, "paths": locations,
                "installed": installed, "bundled": bool(locations and bundle and all(_inside(Path(p), bundle) for p in locations))}
        except (ImportError, ValueError, OSError) as error:
            dependencies[distribution] = {"installed": False, "error": type(error).__name__, "bundled": False}
    models = {}
    for name in ("speech", "insights"):
        value = getattr(args, name + "_model", None)
        if value:
            models[name] = {"path": str(_model(value, name)), "ready": True}
    supported = platform.system() == "Darwin" and platform.machine() == "arm64"
    python_bundled = bool(bundle and _inside(Path(sys.executable), bundle) and _inside(Path(sys.prefix), bundle))
    ready = (supported and all(item.get("path") for item in tools.values()) and helper_ok
             and all(item["installed"] for item in dependencies.values()))
    if strict:
        ready = ready and python_bundled and all(item["bundled"] for item in tools.values()) and all(item["bundled"] for item in dependencies.values())
    return {"operation": "doctor", "ready": bool(ready), "offline": True,
            "version": VERSION, "bundleRoot": str(bundle) if bundle else None,
            "requireBundle": strict, "platform": {"system": platform.system(), "architecture": platform.machine(), "supported": supported},
            "python": {"executable": sys.executable, "prefix": sys.prefix, "version": platform.python_version(), "bundled": python_bundled},
            "tools": tools, "dependencies": dependencies, "models": models}


def _output(value: str | Path) -> Path:
    root = Path(value).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    if not root.is_dir():
        raise ValueError("The output directory is not a directory.")
    return root


def _insights(source: str, model: Path, root: Path, payload: dict | None = None) -> dict:
    from insights import generate_insights, MODEL_NAME
    if not source.strip():
        raise ValueError("No source text is available for the requested local AI insights.")
    payload = payload or {"job": {"transcript": source}, "collections": [], "tags": []}
    result = generate_insights(payload, root, model)
    if result.get("engine") != MODEL_NAME:
        raise RuntimeError("The requested local language model did not produce a validated result; an extractive fallback was not accepted.")
    return {**result, "modelDirectory": str(model)}


def _release_speech_model() -> None:
    # The second model runs in its existing isolated child process. Release
    # speech weights first to avoid loading both models into unified memory.
    from mlx_whisper.transcribe import ModelHolder
    import mlx.core as mx
    ModelHolder.model = None
    ModelHolder.model_path = None
    gc.collect()
    mx.clear_cache()


def transcribe(args) -> dict:
    from worker import audio_from_media, transcribe_file, encode_preview
    source = _file(args.input)
    model = _model(args.speech_model, "speech")
    insight_model = _model(args.insights_model, "insights") if args.insights_model else None
    root = _output(args.output_dir)
    audio, duration = audio_from_media(source, root)
    speech = transcribe_file(audio, model)
    result = {"operation": "transcribe", "source": str(source), "speechModelDirectory": str(model),
              "durationSeconds": duration, **speech}
    atomic_json(root / "extraction.json", result)
    if args.thumbnail:
        preview = encode_preview(source, root, first_frame=True)
        result["preview"] = {"path": str(preview), "kind": "first_frame"}
    if insight_model:
        _release_speech_model()
        result["analysis"] = _insights(str(speech.get("transcript") or ""), insight_model, root)
    return result


def recognize(args) -> dict:
    from ocr import ocr_images, OCR_ENGINE
    # Standalone recognition must not compile code on the user's machine.
    helper = os.environ.get("CLIPTEXT_VISION_OCR_HELPER")
    if not helper or not Path(helper).is_absolute() or not Path(helper).is_file() or not os.access(helper, os.X_OK):
        raise ValueError("Standalone OCR requires the packaged precompiled image recognition tool.")
    sources = [_file(value) for value in args.input]
    insight_model = _model(args.insights_model, "insights") if args.insights_model else None
    root = _output(args.output_dir)
    pages = ocr_images(sources, root, root)
    text = "\n\n".join(page["text"] for page in pages)
    result = {"operation": "ocr", "source": [str(value) for value in sources], "ocrEngine": OCR_ENGINE,
              "contentKind": "image" if len(pages) == 1 else "carousel", "transcript": text, "pages": pages}
    atomic_json(root / "extraction.json", result)
    if insight_model:
        result["analysis"] = _insights(text, insight_model, root)
    return result


def summarize(args) -> dict:
    source = _file(args.input)
    model = _model(args.insights_model, "insights")
    root = _output(args.output_dir)
    if source.stat().st_size > 1024 * 1024:
        raise ValueError("The local insights input must be smaller than 1 MiB.")
    raw = source.read_text(encoding="utf-8")
    payload = None
    if source.suffix.lower() == ".json":
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("The insights JSON must be a transcript object or an insight payload.")
        if isinstance(parsed.get("job"), dict):
            payload = parsed
            raw = str(parsed["job"].get("transcript") or "")
        else:
            raw = str(parsed.get("transcript") or "")
    return {"operation": "insights", "source": str(source), **_insights(raw, model, root, payload)}


def thumbnail(args) -> dict:
    from worker import encode_preview
    source = _file(args.input)
    root = _output(args.output_dir)
    preview = encode_preview(source, root, first_frame=args.first_frame)
    return {"operation": "thumbnail", "source": str(source), "preview": {"path": str(preview),
            "kind": "first_frame" if args.first_frame else "image"}}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--version", action="version", version="cliptext-engine " + VERSION)
    commands = result.add_subparsers(dest="command", required=True)
    probe = commands.add_parser("doctor", help="Report local dependencies and bundled executable paths; does not load model weights.")
    probe.add_argument("--require-bundle", action="store_true")
    probe.add_argument("--speech-model")
    probe.add_argument("--insights-model")
    probe.add_argument("--output-dir")
    speech = commands.add_parser("transcribe", help="Transcribe existing local media using existing local speech weights.")
    speech.add_argument("--input", required=True)
    speech.add_argument("--speech-model", required=True)
    speech.add_argument("--insights-model")
    speech.add_argument("--thumbnail", action="store_true", help="Also extract the video's first frame; requires a video stream.")
    speech.add_argument("--output-dir", required=True)
    image = commands.add_parser("ocr", help="Recognize existing local images with the precompiled Apple Vision helper.")
    image.add_argument("--input", action="append", required=True)
    image.add_argument("--insights-model")
    image.add_argument("--output-dir", required=True)
    summary = commands.add_parser("insights", help="Generate local AI titles and summaries from UTF-8 text or extraction JSON.")
    summary.add_argument("--input", required=True)
    summary.add_argument("--insights-model", required=True)
    summary.add_argument("--output-dir", required=True)
    preview = commands.add_parser("thumbnail", help="Encode a local image, or extract a local video's first frame.")
    preview.add_argument("--input", required=True)
    preview.add_argument("--first-frame", action="store_true")
    preview.add_argument("--output-dir", required=True)
    return result


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    offline_environment()
    previous_umask = os.umask(0o077)
    started = time.monotonic()
    try:
        action = {"doctor": doctor, "transcribe": transcribe, "ocr": recognize,
                  "insights": summarize, "thumbnail": thumbnail}[args.command]
        result = action(args)
        okay = result.get("ready", True)
        result = {"status": "completed" if okay else "failed", "offline": True,
                  "engineVersion": VERSION, **result, "elapsedSeconds": round(time.monotonic() - started, 3)}
        if args.output_dir:
            atomic_json(_output(args.output_dir) / "result.json", result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0 if okay else 1
    except (Exception, KeyboardInterrupt) as error:
        from worker import safe_error
        result = {"status": "failed", "operation": args.command, "offline": True,
                  "engineVersion": VERSION, "error": safe_error(error) or type(error).__name__,
                  "elapsedSeconds": round(time.monotonic() - started, 3)}
        if args.output_dir:
            with contextlib.suppress(OSError, ValueError):
                atomic_json(_output(args.output_dir) / "result.json", result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 130 if isinstance(error, KeyboardInterrupt) else 1
    finally:
        from local_processes import stop_all
        stop_all()
        os.umask(previous_umask)


if __name__ == "__main__":
    raise SystemExit(main())
