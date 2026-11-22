# Reference

## Commands

All commands begin with `/director`. Anything that is not a keyword is a free-text direction.

| Command | Effect |
| --- | --- |
| `/director <text>` | A direction. It reaches the planner, and the narrator once as `player_request` |
| `/director inspect` | Open the inspector. `/director` alone does the same |
| `/director on` | Turn the director back on for a Narrator chat after `/director off`. Has no effect without the Narrator card |
| `/director off` | Turn the director off for this chat and restore the group mode and mute settings it changed |
| `/director setup` | In a group: mute the cast and apply the cast-size rule |
| `/director scene: location=…; time=…; mood=…; present=A, B` | Change the scene. Any subset of fields. Values end at a comma or semicolon; for a value with a comma, use the inspector's Scene tab |
| `/director beats: one; two` | Queue beats ahead of the plan, separated by semicolons |
| `/director rewrite: <instruction>` | Redo the latest reply as a new swipe, with the instruction |
| `/director retcon: <text>` | Remove facts containing the text, or closely matching it, and tell the narrator it did not happen |
| `/director pg` | Request a general-audience tone |
| `/director pg off` | Return this story to mature: explicit on, lethality high |
| `/director explicit on` / `off` | Within a mature story, write sex scenes or fade to black |
| `/director profile` | Draft the story profile again |
| `/director confirm` | Accept the story profile as it stands |
| `/director revise genre <instruction>` | Have the profile revised by instruction |
| `/director replan` | Force a re-plan |
| `/director suggest` | Choose which queued beat comes next. Shows the plan |
| `/director opening` | Offer three premises and draft an opening from the one you pick |
| `/director rollup` | Roll up summaries now |
| `/director spine` | Draft the story spine now, or redraft it from the setup (replaces the current one) |
| `/director track` | Check the spine against the replies waiting for the tracker, now, the newest included |
| `/director retry` | Retry failed director calls and clear their pause |
| `/director dump` | Return the full state as JSON |

## Settings

Under **Extensions → Narrator Director**.

