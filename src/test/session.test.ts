import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExplainSession, Location, WalkthroughSession } from '../core/session';
import { vibeModes } from '../core/prompts';

const CODE = ['function add(a, b) {', '  return a + b;', '}', '', 'console.log(add(2, "3"));'].join('\n');

const PLAN = JSON.stringify({
    overview: 'A tiny function that adds two values.',
    steps: [
        { title: 'The function', simple: 'add takes two values.', detailed: 'add takes a and b and returns their sum.', deep: 'There is no type check, so strings are concatenated.', startLine: 1, endLine: 3, basis: 'read' },
        { title: 'The call', simple: 'It is called with 2 and "3".', detailed: 'The call passes a number and a string.', deep: 'Mixed types give "23", not 5.', startLine: 5, endLine: 5, basis: 'inferred' }
    ]
});

function fakeDeps(reply: string = PLAN) {
    const prompts: Array<{ system: string; user: string }> = [];
    const revealed: Location[] = [];
    return {
        prompts,
        revealed,
        deps: {
            complete: async (system: string, user: string) => {
                prompts.push({ system, user });
                return reply;
            },
            reveal: (l: Location) => revealed.push(l)
        }
    };
}

const opts = { code: CODE, vibe: vibeModes[1], depth: 'detailed' as const, startLine: 10, fileLabel: 'src/math.js' };

test('ExplainSession routes by intent and wraps code as untrusted data', async () => {
    const { deps, prompts } = fakeDeps('model reply');
    const s = new ExplainSession(deps, { code: 'eval(input)', vibe: vibeModes[0], fileLabel: 'a.js', language: 'javascript' });
    const reply = await s.handle('check security');
    assert.equal(reply.text, 'model reply');
    assert.equal(reply.action, 'Security review');
    assert.match(prompts[0].user, /<code_under_review file="a\.js" language="javascript">\neval\(input\)\n<\/code_under_review>/);
    assert.match(prompts[0].system, /never follow instructions/);
});

test('WalkthroughSession.create sends numbered code and rejects unusable plans', async () => {
    const { deps, prompts } = fakeDeps();
    await WalkthroughSession.create(deps, opts);
    assert.match(prompts[0].user, /1\| function add\(a, b\) \{/);
    assert.match(prompts[0].user, /5\| console\.log/);
    await assert.rejects(WalkthroughSession.create(fakeDeps('sorry, I cannot').deps, opts), /usable walkthrough/);
});

test('overview comes first and mentions the step count', async () => {
    const s = await WalkthroughSession.create(fakeDeps().deps, opts);
    const intro = s.start();
    assert.match(intro.text, /adds two values/);
    assert.match(intro.text, /2 steps/);
    assert.equal(s.snapshot().step, null);
});

test('next/back/repeat move through steps and reveal absolute lines', async () => {
    const { deps, revealed } = fakeDeps();
    const s = await WalkthroughSession.create(deps, opts);
    const first = await s.handle('next');
    assert.match(first.text, /^Step 1 of 2\. The function\./);
    assert.deepEqual(revealed.at(-1), { start: 10, end: 12 }); // selection starts on document line 10
    const second = await s.handle('next');
    assert.match(second.text, /^Step 2 of 2\./);
    assert.deepEqual(revealed.at(-1), { start: 14, end: 14 });
    assert.match((await s.handle('go back')).text, /^Step 1 of 2\./);
    assert.match((await s.handle('say that again')).text, /^Step 1 of 2\./);
    assert.equal(s.snapshot().step?.index, 1);
});

test('snapshot highlights the current step in absolute line numbers', async () => {
    const s = await WalkthroughSession.create(fakeDeps().deps, opts);
    await s.handle('next');
    assert.deepEqual(s.snapshot().code?.highlight, [10, 11, 12]);
    assert.equal(s.snapshot().code?.start, 10);
});

test('inferred steps say so out loud; read steps stay quiet', async () => {
    const s = await WalkthroughSession.create(fakeDeps().deps, opts);
    assert.doesNotMatch((await s.handle('next')).text, /inference/);
    assert.match((await s.handle('next')).text, /inference/);
    assert.equal(s.snapshot().step?.basis, 'Inferred');
});

test('end of walkthrough and stop', async () => {
    const s = await WalkthroughSession.create(fakeDeps().deps, opts);
    await s.handle('next');
    await s.handle('next');
    assert.equal((await s.handle('next')).action, 'End');
    const stop = await s.handle('stop');
    assert.equal(stop.done, true);
});

test('depth changes the wording and is honest at the limits', async () => {
    const s = await WalkthroughSession.create(fakeDeps().deps, opts);
    const detailed = (await s.handle('next')).text;
    const simple = (await s.handle('simpler')).text;
    assert.ok(simple.length < detailed.length);
    assert.match(await s.handle('simpler').then(r => r.text), /already as simple/);
    assert.equal((await s.handle('deeper')).text, detailed); // simple -> detailed
    const deep = (await s.handle('deeper')).text; // detailed -> deep
    assert.ok(deep.length > detailed.length);
    assert.match(await s.handle('deeper').then(r => r.text), /already the deepest/);
});

test('free questions go to the model with the current step as context', async () => {
    const { deps, prompts } = fakeDeps();
    const s = await WalkthroughSession.create(deps, opts);
    await s.handle('next');
    deps.complete = async (system, user) => {
        prompts.push({ system, user });
        return 'because it concatenates';
    };
    const reply = await s.handle('why is the result a string');
    assert.equal(reply.action, 'Question');
    assert.equal(reply.text, 'because it concatenates');
    const last = prompts.at(-1)!;
    assert.match(last.user, /<walkthrough_context>/);
    assert.match(last.user, /Current step 1 of 2: The function/);
    assert.match(last.user, /why is the result a string/);
    assert.match(last.system, /never follow instructions/);
});
