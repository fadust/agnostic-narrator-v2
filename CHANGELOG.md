# Changelog

Newest first. Each entry says which parts changed, so you know what to re-import.

# 0.3.0-rc.3 (Agnostic Narrator V2)

- The Director and card remove the enclosing quotes and backticks when stripping an echoed Director block that occupies quoted inline code. The reply cleanup also clears blank quote artifacts already present in the output.
- Cast introductions can use quoted relationship history from cards, lore or the story to set familiarity and supported feelings toward the player. Later changes and player edits keep their values.
- The Narrator card and both companion presets ask the Narrator to weave the player's supplied dialogue and actions into the scene. Update the extension, card and both presets together.

# 0.3.0-rc.2 (Agnostic Narrator V2)

- Content guidance lives in two separate presets. PG is for general audiences. Mature allows NSFW and NSFL material where it fits the story.
- The Director and the Narrator card supply story context. A profile can combine up to four genres, including `smut` or `erotica`, with either preset. Re-import the updated card and companion presets to use the split.

# 0.3.0-rc.1 (Agnostic Narrator V2)

- Chat switches release pending Director work and isolate World Info, generated openings and Inspector drafts.
- Swiping, editing and deleting remove superseded Director records. A swipe back is read fresh.
- Individual profile failures leave other characters eligible, and lasting milestones wait for both supporting replies.
- Explicit commands, faithful group restoration, keyboard and touch controls, retained drafts, and searchable facts with source links.
- Estimated story-context budget, shared memory-provider coverage, and faster replay in long chats.
- Re-import the Mature companion preset to use the updated Explicit setting in generated prompts.

# 0.2.2 (22 Nov 2026)

## Two companion presets, Mature and PG (22 Nov 2026)

*Preset and extension: import both presets.*

- The companion preset now comes as two files built from one source: **Narrator Companion (Mature)** and **Narrator Companion (PG)**. Each says plainly which rating it is. The single preset that switched itself on the story's rating is gone, and the PG one is numbered 1 to 8 (it has no Adult Content section).
- The director warns once per chat when the selected companion preset does not match the story's rating, and names the one to select. `/director pg` and `/director pg off` say which preset goes with the new rating.
- The card's lorebook still follows the rating by itself, so only the preset needs choosing.

# 0.2.1 (22 Nov 2026)

*Extension, card and preset: re-import the card and the preset.* Everything below down to "0.2.0" is in this release.

## Failures you can see, and the package audit fixes (22 Nov 2026)

From docs/package-audit-2026-11-22.md.

- **A failing part of the director is shown** (P6):
  - a toast the first time it fails, saying what failed, the error and what to do (raise a limit, check the key, try another model);
  - a count in the panel header and a dot on the Director menu entry while it fails;
  - a banner at the top of every inspector tab with a Retry button;
  - a toast when it works again. It counts as working again only when its answer is usable, not merely received.
- **No paid re-reads of a reply that is still being written** (P1). The newest reply waits until the narrator finishes, and a reply that changed while it was read waits for the next pass.
- **`/director retcon` is guarded** (P2). Text under 3 letters is refused. More than 3 matching facts are listed first; add `!` at the end to retcon them all.
- **The preset caps replies at 1,500 tokens** (P4). It was 10,000, against a target of about 500 (up to 1,000 for action).
- **Embellishing no longer means longer** (P5): "grow one or two beats", "richly but briefly (a short message gets a short rendering)", and in sex scenes "one or two beats of your own per reply".
- **Plan ids** never repeat after a page reload. The plan number comes from the plans already on the message, and an id already on record is never reused.
- **Profiling:** a card the model keeps failing on is set aside after its tries, so the lorebook and story profiles after it still run. "Retry failed calls" gives it another go.
- **Speed and saving:**
  - a background pass saves the chat once at its end (it was up to 7 full writes);
  - the scan for story-introduced people is cached per chat revision;
  - measured: the replay-cache key costs 0.6 ms at about 1,000 messages, against a 150 ms replay, so it stays.

## End-to-end checks back to green (22 Nov 2026)

