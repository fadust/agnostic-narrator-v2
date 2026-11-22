# Installation

## Requirements

- SillyTavern 1.19.0 or later.
- A chat-completion connection for the narrator. Text-completion backends follow the same code paths but have not been tried.
- Nothing else. Tavern Helper and Group Greetings are not needed.

## 1. Install the extension

1. To install the currently published V2 source, open **Extensions → Install extension** in SillyTavern and enter `https://github.com/fadust/agnostic-narrator-v2`.

   Or by hand: download the release zip and copy its `narrator-director` folder to `SillyTavern/public/scripts/extensions/third-party/`. `manifest.json` must sit directly in that folder.
2. Reload SillyTavern.
3. Open **Extensions**. A **Narrator Director** panel should be listed.

The card, preset and quick replies are not installed by the extension: download them from the release page or the `dist/` folder and import them as below.

## 2. Import the narrator card

1. Import `dist/Narrator.card.json` as a character.
2. Allow its embedded regex scripts when asked. They remove leaked director notes from replies.
3. The embedded lorebook prompt can be answered either way. The director loads the card's craft entries whether or not you import them.

## 3. Import the companion preset

1. In the chat-completion preset panel, import `dist/Narrator Companion (Mature).preset.json` and `dist/Narrator Companion (PG).preset.json`, and select the one for your story's rating. Mature is the default; a story you make PG with `/director pg` wants the PG preset, and the director says so if the wrong one is selected.
2. Check the three values it sets:

   | Setting | Value | Change it when |
   | --- | --- | --- |
   | Context size | 200,000 | Your model's window is smaller, or you want the full window of a 1M model |
   | Unlocked context size | On | Never; it lets the slider reach the value above |
   | Response length | 1,200 | You change the length rules in the preset |

The preset is optional. The director works with any preset, but only this one switches its content sections with the story's rating.

## 4. Give the director its own model

The director reads every reply and must copy quotes exactly, so it wants a steady model, not a creative one.

1. In **API Connections**, set up the director's model.
2. Save the connection as a **Connection Profile**.
3. Under **Extensions → Narrator Director → Director's model**, choose that profile as **Connection profile**.
4. Switch your main connection back to the narrator's model.

**Temperature.** The director sets its own, so it does not matter what the profile's preset says:

| Work | Modules | Temperature |
| --- | --- | --- |
| Record keeping | Observer, summariser, story profile, character profiles | 0.2 |
| Planning | Planner, opening | 0.7 |

Record keeping is low because quotes must be copied exactly. Both values are in the extension settings, under **Director's model**.

If a model refuses a temperature (some reasoning models accept only their default), the director stops sending one to that profile for the session. To turn it off yourself, untick **Set the temperature for director calls**.

This applies when a connection profile is chosen. With none, the director uses your current connection and its sampler settings.

To give the planner a different model, choose a profile for it in the same section.

**Size.** Each director call sends one reply and a short slice of state: a few thousand tokens. A small, fast model keeps the director ahead of you. It does not need a large context window.

With no profile chosen, the director uses your current connection. That works, but it shares the narrator's sampler settings.

## 5. Optional: quick replies

Under **Extensions → Quick Reply**, import `dist/Narrator Director.quickreplies.json` and enable the set.

## 6. Check that it works

1. Open a chat with the Narrator card.
2. Run `/director inspect`. The header reads `narrator: Narrator`.
3. A toast reports that a story profile was drafted.
4. Send a message. The **Now** tab shows the notes that went with it.
5. After the reply, the **Log** tab shows what the observer was sent and what it answered.

If any step fails, see [Troubleshooting](troubleshooting.md).

## Updating

Most updates change the extension, and some change the card or preset. The changelog says which.

| Changed | Do this |
| --- | --- |
| Extension | Replace the `narrator-director` folder and reload |
| Card | Re-import `dist/Narrator.card.json`, replacing the old card |
| Preset | Import `Narrator Companion (Mature)` and `Narrator Companion (PG)` (they replace the single `Narrator Companion` preset of 0.2.1 and earlier) and select the one for the story's rating |

Director migrates older record layouts when a chat opens. V2 migration was checked with saved fixture chats.

## Removing

1. In each narrator group, run `/director off` to restore the original generation mode and mute settings that Director changed.
2. Delete the `narrator-director` folder.
3. Optionally delete the two lorebook files the director created: `Narrator baseline` and `Narrator dynamic lore`.

The card keeps working as a plain narrator without the extension. Chat variables beginning `nar_` stay in old chats and are harmless.
