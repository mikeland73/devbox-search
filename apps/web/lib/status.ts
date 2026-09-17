/**
 * Index-wide statistics for GET /status: how much data there is, how far the
 * commit timeline reaches, and when each system was last imported.
 *
 * Everything here is derived from the schema's own bookkeeping (`commits`,
 * `commit_systems`) plus row counts, so it is cheap to keep honest. The row
 * counts are exact `count(*)`s — variants is ~4M rows, which is a few hundred
 * ms of index-only scan on Neon — and the queries run concurrently since
 * neon-http issues each as its own HTTP request.
 */

import { count, desc, eq, max, sql } from "drizzle-orm";
import {
  commits,
  commitSystems,
  meta,
  packages,
  searchTerms,
  variantRanges,
  variants,
  versions,
} from "@devbox-search/db";
import { db, rowsOf } from "./search";

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

export interface Status {
  /** Exact row counts per table. */
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
  /** When these numbers were computed (responses are CDN-cached). */
  generated_at: Date;
}

export async function status(): Promise<Status> {
  const [counts, oldest, newest, systems, sizeRows] = await Promise.all([
    countRows(),
    commitAt("oldest"),
    commitAt("newest"),
    systemStatuses(),
    db().execute(sql`SELECT pg_database_size(current_database())::text AS bytes`),
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
    generated_at: new Date(),
  };
}

async function countRows(): Promise<Status["counts"]> {
  const tables = { packages, versions, variants, variant_ranges: variantRanges, meta, search_terms: searchTerms, commits };
  const entries = await Promise.all(
    Object.entries(tables).map(async ([name, table]) => {
      const [row] = await db().select({ n: count() }).from(table);
      return [name, row!.n] as const;
    }),
  );
  return Object.fromEntries(entries) as Status["counts"];
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
