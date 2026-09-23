/**
 * GET /pkg/{name}/{version} — one release, as a permalink.
 *
 * This is the page somebody pastes into a review when they pin something,
 * so it leads with the pinned references. Everything comes from the same
 * `/v2/pkg` release entry the package page lists: one block per distinct
 * commit, because a version whose systems last changed at different
 * commits genuinely has more than one pin.
 */

import type { V2Pkg, V2Platform, V2Release } from "../render";
import { day, esc } from "./format";
import { command, commitLink, page } from "./layout";
import { pkgJson, pkgPath, releasePath, resolveJson } from "./links";

export interface ReleasePageInput {
  pkg: V2Pkg;
  release: V2Release;
  /** Neighbours in the package's release order, for walking versions. */
  newer: V2Release | undefined;
  older: V2Release | undefined;
  origin: string;
}

export function renderReleasePage({ pkg, release, newer, older, origin }: ReleasePageInput): string {
  const badges: string[] = [];
  if (release.prerelease) badges.push(`<span class="badge pre">prerelease</span>`);
  if (release.broken) badges.push(`<span class="badge broken">broken</span>`);
  if (release.insecure) badges.push(`<span class="badge broken">insecure</span>`);

  const body = `<div class="crumb"><a href="/">nixsearch</a> / pkg / <a href="${esc(pkgPath(pkg.name))}">${esc(pkg.name)}</a> / ${esc(release.version)}</div>
<div class="pkghead">
  <h1>${esc(pkg.name)} ${esc(release.version)}${badges.join("")}</h1>
  <span class="muted">${esc(pkg.summary)}</span>
</div>
<div class="facts">
  <span>${esc(release.platforms_summary === "" ? "no supported platform" : release.platforms_summary)}</span>
  <span class="muted">last changed ${day(new Date(release.last_updated))}</span>
  ${release.outputs_summary === "" ? "" : `<span class="muted">outputs: ${esc(release.outputs_summary)}</span>`}
</div>

<h2>Pin this version</h2>
${renderPins(pkg.name, release)}

<h2>Per system</h2>
<div class="scroll">
<table>
  <thead><tr><th>System</th><th>Attribute</th><th>Commit</th><th>Date</th><th>Outputs</th><th>Flags</th></tr></thead>
  <tbody>
    ${release.platforms.map(renderPlatform).join("\n    ")}
  </tbody>
</table>
</div>

<div class="facts" style="margin-top:1.5rem">
  ${newer === undefined ? "" : `<a href="${esc(releasePath(pkg.name, newer.version))}">← newer: ${esc(newer.version)}</a>`}
  <a href="${esc(pkgPath(pkg.name))}">all ${pkg.releases.length} releases</a>
  ${older === undefined ? "" : `<a href="${esc(releasePath(pkg.name, older.version))}">older: ${esc(older.version)} →</a>`}
</div>
<p class="legend">JSON: <a class="mono" href="${esc(pkgJson(pkg.name))}">${esc(pkgJson(pkg.name))}</a> ·
<a class="mono" href="${esc(resolveJson(pkg.name, release.version))}">${esc(resolveJson(pkg.name, release.version))}</a></p>`;

  return page({
    title: `${pkg.name} ${release.version} · nixsearch`,
    description: `${pkg.name} ${release.version} in nixpkgs: the commit that ships it, on ${release.platforms_summary === "" ? "every indexed system" : release.platforms_summary}.`,
    canonical: releasePath(pkg.name, release.version),
    origin,
    q: `${pkg.name}@${release.version}`,
    body,
  });
}

/** One block per distinct commit, with the systems it covers. */
function renderPins(name: string, release: V2Release): string {
  const byRev = new Map<string, V2Platform[]>();
  for (const p of release.platforms) {
    const list = byRev.get(p.commit_hash);
    if (list === undefined) byRev.set(p.commit_hash, [p]);
    else list.push(p);
  }

  const blocks = [...byRev].map(([rev, platforms]) => {
    const attrs = [...new Set(platforms.map((p) => p.attribute_path))];
    const systems = platforms.map((p) => p.system).join(", ");
    return `<div class="resolve" style="margin-bottom:.75rem">
    <div class="answer">
      <span class="k">systems</span><span class="v"><code>${esc(systems)}</code></span>
      <span class="k">commit</span><span class="v">${commitLink(rev, 40)}</span>
    </div>
    ${attrs.map((attr) => command(`nix shell github:NixOS/nixpkgs/${rev}#${attr}`)).join("\n    ")}
  </div>`;
  });

  return `${command(`devbox add ${name}@${release.version}`)}
${blocks.join("\n")}`;
}

function renderPlatform(p: V2Platform): string {
  const flags: string[] = [];
  if (p.broken) flags.push(`<span class="badge broken">broken</span>`);
  if (p.insecure) flags.push(`<span class="badge broken">insecure</span>`);
  const outputs = p.outputs
    .map(
      (o) =>
        `<div><code>${esc(o.name ?? "")}</code>${o.default === true ? "" : ` <span class="muted">(not default)</span>`}<br><span class="muted mono">${esc(o.path ?? "")}</span></div>`,
    )
    .join("");
  return `<tr>
      <td><code>${esc(p.system)}</code><br><span class="muted">${esc([p.os, p.arch].filter((x) => x !== "").join(" · "))}</span></td>
      <td><code>${esc(p.attribute_path)}</code></td>
      <td>${commitLink(p.commit_hash, 12)}</td>
      <td>${day(new Date(p.date))}</td>
      <td>${outputs}</td>
      <td>${flags.join(" ")}</td>
    </tr>`;
}
