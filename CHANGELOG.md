# Changelog

All notable changes to this project are documented in this file.

## [0.0.56] — 2026-04-21

### Changed
- **Own FunC WASM compiler build.** Replaced dependency on `@ton-community/func-js` / `func-js-bin` with `tonofcov-func-bin` — our own WASM build of the FunC debugger compiler, built from [krigga/ton](https://github.com/krigga/ton) `debugger` branch. This fixes a WASM stack overflow that crashed debug compilation on larger contracts (e.g. EVAA master.fc at 8256 lines). Root cause: Fift interpreter recursion exceeded the default 1MB WASM stack; fix: `-sSTACK_SIZE=8388608` (8MB, matching native). The build pipeline is fully reproducible via [ton-wasm-builder](https://github.com/krigga/ton-wasm-builder) and open for future compiler modifications (e.g. inline function boundary markers).
- **Fresh WASM instance per compilation.** The FunC compiler uses global state that is not reset between calls. Previously, compiling multiple contracts in one jest run (e.g. master + user + blank) would crash on the second invocation. Each `compileFunc` call now creates a fresh WASM module instance, eliminating global state leakage.

## [0.0.55] — 2026-04-21

### Changed
- **Quieter default output.** Detailed progress logs (compilation registration, aggregation stats, CFG caps) now require `TONOFCOV_VERBOSE=1`. Internal diagnostics (between-fill ratio stats) require `TONOFCOV_DEBUG=1`. Summary lines (final counts, HTML/gaps paths, anomaly count) and warnings still print unconditionally.

## [0.0.54] — 2026-04-21

### Added
- **Analysis anomaly detection.** Six detectors flag suspicious lines in the HTML report with a blue background and a summary box at the top of the file page:
  1. Leading-fill: unconditional throw/return before first covered line in block
  2. Between-fill: anchor after unconditional throw/return in same scope
  3. Inline function body has hits but call site still zero after propagation
  4. Branch body has hits but condition header has none before propagation
  5. Function signature hits > 2× max body hits
  6. Return with hits but zero siblings in block (shared-RET, blocks > 3 lines only)
- **CFG return caps** via `req_ctx_id` chain tracing. For each return location, traces backwards through the compiler's control-flow graph to find the structurally correct upper bound (nearest ancestor with hits on a different line, or function entry count). Applied before `capReturnStatementHits`. On tgusd: 21 returns capped, reducing inflation up to 407× (e.g. jetton-minter.fc:367 raw=407 → cap=1).
- New module `src/cfg.ts`: `buildCfg`, `traceBack`, `findAncestorCap`, `findFunctionEntry`.
- Anomaly count badge in HTML index page (blue number in parentheses after filename, shown only when > 0).
- `compile-cache.ts`: `allEntries()` iterator for accessing all compiled contracts.

### Changed
- `normalizeLocations` now preserves `pos` (column position), `vars` (live variable names), and `reqCtxId` (CFG predecessor chain) from the compiler output. Previously dropped.
- `SourceLocation` type extended with `pos?`, `vars?`, `reqCtxId?` fields.
- Leading-fill in `sequentialFill` now `break`s (not `continue`s) at unconditional throws and returns — stops filling dead code instead of skipping and continuing.
- Serialized coverage (`.tonofcov-raw.json`) now includes `cfgReturnCaps` alongside `opcodeDivisors`.
- Between-fill ratio diagnostic (temporary, for metric collection).

## [0.0.53] — 2026-04-18

### Changed
- Gaps report now respects the same `TONOFCOV_INCLUDE` / `TONOFCOV_EXCLUDE` filters as the index page (default excludes `**/stdlib.fc`). Prevents vendored stdlib from flooding the gaps list.
- Extracted `buildShouldCountFn` into a shared `src/filters.ts` used by both the HTML writer and the gaps generator.

## [0.0.52] — 2026-04-18

### Added
- **Gaps report.** After each run tonofcov writes `coverage/gaps.md` and `coverage/gaps.json` — a structured listing of uncovered code grouped by file and prioritized by actionability: `UNCOVERED_FN` (zero-interior-hit functions), `PARTIAL_THROW` (conditional throws with one-sided outcomes), then `UNCOVERED_RANGE` (contiguous uncovered lines inside covered functions). Each entry carries a source snippet and mechanical AST context (enclosing function, nearest conditional, call sites). Designed as an LLM-agent input for iterative test-writing loops. On by default; disable with `TONOFCOV_GAPS=0` / `TONOFCOV_NO_GAPS=1`.
- `IDEAS.md` — captures design directions we've discussed but not yet built (CLI scoping, per-test coverage attribution, diff-based gaps, etc.).

## [0.0.51] — 2026-04-18

### Added
- `KNOWN_ARTIFACTS.md` — known compiler-level quirks we currently surface (instruction-level hit inflation, shared-RET edge cases, implicit throws, gas-counter gaps, overall accuracy bounds). Living document, add entries when investigating new anomalies.
- `PUBLISHING.md` — maintainer checklist for cutting releases.
- `package.json` now ships `CHANGELOG.md` and `KNOWN_ARTIFACTS.md` via the `files` field.
- `package.json` metadata: `repository`, `bugs`, `homepage` fields for the npm registry.

### Changed
- README rewritten: removed "planned API" disclaimer, documented all env vars, added CI example (GitHub Actions + Codecov), added an honest accuracy section linking to KNOWN_ARTIFACTS.
- R&D scripts in `scripts/` now read test-project path from `TONOFCOV_TEST_PROJECT` env var (default `./test-project`) instead of hardcoding any internal path.

## [0.0.50] — 2026-04-17

### Added
- Index-page separation: files matching the default exclude pattern (`**/stdlib.fc`) are pushed BELOW a "Excluded from totals (vendored / stdlib)" divider row and are NOT summed into the header percentages. They're dimmed but still linked.
- Include / exclude configuration via env vars:
  - `TONOFCOV_INCLUDE=pat1,pat2,...` — if set, ONLY files matching these globs count toward totals.
  - `TONOFCOV_EXCLUDE=pat1,pat2,...` — overrides the default exclude list. Set to empty string to disable all excludes.
  - Globs support `*` (any char except `/`) and `**` (any chars including `/`).
- Footer `generated by tonofcov vX.Y.Z` linking to the repo. Version string read from tonofcov's own `package.json` at runtime.
- Vertical separator between the File column and the Lines column group (matching the existing Lines/Throws separator).

## [0.0.49] — 2026-04-17

### Changed
- Throw counter column shown only on the **start line** of a multi-line throw. Continuation lines keep the yellow/green classification and the propagated hit count but leave the throws column blank to reduce visual noise.

## [0.0.48] — 2026-04-17

### Added
- `throwStatementStart` map exposed from `analyzeSources` — maps every line of a multi-line throw call (including continuation lines) to the throw's start line and its conditional/unconditional flag.
- HTML renderer reads origin-line stats for continuation lines so multi-line `throw_unless` expressions get a consistent classification.

### Changed
- `propagateMultilineStatements` now **forces** all lines of a multi-line statement to the minimum non-zero hit across the range (was: fill only uncovered lines with the max). Eliminates the 69/137 oscillation inside multi-line `throw_unless(err, a +\n b +\n c)` where instruction-level inflation on continuation lines made the same statement appear to have two different hit counts.
- `conditionalThrowSites` / `throwSites` / `unconditionalThrowSites` now include **every line** of a multi-line throw, so the whole expression gets uniformly colored (yellow when the throw never fired).
- Index-page throw counter dedupes by throw origin line — one multi-line throw counts as one throw site, not N.

## [0.0.47] — 2026-04-17

### Changed
- Opcode-normalization scope narrowed to **conditional headers only** (`if` / `while` / `repeat` / `do`). Divisor is still computed for every line via `computeOpcodeDivisors()`, but the divide-by-opcode-count step only applies to conditional-header lines. Straight-line statements keep their raw counts.
- Reason: the naive "divide every line by its opcode count" from 0.0.46 undercounted simple assignments whose compiler-emitted opcode count wasn't a clean multiplier of the execution count (e.g. line 91 `int x = (y & 2) == 2;` raw 26 → incorrectly normalized to 13).

## [0.0.46] — 2026-04-17 *(superseded by 0.0.47)*

### Added
- `computeOpcodeDivisors()` in `compile-cache.ts`. Walks every registered debug-marks map and, for each `(file, line)` referenced by any opcode, computes the minimum per-cell count of distinct offsets marking that line. MIN (not MAX or SUM) correctly handles textually-inlined functions whose body is duplicated into every caller cell.

### Changed *(reverted in 0.0.47)*
- Applied the divisor globally to every line's raw hits — inflation on complex expressions was fixed but simple assignments got undercounted. Reverted scope in 0.0.47.

## [0.0.45] — 2026-04-17

### Added
- `capReturnStatementHits` polish pass. The FunC compiler often pools multiple `return` sites through one shared RET opcode and attaches the debug mark to the first `return ();` in source. That line then absorbs hits from every return path in the function. This pass caps a return-statement's hit count by the max of sibling statements in its enclosing block, which restores the per-branch-local count. Runs BEFORE other propagation so downstream anchors see the corrected values.
- `return_statement` nodes extracted in `func-ast.ts`.

## [0.0.44] — 2026-04-17

### Added
- `stripNonCodeHits` polish pass. Removes hits from lines whose source is pure punctuation / whitespace / comments (`{`, `}`, `;`, blank, `;;`-comment). The compiler emits `ret:true` marks on a function's closing `}` even for inline functions — those carry hit counts that shouldn't appear in coverage.

### Changed
- `propagateConditionalHeaders` now enforces `header.hits >= body.firstEntryHits`. Previously a header with a low raw count (e.g. instruction-level 26) could appear to have fewer hits than its body's first line (46), which is logically impossible.

## [0.0.43] — 2026-04-17

### Changed
- `propagateInlineHits` skips call sites that already have raw hits. Inside functions with deep loops (`recv_internal`'s while), a call site with an accurate raw count (e.g. 458) was being bumped up to the inline function's total invocation count (599) because the local-block cap from 0.0.42 allowed it. Skip-if-has-raw preserves the more authoritative raw value.

## [0.0.42] — 2026-04-17

### Added
- Local-flow cap in `propagateInlineHits`. Before propagating an inline function's invocation count to a call site, the count is clamped by the **raw max hit in the innermost block containing the call site**, snapshotted before any mutation. Fixes the case where `check_same_workchain` (called 1298× across the codebase) pumped 1298 hits into the `send_jettons` call site even though `send_jettons` only ran twice. Uses `Math.max` (not `+=`) so multiple inline calls on the same source line don't stack to N×cap.

## [0.0.41] — 2026-04-17

### Added
- Leading-fill in `sequentialFill`. Symmetric to trailing-fill — from the block's opening `{` forward up to the first `ownHit`. Fills lines whose calls are TVM built-ins (`load_msg_addr`, `load_coins`, etc.) with no source-level FunC body, so inline propagation can't give them hits. Skips past unconditional throws and conditional headers so flow-divergent constructs don't poison the fill.

## [0.0.40] — 2026-04-17

### Changed
- Trailing-fill in `sequentialFill` stops at **conditional headers** (if / while / repeat / do) in addition to unconditional throws. Prevents hits from bleeding past an `if`-dispatch chain into the following `throw(err)` and the unreachable if-body after it.

## [0.0.39] — 2026-04-17

### Changed
- HTML report is now generated **by default**. Disable with `TONOFCOV_HTML=0` / `=false` / `=off` or `TONOFCOV_NO_HTML=1`.
- Trailing-fill stops at unconditional throws. If the last `ownHit` in a block is an unconditional `throw()`, trailing-fill is skipped entirely — dead code after an unconditional terminator must not inherit hits.

## [0.0.38] — 2026-04-17

### Added
- Trailing-fill in `sequentialFill`. Propagates the last `ownHit`'s count forward to the block's closing `}`. Fixes tail `return ();` statements (e.g. lines 587, 637, 701, 731 in jetton-minter) that don't get their own debug marks because the compiler merges them with the implicit function epilogue.

## [0.0.37] — 2026-04-17

### Added
- Second "Conditional throws" column on the index page with its own totals, percentage, and red progress bar. Shows `throwsTotal` (conditional throw sites in the file) and `throwsCovered` (sites that actually fired ≥1 time).
- Vertical separator between the Lines and Conditional-throws column groups.

### Fixed
- Index-page header alignment — switched selector from `.file-list td.num` to `.file-list .num` so `<th class="num">` headers right-align with their numeric columns.

## [0.0.36] — 2026-04-17

### Reverted
- Restored the 0.0.34 dedup-safe aggregator after verifying that the 0.0.35 experiment (firstStatement-only gating) regressed coverage from 703 to 335 lines. Documented as a memoized non-fix — gating loses real signal when a statement's leading opcode doesn't carry `first_stmt`.

## [0.0.35] — 2026-04-17 *(superseded by 0.0.36)*

### Attempted
- Count only steps whose marks include `firstStatement: true`. Regressed coverage (703 → 335 lines) because `throw_unless` and similar don't always carry `first_stmt` on their leading opcode. Reverted.

## [0.0.34] — 2026-04-17

### Fixed
- Aggregator dedup: seed the `seen` set with the statement's `(file, line)` key before the unique-location loop. Previously, if a non-statement `SourceLocation` object for the same `(file, line)` appeared first in `located[]`, the line was double-counted. The fix is hit-count-neutral on the contracts we've tested (no duplicate-key cases in practice) but correct in principle.

## [0.0.33] — 2026-04-17

### Changed
- `propagateFunctionSignatures` now uses the **first-hit line's** count instead of `maxInterior`. A recv_internal function whose body contains a deep `while` loop (41167 iterations) was displaying `41167` on the signature line; the first-hit line is the first real statement, so the signature now reads as the function's call count (468).
- `propagateConditionalHeaders` now sums the first-hit line across each body (was: max across any interior line). Same motivation — header counts shouldn't inherit nested-loop iteration counts.

### Added
- Yellow (`r-partial`) classification for conditional throws (`throw_if` / `throw_unless` / `throw_arg_if` / `throw_arg_unless`) with one-sided coverage (throws === 0 or throws === hits). Signals an untested branch side.

## [0.0.32] — 2026-04-17

### Added
- Throw tracking. Aggregator detects steps whose opcode matches `/^THROW/i` AND raised an exception, incrementing a new `throws` field on `LineStats`.
- `throwSites` / `conditionalThrowSites` derived from `func-ast.ts` callSites matching the throw family (`throw` / `throw_if` / `throw_unless` / `throw_arg*`).
- HTML report: new `g-throws` column to the left of the hits column. Bright red (`#cf222e`), bold. Blank on lines without a throw call. Shows the number of times the THROW opcode actually fired at this line.

## [0.0.31] — 2026-04-16

Baseline reference for the throws-work series. Features at this point:

- `suppressDeadBranchArtifacts` — strips hits from block bodies that only contain calls to dead inline functions.
- Inline-aware coverage propagation, multi-line statement propagation, sequential-flow fill.
- Conditional-header and function-signature propagation using `maxInterior`.
- Dead-function-artifact removal.
- HTML report with border-left gutter coloring, GitHub-Light palette, index page with Lines progress bar.
- LCOV output, Jest `setupFilesAfterEnv` + `globalTeardown` integration.
- `@ton-community/func-js-bin` pinned to `0.4.6-wasmfix.debugger.0` (later versions regressed debug WASM).

---

*Before 0.0.31 was the initial R&D phase: clean-room vmLog parser, aggregator, LCOV emitter, blueprint compile-hook, sandbox-hook, and the tree-sitter-based `func-ast.ts`. Versions 0.0.1 – 0.0.30 were rapid iteration of those pieces; changelog detail starts at 0.0.31 where the behavior stabilized and anomalies started being investigated individually.*
