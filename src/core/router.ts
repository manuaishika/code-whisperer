import { voiceCommands, VoiceCommand } from './prompts';

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalise(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s']/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function countMatches(text: string, stems: string[] | undefined, weight: number): number {
    if (!stems) {
        return 0;
    }
    let score = 0;
    for (const stem of stems) {
        // Prefix match on a word boundary, so "optimi" matches "optimize"/"optimise"/"optimization"
        // but "test" does not match "latest".
        const re = new RegExp(`\\b${escapeRegex(stem)}`);
        if (re.test(text)) {
            // multi-word phrases are more specific, so they count double
            score += stem.includes(' ') ? weight * 2 : weight;
        }
    }
    return score;
}

export interface Detection {
    command: VoiceCommand;
    score: number;
}

/**
 * Pick the command a spoken utterance most likely refers to. Specific commands beat the generic
 * "explain" words ("what are the security risks" is a security request, not an explanation).
 * Falls back to "explain".
 */
export function detectCommand(utterance: string, commands: VoiceCommand[] = voiceCommands): Detection {
    const text = normalise(utterance);
    let best: Detection = { command: commands[0], score: 0 };
    for (const command of commands) {
        const score = countMatches(text, command.strong, 1) + countMatches(text, command.weak, 0.5);
        if (score > best.score) {
            best = { command, score };
        }
    }
    return best;
}

export type Control = 'next' | 'back' | 'repeat' | 'simpler' | 'deeper' | 'stop';

const FILLER = /^(?:(?:ok|okay|alright|now|please|go|and|then|can you|could you|let's|lets)\s+)+/;
const TRAILING = /\s+(?:please|now|again)$/;

const CONTROLS: Array<[Control, RegExp]> = [
    ['next', /^(?:next|next step|next one|continue|keep going|go on|move on|forward)$/],
    ['back', /^(?:back|go back|previous|previous step|last step|step back|before)$/],
    ['repeat', /^(?:repeat|repeat that|say that|say it|say that again|say it again|again|once more|what was that)$/],
    ['simpler', /^(?:simpler|simplify|simplify that|make it simpler|simple|less detail|shorter|eli5)$/],
    ['deeper', /^(?:deeper|go deeper|more detail|more details|more|detailed|tell me more|explain more|deep dive)$/],
    ['stop', /^(?:stop|quit|exit|end|done|finish|that's all|thats all|cancel|never mind)$/]
];

/**
 * Recognise short navigation commands used while walking through a crumbs trail
 * ("next", "go back", "say that again", "simpler"). Anything longer is a free-form question.
 */
export function parseControl(utterance: string): Control | null {
    let text = normalise(utterance);
    if (!text || text.split(' ').length > 6) {
        return null;
    }
    text = text.replace(FILLER, '').replace(TRAILING, '').trim();
    for (const [control, re] of CONTROLS) {
        if (re.test(text)) {
            return control;
        }
    }
    return null;
}
