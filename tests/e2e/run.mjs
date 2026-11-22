// End-to-end checks against a real SillyTavern with a mock LLM behind it.
// Usage: ST_DIR=/path/to/SillyTavern node tests/e2e/run.mjs
// Copies the host into a disposable fixture, installs the extension there, imports the card and plays through
// the acceptance checks that need the real platform (prompt assembly, World Info, swipes, groups).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageDir = process.env.ND_PACKAGE_DIR;
const assets = packageDir || join(root, 'dist');
const shots = process.env.SHOTS_DIR;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
async function check(name, fn) {
    try { await fn(); results.push([true, name]); console.log(`  ok   ${name}`); }
    catch (e) {
        results.push([false, name, e.message]);
        console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').slice(0, 7).join('\n       ')}`);
        if (shots) await page.screenshot({ path: join(shots, `fail-${results.length}.png`) }).catch(() => { });
    }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------------------------------------------------------------- boot
const { baseURL, page, mock, close, restart } = await startFixture(process.env.ST_DIR,
    packageDir ? join(packageDir, 'narrator-director') : root, chromium);
async function abort(error, code = 3) {
    if (error) console.error(error);
    try { await close(); }
    catch (cleanupError) { console.error(cleanupError); }
    process.exit(code);
}
process.once('uncaughtException', error => abort(error));
process.once('unhandledRejection', error => abort(error));
process.once('SIGINT', () => abort(null, 130));
process.once('SIGTERM', () => abort(null, 143));
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && /Narrator Director/.test(m.text())) pageErrors.push(m.text()); });
page.on('dialog', d => d.accept());
page.on('console', m => { if (process.env.VERBOSE) console.log('   >', m.type(), m.text().slice(0, 200)); });
page.on('crash', () => console.log('PAGE CRASHED'));
page.on('close', () => console.log('PAGE CLOSED'));
page.on('framenavigated', f => { if (f === page.mainFrame()) console.log('  (navigated)', f.url()); });
async function openHost() {
    await page.goto(baseURL);
    await page.waitForFunction(() => window.SillyTavern?.getContext && window.narratorDirector && !document.querySelector('#preloader'), null, { timeout: 90000 });
    await sleep(2500);
}
await openHost();

// ---------------------------------------------------------------- helpers
const ev = (fn, arg) => page.evaluate(fn, arg);
const idle = async (timeout = 30000) => {
    await sleep(700);
    await page.waitForFunction(() => window.narratorDirector.idle() && !document.querySelector('#mes_stop:not([style*="display: none"])')?.offsetParent, null, { timeout });
    await sleep(300);
};
const view = (opts) => ev((o) => window.narratorDirector.view(o), opts);
const chatLen = () => ev(() => SillyTavern.getContext().chat.length);
const closePopups = async () => { for (let i = 0; i < 4; i++) { const b = page.locator('dialog[open] .popup-button-ok').last(); if (await b.count()) { await b.click().catch(() => { }); await sleep(400); } else break; } };
async function send(text) {
    const before = await chatLen();
    await ev(() => window.narratorDirector && document.querySelector('#nd-close')?.click()); // the drawer overlaps the send button
    await page.fill('#send_textarea', text);
    await page.click('#send_but');
    await page.waitForFunction((n) => { const c = SillyTavern.getContext().chat; return c.length >= n + 2 && !c.at(-1).is_user; }, before, { timeout: 30000 });
    await idle();
}
const slash = (cmd) => ev((c) => SillyTavern.getContext().executeSlashCommandsWithOptions(c).then(r => r?.pipe ?? ''), cmd);
const narratorCalls = () => mock.log.filter(l => l.kind === 'narrator');
const lastPrompt = () => narratorCalls().at(-1).messages;
// The card's description mentions the tag by name, so a real block is one that opens a message.
const briefOf = (messages) => messages.map(m => String(m.content)).find(t => t.startsWith('<director_notes>\n')) ?? '';
const storyOf = (messages) => flat(messages).match(/<story_context>\n[\s\S]*?<\/story_context>/)?.[0] ?? '';
const flat = (messages) => messages.map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');
async function importCard(json, name) {
    return ev(async ({ json, name }) => {
        const c = SillyTavern.getContext();
        const fd = new FormData();
        fd.append('avatar', new File([json], `${name}.json`, { type: 'application/json' }));
        fd.append('file_type', 'json');
        const headers = c.getRequestHeaders(); delete headers['Content-Type'];
        await fetch('/api/characters/import', { method: 'POST', headers, body: fd });
        await c.getCharacters();
    }, { json, name });
}
const post = (url, body) => ev(async ({ url, body }) => {
    const c = SillyTavern.getContext();
    const r = await fetch(url, { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify(body) });
    return r.ok ? r.json().catch(() => ({})) : Promise.reject(new Error(`${url} ${r.status}`));
}, { url, body });
const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const activeChat = () => ev(() => SillyTavern.getContext().getCurrentChatId());
async function openSolo(id) {
    await ev(chatId => SillyTavern.getContext().openCharacterChat(chatId), id);
    assert(await activeChat() === id, `SillyTavern did not open ${id}`);
}
async function newSolo() {
    await ev(async () => (await import('/script.js')).doNewChat());
    await idle();
    return activeChat();
}
async function waitForCall(kind, from, includes = '') {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const found = mock.log.slice(from).find(entry => entry.kind === kind && flat(entry.messages).includes(includes));
        if (found) return found;
        await sleep(50);
    }
    throw new Error(`No ${kind} request reached the scripted model${includes ? ` with ${includes}` : ''}`);
}
const openingState = () => ev(() => {
    const c = SillyTavern.getContext();
    return JSON.stringify({
        premise: c.chatMetadata.narrator_director?.setup?.premise ?? null,
        messages: c.chat.map(({ mes, swipe_id, swipes }) => ({ mes, swipe_id, swipes })),
    });
});
const setScenario = scenario => ev(async text => {
    const c = SillyTavern.getContext();
    c.chatMetadata.scenario = text;
    await c.saveMetadata();
}, scenario);

/** The main prompt of one companion preset (Mature or PG). */
const preset = (label) => JSON.parse(readFileSync(join(assets, `Narrator Companion (${label}).preset.json`), 'utf8'));
const presetMain = (label) => preset(label).prompts.find(p => p.identifier === 'main').content;
const useMain = (content) => ev((main) => { SillyTavern.getContext().chatCompletionSettings.prompts.find(x => x.identifier === 'main').content = main; }, content);

// ---------------------------------------------------------------- solo chat
console.log('Solo chat');
// Use the companion preset's main prompt in actual requests.
await ev(({ main, maxTokens }) => {
    const settings = SillyTavern.getContext().chatCompletionSettings;
    settings.prompts.find(x => x.identifier === 'main').content = main;
    settings.prompts.find(x => x.identifier === 'jailbreak').content = 'Let the present scene carry the ending.';
    settings.openai_max_tokens = maxTokens;
}, { main: presetMain('Mature').replace('Aim for 500 tokens', 'Aim for 700 tokens'), maxTokens: preset('Mature').openai_max_tokens });
await importCard(readFileSync(join(assets, 'Narrator.card.json'), 'utf8'), 'Narrator');
await ev(() => {
    const c = SillyTavern.getContext();
    c.powerUserSettings.prefer_character_jailbreak = true;
    c.powerUserSettings.persona_description = 'Rowan is a wiry courier, fast on their feet, new to the village.';
    // Not awaited: SillyTavern asks whether to import the card's embedded lorebook and waits for the answer.
    c.selectCharacterById(c.characters.findIndex(x => x.name === 'Narrator'));
});
await sleep(2000);
// Decline SillyTavern's offer to import the embedded lorebook: the director must make it work unbound.
for (let i = 0; i < 3; i++) { const no = page.locator('dialog[open] .popup-button-cancel').last(); if (await no.count()) await no.click().catch(() => { }); await sleep(500); }
// A solo chat with no premise waits for the player's first message before drafting the story profile (since 19 Nov).
// Give it the documented solo setup, a scenario, so the profile is drafted at chat start.
await ev(async () => {
    const c = SillyTavern.getContext();
    c.chatMetadata.scenario = 'A fantasy village in a drought year. Someone has poisoned the old well at Greywell, and the courier Rowan has just arrived.';
    await c.saveMetadata();
    await window.narratorDirector.director.kick();
});
await idle();

