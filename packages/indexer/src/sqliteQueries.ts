/**
 * The grouping queries run against the compact sqlite DB.
 *
 * They live here, as constants, for two reasons: seed.ts and
 * validateOrdering.ts must run the *same* name+version grouping (a drift
 * between them would make the validation report describe a different row set
 * than the one seeded), and — more importantly — the correctness of both
 * queries lives entirely in their collation clauses, which is only testable by
 * executing the SQL text itself (see sqliteQueries.test.ts).
 *
 * ## Collation, and why the two queries differ on purpose
 *
 * `pkg.name` is declared `COLLATE NOCASE`, so sqlite treats spellings that
 * differ only in case as ONE name (354 such groups exist, e.g. `_86Box` /
 * `_86box`). Bare `GROUP BY name` / `ORDER BY name` inherit that collation.
 *
 *   - PACKAGE_SPELLINGS_SQL overrides it with `COLLATE BINARY` *because* it
 *     wants the case variants split: it needs each distinct spelling with its
 *     row count so canonicalSpelling() can pick the dominant one. The caller
 *     re-merges them under packageKey() = lower(name).
 *
 *   - NAME_VERSION_SQL deliberately does NOT override it. Inheriting NOCASE
 *     merges `_86Box@4.2` and `_86box@4.2` into a single row, which is what
 *     keeps the seed from emitting two `versions` rows with the same
 *     (package_id, version) — those share a package id (identity is
 *     lower(name)) and would violate `versions_package_version_key` on the
 *     first COPY. The inherited NOCASE `ORDER BY name` also keeps case
 *     variants adjacent, which the seed's streaming per-package buffer
 *     depends on.
 *
 * So: adding `COLLATE BINARY` to NAME_VERSION_SQL "for consistency" with the
 * query above it turns the seed into a hard COPY failure. The regression test
 * asserts both halves of this.
 */

/**
 * One row per distinct *spelling* of a package name, with how many pkg rows
 * use it. Case variants are separate rows here by design; callers group them
 * with packageKey() and choose a display spelling with canonicalSpelling().
 */
export const PACKAGE_SPELLINGS_SQL = `SELECT name, count(*) AS n FROM pkg
   GROUP BY name COLLATE BINARY ORDER BY name COLLATE BINARY`;

/**
 * One row per (case-insensitive name, version), carrying sqlite's dense-int
 * version_sort and prerelease flag for the seed-time ordering diff. `max()`
 * collapses the per-system/per-attr_path rows of a version, and — for
 * case-variant spellings merged by the inherited NOCASE collation — any
 * disagreement between spellings.
 */
export const NAME_VERSION_SQL = `SELECT name, version, max(version_sort) AS version_sort, max(prerelease) AS prerelease
   FROM pkg GROUP BY name, version ORDER BY name, version`;
