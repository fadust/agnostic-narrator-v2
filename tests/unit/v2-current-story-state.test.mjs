import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONCLUSION_SYSTEM } from '../../core/prompts.js';
import { logOp } from '../../core/state.js';
import { makeHost, narr, replyOf, user } from './helpers.mjs';

const FIRST_SIGN = 'Mira lets Rowan steer the boat past the first buoy.';
const SECOND_SIGN = 'Mira gives Rowan the pilot’s chart and watches him choose the next heading.';
const CONCLUSION = 'Mira came to trust Rowan with the passage through the shoals.';
const CRITERION = 'm1-c1';

async function completeMilestone(reverse = false) {
    const first = narr(FIRST_SIGN);
    const second = narr(SECOND_SIGN);
    const chat = [user('I offer to help steer.'), first, user('I bring the bow around.'), second, user('I keep us on course.')];
    logOp(chat[0], { by: 'setup', kind: 'spine', value: {
        question: 'Will Mira trust Rowan with the crossing?', endings: [],
        milestones: [{ id: 'm1', title: 'Earn the pilot’s trust', status: 'open', criteria: [
            { id: CRITERION, text: 'Mira trusts Rowan to steer the crossing', mark: 'open', lasting: true },
            ...(reverse ? [{ id: 'm1-c2', text: 'The harbourmaster fixes the pilot’s licence', mark: 'open' }] : []),
        ] }],
    } });
    logOp(second, { by: 'player', kind: 'edit', path: 'scene.mood', value: 'tense' });
    const { director, host } = makeHost(chat, { settings: { trackEvery: 2 } });
    const call = host.call;
    const evidenceChecks = [];
    const conclusionRequests = [];
    host.call = async (module, messages, ...rest) => {
        if (module === 'tracker') {
            const quotes = [{ exchange: 1, quote: FIRST_SIGN }, { exchange: 2, quote: SECOND_SIGN }];
            if (reverse) quotes.reverse();
            return JSON.stringify({
                marks: [{ id: CRITERION, mark: 'met', evidence: 'shown', ...quotes[0], also: quotes[1] }],
                happened: [{ milestone: 'm1', exchange: 1, quote: FIRST_SIGN }],
            });
        }
        if (module === 'tracker-check') {
            evidenceChecks.push(messages.at(-1).content);
            return JSON.stringify({ verdicts: [{ id: CRITERION, verdict: 'confirm' }, { id: 'm1', verdict: 'confirm' }] });
        }
        if (module === 'summariser' && messages[0].content.startsWith(CONCLUSION_SYSTEM)) {
            conclusionRequests.push(messages);
            return JSON.stringify({ conclusion: CONCLUSION });
        }
        return call(module, messages, ...rest);
    };
    await director.kick();
    return { chat, director, first, second, evidenceChecks, conclusionRequests };
}

const milestone = (director, options) => director.view(options).spine.milestones[0];
const conclusions = reply => (reply.extra.narrator.ops ?? []).filter(op => op.kind === 'conclusion');

test('a lasting criterion and conclusion take effect on the second supporting reply', async () => {
    const { chat, director, first, second, evidenceChecks, conclusionRequests } = await completeMilestone();
    const beforeSecondReply = milestone(director, { upto: chat.indexOf(second) });
    assert.equal(beforeSecondReply.status, 'open');
    assert.equal(beforeSecondReply.criteria[0].mark, 'open');
    assert.equal(conclusions(first).length, 0);
    assert.equal(conclusions(second).length, 1);
    assert.equal(milestone(director).conclusion, CONCLUSION);
    assert.equal(evidenceChecks.length, 1);
    assert.ok(evidenceChecks[0].includes(FIRST_SIGN) && evidenceChecks[0].includes(SECOND_SIGN), 'the checker received both quotes');
    await director.kick();
    assert.equal(conclusionRequests.length, 1, 'a repeated pass does not write another conclusion');

    const { director: reloaded } = makeHost(structuredClone(chat));
    assert.equal(milestone(reloaded).conclusion, CONCLUSION);
    const { director: branch } = makeHost(structuredClone(chat.slice(0, chat.indexOf(second))));
    assert.equal(milestone(branch).status, 'open');
    assert.equal(milestone(branch).criteria[0].mark, 'open');
});

