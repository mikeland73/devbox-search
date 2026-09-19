#!/usr/bin/env node
/**
 * Integration test against a live deployment.
 *
 * .github/workflows/integration.yml runs this against the Vercel deployment
 * that just became ready — the preview for a PR, production for main. It
 * can be pointed at anything by hand:
 *
 *   BASE_URL=https://devbox-search.vercel.app node --test tools/integration.test.mjs
 *
 * No dependencies (node:test + fetch), so CI needs a checkout and a Node,
 * not a pnpm install. The unit tests cover the query and render layers
 * against PGlite; this covers what they cannot: the deployed build, its env
 * vars, the real Neon database, and the Vercel edge in front of it.
 *
 * Expected values come in two kinds:
 *
 *   - Frozen. go 1.22 left nixpkgs in 2025 and the index is
 *     incremental-forever, so `go@1.22` resolves to the same version and the
 *     same commits for as long as this service exists. Those are pinned
 *     exactly; a change there is a query-layer regression, not data drift.
 *   - Moving. `python@3.11` gets patch releases, `go@latest` moves every
 *     release, /status grows daily. Those are checked for shape and
 *     invariants only.
 */

import { before, test } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = (process.env.BASE_URL ?? "").replace(/\/+$/, "");
if (BASE_URL === "") {
  console.error("BASE_URL is required, e.g. BASE_URL=https://devbox-search.vercel.app");
  process.exit(2);
}

/**
 * The Vercel WAF limits each client IP to 1000 requests per 10 minutes (see
 * docs/operations.md). One run is well under that, but runs share the
 * runner IP pool, so CI sends the override secret and skips the limit
 * entirely. Optional: without it the test still passes, just counted.
 */
const HEADERS = { "User-Agent": "devbox-search-integration" };
if (process.env.RATE_LIMIT_OVERRIDE_SECRET) {
  HEADERS["X-Rate-Limit-Override-Secret"] = process.env.RATE_LIMIT_OVERRIDE_SECRET;
}

const SHA = /^[0-9a-f]{40}$/;
/** v2 timestamps: RFC 3339 without fractional seconds. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** Timestamps rendered by JSON.stringify(Date) — /status is not Go-shaped. */
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// go 1.22: its last nixpkgs release (1.22.12) and the newest commit carrying
// it per system. Frozen — see the header.
const GO_1_22 = {
  version: "1.22.12",
  attrPath: "go_1_22",
  revs: {
    "aarch64-darwin": "0d534853a55b5d02a4ababa1d71921ce8f0aee4c",
    "aarch64-linux": "0d534853a55b5d02a4ababa1d71921ce8f0aee4c",
    "x86_64-darwin": "dd613136ee91f67e5dba3f3f41ac99ae89c5406b",
    "x86_64-linux": "dd613136ee91f67e5dba3f3f41ac99ae89c5406b",
  },
};

const INDEXED_SYSTEMS = ["aarch64-darwin", "aarch64-linux", "x86_64-linux"];

/** GET a path; the body is parsed when the server says it is JSON. */
async function get(path) {
  const res = await fetch(BASE_URL + path, {
    signal: AbortSignal.timeout(60_000),
    headers: HEADERS,
    // The Go service never redirected, so a 3xx is a finding, not a hop to
    // follow: `/pkg/` → 308 → `/pkg` → 400 would otherwise pass as a 400.
    redirect: "manual",
  });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    headers: res.headers,
    contentType,
    text,
    body: contentType.startsWith("application/json") ? JSON.parse(text) : undefined,
  };
}

/** Asserts a 200 JSON response and returns the parsed body. */
function okJson(res, path) {
  assert.equal(res.status, 200, `${path}: ${res.status} ${res.text.slice(0, 200)}`);
  assert.equal(res.contentType, "application/json", `${path}: content-type`);
  // Sanctioned change #5: every JSON response carries an ETag so the edge
  // can revalidate. (Vercel strips s-maxage from the client-facing
  // Cache-Control, so the caching directive itself is not observable here.)
  assert.ok(res.headers.get("etag"), `${path}: missing ETag`);
  return res.body;
}

