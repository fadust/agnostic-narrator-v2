// Round 5, W1 (beats as openings: goal and pressure) and W3 (the plan check).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBrief } from '../../core/brief.js';
import {
    checkPlan, copiedCriterion, fightsGenre, hollowChoice, nameClash, pastPrecondition, reviewPlan, scriptsPlayer, settlePlan, validatePlanRewrites,
} from '../../core/plancheck.js';
import { validatePlan } from '../../core/planner.js';
import { observerPrompt, planCheckPrompt, planPrompt } from '../../core/prompts.js';
import { ensureCast, initialState, logOp, reconcile, replay } from '../../core/state.js';
import { NARRATOR, defaultScript, makeHost, narr, user } from './helpers.mjs';

const ctxOf = (over = {}) => ({ player: 'Max Brenner', criteria: [], names: ['Elsa', 'Piet', 'Max Brenner'], knownText: '', genre: { lethality: 'real', avoid: [] }, time: '', beatLog: [], ...over });
const beat = (goal, pressure = goal, extra = {}) => ({ scene: 's1', goal, pressure, intent: goal, precondition: '', type: 'pressure', required: false, lore: [], clues: [], serves: '', ...extra });

test('W1: a validated beat has goal and pressure; an old-shape answer (intent only) serves as both', () => {
    const st = initialState();
    const v = validatePlan({ scenes: [{ id: 's1', purpose: 'p' }], beats: [
        { scene: 's1', goal: 'Piet tells Max where the captain drinks', pressure: 'Piet is eager to talk to any stranger who pays', type: 'reveal' },
        { scene: 's1', intent: 'a quiet meal', type: 'release' },
    ] }, st).value;
    assert.equal(v.beats[0].goal, 'Piet tells Max where the captain drinks');
    assert.equal(v.beats[0].intent, v.beats[0].goal, 'intent stays as the goal\'s copy');
    assert.equal(v.beats[0].pressure, 'Piet is eager to talk to any stranger who pays');
    assert.deepEqual([v.beats[1].goal, v.beats[1].pressure], ['a quiet meal', 'a quiet meal']);
});

test('W1: an old logged plan replays; the narrator sees the pressure, the observer the pressure and the goal', () => {
    const chat = [narr('The story opens.'), user('x'), narr('Rain on the roofs.'), user('y')];
    reconcile(chat, NARRATOR);
    logOp(chat[0], { kind: 'plan', by: 'player', seq: 0, value: { scenes: [{ id: 's1', purpose: 'p' }], beats: [{ scene: 's1', intent: 'old intent only', type: 'reveal' }] } });
    const view = () => { const v = replay(chat, { narrator: NARRATOR, setup: {} }); v.meta.lagging = false; return v; };
    let s = view();
    assert.deepEqual([s.beats[0].goal, s.beats[0].pressure, s.beats[0].intent], ['old intent only', 'old intent only', 'old intent only']);
    assert.ok(buildBrief(s).text.includes('scene_intent: old intent only'));

    logOp(chat[2], { kind: 'plan', by: 'player', seq: 1, value: { scenes: [{ id: 's1', purpose: 'p' }], beats: [{ scene: 's1', goal: 'Piet names the inn', pressure: 'Piet is eager to talk for coin', precondition: 'Max is in the market', type: 'reveal' }] } });
    s = view();
    const b = s.beats.find(x => x.status === 'queued');
    const brief = buildBrief(s);
    assert.ok(brief.text.includes('scene_intent: Piet is eager to talk for coin (only if: Max is in the market)'), brief.text);
    assert.ok(!brief.text.includes('Piet names the inn'), 'the narrator never sees the goal');
    const obs = observerPrompt({ state: s, reply: 'r', playerMessage: '', offered: { beat: b.id, clues: [] } })[1].content;
    assert.ok(obs.includes('scene intent: Piet is eager to talk for coin (only if: Max is in the market)'));
    assert.ok(obs.includes('goal (judge "direction" by this; the narrator was not shown it): Piet names the inn'));
});

