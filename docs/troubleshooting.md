# Troubleshooting

Start with the inspector (`/director inspect`). **Now** shows what the narrator was told. **Log** shows what the director's models answered, what was refused and why, and any errors.

## Setup

| Symptom | Cause | Fix |
| --- | --- | --- |
| No Narrator Director panel under Extensions | The folder is misplaced or nested one level too deep | `manifest.json` must be directly inside `third-party/narrator-director/` |
| `/director checkplan` is missing from autocomplete help | The tab or installed extension may be older than rc.6 | Check the installed version, update the extension if needed, and reload SillyTavern. [Installation](installation.md) |
| Inspector says `inactive` | The open chat has no Narrator card | Open a chat with the Narrator card, or add it to a group with your cards. Another card is never used as narrator |
| No story profile is drafted | The director call failed, or there is no material to read | Check **Log**. Add a scenario, persona or cast, then `/director profile` |
| Director errors in **Log** | The director's profile cannot reach its model | Fix the profile, then `/director retry` |
| Replies cut off mid-sentence | The model may hit its answer limit | Check **Response length** and the provider limit. The companion presets set 1,500 tokens |
| The narrator forgets recent events | The history may have fallen outside the model's usable context | Check the provider's context window and your memory settings. The companion presets request up to 200,000 tokens |

## The narrator

| Symptom | Cause | Fix |
| --- | --- | --- |
| A character vanished from the scene | The record lost them | Tick them on the **Scene** tab. If it recurs, check the observer's answer in **Log** |
| A character who left is still treated as present | Presence is additive and the narration never showed them leaving | Untick them on the **Scene** tab |
| She keeps steering to the same thing | An intent has not landed; it retires after five turns | `/director replan`, or raise the planner cadence, or set it to 0 |
| She ignores the notes | The narrator model is not weighing them, often with a very large context | Lower the context size; shorten the preset |
| She mentions the notes or a director | A leak. It is stripped from the saved reply | If it shows, check that the card's regex scripts are allowed |
| She answers the notes as if you wrote them | The notes merged with your message | Set **Where the notes go** to **In the system prompt** |
| She writes your character's actions | A narrator-model habit | Edit the reply; the rule is in the card. A stronger narrator model helps most |
| Intimacy is implied | The selected preset or model may prefer implication | Check the active preset in **AI Response Configuration**. Mature permits explicit detail where the model supports it |
| A gentle story turns deadly | The story profile has high lethality | Check **Lethality** on the **Story** tab |

## The record

| Symptom | Cause | Fix |
| --- | --- | --- |
| Few facts are recorded | The director's model paraphrases its quotes, so they are rejected | Check the share of refused changes on the **Now** tab. Above about one in ten, use a different director model |
| Relationships never change | Names were not recognised, or the model proposes none | Check the refused changes in **Log** |
| A wrong fact is on record | The observer misread | Press **Undo** beside it on the **Record** tab |
| A retcon removed too much or too little | Matching is by text | The toast lists what was removed. For precision, use **Undo** on the **Record** tab |
| The notes say "one reply behind" | You sent before the director finished reading | Nothing; it catches up. If constant, use a faster director model |
| Summaries never appear | No message has left the prompt yet | Nothing. With a large context this takes hundreds of turns |

## Other extensions

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Valid World Info file name is required" | Another extension looks the director's lore up by book name | Fixed by the mirror files. If it persists, expand the console warning and read its `file` value |
| Each lore entry is sent twice | `Narrator baseline` or `Narrator dynamic lore` was activated | Deactivate them. The director loads its entries itself |
| A group stays in swap mode after removing the extension | Removal cannot run code | Reinstall and run `/director off`, or set the mode by hand |

## Reporting a problem

Three things identify nearly every fault:

1. The notes from the **Now** tab.
2. The observer's answer from the **Log** tab.
3. The reply that looked wrong, with the narrator's reasoning if the model shows it.

`/director dump` gives the full state if more is needed.
