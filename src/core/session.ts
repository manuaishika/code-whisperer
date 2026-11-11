import { buildExplainPrompt, SAFETY_NOTE, SPOKEN_STYLE, VibeMode, voiceCommands } from './prompts';
import { detectCommand, parseControl } from './router';
import { basisLabel, basisSpoken, buildWalkthroughPrompt, Depth, parseWalkthrough, stepText, Walkthrough } from './walkthrough';

export interface Reply {
    text: string;
    /** Short label for what was done, e.g. "Find bugs and issues" or "Step 2 of 5". */
    action: string;
    /** True when the session has finished (e.g. the user said "stop"). */
    done?: boolean;
}

export interface CodeView {
    /** 1-based line number of the first line shown. */
    start: number;
    lines: string[];
    /** Absolute 1-based line numbers to emphasise. */
    highlight: number[];
}

export interface PanelState {
    mode: 'explain' | 'walkthrough';
    title: string;
    badge: string;
    codeLabel: string;
    code: CodeView | null;
    step: { index: number; total: number; title: string; basis: string } | null;
    commands: Array<{ icon: string; label: string; example: string }> | null;
    placeholder: string;
}

export interface Location {
    /** Absolute 1-based line numbers in the document the code was selected from. */
    start: number;
    end: number;
}

export interface SessionDeps {
    complete(system: string, user: string): Promise<string>;
    /** Called when a walkthrough step wants the editor to highlight some lines. */
    reveal?(loc: Location): void;
}

export interface Session {
    readonly mode: 'explain' | 'walkthrough';
    snapshot(): PanelState;
    /** Optional opening narration, spoken when the panel opens. */
    start?(): Reply | undefined;
    handle(utterance: string): Promise<Reply>;
}

const MAX_PREVIEW_LINES = 200;

export interface CodeOptions {
    code: string;
    language?: string;
    /** Workspace-relative path, used in prompts and the panel header. */
    fileLabel?: string;
    /** 1-based line of the first selected line in its document. */
    startLine?: number;
    vibe: VibeMode;
}

/** "Explain / optimise / find bugs in this selection" by voice or text. */
export class ExplainSession implements Session {
    readonly mode = 'explain' as const;

    constructor(private readonly deps: SessionDeps, private readonly opts: CodeOptions) {}

    snapshot(): PanelState {
        const lines = this.opts.code.split('\n').slice(0, MAX_PREVIEW_LINES);
        return {
            mode: 'explain',
            title: 'Code Whisperer Voice',
            badge: `${this.opts.vibe.name} mode`,
            codeLabel: this.opts.fileLabel ?? 'Selected code',
            code: { start: this.opts.startLine ?? 1, lines, highlight: [] },
            step: null,
            commands: voiceCommands.map(c => ({ icon: c.icon, label: c.label, example: c.example })),
            placeholder: 'Type what you want, e.g. "find bugs"'
        };
    }

    async handle(utterance: string): Promise<Reply> {
        const { command } = detectCommand(utterance);
        const { system, user } = buildExplainPrompt({
            vibe: this.opts.vibe,
            command,
            utterance,
            code: this.opts.code,
            language: this.opts.language,
            fileLabel: this.opts.fileLabel
        });
        const text = await this.deps.complete(system, user);
        return { text, action: command.label };
    }
}

export interface WalkOptions extends CodeOptions {
    depth: Depth;
}

/**
 * Spoken, step-by-step tour of the selected code: "next", "back", "simpler", "deeper", "repeat",
 * "stop", or any question about the step you're on.
 */
export class WalkthroughSession implements Session {
    readonly mode = 'walkthrough' as const;
    private index = -1; // -1 = overview
    private depth: Depth;

    private constructor(
        private readonly deps: SessionDeps,
        private readonly opts: WalkOptions,
        private readonly plan: Walkthrough
    ) {
        this.depth = opts.depth;
    }

    /** Ask the model for a walkthrough of the selection and wrap it in a session. */
    static async create(deps: SessionDeps, opts: WalkOptions): Promise<WalkthroughSession> {
        const { system, user } = buildWalkthroughPrompt({
            code: opts.code,
            language: opts.language,
            fileLabel: opts.fileLabel,
            vibePrompt: opts.vibe.prompt
        });
        const reply = await deps.complete(system, user);
        const plan = parseWalkthrough(reply, opts.code.split('\n').length);
        return new WalkthroughSession(deps, opts, plan);
    }

