import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MIGRATIONS_FOLDER } from "./migrate.js";
import { commits, meta, packages, searchTerms, variantRanges, variants, versions } from "./schema.js";
import { getTableConfig } from "drizzle-orm/pg-core";

const initSql = readFileSync(join(MIGRATIONS_FOLDER, "0000_init.sql"), "utf8");

describe("generated DDL", () => {
  test("creates pg_trgm before any gin_trgm_ops index", () => {
    const extIdx = initSql.indexOf("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    const trgmIdx = initSql.indexOf("USING gin (");
    expect(extIdx).toBeGreaterThanOrEqual(0);
    expect(trgmIdx).toBeGreaterThan(extIdx);
  });

  test("every table in the schema module appears in the migration", () => {
    for (const table of [commits, packages, versions, meta, variants, variantRanges, searchTerms]) {
      const { name } = getTableConfig(table);
      expect(initSql, `table ${name}`).toContain(`CREATE TABLE "${name}"`);
    }
    expect(initSql).toContain(`CREATE TABLE "commit_systems"`);
  });

  test("sort_key is bytea (the byte-comparable version key)", () => {
    expect(initSql).toMatch(/"sort_key" "?bytea"? NOT NULL/);
  });

  test("open variant ranges have a partial index", () => {
    expect(initSql).toContain(`WHERE "variant_ranges"."last_seq" IS NULL`);
  });
});

describe("schema invariants", () => {
  test("commits.seq is a plain (non-identity) int PK: seeded seqs are assigned explicitly", () => {
    const cfg = getTableConfig(commits);
    const seq = cfg.columns.find((c) => c.name === "seq")!;
    expect(seq.primary).toBe(true);
    expect(initSql).toContain(`"seq" integer PRIMARY KEY NOT NULL`);
    // Contrast: surrogate keys elsewhere are identity columns.
    expect(initSql).toMatch(/"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY/);
  });

  test("variant identity is (version, system, attr_path)", () => {
    const cfg = getTableConfig(variants);
    const unique = cfg.indexes.find((i) => i.config.name === "variants_identity_key");
    expect(unique?.config.unique).toBe(true);
    expect(unique?.config.columns.map((c) => ("name" in c ? c.name : ""))).toEqual([
      "version_id",
      "system",
      "attr_path",
    ]);
  });

  test("version identity is (package, version) and content hashes are sha256-sized", () => {
    const versionCfg = getTableConfig(versions);
    expect(versionCfg.indexes.find((i) => i.config.name === "versions_package_version_key")?.config.unique).toBe(true);
    expect(initSql).toContain(`"content_hash" char(64) NOT NULL`);
    expect(initSql).toContain(`"hash" char(64) NOT NULL`); // meta.hash
    expect(initSql).toContain(`"hash" char(40) NOT NULL`); // commits.hash (git sha1)
  });

  test("semver columns are nullable (non-semver versions like 2024-01-05)", () => {
    const cfg = getTableConfig(versions);
    for (const name of ["semver_major", "semver_minor", "semver_patch", "semver_pre"]) {
      expect(cfg.columns.find((c) => c.name === name)!.notNull, name).toBe(false);
    }
  });

  test("meta is content-addressed by a unique hash", () => {
    const cfg = getTableConfig(meta);
    expect(cfg.columns.find((c) => c.name === "hash")!.isUnique).toBe(true);
  });

  test("search_terms carries both trigram indexes", () => {
    const cfg = getTableConfig(searchTerms);
    const names = cfg.indexes.map((i) => i.config.name);
    expect(names).toContain("search_terms_name_trgm_idx");
    expect(names).toContain("search_terms_attr_path_trgm_idx");
  });
});

describe("bytea custom type", () => {
  // The built column off the table, since bytea() itself returns a builder.
  const column = getTableConfig(versions).columns.find((c) => c.name === "sort_key")!;

  test("round-trips Uint8Array through the driver representation", () => {
    expect(column.getSQLType()).toBe("bytea");
    const value = Uint8Array.from([0x04, 0x01, 0x33, 0x02]);
    const driver = column.mapToDriverValue(value) as Buffer;
    expect(Buffer.isBuffer(driver)).toBe(true);
    expect(column.mapFromDriverValue(driver)).toEqual(value);
  });

  test("respects byteOffset when the input is a view into a larger buffer", () => {
    const backing = Uint8Array.from([9, 9, 1, 2, 3, 9]);
    const view = backing.subarray(2, 5);
    const driver = column.mapToDriverValue(view) as Buffer;
    expect([...driver]).toEqual([1, 2, 3]);
  });
});
