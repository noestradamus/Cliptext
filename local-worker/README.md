# Local engine

Cliptext processes each user's media on their own Mac. The standalone app uses `local_service.py`, supervised by the local Node server, with a SQLite library and a private loopback API. It does not need Sites hosting, a transcription API key, or a hosted worker.

The current packaged runtime targets **Apple Silicon and macOS 26.2 or later**. It is a development prototype; the native app is ad-hoc signed and is not notarized. See the [app instructions](../local-app/README.md) for building and running the complete interface.

## Processing

- `worker.py` handles retrieval, queue leases, recovery, transcription, previews, and analysis.
- `image_posts.py` retrieves image posts and carousels; `ocr.py` uses the packaged Apple Vision helper.
- `insights.py` generates titles, short summaries, takeaways, and suggested tags with Qwen.
- `checkpoints.py` keeps resumable job state in the private runtime directory.
- `local_service.py` connects these components to the local app. The supervisor supplies its private configuration through stdin, including explicit model directories and an ephemeral engine key.
- `standalone.py` exposes file-based processing for development and verification.

Speech uses **Whisper large-v3 through MLX Whisper**. Text analysis uses **Qwen3 4B Instruct 2507, quantized to 4-bit, through MLX LM**. Their exact revisions and file hashes are in [models.lock.json](packaging/models.lock.json). Models are acquired explicitly during setup; the local app's inference path does not download missing weights.

Retrieving a platform link needs internet access. Transcription, image OCR, text analysis, and the saved library run locally. Public-link retrieval does not import browser login cookies by default; platform availability and access restrictions still apply.

## Build and exercise the engine

Follow the [packaging instructions](packaging/README.md) to create the runtime and prepare its models. From the repository root, check that the relocated package is complete:

```sh
.engine-build/CliptextEngine/cliptext-engine doctor \
  --require-bundle \
  --speech-model "$PWD/.engine-build/models/whisper-large-v3" \
  --insights-model "$PWD/.engine-build/models/qwen3-4b"
```

Process a local file you supply:

```sh
.engine-build/CliptextEngine/cliptext-engine transcribe \
  --input ./video.mp4 \
  --speech-model "$PWD/.engine-build/models/whisper-large-v3" \
  --output-dir .engine-build/results/speech
```

The CLI also provides `ocr`, `insights`, and `thumbnail`; use `--help` on each subcommand. Output directories contain the result JSON and generated artifacts. Input media, model weights, and generated results are not part of this source snapshot.

## Compatibility code

`worker.py` also retains the older hosted-client interface, and `service.py` retains the older hosted-service launcher. The standalone app does not use that launcher, its hosted configuration, or its Keychain setup. Start the local app through the app's launcher instead of running `service.py`.

Dependency and redistribution notes are in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). This source snapshot has no chosen license for Cliptext's own code.
