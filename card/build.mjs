// Builds the importable files in dist/ from the sources here and from the extension's own patterns,
// so the card's regex scripts and the director's leak stripping can never drift apart.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAK_PATTERNS } from '../core/text.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
const read = (p) => readFileSync(join(here, p), 'utf8').trim();
const POST_HISTORY = '{{original}}\n[Length: about 500 tokens. Up to 1,000 only for action shown blow by blow. A long player message does not need a longer reply. Open differently from your last few replies.]';

const NAME = 'Narrator';
const SOLO_OPENING = '*The page is blank, and the story is yours to open.*\n\nTell me where we begin: a place, a moment, something {{user}} is doing. Or simply act, and the world will answer.';
const GROUP_OPENING = '*The company is gathered and the story is ready to open.*\n\nTell me where we begin: a place, a moment, something {{user}} is doing. Or simply act, and the world will answer.';
// Macro-free prefixes the director uses to recognise these greetings as neutral (nothing to record).
const NEUTRAL = ['*The page is blank, and the story is yours to open.*', '*The company is gathered and the story is ready to open.*'];

// ---------------------------------------------------------------- genre craft (our own text)

const gate = (flag, text) => `{{if .${flag}}}${text}{{/if}}`;
const CRAFT = [
    ['nar_genre_fantasy', 'Fantasy', 'Fantasy craft: the world has rules older than the characters; magic, where it exists, has a cost and a texture, and is never a convenience. Let wonder arrive through concrete detail (a smell, a custom, a ruin) rather than explanation. Travel takes time and leaves marks. Keep the party distinct: each companion notices different things.'],
    ['nar_genre_slice_of_life', 'Slice of life', 'Slice-of-life craft: nothing needs to be at stake for a scene to matter. Stay with small things: food, weather, routines, what someone almost said. Do not invent danger, villains or twists. Let scenes breathe and end softly; progress is a relationship shifting by a degree or a small plan coming together.'],
    ['nar_genre_survival', 'Survival', 'Survival craft: scarcity is the antagonist. Keep supplies, shelter, injury, weather and daylight concrete and consistent from scene to scene. Choices cost something and consequences arrive on time, without cruelty and without rescue. Never soften a loss the story has earned, and never push the player toward one option.'],
    ['nar_genre_horror', 'Horror', 'Horror craft: dread comes from what is withheld. Show the wrong detail, not the monster; let ordinary things turn. Escalate slowly, and give quiet stretches so the next disturbance lands. Safety is always partial. Do not explain the threat fully, and do not release tension with jokes unless a character would.'],
    ['nar_genre_mystery', 'Mystery', 'Mystery craft: play fair. Every answer the story will give must be reachable from things the player can find. Present clues as plain observations, never as conclusions; witnesses have reasons to shade the truth. Do not solve anything for the player, and do not hide a clue behind a single door.'],
    ['nar_genre_romance', 'Romance', 'Romance craft: attraction lives in attention: who is noticed, remembered, waited for. Move by small, reversible steps and let each character want something of their own besides the other person. Keep tension in what is unsaid. Feelings follow the relationship as established; never leap ahead of it.'],
    ['nar_genre_science_fiction', 'Science fiction', 'Science-fiction craft: technology is lived-in and has limits, maintenance and politics. Keep it consistent once shown. Let ideas matter through what they do to people. Use precise, plain terms rather than invented jargon, and let scale (distance, time, systems) be felt.'],
    ['nar_genre_wuxia', 'Wuxia and cultivation', 'Wuxia craft: skill expresses character; a fight is an argument about who someone is. Reputation, debts, face and the bonds between master, disciple and sworn siblings carry as much weight as strength. Differences in power are real and visible. Keep the diction measured, with room for stillness before motion.'],
    ['nar_genre_comedy', 'Comedy', 'Comedy craft: humour comes from character and timing, not from the narrator winking. Let people be serious about absurd things. Set up, then pay off later. Keep stakes light but real to the characters, and never mock the player.'],
    ['nar_genre_drama', 'Drama', 'Drama craft: conflict is between people who each have a point. Let scenes turn on a decision or an admission. Subtext over statement; consequences persist. Give silence and small gestures as much room as speech.'],
    ['nar_genre_adventure', 'Adventure', 'Adventure craft: keep things moving through places worth seeing. Obstacles have more than one way past. Give victories a price and setbacks a way forward, and let each new place change what the travellers know or carry.'],
    ['nar_genre_erotica', 'Erotica', 'Erotica craft: character motives, choices and relationships shape the scene. How a scene changes a relationship can matter as much as the scene itself.'],
    ['nar_lethality_none', 'No lethality', 'In this story nobody dies and nothing irreparable happens on screen. Setbacks are social, emotional or practical.'],
    ['nar_lethality_high', 'High lethality', 'In this story death is possible for anyone, including people the player cares about, when the fiction calls for it. Signal danger clearly before it strikes, then let it strike. The player character dies only as the plain result of the player\'s own choice, after fair warning.'],
    ['nar_tempo_slow', 'Slow tempo', 'Tempo: slow. One scene, one beat. Linger on setting and small reactions; do not skip time unless the player does.'],
    ['nar_tempo_relentless', 'Relentless tempo', 'Tempo: relentless. Short paragraphs, events arriving on each other\'s heels, little time to rest. Cut scene-setting to a line.'],
    ['nar_tension_peak', 'Peak tension', 'The story is at its peak. Keep scenes tight and consequences immediate; hold back anything that would release the tension early, unless the notes ask you to ease off.'],
];

