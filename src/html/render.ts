/**
 * Per-file HTML page renderer. Builds a table with:
 *   - hits column
 *   - line number column
 *   - 6px colored marker column (green covered / red uncovered / yellow
 *     partial-branch / empty non-exec)
 *   - syntax-highlighted source column
 *
 * Row background follows the same coverage class as the marker so the file
 * is readable both at a glance (row tint) and precisely (marker strip).
 */

import type { FileCoverage, LineStats, SuspectLine } from '../types';
import { escapeHtml, renderLine, tokenizeFunC } from './highlight';
import { buildNonExecSet } from './render-internals';

type RowClass = 'r-covered' | 'r-uncovered' | 'r-partial' | 'r-nonexec';
type MarkerClass = 'green' | 'red' | 'yellow' | '';

function classifyLine(
    lineNum: number,
    raw: string,
    coverage: FileCoverage,
    nonExec: Set<number>,
    isConditionalThrow: boolean,
    throwOriginStats?: LineStats,
): { row: RowClass; mark: MarkerClass; hitsLabel: string } {
    const stats: LineStats | undefined = coverage.lines.get(lineNum);
    if (stats && stats.hits > 0) {
        // Conditional throw (throw_if/throw_unless) with one-sided outcome —
        // either never fired (throws=0) or always fired (throws=hits) — is
        // only half-covered at the branch level. Flag as partial so it reads
        // as yellow in the report. For multi-line throws, we consult the
        // ORIGIN line's stats (throws counter only lives there) rather than
        // the continuation line's.
        if (isConditionalThrow) {
            const source = throwOriginStats ?? stats;
            const throws = source.throws ?? 0;
            if (throws === 0 || throws === source.hits) {
                return { row: 'r-partial', mark: 'yellow', hitsLabel: String(stats.hits) };
            }
        }
        return { row: 'r-covered', mark: 'green', hitsLabel: String(stats.hits) };
    }
    if (!raw.trim() || nonExec.has(lineNum)) {
        return { row: 'r-nonexec', mark: '', hitsLabel: '' };
    }
    return { row: 'r-uncovered', mark: 'red', hitsLabel: '0' };
}

export async function renderFilePage(
    file: string,
    source: string,
    coverage: FileCoverage,
    throwSites: Set<string> = new Set(),
    conditionalThrowSites: Set<string> = new Set(),
    throwStatementStart: Map<string, { file: string; line: number }> = new Map(),
    suspects: readonly SuspectLine[] = [],
): Promise<string> {
    const suspectMap = new Map<number, string>();
    for (const s of suspects) {
        if (s.file === file) suspectMap.set(s.line, s.reason);
    }
    const tokens = await tokenizeFunC(source);
    const nonExec = buildNonExecSet(source, tokens);
    const sourceLines = source.split(/\n/);

    let totalExec = 0;
    let coveredExec = 0;

    const rows: string[] = [];
    let offset = 0;
    for (let i = 0; i < sourceLines.length; i++) {
        const lineContent = sourceLines[i];
        const lineStart = offset;
        const lineEnd = offset + lineContent.length;
        offset = lineEnd + 1; // +1 for the '\n' that was stripped by split

        const lineNum = i + 1;
        const isCondThrow = conditionalThrowSites.has(`${file}:${lineNum}`);
        const originRef = throwStatementStart.get(`${file}:${lineNum}`);
        const originStats = originRef && originRef.line !== lineNum
            ? coverage.lines.get(originRef.line)
            : undefined;
        const { row, mark, hitsLabel } = classifyLine(lineNum, lineContent, coverage, nonExec, isCondThrow, originStats);
        if (row === 'r-covered' || row === 'r-partial') { totalExec++; coveredExec++; }
        else if (row === 'r-uncovered') { totalExec++; }

        const codeHtml = renderLine(source, lineStart, lineEnd, tokens);

        // Throw column: shown only on the throw's START line — continuation
        // lines of a multi-line throw_unless are visually classified as
        // part of the throw (yellow/green via classifyLine) but leave the
        // counter column blank to reduce visual noise.
        let throwLabel = '';
        if (throwSites.has(`${file}:${lineNum}`) && (!originRef || originRef.line === lineNum)) {
            const stats = coverage.lines.get(lineNum);
            throwLabel = String(stats?.throws ?? 0);
        }

        void mark;
        const suspectClass = suspectMap.has(lineNum) ? ' r-suspect' : '';
        rows.push(
            `<tr class="${row}${suspectClass}">` +
            `<td class="g-throws">${throwLabel}</td>` +
            `<td class="g-hits">${hitsLabel}</td>` +
            `<td class="g-line">${lineNum}</td>` +
            `<td class="code">${codeHtml || '&nbsp;'}</td>` +
            `</tr>`
        );
    }

    const pct = totalExec === 0 ? 100 : Math.round((coveredExec / totalExec) * 1000) / 10;

    let suspectHtml = '';
    if (suspectMap.size > 0) {
        const items = [...suspectMap.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([ln, reason]) => `<li><span class="line-ref">Line ${ln}</span>: ${escapeHtml(reason)}</li>`)
            .join('\n');
        suspectHtml = `\n<div class="suspect-summary">\n<b>Analysis anomalies (${suspectMap.size}):</b>\n<ul>\n${items}\n</ul>\n</div>`;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(file)} — tonofcov</title>
<link rel="stylesheet" href="../style.css">
</head>
<body>
<nav class="breadcrumbs">
<a href="../index.html">← all files</a>
<span class="sep">/</span>
<span class="cur">${escapeHtml(file)}</span>
<span class="stats">${coveredExec} / ${totalExec} lines (${pct}%)</span>
</nav>${suspectHtml}
<table class="src">
${rows.join('\n')}
</table>
</body>
</html>
`;
}
