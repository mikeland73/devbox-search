/**
 * Pure transforms for the one-time sqlite -> Postgres seed.
 *
 * Kept separate from seed.ts (which owns the sqlite cursor and the COPY
 * streams) so the row-shaping logic is testable without a database.
 *
 * The source is the public "compact" sqlite DB. Its `pkg` table has grain
 * name x version x system x attr_path, with all the package content in a
 * `latest_json` JSONB blob (read out as text via sqlite's json()).
 */

import {
  contentHash,
  isPrerelease,
  metaHash,
  parseSemver,
  sortKey,
  type Output,
} from "@devbox-search/core";

/** A row of the compact DB's `pkg` table, with latest_json already decoded. */
export interface SqlitePkgRow {
  name: string;
  version: string;
  versionSort: number;
  prerelease: number;
  system: string;
  attrPath: string;
  json: LatestJson;
}

/** The shape stored in pkg.latest_json (Go's nixpkgs.Package, omitempty). */
export interface LatestJson {
  commit_hash?: string;
  last_updated?: string;
  store_hash?: string;
  store_name?: string;
  store_version?: string;
  meta_name?: string;
  meta_version?: string[];
  attr_path?: string;
  system?: string;
  program?: string;
  summary?: string;
  description?: string;
  homepage?: string;
  license?: string;
  broken?: boolean;
  insecure?: boolean;
  platforms?: string[];
  outputs?: Array<{ name?: string; path?: string; default?: boolean; nar?: string }>;
}

export interface MetaRow {
  hash: string;
  summary: string;
  description: string;
  homepage: string;
  license: string;
  platforms: string[];
}

export interface VariantRow {
  versionKey: string;
  system: string;
  attrPath: string;
  metaHash: string;
  commitHash: string;
  storeHash: string;
  storeName: string;
  metaName: string;
  metaVersion: string[];
  program: string;
  broken: boolean;
  insecure: boolean;
  outputs: Output[];
  contentHash: string;
}

export interface VersionRow {
  name: string;
  version: string;
  sortKey: Uint8Array;
  prerelease: boolean;
  semverMajor: number | null;
  semverMinor: number | null;
  semverPatch: number | null;
  semverPre: string | null;
}

/**
 * Key identifying a version within the seed's in-memory maps. Uses the
 * case-insensitive package key (see packageKey) joined with a tab, which
 * cannot appear in a name or version (both are trimmed at ingest).
 */
export function versionKey(name: string, version: string): string {
  return packageKey(name) + "\t" + version;
}

/**
 * Package identity key.
 *
 * The compact DB's `pkg.name` column is COLLATE NOCASE, so sqlite treats
 * names differing only in case as ONE package - 354 such groups exist (e.g.
 * `_86Box` / `_86box`). Postgres text comparison is case-sensitive, so
 * package identity must be lower(name) to preserve that grouping. Otherwise
 * those packages split in two and the API's case-insensitive lookup
 * (`lower(name) = lower($1)`) matches multiple package rows and returns a
 * partial version list.
 */
export function packageKey(name: string): string {
  return name.toLowerCase();
}

/**
 * Chooses the canonical spelling among case-variant spellings of one package
 * name: the most frequent, with binary-smallest as a deterministic tie-break.
 *
 * The old service echoed whichever spelling won sqlite's NOCASE unique index
 * (effectively the first inserted), which cannot be reconstructed from the
 * compact DB. This picks the dominant spelling instead. The choice is only
 * visible in the `name` field of responses for those 354 packages, and the
 * shadow diff surfaces any that matter.
 */
export function canonicalSpelling(spellings: Array<{ name: string; count: number }>): string {
  let best = spellings[0]!;
  for (const s of spellings.slice(1)) {
    if (s.count > best.count || (s.count === best.count && s.name < best.name)) {
      best = s;
    }
  }
  return best.name;
}

/**
 * Reconstructs the core EvalPackage-shaped view of a compact-DB row so that
 * the seed hashes content with exactly the same canonical serializer the
 * incremental importer will use. If these disagreed, the first daily import
 * after the seed would rewrite every variant.
 *
 * Note `outputs[].nar` is dropped: it is a cache-status artifact the new
 * pipeline does not store, and including it would make seeded content hashes
 * unreproducible from eval JSON.
 */
