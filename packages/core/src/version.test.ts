import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  compareVersions,
  compareSortKeys,
  isPrerelease,
  parseGoSemver,
  parseSemver,
  prerelease,
  sortKey,
} from "./version.js";

/**
 * Test vectors ported from Go's TestVersionCompare (version_test.go), run in
 * both directions and with "v" prefixes like the original harness.
 *
 * Four vectors intentionally diverge from the Go comparator under sanctioned
 * API change #4 (the clean Nix-style total order); they live in
 * divergedGoCases below with the old expectation noted.
 */
const goCases: Array<[string, string, number]> = [
  // Semver compare
  ["1.0.0", "1.0.0", 0],
  ["1.0.0", "2.0.0", -1],
  ["1", "2", -1],
  ["1", "2.0.0", -1],
  ["1.0.0", "2", -1],
  ["0.0.1", "1", -1],
  ["0.0.1-alpha", "1", -1],
  ["1", "1.0-prerelease", -1],

  // Python compare
  ["1", "01", 0],
  ["1a", "1b", -1],
  ["1a", "1pre", -1],
  ["1a", "1foo", -1],
  ["1.0.0a", "1.0.0b", -1],
  ["1.0.0b", "1.0.0rc", -1],
  ["1.0.0rc", "1.2.0rc", -1],
  ["3.11.0a2", "3.11.0a4", -1],
  ["3.11.0-a2", "3.11.0-a4", -1],
  ["3.11.0-a2", "3.11.0-b2", -1],

  // Fallback simple compare
  ["abc", "abc", 0],
  ["ab", "abc", -1],
  ["a.1", "a.11", -1],
];

/**
 * Go vectors whose expected result changed under the clean total order
 * (sanctioned change #4). The `goWant` column records the old Go result.
 */
const divergedGoCases: Array<{ v: string; w: string; want: number; goWant: number; why: string }> = [
  // Trailing zero components now count: fewer components sorts first
  // (Nix: "1" < "1.0").
  { v: "1", w: "1.0", want: -1, goWant: 0, why: "trailing zeros are significant" },
  // "a" is a prerelease tag and sorts below a numeric component.
  { v: "1a", w: "1.0a", want: -1, goWant: 0, why: "tag < numeric at position 2" },
  // A trailing prerelease tag sorts below the bare release ("1a" is a
  // prerelease of 1), where Go's PEP 440 comparison put it above.
  { v: "1a", w: "1", want: -1, goWant: 1, why: "tag < end-of-version" },
  // Numbers sort above letters (Nix), where Go's fallback said string > int.
  { v: "a.1", w: "a.b", want: 1, goWant: -1, why: "numeric > alpha" },
  // A longer version with a trailing prerelease tag sorts below its prefix.
  { v: "a.b", w: "a.b.c", want: 1, goWant: -1, why: "'c' is a prerelease tag" },
];

function check(v: string, w: string, want: number) {
  // `want || 0` avoids -0 (from negating a zero expectation) failing Object.is.
  expect(compareVersions(v, w), `compare(${JSON.stringify(v)}, ${JSON.stringify(w)})`).toBe(want || 0);
}

