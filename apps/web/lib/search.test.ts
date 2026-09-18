/**
 * Query-layer tests against an in-process Postgres (PGlite + pg_trgm), so
 * the SQL that serves the API is exercised for real rather than mocked.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolve, search } from "./search";
import { createTestDb, seedCommits, seedPackage, type TestDb } from "./testDb";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedCommits(t.db, 3);
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

function uniqueVersions(pkgs: Array<{ version: string }>): string[] {
  return [...new Set(pkgs.map((p) => p.version))];
}

describe("latest: the highest version still present in nixpkgs (#44)", () => {
  // Fixtures default to an open range from seq 1 (still present); `lastSeq`
  // closes it, i.e. nixpkgs dropped the version after that commit.

  // nixpkgs dates snapshots ("2017-03-30"), and the comparator ranks a date
  // above every numeric release. What makes 2.010 latest is that nixpkgs
  // still has it and dropped the snapshot at seq 2.
  test("a snapshot nixpkgs has moved on from is not latest", async () => {
    await seedPackage(t.db, {
      name: "go-font",
      versions: [
        { version: "2017-03-30", lastSeq: 2 },
        { version: "2.010", commitSeq: 3 },
      ],
    });

    expect((await resolve({ name: "go-font", version: "latest" }))[0]?.version).toBe("2.010");
    expect((await search({ phrase: "go-font", version: "latest" }))[0]?.version).toBe("2.010");
    // Listings still show every version in version order.
    expect(uniqueVersions(await search({ name: "go-font" }))).toEqual(["2017-03-30", "2.010"]);
  });

  // The other direction is as real (mod_python 3.5.0 → 2022-10-18), which is
  // why the fix is not "sort dates last": the snapshot that replaced a
  // release is the one nixpkgs has.
  test("a snapshot that replaced a release is latest", async () => {
    await seedPackage(t.db, {
      name: "mod_python",
      versions: [
        { version: "3.5.0", lastSeq: 2 },
        { version: "2022-10-18", commitSeq: 3 },
      ],
    });

    expect((await resolve({ name: "mod_python", version: "latest" }))[0]?.version).toBe("2022-10-18");
  });

  test("a reverted bump yields to the version nixpkgs went back to", async () => {
    await seedPackage(t.db, {
      name: "foo",
      versions: [
        { version: "2.0", commitSeq: 2, lastSeq: 2 },
        { version: "1.9", commitSeq: 3 },
      ],
    });

    expect((await resolve({ name: "foo", version: "latest" }))[0]?.version).toBe("1.9");
  });

  // Renames are the common way a stale, higher-sorting version survives: the
  // old attribute path is gone, so only what is under the new one counts.
  test("a version under an attribute path nixpkgs removed is not latest", async () => {
    await seedPackage(t.db, {
      name: "ebtks",
      versions: [
        { version: "2017-09-23", attrPath: "EBTKS", lastSeq: 2 },
        { version: "1.6.40-unstable-2025-05-06", attrPath: "ebtks", commitSeq: 2 },
      ],
    });

    expect((await resolve({ name: "ebtks", version: "latest" }))[0]?.version).toBe("1.6.40-unstable-2025-05-06");
    expect((await search({ phrase: "ebtks", version: "latest" }))[0]?.version).toBe("1.6.40-unstable-2025-05-06");
  });

  // Several attribute paths carrying the package at once (python312,
  // python313, …) all tie on presence, so the highest wins — and only among
  // the ones nixpkgs still evaluates. `python314` has been missing from evals
  // since buildbotPackages.python started aliasing it (#49): until the eval
  // lists it again, `latest` is the newest interpreter the index can see.
  test("across attribute paths the highest present version wins", async () => {
    await seedPackage(t.db, {
      name: "python",
      versions: [
        { version: "3.12.14", attrPath: "python312" },
        { version: "3.13.15", attrPath: "python313" },
        { version: "3.14.4", attrPath: "python314", lastSeq: 2 },
        { version: "3.15.0rc2", attrPath: "python315" },
      ],
    });

    expect((await resolve({ name: "python", version: "latest" }))[0]?.version).toBe("3.13.15");
    expect((await search({ phrase: "python", version: "latest" }))[0]?.version).toBe("3.13.15");
    // Asking by attribute path scopes the pick to that path.
    expect((await resolve({ name: "python312", version: "latest" }))[0]?.version).toBe("3.12.14");
    // The prerelease fallback stays a fallback.
    expect((await resolve({ name: "python315", version: "latest" }))[0]?.version).toBe("3.15.0rc2");
  });

  test("a system filter judges presence on that system alone", async () => {
    // 2.0 is still shipped for darwin but linux went back to 1.0 at seq 2.
    await seedPackage(t.db, {
      name: "age",
      versions: [
        { version: "1.0" },
        { version: "2.0", lastSeq: { "x86_64-linux": 2, "aarch64-linux": 2 } },
      ],
    });

    expect((await resolve({ name: "age", version: "latest" }))[0]?.version).toBe("2.0");
    expect((await resolve({ name: "age", version: "latest", system: "aarch64-darwin" }))[0]?.version).toBe("2.0");
    expect((await resolve({ name: "age", version: "latest", system: "x86_64-linux" }))[0]?.version).toBe("1.0");
  });

  test("a system that only ever had the old version does not keep it latest", async () => {
    await seedPackage(t.db, {
      name: "go-mtpfs",
      versions: [
        { version: "2018-02-09", lastSeq: 1 },
        { version: "1.0.0", commitSeq: 3, systems: ["x86_64-linux", "aarch64-linux"] },
      ],
    });

    expect((await resolve({ name: "go-mtpfs", version: "latest" }))[0]?.version).toBe("1.0.0");
    // ...but with that system requested, the snapshot is all there ever was.
    expect((await resolve({ name: "go-mtpfs", version: "latest", system: "aarch64-darwin" }))[0]?.version).toBe(
      "2018-02-09",
    );
  });

  // The migration seed wrote point ranges at each row's last content change,
  // which says nothing about presence. They are ignored: a package with no
  // history since the migration (gone before the seed, or asked for on a
  // system frozen at the seed) falls back to plain version order, and a
  // version seen live — even briefly — outranks one seen only by the seed.
  test("seeded ranges do not count as presence", async () => {
    await seedPackage(t.db, {
      name: "dead",
      versions: [
        { version: "1.0", seeded: true, commitSeq: 3 },
        { version: "2020-01-01", seeded: true, commitSeq: 1 },
      ],
    });
    await seedPackage(t.db, {
      name: "dropped",
      versions: [
        { version: "2.0", seeded: true, commitSeq: 3 },
        { version: "1.0", commitSeq: 1, lastSeq: 2 },
      ],
    });

    expect((await resolve({ name: "dead", version: "latest" }))[0]?.version).toBe("2020-01-01");
    expect((await resolve({ name: "dropped", version: "latest" }))[0]?.version).toBe("1.0");
  });

  test("a present but broken version yields to the newest non-broken one (change #3)", async () => {
    await seedPackage(t.db, {
      name: "bar",
      versions: [
        { version: "1.0", lastSeq: 2 },
        { version: "2.0", commitSeq: 3, broken: true },
      ],
    });

    expect((await resolve({ name: "bar", version: "latest" }))[0]?.version).toBe("1.0");
    expect((await search({ phrase: "bar", version: "latest" }))[0]?.version).toBe("1.0");
  });

  test("a version constraint still picks the highest match, present or not", async () => {
    // `go@1.22` must keep resolving to 1.22.12 after nixpkgs drops the
    // series: the constraint names the release line, so presence is moot.
    await seedPackage(t.db, {
      name: "go",
      versions: [
        { version: "1.22.11", attrPath: "go_1_22", lastSeq: 1 },
        { version: "1.22.12", attrPath: "go_1_22", lastSeq: 2 },
        { version: "1.23.0", attrPath: "go" },
      ],
    });

    expect((await resolve({ name: "go", version: "1.22" }))[0]?.version).toBe("1.22.12");
    expect((await resolve({ name: "go", version: "latest" }))[0]?.version).toBe("1.23.0");
  });
});

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
