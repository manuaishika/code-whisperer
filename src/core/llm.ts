import * as http from 'http';
import * as https from 'https';

export type Provider = 'openai' | 'anthropic' | 'ollama' | 'openai-compatible';

export const PROVIDERS: Provider[] = ['openai', 'anthropic', 'ollama', 'openai-compatible'];

export interface LlmConfig {
    provider: Provider;
    /** Empty or undefined means "use the provider default". */
    model?: string;
    /** Empty or undefined means "use the provider default". */
    baseUrl?: string;
    apiKey?: string;
    maxTokens: number;
    timeoutMs?: number;
}

export const DEFAULT_MODELS: Record<Provider, string> = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-5-5',
    ollama: 'llama3.1',
    'openai-compatible': 'default'
};

export const DEFAULT_BASE_URLS: Record<Provider, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    ollama: 'http://localhost:11434',
    'openai-compatible': ''
};

export class LlmError extends Error {
    constructor(message: string, readonly kind: 'config' | 'auth' | 'http' | 'network' = 'http') {
        super(message);
        this.name = 'LlmError';
    }
}

export function providerNeedsKey(provider: Provider): boolean {
    return provider === 'openai' || provider === 'anthropic';
}

/** Environment variable consulted when no key is stored. */
export function envKeyName(provider: Provider): string | undefined {
    if (provider === 'openai') {
        return 'OPENAI_API_KEY';
    }
    if (provider === 'anthropic') {
        return 'ANTHROPIC_API_KEY';
    }
    return undefined;
}

interface HttpResult {
    status: number;
    body: string;
}

function postJson(
    urlString: string,
    headers: Record<string, string>,
    payload: unknown,
    timeoutMs: number
): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
        let url: URL;
        try {
            url = new URL(urlString);
        } catch {
            reject(new LlmError(`Invalid URL: ${urlString}`, 'config'));
            return;
        }
        const data = Buffer.from(JSON.stringify(payload));
        const lib = url.protocol === 'http:' ? http : https;
        const req = lib.request(
            url,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers }
            },
            res => {
                const chunks: Buffer[] = [];
                res.on('data', c => chunks.push(c as Buffer));
                res.on('end', () =>
                    resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
                );
                res.on('error', err => reject(new LlmError(`Connection error: ${err.message}`, 'network')));
            }
        );
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`));
        });
        req.on('error', err => reject(new LlmError(`Could not reach ${url.host}: ${err.message}`, 'network')));
        req.write(data);
        req.end();
    });
}

function errorMessageFromBody(body: string): string {
    try {
        const json = JSON.parse(body);
        const msg = json?.error?.message ?? json?.error ?? json?.message;
        if (typeof msg === 'string') {
            return msg.slice(0, 200);
        }
    } catch {
        /* not JSON */
    }
    return body.replace(/\s+/g, ' ').slice(0, 200);
}

function joinUrl(base: string, path: string): string {
    return base.replace(/\/+$/, '') + path;
}

export function parseOpenAiResponse(body: string): string {
    const json = JSON.parse(body);
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
        throw new LlmError('The model returned an empty response.');
    }
    return text.trim();
}

export function parseAnthropicResponse(body: string): string {
    const json = JSON.parse(body);
    const blocks: Array<{ type?: string; text?: string }> = Array.isArray(json?.content) ? json.content : [];
    const text = blocks
        .filter(b => b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n')
        .trim();
    if (!text) {
        throw new LlmError('The model returned an empty response.');
    }
    return text;
}

export function parseOllamaResponse(body: string): string {
    const json = JSON.parse(body);
    const text = json?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
        throw new LlmError('The model returned an empty response.');
    }
    return text.trim();
}

/** Send one system+user prompt pair to the configured provider and return the reply text. */
export async function complete(config: LlmConfig, system: string, user: string): Promise<string> {
    const { provider } = config;
    const model = config.model?.trim() || DEFAULT_MODELS[provider];
    const base = config.baseUrl?.trim() || DEFAULT_BASE_URLS[provider];
    const timeoutMs = config.timeoutMs ?? 60_000;

    if (!base) {
        throw new LlmError('Set codeWhispererVoice.baseUrl for the openai-compatible provider.', 'config');
    }
    if (providerNeedsKey(provider) && !config.apiKey) {
        throw new LlmError(`No API key for ${provider}. Run "Code Whisperer: Set API Key".`, 'auth');
    }

    let url: string;
    let headers: Record<string, string> = {};
    let payload: unknown;
    let parse: (body: string) => string;

    switch (provider) {
        case 'openai':
        case 'openai-compatible':
            url = joinUrl(base, '/chat/completions');
            if (config.apiKey) {
                headers.authorization = `Bearer ${config.apiKey}`;
            }
            payload = {
                model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user }
                ],
                // Official OpenAI models need max_completion_tokens; local servers expect max_tokens.
                ...(provider === 'openai'
                    ? { max_completion_tokens: config.maxTokens }
                    : { max_tokens: config.maxTokens })
            };
            parse = parseOpenAiResponse;
            break;
        case 'anthropic':
            url = joinUrl(base, '/v1/messages');
            headers = { 'x-api-key': config.apiKey as string, 'anthropic-version': '2023-06-01' };
            payload = {
                model,
                max_tokens: config.maxTokens,
                system,
                messages: [{ role: 'user', content: user }]
            };
            parse = parseAnthropicResponse;
            break;
        case 'ollama':
            url = joinUrl(base, '/api/chat');
            payload = {
                model,
                stream: false,
                options: { num_predict: config.maxTokens },
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user }
                ]
            };
            parse = parseOllamaResponse;
            break;
        default:
            throw new LlmError(`Unknown provider: ${provider}`, 'config');
    }

    const res = await postJson(url, headers, payload, timeoutMs);
    if (res.status === 401 || res.status === 403) {
        throw new LlmError(`${provider} rejected the API key (HTTP ${res.status}).`, 'auth');
    }
    if (res.status < 200 || res.status >= 300) {
        throw new LlmError(`${provider} returned HTTP ${res.status}: ${errorMessageFromBody(res.body)}`);
    }
    try {
        return parse(res.body);
    } catch (err) {
        if (err instanceof LlmError) {
            throw err;
        }
        throw new LlmError(`Could not read the ${provider} response.`);
    }
}
