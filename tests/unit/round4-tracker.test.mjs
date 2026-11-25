// Round 4 (18 November 2026): a harder "met" (evidence kind counted in code, two exchanges for lasting states) and a
// speaker on every quote, checked against the cast and the text around the quote.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trackerPrompt } from '../../core/prompts.js';
import { applySpineDelta, isLasting } from '../../core/spine.js';
import { speakerCheck, validateTracking } from '../../core/validate.js';

const SPINE = { endingIds: ['e1'], criterionIds: ['e1-c1', 'm1-c1', 'm1-c2'], milestoneIds: ['m1'], milestoneCriteria: { m1: ['m1-c1', 'm1-c2'] }, lastingIds: ['m1-c2'] };
const T1 = '"I stood at twelve for the mother," Corliss says. Elizabeth says nothing. Dorothy lets him take her arm.';
const T2 = 'At the cart Dorothy takes his hand without being asked and holds it the whole way.';

test('only an event that occurred or a state plainly shown counts toward "met"', () => {
    const v = validateTracking({ marks: [
        { id: 'e1-c1', mark: 'met', evidence: 'implied', quote: 'Elizabeth says nothing.' },
        { id: 'm1-c1', mark: 'met', quote: 'Elizabeth says nothing.' },
    ] }, { texts: [T1], spine: SPINE });
    assert.equal(v.delta.marks.length, 0);
    assert.deepEqual(v.rejected.map(r => r.reason), ['met: implied evidence does not count', 'met: no evidence kind']);
    const ok = validateTracking({ marks: [{ id: 'm1-c1', mark: 'met', evidence: 'occurred', quote: 'Elizabeth says nothing.' }] }, { texts: [T1], spine: SPINE });
    assert.equal(ok.delta.marks[0].evidence, 'occurred');
});

test('a lasting state needs two different exchanges: one is partly shown, a second completes it', () => {
    const one = validateTracking({ marks: [{ id: 'm1-c2', mark: 'met', evidence: 'shown', quote: 'Dorothy lets him take her arm.' }] }, { texts: [T1, T2], spine: SPINE });
    assert.equal(one.delta.marks[0].partial, true);
    const sameTwice = validateTracking({ marks: [{ id: 'm1-c2', mark: 'met', evidence: 'shown', exchange: 1, quote: 'Dorothy lets him take her arm.', also: { exchange: 1, quote: 'Elizabeth says nothing.' } }] }, { texts: [T1, T2], spine: SPINE });
    assert.equal(sameTwice.delta.marks[0].partial, true, 'the second showing must come from another exchange');
    const two = validateTracking({ marks: [{ id: 'm1-c2', mark: 'met', evidence: 'shown', exchange: 1, quote: 'Dorothy lets him take her arm.', also: { exchange: 2, quote: 'Dorothy takes his hand without being asked' } }] }, { texts: [T1, T2], spine: SPINE });
    assert.equal(two.delta.marks[0].partial, undefined);

    // Applied: a partial mark waits; a second partial from another reply completes the criterion.
    const crit = { id: 'm1-c2', text: 'Dorothy trusts him', mark: 'open' };
    const state = { meta: { turn: 3 }, spine: { endings: [], milestones: [{ id: 'm1', title: 'Trust', status: 'open', criteria: [crit] }], readings: [], turnedAway: [], scene: { key: null } } };
    applySpineDelta(state, { marks: [{ id: 'm1-c2', mark: 'met', quote: 'a', partial: true }] }, { mid: 'r1' }, 'k', true);
    assert.equal(crit.mark, 'open');
    assert.equal(crit.partial.source, 'r1');
    applySpineDelta(state, { marks: [{ id: 'm1-c2', mark: 'met', quote: 'b', partial: true }] }, { mid: 'r1' }, 'k', true);
    assert.equal(crit.mark, 'open', 'the same reply twice does not count');
    applySpineDelta(state, { marks: [{ id: 'm1-c2', mark: 'met', quote: 'c', partial: true }] }, { mid: 'r2' }, 'k', true);
    assert.equal(crit.mark, 'met');
});

