# Playing

## Solo

1. Open a chat with the Narrator card.
2. Put the story's cast and world where SillyTavern can find them: a lorebook, the scenario, or your persona description.
3. Say where the story opens, or run `/director opening` to choose from three premises and have an opening drafted as a swipe of the first message.

The story's goal is your character's. The director builds it from your first message (what your character sets out to do), inside the world your cards, scenario and lorebook set up. Without a card, scenario or lorebook premise, the story profile waits for that first message, because your persona describes who your character is, not the story. Change the goal later on the Plan tab, redraft it with `/director spine`, or steer with `/director <text>`.

A solo Narrator chat cannot see other character cards. For a cast of cards, use a group.

## Group

1. Create a group with the Narrator card and your character cards.
2. Open the group chat and run `/director setup`.

`/director setup` mutes every cast card so that only the narrator speaks. Run it again after adding a member.

What happens to a cast card:

| Card field | Up to 4 cast cards | 5 or more |
| --- | --- | --- |
| Description, personality | Sent in full by SillyTavern | Full text for characters in the scene, a short profile for the rest |
| Scenario | Sent | Used once, to draft the story profile |
| Example dialogues | Sent | Not sent |
| First message | Posted, then hidden from the prompt | Same |
| Bound lorebook | Loaded by the director | Same |

Cast cards are never edited. The threshold is **Largest cast sent in full** in the extension settings.

Recommended group settings:

| Setting | Value |
| --- | --- |
| Group reply strategy | Natural order |
| Group generation handling mode | Leave it; the director sets it |
| Join prefix | `[{{char}}: <FIELDNAME>]` and a line break |
| Allow self responses | Off |
| Auto Mode | Off |

The join prefix labels each card's text with its owner, which keeps traits from drifting between characters.

## Only with the Narrator card

The director runs only when the Narrator card is in the chat: a chat with the Narrator alone, or a group with the Narrator and your cards. Playing any other card on its own, or in a group without the Narrator, leaves the director off. `/director off` pauses it for one Narrator chat and `/director on` resumes it there.

## The story profile

At the start of a chat the director reads your material and drafts a profile: genre, register, point of view, tempo, stakes, lethality, promises and things to avoid. A toast tells you when it is ready.

Review it in the inspector's **Story** tab. Edit and save, or leave it: it counts as accepted once you start playing. `/director profile` drafts it again.

Choose a primary genre and enter up to three secondary genres in **Also**, separated by commas. For example, use **Romance** as the primary genre and **Mystery, Smut** as secondary genres. Director recognizes **Smut** as **Erotica**. The same profile works with either preset.

## Content presets

Select a companion preset in **AI Response Configuration**.

- **Narrator Companion (PG)** uses a general-audience tone, with non-graphic violence and implied intimacy.
- **Narrator Companion (Mature)** allows NSFW and NSFL material where it fits the story. The selected model decides the level of detail.

Both presets use the story's existing genre mix, stakes and lethality. Content settings are in the preset.

## Talking to the director

`/director` speaks to the director without breaking the scene. The inspector's input box does the same.

| You want to | Type |
| --- | --- |
| Give a direction | `/director make the next scene quieter` |
| Change the scene | `/director scene: location=the docks; mood=tense; present=Ji Si, Hale` |
| Queue what comes next | `/director beats: a rival appears; the storm breaks` |
| Recheck the current queue against the scene and selected story memory | `/director checkplan` |
| Redo the last reply | `/director rewrite: less dialogue` |
| Undo something that happened | `/director retcon: the letter was burned` |
| Choose the next beat yourself | `/director suggest` (shows the plan) |

Typing `(OOC: retcon the letter was burned)` in chat does the same as the retcon command, and the message is then hidden from the prompt.

