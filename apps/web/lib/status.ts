/**
 * Index-wide statistics for GET /status.json (and the /status page): how much
 * data there is, how far the commit timeline reaches, when each system was
 * last imported, and what `latest` currently resolves to for a handful of
 * everyday packages.
 *
 * Everything here is derived from the schema's own bookkeeping (`commits`,
 * `commit_systems`, `row_counts`), so it is cheap to keep honest. The row
 * counts are exact but not counted here: variants and variant_ranges are
 * ~4M rows each, a second of scanning per request, and the only writers
 * (the importer and the seed) recount into `row_counts` as they commit.
 * The queries run concurrently since neon-http issues each as its own HTTP
 * request.
 */

import { count, desc, eq, inArray, max, sql } from "drizzle-orm";
import { commits, commitSystems, rowCounts, variants, versions, type CountedTable } from "@devbox-search/db";
import { db, latestOrder, nameOrAttrPath, rowsOf } from "./search";

/**
 * Packages whose `latest` resolution the status page shows: the toolchains
 * a devbox.json most often pins, in the names devbox users write. A glance
 * at these says whether the index is tracking upstream releases, which the
 * row counts alone cannot.
 */
export const COMMON_PACKAGES = [
  "python",
  "nodejs",
  "go",
  "rustc",
  "ruby",
  "php",
  "jdk",
  "deno",
  "bun",
  "elixir",
  "erlang",
  "dotnet-sdk",
  "zig",
  "gcc",
  "clang",
  "ghc",
  "kotlin",
  "swift",
  "perl",
  "lua",
  "julia",
  "terraform",
  "kubectl",
  "postgresql",
  "redis",
  "sqlite",
  "git",
  "docker",
  "uv",
  "pnpm",
] as const;

/**
 * Cache policy for /status.json and /status: fresh enough to catch a stalled
 * import within minutes.
 */
export const STATUS_CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=600";

/** One point on the commit timeline. */
export interface CommitRef {
  seq: number;
  hash: string;
  /** The nixpkgs commit date. */
  committed_at: Date;
  /** When the commit row was created here. */
  imported_at: Date;
}

/** Import state of one Nix system. */
export interface SystemStatus {
  system: string;
  /** Commits with an imported evaluation for this system. */
  commits: number;
  /** The newest commit evaluated for this system. */
  newest: CommitRef;
  /** When that newest evaluation was imported. */
  last_imported_at: Date;
  /** `nix --version` behind the newest evaluation; null for seeded rows. */
  nix_version: string | null;
}

/** What `name@latest` resolves to right now. */
export interface LatestVersion {
  name: string;
  /** null when the name does not resolve at all. */
  version: string | null;
  /** The (alphabetically first) attribute path serving that version. */
  attr_path: string | null;
  /** Systems the version is available on, sorted. */
  systems: string[];
  /** The newest nixpkgs commit date among those variants. */
  last_updated: Date | null;
}

export interface Status {
  /** Exact row counts per table, as of the last import. */
  counts: {
    packages: number;
    versions: number;
    variants: number;
    variant_ranges: number;
    meta: number;
    search_terms: number;
    commits: number;
  };
  /** Endpoints of the commit timeline; null when nothing has been imported. */
  oldest_commit: CommitRef | null;
  newest_commit: CommitRef | null;
  /** The most recent import on any system; null when nothing has been imported. */
  last_import_at: Date | null;
  /** Per-system import state, sorted by system name. */
  systems: SystemStatus[];
  /** pg_database_size() of the serving database. */
  database_size_bytes: number;
  /** `latest` for each of {@link COMMON_PACKAGES}, in that order. */
  latest_versions: LatestVersion[];
  /** When these numbers were computed (responses are CDN-cached). */
  generated_at: Date;
}

/**
 * What the home page shows: three of the counts, the newest commit and the
 * `latest` table. A subset of {@link Status}, so a Status is also one.
 */
export interface HomeStatus {
  counts: Pick<Status["counts"], "packages" | "versions" | "commits">;
  newest_commit: CommitRef | null;
  latest_versions: LatestVersion[];
  generated_at: Date;
}

/** {@link status} without the numbers only /status shows. */
export async function homeStatus(): Promise<HomeStatus> {
  const [counts, newest, latest] = await Promise.all([
    storedCounts(["packages", "versions", "commits"]),
    commitAt("newest"),
    latestVersions([...COMMON_PACKAGES]),
  ]);
  return { counts, newest_commit: newest, latest_versions: latest, generated_at: new Date() };
}

export async function status(): Promise<Status> {
  const [counts, oldest, newest, systems, sizeRows, latest] = await Promise.all([
    storedCounts(["packages", "versions", "variants", "variant_ranges", "meta", "search_terms", "commits"]),
    commitAt("oldest"),
    commitAt("newest"),
    systemStatuses(),
    db().execute(sql`SELECT pg_database_size(current_database())::text AS bytes`),
    latestVersions([...COMMON_PACKAGES]),
  ]);

  let lastImportAt: Date | null = null;
  for (const s of systems) {
    if (lastImportAt === null || s.last_imported_at > lastImportAt) lastImportAt = s.last_imported_at;
  }

  return {
    counts,
    oldest_commit: oldest,
    newest_commit: newest,
    last_import_at: lastImportAt,
    systems,
    database_size_bytes: Number(rowsOf<{ bytes: string }>(sizeRows)[0]!.bytes),
    latest_versions: latest,
    generated_at: new Date(),
  };
}

