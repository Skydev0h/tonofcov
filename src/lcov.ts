/**
 * LCOV emitter — renders a Coverage object as the standard lcov.info text
 * format consumed by VSCode Coverage Gutters, JetBrains, Codecov, genhtml, etc.
 *
 * Format reference:
 *   TN:<test_name>
 *   SF:<source_file_path>
 *   FN:<line>,<function_name>
 *   FNDA:<exec_count>,<function_name>
 *   FNF:<functions_found>
 *   FNH:<functions_hit>
 *   DA:<line>,<exec_count>
 *   LF:<lines_found>
 *   LH:<lines_hit>
 *   BRDA:<line>,<block>,<branch>,<taken>
 *   BRF:<branches_found>
 *   BRH:<branches_hit>
 *   end_of_record
 */

import type { Coverage, FileCoverage } from './types';

/**
 * Converts a Coverage object into an LCOV-formatted string.
 * The `testName` parameter populates the TN: field and can be empty.
 */
export function emitLcov(coverage: Coverage, testName = ''): string {
    const chunks: string[] = [];
    // Sort files by path for deterministic output.
    const files = [...coverage.files.values()].sort((a, b) => a.file.localeCompare(b.file));
    for (const fc of files) {
        chunks.push(formatFileRecord(fc, testName));
    }
    return chunks.join('');
}

function formatFileRecord(fc: FileCoverage, testName: string): string {
    const lines: string[] = [];
    lines.push(`TN:${testName}`);
    lines.push(`SF:${fc.file}`);

    // Functions
    const fnEntries = [...fc.functions.entries()].sort((a, b) => a[1].firstLine - b[1].firstLine);
    for (const [name, stats] of fnEntries) {
        lines.push(`FN:${stats.firstLine},${name}`);
    }
    for (const [name, stats] of fnEntries) {
        lines.push(`FNDA:${stats.hits},${name}`);
    }
    lines.push(`FNF:${fnEntries.length}`);
    lines.push(`FNH:${fnEntries.filter(([, s]) => s.hits > 0).length}`);

    // Branches (v2.1: currently empty for FunC until branch tracking lands)
    let brf = 0, brh = 0;
    const branchEntries = [...fc.branches.entries()].sort((a, b) => a[0] - b[0]);
    for (const [line, branches] of branchEntries) {
        for (const branch of branches) {
            lines.push(`BRDA:${line},${branch.blockId},0,${branch.taken}`);
            lines.push(`BRDA:${line},${branch.blockId},1,${branch.notTaken}`);
            brf += 2;
            brh += (branch.taken > 0 ? 1 : 0) + (branch.notTaken > 0 ? 1 : 0);
        }
    }
    lines.push(`BRF:${brf}`);
    lines.push(`BRH:${brh}`);

    // Lines
    const lineEntries = [...fc.lines.entries()].sort((a, b) => a[0] - b[0]);
    for (const [line, stats] of lineEntries) {
        lines.push(`DA:${line},${stats.hits}`);
    }
    lines.push(`LF:${lineEntries.length}`);
    lines.push(`LH:${lineEntries.filter(([, s]) => s.hits > 0).length}`);
    lines.push(`end_of_record`);

    return lines.join('\n') + '\n';
}