All commands: [Reference](reference.md#commands).

## The inspector

Open it with `/director inspect` or from the wand menu.

![The inspector's Now tab](images/inspector-now.png)

It has seven tabs. Each shows everything it holds at once. Nothing is folded away, nothing waits behind a tooltip, and there is no raw JSON to edit. Between them the tabs show everything the director knows; nothing is kept out of sight.

| Tab | Shows | You can |
| --- | --- | --- |
| Now | Director on or off for this chat, rating, progress, where the notes are placed, the notes sent with the last turn, the notes as they would be sent now, the block sent before the chat history | Switch the director or the rating, re-plan, draft an opening, choose the next beat, retry failed calls, mute a group's cast |
| Scene | Location, time, mood, initiative, who is present | Change any of them. Tick who is here; add a name |
| Cast | Each character: stage, feelings toward you, abilities, conditions, a short description, gender, race, age group and appearance (anchors taken from the card once and never changed by the story; race is human unless the card says otherwise; age group is child, teen, young adult, adult, middle-aged or elderly, judged by how the card describes them; sent to the narrator while they are in the scene), temperament, how they act at each level of regard, what they do unprompted, how they stand toward others, false beliefs, what they witnessed | Edit and save one character at a time. The people icon at the end of a character's name line locks them as main cast: they always stay in the cast, the planner keeps them central, and the notes always give their full line. The pen icon next to the name renames them (renaming onto someone already in the cast joins the two). Remove someone who was only passing by; facts about them stay, and a later reply does not bring the old name back |
| Story | The story profile, including which abilities matter and whether you have accepted it; the premise | Edit, save, or draft the profile again |
| Plan | The story spine first: the setup's question, its possible endings with their progress (like a victory screen: all stay open, none is chosen for you), the arc milestones with their checklists (☐ open, ✔ met, ✘ failed, in any order), concluded milestones as their conclusion only, whether you are building, drifting or turning away and the readings behind it, and a proposed new ending when you have turned from every one. Then when and why it was last planned; the arc with its forces, payoff, things to plant and endings; each beat with its condition, scene, lore keys, clues and how it has fared; each scene; beats already played | Edit all of it, the spine included: question, endings, milestones, criteria and their marks, conclusions; conclude a milestone now; accept or keep a proposed ending; add and remove beats and scenes; re-plan. This tab shows where the story may go |
| Record | Five parts, chosen by the row of buttons at the top. **What has happened**: world facts, then cast knowledge grouped under each character (a fact goes under the first cast member it names), each with its turn, who saw it and the quote; things undone. **Rumours**: world hearsay and cast rumours, grouped the same way. **Threads**. **Turn summaries**: the aggregate summary, older turns not rolled up yet as one block, and the latest 20 one by one. **Living lore**: lore the story has added, with earlier versions, and what is waiting to recur | Undo a fact; mark it secret with the spy icon (lit means secret: characters in the scene who did not see it are played as not knowing); confirm or remove a rumour, resolve a thread, edit the aggregate summary |
| Log | Director errors, corrections sent, refused changes, each module's last call, the chat variables cards and lore can read, and the director's whole state | Retry failed calls; choose a module to read what it was sent and answered |

![The inspector's Scene tab](images/inspector-scene.png)

Typing in a form marks the tab as having unsaved changes. The inspector will not redraw over them, and asks before you leave the tab.

Changes are saved on the latest message. They follow branches and survive swipes. The narrator is told once that the record was corrected, without hearing about the tool.

## With a memory extension

If BaiBai Book (or Summarize, or another memory extension) runs beside the director, set **Who keeps the story's memory** to **Another extension**. That extension then feeds the narrator the story so far; the director sends only its one-line summary of each of the last 2 turns that extension has not summarised yet, and no chapters. The director plans from that extension's record and keeps everything else: facts, scene, cast, threads, the spine and lore.

- BaiBai Book summarises a reply only after later replies arrive. The director's own one-line summary of the last 2 replies covers that, so a fresh chat plans fine.
- Replies BaiBai Book has already hidden before you turned the director on are never read by the director.
- BaiBai's timestamp tags and BaiBai Image's image blocks are removed before the director reads a reply (**Tags to remove before reading**). Add any other extension's tags there.
- The spine tracker's first check comes once enough replies written after the spine was drafted have been answered: around the sixth turn with the default of 4. "Check the spine now" checks at once.

## When something looks wrong

1. Open **Now**. If the notes told the narrator to do it, the fault is the director's.
2. Open **Log** and choose **Observer**. Its answer shows what the director's model recorded from the reply before.
3. Still in **Log**, read the refused changes. Each names its reason.

Then see [Troubleshooting](troubleshooting.md).
