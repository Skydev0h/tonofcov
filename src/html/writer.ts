/**
 * HTML report writer — orchestrates per-file rendering and index generation,
 * writes everything under coverage/html/. Entry called from flush when
 * TONOFCOV_HTML=1 (or equivalent truthy value).
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Coverage } from '../types';
import { buildShouldCountFn } from '../filters';
import { renderFilePage } from './render';
import { renderIndexPage, type FileSummary } from './index-page';
import { CSS } from './style';

function safeFilename(path: string): string {
    // contracts/jetton-wallet.fc  →  contracts__jetton-wallet.fc.html
    return path.replace(/[\\/]/g, '__') + '.html';
}

function readTonofcovVersion(): string {
    try {
        const pkgPath = join(__dirname, '..', '..', 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        return String(pkg.version ?? '');
    } catch {
        return '';
    }
}

export async function writeHtmlReport(
    coverage: Coverage,
    sources: Map<string, string>,
    outDir: string,
    throwSites: Set<string> = new Set(),
    conditionalThrowSites: Set<string> = new Set(),
    throwStatementStart: Map<string, { file: string; line: number; conditional: boolean }> = new Map(),
): Promise<void> {
    const htmlRoot = join(outDir, 'html');
    const filesDir = join(htmlRoot, 'files');
    mkdirSync(filesDir, { recursive: true });

    writeFileSync(join(htmlRoot, 'style.css'), CSS, 'utf8');

    const shouldCount = buildShouldCountFn();

    const summaries: FileSummary[] = [];
    for (const [file, fc] of coverage.files) {
        const source = sources.get(file);
        if (!source) continue;
        const html = await renderFilePage(file, source, fc, throwSites, conditionalThrowSites, throwStatementStart);
        const filename = safeFilename(file);
        writeFileSync(join(filesDir, filename), html, 'utf8');

        // Use same executability rules as renderFilePage — the numbers must
        // agree between the index summary and the per-file page header.
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const { tokenizeFunC } = require('./highlight');
        const toks = await tokenizeFunC(source);
        const { buildNonExecSet } = require('./render-internals');
        const nonExec: Set<number> = buildNonExecSet(source, toks);
        let totalExec = 0, coveredExec = 0;
        const sourceLines = source.split(/\n/);
        for (let i = 0; i < sourceLines.length; i++) {
            const lineNum = i + 1;
            const raw = sourceLines[i];
            if (!raw.trim() || nonExec.has(lineNum)) continue;
            totalExec++;
            const stats = fc.lines.get(lineNum);
            if (stats && stats.hits > 0) coveredExec++;
        }

        // Count DISTINCT conditional throw calls — conditionalThrowSites now
        // includes every line of multi-line throws, so we must dedupe by
        // the throw's origin line to avoid counting one throw multiple times.
        let throwsTotal = 0, throwsCovered = 0;
        const seenOrigins = new Set<number>();
        for (const key of conditionalThrowSites) {
            if (!key.startsWith(`${file}:`)) continue;
            const line = Number(key.slice(file.length + 1));
            const originRef = throwStatementStart.get(key);
            const originLine = originRef?.line ?? line;
            if (seenOrigins.has(originLine)) continue;
            seenOrigins.add(originLine);
            throwsTotal++;
            const stats = fc.lines.get(originLine);
            if (stats && (stats.throws ?? 0) > 0) throwsCovered++;
        }

        summaries.push({
            file,
            href: `files/${filename}`,
            totalExec,
            coveredExec,
            throwsTotal,
            throwsCovered,
            counted: shouldCount(file),
        });
    }

    const indexHtml = renderIndexPage(summaries, readTonofcovVersion());
    writeFileSync(join(htmlRoot, 'index.html'), indexHtml, 'utf8');

    // eslint-disable-next-line no-console
    console.log(`[tonofcov] html report → ${htmlRoot}/index.html`);
}
