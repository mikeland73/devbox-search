/**
 * GET /status.json — index-wide statistics: row counts, the span of the
 * commit timeline, when each system was last imported, and what `latest`
 * resolves to for common packages. Not part of the Go service's API; exists
 * so a monitor can tell whether the daily import is keeping up. See
 * lib/status.ts for the shape, and /status for the same numbers as a page.
 */

import { handleGet, json, serverError } from "@/lib/http";
import { STATUS_CACHE_CONTROL, status, type Status } from "@/lib/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async () => {
  let body: Status;
  try {
    body = await status();
  } catch (err) {
    return serverError("error computing status", err);
  }
  return json(body, { cacheControl: STATUS_CACHE_CONTROL });
});
