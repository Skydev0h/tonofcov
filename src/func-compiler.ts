/**
 * Inline FunC WASM compiler — replaces @ton-community/func-js.
 * Loads WASM from tonofcov-func-bin (our build with stack overflow fix).
 */

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

type SourceResolver = (path: string) => string;

export interface CompileResult {
    status: 'ok' | 'error';
    message?: string;
    fiftCode?: string;
    codeBoc?: string;
    codeHashHex?: string;
    debugInfo?: any;
    debugMarksBoc?: string;
    snapshot?: { filename: string; content: string }[];
}

let cachedWasm: Buffer | null = null;
let modulePath: string | null = null;

async function createModule(): Promise<any> {
    if (!cachedWasm) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const bin = require('tonofcov-func-bin');
        cachedWasm = readFileSync(bin.wasmPath);
        modulePath = bin.modulePath;
    }
    // Fresh require each time — emscripten factory leaks global state through JS closures
    delete require.cache[require.resolve(modulePath!)];
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const factory = require(modulePath!);
    return factory({ wasmBinary: cachedWasm });
}

function copyToCString(mod: any, str: string): number {
    const len = mod.lengthBytesUTF8(str) + 1;
    const ptr = mod._malloc(len);
    mod.stringToUTF8(str, ptr, len);
    return ptr;
}

function copyToCStringPtr(mod: any, str: string, ptrPtr: number): number {
    const ptr = copyToCString(mod, str);
    mod.setValue(ptrPtr, ptr, '*');
    return ptr;
}

export async function compileFunc(config: {
    targets: string[];
    sources: SourceResolver | { filename: string; content: string }[];
    optLevel?: number;
    debugInfo?: boolean;
}): Promise<CompileResult> {
    const resolver: SourceResolver = typeof config.sources === 'function'
        ? config.sources
        : (p: string) => {
            const entry = (config.sources as any[]).find((e: any) => e.filename === p);
            if (!entry) throw new Error(`Source not found: ${p}`);
            return entry.content;
        };

    const targets = config.targets;
    const mod = await createModule();
    const allocatedPtrs: number[] = [];

    const sourceMap: Record<string, { content: string; included: boolean }> = {};
    const sourceOrder: string[] = [];

    const callbackPtr = mod.addFunction(
        (_kind: number, _data: number, contents: number, error: number) => {
            const kind: string = mod.UTF8ToString(_kind);
            const data: string = mod.UTF8ToString(_data);

            if (kind === 'realpath') {
                allocatedPtrs.push(copyToCStringPtr(mod, posix.normalize(data), contents));
            } else if (kind === 'source') {
                const path = posix.normalize(data);
                try {
                    const source = resolver(path);
                    sourceMap[path] = { content: source, included: false };
                    sourceOrder.push(path);
                    allocatedPtrs.push(copyToCStringPtr(mod, source, contents));
                } catch (err: any) {
                    allocatedPtrs.push(copyToCStringPtr(mod, err?.message ?? String(err), error));
                }
            } else {
                allocatedPtrs.push(copyToCStringPtr(mod, 'Unknown callback kind ' + kind, error));
            }
        },
        'viiii',
    );

    const configStr = JSON.stringify({
        sources: targets,
        optLevel: config.optLevel ?? 2,
        debugInfo: config.debugInfo ?? false,
    });

    const configPtr = copyToCString(mod, configStr);
    allocatedPtrs.push(configPtr);

    const resultPtr = mod._func_compile(configPtr, callbackPtr);
    allocatedPtrs.push(resultPtr);

    const resultJson: string = mod.UTF8ToString(resultPtr);

    allocatedPtrs.forEach(ptr => mod._free(ptr));
    mod.removeFunction(callbackPtr);

    const result: CompileResult = JSON.parse(resultJson);

    if (result.status === 'ok') {
        const snapshot: { filename: string; content: string }[] = [];
        for (let i = sourceOrder.length - 1; i >= 0; i--) {
            const p = sourceOrder[i];
            if (sourceMap[p].included) continue;
            snapshot.push({ filename: p, content: sourceMap[p].content });
        }
        result.snapshot = snapshot;
    }

    return result;
}
