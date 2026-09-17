/**
 * Query layer reproducing the three searcher shapes of the old Go service
 * (internal/nixpkgs/search.go), against the normalized Postgres schema.
 *
 * The old queries ran over one wide `pkg` table whose grain was
 * name x version x system x attr_path. Here the same result rows are
 * assembled by joining packages -> versions -> variants -> meta, but the
 * matching semantics are preserved exactly:
 *
 *   - name matching is case-insensitive, attr_path matching is
 *     case-sensitive, and the two are ORed: `name = ?1 OR attr_path = ?1`;
 *   - every input string is NFD-normalized and trimmed, exactly as at ingest;
 *   - `latest` means the highest non-prerelease version, with the handler
 *     retrying including prereleases when that is empty.
 *
 * Sanctioned changes implemented here:
 *   #1 dot-boundary version matching (a partial version is a range, not a raw
 *      string prefix) plus npm-style range constraints in the same parameter;
 *   #3 prefer non-broken versions at `latest`;
 *   #5 LIKE wildcards in user input are escaped.
 */

import { and, asc, desc, eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { escapeLike, normalize } from "@devbox-search/core";
import { createServingClient, meta, packages, schema, variants, versions } from "@devbox-search/db";
import { parseConstraint, satisfies, type Constraint } from "./constraint";

export interface SearchQuery {
  /** Full-text search over names and attribute paths. */
  phrase?: string;
  /** Exact package name or attribute path. */
  name?: string;
  /** Version, version prefix, npm range, or the literal "latest". */
  version?: string;
  /** Exclude prerelease versions. */
  noPrerelease?: boolean;
  /** Restrict to one Nix system. */
  system?: string;
}

/**
 * One result row: a single version x system x attr_path, shaped like the old
 * service's decoded Package so the response builders port line-by-line.
 */
export interface ResultPackage {
  name: string;
  version: string;
  commitHash: string;
  lastUpdated: Date;
  storeHash: string;
  storeName: string;
  storeVersion: string;
  metaName: string;
  metaVersion: string[];
  attrPath: string;
  system: string;
  program: string;
  summary: string;
  description: string;
  homepage: string;
  license: string;
  broken: boolean;
  insecure: boolean;
  platforms: string[];
  outputs: Array<{ name: string; path: string; default: boolean }>;
}

/**
 * Any drizzle Postgres database over our schema. The serving client is
 * neon-http; tests substitute an in-process PGlite via {@link useDb}.
 */
export type SearchDb = PgDatabase<PgQueryResultHKT, typeof schema>;

let cached: SearchDb | undefined;

/** The process-wide serving client (neon-http holds no connections). */
export function db(): SearchDb {
  cached ??= createServingClient();
  return cached;
}

/** Test seam: route every query at `override` (undefined restores the default). */
export function useDb(override: SearchDb | undefined): void {
  cached = override;
}

/** Normalizes a query the same way the Go service did before hitting the DB. */
export function normalizeQuery(q: SearchQuery): SearchQuery {
  const out: SearchQuery = {};
  if (q.phrase !== undefined) out.phrase = normalize(q.phrase);
  if (q.name !== undefined) out.name = normalize(q.name);
  if (q.version !== undefined) out.version = normalize(q.version);
  if (q.system !== undefined) out.system = normalize(q.system.toLowerCase());
  if (q.noPrerelease !== undefined) out.noPrerelease = q.noPrerelease;
  return out;
}

/**
 * The `WITH target AS (...)` predicate: match the canonical name
 * case-insensitively, or the attribute path exactly.
 */
function nameOrAttrPath(term: string): SQL {
  return or(
    sql`lower(${packages.name}) = lower(${term})`,
    eq(variants.attrPath, term),
  )!;
}

/** The column list every searcher selects, joined into a ResultPackage. */
const resultColumns = {
  name: packages.name,
  version: versions.version,
  commitHash: sql<string>`commit_hash.hash`,
  lastUpdated: sql<Date>`commit_hash.committed_at`,
  storeHash: variants.storeHash,
  storeName: variants.storeName,
  storeVersion: versions.version,
  metaName: variants.metaName,
  metaVersion: variants.metaVersion,
  attrPath: variants.attrPath,
  system: variants.system,
  program: variants.program,
  summary: meta.summary,
  description: meta.description,
  homepage: meta.homepage,
  license: meta.license,
  broken: variants.broken,
  insecure: variants.insecure,
  platforms: meta.platforms,
  outputs: variants.outputs,
} as const;

/**
 * The base query: variants joined to their version, package, metadata, and
 * the commit of their last content change.
 */
function baseQuery() {
  return db()
    .select(resultColumns)
    .from(variants)
    .innerJoin(versions, eq(versions.id, variants.versionId))
    .innerJoin(packages, eq(packages.id, versions.packageId))
    .innerJoin(meta, eq(meta.id, variants.metaId))
    .innerJoin(sql`commits AS commit_hash`, sql`commit_hash.seq = ${variants.commitSeq}`);
}

/**
 * Search by exact name or attribute path, returning every version.
 * Mirrors sqlNameSearch: ordered newest version first, then system.
 */
export async function searchByName(q: SearchQuery): Promise<ResultPackage[]> {
  const term = q.name!;
  const conditions: SQL[] = [nameOrAttrPath(term)];
  if (q.noPrerelease === true) conditions.push(eq(versions.prerelease, false));
  if (q.system !== undefined && q.system !== "") conditions.push(eq(variants.system, q.system));

  const rows = await baseQuery()
    .where(and(...conditions))
    .orderBy(desc(versions.sortKey), asc(variants.system), asc(variants.attrPath))
    .limit(1000);
  return rows as ResultPackage[];
}

/**
 * Search by name and version, returning the single best-matching version.
 * Mirrors sqlNameVersionSearch / sqlNameLatestSearch, including the "latest"
 * special case and its prerelease fallback (performed by the caller).
 *
 * Sanctioned change #3: at `latest`, prefer the newest non-broken version and
 * fall back to broken-only, mirroring the existing prerelease fallback.
 */
export async function searchByNameVersion(q: SearchQuery): Promise<ResultPackage[]> {
  const term = q.name!;
  const version = q.version!;

  const scope: SQL[] = [nameOrAttrPath(term)];
  if (q.noPrerelease === true) scope.push(eq(versions.prerelease, false));
  if (q.system !== undefined && q.system !== "") scope.push(eq(variants.system, q.system));

  let versionId: number | undefined;
  if (version === "latest") {
    versionId = await pickLatestVersionId(scope, { preferNonBroken: true });
  } else {
    versionId = await pickConstrainedVersionId(term, version, scope);
  }
  if (versionId === undefined) return [];

  const rows = await baseQuery()
    .where(and(eq(versions.id, versionId), ...scope.slice(1)))
    .orderBy(asc(variants.system), asc(variants.attrPath))
    .limit(1000);
  return rows as ResultPackage[];
}

/** The newest version id in scope, optionally preferring non-broken ones. */
async function pickLatestVersionId(
  scope: SQL[],
  options: { preferNonBroken: boolean },
): Promise<number | undefined> {
  const pick = async (extra?: SQL): Promise<number | undefined> => {
    const rows = await db()
      .select({ id: versions.id })
      .from(variants)
      .innerJoin(versions, eq(versions.id, variants.versionId))
      .innerJoin(packages, eq(packages.id, versions.packageId))
      .where(extra === undefined ? and(...scope) : and(...scope, extra))
      .orderBy(desc(versions.sortKey))
      .limit(1);
    return rows[0]?.id;
  };

  if (options.preferNonBroken) {
    const nonBroken = await pick(eq(variants.broken, false));
    if (nonBroken !== undefined) return nonBroken;
  }
  return pick();
}

/**
 * The newest version id satisfying a version constraint.
 *
 * Sanctioned change #1: partial versions become dot-boundary ranges
 * (`3.1` matches 3.1.x but not 3.11), and full npm ranges (`^3.11`,
 * `>=1.2 <2`) are accepted in the same parameter. Versions that are not
 * strict semver keep prefix-with-boundary semantics, evaluated in SQL.
 */
async function pickConstrainedVersionId(
  term: string,
  version: string,
  scope: SQL[],
): Promise<number | undefined> {
  const constraint = parseConstraint(version);

  // Non-semver input (dates, "1.1.1w", ...) can't be evaluated with the
  // semver columns; fall back to prefix-with-boundary matching in SQL. The
  // boundary is what makes "3.1" stop matching "3.11".
  if (constraint === null) {
    const escaped = escapeLike(version);
    const rows = await db()
      .select({ id: versions.id })
      .from(variants)
      .innerJoin(versions, eq(versions.id, variants.versionId))
      .innerJoin(packages, eq(packages.id, versions.packageId))
      .where(
        and(
          ...scope,
          or(
            eq(versions.version, version),
            // A dot boundary: "3.1" matches "3.1.4" but not "3.11".
            sql`${versions.version} LIKE ${escaped + ".%"} ESCAPE '\\'`,
            // A dash boundary covers prerelease suffixes: "1.0" matches
            // "1.0-rc1".
            sql`${versions.version} LIKE ${escaped + "-%"} ESCAPE '\\'`,
          ),
        ),
      )
      .orderBy(desc(versions.sortKey))
      .limit(1);
    return rows[0]?.id;
  }

  // Semver-expressible constraint: filter with the indexed columns, then
  // apply the precise range check in the application (the candidate set is
  // one package's versions, which is small).
  const candidates = await db()
    .select({
      id: versions.id,
      version: versions.version,
      major: versions.semverMajor,
      minor: versions.semverMinor,
      patch: versions.semverPatch,
      pre: versions.semverPre,
      sortKey: versions.sortKey,
    })
    .from(variants)
    .innerJoin(versions, eq(versions.id, variants.versionId))
    .innerJoin(packages, eq(packages.id, versions.packageId))
    .where(and(...scope, isNotNull(versions.semverMajor), semverBounds(constraint)))
    .orderBy(desc(versions.sortKey))
    .limit(1000);

  for (const c of candidates) {
    if (
      satisfies(constraint, {
        major: c.major!,
        minor: c.minor ?? 0,
        patch: c.patch ?? 0,
        prerelease: c.pre ?? "",
      })
    ) {
      return c.id;
    }
  }

  // A constraint like "3" should still resolve for packages whose versions
  // aren't strict semver (e.g. "3.1.1w"), so fall back to prefix matching.
  return pickConstrainedVersionIdFallback(term, version, scope);
}

async function pickConstrainedVersionIdFallback(
  _term: string,
  version: string,
  scope: SQL[],
): Promise<number | undefined> {
  const escaped = escapeLike(version);
  const rows = await db()
    .select({ id: versions.id })
    .from(variants)
    .innerJoin(versions, eq(versions.id, variants.versionId))
    .innerJoin(packages, eq(packages.id, versions.packageId))
    .where(
      and(
        ...scope,
        or(
          eq(versions.version, version),
          sql`${versions.version} LIKE ${escaped + ".%"} ESCAPE '\\'`,
          sql`${versions.version} LIKE ${escaped + "-%"} ESCAPE '\\'`,
        ),
      ),
    )
    .orderBy(desc(versions.sortKey))
    .limit(1);
  return rows[0]?.id;
}

/** Coarse indexable bounds for a constraint, refined in the application. */
function semverBounds(constraint: Constraint): SQL {
  const clauses: SQL[] = [];
  if (constraint.min !== null) {
    clauses.push(sql`${versions.semverMajor} >= ${constraint.min.major}`);
  }
  if (constraint.max !== null) {
    clauses.push(sql`${versions.semverMajor} <= ${constraint.max.major}`);
  }
  return clauses.length === 0 ? sql`true` : and(...clauses)!;
}

/**
 * Full-text search over names and attribute paths.
 *
 * Replaces FTS5 bm25 (with its 10x top-level-attr weighting) with tiered
 * pg_trgm scoring: exact match, then prefix match, then trigram similarity,
 * with top-level attributes ranked above nested ones. Ranking drift versus
 * the old service is accepted — the CLI critical path is resolve, not search.
 */
export async function searchByPhrase(q: SearchQuery): Promise<ResultPackage[]> {
  const phrase = q.phrase!;
  const latestOnly = q.version === "latest";

  const ranked = await db()
    .select({
      packageId: sql<number>`search_terms.package_id`,
      name: sql<string>`search_terms.name`,
      rank: sql<number>`
        max(
          CASE
            WHEN lower(search_terms.name) = lower(${phrase}) THEN 1000
            WHEN lower(search_terms.attr_path) = lower(${phrase}) THEN 900
            WHEN lower(search_terms.name) LIKE lower(${escapeLike(phrase)}) || '%' ESCAPE '\\' THEN 800
            WHEN lower(search_terms.attr_path) LIKE lower(${escapeLike(phrase)}) || '%' ESCAPE '\\' THEN 700
            ELSE 0
          END
          + 100 * greatest(
              similarity(search_terms.name, ${phrase}),
              similarity(search_terms.attr_path, ${phrase})
            )
          -- Top-level attributes outrank nested ones, mirroring the old
          -- 10x FTS column weight ("python" -> python3, not
          -- emacs28Packages.python3).
          + CASE WHEN search_terms.top_level_attr IS NOT NULL THEN 25 ELSE 0 END
        )`,
    })
    .from(sql`search_terms`)
    .where(
      sql`search_terms.name % ${phrase} OR search_terms.attr_path % ${phrase}
          OR lower(search_terms.name) LIKE lower(${escapeLike(phrase)}) || '%' ESCAPE '\\'`,
    )
    .groupBy(sql`search_terms.package_id, search_terms.name`)
    .orderBy(sql`2 DESC`)
    .limit(50);

  if (ranked.length === 0) return [];

  const results: ResultPackage[] = [];
  for (const [i, hit] of ranked.entries()) {
    const rows = latestOnly
      ? await searchByNameVersion({ name: hit.name, version: "latest", noPrerelease: true })
      : await searchByName({ name: hit.name });
    // Preserve rank order across packages; within a package the per-query
    // ordering already matches the old service.
    for (const row of rows) results.push(row);
    if (latestOnly && results.length >= 50) break;
    if (!latestOnly && results.length >= 1000) break;
    void i;
  }
  return results.slice(0, latestOnly ? 50 : 1000);
}

/** Dispatch mirroring Searcher.search's switch. */
export async function search(query: SearchQuery): Promise<ResultPackage[]> {
  const q = normalizeQuery(query);
  const hasName = q.name !== undefined && q.name !== "";
  const hasPhrase = q.phrase !== undefined && q.phrase !== "";
  const hasVersion = q.version !== undefined && q.version !== "";

  if (!hasName && hasPhrase) return searchByPhrase(q);
  if (hasName && !hasVersion) return searchByName(q);
  if (hasName && hasVersion) return searchByNameVersion(q);
  throw new Error(`unsupported search query: ${JSON.stringify(query)}`);
}

/**
 * Resolve semantics shared by /v1/resolve, /resolve and /v2/resolve: search
 * for the requested version, and if `latest` produced nothing, retry
 * including prereleases.
 */
export async function resolve(query: SearchQuery): Promise<ResultPackage[]> {
  const noPrerelease = query.version === "latest";
  const first = await search({ ...query, noPrerelease });
  if (first.length > 0 || !noPrerelease) return first;
  return search({ ...query, noPrerelease: false });
}
