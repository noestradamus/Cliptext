# Standalone engine packaging

These are build-time tools for an Apple Silicon macOS runtime. The source snapshot contains scripts and lock files, **not compiled tools, model weights, or a ready-to-install app**. The current runtime requires macOS 26.2 or later.

The build machine needs Python, Xcode Command Line Tools, and an arm64 FFmpeg/FFprobe installation. Building the complete app also needs the Node/npm toolchain described in the [app instructions](../../local-app/README.md). The resulting package includes its own Python, Node, media tools, and compiled Vision helper; users do not need developer tools or Homebrew to run it.

## Build the runtime

Run from the repository root. Supply the FFmpeg and FFprobe executables from the build you intend to package:

```sh
python3 local-worker/packaging/bundle_tools.py \
  --output .engine-build/CliptextEngine \
  --cache .engine-build/cache \
  --ffmpeg /path/to/ffmpeg \
  --ffprobe /path/to/ffprobe

python3 local-worker/packaging/build_engine.py \
  --output .engine-build/CliptextEngine \
  --cache .engine-build/cache
```

`bundle_tools.py` downloads a SHA-256-pinned Node 22.23.4 archive, copies the selected media-tool dependency closure, relocates its non-system libraries, and compiles `vision-ocr.swift`. `build_engine.py` downloads a pinned standalone CPython 3.11.18 runtime and installs the exact binary wheels listed in the hash lock. These steps need network access unless the required downloads are already cached.

The runtime contains `bin/`, `lib/`, `python/`, `engine/`, `resources/`, `licenses/`, and the `cliptext-engine` launcher. Keep the entire directory together when relocating it.

## Prepare models explicitly

To download the exact approved files into a separate directory:

```sh
python3 local-worker/packaging/prepare_models.py \
  --output .engine-build/models \
  --download
```

Alternatively, import existing copies of the same pinned models:

```sh
python3 local-worker/packaging/prepare_models.py \
  --output .engine-build/models \
  --speech-from /path/to/whisper-large-v3 \
  --insights-from /path/to/qwen3-4b
```

Both paths validate every approved file against [models.lock.json](models.lock.json), including size and SHA-256. Extra files and symlinks are rejected. The two model directories use approximately **5.36 GB of disk space**; this is not a memory requirement.

| Directory | Upstream model | Pinned revision |
| --- | --- | --- |
| `whisper-large-v3` | `mlx-community/whisper-large-v3-mlx` | `49e6aa286ad60c14352c404340ded53710378a11` |
| `qwen3-4b` | `mlx-community/Qwen3-4B-Instruct-2507-4bit` | `50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b` |

The app receives explicit local model paths. Missing or invalid weights require setup to be completed; they do not trigger an inference-time model download.

## Verify and assemble the app

Run the `doctor` example in the [engine README](../README.md), then process operator-supplied local media to verify speech, OCR, analysis, and previews. `audit_bundle.py` checks native-library references and the required runtime structure:

```sh
python3 local-worker/packaging/audit_bundle.py \
  --bundle .engine-build/CliptextEngine \
  --output .engine-build/runtime-audit.json
```

An audit is a structural check; actual inference and a clean-device installation require separate verification. The smoke utilities can prepare a relocated, restricted test runtime from local fixtures; see their `--help` and provide your own non-sensitive test inputs.

The full app packager consumes the engine and the separate model directory after the frontend/server build. Follow the [app instructions](../../local-app/README.md) for that build and the native wrapper.

## Maintain the pins

| File | Purpose |
| --- | --- |
| `runtime-sources.json` | CPython source URL, release, and archive digest |
| `requirements.in` | Direct standalone-engine dependencies |
| `requirements-versions.lock` | Complete pinned Python dependency closure |
| `requirements-macos-arm64.lock` | Exact accepted wheel digests |
| `models.lock.json` | Model revisions and every accepted file digest |
| `bundle_tools.py` | Node archive pin and media-tool bundling rules |

The direct Python pins are MLX 0.32.4, MLX Whisper 0.4.3, MLX LM 0.32.2, yt-dlp 2026.10.21, and Requests 2.34.2. Do not substitute the legacy `local-worker/requirements.lock.txt` for the standalone hash lock. Dependency updates require deliberate lock regeneration and review; `--bootstrap-lock` is for that maintenance workflow, not a normal build step.

## Distribution status

The build uses ad-hoc signatures and produces prototype manifests with public redistribution disabled. It does not notarize the app. The selected FFmpeg build and its transitive libraries determine the applicable terms; the current prototype uses a GPL/version-3-enabled build. Corresponding-source and other distribution requirements remain pending before a public binary release. Collected license files and package receipts are not a substitute for complete corresponding source.

See [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). No license for Cliptext's own code has been chosen in this private source snapshot.
