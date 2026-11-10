import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    findTrails,
    isSafeRelativePath,
    parseTrail,
    proofSpoken,
    stepText,
    stopForLocation,
    trailSummary
} from '../core/crumbs';

const fixture = fs.readFileSync(path.join(__dirname, '..', '..', 'test-fixtures', 'example-trail.json'), 'utf8');

test('parses the real crumbs example trail', () => {
    const t = parseTrail(fixture);
    assert.equal(t.issue, '42');
    assert.match(t.plainTitle, /dateFormat/);
    assert.equal(t.story.length, 7); // 1+1+3+1+1 steps flattened
    assert.equal(t.stops.length, 4);
    assert.ok(t.aiPolicy?.text.includes('disclose'));
    assert.equal(t.story[0].proof, 'reproduced-isolated');
});

test('steps keep their code location and highlight', () => {
    const t = parseTrail(fixture);
    const withCode = t.story.find(s => s.code?.file === 'src/config.js' && s.code.highlight.length > 0);
    assert.ok(withCode);
    assert.ok(withCode.code!.lines.includes('toLowerCase'));
});

test('stepText: deep adds to detailed, simple stays short', () => {
    const t = parseTrail(fixture);
    const step = t.story[0];
    assert.equal(stepText(step, 'simple'), step.simple);
    assert.equal(stepText(step, 'detailed'), step.detailed);
    assert.equal(stepText(step, 'deep'), `${step.detailed} ${step.deep}`);
});

test('stopForLocation finds the covering stop', () => {
    const t = parseTrail(fixture);
    const stop = t.stops[1];
    assert.equal(stopForLocation(t, stop.file, stop.start)?.id, stop.id);
    assert.equal(stopForLocation(t, 'nope.js', 1), undefined);
});

test('trailSummary mentions problem and the stop', () => {
    const t = parseTrail(fixture);
    const s = trailSummary(t, t.stops[0]);
    assert.match(s, /Issue 42/);
    assert.match(s, /Problem:/);
    assert.match(s, /on the trail/);
});

test('proofSpoken is honest about each label', () => {
    assert.match(proofSpoken('inferred'), /inference/);
    assert.match(proofSpoken('read-in-code'), /not run/);
    assert.equal(proofSpoken(undefined), '');
});

test('rejects things that are not trails', () => {
    assert.throws(() => parseTrail('not json'), /valid JSON/);
    assert.throws(() => parseTrail('[]'), /crumbs trail/);
    assert.throws(() => parseTrail('{"hello":1}'), /crumbs trail/);
});

test('malicious paths in trail.json are dropped, not followed', () => {
    const evil = JSON.stringify({
        issue: '1',
        plainTitle: 'x',
        trail: [
            { id: 't1', file: '../../etc/passwd', start: 1 },
            { id: 't2', file: '/etc/passwd', start: 1 },
            { id: 't3', file: 'C:\\Windows\\system.ini', start: 1 },
            { id: 't4', file: 'src/ok.js', start: 1 }
        ],
        story: [
            {
                chapter: 'c',
                steps: [{ title: 's', simple: 'x', code: { file: '../secret', start: 1, lines: 'a', highlight: [1] } }]
            }
        ]
    });
    const t = parseTrail(evil);
    assert.deepEqual(t.stops.map(s => s.file), ['src/ok.js']);
    assert.equal(t.story[0].code, undefined);
    assert.ok(!isSafeRelativePath('a/../b'));
    assert.ok(isSafeRelativePath('a/b/c.ts'));
});

test('findTrails lists .crumbs/<issue>/trail.json newest first', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-crumbs-'));
    try {
        assert.deepEqual(findTrails(root), []);
        for (const [issue, when] of [['7', 1000], ['9', 2000]] as const) {
            const dir = path.join(root, '.crumbs', issue);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, 'trail.json');
            fs.writeFileSync(file, fixture);
            fs.utimesSync(file, when, when);
        }
        fs.mkdirSync(path.join(root, '.crumbs', 'empty'));
        assert.deepEqual(findTrails(root).map(t => t.issue), ['9', '7']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
