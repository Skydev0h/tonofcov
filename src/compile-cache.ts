/**
 * Compile cache — holds CompiledDebugInfo for every contract we've seen
 * compile() for during the test run. Keyed by the root code cell hash
 * (lowercase hex, 64 chars).
 *
 * The cache is a process-global singleton so the jest globalSetup/globalTeardown
 * and the user's test code share the same view.
 */

import type { Cell } from '@ton/core';
import type { CompiledDebugInfo, SourceLocation } from './types';

const cache = new Map<string, CompiledDebugInfo>();

/**
 * Registers a compiled contract's debug info. Both arguments come from
 * @ton-community/func-js's compileFunc({debugInfo: true}) success result;
 * `marks` is the parsed map (see parseMarksCell in this module).
 */
export function registerCompiled(
    rootCodeHash: string,
    locations: readonly SourceLocation[],
    marks: ReadonlyMap<string, ReadonlyMap<number, readonly number[]>>,
): void {
    const lower = rootCodeHash.toLowerCase();
    cache.set(lower, { rootCodeHash: lower, locations, marks });
}

/**
 * Looks up debug info by any inner cell hash that maps to this contract.
 * Since the marks map has an entry for every cell (including root), any
 * hash encountered in a vmLog will match if we've seen the code compile.
 */
export function findByCellHash(cellHashUpper: string): CompiledDebugInfo | undefined {
    for (const entry of cache.values()) {
        if (entry.marks.has(cellHashUpper)) return entry;
    }
    return undefined;
}

/**
 * Clears the entire cache — useful for tests of tonofcov itself.
 */
export function clearCache(): void {
    cache.clear();
}

/**
 * Number of registered contracts. Diagnostic.
 */
export function size(): number {
    return cache.size;
}

/**
 * Bridge from func-js's LocationEntry[] to our SourceLocation[].
 * Keeps the shape stable across func-js minor versions.
 */
export function normalizeLocations(
    rawLocations: ReadonlyArray<{
        file: string;
        line: number;
        func: string;
        first_stmt?: true;
        ret?: true;
        try_catch_ctx_id?: number;
        is_try_end?: true;
        ctx_id: number;
        branch_true_ctx_id?: number;
        branch_false_ctx_id?: number;
    }>,
): SourceLocation[] {
    return rawLocations.map(r => ({
        file: r.file,
        line: r.line,
        func: r.func,
        firstStatement: r.first_stmt,
        ret: r.ret,
        branchTrueCtxId: r.branch_true_ctx_id,
        branchFalseCtxId: r.branch_false_ctx_id,
        tryCatchCtxId: r.try_catch_ctx_id,
        isTryEnd: r.is_try_end,
        ctxId: r.ctx_id,
    }));
}

/**
 * Parses the debug-marks Cell (from `compileFunc` result's debugMarksBoc) into
 * the map expected by the aggregator.
 *
 * Currently delegates to @ton/sandbox's internal parseMarks. This is a private
 * import path; if sandbox reshuffles internals we'll have to inline the parser.
 * The underlying format is a dictionary keyed by cell hash → offsets → key list.
 */
export function parseMarksCell(marksCell: Cell, rootCode: Cell): Map<string, Map<number, number[]>> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { parseMarks } = require('@ton/sandbox/dist/debugger/marks');
    return parseMarks(marksCell, rootCode);
}

/**
 * Compute the per-source-line opcode divisor used for instruction-level
 * normalization.
 *
 * The FunC compiler generally produces multiple TVM opcodes for a single
 * source statement (e.g. `if (x & 1)` → PUSH x, AND 1, IFJMP — three
 * opcodes, each with a debug mark on the if-header line). Our raw aggregator
 * increments line hits once per executed opcode, so the reported hit count
 * is `opcodes_on_line × statement_executions` instead of just
 * `statement_executions`.
 *
 * This function examines the debug-marks maps registered in the cache and,
 * for each (file, line) that any opcode references, computes a divisor:
 *
 *   divisor(file, line) = min over cells of (distinct offsets in THIS cell
 *                                             with any mark referencing this line)
 *
 * The MIN-per-cell (ignoring cells with zero references) gives the
 * per-expansion opcode count — important for `inline` functions whose body
 * is textually duplicated into every caller's cell. A caller cell with 2
 * expansions of the same inline has 2× the opcodes for the inline's body
 * lines; using MIN instead of MAX or SUM avoids treating duplication as
 * inflation.
 *
 * Dividing raw hits by this divisor yields a per-statement hit count that
 * matches intuition for non-inline straight-line code and stays correct for
 * inline functions in the common case (one expansion per caller).
 *
 * Known caveats:
 *   - If ALL callers of an inline have ≥2 expansions in their own cell,
 *     MIN overestimates the divisor — normalized hits will be too low.
 *     Rare in practice.
 *   - Dead-opcode optimizations may leave marks that never execute; the
 *     divisor counts them anyway, so real raw can be less than `N × K`.
 *     We clamp the result to ≥1 when hits > 0 so covered lines stay green.
 */
export function computeOpcodeDivisors(): Map<string, number> {
    // For each (cellHash, file:line), collect the set of offsets referencing
    // that line. The SET size is the per-cell opcode count for that line.
    const perCellOffsets = new Map<string, Map<string, Set<number>>>();

    for (const info of cache.values()) {
        for (const [cellHash, offsetMap] of info.marks) {
            let lineOffsets = perCellOffsets.get(cellHash);
            if (!lineOffsets) { lineOffsets = new Map(); perCellOffsets.set(cellHash, lineOffsets); }
            for (const [offset, keys] of offsetMap) {
                // A single offset may carry multiple keys (e.g. first_stmt
                // + ret). Deduplicate to the unique (file, line) pairs it
                // references — one OPCODE touches a source line at most
                // once even if it has multiple key flags.
                const fileLines = new Set<string>();
                for (const key of keys) {
                    const loc = info.locations[key];
                    if (loc && loc.file && loc.line > 0) {
                        fileLines.add(`${loc.file}:${loc.line}`);
                    }
                }
                for (const fl of fileLines) {
                    let offsets = lineOffsets.get(fl);
                    if (!offsets) { offsets = new Set(); lineOffsets.set(fl, offsets); }
                    offsets.add(offset);
                }
            }
        }
    }

    // Divisor = MIN across cells with positive count (i.e. cells that
    // actually contain marks for this line). Cells without any mark on
    // the line are excluded — they'd pollute the minimum with zero.
    const divisors = new Map<string, number>();
    for (const lineOffsets of perCellOffsets.values()) {
        for (const [fl, offsets] of lineOffsets) {
            const count = offsets.size;
            if (count === 0) continue;
            const existing = divisors.get(fl);
            if (existing === undefined || count < existing) {
                divisors.set(fl, count);
            }
        }
    }
    return divisors;
}
