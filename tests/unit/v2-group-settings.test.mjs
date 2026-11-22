import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeGroupSettings, saveGroupSettings } from '../../st/group.js';

const SWAP = 0;
const JOIN = 2;
const NARRATOR = 'narrator.png';
const MIRA = 'mira.png';
const HALE = 'hale.png';
const current = () => true;

function makeSaves(initial = {}) {
    let stored = { id: 'group', chat_id: 'A', chats: ['A'], name: 'The Harbor', generation_mode: SWAP,
        disabled_members: [NARRATOR, HALE], members: [MIRA, NARRATOR, HALE], ...initial };
    let group = structuredClone(stored);
    const writes = [];
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture-token' };
    const openManager = () => makeGroupSettings({
        getGroup: id => id === group.id ? group : undefined,
        saveGroup: data => saveGroupSettings(data, headers, async (url, options) => {
            assert.equal(url, '/api/groups/edit');
            assert.equal(options.method, 'POST');
            assert.deepEqual(options.headers, headers);
            writes.push(JSON.parse(options.body));
            if (creation.fail) return { ok: false, status: 500 };
            stored = writes.at(-1);
            return { ok: true, json: async () => ({ ok: true }) };
        }),
    });
    const creation = {
        writes, fail: false,
        group: () => group,
        stored: () => stored,
        manager: openManager(),
        openSiblingAfterReload() {
            stored = { ...stored, chat_id: 'B', chats: ['A', 'B'] };
            group = structuredClone(stored);
            return openManager();
        },
    };
    return creation;
}

test('Setup and Off restore exact Swap mode and original mutes across sibling chats and reload', async () => {
    const saves = makeSaves();
    const initial = structuredClone(saves.group());
    const { manager } = saves;
    await manager.apply('group', { modeFor: () => JOIN, current });
    assert.equal(saves.stored().generation_mode, JOIN);
    assert.deepEqual(saves.stored().disabled_members, initial.disabled_members, 'automatic mode control did not mute anyone');

    await manager.apply('group', { modeFor: () => JOIN, narratorAvatar: NARRATOR, current });
    assert.deepEqual(saves.stored().disabled_members, [MIRA, HALE]);
    await manager.apply('group', { modeFor: () => JOIN, narratorAvatar: NARRATOR, current });
    assert.equal(saves.writes.length, 2, 'repeated Setup left the original snapshot intact');

    const reopened = saves.openSiblingAfterReload();
    await reopened.restore('group', { current });
    assert.deepEqual(saves.stored(), { ...initial, chat_id: 'B', chats: ['A', 'B'] });
    assert.deepEqual(saves.group(), saves.stored());
    assert.equal(saves.writes.length, 3);
});

test('automatic mode management leaves mutes it never owned alone when disabled', async () => {
    const saves = makeSaves({ generation_mode: JOIN });
    const { manager } = saves;
    await manager.apply('group', { modeFor: () => SWAP, current });
    saves.group().disabled_members = [MIRA];
    await manager.restore('group', { current });
    assert.equal(saves.stored().generation_mode, JOIN);
    assert.deepEqual(saves.stored().disabled_members, [MIRA]);
});

test('a failed restore leaves the group and restoration data available for retry', async () => {
    const saves = makeSaves();
    const { manager } = saves;
    await manager.apply('group', { modeFor: () => JOIN, narratorAvatar: NARRATOR, current });
    const managed = structuredClone(saves.group());

    saves.fail = true;
    await assert.rejects(manager.restore('group', { current }), /HTTP 500/);
    assert.deepEqual(saves.group(), managed);
    assert.deepEqual(saves.stored(), managed);

    saves.fail = false;
    await manager.restore('group', { current });
    assert.equal(saves.stored().generation_mode, SWAP);
    assert.deepEqual(saves.stored().disabled_members, [NARRATOR, HALE]);
});

test('a legacy saved mode is restored without guessing the old mute list', async () => {
    const saves = makeSaves({ generation_mode: JOIN, disabled_members: [MIRA, HALE] });
    await saves.manager.restore('group', { legacyMode: SWAP, current });
    assert.equal(saves.stored().generation_mode, SWAP);
    assert.deepEqual(saves.stored().disabled_members, [MIRA, HALE]);
});