test('W1: planner and check system texts stay byte-identical between calls (cache)', () => {
    const s = initialState();
    s.genre = { dominant: 'fantasy' };
    assert.equal(planPrompt({ state: s, loreKeys: [], reason: 'cadence' })[0].content, planPrompt({ state: s, loreKeys: ['x'], reason: 'drifting' })[0].content);
    const sys = planPrompt({ state: s, loreKeys: [], reason: 'x' })[0].content;
    assert.ok(/"goal"/.test(sys) && /"pressure"/.test(sys) && /never how to narrate/.test(sys) && /slip to a later scene/.test(sys));
    const a = planCheckPrompt({ beats: [beat('a')], flags: [{ id: 'b1', reasons: ['r1'] }], player: 'Max', genre: {}, names: ['Elsa'] });
    const b = planCheckPrompt({ beats: [beat('b')], flags: [{ id: 'b1', reasons: ['r2'] }], player: 'Ann', genre: { pg: true }, names: [] });
    assert.equal(a[0].content, b[0].content);
    assert.ok(a[1].content.includes('b1') && a[1].content.includes('r1'));
});

test('a place-bound beat and clue stay out of an unrelated turn while the player remains in the scene', () => {
    const state = initialState({ player: 'Max', genre: { dominant: 'fantasy' } });
    state.scene.present = ['Max', 'Mira'];
    state.scene.location = { value: 'Greywell Seal Hall', established: true };
    ensureCast(state, 'Max').pc = true;
    ensureCast(state, 'Mira');
    state.beats = [beat('someone notices the well water', 'water from the well tastes bitter', {
        id: 'well-beat', status: 'queued', precondition: 'someone drinks or draws water',
        lore: ['secret well lore'], clues: [{ id: 'well-clue', text: 'grey film on the bucket', where: 'the well', route: 'place' }],
    })];

    const away = buildBrief(state, { playerMessage: 'I slide the empty cup toward Mira.' });
    assert.equal(away.lines.present, 'Max, Mira');
    assert.match(away.lines.spotlight, /^Mira/);
    assert.doesNotMatch(away.text, /Max, toward Max|water tastes bitter|grey film/);
    assert.doesNotMatch(away.scan, /secret well lore/);
    assert.deepEqual(away.offered, { beat: null, clues: [] });

    const atWell = buildBrief(state, { playerMessage: 'I draw water from the well.' });
    assert.match(atWell.lines.scene_intent, /water from the well/);
    assert.deepEqual(atWell.offered, { beat: 'well-beat', clues: ['well-clue'] });
    const shortened = buildBrief(state, { playerMessage: 'I draw water from the well.', tokenCap: 40 });
    assert.equal(shortened.lines.clue, undefined);
    assert.deepEqual(shortened.offered.clues, []);
});

test('W3 (a): scripts the player', () => {
    const p = 'Max Brenner';
    for (const t of ['Max sells the map to Piet', 'Max Brenner walks into the inn', 'You follow the stranger', 'the player agrees to the deal', 'Piet hopes the player finally accepts', 'Max has agreed to help']) assert.ok(scriptsPlayer(t, p), t);
    for (const t of ['Max holds the only key', 'Max learns where the captain drinks', 'Max\'s sister arrives with news', 'Piet offers a deal, if the player agrees', 'Max decides whether to sell the map', 'the player may accept or refuse', 'Your landlord wants the rent', 'Maxine waits at the gate']) assert.ok(!scriptsPlayer(t, p), t);
});

test('W3 (b): copies a criterion (at least 3 shared words, 70% of the criterion)', () => {
    const crit = [{ id: 'm2-c2', text: 'the steward owes Max his life', mark: 'open' }, { id: 'm1-c1', text: 'Elsa trusts him', mark: 'open' }];
    assert.equal(copiedCriterion('The steward owes Max his life now', crit)?.id, 'm2-c2');
    assert.equal(copiedCriterion('the steward is drowning in debt to the guild', crit), null);
    assert.equal(copiedCriterion('Elsa trusts him', crit), null, 'a criterion under three content words is never a copy');
});

