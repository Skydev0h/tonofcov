# tonofcov

Source-line code coverage for TON smart contracts. Works with `@ton/sandbox` + Jest test suites. Emits standard LCOV consumable by:

- **VSCode** — [Coverage Gutters](https://marketplace.visualstudio.com/items?itemName=ryanluker.vscode-coverage-gutters) extension (green/red markers in the gutter)
- **JetBrains IDEs** — native `Run > Show Coverage Data` (IntelliJ, WebStorm, etc.)
- **Codecov / Coveralls** — drop `lcov.info` into CI, get PR coverage-diff comments
- **`genhtml`** — standalone HTML report

Plus a built-in **self-contained HTML report** with syntax highlighting, gutter bars, multi-line throw classification, and a conditional-throws branch-coverage column.

## Status

**Functional for FunC.** Tolk support is planned once the Tolk compiler exposes structured debug-info (it currently only emits Fift line-comments). Tact is out of scope — different coverage story, different tool.

| Language | Status | Notes |
|---|---|---|
| FunC | working | Uses `@ton-community/func-js` `debugInfo` |
| Tolk | planned | Blocked on structured debug-info from tolk-js |
| Tact | out of scope | Separate tool |

## Install

```bash
npm install --save-dev tonofcov
```

Peer-deps: `@ton/sandbox` ≥ 0.37, `@ton/core` ≥ 0.63, `@ton/blueprint` ≥ 0.41, `@ton-community/func-js` ≥ 0.10, `jest` ≥ 29.

> **Known FunC compiler crash — pin `func-js-bin`**
>
> The `@ton-community/func-js-bin` `0.4.6-wasmfix.debugger.1` WASM build hard-crashes on some FunC constructs with `RuntimeError: null function or function signature mismatch` during debug-info compilation. The exact trigger isn't yet isolated but it reproduces on larger contracts (e.g. a full jetton-minter implementation).
>
> tonofcov's compile hook catches the crash and gracefully falls back to a non-debug compile for that specific contract — so your tests still run, but coverage data for it is dropped (it won't appear in the report).
>
> To get coverage for crashing contracts, pin to the last known-good build via npm `overrides`:
> ```json
> "overrides": {
>   "@ton-community/func-js-bin": "0.4.6-wasmfix.debugger.0"
> }
> ```
> Isolating the minimal FunC reproducer is a pending investigation — if you encounter the crash, a minimal `.fc` + stack trace in an issue is very welcome.

## Quick start

Extend your Jest config to use the preset:

```js
// jest.config.js
module.exports = {
  preset: 'tonofcov/jest-preset',
  // ...your existing config
};
```

Run tests as usual:

```bash
npm test
```

After the suite finishes, tonofcov writes:

- `coverage/lcov.info` — for IDE / CI tooling
- `coverage/html/index.html` — standalone HTML report (on by default)
- `coverage/gaps.md` + `coverage/gaps.json` — agent-friendly listing of uncovered functions, partial throws, and uncovered ranges (on by default)

## What you get

### Line coverage

Every FunC source line is classified covered / uncovered / partial / non-exec. `inline` and `inline_ref` functions propagate hits back to their call sites, and multi-line statements are kept consistent.

### Conditional-throw branch coverage

Each `throw_if` / `throw_unless` / `throw_arg_if` / `throw_arg_unless` is a two-sided branch: the happy path (cond matched → no throw) and the error path (cond matched → threw). Lines where only one side fired are marked **partial** (yellow). The HTML report shows per-throw fire counts in a dedicated column, and the index page has a separate "Conditional throws" progress section.

### Gaps report (agent-friendly)

`coverage/gaps.md` and `coverage/gaps.json` list everything uncovered, grouped by file and prioritized by actionability:

1. **UNCOVERED_FN** — a function with zero interior hits. Biggest single-test win.
2. **PARTIAL_THROW** — a conditional throw whose error branch never fired (or always fired). Untested error paths.
3. **UNCOVERED_RANGE** — contiguous uncovered lines inside an otherwise-covered function. Usually a missed branch.

