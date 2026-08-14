/**
 * Regression tests for the collation behaviour the seed's grouping queries
 * rely on. These execute the actual SQL text against a fixture DB whose `pkg`
 * table declares `name TEXT COLLATE NOCASE` like the compact DB's, because the
 * behaviour under test lives in the SQL, not in any TS helper.
 */
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { canonicalSpelling, packageKey, versionKey } from "./seedTransform.js";
import { NAME_VERSION_SQL, PACKAGE_SPELLINGS_SQL } from "./sqliteQueries.js";

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

/**
 * A minimal stand-in for the compact DB's `pkg` table. Only the columns the
 * grouping queries read are present; `name COLLATE NOCASE` is the declaration
 * that matters.
 */
function fixture(rows: Array<[name: string, version: string, system: string, sort?: number]>) {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE pkg (
    name TEXT COLLATE NOCASE NOT NULL,
    version TEXT NOT NULL,
    version_sort INTEGER NOT NULL,
    prerelease INTEGER NOT NULL DEFAULT 0,
    system TEXT NOT NULL,
    attr_path TEXT NOT NULL
  )`);
  const insert = db.prepare(
    `INSERT INTO pkg (name, version, version_sort, prerelease, system, attr_path)
     VALUES (?, ?, ?, 0, ?, ?)`,
  );
  for (const [name, version, system, sort] of rows) {
    insert.run(name, version, sort ?? 1, system, name);
  }
  return db;
}

interface NameVersion {
  name: string;
  version: string;
  version_sort: number;
  prerelease: number;
}

describe("NAME_VERSION_SQL (the seed's versions pass)", () => {
  test("merges case-variant spellings of one version into a single row", () => {
    // _86Box and _86box are ONE package (identity is lower(name)), so a
    // version they share must yield ONE versions row: two would collide on
    // versions_package_version_key at COPY time.
    const sqlite = fixture([
      ["_86Box", "4.2", "x86_64-linux"],
      ["_86box", "4.2", "aarch64-linux"],
    ]);
    const rows = sqlite.prepare<[], NameVersion>(NAME_VERSION_SQL).all();
    expect(rows).toHaveLength(1);
    expect(new Set(rows.map((r) => versionKey(r.name, r.version))).size).toBe(1);
  });

  test("adding COLLATE BINARY would split them — which is why it is absent", () => {
    // Guards the inverse: this is the "consistency fix" a future reader might
    // apply to match the packages query. It produces two rows that the seed
    // would map to the same package_id and version.
    const sqlite = fixture([
      ["_86Box", "4.2", "x86_64-linux"],
      ["_86box", "4.2", "aarch64-linux"],
    ]);
    const binary = NAME_VERSION_SQL.replace(
      "GROUP BY name, version",
      "GROUP BY name COLLATE BINARY, version",
    );
    const rows = sqlite.prepare<[], NameVersion>(binary).all();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => versionKey(r.name, r.version))).size).toBe(1);
  });

  test("distinct versions of one package stay distinct rows", () => {
    const sqlite = fixture([
      ["_86Box", "4.2", "x86_64-linux"],
      ["_86box", "4.2.1", "x86_64-linux"],
    ]);
    const rows = sqlite.prepare<[], NameVersion>(NAME_VERSION_SQL).all();
    expect(rows.map((r) => r.version)).toEqual(["4.2", "4.2.1"]);
  });

  test("max() carries the merged group's version_sort and prerelease", () => {
    const sqlite = fixture([
      ["_86Box", "4.2", "x86_64-linux", 7],
      ["_86box", "4.2", "aarch64-linux", 9],
    ]);
    const row = sqlite.prepare<[], NameVersion>(NAME_VERSION_SQL).get()!;
    expect(row.version_sort).toBe(9);
  });

  test("the inherited NOCASE ordering keeps case variants adjacent", () => {
    // The seed buffers one package at a time while streaming this cursor, so
    // all rows of a lower(name) group must arrive consecutively. Binary
    // ordering would interleave _86Boxy between _86Box and _86box.
    const sqlite = fixture([
      ["_86Box", "4.2", "x86_64-linux"],
      ["_86Boxy", "1.0", "x86_64-linux"],
      ["_86box", "4.3", "x86_64-linux"],
    ]);
    const keys = sqlite
      .prepare<[], NameVersion>(NAME_VERSION_SQL)
      .all()
      .map((r) => packageKey(r.name));
    // Every key occupies one contiguous run.
    const runs = keys.filter((k, i) => k !== keys[i - 1]);
    expect(runs).toEqual([...new Set(keys)]);
    expect(runs).toEqual(["_86box", "_86boxy"]);
  });
});

describe("PACKAGE_SPELLINGS_SQL (the seed's packages pass)", () => {
  test("keeps case variants apart, with a count per spelling", () => {
    // The opposite of the versions pass, and deliberately so: canonicalSpelling
    // needs per-spelling counts to pick the dominant one.
    const sqlite = fixture([
      ["_86Box", "4.2", "x86_64-linux"],
      ["_86box", "4.2", "aarch64-linux"],
      ["_86box", "4.3", "x86_64-linux"],
    ]);
    const rows = sqlite.prepare<[], { name: string; n: number }>(PACKAGE_SPELLINGS_SQL).all();
    expect(rows).toEqual([
      { name: "_86Box", n: 1 },
      { name: "_86box", n: 2 },
    ]);
    // ...and the seed re-merges them into one package with one spelling.
    expect(new Set(rows.map((r) => packageKey(r.name))).size).toBe(1);
    expect(canonicalSpelling(rows.map((r) => ({ name: r.name, count: r.n })))).toBe("_86box");
  });

  test("the two passes agree on package count", () => {
    // packages seeded == distinct lower(name) in the versions pass, so every
    // version row resolves to a package id.
    const sqlite = fixture([
      ["_86Box", "4.2", "x86_64-linux"],
      ["_86box", "4.2", "aarch64-linux"],
      ["python", "3.11.9", "x86_64-linux"],
    ]);
    const packages = new Set(
      sqlite
        .prepare<[], { name: string; n: number }>(PACKAGE_SPELLINGS_SQL)
        .all()
        .map((r) => packageKey(r.name)),
    );
    const versionPackages = new Set(
      sqlite
        .prepare<[], NameVersion>(NAME_VERSION_SQL)
        .all()
        .map((r) => packageKey(r.name)),
    );
    expect(packages).toEqual(versionPackages);
    expect(packages.size).toBe(2);
  });
});
