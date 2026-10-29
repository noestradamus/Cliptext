# iPhone simulator verification

Recorded on 2026-10-29 using an iPhone 17e simulator running iOS 27. Native Safari, the installed Home Screen web app, Files, and Apple Shortcuts were exercised through Xcode XCTest UI tests. The Mac companion supplied the library and processing; Sites was not involved.

This records simulator acceptance. No physical iPhone was available. Private connection settings, hostnames, device identifiers, source links, screenshots, and transcript text are excluded from this report.

## Verified results

| Flow | Observed result |
| --- | --- |
| Home Screen installation | Installed Cliptext from Safari and opened its standalone web app. |
| Pairing and library sync | Paired the installed app and synced six existing library items. |
| Cold reopen with the Mac endpoint unavailable | Terminated and reopened the web app while the companion endpoint returned HTTP 502. A previously synced transcript remained readable and matched its source text in the Mac SQLite library. |
| Durable web-app queue | A queued link survived termination and reopening with queue count 1. Restoring the endpoint and syncing reduced the count to 0. |
| Shortcut import | Imported the generic signed Save and Sync templates, using a local Downloads parent. When Add Shortcut was inert after folder selection, Skip Setup retained the selection; the first Create Folder action was checked in the editor. |
| Native Sync delivery | Sync read the saved connection without another prompt, submitted a pending request, received its Mac receipt, and moved the acknowledged JSON file into `sent`: pending 0, sent 1. |
| Empty Sync replay | A subsequent empty Sync left the receipt count at 1 and the library count at 6. |
| Native Safari Share menu | Shared an Instagram post through Save to Cliptext while the companion endpoint was paused and the Cliptext web app was terminated. A valid UUID-named `.json` request was persisted in `pending`; the web app stayed closed. |
| Save retry and receipt archival | After restoring the endpoint, Save delivered the earlier queued share and a supplied existing TikTok link. Final state: pending 0, sent 3, three Mac request receipts, and six library items. |

Existing links were used for delivery checks. The stable library count demonstrates that these submissions reused existing items while preserving request receipts.

## Native Shortcut corrections verified

- Get URLs receives Shortcut input through its native string parameter serialization.
- Set Name gives request and connection content explicit `.json` filenames before Save File converts it to a file. The saved connection is found on later runs.
- Exact library-ID and request-ID comparisons use scalar Text subjects. Receipt archival also requires a job ID.
- Iterator captures use the active repeat depth, so the nested receipt loop reads its receipt instead of the outer pending file. Both Save's sequential loops and Sync's nested loop completed.

The tested generic templates contain 86 actions for Save to Cliptext and 68 for Sync Cliptext. The source regression suite passes 18 tests. Those graph checks supplement the native runs; they do not establish physical-device behavior.

## Limits

- Safari's native Share menu was tested. Sharing directly from the TikTok iPhone app was not tested; URL-scheme input was tested separately.
- The endpoint was deliberately made unavailable. This was not an actual sleeping Mac, airplane-mode test, or physical network-loss test.
- Physical file-provider permissions, storage eviction, battery behavior, and long-duration use remain unverified. The web app does not promise reliable closed-app background sync.
- First-use Shortcuts permission prompts can appear. Share-menu saving did not open the Cliptext library.
- The generic manifest retains `nativeRuntimeVerified:false` pending physical iPhone acceptance.

For installation and local-storage behavior, see [iPhone setup](../iphone.md).
