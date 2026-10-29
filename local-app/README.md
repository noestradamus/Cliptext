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
| `phone-sync/` | Private TLS identity for paired Android connections. |

A held SQLite lock prevents simultaneous migration/opening of one library. Startup recovers interrupted processing leases. The app supervises its own worker; closing the window preserves processing, and Quit stops the app-owned processes.

## Local authorization

The server listens on 127.0.0.1 and checks Host/Origin, private session cookies, and a separate in-memory engine key. A private launch capability connects the browser/native window, then is removed from the address. The bare local address does not authorize another local user. No hosted sign-in or browser credential extraction is implemented.

Shared route source retains two compile-time compatibility imports. The build resolves `cloudflare:workers` to local SQLite/files bindings and the former auth import to the local owner adapter. These aliases do not load Cloudflare or ChatGPT runtime services.

## Android synchronization

Phone sharing is disabled by default. Enable it in Sharing setup, then scan the pairing QR with the phone camera or paste the pairing code into Cliptext Share. Pairing codes expire after ten minutes. They contain a device capability and the Mac's certificate fingerprint; treat them as private. Credentials and TLS files are not part of library exports or the repository.

An independent TLS listener on port 47322 permits only pairing, link submission, and library sync. The phone pins the exact paired certificate and stores credentials using AndroidKeyStore. No browser cookies, Sites login, or media download is involved in phone delivery. Revoke a phone from Sharing setup to stop its future requests. Revocation cannot erase a disconnected device's existing offline copy.

SQLite records durable change cursors and deletion tombstones. Android applies each sync page and its cursor atomically; retries use durable request IDs and canonical link deduplication. The phone stores transcript text, carousel text, notes, tags, and collection information, rather than downloading source videos. Local Wi-Fi and optional Tailscale connectivity use the same protocol. Android's scheduler controls background timing; waking the Mac does not guarantee an immediate phone job.

The TLS identity is generated with macOS's built-in `/usr/bin/openssl` when sharing is first enabled. Runtime operation does not require Xcode, Homebrew, or an installed development interpreter. Keep that identity with the Mac library; changing it requires pairing the phone again.

## iPhone web companion

The package includes a separate `pwa/` interface. Enable it in Sharing setup with the Mac’s HTTPS Tailscale hostname; Tailscale Serve forwards only to the opt-in companion listener on `127.0.0.1:47323`. Desktop authorization, worker routes, and native Android TLS remain separate. Pairing creates revocable browser sessions; Shortcuts receive a different submit-only capability. The PWA retains synced reading text in IndexedDB and precaches only its shell/assets. See [iPhone installation and offline behavior](../docs/iphone.md) and [Shortcut builds](../ios-shortcuts/README.md).

## Verification

Run `npm run build`, `npm run typecheck`, and `npm run test:node`. These tests exercise real SQLite/files, local HTTP sessions, persistence, backup/export, and owned-process lifecycle with synthetic worker fixtures. They do not establish speech/OCR accuracy or a second physical Mac installation.

`verify-fresh-retrieval.mjs` is an optional operator-only acceptance runner. It requires an explicit public TikTok `--url`, an assembled runtime under a fresh `/private/tmp/` workspace named `Cliptext Local`, and models prepared separately. `--write-profile` creates its restrictive macOS sandbox profile. The runner waits for ordinary UI submission, then verifies fresh download, full media decode, actual local inference, preview, and backup. It imports no fixture, backup, or processing checkpoint. Launch capabilities in its private ready file must never be committed or shared.

## Remaining scope

The current target is Apple Silicon/macOS26.2+. Prototype signatures are ad hoc; public signing/notarization, complete binary redistribution notices/source obligations, second-Mac acceptance, and physical Android acceptance remain release work. Library backups currently omit custom theme/appearance settings and device connections.
