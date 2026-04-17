/**
 * Diagnose the hit-growth pattern in minter's load_data (lines 18→38).
 * Raw hits jump by 2 at specific boundaries: 22→23, 27→28, 29→30, 34→35.
 * Enumerate every mark on every line 17-38 and see what's actually there.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cell } from '@ton/core';
import { compileFunc } from '@ton-community/func-js';
const { parseMarks } = require('@ton/sandbox/dist/debugger/marks');

const TEST_PROJECT_ROOT = process.env.TONOFCOV_TEST_PROJECT ?? './test-project';

async function main() {
    const cr = await compileFunc({
        targets: ['contracts/jetton-minter.fc'],
        sources: (p: string) => readFileSync(join(TEST_PROJECT_ROOT, p), 'utf8'),
        debugInfo: true,
    });
    if (cr.status !== 'ok') throw new Error(cr.message);

    const code = Cell.fromBase64(cr.codeBoc);
    const locs = cr.debugInfo!.locations;
    const marks: Map<string, Map<number, number[]>> = parseMarks(Cell.fromBase64(cr.debugMarksBoc!), code);

    // For each line 17-38, collect (cellHash, offset, keyFlags)
    const byLine = new Map<number, Array<{ cell: string; off: number; func: string; flags: string }>>();
    for (const [hash, offMap] of marks) {
        for (const [off, keys] of offMap) {
            for (const k of keys) {
                const l = locs[k];
                if (!l || !l.file.endsWith('jetton-minter.fc')) continue;
                if (l.line < 17 || l.line > 38) continue;
                const flags = [
                    l.first_stmt ? 'first_stmt' : '',
                    l.ret ? 'ret' : '',
                    l.branch_true_ctx_id !== undefined ? 'branch_T' : '',
                    l.branch_false_ctx_id !== undefined ? 'branch_F' : '',
                ].filter(Boolean).join(',') || '-';
                const arr = byLine.get(l.line) ?? [];
                arr.push({ cell: hash.slice(0, 8), off, func: l.func, flags });
                byLine.set(l.line, arr);
            }
        }
    }

    for (let line = 17; line <= 38; line++) {
        const entries = byLine.get(line) ?? [];
        const perCell = new Map<string, Set<number>>();
        for (const e of entries) {
            const s = perCell.get(e.cell) ?? new Set();
            s.add(e.off);
            perCell.set(e.cell, s);
        }
        const cellCounts = [...perCell.entries()].map(([c, s]) => `${c}:${s.size}`).join(' ');
        const totalMarks = entries.length;
        const uniqueOffsets = new Set(entries.map(e => `${e.cell}:${e.off}`)).size;
        console.log(`line ${line}: ${totalMarks} marks across ${perCell.size} cells, ${uniqueOffsets} unique (cell,off) → [${cellCounts}]`);
    }
}
main().catch(e => { console.error(e); process.exit(1); });
