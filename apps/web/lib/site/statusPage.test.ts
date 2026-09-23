/**
 * The /status page is a pure function of a Status, so it is tested on
 * literals: what a healthy index and an empty one look like, that every
 * dynamic string is escaped, and the small formatters.
 */

import { describe, expect, test } from "vitest";
import type { CommitRef, Status } from "../status";
import { bytes, esc, relative } from "./format";
import { renderStatusPage } from "./statusPage";

const ORIGIN = "https://nixsearch.com";

const commit = (seq: number, day: number): CommitRef => ({
  seq,
  hash: seq.toString(16).padStart(40, "0"),
  committed_at: new Date(Date.UTC(2026, 8, day)),
  imported_at: new Date(Date.UTC(2026, 8, day, 6)),
});

const empty: Status = {
  counts: { packages: 0, versions: 0, variants: 0, variant_ranges: 0, meta: 0, search_terms: 0, commits: 0 },
  oldest_commit: null,
  newest_commit: null,
  last_import_at: null,
  systems: [],
  database_size_bytes: 8_000_000,
  latest_versions: [{ name: "go", version: null, attr_path: null, systems: [], last_updated: null }],
  generated_at: new Date("2026-09-19T12:00:00Z"),
};

const healthy: Status = {
  counts: {
    packages: 250_123,
    versions: 1_400_456,
    variants: 3_800_789,
    variant_ranges: 4_000_000,
    meta: 300_000,
    search_terms: 260_000,
    commits: 2800,
  },
  oldest_commit: commit(1, 1),
  newest_commit: commit(2800, 19),
  last_import_at: new Date("2026-09-19T09:30:00Z"),
  systems: [
    {
      system: "aarch64-darwin",
      commits: 2800,
      newest: commit(2800, 19),
      last_imported_at: new Date("2026-09-19T09:30:00Z"),
      nix_version: "2.35.3",
    },
    {
      system: "x86_64-darwin",
      commits: 1,
      newest: commit(1, 1),
      last_imported_at: new Date("2026-09-01T06:00:00Z"),
      nix_version: null,
    },
  ],
  database_size_bytes: 3.2 * 1024 ** 3,
  latest_versions: [
    {
      name: "go",
      version: "1.27.0",
      attr_path: "go_1_27",
      systems: ["aarch64-darwin", "aarch64-linux", "x86_64-linux"],
      last_updated: new Date("2026-08-27T07:16:00Z"),
    },
    {
      name: "python",
      version: "3.14.4",
      attr_path: "python314",
      systems: ["aarch64-darwin", "aarch64-linux", "x86_64-darwin", "x86_64-linux"],
      last_updated: new Date("2026-09-18T00:00:00Z"),
    },
    { name: "nope", version: null, attr_path: null, systems: [], last_updated: null },
  ],
  generated_at: new Date("2026-09-19T12:00:00Z"),
};

describe("renderStatusPage", () => {
  test("a healthy index", () => {
    const page = renderStatusPage(healthy, ORIGIN);
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('<a href="/status.json">');

    // Tiles.
    expect(page).toContain("250,123");
    expect(page).toContain("3,800,789");
    expect(page).toContain("3.2 GiB");
    expect(page).toContain("3 hours ago"); // last import, relative to generated_at

    // Systems: one at the head, one frozen at the seed.
    expect(page).toContain("● at head");
    expect(page).toContain("▲ 2,799 behind");
    expect(page).toContain(">seed<");
    expect(page).toContain("2.35.3");
    expect(page).toContain(`href="https://github.com/NixOS/nixpkgs/commit/${"af0".padStart(40, "0")}"`);

    // Latest versions: a cell per system, a gap where a version is missing,
    // and the package name links to its page.
    expect(page).toContain("1.27.0");
    expect(page).toContain("go_1_27");
    expect(page).toContain('href="/pkg/go"');
    const goRow = page.slice(page.indexOf('href="/pkg/go"'), page.indexOf('href="/pkg/python"'));
    expect(goRow.match(/class="y"/g)).toHaveLength(3);
    expect(goRow).toContain('title="not on x86_64-darwin"');
    expect(page).toContain("does not resolve");
  });

  test("an empty index", () => {
    const page = renderStatusPage(empty, ORIGIN);
    expect(page).toContain("Nothing has been imported.");
    expect(page).toContain(">never<");
    expect(page).toContain("7.6 MiB");
    expect(page).toContain("does not resolve");
  });

  test("escapes everything it interpolates", () => {
    const hostile: Status = {
      ...healthy,
      systems: [{ ...healthy.systems[0]!, system: "<script>", nix_version: '"quoted"' }],
      latest_versions: [
        { name: "a&b", version: "<1>", attr_path: "x'y", systems: ["<sys>"], last_updated: new Date(0) },
      ],
    };
    const page = renderStatusPage(hostile, ORIGIN);
    // The shell carries exactly one <script> (the progressive
    // enhancements); a second one could only have come from the data.
    expect(page.match(/<script>/g)).toHaveLength(1);
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("&quot;quoted&quot;");
    expect(page).toContain("a&amp;b");
    expect(page).toContain("&lt;1&gt;");
    expect(page).toContain("x&#39;y");
    // The system indicator has a fixed set of columns, so an unknown
    // system is not rendered at all rather than rendered escaped.
    expect(page).not.toContain("<sys>");
  });
});

describe("formatters", () => {
  test("esc", () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  test("bytes", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(1023)).toBe("1023 B");
    expect(bytes(1024)).toBe("1.0 KiB");
    expect(bytes(1.5 * 1024 ** 2)).toBe("1.5 MiB");
    expect(bytes(2 * 1024 ** 4)).toBe("2.0 TiB");
  });

  test("relative", () => {
    const now = new Date("2026-09-19T12:00:00Z");
    const ago = (ms: number) => relative(new Date(now.getTime() - ms), now);
    expect(ago(0)).toBe("just now");
    expect(ago(59_000)).toBe("just now");
    expect(ago(60_000)).toBe("1 minute ago");
    expect(ago(5 * 60_000)).toBe("5 minutes ago");
    expect(ago(3_600_000)).toBe("1 hour ago");
    expect(ago(23 * 3_600_000)).toBe("23 hours ago");
    expect(ago(30 * 3_600_000)).toBe("1 day ago");
    expect(ago(48 * 3_600_000)).toBe("2 days ago");
    expect(ago(59 * 86_400_000)).toBe("59 days ago");
    expect(ago(61 * 86_400_000)).toBe("2 months ago");
    expect(ago(800 * 86_400_000)).toBe("2 years ago");
    expect(relative(new Date(now.getTime() + 60_000), now)).toBe("in the future");
  });
});
