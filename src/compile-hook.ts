/**
 * Compile hook — replaces @ton/blueprint's internal doCompileFunc with our own
 * implementation using tonofcov's bundled FunC WASM (tonofcov-func-bin).
 *
 * Best-effort philosophy: never let coverage concerns break a user's test suite.
 */

import { Cell } from '@ton/core';
import { normalizeLocations, parseMarksCell, registerCompiled } from './compile-cache';
import { compileFunc } from './func-compiler';

let installed = false;

export function installCompileHook(): void {
    if (installed) return;
    installed = true;

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const funcModule = require('@ton/blueprint/dist/compile/func/compile.func');

    const noDebugPatterns = (process.env.TONOFCOV_NO_DEBUG ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    funcModule.doCompileFunc = async function tonofcovDoCompileFunc(config: any): Promise<any> {
        const names: string[] = config.targets ?? [];
        const skipDebug = noDebugPatterns.length > 0 && names.some(
            t => noDebugPatterns.some(p => t.toLowerCase().includes(p)),
        );

        let cr: any;
        let debugCompileOk = false;
        if (skipDebug) {
            cr = await compileFunc({ ...config, debugInfo: false });
            if (cr.status === 'error') throw new Error(cr.message);
        } else try {
            cr = await compileFunc({ ...config, debugInfo: true });
            if (cr.status === 'ok') debugCompileOk = true;
            else {
                // eslint-disable-next-line no-console
                console.warn(`[tonofcov] debug compile returned error for ${JSON.stringify(config.targets)}: ${cr.message}. Falling back.`);
            }
        } catch (err: any) {
            // eslint-disable-next-line no-console
            console.warn(`[tonofcov] debug compile threw for ${JSON.stringify(config.targets)}: ${err?.message ?? err}. Falling back to non-debug (coverage unavailable for this contract).`);
        }

        if (!debugCompileOk) {
            cr = await compileFunc({ ...config, debugInfo: false });
            if (cr.status === 'error') throw new Error(cr.message);
        }

        const code = Cell.fromBase64(cr.codeBoc);
        const marksCell = cr.debugMarksBoc ? Cell.fromBase64(cr.debugMarksBoc) : undefined;

        if (debugCompileOk && cr.debugInfo && marksCell) {
            try {
                const marksMap = parseMarksCell(marksCell, code);
                registerCompiled(
                    code.hash().toString('hex'),
                    normalizeLocations(cr.debugInfo.locations ?? []),
                    marksMap,
                );
                if (process.env.TONOFCOV_VERBOSE === '1')
                    console.log(`[tonofcov] registered ${JSON.stringify(config.targets)} codeHash=${code.hash().toString('hex').slice(0,16)} cells=${marksMap.size} locations=${cr.debugInfo.locations?.length ?? 0}`);
            } catch (err) {
                // eslint-disable-next-line no-console
                console.error('[tonofcov] registerCompiled failed:', err);
            }
        }

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