describe("compareVersions", () => {
  test("ported Go vectors", () => {
    for (const [v, w, want] of goCases) {
      // Like the Go harness: every combination of v/no-v prefixes, in both
      // directions. Prefixing only applies where the version starts with a
      // digit (a lone sort key can't replicate Go's asymmetric v-stripping
      // for alpha-leading versions like "vabc").
      const vForms = /^[0-9]/.test(v) ? [v, "v" + v] : [v];
      const wForms = /^[0-9]/.test(w) ? [w, "v" + w] : [w];
      for (const vf of vForms) {
        for (const wf of wForms) {
          check(vf, wf, want);
          if (v !== w) check(wf, vf, -want);
        }
      }
    }
  });

  test("sanctioned divergences from the Go comparator", () => {
    for (const { v, w, want, goWant } of divergedGoCases) {
      check(v, w, want);
      check(w, v, -want);
      expect(want, "vector no longer diverges; move it back to goCases").not.toBe(goWant);
    }
  });

  test("Nix-style ordering", () => {
    // From the Nix manual's compareVersions examples (which agree with the
    // clean order except where prerelease tags apply).
    check("1.0", "2.3", -1);
    check("2.1", "2.3", -1);
    check("2.3", "2.3", 0);
    check("2.5", "2.3", 1);
    check("3.1", "2.3", 1);
    check("2.3.1", "2.3", 1);
    check("2.3.1", "2.3a", 1);
    check("2.3pre1", "2.3", -1);
    check("2.3pre3", "2.3pre12", -1);
    check("2.3a", "2.3c", -1);
    // Divergence from Nix (which special-cases "pre" below everything):
    // known tags compare lexicographically, matching the old service's
    // PEP 440 ordering, so "c" < "pre".
    check("2.3pre1", "2.3c", 1);
    check("2.3pre1", "2.3q", -1);
    // Divergence from Nix: known prerelease tags sort below release.
    check("2.3a", "2.3", -1);
    // But unknown alpha components sort above, as in Nix.
    check("2.3q", "2.3", 1);
  });

  test("semver-style prerelease ordering", () => {
    check("1.0.0-alpha", "1.0.0", -1);
    check("1.0.0-alpha", "1.0.0-alpha.1", -1);
    check("1.0.0-alpha", "1.0.0-beta", -1);
    check("1.0.0-beta", "1.0.0-rc.1", -1);
    check("1.0.0-rc.1", "1.0.0", -1);
    check("1.0.0", "1.0.1", -1);
  });

  test("real-world nixpkgs version shapes", () => {
    check("2024-01-05", "2024-1-6", -1); // date versions, mixed zero padding
    check("1.1.1w", "1.1.1v", 1); // openssl patch letters
    check("0.0.0+date=2023-01-13", "0.0.0+date=2023-01-14", -1);
    check("5.15.108", "6.1.25", -1);
    check("unstable-2023-04-01", "unstable-2023-04-02", -1);
    check("v1.2.3", "1.2.3", 0); // leading v is insignificant
    check("1.0", "1.0.0", -1); // more components sorts later
  });
});

