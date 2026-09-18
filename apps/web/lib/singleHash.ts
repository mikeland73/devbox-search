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
 * Only live ranges count. Seeded rows are point ranges at a row's last
 * content change (the compact DB has no history), which says nothing about
 * presence, and a system that was never imported after the seed
 * (x86_64-darwin, frozen at the migration) would otherwise pin every other
 * system's rev to a commit from before the migration. So a system with no
 * live range keeps its own commit, and the unified rev is chosen among the
 * rest; when fewer than two systems remain, nothing changes — the old
 * per-system behavior.
 *
 * An open range means "present in every import of this system since
 * first_seq", so its upper bound is that system's newest imported commit
 * (commit_systems), not the newest commit overall: a system that lags behind
 * cannot claim presence at a commit it has never evaluated (#50).
 */

import { sql } from "drizzle-orm";
import { db, rowsOf, type ResultPackage } from "./search";

interface RangeRow {
  system: string;
  attr_path: string;
  first_seq: number;
  last_seq: number | null;
  /** The newest commit imported for this system: the bound of an open range. */
  head_seq: number;
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
      SELECT v.system, v.attr_path, r.first_seq, r.last_seq,
        (SELECT max(cs.commit_seq) FROM commit_systems cs WHERE cs.system = v.system) AS head_seq
      FROM variants v
      JOIN variant_ranges r ON r.variant_id = v.id
      JOIN versions ver ON ver.id = v.version_id
      JOIN packages p ON p.id = ver.package_id
      WHERE lower(p.name) = lower(${name}) AND ver.version = ${version} AND NOT r.seeded
    `);
    ranges = rowsOf<RangeRow>(result);
  } catch {
    // Never fail a resolve because the optimization couldn't run.
    return pkgs;
  }

  // For each emitted system, the commit seqs at which the attribute path the
  // response names carried this version, as intervals. Only that attribute
  // path counts: the rev is emitted next to it, so it must exist there.
  const perSystem = new Map<string, Array<{ lo: number; hi: number }>>();
  for (const row of ranges) {
    if (bySystem.get(row.system)?.attrPath !== row.attr_path) continue;
    const list = perSystem.get(row.system) ?? [];
    list.push({ lo: row.first_seq, hi: row.last_seq ?? row.head_seq });
    perSystem.set(row.system, list);
  }
  const unified = [...perSystem.keys()];
  if (unified.length < 2) return pkgs;

  // The newest seq present on every unified system: walk each system's
  // intervals and intersect. The interval count per variant is 1-3, so this
  // stays tiny.
  const best = newestCommonSeq(unified.map((s) => perSystem.get(s)!));
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
  return pkgs.map((pkg) =>
    perSystem.has(pkg.system) ? { ...pkg, commitHash: commit.hash, lastUpdated } : pkg,
  );
}

/**
 * The largest integer contained in at least one interval of every group, or
 * null when the intersection is empty (the version was never present on all
 * of them at the same commit).
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
