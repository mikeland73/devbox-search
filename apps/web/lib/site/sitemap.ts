/**
 * Sitemaps over the whole package list.
 *
 * Every package page is a stable URL worth crawling, and there are a
 * quarter of a million of them — past the 50k-per-file limit in the
 * sitemap protocol, so /sitemap.xml is an index of /sitemaps/N.xml pages.
 * Each page is one keyset query over `packages` (ordered by id, which is
 * the primary key, so it is an index scan rather than a growing OFFSET
 * walk), and both are cached at the edge for a day: a crawl costs a
 * handful of queries, not one per URL.
 *
 * Release pages are deliberately absent. They are linked from the package
 * page a crawler will already have, and listing 1.4M of them would be
 * mostly churn.
 */

import { asc, gt, sql } from "drizzle-orm";
import { packages } from "@devbox-search/db";
import { db, rowsOf } from "../search";
import { esc } from "./format";
import { pkgPath } from "./links";

/** URLs per sitemap file; the protocol's limit is 50,000. */
export const PAGE_SIZE = 50_000;

/** A day: the package list changes by a few names per import. */
export const SITEMAP_CACHE_CONTROL = "public, s-maxage=86400, stale-while-revalidate=604800";

export async function packageCount(): Promise<number> {
  const result = await db().execute(sql`SELECT count(*)::int AS n FROM ${packages}`);
  return rowsOf<{ n: number }>(result)[0]?.n ?? 0;
}

/**
 * One page of package names, by id order. `after` is the last id of the
 * previous page, so paging is a range scan on the primary key.
 */
export async function packageNames(after: number, limit = PAGE_SIZE): Promise<Array<{ id: number; name: string }>> {
  return db()
    .select({ id: packages.id, name: packages.name })
    .from(packages)
    .where(gt(packages.id, after))
    .orderBy(asc(packages.id))
    .limit(limit);
}

/**
 * The id to start page `n` (1-based) after, or null when there is no such
 * page. Null rather than a huge sentinel id: the sentinel would be handed
 * to `id > $1`, where anything past int4 is a Postgres error rather than
 * an empty result.
 */
export async function pageStart(n: number): Promise<number | null> {
  if (n <= 1) return 0;
  const result = await db().execute(
    sql`SELECT id FROM ${packages} ORDER BY id OFFSET ${(n - 1) * PAGE_SIZE - 1} LIMIT 1`,
  );
  return rowsOf<{ id: number }>(result)[0]?.id ?? null;
}

export function renderSitemapIndex(origin: string, pages: number): string {
  const entries = Array.from(
    { length: pages },
    (_, i) => `  <sitemap><loc>${esc(`${origin}/sitemaps/${i + 1}.xml`)}</loc></sitemap>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</sitemapindex>
`;
}

export function renderSitemap(origin: string, names: string[]): string {
  const entries = names.map((name) => `  <url><loc>${esc(origin + pkgPath(name))}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`;
}
