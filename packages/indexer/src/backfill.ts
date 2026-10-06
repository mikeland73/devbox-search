/**
 * Backfill: history for packages that evals before #101 could not see.
 *
 * eval.nix started passing versions nix-env cannot read from a package's
 * name (`gitwatch`, `dotacat-v0.3.0`, `nix-info`) in #101. Imports from
 * then on have those packages; every commit imported before it has none of
 * them. Re-running the full eval for a year of commits is ~1,100 jobs at
 * ~15 GB each. `eval.nix --arg hiddenOnly true` lists just those ~200
 * derivations in ~15 s, and this turns one such eval per (commit, system)
 * into the rows and presence ranges the forward import would have written,
 * had it seen them.
 *
 * The forward importer cannot do it: it only appends commits newer than the
 * head, and its range logic assumes each eval is the newest state. Here
 * every commit is already in `commits`/`commit_systems`, so ranges are
 * computed client-side from the whole window at once (planBackfill) and
 * written in one transaction (applyBackfill):
 *
 *   - a range per run of consecutive evaluated commits a variant is in;
 *     a commit whose eval is missing doesn't break a run, the way the
 *     forward import closes ranges at the previous imported seq;
 *   - the variant row from its last observation, with commit_seq where
 *     that content first appeared (the forward import's meaning);
 *   - a run that ends right before a live range of the same variant (the
 *     forward import's, from the first commit after the window) extends
 *     that range instead of adding a second one.
 *
 * An existing variant keeps its row unless the backfill saw it later (a
 * seed-era row). Re-running the same backfill writes nothing; a window that
 * reaches into commits already imported with these rows is refused.
 */

import type { CopyValue } from "./copy.js";
import { evalRows } from "./import.js";
import { packageKey, toVersionRow } from "./seedTransform.js";
import * as SQL from "./importSql.js";
import { REFRESH_ROW_COUNTS } from "@devbox-search/db";

export type EvalRow = ReturnType<typeof evalRows>[number];

/** One hidden-only eval of a commit already in the database. */
export interface BackfillEval {
  system: string;
  seq: number;
  rows: EvalRow[];
}

export interface BackfillVariant {
  system: string;
  commitSeq: number;
  row: EvalRow;
}

export interface BackfillRange {
  system: string;
  nameKey: string;
  version: string;
  attrPath: string;
  firstSeq: number;
  lastSeq: number;
  /** The system's next imported seq after lastSeq; null at the head. */
  nextSeq: number | null;
}

export interface BackfillPlan {
  variants: BackfillVariant[];
  ranges: BackfillRange[];
}

/**
 * A full eval has ~110k rows; a hidden-only one ~200–300. Anything near the
 * former is the wrong archive, and would write history for every package.
 */
export const MAX_BACKFILL_ROWS = 2000;

const variantKey = (system: string, r: EvalRow) =>
  `${system}\t${packageKey(r.name)}\t${r.version}\t${r.pkg.attrPath}`;

/**
 * Ranges and variant rows for a set of evals. `importedSeqs` is every seq
 * each system has in commit_systems, ascending; it supplies nextSeq, so a
 * window ending just before the forward import's first commit with these
 * rows joins up with it.
 */
export function planBackfill(evals: BackfillEval[], importedSeqs: Map<string, number[]>): BackfillPlan {
  interface Run {
    system: string;
    row: EvalRow;
    firstSeq: number;
    lastSeq: number;
    /** Where the current content first appeared. */
    contentSeq: number;
  }
  const variants: BackfillVariant[] = [];
  const ranges: BackfillRange[] = [];

  const bySystem = new Map<string, BackfillEval[]>();
  for (const e of evals) {
    if (e.rows.length > MAX_BACKFILL_ROWS) {
      throw new Error(
        `eval of seq ${e.seq}/${e.system} has ${e.rows.length} rows: not a hidden-only eval (eval.nix --arg hiddenOnly true)`,
      );
    }
    bySystem.set(e.system, [...(bySystem.get(e.system) ?? []), e]);
  }

  for (const [system, systemEvals] of bySystem) {
    const imported = importedSeqs.get(system) ?? [];
    const nextImported = (seq: number): number | null => imported.find((s) => s > seq) ?? null;
    const open = new Map<string, Run>();
    /** Each variant's newest run once closed: its row, and where a reappearance's content began. */
    const latest = new Map<string, Run>();
    const close = (key: string, run: Run) => {
      ranges.push({
        system,
        nameKey: packageKey(run.row.name),
        version: run.row.version,
        attrPath: run.row.pkg.attrPath,
        firstSeq: run.firstSeq,
        lastSeq: run.lastSeq,
        nextSeq: nextImported(run.lastSeq),
      });
      latest.set(key, run);
    };

    const sorted = [...systemEvals].sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < sorted.length; i++) {
      const { seq, rows } = sorted[i]!;
      if (i > 0 && sorted[i - 1]!.seq === seq) throw new Error(`two evals of seq ${seq}/${system}`);
      const present = new Set<string>();
      for (const row of rows) {
        const key = variantKey(system, row);
        if (present.has(key)) continue;
        present.add(key);
        const run = open.get(key);
        if (run !== undefined) {
          if (run.row.contentHash !== row.contentHash) run.contentSeq = seq;
          run.row = row;
          run.lastSeq = seq;
        } else {
          // New, or back after a gap: a new interval. Like the forward
          // import, unchanged content keeps the seq it first appeared at.
          const before = latest.get(key);
          const contentSeq =
            before !== undefined && before.row.contentHash === row.contentHash ? before.contentSeq : seq;
          open.set(key, { system, row, firstSeq: seq, lastSeq: seq, contentSeq });
        }
      }
      for (const [key, run] of open) {
        if (present.has(key)) continue;
        close(key, run);
        open.delete(key);
      }
    }
    for (const [key, run] of open) close(key, run);
    for (const run of latest.values()) variants.push({ system, commitSeq: run.contentSeq, row: run.row });
  }
  return { variants, ranges };
}

