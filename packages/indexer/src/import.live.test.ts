/**
 * End-to-end import tests against an in-process Postgres (PGlite).
 *
 * The import SQL is the riskiest code in the migration: it is set-based,
 * stateful across days, and a mistake in the range logic silently corrupts
 * history rather than failing loudly. These tests drive the real SQL through
 * a multi-day scenario.
 *
 * PGlite has no wire protocol, so the pg-based COPY path can't be exercised
 * here; the SQL statements are executed through the same helper the importer
 * uses, with COPY replaced by multi-row INSERT. copy.test.ts covers the COPY
 * encoding itself.
 */

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { canonicalName, contentHash, decodeEvalJson, metaHash } from "@devbox-search/core";
import { packageKey, toVersionRow } from "./seedTransform.js";

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../db/drizzle/0000_init.sql",
);

let db: PGlite;

beforeEach(async () => {
  db = await PGlite.create({ extensions: { pg_trgm } });
  for (const statement of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed !== "") await db.exec(trimmed);
  }
}, 120_000);

afterEach(async () => {
  await db?.close();
});

/** A minimal nix-env eval fixture: attrPath -> version. */
function evalJson(entries: Record<string, { version: string; broken?: boolean; summary?: string }>) {
  const out: Record<string, unknown> = {};
  for (const [attrPath, spec] of Object.entries(entries)) {
    out[attrPath] = {
      name: `${attrPath}-${spec.version}`,
      pname: attrPath,
      version: spec.version,
      system: "x86_64-linux",
      outputName: "out",
      outputs: { out: `/nix/store/${"a".repeat(32)}-${attrPath}-${spec.version}` },
      meta: {
        description: spec.summary ?? "a package",
        broken: spec.broken ?? false,
        platforms: ["x86_64-linux"],
      },
    };
  }
  return out;
}

/**
 * Runs the importer's SQL against PGlite. This mirrors import.ts step for
 * step; COPY into the temp tables becomes INSERT since PGlite has no COPY
 * FROM STDIN over a driver connection.
 */
