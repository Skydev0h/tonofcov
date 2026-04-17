/**
 * Two-phase coverage flush to work around jest's worker VM constraints.
 *
 *   Phase 1 — inside jest worker (afterAll hook):
 *     Drain vmLogs, aggregate to Coverage, serialize to a JSON intermediate
 *     file (coverage/.tonofcov-raw.json). No tree-sitter involvement here —
 *     jest's VM context blocks dynamic imports needed by web-tree-sitter.
 *
 *   Phase 2 — inside jest's parent process (globalTeardown):
 *     Read the JSON, run tree-sitter AST analysis of user's .fc sources,
 *     apply inline-aware propagation, and emit the final lcov.info.
 *
 * If something prevents the tree-sitter step, lcov.info is still produced
 * from the raw coverage — just without inline propagation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { aggregate } from './aggregator';
import { computeOpcodeDivisors } from './compile-cache';
import { emitLcov } from './lcov';
import { drainVmLogs, peekCount } from './vmlog-buffer';
import type { Coverage, FileCoverage, LineStats } from './types';

const RAW_FILENAME = '.tonofcov-raw.json';

function outDir(): string {
    return resolve(process.cwd(), process.env.TONOFCOV_OUT_DIR ?? 'coverage');
}

/**
 * Phase 1: called from the jest worker afterAll hook. Writes raw coverage JSON.
 */
export function flushRaw(): void {
    const count = peekCount();
    const vmLogs = drainVmLogs();
    if (vmLogs.length === 0) {
        // eslint-disable-next-line no-console
        console.log('[tonofcov] no vmLogs captured');
        return;
    }

    const coverage = aggregate(vmLogs);

    // We also serialize the opcode-divisor map so the parent process can
    // consult it during conditional-header fixup (the divisor is computed
    // here because compile-cache only exists in the worker). Straight-line
    // statements are NOT normalized at this stage — per-statement opcode
    // counts vary and naive division can undercount simple assignments.
    // Conditional headers are the specific target: `if (cond) {` reliably
    // compiles to multiple opcodes (PUSH / AND / IF*), doubling or tripling
    // the raw hit count relative to how many times the if was evaluated.
    const divisors = computeOpcodeDivisors();

    const dir = outDir();
    mkdirSync(dir, { recursive: true });
    const rawPath = join(dir, RAW_FILENAME);
    writeFileSync(rawPath, JSON.stringify(serializeCoverage(coverage, divisors)), 'utf8');

    let fileCount = 0, lineCount = 0;
    for (const fc of coverage.files.values()) {
        fileCount++;
        lineCount += fc.lines.size;
    }
    // eslint-disable-next-line no-console
    console.log(`[tonofcov] worker: ${count} vmLogs → ${fileCount} files, ${lineCount} lines → ${rawPath}`);
}

/**
 * Phase 2: called from jest globalTeardown. Reads raw JSON, applies inline
 * propagation via tree-sitter, writes final lcov.info.
 */
