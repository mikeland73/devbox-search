/**
 * Every SQL statement the incremental import runs, as shared constants.
 *
 * import.ts executes these against Postgres (staging via COPY); the PGlite
 * tests in import.live.test.ts execute the SAME strings (staging via INSERT,
 * because PGlite has no COPY FROM STDIN). Only the staging mechanism differs,
 * so a change to the merge logic can't drift away from what the tests cover.
 *
 * Parameter numbering is part of each constant's contract and is documented
 * with it.
 */

/** Advisory lock key shared with the seed. */
export const LOCK = "SELECT pg_advisory_xact_lock(hashtext('devbox-search-index'))";

// ---------------------------------------------------------------------------
// Idempotency + ordering guards
// ---------------------------------------------------------------------------

/** $1 commit hash, $2 system. Non-empty means this pair is already imported. */
export const EXISTING_IMPORT = `
  SELECT c.seq FROM commits c
  JOIN commit_systems cs ON cs.commit_seq = c.seq AND cs.system = $2
  WHERE c.hash = $1
`;

export const HEAD_COMMIT = `SELECT seq, committed_at FROM commits ORDER BY seq DESC LIMIT 1`;

/**
 * $1 text[] of expected systems. Commits already in the DB that are missing
 * at least one of them, oldest first — the backfill set for discover.
 */
export const INCOMPLETE_COMMITS = `
  SELECT c.hash, c.committed_at,
         array_agg(s) FILTER (WHERE cs.system IS NULL) AS missing
  FROM commits c
  CROSS JOIN unnest($1::text[]) AS s
  LEFT JOIN commit_systems cs ON cs.commit_seq = c.seq AND cs.system = s
  GROUP BY c.seq, c.hash, c.committed_at
  HAVING count(*) FILTER (WHERE cs.system IS NULL) > 0
  ORDER BY c.seq
`;

/** $1 commit hash. */
export const COMMIT_BY_HASH = `SELECT seq FROM commits WHERE hash = $1`;

/** $1 seq, $2 hash, $3 committed_at. */
export const INSERT_COMMIT = `INSERT INTO commits (seq, hash, committed_at) VALUES ($1, $2, $3)`;

/**
 * $1 system, $2 current commit seq. The previous imported seq FOR THIS SYSTEM,
 * which bounds any range we close: a variant that vanished was last seen then,
 * not at the current commit.
 */
export const PREV_SYSTEM_SEQ = `
  SELECT commit_seq AS seq FROM commit_systems
  WHERE system = $1 AND commit_seq < $2 ORDER BY commit_seq DESC LIMIT 1
`;

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export const STAGE_KEYS_DDL = `
  CREATE TEMP TABLE stage_keys (
    name text NOT NULL,
    name_key text NOT NULL,
    version text NOT NULL,
    attr_path text NOT NULL,
    meta_hash char(64) NOT NULL,
    content_hash char(64) NOT NULL
  ) ON COMMIT DROP
`;

export const STAGE_KEYS_COLUMNS = [
  "name",
  "name_key",
  "version",
  "attr_path",
  "meta_hash",
  "content_hash",
];

export const STAGE_KEYS_INDEX = `CREATE INDEX ON stage_keys (name_key, version)`;

export const STAGE_VERSIONS_DDL = `
  CREATE TEMP TABLE stage_versions (
    name_key text NOT NULL,
    version text NOT NULL,
    sort_key bytea NOT NULL,
    prerelease boolean NOT NULL,
    -- bigint like versions (migration 0001): nixpkgs has date-stamped
    -- components such as 0.1.20260720092025 that overflow int4.
    semver_major bigint,
    semver_minor bigint,
    semver_patch bigint,
    semver_pre text
  ) ON COMMIT DROP
`;

export const STAGE_VERSIONS_COLUMNS = [
  "name_key",
  "version",
  "sort_key",
  "prerelease",
  "semver_major",
  "semver_minor",
  "semver_patch",
  "semver_pre",
];

export const STAGE_META_DDL = `
  CREATE TEMP TABLE stage_meta (
    hash char(64) NOT NULL, summary text NOT NULL, description text NOT NULL,
    homepage text NOT NULL, license text NOT NULL, platforms jsonb NOT NULL
  ) ON COMMIT DROP
`;

export const STAGE_META_COLUMNS = [
  "hash",
  "summary",
  "description",
  "homepage",
  "license",
  "platforms",
];

