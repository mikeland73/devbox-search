/**
 * /status against an in-process Postgres: the numbers must reflect the
 * seeded fixtures, the commit endpoints must be the first and last seq, and
 * the per-system view must surface a system frozen at an older commit.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { commitSystems } from "@devbox-search/db";
import { status } from "./status";
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
  });

  test("serializes to JSON with ISO timestamps", async () => {
    await seedCommits(t.db, 1);
    const s = await status();
    const parsed = JSON.parse(JSON.stringify(s));
    expect(parsed.newest_commit.committed_at).toBe("2026-01-01T00:00:00.000Z");
    expect(typeof parsed.generated_at).toBe("string");
  });
});
