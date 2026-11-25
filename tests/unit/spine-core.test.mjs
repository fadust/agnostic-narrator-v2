// The spine's rules in code: marks in any order, readings per ending, scene-based state, conclusions, proposals.
// Records are written directly, so these tests do not depend on the observer's validator.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStoryBlock } from '../../core/brief.js';
import { chapters, leadingEnding, needsConclusion, needsNewEnding, spineForObserver, spineIds, spineState, spineTrigger } from '../../core/spine.js';
import { logOp, reconcile, replay, visibleText } from '../../core/state.js';
import { hash } from '../../core/util.js';
import { CONCLUSION_SYSTEM, SPINE_SYSTEM } from '../../core/prompts.js';
import { NARRATOR, makeHost, narr, user } from './helpers.mjs';

const SPINE = {
    question: 'Can the fallen prince take back what was stolen?',
    endings: [
        { id: 'e1', title: 'The rightful throne', how: 'by force', criteria: [{ id: 'e1-c1', text: 'loyalists rallied', mark: 'open' }, { id: 'e1-c2', text: 'the guard won over', mark: 'open' }] },
        { id: 'e2', title: 'The crown through marriage', how: 'by alliance', criteria: [{ id: 'e2-c1', text: 'the daughter trusts him', mark: 'open' }] },
    ],
    milestones: [
        { id: 'm1', title: 'Building first allies', status: 'open', conclusion: '', criteria: [
            { id: 'm1-c1', text: 'the house head trusts him', mark: 'open' }, { id: 'm1-c2', text: 'camaraderie with the knight commander', mark: 'open' },
            { id: 'm1-c3', text: 'fortune for mercenaries', mark: 'open' }] },
        { id: 'm2', title: 'The truth of the killing', status: 'open', conclusion: '', criteria: [{ id: 'm2-c1', text: 'he learns who gave the order', mark: 'open' }] },
    ],
};

/** A chat whose replies carry hand-written observations. `obs[i]` is the delta for narration i. */
function chatWith(replies) {
    // The drafted spine sits on an opening message, ahead of the replies whose findings it receives
    // (replay applies a message's own observation before the ops logged on it).
    const chat = [user('start')];
    replies.forEach((r, i) => {
        const m = narr(r.text);
        chat.push(m);
        chat.push(user(`player ${i}`));
        m._delta = { summary: `s${i}`, scene: r.location ? { location: { value: r.location, quote: r.text } } : {} };
        m._track = r.spine;
    });
    reconcile(chat, NARRATOR);
    for (const m of chat) {
        if (!m._delta) continue;
        m.extra.narrator.obs = { hash: hash(visibleText(m)), delta: m._delta, accepted: 1, rejected: [] };
        // The tracker's reading is its own record, beside the observer's: here a batch of one reply each.
        if (m._track) m.extra.narrator.track = { covers: [{ mid: m.narrator_id, hash: hash(visibleText(m)) }], delta: m._track, rejected: [] };
        delete m._delta; delete m._track;
    }
    chat[0].narrator_ops = [{ at: 1, by: 'setup', kind: 'spine', value: structuredClone(SPINE) }];
    return chat;
}
const view = (chat, opts) => replay(chat, { narrator: NARRATOR, setup: { player: 'Rowan' } }, opts);

test('criteria are marked in any order, readings decide the leading ending, and a quoted "against" turns one away', () => {
    const chat = chatWith([
        { text: 'The gate.', location: 'the gate', spine: { marks: [{ id: 'm1-c3', mark: 'met', quote: 'q' }], readings: [{ ending: 'e1', reading: 'toward' }, { ending: 'e2', reading: 'aside' }] } },
        { text: 'The hall.', spine: { marks: [{ id: 'm1-c1', mark: 'failed', quote: 'q' }, { id: 'nope', mark: 'met', quote: 'q' }], readings: [{ ending: 'e2', reading: 'toward' }] } },
        { text: 'The yard.', spine: { readings: [{ ending: 'e2', reading: 'against', quote: 'I refuse her' }] } },
    ]);
    const s = view(chat);
    const m1 = s.spine.milestones[0].criteria;
    assert.deepEqual(m1.map(c => c.mark), ['failed', 'open', 'met'], 'any order; an unknown id is ignored');
    assert.equal(m1[2].by, 'story');
    assert.deepEqual(s.spine.turnedAway, ['e2']);
    assert.equal(leadingEnding(s.spine), 'e1', 'a turned-away ending never leads');
    assert.equal(s.spine.readings.length, 3);
});

