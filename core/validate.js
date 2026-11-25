// "Model proposes, code disposes": everything the observer model returns passes through here.
// Output is a clean delta plus a list of what was refused and why. Nothing here touches state.

import {
    AXES, BEAT_PROGRESS, CAPS, CAST_CHANGES, CERTAINTY, EVIDENCE, INITIATIVE, LORE_KINDS, SEVERITY, STATS, STATUS_OPS,
    SCORE_MAX, SCORE_MIN, STAGES, THREAD_OPS, WEIGHTS,
} from './enums.js';
import { FACT_KIND_WEIGHT } from './enums.js';
import { READINGS } from './spine.js';
import { castableRole, looksLikeName, matchQuote, normalise, quoteMatches, roleName } from './text.js';
import { arr, isBlank, isObj, nameKey, similarity, str } from './util.js';

const PLAYER_ALIASES = /^(the )?(player|player character|user|pc|protagonist|you|\{\{user\}\})$/;

/** Memory evidence is a copied passage from the earlier record supplied to this call. */
function memoryEvidence(quote, memory) {
    const passage = normalise(quote);
    if (!memory?.text || !Number.isInteger(memory.before) || passage.length < 8
        || !` ${normalise(memory.text)} `.includes(` ${passage} `)) return null;
    return { source: str(memory.source, 60) || 'External memory', before: memory.before };
}

/** An existing relationship needs a source quote. Omitted fields leave the record alone. */
export function validatePriorRelationship(raw, text) {
    if (!isObj(raw)) return null;
    const quote = str(raw.quote, 350);
    const passage = normalise(quote);
    if (!passage || passage.length < 8 || !` ${normalise(text)} `.includes(` ${passage} `)) return null;
    const stage = STAGES.includes(raw.stage) && raw.stage !== STAGES[0] ? raw.stage : null;
    const rel = Object.fromEntries(AXES.filter(axis => {
        const score = raw.rel?.[axis];
        return Number.isInteger(score) && score !== 0 && score >= SCORE_MIN && score <= SCORE_MAX;
    }).map(axis => [axis, raw.rel[axis]]));
    return stage || Object.keys(rel).length ? { ...(stage ? { stage } : {}), rel, quote } : null;
}

const TOP_KEYS = [
    'summary', 'scene', 'facts', 'confirmed', 'beliefs', 'settled', 'relationships', 'prior_relationships', 'stats', 'statuses', 'cast_changes',
    'threads', 'lore', 'contradictions', 'direction',
];

/**
 * @param {any} raw Parsed model output.
 * @param {object} ctx
 * @param {string} ctx.text The visible reply, already stripped of director text.
 * @param {string[]} ctx.names Known character names (cast, player). New names are allowed only through cast_changes.
 * @param {{fact: string}[]} [ctx.tombstones]
 * @param {string[]} [ctx.uncertainIds]
 * @param {string[]} [ctx.threadIds]
 * @param {string[]} [ctx.clueIds] Clues the previous brief offered.
 * @param {string} [ctx.player]
 * @returns {{delta: object, rejected: {kind: string, reason: string, item: any}[], accepted: number}}
 */
