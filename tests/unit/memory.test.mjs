// Item 1: another extension owns memory. Tag stripping, old records surviving it, what the narrator and the planner
// get in each memory mode, and the trial fixes (outcome-style criteria, intents cut at a sentence end).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStoryBlock } from '../../core/brief.js';
import { plannerMemory } from '../../core/memory.js';
import { validatePlan } from '../../core/planner.js';
import { PLAN_RULES, SPINE_SYSTEM, planPrompt } from '../../core/prompts.js';
import { logOp, reconcile, replay, scan, visibleText } from '../../core/state.js';
import { parseTags, stripTags } from '../../core/text.js';
import { clip, hash } from '../../core/util.js';
import { NARRATOR, makeHost, narr, user } from './helpers.mjs';

const STRIP = { ...NARRATOR, strip: ['bbs_start', 'bbs_end', 'bbi_image'] };
const WRAPPED = '<bbs_start>1347/5/12 18:22</bbs_start>\n\nPiet points down the quay. The Sea Wren is moored at the end.\n<bbi_image><nl>a quay at dusk, rain</nl><size>landscape</size></bbi_image>\n<bbs_end>1347/5/12 18:25</bbs_end>';
const PROSE = 'Piet points down the quay. The Sea Wren is moored at the end.';

test('tag stripping removes whole elements and stray tags, and leaves prose alone', () => {
    assert.equal(stripTags(WRAPPED, STRIP.strip), PROSE);
    assert.equal(stripTags('a <bbs_start> b </bbs_end> c <bbi_image/> d', STRIP.strip), 'a  b  c  d');
    assert.equal(stripTags('<B>bold</B> stays', ['bbs_start']), '<B>bold</B> stays');
    assert.equal(stripTags(WRAPPED, []), WRAPPED, 'an empty list changes nothing');
    assert.deepEqual(parseTags(' bbs_start, <bbs_end>;  /bbi_image '), ['bbs_start', 'bbs_end', 'bbi_image']);
    const m = narr(WRAPPED);
    assert.equal(visibleText(m, STRIP), PROSE);
    assert.equal(m.mes, WRAPPED, 'the saved message is not changed');
});

test('records read before stripping was switched on still stand: observer and tracker', () => {
    const chat = [user('go'), narr(WRAPPED), user('next'), narr('Another reply.')];
    reconcile(chat, NARRATOR);
    const oldHash = hash(visibleText(chat[1], NARRATOR));
    chat[1].extra.narrator.obs = { hash: oldHash, delta: { summary: 'old' }, accepted: 1, rejected: [] };
    chat[3].extra.narrator.track = { covers: [{ mid: chat[1].narrator_id, hash: oldHash }], delta: { readings: [] }, rejected: [] };
    const r = reconcile(chat, STRIP);
    assert.deepEqual(r.stale, [], 'no record is voided by switching stripping on');
    const e = scan(chat, STRIP)[1];
    assert.equal(e.text, PROSE);
    assert.ok(e.valid, 'old observer record accepted');
    assert.ok(e.tracked, 'old tracker batch accepted');
    // A real edit still voids it.
    chat[1].mes = WRAPPED.replace('Piet', 'Willem');
    assert.equal(reconcile(chat, STRIP).stale.length, 1);
});

test('the observer reads a wrapped reply without the tags and quotes still match', async () => {
    const chat = [user('go'), narr(WRAPPED), user('next')];
    const { director, host, state } = makeHost(chat);
    host.narrator = () => STRIP;
    await director.kick();
    const call = state.calls.find(c => c.module === 'observer');
    assert.ok(call, 'observer ran');
    assert.ok(!call.messages.at(-1).content.includes('bbs_start') && !call.messages.at(-1).content.includes('bbi_image'));
    assert.ok(chat[1].extra.narrator.obs, 'record written');
    assert.ok(chat[1].extra.narrator.obs.accepted > 0, 'facts quoting the stripped text are accepted');
});

