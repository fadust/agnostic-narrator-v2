// Third round (18 November 2026): narrator lines only for turns BaiBai Book has not summarised; the open issues from
// live play (the card's embellish rule, invented scenery in conclusions, unweighed off-screen outcomes).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { buildStoryBlock } from '../../core/brief.js';
import { CONCLUSION_SYSTEM, conclusionPrompt } from '../../core/prompts.js';
import { logOp, reconcile, replay, visibleText } from '../../core/state.js';
import { hash } from '../../core/util.js';
import { cleanDialogue, stripDirector } from '../../core/text.js';
import { NARRATOR, narr, user } from './helpers.mjs';

function chatWithSummaries() {
    const chat = [user('start')];
    for (let i = 0; i < 4; i++) chat.push(narr(`Reply ${i}.`), user(`p${i}`));
    reconcile(chat, NARRATOR);
    chat.forEach((m, i) => { if (!m.is_user) m.extra.narrator.obs = { hash: hash(visibleText(m)), delta: { summary: `summary ${i}` }, accepted: 1, rejected: [] }; });
    return chat;
}

test('with another extension, the narrator gets the director\'s line only for turns that extension has not summarised', () => {
    const s = replay(chatWithSummaries(), { narrator: NARRATOR, setup: { player: 'Rowan' } });
    const block = (unsummarised) => buildStoryBlock(s, { memory: 'extension', firstIncluded: 99, unsummarised }).text;
    assert.match(block([7]), /The last turns, in brief:\n- summary 7\n/);
    assert.doesNotMatch(block([7]), /summary 5/, 'a turn the extension has summarised is left to it');
    assert.doesNotMatch(block([]), /The last turns/, 'everything summarised: no lines');
    assert.match(block(null), /- summary 5\n- summary 7/, 'the extension cannot tell: the last 2');
    assert.doesNotMatch(block([1, 3]), /The last turns/, 'only the last 2 turns are ever candidates');
});

test('the card says embellishing changes how it is done, never what is done', () => {
    const card = fs.readFileSync(new URL('../../card/src/description.md', import.meta.url), 'utf8');
    assert.match(card, /enhance, enrich and embellish/);
    assert.match(card, /changes how it is done/);
    assert.match(card, /no extra action, gift, payment, promise, plan or line of speech/);
});

