import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('code-whisperer-voice.explainSelectedCodeVoice', async () => {
        vscode.window.showInformationMessage('Voice Mode command triggered!');
        // TODO: Implement WebView panel for voice input and TTS
    });
    context.subscriptions.push(disposable);
}

export function deactivate() {} 