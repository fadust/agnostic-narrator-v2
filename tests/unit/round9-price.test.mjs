// Round 9 (owner, 21 Nov 2026): the price theme kept coming back through the arc, the spine, the tracker and wants.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialState, applyOp, applyDelta } from '../../core/state.js';
import { validatePlan } from '../../core/planner.js';
import { MOTIVE, PLAN_RULES, SPINE_SYSTEM, planPrompt, spinePrompt, trackerPrompt } from '../../core/prompts.js';

const arcState = () => {
    const s = initialState({ player: 'Max' });
    s.genre = { dominant: 'drama' };
    s.arc = { goal: 'Get Elizabeth back on her feet', forces: ['the hunters'], act: 1, acts: 3, tension: 'low',
        payoff: { name: 'the reckoning', act: 3, hooks: [{ text: 'a seal', planted: false }, { text: 'the ledger', planted: true }] },
        endings: [{ title: 'The Ledger Closed', outcomes: { Elizabeth: 'pays him back' } }, { title: 'Fled', outcomes: {} }] };
    return s;
};

test('the planner sees the arc without its endings, and only hooks still to plant, numbered', () => {
    const user = planPrompt({ state: arcState(), loreKeys: [], reason: 'x' })[1].content;
    const arc = user.split('## Arc\n')[1].split('\n## ')[0];
    assert.match(arc, /goal: Get Elizabeth back on her feet/);
    assert.match(arc, /hooks still to plant: 1\. a seal/);
    assert.ok(!/ledger|Ledger Closed|pays him back/i.test(arc));
});

test('a completed beat plants the hook it names', () => {
    const s = arcState();
    const v = validatePlan({ beats: [{ scene: 's1', goal: 'the seal turns up', type: 'reveal', plants: 1 }, { scene: 's1', goal: 'b', type: 'release', plants: 2 }] }, s);
    assert.deepEqual(v.value.beats.map(b => b.plants), [1, 0], 'an already planted hook is not offered again');
    applyOp(s, { kind: 'plan', by: 'director', value: v.value }, { mid: 'aaa11111' }, []);
    const id = s.beats.find(b => b.plants === 1)?.id;
    assert.ok(id);
    applyDelta(s, { delta: { summary: 'x', direction: { beat: 'complete', clues_found: [] } }, beat: id, accepted: 0, rejected: [] }, { mid: 'bbb22222', i: 2 });
    assert.equal(s.arc.payoff.hooks[0].planted, true);
});

test('no payment in the motive wording or the spine example', () => {
    assert.ok(!/a price|at a price/.test(MOTIVE + PLAN_RULES));
    assert.match(MOTIVE, /never payment others demand/);
    assert.ok(!/owes him his life/.test(SPINE_SYSTEM));
});

test('settled reaches the tracker, the spine drafter and the planner\'s wants and criteria', () => {
    const s = arcState();
    s.settled = [{ id: 'st-1', text: 'Max wants nothing in return for his help', turn: 3, by: 'player' }];
    s.spine = { question: 'q', endings: [{ id: 'e1', title: 'E', criteria: [{ id: 'e1-c1', text: 'Elizabeth owes Max a debt', mark: 'open' }] }], milestones: [], readings: [], turnedAway: [], scene: {} };
    const tr = trackerPrompt({ state: s, exchanges: [{ player: 'p', reply: 'r' }] })[1].content;
    assert.match(tr, /## Settled by the player[^\n]*"settled": its id[^\n]*\n- \[st-1\] Max wants nothing in return/);
    const sp = spinePrompt({ material: 'm', genre: {}, premise: '', arc: s.arc, player: 'Max', settled: ['Max wants nothing in return for his help'],
        evidence: [['Earlier story memory', "They reached the cooper's room."]] })[1].content;
    assert.match(sp, /## Settled by the player[^\n]*\n- Max wants nothing in return/);
    assert.match(sp, /## Earlier story memory\nThey reached the cooper's room\./);
    assert.match(PLAN_RULES, /Never serve a spine criterion that a settled matter closes/);
    assert.match(PLAN_RULES, /A want that a settled matter answers counts as transformed/);
});
