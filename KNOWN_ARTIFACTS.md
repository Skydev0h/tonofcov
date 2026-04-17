# Known Artifacts

Compiler-level and format-level quirks that tonofcov currently surfaces in its reports. These aren't bugs in the aggregation or propagation passes — they reflect how the FunC compiler emits debug info at the TVM instruction level — but it's useful to keep them on record so we don't rediscover them or misdiagnose user reports.

Format for each entry:
- **Observed**: what shows up in the report
- **Root cause**: why it happens
- **Mitigation**: what we currently do (if anything)
- **Future fix ideas**: plausible directions
- **Severity**: impact on the user

---

## 1. Instruction-level inflation on straight-line statements

- **Observed**: a line like `int x = (y & 2) == 2;` can show a hit count that's 2× the actual statement-execution count. Cannot be fixed by blanket opcode-divisor normalization without undercounting other statements.
- **Root cause**: FunC compiler emits 1–5 TVM opcodes per source statement. Each opcode carries a debug mark on the same source line. Our aggregator records one hit per executed opcode-step (with per-step file:line deduplication), so raw counts are `opcodes_on_line × executions`. Which opcodes carry `first_stmt` vs plain marks varies by expression shape.
- **Mitigation**: Conditional headers (`if` / `while` / `repeat` / `do`) are normalized in v0.0.47 using a divisor computed from `computeOpcodeDivisors()` in compile-cache. Other lines are left raw.
- **Future fix ideas**:
  - Per-line divisor with per-cell MIN works for conditional headers (reliably multi-opcode with `first_stmt` on the first instruction). Would need a smarter classifier to apply it safely to other lines — maybe AST-aware: expressions matching certain shapes get specific divisor hints.
  - FunC could emit cleaner "one first_stmt per statement, no spurious marks on continuation opcodes" debug info upstream; doesn't exist today.
- **Severity**: LOW — users notice but the relative coverage picture (which lines are hit vs not, branch coverage) is still accurate.

## 2. Slowly-growing hit counts across an inline function body

- **Observed**: a straight-line `inline` function that parses data from multiple cell refs (e.g. a `load_data` helper with several `load_ref().begin_parse()` boundaries and a ternary for optional fields) can show hit counts that drift UPWARD by ~2 at each slice-transition or ternary-completion boundary within the body. Example: a function called ~591 times shows `591, 591, 591, 591, 591, 593, 593, …, 595, 595, 597, 597, 597, 597, 597, 599, 599, 599, 599` — ~1–2% drift across the body.
- **Root cause**: unclear from static analysis of debug marks alone. For N callers with inline expansions, there are N cells each with identical offset-to-line templates. If every offset fires once per cell invocation, all lines should sum to the same total. They don't. Suspected contributors:
  - Continuation cells for the ternary (compiled in a gap between the source lines that bracket it) may have debug marks on post-ternary source lines that our cell enumeration doesn't account for.
  - A reference-callable fallback version of the inline function (FunC sometimes emits one alongside the inline expansions) with its own prologue/epilogue contributing to later-line offsets.
  - Cleanup / stack-rebalancing opcodes inserted by the compiler between statements carrying marks on the NEXT source line.
- **Mitigation**: none.
- **Future fix ideas**:
  - Add a diagnostic mode to the aggregator that records per-`(cell, offset)` hit counts (not just per source line) so we can see which specific offset fires the extra +2. Requires plumbing and bloats the raw JSON but would conclusively identify the source.
  - Add a polish pass that MIN-normalizes hit counts across a function body IF the function contains no loops (`while` / `repeat` / `do` AST nodes). Safe for straight-line parsing helpers. For loop-containing functions, skip — loop bodies legitimately see more hits than the header.
- **Severity**: LOW. Absolute drift is ~1–2%. Coverage verdict (covered / not) is unaffected.

## 3. Shared-RET in single-statement blocks