const bookEntries = CRAFT.map(([flag, name, text], i) => ({
    id: i,
    keys: [],
    secondary_keys: [],
    comment: `${name} (${flag})`,
    name,
    content: gate(flag, text),
    constant: true,
    selective: false,
    insertion_order: 100 + i,
    enabled: true,
    position: 'after_char',
    use_regex: false,
    extensions: {
        position: 1, exclude_recursion: true, prevent_recursion: true, probability: 100, useProbability: true, depth: 4,
        selectiveLogic: 0, group: '', group_override: false, group_weight: 100, display_index: i, role: 0,
        match_whole_words: null, case_sensitive: null, scan_depth: null, automation_id: '', vectorized: false,
        delay_until_recursion: false, sticky: 0, cooldown: 0, delay: 0,
    },
}));

// ---------------------------------------------------------------- regex scripts

let n = 0;
const script = (scriptName, p, extra = {}) => ({
    id: `nd-regex-${++n}`,
    scriptName,
    findRegex: `/${p.source}/${p.flags}`,
    replaceString: '',
    trimStrings: [],
    placement: [2, 6],          // AI output and reasoning
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
    ...extra,
});
const regexScripts = [
    // Permanent: alters the saved reply, so a leak cannot stay in history and teach the model to leak.
    ...LEAK_PATTERNS.map(p => script(`Narrator: strip ${p.name}`, p)),
    // Display: hides the text while it is still streaming in.
    ...LEAK_PATTERNS.map(p => script(`Narrator: hide ${p.name} (display)`, p, { markdownOnly: true })),
    // Prompt: cleans replies saved before the card was installed.
    ...LEAK_PATTERNS.map(p => script(`Narrator: clean ${p.name} (prompt)`, p, { promptOnly: true })),
];

// ---------------------------------------------------------------- the card (Character Card V3)

const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
        name: NAME,
        description: read('src/description.md'),
        personality: '',
        scenario: '',
        first_mes: SOLO_OPENING,
        mes_example: '',
        creator_notes: 'A genre-agnostic narrator. Works alone as a plain narrator; with the Narrator Director extension it keeps canon, plans beats and adapts to the story material. Solo: put the cast in a lorebook or the scenario. Group: add this card and the cast, then run /director setup so only the narrator speaks. Personality, scenario and examples are empty on purpose: the voice comes from your story, not from this card.',
        system_prompt: '',
        // After the chat history, where the model reads it last (owner, 22 Nov 2026: the only length rule sat at the top of
        // the preset and replies doubled to imitate long player posts). {{original}} keeps the preset's own post-history text.
        post_history_instructions: POST_HISTORY,
        alternate_greetings: [],
        group_only_greetings: [GROUP_OPENING],
        tags: ['narrator', 'storyteller', 'game master'],
        creator: 'fadust',
        character_version: '0.3.0-rc.2',
        extensions: {
            talkativeness: '1',
            fav: false,
            world: '',
            depth_prompt: { prompt: '', depth: 4, role: 'system' },
            narrator_director: { role: 'narrator', version: 1, neutral: NEUTRAL },
            regex_scripts: regexScripts,
        },
        character_book: {
            name: 'Narrator baseline',
            description: 'Genre craft for the narrator. Each entry is switched on by a flag the director sets; without the director every entry stays empty.',
            scan_depth: 2,
            token_budget: 800,
            recursive_scanning: false,
            extensions: {},
            entries: bookEntries,
        },
    },
};
writeFileSync(join(dist, 'Narrator.card.json'), JSON.stringify(card, null, 2));

