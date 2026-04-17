/**
 * Compile hook — replaces @ton/blueprint's internal doCompileFunc with our own
 * implementation that:
 *   1. Attempts to call @ton-community/func-js compileFunc with debugInfo:true
 *   2. If that succeeds: captures DebugInfo + parsed marks into our cache
 *   3. If it fails (e.g. known WASM debugger bugs on certain contracts): falls
 *      back to a regular debugInfo:false compile so the user's build succeeds
 *      even if coverage is unavailable for that specific contract
 *
 * Best-effort philosophy: never let coverage concerns break a user's test suite.
 */

import { Cell } from '@ton/core';
import { normalizeLocations, parseMarksCell, registerCompiled } from './compile-cache';

let installed = false;

export function installCompileHook(): void {
    if (installed) return;
    installed = true;

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const funcModule = require('@ton/blueprint/dist/compile/func/compile.func');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const funcJs = require('@ton-community/func-js');

    funcModule.doCompileFunc = async function tonofcovDoCompileFunc(config: any): Promise<any> {
        // 1. Try debug compile
        let cr: any;
        let debugCompileOk = false;
        try {
            cr = await funcJs.compileFunc({ ...config, debugInfo: true });
            if (cr.status === 'ok') debugCompileOk = true;
            else {
                // eslint-disable-next-line no-console
                console.warn(`[tonofcov] debug compile returned error for ${JSON.stringify(config.targets)}: ${cr.message}. Falling back.`);
            }
        } catch (err: any) {
            // eslint-disable-next-line no-console
            console.warn(`[tonofcov] debug compile threw for ${JSON.stringify(config.targets)}: ${err?.message ?? err}. Falling back to non-debug (coverage unavailable for this contract).`);
        }

        // 2. Fallback — regular compile without debug info
        if (!debugCompileOk) {
            cr = await funcJs.compileFunc({ ...config, debugInfo: false });
            if (cr.status === 'error') throw new Error(cr.message);
        }

        const code = Cell.fromBase64(cr.codeBoc);
        const marksCell = cr.debugMarksBoc ? Cell.fromBase64(cr.debugMarksBoc) : undefined;

        // 3. Register if we have debug data
        if (debugCompileOk && cr.debugInfo && marksCell) {
            try {
                const marksMap = parseMarksCell(marksCell, code);
                registerCompiled(
                    code.hash().toString('hex'),
                    normalizeLocations(cr.debugInfo.locations ?? []),
                    marksMap,
                );
                // eslint-disable-next-line no-console
                console.log(`[tonofcov] registered ${JSON.stringify(config.targets)} codeHash=${code.hash().toString('hex').slice(0,16)} cells=${marksMap.size} locations=${cr.debugInfo.locations?.length ?? 0}`);
            } catch (err) {
                // eslint-disable-next-line no-console
                console.error('[tonofcov] registerCompiled failed:', err);
            }
        }

        // 4. Return in blueprint's expected shape
        let targets: string[] = [];
        if (config.targets) targets = config.targets;
        else if (Array.isArray(config.sources)) targets = config.sources.map((s: any) => s.filename);

        return {
            lang: 'func',
            fiftCode: cr.fiftCode,
            code,
            targets,
            snapshot: cr.snapshot,
            version: await funcModule.getFuncVersion(),
            debugInfo: debugCompileOk ? cr.debugInfo : undefined,
            marks: debugCompileOk ? marksCell : undefined,
        };
    };
}
