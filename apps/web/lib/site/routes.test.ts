/**
 * The site routes against an in-process Postgres: path parsing, the
 * redirects that stand where the removed API aliases were, and the status
 * codes a crawler will see. The pages themselves are covered by
 * pages.test.ts; what matters here is that the right one is chosen.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, seedCommits, seedPackage, type TestDb } from "../testDb";
import { STATUS_CACHE_CONTROL } from "../status";
import { HOME_CACHE_CONTROL } from "./home";

import * as home from "@/app/(site)/route";
import * as searchPage from "@/app/(site)/search/route";
import * as pkgPage from "@/app/(site)/pkg/[[...path]]/route";
import * as resolvePage from "@/app/(site)/resolve/route";
import * as robots from "@/app/(site)/robots.txt/route";
import * as sitemapIndex from "@/app/(site)/sitemap.xml/route";
import * as sitemapPage from "@/app/(site)/sitemaps/[page]/route";
import * as opensearch from "@/app/(site)/opensearch.xml/route";

let t: TestDb;

const ORIGIN = "https://nixsearch.com";
const get = (mod: { GET: (r: Request) => Promise<Response> }, path: string) =>
  mod.GET(new Request(ORIGIN + path));

beforeEach(async () => {
  t = await createTestDb();
  await seedCommits(t.db, 3);
  await seedPackage(t.db, {
    name: "python",
    summary: "High-level dynamically-typed programming language",
    homepage: "https://www.python.org",
    license: "Python-2.0",
    versions: [
      { version: "3.12.4", attrPath: "python312", commitSeq: 3 },
      { version: "3.11.9", attrPath: "python311", commitSeq: 2 },
    ],
  });
  await seedPackage(t.db, {
    name: "nodePackages.typescript",
    versions: [{ version: "5.5.4", attrPath: "nodePackages.typescript", commitSeq: 3 }],
  });
}, 120_000);

afterEach(async () => {
  await t?.close();
});

describe("/", () => {
  test("serves the home page with the index's own numbers", async () => {
    const res = await get(home, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("Every version of every nixpkgs package");
    expect(body).toContain("nixpkgs-unstable commits");
  });

  test("is served stale for a day, unlike /status", async () => {
    const res = await get(home, "/");
    expect(res.headers.get("cache-control")).toBe(HOME_CACHE_CONTROL);
    expect(HOME_CACHE_CONTROL).toContain("stale-while-revalidate=86400");
    expect(HOME_CACHE_CONTROL).not.toBe(STATUS_CACHE_CONTROL);
  });
});

describe("/search", () => {
  test("renders results for a phrase", async () => {
    const res = await get(searchPage, "/search?q=python");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="/pkg/python"');
    expect(body).toContain("3.12.4");
  });

  test("an empty query goes home rather than 400ing", async () => {
    const res = await get(searchPage, "/search?q=");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  test("a devbox reference jumps to the package with the constraint applied", async () => {
    const res = await get(searchPage, "/search?q=python%403.11");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/pkg/python?v=3.11");
  });

  test("a range constraint survives the redirect intact", async () => {
    const res = await get(searchPage, "/search?q=" + encodeURIComponent("go@>=1.2 <2"));
    expect(res.headers.get("location")).toBe("/pkg/go?v=%3E%3D1.2%20%3C2");
  });

  test("no match is a page, not a 404", async () => {
    const res = await get(searchPage, "/search?q=zzzzzz");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No package matches");
  });
});

describe("/pkg", () => {
  test("a package page resolves latest and lists every release", async () => {
    const res = await get(pkgPage, "/pkg/python");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("devbox add python@3.12.4");
    expect(body).toContain('href="/pkg/python/3.11.9"');
    expect(body).toContain("python312");
  });

  test("?v= answers that constraint instead", async () => {
    const body = await (await get(pkgPage, "/pkg/python?v=3.11")).text();
    expect(body).toContain("devbox add python@3.11.9");
    expect(body).toContain('value="3.11"');
  });

  test("a constraint matching nothing still serves the page", async () => {
    const res = await get(pkgPage, "/pkg/python?v=9.99");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No version of");
  });

  test("an attribute path with dots is one segment", async () => {
    const res = await get(pkgPage, "/pkg/nodePackages.typescript");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("5.5.4");
  });

  test("a release page shows the pinned reference", async () => {
    const res = await get(pkgPage, "/pkg/python/3.11.9");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("nix shell github:NixOS/nixpkgs/");
    expect(body).toContain("python311");
  });

  test("an unknown package is a 404 page", async () => {
    const res = await get(pkgPage, "/pkg/doesnotexist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("No package named doesnotexist");
  });

  test("an unknown version of a known package is a 404 page", async () => {
    const res = await get(pkgPage, "/pkg/python/1.0.0");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("has no version 1.0.0");
  });

  test("more than two segments is a 404", async () => {
    expect((await get(pkgPage, "/pkg/python/3.11.9/extra")).status).toBe(404);
  });

  test("the old ?name= form redirects to the path form", async () => {
    const res = await get(pkgPage, "/pkg?name=python");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/pkg/python");
  });

  test("bare /pkg goes home", async () => {
    expect((await get(pkgPage, "/pkg")).headers.get("location")).toBe("/");
  });
});

describe("/resolve", () => {
  test("redirects to the package page carrying the constraint", async () => {
    const res = await get(resolvePage, "/resolve?name=python&version=3.11");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/pkg/python?v=3.11");
  });

  test("without a version, the package page", async () => {
    expect((await get(resolvePage, "/resolve?name=python")).headers.get("location")).toBe("/pkg/python");
  });
});

describe("crawler files", () => {
  test("robots.txt allows everything and names the sitemap", async () => {
    const body = await (await get(robots, "/robots.txt")).text();
    expect(body).toContain("Allow: /");
    expect(body).not.toContain("Disallow");
    expect(body).toContain("https://nixsearch.com/sitemap.xml");
  });

  test("the sitemap index covers the package count", async () => {
    const body = await (await get(sitemapIndex, "/sitemap.xml")).text();
    expect(body).toContain("<loc>https://nixsearch.com/sitemaps/1.xml</loc>");
  });

  test("a sitemap page lists package URLs", async () => {
    const res = await get(sitemapPage, "/sitemaps/1.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("<loc>https://nixsearch.com/pkg/python</loc>");
    expect(body).toContain("<loc>https://nixsearch.com/pkg/nodePackages.typescript</loc>");
  });

  test("a page past the end is a 404", async () => {
    expect((await get(sitemapPage, "/sitemaps/99.xml")).status).toBe(404);
  });

  test("opensearch points at both the page and the JSON", async () => {
    const body = await (await get(opensearch, "/opensearch.xml")).text();
    expect(body).toContain("https://nixsearch.com/search?q={searchTerms}");
    expect(body).toContain("https://nixsearch.com/v2/search?q={searchTerms}");
  });
});

describe("method handling", () => {
  test("pages answer OPTIONS and refuse writes like the API does", async () => {
    expect((await pkgPage.OPTIONS()).status).toBe(204);
    expect((await pkgPage.POST()).status).toBe(405);
  });
});
