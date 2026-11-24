// Round 10 (audit, 21 Nov 2026): identity and settled fixes found by replaying a long group play-test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialState, applyOp, applyDelta, statusIndex } from '../../core/state.js';
import { validateObservation, validateTracking } from '../../core/validate.js';
import { validatePlan, planTrigger } from '../../core/planner.js';
import { observerPrompt } from '../../core/prompts.js';

const stats = (n) => ({ strength: n, agility: n, endurance: n, intellect: n, perception: n, willpower: n, charisma: n });
const at = (mid) => ({ mid });

test('the player character re-profiles from new sources until the player sets the stats by hand', () => {
    const s = initialState({ player: 'Max' });
    applyOp(s, { kind: 'profile', by: 'setup', name: 'Max', pc: true, value: { summary: 'a man', stats: stats(40) }, cardHash: 'a' }, at('m1'), []);
    applyOp(s, { kind: 'profile', by: 'setup', name: 'Max', pc: true, force: true, aliases: ['Crimson Dragon', 'Max'], value: { summary: 'the Crimson Dragon', stats: stats(110) }, cardHash: 'b' }, at('m1'), []);
    assert.equal(s.cast.Max.stats.strength, 110, 'lore-backed sources replace the persona-only sheet');
    assert.deepEqual(s.cast.Max.aliases, ['Crimson Dragon']);
    applyOp(s, { kind: 'edit', by: 'player', path: 'cast.Max.stats', value: stats(70) }, at('m1'), []);
    applyOp(s, { kind: 'profile', by: 'setup', name: 'Max', pc: true, force: true, value: { summary: 'x', stats: stats(110) }, cardHash: 'c' }, at('m1'), []);
    assert.equal(s.cast.Max.stats.strength, 70, 'a hand-set sheet is never overwritten');
});

test('a story profile does not bring back a person whose introduction was swiped away', () => {
    const s = initialState({ player: 'Max' });
    applyOp(s, { kind: 'profile', by: 'setup', name: 'Arno', lore: true, story: true, value: { summary: 'collector', stats: stats(40) }, cardHash: 'h' }, at('m1'), []);
    assert.equal(s.cast.Arno, undefined);
    assert.equal(s.cards.Arno, undefined);
});

test('a known name is present only when the reply mentions them or they were already in the scene', () => {
    const ctx = { text: 'The street is empty. Brenn leans on the post.', names: ['Arno', 'Brenn', 'Kettle', 'Max'], player: 'Max', present: ['Kettle'] };
    const v = validateObservation({ summary: 'x', scene: { present: ['Arno', 'Brenn', 'Kettle'] } }, ctx);
    assert.deepEqual(v.delta.scene.present, ['Brenn', 'Kettle']);
    assert.ok(v.rejected.some(r => /not in the reply or the scene/.test(r.reason)));
});

