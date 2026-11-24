import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBrief, buildStoryBlock } from '../../core/brief.js';
import { extractJson } from '../../core/json.js';
import { rotate, validateArc, validateGenre, validatePlan, validateProfile } from '../../core/planner.js';
import { splitByCast, summaryView } from '../../core/record.js';
import { detectAttempt } from '../../core/social.js';
import { buildLorebook } from '../../core/lore.js';
import { bandOf, ensureCast, initialState, logOp, reconcile, replay, storyBasis } from '../../core/state.js';
import { planPrompt } from '../../core/prompts.js';
import { quoteMatches, stripDirector } from '../../core/text.js';
import { validateObservation } from '../../core/validate.js';
import { publicVars, writeVars } from '../../core/vars.js';
import { NARRATOR, fakeObserver, makeHost, narr, replyOf, user } from './helpers.mjs';

const ctx = { narrator: NARRATOR, setup: { player: 'Rowan', genre: { dominant: 'fantasy' } } };
const facts = (s) => s.canon.map(f => f.fact);

test('quote matching survives markup, punctuation and elision, and refuses invented quotes', () => {
    const text = '*The gate creaks.* "You owe the guild," Ji Si says — quietly.';
    assert.ok(quoteMatches('"You owe the guild," Ji Si says', text));
    assert.ok(quoteMatches('The gate creaks ... Ji Si says quietly', text));
    assert.ok(!quoteMatches('Ji Si draws a sword', text));
    assert.ok(!quoteMatches('the', text), 'a quote too short to be evidence is refused');
    assert.ok(quoteMatches('他欠商会的债', '季思说：“他欠商会的债。”'));
});

test('leaked director text is stripped, including an unclosed block', () => {
    assert.equal(stripDirector('<director_notes>\nmood: x\n</director_notes>\nThe rain falls.'), 'The rain falls.');
    assert.equal(stripDirector('The rain falls.\n<director_notes>\nmood: x'), 'The rain falls.');
});

test('json extraction handles fences, prose and cut-off output', () => {
    assert.deepEqual(extractJson('Sure!\n```json\n{"a": [1, 2,]}\n```').value, { a: [1, 2] });
    const cut = extractJson('{"summary": "x", "facts": [{"fact": "a", "quote": "b"}, {"fact": "c", "quo');
    assert.ok(cut.ok && cut.repaired);
    assert.equal(cut.value.facts[0].fact, 'a');
    assert.ok(!extractJson('no json here').ok);
});

test('a change whose quote is not in the reply is rejected; unknown keys and enums are refused', () => {
    const v = validateObservation({
        summary: 's', bogus: 1,
        facts: [{ fact: 'The gate is sealed', quote: 'The gate is sealed with wax', certainty: 'stated' }, { fact: 'Ji Si is a spy', quote: 'Ji Si is secretly a spy', certainty: 'stated' }],
        relationships: [{ who: 'Ji Si', toward: 'Rowan', axis: 'loyalty', dir: 'up', weight: 'minor', category: 'words', quote: 'The gate is sealed with wax' }],
    }, { text: 'The gate is sealed with wax. Ji Si waits.', names: ['Ji Si', 'Rowan'], player: 'Rowan' });
    assert.deepEqual(v.delta.facts.map(f => f.fact), ['The gate is sealed']);
    assert.equal(v.rejected.length, 3);
});

test('relationship movement is clamped per reply and a stage needs two kinds of evidence', () => {
    const s = initialState({ player: 'Rowan' });
    const c = ensureCast(s, 'Ji Si');
    const text = 'Ji Si thanks Rowan warmly. Ji Si shields Rowan from the blade.';
    const rel = (category, quote, weight = 'major') => ({ who: 'Ji Si', toward: 'Rowan', axis: 'trust', dir: 'up', weight, category, quote });
    const v = validateObservation({ relationships: [rel('words', 'Ji Si thanks Rowan warmly'), rel('action', 'Ji Si shields Rowan from the blade')] },
        { text, names: ['Ji Si', 'Rowan'], player: 'Rowan' });
    // Words count as minor whatever weight the observer gave (owner, 21 Nov 2026): 1 + 2 fits the cap of 4.
    assert.deepEqual(v.delta.relationships.map(r => r.weight), ['minor', 'major']);
    const over = validateObservation({ relationships: [rel('action', 'Ji Si shields Rowan from the blade', 'pivotal'), rel('words', 'Ji Si thanks Rowan warmly')] },
        { text, names: ['Ji Si', 'Rowan'], player: 'Rowan' });
    assert.equal(over.delta.relationships.length, 1, 'one axis moves at most four points per reply');
    assert.equal(c.stage, 'stranger');
    assert.equal(bandOf({ trust: 6, affection: 6 }), 'devoted');
});