test('the same recalled showing cannot complete a lasting criterion', () => {
    const criterion = { id: 'm1-c2', text: 'Dorothy trusts him', mark: 'open' };
    const state = { meta: { turn: 3 }, spine: { endings: [], milestones: [{ id: 'm1', status: 'open', criteria: [criterion] }],
        readings: [], turnedAway: [], scene: { key: null } } };
    const memory = { source: 'BaiBai Book', before: 2 };
    const mark = { id: criterion.id, mark: 'met', quote: 'Dorothy left the keys with him.', memory, partial: true };
    applySpineDelta(state, { marks: [mark] }, { mid: 'r1' }, 'here');
    applySpineDelta(state, { marks: [{ ...mark, memory: { ...memory, before: 3 } }] }, { mid: 'r2' }, 'here');
    assert.equal(criterion.mark, 'open');
    assert.deepEqual(criterion.partial.memory, memory);
    assert.equal(state.spine.scene.toward, undefined);
    applySpineDelta(state, { marks: [{ id: criterion.id, mark: 'met', quote: 'Dorothy lets him navigate the shoals.', partial: true }] }, { mid: 'r3' }, 'here');
    assert.equal(criterion.mark, 'met');
});

test('lasting criteria are told to the tracker, by the drafter\'s flag or by their wording', () => {
    assert.equal(isLasting({ text: 'Dorothy trusts him' }), true);
    assert.equal(isLasting({ text: 'Max holds the amended writ' }), false);
    assert.equal(isLasting({ text: 'Max holds the amended writ', lasting: true }), true);
    const state = { cast: { Dorothy: {} }, meta: { player: 'Max' }, spine: { endings: [], milestones: [{ id: 'm1', title: 'Trust', status: 'open', criteria: [{ id: 'm1-c1', text: 'Dorothy trusts him', mark: 'open', partial: { source: 'x' } }] }] } };
    const u = trackerPrompt({ state, exchanges: [{ player: 'p', reply: 'r' }] })[1].content;
    assert.match(u, /m1-c1: Dorothy trusts him \(lasting\) \(partly shown once already\)/);
    assert.match(u, /## Cast\nDorothy, Max/);
});

test('the speaker is kept only when it is a known name found at the quote, or "you" for the player character', () => {
    const who = speakerCheck(['Corliss', 'Elizabeth Juringen', 'Dorothy Juringen'], 'Max');
    assert.equal(who('Corliss', T1, 'I stood at twelve for the mother'), 'Corliss');
    assert.equal(who('Elizabeth', T1, 'Elizabeth says nothing.'), 'Elizabeth Juringen', 'a first name resolves to the cast name');
    assert.equal(who('Hobbs', T1, 'Elizabeth says nothing.'), '', 'unknown names are dropped');
    assert.equal(who('Corliss', T2, 'Dorothy takes his hand'), '', 'a known name not near the quote is dropped');
    assert.equal(who('Max', 'You fold the writ and put it inside your coat.', 'You fold the writ'), 'Max');
    const v = validateTracking({ marks: [{ id: 'm1-c1', mark: 'met', evidence: 'occurred', quote: 'I stood at twelve for the mother', by: 'Corliss' }] }, { texts: [T1], spine: SPINE, names: ['Corliss'], player: 'Max' });
    assert.equal(v.delta.marks[0].speaker, 'Corliss');
});

test('the conclusion writer gets each quote with its speaker, and is told not to guess one', async () => {
    const { CONCLUSION_SYSTEM, conclusionPrompt } = await import('../../core/prompts.js');
    const milestone = { title: 'First Ally', criteria: [{ text: 'Max learns who backs the auction', mark: 'met', quote: 'I stood at twelve for the mother', speaker: 'Corliss' }, { text: 'Elizabeth speaks to him', mark: 'met', quote: 'My husband owed' }], happened: { quote: 'My husband owed', speaker: 'Elizabeth Juringen' } };
    const u = conclusionPrompt({ milestone, player: 'Max', genre: {} })[1].content;
    assert.match(u, /\(narration, Corliss: "I stood at twelve for the mother"\)/);
    assert.match(u, /\(narration: "My husband owed"\)/);
    assert.match(u, /Elizabeth Juringen: "My husband owed"/);
    assert.match(CONCLUSION_SYSTEM, /never put it in a particular person's mouth/);
});
