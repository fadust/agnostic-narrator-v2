// Leak stripping and quote matching. The same patterns ship as regex scripts on the card (card/build.mjs imports them).

export const FALLBACK_NOTE = 'The director has no notes ready for this turn. Narrate from the chat as it stands.';

const QUOTED_DIRECTOR_CODE = String.raw`["“][ \t]*\x60[ \t]*<(director_notes|story_context)>[\s\S]*?</\1>[ \t]*\x60`;

/** Cleanup rules shared by runtime replacement and the card's SillyTavern regex scripts. */
export const LEAK_PATTERNS = [
    // Take the wrapper with the block. A quote followed by speech is the opening quote of the real line.
    { name: 'quoted director code at line end', source: String.raw`(?:[ \t]+|(?<![^\s:*]))${QUOTED_DIRECTOR_CODE}[ \t]*["”][ \t]*(?=(?:\*\*)?[ \t]*\r?$)`, flags: 'gim' },
    { name: 'director code before dialogue', source: String.raw`(?<![^\s:*])${QUOTED_DIRECTOR_CODE}[ \t]*(?=["“][^\s"“”][^\r\n"“”]*["”])`, flags: 'gi' },
    { name: 'quoted director code in prose', source: String.raw`(?<![^\s:*])${QUOTED_DIRECTOR_CODE}[ \t]*["”][ \t]+`, flags: 'gi' },
    { name: 'director notes block', source: '<director_notes>[\\s\\S]*?</director_notes>\\s*', flags: 'gi' },
    { name: 'unclosed director notes', source: '<director_notes>[\\s\\S]*$', flags: 'gi' },
    // Spaces after a stray tag go, the line break stays: "\s*" here used to glue the paragraphs either side together.
    { name: 'stray closing tag', source: '</director_notes>[ \\t]*', flags: 'gi' },
    { name: 'story context block', source: '<story_context>[\\s\\S]*?</story_context>\\s*', flags: 'gi' },
    { name: 'unclosed story context', source: '<story_context>[\\s\\S]*$', flags: 'gi' },
].map(rule => ({ ...rule, pattern: new RegExp(rule.source, rule.flags), replacement: '' }));

export function stripDirector(text) {
    return replaceMatches(text, LEAK_PATTERNS).trim();
}

