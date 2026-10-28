# Third-party notices

This private snapshot contains Cliptext source and build manifests. It contains no packaged Python/Node runtime, compiled media tools, or model weights. Cliptext's own code currently has no chosen license (`UNLICENSED` in `package.json`). This document does not assign ownership or grant a license to that code.

Third-party components retain their own copyright and license terms. A binary distribution must carry the notices, license texts, and other materials required by the exact components it includes.

## JavaScript dependencies

The direct and transitive application/build dependencies are recorded in `package.json` and `package-lock.json`, including React, React DOM, ExcelJS, Vite, TypeScript, Tailwind CSS, esbuild, and the MIT-licensed `qrcode-generator` used for local pairing codes. Their upstream licenses apply independently of Cliptext's license status. Preserve the applicable notices when distributing dependencies or bundled output.

The Android helper uses Android platform APIs without bundled runtime libraries. Its portable build inputs (AAPT2, R8/D8, apksig, and compile-only AOSP framework JAR) are identified in `android/tools/PORTABLE-BUILD.md`. They remain external build tools rather than APK runtime contents.

The engine bundler separately pins the official Node.js 22.23.4 runtime. Its distribution includes Node.js and bundled-component license notices; preserve those materials in any runtime package.

## Python and native engine dependencies

`local-worker/packaging/runtime-sources.json` pins CPython 3.11.18 from the python-build-standalone project. CPython and the runtime's included components retain their respective license terms.

The complete engine wheel versions and hashes are recorded in:

- `local-worker/packaging/requirements-versions.lock`
- `local-worker/packaging/requirements-macos-arm64.lock`

These include MLX, MLX Whisper, MLX LM, yt-dlp, Requests, and their dependencies. Preserve wheel metadata, license files, and any notices required by the native libraries included in those wheels. The lock files identify build inputs; they do not replace upstream license texts or a distribution review.

Apple Vision, AppKit, WebKit, and other system frameworks used by the app are supplied by macOS. Those frameworks are not copied into this source snapshot.

## Models

Model weights are acquired separately. The manifest records the following upstream license declarations:

| Model repository | Declared license | Revision |
| --- | --- | --- |
| `mlx-community/whisper-large-v3-mlx` | MIT | `49e6aa286ad60c14352c404340ded53710378a11` |
| `mlx-community/Qwen3-4B-Instruct-2507-4bit` | Apache-2.0 | `50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b` |

See `local-worker/packaging/models.lock.json` for the exact accepted files. Retain the applicable upstream licenses, model notices, and attribution when redistributing weights. A manifest's license field alone does not fulfill those requirements.

## Fonts

Font files under `public/fonts/` are distributed under their accompanying SIL Open Font License 1.1 notices:

- `public/fonts/OFL.txt` contains the DM Sans notice.
- `public/fonts/licenses/` contains the other included families' individual OFL notices.

Keep those notices with redistributed font files and observe the applicable attribution and Reserved Font Name terms. Font licenses do not license the rest of the application.

## FFmpeg, FFprobe, and bundled libraries

The packaging script accepts externally supplied FFmpeg and FFprobe executables and copies their non-system library dependencies. Their license obligations depend on the selected build configuration and dependency closure. The current prototype's selected FFmpeg build has GPL and version-3 features enabled; it must not be treated as an LGPL-only build.

**Public binary redistribution is pending a complete corresponding-source and license-compliance package for the selected FFmpeg build and its dependencies.** The scripts collect available license files and build receipts, but those alone do not provide complete corresponding source or establish redistribution readiness. The source-only snapshot includes no FFmpeg/FFprobe binaries.

The app and runtime builders mark their outputs as prototypes that are not ready for public distribution. Ad-hoc signing and a successful runtime audit do not resolve licensing or notarization requirements.
