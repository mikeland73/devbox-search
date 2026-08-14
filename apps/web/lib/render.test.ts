import { describe, expect, test } from "vitest";
import {
  group,
  omitEmpty,
  renderLegacyVersions,
  renderSearch,
  renderV1Search,
  renderV2Pkg,
  renderV2Resolve,
  renderV2Search,
  rfc3339,
  summarizeOutputs,
  summarizePlatforms,
  unixSeconds,
} from "./render";
import type { ResultPackage } from "./search";

function pkg(overrides: Partial<ResultPackage> = {}): ResultPackage {
  return {
    name: "python",
    version: "3.11.9",
    commitHash: "a".repeat(40),
    lastUpdated: new Date("2024-03-08T13:51:52Z"),
    storeHash: "9xc41alhnbx27a4jc2bmp4w54mq8gvfn",
    storeName: "python3",
    storeVersion: "3.11.9",
    metaName: "python3-3.11.9",
    metaVersion: [""],
    attrPath: "python311",
    system: "x86_64-linux",
    program: "python3",
    summary: "High-level dynamically-typed programming language",
    description: "",
    homepage: "https://www.python.org",
    license: "PSF-2.0",
    broken: false,
    insecure: false,
    platforms: ["aarch64-darwin", "aarch64-linux", "x86_64-darwin", "x86_64-linux", "riscv64-linux"],
    outputs: [{ name: "out", path: "/nix/store/abc-python3-3.11.9", default: true }],
    ...overrides,
  };
}

describe("omitEmpty (Go omitempty semantics)", () => {
  test("drops zero values entirely rather than emitting null/false/empty", () => {
    expect(omitEmpty({ a: "", b: false, c: 0, d: [], e: null, f: undefined })).toEqual({});
  });

  test("keeps non-zero values, including empty objects (Go structs aren't zero-checked)", () => {
    expect(omitEmpty({ a: "x", b: true, c: 1, d: ["y"], e: {} })).toEqual({
      a: "x",
      b: true,
      c: 1,
      d: ["y"],
      e: {},
    });
  });

  test("a dropped key is absent from JSON, not null", () => {
    expect(JSON.stringify(omitEmpty({ broken: false, name: "go" }))).toBe('{"name":"go"}');
  });
});

describe("timestamps", () => {
  test("v2 uses RFC 3339 without fractional seconds", () => {
    expect(rfc3339(new Date("2024-03-08T13:51:52.123Z"))).toBe("2024-03-08T13:51:52Z");
    expect(rfc3339(new Date("2026-08-01T16:34:20Z"))).toBe("2026-08-01T16:34:20Z");
  });

  test("v1 uses unix seconds as a number", () => {
    expect(unixSeconds(new Date("2024-03-08T13:51:52Z"))).toBe(1709905912);
  });
});

describe("group (port of nixpkgs.Group)", () => {
  test("groups consecutive runs only, preserving order", () => {
    expect(group(["a", "a", "b", "a"], (s) => s)).toEqual([["a", "a"], ["b"], ["a"]]);
  });

  test("empty input yields no groups", () => {
    expect(group([], (s: string) => s)).toEqual([]);
  });
});

describe("renderV2Resolve", () => {
  test("matches the shape of a recorded live response", () => {
    const rendered = renderV2Resolve([
      pkg({ system: "aarch64-darwin" }),
      pkg({ system: "aarch64-linux" }),
      // A second attribute path for the same system is ignored.
      pkg({ system: "aarch64-linux", attrPath: "python3" }),
    ]) as Record<string, unknown>;

    expect(rendered["name"]).toBe("python");
    expect(rendered["version"]).toBe("3.11.9");
    expect(rendered["summary"]).toBe("High-level dynamically-typed programming language");
    const systems = rendered["systems"] as Record<string, unknown>;
    expect(Object.keys(systems)).toEqual(["aarch64-darwin", "aarch64-linux"]);
    expect(systems["aarch64-linux"]).toEqual({
      flake_installable: {
        ref: { type: "github", owner: "NixOS", repo: "nixpkgs", rev: "a".repeat(40) },
        attr_path: "python311",
      },
      last_updated: "2024-03-08T13:51:52Z",
      outputs: [{ name: "out", path: "/nix/store/abc-python3-3.11.9", default: true }],
    });
  });

  test("omits outputs when there are none (omitempty)", () => {
    const rendered = renderV2Resolve([pkg({ outputs: [] })]) as Record<string, unknown>;
    const system = (rendered["systems"] as Record<string, unknown>)["x86_64-linux"];
    expect(system).not.toHaveProperty("outputs");
  });

  test("a non-default output omits the default key rather than emitting false", () => {
    const rendered = renderV2Resolve([
      pkg({ outputs: [{ name: "man", path: "/nix/store/x-man", default: false }] }),
    ]) as Record<string, unknown>;
    const system = (rendered["systems"] as Record<string, Record<string, unknown>>)["x86_64-linux"]!;
    expect(system["outputs"]).toEqual([{ name: "man", path: "/nix/store/x-man" }]);
  });
});

