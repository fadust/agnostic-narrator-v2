// Round 5 (18 November 2026): one patience ladder (W2). Nudge an untaken opening once, retire it two turns later,
// re-plan when the scene stalls, refill when threads run low; timed re-plans off by default.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBrief } from '../../core/brief.js';
import { DEFAULTS } from '../../core/director.js';
import { planTrigger } from '../../core/planner.js';
import { initialState, storyBasis } from '../../core/state.js';
import { NARRATOR, fakeObserver, makeHost, narr, replyOf, user } from './helpers.mjs';

function playing(mode, extra = {}) {
    const chat = [narr('The story opens at the gate of Houshan.'), user('x'), narr('Ji Si waits beneath the arch tonight.')];
    let dir = mode;
    const host = makeHost(chat, {
        settings: { nudgeAfter: 3, stallAfter: 0, ...extra },
        script: (m, msgs) => ({ ...fakeObserver(replyOf(msgs)), facts: [], threads: [], direction: { beat: dir, source: 'reply', quote: replyOf(msgs) } }),
    });
    const turn = async (n = 1) => {
        for (let k = 0; k < n; k++) {
            const offered = buildBrief(host.director.view()).offered;
            const reply = narr(`Rain on the arch, beat ${chat.length}.`);
            chat.push(user('I wait.'));
            host.director.sync();
            reply.extra.narratorCue = { ...offered, basis: storyBasis(chat, NARRATOR) };
            chat.push(reply);
            await host.director.kick();
        }
    };
    return { ...host, chat, turn, set: (d) => { dir = d; } };
}

test('defaults: timed re-plans off, nudge after 3, stall after 5', () => {
    assert.equal(DEFAULTS.cadence, 0);
    assert.equal(DEFAULTS.nudgeAfter, 3);
    assert.equal(DEFAULTS.stallAfter, 5);
});

test('an untaken opening is nudged once, at the Nth untouched reply, and retired two turns later', async () => {
    const p = playing('untouched');
    await p.director.kick();
    const id = p.director.view().beats.find(b => b.status === 'queued').id;
    const waiting = () => p.director.view().beats.find(b => b.id === id);
    const nudged = () => 'waiting' in buildBrief(p.director.view()).lines;
    let seen = 0;
    for (let k = 0; k < 6 && waiting().status === 'queued'; k++) { await p.turn(); if (nudged() && waiting().id === id) seen++; }
    assert.equal(seen, 1, 'told once');
    assert.equal(waiting().status, 'skipped');
    assert.equal(waiting().offered, 5, 'retired at N + 2');
});

test('going elsewhere or moving toward it starts the count again; N = 0 never nudges', async () => {
    const p = playing('untouched');
    await p.director.kick();
    await p.turn(2);
    p.set('advanced');
    await p.turn();
    const b = p.director.view().beats.find(x => x.status === 'queued');
    assert.equal(b.waiting, 0);

    const s = initialState();
    s.meta.turn = 4;
    s.meta.nudgeAfter = 0;
    s.genre = { dominant: 'fantasy' };
    s.beats = [{ id: 'b1', status: 'queued', pressure: 'A stranger sells maps', goal: 'g', waiting: 3, clues: [] }];
    assert.ok(!('waiting' in buildBrief(s).lines));
    s.meta.nudgeAfter = 3;
    assert.match(buildBrief(s).lines.waiting, /still there/);
});

const base = () => {
    const s = initialState();
    s.genre = { dominant: 'fantasy' };
    s.arc = { goal: 'g' };
    s.meta.turn = 10;
    s.meta.lastPlanTurn = 2;
    s.beats = [{ status: 'queued' }, { status: 'queued' }];
    s.threads = [{ status: 'open' }, { status: 'open' }];
    return s;
};

test('stall: N quiet replies ask for a re-plan that brings something small; a request for quiet wins', () => {
    const s = base();
    s.meta.quiet = 4;
    assert.equal(planTrigger(s, { cadence: 0, stallAfter: 5 }), null, 'no timed re-plan by default');
    s.meta.quiet = 5;
    assert.match(planTrigger(s, { cadence: 0, stallAfter: 5 }), /^stalled: .*never cut the scene short/);
    assert.equal(planTrigger(s, { cadence: 0, stallAfter: 0 }), null, '0 turns it off');
    s.instructions = [{ text: 'let this scene breathe, slower please', turn: 9, planned: true }];
    assert.equal(planTrigger(s, { cadence: 0, stallAfter: 5 }), null);
    assert.equal(planTrigger(base(), { cadence: 6 }), 'cadence', 'a chosen cadence still works');
});

test('threads running low refill the queue before it runs dry, once per turn', () => {
    const s = base();
    s.beats = [{ status: 'queued' }];
    s.threads = [{ status: 'open' }];
    assert.match(planTrigger(s, { cadence: 0 }), /^threads running low/);
    s.meta.lastPlanTurn = 10;
    assert.equal(planTrigger(s, { cadence: 0 }), null);
});

test('a reply that records nothing new counts toward a stall; a fact or a plan resets it', async () => {
    const p = playing('untouched', { stallAfter: 0 });
    await p.director.kick();
    await p.turn(3);
    assert.equal(p.director.view().meta.quiet, 3);
    p.set('advanced');
    await p.turn();
    assert.equal(p.director.view().meta.quiet, 0);
});

test('a bare re-plan reaches the planner but never the narrator\'s notes', () => {
    const s = initialState();
    s.genre = { dominant: 'fantasy' };
    s.meta.turn = 3;
    s.instructions = [{ text: 're-plan from where the story stands', turn: 3, quiet: true }, { text: 'make it rain', turn: 3 }];
    assert.deepEqual(buildBrief(s).lines.player_request, ['make it rain']);
});

test('an unchanged location and minor background events are not "something new" (live, 19 Nov 2026)', async () => {
    const { applyDelta } = await import('../../core/state.js');
    const s = initialState({ player: 'Max' });
    s.scene.location = { value: 'the Hare and Hearth', established: true };
    const obs = (delta) => ({ delta: { summary: '', scene: {}, facts: [], confirmed: [], beliefs: [], relationships: [], stats: [], statuses: [], cast_changes: [], threads: [], lore: [], contradictions: [], direction: { beat: 'untouched', clues_found: [] }, ...delta }, accepted: 1, rejected: [] });
    const e = (n) => ({ mid: `m-${n}-aaaaaaaa`, i: n, text: 'Rain on the shutters.', committed: true });
    applyDelta(s, obs({ scene: { location: { value: 'the Hare and Hearth' } }, facts: [{ fact: 'Rain begins', kind: 'event', weight: 'minor' }] }), e(1));
    assert.equal(s.meta.quiet, 1);
    applyDelta(s, obs({ facts: [{ fact: 'Sennet tells Max where the house is', kind: 'knowledge', weight: 'major' }] }), e(2));
    assert.equal(s.meta.quiet, 0);
});
