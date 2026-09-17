/**
 * Importer guards that need no database: the rows an eval contributes and
 * the sanity checks on them. The merge SQL itself is covered by
 * import.live.test.ts.
 */

import { describe, expect, test } from "vitest";
import { CHANGE_RATIO_WARN_THRESHOLD, changeRatioWarning, evalRows } from "./import.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DAY = new Date("2026-09-17T00:00:00Z");

function pkg(attrPath: string, overrides: Record<string, unknown> = {}) {
  return {
    name: `${attrPath}-1.0`,
    pname: attrPath,
    version: "1.0",
    system: "x86_64-linux",
    outputName: "out",
    outputs: { out: `/nix/store/${"a".repeat(32)}-${attrPath}-1.0` },
    meta: { description: "a package", platforms: ["x86_64-linux"] },
    ...overrides,
  };
}

describe("evalRows", () => {
  test("keeps well-formed packages, stamps the requested system, drops versionless rows", () => {
    const rows = evalRows(
      { hello: pkg("hello", { system: "aarch64-darwin" }), noVersion: pkg("noVersion", { version: "" }) },
      COMMIT,
      DAY,
      "x86_64-linux",
    );
    expect(rows.map((r) => r.pkg.attrPath)).toEqual(["hello"]);
    expect(rows[0]!.pkg.system).toBe("x86_64-linux");
    expect(rows[0]!.pkg.storeHash).toBe("a".repeat(32));
  });

  test("a nix-env stub (no outputs at all) is dropped by the decoder, not seen here", () => {
    const rows = evalRows({ hello: pkg("hello"), stub: { name: "stub-1.0", pname: "stub", version: "1.0" } }, COMMIT, DAY, "x86_64-linux");
    expect(rows.map((r) => r.pkg.attrPath)).toEqual(["hello"]);
  });

  test("refuses the whole eval when any row would have an empty store hash", () => {
    // `outputs: {}` is an object, so the decoder's stub check lets it through;
    // this is the shape of a future producer or decoder regression. #19's
    // stubs became ~75k phantom variants per commit — fail instead.
    const json = {
      hello: pkg("hello"),
      "haskellPackages.phantom": pkg("haskellPackages.phantom", { outputs: {} }),
      "rPackages.phantom": pkg("rPackages.phantom", { outputs: { out: "" } }),
    };
    expect(() => evalRows(json, COMMIT, DAY, "x86_64-linux")).toThrow(
      /refusing to import 0123456\/x86_64-linux: 2 of 3 rows have no store hash \(e\.g\. haskellPackages\.phantom, rPackages\.phantom\)/,
    );
  });
});

describe("changeRatioWarning", () => {
  test("a normal day is silent", () => {
    expect(changeRatioWarning(1500, 100_000, 2751)).toBeNull();
    expect(changeRatioWarning(0, 100_000, 2751)).toBeNull();
  });

  test("the first import for a system is 100% new by definition, so no warning", () => {
    expect(changeRatioWarning(100_000, 100_000, null)).toBeNull();
  });

  test("an implausible share of changed variants is called out with the numbers", () => {
    // #19's first import: 74,567 phantoms of ~100k rows.
    const warning = changeRatioWarning(74_567, 100_000, 2751);
    expect(warning).toMatch(/74567 of 100000 variants \(74\.6%\) are new or changed/);
    expect(warning).toMatch(/staging-next/);
  });

  test("the threshold is inclusive on the quiet side", () => {
    const scanned = 1000;
    const atThreshold = Math.floor(scanned * CHANGE_RATIO_WARN_THRESHOLD);
    expect(changeRatioWarning(atThreshold, scanned, 1)).toBeNull();
    expect(changeRatioWarning(atThreshold + 1, scanned, 1)).not.toBeNull();
  });

  test("an empty eval cannot divide by zero", () => {
    expect(changeRatioWarning(0, 0, 1)).toBeNull();
  });
});