test('W3 (c): a hollow choice is retyped as pressure; a real one stays', () => {
    assert.ok(hollowChoice({ type: 'choice', goal: 'the player is offered the job', pressure: 'the guild needs a courier' }));
    assert.ok(!hollowChoice({ type: 'choice', goal: 'take the job or warn Elsa', pressure: 'p' }));
    const { plan, fixed } = checkPlan({ beats: [beat('the guild needs a courier', undefined, { type: 'choice' })] }, ctxOf());
    assert.equal(plan.beats[0].type, 'pressure');
    assert.equal(fixed.length, 1);
});

test('W3 (d): a new name too close to a known one', () => {
    assert.deepEqual(nameClash('Elza waits at the well', ['Elsa', 'Piet']), { name: 'Elza', like: 'Elsa' });
    assert.equal(nameClash('A courier named Elsa Brand arrives', ['Elsa'])?.like, 'Elsa');
    assert.equal(nameClash('Elsa waits; Piet frowns. Then Corwin arrives', ['Elsa', 'Piet']), null, 'a clearly different new name is fine');
    assert.equal(nameClash('Elsa Brand waits', ['Elsa Brand']), null);
    assert.equal(nameClash('Then the bell rings', ['Thea']), null, 'a common sentence-first word is not a name');
});

test('W3 (e): a precondition tied to a time already passed is dropped in code', () => {
    assert.ok(pastPrecondition('on day 2 at the market', 'day 3, morning'));
    assert.ok(pastPrecondition('before nightfall', 'night'));
    assert.ok(pastPrecondition('this morning', 'late evening'));
    assert.ok(!pastPrecondition('before nightfall', 'afternoon'));
    assert.ok(!pastPrecondition('tomorrow morning', 'evening'));
    assert.ok(!pastPrecondition('if the player enters the city', 'night'));
    const { plan } = checkPlan({ beats: [beat('the bell rings', undefined, { precondition: 'before nightfall' })] }, ctxOf({ time: 'night' }));
    assert.equal(plan.beats[0].precondition, '');
});

test('W3 (f): fights the genre', () => {
    assert.match(fightsGenre('the guild sends assassins with modern technology', { avoid: ['modern technology'] }), /avoids/);
    assert.match(fightsGenre('a rival is killed in the square', { lethality: 'none', avoid: [] }), /lethality none/);
    assert.equal(fightsGenre('the two undress by the fire', { pg: true }), '');
    assert.equal(fightsGenre('the two undress by the fire', { pg: false, explicit: false }), '');
    assert.equal(fightsGenre('the painter describes gore in a painting', { lethality: 'low' }), '');
    assert.equal(fightsGenre('a rival is killed in the square', { lethality: 'real' }), '');
    assert.equal(fightsGenre('a quiet supper', { pg: true, lethality: 'none', avoid: ['graphic gore'] }), '');
});

test('W3: a rewrite that still trips a flag is refused; a clean one is kept', () => {
    const plan = { beats: [beat('Max sells the map'), beat('Elza waits')] };
    const ctx = ctxOf();
    const { flags } = checkPlan(plan, ctx);
    assert.deepEqual(flags.map(f => [f.id, f.codes]), [['b1', ['script']], ['b2', ['name']]]);
    const v = validatePlanRewrites({ rewrites: [
        { id: 'b1', goal: 'Max sells the map anyway', pressure: 'a buyer asks about maps' },
        { id: 'b2', goal: 'Corwin waits', pressure: 'Corwin is at the well' },
        { id: 'b9', goal: 'x', pressure: 'y' },
    ] }, flags, plan, ctx);
    assert.ok(v.ok);
    assert.deepEqual(v.value.map(r => r.id), ['b2']);
    assert.ok(!validatePlanRewrites({ rewrites: [{ id: 'b1', goal: 'You sell it', pressure: 'p' }] }, flags, plan, ctx).ok);
});

