/**
 * Round-trip and plan-shape tests for the query layer (#26): phrase search
 * fetches every hit in one query instead of two or three per hit, and name
 * lookups go through an indexable semi-join. Runs against an in-process
 * Postgres (PGlite + pg_trgm), so the assertions are on real SQL behavior;
 * the staging plans themselves are recorded in docs/query-plans.md.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolve, search } from "./search";
import { renderV2Pkg } from "./render";
import { GET as v2Search } from "@/app/v2/search/route";
import { createTestDb, seedCommits, seedPackage, type TestDb } from "./testDb";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedCommits(t.db);
}, 120_000);

afterEach(async () => {
  await t?.close();
});

describe("searchByPhrase round trips", () => {
  test("latest: two queries total, not two or three per hit", async () => {
    for (let i = 1; i <= 20; i++) {
      await seedPackage(t.db, {
        name: `zz-pkg-${String(i).padStart(2, "0")}`,
        versions: [{ version: "1.0.0", systems: ["x86_64-linux"] }],
      });
    }
    t.queries.length = 0;

    const rows = await search({ phrase: "zz-pkg", version: "latest" });
    expect(new Set(rows.map((r) => r.name)).size).toBe(20);
    expect(t.queries).toHaveLength(2);
  });

  test("all versions: two queries total", async () => {
    for (let i = 1; i <= 20; i++) {
      await seedPackage(t.db, {
        name: `zz-pkg-${String(i).padStart(2, "0")}`,
        versions: [{ version: "1.0.0" }, { version: "2.0.0" }],
      });
    }
    t.queries.length = 0;

    const rows = await search({ phrase: "zz-pkg" });
    expect(new Set(rows.map((r) => r.name)).size).toBe(20);
    expect(t.queries).toHaveLength(2);
  });
});

describe("searchByPhrase batched semantics match the per-hit lookups", () => {
  test("latest picks the newest non-prerelease version, preferring a non-broken one", async () => {
    await seedPackage(t.db, {
      name: "go",
      versions: [
        { version: "1.21.0" },
        // Newest stable, but broken everywhere: sanctioned change #3 skips it.
        { version: "1.22.0", broken: true },
        // Newer still, but a prerelease: excluded at `latest`.
        { version: "1.23rc1" },
      ],
    });
    await seedPackage(t.db, { name: "go-2fa", versions: [{ version: "1.0.0" }, { version: "1.1.0" }] });

    const rows = await search({ phrase: "go", version: "latest" });
    const versionByName = new Map(rows.map((r) => [r.name, r.version]));
    expect(versionByName.get("go")).toBe("1.21.0");
    expect(versionByName.get("go-2fa")).toBe("1.1.0");
  });

  test("latest falls back to a broken version when nothing else exists", async () => {
    await seedPackage(t.db, { name: "go", versions: [{ version: "1.22.0", broken: true }] });

    const rows = await search({ phrase: "go", version: "latest" });
    expect(rows.map((r) => r.version)).toContain("1.22.0");
  });

  test("latest falls back to the newest prerelease when there is no release", async () => {
    await seedPackage(t.db, { name: "rustfs", versions: [{ version: "1.0.0-rc.5" }, { version: "1.0.0-rc.6" }] });
    await seedPackage(t.db, { name: "rustfs-cli", versions: [{ version: "0.9.0", broken: true }, { version: "1.0.0-rc.1" }] });

    const rows = await search({ phrase: "rustfs", version: "latest" });
    const versionByName = new Map(rows.map((r) => [r.name, r.version]));
    expect(versionByName.get("rustfs")).toBe("1.0.0-rc.6");
    expect(versionByName.get("rustfs-cli")).toBe("0.9.0");
  });

  test("all versions: every version, newest first, one row each at the lowest system", async () => {
    await seedPackage(t.db, {
      name: "go",
      versions: [
        { version: "1.21.0", systems: ["x86_64-linux", "aarch64-darwin"] },
        { version: "1.22.0", systems: ["x86_64-linux", "aarch64-darwin"] },
        { version: "1.23rc1", systems: ["x86_64-linux"] },
      ],
    });

    const rows = await search({ phrase: "go" });
    expect(rows.map((r) => [r.version, r.system])).toEqual([
      ["1.23rc1", "x86_64-linux"],
      ["1.22.0", "aarch64-darwin"],
      ["1.21.0", "aarch64-darwin"],
    ]);
  });
});

describe("name lookups through the semi-join", () => {
  beforeEach(async () => {
    await seedPackage(t.db, {
      name: "python",
      versions: [
        { version: "3.11.9", attrPath: "python311" },
        { version: "3.12.3", attrPath: "python312" },
        { version: "3.13.0rc1", attrPath: "python313" },
      ],
    });
    await seedPackage(t.db, { name: "hello", versions: [{ version: "2.12.1" }] });
  });

  test("by name, case-insensitively, every version newest first", async () => {
    const rows = await search({ name: "PYTHON" });
    expect([...new Set(rows.map((r) => r.version))]).toEqual(["3.13.0rc1", "3.12.3", "3.11.9"]);
  });

  test("by attribute path, case-sensitively", async () => {
    expect((await search({ name: "python311" })).map((r) => r.version)).toEqual(Array(4).fill("3.11.9"));
    expect(await search({ name: "PYTHON311" })).toEqual([]);
  });

  test("resolve latest: newest non-prerelease, then the prerelease fallback", async () => {
    const latest = await resolve({ name: "python", version: "latest" });
    expect(latest[0]?.version).toBe("3.12.3");

    await seedPackage(t.db, { name: "only-pre", versions: [{ version: "1.0.0-beta.1" }] });
    const fallback = await resolve({ name: "only-pre", version: "latest" });
    expect(fallback[0]?.version).toBe("1.0.0-beta.1");
  });

  test("resolve by constraint and by exact version", async () => {
    expect((await resolve({ name: "python", version: "3.11" }))[0]?.version).toBe("3.11.9");
    expect((await resolve({ name: "python", version: "^3.11" }))[0]?.version).toBe("3.12.3");
    expect((await resolve({ name: "hello", version: "2.12.1" }))[0]?.version).toBe("2.12.1");
    expect(await resolve({ name: "hello", version: "9.9.9" })).toEqual([]);
  });

  test("system filter narrows to one system", async () => {
    const rows = await search({ name: "hello", system: "x86_64-linux" });
    expect(rows.map((r) => r.system)).toEqual(["x86_64-linux"]);
  });

  test("every version of a package with more rows than releases", async () => {
    const releases = Array.from({ length: 130 }, (_, i) => `${130 - i}.0.0`);
    await seedPackage(t.db, {
      name: "nodejs",
      versions: releases.flatMap((version) => [
        { version, attrPath: "nodejs" },
        { version, attrPath: "nodejs-slim" },
      ]),
    });

    t.queries.length = 0;
    const rows = await search({ name: "nodejs" });
    expect(t.queries).toHaveLength(1);
    expect(rows).toHaveLength(130 * 2 * 4);
    expect([...new Set(rows.map((r) => r.version))]).toEqual(releases);
  });
});

describe("/v2/search releases", () => {
  beforeEach(async () => {
    await seedPackage(t.db, {
      name: "nodejs",
      versions: [
        { version: "20.0.0", systems: ["x86_64-linux"] },
        { version: "22.0.0", systems: ["x86_64-linux", "aarch64-darwin"], attrPath: "nodejs_22" },
        { version: "22.0.0", systems: ["x86_64-linux"], attrPath: "nodejs-slim_22" },
        { version: "23.0.0-rc.1", systems: ["aarch64-darwin"] },
        { version: "21.0.0", systems: ["x86_64-linux"] },
      ],
    });
    await seedPackage(t.db, { name: "nodejs-slim", versions: [{ version: "22.0.0" }] });
  });

  const get = async (query: string) => {
    const res = await v2Search(new Request(`https://nixsearch.com/v2/search?${query}`));
    return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
  };

  test("absent: the response is unchanged", async () => {
    const { body } = await get("q=nodejs");
    expect(body.results[0]).not.toHaveProperty("releases");
  });

  test("all: every release newest first, each system once across attribute paths", async () => {
    t.queries.length = 0;
    const { body } = await get("q=nodejs&releases=all");
    expect(t.queries).toHaveLength(2);
    expect(body.results[0].name).toBe("nodejs");
    expect(body.results[0].version).toBe("22.0.0");
    expect(body.results[0].releases).toEqual([
      { version: "23.0.0-rc.1", systems: ["aarch64-darwin"] },
      { version: "22.0.0", systems: ["aarch64-darwin", "x86_64-linux"] },
      { version: "21.0.0", systems: ["x86_64-linux"] },
      { version: "20.0.0", systems: ["x86_64-linux"] },
    ]);
    expect(body.results[1].releases).toHaveLength(1);
  });

  test("n counts per package, and a count past every release returns them all", async () => {
    const { body } = await get("q=nodejs&releases=2");
    expect(body.results[0].releases).toHaveLength(2);
    expect(body.results[1].releases).toHaveLength(1);

    const { body: huge } = await get(`q=nodejs&releases=${"9".repeat(30)}`);
    expect(huge.results[0].releases).toHaveLength(4);
  });

  test("releases=n is the first n of /v2/pkg's releases", async () => {
    await seedPackage(t.db, {
      name: "tool",
      versions: [
        // "1.01" and "1.1" share a sort_key, so the tie-breaks decide.
        { version: "1.1", systems: ["x86_64-linux"] },
        { version: "1.01", systems: ["aarch64-darwin"] },
        { version: "2.0.0-rc.1", systems: ["x86_64-linux"] },
        { version: "1.9.0", systems: ["x86_64-linux", "aarch64-linux"], attrPath: "tool_19" },
        { version: "1.9.0", systems: ["x86_64-darwin"], attrPath: "tool-bin_19" },
        { version: "1.8.0", broken: true },
        { version: "0.9.0" },
      ],
    });
    const pkg = renderV2Pkg(await search({ name: "tool" })).releases.map((r) => ({
      version: r.version,
      systems: r.platforms.map((p) => p.system).sort(),
    }));
    expect(pkg).toHaveLength(6);

    for (const n of [1, 2, 3, 4, 5, 6, 7, "all"] as const) {
      const { body } = await get(`q=tool&releases=${n}`);
      const tool = body.results.find((r: { name: string }) => r.name === "tool");
      expect(tool.releases, `releases=${n}`).toEqual(n === "all" ? pkg : pkg.slice(0, n));
    }
  });

  test.each(["0", "-1", "1.5", "abc", "", "ALL", "01"])("400 for releases=%s", async (value) => {
    const { status, body } = await get(`q=nodejs&releases=${value}`);
    expect(status).toBe(400);
    expect(body).toContain("releases must be a positive integer");
  });
});
