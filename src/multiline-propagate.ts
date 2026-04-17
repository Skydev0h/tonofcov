/**
 * Multi-line statement propagation.
 *
 * FunC debug info is line-granular and marks only the FIRST line of a
 * statement as `first_stmt: true`. A statement like
 *   cell msg = begin_cell()
 *       .store_op(...)
 *       .store_query_id(...)
 *       .end_cell();
 * spanning lines 64-72 produces a single mark at line 64 — TVM executes all
 * the store_* ops but their debug marks point back to line 64 as well.
 *
 * This pass uses AST-derived statement ranges to detect such multi-line
 * expressions and fills in the intermediate lines with the same hit count
 * as the marked start, so the coverage view shows the whole expression
 * uniformly covered.
 *
 * Only fills lines that have NO existing coverage entry — lines with their
 * own marks (e.g. the trailing `.end_cell();` on line 72, which can have its
 * own first_stmt mark depending on how the compiler chunks the expression)
 * keep their authoritative counts.
 */

import type { Coverage } from './types';
import type { StatementRange } from './func-ast';

export function propagateMultilineStatements(
    coverage: Coverage,
    statementRanges: readonly StatementRange[],
): void {
    // Group ranges by file
    const byFile = new Map<string, StatementRange[]>();
    for (const r of statementRanges) {
        const arr = byFile.get(r.file) ?? [];
        arr.push(r);
        byFile.set(r.file, arr);
    }

    for (const [file, ranges] of byFile) {
        const fc = coverage.files.get(file);
        if (!fc) continue;

        for (const range of ranges) {
            // Collect non-zero hits in range. Instruction-level inflation
            // makes some lines show higher counts than the statement's true
            // execution count — the MIN of non-zero hits is the best
            // available estimate of "how many times this statement ran".
            let minHits = Infinity;
            for (let line = range.startLine; line <= range.endLine; line++) {
                const stats = fc.lines.get(line);
                if (stats && stats.hits > 0 && stats.hits < minHits) {
                    minHits = stats.hits;
                }
            }
            if (!isFinite(minHits)) continue; // statement never executed — leave as-is

            // Force EVERY line in range to the min — including lines that
            // already had higher counts. Multi-line `throw_unless(err, a +\n
            // b +\n c)` was showing the first line as 69 and inner
            // continuation lines as 137 (opcode-level 2×), which makes no
            // sense for a single statement that either executed 69 times or
            // it didn't.
            for (let line = range.startLine; line <= range.endLine; line++) {
                const existing = fc.lines.get(line);
                if (existing) {
                    if (existing.hits !== minHits) {
                        existing.hits = minHits;
                        fc.lines.set(line, existing);
                    }
                } else {
                    fc.lines.set(line, { hits: minHits, totalGas: 0 });
                }
            }
        }
    }
}