describe("sortKey", () => {
  test("bytewise order matches compareVersions on hand-picked versions", () => {
    const versions = [
      "",
      "0.0.1-alpha",
      "1",
      "01",
      "1.0",
      "1.0.0",
      "2.3pre1",
      "2.3a",
      "2.3",
      "2.3q",
      "2.3.1",
      "3.11.0a2",
      "3.11.0-a4",
      "3.11.0",
      "1.1.1w",
      "2024-01-05",
      "unstable-2023-04-01",
      "v2.0.0",
      "20240105",
    ];
    for (const v of versions) {
      for (const w of versions) {
        expect(
          compareSortKeys(sortKey(v), sortKey(w)),
          `sortKey order for (${JSON.stringify(v)}, ${JSON.stringify(w)})`,
        ).toBe(compareVersions(v, w));
      }
    }
  });

  test("property: sort key order is exactly comparator order", () => {
    const versionish = fc.oneof(
      fc.string(),
      fc.string({ unit: "binary" }),
      fc.stringMatching(/^v?[0-9]{1,4}(\.[0-9]{1,4}){0,3}(-?(a|b|c|rc|alpha|beta|pre|preview|q|dev)[0-9]{0,3})?$/),
    );
    fc.assert(
      fc.property(versionish, versionish, (v, w) => {
        expect(compareSortKeys(sortKey(v), sortKey(w))).toBe(compareVersions(v, w));
      }),
      { numRuns: 5000 },
    );
  });

  test("property: comparator is transitive and antisymmetric (total order)", () => {
    // Total order follows from the bytewise key equivalence, but check the
    // comparator directly on triples as documentation.
    const versionish = fc.stringMatching(/^v?[0-9]{1,3}(\.[0-9]{1,3}){0,3}[a-z]{0,5}[0-9]{0,2}$/);
    fc.assert(
      fc.property(versionish, versionish, versionish, (a, b, c) => {
        expect(compareVersions(a, b)).toBe(-compareVersions(b, a));
        if (compareVersions(a, b) <= 0 && compareVersions(b, c) <= 0) {
          expect(compareVersions(a, c)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: 5000 },
    );
  });
});

describe("prerelease (faithful Go port)", () => {
  test("vectors matching Go behavior", () => {
    // x/mod/semver path: only "v"-prefixed versions, keeps the leading "-".
    expect(prerelease("v2.1.0-pre")).toBe("-pre");
    expect(prerelease("v2.1.0-pre+meta")).toBe("-pre");
    expect(prerelease("v1.2.3")).toBe("");
    expect(prerelease("v1")).toBe("");

    // PEP 440 path.
    expect(prerelease("3.11.0a2")).toBe("a2");
    expect(prerelease("3.11.0-a2")).toBe("a2");
    expect(prerelease("1.0.0rc1")).toBe("rc1");
    expect(prerelease("1.0-rc.1")).toBe("rc.1"); // pre group includes the trailing separator+number
    expect(prerelease("1.2.3")).toBe("");
    expect(prerelease("1.1.1a")).toBe("a"); // openssl-style patch letter (old-service quirk, kept)
    expect(prerelease("1.1.1w")).toBe(""); // "w" is not a PEP 440 pre tag
    expect(prerelease("2024-01-05")).toBe(""); // parses as release + post-release
    expect(prerelease("1.0.0.dev1")).toBe(""); // dev-only releases were not flagged

    // Suffix fallback path (non-PEP-440 shapes).
    expect(prerelease("foo-alpha")).toBe("alpha");
    expect(prerelease("foo-rc")).toBe("rc");
    expect(prerelease("unstable-2023-04-01")).toBe("");
    expect(prerelease("abc")).toBe("");
  });

  test("isPrerelease", () => {
    expect(isPrerelease("3.11.0a2")).toBe(true);
    expect(isPrerelease("3.11.0")).toBe(false);
  });
});

describe("parseGoSemver", () => {
  test("follows x/mod/semver's lax rules", () => {
    expect(parseGoSemver("v1")).toEqual({ major: 1, minor: 0, patch: 0, prerelease: "", build: "" });
    expect(parseGoSemver("v1.2")).toEqual({ major: 1, minor: 2, patch: 0, prerelease: "", build: "" });
    expect(parseGoSemver("v1.2.3-rc.1+build.5")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: "rc.1",
      build: "build.5",
    });
    expect(parseGoSemver("1.2.3")).toBeNull(); // no leading v
    expect(parseGoSemver("v01.2.3")).toBeNull(); // leading zero
    expect(parseGoSemver("v1.2.3-01")).toBeNull(); // numeric identifier leading zero
    expect(parseGoSemver("v1.2.3-")).toBeNull();
    expect(parseGoSemver("v1.2.3+")).toBeNull();
    expect(parseGoSemver("v1.2.3-rc..1")).toBeNull();
    expect(parseGoSemver("v1.2.3.4")).toBeNull();
  });
});

describe("parseSemver", () => {
  test("strict SemVer 2.0.0 with optional v", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "" });
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "" });
    expect(parseSemver("1.2.3-rc.1")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "rc.1" });
    expect(parseSemver("1.2.3+build")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "" });
    expect(parseSemver("1.2")).toBeNull(); // partial versions are not semver
    expect(parseSemver("1.02.3")).toBeNull(); // leading zero
    expect(parseSemver("2024-01-05")).toBeNull();
    expect(parseSemver("1.2.3-01")).toBeNull();
    expect(parseSemver("1.1.1w")).toBeNull();
  });
});
