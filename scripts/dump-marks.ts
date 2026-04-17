/**
 * Dump all debug marks (LocationEntry + corresponding offsets) for specific
 * source line ranges. Helps investigate why the compiler didn't produce marks
 * for lines we expect to be covered.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cell } from '@ton/core';
import { compileFunc } from '@ton-community/func-js';
const { parseMarks } = require('@ton/sandbox/dist/debugger/marks');

const TEST_PROJECT_ROOT = process.env.TONOFCOV_TEST_PROJECT ?? './test-project';

async function main() {
    const cr = await compileFunc({
        targets: ['contracts/jetton-wallet.fc'],
        sources: (p: string) => readFileSync(join(TEST_PROJECT_ROOT, p), 'utf8'),
        debugInfo: true,
    });
    if (cr.status !== 'ok') throw new Error(cr.message);

    const locs = cr.debugInfo!.locations;
    console.log(`Total locations: ${locs.length}`);

    // Which lines in jetton-wallet.fc between 85-110 have a LocationEntry?
    console.log('\n=== Location entries for jetton-wallet.fc lines 85-110 ===');
    for (let i = 0; i < locs.length; i++) {
        const l = locs[i];
        if (!l.file.endsWith('jetton-wallet.fc')) continue;
        if (l.line < 85 || l.line > 110) continue;
        const flags = [
            l.first_stmt ? 'first_stmt' : '',
            l.ret ? 'ret' : '',
            l.branch_true_ctx_id !== undefined ? `branch(t=${l.branch_true_ctx_id},f=${l.branch_false_ctx_id ?? '?'})` : '',
            l.try_catch_ctx_id !== undefined ? `try_begin(catch=${l.try_catch_ctx_id})` : '',
            l.is_try_end ? 'try_end' : '',
        ].filter(Boolean).join(',');
        console.log(`  key=${i} file=${l.file} line=${l.line} func=${l.func} ctx=${l.ctx_id} [${flags}]`);
    }

    // Now correlate with marks: which offsets in which cells reference these keys?
    const code = Cell.fromBase64(cr.codeBoc);
    const marks = parseMarks(Cell.fromBase64(cr.debugMarksBoc!), code);

    console.log('\n=== Offsets pointing to lines 85-110 ===');
    const linesOfInterest = new Set<number>();
    for (let i = 0; i < locs.length; i++) {
        const l = locs[i];
        if (l.file.endsWith('jetton-wallet.fc') && l.line >= 85 && l.line <= 110) {
            linesOfInterest.add(i);
        }
    }
    let total = 0;
    for (const [hash, offMap] of marks as Map<string, Map<number, number[]>>) {
        for (const [off, keys] of offMap) {
            for (const k of keys) {
                if (linesOfInterest.has(k)) {
                    const l = locs[k];
                    console.log(`  cell ${hash.slice(0, 8)}... off=${off}  →  key=${k}  line=${l.line} func=${l.func}`);
                    total++;
                    if (total > 50) { console.log('  (truncated)'); return; }
                }
            }
        }
    }
    console.log(`\nTotal offsets referencing interesting keys: ${total}`);
}

main().catch(e => { console.error(e); process.exit(1); });
