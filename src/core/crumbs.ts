/**
 * Reader for trail.json files written by crumbs (https://github.com/navyabijoy/crumbs), the agent
 * skill that traces an issue to the code behind it. Code Whisperer narrates those trails by voice.
 *
 * trail.json comes from an agent that has read untrusted issue text, so everything here is treated
 * as data: it is validated defensively and never executed or interpreted as instructions.
 */
import * as fs from 'fs';
import * as path from 'path';

export type Depth = 'simple' | 'detailed' | 'deep';
export type Proof = 'reproduced-real' | 'reproduced-isolated' | 'read-in-code' | 'inferred';

export interface CodeRef {
    file: string;
    start: number;
    lines: string;
    highlight: number[];
    pointer?: string;
}

export interface StoryStep {
    chapter: string;
    title: string;
    simple?: string;
    detailed?: string;
    deep?: string;
    proof?: Proof;
    trail?: string;
    code?: CodeRef;
}

export interface TrailStop {
    id: string;
    plainLabel: string;
    label: string;
    file: string;
    start: number;
    end: number;
    role: string;
    whatItDoes?: string;
}

export interface Trail {
    repo: string;
    issue: string;
    issueUrl?: string;
    plainTitle: string;
    tldr?: { problem?: string; cause?: string; change?: string };
    aiPolicy?: { text: string; source?: string };
    story: StoryStep[];
    stops: TrailStop[];
}

export interface TrailRef {
    issue: string;
    file: string;
    mtimeMs: number;
}

const PROOFS: Proof[] = ['reproduced-real', 'reproduced-isolated', 'read-in-code', 'inferred'];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);

/** Reject paths that could escape the repository: absolute, drive-lettered or containing "..". */
export function isSafeRelativePath(p: string): boolean {
    if (!p || p.includes('\0')) {
        return false;
    }
    const normalised = p.replace(/\\/g, '/');
    if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) {
        return false;
    }
    return !normalised.split('/').includes('..');
}

function parseCode(raw: unknown, fallbackFile?: string): CodeRef | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const r = raw as Record<string, unknown>;
    const file = str(r.file) ?? fallbackFile;
    const start = int(r.start);
    const lines = typeof r.lines === 'string' ? r.lines : undefined;
    if (!file || !isSafeRelativePath(file) || start === undefined || lines === undefined) {
        return undefined;
    }
    const highlight = Array.isArray(r.highlight)
        ? r.highlight.map(int).filter((n): n is number => n !== undefined)
        : [];
    return { file, start, lines, highlight, pointer: str(r.pointer) };
}

/** Parse and validate trail.json content. Throws Error with a readable message if unusable. */
export function parseTrail(json: string): Trail {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        throw new Error('trail.json is not valid JSON.');
    }
    if (!raw || typeof raw !== 'object') {
        throw new Error('trail.json must contain an object.');
    }
    const r = raw as Record<string, unknown>;
    const plainTitle = str(r.plainTitle);
    const issue = str(r.issue) ?? (typeof r.issue === 'number' ? String(r.issue) : undefined);
    if (!plainTitle || !issue) {
        throw new Error('trail.json is missing "issue" or "plainTitle", so it does not look like a crumbs trail.');
    }

    const story: StoryStep[] = [];
    if (Array.isArray(r.story)) {
        for (const chapter of r.story) {
            const c = chapter as Record<string, unknown> | null;
            const chapterName = str(c?.chapter) ?? 'Story';
            const steps = Array.isArray(c?.steps) ? (c?.steps as unknown[]) : [];
            for (const s of steps) {
                const step = s as Record<string, unknown> | null;
                if (!step || typeof step !== 'object') {
                    continue;
                }
                const simple = str(step.simple);
                const detailed = str(step.detailed);
                if (!simple && !detailed) {
                    continue;
                }
                const proof = PROOFS.find(p => p === step.proof);
                story.push({
                    chapter: chapterName,
                    title: str(step.title) ?? chapterName,
                    simple,
                    detailed,
                    deep: str(step.deep),
                    proof,
                    trail: str(step.trail),
                    code: parseCode(step.code)
                });
            }
        }
    }

    const stops: TrailStop[] = [];
    if (Array.isArray(r.trail)) {
        for (const s of r.trail) {
            const stop = s as Record<string, unknown> | null;
            const file = str(stop?.file);
            const start = int(stop?.start);
            if (!stop || !file || !isSafeRelativePath(file) || start === undefined) {
                continue;
            }
            stops.push({
                id: str(stop.id) ?? `t${stops.length + 1}`,
                plainLabel: str(stop.plainLabel) ?? str(stop.label) ?? file,
                label: str(stop.label) ?? file,
                file,
                start,
                end: int(stop.end) ?? start,
                role: str(stop.role) ?? 'path',
                whatItDoes: str(stop.whatItDoes)
            });
        }
    }

    // A step that points at a trail stop but carries no code of its own can still be located.
    for (const step of story) {
        if (!step.code && step.trail) {
            const stop = stops.find(s => s.id === step.trail);
            if (stop) {
                step.code = { file: stop.file, start: stop.start, lines: '', highlight: [] };
            }
        }
    }

    const tldr = r.tldr && typeof r.tldr === 'object' ? (r.tldr as Record<string, unknown>) : undefined;
    const policy = r.aiPolicy && typeof r.aiPolicy === 'object' ? (r.aiPolicy as Record<string, unknown>) : undefined;
    const policyText = str(policy?.text);

    return {
        repo: str(r.repo) ?? 'unknown repository',
        issue,
        issueUrl: str(r.issueUrl),
        plainTitle,
        tldr: tldr ? { problem: str(tldr.problem), cause: str(tldr.cause), change: str(tldr.change) } : undefined,
        aiPolicy: policyText ? { text: policyText, source: str(policy?.source) } : undefined,
        story,
        stops
    };
}

