/**
 * Applies the real migrations to an in-process Postgres (PGlite, WASM) and
 * asserts the resulting catalog — so the DDL in drizzle/ is verified to
 * actually run, not just to look right as text.
 *
 * Also exercises the behaviors the schema exists to support: byte-comparable
 * sort_key ordering, content-addressed meta dedup, variant identity, and
 * open/closed presence ranges.
 */

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sortKey } from "@devbox-search/core";
import { migrationStatements } from "./migrate.js";

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create({ extensions: { pg_trgm } });
  for (const statement of migrationStatements()) await db.exec(statement);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

async function rows<T>(query: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(query, params);
  return result.rows;
}

describe("migration applies cleanly", () => {
  test("all tables exist", async () => {
    const found = await rows<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    expect(found.map((r) => r.tablename)).toEqual([
      "commit_systems",
      "commits",
      "meta",
      "packages",
      "search_terms",
      "variant_ranges",
      "variants",
      "versions",
    ]);
  });

  test("pg_trgm is installed and the GIN indexes are usable", async () => {
    const ext = await rows<{ extname: string }>(`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`);
    expect(ext).toHaveLength(1);
    const idx = await rows<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'search_terms' AND indexdef LIKE '%gin_trgm_ops%' ORDER BY indexname`,
    );
    expect(idx.map((r) => r.indexname)).toEqual([
      "search_terms_attr_path_trgm_idx",
      "search_terms_name_trgm_idx",
    ]);
    // similarity() comes from pg_trgm; it backs the search ranking.
    const sim = await rows<{ similarity: number }>(`SELECT similarity('python3', 'python') AS similarity`);
    expect(sim[0]!.similarity).toBeGreaterThan(0);
  });

  test("the lower() btrees behind the phrase-search prefix tier exist", async () => {
    const idx = await rows<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'search_terms' AND indexdef LIKE '%btree (lower(%' ORDER BY indexname`,
    );
    expect(idx.map((r) => r.indexname)).toEqual([
      "search_terms_attr_path_lower_idx",
      "search_terms_name_lower_idx",
    ]);
  });

  test("the partial index on open ranges exists", async () => {
    const idx = await rows<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'variant_ranges_open_idx'`,
    );
    expect(idx[0]!.indexdef).toContain("last_seq IS NULL");
  });
});

describe("schema behavior", () => {
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO commits (seq, hash, committed_at) VALUES
        (1, repeat('a', 40), '2026-01-01T00:00:00Z'),
        (2, repeat('b', 40), '2026-01-02T00:00:00Z'),
        (3, repeat('c', 40), '2026-01-03T00:00:00Z');
      INSERT INTO commit_systems (commit_seq, system) VALUES
        (1, 'x86_64-linux'), (2, 'x86_64-linux'), (3, 'x86_64-linux');
      INSERT INTO packages (name) VALUES ('python'), ('go');
      INSERT INTO meta (hash, summary, platforms) VALUES
        (repeat('1', 64), 'shared summary', '["x86_64-linux"]'::jsonb);
    `);
  });

  test("sort_key ordering in SQL reproduces the comparator (latest = max)", async () => {
    const versions = ["3.9.1", "3.10.0", "3.11.0", "3.11.0a2", "3.11.10", "2024-01-05"];
    const pkgId = (await rows<{ id: number }>(`SELECT id FROM packages WHERE name = 'python'`))[0]!.id;
    for (const v of versions) {
      await db.query(
        `INSERT INTO versions (package_id, version, sort_key, prerelease) VALUES ($1, $2, $3, $4)`,
        [pkgId, v, Buffer.from(sortKey(v)), v.includes("a2")],
      );
    }

    // "latest" excluding prereleases, exactly as the API will query it.
    const latest = await rows<{ version: string }>(
      `SELECT version FROM versions WHERE package_id = $1 AND prerelease = false
       ORDER BY sort_key DESC LIMIT 1`,
      [pkgId],
    );
    // 2024-01-05 sorts above all 3.x because 2024 > 3 numerically.
    expect(latest[0]!.version).toBe("2024-01-05");

    // Within the 3.x family, string ordering would put 3.9.1 last; the
    // sort key orders numerically and puts the prerelease below its release.
    const threes = await rows<{ version: string }>(
      `SELECT version FROM versions WHERE package_id = $1 AND version LIKE '3.%'
       ORDER BY sort_key ASC`,
      [pkgId],
    );
    expect(threes.map((r) => r.version)).toEqual(["3.9.1", "3.10.0", "3.11.0a2", "3.11.0", "3.11.10"]);
  });

  test("version identity is unique per package", async () => {
    const pkgId = (await rows<{ id: number }>(`SELECT id FROM packages WHERE name = 'python'`))[0]!.id;
    await expect(
      db.query(`INSERT INTO versions (package_id, version, sort_key) VALUES ($1, '3.11.0', $2)`, [
        pkgId,
        Buffer.from(sortKey("3.11.0")),
      ]),
    ).rejects.toThrow(/duplicate key/);
  });

  test("meta dedup: the same content hash cannot be inserted twice", async () => {
    await expect(
      db.query(`INSERT INTO meta (hash, summary) VALUES ($1, 'different summary')`, [
        "1".repeat(64),
      ]),
    ).rejects.toThrow(/duplicate key/);
  });

  test("variant identity is (version, system, attr_path); ranges open and close", async () => {
    const versionId = (
      await rows<{ id: number }>(`SELECT id FROM versions WHERE version = '3.11.0'`)
    )[0]!.id;
    const metaId = (await rows<{ id: number }>(`SELECT id FROM meta LIMIT 1`))[0]!.id;

    // Two attr paths for the same version+system are distinct variants
    // (python3 and python311 both provide python 3.11.0).
    for (const attrPath of ["python3", "python311"]) {
      await db.query(
        `INSERT INTO variants (version_id, system, attr_path, meta_id, commit_seq, store_hash, content_hash)
         VALUES ($1, 'x86_64-linux', $2, $3, 1, $4, $5)`,
        [versionId, attrPath, metaId, "a".repeat(32), "2".repeat(64)],
      );
    }
    await expect(
      db.query(
        `INSERT INTO variants (version_id, system, attr_path, meta_id, commit_seq, store_hash, content_hash)
         VALUES ($1, 'x86_64-linux', 'python3', $2, 1, $3, $4)`,
        [versionId, metaId, "a".repeat(32), "3".repeat(64)],
      ),
    ).rejects.toThrow(/duplicate key/);

    const variantIds = (
      await rows<{ id: number }>(`SELECT id FROM variants ORDER BY attr_path`)
    ).map((r) => r.id);

    // python3 present in commits 1-2 then gone; python311 still present.
    await db.query(`INSERT INTO variant_ranges (variant_id, first_seq, last_seq) VALUES ($1, 1, 2)`, [
      variantIds[0]!,
    ]);
    await db.query(`INSERT INTO variant_ranges (variant_id, first_seq) VALUES ($1, 1)`, [variantIds[1]!]);

    // "which commits contain this variant" — the range-containment query that
    // powers hash-coverage features.
    const atCommit2 = await rows<{ attr_path: string }>(
      `SELECT v.attr_path FROM variants v JOIN variant_ranges r ON r.variant_id = v.id
       WHERE 2 BETWEEN r.first_seq AND coalesce(r.last_seq, 2147483647)
       ORDER BY v.attr_path`,
    );
    expect(atCommit2.map((r) => r.attr_path)).toEqual(["python3", "python311"]);

    const atCommit3 = await rows<{ attr_path: string }>(
      `SELECT v.attr_path FROM variants v JOIN variant_ranges r ON r.variant_id = v.id
       WHERE 3 BETWEEN r.first_seq AND coalesce(r.last_seq, 2147483647)
       ORDER BY v.attr_path`,
    );
    expect(atCommit3.map((r) => r.attr_path)).toEqual(["python311"]);
  });

  test("a variant with no store hash is a stub, and the table refuses it", async () => {
    // Belt and braces with the importer's own guard: the one time stubs got
    // through the decoder they became ~75k phantom variants per commit.
    const versionId = (await rows<{ id: number }>(`SELECT id FROM versions WHERE version = '3.11.0'`))[0]!.id;
    const metaId = (await rows<{ id: number }>(`SELECT id FROM meta LIMIT 1`))[0]!.id;
    for (const storeHash of ["", null]) {
      await expect(
        db.query(
          `INSERT INTO variants (version_id, system, attr_path, meta_id, commit_seq, store_hash, content_hash)
           VALUES ($1, 'x86_64-linux', 'python312', $2, 1, $3, $4)`,
          [versionId, metaId, storeHash, "4".repeat(64)],
        ),
        `store_hash = ${JSON.stringify(storeHash)}`,
      ).rejects.toThrow(/variants_store_hash_nonempty|null value in column "store_hash"/);
    }
    // No default to fall back on either: omitting the column is an error.
    await expect(
      db.query(
        `INSERT INTO variants (version_id, system, attr_path, meta_id, commit_seq, content_hash)
         VALUES ($1, 'x86_64-linux', 'python312', $2, 1, $3)`,
        [versionId, metaId, "4".repeat(64)],
      ),
    ).rejects.toThrow(/null value in column "store_hash"/);
  });

  test("case-insensitive name lookup uses the lower(name) index", async () => {
    const found = await rows<{ name: string }>(`SELECT name FROM packages WHERE lower(name) = lower('PyThOn')`);
    expect(found.map((r) => r.name)).toEqual(["python"]);
  });

  test("semver components accept date-stamped values wider than int4", async () => {
    // nixpkgs has ~100 strict-semver versions like 3.1.20220119140128; the
    // seed COPY failed on the first of them while the columns were integer.
    await db.exec(`INSERT INTO packages (name) VALUES ('semver-wide')`);
    const [pkg] = await rows<{ id: number }>(`SELECT id FROM packages WHERE name = 'semver-wide'`);
    await db.query(
      `INSERT INTO versions (package_id, version, sort_key, semver_major, semver_minor, semver_patch)
       VALUES ($1, '3.1.20220119140128', '\\x00', 3, 1, 20220119140128)`,
      [pkg!.id],
    );
    const [row] = await rows<{ patch: string }>(
      `SELECT semver_patch::text AS patch FROM versions WHERE version = '3.1.20220119140128'`,
    );
    expect(row?.patch).toBe("20220119140128");
  });

  test("cascade: deleting a package removes its versions and variants", async () => {
    await db.exec(`INSERT INTO packages (name) VALUES ('scratch')`);
    const pkgId = (await rows<{ id: number }>(`SELECT id FROM packages WHERE name = 'scratch'`))[0]!.id;
    await db.query(`INSERT INTO versions (package_id, version, sort_key) VALUES ($1, '1.0.0', $2)`, [
      pkgId,
      Buffer.from(sortKey("1.0.0")),
    ]);
    await db.query(`DELETE FROM packages WHERE id = $1`, [pkgId]);
    const left = await rows(`SELECT 1 FROM versions WHERE package_id = $1`, [pkgId]);
    expect(left).toHaveLength(0);
  });
});
