/**
 * Sequential-flow fill.
 *
 * The FunC debug compiler creates LocationEntry records for every statement
 * but only attaches first_stmt/ret/branch markers to a subset — simple
 * assignments (`int x = ...;`) often get no hit-triggering marker. If a
 * statement is never mentioned in `marks[cellHash][offset]`, no amount of
 * vmLog replay will light it up.
 *
 * Logically though, between two covered statement lines L1 < L2 in the same
 * basic block, every statement between them executed on the path from L1 to
 * L2 (barring a throw, which would have prevented L2 from being hit).
 *
 * This pass propagates that: for each block_statement, considering only the
 * hits that fall in this block's OWN scope (not inside any tighter sub-block),
 * fill the code-bearing gaps between consecutive hit lines with
 * `min(L1.hits, L2.hits)`.
 *
 * Per-block scoping prevents a hit inside an if-branch body from affecting a
 * sibling branch or the parent scope, and vice-versa: the parent scope's
 * hits don't fill lines inside inner blocks (which need their own evidence).
 */

import type { Coverage } from './types';
import type { Block } from './func-ast';

export function sequentialFill(
    coverage: Coverage,
    blocks: readonly Block[],
    sources: Map<string, string>,
    /**
     * Set of `file:line` keys for unconditional throw call sites
     * (throw / throw_arg, NOT throw_if/throw_unless). Used to stop
     * trailing-fill so dead code after an unconditional throw doesn't
     * get spurious hits. Optional — omit for no special handling.
     */
    unconditionalThrowSites: Set<string> = new Set(),
    /**
     * Set of `file:line` keys for conditional-flow headers (if / while /
     * repeat / do). Trailing-fill must not propagate past these — an
     * `if (cond) { ...return... }` in the middle of a block can divert
     * flow, so code after the if sees fewer hits than the last straight-
     * line anchor before the if. Stop forward-fill at such lines.
     */
    conditionalHeaders: Set<string> = new Set(),
): void {
    const blocksByFile = new Map<string, Block[]>();
    for (const b of blocks) {
        const arr = blocksByFile.get(b.file) ?? [];
        arr.push(b);
        blocksByFile.set(b.file, arr);
    }

    for (const [file, fileBlocks] of blocksByFile) {
        const fc = coverage.files.get(file);
        if (!fc) continue;
        const source = sources.get(file);
        if (!source) continue;
        const sourceLines = source.split(/\r?\n/);

        for (const block of fileBlocks) {
            // Collect hits that belong to THIS block's own scope, i.e. inside
            // its line range AND not inside any tighter sub-block.
            const ownHits: Array<{ line: number; count: number }> = [];
            for (const [line, stats] of fc.lines) {
                if (line < block.startLine || line > block.endLine) continue;
                if (stats.hits <= 0) continue;
                if (findInnermost(fileBlocks, line) !== block) continue;
                ownHits.push({ line, count: stats.hits });
            }
            if (ownHits.length < 1) continue;
            ownHits.sort((a, b) => a.line - b.line);

            // (1) Between-anchor fill: gap between consecutive ownHits.
            for (let i = 0; i + 1 < ownHits.length; i++) {
                const L1 = ownHits[i];
                const L2 = ownHits[i + 1];
                if (L2.line - L1.line <= 1) continue;

                const count = Math.min(L1.count, L2.count);
                for (let line = L1.line + 1; line < L2.line; line++) {
                    // Only fill lines that belong to THIS block's own scope
                    // (same innermost — not inside a sub-block).
                    if (findInnermost(fileBlocks, line) !== block) continue;
                    if (fc.lines.has(line)) continue;
                    if (!isCodeLine(sourceLines[line - 1])) continue;
                    fc.lines.set(line, { hits: count, totalGas: 0 });
                }
            }

            // (2) Leading-fill: from the block's opening `{` forward up to the
            // FIRST ownHit. Some statements (call sites of TVM built-ins like
            // load_msg_addr, load_coins that have no source-level FunC body)
            // don't get their own debug marks and can't be propagated by the
            // inline pass — they appear as dark holes before the first real
            // anchor. Fill them with the first anchor's count.
            //
            // Symmetric to trailing-fill: skip over unconditional throws
            // (unreachable) and conditional headers (flow-divergent).
            const first = ownHits[0];
            for (let line = block.startLine + 1; line < first.line; line++) {
                if (findInnermost(fileBlocks, line) !== block) continue;
                if (unconditionalThrowSites.has(`${file}:${line}`)) continue;
                if (conditionalHeaders.has(`${file}:${line}`)) continue;
                if (fc.lines.has(line)) continue;
                if (!isCodeLine(sourceLines[line - 1])) continue;
                fc.lines.set(line, { hits: first.count, totalGas: 0 });
            }

            // (3) Trailing-fill: from the last ownHit forward to the block's
            // closing `}`. Tail `return ();` statements don't get their own
            // debug mark — the compiler merges the RET opcode with the
            // implicit function epilogue — so without this pass they appear
            // uncovered despite being reached. We propagate the last
            // anchor's count to any code-bearing lines between it and `}`.
            //
            // Stop at any unconditional throw() — code after an unconditional
            // terminator is dead and must not inherit hits. If the last ownHit
            // itself is such a throw, no forward-fill at all.
            const last = ownHits[ownHits.length - 1];
            if (!unconditionalThrowSites.has(`${file}:${last.line}`)) {
                for (let line = last.line + 1; line < block.endLine; line++) {
                    if (findInnermost(fileBlocks, line) !== block) continue;
                    // Stop at terminators and flow-divergent constructs: an
                    // unconditional throw ends flow, and a conditional header
                    // (if/while/etc.) can consume some portion of the flow in
                    // its body — lines after it shouldn't inherit the anchor
                    // count unchanged.
                    if (unconditionalThrowSites.has(`${file}:${line}`)) break;
                    if (conditionalHeaders.has(`${file}:${line}`)) break;
                    if (fc.lines.has(line)) continue;
                    if (!isCodeLine(sourceLines[line - 1])) continue;
                    fc.lines.set(line, { hits: last.count, totalGas: 0 });
                }
            }
        }
    }
}

/**
 * Strict-interior innermost block lookup. A line on a block's opening `{`
 * (startLine) or closing `}` (endLine) belongs to the PARENT scope — that
 * line is syntactically the header / close of the enclosing control-flow
 * statement, not executable code inside the block itself. Under this rule,
 * an `if (cond) {` line is in the same scope as the condition being
 * tested, which is what we want for sequential-flow fill: if outer flow
 * passed around the if-statement, the header line is part of the flow.
 */
function findInnermost(blocks: readonly Block[], line: number): Block | undefined {
    let best: Block | undefined;
    let bestSpan = Infinity;
    for (const b of blocks) {
        if (line <= b.startLine || line >= b.endLine) continue;
        const span = b.endLine - b.startLine;
        if (span < bestSpan) {
            best = b;
            bestSpan = span;
        }
    }
    return best;
}

function isCodeLine(raw: string | undefined): boolean {
    if (!raw) return false;
    const trimmed = raw.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith(';;')) return false;
    if (trimmed === '{' || trimmed === '}' || trimmed === ';') return false;
    if (trimmed.startsWith('{-') || trimmed.startsWith('-}')) return false;
    return true;
}
