import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCommand, parseControl } from '../core/router';
import { voiceCommands } from '../core/prompts';

test('every command card example routes to its own command', () => {
    for (const c of voiceCommands) {
        assert.equal(detectCommand(c.example).command.id, c.id, `"${c.example}" should route to ${c.id}`);
    }
});

test('specific commands beat generic explain words', () => {
    assert.equal(detectCommand('what are the security risks here').command.id, 'security');
    assert.equal(detectCommand('how can I make this faster').command.id, 'optimize');
    assert.equal(detectCommand('what is wrong with this, there is a bug').command.id, 'debug');
});

test('stems match word variants but not unrelated words', () => {
    assert.equal(detectCommand('Optimise it please').command.id, 'optimize');
    assert.equal(detectCommand('add some documentation').command.id, 'document');
    assert.equal(detectCommand('explain the latest changes').command.id, 'explain'); // "latest" must not match "test"
});

test('unknown phrases fall back to explain', () => {
    assert.equal(detectCommand('banana').command.id, 'explain');
    assert.equal(detectCommand('').command.id, 'explain');
});

test('parseControl recognises navigation phrases', () => {
    assert.equal(parseControl('next'), 'next');
    assert.equal(parseControl('Okay, next step please.'), 'next');
    assert.equal(parseControl('go back'), 'back');
    assert.equal(parseControl('say that again'), 'repeat');
    assert.equal(parseControl('Make it simpler'), 'simpler');
    assert.equal(parseControl('go deeper'), 'deeper');
    assert.equal(parseControl('stop'), 'stop');
});

test('parseControl leaves real questions alone', () => {
    assert.equal(parseControl('why does normalize lowercase the keys'), null);
    assert.equal(parseControl('what happens next in the loop when the list is empty'), null);
    assert.equal(parseControl(''), null);
});
