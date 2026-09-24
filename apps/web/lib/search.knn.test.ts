/**
 * Phrase search ranks a broad phrase's nearest prefix matches by trigram
 * distance instead of scoring every prefix match. The two must agree
 * exactly, so this drives both over one fixture — with the threshold at
 * zero (always nearest matches) and out of reach (always score everything)
 * — and compares the answers.
 *
 * The fixture is built so the nearest-match path has something to get
 * wrong: more than PHRASE_LIMIT rows in both the top-level and the nested
 * class, runs of names at equal similarity (ties broken by name), aliases
 * (name <> attr_path), an attribute-path-only prefix match, and a name that
 * differs from its attribute path only in case.
 */

import { afterEach, beforeAll, afterAll, describe, expect, test } from "vitest";
import { search, useKnnMinPrefixRows, type ResultPackage } from "./search";
import { createTestDb, seedCommits, seedPackage, type TestDb } from "./testDb";

let t: TestDb;

const letters = "abcdefghijklmnopqrstuvwxyz";

beforeAll(async () => {
  t = await createTestDb();
  await seedCommits(t.db, 1);
  const one = (name: string, attrPath = name) =>
    seedPackage(t.db, { name, versions: [{ version: "1.0.0", attrPath, systems: ["x86_64-linux"] }] });

  // Top-level: 60 names under "py", many of equal length (so equal
  // similarity to "py"), plus the obvious ones.
  for (let i = 0; i < 56; i++) await one(`py${letters[i % 26]}${"x".repeat(Math.floor(i / 26))}`);
  for (const name of ["py", "pyth", "python", "python3"]) await one(name);
  // Nested: 70 python3Packages.* attributes.
  for (let i = 0; i < 70; i++) await one(`python3Packages.${letters[i % 26]}${"y".repeat(Math.floor(i / 26))}`);
  // Aliases: one package, several attribute paths, one of them a "py" prefix
  // that the name is not.
  await seedPackage(t.db, {
    name: "nix",
    versions: [
      { version: "2.30.0", attrPath: "nix", systems: ["x86_64-linux"] },
      { version: "2.31.0", attrPath: "nixVersions.latest", systems: ["x86_64-linux"] },
      { version: "2.29.0", attrPath: "pyNixCompat", systems: ["x86_64-linux"] },
    ],
  });
  // An attribute-path-only prefix match, and a case-only alias.
  await one("unrelated", "pyUnrelated");
  await one("Pyramid", "pyramid");
}, 300_000);

afterAll(async () => {
  await t?.close();
});

afterEach(() => {
  useKnnMinPrefixRows(undefined);
});

const PHRASES = ["py", "PY", "pyth", "python", "python3", "python3Packages.", "python3Packages.a", "p", "nix", "pyramid", "pyNix", "zzz", "-"];

const shape = (rows: ResultPackage[]) => rows.map((r) => [r.name, r.version, r.attrPath, r.system]);

describe("nearest prefix matches rank exactly as scoring every prefix match", () => {
  for (const version of ["latest", "all"]) {
    test.each(PHRASES)(`%s (${version})`, async (phrase) => {
      const query = version === "latest" ? { phrase, version } : { phrase };
      useKnnMinPrefixRows(1_000_000_000);
      const everything = await search(query);
      useKnnMinPrefixRows(0);
      const nearest = await search(query);
      expect(shape(nearest)).toEqual(shape(everything));
    });
  }

  test("the fixture is broad enough for the LIMIT to cut", async () => {
    useKnnMinPrefixRows(0);
    const rows = await search({ phrase: "py", version: "latest" });
    const names = [...new Set(rows.map((r) => r.name))];
    expect(names).toHaveLength(50);
    // The exact match, then the shortest top-level prefix matches (most
    // similar), ties by name.
    expect(names.slice(0, 4)).toEqual(["py", "pya", "pyb", "pyc"]);
    // The attribute-path-only match (700) ranks below every name-prefix
    // match of either class (800+), so a full page leaves it out.
    expect(names).not.toContain("unrelated");
  });
});
