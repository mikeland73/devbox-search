/**
 * Records EXPLAIN (ANALYZE, BUFFERS) plans for the serving queries, as
 * markdown, so plan regressions are visible in review (docs/query-plans.md).
 *
 * The statements are the ones drizzle emits for apps/web/lib/search.ts
 * (captured from the PGlite harness's query log); keep them in sync when the
 * query layer changes. Parameters mirror the API: the ranked phrase query
 * runs for real first so the batched fetch is explained with the ids it
 * would actually receive.
 *
 * Usage:
 *   DATABASE_URL_UNPOOLED=... node tools/explain-plans.mjs > docs/query-plans.md
 *
 * Needs a direct (session) connection; the pooled endpoint works too, but
 * run it against the same branch the API serves so the numbers mean
 * something. Run each query twice and keep the second (warm) plan, which is
 * what a request against a live compute sees.
 */

import pg from "pg";

const PHRASES = ["go", "python", "python313Packages.", "hello", "-"];
const NAMES = ["go", "python", "python311", "hello"];

/** The tiered rank expression shared by both candidate tiers. */
const RANK = `max(
    CASE
      WHEN lower(search_terms.name) = lower($1) THEN 1000
      WHEN lower(search_terms.attr_path) = lower($1) THEN 900
      WHEN lower(search_terms.name) LIKE lower($2) || '%' ESCAPE '\\' THEN 800
      WHEN lower(search_terms.attr_path) LIKE lower($2) || '%' ESCAPE '\\' THEN 700
      ELSE 0
    END
    + 100 * CASE
        WHEN search_terms.name = search_terms.attr_path THEN similarity(search_terms.name, $1)
        ELSE greatest(similarity(search_terms.name, $1), similarity(search_terms.attr_path, $1))
      END
    + CASE WHEN search_terms.top_level_attr IS NOT NULL THEN 25 ELSE 0 END
  )`;

const PREFIX_MATCH = `(lower(search_terms.name) LIKE lower($2) || '%' ESCAPE '\\'
   OR lower(search_terms.attr_path) LIKE lower($2) || '%' ESCAPE '\\')`;

const tier = (rows) => `
  SELECT search_terms.package_id, search_terms.name, ${RANK} AS rank
  FROM ${rows}
  GROUP BY search_terms.package_id, search_terms.name
  ORDER BY rank DESC, search_terms.name
  LIMIT 50`;

/** KNN_MIN_PREFIX_ROWS in search.ts. */
const KNN_MIN_PREFIX_ROWS = 10000;

const CANDIDATE_COLUMNS = `search_terms.package_id, search_terms.name, search_terms.attr_path, search_terms.top_level_attr`;

/** One class's PHRASE_LIMIT nearest name-prefix matches, by trigram distance. */
const nearest = (topLevel) => `(
  SELECT ${CANDIDATE_COLUMNS}
  FROM search_terms
  WHERE (SELECT broad FROM breadth) AND (search_terms.name = search_terms.attr_path) IS TRUE AND ${topLevel}
    AND lower(search_terms.name) LIKE lower($2) || '%' ESCAPE '\\'
  ORDER BY lower(search_terms.name) <-> lower($1), search_terms.name
  LIMIT 50)`;

/**
 * The prefix tier's rows for a phrase with letters or digits: every prefix
 * match when the phrase is narrow, the nearest matches per class when it is
 * broad (see searchByPhrase).
 */
const PREFIX_ROWS = `(
  SELECT ${CANDIDATE_COLUMNS} FROM search_terms
  WHERE NOT (SELECT broad FROM breadth) AND ${PREFIX_MATCH}
  UNION ALL
  SELECT ${CANDIDATE_COLUMNS} FROM search_terms
  WHERE (SELECT broad FROM breadth)
    AND (lower(search_terms.name) = lower($1) OR lower(search_terms.attr_path) = lower($1))
  UNION ALL
  SELECT ${CANDIDATE_COLUMNS} FROM search_terms
  WHERE (SELECT broad FROM breadth) AND (search_terms.name = search_terms.attr_path) IS FALSE AND ${PREFIX_MATCH}
  UNION ALL ${nearest("search_terms.top_level_attr IS NOT NULL")}
  UNION ALL ${nearest("search_terms.top_level_attr IS NULL")}
) AS search_terms`;

const BREADTH = `breadth AS (
  SELECT count(*) >= ${KNN_MIN_PREFIX_ROWS} AS broad
  FROM (
    SELECT 1 FROM search_terms
    WHERE lower(search_terms.name) LIKE lower($2) || '%' ESCAPE '\\'
    LIMIT ${KNN_MIN_PREFIX_ROWS}
  ) AS probe
),`;

/**
 * searchByPhrase, ranking: the prefix tier, then — only if it is not already
 * full — the trigram-similarity tier. A phrase with no letters or digits
 * has no trigrams and always scores every prefix match.
 */