test('state comes from scenes: building while the scene builds, drifting when a scene closes with nothing, turning away on a quoted against', () => {
    const quiet = { readings: [{ ending: 'e1', reading: 'aside' }, { ending: 'e2', reading: 'aside' }] };
    const chat = chatWith([
        { text: 'A meal at the inn.', location: 'the inn', spine: quiet },
        { text: 'More talk at the inn.', spine: quiet },
        { text: 'Off to the market.', location: 'the market', spine: quiet },
    ]);
    let s = view(chat);
    assert.equal(spineState(s.spine), 'drifting', 'the inn scene closed with nothing built');
    assert.equal(spineTrigger({ ...s, meta: { ...s.meta, lastPlanTurn: 1 } }), 'drifting');
    assert.equal(spineTrigger({ ...s, meta: { ...s.meta, lastPlanTurn: 3 } }), null, 'already planned since');
    const chat2 = chatWith([
        { text: 'A meal at the inn.', location: 'the inn', spine: quiet },
        { text: 'He asks the commander to spar.', spine: { readings: [{ ending: 'e1', reading: 'toward' }] } },
    ]);
    assert.equal(spineState(view(chat2).spine), 'building', 'one toward in the scene is enough; nothing is counted');
    const chat3 = chatWith([{ text: 'He burns the letter.', location: 'the inn', spine: { readings: [{ ending: 'e1', reading: 'against', quote: 'burns' }] } }]);
    assert.equal(spineState(view(chat3).spine), 'turning away');
});

test('a re-plan that renames scenes does not close one; the scene ends when its beats run out (no re-plan loop)', () => {
    const quiet = { readings: [{ ending: 'e1', reading: 'aside' }, { ending: 'e2', reading: 'aside' }] };
    const chat = chatWith([
        { text: 'A meal at the inn.', location: 'the inn', spine: quiet },
        { text: 'Talk over ale at the inn.', spine: quiet },
        { text: 'Dice at the inn.', spine: quiet },
    ]);
    const plan = (at, scene) => ({ at, by: 'player', kind: 'plan', seq: at, value: { scenes: [{ id: scene, purpose: 'p' }], beats: [{ scene, intent: 'a quiet meal', type: 'release' }] } });
    chat[0].narrator_ops.push(plan(2, 's1'));
    chat[2].narrator_ops = [plan(3, 'renamed')]; // a re-plan between the first and second reply, with a new scene id
    let s = view(chat);
    assert.equal(s.spine.lastClosed, null, 'the re-plan did not close the scene');
    assert.equal(spineTrigger(s), null, 'so no drifting re-plan, and no loop');
    // The second reply completes the only beat of the planner's scene: the scene is over, and the third reply opens a new one.
    const active = view(chat, { upto: 3 }).beats.find(b => b.status === 'queued');
    Object.assign(chat[3].extra.narrator.obs, { beat: active.id });
    chat[3].extra.narrator.obs.delta.direction = { beat: 'complete', clues_found: [] };
    s = view(chat);
    assert.equal(s.spine.lastClosed, 'drifting', 'the finished scene closed with nothing built');
});

