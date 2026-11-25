// A deterministic OpenAI-compatible endpoint for end-to-end tests. It plays both models:
// narrator requests get prose, director requests (recognised by their system prompt) get JSON.
// Every request is logged so tests can assert on what the narrator and each module were actually sent.

import http from 'node:http';

export function startMock(port = 8124) {
    const log = [];
    const control = { leak: false, contradict: false, narration: null, delayMs: 0, observerBeat: 'untouched', failObserver: false, failSpine: false, revisedGenre: null, arcGoal: null };
    const paused = new Map();
    let turn = 0;

    function pauseNext(kind) {
        if (paused.has(kind)) throw new Error(`Already holding the next ${kind} response`);
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        paused.set(kind, gate);
        return () => {
            if (paused.get(kind) === gate) paused.delete(kind);
            release();
        };
    }

    const flat = (messages) => messages.map(m => (typeof m.content === 'string' ? m.content : (m.content ?? []).map(p => p.text ?? '').join(''))).join('\n');

    function respond(messages) {
        const sys = flat(messages.filter(m => m.role === 'system'));
        const all = flat(messages);
        if (sys.includes('You keep the record for an interactive story')) {
            if (control.failObserver) return { kind: 'observer', text: 'I cannot comply.' };
            const reply = all.split('## REPLY\n')[1] ?? '';
            const sentences = reply.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 15).slice(0, 4);
            const known = [...all.matchAll(/^- ([A-Z][\w ]+?)(?: \(|$)/gm)].map(m => m[1]);
            const present = [...new Set(['Mira', 'Old Tam', 'Captain Hale'].filter(n => reply.includes(n)))];
            const cast_changes = present.filter(n => !known.includes(n)).map(n => ({ who: n, change: 'introduced', quote: sentences.find(s => s.includes(n)) }));
            const loc = reply.match(/(?:at|in|into|through) (the [A-Z][\w]+(?: [A-Z][\w]+)*)/);
            const out = {
                summary: sentences[0] ?? 'Nothing happened.',
                scene: { present, mood: 'watchful', initiative: 'player', ...(loc ? { location: { value: loc[1], quote: sentences.find(s => s.includes(loc[1])) } } : {}) },
                cast_changes,
                prior_relationships: sentences.filter(s => s.includes('Old Tam has trusted Rowan since the winter floods')).map(quote => ({
                    who: 'Old Tam', toward: 'Rowan', stage: 'familiar', rel: { trust: 6 }, quote,
                })),
                facts: [
                    ...sentences.map(s => ({ fact: s.replace(/[.!?]$/, ''), quote: s, certainty: 'stated', witnesses: 'present' })),
                    { fact: 'The moon is made of cheese', quote: 'this sentence appears nowhere in the reply', certainty: 'stated' },
                ],
                relationships: present.includes('Mira') && /Mira (smiles|thanks|nods)/.test(reply)
                    ? [{ who: 'Mira', toward: 'the player', axis: 'trust', dir: 'up', weight: 'minor', category: 'words', quote: sentences.find(s => s.includes('Mira')) }] : [],
                lore: loc ? [{ keys: [loc[1].replace(/^the /, '')], text: `${loc[1]} is a place in this story.`, kind: 'place', quote: sentences.find(s => s.includes(loc[1])) }] : [],
                contradictions: control.contradict ? [{ quote: sentences[0], conflicts_with: 'Old Tam is dead', correction: 'Old Tam is dead and cannot speak; treat the voice as a memory' }] : [],
                direction: { beat: control.observerBeat, source: 'reply', quote: sentences[0], clues_found: [] },
            };
            return { kind: 'observer', text: '```json\n' + JSON.stringify(out) + '\n```' };
        }
        if (sys.includes('You check a proposed beat outcome')) {
            return { kind: 'observer-check', text: JSON.stringify({ verdicts: [{ id: 'beat', verdict: 'reject', observed: 'Mira hands over a bucket.', reason: 'handling the bucket does not show its taste' }] }) };
        }
        // Modules added after 0.1.0: spine, its check, the tracker and its check, plan check, fact clean-up, conclusions.
        if (sys.includes('You draft the spine of an interactive story')) {
            if (control.failSpine) return { kind: 'spine', text: '{}' };
            return { kind: 'spine', text: JSON.stringify({
                question: 'Will the village learn who poisoned the well before it scatters?',
                endings: [
                    { title: 'The truth out', how: 'the poisoner is named in the square', criteria: [{ text: 'Mira trusts Rowan with what she saw at the well', role: 'she becomes a witness', lasting: true }] },
                    { title: 'The village scatters', how: 'the families leave for the hills', criteria: [{ text: 'Old Tam has given up on the well', role: 'the last elder stops resisting' }] },
                ],
                milestones: [{ title: 'The water is tested', criteria: [{ text: 'someone has shown the well water is bitter', role: 'the poisoning becomes known' }] }],
            }) };
        }
        if (sys.includes('You check a drafted story spine')) return { kind: 'spine-check', text: JSON.stringify({ rewrites: [] }) };
        if (sys.includes('You track the spine of an interactive story')) return { kind: 'tracker', text: JSON.stringify({ readings: [], marks: [], happened: [] }) };
        if (sys.includes('You check marks another reader made')) return { kind: 'tracker-check', text: JSON.stringify({ verdicts: [] }) };
        if (sys.includes('You check beats a planner drafted')) return { kind: 'plan-check', text: JSON.stringify({ rewrites: [] }) };
        if (sys.includes('You tidy the list of established facts')) return { kind: 'cleanup', text: JSON.stringify({ merges: [], retire: [] }) };
        if (sys.includes('You write the conclusion of one milestone')) return { kind: 'conclusion', text: JSON.stringify({ conclusion: 'The water was tested and found bitter.' }) };
        if (sys.includes('Revise the story profile below')) {
            return { kind: 'genre-revision', text: control.revisedGenre ? JSON.stringify(control.revisedGenre) : '{}' };
        }
        if (sys.includes('describe what kind of story it wants to be')) {
            return { kind: 'genre', text: JSON.stringify({ dominant: 'Fantasy', secondary: ['adventure'], register: 'plain, concrete, a little wry', pov: 'second person, present tense', priority: ['player agency', 'character consistency'], stakes: 'the village and its people', lethality: 'real', tempo: 'measured', promises: ['wonder with a cost'], avoid: ['modern slang'], stats_focus: ['agility', 'will'] }) };
        }
        if (sys.includes('compact profile of one character')) {
            const name = all.match(/## Card: (.+)/)?.[1] ?? 'X';
            return { kind: 'profile', text: JSON.stringify({ summary: `${name} in brief.`, stats: { strength: 35, agility: name === 'Mira' ? 66 : 40, endurance: 30, intellect: 45, perception: 50, will: 40, presence: 38 }, temperament: 'proud', tells: { warm: 'teases instead of praising' }, unprompted: 'checks the exits' }) };
        }
        if (sys.includes('outline the arc')) {
            return { kind: 'arc', text: JSON.stringify({ goal: control.arcGoal ?? 'Find out who poisoned the well', forces: ['the miller', 'the drought'], acts: 3, payoff: { name: 'the well runs clear', act: 3, hooks: ['a bitter taste', 'a missing ledger'] }, endings: [{ title: 'The truth out', outcomes: { Mira: 'stays' } }, { title: 'The village scatters', outcomes: { Mira: 'leaves' } }] }) };
        }
        if (sys.includes('You are the planner')) {
            return { kind: 'plan', text: JSON.stringify({ scenes: [{ id: 's1', purpose: 'unease at the well', if_unchallenged: ['the miller buys up the last clean water'], choice_points: ['confront or watch'], focus: { Mira: 'guarded hope' } }], beats: [{ scene: 's1', intent: 'let the bitter taste of the well water be noticed', precondition: 'someone drinks or draws water', type: 'reveal', required: true, lore: ['Greywell'], clues: [{ text: 'a grey film on the bucket', route: 'place', where: 'the well' }] }, { scene: 's1', intent: 'SECRET_SECOND_BEAT the miller makes an offer', precondition: 'the player lingers', type: 'pressure' }], tension: 'rising' }) };
        }
        if (sys.includes('compress the running summary')) return { kind: 'summariser', text: JSON.stringify({ summary: 'ROLLED: the story so far in brief.' }) };
        if (sys.includes('Offer three different premises')) return { kind: 'premises', text: JSON.stringify({ premises: ['A drought year.', 'A stranger arrives.', 'The well goes bitter.'] }) };
        if (sys.includes('Write the opening scene')) return { kind: 'opening', text: 'Dust hangs over the Greywell road as you arrive.' };

        turn++;
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        const said = flat(lastUser ? [lastUser] : []).slice(0, 60).replace(/\s+/g, ' ');
        const tam = control.priorHistory ? 'Old Tam has trusted Rowan since the winter floods.' : 'Old Tam mutters about the bitter water.';
        let text = control.narration ?? `Mira nods toward the well at the Greywell Square as turn ${turn} begins. ${tam} The wind carries dust across the stones.`;
        control.priorHistory = false;
        control.narration = null;
        if (control.leak) text = `<director_notes>\nscene_intent: leaked\n</director_notes>\n${text}`;
        if (control.emptyDialogue) text += '\n\n**Mira: "\x60 <director_notes>Test note</director_notes>\x60 "Thank you." She stepped back. "\x60 <story_context>Test context</story_context>\x60"**';
        control.emptyDialogue = false;
        void said;
        return { kind: 'narrator', text };
    }

    const server = http.createServer(async (req, res) => {
        const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.method === 'GET' && req.url.endsWith('/models')) return send(200, { object: 'list', data: [{ id: 'mock', object: 'model' }] });
        if (req.method === 'GET' && req.url === '/log') return send(200, log);
        let body = '';
        for await (const chunk of req) body += chunk;
        if (req.method === 'POST' && req.url === '/control') { Object.assign(control, JSON.parse(body || '{}')); return send(200, control); }
        if (req.method === 'POST' && req.url === '/reset') { log.length = 0; return send(200, {}); }
        if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
            const data = JSON.parse(body);
            const out = respond(data.messages ?? []);
            log.push({ kind: out.kind, messages: data.messages, at: Date.now(), response: out.text, temperature: data.temperature });
            const gate = paused.get(out.kind);
            if (gate) {
                paused.delete(out.kind);
                await gate;
            }
            if (control.delayMs && out.kind !== 'narrator') await new Promise(r => setTimeout(r, control.delayMs));
            // Director calls through a Connection Manager profile are streamed (since 21 Nov 2026): answer as server-sent events.
            if (data.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
                res.write(chunk({ role: 'assistant', content: '' }));
                for (let i = 0; i < out.text.length; i += 400) res.write(chunk({ content: out.text.slice(i, i + 400) }));
                res.write(chunk({}, 'stop'));
                res.end('data: [DONE]\n\n');
                return;
            }
            return send(200, { id: 'x', object: 'chat.completion', model: 'mock', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: out.text } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        }
        send(404, { error: 'not found' });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve({ server, log, control, pauseNext, port: server.address().port }));
    });
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) startMock(Number(process.argv[2]) || 8124).then(m => console.log(`mock LLM on ${m.port}`));
