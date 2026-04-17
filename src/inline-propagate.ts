/**
 * Inline-aware coverage post-processing.
 *
 * When a FunC function is declared `inline` / `inline_ref`, the compiler emits
 * debug marks for the body instructions pointing to the function's definition
 * lines, not the call sites. Call sites appear uncovered even when execution
 * clearly passed through them. This pass propagates hits from covered inline
 * function bodies to their call sites.
 *
 * Over-propagation guards:
 *
 *   1. "Live function" detection. The FunC compiler always emits a `ret:true`
 *      debug mark on the closing `}` of every function. For functions whose
 *      body consists entirely of calls to OTHER inline stdlib functions, the
 *      ONLY body-line mark pointing back is the ret artifact. A function is
 *      LIVE only if it has at least one hit on a body line strictly before
 *      the closing brace.
 *
 *   2. "Live block" detection for call sites. Even within a live function a
 *      specific if-branch / while-body / standalone block may be dead code
 *      for the current test run. The innermost block_statement containing a
 *      call site must itself have at least one hit (excluding its closing
 *      brace line) for the call site to receive propagated hits.
 *
 *   3. Per-file scoping of duplicated names. When a helper name exists in
 *      multiple contracts (e.g. `save_data` defined in both jetton-minter.fc
 *      and jetton-wallet.fc with different signatures), propagation is
 *      scoped to the file of each definition to avoid cross-contamination.
 *
 *   4. LOCAL-FLOW CAP. An inline's total invocation count (max hit across
 *      its body) is the SUM of invocations across ALL call sites. Assigning
 *      that full sum to every individual call site wildly inflates counts
 *      (e.g. check_same_workchain called 1298× across the codebase shows
 *      1298 hits at the send_jettons call site even if send_jettons only
 *      ran twice). To fix this, each call site's propagated count is capped
 *      by the local flow through it — concretely the max RAW hit in the
 *      innermost block_statement containing the call site, snapshotted
 *      before any propagation mutates the coverage map.
 */

import type { Coverage, FileCoverage } from './types';
import type { Block, FuncAnalysis, FuncFunction } from './func-ast';

export function propagateInlineHits(coverage: Coverage, analysis: FuncAnalysis): void {
    const definitionCountByName = new Map<string, number>();
    for (const f of analysis.functions) {
        definitionCountByName.set(f.name, (definitionCountByName.get(f.name) ?? 0) + 1);
    }

    const liveFunctions = new Set<string>();
    const liveKey = (file: string, name: string) => `${file}::${name}`;
    for (const fn of analysis.functions) {
        const fc = coverage.files.get(fn.file);
        if (!fc) continue;
        if (hasInteriorHit(fc, fn.startLine, fn.endLine)) {
            liveFunctions.add(liveKey(fn.file, fn.name));
        }
    }

    // Index blocks by file for efficient innermost-lookup per call site.
    const blocksByFile = new Map<string, Block[]>();
    for (const b of analysis.blocks) {
        const arr = blocksByFile.get(b.file) ?? [];
        arr.push(b);
        blocksByFile.set(b.file, arr);
    }

    // Snapshot each block's RAW max interior hit, BEFORE any propagation
    // mutates the coverage. This is our per-call-site cap: a call site inside
    // a block can't have been invoked more than the block's flow count. Doing
    // the snapshot first is essential because propagation itself writes to
    // lines inside the same blocks, which would otherwise contaminate the cap.
    const blockRawMax = new Map<Block, number>();
    for (const block of analysis.blocks) {
        const fc = coverage.files.get(block.file);
        if (!fc) { blockRawMax.set(block, 0); continue; }
        let max = 0;
        const innerStart = block.startLine + 1;
        const innerEnd = block.endLine - 1;
        for (const [line, stats] of fc.lines) {
            if (line >= innerStart && line <= innerEnd && stats.hits > max) max = stats.hits;
        }
        blockRawMax.set(block, max);
    }

    for (const fn of analysis.functions) {
        if (!fn.inlineKind) continue;
        if (!liveFunctions.has(liveKey(fn.file, fn.name))) continue;

        const fc = coverage.files.get(fn.file);
        if (!fc) continue;
        const invocationCount = maxInteriorHit(fc, fn.startLine, fn.endLine);
        if (invocationCount === 0) continue;

        const nameIsDuplicated = (definitionCountByName.get(fn.name) ?? 0) > 1;

        for (const c of analysis.callSites) {
            if (c.callee !== fn.name) continue;
            if (nameIsDuplicated && c.file !== fn.file) continue;

            const enclosing = findEnclosing(analysis.functions, c.file, c.line);
            if (!enclosing || !liveFunctions.has(liveKey(enclosing.file, enclosing.name))) continue;

            const innermost = findInnermostBlock(blocksByFile.get(c.file) ?? [], c.line);
            if (!innermost) continue;

            // If the call-site line ALREADY has raw hits, the debug info gave
            // us an exact count — don't pollute it with an estimate. This
            // matters in functions with deep nested loops (recv_internal's
            // `while` iterates tens of thousands of times) where the
            // innermost-block cap is dominated by loop iterations, not the
            // linear flow count at this specific line.
            const targetFc = getOrCreateFile(coverage, c.file);
            const existing = targetFc.lines.get(c.line) ?? { hits: 0, totalGas: 0 };
            if (existing.hits > 0) continue;

            // Cap = local flow count (raw max hit in the innermost block).
            // If the block shows no raw hits, it's dead for this test run —
            // the call site inside it never executed, so no propagation.
            const cap = blockRawMax.get(innermost) ?? 0;
            if (cap === 0) continue;

            existing.hits = Math.min(invocationCount, cap);
            targetFc.lines.set(c.line, existing);
        }
    }
}