export function validateObservation(raw, ctx) {
    const rejected = [];
    let accepted = 0;
    const reject = (kind, reason, item) => rejected.push({ kind, reason, item });
    const hay = normalise(ctx.text);
    const quoted = (q) => quoteMatches(q, ctx.text, hay);
    /** The item with its quote in the reply's own words when the match was lenient (a name/pronoun swap). */
    const ownWords = (it) => {
        if (!isObj(it) || typeof it.quote !== 'string') return it;
        const q = matchQuote(it.quote, ctx.text, hay);
        return q && q !== it.quote ? { ...it, quote: q } : it;
    };
    const names = new Map(arr(ctx.names).map(n => [nameKey(n), n]));
    // Other names a known person goes by (from their lorebook keys) resolve to them.
    const aliases = new Map(Object.entries(isObj(ctx.aliases) ? ctx.aliases : {}).map(([a, n]) => [nameKey(a), n]).filter(([k, n]) => k && names.has(nameKey(n))));
    // Models write "the player", a first name, or a title plus surname. All of those are the same person.
    const resolve = (n) => {
        const k = nameKey(n);
        if (!k) return undefined;
        if (names.has(k)) return names.get(k);
        if (aliases.has(k)) return aliases.get(k);
        // "the hall master" and "Hall master" are one role character.
        const rk = nameKey(roleName(n));
        if (rk !== k && names.has(rk)) return names.get(rk);
        // "you" is the player character only when the story is told in the second person (audit map, 22 Nov 2026: a
        // narrator speaking to the reader made "you" mean the reader).
        if (ctx.player && PLAYER_ALIASES.test(k) && !(ctx.secondPerson === false && /^you$/.test(k))) return ctx.player;
        const hits = partial(k);
        return hits.length === 1 ? hits[0] : undefined;
    };
    /** A person known only by a role, admitted when they speak under it or a plan centres on them: their cast key, or ''. */
    const admitRole = (n) => {
        if (!castableRole(n, ctx.text, ctx.planned)) return '';
        const rn = roleName(n);
        names.set(nameKey(rn), rn);
        return rn;
    };
    /** Known names that share every word with `k`, one way or the other. */
    const partial = (k) => {
        const tok = k.split(' ');
        return [...names.entries()].filter(([key]) => {
            const kt = key.split(' ');
            return tok.every(t => kt.includes(t)) || kt.every(t => tok.includes(t));
        }).map(([, name]) => name);
    };
    /**
     * A new character's name must come from the reply, so the observer cannot invent one. Prose often uses only part
     * of a name ("Varn") once the full name is known; that counts when the full name already appears in what the
     * story knows (ctx.known: the player's message, established facts). Parts are words of 3+ letters, matched whole.
     */
    const known = normalise(ctx.known ?? '');
    const word = (p, text) => new RegExp(`(^|[^\\p{L}\\p{N}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(text);
    const namedInReply = (who) => {
        const n = normalise(who);
        if (hay.includes(n)) return true;
        if (!n) return false;
        // Every part of the name is already known as a word ("Elizabeth and Dorothy Juringen" knows "Elizabeth
        // Juringen"), and the reply uses at least one part.
        const parts = n.split(/\s+/).filter(Boolean);
        if (!parts.every(p => word(p, known))) return false;
        return parts.some(p => p.length >= 3 && word(p, hay));
    };
    /** A name that could be two known people is never taken as a third. */
    const ambiguous = (n) => !names.has(nameKey(n)) && partial(nameKey(n)).length > 1;

    const delta = {
        summary: '', scene: {}, facts: [], confirmed: [], beliefs: [], settled: [], relationships: [], stats: [], statuses: [],
        cast_changes: [], prior_relationships: [], threads: [], lore: [], contradictions: [], direction: { beat: 'untouched', clues_found: [], proof: null },
    };
    if (!isObj(raw)) {
        reject('output', 'not an object', raw);
        return { delta, rejected, accepted };
    }
    for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) reject('key', `unknown key "${k}"`, k);

    const from = new Map(); // accepted item -> the raw item it came from
    /** Shared gate: required quote, cap, then the item's own checks. */
    const each = (key, cap, fn) => {
        const list = arr(raw[key]);
        for (const item of list) {
            if (!isObj(item)) { reject(key, 'not an object', item); continue; }
            if (delta[key].length >= cap) { reject(key, 'over the per-reply cap', item); continue; }
            const out = fn(ownWords(item), item);
            if (typeof out === 'string') reject(key, out, item);
            else if (out) { delta[key].push(out); from.set(out, item); accepted++; }
        }
    };

    delta.summary = str(raw.summary, CAPS.summary);

    // New characters first, so later sections can refer to them.
    each('cast_changes', CAPS.cast_changes, (it) => {
        const who = str(it.who, 60);
        if (!who) return 'no name';
        if (!CAST_CHANGES.includes(it.change)) return 'unknown change';
        if (!quoted(it.quote)) return 'quote not in the reply';
        if (it.change === 'introduced') {
            if (!namedInReply(who)) return 'introduced name not in the reply';
            if (ambiguous(who)) return 'name matches more than one known character';
            if (!resolve(who) && !looksLikeName(who)) {
                if (!admitRole(who)) return 'a role, not a named character';
            } else if (!resolve(who)) names.set(nameKey(who), who);
        } else if (it.change === 'named') {
            // A role character's own name is revealed: the entry moves to the name, the role stays as another name.
            const r = resolve(who);
            const to = str(it.name, 60);
            if (!r) return 'unknown character';
            if (!to || !looksLikeName(to) || !namedInReply(to)) return 'named: the new name is not in the reply';
            if (resolve(to) && resolve(to) !== r) return 'named: that name is someone else';
            return { who: r, change: 'named', name: to, quote: str(it.quote) };
        } else if (!resolve(who)) return 'unknown character';
        return { who: resolve(who), change: it.change, quote: str(it.quote) };
    });

    if (isObj(raw.scene)) {
        const s = raw.scene;
        for (const field of ['location', 'time']) {
            const f = ownWords(s[field]);
            if (!isObj(f) || isBlank(f.value)) continue;
            // Established flags: a place or time counts only when the narration states it.
            if (!quoted(f.quote)) { reject('scene', `${field}: quote not in the reply`, f); continue; }
            delta.scene[field] = { value: str(f.value, 120), quote: str(f.quote) };
            accepted++;
        }
        if (Array.isArray(s.present)) {
            const present = [];
            for (const n of s.present) {
                const r = resolve(n);
                // A known character counts as present when the reply mentions them or they were already in the scene
                // (silent people stay); a known name pinned on someone the reply never names is refused (audit, 21 Nov 2026).
                if (r && !arr(ctx.present).includes(r) && !String(r).split(/\s+/).some(w => w.length >= 3 && hay.includes(normalise(w)))) {
                    reject('scene', 'present: not in the reply or the scene', n); continue;
                }
                if (r) { if (!present.includes(r)) present.push(r); continue; }
                // Not on record, but named in the reply itself: accept, so a forgotten "introduced" cannot drop someone.
                const name = str(n, 60);
                if (name && !looksLikeName(name) && hay.includes(normalise(roleName(name))) && admitRole(name)) present.push(roleName(name));
                else if (name && !looksLikeName(name)) reject('scene', 'present: a role, not a named character', n);
                else if (name && !ambiguous(name) && hay.includes(normalise(name))) { names.set(nameKey(name), name); present.push(name); }
                else reject('scene', 'present: unknown character', n);
            }
            delta.scene.present = present;
        }
        if (!isBlank(s.mood)) delta.scene.mood = str(s.mood, 60);
        if (INITIATIVE.includes(s.initiative)) delta.scene.initiative = s.initiative;
        if (s.cut === true) delta.scene.cut = true;
    }

    let factOrder = null;
    // The cap keeps the weightiest facts, not the first ones listed (audit, 21 Nov 2026: a revelation was cut for minor events).
    if (Array.isArray(raw.facts)) {
        const score = (f) => (isObj(f) && (FACT_KIND_WEIGHT[f.kind] ?? f.weight) === 'major' ? 1 : 0);
        factOrder = new Map(raw.facts.map((f, n) => [f, n]));
        raw = { ...raw, facts: raw.facts.map((f, n) => [f, n]).sort((a, b) =>
            Number(a[0]?.source === 'memory') - Number(b[0]?.source === 'memory') || score(b[0]) - score(a[0]) || a[1] - b[1]).map(([f]) => f) };
    }
    each('facts', CAPS.facts, (it, original) => {
        const fact = str(it.fact, CAPS.fact);
        if (!fact) return 'empty fact';
        // The observer names the kind; code decides the weight. Gestures and scenery are not facts.
        const kind = typeof it.kind === 'string' ? it.kind.trim().toLowerCase() : '';
        const kw = FACT_KIND_WEIGHT[kind];
        if (kw === 'dropped') return `not a fact: ${kind}`;
        // Unknown or missing kind keeps the fact as minor; a legacy "weight" counts only when no kind was given.
        const weight = kw ?? (!kind && it.weight === 'major' ? 'major' : 'minor');
        const recalled = original.source === 'memory';
        const quote = str(recalled ? original.quote : it.quote);
        const memory = recalled ? memoryEvidence(quote, ctx.memory) : null;
        if (recalled ? !memory : !quoted(it.quote)) return recalled ? 'quote not in the earlier memory' : 'quote not in the reply';
        if (arr(ctx.tombstones).some(t => similarity(t.fact, fact) >= 0.7)) return 'retconned fact';
        if (delta.facts.some(f => similarity(f.fact, fact) >= 0.9)) return 'duplicate';
        let witnesses = 'present';
        if (memory) witnesses = [];
        else if (Array.isArray(it.witnesses)) witnesses = it.witnesses.map(resolve).filter(Boolean);
        return {
            fact, quote, certainty: CERTAINTY.includes(it.certainty) ? it.certainty : 'implied',
            ...(memory ? { memory } : {}),
            weight, ...(kw ? { kind } : {}), witnesses, secret: it.secret === true,
        };
    });
    // Kept in the order the reply told them.
    if (factOrder) delta.facts.sort((a, b) => (factOrder.get(from.get(a)) ?? 0) - (factOrder.get(from.get(b)) ?? 0));


    each('confirmed', CAPS.facts, (it) => {
        if (!arr(ctx.uncertainIds).includes(it.id)) return 'unknown uncertain id';
        if (!quoted(it.quote)) return 'quote not in the reply';
        return { id: it.id, quote: str(it.quote) };
    });

    // Beliefs rest on presence evidence, not a quote: who was there when it was said. A quote is kept when given.
    each('beliefs', CAPS.beliefs, (it) => {
        const who = resolve(it.who);
        if (!who) return 'unknown character';
        const believes = str(it.believes, CAPS.fact);
        if (!believes) return 'empty belief';
        const present = delta.scene.present ?? ctx.present ?? [];
        if (!present.includes(who) && !quoted(it.quote)) return 'holder not present and no quote';
        return { who, believes, true: it.true === true, quote: quoted(it.quote) ? str(it.quote) : '' };
    });

    // Settled: the player character answered a matter for good, or the player has had enough of it. The quote may come
    // from the REPLY or from the player's own message (owner, 21 Nov 2026).
    const playerHay = normalise(ctx.playerMessage ?? '');
    const seenSettled = [];
    each('settled', CAPS.settled, (it) => {
        const text = str(it.text, 200);
        if (!text) return 'no text';
        const q = str(it.quote);
        const inPlayer = q && normalise(q).length >= 8 && quoteMatches(q, ctx.playerMessage ?? '', playerHay);
        if (!inPlayer && !quoted(q)) return "quote not in the reply or the player's message";
        if (seenSettled.includes(text)) return 'duplicate';
        seenSettled.push(text);
        return { text, quote: q, from: inPlayer ? 'player' : 'story' };
    });

    const axisCount = {};
    const priorSeen = new Set();
    each('prior_relationships', CAPS.cast_changes, (it, rawItem) => {
        const who = resolve(it.who);
        if (!who || !ctx.player || who === ctx.player || resolve(it.toward) !== ctx.player) return 'expected a cast member toward the player';
        if (priorSeen.has(who)) return 'prior relationship already recorded for this character';
        const value = validatePriorRelationship(rawItem, ctx.text);
        if (!value) return 'no valid prior relationship quoted from the reply';
        priorSeen.add(who);
        return { who, toward: ctx.player, ...value };
    });

    const PIVOTAL = ['action', 'sacrifice', 'shared_danger', 'betrayal'];
    const COSTLY = ['sacrifice', 'shared_danger', 'betrayal'];
    each('relationships', CAPS.relationships, (it) => {
        const who = resolve(it.who);
        const toward = resolve(it.toward ?? ctx.player);
        if (!who || !toward || who === toward) return 'unknown or identical characters';
        if (!AXES.includes(it.axis)) return 'unknown axis';
        if (it.dir !== 'up' && it.dir !== 'down') return 'unknown direction';
        if (!(it.weight in WEIGHTS)) return 'unknown weight';
        if (!EVIDENCE.includes(it.category)) return 'unknown evidence category';
        if (!quoted(it.quote)) return 'quote not in the reply';
        // Deeds weigh more than words (owner, 21 Nov 2026): words alone move a feeling one step at most, and a pivotal
        // step needs a pivotal kind of deed.
        let weight = it.category === 'words' ? 'minor' : it.weight;
        if (weight === 'pivotal' && !PIVOTAL.includes(it.category)) weight = 'major';
        // A sacrifice, shared danger or betrayal is never a small step (owner, 21 Nov 2026).
        if (weight === 'minor' && COSTLY.includes(it.category)) weight = 'major';
        const k = `${who}>${toward}:${it.axis}`;
        const step = WEIGHTS[weight];
        if ((axisCount[k] ?? 0) + step > CAPS.axisPerReply) return 'axis already moved the maximum this reply';
        axisCount[k] = (axisCount[k] ?? 0) + step;
        return { who, toward, axis: it.axis, dir: it.dir, weight, category: it.category, quote: str(it.quote) };
    });

    const statSeen = new Set();
    each('stats', CAPS.stats, (it) => {
        const who = resolve(it.who);
        if (!who) return 'unknown character';
        if (!STATS.includes(it.stat)) return 'unknown stat';
        if (it.dir !== 'up' && it.dir !== 'down') return 'unknown direction';
        if (!quoted(it.quote)) return 'quote not in the reply';
        if (statSeen.has(`${who}:${it.stat}`)) return 'stat already moved this reply';
        statSeen.add(`${who}:${it.stat}`);
        return { who, stat: it.stat, dir: it.dir, size: it.size === 'large' ? 'large' : 'small', quote: str(it.quote) };
    });

    each('statuses', CAPS.statuses, (it) => {
        const who = resolve(it.who);
        if (!who) return 'unknown character';
        if (!STATUS_OPS.includes(it.op)) return 'unknown op';
        const status = str(it.status, 60);
        if (!status) return 'empty status';
        if (!quoted(it.quote)) return 'quote not in the reply';
        return {
            who, op: it.op, status, quote: str(it.quote),
            severity: SEVERITY.includes(it.severity) ? it.severity : 'mild',
            affects: STATS.includes(it.affects) ? it.affects : null,
        };
    });

    const misfiledClues = [];
    each('threads', CAPS.threads, (it) => {
        if (!THREAD_OPS.includes(it.op)) return 'unknown op';
        if (!quoted(it.quote)) return 'quote not in the reply';
        if (it.op === 'open') {
            const text = str(it.text, 200);
            return text ? { op: 'open', text, quote: str(it.quote) } : 'empty thread';
        }
        if (!arr(ctx.threadIds).includes(it.id)) {
            // A misfiled id (live, 21 Nov 2026): a clue or unconfirmed-fact id sent under threads goes where it belongs.
            if (arr(ctx.clueIds).includes(it.id)) { misfiledClues.push(it.id); return null; }
            if (arr(ctx.uncertainIds).includes(it.id)) {
                if (!delta.confirmed.some(c => c.id === it.id)) { delta.confirmed.push({ id: it.id, quote: str(it.quote) }); accepted++; }
                return null;
            }
            return 'unknown thread id';
        }
        return { op: it.op, id: it.id, text: str(it.text, 200), quote: str(it.quote) };
    });

    each('lore', CAPS.lore, (it) => {
        const keys = arr(it.keys).map(k => str(k, 40)).filter(Boolean).slice(0, CAPS.loreKeys);
        const text = str(it.text, CAPS.loreText);
        if (!keys.length || !text) return 'needs keys and text';
        if (!quoted(it.quote)) return 'quote not in the reply';
        if (!keys.some(k => hay.includes(normalise(k)))) return 'no key appears in the reply';
        if (arr(ctx.tombstones).some(t => similarity(t.fact, text) >= 0.7)) return 'retconned fact';
        return {
            keys, text, kind: LORE_KINDS.includes(it.kind) ? it.kind : 'world',
            supersedes: typeof it.supersedes === 'string' ? str(it.supersedes, 60) : null, quote: str(it.quote),
        };
    });

    each('contradictions', CAPS.contradictions, (it) => {
        const correction = str(it.correction, 200);
        if (!correction) return 'no correction';
        if (!quoted(it.quote)) return 'quote not in the reply';
        return { quote: str(it.quote), conflicts_with: str(it.conflicts_with, 200), correction };
    });

    if (isObj(raw.direction)) {
        const { beat, source } = raw.direction;
        if (ctx.beatOffered && BEAT_PROGRESS.includes(beat) && beat !== 'untouched') {
            const required = beat === 'preempted' ? 'player' : beat === 'complete' ? (ctx.beatGoalSource ?? 'reply') : null;
            const passage = str(raw.direction.quote, 350);
            const original = source === 'player' ? normalise(ctx.playerMessage) : source === 'reply' ? hay : '';
            const proof = normalise(passage);
            if ((!required || source === required) && proof
                && (proof === original || (proof.length >= 5 && (' ' + original + ' ').includes(' ' + proof + ' ')))) {
                delta.direction.beat = beat;
                delta.direction.proof = { source, quote: passage };
            } else reject('direction', 'beat progress needs a quote from ' + (required ?? 'the reply or player message'), raw.direction);
        }
        for (const id of arr(raw.direction.clues_found)) {
            if (arr(ctx.clueIds).includes(id)) delta.direction.clues_found.push(id);
            else reject('direction', 'clue was not on offer', id);
        }
    }
    for (const id of misfiledClues) if (!delta.direction.clues_found.includes(id)) delta.direction.clues_found.push(id);

    return { delta, rejected, accepted };
}

/**
 * The fact clean-up's answer: merges of two or more live facts into one current wording, and minor facts to retire.
 * Unknown ids are dropped; a fact is used once; a major fact is never retired.
 * @param {object} raw
 * @param {{id: string, weight?: string}[]} facts the live facts that were offered
 */
export function validateCleanup(raw, facts) {
    if (!isObj(raw)) return { ok: false, error: 'not an object' };
    const byId = new Map(arr(facts).map(f => [f.id, f]));
    const used = new Set();
    const merges = [];
    for (const m of arr(raw.merge)) {
        if (!isObj(m)) continue;
        const ids = [...new Set(arr(m.ids).map(String))].filter(id => byId.has(id) && !used.has(id));
        const fact = str(m.fact, CAPS.fact);
        if (ids.length < 2 || !fact) continue;
        ids.forEach(id => used.add(id));
        merges.push({ ids, fact });
    }
    const retire = [...new Set(arr(raw.retire).map(String))].filter(id => byId.get(id)?.weight === 'minor' && !used.has(id));
    return { ok: true, value: { merges, retire } };
}

/** Evidence kinds a tracker mark may give; only the first two count toward "met". */
export const TRACKER_EVIDENCE = ['occurred', 'shown', 'implied'];

/**
 * Who speaks or acts in a quote, as the model names them, kept only when it is a known name and that name (or a part of
 * it) appears in the quote or within a sentence or so around it, where its speech tag would be. Otherwise ''.
 * @param {string[]} [names]
 */
export function speakerCheck(names, player = '') {
    const known = [...arr(names), player].filter(Boolean);
    return (who, text, quote) => {
        const w = nameKey(who);
        if (!w || !text) return '';
        const name = known.find(n => nameKey(n) === w) ?? known.find(n => nameKey(n).split(' ').includes(w)) ?? known.find(n => w.split(' ').includes(nameKey(n).split(' ')[0]));
        if (!name) return '';
        const hay = String(text);
        const lower = hay.toLowerCase();
        const head = String(quote ?? '').trim().slice(0, 24).toLowerCase();
        const at = head ? lower.indexOf(head) : -1;
        const span = at === -1 ? hay : hay.slice(Math.max(0, at - 160), at + String(quote ?? '').length + 160);
        const parts = nameKey(name).split(' ').filter(p => p.length >= 3);
        // Replies address the player character as "you".
        if (player && name === player && /(^|[^\p{L}])(you|your)($|[^\p{L}])/iu.test(span)) return name;
        return parts.some(p => new RegExp(`(^|[^\\p{L}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'iu').test(span)) ? name : '';
    };
}

