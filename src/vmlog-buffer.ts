/**
 * Process-global buffer of captured vmLogs.
 *
 * Each entry is a raw vmLog string as produced by the TVM emulator. Populated
 * by the sandbox hook during tests, drained by the jest teardown for aggregation.
 */

const logs: string[] = [];

export function appendVmLog(log: string): void {
    if (log) logs.push(log);
}

export function drainVmLogs(): string[] {
    const drained = logs.slice();
    logs.length = 0;
    return drained;
}

export function peekCount(): number {
    return logs.length;
}
