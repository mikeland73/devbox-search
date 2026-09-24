/**
 * GET /pkg/{name} — every release of one package, plus the resolve panel.
 *
 * Both halves are v2 responses rendered as they are: the releases table is
 * `/v2/pkg`, and the panel is `/v2/resolve` for the constraint in `?v=`
 * (default `latest`). Nothing on the page re-derives a fact the API
 * decided — in particular which version is `latest`, which depends on what
 * nixpkgs still contains and cannot be recomputed from a version list.
 */

import type { V2Pkg, V2Release, V2Resolve } from "../render";
import { ago, day, esc, systemCells, systemHeaders } from "./format";
import { command, commitLink, page } from "./layout";
import { pkgJson, releasePath, resolveJson } from "./links";

export interface PkgPageInput {
  pkg: V2Pkg;
  /** The version constraint the panel answered; `latest` by default. */
  constraint: string;
  /** The resolve answer, or null when nothing matched the constraint. */
  resolved: V2Resolve | null;
  now: Date;
  origin: string;
}

export function renderPkgPage({ pkg, constraint, resolved, now, origin }: PkgPageInput): string {
  const body = `<div class="crumb"><a href="/">nixsearch</a> / pkg / ${esc(pkg.name)}</div>
<div class="pkghead">
  <h1>${esc(pkg.name)}</h1>
  <span class="muted">${esc(pkg.summary)}</span>
</div>
${renderFacts(pkg, now)}
<div class="cols">
<div>
${renderResolve(pkg, constraint, resolved)}
${renderReleases(pkg, resolved)}
</div>
${renderAside(pkg, constraint)}
</div>`;

  return page({
    title: `${pkg.name} · nixsearch`,
    description:
      pkg.summary === ""
        ? `Every nixpkgs version of ${pkg.name}.`
        : `${pkg.summary}. Every nixpkgs version of ${pkg.name}, with the commit that ships each one.`,
    canonical: `/pkg/${encodeURIComponent(pkg.name)}`,
    origin,
    q: pkg.name,
    body,
  });
}

function renderFacts(pkg: V2Pkg, now: Date): string {
  const facts: string[] = [];
  if (pkg.license !== "") facts.push(`<span>${esc(pkg.license)}</span>`);
  if (pkg.homepage_url !== "") {
    facts.push(`<a href="${esc(pkg.homepage_url)}" rel="nofollow noopener">${esc(hostOf(pkg.homepage_url))}</a>`);
  }
  const shown = pkg.attribute_paths.slice(0, 6).map((a) => `<span class="chip mono">${esc(a)}</span>`);
  const extra = pkg.attribute_paths.length - shown.length;
  facts.push(`<span>${shown.join("")}${extra > 0 ? `<span class="muted">+${extra}</span>` : ""}</span>`);
  facts.push(
    `<span class="muted">${pkg.releases.length} release${pkg.releases.length === 1 ? "" : "s"}</span>`,
  );
  const newest = pkg.releases[0];
  if (newest !== undefined) {
    facts.push(`<span class="muted">newest changed ${ago(new Date(newest.last_updated), now)}</span>`);
  }
  return `<div class="facts">${facts.join("\n  ")}</div>`;
}

/**
 * The resolve panel: the constraint form, the answer, and the two commands
 * that answer is for.
 *
 * When every system shares one rev — the single-hash rule of /v2/resolve —
 * there is one `nix shell` line covering all of them. When they don't
 * (a system frozen at the migration seed keeps its own last-change commit)
 * each rev is listed with the systems it serves, because a single line
 * would be wrong for somebody.
 */
function renderResolve(pkg: V2Pkg, constraint: string, resolved: V2Resolve | null): string {
  const form = `<form method="get" action="/pkg/${encodeURIComponent(pkg.name)}">
    <span class="name">${esc(pkg.name)}@</span>
    <input name="v" value="${esc(constraint)}" aria-label="Version constraint" spellcheck="false">
    <button class="primary" type="submit">Resolve</button>
    <span class="hint"><code>latest</code>, <code>3.11</code>, <code>^3.11</code>, <code>&gt;=3.10 &lt;3.12</code></span>
  </form>`;

  if (resolved === null) {
    return `<div class="resolve">
  ${form}
  <p class="muted" style="margin:0">No version of <code>${esc(pkg.name)}</code> matches <code>${esc(constraint)}</code>. A partial version is a range on dot boundaries (<code>3.11</code> means <code>&gt;=3.11.0 &lt;3.12.0</code>), so <code>3.1</code> does not match <code>3.11</code>.</p>
</div>`;
  }

  const systems = Object.entries(resolved.systems);
  const revs = [...new Set(systems.map(([, s]) => s.flake_installable.ref.rev))];
  const first = systems[0]![1];
  const attrs = [...new Set(systems.map(([, s]) => s.flake_installable.attr_path))];

  const cells = INDICATOR.map((system) => {
    const on = resolved.systems[system] !== undefined;
    return `<span class="${on ? "on" : "off"}">${on ? "✓ " : ""}${esc(system)}</span>`;
  }).join("");

  const revLine =
    revs.length === 1
      ? `${commitLink(revs[0]!, 40)} <span class="muted">${day(new Date(first.last_updated))} · one commit for every system</span>`
      : systems
          .map(
            ([system, s]) =>
              `<div><code>${esc(system)}</code> ${commitLink(s.flake_installable.ref.rev, 40)} <span class="muted">${day(new Date(s.last_updated))}</span></div>`,
          )
          .join("");

  const installs =
    revs.length === 1
      ? command(`nix shell github:NixOS/nixpkgs/${revs[0]!}#${first.flake_installable.attr_path}`)
      : systems
          .map(([system, s]) =>
            command(
              `nix shell github:NixOS/nixpkgs/${s.flake_installable.ref.rev}#${s.flake_installable.attr_path}  # ${system}`,
            ),
          )
          .join("\n  ");

  return `<div class="resolve">
  ${form}
  <div class="answer">
    <span class="k">version</span><span class="v"><b>${esc(resolved.version)}</b></span>
    <span class="k">attribute</span><span class="v mono">${attrs.map(esc).join(", ")}</span>
    <span class="k">rev</span><span class="v">${revLine}</span>
    <span class="k">systems</span><span class="v systems">${cells}</span>
  </div>
  ${command(`devbox add ${pkg.name}@${resolved.version}`)}
  ${installs}
  <p class="legend" style="margin-bottom:0">JSON: <a class="mono" href="${esc(resolveJson(pkg.name, constraint))}">${esc(resolveJson(pkg.name, constraint))}</a></p>
</div>`;
}