export const STAGE_VARIANTS_DDL = `
  CREATE TEMP TABLE stage_variants (
    name_key text NOT NULL, version text NOT NULL, attr_path text NOT NULL,
    meta_hash char(64) NOT NULL, store_hash text NOT NULL, store_name text NOT NULL,
    meta_name text NOT NULL, meta_version jsonb NOT NULL, program text NOT NULL,
    broken boolean NOT NULL, insecure boolean NOT NULL, outputs jsonb NOT NULL,
    content_hash char(64) NOT NULL
  ) ON COMMIT DROP
`;

export const STAGE_VARIANTS_COLUMNS = [
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
];

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

export const INSERT_PACKAGES = `
  INSERT INTO packages (name)
  SELECT DISTINCT ON (s.name_key) s.name
  FROM stage_keys s
  WHERE NOT EXISTS (SELECT 1 FROM packages p WHERE lower(p.name) = s.name_key)
  ORDER BY s.name_key, s.name
  ON CONFLICT DO NOTHING
`;

/** The (name_key, version) pairs whose version row still has to be built. */
export const MISSING_VERSIONS = `
  SELECT DISTINCT s.name_key, s.version
  FROM stage_keys s
  JOIN packages p ON lower(p.name) = s.name_key
  WHERE NOT EXISTS (
    SELECT 1 FROM versions v WHERE v.package_id = p.id AND v.version = s.version
  )
`;

export const INSERT_VERSIONS = `
  INSERT INTO versions (package_id, version, sort_key, prerelease, semver_major, semver_minor, semver_patch, semver_pre)
  SELECT p.id, sv.version, sv.sort_key, sv.prerelease, sv.semver_major, sv.semver_minor, sv.semver_patch, sv.semver_pre
  FROM stage_versions sv
  JOIN packages p ON lower(p.name) = sv.name_key
  ON CONFLICT (package_id, version) DO NOTHING
`;

/** The meta hashes the server lacks; only those blobs get uploaded. */
export const MISSING_META = `
  SELECT DISTINCT s.meta_hash FROM stage_keys s
  WHERE NOT EXISTS (SELECT 1 FROM meta m WHERE m.hash = s.meta_hash)
`;

export const INSERT_META = `
  INSERT INTO meta (hash, summary, description, homepage, license, platforms)
  SELECT hash, summary, description, homepage, license, platforms FROM stage_meta
  ON CONFLICT (hash) DO NOTHING
`;

/** $1 system. The anti-join that finds new-or-changed variants. */
export const CHANGED_VARIANTS = `
  SELECT s.name_key, s.version, s.attr_path
  FROM stage_keys s
  JOIN packages p ON lower(p.name) = s.name_key
  JOIN versions v ON v.package_id = p.id AND v.version = s.version
  LEFT JOIN variants va
    ON va.version_id = v.id AND va.system = $1 AND va.attr_path = s.attr_path
  WHERE va.id IS NULL OR va.content_hash <> s.content_hash
`;

/**
 * $1 system, $2 commit seq. commit_seq is the commit of the last CONTENT
 * change, which is what the API reports as commit_hash/last_updated.
 */
export const UPSERT_VARIANTS = `
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
`;

/**
 * $1 system, $2 previous seq for this system. Closes ranges for variants of
 * this system that are absent from this eval, at the last seq where they were
 * actually observed.
 */
export const CLOSE_RANGES = `
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
`;

/**
 * $1 system, $2 commit seq. Opens a range for every present variant with no
 * open one: brand-new variants and variants that reappeared after closing.
 */
export const OPEN_RANGES = `
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
`;

export const INSERT_SEARCH_TERMS = `
  INSERT INTO search_terms (package_id, name, attr_path, top_level_attr)
  SELECT DISTINCT p.id, p.name, s.attr_path,
         CASE WHEN position('.' in s.attr_path) = 0 THEN s.attr_path END
  FROM stage_keys s
  JOIN packages p ON lower(p.name) = s.name_key
  ON CONFLICT (name, attr_path) DO NOTHING
`;

/** $1 commit seq, $2 system. */
export const INSERT_COMMIT_SYSTEM = `
  INSERT INTO commit_systems (commit_seq, system, nix_version) VALUES ($1, $2, $3)
  ON CONFLICT DO NOTHING
`;

// ---------------------------------------------------------------------------
// Backfill (backfill.ts): history for rows an older eval could not see
// ---------------------------------------------------------------------------

/** stage_variants plus the system and content-change seq of each row. */
export const STAGE_BACKFILL_VARIANTS_DDL = `
  CREATE TEMP TABLE stage_backfill_variants (
    system text NOT NULL, commit_seq integer NOT NULL,
    name_key text NOT NULL, version text NOT NULL, attr_path text NOT NULL,
    meta_hash char(64) NOT NULL, store_hash text NOT NULL, store_name text NOT NULL,
    meta_name text NOT NULL, meta_version jsonb NOT NULL, program text NOT NULL,
    broken boolean NOT NULL, insecure boolean NOT NULL, outputs jsonb NOT NULL,
    content_hash char(64) NOT NULL
  ) ON COMMIT DROP
`;

