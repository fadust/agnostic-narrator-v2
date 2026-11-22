// State is never stored. It is rebuilt by replaying the records logged on the chat's own messages.
// That one rule gives swipe, delete, edit, branch and checkpoint handling for free: change the messages,
// replay, and the state matches them.
//
// Each message carries three things:
//   message.narrator_id          a stable id
//   message.narrator_ops         operations by the player or by setup (edits, retcons, profiles, roll-ups)
//   message.extra.narrator       { v, obs?: { hash, delta, accepted, rejected, beat }, track?: { covers: [{ mid, hash }], delta, rejected }, ops?: [director ops], err?, trackErr? }
//                                (track sits on the last reply of a spine-tracker batch; see scan)
// SillyTavern keeps a separate `extra` per swipe and swaps it when you swipe, so only what belongs to one
// swipe lives there: the observer's reading (bound to the reply's text by `hash`) and the director's ops that
// rest on it. The id and the player's own operations sit on the message itself, where swiping cannot touch them.
// Each op says who made it: 'director' ops rest on the reply they were logged on and die with it when it is
// swiped or edited; 'setup' ops (profiles, roll-ups) and 'player' ops do not depend on that reply and survive.

import {
    ARC_TENSION, AXES, BANDS, CAPS, SCORE_MAX, SCORE_MIN, SEVERITY, STAGES, STATS, STAT_BASELINE, STAT_STEP, STAT_STEP_LARGE, WEIGHTS,
} from './enums.js';
import { applyPlanSpine, applySpineDelta, applySpineOp, mergeSpineEdit, sceneKey, trackPart } from './spine.js';
import { applyAgendaOp, applyPlanAgendas, renameAgenda } from './agenda.js';
import { beatText } from './beat.js';
import { looksLikeName, stripDirector, stripTags } from './text.js';
import { arr, clamp, clone, hash, isObj, nameKey, setPath, similarity, uuid } from './util.js';

export const RECORD_VERSION = 1;
const STATUS_WORSEN_AFTER = 10;
const STATUS_EASE_AFTER = 4;

/** Legacy profiles may contain rating toggles. Keep their story data for replay. */
function storyGenre(value) {
    if (!isObj(value)) return null;
    const { pg, explicit, ...profile } = value;
    return clone(profile);
}

export function initialState(setup = {}) {
    return {
        genre: storyGenre(setup.genre),
        premise: setup.premise ?? '',
        arc: null,
        spine: null,
        scenes: [],
        beats: [],
        threads: [],
        scene: {
            location: { value: '', established: false },
            time: { value: '', established: false },
            present: [], mood: '', initiative: 'player',
        },
        cast: {},
        agendas: {},
        cards: {},
        canon: [],
        uncertain: [],
        summaries: { recent: [], rolled: '' },
        tombstones: [],
        lore_drafts: [],
        flags: [],
        notes: [],
        instructions: [],
        // Matters the player character has answered for good, or the player has had enough of (owner, 21 Nov 2026).
        // The planner never reopens them; the narrator's notes carry the latest.
        settled: [],
        meta: {
            turn: 0, lastPlanTurn: -1, planReason: '', deviationTurn: -1, beatLog: [], pending: [], unextracted: null,
            accepted: 0, rejected: 0, rejections: [], player: setup.player ?? '', staleRollup: false, lagging: false,
            removedCast: [], renamedCast: {}, sceneSerial: 0,
        },
    };
}

// ---------------------------------------------------------------- chat scanning

/**
 * @typedef {object} NarratorRef
 * @property {string} name
 * @property {string} [avatar]
 * @property {boolean} [group]
 * @property {string[]} [neutral] Opening prefixes of the card's neutral greetings.
 * @property {string[]} [strip] Other extensions' tags to remove, content included, before the director reads a reply.
 */

/** What a chat message is to the director. */
export function classify(m, narrator) {
    if (m?.extra?.narrator?.post) return 'post';
    if (m.is_user) return 'user';
    if (!narrator) return 'other';
    if (m.extra?.type) return 'other'; // SillyTavern system message types (/sys, help, and so on)
    const authored = narrator.group && m.original_avatar
        ? m.original_avatar === narrator.avatar
        : m.name === narrator.name;
    if (!authored) return 'other';
    // The card's neutral greetings say nothing about the story; they are not narration to record.
    const text = String(m.mes ?? '');
    if ((narrator.neutral ?? []).some(p => p && text.startsWith(p))) return 'other';
    return 'narration';
}

/** What the director reads of a reply: its own blocks removed, and other extensions' tags (narrator.strip). */
/** Turns a minor fact stays in what the models see. */
export const FACT_FADE = 3;

/**
 * The facts the models check against: every major fact (the newest `majors`) and minor facts from the last FACT_FADE
 * turns, in record order. Retired facts (by the clean-up) never. All of them stay in the record for the player.
 */
export function factsInView(state, majors = 40) {
    const live = state.canon.filter(f => !f.retired);
    const fresh = (f) => state.meta.turn - (f.turn ?? 0) <= FACT_FADE;
    const keep = new Set([...live.filter(f => f.weight !== 'minor').slice(-majors), ...live.filter(f => f.weight === 'minor' && fresh(f))]);
    return live.filter(f => keep.has(f));
}

const textCache = new WeakMap();
function reading(message, strip) {
    const raw = String(message?.mes ?? '');
    const key = arr(strip).join('\u0000');
    if (!message) return { text: '', hash: hash('') };
    let cached = textCache.get(message);
    if (cached?.raw !== raw) {
        cached = { raw, digest: hash(raw), plain: stripDirector(raw), variants: new Map() };
        textCache.set(message, cached);
    }
    if (!cached.variants.has(key)) {
        if (cached.variants.size >= 8) cached.variants.clear();
        const text = stripTags(cached.plain, strip);
        cached.variants.set(key, { text, hash: hash(text), rawHash: cached.digest });
    }
    return cached.variants.get(key);
}

export const visibleText = (m, narrator = null) => reading(m, narrator?.strip).text;
export const rawTextHash = (m) => reading(m).rawHash;

/** Strip lists used by earlier versions, for records that do not say which list they were read with. */
const LEGACY_STRIP = [['bbs_start', 'bbs_end', 'bbi_image']];

function replyKey(message, narrator) {
    const strip = message.narrator_revision?.strip ?? narrator?.strip;
    const digest = message.is_user ? rawTextHash(message) : reading(message, strip).hash;
    return `${message.swipe_id ?? 0}:${digest}`;
}

export function activeRevision(message, narrator) {
    const key = replyKey(message, narrator);
    return message.narrator_revision?.key === key ? message.narrator_revision.id : key;
}

function storyFingerprints(chat, narrator, through) {
    const revisions = new Map();
    let prefix = '';
    for (const message of chat) {
        const kind = classify(message, narrator);
        if (kind === 'narration' || kind === 'user') {
            prefix = hash(`${prefix}|${message.narrator_id}:${activeRevision(message, narrator)}`);
        }
        if (message.narrator_id) revisions.set(message.narrator_id, prefix);
        if (message === through) break;
    }
    return revisions;
}

