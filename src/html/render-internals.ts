/**
 * Re-exports small helpers from render.ts for other modules that need the
 * same non-exec classification (the index page's summary stats should agree
 * with the per-file page's header).
 */

import type { Token } from './highlight';

export function buildNonExecSet(source: string, tokens: readonly Token[]): Set<number> {
    const lines = source.split(/\n/);
    const lineStarts: number[] = [];
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
        lineStarts.push(offset);
        offset += lines[i].length + 1;
    }
    lineStarts.push(offset);

    const nonExec = new Set<number>();

    for (const tok of tokens) {
        if (tok.cls !== 'tok-comment' && tok.cls !== 'tok-macro') continue;
        for (let line = 1; line <= lines.length; line++) {
            const lStart = lineStarts[line - 1];
            const lEnd = lineStarts[line] - 1;
            if (tok.start <= lStart && tok.end >= lEnd && lines[line - 1].trim() !== '') {
                nonExec.add(line);
            }
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        // Single-line comments — the token-based check above only catches
        // block comments whose span covers the whole line including leading
        // indentation. A line like `    ;; see TL-B layout` has a comment
        // token starting at column 4, not 0, so we add an explicit prefix
        // check here.
        if (t.startsWith(';;')) {
            nonExec.add(i + 1);
            continue;
        }
        if (t.startsWith('#include') || t.startsWith('#pragma') || t.startsWith('global ') || t.startsWith('const ')) {
            nonExec.add(i + 1);
        }
        if (t === '{' || t === '}' || t === ';' || t === '{-' || t === '-}') {
            nonExec.add(i + 1);
        }
    }

    return nonExec;
}
