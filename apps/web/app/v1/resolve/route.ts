/**
 * GET /v1/resolve?name=&version=&system= - the v1 resolve shape.
 */

import { handleGet } from "@/lib/http";
import { legacyResolve } from "@/lib/legacyHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(legacyResolve);