/** Fingerprint of the story inputs through a stable anchor. Later messages do not invalidate it. */
export function storyBasis(chat, narrator, through = chat.at(-1)) {
    const mid = through?.narrator_id;
    if (!mid) return undefined;
    return { mid, fingerprint: storyFingerprints(chat, narrator, through).get(mid) };
}

function validBasis(op, fingerprints) {
    return !op.basis || fingerprints.get(op.basis.mid) === op.basis.fingerprint;
}

/**
 * Hashes a record may carry for this reply: the text as read now; with no tags stripped; with the tags its own records
 * were read with (obs.strip, track.strip); and with earlier default lists. A record made from any of them still stands,
 * so changing what is stripped never voids what was already read.
 */
export const textHashes = (m, narrator = null) => {
    const rec = m?.extra?.narrator;
    const lists = [arr(narrator?.strip), [], arr(rec?.obs?.strip), arr(rec?.track?.strip), ...LEGACY_STRIP];
    const seen = new Set();
    const out = [];
    for (const list of lists) {
        const key = list.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const h = reading(m, list).hash;
        if (!out.includes(h)) out.push(h);
    }
    return out;
};

/** One pass over the chat: classification, text hash and record state for every message. */
export function scan(chat, narrator, fingerprints = storyFingerprints(chat, narrator)) {
    let player = null;
    const entries = chat.map((m, i) => {
        const kind = classify(m, narrator);
        const revision = activeRevision(m, narrator);
        const rec = isObj(m.extra?.narrator) && (!m.narrator_revision || m.narrator_revision.id === revision) ? m.extra.narrator : null;
        const read = kind === 'narration' ? reading(m, narrator?.strip) : null;
        const text = read?.text ?? '';
        const h = read?.hash ?? '';
        const hashes = kind === 'narration' ? textHashes(m, narrator) : [];
        const ops = [...arr(m.narrator_ops), ...arr(rec?.ops)].filter(op => validBasis(op, fingerprints))
            .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
        const entry = {
            i, m, kind, rec, ops, text, hash: h, hashes, revision, mid: typeof m.narrator_id === 'string' ? m.narrator_id : null,
            hidden: m.is_system === true,
            valid: kind === 'narration' && !!rec?.obs && hashes.includes(rec.obs.hash) && (!rec.obs.revision || rec.obs.revision === revision)
                && (!rec.obs.player || (rec.obs.player.mid === (player?.narrator_id ?? null)
                    && rec.obs.player.revision === (player ? activeRevision(player, narrator) : null))),
            player,
            tracked: false, trackPart: undefined, trackValid: false,
        };
        if (m.is_user) player = m;
        return entry;
    });
    // The spine tracker reads replies in batches. A batch is stored on its last reply with the replies it covers,
    // and stands only while every one of them is unchanged. Each reply then gets its own share of the findings.
    const byMid = new Map(entries.filter(e => e.mid).map(e => [e.mid, e]));
    for (const e of entries) {
        const covers = arr(e.rec?.track?.covers);
        // A covered reply matches as it reads now, or as it read with the tag list this batch was made with.
        const batchStrip = e.rec?.track?.strip;
        const matches = (c) => {
            const t = byMid.get(c.mid);
            return !!t && (!c.revision || c.revision === t.revision)
                && (t.hashes.includes(c.hash) || (Array.isArray(batchStrip) && reading(t.m, batchStrip).hash === c.hash));
        };
        if (!covers.length || !covers.every(matches) || !validBasis(e.rec.track, fingerprints)) continue;
        e.trackValid = true;
        covers.forEach((c, n) => Object.assign(byMid.get(c.mid), { tracked: true, trackPart: trackPart(e.rec.track.delta, n + 1, covers.length) }));
    }
    let lastStory = -1;
    for (const e of entries) if ((e.kind === 'user' || e.kind === 'narration') && !e.hidden) lastStory = e.i;
    for (const e of entries) e.committed = e.kind === 'narration' && e.i < lastStory;
    return entries;
}

const sameOp = (a, b) => a.at === b.at && a.kind === b.kind && JSON.stringify(a) === JSON.stringify(b);

/**
 * Bring the chat's records in line with its text. Mutates the messages only.
 * - every message gets a stable id
 * - records written by earlier versions (id and all ops inside `extra`) are moved to the current layout
 * - a record whose hash no longer matches the reply (swipe, continue, edit, regenerate) loses its
 *   observation and the director's ops made on top of it; the player's own ops are untouched
 * @param {string[]} [knownMids] The ids seen last time, to report deletions.
 * @returns {{changed: boolean, stale: string[], deleted: string[], mids: string[]}}
 */
export function reconcile(chat, narrator, knownMids = null) {
    let changed = false;
    const stale = [];
    const seen = new Set();
    let firstChanged = Infinity;
    for (const [index, m] of chat.entries()) {
        if (!isObj(m.extra)) m.extra = {};
        let rec = m.extra.narrator;
        if (!isObj(rec)) { rec = m.extra.narrator = { v: RECORD_VERSION }; changed = true; }
        if (typeof m.narrator_id !== 'string') {
            m.narrator_id = typeof rec.mid === 'string' && !seen.has(rec.mid) ? rec.mid : uuid();
            changed = true;
        }
        if (seen.has(m.narrator_id)) {
            // A duplicate id means the message was copied; the copy starts clean.
            m.narrator_id = uuid();
            delete m.narrator_ops;
            rec = m.extra.narrator = { v: RECORD_VERSION };
            delete m.narrator_revision;
            changed = true;
        }
        seen.add(m.narrator_id);
        // Old layout, or a swipe restored from before the move: lift the id and the non-director ops out of `extra`.
        if ('mid' in rec) { delete rec.mid; changed = true; }
        if (arr(rec.ops).some(op => op.by !== 'director')) {
            const own = (m.narrator_ops ??= []);
            for (const op of rec.ops) if (op.by !== 'director' && !own.some(o => sameOp(o, op))) own.push(op);
            rec.ops = rec.ops.filter(op => op.by === 'director');
            changed = true;
        }
        if (rec.ops && !rec.ops.length) { delete rec.ops; changed = true; }
        const kind = classify(m, narrator);
        const key = replyKey(m, narrator);
        const prior = m.narrator_revision;
        const activeChanged = prior && prior.key !== key;
        if ((kind === 'user' || kind === 'narration' || prior) && prior?.key !== key) {
            m.narrator_revision = { key, id: uuid(), strip: prior?.strip ?? arr(narrator?.strip) };
            changed = true;
        }
        // Keep the host's swipe text and other extensions' data; current Director data lives in message.extra.
        for (const info of arr(m.swipe_info)) {
            if (!isObj(info?.extra?.narrator)) continue;
            for (const op of arr(info.extra.narrator.ops)) if (op.by === 'player') {
                const own = (m.narrator_ops ??= []);
                if (!own.some(o => sameOp(o, op))) own.push(op);
            }
            if (info.extra === m.extra) info.extra = { ...info.extra };
            delete info.extra.narrator;
            changed = true;
        }
        if (activeChanged || (rec.obs && kind === 'narration' && !textHashes(m, narrator).includes(rec.obs.hash))) {
            delete rec.obs;
            delete rec.ops;
            delete rec.track;
            delete rec.err;
            delete rec.trackErr;
            if (kind === 'narration') stale.push(m.narrator_id);
            firstChanged = Math.min(firstChanged, index);
            changed = true;
        }
    }
    const mids = chat.map(m => m.narrator_id);
    const deleted = knownMids ? knownMids.filter(id => !seen.has(id)) : [];
    if (deleted.length) firstChanged = Math.min(firstChanged, knownMids.indexOf(deleted[0]));
    const reordered = knownMids?.some((id, i) => id !== mids[i]);
    if (!knownMids || firstChanged !== Infinity || reordered) {
        const fingerprints = storyFingerprints(chat, narrator);
        for (const entry of scan(chat, narrator, fingerprints)) {
            const { m, rec, i, trackValid } = entry;
            if (rec?.obs && entry.kind === 'narration' && !entry.valid) {
                delete rec.obs;
                delete rec.err;
                stale.push(m.narrator_id);
                changed = true;
            }
            if (rec?.track && !trackValid) { delete rec.track; delete rec.trackErr; changed = true; }
            const valid = op => validBasis(op, fingerprints) && (op.basis || i < firstChanged || !legacyDerived(op));
            for (const owner of [m, rec].filter(Boolean)) {
                const prop = owner === m ? 'narrator_ops' : 'ops';
                if (!Array.isArray(owner[prop])) continue;
                const keep = owner[prop].filter(valid);
                if (keep.length !== owner[prop].length) {
                    if (keep.length) owner[prop] = keep;
                    else delete owner[prop];
                    changed = true;
                }
            }
        }
    }
    return { changed, stale, deleted, mids };
}

