import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)('playwright');
const { baseURL, page, mock, close } = await startFixture(process.env.ST_DIR, root, chromium, { username: 'Max' });
const readAsset = name => readFileSync(join(root, 'dist', name), 'utf8');
const idle = () => page.waitForFunction(() => window.narratorDirector?.idle(), null, { timeout: 30000 });

async function newGroup(name) {
    const id = await page.evaluate(async (groupName) => {
        const c = SillyTavern.getContext();
        const avatar = name => c.characters.find(character => character.name === name).avatar;
        const narr = avatar('Narrator');
        const mira = avatar('Mira');
        const response = await fetch('/api/groups/create', {
            method: 'POST',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({ name: groupName, members: [narr, mira], disabled_members: [mira], generation_mode: 2,
                activation_strategy: 0, allow_self_responses: false, chat_id: groupName, chats: [groupName] }),
        });
        if (!response.ok) throw new Error(`Group setup failed with HTTP ${response.status}.`);
        const { id } = await response.json();
        const { getGroups, openGroupById } = await import('/scripts/group-chats.js');
        await getGroups();
        await openGroupById(id);
        return id;
    }, name);
    const cancel = page.locator('dialog[open] .popup-button-cancel').last();
    if (await cancel.count()) await cancel.click();
    await page.waitForFunction(({ id, name }) => {
        const c = SillyTavern.getContext();
        return String(c.groupId) === String(id) && c.getCurrentChatId() === name && c.chat.length > 0 && c.chat.every(m => !m.is_user);
    }, { id, name }, { timeout: 30000 });
    await page.evaluate(async () => {
        const c = SillyTavern.getContext();
        c.chatMetadata.scenario = 'A courier visits Mira in a village hall on an ordinary evening.';
        await c.saveMetadata();
    });
    await idle();
}

async function send(input, reply) {
    const previous = await page.evaluate(() => SillyTavern.getContext().chat.length);
    const count = mock.log.length;
    mock.control.narration = reply;
    await page.fill('#send_textarea', input);
    await page.click('#send_but');
    await page.waitForFunction(n => {
        const chat = SillyTavern.getContext().chat;
        return chat.length >= n + 2 && !chat.at(-1).is_user;
    }, previous, { timeout: 30000 });
    await idle();
    const request = mock.log.slice(count).find(row => row.kind === 'narrator');
    assert.ok(request, 'narrator request was captured');
    const saved = await page.evaluate(() => {
        const m = SillyTavern.getContext().chat.at(-1);
        return { text: m.mes, activeSwipe: m.swipes?.[m.swipe_id] };
    });
    return { request, saved };
}

