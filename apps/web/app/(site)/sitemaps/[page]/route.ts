/**
 * GET /sitemaps/{n}.xml — one page of package URLs.
 */

import { handleGet, notFound, serverError } from "@/lib/http";
import { PAGE_SIZE, SITEMAP_CACHE_CONTROL, packageNames, pageStart, renderSitemap } from "@/lib/site/sitemap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) => {
  const url = new URL(request.url);
  const page = Number(url.pathname.split("/").pop()?.replace(/\.xml$/, ""));
  if (!Number.isInteger(page) || page < 1) return notFound("");

  let names: string[];
  try {
    const start = await pageStart(page);
    if (start === null) return notFound("");
    names = (await packageNames(start, PAGE_SIZE)).map((p) => p.name);
  } catch (err) {
    return serverError("error listing packages", err);
  }
  if (names.length === 0) return notFound("");

  return new Response(renderSitemap(url.origin, names), {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": SITEMAP_CACHE_CONTROL },
  });
});
