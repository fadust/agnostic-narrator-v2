# Design review

This review describes the first implementation and its position against the original build plan. For current release, test and audit findings, see [V2 verification](v2-verification.md).

How the build departs from the original plan, and why. The plan is in [`design-and-build-plan.md`](design-and-build-plan.md); it was reviewed against SillyTavern 1.19.0 source (`release`, `06bde93`), then built and run against it. For how the system works now, read [How it works](how-it-works.md). The "Extension requirements" tab it refers to was not part of what I was given, so requirement IDs (MSG-01, DIR-08 and so on) are not traced here; I worked from the design text.

The nine principles held up and are all implemented. The changes below are in how they are met.

## Where the plan did not match the platform

| # | Plan | What the source does | What was built |
| --- | --- | --- | --- |
| 1 | The brief is skipped for impersonate and quiet generations by a prompt filter | In 1.19.0 the filter is ignored for in-chat injections: `getExtensionPrompt` passes an async predicate to `Array.filter`, which is always truthy (`script.js` 3301–3315). The notes went into impersonate prompts | The interceptor removes all three blocks for those generation types and puts them back afterwards. Covered by an end-to-end check |
| 2 | The narrator's group opening is posted by the Group Greetings extension | Core 1.19.0 never reads `group_only_greetings`; that needs a second extension | The director sets the group greeting itself through `CHARACTER_FIRST_MESSAGE_SELECTED`. One dependency fewer |
| 3 | Cast cards in a narrator group have empty greetings | Correct that a greeting cannot be suppressed, but emptying cast cards breaks principle 6 (authored material stays untouched) | Cast cards stay as written. Their greetings are hidden from the prompt after SillyTavern posts them, and the extractor never reads them |
| 4 | Genre craft lives in the card's bound lorebook | An embedded lorebook does nothing until the player imports it by hand. Skip that step and no genre entry ever fires, silently | If the book is not bound, the director adds the card's embedded entries at the World Info hook. Importing still works |
| 5 | Tavern Helper is required for variable macros and the card script | 1.19.0 has `{{if .var}}`, chat variables and a macro registry built in | Tavern Helper is not required, so the recorded exception to dependency criterion 5 is gone. The `nar` object is still mirrored for people who use it |
| 6 | `sillytavern-utils-lib` is bundled for `buildPrompt` | `ConnectionManagerRequestService.sendRequest` takes chat messages directly | Nothing is bundled and there is no build step for the extension |

## Where the plan disagreed with itself

1. **The extractor "never sees the plan", yet its delta carries `clues_found`.** Something has to judge whether a beat landed. The observer is shown exactly the intent and clue the narrator was shown that turn, and nothing else. The quote rule keeps that from contaminating canon, and a fixture tests it.
2. **Enumerated steps or scores.** The state model says relationships move by enumerated steps; Stats and social says scores fall into bands. Both are kept: the model proposes a step (axis, direction, minor or major, evidence category, quote); code holds a clamped score and derives the band. An axis moves at most two points per reply.
3. **Stored status.** `provisional | pending | committed` was a stored field. It is now derived from position: a reply is committed when a later story message exists. A stored flag can disagree with the chat; a derived one cannot. Deleting your reply makes the narration before it provisional again, which is what you would expect.
4. **Edits on a provisional reply.** "The record is cleared when a swipe starts" would also discard an inspector edit or retcon made while that reply was the latest. Every logged operation now names its author. Director operations that rest on the reply die with it; player and setup operations survive.

## Simplifications

| Plan | Built | Why |
| --- | --- | --- |
| Three model calls after every reply (extractor, continuity checker, brief writer) | One. The observer extracts and checks continuity in a single call; the brief is composed in code | A third of the cost and wait, so the director is rarely slower than the player. The brief became deterministic and testable |
| A chat-bound lorebook file, cleaned by provenance and forked on branch | The dynamic lorebook is derived from committed lore drafts on every World Info load. One mirror file is kept so other extensions can look entries up | Deletes and branches need no cleanup or fork code. The cost: it is edited through the inspector, not the World Info editor |
| Integrity ID check to detect branches; state cache in metadata | Neither. State is replayed from the open chat's messages | A branch carries its own records, so it rebuilds correctly with no detection |
| Per-event handlers for swipe, swipe-back, continue, stop, edit, regenerate | One rule: a record is valid only while its hash matches the reply's visible text | Every one of those events is "the text changed". Swiping back to a reply that was already read reuses its record instead of paying for another call |
| The preset places the brief, with a variant for Claude and Gemini | The director places it by backend: depth 1 system by default, system prompt for Claude and Gemini. `{{director_notes}}` still works for manual placement | One preset serves every backend; any preset works |
| The director runs wherever it is enabled | It is active only in chats with the Narrator card (since 18 Nov 2026 `/director on` no longer adopts another card) | It must not touch ordinary chats |

