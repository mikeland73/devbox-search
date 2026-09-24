/**
 * GET / — the home page.
 *
 * Built from {@link homeStatus}, the subset of what the /status page and
 * /status.json report that this page shows, so the headline numbers and the
 * `latest` table are the index's own report of itself, on the same
 * five-minute cache.
 */

import { handleGet, html, serverError } from "@/lib/http";
import { STATUS_CACHE_CONTROL, homeStatus, type HomeStatus } from "@/lib/status";
import { renderHomePage } from "@/lib/site/home";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) => {
  let body: HomeStatus;
  try {
    body = await homeStatus();
  } catch (err) {
    return serverError("error computing status", err);
  }
  return html(renderHomePage(body, new URL(request.url).origin), { cacheControl: STATUS_CACHE_CONTROL });
});
