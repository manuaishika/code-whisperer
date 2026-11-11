import { spawn, ChildProcess } from 'child_process';

/** Strip markdown and code noise so text reads naturally when spoken. */
export function toSpeakable(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, ' (code omitted) ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

export interface TtsCommand {
    command: string;
    args: string[];
    /** Text to write to the process's stdin (keeps it out of argv and away from shells). */
    stdin?: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Text-to-speech commands to try for a platform, in order of preference. Text is always passed on
 * stdin or after `--`, never interpolated into a shell string.
 * `rate` is a multiplier: 1 = normal speed.
 */
export function ttsCandidates(platform: NodeJS.Platform, text: string, rate = 1): TtsCommand[] {
    const wpm = Math.round(175 * clamp(rate, 0.5, 2));
    switch (platform) {
        case 'darwin':
            return [{ command: 'say', args: ['-r', String(wpm)], stdin: text }];
        case 'win32': {
            const winRate = clamp(Math.round((rate - 1) * 10), -10, 10);
            const script =
                '[Console]::InputEncoding=[Text.Encoding]::UTF8;' +
                'Add-Type -AssemblyName System.Speech;' +
                '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
                `$s.Rate=${winRate};` +
                '$s.Speak([Console]::In.ReadToEnd())';
            return [
                { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script], stdin: text }
            ];
        }
        default: {
            const spdRate = clamp(Math.round((rate - 1) * 100), -100, 100);
            return [
                { command: 'spd-say', args: ['--wait', '-r', String(spdRate), '--', text] },
                { command: 'espeak-ng', args: ['-s', String(wpm), '--stdin'], stdin: text },
                { command: 'espeak', args: ['-s', String(wpm), '--stdin'], stdin: text }
            ];
        }
    }
}

function run(cmd: TtsCommand, onSpawn: (p: ChildProcess) => void): Promise<boolean> {
    return new Promise(resolve => {
        let settled = false;
        const done = (ok: boolean) => {
            if (!settled) {
                settled = true;
                resolve(ok);
            }
        };
        let child: ChildProcess;
        try {
            child = spawn(cmd.command, cmd.args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
        } catch {
            done(false);
            return;
        }
        onSpawn(child);
        child.on('error', () => done(false)); // typically ENOENT: not installed
        child.on('close', code => done(code === 0 || code === null)); // null: we killed it
        child.stdin?.on('error', () => undefined);
        if (cmd.stdin !== undefined) {
            child.stdin?.end(cmd.stdin);
        } else {
            child.stdin?.end();
        }
    });
}

/** Speaks text through the operating system's built-in voice. */
export class Speaker {
    private current: ChildProcess | undefined;
    private generation = 0;

    constructor(private readonly platform: NodeJS.Platform = process.platform) {}

    /** Resolves true if some speech engine ran, false if none is available. */
    async speak(text: string, rate = 1): Promise<boolean> {
        const speakable = toSpeakable(text);
        if (!speakable) {
            return true;
        }
        this.stop();
        const myGeneration = ++this.generation;
        for (const candidate of ttsCandidates(this.platform, speakable, rate)) {
            if (myGeneration !== this.generation) {
                return true; // superseded by newer speech or stop()
            }
            if (await run(candidate, p => (this.current = p))) {
                return true;
            }
        }
        return myGeneration !== this.generation;
    }

    stop(): void {
        this.generation++;
        if (this.current && !this.current.killed) {
            this.current.kill();
        }
        this.current = undefined;
    }
}
