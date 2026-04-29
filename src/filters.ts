/**
 * Shared file include/exclude predicate used by the HTML index totals and
 * by the gaps report. Env-driven:
 *
 *   - `TONOFCOV_INCLUDE=pat1,pat2,...` — ONLY files matching count.
 *   - `TONOFCOV_EXCLUDE=pat1,pat2,...` — files matching are excluded. If
 *     set, REPLACES the default exclude list.
 *   - Default exclude (neither set): `** /stdlib.fc,** /mathlib.fc` so vendored
 *     FunC stdlib and mathlib copies don't drag the project's coverage down.
 *
 * Patterns are simple globs (`*` = any-char-but-slash, `**` = any chars).
 */

function globToRegex(glob: string): RegExp {
    const SENTINEL = '\x00__DS__\x00';
    const escaped = glob
        .trim()
        .replace(/\*\*/g, SENTINEL)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .split(SENTINEL).join('.*');
    return new RegExp(`^${escaped}$`);
}

export function buildShouldCountFn(): (file: string) => boolean {
    const include = process.env.TONOFCOV_INCLUDE;
    const exclude = process.env.TONOFCOV_EXCLUDE;

    if (include !== undefined && include !== '') {
        const patterns = include.split(',').map(s => s.trim()).filter(Boolean).map(globToRegex);
        return (file) => patterns.some(p => p.test(file));
    }

    const excludePatterns = (exclude !== undefined ? exclude : '**/stdlib.fc,**/mathlib.fc')
        .split(',').map(s => s.trim()).filter(Boolean).map(globToRegex);
    if (excludePatterns.length === 0) {
        return () => true;
    }
    return (file) => !excludePatterns.some(p => p.test(file));
}