await check('the director is active only for the narrator card, and the neutral greeting is not read', async () => {
    assert(await ev(() => window.narratorDirector.active()), 'not active');
    assert(mock.log.filter(l => l.kind === 'observer').length === 0, 'observer read the neutral greeting');
});
await check('chat start: the story profile is drafted and mirrored as flags', async () => {
    const s = await view();
    assert(s.genre?.dominant === 'fantasy', `genre ${JSON.stringify(s.genre)}`);
    const vars = await ev(() => SillyTavern.getContext().chatMetadata.variables);
    assert(vars.nar_genre_fantasy === '1' && vars.nar.genre === 'fantasy', JSON.stringify(vars));
});

mock.control.priorHistory = true;
const mixedTurn = 'I walk to the well and look around. "Does anyone know what happened?"';
await send(mixedTurn);
await check('turn 1: brief sits just before the player message; story block and gated genre craft are in the prompt', async () => {
    const p = lastPrompt();
    const text = flat(p);
    const briefAt = p.findIndex(m => String(m.content).startsWith('<director_notes>\n'));
    const userAt = p.map(m => m.role).lastIndexOf('user');
    assert(briefAt !== -1, 'no brief in prompt');
    assert(briefAt === userAt - 1 && p[briefAt].role === 'system', `brief at ${briefAt}, player at ${userAt}`);
    assert(storyOf(p).includes('genre: fantasy'), 'story block missing');
    assert(text.includes('Fantasy craft:'), 'fantasy craft entry did not fire');
    assert(text.includes('Use the story profile\'s genre, voice and pace') && text.includes('let the mood shape the details'),
        'the narrator card lost the guidance for using the story profile and scene');
    assert(!text.includes('Horror craft:') && !text.includes('{{if'), 'ungated or unresolved lore');
    assert((text.match(/<director_notes>\n/g) ?? []).length === 1, 'brief sent more than once');
    assert(String(p[userAt].content).includes(mixedTurn), 'the user dialogue or action was lost in prompt assembly');
    assert(p.slice(userAt + 1).some(message => String(message.content).includes('Let the present scene carry the ending.')),
        'the selected preset lost its post-history instruction');
    assert(!text.includes('Open differently from your last few replies.'), 'the retired card post-history rule reached the model');
    assert(text.includes('Aim for 700 tokens') && !/\b500 tokens\b/.test(text), 'the preset length was overridden by the card');
    assert((text.match(/carrying out the supplied actions in order/g) ?? []).length === 1,
        'the prompt must contain one instruction to blend the supplied dialogue and action into the scene');
    assert(!text.includes('Start each reply with') && !text.includes('Narrate the world and everyone else'),
        'a retired player-rendering instruction reached the model');
    assert(presetMain('PG').includes('carrying out the supplied actions in order'),
        'the PG preset lost the shared instruction');
});
await check('the reply is read: quoted facts recorded, the unquoted one rejected, place and cast established', async () => {
    const s = await view();
    assert(s.canon.length >= 2, `canon ${s.canon.length}`);
    assert(!s.canon.some(f => f.fact.includes('cheese')), 'unquoted fact accepted');
    assert(s.meta.rejected >= 1, 'no rejection counted');
    assert(s.scene.location.established && s.scene.location.value === 'the Greywell Square', JSON.stringify(s.scene.location));
    assert(s.scene.present.includes('Mira') && s.cast.Mira, 'Mira not in cast');
    assert(s.cast['Old Tam'].stage === 'familiar' && s.cast['Old Tam'].rel.trust === 6, 'prior history was not recorded');
    assert(s.cast.Mira.stage === 'stranger' && s.cast.Mira.rel.trust === 1, 'Mira had no prior history; only her current nod was recorded');
});
await check('the planner ran after the first reply; the player profile was derived from the persona', async () => {
    const s = await view();
    assert(s.arc?.goal && s.beats.length === 2, `arc ${!!s.arc} beats ${s.beats.length}`);
    assert(s.cast.Rowan?.pc && s.cast.Rowan.stats, 'no PC profile');
});

