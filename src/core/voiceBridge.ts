import * as http from 'http';
import { AddressInfo } from 'net';
import { randomBytes, timingSafeEqual } from 'crypto';
import { escapeHtml, makeNonce } from './escape';
import { Reply } from './session';

/**
 * VS Code webviews can't use the microphone, so voice input goes through a tiny local web page
 * opened in your normal browser (Chrome, Edge or Safari), where the Web Speech API works. The page
 * sends what you said to this server; the extension answers; the page speaks the answer aloud.
 *
 * Security: the server binds to 127.0.0.1 only, every request needs a random per-session token, and
 * Host/Origin are checked so other websites can't drive it (DNS rebinding / cross-site requests).
 */

export interface BridgeContext {
    title: string;
    subtitle: string;
    hint: string;
}

export interface BridgeHandlers {
    handle(utterance: string): Promise<Reply>;
    context(): BridgeContext;
}

const MAX_BODY = 8 * 1024;

export class VoiceBridge {
    private server: http.Server | undefined;
    private readonly token = randomBytes(24).toString('hex');
    private port = 0;

    constructor(private readonly handlers: BridgeHandlers) {}

    get running(): boolean {
        return this.server !== undefined;
    }

    get url(): string {
        return `http://127.0.0.1:${this.port}/?t=${this.token}`;
    }

