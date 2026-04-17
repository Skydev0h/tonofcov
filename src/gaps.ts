/**
 * Coverage-gaps report — an LLM/agent-friendly view of what's uncovered,
 * joined with source snippets and AST-derived structural context.
 *
 * Emitted alongside lcov.info and the HTML report as `coverage/gaps.md`
 * and `coverage/gaps.json`. Agents writing tests read gaps.md, decide
 * how to trigger each gap from the code, and iterate.
 *
 * Design principle: facts only. We give location, source, and enclosing
 * structure. We do NOT generate natural-language hints like "trigger by
 * sending op::X" — the agent reasons from the code itself. Stays correct
 * even when our assumptions about the codebase would be wrong.
 *
 * Three kinds of gap, in priority order:
 *   1. UNCOVERED_FN    — a function with zero interior hits. Biggest
 *                        single-test win; one well-placed test call often
 *                        lights up the whole body.
 *   2. PARTIAL_THROW   — a conditional throw whose error branch never
 *                        fired (throws === 0) or always fired (throws
 *                        === hits). Error paths that weren't exercised.
 *   3. UNCOVERED_RANGE — contiguous uncovered lines inside an otherwise
 *                        covered function. Usually a branch of an if or
 *                        a case of a dispatch that tests didn't hit.
 */

import type { Coverage } from './types';
import type { Block, FuncAnalysis, FuncFunction, Conditional } from './func-ast';

export type UncoveredFunctionGap = {
    kind: 'UNCOVERED_FN';
    file: string;
    name: string;
    startLine: number;
    endLine: number;
    /** Tree-sitter function signature line, trimmed. */
    signature: string;
    /** Call sites where this function is referenced. Empty = possibly dead code. */
    callSites: Array<{ file: string; line: number }>;
    /** The function body (startLine..endLine inclusive), one line per entry. */
    source: string[];
};

export type PartialThrowGap = {
    kind: 'PARTIAL_THROW';
    file: string;
    line: number;
    /** The statement on that line, trimmed — e.g. `throw_unless(err::foo, cond)`. */
    statement: string;
    hits: number;
    throws: number;
    /** Why it's partial: error branch never fired, or always fired. */
    reason: 'never-fired' | 'always-fired';
    /** Enclosing function name + range. */
    enclosingFunction?: { name: string; startLine: number; endLine: number };
    /** Nearest enclosing if/while/repeat/do header line, if any — gives the condition that gates this throw. */
    enclosingConditional?: { headerLine: number };
    /** ~5 lines of context around the throw line, [startLine, text[]]. */
    context: { startLine: number; source: string[] };
};

export type UncoveredRangeGap = {
    kind: 'UNCOVERED_RANGE';
    file: string;
    startLine: number;
    endLine: number;
    enclosingFunction?: { name: string; startLine: number; endLine: number };
    /** Source for the uncovered range plus a couple of context lines. */
    context: { startLine: number; source: string[] };
};

export type Gap = UncoveredFunctionGap | PartialThrowGap | UncoveredRangeGap;

export type FileGaps = {
    file: string;
    totalExec: number;
    coveredExec: number;
    percentage: number;
    gaps: Gap[];
};