/**
 * The row counts the last import (or the seed, or migration 0006) recorded
 * for each table, keyed as given. Every tracked table has a row from
 * migration 0006 on, so a missing one is a database that skipped it.
 */
async function storedCounts<K extends CountedTable>(tables: K[]): Promise<Record<K, number>> {
  const rows = await db()
    .select({ table: rowCounts.tableName, n: rowCounts.rowCount })
    .from(rowCounts)
    .where(inArray(rowCounts.tableName, tables));
  const found = new Map(rows.map((r) => [r.table, r.n]));
  return Object.fromEntries(
    tables.map((t) => {
      const n = found.get(t);
      if (n === undefined) throw new Error(`row_counts has no row for ${t}; is migration 0006 applied?`);
      return [t, n];
    }),
  ) as Record<K, number>;
}

async function commitAt(end: "oldest" | "newest"): Promise<CommitRef | null> {
  const [row] = await db()
    .select({
      seq: commits.seq,
      hash: commits.hash,
      committed_at: commits.committedAt,
      imported_at: commits.importedAt,
    })
    .from(commits)
    .orderBy(end === "oldest" ? commits.seq : desc(commits.seq))
    .limit(1);
  return row ?? null;
}

/**
 * One row per system: how many commits it has, and the newest of them
 * (joined back to `commit_systems` for that evaluation's import time and
 * Nix version). This is where a system frozen at an old seq shows up.
 */
async function systemStatuses(): Promise<SystemStatus[]> {
  const perSystem = db()
    .select({
      system: commitSystems.system,
      commits: count().as("commits"),
      newestSeq: max(commitSystems.commitSeq).as("newest_seq"),
    })
    .from(commitSystems)
    .groupBy(commitSystems.system)
    .as("s");

  const rows = await db()
    .select({
      system: perSystem.system,
      commits: perSystem.commits,
      seq: commits.seq,
      hash: commits.hash,
      committed_at: commits.committedAt,
      imported_at: commits.importedAt,
      last_imported_at: commitSystems.importedAt,
      nix_version: commitSystems.nixVersion,
    })
    .from(perSystem)
    .innerJoin(commits, eq(commits.seq, perSystem.newestSeq))
    .innerJoin(
      commitSystems,
      sql`${commitSystems.commitSeq} = ${perSystem.newestSeq} AND ${commitSystems.system} = ${perSystem.system}`,
    )
    .orderBy(perSystem.system);

  return rows.map((r) => ({
    system: r.system,
    commits: r.commits,
    newest: { seq: r.seq, hash: r.hash, committed_at: r.committed_at, imported_at: r.imported_at },
    last_imported_at: r.last_imported_at,
    nix_version: r.nix_version,
  }));
}

/**
 * What `name@latest` resolves to, for each name, in one round trip.
 *
 * The same choice /v2/resolve makes — nameOrAttrPath scoping and latestOrder,
 * per package via a LATERAL subquery — with resolve()'s "retry including
 * prereleases" fallback folded into the ordering: a non-prerelease version
 * outranks any prerelease, so the fallback only ever applies when there is
 * nothing else. Names that match nothing are returned with null fields so
 * the list is always the full input, in input order.
 */
export async function latestVersions(names: string[]): Promise<LatestVersion[]> {
  if (names.length === 0) return [];
  // Names carry no commas (they are package names), so a CSV parameter
  // unnests cleanly; the ordinality keeps the input order.
  const want = sql`unnest(string_to_array(${names.join(",")}, ',')) WITH ORDINALITY AS want(name, ord)`;
  const rows = await db()
    .select({
      name: sql<string>`want.name`,
      version: versions.version,
      attr_path: sql<string>`min(${variants.attrPath})`,
      // jsonb rather than text[]: both drivers parse jsonb, and drizzle only
      // decodes array literals for schema columns.
      systems: sql`jsonb_agg(DISTINCT ${variants.system})`.mapWith((v: unknown) =>
        (typeof v === "string" ? (JSON.parse(v) as string[]) : (v as string[])).sort(),
      ),
      last_updated: max(commits.committedAt),
    })
    .from(want)
    .innerJoin(
      sql`LATERAL (
        SELECT ${versions.id} AS version_id
        FROM ${variants}
        JOIN ${versions} ON ${versions.id} = ${variants.versionId}
        WHERE ${nameOrAttrPath(sql`want.name`)}
        ORDER BY ${versions.prerelease}, ${sql.join(latestOrder(undefined), sql`, `)}
        LIMIT 1
      ) AS latest`,
      sql`true`,
    )
    .innerJoin(variants, sql`${variants.versionId} = latest.version_id`)
    .innerJoin(versions, eq(versions.id, variants.versionId))
    .innerJoin(commits, eq(commits.seq, variants.commitSeq))
    .groupBy(sql`want.ord`, sql`want.name`, versions.version)
    .orderBy(sql`want.ord`);

  const found = new Map(rows.map((r) => [r.name, r]));
  return names.map((name) => {
    const r = found.get(name);
    if (r === undefined) return { name, version: null, attr_path: null, systems: [], last_updated: null };
    return { name, version: r.version, attr_path: r.attr_path, systems: r.systems, last_updated: r.last_updated };
  });
}
