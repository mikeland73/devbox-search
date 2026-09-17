/**
 * GET /status — index-wide statistics: row counts, the span of the commit
 * timeline, and when each system was last imported. Not part of the Go
 * service's API; exists so a human (or a monitor) can tell at a glance
 * whether the daily import is keeping up. See lib/status.ts for the shape.
 */

import { handleGet, json, serverError } from "@/lib/http";
import { status, type Status } from "@/lib/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fresh enough to catch a stalled import within minutes, cached enough that
 * the ~4M-row counts aren't recomputed per request.
 */
const STATUS_CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=600";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async () => {
  let body: Status;
  try {
    body = await status();
  } catch (err) {
    return serverError("error computing status", err);
  }
  return json(body, { cacheControl: STATUS_CACHE_CONTROL });
});
