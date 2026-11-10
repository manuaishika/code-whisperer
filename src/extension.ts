import * as vscode from 'vscode';
import * as path from 'path';
import { complete, LlmConfig, LlmError, PROVIDERS, Provider, providerNeedsKey, envKeyName } from './core/llm';
import { VibeMode, vibeModes } from './core/prompts';
import { Speaker } from './core/speech';
import { makeNonce } from './core/escape';
import { panelHtml } from './core/webview';
import { VoiceBridge } from './core/voiceBridge';
import { ExplainSession, Location, Session, SessionDeps, TrailSession } from './core/session';
import { Depth, findTrails, loadTrail, stopForLocation, trailSummary, Trail } from './core/crumbs';

const SECRET_PREFIX = 'codeWhispererVoice.apiKey.';
const cfg = () => vscode.workspace.getConfiguration('codeWhispererVoice');

let speaker: Speaker;
let warnedNoTts = false;

export function activate(context: vscode.ExtensionContext): void {
    speaker = new Speaker();
    void migrateLegacyKey(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('code-whisperer-voice.explainSelectedCodeVoice', () => explainSelection(context)),
        vscode.commands.registerCommand('code-whisperer-voice.walkCrumbsTrail', () => walkTrail(context)),
        vscode.commands.registerCommand('code-whisperer-voice.setApiKey', () => promptForKey(context, currentProvider())),
        vscode.commands.registerCommand('code-whisperer-voice.stopSpeaking', () => speaker.stop()),
        { dispose: () => speaker.stop() }
    );
}

export function deactivate(): void {
    speaker?.stop();
}

// ---------------------------------------------------------------------------------------------
// Settings, keys and the language model
// ---------------------------------------------------------------------------------------------

function currentProvider(): Provider {
    const value = cfg().get<string>('provider', 'openai') as Provider;
    return PROVIDERS.includes(value) ? value : 'openai';
}

/** Move a key from the old plain-text setting into encrypted SecretStorage. */
async function migrateLegacyKey(context: vscode.ExtensionContext): Promise<void> {
    const legacy = cfg().get<string>('openaiApiKey', '').trim();
    if (!legacy) {
        return;
    }
    const slot = SECRET_PREFIX + 'openai';
    if (!(await context.secrets.get(slot))) {
        await context.secrets.store(slot, legacy);
    }
    void vscode.window.showInformationMessage(
        'Code Whisperer moved your OpenAI key into VS Code\'s encrypted secret storage. You can now delete "codeWhispererVoice.openaiApiKey" from your settings.'
    );
}

async function promptForKey(context: vscode.ExtensionContext, provider: Provider): Promise<string | undefined> {
    if (!providerNeedsKey(provider)) {
        void vscode.window.showInformationMessage(`The ${provider} provider does not need an API key.`);
        return undefined;
    }
    const key = await vscode.window.showInputBox({
        title: `Code Whisperer: ${provider} API key`,
        prompt: `Paste your ${provider} API key. It is stored encrypted in VS Code, not in settings.json.`,
        password: true,
        ignoreFocusOut: true
    });
    if (!key?.trim()) {
        return undefined;
    }
    await context.secrets.store(SECRET_PREFIX + provider, key.trim());
    return key.trim();
}

async function resolveLlmConfig(context: vscode.ExtensionContext): Promise<LlmConfig> {
    const provider = currentProvider();
    let apiKey = await context.secrets.get(SECRET_PREFIX + provider);
    const envName = envKeyName(provider);
    if (!apiKey && envName) {
        apiKey = process.env[envName];
    }
    if (!apiKey && providerNeedsKey(provider)) {
        apiKey = await promptForKey(context, provider);
    }
    return {
        provider,
        model: cfg().get<string>('model', ''),
        baseUrl: cfg().get<string>('baseUrl', ''),
        apiKey,
        maxTokens: cfg().get<number>('maxTokens', 700)
    };
}

function makeDeps(context: vscode.ExtensionContext, rootUri?: vscode.Uri): SessionDeps {
    return {
        complete: async (system, user) => {
            const config = await resolveLlmConfig(context);
            try {
                return await complete(config, system, user);
            } catch (err) {
                if (err instanceof LlmError && err.kind === 'auth') {
                    // Forget the rejected key so the next attempt asks again.
                    await context.secrets.delete(SECRET_PREFIX + config.provider);
                }
                throw err;
            }
        },
        reveal: rootUri ? loc => void revealLocation(rootUri, loc) : undefined
    };
}

