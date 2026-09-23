/**
 * The pages are pure functions of a v2 response, so they are tested on
 * literals: what each one says about a given shape, and that every dynamic
 * string is escaped on the way into HTML.
 */

import { describe, expect, test } from "vitest";
import type { V2Pkg, V2Release, V2Resolve, V2Search } from "../render";
import { renderResultsPage, highlight } from "./results";
import { renderPkgPage } from "./pkg";
import { renderReleasePage } from "./release";
import { renderNotFoundPage } from "./notFound";
import { renderSitemap, renderSitemapIndex } from "./sitemap";
import { splitRef } from "./links";

const ORIGIN = "https://nixsearch.com";
const NOW = new Date("2026-09-21T12:00:00Z");

const platform = (system: string, over: Partial<V2Release["platforms"][number]> = {}) => ({
  arch: system.startsWith("x86") ? "x86-64" : "arm64",
  os: system.endsWith("darwin") ? "macOS" : "Linux",
  system,
  attribute_path: "python311",
  commit_hash: "a".repeat(40),
  date: "2026-09-13T01:58:51Z",
  outputs: [{ name: "out", path: `/nix/store/abc-python-${system}`, default: true }],
  broken: false,
  insecure: false,
  ...over,
});

const release = (over: Partial<V2Release> = {}): V2Release => ({
  version: "3.11.16",
  last_updated: "2026-09-13T01:58:51Z",
  platforms: [platform("aarch64-darwin"), platform("x86_64-linux")],
  platforms_summary: "Linux and macOS (Apple Silicon only)",
  outputs_summary: "out, debug (Linux only)",
  prerelease: false,
  broken: false,
  insecure: false,
  ...over,
});

const pkg = (over: Partial<V2Pkg> = {}): V2Pkg => ({
  name: "python",
  summary: "High-level dynamically-typed programming language",
  description: "A long description.",
  homepage_url: "https://www.python.org",
  license: "Python-2.0",
  attribute_paths: ["python3", "python311"],
  releases: [release(), release({ version: "3.10.19", prerelease: false })],
  ...over,
});

const resolved = (over: Partial<V2Resolve> = {}): V2Resolve => ({
  name: "python",
  version: "3.11.16",
  summary: "High-level dynamically-typed programming language",
  systems: {
    "aarch64-darwin": {
      flake_installable: {
        ref: { type: "github", owner: "NixOS", repo: "nixpkgs", rev: "a".repeat(40) },
        attr_path: "python311",
      },
      last_updated: "2026-09-13T01:58:51Z",
    },
    "x86_64-linux": {
      flake_installable: {
        ref: { type: "github", owner: "NixOS", repo: "nixpkgs", rev: "a".repeat(40) },
        attr_path: "python311",
      },
      last_updated: "2026-09-13T01:58:51Z",
    },
  },
  ...over,
});