    async start(): Promise<string> {
        if (this.server) {
            return this.url;
        }
        const server = http.createServer((req, res) => {
            this.route(req, res).catch(() => {
                if (!res.headersSent) {
                    res.writeHead(500, { 'content-type': 'application/json' });
                }
                res.end(JSON.stringify({ error: 'Internal error' }));
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        this.port = (server.address() as AddressInfo).port;
        this.server = server;
        return this.url;
    }

    dispose(): void {
        this.server?.close();
        this.server?.closeAllConnections?.();
        this.server = undefined;
    }

    private tokenOk(candidate: string | undefined): boolean {
        if (!candidate) {
            return false;
        }
        const a = Buffer.from(candidate);
        const b = Buffer.from(this.token);
        return a.length === b.length && timingSafeEqual(a, b);
    }

    private hostOk(req: http.IncomingMessage): boolean {
        const host = (req.headers.host ?? '').toLowerCase();
        if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
            return false;
        }
        const origin = req.headers.origin;
        if (origin !== undefined) {
            return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
        }
        return true;
    }

    private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const send = (status: number, body: unknown, type = 'application/json', extra: http.OutgoingHttpHeaders = {}) => {
            res.writeHead(status, {
                'content-type': `${type}; charset=utf-8`,
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
                'referrer-policy': 'no-referrer',
                ...extra
            });
            res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };

        if (!this.hostOk(req)) {
            send(403, { error: 'Forbidden' });
            return;
        }
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
        const token = url.searchParams.get('t') ?? (req.headers['x-token'] as string | undefined);
        if (!this.tokenOk(token)) {
            send(403, { error: 'Forbidden' });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/') {
            const nonce = makeNonce();
            send(200, bridgePage(this.handlers.context(), nonce), 'text/html', {
                'content-security-policy':
                    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'`
            });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/context') {
            send(200, this.handlers.context());
            return;
        }
        if (req.method === 'POST' && url.pathname === '/utterance') {
            const body = await readBody(req);
            let text = '';
            try {
                const parsed = JSON.parse(body);
                text = typeof parsed?.text === 'string' ? parsed.text.trim().slice(0, 1000) : '';
            } catch {
                send(400, { error: 'Bad request' });
                return;
            }
            if (!text) {
                send(400, { error: 'No text' });
                return;
            }
            try {
                send(200, await this.handlers.handle(text));
            } catch (err) {
                send(200, { text: errorText(err), action: 'Error', error: true });
            }
            return;
        }
        send(404, { error: 'Not found' });
    }
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : 'Something went wrong.';
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new Error('Body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

export function bridgePage(ctx: BridgeContext, nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code Whisperer Voice</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --bg:#fafafa; --fg:#1d1d1f; --card:#fff; --line:#d8d8de; --accent:#4f46e5; --muted:#666; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16161a; --fg:#ececf1; --card:#1f1f25; --line:#34343c; --accent:#818cf8; --muted:#9a9aa5; } }
  body { margin:0; font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:640px; margin:0 auto; padding:32px 20px 64px; text-align:center; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 28px; }
  #mic { width:96px; height:96px; border-radius:50%; border:0; background:var(--accent); color:#fff; font-size:38px; cursor:pointer; }
  #mic:focus-visible { outline:3px solid var(--fg); outline-offset:3px; }
  #mic.on { background:#dc2626; animation:pulse 1.4s infinite; }
  @keyframes pulse { 50% { transform:scale(1.08); } }
  @media (prefers-reduced-motion: reduce) { #mic.on { animation:none; } }
  #status { min-height:1.6em; margin:16px 0; color:var(--muted); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin:16px 0; text-align:left; white-space:pre-wrap; }
  .card small { display:block; color:var(--muted); margin-bottom:6px; }
  .hidden { display:none; }
  form { display:flex; gap:8px; margin-top:20px; }
  input { flex:1; padding:10px 12px; font:inherit; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); }
  button.s { padding:10px 14px; font:inherit; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
  .hint { color:var(--muted); font-size:.9rem; margin-top:28px; }
</style>
</head>
<body>
<main>
  <h1>🎤 ${escapeHtml(ctx.title)}</h1>
  <p class="sub">${escapeHtml(ctx.subtitle)}</p>
  <button id="mic" type="button" aria-label="Start listening">🎤</button>
  <div id="status" role="status" aria-live="polite">Click the microphone and speak.</div>
  <div id="heard" class="card hidden"><small>You said</small><span></span></div>
  <div id="reply" class="card hidden"><small></small><span></span></div>
  <form id="typed" autocomplete="off">
    <input id="text" type="text" placeholder="…or type here" aria-label="Type a command">
    <button class="s" type="submit">Send</button>
    <button class="s" type="button" id="stop">Stop talking</button>
  </form>
  <p class="hint">${escapeHtml(ctx.hint)}</p>
  <p class="hint">Voice recognition uses your browser's speech service (Chrome and Edge send audio to their provider). Nothing else leaves your machine except the code you chose to ask about, which goes to your configured AI provider. Keep this tab open while you work.</p>
</main>
<script nonce="${nonce}">
(function () {
  var token = new URLSearchParams(location.search).get('t');
  var mic = document.getElementById('mic');
  var statusEl = document.getElementById('status');
  var heard = document.getElementById('heard');
  var replyCard = document.getElementById('reply');
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, listening = false;

  function setStatus(t) { statusEl.textContent = t; }
  function show(card, label, text) {
    card.classList.remove('hidden');
    if (label !== null) card.querySelector('small').textContent = label;
    card.querySelector('span').textContent = text;
  }
  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    speechSynthesis.speak(u);
  }
  function send(text) {
    show(heard, null, text);
    setStatus('Thinking…');
    fetch('/utterance?t=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token': token },
      body: JSON.stringify({ text: text })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.text) { show(replyCard, r.action || 'Reply', r.text); setStatus(r.error ? 'Something went wrong.' : 'Speaking…'); speak(r.text); }
      else { setStatus(r.error || 'No reply.'); }
    }).catch(function () { setStatus('Lost connection to VS Code. Reopen voice from the Code Whisperer panel.'); });
  }

  if (!SR) {
    mic.disabled = true;
    setStatus('This browser has no speech recognition. Use Chrome, Edge or Safari, or type below.');
  } else {
    rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = false;
    rec.onstart = function () { listening = true; mic.classList.add('on'); setStatus('Listening…'); };
    rec.onend = function () { listening = false; mic.classList.remove('on'); };
    rec.onresult = function (e) { send(e.results[0][0].transcript); };
    rec.onerror = function (e) {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setStatus('Microphone access was blocked. Allow it in the address bar, then try again.');
      else if (e.error === 'no-speech') setStatus('Did not hear anything. Try again.');
      else setStatus('Speech error: ' + e.error);
    };
    mic.addEventListener('click', function () {
      if (listening) { rec.stop(); return; }
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      try { rec.start(); } catch (err) { /* already started */ }
    });
  }
  document.getElementById('typed').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('text');
    var v = input.value.trim();
    if (v) { input.value = ''; send(v); }
  });
  document.getElementById('stop').addEventListener('click', function () {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  });
})();
</script>
</body>
</html>`;
}