// ---------------------------------------------------------------- companion preset (chat completion)

// The main prompt has one source with PG-gated sections. It is built into two presets, Mature and PG, with the gates
// resolved, so the preset says plainly which rating it is (owner, 22 Nov 2026: one preset that switched itself confused).
const PROSE = read('src/preset.md');

/** Resolve the build-time branches. The imported presets have no rating macros. */
function forRating(text, pg) {
    const out = text
        .replace(/\{\{if \.preset_pg\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, a, b) => (pg ? a : b))
        .replace(/\{\{if !\.preset_pg\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, a) => (pg ? '' : a));
    if (/preset_pg/.test(out)) throw new Error('preset.md: an unresolved PG gate is left');
    // PG has no section 7 (Adult Content): the sections after it move up one, and so do references to them.
    return pg ? out.replace(/^## (\d+)\./gm, (m, n) => (Number(n) > 7 ? `## ${n - 1}.` : m)).replace(/\bsection 8\b/g, 'section 7') : out;
}

function buildPreset(pg) {
const preset = JSON.parse(readFileSync(join(here, 'src/preset.base.json'), 'utf8'));
preset.prompts = preset.prompts.map(p => (p.identifier === 'main' ? { ...p, content: forRating(PROSE, pg) } : p));
preset.prompts.push({
    identifier: 'directorNotes',
    name: 'Director notes (optional manual placement)',
    system_prompt: false,
    marker: false,
    role: 'system',
    content: '{{director_notes}}',
    injection_position: 1,
    injection_depth: 1,
    forbid_overrides: false,
});
// Off by default: with the entry disabled the director places its notes itself, per backend
// (in chat at depth 1; in the system prompt for Claude and Gemini). Enable it only to choose the spot yourself.
for (const o of preset.prompt_order) o.order.push({ identifier: 'directorNotes', enabled: false });
preset.squash_system_messages = false;
return preset;
}
for (const [label, pg] of [['Mature', false], ['PG', true]]) writeFileSync(join(dist, `Narrator Companion (${label}).preset.json`), JSON.stringify(buildPreset(pg), null, 2));
// The single switching preset of 0.1-0.2.1 is gone; remove a stale copy so it is not shipped by mistake.
rmSync(join(dist, 'Narrator Companion.preset.json'), { force: true });

// ---------------------------------------------------------------- quick replies

const qr = (id, label, message, title) => ({
    id, icon: '', showLabel: true, label, title, message, contextList: [], preventAutoExecute: true, isHidden: false,
    executeOnStartup: false, executeOnUser: false, executeOnAi: false, executeOnChatChange: false, executeOnGroupMemberDraft: false,
    executeOnNewChat: false, executeBeforeGeneration: false, automationId: '',
});
const qrSet = {
    version: 2, name: 'Narrator Director', disableSend: false, placeBeforeInput: false, injectInput: false, color: 'transparent', onlyBorderColor: false,
    qrList: [
        qr(1, 'Inspect', '/director inspect', 'Open the director inspector'),
        qr(2, 'Re-plan', '/director replan', 'Force a re-plan'),
        qr(3, 'Story profile', '/director profile', 'Re-run the story profile'),
        qr(4, 'Opening', '/director opening', 'Draft an opening from a premise'),
        qr(5, 'Dump state', '/director dump | /popup <pre>{{pipe}}</pre>', 'Show the full state'),
    ],
    idIndex: 7,
};
writeFileSync(join(dist, 'Narrator Director.quickreplies.json'), JSON.stringify(qrSet, null, 2));

console.log(`Built ${bookEntries.length} genre entries, ${regexScripts.length} regex scripts -> dist/`);
