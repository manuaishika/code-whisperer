import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { AddressInfo } from 'net';
import { complete, LlmError, LlmConfig } from '../core/llm';

interface Captured {
    url?: string;
    headers: http.IncomingHttpHeaders;
    body: any;
}

async function withServer(
    respond: (cap: Captured) => { status: number; body: unknown },
    run: (baseUrl: string, cap: Captured) => Promise<void>
): Promise<void> {
    const cap: Captured = { headers: {}, body: undefined };
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            cap.url = req.url;
            cap.headers = req.headers;
            cap.body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            const r = respond(cap);
            res.writeHead(r.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r.body));
        });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, cap);
    } finally {
        server.close();
    }
}

const base: Pick<LlmConfig, 'maxTokens'> = { maxTokens: 123 };

test('openai: request shape and parsing', async () => {
    await withServer(
        () => ({ status: 200, body: { choices: [{ message: { content: ' hello ' } }] } }),
        async (url, cap) => {
            const out = await complete({ ...base, provider: 'openai', apiKey: 'sk-test', baseUrl: url + '/v1' }, 'sys', 'usr');
            assert.equal(out, 'hello');
            assert.equal(cap.url, '/v1/chat/completions');
            assert.equal(cap.headers.authorization, 'Bearer sk-test');
            assert.equal(cap.body.model, 'gpt-4o-mini');
            assert.equal(cap.body.max_completion_tokens, 123);
            assert.deepEqual(cap.body.messages.map((m: any) => m.role), ['system', 'user']);
        }
    );
});

test('anthropic: request shape and parsing', async () => {
    await withServer(
        () => ({ status: 200, body: { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] } }),
        async (url, cap) => {
            const out = await complete({ ...base, provider: 'anthropic', apiKey: 'ak', baseUrl: url, model: 'm1' }, 'sys', 'usr');
            assert.equal(out, 'one\ntwo');
            assert.equal(cap.url, '/v1/messages');
            assert.equal(cap.headers['x-api-key'], 'ak');
            assert.equal(cap.headers['anthropic-version'], '2023-06-01');
            assert.equal(cap.body.system, 'sys');
            assert.equal(cap.body.model, 'm1');
            assert.equal(cap.body.max_tokens, 123);
        }
    );
});

test('ollama: no key needed, non-streaming', async () => {
    await withServer(
        () => ({ status: 200, body: { message: { content: 'local reply' } } }),
        async (url, cap) => {
            const out = await complete({ ...base, provider: 'ollama', baseUrl: url }, 's', 'u');
            assert.equal(out, 'local reply');
            assert.equal(cap.url, '/api/chat');
            assert.equal(cap.body.stream, false);
            assert.equal(cap.headers.authorization, undefined);
        }
    );
});

test('openai-compatible: uses max_tokens and works without a key', async () => {
    await withServer(
        () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } }),
        async (url, cap) => {
            await complete({ ...base, provider: 'openai-compatible', baseUrl: url + '/v1' }, 's', 'u');
            assert.equal(cap.body.max_tokens, 123);
            assert.equal(cap.body.max_completion_tokens, undefined);
        }
    );
});

test('missing key and missing baseUrl are config errors, not network calls', async () => {
    await assert.rejects(complete({ ...base, provider: 'openai' }, 's', 'u'), (e: LlmError) => e.kind === 'auth');
    await assert.rejects(complete({ ...base, provider: 'openai-compatible' }, 's', 'u'), (e: LlmError) => e.kind === 'config');
});

test('401 is reported as an auth error and never echoes the key', async () => {
    await withServer(
        () => ({ status: 401, body: { error: { message: 'bad key sk-secret' } } }),
        async url => {
            await assert.rejects(
                complete({ ...base, provider: 'openai', apiKey: 'sk-secret', baseUrl: url }, 's', 'u'),
                (e: LlmError) => e.kind === 'auth' && !e.message.includes('sk-secret')
            );
        }
    );
});

test('server errors surface the provider message', async () => {
    await withServer(
        () => ({ status: 500, body: { error: { message: 'overloaded' } } }),
        async url => {
            await assert.rejects(
                complete({ ...base, provider: 'ollama', baseUrl: url }, 's', 'u'),
                /HTTP 500: overloaded/
            );
        }
    );
});

test('empty model output is an error', async () => {
    await withServer(
        () => ({ status: 200, body: { choices: [{ message: { content: '  ' } }] } }),
        async url => {
            await assert.rejects(complete({ ...base, provider: 'openai-compatible', baseUrl: url }, 's', 'u'), /empty/);
        }
    );
});

test('unreachable server is a network error', async () => {
    await assert.rejects(
        complete({ ...base, provider: 'ollama', baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 }, 's', 'u'),
        (e: LlmError) => e.kind === 'network'
    );
});