test('a resolved checklist waits for its conclusion; the conclusion drops the checklist and reaches the narrator', () => {
    const chat = chatWith([
        { text: 'One.', location: 'the hall', spine: { marks: [{ id: 'm1-c1', mark: 'failed', quote: 'q' }, { id: 'm1-c2', mark: 'met', quote: 'q' }] } },
        { text: 'Two.', spine: { marks: [{ id: 'm1-c3', mark: 'met', quote: 'q' }] } },
    ]);
    let s = view(chat);
    assert.deepEqual(needsConclusion(s).map(m => m.id), ['m1']);
    assert.ok(!buildStoryBlock(s).text.includes('Chapters so far'), 'nothing is sent before a milestone concludes');
    logOp(chat[3], { kind: 'conclusion', by: 'director', milestone: 'm1', text: 'His first allies came from below the high table.' });
    s = view(chat);
    const m1 = s.spine.milestones[0];
    assert.equal(m1.status, 'concluded');
    assert.deepEqual(m1.criteria, [], 'the checklist is dropped');
    assert.deepEqual(chapters(s).map(c => c.title), ['Building first allies']);
    assert.ok(buildStoryBlock(s).text.includes('Chapters so far:\n- Building first allies: His first allies came'));
    assert.ok(!spineForObserver(s).milestones.some(m => m.id === 'm1'), 'the observer no longer sees it');
    // Swiping the reply that concluded it reopens the milestone with its checklist.
    chat[3].mes = 'Two, swiped.';
    reconcile(chat, NARRATOR);
    s = view(chat);
    assert.equal(s.spine.milestones[0].status, 'open');
    assert.equal(s.spine.milestones[0].criteria.length, 3);
});

test('the player marks, reopens and concludes; the observer sees only open criteria of the first open milestones', () => {
    const chat = chatWith([{ text: 'One.', location: 'the hall' }]);
    logOp(chat[2], { kind: 'spine-mark', by: 'player', id: 'm2-c1', mark: 'met' });
    let s = view(chat);
    assert.equal(s.spine.milestones[1].criteria[0].by, 'player');
    assert.ok(!spineIds(s).criterionIds.includes('m2-c1'), 'resolved criteria are not offered to the observer');
    logOp(chat[2], { kind: 'spine-mark', by: 'player', id: 'm2-c1', mark: 'open' });
    logOp(chat[2], { kind: 'spine-conclude', by: 'player', milestone: 'm1' });
    s = view(chat);
    assert.equal(s.spine.milestones[1].criteria[0].mark, 'open', 'reopened');
    assert.deepEqual(s.spine.milestones[0].criteria.map(c => c.mark), ['failed', 'failed', 'failed'], 'Conclude now fails what is open');
    assert.deepEqual(needsConclusion(s).map(m => m.id), ['m1']);
});

test('the whole loop through the director: drafted after the arc, marked by the observer, concluded, sent as a chapter', async () => {
    const chat = [narr('The story opens at the gate of the noble house.'), user('I report for work.')];
    const { director, host } = makeHost(chat, { settings: { trackEvery: 1 } });
    host.material = async () => '[Scenario]\nThe king and queen were murdered; the prince now serves a noble house as a hired hand.';
    const reply = 'Ser Corwin claps him on the shoulder like a brother. The river contract pays out in gold.';
    let observed = 0, concluded = 0;
    const call = host.call;
    host.call = async (module, messages, ...rest) => {
        const system = messages[0].content;
        if (module === 'planner' && system.startsWith(SPINE_SYSTEM)) {
            return JSON.stringify({ question: 'Can he take it back?', endings: [{ title: 'Throne', how: 'force', criteria: ['loyalists rallied'] }, { title: 'Marriage', how: 'alliance', criteria: ['the daughter trusts him'] }],
                milestones: [{ title: 'Building first allies', criteria: ['camaraderie with the knight commander', 'fortune for mercenaries'] }] });
        }
        if (module === 'summariser' && system.startsWith(CONCLUSION_SYSTEM)) { concluded++; return JSON.stringify({ conclusion: 'He found a brother in Ser Corwin and gold for swords.' }); }
        if (module === 'observer') assert.ok(!messages[1].content.includes('m1-c1'), 'the observer never sees the spine');
        if (module === 'tracker-check') return JSON.stringify({ verdicts: ['m1-c1', 'm1-c2'].map(id => ({ id, verdict: 'confirm' })) });
        if (module === 'tracker' && messages[1].content.includes(reply)) {
            observed++;
            assert.ok(messages[1].content.includes('m1-c1') && messages[1].content.includes('I report for work.'), 'the tracker sees open criteria and the player\'s message');
            return JSON.stringify({
                readings: [{ ending: 'e1', reading: 'toward' }, { ending: 'e2', reading: 'aside' }],
                marks: [{ id: 'm1-c1', mark: 'met', evidence: 'shown', quote: 'Ser Corwin claps him on the shoulder like a brother' }, { id: 'm1-c2', mark: 'met', evidence: 'occurred', quote: 'pays out in gold' }],
            });
        }
        return call(module, messages, ...rest);
    };
    await director.kick();
    assert.equal(director.view().spine?.question, 'Can he take it back?', 'drafted after the arc');
    chat.push(narr(reply), user('I thank him.'));
    await director.kick();
    const s = director.view();
    assert.equal(observed, 1);
    assert.equal(concluded, 1, 'the resolved milestone got its conclusion');
    assert.equal(s.spine.milestones[0].status, 'concluded');
    assert.equal(spineState(s.spine), 'building');
    assert.ok(buildStoryBlock(s).text.includes('- Building first allies: He found a brother in Ser Corwin'));
});

