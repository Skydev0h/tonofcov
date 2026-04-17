/**
 * Syntax-classification of FunC source via the tree-sitter-func grammar we
 * already load for AST analysis. Produces an ordered list of (start, end,
 * cssClass) tokens. Non-classified ranges (whitespace, punctuation) are left
 * as gaps — the renderer emits them as plain text.
 *
 * This is NOT a general-purpose highlighter — it only emits the specific
 * classes our CSS styles (tok-kw, tok-type, tok-string, tok-number,
 * tok-comment, tok-fn, tok-macro). Everything else is unclassified.
 */

export type Token = {
    start: number;
    end: number;
    cls: string | null;
};

// Direct node-type → CSS class mapping. These are leaf / near-leaf node
// types produced by tree-sitter-func that we visually distinguish.
const TYPE_TO_CLASS: Record<string, string> = {
    comment: 'tok-comment',
    number_literal: 'tok-number',
    string_literal: 'tok-string',
    function_name: 'tok-fn',
    include_directive: 'tok-macro',
    '#include': 'tok-macro',
    compiler_directive: 'tok-macro',
    '#pragma': 'tok-macro',
    // Keywords — appear as anonymous string-literal nodes in tree-sitter-func
    if: 'tok-kw',
    else: 'tok-kw',
    return: 'tok-kw',
    while: 'tok-kw',
    repeat: 'tok-kw',
    do: 'tok-kw',
    until: 'tok-kw',
    inline: 'tok-kw',
    inline_ref: 'tok-kw',
    impure: 'tok-kw',
    method_id: 'tok-kw',
    global: 'tok-kw',
    const: 'tok-kw',
    var: 'tok-kw',
    // Primitive types
    int: 'tok-type',
    slice: 'tok-type',
    cell: 'tok-type',
    builder: 'tok-type',
    cont: 'tok-type',
    tuple: 'tok-type',
    primitive_type: 'tok-type',
};

let parserPromise: Promise<any> | null = null;

async function getParser(): Promise<any> {
    if (parserPromise) return parserPromise;
    parserPromise = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const { Parser, Language } = require('web-tree-sitter');
        await Parser.init();
        const parser = new Parser();
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const wasmPath = require.resolve('@scaleton/tree-sitter-func/lib/tree-sitter-func.wasm');
        parser.setLanguage(await Language.load(wasmPath));
        return parser;
    })();
    return parserPromise;
}

export async function tokenizeFunC(source: string): Promise<Token[]> {
    const parser = await getParser();
    const tree = parser.parse(source);
    const tokens: Token[] = [];

    const walk = (node: any): void => {
        if (node.childCount === 0) {
            let cls = TYPE_TO_CLASS[node.type] ?? null;

            // Context-sensitive: a bare identifier that's the first child of
            // a function call/application is the call target — render as fn.
            if (!cls && node.type === 'identifier') {
                const parent = node.parent;
                if (
                    parent &&
                    (parent.type === 'function_application' || parent.type === 'function_call') &&
                    parent.firstChild === node
                ) {
                    cls = 'tok-fn';
                }
            }

            if (node.endIndex > node.startIndex) {
                tokens.push({ start: node.startIndex, end: node.endIndex, cls });
            }
        } else {
            for (let i = 0; i < node.childCount; i++) walk(node.child(i));
        }
    };
    walk(tree.rootNode);

    tokens.sort((a, b) => a.start - b.start);
    return tokens;
}

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Renders a source line range [lineStart, lineEnd) as HTML with syntax spans
 * overlaid. `tokens` must cover the source globally; we clip to the line.
 */
export function renderLine(source: string, lineStart: number, lineEnd: number, tokens: readonly Token[]): string {
    let result = '';
    let cursor = lineStart;

    for (const tok of tokens) {
        if (tok.end <= cursor) continue;
        if (tok.start >= lineEnd) break;

        if (tok.start > cursor) {
            result += escapeHtml(source.slice(cursor, tok.start));
            cursor = tok.start;
        }

        const startIn = Math.max(tok.start, lineStart);
        const endIn = Math.min(tok.end, lineEnd);
        const text = escapeHtml(source.slice(startIn, endIn));
        if (tok.cls) result += `<span class="${tok.cls}">${text}</span>`;
        else result += text;
        cursor = endIn;
    }

    if (cursor < lineEnd) result += escapeHtml(source.slice(cursor, lineEnd));
    return result;
}
