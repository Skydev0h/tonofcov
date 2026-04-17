# Publishing checklist

Maintainer-facing notes for cutting a new tonofcov release.

## Before publish

1. **Sync CHANGELOG**. Move any `[Unreleased]` entries under a new `[X.Y.Z] — YYYY-MM-DD` heading. If the release bundles multiple functional changes, make sure each is listed under the appropriate Added / Changed / Fixed / Reverted subsection.

2. **Bump `package.json` version**. Keep it aligned with the CHANGELOG heading.

3. **Run the test matrix** against a FunC project that exercises at least:
   - A jetton-style contract (for recv_internal dispatch / inline helpers).
   - A function with nested `if` / `while` bodies (conditional-header normalization).
   - Multi-line `throw_unless(...)` with arithmetic conditions (multi-line throw coloring).
   - Several getters that load only a subset of data (inline-expansion partial use).

4. **Spot-check the HTML report**:
   - Index page: excluded files below the divider, grand totals exclude them, footer shows the new version.
   - Per-file page: throws counter only on throw-start line, multi-line throws uniformly coloured, tail `return` lines covered, unconditional throws not overfilled.

5. **Build cleanly**:
   ```bash
   rm -rf dist/ *.tgz
   npm run build
   npm pack
   ```
   Verify the tarball contents — `npm pack` prints a file list. Should include `dist/`, `jest-preset.json`, `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, `KNOWN_ARTIFACTS.md`. Should NOT include `scripts/`, `node_modules/`, `coverage/`, `src/`.

6. **Smoke-test the tarball** in a separate clean project:
   ```bash
   cd /tmp/test-project
   npm install /path/to/tonofcov-X.Y.Z.tgz
   npm test
   ```
   Confirm `coverage/lcov.info` and `coverage/html/index.html` are produced and look right.

## Publish

```bash
npm publish --access public
```

First-time only: `npm login` and ensure the `tonofcov` name is held by your account.

## After publish

1. **Tag the commit**:
   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```

2. **GitHub release**: paste the CHANGELOG section for this version into the release body. Link any related issues / PRs.

3. **Bump a test project** that consumes tonofcov to the new version and re-run its CI to confirm no regression.

## Rollback

If a release is broken:

```bash
npm deprecate tonofcov@X.Y.Z "Broken release — use vA.B.C or later"
```

Never `npm unpublish` for a version that's been live > 72h (npm policy). Just deprecate and publish a fixed patch.

## Things to NOT include in the package

- `scripts/` — R&D probes, not shipped
- `*.tgz` artifacts in the repo root (result of local `npm pack`)
- `coverage/` output
- `node_modules/`
- `src/` sources (we ship compiled `dist/` only)

The `files` field in `package.json` is the source of truth — keep it minimal.
