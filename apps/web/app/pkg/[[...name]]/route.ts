/**
 * GET /pkg/{name...} and GET /pkg?name=
 *
 * The legacy path form takes EVERYTHING after the first segment as the
 * package name - names contain dots (nodePackages.typescript) and the old
 * handler used strings.Cut, not a single path segment. The optional
 * catch-all segment reproduces that; the query-string form is the fallback
 * when no path is given.
 */

import { handleGet } from "@/lib/http";
import { legacyPkg } from "@/lib/legacyHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/pkg\/?/, "");
  const name = path === "" ? (url.searchParams.get("name") ?? "") : decodeURIComponent(path);
  return legacyPkg(name);
});
