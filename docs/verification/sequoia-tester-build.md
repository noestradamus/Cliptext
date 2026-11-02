# Sequoia tester build verification

Recorded on 2026-10-30 for the private Apple Silicon tester build, version 0.4.1. The intended minimum is **macOS 15.6**. Runtime checks were performed on an Apple Silicon build Mac running **macOS 26.6**; a physical M2 Mac running 15.6 and a physical iPhone remain acceptance targets.

The local receipts contain the detailed inputs and results. Personal source links, transcript text, machine paths, hostnames, identifiers, and connection credentials are excluded from this report.

## Deployment-target checks

`engine-audit.json` passes with **246 Mach-O files**, six symlinks, and no issues. The highest declared native minimum is **15.0**, below the enforced **15.6** ceiling. The audit reports `deploymentTargetsWithinLimit:true`.

This checks the packaged native dependency closure and declared deployment targets. It does not establish Metal-driver behavior, every possible runtime symbol path, or actual installation and inference on Sequoia 15.6. Lowering the app metadata alone would not provide that evidence.

## Runtime checks on macOS 26.6

`models-smoke-report.json` records **seven passing checks**: isolation controls, the runtime doctor, speech transcription, image OCR, text insights, thumbnail generation, and bundled JavaScript execution.

The test runtime was relocated to a path containing spaces. Network, Homebrew, and `xcrun` access were denied, and the runtime and model directories were read-only. The doctor reports the embedded interpreter, tools, dependencies, and both local model directories as ready. These are real engine runs on the build host, rather than physical Sequoia acceptance.

`fresh-link-verification.json` records **seven passing checks** covering an empty test library, developer-tool/application-write denial, tester startup, link submission through the local API, fresh media download and full decode, a real engine result, and library backup. It reports fresh platform retrieval with no fixture, seeded checkpoint, or existing media used. This establishes the fresh-network path on the build host; it was not a native-window interaction test or a second-Mac install.

The owner's existing item records, active Android pairing count, and TLS identity matched their pre-test baseline, and the owner app remained running.

## Source and packaging checks

The observed test logs record:

| Log | Result |
| --- | --- |
| `node-tests.log` | 186 tests passed; zero failures, cancellations, or skipped tests. |
| `packaging-tests.log` | 47 tests passed. |
| `cleaner-tests-py311.log` | 13 tests passed. |

Native app assembly completed with its models included. The completed app audit reports **247 native files**, with a highest declared minimum of **15.6**. The app is ad-hoc signed, is not notarized, and retains the prototype/public-release-not-ready markers.

The source-material manifest was checked read-only against the complete file set, byte sizes, and SHA-256 digests. It includes all eleven requested tool source archives, their recipes/build inputs, model licenses, and JavaScript/font notices with no collection issues. This collection and integrity check is not an exact binary reproduction build or a certification of complete redistribution compliance.

## Final installer

The completed image is `Cliptext-0.4.1-Sequoia-AppleSilicon.dmg`, **5,556,920,816 bytes**, with SHA-256:

```text
9cc524cd47d616d830f5b3f9212dc0590d5f8a2af3e21cb6c3a007d8ea69f2c7
```

`dmg-mounted-report.json` records **seven passing checks** against the mounted image:

- Installer layout and signed bundle metadata match the verified input.
- Recipient-readable permissions are verified for **41,741 files**, along with six internal app symlinks.
- The source-material check covers **329 files** and eleven source archives with matching hashes.
- Generic phone Shortcut hashes match the verified app.
- Bundled Node reports **22.23.4**.
- Bundled Python reports **3.11.18**, and actual MLX evaluation returns **[2, 4, 6]**.

The first direct execution of the mounted Node binary timed out after 60 seconds. A scoped macOS log recorded an ad-hoc/unknown-certificate-chain assessment. An unchanged retry completed in 0.48 seconds. This transient first-execution result is retained as an observation; the log does not establish its full cause. The image was detached normally after verification.

## Remaining device acceptance

- Install the delivered app on the M2 Mac running Sequoia 15.6, then process a new public video and an image post using that Mac's own library.
- Pair the installed iPhone web app with that Mac's private Tailscale HTTPS address and fresh credentials.
- Exercise Save to Cliptext from the physical iPhone's TikTok Share menu, including first-use file/network permissions.
- Confirm a link remains saved while the Mac is unavailable, retries after reconnection, and produces a readable synced transcript.
- Confirm a previously synced transcript remains readable after closing the iPhone app from the app switcher and reopening it in airplane mode.

Use the [tester guide](../testing/sequoia-tester.md) to record these outcomes. Earlier iPhone simulator results are documented separately in [iPhone simulator verification](iphone-simulator.md).
