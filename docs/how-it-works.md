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

Two kinds of data sit on a message:

- **Bound to the active reply**, in `extra.narrator`: the observer's reading and director operations that rest on the current story, such as a plan. SillyTavern still keeps its swipe text.
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

- **The quote.** Each item carries a passage copied from the reply. Code looks for it, after stripping markup and punctuation. No match, no item.
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
- **A second check before "met".** When a tracker batch would mark criteria met, one cheap call on the tracker's profile sees each criterion, its quote, the text around it and the speaker, and confirms or rejects. A rejected mark is refused and the criterion stays open. If the check fails, the marks stand.
- **Skipped milestones.** When a later milestone concludes while an earlier one is open, the earlier one is skipped: no conclusion, no chapter, and it leaves the tracker and planner. It can be reopened on the Plan tab.
- **Milestones conclude** when every criterion is met or failed, or on "Conclude now". A short conclusion is written from the marks and quotes, and the checklist is dropped. The conclusion is logged on the reply that resolved the milestone, so swiping that reply reopens it.
- **State is judged per scene,** never by counting replies. A scene ends when the place changes or the planner's scene runs out of beats; a re-plan never ends one by itself, so a drifting stretch cannot set off a re-plan on every reply. Anything built toward an ending or milestone in the scene means building; a scene that closes with nothing built means drifting (but not while some of its replies still wait for the tracker); a quoted "against" turns that ending away. Drifting, a failed ending criterion, and turning from every ending each ask the planner for a new plan.
- **The narrator never sees the spine,** only the current beat's intent, and the conclusions of milestones that have concluded, as "Chapters so far".

## Fact, plan and belief

| Kind | Holds | Reaches the narrator as |
| --- | --- | --- |
| Canon | What the narration stated, with quotes | Cast lines, `watch`, summaries, lore |
| Unconfirmed | What was hinted or rumoured, and off-screen outcomes | Nothing, until narration confirms it |
| Plan | Beats that might happen | One `scene_intent` at a time |
| Spine | Endings and milestones with their checklists | Only concluded milestones, as "Chapters so far" |
| Belief | What a character thinks, true or not | `watch` |

They are kept apart so that a plan can never be mistaken for a fact.

## Presence

The list of who is in the scene only grows by the observer's word. A character leaves by a quoted departure or death, or when the scene moves to a different place. A model that lists only who spoke cannot make a silent character vanish.

## Abilities and relationships

Each character has seven attributes on a private scale and four relationship axes toward the player. Neither is rolled, and no number reaches the narrator. Before each turn code turns them into words:

- a relationship **band** (hostile, wary, neutral, warm, devoted) and that character's own behaviour at that band
- one phrase per stand-out ability
- a comparison when you act against someone
- an **attempt tier** when the verb, the opponent and both sets of abilities are unambiguous

A missing tier is a safe failure: the narrator judges from the cast lines. A wrong tier is not safe, so the bar for sending one is high.

## Planning

The planner keeps a short horizon: up to three scenes and six beats. The plan is a ride the player may jump on or not. Each beat has a **goal** (what counts as it landing, seen by the planner and the observer) and a **pressure** (an opening the world offers, which is all the narrator sees). A beat may slip to a later scene and says how it reaches the player wherever they are. Plans follow the story profile and never fight it.

The planner runs when the openings run out or threads run low, when you go off-plan, when the scene stalls (N replies recording nothing new), when the spine says you are drifting, and when you ask. Timed re-plans are off by default.

**Plan check.** Code flags each new plan: beats that script the player, copy a spine criterion into the opening, offer a "choice" with no choice, clash with a known name, rest on a time already past, or fight the genre (its avoid list, lethality or rating). Hollow choices are retyped and past times dropped in code. Only when something needs rewriting does one cheap call rewrite the flagged beats. A rewrite that still trips a flag is refused. If the rewrite fails, beats that script the player or fight the genre are dropped.

**Wants.** Every cast character may have up to three lasting, high-level wants: what they live for ("a happy family", "to amass a fortune", "to be loved", "keep the inn's silence"). They may support each other or pull against each other. The spine drafts them for the people the material names, rooted in their description, the lorebook and their place in the story; the planner gives them to others, a few per plan, and changes a character's wants only when the story transforms one (achieved, lost, betrayed), saying why. No trigger, no expiry, no observer check. The narrator sees them on the cast line while the character is present; short-term wants stay in the openings. While a character is away, the planner may move one of their wants off screen as an outcome, unconfirmed until narrated. They show and edit on the Cast tab; a character whose wants you clear is left without.

**Dormant threads.** A thread untouched for 12 turns (a setting) leaves the planner's prompt until a reply names its people, place or key words again, or they are in the scene.

**Names already in use.** The block before the chat history lists the names the cast and the lorebook already use, so a new character never gets one of them.

**Patience.** An opening left untouched for N turns (3) is mentioned to the narrator once more as still there, never pressed, and retired two turns later (five if required). Going elsewhere starts the count again.

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
