/**
 * Jest setup — runs inside each worker via setupFilesAfterEnv.
 * Installs compile + sandbox hooks, registers an afterAll to drain the
 * vmlog buffer into a raw coverage JSON file. Final lcov.info emission
 * happens in globalTeardown (parent process) via src/jest-teardown.ts.
 */

import { installCompileHook } from './compile-hook';
import { installSandboxHook } from './sandbox-hook';
import { flushRaw } from './flush';

installCompileHook();
installSandboxHook();

let flushed = false;
const flushOnce = () => {
    if (flushed) return;
    flushed = true;
    try {
        flushRaw();
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[tonofcov] flushRaw failed:', err);
    }
};

if (typeof (globalThis as any).afterAll === 'function') {
    (globalThis as any).afterAll(flushOnce);
}

process.on('beforeExit', flushOnce);
process.on('SIGTERM', flushOnce);
process.on('SIGINT', flushOnce);
