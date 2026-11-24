#!/usr/bin/env node
// Fixture suite for director models (dev tool; not part of the extension).
// It sends the extension's real prompts to an OpenAI-compatible endpoint and checks the validated result.
//
//   node tools/fixtures.mjs --base-url http://127.0.0.1:5001/v1 --model my-model [--only obs-] [--runs 1] [--verbose]
//   FIXTURE_API_KEY=... for endpoints that need a key.
//   --print shows the prompts without calling anything.
//
// Pass bar (acceptance check): 90% of fixtures pass and no fixture produces forbidden output.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBrief } from '../core/brief.js';
import { extractJson } from '../core/json.js';
import { validateArc, validateGenre, validatePlan, validateProfile } from '../core/planner.js';
import { arcPrompt, genrePrompt, observerPrompt, planPrompt, profilePrompt } from '../core/prompts.js';
import { ensureCast, initialState } from '../core/state.js';
import { validateObservation } from '../core/validate.js';
import { getPath } from '../core/util.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => JSON.parse(readFileSync(join(root, 'fixtures', f), 'utf8'));

/** Build the state slice a fixture describes. */
export function stateFor(input) {
    const s = initialState({ player: input.player ?? 'Rowan', genre: input.genre ?? { dominant: 'fantasy' }, premise: input.premise ?? '' });
    ensureCast(s, s.meta.player).pc = true;
    for (const n of input.cast ?? []) ensureCast(s, n);
    for (const n of input.dead ?? []) ensureCast(s, n).dead = true;
    s.scene.present = input.present ?? (input.cast ?? []).filter(n => !(input.dead ?? []).includes(n));
    if (input.location) s.scene.location = { value: input.location, established: true };
    (input.canon ?? []).forEach((fact, i) => s.canon.push({ id: `fx-${i}`, fact, quote: fact, source: 'fixture', witnesses: [] }));
    (input.tombstones ?? []).forEach(fact => s.tombstones.push({ fact, source: 'fixture', turn: 0 }));
    (input.summaries ?? []).forEach((text, i) => s.summaries.recent.push({ text, source: `fx${i}`, i }));
    if (input.arc) s.arc = input.arc;
    if (input.beat) {
        s.beats.push({ id: 'fxbeat', scene: '', intent: input.beat.intent, precondition: '', type: 'reveal', required: false, status: 'queued', lore: [],
            clues: (input.beat.clues ?? []).map((c, n) => ({ id: `fxbeat-c${n}`, text: c.text, route: 'place', where: '', found: false })) });
    }
    (input.queued ?? []).forEach((intent, n) => s.beats.push({ id: `fxq${n}`, scene: '', intent, precondition: '', type: 'pressure', required: false, status: 'queued', lore: [], clues: [] }));
    return s;
}

/** Prompt and validator for one fixture. */
export function prepare(fx) {
    const module = fx.module ?? 'observer';
    const input = fx.input;
    if (module === 'observer') {
        const state = stateFor(input);
        const offered = buildBrief(state).offered;
        return {
            messages: observerPrompt({ state, reply: input.reply, playerMessage: input.playerMessage, offered }),
            validate: (raw) => {
                const v = validateObservation(raw, {
                    text: input.reply, names: [...Object.keys(state.cast)], tombstones: state.tombstones, present: state.scene.present,
                    uncertainIds: [], threadIds: [], clueIds: offered.clues, player: state.meta.player,
                    playerMessage: input.playerMessage, beatOffered: !!offered.beat,
                });
                return { ok: true, value: v.delta, rejected: v.rejected };
            },
        };
    }
    if (module === 'genre') return { messages: genrePrompt({ material: input.material }), validate: validateGenre };
    if (module === 'profile') return { messages: profilePrompt(input), validate: validateProfile };
    const state = stateFor(input);
    if (module === 'arc') return { messages: arcPrompt({ state, loreKeys: [] }), validate: validateArc };
    return { messages: planPrompt({ state, loreKeys: input.loreKeys ?? [], reason: input.reason ?? 'cadence' }), validate: (raw) => validatePlan(raw, state) };
}

