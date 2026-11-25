// Round 5 (18 November 2026): the observer goes first in a profile's queue (W0), and a second check before "met" (W4).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Director } from '../../core/director.js';
import { trackCheckPrompt } from '../../core/prompts.js';
import { logOp, storyBasis } from '../../core/state.js';
import { applyTrackCheck, aroundQuote, validateEvidenceCheck } from '../../core/validate.js';
import { makeHost, NARRATOR, narr, user } from './helpers.mjs';

function hostWith(call, settings = {}) {
    return {
        chat: () => [], narrator: () => NARRATOR, setup: () => ({}), setSetup: () => { },
        settings: () => ({ cadence: 0, ...settings }), save: () => { }, changed: () => { }, call,
    };
}

test('an observer call goes ahead of queued background calls, never ahead of a running one', async () => {
    const order = [];
    let release;
    const first = new Promise(r => { release = r; });
    const d = new Director(hostWith(async (role, messages) => {
        order.push(messages[0].content);
        if (messages[0].content === 'planner-1') await first;
        return 'ok';
    }));
    const p1 = d.model('planner', [{ content: 'planner-1' }]);
    const p2 = d.model('tracker', [{ content: 'tracker-1' }]);
    const p3 = d.model('planner', [{ content: 'planner-2' }]);
    const o1 = d.model('observer', [{ content: 'observer-1' }]);
    const o2 = d.model('observer', [{ content: 'observer-2' }]);
    release();
    await Promise.all([p1, p2, p3, o1, o2]);
    assert.deepEqual(order, ['planner-1', 'observer-1', 'observer-2', 'tracker-1', 'planner-2']);
});

test('separate profiles do not wait for each other; a check call uses its parent role\'s profile and limit', async () => {
    const seen = [];
    const d = new Director(hostWith(async (role, messages, max) => { seen.push([role, max]); return 'ok'; }, { profiles: { tracker: 'cheap' }, tokens: { tracker: 600 } }));
    await d.model('tracker-check', [{ content: 'x' }]);
    assert.deepEqual(seen, [['tracker-check', 600]]);
    assert.equal(d.usage['tracker-check'].calls, 1, 'logged apart from the tracker');
    assert.ok(d.queues.has('cheap'));
});

const V = () => ({
    delta: {
        readings: [],
        marks: [
            { id: 'm1-c1', mark: 'met', quote: 'the bailiff makes the tally', exchange: 1 },
            { id: 'm1-c2', mark: 'met', quote: 'Elizabeth asks him plainly', exchange: 1, speaker: 'Elizabeth' },
            { id: 'e1-c1', mark: 'failed', quote: 'the house burns', exchange: 1, reason: 'the house is gone for good' },
        ],
        happened: [{ milestone: 'm1', quote: 'the bailiff makes the tally', exchange: 1 }],
    },
    rejected: [], accepted: 4,
});

test('only confirmed claims stand, and a milestone needs both its own verdict and criterion support', () => {
    const verdicts = validateEvidenceCheck({ verdicts: [
        { id: 'm1-c1', verdict: 'reject', reason: 'a tally, not the forfeit satisfied' },
        { id: 'm1-c2', verdict: 'confirm' },
        { id: 'e1-c1', verdict: 'confirm' },
        { id: 'm1', verdict: 'confirm' },
        { id: 'zz', verdict: 'reject', reason: 'unknown id' },
    ] }, ['m1-c1', 'm1-c2', 'e1-c1', 'm1']).value;
    assert.deepEqual(Object.keys(verdicts), ['m1-c1', 'm1-c2', 'e1-c1', 'm1']);
    const out = applyTrackCheck(V(), verdicts, { m1: ['m1-c1', 'm1-c2'] });
    assert.deepEqual(out.delta.marks.map(m => m.id), ['m1-c2', 'e1-c1']);
    assert.equal(out.delta.happened.length, 1, 'm1-c2 is still met, so the turning point stands');
    assert.equal(out.rejected[0].reason, 'check: a tally, not the forfeit satisfied');

    delete verdicts.m1;
    assert.equal(applyTrackCheck(V(), verdicts, { m1: ['m1-c1', 'm1-c2'] }).delta.happened.length, 0);
    const both = applyTrackCheck(V(), { m1: { verdict: 'confirm' } }, { m1: ['m1-c1', 'm1-c2'] });
    assert.equal(both.delta.happened.length, 0);
    assert.equal(both.accepted, 0);
    assert.equal(both.delta.marks.length, 0, 'even a quoted failure needs a verdict');
});

