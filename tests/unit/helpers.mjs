import { Director } from '../../core/director.js';

export const NARRATOR = { name: 'Narrator', avatar: 'narrator.png', group: false };

export const user = (mes) => ({ is_user: true, name: 'Rowan', mes, extra: {} });
export const narr = (mes) => ({ is_user: false, name: 'Narrator', mes, extra: {} });

/** Observer double: turns "Name does X." sentences into facts quoting themselves. Override per test with `script`. */
export function fakeObserver(reply) {
    const sentences = reply.split(/(?<=\.)\s+/).filter(s => s.length > 12);
    return {
        summary: sentences[0] ?? '',
        scene: { present: [], mood: 'calm', initiative: 'player' },
        facts: sentences.map(s => ({ fact: s.replace(/\.$/, ''), quote: s, certainty: 'stated', witnesses: 'present' })),
    };
}

export function makeHost(chat, opts = {}) {
    const state = { setup: { player: 'Rowan', genre: { dominant: 'fantasy', confirmed: true }, ...(opts.setup ?? {}) }, saves: 0, calls: [] };
    const host = {
        chat: () => chat,
        narrator: () => NARRATOR,
        setup: () => state.setup,
        setSetup: (p) => Object.assign(state.setup, p),
        settings: () => ({ cadence: 0, ...(opts.settings ?? {}) }),
        save: () => { state.saves++; },
        changed: () => { },
        firstIncluded: () => opts.firstIncluded ?? 0,
        call: async (module, messages) => {
            state.calls.push({ module, messages });
            if (opts.gate) await opts.gate(module, messages);
            // A test's script speaks for the observer only; other modules use the defaults.
            const out = (module === 'observer' && opts.script ? opts.script : defaultScript)(module, messages);
            return typeof out === 'string' ? out : JSON.stringify(out);
        },
    };
    const director = new Director(host);
    return { host, director, state };
}

export function replyOf(messages) {
    return messages.at(-1).content.split('## REPLY\n')[1];
}

export function defaultScript(module, messages) {
    if (module === 'observer') return fakeObserver(replyOf(messages));
    if (module === 'observer-check') return { verdicts: [{ id: 'beat', verdict: 'confirm' }] };
    if (module === 'planner') {
        if (messages[0].content.includes('outline the arc')) {
            return { goal: 'Settle the debt', forces: ['the guild', 'the family'], payoff: { name: 'the reckoning', act: 3, hooks: ['a seal'] }, endings: [{ title: 'Paid' }, { title: 'Fled' }] };
        }
        return { scenes: [{ id: 's1', purpose: 'arrival' }], beats: [{ scene: 's1', intent: 'let the debt surface', precondition: 'the player enters the city', type: 'pressure', clues: [{ text: 'a seal on the gate', route: 'place' }] }, { scene: 's1', intent: 'a quiet meal', type: 'release' }] };
    }
    if (module === 'summariser') return { summary: 'Rolled summary.' };
    return {};
}