function hasInteriorHit(fc: FileCoverage, startLine: number, endLine: number): boolean {
    const effectiveEnd = endLine > startLine ? endLine - 1 : endLine;
    for (const [line, stats] of fc.lines) {
        if (line >= startLine && line <= effectiveEnd && stats.hits > 0) return true;
    }
    return false;
}

function blockHasInteriorHit(fc: FileCoverage, startLine: number, endLine: number): boolean {
    // Mirror of hasInteriorHit — a block_statement starts on `{` line and ends
    // on `}` line. Hits on `{`/`}` themselves don't usually happen but the
    // compiler's function-end ret mark lives on the enclosing function's `}`.
    // Interior = strict between.
    const innerStart = startLine + 1;
    const innerEnd = endLine - 1;
    if (innerEnd < innerStart) return false;
    for (const [line, stats] of fc.lines) {
        if (line >= innerStart && line <= innerEnd && stats.hits > 0) return true;
    }
    return false;
}

function maxInteriorHit(fc: FileCoverage, startLine: number, endLine: number): number {
    const effectiveEnd = endLine > startLine ? endLine - 1 : endLine;
    let max = 0;
    for (const [line, stats] of fc.lines) {
        if (line >= startLine && line <= effectiveEnd && stats.hits > max) {
            max = stats.hits;
        }
    }
    return max;
}

function findEnclosing(functions: readonly FuncFunction[], file: string, line: number): FuncFunction | undefined {
    let best: FuncFunction | undefined;
    let bestSpan = Infinity;
    for (const f of functions) {
        if (f.file !== file) continue;
        if (line < f.startLine || line > f.endLine) continue;
        const span = f.endLine - f.startLine;
        if (span < bestSpan) {
            best = f;
            bestSpan = span;
        }
    }
    return best;
}

/**
 * Strict-interior block lookup — see sequential-fill.ts for rationale. A
 * line on the block's `{` or `}` line belongs to the parent scope.
 */
function findInnermostBlock(blocks: readonly Block[], line: number): Block | undefined {
    let best: Block | undefined;
    let bestSpan = Infinity;
    for (const b of blocks) {
        if (line <= b.startLine || line >= b.endLine) continue;
        const span = b.endLine - b.startLine;
        if (span < bestSpan) {
            best = b;
            bestSpan = span;
        }
    }
    return best;
}

function getOrCreateFile(coverage: Coverage, file: string): FileCoverage {
    let fc = coverage.files.get(file);
    if (!fc) {
        fc = { file, lines: new Map(), branches: new Map(), functions: new Map() };
        coverage.files.set(file, fc);
    }
    return fc;
}
