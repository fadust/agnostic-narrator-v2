// The director's pipeline. All SillyTavern access goes through `host`, so this runs unchanged in tests and fixtures.

import { buildBrief } from './brief.js';
import { extractJson } from './json.js';
import { buildLorebook } from './lore.js';
import { memoryMode, plannerMemory } from './memory.js';
import { planTrigger, queuedBeatText, validateArc, validateConclusion, validateGenre, validatePlan, validateProfile, validateSpine, validateSpineRewrites } from './planner.js';
import { arcPrompt, cleanupPrompt, conclusionPrompt, genrePrompt, observerPrompt, planPrompt, profilePrompt, spineCheckPrompt, spinePrompt, summariserPrompt, trackCheckPrompt, trackerPrompt } from './prompts.js';
import { applySpineRewrites, emptySpine, findCriterion, flagSpine, needsConclusion, spineIds, spineTrigger } from './spine.js';
import { activeRevision, castPeople, ensureCast, logOp, playerSettled, rawTextHash, reconcile, replay, scan, storyBasis, visibleText } from './state.js';
import { aroundQuote, applyTrackCheck, validateCleanup, validateObservation, validateTrackCheck, validateTracking } from './validate.js';
import { arr, hash, roughTokens, str } from './util.js';
import { planCheckContext, reviewPlan, validatePlanRewrites } from './plancheck.js';
import { planCheckPrompt } from './prompts.js';
import { validateAgendas } from './agenda.js';

/** Candidates for an agenda, most important first: main cast, then those in the scene, then those the record knows most about. */
function spineCast(state) {
    const weight = (n) => { const c = state.cast[n]; return (c.main ? 1000 : 0) + (state.scene.present.includes(n) ? 100 : 0) + arr(c.knows).length; };
    return Object.keys(state.cast).filter(n => !state.cast[n].pc && !state.cast[n].dead && n !== state.meta.player)
        .sort((a, b) => weight(b) - weight(a)).slice(0, 8).map(n => (state.cast[n].main ? `${n} (main cast)` : n));
}

/**
 * Cast members with no starting stats whom an authored lorebook entry describes: the entry's title or a key is their
 * name (the entry is about them: a place or faction entry that merely lists them is not taken), and its opening names them.
 * The longest such entry wins. Card people, the player character and anyone already profiled from this entry are skipped.
 */
export function loreCards(state, entries) {
    const fromCards = new Set(Object.entries(state.cards ?? {}).filter(([, v]) => !v.lore).flatMap(([, v]) => v.people ?? []));
    const out = [];
    for (const [name, c] of Object.entries(state.cast ?? {})) {
        if (c.stats || c.pc || name === state.meta?.player || fromCards.has(name)) continue;
        const low = name.toLowerCase();
        const named = (t) => words(String(t).slice(0, 200)).includes(words(name));
        const entry = arr(entries)
            .filter(e => [e.comment, arr(e.keys)[0]].some(k => String(k ?? '').trim().toLowerCase() === low) && named(e.content))
            .sort((a, b) => b.content.length - a.content.length)[0];
        if (!entry || entry.content.trim().length < 20) continue;
        const h = hash(entry.content);
        if (state.cards?.[name]?.hash === h) continue;
        out.push({ name, text: entry.content, hash: h, aliases: arr(entry.keys) });
    }
    return out;
}

