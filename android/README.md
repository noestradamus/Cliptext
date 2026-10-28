# Cliptext Share for Android

Version 0.6.0 / version code 6. Native Java, Android 8+ (API 26), target API 35. No runtime library dependencies or cloud service.

## Connect

1. Open the standalone Mac app, then **Sharing setup → Phone sharing**. Enable phone sharing and choose **Pair phone**.
2. Install this APK over an earlier Cliptext Share installation. Keep the same signing key to preserve the app's data. Do not uninstall to update.
3. Scan the Mac's QR code with the phone camera, or copy its pairing code into **Cliptext Share → Connection**. Tap **Connect**. The code expires after ten minutes.
4. From TikTok, Instagram or YouTube, share to **Save to Cliptext**. It commits the link to SQLite and immediately closes the share activity. It never opens the library.

An existing hosted-Site connection is deliberately retired during the update. Pending links remain on the phone and are delivered after local pairing; no hosted login, cookies or Site credentials are reused.

## Queue and offline library

Pending URLs and stable request UUIDs survive process death, update and restart. The Mac acknowledges a request before the phone removes it. Server-side receipts and canonical URL deduplication make a lost-response retry safe. Invalid links stay in the visible failed queue and can be retried.

The Mac remains the source of truth for transcripts, notes and collections. The phone keeps a read-only SQLite replica, including image-post text, titles and summaries. No network request is needed to open a saved transcript. Timestamp segments remain on the Mac. Images, thumbnails and original media are not downloaded to the phone in this milestone.

Each sync page and cursor commit in one SQLite transaction. Mac edits, trash, restores and permanent deletion update the phone on its next sync. Pairing a different Mac clears the old replica; a failed pairing attempt leaves it intact. Disconnecting clears the replica but preserves queued links. Revocation stops future network access. Already synced transcripts remain until the user disconnects or pairs another Mac.

Sharing schedules an immediate background attempt. A persisted Android job also checks approximately every 15 minutes when the OS permits. While the Mac is asleep, stopped or unreachable, links stay on the phone and saved transcripts remain readable. Opening the helper or tapping **Sync** starts an immediate check. Android Doze, network restrictions and force-stop can delay background execution; there is no promise of instant wake-time delivery.

## Wi-Fi and Tailscale

Use the same local network, or run Tailscale on both devices for delivery away from home. The Mac's Tailscale IP can be added in **Connection → Mac addresses** using `https://<address>:47322`; one address per line. Addresses may change without replacing the paired certificate, device token or offline library. No router port forwarding is needed or recommended.

Tailscale is optional networking software. Cliptext does not upload its queue, media or library to Tailscale or any shared Cliptext backend. Transcription still runs on the user's Mac. Waking the Mac alone does not make it reachable from an unrelated network.

## Trust and storage

The Mac's pairing capsule carries its certificate fingerprint, network addresses and a bootstrap capability valid only for pairing for ten minutes. Successful pairing exchanges it for a different device-scoped bearer capability. The QR/bootstrap capability cannot upload links or read the library, even after pairing. The Android client pins the complete leaf certificate SHA-256 and checks certificate validity before sending authorization. It never follows redirects or falls back to cleartext or an unpinned connection. The pin establishes identity across changing LAN/Tailscale IPs; the IP hostname itself is not the trust anchor.

Capabilities are AES-256-GCM encrypted with a non-exportable AndroidKeyStore key. Android backup is disabled. URLs and transcript text live only in app-private SQLite. Large JSON records use small text chunks so a valid transcript cannot exceed Android's per-cell CursorWindow limit. No credentials, pairing codes or transcript content are logged.

## Build and verification

The standard project uses JDK 17, Gradle 8.11.1, AGP 8.9.2, Android platform 35 and build-tools 35.0.0:

```sh
gradle :app:assembleDebug :app:testDebugUnitTest
gradle :app:connectedDebugAndroidTest
```

Run the instrumentation suite on a disposable emulator; it installs a debug build.

The portable build route is documented in [tools/PORTABLE-BUILD.md](tools/PORTABLE-BUILD.md). Keep the toolchain, private signing material, APKs and test reports outside this source checkout. Pure JVM tests cover URL validation, queue retry policy, pairing capsule validation, address updates, cursor ordering/tombstones, and large multibyte cache chunks. The desktop protocol probe exercises the same pinned Java HTTPS transport against a disposable Mac server without AndroidKeyStore.

Instrumentation tests under `app/src/androidTest` exercise the actual Android SQLite queue, atomic cache/cursor transactions, large records and AndroidKeyStore persistence. These require an emulator or phone. Compilation, JVM tests, and desktop TLS probes do not establish Android lifecycle, share-sheet, JobScheduler, TLS-provider, keystore, TalkBack or physical-device acceptance.
