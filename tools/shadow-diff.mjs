#!/usr/bin/env node
/**
 * Shadow diff: replay the recorded corpus against a deployment of the new
 * service and classify every difference.
 *
 * The gate is NOT "byte-equal". Sanctioned API changes (see the migration
 * plan) mean resolved *values* may legitimately improve. The gate is:
 *
 *   every /v1/resolve and /v2/resolve divergence must classify into one of
 *   the sanctioned classes; anything unclassified fails.
 *
 * Sanctioned classes:
 *   boundary-matching   #1 partial versions are ranges, so "3.1" stops
 *                          matching 3.11
 *   sort-order          #4 the clean total-order comparator picks a
 *                          different "latest"
 *   broken-skip         #3 "latest" prefers a non-broken version
 *   single-hash         #2 one rev is emitted for all systems instead of up
 *                          to four
 *   caching-headers     #5 Cache-Control/ETag added (headers only)
 *
 * `latest` is the most common request the CLI makes, so "the comparator
 * changed" must not become a catch-all excuse for any divergence there. A
 * sort-order (or v2 broken-skip) verdict is therefore corroborated against the
 * package's version list as the NEW service reports it (GET /v1/pkg, ordered
 * by the new sort key, one cached request per package): both the old and the
 * new answer must be versions of that package, and the new answer must rank at
 * least as high as the old one. A `latest` divergence that cannot be checked
 * that way is reported, not excused.
 *
 * Usage:
 *   node tools/shadow-diff.mjs <baseUrl> [corpus.jsonl] [--json report.json]
 *
 * Exit code 0 when every resolve divergence is classified, 1 otherwise.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Argument parsing lives in a function so that importing this module (the
 * classifier is unit-tested) has no side effects.
 */
function parseArgs() {
  const baseUrl = process.argv[2];
  if (baseUrl === undefined || baseUrl.startsWith("--")) {
    console.error("usage: shadow-diff.mjs <baseUrl> [corpus.jsonl] [--json report.json]");
    process.exit(2);
  }
  const corpusPath =
    process.argv[3] !== undefined && !process.argv[3].startsWith("--")
      ? process.argv[3]
      : join(process.env.HOME, "devbox-search-data", "shadow-corpus", "corpus.jsonl");
  const jsonIdx = process.argv.indexOf("--json");
  return { baseUrl, corpusPath, jsonOut: jsonIdx === -1 ? null : process.argv[jsonIdx + 1] };
}

/** Endpoints whose divergences gate the migration. */
const isResolve = (path) => /^\/(v1\/|v2\/)?resolve\b/.test(path) || /^\/search\?.*[?&]v=/.test(path);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** All revs in a v2 resolve response, per system. */
function revsBySystem(body) {
  const out = {};
  for (const [system, info] of Object.entries(body?.systems ?? {})) {
    out[system] = info?.flake_installable?.ref?.rev;
  }
  return out;
}

/** The package name and requested version a resolve path asks for. */
export function target(path) {
  const params = new URL("http://x" + path).searchParams;
  return {
    name: params.get("name") ?? params.get("q") ?? "",
    requested: params.get("version") ?? params.get("v") ?? "",
  };
}

/**
 * Classifies one divergence, returning a class name or null when the change
 * is not sanctioned (which fails the gate).
 *
 * `ctx.versions` is the package's version list as the new service reports it,
 * ordered newest-first under the new total order, as
 * `[{ version, broken }, ...]` (see knownVersions). It is what makes a
 * `latest` divergence checkable; null when the lookup was unavailable.
 */