/**
 * The database operations applyBackfill needs: a query, and a bulk load
 * into a staging table (COPY in production, INSERTs under PGlite).
 */
export interface BackfillDb {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[]; count: number }>;
  stage(table: string, columns: string[], rows: CopyValue[][]): Promise<void>;
}

export interface BackfillResult {
  newPackages: number;
  newVersions: number;
  /** Inserted, or updated from an older seed-era row. */
  newVariants: number;
  rangesExtended: number;
  rangesInserted: number;
}

/**
 * Writes a plan in one transaction. Throws, having written nothing, on an
 * overlap. `dryRun` rolls back instead of committing, after every check and
 * count has run against the real data.
 */
export async function applyBackfill(
  db: BackfillDb,
  plan: BackfillPlan,
  log: (m: string) => void = () => {},
  options: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const rows = plan.variants.map((v) => v.row);
  await db.query("BEGIN");
  try {
    await db.query(SQL.LOCK);

    // Packages, versions and meta: the forward import's statements, over
    // the rows whose content becomes the variant row.
    await db.query(SQL.STAGE_KEYS_DDL);
    await db.stage(
      "stage_keys",
      SQL.STAGE_KEYS_COLUMNS,
      rows.map((r) => [r.name, packageKey(r.name), r.version, r.pkg.attrPath, r.metaHash, r.contentHash]),
    );
    await db.query(SQL.STAGE_KEYS_INDEX);

    await db.query(SQL.STAGE_BACKFILL_RANGES_DDL);
    await db.stage(
      "stage_backfill_ranges",
      SQL.STAGE_BACKFILL_RANGES_COLUMNS,
      plan.ranges.map((r) => [r.system, r.nameKey, r.version, r.attrPath, r.firstSeq, r.lastSeq, r.nextSeq]),
    );
    const overlaps = await db.query<Record<string, unknown>>(SQL.BACKFILL_OVERLAPS);
    if (overlaps.rows.length > 0) {
      throw new Error(
        `refusing backfill: it overlaps ranges the forward import already wrote, so --through-seq ` +
          `reaches into commits imported with these rows. e.g.\n` +
          overlaps.rows.map((r) => `  ${JSON.stringify(r)}`).join("\n"),
      );
    }

    const newPackages = (await db.query(SQL.INSERT_PACKAGES)).count;
    const missingVersions = await db.query<{ name_key: string; version: string }>(SQL.MISSING_VERSIONS);
    if (missingVersions.rows.length > 0) {
      await db.query(SQL.STAGE_VERSIONS_DDL);
      await db.stage(
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
          ];
        }),
      );
    }
    const newVersions = missingVersions.rows.length > 0 ? (await db.query(SQL.INSERT_VERSIONS)).count : 0;

    const missingMeta = new Set((await db.query<{ meta_hash: string }>(SQL.MISSING_META)).rows.map((r) => r.meta_hash));
    if (missingMeta.size > 0) {
      const blobs = new Map<string, CopyValue[]>();
      for (const r of rows) {
        if (!missingMeta.has(r.metaHash)) continue;
        const { summary, description, homepage, license, platforms } = r.pkg;
        blobs.set(r.metaHash, [r.metaHash, summary, description, homepage, license, platforms]);
      }
      await db.query(SQL.STAGE_META_DDL);
      await db.stage("stage_meta", SQL.STAGE_META_COLUMNS, [...blobs.values()]);
      await db.query(SQL.INSERT_META);
    }

    await db.query(SQL.STAGE_BACKFILL_VARIANTS_DDL);
    await db.stage(
      "stage_backfill_variants",
      SQL.STAGE_BACKFILL_VARIANTS_COLUMNS,
      plan.variants.map(({ system, commitSeq, row: r }) => [
        system,
        commitSeq,
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
      ]),
    );
    const newVariants = (await db.query(SQL.INSERT_BACKFILL_VARIANTS)).count;

    const rangesExtended = (await db.query(SQL.EXTEND_BACKFILL_RANGES)).count;
    const rangesInserted = (await db.query(SQL.INSERT_BACKFILL_RANGES)).count;

    await db.query(SQL.INSERT_SEARCH_TERMS);
    await db.query(REFRESH_ROW_COUNTS);
    await db.query(options.dryRun === true ? "ROLLBACK" : "COMMIT");

    const result = { newPackages, newVersions, newVariants, rangesExtended, rangesInserted };
    log(
      `backfill${options.dryRun === true ? " (dry run, rolled back)" : ""}: ${JSON.stringify(result)} ` +
        `from ${plan.variants.length} variants, ${plan.ranges.length} ranges`,
    );
    return result;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
