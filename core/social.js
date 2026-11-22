// Stats and relationships become words here. No number, rank letter or score ever leaves this file toward the narrator.

import { BANDS, STAGES, STATS, STAT_BASELINE } from './enums.js';
import { bandOf, stanceBand } from './state.js';
import { nameKey } from './util.js';

/** Fallback tells when a character's card gives none: temperament x band. */
export const TEMPERAMENT_TELLS = {
    reserved: ['cold and brief; leaves when able', 'polite, closed, watches before answering', 'civil, gives little away', 'stays near; small unprompted kindnesses', 'quietly constant; says the hard thing gently'],
    warm: ['hurt more than angry; withdraws warmth pointedly', 'friendly on the surface, careful underneath', 'easy and open', 'generous with time and attention', 'openly protective; shares everything'],
    proud: ['contemptuous; needles and dismisses', 'stiff, tests for weakness', 'courteous as between equals, no more', 'teases instead of praising; stays close', 'defends the player to others; admits fault to them alone'],
    playful: ['mockery with an edge', 'jokes to keep distance', 'light, curious', 'includes the player in every scheme', 'drops the act when it matters; fiercely loyal'],
    stern: ['openly obstructive', 'correct, exacting, unforgiving of slips', 'fair and businesslike', 'gruff approval; gives real responsibility', 'trusts the player with what matters most'],
    timid: ['avoids the player; flinches', 'answers in few words, eyes down', 'shy but willing', 'seeks the player out; talks more freely', 'brave for the player\'s sake'],
};

const HIGH = {
    strength: 'strong, hits hard', agility: 'quick and hard to track', endurance: 'tireless', intellect: 'sharp, thinks ahead',
    perception: 'misses little', will: 'hard to shake', presence: 'commanding, hard to refuse',
};
const VERY_HIGH = {
    strength: 'immensely strong', agility: 'blindingly fast', endurance: 'all but inexhaustible', intellect: 'brilliant',
    perception: 'uncannily observant', will: 'unbreakable', presence: 'overwhelming presence',
};
const LOW = {
    strength: 'physically weak', agility: 'slow and clumsy', endurance: 'tires fast', intellect: 'slow to work things out',
    perception: 'unobservant', will: 'easily cowed', presence: 'easily overlooked',
};
const COMPARE = {
    strength: ['stronger than', 'hits harder'], agility: ['quicker than', 'is quicker'], endurance: ['outlasts', 'outlasts them'],
    intellect: ['out-thinks', 'out-thinks them'], perception: ['notices more than', 'notices more'],
    will: ['steadier than', 'is steadier'], presence: ['more commanding than', 'is more commanding'],
};

const effective = (c, stat) => {
    let v = c?.stats?.[stat] ?? STAT_BASELINE;
    for (const s of c?.statuses ?? []) {
        if (s.affects === stat || (!s.affects && s.severity !== 'mild')) v -= s.severity === 'critical' ? 20 : s.severity === 'serious' ? 12 : 5;
    }
    return v;
};

export function statPhrase(stat, value) {
    if (value >= 85) return VERY_HIGH[stat];
    if (value >= 60) return HIGH[stat];
    if (value < 24) return LOW[stat];
    return null;
}

/** Stand-out abilities, best first. */
export function standouts(c, max = 2) {
    if (!c?.stats) return [];
    return STATS.map(s => ({ s, v: c.stats[s] }))
        .filter(x => statPhrase(x.s, x.v))
        .sort((a, b) => Math.abs(b.v - 45) - Math.abs(a.v - 45))
        .slice(0, max)
        .map(x => statPhrase(x.s, x.v));
}

export function statusPhrase(c) {
    return (c?.statuses ?? []).map(s => {
        const sev = s.severity === 'mild' ? '' : `${s.severity} `;
        const trend = s.trend === 'worsening' ? ', worsening untreated' : s.trend === 'easing' ? ', easing' : s.treated ? ', treated' : '';
        return `${sev}${s.name}${trend}`;
    }).join('; ');
}

export function tellsFor(c, band) {
    if (c?.tells?.[band]) return c.tells[band];
    const table = TEMPERAMENT_TELLS[c?.temperament] ?? TEMPERAMENT_TELLS.reserved;
    return table[BANDS.indexOf(band)];
}

/** Relationship line for one NPC toward the player. `full` adds tells, extras and abilities. */
export function castLine(state, name, full = true) {
    const c = state.cast[name];
    if (!c) return null;
    const player = state.meta.player || 'the player';
    const band = bandOf(c.rel);
    let line = `- ${name}, toward ${player}: ${band}`;
    const stage = STAGES.indexOf(c.stage) > 0 ? c.stage : '';
    if (!full) return stage ? `${line} (${stage})` : line;
    const extras = [stage, tellsFor(c, band)].filter(Boolean);
    if (c.rel.tension >= 4) extras.push('strained right now');
    if (c.rel.desire >= 4) extras.push('drawn to them');
    line += ` (${extras.join('; ')})`;
    const so = standouts(c);
    if (so.length) line += `; ${so.join(', ')}`;
    const st = statusPhrase(c);
    if (st) line += `; ${st}`;
    const stances = Object.entries(c.stances ?? {})
        .filter(([other, score]) => state.scene.present.includes(other) && stanceBand(score) !== 'neutral')
        .map(([other, score]) => `${stanceBand(score)} toward ${other}`);
    if (stances.length) line += `; ${stances.join(', ')}`;
    return line;
}