const INDICATOR = ["aarch64-darwin", "aarch64-linux", "x86_64-darwin", "x86_64-linux"];

function renderReleases(pkg: V2Pkg, resolved: V2Resolve | null): string {
  const rows = pkg.releases.map((r) => renderReleaseRow(pkg.name, r, resolved));
  return `<div class="tablehead">
  <h2 id="releases-heading">Releases</h2>
  <span class="muted">newest first, as <code>/v2/pkg</code> orders them</span>
  <input id="version-filter" type="search" placeholder="filter versions…" aria-label="Filter versions" hidden>
  <span id="filter-count" class="muted"></span>
</div>
<div class="scroll">
<table id="releases">
  <thead><tr>
    <th>Version</th>${systemHeaders()}<th>Attribute</th><th>Commit</th><th>Date</th><th>Outputs</th>
  </tr></thead>
  <tbody>
    ${rows.join("\n    ")}
  </tbody>
</table>
</div>
<p class="legend">Prereleases are listed but <code>latest</code> never picks one. “varies” means each system last changed at a different nixpkgs commit — the release page lists them.</p>`;
}

function renderReleaseRow(name: string, r: V2Release, resolved: V2Resolve | null): string {
  const badges: string[] = [];
  if (resolved !== null && resolved.version === r.version) {
    badges.push(`<span class="badge latest">resolved</span>`);
  }
  if (r.prerelease) badges.push(`<span class="badge pre">pre</span>`);
  if (r.broken) badges.push(`<span class="badge broken">broken</span>`);
  if (r.insecure) badges.push(`<span class="badge broken">insecure</span>`);

  const attrs = [...new Set(r.platforms.map((p) => p.attribute_path))];
  const attr =
    attrs.length === 1
      ? `<code>${esc(attrs[0]!)}</code>`
      : `<code>${esc(attrs[0]!)}</code> <span class="muted">+${attrs.length - 1}</span>`;

  const revs = [...new Set(r.platforms.map((p) => p.commit_hash))];
  const commit = revs.length === 1 ? commitLink(revs[0]!) : `<span class="muted">varies</span>`;

  return `<tr${r.prerelease ? ' class="pre"' : ""} data-version="${esc(r.version)}">
      <td class="ver"><a href="${esc(releasePath(name, r.version))}">${esc(r.version)}</a>${badges.join("")}</td>
      ${systemCells(r.platforms.map((p) => p.system))}
      <td>${attr}</td>
      <td>${commit}</td>
      <td>${day(new Date(r.last_updated))}</td>
      <td class="out muted">${esc(r.outputs_summary)}</td>
    </tr>`;
}

function renderAside(pkg: V2Pkg, constraint: string): string {
  const latest = pkg.releases[0];
  const items: string[] = [];
  if (pkg.description !== "") {
    items.push(`<h3>Description</h3><p class="muted">${esc(pkg.description)}</p>`);
  }
  if (pkg.license !== "") items.push(`<h3>License</h3><ul><li>${esc(pkg.license)}</li></ul>`);
  if (pkg.homepage_url !== "") {
    items.push(
      `<h3>Homepage</h3><ul><li><a href="${esc(pkg.homepage_url)}" rel="nofollow noopener">${esc(pkg.homepage_url)}</a></li></ul>`,
    );
  }
  if (latest !== undefined && latest.platforms_summary !== "") {
    items.push(`<h3>Newest release runs on</h3><ul><li>${esc(latest.platforms_summary)}</li></ul>`);
  }
  // Long tails (python has 15, some package sets far more) would push
  // everything else off the screen; the full list is in the JSON.
  const shownPaths = pkg.attribute_paths.slice(0, 12);
  const restPaths = pkg.attribute_paths.length - shownPaths.length;
  items.push(
    `<h3>Attribute paths</h3><ul class="mono">${shownPaths
      .map((a) => `<li>${esc(a)}</li>`)
      .join("")}${restPaths > 0 ? `<li class="muted">+${restPaths} more</li>` : ""}</ul>`,
  );
  items.push(
    `<h3>Raw data</h3><ul>
      <li><a class="mono" href="${esc(pkgJson(pkg.name))}">/v2/pkg</a></li>
      <li><a class="mono" href="${esc(resolveJson(pkg.name, constraint))}">/v2/resolve</a></li>
    </ul>`,
  );
  items.push(
    `<h3>Elsewhere</h3><ul>
      <li><a href="https://search.nixos.org/packages?query=${encodeURIComponent(pkg.name)}" rel="nofollow noopener">search.nixos.org</a></li>
      <li><a href="https://github.com/NixOS/nixpkgs/search?q=${encodeURIComponent(pkg.attribute_paths[0] ?? pkg.name)}" rel="nofollow noopener">nixpkgs source</a></li>
    </ul>`,
  );
  return `<aside>${items.join("\n")}</aside>`;
}

/** The host of a homepage URL, for a compact link label. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
