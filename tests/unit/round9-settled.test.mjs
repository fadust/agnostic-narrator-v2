// Round 9 (owner, 21 Nov 2026): a matter the player character has answered for good, or the player has had enough of,
// is settled. The planner never reopens it and the narrator's notes carry it. /director redraft is the safety valve.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialState, applyDelta, applyOp } from '../../core/state.js';
import { validateObservation } from '../../core/validate.js';
import { planTrigger } from '../../core/planner.js';
import { PLAN_RULES, arcPrompt, observerPrompt, planPrompt } from '../../core/prompts.js';
import { buildBrief } from '../../core/brief.js';
import { makeHost, narr, user } from './helpers.mjs';

const reply = 'Elizabeth stares at the door. "Just a helping hand," she repeats.';
const player = '"nothing, none, just a helping hand"';

test('a settled quote may come from the player\'s message or the reply, nowhere else', () => {
    const ctx = { text: reply, names: ['Elizabeth', 'Max'], player: 'Max', playerMessage: player };
    const v = validateObservation({ summary: 'x', settled: [
        { text: 'Max wants nothing in return for his help', quote: 'nothing, none, just a helping hand' },
        { text: 'Elizabeth stops asking', quote: 'Elizabeth stares at the door' },
    ] }, ctx);
    assert.deepEqual(v.delta.settled.map(s => s.from), ['player', 'story']);
    const bad = validateObservation({ summary: 'x', settled: [{ text: 'made up', quote: 'I will pay you in gold' }] }, ctx);
    assert.ok(bad.rejected.some(r => r.kind === 'settled' && /quote not in/.test(r.reason)));
});

test('settled matters are kept once, trigger a re-plan, and reach planner, observer and narrator', () => {
    const s = initialState({ player: 'Max' });
    s.genre = { dominant: 'drama' };
    s.arc = { goal: 'g', act: 1, endings: [] };
    s.beats = [{ id: 'b1', status: 'queued', goal: 'Elizabeth asks Max to restate the no-price promise', type: 'pressure' }];
    s.meta.turn = 5; s.meta.lastPlanTurn = 4;
    const ctx = { text: reply, names: ['Elizabeth', 'Max'], player: 'Max', playerMessage: player };
    const v = validateObservation({ summary: 'x', settled: [{ text: 'Max wants nothing in return for his help', quote: 'nothing, none, just a helping hand' }] }, ctx);
    applyDelta(s, v, { mid: 'abcdef123456', i: 3 });
    applyDelta(s, validateObservation({ summary: 'x', settled: [{ text: 'Max wants nothing in return for his help.', quote: 'Just a helping hand' }] }, ctx), { mid: 'bbcdef123456', i: 5 });
    assert.equal(s.settled.length, 1, 'a close rewording is the same matter');
    assert.match(planTrigger(s), /^settled by the player: Max wants nothing in return/);
    applyOp(s, { kind: 'plan', by: 'director', value: { beats: [], scenes: [] } }, { mid: 'bbcdef123456' }, []);
    assert.ok(!/^settled/.test(planTrigger(s) ?? ''), 'once planned around, it does not re-plan for it again');
    assert.match(planPrompt({ state: s, loreKeys: [], reason: 'x' })[1].content, /## Settled by the player \(closed: never reopen\)\n- Max wants nothing in return/);
    assert.match(PLAN_RULES, /Settled matters are closed/);
    assert.match(observerPrompt({ state: s, reply, playerMessage: player, offered: {} })[1].content, /## Settled \(already recorded\)/);
    assert.match(observerPrompt({ state: s, reply, playerMessage: player, offered: {} })[0].content, /"settled": a matter closed for good/);
    assert.match(buildBrief(s).text ?? JSON.stringify(buildBrief(s)), /settled: Max wants nothing in return/);
});

test('the player can settle and reopen by hand', () => {
    const s = initialState({ player: 'Max' });
    applyOp(s, { kind: 'settle', by: 'player', text: 'No more haggling over the price' }, { mid: 'ccc00000' }, []);
    assert.equal(s.settled[0].by, 'player');
    applyOp(s, { kind: 'unsettle', by: 'player', id: s.settled[0].id }, { mid: 'ccc00000' }, []);
    assert.equal(s.settled.length, 0);
});

test('/director redraft writes a fresh arc as a player edit and re-plans', async () => {
    const chat = [narr('The story opens at the gate of Houshan.'), user('I walk in.'), narr('Ji Si waits beneath the arch.')];
    const { director, state } = makeHost(chat);
    await director.kick();
    const before = director.view();
    assert.ok(before.arc, 'the first arc was drafted');
    const plans = state.calls.filter(c => c.module === 'planner').length;
    assert.ok((await director.redraftArc()).includes('arc'));
    const redraft = state.calls.filter(c => c.module === 'planner').slice(plans);
    assert.ok(redraft.some(c => /## Redraft\n/.test(c.messages[1].content)), 'the arc call says it is a redraft');
    assert.ok(redraft.some(c => !c.messages[0].content.includes('outline the arc')), 'a fresh plan follows');
    assert.match(arcPrompt({ state: before, loreKeys: [], redraft: true })[1].content, /Nothing settled may return as a force/);
});
