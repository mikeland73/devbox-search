/**
 * GET /robots.txt — everything is crawlable.
 *
 * Package pages are the point of the site: a quarter of a million stable
 * URLs whose content changes only when nixpkgs changes. Nothing is hidden
 * from crawlers; the sitemap points at the package list so they do not
 * have to discover it link by link.
 */

import { handleGet } from "@/lib/http";
import { SITEMAP_CACHE_CONTROL } from "@/lib/site/sitemap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) => {
  const origin = new URL(request.url).origin;
  const body = `User-agent: *
Allow: /

Sitemap: ${origin}/sitemap.xml
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": SITEMAP_CACHE_CONTROL },
  });
});
