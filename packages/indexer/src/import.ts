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
 */

import { createImportClient } from "@devbox-search/db";
import { canonicalName, contentHash, decodeEvalJson, metaHash, type EvalPackage } from "@devbox-search/core";
import { copyRows, type CopyValue } from "./copy.js";
import { packageKey, toVersionRow } from "./seedTransform.js";

/** Advisory lock key shared with the seed. */
const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('devbox-search-index'))";

export interface ImportOptions {
  /** Parsed eval JSON (nix-env or Hydra shape). */
  json: unknown;
  commitHash: string;
  committedAt: Date;
  system: string;
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
    const decoded = decodeEvalJson(options.json, options.commitHash, options.committedAt);
    log(`decoded ${decoded.packages.length} attribute paths for ${options.system}`);

    const rows = decoded.packages
      // An eval is per-system, but Hydra JSON can carry a system field; trust
      // the requested system so a mislabelled row can't corrupt another one.
      .map((pkg) => ({ ...pkg, system: options.system }))
      .map((pkg) => ({
        pkg,
        name: canonicalName(pkg.attrPath),
        version: pkg.storeVersion,
        metaHash: metaHash(pkg),
        contentHash: contentHash(pkg),
      }))
      // Rows without a version can't be addressed by the API and were never
      // stored by the old service either.
      .filter((r) => r.version !== "");

    await client.query("BEGIN");
    await client.query(LOCK_SQL);

    // ---------------------------------------------------------------------
    // Idempotency + ordering guards
    // ---------------------------------------------------------------------
    const existing = await client.query<{ seq: number }>(
      `SELECT c.seq FROM commits c
       JOIN commit_systems cs ON cs.commit_seq = c.seq AND cs.system = $2
       WHERE c.hash = $1`,
      [options.commitHash, options.system],
    );
    if (existing.rowCount !== null && existing.rowCount > 0) {
      await client.query("ROLLBACK");
      log(`(${options.commitHash.slice(0, 7)}, ${options.system}) already imported; skipping`);
      return emptyResult(existing.rows[0]!.seq, true);
    }

    const head = await client.query<{ seq: number; committed_at: Date }>(
      `SELECT seq, committed_at FROM commits ORDER BY seq DESC LIMIT 1`,
    );
    const headRow = head.rows[0];