/** Asserts one of Go's http.Error-shaped text bodies. */
function assertError(res, status, message, path) {
  assert.equal(res.status, status, `${path}: ${res.status} ${res.text.slice(0, 200)}`);
  assert.equal(res.contentType, "text/plain; charset=utf-8", `${path}: content-type`);
  assert.equal(res.text, message + "\n", `${path}: body`);
}

// Vercel reports success once the deployment is live, but give the first
// function invocation (cold Next.js server, cold Neon connection) a moment
// rather than failing the whole run on it.
before(async () => {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const res = await get("/readyz");
      if (res.status === 200) return;
      console.log(`readyz: ${res.status}, retrying`);
    } catch (err) {
      console.log(`readyz: ${err.message ?? err}, retrying`);
    }
    if (Date.now() > deadline) throw new Error(`${BASE_URL}/readyz did not come up in 90s`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
});

// ---------------------------------------------------------------------------
// Health and status
// ---------------------------------------------------------------------------

test("GET /readyz", async () => {
  const res = await get("/readyz");
  assert.equal(res.status, 200);
  assert.equal(res.text, "ok\n");
  assert.match(res.contentType, /^text\/plain/);
});

test("GET /status reports a fully indexed database", async () => {
  const path = "/status";
  const body = okJson(await get(path), path);

  // Row counts as of 2026-09-17 (seq 2795); the index only grows.
  assert.ok(body.counts.packages >= 250_000, `packages: ${body.counts.packages}`);
  assert.ok(body.counts.versions >= 1_400_000, `versions: ${body.counts.versions}`);
  assert.ok(body.counts.variants >= 3_800_000, `variants: ${body.counts.variants}`);
  assert.ok(body.counts.commits >= 2795, `commits: ${body.counts.commits}`);

  // The seed's first commit; the timeline never loses its start.
  assert.equal(body.oldest_commit.seq, 1);
  assert.equal(body.oldest_commit.hash, "d6d07f262b171bb1e415e1a06c52288af056a98d");
  assert.ok(body.newest_commit.seq >= 2795);
  assert.match(body.newest_commit.hash, SHA);
  assert.match(body.newest_commit.committed_at, ISO_MS);
  assert.ok(body.newest_commit.seq >= body.oldest_commit.seq);
  assert.match(body.last_import_at, ISO_MS);
  assert.match(body.generated_at, ISO_MS);
  assert.ok(body.database_size_bytes > 1_000_000_000, `database_size_bytes: ${body.database_size_bytes}`);

  // Every system the daily import covers is at the head of the timeline.
  // x86_64-darwin and i686-linux are also present, frozen at the seed (#17).
  const systems = Object.fromEntries(body.systems.map((s) => [s.system, s]));
  for (const system of INDEXED_SYSTEMS) {
    assert.ok(systems[system], `missing system ${system}`);
    assert.equal(systems[system].newest.seq, body.newest_commit.seq, `${system} is behind the newest commit`);
    assert.equal(systems[system].newest.hash, body.newest_commit.hash);
    assert.match(systems[system].last_imported_at, ISO_MS);
  }
  assert.deepEqual(
    body.systems.map((s) => s.system),
    [...body.systems.map((s) => s.system)].sort(),
    "systems are sorted by name",
  );
});

