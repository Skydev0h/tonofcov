/**
 * FunC source parser via tree-sitter. Extracts:
 *   - function definitions with their inline qualifier
 *   - all function call sites (name + file + line)
 *   - multi-line statement ranges — used by post-processing to propagate hits
 *     to continuation lines of statements the compiler emits a single mark on
 *     (e.g. `begin_cell().store_*(...).end_cell()` spread across 5 lines)
 *
 * Uses @scaleton/tree-sitter-func (GPL-3.0 grammar) via web-tree-sitter.
 * Loaded lazily on first call so projects that don't need inline-aware
 * coverage pay no startup cost.
 */

export type InlineKind = 'inline' | 'inline_ref';

export type FuncFunction = {
    name: string;
    file: string;
    startLine: number;
    endLine: number;
    inlineKind?: InlineKind;
};

export type FuncCallSite = {
    callee: string;
    file: string;
    line: number;
};

export type ReturnStatement = {
    file: string;
    line: number;
};

export type StatementRange = {
    file: string;
    startLine: number;
    endLine: number;
};

export type Block = {
    file: string;
    startLine: number;
    endLine: number;
};

/**
 * A control-flow statement that branches (if/while/repeat/do). Its header
 * line carries the condition; one or more body blocks follow. Used by the
 * conditional-header propagation pass — if any body block has hits, the
 * condition line must have been evaluated too, even when the compiler
 * emits no direct mark on it.
 */
export type Conditional = {
    file: string;
    headerLine: number;
    bodies: Array<[number, number]>; // [startLine, endLine] per body block
};

export type FuncAnalysis = {
    functions: FuncFunction[];
    callSites: FuncCallSite[];
    statementRanges: StatementRange[];
    blocks: Block[];
    conditionals: Conditional[];
    returnStatements: ReturnStatement[];
    /**
     * Source lines that contain a throw-family call (throw / throw_if /
     * throw_unless / throw_arg / throw_arg_if / throw_arg_unless). Keyed
     * `file:line`. Populated from callSites whose callee matches the
     * throw pattern — in FunC these are regular builtin function calls.
     */
    throwSites: Set<string>;
    /**
     * Subset of throwSites restricted to the conditional family
     * (throw_if / throw_unless / throw_arg_if / throw_arg_unless). These
     * are the lines where a one-sided outcome (always threw / never threw)
     * represents partial branch coverage.
     */
    conditionalThrowSites: Set<string>;
    /**
     * Subset of throwSites where the throw is unconditional (plain `throw`
     * or `throw_arg`). These terminate control flow, so passes that
     * forward-propagate hits (e.g. sequential-fill) must stop at them
     * rather than bleed hits into dead code that follows.
     */
    unconditionalThrowSites: Set<string>;
    /**
     * For each line that is part of a throw call (including all continuation
     * lines of a multi-line throw_unless/throw_if expression), a pointer to
     * the throw's starting line. Rendering uses this to:
     *   - read the throw counter from the start line (that's where the
     *     THROW opcode fired; continuation lines always have 0 throws)
     *   - classify continuation lines consistently with the throw itself
     */
    throwStatementStart: Map<string, { file: string; line: number; conditional: boolean }>;
};

const THROW_CALLEE_RE = /^throw(_if|_unless|_arg(_if|_unless)?)?$/;
const CONDITIONAL_THROW_RE = /^throw(_arg)?_(if|unless)$/;

// Node types that represent a single atomic statement worth treating as one
// line-range for coverage propagation. block_statement / function_definition /
// if_statement are deliberately excluded — their ranges include sibling
// statements that may legitimately have independent coverage.
const STATEMENT_NODE_TYPES = new Set([
    'expression_statement',
    'return_statement',
    'variable_declaration',
    'throw_statement',
]);

const CONDITIONAL_NODE_TYPES = new Set([
    'if_statement',
    'while_statement',
    'repeat_statement',
    'do_statement',
]);

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