const SUMMARISED = () => {
    const chat = [user('start')];
    for (let i = 0; i < 4; i++) {
        const m = narr(`Reply ${i}.`);
        chat.push(m, user(`p${i}`));
    }
    reconcile(chat, NARRATOR);
    chat.forEach((m, i) => {
        if (m.is_user) return;
        m.extra.narrator.obs = { hash: hash(visibleText(m)), delta: { summary: `summary ${i}` }, accepted: 1, rejected: [] };
    });
    chat[0].narrator_ops = [{ at: 1, by: 'setup', kind: 'spine', value: { question: 'q', endings: [], milestones: [{ id: 'm1', title: 'First allies', status: 'open', conclusion: '', criteria: [] }] } }];
    logOp(chat[1], { kind: 'conclusion', by: 'director', milestone: 'm1', text: 'Allies were found.' });
    return chat;
};

test('the narrator gets summaries and chapters only when the director keeps the memory', () => {
    const chat = SUMMARISED();
    const s = replay(chat, { narrator: NARRATOR, setup: { player: 'Rowan' } });
    const director = buildStoryBlock(s, { firstIncluded: 99, memory: 'director' }).text;
    assert.match(director, /Chapters so far/);
    assert.match(director, /The story so far/);
    const ext = buildStoryBlock(s, { firstIncluded: 99, memory: 'extension' }).text;
    assert.doesNotMatch(ext, /Chapters so far|The story so far/);
    assert.match(ext, /The last turns, in brief:\n- summary 5\n- summary 7/, 'with another extension: only the last 2 turns');
    assert.doesNotMatch(ext, /summary 1\b|summary 3\b/);
    assert.doesNotMatch(buildStoryBlock(s, { firstIncluded: 99, memory: 'off' }).text, /Chapters so far|The story so far|summary \d/, 'off');
});

