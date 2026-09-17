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

const PHRASES = ["go", "python", "hello"];
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

const tier = (where) => `
  SELECT search_terms.package_id, search_terms.name, ${RANK} AS rank
  FROM search_terms
  WHERE ${where}
  GROUP BY search_terms.package_id, search_terms.name
  ORDER BY rank DESC, search_terms.name
  LIMIT 50`;

/**
 * searchByPhrase, ranking: the prefix tier, then — only if it is not already
 * full — the trigram-similarity tier.
 */
const RANKED = `
WITH prefix AS (${tier(PREFIX_MATCH)}),
fuzzy AS (${tier(`(SELECT count(*) FROM prefix) < 50
    AND (search_terms.name % $1 OR search_terms.attr_path % $1)
    AND NOT ${PREFIX_MATCH}`)})
SELECT package_id
FROM (SELECT * FROM prefix UNION ALL SELECT * FROM fuzzy) AS tiers
ORDER BY rank DESC, name
LIMIT 50`;

const RESULT_COLUMNS = `"packages"."name", "versions"."version", commit_hash.hash, commit_hash.committed_at, "variants"."store_hash", "variants"."store_name", "versions"."version", "variants"."meta_name", "variants"."meta_version", "variants"."attr_path", "variants"."system", "variants"."program", "meta"."summary", "meta"."description", "meta"."homepage", "meta"."license", "variants"."broken", "variants"."insecure", "meta"."platforms", "variants"."outputs"`;

const RESULT_JOINS = `inner join "versions" on "versions"."id" = "variants"."version_id" inner join "packages" on "packages"."id" = "versions"."package_id" inner join "meta" on "meta"."id" = "variants"."meta_id" inner join commits AS commit_hash on commit_hash.seq = "variants"."commit_seq"`;

/** searchByPhrase, latest: one query for every ranked hit, one row per package. */
const PHRASE_LATEST = `
select distinct on (hits.ord) ${RESULT_COLUMNS}
from unnest(string_to_array($1, ',')::int[]) WITH ORDINALITY AS hits(package_id, ord)
inner join LATERAL (
  SELECT v.id AS version_id
  FROM "versions" v
  WHERE v.package_id = hits.package_id AND v.prerelease = false
  ORDER BY
    EXISTS (SELECT 1 FROM "variants" b WHERE b.version_id = v.id AND NOT b.broken) DESC,
    v.sort_key DESC
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

/** pickLatestVersionId (non-broken pass), the first query of resolve@latest. */
const PICK_LATEST = `
select "versions"."id" from "variants"
inner join "versions" on "versions"."id" = "variants"."version_id"
inner join "packages" on "packages"."id" = "versions"."package_id"
where (${TARGET} and "versions"."prerelease" = false and "variants"."broken" = false)
order by "versions"."sort_key" desc limit 1`;

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
print("- **Ranked terms** is two tiers. The `prefix` CTE's filter must be the two `LIKE`s");
print("  only — a `BitmapOr` of `search_terms_name_lower_idx` and `search_terms_attr_path_lower_idx`");
print("  for narrow phrases (`go`), a plain seq scan when a quarter of the table matches");
print("  (`python`, ~90 ms). The `fuzzy` arm must sit under a `One-Time Filter` and show");
print("  `(never executed)` whenever the prefix tier is full (`go`, `python`); it runs for");
print("  `hello`. A `%` in the prefix arm's filter, or a fuzzy arm that ran for `python`, is a");
print("  regression: `%` is cheap to index but every GIN candidate is rechecked with");
print("  similarity(), and `python` has 70k of them (every `pythonXYPackages.*` attribute is");
print("  a name-prefix match) — ~1.1 s of CPU when both tiers were one OR'd WHERE. What");
print("  remains for broad prefixes is similarity() over the prefix rows themselves (~0.4 s");
print("  for `python`); making that cheaper means changing how that tier is ranked, not the plan.");
print();

print("## Phrase search (/v2/search, /v1/search, /search)");
print();
for (const phrase of PHRASES) {
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
