# Sequoia Mac and iPhone tester guide

This private build targets an Apple Silicon Mac running **macOS Sequoia 15.6 or later**. Its models and runtimes are included. There is no developer-tool installation or paid inference API setup for the recipient.

Native deployment-target checks and tests on the build Mac are preparation evidence. A successful install, real inference, and phone flow on the tester's M2/Sequoia 15.6 Mac and physical iPhone are still required for device acceptance. Record those outcomes separately from the earlier iPhone simulator tests.

## Install the app

1. Open the supplied disk image and drag **Cliptext** to **Applications**. Eject the disk image and launch the installed copy.
2. This private build is ad-hoc signed and is not notarized. If macOS blocks the first launch, use **System Settings → Privacy & Security → Open Anyway** for Cliptext and approve the macOS prompt yourself. Follow [Apple's instructions](https://support.apple.com/en-us/102445). If macOS reports a damaged app or no per-app approval is available, stop and report the exact message. Do not remove quarantine attributes or disable Gatekeeper with Terminal commands.
3. Wait for **Running**. On a fresh Mac account, the library should be empty. Paste a new public TikTok link and wait for the transcript, short title, and summary.

The app creates `~/Library/Application Support/Cliptext` on that Mac. It contains that user's library, private media, checkpoints, and local connections. The installer does not carry another user's library, logins, Tailscale identity, or pairing settings. If an existing Cliptext library is already present, the app opens it; make a library backup before testing an update.

Keep Cliptext running and the Mac awake while processing. Closing its window keeps processing alive; **Quit Cliptext** stops its own server and worker. New retrieval needs internet access. Saved text, transcription, OCR, and summaries run locally. Restricted or removed posts can fail without indicating an installation fault.

## Set up the private phone connection once

Use the tester's own Tailscale account and private network for their Mac and iPhone. Each Mac has its own HTTPS address; do not reuse a developer's URL or connection settings.

1. Install [Tailscale](https://tailscale.com/download) on the Mac and iPhone. Sign in with the same personal account on both, turn it on, and confirm both devices are connected.
2. Find the Mac's full HTTPS MagicDNS hostname in Tailscale, such as `https://your-mac.your-tailnet.ts.net`. Use a nonsensitive machine name: HTTPS certificate issuance makes the hostname visible in public certificate logs.
3. In Cliptext on the Mac, open **Sharing setup → iPhone**, enter that address, and choose **Enable iPhone connection**.
4. Configure Tailscale Serve once. With the standalone Tailscale Mac app installed at its usual location, run these commands in Terminal:

   ```sh
   /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=443 http://127.0.0.1:47323
   /Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
   ```

   Tailscale may ask you to enable HTTPS certificates through its authenticated setup page. Complete that step yourself using your own account.

5. Confirm Serve forwards HTTPS to **`127.0.0.1:47323`**. Keep the connection private; do not enable Tailscale Funnel. Do not forward desktop port 47321 or Android port 47322.
6. On the connected iPhone, open the Mac's HTTPS address in Safari. It should display Cliptext's connection screen with a valid certificate. Stop and report any certificate warning.

This network setup does not wake the Mac or store library data online. A sleeping or powered-off Mac stays unavailable until it wakes. Leave Tailscale connected on both devices for later syncing, including when the phone is away from home.

## Install and pair the iPhone library

1. In Safari at the Mac's HTTPS address, choose **Share → Add to Home Screen**.
2. Open Cliptext using its new Home Screen icon.
3. In the Mac app, choose **Sharing setup → iPhone → Pair iPhone**. Paste that fresh code into the installed phone app, then tap **Connect**.
4. Tap **Sync**. Check the saved item from the Mac and wait for **Offline reading is ready** in the Connection panel.

Pair inside the Home Screen app, even if Safari was already paired. iOS can use separate storage for those two contexts. The pairing code expires after ten minutes; generate a new one if it expires.

The phone retains text, summaries, notes, tags, and collections. It does not cache the original videos, audio, or images. Sync runs while the web app is open or returns to the foreground, or when **Sync** is tapped. Closed-app background delivery is not guaranteed. The Mac is the source of truth, and the phone's library is read-only in this release.

## Set up sharing from TikTok

1. In the iPhone Cliptext app, open the **Connection** panel and download the generic **Save to Cliptext** and **Sync Cliptext** templates. Install them in Apple Shortcuts.
2. Choose **On My iPhone → Downloads** as the local parent folder for both. Each Shortcut creates or reuses the same `Cliptext` folder there. Keep it on the phone, outside iCloud Drive, for the local-only test.
3. If **Add Shortcut** is inert after folder selection on iOS 27, tap **Skip Setup**. This retained the selected folder during the simulator test. Before the first run, open each Shortcut in its editor and confirm the first **Create Folder** action points to the local **On My iPhone → Downloads** parent. Behavior on the tester's physical iOS version is part of the test.
4. On the Mac, expand **Sharing setup → iPhone → Save to Cliptext Shortcut**, then choose **Create Shortcut connection**. Transfer those settings privately to your own phone and paste them when the Shortcut asks on its first run. They grant link submission to your Mac; do not send them in a bug report.
5. From TikTok, share a new public video using **Save to Cliptext** in the iOS Share menu. TikTok may place the system Share menu under **More**. If the Shortcut is absent, report the iOS/TikTok versions and the visible Share options.

The Share Shortcut should save the link without opening the full Cliptext library. iOS can show its own Shortcut progress and first-use file or network permission prompts. The first Mac connection must be completed while the Mac is reachable so the Shortcut can store its settings. Later requests are saved before a network attempt.

The Shortcut's outbox is in the local `Cliptext/pending` folder. A matching Mac receipt moves the request to `Cliptext/sent`. **Sync Cliptext** retries pending files. The Home Screen app has its own queue for links pasted there; opening it cannot drain the Shortcut's files. Preserve `pending` when troubleshooting.

## Record the device results

| Check | What to verify |
| --- | --- |
| Fresh install | App opens from Applications without Homebrew, Node, Python, Xcode, or another Cliptext installation. The new library is empty. |
| Real processing | A new public TikTok link is retrieved and produces a readable transcript, short title, and one-line summary on the M2 Mac. |
| Image text | A public image post or carousel produces slide text using the local OCR engine. |
| Physical iPhone pairing | The installed Home Screen app connects to this Mac and shows the new items after Sync. |
| Real TikTok sharing | Save to Cliptext appears in TikTok's iOS Share menu and saves the link without opening the Cliptext library. |
| Mac unavailable | With the Mac asleep, a new shared link remains in the local Shortcut outbox. A network error may appear. Confirm the Mac actually stayed asleep; if it woke, record that and repeat with Cliptext's iPhone connection turned off temporarily. |
| Reconnect | Wake the Mac or restore its iPhone connection, keep both Tailscale connections on, and run Sync Cliptext. The pending request moves to sent. Wait for processing, then tap Sync in the Home Screen app and read the completed transcript. |
| Offline reading | After a completed sync, turn on airplane mode, close Cliptext from the iPhone app switcher, reopen its Home Screen icon, and read the synced transcript. Restore connectivity after the test. |
| Away-from-home connection | With Mac awake and iPhone Wi-Fi off, leave mobile data and Tailscale on. Run Sync Cliptext and then Sync in the phone app. |
| Retry | Run Sync Cliptext again after delivery. The same library item should not be duplicated. |

Record the app version, Mac chip, macOS version, iOS version, and pass/fail for each applicable row. For a failure, note the exact step, visible error, source platform, and whether the Mac was awake and Tailscale connected. A public example link can help reproduce retrieval issues. Keep pairing codes, connection settings, passwords, and private transcripts out of reports and screenshots. Share a library backup only if you have reviewed its contents and intend to share that data.

## If a connection stops working

- Keep the Mac awake, Cliptext running, and Tailscale connected on both devices; then try the phone app's **Sync** and the separate **Sync Cliptext** Shortcut.
- An expired pairing code needs a fresh code from **Pair iPhone**.
- If the Shortcut credential was revoked or replaced, use Files to move `cliptext-connection.json` out of the local `Cliptext` folder. Run the Shortcut again and paste fresh settings. Keep the `pending` folder and its files in place.
- A revoked connection cannot sync again until paired or configured afresh. Revocation does not erase an already saved offline phone copy.
- Keep regular Mac library backups. iOS can clear browser storage, and the Shortcut outbox and phone library are separate local stores.