| Setting | Default | Meaning |
| --- | --- | --- |
| Enabled | On | Master switch. The director is active only in chats with the Narrator card, alone or in a group with your cards |
| Connection profile | Current connection | The profile all director calls use |
| Observer, Spine tracker, Planner, Summariser, Story profile, Character profiles, Opening | Same as above | A separate profile for that module. The spine tracker runs only once a story has a spine. The observer and the spine tracker run side by side when they use different profiles; on the same profile they take turns |
| Set the temperature for director calls | On | Send the two temperatures below with calls made through a profile |
| Record keeping | 0.2 | Temperature for observer, summariser, story profile and character profiles |
| Planning | 0.7 | Temperature for planner and opening |
| Tries per reply | 2 | How many times the observer may fail on one reply before it is left for `/director retry` |
| Longest answer per module | Observer 1500, planner 3000, summariser 500, story profile 700, character profiles 700, opening 900 | Token limit for each module's answer |
| Where the notes go | Automatic | Where the notes go. Auto uses a `{{director_notes}}` preset entry if one is enabled; otherwise depth 1 as a system message, or the system prompt for Claude and Gemini |
| Content rating for new stories | Mature | Mature or PG |
| Other members' greetings | Hide | Hide them from the prompt, or keep them |
| Largest cast sent in full | 4 | Above this many cast cards the group swaps and the director sends the cast |
| Re-plan every N turns | 0 | 0 means on events only: the openings run out, you go elsewhere, the scene stalls, the story drifts, or you ask. A timed re-plan can replace an opening you were about to take |
| Nudge a waiting opening after N turns | 3 | An opening offered this many turns without being taken is mentioned once more as still there, never pressed. Retired two turns later (five if required). Going elsewhere starts the count again. 0 means never nudge |
| Let a thread sleep after N turns | 12 | An open thread untouched this long leaves the planner's view until a reply names its people, place or key words again, or they are in the scene. It stays on the Record tab. 0 means threads never sleep |
| Re-plan when nothing changes for N replies | 5 | Replies that record no fact, thread, person, place, clue or opening taken. The planner then brings one small opening to where you are. A recent direction asking for quiet holds it back. 0 turns it off |
| Who keeps the story's memory | The director | The director: it sends summaries and chapters. Another extension: that extension feeds the narrator the story so far; the director adds its summaries of those of the last 2 turns that extension has not summarised yet, and plans from that extension's record. Nobody: no memory is sent |
| Read the memory from | Automatic | With "Another extension": BaiBai Book, Summarize, or a macro. Automatic takes the first present |
| Macro to read | (empty) | With "A macro": its name without braces |
| Tags to remove before reading | `bbs_start, bbs_end, bbs_items, bbs_vars, bbi_image` | Other extensions' tags, removed whole before the director reads a reply. The message is not changed |
| Roll up summaries every N | 8 | Counted over summaries whose messages have left the prompt. Only when the director keeps the memory |
| Replies to read on an existing chat | 6 | How far back the director reads when first enabled on a chat |
| Check the spine every N replies | 4 | The spine tracker waits until this many replies you have answered are ready, then reads them in one call. "Check the spine now" or `/director track` checks at once |
| Clean up facts every N turns | 10 | Merges facts that say the same thing (the most current wins) and retires faded minor facts. A major fact is never removed. 0 turns off the timer only |
| Clean up early above N facts | 30 | The clean-up also runs when live facts have grown well past this count. 0 turns it off |
| Mentions before a lore entry | 2 | Accepted replies that must mention a person, place or thing |
| Keep lorebook files for the director's lore | On | Writes `Narrator baseline` (or `Narrator baseline (director)` when you already have a file of that name) and `Narrator dynamic lore` so other extensions can look entries up |
| Notes | 300 | Token cap. Lines are dropped, least important first, to fit |
| Block before the chat history | 1200 | Estimated token cap for story context. The Now tab reports when context was shortened to fit |

Every setting the extension reads has a control in this panel, and each control's explanation is printed beside it. There are no settings reachable only by editing a file.

## The notes

Each turn the narrator receives one block. Lines appear only when they have something to say.

```
<director_notes>
present: Ji Si, Captain Hale
location: the Houshan gatehouse
mood: uneasy calm
initiative: player (the scene waits on them)
spotlight: Captain Hale (little attention lately)
scene_intent: let the debt to the guild surface (only if: the player enters the city)
clue: a creditor's seal on the gate (found only through: place)
tension: rising
cast:
- Ji Si, toward Rowan: warm (teases instead of praising; stays close); serious arm wound
- Captain Hale, toward Rowan: wary (polite, closed, watches before answering); strong, hits hard
- Rowan: quick and hard to track
attempt: agility against Captain Hale is trivial for Rowan (succeeds easily)
</director_notes>
```

| Line | From | Meaning to the narrator |
| --- | --- | --- |
| `status` | Code | A remark about the notes, such as being one reply behind |
| `present`, `location`, `time`, `mood` | Record | The scene as last recorded. Not a cast list to enforce |
| `initiative` | Record | Whether the scene waits on the player or the world keeps moving |
| `spotlight` | Code | A present character with little recent attention |
| `scene_intent` | Plan | An opening the world offers, true now, with its condition. The player may take it or pass it by. One beat only; never the beat's goal |
| `waiting` | Code | The opening has gone untaken for N turns: let it be noticed once more, lightly. Sent once |
| `clue` | Plan | Something the player can find only by the named route |
| `tension` | Plan | How tight to hold the scene; "ease off" after two tense beats |
| `world_moves` | Plan | What happens next if the player does not step in. Only when initiative is the world's |
| `focus` | Plan | The feeling the spotlight character should carry |
| `cast` | Record | How each character stands toward the player and what they can do, in words. "wants": what that character is after (their agenda), never an action to perform |
| `exchange` | Code | How abilities compare for what the player is doing |
| `attempt` | Code | The outcome tier: trivial, a strain, risky, beyond. Sent only when unambiguous |
| `watch` | Record | What a present character does not know or wrongly believes |
| `correction` | Observer | A continuity fix. Sent once |
| `did_not_happen` | Player | Retconned facts, for eight turns |
| `note` | Player or planner | A change made outside the story, or an off-screen outcome. Sent once |
| `player_request` | Player | A direction given with `/director`. Sent once |

