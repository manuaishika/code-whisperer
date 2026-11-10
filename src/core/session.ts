import { buildExplainPrompt, SAFETY_NOTE, SPOKEN_STYLE, VibeMode, voiceCommands } from './prompts';
import { detectCommand, parseControl } from './router';
import { Depth, proofLabel, proofSpoken, StoryStep, stepText, Trail, trailSummary } from './crumbs';

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
    pointer?: string;
}

export interface PanelState {
    mode: 'explain' | 'trail';
    title: string;
    badge: string;
    codeLabel: string;
    code: CodeView | null;
    step: { index: number; total: number; title: string; chapter: string; proof: string } | null;
    commands: Array<{ icon: string; label: string; example: string }> | null;
    placeholder: string;
}

export interface Location {
    file: string;
    start: number;
    end: number;
}

export interface SessionDeps {
    complete(system: string, user: string): Promise<string>;
    /** Called when a trail step wants an editor to jump to some code. */
    reveal?(loc: Location): void;
}

export interface Session {
    readonly mode: 'explain' | 'trail';
    snapshot(): PanelState;
    /** Optional opening narration, spoken when the panel opens. */
    start?(): Reply | undefined;
    handle(utterance: string): Promise<Reply>;
}

const MAX_PREVIEW_LINES = 200;

export interface ExplainOptions {
    code: string;
    language?: string;
    /** Workspace-relative path, used in prompts and the panel header. */
    fileLabel?: string;
    startLine?: number;
    vibe: VibeMode;
    trailContext?: string;
}

/** "Explain / optimise / find bugs in this selection" by voice or text. */
export class ExplainSession implements Session {
    readonly mode = 'explain' as const;

    constructor(private readonly deps: SessionDeps, private readonly opts: ExplainOptions) {}

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
            fileLabel: this.opts.fileLabel,
            trailContext: this.opts.trailContext
        });
        const text = await this.deps.complete(system, user);
        return { text, action: command.label };
    }
}

export interface TrailOptions {
    vibe: VibeMode;
    depth: Depth;
}

/**
 * Spoken walkthrough of a crumbs trail: "next", "back", "simpler", "deeper", "repeat", "stop",
 * or any free question about the step you're on.
 */
export class TrailSession implements Session {
    readonly mode = 'trail' as const;
    private index = -1; // -1 = introduction
    private depth: Depth;
    private readonly steps: StoryStep[];

    constructor(private readonly deps: SessionDeps, private readonly trail: Trail, private readonly opts: TrailOptions) {
        this.depth = opts.depth;
        this.steps = trail.story.length > 0 ? trail.story : stopsAsSteps(trail);
    }

    get stepCount(): number {
        return this.steps.length;
    }

    get currentIndex(): number {
        return this.index;
    }

    snapshot(): PanelState {
        const step = this.index >= 0 ? this.steps[this.index] : undefined;
        const code = step?.code && step.code.lines ? step.code : undefined;
        return {
            mode: 'trail',
            title: `Issue ${this.trail.issue}`,
            badge: `${this.depth} · ${this.opts.vibe.name}`,
            codeLabel: step?.code ? `${step.code.file}:${step.code.start}` : this.trail.plainTitle,
            code: code
                ? { start: code.start, lines: code.lines.split('\n'), highlight: code.highlight, pointer: code.pointer }
                : null,
            step: step
                ? {
                      index: this.index + 1,
                      total: this.steps.length,
                      title: step.title,
                      chapter: step.chapter,
                      proof: proofLabel(step.proof)
                  }
                : null,
            commands: null,
            placeholder: 'Say "next" or "back", or ask a question'
        };
    }

    start(): Reply {
        const parts = [`Walking through issue ${this.trail.issue}: ${this.trail.plainTitle}.`];
        if (this.trail.aiPolicy) {
            parts.push(`Before you start, note the project's rule on AI-assisted contributions: ${this.trail.aiPolicy.text}`);
        }
        const { problem, cause, change } = this.trail.tldr ?? {};
        if (problem) {
            parts.push(`The problem: ${problem}`);
        }
        if (cause) {
            parts.push(`The cause: ${cause}`);
        }
        if (change) {
            parts.push(`Where you would change it: ${change}`);
        }
        parts.push(
            this.steps.length > 0
                ? `There are ${this.steps.length} steps. Say next to begin.`
                : 'This trail has no walkthrough steps.'
        );
        return { text: parts.join(' '), action: 'Introduction' };
    }

    async handle(utterance: string): Promise<Reply> {
        const control = parseControl(utterance);
        switch (control) {
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
        if (this.steps.length === 0) {
            return this.start();
        }
        if (i >= this.steps.length) {
            this.index = this.steps.length - 1;
            return { text: "That's the end of the trail. Say back to revisit a step, or stop to finish.", action: 'End' };
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
        const step = this.steps[this.index];
        const parts = [`Step ${this.index + 1} of ${this.steps.length}. ${step.title}.`, stepText(step, this.depth)];
        if (this.depth !== 'simple' && step.code?.pointer) {
            parts.push(`Look at this: ${step.code.pointer}`);
        }
        const proof = proofSpoken(step.proof);
        if (proof) {
            parts.push(proof);
        }
        if (step.code && this.deps.reveal) {
            const { start, highlight, lines } = step.code;
            const lineCount = lines ? lines.split('\n').length : 1;
            const first = highlight.length > 0 ? Math.min(...highlight) : start;
            const last = highlight.length > 0 ? Math.max(...highlight) : start + lineCount - 1;
            this.deps.reveal({ file: step.code.file, start: first, end: last });
        }
        return { text: parts.join(' '), action: `Step ${this.index + 1} of ${this.steps.length}` };
    }

    private async answer(question: string): Promise<Reply> {
        const step = this.index >= 0 ? this.steps[this.index] : undefined;
        const context: string[] = [trailSummary(this.trail)];
        if (step) {
            context.push(`Current step ${this.index + 1} of ${this.steps.length}: ${step.title}. ${stepText(step, 'deep')}`);
            if (step.code?.lines) {
                context.push(`Code (${step.code.file}:${step.code.start}):\n${step.code.lines}`);
            }
        }
        const system =
            `You are guiding a newcomer through the code behind an open-source issue, step by step. ` +
            `${this.opts.vibe.prompt} ${SAFETY_NOTE}`;
        const user = [
            '<trail_context>',
            context.join('\n\n'),
            '</trail_context>',
            '',
            `The contributor asks: "${question}"`,
            'Answer using only the trail context above. If it does not contain the answer, say so plainly instead of guessing, and suggest what to look at.',
            SPOKEN_STYLE
        ].join('\n');
        const text = await this.deps.complete(system, user);
        return { text, action: 'Question' };
    }
}

function stopsAsSteps(trail: Trail): StoryStep[] {
    return trail.stops
        .filter(s => s.whatItDoes)
        .map(s => ({
            chapter: 'Trail',
            title: s.plainLabel,
            detailed: s.whatItDoes,
            trail: s.id,
            code: { file: s.file, start: s.start, lines: '', highlight: [] }
        }));
}