mock.control.narration = 'Mira smiles and hands you the bucket at the Greywell Square. Old Tam spits and looks away from the water. A grey film clings to the rim of the bucket.';
await send('I try to outrun Mira to the well.');
await check('turn 2: one intent, never the queue; cast lines in words; lore keys reach World Info only by scan', async () => {
    const text = flat(lastPrompt());
    const brief = briefOf(lastPrompt());
    assert(brief.includes('scene_intent: let the bitter taste'), `no intent in ${brief}`);
    assert(!text.includes('SECRET_SECOND_BEAT'), 'the queue leaked into the prompt');
    assert(/- Mira, toward Rowan: neutral/.test(brief), `no cast line: ${brief}`);
    assert(/- Old Tam, toward Rowan: warm \(familiar;/.test(brief), `prior history missing from narrator guidance: ${brief}`);
    assert(!/\d/.test(brief.replace(/turn \d+/g, '')), `a number reached the narrator: ${brief}`);
    const scan = await ev(() => window.narratorDirector.brief().scan);
    assert(scan.includes('Mira') && scan.includes('Greywell'), `scan text: ${scan}`);
    assert(!text.includes(scan), 'the scan-only block was sent');
});
await check('/listvar-visible variables hold no beat, clue or belief', async () => {
    const vars = JSON.stringify(await ev(() => SillyTavern.getContext().chatMetadata.variables));
    for (const secret of ['bitter', 'SECRET', 'grey film', 'poisoned', 'miller']) assert(!vars.includes(secret), `${secret} in variables`);
    assert(vars.includes('nar_trust_mira_'), 'no trust band flag');
});

await send('I taste the water.');
await check('dynamic lore: a place mentioned in two accepted replies is loaded into World Info', async () => {
    const book = await ev(() => window.narratorDirector.lorebook());
    assert(book.entries.some(e => e.keys.includes('Greywell Square')), `entries ${JSON.stringify(book.entries.map(e => e.keys))}`);
    await send('I wait.');
    assert(flat(lastPrompt()).includes('the Greywell Square is a place in this story.'), 'dynamic entry not in prompt');
});

await check('the director\'s books exist as real files, so lookups by other extensions do not warn', async () => {
    const names = await ev(() => SillyTavern.getContext().getWorldInfoNames());
    assert(names.includes('Narrator dynamic lore') && names.includes('Narrator baseline'), `world names: ${names}`);
    await ev(() => { window.__warned = 0; const w = toastr.warning; toastr.warning = (...a) => { window.__warned++; return w.apply(toastr, a); }; });
    const dyn = await slash('/wi-get-timed-effect file="Narrator dynamic lore" effect=sticky 900000');
    const base = await slash('/wi-get-timed-effect file="Narrator baseline" effect=sticky 0');
    assert(dyn === 'false' && base === 'false', `results: ${dyn} / ${base}`);
    assert(await ev(() => window.__warned) === 0, 'a lookup warned');
});

await check('swipe: the rejected swipe leaves nothing behind', async () => {
    mock.control.narration = 'Captain Hale rides into the Greywell Square with six riders. The crowd falls silent at once.';
    const before = (await view()).canon.length;
    await ev(() => SillyTavern.getContext().swipe.right());
    await page.waitForFunction(() => SillyTavern.getContext().chat.at(-1).mes.includes('Captain Hale'), null, { timeout: 30000 });
    await idle();
    const s = await view();
    assert(s.canon.some(f => f.fact.includes('Captain Hale rides')), 'new swipe not read');
    const last = await ev(() => SillyTavern.getContext().chat.at(-1).swipes[0]);
    assert(!s.canon.some(f => last.includes(f.fact) && !f.fact.includes('Hale') && f.turn === s.meta.turn), 'old swipe facts remain');
    assert(s.canon.length <= before + 2, 'canon grew by more than the new swipe');
    const prompt = flat(lastPrompt());
    assert(briefOf(lastPrompt()), 'no brief on swipe');
    void prompt;
});

await check('a leaked note and blank dialogue quotes are absent from the saved reply and next prompt', async () => {
    mock.control.leak = true;
    mock.control.emptyDialogue = true;
    await send('I greet the captain.');
    mock.control.leak = false;
    const saved = await ev(() => { const m = SillyTavern.getContext().chat.at(-1); return m.mes + JSON.stringify(m.swipes ?? []); });
    assert(!saved.includes('director_notes'), `leak saved: ${saved.slice(0, 120)}`);
    const dialogue = '**Mira: "Thank you." She stepped back.**';
    assert(saved.includes(dialogue) && !saved.includes('\x60 \x60'), 'blank dialogue quotes reached the saved reply');
    await send('I step back.');
    const assistant = lastPrompt().filter(m => m.role === 'assistant').map(m => m.content).join('\n');
    assert(!assistant.includes('director_notes'), 'leak fed back');
    assert(assistant.includes(dialogue) && !assistant.includes('\x60 \x60'), 'blank dialogue quotes reached the narrator again');
});

await check('a contradiction is flagged and the next brief carries the correction', async () => {
    mock.control.contradict = true;
    await send('I listen.');
    mock.control.contradict = false;
    await send('I ask who spoke.');
    assert(flat(lastPrompt()).includes('correction: Old Tam is dead'), 'no correction in brief');
    await send('I nod.');
    assert(!flat(lastPrompt()).includes('correction:'), 'correction sent twice');
});

await check('deleting the last exchange rolls state back; committed state before it is unchanged', async () => {
    const before = await view();
    await slash('/del 2');
    await idle();
    const after = await view();
    assert(after.meta.turn === before.meta.turn - 1, `turn ${before.meta.turn} -> ${after.meta.turn}`);
    // Repeated sentences are collapsed in canon, so the deleted reply's own trace is its summary.
    assert(after.summaries.recent.length === before.summaries.recent.length - 1 && after.canon.length <= before.canon.length, 'the deleted reply left state behind');
    assert(JSON.stringify(after.canon.slice(0, 3)) === JSON.stringify(before.canon.slice(0, 3)), 'earlier canon changed');
});

await check('/director retcon removes the fact and tells the narrator once per turn until it ages out', async () => {
    const fact = (await view()).canon[0].fact;
    await slash(`/director retcon: ${fact}`);
    const s = await view();
    assert(!s.canon.some(f => f.fact === fact) && s.tombstones.length === 1, `not retconned: ${s.tombstones.length} tombstones`);
    await send('I go on.');
    assert(flat(lastPrompt()).includes('did_not_happen:'), 'narrator not told');
});

await check('impersonate: the prompt carries no director notes', async () => {
    const n = narratorCalls().length;
    await slash('/impersonate await=true go');
    await sleep(1500);
    assert(narratorCalls().length > n, 'no impersonate call seen');
    assert(!briefOf(lastPrompt()) && !storyOf(lastPrompt()), 'notes in impersonate prompt');
    await ev(() => { document.querySelector('#send_textarea').value = ''; });
    await send('I carry on.');
    assert(briefOf(lastPrompt()), 'the brief did not come back after impersonate');
});

await check('summaries stay out while their messages are still in the prompt', async () => {
    const first = await ev(() => window.narratorDirector.firstIncluded());
    assert(Number.isFinite(first) && first <= 1, `firstIncluded ${first}`);
    assert(!storyOf(lastPrompt()).includes('The story so far'), 'summaries duplicated the chat history');
    assert((await view()).summaries.recent.length >= 3, 'no turn summaries recorded');
});

await check('dry runs change nothing: no state, variable or director call', async () => {
    const snap = async () => JSON.stringify([await view(), await ev(() => SillyTavern.getContext().chatMetadata.variables), mock.log.length]);
    const before = await snap();
    for (let i = 0; i < 5; i++) await ev(() => SillyTavern.getContext().generate('normal', {}, true));
    assert(await snap() === before, 'dry run changed something');
});

await check('inspector: the scene form saves a location with a comma, and the edit reaches the narrator as a note', async () => {
    await slash('/director inspect');
    await page.click('#nd-inspector [data-nd-tab="scene"]');
    await page.fill('#nd-body [data-f="location"]', 'the Mill Yard, east side');
    await page.fill('#nd-body [data-f="mood"]', 'tense');
    await page.fill('#nd-body [data-f="add"]', 'Captain Hale');
    assert(await page.textContent('#nd-unsaved') === 'unsaved changes', 'no unsaved marker');
    await shot('inspector-scene');
    await page.click('#nd-body [data-act="save-scene"]');
    const s = await view();
    assert(s.scene.location.value === 'the Mill Yard, east side' && s.scene.mood === 'tense', JSON.stringify(s.scene));
    assert(s.scene.present.includes('Captain Hale') && s.scene.present.includes('Mira'), `present: ${s.scene.present}`);
    await send('I look around the yard.');
    assert(/note: the record(?: of scene)? was corrected/i.test(flat(lastPrompt())), 'no operation note');
});

await check('inspector: every tab renders with nothing folded away, and forms on cast, plan and record work', async () => {
    await slash('/director inspect');
    for (const t of ['now', 'scene', 'cast', 'story', 'plan', 'record', 'log']) {
        await page.click(`#nd-inspector .nd-tabs [data-nd-tab="${t}"]`);
        const info = await ev(() => ({ text: document.querySelector('#nd-body').innerText.length, folded: document.querySelectorAll('#nd-body details').length, error: /TypeError|ReferenceError/.test(document.querySelector('#nd-body').innerText) }));
        assert(info.text > 40 && info.folded === 0 && !info.error, `${t}: ${JSON.stringify(info)}`);
        await shot(`inspector-${t}`);
    }
    // Full disclosure: every setting has a control, hints are visible text, and the Log tab shows the whole state.
    const disclosed = await ev(() => {
        const set = document.querySelector('#nd-settings-body');
        const keys = Object.keys(SillyTavern.getContext().extensionSettings.narrator_director);
        const html = set.innerHTML;
        const has = { enabled: '#nd-enabled', profile: '#nd-profile', profiles: '[data-nd-module]', setTemps: '#nd-temps', placement: '#nd-placement', greetings: '#nd-greetings', mirrorLore: '#nd-mirror', tokens: '[data-nd-token]', memory: '#nd-memory', memoryProvider: '#nd-memory-provider', memoryMacro: '#nd-memory-macro', stripTags: '#nd-strip' };
        // One-time migration markers are not settings (cadenceEvents: timed re-plans moved to off once, 18 Nov 2026).
        const internal = new Set(['cadenceEvents']);
        const missing = keys.filter(k => !internal.has(k)).filter(k => !(has[k] ? set.querySelector(has[k]) : set.querySelector(`[data-nd-num="${k}"]`)));
        return { missing, tooltips: set.querySelectorAll('[title]').length, hints: set.querySelectorAll('.nd-hint').length, folded: /<details/.test(html) };
    });
    assert(disclosed.missing.length === 0, `settings with no control: ${disclosed.missing}`);
    assert(disclosed.tooltips === 0 && disclosed.hints > 10 && !disclosed.folded, JSON.stringify(disclosed));
    await page.click('#nd-inspector .nd-tabs [data-nd-tab="log"]');
    const stateButton = page.locator('#nd-body [data-act="show-state"]');
    if (await stateButton.count()) await stateButton.click();
    const logText = await page.innerText('#nd-body');
    assert(logText.includes('nar_genre_fantasy = 1') && logText.includes('"lastPlanTurn"'), 'variables or full state not shown');
    await page.click('#nd-inspector [data-nd-tab="record"]');
    assert((await page.innerText('#nd-body')).includes('seen by'), 'witnesses not shown');
    await page.click('#nd-inspector [data-nd-tab="plan"]');
    await page.fill('#nd-beats .nd-beat:first-child [data-f="clues"]', 'a grey film on the bucket | place | the well\na torn ledger page | person | the miller');
    await page.click('#nd-body [data-act="add-scene"]');
    await page.fill('#nd-scenes .nd-scene:last-child [data-f="purpose"]', 'a quiet evening');
    await page.fill('#nd-scenes .nd-scene:last-child [data-f="focus"]', 'Mira: at ease');
    await page.click('#nd-body [data-act="save-scenes"]');
    await page.click('#nd-inspector [data-nd-tab="plan"]');
    await page.fill('#nd-beats .nd-beat:first-child [data-f="clues"]', 'a grey film on the bucket | place | the well\na torn ledger page | person | the miller');
    await page.click('#nd-body [data-act="save-beats"]');
    let planned = await view();
    assert(planned.scenes.some(x => x.purpose === 'a quiet evening' && x.focus.Mira === 'at ease'), 'scene not saved');
    assert(planned.beats.find(b => b.status === 'queued').clues.length === 2, 'clues not saved');
    await page.click('#nd-inspector [data-nd-tab="cast"]');
    await page.fill('#nd-body [data-name="Mira"] [data-f="tells.devoted"]', 'hums while she works beside you');
    await page.fill('#nd-body [data-name="Mira"] [data-f="rel.trust"]', '6');
    await page.fill('#nd-body [data-name="Mira"] [data-f="rel.affection"]', '6');
    await page.fill('#nd-body [data-name="Mira"] [data-f="statuses"]', 'twisted ankle (serious)');
    await page.click('#nd-body [data-name="Mira"] [data-act="save-cast"]');
    let s = await view();
    assert(s.cast.Mira.rel.trust === 6 && s.cast.Mira.statuses[0]?.severity === 'serious', JSON.stringify(s.cast.Mira.rel));
    await page.click('#nd-inspector [data-nd-tab="plan"]');
    await page.click('#nd-body [data-act="add-beat"]');
    await page.fill('#nd-beats .nd-beat:last-child [data-f="pressure"]', 'a stranger asks for water');
    await page.click('#nd-body [data-act="save-beats"]');
    s = await view();
    assert(s.beats.some(b => b.intent === 'a stranger asks for water' && b.status === 'queued'), 'beat not saved');
    await page.click('#nd-inspector [data-nd-tab="record"]');
    const before = s.canon.length;
    await page.click('#nd-body [data-act="retcon"]');
    s = await view();
    assert(s.canon.length === before - 1 && s.tombstones.length >= 1, 'fact not undone');
    await page.click('#nd-close');
    await send('I greet Mira.');
    assert(/- Mira, toward Rowan: devoted \(hums while she works beside you/.test(briefOf(lastPrompt())), `cast line: ${briefOf(lastPrompt())}`);
});

await check('a branch rebuilds its own state from its own messages', async () => {
    const full = await view();
    const state = await ev(async () => {
        const c = SillyTavern.getContext();
        const { replay } = await import('/scripts/extensions/third-party/narrator-director/core/state.js');
        const branch = structuredClone(c.chat.slice(0, 5));
        return replay(branch, { narrator: window.narratorDirector.ref(), setup: { ...c.chatMetadata.narrator_director.setup, player: c.name1 } });
    });
    assert(state.meta.turn === 2 && state.summaries.recent.length < full.summaries.recent.length && state.tombstones.length === 0 && state.scene.mood !== 'tense', `turn ${state.meta.turn}, ${state.tombstones.length} undone`);
});

await check('switching presets controls the actual narrator prompt without changing story stakes', async () => {
    assert((await view()).genre.lethality === 'real', 'The active Mature preset forced high lethality');
    let text = flat(lastPrompt());
    assert(text.includes('NSFW and NSFL material can appear') && text.includes('## 7. Adult Content'), 'Mature guidance is absent');
    assert(!/## Boundaries|without exception|Nothing in this block reaches past that line/i.test(text),
        'Built-in content restrictions reached the actual narrator prompt');
    assert(!/rating:|intimacy style:/i.test(storyOf(lastPrompt())), 'The Director injected a content rating');
    assert(/set by the selected preset/i.test(await slash('/director pg')), 'The old PG command did not direct the user to presets');
    await ev(() => {
        const { chatMetadata } = SillyTavern.getContext();
        Object.assign(chatMetadata.variables, { nar_pg: '1', nar_explicit: '1' });
        Object.assign(chatMetadata.narrator_director.setup.genre, { pg: true, explicit: false });
    });
    await useMain(presetMain('PG'));
    await send('I sit by the fire.');
    text = flat(lastPrompt());
    const vars = await ev(() => SillyTavern.getContext().chatMetadata.variables);
    assert(!('nar_pg' in vars) && !('nar_explicit' in vars), 'Legacy rating flags remain active');
    assert(text.includes('general-audience tone') && text.includes('Keep violence non-graphic'), 'PG guidance is absent');
    assert(!/NSFW and NSFL|## 7\. Adult Content|for an adult audience/.test(text), 'Mature guidance leaked into PG');
    assert((await view()).genre.lethality === 'real', 'Switching presets changed story stakes');
    await useMain(presetMain('Mature'));
    await send('I stand up.');
    text = flat(lastPrompt());
    assert(text.includes('## 7. Adult Content') && text.includes('NSFW and NSFL material can appear') && !text.includes('{{if'), 'Mature still depends on a rating flag');
});

await check('disabled: no notes, no flags, card still narrates', async () => {
    await slash('/director off');
    await send('I breathe.');
    const text = flat(lastPrompt());
    assert(!briefOf(lastPrompt()) && !storyOf(lastPrompt()) && !text.includes('Fantasy craft:'), 'director output while disabled');
    const vars = await ev(() => SillyTavern.getContext().chatMetadata.variables);
    assert(!Object.keys(vars).some(k => k.startsWith('nar')), 'flags remain');
    await slash('/director on');
    await idle();
});

await check('a failing part is shown: a toast once, a dot on the menu entry, a banner in the panel; recovery clears them', async () => {
    mock.control.failObserver = true;
    await send('I wait by the well.');
    await sleep(500);
    const shown = await ev(() => ({
        toast: [...document.querySelectorAll('#toast-container .toast-warning')].map(t => t.textContent).join(' | '),
        failing: Object.keys(window.narratorDirector.director.failing),
        dot: document.querySelector('#nd-wand .nd-badge')?.textContent ?? '',
    }));
    assert(/reading replies failed/.test(shown.toast) && /wrong shape/.test(shown.toast), 'toast: ' + shown.toast);
    assert(shown.failing.includes('observer') && shown.dot === '1', JSON.stringify(shown));
    await ev(() => document.querySelector('#nd-wand')?.click());
    await sleep(300);
    const banner = await ev(() => document.querySelector('#nd-body .nd-failing')?.textContent ?? '');
    assert(/reading replies/.test(banner) && /Retry now/.test(banner), 'banner: ' + banner);
    mock.control.failObserver = false;
    await ev(() => window.narratorDirector.director.retry());
    await idle();
    const after = await ev(() => ({ failing: Object.keys(window.narratorDirector.director.failing), dot: !!document.querySelector('#nd-wand .nd-badge'), ok: [...document.querySelectorAll('#toast-container .toast-success')].map(t => t.textContent).join(' | ') }));
    assert(!after.failing.length && !after.dot, JSON.stringify(after));
    assert(/reading replies works again/.test(after.ok), 'no recovery toast: ' + after.ok);
    await ev(() => document.querySelector('#nd-close')?.click());
});
await check('director calls go through a Connection Manager profile when one is chosen', async () => {
    await ev((url) => {
        const c = SillyTavern.getContext();
        (c.extensionSettings.connectionManager.profiles ??= []).push({ id: 'nd-test-profile', name: 'Director (mock)', mode: 'cc', api: 'custom', model: 'mock', 'api-url': url });
        c.extensionSettings.narrator_director.profile = 'nd-test-profile';
    }, `http://127.0.0.1:${mock.port}/v1`);
    const n = mock.log.filter(l => l.kind === 'observer').length;
    await send('I keep walking.');
    assert(mock.log.filter(l => l.kind === 'observer').length === n + 1, 'no observer call through the profile');
    assert(mock.log.filter(l => l.kind === 'observer').at(-1).temperature === 0.2, `observer temperature: ${mock.log.filter(l => l.kind === 'observer').at(-1).temperature}`);
    const errors = await ev(() => window.narratorDirector.director.errors);
    assert(errors.length === 0, JSON.stringify(errors));
    const s = await view();
    assert(!s.meta.lagging, 'the reply was not read');
});

// ---------------------------------------------------------------- inspector interactions
console.log('Inspector interactions');
const directorTab = name => page.locator(`#nd-inspector .nd-tabs [data-nd-tab="${name}"]`);
const feedbackIs = text => page.waitForFunction(text => document.querySelector('#nd-feedback').textContent.includes(text), text);
async function inspectorDirection(text) {
    await page.locator('#nd-say').fill(text);
    await page.locator('#nd-say').press('Enter');
}

await check('keyboard saves a retained Scene draft, while later edits and swipes can still change Location', async () => {
    await newSolo();
    const original = 'Mira waits in the Glass Courtyard.';
    const edited = 'Mira rests in the River Yard.';
    const alternative = 'Mira watches in the Lantern Annex.';
    mock.control.narration = original;
    await send('I look for Mira near the house.');
    assert((await view()).scene.location.value === 'the Glass Courtyard', 'test needs an observed original location');
    await ev(() => {
        const c = SillyTavern.getContext();
        window.fixtureHostEvents = [];
        for (const name of ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED']) {
            c.eventSource.on(c.eventTypes[name], (value, options, dryRun) => {
                if (!dryRun) window.fixtureHostEvents.push([name, value]);
            });
        }
    });

    const composer = page.locator('#send_textarea');
    async function openWithKeyboard() {
        await composer.fill('/director inspect');
        await composer.press('Enter');
        await page.waitForFunction(() => document.querySelector('#nd-inspector .nd-active') === document.activeElement);
    }
    await openWithKeyboard();
    await directorTab('now').focus();
    const tabOrder = ['now', 'scene', 'cast', 'story', 'plan', 'record', 'log'];
    for (const tab of tabOrder) {
        assert(await ev(() => document.activeElement.dataset.ndTab) === tab, `Keyboard did not reach ${tab}`);
        if (tab !== 'log') await page.keyboard.press('Tab');
    }
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    assert(await directorTab('scene').getAttribute('aria-current') === 'true', 'Keyboard did not activate Scene');
    const mood = page.getByRole('textbox', { name: 'Mood', exact: true });
    const draft = 'quietly expectant';
    await mood.fill(draft);
    await page.keyboard.press('Escape');
    await page.locator('#nd-inspector').waitFor({ state: 'hidden' });
    assert(await ev(() => document.activeElement.id) === 'send_textarea', 'Closing did not return focus to the composer');
    assert((await view()).scene.mood !== draft, 'Closing saved an unsaved draft');
    await openWithKeyboard();
    assert(await mood.inputValue() === draft && await page.textContent('#nd-unsaved') === 'unsaved changes', 'Reopening discarded the draft');
    await shot('inspector-desktop-retained-draft');

    await mood.focus();
    for (let i = 0; i < 16 && !await ev(() => document.activeElement.dataset.act === 'save-scene'); i++) await page.keyboard.press('Tab');
    assert(await ev(() => document.activeElement.dataset.act === 'save-scene'), 'Keyboard could not reach Save the scene');
    await page.keyboard.press('Enter');
    await feedbackIs('Scene saved');
    const liveFeedback = page.locator('#nd-inspector').getByRole('status').filter({ hasText: 'Scene saved' });
    assert(await liveFeedback.isVisible(), 'Scene save feedback did not reach the drawer’s live status');
    assert((await view()).scene.mood === draft && !await page.textContent('#nd-unsaved'), 'Keyboard Save did not commit the Mood draft');
    await page.click('#nd-close');

    const reply = page.locator('#chat .mes').last();
    let from = mock.log.length;
    await reply.hover();
    await reply.locator('.mes_edit').click();
    await reply.locator('.edit_textarea').fill(edited);
    await reply.locator('.mes_edit_done').click();
    try {
        await waitForCall('observer', from, edited);
    } catch (error) {
        const diagnostics = await ev(() => {
            const { director, idle } = window.narratorDirector;
            return { events: window.fixtureHostEvents, idle: idle(), reading: director.nextUnread()?.text };
        });
        throw new Error(`${error.message}. Host state ${JSON.stringify(diagnostics)}`);
    }
    await idle();
    assert((await view()).scene.location.value === 'the River Yard', 'Saving Mood froze the old Location after a reply edit');

    from = mock.log.length;
    mock.control.narration = alternative;
    await ev(() => SillyTavern.getContext().swipe.right());
    await waitForCall('observer', from, alternative);
    await idle();
    assert((await view()).scene.location.value === 'the Lantern Annex', 'Saving Mood froze the old Location after a swipe');
});

await check('390px touch can navigate, save a scene and close the Inspector', async () => {
    const viewport = page.viewportSize();
    const cdp = await page.context().newCDPSession(page);
    async function tap(locator) {
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        assert(box, 'Touch target was not visible');
        assert(box.width >= 24 && box.height >= 44, `Touch target is ${box.width.toFixed(1)} × ${box.height.toFixed(1)} CSS px`);
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const blocked = await locator.evaluate((node, { x, y }) => {
            const hit = document.elementFromPoint(x, y);
            return node.contains(hit) ? '' : `${hit?.tagName ?? 'no target'}.${hit?.className ?? ''}`;
        }, point);
        assert(!blocked, `Touch target was covered by ${blocked}`);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await sleep(50);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        return [box.width, box.height].map(Math.round).join('×');
    }
    try {
        await page.setViewportSize({ width: 390, height: 844 });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
        await useMain(presetMain('PG'));
        await slash('/director inspect');
        await shot('inspector-390px-before-touch');
        await ev(() => toastr.clear());
        await page.locator('#toast-container').waitFor({ state: 'hidden' });
        await tap(directorTab('now'));
        await page.waitForFunction(() => document.querySelector('.nd-tabs [data-nd-tab="now"]').getAttribute('aria-current') === 'true');
        await tap(directorTab('scene'));
        const inspector = page.locator('#nd-inspector');
        const layout = await inspector.evaluate(n => {
            const rect = n.getBoundingClientRect();
            const body = n.querySelector('#nd-body');
            const css = getComputedStyle(n);
            return {
                fits: rect.left >= 0 && rect.right <= window.innerWidth && n.scrollWidth <= n.clientWidth && body.scrollWidth <= body.clientWidth,
                top: rect.top, bottom: rect.bottom, height: rect.height, viewport: window.innerHeight,
                position: css.position, background: css.backgroundColor, zIndex: css.zIndex,
                bodyPosition: getComputedStyle(document.body).position, htmlTransform: getComputedStyle(document.documentElement).transform,
            };
        });
        console.log(`       390px inspector layout ${JSON.stringify(layout)}`);
        assert(layout.fits && layout.bottom >= layout.viewport - 2 && /^rgb\(/.test(layout.background),
            'Inspector clipped, failed to fill the available narrow viewport or lacked an opaque base');
        await page.getByRole('textbox', { name: 'Mood', exact: true }).fill('still and quiet');
        await shot('inspector-390px-draft');
        const save = await tap(page.getByRole('button', { name: 'Save the scene' }));
        await feedbackIs('Scene saved');
        assert((await view()).scene.mood === 'still and quiet', 'Touch did not save the Scene edit');
        const closeSize = await tap(page.getByRole('button', { name: 'Close', exact: true }));
        await inspector.waitFor({ state: 'hidden' });
        console.log(`       390 CSS px, Chromium touch: Save ${save}, Close ${closeSize}`);
    } finally {
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await cdp.detach();
        await page.setViewportSize(viewport);
    }
});

await check('a mixed genre including smut is preserved under either preset', async () => {
    await newSolo();
    await useMain(presetMain('PG'));
    await setScenario('Rowan waits for the rain to stop while visiting an isolated village.');
    await slash('/director profile');
    await idle();
    assert(/set by the selected preset/i.test(await slash('/director explicit off')), 'The old Explicit command still changes the story');
    mock.control.revisedGenre = { ...((await view()).genre), dominant: 'romance', secondary: ['Mystery', 'Smut'], pg: true, explicit: true };
    try {
        assert(/profile revised/i.test(await slash('/director revise genre use the proposed genre')), 'The model-proposed genre did not save');
    } finally {
        mock.control.revisedGenre = null;
    }
    const genre = (await view()).genre;
    assert(genre.dominant === 'romance' && genre.secondary.join(',') === 'mystery,erotica' && !('pg' in genre) && !('explicit' in genre),
        'The revised profile lost its genres or added a content rating');
    await slash('/director inspect');
    await directorTab('story').click();
    await page.locator('#nd-body [data-f="secondary"]').fill('Mystery, Smut, Drama');
    await page.getByRole('button', { name: 'Save the profile' }).click();
    await feedbackIs('Story profile saved');
    await send('I check whether the rain has eased.');
    assert(storyOf(lastPrompt()).includes('genre: romance / mystery / erotica / drama'), 'PG lost a selected genre');
    assert(!/NSFW and NSFL|Adult Content|Explicit content is part of this story/i.test(flat(lastPrompt())),
        'A genre activated Mature content in the PG prompt');
    await useMain(presetMain('Mature'));
    await send('I wait at the window.');
    assert(storyOf(lastPrompt()).includes('genre: romance / mystery / erotica / drama'), 'Mature lost a selected genre');
    assert(flat(lastPrompt()).includes('NSFW and NSFL material can appear'), 'Mature guidance is absent after the switch');
});

await check('commands report refusal or partial success, and prose containing rewrite creates no new swipe', async () => {
    await newSolo();
    await slash('/director inspect');
    await directorTab('now').click();
    assert(/valid story profile is needed/i.test(await slash('/director confirm')), 'Confirm claimed success without a profile');
    await send('I listen to the rain.');
    assert(/did not return a valid story profile/i.test(await slash('/director revise genre try an invalid change')), 'Revise claimed success on malformed output');
    const newArc = 'Find what changed at the north gate';
    mock.control.failSpine = true;
    mock.control.arcGoal = newArc;
    const partialFrom = mock.log.length;
    try {
        await slash('/director inspect');
        await inspectorDirection('redraft');
        await feedbackIs('Redrafted arc');
        const feedback = await page.textContent('#nd-feedback');
        assert(feedback.includes('See the Log tab') && !feedback.includes('spine and plan'), `Redraft misreported the saved parts: ${feedback}`);
        assert((await view()).arc?.goal === newArc, 'Redraft claimed an arc it had not saved');
        await waitForCall('spine', partialFrom);
    } finally {
        mock.control.failSpine = false;
        mock.control.arcGoal = null;
    }

    await idle();
    const before = await openingState();
    const requests = narratorCalls().length;
    await inspectorDirection('rewrite the ending darker');
    await feedbackIs('Noted.');
    await idle();
    assert(await openingState() === before && narratorCalls().length === requests, 'Plain directions generated a swipe');
    assert(await ev(() => SillyTavern.getContext().chat.at(-1).narrator_ops
        .some(op => op.kind === 'instruction' && op.text === 'rewrite the ending darker')), 'The original prose direction did not save');
    await page.click('#nd-close');
    const oldSwipes = await ev(() => SillyTavern.getContext().chat.at(-1).swipes.length);
    mock.control.narration = 'Mira closes the shutters over the lamp.';
    await slash('/director rewrite: less dialogue');
    await page.waitForFunction(() => SillyTavern.getContext().chat.at(-1).mes === 'Mira closes the shutters over the lamp.');
    await idle();
    assert(await ev(() => SillyTavern.getContext().chat.at(-1).swipes.length) === oldSwipes + 1
        && narratorCalls().length === requests + 1, 'The explicit Rewrite form did not create one new swipe');
});

await check('Record search filters facts and Source focuses the matching chat reply', async () => {
    await newSolo();
    mock.control.narration = 'Mira discovers a Bronze Locket. Old Tam opens an Iron Chest.';
    await send('I look through the old cabinets.');
    await slash('/director inspect');
    await directorTab('record').click();
    const record = page.locator('#nd-body');
    assert(/Bronze Locket/.test(await record.innerText()) && /Iron Chest/.test(await record.innerText()), 'Record needs both fixture facts before search');
    const search = record.getByRole('searchbox', { name: 'Search this record' });
    await search.fill('bronze locket');
    await search.press('Enter');
    const rows = record.locator('.nd-line');
    assert(await rows.filter({ hasText: 'Bronze Locket' }).count() === 1 && await rows.filter({ hasText: 'Iron Chest' }).count() === 0,
        'Search did not keep only the matching fact');
    await shot('inspector-record-search');
    await rows.filter({ hasText: 'Bronze Locket' }).getByRole('button', { name: 'Source', exact: true }).click();
    await page.locator('#nd-inspector').waitFor({ state: 'hidden' });
    assert(await ev(() => document.activeElement.matches('#chat .mes') && document.activeElement.textContent.includes('Bronze Locket')),
        'Source did not focus the evidenced reply in the host chat');
});

// ---------------------------------------------------------------- real chat switches
console.log('Chat isolation');
await ev(() => { SillyTavern.getContext().extensionSettings.narrator_director.profile = ''; });

await check('a pending opening cancels on chat switch and saves when the player stays', async () => {
    const source = await newSolo();
    const sourceBefore = await openingState();
    const target = await newSolo();
    assert(target !== source && await chatLen() === 1, 'test needs two independent chats, each with only its greeting');
    const targetBefore = await openingState();
    await openSolo(source);
    await idle();

    const from = mock.log.length;
    const releaseOpening = mock.pauseNext('opening');
    const opening = slash('/director opening');
    try {
        await page.locator('dialog[open] .popup-button-ok').click();
        await waitForCall('opening', from);
        await openSolo(target);
        releaseOpening();
        const result = await opening;
        await idle();
        assert(await activeChat() === target && !/opening (drafted|posted)/i.test(result), `Unexpected opening result: ${result}`);
        assert(await openingState() === targetBefore, 'the target chat received a premise, message or swipe');
        await openSolo(target);
        assert(await openingState() === targetBefore, 'the target chat changed on disk');
        await openSolo(source);
        assert(await openingState() === sourceBefore, 'the source chat changed on disk');
    } finally {
        releaseOpening();
    }
    const next = mock.log.length;
    const releaseSameChat = mock.pauseNext('opening');
    const sameChatOpening = slash('/director opening');
    try {
        await page.locator('dialog[open] .popup-button-ok').click();
        await waitForCall('opening', next);
        const replaced = await ev(() => {
            const c = SillyTavern.getContext();
            const before = c.chatMetadata;
            c.updateChatMetadata({ fixtureMetadata: true });
            const after = SillyTavern.getContext().chatMetadata;
            return before !== after && !!before.integrity && before.integrity === after.integrity;
        });
        assert(replaced, 'SillyTavern did not replace the metadata object within the same chat');
    } finally {
        releaseSameChat();
    }
    await sameChatOpening;
    await openSolo(source);
    const saved = JSON.parse(await openingState());
    assert(saved.premise === 'A drought year.' && saved.messages[0]?.swipes?.includes('Dust hangs over the Greywell road as you arrive.'),
        'the subsequent opening did not save its premise and swipe in the source chat');
    await idle();
});

await check('a chat switch clears the Scene draft and excludes the old chat lore before World Info reloads', async () => {
    const target = await newSolo();
    const targetScenario = 'A port crew inspects the light at Blue Beacon.';
    await setScenario(targetScenario);
    const source = await newSolo();
    assert(source !== target, 'test needs separate lore and profile chats');
    const book = 'Switch-only lore';
    const marker = 'Silver Weir seal belongs to the old keeper.';
    await post('/api/worldinfo/edit', { name: book, data: { entries: { 0: {
        uid: 0, key: ['Silver Weir'], keysecondary: [], comment: 'Silver Weir',
        content: marker, constant: true, selective: false, order: 100, position: 0, disable: false,
    } } } });
    await ev(async name => {
        const c = SillyTavern.getContext();
        c.chatMetadata.world_info = name;
        await c.saveMetadata();
    }, book);
    await send('I look for the Silver Weir.');
    assert(flat(lastPrompt()).includes(marker), 'the source chat lore did not fire in SillyTavern');
    let from = mock.log.length;
    await slash('/director profile');
    await waitForCall('genre', from, marker);

    await slash('/director inspect');
    await page.click('#nd-inspector [data-nd-tab="scene"]');
    const sourceDraft = 'Uncommitted Copper Study';
    const location = page.locator('#nd-body [data-f="location"]');
    await location.fill(sourceDraft);
    assert(await page.textContent('#nd-unsaved') === 'unsaved changes', 'the source fixture needs an unsaved scene');
    await ev(() => {
        const c = SillyTavern.getContext();
        const event = c.eventTypes.WORLDINFO_ENTRIES_LOADED;
        const emit = c.eventSource.emit;
        const queued = [];
        c.eventSource.emit = async function (type, ...args) {
            // Delay delivery of the host's precached World Info without blocking the chat switch itself.
            if (type === event) {
                queued.push(args);
                return;
            }
            return emit.call(this, type, ...args);
        };
        window.restoreWorldInfoDelivery = async deliver => {
            c.eventSource.emit = emit;
            delete window.restoreWorldInfoDelivery;
            if (deliver) {
                for (const args of queued) await c.eventSource.emit(event, ...args);
            }
            return queued.length;
        };
    });
    from = mock.log.length;
    let held, targetLocation, targetDirty, targetProfile;
    try {
        await openSolo(target);
        targetLocation = await location.inputValue();
        targetDirty = await page.textContent('#nd-unsaved');
        await page.click('#nd-body [data-act="save-scene"]');
        await ev(() => SillyTavern.getContext().saveChat());
        await page.click('#nd-close');
        await slash('/director profile');
        targetProfile = await waitForCall('genre', from, targetScenario);
    } finally {
        held = await ev(deliver => window.restoreWorldInfoDelivery(deliver), await activeChat() === target);
    }
    assert(held > 0, 'the fixture did not exercise delayed World Info delivery');
    assert(!flat(targetProfile.messages).includes('Silver Weir'), 'the target profile used the previous chat’s World Info');
    assert(targetLocation !== sourceDraft && !targetDirty,
        `the target inspector retained source draft information (location: ${JSON.stringify(targetLocation)}, badge: ${JSON.stringify(targetDirty)})`);
    assert((await view()).scene.location.value !== sourceDraft, 'the source scene draft reached the target chat');
    await openSolo(target);
    assert((await view()).scene.location.value !== sourceDraft, 'the source scene draft was saved in the target chat');
    await idle();
});

await check('a held current-connection call in one chat does not block work in the next', async () => {
    const target = await newSolo();
    const targetScenario = 'The last train crosses North Bridge at dawn.';
    await setScenario(targetScenario);
    const source = await newSolo();
    const sourceScenario = 'The town rings a bell at Copper Gate.';
    assert(source !== target, 'test needs separate chat sessions');
    await setScenario(sourceScenario);

    const from = mock.log.length;
    const release = mock.pauseNext('genre');
    const pending = slash('/director profile');
    let newProfile;
    try {
        await waitForCall('genre', from, sourceScenario);
        await openSolo(target);
        const next = mock.log.length;
        newProfile = slash('/director profile');
        await waitForCall('genre', next, targetScenario);
        await newProfile;
        await idle();
        assert(await activeChat() === target && (await view()).genre?.dominant === 'fantasy', 'the target chat did not finish its profile while the source request was held');
    } finally {
        release();
        await Promise.allSettled([pending, newProfile]);
    }
});

// ---------------------------------------------------------------- saved replay
console.log('Saved replay');
await check('only the active swipe survives in Director records through swipes, edit, restart and deletion', async () => {
    const id = await newSolo();
    const original = 'Mira records the Copper Token in the Greywell Square.';
    const alternate = 'Old Tam unfolds the Silver Ledger in the Greywell Square.';
    const revised = 'Mira seals the Bronze Receipt in the Greywell Square.';
    const earlier = 'Mira places the Ivory Key beneath a lantern.';
    const playerNote = 'The player asked to keep the lantern burning.';
    const needle = prose => prose.split(' in the Greywell')[0].replace(/\.$/, '');

    const readSaved = () => ev(async () => {
        const c = SillyTavern.getContext();
        const response = await fetch('/api/chats/get', {
            method: 'POST', headers: c.getRequestHeaders(),
            body: JSON.stringify({ file_name: c.getCurrentChatId(), avatar_url: c.characters[c.characterId].avatar }),
        });
        if (!response.ok) throw new Error(`Saved fixture chat read failed: ${response.status}`);
        return response.json();
    });
    async function waitSaved(matches) {
        const until = Date.now() + 6500;
        let saved;
        while (Date.now() < until) {
            saved = await readSaved();
            if (matches(saved)) return saved;
            await sleep(100);
        }
        throw new Error('The current Director state did not reach the saved chat');
    }
    function expectFacts(state, present, absent) {
        const facts = state.canon.map(fact => fact.fact);
        assert(facts.some(fact => fact.includes(needle(present))), `Current reply missing from replay: ${present}`);
        for (const prose of absent) {
            assert(!facts.some(fact => fact.includes(needle(prose))), `Stale reply survived replay: ${prose}`);
        }
    }
    async function stampSwipe(value, legacyRecord = null) {
        await ev(async ({ value, legacyRecord, playerNote }) => {
            const c = SillyTavern.getContext();
            const message = c.chat.at(-1);
            const slot = message.swipe_info[message.swipe_id];
            message.extra.fixtureThirdParty = { value };
            slot.extra = { ...slot.extra, fixtureThirdParty: { value } };
            if (legacyRecord) {
                const inactive = message.swipe_info[0];
                (legacyRecord.ops ??= []).push({ by: 'player', kind: 'note', text: playerNote, at: Date.now() });
                inactive.extra = { ...inactive.extra, narrator: legacyRecord };
            }
            await c.saveChat();
        }, { value, legacyRecord, playerNote });
    }
    async function moveSwipe(direction, prose) {
        const from = mock.log.length;
        await ev(direction => SillyTavern.getContext().swipe[direction](), direction);
        await page.waitForFunction(prose => SillyTavern.getContext().chat.at(-1).mes === prose, prose);
        await waitForCall('observer', from, prose);
        await idle();
    }
    function expectSwipes(message, current, versions) {
        assert(message.mes === versions[current] && message.swipe_id === current, 'Saved active selection changed');
        assert(JSON.stringify(message.swipes) === JSON.stringify(versions), 'A saved swipe’s prose was lost or modified');
        assert(message.swipe_info.length === versions.length, 'The saved message lost a swipe metadata slot');
        assert(message.swipe_info.every(slot => !slot.extra?.narrator), 'Director records remain under saved swipe_info');
        assert(message.swipe_info.every((slot, i) => slot.extra?.fixtureThirdParty?.value === ['first', 'second'][i]),
            'Unrelated per-swipe metadata was lost or reassigned');
        assert(message.extra.fixtureThirdParty?.value === ['first', 'second'][current], 'Unrelated active metadata was lost or reassigned');
        assert(message.extra.narrator?.obs, 'Active observation is absent from the saved Director record');
        assert(message.narrator_ops?.filter(op => op.by === 'player' && op.text === playerNote).length === 1,
            'The older swipe-stored player note was lost or duplicated during migration');
    }

    mock.control.narration = earlier;
    await send('I wait near Mira.');
    mock.control.narration = original;
    await send('I ask what she writes.');
    expectFacts(await view(), original, [alternate, revised]);
    await stampSwipe('first');
    const legacyRecord = (await readSaved()).at(-1).extra.narrator;

    mock.control.narration = alternate;
    await moveSwipe('right', alternate);
    expectFacts(await view(), alternate, [original, revised]);
    await stampSwipe('second', legacyRecord);
    assert((await readSaved()).at(-1).swipe_info[0].extra.narrator?.obs, 'This migration fixture needs a saved inactive observation');
    await openSolo(id);
    await idle();
    let stored = await waitSaved(data => data.at(-1)?.mes === alternate && data.at(-1)?.extra?.narrator?.obs
        && data.at(-1)?.swipe_info.every(slot => !slot.extra?.narrator));
    expectSwipes(stored.at(-1), 1, [original, alternate]);

    await moveSwipe('left', original);
    expectFacts(await view(), original, [alternate, revised]);
    stored = await waitSaved(data => data.at(-1)?.mes === original && data.at(-1)?.extra?.narrator?.obs);
    expectSwipes(stored.at(-1), 0, [original, alternate]);
    const keptProse = stored.slice(1, -1).map(message => message.mes);

    const lastMessage = page.locator('#chat .mes').last();
    const from = mock.log.length;
    await lastMessage.hover();
    await lastMessage.locator('.mes_edit').click();
    await lastMessage.locator('.edit_textarea').fill(revised);
    await lastMessage.locator('.mes_edit_done').click();
    await waitForCall('observer', from, revised);
    await idle();
    expectFacts(await view(), revised, [original, alternate]);
    stored = await waitSaved(data => data.at(-1)?.mes === revised && data.at(-1)?.extra?.narrator?.obs);
    expectSwipes(stored.at(-1), 0, [revised, alternate]);
    assert(JSON.stringify(stored.slice(1, -1).map(message => message.mes)) === JSON.stringify(keptProse), 'The edit modified earlier prose');

    const avatar = await ev(() => {
        const c = SillyTavern.getContext();
        return c.characters[c.characterId].avatar;
    });
    await restart();
    await openHost();
    await ev(async avatar => {
        const c = SillyTavern.getContext();
        await c.selectCharacterById(c.characters.findIndex(character => character.avatar === avatar));
    }, avatar);
    await openSolo(id);
    await idle();
    expectFacts(await view(), revised, [original, alternate]);
    expectSwipes((await readSaved()).at(-1), 0, [revised, alternate]);

    await slash('/del 1');
    await idle();
    expectFacts(await view(), earlier, [original, alternate, revised]);
    stored = await waitSaved(data => data.length === keptProse.length + 1);
    assert(JSON.stringify(stored.slice(1).map(message => message.mes)) === JSON.stringify(keptProse), 'Deleting the selected message modified earlier prose');
    await openSolo(id);
    await idle();
    expectFacts(await view(), earlier, [original, alternate, revised]);
});

// ---------------------------------------------------------------- group chat
console.log('Group chat');
const castCard = (name, desc, world) => JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name, description: desc, personality: '', scenario: '', first_mes: `${name} greets you from a cast card.`, mes_example: '', alternate_greetings: [], tags: [], extensions: world ? { world } : {} } });
await post('/api/worldinfo/edit', { name: 'MiraBook', data: { entries: { 0: { uid: 0, key: ['heirloom'], keysecondary: [], comment: 'heirloom', content: 'MIRA_LORE: the heirloom is a brass compass.', constant: false, selective: false, order: 100, position: 0, disable: false, probability: 100, useProbability: true, depth: 4 } } } });
await importCard(castCard('Mira', '{{char}} is a sharp-tongued well keeper.', 'MiraBook'), 'Mira');
await importCard(castCard('Old Tam', '{{char}} is a tired ferryman.'), 'Old Tam');
await ev(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/closechat'));
await sleep(800);
const groupFixture = await ev(async () => {
    const c = SillyTavern.getContext();
    const av = (n) => c.characters.find(x => x.name === n).avatar;
    const headers = c.getRequestHeaders();
    const originalMutes = [av('Narrator'), av('Old Tam')];
    const setupMutes = [av('Mira'), av('Old Tam')];
    const name = String(Date.now());
    const r = await fetch('/api/groups/create', { method: 'POST', headers, body: JSON.stringify({ name: 'Greywell', members: [av('Mira'), av('Narrator'), av('Old Tam')], avatar_url: '', allow_self_responses: false, activation_strategy: 0, generation_mode: 0, disabled_members: originalMutes, fav: false, chat_id: name, chats: [name] }) });
    if (!r.ok) throw new Error(`Could not create the group fixture (HTTP ${r.status}).`);
    const group = await r.json();
    await c.getCharacters();
    const { getGroups, openGroupById } = await import('/scripts/group-chats.js');
    await getGroups();
    await openGroupById(group.id);
    return { id: group.id, originalMutes, setupMutes };
});
await sleep(2500);
await closePopups();
await idle();

await check('fresh group chat: the narrator opens with her group greeting; cast greetings are hidden and never read', async () => {
    const msgs = await ev(() => SillyTavern.getContext().chat.map(m => ({ name: m.name, mes: m.mes.slice(0, 40), hidden: !!m.is_system })));
    const nar = msgs.find(m => m.name === 'Narrator');
    assert(nar?.mes.startsWith('*The company is gathered'), `narrator greeting: ${JSON.stringify(msgs)}`);
    assert(msgs.filter(m => m.name !== 'Narrator').every(m => m.hidden), 'cast greeting visible to the prompt');
    assert(mock.log.filter(l => l.kind === 'observer' && flat(l.messages).includes('greets you from a cast card')).length === 0, 'cast greeting was read');
});
await check('group setup: only the narrator is unmuted; a small cast uses join mode', async () => {
    await slash('/director setup');
    const saved = (await post('/api/groups/all', {})).find(g => g.id === groupFixture.id);
    assert(saved?.generation_mode === 2, `saved group mode ${saved?.generation_mode}`);
    assert(JSON.stringify(saved.disabled_members) === JSON.stringify(groupFixture.setupMutes), `saved mute list ${JSON.stringify(saved.disabled_members)}`);
});
await check('join mode: only the narrator generates, cast cards are in the prompt, and a muted member\'s lorebook fires', async () => {
    const n = narratorCalls().length;
    await send('I ask Mira about the heirloom.');
    assert(narratorCalls().length === n + 1, `${narratorCalls().length - n} generations`);
    const last = await ev(() => SillyTavern.getContext().chat.at(-1).name);
    assert(last === 'Narrator', `reply by ${last}`);
    const text = flat(lastPrompt());
    assert(text.includes('Mira is a sharp-tongued well keeper') && text.includes('Old Tam is a tired ferryman'), 'cast cards missing');
    assert(text.includes('MIRA_LORE'), 'muted member lore did not fire');
    assert(briefOf(lastPrompt()), 'no brief in group');
});
await check('cast profiles are derived from the cards', async () => {
    const s = await view();
    assert(s.cast.Mira?.stats?.agility === 66 && s.cast.Mira.tells?.warm, JSON.stringify(s.cast.Mira?.stats));
});
await check('cast-size rule: above the limit the group swaps and the director injects the cast', async () => {
    await ev(() => { SillyTavern.getContext().extensionSettings.narrator_director.castLimit = 1; });
    await ev(() => SillyTavern.getContext().eventSource.emit('group_updated'));
    await sleep(1000);
    const mode = await ev(() => { const c = SillyTavern.getContext(); return c.groups.find(x => x.id === c.groupId).generation_mode; });
    assert(mode === 0, `mode ${mode}`);
    // Presence is additive, so Old Tam leaves the scene only when it moves somewhere else.
    mock.control.narration = 'Mira leads you alone into the Mill Yard beyond the houses. Nobody else is in sight this morning.';
    await send('I walk on with Mira.');
    await send('I look at Mira.');
    const text = flat(lastPrompt());
    const story = storyOf(lastPrompt());
    assert(story.includes('Characters in the scene:') && story.includes('[Mira]'), `no injected cast: ${story.slice(0, 300)}`);
    assert(story.includes('Other characters (not in the scene):') && story.includes('- Old Tam: Old Tam in brief.'), 'no short profile for absent cast');
});

await check('group Off restores the original Swap and mutes from a sibling chat after reload', async () => {
    const originalChat = await activeChat();
    await ev(async () => {
        const c = SillyTavern.getContext();
        c.extensionSettings.narrator_director.castLimit = 4;
        await c.eventSource.emit('group_updated');
    });
    await page.waitForFunction(() => {
        const c = SillyTavern.getContext();
        return c.groups.find(g => g.id === c.groupId)?.generation_mode === 2;
    });
    const sibling = await ev(async id => {
        const { createNewGroupChat } = await import('/scripts/group-chats.js');
        await createNewGroupChat(id);
        return SillyTavern.getContext().getCurrentChatId();
    }, groupFixture.id);
    assert(sibling && sibling !== originalChat, `sibling chat ${sibling}`);
    await idle();
    await openHost();
    await ev(async ({ id, chat }) => {
        const c = SillyTavern.getContext();
        const { openGroupById, openGroupChat } = await import('/scripts/group-chats.js');
        if (c.groupId !== id) await openGroupById(id);
        if (c.getCurrentChatId() !== chat) await openGroupChat(id, chat);
    }, { id: groupFixture.id, chat: sibling });
    assert(await activeChat() === sibling, 'reopened sibling group chat');
    await idle();

    const result = await slash('/director off');
    assert(result === 'Director off for this chat.', result);
    const saved = (await post('/api/groups/all', {})).find(g => g.id === groupFixture.id);
    assert(saved?.generation_mode === 0, `saved mode after disabling ${saved?.generation_mode}`);
    assert(JSON.stringify(saved.disabled_members) === JSON.stringify(groupFixture.originalMutes), `restored mutes ${JSON.stringify(saved.disabled_members)}`);
    assert(!saved.narrator_director, 'restored group still has a Director baseline');
    assert(saved.chat_id === sibling && saved.chats.includes(originalChat), 'group chat identity or history changed during restore');
});

await check('no page errors from the extension', async () => assert(pageErrors.length === 0, pageErrors.join(' | ')));

// ---------------------------------------------------------------- done
await close();
const failed = results.filter(r => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