export function computeGaps(
    coverage: Coverage,
    analysis: FuncAnalysis,
    sources: Map<string, string>,
    nonExecByFile: Map<string, Set<number>>,
    shouldCount: (file: string) => boolean = () => true,
): FileGaps[] {
    const fileGaps: FileGaps[] = [];

    for (const [file, source] of sources) {
        if (!shouldCount(file)) continue;
        const fc = coverage.files.get(file);
        if (!fc) continue;

        const sourceLines = source.split(/\r?\n/);
        const nonExec = nonExecByFile.get(file) ?? new Set();

        // File-level totals for header.
        let totalExec = 0, coveredExec = 0;
        for (let i = 0; i < sourceLines.length; i++) {
            const lineNum = i + 1;
            if (!sourceLines[i].trim() || nonExec.has(lineNum)) continue;
            totalExec++;
            const stats = fc.lines.get(lineNum);
            if (stats && stats.hits > 0) coveredExec++;
        }
        const percentage = totalExec === 0 ? 100 : Math.round((coveredExec / totalExec) * 1000) / 10;

        const fileFunctions = analysis.functions.filter(f => f.file === file);
        const fileConditionals = analysis.conditionals.filter(c => c.file === file);

        const gaps: Gap[] = [];

        // --- 1. UNCOVERED FUNCTIONS ---
        for (const fn of fileFunctions) {
            if (fnHasInteriorHit(fc, fn)) continue;
            const sig = extractSignatureLine(sourceLines, fn.startLine);
            const body = sourceLines.slice(fn.startLine - 1, fn.endLine);
            const callSites = analysis.callSites
                .filter(c => c.callee === fn.name)
                // Don't include the definition line itself as a "call site".
                .filter(c => !(c.file === fn.file && c.line === fn.startLine))
                .map(c => ({ file: c.file, line: c.line }));
            gaps.push({
                kind: 'UNCOVERED_FN',
                file,
                name: fn.name,
                startLine: fn.startLine,
                endLine: fn.endLine,
                signature: sig,
                callSites,
                source: body,
            });
        }

        // --- 2. PARTIAL THROWS ---
        // Dedupe by conditional-throw call site (one entry per call, even
        // if it spans multiple source lines).
        const seenThrowOrigins = new Set<number>();
        for (const key of analysis.conditionalThrowSites) {
            if (!key.startsWith(`${file}:`)) continue;
            const originRef = analysis.throwStatementStart.get(key);
            const originLine = originRef?.line ?? Number(key.slice(file.length + 1));
            if (seenThrowOrigins.has(originLine)) continue;
            seenThrowOrigins.add(originLine);

            const stats = fc.lines.get(originLine);
            if (!stats || stats.hits === 0) continue; // wholly uncovered — will appear as UNCOVERED_FN or UNCOVERED_RANGE
            const throws = stats.throws ?? 0;
            if (throws > 0 && throws < stats.hits) continue; // both sides exercised

            const reason: 'never-fired' | 'always-fired' = throws === 0 ? 'never-fired' : 'always-fired';

            // Skip the "always-fired" case if it's an unconditional throw that
            // just happens to also be in conditionalThrowSites (it shouldn't,
            // but belt-and-braces).
            if (reason === 'always-fired' && analysis.unconditionalThrowSites.has(`${file}:${originLine}`)) continue;

            const enclFn = findEnclosingFn(fileFunctions, originLine);
            const enclCond = findEnclosingConditional(fileConditionals, originLine);
            const ctxStart = Math.max(1, originLine - 3);
            const ctxEnd = Math.min(sourceLines.length, originLine + 2);

            gaps.push({
                kind: 'PARTIAL_THROW',
                file,
                line: originLine,
                statement: (sourceLines[originLine - 1] ?? '').trim(),
                hits: stats.hits,
                throws,
                reason,
                enclosingFunction: enclFn ? { name: enclFn.name, startLine: enclFn.startLine, endLine: enclFn.endLine } : undefined,
                enclosingConditional: enclCond ? { headerLine: enclCond.headerLine } : undefined,
                context: {
                    startLine: ctxStart,
                    source: sourceLines.slice(ctxStart - 1, ctxEnd),
                },
            });
        }

        // --- 3. UNCOVERED RANGES inside covered functions ---
        for (const fn of fileFunctions) {
            if (!fnHasInteriorHit(fc, fn)) continue; // fully uncovered: already reported above
            const ranges = findUncoveredRangesInFn(fc, fn, sourceLines, nonExec);
            for (const r of ranges) {
                const ctxStart = Math.max(1, r.startLine - 2);
                const ctxEnd = Math.min(sourceLines.length, r.endLine + 1);
                gaps.push({
                    kind: 'UNCOVERED_RANGE',
                    file,
                    startLine: r.startLine,
                    endLine: r.endLine,
                    enclosingFunction: { name: fn.name, startLine: fn.startLine, endLine: fn.endLine },
                    context: {
                        startLine: ctxStart,
                        source: sourceLines.slice(ctxStart - 1, ctxEnd),
                    },
                });
            }
        }

        if (gaps.length > 0 || percentage < 100) {
            fileGaps.push({ file, totalExec, coveredExec, percentage, gaps });
        }
    }

    return fileGaps;
}

