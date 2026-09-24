/**
 * GET / — the home page.
 *
 * Built from the same {@link status} the /status page and /status.json
 * use, so the headline numbers and the `latest` table are the index's own
 * report of itself. It is fresh for the same five minutes, but served stale
 * for longer (see HOME_CACHE_CONTROL).
 */

import { handleGet, html, serverError } from "@/lib/http";
import { status, type Status } from "@/lib/status";
import { HOME_CACHE_CONTROL, renderHomePage } from "@/lib/site/home";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) => {
  let body: Status;
  try {
    body = await status();
  } catch (err) {
    return serverError("error computing status", err);
  }
  return html(renderHomePage(body, new URL(request.url).origin), { cacheControl: HOME_CACHE_CONTROL });
});
