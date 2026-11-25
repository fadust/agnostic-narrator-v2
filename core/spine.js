// The spine: the setup's question, its possible answers (endings, Civ-style: all live at once) and the arc milestones
// that lead there. Endings and milestones each carry a checklist of criteria, met or failed in any order.
// Code only. The observer proposes marks and readings; this file decides what they do.
//
// state.spine = {
//   question: '',
//   endings:    [{ id, title, how, criteria: [Criterion] }]
//   milestones: [{ id, title, criteria: [Criterion], status: 'open' | 'concluded' | 'skipped', conclusion: '', happened?: {quote, source} }]
//   readings:   [{ turn, source, byEnding: { [endingId]: 'toward' | 'aside' | 'against' } }]   newest last, kept short
//   turnedAway: [endingId]          endings with a quoted "against" and no "toward" since
//   scene:      { key, toward, unread }  the scene in progress, whether anything in it built toward the spine, and
//                                    whether any of its replies still waits for the tracker
//   lastClosed: 'building' | 'drifting' | null     how the previous scene ended
//   closedTurn, againstTurn: the turn the last scene closed, and of the last "against" (when, not how many)
//   proposal:   null | { title, how, criteria: [text], reason }   a new ending the planner proposes; the player decides
// }
// Criterion = { id, text, mark: 'open' | 'met' | 'failed', by?: 'story' | 'player', quote?, turn?, source? }
// A concluded milestone keeps only its title and conclusion: its checklist is dropped.
// A skipped milestone (an earlier one still open when a later one concluded) keeps its checklist but is out of play: no
// conclusion, no chapter, never shown to the tracker or planner. The player can reopen it (op 'spine-reopen').

import { arr, isObj, nameKey, str } from './util.js';

export const MARKS = ['open', 'met', 'failed'];
export const READINGS = ['toward', 'aside', 'against'];
export const SPINE_CAPS = { endings: 4, milestones: 5, criteria: 4, readings: 12, observerMilestones: 2, text: 200, conclusion: 900 };

export const emptySpine = () => ({
    question: '', endings: [], milestones: [], readings: [], turnedAway: [], scene: { key: null, toward: false, unread: false }, lastClosed: null, proposal: null,
});

/** Counts for one ending or milestone. */
export function progress(item) {
    const c = arr(item?.criteria);
    return { met: c.filter(x => x.mark === 'met').length, failed: c.filter(x => x.mark === 'failed').length, open: c.filter(x => x.mark === 'open').length, total: c.length };
}

/** Find a criterion by id across endings and milestones. */
export function findCriterion(spine, id) {
    for (const kind of ['endings', 'milestones']) {
        for (const item of arr(spine?.[kind])) {
            const criterion = arr(item.criteria).find(c => c.id === id);
            if (criterion) return { kind: kind === 'endings' ? 'ending' : 'milestone', item, criterion };
        }
    }
    return null;
}

const openMilestones = (spine) => arr(spine?.milestones).filter(m => m.status !== 'concluded' && m.status !== 'skipped');

/** A later milestone concluded: every earlier one still open is skipped. Derived in replay, so a swiped conclusion undoes it. */
function skipEarlier(spine, id) {
    const ms = arr(spine?.milestones);
    const at = ms.findIndex(x => x.id === id);
    for (let i = 0; i < at; i++) if (ms[i].status !== 'concluded' && ms[i].status !== 'skipped') { ms[i].status = 'skipped'; delete ms[i].happened; }
}

/** Words that name a lasting state between people, for criteria drafted before the drafter said so itself. */
const LASTING_RE = /\b(trusts?|trusted|trusting|loyal(ty)?|devot(ed|ion)|owes?|owed|indebted|debt|all(y|ies|ied)|allegiance|friends?(hip)?|respects?|confides?|relies|rely|depends?|accepts? (him|her|them) as|loves?|swears?|sworn|backs? (his|her|their))\b/i;

/**
 * A lasting state (trust, a debt, an alliance) is met only when two different exchanges show it; one is "partly".
 * The drafter marks it (lasting: true/false); older criteria are judged by their wording.
 */