export async function analyzeSources(sources: Map<string, string>): Promise<FuncAnalysis> {
    const parser = await getParser();
    const functions: FuncFunction[] = [];
    const callSites: FuncCallSite[] = [];
    const statementRanges: StatementRange[] = [];
    const blocks: Block[] = [];
    const conditionals: Conditional[] = [];
    const returnStatements: ReturnStatement[] = [];

    for (const [file, source] of sources) {
        const tree = parser.parse(source);
        walk(tree.rootNode, source, file, functions, callSites, statementRanges, blocks, conditionals, returnStatements);
    }

    // Index statement ranges by (file, line) so we can expand a throw call
    // on line L to the full line span of its enclosing multi-line statement.
    // Without this, `throw_unless(error, a +\n b +\n c)` only classifies
    // line L as a throw site, and continuation lines look like regular green
    // code even when the throw never fired.
    const rangeByFileLine = new Map<string, StatementRange>();
    for (const r of statementRanges) {
        for (let l = r.startLine; l <= r.endLine; l++) {
            const key = `${r.file}:${l}`;
            // If a line is covered by multiple nested ranges, prefer the
            // tightest one — but in practice tree-sitter's expression /
            // return / variable_declaration statements don't nest.
            const existing = rangeByFileLine.get(key);
            if (!existing || (r.endLine - r.startLine) < (existing.endLine - existing.startLine)) {
                rangeByFileLine.set(key, r);
            }
        }
    }

    const throwSites = new Set<string>();
    const conditionalThrowSites = new Set<string>();
    const unconditionalThrowSites = new Set<string>();
    /**
     * For multi-line throws, records start line so rendering can look up
     * the throws counter and hit count on the statement's first line. Keyed
     * `file:line` (every line of a multi-line throw maps to its start).
     */
    const throwStatementStart = new Map<string, { file: string; line: number; conditional: boolean }>();
    for (const c of callSites) {
        if (!THROW_CALLEE_RE.test(c.callee)) continue;
        const isConditional = CONDITIONAL_THROW_RE.test(c.callee);
        const startKey = `${c.file}:${c.line}`;
        throwSites.add(startKey);
        if (isConditional) conditionalThrowSites.add(startKey);
        else unconditionalThrowSites.add(startKey);
        throwStatementStart.set(startKey, { file: c.file, line: c.line, conditional: isConditional });

        // If the call is part of a multi-line statement, mark every line in
        // the statement's range — so a throw_unless whose condition spans
        // 8 lines gets all 8 classified consistently (yellow if partial).
        const range = rangeByFileLine.get(startKey);
        if (range && (range.endLine > range.startLine)) {
            for (let l = range.startLine; l <= range.endLine; l++) {
                if (l === c.line) continue;
                const k = `${c.file}:${l}`;
                throwSites.add(k);
                if (isConditional) conditionalThrowSites.add(k);
                else unconditionalThrowSites.add(k);
                throwStatementStart.set(k, { file: c.file, line: c.line, conditional: isConditional });
            }
        }
    }

    return { functions, callSites, statementRanges, blocks, conditionals, returnStatements, throwSites, conditionalThrowSites, unconditionalThrowSites, throwStatementStart };
}

function walk(
    node: any,
    source: string,
    file: string,
    fns: FuncFunction[],
    calls: FuncCallSite[],
    stmts: StatementRange[],
    blocks: Block[],
    conditionals: Conditional[],
    returns: ReturnStatement[],
): void {
    if (!node) return;

    if (node.type === 'function_definition') {
        const nameNode = node.childForFieldName ? node.childForFieldName('name') : null;
        const name = nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : '?';
        let headerEnd = node.endIndex;
        for (let i = 0; i < node.childCount; i++) {
            const ch = node.child(i);
            if (ch.type === 'block_statement' || ch.type === 'body') {
                headerEnd = ch.startIndex;
                break;
            }
        }
        const header = source.slice(node.startIndex, headerEnd);
        let inlineKind: InlineKind | undefined;
        if (/\binline_ref\b/.test(header)) inlineKind = 'inline_ref';
        else if (/\binline\b/.test(header)) inlineKind = 'inline';

        fns.push({
            name,
            file,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            inlineKind,
        });
    }

    if (node.type === 'function_application' || node.type === 'function_call') {
        const fn = node.firstChild;
        if (fn) {
            const name = source.slice(fn.startIndex, fn.endIndex);
            if (/^[A-Za-z_][\w:]*$/.test(name)) {
                calls.push({
                    callee: name,
                    file,
                    line: node.startPosition.row + 1,
                });
            }
        }
    }

    if (STATEMENT_NODE_TYPES.has(node.type)) {
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        if (endLine > startLine) {
            stmts.push({ file, startLine, endLine });
        }
    }

    if (node.type === 'block_statement') {
        blocks.push({
            file,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
        });
    }

    if (node.type === 'return_statement') {
        returns.push({ file, line: node.startPosition.row + 1 });
    }

    if (CONDITIONAL_NODE_TYPES.has(node.type)) {
        const bodies: Array<[number, number]> = [];
        for (let i = 0; i < node.childCount; i++) {
            const ch = node.child(i);
            if (ch.type === 'block_statement') {
                bodies.push([ch.startPosition.row + 1, ch.endPosition.row + 1]);
            }
        }
        if (bodies.length > 0) {
            conditionals.push({
                file,
                headerLine: node.startPosition.row + 1,
                bodies,
            });
        }
    }

    for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i), source, file, fns, calls, stmts, blocks, conditionals, returns);
    }
}
