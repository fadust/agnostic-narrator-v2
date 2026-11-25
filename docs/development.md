# Development

## Layout

```
manifest.json       the SillyTavern extension sits at the repo root, so it installs from the GitHub URL
index.js            the only file that imports from SillyTavern
style.css
st/ui.js            settings panel and inspector
core/               plain ES modules with no SillyTavern imports; run in Node
card/               sources for everything in dist/
  src/description.md    the narrator card's rules
  src/preset.md         the companion preset's main prompt
  src/preset.base.json  preset settings other than the main prompt
  build.mjs             builds dist/; holds craft entries and greetings
dist/               built, importable JSON files and installation notes (committed)
fixtures/           cases for testing director models
tools/fixtures.mjs  fixture runner
tools/rules.mjs     writes docs/rules.md from source
tests/unit/         core tests (Node test runner)
tests/e2e/          checks against a real SillyTavern with a mock LLM
docs/               documentation
```

The split matters. Everything with a rule in it lives in `core/` and is tested in Node. `index.js` connects that core to SillyTavern's events, prompt slots and World Info, and holds as little logic as possible.

## Commands

```bash
npm test
```

```bash
npm run build
```

```bash
npm run docs
```

```bash
ST_DIR=/path/to/SillyTavern npm run e2e
```

| Command | Does | Needs |
| --- | --- | --- |
| `npm test` | Runs the unit tests | Node 20 or later |
| `npm run build` | Rebuilds `dist/` and `docs/rules.md` | Node |
| `npm run docs` | Rebuilds `docs/rules.md` only | Node |
| `npm run e2e` | Starts SillyTavern on a throwaway data folder with a mock LLM and runs the end-to-end checks | A SillyTavern checkout with `npm install` done, and Playwright with Chromium |

The end-to-end run copies SillyTavern and the extension's runtime files (`index.js`, `manifest.json`, `style.css`, `core/`, `st/`) into a disposable fixture. It takes a few minutes and removes the fixture afterward. `ND_PACKAGE_DIR` can point to an extracted installer with `narrator-director/` and the import files. Set `SHOTS_DIR` to save screenshots and `VERBOSE=1` for the browser console. [Current release verification](v2-verification.md)

## Changing a rule

The rules the models read live in four places:

| Rule | Edit | Then |
| --- | --- | --- |
| Narrator card | `card/src/description.md` | `npm run build`, re-import the card |
| Craft entries | `CRAFT` in `card/build.mjs` | `npm run build`, re-import the card |
| Companion preset | `card/src/preset.md` | `npm run build`, re-import the preset |
| Observer, planner and other director prompts | `core/prompts.js` | `npm run docs`, reload the extension |

`npm test` fails if `docs/rules.md` no longer matches the sources, so a rule cannot change without the document changing.

When a note line is added or renamed in `brief.js`, explain it in the card. An unexplained line makes the narrator guess.

## Adding a craft entry

1. Add a row to `CRAFT` in `card/build.mjs`: a flag, a name and the text.
2. For a genre, add the label to `GENRES` in `core/enums.js`, and any synonyms to `GENRE_ALIASES`. The flag is `nar_genre_` plus the label with underscores.
3. `npm run build` and re-import the card.

## The fixture suite

The fixtures send the extension's real prompts to a model and check the validated result. Use them to choose a director model and to test a prompt change.

```bash
node tools/fixtures.mjs --base-url http://127.0.0.1:5001/v1 --model your-model
```

| Option | Effect |
| --- | --- |
| `--base-url`, `--model` | Any OpenAI-compatible endpoint |
| `FIXTURE_API_KEY` | Environment variable for endpoints that need a key |
| `--only obs-` | Run fixtures whose id contains the text |
| `--runs 3` | Repeat each fixture |
| `--temperature 0.2` | Sampling temperature (default 0.2) |
| `--verbose` | Print the validated output of failures |
| `--print` | Print the prompts and call nothing |

**The bar:** 90% of fixtures pass, and none produces forbidden output.

A fixture has an input, expectations and forbidden results:

```json
{
  "id": "obs-attempt-is-not-outcome",
  "about": "The player declared a kill; the narration shows a miss. The attempt must not be recorded as fact.",
  "input": { "cast": ["Captain Hale"], "reply": "Your blade whistles through the space where…", "playerMessage": "I stab Captain Hale through the heart and kill him." },
  "expect": [{ "has": "facts", "matching": "miss|dodg|step|back" }],
  "forbid": [{ "has": "facts", "matching": "(Hale|captain) (is|was) (dead|killed)" }]
}
```

| Assertion | Holds when |
| --- | --- |
| `{ "has": section, "matching": regex }` | Some item in that section matches. `where` can require a certainty or a witness |
| `{ "path": path, "matching": regex }` | The value at that path matches |
| `{ "count": [section, min, max] }` | The section's length is in range |
| `{ "range": [path, min, max] }` | The number at that path is in range |
| `{ "maxRejected": n }` | At most n proposed changes were rejected |

Assertions run on the output after validation, so a fixture tests the model and the code together, as in play.

Twelve fixtures cover the observer and six cover the story profile, the planner and character profiles. Add one whenever play shows a fault in what a model recorded or planned.

## Tests

Unit tests build a small chat, drive the pipeline with a scripted model, and assert on replayed state. `tests/unit/helpers.mjs` has the doubles. Prefer a test that reproduces a reported symptom in the words the player would use.

End-to-end checks cover what only the real platform can show: prompt assembly and order, World Info, swipes, group chats, slash commands and macros in a preset.

Neither suite involves a real model. A fault in how a model reads a prompt shows up only in the fixture suite or in play.

## Platform notes

Findings from SillyTavern 1.19.0 that the code depends on:

- **Generate interceptors** run after the player's message is in the chat and before World Info scans. They do not run for dry runs.
- **`WORLDINFO_ENTRIES_LOADED`** exposes the entry lists before sorting, and the handler is awaited. The director adds entries there.
- **Extension prompt filters are ignored for in-chat injections** (an async predicate is passed to `Array.filter`). The director clears its prompts for impersonate and quiet generations instead.
- **`extra` is kept per swipe** and swapped on swipe. Top-level message keys are untouched and saved with the chat.
- **`group_only_greetings` is not read by core.** The director sets the narrator's group greeting through `CHARACTER_FIRST_MESSAGE_SELECTED`.
- **A group greeting cannot be suppressed.** Other members' greetings are hidden after they are posted.
- **A bound lorebook loads only for the generating member.** The director loads the muted cast's books.
- **`ConnectionManagerRequestService.sendRequest`** takes chat messages and applies the profile's own preset.

After updating SillyTavern, run the end-to-end checks.
