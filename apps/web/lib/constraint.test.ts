import { describe, expect, test } from "vitest";
import { compareTuples, parseConstraint, satisfies, type SemverTuple } from "./constraint";

function v(s: string): SemverTuple {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(s)!;
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, prerelease: m[4] ?? "" };
}

function matches(constraint: string, version: string): boolean {
  const c = parseConstraint(constraint);
  if (c === null) throw new Error(`unparseable constraint ${constraint}`);
  return satisfies(c, v(version));
}

describe("parseConstraint", () => {
  test("returns null for input that isn't semver-expressible", () => {
    // These fall back to prefix-with-boundary matching in SQL.
    for (const input of ["2024-01-05", "1.1.1w", "unstable-2023-04-01", "", "latest", "abc"]) {
      expect(parseConstraint(input), input).toBeNull();
    }
  });

  test("a full version is exact", () => {
    const c = parseConstraint("3.1.4")!;
    expect(c.exact).toBe(true);
    expect(c.min).toMatchObject({ major: 3, minor: 1, patch: 4, inclusive: true });
    expect(c.max).toMatchObject({ major: 3, minor: 1, patch: 4, inclusive: true });
  });

  test("a leading v is accepted (only `source` keeps the original text)", () => {
    const withV = { ...parseConstraint("v3.1.4")!, source: "" };
    const without = { ...parseConstraint("3.1.4")!, source: "" };
    expect(withV).toEqual(without);
  });
});

describe("dot-boundary matching (sanctioned change #1)", () => {
  test("3.1 no longer matches 3.11 — the headline behavior change", () => {
    // The old service used a raw string prefix, so "3.1" matched "3.11.x".
    expect(matches("3.1", "3.1.0")).toBe(true);
    expect(matches("3.1", "3.1.9")).toBe(true);
    expect(matches("3.1", "3.11.0")).toBe(false);
    expect(matches("3.1", "3.2.0")).toBe(false);
  });

  test("a bare major bounds at the next major", () => {
    expect(matches("3", "3.0.0")).toBe(true);
    expect(matches("3", "3.11.9")).toBe(true);
    expect(matches("3", "4.0.0")).toBe(false);
    expect(matches("3", "2.9.9")).toBe(false);
  });

  test("an exact version matches only itself", () => {
    expect(matches("3.11.9", "3.11.9")).toBe(true);
    expect(matches("3.11.9", "3.11.10")).toBe(false);
  });

  test("1.2 does not match 1.20", () => {
    expect(matches("1.2", "1.2.3")).toBe(true);
    expect(matches("1.2", "1.20.0")).toBe(false);
  });
});

describe("npm-style ranges in the same parameter", () => {
  test("caret allows minor and patch, not major", () => {
    expect(matches("^3.11", "3.11.0")).toBe(true);
    expect(matches("^3.11", "3.12.5")).toBe(true);
    expect(matches("^3.11", "4.0.0")).toBe(false);
    expect(matches("^3.11", "3.10.0")).toBe(false);
  });

  test("caret on 0.x treats the minor as breaking, like npm", () => {
    expect(matches("^0.2.1", "0.2.9")).toBe(true);
    expect(matches("^0.2.1", "0.3.0")).toBe(false);
  });

  test("tilde allows patch only", () => {
    expect(matches("~3.11.2", "3.11.9")).toBe(true);
    expect(matches("~3.11.2", "3.12.0")).toBe(false);
    expect(matches("~3.11.2", "3.11.1")).toBe(false);
  });

  test("comparators combine into a conjunction", () => {
    expect(matches(">=1.2 <2", "1.5.0")).toBe(true);
    expect(matches(">=1.2 <2", "2.0.0")).toBe(false);
    expect(matches(">=1.2 <2", "1.1.0")).toBe(false);
    expect(matches(">1.2.0 <=1.3.0", "1.3.0")).toBe(true);
    expect(matches(">1.2.0 <=1.3.0", "1.2.0")).toBe(false);
  });
});

describe("prerelease handling", () => {
  test("a range does not silently resolve to a prerelease", () => {
    expect(matches("^1.0.0", "2.0.0-rc.1")).toBe(false);
    expect(matches("1", "1.5.0-alpha")).toBe(false);
  });

  test("an exact prerelease request matches", () => {
    expect(matches("1.0.0-rc.1", "1.0.0-rc.1")).toBe(true);
  });

  test("a bound naming a prerelease opts into them", () => {
    expect(matches(">=1.0.0-rc.1 <2", "1.0.0-rc.2")).toBe(true);
  });
});

describe("compareTuples (SemVer 2.0.0 precedence)", () => {
  test("release outranks its own prerelease", () => {
    expect(compareTuples(v("1.0.0"), v("1.0.0-rc.1"))).toBe(1);
  });

  test("numeric prerelease identifiers compare numerically", () => {
    expect(compareTuples(v("1.0.0-alpha.2"), v("1.0.0-alpha.10"))).toBe(-1);
  });

  test("numeric identifiers rank below alphanumeric ones", () => {
    expect(compareTuples(v("1.0.0-1"), v("1.0.0-alpha"))).toBe(-1);
  });

  test("a longer prerelease outranks its prefix", () => {
    expect(compareTuples(v("1.0.0-alpha"), v("1.0.0-alpha.1"))).toBe(-1);
  });

  test("the documented SemVer precedence chain holds", () => {
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i + 1 < chain.length; i++) {
      expect(compareTuples(v(chain[i]!), v(chain[i + 1]!)), `${chain[i]} < ${chain[i + 1]}`).toBe(-1);
    }
  });
});
