/**
 * Incremental import: one (commit, system) eval into Postgres.
 *
 * The store is never rebuilt, so this is a set-based merge, not a reload.
 * The shape exists to keep Neon egress at ~0: we never download DB state to
 * diff against it. Instead every key from the eval is COPYed into a temp
 * table and the diffing happens server-side.
 *
 *   1. Parse the eval JSON with the same core decoder the seed used, so
 *      content hashes agree and unchanged variants produce no writes.
 *   2. COPY skinny keys (~1M rows, ~120 MB, ingress is free) into stage_keys.
 *   3. In one transaction:
 *      a. insert missing packages / versions / meta (the server tells us
 *         which meta hashes it lacks, and only those blobs are uploaded);
 *      b. anti-join on content_hash to find new-or-changed variants;
 *      c. COPY full rows for the changed set only and upsert;
 *      d. maintain variant_ranges for THIS system: close ranges that are
 *         absent from this eval, open ranges for present variants that
 *         lack one, leave present+open alone;
 *      e. upsert search_terms, record the commit and commit_system.
 *
 * Concurrency: a session advisory lock, matching the CI `concurrency: indexer`
 * group. Idempotent: a (commit, system) already in commit_systems is skipped.
 * Commits older than the DB head are refused, because commit seq must stay
 * dense and ordered for the range logic to mean anything.
 *
 * Every statement lives in importSql.ts so the PGlite scenario tests can run
 * the same SQL this does.
 */

import { createImportClient } from "@devbox-search/db";
import { canonicalName, contentHash, decodeEvalJson, metaHash, type EvalPackage } from "@devbox-search/core";
import { copyRows, type CopyValue } from "./copy.js";
import { packageKey, toVersionRow } from "./seedTransform.js";
import * as SQL from "./importSql.js";

export interface ImportOptions {
  /** Parsed eval JSON (nix-env or Hydra shape). */
  json: unknown;
  commitHash: string;
  committedAt: Date;
  system: string;
  /**
   * `nix --version` of the Nix that produced the eval, when the archive
   * carried it (R2 object metadata written by the eval workflow). Recorded on
   * commit_systems so an output-shape change can be traced to a Nix upgrade.
   */
  nixVersion?: string | null;
  connectionString?: string;
  onProgress?: (message: string) => void;
}

export interface ImportResult {
  skipped: boolean;
  commitSeq: number;
  scanned: number;
  newPackages: number;
  newVersions: number;
  newMeta: number;
  changedVariants: number;
  rangesOpened: number;
  rangesClosed: number;
}