function legacyDerived(op) {
    return ['arc', 'plan', 'spine', 'conclusion', 'agendas', 'rollup', 'facts-clean'].includes(op.kind)
        || (op.kind === 'profile' && (op.story || op.lore))
        || (op.kind === 'edit' && op.replace && op.path === 'spine');
}

// ---------------------------------------------------------------- cast helpers

export function ensureCast(state, name) {
    if (!state.cast[name]) {
        state.cast[name] = {
            stage: STAGES[0], rel: { trust: 0, affection: 0, desire: 0, tension: 0 }, stances: {}, evidence: [],
            stageEvidence: [], knows: [], beliefs: [], statuses: [], stats: null, profile: '', gender: '', race: '', age_group: '', appearance: '', tells: null,
            temperament: null, unprompted: '', dead: false, pc: false, main: false,
        };
    }
    return state.cast[name];
}

/** Fill only relationship fields that have never been established in this chat. */
function seedRelationship(c, prior) {
    if (!prior || c.pc) return false;
    const fields = c.relationshipFields ??= {};
    let changed = false;
    if (prior.stage && !fields.stage && c.stage === STAGES[0]) {
        c.stage = prior.stage;
        fields.stage = true;
        changed = true;
    }
    for (const axis of AXES) {
        const key = `rel.${axis}`;
        if (prior.rel?.[axis] && !fields[key] && c.rel[axis] === 0) {
            c.rel[axis] = prior.rel[axis];
            fields[key] = true;
            changed = true;
        }
    }
    return changed;
}

/** One band for how an NPC stands toward the player: trust and affection carry it. */
export function bandOf(rel) {
    const s = (rel.trust + rel.affection) / 2;
    if (s <= -5) return BANDS[0];
    if (s <= -1.5) return BANDS[1];
    if (s < 2) return BANDS[2];
    if (s < 6) return BANDS[3];
    return BANDS[4];
}

export const stanceBand = (score) => bandOf({ trust: score, affection: score });

/**
 * The name a card's person goes by. The card's title is kept when the profile gives no name, or a fuller form of
 * it ("Mira" for "Mira Vell"), so records stay where they are; otherwise the name from the card text wins.
 */
export function castName(title, given) {
    const g = String(given ?? '').trim();
    return !g || g.toLowerCase().includes(String(title).toLowerCase()) ? title : g;
}

/** Card titles to the people they hold, once profiled. A card not yet profiled stands for itself. */
export const castPeople = (state, titles) => [...new Set(arr(titles).flatMap(t => state.cards?.[t]?.people ?? [t]))];

export const activeBeat = (state) => state.beats.find(b => b.status === 'queued') ?? null;

// ---------------------------------------------------------------- applying an observation

function progressStatuses(state) {
    const turn = state.meta.turn;
    for (const c of Object.values(state.cast)) {
        c.statuses = c.statuses.filter(s => {
            const idx = SEVERITY.indexOf(s.severity);
            if (!s.treated && idx >= 1 && turn - s.since >= STATUS_WORSEN_AFTER && idx < SEVERITY.length - 1) {
                // A serious untreated condition worsens, once, to critical: code does not kill characters.
                // Mild ones never worsen on their own, because a count of replies is not a measure of story time.
                s.severity = SEVERITY[idx + 1];
                s.since = turn;
                s.trend = 'worsening';
            } else if (s.treated && turn - s.since >= STATUS_EASE_AFTER) {
                if (idx === 0) return false;
                s.severity = SEVERITY[idx - 1];
                s.since = turn;
                s.trend = 'easing';
            }
            return true;
        });
    }
}

// Capitalised words that open sentences but are not names.
const NOT_NAMES = new Set(('the a an and but or if when while who what where why how his her their its this that these those there here '
    + 'someone something somebody nobody everyone a an he she they it we you i one some any each every no not after before since until '
    + 'whether will would can could may might must should').split(' '));

