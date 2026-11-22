// Plan check: code flags on every validated plan, before it is logged. Code fixes what is certain (a hollow choice is
// retyped, a precondition tied to a time already passed is dropped). What needs words goes to one cheap rewrite call,
// and only when something is flagged. The check never blocks a plan, except that a beat that still scripts the player
// or fights the story's genre after the check is dropped (owner decision, 18 Nov 2026).

import { rotate } from './planner.js';
import { arr, clip, isObj, nameKey, str } from './util.js';

/** Flags that need a rewrite. `script` and `genre` beats are dropped when no accepted rewrite clears them. */
export const REWRITE_CODES = ['script', 'criterion', 'name', 'genre'];
export const DROP_CODES = ['script', 'genre'];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------ (a) scripts the player

// What may follow the player (or "you") at the start of a beat without deciding his action: his situation, or a modal.
// Things that happen to him (learns, hears, is told, receives) are his situation too.
const SUBJECT_STATE = /^(is|are|was|has|have|had|holds|owns|owes|knows|carries|keeps|remains|stays|possesses|learns|hears|receives|gets|finds out|may|might|can|could|would|still|already|no longer)\b/i;
const AGREES = /^(agree|agrees|agreed|decide|decides|decided|accept|accepts|accepted|choose|chooses|chose|chosen|consent|consents|consented|commit|commits|committed)$/i;
// "decides whether..." names the decision, not its outcome; "may choose" leaves it open.
const OPEN_AFTER = /^\s*(whether|between|if|which|how)\b/i;
const MODAL = /^(may|might|can|could|would|should|must|to|not|never|if|whether)$/i;

function subjects(player) {
    const p = str(player, 80);
    const names = [...new Set([p, p.split(/\s+/)[0]])].filter(n => n.length >= 2).map(esc);
    return [...names, 'the player(?: character)?', 'you'];
}

// The player's body or clothes changed by the plan ("Max's collar has come loose", "the scar over Max's ribs is
// offered"): the narrator would have to set his state, which only the player's message may do (found live, 18 Nov 2026).
const CHANGED = '(?:(?:is|are|was|were|has|have|had)\\s+(?:been\\s+)?)?(?:come|comes|came|coming|slip|slips|slipped|fall|falls|fell|roll|rolls|rolled|loosen|loosens|loosened|open|opens|opened|shift|shifts|shifted|offered|shown|bared|exposed|revealed|undone|pulled|pushed|rides|ridden)\\b';

/**
 * True when any clause starts with the player (name, "the player", "you") doing something, when the player's body or
 * clothes are changed by the text, or when it says he agrees or decides.
 */
export function scriptsPlayer(text, player) {
    const t = str(text, 400).trim();
    if (!t) return false;
    const subj = subjects(player).join('|');
    // Every clause, not only the first: "The fire is high, and Max takes off his coat" scripts him as much.
    const clauses = t.split(/(?<=[.!?;:])\s+|,\s*(?:and|then|but|so|while)\s+|\s+(?:and|then)\s+/i).map(s => s.trim()).filter(Boolean);
    for (const clause of clauses) {
        const lead = new RegExp(`^(?:${subj})\\b(?!['’]s\\b)\\s*(.*)$`, 'iu').exec(clause);
        if (lead && lead[1]) {
            const first = lead[1].split(/\s+/)[0].replace(/[^\p{L}]/gu, '');
            // "Max decides whether to..." is left to the agreement test below; any other action of his is scripted.
            if (!AGREES.test(first) && !SUBJECT_STATE.test(lead[1])) return true;
        }
    }
    if (new RegExp(`\\b(?:${subj})['’]s\\s+\\p{L}+(?:\\s+\\p{L}+)?\\s+${CHANGED}`, 'iu').test(t)) return true;
    // Anywhere: the player, then up to two words, then agrees/decides/accepts, unless a modal leaves it open.
    const re = new RegExp(`\\b(?:${subj})\\b(?!['’]s\\b)`, 'giu');
    for (let m; (m = re.exec(t));) {
        // "if the player agrees" is a condition, not a script.
        if (/\b(if|unless|whether|until|once|when|should)\s+$/i.test(t.slice(0, m.index))) continue;
        if (agreesAt(t.slice(m.index + m[0].length))) return true;
    }
    return false;
}

