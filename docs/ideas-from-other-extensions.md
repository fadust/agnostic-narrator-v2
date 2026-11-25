# Ideas from other extensions

This is the November research record. Check [rc.6 verification](v2-verification.md) for the current behavior and remaining audit findings.

Written 18 November 2026. Nine SillyTavern extensions were read, README, docs and code, by three research agents: storybooster, Story_director, Story_block, 100log, StoryArc, Story-Engine, zTracker, Extension-Blackboard and merged_world_tracker. Nothing here is built. It is a menu for the owner to choose from. Shallow clones were kept in the session scratchpad for reference only.

## What we already do better

- **Every record must quote the reply word for word.** No other extension checks this everywhere; most trust the model or the narrator's own bookkeeping lines.
- **State is rebuilt by replaying records kept on the messages.** Only Story_block does the same; the others snapshot or reconcile, and orphan data on swipes.
- **A spine with live endings and objective milestone criteria.** No other extension has one. The rest plan arcs or beats with no idea of how the story could end.

The best ideas below sit around those strengths rather than replacing them.

## Theme A: an honest tracker

These target the weak spots seen in play: "met" given too easily, scene-sized milestones and misattributed quotes.

| # | Idea | Seen in | Cost |
| --- | --- | --- | --- |
| A1 | One verdict per open criterion, with "no evidence" or "no opportunity" as the default answer. Nothing is skipped, and a criterion that had no chance to happen stays open | storybooster (`audit-policy.js`), Blackboard (`validateAudit`), merged_world_tracker (`progress.js`) | Prompt and schema |
| A2 | "Met" only when the reply depicts it, not when it foreshadows, discusses, repeats a plan or resembles it in theme (wording from merged_world_tracker) | merged_world_tracker | Prompt |
| A3 | A soft criterion (trust, a change of heart) needs evidence from two separate replies | storybooster, Story-Engine (two distinct evidence categories for a bond stage) | Small code |
| A4 | A cheap second check, only for items about to turn "met": given the criterion and the quote, confirm or reject | Blackboard (independent verifier: "the repairer's confidence is not evidence") | One small call per conclusion |
| A5 | A criterion must be recognisable as one moment on the page. A tally or an "X and Y" chain is split or refused; a slow process names the moment it "has taken hold" (a beat stayed open for 439 messages without this) | StoryArc (ADR-0006) | Validator rule |
| A6 | "Skipped", not "failed", for a milestone the story jumped past | StoryArc (ADR-0010) | Small |
| A7 | Number the replies sent to the tracker and the conclusion writer and tag each with who speaks, so verdicts cite a reply and conclusions know the speaker | storybooster (`[CHAR_RESPONSE_n]`) | Small; fixes finding 4 |

## Theme B: the narrator feels pressure, never sees the goal

StoryArc's design notes record a real failure. When the narrator was shown what a beat should achieve, even marked "not instructions", it forced the event within two messages (ADR-0008, ADR-0002). Their fix shows the narrator only a force acting on the scene; whether the goal happened is judged afterwards by the extraction call.

| # | Idea | Seen in | Cost |
| --- | --- | --- | --- |
| B1 | Audit our director notes. `scene_intent` currently states the beat's event ("Piet tells Max where the captain drinks…"). Rewrite it as a pressure in the world ("Piet is eager to talk to a paying stranger"), never as the outcome | StoryArc | Prompt and notes wording |
| B2 | Plans state what is true in the world, never how to narrate; tone words leaked into the prose | StoryArc (ADR-0009) | Prompt |
| B3 | A "still waiting after N turns" nudge, and a setting for how hard beats push (passive, proactive, assertive) | merged_world_tracker (`injection.js`) | Small |

## Theme C: better plans

| # | Idea | Seen in | Cost |
| --- | --- | --- | --- |
| C1 | Beat rules for the planner prompt (text only): each beat commits to one event and changes the conditions for the next; setup is not foreshadowing; a character performs the beat, never the player; no beat assumes the player agreed; at least one beat works against the goal; proposals vary in driver, target and scale | merged_world_tracker (`story_planner/prompts.js`) | Prompt |
| C2 | Size test for milestones: "a new playable situation, not another scene"; "name the encounter, do not stage it" | merged_world_tracker | Prompt; targets finding 3 |
| C3 | Beats may slip, work without the player present, and state how they reach the player wherever they are | Story_director (arc planner) | Prompt and one field |
| C4 | Code checks on every plan: a line that scripts the player is refused; dates in the past are dropped | Story_director (`validate.js`) | Small code |
| C5 | Better re-plan triggers: the scene has stalled, or open threads are running low, rather than only every N turns. Before forcing an event, check that the player's direction does not exclude it and nothing is already under way | Story_director, storybooster (six gates in `automatic-plot.js`) | Small, or one small call |
| C6 | A re-plan keeps the situation and replaces the road: what happened and what was revealed stay. The player's out-of-character rulings stay binding | StoryArc (ADR-0003) | Prompt |
| C7 | One narrow check call per new plan: rewrite triggers that give away secrets, unrecognisable goals, and new names that clash with the cast | StoryArc (`check-plan.txt`) | One call per plan |

## Theme D: characters and a world with their own purpose