    // The commit may already exist if another system was imported first.
    const known = await client.query<{ seq: number }>(`SELECT seq FROM commits WHERE hash = $1`, [
      options.commitHash,
    ]);
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
      await client.query(`INSERT INTO commits (seq, hash, committed_at) VALUES ($1, $2, $3)`, [
        commitSeq,
        options.commitHash,
        options.committedAt,
      ]);
    }

    // The previous imported seq FOR THIS SYSTEM bounds any range we close:
    // a variant that vanished was last seen then, not at the current commit.
    const prev = await client.query<{ seq: number }>(
      `SELECT commit_seq AS seq FROM commit_systems
       WHERE system = $1 AND commit_seq < $2 ORDER BY commit_seq DESC LIMIT 1`,
      [options.system, commitSeq],
    );
    const prevSeq = prev.rows[0]?.seq ?? null;

    // ---------------------------------------------------------------------
    // 2. Stage the skinny keys
    // ---------------------------------------------------------------------
    await client.query(`
      CREATE TEMP TABLE stage_keys (
        name text NOT NULL,
        name_key text NOT NULL,
        version text NOT NULL,
        attr_path text NOT NULL,
        meta_hash char(64) NOT NULL,
        content_hash char(64) NOT NULL
      ) ON COMMIT DROP
    `);
    const staged = await copyRows(
      client,
      "stage_keys",
      ["name", "name_key", "version", "attr_path", "meta_hash", "content_hash"],
      rows.map((r) => [r.name, packageKey(r.name), r.version, r.pkg.attrPath, r.metaHash, r.contentHash] as CopyValue[]),
    );
    log(`staged ${staged} keys`);
    await client.query(`CREATE INDEX ON stage_keys (name_key, version)`);
    await client.query(`ANALYZE stage_keys`);

    // ---------------------------------------------------------------------
    // 3a. Insert missing packages and versions
    // ---------------------------------------------------------------------
    const newPackages = await client.query(`
      INSERT INTO packages (name)
      SELECT DISTINCT ON (s.name_key) s.name
      FROM stage_keys s
      WHERE NOT EXISTS (SELECT 1 FROM packages p WHERE lower(p.name) = s.name_key)
      ORDER BY s.name_key, s.name
      ON CONFLICT DO NOTHING
    `);

    // Version rows need the client-computed sort key, so stage those too.
    const missingVersions = await client.query<{ name_key: string; version: string }>(`
      SELECT DISTINCT s.name_key, s.version
      FROM stage_keys s
      JOIN packages p ON lower(p.name) = s.name_key
      WHERE NOT EXISTS (
        SELECT 1 FROM versions v WHERE v.package_id = p.id AND v.version = s.version
      )
    `);
    let newVersions = 0;
    if (missingVersions.rowCount !== null && missingVersions.rowCount > 0) {
      await client.query(`
        CREATE TEMP TABLE stage_versions (
          name_key text NOT NULL,
          version text NOT NULL,
          sort_key bytea NOT NULL,
          prerelease boolean NOT NULL,
          semver_major integer,
          semver_minor integer,
          semver_patch integer,
          semver_pre text
        ) ON COMMIT DROP
      `);
      await copyRows(
        client,
        "stage_versions",
        ["name_key", "version", "sort_key", "prerelease", "semver_major", "semver_minor", "semver_patch", "semver_pre"],
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
      const inserted = await client.query(`
        INSERT INTO versions (package_id, version, sort_key, prerelease, semver_major, semver_minor, semver_patch, semver_pre)
        SELECT p.id, sv.version, sv.sort_key, sv.prerelease, sv.semver_major, sv.semver_minor, sv.semver_patch, sv.semver_pre
        FROM stage_versions sv
        JOIN packages p ON lower(p.name) = sv.name_key
        ON CONFLICT (package_id, version) DO NOTHING
      `);
      newVersions = inserted.rowCount ?? 0;
    }

    // ---------------------------------------------------------------------
    // 3a'. Meta: ask the server which hashes it lacks, upload only those
    // ---------------------------------------------------------------------
    const missingMeta = await client.query<{ meta_hash: string }>(`
      SELECT DISTINCT s.meta_hash FROM stage_keys s
      WHERE NOT EXISTS (SELECT 1 FROM meta m WHERE m.hash = s.meta_hash)
    `);
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
      await client.query(`
        CREATE TEMP TABLE stage_meta (
          hash char(64) NOT NULL, summary text NOT NULL, description text NOT NULL,
          homepage text NOT NULL, license text NOT NULL, platforms jsonb NOT NULL
        ) ON COMMIT DROP
      `);
      await copyRows(
        client,
        "stage_meta",
        ["hash", "summary", "description", "homepage", "license", "platforms"],
        blobs,
      );
      const inserted = await client.query(`
        INSERT INTO meta (hash, summary, description, homepage, license, platforms)
        SELECT hash, summary, description, homepage, license, platforms FROM stage_meta
        ON CONFLICT (hash) DO NOTHING
      `);
      newMeta = inserted.rowCount ?? 0;
      log(`meta: ${newMeta} new blobs uploaded (of ${rows.length} rows)`);
    }

    // ---------------------------------------------------------------------
    // 3b. Anti-join: which variants are new or changed?
    // ---------------------------------------------------------------------
    const changed = await client.query<{ name_key: string; version: string; attr_path: string }>(
      `
      SELECT s.name_key, s.version, s.attr_path
      FROM stage_keys s
      JOIN packages p ON lower(p.name) = s.name_key
      JOIN versions v ON v.package_id = p.id AND v.version = s.version
      LEFT JOIN variants va
        ON va.version_id = v.id AND va.system = $1 AND va.attr_path = s.attr_path
      WHERE va.id IS NULL OR va.content_hash <> s.content_hash
    `,
      [options.system],
    );
    const changedCount = changed.rowCount ?? 0;
    log(`variants: ${changedCount} new or changed (of ${rows.length})`);

    // ---------------------------------------------------------------------
    // 3c. Upload full rows for the changed set only
    // ---------------------------------------------------------------------
    if (changedCount > 0) {
      const wanted = new Set(changed.rows.map((r) => `${r.name_key}\t${r.version}\t${r.attr_path}`));
      await client.query(`
        CREATE TEMP TABLE stage_variants (
          name_key text NOT NULL, version text NOT NULL, attr_path text NOT NULL,
          meta_hash char(64) NOT NULL, store_hash text NOT NULL, store_name text NOT NULL,
          meta_name text NOT NULL, meta_version jsonb NOT NULL, program text NOT NULL,
          broken boolean NOT NULL, insecure boolean NOT NULL, outputs jsonb NOT NULL,
          content_hash char(64) NOT NULL
        ) ON COMMIT DROP
      `);
      await copyRows(
        client,
        "stage_variants",
        [
          "name_key",
          "version",
          "attr_path",
          "meta_hash",
          "store_hash",
          "store_name",
          "meta_name",
          "meta_version",
          "program",
          "broken",
          "insecure",
          "outputs",
          "content_hash",
        ],
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

      // commit_seq is the commit of the last CONTENT change, which is what
      // the API reports as commit_hash/last_updated.
      await client.query(
        `
        INSERT INTO variants (
          version_id, system, attr_path, meta_id, commit_seq, store_hash, store_name,
          meta_name, meta_version, program, broken, insecure, outputs, content_hash
        )
        SELECT v.id, $1, sv.attr_path, m.id, $2, sv.store_hash, sv.store_name,
               sv.meta_name, sv.meta_version, sv.program, sv.broken, sv.insecure,
               sv.outputs, sv.content_hash
        FROM stage_variants sv
        JOIN packages p ON lower(p.name) = sv.name_key
        JOIN versions v ON v.package_id = p.id AND v.version = sv.version
        JOIN meta m ON m.hash = sv.meta_hash
        ON CONFLICT (version_id, system, attr_path) DO UPDATE SET
          meta_id = EXCLUDED.meta_id,
          commit_seq = EXCLUDED.commit_seq,
          store_hash = EXCLUDED.store_hash,
          store_name = EXCLUDED.store_name,
          meta_name = EXCLUDED.meta_name,
          meta_version = EXCLUDED.meta_version,
          program = EXCLUDED.program,
          broken = EXCLUDED.broken,
          insecure = EXCLUDED.insecure,
          outputs = EXCLUDED.outputs,
          content_hash = EXCLUDED.content_hash
      `,
        [options.system, commitSeq],
      );
    }

    // ---------------------------------------------------------------------
    // 3d. Range maintenance, scoped to this system
    // ---------------------------------------------------------------------
    // Close ranges for variants of this system that are absent from this eval.
    // last_seq is the PREVIOUS imported seq for this system: that's the last
    // commit where we actually observed the variant.
    let rangesClosed = 0;
    if (prevSeq !== null) {
      const closed = await client.query(
        `
        UPDATE variant_ranges r SET last_seq = $2
        FROM variants va
        JOIN versions v ON v.id = va.version_id
        JOIN packages p ON p.id = v.package_id
        WHERE r.variant_id = va.id
          AND r.last_seq IS NULL
          AND va.system = $1
          AND NOT EXISTS (
            SELECT 1 FROM stage_keys s
            WHERE s.name_key = lower(p.name) AND s.version = v.version AND s.attr_path = va.attr_path
          )
      `,
        [options.system, prevSeq],
      );
      rangesClosed = closed.rowCount ?? 0;
    }

    // Open a range for every present variant that has no open one. This
    // covers both brand-new variants and variants that reappeared after
    // being closed.
    const opened = await client.query(
      `
      INSERT INTO variant_ranges (variant_id, first_seq, last_seq, seeded)
      SELECT va.id, $2, NULL, false
      FROM stage_keys s
      JOIN packages p ON lower(p.name) = s.name_key
      JOIN versions v ON v.package_id = p.id AND v.version = s.version
      JOIN variants va ON va.version_id = v.id AND va.system = $1 AND va.attr_path = s.attr_path
      WHERE NOT EXISTS (
        SELECT 1 FROM variant_ranges r WHERE r.variant_id = va.id AND r.last_seq IS NULL
      )
      ON CONFLICT (variant_id, first_seq) DO NOTHING
    `,
      [options.system, commitSeq],
    );
    const rangesOpened = opened.rowCount ?? 0;

    // ---------------------------------------------------------------------
    // 3e. search_terms, commit_systems, done
    // ---------------------------------------------------------------------
    await client.query(`
      INSERT INTO search_terms (package_id, name, attr_path, top_level_attr)
      SELECT DISTINCT p.id, p.name, s.attr_path,
             CASE WHEN position('.' in s.attr_path) = 0 THEN s.attr_path END
      FROM stage_keys s
      JOIN packages p ON lower(p.name) = s.name_key
      ON CONFLICT (name, attr_path) DO NOTHING
    `);

    await client.query(
      `INSERT INTO commit_systems (commit_seq, system) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [commitSeq, options.system],
    );

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

/** Exported for tests: the rows an eval contributes, before any DB contact. */
export function evalRows(json: unknown, commitHash: string, committedAt: Date, system: string) {
  const decoded = decodeEvalJson(json, commitHash, committedAt);
  return decoded.packages
    .map((pkg: EvalPackage) => ({ ...pkg, system }))
    .map((pkg: EvalPackage) => ({
      pkg,
      name: canonicalName(pkg.attrPath),
      version: pkg.storeVersion,
      metaHash: metaHash(pkg),
      contentHash: contentHash(pkg),
    }))
    .filter((r) => r.version !== "");
}
