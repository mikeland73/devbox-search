/**
 * The `system` parameter of /v2/resolve and /v2/search, through the route
 * handlers: validation, the "not on this system" 404, and that a filtered
 * response still covers every system. The query semantics themselves are
 * in search.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, seedCommits, seedPackage, type TestDb } from "./testDb";

import * as v2Resolve from "@/app/v2/resolve/route";
import * as v2Search from "@/app/v2/search/route";

let t: TestDb;

const get = (mod: { GET: (r: Request) => Promise<Response> }, path: string) =>
  mod.GET(new Request("https://nixsearch.com" + path));

beforeEach(async () => {
  t = await createTestDb();
  await seedCommits(t.db, 3);
  // Apple's libiconv on darwin, glibc's on Linux: the newest version exists
  // on one system only.
  await seedPackage(t.db, {
    name: "libiconv",
    versions: [
      { version: "115.100.1", commitSeq: 3, systems: ["aarch64-darwin"] },
      { version: "2.40", commitSeq: 2, systems: ["aarch64-linux", "x86_64-linux"] },
    ],
  });
  await seedPackage(t.db, {
    name: "go",
    versions: [
      { version: "1.23.0", commitSeq: 3, systems: ["aarch64-linux", "x86_64-linux"] },
      { version: "1.22.5", commitSeq: 2 },
    ],
  });
}, 120_000);

afterEach(async () => {
  await t?.close();
});

describe("/v2/resolve?system=", () => {
  test("picks the newest version on that system and lists every system it is on", async () => {
    const res = await get(v2Resolve, "/v2/resolve?name=go&version=latest&system=aarch64-darwin");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; systems: Record<string, unknown> };
    expect(body.version).toBe("1.22.5");
    expect(Object.keys(body.systems).sort()).toEqual([
      "aarch64-darwin",
      "aarch64-linux",
      "x86_64-darwin",
      "x86_64-linux",
    ]);
  });

  test("without it, nothing changes", async () => {
    const body = (await (await get(v2Resolve, "/v2/resolve?name=libiconv&version=latest")).json()) as {
      version: string;
    };
    expect(body.version).toBe("115.100.1");
    const linux = (await (
      await get(v2Resolve, "/v2/resolve?name=libiconv&version=latest&system=x86_64-linux")
    ).json()) as { version: string };
    expect(linux.version).toBe("2.40");
  });

  test("is normalized before validation", async () => {
    const res = await get(v2Resolve, "/v2/resolve?name=libiconv&version=latest&system=X86_64-Linux");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { version: string }).version).toBe("2.40");
  });

  test("an unknown system is a 400, not an empty match", async () => {
    const res = await get(v2Resolve, "/v2/resolve?name=go&version=latest&system=x86_64-linx");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      '400 Bad Request: unknown system "x86_64-linx" (expected one of aarch64-darwin, aarch64-linux, x86_64-darwin, x86_64-linux)\n',
    );
  });

  test("a version that exists, but not on that system, is a JSON 404 naming where it is", async () => {
    const res = await get(v2Resolve, "/v2/resolve?name=libiconv&version=115&system=x86_64-linux");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=0, s-maxage=60");
    expect(await res.json()).toEqual({
      error: "not_available_on_system",
      message: 'no package found for: name = "libiconv" && version = "115" && system = "x86_64-linux"',
      system: "x86_64-linux",
      available: ["aarch64-darwin"],
    });
  });

  test("a version that exists nowhere is the usual plain-text 404", async () => {
    const res = await get(v2Resolve, "/v2/resolve?name=libiconv&version=9.99&system=x86_64-linux");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(
      '404 Not Found: no package found for: name = "libiconv" && version = "9.99" && system = "x86_64-linux"\n',
    );
  });
});

describe("/v2/search?system=", () => {
  interface Search {
    results: Array<{ name: string; version: string; systems: string[] }>;
  }

  test("picks each package's latest on that system and lists every system it is on", async () => {
    const body = (await (await get(v2Search, "/v2/search?q=libiconv&system=x86_64-linux")).json()) as Search;
    expect(body.results).toMatchObject([
      { name: "libiconv", version: "2.40", systems: ["aarch64-linux", "x86_64-linux"] },
    ]);
  });

  test("drops packages with no release on that system", async () => {
    await seedPackage(t.db, { name: "go-darwin-only", versions: [{ version: "1.0.0", systems: ["aarch64-darwin"] }] });

    const all = (await (await get(v2Search, "/v2/search?q=go")).json()) as Search;
    expect(all.results.map((r) => r.name)).toEqual(["go", "go-darwin-only"]);
    const linux = (await (await get(v2Search, "/v2/search?q=go&system=x86_64-linux")).json()) as Search;
    expect(linux.results.map((r) => r.name)).toEqual(["go"]);
  });

  test("an unknown system is a 400", async () => {
    const res = await get(v2Search, "/v2/search?q=go&system=riscv64-linux");
    expect(res.status).toBe(400);
  });
});
