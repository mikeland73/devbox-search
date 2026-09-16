/**
 * Indexer CLI, driven by .github/workflows/index.yml.
 *
 *   cli.js discover --limit 4     list commits needing indexing (GH output)
 *   cli.js eval --nixpkgs DIR --system S --commit H --committed-at T --out F
 *   cli.js import --dir evals     import every archived eval in a directory
 *   cli.js status                 a markdown summary of the index
 */

import { appendFileSync, createReadStream, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { createGunzip } from "node:zlib";
import { text } from "node:stream/consumers";
import { createImportClient } from "@devbox-search/db";
import { DEFAULT_LIMIT, listUnstableReleases, resolveCommit, selectPendingForCommits } from "./discover.js";
import { evaluate } from "./evaluate.js";
import { importEval } from "./import.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function requireArg(name: string): string {
  const value = arg(name);
  if (value === undefined) {
    console.error(`missing required --${name}`);
    process.exit(2);
  }
  return value;
}

/** Writes a GitHub Actions step output when running in CI. */
function setOutput(name: string, value: string): void {
  const file = process.env["GITHUB_OUTPUT"];
  if (file !== undefined && file !== "") appendFileSync(file, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

async function cmdDiscover(): Promise<void> {
  const limit = Number(arg("limit") ?? String(DEFAULT_LIMIT));
  const { pool } = createImportClient();
  try {
    // EVERY imported commit, not a recent window: selectPendingForCommits
    // takes the oldest unknown release first, so a hash missing from this set
    // gets re-queued forever. One row is a 40-char hash; even 100k is nothing.
    const [releases, known] = await Promise.all([
      listUnstableReleases(),
      pool.query<{ hash: string }>(`SELECT hash FROM commits`),
    ]);

    const knownHashes = new Set(known.rows.map((r) => r.hash));
    const pending = selectPendingForCommits(releases, knownHashes, { limit });

    const commits = [];
    for (const release of pending) {
      const { hash, committedAt } = await resolveCommit(release.abbrevHash);
      if (knownHashes.has(hash)) continue;
      commits.push({ hash, committedAt: committedAt.toISOString(), release: release.name });
    }
    console.log(`${releases.length} releases, ${commits.length} to index`);
    for (const c of commits) console.log(`  ${c.hash.slice(0, 12)} ${c.committedAt} ${c.release}`);

    setOutput("commits", JSON.stringify(commits));
    setOutput("count", String(commits.length));
  } finally {
    await pool.end();
  }
}

async function cmdEval(): Promise<void> {
  const result = await evaluate({
    nixpkgsDir: requireArg("nixpkgs"),
    system: requireArg("system"),
    outputPath: arg("out") ?? "eval.json.gz",
    onProgress: (m) => console.log(m),
  });
  console.log(`eval complete: ${result.outputPath} (${result.bytes} bytes)`);
}

/**
 * Imports every eval archive under --dir. Artifact directories are named
 * eval-{system}-{commit}, which is where the system and commit come from.
 */
async function cmdImport(): Promise<void> {
  const dir = requireArg("dir");
  const entries: Array<{ path: string; system: string; commit: string }> = [];

  // download-artifact does not create --dir when no artifact matched (every
  // eval failed, or was cancelled). That is the "import whatever succeeded"
  // case the workflow runs this job for, so it must be a no-op, not ENOENT.
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const m = /^eval-([0-9a-z_-]+)-([0-9a-f]{40})$/.exec(name);
    if (m === null) continue;
    const inner = join(dir, name);
    for (const file of readdirSync(inner)) {
      if (file.endsWith(".json.gz")) {
        entries.push({ path: join(inner, file), system: m[1]!, commit: m[2]! });
      }
    }
  }
  if (entries.length === 0) {
    console.log(`no eval archives found under ${dir}`);
    return;
  }

  // Import oldest commit first so commit seq stays dense and ordered; within
  // a commit the system order doesn't matter. Dates come from the GitHub API,
  // not the DB — importEval opens its own connection.
  const dates = new Map<string, Date>();
  for (const commit of new Set(entries.map((e) => e.commit))) {
    const { committedAt } = await resolveCommit(commit);
    dates.set(commit, committedAt);
  }
  entries.sort((a, b) => {
    const da = dates.get(a.commit)!.getTime();
    const db = dates.get(b.commit)!.getTime();
    return da !== db ? da - db : a.system < b.system ? -1 : 1;
  });

  let failures = 0;
  for (const entry of entries) {
    console.log(`\n=== ${basename(entry.path)} (${entry.system}) ===`);
    try {
      const json = JSON.parse(await text(createReadStream(entry.path).pipe(createGunzip()))) as unknown;
      await importEval({
        json,
        commitHash: entry.commit,
        committedAt: dates.get(entry.commit)!,
        system: entry.system,
        onProgress: (m) => console.log(m),
      });
    } catch (err) {
      failures++;
      console.error(`import failed for ${entry.path}:`, err);
    }
  }
  if (failures > 0) {
    console.error(`${failures} of ${entries.length} imports failed`);
    process.exit(1);
  }
}

async function cmdStatus(): Promise<void> {
  const { pool } = createImportClient();
  try {
    const counts = await pool.query<{ table_name: string; n: string }>(`
      SELECT 'commits' AS table_name, count(*)::text AS n FROM commits
      UNION ALL SELECT 'packages', count(*)::text FROM packages
      UNION ALL SELECT 'versions', count(*)::text FROM versions
      UNION ALL SELECT 'meta', count(*)::text FROM meta
      UNION ALL SELECT 'variants', count(*)::text FROM variants
      UNION ALL SELECT 'open ranges', count(*)::text FROM variant_ranges WHERE last_seq IS NULL
    `);
    const head = await pool.query<{ seq: number; hash: string; committed_at: Date }>(
      `SELECT seq, hash, committed_at FROM commits ORDER BY seq DESC LIMIT 1`,
    );
    const systems = await pool.query<{ system: string; n: string }>(
      `SELECT system, count(*)::text AS n FROM commit_systems GROUP BY system ORDER BY system`,
    );

    console.log("## Index status\n");
    if (head.rows[0] !== undefined) {
      const h = head.rows[0];
      console.log(`Head: seq ${h.seq} \`${h.hash.slice(0, 12)}\` (${h.committed_at.toISOString()})\n`);
    }
    console.log("| table | rows |");
    console.log("|---|---|");
    for (const row of counts.rows) console.log(`| ${row.table_name} | ${row.n} |`);
    console.log("\n| system | commits imported |");
    console.log("|---|---|");
    for (const row of systems.rows) console.log(`| ${row.system} | ${row.n} |`);
  } finally {
    await pool.end();
  }
}

const command = process.argv[2];
switch (command) {
  case "discover":
    await cmdDiscover();
    break;
  case "eval":
    await cmdEval();
    break;
  case "import":
    await cmdImport();
    break;
  case "status":
    await cmdStatus();
    break;
  default:
    console.error(`usage: cli.js <discover|eval|import|status> [options]`);
    process.exit(2);
}