test('a tracker that lists the later quote first still waits for the second supporting reply', async () => {
    const { chat, director, first, second } = await completeMilestone(true);
    assert.equal(milestone(director, { upto: chat.indexOf(second) }).status, 'open');
    assert.equal(conclusions(first).length, 0);
    assert.equal(conclusions(second).length, 1);
});

for (const changedSupport of ['first', 'second']) {
    test(`editing the ${changedSupport} supporting reply invalidates a lasting conclusion`, async () => {
        const { chat, director, first, second } = await completeMilestone();
        assert.equal(milestone(director).conclusion, CONCLUSION);
        (changedSupport === 'first' ? first : second).mes = 'Mira studies a distant storm and keeps both hands on the tiller.';
        director.sync();
        const state = director.view();
        assert.equal(state.spine.milestones[0].status, 'open');
        assert.equal(state.spine.milestones[0].criteria[0].mark, 'open');
        assert.notEqual(state.spine.milestones[0].conclusion, CONCLUSION);
        assert.equal(state.scene.mood, 'tense', 'the player operation stays in force');

        const { director: reloaded } = makeHost(structuredClone(chat));
        assert.equal(milestone(reloaded).status, 'open', 'saved records cannot restore the invalid conclusion');
    });
}

function selectSwipe(message, index) {
    message.swipe_info[message.swipe_id].extra = structuredClone(message.extra);
    message.swipe_id = index;
    message.mes = message.swipes[index];
    message.extra = structuredClone(message.swipe_info[index].extra);
}

test('inactive swipe records are purged and selecting an old swipe reads it anew', async () => {
    const initial = 'The pilot hauls a red flag to the top of the mast.';
    const alternate = 'The pilot hangs a green lamp from the forecastle.';
    const reply = narr(initial);
    const firstImage = { image: 'red-flag.png', caption: 'Red flag' };
    const secondImage = { image: 'green-lamp.png', caption: 'Green lamp' };
    reply.extra.illustration = firstImage;
    reply.swipes = [initial, alternate];
    reply.swipe_id = 0;
    reply.swipe_info = [
        { send_date: 'before noon', extra: { illustration: firstImage } },
        { send_date: 'after noon', extra: { illustration: secondImage } },
    ];
    const chat = [user('What signal do we use?'), reply, user('I watch for the signal.')];
    const { director, state } = makeHost(chat);
    await director.kick();
    assert.ok(reply.extra.narrator.obs);
    logOp(reply, { by: 'player', kind: 'edit', path: 'scene.mood', value: 'tense' });
    const playerOps = structuredClone(reply.narrator_ops);
    const id = reply.narrator_id;

    selectSwipe(reply, 1);
    director.sync();
    assert.deepEqual(reply.swipe_info[0], { send_date: 'before noon', extra: { illustration: firstImage } });
    assert.deepEqual(reply.extra.illustration, secondImage);
    assert.doesNotMatch(JSON.stringify(director.view().canon), /red flag/);
    await director.kick();
    assert.match(JSON.stringify(director.view().canon), /green lamp/);

    selectSwipe(reply, 0);
    director.sync();
    assert.equal(reply.narrator_id, id);
    assert.deepEqual(reply.narrator_ops, playerOps);
    assert.deepEqual(reply.swipe_info[1], { send_date: 'after noon', extra: { illustration: secondImage } });
    assert.deepEqual(reply.extra.illustration, firstImage);
    assert.equal(reply.extra.narrator?.obs, undefined);
    assert.doesNotMatch(JSON.stringify(director.view().canon), /red flag|green lamp/);
    await director.kick();

    assert.deepEqual(state.calls.filter(call => call.module === 'observer').map(call => replyOf(call.messages)), [initial, alternate, initial]);
    const current = director.view();
    assert.match(JSON.stringify(current.canon), /red flag/);
    assert.doesNotMatch(JSON.stringify(current.canon), /green lamp/);
    assert.equal(current.scene.mood, 'tense');
});
