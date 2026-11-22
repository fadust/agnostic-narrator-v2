// Validation and rules for everything the planning-side models propose: genre profile, arc, plan, character profile.

import { AGE_GROUPS, ARC_TENSION, BANDS, BEAT_TYPES, CAPS, CLUE_ROUTES, GENRE_ALIASES, LETHALITY, STATS, STAT_BASELINE, TEMPERAMENTS, TEMPO } from './enums.js';
import { SPINE_CAPS, applySpineRewrites, findCriterion, flagSpine, needsNewEnding } from './spine.js';
import { awakeThreads } from './state.js';
import { arr, clamp, clip, isObj, str } from './util.js';
import { validateRenewals } from './agenda.js';
import { beatText } from './beat.js';

const strs = (v, max, len = 160) => arr(v).map(x => str(x, len)).filter(Boolean).slice(0, max);
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);

/** "Sci-Fi" and "science fiction" must set the same flag, or the genre's craft entry never fires. */
const genreLabel = (s) => { const k = str(s, 40).toLowerCase(); return GENRE_ALIASES[k] ?? k; };

export function validateGenre(raw) {
    if (!isObj(raw) || !str(raw.dominant)) return { ok: false, error: 'no dominant genre' };
    return {
        ok: true,
        value: {
            dominant: genreLabel(raw.dominant),
            secondary: [...new Set(strs(raw.secondary, 3, 40).map(genreLabel))].filter(g => g !== genreLabel(raw.dominant)),
            register: str(raw.register, 200),
            pov: str(raw.pov, 80),
            priority: strs(raw.priority, 5, 80),
            stakes: str(raw.stakes, 200),
            lethality: pick(raw.lethality, LETHALITY, 'low'),
            tempo: pick(raw.tempo, TEMPO, 'measured'),
            promises: strs(raw.promises, 5),
            avoid: strs(raw.avoid, 5),
            stats_focus: strs(raw.stats_focus, 7, 20).filter(s => STATS.includes(s)),
            confirmed: raw.confirmed === true,
        },
    };
}

export function validateArc(raw) {
    if (!isObj(raw) || !str(raw.goal)) return { ok: false, error: 'no goal' };
    const endings = arr(raw.endings).filter(isObj).map(e => ({
        title: str(e.title, 80),
        outcomes: isObj(e.outcomes) ? Object.fromEntries(Object.entries(e.outcomes).slice(0, 8).map(([k, v]) => [str(k, 60), str(v, 200)])) : {},
    })).filter(e => e.title).slice(0, CAPS.endings);
    // No ending is settled before the final act: an arc with fewer than two possible endings is a script.
    if (endings.length < 2) return { ok: false, error: 'needs at least two possible endings' };
    const p = isObj(raw.payoff) ? raw.payoff : {};
    const hooks = arr(p.hooks).map(h => ({ text: str(isObj(h) ? h.text : h, 200), planted: false })).filter(h => h.text).slice(0, CAPS.hooks);
    return {
        ok: true,
        value: {
            goal: str(raw.goal, 300), act: 1, acts: clamp(Number(raw.acts) || 3, 1, 5), tension: 'low',
            forces: strs(raw.forces, 4, 200),
            payoff: { name: str(p.name, 120), act: clamp(Number(p.act) || 3, 1, 5), hooks },
            endings,
        },
    };
}

/**
 * @param {any} raw
 * @param {object} state For rotation (recent beat types) and known scene ids.
 */