/** What the player character can do, in words. */
export function pcLine(state) {
    const name = state.meta.player;
    const c = state.cast[name];
    if (!c?.stats) return null;
    const parts = standouts(c, 3);
    const weak = STATS.filter(s => c.stats[s] < 24).map(s => LOW[s]);
    const st = statusPhrase(c);
    const bits = [];
    if (parts.length) bits.push(parts.join(', '));
    else bits.push('no stand-out abilities; an ordinary person\'s limits apply');
    if (weak.length && !parts.some(p => weak.includes(p))) bits.push(`weak points: ${weak.join(', ')}`);
    if (st) bits.push(`now ${st}`);
    return `- ${name}: ${bits.join('; ')}`;
}

/** Pairwise comparisons on one stat between the PC and each present NPC with stats. */
export function comparisons(state, stat) {
    const pcName = state.meta.player;
    const pc = state.cast[pcName];
    if (!pc?.stats) return [];
    const out = [];
    for (const n of state.scene.present) {
        const c = state.cast[n];
        if (!c?.stats) continue;
        const diff = effective(pc, stat) - effective(c, stat);
        if (diff >= 8) out.push(`${pcName} ${COMPARE[stat][0]} ${n}`);
        else if (diff <= -8) out.push(`${n} ${COMPARE[stat][1]}`);
        else out.push(`${pcName} and ${n} are evenly matched in ${stat}`);
    }
    return out;
}

// Verb stems that make the governing stat unambiguous. Anything not listed yields no tier, which is the safe failure.
const VERBS = {
    agility: /\b(run|runs|ran|sprint|dash|dodge|vault|leap|jump|sneak|slip past|outrun|outpace|chase|flee|evade|climb)/i,
    strength: /\b(lift|shove|push|force|break|wrestle|grapple|overpower|pin|punch|strike|smash|drag|hold (him|her|them) down)/i,
    presence: /\b(persuade|convince|charm|intimidate|threaten|bluff|lie to|deceive|command|order|seduce|negotiate|haggle)/i,
    perception: /\b(search|spot|notice|track|watch for|listen for|read (his|her|their) (face|expression)|scan)/i,
    intellect: /\b(decipher|solve|deduce|out-?think|out-?wit|recall|work out|analy[sz]e)/i,
    will: /\b(resist|stare down|hold (my|his|her|their) ground|endure the|refuse to yield)/i,
    endurance: /\b(outlast|keep going|march|hold (my|his|her) breath|push through)/i,
};

// Verbs that can only mean a contest with someone. The broader list above also matches everyday actions
// ("I order a drink from Bianca", "I run a hand through her hair"), so it counts only after "try to" or "attempt to".
const CONTEST = {
    agility: /\b(outrun|outpace|dodge|evade|slip past)/i,
    strength: /\b(overpower|wrestle|grapple|tackle|disarm|pin (him|her|them)|shove)/i,
    presence: /\b(persuade|convince|intimidate|bluff|deceive|seduce|haggle with|lie to)/i,
    intellect: /\b(out-?think|out-?wit|outsmart)/i,
    will: /\b(stare down|defy)/i,
    endurance: /\b(outlast)/i,
};
const TRYING = /\b(try|tries|trying|attempt|attempts|attempting)\b[^.!?]{0,30}$/i;

/** Which stats the message clearly puts to the test against someone. */
function contested(text) {
    return STATS.filter(s => {
        if (CONTEST[s]?.test(text)) return true;
        const m = VERBS[s]?.exec(text);
        return !!m && TRYING.test(text.slice(0, m.index));
    });
}

/**
 * An attempt tier is emitted only when the stat, the opponent and both sets of stats are all clear.
 * @returns {{stat: string, opponent: string, tier: string, line: string} | null}
 */
export function detectAttempt(message, state) {
    const text = String(message ?? '');
    const pcName = state.meta.player;
    const pc = state.cast[pcName];
    if (!text || !pc?.stats) return null;
    const hits = contested(text);
    if (hits.length !== 1) return null;
    const stat = hits[0];
    const key = nameKey(text);
    const opponents = state.scene.present.filter(n => state.cast[n]?.stats && nameKey(n).split(' ').some(p => p.length > 2 && new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(key)));
    if (opponents.length !== 1) return null;
    const opponent = opponents[0];
    const diff = effective(pc, stat) - effective(state.cast[opponent], stat);
    const tier = diff >= 15 ? 'trivial' : diff >= 0 ? 'a strain' : diff > -15 ? 'risky' : 'beyond';
    const meaning = {
        trivial: 'succeeds easily', 'a strain': 'succeeds at a cost', risky: 'may fail; success costs dearly',
        beyond: 'fails, or needs help or a different approach',
    }[tier];
    return { stat, opponent, tier, line: `attempt: ${stat} against ${opponent} is ${tier} for ${pcName} (${meaning})` };
}

export const detectExchange = (message) => {
    const hits = STATS.filter(s => VERBS[s]?.test(String(message ?? '')));
    if (!hits.length) return null;
    const physical = ['agility', 'strength', 'endurance'];
    return { stat: hits[0], kind: physical.includes(hits[0]) ? 'physical' : hits[0] === 'presence' ? 'social' : 'mental' };
};
