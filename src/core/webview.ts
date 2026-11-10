import { escapeHtml } from './escape';

/**
 * Static shell of the Code Whisperer panel. All dynamic content (code, replies, step info) arrives
 * later through postMessage and is inserted with textContent, never as HTML, so selected code or a
 * model reply can't inject markup or script into the panel.
 */
export function panelHtml(opts: { nonce: string; cspSource: string }): string {
    const { nonce, cspSource } = opts;
    const csp = `default-src 'none'; style-src ${escapeHtml(cspSource)} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Code Whisperer Voice</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 16px 20px 40px; }
  .wrap { max-width: 720px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
  h1 { font-size: 1.3em; margin: 0; }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 12px; border-radius: 12px; font-size: .85em; }
  .proof { border: 1px solid var(--vscode-textBlockQuote-border); padding: 1px 8px; border-radius: 10px; font-size: .8em; opacity: .85; }
  .label { font-size: .85em; opacity: .75; margin: 14px 0 4px; }
  pre#code { margin: 0; padding: 10px 0; max-height: 260px; overflow: auto; background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-textBlockQuote-border); border-radius: 6px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .ln { display: block; padding: 0 12px; white-space: pre; }
  .ln b { display: inline-block; width: 3.2em; opacity: .5; font-weight: normal; user-select: none; }
  .ln.hl { background: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 200, 0, .25)); }
  .pointer { font-size: .85em; opacity: .85; margin-top: 6px; }
  .step { margin: 10px 0 0; font-weight: 600; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0; align-items: center; }
  button { background: var(--vscode-button-secondaryBackground, var(--vscode-button-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground)); border: 1px solid transparent; border-radius: 4px; padding: 6px 12px; cursor: pointer; font: inherit; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button:disabled { opacity: .5; cursor: default; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; margin: 10px 0; }
  .grid button { text-align: left; display: flex; gap: 8px; align-items: center; }
  input[type=text] { flex: 1; min-width: 200px; padding: 6px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; font: inherit; }
  #status { min-height: 1.4em; opacity: .85; }
  #status.error { color: var(--vscode-errorForeground); opacity: 1; }
  .reply { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-textBlockQuote-border); border-radius: 6px; padding: 14px 16px; margin: 12px 0; line-height: 1.6; white-space: pre-wrap; }
  .reply small { display: block; opacity: .7; margin-bottom: 6px; }
  .hidden { display: none !important; }
  .tip { font-size: .85em; opacity: .75; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1 id="title">Code Whisperer Voice</h1>
    <span class="badge" id="badge"></span>
  </header>

  <div class="label" id="codeLabel"></div>
  <pre id="code" class="hidden" aria-label="Code"></pre>
  <div class="pointer hidden" id="pointer"></div>
  <div class="step hidden" id="step"></div>

  <div class="grid hidden" id="commands"></div>

  <div class="row hidden" id="nav">
    <button id="back" type="button">⏮ Back</button>
    <button id="repeat" type="button">🔁 Repeat</button>
    <button id="next" type="button" class="primary">Next ⏭</button>
    <button id="simpler" type="button">Simpler</button>
    <button id="deeper" type="button">Deeper</button>
  </div>

  <form class="row" id="form" autocomplete="off">
    <input type="text" id="text" aria-label="Type a command or question">
    <button type="submit" class="primary" id="send">Ask</button>
    <button type="button" id="voice" title="Opens a page in your browser, where the microphone works">🎤 Talk (in browser)</button>
    <button type="button" id="stop" title="Stop speaking">⏹ Stop</button>
  </form>

  <div id="status" role="status" aria-live="polite"></div>
  <div id="heard" class="tip hidden"></div>
  <div id="reply" class="reply hidden"><small></small><span></span></div>
  <p class="tip">VS Code panels can't access your microphone, so <b>Talk</b> opens a small page in your browser. Typing and the buttons here work everywhere, and replies are read aloud by your system voice.</p>
</div>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var $ = function (id) { return document.getElementById(id); };
  var busy = false;

  function setBusy(b) {
    busy = b;
    ['send', 'back', 'repeat', 'next', 'simpler', 'deeper'].forEach(function (id) { $(id).disabled = b; });
    document.querySelectorAll('#commands button').forEach(function (btn) { btn.disabled = b; });
  }
  function status(text, isError) {
    var el = $('status');
    el.textContent = text || '';
    el.className = isError ? 'error' : '';
  }
  function ask(text) {
    if (!text || busy) return;
    setBusy(true);
    status('Thinking…');
    vscode.postMessage({ type: 'utterance', text: text });
  }

  function renderCode(code, pointer) {
    var pre = $('code');
    pre.textContent = '';
    if (!code) { pre.classList.add('hidden'); $('pointer').classList.add('hidden'); return; }
    var hl = {};
    (code.highlight || []).forEach(function (n) { hl[n] = true; });
    code.lines.forEach(function (line, i) {
      var n = code.start + i;
      var row = document.createElement('span');
      row.className = 'ln' + (hl[n] ? ' hl' : '');
      var num = document.createElement('b');
      num.textContent = String(n);
      row.appendChild(num);
      row.appendChild(document.createTextNode(line));
      pre.appendChild(row);
    });
    pre.classList.remove('hidden');
    var p = $('pointer');
    if (code.pointer) { p.textContent = code.pointer; p.classList.remove('hidden'); } else { p.classList.add('hidden'); }
  }

  function renderState(s) {
    $('title').textContent = s.title;
    $('badge').textContent = s.badge;
    $('codeLabel').textContent = s.codeLabel;
    $('text').placeholder = s.placeholder;
    renderCode(s.code);

    var stepEl = $('step');
    if (s.step) {
      stepEl.textContent = 'Step ' + s.step.index + ' of ' + s.step.total + ' · ' + s.step.chapter + ' — ' + s.step.title;
      if (s.step.proof) {
        var tag = document.createElement('span');
        tag.className = 'proof';
        tag.textContent = s.step.proof;
        stepEl.appendChild(document.createTextNode(' '));
        stepEl.appendChild(tag);
      }
      stepEl.classList.remove('hidden');
    } else { stepEl.classList.add('hidden'); }

    $('nav').classList.toggle('hidden', s.mode !== 'trail');

    var grid = $('commands');
    grid.textContent = '';
    if (s.commands) {
      s.commands.forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button';
        var icon = document.createElement('span'); icon.textContent = c.icon;
        var label = document.createElement('span'); label.textContent = c.label;
        b.appendChild(icon); b.appendChild(label);
        b.title = 'Say: "' + c.example + '"';
        b.addEventListener('click', function () { ask(c.example); });
        grid.appendChild(b);
      });
      grid.classList.remove('hidden');
    } else { grid.classList.add('hidden'); }
  }

  function showReply(text, action, heardText) {
    var card = $('reply');
    card.querySelector('small').textContent = action || 'Reply';
    card.querySelector('span').textContent = text;
    card.classList.remove('hidden');
    var h = $('heard');
    if (heardText) { h.textContent = 'You said: ' + heardText; h.classList.remove('hidden'); } else { h.classList.add('hidden'); }
  }

  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('text');
    var v = input.value.trim();
    input.value = '';
    ask(v);
  });
  $('voice').addEventListener('click', function () { vscode.postMessage({ type: 'openVoice' }); });
  $('stop').addEventListener('click', function () { vscode.postMessage({ type: 'stop' }); });
  [['back', 'back'], ['repeat', 'repeat'], ['next', 'next'], ['simpler', 'simpler'], ['deeper', 'deeper']].forEach(function (p) {
    $(p[0]).addEventListener('click', function () { ask(p[1]); });
  });

  window.addEventListener('message', function (event) {
    var m = event.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'state') { renderState(m.state); }
    else if (m.type === 'reply') { setBusy(false); status(''); showReply(m.text, m.action, m.heard); if (m.state) renderState(m.state); }
    else if (m.type === 'error') { setBusy(false); status(m.text, true); }
    else if (m.type === 'status') { status(m.text, false); }
  });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
