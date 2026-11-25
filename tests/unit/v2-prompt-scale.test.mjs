import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStoryBlock } from '../../core/brief.js';
import { initialState } from '../../core/state.js';
import { stripTags } from '../../core/text.js';
import { roughTokens, similarity } from '../../core/util.js';
import { memoryGaps, memoryStory, registerMemoryProvider } from '../../st/providers.js';

test('the emitted story block obeys its estimate and preserves higher-priority context', () => {
    const state = initialState({ player: 'Rowan' });
    state.premise = 'Rowan is looking for the missing ledger before the tide turns.';
    state.genre = { dominant: 'fantasy', pg: true, explicit: false, pov: 'second person', lethality: 'low' };
    state.scene.present = ['Mira'];
    state.cast.Mira = { appearance: 'Mira has a scar on her left hand.' };
    state.tombstones = [{ fact: 'The keel struck the reef' }];
    state.summaries.rolled = 'At the old quay, Rowan found no sign of the ledger and asked around. '.repeat(85);
    const cast = [{
        name: 'Mira', full: '[Mira] A pilot who keeps a red compass in her coat.', short: 'Mira is a pilot.',
    }, ...Array.from({ length: 24 }, (_, i) => ({
        name: `Away crew ${i}`, full: '', short: `Away background ${i}. ${'The old tide chart was copied by hand. '.repeat(8)}`,
    }))];
    const tokenCap = 260;
    const result = buildStoryBlock(state, { cast, firstIncluded: 100, tokenCap });

    assert.ok(result.tokens <= tokenCap, `estimated ${result.tokens} tokens for a ${tokenCap}-token cap`);
    assert.equal(result.tokens, roughTokens(result.text));
    assert.equal(result.overflow, true, 'the inspector can report that optional context was shortened');
    assert.match(result.text, /^<story_context>\n[\s\S]+\n<\/story_context>$/);
    assert.match(result.text, /genre: fantasy/);
    assert.doesNotMatch(result.text, /rating:\s*PG/i);
    assert.match(result.text, /red compass/);
    assert.match(result.text, /scar on her left hand/);
    assert.match(result.text, /The keel struck the reef/);
    assert.doesNotMatch(result.text, /Away background 23/);
});

test('story context below its budget does not report omission', () => {
    const state = initialState({ player: 'Rowan' });
    state.premise = 'Rowan returns to the harbor.';
    const result = buildStoryBlock(state, { tokenCap: 1200 });
    assert.equal(result.overflow, false);
    assert.match(result.text, /Rowan returns to the harbor/);
    assert.equal(result.tokens, roughTokens(result.text));
});

test('planner and prompt resolve the same registered memory provider without awaiting its story in the prompt path', async t => {
    const oldHost = globalThis.SillyTavern;
    globalThis.SillyTavern = { getContext: () => ({ substituteParams: macro => macro }) };
    t.after(() => {
        if (oldHost === undefined) delete globalThis.SillyTavern;
        else globalThis.SillyTavern = oldHost;
    });
    let storyCalls = 0;
    registerMemoryProvider({
        id: 'fixture-unavailable', available: () => false,
        story: () => { throw new Error('an unavailable provider was selected'); },
        gaps: () => { throw new Error('an unavailable provider was selected'); },
    });
    registerMemoryProvider({
        id: 'fixture-shared-coverage',
        async story() { storyCalls++; return { text: 'The earlier arrival is covered.', missing: [23], source: 'Fixture memory' }; },
        gaps: () => [23],
    });

    for (const memoryProvider of ['auto', 'fixture-shared-coverage']) {
        assert.deepEqual(memoryGaps({ memoryProvider }), [23]);
    }
    assert.equal(storyCalls, 0);
    assert.equal((await memoryStory({ memoryProvider: 'auto' })).source, 'Fixture memory');
    assert.equal(storyCalls, 1);

    const state = initialState({ player: 'Rowan' });
    state.summaries.recent = [
        { i: 21, text: 'They arrive at the gates.' },
        { i: 23, text: 'They catch the departing boat.' },
    ];
    const known = buildStoryBlock(state, { memory: 'extension', unsummarised: memoryGaps({ memoryProvider: 'auto' }) });
    assert.match(known.text, /departing boat/);
    assert.doesNotMatch(known.text, /arrive at the gates/);

    const stories = () => ({ text: 'Fallback record.' });
    registerMemoryProvider({ id: 'fixture-unknown-gaps', story: stories });
    registerMemoryProvider({ id: 'fixture-async-gaps', story: stories, gaps: async () => [23] });
    registerMemoryProvider({ id: 'fixture-invalid-gaps', story: stories, gaps: () => '23' });
    for (const memoryProvider of ['fixture-unknown-gaps', 'fixture-async-gaps', 'fixture-invalid-gaps']) {
        const unknown = memoryGaps({ memoryProvider });
        assert.equal(unknown, null);
        const result = buildStoryBlock(state, { memory: 'extension', unsummarised: unknown });
        assert.match(result.text, /arrive at the gates/);
        assert.match(result.text, /departing boat/);
    }
});

test('a reworded Chinese fact can match a retcon without matching unrelated text', () => {
    const original = '李明烧掉了那封信';
    const reworded = '那封信被李明烧掉了';
    const unrelated = '李明明天要到市场买雨伞';
    assert.ok(similarity(original, reworded) >= 0.7);
    assert.ok(similarity(original, unrelated) < 0.7);
    assert.equal(similarity('Mira found the brass compass', 'Mira lost the brass compass'), 4 / 6);
});

test('historical reads only use providers that return the requested cutoff', async t => {
    const previous = globalThis.STBaiBaiBook;
    t.after(() => {
        if (previous === undefined) delete globalThis.STBaiBaiBook;
        else globalThis.STBaiBaiBook = previous;
    });
    const requests = [];
    globalThis.STBaiBaiBook = { getHistory: options => {
        requests.push(options);
        return { before: 4, text: 'The captain arrived before reply four.' };
    } };
    registerMemoryProvider({ id: 'unbounded-for-history-test', story: () => {
        throw new Error('unbounded provider must not be called for a historical read');
    } });
    registerMemoryProvider({ id: 'bounded-for-history-test', supportsBefore: true,
        story: ({ before }) => ({ before, text: 'An earlier note from a registered provider.' }) });
    assert.equal((await memoryStory({ memoryProvider: 'baibai' }, { before: 4 })).text, 'The captain arrived before reply four.');
    assert.equal(await memoryStory({ memoryProvider: 'baibai' }, { before: 5 }), null);
    assert.deepEqual(requests, [{ before: 4 }, { before: 5 }]);
    assert.equal(await memoryStory({ memoryProvider: 'unbounded-for-history-test' }, { before: 4 }), null);
    assert.equal(await memoryStory({ memoryProvider: 'macro', memoryMacro: 'summary' }, { before: 4 }), null);
    assert.equal((await memoryStory({ memoryProvider: 'bounded-for-history-test' }, { before: 6 })).before, 6);
});

test('a configured dotted tag is matched literally and leaves similar named tags intact', () => {
    const text = 'Before\n<STORY.NOTES roll="1">private notes</story.notes>\n<storyXnotes>Keep this story text.</storyXnotes><story.notes/>\nAfter';
    const result = stripTags(text, ['story.notes']);
    assert.equal(result, 'Before\n\n<storyXnotes>Keep this story text.</storyXnotes>\nAfter');
});