test('swipe three times: only the active swipe applies, and nothing reaches the lorebook', async () => {
    const chat = [narr('The story opens at the gate of Houshan.'), user('I walk in.'), narr('Swipe one says the gate is red.')];
    const { director } = makeHost(chat, {
        script: (m, msgs) => {
            const reply = replyOf(msgs);
            return { ...fakeObserver(reply), lore: [{ keys: ['gate'], text: 'The gate.', kind: 'event', quote: reply.slice(0, 20) }] };
        },
    });
    await director.kick();
    for (const text of ['Swipe two says the gate is blue.', 'Swipe three says the gate is green.']) {
        chat[2].mes = text; // SillyTavern carries extra.narrator into the new swipe; the hash no longer matches
        await director.kick();
    }
    const s = director.view();
    assert.ok(facts(s).some(f => f.includes('green')));
    assert.ok(!facts(s).some(f => f.includes('red') || f.includes('blue')));
    const book = director.lorebook();
    assert.ok(!book.entries.some(e => /green|red|blue/.test(e.text) || e.source === chat[2].narrator_id), 'provisional lore stays out');
});

test('swipe then send at once: the commit carries the new swipe, and pending replies commit when read', async () => {
    const chat = [narr('The story opens at the gate of Houshan.'), user('I walk in.'), narr('Old swipe mentions a red door.')];
    let release;
    const gate = new Promise(r => { release = r; });
    let held = false;
    const { director } = makeHost(chat, { gate: async (m, msgs) => { if (replyOf(msgs)?.includes('green') && !held) { held = true; await gate; } } });
    await director.kick();
    chat[2].mes = 'New swipe mentions a green door.';
    const pass = director.kick();
    chat.push(user('I open it.'));               // the player sends before the director finishes
    director.sync();
    const during = director.view();
    assert.equal(during.meta.pending.length, 1, 'the reply is pending');
    const late = buildBrief(during);
    assert.ok(late.lagging && late.text.includes('one reply behind') && !late.text.includes('scene_intent'), 'the narrator gets older notes, marked, with no steering');
    assert.ok(!facts(during).some(f => f.includes('red')), 'the rejected swipe is gone');
    release();
    await pass;
    const after = director.view();
    assert.equal(after.meta.pending.length, 0);
    assert.ok(facts(after).some(f => f.includes('green')));
});

test('a reply edited while the director reads it: the stale result is discarded and the reply re-read', async () => {
    const chat = [narr('The innkeeper pours a cup of wine.')];
    let first = true;
    const { director, state } = makeHost(chat, { gate: async () => { if (first) { first = false; chat[0].mes = 'The innkeeper pours a cup of tea.'; } } });
    await director.kick();
    const s = director.view();
    assert.deepEqual(facts(s), ['The innkeeper pours a cup of tea']);
    assert.equal(state.calls.filter(c => c.module === 'observer').length, 2);
});

test('deleting the latest reply leaves committed state alone; deleting three back removes their state, summaries and lore', async () => {
    const chat = [
        narr('Ji Si arrives at the Houshan gate carrying a sealed letter.'), user('a'),
        narr('The Houshan gate guard waves Ji Si through at dusk.'), user('b'),
        narr('A merchant demands payment before the Houshan gate closes.'), user('c'),
        narr('Rain begins to fall on the market square.'),
    ];
    const { director } = makeHost(chat, {
        script: (m, msgs) => {
            const reply = replyOf(msgs);
            return { ...fakeObserver(reply), lore: reply.includes('Houshan') ? [{ keys: ['Houshan gate'], text: `Lore: ${reply}`, kind: 'place', quote: reply }] : [] };
        },
    });
    await director.kick();
    const full = director.view();
    assert.equal(full.canon.length, 4);
    assert.equal(director.lorebook().entries.length, 1, 'three committed mentions earn an entry');

    chat.pop();
    director.sync();
    const afterOne = director.view();
    assert.equal(afterOne.canon.length, 3, 'earlier committed state is unchanged');

    chat.splice(2, 3); // delete three messages back
    const r = director.sync();
    assert.equal(r.deleted.length, 3);
    const s = director.view();
    assert.deepEqual(facts(s), ['Ji Si arrives at the Houshan gate carrying a sealed letter']);
    assert.equal(s.summaries.recent.length, 1);
    assert.equal(director.lorebook().entries.length, 0, 'the entry lost its recurrence and is gone');
});

test('a branch rebuilds from its own messages: later plans and tombstones are absent', async () => {
    const chat = [narr('Ji Si arrives at the gate with a letter.'), user('a'), narr('The guard reads the letter aloud.'), user('b')];
    const { director } = makeHost(chat);
    await director.kick();
    const id = director.view().canon[1].id;
    director.playerOp({ kind: 'retcon', ids: [id] });
    assert.equal(director.view().canon.length, 1);
    const branch = JSON.parse(JSON.stringify(chat.slice(0, 3))); // branch before the retcon was logged
    const s = replay(branch, ctx);
    assert.equal(s.canon.length, 2);
    assert.equal(s.tombstones.length, 0);
});

test('a retconned fact does not return when the old message is re-extracted after an edit', async () => {
    const chat = [narr('The guard reads the letter aloud to the crowd.'), user('a'), narr('Night falls over the city walls.'), user('b')];
    const { director } = makeHost(chat);
    await director.kick();
    director.playerOp({ kind: 'retcon', ids: [director.view().canon[0].id] });
    assert.ok(!facts(director.view()).some(f => f.includes('letter')));
    chat[0].mes = 'The guard reads the letter aloud to the crowd. A dog barks twice nearby.';
    await director.kick();
    const s = director.view();
    assert.ok(!facts(s).some(f => f.includes('reads the letter')), 'tombstone holds');
    assert.ok(facts(s).some(f => f.includes('dog barks')));
    assert.ok(buildBrief(s).text.includes('did_not_happen'));
});

