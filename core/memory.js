// What the planner reads as the story so far, by memory mode.
//
//   director   the director's own turn summaries and roll-up (unchanged behaviour)
//   extension  another extension (BaiBai Book, Summarize, a macro) owns memory. The planner reads its record, plus the
//              director's one-line summaries of the last 2 replies, which cover the extension running a reply behind
//              (BaiBai writes a reply's summary only after the next reply) and a short outage
//   off        no story memory: only the last 2 replies' lines
//
// In the last two modes nothing here reaches the narrator; the narrator's memory is the extension's business.

import { beatText } from './beat.js';
import { factsInView, playerSettled } from './state.js';
import { normalise } from './text.js';
import { clip, str } from './util.js';

export const MEMORY_MODES = ['director', 'extension', 'off'];
export const LATEST = 2;
const RAW_PER_GAP = 600;
const RAW_GAPS = 4;

export const memoryMode = (v) => (MEMORY_MODES.includes(v) ? v : 'director');

/**
 * @param {object} args
 * @param {string} args.mode
 * @param {object} args.state Replayed state.
 * @param {object[]} [args.entries] scan() of the chat, to place gaps and quote hidden replies.
 * @param {{text?: string, missing?: number[], source?: string}|null} [args.provided] The extension's record, or null when
 *   it is missing, failed or was too slow.
 * @returns {{mode: string, text: string, source: string, latest: string[], gaps: number, raw: string[], unavailable: boolean}}
 */
export function plannerMemory({ mode, state, entries = [], provided = null }) {
    const m = memoryMode(mode);
    const latest = state.summaries.recent.slice(-LATEST).map(s => s.text).filter(Boolean);
    const out = { mode: m, text: '', source: '', latest, gaps: 0, raw: [], unavailable: false, empty: false };
    if (m !== 'extension') return out;
    const text = str(provided?.text ?? '', 1e6);
    // Present but empty: early in a chat the extension has summarised nothing yet. That is not an outage.
    if (!text) { out.unavailable = !provided; out.empty = !!provided; return out; }
    out.text = text;
    out.source = str(provided?.source ?? '', 60);
    // The newest replies have no summary in the extension yet; the director's lines cover them, so they are no gap.
    const narr = entries.filter(e => e.kind === 'narration');
    const covered = new Set(narr.slice(-LATEST).map(e => e.i));
    const missing = [...new Set((provided?.missing ?? []).map(Number).filter(Number.isInteger))]
        .filter(i => !covered.has(i) && entries[i]?.kind === 'narration');
    out.gaps = missing.length;
    // A stretch with no summary that has also left the prompt would be lost entirely: quote it, briefly.
    out.raw = missing.filter(i => entries[i].hidden).slice(-RAW_GAPS)
        .map(i => clip(entries[i].text, RAW_PER_GAP)).filter(Boolean);
    return out;
}

/** Keep relevant passages from a long record in their original order. */
export function memoryExcerpt(text, query, limit) {
    const source = str(text, 1e6);
    if (source.length <= limit) return source;
    const words = text => normalise(text).split(' ').filter(word => word.length >= 4);
    const terms = new Set(words(query));
    const passages = source.split(/\r?\n+/).flatMap(line => line.match(/.{1,1000}(?:\s|$)|.{1000}/gu) ?? []);
    const ranked = passages.map((passage, index) => ({
        passage, index, score: new Set(words(passage).filter(word => terms.has(word))).size,
    })).sort((a, b) => b.score - a.score || b.index - a.index);
    const selected = [];
    let remaining = limit;
    for (const item of ranked) {
        if (item.passage.length + 1 > remaining) continue;
        selected.push(item);
        remaining -= item.passage.length + 1;
    }
    return selected.sort((a, b) => a.index - b.index).map(item => item.passage).join('\n');
}

/** Supply the same bounded story records for a plan check or a spine draft. */
export function planCheckEvidence(state, beats, memory) {
    const query = [state.scene.location.value, ...state.scene.present, ...beats.map(b => {
        const { goal, pressure } = beatText(b);
        return [goal, pressure, b.precondition, b.when?.place, ...(b.when?.people ?? [])].filter(Boolean).join(' ');
    })].filter(Boolean).join(' ');
    const select = (text, budget) => memoryExcerpt(text, query, budget);
    const { location, time, present } = state.scene;
    const scene = [location.established && `Location: ${location.value}`, time.established && `Time: ${time.value}`,
        present.length && `Present: ${present.join(', ')}`].filter(Boolean).join('\n');
    const record = memory.mode === 'director'
        ? [state.summaries.rolled, ...state.summaries.recent.slice(-12, -LATEST).map(s => s.text)].filter(Boolean).join('\n')
        : memory.text;
    return [
        ['Current scene', clip(scene, 800)],
        ['Settled by the player', select(playerSettled(state).map(s => s.text).join('\n'), 1200)],
        ['Established story facts', select(factsInView(state).map(f => f.memory ? `Earlier memory (${f.memory.source}): ${f.fact}` : f.fact).join('\n'), 3200)],
        ['Recent Director summaries', select(memory.latest.join('\n'), 1600)],
        [memory.source ? `Earlier story memory (${memory.source})` : 'Earlier story memory', select(record, 8000)],
    ].filter(([, text]) => text);
}