/** A director with a drafted spine and a scripted tracker; returns the tracker calls it receives. */
async function spinedDirector(chat, settings, answer) {
    const { director, host } = makeHost(chat, { settings });
    host.material = async () => '[Scenario]\nThe king and queen were murdered; the prince now serves a noble house as a hired hand.';
    const calls = [];
    const call = host.call;
    host.call = async (module, messages, ...rest) => {
        if (module === 'planner' && messages[0].content.startsWith(SPINE_SYSTEM)) return JSON.stringify({ question: 'q', endings: [{ title: 'Throne', criteria: ['loyalists rallied'] }, { title: 'Marriage', criteria: ['the daughter trusts him'] }], milestones: [{ title: 'Allies', criteria: ['the commander stands with him', 'gold for swords'] }] });
        if (module === 'tracker') { calls.push(messages[1].content); return JSON.stringify(answer(messages[1].content)); }
        if (module === 'tracker-check') return JSON.stringify({ verdicts: ['m1-c1', 'm1-c2'].map(id => ({ id, verdict: 'confirm' })) });
        return call(module, messages, ...rest);
    };
    await director.kick();
    return { director, calls };
}

test('the tracker waits for N answered replies, reads them in one call, and puts each finding on its own reply', async () => {
    const chat = [narr('The story opens at the gate of the noble house.'), user('I report for work.')];
    const { director, calls } = await spinedDirector(chat, { trackEvery: 2 }, () => ({
        readings: [{ ending: 'e1', reading: 'toward', exchange: 1 }, { ending: 'e2', reading: 'aside' }],
        marks: [{ id: 'm1-c1', mark: 'met', evidence: 'occurred', quote: 'Ser Corwin swears to stand with him' }, { id: 'm1-c2', mark: 'met', evidence: 'occurred', exchange: 2, quote: 'a purse of gold' }],
    }));
    chat.push(narr('In the barracks Ser Corwin swears to stand with him.'), user('I nod.'));
    await director.kick();
    assert.equal(calls.length, 0, 'one answered reply waits; N is 2');
    chat.push(narr('Later, at the market, a merchant presses a purse of gold into his hand.'), user('I take it.'));
    await director.kick();
    assert.equal(calls.length, 1, 'two replies, one call');
    assert.ok(calls[0].includes('## EXCHANGE 1') && calls[0].includes('## EXCHANGE 2') && calls[0].includes('I nod.'));
    const s = director.view();
    const [c1, c2] = s.spine.milestones[0].criteria.length ? s.spine.milestones[0].criteria : [{}, {}];
    assert.equal(c1.source, chat[2].narrator_id, 'placed on exchange 1 by where its quote is');
    assert.equal(c2.source, chat[4].narrator_id);
    const carrier = chat[4].extra.narrator.track;
    assert.deepEqual(carrier.covers.map(c => c.mid), [chat[2].narrator_id, chat[4].narrator_id], 'stored on the last reply of the batch');
    // Editing a covered reply voids the batch; both replies wait again.
    chat[2].mes = 'In the barracks Ser Corwin nods, nothing more.';
    director.sync();
    assert.ok(!director.view().spine.milestones[0].criteria.some(c => c.mark === 'met'));
});

