/**
 * Minimal vmLog parser — extracts execution steps from TVM full verbosity log.
 *
 * Format emitted by @ton/sandbox when `verbosity.vmLogs = 'vm_logs_full'` or
 * similar. We parse just enough to get (cellHash, offset, gas, exception)
 * per step; instruction mnemonics are kept for diagnostics.
 *
 * Reference grammar (non-exhaustive, gleaned from TVM emulator source):
 *   "code cell hash: <HEX> offset: <N>"   ← new location, start of a step
 *   "execute <CMD>"                        ← instruction about to run
 *   "gas remaining: <N>"                   ← gas counter after execution
 *   "handling exception code <N>: <desc>"  ← recoverable exception
 *   "default exception handler, terminating vm with exit code <N>"  ← fatal
 *
 * We keep the parser deliberately lenient — unknown lines are skipped.
 */

import type { Step } from './types';

const POS_RE = /^\s*code cell hash:\s*([0-9A-Fa-f]+)\s+offset:\s*(\d+)/;
const EXEC_RE = /^\s*execute\s+(.+)$/;
const GAS_RE = /^\s*gas remaining:\s*(\d+)/;
const EXC_HANDLED_RE = /^\s*handling exception code\s*\d+/;
const EXC_FATAL_RE = /^\s*default exception handler, terminating vm with exit code/;

/**
 * Parses an entire vmLog string into an ordered list of Steps.
 * Gas per step is computed as the delta from the previous gas-remaining value;
 * the first step's gas is undefined.
 */
export function parseVmLog(vmLog: string): Step[] {
    const steps: Step[] = [];
    let current: Partial<Step> | null = null;
    let prevGasRemaining: number | null = null;

    const flush = () => {
        if (current && current.cellHash !== undefined && current.offset !== undefined) {
            steps.push(current as Step);
        }
        current = null;
    };

    for (const rawLine of vmLog.split(/\r?\n/)) {
        const line = rawLine;

        const mPos = POS_RE.exec(line);
        if (mPos) {
            flush();
            current = {
                cellHash: mPos[1].toUpperCase(),
                offset: Number(mPos[2]),
            };
            continue;
        }

        if (!current) continue;

        const mExec = EXEC_RE.exec(line);
        if (mExec) {
            current.opcode = mExec[1].trim();
            continue;
        }

        const mGas = GAS_RE.exec(line);
        if (mGas) {
            const rem = Number(mGas[1]);
            if (prevGasRemaining !== null && rem <= prevGasRemaining) {
                current.gas = prevGasRemaining - rem;
            }
            prevGasRemaining = rem;
            continue;
        }

        if (EXC_HANDLED_RE.test(line)) {
            current.exceptionRaised = true;
            continue;
        }

        if (EXC_FATAL_RE.test(line)) {
            current.exceptionFatal = true;
            continue;
        }
    }

    flush();
    return steps;
}
