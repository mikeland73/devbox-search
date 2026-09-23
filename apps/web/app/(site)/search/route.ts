/**
 * GET /search?q= — the search results page.
 *
 * The same query `/v2/search` runs, rendered as a table. A devbox-style
 * reference (`python@3.11`) is a request for one package, so it redirects
 * to that package's page with the constraint already applied rather than
 * searching for a name nothing is called.
 */

import { handleGet, html, redirect, serverError } from "@/lib/http";
import { search, type ResultPackage } from "@/lib/search";
import { renderV2Search } from "@/lib/render";
import { renderResultsPage } from "@/lib/site/results";
import { pkgPath, resolvePath, splitRef } from "@/lib/site/links";
import { normalize } from "@devbox-search/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) => {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q === "") return redirect("/");

  const ref = splitRef(q);
  if (ref.version !== undefined && ref.name !== "") {
    return redirect(ref.version === "" ? pkgPath(ref.name) : resolvePath(ref.name, ref.version));
  }

  let pkgs: ResultPackage[];
  try {
    pkgs = await search({ phrase: q, version: "latest" });
  } catch (err) {
    return serverError("error searching", err);
  }
  return html(renderResultsPage(renderV2Search(normalize(q), pkgs), new Date(), url.origin));
});
