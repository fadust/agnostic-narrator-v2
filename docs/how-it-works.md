# How it works

## Two models, three channels

The narrator writes the story. The director keeps the truth and the future. They share one story through three channels:

| Channel | Direction | Carries |
| --- | --- | --- |
| The reply | Narrator to director | What happened |
| The notes | Director to narrator | What she needs to know for this turn |
| World Info | Both lorebooks to narrator | Authored lore, and lore the story has added |

Only the narrator writes to the chat. Every director call runs through its own connection and never sees the narrator's prompt.

## Records, not stored state

After each narrator reply the director logs a record on that message. Current state is never saved; it is rebuilt by replaying the records in chat order.

That one decision handles everything SillyTavern lets you do to a chat:

| You do | What follows |
| --- | --- |
| Swipe | Director removes the old reading and dependent records, then reads the active reply |
| Swipe back | Director reads the newly active reply again |
| Edit a reply | Director discards records that depended on the previous text and reads the edited reply |
| Delete messages | Director removes facts, plans, summaries and lore that depended on the deleted text |
| Branch or checkpoint | The branch carries its own messages and so rebuilds its own state |

The message carries three kinds of Director data.

- **Bound to the active reply**, in `extra.narrator`: the observer's reading and director operations that rest on the current story, such as a plan. SillyTavern still keeps its swipe text.
- **Bound to the generated swipe**, in `extra.narratorCue`: the beat and clue IDs that reached the assembled prompt. The observer uses this record for beat progress, and the Now tab shows the sent opening and any evidence it found.
- **Bound to the message**, at its top level: a stable id, active revision and operations by the player or by setup. Swiping preserves independent player edits and retcons.

## Nothing counts until accepted

The latest reply is provisional: you may still swipe it. It commits when a later message exists. Status is derived from position, never stored, so it cannot disagree with the chat.

The notes may rest on a provisional reply, because by the time they are used you have replied. The dynamic lore uses committed replies only.

## A turn

1. **You send.** SillyTavern adds your message, then runs the director's generate interceptor.
2. **The notes are composed in code**, in milliseconds, from replayed state and your message. No model is called.
3. **The narrator generates.**
4. **The observer reads the reply**: one call, in the background, while you read.
5. **Setup and planning run if needed**: character profiles, a re-plan, a summary roll-up.

