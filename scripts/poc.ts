/**
 * End-to-end POC:
 *   1. Compile JettonWallet with debugInfo: true
 *   2. Register into tonofcov cache
 *   3. Deploy + send a message through @ton/sandbox
 *   4. Parse vmLog, aggregate hits, emit lcov.info
 *   5. Print a summary + save lcov.info to disk for external inspection
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beginCell, Cell, Address, contractAddress, toNano } from '@ton/core';
import { Blockchain, internal } from '@ton/sandbox';
import { compileFunc } from '@ton-community/func-js';

import { registerCompiled, normalizeLocations, parseMarksCell, size as cacheSize, clearCache } from '../src/compile-cache';
import { aggregate } from '../src/aggregator';
import { emitLcov } from '../src/lcov';
import { parseVmLog } from '../src/vmlog';

const TEST_PROJECT_ROOT = process.env.TONOFCOV_TEST_PROJECT ?? './test-project';

async function main() {
    clearCache();

    // -------- 1. Compile ----------
    console.log('[1] Compiling contracts/jetton-wallet.fc with debugInfo: true');
    const cr = await compileFunc({
        targets: ['contracts/jetton-wallet.fc'],
        sources: (p: string) => readFileSync(join(TEST_PROJECT_ROOT, p), 'utf8'),
        debugInfo: true,
    });
    if (cr.status !== 'ok') throw new Error(`compile error: ${cr.message}`);

    const code = Cell.fromBase64(cr.codeBoc);
    const marksCell = Cell.fromBase64(cr.debugMarksBoc!);
    console.log(`    codeHash=${code.hash().toString('hex')}, locations=${cr.debugInfo!.locations.length}`);

    // -------- 2. Register ----------
    const marks = parseMarksCell(marksCell, code);
    registerCompiled(
        code.hash().toString('hex'),
        normalizeLocations(cr.debugInfo!.locations),
        marks,
    );
    console.log(`[2] Registered. cache size=${cacheSize()}, marks cells=${marks.size}`);

    // -------- 3. Run a sandbox transaction ----------
    console.log('[3] Setting up blockchain and sending a message');
    const blockchain = await Blockchain.create();
    blockchain.verbosity.vmLogs = 'vm_logs_full';

    const deployer = await blockchain.treasury('deployer');

    // Deploy a wallet with fake data (minter = deployer, owner = deployer).
    const data = beginCell()
        .storeUint(0, 4) // status
        .storeCoins(0)   // balance
        .storeAddress(deployer.address) // owner
        .storeAddress(deployer.address) // minter
        .endCell();

    const addr = contractAddress(0, { code, data });

    // Deploy
    const deployResult = await deployer.send({
        to: addr,
        value: toNano('1'),
        init: { code, data },
        bounce: false,
    });

    const vmLogs: string[] = [];
    for (const tx of deployResult.transactions) {
        if (tx.vmLogs) vmLogs.push(tx.vmLogs);
    }

    // Send a transfer op (will fail auth but exercises a bunch of code paths)
    const transferBody = beginCell()
        .storeUint(0x0f8a7ea5, 32) // op::transfer
        .storeUint(12345, 64)       // query_id
        .storeCoins(100)            // jetton amount
        .storeAddress(deployer.address) // dest
        .storeAddress(deployer.address) // response
        .storeBit(0)                // no custom payload
        .storeCoins(0)              // forward amount
        .storeBit(0)                // no forward payload
        .endCell();

    const xferResult = await deployer.send({
        to: addr,
        value: toNano('1'),
        body: transferBody,
        bounce: true,
    });
    for (const tx of xferResult.transactions) {
        if (tx.vmLogs) vmLogs.push(tx.vmLogs);
    }

    console.log(`    captured ${vmLogs.length} vmLogs, total size=${vmLogs.reduce((s, l) => s + l.length, 0)}`);

    // Peek first few parsed steps
    const peekSteps = parseVmLog(vmLogs[0] ?? '');
    console.log(`    first vmLog has ${peekSteps.length} steps; first 3:`);
    for (const s of peekSteps.slice(0, 3)) {
        console.log(`      ${s.cellHash.slice(0, 16)}...  off=${s.offset}  ${s.opcode ?? '?'}`);
    }

    // -------- 4. Aggregate ----------
    console.log('[4] Aggregating coverage');
    const coverage = aggregate(vmLogs);
    let totalLines = 0, hitLines = 0;
    for (const fc of coverage.files.values()) {
        totalLines += fc.lines.size;
        for (const [, stats] of fc.lines) if (stats.hits > 0) hitLines++;
    }
    console.log(`    files=${coverage.files.size}, total lines touched=${totalLines}, hit lines=${hitLines}`);
    for (const fc of coverage.files.values()) {
        console.log(`      ${fc.file}: ${fc.lines.size} lines, ${fc.functions.size} funcs`);
    }

    // -------- 5. Emit LCOV ----------
    console.log('[5] Emitting LCOV');
    const lcov = emitLcov(coverage, 'tonofcov-poc');
    mkdirSync(join(process.cwd(), 'coverage'), { recursive: true });
    const lcovPath = join(process.cwd(), 'coverage', 'lcov.info');
    writeFileSync(lcovPath, lcov, 'utf8');
    console.log(`    wrote ${lcov.length} bytes to ${lcovPath}`);
    console.log(`\n--- lcov.info preview (first 60 lines) ---`);
    console.log(lcov.split('\n').slice(0, 60).join('\n'));
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