/** A thread's key words: its proper names (capitalised words of 3+ letters that are not common sentence openers), lower-cased. */
export function threadKeys(th) {
    const text = `${th.setup ?? ''} ${th.latest ?? ''}`;
    const keys = new Set();
    for (const m of text.matchAll(/\p{Lu}[\p{L}'’-]{2,}/gu)) {
        const k = m[0].toLowerCase().replace(/['’]s$/, '');
        if (!NOT_NAMES.has(k)) keys.add(k);
    }
    return [...keys];
}

/** Open threads still awake: seen within `after` turns, or naming someone present or the current place. 0 = all. */
export function awakeThreads(state, after = state.meta?.dormantAfter ?? 12) {
    const open = arr(state.threads).filter(t => t.status !== 'resolved');
    if (!(Number(after) > 0)) return open;
    const here = ` ${nameKey([...arr(state.scene?.present), state.scene?.location?.value ?? ''].join(' '))} `;
    return open.filter(t => state.meta.turn - (t.seen ?? 0) < Number(after) || threadKeys(t).some(k => here.includes(` ${k} `)));
}

export function applyDelta(state, obs, entry) {
    const d = obs.delta;
    const mid = entry.mid;
    const turn = state.meta.turn;
    const tag = obs.revision ? `${mid.slice(0, 8)}${obs.revision.slice(0, 8)}` : mid.slice(0, 8);
    const player = state.meta.player;
    const placeBefore = state.scene.location.established ? nameKey(state.scene.location.value) : null;
    const gone = new Set(arr(d.cast_changes).filter(c => c.change === 'departed' || c.change === 'dead').map(c => c.who));

    for (const c of arr(d.cast_changes)) {
        if (c.change === 'named') {
            if (state.cast[c.who] && c.name && c.name !== c.who) {
                renameCast(state, c.who, c.name);
                const p = state.cast[c.name];
                p.aliases = [...new Set([...arr(p.aliases), c.who])].slice(0, 8);
            }
            continue;
        }
        const who = ensureCast(state, c.who);
        const present = state.scene.present;
        if (c.change === 'introduced' || c.change === 'returned') {
            if (!present.includes(c.who)) present.push(c.who);
            if (c.change === 'introduced' && !who.introduced) who.introduced = mid;
        } else {
            state.scene.present = present.filter(n => n !== c.who);
            if (c.change === 'dead') who.dead = true;
        }
    }

    const s = d.scene ?? {};
    for (const f of ['location', 'time']) {
        if (s[f]) state.scene[f] = { value: s[f].value, established: true, source: mid };
    }
    if (Array.isArray(s.present)) {
        // The observer's list adds people; it never removes them by omission. A model that lists only who spoke
        // must not make a silent character vanish. People leave by a quoted "departed" or "dead", or when the
        // scene moves to a different place, where the new list stands on its own.
        // A cut (the REPLY ends somewhere else or with other people) counts as a move even when no new place is quoted
        // (audit, 22 Nov 2026: a cross-cut left the earlier scene's people present, and they became witnesses).
        const moved = s.cut === true || (!!s.location && placeBefore !== null && nameKey(s.location.value) !== placeBefore);
        const merged = moved ? [...s.present] : [...state.scene.present, ...s.present];
        state.scene.present = [...new Set(merged)].filter(n => n !== player && !state.cast[n]?.dead && !gone.has(n));
        for (const n of state.scene.present) ensureCast(state, n);
    }
    if (s.mood) state.scene.mood = s.mood;
    if (s.initiative) state.scene.initiative = s.initiative;
    // A death told only as a fact ("Rulf dies of his wounds") marks them dead too (audit map, 22 Nov 2026: a dead man
    // stayed in play because no "dead" cast change came with it). The name must open the fact: "Max killed Rulf" is not Max's death.
    for (const f of arr(d.facts)) {
        if (f.certainty !== 'stated') continue;
        for (const n of Object.keys(state.cast)) {
            if (n === player || state.cast[n].dead || state.cast[n].pc) continue;
            const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`^${esc}\\b[^.;]{0,30}?\\b(dies|died|is dead|was killed|has died|lies dead|is slain|was slain|breathes (his|her|their) last)\\b`, 'i').test(String(f.fact))) {
                state.cast[n].dead = true;
                state.scene.present = state.scene.present.filter(x => x !== n);
            }
        }
    }

    arr(d.facts).forEach((f, n) => {
        if (state.tombstones.some(t => similarity(t.fact, f.fact) >= 0.7)) return;
        // Models restate what is already on record. Canon keeps one copy; a hint that is now stated is promoted.
        if (state.canon.slice(-80).some(x => similarity(x.fact, f.fact) >= 0.85)) return;
        const hinted = state.uncertain.findIndex(x => similarity(x.fact, f.fact) >= 0.85);
        if (hinted !== -1) {
            if (f.certainty === 'stated') state.canon.push({ ...state.uncertain.splice(hinted, 1)[0], quote: f.quote, confirmed: mid });
            return;
        }
        const id = `${tag}-${n}`;
        const witnesses = f.witnesses === 'present' ? [...state.scene.present] : arr(f.witnesses);
        // Records from before facts were weighed carry no weight: they count as major, so nothing old fades away.
        const item = { id, fact: f.fact, quote: f.quote, source: mid, turn, witnesses, secret: !!f.secret, weight: f.weight === 'minor' ? 'minor' : 'major' };
        if (f.kind) item.kind = f.kind;
        (f.certainty === 'stated' ? state.canon : state.uncertain).push(item);
        for (const w of witnesses) {
            if (w === player) continue;
            ensureCast(state, w).knows.push({ fact: id, via: 'present', source: mid });
        }
    });


    for (const c of arr(d.confirmed)) {
        const at = state.uncertain.findIndex(u => u.id === c.id);
        if (at === -1) continue;
        const [item] = state.uncertain.splice(at, 1);
        state.canon.push({ ...item, quote: c.quote, confirmed: mid });
    }

    for (const b of arr(d.beliefs)) {
        const c = ensureCast(state, b.who);
        c.beliefs.push({ believes: b.believes, true: b.true, source: mid, turn });
        if (c.beliefs.length > 12) c.beliefs.shift();
    }

    for (const s of arr(d.settled)) addSettled(state, { text: s.text, quote: s.quote, by: s.from, source: mid, turn });

    let seededRelationship = false;
    for (const prior of arr(d.prior_relationships)) {
        if (prior.toward !== player || prior.who === player || !Object.hasOwn(state.cast, prior.who)) continue;
        seededRelationship = seedRelationship(state.cast[prior.who], prior) || seededRelationship;
    }
    for (const r of arr(d.relationships)) {
        const c = ensureCast(state, r.who);
        const step = WEIGHTS[r.weight] * (r.dir === 'up' ? 1 : -1);
        if (r.toward === player || !player) {
            c.rel[r.axis] = clamp(c.rel[r.axis] + step, SCORE_MIN, SCORE_MAX);
            const fields = c.relationshipFields ??= {};
            fields[`rel.${r.axis}`] = true;
            c.evidence.push({ axis: r.axis, dir: r.dir, category: r.category, source: mid });
            if (c.evidence.length > 20) c.evidence.shift();
            // A stage moves one step, and only on evidence from two different categories.
            const warming = (r.axis === 'trust' || r.axis === 'affection') && r.dir === 'up';
            const at = STAGES.indexOf(c.stage);
            if (warming) {
                if (!c.stageEvidence.includes(r.category)) c.stageEvidence.push(r.category);
                if (c.stageEvidence.length >= 2 && at < STAGES.length - 1 && BANDS.indexOf(bandOf(c.rel)) >= 2) {
                    c.stage = STAGES[at + 1];
                    fields.stage = true;
                    c.stageEvidence = [];
                }
            } else if (r.axis === 'trust' && r.dir === 'down' && r.weight !== 'minor' && at > 0) {
                c.stage = STAGES[at - 1];
                fields.stage = true;
                c.stageEvidence = [];
            }
        } else if (state.scene.present.includes(r.who) && state.scene.present.includes(r.toward)) {
            // NPC-to-NPC stances change only when both are in the scene.
            c.stances[r.toward] = clamp((c.stances[r.toward] ?? 0) + step, SCORE_MIN, SCORE_MAX);
        }
    }

    for (const st of arr(d.stats)) {
        const c = ensureCast(state, st.who);
        if (!c.stats) c.stats = Object.fromEntries(STATS.map(k => [k, STAT_BASELINE]));
        // Stats grow and decline with the story (owner, 21 Nov 2026): a small step for practice, a lesson, ageing or disuse;
        // a large one for a decisive event.
        const step = st.size === 'large' ? STAT_STEP_LARGE : STAT_STEP;
        c.stats[st.stat] = clamp(c.stats[st.stat] + (st.dir === 'up' ? step : -step), 1, 130);
    }

    for (const st of arr(d.statuses)) {
        const c = ensureCast(state, st.who);
        const at = statusIndex(c.statuses, st.status);
        if (st.op === 'add') {
            const item = { name: st.status, severity: st.severity, affects: st.affects, treated: false, since: turn, source: mid };
            if (at === -1) c.statuses.push(item); else c.statuses[at] = item;
        } else if (at !== -1) {
            const cur = c.statuses[at];
            if (st.op === 'clear') c.statuses.splice(at, 1);
            else if (st.op === 'treat') { cur.treated = true; cur.since = turn; cur.trend = 'treated'; }
            else if (st.op === 'worsen') {
                cur.severity = SEVERITY[Math.min(SEVERITY.indexOf(cur.severity) + 1, SEVERITY.length - 1)];
                cur.since = turn; cur.trend = 'worsening';
            }
        }
    }

    arr(d.threads).forEach((t, n) => {
        if (t.op === 'open') {
            state.threads.push({ id: `t-${tag}-${n}`, status: 'open', setup: t.text, payoff: '', source: mid, seen: turn });
        } else {
            const th = state.threads.find(x => x.id === t.id);
            if (!th) return;
            th.seen = turn;
            if (t.op === 'resolve') { th.status = 'resolved'; th.payoff = t.text; th.resolved = mid; }
            else { th.status = 'advanced'; if (t.text) th.latest = t.text; }
        }
    });
    // Dormancy (F1) is worked out, never stored: a thread is awake while it was seen lately. It wakes when a reply
    // names its people, place or key words again.
    const said = ` ${nameKey(entry.text ?? '')} `;
    for (const th of state.threads) {
        if (th.status === 'resolved' || th.seen === turn) continue;
        if (threadKeys(th).some(k => said.includes(` ${k} `))) th.seen = turn;
    }

    for (const l of arr(d.lore)) state.lore_drafts.push({ ...l, source: mid, turn, committed: entry.committed });

    for (const c of arr(d.contradictions)) state.flags.push({ kind: 'contradiction', ...c, source: mid, turn });

    const dir = d.direction ?? {};
    const beat = state.beats.find(b => b.id === obs.beat && b.status === 'queued');
    if (beat) {
        beat.offered = (beat.offered ?? 0) + 1;
        for (const id of arr(dir.clues_found)) {
            const clue = arr(beat.clues).find(c => c.id === id);
            if (clue) { clue.found = true; clue.source = mid; }
        }
        // Patience: replies in a row this opening was offered and left untouched. Going elsewhere (preempted) is the
        // player choosing, and movement toward it is not waiting: both start the count again.
        beat.waiting = dir.beat === 'untouched' || !dir.beat ? (beat.waiting ?? 0) + 1 : 0;
        if (dir.beat === 'complete') completeBeat(state, beat, mid);
        else if (dir.beat === 'advanced') {
            beat.progress = (beat.progress ?? 0) + 1;
            // Three replies moving toward an intent have delivered it, whatever the model calls it.
            if (beat.progress >= 3) completeBeat(state, beat, mid);
        } else if (dir.beat === 'preempted') {
            beat.preempted = (beat.preempted ?? 0) + 1;
            // Deviation bends the plan: an optional beat the player walked past twice is dropped, never forced back.
            // Passing an opening by once is the player's choice and leaves the rest of the plan standing: only a dropped
            // beat asks for a re-plan (live, 21 Nov 2026: a re-plan on every pass-by made 8 of 11 plans in 13 turns).
            if (!beat.required && beat.preempted >= 2) { beat.status = 'skipped'; state.meta.deviationTurn = turn; }
        }
        // An opening the narrator has been handed turn after turn without it being taken is pressure, not direction.
        // It is retired and the planner is asked to think again: two turns after the nudge (five if required).
        const nudge = Number(state.meta.nudgeAfter) > 0 ? Number(state.meta.nudgeAfter) : 3;
        if (beat.status === 'queued' && beat.offered >= nudge + (beat.required ? 5 : 2)) {
            beat.status = 'skipped';
            state.meta.deviationTurn = turn;
        }
        // The planner's scene has run out of beats: for the spine, the scene is over. A re-plan never ends a scene by
        // itself, however it renames the scenes; only the place changing or the beats running out does.
        if (beat.status !== 'queued' && !state.beats.some(b => b.status === 'queued' && b.scene === beat.scene)) state.meta.sceneSerial++;
    }

    // Patience: replies in a row that record nothing new, for the stall re-plan. Mood, time and who speaks do not count;
    // a fact, a belief, a relationship or status change, a new person, a thread, a clue, a new place or an opening
    // taken up do. A plan resets the count.
    // Found live (19 Nov 2026): the observer names the location on every reply and records background events as minor
    // facts, so only a major fact or a real change of place counts.
    const placeMoved = placeBefore !== null && state.scene.location.established && nameKey(state.scene.location.value) !== placeBefore;
    const moved = seededRelationship || arr(d.facts).some(f => f.weight === 'major')
        || ['confirmed', 'beliefs', 'relationships', 'statuses', 'cast_changes', 'threads'].some(k => arr(d[k]).length)
        || arr(dir.clues_found).length > 0 || dir.beat === 'complete' || dir.beat === 'advanced' || placeMoved;
    state.meta.quiet = moved ? 0 : (state.meta.quiet ?? 0) + 1;

    if (d.summary) state.summaries.recent.push({ text: d.summary, source: mid, i: entry.i, hidden: entry.hidden });

    state.meta.accepted += obs.accepted ?? 0;
    state.meta.rejected += arr(obs.rejected).length;
    for (const r of arr(obs.rejected)) state.meta.rejections.push({ ...r, source: mid });
    if (state.meta.rejections.length > 40) state.meta.rejections.splice(0, state.meta.rejections.length - 40);
}

// ---------------------------------------------------------------- applying logged operations

/**
 * A beat has a goal (what counts as it landing: the observer judges by it) and a pressure (the opening the narrator is
 * shown). `intent` is the goal's old name, kept as a copy for older readers. A beat logged before goal and pressure
 * existed has only `intent`: it serves as both.
 */
function sanitiseBeat(b, id) {
    return {
        id, scene: b.scene ?? '', ...beatText(b), precondition: b.precondition ?? '', type: b.type ?? 'pressure',
        required: !!b.required, status: 'queued', lore: arr(b.lore).slice(0, 3), serves: typeof b.serves === 'string' ? b.serves : '', plants: Number.isInteger(b.plants) ? b.plants : 0,
        clues: arr(b.clues).slice(0, CAPS.clues).map((c, n) => ({
            id: `${id}-c${n}`, text: c.text ?? '', route: c.route ?? 'place', where: c.where ?? '', found: false,
        })),
    };
}

export function applyOp(state, op, entry, chatMids) {
    const turn = state.meta.turn;
    const tag = entry.mid.slice(0, 6) + (op.basis?.fingerprint.slice(0, 8) ?? '');
    if (applySpineOp(state, op, entry)) return;
    if (applyAgendaOp(state, op)) return;
    switch (op.kind) {
        case 'genre': state.genre = storyGenre(op.value); break;
        case 'premise': state.premise = String(op.value ?? ''); break;
        case 'arc': state.arc = clone(op.value); break;
        case 'plan': {
            const v = op.value ?? {};
            const done = state.beats.filter(b => b.status !== 'queued');
            const seq = op.seq ?? turn;
            // Never the id of a beat already on record (older records may repeat a plan number).
            const taken = new Set(done.map(b => b.id));
            const fresh = arr(v.beats).map((b, n) => { let id = `b-${tag}-${seq}-${n}`; while (taken.has(id)) id += 'x'; taken.add(id); return sanitiseBeat(b, id); });
            state.beats = [...done, ...fresh];
            if (Array.isArray(v.scenes)) state.scenes = clone(v.scenes);
            if (state.arc) {
                if (Number.isInteger(v.act) && v.act === state.arc.act + 1) state.arc.act = v.act;
                const cur = ARC_TENSION.indexOf(state.arc.tension), want = ARC_TENSION.indexOf(v.tension);
                if (want !== -1 && cur !== -1) state.arc.tension = ARC_TENSION[clamp(want, cur - 1, cur + 1)];
            }
            arr(v.outcomes).forEach((o, n) => {
                state.notes.push({ kind: 'outcome', text: o, turn });
                // The narrator is told this as fact, so the record must hold it too, or the two models diverge.
                // It waits as unconfirmed until the narration shows it.
                // An off-screen outcome is planned because the story needs it: it counts as major.
                state.uncertain.push({ id: `o-${tag}-${seq}-${n}`, fact: o, quote: '', source: entry.mid, turn, witnesses: [], offscreen: true, weight: 'major' });
            });
            applyPlanSpine(state, v, `${tag}${seq}`);
            applyPlanAgendas(state, v);
            state.meta.lastPlanTurn = turn;
            state.meta.settledPending = [];
            state.meta.quiet = 0;
            for (const i of state.instructions) i.planned = true;
            state.meta.planReason = op.reason ?? '';
            break;
        }
        case 'beats': {
            // The player queued beats through /director beats: they go to the front.
            const fresh = arr(op.value).map((b, n) => sanitiseBeat(b, `b-${tag}-p${op.seq ?? turn}-${n}`));
            const at = state.beats.findIndex(b => b.status === 'queued');
            state.beats.splice(at === -1 ? state.beats.length : at, 0, ...fresh);
            break;
        }
        case 'profile': {
            // A card's title is not always a person's name ("Elizabeth & Dorothy", "Jubaku House"), and one card may
            // hold several people. The cast is keyed by the people the card describes; `cards` maps title to people.
            const v = op.value ?? {};
            const people = !op.pc && arr(v.people).length >= 2 ? v.people : [{ ...v, name: op.pc ? op.name : castName(op.name, v.name) }];
            const names = people.map(p => p.name);
            // A profile drawn from the story or a lorebook entry rests on the person having been introduced. When the
            // reply that introduced them is swiped away, so is the person: the profile does not bring them back
            // (audit, 21 Nov 2026: a name from a discarded swipe stayed in the cast and moved onto another man).
            if (op.lore && !op.pc && !names.some(n => state.cast[n])) break;
            const before = state.cards[op.name]?.people ?? [op.name];
            const relationshipMeta = {
                ...(op.relationshipPlayer !== undefined ? { relationshipPlayer: op.relationshipPlayer } : {}),
                ...(op.relationshipLore ? { relationshipLore: op.relationshipLore } : {}),
            };
            if (op.relationshipOnly && state.cards[op.name]) {
                Object.assign(state.cards[op.name], relationshipMeta, { hash: op.cardHash });
                if (op.relationshipPlayer === state.meta.player) for (const p of people) {
                    const name = before.find(n => nameKey(n) === nameKey(p.name));
                    if (name && name !== state.meta.player && state.cast[name]) seedRelationship(state.cast[name], p.priorRelationship);
                }
                break;
            }
            state.cards[op.name] = {
                hash: op.cardHash ?? null, people: names,
                ...(op.lore ? { lore: true } : {}),
                ...relationshipMeta,
            };
            for (const old of before) {
                if (names.includes(old) || !state.cast[old]) continue;
                // A card that holds one person keeps what was recorded under its title; a split card starts its people fresh.
                if (names.length === 1 && !state.cast[names[0]]) state.cast[names[0]] = state.cast[old];
                delete state.cast[old];
                if (state.scene.present.includes(old)) state.scene.present = [...new Set(state.scene.present.flatMap(n => (n === old ? names : [n])))];
            }
            for (const p of people) {
                const c = ensureCast(state, p.name);
                c.profile = p.summary ?? c.profile;
                // Gender, race and appearance are anchors: taken from the card once, then kept. A player's edit is never overwritten;
                // clearing the field lets the next profile fill it again.
                for (const k of ['gender', 'race', 'age_group', 'appearance']) if (p[k] && !c[k]) c[k] = p[k];
                // Starting values are derived once; later changes come only from narrated evidence.
                if (p.stats && (!c.stats || (op.force && !c.statsByPlayer))) c.stats = clone(p.stats);
                if (p.tells) c.tells = clone(p.tells);
                if (p.temperament) c.temperament = p.temperament;
                if (p.unprompted) c.unprompted = p.unprompted;
                if (op.pc) c.pc = true;
                if (op.relationshipPlayer === state.meta.player && p.name !== state.meta.player) seedRelationship(c, p.priorRelationship);
                // Other names the person goes by, from their lorebook entry's keys (audit, 21 Nov 2026: "the Crimson
                // Dragon" would otherwise pass as a new person). Never another cast member's name.
                if (people.length === 1) {
                    const own = nameKey(p.name);
                    const extra = arr(op.aliases).map(a => String(a ?? '').trim()).filter(a => a && a.length <= 40 && nameKey(a) !== own
                        && !Object.keys(state.cast).some(n => n !== p.name && nameKey(n) === nameKey(a)));
                    if (extra.length) c.aliases = [...new Set([...arr(c.aliases), ...extra])].slice(0, 8);
                }
                c.cardHash = op.cardHash ?? c.cardHash;
            }
            break;
        }
        case 'retcon': {
            const ids = new Set(arr(op.ids));
            const texts = arr(op.texts);
            for (const bucket of ['canon', 'uncertain']) {
                state[bucket] = state[bucket].filter(f => {
                    if (!ids.has(f.id) && !texts.some(text => similarity(text, f.fact) >= 0.85)) return true;
                    ids.add(f.id);
                    state.tombstones.push({ fact: f.fact, source: f.source, turn });
                    return false;
                });
            }
            for (const t of texts) if (!state.tombstones.some(record => record.fact === t)) {
                state.tombstones.push({ fact: t, source: entry.mid, turn });
            }
            for (const c of Object.values(state.cast)) c.knows = c.knows.filter(k => !ids.has(k.fact));
            state.lore_drafts = state.lore_drafts.filter(l => !state.tombstones.some(t => similarity(t.fact, l.text) >= 0.7));
            break;
        }
        case 'edit':
            // A Plan-tab save of the spine keeps what the story recorded (see mergeSpineEdit); a redraft replaces it.
            if (op.path === 'spine' && !op.replace) state.spine = mergeSpineEdit(state.spine, op.value);
            else {
                // A character whose agenda the player clears is never given a new one by the planner; giving one back
                // by hand lifts that (owner, 19 Nov 2026).
                if (op.path === 'agendas' && op.by === 'player') {
                    const before = Object.keys(state.agendas ?? {}), after = Object.keys(op.value ?? {});
                    const cleared = new Set(state.meta.clearedAgendas ?? []);
                    for (const n of before) if (!after.includes(n)) cleared.add(n);
                    for (const n of after) cleared.delete(n);
                    state.meta.clearedAgendas = [...cleared];
                }
                setPath(state, op.path, clone(op.value));
                // Stats the player sets by hand are never overwritten by a re-profile.
                const sm = /^cast\.([^.]+)(\.stats(?:\.|$))?/.exec(op.path ?? '');
                if (sm && op.by === 'player' && state.cast[sm[1]] && (sm[2] || (op.path === `cast.${sm[1]}` && op.value?.stats))) state.cast[sm[1]].statsByPlayer = true;
                const rm = /^cast\.([^.]+)\.(stage|rel\.[^.]+)$/.exec(op.path ?? '');
                if (rm && op.by === 'player' && state.cast[rm[1]]) (state.cast[rm[1]].relationshipFields ??= {})[rm[2]] = true;
            }
            break;
        case 'cast': {
            // The player renames or removes a cast member. Who counts as a character is the player's call;
            // the observer's guess at it is only a first draft.
            const name = String(op.name ?? '');
            if (op.action === 'edit') {
                if (!Object.hasOwn(state.cast, name)) break;
                const person = state.cast[name];
                for (const [field, value] of arr(op.fields)) {
                    if (field === 'stage' || field.startsWith('rel.')) (person.relationshipFields ??= {})[field] = true;
                    if (field.startsWith('stats.')) {
                        person.stats ??= Object.fromEntries(STATS.map(stat => [stat, STAT_BASELINE]));
                        person.statsByPlayer = true;
                    }
                    if (field === 'beliefs') person.beliefs = [...person.beliefs.filter(b => b.true), ...clone(value)];
                    else setPath(person, field, clone(value));
                }
                if (Array.isArray(op.wants) && !state.cast[name].pc) {
                    const cleared = new Set(state.meta.clearedAgendas ?? []);
                    if (op.wants.length) {
                        state.agendas[name] = { wants: [...op.wants], since: turn, by: 'player' };
                        cleared.delete(name);
                    } else {
                        delete state.agendas[name];
                        cleared.add(name);
                    }
                    state.meta.clearedAgendas = [...cleared];
                }
                break;
            }
            const to = String(op.to ?? '').trim();
            const swap = (n) => (n === name ? to : n);
            if (!name || state.cast[name]?.pc) break;
            // Locked: the player marks a main cast member. They always stay in the cast, and the planner and the
            // notes treat them as the story's core.
            if (op.action === 'lock' || op.action === 'unlock') {
                if (state.cast[name]) state.cast[name].main = op.action === 'lock';
                break;
            }
            if (op.action === 'remove') {
                if (state.cast[name]?.main) break; // unlock first
                delete state.cast[name];
                renameAgenda(state, name, '');
                state.scene.present = state.scene.present.filter(n => n !== name);
                if (!state.meta.removedCast.includes(name)) state.meta.removedCast.push(name);
                break;
            }
            if (op.action !== 'rename' || !to || to === name || !state.cast[name]) break;
            renameCast(state, name, to);
            state.meta.renamedCast[name] = to;
            delete state.meta.renamedCast[to]; // renaming back to an earlier name brings that name back
            state.meta.removedCast = state.meta.removedCast.filter(n => n !== to);
            break;
        }
        case 'note': state.notes.push({ kind: 'operation', text: String(op.text ?? ''), turn }); break;
        case 'scene-presence': {
            const present = new Set(state.scene.present);
            for (const name of arr(op.remove)) present.delete(name);
            for (const name of arr(op.add)) present.add(name);
            state.scene.present = [...present];
            break;
        }
        case 'fact-secret': {
            const fact = state.canon.find(f => f.id === op.id);
            if (fact) fact.secret = !!op.secret;
            break;
        }
        case 'fact-review': {
            const index = state.uncertain.findIndex(f => f.id === op.id);
            if (index < 0) break;
            const [fact] = state.uncertain.splice(index, 1);
            if (op.confirm) state.canon.push(fact);
            break;
        }
        case 'thread-review':
            state.threads = op.resolve ? state.threads.map(t => t.id === op.id ? { ...t, status: 'resolved' } : t)
                : state.threads.filter(t => t.id !== op.id);
            break;
        // A bare re-plan is an instruction to the planner only: `quiet` keeps it out of the narrator's notes, which must
        // never reveal that a plan exists (found live, 18 Nov 2026).
        case 'settle': addSettled(state, { text: op.text, by: 'player', source: entry.mid, turn }); break;
        case 'unsettle': state.settled = arr(state.settled).filter(s => s.id !== op.id); break;
        case 'instruction': state.instructions.push({ text: String(op.text ?? ''), turn, ...(op.quiet ? { quiet: true } : {}) }); break;
        case 'facts-clean': {
            // The periodic clean-up. Merges: the listed facts become one, at the newest one's place and id, worded as
            // the most current truth. Retires: minor facts that no longer matter leave what the models see but stay in
            // the record. A major fact is never retired.
            const byId = new Map(state.canon.map(f => [f.id, f]));
            for (const mg of arr(op.merges)) {
                const parts = arr(mg.ids).map(id => byId.get(id)).filter(Boolean);
                if (parts.length < 2 || !String(mg.fact ?? '').trim()) continue;
                const newest = parts.reduce((a, b) => ((b.turn ?? 0) >= (a.turn ?? 0) ? b : a));
                const merged = {
                    ...newest, fact: String(mg.fact).trim(), weight: parts.some(f => f.weight !== 'minor') || mg.weight === 'major' ? 'major' : 'minor',
                    witnesses: [...new Set(parts.flatMap(f => arr(f.witnesses)))], secret: parts.some(f => f.secret), merged: parts.map(f => f.id),
                };
                delete merged.retired;
                const gone = new Set(parts.map(f => f.id));
                state.canon = state.canon.flatMap(f => (f === newest ? [merged] : gone.has(f.id) ? [] : [f]));
                byId.set(merged.id, merged);
                for (const c of Object.values(state.cast)) for (const k of arr(c.knows)) if (gone.has(k.fact)) k.fact = merged.id;
                for (const c of Object.values(state.cast)) c.knows = arr(c.knows).filter((k, i, all) => all.findIndex(x => x.fact === k.fact) === i);
            }
            for (const id of arr(op.retire)) {
                const f = byId.get(id);
                if (f && f.weight === 'minor') f.retired = true;
            }
            state.meta.lastCleanTurn = state.meta.turn;
            break;
        }
        case 'rollup': {
            // A roll-up that covers a deleted message is void; the individual summaries stand until it is redone.
            const covers = arr(op.covers);
            if (chatMids && covers.some(id => !chatMids.has(id))) { state.meta.staleRollup = true; break; }
            const set = new Set(covers);
            state.summaries.rolled = String(op.text ?? '');
            state.summaries.recent = state.summaries.recent.filter(s => !set.has(s.source));
            break;
        }
        default: break;
    }
}

// ---------------------------------------------------------------- replay

/**
 * Rebuild state from the chat.
 * @param {object[]} chat SillyTavern chat array (records already reconciled).
 * @param {object} ctx
 * @param {NarratorRef} ctx.narrator
 * @param {object} [ctx.setup] Setup values from chat metadata: { genre, premise, player }.
 * @param {object} [opts]
 * @param {boolean} [opts.includeProvisional=true] Include the latest, not-yet-accepted reply.
 * @param {number} [opts.upto] Stop before this chat index (state as it was before that message).
 */
export function replay(chat, ctx, opts = {}, entries = scan(chat, ctx.narrator)) {
    const { includeProvisional = true, upto = Infinity } = opts;
    const state = initialState(ctx.setup);
    // Patience settings travel with the context, so retirement and the nudge follow them on every replay.
    state.meta.nudgeAfter = Number(ctx.patience?.nudge ?? 3);
    state.meta.stallAfter = Number(ctx.patience?.stall ?? 5);
    state.meta.dormantAfter = Number(ctx.patience?.dormant ?? 12);
    const chatMids = new Set(entries.map(e => e.mid));
    if (state.meta.player) ensureCast(state, state.meta.player).pc = true;

    for (const e of entries) {
        if (e.i >= upto) break;
        if (!e.mid) continue;
        const provisional = e.kind === 'narration' && !e.committed;
        if (e.kind === 'narration') {
            // Lagging: the newest reply the brief should rest on has not been read yet.
            if (!e.hidden && (e.committed || includeProvisional)) state.meta.lagging = !e.valid;
            if (e.valid && (e.committed || includeProvisional)) {
                state.meta.turn++;
                progressStatuses(state);
                applyDelta(state, e.rec.obs, e);
            } else if (!e.valid && !e.hidden) {
                if (e.committed) { state.meta.turn++; state.meta.pending.push(e.mid); }
                else if (includeProvisional) state.meta.unextracted = e.mid;
            }
            // The spine tracker's reading of this reply, kept apart from the observer's: either can fail alone.
            // Called for every counted reply, read or not, so scene boundaries are seen.
            if (e.committed || includeProvisional) {
                // A reply hidden later (a summary extension hides what it has summarised) keeps what the tracker found in
                // it; it only leaves the scene as it is (audit, 21 Nov 2026: 4 of 7 readings vanished).
                if (!e.hidden || e.trackPart) applySpineDelta(state, e.trackPart, e, e.hidden ? state.spine?.scene?.key ?? null : sceneKey(state), e.hidden || e.tracked);
            }
        }
        for (const op of e.ops) {
            if (op.by === 'director' && provisional && !includeProvisional) continue;
            applyOp(state, op, e, chatMids);
        }
    }
    // Records written before role names were refused can hold passers-by ("cobbler"). They leave the cast;
    // facts about what they did stay. Card people and the player character are never removed by this rule.
    // Names the player removed or renamed stay out, even if a later reply brought the old name back.
    const keep = new Set(Object.values(state.cards).flatMap(c => arr(c.people)));
    const gone = new Set([...state.meta.removedCast, ...Object.keys(state.meta.renamedCast)]);
    const dropped = new Set(Object.keys(state.cast).filter(n => !state.cast[n].pc && !state.cast[n].main && (gone.has(n) || (!keep.has(n) && !looksLikeName(n)))));
    for (const n of dropped) delete state.cast[n];
    if (dropped.size) state.scene.present = state.scene.present.filter(n => !dropped.has(n));
    return state;
}

/** Append an op to a message. The director's ops go with the swipe they rest on; everything else stays with the message. */
export function logOp(message, op) {
    const item = { at: Date.now(), ...op };
    if (!isObj(message.extra)) message.extra = {};
    if (item.by === 'director') {
        const rec = (message.extra.narrator ??= { v: RECORD_VERSION });
        (rec.ops ??= []).push(item);
    } else {
        (message.narrator_ops ??= []).push(item);
    }
}

/** Move a cast entry to a new name everywhere it is referred to. Onto someone already in the cast: that entry is kept. */
function renameCast(state, name, to) {
    const swap = (n) => (n === name ? to : n);
    if (!state.cast[to]) state.cast[to] = state.cast[name];
    renameAgenda(state, name, to);
    delete state.cast[name];
    state.scene.present = [...new Set(state.scene.present.map(swap))];
    for (const c of Object.values(state.cast)) {
        if (name in (c.stances ?? {})) { c.stances[to] ??= c.stances[name]; delete c.stances[name]; }
    }
    for (const f of [...state.canon, ...state.uncertain]) if (Array.isArray(f.witnesses)) f.witnesses = [...new Set(f.witnesses.map(swap))];
    for (const card of Object.values(state.cards)) card.people = card.people.map(swap);
}

/**
 * One way to finish a beat, whatever finished it. A completed beat plants the hook it named (found live, 21 Nov 2026:
 * nothing ever named one; audit the same day: a beat finished by three "advanced" replies skipped the planting).
 */
function completeBeat(state, beat, mid) {
    beat.status = 'complete';
    beat.completed = mid;
    state.meta.beatLog.push(beat.type);
    const hook = arr(state.arc?.payoff?.hooks)[(beat.plants ?? 0) - 1];
    if (hook) hook.planted = true;
}

/** Words that say how bad or what kind a condition is, not where or what: never enough to call two statuses the same. */
const STATUS_GENERIC = new Set(['injury', 'injured', 'wound', 'wounded', 'wounds', 'infection', 'infected', 'broken', 'deep', 'minor', 'major',
    'severe', 'bad', 'light', 'heavy', 'cut', 'bruise', 'bruised', 'pain', 'left', 'right', 'the', 'and', 'with', 'from', 'her', 'his', 'their']);
/**
 * The status a new reading refers to: the same name, or failing that the one condition sharing a telling word with it
 * ("knee injury" = "infected knee wound"; audit, 21 Nov 2026: treatments under a new wording did nothing).
 */
export function statusIndex(statuses, name) {
    const k = nameKey(name);
    const exact = arr(statuses).findIndex(x => nameKey(x.name) === k);
    if (exact !== -1) return exact;
    const telling = (t) => nameKey(t).split(' ').filter(w => w.length >= 3 && !STATUS_GENERIC.has(w)).map(w => w.replace(/s$/, ''));
    const mine = telling(name);
    const hits = arr(statuses).map((x, i) => [i, telling(x.name)]).filter(([, ws]) => ws.some(w => mine.includes(w))).map(([i]) => i);
    return hits.length === 1 ? hits[0] : -1;
}

/** What the player settled: the matters that close plans, criteria and notes. Settled read from the story alone stays in the record. */
export const playerSettled = (state) => arr(state.settled).filter(s => s.by === 'player');

/** Record a settled matter once (a close rewording counts as the same), newest kept, capped. */
function addSettled(state, { text, quote = '', by = 'story', source = '', turn = 0 }) {
    const t = String(text ?? '').trim().slice(0, CAPS.settledText ?? 200);
    if (!t) return;
    state.settled = arr(state.settled).filter(x => similarity(x.text, t) < 0.6);
    state.settled.push({ id: `st-${hash(t.toLowerCase())}`, text: t, quote, by, source, turn });
    if (state.settled.length > CAPS.settledKept) state.settled.shift();
    // What the player settled waits for the next plan to be planned around (audit, 21 Nov 2026: comparing turns missed a
    // settle logged on the same message as the latest plan). Settled from the story alone records it, no re-plan.
    if (by === 'player') state.meta.settledPending = [...new Set([...arr(state.meta.settledPending), t])];
}