export const isLasting = (c) => (typeof c?.lasting === 'boolean' ? c.lasting : LASTING_RE.test(String(c?.text ?? '')));

/**
 * What the observer may see: every ending's title and open criteria, and the open criteria of the first open
 * milestones. Never the beats, never what is already resolved.
 */
export function spineForObserver(state) {
    const sp = state.spine;
    if (!sp) return null;
    const open = (item) => arr(item.criteria).filter(c => c.mark === 'open').map(c => ({
        id: c.id, text: c.text, ...(c.role ? { role: c.role } : {}), ...(isLasting(c) ? { lasting: true } : {}), ...(c.partial ? { partial: true } : {}),
    }));
    return {
        endings: arr(sp.endings).map(e => ({ id: e.id, title: e.title, criteria: open(e) })),
        // Skipped milestones stay on offer (owner, 22 Nov 2026): one that happens later is reopened.
        milestones: [...openMilestones(sp).slice(0, SPINE_CAPS.observerMilestones), ...arr(sp.milestones).filter(m => m.status === 'skipped').slice(-2)]
            .map(m => ({ id: m.id, title: m.title, criteria: open(m) })),
    };
}

/** Ids the observer may refer to, for the validator. */
export function spineIds(state) {
    const view = spineForObserver(state);
    if (!view) return { endingIds: [], criterionIds: [], milestoneIds: [], milestoneCriteria: {} };
    return {
        endingIds: view.endings.map(e => e.id),
        criterionIds: [...view.endings, ...view.milestones].flatMap(i => i.criteria.map(c => c.id)),
        milestoneIds: view.milestones.map(m => m.id),
        /** Open criterion ids per milestone on offer: "happened" needs one of them marked in the same answer. */
        milestoneCriteria: Object.fromEntries(view.milestones.map(m => [m.id, m.criteria.map(c => c.id)])),
        /** Criteria naming a lasting state: met only with two different exchanges. */
        lastingIds: [...view.endings, ...view.milestones].flatMap(i => i.criteria.filter(c => c.lasting).map(c => c.id)),
    };
}

/** Concluded milestones, oldest first: what the narrator gets as "Chapters so far". */
export const chapters = (state) => arr(state.spine?.milestones).filter(m => m.status === 'concluded' && m.conclusion).map(m => ({ id: m.id, title: m.title, conclusion: m.conclusion }));

/** Open milestones whose checklist is fully resolved, or whose event the narration showed. They wait for a conclusion. */
export const needsConclusion = (state) => openMilestones(state.spine).filter(m => m.happened || (arr(m.criteria).length && progress(m).open === 0));

/**
 * The ending that leads: the one the player is building toward. Turned-away endings never lead. Ranked by criteria met
 * and recent "toward" readings; ties go to the one read "toward" most recently.
 */