describe("results page", () => {
  const result: V2Search = {
    query: "go",
    total_results: 2,
    results: [
      {
        name: "go",
        summary: "Go Programming language",
        last_updated: "2026-09-13T01:58:51Z",
        version: "1.27.1",
        attribute_path: "go_1_27",
        systems: ["aarch64-darwin", "aarch64-linux", "x86_64-linux"],
      },
      {
        name: "go-task",
        summary: "Task runner",
        last_updated: "2026-09-13T01:58:51Z",
        version: "3.38.0",
        attribute_path: "go-task",
        systems: ["x86_64-linux"],
      },
    ],
  };

  test("one row per package, linking to its page, with the match marked", () => {
    const page = renderResultsPage(result, NOW, ORIGIN);
    expect(page).toContain('href="/pkg/go"');
    expect(page).toContain('href="/pkg/go-task"');
    expect(page).toContain("<mark>go</mark>-task");
    expect(page).toContain("1.27.1");
    expect(page).toContain("go_1_27");
    // The attribute column is empty when it is the name again.
    expect(page).not.toContain("<code class=\"muted\">go-task</code>");
  });

  test("a system a package is missing shows as a gap, not an absence", () => {
    const page = renderResultsPage(result, NOW, ORIGIN);
    const taskRow = page.slice(page.indexOf('href="/pkg/go-task"'));
    expect(taskRow).toContain('title="not on aarch64-darwin"');
  });

  test("an empty result explains the case rules instead of 404ing", () => {
    const page = renderResultsPage({ query: "zzz", total_results: 0, results: [] }, NOW, ORIGIN);
    expect(page).toContain("No package matches");
    expect(page).toContain("case-sensitively");
  });

  test("a full page says the API capped it", () => {
    const many: V2Search = {
      query: "go",
      total_results: 50,
      results: Array.from({ length: 50 }, (_, i) => ({ ...result.results[0]!, name: `go${i}` })),
    };
    expect(renderResultsPage(many, NOW, ORIGIN)).toContain("at most 50");
  });

  test("highlight marks the first match only, escaping every fragment", () => {
    expect(highlight("go-task", "go")).toBe("<mark>go</mark>-task");
    expect(highlight("<b>", "b")).toBe("&lt;<mark>b</mark>&gt;");
    expect(highlight("abc", "zz")).toBe("abc");
    expect(highlight("<i>", "")).toBe("&lt;i&gt;");
  });
});

