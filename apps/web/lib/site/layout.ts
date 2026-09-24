/**
 * The page shell every route under app/(site) renders into, plus the one
 * stylesheet the site has.
 *
 * Same approach as the original /status page: plain HTML with an inline
 * stylesheet, no framework and no client bundle, so a page serves from the
 * same route-handler stack (and the same CDN cache) as the JSON it mirrors.
 * The two scripts at the bottom — copy buttons and the version filter — are
 * progressive enhancements; every page is complete without them.
 */

import { esc } from "./format";

export const REPO = "https://github.com/mikeland73/devbox-search";
export const API_DOCS = `${REPO}/blob/main/docs/apis/README.md`;
export const NIXPKGS_COMMIT = "https://github.com/NixOS/nixpkgs/commit/";

export interface PageOptions {
  /** Document title, without the site name. */
  title: string;
  /** `<meta name="description">`; omitted when absent. */
  description?: string;
  /** Canonical path, e.g. `/pkg/python`. Omitted when absent. */
  canonical?: string;
  /**
   * Origin of the request, so a canonical URL names the host that served
   * it — a self-hosted copy and a preview deployment each point at
   * themselves rather than at nixsearch.com.
   */
  origin: string;
  /** Prefill for the header search box. */
  q?: string;
  /** Contents of `<main>`. */
  body: string;
  /** Hide the header search box (the home page has its own). */
  hideSearch?: boolean;
}

