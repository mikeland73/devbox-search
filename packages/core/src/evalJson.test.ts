import { describe, expect, test } from "vitest";
import {
  canonicalJson,
  contentHash,
  decodeEvalJson,
  metaHash,
  packageName,
  sha256Hex,
  type EvalPackage,
} from "./evalJson.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const COMMITTED_AT = new Date("2026-08-01T00:00:00Z");

/** A nix-env style eval fixture exercising the decoder's edge cases. */
const nixEnvFixture = {
  go: {
    name: "go-1.22.5",
    pname: "go",
    version: "1.22.5",
    system: "x86_64-linux",
    outputName: "out",
    outputs: {
      out: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-go-1.22.5",
      doc: "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-go-1.22.5-doc",
      lib: "/nix/store/cccccccccccccccccccccccccccccccc-go-1.22.5-lib",
    },
    meta: {
      available: true,
      broken: false,
      description: "The Go Programming language",
      homepage: "https://go.dev/",
      license: { spdxId: "BSD-3-Clause", fullName: "BSD 3-clause License" },
      mainProgram: "go",
      outputsToInstall: ["out", "doc"],
      platforms: ["x86_64-linux", "aarch64-linux"],
      version: "1.22.5",
      name: "go-1.22.5",
    },
  },
  "python3Packages.requests": {
    name: "python3.11-requests-2.31.0",
    pname: "python3.11-requests",
    version: "2.31.0",
    system: "x86_64-linux",
    outputName: "out",
    outputs: { out: "/nix/store/dddddddddddddddddddddddddddddddd-python3.11-requests-2.31.0" },
    meta: {
      description: "  HTTP library  ", // whitespace to be trimmed
      // homepage as a list; first non-empty wins.
      homepage: ["", "https://requests.readthedocs.io"],
      // license list without spdxId objects: first string wins.
      license: [{ fullName: "Apache 2" }, "Apache 2.0", "MIT"],
      // nested platform arrays (old nixpkgs bug) + object platforms filtered.
      platforms: [["x86_64-linux"], ["aarch64-linux"], { cpu: {} }, "x86_64-linux"],
      broken: true,
      insecure: true,
    },
  },
  brokenMeta: {
    // Missing system: Hydra assumed x86_64-linux. No outputs at all.
    name: "weird",
    pname: "weird",
    version: "1.0",
    meta: {},
  },
} as const;

describe("decodeEvalJson", () => {
  const eval_ = decodeEvalJson(nixEnvFixture, COMMIT, COMMITTED_AT);
  const byAttr = new Map(eval_.packages.map((p) => [p.attrPath, p]));

  test("eval header", () => {
    expect(eval_.commit).toBe(COMMIT);
    expect(eval_.system).toBe("x86_64-linux");
    expect(eval_.count).toBe(3);
    expect(eval_.committedAt).toBe(COMMITTED_AT);
  });

  test("clean package with default output first, then outputsToInstall, then rest sorted", () => {
    const go = byAttr.get("go")!;
    expect(go.storeHash).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(go.storeName).toBe("go");
    expect(go.storeVersion).toBe("1.22.5");
    expect(go.metaName).toBe("go-1.22.5");
    expect(go.metaVersion).toEqual(["1.22.5"]);
    expect(go.program).toBe("go");
    expect(go.summary).toBe("The Go Programming language");
    expect(go.license).toBe("BSD-3-Clause");
    expect(go.homepage).toBe("https://go.dev/");
    expect(go.platforms).toEqual(["aarch64-linux", "x86_64-linux"]); // sorted
    expect(go.outputs).toEqual([
      { name: "out", path: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-go-1.22.5", default: true },
      { name: "doc", path: "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-go-1.22.5-doc", default: true },
      { name: "lib", path: "/nix/store/cccccccccccccccccccccccccccccccc-go-1.22.5-lib", default: false },
    ]);
    expect(packageName(go)).toBe("go");
  });

  test("oneOrMany flattening, license/homepage selection, trimming, flags", () => {
    const requests = byAttr.get("python3Packages.requests")!;
    expect(requests.summary).toBe("HTTP library");
    expect(requests.homepage).toBe("https://requests.readthedocs.io");
    expect(requests.license).toBe("Apache 2.0"); // first string; objects without spdxId skipped
    expect(requests.platforms).toEqual(["aarch64-linux", "x86_64-linux"]); // flattened, filtered, deduped
    expect(requests.broken).toBe(true);
    expect(requests.insecure).toBe(true);
    expect(packageName(requests)).toBe("python3Packages.requests");
  });

  test("missing system defaults to x86_64-linux; no outputs -> empty store hash", () => {
    const weird = byAttr.get("brokenMeta")!;
    expect(weird.system).toBe("x86_64-linux");
    expect(weird.storeHash).toBe("");
    expect(weird.outputs).toEqual([]);
    expect(weird.broken).toBe(false);
  });

  test("hydra packages.json wrapper decodes identically", () => {
    const hydra = decodeEvalJson({ version: 2, packages: nixEnvFixture }, COMMIT, COMMITTED_AT);
    expect(hydra.packages).toEqual(eval_.packages);
  });

  test("rejects non-object top level (legacy pkgmeta schema)", () => {
    expect(() => decodeEvalJson([{ commit: COMMIT }, {}], COMMIT, COMMITTED_AT)).toThrow(TypeError);
  });
});

describe("canonicalJson", () => {
  test("sorts object keys and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  });

  test("does not HTML-escape", () => {
    expect(canonicalJson("<a> & </a>")).toBe('"<a> & </a>"');
  });

  test("null, undefined, and primitives", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined])).toBe("[null]");
    expect(canonicalJson(true)).toBe("true");
  });
});