describe("package page", () => {
  test("shows the resolve answer, both commands, and one rev for every system", () => {
    const page = renderPkgPage({ pkg: pkg(), constraint: "3.11", resolved: resolved(), now: NOW, origin: ORIGIN });
    expect(page).toContain("devbox add python@3.11.16");
    expect(page).toContain(`nix shell github:NixOS/nixpkgs/${"a".repeat(40)}#python311`);
    expect(page).toContain("one commit for every system");
    expect(page).toContain('value="3.11"');
    // x86_64-darwin is not in the answer, so it reads as struck through.
    expect(page).toContain('class="off"');
  });

  test("lists a rev per system when the systems disagree", () => {
    const split = resolved();
    split.systems["x86_64-linux"]!.flake_installable.ref.rev = "b".repeat(40);
    const page = renderPkgPage({ pkg: pkg(), constraint: "latest", resolved: split, now: NOW, origin: ORIGIN });
    expect(page).not.toContain("one commit for every system");
    expect(page).toContain(`nix shell github:NixOS/nixpkgs/${"b".repeat(40)}#python311  # x86_64-linux`);
  });

  test("a constraint that matches nothing explains itself and keeps the table", () => {
    const page = renderPkgPage({ pkg: pkg(), constraint: "9.99", resolved: null, now: NOW, origin: ORIGIN });
    expect(page).toContain("No version of");
    expect(page).toContain("does not match");
    expect(page).toContain("3.11.16"); // the releases table is still there
  });

  test("badges the resolved release, prereleases and broken ones", () => {
    const page = renderPkgPage({
      pkg: pkg({
        releases: [
          release({ version: "3.15.0rc2", prerelease: true }),
          release(),
          release({ version: "2.7.18", insecure: true }),
        ],
      }),
      constraint: "latest",
      resolved: resolved(),
      now: NOW,
      origin: ORIGIN,
    });
    expect(page).toContain('<span class="badge latest">resolved</span>');
    expect(page).toContain('<span class="badge pre">pre</span>');
    expect(page).toContain('<span class="badge broken">insecure</span>');
  });

  test("says a commit varies when the systems last changed at different ones", () => {
    const mixed = release({
      platforms: [platform("aarch64-darwin"), platform("x86_64-linux", { commit_hash: "c".repeat(40) })],
    });
    const page = renderPkgPage({
      pkg: pkg({ releases: [mixed] }),
      constraint: "latest",
      resolved: null,
      now: NOW,
      origin: ORIGIN,
    });
    expect(page).toContain("varies");
  });

  test("escapes everything it interpolates", () => {
    const page = renderPkgPage({
      pkg: pkg({
        name: "a&b",
        summary: "<script>alert(1)</script>",
        attribute_paths: ["x'y"],
        homepage_url: "https://example.com/?a=1&b=2",
        releases: [release({ version: "<1>" })],
      }),
      constraint: '"><script>',
      resolved: null,
      now: NOW,
      origin: ORIGIN,
    });
    expect(page.match(/<script>/g)).toHaveLength(1); // the shell's own
    expect(page).toContain("a&amp;b");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("x&#39;y");
    expect(page).toContain("&lt;1&gt;");
    expect(page).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("release page", () => {
  test("one pin block per distinct commit, with the systems it covers", () => {
    const mixed = release({
      platforms: [
        platform("aarch64-darwin"),
        platform("aarch64-linux"),
        platform("x86_64-linux", { commit_hash: "c".repeat(40), attribute_path: "python3" }),
      ],
    });
    const page = renderReleasePage({
      pkg: pkg({ releases: [mixed] }),
      release: mixed,
      newer: undefined,
      older: undefined,
      origin: ORIGIN,
    });
    expect(page).toContain("aarch64-darwin, aarch64-linux");
    expect(page).toContain(`github:NixOS/nixpkgs/${"a".repeat(40)}#python311`);
    expect(page).toContain(`github:NixOS/nixpkgs/${"c".repeat(40)}#python3`);
    expect(page).toContain("devbox add python@3.11.16");
  });

  test("links its neighbours and the package", () => {
    const releases = [release({ version: "3.12.0" }), release(), release({ version: "3.10.0" })];
    const page = renderReleasePage({
      pkg: pkg({ releases }),
      release: releases[1]!,
      newer: releases[0],
      older: releases[2],
      origin: ORIGIN,
    });
    expect(page).toContain('href="/pkg/python/3.12.0"');
    expect(page).toContain('href="/pkg/python/3.10.0"');
    expect(page).toContain('href="/pkg/python"');
  });

  test("shows per-system flags and store paths", () => {
    const broken = release({
      platforms: [platform("x86_64-linux", { broken: true })],
      broken: true,
    });
    const page = renderReleasePage({
      pkg: pkg({ releases: [broken] }),
      release: broken,
      newer: undefined,
      older: undefined,
      origin: ORIGIN,
    });
    expect(page).toContain("/nix/store/abc-python-x86_64-linux");
    expect(page.match(/badge broken/g)?.length).toBeGreaterThanOrEqual(2); // heading + row
  });
});

describe("not found page", () => {
  test("offers a search for the name that missed", () => {
    const page = renderNotFoundPage({ heading: "No package named zz", detail: "…", suggest: "zz", origin: ORIGIN });
    expect(page).toContain('href="/search?q=zz"');
  });
});

describe("sitemaps", () => {
  test("the index lists one file per page", () => {
    const xml = renderSitemapIndex(ORIGIN, 3);
    expect(xml.match(/<sitemap>/g)).toHaveLength(3);
    expect(xml).toContain("https://nixsearch.com/sitemaps/3.xml");
  });

  test("a page lists absolute, escaped package URLs", () => {
    const xml = renderSitemap(ORIGIN, ["python", "a&b", "nodePackages.typescript"]);
    expect(xml).toContain("<loc>https://nixsearch.com/pkg/python</loc>");
    expect(xml).toContain("<loc>https://nixsearch.com/pkg/a%26b</loc>");
    expect(xml).toContain("<loc>https://nixsearch.com/pkg/nodePackages.typescript</loc>");
  });
});

describe("splitRef", () => {
  test("splits a devbox reference at the first @, keeping the constraint whole", () => {
    expect(splitRef("python")).toEqual({ name: "python" });
    expect(splitRef("python@3.11")).toEqual({ name: "python", version: "3.11" });
    expect(splitRef("go@^1.22")).toEqual({ name: "go", version: "^1.22" });
    expect(splitRef("go@>=1.2 <2")).toEqual({ name: "go", version: ">=1.2 <2" });
    // A leading @ is part of the name (npm-scoped attribute paths).
    expect(splitRef("@scope/pkg")).toEqual({ name: "@scope/pkg" });
  });
});
