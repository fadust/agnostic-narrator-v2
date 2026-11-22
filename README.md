# Agnostic Narrator

A genre- and content-agnostic storytelling toolkit for SillyTavern. The **Narrator card** gives the narrator its role and genre guidance. The **Director extension** keeps the record, plans ahead and sends one short note per turn. The **selected preset** supplies the content guidance.

Needs SillyTavern 1.19.0 or later. The card uses the macro engine for genre guidance.

## What you get

- **One narrator for any story.** The narrator has no house style: genre, voice and pace come from your cards and lore.
- **A record that follows the chat.** Swipe, edit, delete or branch, and the director's state follows, because it is rebuilt from the chat's own messages.
- **Facts with evidence.** A change is recorded only if the director can quote the narrator's reply for it.
- **Planning without railroading.** The narrator sees one opening with a condition, never the plan, and your message always comes first.
- **A story spine.** The question your setup poses, its possible endings and the milestones on the way. All endings stay open; the director tracks which way the story leans.
- **Characters who remember what you did.** Feelings move with deeds, not words. Each character keeps wants of their own. A person known only by a role ("the hall master") becomes a character once they speak, and keeps the role as another name when their own name comes out.
- **Your own character, profiled from your persona and your lorebook entry.** An S-class fighter written in lore is not treated as an ordinary person.
- **Settled stays settled.** When you answer something for good, or have had enough of it, the director stops pressing it (`/director settle`). `/director redraft` rebuilds the arc and spine from where the story stands.
- **Failures you can see.** If a part of the director fails, you get a toast saying what failed and what to do. A dot appears on the Director menu entry, and a banner with Retry appears in the inspector. Another toast tells you when it works again.
- **An inspector.** Seven plain tabs with forms: see and change the scene, the cast, the story profile, the plan and the record, and read what each director call was sent and answered.

## Quick start

1. Install the extension in one of two ways:
   - **Lean:** open the V2 release ZIP and put its `narrator-director` folder in `SillyTavern/public/scripts/extensions/third-party/`.
   - **From the repository:** in **Extensions → Install extension**, paste `https://github.com/fadust/agnostic-narrator-v2` to install the currently published source.
2. Import `Narrator.card.json` as a character, and allow its regex scripts when asked.
3. Import both [companion presets](#presets-and-genres). Choose one in **AI Response Configuration**.
4. Optional: import `Narrator Director.quickreplies.json` for buttons.
5. Open a chat with the Narrator and say where the story begins.

For a cast of character cards, make a group with the Narrator and run `/director setup`.

The director can use its own connection profile, a cheaper or faster model than the narrator's. Choose one in **Extensions → Narrator Director**. Without one, it shares the narrator's connection. Full steps: [docs/installation.md](docs/installation.md).

## Presets and genres

| Preset | Content guidance |
| --- | --- |
| [Narrator Companion (PG)](dist/Narrator%20Companion%20%28PG%29.preset.json) | General-audience tone with non-graphic violence and implied intimacy. |
| [Narrator Companion (Mature)](dist/Narrator%20Companion%20%28Mature%29.preset.json) | Allows NSFW and NSFL material where it fits the story. The selected model determines the level of detail. |

In **Director → Story**, set one primary genre and enter up to three secondary genres in **Also**, separated by commas. For example, choose **Romance** with **Mystery, Smut, Drama**. The Director saves `Smut` as `Erotica`. You can switch between PG and Mature while keeping the same genre mix and story stakes.

## Talking to the director

A few commands you will use most (all of them: [docs/reference.md](docs/reference.md)):

| Command | What it does |
| --- | --- |
| `/director inspect` | Open the inspector |
| `/director <words>` | A direction for the story, for example `/director a storm is coming` |
| `/director settle <text>` | Close a matter for good: no one presses it again |
| `/director redraft` | A fresh arc and spine from where the story stands |
| `/director retcon: <text>` | Undo a fact. Use `!` to confirm a broad match |
| `/director retry` | Try failed director calls again now |

## Cost

On a 47-turn test chat the director made about 2.3 calls per turn, or 4 to 5 on a turn that plans. The calls are spread over the observer, spine tracker, planner, profiles and clean-ups. A cheap model on the director's own profile keeps this low. The companion presets cap replies at 1,500 tokens; the target is about 500, and up to 1,000 for action.

## Documentation

| Document | For |
| --- | --- |
| [Installation](docs/installation.md) | Installing, choosing models and temperatures, updating, removing |
| [Playing](docs/playing.md) | Solo and group play, content presets, talking to the director, and the inspector |
| [Reference](docs/reference.md) | Every command, setting, note line, variable and file |
| [Active rules](docs/rules.md) | The exact rules each model is given. Generated from source |
| [How it works](docs/how-it-works.md) | The design: records, replay, the turn, the notes, lore, planning |
| [Director map](docs/director-map.md) | Modules, one pass step by step, what the narrator gets each turn |
| [Troubleshooting](docs/troubleshooting.md) | Symptoms, causes and fixes |
| [Development](docs/development.md) | Layout, tests, the fixture suite, changing rules |
| [Integration notes](docs/integration-notes.md) | Working alongside other extensions: findings, and what is planned |
| [Audits](docs/package-audit-2026-11-22.md) | The latest whole-package audit and what was fixed |
| [Changelog](CHANGELOG.md) | What changed, newest first |

## What is in the box

| Part | Path | Purpose |
| --- | --- | --- |
| Director extension | repo root (`manifest.json`, `index.js`, `core/`, `st/`) | Record, memory, continuity, story spine, planning, notes, dynamic lore, inspector, `/director` |
| Narrator card | `dist/Narrator.card.json` | Identity and rules, genre craft entries, regex scripts that strip leaked notes |
| Companion presets | `dist/Narrator Companion (Mature).preset.json`, `dist/Narrator Companion (PG).preset.json` | Content stance and prose craft, one file per rating |
| Quick replies | `dist/Narrator Director.quickreplies.json` | Buttons for common commands |
| Fixture suite | `fixtures/`, `tools/fixtures.mjs` | Tests a director model before you rely on it |

## Status

The current candidate is `0.3.0-rc.3`. It includes the quoted Director note cleanup, cast relationship history and updated dialogue instructions. See the [change catalog](CHANGELOG.md) and the [V2 verification record](docs/v2-verification.md).

## Licence

[MIT](LICENSE). Free to use, change, share and build on, including commercially. The only condition is that the copyright and licence notice stay with copies of the code.