async function revealLocation(root: vscode.Uri, loc: Location): Promise<void> {
    try {
        const uri = vscode.Uri.joinPath(root, ...loc.file.split('/'));
        // Belt and braces: refuse to open anything that resolves outside the workspace folder.
        if (!path.resolve(uri.fsPath).startsWith(path.resolve(root.fsPath) + path.sep)) {
            return;
        }
        const doc = await vscode.workspace.openTextDocument(uri);
        const range = new vscode.Range(
            Math.max(0, loc.start - 1),
            0,
            Math.max(0, loc.end - 1),
            doc.lineAt(Math.min(doc.lineCount - 1, Math.max(0, loc.end - 1))).text.length
        );
        const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: true,
            preview: false
        });
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch {
        /* file may not exist at this commit; the narration still works */
    }
}

// ---------------------------------------------------------------------------------------------
// Speaking
// ---------------------------------------------------------------------------------------------

async function speakAloud(text: string): Promise<void> {
    if (!cfg().get<boolean>('speech.enabled', true)) {
        return;
    }
    const ok = await speaker.speak(text, cfg().get<number>('speech.rate', 1));
    if (!ok && !warnedNoTts) {
        warnedNoTts = true;
        void vscode.window.showWarningMessage(
            'No system text-to-speech engine found. On Linux install espeak-ng or speech-dispatcher. Or use the "Talk (in browser)" button, where your browser reads replies aloud.'
        );
    }
}

// ---------------------------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------------------------

function openPanel(context: vscode.ExtensionContext, session: Session, bridgeHint: string): void {
    const panel = vscode.window.createWebviewPanel(
        'codeWhispererVoice',
        'Code Whisperer Voice',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = panelHtml({ nonce: makeNonce(), cspSource: panel.webview.cspSource });

    let bridge: VoiceBridge | undefined;

    const run = async (utterance: string, source: 'panel' | 'browser') => {
        const reply = await session.handle(utterance);
        const state = session.snapshot();
        void panel.webview.postMessage({
            type: 'reply',
            text: reply.text,
            action: reply.action,
            heard: source === 'browser' ? utterance : undefined,
            state
        });
        if (source === 'panel') {
            void speakAloud(reply.text);
        }
        if (reply.done) {
            setTimeout(() => panel.dispose(), 1500);
        }
        return reply;
    };

    panel.webview.onDidReceiveMessage(
        async message => {
            switch (message?.type) {
                case 'ready': {
                    void panel.webview.postMessage({ type: 'state', state: session.snapshot() });
                    const intro = session.start?.();
                    if (intro) {
                        void panel.webview.postMessage({ type: 'reply', text: intro.text, action: intro.action, state: session.snapshot() });
                        void speakAloud(intro.text);
                    }
                    break;
                }
                case 'utterance': {
                    const text = typeof message.text === 'string' ? message.text.slice(0, 1000) : '';
                    if (!text.trim()) {
                        break;
                    }
                    speaker.stop();
                    try {
                        await run(text, 'panel');
                    } catch (err) {
                        void panel.webview.postMessage({ type: 'error', text: friendlyError(err) });
                    }
                    break;
                }
                case 'openVoice': {
                    try {
                        if (!bridge) {
                            bridge = new VoiceBridge({
                                handle: async text => {
                                    speaker.stop();
                                    return run(text, 'browser');
                                },
                                context: () => {
                                    const s = session.snapshot();
                                    return { title: s.title, subtitle: s.codeLabel, hint: bridgeHint };
                                }
                            });
                        }
                        const local = vscode.Uri.parse(await bridge.start());
                        // asExternalUri makes this work in Codespaces / Remote-SSH by forwarding the port.
                        const external = await vscode.env.asExternalUri(local);
                        await vscode.env.openExternal(external);
                        void panel.webview.postMessage({
                            type: 'status',
                            text: 'Voice page opened in your browser. Click its microphone and speak.'
                        });
                    } catch (err) {
                        void panel.webview.postMessage({ type: 'error', text: `Could not start voice page: ${friendlyError(err)}` });
                    }
                    break;
                }
                case 'stop':
                    speaker.stop();
                    break;
            }
        },
        undefined,
        context.subscriptions
    );

    panel.onDidDispose(() => {
        bridge?.dispose();
        speaker.stop();
    });
}

function friendlyError(err: unknown): string {
    return err instanceof Error ? err.message : 'Something went wrong.';
}

// ---------------------------------------------------------------------------------------------
// Command: explain the selection
// ---------------------------------------------------------------------------------------------

async function explainSelection(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        void vscode.window.showErrorMessage('No active editor found.');
        return;
    }
    const selectedCode = editor.document.getText(editor.selection);
    if (!selectedCode.trim()) {
        void vscode.window.showErrorMessage('Select some code first.');
        return;
    }

    const configured = cfg().get<string>('defaultVibe', 'Ask each time');
    let vibe: VibeMode | undefined = vibeModes.find(v => v.name === configured);
    if (!vibe) {
        const picked = await vscode.window.showQuickPick(
            vibeModes.map(v => ({ label: v.name, description: v.description, detail: v.prompt })),
            { placeHolder: 'Select explanation style' }
        );
        vibe = vibeModes.find(v => v.name === picked?.label);
    }
    if (!vibe) {
        return;
    }

    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const relPath = folder ? vscode.workspace.asRelativePath(editor.document.uri, false) : undefined;
    const startLine = editor.selection.start.line + 1;

    // If the user has run crumbs on an issue and this code is on its trail, say so to the model.
    let trailContext: string | undefined;
    if (folder && relPath) {
        const ctx = trailContextFor(folder.uri.fsPath, relPath, startLine);
        trailContext = ctx;
    }

    const session = new ExplainSession(makeDeps(context), {
        code: selectedCode,
        language: editor.document.languageId,
        fileLabel: relPath,
        startLine,
        vibe,
        trailContext
    });
    openPanel(context, session, 'Say what you want about the selected code: "explain this", "find bugs", "optimize this", "write tests"…');
}