export function leadingEnding(spine) {
    const live = arr(spine?.endings).filter(e => !arr(spine.turnedAway).includes(e.id));
    if (!live.length) return null;
    const readings = arr(spine.readings);
    const score = (e) => progress(e).met * 2 + readings.filter(r => r.byEnding?.[e.id] === 'toward').length;
    const lastToward = (e) => readings.map((r, i) => (r.byEnding?.[e.id] === 'toward' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const best = live.slice().sort((a, b) => score(b) - score(a) || lastToward(b) - lastToward(a))[0];
    return score(best) > 0 ? best.id : null;
}

/**
 * Where the player stands, judged by scenes, never by counting replies.
 * building: something in the current scene built toward an ending or milestone (or, with nothing yet in this scene,
 *           the previous scene ended that way)
 * turning away: the latest reading has a quoted "against" and nothing in this scene built toward anything
 * drifting: the previous scene ended with nothing built
 */
export function spineState(spine) {
    if (!spine) return '';
    if (spine.scene?.toward) return 'building';
    if (Object.values(arr(spine.readings).at(-1)?.byEnding ?? {}).includes('against')) return 'turning away';
    return spine.lastClosed ?? '';
}

/**
 * True when every ending has been turned away from: the planner should propose a new one. Not again after the player
 * dismissed a proposal ("Keep the current endings"), until a new "against" comes after that.
 */
export const needsNewEnding = (spine) => arr(spine?.endings).length > 0 && arr(spine.endings).every(e => arr(spine.turnedAway).includes(e.id))
    && !spine.proposal && (spine.againstTurn ?? -1) > (spine.dismissedTurn ?? -1);

/**
 * Why the spine wants a re-plan now, or null. Each reason is a story event that happened after the last plan:
 * a scene closed with nothing built, an ending lost a criterion, or every ending was turned away from.
 */
export function spineTrigger(state) {
    const sp = state.spine;
    if (!sp) return null;
    const since = state.meta.lastPlanTurn;
    if (needsNewEnding(sp) && (sp.againstTurn ?? -1) > since) return 'every ending turned away';
    if (arr(sp.endings).some(e => arr(e.criteria).some(c => c.mark === 'failed' && (c.turn ?? -1) > since))) return 'an ending lost a criterion';
    if (sp.lastClosed === 'drifting' && (sp.closedTurn ?? -1) > since) return 'drifting';
    return null;
}

/** Plain data for the planner prompt. */
export function spineForPlanner(state) {
    const sp = state.spine;
    if (!sp) return null;
    const lead = leadingEnding(sp);
    const pending = (item) => arr(item.criteria).filter(c => c.mark === 'open').map(c => ({ id: c.id, text: c.text, ...(c.role ? { role: c.role } : {}) }));
    return {
        question: sp.question,
        state: spineState(sp),
        needsNewEnding: needsNewEnding(sp),
        endings: arr(sp.endings).map(e => ({
            id: e.id, title: e.title, how: e.how, ...progress(e), leading: e.id === lead, turnedAway: arr(sp.turnedAway).includes(e.id),
            open: pending(e), failedTexts: arr(e.criteria).filter(c => c.mark === 'failed').map(c => c.text),
        })),
        milestones: openMilestones(sp).map(m => ({
            id: m.id, title: m.title, open: pending(m), resolved: arr(m.criteria).filter(c => c.mark !== 'open').map(c => ({ text: c.text, mark: c.mark })),
        })),
        chapters: chapters(state),
    };
}

/**
 * The scene a reply belongs to: the place, and how many planner scenes have run out of beats so far
 * (state.meta.sceneSerial). Planner scene ids are not used: a re-plan renames them, and must not end a scene by itself.
 */
export const sceneKey = (state) => `${state.scene.location.established ? nameKey(state.scene.location.value) : ''}|${state.meta.sceneSerial ?? 0}`;

/**
 * Apply the observer's spine findings for one reply, and move the scene tracking on. Called for every read reply,
 * with or without findings, so scene boundaries are seen.
 * @param {object} state
 * @param {{readings?: {ending: string, reading: string, quote?: string}[], marks?: {id: string, mark: string, quote: string}[], happened?: {milestone: string, quote: string}[]}|undefined} sd validated delta.spine
 * @param {{mid: string}} entry
 * @param {string} key sceneKey after this reply
 * @param {boolean} [tracked] Whether the tracker has read this reply yet. A scene with unread replies is not called
 *   drifting when it closes: its findings may simply not be in yet.
 */
export function applySpineDelta(state, sd, entry, key, tracked = true) {
    const sp = state.spine;
    if (!sp) return;
    const turn = state.meta.turn;
    // A new place, or the planner's scene finished: the old scene closes with whatever it built.
    if (sp.scene.key !== null && sp.scene.key !== key) {
        sp.lastClosed = sp.scene.toward ? 'building' : sp.scene.unread ? null : 'drifting';
        sp.closedTurn = turn;
        sp.scene = { key, toward: false, unread: false };
    } else if (sp.scene.key === null) sp.scene.key = key;
    if (!tracked) sp.scene.unread = true;
    if (!isObj(sd)) return;
    let built = false;
    for (const m of arr(sd.marks)) {
        const hit = findCriterion(sp, m.id);
        if (!hit || hit.criterion.mark !== 'open' || !MARKS.includes(m.mark) || m.mark === 'open') continue;
        const speaker = str(m.speaker, 60);
        // A lasting state shown in one exchange is partly met; a second showing in another reply completes it.
        if (m.mark === 'met' && m.partial) {
            const first = hit.criterion.partial;
            if (m.memory && first) continue;
            if (!first || first.source === entry.mid) {
                hit.criterion.partial = { quote: str(m.quote), source: entry.mid, turn, ...(speaker ? { speaker } : {}), ...(m.memory ? { memory: m.memory } : {}) };
                continue;
            }
        }
        Object.assign(hit.criterion, { mark: m.mark, by: 'story', quote: str(m.quote), turn, source: entry.mid, ...(m.reason ? { reason: str(m.reason, 200) } : {}), ...(speaker ? { speaker } : {}), ...(m.memory ? { memory: m.memory } : {}) });
        if (m.mark === 'met' && !m.memory) built = true;
    }
    for (const h of arr(sd.happened)) {
        const ms = arr(sp.milestones).find(x => x.id === h.milestone && x.status !== 'concluded');
        // A skipped milestone that happens after all is reopened, and concludes like any other (owner, 22 Nov 2026).
        if (!ms || ms.happened) continue;
        if (h.support?.length && !arr(ms.criteria).some(c => c.mark === 'met' && h.support.includes(c.id))) continue;
        if (!h.support && h.exchange && ms.criteria?.some(c => c.partial) && !ms.criteria.some(c => c.mark === 'met')) continue;
        if (ms.status === 'skipped') ms.status = 'open';
        ms.happened = { quote: str(h.quote), source: entry.mid, ...(h.speaker ? { speaker: str(h.speaker, 60) } : {}) };
        built = true;
    }
    const byEnding = {};
    for (const r of arr(sd.readings)) {
        if (!READINGS.includes(r.reading) || !arr(sp.endings).some(e => e.id === r.ending)) continue;
        byEnding[r.ending] = r.reading;
        if (r.reading === 'toward') { built = true; sp.turnedAway = sp.turnedAway.filter(id => id !== r.ending); }
        if (r.reading === 'against') { sp.againstTurn = turn; if (!sp.turnedAway.includes(r.ending)) sp.turnedAway.push(r.ending); }
    }
    if (Object.keys(byEnding).length) {
        sp.readings.push({ turn, source: entry.mid, byEnding });
        if (sp.readings.length > SPINE_CAPS.readings) sp.readings.splice(0, sp.readings.length - SPINE_CAPS.readings);
    }
    if (built) sp.scene.toward = true;
}

/**
 * The tracker reads several replies in one call (a batch), and tags each finding with the exchange it came from.
 * This returns the findings for exchange `k` of `count`, so each lands on its own reply and in its own scene.
 * Findings without an exchange (an "aside" reading) belong to the last exchange.
 */
export function trackPart(delta, k, count) {
    if (!isObj(delta)) return undefined;
    const mine = (it) => (Number(it.exchange) || count) === k;
    const marks = [];
    for (const mark of arr(delta.marks)) {
        if (!mark.also) {
            if (mine(mark)) marks.push(mark);
            continue;
        }
        const { also, ...first } = mark;
        const second = { ...first, ...also, speaker: also.speaker };
        const [early, late] = first.exchange < second.exchange ? [first, second] : [second, first];
        if (early.exchange === k) marks.push({ ...early, partial: true });
        if (late.exchange === k) marks.push(late);
    }
    return { readings: arr(delta.readings).filter(mine), marks, happened: arr(delta.happened).filter(h => (h.at || h.exchange || count) === k) };
}

/** The planner's additions in a plan: alternative criteria for endings that lost one, and a proposed new ending. */
export function applyPlanSpine(state, v, tag) {
    const sp = state.spine;
    if (!sp || !isObj(v)) return;
    arr(v.alternatives).forEach((a, n) => {
        const e = arr(sp.endings).find(x => x.id === a.ending);
        if (!e || !str(a.text) || arr(e.criteria).length >= SPINE_CAPS.criteria + 3) return;
        if (arr(e.criteria).some(c => nameKey(c.text) === nameKey(a.text))) return;
        // One alternative per failed criterion: every re-plan sees the same failure, and must not add another each time.
        const failed = arr(e.criteria).filter(c => c.mark === 'failed').length;
        const alternatives = arr(e.criteria).filter(c => c.alternative).length;
        if (alternatives >= failed) return;
        e.criteria.push({ id: `${e.id}-a${tag}${n}`, text: str(a.text, SPINE_CAPS.text), mark: 'open', alternative: true });
    });
    if (isObj(v.new_ending) && str(v.new_ending.title) && needsNewEnding(sp)) {
        sp.proposal = {
            title: str(v.new_ending.title, 80), how: str(v.new_ending.how, SPINE_CAPS.text),
            criteria: arr(v.new_ending.criteria).map(c => str(c, SPINE_CAPS.text)).filter(Boolean).slice(0, SPINE_CAPS.criteria),
            reason: str(v.new_ending.reason, SPINE_CAPS.text),
        };
    }
}

/**
 * Spine operations, applied in replay.
 *   { kind: 'spine', by: 'setup', value }                    the drafted spine (validated); only when none exists
 *   { kind: 'conclusion', by: 'director', milestone, text }  a milestone concludes: keep the conclusion, drop the checklist
 *   { kind: 'spine-reopen', by: 'player', milestone }        the player reopens a skipped milestone
 *   { kind: 'spine-mark', by: 'player', id, mark }           the player ticks, fails or reopens a criterion
 *   { kind: 'spine-conclude', by: 'player', milestone }      "Conclude now": open criteria become failed
 *   { kind: 'spine-proposal', by: 'player', accept: bool }   accept or dismiss the proposed new ending
 * Text edits to the spine use the ordinary { kind: 'edit', path: 'spine', value } op.
 * @returns {boolean} true when the op was a spine op
 */
/**
 * A spine saved from the Plan tab is a full copy taken when the player pressed Save. Replay applies it after the
 * story findings on the same and earlier messages, which may be newer in real time. So a save changes only what the
 * Plan tab edits (question, titles, how, criterion texts, which items and criteria exist); what the story recorded
 * stays as replay has it: marks with their quotes, readings, scene state, turned-away endings, the proposal, and
 * concluded milestones.
 */
export function mergeSpineEdit(current, value) {
    if (!isObj(value)) return current;
    const next = { ...emptySpine(), ...structuredClone(value) };
    if (!current) return next;
    const STORY_KEYS = ['mark', 'by', 'quote', 'turn', 'source', 'alternative', 'reason', 'partial', 'speaker', 'memory'];
    const keepMarks = (item, prev) => {
        if (!prev) return;
        for (const c of arr(item.criteria)) {
            const old = arr(prev.criteria).find(x => x.id && x.id === c.id);
            if (!old) continue;
            for (const k of STORY_KEYS) delete c[k];
            for (const k of STORY_KEYS) if (old[k] !== undefined) c[k] = old[k];
        }
    };
    for (const e of arr(next.endings)) keepMarks(e, arr(current.endings).find(x => x.id === e.id));
    for (const m of arr(next.milestones)) {
        const prev = arr(current.milestones).find(x => x.id === m.id);
        if (prev?.status === 'concluded') {
            const text = m.status === 'concluded' ? m.conclusion : prev.conclusion;
            Object.assign(m, { status: 'concluded', conclusion: text, criteria: [] });
            delete m.happened;
            continue;
        }
        if (prev?.status === 'skipped' && m.status !== 'concluded') m.status = 'skipped';
        keepMarks(m, prev);
        if (prev?.happened) m.happened = prev.happened; else delete m.happened;
        if (m.status === 'concluded' && prev && prev.status !== 'concluded') Object.assign(m, { status: prev.status, conclusion: prev.conclusion, criteria: m.criteria?.length ? m.criteria : structuredClone(arr(prev.criteria)) });
    }
    const endingIds = new Set(arr(next.endings).map(e => e.id));
    for (const k of ['readings', 'scene', 'lastClosed', 'proposal', 'againstTurn', 'dismissedTurn']) if (current[k] !== undefined) next[k] = structuredClone(current[k]); else delete next[k];
    next.turnedAway = arr(current.turnedAway).filter(id => endingIds.has(id));
    return next;
}

export function applySpineOp(state, op, entry) {
    const turn = state.meta.turn;
    switch (op.kind) {
        case 'spine':
            if (!state.spine && isObj(op.value)) state.spine = { ...emptySpine(), ...structuredClone(op.value) };
            return true;
        case 'conclusion': {
            const m = arr(state.spine?.milestones).find(x => x.id === op.milestone);
            if (m) { m.status = 'concluded'; m.conclusion = str(op.text, SPINE_CAPS.conclusion); m.criteria = []; delete m.happened; skipEarlier(state.spine, m.id); }
            return true;
        }
        case 'spine-reopen': {
            const m = arr(state.spine?.milestones).find(x => x.id === op.milestone && x.status === 'skipped');
            if (m) m.status = 'open';
            return true;
        }
        case 'spine-mark': {
            const hit = findCriterion(state.spine, op.id);
            if (hit && MARKS.includes(op.mark)) {
                delete hit.criterion.memory;
                if (op.mark === 'open') { hit.criterion.mark = 'open'; for (const k of ['by', 'quote', 'turn', 'source', 'reason', 'partial', 'speaker']) delete hit.criterion[k]; }
                else { delete hit.criterion.reason; delete hit.criterion.speaker; Object.assign(hit.criterion, { mark: op.mark, by: 'player', quote: '', turn, source: entry.mid }); }
            }
            return true;
        }
        case 'spine-conclude': {
            const m = arr(state.spine?.milestones).find(x => x.id === op.milestone && x.status !== 'concluded' && x.status !== 'skipped');
            if (m) for (const c of arr(m.criteria)) if (c.mark === 'open') Object.assign(c, { mark: 'failed', by: 'player', quote: '', turn, source: entry.mid });
            if (m && !arr(m.criteria).length) m.happened = { quote: '', source: entry.mid };
            return true;
        }
        case 'spine-proposal': {
            const sp = state.spine;
            if (sp?.proposal && op.accept) {
                const id = `e-${entry.mid.slice(0, 6)}-${(op.at ?? 0) % 100000}`;
                sp.endings.push({ id, title: sp.proposal.title, how: sp.proposal.how, criteria: sp.proposal.criteria.map((text, n) => ({ id: `${id}-c${n}`, text, mark: 'open' })) });
            }
            if (sp?.proposal && !op.accept) sp.dismissedTurn = turn;
            if (sp) sp.proposal = null;
            return true;
        }
        default: return false;
    }
}

// ---------------------------------------------------------------- draft check (code flags before the spine is logged)

// Gestures and expressions: a scripted moment, not an objective.
const GESTURE = /\b(eye contact|looks? (at|into|away)|looked (at|into|away)|glanc(e|es|ed|ing)|nod(s|ded|ding)?|smil(e|es|ed|ing)|flinch(es|ed|ing)?|touch(es|ed|ing)?|blush(es|ed|ing)?|wink(s|ed)?|frown(s|ed)?|stares? at|stared at|gazes? at|gazed at|shrug(s|ged)?|grin(s|ned)?|sighs?|sighed)\b/i;
// Tallies of many scenes: counts, "several", "all of the", "first patrols".
const TALLY = /\b(twice|(once|two|three|four|five|six|seven|several|many|multiple|\d+) times|several|all of the|each of the|every one of|first \w+[^s\W]s)\b/i;
// Words that make a milestone read as the scene in progress (first meetings, arrivals, "tonight").
const SCENE_NOW = /\b(meets?|meeting|first (sight|look|glimpse|words|impression)|arriv(e|es|ed|al)|enters?|entered|walks in|tonight|this (scene|room|night|evening|morning|moment))\b/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// What may follow the player character's name in a criterion about his situation: a state verb, or "has/is/remains"
// followed by anything but a past participle ("has enough coin", not "has given up").
const PC_STATE = /^(possesses|holds|owns|owes|knows|carries|keeps|remains|stays|is (known|seen|named|trusted|owed|bound|free|no longer|the|a|an)\b|has (enough|a|an|the|no|some|his|her|their|\d)\b|is owed|is in)\b/i;
const capWords = (text) => (String(text).match(/\p{Lu}[\p{L}'’-]*/gu) ?? []).map(w => w.replace(/['’]s$/u, ''));

/**
 * Code flags on a drafted spine, one entry per flagged criterion: [{id, text, reason}]. Rules:
 * (a) the criterion begins with the player character's name (his actions are the player's, never an objective);
 * (b) it names a gesture or expression (eye contact, looks at, nods, smiles, flinches, touches...);
 * (c) it is a tally ("three times", "several", "all of the", "first patrols");
 * (d) milestone 1 only: every name in its criteria is someone present now (or the player), at least one is present,
 *     and its title or criteria read as the current scene (scene words, the location's words, or a gesture). Conservative.
 */
export function flagSpine(spine, { present = [], player = '', location = '' } = {}) {
    const out = new Map();
    const flag = (c, reason) => {
        const f = out.get(c.id);
        if (f) { if (!f.reason.includes(reason)) f.reason += `; ${reason}`; } else out.set(c.id, { id: c.id, text: c.text, reason });
    };
    const p = str(player, 80);
    const pNames = [...new Set([p, p.split(/\s+/)[0]])].filter(n => n.length >= 2);
    const pcLead = pNames.length ? new RegExp(`^(${pNames.map(esc).join('|')})\\b(?!['’]s\\b)`, 'iu') : null;
    const all = [...arr(spine?.endings), ...arr(spine?.milestones)].flatMap(item => arr(item.criteria));
    for (const c of all) {
        const t = str(c.text, 400);
        // His situation is allowed ("Max holds the writ", "Max knows who signed it", "Max has enough coin"); only an
        // action of his ("Max gives", "Max has given up") is the player's to decide.
        if (pcLead?.test(t) && !PC_STATE.test(t.replace(pcLead, '').trim())) flag(c, 'begins with the player character: his actions are the player\'s');
        if (GESTURE.test(t)) flag(c, 'a gesture or expression, not an objective');
        if (TALLY.test(t)) flag(c, 'a tally of many scenes');
    }
    const m1 = arr(spine?.milestones)[0];
    const here = arr(present).map(n => str(n, 80)).filter(Boolean);
    if (m1 && here.length && arr(m1.criteria).length) {
        const tok = (names) => new Set(names.flatMap(n => nameKey(n).split(' ')).filter(Boolean));
        const hereTok = tok(here), known = tok([...here, ...pNames]);
        let named = false, only = true;
        for (const c of m1.criteria) {
            // A capital at the start of the text ("The steward...") is not a name unless it is a known one.
            const first = (String(c.text).trim().split(/\s+/)[0] ?? '').replace(/['’]s$/u, '').replace(/[^\p{L}'’-]/gu, '');
            const words = capWords(c.text).filter((w, i) => w !== 'I' && !(i === 0 && w === first && !known.has(nameKey(w))));
            for (const w of words) {
                if (!known.has(nameKey(w))) only = false;
                if (hereTok.has(nameKey(w))) named = true;
            }
        }
        const locWords = nameKey(location).split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3);
        const blob = [m1.title, ...m1.criteria.map(c => c.text)].join(' ');
        const scene = SCENE_NOW.test(blob) || locWords.some(w => nameKey(m1.title).includes(w)) || m1.criteria.some(c => GESTURE.test(c.text));
        if (named && only && scene) for (const c of m1.criteria) flag(c, 'milestone 1 reads as the current scene; it must start after it');
    }
    return [...out.values()];
}

/** Apply the check pass's rewrites to a drafted spine (a copy): text, role and lasting of flagged criteria only. */
export function applySpineRewrites(spine, rewrites) {
    const copy = JSON.parse(JSON.stringify(spine));
    for (const r of arr(rewrites)) {
        const hit = findCriterion(copy, r.id);
        if (!hit || !str(r.text)) continue;
        hit.criterion.text = str(r.text, SPINE_CAPS.text);
        if (str(r.role)) hit.criterion.role = str(r.role, 120);
        if (typeof r.lasting === 'boolean') hit.criterion.lasting = r.lasting; else delete hit.criterion.lasting;
    }
    return copy;
}