async function runImport(json: unknown, commitHash: string, committedAt: Date, system: string) {
  const decoded = decodeEvalJson(json, commitHash, committedAt);
  const rows = decoded.packages
    .map((pkg) => ({ ...pkg, system }))
    .map((pkg) => ({
      pkg,
      name: canonicalName(pkg.attrPath),
      version: pkg.storeVersion,
      metaHash: metaHash(pkg),
      contentHash: contentHash(pkg),
    }))
    .filter((r) => r.version !== "");

  await db.exec("BEGIN");

  const already = await db.query<{ seq: number }>(
    `SELECT c.seq FROM commits c JOIN commit_systems cs ON cs.commit_seq = c.seq AND cs.system = $2
     WHERE c.hash = $1`,
    [commitHash, system],
  );
  if (already.rows.length > 0) {
    await db.exec("ROLLBACK");
    return { skipped: true, commitSeq: already.rows[0]!.seq, changed: 0, opened: 0, closed: 0 };
  }

  const head = await db.query<{ seq: number; committed_at: Date }>(
    `SELECT seq, committed_at FROM commits ORDER BY seq DESC LIMIT 1`,
  );
  const known = await db.query<{ seq: number }>(`SELECT seq FROM commits WHERE hash = $1`, [commitHash]);
  let commitSeq: number;
  if (known.rows.length > 0) {
    commitSeq = known.rows[0]!.seq;
  } else {
    const headRow = head.rows[0];
    if (headRow !== undefined && committedAt <= new Date(headRow.committed_at)) {
      await db.exec("ROLLBACK");
      throw new Error("refusing commit not newer than DB head");
    }
    commitSeq = (headRow?.seq ?? 0) + 1;
    await db.query(`INSERT INTO commits (seq, hash, committed_at) VALUES ($1, $2, $3)`, [
      commitSeq,
      commitHash,
      committedAt.toISOString(),
    ]);
  }

  const prev = await db.query<{ seq: number }>(
    `SELECT commit_seq AS seq FROM commit_systems WHERE system = $1 AND commit_seq < $2
     ORDER BY commit_seq DESC LIMIT 1`,
    [system, commitSeq],
  );
  const prevSeq = prev.rows[0]?.seq ?? null;

  await db.exec(`
    CREATE TEMP TABLE stage_keys (
      name text NOT NULL, name_key text NOT NULL, version text NOT NULL,
      attr_path text NOT NULL, meta_hash char(64) NOT NULL, content_hash char(64) NOT NULL
    ) ON COMMIT DROP
  `);
  for (const r of rows) {
    await db.query(
      `INSERT INTO stage_keys (name, name_key, version, attr_path, meta_hash, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [r.name, packageKey(r.name), r.version, r.pkg.attrPath, r.metaHash, r.contentHash],
    );
  }

  await db.exec(`
    INSERT INTO packages (name)
    SELECT DISTINCT ON (s.name_key) s.name FROM stage_keys s
    WHERE NOT EXISTS (SELECT 1 FROM packages p WHERE lower(p.name) = s.name_key)
    ORDER BY s.name_key, s.name
    ON CONFLICT DO NOTHING
  `);

  const missingVersions = await db.query<{ name_key: string; version: string }>(`
    SELECT DISTINCT s.name_key, s.version FROM stage_keys s
    JOIN packages p ON lower(p.name) = s.name_key
    WHERE NOT EXISTS (SELECT 1 FROM versions v WHERE v.package_id = p.id AND v.version = s.version)
  `);
  for (const r of missingVersions.rows) {
    const v = toVersionRow(r.name_key, r.version);
    await db.query(
      `INSERT INTO versions (package_id, version, sort_key, prerelease, semver_major, semver_minor, semver_patch, semver_pre)
       SELECT p.id, $2, $3, $4, $5, $6, $7, $8 FROM packages p WHERE lower(p.name) = $1
       ON CONFLICT (package_id, version) DO NOTHING`,
      [
        r.name_key,
        r.version,
        Buffer.from(v.sortKey),
        v.prerelease,
        v.semverMajor,
        v.semverMinor,
        v.semverPatch,
        v.semverPre,
      ],
    );
  }

  const missingMeta = await db.query<{ meta_hash: string }>(`
    SELECT DISTINCT s.meta_hash FROM stage_keys s
    WHERE NOT EXISTS (SELECT 1 FROM meta m WHERE m.hash = s.meta_hash)
  `);
  const wantedMeta = new Set(missingMeta.rows.map((r) => r.meta_hash));
  const seenMeta = new Set<string>();
  for (const r of rows) {
    if (!wantedMeta.has(r.metaHash) || seenMeta.has(r.metaHash)) continue;
    seenMeta.add(r.metaHash);
    await db.query(
      `INSERT INTO meta (hash, summary, description, homepage, license, platforms)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (hash) DO NOTHING`,
      [r.metaHash, r.pkg.summary, r.pkg.description, r.pkg.homepage, r.pkg.license, JSON.stringify(r.pkg.platforms)],
    );
  }

  const changed = await db.query<{ name_key: string; version: string; attr_path: string }>(
    `
    SELECT s.name_key, s.version, s.attr_path FROM stage_keys s
    JOIN packages p ON lower(p.name) = s.name_key
    JOIN versions v ON v.package_id = p.id AND v.version = s.version
    LEFT JOIN variants va ON va.version_id = v.id AND va.system = $1 AND va.attr_path = s.attr_path
    WHERE va.id IS NULL OR va.content_hash <> s.content_hash
  `,
    [system],
  );

  const wantedVariants = new Set(changed.rows.map((r) => `${r.name_key}\t${r.version}\t${r.attr_path}`));
  for (const r of rows) {
    if (!wantedVariants.has(`${packageKey(r.name)}\t${r.version}\t${r.pkg.attrPath}`)) continue;
    await db.query(
      `
      INSERT INTO variants (version_id, system, attr_path, meta_id, commit_seq, store_hash,
                            store_name, meta_name, meta_version, program, broken, insecure, outputs, content_hash)
      SELECT v.id, $1, $2, m.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      FROM packages p
      JOIN versions v ON v.package_id = p.id AND v.version = $14
      JOIN meta m ON m.hash = $13
      WHERE lower(p.name) = $15
      ON CONFLICT (version_id, system, attr_path) DO UPDATE SET
        meta_id = EXCLUDED.meta_id, commit_seq = EXCLUDED.commit_seq,
        store_hash = EXCLUDED.store_hash, store_name = EXCLUDED.store_name,
        meta_name = EXCLUDED.meta_name, meta_version = EXCLUDED.meta_version,
        program = EXCLUDED.program, broken = EXCLUDED.broken, insecure = EXCLUDED.insecure,
        outputs = EXCLUDED.outputs, content_hash = EXCLUDED.content_hash
    `,
      [
        system,
        r.pkg.attrPath,
        commitSeq,
        r.pkg.storeHash,
        r.pkg.storeName,
        r.pkg.metaName,
        JSON.stringify(r.pkg.metaVersion),
        r.pkg.program,
        r.pkg.broken,
        r.pkg.insecure,
        JSON.stringify(r.pkg.outputs),
        r.contentHash,
        r.metaHash,
        r.version,
        packageKey(r.name),
      ],
    );
  }

  let closed = 0;
  if (prevSeq !== null) {
    const result = await db.query(
      `
      UPDATE variant_ranges r SET last_seq = $2
      FROM variants va
      JOIN versions v ON v.id = va.version_id
      JOIN packages p ON p.id = v.package_id
      WHERE r.variant_id = va.id AND r.last_seq IS NULL AND va.system = $1
        AND NOT EXISTS (
          SELECT 1 FROM stage_keys s
          WHERE s.name_key = lower(p.name) AND s.version = v.version AND s.attr_path = va.attr_path
        )
    `,
      [system, prevSeq],
    );
    closed = result.affectedRows ?? 0;
  }

  const opened = await db.query(
    `
    INSERT INTO variant_ranges (variant_id, first_seq, last_seq, seeded)
    SELECT va.id, $2, NULL, false
    FROM stage_keys s
    JOIN packages p ON lower(p.name) = s.name_key
    JOIN versions v ON v.package_id = p.id AND v.version = s.version
    JOIN variants va ON va.version_id = v.id AND va.system = $1 AND va.attr_path = s.attr_path
    WHERE NOT EXISTS (SELECT 1 FROM variant_ranges r WHERE r.variant_id = va.id AND r.last_seq IS NULL)
    ON CONFLICT (variant_id, first_seq) DO NOTHING
  `,
    [system, commitSeq],
  );

  await db.exec(`
    INSERT INTO search_terms (package_id, name, attr_path, top_level_attr)
    SELECT DISTINCT p.id, p.name, s.attr_path,
           CASE WHEN position('.' in s.attr_path) = 0 THEN s.attr_path END
    FROM stage_keys s JOIN packages p ON lower(p.name) = s.name_key
    ON CONFLICT (name, attr_path) DO NOTHING
  `);

  await db.query(
    `INSERT INTO commit_systems (commit_seq, system) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [commitSeq, system],
  );
  await db.exec("COMMIT");

  return {
    skipped: false,
    commitSeq,
    changed: changed.rows.length,
    opened: opened.affectedRows ?? 0,
    closed,
  };
}

const HASH = (n: number) => String(n).padStart(2, "0").repeat(20);
const DAY = (n: number) => new Date(Date.UTC(2026, 0, n));

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

describe("first import", () => {
  test("creates packages, versions, meta, variants and open ranges", async () => {
    const result = await runImport(
      evalJson({ hello: { version: "2.12.1" }, go: { version: "1.22.5" } }),
      HASH(1),
      DAY(1),
      "x86_64-linux",
    );
    expect(result.commitSeq).toBe(1);
    expect(result.changed).toBe(2);
    expect(result.opened).toBe(2);

    expect(await rows(`SELECT name FROM packages ORDER BY name`)).toEqual([
      { name: "go" },
      { name: "hello" },
    ]);
    const ranges = await rows<{ first_seq: number; last_seq: number | null }>(
      `SELECT first_seq, last_seq FROM variant_ranges`,
    );
    expect(ranges).toHaveLength(2);
    expect(ranges.every((r) => r.last_seq === null)).toBe(true);
  });
});

describe("second import with no changes", () => {
  test("writes no variants and opens no ranges", async () => {
    const json = evalJson({ hello: { version: "2.12.1" } });
    await runImport(json, HASH(1), DAY(1), "x86_64-linux");
    const second = await runImport(json, HASH(2), DAY(2), "x86_64-linux");

    // This is the property that keeps steady-state cost near zero.
    expect(second.changed).toBe(0);
    expect(second.opened).toBe(0);
    expect(second.closed).toBe(0);

    // The variant still points at the commit of its last CONTENT change.
    const [variant] = await rows<{ commit_seq: number }>(`SELECT commit_seq FROM variants`);
    expect(variant!.commit_seq).toBe(1);

    const [range] = await rows<{ first_seq: number; last_seq: number | null }>(
      `SELECT first_seq, last_seq FROM variant_ranges`,
    );
    expect(range).toEqual({ first_seq: 1, last_seq: null });
  });
});

describe("content change", () => {
  test("updates the variant and advances its commit_seq, without touching ranges", async () => {
    await runImport(evalJson({ hello: { version: "2.12.1", summary: "old" } }), HASH(1), DAY(1), "x86_64-linux");
    const second = await runImport(
      evalJson({ hello: { version: "2.12.1", summary: "new" } }),
      HASH(2),
      DAY(2),
      "x86_64-linux",
    );

    expect(second.changed).toBe(1);
    expect(second.opened).toBe(0); // the range stays open and unbroken

    const [variant] = await rows<{ commit_seq: number }>(`SELECT commit_seq FROM variants`);
    expect(variant!.commit_seq).toBe(2);
    expect(await rows(`SELECT count(*)::int AS n FROM meta`)).toEqual([{ n: 2 }]);
  });
});

describe("range lifecycle", () => {
  test("a disappearing variant closes at the PREVIOUS seq, not the current one", async () => {
    await runImport(
      evalJson({ hello: { version: "2.12.1" }, oldpkg: { version: "1.0.0" } }),
      HASH(1),
      DAY(1),
      "x86_64-linux",
    );
    await runImport(
      evalJson({ hello: { version: "2.12.1" }, oldpkg: { version: "1.0.0" } }),
      HASH(2),
      DAY(2),
      "x86_64-linux",
    );
    const third = await runImport(evalJson({ hello: { version: "2.12.1" } }), HASH(3), DAY(3), "x86_64-linux");

    expect(third.closed).toBe(1);
    const closed = await rows<{ attr_path: string; first_seq: number; last_seq: number | null }>(`
      SELECT va.attr_path, r.first_seq, r.last_seq
      FROM variant_ranges r JOIN variants va ON va.id = r.variant_id
      WHERE r.last_seq IS NOT NULL
    `);
    // Last observed at seq 2, so the interval ends there — not at seq 3,
    // where it was already gone.
    expect(closed).toEqual([{ attr_path: "oldpkg", first_seq: 1, last_seq: 2 }]);
  });

  test("a reappearing variant opens a second interval instead of reviving the first", async () => {
    const withPkg = evalJson({ hello: { version: "2.12.1" }, flaky: { version: "1.0.0" } });
    const withoutPkg = evalJson({ hello: { version: "2.12.1" } });

    await runImport(withPkg, HASH(1), DAY(1), "x86_64-linux");
    await runImport(withoutPkg, HASH(2), DAY(2), "x86_64-linux");
    await runImport(withPkg, HASH(3), DAY(3), "x86_64-linux");

    const ranges = await rows<{ first_seq: number; last_seq: number | null }>(`
      SELECT r.first_seq, r.last_seq FROM variant_ranges r
      JOIN variants va ON va.id = r.variant_id
      WHERE va.attr_path = 'flaky' ORDER BY r.first_seq
    `);
    expect(ranges).toEqual([
      { first_seq: 1, last_seq: 1 },
      { first_seq: 3, last_seq: null },
    ]);
  });

  test("closing is scoped per system: another system's ranges are untouched", async () => {
    const both = evalJson({ hello: { version: "2.12.1" }, only: { version: "1.0.0" } });
    await runImport(both, HASH(1), DAY(1), "x86_64-linux");
    await runImport(both, HASH(1), DAY(1), "aarch64-linux");
    await runImport(both, HASH(2), DAY(2), "x86_64-linux");

    // 'only' vanishes from x86_64-linux at seq 3 but is never re-evaluated
    // for aarch64-linux.
    await runImport(evalJson({ hello: { version: "2.12.1" } }), HASH(3), DAY(3), "x86_64-linux");

    const byLinux = await rows<{ system: string; last_seq: number | null }>(`
      SELECT va.system, r.last_seq FROM variant_ranges r
      JOIN variants va ON va.id = r.variant_id
      WHERE va.attr_path = 'only' ORDER BY va.system
    `);
    expect(byLinux).toEqual([
      { system: "aarch64-linux", last_seq: null }, // untouched
      { system: "x86_64-linux", last_seq: 2 },
    ]);
  });
});

describe("guards", () => {
  test("re-importing the same (commit, system) is a no-op", async () => {
    const json = evalJson({ hello: { version: "2.12.1" } });
    await runImport(json, HASH(1), DAY(1), "x86_64-linux");
    const again = await runImport(json, HASH(1), DAY(1), "x86_64-linux");

    expect(again.skipped).toBe(true);
    expect(await rows(`SELECT count(*)::int AS n FROM variants`)).toEqual([{ n: 1 }]);
    expect(await rows(`SELECT count(*)::int AS n FROM variant_ranges`)).toEqual([{ n: 1 }]);
  });

  test("a second system for the same commit reuses its seq", async () => {
    const json = evalJson({ hello: { version: "2.12.1" } });
    const first = await runImport(json, HASH(1), DAY(1), "x86_64-linux");
    const second = await runImport(json, HASH(1), DAY(1), "aarch64-linux");

    expect(second.commitSeq).toBe(first.commitSeq);
    expect(await rows(`SELECT count(*)::int AS n FROM commits`)).toEqual([{ n: 1 }]);
    expect(await rows(`SELECT count(*)::int AS n FROM commit_systems`)).toEqual([{ n: 2 }]);
  });

  test("a commit older than the head is refused", async () => {
    await runImport(evalJson({ hello: { version: "2.12.1" } }), HASH(2), DAY(5), "x86_64-linux");
    await expect(
      runImport(evalJson({ hello: { version: "2.12.1" } }), HASH(1), DAY(1), "x86_64-linux"),
    ).rejects.toThrow(/not newer than DB head/);
  });
});

describe("new version of an existing package", () => {
  test("adds a version and a variant, leaving the old one open", async () => {
    await runImport(evalJson({ hello: { version: "2.12.1" } }), HASH(1), DAY(1), "x86_64-linux");
    await runImport(
      evalJson({ hello: { version: "2.12.2" } }),
      HASH(2),
      DAY(2),
      "x86_64-linux",
    );

    expect(await rows(`SELECT count(*)::int AS n FROM packages`)).toEqual([{ n: 1 }]);
    const versions = await rows<{ version: string }>(`SELECT version FROM versions ORDER BY sort_key`);
    expect(versions.map((v) => v.version)).toEqual(["2.12.1", "2.12.2"]);

    // The old version's range closes because that variant is absent from the
    // new eval; the new one opens.
    const ranges = await rows<{ version: string; first_seq: number; last_seq: number | null }>(`
      SELECT v.version, r.first_seq, r.last_seq
      FROM variant_ranges r
      JOIN variants va ON va.id = r.variant_id
      JOIN versions v ON v.id = va.version_id
      ORDER BY v.version
    `);
    expect(ranges).toEqual([
      { version: "2.12.1", first_seq: 1, last_seq: 1 },
      { version: "2.12.2", first_seq: 2, last_seq: null },
    ]);
  });
});