export const STAGE_BACKFILL_VARIANTS_COLUMNS = ["system", "commit_seq", ...STAGE_VARIANTS_COLUMNS];

/**
 * One row per presence interval. next_seq is the system's next imported seq
 * after last_seq (NULL at the head): a live range starting there is the
 * same presence continuing, so it is extended rather than duplicated.
 */
export const STAGE_BACKFILL_RANGES_DDL = `
  CREATE TEMP TABLE stage_backfill_ranges (
    system text NOT NULL, name_key text NOT NULL, version text NOT NULL, attr_path text NOT NULL,
    first_seq integer NOT NULL, last_seq integer NOT NULL, next_seq integer
  ) ON COMMIT DROP
`;

export const STAGE_BACKFILL_RANGES_COLUMNS = [
  "system",
  "name_key",
  "version",
  "attr_path",
  "first_seq",
  "last_seq",
  "next_seq",
];

/**
 * Per system, the first and last seq this backfill has an eval of. Within
 * it the evals are the truth, so an earlier backfill's ranges there give
 * way to this one's.
 */
export const STAGE_BACKFILL_WINDOWS_DDL = `
  CREATE TEMP TABLE stage_backfill_windows (
    system text PRIMARY KEY, first_seq integer NOT NULL, last_seq integer NOT NULL
  ) ON COMMIT DROP
`;

export const STAGE_BACKFILL_WINDOWS_COLUMNS = ["system", "first_seq", "last_seq"];

/** The staged ranges with their variant ids, once the variants exist. */
export const RESOLVE_BACKFILL_RANGES = `
  CREATE TEMP TABLE backfill_ranges ON COMMIT DROP AS
  SELECT va.id AS variant_id, s.system, s.first_seq, s.last_seq, s.next_seq
  FROM stage_backfill_ranges s
  JOIN packages p ON lower(p.name) = s.name_key
  JOIN versions v ON v.package_id = p.id AND v.version = s.version
  JOIN variants va ON va.version_id = v.id AND va.system = s.system AND va.attr_path = s.attr_path
`;

/**
 * An earlier backfill's part of a range (variant_ranges.backfill_last_seq)
 * that lies within this window, for a variant this one stages, and is not
 * exactly a range this one stages: what a partial run left (a run closed
 * early, or bridged over a failed eval). This run's evals replace it.
 * Identical reruns match exactly, so they replace nothing.
 */
const STALE_BACKFILL_PART = `
  r.backfill_last_seq IS NOT NULL AND NOT r.seeded
  AND r.variant_id IN (SELECT variant_id FROM backfill_ranges)
  AND EXISTS (
    SELECT 1 FROM stage_backfill_windows w
    WHERE w.system = va.system AND w.first_seq <= r.first_seq AND r.backfill_last_seq <= w.last_seq
  )
  AND NOT EXISTS (
    SELECT 1 FROM backfill_ranges s
    WHERE s.variant_id = r.variant_id AND s.first_seq = r.first_seq AND s.last_seq = r.backfill_last_seq
  )
`;

/** A stale range a backfill wrote whole goes. */
export const DELETE_STALE_BACKFILL_RANGES = `
  DELETE FROM variant_ranges r USING variants va
  WHERE va.id = r.variant_id AND r.last_seq = r.backfill_last_seq AND ${STALE_BACKFILL_PART}
`;

/**
 * A seed-era point range (seed.ts: seeded, at the variant's last content
 * change) inside a staged range: the real range covers it, and one starting
 * at the same seq would otherwise collide on (variant_id, first_seq), so
 * the insert would drop the real range or the extend would abort the run.
 */
export const DELETE_COVERED_SEEDED_RANGES = `
  DELETE FROM variant_ranges r
  WHERE r.seeded
    AND EXISTS (
      SELECT 1 FROM backfill_ranges s
      WHERE s.variant_id = r.variant_id AND s.first_seq <= r.first_seq AND r.first_seq <= s.last_seq
    )
`;

/**
 * A forward-import range a stale backfill extended goes back to where the
 * forward import started it: the system's next imported seq after the
 * backfilled part (extension only ever joins a run to the range starting
 * at its next_seq). EXTEND_BACKFILL_RANGES then joins it up again if this
 * run's evals say so.
 */
