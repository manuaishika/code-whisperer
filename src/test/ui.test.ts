import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { escapeHtml, makeNonce } from '../core/escape';
import { panelHtml } from '../core/webview';
import { toSpeakable, ttsCandidates } from '../core/speech';
import { VoiceBridge, bridgePage } from '../core/voiceBridge';

test('escapeHtml neutralises markup', () => {
    assert.equal(escapeHtml(`<script>alert("x")</script>&'`), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
});

test('panel shell has a strict CSP and no inline handlers', () => {
    const nonce = makeNonce();
    const html = panelHtml({ nonce, cspSource: 'vscode-webview://abc' });
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, new RegExp(`script-src 'nonce-${nonce}'`));
    assert.doesNotMatch(html, /\bon(click|load|error)=/i);
    assert.doesNotMatch(html, /innerHTML/); // dynamic content must only use textContent
});

test('bridge page escapes its context', () => {
    const html = bridgePage({ title: '<img src=x onerror=alert(1)>', subtitle: '"><b>', hint: '&' }, 'n0nce');
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('toSpeakable strips markdown', () => {
    assert.equal(toSpeakable('## Title\n**bold** and `code` and [link](http://x.y)\n- item\n```js\nlet a=1\n```'), 'Title bold and code and link item (code omitted)');
});

test('ttsCandidates never put text in a shell string', () => {
    const evil = '"; rm -rf / #';
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
        for (const c of ttsCandidates(platform, evil, 1)) {
            assert.ok(c.stdin === evil || c.args.includes(evil), `${platform}/${c.command} must pass text via stdin or argv`);
            assert.ok(!c.args.some(a => a !== evil && a.includes(evil)));
        }
    }
    assert.deepEqual(ttsCandidates('linux', 'hi').map(c => c.command), ['spd-say', 'espeak-ng', 'espeak']);
});

function request(port: number, opts: http.RequestOptions, body?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, ...opts }, res => {
            const chunks: Buffer[] = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        if (body) {
            req.write(body);
        }
        req.end();
    });
}

test('voice bridge: token, host and origin checks; round trip', async () => {
    const bridge = new VoiceBridge({
        handle: async text => ({ text: `you said ${text}`, action: 'Echo' }),
        context: () => ({ title: 'T', subtitle: 'S', hint: 'H' })
    });
    const url = new URL(await bridge.start());
    const port = Number(url.port);
    const token = url.searchParams.get('t')!;
    try {
        // page loads with token, with CSP
        const page = await request(port, { path: `/?t=${token}`, headers: { host: `127.0.0.1:${port}` } });
        assert.equal(page.status, 200);
        // wrong / missing token
        assert.equal((await request(port, { path: '/?t=nope', headers: { host: `127.0.0.1:${port}` } })).status, 403);
        assert.equal((await request(port, { path: '/', headers: { host: `127.0.0.1:${port}` } })).status, 403);
        // DNS-rebinding style Host
        assert.equal((await request(port, { path: `/?t=${token}`, headers: { host: 'evil.example' } })).status, 403);
        // cross-site Origin
        assert.equal(
            (await request(port, { method: 'POST', path: `/utterance?t=${token}`, headers: { host: `127.0.0.1:${port}`, origin: 'https://evil.example' } }, '{"text":"x"}')).status,
            403
        );
        // valid round trip
        const ok = await request(
            port,
            { method: 'POST', path: `/utterance?t=${token}`, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' } },
            JSON.stringify({ text: 'hello' })
        );
        assert.equal(ok.status, 200);
        assert.deepEqual(JSON.parse(ok.body), { text: 'you said hello', action: 'Echo' });
        // bad bodies
        assert.equal(
            (await request(port, { method: 'POST', path: `/utterance?t=${token}`, headers: { host: `127.0.0.1:${port}` } }, 'not json')).status,
            400
        );
    } finally {
        bridge.dispose();
    }
});
