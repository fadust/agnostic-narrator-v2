import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeObserver, makeHost, narr, replyOf, user } from './helpers.mjs';

const INTRO = {
    Mira: 'Mira, the harbor pilot, marks the shoals with a steady hand.',
    Hale: 'Hale, the keeper of the beacon, carries two tins of lamp oil.',
    Oren: 'Oren, a broad-shouldered smith, hammers a hinge for the gate.',
};

const validProfile = name => ({ name, summary: `${name} knows the harbor well.`, stats: { agility: 65 } });

function profileFixture(t, { names = Object.keys(INTRO), loreNames = ['Mira', 'Hale'], cards = [], maxRetries = 2 } = {}) {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const lore = loreNames.map(name => ({ keys: [name], comment: name, content: INTRO[name] }));
    const firstReply = narr(names.map(name => INTRO[name]).join(' '));
    const chat = [firstReply, user('I wait by the gate.')];
    const { director, host } = makeHost(chat, {
        settings: { maxRetries },
        script(module, messages) {
            const reply = replyOf(messages);
            return {
                ...fakeObserver(reply),
                cast_changes: names.filter(name => reply.includes(INTRO[name])).map(name => ({
                    who: name, change: 'introduced', quote: INTRO[name],
                })),
            };
        },
    });
    host.cards = async () => cards;
    host.loreEntries = () => lore;
    const calls = [];
    const notices = [];
    const call = host.call;
    const control = { respond: validProfile };
    host.call = async (module, messages, ...rest) => {
        if (module !== 'profile') return call(module, messages, ...rest);
        const prompt = messages[1].content;
        const name = prompt.match(/^## (?:Card|Story notes): (.+)$/m)?.[1];
        assert.ok(name, 'the profile request identifies the candidate');
        calls.push({ name, prompt });
        return JSON.stringify(control.respond(name));
    };
    host.failed = (module, warning) => {
        if (module === 'profile') notices.push(warning);
    };
    t.after(() => director.reset());
    return { director, chat, lore, firstReply, calls, notices, control, advance: (ms = 181_000) => { now += ms; } };
}

test('an unusable first lore profile keeps its warning without blocking later lore and story profiles', async (t) => {
    const { director, lore, calls, notices, control, advance } = profileFixture(t);
    control.respond = name => name === 'Mira' ? { name } : validProfile(name);

    await director.kick();
    assert.deepEqual(calls.map(call => call.name), ['Mira', 'Hale', 'Oren']);
    assert.equal(director.view().cast.Mira.stats, null);
    assert.equal(director.view().cast.Hale.stats.agility, 65);
    assert.equal(director.view().cast.Oren.stats.agility, 65);
    assert.deepEqual(director.failing.profile?.characters, ['Mira']);
    assert.ok(notices.every(Boolean), 'another candidate succeeding did not report recovery');

    advance();
    await director.kick();
    advance();
    await director.kick();
    assert.deepEqual(calls.map(call => call.name), ['Mira', 'Hale', 'Oren', 'Mira'], 'Mira stops at the existing cap');
    for (const call of calls.filter(call => call.name === 'Mira')) assert.match(call.prompt, /^## Card: Mira$/m);
    assert.deepEqual(director.failing.profile?.characters, ['Mira']);

    lore[0].content += ' Mira charted a new channel through the harbor yesterday.';
    control.respond = validProfile;
    advance();
    await director.kick();
    assert.deepEqual(calls.map(call => call.name), ['Mira', 'Hale', 'Oren', 'Mira', 'Mira']);
    assert.match(calls.at(-1).prompt, /charted a new channel/);
    assert.equal(director.view().cast.Mira.stats.agility, 65);
    assert.equal(director.failing.profile, undefined);
    assert.equal(notices.filter(warning => !warning).length, 1, 'only Mira’s successful retry reported recovery');
});

test('new prose does not refill a story-only profile budget, while Retry and reset do', async (t) => {
    const { director, chat, calls, control, advance } = profileFixture(t, { names: ['Oren'], loreNames: [], maxRetries: 1 });
    control.respond = name => ({ name });
    await director.kick();
    assert.deepEqual(director.failing.profile?.characters, ['Oren']);

    chat.push(narr('Oren sets his hammer down and fetches a fresh pair of tongs.'), user('I help.'));
    advance();
    await director.kick();
    assert.equal(calls.length, 1, 'another description of Oren does not grant more attempts');
    await director.retry();
    assert.equal(calls.length, 2, 'manual Retry immediately tried Oren again');
    assert.match(calls.at(-1).prompt, /fresh pair of tongs/);
    assert.deepEqual(director.failing.profile?.characters, ['Oren']);

    director.reset();
    assert.equal(director.failing.profile, undefined, 'warning state lives in the active session');
    control.respond = validProfile;
    await director.kick();
    assert.equal(calls.length, 3, 'a fresh session has a fresh retry budget');
    assert.equal(director.view().cast.Oren.stats.agility, 65);
});

test('edits to selected cards and personas reset only their own attempts', async (t) => {
    const persona = { name: 'Rowan', text: 'Rowan is a cartographer with years of surveying the coast.', isPlayer: true };
    const card = { name: 'Mira', text: 'Mira keeps a painted map of every safe landing on the island.' };
    const { director, calls, notices, control, advance } = profileFixture(t, {
        names: ['Mira', 'Oren'], loreNames: ['Mira'], cards: [persona, card], maxRetries: 1,
    });
    control.respond = name => name === 'Oren' ? validProfile(name) : { name };
    await director.kick();
    assert.deepEqual(calls.map(call => call.name), ['Rowan', 'Mira', 'Oren']);
    assert.match(calls[1].prompt, /painted map/, 'the authored card is selected before the lore entry');
    assert.deepEqual(director.failing.profile?.characters, ['Rowan', 'Mira']);
    advance();
    await director.kick();
    assert.equal(calls.length, 3, 'no fallback to lore or story after the selected card reaches its cap');

    card.text += ' Mira also keeps a log of high tides.';
    control.respond = validProfile;
    advance();
    await director.kick();
    assert.deepEqual(calls.map(call => call.name), ['Rowan', 'Mira', 'Oren', 'Mira']);
    assert.match(calls.at(-1).prompt, /high tides/);
    assert.deepEqual(director.failing.profile?.characters, ['Rowan']);
    assert.ok(notices.every(Boolean), 'the other character’s failure remains open');

    persona.text += ' Rowan can identify an inlet by the sound of its surf.';
    advance();
    await director.kick();
    assert.deepEqual(calls.map(call => call.name), ['Rowan', 'Mira', 'Oren', 'Mira', 'Rowan']);
    assert.match(calls.at(-1).prompt, /sound of its surf/);
    assert.equal(director.failing.profile, undefined);
    assert.equal(notices.filter(warning => !warning).length, 1);
});

const SHARED_FAILURES = [
    ['connection drop', 'socket hang up'],
    ['credential refusal', 'Got response status 401: Unauthorized', 401],
    ['quota refusal', 'Got response status 429: Insufficient quota', 429],
];

for (const [kind, message, status] of SHARED_FAILURES) {
    test(`${kind} pauses remaining profiles without consuming the failed character’s attempt`, async (t) => {
        const cards = [{ name: 'Rowan', text: 'Rowan is a cartographer who has spent years surveying the coast.', isPlayer: true }];
        const { director, calls, control, advance } = profileFixture(t, { cards, maxRetries: 1 });
        control.respond = () => { throw Object.assign(new Error(message), { status }); };
        await director.kick();
        await director.kick();
        assert.deepEqual(calls.map(call => call.name), ['Rowan'], 'the outage stopped the queue and applied a shared cooldown');
        assert.equal(director.view().cast.Hale.stats, null);

        control.respond = validProfile;
        advance();
        await director.kick();
        assert.deepEqual(calls.map(call => call.name), ['Rowan', 'Rowan', 'Mira', 'Hale', 'Oren']);
        assert.equal(director.view().cast.Rowan.stats.agility, 65, 'Rowan still had an attempt after the shared outage');
        assert.equal(director.failing.profile, undefined);
    });
}

test('swiping out the introduction quietly removes the failed profile warning', async (t) => {
    const { director, firstReply, calls, notices, control, advance } = profileFixture(t, { names: ['Mira'], maxRetries: 1 });
    control.respond = name => ({ name });
    await director.kick();
    assert.deepEqual(director.failing.profile?.characters, ['Mira']);

    firstReply.mes = 'The waves shatter against the stone pier and wash it clean.';
    advance();
    await director.kick();
    assert.equal(director.view().cast.Mira, undefined);
    assert.equal(director.failing.profile, undefined);
    assert.deepEqual(calls.map(call => call.name), ['Mira']);
    assert.ok(notices.every(Boolean), 'a discarded character did not announce successful recovery');
});
