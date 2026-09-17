/**
 * Drizzle schema for the incremental-forever nixpkgs index.
 *
 * Design notes (see the migration plan §1):
 *
 *   - The store is never rebuilt. Every import appends a commit and merges
 *     only what changed, so all history lives in `variant_ranges`.
 *   - The old sqlite `pkg` table had grain name × version × system × attr_path
 *     with a fat `latest_json` blob (~1.1 kB/row × 3.8M rows). Here the
 *     ~900 B of per-row duplicated metadata is deduplicated into content-
 *     addressed `meta` rows, which is the bulk of the size win (5.6 GB → ~3-4.5 GB).
 *   - `versions.sort_key` is the self-contained byte-comparable key from
 *     @devbox-search/core, so `latest` is max(sort_key) with no re-sort step
 *     in the import pipeline (the old dense-int version_sort only existed
 *     because the Go comparator wasn't transitive).
 *   - Text search uses pg_trgm GIN indexes over a small `search_terms` table
 *     (~300-400k rows) instead of FTS5.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Postgres bytea mapped to Uint8Array. Drizzle has no built-in bytea type;
 * node-postgres already returns Buffer for bytea, and accepts Buffer on the
 * way in.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  // Buffer.from(arrayBuffer, byteOffset, length) deliberately *views* the same
  // memory rather than copying (unlike Buffer.from(typedArray)), and honours
  // the offset so subarray views serialize correctly. Callers must hand over a
  // buffer they don't mutate afterwards; sortKey()/contentHash() from
  // @devbox-search/core allocate fresh arrays, so that holds today. Do not
  // "simplify" this to Buffer.from(value) — that silently adds a copy per row
  // on a multi-million-row import.
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  },
  fromDriver(value: Buffer): Uint8Array {
    return Uint8Array.from(value);
  },
});

/**
 * The linear nixpkgs-unstable commit timeline. `seq` is a dense integer so
 * that presence intervals in variant_ranges are cheap int comparisons.
 * Seeded rows get seq 1..N ordered by committed_at.
 */
export const commits = pgTable(
  "commits",
  {
    seq: integer("seq").primaryKey(),
    hash: char("hash", { length: 40 }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("commits_hash_key").on(t.hash),
    index("commits_committed_at_idx").on(t.committedAt),
  ],
);

/**
 * Which (commit, system) evaluations were actually imported. This scopes
 * range-close logic per system and distinguishes "the package is absent from
 * this commit" from "we never evaluated this system at this commit" — which
 * matters because CI imports systems independently and may backfill later.
 *
 * nix_version is the `nix --version` that produced the eval archive, carried
 * over from the archive's R2 object metadata. The eval output shape is a
 * nix-env behaviour (which packages are listed, how stubs appear), so when
 * import counts shift this is the first thing to compare. Null for seeded
 * rows and archives written before the metadata existed.
 */
export const commitSystems = pgTable(
  "commit_systems",
  {
    commitSeq: integer("commit_seq")
      .notNull()
      .references(() => commits.seq, { onDelete: "cascade" }),
    system: text("system").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    nixVersion: text("nix_version"),
  },
  (t) => [primaryKey({ columns: [t.commitSeq, t.system] })],
);

/**
 * Canonical Devbox package names (devpkg.canonicalName of an attribute path).
 * Names are stored NFD-normalized. Name matching is case-insensitive in the
 * API (the old sqlite column was COLLATE NOCASE), which the lower(name) index
 * serves; attr_path matching stays case-sensitive.
 *
 * Uniqueness is intentionally exact-case, not on lower(name): nixpkgs attribute
 * paths are case-sensitive and do contain case-variant siblings, so a
 * case-insensitive constraint would collapse two genuinely distinct packages
 * (and fail the import when it did). The consequence is that a case-insensitive
 * lookup can match more than one row; resolution is a query-layer rule (prefer
 * the exact-case match, else the lowest id), not a storage-layer one.
 */
export const packages = pgTable(
  "packages",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
  },
  (t) => [
    uniqueIndex("packages_name_key").on(t.name),
    index("packages_name_lower_idx").on(sql`lower(${t.name})`),
  ],
);

/**
 * One row per package × version string.
 *
 * `sortKey` is the byte-comparable key from @devbox-search/core; ordering by
 * it reproduces compareVersions() exactly. `prerelease` is the faithful port
 * of the Go Prerelease() check and drives the `latest` prerelease fallback.
 *
 * semverMajor/Minor/Patch/Pre are NULL for versions that aren't strict semver
 * (e.g. "2024-01-05", "1.1.1w"); they exist to support npm-style range
 * constraints (sanctioned change #1). Unparseable versions fall back to
 * prefix-with-boundary matching.
 *
 * They are bigint, not integer: nixpkgs has ~100 strict-semver versions with a
 * date-stamped component ("3.1.20220119140128") that overflows int4. The
 * longest in the data is 14 digits, and parseSemver already rejects anything
 * past Number.MAX_SAFE_INTEGER, so int8 can never overflow.
 */
export const versions = pgTable(
  "versions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    packageId: integer("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    sortKey: bytea("sort_key").notNull(),
    prerelease: boolean("prerelease").notNull().default(false),
    semverMajor: bigint("semver_major", { mode: "number" }),
    semverMinor: bigint("semver_minor", { mode: "number" }),
    semverPatch: bigint("semver_patch", { mode: "number" }),
    semverPre: text("semver_pre"),
  },
  (t) => [
    uniqueIndex("versions_package_version_key").on(t.packageId, t.version),
    // Serves `latest` (max sort_key, optionally excluding prereleases) and
    // the ordered version listings used by /pkg.
    index("versions_latest_idx").on(t.packageId, t.prerelease, t.sortKey.desc()),
    // Serves npm-range constraint predicates.
    index("versions_semver_idx").on(t.packageId, t.semverMajor, t.semverMinor, t.semverPatch),
  ],
);

