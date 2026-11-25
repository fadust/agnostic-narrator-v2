import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseDirectorCommand } from '../../st/commands.js';

test('direction prose can begin with an action name without dispatching it', () => {
    for (const text of [
        'rewrite the ending darker',
        'rewrite',
        'opening with a quiet conversation would be good',
        'profile the keep from the water',
        'scene returns to the harbor',
        'off we go into the mist',
        'pg tone would work well here',
        'explicit about what the crew saw',
        'unsetTle the watch captain',
        'revise the names to match the charter',
    ]) {
        assert.deepEqual(parseDirectorCommand(text), { key: 'instruction', rest: text });
    }
});

test('the documented argument forms select their intended action', () => {
    const forms = [
        ['checkplan', 'checkplan', ''],
        ['Scene: location=the harbor; mood=quiet', 'scene', 'location=the harbor; mood=quiet'],
        ['beats: one; two', 'beats', 'one; two'],
        ['rewrite: let the crew decide', 'rewrite', 'let the crew decide'],
        ['retcon: the burnt pier', 'retcon', 'the burnt pier'],
        ['pg off', 'pg', 'off'],
        ['explicit on', 'explicit', 'on'],
        ['explicit: no', 'explicit', 'no'],
        ['settle the argument over the pilot’s fee', 'settle', 'the argument over the pilot’s fee'],
        ['unsettle 2', 'unsettle', '2'],
        ['revise genre keep the quiet register', 'revise', 'genre keep the quiet register'],
        ['revise: plan let the tide go out first', 'revise', 'plan let the tide go out first'],
    ];
    for (const [text, key, rest] of forms) assert.deepEqual(parseDirectorCommand(text), { key, rest });
    for (const text of ['pg: off to sea', 'explicit: about the watch', 'unsettle: the captain', 'revise: the names']) {
        assert.deepEqual(parseDirectorCommand(text), { key: 'instruction', rest: text });
    }
});

test('every shipped quick reply still selects its Director action', () => {
    const file = new URL('../../dist/Narrator Director.quickreplies.json', import.meta.url);
    const { qrList } = JSON.parse(readFileSync(file, 'utf8'));
    const expected = {
        Inspect: ['inspect', ''],
        'Re-plan': ['replan', ''],
        'Story profile': ['profile', ''],
        Opening: ['opening', ''],
        'Dump state': ['dump', ''],
    };
    assert.deepEqual(qrList.map(reply => reply.label).sort(), Object.keys(expected).sort());
    for (const reply of qrList) {
        const text = reply.message.split(' | ')[0].replace(/^\/director\s*/, '');
        const [key, rest] = expected[reply.label];
        assert.deepEqual(parseDirectorCommand(text), { key, rest });
    }
    assert.deepEqual(parseDirectorCommand(''), { key: 'inspect', rest: '' });
});