test('player edits survive a swipe; the director\'s plan made on the swiped reply does not', async () => {
    const chat = [narr('The story opens at the gate.'), user('I walk in.'), narr('A crowd gathers in the square.')];
    const { director } = makeHost(chat, { settings: { cadence: 6 } });
    await director.kick();
    assert.ok(director.view().beats.length, 'planner ran on the latest reply');
    director.playerOp({ kind: 'edit', path: 'scene.mood', value: 'festive' });
    chat[2].mes = 'A different crowd gathers by the river.';
    reconcile(chat, NARRATOR);
    const s = replay(chat, ctx, { includeProvisional: false });
    assert.equal(s.scene.mood, 'festive');
    assert.equal(s.beats.length, 0);
});

test('the brief carries one intent, never the queue; public variables carry no plan, clue or belief', async () => {
    const chat = [narr('The story opens at the gate of Houshan.'), user('I walk in.'), narr('Ji Si waits beneath the arch.')];
    const { director } = makeHost(chat, { settings: { cadence: 6 } });
    await director.kick();
    const s = director.view();
    assert.equal(s.beats.length, 2);
    const brief = buildBrief(s);
    assert.ok(brief.text.includes('let the debt surface'));
    assert.ok(!brief.text.includes('a quiet meal'), 'the next beat is not shown');
    assert.deepEqual(brief.offered.clues.length, 1);
    const vars = {};
    writeVars(vars, publicVars(s));
    const dump = JSON.stringify(vars);
    for (const secret of ['debt', 'seal', 'quiet meal', 'reckoning']) assert.ok(!dump.includes(secret), `${secret} leaked into variables`);
    assert.equal(vars.nar_genre_fantasy, '1');
});

test('passing an opening by once keeps the plan; walked past twice it is dropped and a re-plan follows, not within 3 turns of the last', async () => {
    const chat = [narr('The story opens at the gate of Houshan.'), user('x'), narr('Ji Si waits beneath the arch tonight.')];
    let mode = 'untouched';
    const { director, state } = makeHost(chat, {
        script: (m, msgs) => ({ ...fakeObserver(replyOf(msgs)), direction: { beat: mode, source: 'player', quote: 'I go my own way.' } }),
    });
    await director.kick();
    const plans = () => state.calls.filter(c => c.module === 'planner').length;
    const before = plans();
    mode = 'preempted';
    const turn = async (text) => {
        const offered = buildBrief(director.view()).offered;
        chat.push(user('I go my own way.'));
        director.sync();
        const reply = narr(text);
        reply.extra.narratorCue = { ...offered, basis: storyBasis(chat, NARRATOR) };
        chat.push(reply);
        await director.kick();
    };
    await turn('The road north is empty and cold tonight.');
    assert.equal(plans(), before, 'one pass-by: the plan stands (live, 21 Nov 2026)');
    await turn('Snow lies on the road north tonight.');
    const dropped = director.view().beats.filter(b => b.status === 'skipped').length;
    assert.ok(dropped >= 1, 'walked past twice: dropped');
    mode = 'untouched';
    for (let k = 0; k < 3 && plans() === before; k++) await turn(`The road bends west, mile ${k}.`);
    assert.ok(plans() > before, 'the dropped opening brings a re-plan once 3 turns have passed since the last');
});

test('beat rotation: never three pressure beats in a row', () => {
    const b = (type) => ({ type, intent: type });
    assert.deepEqual(rotate([b('pressure'), b('pressure'), b('pressure'), b('release')], []).map(x => x.type), ['pressure', 'pressure', 'release', 'pressure']);
    assert.equal(rotate([b('pressure')], ['pressure', 'pressure'])[0].type, 'release');
    assert.ok(!validateArc({ goal: 'g', endings: [{ title: 'only one' }] }).ok, 'a single ending is a script');
    assert.ok(!validatePlan({ beats: [] }, initialState()).ok);
});

test('attempt tiers appear only when stat, opponent and abilities are all clear', () => {
    const s = initialState({ player: 'Rowan' });
    ensureCast(s, 'Rowan').stats = { strength: 30, agility: 62, endurance: 30, intellect: 30, perception: 30, will: 30, presence: 30 };
    ensureCast(s, 'Captain Hale').stats = { strength: 65, agility: 40, endurance: 30, intellect: 30, perception: 30, will: 30, presence: 30 };
    s.scene.present = ['Captain Hale'];
    assert.equal(detectAttempt('I try to outrun Hale to the gate.', s).tier, 'trivial');
    assert.equal(detectAttempt('I wrestle Hale to the ground.', s).tier, 'beyond');
    assert.equal(detectAttempt('I run for the gate.', s), null, 'no opponent named: no tier');
    assert.equal(detectAttempt('I think about Hale.', s), null);
    const brief = buildBrief({ ...s, genre: {} }, { playerMessage: 'I wrestle Hale to the ground.' }).text;
    assert.ok(/attempt: .*beyond/.test(brief));
    assert.ok(!/\d/.test(brief), 'no number reaches the narrator');
});

