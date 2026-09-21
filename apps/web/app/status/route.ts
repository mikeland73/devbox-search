/**
 * GET /status — the numbers behind /status.json as a page a person can read:
 * overview tiles, per-system import state, the commit timeline, and what
 * `latest` resolves to for common packages. Same data, same cache policy;
 * see lib/statusPage.ts for the layout.
 */

import { handleGet, html, serverError } from "@/lib/http";
import { STATUS_CACHE_CONTROL, status, type Status } from "@/lib/status";
import { renderStatusPage } from "@/lib/statusPage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async () => {
  let body: Status;
  try {
    body = await status();
  } catch (err) {
    return serverError("error computing status", err);
  }
  return html(renderStatusPage(body), { cacheControl: STATUS_CACHE_CONTROL });
});