export const UNEXTEND_STALE_BACKFILL_RANGES = `
  UPDATE variant_ranges r SET
    first_seq = (
      SELECT min(cs.commit_seq) FROM commit_systems cs
      WHERE cs.system = va.system AND cs.commit_seq > r.backfill_last_seq
    ),
    backfill_last_seq = NULL
  FROM variants va
  WHERE va.id = r.variant_id AND (r.last_seq IS NULL OR r.last_seq > r.backfill_last_seq) AND ${STALE_BACKFILL_PART}
`;

/**
 * Ranges that overlap a staged one without being it. Non-empty means the
 * backfill reaches into commits the forward import already wrote these rows
 * for (through-seq too high), or into an earlier backfill's range that
 * runs past this window, so it is refused. Being it means this backfill
 * already wrote it: same start, and its backfilled part ends where the
 * staged range does.
 */
export const BACKFILL_OVERLAPS = `
  SELECT s.system, p.name, v.version, va.attr_path, s.first_seq, s.last_seq,
         r.first_seq AS live_first, r.last_seq AS live_last,
         CASE WHEN r.backfill_last_seq IS NULL THEN 'forward import' ELSE 'earlier backfill' END AS written_by
  FROM backfill_ranges s
  JOIN variant_ranges r ON r.variant_id = s.variant_id AND NOT r.seeded
  JOIN variants va ON va.id = s.variant_id
  JOIN versions v ON v.id = va.version_id
  JOIN packages p ON p.id = v.package_id
  WHERE NOT (r.first_seq = s.first_seq AND coalesce(r.backfill_last_seq = s.last_seq, false))
    AND r.first_seq <= s.last_seq
    AND coalesce(r.last_seq, 2147483647) >= s.first_seq
  ORDER BY s.system, p.name, va.attr_path
  LIMIT 5
`;

/**
 * A variant that already exists keeps its row unless the backfill saw it
 * later: the forward import's rows are always newer than the window, but a
 * seed-era row (the old service listed a few of these packages) can be
 * older, with a store path nixpkgs has since rebuilt.
 *
 * Unchanged content moves commit_seq back to the earliest seq the backfill
 * saw it at, which is where that content first appeared: a seed-era row is
 * dated at its last change, and an allowed partial run dates content from
 * the first eval it had. The content hash covers every other column, so
 * only commit_seq changes. Identical reruns match on both and write nothing.
 */
export const INSERT_BACKFILL_VARIANTS = `
  INSERT INTO variants (
    version_id, system, attr_path, meta_id, commit_seq, store_hash, store_name,
    meta_name, meta_version, program, broken, insecure, outputs, content_hash
  )
  SELECT v.id, sv.system, sv.attr_path, m.id, sv.commit_seq, sv.store_hash, sv.store_name,
         sv.meta_name, sv.meta_version, sv.program, sv.broken, sv.insecure,
         sv.outputs, sv.content_hash
  FROM stage_backfill_variants sv
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
  WHERE variants.commit_seq < EXCLUDED.commit_seq
     OR (variants.content_hash = EXCLUDED.content_hash AND EXCLUDED.commit_seq < variants.commit_seq)
`;

/**
 * Pulls back the start of a range that the staged one runs into: the
 * forward import's live range, or an earlier backfill's from a later
 * window. The backfilled part then runs through the staged range's end,
 * unless it already ran further.
 */
export const EXTEND_BACKFILL_RANGES = `
  UPDATE variant_ranges r SET
    first_seq = s.first_seq,
    backfill_last_seq = coalesce(r.backfill_last_seq, s.last_seq)
  FROM backfill_ranges s
  WHERE r.variant_id = s.variant_id AND NOT r.seeded AND r.first_seq = s.next_seq
`;

/**
 * Every other staged range, closed and marked as backfilled. What conflicts
 * here is a range this backfill already wrote (an identical rerun, or one
 * just extended to start there): the overlap check has refused anything
 * else, and seeded points in the way are gone.
 */
export const INSERT_BACKFILL_RANGES = `
  INSERT INTO variant_ranges (variant_id, first_seq, last_seq, seeded, backfill_last_seq)
  SELECT s.variant_id, s.first_seq, s.last_seq, false, s.last_seq
  FROM backfill_ranges s
  ON CONFLICT (variant_id, first_seq) DO NOTHING
`;

/**
 * The imported commits a backfill window covers, with the systems each was
 * imported for: what backfill-list hands the eval matrix, and what the
 * backfill expects an eval of. $1 since (date), $2 through seq, $3 systems.
 */
export const BACKFILL_COMMITS = `
  SELECT c.seq, c.hash, array_agg(cs.system ORDER BY cs.system) AS systems
  FROM commits c JOIN commit_systems cs ON cs.commit_seq = c.seq AND cs.system = ANY($3)
  WHERE c.committed_at >= $1 AND c.seq <= $2
  GROUP BY c.seq, c.hash ORDER BY c.seq
`;
