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
import { allEntries, computeOpcodeDivisors } from './compile-cache';
import { buildCfg, findAncestorCap, findFunctionEntry } from './cfg';
import { emitLcov } from './lcov';
import { drainVmLogs, peekCount } from './vmlog-buffer';
import type { Coverage, FileCoverage, LineStats, SuspectLine } from './types';

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

    // Build CFG caps from reqCtxId chains — computed here because
    // compile-cache (locations) only exists in the worker.
    const cfgReturnCaps = computeCfgReturnCaps(coverage);

    const dir = outDir();
    mkdirSync(dir, { recursive: true });
    const rawPath = join(dir, RAW_FILENAME);
    writeFileSync(rawPath, JSON.stringify(serializeCoverage(coverage, divisors, cfgReturnCaps)), 'utf8');

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

    const { coverage, opcodeDivisors, cfgReturnCaps } = deserializeCoverage(JSON.parse(readFileSync(rawPath, 'utf8')));

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

    let suspects: SuspectLine[] = [];
    const propagateEnabled = process.env.TONOFCOV_NO_INLINE_PROPAGATE !== '1';
    if (propagateEnabled && analysis) {
        try {
            suspects = applyInlinePropagation(coverage, analysis, sources, cfgReturnCaps);
        } catch (err: any) {
            // eslint-disable-next-line no-console
            console.warn(`[tonofcov] inline-propagation skipped: ${err?.message ?? err}`);
        }
    }

    if (suspects.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[tonofcov] ${suspects.length} analysis anomaly(s) detected — flagged in HTML report`);
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
            await writeHtmlReport(coverage, sources, dir, throwSites, conditionalThrowSites, throwStatementStart, suspects);
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

function applyInlinePropagation(coverage: Coverage, analysis: any, sources: Map<string, string>, cfgReturnCaps: Map<string, number> = new Map()): SuspectLine[] {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { propagateInlineHits } = require('./inline-propagate');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { propagateMultilineStatements } = require('./multiline-propagate');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { sequentialFill } = require('./sequential-fill');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { removeDeadFunctionArtifacts, propagateConditionalHeaders, propagateFunctionSignatures, suppressDeadBranchArtifacts, stripNonCodeHits, capReturnStatementHits } = require('./polish');

    // Apply CFG-derived return caps BEFORE capReturnStatementHits — these are
    // structurally correct upper bounds from reqCtxId chain tracing + function entry count.
    if (cfgReturnCaps.size > 0) {
        let applied = 0;
        for (const [key, cap] of cfgReturnCaps) {
            const [file, lineStr] = key.split(':');
            const line = Number(lineStr);
            const fc = coverage.files.get(file);
            if (!fc) continue;
            const stats = fc.lines.get(line);
            if (stats && stats.hits > cap) {
                stats.hits = cap;
                applied++;
            }
        }
        if (applied > 0) {
            // eslint-disable-next-line no-console
            console.log(`[tonofcov] CFG return caps applied: ${applied}/${cfgReturnCaps.size} returns capped`);
        }
    }

    capReturnStatementHits(coverage, analysis);
    const suspects: SuspectLine[] = [];

    // #6: return statement has hits but no sibling in same block has any hits — likely shared-RET artifact
    // Skip blocks too small to have siblings (one-statement function bodies: { return ...; })
    for (const ret of analysis.returnStatements) {
        const fc = coverage.files.get(ret.file);
        if (!fc) continue;
        const retHits = fc.lines.get(ret.line)?.hits ?? 0;
        if (retHits === 0) continue;
        const block = findInnermostBlock(analysis.blocks, ret.file, ret.line);
        if (!block) continue;
        if (block.endLine - block.startLine <= 3) continue;
        let anySiblingHit = false;
        for (const [line, stats] of fc.lines) {
            if (line === ret.line) continue;
            if (line <= block.startLine || line >= block.endLine) continue;
            if (stats.hits > 0) { anySiblingHit = true; break; }
        }
        if (!anySiblingHit) {
            suspects.push({ file: ret.file, line: ret.line, reason: `return has ${retHits} hits but no other line in its block has any — likely shared-RET artifact` });
        }
    }

    propagateInlineHits(coverage, analysis);
    propagateMultilineStatements(coverage, analysis.statementRanges);

    // #3: detect inline body with hits but all call sites STILL at zero
    // (after propagateInlineHits + propagateMultilineStatements had their chance)
    for (const fn of analysis.functions) {
        if (!fn.inlineKind) continue;
        const fc = coverage.files.get(fn.file);
        if (!fc) continue;
        let bodyHasHits = false;
        for (const [line, stats] of fc.lines) {
            if (line > fn.startLine && line < fn.endLine && stats.hits > 0) {
                bodyHasHits = true;
                break;
            }
        }
        if (!bodyHasHits) continue;
        const sites = analysis.callSites.filter((cs: any) => cs.callee === fn.name);
        const anySiteHit = sites.some((cs: any) => {
            const sfc = coverage.files.get(cs.file);
            return sfc && (sfc.lines.get(cs.line)?.hits ?? 0) > 0;
        });
        if (!anySiteHit && sites.length > 0) {
            for (const cs of sites) {
                suspects.push({ file: cs.file, line: cs.line, reason: `call to inline \`${fn.name}\` — body has hits but call site has none even after propagation` });
            }
        }
    }
    const conditionalHeaders = new Set<string>();
    for (const c of analysis.conditionals) {
        conditionalHeaders.add(`${c.file}:${c.headerLine}`);
    }
    const returnLines = new Set<string>();
    for (const r of analysis.returnStatements) {
        returnLines.add(`${r.file}:${r.line}`);
    }
    const ratios: any[] = [];
    const fillSuspects: SuspectLine[] = sequentialFill(coverage, analysis.blocks, sources, analysis.unconditionalThrowSites, conditionalHeaders, returnLines, ratios);
    suspects.push(...fillSuspects);
    {
        const sorted = ratios.sort((a: any, b: any) => b.ratio - a.ratio);
        // eslint-disable-next-line no-console
        console.log(`[tonofcov] between-fill ratio stats: ${ratios.length} pairs`);
        for (const r of sorted.slice(0, 15)) {
            // eslint-disable-next-line no-console
            console.log(`  ${r.file}:${r.L1}-${r.L2}  ${r.hitsL1} / ${r.hitsL2}  ratio=${r.ratio.toFixed(1)}`);
        }
    }
    suppressDeadBranchArtifacts(coverage, analysis);

    // #2: detect branch body with hits but header at zero (before propagation fixes it)
    for (const cond of analysis.conditionals) {
        const fc = coverage.files.get(cond.file);
        if (!fc) continue;
        const headerHits = fc.lines.get(cond.headerLine)?.hits ?? 0;
        if (headerHits > 0) continue;
        let bodyHasHits = false;
        for (const [bStart, bEnd] of cond.bodies) {
            for (const [line, stats] of fc.lines) {
                if (line > bStart && line < bEnd && stats.hits > 0) {
                    bodyHasHits = true;
                    break;
                }
            }
            if (bodyHasHits) break;
        }
        if (bodyHasHits) {
            suspects.push({ file: cond.file, line: cond.headerLine, reason: `branch body has hits but condition was never marked as executed` });
        }
    }

    propagateConditionalHeaders(coverage, analysis);
    propagateFunctionSignatures(coverage, analysis);

    // #5: function signature hits > max body hits — signature can't execute more than body
    for (const fn of analysis.functions) {
        const fc = coverage.files.get(fn.file);
        if (!fc) continue;
        const sigHits = fc.lines.get(fn.startLine)?.hits ?? 0;
        if (sigHits === 0) continue;
        let maxBody = 0;
        for (const [line, stats] of fc.lines) {
            if (line > fn.startLine && line <= fn.endLine && stats.hits > maxBody) {
                maxBody = stats.hits;
            }
        }
        if (maxBody > 0 && sigHits > maxBody * 2) {
            suspects.push({ file: fn.file, line: fn.startLine, reason: `signature has ${sigHits} hits but max body line has ${maxBody} — signature can't execute more than body` });
        }
    }

    removeDeadFunctionArtifacts(coverage, analysis);
    stripNonCodeHits(coverage, sources);
    return suspects;
}

