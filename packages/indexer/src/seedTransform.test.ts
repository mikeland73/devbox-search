import { describe, expect, test } from "vitest";
import { contentHash, metaHash } from "@devbox-search/core";
import {
  canonicalSpelling,
  compareVersionOrder,
  packageKey,
  toEvalShape,
  toMetaRow,
  toVariantRow,
  toVersionRow,
  topLevelAttr,
  versionKey,
  type SqlitePkgRow,
} from "./seedTransform.js";

/** A representative compact-DB row (fields as they appear in latest_json). */
const row: SqlitePkgRow = {
  name: "python",
  version: "3.11.9",
  versionSort: 42,
  prerelease: 0,
  system: "x86_64-linux",
  attrPath: "python311",
  json: {
    commit_hash: "a".repeat(40),
    last_updated: "2024-03-08T13:51:52Z",
    store_hash: "9xc41alhnbx27a4jc2bmp4w54mq8gvfn",
    store_name: "python3",
    store_version: "3.11.9",
    meta_name: "python3-3.11.9",
    meta_version: [""],
    attr_path: "python311",
    system: "x86_64-linux",
    summary: "High-level dynamically-typed programming language",
    homepage: "https://www.python.org",
    license: "PSF-2.0",
    platforms: ["aarch64-linux", "x86_64-linux"],
    outputs: [
      {
        name: "out",
        path: "/nix/store/9xc41alhnbx27a4jc2bmp4w54mq8gvfn-python3-3.11.9",
        default: true,
        nar: "nar/abc.nar.xz",
      },
    ],
  },
};

describe("toEvalShape", () => {
  test("fills every field the hashers read, defaulting omitted ones", () => {
    const shape = toEvalShape({ ...row, json: { store_version: "1.0" } });
    expect(shape).toEqual({
      storeHash: "",
      storeName: "",
      storeVersion: "1.0",
      metaName: "",
      metaVersion: [],
      attrPath: "python311",
      system: "x86_64-linux",
      program: "",
      summary: "",
      description: "",
      homepage: "",
      license: "",
      broken: false,
      insecure: false,
      platforms: [],
      outputs: [],
    });
  });

  test("drops outputs[].nar, which the new pipeline does not store", () => {
    const shape = toEvalShape(row);
    expect(shape.outputs).toEqual([
      {
        name: "out",
        path: "/nix/store/9xc41alhnbx27a4jc2bmp4w54mq8gvfn-python3-3.11.9",
        default: true,
      },
    ]);
    expect(JSON.stringify(shape)).not.toContain("nar");
  });

  test("takes attr_path and system from the columns, not the JSON copy", () => {
    // The columns are sqlite generated columns derived from the JSON, but the
    // row grain is defined by the columns; trust those.
    const shape = toEvalShape({
      ...row,
      attrPath: "python3",
      system: "aarch64-darwin",
      json: { ...row.json, attr_path: "stale", system: "stale" },
    });
    expect(shape.attrPath).toBe("python3");
    expect(shape.system).toBe("aarch64-darwin");
  });
});

describe("hashing agrees with core", () => {
  test("meta and content hashes are the ones the importer will compute", () => {
    // If these diverged, the first daily import after the seed would rewrite
    // every single variant.
    const shape = toEvalShape(row);
    expect(toMetaRow(row).hash).toBe(metaHash(shape));
    expect(toVariantRow(row).contentHash).toBe(contentHash(shape));
  });

  test("meta hash ignores variant-identity fields", () => {
    const other = { ...row, attrPath: "python3", system: "aarch64-darwin" };
    expect(toMetaRow(other).hash).toBe(toMetaRow(row).hash);
  });

  test("meta hash changes when a deduplicated field changes", () => {
    const changed = { ...row, json: { ...row.json, summary: "different" } };
    expect(toMetaRow(changed).hash).not.toBe(toMetaRow(row).hash);
  });

  test("content hash changes when the store path changes", () => {
    const changed = { ...row, json: { ...row.json, store_hash: "b".repeat(32) } };
    expect(toVariantRow(changed).contentHash).not.toBe(toVariantRow(row).contentHash);
  });

  test("content hash ignores nar (cache status), so it is reproducible from eval JSON", () => {
    const output = { ...row.json.outputs![0]! };
    delete output.nar;
    const outputWithoutNar = output;
    const noNar: SqlitePkgRow = {
      ...row,
      json: { ...row.json, outputs: [outputWithoutNar] },
    };
    expect(toVariantRow(noNar).contentHash).toBe(toVariantRow(row).contentHash);
  });
});

describe("toVariantRow", () => {
  test("carries identity, commit, and content", () => {
    const v = toVariantRow(row);
    expect(v.versionKey).toBe(versionKey("python", "3.11.9"));
    expect(v.system).toBe("x86_64-linux");
    expect(v.attrPath).toBe("python311");
    expect(v.commitHash).toBe("a".repeat(40));
    expect(v.storeName).toBe("python3");
    expect(v.metaVersion).toEqual([""]);
    expect(v.broken).toBe(false);
  });
});