    get stepCount(): number {
        return this.plan.steps.length;
    }

    snapshot(): PanelState {
        const step = this.index >= 0 ? this.plan.steps[this.index] : undefined;
        const lines = this.opts.code.split('\n').slice(0, MAX_PREVIEW_LINES);
        const first = this.opts.startLine ?? 1;
        const highlight: number[] = [];
        if (step) {
            for (let n = step.startLine; n <= step.endLine; n++) {
                highlight.push(first + n - 1);
            }
        }
        return {
            mode: 'walkthrough',
            title: 'Walkthrough',
            badge: `${this.depth} · ${this.opts.vibe.name}`,
            codeLabel: this.opts.fileLabel ?? 'Selected code',
            code: { start: first, lines, highlight },
            step: step
                ? { index: this.index + 1, total: this.plan.steps.length, title: step.title, basis: basisLabel(step.basis) }
                : null,
            commands: null,
            placeholder: 'Say "next" or "back", or ask a question'
        };
    }

    start(): Reply {
        return {
            text: `${this.plan.overview} There are ${this.plan.steps.length} steps. Say next to begin.`,
            action: 'Overview'
        };
    }

    async handle(utterance: string): Promise<Reply> {
        switch (parseControl(utterance)) {
            case 'next':
                return this.goTo(this.index + 1);
            case 'back':
                return this.index <= 0 ? this.start() : this.goTo(this.index - 1);
            case 'repeat':
                return this.index < 0 ? this.start() : this.goTo(this.index);
            case 'simpler':
                return this.changeDepth(this.depth === 'deep' ? 'detailed' : 'simple');
            case 'deeper':
                return this.changeDepth(this.depth === 'simple' ? 'detailed' : 'deep');
            case 'stop':
                return { text: 'Okay, stopping the walkthrough.', action: 'Stopped', done: true };
            default:
                return this.answer(utterance);
        }
    }

    private goTo(i: number): Reply {
        if (i >= this.plan.steps.length) {
            this.index = this.plan.steps.length - 1;
            return { text: "That's the end of the walkthrough. Say back to revisit a step, or stop to finish.", action: 'End' };
        }
        this.index = Math.max(0, i);
        return this.narrate();
    }

    private changeDepth(depth: Depth): Reply {
        const changed = depth !== this.depth;
        this.depth = depth;
        if (this.index < 0) {
            return {
                text: changed ? `Okay, ${depth} explanations. Say next to begin.` : `Already at ${depth}. Say next to begin.`,
                action: 'Depth'
            };
        }
        const reply = this.narrate();
        const note = changed ? '' : depth === 'simple' ? "That's already as simple as it gets. " : "That's already the deepest level. ";
        return { ...reply, text: note + reply.text };
    }

    private narrate(): Reply {
        const step = this.plan.steps[this.index];
        const parts = [`Step ${this.index + 1} of ${this.plan.steps.length}. ${step.title}.`, stepText(step, this.depth)];
        const note = basisSpoken(step.basis);
        if (note) {
            parts.push(note);
        }
        const first = this.opts.startLine ?? 1;
        this.deps.reveal?.({ start: first + step.startLine - 1, end: first + step.endLine - 1 });
        return { text: parts.join(' '), action: `Step ${this.index + 1} of ${this.plan.steps.length}` };
    }

    private async answer(question: string): Promise<Reply> {
        const step = this.index >= 0 ? this.plan.steps[this.index] : undefined;
        const context = [`Overview: ${this.plan.overview}`];
        if (step) {
            context.push(`Current step ${this.index + 1} of ${this.plan.steps.length}: ${step.title}. ${stepText(step, 'deep')}`);
        }
        const system =
            `You are guiding someone through a piece of code, step by step. ${this.opts.vibe.prompt} ${SAFETY_NOTE}`;
        const user = [
            '<walkthrough_context>',
            context.join('\n'),
            '</walkthrough_context>',
            '',
            `<code_under_review${this.opts.fileLabel ? ` file="${this.opts.fileLabel}"` : ''}>`,
            this.opts.code,
            '</code_under_review>',
            '',
            `They ask: "${question}"`,
            'Answer from the code and context above. If they do not contain the answer, say so plainly instead of guessing.',
            SPOKEN_STYLE
        ].join('\n');
        const text = await this.deps.complete(system, user);
        return { text, action: 'Question' };
    }
}