test('planner memory: the extension record, the last 2 replies, lag is no gap, real gaps are flagged', () => {
    const chat = SUMMARISED();
    const s = replay(chat, { narrator: NARRATOR, setup: { player: 'Rowan' } });
    chat[3].is_system = true; // hidden: left the prompt
    const entries = scan(chat, NARRATOR);
    const latestIdx = entries.filter(e => e.kind === 'narration').slice(-2).map(e => e.i);
    const mem = plannerMemory({ mode: 'extension', state: s, entries, provided: { text: 'L2: the voyage. L0: the quay.', missing: [3, ...latestIdx], source: 'BaiBai Book' } });
    assert.deepEqual(mem.latest, ['summary 5', 'summary 7']);
    assert.equal(mem.gaps, 1, 'the two newest replies are covered by the director, not counted as gaps');
    assert.deepEqual(mem.raw, ['Reply 1.'], 'a hidden reply with no summary is quoted');
    const prompt = planPrompt({ state: s, loreKeys: [], reason: 'test', memory: mem })[1].content;
    assert.match(prompt, /from the memory extension \(BaiBai Book\)/);
    assert.match(prompt, /L2: the voyage/);
    assert.match(prompt, /has gaps: 1 earlier reply/);
    assert.match(prompt, /Latest replies \(newer than that record\)\n- summary 5\n- summary 7/);
    assert.doesNotMatch(prompt, /summary 1\b/, 'older director summaries are not used');
    const off = planPrompt({ state: s, loreKeys: [], reason: 'test', memory: plannerMemory({ mode: 'off', state: s }) })[1].content;
    assert.doesNotMatch(off, /memory extension/);
    assert.match(off, /Latest replies\n- summary 5\n- summary 7/);
    const director = planPrompt({ state: s, loreKeys: [], reason: 'test' })[1].content;
    assert.match(director, /## Story so far\nsummary 1/, 'director mode is unchanged');
});

test('confirmed memory quotes can establish facts and criteria, with the earlier story bound to the evidence', async () => {
    const earlier = 'The captain signed the old order.';
    const chat = [user('Open the story.'), narr('The captain inspects the watch.'), user('I ask about the watch.'),
        narr('The captain sets the fresh order on the table.'), user('I look at it.')];
    const { director, host, state } = makeHost(chat, { settings: { memory: 'extension' } });
    director.sync();
    logOp(chat[0], { kind: 'spine', by: 'setup', value: { question: 'What will the captain do?', endings: [], milestones: [
        { id: 'm1', title: 'The captain signs', status: 'open', criteria: [
            { id: 'm1-c1', text: 'The captain signs the old order', mark: 'open' },
            { id: 'm1-c2', text: 'The watch closes the harbor', mark: 'open' },
        ] },
    ] } });
    const queries = [];
    host.memoryStory = ({ before }) => {
        queries.push(before);
        return { before, text: `${earlier} The captain visits the market.`, source: 'BaiBai Book' };
    };
    host.call = async (module, messages) => {
        state.calls.push({ module, messages });
        if (module === 'observer') return JSON.stringify({ summary: chat[3].mes, facts: [
            { fact: 'The fresh order is on the table.', quote: chat[3].mes, certainty: 'stated' },
            { fact: earlier, quote: earlier, source: 'memory', certainty: 'stated' },
            { fact: 'The watch seized the market.', quote: 'The captain visits the market.', source: 'memory', certainty: 'stated' },
        ] });
        if (module === 'observer-memory-check') return JSON.stringify({ verdicts: [
            { id: 'f1', verdict: 'confirm' }, { id: 'f2', verdict: 'reject', reason: 'a visit does not show a seizure' },
        ] });
        if (module === 'tracker') return JSON.stringify({ marks: [
            { id: 'm1-c1', mark: 'met', evidence: 'occurred', source: 'memory', quote: earlier },
            { id: 'm1-c2', mark: 'met', evidence: 'occurred', source: 'memory', quote: 'The watch closed the harbor.' },
        ] });
        return JSON.stringify({ verdicts: [{ id: 'm1-c1', verdict: 'confirm' }] });
    };
    assert.equal(await director.observe(director.readings().entries[3]), true);
    assert.equal(await director.track([director.readings().entries[3]]), true);
    assert.deepEqual(queries, [3, 3]);
    assert.deepEqual(state.calls.map(c => c.module), ['observer', 'observer-memory-check', 'tracker', 'tracker-check']);
    for (const call of state.calls) assert.ok(call.messages[1].content.includes('BaiBai Book'));
    const result = director.view();
    assert.equal(result.canon.length, 2);
    const fact = result.canon.find(f => f.memory);
    assert.deepEqual(fact.memory, { source: 'BaiBai Book', before: 3 });
    assert.deepEqual(fact.witnesses, []);
    const [met, open] = result.spine.milestones[0].criteria;
    assert.equal(met.mark, 'met');
    assert.deepEqual(met.memory, fact.memory);
    assert.equal(open.mark, 'open');
    assert.match(JSON.stringify(chat[3].extra.narrator.track.rejected), /needs a quote from the earlier memory/);
    assert.deepEqual(makeHost(structuredClone(chat)).director.view().canon, result.canon);
    chat[0].mes = 'Start a different scene.';
    const afterEdit = director.view();
    assert.deepEqual(afterEdit.canon.map(f => f.fact), ['The fresh order is on the table.']);
    assert.equal(afterEdit.spine.milestones[0].criteria[0].mark, 'open');
});

test('a spine redraft uses the selected external memory with its source', async () => {
    const chat = SUMMARISED();
    logOp(chat[0], { kind: 'arc', by: 'setup', value: { goal: 'Settle the pilot’s debt', forces: ['the watch'], act: 1, tension: 'low' } });
    const { director, host, state } = makeHost(chat, { settings: { memory: 'extension' } });
    host.material = async () => 'The pilot owes the watch, but the watch has withheld the ship and stopped her family from leaving port.';
    host.memoryStory = async () => ({ source: 'A registered notebook', text: 'The watch has returned the ship but still holds the crew.' });
    host.call = async (module, messages) => {
        state.calls.push({ module, messages });
        return JSON.stringify({ question: 'Can the crew go free?', endings: [
            { title: 'Paid', criteria: ['The pilot holds a receipt'] },
            { title: 'Released', criteria: ['The crew leaves the port'] },
        ], milestones: [{ title: 'The watch yields', criteria: ['The watch gives up its hold on the crew'] }] });
    };
    assert.equal(await director.ensureSpine(true), true);
    assert.match(state.calls[0].messages[1].content, /Earlier story memory \(A registered notebook\)\nThe watch has returned the ship/);
});

test('the planner plans without the extension when it is missing, throws or is slow', async () => {
    for (const memoryStory of [null, () => { throw new Error('boom'); }, () => new Promise(r => setTimeout(() => r({ text: 'late' }), 200))]) {
        const chat = SUMMARISED();
        const { director, host, state } = makeHost(chat, { settings: { memory: 'extension', memoryWait: 50 } });
        if (memoryStory) host.memoryStory = memoryStory;
        assert.equal(await director.memoryRecord(director.cfg()), null);
        await director.maybePlan('test');
        const plan = state.calls.filter(c => c.module === 'planner').at(-1);
        assert.ok(plan, 'the planner still ran');
        assert.match(plan.messages[1].content, /memory extension did not answer/);
    }
    const chat = SUMMARISED();
    const { director, host } = makeHost(chat, { settings: { memory: 'extension' } });
    host.memoryStory = async () => ({ text: 'BaiBai record', missing: [] });
    assert.equal((await director.memoryRecord(director.cfg())).text, 'BaiBai record');
});

test('no roll-up when another extension keeps the memory', async () => {
    const chat = SUMMARISED();
    const { director, state } = makeHost(chat, { settings: { memory: 'extension', rollEvery: 1 }, firstIncluded: 99 });
    assert.equal(await director.maybeRollUp(true), false);
    assert.equal(state.calls.filter(c => c.module === 'summariser').length, 0);
});

test('beat intents are cut at a sentence end, never mid-word', () => {
    const long = `Piet tells Max where the captain drinks. ${'He adds that men pay the barkeep to look away. '.repeat(6)}`;
    const v = validatePlan({ scenes: [{ id: 's1', purpose: 'p' }], beats: [{ scene: 's1', intent: long, type: 'reveal' }] }, replay([], { narrator: NARRATOR, setup: {} }));
    const intent = v.value.beats[0].intent;
    assert.ok(intent.length <= 240 && /[.!?]$/.test(intent), intent);
    assert.equal(clip('one two three four five six', 12), 'one two…');
    assert.equal(clip('short', 12), 'short');
});

test('spine criteria are asked for as outcomes, with names from the setup only', () => {
    assert.match(SPINE_SYSTEM, /never bound to a particular action, gesture, scene, time of day/);
    assert.match(SPINE_SYSTEM, /Never invent a name/);
    assert.match(PLAN_RULES, /at most two short sentences/i);
});

test('an extension that is present but has summarised nothing yet is not reported as down', () => {
    const chat = SUMMARISED();
    const s = replay(chat, { narrator: NARRATOR, setup: { player: 'Rowan' } });
    const mem = plannerMemory({ mode: 'extension', state: s, entries: scan(chat, NARRATOR), provided: { text: '', empty: true } });
    assert.equal(mem.unavailable, false);
    const prompt = planPrompt({ state: s, loreKeys: [], reason: 'test', memory: mem })[1].content;
    assert.match(prompt, /has no record yet/);
    assert.doesNotMatch(prompt, /did not answer/);
});

test('a new character named only in part in the prose joins the cast when the full name is already known', async () => {
    const { validateObservation } = await import('../../core/validate.js');
    const text = '"Varn," she says. Not a question. She closes the ledger.';
    const intro = { cast_changes: [{ who: 'Ilse Varn', change: 'introduced', quote: '"Varn," she says.' }] };
    const base = { text, names: ['Max'], tombstones: [], present: [], uncertainIds: [], threadIds: [], clueIds: [], player: 'Max' };
    assert.equal(validateObservation(intro, base).delta.cast_changes.length, 0, 'unknown full name: refused, as before');
    const ok = validateObservation(intro, { ...base, known: 'Max asks for Captain Ilse Varn.' });
    assert.deepEqual(ok.delta.cast_changes.map(c => c.who), ['Ilse Varn']);
    const vague = validateObservation({ cast_changes: [{ who: 'Ilse Varn', change: 'introduced', quote: 'She closes the ledger.' }] }, { ...base, text: 'She closes the ledger.', known: 'Captain Ilse Varn' });
    assert.equal(vague.delta.cast_changes.length, 0, 'no part of the name in the reply: refused');
});

test('a milestone concluded on the newest reply is not concluded again on the next pass', async () => {
    const chat = [user('start'), narr('Ilse sets the glass down.'), user('go on'), narr('She reads the letter twice.')];
    reconcile(chat, NARRATOR);
    chat.forEach(m => { if (!m.is_user) m.extra.narrator.obs = { hash: hash(visibleText(m)), delta: { summary: 's' }, accepted: 1, rejected: [] }; });
    chat[0].narrator_ops = [{ at: 1, by: 'setup', kind: 'spine', value: { question: 'q', endings: [], milestones: [{ id: 'm1', title: 'First trust', status: 'open', conclusion: '', criteria: [{ id: 'm1-c1', text: 'Ilse trusts him', mark: 'open' }] }] } }];
    logOp(chat[3], { kind: 'spine-conclude', by: 'player', milestone: 'm1' });
    const { director, host, state } = makeHost(chat);
    const call = host.call;
    host.call = async (module, messages, ...rest) => (module === 'summariser' ? (state.calls.push({ module }), JSON.stringify({ conclusion: 'Trust was not won this time.' })) : call(module, messages, ...rest));
    assert.equal(await director.maybeConclude(), true, 'first pass writes the conclusion');
    assert.equal(await director.maybeConclude(), false, 'second pass leaves it');
    assert.equal(state.calls.filter(c => c.module === 'summariser').length, 1);
    assert.equal(director.view().spine.milestones[0].status, 'concluded');
});

test('a spine saved on the Plan tab keeps what the story recorded; a redraft replaces it', () => {
    const SP = { question: 'q', endings: [{ id: 'e1', title: 'Trust', how: 'h', criteria: [{ id: 'e1-c1', text: 'she trusts him', mark: 'open' }, { id: 'e1-c2', text: 'she shares a meal', mark: 'open' }] }],
        milestones: [{ id: 'm1', title: 'First words', status: 'open', conclusion: '', criteria: [{ id: 'm1-c1', text: 'she speaks first', mark: 'open' }] }] };
    const chat = [user('start'), narr('She trusts him now.'), user('go on'), narr('More.')];
    reconcile(chat, NARRATOR);
    chat.forEach(m => { if (!m.is_user) m.extra.narrator.obs = { hash: hash(visibleText(m)), delta: { summary: 's' }, accepted: 1, rejected: [] }; });
    chat[0].narrator_ops = [{ at: 1, by: 'setup', kind: 'spine', value: structuredClone(SP) }];
    // The tracker read reply 1 and marked a criterion; the batch is stored on reply 3.
    chat[3].extra.narrator.track = { covers: [{ mid: chat[1].narrator_id, hash: hash(visibleText(chat[1])) }, { mid: chat[3].narrator_id, hash: hash(visibleText(chat[3])) }],
        delta: { readings: [{ ending: 'e1', reading: 'toward', exchange: 1 }], marks: [{ id: 'e1-c1', mark: 'met', quote: 'She trusts him now.', exchange: 1 }], happened: [] }, rejected: [] };
    logOp(chat[3], { kind: 'conclusion', by: 'director', milestone: 'm1', text: 'She spoke first.' });
    // The player saved the spine (an older copy: everything open, m1 not concluded), retitled e1 and edited a text.
    const saved = structuredClone(SP); saved.endings[0].title = 'Earned trust'; saved.endings[0].criteria[1].text = 'she shares a meal with him';
    logOp(chat[3], { kind: 'edit', by: 'player', path: 'spine', value: saved, at: 9e15 });
    const view = () => replay(chat, { narrator: NARRATOR, setup: { player: 'Rowan' } });
    let sp = view().spine;
    assert.equal(sp.endings[0].title, 'Earned trust', 'the edit applies');
    assert.equal(sp.endings[0].criteria[1].text, 'she shares a meal with him');
    assert.equal(sp.endings[0].criteria[0].mark, 'met', 'the tracker\'s mark survives the older copy');
    assert.equal(sp.readings.length, 1, 'readings survive');
    assert.equal(sp.milestones[0].status, 'concluded', 'a concluded milestone stays concluded');
    // A redraft is a real replacement.
    logOp(chat[3], { kind: 'edit', by: 'player', path: 'spine', replace: true, value: structuredClone(SP), at: 9e15 + 1 });
    sp = view().spine;
    assert.equal(sp.endings[0].criteria[0].mark, 'open');
    assert.equal(sp.milestones[0].status, 'open');
});
