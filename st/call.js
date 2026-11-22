// The director's model calls through SillyTavern (moved out of index.js, audit map 22 Nov 2026, so it can be tested
// with a fake context). Streaming, the no-streaming fallback and the temperature fallback live here.

const PLANNING_MODULES = new Set(['planner', 'opening']);

/**
 * @param {{getContext: () => object, getSettings: () => object}} deps SillyTavern's context and the extension settings.
 * @returns {(module: string, messages: object[], maxTokens: number, signal?: AbortSignal) => Promise<string>}
 */
export function makeCall({ getContext, getSettings }) {
    // Profiles whose connection refused a temperature, or a streamed request: they get plain requests from then on.
    const tempRefused = new Set();
    const noStream = new Set();
    return async function call(module, messages, maxTokens, signal) {
        signal?.throwIfAborted();
        const c = getContext();
        const settings = getSettings();
        // A check call ('tracker-check', 'planner-check') runs on its parent role's profile and temperature.
        const role = String(module).replace(/-check$/, '');
        const profile = settings.profiles?.[role] || settings.profile;
        if (profile) {
            // Streamed (owner, 21 Nov 2026): a slow thinking model sends nothing for a minute without streaming, and the
            // connection is cut ("socket hang up"). A stream keeps it alive. A profile that refuses streaming falls back.
            const streams = !noStream.has(profile);
            const opts = { stream: streams, signal, extractData: true, includePreset: true, includeInstruct: true };
            const collect = async (r) => {
                if (typeof r !== 'function') return r;
                let content = '', reasoning = '';
                for await (const chunk of r()) {
                    signal?.throwIfAborted();
                    content = chunk?.text ?? content;
                    reasoning = chunk?.state?.reasoning ?? reasoning;
                }
                return { content, reasoning };
            };
            // A thinking model can spend the whole answer limit thinking and return no answer. Say so: retrying the same
            // call with the same limit would only fail again.
            const answer = (r) => {
                const text = r?.content ?? '';
                if (!String(text).trim() && String(r?.reasoning ?? '').trim()) {
                    throw Object.assign(new Error(`${module}: the model spent its whole answer limit (${maxTokens} tokens) thinking and wrote no answer. Raise this module's answer limit, or give it a model that thinks less.`), { invalidAnswer: true });
                }
                return text;
            };
            const request = async (payload, o) => {
                signal?.throwIfAborted();
                const response = await c.ConnectionManagerRequestService.sendRequest(profile, messages, maxTokens, o, payload);
                signal?.throwIfAborted();
                const result = await collect(response);
                signal?.throwIfAborted();
                return answer(result);
            };
            const send = async (payload) => {
                if (!streams) return request(payload, opts);
                try {
                    return await request(payload, opts);
                } catch (e) {
                    signal?.throwIfAborted();
                    // Under streaming a refusal arrives only as "Got response status 4xx", with the reason lost (audit,
                    // 21 Nov 2026). Ask once without streaming: that answer carries the provider's own message, which the
                    // temperature fallback reads. A profile that then works without streaming stays off it.
                    const why = `${e?.message} ${e?.cause?.message ?? ''}`;
                    if (/\b40[123]\b|\b429\b|unauthori[sz]ed|forbidden|quota|rate limit/i.test(why)) throw e;
                    if (!/stream|response status 4\d\d/i.test(why)) throw e;
                    const r = await request(payload, { ...opts, stream: false });
                    noStream.add(profile);
                    return r;
                }
            };
            // The director sets its own temperature, so it does not depend on how the profile's preset was saved.
            const temperature = PLANNING_MODULES.has(role) ? settings.tempPlan : settings.tempRecord;
            if (!settings.setTemps || tempRefused.has(profile)) return await send({});
            try {
                return await send({ temperature });
            } catch (e) {
                signal?.throwIfAborted();
                // Some reasoning models accept only their default temperature. Stop sending it to that profile.
                if (!/temperature/i.test(`${e?.message} ${e?.cause?.message} ${JSON.stringify(e?.cause ?? '')}`)) throw e;
                tempRefused.add(profile);
                return await send({});
            }
        }
        // No director profile chosen: use the current connection. Works, but shares the narrator's sampler settings.
        return await c.generateRaw({ prompt: messages, responseLength: maxTokens });
    };
}
