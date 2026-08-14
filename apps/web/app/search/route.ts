/**
 * GET /search?q=[&v=] - the oldest search shape.
 */

import { handleGet } from "@/lib/http";
import { legacySearch } from "@/lib/legacyHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(legacySearch);