export function classify(path, oldBody, newBody, ctx = {}) {
  if (oldBody === null || newBody === null) return null;

  const { requested } = target(path);

  const oldVersion = oldBody.version ?? oldBody?.[0]?.version;
  const newVersion = newBody.version ?? newBody?.[0]?.version;

  // #2 single-hash: same resolved version, but the new response uses one rev
  // for every system where the old one used several.
  if (oldVersion === newVersion) {
    const oldRevs = Object.values(revsBySystem(oldBody));
    const newRevs = Object.values(revsBySystem(newBody));
    const oldDistinct = new Set(oldRevs.filter(Boolean)).size;
    const newDistinct = new Set(newRevs.filter(Boolean)).size;
    if (newDistinct === 1 && oldDistinct > 1) return "single-hash";
    // Same version and same revs: any remaining difference is not sanctioned.
    return null;
  }

  if (oldVersion === undefined || newVersion === undefined) return null;

  // #1 boundary matching: the requested version is a partial version that
  // the old service prefix-matched past a dot boundary.
  if (requested !== "" && requested !== "latest") {
    const oldPrefixOnly = oldVersion.startsWith(requested) && !boundaryMatch(requested, oldVersion);
    const newBoundary = boundaryMatch(requested, newVersion);
    if (oldPrefixOnly && newBoundary) return "boundary-matching";
  }

  // #3 broken-skip: the old "latest" was a broken build, the new one isn't.
  if (requested === "latest" && anyBroken(oldBody) && !anyBroken(newBody)) return "broken-skip";

  // #4 sort order (and the v2 shape of #3, which carries no `broken` field).
  if (requested === "latest") return classifyLatest(oldVersion, newVersion, ctx.versions ?? null);

  return null;
}

/**
 * Classifies a divergence on a `latest` request against the package's known
 * versions, newest-first under the new total order.
 *
 * The only thing sanctioned change #4 licenses is a *reordering*: the new
 * service returns the top of the same candidate set under a different order.
 * So both answers have to be versions of this package, and the new answer has
 * to sit at or above the old one in the new ordering. Returning "sort-order"
 * without checking would excuse any wrong answer at `latest` — a version from
 * another package, a garbled string, a stale row — as a sanctioned change.
 *
 * The one sanctioned way for the new answer to rank *below* the old one is
 * change #3 skipping a broken build. v2 resolve responses have no `broken`
 * field, so the version list is also what corroborates that.
 */
function classifyLatest(oldVersion, newVersion, versions) {
  if (versions === null) return null;

  const oldIdx = versions.findIndex((v) => v.version === oldVersion);
  const newIdx = versions.findIndex((v) => v.version === newVersion);
  // One of the two answers is not a version of this package: whatever
  // happened, it is not a reordering.
  if (oldIdx === -1 || newIdx === -1) return null;

  if (newIdx < oldIdx) return "sort-order";
  if (versions[oldIdx].broken && !versions[newIdx].broken) return "broken-skip";
  return null;
}

/** Whether `version` matches `requested` at a dot (or dash) boundary. */
function boundaryMatch(requested, version) {
  if (version === requested) return true;
  const next = version.slice(requested.length, requested.length + 1);
  return version.startsWith(requested) && (next === "." || next === "-");
}