describe("toVersionRow", () => {
  test("strict semver populates the range-query columns", () => {
    expect(toVersionRow("python", "3.11.9")).toMatchObject({
      version: "3.11.9",
      prerelease: false,
      semverMajor: 3,
      semverMinor: 11,
      semverPatch: 9,
      semverPre: null,
    });
  });

  test("prerelease semver keeps its identifiers", () => {
    expect(toVersionRow("python", "3.12.0-rc.1")).toMatchObject({
      prerelease: true,
      semverMajor: 3,
      semverPre: "rc.1",
    });
  });

  test("non-semver versions leave the semver columns NULL", () => {
    for (const version of ["2024-01-05", "1.1.1w", "3.11", "unstable-2023-04-01"]) {
      const v = toVersionRow("pkg", version);
      expect(v.semverMajor, version).toBeNull();
      expect(v.semverMinor, version).toBeNull();
      expect(v.semverPatch, version).toBeNull();
      expect(v.semverPre, version).toBeNull();
    }
  });

  test("prerelease flag follows the ported Go function, not the semver parse", () => {
    // "3.11.0a2" isn't strict semver, but the Go PEP 440 path flags it.
    const v = toVersionRow("python", "3.11.0a2");
    expect(v.prerelease).toBe(true);
    expect(v.semverMajor).toBeNull();
  });

  test("sort keys order versions correctly", () => {
    const keys = ["3.9.1", "3.10.0", "3.11.0"].map((v) => Buffer.from(toVersionRow("p", v).sortKey));
    expect(Buffer.compare(keys[0]!, keys[1]!)).toBe(-1);
    expect(Buffer.compare(keys[1]!, keys[2]!)).toBe(-1);
  });
});

describe("topLevelAttr", () => {
  test("is the attr path only when it has no dot", () => {
    expect(topLevelAttr("python311")).toBe("python311");
    expect(topLevelAttr("python3Packages.requests")).toBeNull();
  });
});

describe("compareVersionOrder", () => {
  test("reports nothing when the two orderings agree", () => {
    const versions = [
      { version: "1.0.0", versionSort: 1 },
      { version: "1.1.0", versionSort: 2 },
      { version: "2.0.0", versionSort: 3 },
    ];
    expect(compareVersionOrder(versions)).toEqual([]);
  });

  test("reports the pair when the old ordering disagreed", () => {
    // Old dense-int order said 1.10.0 < 1.9.0 (a plausible artifact of the
    // non-transitive comparator); the new key orders numerically.
    const versions = [
      { version: "1.9.0", versionSort: 2 },
      { version: "1.10.0", versionSort: 1 },
    ];
    expect(compareVersionOrder(versions)).toEqual([
      { a: "1.9.0", b: "1.10.0", oldOrder: 1, newOrder: -1 },
    ]);
  });

  test("equal version_sort values are not divergences", () => {
    const versions = [
      { version: "1.0", versionSort: 1 },
      { version: "1.0.0", versionSort: 1 },
    ];
    expect(compareVersionOrder(versions)).toEqual([]);
  });
});

describe("packageKey", () => {
  test("is case-insensitive, matching sqlite's NOCASE name column", () => {
    // 354 real packages have case-variant spellings (_86Box / _86box). They
    // are ONE package in the old DB, so they must be one here too.
    expect(packageKey("_86Box")).toBe(packageKey("_86box"));
    expect(packageKey("AMB-plugins")).toBe(packageKey("amb-plugins"));
    expect(packageKey("python")).not.toBe(packageKey("python3"));
  });

  test("versionKey inherits the case-insensitive grouping", () => {
    expect(versionKey("_86Box", "4.2")).toBe(versionKey("_86box", "4.2"));
    expect(versionKey("go", "1.22")).not.toBe(versionKey("go", "1.23"));
  });

  test("versionKey separator cannot collide across name/version splits", () => {
    // "a" + "b.c" must not key the same as "a\tb" + "c".
    expect(versionKey("a", "b.c")).not.toBe(versionKey("a\tb", "c"));
  });
});

describe("canonicalSpelling", () => {
  test("picks the most frequent spelling", () => {
    expect(
      canonicalSpelling([
        { name: "_86Box", count: 3 },
        { name: "_86box", count: 97 },
      ]),
    ).toBe("_86box");
  });

  test("breaks ties deterministically by binary order", () => {
    expect(
      canonicalSpelling([
        { name: "amb-plugins", count: 5 },
        { name: "AMB-plugins", count: 5 },
      ]),
    ).toBe("AMB-plugins");
  });

  test("a single spelling is returned unchanged", () => {
    expect(canonicalSpelling([{ name: "python", count: 12 }])).toBe("python");
  });
});
