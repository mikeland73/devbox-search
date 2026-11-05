/**
 * GET /v2/search?q={phrase}[&releases={n|all}]
 *
 * Text search returning the latest release of each matching package.
 * Port of Handler.search in internal/api/handler.go.
 */

import { badRequest, handleGet, json, serverError } from "@/lib/http";
import { search, type ResultPackage } from "@/lib/search";
import { renderV2Search } from "@/lib/render";
import { normalize } from "@devbox-search/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) => {
  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  if (q === "") return badRequest("empty search query (set a ?q=<term> query parameter)");
  const releases = parseReleases(params.get("releases"));
  if (releases === null) return badRequest("releases must be a positive integer or \"all\"");

  let pkgs: ResultPackage[];
  try {
    pkgs = await search({ phrase: q, version: "latest", ...(releases === undefined ? {} : { releases }) });
  } catch (err) {
    return serverError("", err);
  }
  // The response echoes the normalized phrase, as Query.Phrase did.
  return json(renderV2Search(normalize(q), pkgs));
});

/**
 * undefined when absent, null when invalid. A count too large to be an exact
 * number is more than any package has, so it means every release.
 */
function parseReleases(value: string | null): number | "all" | undefined | null {
  if (value === null) return undefined;
  if (value === "all") return "all";
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : "all";
}
