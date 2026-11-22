// Round 13 (package audit, 22 Nov 2026): streaming guard, plan ids after a reload, one save per pass.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { initialState, applyOp } from '../../core/state.js';
import { makeHost, narr, user } from './helpers.mjs';

test('the two presets own their content guidance and work without Director rating variables', () => {
    const read = file => JSON.parse(readFileSync(new URL(`../../dist/${file}`, import.meta.url), 'utf8'));
    const prompt = preset => preset.prompts.find(p => p.identifier === 'main').content;
    const pg = read('Narrator Companion (PG).preset.json');
    const mature = read('Narrator Companion (Mature).preset.json');
    assert.match(prompt(pg), /general-audience.*all the story's genres/);
    assert.doesNotMatch(prompt(pg), /NSFW|NSFL|Adult Content/);
    assert.match(prompt(mature), /NSFW and NSFL material can appear/);
    assert.match(prompt(mature), /graphic violence/);
    for (const preset of [pg, mature]) {
        assert.equal(preset.openai_max_tokens, 1500);
        assert.doesNotMatch(prompt(preset), /nar_pg|nar_explicit|preset_pg|\{\{if/);
    }
    assert.doesNotMatch(JSON.stringify(read('Narrator.card.json')), /nar_pg|nar_explicit|NSFW and NSFL|## Boundaries/);
});

test('P1: the newest reply is not read while the narrator is still writing it', () => {
    const chat = [user('x'), narr('Ji Si waits beneath the arch tonight, half writ')];
    const { director, host } = makeHost(chat);
    host.generating = () => true;
    director.sync();
    assert.equal(director.nextUnread(), null);
    host.generating = () => false;
    assert.equal(director.nextUnread()?.i, 1);
});

test('plan ids never repeat, even when a plan number does', () => {
    const s = initialState({ player: 'Max' });
    s.genre = { dominant: 'drama' };
    applyOp(s, { kind: 'plan', by: 'director', seq: 0, value: { beats: [{ scene: 's1', goal: 'a', type: 'reveal' }] } }, { mid: 'same0000' }, []);
    s.beats[0].status = 'complete';
    applyOp(s, { kind: 'plan', by: 'director', seq: 0, value: { beats: [{ scene: 's1', goal: 'b', type: 'reveal' }] } }, { mid: 'same0000' }, []);
    const ids = s.beats.map(b => b.id);
    assert.equal(new Set(ids).size, ids.length, ids.join(' '));
});

test('a background pass saves the chat once at its end, not after every step', async () => {
    const chat = [narr('The story opens at the gate of Houshan.'), user('x'), narr('Ji Si waits beneath the arch tonight.'), user('y'), narr('The bell rings twice over the yard.')];
    const { director, state } = makeHost(chat);
    const before = state.saves;
    await director.kick();
    assert.ok(state.saves - before <= 2, `saves in one pass: ${state.saves - before}`);
});