function anyBroken(body) {
  if (body?.systems !== undefined) {
    return Object.values(body.systems).some((s) => s?.broken === true);
  }
  return body?.broken === true;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function parseBody(entry) {
  const text = entry.body ?? Buffer.from(entry.bodyBase64, "base64").toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const FETCH_HEADERS = {
  "Accept-Encoding": "identity",
  "User-Agent": "devbox-search-shadow-diff/1",
};

/**
 * The versions the NEW service knows for a package, newest-first under the new
 * total order, as `[{ version, broken }, ...]`.
 *
 * /v1/pkg is ordered by the seeded sort key and reports `broken` per system,
 * so this checks the resolve path against the real ordering rather than a
 * reimplementation of the comparator. Returns null when the list is
 * unavailable, which makes `latest` divergences unclassified rather than
 * silently sanctioned.
 *
 * One request per distinct package name, cached for the whole replay. The
 * listing is row-limited, so for a package with very many versions the tail of
 * the list can be missing; that can only downgrade a `latest` verdict to
 * unclassified, never the other way.
 */
async function knownVersions(baseUrl, name, cache) {
  if (name === "") return null;
  if (cache.has(name)) return cache.get(name);

  let versions = null;
  try {
    const res = await fetch(`${baseUrl}/v1/pkg?name=${encodeURIComponent(name)}`, {
      headers: FETCH_HEADERS,
    });
    const body = res.ok ? safeParse(await res.text()) : null;
    if (Array.isArray(body)) {
      versions = body
        .filter((v) => typeof v?.version === "string")
        .map((v) => ({
          version: v.version,
          // `broken` is omitempty, so it is present only when true, and only
          // in the per-system entries.
          broken: Object.values(v.systems ?? {}).some((s) => s?.broken === true),
        }));
    }
  } catch {
    versions = null;
  }
  cache.set(name, versions);
  return versions;
}

async function main() {
  const { baseUrl, corpusPath, jsonOut } = parseArgs();
  const corpus = readFileSync(corpusPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));

  const results = [];
  const versionCache = new Map();
  let identical = 0;
  let classified = 0;
  let unclassified = 0;
  let statusMismatch = 0;

  for (const entry of corpus) {
    const res = await fetch(baseUrl + entry.path, { headers: FETCH_HEADERS });
    const newText = await res.text();
    const oldText = entry.body ?? Buffer.from(entry.bodyBase64, "base64").toString("utf8");

    const record = { path: entry.path, oldStatus: entry.status, newStatus: res.status };

    if (res.status !== entry.status) {
      statusMismatch++;
      record.verdict = "status-mismatch";
      results.push(record);
      continue;
    }
    if (newText === oldText) {
      identical++;
      record.verdict = "identical";
      results.push(record);
      continue;
    }

    // A `latest` divergence is only classifiable against the package's known
    // versions, so look them up (once per package) before classifying.
    const { name, requested } = target(entry.path);
    const versions =
      requested === "latest" ? await knownVersions(baseUrl, name, versionCache) : null;

    const cls = classify(entry.path, parseBody(entry), safeParse(newText), { versions });
    if (cls !== null) {
      classified++;
      record.verdict = "sanctioned:" + cls;
    } else if (isResolve(entry.path)) {
      unclassified++;
      record.verdict = "UNCLASSIFIED";
      if (requested === "latest" && versions === null) record.versionsUnavailable = true;
      record.old = truncate(oldText);
      record.new = truncate(newText);
    } else {
      // Non-resolve endpoints (search ranking, /pkg listings) are allowed to
      // drift; they are reported but do not gate.
      record.verdict = "non-gating-diff";
    }
    results.push(record);
  }

  const gating = results.filter((r) => r.verdict === "UNCLASSIFIED" || r.verdict === "status-mismatch");
  console.log(`corpus:        ${corpus.length}`);
  console.log(`identical:     ${identical}`);
  console.log(`sanctioned:    ${classified}`);
  console.log(`non-gating:    ${results.filter((r) => r.verdict === "non-gating-diff").length}`);
  console.log(`status diffs:  ${statusMismatch}`);
  console.log(`UNCLASSIFIED:  ${unclassified}`);
  // A failed version lookup can only make a `latest` divergence unclassified,
  // never sanctioned, but say so rather than leaving it to be puzzled over.
  const noVersions = results.filter((r) => r.versionsUnavailable === true);
  if (noVersions.length > 0) {
    console.log(`  (${noVersions.length} of these could not reach /v1/pkg for the version list)`);
  }
  for (const r of gating) console.log(`  ${r.verdict}  ${r.path}`);

  if (jsonOut !== null) {
    writeFileSync(jsonOut, JSON.stringify({ baseUrl, results }, null, 2));
    console.log(`\nreport written to ${jsonOut}`);
  }
  process.exit(gating.length === 0 ? 0 : 1);
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const truncate = (s) => (s.length > 2000 ? s.slice(0, 2000) + "…" : s);

// Only replay when run directly; the classifier is imported by tests.
if (process.argv[1]?.endsWith("shadow-diff.mjs")) {
  await main();
}