export function validatePlan(raw, state) {
    if (!isObj(raw)) return { ok: false, error: 'not an object' };
    const scenes = arr(raw.scenes).filter(isObj).slice(0, CAPS.scenes).map((s, n) => ({
        id: str(s.id, 30) || `s${n + 1}`,
        purpose: str(s.purpose, 200),
        if_unchallenged: strs(s.if_unchallenged, 4, 200),
        choice_points: strs(s.choice_points, 4, 200),
        focus: isObj(s.focus) ? Object.fromEntries(Object.entries(s.focus).slice(0, 6).map(([k, v]) => [str(k, 60), str(v, 120)])) : {},
    })).filter(s => s.purpose);
    const sceneIds = new Set(scenes.map(s => s.id));
    // goal: what counts as the beat landing (the record keeper judges by it; the old "intent", kept as its copy).
    // pressure: the opening the narrator is shown. A model answer in the old shape (intent only) still works.
    // The narrator reads these: cut at a sentence end, never mid-word.
    let beats = arr(raw.beats).filter(isObj).map(b => ({
        scene: sceneIds.has(b.scene) ? b.scene : (scenes[0]?.id ?? ''),
        ...beatText(b, text => clip(text, 240)),
        precondition: clip(b.precondition, 200),
        type: pick(b.type, BEAT_TYPES, 'pressure'),
        required: b.required === true,
        lore: strs(b.lore, 3, 40),
        clues: arr(b.clues).filter(isObj).slice(0, CAPS.clues).map(c => ({
            text: clip(c.text, 200), route: pick(c.route, CLUE_ROUTES, 'place'), where: str(c.where, 80),
        })).filter(c => c.text),
        serves: servesOf(b.serves, state),
        plants: plantsOf(b.plants, state),
    })).filter(b => b.goal).slice(0, CAPS.beats);
    if (!beats.length) return { ok: false, error: 'no usable beats' };
    beats = rotate(beats, arr(state?.meta?.beatLog));
    const sp = state?.spine;
    const endingIds = new Set(arr(sp?.endings).map(e => e.id));
    const alternatives = arr(raw.alternatives).filter(isObj)
        .map(a => ({ ending: str(a.ending, 40), text: str(a.text, SPINE_CAPS.text) }))
        .filter(a => endingIds.has(a.ending) && a.text).slice(0, 3);
    let newEnding;
    if (isObj(raw.new_ending) && str(raw.new_ending.title) && needsNewEnding(sp)) {
        const n = raw.new_ending;
        const criteria = strs(n.criteria, SPINE_CAPS.criteria, SPINE_CAPS.text);
        if (criteria.length) newEnding = { title: str(n.title, 80), how: str(n.how, SPINE_CAPS.text), criteria, reason: str(n.reason, SPINE_CAPS.text) };
    }
    return {
        ok: true,
        value: {
            scenes, beats,
            act: Number.isInteger(raw.act) ? raw.act : undefined,
            tension: ARC_TENSION.includes(raw.tension) ? raw.tension : undefined,
            // An outcome is told to the narrator as fact: one cut off (an answer that ran out of tokens) is dropped,
            // and a long one is cut at a sentence end (found live, 19 Nov 2026).
            outcomes: arr(raw.outcomes).map(o => String(o ?? '').trim()).filter(o => /[.!?"'”’)]$/.test(o)).map(o => clip(o, 240)).filter(Boolean).slice(0, 2),
            alternatives,
            new_ending: newEnding,
            // Renewals of agendas that are fulfilled, lapsed or expired; a live agenda is never replaced.
            agendas: state ? validateRenewals(raw.agendas, state) : [],
        },
    };
}

/** A beat may name, by number, a payoff hook it plants that is not planted yet. Anything else is dropped. */
function plantsOf(n, state) {
    const k = Number(n);
    const h = arr(state?.arc?.payoff?.hooks)[k - 1];
    return Number.isInteger(k) && h && !h.planted ? k : 0;
}

/** A beat may name the open spine criterion it serves. Anything else is dropped. */
function servesOf(id, state) {
    const k = str(id, 60);
    if (!k || !state?.spine) return '';
    const hit = findCriterion(state.spine, k);
    if (!hit || hit.criterion.mark !== 'open') return '';
    if (hit.kind === 'milestone' && hit.item.status === 'concluded') return '';
    return k;
}

/**
 * The drafted spine: the setup's question, its possible endings (all live) and the arc milestones.
 * Ids are assigned here, never taken from the model.
 */
export function validateSpine(raw) {
    if (!isObj(raw)) return { ok: false, error: 'not an object' };
    // Each criterion is an objective with the role it plays: {text, role, lasting?}. A bare string is still accepted.
    // `lasting` (a lasting state between people) is kept only when the model gave a boolean.
    const criteria = (list, prefix) => arr(list).map(c => (isObj(c) ? { text: str(c.text, SPINE_CAPS.text), role: str(c.role, 120), lasting: c.lasting } : { text: str(c, SPINE_CAPS.text), role: '' }))
        .filter(c => c.text).slice(0, SPINE_CAPS.criteria)
        .map((c, n) => ({ id: `${prefix}-c${n + 1}`, text: c.text, ...(c.role ? { role: c.role } : {}), ...(typeof c.lasting === 'boolean' ? { lasting: c.lasting } : {}), mark: 'open' }));
    const endings = arr(raw.endings).filter(isObj).filter(e => str(e.title)).slice(0, SPINE_CAPS.endings).map((e, n) => {
        const id = `e${n + 1}`;
        return { id, title: str(e.title, 80), how: str(e.how, SPINE_CAPS.text), criteria: criteria(e.criteria, id) };
    }).filter(e => e.criteria.length);
    if (endings.length < 2) return { ok: false, error: 'needs at least two endings with criteria' };
    const milestones = arr(raw.milestones).filter(isObj).filter(m => str(m.title)).slice(0, SPINE_CAPS.milestones).map((m, n) => {
        const id = `m${n + 1}`;
        return { id, title: str(m.title, 120), criteria: criteria(m.criteria, id), status: 'open', conclusion: '' };
    }).filter(m => m.criteria.length);
    if (!milestones.length) return { ok: false, error: 'needs at least one milestone with criteria' };
    return { ok: true, value: { question: str(raw.question, SPINE_CAPS.text), endings, milestones } };
}

/** The spine check's answer: rewrites only for flagged ids, with text; caps as for the draft. Nothing usable fails. */
export function validateSpineRewrites(raw, flags, check = null) {
    if (!isObj(raw)) return { ok: false, error: 'not an object' };
    const flagged = new Set(arr(flags).map(f => f.id));
    const seen = new Set();
    let rewrites = arr(raw.rewrites).filter(isObj).map(r => ({ id: str(r.id, 40), text: str(r.text, SPINE_CAPS.text), role: str(r.role, 120), lasting: r.lasting }))
        .filter(r => r.text && flagged.has(r.id) && !seen.has(r.id) && seen.add(r.id))
        .map(r => ({ id: r.id, text: r.text, ...(r.role ? { role: r.role } : {}), ...(typeof r.lasting === 'boolean' ? { lasting: r.lasting } : {}) }));
    // A rewrite must clear what it was flagged for: one that still starts with the player character, or is still a
    // gesture or a tally, is refused and the original stays. `check` is { spine, present, player, location }.
    if (check?.spine) {
        const after = new Set(flagSpine(applySpineRewrites(check.spine, rewrites), check).map(f => f.id));
        rewrites = rewrites.filter(r => !after.has(r.id));
    }
    if (!rewrites.length) return { ok: false, error: 'no usable rewrites' };
    return { ok: true, value: rewrites };
}

/** A concluded milestone's short account. */
export function validateConclusion(raw) {
    const text = str(isObj(raw) ? raw.conclusion : null, SPINE_CAPS.conclusion);
    return text ? { ok: true, value: text } : { ok: false, error: 'no conclusion' };
}

/** After two pressure beats the next must be something else: reorder when possible, retype when not. */
export function rotate(beats, log) {
    const out = [];
    const pool = [...beats];
    const tail = [...log.slice(-2)];
    while (pool.length) {
        const blocked = tail.length >= 2 && tail.slice(-2).every(t => t === 'pressure');
        let at = blocked ? pool.findIndex(b => b.type !== 'pressure') : 0;
        if (at === -1) { at = 0; pool[0] = { ...pool[0], type: 'release' }; }
        const [b] = pool.splice(at, 1);
        out.push(b);
        tail.push(b.type);
    }
    return out;
}

/**
 * One character's profile, or, for a card that holds several people, `{ people: [{ name, ...profile }] }`.
 * A "characters" list with fewer than two named, valid entries is read as one character.
 */
export function validateProfile(raw, allowMultiple = true) {
    if (isObj(raw) && Array.isArray(raw.characters)) {
        const seen = new Set();
        const people = [];
        for (const c of raw.characters.slice(0, 6)) {
            const name = str(c?.name, 60);
            const v = name && !seen.has(name.toLowerCase()) ? profileOf(c) : null;
            if (v) { seen.add(name.toLowerCase()); people.push({ name, ...v }); }
        }
        if (people.length >= 2) return allowMultiple
            ? { ok: true, value: { people } }
            : { ok: false, error: 'expected a single character profile' };
        if (people.length === 1) return { ok: true, value: people[0] };
        return { ok: false, error: 'no usable character in "characters"' };
    }
    const v = profileOf(raw);
    return v ? { ok: true, value: { name: str(raw.name, 60), ...v } } : { ok: false, error: 'no summary' };
}

function profileOf(raw) {
    if (!isObj(raw) || !str(raw.summary)) return null;
    const stats = {};
    for (const s of STATS) {
        const v = Number(raw.stats?.[s]);
        stats[s] = Number.isFinite(v) ? clamp(Math.round(v), 5, 100) : STAT_BASELINE;
    }
    const tells = {};
    if (isObj(raw.tells)) for (const b of BANDS) { const t = str(raw.tells[b], 120); if (t) tells[b] = t; }
    return {
        summary: str(raw.summary, 500),
        gender: str(raw.gender, 40),
        race: str(raw.race, 60),
        age_group: pick(raw.age_group, AGE_GROUPS, ''),
        appearance: str(raw.appearance, 400),
        stats,
        temperament: pick(raw.temperament, TEMPERAMENTS, 'reserved'),
        tells: Object.keys(tells).length ? tells : null,
        unprompted: str(raw.unprompted, 160),
    };
}

/**
 * Why the planner should run now, or null.
 * @param {object} state View state.
 * @param {{cadence: number}} cfg cadence 0 = event-driven only.
 */
/** A player direction asking for a slower, quieter stretch: the stall re-plan waits. */
const QUIET_RE = /\b(quiet|quieter|slow|slower|calm|calmer|linger|rest|breathe|breather|take (?:it|our|my|their) time|no rush|let it sit)\b/i;

const DEVIATION_GAP = 3;

/** The queued openings' words, for telling who a plan centres on. */
export const queuedBeatText = (state) => arr(state.beats).filter(b => b.status === 'queued').map(b => {
    const { goal, pressure } = beatText(b);
    return `${goal} ${pressure}`;
}).join(' ');

export function planTrigger(state, cfg = { cadence: 0 }) {
    if (!state.genre) return null;
    if (!state.arc) return 'arc';
    const m = state.meta;
    const queued = state.beats.filter(b => b.status === 'queued').length;
    if (!queued) return 'queue empty';
    // The player settled something: openings that press it must go now (owner, 21 Nov 2026).
    const settledNow = (m.settledPending ?? []).filter(t => (state.settled ?? []).some(s => s.text === t));
    if (settledNow.length) return `settled by the player: ${settledNow.join('; ')}. Drop every opening that presses it, and plan something new`;
    // Threads running low: the last opening is in use and little is left open. Refill before the queue runs dry.
    // Held to the deviation gap (audit, 21 Nov 2026: a plan leaving one beat re-planned every turn).
    if (queued === 1 && awakeThreads(state).length < 2 && m.turn - m.lastPlanTurn >= DEVIATION_GAP) return 'threads running low: plan new openings from what is in play, tied to the cast and the spine';
    // A dropped opening re-plans, but not sooner than DEVIATION_GAP turns after the last plan while openings remain:
    // the next pass-by is often the player still finishing what they chose.
    if (m.deviationTurn >= 0 && m.deviationTurn > m.lastPlanTurn && (queued <= 1 || m.turn - m.lastPlanTurn >= DEVIATION_GAP)) return 'deviation';
    if (state.instructions.some(i => !i.planned)) return 'player request';
    // Stall: replies in a row that recorded nothing new. A recent player direction asking for quiet wins.
    const stall = Number(cfg.stallAfter ?? m.stallAfter ?? 0);
    const wantsQuiet = state.instructions.some(i => m.turn - (i.turn ?? 0) <= 3 && QUIET_RE.test(String(i.text ?? '')));
    if (stall > 0 && (m.quiet ?? 0) >= stall && !wantsQuiet) {
        return `stalled: ${m.quiet} replies in a row recorded nothing new. Bring one small opening to where the player already is, with the people present; never cut the scene short or force an event`;
    }
    if (cfg.cadence > 0 && m.turn - m.lastPlanTurn >= cfg.cadence) return 'cadence';
    return null;
}
