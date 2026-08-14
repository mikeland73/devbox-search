/**
 * One-time seed: the public compact sqlite DB -> Postgres.
 *
 * Run locally (not in CI): it streams 3.8M rows and uploads ~1.5 GB, and
 * wants the Neon compute temporarily bumped.
 *
 *   DATABASE_URL_DIRECT=postgres://... node --experimental-strip-types \
 *     src/seed.ts ~/devbox-search-data/nixpkgs-compact-2026-08-13.db
 *
 * Shape of the work. Rows are streamed straight from a sqlite cursor into
 * COPY, so nothing but the id dictionaries is held in memory. That costs
 * several passes over the local sqlite file, which is much cheaper than
 * buffering ~4 GB of row arrays:
 *
 *   1. commits     — seq 1..N by unix_time, so seq order == time order.
 *   2. packages    — one row per lower(name), preserving sqlite's NOCASE
 *                    grouping (354 names have case variants).
 *   3. versions    — DISTINCT name+version, with the new sort_key. This pass
 *                    also collects the sort-key-vs-version_sort ordering diff
 *                    and any prerelease-flag divergence.
 *   4. meta        — full scan, COPYing each content hash the first time it
 *                    is seen (this is the dedup that shrinks the DB).
 *   5. variants    — full scan, resolving version/meta ids from the maps.
 *   6. variant_ranges and search_terms are derived server-side with
 *      INSERT ... SELECT: no egress, no client memory.
 *
 * variant_ranges are seeded as *point* ranges (seeded = true): the compact DB
 * carries no history, so hash-coverage features are only authoritative from
 * migration day forward. That is an accepted limitation of the migration.
 *
 * Validation printed and written to a report file:
 *   - row counts vs the sqlite source (hard assertions)
 *   - every ordering divergence between the new sort_key and sqlite's
 *     version_sort, enumerated (sanctioned change #4 makes these expected;
 *     they are reviewed, not gated)
 *   - prerelease-flag divergences vs the sqlite column (expected: none)
 */

import { createWriteStream } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createImportClient } from "@devbox-search/db";
import { copyRows, type CopyValue } from "./copy.js";
import {
  canonicalSpelling,
  compareVersionOrder,
  packageKey,
  toMetaRow,
  toVariantRow,
  toVersionRow,
  versionKey,
  type LatestJson,
  type SqlitePkgRow,
} from "./seedTransform.js";

export interface SeedReport {
  commits: number;
  commitSystems: number;
  packages: number;
  versions: number;
  meta: number;
  variants: number;
  ranges: number;
  searchTerms: number;
  sqliteCounts: { pkg: number; nameVersion: number; names: number; commits: number };
  orderDivergences: Array<{ package: string; a: string; b: string }>;
  prereleaseDivergences: Array<{ package: string; version: string; old: boolean; new: boolean }>;
}

export interface SeedOptions {
  sqlitePath: string;
  connectionString?: string;
  /** Stop after this many pkg rows per scan (smoke-testing against staging). */
  limit?: number;
  onProgress?: (message: string) => void;
}

interface RawPkgRow {
  name: string;
  version: string;
  version_sort: number;
  prerelease: number;
  system: string;
  attr_path: string;
  json: string;
}