const ranked = (knn) => `
WITH ${knn ? BREADTH : ""}
prefix AS (${tier(knn ? PREFIX_ROWS : `search_terms WHERE ${PREFIX_MATCH}`)}),
fuzzy AS (${tier(`search_terms WHERE (SELECT count(*) FROM prefix) < 50
    AND (search_terms.name % $1 OR search_terms.attr_path % $1)
    AND NOT ${PREFIX_MATCH}`)})
SELECT package_id
FROM (
  SELECT package_id, max(rank) AS rank, min(name) AS name
  FROM (SELECT * FROM prefix UNION ALL SELECT * FROM fuzzy) AS tiers
  GROUP BY package_id
) AS ranked
ORDER BY rank DESC, name
LIMIT 50`;

const RESULT_COLUMNS = `"packages"."name", "versions"."version", commit_hash.hash, commit_hash.committed_at, "variants"."store_hash", "variants"."store_name", "versions"."version", "variants"."meta_name", "variants"."meta_version", "variants"."attr_path", "variants"."system", "variants"."program", "meta"."summary", "meta"."description", "meta"."homepage", "meta"."license", "variants"."broken", "variants"."insecure", "meta"."platforms", "variants"."outputs"`;

const RESULT_JOINS = `inner join "versions" on "versions"."id" = "variants"."version_id" inner join "packages" on "packages"."id" = "versions"."package_id" inner join "meta" on "meta"."id" = "variants"."meta_id" inner join commits AS commit_hash on commit_hash.seq = "variants"."commit_seq"`;

/** latestOrder: non-broken first, then newest live presence, then version. */
const LATEST_ORDER = `EXISTS (SELECT 1 FROM "variants" b WHERE b.version_id = "versions"."id" AND NOT b.broken) desc, (
    SELECT coalesce(max(coalesce(r.last_seq, 2147483647)), 0)
    FROM "variant_ranges" r
    WHERE r.variant_id = "variants"."id" AND NOT r.seeded
  ) desc, "versions"."sort_key" desc`;

/** searchByPhrase, latest: one query for every ranked hit, one row per package. */
const PHRASE_LATEST = `
select distinct on (hits.ord) ${RESULT_COLUMNS}
from unnest(string_to_array($1, ',')::int[]) WITH ORDINALITY AS hits(package_id, ord)
inner join LATERAL (
  SELECT "versions"."id" AS version_id
  FROM "variants"
  JOIN "versions" ON "versions"."id" = "variants"."version_id"
  WHERE "versions"."package_id" = hits.package_id AND "versions"."prerelease" = false
  ORDER BY ${LATEST_ORDER}
  LIMIT 1
) AS latest on true
inner join "variants" on "variants"."version_id" = latest.version_id
${RESULT_JOINS}
order by hits.ord, "variants"."system" asc, "variants"."attr_path" asc
limit 50`;

/** searchByPhrase, all versions: one row per package x version. */
const PHRASE_ALL = `
select distinct on (hits.ord, "versions"."sort_key", "versions"."version") ${RESULT_COLUMNS}
from unnest(string_to_array($1, ',')::int[]) WITH ORDINALITY AS hits(package_id, ord)
inner join "versions" on "versions"."package_id" = hits.package_id
inner join "variants" on "variants"."version_id" = "versions"."id"
inner join "packages" on "packages"."id" = "versions"."package_id"
inner join "meta" on "meta"."id" = "variants"."meta_id"
inner join commits AS commit_hash on commit_hash.seq = "variants"."commit_seq"
order by hits.ord, "versions"."sort_key" desc, "versions"."version" asc, "variants"."system" asc, "variants"."attr_path" asc
limit 1000`;

/** nameOrAttrPath: the semi-join every name lookup is scoped by. */
const TARGET = `"variants"."id" IN (
  SELECT va.id
  FROM "packages" p
  JOIN "versions" ve ON ve.package_id = p.id
  JOIN "variants" va ON va.version_id = ve.id
  WHERE lower(p.name) = lower($1)
  UNION
  SELECT va.id FROM "variants" va WHERE va.attr_path = $1
)`;

/** pickLatestVersionId, the first query of resolve@latest. */
const PICK_LATEST = `
select "versions"."id" from "variants"
inner join "versions" on "versions"."id" = "variants"."version_id"
inner join "packages" on "packages"."id" = "versions"."package_id"
where (${TARGET} and "versions"."prerelease" = false)
order by ${LATEST_ORDER} limit 1`;

/** searchByName: every version of a package (/v2/pkg, /v1/pkg). */
const BY_NAME = `
select ${RESULT_COLUMNS} from "variants" ${RESULT_JOINS}
where (${TARGET})
order by "versions"."sort_key" desc, "variants"."system" asc, "variants"."attr_path" asc
limit 1000`;

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("set DATABASE_URL_UNPOOLED (or DATABASE_URL)");
  process.exit(1);
}
const client = new pg.Client({ connectionString });
await client.connect();

const out = [];
const print = (s = "") => out.push(s);