/**
 * Content-addressed dedup of the descriptive metadata that repeats across
 * every version × system × attr_path row (~900 B/row in the old schema).
 * `hash` is sha256 of the canonical JSON of exactly these fields (see
 * core's metaHash), so inserts are pure "insert if the hash is missing".
 */
export const meta = pgTable("meta", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  hash: char("hash", { length: 64 }).notNull().unique(),
  summary: text("summary").notNull().default(""),
  description: text("description").notNull().default(""),
  homepage: text("homepage").notNull().default(""),
  license: text("license").notNull().default(""),
  platforms: jsonb("platforms").$type<string[]>().notNull().default([]),
});

/**
 * The current content of one version × system × attr_path.
 *
 * `commitSeq` is the commit of the last *content* change, which is what the
 * API reports as commit_hash / last_updated — matching the old service, where
 * a package's revision only advanced when its content actually changed.
 *
 * `contentHash` (core's contentHash) makes import diffing a single anti-join:
 * rows whose hash is unchanged need no write at all.
 */
export const variants = pgTable(
  "variants",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    versionId: integer("version_id")
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    system: text("system").notNull(),
    attrPath: text("attr_path").notNull(),
    metaId: integer("meta_id")
      .notNull()
      .references(() => meta.id),
    commitSeq: integer("commit_seq")
      .notNull()
      .references(() => commits.seq),
    // Never empty: a variant with no store path is a nix-env stub (see
    // decodeEvalJson), not a package. The first live import wrote ~75k of
    // them per commit before the decoder skipped stubs; this makes the
    // database refuse them no matter which producer or decoder let one by.
    storeHash: text("store_hash").notNull(),
    storeName: text("store_name").notNull().default(""),
    metaName: text("meta_name").notNull().default(""),
    metaVersion: jsonb("meta_version").$type<string[]>().notNull().default([]),
    program: text("program").notNull().default(""),
    broken: boolean("broken").notNull().default(false),
    insecure: boolean("insecure").notNull().default(false),
    outputs: jsonb("outputs")
      .$type<Array<{ name: string; path: string; default: boolean }>>()
      .notNull()
      .default([]),
    contentHash: char("content_hash", { length: 64 }).notNull(),
  },
  (t) => [
    check("variants_store_hash_nonempty", sql`${t.storeHash} <> ''`),
    uniqueIndex("variants_identity_key").on(t.versionId, t.system, t.attrPath),
    // Attribute-path lookups: the API matches `name = ?1 OR attr_path = ?1`.
    index("variants_attr_path_idx").on(t.attrPath),
    // No standalone version_id index: variants_identity_key leads with
    // version_id, so it already serves version_id equality lookups and the
    // ON DELETE CASCADE from versions.
  ],
);

/**
 * Presence intervals over the commit timeline: variant V existed in every
 * evaluated commit with firstSeq <= seq <= lastSeq (lastSeq NULL = still
 * present as of the newest import).
 *
 * This is what makes "which commit hashes contain version X" and hash-overlap
 * maximization (sanctioned change #2) answerable, at ~1-3 skinny rows per
 * variant. Two int columns beat int4range because the open/extend/close merge
 * SQL is much simpler; ranges convert to multiranges at query time when
 * intersecting across constraints.
 *
 * `seeded` marks rows created by the one-time sqlite seed, which are point
 * ranges (firstSeq = lastSeq) because the compact DB carries no history.
 * Resolution falls back to per-system commits for seeded data.
 */
export const variantRanges = pgTable(
  "variant_ranges",
  {
    variantId: integer("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "cascade" }),
    firstSeq: integer("first_seq")
      .notNull()
      .references(() => commits.seq),
    lastSeq: integer("last_seq").references(() => commits.seq),
    seeded: boolean("seeded").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.variantId, t.firstSeq] }),
    // Range maintenance touches only open ranges each import, so keep a
    // partial index on them.
    index("variant_ranges_open_idx")
      .on(t.variantId)
      .where(sql`${t.lastSeq} IS NULL`),
    index("variant_ranges_span_idx").on(t.firstSeq, t.lastSeq),
  ],
);

/**
 * Distinct (name, attr_path, top_level_attr) triples backing text search,
 * replacing the FTS5 virtual table. `topLevelAttr` is the attr_path when it
 * has no dot, mirroring the old FTS column that was weighted 10x so that
 * "python" ranks python3 above emacs28Packages.python3.
 */
export const searchTerms = pgTable(
  "search_terms",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    packageId: integer("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    attrPath: text("attr_path").notNull(),
    topLevelAttr: text("top_level_attr"),
  },
  (t) => [
    uniqueIndex("search_terms_key").on(t.name, t.attrPath),
    index("search_terms_name_trgm_idx").using("gin", sql`${t.name} gin_trgm_ops`),
    index("search_terms_attr_path_trgm_idx").using("gin", sql`${t.attrPath} gin_trgm_ops`),
    index("search_terms_name_lower_idx").on(sql`lower(${t.name})`),
  ],
);

export type Commit = typeof commits.$inferSelect;
export type NewCommit = typeof commits.$inferInsert;
export type Package = typeof packages.$inferSelect;
export type Version = typeof versions.$inferSelect;
export type Meta = typeof meta.$inferSelect;
export type Variant = typeof variants.$inferSelect;
export type VariantRange = typeof variantRanges.$inferSelect;
export type SearchTerm = typeof searchTerms.$inferSelect;
