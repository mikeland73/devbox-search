/**
 * Query-layer tests against an in-process Postgres (PGlite + pg_trgm), so
 * the SQL that serves the API is exercised for real rather than mocked.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { search } from "./search";
import { createTestDb, seedCommits, seedPackage, type TestDb } from "./testDb";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedCommits(t.db);
}, 120_000);

afterEach(async () => {
  await t?.close();
});

describe("searchByPhrase ranking", () => {
  test("an exact name match outranks a prefix match, which outranks a similarity match", async () => {
    // Reverse-alphabetical seeding order, so an accidental ORDER BY name
    // (in either direction) cannot pass by coincidence.
    await seedPackage(t.db, { name: "yq-go", versions: [{ version: "4.0.0" }] });
    await seedPackage(t.db, { name: "go-2fa", versions: [{ version: "1.0.0" }] });
    await seedPackage(t.db, { name: "go", versions: [{ version: "1.22.0" }] });

    const latest = await search({ phrase: "go", version: "latest" });
    expect(uniqueNames(latest)).toEqual(["go", "go-2fa", "yq-go"]);

    const all = await search({ phrase: "go" });
    expect(uniqueNames(all)).toEqual(["go", "go-2fa", "yq-go"]);
  });

  test("a top-level attribute outranks a nested one with the same name", async () => {
    await seedPackage(t.db, {
      name: "emacsPackages.python",
      versions: [{ version: "1.0.0", attrPath: "emacsPackages.python" }],
    });
    await seedPackage(t.db, { name: "python", versions: [{ version: "3.12.0", attrPath: "python3" }] });

    const latest = await search({ phrase: "python", version: "latest" });
    expect(uniqueNames(latest)).toEqual(["python", "emacsPackages.python"]);
  });

  test("ties are broken by name ascending, as the old service did", async () => {
    await seedPackage(t.db, { name: "go-c", versions: [{ version: "1.0.0" }] });
    await seedPackage(t.db, { name: "go-a", versions: [{ version: "1.0.0" }] });
    await seedPackage(t.db, { name: "go-b", versions: [{ version: "1.0.0" }] });

    const latest = await search({ phrase: "go", version: "latest" });
    expect(uniqueNames(latest)).toEqual(["go-a", "go-b", "go-c"]);
  });
});

/** Names in first-seen order (results may hold several rows per package). */
function uniqueNames(pkgs: Array<{ name: string }>): string[] {
  return [...new Set(pkgs.map((p) => p.name))];
}
