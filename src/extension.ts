import * as vscode from 'vscode';
import OpenAI from 'openai';

interface VibeMode {
    name: string;
    description: string;
    prompt: string;
}

const vibeModes: VibeMode[] = [
    {
        name: 'Casual',
        description: 'Friendly and relaxed explanation',
        prompt: 'Explain this code in a casual, friendly way as if you\'re talking to a friend.'
    },
    {
        name: 'Mentor',
        description: 'Educational and encouraging',
        prompt: 'Explain this code as a supportive mentor would, with educational insights and encouragement.'
    },
    {
        name: 'Professional',
        description: 'Formal and technical',
        prompt: 'Provide a professional, technical explanation of this code suitable for a business context.'
    }
];

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('code-whisperer-voice.explainSelectedCodeVoice', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found');
            return;
        }

        const selection = editor.selection;
        const selectedCode = editor.document.getText(selection);
        
        if (!selectedCode.trim()) {
            vscode.window.showErrorMessage('No code selected');
            return;
        }

        // Show vibe mode selection
        const vibeModeItems = vibeModes.map(mode => ({
            label: mode.name,
            description: mode.description,
            detail: mode.prompt
        }));
        
        const selectedVibeItem = await vscode.window.showQuickPick(vibeModeItems, {
            placeHolder: 'Select explanation style',
            canPickMany: false
        });

        if (!selectedVibeItem) {
            return;
        }

        const selectedVibe = vibeModes.find(mode => mode.name === selectedVibeItem.label);
        if (!selectedVibe) {
            return;
        }

        // Create and show WebView for voice input
        const panel = vscode.window.createWebviewPanel(
            'codeWhispererVoice',
            'Code Whisperer Voice',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        panel.webview.html = getWebviewContent(selectedCode, selectedVibe);
        
        // Handle messages from WebView
        panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'explainCode':
                        await handleExplainCode(message.voiceCommand, selectedCode, selectedVibe, panel);
                        break;
                    case 'speakText':
                        panel.webview.postMessage({ command: 'speak', text: message.text });
                        break;
                }
            },
            undefined,
            context.subscriptions
        );
    });

    context.subscriptions.push(disposable);
}

async function handleExplainCode(voiceCommand: string, selectedCode: string, vibeMode: VibeMode, panel: vscode.WebviewPanel) {
    try {
        // Get OpenAI API key from settings
        const config = vscode.workspace.getConfiguration('codeWhispererVoice');
        const apiKey = config.get<string>('openaiApiKey');
        
        if (!apiKey) {
            vscode.window.showErrorMessage('OpenAI API key not configured. Please set it in settings.');
            return;
        }

        const openai = new OpenAI({ apiKey });

        const prompt = `${vibeMode.prompt}

Voice command: "${voiceCommand}"
Code to explain:
\`\`\`
${selectedCode}
\`\`\`

Please provide a clear explanation that would be suitable for text-to-speech (avoid complex formatting, use natural language).`;

        const completion = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: 'You are a helpful coding assistant that explains code in a natural, conversational way suitable for voice output.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: 500,
            temperature: 0.7
        });

        const explanation = completion.choices[0]?.message?.content || 'Sorry, I couldn\'t generate an explanation.';
        
        // Send explanation back to WebView for TTS
        panel.webview.postMessage({ 
            command: 'explanationReady', 
            text: explanation,
            vibeMode: vibeMode.name
        });

    } catch (error) {
        console.error('Error explaining code:', error);
        vscode.window.showErrorMessage('Error generating explanation. Please check your API key and try again.');
    }
}

function getWebviewContent(selectedCode: string, vibeMode: VibeMode): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Code Whisperer Voice</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 20px;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        .vibe-mode {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 8px 16px;
            border-radius: 20px;
            display: inline-block;
            margin-bottom: 20px;
        }
        .code-preview {
            background: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-textBlockQuote-border);
            border-radius: 6px;
            padding: 15px;
            margin: 20px 0;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            font-size: 12px;
            max-height: 200px;
            overflow-y: auto;
        }
        .voice-controls {
            text-align: center;
            margin: 30px 0;
        }
        .mic-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 50%;
            width: 80px;
            height: 80px;
            font-size: 24px;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .mic-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .mic-button.recording {
            background: #ff4444;
            animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.1); }
            100% { transform: scale(1); }
        }
        .status {
            margin: 20px 0;
            padding: 10px;
            border-radius: 6px;
            text-align: center;
        }
        .status.listening {
            background: var(--vscode-inputValidation-infoBackground);
            color: var(--vscode-inputValidation-infoForeground);
        }
        .status.processing {
            background: var(--vscode-progressBar-background);
            color: var(--vscode-progressBar-foreground);
        }
        .explanation {
            background: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-textBlockQuote-border);
            border-radius: 6px;
            padding: 20px;
            margin: 20px 0;
            line-height: 1.6;
        }
        .hidden {
            display: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎤 Code Whisperer Voice</h1>
            <div class="vibe-mode">${vibeMode.name} Mode</div>
        </div>

        <div class="code-preview">
            <strong>Selected Code:</strong><br>
            <pre>${selectedCode}</pre>
        </div>

        <div class="voice-controls">
            <button id="micButton" class="mic-button" onclick="toggleRecording()">
                🎤
            </button>
            <p>Click the microphone and say "explain this" or similar</p>
        </div>

        <div id="status" class="status hidden"></div>
        <div id="explanation" class="explanation hidden"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let recognition;
        let isRecording = false;

        // Initialize speech recognition
        if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            recognition = new SpeechRecognition();
            recognition.continuous = false;
            recognition.interimResults = false;
            recognition.lang = 'en-US';

            recognition.onstart = () => {
                showStatus('Listening...', 'listening');
                document.getElementById('micButton').classList.add('recording');
            };

            recognition.onresult = (event) => {
                const transcript = event.results[0][0].transcript.toLowerCase();
                showStatus('Processing...', 'processing');
                document.getElementById('micButton').classList.remove('recording');
                
                // Send voice command to extension
                vscode.postMessage({
                    command: 'explainCode',
                    voiceCommand: transcript
                });
            };

            recognition.onerror = (event) => {
                console.error('Speech recognition error:', event.error);
                showStatus('Error: ' + event.error, 'error');
                document.getElementById('micButton').classList.remove('recording');
            };

            recognition.onend = () => {
                document.getElementById('micButton').classList.remove('recording');
            };
        } else {
            showStatus('Speech recognition not supported in this browser', 'error');
        }

        function toggleRecording() {
            if (!recognition) return;
            
            if (isRecording) {
                recognition.stop();
                isRecording = false;
            } else {
                recognition.start();
                isRecording = true;
            }
        }

        function showStatus(message, type) {
            const statusEl = document.getElementById('status');
            statusEl.textContent = message;
            statusEl.className = 'status ' + type;
            statusEl.classList.remove('hidden');
        }

        function hideStatus() {
            document.getElementById('status').classList.add('hidden');
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'explanationReady':
                    hideStatus();
                    const explanationEl = document.getElementById('explanation');
                    explanationEl.innerHTML = '<strong>Explanation (' + message.vibeMode + ' mode):</strong><br><br>' + message.text;
                    explanationEl.classList.remove('hidden');
                    
                    // Auto-speak the explanation
                    speakText(message.text);
                    break;
                    
                case 'speak':
                    speakText(message.text);
                    break;
            }
        });

        function speakText(text) {
            if ('speechSynthesis' in window) {
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.rate = 0.9;
                utterance.pitch = 1;
                speechSynthesis.speak(utterance);
            }
        }
    </script>
</body>
</html>`;
}

export function deactivate() {} 