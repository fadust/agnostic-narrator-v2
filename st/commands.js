// Bare phrases remain story directions. Only recognized complete forms invoke a command.
const bare = new Set(['on', 'off', 'inspect', 'profile', 'confirm', 'replan', 'rollup', 'track', 'spine',
    'redraft', 'opening', 'setup', 'retry', 'dump', 'suggest', 'unsettle', 'pg', 'explicit']);
const prompts = new Set(['scene', 'beats', 'rewrite', 'retcon', 'replan']);

export function parseDirectorCommand(text) {
    const input = String(text ?? '').trim();
    if (!input) return { key: 'inspect', rest: '' };
    const [, word, separator, rest = ''] = input.match(/^(\w+)(\s*:\s*|\s+)([\s\S]*)$/) ?? [];
    const key = String(word ?? input).toLowerCase();
    if (!word && bare.has(key)) return { key, rest: '' };
    if (separator?.includes(':') && prompts.has(key)) return { key, rest };
    if (((key === 'pg' || key === 'explicit') && /^(on|off|no|yes|true|false|0|1)$/i.test(rest))
        || (key === 'settle' && rest)
        || (key === 'unsettle' && /^\d+$/.test(rest))
        || (key === 'revise' && /^(genre|plan)\s+\S/i.test(rest))) return { key, rest };
    return { key: 'instruction', rest: input };
}