test('the checker names the flagged goal on the saved household tally beat', () => {
    const goal = "Elizabeth corrects a figure in Bianca's household tally in front of the table, unasked, and Bianca and Max both see it.";
    const pressure = "Bianca's tradesman's tally and household account lie open on the kitchen plank beside the bread, its columns wrong in two places that any merchant's wife would catch at a glance.";
    const context = ctxOf({ player: 'Max', names: ['Max', 'Elizabeth', 'Bianca'] });
    const { plan, flags } = checkPlan({ beats: [beat(goal, pressure, { type: 'reveal', precondition: 'Elizabeth is seated at the kitchen table with the tally in view' })] }, context);
    assert.deepEqual(flags.map(f => f.codes), [['script']]);
    const prompt = planCheckPrompt({ beats: plan.beats, flags, player: context.player, genre: context.genre, names: context.names });
    assert.match(prompt[0].content, /A flagged goal needs a revised goal/);
    assert.match(prompt[1].content, /flagged: rewrite goal: scripted player participation/);

    const attempted = { id: 'b1', goal, pressure: `${pressure.slice(0, -1)}; Elizabeth sits at the kitchen table with the tally in view.` };
    assert.deepEqual(validatePlanRewrites({ rewrites: [attempted] }, flags, plan, context), { ok: false, error: 'no usable rewrites' });
    const corrected = { ...attempted, goal: 'Elizabeth corrects a figure in the open household tally where everyone at the table can see the page.' };
    const accepted = validatePlanRewrites({ rewrites: [corrected] }, flags, plan, context);
    assert.ok(accepted.ok);
    const settled = settlePlan(plan, flags, accepted.value);
    assert.deepEqual(settled.dropped, []);
    assert.equal(settled.plan.beats[0].goal, corrected.goal);
    assert.equal(settled.plan.beats[0].precondition, plan.beats[0].precondition);
});

test('W3: a failed check drops beats that script the player or fight the genre; the others stay as drafted', async () => {
    const plan = { beats: [beat('Max sells the map'), beat('Elza waits'), beat('a rival is killed', undefined, {}), beat('a quiet supper')] };
    const ctx = ctxOf({ genre: { lethality: 'none', avoid: [] } });
    let asked = 0;
    const out = await reviewPlan(plan, ctx, async () => { asked++; throw new Error('timeout'); });
    assert.equal(asked, 1, 'one call for all flagged beats');
    assert.deepEqual(out.dropped, ['b1', 'b3']);
    assert.deepEqual(out.plan.beats.map(b => b.goal), ['Elza waits', 'a quiet supper']);
    // A clean plan makes no call at all.
    const clean = await reviewPlan({ beats: [beat('a quiet supper')] }, ctx, async () => { asked++; return []; });
    assert.equal(asked, 1);
    assert.equal(clean.flagged, 0);
    // A rewrite applies to goal, pressure and intent.
    const { plan: s } = settlePlan({ beats: [beat('Max sells the map')] }, [{ id: 'b1', codes: ['script'] }], [{ id: 'b1', goal: 'a buyer asks about maps', pressure: 'a buyer is asking about maps' }]);
    assert.deepEqual([s.beats[0].goal, s.beats[0].intent, s.beats[0].pressure], ['a buyer asks about maps', 'a buyer asks about maps', 'a buyer is asking about maps']);
});