*Tests only.* All 29 checks pass against a real SillyTavern (B's checkout, throwaway data root).

- The stand-in model answers every module added since 0.1.0 (spine and its check, tracker and its check, plan check, fact clean-up, conclusions), and streams when asked: director calls through a connection profile are streamed. Unanswered, the spine call had been taken for the narrator's prompt.
- The test chat gets a scenario: a solo chat with no premise waits for the player's first message before drafting the story profile (by design since 19 Nov).
- The test context is 32k: the default 4k no longer fits the preset, card and notes, and SillyTavern dropped the chat history, notes included.
- Other third-party extensions are switched off for the run; the one-time `cadenceEvents` migration marker is not counted as a setting without a control.
- Seen, not changed: the card's `{{original}}` logs a console error when the preset has no post-history prompt at all; the companion preset has an empty one, so it does not happen with it.

## The rest of the map audit (22 Nov 2026)

*Extension only.* Findings A4-A10 of docs/director-map.md.

- A4: a stated fact that someone died ("Rulf dies of his wounds", "is dead", "was killed") marks them dead and out of the scene. The name must open the fact, so "Brenn killed a collector" is not Brenn's death.
- A5: "you" resolves to the player character only when the story profile's point of view is second person (or unset).
- A6: after a tracker batch fits, a halved batch size grows back by one reply up to the usual size.
- A7: only what the player settled (by command, or quoted from their own message) reaches the planner, the tracker, the spine drafter and the notes. Settled read from the story alone stays in the record.
- A8: the model call moved from index.js to `st/call.js` (`makeCall`), with no change in behaviour.
- A9: the tracker's batching scans the chat once per revision, not on every loop turn.
- A10: tests for the model call (streaming, the no-streaming and temperature fallbacks, thinking out), tracker batch sizing, deaths, "you" and player-only settled. The end-to-end checks need Playwright, which is not installed here, so they were not run.

## Commands in line, profiles after swipes, scene cuts (22 Nov 2026)

*Extension only.* Findings A1-A3 of docs/director-map.md.

- `/director spine`, `redraft`, `rollup` and the genre re-run wait their turn: they run in the same one-at-a-time slot as a background pass, so they never overlap a call doing the same job. A pass asked for meanwhile runs after.
- A profile drawn from the story or a lorebook entry is not written when the person left the cast while the call ran (the reply that introduced them was swiped).
- The observer can mark a scene cut (`"cut": true`): the REPLY ends in another place or with other people. The present list is then replaced, not added to, so people from the earlier scene stop being witnesses there.

## Replay cache (22 Nov 2026)

*Extension only.*

- The director's state is cached per chat revision: repeated reads in one pass (4-6 per setup pass) cost a 0.4 ms copy instead of a full replay (13 ms on a 97-message chat, growing with length). Any change to the messages or their records changes the key, and each pass starts with a fresh cache.

## Refactor after 0.2.0 (22 Nov 2026)

*Extension only. No behaviour change, except the one noted.*

- One helper for the queued openings' text (planner and observer used two copies); one admission path for role characters in the validator; one call for hidden and visible replies' spine findings.
- Removed the unread `meta.settledTurn`, and the tracker prompt's old single-reply parameters (it takes exchanges only).
- Doc comments back above their functions; observer rules numbered in order.
- Noted change: hand-editing a single stat (`cast.X.stats.<stat>`) now also keeps a re-profile from overwriting the sheet, as editing the whole sheet already did.

# 0.2.0 (22 Nov 2026)

## Role characters, skipped milestones (22 Nov 2026)

*Extension and card (version bump): re-import the card.*

- Someone known only by a role is a character once they speak under it ("The hall master: ...") or a queued plan centres on them. They are recorded by the role without the article ("Hall master"), and "the hall master" resolves to them. A silent role is still a passer-by.
- When a role character's name is revealed, the observer reports it as "named": the entry moves to the name everywhere (presence, feelings, witnesses, wants) and the role stays as another name.
- A skipped milestone stays on the tracker's list. If it happens after all, it is reopened and concludes like any other.
- Version 0.2.0 covers everything since 0.1.0 (21 Nov 2026), entries below up to and including "Deeds count".

## A length rule the model reads last (22 Nov 2026)

*Card and preset: re-import both.*

- The card now has post-history instructions, read after the chat: about 500 tokens, up to 1,000 only for action shown blow by blow; a long player message does not need a longer reply; open differently from the last few replies. `{{original}}` keeps your preset's own post-history text. Before, the only length rule sat at the top of an 8k preset, and replies doubled to imitate long player posts.
- The preset's length exception for "two or more characters" now covers only people moving against each other (a fight, a chase), never a conversation. It had relaxed the cap in every group scene.

## Lighter prompts and records (22 Nov 2026)

*Extension only.* Phase 3 of docs/audit-2026-11-21.md, the parts that need no design call.

- The planner gets full lines only for the people in play: present, main cast, named in a queued opening, or holding wants. Everyone else is one list of names (dead ones marked).
- A long player message reaches the observer as its head and tail, about 1,500 characters; settled quotes are still checked against the whole message.
- The genre register describes voice (diction, humour, how graphic), never length: "long detailed sentences" was sent every turn and pushed replies longer.
- Refusals stored on a message keep their kind and reason; the refused item is cut to 200 characters.
- Replay caches the word sets behind fact similarity: about 4× faster on a 97-message chat (13.7 ms warm, from about 59 ms).

## Calls that fail well (22 Nov 2026)

*Extension only.* Phase 2 of docs/audit-2026-11-21.md.

- Errors under streaming are read correctly. SillyTavern reports a failed streamed call only as "Got response status N", so the dropped-connection retry, the no-streaming fallback and the temperature fallback never fired. A 502/503/504 or "Failed to fetch" now counts as a dropped connection. A 4xx is asked once more without streaming, which carries the provider's own message.
- Retry waits hold. A chat event no longer retries the observer or tracker before its 20/60/180-second wait is over, so a flaky connection gets its three spaced tries instead of burning them in two turns.
- Tracker batches close at 20k characters of reply text as well as at the reply count. When the model spends its whole answer limit thinking, the next batch is half the size instead of the same input again.
- "Threads running low" re-plans at most every 3 turns.
- The facts cap keeps the weightiest facts (a revelation over a passing cart), still in the order the reply told them.
- A short answer that is a whole spoken line counts as evidence (`Elizabeth: "...Yes."`); a stray short word still does not. "who", "whom" and "whose" swap like other pronouns.
- Fact clean-up runs early only when there are enough facts it may remove; major facts held the count up and it re-fired every 2-3 turns.
- Rewritten beats are cut at a word, never mid-word.

## Who is who, and settled that sticks (21 Nov 2026)

*Extension only.* Found by an audit of a long group play-test (docs/audit-2026-11-21.md, Phase 1).

- The player character is profiled from the persona plus their own lorebook entry (title or first key is their name). Before, a persona holding only looks left a lore-written fighter noted as "an ordinary person's limits apply". Their sheet follows those sources until you set the stats by hand.
- Other names: a lorebook entry's keys become the person's other names ("Crimson Dragon" is Max). The observer sees them and resolves them to the person instead of a newcomer.
- A name from a swiped-away reply no longer stays in the cast: a profile drawn from the story or a lorebook entry does not bring back someone whose introduction is gone.
- A known name counts as present only when the reply mentions them or they were already in the scene.
- A status under another wording is the same condition ("knee injury" and "infected knee wound"), so treatments land.
- Settled matters close spine criteria by their id. The tracker was told to do this, but the validator refused every one.
- A settle on the same message as the latest plan now re-plans. Only what the player settled re-plans; settled read from the story alone is recorded without one. A player quote must be at least 8 characters.
- Settled ids come from the text, so two never collide and unsettle removes only one.
- Spine findings from replies a summary extension hides later are kept.
- A beat finished by three "advanced" replies plants its hook too.

## The price loop (21 Nov 2026)

*Extension only.*

Found live: the story kept returning to "what do you want in return" after the player had answered it. The arc, the spine, the tracker and the characters' wants all carried it, and nothing retired it.

- The planner sees the arc as goal, forces, act and the payoff's hooks still to plant. The arc's own endings stay out; the spine's endings are the live ones.
- Hooks are planted: a beat names the hook it plants by number, and completing the beat marks it. Before, nothing ever named one, so every hook stayed unplanted and kept being offered.
- A "toward" reading needs a quote, as "against" does. Unquoted readings had made an ending lead.
- The motive wording no longer speaks of a price: the cost of a goal is danger, time, loss or temptation, never payment others demand. The spine example no longer turns on a debt.
- Settled matters reach the tracker (a criterion that needs one reopened is marked failed), the spine drafter (no question, ending, criterion or want may turn on reopening one) and the planner's wants (a want a settled matter answers is renewed) and criteria (never served).
- `/director redraft` gives the spine drafter the settled list and the story so far, so the new spine starts from where the story stands.

## Feelings follow the deed, not the reaction (21 Nov 2026)

*Extension only.*

- The observer judges a feeling change by its cause, usually what the player character did, and quotes the deed. Tending a wound or standing between someone and danger is action or sacrifice and at least major, even when they only answer with a word. In a live run, sucking the pus from a wound was scored as "Don't stop." = words, minor.
- A sacrifice, shared danger or betrayal is never scored as minor.

## Settled stays settled, and a redraft button (21 Nov 2026)

*Extension and card: re-import the narrator card.*

- Settled matters: when the player character plainly answers something others keep pressing ("nothing, none, just a helping hand"), or the player shows they have had enough of a thread, in or out of character, the observer records it as settled. The quote may come from the reply or the player's message.
- A settled matter triggers a re-plan at once. The planner may not plan openings that press, test or reopen it, and an arc force it answers stops driving openings.
- The narrator's notes carry a `settled` line, and the card says what it means: closed, no one presses or asks about it again; feelings about it may still show.
- `/director settle <text>` closes a matter by hand; `/director unsettle` lists and reopens them.
- `/director redraft`: a fresh arc, spine and plan from where the story stands, for when the story feels stuck. Settled matters cannot come back as forces.

## Room for slow models (21 Nov 2026)

*Extension only.*

- Director calls are streamed. A slow thinking model used to send nothing for a minute and the connection was cut ("socket hang up"); a stream keeps it open while the model thinks. A connection that refuses streaming gets plain requests from then on.
- A dropped connection (socket hang up, reset, timeout) is retried after 20 s, 60 s and 180 s, then stops until "Retry failed calls", like an empty answer. It used to retry every 90 s without end. The spine step waits the same way.

## Deeds count, and goals with something at stake (21 Nov 2026)

*Extension only.*

- Feelings: deeds weigh more than words. Words alone move a feeling one step at most, whatever the observer says. A deed that costs or risks something is a major step (2); a new pivotal step (4) is for a life-changing act: saving a life, a real sacrifice, a betrayal. One reply can move a feeling by up to 4 (was 2). A major or pivotal loss of trust lowers the stage.
- Goals: the arc and the spine build the goal from the player character's own wants (survival, money, status, freedom, desire, revenge, pride, fear). Helping others can be part of it, but the goal also holds something the player character gains or keeps, at a cost; a purely selfless aim only when the card or the player shows that motive. At least one ending rewards putting themselves first.
- Planner: each plan offers at least one opening toward the player character's own goal, so they drive the story instead of only serving others' needs.
- The goal prompts no longer assume a male player character.

## Fixes from the group play-test (21 Nov 2026)

*Extension only.*

- Fewer planner calls: passing an opening by once no longer re-plans (8 of 11 plans in a 13-turn test came from that). An opening walked past twice is dropped, and the re-plan comes no sooner than 3 turns after the last plan, unless only one opening is left.
- Quotes: a quote of 6 or more words still matches when the observer swapped up to two names for pronouns or possessives ("Her left hand" for "Elizabeth's left hand"); every other word must match in order. The record keeps the reply's own wording. A crushed hand was refused before and never became a condition.
- Threads: the observer's prompt says which list each id comes from, and always shows Open threads (or "none"). A clue or unconfirmed-fact id sent under threads is filed where it belongs instead of refused.
- Story notes for stats: someone described by role before giving a name ("the guard … a slab of a man", then "**Guard:** … Berolt") now has that description in their notes, so their stats follow it.

## Installs from GitHub

*Extension only, no behaviour change.* The extension's files now sit at the repo root, so SillyTavern's **Install extension** takes `https://github.com/fadust/agnostic-narrator` directly. A copy installed by hand keeps working; to switch, remove the old `narrator-director` folder and install from the URL.

## Bounded retries after empty answers; every character gets stats; stats grow and decline

*Extension and card.* Re-import the card, or replace `Narrator.png` in place: it asks for build and occupation when a character first appears.

- The narrator card: when a character first takes part in the story, the prose shows at least their build and their occupation or role. Story-only characters' stats are drafted from that.
- Stats move with the story both ways, in two sizes (owner, 21 Nov 2026): small (2 points) for hard training or practice shown in a reply, a lesson learned, or a decline from age, sickness or disuse; large (8 points) for a decisive change, such as a maiming, a lost limb or sense, a breakthrough, a power gained or lost, or long training across a time skip. One event may move several stats. Anything that heals or passes stays a status.

- Characters the story introduces with no card and no lorebook entry are profiled once from story notes: the sentences of the replies that name them, the facts about them and their appearance on record (owner, 21 Nov 2026). One profile call per character.
- The profile prompt now says how build, occupation, background and age move each stat (a labourer's strength and endurance, a thief's agility, a scholar's intellect, a hard life's will); anything the text does not show stays at 30. This applies to cards and lorebook entries too.

- Fix (live, 21 Nov 2026): a character the story introduces whom an authored lorebook entry describes (Janus and Bianca in "Cast & Setting") now gets a profile and starting stats from that entry, once, like a card. Only character cards and the persona were profiled before, so such characters had no stats. The entry must be about them: titled, or first keyed, with their name, and naming them in its opening; a place or faction entry that merely lists them does not count. One profile call per character, and none again until the entry changes.

- Fix (live, 19 Nov 2026): an empty answer from the connection was retried every 20 seconds without end, so a model that kept failing burned prompt tokens (62 observer calls, ~160k prompt tokens, almost no answers). Empty answers now back off, 20 s, 60 s, then 180 s, counted per module; after that they count as ordinary failures (the reply's tries) and wait for "Retry failed calls".
- When a thinking model spends its whole answer limit thinking and writes no answer, the error now says so and names the fix (raise that module's answer limit, or use a model that thinks less), instead of "empty answer".

## Agendas, taken names, sleeping threads

*Extension and card.* Re-import the card, or replace `Narrator.png` in place: it explains "wants" on cast lines.

- Characters have wants of their own: up to three lasting, high-level wants each (what they live for), for every cast character. The spine drafts them from the characters' descriptions, the lorebook and their place in the story; the planner gives them to characters met later and changes them only when the story transforms one. The narrator sees them on a present character's cast line, never as an action to perform; short-term wants stay in the openings. They show and edit on the Cast tab. No extra model call.
- The block before the chat history lists the names already in use (cast and lorebook), so a new character never reuses one.
- A character whose wants you clear on the Cast tab is never given new ones by the planner; writing some back lifts that.
- Fix: the planner's answer was cut off (its limit was 1,800 tokens while beats grew a goal and an opening); the limit is now 3,000, and a setting still at 1,800 is raised. Tokens are spent only when a plan needs them.
- Fix: the plan check's "avoid" test flagged beats for sharing a word or a name with a style note in the profile ("rushing past the inn…"), and dropped good beats. Most of the avoid item's words must now be there.
- Fixes from the full live test (19 Nov 2026): when the notes run long, wants are kept on the cast lines longest instead of being cut first; an off-screen outcome cut off mid-sentence is dropped; the stall count no longer treats an unchanged location or minor background events as something new; the Cast tab's Wants box keeps one want per line (it was a one-line field that joined them).
- New setting **Let a thread sleep after N turns** (12): an untouched thread leaves the planner's view until it comes up again, keeping plans on what is in play and the planner's prompt smaller.

## Openings, patience and checks

*Extension and card.* Re-import the card, or replace `Narrator.png` in place: the `scene_intent` line means something new, and there is a new `waiting` line.

- The plan is a ride you may jump on or not. Each beat now has a goal, which the narrator never sees, and an opening the world offers, which is all the notes carry in `scene_intent`. A beat may slip to a later scene and says how it reaches you wherever you are. Plans follow the story profile, its avoid list included, and never fight it.
- Plan check: code flags beats that script your character, copy a spine goal into the opening, offer a "choice" with no choice, clash with a known name, rest on a time already past, or fight the genre. One cheap call rewrites flagged beats, only when there are any. Beats that still script you or fight the genre are dropped.
- Patience: an opening left untouched for **Nudge a waiting opening after N turns** (3) is mentioned once more as still there (the new `waiting` line), never pressed, and retired two turns later. Going elsewhere starts the count again.
- New re-plan triggers: **Re-plan when nothing changes for N replies** (5) brings one small opening to where you are, without cutting the scene short; a recent direction asking for quiet holds it back. The planner also refills when threads run low. **Re-plan every N turns** now defaults to 0 (events only); a setting still at the old default of 6 becomes 0 once.
- Spine tracker: a second, cheap check before "met". It sees each criterion with its quote, the text around it and the speaker, and confirms or rejects. A rejected mark is refused and the goal stays open. If the check fails, the marks stand.
- Skipped milestones: when a later milestone concludes while an earlier one is open, the earlier one is skipped. It gets no conclusion and no chapter, and leaves the tracker and planner. The Plan tab can reopen it.
- On a shared connection profile, the observer goes ahead of background calls that have not started, so your next turn's notes are not held back.
- The Log tab lists the check calls separately (`tracker-check`, `planner-check`).
- From the live test: the plan check also catches your character anywhere in a beat, not only at its start, and a beat that changes your character's body or clothes ("Max's collar has come loose"). The planner is shown what an opening is: a standing situation or want, not the act itself.
- The story's goal is your character's: the arc and the spine's question are built on what your first message says your character sets out to do, inside the world your cards, scenario and lorebook give. Your persona describes who your character is and never sets the story. Without a card, scenario or lorebook premise, the story profile waits for your first message.
- Fix: a bare `/director replan` (or the Re-plan button) no longer tells the narrator "re-plan from where the story stands", which revealed that a plan exists.

## The director runs only with the Narrator card

*Extension.*

- The director is active only in a chat with the Narrator card: alone, or in a group with your cards. A chat with any other card, or a group without the Narrator, gets nothing from it.
- `/director on` no longer adopts another card as narrator. It only turns the director back on in a Narrator chat paused with `/director off`. Chats where an earlier version adopted another card are now left alone.

## Ideas from other extensions

*Extension only.* Ideas taken from nine other extensions' code (merged_world_tracker, 100log, Story-Engine, storybooster, StoryArc, Story_director, Story_block, zTracker, Blackboard).

- Spine tracker, a harder "met": the quote must show the state itself, not a hint, a step toward it or a reaction; a request is not agreement until accepted. Each mark says its evidence: "occurred", "shown" or "implied", and only the first two count. A lasting state (trust, loyalty, a debt, an alliance) needs two different replies; one is shown on the Plan tab as "partly shown once".
- Every tracker mark and milestone event carries who speaks or acts in its quote, kept only when that name is in the cast and appears at the quote (or "you" for your character). Conclusions get "Corliss: …" and are told never to put an unnamed quote in someone's mouth.
- Facts: the observer names each fact's kind (identity, knowledge, relationship, possession, decision, promise, revelation, change, event, condition, gesture, scenery) and code sets the weight. Gestures and scenery are not recorded at all.
- Spine drafter: milestones and criteria are written as what has already happened on screen, reachable many ways; no tallies, no chains joined by "and"; milestone 1 starts after the current scene. Code flags criteria that start with your character's name, are gestures, tallies, or tie milestone 1 to the current scene, and one cheap call rewrites just those before the spine is saved.
- Cheaper calls: each role's fixed instructions are now identical between calls, so providers can cache them. The Log tab shows a rough token count per role for the session. New setting **Clean up early above N facts** (30): the clean-up also runs when facts have grown well past that, not only every 10 turns. "Clean up facts every N turns" at 0 now only turns off the timer.


## Design fixes from live play

*Extension, card and preset.* Re-import the card and the preset (or replace them in place), then select the preset again so its new reply limit applies.

- Preset: the longest reply is 10,000 tokens instead of 1,200. A reasoning model spends part of that limit thinking, and replies were cut off mid-word.
- Card: the narrator renders your character's action and speech from your message, enhanced and enriched in the story's voice, but never adds an intention you did not write. It used to be told never to write them, which contradicted the preset.
- Spine tracker: criteria are listed apart from the one reading per ending; most exchanges settle none. A "failed" mark must say why the criterion can never become true, or it is refused. "Milestone happened" counts only together with one of its criteria met.
- Spine drafter: three to five milestones that are real turning points, two to four criteria each. A criterion is an objective (who knows, trusts, owes, holds what) that states the role it plays, never a particular gesture, scene or time.
- Facts: each is weighed major or minor, at most four per reply, and gestures or background are not facts. Minor facts fade from what the models see after three turns. Every 10 turns (setting) a clean-up merges facts that say the same thing, the most current winning, and retires minor ones that no longer matter; a major fact is never removed. The Record tab shows weight, fading and merges.
- With another extension keeping the memory, the narrator also gets the director's one-line summary of each of the last 2 turns that extension has not summarised yet (BaiBai Book reports which). When it cannot tell, both are sent.
- Card: embellishing your character's action changes how it is done, never what is done: no extra action, gift, payment, promise, plan or line of speech.
- Tags removed before reading now include BaiBai Book's `bbs_items` and `bbs_vars` (its item and variable bookkeeping). A list still at the earlier default is updated; one you edited stays as it is. Changing the list no longer voids what was already read: each record remembers the tags it was read with.
- Preset: a new impersonation instruction. `/impersonate` (and Guided Generations' impersonate) drafted narrator prose with a timestamp instead of your character's next message.
- Card regex: removing a stray closing tag no longer glues the paragraphs around it together.
- Preset: "what the world left open is yours to build" no longer reads as covering your character. The narrator had been filling in Max's in-between actions (dismounting, handing over reins, paying a guard). Select the preset again after re-importing it.
- Milestone conclusions get the current scene and the reasons for failed criteria, and may not invent places or scenery.
- The planner's off-screen outcomes count as major facts.
- Fix: an empty answer from the connection no longer counts as a failed reading of the reply; the director tries again 20 seconds later.
- Fix: a name known only in parts ("Elizabeth and Dorothy Juringen") is accepted for a new character the reply names in part.
- Fix: speech quoted without its "she says" tag matches the reply sentence by sentence.

## Other memory extensions, Group Greetings, trial fixes

*Extension and card.* Re-import the card, or replace `Narrator.png` in place.

- New setting, **Who keeps the story's memory**: the director (as before), another extension, or nobody. With another extension (BaiBai Book, Summarize, or a macro you name) the director sends the narrator no summaries and no chapters, plans from that extension's record, and keeps a one-line summary of only the last 2 replies, which covers BaiBai Book writing its summaries a reply or two behind. If the extension is missing, fails or takes over 5 seconds, the planner works from those lines and the rest of the record. Other extensions can register their own connector (`narratorDirector.registerMemoryProvider`).
- New setting, **Tags to remove before reading**, default `bbs_start, bbs_end, bbi_image`. Each tag is removed whole, content included, before the director reads a reply; the saved message is unchanged, and what was read before still counts.
- Card: tags or blocks another instruction asks for around the prose (a timestamp, an image prompt) are allowed.
- In a group, a greeting Group Greetings has already chosen for the narrator is kept instead of being replaced by the card's first group greeting.
- Fix: "Valid UID is required" popups (raised by WorldInfoInfo) after the card gained entries. The director now keeps its lore files in step with the card, and uses its own `Narrator baseline (director)` when you already have a `Narrator baseline` file it did not write.
- Spine criteria are drafted as outcomes that can happen many ways, using only names the setup gives; the same goes for alternatives the planner suggests.
- Beat intents, preconditions and clues are cut at a sentence end instead of mid-word, and the planner is asked to keep intents to two short sentences.
- Fix: a character whose full name appeared only inside another extension's block (an image prompt) never joined the cast once those blocks were removed. A name the reply uses only in part ("Varn") now counts when the full name is already known from your message or the record.
- Fix: concluding a milestone, marking a criterion or another change in the inspector now starts the director at once; before, the conclusion waited for your next reply.
- Fix: a milestone concluded on the newest reply was concluded again on every pass until you answered, each time with a model call.
- Fix: saving the spine on the Plan tab no longer wipes what the story recorded since you opened it. The save changes the question, titles and texts; marks, quotes, readings and concluded milestones stay. Redrafting the spine still replaces everything.
- The Record tab's Turn summaries part says when another extension keeps the memory, instead of offering a roll-up that does not apply.

## Observer and spine tracker in parallel

*Extension.*

- The observer and the spine tracker now read replies side by side. Give the spine tracker its own connection profile and both calls are in flight together; on one shared profile they still take turns. The director still waits for the narrator's reply to finish before either starts.

## Fixes from review

*Extension.*

- Saving the arc, beats, scenes or spine on the Plan tab no longer sends the narrator a "the record of … was corrected" note, which revealed that a plan exists.
- A failed ending criterion gets at most one alternative route, instead of one more on every re-plan.
- "Keep the current endings" sticks: no new ending is proposed again until you turn away again.
- A batch the spine tracker keeps failing on is passed over, so newer replies are still checked.
- A card character you renamed or removed no longer reappears in the observer's list after the card is re-profiled.

## Story spine: endings and milestones

*Extension.*

- A new model role, the **spine tracker**, reads replies for the spine only; the observer is back to record keeping and never sees the spine. The tracker has its own connection profile and longest-answer setting, and its result is stored apart from the observer's, so either can fail alone.
- The tracker does not run after every reply. It waits for **Check the spine every N replies** (4 by default) answered replies and reads them in one call, tagging each finding with the exchange it came from. "Check the spine now" on the Plan tab, or `/director track`, checks at once, the newest reply included.

- The planner drafts a story spine from the setup: the question the setup poses, three or four endings that answer it in different ways (all stay open, like victory conditions), and three to six arc milestones. Each has a checklist of criteria.
- The tracker marks criteria met or failed, in any order, each with a quote, and gives a toward, aside or against reading for every ending. "Against" needs a quote.
- Endings never close: a failed criterion lowers progress, and the planner suggests an alternative by another route. When every ending has been turned away from, the planner proposes a new one; it is added only if you accept.
- A milestone concludes when its checklist is resolved, or on "Conclude now". A short conclusion is written, the checklist is dropped, and the conclusion reaches the narrator as "Chapters so far". Nothing about milestones in progress is sent.
- Building, drifting and turning away are judged per scene, not by counting replies. A scene ends when the place changes or the planner's scene runs out of beats; a re-plan renaming its scenes does not end one, so drifting cannot cause a re-plan on every reply. Drifting, a failed ending criterion and turning from every ending each prompt a re-plan.
- The planner is given definitions for each beat kind and guidance on writing an intent; beats can name the criterion they serve.
- The Plan tab shows and edits all of it. `/director spine` drafts or redrafts the spine.

## Appearance anchors

*Extension.*

- Each character has an Appearance field on the Cast tab: lasting looks only (build, hair, eyes, marks, usual clothing). Gender, race and age group sit beside it and work the same way; race is human unless the card says otherwise. Age group is one of child, teen, young adult, adult, middle-aged, elderly, judged by how the card describes or depicts the character rather than a number it claims.
- It is taken from the card when the character is profiled, then kept: the story and later profiles never change it. Clear it to take it from the card again.
- While a character is in the scene, their appearance, and the player character's, goes to the narrator in the block before the chat history, under "How they look (keep it consistent)".

## Record tab in parts

*Extension.*

- The Record tab has five parts: What has happened, Rumours, Threads, Turn summaries, Living lore.
- Facts and rumours are split into the world's (names no cast member) and the cast's, grouped under the first character each one names; main cast first.
- Turn summaries show the latest 20 one by one; older ones not rolled up yet appear as one block under the aggregate summary.

## Passers-by are not cast

*Extension.*

- The Cast tab can lock a character as main cast. A locked character always stays in the cast and cannot be removed until unlocked; the planner is told they are main cast and keeps them central; the notes always give their full line, even in a large scene.
- The Cast tab can rename a character or remove one from the cast. Renaming onto an existing cast member joins the two. A removed or renamed-away name stays out even when a later reply uses it again; renaming back restores it. The player character cannot be removed.

- The observer introduces only people with a proper name who take real part in a scene. People known only by a role ("the cobbler"), crowds, and named people only glimpsed or mentioned are not cast; what they do can still be a fact.
- A new name that reads as a role (no capital letter, or starting with "the" or "a") is refused, whatever the observer says.
- Role entries already on an existing chat leave the cast and the scene; their facts stay.
- `npm run docs` and `npm run fixtures` now work on Windows.

## Cast cards are read as people, not titles

*Extension.*

- A card that holds several people ("Elizabeth & Dorothy") becomes one cast member per person, each with their own profile, abilities and feelings.
- A card whose title is not its character's name takes the name from the card text. A fuller form of the title ("Mira Vell" for a card called Mira) keeps the title.
- On an existing chat each cast card is profiled once more. What was recorded under a one-person card's title moves to that person; a split card's people start fresh, and take the title's place in the scene.

## Full disclosure

*Extension.*

- Every setting has a control: tries per reply, the longest answer per module and the lore mirror files were previously reachable only by editing a file.
- Explanations are printed beside each setting instead of in tooltips.
- Cast shows temperament, behaviour at each level of regard, stances toward others, false beliefs and what was witnessed.
- Plan shows and edits the whole arc, every scene, and each beat's scene, lore keys and clues.
- Record shows each fact's turn, witnesses and quote, every turn summary, and lore history; facts can be marked secret and the summary edited.
- Log shows the chat variables and the director's whole state.
- Now has the director's on and off switch for the chat.

## Inspector redesign, temperatures, licence

*Extension.*

- The inspector is rebuilt as seven flat tabs with forms: Now, Scene, Cast, Story, Plan, Record, Log. Nothing is folded away and no JSON is edited by hand.
- A scene form, so a location may contain a comma.
- The director sets its own temperature: 0.2 for record keeping, 0.7 for planning.
- The settings panel is flat and grouped.
- MIT licence added.

## Documentation

**Documentation.** README rewritten; installation, playing, reference, how-it-works, troubleshooting and development guides added; `docs/rules.md` is generated from source and checked by the tests.

## Companion preset: context and length

*Preset.*

- Context size 200,000 with the unlocked slider, for 1M-context models.
- Response length 1,200, so the length rules can be met.
- Seniority restored as an allowed imbalance: the young bound by the word of their elders.
- The length cap relaxes for action, up to about 1,000 tokens.

## Content rating

*Extension, card, preset.*

- Stories are mature by default: explicit on, lethality high.
- `/director pg` turns adult content off; `/director pg off` returns to mature.
- New companion preset from the author's draft. Its content sections switch on the PG flag.
- The card states that no preset overrides its boundary.

## Rules revised

*Extension, card, preset.*

- The card states what outranks what, and explains every line of the notes.
- The player decides the attempt; the world decides the outcome.
- A turn ends where it becomes the player's move, not on a forced hook.
- Lore keys are no longer shown in the notes; `pressure` is renamed `tension`.
- The observer's rules define `secret`, `beliefs` and threads, and require certainty for a correction.
- Off-screen outcomes enter the record as unconfirmed.

## Audit fixes

*Extension.*

- Message ids and player operations moved out of the per-swipe data; swiping back no longer loses edits. Older records migrate.
- A late director sends older notes marked as behind, without steering.
- Attempt tiers only for real contests.
- "The player" and first names resolve; ambiguous names are refused.
- Restated facts are not duplicated; lore entries sharing a key merge.
- An intent that never lands is retired.
- A failed step pauses for 90 seconds; plans survive the player typing meanwhile.
- The narrator's own group greeting is no longer hidden.

## Presence

*Extension, card.*

- Presence is additive: a character leaves only by a quoted departure or death, or a change of place.
- Cast cards are known names from the first reply.
- The card tells the narrator that notes can lag and never to drop a character because the notes omit them.

## Lore mirror files

*Extension.*

- The director's two lore books are mirrored to real lorebook files, so other extensions can look entries up. Fixes "Valid World Info file name is required".

## Explicit content

*Extension, card.*

- An explicit-content switch per story, and an erotica craft entry.

## First build

*Extension, card, preset, quick replies.*

- Director extension: records and replay, observer with quote checks, notes composed in code, planner, summaries, dynamic lore, group handling, inspector, `/director`.
- Narrator card with craft entries and regex scripts.
- Fixture suite, unit tests and end-to-end checks.
