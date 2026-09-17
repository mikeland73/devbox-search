/**
 * End-to-end import tests against an in-process Postgres (PGlite).
 *
 * The import SQL is the riskiest code in the migration: it is set-based,
 * stateful across days, and a mistake in the range logic silently corrupts
 * history rather than failing loudly. These tests drive the real SQL through
 * a multi-day scenario.
 *
 * Every statement here comes from importSql.ts — the same strings import.ts
 * executes — so the merge logic can't drift away from what's tested. PGlite
 * has no wire protocol, so the only substitution is staging: COPY becomes
 * per-row INSERT into the identical temp tables. copy.test.ts covers the COPY
 * encoding itself.
 */

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { canonicalName, contentHash, decodeEvalJson, metaHash } from "@devbox-search/core";
import { migrationStatements } from "@devbox-search/db";
import { packageKey, toVersionRow } from "./seedTransform.js";
import * as SQL from "./importSql.js";

let db: PGlite;

beforeEach(async () => {
  db = await PGlite.create({ extensions: { pg_trgm } });
  for (const statement of migrationStatements()) await db.exec(statement);
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
 * PGlite's stand-in for copyRows: loads the same temp table with the same
 * columns, one INSERT per row.
 */
async function stage(table: string, columns: string[], values: unknown[][]): Promise<void> {
  const sql =
    `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) ` +
    `VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`;
  for (const row of values) await db.query(sql, row.map(toParam));
}

/** COPY text format encodes these itself; the driver needs them pre-encoded. */
function toParam(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value !== null && typeof value === "object") return JSON.stringify(value); // jsonb
  return value;
}

/**
 * Runs the importer's SQL against PGlite: the statements are importSql.ts
 * verbatim, in importEval's order, with COPY replaced by `stage`.
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

  const already = await db.query<{ seq: number }>(SQL.EXISTING_IMPORT, [commitHash, system]);
  if (already.rows.length > 0) {
    await db.exec("ROLLBACK");
    return { skipped: true, commitSeq: already.rows[0]!.seq, changed: 0, opened: 0, closed: 0 };
  }

  const head = await db.query<{ seq: number; committed_at: Date }>(SQL.HEAD_COMMIT);
  const known = await db.query<{ seq: number }>(SQL.COMMIT_BY_HASH, [commitHash]);
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
    await db.query(SQL.INSERT_COMMIT, [commitSeq, commitHash, committedAt.toISOString()]);
  }

  const prev = await db.query<{ seq: number }>(SQL.PREV_SYSTEM_SEQ, [system, commitSeq]);
  const prevSeq = prev.rows[0]?.seq ?? null;

  await db.exec(SQL.STAGE_KEYS_DDL);
  await stage(
    "stage_keys",
    SQL.STAGE_KEYS_COLUMNS,
    rows.map((r) => [r.name, packageKey(r.name), r.version, r.pkg.attrPath, r.metaHash, r.contentHash]),
  );
  await db.exec(SQL.STAGE_KEYS_INDEX);

  await db.exec(SQL.INSERT_PACKAGES);

  const missingVersions = await db.query<{ name_key: string; version: string }>(SQL.MISSING_VERSIONS);
  if (missingVersions.rows.length > 0) {
    await db.exec(SQL.STAGE_VERSIONS_DDL);
    await stage(
      "stage_versions",
      SQL.STAGE_VERSIONS_COLUMNS,
      missingVersions.rows.map((r) => {
        const v = toVersionRow(r.name_key, r.version);
        return [
          r.name_key,
          r.version,
          v.sortKey,
          v.prerelease,
          v.semverMajor,
          v.semverMinor,
          v.semverPatch,
          v.semverPre,
        ];
      }),
    );
    await db.exec(SQL.INSERT_VERSIONS);
  }

  const missingMeta = await db.query<{ meta_hash: string }>(SQL.MISSING_META);
  if (missingMeta.rows.length > 0) {
    const wanted = new Set(missingMeta.rows.map((r) => r.meta_hash));
    const seen = new Set<string>();
    const blobs: unknown[][] = [];
    for (const r of rows) {
      if (!wanted.has(r.metaHash) || seen.has(r.metaHash)) continue;
      seen.add(r.metaHash);
      blobs.push([
        r.metaHash,
        r.pkg.summary,
        r.pkg.description,
        r.pkg.homepage,
        r.pkg.license,
        r.pkg.platforms,
      ]);
    }
    await db.exec(SQL.STAGE_META_DDL);
    await stage("stage_meta", SQL.STAGE_META_COLUMNS, blobs);
    await db.exec(SQL.INSERT_META);
  }

  const changed = await db.query<{ name_key: string; version: string; attr_path: string }>(
    SQL.CHANGED_VARIANTS,
    [system],
  );

  if (changed.rows.length > 0) {
    const wanted = new Set(changed.rows.map((r) => `${r.name_key}\t${r.version}\t${r.attr_path}`));
    await db.exec(SQL.STAGE_VARIANTS_DDL);
    await stage(
      "stage_variants",
      SQL.STAGE_VARIANTS_COLUMNS,
      rows
        .filter((r) => wanted.has(`${packageKey(r.name)}\t${r.version}\t${r.pkg.attrPath}`))
        .map((r) => [
          packageKey(r.name),
          r.version,
          r.pkg.attrPath,
          r.metaHash,
          r.pkg.storeHash,
          r.pkg.storeName,
          r.pkg.metaName,
          r.pkg.metaVersion,
          r.pkg.program,
          r.pkg.broken,
          r.pkg.insecure,
          r.pkg.outputs,
          r.contentHash,
        ]),
    );
    await db.query(SQL.UPSERT_VARIANTS, [system, commitSeq]);
  }

  let closed = 0;
  if (prevSeq !== null) {
    const result = await db.query(SQL.CLOSE_RANGES, [system, prevSeq]);
    closed = result.affectedRows ?? 0;
  }

  const opened = await db.query(SQL.OPEN_RANGES, [system, commitSeq]);

  await db.exec(SQL.INSERT_SEARCH_TERMS);
  await db.query(SQL.INSERT_COMMIT_SYSTEM, [commitSeq, system]);
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

describe("version staging", () => {
  test("date-stamped semver components wider than int4 stage and land as bigint", async () => {
    // nixpkgs-unstable 8b7dc2ca (2026-08-17) carries a 0.1.20260720092025-style
    // version; the staging table used to be integer and rejected it at COPY.
    await runImport(evalJson({ stamped: { version: "0.1.20260720092025" } }), HASH(1), DAY(1), "x86_64-linux");

    expect(
      await rows(`SELECT semver_major::int AS major, semver_minor::int AS minor, semver_patch::text AS patch FROM versions`),
    ).toEqual([{ major: 0, minor: 1, patch: "20260720092025" }]);
  });
});

describe("INCOMPLETE_COMMITS (discover's backfill query)", () => {
  const SYSTEMS = ["x86_64-linux", "aarch64-linux", "aarch64-darwin"];
  async function seedCommit(seq: number, hash: string, systems: string[]): Promise<void> {
    await db.query(`INSERT INTO commits (seq, hash, committed_at) VALUES ($1, $2, $3)`, [seq, hash, new Date(2026, 0, seq)]);
    for (const s of systems) await db.query(`INSERT INTO commit_systems (commit_seq, system) VALUES ($1, $2)`, [seq, s]);
  }

  test("reports each commit missing any expected system, oldest first, with the missing set", async () => {
    await seedCommit(1, "a".repeat(40), [...SYSTEMS, "i686-linux", "x86_64-darwin"]); // seeded: complete
    await seedCommit(2, "b".repeat(40), ["aarch64-darwin"]); // one system landed
    await seedCommit(3, "c".repeat(40), SYSTEMS); // complete
    await seedCommit(4, "d".repeat(40), ["x86_64-linux", "aarch64-linux"]); // darwin missing
    const { rows } = await db.query<{ hash: string; missing: string[] }>(SQL.INCOMPLETE_COMMITS, [SYSTEMS]);
    expect(rows.map((r) => [r.hash[0], [...r.missing].sort()])).toEqual([
      ["b", ["aarch64-linux", "x86_64-linux"]],
      ["d", ["aarch64-darwin"]],
    ]);
  });

  test("extra systems a commit has beyond the expected list do not count as incomplete", async () => {
    await seedCommit(1, "a".repeat(40), [...SYSTEMS, "i686-linux"]);
    const { rows } = await db.query(SQL.INCOMPLETE_COMMITS, [SYSTEMS]);
    expect(rows).toHaveLength(0);
  });
});
