# Agnostic Narrator V2 verification

The V2 checkout starts from audited commit `e6b77d9`. The local `0.3.0-rc.1` ZIP contains the extension, both companion presets, seven Quick Replies, the card as JSON and PNG, installation notes and the licence.

## Release candidate results

- Independent critique and core and browser testers cleared all five audit criteria for the local candidate.
- All 257 unit tests passed in both the LF worktree and a Windows CRLF checkout. The Windows build reproduced the four generated JSON assets byte for byte.
- All 40 end-to-end checks passed on the exact extracted ZIP in disposable SillyTavern 1.19.0. All 35 extracted files matched the archive entries and remained byte-identical through the run.
- ZIP SHA-256 `22904b0f33a59d4c68af5ec4c9a1a3fe8063bd693eef3e8a123e440a4439c63d`.

| Criterion | Audited baseline | V2 |
| --- | ---: | ---: |
| Core features | 8 | 8.5 |
| Robustness | 5 | 8 |
| UI and communication | 5 | 8 |
| Architecture and scale | 6.5 | 8 |
| Verification and release | 8 | 8.5 |

## Changes by audit stage

| Stage | Audit findings | Behavior checked |
| --- | --- | --- |
| Chat isolation | F01–F03 | An opening, World Info result or pending model call from the old chat cannot write into the new chat or block its Director pass. |
| Profiles and current story | F04–F05 | One unusable profile leaves others eligible. Transport and credential failures pause shared work. Returning to an older swipe reads it again. Editing or deleting evidence removes dependent records. Lasting criteria require a second supporting reply. |
| Commands and Inspector | F06–F09, F11, F14, F17, F21 | Explicit off reaches the Mature preset. A prose direction stays a direction. Status reflects what saved. Scene drafts survive close and reopen. The panel supports keyboard and 390 px touch. Group Off restores the original mode and mutes. Record search and Source work on the active chat. |
| Budgets and replay | F12–F13, F15–F16, F18–F19 | Story context fits its estimated cap. Registered providers can report coverage synchronously. Dotted tags are literal. The Chinese audit pair meets the retcon threshold. The narrator sees beat pressure and the observer judges the goal. |
| Release | F10, F20 | The harness copies host code and dependencies into a disposable fixture. Windows CRLF checkout and generated assets are checked against the staged package. |

## Current-state storage

SillyTavern retains the prose of its inactive swipes and other extensions’ metadata. Director removes inactive swipe records and rebuilds its own state from the active messages. Independent player corrections survive a revision of their carrier message, including retcons and scoped Scene and Cast changes. Deleting the carrier also deletes the operations it held. Plan edits based on discarded generated plans are invalidated.

## Replay measurements

The same Node 24.16 benchmark played a representative synthetic workload into the audited code and V2. At 1,000 turns it held 2,001 messages, 1,000 observations and 250 tracker batches. Each number is a median over nine paired runs. These are local processing times and exclude network, provider, browser rendering and disk writes.

| Operation | Audited baseline | V2 |
| --- | ---: | ---: |
| Cold reload and view | 267 ms | 182 ms |
| 20 cached internal reads | 337 ms | 29 ms |
| Append, reconcile and prepare the next work | 325 ms | 156 ms |

## Verification limits

The browser fixture uses Chromium and a local scripted model. Revision replay, actual prompt assembly, legacy saved records and browser reloading are covered. Physical devices, screen readers, live provider output and full install upgrade and rollback are outside these runs. With SillyTavern’s Current Connection, V2 releases the old chat and rejects stale results. The host may still finish the detached network request.
