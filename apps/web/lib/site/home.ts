/**
 * GET / — the search box, the numbers that say the index is alive, and
 * what `latest` resolves to for the toolchains a devbox.json usually pins.
 *
 * Everything here is already in /status.json, including `latest_versions`
 * (COMMON_PACKAGES), which is the fastest way to show what the site is
 * for: a version, an attribute path, and which systems have it.
 */

import type { Status } from "../status";
import { ago, esc, integer, systemCells, systemHeaders } from "./format";
import { commitLink, page } from "./layout";
import { pkgPath, searchPath } from "./links";

/**
 * Five minutes fresh, like /status.json, but a day of stale-while-revalidate
 * rather than ten minutes.
 *
 * With the status policy, a home page nobody had asked for in fifteen
 * minutes was a full miss, and a miss is the slowest render the site has
 * (the status counts). The numbers only move when the indexer imports a
 * commit, a few times a day, so a visitor after a quiet spell is better
 * served the previous render at once while the edge refreshes it. /status
 * keeps the short window: it exists to catch a stalled import, and a day
 * of staleness would hide one.
 */
export const HOME_CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=86400";

const EXAMPLES = ["python", "go@^1.22", "nodejs@20", "ripgrep", "nodePackages.typescript"];

export function renderHomePage(s: Status, origin: string): string {
  const body = `<section class="hero">
  <h1>Every version of every nixpkgs package</h1>
  <p class="lead">Which nixpkgs commit has a package, what it is called there, and on which systems.</p>
  <form action="/search" role="search">
    <input type="search" name="q" autofocus placeholder="python, go@1.22, nodePackages.typescript" aria-label="Search packages">
    <button class="primary" type="submit">Search</button>
  </form>
  <p class="examples">Try ${EXAMPLES.map((e) => `<a href="${esc(searchPath(e))}">${esc(e)}</a>`).join(" · ")}</p>
</section>
${renderStats(s)}
<div class="about">
  <p>nixsearch indexes every commit of <code>nixpkgs-unstable</code> minutes after it lands, and never rebuilds: a version that was ever in nixpkgs stays findable, with the commit that shipped it on each system. It is the resolver behind <code>devbox add</code>, and every page here is a view of the same <a href="${esc(API_DOCS_PATH)}">JSON API</a>.</p>
</div>
${renderLatest(s)}`;

  return page({
    title: "nixsearch · nixpkgs package search",
    description:
      "Search every version of every nixpkgs package, with the commit hash and attribute path that ships each one.",
    canonical: "/",
    origin,
    body,
    hideSearch: true,
  });
}

const API_DOCS_PATH = "https://github.com/mikeland73/devbox-search/blob/main/docs/apis/README.md";

function renderStats(s: Status): string {
  const head = s.newest_commit;
  const parts = [
    `<b>${integer(s.counts.packages)}</b> packages`,
    `<b>${integer(s.counts.versions)}</b> versions`,
    `<b>${integer(s.counts.commits)}</b> nixpkgs-unstable commits`,
  ];
  const updated =
    head === null
      ? "nothing imported yet"
      : `updated <b>${ago(head.committed_at, s.generated_at)}</b> at ${commitLink(head.hash, 8)}`;
  return `<p class="stats">${parts.join('<span class="dot">·</span>')}<span class="dot">·</span>${updated}</p>`;
}

/**
 * One row per common package with a cell per system, so a version missing
 * on a platform reads as a gap in the column rather than a shorter list.
 */
function renderLatest(s: Status): string {
  const rows = s.latest_versions.map((l) => {
    if (l.version === null) {
      return `<tr>
      <th scope="row"><a href="${esc(pkgPath(l.name))}">${esc(l.name)}</a></th>
      <td colspan="7" class="muted">does not resolve</td>
    </tr>`;
    }
    return `<tr>
      <th scope="row"><a href="${esc(pkgPath(l.name))}">${esc(l.name)}</a></th>
      <td class="ver num">${esc(l.version)}</td>
      <td><code class="muted">${esc(l.attr_path ?? "")}</code></td>
      ${systemCells(l.systems)}
      <td>${l.last_updated === null ? "" : ago(l.last_updated, s.generated_at)}</td>
    </tr>`;
  });

  return `<h2>What <code>latest</code> resolves to right now</h2>
<div class="scroll">
<table>
  <thead><tr>
    <th>Package</th><th>Latest</th><th>Attribute</th>${systemHeaders()}<th>Updated</th>
  </tr></thead>
  <tbody>
    ${rows.join("\n    ")}
  </tbody>
</table>
</div>
<p class="legend">Chosen exactly as <code>/v2/resolve?version=latest</code> chooses. x86_64-darwin is no longer evaluated upstream, so recent versions show a gap there. Row counts and per-system import state are on <a href="/status">the status page</a>.</p>`;
}
