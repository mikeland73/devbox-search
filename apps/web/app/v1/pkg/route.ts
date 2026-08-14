/**
 * GET /v1/pkg?name= - every version of one package, v1 shape.
 */

import { handleGet } from "@/lib/http";
import { legacyPkg } from "@/lib/legacyHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) =>
  legacyPkg(new URL(request.url).searchParams.get("name") ?? ""),
);