export async function seed(options: SeedOptions): Promise<SeedReport> {
  const log = options.onProgress ?? ((m: string) => console.log(m));
  const sqlite = new Database(options.sqlitePath, { readonly: true, fileMustExist: true });
  const limit = options.limit === undefined ? "" : ` LIMIT ${options.limit}`;

  const { pool } = createImportClient(options.connectionString);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    // The seed is the only writer, but take the same lock the importer uses
    // so a stray import can't interleave.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('devbox-search-index'))");

    // ---------------------------------------------------------------------
    // 1. commits + commit_systems
    // ---------------------------------------------------------------------
    const commitRows = sqlite
      .prepare<[], { hash: string; unix_time: number }>(
        `SELECT hash, unix_time FROM nixpkgs_commit ORDER BY unix_time, id`,
      )
      .all();
    const seqByHash = new Map<string, number>();
    for (const [i, c] of commitRows.entries()) seqByHash.set(c.hash, i + 1);

    const commits = await copyRows(
      client,
      "commits",
      ["seq", "hash", "committed_at"],
      commitRows.map((c, i) => [i + 1, c.hash, new Date(c.unix_time * 1000).toISOString()]),
    );
    log(`commits: ${commits}`);

    // Every seeded commit counts as evaluated for the systems the compact DB
    // contains, so the importer's range-close logic has a baseline.
    const systems = sqlite
      .prepare<[], { system: string }>(`SELECT DISTINCT system FROM pkg WHERE system IS NOT NULL ORDER BY system`)
      .all()
      .map((r) => r.system);
    const commitSystems = await copyRows(
      client,
      "commit_systems",
      ["commit_seq", "system"],
      commitRows.flatMap((_, i) => systems.map((s) => [i + 1, s] as CopyValue[])),
    );
    log(`commit_systems: ${commitSystems} (${systems.length} systems)`);

    // ---------------------------------------------------------------------
    // 2. packages
    // ---------------------------------------------------------------------
    // `pkg.name` is COLLATE NOCASE in sqlite, so names differing only in case
    // are ONE package there. Group by lower(name) to preserve that, and store
    // the dominant spelling (see canonicalSpelling).
    const packageIds = new Map<string, number>();
    const packages = await copyRows(
      client,
      "packages",
      ["id", "name"],
      (function* () {
        const stmt = sqlite.prepare<[], { name: string; n: number }>(
          `SELECT name, count(*) AS n FROM pkg
           GROUP BY name COLLATE BINARY ORDER BY name COLLATE BINARY${limit}`,
        );
        // Buffer the spellings of one lower(name) group at a time. The
        // BINARY ordering keeps case variants of a name adjacent only if
        // they share a prefix, so accumulate into a map instead.
        const spellings = new Map<string, Array<{ name: string; count: number }>>();
        for (const row of stmt.iterate()) {
          const key = packageKey(row.name);
          const list = spellings.get(key);
          if (list === undefined) spellings.set(key, [{ name: row.name, count: row.n }]);
          else list.push({ name: row.name, count: row.n });
        }
        for (const [key, variants] of spellings) {
          const id = packageIds.size + 1;
          packageIds.set(key, id);
          yield [id, canonicalSpelling(variants)] as CopyValue[];
        }
      })(),
    );
    log(`packages: ${packages}`);

    // ---------------------------------------------------------------------
    // 3. versions (+ ordering and prerelease validation)
    // ---------------------------------------------------------------------
    const versionIds = new Map<string, number>();
    const orderDivergences: SeedReport["orderDivergences"] = [];
    const prereleaseDivergences: SeedReport["prereleaseDivergences"] = [];

    const versions = await copyRows(
      client,
      "versions",
      [
        "id",
        "package_id",
        "version",
        "sort_key",
        "prerelease",
        "semver_major",
        "semver_minor",
        "semver_patch",
        "semver_pre",
      ],
      (function* () {
        // Rows arrive grouped by name so the per-package ordering diff can be
        // computed with only one package buffered at a time.
        const stmt = sqlite.prepare<[], {
          name: string;
          version: string;
          version_sort: number;
          prerelease: number;
        }>(
          `SELECT name, version, max(version_sort) AS version_sort, max(prerelease) AS prerelease
           FROM pkg GROUP BY name, version ORDER BY name, version${limit}`,
        );

        let currentPackage = "";
        let buffered: Array<{ version: string; versionSort: number }> = [];
        const flush = () => {
          if (buffered.length < 2) return;
          for (const d of compareVersionOrder(buffered)) {
            orderDivergences.push({ package: currentPackage, a: d.a, b: d.b });
          }
        };

        for (const row of stmt.iterate()) {
          if (packageKey(row.name) !== currentPackage) {
            flush();
            currentPackage = packageKey(row.name);
            buffered = [];
          }
          buffered.push({ version: row.version, versionSort: row.version_sort });

          const packageId = packageIds.get(packageKey(row.name));
          if (packageId === undefined) {
            throw new Error(`version ${row.name}@${row.version} has no package row`);
          }
          const id = versionIds.size + 1;
          versionIds.set(versionKey(row.name, row.version), id);

          const v = toVersionRow(row.name, row.version);
          if (v.prerelease !== (row.prerelease === 1)) {
            prereleaseDivergences.push({
              package: row.name,
              version: row.version,
              old: row.prerelease === 1,
              new: v.prerelease,
            });
          }
          yield [
            id,
            packageId,
            v.version,
            v.sortKey,
            v.prerelease,
            v.semverMajor,
            v.semverMinor,
            v.semverPatch,
            v.semverPre,
          ] as CopyValue[];
        }
        flush();
      })(),
    );
    log(`versions: ${versions} (order divergences so far: ${orderDivergences.length})`);

    // ---------------------------------------------------------------------
    // 4. meta (content-addressed dedup)
    // ---------------------------------------------------------------------
    const metaIds = new Map<string, number>();
    const meta = await copyRows(
      client,
      "meta",
      ["id", "hash", "summary", "description", "homepage", "license", "platforms"],
      (function* () {
        let scanned = 0;
        for (const row of scanPkgRows(sqlite, limit)) {
          if (++scanned % 500_000 === 0) log(`  meta scan: ${scanned} rows, ${metaIds.size} unique`);
          const m = toMetaRow(row);
          if (metaIds.has(m.hash)) continue;
          const id = metaIds.size + 1;
          metaIds.set(m.hash, id);
          yield [id, m.hash, m.summary, m.description, m.homepage, m.license, m.platforms] as CopyValue[];
        }
      })(),
    );
    log(`meta: ${meta}`);

    // ---------------------------------------------------------------------
    // 5. variants
    // ---------------------------------------------------------------------
    const variants = await copyRows(
      client,
      "variants",
      [
        "id",
        "version_id",
        "system",
        "attr_path",
        "meta_id",
        "commit_seq",
        "store_hash",
        "store_name",
        "meta_name",
        "meta_version",
        "program",
        "broken",
        "insecure",
        "outputs",
        "content_hash",
      ],
      (function* () {
        let id = 0;
        for (const row of scanPkgRows(sqlite, limit)) {
          const variant = toVariantRow(row);
          const versionId = versionIds.get(variant.versionKey);
          if (versionId === undefined) {
            throw new Error(`variant ${row.name}@${row.version} has no version row`);
          }
          const metaId = metaIds.get(variant.metaHash);
          if (metaId === undefined) {
            throw new Error(`variant ${row.name}@${row.version} has no meta row for ${variant.metaHash}`);
          }
          // The compact DB should never reference an unknown commit; fail
          // loudly rather than silently dropping data.
          const commitSeq = seqByHash.get(variant.commitHash);
          if (commitSeq === undefined) {
            throw new Error(
              `variant ${row.name}@${row.version} (${row.system}, ${row.attrPath}) references unknown commit ${variant.commitHash || "<empty>"}`,
            );
          }
          if (++id % 500_000 === 0) log(`  variants: ${id}`);
          yield [
            id,
            versionId,
            variant.system,
            variant.attrPath,
            metaId,
            commitSeq,
            variant.storeHash,
            variant.storeName,
            variant.metaName,
            variant.metaVersion,
            variant.program,
            variant.broken,
            variant.insecure,
            variant.outputs,
            variant.contentHash,
          ] as CopyValue[];
        }
      })(),
    );
    log(`variants: ${variants}`);

    // ---------------------------------------------------------------------
    // 6. Derived tables, computed server-side (no egress, no client memory)
    // ---------------------------------------------------------------------
    const rangeResult = await client.query(
      `INSERT INTO variant_ranges (variant_id, first_seq, last_seq, seeded)
       SELECT id, commit_seq, commit_seq, true FROM variants`,
    );
    const ranges = rangeResult.rowCount ?? 0;
    log(`variant_ranges: ${ranges} (point ranges, seeded)`);

    const termResult = await client.query(
      `INSERT INTO search_terms (package_id, name, attr_path, top_level_attr)
       SELECT DISTINCT p.id, p.name, v.attr_path,
              CASE WHEN position('.' in v.attr_path) = 0 THEN v.attr_path END
       FROM variants v
       JOIN versions ver ON ver.id = v.version_id
       JOIN packages p ON p.id = ver.package_id`,
    );
    const searchTerms = termResult.rowCount ?? 0;
    log(`search_terms: ${searchTerms}`);

    // Identity sequences must continue past the explicitly-assigned ids.
    for (const table of ["packages", "versions", "meta", "variants", "search_terms"]) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), coalesce((SELECT max(id) FROM ${table}), 1))`,
        [table],
      );
    }

    await client.query("COMMIT");

    const sqliteCounts = {
      pkg: sqlite.prepare<[], { n: number }>(`SELECT count(*) AS n FROM pkg`).get()!.n,
      nameVersion: sqlite
        .prepare<[], { n: number }>(`SELECT count(*) AS n FROM (SELECT DISTINCT name, version FROM pkg)`)
        .get()!.n,
      // count(DISTINCT name) uses the column's NOCASE collation, i.e. it is
      // already a count of lower(name) groups - which is what we seed.
      names: sqlite.prepare<[], { n: number }>(`SELECT count(DISTINCT name) AS n FROM pkg`).get()!.n,
      commits: sqlite.prepare<[], { n: number }>(`SELECT count(*) AS n FROM nixpkgs_commit`).get()!.n,
    };

    return {
      commits,
      commitSystems,
      packages,
      versions,
      meta,
      variants,
      ranges,
      searchTerms,
      sqliteCounts,
      orderDivergences,
      prereleaseDivergences,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

/** Streams decoded pkg rows from the compact DB. */
function* scanPkgRows(sqlite: Database.Database, limit: string): Generator<SqlitePkgRow> {
  const stmt = sqlite.prepare<[], RawPkgRow>(
    `SELECT name, version, version_sort, prerelease, system, attr_path, json(latest_json) AS json
     FROM pkg ORDER BY name, version${limit}`,
  );
  for (const raw of stmt.iterate()) {
    yield {
      name: raw.name,
      version: raw.version,
      versionSort: raw.version_sort,
      prerelease: raw.prerelease,
      system: raw.system,
      attrPath: raw.attr_path,
      json: JSON.parse(raw.json) as LatestJson,
    };
  }
}

/** Row-count assertions. Returns a list of human-readable failures. */
export function assertCounts(report: SeedReport): string[] {
  const failures: string[] = [];
  const check = (label: string, got: number, want: number) => {
    if (got !== want) failures.push(`${label}: got ${got}, want ${want}`);
  };
  check("variants vs sqlite pkg rows", report.variants, report.sqliteCounts.pkg);
  check("versions vs sqlite name+version", report.versions, report.sqliteCounts.nameVersion);
  check("packages vs sqlite names", report.packages, report.sqliteCounts.names);
  check("commits vs sqlite commits", report.commits, report.sqliteCounts.commits);
  check("variant_ranges vs variants", report.ranges, report.variants);
  return failures;
}

/** Writes the human-reviewable validation report. */
export async function writeReport(report: SeedReport, path: string): Promise<void> {
  const out = createWriteStream(path);
  const write = (s: string) => out.write(s + "\n");

  write("# Seed validation report\n");
  write("## Row counts");
  write(`sqlite pkg rows:      ${report.sqliteCounts.pkg}`);
  write(`sqlite name+version:  ${report.sqliteCounts.nameVersion}`);
  write(`sqlite names:         ${report.sqliteCounts.names}`);
  write(`sqlite commits:       ${report.sqliteCounts.commits}`);
  write("");
  write(`pg variants:          ${report.variants}   (expect == sqlite pkg rows)`);
  write(`pg versions:          ${report.versions}   (expect == sqlite name+version)`);
  write(`pg packages:          ${report.packages}   (expect == sqlite names)`);
  write(`pg commits:           ${report.commits}   (expect == sqlite commits)`);
  write(
    `pg meta:              ${report.meta}   (dedup ${(report.variants / Math.max(report.meta, 1)).toFixed(1)}x vs variants)`,
  );
  write(`pg variant_ranges:    ${report.ranges}   (point ranges, seeded=true)`);
  write(`pg search_terms:      ${report.searchTerms}`);

  const failures = assertCounts(report);
  write(`\nCount assertions: ${failures.length === 0 ? "PASS" : "FAIL"}`);
  for (const f of failures) write(`  ${f}`);

  write(`\n## Sort-key vs sqlite version_sort divergences (${report.orderDivergences.length})`);
  write("Expected: sanctioned change #4 replaced a non-transitive comparator,");
  write("so some pairs legitimately flip. Every pair is listed for review.");
  write("This is a report, not a gate.\n");
  for (const d of report.orderDivergences) {
    write(`${d.package}: new says ${d.a} < ${d.b}; sqlite version_sort said the reverse`);
  }

  write(`\n## Prerelease flag divergences (${report.prereleaseDivergences.length})`);
  write("Expected: 0 — prerelease() is a faithful port of the Go function.\n");
  for (const d of report.prereleaseDivergences) {
    write(`${d.package}@${d.version}: sqlite=${d.old} new=${d.new}`);
  }
  await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
}

if (process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sqlitePath = process.argv[2];
  if (sqlitePath === undefined || sqlitePath.startsWith("--")) {
    console.error("usage: seed.ts <compact.db> [--limit N]");
    process.exit(2);
  }
  const limitArg = process.argv.indexOf("--limit");
  const report = await seed({
    sqlitePath,
    ...(limitArg !== -1 ? { limit: Number(process.argv[limitArg + 1]) } : {}),
  });
  await writeReport(report, "seed-report.txt");
  console.log(`\nreport written to seed-report.txt`);
  console.log(`order divergences: ${report.orderDivergences.length}`);
  console.log(`prerelease divergences: ${report.prereleaseDivergences.length}`);

  // --limit produces a partial DB, so counts intentionally won't match.
  const failures = limitArg !== -1 ? [] : assertCounts(report);
  for (const f of failures) console.error(`COUNT MISMATCH: ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
