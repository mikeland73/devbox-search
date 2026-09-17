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

  test("an attribute-path prefix match is admitted even when the name is unrelated", async () => {
    await seedPackage(t.db, { name: "cpython", versions: [{ version: "3.12.0", attrPath: "python312" }] });

    const latest = await search({ phrase: "python3", version: "latest" });
    expect(uniqueNames(latest)).toEqual(["cpython"]);
  });
});

describe("searchByPhrase candidate tiers", () => {
  // The ranked query evaluates two candidate tiers — exact/prefix matches,
  // then trigram-similarity matches — and skips the second when the first
  // already fills the result cap. These tests pin the equivalence that makes
  // the skip safe: the result must be exactly what a single ranking over all
  // candidates produces, whether or not the fuzzy tier ran.

  /** Seeds `n` packages named `${stem}-000` .. `${stem}-(n-1)`. */
  async function seedPrefixed(stem: string, n: number): Promise<string[]> {
    const names = Array.from({ length: n }, (_, i) => `${stem}-${String(i).padStart(3, "0")}`);
    // Reverse order so an insertion-order pass cannot masquerade as ranking.
    for (const name of [...names].reverse()) {
      await seedPackage(t.db, { name, versions: [{ version: "1.0.0" }] });
    }
    return names;
  }

  test("a similarity-only match appears when the prefix tier has room", async () => {
    const prefixed = await seedPrefixed("py", 49);
    // pg_trgm trigrams words separately, so "yq-py" shares every trigram of
    // "py" (similarity 0.5) without being a prefix match — the same reason
    // "yq-go" is a hit for "go" above.
    await seedPackage(t.db, { name: "yq-py", versions: [{ version: "1.0.0" }] });

    const latest = await search({ phrase: "py", version: "latest" });
    expect(uniqueNames(latest)).toEqual([...prefixed, "yq-py"]);
  }, 60_000);

  test("a similarity-only match is cut when the prefix tier is full, and the cap holds", async () => {
    const prefixed = await seedPrefixed("py", 51);
    // "yq-py" is more similar to "py" (0.5) than any "py-NNN" is, so it is
    // cut on tier alone — which is the property that lets the fuzzy tier be
    // skipped when the prefix tier is full.
    await seedPackage(t.db, { name: "yq-py", versions: [{ version: "1.0.0" }] });

    const latest = await search({ phrase: "py", version: "latest" });
    expect(latest).toHaveLength(50);
    expect(uniqueNames(latest)).toEqual(prefixed.slice(0, 50));
  }, 60_000);

  test("a package straddling both tiers is one result, not two", async () => {
    // The tiers are grouped separately, so a package whose name matches
    // neither way but whose attribute paths split across the tiers — one a
    // prefix match, one only trigram-similar — would surface once from each
    // without a final grouping on package. The old single GROUP BY could not
    // produce this; the response builders assume one hit per package.
    await seedPackage(t.db, {
      name: "cpython",
      versions: [
        { version: "3.12.0", attrPath: "python312" },
        { version: "3.11.0", attrPath: "ipython3" },
      ],
    });
    await seedPackage(t.db, { name: "python3-full", versions: [{ version: "3.12.0" }] });

    const latest = await search({ phrase: "python3", version: "latest" });
    expect(latest.map((p) => p.name)).toEqual(["python3-full", "cpython"]);

    const all = await search({ phrase: "python3" });
    expect(uniqueNames(all)).toEqual(["python3-full", "cpython"]);
    expect(all.filter((p) => p.name === "cpython")).toHaveLength(2);
  });

  test("a full prefix tier still yields to a better prefix match seeded last", async () => {
    await seedPrefixed("py", 50);
    await seedPackage(t.db, { name: "py", versions: [{ version: "1.0.0" }] });

    const latest = await search({ phrase: "py", version: "latest" });
    expect(uniqueNames(latest)[0]).toBe("py");
    expect(latest).toHaveLength(50);
  }, 60_000);
});

/** Names in first-seen order (results may hold several rows per package). */
function uniqueNames(pkgs: Array<{ name: string }>): string[] {
  return [...new Set(pkgs.map((p) => p.name))];
}

describe("result row decoding", () => {
  // The drivers hand timestamps back as strings; only a schema column (not a
  // raw `sql` fragment) goes through drizzle's Date mapping. The renderers
  // call `.toISOString()` on lastUpdated, so a string here is a 500.
  test("lastUpdated and commitHash come from the commits table as Date and string", async () => {
    await seedPackage(t.db, { name: "ripgrep", versions: [{ version: "14.1.0" }] });
    const committedAt = new Date(Date.UTC(2026, 0, 1));

    const queries = [
      { phrase: "ripgrep" },
      { phrase: "ripgrep", version: "latest" },
      { name: "ripgrep" },
      { name: "ripgrep", version: "latest" },
    ];
    for (const q of queries) {
      const rows = await search(q);
      expect(rows.length, JSON.stringify(q)).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.lastUpdated, JSON.stringify(q)).toBeInstanceOf(Date);
        expect(row.lastUpdated.getTime()).toBe(committedAt.getTime());
        expect(row.commitHash).toBe("1".padStart(40, "0"));
      }
    }
  });
});
