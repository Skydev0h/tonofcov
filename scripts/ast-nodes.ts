/**
 * Probe: dump all distinct AST node types in jetton-wallet.fc along with line spans.
 * Helps identify which node types map to "statement ranges" worth propagating.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const { Parser, Language } = require('web-tree-sitter');

const TEST_PROJECT_ROOT = process.env.TONOFCOV_TEST_PROJECT ?? './test-project';

async function main() {
    await Parser.init();
    const parser = new Parser();
    const wasmPath = require.resolve('@scaleton/tree-sitter-func/lib/tree-sitter-func.wasm');
    parser.setLanguage(await Language.load(wasmPath));

    const source = readFileSync(join(TEST_PROJECT_ROOT, 'contracts/jetton-wallet.fc'), 'utf8');
    const tree = parser.parse(source);

    const byType = new Map<string, { count: number; multilineCount: number; samples: Array<{ start: number; end: number; preview: string }> }>();

    const visit = (node: any) => {
        if (!node) return;
        const stats = byType.get(node.type) ?? { count: 0, multilineCount: 0, samples: [] };
        stats.count += 1;
        const start = node.startPosition.row + 1;
        const end = node.endPosition.row + 1;
        if (end > start) {
            stats.multilineCount += 1;
            if (stats.samples.length < 3) {
                const preview = source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 80)).replace(/\s+/g, ' ');
                stats.samples.push({ start, end, preview });
            }
        }
        byType.set(node.type, stats);
        for (let i = 0; i < node.childCount; i++) visit(node.child(i));
    };
    visit(tree.rootNode);

    console.log('Node types encountered (sorted by multi-line count):');
    const sorted = [...byType.entries()].sort((a, b) => b[1].multilineCount - a[1].multilineCount);
    for (const [type, s] of sorted) {
        if (s.count < 2 && s.multilineCount === 0) continue;
        console.log(`  ${type.padEnd(40)} total=${String(s.count).padStart(4)}  multiline=${String(s.multilineCount).padStart(3)}`);
        for (const sample of s.samples) {
            console.log(`      L${sample.start}-${sample.end}: ${sample.preview}`);
        }
    }
}
main().catch(e => { console.error(e); process.exit(1); });
