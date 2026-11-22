// Public state mirrored into chat variables. Private state (beats, clues, beliefs, canon) never goes here,
// because any macro or /listvar can read variables.

import { BANDS } from './enums.js';
import { bandOf } from './state.js';
import { slug } from './util.js';

export const VAR_OBJECT = 'nar';
export const FLAG_PREFIX = 'nar_';

/**
 * @returns {{nar: object, flags: Record<string, string>}} `nar` for Tavern Helper style object reads,
 * `flags` as flat variables for SillyTavern's own {{if .flag}} gating.
 */
export function publicVars(state) {
    const g = state.genre ?? {};
    const trust = {};
    for (const n of state.scene.present) {
        const c = state.cast[n];
        if (c && !c.pc) trust[n] = bandOf(c.rel);
    }
    const tension = state.arc?.tension ?? 'low';
    const nar = {
        active: true,
        genre: g.dominant ?? '',
        secondary: g.secondary ?? [],
        register: g.register ?? '',
        pov: g.pov ?? '',
        tempo: g.tempo ?? '',
        lethality: g.lethality ?? '',
        mood: state.scene.mood,
        location: state.scene.location.established ? state.scene.location.value : '',
        time: state.scene.time.established ? state.scene.time.value : '',
        present: [...state.scene.present],
        tension,
        trust,
    };
    const flags = { nar_active: '1' };
    for (const name of [g.dominant, ...(g.secondary ?? [])].filter(Boolean)) flags[`nar_genre_${slug(name)}`] = '1';
    if (g.dominant) flags.nar_genre = g.dominant;
    if (g.lethality) flags[`nar_lethality_${slug(g.lethality)}`] = '1';
    if (g.tempo) flags[`nar_tempo_${slug(g.tempo)}`] = '1';
    flags[`nar_tension_${slug(tension)}`] = '1';
    for (const [n, band] of Object.entries(trust)) {
        flags[`nar_trust_${slug(n)}_${band}`] = '1';
        // Coarse bands for lore that only cares about "high" or "low".
        const at = BANDS.indexOf(band);
        if (at >= 3) flags[`nar_trust_${slug(n)}_high`] = '1';
        if (at <= 1) flags[`nar_trust_${slug(n)}_low`] = '1';
    }
    if (nar.mood) flags.nar_mood = nar.mood;
    if (nar.location) flags.nar_location = nar.location;
    return { nar, flags };
}

/** Apply to a variables object (chat_metadata.variables). Removes flags that no longer hold. Returns true when changed. */
export function writeVars(variables, { nar, flags }) {
    let changed = false;
    for (const k of Object.keys(variables)) {
        if (k.startsWith(FLAG_PREFIX) && !(k in flags)) { delete variables[k]; changed = true; }
    }
    for (const [k, v] of Object.entries(flags)) {
        if (variables[k] !== v) { variables[k] = v; changed = true; }
    }
    const json = JSON.stringify(nar);
    if (JSON.stringify(variables[VAR_OBJECT]) !== json) { variables[VAR_OBJECT] = JSON.parse(json); changed = true; }
    return changed;
}

export function clearVars(variables) {
    let changed = false;
    for (const k of Object.keys(variables)) {
        if (k.startsWith(FLAG_PREFIX) || k === VAR_OBJECT) { delete variables[k]; changed = true; }
    }
    return changed;
}
