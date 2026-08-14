/**
 * GET /v1/search?q= - the v1 search shape.
 */

import { handleGet } from "@/lib/http";
import { legacyV1Search } from "@/lib/legacyHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(legacyV1Search);