A second block, `<story_context>`, goes before the chat history: premise, story profile, the cast in swap mode, and summaries of messages that have left the prompt.

## Variables

Public state is written to chat variables after every change.

**Flags**, for `{{if .flag}}…{{/if}}`:

| Flag | Set when |
| --- | --- |
| `nar_active` | The director is active in this chat |
| `nar_genre_<label>` | For the dominant and each secondary genre, for example `nar_genre_slice_of_life` |
| `nar_lethality_<level>` | `none`, `low`, `real` or `high` |
| `nar_tempo_<level>` | `slow`, `measured`, `brisk` or `relentless` |
| `nar_tension_<level>` | `low`, `rising`, `high` or `peak` |
| `nar_explicit` | Explicit content is on |
| `nar_pg` | The story is rated PG |
| `nar_trust_<name>_<band>` | For each present character: `hostile`, `wary`, `neutral`, `warm` or `devoted` |
| `nar_trust_<name>_high`, `_low` | Warm or better; wary or worse |

**Values**, for `{{getvar::name}}`: `nar_genre`, `nar_mood`, `nar_location`.

**Object**, for Tavern Helper: `nar`, with `genre`, `secondary`, `register`, `pov`, `tempo`, `lethality`, `explicit`, `pg`, `mood`, `location`, `time`, `present`, `tension`, `trust`.

Names become lowercase with underscores: `Ji Si` is `ji_si`.

Never mirrored: beats, clues, the arc, beliefs, canon.

## Macro

`{{director_notes}}` returns the current notes. Put it in its own preset prompt entry to choose where they go; the director then stops placing them itself. The companion preset ships such an entry, disabled.

## Where data lives

| Data | Place |
| --- | --- |
| A message's stable id | `message.narrator_id` |
| Player and setup operations | `message.narrator_ops` |
| The observer's reading of the active reply and Director operations based on it | `message.extra.narrator`. Saved inactive swipes retain their prose and other extensions' metadata |
| Story profile and premise at chat start | `chat_metadata.narrator_director.setup` |
| Public variables | `chat_metadata.variables` |
| Extension settings | `extension_settings.narrator_director` |
| Mirrors of the director's lore | Lorebook files `Narrator baseline` and `Narrator dynamic lore` |

Nothing else is stored. State is rebuilt from the messages each time it is needed.

## Files

| Path | Contents |
| --- | --- |
| `index.js` | The only file that touches SillyTavern: events, prompts, World Info, groups, commands |
| `st/ui.js` | Settings panel and inspector |
| `core/state.js` | Records, reconciliation, replay |
| `core/validate.js` | Checks everything the observer proposes |
| `core/director.js` | The pipeline: observe, profile, plan, roll up |
| `core/brief.js` | Composes the notes and the story block |
| `core/social.js` | Turns abilities and relationships into words; attempt tiers |
| `core/planner.js` | Validates profiles, arcs and plans; the rating; re-plan triggers |
| `core/lore.js` | Derives the dynamic lorebook |
| `core/prompts.js` | Every prompt the director sends |
| `core/vars.js` | Public variables |
| `core/text.js`, `json.js`, `util.js`, `enums.js` | Quote matching and leak stripping, JSON recovery, helpers, allowed values |
| `card/src/description.md` | The narrator card's rules |
| `card/src/preset.md` | The companion preset's main prompt |
| `card/build.mjs` | Builds `dist/`; holds the craft entries |
