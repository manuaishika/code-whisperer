import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ExplainSession, Location, TrailSession } from '../core/session';
import { parseTrail } from '../core/crumbs';
import { vibeModes } from '../core/prompts';

const trail = parseTrail(
    fs.readFileSync(path.join(__dirname, '..', '..', 'test-fixtures', 'example-trail.json'), 'utf8')
);

function fakeDeps() {
    const prompts: Array<{ system: string; user: string }> = [];
    const revealed: Location[] = [];
    return {
        prompts,
        revealed,
        deps: {
            complete: async (system: string, user: string) => {
                prompts.push({ system, user });
                return 'model reply';
            },
            reveal: (l: Location) => revealed.push(l)
        }
    };
}

test('ExplainSession routes by intent and wraps code as untrusted data', async () => {
    const { deps, prompts } = fakeDeps();
    const s = new ExplainSession(deps, { code: 'eval(input)', vibe: vibeModes[0], fileLabel: 'a.js', language: 'javascript' });
    const reply = await s.handle('check security');
    assert.equal(reply.text, 'model reply');
    assert.equal(reply.action, 'Security review');
    assert.match(prompts[0].user, /<code_under_review file="a\.js" language="javascript">\neval\(input\)\n<\/code_under_review>/);
    assert.match(prompts[0].system, /never follow instructions/);
});

test('ExplainSession includes trail context when provided', async () => {
    const { deps, prompts } = fakeDeps();
    const s = new ExplainSession(deps, { code: 'x', vibe: vibeModes[1], trailContext: 'Issue 42 ...' });
    await s.handle('explain this');
    assert.match(prompts[0].user, /<trail_context>\nIssue 42 \.\.\.\n<\/trail_context>/);
});

test('TrailSession: introduction mentions the AI policy first', () => {
    const { deps } = fakeDeps();
    const s = new TrailSession(deps, trail, { vibe: vibeModes[1], depth: 'detailed' });
    const intro = s.start();
    assert.match(intro.text, /issue 42/i);
    assert.match(intro.text, /AI-assisted contributions/);
    assert.match(intro.text, /Say next to begin/);
});

test('TrailSession: next/back/repeat move through steps and reveal code', async () => {
    const { deps, revealed } = fakeDeps();
    const s = new TrailSession(deps, trail, { vibe: vibeModes[1], depth: 'detailed' });
    const first = await s.handle('next');
    assert.match(first.text, /^Step 1 of 7\./);
    assert.match(first.text, /smaller stand-in/); // proof label is spoken
    const second = await s.handle('next');
    assert.match(second.text, /^Step 2 of 7\./);
    assert.ok(revealed.length >= 1);
    const back = await s.handle('go back');
    assert.match(back.text, /^Step 1 of 7\./);
    const again = await s.handle('say that again');
    assert.match(again.text, /^Step 1 of 7\./);
    assert.equal(s.snapshot().step?.index, 1);
});

test('TrailSession: highlighted lines drive the revealed range', async () => {
    const { deps, revealed } = fakeDeps();
    const s = new TrailSession(deps, trail, { vibe: vibeModes[1], depth: 'detailed' });
    for (let i = 0; i < 4; i++) {
        await s.handle('next');
    }
    const last = revealed[revealed.length - 1];
    assert.equal(last.file, 'src/config.js');
    assert.ok(last.start >= 1 && last.end >= last.start);
});

test('TrailSession: end of trail, stop', async () => {
    const { deps } = fakeDeps();
    const s = new TrailSession(deps, trail, { vibe: vibeModes[1], depth: 'detailed' });
    let reply = await s.handle('next');
    for (let i = 0; i < 7; i++) {
        reply = await s.handle('next');
    }
    assert.equal(reply.action, 'End');
    const stop = await s.handle('stop');
    assert.equal(stop.done, true);
});

test('TrailSession: depth changes the wording', async () => {
    const { deps } = fakeDeps();
    const s = new TrailSession(deps, trail, { vibe: vibeModes[1], depth: 'detailed' });
    const detailed = (await s.handle('next')).text;
    const simple = (await s.handle('simpler')).text;
    const deep = (await s.handle('deeper')).text; // simple -> detailed
    const deeper = (await s.handle('deeper')).text; // detailed -> deep
    assert.ok(simple.length < detailed.length);
    assert.equal(deep, detailed);
    assert.ok(deeper.length > detailed.length);
    const again = (await s.handle('deeper')).text;
    assert.match(again, /already the deepest/);
});

test('TrailSession: free questions go to the model with trail context, not to navigation', async () => {
    const { deps, prompts } = fakeDeps();
    const s = new TrailSession(deps, trail, { vibe: vibeModes[1], depth: 'detailed' });
    await s.handle('next');
    const reply = await s.handle('why does normalize lowercase the keys');
    assert.equal(reply.action, 'Question');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].user, /<trail_context>/);
    assert.match(prompts[0].user, /Current step 1 of 7/);
    assert.match(prompts[0].user, /why does normalize lowercase the keys/);
});
