/**
 * GET /v2/pkg?name={name}
 *
 * All releases of a package, with per-platform detail and the display
 * summaries. Port of Handler.pkg in internal/api/handler.go.
 */

import { badRequest, handleGet, json, notFound, serverError } from "@/lib/http";
import { search, type ResultPackage } from "@/lib/search";
import { renderV2Pkg } from "@/lib/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) => {
  const name = new URL(request.url).searchParams.get("name") ?? "";
  if (name === "") return badRequest("empty package name (set a ?name=<pkg> query parameter)");

  let pkgs: ResultPackage[];
  try {
    pkgs = await search({ name });
  } catch (err) {
    return serverError("", err);
  }
  // Go returned a bare http.NotFound here (no query description).
  if (pkgs.length === 0) return notFound("");

  return json(renderV2Pkg(pkgs));
});