**Where starting stats come from.** Every character gets a profile with starting stats once: card people and the player character from their card or persona; a character the story introduces from the authored lorebook entry about them (titled, or first keyed, with their name); anyone else from story notes, which are what the story has shown of them so far. Build, occupation, background and age set the stats (a labourer's strength, a scholar's intellect, a hard life's will); what the text does not show stays at 30. After that, stats change only on narrated evidence, both ways: a small step for training, practice, a lesson, or decline from age, sickness or disuse; a large step for a decisive change (a maiming, a breakthrough, a power gained or lost). Anything that heals or passes is a status, not a stat.

Because step 4 happens after the reply is on screen, the director adds no wait before narration. If you send before it finishes, the notes are built from what is known, marked as one reply behind, and carry nothing that steers.

## Model proposes, code disposes

The observer returns JSON: facts, scene, relationships, statuses, threads, lore drafts, contradictions. Nothing it returns is applied directly. `validate.js` checks each item:

- **The quote.** Each item carries a passage copied from its source. An earlier fact can cite the selected memory with a confirming verdict. Current events still need evidence from the reply. Code checks that the passage exists in the cited source.
- **Allowed values.** Axes, directions, weights and the rest come from fixed lists.
- **Names.** "The player", a first name or a fuller name resolve to one known character. A name matching two is refused.
- **Caps.** One reply can add only so much.

Rejections are counted and listed in the inspector. A high rate means the model is paraphrasing instead of quoting.

## What the observer may see

The observer sees the reply, the scene before it, known characters, recent facts and open threads. Of the plan it sees only the one intent and clue the narrator was shown that turn, so that it can say whether the beat landed. The quote rule stops that from leaking into the record: an intent that was asked for but not narrated has nothing to quote.

It never sees the spine. A separate **spine tracker** reads replies for the spine and nothing else, once a story has one. It does not run after every reply: it waits until a set number of replies you have answered are ready (4 by default), then reads them in one call, or reads at once when you ask. It sees each ending's title and open criteria, the open criteria of the first open milestones, and the numbered exchanges (your message and the reply). It gives one reading per ending for the batch (toward, aside or against; "against" needs a quote) and marks criteria met or failed, each with a quote, each tagged with the exchange it came from so it lands on its own reply. The batch is stored on its last reply, apart from the observer's record, and stands only while every reply it covers is unchanged.

## The spine

The planner drafts it once, after the arc, from the same material as the story profile: the setup's question, three or four endings that answer it in different ways, and three to five arc milestones as stepping stones. Each carries a checklist.

- **Endings never close.** A failed criterion lowers that ending's progress, and the planner suggests an alternative by another route: a refusal from one house is not a refusal from every house.
- **A second check for quoted claims.** One call on the tracker's profile checks each proposed criterion mark and milestone turning point against its quote, nearby text, and speaker. Each claim needs its own confirming verdict. Criteria settled by an explicit player decision still use the settled matter's ID.
- **Earlier memory.** A confirmed quote from the selected memory can establish that a criterion was already met. A lasting criterion can use memory for one showing and a separate reply for the second. A recalled mark can resolve the checklist while the current scene’s direction still comes from the current exchanges.
- **Skipped milestones.** When a later milestone concludes while an earlier one is open, the earlier one is skipped. Its checklist stays available to the tracker, and a later confirmed turning point can reopen it. The player can also reopen it on the Plan tab.
- **Milestones conclude** when every criterion is met or failed, or on "Conclude now". A short conclusion is written from the marks and quotes, and the checklist is dropped. The conclusion is logged on the reply that resolved the milestone, so swiping that reply reopens it.
- **State is judged per scene,** never by counting replies. A scene ends when the place changes or the planner's scene runs out of beats; a re-plan never ends one by itself, so a drifting stretch cannot set off a re-plan on every reply. Anything built toward an ending or milestone in the scene means building; a scene that closes with nothing built means drifting (but not while some of its replies still wait for the tracker); a quoted "against" turns that ending away. Drifting, a failed ending criterion, and turning from every ending each ask the planner for a new plan.
- **The narrator never sees the spine,** only the current beat's intent, and the conclusions of milestones that have concluded, as "Chapters so far".

## Fact, plan and belief

| Kind | Holds | Reaches the narrator as |
| --- | --- | --- |
| Canon | Quoted narration and confirmed earlier facts from memory | Cast lines, `watch`, summaries, lore |
| Unconfirmed | What was hinted or rumoured, and off-screen outcomes | Nothing, until narration confirms it |
| Plan | Beats that might happen | One `scene_intent` at a time |
| Spine | Endings and milestones with their checklists | Only concluded milestones, as "Chapters so far" |
| Belief | What a character thinks, true or not | `watch` |

They are kept apart so that a plan can never be mistaken for a fact.

## Presence

The list of who is in the scene only grows by the observer's word. A character leaves by a quoted departure or death, or when the scene moves to a different place. A model that lists only who spoke cannot make a silent character vanish.

## Abilities and relationships

The Cast tab shows the seven abilities and four feelings the Director keeps on record. When a character's profile or the narration establishes prior history with the player, the Director can fill the starting stage and any feelings supported by that history. Later events and Cast edits update those fields.

- **Trust and affection** are averaged into a band from hostile to devoted. That band chooses the character's behaviour cue. Familiarity has its own stage, so a longtime rival can be familiar and wary. The planner sees the band and stage when it plans around the cast.
- **Desire and tension** add separate cues at +4 or more, such as “drawn to them” or “strained right now.” Stances toward other cast members become cues when both people are present.
- **Abilities** such as strength and agility become descriptions such as “strong” or “quick.” The Director compares relevant abilities when the player's turn suggests an exchange. Conditions can lower effective abilities for those comparisons.
- **Attempt tiers** apply when the Director can identify one opposed ability and one opponent with stats on record. The result guides the outcome as easy, costly, risky, or beyond the player's current ability. Without a tier, the narrator uses the cast descriptions and scene.

The narrator receives these cues in words and writes the reactions and consequences. The Director uses fixed comparisons and changes the scores when the observer records an event with evidence from the story.

## Planning

The planner keeps a short horizon: up to three scenes and six beats. The plan is a ride the player may jump on or not. Each beat has a **goal** (what counts as it landing, seen by the planner and the observer) and a **pressure** (an opening the world offers, which is all the narrator sees). A beat may slip to a later scene and says how it reaches the player wherever they are. Plans follow the story profile and never fight it.

The director offers the first queued opening that fits. A required place, required people or an unfinished prerequisite can hold a beat back. An independent opening can come up first, and a held beat stays available when its conditions are met.

The observer quotes the narrator's reply for a world outcome and the player's own message for a player choice. When it proposes progress, a second call on the observer's profile checks the quote against the goal. A missing or negative verdict leaves the beat untouched. A confirmed partial advance keeps the goal open. Earlier saved observations replay with the rules in effect when they were recorded.

The planner runs when the openings run out or threads run low, when you go off-plan, when the scene stalls (N replies recording nothing new), when the spine says you are drifting, and when you ask. Timed re-plans are off by default.

**Plan check.** Code flags each new plan: beats that script the player, copy a spine criterion into the opening, offer a "choice" with no choice, clash with a known name, rest on a time already past, or fight the story's avoid list or lethality. Hollow choices are retyped and past times dropped in code. Only when something needs rewriting does one cheap call rewrite the flagged beats. A rewrite that still trips a flag is refused. If the rewrite fails, beats that script the player or fight the story's profile are dropped.

Run `/director checkplan` to review the existing queue in one checker call. It reads the current scene, established facts and the selected story memory provider, such as BaiBai Book, SillyTavern Summarize, a configured macro or a registered provider. The checker quotes its source when making a continuity correction. It saves accepted corrections under existing beat IDs and skips beats that still violate the agency or genre rules. The command preserves queue order and progress. If the checker call fails, the queue stays as it was.

Planning, flagged-beat rewrites, and spine drafting and redrafting use the selected memory alongside the Director’s records. The Observer and spine tracker request earlier memory from a provider that can stop before the reply or batch being read. BaiBai Book supports this through its history API. Confirmed memory quotes can establish earlier facts and mark criteria met. The Director records their provider and cutoff. Beat progress, scene changes and ending readings keep their original evidence rules. When a source is missing, slow, or cannot supply the requested cutoff, the Director continues from the local story record.

**Wants.** Every cast character may have up to three lasting, high-level wants: what they live for ("a happy family", "to amass a fortune", "to be loved", "keep the inn's silence"). They may support each other or pull against each other. The spine drafts them for the people the material names, rooted in their description, the lorebook and their place in the story; the planner gives them to others, a few per plan, and changes a character's wants only when the story transforms one (achieved, lost, betrayed), saying why. No trigger, no expiry, no observer check. The narrator sees them on the cast line while the character is present; short-term wants stay in the openings. While a character is away, the planner may move one of their wants off screen as an outcome, unconfirmed until narrated. They show and edit on the Cast tab; a character whose wants you clear is left without.

**Dormant threads.** A thread untouched for 12 turns (a setting) leaves the planner's prompt until a reply names its people, place or key words again, or they are in the scene.

**Names already in use.** The block before the chat history lists the names the cast and the lorebook already use, so a new character never gets one of them.

**Patience.** An opening sent to the narrator and left untouched for N turns (3) gets one reminder. It is retired after two more untouched offers (five if required). Taking a step toward it or going elsewhere starts the count again.

Code enforces the rest: no three pressure beats in a row; an arc needs at least two possible endings; your message always outranks the opening.

## Dynamic lore

Lore drafts ride in the observer's output. Once their reply commits, code turns them into lorebook entries:

- An event or a change to the world earns an entry at once.
- A person, place or thing must appear in two accepted replies first.
- Drafts sharing a key update one entry.
- A character who has a card gets no entry.

The book is derived on every World Info load and added to SillyTavern's list at that point. A mirror file is written so that other extensions can look entries up by book name; the mirror is never bound or activated.

## Memory

**Who keeps the story's memory** decides this. With the director (the default), each observation includes a one or two sentence summary. Summaries are sent only for messages that have left the prompt or that you have hidden, so nothing is told twice, and every eight are rolled into one. With another extension (BaiBai Book, Summarize), that extension feeds the narrator. The director adds only its one-line summaries of those of the last 2 turns the extension has not summarised, sends no chapters, and plans from the extension's record. With nobody, no memory is sent.

**Call order.** On a shared connection profile, the observer goes ahead of planning, tracking and check calls that have not started, so the next turn's notes are never held back by background work.

## Prompt placement

| Block | Where |
| --- | --- |
| `<story_context>` | Before the chat history |
| `<director_notes>` | Depth 1 as a system message, just before your latest message. In the system prompt for Claude and Gemini, which would otherwise merge it with your message |
| Lore triggers | A scan-only prompt: World Info reads it, the model never sees it |

For impersonate and quiet generations all three are removed and restored afterwards.

## Without the extension

The card narrates as a plain narrator. No flag is set, so every craft entry stays empty, and nothing in the card depends on the notes being present. The preset reads as mature.
