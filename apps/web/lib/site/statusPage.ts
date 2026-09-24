/**
 * The human-readable /status page: the same numbers as /status.json, laid
 * out so a person can tell in one glance whether the daily import is keeping
 * up (every indexed system at the head, last import recent) and whether the
 * index is tracking upstream (what `latest` resolves to for common tools).
 *
 * It renders into the same shell as the rest of the site, so the header,
 * footer and stylesheet are shared; the formatters live in ./format.
 * Everything dynamic goes through `esc`.
 */

import type { CommitRef, LatestVersion, Status, SystemStatus } from "../status";
import { ago, bytes, esc, integer, iso, relative, systemCells, systemHeaders, time } from "./format";
import { commitLink, page } from "./layout";
import { pkgPath } from "./links";

export function renderStatusPage(s: Status, origin: string): string {
  const head = s.newest_commit;
  const body = `<header>
  <h1>Index status</h1>
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
</section>`;

  return page({
    title: "Index status · nixsearch",
    description: "Row counts, per-system import state and commit timeline of the nixsearch index.",
    canonical: "/status",
    origin,
    body,
  });
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
      <td>${commitLink(sys.newest.hash, 12)} <span class="muted">#${integer(sys.newest.seq)}</span></td>
      <td>${time(sys.newest.committed_at)}</td>
      <td>${time(sys.last_imported_at)}</td>
      <td>${sys.nix_version === null ? `<span class="muted">seed</span>` : esc(sys.nix_version)}</td>
    </tr>`;
  });
  return `<div class="scroll"><table>
    <thead><tr>
      <th>System</th><th>State</th><th class="num">Commits</th><th>Newest commit</th><th>Committed</th><th>Imported</th><th>Nix</th>
    </tr></thead>
    <tbody>
      ${rows.join("\n      ")}
    </tbody>
  </table></div>`;
}

function renderTimeline(oldest: CommitRef | null, newest: CommitRef | null): string {
  if (oldest === null || newest === null) return `<p class="muted">Nothing has been imported.</p>`;
  const row = (label: string, c: CommitRef) => `<tr>
      <th scope="row">${label}</th>
      <td>${commitLink(c.hash, 12)} <span class="muted">#${integer(c.seq)}</span></td>
      <td>${time(c.committed_at)}</td>
      <td>${time(c.imported_at)}</td>
    </tr>`;
  return `<div class="scroll"><table>
    <thead><tr><th></th><th>Commit</th><th>Committed</th><th>Imported</th></tr></thead>
    <tbody>
      ${row("Oldest", oldest)}
      ${row("Newest", newest)}
    </tbody>
  </table></div>`;
}

/**
 * One row per package with a cell per system, so a version that is missing
 * on one platform stands out as a gap in the column rather than a longer or
 * shorter list.
 */
function renderLatest(latest: LatestVersion[], now: Date): string {
  const rows = latest.map((l) => {
    if (l.version === null) {
      return `<tr class="missing">
      <th scope="row"><a href="${esc(pkgPath(l.name))}">${esc(l.name)}</a></th>
      <td colspan="7" class="muted">does not resolve</td>
    </tr>`;
    }
    return `<tr>
      <th scope="row"><a href="${esc(pkgPath(l.name))}">${esc(l.name)}</a></th>
      <td class="ver num">${esc(l.version)}</td>
      <td><code class="muted">${esc(l.attr_path ?? "")}</code></td>
      ${systemCells(l.systems)}
      <td>${l.last_updated === null ? "" : `<span title="${esc(iso(l.last_updated))}">${ago(l.last_updated, now)}</span>`}</td>
    </tr>`;
  });
  return `<div class="scroll"><table>
    <thead><tr>
      <th>Package</th><th>Latest</th><th>Attribute</th>${systemHeaders()}<th>Updated</th>
    </tr></thead>
    <tbody>
      ${rows.join("\n      ")}
    </tbody>
  </table></div>`;
}