test('summaries are injected only for messages that left the prompt, and roll-ups die with deleted messages', async () => {
    const chat = [];
    for (let i = 0; i < 5; i++) chat.push(narr(`Chapter ${i} happens in the valley today.`), user('next'));
    const { director } = makeHost(chat, { settings: { rollEvery: 3 }, firstIncluded: 6 });
    await director.kick();
    let s = director.view();
    assert.equal(s.summaries.rolled, 'Rolled summary.');
    assert.equal(s.summaries.recent.length, 2);
    assert.ok(!buildStoryBlock(s, { firstIncluded: 6 }).text.includes('Chapter 3'), 'still in the prompt: not summarised');
    chat.splice(0, 2);
    director.sync();
    s = director.view();
    assert.equal(s.summaries.rolled, '', 'the roll-up covered a deleted message');
    assert.ok(!chat.some(m => [...(m.narrator_ops ?? []), ...(m.extra?.narrator?.ops ?? [])].some(op => op.kind === 'rollup')));
});

test('hidden messages keep their committed record; other characters\' greetings are never read', async () => {
    const chat = [{ is_user: false, name: 'Ji Si', mes: 'Hello, I am Ji Si, a greeting from a cast card.', extra: {} }, narr('The story opens at the gate.'), user('go')];
    const { director, state } = makeHost(chat);
    await director.kick();
    assert.equal(state.calls.filter(c => c.module === 'observer').length, 1);
    chat[1].is_system = true;
    director.sync();
    assert.equal(director.view().canon.length, 1);
});

test('enabling the director on a long chat reads only the latest replies, but an edited old reply is always re-read', async () => {
    const chat = [];
    for (let i = 0; i < 10; i++) chat.push(narr(`Chapter ${i} unfolds along the river road.`), user('next'));
    const { director, state } = makeHost(chat, { settings: { backfill: 3 } });
    await director.kick();
    assert.equal(state.calls.filter(c => c.module === 'observer').length, 3);
    assert.ok(!director.view().meta.lagging, 'old unread replies do not hold the brief back');
    chat[14].mes = 'Chapter 7 now ends at the ferry crossing instead.';   // inside the window
    chat[0].mes = 'Chapter 0 is left as it was, never read.';              // outside it and never read: stays unread
    await director.kick();
    assert.ok(facts(director.view()).some(f => f.includes('ferry crossing')));
    // Make an old reply "read", then edit it: it must be read again although it is far outside the window.
    const { director: d2, state: s2 } = makeHost(chat, { settings: { backfill: 10 } });
    await d2.kick();
    d2.host.settings = () => ({ cadence: 0, backfill: 1 });
    chat[2].mes = 'Chapter 1 is rewritten: the bridge has fallen.';
    await d2.kick();
    assert.ok(facts(d2.view()).some(f => f.includes('bridge has fallen')), 'edited committed reply was re-read');
    void s2;
});

test('mixed genres accept smut and erotica without setting a content rating', () => {
    const genre = validateGenre({ dominant: 'Romance', secondary: ['Mystery', 'Smut', 'Erotica'], pg: true, explicit: true }).value;
    assert.deepEqual(genre.secondary, ['mystery', 'erotica']);
    const state = initialState({ genre });
    const { flags } = publicVars(state);
    for (const label of ['romance', 'mystery', 'erotica']) assert.equal(flags[`nar_genre_${label}`], '1');
    assert.equal(flags.nar_explicit, undefined);
    assert.equal(flags.nar_pg, undefined);
    assert.match(buildStoryBlock(state).text, /genre: romance \/ mystery \/ erotica/);
    assert.doesNotMatch(buildStoryBlock(state).text, /rating:|adult content|general-audience/i);
});

test('presence is additive: omission never removes anyone; leaving needs a quoted departure or a change of place', async () => {
    const chat = [
        narr('Elizabeth and Dorothy follow you through the door of the Blue Lantern.'), user('a'),
        narr('Bianca looks up from the counter. Dorothy gives a small wave.'), user('b'),
        narr('Dorothy slips out to fetch the bags. Bianca pours a drink.'), user('c'),
        narr('You and Bianca step out into the Harbor Market at dusk.'), user('d'),
    ];
    const present = [['Elizabeth', 'Dorothy'], ['Bianca', 'Dorothy'], ['Bianca'], ['Bianca']];
    let n = 0;
    const { director } = makeHost(chat, {
        script: (m, msgs) => {
            const reply = replyOf(msgs), i = n++;
            return {
                summary: 's', scene: { present: present[i], ...(i === 0 ? { location: { value: 'the Blue Lantern', quote: reply } } : i === 3 ? { location: { value: 'the Harbor Market', quote: reply } } : {}) },
                cast_changes: i === 2 ? [{ who: 'Dorothy', change: 'departed', quote: 'Dorothy slips out to fetch the bags' }] : [],
            };
        },
    });
    director.host.castNames = () => ['Elizabeth', 'Dorothy', 'Bianca'];
    await director.kick();
    const at = (upto) => director.view({ upto }).scene.present.slice().sort();
    assert.deepEqual(at(2), ['Dorothy', 'Elizabeth'], 'cast cards are known names before any profile exists');
    assert.deepEqual(at(4), ['Bianca', 'Dorothy', 'Elizabeth'], 'Elizabeth was not listed, and is still there');
    assert.deepEqual(at(6), ['Bianca', 'Elizabeth'], 'a quoted departure removes Dorothy');
    assert.deepEqual(at(8), ['Bianca'], 'a new place starts from the new list');
});