export function toEvalShape(row: SqlitePkgRow) {
  const j = row.json;
  return {
    storeHash: j.store_hash ?? "",
    storeName: j.store_name ?? "",
    storeVersion: j.store_version ?? "",
    metaName: j.meta_name ?? "",
    metaVersion: j.meta_version ?? [],
    attrPath: row.attrPath,
    system: row.system,
    program: j.program ?? "",
    summary: j.summary ?? "",
    description: j.description ?? "",
    homepage: j.homepage ?? "",
    license: j.license ?? "",
    broken: j.broken ?? false,
    insecure: j.insecure ?? false,
    platforms: j.platforms ?? [],
    outputs: (j.outputs ?? []).map((o) => ({
      name: o.name ?? "",
      path: o.path ?? "",
      default: o.default ?? false,
    })),
  };
}

/** The deduplicated meta blob for a row, plus its content address. */
export function toMetaRow(row: SqlitePkgRow): MetaRow {
  const pkg = toEvalShape(row);
  return {
    hash: metaHash(pkg),
    summary: pkg.summary,
    description: pkg.description,
    homepage: pkg.homepage,
    license: pkg.license,
    platforms: pkg.platforms,
  };
}

/** The variant row for a compact-DB row. */
export function toVariantRow(row: SqlitePkgRow): VariantRow {
  const pkg = toEvalShape(row);
  return {
    versionKey: versionKey(row.name, row.version),
    system: row.system,
    attrPath: row.attrPath,
    metaHash: metaHash(pkg),
    commitHash: row.json.commit_hash ?? "",
    storeHash: pkg.storeHash,
    storeName: pkg.storeName,
    metaName: pkg.metaName,
    metaVersion: pkg.metaVersion,
    program: pkg.program,
    broken: pkg.broken,
    insecure: pkg.insecure,
    outputs: pkg.outputs,
    contentHash: contentHash(pkg),
  };
}

/**
 * The version row for a (name, version) pair.
 *
 * `prerelease` is recomputed with the ported Go Prerelease() rather than
 * copied from sqlite, so the column keeps its exact old meaning while being
 * reproducible by the importer. Divergences from the sqlite column are
 * reported by the seed (see compareVersionOrder) rather than silently
 * accepted.
 */
export function toVersionRow(name: string, version: string): VersionRow {
  const semver = parseSemver(version);
  return {
    name,
    version,
    sortKey: sortKey(version),
    prerelease: isPrerelease(version),
    semverMajor: semver?.major ?? null,
    semverMinor: semver?.minor ?? null,
    semverPatch: semver?.patch ?? null,
    semverPre: semver === null || semver.prerelease === "" ? null : semver.prerelease,
  };
}

/** The `top_level_attr` column: the attr path when it has no dot. */
export function topLevelAttr(attrPath: string): string | null {
  return attrPath.includes(".") ? null : attrPath;
}

/**
 * Compares the new sort-key ordering against sqlite's dense-int version_sort
 * for one package's versions, returning the pairs that changed relative
 * order.
 *
 * This is the seed-time validation required by the plan: sanctioned change #4
 * replaced a non-transitive comparator, so divergences are expected but every
 * one must be enumerated and eyeballed. It is a report, not a gate.
 */
export function compareVersionOrder(
  versions: Array<{ version: string; versionSort: number }>,
): Array<{ a: string; b: string; oldOrder: number; newOrder: number }> {
  const divergences: Array<{ a: string; b: string; oldOrder: number; newOrder: number }> = [];
  const byNew = [...versions].sort((x, y) => {
    const cmp = Buffer.compare(Buffer.from(sortKey(x.version)), Buffer.from(sortKey(y.version)));
    return cmp !== 0 ? cmp : x.version < y.version ? -1 : x.version > y.version ? 1 : 0;
  });
  for (let i = 0; i < byNew.length; i++) {
    for (let j = i + 1; j < byNew.length; j++) {
      const a = byNew[i]!;
      const b = byNew[j]!;
      // New order says a < b. Old order disagrees only if it says a > b;
      // ties in version_sort are not divergences (the old key was dense but
      // not necessarily unique across equal-comparing versions).
      if (a.versionSort > b.versionSort) {
        divergences.push({ a: a.version, b: b.version, oldOrder: 1, newOrder: -1 });
      }
    }
  }
  return divergences;
}
