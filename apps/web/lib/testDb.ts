/**
 * In-process Postgres for query-layer tests.
 *
 * PGlite runs the real migrations (via `migrationStatements()`, so a new
 * migration is exercised the moment drizzle-kit generates it) with pg_trgm
 * loaded, and {@link useDb} points search.ts at it. Fixtures are described
 * at the API's grain — package, versions, systems — and expanded into the
 * normalized tables the same way the importer would.
 */

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { isPrerelease, parseSemver, sha256Hex, sortKey } from "@devbox-search/core";
import {
  commitSystems,
  commits,
  meta,
  migrationStatements,
  packages,
  REFRESH_ROW_COUNTS,
  schema,
  searchTerms,
  variantRanges,
  variants,
  versions,
} from "@devbox-search/db";
import { useDb, type SearchDb } from "./search";

export interface TestDb {
  db: SearchDb;
  /** Every statement issued through `db`, in order (clear it between phases). */
  queries: string[];
  close(): Promise<void>;
}

/** A fresh database with the schema applied, already installed via useDb. */
export async function createTestDb(): Promise<TestDb> {
  const client = await PGlite.create({ extensions: { pg_trgm } });
  for (const statement of migrationStatements()) await client.exec(statement);
  const queries: string[] = [];
  const db = drizzle(client, { schema, logger: { logQuery: (query) => void queries.push(query) } });
  useDb(db);
  return {
    db,
    queries,
    async close() {
      useDb(undefined);
      await client.close();
    },
  };
}

export interface FixtureVersion {
  /** May repeat within a package: entries for the same version string share one versions row. */
  version: string;
  /** Defaults to every system in {@link SYSTEMS}. */
  systems?: string[];
  /** Defaults to the package name. */
  attrPath?: string;
  /** Commit seq of the last content change; defaults to 1. */
  commitSeq?: number;
  /**
   * Commit seq the version was last present in. Defaults to still present:
   * an open range from `commitSeq`, as the importer leaves a variant that is
   * in the newest eval. Set it to model a version nixpkgs has since dropped,
   * either everywhere or (as a per-system map) on some systems only.
   */
  lastSeq?: number | Partial<Record<string, number>>;
  /**
   * Model a row from the one-time sqlite seed: a point range at `commitSeq`
   * flagged `seeded`, which records a content change, not presence (the
   * compact DB had no history). `lastSeq` is ignored.
   */
  seeded?: boolean;
  broken?: boolean;
}

export interface FixturePackage {
  name: string;
  versions: FixtureVersion[];
  summary?: string;
  homepage?: string;
  license?: string;
  /** `meta.mainProgram`; defaults to the package name. */
  program?: string;
}

export const SYSTEMS = ["aarch64-darwin", "aarch64-linux", "x86_64-darwin", "x86_64-linux"];

/** Seeds `commits` with seq 1..n, one day apart starting 2026-01-01. */
export async function seedCommits(db: SearchDb, n = 1): Promise<void> {
  await db.insert(commits).values(
    Array.from({ length: n }, (_, i) => ({
      seq: i + 1,
      hash: (i + 1).toString(16).padStart(40, "0"),
      committedAt: new Date(Date.UTC(2026, 0, 1 + i)),
    })),
  );
}

/**
 * Records which commits were imported for each system: every seq from 1 to
 * the given head, as the importer does. A system whose head is below the
 * newest commit models one frozen at an older eval (x86_64-darwin).
 */
export async function seedCommitSystems(db: SearchDb, heads: Record<string, number>): Promise<void> {
  await db.insert(commitSystems).values(
    Object.entries(heads).flatMap(([system, head]) =>
      Array.from({ length: head }, (_, i) => ({ commitSeq: i + 1, system })),
    ),
  );
}

/**
 * Recounts the tables into row_counts, as the importer does when it commits.
 * The fixture helpers don't, so status tests call this once seeding is done.
 */
export async function recordRowCounts(db: SearchDb): Promise<void> {
  await db.execute(sql.raw(REFRESH_ROW_COUNTS));
}

/** Inserts one package with its versions, variants, meta and search terms. */
export async function seedPackage(db: SearchDb, fixture: FixturePackage): Promise<void> {
  const [pkg] = await db.insert(packages).values({ name: fixture.name }).returning({ id: packages.id });
  const packageId = pkg!.id;

  const summary = fixture.summary ?? `${fixture.name} summary`;
  const homepage = fixture.homepage ?? "";
  const license = fixture.license ?? "";
  const metaHash = sha256Hex(JSON.stringify({ summary, homepage, license }));
  const [metaRow] = await db
    .insert(meta)
    .values({ hash: metaHash, summary, homepage, license, platforms: SYSTEMS })
    .onConflictDoNothing()
    .returning({ id: meta.id });
  const metaId =
    metaRow?.id ?? (await db.select({ id: meta.id }).from(meta).where(eq(meta.hash, metaHash)))[0]!.id;

  const attrPaths = new Set<string>();
  for (const v of fixture.versions) {
    const semver = parseSemver(v.version);
    const [inserted] = await db
      .insert(versions)
      .values({
        packageId,
        version: v.version,
        sortKey: sortKey(v.version),
        prerelease: isPrerelease(v.version),
        semverMajor: semver?.major ?? null,
        semverMinor: semver?.minor ?? null,
        semverPatch: semver?.patch ?? null,
        semverPre: semver?.prerelease ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: versions.id });
    const ver =
      inserted ??
      (
        await db
          .select({ id: versions.id })
          .from(versions)
          .where(and(eq(versions.packageId, packageId), eq(versions.version, v.version)))
      )[0];

    const attrPath = v.attrPath ?? fixture.name;
    attrPaths.add(attrPath);
    for (const system of v.systems ?? SYSTEMS) {
      const ident = `${fixture.name}-${v.version}-${system}`;
      const [variant] = await db.insert(variants).values({
        versionId: ver!.id,
        system,
        attrPath,
        metaId,
        commitSeq: v.commitSeq ?? 1,
        storeHash: sha256Hex(ident).slice(0, 32),
        storeName: fixture.name,
        metaName: `${fixture.name}-${v.version}`,
        program: fixture.program ?? fixture.name,
        broken: v.broken ?? false,
        outputs: [{ name: "out", path: `/nix/store/${sha256Hex(ident).slice(0, 32)}-${ident}`, default: true }],
        contentHash: sha256Hex(ident),
      }).returning({ id: variants.id });
      const commitSeq = v.commitSeq ?? 1;
      const lastSeq = typeof v.lastSeq === "object" ? v.lastSeq[system] : v.lastSeq;
      await db.insert(variantRanges).values({
        variantId: variant!.id,
        firstSeq: commitSeq,
        lastSeq: v.seeded ? commitSeq : (lastSeq ?? null),
        seeded: v.seeded ?? false,
      });
    }
  }

  await db.insert(searchTerms).values(
    [...attrPaths].map((attrPath) => ({
      packageId,
      name: fixture.name,
      attrPath,
      topLevelAttr: attrPath.includes(".") ? null : attrPath,
    })),
  );
}