/** Does the observer's call overlap the tracker's? The observer waits briefly for the tracker to start. */
async function overlapWith(profiles) {
    const chat = [narr('The story opens at the gate of the noble house.'), user('I report for work.')];
    let trackerStarted, overlapped = false;
    const started = new Promise(r => { trackerStarted = r; });
    let watching = false;
    const { director, host } = makeHost(chat, {
        settings: { trackEvery: 1, profiles },
        // The observer's call waits up to 150 ms for the tracker's call to begin: it only can if they run side by side.
        gate: async (module) => {
            if (module === 'observer' && watching) overlapped = await Promise.race([started.then(() => true), new Promise(r => setTimeout(() => r(false), 150))]);
        },
    });
    host.material = async () => '[Scenario]\nThe king and queen were murdered; the prince now serves a noble house as a hired hand.';
    const call = host.call;
    host.call = async (module, messages, ...rest) => {
        if (module === 'planner' && messages[0].content.startsWith(SPINE_SYSTEM)) return JSON.stringify({ question: 'q', endings: [{ title: 'Throne', criteria: ['loyalists rallied'] }, { title: 'Marriage', criteria: ['the daughter trusts him'] }], milestones: [{ title: 'Allies', criteria: ['the commander stands with him'] }] });
        if (module === 'tracker') { trackerStarted(); return JSON.stringify({ readings: [{ ending: 'e1', reading: 'toward', quote: 'Ser Corwin trains him in the yard' }] }); }
        return call(module, messages, ...rest);
    };
    await director.kick();
    // One reply the player has answered, unread by both: the observer and the tracker each have work in the same pass.
    chat.push(narr('Ser Corwin trains him in the yard.'), user('I keep at it.'));
    watching = true;
    await director.kick();
    return { overlapped, view: director.view() };
}

test('the observer and the tracker run side by side on different profiles, and in turn on one profile', async () => {
    const apart = await overlapWith({ observer: 'profile-a', tracker: 'profile-b' });
    assert.equal(apart.overlapped, true, 'different profiles: both calls in flight together');
    assert.equal(spineState(apart.view.spine), 'building', 'and both results landed');
    assert.equal(apart.view.summaries.recent.length >= 1, true);
    const shared = await overlapWith({});
    assert.equal(shared.overlapped, false, 'one profile: the tracker waits for the observer');
    assert.equal(spineState(shared.view.spine), 'building');
});

test('a check on request reads what waits at once, the newest reply included', async () => {
    const chat = [narr('The story opens at the gate of the noble house.'), user('I report for work.')];
    const { director, calls } = await spinedDirector(chat, { trackEvery: 4 }, () => ({ readings: [{ ending: 'e1', reading: 'toward', quote: 'Ser Corwin watches him train in the yard' }] }));
    chat.push(narr('Ser Corwin watches him train in the yard.'));
    await director.kick();
    assert.equal(calls.length, 0, 'not answered yet, and fewer than N');
    await director.trackNow();
    assert.equal(calls.length, 1);
    assert.equal(spineState(director.view().spine), 'building');
    await director.trackNow();
    assert.equal(calls.length, 1, 'nothing left waiting: no call');
});

