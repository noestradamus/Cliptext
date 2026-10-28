# Cliptext

A local-first Mac app that turns video and image-post links into a searchable text library.

The interface, SQLite database, media processing, and AI models run on each user's own Mac. No Sites hosting, ChatGPT account, or paid inference API is required. New post retrieval needs internet; saved transcripts remain available offline.

## Current prototype

- Paste TikTok, YouTube, or Instagram links.
- Transcribe speech with Whisper large-v3 through MLX.
- Extract text from image posts and carousels with Apple Vision.
- Generate short titles, one-line summaries, and suggested organization with Qwen3 4B through MLX.
- Organize items with collections, tags, notes, search, review state, and Trash.
- Export CSV/Excel by collection or save/restore a library backup.
- Choose appearance presets, custom colors, and fonts.
- Open the retained React interface in an AppKit/WKWebView Mac window.
- Pair the Android helper directly with the Mac using a QR code.
- Queue shared links on Android until the Mac is reachable, then retain synced transcripts for offline reading.

**Target:** Apple Silicon, macOS 26.2 or later; Android 8.0 or later for the companion. This is a private development snapshot, not a notarized public release. See [Android setup and build](android/README.md) for companion installation and device-verification limits.

## What is in this repository

Source code, tests, SQL migrations, build scripts, dependency/model checksum manifests, and licensed font/icon assets. There are no personal libraries, real transcript exports, downloaded videos, model weights, credentials, hosted deployment settings, or old project Git history.

Model manifests describe public upstream artifacts; the actual weights are downloaded separately and remain outside Git. Compiled applications and runtime binaries are also outside Git.

## Development

Use Node **22.23.4** (see `.nvmrc`). Building the native app/engine additionally requires an Apple Silicon Mac, Python 3.11, macOS command-line build tools, and FFmpeg/FFprobe. The finished application bundles its runtime and does not need those development tools installed to run.

```sh
npm ci
npm run build
npm run typecheck
npm run test:node
```

Python tests require the engine's Python dependencies. With an existing compatible interpreter:

```sh
CLIPTEXT_PYTHON=/absolute/path/to/python3.11 npm run test:python
```

See [engine packaging](local-worker/packaging/README.md) for constructing the pinned runtime and downloading/verifying models. Once those directories exist, run the local interface with explicit paths:

```sh
npm start -- \
  --engine-bundle "$PWD/.engine-build/CliptextEngine" \
  --engine-script "$PWD/local-worker/local_service.py" \
  --models-dir "$PWD/.engine-build/models" \
  --open
```

The app opens an authenticated local session automatically. Opening the bare loopback address without its launch session does not grant access to the library.

To assemble the native application after building the runtime and preparing models:

```sh
npm run package:local -- \
  --engine-bundle "$PWD/.engine-build/CliptextEngine" \
  --models "$PWD/.engine-build/models" \
  --output "$PWD/.engine-build/CliptextLocal"
npm run package:mac -- \
  --package "$PWD/.engine-build/CliptextLocal" \
  --output "$PWD/.engine-build/Cliptext.app"
```

Use fresh output directories. Build details and runtime behavior are in [local-app/README.md](local-app/README.md).

## Data and process ownership

The default library lives in `~/Library/Application Support/Cliptext`. Its SQLite database, private images, processing checkpoints, and logs belong to that Mac user. Closing the native window keeps processing alive; **Quit Cliptext** stops its own server and worker. The desktop interface binds to loopback only. Enabling phone sharing starts a separate HTTPS listener on port 47322, restricted to paired-device link submission and transcript sync. The desktop session, settings, worker operations, and file paths are never exposed by that listener.

Pair in **Sharing setup → Phone sharing**. The helper stores links before attempting delivery and stores synced text on the phone. The Mac remains the source of truth; the phone library is read-only. No Sites hosting or shared Cliptext queue is involved. Links saved while the Mac is asleep remain on Android until it is reachable. Android battery policies can delay automatic sync; **Sync now** runs it explicitly.

For local delivery, both devices must be on a network that allows them to reach each other. For delivery away from home, install [Tailscale](https://tailscale.com/download) on both devices and join the same private network. Use the Mac's Tailscale address in the helper connection if pairing happened before Tailscale was enabled. Tailscale provides connectivity, not Cliptext storage or transcription. Neither networking option wakes a sleeping or powered-off Mac. Transcript text already synced to the phone remains readable without either connection.

Public retrieval does not import browser logins. Posts that require account access or that are removed/restricted can fail. The TikTok downloader keeps metadata extraction and media download in the same temporary anonymous session; new jobs do not rely on pre-supplied media.

Unit tests use synthetic identifiers and data. The optional live verification runner requires an explicit `--url`; it contains no saved personal example.

## Before a public release

- Test installation on a second clean Mac.
- Complete native signing/notarization and binary-distribution license obligations.
- Choose the license for Cliptext itself and finish release/contributor documentation.
- Verify Android installation, quiet sharing, sleep/reconnect, and offline reading on a physical phone.

No open-source license for Cliptext itself has been selected yet. Dependencies and included fonts retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
