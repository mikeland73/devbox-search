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
