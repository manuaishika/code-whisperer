import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basisLabel, basisSpoken, MAX_STEPS, numberLines, parseWalkthrough, stepText } from '../core/walkthrough';

const step = (over: Record<string, unknown> = {}) => ({
    title: 'T',
    simple: 'short',
    detailed: 'longer text',
    deep: 'extra',
    startLine: 1,
    endLine: 2,
    basis: 'read',
    ...over
});

test('numberLines prefixes 1-based numbers', () => {
    assert.equal(numberLines('a\nb'), '1| a\n2| b');
});

test('parses a clean reply', () => {
    const w = parseWalkthrough(JSON.stringify({ overview: 'O', steps: [step()] }), 10);
    assert.equal(w.overview, 'O');
    assert.equal(w.steps.length, 1);
    assert.deepEqual([w.steps[0].startLine, w.steps[0].endLine, w.steps[0].basis], [1, 2, 'read']);
});

test('tolerates code fences and chatter around the JSON', () => {
    const body = JSON.stringify({ overview: 'O', steps: [step()] });
    assert.equal(parseWalkthrough('Sure! Here you go:\n```json\n' + body + '\n```\nHope that helps.', 10).steps.length, 1);
    assert.equal(parseWalkthrough('Here: ' + body, 10).steps.length, 1);
});

test('clamps line ranges into the selection and orders them', () => {
    const w = parseWalkthrough(JSON.stringify({ steps: [step({ startLine: -5, endLine: 999 }), step({ startLine: 8, endLine: 3 })] }), 10);
    assert.deepEqual([w.steps[0].startLine, w.steps[0].endLine], [1, 10]);
    assert.deepEqual([w.steps[1].startLine, w.steps[1].endLine], [8, 8]);
});

test('anything but an explicit "read" is labelled inferred', () => {
    const w = parseWalkthrough(JSON.stringify({ steps: [step({ basis: 'verified!!' }), step({ basis: undefined }), step()] }), 10);
    assert.deepEqual(w.steps.map(s => s.basis), ['inferred', 'inferred', 'read']);
});

test('drops unusable steps and caps the count', () => {
    const many = Array.from({ length: 30 }, () => step());
    assert.equal(parseWalkthrough(JSON.stringify({ steps: many }), 10).steps.length, MAX_STEPS);
    const mixed = parseWalkthrough(JSON.stringify({ steps: [null, 'x', { title: 'no text' }, step()] }), 10);
    assert.equal(mixed.steps.length, 1);
});

test('rejects replies with nothing usable', () => {
    for (const bad of ['', 'no json here', '{"steps": []}', '{"steps": [{"title": "x"}]}', '[1,2,3]', '{broken']) {
        assert.throws(() => parseWalkthrough(bad, 10), /usable walkthrough/, bad);
    }
});

test('model text is flattened and length-limited, not trusted as markup', () => {
    const w = parseWalkthrough(JSON.stringify({ overview: 'a\n\n b', steps: [step({ title: 'x'.repeat(500), simple: '<img src=x onerror=1>' })] }), 5);
    assert.equal(w.overview, 'a b');
    assert.equal(w.steps[0].title.length, 80);
    assert.equal(w.steps[0].simple, '<img src=x onerror=1>'); // kept as text; the UI only ever uses textContent
});

test('stepText: deep adds to detailed, simple stays short, missing fields fall back', () => {
    const s = parseWalkthrough(JSON.stringify({ steps: [step()] }), 5).steps[0];
    assert.equal(stepText(s, 'simple'), 'short');
    assert.equal(stepText(s, 'detailed'), 'longer text');
    assert.equal(stepText(s, 'deep'), 'longer text extra');
    const onlySimple = parseWalkthrough(JSON.stringify({ steps: [step({ detailed: undefined, deep: undefined })] }), 5).steps[0];
    assert.equal(stepText(onlySimple, 'deep'), 'short');
});

test('basis wording', () => {
    assert.equal(basisLabel('read'), 'Read in code');
    assert.equal(basisLabel('inferred'), 'Inferred');
    assert.match(basisSpoken('inferred'), /inference/);
    assert.equal(basisSpoken('read'), '');
});
