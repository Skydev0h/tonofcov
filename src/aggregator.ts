/**
 * Coverage aggregator — turns (vmLogs, compile cache) into structured Coverage.
 *
 * For each step in the vmLog, looks up the source location(s) in the compile
 * cache and increments the appropriate counters. Branch coverage is deferred
 * to v2.1; for now we emit the plumbing but leave branch stats empty.
 */

import type {
    Coverage,
    FileCoverage,
    LineStats,
    SourceLocation,
    Step,
} from './types';
import { findByCellHash } from './compile-cache';
import { parseVmLog } from './vmlog';

/**
 * Aggregates multiple vmLog strings into a single Coverage object.
 * Looks up each step's source location via the global compile cache.
 */
export function aggregate(vmLogs: readonly string[]): Coverage {
    const coverage: Coverage = { files: new Map() };

    let totalSteps = 0;
    let matchedCells = 0;
    let matchedOffsets = 0;
    const uniqHashes = new Set<string>();

    for (const vmLog of vmLogs) {
        const steps = parseVmLog(vmLog);
        totalSteps += steps.length;
        for (const step of steps) uniqHashes.add(step.cellHash);
        const [cells, offsets] = processSteps(steps, coverage);
        matchedCells += cells;
        matchedOffsets += offsets;
    }

    if (process.env.TONOFCOV_VERBOSE === '1')
        console.log(`[tonofcov] aggregated: ${totalSteps} steps across ${uniqHashes.size} unique cell hashes; matched ${matchedCells} steps on ${matchedOffsets} offsets`);

    return coverage;
}

function processSteps(steps: readonly Step[], coverage: Coverage): [number, number] {
    let matchedCells = 0;
    let matchedOffsets = 0;
    for (const step of steps) {
        const info = findByCellHash(step.cellHash);
        if (!info) continue;
        matchedCells++;

        const keysMap = info.marks.get(step.cellHash);
        if (!keysMap) continue;

        const keys = keysMap.get(step.offset);
        if (!keys || keys.length === 0) continue;
        matchedOffsets++;

        const located = keys
            .map(k => info.locations[k])
            .filter((l): l is SourceLocation => l !== undefined && !!l.file && l.line > 0);

        if (located.length === 0) continue;

        const statement = located.find(l => l.firstStatement) ?? located[0];
        const seen = new Set<string>();
        seen.add(`${statement.file}:${statement.line}`);
        recordLine(coverage, statement, step);

        // Record each additional unique (file:line) from the same step (happens
        // when a single instruction has marks across inline expansions). Seeding
        // `seen` with the statement's key guards against double-counting the
        // statement line when located[] contains another SourceLocation object
        // that points to the same (file:line) — the `loc !== statement` object
        // check alone was insufficient.
        for (const loc of located) {
            const key = `${loc.file}:${loc.line}`;
            if (seen.has(key)) continue;
            seen.add(key);
            recordLine(coverage, loc, step);
        }
    }
    return [matchedCells, matchedOffsets];
}

function recordLine(coverage: Coverage, loc: SourceLocation, step: Step): void {
    let fc = coverage.files.get(loc.file);
    if (!fc) {
        fc = emptyFileCoverage(loc.file);
        coverage.files.set(loc.file, fc);
    }

    const existing: LineStats = fc.lines.get(loc.line) ?? { hits: 0, totalGas: 0 };
    existing.hits += 1;
    existing.totalGas += step.gas ?? 0;
    if (isThrowFire(step)) {
        existing.throws = (existing.throws ?? 0) + 1;
    }
    fc.lines.set(loc.line, existing);

    const fn = fc.functions.get(loc.func);
    if (!fn) {
        fc.functions.set(loc.func, { firstLine: loc.line, hits: 1 });
    } else {
        fn.hits += 1;
        if (loc.line < fn.firstLine) fn.firstLine = loc.line;
    }
}

/**
 * A step is treated as a throw-fire when its opcode is one of the THROW*
 * family AND it raised an exception. Unconditional THROW/THROWARG always
 * raise, while conditional THROWIF/THROWIFNOT only raise when the
 * condition matched. Both map to user-level `throw` / `throw_if` /
 * `throw_unless` / `throw_arg*` calls in FunC.
 */
function isThrowFire(step: Step): boolean {
    if (!step.exceptionRaised && !step.exceptionFatal) return false;
    const op = step.opcode;
    if (!op) return false;
    return /^THROW/i.test(op);
}

function emptyFileCoverage(file: string): FileCoverage {
    return {
        file,
        lines: new Map(),
        branches: new Map(),
        functions: new Map(),
    };
}
