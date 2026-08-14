/**
 * GET /v2/search?q={phrase}
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
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (q === "") return badRequest("empty search query (set a ?q=<term> query parameter)");

  let pkgs: ResultPackage[];
  try {
    pkgs = await search({ phrase: q, version: "latest" });
  } catch (err) {
    return serverError("", err);
  }
  // The response echoes the normalized phrase, as Query.Phrase did.
  return json(renderV2Search(normalize(q), pkgs));
});
