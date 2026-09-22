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
 *   - `latest` means the highest non-prerelease version still present in
 *     nixpkgs (see latestOrder), with the handler retrying including
 *     prereleases when that is empty.
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
import { commits, createServingClient, meta, packages, schema, variants, versions } from "@devbox-search/db";
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

/**
 * Rows of a raw `execute` result. Drivers disagree on the container:
 * neon-http returns an object with `rows`, PGlite (tests) too, and some
 * drivers return the array directly.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows: T[] }).rows;
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
 * case-insensitively, or the attribute path exactly. `term` is a parameter,
 * or an SQL expression when the name comes from a joined row.
 *
 * Written as a semi-join on variant ids rather than
 * `lower(packages.name) = ? OR variants.attr_path = ?`: an OR spanning two
 * tables can't be served by either table's index, so the planner hash-joined
 * every variant (3.8M rows, ~4 s) for each lookup. Each UNION arm is a plain
 * index walk (packages_name_lower_idx -> versions -> variants_identity_key,
 * and variants_attr_path_idx), which brings a lookup to single-digit ms.
 * See docs/query-plans.md.
 */
export function nameOrAttrPath(term: string | SQL): SQL {
  return sql`${variants.id} IN (
    SELECT va.id
    FROM ${packages} p
    JOIN ${versions} ve ON ve.package_id = p.id
    JOIN ${variants} va ON va.version_id = ve.id
    WHERE lower(p.name) = lower(${term})
    UNION
    SELECT va.id FROM ${variants} va WHERE va.attr_path = ${term}
  )`;
}

/**
 * The newest commit seq a variant was seen in, from its live presence ranges:
 * an open range (the variant is in the newest import of its system) counts
 * as newer than any closed one. Seeded ranges are ignored — they are point
 * ranges at the last *content change* of a row, not presence (the compact DB
 * carried no history) — so a variant with only seeded history is older than
 * anything observed since the migration, and every such variant ties.
 */
function lastSeen(variantId: SQL): SQL<number> {
  return sql<number>`(
    SELECT coalesce(max(coalesce(r.last_seq, 2147483647)), 0)
    FROM ${schema.variantRanges} r
    WHERE r.variant_id = ${variantId} AND NOT r.seeded
  )`;
}

/**
 * The ordering that picks `latest`, over variant rows joined to versions.
 *
 * A version string alone cannot say which release is current: nixpkgs
 * versions snapshots as dates (`2017-03-30`), the comparator ranks a date
 * above any numeric release, and so by sort_key alone go-font's `latest` is a
 * 2017 snapshot rather than 2.010 — while packages that went the other way
 * (mod_python 3.5.0 → 2022-10-18) are just as real, so no string rule can
 * separate an old snapshot from a new one (#44).
 *
 * What does separate them is nixpkgs itself: the newest commit each version
 * was present in. So `latest` is, in order,
 *
 *   1. a version with a non-broken variant in scope (sanctioned change #3,
 *      the two-pass lookup the old service did, as one ordering);
 *   2. the version most recently present — every version still in the newest
 *      import ties here, and a version nixpkgs dropped (or renamed the
 *      attribute of) loses to any that is still there;
 *   3. the highest version, which is the only rule that applies when a
 *      package is served by several attribute paths at once (python312,
 *      python313, …), or when nothing has been seen since the migration
 *      (a package gone before the seed, or a frozen system's history).
 *
 * Presence is judged per variant row, so a system filter narrows it too:
 * "latest on x86_64-linux" is what that system's evals still list.
 */
export function latestOrder(system: string | undefined): SQL[] {
  const scoped = system !== undefined && system !== "" ? sql` AND b.system = ${system}` : sql``;
  return [
    desc(sql`EXISTS (SELECT 1 FROM ${variants} b WHERE b.version_id = ${versions.id} AND NOT b.broken${scoped})`),
    desc(lastSeen(sql`${variants.id}`)),
    desc(versions.sortKey),
  ];
}

