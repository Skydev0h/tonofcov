/**
 * POC: parse jetton-wallet.fc with tree-sitter-func, extract:
 *   - function definitions + their `inline` / `inline_ref` qualifier
 *   - all function call sites (name + line)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Parser, Language } = require('web-tree-sitter');

const TEST_PROJECT_ROOT = process.env.TONOFCOV_TEST_PROJECT ?? './test-project';

async function main() {
    await Parser.init();
    const parser = new Parser();
    const wasmPath = require.resolve('@scaleton/tree-sitter-func/lib/tree-sitter-func.wasm');
    const funcLang = await Language.load(wasmPath);
    parser.setLanguage(funcLang);

    const source = readFileSync(join(TEST_PROJECT_ROOT, 'contracts/jetton-wallet.fc'), 'utf8');
    const tree = parser.parse(source);

    console.log('root node type:', tree.rootNode.type);
    console.log('top-level children types:', [...new Set(tree.rootNode.children.map((c: any) => c.type))].join(', '));

    const functions: Array<{ name: string; inline?: string; startLine: number; endLine: number }> = [];
    const calls: Array<{ name: string; line: number }> = [];

    const visit = (node: any) => {
        if (!node) return;

        if (node.type === 'function_definition') {
            const nameNode = node.childForFieldName ? node.childForFieldName('name') : null;
            const name = nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : '?';
            // Scan header (before body block) for inline keywords
            const headerEnd = (() => {
                for (let i = 0; i < node.childCount; i++) {
                    const ch = node.child(i);
                    if (ch.type === 'block_statement' || ch.type === 'body') return ch.startIndex;
                }
                return node.startIndex + 500;
            })();
            const header = source.slice(node.startIndex, headerEnd);
            let inlineKind: string | undefined;
            if (/\binline_ref\b/.test(header)) inlineKind = 'inline_ref';
            else if (/\binline\b/.test(header)) inlineKind = 'inline';
            functions.push({
                name,
                inline: inlineKind,
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
            });
        }

        if (node.type === 'function_application' || node.type === 'function_call') {
            const fn = node.firstChild;
            const name = fn ? source.slice(fn.startIndex, fn.endIndex) : '?';
            calls.push({ name, line: node.startPosition.row + 1 });
        }

        for (let i = 0; i < node.childCount; i++) visit(node.child(i));
    };
    visit(tree.rootNode);

    console.log(`\n=== Functions found (${functions.length}) ===`);
    for (const f of functions) {
        console.log(`  line ${String(f.startLine).padStart(4)}-${String(f.endLine).padStart(4)}: ${f.name.padEnd(30)} ${f.inline ?? ''}`);
    }

    console.log(`\n=== Call sites by name (sorted, top 20) ===`);
    const byName = new Map<string, number[]>();
    for (const c of calls) {
        const lines = byName.get(c.name) ?? [];
        lines.push(c.line);
        byName.set(c.name, lines);
    }
    const sorted = [...byName.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [name, lines] of sorted.slice(0, 20)) {
        const preview = lines.slice(0, 6).join(',') + (lines.length > 6 ? '...' : '');
        console.log(`  ${String(lines.length).padStart(3)}x  ${name.padEnd(30)}  lines: ${preview}`);
    }

    // Show all call sites of inline functions
    const inlineNames = new Set(functions.filter(f => f.inline).map(f => f.name));
    console.log('\n=== Inline function call sites ===');
    for (const [name, lines] of byName.entries()) {
        if (inlineNames.has(name)) {
            console.log(`  ${name} (${functions.find(f => f.name === name)?.inline}): called at lines ${lines.join(',')}`);
        }
    }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
