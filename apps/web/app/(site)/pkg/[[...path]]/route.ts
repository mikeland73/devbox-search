/**
 * GET /pkg, /pkg/{name} and /pkg/{name}/{version} — the package and
 * release pages.
 *
 * One optional catch-all serves the whole tree, the way the removed API
 * alias at this path did (#80). The split is different, though: the alias
 * took *everything* after `/pkg/` as the name, because names contain dots
 * and the Go handler used strings.Cut; here the first segment is the name
 * and an optional second is a version. That is unambiguous because nothing
 * in the index contains a slash — a trigram search for `/` matches none of
 * the 250k names and attribute paths.
 *
 * `?name=` still works and redirects to the path form, so links that
 * predate the alias removal land on the page instead of a 404.
 */

import { handleGet, html, redirect, serverError } from "@/lib/http";
import { resolve, search, type ResultPackage } from "@/lib/search";
import { renderV2Pkg, renderV2Resolve, type V2Resolve } from "@/lib/render";
import { singleHashAcrossSystems } from "@/lib/singleHash";
import { renderPkgPage } from "@/lib/site/pkg";
import { renderReleasePage } from "@/lib/site/release";
import { renderNotFoundPage } from "@/lib/site/notFound";
import { pkgPath, releasePath } from "@/lib/site/links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) => {
  const url = new URL(request.url);
  const origin = url.origin;
  const segments = url.pathname
    .replace(/^\/pkg\/?/, "")
    .split("/")
    .filter((s) => s !== "")
    .map(decodeURIComponent);

  // /pkg?name=python — the shape the removed alias took.
  if (segments.length === 0) {
    const name = (url.searchParams.get("name") ?? "").trim();
    if (name === "") return redirect("/");
    const version = (url.searchParams.get("version") ?? "").trim();
    return redirect(version === "" ? pkgPath(name) : releasePath(name, version));
  }
  if (segments.length > 2) {
    return html(
      renderNotFoundPage({
        heading: "No such page",
        detail: "A package page is /pkg/<name>, and a release is /pkg/<name>/<version>.",
        origin,
      }),
      { status: 404 },
    );
  }

  const [name, version] = segments as [string, string | undefined];
  const requested = (url.searchParams.get("v") ?? "").trim();
  const constraint = version ?? (requested === "" ? "latest" : requested);

  // The two queries are independent, and over a remote Postgres each is a
  // round trip, so the package page issues them together. A release page
  // asks for no resolution at all: the version's per-system commits are
  // already in the /v2/pkg entry.
  let pkgs: ResultPackage[];
  let resolved: V2Resolve | null;
  try {
    [pkgs, resolved] = await Promise.all([
      search({ name }),
      version === undefined ? resolveConstraint(name, constraint) : Promise.resolve(null),
    ]);
  } catch (err) {
    return serverError("error looking up package", err);
  }
  if (pkgs.length === 0) {
    return html(
      renderNotFoundPage({
        heading: `No package named ${name}`,
        detail:
          "Names match case-insensitively; nixpkgs attribute paths (nodePackages.typescript) match case-sensitively.",
        suggest: name,
        origin,
      }),
      { status: 404 },
    );
  }
  const pkg = renderV2Pkg(pkgs);

  // A release page needs no second query: the version's per-system
  // commits are already in the /v2/pkg entry.
  if (version !== undefined) {
    const at = pkg.releases.findIndex((r) => r.version === version);
    if (at < 0) {
      return html(
        renderNotFoundPage({
          heading: `${pkg.name} has no version ${version}`,
          detail: `nixpkgs has ${pkg.releases.length} other release${pkg.releases.length === 1 ? "" : "s"} of it.`,
          suggest: pkg.name,
          origin,
        }),
        { status: 404 },
      );
    }
    return html(
      renderReleasePage({
        pkg,
        release: pkg.releases[at]!,
        newer: pkg.releases[at - 1],
        older: pkg.releases[at + 1],
        origin,
      }),
    );
  }

  return html(renderPkgPage({ pkg, constraint, resolved, now: new Date(), origin }));
});

/**
 * The /v2/resolve answer for the panel, including the single-hash choice.
 * A constraint that matches nothing is a state of the page (the panel says
 * so), not an error: the releases table below it is still the answer to
 * "what does exist?".
 */
async function resolveConstraint(name: string, constraint: string): Promise<V2Resolve | null> {
  try {
    const matched = await resolve({ name, version: constraint });
    if (matched.length === 0) return null;
    return renderV2Resolve(await singleHashAcrossSystems(matched));
  } catch {
    // The page is worth serving without the panel's answer.
    return null;
  }
}