describe("renderV2Search", () => {
  test("echoes the query and counts results", () => {
    expect(renderV2Search("python", [pkg(), pkg({ name: "python3" })])).toEqual({
      query: "python",
      total_results: 2,
      results: [
        {
          name: "python",
          summary: "High-level dynamically-typed programming language",
          last_updated: "2024-03-08T13:51:52Z",
        },
        {
          name: "python3",
          summary: "High-level dynamically-typed programming language",
          last_updated: "2024-03-08T13:51:52Z",
        },
      ],
    });
  });
});

describe("renderV2Pkg", () => {
  test("groups releases by version with per-platform detail", () => {
    const rendered = renderV2Pkg([
      pkg({ version: "3.11.9", system: "x86_64-linux" }),
      pkg({ version: "3.11.9", system: "aarch64-darwin" }),
      pkg({ version: "3.10.0", system: "x86_64-linux" }),
    ]) as Record<string, unknown>;

    expect(rendered["name"]).toBe("python");
    expect(rendered["homepage_url"]).toBe("https://www.python.org");
    const releases = rendered["releases"] as Array<Record<string, unknown>>;
    expect(releases).toHaveLength(2);
    expect(releases[0]!["version"]).toBe("3.11.9");
    const platforms = releases[0]!["platforms"] as Array<Record<string, unknown>>;
    expect(platforms.map((p) => p["system"])).toEqual(["x86_64-linux", "aarch64-darwin"]);
    expect(platforms[0]).toMatchObject({ arch: "x86-64", os: "Linux" });
    expect(platforms[1]).toMatchObject({ arch: "arm64", os: "macOS" });
  });

  test("a duplicate arch+os within a release is skipped", () => {
    const rendered = renderV2Pkg([
      pkg({ system: "x86_64-linux", attrPath: "python311" }),
      pkg({ system: "x86_64-linux", attrPath: "python3" }),
    ]) as Record<string, unknown>;
    const releases = rendered["releases"] as Array<Record<string, unknown>>;
    expect(releases[0]!["platforms"]).toHaveLength(1);
  });
});

describe("summarizePlatforms", () => {
  const cases: Array<[string[], string]> = [
    [["x86_64-linux"], "Linux"],
    [["x86_64-linux", "aarch64-linux"], "Linux"],
    [["aarch64-darwin", "x86_64-darwin"], "macOS"],
    [["aarch64-darwin"], "macOS (Apple Silicon only)"],
    [["x86_64-darwin"], "macOS (Intel only)"],
    [["x86_64-linux", "aarch64-darwin", "x86_64-darwin"], "Linux and macOS"],
    [["x86_64-linux", "x86_64-darwin"], "Linux and macOS (Intel only)"],
    [["x86_64-linux", "aarch64-darwin"], "Linux and macOS (Apple Silicon only)"],
    [[], ""],
    [["riscv64-linux"], ""],
  ];
  test.each(cases)("%j -> %s", (systems, want) => {
    expect(summarizePlatforms(systems.map((s) => pkg({ system: s })))).toBe(want);
  });
});

describe("summarizeOutputs", () => {
  test("returns empty when every output is installed by default", () => {
    expect(
      summarizeOutputs([pkg({ outputs: [{ name: "out", path: "/x", default: true }] })]),
    ).toBe("");
  });

  test("lists defaults first, then others alphabetically, with OS qualifiers", () => {
    const summary = summarizeOutputs([
      pkg({
        system: "x86_64-linux",
        outputs: [
          { name: "out", path: "/x", default: true },
          { name: "debug", path: "/d", default: false },
        ],
      }),
      pkg({
        system: "aarch64-darwin",
        outputs: [
          { name: "out", path: "/x", default: true },
          { name: "man", path: "/m", default: false },
        ],
      }),
    ]);
    expect(summary).toBe("out, debug (Linux only), man (macOS only)");
  });
});