test('the conclusion writer gets the scene and failure reasons, and may not invent scenery', () => {
    const milestone = { title: 'First trust', criteria: [{ text: 'she trusts him', mark: 'failed', quote: 'She turns away.', reason: 'she left town for good' }] };
    const u = conclusionPrompt({ milestone, player: 'Max', genre: {}, scene: 'the market square' })[1].content;
    assert.match(u, /## Scene\nthe market square/);
    assert.match(u, /\(why: she left town for good\)/);
    assert.match(CONCLUSION_SYSTEM, /no place, room, object, weather or scenery unless a quote or the scene line names it/);
});

test('a planned off-screen outcome is weighed major, also once confirmed', () => {
    const chat = [user('start'), narr('The road is quiet.'), user('next')];
    reconcile(chat, NARRATOR);
    chat[1].extra.narrator.obs = { hash: hash(visibleText(chat[1])), delta: { summary: 's' }, accepted: 1, rejected: [] };
    logOp(chat[1], { kind: 'plan', by: 'director', value: { scenes: [{ id: 's1', purpose: 'p' }], beats: [{ scene: 's1', intent: 'i', type: 'reveal' }], outcomes: ['The sheriff rode north overnight.'] }, reason: 't', seq: 0 });
    const s = replay(chat, { narrator: NARRATOR, setup: { player: 'Rowan' } });
    const o = s.uncertain.find(f => f.offscreen);
    assert.ok(o, 'outcome recorded');
    assert.equal(o.weight, 'major');
});

test('a stray closing tag is removed without gluing the paragraphs around it', () => {
    assert.equal(stripDirector('Prose one.</director_notes>\nProse two.'), 'Prose one.\nProse two.');
    assert.equal(stripDirector('Prose one. </director_notes>   Prose two.'), 'Prose one. Prose two.');
});

test('blank code and quote prefixes are removed from speaker lines without changing the speech', () => {
    const dialogue = '**Elizabeth: "Thank you." She turned away.**';
    assert.equal(cleanDialogue('**Elizabeth: "\x60 \x60 "Thank you." She turned away.**'), dialogue);
    assert.equal(cleanDialogue('**Elizabeth: " "Thank you." She turned away.**'), dialogue);
    assert.equal(cleanDialogue(dialogue), dialogue);
    const genuine = '**Elizabeth:** " " She let the pause linger.\nThe example used "\x60 \x60 " in an empty field.';
    assert.equal(cleanDialogue(genuine), genuine);
});

test('empty quotes after a finished sentence are removed while the dialogue and bold markers survive', () => {
    const action = 'The courier folded the letter and left it on the desk.';
    const dialogue = 'Mira: "Wait for me at the gate." Her voice dropped.';
    assert.equal(cleanDialogue(`**${action} ""**\r\n\r\n**${dialogue} ""&#x20;**`), `**${action}**\r\n\r\n**${dialogue}**`);
    assert.equal(cleanDialogue(`${action} "\x60 \x60 "\n${dialogue} "\x60 \x60 "`), `${action}\n${dialogue}`);
    const ordinary = 'Bianca: "Thank you."\nThe field contains "".\nThe value is ""\n"I left," she said.';
    assert.equal(cleanDialogue(ordinary), ordinary);
});

test('the note stripper removes quoted code wrappers and keeps actual dialogue, spaces and bold', () => {
    const wrappedNote = '\x60 <director_notes>Test note</director_notes>\x60';
    const prefix = `**Mira: "${wrappedNote} "Thank you."**`;
    const suffix = `**The courier folded the letter. "${wrappedNote}"**`;
    const context = '\x60 <story_context>Test context</story_context> \x60';
    assert.equal(stripDirector(prefix), '**Mira: "Thank you."**');
    assert.equal(stripDirector(suffix), '**The courier folded the letter.**');
    assert.equal(stripDirector(`Mira paused. “${context}” "Thank you."`), 'Mira paused. "Thank you."');
    assert.equal(stripDirector(`"${wrappedNote}"\nNext line.`), 'Next line.');
    assert.equal(stripDirector('Mira said "keep \`this\`."'), 'Mira said "keep \`this\`."');
    assert.equal(stripDirector(`"Thank you."\nNext line. "${wrappedNote}"\r\nLast line.`), '"Thank you."\nNext line.\r\nLast line.');
});

test('BaiBai Book item and variable blocks are removed before the director reads a reply', async () => {
    const { stripTags, parseTags } = await import('../../core/text.js');
    const tags = parseTags('bbs_start, bbs_end, bbs_items, bbs_vars, bbi_image');
    const reply = '<bbs_start>1420/4/12 09:43</bbs_start>\n\nHe slides the writ across.\n<bbs_items>\nGained Amended forfeit writ 1\n</bbs_items>\n<bbs_vars>\nSet trust 2\n</bbs_vars>';
    assert.equal(stripTags(reply, tags), 'He slides the writ across.');
});

test('adding tags to the strip list keeps records read with the earlier list', async () => {
    const { scan } = await import('../../core/state.js');
    const before = { ...NARRATOR, strip: ['bbs_start', 'bbs_end', 'bbi_image'] };
    const after = { ...NARRATOR, strip: ['bbs_start', 'bbs_end', 'bbs_items', 'bbs_vars', 'bbi_image'] };
    const chat = [user('go'), narr('<bbs_start>t</bbs_start>\nHe slides the writ across.\n<bbs_items>\nGained writ 1\n</bbs_items>'), user('next'), narr('Another reply.')];
    reconcile(chat, before);
    // A record from before records said which list they used (the old default), and one that says it.
    chat[1].extra.narrator.obs = { hash: hash(visibleText(chat[1], before)), delta: { summary: 'a' }, accepted: 1, rejected: [] };
    chat[3].extra.narrator.track = { covers: [{ mid: chat[1].narrator_id, hash: hash(visibleText(chat[1], { strip: ['bbs_start', 'bbs_end'] })) }], delta: { readings: [] }, rejected: [], strip: ['bbs_start', 'bbs_end'] };
    assert.equal(reconcile(chat, after).stale.length, 0, 'nothing voided by the longer list');
    const e = scan(chat, after)[1];
    assert.ok(e.valid, 'observer record still stands');
    assert.ok(e.tracked, 'tracker batch read with its own list still stands');
    assert.equal(e.text, 'He slides the writ across.');
});
