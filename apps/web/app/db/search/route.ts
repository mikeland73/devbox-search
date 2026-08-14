/**
 * GET /db/search?q= - alias of /v1/search.
 */

import { handleGet } from "@/lib/http";
import { legacyV1Search } from "@/lib/legacyHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(legacyV1Search);