export const DIALOGUE_FIXES = [
    // A blank quoted prefix immediately before real dialogue on a speaker line.
    { name: 'blank dialogue prefix', pattern: /^([ \t]*(?:\*\*)?[\p{L}\p{M}][\p{L}\p{M}\p{N} .’'-]{0,60}(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*)["“](?:[ \t]*\x60[ \t]+\x60[ \t]*|[ \t]+)(?=["“]\S[^\r\n"“”]*["”])/gmu },
    // An empty quoted string or blank code span after a finished sentence, before any closing bold markers.
    { name: 'blank dialogue suffix', pattern: /([.!?…])[ \t]+(?:"(?:[ \t]*\x60[ \t]+\x60[ \t]*)?[ \t]*"|“[ \t]*”)(?:[ \t]|&#x20;)*(?=(?:\*\*)?[ \t]*\r?$)/gmu },
    // An empty spoken cue followed directly by prose. Keep any bold markup around the paragraph.
    { name: 'blank speaker cue before prose', pattern: /^([ \t]*(?:\*\*)?)[\p{L}\p{M}][\p{L}\p{M}\p{N} .’'-]{0,60}:[ \t]*["“]\x60[ \t]+\x60["”][ \t]+(?=[\p{L}\p{N}])/gmu },
    { name: 'blank code at line end', pattern: /([.!?…])[ \t]+\x60[ \t]+\x60[ \t]*(?=\r?$)/gm },
    { name: 'blank code in prose', pattern: /([^\s"“”\\\x60][ \t]+)\x60[ \t]+\x60[ \t]+/g },
    { name: 'blank code between spoken lines', pattern: /("[^"\r\n]+"|“[^”\r\n]+”)[ \t]*\x60[ \t]+\x60(?=[ \t]+["“])/g },
].map(({ name, pattern }) => ({ name, pattern, source: pattern.source, flags: pattern.flags, replacement: '$1' }));

export function cleanDialogue(text) {
    return replaceMatches(text, DIALOGUE_FIXES);
}

function replaceMatches(text, rules) {
    let out = String(text ?? '');
    for (const { pattern, replacement } of rules) out = out.replace(pattern, replacement);
    return out;
}

/**
 * Remove other extensions' tags from a reply before the director reads it: each `<tag …>…</tag>` goes whole, content
 * included, and so does any stray single `<tag>`, `</tag>` or `<tag/>`. Tag names are matched case-insensitively.
 * The saved message is never changed; this is only what the director reads.
 * @param {string} text
 * @param {string[]} [tags]
 */
export function stripTags(text, tags) {
    let out = String(text ?? '');
    const names = (tags ?? []).map(t => String(t).trim()).filter(t => /^[\w:.-]+$/.test(t));
    if (!names.length) return out;
    for (const name of names) {
        const t = name.replace(/\./g, '\\.');
        out = out.replace(new RegExp(`<${t}(?:\\s[^>]*)?>[\\s\\S]*?</${t}\\s*>`, 'gi'), '');
        out = out.replace(new RegExp(`</?${t}(?:\\s[^>]*)?/?>`, 'gi'), '');
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** "bbs_start, bbs_end" -> ['bbs_start', 'bbs_end']. Angle brackets and slashes typed by the player are ignored. */
export const parseTags = (s) => String(s ?? '').split(/[\s,;]+/).map(t => t.replace(/[<>/]/g, '').trim()).filter(Boolean);

export const hasLeak =(text) => /<\/?(director_notes|story_context)>/i.test(String(text ?? ''));

/**
 * True when a name reads as a person's name rather than a role. "the cobbler", "a clothier" and "restaurant keeper"
 * are roles. In scripts with capital letters a name has one; scripts without capitals (Chinese, Japanese) pass.
 */
export function looksLikeName(name) {
    const n = String(name ?? '').trim();
    if (!n) return false;
    if (/^(the|a|an|some|another)\s/i.test(n)) return false;
    return !(/\p{Ll}/u.test(n) && !/\p{Lu}/u.test(n));
}

/** A role as a cast key: no leading article, first letter capital ("the hall master" -> "Hall master"). */
export function roleName(name) {
    const n = String(name ?? '').trim().replace(/^(the|a|an)\s+/i, '');
    return n ? n[0].toUpperCase() + n.slice(1) : '';
}

/**
 * A person known only by a role counts as a character once they speak under that role ("The hall master: ...", or
 * "Hall master:" at a line's start) or a plan centres on them (owner, 22 Nov 2026: a role-only figure who granted the
 * commission and gained trust was refused everywhere, while plans kept building on him).
 */
export function castableRole(name, text, planned = '') {
    const role = roleName(name).toLowerCase();
    if (!role || role.split(' ').length > 4) return false;
    const esc = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|\\n)\\s*[*_]*(the\\s+)?${esc}[*_]*\\s*:`, 'i').test(String(text ?? ''))) return true;
    return String(planned ?? '').toLowerCase().includes(role);
}

/** Normalise for quote comparison: drop markup, unify punctuation away, collapse whitespace, lowercase. */
export function normalise(text) {
    return String(text ?? '')
        .normalize('NFKC')
        .replace(/<[^>]{0,80}>/g, ' ')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

// Short enough to admit "He is dead.", long enough that a stray word is not evidence.
const MIN_QUOTE = 5;

/**
 * True when `quote` is really in `text`. An ellipsis in the quote splits it into parts that must appear in order.
 * A quote too short to be evidence is refused unless it is the whole text.
 */
export function quoteMatches(quote, text, normalisedText = null) {
    return matchQuote(quote, text, normalisedText) !== '';
}

// Pronouns and possessives a model may write in place of a name, or the other way round.
const PRONOUNS = new Set(['he', 'she', 'they', 'him', 'her', 'them', 'his', 'hers', 'their', 'theirs', 'it', 'its',
    'himself', 'herself', 'themselves', 'itself', 'who', 'whom', 'whose']);
// A quote must be this many words long before a name/pronoun swap is forgiven, and at most this many swaps.
const MIN_LENIENT_WORDS = 6;
const MAX_SWAPS = 2;

/** Words with their place in the text. "Elizabeth's" and "don't" stay one word. Markup is blanked out. */
function words(text) {
    const src = String(text ?? '').normalize('NFKC').replace(/<[^>]{0,80}>/g, m => ' '.repeat(m.length));
    const out = [];
    for (const m of src.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)) {
        const w = m[0].replace(/’/g, "'");
        out.push({ key: w.toLowerCase(), cap: /^\p{Lu}/u.test(w), start: m.index, end: m.index + m[0].length });
    }
    return { src, out };
}

/** A word that may stand for a person: a pronoun, or a capitalised word (a name, "Elizabeth's"). */
const personWord = (w) => w.cap || PRONOUNS.has(w.key);

/**
 * The quote as it should be stored, or '' when it is not in `text`. An exact match keeps the quote as given. Failing
 * that, a quote of 6+ words still matches when it differs from a run of the reply only by one or two words where one
 * side is a pronoun and the other a pronoun or name ("Her left hand" for "Elizabeth's left hand"); every other word
 * must match in order. Then the reply's own wording is returned, so a stored quote is always genuine text.
 */
export function matchQuote(quote, text, normalisedText = null) {
    if (exactMatch(quote, text, normalisedText)) return String(quote ?? '');
    const q = words(quote).out;
    const { src, out: t } = words(text);
    if (q.length < MIN_LENIENT_WORDS || /\.{3,}|…/.test(String(quote ?? ''))) return '';
    for (let i = 0; i + q.length <= t.length; i++) {
        let swaps = 0;
        for (let j = 0; j < q.length && swaps <= MAX_SWAPS; j++) {
            const a = q[j], b = t[i + j];
            if (a.key === b.key) continue;
            const pronounSwap = (PRONOUNS.has(a.key) || PRONOUNS.has(b.key)) && personWord(a) && personWord(b);
            swaps += pronounSwap ? 1 : MAX_SWAPS + 1;
        }
        if (swaps <= MAX_SWAPS) return src.slice(t[i].start, t[i + q.length - 1].end);
    }
    return '';
}

/**
 * A short answer counts when it is a whole spoken line: inside quotation marks, or the whole line after a speaker tag
 * (audit, 21 Nov 2026: a character's pivotal "...Yes." was refused as too short to be evidence).
 */
function spokenLine(short, text) {
    if (!short) return false;
    const src = String(text ?? '');
    for (const m of src.matchAll(/["“”]([^"“”\n]{1,40})["“”]|^[^\n:]{1,40}:\s*([^\n]{1,40})$/gmu)) if (normalise(m[1] ?? m[2]) === short) return true;
    return false;
}

function exactMatch(quote, text, normalisedText) {
    const hay = normalisedText ?? normalise(text);
    const parts = String(quote ?? '').split(/\.{3,}|…|\[\.\.\.\]/).map(normalise).filter(Boolean);
    if (!parts.length) return false;
    const total = parts.reduce((n, p) => n + p.replace(/ /g, '').length, 0);
    const cjk = /[　-鿿가-힯]/.test(parts.join(''));
    if (total < (cjk ? 3 : MIN_QUOTE) && parts.join(' ') !== hay && !spokenLine(parts.join(' '), text)) return false;
    const inOrder = (list) => {
        let from = 0;
        for (const p of list) {
            const at = hay.indexOf(p, from);
            if (at === -1) return false;
            from = at + p.length;
        }
        return true;
    };
    if (inOrder(parts)) return true;
    // Speech is quoted without its tags: "'My father had a chest,' she says. 'Bond notes.'" comes back as "My father had
    // a chest. Bond notes." Accept it when every sentence of the quote is in the text, in order. Each still has to be
    // there word for word, so nothing paraphrased passes.
    const sentences = String(quote ?? '').split(/\.{3,}|…|\[\.\.\.\]|[.!?;](?=\s|$)|,(?=\s)/).map(normalise).filter(p => p.replace(/ /g, '').length >= 3);
    return sentences.length >= 2 && inOrder(sentences);
}
