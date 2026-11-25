# Agnostic Narrator V2 verification

## Current release candidate

`v0.3.0-rc.6` points to `96c414d`. The build, 279 unit tests, and 41 end-to-end checks against a disposable SillyTavern 1.19.0 profile passed. The browser suite used a scripted model. [GitHub prerelease](https://github.com/fadust/agnostic-narrator-v2/releases/tag/v0.3.0-rc.6)

The dedicated installer has 35 allowlisted files. Its runtime files and JSON assets match the tag, and its PNG uses the earlier installer’s artwork with the rc.6 card data. Building the archive twice produced the same SHA-256, `668388d2d356148cb816796975d92ed23b86e29d28a73afce07709ee6f9c6ece`. A disposable SillyTavern profile loaded the extracted extension, listed `/director checkplan` in command help, and imported both card formats, both presets and all five Quick Replies. The installation check made zero model calls. [Installer ZIP](https://github.com/fadust/agnostic-narrator-v2/releases/download/v0.3.0-rc.6/agnostic-narrator-v2-0.3.0-rc.6.zip)

In an isolated provider test, BaiBai Book 1.3.5 supplied bounded earlier history. NanoGPT’s `deepseek/deepseek-v4.1-flash` confirmed a memory-only fact and milestone criterion from a synthetic story and rejected an unrelated quote for both claim types. The cutoff excluded a later quote. B served the same commit, and the reloaded browser listed `/director checkplan` in autocomplete without executing it. The saved chat and group hashes matched across the reload.

### 22 November package audit against rc.6

| Findings | Status in rc.6 |
| --- | --- |
| P1, P2, P6, P8, P9, P11, P12, P20–P22, P28 | The streaming guard, protected retcon, surfaced failures, per-request deadline, explicit command syntax, stable plan IDs, isolated profile failures, batched saves, touch layout, accurate command results and on-demand full state are in the build. [Package tests](../tests/unit/round13-package.test.mjs) · [Call and chat isolation](../tests/unit/v2-chat-isolation.test.mjs) · [Browser suite](../tests/e2e/run.mjs) |
| P3, P4, P5, P13, P14 | Content and writing rules come from the selected PG or Mature preset. The old rating commands point to the preset and leave story stakes alone. Both presets have a 1,500-token cap and own the reply length guidance. Delivery and length still depend on the narrator model and active preset. [Preset checks](../tests/unit/round13-package.test.mjs) · [Preset source](../card/src/preset.md) |
| P7 | The GitHub prerelease, checked-out manifest and tagged package version agree at rc.6. [Manifest](../manifest.json) |
| P10, P17 | The CJK matching path and literal tag handling are in the build. The focused checks cover the reported Chinese match and a configured dotted tag. Story-sourced profile extraction still splits on Western sentence endings followed by whitespace. [Prompt and text checks](../tests/unit/v2-prompt-scale.test.mjs) · [Profile extraction](../core/director.js) |
| P15, P16 | Both presets still ship an unlocked 200,000-token context. Minimum SillyTavern 1.19.0 is documented and enforced by the extension manifest. The card’s import notes omit the requirement. [Preset defaults](../card/src/preset.base.json) · [Card build](../card/build.mjs) |
| P18, P19, P27 | Evidence checks limit unsupported claims and prompts label memory as data. Story-derived text still flows into prompts. Replay and scan caches reduce repeated work, while fingerprints still check revisions. Commands have a grammar module and calls have a transport module. Most dispatch and setup still live in the host and Director. [Memory rules](reference.md#memory-providers) · [Host](../index.js) · [Director](../core/director.js) |
| P23, P24 | The unclosed-tag cleanup still drops the tail of the reply. Quick Reply IDs are in order. The beat picker still interpolates the beat type, and Dump state sends the JSON through the host’s sanitized HTML popup. Literal-text rendering remains open. [Cleanup](../core/text.js) · [Quick Replies](../card/build.mjs) |
| P25, P26 | The rc.6 installer excludes audit and handover documents, tests and fixtures. Current public audit docs anonymize local paths, chat references and profile identifiers. GitHub’s automatic source archives reflect the original tagged commit and retain its historical files. [Package audit](package-audit-2026-11-22.md) |

### 21–22 November runtime audits against rc.6

| Findings | Status in rc.6 |
| --- | --- |
| I1–I6, A2–A4 | Player lore contributes to profiling. Story and lore profiles are tied to their source history. Role characters, aliases, similar treatment names, scene cuts and established deaths are handled in code. The basis check covers stale profiles, and replay is tested after a swipe. There is no dedicated browser test for a swipe during the profile request. [Identity checks](../tests/unit/round10-identity-settled.test.mjs) · [Replay checks](../tests/unit/v2-current-story-state.test.mjs) |
| I7, A5, B3 | The validator limits the player interpretation of “you” to second person or an unset viewpoint. V2 moved writing guidance to the preset and removed the old reader-address example from the card. Conflicting authored sources still need correction at their source. Prose repetition remains model-dependent. [Card source](../card/src/description.md) |
| L1–L6, L8–L13, R1–R3, A1, A6–A7, A9–A10 | The current code has settled IDs and player-source gates, hidden-reply replay, timed retries, bounded tracker batches that recover after success, shorter evidence handling, fact priority and milestone reopening. Manual checks share the Director’s queue. Unit and browser checks cover the primary paths. [Reliability tests](../tests/unit/round10-reliability.test.mjs) · [Batch and transport tests](../tests/unit/round12-call-batch.test.mjs) · [Single-flight tests](../tests/unit/round12-open-findings.test.mjs) |
| L7 | Saved legacy advances still replay their hooks. Current beats require confirmed completion evidence. Multiple partial advances leave the goal open. [Legacy replay test](../tests/unit/round10-identity-settled.test.mjs) · [Planning behavior](how-it-works.md#planning) |
| B1, B2, B4, R4, A8 | The shipped presets cap output. The Director clips long player input, bounds tracker batches and historical evidence excerpts, keeps short rejection records and caches replay work. Initial and automatic planning still read the selected provider’s full story record up to the general text limit. Long-history costs and prose quality depend on model and settings. The old benchmark below is historical. The transport and command grammar are separate modules. Further decomposition needs a concrete maintenance reason. |

Sources for the finding IDs are the [identity and reliability audit](audit-2026-11-21.md), [Director map audit](director-map.md) and [whole-package audit](package-audit-2026-11-22.md).

## Historical rc.1 verification

The V2 checkout starts from audited commit `e6b77d9`. The local `0.3.0-rc.1` ZIP contains the extension, both companion presets, seven Quick Replies, the card as JSON and PNG, installation notes and the licence.

### Release candidate results

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

### Changes by audit stage

| Stage | Audit findings | Behavior checked |
| --- | --- | --- |
| Chat isolation | F01–F03 | An opening, World Info result or pending model call from the old chat cannot write into the new chat or block its Director pass. |
| Profiles and current story | F04–F05 | One unusable profile leaves others eligible. Transport and credential failures pause shared work. Returning to an older swipe reads it again. Editing or deleting evidence removes dependent records. Lasting criteria require a second supporting reply. |
| Commands and Inspector | F06–F09, F11, F14, F17, F21 | Explicit off reaches the Mature preset. A prose direction stays a direction. Status reflects what saved. Scene drafts survive close and reopen. The panel supports keyboard and 390 px touch. Group Off restores the original mode and mutes. Record search and Source work on the active chat. |
| Budgets and replay | F12–F13, F15–F16, F18–F19 | Story context fits its estimated cap. Registered providers can report coverage synchronously. Dotted tags are literal. The Chinese audit pair meets the retcon threshold. The narrator sees beat pressure and the observer judges the goal. |
| Release | F10, F20 | The harness copies host code and dependencies into a disposable fixture. Windows CRLF checkout and generated assets are checked against the staged package. |

## Current-state storage

SillyTavern retains the prose of its inactive swipes and other extensions’ metadata. Director removes inactive swipe records and rebuilds its own state from the active messages. Independent player corrections survive a revision of their carrier message, including retcons and scoped Scene and Cast changes. Deleting the carrier also deletes the operations it held. Plan edits based on discarded generated plans are invalidated.

## Historical replay measurements

The same Node 24.16 benchmark played a representative synthetic workload into the audited code and V2. At 1,000 turns it held 2,001 messages, 1,000 observations and 250 tracker batches. Each number is a median over nine paired runs. These are local processing times and exclude network, provider, browser rendering and disk writes.

| Operation | Audited baseline | V2 |
| --- | ---: | ---: |
| Cold reload and view | 267 ms | 182 ms |
| 20 cached internal reads | 337 ms | 29 ms |
| Append, reconcile and prepare the next work | 325 ms | 156 ms |

## Verification limits

The browser fixture uses Chromium and a local scripted model. It covers revision replay, prompt assembly, legacy saved records and browser reloading. The rc.6 provider test covers memory evidence with one model and synthetic text. Physical devices, screen readers, general narrator quality and installer upgrade or rollback were outside that test. With SillyTavern’s Current Connection, V2 releases the old chat and rejects stale results. The host may still finish the detached network request.