export async function flushFinal(): Promise<void> {
    const dir = outDir();
    const rawPath = join(dir, RAW_FILENAME);
    if (!existsSync(rawPath)) {
        // eslint-disable-next-line no-console
        console.log('[tonofcov] no raw coverage file — skipping final emission');
        return;
    }

    const { coverage, opcodeDivisors } = deserializeCoverage(JSON.parse(readFileSync(rawPath, 'utf8')));

    const sources = loadSources(coverage);
    let analysis: any = undefined;
    if (sources.size > 0) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
            const { analyzeSources } = require('./func-ast');
            analysis = await analyzeSources(sources);
        } catch (err: any) {
            // eslint-disable-next-line no-console
            console.warn(`[tonofcov] AST analysis skipped: ${err?.message ?? err}`);
        }
    }

    // Normalize conditional-header raw hits by opcode count. `if (x & y)` /
    // `while (cond)` etc. compile to multiple opcodes each carrying a mark
    // on the header line, so raw hits over-count by the opcode multiplier.
    // Applying this here, BEFORE propagation, ensures downstream passes see
    // the normalized anchor values. Non-header lines are left alone —
    // per-statement opcode counts are less predictable and normalizing
    // them can undercount simple assignments.
    if (analysis) {
        for (const cond of analysis.conditionals) {
            const fc = coverage.files.get(cond.file);
            if (!fc) continue;
            const stats = fc.lines.get(cond.headerLine);
            if (!stats || stats.hits === 0) continue;
            const d = opcodeDivisors.get(`${cond.file}:${cond.headerLine}`) ?? 1;
            if (d > 1) {
                stats.hits = Math.max(1, Math.round(stats.hits / d));
                fc.lines.set(cond.headerLine, stats);
            }
        }
    }

    const propagateEnabled = process.env.TONOFCOV_NO_INLINE_PROPAGATE !== '1';
    if (propagateEnabled && analysis) {
        try {
            applyInlinePropagation(coverage, analysis, sources);
        } catch (err: any) {
            // eslint-disable-next-line no-console
            console.warn(`[tonofcov] inline-propagation skipped: ${err?.message ?? err}`);
        }
    }

    const lcov = emitLcov(coverage, process.env.TONOFCOV_TEST_NAME ?? '');
    const lcovPath = join(dir, 'lcov.info');
    writeFileSync(lcovPath, lcov, 'utf8');

    let fileCount = 0, lineCount = 0;
    for (const fc of coverage.files.values()) {
        fileCount++;
        lineCount += fc.lines.size;
    }
    // eslint-disable-next-line no-console
    console.log(`[tonofcov] final: ${fileCount} files, ${lineCount} lines → ${lcovPath}`);

    // HTML report is on by default — disable with TONOFCOV_HTML=0/false or
    // TONOFCOV_NO_HTML=1 (either form accepted; CI may prefer the explicit
    // NO_HTML variant).
    const htmlRaw = process.env.TONOFCOV_HTML;
    const htmlDisabled =
        htmlRaw === '0' || htmlRaw === 'false' || htmlRaw === 'off' ||
        process.env.TONOFCOV_NO_HTML === '1' || process.env.TONOFCOV_NO_HTML === 'true';
    if (!htmlDisabled) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
            const { writeHtmlReport } = require('./html/writer');
            const throwSites: Set<string> = analysis?.throwSites ?? new Set();
            const conditionalThrowSites: Set<string> = analysis?.conditionalThrowSites ?? new Set();
            const throwStatementStart = analysis?.throwStatementStart ?? new Map();
            await writeHtmlReport(coverage, sources, dir, throwSites, conditionalThrowSites, throwStatementStart);
        } catch (err: any) {
            // eslint-disable-next-line no-console
            console.warn(`[tonofcov] html report skipped: ${err?.message ?? err}`);
        }
    }

    // Gaps report — agent-friendly listing of uncovered functions, partial
    // throws, and uncovered ranges inside covered functions. Emitted by
    // default alongside LCOV/HTML; disable with TONOFCOV_NO_GAPS=1 or
    // TONOFCOV_GAPS=0/false/off.
    const gapsRaw = process.env.TONOFCOV_GAPS;
    const gapsDisabled =
        gapsRaw === '0' || gapsRaw === 'false' || gapsRaw === 'off' ||
        process.env.TONOFCOV_NO_GAPS === '1' || process.env.TONOFCOV_NO_GAPS === 'true';
    if (!gapsDisabled && analysis) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
            const { computeGaps, formatGapsMarkdown, formatGapsJson } = require('./gaps');
            // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
            const { buildShouldCountFn } = require('./filters');
            const nonExecByFile = await buildNonExecByFile(sources);
            const fileGaps = computeGaps(coverage, analysis, sources, nonExecByFile, buildShouldCountFn());
            writeFileSync(join(dir, 'gaps.md'), formatGapsMarkdown(fileGaps), 'utf8');
            writeFileSync(join(dir, 'gaps.json'), formatGapsJson(fileGaps), 'utf8');
            const gapCount = fileGaps.reduce((s: number, f: any) => s + f.gaps.length, 0);
            // eslint-disable-next-line no-console
            console.log(`[tonofcov] gaps: ${gapCount} gap(s) across ${fileGaps.length} file(s) → ${join(dir, 'gaps.md')}`);
        } catch (err: any) {
            // eslint-disable-next-line no-console
            console.warn(`[tonofcov] gaps report skipped: ${err?.message ?? err}`);
        }
    }
}