/** Find .crumbs/<issue>/trail.json files under a repository root, newest first. */
export function findTrails(root: string): TrailRef[] {
    const base = path.join(root, '.crumbs');
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
        return [];
    }
    const found: TrailRef[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const file = path.join(base, entry.name, 'trail.json');
        try {
            const stat = fs.statSync(file);
            if (stat.isFile()) {
                found.push({ issue: entry.name, file, mtimeMs: stat.mtimeMs });
            }
        } catch {
            /* no trail.json in this folder */
        }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function loadTrail(file: string): Trail {
    return parseTrail(fs.readFileSync(file, 'utf8'));
}

/** Which trail stop, if any, covers a line of a file? `relPath` is relative to the repo root. */
export function stopForLocation(trail: Trail, relPath: string, line: number): TrailStop | undefined {
    const rel = relPath.replace(/\\/g, '/');
    return trail.stops.find(
        s => s.file.replace(/\\/g, '/') === rel && line >= s.start && line <= Math.max(s.end, s.start)
    );
}

/** The wording of a step at a given depth. "deep" adds to "detailed" rather than replacing it. */
export function stepText(step: StoryStep, depth: Depth): string {
    const simple = step.simple ?? step.detailed ?? '';
    const detailed = step.detailed ?? step.simple ?? '';
    if (depth === 'simple') {
        return simple;
    }
    if (depth === 'deep' && step.deep) {
        return `${detailed} ${step.deep}`;
    }
    return detailed;
}

const PROOF_SPOKEN: Record<Proof, string> = {
    'reproduced-real': 'Confirmed by running the real failing test.',
    'reproduced-isolated': 'Confirmed with a smaller stand-in, not the real test.',
    'read-in-code': 'Read from the code, not run.',
    inferred: 'This part is an inference, so check it before relying on it.'
};

export function proofSpoken(proof: Proof | undefined): string {
    return proof ? PROOF_SPOKEN[proof] : '';
}

export function proofLabel(proof: Proof | undefined): string {
    switch (proof) {
        case 'reproduced-real':
            return 'Reproduced: real test';
        case 'reproduced-isolated':
            return 'Reproduced: isolated';
        case 'read-in-code':
            return 'Read in code';
        case 'inferred':
            return 'Inferred';
        default:
            return '';
    }
}

/** One-paragraph summary of an issue trail, used as grounding context for the language model. */
export function trailSummary(trail: Trail, stop?: TrailStop): string {
    const lines = [`Issue ${trail.issue} in ${trail.repo}: ${trail.plainTitle}.`];
    if (trail.tldr?.problem) {
        lines.push(`Problem: ${trail.tldr.problem}`);
    }
    if (trail.tldr?.cause) {
        lines.push(`Cause: ${trail.tldr.cause}`);
    }
    if (trail.tldr?.change) {
        lines.push(`Where to change: ${trail.tldr.change}`);
    }
    if (stop) {
        lines.push(
            `The selected code is stop "${stop.plainLabel}" (${stop.role}) on the trail` +
                (stop.whatItDoes ? `: ${stop.whatItDoes}` : '.')
        );
    }
    return lines.join('\n');
}
