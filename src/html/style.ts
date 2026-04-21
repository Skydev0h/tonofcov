/**
 * CSS for the HTML report. Exported as a string so we can write it alongside
 * the HTML files without bundler gymnastics. All colors are GitHub-Light
 * inspired — legible on white, readable for long sessions.
 */

export const CSS = `
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #ffffff;
    color: #24292f;
    margin: 0;
    padding: 0;
    font-size: 14px;
}

.breadcrumbs {
    padding: 14px 24px;
    border-bottom: 1px solid #d0d7de;
    background: #f6f8fa;
    display: flex;
    align-items: center;
    gap: 8px;
}
.breadcrumbs a { color: #0969da; text-decoration: none; }
.breadcrumbs a:hover { text-decoration: underline; }
.breadcrumbs .sep { color: #8c959f; }
.breadcrumbs .cur { font-weight: 600; }
.breadcrumbs .stats { margin-left: auto; color: #57606a; font-size: 13px; }

header.index-header { padding: 24px; border-bottom: 1px solid #d0d7de; }
header.index-header h1 { margin: 0; font-size: 20px; font-weight: 600; }
header.index-header .summary { margin-top: 6px; color: #57606a; font-size: 13px; }

.file-list { border-collapse: collapse; width: 100%; }
.file-list th, .file-list td { padding: 8px 16px; text-align: left; border-bottom: 1px solid #eaeef2; }
.file-list th { background: #f6f8fa; font-weight: 600; font-size: 11px; color: #57606a; text-transform: uppercase; letter-spacing: 0.4px; }
.file-list tbody tr:hover { background: #f6f8fa; }
/* Align numeric cells AND their headers to the right — the selector also
   matches th.num so the header label sits over the right-aligned column. */
.file-list .num { text-align: right; font-variant-numeric: tabular-nums; color: #57606a; }
.file-list .pct { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.file-list td.num, .file-list td.pct { color: #57606a; }
.file-list td.pct { color: #24292f; }
.file-list .bar { width: 140px; padding-right: 16px; }
.file-list .bar-track { height: 8px; background: #eaeef2; border-radius: 4px; overflow: hidden; }
.file-list .bar-fill { height: 100%; background: #1a7f37; border-radius: 4px 0 0 4px; }
.file-list .bar-fill.throws { background: #cf222e; }
.file-list .group-sep { border-left: 1px solid #d0d7de; }
.file-list a { color: #0969da; text-decoration: none; }
.file-list a:hover { text-decoration: underline; }
/* Divider row separating counted files from excluded (stdlib / vendored). */
.file-list tr.divider td {
    background: #f6f8fa;
    color: #57606a;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    text-align: center;
    padding: 6px 16px;
    border-top: 1px solid #d0d7de;
}
.file-list tr.dimmed { opacity: 0.6; }
.file-list tr.dimmed:hover { opacity: 1; }

.report-footer {
    padding: 16px 24px;
    color: #8c959f;
    font-size: 12px;
    border-top: 1px solid #eaeef2;
    margin-top: 8px;
}
.report-footer a { color: #8c959f; }
.report-footer a:hover { color: #0969da; }

.src {
    border-collapse: collapse;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 12.5px;
    width: 100%;
}
.src td {
    padding: 0 8px;
    vertical-align: top;
    line-height: 20px;
    white-space: pre;
    -moz-tab-size: 4;
    tab-size: 4;
}

/* Throw-fires column: sits left of the hit counter. Blank for lines with
   no throw_if/throw_unless/throw call; otherwise a bright red count of how
   many times the THROW* opcode actually raised at this line. */
.g-throws {
    width: 36px;
    text-align: right;
    color: #cf222e;
    font-weight: 600;
    user-select: none;
    font-variant-numeric: tabular-nums;
    padding-left: 12px !important;
    padding-right: 10px !important;
}
.g-hits { width: 46px; text-align: right; color: #6e7781; user-select: none; font-variant-numeric: tabular-nums; padding-left: 6px; padding-right: 14px !important; }
/* The coverage gutter is rendered as a thick left-border on the line-number
   cell rather than a dedicated empty <td> — empty table cells can fail to
   render their background in some browsers, borders never do. */
.g-line {
    width: 42px;
    text-align: right;
    color: #8c959f;
    user-select: none;
    font-variant-numeric: tabular-nums;
    border-left: 8px solid transparent;
    padding-left: 12px !important;
}
/* Gutter bar colors — midpoint between the saturated marker and the row
   background, so the bar reads as a brighter echo of the tint rather than
   a contrasting stripe. */
tr.r-covered   .g-line { border-left-color: #7abd8c; }
tr.r-uncovered .g-line { border-left-color: #e7858b; }
tr.r-partial   .g-line { border-left-color: #dfc063; }

.code { width: 100%; color: #24292f; padding-left: 14px !important; }

tr.r-covered   { background: #dafbe1; }  /* light green */
tr.r-uncovered { background: #fff0ef; }  /* light red */
tr.r-partial   { background: #fff8c5; }  /* light yellow */
tr.r-nonexec   { background: transparent; }
tr.r-suspect   { background: #dbeafe; }  /* light blue — analysis anomaly, overrides row bg, gutter stays */

.suspect-summary {
    padding: 12px 24px;
    background: #eff6ff;
    border-bottom: 1px solid #bfdbfe;
    color: #1e40af;
    font-size: 13px;
}
.suspect-summary b { font-weight: 600; }
.suspect-summary ul { margin: 6px 0 0 0; padding-left: 20px; }
.suspect-summary li { margin: 2px 0; }
.suspect-summary .line-ref { font-weight: 600; font-variant-numeric: tabular-nums; }

/* Syntax colors — GitHub Light palette */
.tok-kw      { color: #cf222e; }
.tok-type    { color: #0550ae; }
.tok-comment { color: #6e7781; font-style: italic; }
.tok-string  { color: #0a3069; }
.tok-number  { color: #0550ae; }
.tok-fn      { color: #8250df; }
.tok-macro   { color: #116329; }
`.trim() + '\n';
