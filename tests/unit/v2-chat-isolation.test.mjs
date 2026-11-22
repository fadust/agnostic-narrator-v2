import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { makeCall } from '../../st/call.js';
import { makeHost, narr, replyOf, user } from './helpers.mjs';

function gate() {
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    return { wait, release };
}

for (const lateResult of ['success', 'connection failure']) {
    test(`chat B reads on the same profile while chat A is stalled, then ignores A's late ${lateResult}`, { timeout: 2000 }, async () => {
        const oldReply = narr('The amber lantern lights the old pier.');
        const firstNewReply = narr('The brass compass points toward the harbor.');
        const secondNewReply = narr('The silver bell rings three times at noon.');
        const chat = [user('Go to the old pier.'), oldReply];
        const oldRequest = gate();
        const secondNewRequest = gate();
        const { director, host, state } = makeHost(chat, {
            settings: { profile: 'shared-test-profile', requestTimeoutMs: 5000 },
            async gate(module, messages) {
                if (module !== 'observer') return;
                const reply = replyOf(messages);
                if (reply === oldReply.mes) {
                    await oldRequest.wait;
                    if (lateResult === 'connection failure') throw new Error('socket hang up');
                }
                if (reply === secondNewReply.mes) await secondNewRequest.wait;
            },
        });
        const notices = [];
        host.failed = (module, error) => notices.push([module, error]);
        let newPass;
        const oldPass = director.kick();

        try {
            await setImmediate();
            assert.deepEqual(state.calls.map(call => replyOf(call.messages)), [oldReply.mes]);
            chat.splice(0, chat.length, user('Go to the harbor.'), firstNewReply, user('What do I hear?'), secondNewReply);
            director.reset();
            newPass = director.kick();

            await setImmediate();
            assert.deepEqual(state.calls.filter(call => call.module === 'observer').map(call => replyOf(call.messages)),
                [oldReply.mes, firstNewReply.mes, secondNewReply.mes], 'B must read its replies before A answers');
            assert.ok(firstNewReply.extra.narrator.obs, 'the first B reply was recorded');
            assert.equal(secondNewReply.extra.narrator.obs, undefined, 'the second B request is still pending');
            const firstRecord = structuredClone(firstNewReply.extra.narrator.obs);
            const savesBeforeLateResult = state.saves;

            oldRequest.release();
            await oldPass;
            await setImmediate();
            assert.equal(oldReply.extra.narrator.obs, undefined, 'the discarded reply was not written');
            assert.equal(oldReply.extra.narrator.err, undefined, 'the discarded reply was not marked failed');
            assert.deepEqual(firstNewReply.extra.narrator.obs, firstRecord);
            assert.equal(state.saves, savesBeforeLateResult, 'the stale pass did not flush B’s pending save');
            assert.deepEqual(notices, [], 'the old request did not publish a failure or recovery in B');
            assert.deepEqual(director.errors, []);
            assert.deepEqual(director.failing, {});
            assert.equal(director.emptyRun.observer, undefined, 'the old request did not spend B’s transport retry');
            assert.equal(director.kick(), newPass, 'the old pass did not release B’s single-flight slot');

            secondNewRequest.release();
            await newPass;
            assert.ok(secondNewReply.extra.narrator.obs, 'the second B reply was recorded');
            assert.doesNotMatch(JSON.stringify(director.view().canon), /amber lantern/);
            assert.equal(state.calls.filter(call => call.module === 'observer').length, 3);
        } finally {
            oldRequest.release();
            secondNewRequest.release();
            director.reset();
        }
    });
}

test('an old model result is superseded when the host chat changes before reset', { timeout: 2000 }, async () => {
    let chatKey = 'A';
    const response = gate();
    const started = gate();
    const { director, host, state } = makeHost([]);
    host.chatKey = () => chatKey;
    host.call = () => {
        started.release();
        return response.wait;
    };
    director.reset();

    const result = assert.rejects(director.model('planner', [{ role: 'user', content: 'Plan chat A.' }]), /superseded/);
    try {
        await started.wait;
        chatKey = 'B';
        response.release('answer for A');
        await result;
        assert.deepEqual(director.usage, {}, 'A’s call did not change usage for the newly active chat');
        assert.equal(state.saves, 0);
    } finally {
        response.release();
        director.reset();
    }
});

for (const source of ['material', 'memoryStory']) {
    test(`late ${source} from chat A does not start a model request in B`, { timeout: 2000 }, async () => {
        const chat = [user('Plan the crossing from the old pier.')];
        const sourceRead = gate();
        const sourceResult = gate();
        const { director, host, state } = makeHost(chat, { settings: { memory: 'extension' } });
        host[source] = () => {
            sourceRead.release();
            return sourceResult.wait;
        };
        const result = source === 'material' ? director.ensureGenre(true) : director.maybePlan('Plan the crossing.');
        try {
            await sourceRead.wait;
            chat.splice(0, chat.length, user('Choose a route to the new harbor.'));
            director.reset();
            const chatBefore = structuredClone(chat);
            const oldMaterial = 'The old pier is a deserted trading post with a ruined lighthouse and a sealed passage.';
            sourceResult.release(source === 'material' ? oldMaterial : { text: oldMaterial });

            assert.equal(await result, false);
            assert.deepEqual(state.calls, [], 'stale inputs did not reach the model');
            assert.deepEqual(chat, chatBefore);
            assert.equal(state.saves, 0);
            assert.deepEqual(director.errors, []);
        } finally {
            sourceResult.release();
            director.reset();
        }
    });
}

for (const transport of ['current connection', 'Connection Manager stream']) {
    test(`${transport} deadline is a transient, role-specific failure and releases the queue`, { timeout: 2000 }, async () => {
        const calls = [];
        const partial = gate();
        const stalled = gate();
        const profile = transport === 'current connection' ? '' : 'shared-test-profile';
        const settings = { profile, requestTimeoutMs: 40 };
        const { director, host } = makeHost([], { settings });
        const ctx = {
            generateRaw() {
                calls.push('current connection');
                if (calls.length > 1) return 'next answer';
                partial.release();
                return stalled.wait;
            },
            ConnectionManagerRequestService: {
                async sendRequest(actualProfile, messages, maxTokens, options) {
                    assert.equal(actualProfile, profile);
                    assert.equal(options.stream, true);
                    calls.push('Connection Manager stream');
                    if (calls.length > 1) return { content: 'next answer' };
                    return async function* () {
                        yield { text: '{' };
                        partial.release();
                        await stalled.wait;
                        yield { text: '{"stale":true}' };
                    };
                },
            },
        };
        host.call = makeCall({ getContext: () => ctx, getSettings: () => settings });
        const messages = [{ role: 'user', content: 'Read this reply.' }];
        let watchdog;
        const bound = new Promise((resolve, reject) => {
            watchdog = setTimeout(() => reject(new Error(`${transport} never released the stalled request`)), 750);
        });
        const request = director.model('observer', messages);
        try {
            await assert.rejects(Promise.race([request, bound]), error => {
                assert.match(String(error.message), /observer/i);
                assert.match(String(error.message), /timed?\s*out|timeout|deadline/i);
                assert.equal(error.transient, true);
                return true;
            });
            await partial.wait;
            assert.deepEqual(calls, [transport], 'the stalled request was sent once');
            assert.equal(await Promise.race([director.model('planner', messages), bound]), 'next answer');
            assert.deepEqual(calls, [transport, transport]);
        } finally {
            clearTimeout(watchdog);
            stalled.release('late answer');
            director.reset();
        }
    });
}