try {
    await page.addInitScript(() => {
        Object.defineProperty(navigator.clipboard, 'writeText', {
            value: async text => { window.testCopiedReply = text; },
        });
    });
    await page.goto(baseURL);
    await page.waitForFunction(() => window.SillyTavern?.getContext && window.narratorDirector && !document.querySelector('#preloader'), null, { timeout: 90000 });
    const main = JSON.parse(readAsset('Narrator Companion (Mature).preset.json')).prompts.find(p => p.identifier === 'main').content;
    await page.evaluate(async ({ main, narrator }) => {
        const c = SillyTavern.getContext();
        c.chatCompletionSettings.prompts.find(p => p.identifier === 'main').content = main;
        const mira = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: {
            name: 'Mira', description: 'Mira is a village clerk. She keeps the seal records at the hall.',
            personality: '', scenario: '', first_mes: '', mes_example: '', alternate_greetings: [], tags: [], extensions: {},
        } });
        for (const [name, json] of [['Narrator', narrator], ['Mira', mira]]) {
            const form = new FormData();
            form.append('avatar', new File([json], `${name}.json`, { type: 'application/json' }));
            form.append('file_type', 'json');
            const headers = c.getRequestHeaders();
            delete headers['Content-Type'];
            const r = await fetch('/api/characters/import', { method: 'POST', headers, body: form });
            if (!r.ok) throw new Error(`Import failed for ${name} (HTTP ${r.status}).`);
        }
        await c.getCharacters();
    }, { main, narrator: readAsset('Narrator.card.json') });

    for (const [label, input, reply] of [
        ['mixed', 'I set the sealed letter on the counter. "Who sent this?"', 'You set the sealed letter on the counter. "Who sent this?" Mira looks at the seal.'],
        ['action', 'I slide the empty cup toward Mira.', 'You slide the empty cup toward Mira. She fills it from the jug.'],
    ]) {
        await newGroup(label);
        const { request, saved } = await send(input, reply);
        assert.deepEqual(request.messages.filter(m => m.role === 'user').map(m => m.content), [input]);
        assert.equal(saved.text, reply);
        if (label === 'action') assert.doesNotMatch(saved.text, /"/);
        console.log(`PASS ${label}: exact player turn reached the model. The scripted reply retained the supplied action${label === 'mixed' ? ' and exact dialogue' : ''}.`);
    }

    await newGroup('Blank code');
    const filled = 'a `wax seal`';
    const raw = `**Mira pauses. \` \` The lamp flickers.**\n\n**Mira: "\` \`" She lowers her eyes.**\n\n"Keep it."\` \` "On the counter."\n"I heard you." \` \` "Say the sentence."\nThe clerk waits. \` \`\n\nShe notices ${filled}.\n\n<bbs_start>Evening</bbs_start>`;
    const cleaned = `**Mira pauses. The lamp flickers.**\n\n**She lowers her eyes.**\n\n"Keep it." "On the counter."\n"I heard you." "Say the sentence."\nThe clerk waits.\n\nShe notices ${filled}.\n\n<bbs_start>Evening</bbs_start>`;
    const { request, saved } = await send('I wait for the clerk.', raw);
    assert.equal(request.response, raw, 'the scripted endpoint sent the same raw reply');
    assert.equal(saved.text, cleaned);
    if (saved.activeSwipe !== undefined) assert.equal(saved.activeSwipe, saved.text);
    const rendered = await page.locator('#chat .mes').last().locator('.mes_text code').allTextContents();
    assert.equal(rendered.filter(text => !text.trim()).length, 0);
    assert.ok(rendered.includes('wax seal'));
    await page.locator('#chat .mes').last().locator('.mes_copy').dispatchEvent('pointerup');
    await page.waitForFunction(() => typeof window.testCopiedReply === 'string');
    assert.equal(await page.evaluate(() => window.testCopiedReply), saved.text);
    const next = await send('I look up.', 'Mira straightens the papers.');
    const history = next.request.messages.filter(m => m.role === 'assistant').map(m => m.content).join('\n');
    assert.doesNotMatch(history, /\x60[ \t]+\x60/);
    assert.ok(history.includes(filled));
    console.log('PASS markup: 5 blank spans removed in save, render, copy, and next prompt. The filled code span survived.');

    const historical = 'Mira: "I heard you." \x60 \x60 "Say the sentence."\n\nShe notices a \x60wax seal\x60.';
    const kept = await page.evaluate((text) => {
        const c = SillyTavern.getContext();
        // Repaint an older group reply with no scoped card rule available.
        c.characters.find(ch => ch.name === 'Narrator').data.extensions.regex_scripts = [];
        const id = c.chat.length - 1;
        c.chat[id].mes = text;
        c.updateMessageBlock(id, c.chat[id]);
        return c.chat[id].mes;
    }, historical);
    assert.equal(kept, historical, 'the rendering hook must leave saved text unchanged');
    const historicalReply = page.locator('#chat .mes').last().locator('.mes_text');
    assert.deepEqual(await historicalReply.locator('code').allTextContents(), ['wax seal']);
    assert.match(await historicalReply.innerText(), /I heard you.*Say the sentence/);
    console.log('PASS historical group markup: removed the blank span at display time without rewriting the reply.');
} finally {
    await close();
}
