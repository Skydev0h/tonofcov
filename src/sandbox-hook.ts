/**
 * Sandbox hook — intercepts @ton/sandbox's Executor to capture every vmLog
 * emitted during test execution. Covers:
 *   - runTransaction         (ordinary message sends)
 *   - runTickTock            (tick/tock special transactions)
 *   - runGetMethod           (get-method invocations)
 * The captured logs accumulate in vmlog-buffer and are drained by the jest
 * teardown after all tests finish.
 */

import { appendVmLog } from './vmlog-buffer';

let installed = false;

export function installSandboxHook(): void {
    if (installed) return;
    installed = true;

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const sandbox = require('@ton/sandbox');
    const Executor = sandbox.Executor;

    if (!Executor) {
        // eslint-disable-next-line no-console
        console.error('[tonofcov] sandbox.Executor not found — hook cannot install');
        return;
    }

    const proto = Executor.prototype;
    const report = {
        runTransaction: typeof proto?.runTransaction,
        runTickTock: typeof proto?.runTickTock,
        runGetMethod: typeof proto?.runGetMethod,
    };
    if (process.env.TONOFCOV_VERBOSE === '1')
        console.log(`[tonofcov] sandbox-hook: Executor.prototype methods:`, report);

    // Sentinel so we can verify from within tests that the patched prototype is the same
    // one sandbox actually uses at runtime.
    (proto as any).__tonofcov_installed_at = new Date().toISOString();
    (Executor as any).__tonofcov_installed = true;

    wrapMethod(Executor, 'runTransaction', (result: any) => {
        const r = result?.result;
        if (!r) return;
        if (r.success && r.vmLog) appendVmLog(r.vmLog);
        else if (!r.success && r.vmResults?.vmLog) appendVmLog(r.vmResults.vmLog);
    });

    wrapMethod(Executor, 'runTickTock', (result: any) => {
        const r = result?.result;
        if (!r) return;
        if (r.success && r.vmLog) appendVmLog(r.vmLog);
        else if (!r.success && r.vmResults?.vmLog) appendVmLog(r.vmResults.vmLog);
    });

    wrapMethod(Executor, 'runGetMethod', (result: any) => {
        const o = result?.output;
        if (!o) return;
        if (o.success && o.vm_log) appendVmLog(o.vm_log);
    });
}

function wrapMethod(cls: any, name: string, onResult: (result: any) => void): void {
    const proto = cls.prototype;
    if (!proto || typeof proto[name] !== 'function') {
        // eslint-disable-next-line no-console
        console.error(`[tonofcov] sandbox-hook: cannot wrap ${name}, not a prototype method`);
        return;
    }
    const original = proto[name];
    proto[name] = async function hooked(this: unknown, ...args: unknown[]) {
        // Force verbosity to include cell-hash + offset in vmLog. Without this,
        // the default 'short' verbosity emits instruction names only — useless
        // for source mapping. 'full_location_stack' gives us position per step.
        const patched = args.slice();
        const first = patched[0] as Record<string, unknown> | undefined;
        if (first && typeof first === 'object' && 'verbosity' in first) {
            patched[0] = { ...first, verbosity: 'full_location_stack' };
        }
        const result = await original.apply(this, patched);
        try {
            onResult(result);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[tonofcov] sandbox-hook ${name} capture failed:`, err);
        }
        return result;
    };
}