/** One assertion against a validated result. Returns true when it holds. */
export function holds(a, value, rejected = []) {
    if ('maxRejected' in a) return rejected.length <= a.maxRejected;
    if (a.count) { const [p, min, max] = a.count; const n = (getPath(value, p) ?? []).length; return n >= min && n <= max; }
    if (a.range) { const [p, min, max] = a.range; const n = Number(getPath(value, p)); return n >= min && n <= max; }
    const re = new RegExp(a.matching ?? '.', 'i');
    if (a.has) {
        return (getPath(value, a.has) ?? []).some(item => {
            if (!re.test(JSON.stringify(item))) return false;
            if (a.where?.certainty && item.certainty !== a.where.certainty) return false;
            if (a.where?.witnessesInclude) return item.witnesses === 'present' || (item.witnesses ?? []).includes(a.where.witnessesInclude);
            return true;
        });
    }
    if (a.path) { const v = getPath(value, a.path); return v !== undefined && re.test(typeof v === 'string' ? v : JSON.stringify(v)); }
    return false;
}

export function judge(fx, rawText) {
    const { validate } = prepare(fx);
    const parsed = extractJson(rawText);
    if (!parsed.ok) return { pass: false, forbidden: false, why: [`unparseable: ${parsed.error}`] };
    const v = validate(parsed.value);
    if (!v.ok) return { pass: false, forbidden: false, why: [`invalid: ${v.error}`] };
    const why = [];
    for (const a of fx.expect ?? []) if (!holds(a, v.value, v.rejected)) why.push(`expected ${JSON.stringify(a)}`);
    let forbidden = false;
    for (const a of fx.forbid ?? []) if (holds(a, v.value, v.rejected)) { forbidden = true; why.push(`FORBIDDEN ${JSON.stringify(a)}`); }
    return { pass: !why.length, forbidden, why, value: v.value, rejected: v.rejected };
}

async function main() {
    const args = process.argv.slice(2);
    const opt = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : (args[i + 1] ?? true); };
    const fixtures = [...load('observer.json'), ...load('planning.json')].filter(f => !opt('only') || f.id.includes(opt('only')));
    if (args.includes('--print')) {
        for (const fx of fixtures) { console.log(`\n===== ${fx.id}`); for (const m of prepare(fx).messages) console.log(`--- ${m.role}\n${m.content}`); }
        return;
    }
    const base = opt('base-url'), model = opt('model'), runs = Number(opt('runs', 1));
    if (!base || !model) { console.error('Usage: node tools/fixtures.mjs --base-url <url>/v1 --model <name> [--only id] [--runs n] [--verbose] [--print]'); process.exit(2); }
    let passed = 0, total = 0, forbidden = 0;
    for (const fx of fixtures) {
        for (let r = 0; r < runs; r++) {
            total++;
            let out;
            try {
                const res = await fetch(`${String(base).replace(/\/$/, '')}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...(process.env.FIXTURE_API_KEY ? { Authorization: `Bearer ${process.env.FIXTURE_API_KEY}` } : {}) },
                    body: JSON.stringify({ model, messages: prepare(fx).messages, temperature: Number(opt('temperature', 0.2)), max_tokens: 1800 }),
                });
                const data = await res.json();
                out = judge(fx, data.choices?.[0]?.message?.content ?? '');
            } catch (e) { out = { pass: false, forbidden: false, why: [`request failed: ${e.message}`] }; }
            if (out.pass) passed++;
            if (out.forbidden) forbidden++;
            console.log(`${out.pass ? 'pass' : 'FAIL'}  ${fx.id}${runs > 1 ? ` #${r + 1}` : ''}${out.pass ? '' : `\n      ${out.why.join('\n      ')}`}`);
            if (args.includes('--verbose') && !out.pass) console.log(JSON.stringify(out.value ?? null, null, 2));
        }
    }
    const rate = total ? passed / total : 0;
    const ok = rate >= 0.9 && forbidden === 0;
    console.log(`\n${passed}/${total} passed (${Math.round(rate * 100)}%), ${forbidden} with forbidden output. ${ok ? 'Meets' : 'Does not meet'} the bar (90%, no forbidden output).`);
    process.exit(ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
