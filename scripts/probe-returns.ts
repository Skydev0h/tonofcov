/**
 * Check whether multiple `return ()` source positions in recv_internal map
 * to distinct (cell, offset) pairs or share one — to diagnose why 202/213/219
 * are all marked as hit while the calls preceding them (201/212) aren't.
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

    const code = Cell.fromBase64(cr.codeBoc);
    const locs = cr.debugInfo!.locations;
    const marks: Map<string, Map<number, number[]>> = parseMarks(Cell.fromBase64(cr.debugMarksBoc!), code);

    const interest = new Set<number>();
    console.log('Location entries for lines 200-220:');
    for (let i = 0; i < locs.length; i++) {
        const l = locs[i];
        if (!l.file.endsWith('jetton-wallet.fc')) continue;
        if (l.line < 200 || l.line > 220) continue;
        const flags = [
            l.first_stmt ? 'first_stmt' : '',
            l.ret ? 'ret' : '',
            l.branch_true_ctx_id !== undefined ? `branch` : '',
        ].filter(Boolean).join(',');
        console.log(`  key=${i} line=${l.line} func=${l.func} ctx=${l.ctx_id} [${flags}]`);
        interest.add(i);
    }

    console.log('\nOffsets referencing those keys:');
    for (const [hash, offMap] of marks) {
        for (const [off, keys] of offMap) {
            for (const k of keys) {
                if (interest.has(k)) {
                    const l = locs[k];
                    console.log(`  cell ${hash.slice(0, 8)}... off=${off}  →  key=${k}  line=${l.line} ${l.ret ? '[ret]' : ''}${l.first_stmt ? '[first_stmt]' : ''}${l.branch_true_ctx_id !== undefined ? '[branch]' : ''}`);
                }
            }
        }
    }
}
main().catch(e => { console.error(e); process.exit(1); });