function fnHasInteriorHit(fc: { lines: Map<number, { hits: number }> }, fn: FuncFunction): boolean {
    for (const [line, stats] of fc.lines) {
        if (line > fn.startLine && line < fn.endLine && stats.hits > 0) return true;
    }
    return false;
}

function extractSignatureLine(sourceLines: string[], startLine: number): string {
    const raw = sourceLines[startLine - 1] ?? '';
    return raw.trim().replace(/\s+\{$/, '').trim();
}

function findEnclosingFn(fns: readonly FuncFunction[], line: number): FuncFunction | undefined {
    let best: FuncFunction | undefined;
    let bestSpan = Infinity;
    for (const f of fns) {
        if (line < f.startLine || line > f.endLine) continue;
        const span = f.endLine - f.startLine;
        if (span < bestSpan) { best = f; bestSpan = span; }
    }
    return best;
}

function findEnclosingConditional(conds: readonly Conditional[], line: number): Conditional | undefined {
    let best: Conditional | undefined;
    let bestSpan = Infinity;
    for (const c of conds) {
        // Use the largest body end across all bodies as the conditional's reach.
        let maxBodyEnd = c.headerLine;
        for (const [, bEnd] of c.bodies) if (bEnd > maxBodyEnd) maxBodyEnd = bEnd;
        if (line < c.headerLine || line > maxBodyEnd) continue;
        const span = maxBodyEnd - c.headerLine;
        if (span < bestSpan) { best = c; bestSpan = span; }
    }
    return best;
}

function findUncoveredRangesInFn(
    fc: { lines: Map<number, { hits: number }> },
    fn: FuncFunction,
    sourceLines: string[],
    nonExec: Set<number>,
): Array<{ startLine: number; endLine: number }> {
    const ranges: Array<{ startLine: number; endLine: number }> = [];
    let curStart: number | null = null;
    for (let line = fn.startLine + 1; line < fn.endLine; line++) {
        const raw = sourceLines[line - 1] ?? '';
        if (!raw.trim() || nonExec.has(line)) continue;
        const stats = fc.lines.get(line);
        const isUncovered = !stats || stats.hits === 0;
        if (isUncovered) {
            if (curStart === null) curStart = line;
        } else {
            if (curStart !== null) {
                ranges.push({ startLine: curStart, endLine: line - 1 });
                curStart = null;
            }
        }
    }
    if (curStart !== null) {
        // Walk back from endLine-1 to last uncovered line so we don't include trailing non-exec lines.
        let end = fn.endLine - 1;
        while (end >= curStart) {
            const raw = sourceLines[end - 1] ?? '';
            if (raw.trim() && !nonExec.has(end)) break;
            end--;
        }
        if (end >= curStart) ranges.push({ startLine: curStart, endLine: end });
    }
    return ranges;
}

// -------------------------------------------------------------------------
// Formatters
// -------------------------------------------------------------------------

export function formatGapsMarkdown(fileGaps: readonly FileGaps[]): string {
    const out: string[] = [];
    out.push('# Coverage gaps');
    out.push('');
    if (fileGaps.length === 0) {
        out.push('No uncovered code. All files at 100%.');
        return out.join('\n') + '\n';
    }

    const totals = {
        totalExec: fileGaps.reduce((s, f) => s + f.totalExec, 0),
        coveredExec: fileGaps.reduce((s, f) => s + f.coveredExec, 0),
        gapCount: fileGaps.reduce((s, f) => s + f.gaps.length, 0),
    };
    const overallPct = totals.totalExec === 0 ? 100 : Math.round((totals.coveredExec / totals.totalExec) * 1000) / 10;
    out.push(`Overall: ${totals.coveredExec} / ${totals.totalExec} lines (${overallPct}%) · ${totals.gapCount} gaps across ${fileGaps.length} file(s).`);
    out.push('');
    out.push('Gap kinds, in the order they appear per file:');
    out.push('1. **UNCOVERED_FN** — function with zero interior hits.');
    out.push('2. **PARTIAL_THROW** — conditional throw with one-sided outcome (error branch never fired, or always fired).');
    out.push('3. **UNCOVERED_RANGE** — contiguous uncovered lines inside an otherwise-covered function.');
    out.push('');
    out.push('---');
    out.push('');

    for (const fg of fileGaps) {
        out.push(`## ${fg.file} — ${fg.coveredExec}/${fg.totalExec} (${fg.percentage}%)`);
        out.push('');
        if (fg.gaps.length === 0) {
            out.push('No gaps.');
            out.push('');
            continue;
        }
        for (const gap of fg.gaps) {
            out.push(formatGapMarkdown(gap));
            out.push('');
        }
    }
    return out.join('\n');
}

function formatGapMarkdown(gap: Gap): string {
    const out: string[] = [];
    switch (gap.kind) {
        case 'UNCOVERED_FN': {
            out.push(`### UNCOVERED_FN · ${gap.name} @ L${gap.startLine}-L${gap.endLine} (${gap.endLine - gap.startLine + 1} lines)`);
            out.push(`- signature: \`${gap.signature}\``);
            if (gap.callSites.length === 0) {
                out.push(`- called-from: (none found — possibly dead code or referenced only indirectly)`);
            } else {
                const sites = gap.callSites.map(cs => `${cs.file}:${cs.line}`).join(', ');
                out.push(`- called-from: ${sites}`);
            }
            out.push('');
            out.push('```funC');
            for (let i = 0; i < gap.source.length; i++) {
                const lineNum = gap.startLine + i;
                out.push(`${String(lineNum).padStart(4)}  ${gap.source[i]}`);
            }
            out.push('```');
            break;
        }
        case 'PARTIAL_THROW': {
            const header = gap.reason === 'never-fired'
                ? `error branch never fired (hits=${gap.hits}, throws=0)`
                : `error branch always fired (hits=${gap.hits}, throws=${gap.throws})`;
            out.push(`### PARTIAL_THROW @ L${gap.line} — ${header}`);
            out.push(`- statement: \`${gap.statement}\``);
            if (gap.enclosingFunction) {
                out.push(`- enclosing fn: ${gap.enclosingFunction.name} (L${gap.enclosingFunction.startLine}-L${gap.enclosingFunction.endLine})`);
            }
            if (gap.enclosingConditional) {
                out.push(`- nearest conditional: header @ L${gap.enclosingConditional.headerLine}`);
            }
            out.push('');
            out.push('```funC');
            for (let i = 0; i < gap.context.source.length; i++) {
                const lineNum = gap.context.startLine + i;
                const marker = lineNum === gap.line ? ' >' : '  ';
                out.push(`${String(lineNum).padStart(4)}${marker}${gap.context.source[i]}`);
            }
            out.push('```');
            break;
        }
        case 'UNCOVERED_RANGE': {
            const span = gap.endLine - gap.startLine + 1;
            out.push(`### UNCOVERED_RANGE @ L${gap.startLine}-L${gap.endLine} (${span} line${span === 1 ? '' : 's'})`);
            if (gap.enclosingFunction) {
                out.push(`- inside fn: ${gap.enclosingFunction.name} (L${gap.enclosingFunction.startLine}-L${gap.enclosingFunction.endLine})`);
            }
            out.push('');
            out.push('```funC');
            for (let i = 0; i < gap.context.source.length; i++) {
                const lineNum = gap.context.startLine + i;
                const inGap = lineNum >= gap.startLine && lineNum <= gap.endLine;
                const marker = inGap ? ' >' : '  ';
                out.push(`${String(lineNum).padStart(4)}${marker}${gap.context.source[i]}`);
            }
            out.push('```');
            break;
        }
    }
    return out.join('\n');
}

export function formatGapsJson(fileGaps: readonly FileGaps[]): string {
    const totals = {
        totalExec: fileGaps.reduce((s, f) => s + f.totalExec, 0),
        coveredExec: fileGaps.reduce((s, f) => s + f.coveredExec, 0),
        gapCount: fileGaps.reduce((s, f) => s + f.gaps.length, 0),
    };
    const overallPct = totals.totalExec === 0 ? 100 : Math.round((totals.coveredExec / totals.totalExec) * 1000) / 10;
    return JSON.stringify({
        summary: { ...totals, percentage: overallPct, fileCount: fileGaps.length },
        files: fileGaps,
    }, null, 2) + '\n';
}
