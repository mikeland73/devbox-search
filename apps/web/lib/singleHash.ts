/**
 * Single-hash resolution across systems (sanctioned API change #2).
 *
 * The old service resolved each system independently, so `python@3.11` could
 * come back with up to four different nixpkgs revs — one per system. Since
 * `variant_ranges` records the commit interval in which each variant was
 * present, we can instead pick the newest commit that contains the version on
 * EVERY requested system and emit that single rev everywhere. That is the
 * direct expression of the maximize-packages-per-hash goal.
 *
 * Fallback: seeded rows are point ranges (the compact DB has no history), so
 * when the intersection is empty we return the per-system commits unchanged —
 * which is exactly the old behavior. Post-migration data has real intervals,
 * so coverage improves over time.
 */

import { sql } from "drizzle-orm";
import { db, rowsOf, type ResultPackage } from "./search";

interface RangeRow {
  system: string;
  attr_path: string;
  first_seq: number;
  last_seq: number | null;
  seeded: boolean;
}

/**
 * Rewrites `commitHash`/`lastUpdated` so that every system shares the newest
 * commit that contains this version on all of them. Returns the input
 * unchanged when no such commit exists.
 */
export async function singleHashAcrossSystems(pkgs: ResultPackage[]): Promise<ResultPackage[]> {
  // Only the first attribute path per system is emitted, matching the
  // response builder.
  const bySystem = new Map<string, ResultPackage>();
  for (const pkg of pkgs) {
    if (!bySystem.has(pkg.system)) bySystem.set(pkg.system, pkg);
  }
  if (bySystem.size < 2) return pkgs;

  const version = pkgs[0]!.version;
  const name = pkgs[0]!.name;

  let ranges: RangeRow[];
  try {
    const result = await db().execute(sql`
      SELECT v.system, v.attr_path, r.first_seq, r.last_seq, r.seeded
      FROM variants v
      JOIN variant_ranges r ON r.variant_id = v.id
      JOIN versions ver ON ver.id = v.version_id
      JOIN packages p ON p.id = ver.package_id
      WHERE lower(p.name) = lower(${name}) AND ver.version = ${version}
    `);
    ranges = rowsOf<RangeRow>(result);
  } catch {
    // Never fail a resolve because the optimization couldn't run.
    return pkgs;
  }
  if (ranges.length === 0) return pkgs;

  // For each system, the set of commit seqs covering it, as intervals.
  const wanted = [...bySystem.keys()];
  const perSystem = new Map<string, Array<{ lo: number; hi: number }>>();
  for (const row of ranges) {
    if (!bySystem.has(row.system)) continue;
    const list = perSystem.get(row.system) ?? [];
    list.push({ lo: row.first_seq, hi: row.last_seq ?? Number.MAX_SAFE_INTEGER });
    perSystem.set(row.system, list);
  }
  if (wanted.some((s) => (perSystem.get(s) ?? []).length === 0)) return pkgs;

  // The newest seq present on every system: walk each system's intervals and
  // intersect. The interval count per variant is 1-3, so this stays tiny.
  const best = newestCommonSeq(wanted.map((s) => perSystem.get(s)!));
  if (best === null) return pkgs;

  // Resolve the seq back to a hash and date.
  let commit: { hash: string; committed_at: string | Date } | undefined;
  try {
    const result = await db().execute(
      sql`SELECT hash, committed_at FROM commits WHERE seq = ${best}`,
    );
    commit = rowsOf<{ hash: string; committed_at: string | Date }>(result)[0];
  } catch {
    return pkgs;
  }
  if (commit === undefined) return pkgs;

  const lastUpdated = commit.committed_at instanceof Date ? commit.committed_at : new Date(commit.committed_at);
  return pkgs.map((pkg) => ({ ...pkg, commitHash: commit.hash, lastUpdated }));
}

/**
 * The largest integer contained in at least one interval of every group, or
 * null when the intersection is empty (which is the seeded point-range case
 * whenever the per-system commits differ).
 */
export function newestCommonSeq(groups: Array<Array<{ lo: number; hi: number }>>): number | null {
  if (groups.length === 0) return null;
  // Candidate seqs are the interval upper bounds: the newest common seq is
  // always the smallest `hi` among some choice of intervals.
  const candidates = new Set<number>();
  for (const group of groups) for (const iv of group) candidates.add(iv.hi);

  let best: number | null = null;
  for (const candidate of candidates) {
    if (!groups.every((group) => group.some((iv) => iv.lo <= candidate && candidate <= iv.hi))) continue;
    if (best === null || candidate > best) best = candidate;
  }
  return best;
}
