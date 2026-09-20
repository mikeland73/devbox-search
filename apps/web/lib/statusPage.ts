/**
 * The human-readable /status page: the same numbers as /status.json, laid
 * out so a person can tell in one glance whether the daily import is keeping
 * up (every indexed system at the head, last import recent) and whether the
 * index is tracking upstream (what `latest` resolves to for common tools).
 *
 * Plain HTML with an inline stylesheet — no client-side code, no framework,
 * so it serves from the same route-handler stack (and CDN cache) as the JSON.
 * Everything dynamic goes through {@link esc}.
 */

import type { CommitRef, LatestVersion, Status, SystemStatus } from "./status";

const NIXPKGS_COMMIT = "https://github.com/NixOS/nixpkgs/commit/";

export function renderStatusPage(s: Status): string {
  const head = s.newest_commit;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>devbox search · status</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
  <h1>devbox search <span class="muted">·</span> status</h1>
  <p class="muted">As of ${time(s.generated_at)} · <a href="/status.json">status.json</a> · cached for five minutes</p>
</header>

<section aria-label="Overview" class="tiles">
  ${tile("Packages", integer(s.counts.packages))}
  ${tile("Versions", integer(s.counts.versions))}
  ${tile("Variants", integer(s.counts.variants), "version × system × attribute")}
  ${tile("Commits", integer(s.counts.commits), head === null ? "" : `head at seq ${integer(head.seq)}`)}
  ${tile("Last import", s.last_import_at === null ? "never" : relative(s.last_import_at, s.generated_at), s.last_import_at === null ? "" : time(s.last_import_at))}
  ${tile("Database", bytes(s.database_size_bytes))}
</section>

<section>
  <h2>Systems</h2>
  ${renderSystems(s.systems, head)}
</section>

<section>
  <h2>Commit timeline</h2>
  ${renderTimeline(s.oldest_commit, s.newest_commit)}
</section>

<section>
  <h2>Latest versions</h2>
  <p class="muted">What <code>name@latest</code> resolves to right now (<code>/v2/resolve?name=…&amp;version=latest</code>).</p>
  ${renderLatest(s.latest_versions, s.generated_at)}
</section>

<section>
  <h2>Row counts</h2>
  <table class="kv">
    <tbody>
      ${Object.entries(s.counts)
        .map(([name, n]) => `<tr><th scope="row"><code>${esc(name)}</code></th><td class="num">${integer(n)}</td></tr>`)
        .join("\n      ")}
    </tbody>
  </table>
</section>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function tile(label: string, value: string, note = ""): string {
  return `<div class="tile">
    <div class="label">${esc(label)}</div>
    <div class="value">${value}</div>
    ${note === "" ? "" : `<div class="note">${note}</div>`}
  </div>`;
}

/**
 * One row per system, with its state relative to the timeline head: a system
 * the daily import covers sits at the head; one it has stopped covering
 * (x86_64-darwin, i686-linux — frozen at the migration seed) falls behind
 * and stays there, which is expected, not an outage. The badge says which,
 * in words as well as color.
 */
function renderSystems(systems: SystemStatus[], head: CommitRef | null): string {
  if (systems.length === 0) return `<p class="muted">Nothing has been imported.</p>`;
  const rows = systems.map((sys) => {
    const behind = head === null ? 0 : head.seq - sys.newest.seq;
    const badge =
      behind === 0
        ? `<span class="badge good">● at head</span>`
        : `<span class="badge behind">▲ ${integer(behind)} behind</span>`;
    return `<tr>
      <th scope="row"><code>${esc(sys.system)}</code></th>
      <td>${badge}</td>
      <td class="num">${integer(sys.commits)}</td>
      <td>${commitLink(sys.newest)}</td>
      <td>${time(sys.newest.committed_at)}</td>
      <td>${time(sys.last_imported_at)}</td>
      <td>${sys.nix_version === null ? `<span class="muted">seed</span>` : esc(sys.nix_version)}</td>
    </tr>`;
  });
  return `<table>
    <thead><tr>
      <th>System</th><th>State</th><th class="num">Commits</th><th>Newest commit</th><th>Committed</th><th>Imported</th><th>Nix</th>
    </tr></thead>
    <tbody>
      ${rows.join("\n      ")}
    </tbody>
  </table>`;
}

function renderTimeline(oldest: CommitRef | null, newest: CommitRef | null): string {
  if (oldest === null || newest === null) return `<p class="muted">Nothing has been imported.</p>`;
  const row = (label: string, c: CommitRef) => `<tr>
      <th scope="row">${label}</th>
      <td>${commitLink(c)}</td>
      <td>${time(c.committed_at)}</td>
      <td>${time(c.imported_at)}</td>
    </tr>`;
  return `<table>
    <thead><tr><th></th><th>Commit</th><th>Committed</th><th>Imported</th></tr></thead>
    <tbody>
      ${row("Oldest", oldest)}
      ${row("Newest", newest)}
    </tbody>
  </table>`;
}

/**
 * One row per package with a check per system, so a version that is missing
 * on one platform stands out as a gap in the column rather than a longer or
 * shorter list. Columns are whatever systems appear in the data.
 */
function renderLatest(latest: LatestVersion[], now: Date): string {
  const systems = [...new Set(latest.flatMap((l) => l.systems))].sort();
  const rows = latest.map((l) => {
    if (l.version === null) {
      return `<tr class="missing">
      <th scope="row"><code>${esc(l.name)}</code></th>
      <td colspan="${3 + systems.length}" class="muted">does not resolve</td>
    </tr>`;
    }
    const checks = systems
      .map((sys) =>
        l.systems.includes(sys)
          ? `<td class="check yes" title="${esc(sys)}">✓</td>`
          : `<td class="check no" title="not on ${esc(sys)}">–</td>`,
      )
      .join("");
    return `<tr>
      <th scope="row"><code>${esc(l.name)}</code></th>
      <td class="version">${esc(l.version)}</td>
      <td><code class="muted">${esc(l.attr_path ?? "")}</code></td>
      ${checks}
      <td>${l.last_updated === null ? "" : `<span title="${esc(iso(l.last_updated))}">${relative(l.last_updated, now)}</span>`}</td>
    </tr>`;
  });
  return `<table>
    <thead><tr>
      <th>Package</th><th>Latest</th><th>Attribute</th>${systems.map((sys) => `<th class="check">${esc(shortSystem(sys))}</th>`).join("")}<th>Updated</th>
    </tr></thead>
    <tbody>
      ${rows.join("\n      ")}
    </tbody>
  </table>`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function commitLink(c: CommitRef): string {
  return `<a href="${esc(NIXPKGS_COMMIT + c.hash)}"><code>${esc(c.hash.slice(0, 12))}</code></a> <span class="muted">#${integer(c.seq)}</span>`;
}

function integer(n: number): string {
  return n.toLocaleString("en-US");
}

/** Binary units, one decimal: the number Neon's dashboard shows. */
export function bytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

function iso(d: Date): string {
  return d.toISOString();
}

/** `2026-09-19 14:03 UTC`, machine-readable underneath. */
function time(d: Date): string {
  const text = d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return `<time datetime="${esc(iso(d))}">${text}</time>`;
}

/** Coarse "3 hours ago"; the exact instant is always alongside as a title. */
export function relative(d: Date, now: Date): string {
  const seconds = Math.round((now.getTime() - d.getTime()) / 1000);
  if (seconds < 0) return "in the future";
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute") + " ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, "hour") + " ago";
  const days = Math.round(hours / 24);
  if (days < 60) return plural(days, "day") + " ago";
  const months = Math.round(days / 30.4);
  if (months < 24) return plural(months, "month") + " ago";
  return plural(Math.round(days / 365.25), "year") + " ago";
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** `x86_64-linux` → `x86_64 linux`, so a header can wrap on the space. */
function shortSystem(system: string): string {
  return system.replace("-", " ");
}

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
  --good: #006300;
  --good-bg: rgba(12, 163, 12, 0.12);
  --behind: #7a5a00;
  --behind-bg: rgba(250, 178, 25, 0.18);
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
    --good: #0ca30c;
    --good-bg: rgba(12, 163, 12, 0.18);
    --behind: #fab219;
    --behind-bg: rgba(250, 178, 25, 0.14);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 72rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
header { margin-bottom: 1.5rem; }
h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; font-weight: 600; margin: 2rem 0 .75rem; }
p { margin: 0 0 .75rem; }
a { color: var(--link); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
.muted { color: var(--muted); }

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
  gap: .75rem;
}
.tile {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: .85rem 1rem;
}
.tile .label { color: var(--ink-2); font-size: .85rem; }
.tile .value { font-size: 1.6rem; font-weight: 600; line-height: 1.2; margin-top: .15rem; white-space: nowrap; }
.tile .note { color: var(--muted); font-size: .8rem; margin-top: .25rem; }

table {
  width: 100%;
  border-collapse: collapse;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  font-size: .92rem;
}
th, td { padding: .5rem .75rem; text-align: left; vertical-align: top; border-top: 1px solid var(--hairline); }
thead th { border-top: 0; color: var(--ink-2); font-weight: 500; font-size: .82rem; }
tbody th { font-weight: 500; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.check, th.check { text-align: center; }
th.check { font-size: .72rem; line-height: 1.15; }
td.check.yes { color: var(--good); }
td.check.no { color: var(--muted); }
td.version { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.missing th { color: var(--muted); font-weight: 400; }
table.kv { max-width: 24rem; }
time { white-space: nowrap; font-variant-numeric: tabular-nums; }

.badge {
  display: inline-block;
  padding: .05rem .5rem;
  border-radius: 999px;
  font-size: .8rem;
  font-weight: 500;
  white-space: nowrap;
}
.badge.good { color: var(--good); background: var(--good-bg); }
.badge.behind { color: var(--behind); background: var(--behind-bg); }

@media (max-width: 40rem) {
  main { padding: 1.25rem .75rem 3rem; }
  th, td { padding: .4rem .5rem; }
  table { display: block; overflow-x: auto; }
}
`;