export async function importEval(options: ImportOptions): Promise<ImportResult> {
  const log = options.onProgress ?? ((m: string) => console.log(m));
  const { pool } = createImportClient(options.connectionString);
  const client = await pool.connect();

  try {
    // ---------------------------------------------------------------------
    // 1. Parse client-side (same decoder + hashers as the seed)
    // ---------------------------------------------------------------------
    const rows = evalRows(options.json, options.commitHash, options.committedAt, options.system);
    log(`decoded ${rows.length} rows for ${options.system}`);

    await client.query("BEGIN");
    await client.query(SQL.LOCK);

    // ---------------------------------------------------------------------
    // Idempotency + ordering guards
    // ---------------------------------------------------------------------
    const existing = await client.query<{ seq: number }>(SQL.EXISTING_IMPORT, [
      options.commitHash,
      options.system,
    ]);
    if (existing.rowCount !== null && existing.rowCount > 0) {
      await client.query("ROLLBACK");
      log(`(${options.commitHash.slice(0, 7)}, ${options.system}) already imported; skipping`);
      return emptyResult(existing.rows[0]!.seq, true);
    }

    const head = await client.query<{ seq: number; committed_at: Date }>(SQL.HEAD_COMMIT);
    const headRow = head.rows[0];

    // The commit may already exist if another system was imported first.
    const known = await client.query<{ seq: number }>(SQL.COMMIT_BY_HASH, [options.commitHash]);
    let commitSeq: number;
    if (known.rowCount !== null && known.rowCount > 0) {
      commitSeq = known.rows[0]!.seq;
    } else {
      if (headRow !== undefined && options.committedAt <= headRow.committed_at) {
        await client.query("ROLLBACK");
        throw new Error(
          `refusing commit ${options.commitHash.slice(0, 7)} dated ${options.committedAt.toISOString()}: ` +
            `not newer than DB head seq ${headRow.seq} (${headRow.committed_at.toISOString()}). ` +
            `Commit seq must stay dense and ordered for range logic.`,
        );
      }
      commitSeq = (headRow?.seq ?? 0) + 1;
      await client.query(SQL.INSERT_COMMIT, [commitSeq, options.commitHash, options.committedAt]);
    }

    // The previous imported seq FOR THIS SYSTEM bounds any range we close:
    // a variant that vanished was last seen then, not at the current commit.
    const prev = await client.query<{ seq: number }>(SQL.PREV_SYSTEM_SEQ, [
      options.system,
      commitSeq,
    ]);
    const prevSeq = prev.rows[0]?.seq ?? null;

    // ---------------------------------------------------------------------
    // 2. Stage the skinny keys
    // ---------------------------------------------------------------------
    await client.query(SQL.STAGE_KEYS_DDL);
    const staged = await copyRows(
      client,
      "stage_keys",
      SQL.STAGE_KEYS_COLUMNS,
      rows.map((r) => [r.name, packageKey(r.name), r.version, r.pkg.attrPath, r.metaHash, r.contentHash] as CopyValue[]),
    );
    log(`staged ${staged} keys`);
    await client.query(SQL.STAGE_KEYS_INDEX);
    await client.query(`ANALYZE stage_keys`);

    // ---------------------------------------------------------------------
    // 3a. Insert missing packages and versions
    // ---------------------------------------------------------------------
    const newPackages = await client.query(SQL.INSERT_PACKAGES);

    // Version rows need the client-computed sort key, so stage those too.
    const missingVersions = await client.query<{ name_key: string; version: string }>(
      SQL.MISSING_VERSIONS,
    );
    let newVersions = 0;
    if (missingVersions.rowCount !== null && missingVersions.rowCount > 0) {
      await client.query(SQL.STAGE_VERSIONS_DDL);
      await copyRows(
        client,
        "stage_versions",
        SQL.STAGE_VERSIONS_COLUMNS,
        missingVersions.rows.map((r) => {
          const v = toVersionRow(r.name_key, r.version);
          return [
            r.name_key,
            r.version,
            v.sortKey,
            v.prerelease,
            v.semverMajor,
            v.semverMinor,
            v.semverPatch,
            v.semverPre,
          ] as CopyValue[];
        }),
      );
      const inserted = await client.query(SQL.INSERT_VERSIONS);
      newVersions = inserted.rowCount ?? 0;
    }

    // ---------------------------------------------------------------------
    // 3a'. Meta: ask the server which hashes it lacks, upload only those
    // ---------------------------------------------------------------------
    const missingMeta = await client.query<{ meta_hash: string }>(SQL.MISSING_META);
    let newMeta = 0;
    if (missingMeta.rowCount !== null && missingMeta.rowCount > 0) {
      const wanted = new Set(missingMeta.rows.map((r) => r.meta_hash));
      const seen = new Set<string>();
      const blobs: CopyValue[][] = [];
      for (const r of rows) {
        if (!wanted.has(r.metaHash) || seen.has(r.metaHash)) continue;
        seen.add(r.metaHash);
        blobs.push([
          r.metaHash,
          r.pkg.summary,
          r.pkg.description,
          r.pkg.homepage,
          r.pkg.license,
          r.pkg.platforms,
        ]);
      }
      await client.query(SQL.STAGE_META_DDL);
      await copyRows(client, "stage_meta", SQL.STAGE_META_COLUMNS, blobs);
      const inserted = await client.query(SQL.INSERT_META);
      newMeta = inserted.rowCount ?? 0;
      log(`meta: ${newMeta} new blobs uploaded (of ${rows.length} rows)`);
    }

    // ---------------------------------------------------------------------
    // 3b. Anti-join: which variants are new or changed?
    // ---------------------------------------------------------------------
    const changed = await client.query<{ name_key: string; version: string; attr_path: string }>(
      SQL.CHANGED_VARIANTS,
      [options.system],
    );
    const changedCount = changed.rowCount ?? 0;
    log(`variants: ${changedCount} new or changed (of ${rows.length})`);
    const warning = changeRatioWarning(changedCount, rows.length, prevSeq);
    if (warning !== null) log(`WARNING: ${warning}`);

    // ---------------------------------------------------------------------
    // 3c. Upload full rows for the changed set only
    // ---------------------------------------------------------------------
    if (changedCount > 0) {
      const wanted = new Set(changed.rows.map((r) => `${r.name_key}\t${r.version}\t${r.attr_path}`));
      await client.query(SQL.STAGE_VARIANTS_DDL);
      await copyRows(
        client,
        "stage_variants",
        SQL.STAGE_VARIANTS_COLUMNS,
        rows
          .filter((r) => wanted.has(`${packageKey(r.name)}\t${r.version}\t${r.pkg.attrPath}`))
          .map(
            (r) =>
              [
                packageKey(r.name),
                r.version,
                r.pkg.attrPath,
                r.metaHash,
                r.pkg.storeHash,
                r.pkg.storeName,
                r.pkg.metaName,
                r.pkg.metaVersion,
                r.pkg.program,
                r.pkg.broken,
                r.pkg.insecure,
                r.pkg.outputs,
                r.contentHash,
              ] as CopyValue[],
          ),
      );

      await client.query(SQL.UPSERT_VARIANTS, [options.system, commitSeq]);
    }

    // ---------------------------------------------------------------------
    // 3d. Range maintenance, scoped to this system
    // ---------------------------------------------------------------------
    // Close ranges for variants of this system that are absent from this eval.
    // last_seq is the PREVIOUS imported seq for this system: that's the last
    // commit where we actually observed the variant.
    let rangesClosed = 0;
    if (prevSeq !== null) {
      const closed = await client.query(SQL.CLOSE_RANGES, [options.system, prevSeq]);
      rangesClosed = closed.rowCount ?? 0;
    }

    // Open a range for every present variant that has no open one. This
    // covers both brand-new variants and variants that reappeared after
    // being closed.
    const opened = await client.query(SQL.OPEN_RANGES, [options.system, commitSeq]);
    const rangesOpened = opened.rowCount ?? 0;

    // ---------------------------------------------------------------------
    // 3e. search_terms, commit_systems, done
    // ---------------------------------------------------------------------
    await client.query(SQL.INSERT_SEARCH_TERMS);

    await client.query(SQL.INSERT_COMMIT_SYSTEM, [commitSeq, options.system, options.nixVersion ?? null]);

    await client.query("COMMIT");
    log(
      `imported ${options.commitHash.slice(0, 7)}/${options.system} as seq ${commitSeq}: ` +
        `${changedCount} variants, +${rangesOpened} ranges, -${rangesClosed} closed`,
    );

    return {
      skipped: false,
      commitSeq,
      scanned: rows.length,
      newPackages: newPackages.rowCount ?? 0,
      newVersions,
      newMeta,
      changedVariants: changedCount,
      rangesOpened,
      rangesClosed,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

function emptyResult(commitSeq: number, skipped: boolean): ImportResult {
  return {
    skipped,
    commitSeq,
    scanned: 0,
    newPackages: 0,
    newVersions: 0,
    newMeta: 0,
    changedVariants: 0,
    rangesOpened: 0,
    rangesClosed: 0,
  };
}

/**
 * The rows an eval contributes, before any DB contact: decoded, hashed, and
 * checked. Throws rather than returning a row with no store hash.
 *
 * decodeEvalJson already drops nix-env stubs (listed but unevaluable: no
 * outputs, no meta). This is the second line of defence at the importer
 * boundary, because the failure mode is quiet and expensive: the one time
 * stubs got through they became ~75k phantom variants per commit and ~11k
 * fake packages with broken=false, cleaned up by hand. A future decoder
 * change, another eval producer or a hand-run import must fail here, not
 * write that again. The variants CHECK constraint is the third line.
 */
export function evalRows(json: unknown, commitHash: string, committedAt: Date, system: string) {
  const decoded = decodeEvalJson(json, commitHash, committedAt);
  const rows = decoded.packages
    // An eval is per-system, but Hydra JSON can carry a system field; trust
    // the requested system so a mislabelled row can't corrupt another one.
    .map((pkg: EvalPackage) => ({ ...pkg, system }))
    .map((pkg: EvalPackage) => ({
      pkg,
      name: canonicalName(pkg.attrPath),
      version: pkg.storeVersion,
      metaHash: metaHash(pkg),
      contentHash: contentHash(pkg),
    }))
    // Rows without a version can't be addressed by the API and were never
    // stored by the old service either.
    .filter((r) => r.version !== "");

  const stubs = rows.filter((r) => r.pkg.storeHash === "");
  if (stubs.length > 0) {
    const sample = stubs
      .slice(0, 5)
      .map((r) => r.pkg.attrPath)
      .join(", ");
    throw new Error(
      `refusing to import ${commitHash.slice(0, 7)}/${system}: ${stubs.length} of ${rows.length} rows ` +
        `have no store hash (e.g. ${sample}). These are nix-env stubs that decodeEvalJson should have ` +
        `dropped; importing them would create phantom packages.`,
    );
  }
  return rows;
}

/**
 * Above this share of new-or-changed variants, something is probably wrong
 * with the eval rather than with nixpkgs. A normal day is ~1–1.5%.
 */
export const CHANGE_RATIO_WARN_THRESHOLD = 0.2;

/**
 * A loud-log message when an import changes an implausible share of its
 * rows, or null when the numbers look like a normal day.
 *
 * Only a warning, not a failure: a staging-next merge legitimately rebuilds
 * nearly every package (new store hashes → new content hashes), and blocking
 * the index on that would be wrong. The stub guard above is the hard stop
 * for the known bad case; this catches the ones we haven't met yet, in the
 * CI log. Skipped when there is no previous import for the system, since
 * the first one is 100% new by definition.
 */
export function changeRatioWarning(changed: number, scanned: number, prevSeq: number | null): string | null {
  if (prevSeq === null || scanned === 0) return null;
  const ratio = changed / scanned;
  if (ratio <= CHANGE_RATIO_WARN_THRESHOLD) return null;
  return (
    `${changed} of ${scanned} variants (${(ratio * 100).toFixed(1)}%) are new or changed; ` +
    `a normal day is ~1–1.5%. Expected after a mass rebuild (staging-next), ` +
    `otherwise the eval or decoder is probably wrong — inspect this import before trusting it.`
  );
}