describe("hashing", () => {
  const pkg: EvalPackage = {
    storeHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    storeName: "go",
    storeVersion: "1.22.5",
    metaName: "go-1.22.5",
    metaVersion: ["1.22.5"],
    attrPath: "go",
    system: "x86_64-linux",
    program: "go",
    summary: "The Go Programming language",
    description: "",
    homepage: "https://go.dev/",
    license: "BSD-3-Clause",
    broken: false,
    insecure: false,
    platforms: ["aarch64-linux", "x86_64-linux"],
    outputs: [{ name: "out", path: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-go-1.22.5", default: true }],
  };

  test("sha256Hex", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("metaHash ignores identity and content fields outside the meta blob", () => {
    const h = metaHash(pkg);
    expect(metaHash({ ...pkg, attrPath: "other", storeVersion: "9.9.9" })).toBe(h);
    expect(metaHash({ ...pkg, summary: "changed" })).not.toBe(h);
    expect(metaHash({ ...pkg, platforms: ["x86_64-linux"] })).not.toBe(h);
  });

  test("contentHash ignores identity fields but sees content changes", () => {
    const h = contentHash(pkg);
    expect(contentHash({ ...pkg, attrPath: "go_1_22", system: "aarch64-linux" })).toBe(h);
    expect(contentHash({ ...pkg, storeHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })).not.toBe(h);
    expect(contentHash({ ...pkg, broken: true })).not.toBe(h);
    expect(
      contentHash({ ...pkg, outputs: [{ ...pkg.outputs[0]!, default: false }] }),
    ).not.toBe(h);
  });

  test("hashes are stable across runs (golden)", () => {
    // Literal digests pin the whole pipeline — field list, canonical
    // serialization, and SHA-256 encoding. A change to any of them means every
    // stored meta_hash/content_hash would be invalidated, so update these only
    // deliberately (and plan a re-import).
    expect(metaHash(pkg)).toBe("7e2aa28e6ea094f57559a6ce3e03bd89cb34ececb81775add94a1ce109653ad1");
    expect(contentHash(pkg)).toBe("1005ccace6cbc119d5a5e830e77620ea9827fda93177205d1b290eb7bf3e41fb");
  });

  test("golden hashes cover the expected field list", () => {
    // Companion to the literals above: shows which fields feed each hash.
    expect(metaHash(pkg)).toBe(sha256Hex(canonicalJson({
      description: "",
      homepage: "https://go.dev/",
      license: "BSD-3-Clause",
      platforms: ["aarch64-linux", "x86_64-linux"],
      summary: "The Go Programming language",
    })));
  });
});