function computeCfgReturnCaps(coverage: Coverage): Map<string, number> {
    const caps = new Map<string, number>();
    const lineHits = (file: string, line: number): number => {
        return coverage.files.get(file)?.lines.get(line)?.hits ?? 0;
    };

    for (const info of allEntries()) {
        const cfg = buildCfg(info.locations);

        for (const ret of cfg.returns) {
            const key = `${ret.loc.file}:${ret.loc.line}`;
            const retHits = lineHits(ret.loc.file, ret.loc.line);
            if (retHits === 0) continue;

            // Layer 1: CFG ancestor cap (different line with hits)
            const ancestorCap = findAncestorCap(cfg, ret.ctxId, lineHits);

            // Layer 2: function entry cap (for inline one-liners where ancestor is same line)
            const entry = findFunctionEntry(cfg, ret.loc.func, ret.loc.file);
            const entryCap = entry ? lineHits(entry.loc.file, entry.loc.line) : undefined;

            const candidates = [ancestorCap, entryCap].filter((c): c is number => c !== undefined && c > 0);
            if (candidates.length > 0) {
                const cap = Math.min(...candidates);
                if (cap < retHits) {
                    caps.set(key, cap);
                }
            }
        }
    }

    return caps;
}

function findInnermostBlock(blocks: readonly any[], file: string, line: number): any | undefined {
    let best: any | undefined;
    let bestSpan = Infinity;
    for (const b of blocks) {
        if (b.file !== file) continue;
        if (line <= b.startLine || line >= b.endLine) continue;
        const span = b.endLine - b.startLine;
        if (span < bestSpan) { best = b; bestSpan = span; }
    }
    return best;
}

// -------- serialization helpers --------

type SerializedCoverage = {
    files: Array<{
        file: string;
        lines: Array<[number, LineStats]>;
        functions: Array<[string, { firstLine: number; hits: number }]>;
    }>;
    opcodeDivisors?: Array<[string, number]>;
    cfgReturnCaps?: Array<[string, number]>;
};

function serializeCoverage(cov: Coverage, divisors?: Map<string, number>, cfgReturnCaps?: Map<string, number>): SerializedCoverage {
    return {
        files: [...cov.files.values()].map(fc => ({
            file: fc.file,
            lines: [...fc.lines.entries()],
            functions: [...fc.functions.entries()],
        })),
        opcodeDivisors: divisors ? [...divisors.entries()] : undefined,
        cfgReturnCaps: cfgReturnCaps?.size ? [...cfgReturnCaps.entries()] : undefined,
    };
}

function deserializeCoverage(s: SerializedCoverage): { coverage: Coverage; opcodeDivisors: Map<string, number>; cfgReturnCaps: Map<string, number> } {
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
    const cfgReturnCaps = new Map<string, number>(s.cfgReturnCaps ?? []);
    return { coverage: cov, opcodeDivisors, cfgReturnCaps };
}