test('checkMarks: no quoted claim, no call; a failed check leaves the criteria open', async () => {
    const calls = [];
    const state = { spine: { endings: [], milestones: [{ id: 'm1', title: 'T', status: 'open', criteria: [{ id: 'm1-c1', text: 'The forfeit is satisfied', mark: 'open' }, { id: 'm1-c2', text: 'Elizabeth has asked Max', mark: 'open' }] }] } };
    const ids = { milestoneCriteria: { m1: ['m1-c1', 'm1-c2'] } };
    const quiet = new Director(hostWith(async () => { calls.push(1); return '{}'; }));
    const none = { delta: { readings: [], marks: [], happened: [] }, rejected: [], accepted: 0 };
    assert.equal(await quiet.checkMarks(none, ['t'], state, ids), none);
    assert.equal(calls.length, 0);

    const broken = new Director(hostWith(async () => ''));
    const v = V();
    assert.equal((await broken.checkMarks(v, ['text'], state, ids)).accepted, 0);

    const judge = new Director(hostWith(async (role, messages) => {
        assert.equal(role, 'tracker-check');
        assert.match(messages[1].content, /Criterion: The forfeit is satisfied/);
        assert.match(messages[1].content, /Speaks or acts in the quote: Elizabeth/);
        assert.match(messages[1].content, /Claim: failed/);
        return JSON.stringify({ verdicts: [{ id: 'm1-c1', verdict: 'reject', reason: 'only a tally' }, { id: 'm1-c2', verdict: 'confirm' }] });
    }));
    const out = await judge.checkMarks(V(), ['Then the bailiff makes the tally and Elizabeth asks him plainly.'], state, ids);
    assert.deepEqual(out.delta.marks.map(m => m.id), ['m1-c2']);
});

test('the check prompt carries only the marks, and the text around a quote', () => {
    const text = 'One. Two three four. Elizabeth asks him plainly what he means. Five six.';
    assert.match(aroundQuote(text, 'Elizabeth asks him plainly', 10), /four\. Elizabeth asks him plainly what he/);
    assert.equal(aroundQuote(text, 'not there'), 'not there');
    const [sys, user] = trackCheckPrompt({ items: [{ id: 'm1-c1', mark: 'met', criterion: 'C', quote: 'Q', context: 'X Q Y' }] });
    assert.match(sys.content, /someone other than the person the criterion names/);
    assert.match(user.content, /## MARK m1-c1\nClaim: met\nCriterion: C\nQuote: Q\nAround it: X Q Y\nSpeaks or acts in the quote: not known/);
});

test('a criterion cannot advance with two conflicting verdicts for its quote', () => {
    const { value } = validateEvidenceCheck({ verdicts: [
        { id: 'm1-c1', verdict: 'confirm' },
        { id: 'm1-c1', verdict: 'reject', reason: 'an unrelated action' },
    ] }, ['m1-c1']);
    assert.deepEqual(value, {});
});

test('the Observer only completes a beat when its quote proves the exact goal', async () => {
    const goal = 'Haruka says goodbye to Dachi before he leaves.';
    const addressee = 'Dachi has left. Haruka turns to Max, who is still kneeling.';
    const description = 'The wind rattles the latch. '.repeat(16);
    for (const [quote, verdicts, expected, leadIn = ''] of [
        ['Stand up, honey. Please.', [{ id: 'beat', verdict: 'reject', observed: 'Haruka asks Max to stand', reason: 'Haruka addresses Max' }], 'untouched', `${addressee}\n\n${description}`],
        ['Haruka tells Max to stand up.', [], 'untouched'],
        ['Haruka tells Max to stand up.', [{ id: 'beat', verdict: 'confirm' }], 'untouched'],
        ['Haruka tells Max to stand up.', [{ id: 'beat', verdict: 'confirm', observed: 'Haruka speaks to Max', target: { required: 'Dachi', actual: 'Max' }, reason: 'She speaks a final line' }], 'untouched'],
        ['Haruka bids Dachi goodbye at the door.', [{ id: 'beat', verdict: 'confirm', observed: 'Haruka bids Dachi goodbye', target: { required: 'Dachi', actual: 'Dachi' }, reason: 'She says goodbye to Dachi at the door' }], 'complete'],
    ]) {
        const chat = [user('I watch from the hall.')];
        logOp(chat[0], { by: 'player', kind: 'plan', value: { beats: [{ goal, pressure: 'Dachi reaches for the latch.', type: 'choice' }] } });
        const { director, host } = makeHost(chat, {
            script: () => ({ summary: 'Haruka speaks.', direction: { beat: 'complete', quote, source: 'reply' } }),
        });
        director.sync();
        const [beat] = director.view().beats;
        const reply = narr(leadIn + quote);
        reply.extra.narratorCue = { beat: beat.id, clues: [], basis: storyBasis(chat, NARRATOR) };
        chat.push(reply);
        const call = host.call;
        let evidencePrompt;
        host.call = async (module, messages, ...rest) => {
            if (module !== 'observer-check') return call(module, messages, ...rest);
            evidencePrompt = messages;
            return JSON.stringify({ verdicts });
        };
        director.sync();
        assert.equal(await director.observe(director.readings().entries.at(-1)), true);
        assert.ok(evidencePrompt[1].content.includes(goal));
        assert.ok(evidencePrompt[1].content.includes(quote));
        if (leadIn) {
            assert.match(evidencePrompt[0].content, /Do not assign an identity from the goal/);
            const sourceIndex = evidencePrompt[1].content.indexOf(addressee);
            assert.ok(sourceIndex >= 0, 'the addressee is established in earlier context');
            assert.ok(sourceIndex < evidencePrompt[1].content.indexOf(goal));
        }
        assert.equal(reply.extra.narrator.obs.delta.direction.beat, expected);
        assert.equal(reply.extra.narrator.obs.delta.summary, 'Haruka speaks.');
        assert.equal(director.view().beats[0].status, expected === 'complete' ? 'complete' : 'queued');
    }
});
