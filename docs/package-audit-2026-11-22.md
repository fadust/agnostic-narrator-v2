# Package audit, 22 Nov 2026 (whole package at HEAD, after 0.2.0)

This is the original 0.2.0-era audit. Its version, baseline counts, proposed changes and severity reflect that snapshot. See [current rc.6 package findings](v2-verification.md#22-november-package-audit-against-rc6).

Four read-only audits of the whole package, not only recent changes:
1. extension code;
2. card, preset, quick replies, regex and lorebook;
3. packaging, docs and release;
4. security, UX and performance.

The top claims were re-checked against the code. Baseline: 221 unit tests and 29/29 end-to-end checks pass.

Verdicts:
- **V**: verified in the code by a second read.
- **L**: likely, but needs a live check.
- Unmarked: one audit's finding.

## Critical and high

| # | Area | Finding | Where | Fix |
|---|---|---|---|---|
| P1 | Code (V, L) | **The observer can pay repeatedly for a reply that is still streaming.** `nextUnread` reads narration that has text and no record, but never checks that generation has finished. `stillCurrent()` then fails, `again` re-runs the pass, and the same partial reply is read again (up to 50 per pass). `retrySoon`, `trackNow`, `retry` and `exclusive` skip the host's `generating` guard. | core/director.js:435-441, 394-397; index.js:317 | Add `host.generating()`. While it is true, skip the last message and stop after one failure of `stillCurrent`. Route `retrySoon` through `scheduleKick`. |
| P2 | Code (V) | **`/director retcon` with no text, or one letter, retcons every fact.** `''` is contained in every fact. | index.js:581-586, 744 | Refuse a needle under 3 characters; when more than 3 facts match, list them and ask for confirmation. |
| P3 | Card (V) | **Turning explicit off leaves the preset's adult sections on.** Preset §7 and the adult lines in §1 and §5 check only `nar_pg`. `/director explicit off` clears `nar_explicit` but leaves the preset ordering graphic sex with no fade. | card/src/preset.md:5, 75; index.js:736 | Gate §7 and the explicit lines on `nar_explicit`; with explicit off, use the stance's closed-door line. |
| P4 | Card | **The preset's `openai_max_tokens` is 10000** against a written target of about 500 (at most 1,000), so nothing hard stops a runaway reply. This matches the live growth from 3k to 15k characters. | card/src/preset.base.json:6 | Set it to about 1,500. |
| P5 | Card | **Several rules ask for more, none for less:** "seed, not a script… grow beats… richly" (preset.md:73), "enhance, enrich and embellish" (description.md:11), "take beats of your own" (:121). | card/src | "Grow one or two beats"; "embellishing never lengthens: a short message gets a short rendering"; "one beat per reply, then stop at the player's move". |
| P6 | UX | **Background failures are silent.** `fail()` only warns in the console and fills the inspector's Log tab, so a broken profile or model quietly stops the director. | core/director.js:338-343 | One toast per module per session; an error dot on the panel and its menu entry. |
| P7 | Release | **The v0.2.0 release is 8 commits behind HEAD** (A1-A10, replay cache, refactor), yet both say 0.2.0. Git-URL installs get HEAD under the same version. | manifest.json:9, package.json:3, card character_version, INSTALL.txt | Release 0.2.1 and put the CHANGELOG entries since 0.2.0 under it. |

## Medium

| # | Area | Finding | Fix |
|---|---|---|---|
| P8 | Code | No time limit on model calls: a hung stream holds the queue and `running`, so every later pass and command waits until the chat changes. `generateRaw` (no profile) cannot be cancelled. | Race each call against about 3 minutes, using a per-call AbortController linked to `this.abort`. |
| P9 | Code | Free text that starts with a keyword runs that command ("/director rewrite the ending darker" swipes the reply). | Treat a keyword as a command only with a colon or as the whole input. |
| P10 | Code | Chinese, Japanese and Korean facts never dedupe or match retcons: similarity splits on spaces (`similarity('李明烧掉了那封信','那封信被李明烧掉了') = 0`). The story-profile sentence split also misses 。！？. | Character bigrams for CJK; split on 。！？ too. |
| P11 | Code | Plan beat ids can collide after a reload: `planSeq` restarts at 0, so a second plan on the same message reuses `b-<tag>-0-n`. | Derive the number from the count of plan ops on the message, or from `op.at`. |
| P12 | Code | A card that always fails profiling blocks the lorebook and story profiles after it, and is retried every 90 s. | Count failures per card hash and skip a card past the limit. |
| P13 | Card | The two length rules disagree: post-history allows 1,000 tokens only for action, while preset §8 also allows it for body movement and fights. Length is also restated in §6 and §9. | Point the post-history line at "the section 8 exceptions"; delete the restatements. |
| P14 | Card | `/director pg off` and the Mature quick reply force lethality high, wiping the user's choice. | Keep the existing lethality. |
| P15 | Card | The preset context is 200k, unlocked: costly, and it feeds style-copying from long histories. | Default to 32k-64k. |
| P16 | Card | Everything depends on the newer `{{if}}` macro engine; on older SillyTavern the raw syntax reaches the model. | State the minimum SillyTavern version and the setting in creator_notes and the README. |
| P17 | Security | User tags in "Tags to remove" and plan-check subjects are built into regexes unescaped: a stray `(` throws on every reply. | Escape them; refuse tags outside `[\w:-]`. |
| P18 | Security | Prompt injection is inherent: model-written facts and summaries flow into later prompts and the brief. | Present canon and summaries in prompts as quoted data; refuse facts written as orders. |
| P19 | Performance | Every `view()` builds the cache key over the whole chat; `sync()` on each edit or swipe reconciles the whole chat and empties the caches; `observe` replays up to each reply; `storyCards` scans cast × replies × sentences on each pass. | A revision counter bumped by SillyTavern events instead of a print; cache `storyCards` by revision. |
| P20 | Performance | Up to about 7 full `saveChat` writes per background pass. | One save at the end of `kick()`, or a debounced save. |
| P21 | UX | No mobile layout rules: the panel fits, but field rows and tabs cramp under 400 px. | One `@media (max-width:600px)` rule. |

## Low

- **P22.** The commands `/director confirm` (with no genre yet) and `revise genre` report success when they did nothing.
- **P23.** The unclosed-block leak regex deletes everything after a stray `<director_notes>` from the saved reply. It is acceptable as leak protection, but it could cut only to the next blank line.
- **P24.** `b.type` is not escaped in the opening picker (index.js:804). The Dump quick reply puts raw JSON into `<pre>`. Quick-reply ids are out of order.
- **P25.** The git-URL install ships tests, docs and tools (node_modules is correctly ignored). Point users to the release zip as the lean option.
- **P26.** docs/audit-2026-11-21.md names internal profile ids, and docs/ideas-from-other-extensions.md links to the private handover. docs/handover.md (local) is stale, from 18 Nov.
- **P27.** Dead code: a stray block in `runCall`, a separate import line for `planCheckPrompt`, and a leftover `delete m.narrator`. `index.js` still handles every command: move them to `st/commands.js` so they can be tested.
- **P28.** The Log tab rebuilds a full state dump on every update while the panel is open.

## Checked and fine

- **Security:** model text is escaped in every panel builder; there are no network calls besides SillyTavern's connection calls; git authorship is the single noreply identity.
- **Card and lorebook:** the card conforms to CCv3; lorebook gating and budget are fine; genre craft entries are good; all quick-reply subcommands exist; the boundary wording is consistent.
- **Packaging:** the manifest and package.json are sound; a LICENSE is present; the version is consistent at 0.2.0.
- **Code:** switching chats mid-call is safe through the epoch, the abort and the anchor checks; `exclusive` serialises correctly; the settings migrations are right.

## Plan

1. **Safety and cost:** P1, P2, P3, P4, P8, P9 and P17. These are small, high-value code and preset fixes.
2. **Length and voice (card and preset):** P5, P13, P14, P15, P16, P23 and P24. This touches the "enrich" rule, so owner input is needed on P5.
3. **Robustness:** P6, P10, P11, P12, P20, P21 and P22.
4. **Scale and structure:** P19 (revision counter), P27 (`st/commands.js`) and P28.
5. **Release 0.2.1:** P7, P25 and P26; refresh the handover.
