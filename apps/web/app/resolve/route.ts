/**
 * GET /resolve?name=&version=&system= - alias of /v1/resolve.
 */

import { handleGet } from "@/lib/http";
import { legacyResolve } from "@/lib/legacyHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(legacyResolve);
