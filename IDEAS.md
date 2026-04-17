# Future ideas

Design notes for features we've discussed but haven't built yet. Loose, may pivot.

## Agent-assisted test writing (near-term, partially built)

Coverage reports are traditionally for humans. LLM agents writing tests for uncovered paths would benefit from a dedicated output format.

**Implemented in this session**: `coverage/gaps.md` + `coverage/gaps.json` — structured view of what's uncovered, joined with source snippets and AST-derived enclosing context. Priority: uncovered functions > partial throws > uncovered ranges within covered functions.

**Principles we settled on**:
- Facts only, no interpretation. We give location + code + structural context. Agent reasons about how to trigger the code itself.
- Sort by actionability — biggest gaps first.
- Compact markdown that an LLM can read in one pass; JSON alongside for tooling.

## Future extensions

### CLI scoping

Generate gaps for a specific file / function / range only:

```
tonofcov gaps --file contracts/jetton-wallet.fc --fn receive_jettons
```

Useful when an agent is iterating on one function and doesn't want the whole codebase's gaps in its context every turn.

### Skill / slash-command integration

This naturally pairs with a Claude Code skill or subagent config that:
1. Runs `npm test` (tonofcov generates gaps)
2. Reads `coverage/gaps.md`
3. Writes a new test targeting the highest-priority gap
4. Re-runs tests
5. Verifies the gap closed; repeats

Thin orchestration layer; the heavy lifting (understanding what to test) is the LLM reading the gap's code + context. Could become its own repo / skill package rather than living in tonofcov.

### Diff-based gaps

Run against two coverage snapshots — "which previously-covered lines became uncovered after this PR" or "which new lines this PR adds are already covered". The latter is a CI-gate primitive: fail PR if new code has < X% coverage.

### Cross-call-graph hints (weaker — may or may not be reliable)

For uncovered function F, enumerate transitively which message ops / getter calls reach F. Purely mechanical from callSites + recv_internal dispatch structure. Might or might not be clearer than just showing F's call sites directly.

### Coverage attribution per test

Today: one coverage.info aggregates all tests. If we captured per-test vmLogs (tagged with test name via jest globals), we could produce "test X exercised lines Y-Z" — useful for locating redundant tests or orphaned coverage.

Would require wrapping jest's `test` / `it` to tag captured vmLogs with current test name. Plumbing-heavy.

### Gas per-statement (blocked on artifact #8)

Once gas attribution and normalization are fixed (KNOWN_ARTIFACTS.md #8), the HTML could show per-line `totalGas / hits` as a fourth gutter column. Useful for gas-optimization work.