test('a failed ending criterion gets an alternative route; when every ending is turned away a new one is proposed and waits for the player', () => {
    const chat = chatWith([
        { text: 'One.', location: 'the hall', spine: { marks: [{ id: 'e2-c1', mark: 'failed', quote: 'q' }] } },
        { text: 'Two.', spine: { readings: [{ ending: 'e1', reading: 'against', quote: 'x' }, { ending: 'e2', reading: 'against', quote: 'y' }] } },
    ]);
    let s = view(chat);
    assert.equal(spineTrigger(s), 'every ending turned away');
    assert.ok(needsNewEnding(s.spine));
    logOp(chat[3], { kind: 'plan', by: 'director', seq: 1, value: {
        beats: [{ intent: 'x', type: 'choice' }],
        alternatives: [{ ending: 'e2', text: 'a marriage alliance with another house or kingdom' }, { ending: 'zz', text: 'ignored' }],
        new_ending: { title: 'A life of his own', how: 'renouncing', criteria: ['a safe place for those he loves'], reason: 'he refuses both' },
    } });
    s = view(chat);
    const e2 = s.spine.endings[1].criteria;
    assert.equal(e2.length, 2);
    assert.ok(e2[1].alternative && e2[0].mark === 'failed', 'the failed one stays as history');
    assert.equal(s.spine.proposal.title, 'A life of his own');
    assert.equal(s.spine.endings.length, 2, 'not added until the player accepts');
    // A later re-plan sees the same failure: it must not add a second alternative for it.
    logOp(chat[3], { kind: 'plan', by: 'director', seq: 2, at: Date.now() + 500, value: { beats: [{ intent: 'y', type: 'choice' }], alternatives: [{ ending: 'e2', text: 'a match arranged by the loyalists' }] } });
    assert.equal(view(chat).spine.endings[1].criteria.length, 2, 'one alternative per failed criterion');
    logOp(chat[3], { kind: 'spine-proposal', by: 'player', accept: true, at: Date.now() + 1000 }); // a click comes after the plan
    s = view(chat);
    assert.equal(s.spine.endings.length, 3);
    assert.equal(s.spine.proposal, null);
    assert.equal(s.spine.endings[2].criteria[0].text, 'a safe place for those he loves');
});

test('"Keep the current endings" sticks: no new proposal until the player turns away again', () => {
    const chat = chatWith([
        { text: 'One.', location: 'the hall', spine: { readings: [{ ending: 'e1', reading: 'against', quote: 'x' }, { ending: 'e2', reading: 'against', quote: 'y' }] } },
        { text: 'Two.' },
    ]);
    const propose = (at) => ({ at, by: 'director', kind: 'plan', seq: at, value: { beats: [{ intent: 'x', type: 'choice' }], new_ending: { title: 'A life of his own', criteria: ['a safe place'] } } });
    logOp(chat[1], propose(Date.now()));
    logOp(chat[1], { kind: 'spine-proposal', by: 'player', accept: false, at: Date.now() + 100 });
    let s = view(chat);
    assert.equal(s.spine.proposal, null);
    assert.equal(needsNewEnding(s.spine), false, 'dismissed');
    logOp(chat[2], propose(Date.now() + 200));
    s = view(chat);
    assert.equal(s.spine.proposal, null, 'a re-plan does not propose it again');
    assert.equal(spineTrigger(s), null);
});

test('a batch the tracker keeps failing on is passed over, so newer replies still get checked', async () => {
    const chat = [narr('The story opens at the gate of the noble house.'), user('I report for work.')];
    let fail = true;
    const { director, calls } = await spinedDirector(chat, { trackEvery: 1, maxRetries: 1 }, () => {
        if (fail) throw new Error('tracker down');
        return { readings: [{ ending: 'e1', reading: 'toward' }] };
    });
    chat.push(narr('A broken reply the tracker cannot read.'), user('a'));
    await director.kick();
    assert.equal(calls.length, 1, 'tried once, failed');
    fail = false;
    director.cool = {};
    chat.push(narr('Ser Corwin trains him in the yard.'), user('b'));
    await director.kick();
    assert.equal(calls.length, 2, 'the failed reply was passed over and the newer one was read');
    assert.ok(calls[1].includes('Ser Corwin trains him') && !calls[1].includes('A broken reply'));
});
