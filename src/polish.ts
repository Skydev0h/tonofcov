/**
 * Two small cosmetic passes applied after all propagation is done.
 *
 * (1) removeDeadFunctionArtifacts — the FunC debug compiler places a
 *     `ret:true` marker on the closing `}` of every function, including
 *     functions whose body never actually executed. After all propagation
 *     phases, such functions end up with exactly one DA entry at their
 *     endLine. Strip those entries (and their FN record) so the report
 *     doesn't show spurious green on unused handlers.
 *
 * (2) propagateConditionalHeaders — `if (cond) {` / `while (cond) {` /
 *     `repeat (n) {` / `do { ... } until (cond)` constructs have the
 *     condition on the same line as the opening `{`. The compiler sometimes
 *     skips marking this header line even when one of the bodies executed.
 *     If any body block has interior hits, the condition was evaluated and
 *     we mark the header line covered.
 */

import type { Coverage } from './types';
import type { Block, FuncAnalysis } from './func-ast';

/**
 * Cap `return` statement hit counts by the max hit of sibling statements
 * in the same innermost block. The FunC compiler often emits a single
 * shared RET opcode whose debug mark points to the first `return ();`
 * statement in source — so that line accumulates hits for ALL return
 * paths in the function, not just the 2 times its specific branch ran.
 *
 * Rule: if a return statement's raw hit count exceeds the max hit of
 * other lines in its enclosing block, it's almost certainly inflated by
 * this shared-RET artifact. Clamp it to the sibling max. We only lower
 * counts here — never raise — so legitimately-higher return counts (if
 * they ever existed) are preserved.
 */
export function capReturnStatementHits(coverage: Coverage, analysis: FuncAnalysis): void {
    const blocksByFile = new Map<string, Block[]>();
    for (const b of analysis.blocks) {
        const arr = blocksByFile.get(b.file) ?? [];
        arr.push(b);
        blocksByFile.set(b.file, arr);
    }

    for (const ret of analysis.returnStatements) {
        const fc = coverage.files.get(ret.file);
        if (!fc) continue;
        const stats = fc.lines.get(ret.line);
        if (!stats || stats.hits === 0) continue;

        const blocks = blocksByFile.get(ret.file) ?? [];
        let innermost: Block | undefined;
        let bestSpan = Infinity;
        for (const b of blocks) {
            if (ret.line <= b.startLine || ret.line >= b.endLine) continue;
            const span = b.endLine - b.startLine;
            if (span < bestSpan) { innermost = b; bestSpan = span; }
        }
        if (!innermost) continue;

        let siblingMax = 0;
        const innerStart = innermost.startLine + 1;
        const innerEnd = innermost.endLine - 1;
        for (const [line, lineStats] of fc.lines) {
            if (line === ret.line) continue;
            if (line < innerStart || line > innerEnd) continue;
            if (lineStats.hits > siblingMax) siblingMax = lineStats.hits;
        }

        // If the block has no sibling hits at all, we can't derive a cap —
        // leave the return's hit count alone (it's likely the only anchor
        // in a single-statement block).
        if (siblingMax === 0) continue;

        if (stats.hits > siblingMax) {
            stats.hits = siblingMax;
            fc.lines.set(ret.line, stats);
        }
    }
}

/**
 * Strip hits from lines whose source contains only syntactic noise (`{`,
 * `}`, `;`, blank, or a pure comment). The FunC compiler emits `ret:true`
 * debug marks on a function's closing `}` — those aren't statement executions
 * and shouldn't carry visible hit counts. Similarly, any artifact mark that
 * landed on an opening brace or semicolon line is cosmetic, not executable.
 *
 * Run this LATE, after all propagation passes, so that earlier passes that
 * use raw hit counts as anchors still see the artifacts (they sometimes carry
 * legitimate flow signal), but the final output is clean.
 */
export function stripNonCodeHits(coverage: Coverage, sources: Map<string, string>): void {
    for (const [file, src] of sources) {
        const fc = coverage.files.get(file);
        if (!fc) continue;
        const srcLines = src.split(/\r?\n/);
        const toDelete: number[] = [];
        for (const line of fc.lines.keys()) {
            const raw = srcLines[line - 1];
            if (raw === undefined) continue;
            const trimmed = raw.trim();
            if (
                trimmed === '' ||
                trimmed === '{' ||
                trimmed === '}' ||
                trimmed === ';' ||
                trimmed === '{-' ||
                trimmed === '-}' ||
                trimmed.startsWith(';;')
            ) {
                toDelete.push(line);
            }
        }
        for (const line of toDelete) fc.lines.delete(line);
    }
}

export function removeDeadFunctionArtifacts(coverage: Coverage, analysis: FuncAnalysis): void {
    for (const fn of analysis.functions) {
        const fc = coverage.files.get(fn.file);
        if (!fc) continue;

        // "Interior" = lines strictly before the closing brace, where genuine
        // execution marks (first_stmt) land. The `ret:true` artifact sits on
        // endLine.
        let hasInterior = false;
        for (const [line, stats] of fc.lines) {
            if (line >= fn.startLine && line < fn.endLine && stats.hits > 0) {
                hasInterior = true;
                break;
            }
        }
        if (hasInterior) continue;

        // Dead function — remove any DA entries within its full range and the
        // function record itself. We use a local snapshot of keys because we
        // mutate the map.
        const toDelete: number[] = [];
        for (const line of fc.lines.keys()) {
            if (line >= fn.startLine && line <= fn.endLine) toDelete.push(line);
        }
        for (const line of toDelete) fc.lines.delete(line);
        fc.functions.delete(fn.name);
    }
}