/** Does the text right after the subject say he agrees, decides or accepts (within three words, no modal first)? */
function agreesAt(rest) {
    const toks = rest.trim().split(/\s+/);
    for (let i = 0; i < Math.min(3, toks.length); i++) {
        const w = toks[i].replace(/[^\p{L}]/gu, '');
        if (MODAL.test(w)) return false;
        if (AGREES.test(w)) return !OPEN_AFTER.test(toks.slice(i + 1).join(' '));
    }
    return false;
}

// ------------------------------------------------------------ (b) copies a criterion

const STOP = new Set(('the a an and or but of to in on at by for with from into onto over under about as is are was were be been has have had his her their its '
    + 'he she they them him it this that these those who whom whose which what when where while than then there here not no now still yet very '
    + 'own one some any all each every more most such only also just will would can could may might must shall should does did done do').split(' '));
const words = (s) => (nameKey(s).match(/[\p{L}\p{N}'’]+/gu) ?? []).map(w => w.replace(/['’]s$/u, '').replace(/s$/, '')).filter(w => w.length >= 3 && !STOP.has(w));

/** Share of a criterion's content words found in the text. A copy needs at least 3 shared words and 70% coverage. */
export const COPY_MIN_WORDS = 3;
export const COPY_COVERAGE = 0.7;
export function copiedCriterion(text, criteria) {
    const have = new Set(words(text));
    for (const c of arr(criteria)) {
        const cw = [...new Set(words(c.text))];
        if (cw.length < COPY_MIN_WORDS) continue;
        const shared = cw.filter(w => have.has(w)).length;
        if (shared >= COPY_MIN_WORDS && shared / cw.length >= COPY_COVERAGE) return c;
    }
    return null;
}

/** Open criteria of every ending and of milestones still in play. */
export function openCriteria(spine) {
    if (!spine) return [];
    const items = [...arr(spine.endings), ...arr(spine.milestones).filter(m => m.status !== 'concluded' && m.status !== 'skipped')];
    return items.flatMap(i => arr(i.criteria)).filter(c => c.mark === 'open' && str(c.text));
}

// ------------------------------------------------------------ (c) hollow choice

const ALTERNATIVE = /\b(or|either|whether|instead|rather|unless|otherwise|versus|vs)\b/i;
export const hollowChoice = (b) => b.type === 'choice' && !ALTERNATIVE.test([b.goal, b.pressure, b.precondition].join(' '));

// ------------------------------------------------------------ (d) name clash

const STARTERS = new Set('word news rumour rumours someone something nobody everyone after before late early once soon meanwhile somewhere outside inside across'.split(' '));
const NOT_NAMES = new Set(['I', 'The', 'A', 'An', 'If', 'When', 'While', 'As', 'At', 'In', 'On', 'One', 'Someone', 'Something', 'Sir', 'Lady', 'Lord', 'Mr', 'Mrs', 'Ms', 'Dr']);

function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[a.length][b.length];
}