export function page(o: PageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
${o.description === undefined ? "" : `<meta name="description" content="${esc(o.description)}">\n`}${
    o.canonical === undefined ? "" : `<link rel="canonical" href="${esc(o.origin + o.canonical)}">\n`
  }<link rel="icon" href="data:,">
<link rel="search" type="application/opensearchdescription+xml" title="nixsearch" href="/opensearch.xml">
<style>${STYLE}</style>
</head>
<body>
<div class="top"><div class="in">
  <a class="brand" href="/">nixsearch</a>
  ${
    o.hideSearch === true
      ? ""
      : `<form action="/search" role="search"><input type="search" name="q" value="${esc(o.q ?? "")}" placeholder="python, go@1.22, nodePackages.typescript" aria-label="Search packages"></form>`
  }
  <nav><a href="${API_DOCS}">API</a><a href="/status">Status</a><a href="${REPO}">GitHub</a></nav>
</div></div>
<main>
${o.body}
</main>
<footer>
  <span>nixsearch.com</span>
  <a href="${API_DOCS}">API reference</a>
  <a href="/status">Index status</a>
  <a href="${REPO}">Source</a>
  <span class="muted">Data from nixpkgs; Apache-2.0</span>
</footer>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** A `<pre>` holding one shell command, with a copy button. */
export function command(text: string): string {
  return `<pre class="cmd"><span class="p">$ </span><code>${esc(text)}</code><button class="copy" type="button" aria-label="Copy to clipboard">copy</button></pre>`;
}

/** A nixpkgs commit link, abbreviated to the first 10 characters. */
export function commitLink(hash: string, length = 10): string {
  return `<a class="mono" href="${esc(NIXPKGS_COMMIT + hash)}" title="${esc(hash)}">${esc(hash.slice(0, length))}</a>`;
}

// ---------------------------------------------------------------------------
// Enhancements
// ---------------------------------------------------------------------------

/**
 * Copy buttons and the releases-table filter. Both are additive: without
 * JS the commands are still selectable text and the table is still the
 * whole table.
 */
const SCRIPT = `
document.addEventListener("click", function (e) {
  var b = e.target.closest(".copy");
  if (!b) return;
  var code = b.parentElement.querySelector("code");
  navigator.clipboard.writeText(code.textContent).then(function () {
    b.textContent = "copied";
    setTimeout(function () { b.textContent = "copy"; }, 1200);
  });
});
var filter = document.getElementById("version-filter");
if (filter) {
  filter.hidden = false;
  filter.addEventListener("input", function () {
    var q = filter.value.trim().toLowerCase();
    var shown = 0;
    document.querySelectorAll("#releases tbody tr").forEach(function (row) {
      var v = row.getAttribute("data-version") || "";
      var hit = q === "" || v.toLowerCase().indexOf(q) === 0;
      row.hidden = !hit;
      if (hit) shown++;
    });
    var note = document.getElementById("filter-count");
    if (note) note.textContent = q === "" ? "" : shown + " matching";
  });
}
`;

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

const STYLE = `
:root {
  color-scheme: light dark;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --hairline: #e1e0d9;
  --border: rgba(11, 11, 11, 0.10);
  --link: #1f5fb0;
  --accent: #1f5fb0;
  --accent-bg: rgba(31, 95, 176, 0.10);
  --good: #006300;
  --good-bg: rgba(12, 163, 12, 0.12);
  --behind: #7a5a00;
  --behind-bg: rgba(250, 178, 25, 0.18);
  --danger: #a11a1a;
  --danger-bg: rgba(200, 40, 40, 0.10);
  --mark: rgba(250, 178, 25, 0.35);
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --hairline: #2c2c2a;
    --border: rgba(255, 255, 255, 0.10);
    --link: #6fa8ea;
    --accent: #6fa8ea;
    --accent-bg: rgba(111, 168, 234, 0.14);
    --good: #0ca30c;
    --good-bg: rgba(12, 163, 12, 0.18);
    --behind: #fab219;
    --behind-bg: rgba(250, 178, 25, 0.14);
    --danger: #f07070;
    --danger-bg: rgba(240, 112, 112, 0.14);
    --mark: rgba(250, 178, 25, 0.28);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
.muted { color: var(--muted); }
.num { font-variant-numeric: tabular-nums; }

.top { border-bottom: 1px solid var(--hairline); background: var(--surface); }
.top .in { max-width: 72rem; margin: 0 auto; padding: .6rem 1.25rem; display: flex; align-items: center; gap: 1.25rem; }
.brand { font-weight: 650; letter-spacing: -.01em; color: var(--ink); }
.top form { flex: 1; display: flex; max-width: 34rem; }
.top input {
  flex: 1; font: inherit; padding: .4rem .7rem;
  border: 1px solid var(--border); border-radius: 6px; background: var(--page); color: var(--ink);
}
.top nav { display: flex; gap: 1rem; font-size: .9rem; margin-left: auto; }
.top nav a { color: var(--ink-2); }
main { max-width: 72rem; margin: 0 auto; padding: 1.75rem 1.25rem 3rem; }
footer {
  max-width: 72rem; margin: 0 auto; padding: 1rem 1.25rem 2rem; font-size: .85rem;
  color: var(--muted); border-top: 1px solid var(--hairline); display: flex; gap: 1.25rem; flex-wrap: wrap;
}
footer a { color: var(--ink-2); }

h1 { font-size: 1.6rem; font-weight: 650; margin: 0 0 .25rem; letter-spacing: -.01em; }
h2 { font-size: 1.02rem; font-weight: 600; margin: 2rem 0 .6rem; }
h3 { font-size: .95rem; font-weight: 600; margin: 1.5rem 0 .4rem; }
p { margin: 0 0 .75rem; }

table {
  width: 100%; border-collapse: collapse; background: var(--surface);
  border: 1px solid var(--border); border-radius: 8px; overflow: hidden; font-size: .92rem;
}
th, td { padding: .45rem .7rem; text-align: left; vertical-align: top; border-top: 1px solid var(--hairline); }
thead th { border-top: 0; color: var(--ink-2); font-weight: 500; font-size: .8rem; white-space: nowrap; }
tbody th { font-weight: 500; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.sys, th.sys { text-align: center; padding-left: .3rem; padding-right: .3rem; width: 2.6rem; }
th.sys { font-size: .68rem; line-height: 1.1; color: var(--muted); }
.sys .y { color: var(--good); }
.sys .n { color: var(--muted); opacity: .5; }
/* .num right-aligns, which a version column should not: it belongs next
   to the name it labels. Tabular figures still apply. */
td.ver { white-space: nowrap; font-weight: 600; font-variant-numeric: tabular-nums; text-align: left; }
td.ver a { color: var(--ink); }
tr.pre td, tr.pre th { color: var(--muted); }
tr.pre td.ver { font-weight: 500; }
tr.pre td.ver a { color: var(--muted); }
td.sum { color: var(--ink-2); max-width: 30rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A package name is an identifier: breaking it across lines makes it
   unreadable and un-copyable. The summary is what should give up width. */
td.pkg { white-space: nowrap; }
td.out { white-space: nowrap; }
time { white-space: nowrap; font-variant-numeric: tabular-nums; }
mark { background: var(--mark); color: inherit; padding: 0 .05em; border-radius: 2px; }
table.kv { max-width: 24rem; }

.badge {
  display: inline-block; padding: 0 .45rem; border-radius: 999px;
  font-size: .74rem; font-weight: 500; white-space: nowrap; vertical-align: 1px; margin-left: .35rem;
}
.badge.latest { color: var(--accent); background: var(--accent-bg); }
.badge.pre { color: var(--behind); background: var(--behind-bg); }
.badge.broken { color: var(--danger); background: var(--danger-bg); }
.badge.good { color: var(--good); background: var(--good-bg); margin-left: 0; }
.badge.behind { color: var(--behind); background: var(--behind-bg); margin-left: 0; }
.chip {
  display: inline-block; padding: .05rem .5rem; border: 1px solid var(--border); border-radius: 999px;
  font-size: .82rem; background: var(--surface); color: var(--ink-2); margin: 0 .3rem .25rem 0;
}

.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: .75rem; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: .85rem 1rem; }
.tile .label { color: var(--ink-2); font-size: .85rem; }
.tile .value { font-size: 1.6rem; font-weight: 600; line-height: 1.2; margin-top: .15rem; white-space: nowrap; }
.tile .note { color: var(--muted); font-size: .8rem; margin-top: .25rem; }

.hero { padding: 3.5rem 0 1.5rem; max-width: 44rem; margin: 0 auto; text-align: center; }
.hero h1 { font-size: 2rem; margin-bottom: .35rem; }
.hero .lead { color: var(--ink-2); font-size: 1.05rem; margin-bottom: 1.5rem; }
.hero form { display: flex; gap: .5rem; }
.hero input {
  flex: 1; font: inherit; font-size: 1.1rem; padding: .7rem 1rem; border: 1px solid var(--border);
  border-radius: 8px; background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.04);
}
button.primary {
  font: inherit; padding: .6rem 1.1rem; border-radius: 8px; border: 1px solid var(--accent);
  background: var(--accent); color: #fff; font-weight: 500; cursor: pointer;
}
.examples { margin-top: .9rem; font-size: .9rem; color: var(--muted); }
.examples a { margin: 0 .25rem; }
.stats { text-align: center; color: var(--ink-2); font-size: .95rem; margin: .5rem 0 2.5rem; }
.stats b { color: var(--ink); font-weight: 600; }
.stats .dot { color: var(--muted); margin: 0 .5rem; }
.about { max-width: 44rem; margin: 0 auto 1rem; color: var(--ink-2); font-size: .95rem; }

.pkghead { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
.pkghead h1 { margin: 0; }
.facts { color: var(--ink-2); font-size: .92rem; margin: .4rem 0 1.25rem; display: flex; gap: 1.1rem; flex-wrap: wrap; align-items: baseline; }
.cols { display: grid; grid-template-columns: 1fr 17rem; gap: 2rem; align-items: start; }
/* Grid items are min-width:auto by default, so the widest unbreakable
   thing inside (a command, a hash) would stretch the whole page instead
   of scrolling inside its own box. */
.cols > * { min-width: 0; }
aside { font-size: .9rem; }
aside h3 { font-size: .78rem; font-weight: 500; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin: 1.25rem 0 .35rem; }
aside h3:first-child { margin-top: 0; }
aside ul { list-style: none; padding: 0; margin: 0; }
aside li { margin: .15rem 0; overflow-wrap: anywhere; }

.resolve { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: .9rem 1rem 1rem; }
.resolve form { display: flex; align-items: center; gap: .5rem; margin-bottom: .75rem; flex-wrap: wrap; }
.resolve form .name { font-weight: 600; }
.resolve input {
  font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; width: 10rem;
  padding: .35rem .6rem; border: 1px solid var(--border); border-radius: 6px; background: var(--page); color: var(--ink);
}
.resolve button.primary { padding: .35rem .8rem; border-radius: 6px; }
.resolve .hint { font-size: .82rem; color: var(--muted); margin-left: auto; }
.answer { display: grid; grid-template-columns: auto 1fr; gap: .25rem 1rem; font-size: .92rem; align-items: baseline; }
.answer .k { color: var(--muted); }
/* A grid item defaults to min-width:auto, so a 40-character commit hash
   would push the page wider than the screen rather than wrapping. */
.answer .v { min-width: 0; overflow-wrap: anywhere; }
.answer .systems { display: flex; gap: .75rem; flex-wrap: wrap; }
.answer .systems .on { color: var(--good); }
.answer .systems .off { color: var(--muted); text-decoration: line-through; }
pre.cmd {
  position: relative; margin: .5rem 0 0; padding: .55rem 4.5rem .55rem .75rem; background: var(--page);
  border: 1px solid var(--hairline); border-radius: 6px; font-size: .86rem; overflow-x: auto; white-space: nowrap;
}
pre.cmd .copy {
  position: absolute; right: .4rem; top: .3rem; font: inherit; font-size: .76rem; padding: .1rem .5rem;
  border: 1px solid var(--border); border-radius: 5px; background: var(--surface); color: var(--ink-2); cursor: pointer;
}
pre.cmd .p { color: var(--muted); }

.tablehead { display: flex; align-items: baseline; gap: 1rem; margin: 2rem 0 .6rem; flex-wrap: wrap; }
.tablehead h2 { margin: 0; }
.tablehead input {
  font: inherit; font-size: .88rem; padding: .25rem .6rem; border: 1px solid var(--border);
  border-radius: 6px; background: var(--surface); color: var(--ink); width: 12rem; margin-left: auto;
}
.legend { font-size: .8rem; color: var(--muted); margin-top: .5rem; }
.resulthead { display: flex; align-items: baseline; gap: 1rem; margin-bottom: .75rem; flex-wrap: wrap; }
.resulthead h1 { font-size: 1.15rem; font-weight: 600; }
.resulthead .json { margin-left: auto; font-size: .85rem; }
.crumb { font-size: .85rem; color: var(--muted); margin-bottom: .5rem; }
.empty { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; }
.empty h1 { font-size: 1.15rem; }

@media (max-width: 52rem) {
  .cols { grid-template-columns: 1fr; }
  .top .in { flex-wrap: wrap; gap: .6rem 1rem; }
  .top form { order: 3; flex-basis: 100%; max-width: none; }
}
@media (max-width: 40rem) {
  main { padding: 1.25rem .75rem 2rem; }
  th, td { padding: .4rem .5rem; }
  .scroll { overflow-x: auto; }
}
`;