async function buildNonExecByFile(sources: Map<string, string>): Promise<Map<string, Set<number>>> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { tokenizeFunC } = require('./html/highlight');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { buildNonExecSet } = require('./html/render-internals');
    const out = new Map<string, Set<number>>();
    for (const [file, src] of sources) {
        try {
            const toks = await tokenizeFunC(src);
            out.set(file, buildNonExecSet(src, toks));
        } catch {
            out.set(file, new Set());
        }
    }
    return out;
}

function loadSources(coverage: Coverage): Map<string, string> {
    const sources = new Map<string, string>();
    for (const file of coverage.files.keys()) {
        const fullPath = resolve(process.cwd(), file);
        try {
            sources.set(file, readFileSync(fullPath, 'utf8'));
        } catch {
            // missing — skip
        }
    }
    return sources;
}

function applyInlinePropagation(coverage: Coverage, analysis: any, sources: Map<string, string>): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { propagateInlineHits } = require('./inline-propagate');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { propagateMultilineStatements } = require('./multiline-propagate');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { sequentialFill } = require('./sequential-fill');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { removeDeadFunctionArtifacts, propagateConditionalHeaders, propagateFunctionSignatures, suppressDeadBranchArtifacts, stripNonCodeHits, capReturnStatementHits } = require('./polish');
    // Run FIRST so downstream passes (inline-propagate's blockRawMax cap,
    // sequential-fill's anchors, conditional-header propagation) see the
    // corrected return counts instead of the shared-RET-inflated raw values.
    capReturnStatementHits(coverage, analysis);
    propagateInlineHits(coverage, analysis);
    propagateMultilineStatements(coverage, analysis.statementRanges);
    const conditionalHeaders = new Set<string>();
    for (const c of analysis.conditionals) {
        conditionalHeaders.add(`${c.file}:${c.headerLine}`);
    }
    sequentialFill(coverage, analysis.blocks, sources, analysis.unconditionalThrowSites, conditionalHeaders);
    // Must run BEFORE header/signature propagation so suppressed-branch hits
    // don't bleed into the if-header or enclosing function signature line.
    suppressDeadBranchArtifacts(coverage, analysis);
    propagateConditionalHeaders(coverage, analysis);
    propagateFunctionSignatures(coverage, analysis);
    removeDeadFunctionArtifacts(coverage, analysis);
    // Final cosmetic pass: drop compiler ret-artifact hits from `}` and
    // similar non-code lines so they don't show up as covered in the report.
    stripNonCodeHits(coverage, sources);
}

// -------- serialization helpers --------

type SerializedCoverage = {
    files: Array<{
        file: string;
        lines: Array<[number, LineStats]>;
        functions: Array<[string, { firstLine: number; hits: number }]>;
    }>;
    /** `file:line` → opcodes-per-line divisor, used for conditional-header normalization in the final pass. */
    opcodeDivisors?: Array<[string, number]>;
};

function serializeCoverage(cov: Coverage, divisors?: Map<string, number>): SerializedCoverage {
    return {
        files: [...cov.files.values()].map(fc => ({
            file: fc.file,
            lines: [...fc.lines.entries()],
            functions: [...fc.functions.entries()],
        })),
        opcodeDivisors: divisors ? [...divisors.entries()] : undefined,
    };
}

function deserializeCoverage(s: SerializedCoverage): { coverage: Coverage; opcodeDivisors: Map<string, number> } {
    const cov: Coverage = { files: new Map() };
    for (const entry of s.files) {
        const fc: FileCoverage = {
            file: entry.file,
            lines: new Map(entry.lines),
            branches: new Map(),
            functions: new Map(entry.functions),
        };
        cov.files.set(entry.file, fc);
    }
    const opcodeDivisors = new Map<string, number>(s.opcodeDivisors ?? []);
    return { coverage: cov, opcodeDivisors };
}
