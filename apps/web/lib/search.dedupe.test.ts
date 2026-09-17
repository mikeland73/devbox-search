/**
 * Phrase search returns one row per package (latest) or per package x
 * version (all versions) — never one per system — matching the old
 * service's GROUP BY. Runs against an in-process Postgres (PGlite + pg_trgm).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { search } from "./search";
import { createTestDb, seedCommits, seedPackage, type TestDb } from "./testDb";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedCommits(t.db, 2);
}, 120_000);

afterEach(async () => {
  await t?.close();
});

describe("searchByPhrase grouping", () => {
  test("latest: one row per package, at its newest version, lowest system first", async () => {
    await seedPackage(t.db, {
      name: "go",
      versions: [
        { version: "1.21.0", commitSeq: 1 },
        // Systems on different commits, as on staging: the collapsed row
        // must still be a single, deterministic one.
        { version: "1.22.0", systems: ["x86_64-linux", "aarch64-linux"], commitSeq: 2 },
      ],
    });
    await seedPackage(t.db, { name: "go-2fa", versions: [{ version: "1.0.0" }] });

    const rows = await search({ phrase: "go", version: "latest" });
    // renderV2Search maps rows 1:1, so this is also /v2/search's
    // total_results: 2 packages, not 6 system rows.
    expect(byName(rows).map((r) => [r.name, r.version, r.system])).toEqual([
      ["go", "1.22.0", "aarch64-linux"],
      ["go-2fa", "1.0.0", "aarch64-darwin"],
    ]);
  });

  test("all versions: one row per package x version, newest first", async () => {
    await seedPackage(t.db, {
      name: "go",
      versions: [{ version: "1.21.0" }, { version: "1.22.0" }],
    });
    await seedPackage(t.db, { name: "go-2fa", versions: [{ version: "1.0.0" }] });

    // /v1/search and /search group these by name then version, so one row
    // per version means one version entry with a single system each — the
    // shape in the golden corpus.
    const rows = await search({ phrase: "go" });
    expect(byName(rows).map((r) => [r.name, r.version, r.system])).toEqual([
      ["go", "1.22.0", "aarch64-darwin"],
      ["go", "1.21.0", "aarch64-darwin"],
      ["go-2fa", "1.0.0", "aarch64-darwin"],
    ]);
  });

  test("the latest cap of 50 counts packages, not system rows", async () => {
    for (let i = 1; i <= 52; i++) {
      await seedPackage(t.db, {
        name: `zz-pkg-${String(i).padStart(2, "0")}`,
        versions: [{ version: "1.0.0", systems: ["x86_64-linux", "aarch64-darwin"] }],
      });
    }

    const rows = await search({ phrase: "zz-pkg", version: "latest" });
    expect(rows).toHaveLength(50);
    expect(new Set(rows.map((r) => r.name)).size).toBe(50);
  }, 60_000);
});

/**
 * Stable sort by name: cross-package order is the ranking's concern (#24),
 * not this file's; within a package the query order is preserved.
 */
function byName<T extends { name: string }>(items: T[]): T[] {
  return items.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
