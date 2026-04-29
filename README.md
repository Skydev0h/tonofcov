# tonofcov (TON of Coverage)

Source-line code coverage for TON smart contracts, with first-class **branch coverage on conditional throws** (`throw_if` / `throw_unless` / `throw_arg_*`) — the most audit-relevant signal in FunC - see exactly which error paths your tests never triggered.

Works with `@ton/sandbox` + Jest. Outputs:

- **`coverage/lcov.info`** — standard LCOV consumable by:
  - **VSCode** — [Coverage Gutters](https://marketplace.visualstudio.com/items?itemName=ryanluker.vscode-coverage-gutters) extension (green/red markers in the gutter)
  - **JetBrains IDEs** — native `Run > Show Coverage Data` (IntelliJ, WebStorm, etc.)
  - **Codecov / Coveralls** — drop into CI, get PR coverage-diff comments
  - **`genhtml`** — standalone HTML report
- **`coverage/html/index.html`** — built-in self-contained HTML report with syntax highlighting, gutter bars, multi-line throw classification, and a dedicated conditional-throws branch-coverage column.
- **`coverage/gaps.md`** + **`gaps.json`** — agent-friendly listing of uncovered functions, partial throws, and uncovered ranges, designed for LLM-driven test-writing loops.

## Status

**Functional for FunC.** Tolk support is planned once the Tolk compiler exposes structured debug-info (it currently only emits Fift line-comments). Tact is out of scope — different coverage story, different tool.

| Language | Status | Notes |
|---|---|---|
| FunC | working | Own WASM build with debugger extensions (`tonofcov-func-bin`) |
| Tolk | planned | Blocked on structured debug-info from tolk-js |
| Tact | out of scope | Separate tool |

## Install

```bash
npm install --save-dev tonofcov
```

Peer-deps: `@ton/sandbox` ≥ 0.37, `@ton/core` ≥ 0.63, `@ton/blueprint` ≥ 0.41, `jest` ≥ 29.

> **Note:** tonofcov ships its own FunC compiler WASM build (`tonofcov-func-bin`) with debugger extensions and a stack overflow fix for large contracts. You do **not** need to install or configure `@ton-community/func-js-bin` — tonofcov handles compilation internally.

## Quick start

Extend your Jest config with two hooks:

```js
// jest.config.js
module.exports = {
  preset: 'ts-jest',                                      // keep your existing preset
  setupFilesAfterEnv: ['tonofcov/dist/jest-setup'],       // add this
  globalTeardown: 'tonofcov/dist/jest-teardown',          // add this
  // ...your existing config
};
```

Most TON projects already use `ts-jest` or a preset shipped with `@ton/blueprint` / `@ton/sandbox`, and Jest only allows one preset — so adding the two hooks inline is the path of least resistance. If your project already sets `setupFilesAfterEnv`, append `'tonofcov/dist/jest-setup'` to the array rather than replacing it.

If you already have a `globalTeardown` of your own (Jest only allows one), wrap it:

```js
// jest.teardown.js
const tonofcovTeardown = require('tonofcov/dist/jest-teardown').default;
const myTeardown = require('./my-existing-teardown');

module.exports = async () => {
  await myTeardown();
  await tonofcovTeardown();
};
```

```js
// jest.config.js
module.exports = {
  globalTeardown: './jest.teardown.js',
  // ...
};
```

If you have no preset configured yet, you can use tonofcov's instead:

```js
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
| `TONOFCOV_NO_DEBUG` | — | Comma-separated substrings of target filenames to compile without debug info (no coverage for these contracts). Useful when debug-compiled code changes cell hashes that other contracts depend on. |
| `TONOFCOV_VERBOSE` | — | Set to `1` for detailed progress logs (compilation, aggregation, CFG caps). |
| `TONOFCOV_DEBUG` | — | Set to `1` for internal diagnostic output (between-fill ratio stats, etc.). |

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

1. A compile hook replaces blueprint's `doCompileFunc` with tonofcov's own FunC WASM compiler (`tonofcov-func-bin`) to force `debugInfo: true`, then parses the debug-marks Cell into `(cell_hash, offset) → location_keys` maps.
2. A sandbox hook wraps `Executor.runTransaction` / `runTickTock` / `runGetMethod` to bump vmLog verbosity to `full_location_stack` and capture every executed step's cell hash, offset, gas, and exception state.
3. After tests (`afterAll` in the worker, then `globalTeardown` in the parent process), vmLogs are aggregated against the compile cache → raw per-line hits and throw counts.
4. Post-processing: inline-propagation, multi-line-statement propagation, sequential-fill, dead-branch suppression, conditional-header normalization, return-statement capping, non-code-hit stripping, function-signature propagation.
5. Emit LCOV and (by default) a static HTML report.

## License

MIT.

## Credits

Built on top of work from `@ton/sandbox`'s debug-marks format, [krigga](https://github.com/krigga)'s FunC debugger compiler fork (`ctx_id`, `req_ctx_id`, branch coverage fields), and `@scaleton/tree-sitter-func` (GPL-3.0 grammar, loaded at runtime). The FunC WASM binary (`tonofcov-func-bin`) is built from [krigga/ton](https://github.com/krigga/ton) `debugger` branch via [ton-wasm-builder](https://github.com/krigga/ton-wasm-builder) and is GPL-2.0 (inheriting from TON source). This package itself is MIT.