const words = (t) => ` ${String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/**
 * Cast members the story brought in with no card and no lorebook entry, and no stats yet: their notes are what the story
 * has shown of them (appearance and summary on record, facts naming them, and the sentences of the replies that name
 * them, earliest first). Profiled once: the op marks them, so a later pass does not ask again even if stats are missing.
 */
export function storyCards(state, chat, narrator, entries, cap = 1800) {
    const fromCards = new Set(Object.entries(state.cards ?? {}).filter(([, v]) => !v.lore).flatMap(([, v]) => v.people ?? []));
    const lore = new Set(loreCards(state, entries).map(c => c.name));
    const texts = arr(chat).filter(m => !m.is_user && !m.is_system).map(m => visibleText(m, narrator));
    const out = [];
    for (const [name, c] of Object.entries(state.cast ?? {})) {
        if (c.stats || c.pc || name === state.meta?.player || fromCards.has(name) || lore.has(name) || state.cards?.[name]) continue;
        const key = words(name);
        const sentences = [];
        for (const t of texts) {
            const split = String(t).split(/(?<=[.!?…"”*])\s+/);
            // Someone is often described by their role before they give a name ("the guard beside her stall is a slab of
            // a man", then "**Guard:** ... \"Berolt.\"", live 21 Nov 2026). In a reply that names them under a speaker
            // label, sentences using that label's word count as about them too.
            const aliases = [...String(t).matchAll(/\*\*([^*:\n]{2,30}):\*\*([^\n]*)/g)]
                .filter(([, label, line]) => words(line).includes(key) && !words(label).includes(key))
                .map(([, label]) => words(label.replace(/^(the|a|an)\s+/i, '')));
            sentences.push(...split.filter(s => words(s).includes(key) || aliases.some(a => a.trim() && words(s).includes(a))));
        }
        if (!sentences.length) continue;
        const facts = [...arr(state.canon), ...arr(state.uncertain)].map(f => f.fact).filter(f => words(f).includes(key)).slice(0, 8);
        const lines = [
            `Story notes about ${name}: what the story has shown of them so far. There is no card.`,
            c.appearance ? `Appearance on record: ${c.appearance}` : '',
            c.profile ? `On record: ${c.profile}` : '',
            facts.length ? `Facts:\n${facts.map(f => `- ${f}`).join('\n')}` : '',
            `From the story:\n${sentences.map(s => `- ${s.trim()}`).join('\n')}`,
        ].filter(Boolean);
        out.push({ name, text: lines.join('\n').slice(0, cap), hash: 'story' });
    }
    return out;
}

/** Check calls run on their parent role's connection profile, temperature and answer limit, but are logged apart. */
const ROLE_OF = { 'tracker-check': 'tracker', 'planner-check': 'planner' };

const COOL_MS = 90_000;
const MEMORY_MS = 5_000;
// After an empty answer from the connection, try again after these waits (live, 19 Nov 2026: unlimited 20-second
// retries against a failing model burned ~160k prompt tokens). Past the last, an empty answer is an ordinary failure:
// it counts against a reply's tries and waits for "Retry failed calls".
const TRANSIENT_WAITS = [20_000, 60_000, 180_000];
// Reply text one tracker batch may carry: past it, the batch closes early (audit, 21 Nov 2026: batches reached 50k characters).
const TRACK_CHARS = 20_000;
// Under streaming SillyTavern reports only "Got response status N": a provider dropping the connection comes back as a
// 502/503/504 from SillyTavern's server, a browser-side drop as "Failed to fetch" (audit, 21 Nov 2026).
const DROPPED = /socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|failed to fetch|networkerror|network error|load failed|terminated|response status (?:502|503|504|520|522|524)\b/i;

/** Refusals as stored on a message: kind and reason in full, the refused item cut to 200 characters (audit, 21 Nov 2026). */
function slimRejected(list) {
    return arr(list).map(r => {
        const item = typeof r?.item === 'string' ? r.item : JSON.stringify(r?.item ?? '');
        return { kind: r?.kind, reason: r?.reason, item: item.length > 200 ? `${item.slice(0, 200)}…` : r?.item };
    });
}

/**
 * The number for a new plan on a message: one past the plans already logged there. It survives a page reload, which an
 * in-memory counter did not (package audit, 22 Nov 2026: a second plan after a reload reused the first one's beat ids).
 */
function planSeqOn(message) {
    return arr(message?.extra?.narrator?.ops).filter(o => o.kind === 'plan').reduce((n, o) => Math.max(n, (Number(o.seq) || 0) + 1), 0);
}

/** A print of the chat for the replay cache. Message text hashes are reused until the text actually changes. */
function chatPrint(chat) {
    let out = `${chat.length}`;
    for (const m of chat) {
        const r = m?.extra?.narrator;
        out += `|${m.narrator_id ?? ''}:${m.narrator_revision?.id ?? ''}:${m.is_user ? 'u' : ''}${m.is_system ? 'h' : ''}:${m.swipe_id ?? ''}:${rawTextHash(m)}`;
        out += `:${m.name ?? ''}:${m.original_avatar ?? ''}:${m.extra?.type ?? ''}:${r?.post ? 'p' : ''}:${arr(m.narrator_ops).length}.${arr(m.narrator_ops).at(-1)?.at ?? ''}`;
        if (r) out += `:${r.obs?.at ?? ''}.${r.obs?.hash ?? ''}.${r.track?.at ?? ''}.${arr(r.ops).length}.${arr(r.ops).at(-1)?.at ?? ''}.${r.err?.n ?? ''}.${r.trackErr?.n ?? ''}`;
    }
    return out;
}

export const DEFAULTS = {
    cadence: 0,          // planner: every N turns; 0 = event-driven only (the default since 18 Nov 2026)
    nudgeAfter: 3,       // a queued beat offered this many turns without being taken is nudged once; retired 2 turns later (5 if required); 0 = never nudge
    stallAfter: 5,       // this many replies in a row recording nothing new ask for a re-plan; 0 = off
    dormantAfter: 12,    // a thread unseen this many turns leaves the planner's prompt until its people, place or key words return; 0 = never
    rollEvery: 8,        // summariser: roll up once this many summaries have left the prompt
    backfill: 6,         // on an existing chat, read at most this many unread replies
    trackEvery: 4,       // spine tracker: check the spine once this many answered replies wait (or on request)
    cleanEvery: 10,      // fact clean-up: merge and retire facts every N turns; 0 = never
    cleanAbove: 30,      // fact clean-up also runs early once live facts pass this count and have grown since the last one; 0 = off
    recurrence: 2,       // dynamic lore: mentions before a person, place or thing earns an entry
    briefTokens: 300,
    storyTokens: 1200,
    maxRetries: 2,
    requestTimeoutMs: 180_000,
    tokens: { observer: 1500, tracker: 600, planner: 3000, summariser: 500, genre: 700, profile: 700, opening: 900, cleanup: 900 },
};

/**
 * @typedef {object} Host
 * @property {() => object[]} chat
 * @property {() => string} [chatKey] Identity of the active host chat, independent of the mutable message array.
 * @property {() => import('./state.js').NarratorRef|null} narrator
 * @property {() => object} setup Setup values: { genre, premise, player }.
 * @property {(patch: object) => void} setSetup
 * @property {() => object} settings Merged with DEFAULTS by the caller.
 * @property {(module: string, messages: object[], maxTokens: number, signal: AbortSignal) => Promise<string>} call
 * @property {() => void} save Persist the chat (records live on messages).
 * @property {(reason: string) => void} [changed] State changed; refresh variables, lore and UI.
 * @property {() => Promise<{name: string, text: string, isPlayer?: boolean}[]>} [cards]
 * @property {() => Promise<string>} [material] Story material for the genre profiler.
 * @property {() => string[]} [loreKeys]
 * @property {() => string[]} [castNames] Titles of the cast cards in the chat. Each stands for the people its profile names (castPeople).
 * @property {() => number} [firstIncluded] Chat index of the oldest message still in the prompt.
 * @property {() => Promise<{text: string, missing?: number[], source?: string}|null>} [memoryStory] The memory extension's
 *   record of the story, for the planner, when settings.memory is 'extension'. missing: chat indices of replies it has
 *   no summary for.
 */

export class Director {
    /** @param {Host} host */
    constructor(host) {
        this.host = host;
        this.epoch = 0;
        this.chatKey = host.chatKey?.();
        this.running = false;
        this.again = false;
        this.queues = new Map();
        this.calls = {};
        this.errors = [];
        this.failing = {};
        this.profileFails = new Map();
        this.profileConnectionFailure = null;
        this.mids = null;
        this.abort = new AbortController();
        /** Replies whose record went stale (edited, swiped). They are re-read even outside the backfill window. */
        this.reread = new Set();
        /** Step name -> time before which it is not retried after a failure. */
        this.cool = {};
        this.trackMax = null;
        /** Empty answers in a row, per module (backs off, then stops automatic retries). */
        this.emptyRun = {};
        /** Per-module running totals for this chat: { [module]: { calls, promptTokens, answerTokens } } (rough estimates). */
        this.usage = {};
    }

    ctx() {
        const cfg = this.cfg();
        return { narrator: this.host.narrator(), setup: this.host.setup(), patience: { nudge: Number(cfg.nudgeAfter ?? DEFAULTS.nudgeAfter), stall: Number(cfg.stallAfter ?? DEFAULTS.stallAfter), dormant: Number(cfg.dormantAfter ?? DEFAULTS.dormantAfter) } };
    }

    cfg() {
        return { ...DEFAULTS, ...this.host.settings(), tokens: { ...DEFAULTS.tokens, ...(this.host.settings().tokens ?? {}) } };
    }

    owns(epoch = this.epoch) {
        return epoch === this.epoch && this.chatKey === this.host.chatKey?.();
    }

    /** Drop everything in flight: the chat changed underneath us. */
    reset() {
        this.epoch++;
        this.chatKey = this.host.chatKey?.();
        this.abort.abort();
        this.abort = new AbortController();
        for (const q of this.queues.values()) {
            for (const job of q.jobs.splice(0)) job.reject(new Error('superseded'));
        }
        this.queues.clear();
        this.running = false;
        this.pass = null;
        this.unsaved = false;
        this.mids = null;
        this.errors = [];
        this.failing = {};
        this.profileFails.clear();
        this.profileConnectionFailure = null;
        this.calls = {};
        this.again = false;
        this.reread.clear();
        this.cool = {};
        this.trackMax = null;
        this.usage = {};
        this.forceTrack = false;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.emptyRun = {};
        this.viewCache = null;
        this.scanCache = null;
    }

    /** Align records with the chat. Cheap; safe to call on every event. */
    sync() {
        if (!this.owns()) return { changed: false, stale: [], deleted: [], mids: this.mids };
        // Callers also sync after changing a saved record in place.
        this.viewCache = null;
        const chat = this.host.chat();
        const r = reconcile(chat, this.host.narrator(), this.mids);
        if (r.changed || r.deleted.length) {
            this.scanCache = null;
        }
        this.mids = r.mids;
        for (const id of r.stale) this.reread.add(id);
        for (const id of r.deleted) this.reread.delete(id);
        if ((r.stale.length || r.deleted.length) && this.profileFails.size) {
            const cast = this.view().cast;
            for (const [key, failure] of this.profileFails) {
                if (failure.source !== 'card' && !cast[failure.name]) this.profileFails.delete(key);
            }
            this.updateProfileWarning();
        }
        if (r.changed) this.save();
        return r;
    }

    /** @param {{includeProvisional?: boolean, upto?: number}} [opts] */
    /**
     * The state, rebuilt by replay. Cached per chat revision (audit, 22 Nov 2026: one setup pass replayed the whole chat
     * 4-6 times). The key includes the message digests, current records, context and options. Callers get a
     * copy, so nothing they do to the state reaches the cache.
     */
    view(opts) {
        return structuredClone(this.readView(opts));
    }

    /** The cached state, for internal consumers that only read it. */
    readView(opts) {
        const chat = this.host.chat();
        const ctx = this.ctx();
        const snapshot = this.readings(ctx.narrator);
        const key = `${JSON.stringify(opts ?? {})}#${JSON.stringify(ctx)}#${snapshot.print}`;
        const hit = this.viewCache?.get(key);
        if (hit) return hit;
        const state = replay(chat, ctx, opts, snapshot.entries);
        this.viewCache ??= new Map();
        if (this.viewCache.size >= 6) this.viewCache.delete(this.viewCache.keys().next().value);
        this.viewCache.set(key, state);
        return state;
    }

    readings(narrator = this.host.narrator()) {
        const chat = this.host.chat();
        const print = `${JSON.stringify(narrator)}#${chatPrint(chat)}`;
        if (this.scanCache?.chat !== chat || this.scanCache.print !== print) {
            this.scanCache = { chat, print, entries: scan(chat, narrator) };
        }
        return this.scanCache;
    }

    lorebook(state = null) {
        const st = state ?? this.readView();
        const texts = this.readings().entries.filter(e => e.kind === 'narration' && e.committed).map(e => e.text);
        const titles = this.host.castNames?.() ?? [];
        return buildLorebook(st.lore_drafts, texts, { recurrence: this.cfg().recurrence, exclude: [...titles, ...castPeople(st, titles)] });
    }

    /**
     * One model call, serialised per connection profile, logged for the inspector. An observer call goes ahead of calls
     * that are queued but not started (after any observer calls already waiting): the next turn's notes rest on the
     * observer, so it never waits behind planning, tracking or checks. A running call is never interrupted.
     * Check calls ('tracker-check', 'planner-check') use their parent role's profile, temperature and answer limit.
     */
    model(module, messages) {
        if (!this.owns()) return Promise.reject(new Error('superseded'));
        const cfg = this.cfg();
        const role = ROLE_OF[module] ?? module;
        const profile = cfg.profiles?.[role] || cfg.profile || '';
        let q = this.queues.get(profile);
        if (!q) { q = { jobs: [], busy: false }; this.queues.set(profile, q); }
        const epoch = this.epoch, signal = this.abort.signal;
        return new Promise((resolve, reject) => {
            const job = { module, run: () => this.runCall(module, role, messages, cfg, epoch, signal), resolve, reject };
            if (module === 'observer') {
                let at = 0;
                while (at < q.jobs.length && q.jobs[at].module === 'observer') at++;
                q.jobs.splice(at, 0, job);
            } else q.jobs.push(job);
            this.drain(q);
        });
    }

    /** Start the next queued call on a profile when none is running. */
    drain(q) {
        if (q.busy || !q.jobs.length) return;
        q.busy = true;
        const job = q.jobs.shift();
        job.run().then(job.resolve, job.reject).finally(() => { q.busy = false; this.drain(q); });
    }

    async runCall(module, role, messages, cfg, epoch, signal) {
        if (!this.owns(epoch)) throw new Error('superseded');
        const request = new AbortController();
        const cancel = () => request.abort(new Error('superseded'));
        signal.addEventListener('abort', cancel, { once: true });
        const deadline = Number(cfg.requestTimeoutMs);
        const ms = Number.isFinite(deadline) && deadline > 0 ? deadline : DEFAULTS.requestTimeoutMs;
        const timer = setTimeout(() => request.abort(new Error(`request timed out after ${ms} ms`)), ms);
        const interrupted = new Promise((_, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
        });
        const started = Date.now();
        // Sizes for the inspector's cost table: characters and a rough token estimate from text length.
        const promptText = arr(messages).map(m => String(m?.content ?? '')).join('\n');
        const entry = { module, messages, raw: '', error: null, at: started, ms: 0, promptChars: promptText.length, promptTokens: roughTokens(promptText), answerChars: 0, answerTokens: 0 };
        this.calls[module] = entry;
        try {
            const raw = await Promise.race([
                interrupted,
                Promise.resolve().then(() => {
                    if (!this.owns(epoch)) throw new Error('superseded');
                    request.signal.throwIfAborted();
                    return this.host.call(module, messages, cfg.tokens[module] ?? cfg.tokens[role] ?? 800, request.signal);
                }),
            ]);
            if (!this.owns(epoch)) throw new Error('superseded');
            entry.raw = String(raw ?? '');
            // An empty answer is the connection's failure (a timeout, a dropped stream), not the input's. It is
            // marked transient so it never counts against a reply's tries.
            if (!entry.raw.trim()) {
                // Counted per module: another module's answer says nothing about this one's model.
                const run = this.emptyRun[module] = (this.emptyRun[module] ?? 0) + 1;
                if (run <= TRANSIENT_WAITS.length) throw Object.assign(new Error(`${module}: empty answer from the connection`), { transient: true, run });
                throw new Error(`${module}: empty answer from the connection, ${run} in a row; automatic retries stopped until "Retry failed calls"`);
            }
            delete this.emptyRun[module];
            return entry.raw;
        } catch (e) {
            if (!this.owns(epoch)) throw new Error('superseded');
            if (request.signal.aborted) e = request.signal.reason;
            entry.error = String(e?.cause?.message ?? e?.message ?? e);
            // A dropped connection (socket hang up, reset, timeout) is the connection's failure too: retried with
            // growing waits, then stopped, like an empty answer (owner, 21 Nov 2026).
            if (!e?.transient && (request.signal.aborted || DROPPED.test(`${entry.error} ${e?.message ?? ''}`))) {
                const run = this.emptyRun[module] = (this.emptyRun[module] ?? 0) + 1;
                if (run <= TRANSIENT_WAITS.length) throw Object.assign(new Error(`${module}: ${entry.error}`), { transient: true, run });
                throw new Error(`${module}: ${entry.error}, ${run} in a row; automatic retries stopped until "Retry failed calls"`);
            }
            throw e;
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            entry.ms = Date.now() - started;
            entry.answerChars = entry.raw.length;
            entry.answerTokens = roughTokens(entry.raw);
            // A reset (chat change) during the call starts a fresh table; this call belongs to the old chat.
            if (this.owns(epoch)) {
                const u = this.usage[module] ??= { calls: 0, promptTokens: 0, answerTokens: 0 };
                u.calls++;
                u.promptTokens += entry.promptTokens;
                u.answerTokens += entry.answerTokens;
            }
        }
    }

    async json(module, messages, validate) {
        const epoch = this.epoch;
        const raw = await this.model(module, messages);
        if (!this.owns(epoch)) throw new Error('superseded');
        const parsed = extractJson(raw);
        if (!parsed.ok) throw Object.assign(new Error(`${module}: ${parsed.error}`), { invalidAnswer: true });
        const v = validate(parsed.value);
        if (!v.ok) throw Object.assign(new Error(`${module}: ${v.error}`), { invalidAnswer: true });
        // Recovered only once an answer is usable, not merely received: a model answering in the wrong shape still fails.
        if (module !== 'profile') this.recovered(module);
        return v.value;
    }

    fail(module, e, mid = null, details = {}) {
        if (String(e?.message) === 'superseded' || e?.name === 'AbortError') return;
        const entry = { module, error: String(e?.cause?.message ?? e?.message ?? e), mid, at: Date.now(), ...details };
        this.errors.push(entry);
        if (this.errors.length > 20) this.errors.shift();
        console.warn(`[Narrator Director] ${module} failed`, e);
        // The player hears about it (audit, 22 Nov 2026): once when a module starts failing, again when it recovers.
        const first = !this.failing[module];
        this.failing[module] = { ...entry, count: (this.failing[module]?.count ?? 0) + 1 };
        this.host.failed?.(module, entry, first);
    }

    /** A module answered again after failing: it is no longer reported. */
    recovered(module) {
        if (!this.failing[module]) return;
        delete this.failing[module];
        this.host.failed?.(module, null, false);
    }

    /**
     * Save the chat: at once outside a pass, once at its end inside one (package audit, 22 Nov 2026: a pass wrote the whole
     * chat up to 7 times). A player's own edit still saves at once (playerOp).
     */
    save() {
        if (!this.owns()) return;
        if (this.running) { this.unsaved = true; return; }
        this.host.save();
    }

    /** The save a pass held back, written when the pass ends. */
    flushSave() {
        if (!this.unsaved) return;
        this.unsaved = false;
        this.host.save();
    }

    /** Start (or re-run) the background pass. Single flight. */
    kick() {
        const epoch = this.epoch;
        if (!this.owns(epoch)) return Promise.resolve();
        if (this.running) { this.again = true; return this.pass; }
        this.running = true;
        this.pass = (async () => {
            try {
                do {
                    this.again = false;
                    await this.work();
                } while (this.owns(epoch) && this.again);
            } finally {
                if (this.owns(epoch)) {
                    this.running = false;
                    this.flushSave();
                }
            }
        })();
        return this.pass;
    }

    /**
     * Run a command's work (a spine redraft, an arc redraft, a roll-up, a genre re-run) inside the same single-flight as
     * a pass, so it never overlaps a background call doing the same job (audit, 22 Nov 2026: a command could pay for a
     * spine twice). It waits for a running pass, holds the slot while it runs, then lets a pass that was asked for meanwhile run.
     */
    async exclusive(fn) {
        const epoch = this.epoch;
        while (this.owns(epoch) && this.running) await this.pass;
        if (!this.owns(epoch)) throw new Error('superseded');
        this.running = true;
        let out, err = null;
        this.pass = (async () => {
            try { out = await fn(); } catch (e) { err = e; } finally {
                if (this.owns(epoch)) {
                    this.running = false;
                    this.flushSave();
                }
            }
        })();
        await this.pass;
        if (!this.owns(epoch)) throw new Error('superseded');
        if (this.again) { this.again = false; this.kick(); }
        if (err) throw err;
        return out;
    }

    async work() {
        const epoch = this.epoch;
        if (!this.host.narrator()) return;
        this.sync();
        // 1. The observer and the spine tracker read replies side by side. They write different records on the message
        // (obs and track) and neither reads the other's, so they cannot clash. On different connection profiles their
        // calls are in flight together; on one profile the per-profile queue in model() still takes them in turn.
        const force = this.forceTrack;
        this.forceTrack = false;
        const observing = (async () => {
            // Every unread reply, oldest first, within the backfill window.
            for (let guard = 0; guard < 50; guard++) {
                // A transient failure waits its turn: a chat event does not retry before it (audit, 21 Nov 2026).
                if ((this.cool.observer ?? 0) > Date.now()) break;
                const next = this.nextUnread();
                if (!next || !this.owns(epoch)) break;
                const done = await this.observe(next);
                // A reply that changed while it was read (still streaming, or swiped) waits for the next pass instead of being
                // read again at once (package audit P1, 22 Nov 2026: up to 50 paid reads of one streaming reply per pass).
                if (!this.owns(epoch) || done === 'transient' || (!done && this.again)) break;
                if (done) this.host.changed?.('observed');
            }
        })();
        const tracking = (async () => {
            // The spine only, in batches: once enough answered replies wait, or at once when the player asks.
            for (let guard = 0; guard < 20; guard++) {
                const batch = this.nextBatch(force);
                if (!batch || !this.owns(epoch)) break;
                const done = await this.track(batch);
                if (!this.owns(epoch)) break;
                if (done) this.host.changed?.('tracked');
                else break; // failed or superseded: the next pass tries again
            }
        })();
        await Promise.all([observing, tracking]);
        if (!this.owns(epoch)) return;
        // 2. Setup and planning rest on the freshest view.
        const steps = {
            genre: () => this.ensureGenre(), profile: () => this.ensureProfiles(), spine: () => this.ensureSpine(),
            planner: () => this.maybePlan(), conclusion: () => this.maybeConclude(), summariser: () => this.maybeRollUp(),
            cleanup: () => this.maybeCleanUp(),
        };
        for (const [name, step] of Object.entries(steps)) {
            // A step that just failed is left alone for a while. Without this, a broken planner or profile call
            // would be repeated on every chat event.
            if ((this.cool[name] ?? 0) > Date.now()) continue;
            try {
                const changed = await step();
                if (!this.owns(epoch)) return;
                if (changed) { this.save(); this.host.changed?.('directed'); }
                if (name !== 'profile') this.recovered(name);
            } catch (e) {
                if (!this.owns(epoch)) return;
                this.cool[name] = Date.now() + (e?.transient ? this.transientWait(e.run) : COOL_MS);
                if (e?.transient) this.retrySoon(e.run);
                this.fail(name, e);
            }
            if (!this.owns(epoch)) return;
        }
    }

    nextUnread() {
        const cfg = this.cfg();
        const entries = this.readings().entries;
        const narr = entries.filter(e => e.kind === 'narration' && !e.hidden);
        // The newest reply is not read while the narrator is still writing it.
        if (this.host.generating?.() && narr.at(-1)?.i === entries.at(-1)?.i) narr.pop();
        const recent = new Set(narr.slice(-cfg.backfill));
        return narr.find(e => (recent.has(e) || this.reread.has(e.mid)) && !e.valid && e.text
            && !(e.rec?.err?.hash === e.hash && e.rec.err.n >= cfg.maxRetries)) ?? null;
    }

    /** Observer: extract and check one reply. Returns true when a record was written. */
    async observe(entry) {
        const epoch = this.epoch;
        const before = this.view({ upto: entry.i });
        // Card people the player removed or renamed away stay out, even if a re-profile brought the old name back.
        for (const n of castPeople(before, this.host.castNames?.() ?? [])) {
            if (!before.meta.removedCast.includes(n) && !(n in before.meta.renamedCast)) ensureCast(before, n);
        }
        const offered = buildBrief(before).offered;
        const player = entry.player;
        const playerMessage = player?.mes ?? '';
        const playerBasis = { mid: player?.narrator_id ?? null, revision: player ? activeRevision(player, this.host.narrator()) : null };
        const messages = observerPrompt({ state: before, reply: entry.text, playerMessage, offered });
        const rec = entry.m.extra.narrator;
        const stillCurrent = () => {
            const current = this.host.chat();
            const index = current.indexOf(entry.m);
            if (index < 0 || activeRevision(entry.m, this.host.narrator()) !== entry.revision
                || hash(visibleText(entry.m, this.host.narrator())) !== entry.hash) return false;
            for (let i = index - 1; i >= 0; i--) if (current[i].is_user) {
                return current[i] === player && activeRevision(player, this.host.narrator()) === playerBasis.revision;
            }
            return !player;
        };
        try {
            const raw = await this.model('observer', messages);
            if (!this.owns(epoch)) return false;
            if (!stillCurrent()) { this.again = true; return false; } // the reply changed while we worked: discard
            const parsed = extractJson(raw);
            if (!parsed.ok) throw new Error(`observer: ${parsed.error}`);
            const names = [...Object.keys(before.cast), before.meta.player].filter(Boolean);
            const v = validateObservation(parsed.value, {
                text: entry.text, names, tombstones: before.tombstones, present: before.scene.present,
                secondPerson: !before.genre?.pov || /second/i.test(before.genre.pov),
                planned: queuedBeatText(before),
                aliases: Object.fromEntries(Object.entries(before.cast).flatMap(([n, c]) => arr(c.aliases).map(a => [a, n]))),
                uncertainIds: before.uncertain.map(u => u.id), threadIds: before.threads.map(t => t.id),
                clueIds: offered.clues, player: before.meta.player, playerMessage,
                known: [playerMessage, ...before.canon.map(f => f.fact), ...before.uncertain.map(f => f.fact)].join('\n'),
            });
            this.recovered('observer');
            rec.obs = { hash: entry.hash, revision: entry.revision, player: playerBasis, delta: v.delta, accepted: v.accepted, rejected: slimRejected(v.rejected), beat: offered.beat, at: Date.now(), strip: [...(this.host.narrator()?.strip ?? [])] };
            delete rec.err;
            this.save();
            return true;
        } catch (e) {
            if (!this.owns(epoch)) return false;
            if (!stillCurrent()) { this.again = true; return false; }
            if (e?.transient) { this.cool.observer = Date.now() + this.transientWait(e.run); this.fail('observer', e, entry.mid); this.retrySoon(e.run); return 'transient'; }
            if (String(e?.message) !== 'superseded' && e?.name !== 'AbortError') {
                // The previous state stands. Remember the failure so a broken reply is not retried forever.
                rec.err = { hash: entry.hash, n: (rec.err?.hash === entry.hash ? rec.err.n : 0) + 1, error: String(e?.message ?? e) };
                this.save();
            }
            this.fail('observer', e, entry.mid);
            return false;
        }
    }

    /** How long to wait after an empty answer: longer each time in a row (run = that module's count). */
    transientWait(run = 1) {
        return TRANSIENT_WAITS[Math.min(Math.max(run - 1, 0), TRANSIENT_WAITS.length - 1)];
    }

    /** After a transient failure, run the pass again a little later (once, however many calls failed). */
    retrySoon(run = 1) {
        if (this.retryTimer) return;
        const epoch = this.epoch;
        this.retryTimer = setTimeout(() => {
            if (!this.owns(epoch)) return;
            this.retryTimer = null;
            this.kick();
        }, this.transientWait(run));
        this.retryTimer.unref?.();
    }

    /** Ask the spine tracker to read whatever replies are waiting, now, without waiting for a full batch. */
    async trackNow() {
        this.sync();
        const epoch = this.epoch;
        const pending = this.nextBatch(true);
        if (!pending) return { status: 'current' };
        this.forceTrack = true;
        delete this.cool.tracker;
        await this.kick();
        if (!this.owns(epoch)) return { status: 'superseded' };
        const covered = new Set(this.readings().entries.filter(e => e.tracked).map(e => e.mid));
        return { status: pending.every(e => covered.has(e.mid)) ? (this.nextBatch(true) ? 'partial' : 'checked') : 'pending' };
    }

    /**
     * The next batch for the spine tracker: the oldest replies it has not read, after the spine was drafted (earlier
     * replies have nothing to be judged against) and within the backfill window. A batch waits until `trackEvery`
     * answered replies are ready; the newest reply joins only when the player asks, since it may still be swiped.
     * At most `trackEvery` replies per batch, or 12 when asked.
     */
    nextBatch(force = false) {
        const cfg = this.cfg();
        const every = Math.max(1, Number(cfg.trackEvery) || DEFAULTS.trackEvery);
        const chat = this.host.chat();
        const isSpineOp = (op) => op.kind === 'spine' || (op.kind === 'edit' && op.path === 'spine');
        const from = chat.findIndex(m => [...arr(m.narrator_ops), ...arr(m.extra?.narrator?.ops)].some(isSpineOp));
        if (from === -1 || (!force && (this.cool.tracker ?? 0) > Date.now())) return null;
        const entries = this.readings().entries;
        const narr = entries.filter(e => e.kind === 'narration' && !e.hidden);
        const windowed = new Set(narr.slice(-Math.max(cfg.backfill, every)));
        const waiting = narr.filter(e => e.i > from && windowed.has(e) && !e.tracked && e.text && (force || e.committed));
        // A batch that has failed too often is passed over (one reply at a time), so it cannot hold back newer replies.
        while (waiting.length && (force || waiting.length >= Math.min(every, this.trackMax ?? every) || waiting.reduce((n, e) => n + e.text.length, 0) > TRACK_CHARS)) {
            // A batch is closed by size as well as count, and shrinks after the model ran out of thinking room.
            const cap = Math.min(force ? 12 : every, this.trackMax ?? Infinity);
            let size = 0, chars = 0;
            while (size < Math.min(cap, waiting.length)) {
                const n = waiting[size].text.length;
                if (size > 0 && chars + n > TRACK_CHARS) break;
                chars += n;
                size++;
            }
            const batch = waiting.slice(0, size);
            const last = batch.at(-1).rec;
            const sig = hash(batch.map(e => e.hash).join('|'));
            if (force || !(last?.trackErr?.sig === sig && last.trackErr.n >= cfg.maxRetries)) return batch;
            waiting.shift();
        }
        return null;
    }

    /** Spine tracker: read a batch of replies for the spine only. Stored on the batch's last reply. True when written. */
    async track(batch) {
        const epoch = this.epoch;
        const chat = this.host.chat();
        const before = replay(chat, this.ctx(), { upto: batch[0].i });
        if (!before.spine) return false;
        const playerBefore = (i) => { for (let j = i - 1; j >= 0; j--) if (chat[j].is_user) return chat[j].mes; return ''; };
        const exchanges = batch.map(e => ({ player: playerBefore(e.i), reply: e.text }));
        const carrier = batch.at(-1);
        const basis = this.basis(carrier.m);
        const rec = carrier.m.extra.narrator;
        const sig = hash(batch.map(e => e.hash).join('|'));
        const stillCurrent = () => this.basisCurrent(basis) && batch.every(e => this.host.chat().includes(e.m)
            && activeRevision(e.m, this.host.narrator()) === e.revision
            && hash(visibleText(e.m, this.host.narrator())) === e.hash);
        try {
            const raw = await this.model('tracker', trackerPrompt({ state: before, exchanges }));
            if (!this.owns(epoch)) return false;
            if (!stillCurrent()) { this.again = true; return false; }
            const parsed = extractJson(raw);
            if (!parsed.ok) throw new Error(`tracker: ${parsed.error}`);
            const ids = spineIds(before);
            const texts = batch.map(e => e.text);
            const v = await this.checkMarks(validateTracking(parsed.value, { texts, spine: ids, names: Object.keys(before.cast), player: before.meta.player, settledIds: playerSettled(before).map(s => s.id) }), texts, before, ids);
            if (!this.owns(epoch)) return false;
            if (!stillCurrent()) { this.again = true; return false; }
            // A batch that fitted lets the next one grow back by a reply, up to the usual size (audit map, 22 Nov 2026).
            if (this.trackMax) this.trackMax = this.trackMax + 1 >= (Number(this.cfg().trackEvery) || DEFAULTS.trackEvery) ? null : this.trackMax + 1;
            this.recovered('tracker');
            rec.track = { covers: batch.map(e => ({ mid: e.mid, hash: e.hash, revision: e.revision })), basis, delta: v.delta, rejected: slimRejected(v.rejected), at: Date.now(), strip: [...(this.host.narrator()?.strip ?? [])] };
            delete rec.trackErr;
            this.save();
            return true;
        } catch (e) {
            if (!this.owns(epoch)) return false;
            if (!stillCurrent()) { this.again = true; return false; }
            if (e?.transient) { this.cool.tracker = Date.now() + this.transientWait(e.run); this.fail('tracker', e, carrier.mid); this.retrySoon(e.run); return false; }
            // Out of thinking room: the same input would fail the same way. Halve the batch (audit, 21 Nov 2026: four
            // 40-50k-character batches burned ~110k reasoning tokens and two replies were never tracked).
            if (/spent its whole answer limit/.test(String(e?.message))) this.trackMax = Math.max(1, Math.floor(batch.length / 2));
            if (String(e?.message) !== 'superseded' && e?.name !== 'AbortError') {
                rec.trackErr = { sig, n: (rec.trackErr?.sig === sig ? rec.trackErr.n : 0) + 1, error: String(e?.message ?? e) };
                this.cool.tracker = Date.now() + COOL_MS;
                this.save();
            }
            this.fail('tracker', e, carrier.mid);
            return false;
        }
    }

    /**
     * Second check before "met": one cheap call for every "met" mark in the batch, on the tracker's profile. No such
     * mark, no call. A rejected mark is refused and its criterion stays open. If the check fails, the marks stand as
     * the tracker gave them (owner, 18 Nov 2026): a failed check never stalls the spine.
     */
    async checkMarks(v, texts, state, ids) {
        const epoch = this.epoch;
        const met = v.delta.marks.filter(m => m.mark === 'met');
        if (!met.length) return v;
        const items = met.map(m => {
            const c = findCriterion(state.spine, m.id)?.criterion;
            return {
                id: m.id, criterion: c?.text ?? '', role: c?.role ?? '', quote: m.quote,
                context: aroundQuote(texts[m.exchange - 1], m.quote), speaker: m.speaker ?? '',
                ...(m.also ? { also: { ...m.also, context: aroundQuote(texts[m.also.exchange - 1], m.also.quote) } } : {}),
            };
        });
        try {
            const verdicts = await this.json('tracker-check', trackCheckPrompt({ items }), raw => validateTrackCheck(raw, items.map(i => i.id)));
            return applyTrackCheck(v, verdicts, ids.milestoneCriteria);
        } catch (e) {
            if (!this.owns(epoch) || String(e?.message) === 'superseded' || e?.name === 'AbortError') throw e;
            this.fail('tracker-check', e);
            return v;
        }
    }

    latest() {
        const chat = this.host.chat();
        return chat.length ? chat[chat.length - 1] : null;
    }

    basis(through = this.latest()) {
        return through ? storyBasis(this.host.chat(), this.host.narrator(), through) : undefined;
    }

    basisCurrent(basis) {
        if (!basis) return true;
        const through = this.host.chat().find(message => message.narrator_id === basis.mid);
        return !!through && this.basis(through)?.fingerprint === basis.fingerprint;
    }

    /**
     * Log a director op on the message it was computed from. It stays valid when newer messages have arrived
     * since (the player typed while the planner was thinking); it is discarded only if that message itself
     * was swiped, edited or deleted.
     */
    logOnAnchor(epoch, anchor, anchorHash, op) {
        if (!this.owns(epoch)) return false;
        if (!this.host.chat().includes(anchor) || hash(anchor.mes) !== anchorHash || !this.basisCurrent(op.basis)) { this.again = true; return false; }
        logOp(anchor, op);
        return true;
    }

    /** Setup results (profiles, roll-ups) do not depend on the latest reply: log them on whatever is latest now. */
    logSetup(epoch, op) {
        if (!this.owns(epoch)) return false;
        const m = this.latest();
        if (!m || !this.basisCurrent(op.basis)) return false;
        logOp(m, op);
        return true;
    }

    async ensureGenre(force = false) {
        const epoch = this.epoch;
        const setup = this.host.setup();
        if ((setup.genre && !force) || !this.host.material) return false;
        const material = await this.host.material();
        if (!this.owns(epoch) || !str(material, 50)) return false;
        const drafted = await this.json('genre', genrePrompt({ material }), validateGenre);
        if (!this.owns(epoch)) return false;
        // Preserve the existing story stakes when re-profiling an active story.
        const lethality = setup.genre && this.readView().genre?.lethality;
        const value = lethality ? { ...drafted, lethality } : drafted;
        const m = this.latest();
        if (force && setup.genre && m) logOp(m, { kind: 'genre', by: 'setup', value });
        else this.host.setSetup({ genre: value });
        return true;
    }

    async ensureProfiles() {
        const epoch = this.epoch;
        if (!this.host.cards || !this.view().genre) return false;
        const cards = await this.host.cards();
        if (!this.owns(epoch)) return false;
        const eligible = new Set();
        let wrote = false;
        let recovered = false;

        // Successful card profiles establish the cast names used by the lower-priority sources.
        const atStart = this.view();
        const reserved = new Set(cards.filter(card => str(card.text, 20))
            .flatMap(card => [card.name, ...arr(atStart.cards[card.name]?.people)]));
        const sources = [
            ['card', () => cards],
            ['lore', () => loreCards(this.view(), this.host.loreEntries?.() ?? []).filter(card => !reserved.has(card.name))],
            ['story', () => storyCards(this.view(), this.host.chat(), this.host.narrator(), this.host.loreEntries?.() ?? [])
                .filter(card => !reserved.has(card.name))],
        ];
        for (const [source, candidates] of sources) {
            const state = this.view();
            for (const card of candidates()) {
                const version = card.hash ?? hash(card.text);
                if (!str(card.text, 20) || (source === 'card' && state.cards[card.name]?.hash === version)) continue;
                const key = source + ':' + card.name;
                eligible.add(key);
                const failed = this.profileFails.get(key);
                const attempts = failed?.version === version ? failed.attempts : 0;
                if (attempts >= this.cfg().maxRetries && failed) continue;
                const basis = source !== 'card' ? this.basis() : undefined;
                try {
                    const value = await this.json('profile', profilePrompt({
                        name: card.name, card: card.text, genre: state.genre,
                        isPlayer: !!card.isPlayer, story: source === 'story',
                    }), raw => validateProfile(raw, source === 'card' && !card.isPlayer));
                    if (!this.owns(epoch)) return false;
                    if (source !== 'card' && !this.view().cast[card.name]) {
                        this.profileFails.delete(key);
                        continue;
                    }
                    if (source !== 'card') value.name = card.name;
                    const logged = this.logSetup(epoch, {
                        kind: 'profile', by: 'setup', name: card.name, value, cardHash: version, pc: !!card.isPlayer,
                        ...(card.isPlayer ? { force: true } : {}),
                        ...(card.aliases?.length ? { aliases: card.aliases } : {}),
                        ...(source !== 'card' ? { lore: true } : {}),
                        ...(source === 'story' ? { story: true } : {}),
                        ...(basis ? { basis } : {}),
                    });
                    if (!logged) continue;
                    wrote = true;
                    recovered = this.profileFails.delete(key) || !!this.profileConnectionFailure || recovered;
                    this.profileConnectionFailure = null;
                } catch (error) {
                    if (!this.owns(epoch)) return false;
                    if (source !== 'card' && !this.view().cast[card.name]) {
                        this.profileFails.delete(key);
                        continue;
                    }
                    if (!error?.invalidAnswer) {
                        this.profileConnectionFailure = error;
                        this.cool.profile = Date.now() + (error?.transient ? this.transientWait(error.run) : COOL_MS);
                        if (error?.transient) this.retrySoon(error.run);
                        this.updateProfileWarning(true);
                        return wrote;
                    }
                    this.profileConnectionFailure = null;
                    this.profileFails.set(key, { name: card.name, source, version, attempts: attempts + 1, error });
                    this.updateProfileWarning();
                }
            }
        }
        for (const key of this.profileFails.keys()) {
            if (!eligible.has(key)) this.profileFails.delete(key);
        }
        this.updateProfileWarning(false, recovered);
        return wrote;
    }

    updateProfileWarning(transportFailed = false, recovered = false) {
        const failures = [...this.profileFails.values()];
        const characters = [...new Set(failures.map(failure => failure.name))];
        const connection = this.profileConnectionFailure;
        const previous = this.failing.profile;
        if (!failures.length && !connection) {
            if (recovered) this.recovered('profile');
            else if (previous) {
                delete this.failing.profile;
                this.host.changed?.('errors');
            }
            return;
        }
        const issue = connection ?? failures.at(-1).error;
        const description = connection ? String(issue?.cause?.message ?? issue?.message ?? issue)
            : characters.join(', ') + ' — ' + String(issue?.message ?? issue);
        if (!previous || transportFailed || previous.error !== description) {
            this.fail('profile', new Error(description), null, { characters });
        }
    }

    async maybePlan(force = null) {
        const epoch = this.epoch;
        const cfg = this.cfg();
        let state = this.view();
        const reason = force ?? planTrigger(state, cfg) ?? (state.arc ? spineTrigger(state) : null);
        if (!reason || state.meta.lagging) return false;
        // The arc waits for the player to accept the genre profile, or to start playing, whichever comes first.
        if (!state.arc && !state.genre?.confirmed && state.meta.turn < 1 && !force) return false;
        const anchor = this.latest();
        if (!anchor) return false;
        const anchorHash = hash(anchor.mes);
        const basis = this.basis(anchor);
        const loreKeys = this.host.loreKeys?.() ?? [];
        const provided = await this.memoryRecord(cfg);
        if (!this.owns(epoch)) return false;
        const memory = (st) => plannerMemory({ mode: cfg.memory, state: st, entries: this.readings().entries, provided });
        let wrote = false;
        if (!state.arc) {
            const opening = this.host.chat().find(m => m.is_user && !m.is_system)?.mes ?? '';
            const arc = await this.json('planner', arcPrompt({ state, loreKeys, memory: memory(state), opening }), validateArc);
            if (!this.logOnAnchor(epoch, anchor, anchorHash, { kind: 'arc', by: 'director', value: arc, basis })) return false;
            wrote = true;
            state = this.view();
        }
        // The spine follows the arc at once, so the first plan already serves it. A failed draft does not block the plan;
        // the spine step tries again later.
        if (!state.spine) {
            try {
                const changed = await this.ensureSpine();
                if (!this.owns(epoch)) return false;
                if (changed) { wrote = true; state = this.view(); }
            } catch (e) {
                if (!this.owns(epoch)) return false;
                this.cool.spine = Date.now() + (e?.transient ? this.transientWait(e.run) : COOL_MS);
                this.fail('spine', e);
                if (e?.transient) this.retrySoon(e.run);
            }
        }
        const drafted = await this.json('planner', planPrompt({ state, loreKeys, reason, memory: memory(state) }), (raw) => validatePlan(raw, state));
        if (!this.owns(epoch)) return false;
        // Plan check: code flags, and one cheap rewrite call only when something is flagged. Runs here, in the background
        // pass, never in the narrator's path. Beats that still script the player or fight the genre are dropped.
        const ctx = planCheckContext(state, loreKeys);
        const checked = await reviewPlan(drafted, ctx,
            (flags, draft) => this.json('planner-check', planCheckPrompt({ beats: draft.beats, flags, player: ctx.player, genre: ctx.genre, names: ctx.names }), raw => validatePlanRewrites(raw, flags, draft, ctx)),
            e => { if (this.owns(epoch)) this.fail('planner-check', e); });
        if (!this.owns(epoch)) return false;
        // Nothing left: log nothing (the old queue stays as it was) and let the planner rest before it tries again,
        // so an empty queue cannot set off one planner call per pass.
        if (!checked.plan.beats.length) {
            this.cool.planner = Date.now() + COOL_MS;
            this.fail('planner-check', new Error(`the plan check dropped every beat (${checked.dropped.join(', ')}); the planner tries again later`));
            return wrote;
        }
        const check = checked.flagged || checked.fixed.length ? { fixed: checked.fixed, rewritten: checked.rewritten, dropped: checked.dropped } : undefined;
        wrote = this.logOnAnchor(epoch, anchor, anchorHash, { kind: 'plan', by: 'director', value: checked.plan, reason, seq: planSeqOn(anchor), basis, ...(check ? { check } : {}) }) || wrote;
        return wrote;
    }

    /**
     * The memory extension's record, when it owns memory. Missing, failing or slower than MEMORY_MS: null, and the
     * planner works from the last replies' summaries and the other records.
     */
    async memoryRecord(cfg = this.cfg()) {
        if (memoryMode(cfg.memory) !== 'extension' || !this.host.memoryStory) return null;
        const epoch = this.epoch;
        let timer;
        try {
            const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('memory extension too slow')), Number(cfg.memoryWait) || MEMORY_MS); });
            const r = await Promise.race([Promise.resolve().then(() => this.owns(epoch) ? this.host.memoryStory() : null), late]);
            if (!this.owns(epoch)) return null;
            return r && typeof r === 'object' ? r : (typeof r === 'string' ? { text: r } : null);
        } catch (e) {
            if (this.owns(epoch)) console.warn('[Narrator Director] memory extension unavailable; planning from the latest replies', e);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * The player's safety valve (owner, 21 Nov 2026): a fresh arc from where the story stands, then a fresh spine and
     * plan. Report each part that was saved; a later failure leaves earlier successful parts in place.
     */
    async redraftArc() {
        const cfg = this.cfg();
        const state = this.view();
        if (!state.genre) return false;
        const epoch = this.epoch;
        const loreKeys = this.host.loreKeys?.() ?? [];
        const basis = this.basis();
        const provided = await this.memoryRecord(cfg);
        if (!this.owns(epoch)) return false;
        const memory = plannerMemory({ mode: cfg.memory, state, entries: this.readings().entries, provided });
        const opening = this.host.chat().find(m => m.is_user && !m.is_system)?.mes ?? '';
        const arc = await this.json('planner', arcPrompt({ state, loreKeys, memory, opening, redraft: true }), validateArc);
        const value = { ...arc, act: state.arc?.act ?? arc.act, tension: state.arc?.tension ?? arc.tension };
        if (!this.logSetup(epoch, { kind: 'edit', by: 'player', path: 'arc', value, basis })) return false;
        const saved = ['arc'];
        try {
            if (await this.ensureSpine(true)) saved.push('spine');
        } catch (e) { if (this.owns(epoch)) this.fail('spine', e); }
        if (!this.owns(epoch)) return false;
        try {
            if (await this.maybePlan('the player redrafted the arc: replace every queued opening with a fresh plan from where the story stands')) saved.push('plan');
        } catch (e) { if (this.owns(epoch)) this.fail('planner', e); }
        return this.owns(epoch) && saved;
    }

    /**
     * The spine is drafted once, after the arc, from the same story material as the genre profile.
     * `force` redrafts it (from /director spine), replacing the current one as a player edit.
     */
    async ensureSpine(force = false) {
        const epoch = this.epoch;
        if (!this.host.material) return false;
        const state = this.view();
        if (!state.genre || !state.arc || (state.spine && !force)) return false;
        const basis = this.basis();
        const material = await this.host.material();
        if (!this.owns(epoch) || !str(material, 50)) return false;
        // Agendas (M1) ride in the same call, rooted in the same material; validated against the cast and the material.
        let agendas = [];
        let value = await this.json('planner', spinePrompt({ material, genre: state.genre, premise: state.premise, arc: state.arc, player: state.meta.player, cast: spineCast(state), settled: playerSettled(state).map(s => s.text), story: force ? [state.summaries.rolled, ...state.summaries.recent.slice(-12).map(s => s.text)].filter(Boolean).join('\n') : '' }), (raw) => {
            const v = validateSpine(raw);
            if (v.ok) agendas = validateAgendas(raw.agendas, state, material);
            return v;
        });
        if (!this.owns(epoch)) return false;
        // Check pass: criteria code flags get one cheap rewrite call before the draft is logged. A failed or empty
        // answer leaves the draft as it was: the check never blocks the spine.
        const flagCtx = { present: state.scene.present, player: state.meta.player, location: state.scene.location?.established ? state.scene.location.value : '' };
        const flags = flagSpine(value, flagCtx);
        if (flags.length) {
            try {
                const rewrites = await this.json('planner', spineCheckPrompt({ spine: value, flags, player: state.meta.player }), raw => validateSpineRewrites(raw, flags, { ...flagCtx, spine: value }));
                if (!this.owns(epoch)) return false;
                value = applySpineRewrites(value, rewrites);
            } catch (e) {
                if (!this.owns(epoch)) return false;
                this.fail('spine-check', e);
            }
        }
        const logged = state.spine
            ? this.logSetup(epoch, { kind: 'edit', by: 'player', path: 'spine', replace: true, value: { ...emptySpine(), ...value }, basis })
            : this.logSetup(epoch, { kind: 'spine', by: 'setup', value, basis });
        // A first draft sets the agendas (none is fine); a redraft replaces them only when it brought some.
        if (logged && (agendas.length || !state.spine)) this.logSetup(epoch, { kind: 'agendas', by: 'setup', value: agendas, basis });
        return logged;
    }

    /**
     * A milestone whose checklist is resolved gets its conclusion written from the marks and quotes. The conclusion is
     * logged on the message that resolved it, so swiping or deleting that reply reopens the milestone.
     */
    async maybeConclude() {
        const epoch = this.epoch;
        const state = this.view({ includeProvisional: false });
        // Due is judged on committed replies, but the conclusion may already sit on the newest reply (provisional until
        // the player answers). Without this check every pass would write the same conclusion again.
        const now = this.view();
        const due = needsConclusion(state).filter(m => now.spine?.milestones.find(x => x.id === m.id)?.status !== 'concluded');
        if (!due.length) return false;
        const m = due[0];
        const chat = this.host.chat();
        const sources = [...m.criteria.map(c => c.source), m.happened?.source].filter(Boolean);
        const anchor = [...chat].reverse().find(msg => sources.includes(msg.narrator_id)) ?? this.latest();
        if (!anchor) return false;
        const anchorHash = hash(anchor.mes);
        // A tracker batch can be stored after the reply that resolved the checklist.
        const basis = this.basis();
        const text = await this.json('summariser', conclusionPrompt({ milestone: m, player: state.meta.player, genre: state.genre, scene: state.scene.location.established ? state.scene.location.value : '' }), validateConclusion);
        return this.logOnAnchor(epoch, anchor, anchorHash, { kind: 'conclusion', by: 'director', milestone: m.id, text, basis });
    }

    async maybeRollUp(force = false) {
        const cfg = this.cfg();
        // Roll-ups only compress what the director sends. With another extension (or nothing) keeping the memory, none.
        if (memoryMode(cfg.memory) !== 'director') return false;
        const state = this.view({ includeProvisional: false });
        const first = this.host.firstIncluded?.() ?? 0;
        const gone = state.summaries.recent.filter(s => s.i < first || s.hidden);
        if (gone.length < (force ? 1 : cfg.rollEvery)) return false;
        const epoch = this.epoch;
        const basis = this.basis();
        const value = await this.json('summariser', summariserPrompt({ rolled: state.summaries.rolled, summaries: gone.map(s => s.text) }),
            (raw) => (str(raw?.summary) ? { ok: true, value: str(raw.summary, 2000) } : { ok: false, error: 'no summary' }));
        if (!this.owns(epoch)) return false;
        const prior = this.rolledCovers();
        return this.logSetup(epoch, { kind: 'rollup', by: 'setup', text: value, covers: [...prior, ...gone.map(s => s.source)], basis });
    }

    /**
     * Every `cleanEvery` turns, the live facts are tidied: duplicates and superseded facts merged into the most current
     * wording, faded minor facts retired. Logged as a setup op on the latest message, so deleting that message undoes it.
     * A pass that changes nothing is still logged, so it is not repeated on every turn.
     * Early trigger: when the live facts number more than `cleanAbove` and have grown since the last clean-up (the count
     * left after it, stored as `live` on its op), it runs regardless of the turn timer. One clean-up per pass at most.
     */
    async maybeCleanUp(force = false) {
        const cfg = this.cfg();
        const every = Number(cfg.cleanEvery ?? DEFAULTS.cleanEvery);
        const above = Number(cfg.cleanAbove ?? DEFAULTS.cleanAbove);
        if (!force && !(every > 0) && !(above > 0)) return false;
        const state = this.view({ includeProvisional: false });
        const live = state.canon.filter(f => !f.retired);
        const timed = every > 0 && state.meta.turn - (state.meta.lastCleanTurn ?? 0) >= every && live.length >= 8;
        // Real growth, not one new fact: a clean-up that could not get below the limit would otherwise run every turn.
        // Only facts a clean-up may remove count toward running early: major facts are never deleted, so a count held up by
        // them re-fired every 2-3 turns (audit, 21 Nov 2026).
        const removable = live.filter(f => f.weight !== 'major').length;
        const early = above > 0 && live.length > above && removable >= Math.max(5, Math.round(above / 4))
            && live.length >= this.lastCleanLive() + Math.max(5, Math.round(above / 4));
        if (!force && !timed && !early) return false;
        if (live.length < 2) return false;
        const epoch = this.epoch;
        const basis = this.basis();
        const value = await this.json('cleanup', cleanupPrompt({ facts: live }), (raw) => validateCleanup(raw, live));
        if (!this.owns(epoch)) return false;
        // Live facts left once this op applies (the validator keeps only live ids, minor retires, no id in two places).
        const left = live.length - value.retire.length - value.merges.reduce((n, mg) => n + mg.ids.length - 1, 0);
        return this.logSetup(epoch, { kind: 'facts-clean', by: 'setup', merges: value.merges, retire: value.retire, live: left, basis });
    }

    /** Live-fact count left by the latest clean-up still in the chat (0 if none, or if it predates the count). */
    lastCleanLive() {
        let n = 0;
        for (const m of this.host.chat()) for (const op of m.narrator_ops ?? []) if (op.kind === 'facts-clean') n = Number(op.live) || 0;
        return n;
    }

    /** Message ids the current roll-up already covers, so a new roll-up keeps covering them. */
    rolledCovers() {
        let covers = [];
        for (const m of this.host.chat()) for (const op of m.narrator_ops ?? []) if (op.kind === 'rollup') covers = op.covers ?? [];
        const present = new Set(this.host.chat().map(m => m.narrator_id));
        return covers.every(id => present.has(id)) ? covers : [];
    }

    /** A player-made change, logged on the latest message. */
    playerOp(op) {
        if (!this.owns()) return false;
        this.sync();
        const m = this.latest();
        if (!m) return false;
        if (op.kind === 'retcon' && op.ids?.length) {
            const { canon, uncertain } = this.view();
            const texts = [...canon, ...uncertain].filter(f => op.ids.includes(f.id)).map(f => f.fact);
            op = { ...op, texts: [...new Set([...arr(op.texts), ...texts])] };
        }
        if (op.kind === 'edit' && ['arc', 'spine', 'beats', 'scenes'].includes(op.path)) {
            op = { ...op, basis: this.basis() };
        }
        logOp(m, { ...op, by: 'player' });
        this.host.save();
        this.host.changed?.('player');
        return true;
    }

    /** Let a failed reply be read again. */
    retry() {
        if (!this.owns()) return Promise.resolve();
        for (const m of this.host.chat()) { delete m.extra?.narrator?.err; delete m.extra?.narrator?.trackErr; }
        this.errors = [];
        // Failing parts stay listed until they answer again, so the player sees them recover.
        for (const failure of this.profileFails.values()) failure.attempts = 0;
        this.cool = {};
        this.trackMax = null;
        this.emptyRun = {};
        return this.kick();
    }
}
