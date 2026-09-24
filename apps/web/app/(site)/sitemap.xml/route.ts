/**
 * GET /sitemap.xml — an index of the paged package sitemaps.
 */

import { handleGet, serverError } from "@/lib/http";
import { PAGE_SIZE, SITEMAP_CACHE_CONTROL, packageCount, renderSitemapIndex } from "@/lib/site/sitemap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) => {
  let count: number;
  try {
    count = await packageCount();
  } catch (err) {
    return serverError("error counting packages", err);
  }
  const body = renderSitemapIndex(new URL(request.url).origin, Math.max(1, Math.ceil(count / PAGE_SIZE)));
  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": SITEMAP_CACHE_CONTROL },
  });
});