/**
 * The spine tracker's answer: readings per ending, criteria met or failed, a milestone's event narrated.
 * Only ids the tracker was shown; every mark, every "happened" and every "against" needs a quote from a reply.
 * The tracker reads a batch of exchanges; each finding is tagged with the exchange (1-based) it came from, and a quote
 * must come from that exchange's reply. A quoted finding without an exchange is placed by where its quote is found.
 * @param {any} raw Parsed model output: { readings, marks, happened }.
 * @param {{texts?: string[], text?: string, spine: {endingIds: string[], criterionIds: string[], milestoneIds: string[]}}} ctx
 *   `texts`: the batch's replies, oldest first (`text` alone means a batch of one).
 * @returns {{delta: {readings: object[], marks: object[], happened: object[]}, rejected: {kind: string, reason: string, item: any}[], accepted: number}}
 */
export function validateTracking(raw, ctx) {
    const speakerOf = speakerCheck(ctx.names, ctx.player);
    const rejected = [];
    let accepted = 0;
    const reject = (kind, reason, item) => rejected.push({ kind, reason, item });
    const texts = arr(ctx.texts).length ? arr(ctx.texts).map(String) : [String(ctx.text ?? '')];
    const hays = texts.map(t => normalise(t));
    const count = texts.length;
    /** The exchange a finding belongs to: its stated number if its quote is there, else wherever the quote is found. */
    const placeQuote = (q, ex) => {
        const n = Number(ex);
        if (n >= 1 && n <= count && quoteMatches(q, texts[n - 1], hays[n - 1])) return n;
        const at = texts.findIndex((t, i) => quoteMatches(q, t, hays[i]));
        return at === -1 ? 0 : at + 1;
    };
    const exchangeOf = (ex) => { const n = Number(ex); return n >= 1 && n <= count ? n : count; };
    const delta = { readings: [], marks: [], happened: [] };
    if (!isObj(raw)) {
        reject('spine', 'not an object', raw);
        return { delta, rejected, accepted };
    }
    // Models sometimes wrap the answer in a "spine" key, as the observer once did.
    const src = isObj(raw.spine) ? raw.spine : raw;
    {
        const sp = ctx.spine ?? { endingIds: [], criterionIds: [], milestoneIds: [] };
        const seenEnding = new Set(), seenMark = new Set();
        for (const r of arr(src.readings)) {
            if (!isObj(r)) { reject('spine', 'reading: not an object', r); continue; }
            if (!arr(sp.endingIds).includes(r.ending)) { reject('spine', 'reading: unknown ending', r); continue; }
            if (!READINGS.includes(r.reading)) { reject('spine', 'reading: unknown value', r); continue; }
            if (seenEnding.has(r.ending)) { reject('spine', 'reading: ending already read', r); continue; }
            // Turning away from an ending is a decisive moment; it needs the narration to show it.
            // So does building toward one (live, 21 Nov 2026: unquoted "toward" readings made an ending lead).
            const quoted = r.reading !== 'aside';
            const exchange = quoted ? placeQuote(r.quote, r.exchange) : exchangeOf(r.exchange);
            if (!exchange) { reject('spine', `${r.reading}: quote not in the reply`, r); continue; }
            seenEnding.add(r.ending);
            delta.readings.push({ ending: r.ending, reading: r.reading, quote: quoted ? str(r.quote) : '', exchange });
            accepted++;
        }
        const marks = [...arr(src.marks)].sort((a, b) => Number(a?.source === 'memory') - Number(b?.source === 'memory'));
        for (const m of marks) {
            if (!isObj(m)) { reject('spine', 'mark: not an object', m); continue; }
            if (!arr(sp.criterionIds).includes(m.id)) { reject('spine', 'mark: criterion not on offer', m); continue; }
            if (m.mark !== 'met' && m.mark !== 'failed') { reject('spine', 'mark: unknown value', m); continue; }
            if (seenMark.has(m.id)) { reject('spine', 'mark: criterion already marked', m); continue; }
            // A settled matter closes a criterion by its id: no quote from this batch is needed, the player settled it
            // earlier (audit, 21 Nov 2026: the prompt asked for this, the validator refused every one).
            if (m.mark === 'failed' && typeof m.settled === 'string' && m.settled) {
                if (!arr(ctx.settledIds).includes(m.settled)) { reject('spine', 'failed: unknown settled matter', m); continue; }
                seenMark.add(m.id);
                delta.marks.push({ id: m.id, mark: 'failed', quote: '', exchange: texts.length, reason: `settled: ${m.settled}`, settled: m.settled });
                accepted++;
                continue;
            }
            // A failure is permanent, so it must say what makes the criterion impossible; "not shown here" is no reason.
            const reason = str(m.reason, 200);
            if (m.mark === 'failed' && reason.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').length < 3) { reject('spine', 'failed: no reason why it can never become true', m); continue; }
            // Only an event that happens, or a state plainly shown, counts toward "met"; a hint is noted as refused.
            const evidence = TRACKER_EVIDENCE.includes(m.evidence) ? m.evidence : '';
            if (m.mark === 'met' && evidence !== 'occurred' && evidence !== 'shown') { reject('spine', evidence ? 'met: implied evidence does not count' : 'met: no evidence kind', m); continue; }
            const recalled = m.source === 'memory';
            const quote = str(m.quote);
            const memory = recalled && m.mark === 'met' ? memoryEvidence(quote, ctx.memory) : null;
            const exchange = recalled ? (memory ? count : 0) : placeQuote(m.quote, m.exchange);
            if (!exchange) { reject('spine', recalled ? 'mark: needs a quote from the earlier memory for a met criterion' : 'mark: quote not in the reply', m); continue; }
            // A lasting state needs two different exchanges. A valid second one completes it; otherwise it is partly shown.
            let partial = false;
            let also;
            if (m.mark === 'met' && arr(sp.lastingIds).includes(m.id)) {
                const second = !memory && isObj(m.also) && m.also.source !== 'memory' ? placeQuote(m.also.quote, m.also.exchange) : 0;
                partial = !(second && second !== exchange);
                if (!partial) {
                    const speaker = speakerOf(m.also.by ?? m.by, texts[second - 1], m.also.quote);
                    also = { exchange: second, quote: str(m.also.quote), ...(speaker ? { speaker } : {}) };
                }
            }
            seenMark.add(m.id);
            delta.marks.push({
                id: m.id, mark: m.mark, quote, exchange, ...(evidence ? { evidence } : {}), ...(memory ? { memory } : {}),
                ...((who) => (who ? { speaker: who } : {}))(speakerOf(m.by, memory ? ctx.memory.text : texts[exchange - 1], quote)),
                ...(partial ? { partial: true } : {}), ...(also ? { also } : {}), ...(m.mark === 'failed' ? { reason } : {}),
            });
            accepted++;
        }
        for (const h of arr(src.happened)) {
            if (!isObj(h)) { reject('spine', 'happened: not an object', h); continue; }
            if (!arr(sp.milestoneIds).includes(h.milestone)) { reject('spine', 'happened: milestone not on offer', h); continue; }
            // A turning point comes with the criteria it settles. A milestone with open criteria needs one met here.
            const own = arr(sp.milestoneCriteria?.[h.milestone]);
            if (own.length && !delta.marks.some(m => m.mark === 'met' && own.includes(m.id))) { reject('spine', 'happened: none of its criteria marked met', h); continue; }
            const exchange = placeQuote(h.quote, h.exchange);
            if (!exchange) { reject('spine', 'happened: quote not in the reply', h); continue; }
            const who = speakerOf(h.by, texts[exchange - 1], h.quote);
            const supporting = delta.marks.filter(m => m.mark === 'met' && own.includes(m.id));
            const at = Math.max(exchange, ...supporting.map(m => Math.max(m.exchange, m.also?.exchange ?? 0)));
            delta.happened.push({ milestone: h.milestone, quote: str(h.quote), exchange, ...(at !== exchange ? { at } : {}),
                support: supporting.map(m => m.id), ...(who ? { speaker: who } : {}) });
            accepted++;
        }
    }

    return { delta, rejected, accepted };
}

/** The text around a quote in its source, for the evidence checker. */
export function aroundQuote(text, quote, before = 200, after = before) {
    const hay = String(text ?? '');
    const q = String(quote ?? '').trim();
    let at = q ? hay.toLowerCase().indexOf(q.toLowerCase()) : -1;
    // A quote matched with a name/pronoun swap: find the reply's own wording of it.
    if (at === -1 && q) {
        const own = matchQuote(q, hay);
        at = own ? hay.indexOf(own) : -1;
    }
    if (at === -1) return q;
    return hay.slice(Math.max(0, at - before), at + q.length + after).replace(/\s+/g, ' ').trim();
}

/** Accept a single verdict per known claim. Repeated or missing verdicts confer no confirmation. */
export function validateEvidenceCheck(raw, ids, checkBeat = false) {
    if (!isObj(raw) || !Array.isArray(raw.verdicts)) return { ok: false, error: 'no verdicts' };
    const known = new Set(arr(ids));
    const seen = new Set();
    const out = {};
    for (const v of raw.verdicts) {
        if (!isObj(v) || !known.has(v.id)) continue;
        if (seen.has(v.id)) {
            delete out[v.id];
            continue;
        }
        seen.add(v.id);
        const reason = str(v.reason, 200);
        if (checkBeat && !str(v.observed, 240)) continue;
        if (checkBeat && v.verdict === 'confirm') {
            if (!reason || typeof v.target?.required !== 'string' || typeof v.target?.actual !== 'string') continue;
            const required = str(v.target.required, 100);
            const actual = str(v.target.actual, 100);
            if (required && nameKey(required) !== nameKey(actual)) {
                out[v.id] = { verdict: 'reject', reason: `The goal names ${required}, but the quote establishes ${actual || 'no identified recipient'}.` };
                continue;
            }
        }
        if (v.verdict === 'confirm') out[v.id] = { verdict: 'confirm', ...(reason ? { reason } : {}) };
        else if (v.verdict === 'reject' && reason) out[v.id] = { verdict: 'reject', reason };
    }
    return { ok: true, value: out };
}

/**
 * Keep only confirmed quoted claims. A player-settled matter was checked by id before this pass.
 * A confirmed "happened" also needs surviving criterion support when the checklist has open criteria.
 * @param {{delta: object, rejected: object[], accepted: number}} v validateTracking's result (not changed)
 * @param {Record<string, {verdict: string, reason?: string}>} verdicts
 * @param {Record<string, string[]>} [milestoneCriteria]
 */
export function applyTrackCheck(v, verdicts, milestoneCriteria = {}) {
    const rejected = [...v.rejected];
    let accepted = v.accepted;
    const marks = [];
    for (const m of v.delta.marks) {
        const verdict = verdicts?.[m.id];
        if (!m.settled && verdict?.verdict !== 'confirm') {
            rejected.push({ kind: 'spine', reason: `check: ${verdict?.reason ?? 'no confirming verdict'}`, item: m });
            accepted--;
        } else marks.push(m);
    }
    const happened = [];
    for (const h of v.delta.happened) {
        const own = arr(milestoneCriteria[h.milestone]);
        const supporting = marks.filter(m => m.mark === 'met' && own.includes(m.id));
        const verdict = verdicts?.[h.milestone];
        if (verdict?.verdict !== 'confirm' || (own.length && !supporting.length)) {
            const reason = verdict?.verdict === 'confirm' ? 'none of its criteria still met' : (verdict?.reason ?? 'no confirming verdict');
            rejected.push({ kind: 'spine', reason: `check: ${reason}`, item: h });
            accepted--;
        } else happened.push({ ...h, support: supporting.map(m => m.id),
            at: Math.max(h.exchange, ...supporting.map(m => Math.max(m.exchange, m.also?.exchange ?? 0))) });
    }
    return { delta: { ...v.delta, marks, happened }, rejected, accepted };
}
