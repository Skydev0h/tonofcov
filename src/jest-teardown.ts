/**
 * Jest globalTeardown — runs in the jest parent process after all workers exit.
 * Reads the raw coverage JSON written by each worker, applies inline-aware
 * propagation via tree-sitter, and writes the final lcov.info.
 */

import { flushFinal } from './flush';

export default async function tonofcovGlobalTeardown(): Promise<void> {
    await flushFinal();
}
