/**
 * GET /search — the v2 search response as a table.
 *
 * Row order is the API's ranking (exact name, exact attribute path, name
 * prefix, attribute prefix, then trigram similarity, top-level attributes
 * first) and is never re-sorted here: the page shows what the endpoint
 * returned, in the order it returned it.
 */

import type { V2Search } from "../render";
import { ago, esc, systemCells, systemHeaders } from "./format";
import { page } from "./layout";
import { pkgPath } from "./links";

/** The API's cap; a full page of results means "there are probably more". */
const LIMIT = 50;

export function renderResultsPage(result: V2Search, now: Date, origin: string): string {
  const q = result.query;
  const body = result.total_results === 0 ? renderEmpty(q) : renderTable(result, now);
  return page({
    title: `${q} · nixsearch`,
    description: `nixpkgs packages matching ${q}.`,
    canonical: `/search?q=${encodeURIComponent(q)}`,
    origin,
    q,
    body,
  });
}

function renderTable(result: V2Search, now: Date): string {
  const q = result.query;
  const rows = result.results.map((r) => {
    const attr = r.attribute_path === r.name ? "" : `<code class="muted">${esc(r.attribute_path)}</code>`;
    return `<tr>
      <td class="pkg"><a href="${esc(pkgPath(r.name))}">${highlight(r.name, q)}</a></td>
      <td class="ver num">${esc(r.version)}</td>
      <td>${attr}</td>
      <td class="sum" title="${esc(r.summary)}">${esc(r.summary)}</td>
      ${systemCells(r.systems)}
      <td>${ago(new Date(r.last_updated), now)}</td>
    </tr>`;
  });

  const count =
    result.total_results < LIMIT
      ? `${result.total_results} package${result.total_results === 1 ? "" : "s"} match`
      : `Top ${LIMIT} packages matching`;

  return `<div class="resulthead">
  <h1>${esc(count)} <code>${esc(q)}</code></h1>
  ${result.total_results < LIMIT ? "" : `<span class="muted">the API returns at most ${LIMIT} — refine the query for more</span>`}
  <a class="json mono" href="/v2/search?q=${encodeURIComponent(q)}">/v2/search?q=${esc(q)}</a>
</div>
<div class="scroll">
<table>
  <thead><tr>
    <th>Package</th><th>Latest</th><th>Attribute</th><th>Summary</th>${systemHeaders()}<th>Updated</th>
  </tr></thead>
  <tbody>
    ${rows.join("\n    ")}
  </tbody>
</table>
</div>
<p class="legend">Ranked by the API: exact name, exact attribute path, name prefix, attribute prefix, then similarity, with top-level nixpkgs attributes above nested ones.</p>`;
}

function renderEmpty(q: string): string {
  return `<div class="empty">
  <h1>No package matches <code>${esc(q)}</code></h1>
  <p class="muted">Package names match case-insensitively; nixpkgs attribute paths (<code>nodePackages.typescript</code>) match case-sensitively, so the capitals have to be right.</p>
  <p class="muted">A version can go on the end — <code>${esc(q)}@latest</code> — to jump straight to it.</p>
</div>`;
}

/**
 * Marks the first case-insensitive occurrence of the query inside a name.
 * Escaping happens per fragment, so the mark can never come from the data.
 */
export function highlight(text: string, q: string): string {
  if (q === "") return esc(text);
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return esc(text);
  const before = text.slice(0, at);
  const hit = text.slice(at, at + q.length);
  const after = text.slice(at + q.length);
  return `${esc(before)}<mark>${esc(hit)}</mark>${esc(after)}`;
}