test('other names from lorebook keys resolve to the person and reach the observer', () => {
    const ctx = { text: 'The Crimson Dragon steps in. Brenn flinches.', names: ['Max', 'Brenn'], player: 'Max', present: [], aliases: { 'Crimson Dragon': 'Max' } };
    const v = validateObservation({ summary: 'x', relationships: [{ who: 'Brenn', toward: 'Crimson Dragon', axis: 'trust', dir: 'up', weight: 'minor', category: 'action', quote: 'The Crimson Dragon steps in' }] }, ctx);
    assert.equal(v.delta.relationships[0]?.toward, 'Max');
    const s = initialState({ player: 'Max' });
    s.cast.Max = { pc: true, aliases: ['Crimson Dragon'], statuses: [], knows: [] };
    assert.match(observerPrompt({ state: s, reply: 'r', playerMessage: '', offered: {} })[1].content, /Max \(the player character; also called Crimson Dragon/);
});

test('a status under another wording is the same condition', () => {
    const list = [{ name: 'knee injury' }, { name: 'fever' }];
    assert.equal(statusIndex(list, 'infected knee wound'), 0);
    assert.equal(statusIndex(list, 'high fever'), 1);
    assert.equal(statusIndex(list, 'broken arm'), -1);
    assert.equal(statusIndex([{ name: 'left arm wound' }, { name: 'right arm cut' }], 'arm wound'), -1, 'two candidates: left unmatched');
});

test('a settled matter closes a spine criterion by its id, no quote needed', () => {
    const spine = { endingIds: ['e1'], criterionIds: ['e1-c1'], milestoneIds: [] };
    const v = validateTracking({ marks: [{ id: 'e1-c1', mark: 'failed', settled: 'st-abc' }] }, { texts: ['a', 'b'], spine, settledIds: ['st-abc'] });
    assert.deepEqual(v.delta.marks.map(m => [m.id, m.mark, m.exchange]), [['e1-c1', 'failed', 2]]);
    const bad = validateTracking({ marks: [{ id: 'e1-c1', mark: 'failed', settled: 'st-zzz' }] }, { texts: ['a'], spine, settledIds: ['st-abc'] });
    assert.ok(bad.rejected.some(r => /unknown settled/.test(r.reason)));
});

test('a settle on the same message as the latest plan still re-plans; settled from the story alone does not', () => {
    const s = initialState({ player: 'Max' });
    s.genre = { dominant: 'drama' }; s.arc = { goal: 'g', act: 1, endings: [] };
    s.beats = [{ id: 'b1', status: 'queued', goal: 'x', type: 'pressure' }, { id: 'b2', status: 'queued', goal: 'y', type: 'pressure' }];
    applyOp(s, { kind: 'plan', by: 'director', value: { beats: [], scenes: [] } }, at('m9'), []);
    s.beats = [{ id: 'b1', status: 'queued', goal: 'x', type: 'pressure' }, { id: 'b2', status: 'queued', goal: 'y', type: 'pressure' }];
    applyOp(s, { kind: 'settle', by: 'player', text: 'No more haggling' }, at('m9'), []);
    assert.match(planTrigger(s) ?? '', /^settled by the player: No more haggling/);
    const t = initialState({ player: 'Max' });
    t.genre = s.genre; t.arc = s.arc;
    t.beats = s.beats;
    const ctx = { text: 'Farren names his fee: ten silver.', names: ['Max', 'Farren'], player: 'Max', playerMessage: 'ok' };
    applyDelta(t, validateObservation({ summary: 'x', settled: [{ text: 'the fee is ten silver', quote: 'Farren names his fee' }] }, ctx), { mid: 'abcdef12', i: 1 });
    assert.equal(t.settled.length, 1);
    assert.ok(!/^settled/.test(planTrigger(t) ?? ''));
});

test('settled ids stay unique at the cap, and a 2-letter player quote does not count', () => {
    const s = initialState({ player: 'Max' });
    const texts = ['apples are red', 'the sea is cold', 'iron rusts fast', 'owls hunt at night', 'bread needs yeast', 'rivers find the sea', 'snow melts in spring', 'glass can shatter', 'wolves run in packs', 'copper turns green'];
    for (const text of texts) applyOp(s, { kind: 'settle', by: 'player', text }, at('same0000'), []);
    assert.equal(new Set(s.settled.map(x => x.id)).size, s.settled.length);
    const v = validateObservation({ summary: 'x', settled: [{ text: 'Max refuses', quote: 'no' }] }, { text: 'Rain.', names: ['Max'], player: 'Max', playerMessage: 'nothing for me' });
    assert.equal(v.delta.settled?.length ?? 0, 0);
});

test('three saved legacy advances replay the hook they already planted', () => {
    const s = initialState({ player: 'Max' });
    s.genre = { dominant: 'drama' };
    s.arc = { goal: 'g', act: 1, payoff: { name: 'p', hooks: [{ text: 'a seal', planted: false }] }, endings: [] };
    const v = validatePlan({ beats: [{ scene: 's1', goal: 'the seal turns up', type: 'reveal', plants: 1 }] }, s);
    applyOp(s, { kind: 'plan', by: 'director', value: v.value }, at('aaa11111'), []);
    const id = s.beats[0].id;
    for (const i of [2, 3, 4]) applyDelta(s, { delta: { summary: 'x', direction: { beat: 'advanced', clues_found: [] } }, beat: id, accepted: 0, rejected: [] }, { mid: `bbb2222${i}`, i });
    assert.equal(s.beats[0].status, 'complete');
    assert.equal(s.arc.payoff.hooks[0].planted, true);
});

test('a player goal needs the player’s evidence, and partial advances never plant its hook', () => {
    const s = initialState({ player: 'Max' });
    s.genre = { dominant: 'drama' };
    s.arc = { goal: 'g', act: 1, payoff: { name: 'p', hooks: [{ text: 'a seal', planted: false }] }, endings: [] };
    const plan = validatePlan({ beats: [{ goal: 'accept the granary job', pressure: 'Mira has a job on offer', goal_source: 'player', plants: 1 }] }, s);
    applyOp(s, { kind: 'plan', by: 'director', value: plan.value }, at('aaa11111'), []);
    const beat = s.beats[0];
    const text = 'Mira explains the terms and says Max has accepted.';
    const apply = (direction, playerMessage, i) => {
        const result = validateObservation({ direction }, { text, names: ['Max', 'Mira'], beatOffered: true, beatGoalSource: beat.goal_source, playerMessage });
        applyDelta(s, { ...result, beat: beat.id }, { mid: `reply-${i}`, i, text });
        return result.delta.direction;
    };
    assert.equal(apply({ beat: 'complete', source: 'reply', quote: text }, 'Tell me more.', 1).beat, 'untouched');
    assert.equal(apply({ beat: 'advanced', source: 'player', quote: 'I accept.' }, 'Tell me more.', 2).proof, null);
    for (let i = 3; i < 6; i++) apply({ beat: 'advanced', source: 'reply', quote: 'Mira explains the terms' }, 'Tell me more.', i);
    assert.equal(beat.progress, 3);
    assert.equal(beat.status, 'queued');
    assert.equal(s.arc.payoff.hooks[0].planted, false);
    const proof = apply({ beat: 'complete', source: 'player', quote: 'I accept the granary job.' }, 'I accept the granary job.', 6);
    assert.deepEqual(proof.proof, { source: 'player', quote: 'I accept the granary job.' });
    assert.equal(beat.status, 'complete');
    assert.equal(s.arc.payoff.hooks[0].planted, true);
});