/**
 * Strips spurious hits from branches whose body exists solely to call a dead
 * inline function. The FunC compiler emits `ret:true` debug marks on
 * `return ()` statements inside if-bodies regardless of whether execution
 * actually took that branch — the marked offset appears to be reachable via
 * a shared RET pattern even when the if-check rejected the branch. That
 * produces "return hit, but the preceding call wasn't" inconsistencies.
 *
 * Detection rule: a block_statement is considered spuriously-hit if its
 * interior contains at least one call to a dead inline function AND no call
 * to any function that's live. In that case, all interior hits in the block
 * are removed — including the spurious return mark.
 *
 * Caveat: this runs BEFORE header/signature propagation, so suppressed blocks
 * don't bleed their artifacts into the if-header or function-signature line
 * via later passes.
 */
export function suppressDeadBranchArtifacts(coverage: Coverage, analysis: FuncAnalysis): void {
    const liveKey = (file: string, name: string) => `${file}::${name}`;
    const liveInlines = new Set<string>();
    for (const fn of analysis.functions) {
        if (!fn.inlineKind) continue;
        const fc = coverage.files.get(fn.file);
        if (!fc) continue;
        for (const [line, stats] of fc.lines) {
            if (line >= fn.startLine && line < fn.endLine && stats.hits > 0) {
                liveInlines.add(liveKey(fn.file, fn.name));
                break;
            }
        }
    }

    // Index call sites by (file, line) for quick lookup.
    const callsAt = new Map<string, Map<number, string[]>>();
    for (const c of analysis.callSites) {
        let fileMap = callsAt.get(c.file);
        if (!fileMap) { fileMap = new Map(); callsAt.set(c.file, fileMap); }
        const arr = fileMap.get(c.line) ?? [];
        arr.push(c.callee);
        fileMap.set(c.line, arr);
    }

    for (const block of analysis.blocks) {
        const innerStart = block.startLine + 1;
        const innerEnd = block.endLine - 1;
        if (innerEnd < innerStart) continue;

        const fc = coverage.files.get(block.file);
        if (!fc) continue;
        const fileMap = callsAt.get(block.file);
        if (!fileMap) continue;

        let hasDeadInline = false;
        let hasLive = false;

        for (let line = innerStart; line <= innerEnd; line++) {
            const callees = fileMap.get(line);
            if (!callees) continue;
            for (const name of callees) {
                const sameFileFn = analysis.functions.find(f => f.name === name && f.file === block.file && f.inlineKind);
                if (sameFileFn) {
                    if (liveInlines.has(liveKey(sameFileFn.file, sameFileFn.name))) hasLive = true;
                    else hasDeadInline = true;
                } else {
                    // Non-inline or cross-file call — assume live (we can't classify).
                    hasLive = true;
                }
            }
        }

        if (hasDeadInline && !hasLive) {
            for (let line = innerStart; line <= innerEnd; line++) {
                fc.lines.delete(line);
            }
        }
    }
}

export function propagateConditionalHeaders(coverage: Coverage, analysis: FuncAnalysis): void {
    for (const cond of analysis.conditionals) {
        const fc = coverage.files.get(cond.file);
        if (!fc) continue;

        // Sum the FIRST hit line across each body — that's the count of times
        // the body was entered. Using max would wrongly pick up nested-loop
        // counters and make `if` / `while` headers display absurd numbers.
        let total = 0;
        for (const [bStart, bEnd] of cond.bodies) {
            let firstLine = Infinity;
            let firstHits = 0;
            for (const [line, stats] of fc.lines) {
                if (line > bStart && line < bEnd && stats.hits > 0 && line < firstLine) {
                    firstLine = line;
                    firstHits = stats.hits;
                }
            }
            total += firstHits;
        }
        if (total === 0) continue;

        const existing = fc.lines.get(cond.headerLine);
        const existingHits = existing?.hits ?? 0;
        // The header must be evaluated at least as often as the body was
        // entered — otherwise the report shows impossible state (body hit
        // more times than the if was checked). If raw instruction-level
        // counts land below the body-entry count (happens when the header
        // line isn't marked or is marked by fewer opcodes than the body
        // line), bump it up.
        if (existingHits >= total) continue;
        fc.lines.set(cond.headerLine, { hits: total, totalGas: 0 });
    }
}

/**
 * Mark function-signature lines as covered when the function's body has hits.
 * The compiler doesn't emit first_stmt on `() foo(...) impure inline {` itself —
 * marks start at the first real statement inside. Visually a live function's
 * signature should match its body's coverage colour, not appear as uncovered
 * red above a sea of green body lines.
 */
export function propagateFunctionSignatures(coverage: Coverage, analysis: FuncAnalysis): void {
    for (const fn of analysis.functions) {
        const fc = coverage.files.get(fn.file);
        if (!fc) continue;

        // Use the FIRST line with hits (by source order) — that's the call
        // count of the function. Using max would inflate the signature's
        // displayed hits with nested-loop iteration counts.
        let firstHitLine = Infinity;
        let firstHits = 0;
        for (const [line, stats] of fc.lines) {
            if (line > fn.startLine && line < fn.endLine && stats.hits > 0 && line < firstHitLine) {
                firstHitLine = line;
                firstHits = stats.hits;
            }
        }
        if (firstHits === 0) continue;

        const existing = fc.lines.get(fn.startLine);
        if (existing && existing.hits > 0) continue;
        fc.lines.set(fn.startLine, { hits: firstHits, totalGas: 0 });
    }
}
