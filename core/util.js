// Pure helpers. No SillyTavern imports anywhere under core/, so everything here runs in Node for tests and fixtures.

/** FNV-1a 32-bit, hex. Fast, stable, good enough to detect that a reply's text changed. */
export function hash(text) {
    let h = 0x811c9dc5;
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

export function uuid() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/**
 * Like str(), but a text over the limit is cut at the last sentence end that fits, or else at the last word, with "…".
 * For text the narrator reads, which must never stop mid-word.
 */
export function clip(v, max = 400) {
    const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
    if (s.length <= max) return s;
    const head = s.slice(0, max);
    let end = -1;
    for (const m of `${head} `.matchAll(/[.!?;]["'”’)]?(?=\s)/g)) end = m.index + m[0].length;
    if (end >= max * 0.5) return head.slice(0, end).replace(/;$/, '.').trim();
    const sp = head.lastIndexOf(' ');
    return `${(sp > 0 ? head.slice(0, sp) : head.slice(0, max - 1)).replace(/[,;:\s]+$/, '')}…`;
}

export const arr = (v) =>(Array.isArray(v) ? v : []);

/** Case- and space-insensitive key for names and lore keys. */
export const nameKey = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** ASCII slug for variable names: "Ji Si" -> "ji_si". Non-ASCII names fall back to a hash so keys stay ASCII. */
export function slug(s) {
    const base = String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return base || `n${hash(s)}`;
}

/** Values the models use to say "nothing changed". */
export function isBlank(v) {
    if (v === null || v === undefined) return true;
    if (typeof v !== 'string') return false;
    return /^(|same|unchanged|n\/?a|none|null|unknown|-|—)$/i.test(v.trim());
}

export function getPath(obj, path) {
    return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
    const keys = String(path).split('.');
    if (keys.some(k => k === '__proto__' || k === 'constructor' || k === 'prototype')) return false;
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!isObj(o[keys[i]]) && !Array.isArray(o[keys[i]])) o[keys[i]] = {};
        o = o[keys[i]];
    }
    o[keys.at(-1)] = value;
    return true;
}

// Word sets for similarity, cached: replay compares every new fact with every fact on record, and building the sets was
// 75% of replay time (audit, 21 Nov 2026). The sets are only read, never changed.
const SIM_CACHE = new Map();
const EAST_ASIAN_WORDS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
function simTok(s) {
    const k = String(s ?? '');
    let v = SIM_CACHE.get(k);
    if (!v) {
        if (SIM_CACHE.size > 20000) SIM_CACHE.clear();
        const normal = nameKey(k);
        const pairs = new Set();
        for (const [run] of normal.matchAll(EAST_ASIAN_WORDS)) {
            const chars = [...run];
            for (let i = 1; i < chars.length; i++) pairs.add(chars[i - 1] + chars[i]);
        }
        v = { words: new Set(normal.replace(/[^\p{L}\p{N} ]/gu, ' ').split(' ').filter(w => w.length > 2)), pairs };
        SIM_CACHE.set(k, v);
    }
    return v;
}

/** Word-overlap similarity, used to keep retconned facts from coming back reworded. */
export function similarity(a, b) {
    const left = simTok(a), right = simTok(b);
    if (left.pairs.size && right.pairs.size) {
        let shared = 0;
        for (const pair of left.pairs) if (right.pairs.has(pair)) shared++;
        return 2 * shared / (left.pairs.size + right.pairs.size);
    }
    const A = left.words, B = right.words;
    if (!A.size || !B.size) return nameKey(a) === nameKey(b) ? 1 : 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / (A.size + B.size - inter);
}

/** Rough token estimate (no tokenizer in core): ~4 chars per token, CJK ~1 per char. */
export function roughTokens(text) {
    const s = String(text ?? '');
    const cjk = (s.match(/[　-鿿가-힯]/g) || []).length;
    return Math.ceil((s.length - cjk) / 4) + cjk;
}
