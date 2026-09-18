/**
 * Sanctioned change #2 against an in-process Postgres: one nixpkgs rev for
 * every system a version is present on, taken from live presence ranges.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolve } from "./search";
import { newestCommonSeq, singleHashAcrossSystems } from "./singleHash";
import { createTestDb, seedCommits, seedCommitSystems, seedPackage, type TestDb } from "./testDb";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedCommits(t.db, 3);
}, 120_000);

afterEach(async () => {
  await t?.close();
});

const hashOf = (seq: number) => seq.toString(16).padStart(40, "0");

async function revs(name: string, version = "latest"): Promise<Record<string, string>> {
  const pkgs = await singleHashAcrossSystems(await resolve({ name, version }));
  return Object.fromEntries(pkgs.map((p) => [p.system, p.commitHash]));
}

describe("singleHashAcrossSystems", () => {
  // Every system still carries the version, so the newest commit they all
  // evaluated is the answer — not the per-system content-change commits,
  // and not "no commit" because an open range has no upper bound (#50).
  test("open ranges on every system resolve to the newest imported commit", async () => {
    await seedCommitSystems(t.db, { "x86_64-linux": 3, "aarch64-linux": 3, "aarch64-darwin": 3 });
    await seedPackage(t.db, {
      name: "go",
      versions: [{ version: "1.23.0", commitSeq: 1, systems: ["x86_64-linux", "aarch64-linux", "aarch64-darwin"] }],
    });

    expect(await revs("go")).toEqual({
      "x86_64-linux": hashOf(3),
      "aarch64-linux": hashOf(3),
      "aarch64-darwin": hashOf(3),
    });
  });

  test("an open range is bounded by its own system's newest import, not the timeline's", async () => {
    // aarch64-darwin's evals lag one commit behind.
    await seedCommitSystems(t.db, { "x86_64-linux": 3, "aarch64-darwin": 2 });
    await seedPackage(t.db, {
      name: "go",
      versions: [{ version: "1.23.0", commitSeq: 1, systems: ["x86_64-linux", "aarch64-darwin"] }],
    });

    expect(await revs("go")).toEqual({ "x86_64-linux": hashOf(2), "aarch64-darwin": hashOf(2) });
  });

  test("a range closed on one system caps the common commit", async () => {
    await seedCommitSystems(t.db, { "x86_64-linux": 3, "aarch64-darwin": 3 });
    await seedPackage(t.db, {
      name: "go",
      versions: [
        { version: "1.23.0", commitSeq: 1, lastSeq: { "x86_64-linux": 2 }, systems: ["x86_64-linux", "aarch64-darwin"] },
      ],
    });

    expect(await revs("go", "1.23.0")).toEqual({ "x86_64-linux": hashOf(2), "aarch64-darwin": hashOf(2) });
  });

  // x86_64-darwin was never imported after the migration seed: its only
  // ranges are seeded points, which are not presence. It keeps its own
  // commit and must not drag the other systems back to the seed.
  test("a system with only seeded ranges keeps its own commit and is left out of the unification", async () => {
    await seedCommitSystems(t.db, { "x86_64-linux": 3, "aarch64-linux": 3, "x86_64-darwin": 1 });
    await seedPackage(t.db, {
      name: "go",
      versions: [
        { version: "1.23.0", commitSeq: 2, systems: ["x86_64-linux", "aarch64-linux"] },
        { version: "1.23.0", commitSeq: 1, seeded: true, systems: ["x86_64-darwin"] },
      ],
    });

    expect(await revs("go")).toEqual({
      "x86_64-linux": hashOf(3),
      "aarch64-linux": hashOf(3),
      "x86_64-darwin": hashOf(1),
    });
  });

  test("nothing changes when fewer than two systems have live ranges", async () => {
    await seedCommitSystems(t.db, { "x86_64-linux": 3, "x86_64-darwin": 1 });
    await seedPackage(t.db, {
      name: "go",
      versions: [
        { version: "1.23.0", commitSeq: 2, systems: ["x86_64-linux"] },
        { version: "1.23.0", commitSeq: 1, seeded: true, systems: ["x86_64-darwin"] },
      ],
    });

    expect(await revs("go")).toEqual({ "x86_64-linux": hashOf(2), "x86_64-darwin": hashOf(1) });
  });

  // The rev is emitted next to one attribute path per system; presence under
  // another attribute path of the same version does not make it valid there.
  test("only the emitted attribute path's presence counts", async () => {
    await seedCommitSystems(t.db, { "x86_64-linux": 3, "aarch64-darwin": 3 });
    await seedPackage(t.db, {
      name: "python",
      versions: [
        // `python3` (emitted: alphabetically first) left both systems at seq 2...
        { version: "3.13.0", attrPath: "python3", commitSeq: 1, lastSeq: 2, systems: ["x86_64-linux", "aarch64-darwin"] },
        // ...while `python313` is still current.
        { version: "3.13.0", attrPath: "python313", commitSeq: 1, systems: ["x86_64-linux", "aarch64-darwin"] },
      ],
    });

    const pkgs = await singleHashAcrossSystems(await resolve({ name: "python", version: "3.13.0" }));
    expect(pkgs.map((p) => [p.system, p.attrPath, p.commitHash])).toEqual([
      ["aarch64-darwin", "python3", hashOf(2)],
      ["aarch64-darwin", "python313", hashOf(2)],
      ["x86_64-linux", "python3", hashOf(2)],
      ["x86_64-linux", "python313", hashOf(2)],
    ]);
  });
});

describe("newestCommonSeq", () => {
  test("picks the newest seq inside one interval of every group", () => {
    expect(newestCommonSeq([[{ lo: 1, hi: 5 }], [{ lo: 3, hi: 8 }]])).toBe(5);
    expect(newestCommonSeq([[{ lo: 1, hi: 2 }, { lo: 6, hi: 9 }], [{ lo: 3, hi: 7 }]])).toBe(7);
  });

  test("is null when the groups never overlap", () => {
    expect(newestCommonSeq([[{ lo: 1, hi: 2 }], [{ lo: 3, hi: 4 }]])).toBeNull();
    expect(newestCommonSeq([])).toBeNull();
  });
});