## Changes made after play began

The first real sessions and an audit found faults the plan could not have predicted. Each is listed in the [changelog](../CHANGELOG.md); the ones that changed the design are:

- **Presence is additive.** The plan let the extractor's list of who is present replace the old one. A model that listed only the speakers made silent characters vanish.
- **Ids and player operations live on the message, not in `extra`.** SillyTavern swaps `extra` on every swipe, so an edit made on one swipe was lost on another.
- **A late director sends older notes, marked.** The plan's fixed fallback note threw away the cast lines and the scene whenever the player typed quickly.
- **Every note line is explained in the card, and precedence is stated.** The narrator was guessing at lines such as `spotlight`, and "the chat wins" conflicted with "apply corrections".
- **A content rating.** Mature by default, PG by command, with the preset switching on the same flag.

Smaller additions: genre labels are normalised ("sci-fi" and "science fiction" set the same flag); an edited committed reply is re-read however old it is; a failed read is retried twice and then left alone until `/director retry`; retcon matching prefers exact containment and reports what it removed.

## Status against the build plan

| Phase | Status |
| --- | --- |
| 0b · Prove the Tavern Helper parts and the interceptor | Interceptor, `{{director_notes}}`, scan-only prompt and variable gating are proven end to end. The Tavern Helper items no longer apply |
| 1 · Narrator card and preset | Done. The preset is the author's own, adapted to a narrator card |
| 2 · State plumbing | Done |
| 3 · Director core | Done, with the fixture suite. **Not yet run against a real model** |
| 4 · Genre and framing | Done: profiler, opening drafter, eleven genre craft entries plus tempo, lethality and tension entries |
| 5 · Planner and player controls | Done. Arc setup is two calls plus code validation rather than four. Suggest mode is a command (`/director suggest`) |
| 6 · Dynamic lorebook | Done, as a derived book |
| 7 · Harden and release | Partly: documentation and tests exist. Not published; the test suites have not been run against real backends |

## Status against the test plan

Verified automatically (35 unit tests on the core, 29 end-to-end checks in a real SillyTavern with a scripted mock LLM):

- Swipe three times; swipe then send at once; edit while the director is reading; send before it finishes (pending, then commit)
- Delete the latest reply; delete three back (state, summaries, lore); branch; retcon then edit an old message
- A change whose quote is not in the reply is rejected; rejections are counted and shown
- Impersonate carries no notes; dry runs change no state, variable or director call
- `/listvar`-visible variables hold no beat, clue or belief
- A forced leak is absent from the saved reply and the next prompt
- A pre-empted beat triggers a re-plan; the brief never shows the queue; no number reaches the narrator
- A contradiction is flagged and corrected once in the next brief
- Extension disabled: card narrates, no genre entry fires, group back in join mode
- Fresh group chat: narrator's group greeting only, cast greetings unread
- Cast-size rule in both directions; only the narrator generates; a muted member's lorebook fires
- Director calls through a Connection Manager profile

Not verified, because they need real models or real play:

- Same card, three stories, 13 of 15 identified
- Fixture suite at 90% on the chosen director model
- Quote rejection rate under 1 in 10 over 20 turns
- Claude and Gemini over ten turns; text-completion backends
- Ten turns with no beat named in prose; 20 turns of stats and relationships; lorebook quality after 30 turns
- World Info sticky and cooldown timers under dry runs (the director no longer runs World Info scans of its own, so the risk is gone rather than tested)

## Open decisions, with a recommendation each

| Decision | Recommendation |
| --- | --- |
| Genre craft: StoryMode's 43 types or our own | Our own, as shipped. Add an entry when a story needs one; the gate is one flag |
| Planner cadence | Keep 6 turns plus events. It is a setting; 0 means events only |
| Override method for changed authored facts | Superseding entry only, as built. It never touches an authored entry |
| Memory | Director summariser only. It already rolls back by message |
| Which preset to adapt | Decided: the author's own preset, shipped as the companion preset |
| Director and narrator models | Decide with the fixture suite. Nothing here has met a real model yet |
| Name and publication | Named "Narrator Director" in code. Publication and licence are yours to decide; nothing has been pushed anywhere |

## Risks that remain

- **Prompt quality is unproven.** The observer prompt is the piece everything rests on. Expect to iterate on it with the fixture suite.
- **Over-direction** is limited by construction (one intent, a precondition, the player wins) but only real play shows whether a given narrator model leans on the notes too hard.
- **The retcon matcher** is textual. It reports what it removed; check the toast.
- **Status progression** (a serious untreated injury worsens once, after ten turns) is code asserting something the narration did not say. It reaches the narrator as a cast line, but watch for it feeling arbitrary.
- **High lethality as the mature default** applies to every story, gentle ones included, unless the story is rated PG or its profile is edited.
