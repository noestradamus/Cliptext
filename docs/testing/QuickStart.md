# Cliptext — private tester setup

For an Apple Silicon Mac running macOS Sequoia 15.6 or later, plus an iPhone. This build targets Sequoia; the test on your Mac and iPhone is still needed to confirm it works there.

## 1. Install on the Mac

1. Open the Cliptext disk image and drag **Cliptext** to **Applications**.
2. Eject the disk image, then open Cliptext from Applications.
3. If macOS blocks the first launch, use **System Settings → Privacy & Security → Open Anyway** for this app, then confirm the macOS prompt yourself. If the app is reported as damaged, stop and send the exact message. Do not run Terminal security-bypass commands.
4. Wait for **Running**, then paste a new public TikTok link. Check the transcript when processing finishes.

The models and runtimes are included. Your first launch creates an empty library on your Mac; it does not contain another user's items or connections. Keep Cliptext running while it processes links. **Quit Cliptext** stops processing.

## 2. Connect the iPhone

1. Install Tailscale on your Mac and iPhone. Sign in with your own account on both and connect them to the same private network.
2. Complete the one-time private HTTPS setup described in the accompanying **Tester guide**. It forwards only the iPhone listener at `127.0.0.1:47323`.
3. On iPhone Safari, open your Mac's private HTTPS address. Choose **Share → Add to Home Screen**, then open Cliptext from its Home Screen icon.
4. On the Mac, open **Sharing setup → iPhone → Pair iPhone**. Paste the fresh pairing code into the installed iPhone app and tap **Connect**, then **Sync**. Wait for **Offline reading is ready**.

## 3. Add Save to Cliptext

1. Install **Save to Cliptext** and **Sync Cliptext** from the iPhone app's Connection panel.
2. For both, choose **On My iPhone → Downloads** as the folder. They create their own `Cliptext` folder there.
3. On the Mac, open **Sharing setup → iPhone → Save to Cliptext Shortcut → Create Shortcut connection**. Paste the settings into the Shortcut when asked on its first run. Keep these settings private.
4. Share a public TikTok link to **Save to Cliptext**. The Shortcut saves the link before sending it and should leave the Cliptext library closed. First-use iOS permission prompts or Shortcuts progress can appear.

## 4. Try the offline flow

- Put the Mac to sleep and share another new link using **Save to Cliptext**. An iOS network error is possible; the link should remain saved locally.
- Wake the Mac, leave Cliptext and Tailscale running, then run **Sync Cliptext** on the iPhone. Open the iPhone app and tap **Sync** to fetch the completed transcript.
- Turn on airplane mode, close Cliptext from the iPhone app switcher, reopen its Home Screen icon, and check that a synced transcript remains readable.

The web app and Shortcuts have separate queues. Opening the web app does not send the Shortcut's pending files. Neither Tailscale nor Cliptext wakes a sleeping Mac.

For a problem report, send the step, exact visible error, and Mac/iOS/app versions. Keep pairing codes, connection settings, passwords, and private transcripts out of screenshots and messages.