/** The column list every searcher selects, joined into a ResultPackage. */
const resultColumns = {
  name: packages.name,
  version: versions.version,
  // Schema columns, not raw `sql` fragments: only a column goes through
  // drizzle's driver-value mapping, and both neon-http and PGlite hand
  // timestamps back as strings. The renderers call `.toISOString()` on
  // lastUpdated, so a raw fragment here is a 500 on every route.
  commitHash: commits.hash,
  lastUpdated: commits.committedAt,
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
    .innerJoin(commits, eq(commits.seq, variants.commitSeq));
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
 * Sanctioned change #3: at `latest`, prefer a version with a non-broken
 * variant and fall back to broken-only (see latestOrder), mirroring the
 * existing prerelease fallback.
 */
export async function searchByNameVersion(q: SearchQuery): Promise<ResultPackage[]> {
  const term = q.name!;
  const version = q.version!;

  const scope: SQL[] = [nameOrAttrPath(term)];
  if (q.noPrerelease === true) scope.push(eq(versions.prerelease, false));
  if (q.system !== undefined && q.system !== "") scope.push(eq(variants.system, q.system));

  let versionId: number | undefined;
  if (version === "latest") {
    versionId = await pickLatestVersionId(scope, q.system);
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

/** The `latest` version id in scope, by latestOrder. One round trip. */
async function pickLatestVersionId(scope: SQL[], system: string | undefined): Promise<number | undefined> {
  const rows = await db()
    .select({ id: versions.id })
    .from(variants)
    .innerJoin(versions, eq(versions.id, variants.versionId))
    .innerJoin(packages, eq(packages.id, versions.packageId))
    .where(and(...scope))
    .orderBy(...latestOrder(system))
    .limit(1);
  return rows[0]?.id;
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

/** Phrase search returns at most this many packages. */
const PHRASE_LIMIT = 50;

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
  const prefix = sql`lower(${escapeLike(phrase)}) || '%'`;

  // The tiered score, selected as `rank` and ordered by that alias so the
  // ordering cannot drift from what is selected (ordering by a positional
  // ordinal once pointed at `name` instead).
  //
  // similarity() is the expensive part of this query (it re-trigrams both
  // strings on every call), and name = attr_path for all but a few hundred
  // rows, so call it once when the two are the same string.
  const rank = sql<number>`
    max(
      CASE
        WHEN lower(search_terms.name) = lower(${phrase}) THEN 1000
        WHEN lower(search_terms.attr_path) = lower(${phrase}) THEN 900
        WHEN lower(search_terms.name) LIKE ${prefix} ESCAPE '\\' THEN 800
        WHEN lower(search_terms.attr_path) LIKE ${prefix} ESCAPE '\\' THEN 700
        ELSE 0
      END
      + 100 * CASE
          WHEN search_terms.name = search_terms.attr_path THEN similarity(search_terms.name, ${phrase})
          ELSE greatest(
            similarity(search_terms.name, ${phrase}),
            similarity(search_terms.attr_path, ${phrase})
          )
        END
      -- Top-level attributes outrank nested ones, mirroring the old
      -- 10x FTS column weight ("python" -> python3, not
      -- emacs28Packages.python3).
      + CASE WHEN search_terms.top_level_attr IS NOT NULL THEN 25 ELSE 0 END
    )`;

  // Two candidate tiers, and the second is skipped when the first is full.
  //
  // Every exact/prefix match scores at least 700; every similarity-only
  // match at most 125. So once the prefix tier alone yields PHRASE_LIMIT
  // packages, no similarity-only row can make the cut, and the `%` scan can
  // be skipped: `(SELECT count(*) FROM prefix) < N` is a pseudo-constant
  // that the planner turns into a One-Time Filter over the fuzzy arm.
  //
  // This matters because `%` is expensive to evaluate, not to index. The
  // GIN trigram index is lossy, so every candidate is rechecked with
  // similarity(), and a broad prefix like "python" has 70k candidates
  // (every pythonXYPackages.* attribute) — 1.1 s of CPU when the two tiers
  // were one OR'd WHERE clause. The prefix tier itself is a BitmapOr of the
  // two lower() btrees. See docs/query-plans.md.
  const prefixMatch = sql`(
    lower(search_terms.name) LIKE ${prefix} ESCAPE '\\'
    OR lower(search_terms.attr_path) LIKE ${prefix} ESCAPE '\\'
  )`;
  const tier = (where: SQL) => sql`
    SELECT search_terms.package_id, search_terms.name, ${rank} AS rank
    FROM search_terms
    WHERE ${where}
    GROUP BY search_terms.package_id, search_terms.name
    ORDER BY rank DESC, search_terms.name
    LIMIT ${PHRASE_LIMIT}`;
  const result = await db().execute(sql`
    WITH prefix AS (${tier(prefixMatch)}),
    fuzzy AS (${tier(sql`
      (SELECT count(*) FROM prefix) < ${PHRASE_LIMIT}
      AND (search_terms.name % ${phrase} OR search_terms.attr_path % ${phrase})
      AND NOT ${prefixMatch}`)})
    -- The tiers are grouped separately, and a package with several attribute
    -- paths can have one in each (name not a prefix match; one attr_path a
    -- prefix match, another only similar). Group once more so a package is
    -- one hit, as the old single GROUP BY guaranteed; name is constant per
    -- package. At most 2 x PHRASE_LIMIT rows reach this point.
    SELECT package_id
    FROM (
      SELECT package_id, max(rank) AS rank, min(name) AS name
      FROM (SELECT * FROM prefix UNION ALL SELECT * FROM fuzzy) AS tiers
      GROUP BY package_id
    ) AS ranked
    -- Best score first; ties by name, as the old "ORDER BY rank, pkg.name".
    ORDER BY rank DESC, name
    LIMIT ${PHRASE_LIMIT}`);
  const ranked = rowsOf<{ package_id: number }>(result);

  if (ranked.length === 0) return [];

  // One query for every hit rather than two or three per hit: under
  // neon-http each query is an HTTPS round trip, and 50 hits x 3 queries was
  // most of /v2/search's latency. `hits` carries the rank order so rows come
  // back in it; within a package the ordering matches the old service.
  //
  // The DISTINCT ON reproduces the old queries' grouping: sqlPrefixLatestSearch
  // `GROUP BY pkg.name` (one row per package, at its newest version) and
  // sqlPrefixSearch `GROUP BY pkg.name, pkg.version` (one row per version).
  // A search result is a package, not a package x system, and the caps count
  // accordingly. Rows are ordered by system then attr_path within a version,
  // so the surviving row is the lowest system — the row sqlite's bare-column
  // grouping surfaced in the live service.
  const hits = sql`unnest(string_to_array(${ranked.map((h) => h.package_id).join(",")}, ',')::int[])
    WITH ORDINALITY AS hits(package_id, ord)`;

  if (latestOnly) {
    // Per package, the non-prerelease version pickLatestVersionId would
    // choose: the same ordering (latestOrder) over the package's variants.
    const rows = await db()
      .selectDistinctOn([sql`hits.ord`], resultColumns)
      .from(hits)
      .innerJoin(
        sql`LATERAL (
          SELECT ${versions.id} AS version_id
          FROM ${variants}
          JOIN ${versions} ON ${versions.id} = ${variants.versionId}
          WHERE ${versions.packageId} = hits.package_id AND ${versions.prerelease} = false
          ORDER BY ${sql.join(latestOrder(undefined), sql`, `)}
          LIMIT 1
        ) AS latest`,
        sql`true`,
      )
      .innerJoin(variants, sql`${variants.versionId} = latest.version_id`)
      .innerJoin(versions, eq(versions.id, variants.versionId))
      .innerJoin(packages, eq(packages.id, versions.packageId))
      .innerJoin(meta, eq(meta.id, variants.metaId))
      .innerJoin(commits, eq(commits.seq, variants.commitSeq))
      .orderBy(sql`hits.ord`, asc(variants.system), asc(variants.attrPath))
      .limit(PHRASE_LIMIT);
    return rows as ResultPackage[];
  }

  const rows = await db()
    .selectDistinctOn([sql`hits.ord`, versions.sortKey, versions.version], resultColumns)
    .from(hits)
    .innerJoin(versions, sql`${versions.packageId} = hits.package_id`)
    .innerJoin(variants, eq(variants.versionId, versions.id))
    .innerJoin(packages, eq(packages.id, versions.packageId))
    .innerJoin(meta, eq(meta.id, variants.metaId))
    .innerJoin(commits, eq(commits.seq, variants.commitSeq))
    .orderBy(
      sql`hits.ord`,
      desc(versions.sortKey),
      asc(versions.version),
      asc(variants.system),
      asc(variants.attrPath),
    )
    .limit(1000);
  return rows as ResultPackage[];
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
 * Resolve semantics shared by /v1/resolve and /v2/resolve: search
 * for the requested version, and if `latest` produced nothing, retry
 * including prereleases.
 */
export async function resolve(query: SearchQuery): Promise<ResultPackage[]> {
  const noPrerelease = query.version === "latest";
  const first = await search({ ...query, noPrerelease });
  if (first.length > 0 || !noPrerelease) return first;
  return search({ ...query, noPrerelease: false });
}
