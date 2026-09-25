/**
 * /status.json against an in-process Postgres: the numbers must reflect the
 * seeded fixtures, the commit endpoints must be the first and last seq, the
 * per-system view must surface a system frozen at an older commit, and the
 * `latest` lookup must agree with what /v2/resolve would say.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { commitSystems } from "@devbox-search/db";
import { resolve } from "./search";
import { COMMON_PACKAGES, homeStatus, latestVersions, status } from "./status";
import { createTestDb, seedCommits, seedPackage, type TestDb } from "./testDb";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
}, 120_000);

afterEach(async () => {
  await t?.close();
});

describe("status", () => {
  test("empty database", async () => {
    const s = await status();
    expect(s.counts).toEqual({
      packages: 0,
      versions: 0,
      variants: 0,
      variant_ranges: 0,
      meta: 0,
      search_terms: 0,
      commits: 0,
    });
    expect(s.oldest_commit).toBeNull();
    expect(s.newest_commit).toBeNull();
    expect(s.last_import_at).toBeNull();
    expect(s.systems).toEqual([]);
    expect(s.database_size_bytes).toBeGreaterThan(0);
    // Every common package is listed, none resolves.
    expect(s.latest_versions.map((l) => l.name)).toEqual([...COMMON_PACKAGES]);
    expect(new Set(s.latest_versions.map((l) => l.version))).toEqual(new Set([null]));
    expect(s.generated_at).toBeInstanceOf(Date);
  });

  test("counts, commit span and per-system import state", async () => {
    await seedCommits(t.db, 3);
    // x86_64-linux is current; aarch64-darwin is frozen at seq 2 and has no
    // recorded Nix version (a seeded row).
    await t.db.insert(commitSystems).values([
      { commitSeq: 1, system: "x86_64-linux", nixVersion: "2.35.2", importedAt: new Date("2026-09-01T00:00:00Z") },
      { commitSeq: 2, system: "x86_64-linux", nixVersion: "2.35.2", importedAt: new Date("2026-09-02T00:00:00Z") },
      { commitSeq: 3, system: "x86_64-linux", nixVersion: "2.35.3", importedAt: new Date("2026-09-03T00:00:00Z") },
      { commitSeq: 1, system: "aarch64-darwin", importedAt: new Date("2026-09-01T00:00:00Z") },
      { commitSeq: 2, system: "aarch64-darwin", importedAt: new Date("2026-09-02T00:00:00Z") },
    ]);
    await seedPackage(t.db, {
      name: "go",
      versions: [
        { version: "1.21.0", systems: ["x86_64-linux", "aarch64-darwin"] },
        { version: "1.22.0", systems: ["x86_64-linux"] },
      ],
    });
    await seedPackage(t.db, { name: "python3", versions: [{ version: "3.12.0", systems: ["x86_64-linux"] }] });

    const s = await status();

    expect(s.counts).toEqual({
      packages: 2,
      versions: 3,
      variants: 4,
      variant_ranges: 4, // one open range per variant (see FixtureVersion.lastSeq)
      meta: 2,
      search_terms: 2,
      commits: 3,
    });

    expect(s.oldest_commit).toMatchObject({ seq: 1, hash: "1".padStart(40, "0") });
    expect(s.oldest_commit!.committed_at).toEqual(new Date(Date.UTC(2026, 0, 1)));
    expect(s.newest_commit).toMatchObject({ seq: 3, hash: "3".padStart(40, "0") });
    expect(s.newest_commit!.committed_at).toEqual(new Date(Date.UTC(2026, 0, 3)));
    expect(s.newest_commit!.imported_at).toBeInstanceOf(Date);

    expect(s.systems.map((x) => x.system)).toEqual(["aarch64-darwin", "x86_64-linux"]);
    const [darwin, linux] = s.systems;
    expect(linux).toMatchObject({ commits: 3, nix_version: "2.35.3" });
    expect(linux!.newest.seq).toBe(3);
    expect(linux!.last_imported_at).toEqual(new Date("2026-09-03T00:00:00Z"));
    expect(darwin).toMatchObject({ commits: 2, nix_version: null });
    expect(darwin!.newest.seq).toBe(2);
    expect(darwin!.newest.committed_at).toEqual(new Date(Date.UTC(2026, 0, 2)));
    expect(darwin!.last_imported_at).toEqual(new Date("2026-09-02T00:00:00Z"));

    expect(s.last_import_at).toEqual(new Date("2026-09-03T00:00:00Z"));

    // Of the fixture packages only go is in COMMON_PACKAGES (devbox users
    // write `python`, not `python3`), so it is the one that resolves.
    const go = s.latest_versions.find((l) => l.name === "go");
    expect(go).toEqual({
      name: "go",
      version: "1.22.0",
      attr_path: "go",
      systems: ["x86_64-linux"],
      last_updated: new Date(Date.UTC(2026, 0, 1)),
    });
    expect(s.latest_versions.find((l) => l.name === "python")).toMatchObject({ version: null, systems: [] });
  });

  test("latest versions agree with resolve() and keep input order", async () => {
    await seedCommits(t.db, 3);
    // go: 1.23.0 was dropped from nixpkgs at seq 2, so 1.22.0 is latest
    // despite the lower version (latestOrder's presence rule).
    await seedPackage(t.db, {
      name: "go",
      versions: [
        { version: "1.22.0", systems: ["x86_64-linux", "aarch64-darwin"], commitSeq: 3 },
        { version: "1.23.0", systems: ["x86_64-linux"], commitSeq: 1, lastSeq: 2 },
      ],
    });
    // nodejs: served by attribute path only (the name devbox users write is
    // the attr path here), and only as a prerelease.
    await seedPackage(t.db, {
      name: "nodejs-slim",
      versions: [{ version: "27.0.0-rc.1", attrPath: "nodejs", systems: ["x86_64-linux"] }],
    });
    // python: a broken newest version loses to a working older one.
    await seedPackage(t.db, {
      name: "python",
      versions: [
        { version: "3.14.0", attrPath: "python314", broken: true },
        { version: "3.13.2", attrPath: "python313" },
      ],
    });

    const latest = await latestVersions(["python", "nope", "go", "nodejs"]);
    expect(latest.map((l) => l.name)).toEqual(["python", "nope", "go", "nodejs"]);
    expect(latest[0]).toEqual({
      name: "python",
      version: "3.13.2",
      attr_path: "python313",
      systems: ["aarch64-darwin", "aarch64-linux", "x86_64-darwin", "x86_64-linux"],
      last_updated: new Date(Date.UTC(2026, 0, 1)),
    });
    expect(latest[1]).toEqual({ name: "nope", version: null, attr_path: null, systems: [], last_updated: null });
    expect(latest[2]).toMatchObject({
      version: "1.22.0",
      attr_path: "go",
      systems: ["aarch64-darwin", "x86_64-linux"],
      last_updated: new Date(Date.UTC(2026, 0, 3)),
    });
    expect(latest[3]).toMatchObject({ version: "27.0.0-rc.1", attr_path: "nodejs", systems: ["x86_64-linux"] });

    // The same answers /v2/resolve gives.
    for (const name of ["python", "go", "nodejs"]) {
      const pkgs = await resolve({ name, version: "latest" });
      const mine = latest.find((l) => l.name === name)!;
      expect(pkgs[0]!.version, name).toBe(mine.version);
      expect([...new Set(pkgs.map((p) => p.system))].sort(), name).toEqual(mine.systems);
    }
  });

  test("homeStatus is the home page's subset of status", async () => {
    await seedCommits(t.db, 3);
    await seedPackage(t.db, {
      name: "go",
      versions: [
        { version: "1.21.0", systems: ["x86_64-linux", "aarch64-darwin"] },
        { version: "1.22.0", systems: ["x86_64-linux"] },
      ],
    });

    const [home, full] = await Promise.all([homeStatus(), status()]);
    expect(home.counts).toEqual({ packages: 1, versions: 2, commits: 3 });
    expect(home.counts).toEqual({
      packages: full.counts.packages,
      versions: full.counts.versions,
      commits: full.counts.commits,
    });
    expect(home.newest_commit).toEqual(full.newest_commit);
    expect(home.latest_versions).toEqual(full.latest_versions);
    expect(home.generated_at).toBeInstanceOf(Date);
    // Nothing beyond what the page renders.
    expect(Object.keys(home).sort()).toEqual(["counts", "generated_at", "latest_versions", "newest_commit"]);
  });

  test("serializes to JSON with ISO timestamps", async () => {
    await seedCommits(t.db, 1);
    const s = await status();
    const parsed = JSON.parse(JSON.stringify(s));
    expect(parsed.newest_commit.committed_at).toBe("2026-01-01T00:00:00.000Z");
    expect(typeof parsed.generated_at).toBe("string");
    expect(parsed.latest_versions[0]).toEqual({
      name: "python",
      version: null,
      attr_path: null,
      systems: [],
      last_updated: null,
    });
  });
});