// Go path.Clean'd every request path, so a trailing slash reached the same
// handler as the bare path. Next.js would 308 these to the slash-less form
// unless told not to (skipTrailingSlashRedirect, #45).
test("trailing slashes are served, not redirected", async () => {
  assert.equal((await get("/readyz/")).status, 200, "/readyz/");
  assertError(
    await get("/pkg/"),
    400,
    "400 Bad Request: empty name (set a ?name=<value> query parameter)",
    "/pkg/",
  );
  const path = "/v2/resolve/?name=go&version=1.22";
  const body = okJson(await get(path), path);
  assert.equal(body.version, GO_1_22.version);
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test("GET /v2/search?q=python", async () => {
  const path = "/v2/search?q=python";
  const body = okJson(await get(path), path);

  assert.equal(body.query, "python");
  assert.ok(body.total_results > 0);
  assert.equal(body.results.length, body.total_results);
  // An exact name match outranks every prefix and trigram hit.
  assert.equal(body.results[0].name, "python");
  assert.equal(body.results[0].summary, "High-level dynamically-typed programming language");
  for (const hit of body.results) {
    assert.equal(typeof hit.name, "string");
    assert.equal(typeof hit.summary, "string");
    assert.match(hit.last_updated, RFC3339);
  }
});

test("GET /v1/search?q=python", async () => {
  const path = "/v1/search?q=python";
  const body = okJson(await get(path), path);

  assert.ok(body.num_results > 0);
  assert.equal(body.packages.length, body.num_results);
  const first = body.packages[0];
  assert.equal(first.name, "python");
  assert.equal(first.num_versions, first.versions.length);
  assert.ok(first.num_versions > 0);
  // v1 timestamps are unix seconds; the commit hash is the nixpkgs rev.
  const newest = first.versions[0];
  assert.match(newest.commit_hash, SHA);
  assert.equal(typeof newest.last_updated, "number");
  assert.equal(typeof newest.version, "string");
  assert.ok(Object.keys(newest.systems).length > 0);
});

test("GET /v2/search without q is a 400", async () => {
  const path = "/v2/search";
  assertError(
    await get(path),
    400,
    "400 Bad Request: empty search query (set a ?q=<term> query parameter)",
    path,
  );
});

// ---------------------------------------------------------------------------
// Resolve — frozen expectations
// ---------------------------------------------------------------------------

test("GET /v2/resolve?name=go&version=1.22 resolves to the frozen 1.22.12", async () => {
  const path = "/v2/resolve?name=go&version=1.22";
  const body = okJson(await get(path), path);

  assert.equal(body.name, "go");
  assert.equal(body.version, GO_1_22.version);
  assert.equal(body.summary, "Go Programming language");
  assert.deepEqual(Object.keys(body.systems).sort(), Object.keys(GO_1_22.revs));
  for (const [system, rev] of Object.entries(GO_1_22.revs)) {
    const info = body.systems[system];
    assert.deepEqual(
      info.flake_installable,
      {
        ref: { type: "github", owner: "NixOS", repo: "nixpkgs", rev },
        attr_path: GO_1_22.attrPath,
      },
      `${system} flake_installable`,
    );
    assert.match(info.last_updated, RFC3339);
    assert.deepEqual(
      info.outputs.map((o) => o.name),
      ["out"],
      `${system} outputs`,
    );
    assert.equal(info.outputs[0].default, true);
    assert.match(info.outputs[0].path, /^\/nix\/store\/[a-z0-9]{32}-go-1\.22\.12$/);
  }
});

test("GET /v1/resolve?name=go&version=1.22 resolves to the frozen 1.22.12", async () => {
  const path = "/v1/resolve?name=go&version=1.22";
  const body = okJson(await get(path), path);

  assert.equal(body.name, "go");
  assert.equal(body.version, GO_1_22.version);
  // The top-level commit_hash is the first system's (aarch64-darwin).
  assert.equal(body.commit_hash, GO_1_22.revs["aarch64-darwin"]);
  assert.equal(typeof body.last_updated, "number");
  assert.deepEqual(body.platforms, Object.keys(GO_1_22.revs));
  assert.equal(body.license, "BSD-3-Clause");
  assert.equal(body.homepage, "https://go.dev/");
  for (const [system, rev] of Object.entries(GO_1_22.revs)) {
    const info = body.systems[system];
    assert.ok(info, `missing system ${system}`);
    assert.equal(info.commit_hash, rev, `${system} commit_hash`);
    assert.equal(info.version, GO_1_22.version);
    assert.equal(info.system, system);
    assert.equal(info.store_version, GO_1_22.version);
    assert.deepEqual(info.attr_paths, [GO_1_22.attrPath], `${system} attr_paths`);
    assert.deepEqual(info.programs, ["go"], `${system} programs`);
  }
});

test("GET /search?q=go&v=1.22 (oldest shape) resolves to the frozen 1.22.12", async () => {
  const path = "/search?q=go&v=1.22";
  const body = okJson(await get(path), path);

  assert.equal(body.metadata.total_results, 1);
  assert.equal(body.results[0].name, "go");
  const pkg = body.results[0].packages[0];
  assert.equal(pkg.attribute_path, GO_1_22.attrPath);
  assert.equal(pkg.pname, "go-1.22.12");
  assert.equal(pkg.version, GO_1_22.version);
  assert.equal(pkg.nixpkg_commit, GO_1_22.revs["aarch64-darwin"]);
  assert.match(pkg.date, RFC3339);
});

// ---------------------------------------------------------------------------
// Resolve — moving expectations
// ---------------------------------------------------------------------------

test("GET /v2/resolve?name=python&version=3.11 is a range over 3.11.x", async () => {
  const path = "/v2/resolve?name=python&version=3.11";
  const body = okJson(await get(path), path);

  assert.equal(body.name, "python");
  // Sanctioned change #1: a partial version is a range, so "3.11" never
  // matches 3.1.x or 3.110.
  assert.match(body.version, /^3\.11\.\d+$/);
  for (const system of INDEXED_SYSTEMS) {
    const info = body.systems[system];
    assert.ok(info, `missing system ${system}`);
    assert.equal(info.flake_installable.attr_path, "python311", `${system} attr_path`);
    assert.match(info.flake_installable.ref.rev, SHA);
  }
  // Sanctioned change #2: one commit for every system it can be found on.
  const revs = new Set(INDEXED_SYSTEMS.map((s) => body.systems[s].flake_installable.ref.rev));
  assert.equal(revs.size, 1, `expected a single rev across ${INDEXED_SYSTEMS}, got ${[...revs]}`);
});

test("GET /v2/resolve?name=go&version=latest", async () => {
  const path = "/v2/resolve?name=go&version=latest";
  const body = okJson(await get(path), path);

  assert.equal(body.name, "go");
  // Already past 1.27 in 2026-09; "latest" never goes backwards.
  assert.match(body.version, /^1\.(2[7-9]|[3-9]\d)\b/);
  for (const system of INDEXED_SYSTEMS) {
    const info = body.systems[system];
    assert.ok(info, `missing system ${system}`);
    assert.match(info.flake_installable.ref.rev, SHA);
    assert.match(info.flake_installable.attr_path, /^go(_\d+_\d+)?$/);
  }

  // Sanctioned change #2, for a version still in nixpkgs: the one rev is the
  // newest commit every indexed system has evaluated (#50). /status names
  // it; the two are cached separately, so allow the head to have moved on
  // by one import between the calls.
  const status = okJson(await get("/status"), "/status");
  const heads = INDEXED_SYSTEMS.map((s) => status.systems.find((x) => x.system === s).newest);
  const common = heads.reduce((a, b) => (a.seq <= b.seq ? a : b));
  const revs = new Set(INDEXED_SYSTEMS.map((s) => body.systems[s].flake_installable.ref.rev));
  assert.equal(revs.size, 1, `expected a single rev across ${INDEXED_SYSTEMS}, got ${[...revs]}`);
  const [rev] = revs;
  assert.ok(
    rev === common.hash || rev === status.newest_commit.hash,
    `go@latest rev ${rev} is not the current head (${heads.map((h) => `${h.seq}=${h.hash.slice(0, 8)}`)})`,
  );
});

test("latest is the current release, not a date snapshot the attribute moved on from (#44)", async () => {
  // Each of these has an old `YYYY-MM-DD` snapshot that compares above its
  // real releases. Moving expectations: the release may advance, but it
  // can never go back to the snapshot.
  for (const [name, snapshot, release] of [
    ["go-font", "2017-03-30", /^2\.\d/],
    ["age", "2020-03-25", /^1\.\d/],
    ["alejandra", "2022-02-12", /^[4-9]\.\d/],
    ["go-mtpfs", "2018-02-09", /^1\.\d/],
  ]) {
    const path = `/v2/resolve?name=${name}&version=latest`;
    const body = okJson(await get(path), path);
    assert.notEqual(body.version, snapshot, `${name}: resolved to the snapshot`);
    assert.match(body.version, release, `${name}: ${body.version}`);
  }
  // And the other way round: mod_python's snapshot replaced its last release.
  const path = "/v2/resolve?name=mod_python&version=latest";
  assert.match(okJson(await get(path), path).version, /^\d{4}-\d{2}-\d{2}$/);
  // A renamed attribute path (EBTKS → ebtks) must not keep its last version.
  const ebtks = "/v2/resolve?name=ebtks&version=latest";
  assert.notEqual(okJson(await get(ebtks), ebtks).version, "2017-09-23");
});

test("python@latest is the interpreter nixpkgs-unstable ships, not a stale line (#49)", async (t) => {
  // Top-level `python314` was hidden from every eval by nix-env's dedup once
  // buildbotPackages.python aliased it, so the index stopped at 3.14.4 from
  // May 2026 while nixpkgs moved on. Until an import produced by the fixed
  // eval (eval.nix, #49) has run, the index simply has no
  // newer 3.14.x under `python`, and there is nothing for `latest` to get
  // right or wrong — so the check arms itself: once a 3.14.5+ exists under
  // a top-level attribute, `latest` must be it (or newer) and current.
  const listing = okJson(await get("/v2/pkg?name=python"), "/v2/pkg?name=python");
  const release = (v) => /^\d+\.\d+\.\d+$/.test(v) && v.split(".").map(Number);
  const newerThan = (a, b) => (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0;
  const fixed = listing.releases.some((r) => release(r.version) && newerThan(release(r.version), [3, 14, 4]));
  if (!fixed) {
    t.skip("index has no python 3.14.5+ yet: the fixed eval has not been imported");
    return;
  }

  const path = "/v2/resolve?name=python&version=latest";
  const body = okJson(await get(path), path);
  assert.match(body.version, /^3\.(1[4-9]|[2-9]\d)\.\d+$/, `python@latest: ${body.version}`);
  const status = okJson(await get("/status"), "/status");
  for (const system of INDEXED_SYSTEMS) {
    const info = body.systems[system];
    assert.ok(info, `missing system ${system}`);
    assert.match(info.flake_installable.attr_path, /^python3\d\d$/, `${system} attr_path`);
  }
  // Present at head: last_updated is at most a few imports old, never May.
  const newest = new Date(status.newest_commit.committed_at);
  const age = newest - new Date(body.systems["x86_64-linux"].last_updated);
  assert.ok(age <= 14 * 86_400_000, `python@latest last_updated is ${Math.round(age / 86_400_000)} days behind the head`);
});

test("GET /v1/resolve?name=python&version=3.11&system=x86_64-linux filters by system", async () => {
  const path = "/v1/resolve?name=python&version=3.11&system=x86_64-linux";
  const body = okJson(await get(path), path);

  assert.equal(body.name, "python");
  assert.match(body.version, /^3\.11\.\d+$/);
  assert.match(body.commit_hash, SHA);
  assert.deepEqual(Object.keys(body.systems), ["x86_64-linux"]);
  assert.deepEqual(body.systems["x86_64-linux"].attr_paths, ["python311"]);
});

// ---------------------------------------------------------------------------
// Resolve — errors
// ---------------------------------------------------------------------------

test("GET /v2/resolve without version is a 400", async () => {
  const path = "/v2/resolve?name=go";
  assertError(
    await get(path),
    400,
    "400 Bad Request: empty version (set a ?version=<value> query parameter)",
    path,
  );
});

test("GET /v2/resolve for an unknown package is a 404 that describes the query", async () => {
  const path = "/v2/resolve?name=definitely-not-a-package-xyz&version=1";
  assertError(
    await get(path),
    404,
    '404 Not Found: no package found for: name = "definitely-not-a-package-xyz" && version = "1"',
    path,
  );
});

test("GET /v1/resolve for an unknown package is a 404 that describes the query", async () => {
  const path = "/v1/resolve?name=definitely-not-a-package-xyz&version=1";
  assertError(
    await get(path),
    404,
    '404 Not Found: no package found for: name = "definitely-not-a-package-xyz" && version = "1"',
    path,
  );
});

// ---------------------------------------------------------------------------
// Package listings
// ---------------------------------------------------------------------------

test("GET /v2/pkg?name=go lists every release, including the frozen 1.22.12", async () => {
  const path = "/v2/pkg?name=go";
  const body = okJson(await get(path), path);

  assert.equal(body.name, "go");
  assert.equal(body.summary, "Go Programming language");
  assert.equal(body.homepage_url, "https://go.dev/");
  assert.equal(body.license, "BSD-3-Clause");
  // 191 releases as of 2026-09-17; the list only grows.
  assert.ok(body.releases.length >= 191, `releases: ${body.releases.length}`);
  // Newest first.
  assert.match(body.releases[0].version, /^1\.(2[7-9]|[3-9]\d)\b/);

  const release = body.releases.find((r) => r.version === GO_1_22.version);
  assert.ok(release, "no 1.22.12 release");
  assert.equal(release.platforms_summary, "Linux and macOS");
  assert.match(release.last_updated, RFC3339);
  const platforms = Object.fromEntries(release.platforms.map((p) => [p.system, p]));
  assert.deepEqual(Object.keys(platforms).sort(), Object.keys(GO_1_22.revs));
  for (const [system, rev] of Object.entries(GO_1_22.revs)) {
    assert.equal(platforms[system].attribute_path, GO_1_22.attrPath, `${system} attribute_path`);
    assert.equal(platforms[system].commit_hash, rev, `${system} commit_hash`);
  }
  assert.deepEqual(
    { arch: platforms["x86_64-linux"].arch, os: platforms["x86_64-linux"].os },
    { arch: "x86-64", os: "Linux" },
  );
  assert.deepEqual(
    { arch: platforms["aarch64-darwin"].arch, os: platforms["aarch64-darwin"].os },
    { arch: "arm64", os: "macOS" },
  );
});

test("GET /v1/pkg?name=go lists every version, including the frozen 1.22.12", async () => {
  const path = "/v1/pkg?name=go";
  const body = okJson(await get(path), path);

  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 191, `versions: ${body.length}`);
  const entry = body.find((v) => v.version === GO_1_22.version);
  assert.ok(entry, "no 1.22.12 entry");
  assert.equal(entry.name, "go");
  assert.equal(entry.commit_hash, GO_1_22.revs["aarch64-darwin"]);
  assert.deepEqual(Object.keys(entry.systems).sort(), Object.keys(GO_1_22.revs));
  assert.equal(entry.systems["x86_64-linux"].commit_hash, GO_1_22.revs["x86_64-linux"]);
});

test("GET /v2/pkg for an unknown package is a bare 404", async () => {
  const path = "/v2/pkg?name=definitely-not-a-package-xyz";
  // Go's handler wrote http.NotFound with an empty message here.
  assertError(await get(path), 404, "404 Not Found: ", path);
});