async function explain(title, sql, params) {
  // Twice: the first run warms the buffer cache; the second is what a
  // request against a live compute sees.
  await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
  const plan = rows.map((r) => r["QUERY PLAN"]);
  const exec = plan.find((l) => l.startsWith("Execution Time"));
  print(`### ${title}`);
  print();
  print(`Parameters: \`${JSON.stringify(params)}\` — ${exec}`);
  print();
  print("```");
  for (const line of plan) print(line);
  print("```");
  print();
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => "\\" + m);

print("# Serving query plans");
print();
print(`Recorded ${new Date().toISOString().slice(0, 10)} against \`${new URL(connectionString).host}\` with \`node tools/explain-plans.mjs\`.`);
print("Regenerate after changing apps/web/lib/search.ts or the indexes, and diff.");
print("Warm plans (second run); see the script for what each statement is.");
print();

const { rows: counts } = await client.query(
  `select (select count(*) from packages) as packages, (select count(*) from versions) as versions,
          (select count(*) from variants) as variants, (select count(*) from search_terms) as search_terms`,
);
print(`Table sizes: ${Object.entries(counts[0]).map(([k, v]) => `${k}=${v}`).join(", ")}`);
print();
print("## What to look for");
print();
print("- **Name lookups** must be index walks: `packages_name_lower_idx` -> `versions` ->");
print("  `variants_identity_key`, unioned with `variants_attr_path_idx`. A `Hash Join` or");
print("  `Seq Scan on variants` here means the name/attr_path predicate has become an OR");
print("  across two tables again (#26: ~4 s per lookup).");
print("- **Batched fetch** must be one `Nested Loop` over `hits` with an index scan on");
print("  `versions (package_id, ...)` per hit — never one query per hit.");
print("- **Latest** (pick latest version, batched fetch latest) sorts one package's variant");
print("  rows with a `SubPlan` per row on `variant_ranges_pkey` (#44). A few hundred index");
print("  probes; a `Seq Scan on variant_ranges` would mean the presence subquery lost its");
print("  `variant_id =` correlation.");
print("- **Ranked terms** is two tiers. The `breadth` probe is an index scan of");
print("  `search_terms_name_lower_idx` stopped by its LIMIT, and it gates the `prefix` arms with");
print("  `One-Time Filter`s. For a narrow phrase (`go`, `hello`) only the first arm runs: a");
print("  `BitmapOr` of `search_terms_name_lower_idx` and `search_terms_attr_path_lower_idx`. For a");
print("  broad one (`python`) that arm shows `(never executed)`, the alias arm scans");
print("  `search_terms_alias_idx` (a few hundred rows), and the two nearest-match arms are");
print("  `Index Scan`s of `search_terms_top_level_name_knn_idx` / `search_terms_nested_name_knn_idx`");
print("  ordered by `<->` under an `Incremental Sort` and a `Limit` of 50. A seq scan or a");
print("  full-arm `Sort` of tens of thousands of rows here is the old cost coming back:");
print("  similarity() over every prefix match was ~0.4 s for `python`, 70k rows. Check");
print("  `python313Packages.` too: at 12k matches it is just over the probe's threshold, and a");
print("  `Bitmap Heap Scan` + `top-N heapsort` in its nested arm means the planner expects fewer");
print("  than 50 rows there — `search_terms_same_name_stats` is missing or was never analyzed");
print("  (`(name = attr_path) IS TRUE` should estimate ~99.8% of the table). `-` has no");
print("  trigrams and takes the scoring path with no probe. The `fuzzy` arm must sit under a");
print("  `One-Time Filter` and show `(never executed)` whenever the prefix tier is full (`go`,");
print("  `python`); it runs for `hello` and `-`. A `%` in the prefix arms, or a fuzzy arm that");
print("  ran for `python`, is a regression: `%` is cheap to index but every GIN candidate is");
print("  rechecked with similarity() — ~1.1 s of CPU for `python` when both tiers were one");
print("  OR'd WHERE.");
print();

print("## Phrase search (/v2/search, /v1/search)");
print();
for (const phrase of PHRASES) {
  const RANKED = ranked(/[\p{L}\p{N}]/u.test(phrase));
  await explain(`ranked terms — q=${phrase}`, RANKED, [phrase, escapeLike(phrase)]);
  const { rows: hits } = await client.query(RANKED, [phrase, escapeLike(phrase)]);
  const ids = hits.map((h) => h.package_id).join(",");
  await explain(`batched fetch, latest — q=${phrase} (${hits.length} hits)`, PHRASE_LATEST, [ids]);
  await explain(`batched fetch, all versions — q=${phrase} (${hits.length} hits)`, PHRASE_ALL, [ids]);
}

print("## Name lookups (/v2/resolve, /v1/resolve, /v2/pkg, /v1/pkg)");
print();
for (const name of NAMES) {
  await explain(`pick latest version — name=${name}`, PICK_LATEST, [name]);
}
for (const name of NAMES) {
  await explain(`every version — name=${name}`, BY_NAME, [name]);
}

await client.end();
console.log(out.join("\n"));