describe("renderLegacyVersions (v1 shape)", () => {
  test("emits unix-second timestamps and a per-system map", () => {
    const rendered = renderLegacyVersions([
      pkg({ system: "x86_64-linux" }),
      pkg({ system: "aarch64-darwin" }),
    ]) as Array<Record<string, unknown>>;

    expect(rendered).toHaveLength(1);
    const release = rendered[0]!;
    expect(release["name"]).toBe("python");
    expect(release["version"]).toBe("3.11.9");
    expect(release["last_updated"]).toBe(1709905912);
    expect(typeof release["last_updated"]).toBe("number");

    const systems = release["systems"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(systems).sort()).toEqual(["aarch64-darwin", "x86_64-linux"]);
    expect(systems["x86_64-linux"]).toMatchObject({
      system: "x86_64-linux",
      store_name: "python3",
      meta_name: "python3-3.11.9",
      attr_paths: ["python311"],
      programs: ["python3"],
    });
  });

  test("filters platforms devbox does not support", () => {
    const rendered = renderLegacyVersions([pkg()]) as Array<Record<string, unknown>>;
    expect(rendered[0]!["platforms"]).toEqual([
      "aarch64-darwin",
      "aarch64-linux",
      "x86_64-darwin",
      "x86_64-linux",
    ]);
  });

  test("false booleans are omitted, true ones kept", () => {
    const ok = renderLegacyVersions([pkg()]) as Array<Record<string, unknown>>;
    const systems = ok[0]!["systems"] as Record<string, Record<string, unknown>>;
    expect(systems["x86_64-linux"]).not.toHaveProperty("broken");

    const broken = renderLegacyVersions([pkg({ broken: true })]) as Array<Record<string, unknown>>;
    const brokenSystems = broken[0]!["systems"] as Record<string, Record<string, unknown>>;
    expect(brokenSystems["x86_64-linux"]!["broken"]).toBe(true);
  });

  test("collects every attribute path for a system", () => {
    const rendered = renderLegacyVersions([
      pkg({ attrPath: "python311" }),
      pkg({ attrPath: "python3" }),
    ]) as Array<Record<string, unknown>>;
    const systems = rendered[0]!["systems"] as Record<string, Record<string, unknown>>;
    expect(systems["x86_64-linux"]!["attr_paths"]).toEqual(["python311", "python3"]);
  });
});

describe("renderV1Search", () => {
  test("counts packages, not rows, and nests versions", () => {
    const rendered = renderV1Search([
      pkg({ name: "python", version: "3.11.9" }),
      pkg({ name: "python", version: "3.10.0" }),
      pkg({ name: "go", version: "1.22.5" }),
    ]) as Record<string, unknown>;

    expect(rendered["num_results"]).toBe(2);
    const packages = rendered["packages"] as Array<Record<string, unknown>>;
    expect(packages[0]!["name"]).toBe("python");
    expect(packages[0]!["num_versions"]).toBe(2);
    expect(packages[1]!["num_versions"]).toBe(1);
  });

  test("no results omits the packages key entirely", () => {
    expect(renderV1Search([])).toEqual({ num_results: 0 });
  });
});

describe("renderSearch (/search shape)", () => {
  test("wraps results in metadata and compacts by pname+version", () => {
    const rendered = renderSearch([
      pkg({ name: "python", system: "x86_64-linux" }),
      // Same pname+version on another system collapses away.
      pkg({ name: "python", system: "aarch64-linux" }),
      pkg({ name: "python", version: "3.10.0", storeVersion: "3.10.0", metaName: "python3-3.10.0" }),
    ]) as Record<string, unknown>;

    expect(rendered["metadata"]).toEqual({ total_results: 1 });
    const results = rendered["results"] as Array<Record<string, unknown>>;
    const packages = results[0]!["packages"] as Array<Record<string, unknown>>;
    expect(packages).toHaveLength(2);
    expect(packages[0]).toMatchObject({
      attribute_path: "python311",
      pname: "python3-3.11.9",
      version: "3.11.9",
      date: "2024-03-08T13:51:52Z",
    });
  });
});