function trailContextFor(root: string, relPath: string, line: number): string | undefined {
    for (const ref of findTrails(root)) {
        try {
            const trail = loadTrail(ref.file);
            const stop = stopForLocation(trail, relPath, line);
            if (stop) {
                return trailSummary(trail, stop);
            }
        } catch {
            /* ignore unreadable trails */
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------------------------
// Command: walk a crumbs trail
// ---------------------------------------------------------------------------------------------

async function walkTrail(context: vscode.ExtensionContext): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        void vscode.window.showErrorMessage('Open the project folder you ran crumbs in first.');
        return;
    }
    const trails = findTrails(folder.uri.fsPath);
    if (trails.length === 0) {
        const choice = await vscode.window.showInformationMessage(
            'No crumbs trail found in this folder (.crumbs/<issue>/trail.json). Run crumbs in your coding agent first, e.g. "/crumbs explain issue #123".',
            'Open crumbs'
        );
        if (choice === 'Open crumbs') {
            void vscode.env.openExternal(vscode.Uri.parse('https://github.com/navyabijoy/crumbs'));
        }
        return;
    }

    let chosen = trails[0];
    if (trails.length > 1) {
        const items = trails.map(t => {
            let title = '';
            try {
                title = loadTrail(t.file).plainTitle;
            } catch {
                title = '(unreadable trail.json)';
            }
            return { label: `Issue ${t.issue}`, description: title, trail: t };
        });
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Which issue do you want to walk through?' });
        if (!picked) {
            return;
        }
        chosen = picked.trail;
    }

    let trail: Trail;
    try {
        trail = loadTrail(chosen.file);
    } catch (err) {
        void vscode.window.showErrorMessage(`Could not read ${path.basename(path.dirname(chosen.file))}/trail.json: ${friendlyError(err)}`);
        return;
    }

    const vibeName = cfg().get<string>('defaultVibe', 'Mentor');
    const vibe = vibeModes.find(v => v.name === vibeName) ?? vibeModes[1];
    const depth = cfg().get<Depth>('crumbs.depth', 'detailed');
    const session = new TrailSession(makeDeps(context, folder.uri), trail, { vibe, depth });
    openPanel(context, session, 'Say "next", "back", "simpler", "deeper" or "repeat" to move through the trail, or ask a question about the current step.');
}