Each entry includes the source snippet plus mechanical context — enclosing function, nearest conditional header, call sites. No natural-language hints; the consuming agent reads the code and decides how to trigger each gap.

### HTML report layout

Per-file page: `[throws counter | hit counter | line # | coloured border | syntax-highlighted source]`. Index page: Lines block (total / hit / % / bar) and Conditional-throws block (total / fired / % / bar). Files matching the `stdlib` exclude default are pushed below a divider and don't affect overall percentages.

## Configuration

All configuration is via environment variables.

| Variable | Default | Effect |
|---|---|---|
| `TONOFCOV_HTML` | enabled | Set to `0` / `false` / `off` to skip HTML report generation. |
| `TONOFCOV_NO_HTML` | — | Alternative kill switch for CI. `=1` disables HTML. |
| `TONOFCOV_GAPS` | enabled | Set to `0` / `false` / `off` to skip the gaps report (`gaps.md` + `gaps.json`). |
| `TONOFCOV_NO_GAPS` | — | Alternative kill switch for gaps. `=1` disables. |
| `TONOFCOV_OUT_DIR` | `coverage` | Output directory, relative to cwd. |
| `TONOFCOV_INCLUDE` | — | Comma-separated globs. If set, ONLY matching files contribute to overall totals. |
| `TONOFCOV_EXCLUDE` | `**/stdlib.fc` | Comma-separated globs. Matching files are shown but don't count toward totals. Set to empty string to count everything. |
| `TONOFCOV_TEST_NAME` | `""` | Populates LCOV's `TN:` field. |
| `TONOFCOV_NO_INLINE_PROPAGATE` | — | Set to `1` to skip inline-propagation and post-processing passes; raw aggregation only. |

Globs support `*` (any char except `/`) and `**` (any chars including `/`).

## CI example — GitHub Actions + Codecov

```yaml
name: ci
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm test
        env:
          TONOFCOV_NO_HTML: "1"   # LCOV only in CI; skip HTML
      - uses: codecov/codecov-action@v4
        with:
          files: coverage/lcov.info
          fail_ci_if_error: true
```

For GitLab CI, Bitbucket Pipelines, etc. — the pattern is identical: run Jest, upload `coverage/lcov.info`.

## Accuracy — the honest version

**Binary coverage** (line shown as covered vs not) is reliable — that's what LCOV is for and what we do well.

**Hit counts** are approximate. Relative ordering (A runs more than B) within a function is usually meaningful, but absolute numbers can be off by a small factor because the FunC compiler emits multiple opcodes per source statement. Conditional headers (`if` / `while` / etc.) are normalized; straight-line statements are not. See [KNOWN_ARTIFACTS.md](./KNOWN_ARTIFACTS.md) for the full catalogue of compiler-level quirks.

**Gas counters** are tracked internally but not yet exposed — the values double-count across inline expansions and are inconsistent with normalization. See artifact #8.

## How it works

1. A compile hook replaces blueprint's `doCompileFunc` to force `debugInfo: true`, then parses the debug-marks Cell into `(cell_hash, offset) → location_keys` maps.
2. A sandbox hook wraps `Executor.runTransaction` / `runTickTock` / `runGetMethod` to bump vmLog verbosity to `full_location_stack` and capture every executed step's cell hash, offset, gas, and exception state.
3. After tests (`afterAll` in the worker, then `globalTeardown` in the parent process), vmLogs are aggregated against the compile cache → raw per-line hits and throw counts.
4. Post-processing: inline-propagation, multi-line-statement propagation, sequential-fill, dead-branch suppression, conditional-header normalization, return-statement capping, non-code-hit stripping, function-signature propagation.
5. Emit LCOV and (by default) a static HTML report.

## License

MIT.

## Credits

Built on top of work from `@ton/sandbox`'s debug-marks format, `@ton-community/func-js` structured debug info, and `@scaleton/tree-sitter-func` (GPL-3.0 grammar, loaded at runtime). This package itself is MIT.
