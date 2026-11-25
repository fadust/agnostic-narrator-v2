# Integration notes

Notes on working alongside other extensions. "Built" was tried live; the findings further down come from reading each extension's source.

Read on 17 November 2026: BaiBai Book 1.3.5, BaiBai Image 0.5.9, Group Greetings 1.0.0, ST-Copilot 2.7.5.

## Built

Both items below were built on 18 November 2026 and tried in a SillyTavern 1.19.0 trial install with BaiBai Book, BaiBai Image, Inkwell, Copilot, Guided Generations, Group Greetings and WorldInfoInfo running.

### 1. Other memory extensions

**Setting: Who keeps the story's memory.**

| Choice | The narrator gets | The planner reads | The director keeps |
| --- | --- | --- | --- |
| The director (default) | Its summaries, roll-up and "Chapters so far" | Its own summaries | Everything |
| Another extension | That extension's record, plus the director's one-line summaries of the last 2 turns; no chapters | That extension's record, plus the director's one-line summaries of the last 2 replies | Everything except turn summaries beyond the last 2: facts, scene, cast, threads, spine, lore |
| Nobody | No memory | The last 2 replies' lines only | Same as above |

- **Connectors** (`st/providers.js`) include BaiBai Book, SillyTavern Summarize and a configured macro. The selected provider supplies planning, `/director checkplan` and spine drafts. An optional synchronous `gaps()` reports unsummarized reply indices. Return `[]` for full coverage or `null` when coverage is unknown. [Provider contract](reference.md#memory-providers)
- **BaiBai Book** supplies its own layered history through `STBaiBaiBook.getHistory`. For the Observer and spine tracker, the Director asks for `getHistory({ before })` at the reply or batch’s exclusive cutoff. It passes a bounded excerpt and requires a separate confirmation for memory-only facts and criterion marks. Registered providers can opt in to the same historical contract. [rc.6 verification](v2-verification.md)
- **BaiBai runs behind.** It writes a reply's summary only after later replies; in the trial `coverage.missingAiFloors` listed exactly the two newest replies. Those are covered by the director's last-2 lines and are not reported as gaps. An older reply with no summary is reported to the planner as a gap; if it has also been hidden from the prompt, its text is quoted, shortened.
- **Missing, failing or slower than 5 seconds:** the planner works from the last-2 lines and the other records. Present but empty (a new chat): the planner is told there is no record yet.
- **Tags removed before reading:** `bbs_start, bbs_end, bbs_items, bbs_vars, bbi_image` by default. Each element goes whole, content included; the message itself is unchanged. Records read before the list changed still count. The director then judges story time from the prose, not BaiBai's timestamp.
- **Card line:** tags or blocks that another instruction asks for around the prose are allowed.
- The director keeps its own `location` and `time`: scene boundaries for the spine depend on them.

### 2. Group Greetings

The director's greeting handler steps aside when the event already carries a chosen greeting. Group Greetings loads first (loading order 10, the director 50) and reads the same card field, `group_only_greetings`. Tried with the real extension: over ten events with two greetings its random choice came through both ways; before, the director always forced the first.

## Considered, not decided

| Idea | For | Notes |
| --- | --- | --- |
| Read BaiBai Book's inventory and story time into the notes | BaiBai Book | Declined 18 Nov 2026: the other extensions read the rendered story directly |
| "Illustrate this scene" button | BaiBai Image | Declined 18 Nov 2026: BaiBai Image captures the scene its own way |
| "Copy the story record" button | ST-Copilot | Declined 18 Nov 2026 |

## Findings by extension

### BaiBai Book

A memory engine. With auto-summary on it:

- hides older messages and sends its summaries in their place
- sends a block of tracked state (time, location, characters, items) just before the latest messages, where the director's notes also go
- tells the narrator to wrap each reply in `<bbs_start>` and `<bbs_end>` time tags
- makes its own model call after each reply
- has its own generate interceptor, which runs after the director's

It offers a read-only public interface (`globalThis.STBaiBaiBook`), a slash command and macros. Reading works whether or not its engine is switched on.

Until item 1 is built: either turn its engine off in narrator chats, or accept duplicated summaries.

### BaiBai Image

Illustrates scenes. Independent of the director: it keeps its data per swipe in the message's own extra field, plans prompts with its own model call, and adds nothing to the narrator's prompt.

When it edits a message's text, the director sees the reply as changed and reads it once more. One extra director call; nothing else.

### Group Greetings

Adds group-only greetings to cards, with an editor and a random or user-pick mode. The director already opens a group with the narrator card's group greeting, so the extension is not needed. Its editor is the one reason to install it. See item 2.

### ST-Copilot

An out-of-character assistant in its own window, on its own connection profile. It adds nothing to the narrator's prompt.

- Its lorebook manager must not be used on `Narrator dynamic lore`, `Narrator baseline` or `Narrator baseline (director)`. They are mirror files; the director rewrites the first and ignores edits to both.
- Its character editor can rewrite cast cards. The director re-profiles a changed card on its own.
- A workable pairing: brainstorm in Copilot, then hand chosen ideas to the director with `/director beats: …`.

### The lorebook warnings

- "Valid World Info file name is required": none of these four raises it; the mirror files remove it regardless.
- "Valid UID is required" (found 18 Nov 2026): **WorldInfoInfo** looks every active entry up by book name and uid. An earlier "Import Card Lore" had left a file called `Narrator baseline` with the card's old 16 entries, which the director does not own and never overwrites, so the three newer entries (16–18) could not be found. The director now files the card's entries in its own `Narrator baseline (director)` when a file of that name exists that it did not write, and keeps its own files in step with the card.