- **Observed**: a block containing ONLY a `return` statement shows that return's raw hit count unchanged — even when the count is obviously inflated by the compiler's shared-RET pattern (a single pooled RET opcode whose debug mark points to one of multiple return sites, absorbing hits from all branches).
- **Root cause**: `capReturnStatementHits` clamps a `return`'s hits by the MAX of sibling statement hits in the same innermost block. If there are no siblings (single-statement block), `siblingMax === 0` and the cap is skipped.
- **Mitigation**: `capReturnStatementHits` (added v0.0.45) handles multi-statement blocks correctly.
- **Future fix ideas**:
  - When the block has no siblings, walk UP to the parent block and use its sibling max. Careful: this could under-cap if the single-statement block is inside an unusual caller.
  - Or use the enclosing function's `firstStmtLine` hit as a fallback cap — "a return can never fire more often than the function was entered".
- **Severity**: LOW — only affects unusually structured blocks like `if (c) { return (); }`. Hit count inflation there usually still reads as "the branch fired".

## 4. Implicit throws from stdlib builtins

- **Observed**: a line like `(int status, ...) = load_data();` shows 27 hits but the next line shows 26. No user-visible `throw_if` / `throw_unless` on the call line, so the throws counter column is blank — yet one of 27 invocations threw inside the inline expansion of `load_data` (likely `ds.end_parse()` with leftover bytes).
- **Root cause**: our throws tracking only counts `THROW*` opcode executions that happen AND attributes them to the source line via the step's marks. For implicit throws deep inside a stdlib builtin call chain (inlined or not), the throw's source-line mark points to the builtin's internal location, not the user's call-site line.
- **Mitigation**: none — the drop reflects real execution.
- **Future fix ideas**:
  - For throws happening on lines NOT covered by a `throw_if` / `throw_unless` / `throw` call site, record a separate "implicit throws" counter and display in a subtle marker on the HTML (e.g. ⚠ icon next to the hit count).
  - Attribute implicit throws to the statement's start line via AST lookup: if a step caused a throw and the step's current location is inside a builtin chain, attribute to the enclosing user-source statement.
- **Severity**: LOW — confusing to first-time readers but the 1-off drop is genuine information about test coverage of implicit error paths.

## 5. Multi-expansion within a single caller cell

- **Observed**: inline-hit propagation in `propagateInlineHits` caps a call site's count by the MIN across cells of "offsets marking this line". If EVERY caller cell contains 2+ textual expansions of the same inline function (so all cells show `2 × opcodes-per-line`), the MIN is still `2 × K` and we under-normalize — propagated count is half of reality.
- **Root cause**: MIN assumes at least one cell has exactly 1 expansion. If all callers invoke the inline function 2+ times per caller invocation, there's no "baseline" cell to anchor MIN to.
- **Mitigation**: none beyond MIN. In practice rare — most callers invoke a given inline once per invocation.
- **Future fix ideas**:
  - Use tree-sitter `callSites` to count DISTINCT call sites of the inline function in each caller's source. The compiler won't usually merge different call sites into one expansion, so `callSites-per-caller-file` gives an upper bound on per-cell expansion count. Divide accordingly.
- **Severity**: LOW — only manifests in contracts where the same inline is called multiple times in each user function. Haven't encountered in practice so far.

## 6. if-header opcode count varies by condition complexity

- **Observed**: `if (x)` and `if (x == y)` and `if (x & 1)` emit different opcode counts (1, 3, 2 respectively), so the normalization divisor differs per header. Generally correct because `computeOpcodeDivisors()` derives divisor from actual marks, but if the marks on a complex condition are non-uniform (e.g. some opcodes uninstrumented), the divisor is wrong.
- **Root cause**: debug info fidelity. Not every TVM opcode gets a source-line mark; the FunC compiler decides which opcodes to mark.
- **Mitigation**: our divisor is per-`(file, line)` based on "how many distinct offsets carry ANY mark on this line". So if only marked opcodes contribute hits (which is what our aggregator counts), divisor matches the number of marked opcodes. Correct in principle.
- **Future fix ideas**:
  - None obvious. Would need deeper compiler cooperation.
