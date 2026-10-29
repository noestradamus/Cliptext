# iPhone companion

The iPhone uses an installed web app for the library and Apple Shortcuts for the Share menu. Processing and the main library stay on the user's Mac. There is no Cliptext hosting account, paid API, Apple Developer membership, or weekly signing renewal.

## Private HTTPS on the Mac

1. Install Tailscale on the Mac and iPhone, sign in to the same private network, and leave it connected. Cliptext does not configure an internet-facing Funnel.
2. Build/package Cliptext with the `pwa` directory included. In **Sharing setup → iPhone**, enter the Mac's full HTTPS MagicDNS address, such as `https://your-mac.your-tailnet.ts.net`, and enable the connection.
3. Configure Tailscale Serve to forward HTTPS to the dedicated companion listener:

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:47323
   tailscale serve status
   ```

   The standalone Mac application includes its CLI inside `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. Tailscale may first ask the network owner to enable HTTPS certificates. The machine's HTTPS hostname appears in public certificate transparency records; library data and credentials do not. Keep device names nonsensitive.

4. Open the HTTPS address. It should show the phone library's connection screen. Do **not** proxy the desktop port 47321 or Android port 47322. Never bypass a certificate warning.

Serve provides private connectivity and trusted TLS. It does not store links, transcripts, or model files. It does not wake the Mac. Existing Tailscale access controls still apply; Cliptext additionally requires a paired device.

## Install and pair the library

1. On iPhone Safari, open the HTTPS address and choose **Share → Add to Home Screen**.
2. Open Cliptext from the Home Screen. Generate a fresh code in the Mac's **Sharing setup → iPhone → Pair iPhone**, and paste it into the installed app. Pairing in Safari alone may not connect the installed app because iOS can separate their browser storage.
3. Tap **Sync**. Wait for the library to finish syncing and the offline shell to finish installing before testing with airplane mode.

The web app retains transcript text, carousel text, summaries, notes, tags, and collections in IndexedDB. It caches only its interface and bundled assets in the service worker; authenticated API responses and credentials are never placed in CacheStorage. Raw videos, images, and audio are not cached on the phone. Phone appearance settings stay on that device.

Search, collection/filter views, copying text, and reading synced transcripts work while the Mac is unavailable. Pasted links enter a durable local queue before delivery. Sync runs when the app opens/returns to the foreground, when connectivity returns with the app active, or when **Sync** is tapped. iOS does not provide this app with reliable closed-app background sync.

The Mac remains the source of truth. Phone edits to transcripts/organization are not part of this release. Changes and deletions arrive on the next sync. Disconnecting a device blocks future requests but cannot erase an offline copy on a disconnected phone. Browser storage can be cleared or evicted by the system; keep Mac library backups.

## Save to Cliptext in the Share menu

Install the two credential-free templates from the private web app or `ios-shortcuts` build output:

- **Save to Cliptext** accepts a post link from an app's Share menu.
- **Sync Cliptext** retries links already saved by the Shortcut.

Choose the same local parent folder under **On My iPhone** for both. The Shortcuts create a `Cliptext` folder inside it and share that folder's outbox. Avoid an iCloud Drive folder if links must stay local. Create a Shortcut connection on the Mac and paste its JSON settings on the first run. The submit-only credential is stored in the local `Cliptext` folder, rather than embedded in the Shortcut definition. Do not share the connection file or settings.

The Save Shortcut writes a unique link file before making a network request. It moves that exact queued file to the local `sent` folder only after the Mac returns a matching receipt. Repeating a request is safe. If the Mac is unreachable, iOS may show a network error; the saved file remains for **Sync Cliptext** or the next share. Opening the PWA cannot retry the Shortcut's files: iOS keeps the web app and Shortcuts in separate storage containers.

If the Shortcut connection is revoked or its settings change, use Files to move `cliptext-connection.json` out of the local `Cliptext` folder, then run the Shortcut again and paste new settings. Keep the `pending` folder in place so queued links can retry. The `sent` folder is a local delivery archive and can be cleared by the user when no longer needed.

This is why the Shortcut is used for sharing: iPhone PWAs do not support the web share-target manifest behavior. Saving a link does not open the full Cliptext library. The Share sheet can still show Shortcuts progress or first-use permission prompts.

## Developer verification

Use disposable libraries for pairing, receipt, tombstone, and revocation checks. Tests must preserve the existing Android protocol and applied migration checksums. Never embed a pairing code, device capability, actual hostname, or user transcript in committed sources or generic Shortcut downloads.

Browser tests and the iOS simulator provide useful coverage but do not establish real TikTok Share-sheet behavior, iPhone file-provider permissions, storage eviction, battery/background timing, or a physical device's offline acceptance. Complete those checks on an iPhone before a public release.