/** Runs of capitalised words. A sentence's first word counts unless it is a common word ("Then", "Every"). */
function nameRuns(text) {
    const runs = [];
    for (const sentence of String(text).split(/(?<=[.!?;:])\s+/)) {
        const toks = sentence.split(/\s+/).map(t => t.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, '').replace(/['’]s$/u, ''));
        let run = [];
        toks.forEach((t, i) => {
            const cap = /^\p{Lu}/u.test(t) && !NOT_NAMES.has(t);
            if (cap && !(i === 0 && (STOP.has(t.toLowerCase()) || STARTERS.has(t.toLowerCase())))) run.push(t);
            else { if (run.length) runs.push(run); run = []; }
        });
        if (run.length) runs.push(run);
    }
    return runs;
}

/**
 * A new proper name too close to one already in the story: a new full name sharing a known first name ("Elsa Brand"
 * beside "Elsa"), or a new word one edit from a known name ("Elza" beside "Elsa"; both at least 4 letters).
 * @returns {{name: string, like: string} | null}
 */
export function nameClash(text, names, knownText = '') {
    const known = names.map(n => str(n, 80)).filter(Boolean);
    const knownTok = new Set(known.flatMap(n => nameKey(n).split(/\s+/)));
    const knownFull = new Set(known.map(n => nameKey(n)));
    const firsts = new Map(known.map(n => [nameKey(n).split(/\s+/)[0], n]));
    const seen = new Set((String(knownText).match(/\p{Lu}[\p{L}'’-]*/gu) ?? []).map(w => nameKey(w.replace(/['’]s$/u, ''))));
    for (const run of nameRuns(text)) {
        const keys = run.map(w => nameKey(w));
        const fresh = keys.filter(k => !knownTok.has(k) && !seen.has(k));
        if (!fresh.length) continue;
        const full = keys.join(' ');
        if (keys.length > 1 && firsts.has(keys[0]) && !knownFull.has(full)) return { name: run.join(' '), like: firsts.get(keys[0]) };
        for (const k of fresh) {
            if (k.length < 4) continue;
            const like = known.find(n => nameKey(n).split(/\s+/).some(t => t.length >= 4 && editDistance(t, k) === 1));
            if (like) return { name: run[keys.indexOf(k)], like };
        }
    }
    return null;
}

// ------------------------------------------------------------ (e) past date

const TOD = { dawn: 0, sunrise: 0, daybreak: 0, morning: 1, noon: 2, midday: 2, afternoon: 3, dusk: 4, sunset: 4, sundown: 4, nightfall: 4, evening: 4, night: 5, midnight: 6 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const todOf = (s) => { const m = nameKey(s).match(new RegExp(`\\b(${Object.keys(TOD).join('|')})\\b`)); return m ? TOD[m[1]] : -1; };
const dayOf = (s) => { const m = nameKey(s).match(/\bday (\d+)\b|\b(\d+)(?:st|nd|rd|th) day\b/); return m ? Number(m[1] ?? m[2]) : -1; };
function dateOf(s) {
    const k = nameKey(s);
    const re = new RegExp(`\\b(?:(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MONTHS.join('|')})|(${MONTHS.join('|')}) (\\d{1,2})(?:st|nd|rd|th)?)\\b`);
    const m = k.match(re);
    if (!m) return -1;
    const month = MONTHS.indexOf(m[2] ?? m[3]), day = Number(m[1] ?? m[4]);
    return month * 40 + day;
}

/**
 * True when the precondition is tied to a time the story has already passed: an earlier "day N" or date than the
 * scene's time, or a time of day earlier than now ("before nightfall" when it is night, "this morning" in the evening).
 * Anything that looks ahead ("tomorrow", "next") is never past. Needs an established scene time.
 */
export function pastPrecondition(pre, now) {
    const p = nameKey(pre), n = nameKey(now);
    if (!p || !n) return false;
    if (/\b(tomorrow|next|later|again|another|following|coming)\b/.test(p)) return false;
    const pd = dayOf(p), nd = dayOf(n);
    if (pd >= 0 && nd >= 0) return pd < nd;
    const pdate = dateOf(p), ndate = dateOf(n);
    if (pdate >= 0 && ndate >= 0) return pdate < ndate;
    const pt = todOf(p), nt = todOf(n);
    if (pt < 0 || nt < 0) return false;
    if (/\b(before|until|till|by)\b/.test(p)) return nt >= pt;
    if (/\b(this|at|in the)\b/.test(p)) return nt > pt;
    return false;
}

// ------------------------------------------------------------ (f) fights the genre

const KILLING = /\b(kill|kills|killed|killing|murder\w*|slay|slays|slain|slew|execut(e|es|ed|ion)|assassinat\w*|corpse|dead body)\b/i;

/** Does an "avoid" item show up in the text: all its content words (one or two), or at least two of a longer item. */
// An avoid item is often a note on style ("rushing past the inn and its watchful regulars"). Sharing a word or two with
// it (the inn, the player's name) is not doing it: most of its words must be there, names of the story's people aside
// (found live, 19 Nov 2026: good beats were dropped for mentioning the inn).
function touchesAvoid(text, item, names = []) {
    const skip = new Set(arr(names).flatMap(n => words(n)));
    const have = new Set(words(text));
    const aw = [...new Set(words(item))].filter(w => !skip.has(w));
    if (!aw.length) return false;
    const shared = aw.filter(w => have.has(w)).length;
    return aw.length <= 2 ? shared === aw.length : shared >= Math.max(3, Math.ceil(aw.length * COPY_COVERAGE));
}

/** The first way the beat goes past the profile, in words, or ''. */
export function fightsGenre(text, genre, names = []) {
    const g = isObj(genre) ? genre : {};
    for (const a of arr(g.avoid)) if (touchesAvoid(text, a, names)) return `touches what the story avoids: "${a}"`;
    if (g.lethality === 'none' && KILLING.test(text)) return 'killing or death in a story with lethality none';
    return '';
}

// ------------------------------------------------------------ the check

/**
 * Code flags for one beat: [{code, reason}].
 * @param {object} b A validated beat ({goal, pressure, precondition, type}).
 * @param {object} ctx {player, criteria, names, knownText, genre}
 */
export function flagBeat(b, ctx) {
    const out = [];
    const goal = str(b.goal, 400), pressure = str(b.pressure, 400);
    if (scriptsPlayer(goal, ctx.player) || scriptsPlayer(pressure, ctx.player)) {
        out.push({ code: 'script', reason: 'scripts the player character (his action, decision or agreement); state what the world offers instead' });
    }
    const copy = copiedCriterion(pressure, ctx.criteria);
    if (copy) out.push({ code: 'criterion', reason: `the pressure copies spine criterion ${copy.id} ("${copy.text}"); the goal may name it, the pressure must be an opening in the world in its own words` });
    const clash = nameClash(`${goal}. ${pressure}`, arr(ctx.names), ctx.knownText);
    if (clash) out.push({ code: 'name', reason: `the new name "${clash.name}" is too close to "${clash.like}"; use a clearly different name, or ${clash.like} if that person is meant` });
    const fight = fightsGenre([goal, pressure, b.precondition].join(' '), ctx.genre, [ctx.player, ...arr(ctx.names)]);
    if (fight) out.push({ code: 'genre', reason: `fights the story profile: ${fight}` });
    return out;
}

/** The check's context from view state: player, open criteria, known names, text that already names people, profile. */
export function planCheckContext(state, loreKeys = []) {
    const names = [...Object.keys(state?.cast ?? {}), state?.meta?.player, ...arr(loreKeys)].filter(Boolean);
    const sp = state?.spine;
    const knownText = [state?.premise, sp?.question, ...arr(sp?.endings).flatMap(e => [e.title, e.how, ...arr(e.criteria).map(c => c.text)]),
        ...arr(sp?.milestones).flatMap(m => [m.title, ...arr(m.criteria).map(c => c.text)]), state?.scene?.location?.value].filter(Boolean).join(' . ');
    return {
        player: state?.meta?.player ?? '', criteria: openCriteria(sp), names, knownText, genre: state?.genre ?? null,
        time: state?.scene?.time?.established ? state.scene.time.value : '', beatLog: arr(state?.meta?.beatLog),
    };
}

/**
 * Code fixes and flags on a validated plan (not changed; a copy is returned). Beats are given ids b1, b2... by position.
 * @returns {{plan: object, flags: {id: string, goal: string, pressure: string, codes: string[], reasons: string[]}[], fixed: string[]}}
 */
export function checkPlan(plan, ctx) {
    const copy = JSON.parse(JSON.stringify(plan));
    const fixed = [];
    copy.beats = arr(copy.beats).map((b, n) => {
        const id = `b${n + 1}`;
        if (hollowChoice(b)) { b.type = 'pressure'; fixed.push(`${id}: choice with no alternative, retyped as pressure`); }
        if (b.precondition && ctx.time && pastPrecondition(b.precondition, ctx.time)) { fixed.push(`${id}: precondition "${b.precondition}" already passed, dropped`); b.precondition = ''; }
        return b;
    });
    // A retyped choice can make three pressure beats in a row: rotate again, as the validator does.
    if (fixed.some(f => f.includes('retyped'))) copy.beats = rotate(copy.beats, arr(ctx.beatLog));
    const flags = [];
    copy.beats.forEach((b, n) => {
        const f = flagBeat(b, ctx);
        if (f.length) flags.push({ id: `b${n + 1}`, goal: b.goal, pressure: b.pressure, codes: f.map(x => x.code), reasons: f.map(x => x.reason) });
    });
    return { plan: copy, flags, fixed };
}

const CAP = 240;

/** Apply rewrites ({id, goal?, pressure?}) to a plan (a copy). */
export function applyPlanRewrites(plan, rewrites) {
    const copy = JSON.parse(JSON.stringify(plan));
    for (const r of arr(rewrites)) {
        const b = copy.beats[Number(String(r.id).slice(1)) - 1];
        if (!b) continue;
        // Clipped at a word, never mid-word: the narrator reads these (audit, 21 Nov 2026: "...with more blo").
        if (str(r.goal)) { b.goal = clip(r.goal, CAP); b.intent = b.goal; }
        if (str(r.pressure)) b.pressure = clip(r.pressure, CAP);
    }
    return copy;
}

/**
 * The check call's answer: one rewrite per flagged id, refused when the rewritten beat still trips any flag that needs
 * a rewrite. Nothing usable fails.
 */
export function validatePlanRewrites(raw, flags, plan, ctx) {
    if (!isObj(raw)) return { ok: false, error: 'not an object' };
    const flagged = new Set(arr(flags).map(f => f.id));
    const seen = new Set();
    const rewrites = arr(raw.rewrites).filter(isObj).map(r => ({ id: str(r.id, 10), goal: clip(r.goal, CAP), pressure: clip(r.pressure, CAP) }))
        .filter(r => (r.goal || r.pressure) && flagged.has(r.id) && !seen.has(r.id) && seen.add(r.id))
        .filter(r => {
            const b = applyPlanRewrites(plan, [r]).beats[Number(r.id.slice(1)) - 1];
            return !flagBeat(b, ctx).length;
        });
    if (!rewrites.length) return { ok: false, error: 'no usable rewrites' };
    return { ok: true, value: rewrites };
}

/**
 * The whole check on a validated plan: code fixes, then, only when something is flagged, one rewrite call through `ask`
 * (flags, draft) => rewrites. A failed call is reported through `onFail` and changes nothing but the drops.
 * @returns {Promise<{plan: object, fixed: string[], rewritten: string[], dropped: string[], flagged: number}>}
 */
export async function reviewPlan(plan, ctx, ask, onFail = () => {}) {
    const { plan: draft, flags, fixed } = checkPlan(plan, ctx);
    let rewrites = [];
    if (flags.length) {
        try { rewrites = arr(await ask(flags, draft)); } catch (e) { onFail(e); }
    }
    const { plan: out, dropped } = settlePlan(draft, flags, rewrites);
    return { plan: out, fixed, rewritten: rewrites.map(r => r.id), dropped, flagged: flags.length };
}

/**
 * After the check: drop beats still flagged for scripting the player or fighting the genre (no accepted rewrite).
 * Others stay as drafted. Returns the plan and the ids dropped; the plan may be left with no beats.
 */
export function settlePlan(plan, flags, rewrites = []) {
    const cleared = new Set(arr(rewrites).map(r => r.id));
    const drop = new Set(arr(flags).filter(f => !cleared.has(f.id) && f.codes.some(c => DROP_CODES.includes(c))).map(f => f.id));
    const out = applyPlanRewrites(plan, rewrites);
    out.beats = out.beats.filter((_, n) => !drop.has(`b${n + 1}`));
    return { plan: out, dropped: [...drop] };
}
