// Memory connectors: where the planner reads the story so far when another extension owns memory (settings.memory
// 'extension'). Each connector says whether its extension is there and returns { text, missing?, source }.
// Other extensions may register { id, name, available, story, gaps?, supportsBefore? }. Only gaps() must be synchronous.

const ctx = () => SillyTavern.getContext();

/** A macro's value, or '' when the macro is unknown (SillyTavern then leaves the text as typed). */
function macroText(name) {
    const raw = `{{${name}}}`;
    const out = String(ctx().substituteParams?.(raw) ?? '');
    return out === raw ? '' : out.trim();
}

const providers = new Map();

export function registerMemoryProvider(p) {
    if (!p || typeof p.id !== 'string' || typeof p.story !== 'function') throw new TypeError('a memory provider needs an id and a story()');
    providers.set(p.id, { name: p.id, available: () => true, ...p });
}

// BaiBai Book: its layered record (L0 summaries of each reply, merged upwards into L1, L2, L3), chosen by BaiBai's own
// rule: the highest level that fully covers each stretch. coverage.missingAiFloors lists replies with no valid summary.
const baiBaiMissing = h => Array.isArray(h?.coverage?.missingAiFloors) ? h.coverage.missingAiFloors : null;
registerMemoryProvider({
    id: 'baibai',
    name: 'BaiBai Book',
    supportsBefore: true,
    available: () => typeof globalThis.STBaiBaiBook?.getHistory === 'function',
    story({ before } = {}) {
        const h = globalThis.STBaiBaiBook.getHistory(Number.isInteger(before) ? { before } : {});
        return { text: String(h?.text ?? ''), missing: baiBaiMissing(h), source: 'BaiBai Book', before: h?.before };
    },
    gaps: () => baiBaiMissing(globalThis.STBaiBaiBook.getHistory({})),
});

// SillyTavern's built-in Summarize extension.
registerMemoryProvider({
    id: 'summarize',
    name: 'SillyTavern Summarize',
    available: () => !!macroText('summary'),
    story: () => ({ text: macroText('summary'), source: 'Summarize' }),
});

/**
 * Chat indices of replies the memory extension has no summary for, or null when it cannot tell. Synchronous: it is
 * read while the narrator's prompt is built. An empty array means all replies are covered.
 * @param {{memoryProvider?: string}} settings
 */
export function memoryGaps(settings) {
    try {
        const missing = availableProviders(settings).next().value?.gaps?.();
        if (typeof missing?.catch === 'function') missing.catch(() => {});
        return Array.isArray(missing) ? missing : null;
    } catch {
        return null;
    }
}

/** Connector choices for the settings panel: [value, label]. */
export const providerOptions = () => [['auto', 'Automatic'], ...[...providers.values()].map(p => [p.id, p.name]), ['macro', 'A macro, named below']];

function* availableProviders(settings) {
    const choice = settings.memoryProvider || 'auto';
    const list = choice === 'auto' ? providers.values() : [providers.get(choice)];
    for (const provider of list) {
        try { if (provider?.available()) yield provider; } catch { /* provider unavailable */ }
    }
}

/**
 * The record from the chosen connector. 'auto' takes the first available one. 'macro' reads {{name}}.
 * @param {{memoryProvider?: string, memoryMacro?: string}} settings
 * @param {{before?: number}} [options] An exclusive chat index. Providers must support the cutoff and return it.
 */
export async function memoryStory(settings, options = {}) {
    const choice = settings.memoryProvider || 'auto';
    const bounded = Number.isInteger(options.before);
    if (choice === 'macro') {
        if (bounded) return null;
        const name = String(settings.memoryMacro ?? '').replace(/[{}]/g, '').trim();
        const text = name ? macroText(name) : '';
        return text ? { text, source: `{{${name}}}` } : null;
    }
    for (const provider of availableProviders(settings)) {
        if (bounded && !provider.supportsBefore) continue;
        const record = await provider.story(options);
        if (bounded && record?.before !== options.before) continue;
        if (record?.text) return record;
        // Present but nothing summarised yet (BaiBai writes a reply's summary only after the next reply).
        if (record) return { ...record, text: '', empty: true };
    }
    return null;
}
