# Local Mac application

The current interface runs against a local SQLite library and packaged transcription, OCR, summary, and preview engine. It needs no hosted account or inference API key. Source setup/build commands are in the [root README](../README.md); engine construction is in [packaging](../local-worker/packaging/README.md).

## Runtime package

`local-app/build.mjs` builds the React client and Node server, then copies the SQL migrations. `package.mjs` combines them with an independently prepared engine and model directory. `build-mac.mjs` wraps the package in an AppKit/WKWebView application with embedded runtimes and weights. Generated packages stay outside Git.

For development, Node 22.23.4 is pinned. Runtime data defaults to `~/Library/Application Support/Cliptext`:

| Path | Contents |
| --- | --- |
| `library.sqlite` | Items, text, collections, notes, tags, review/Trash state, themes, and appearance. |
| `assets/` | Private image objects. |
| `engine/` | Processing checkpoints, temporary files, and caches. |
| `logs/` | Local diagnostics. |
| `migration-backups/` | SQLite snapshots created before later schema upgrades. |

A held SQLite lock prevents simultaneous migration/opening of one library. Startup recovers interrupted processing leases. The app supervises its own worker; closing the window preserves processing, and Quit stops the app-owned processes.

## Local authorization

The server listens on 127.0.0.1 and checks Host/Origin, private session cookies, and a separate in-memory engine key. A private launch capability connects the browser/native window, then is removed from the address. The bare local address does not authorize another local user. No hosted sign-in or browser credential extraction is implemented.

Shared route source retains two compile-time compatibility imports. The build resolves `cloudflare:workers` to local SQLite/files bindings and the former auth import to the local owner adapter. These aliases do not load Cloudflare or ChatGPT runtime services.

## Verification

Run `npm run build`, `npm run typecheck`, and `npm run test:node`. These tests exercise real SQLite/files, local HTTP sessions, persistence, backup/export, and owned-process lifecycle with synthetic worker fixtures. They do not establish speech/OCR accuracy or a second physical Mac installation.

`verify-fresh-retrieval.mjs` is an optional operator-only acceptance runner. It requires an explicit public TikTok `--url`, an assembled runtime under a fresh `/private/tmp/` workspace named `Cliptext Local`, and models prepared separately. `--write-profile` creates its restrictive macOS sandbox profile. The runner waits for ordinary UI submission, then verifies fresh download, full media decode, actual local inference, preview, and backup. It imports no fixture, backup, or processing checkpoint. Launch capabilities in its private ready file must never be committed or shared.

## Remaining scope

The current target is Apple Silicon/macOS26.2+. Prototype signatures are ad hoc; public signing/notarization, complete binary redistribution notices/source obligations, and second-Mac acceptance remain release work. Android pairing, queued sharing, and offline phone reading are not included. Library backups currently omit custom theme/appearance settings.