- **Severity**: LOW — rare mismatch. Observed if-header counts on tested contracts all normalize to recognizable values (e.g. matching the enclosing function's call count).

## 7. Overall hit-count accuracy — moderate only

- **Observed**: hit counts displayed per line are approximate. Relative ordering (A is hit more often than B) is usually reliable within a function; absolute numbers for a given line may be off by a factor of 1–3× from the underlying statement-execution count.
- **Root cause**: hit counts are the sum of executed opcode-steps whose debug marks land on each source line. Because:
  - The compiler emits multiple opcodes per statement and all of them carry marks (artifact #1).
  - Inline propagation caps counts by local-block MIN which is only an estimate (artifact #5 edge case).
  - Shared-RET / tail-return artifacts are handled for multi-statement blocks but not single-statement ones (artifact #3).
  - Sequential / trailing / leading fill use min of neighbor anchors, which over- or under-estimates in specific flow patterns.
- **Mitigation**: specific cases are already normalized — conditional headers (opcode divisor), multi-line statements (MIN-force), trailing/leading fill at block boundaries (guards against control-flow divergence), shared-RET via `capReturnStatementHits`.
- **Future fix ideas**: none general. Would need deeper debug-info cooperation from the FunC compiler (one `first_stmt` mark per statement, no marks on continuation opcodes) to eliminate all sources of drift.
- **Severity**: LOW–MEDIUM. Fine for relative comparisons and "is this branch exercised" questions. NOT fine for strict numeric claims like "function X was called exactly N times". When users need an exact call count, point them at a specific raw anchor line (typically the function's first statement).

## 8. Gas counter is not yet trustworthy for display

- **Observed**: `totalGas` is tracked in `LineStats` alongside hit counts but is NOT surfaced in the LCOV output or HTML report, for good reason — the values are inconsistent.
- **Root cause**: three compounding issues:
  1. **Double attribution across inline expansions**. For each step the aggregator calls `recordLine()` once per unique `(file, line)` the step touches. We `existing.totalGas += step.gas` in every such call, so a single opcode whose marks point to both a call-site line and an inlined callee line contributes its gas to BOTH lines. Double (or triple) counting.
  2. **Zero gas on propagation-filled lines**. `propagateInlineHits`, `sequentialFill`, and `propagateMultilineStatements` create new entries with `totalGas: 0`. Those lines display as covered but have no gas signal — fine if we hide gas, misleading if we show it.
  3. **Inconsistent normalization**. `hits` gets divided by opcode count on conditional headers (v0.0.47) but `totalGas` is never scaled. `totalGas / hits` therefore means different things on different lines: per-opcode gas on raw lines, per-statement gas on normalized cond-header lines, zero on filled lines.
- **Mitigation**: gas is simply not exposed in any output.
- **Future fix ideas** (needed before gas can be displayed):
  - Attribute gas to ONE canonical line per step (the `first_stmt` location, or `located[0]` fallback) rather than to every matched line.
  - Propagate `totalGas` alongside `hits` in inline-propagate / sequential-fill: divide the inline's total-body gas proportionally across its call sites, or leave filled lines explicitly gas-unknown rather than zero.
  - Decide on a single display metric — most likely "average gas per statement execution" (`totalGas / hits` after consistent normalization) since it's stable across test-count changes.
  - Add a `gasLabel` column to the HTML that reads only when all three issues are addressed, or falls back to em-dash when unreliable.
- **Severity**: MEDIUM. Users will eventually want per-line gas for optimization work; until the above are fixed the numbers would actively mislead.

---

## How to add an entry

When debugging a new anomaly, if root-causing it would require runtime instrumentation or deeper compiler cooperation:

1. Add a new numbered section above with the same structure.
2. Reference concrete line numbers and observed values from whichever contract you were investigating so future-you can verify the artifact still exists (keep names generic — "the test contract" is fine).
3. If it's fixed in a later version, move the entry to a `## Resolved` section at the bottom (or remove and note in CHANGELOG).