test('W3 in the director: one check call when flagged; a plan with every beat dropped is not logged and the planner rests', async () => {
    const chat = [narr('The story opens at the gate of Houshan.'), user('I walk in.'), narr('Ji Si waits beneath the arch.')];
    const { host, director, state } = makeHost(chat);
    host.call = async (module, messages) => {
        state.calls.push({ module, messages });
        if (module === 'planner' && !messages[0].content.includes('outline the arc')) {
            return JSON.stringify({ scenes: [{ id: 's1', purpose: 'p' }], beats: [{ scene: 's1', goal: 'Rowan pays the debt', pressure: 'Rowan pays the debt', type: 'pressure' }] });
        }
        if (module === 'planner-check') return JSON.stringify({ rewrites: [{ id: 'b1', goal: 'Rowan pays it anyway', pressure: 'Rowan pays' }] });
        return JSON.stringify(defaultScript(module, messages));
    };
    await director.kick();
    assert.equal(state.calls.filter(c => c.module === 'planner-check').length, 1);
    assert.equal(director.view().beats.length, 0, 'nothing logged: the only beat scripted the player and its rewrite was refused');
    assert.ok((director.cool.planner ?? 0) > Date.now(), 'the planner rests before trying again');
    assert.ok(director.errors.some(e => e.module === 'planner-check'));
    assert.ok(director.failing['planner-check'], 'a plan with no usable beats leaves the active warning');
});

test('W3 in the director: saving a clean plan clears the previous warning without making a check call', async () => {
    const chat = [narr('The story opens at the gate of Houshan.'), user('I walk in.'), narr('Ji Si waits beneath the arch.')];
    const { director, state } = makeHost(chat);
    director.fail('planner-check', new Error('no usable rewrites'));
    assert.ok(director.failing['planner-check']);
    await director.kick();
    assert.equal(state.calls.filter(c => c.module === 'planner-check').length, 0);
    assert.equal(director.view().beats.length, 2);
    assert.ok(state.saves > 0);
    assert.equal(director.failing['planner-check'], undefined);
});

test('scripts the player anywhere in the text, and when his body or clothes are changed (live, 18 Nov 2026)', async () => {
    const { scriptsPlayer: s } = await import('../../core/plancheck.js');
    const P = 'Max Brenner';
    assert.equal(s("The fire throws enough light to see by, and Max's collar has come loose in the warmth.", P), true);
    assert.equal(s("A glimpse of the scar over Max's ribs is offered to the woman.", P), true);
    assert.equal(s('The room is warm, and Max takes off his coat.', P), true);
    assert.equal(s('She offers him the chair nearest the fire and watches whether he sheds the layers.', P), false);
    assert.equal(s("Max's horse is tired and the stable is full.", P), false);
});

test('the arc and spine are built on the player character\'s aim from the opening move (owner, 19 Nov 2026)', async () => {
    const { arcPrompt, spinePrompt } = await import('../../core/prompts.js');
    const { initialState } = await import('../../core/state.js');
    const s = initialState({ player: 'Max' });
    s.genre = { dominant: 'drama' };
    const arc = arcPrompt({ state: s, loreKeys: [], opening: 'Max rides into Veldmark looking for news of the Juringen sisters.' });
    assert.match(arc[0].content, /The goal is the player character's/);
    assert.match(arc[1].content, /## The player's opening move[^\n]*\nMax rides into Veldmark looking for news of the Juringen sisters\./);
    assert.ok(!/opening move \(/.test(arcPrompt({ state: s, loreKeys: [] })[1].content), 'no section without a first message');
    assert.match(spinePrompt({ material: 'x', genre: s.genre, premise: '', arc: null, player: 'Max' })[0].content, /The question is about the player character/);
});

test('an avoid item that is a style note is not touched by sharing a word or a name with it (live, 19 Nov 2026)', async () => {
    const { fightsGenre } = await import('../../core/plancheck.js');
    const genre = { lethality: 'high', avoid: ['rushing past the inn and its watchful regulars', 'letting Max solve everything without friction', 'gore'] };
    assert.equal(fightsGenre('The north road past the tannery bend is walkable tonight, and the inn regulars are still at their benches.', genre, ['Max']), '');
    assert.equal(fightsGenre('Max can leave the inn tonight or stay.', genre, ['Max']), '');
    assert.match(fightsGenre('The scene lingers on gore at the well.', genre, ['Max']), /avoids: "gore"/);
    assert.match(fightsGenre('The plan is rushing past the inn and its watchful regulars to reach the road.', genre, ['Max']), /rushing past the inn/);
});