| # | Idea | Seen in | Cost |
| --- | --- | --- | --- |
| D1 | A hidden intention per important character: action, trigger, expiry. It defaults to open; "done" only when it fully happens on the page. When its trigger is met, the notes say that character acts this turn. Capped in number | merged_world_tracker (`interiority`) | One small call every N turns, or folded into the observer |
| D2 | Standing state per character: manner, and stance toward others, changed only at a quoted turning point ("said differently is not a change"). Players otherwise restate it by hand (146 corrections in 1,000 messages in StoryArc's test) | StoryArc (long-term memory design) | A few fields |
| D3 | Off-screen plans on the story clock: a faction or rival moves at a set time, advanced by code when due, and leaves evidence the player can find by one route | Story-Engine (`world-memory.js`), Story_director (agendas, clocks) | Code; needs a reliable story clock |
| D4 | Characters the player has not met stay hidden from the narrator until they are met | Story_director (cast planner) | Small |

## Theme E: who knows what

| # | Idea | Seen in | Cost |
| --- | --- | --- | --- |
| E1 | Each fact records, per character, known / unknown / unverified, with how they learned it. "Unverified" constrains nothing. Knowledge follows information flow, not who was in the room | 100log (`memoryRequest`), StoryArc (knowledge ledger) | Schema; improves secrets, "wrongly believes" and "who knows" criteria |
| E2 | A fact is printed once, with everyone who knows it, under a character budget | StoryArc | Small |
| E3 | A list of names already taken, made in code, so the narrator never reuses one for a new character | StoryArc | Free |

## Theme F: memory, cost and robustness

| # | Idea | Seen in | Cost |
| --- | --- | --- | --- |
| F1 | Dormancy worked out, not stored: a thread or fact unseen for N replies sleeps, and wakes when its key, place or people return. Replay-safe | Story_director (`relevance.js`) | Small code |
| F2 | The clean-up flags two facts that cannot both be true, instead of "newest wins", when the story does not say which replaced which | 100log (`cleanupRequest`) | Prompt |
| F3 | Facts the player deleted are listed to the observer, so they are not recorded again in other words | 100log | Small |
| F4 | A "carry" tag for unresolved threads, secrets and corrections, so they survive when a memory extension hides old messages | 100log | One field |
| F5 | The notes carry "what changed since last told", told once, so the narrator is not told the same thing every turn | Story_block (`[Happened]` lines) | Moderate |
| F6 | One budget for everything the director injects; the least important block drops first, and must-tell lines are pinned | merged_world_tracker (`budget.js`), Story_block | Small |
| F7 | The fixed part of the director's text stays byte-identical so the provider's prompt cache holds | Story_director, Story_block | Check first |
| F8 | Repair malformed JSON (fences, trailing commas, smart quotes) before refusing; never touch quote text | zTracker | Small |
| F9 | Split a step that often fails into small calls (cast first, then relationships for those present), each retried on its own | zTracker | More calls, each smaller |

## Not worth copying

- Bookkeeping lines written by the narrator inside its own reply (Story_block, Story_director, Story-Engine). Cheap narrators drop or garble them; ours is a separate, checked reading.
- A review and rewrite pass on every reply (Blackboard, 100log's checker). It costs several calls and adds latency per turn.
- Dice, economy and injury systems (Story-Engine, Blackboard). Our objective is story, not a game system.
- Very long, rule-stuffed prompts (100log, storybooster, StoryArc's extractor). They suit capable models, not cheap ones.

## Suggested order

1. **Theme A and B1.** They fix weak spots already seen in play, cost almost nothing to run, and touch only prompts, the validator and the notes.
2. **Theme C.** Better plans and smarter re-plan triggers, mostly prompt text plus small code checks.
3. **E1 and D2.** Knowledge and standing state make characters consistent over long stories.
4. **D1 and D3.** Characters with their own purpose and a moving world: the largest change, worth doing once the tracker is trusted.
5. **Theme F.** As needed, when cost or prompt size starts to matter.

## Reassessment after the integration trial (18 November 2026)

Correction from the [archived research round](archive/handover-2026-11-18.md#research-round-nine-other-extensions-18-nov-2026). The earlier implementation added evidence kinds and two exchanges for lasting states (I1), fact weight from a kind list (I2), a speaker on quotes (I3), milestone wording plus a check pass (I4), and cheaper calls with a cost table (I5). The recorded test count at the time was 111.

What B's chats show on top of that:

- **Self-labelled evidence does not stop wrong marks.** In the 12h08 chat (running I1 and I3), all three "met" marks were labelled "occurred", the strongest kind, including a tally ("the bailiff makes the tally" for "the forfeit has been satisfied") and a gesture.
- **The speaker check catches the error but nothing acts on it.** For "Elizabeth has asked Max what he means to do", I3 correctly found the quote's speaker was Dorothy Juringen ("she puts her hand in yours"). Nothing compares that speaker with the person the goal names.
- **The planner still hands goals to the narrator as events.** A beat was copied word for word from milestone goal m2-c2. Beats included scenery filed as a "reveal", a "choice" that offered none, and 3 of 41 beats that assumed the player's action. Not covered by I1–I5.
- **Milestone 1 is fixed by I4, later milestones are not.** "Wins a moment of trust from Elizabeth" is now a real turning point. But milestone 3 was still "Dorothy stops flinching", with "no longer keeps her body turned away".
- **Less pressing.** Players wrote no out-of-character messages, so binding rulings matter less. The tracker no longer fails anything, so "skipped, not failed" matters less. BaiBai Book owns memory and tracks the protagonist, items, variables, NPCs and story time, so memory, dormancy and standing state matter less.

Revised order: (1) reject a mark whose checked speaker is not the person the goal names; (2) a second check before "met", since self-labels proved unreliable; (3) pressure, not goal, in the notes; (4) beat rules plus a code check against beats that script the player; (5) extend I4's check pass to body-language and gesture goals in every milestone; then the rest as before.