test('a card holding two people becomes two cast members; a card titled other than its person takes the person\'s name', async () => {
    const chat = [narr('Elizabeth and Dorothy follow you to the inn.'), user('a')];
    // What an earlier version recorded: the card's title as one cast member, in the scene.
    chat[0].narrator_ops = [
        { at: 1, by: 'setup', kind: 'profile', name: 'Elizabeth & Dorothy', value: { summary: 'Both of them.' }, cardHash: 'old' },
        { at: 2, by: 'player', kind: 'edit', path: 'scene.present', value: ['Elizabeth & Dorothy'] },
        { at: 3, by: 'setup', kind: 'profile', name: 'The Blue Lantern', value: { summary: 'The keeper.' }, cardHash: 'old' },
        { at: 4, by: 'player', kind: 'edit', path: 'cast.The Blue Lantern.rel.trust', value: 3 },
    ];
    const { director, host } = makeHost(chat);
    const profiles = {
        'Elizabeth & Dorothy': { characters: [{ name: 'Elizabeth', summary: 'A widow.', stats: { will: 60 } }, { name: 'Dorothy', summary: 'Her daughter.' }] },
        'The Blue Lantern': { name: 'Bianca', summary: 'Keeps the inn.' },
        Mira: { name: 'Mira Vell', summary: 'A well keeper.' },
    };
    host.cards = async () => Object.keys(profiles).map(name => ({ name, text: `${name}: a card long enough to profile.` }));
    host.castNames = () => Object.keys(profiles);
    let calls = 0;
    const call = host.call;
    host.call = async (m, msgs, ...rest) => {
        if (m !== 'profile') return call(m, msgs, ...rest);
        calls++;
        return JSON.stringify(profiles[msgs[1].content.match(/## Card: (.+)/)[1]]);
    };
    await director.kick();
    const s = director.view();
    assert.deepEqual(Object.keys(s.cast).filter(n => n !== 'Rowan').sort(), ['Bianca', 'Dorothy', 'Elizabeth', 'Mira']);
    assert.equal(s.cast.Elizabeth.stats.will, 60);
    assert.equal(s.cast.Bianca.rel.trust, 3, 'what was recorded under the card title moved to the person');
    assert.deepEqual(s.scene.present.slice().sort(), ['Dorothy', 'Elizabeth'], 'the pair replaced the title in the scene');
    assert.deepEqual(s.cards['Elizabeth & Dorothy'].people, ['Elizabeth', 'Dorothy']);
    assert.equal(calls, 3);
    chat.push(narr('Dorothy hums by the fire tonight.'));
    await director.kick();
    assert.equal(calls, 3, 'an unchanged card is not profiled again');
    const observer = director.calls.observer.messages.map(m => m.content).join('\n');
    assert.ok(observer.includes('Dorothy') && !observer.includes('Elizabeth & Dorothy'), 'the observer sees the people, not the title');
});

test('passers-by known only by a role are not cast: refused when new, dropped from older records', async () => {
    const text = 'The cobbler waves as Marda hands you the key. A clothier calls out from her stall. The restaurant keeper nods.';
    const v = validateObservation({
        summary: 's',
        scene: { present: ['Marda', 'cobbler', 'the clothier'] },
        cast_changes: [{ who: 'Marda', change: 'introduced', quote: 'Marda hands you the key' }, { who: 'restaurant keeper', change: 'introduced', quote: 'The cobbler waves' }],
    }, { text, names: ['Rowan'], tombstones: [], present: [], player: 'Rowan' });
    assert.deepEqual(v.delta.scene.present, ['Marda']);
    assert.deepEqual(v.delta.cast_changes.map(c => c.who), ['Marda']);
    assert.equal(v.rejected.filter(r => /a role/.test(r.reason ?? r.error ?? JSON.stringify(r))).length, 3);
    // An older record that let a role through.
    const chat = [narr('Marda hands you the key at the inn.'), user('a')];
    const { director } = makeHost(chat);
    await director.kick();
    const d = chat[0].extra.narrator.obs.delta;
    d.cast_changes = [{ who: 'cobbler', change: 'introduced', quote: 'x' }];
    d.scene.present = ['Marda', 'cobbler'];
    director.sync(); // an in-place edit is seen from the next pass on
    const s = director.view();
    assert.ok(!('cobbler' in s.cast) && 'Marda' in s.cast);
    assert.deepEqual(s.scene.present, ['Marda']);
    assert.ok(s.canon.length > 0, 'facts stay');
});

test('the player renames or removes a cast member, and a later reply does not bring the old name back', async () => {
    const chat = [narr('Marda hands you the key. Pellion waves from the street. Bianca smiles.'), user('a')];
    const { director } = makeHost(chat, {
        script: () => ({ summary: 's', scene: { present: ['Marda', 'Pellion', 'Bianca'] }, facts: [{ fact: 'Marda gave the key', quote: 'Marda hands you the key', certainty: 'stated', witnesses: ['Marda', 'Bianca'] }] }),
    });
    await director.kick();
    director.playerOp({ kind: 'edit', path: 'cast.Bianca.stances', value: { Marda: 4 } });
    director.playerOp({ kind: 'cast', action: 'rename', name: 'Marda', to: 'Marta' });
    director.playerOp({ kind: 'cast', action: 'remove', name: 'Pellion' });
    director.playerOp({ kind: 'cast', action: 'remove', name: 'Rowan' }); // the player character cannot be removed
    let s = director.view();
    assert.deepEqual(Object.keys(s.cast).sort(), ['Bianca', 'Marta', 'Rowan']);
    assert.deepEqual(s.scene.present.slice().sort(), ['Bianca', 'Marta']);
    assert.equal(s.cast.Bianca.stances.Marta, 4);
    assert.deepEqual(s.canon[0].witnesses, ['Marta', 'Bianca']);
    // A later reply names both again under their old names.
    chat.push(narr('Marda and Pellion argue at the gate tonight.'));
    await director.kick();
    s = director.view();
    assert.ok(!('Marda' in s.cast) && !('Pellion' in s.cast), JSON.stringify(Object.keys(s.cast)));
    // Renaming back to the old name brings it back.
    director.playerOp({ kind: 'cast', action: 'rename', name: 'Marta', to: 'Marda' });
    assert.ok('Marda' in director.view().cast && !('Marta' in director.view().cast));
});

test('a locked character is main cast: kept in the cast, named to the planner, given a full line in the notes', async () => {
    const chat = [narr('Marda hands you the key at the inn.'), user('a')];
    const { director } = makeHost(chat, { script: () => ({ summary: 's', scene: { present: ['Marda'] } }) });
    await director.kick();
    director.playerOp({ kind: 'cast', action: 'lock', name: 'Marda' });
    director.playerOp({ kind: 'cast', action: 'remove', name: 'Marda' }); // refused while locked
    let s = director.view();
    assert.equal(s.cast.Marda?.main, true);
    assert.ok(planPrompt({ state: s, loreKeys: [], reason: 'test' })[1].content.includes('Marda (main cast)'));
    // Six people in the scene: only the main cast member and the spotlight keep full lines.
    for (const n of ['Ana', 'Bo', 'Cy', 'Di', 'Ed']) { ensureCast(s, n); s.scene.present.push(n); }
    const notes = buildBrief({ ...s, genre: {} }, { tokenCap: 2000 }).text;
    assert.match(notes, /- Marda, toward Rowan: \w+ \(/, 'the main cast member has a full line');
    assert.match(notes, /- Bo, toward Rowan: \w+\n/, 'others in a large scene get the short line');
    director.playerOp({ kind: 'cast', action: 'unlock', name: 'Marda' });
    director.playerOp({ kind: 'cast', action: 'remove', name: 'Marda' });
    s = director.view();
    assert.ok(!('Marda' in s.cast), 'removable once unlocked');
});

test('the record groups facts into the world\'s and each cast member\'s, and keeps the latest 20 summaries apart', () => {
    const s = initialState({ player: 'Rowan' });
    for (const n of ['Rowan', 'Bianca', 'Old Tam', 'Tamsin']) ensureCast(s, n);
    s.cast.Tamsin.main = true;
    const facts = ['The bridge at Greywell collapsed', 'Bianca owns the Blue Lantern', 'old tam ferried Bianca across', 'Tamsin hid the letter',
        'Rowan arrived at dusk', 'The Tamsinian guard is gone'].map((fact, i) => ({ id: `f${i}`, fact }));
    const g = splitByCast(s, facts);
    assert.deepEqual(g.world.map(f => f.id), ['f0', 'f5'], 'no cast name, or only part of a word');
    assert.deepEqual(g.cast.map(([n, list]) => [n, list.map(f => f.id)]), [['Tamsin', ['f3']], ['Bianca', ['f1']], ['Old Tam', ['f2']], ['Rowan', ['f4']]],
        'main cast first, then by count; a fact goes to the first name it mentions');
    const v = summaryView({ recent: Array.from({ length: 25 }, (_, i) => ({ text: `t${i}`, i })) }, 20);
    assert.equal(v.latest.length, 20);
    assert.equal(v.latest[0].text, 't24', 'newest first');
    assert.deepEqual(v.older.map(x => x.text), ['t0', 't1', 't2', 't3', 't4']);
    assert.equal(summaryView({ recent: [{ text: 'a', i: 0 }] }).older.length, 0);
});

test('appearance is an anchor: taken from the card once, kept over a re-profile, sent only for those present', () => {
    const chat = [narr('Marda waits at the gate.')];
    chat[0].narrator_ops = [
        { at: 1, by: 'setup', kind: 'profile', name: 'Marda', value: { summary: 'Innkeeper.', gender: 'woman', race: 'human', age_group: 'elderly', appearance: 'Tall, grey braid, burn scar on the left hand.' }, cardHash: 'a' },
        { at: 2, by: 'setup', kind: 'profile', name: 'Hale', value: { summary: 'Captain.', appearance: 'Broad, cropped red hair.' }, cardHash: 'a' },
        { at: 3, by: 'setup', kind: 'profile', name: 'Rowan', value: { summary: 'Courier.', appearance: 'Wiry, ink-stained fingers.' }, pc: true },
        { at: 4, by: 'setup', kind: 'profile', name: 'Marda', value: { summary: 'Innkeeper.', gender: 'man', race: 'elf', appearance: 'Short and blonde.' }, cardHash: 'b' },
        { at: 5, by: 'player', kind: 'edit', path: 'scene.present', value: ['Marda'] },
    ];
    reconcile(chat, NARRATOR);
    const s = replay(chat, { narrator: NARRATOR, setup: { player: 'Rowan' } });
    assert.equal(s.cast.Marda.appearance, 'Tall, grey braid, burn scar on the left hand.', 'a later profile does not overwrite it');
    const text = buildStoryBlock(s).text;
    assert.equal(s.cast.Marda.race, 'human', 'race is kept over a re-profile too');
    assert.ok(text.includes('How they look') && text.includes('- Marda (woman, human, elderly): Tall, grey braid') && text.includes('- Rowan: Wiry'), text);
    // Hale's appearance is not sent while he is away (his name is, among the names already in use).
    assert.ok(!text.includes('Broad, cropped red hair') && !/- Hale/.test(text), 'not in the scene: not sent');
    assert.equal(validateProfile({ summary: 'x', age_group: 'ancient' }).value.age_group, '', 'only the listed age groups');
    assert.equal(validateProfile({ summary: 'x', age_group: 'teen' }).value.age_group, 'teen');
});

test('swiping back rereads the active reply and keeps the message id and player operations', async () => {
    const chat = [narr('The story opens at the gate.'), user('go'), narr('Swipe one: a red banner hangs over the gate.')];
    const { director } = makeHost(chat);
    await director.kick();
    const id = chat[2].narrator_id;
    const snapshotOne = structuredClone(chat[2].extra);       // SillyTavern keeps one `extra` per swipe
    chat[2].mes = 'Swipe two: a blue banner hangs over the gate.';
    await director.kick();
    director.playerOp({ kind: 'edit', path: 'scene.mood', value: 'festive' });   // made while swipe two is showing
    chat[2].mes = 'Swipe one: a red banner hangs over the gate.';
    chat[2].extra = snapshotOne;                               // swipe back: the older extra is restored
    director.sync();
    const s = director.view();
    assert.equal(chat[2].narrator_id, id);
    assert.equal(s.scene.mood, 'festive', 'the edit survived the swipe back');
    assert.ok(!facts(s).some(f => f.includes('red banner') || f.includes('blue banner')));
    await director.kick();
    assert.ok(facts(director.view()).some(f => f.includes('red banner')), 'the active reply was read again');
});

test('records written in the earlier layout are migrated without loss or duplication', () => {
    const old = (mes, rec, isUser = false) => ({ is_user: isUser, name: isUser ? 'Rowan' : 'Narrator', mes, extra: { narrator: rec } });
    const chat = [
        old('The gate opens slowly at dawn.', { v: 1, mid: 'aaa', ops: [{ at: 5, kind: 'edit', by: 'player', path: 'scene.mood', value: 'tense' }, { at: 6, kind: 'arc', by: 'director', value: { goal: 'g' } }] }),
        old('go', { v: 1, mid: 'bbb' }, true),
    ];
    reconcile(chat, NARRATOR);
    reconcile(chat, NARRATOR);
    assert.equal(chat[0].narrator_id, 'aaa');
    assert.equal(chat[0].narrator_ops.length, 1);
    assert.deepEqual(chat[0].extra.narrator.ops.map(o => o.kind), ['arc']);
    assert.ok(!('mid' in chat[0].extra.narrator));
    assert.equal(replay(chat, ctx).scene.mood, 'tense');
});

test('names: "the player", a first name and a fuller name all resolve; an ambiguous one does not', () => {
    const text = 'Elizabeth thanks you warmly for the help today. Captain Hale watches from the door.';
    const rel = (who, toward) => ({ who, toward, axis: 'trust', dir: 'up', weight: 'minor', category: 'words', quote: 'Elizabeth thanks you warmly for the help today' });
    const v = validateObservation({
        relationships: [rel('Elizabeth', 'the player'), rel('Hale', 'you'), rel('Beth', 'Rowan')],
        scene: { present: ['Elizabeth', 'Captain Hale'] },
    }, { text, names: ['Elizabeth Harrow', 'Elizabeth Stone', 'Captain Hale', 'Rowan'], player: 'Rowan' });
    assert.deepEqual(v.delta.relationships.map(r => [r.who, r.toward]), [['Captain Hale', 'Rowan']]);
    assert.ok(v.rejected.some(r => r.kind === 'relationships'), 'two Elizabeths: the bare first name is ambiguous and refused');
    const one = validateObservation({ relationships: [rel('Elizabeth', 'the player')] }, { text, names: ['Elizabeth Harrow', 'Rowan'], player: 'Rowan' });
    assert.deepEqual(one.delta.relationships.map(r => [r.who, r.toward]), [['Elizabeth Harrow', 'Rowan']]);
});

test('canon keeps one copy of a restated fact, and promotes a hint once it is stated', async () => {
    const chat = [narr('Bianca owns the Blue Lantern tavern outright.'), user('a'), narr('Bianca owns the Blue Lantern tavern outright, people say.'), user('b')];
    let n = 0;
    const { director } = makeHost(chat, {
        script: (m, msgs) => {
            const reply = replyOf(msgs), i = n++;
            return { summary: 's', facts: [
                { fact: 'Bianca owns the Blue Lantern tavern', quote: reply, certainty: i === 0 ? 'implied' : 'stated' },
                ...(i === 1 ? [{ fact: 'Bianca owns the Blue Lantern tavern outright', quote: reply, certainty: 'stated' }] : []),
            ] };
        },
    });
    await director.kick();
    const s = director.view();
    assert.equal(s.canon.length, 1);
    assert.equal(s.uncertain.length, 0);
});

test('an intent that never lands is retired instead of being pushed every turn', async () => {
    const chat = [narr('The story opens at the gate of Houshan.')];
    const { director } = makeHost(chat, { script: (m, msgs) => ({ ...fakeObserver(replyOf(msgs)), direction: { beat: 'untouched' } }) });
    await director.kick();
    const first = director.view().beats.find(b => b.status === 'queued').id;
    for (let i = 0; i < 6; i++) {
        chat.push(user('I wander.'), narr(`Nothing in particular happens during wandering number ${i}.`));
        await director.kick();
    }
    const beat = director.view().beats.find(b => b.id === first);
    assert.ok(!beat || beat.status === 'skipped', 'the first intent was retired');
});

test('everyday verbs do not produce an attempt tier; real contests and "try to" do', () => {
    const s = initialState({ player: 'Rowan' });
    ensureCast(s, 'Rowan').stats = { strength: 30, agility: 30, endurance: 30, intellect: 30, perception: 30, will: 30, presence: 30 };
    ensureCast(s, 'Bianca').stats = { strength: 30, agility: 30, endurance: 30, intellect: 30, perception: 30, will: 30, presence: 60 };
    s.scene.present = ['Bianca'];
    for (const mundane of ['I order a drink from Bianca.', 'I run a hand through Bianca\'s hair.', 'I push the glass toward Bianca.', 'I search my bag while Bianca waits.']) {
        assert.equal(detectAttempt(mundane, s), null, mundane);
    }
    assert.ok(detectAttempt('I try to push Bianca aside.', s));
    assert.ok(detectAttempt('I intimidate Bianca.', s));
});

test('dynamic lore: one entry per thing, and none for a character who already has a card', () => {
    const d = (keys, text, kind = 'place') => ({ keys, text, kind, supersedes: null, source: 'm', turn: 1, committed: true });
    const { entries, waiting } = buildLorebook([
        d(['the Blue Lantern'], 'A tavern by the harbour.'),
        d(['Blue Lantern', 'Lantern tavern'], 'A tavern by the harbour, run by Bianca.'),
        d(['Bianca'], 'Bianca runs the tavern.', 'character'),
    ], [], { exclude: ['Bianca'] });
    assert.equal(entries.length + waiting.length, 1);
    assert.equal(entries[0].text, 'A tavern by the harbour, run by Bianca.');
});

test('a plan survives the player typing while the planner thinks; a failing planner is not retried on every event', async () => {
    const chat = [narr('The story opens at the gate of Houshan.')];
    let fail = false, plannerCalls = 0;
    const { director } = makeHost(chat, { gate: async (module) => { if (module === 'planner') { plannerCalls++; if (fail) throw new Error('boom'); if (chat.length === 1) chat.push(user('I walk in.')); } } });
    await director.kick();
    assert.ok(director.view().beats.length, 'the plan was kept although a newer message arrived');
    fail = true;
    director.playerOp({ kind: 'instruction', text: 're-plan' });
    const before = plannerCalls;
    await director.kick(); await director.kick(); await director.kick();
    assert.equal(plannerCalls - before, 1, 'one failed attempt, then a pause');
    void logOp;
});

test('summaries of messages the player hid count as out of the prompt', async () => {
    const chat = [narr('Chapter one happens in the valley today.'), user('a'), narr('Chapter two happens on the ridge today.'), user('b')];
    const { director } = makeHost(chat);
    await director.kick();
    chat[0].is_system = true;
    const text = buildStoryBlock(director.view(), { firstIncluded: 0 }).text;
    assert.ok(text.includes('Chapter one') && !text.includes('Chapter two'));
});

test('saved profiles replay without legacy rating fields and keep their genre and stakes', () => {
    const legacy = { dominant: 'slice of life', lethality: 'none', pg: true, explicit: false };
    assert.deepEqual(initialState({ genre: legacy }).genre, { dominant: 'slice of life', lethality: 'none' });
    const chat = [user('I sit near the window.')];
    reconcile(chat, NARRATOR);
    logOp(chat[0], { kind: 'genre', by: 'player', value: legacy });
    const state = replay(chat, { narrator: NARRATOR });
    assert.deepEqual(state.genre, { dominant: 'slice of life', lethality: 'none' });
    assert.equal(chat[0].narrator_ops[0].value.pg, true, 'replay preserves the saved record');
    const vars = { nar_pg: '1', nar_explicit: '1' };
    writeVars(vars, publicVars(state));
    assert.equal(vars.nar_pg, undefined);
    assert.equal(vars.nar_explicit, undefined);
    assert.equal(vars.nar_lethality_none, '1');
});
