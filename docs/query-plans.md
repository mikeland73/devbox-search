# Serving query plans

Recorded 2026-09-18 against `ep-purple-river-auzjl04j.c-10.us-east-1.aws.neon.tech` with `node tools/explain-plans.mjs`.
Regenerate after changing apps/web/lib/search.ts or the indexes, and diff.
Warm plans (second run); see the script for what each statement is.

Table sizes: packages=250731, versions=1468104, variants=3833368, search_terms=251319

## What to look for

- **Name lookups** must be index walks: `packages_name_lower_idx` -> `versions` ->
  `variants_identity_key`, unioned with `variants_attr_path_idx`. A `Hash Join` or
  `Seq Scan on variants` here means the name/attr_path predicate has become an OR
  across two tables again (#26: ~4 s per lookup).
- **Batched fetch** must be one `Nested Loop` over `hits` with an index scan on
  `versions (package_id, ...)` per hit — never one query per hit.
- **Latest** (pick latest version, batched fetch latest) sorts one package's variant
  rows with a `SubPlan` per row on `variant_ranges_pkey` (#44). A few hundred index
  probes; a `Seq Scan on variant_ranges` would mean the presence subquery lost its
  `variant_id =` correlation.
- **Ranked terms** is two tiers. The `prefix` CTE's filter must be the two `LIKE`s
  only — a `BitmapOr` of `search_terms_name_lower_idx` and `search_terms_attr_path_lower_idx`
  for narrow phrases (`go`), a plain seq scan when a quarter of the table matches
  (`python`, ~90 ms). The `fuzzy` arm must sit under a `One-Time Filter` and show
  `(never executed)` whenever the prefix tier is full (`go`, `python`); it runs for
  `hello`. A `%` in the prefix arm's filter, or a fuzzy arm that ran for `python`, is a
  regression: `%` is cheap to index but every GIN candidate is rechecked with
  similarity(), and `python` has 70k of them (every `pythonXYPackages.*` attribute is
  a name-prefix match) — ~1.1 s of CPU when both tiers were one OR'd WHERE. What
  remains for broad prefixes is similarity() over the prefix rows themselves (~0.4 s
  for `python`); making that cheaper means changing how that tier is ranked, not the plan.

## Phrase search (/v2/search, /v1/search, /search)

### ranked terms — q=go

Parameters: `["go","go"]` — Execution Time: 1.676 ms

```
Limit  (cost=3139.25..3139.38 rows=50 width=44) (actual time=1.265..1.274 rows=50 loops=1)
  Buffers: shared hit=21
  CTE prefix
    ->  Limit  (cost=2538.65..2538.77 rows=50 width=39) (actual time=1.171..1.179 rows=50 loops=1)
          Buffers: shared hit=21
          ->  Sort  (cost=2538.65..2541.85 rows=1279 width=39) (actual time=1.171..1.174 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_1.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms_1.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms_1.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms_1.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_1.name = search_terms_1.attr_path) THEN similarity(search_terms_1.name, 'go'::text) ELSE GREATEST(similarity(search_terms_1.name, 'go'::text), similarity(search_terms_1.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms_1.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_1.name
                Sort Method: top-N heapsort  Memory: 30kB
                Buffers: shared hit=21
                ->  HashAggregate  (cost=2483.37..2496.16 rows=1279 width=39) (actual time=1.021..1.083 rows=424 loops=1)
                      Group Key: search_terms_1.package_id, search_terms_1.name
                      Batches: 1  Memory Usage: 97kB
                      Buffers: shared hit=21
                      ->  Bitmap Heap Scan on search_terms search_terms_1  (cost=50.41..2416.22 rows=1279 width=68) (actual time=0.068..0.204 rows=439 loops=1)
                            Recheck Cond: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                            Filter: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                            Heap Blocks: exact=11
                            Buffers: shared hit=21
                            ->  BitmapOr  (cost=50.41..50.41 rows=1293 width=0) (actual time=0.057..0.057 rows=0 loops=1)
                                  Buffers: shared hit=10
                                  ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.81 rows=39 width=0) (actual time=0.033..0.033 rows=439 loops=1)
                                        Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                        Buffers: shared hit=5
                                  ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..44.96 rows=1254 width=0) (actual time=0.023..0.023 rows=439 loops=1)
                                        Index Cond: ((lower(attr_path) >= 'go'::text) AND (lower(attr_path) < 'gp'::text))
                                        Buffers: shared hit=5
  ->  Sort  (cost=600.48..600.73 rows=100 width=44) (actual time=1.264..1.268 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=21
        ->  GroupAggregate  (cost=595.16..597.16 rows=100 width=44) (actual time=1.222..1.243 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=21
              ->  Sort  (cost=595.16..595.41 rows=100 width=42) (actual time=1.218..1.222 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=21
                    ->  Append  (cost=0.00..591.83 rows=100 width=42) (actual time=1.174..1.210 rows=50 loops=1)
                          Buffers: shared hit=21
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=1.173..1.188 rows=50 loops=1)
                                Buffers: shared hit=21
                          ->  Subquery Scan on fuzzy  (cost=589.71..590.33 rows=50 width=39) (actual time=0.015..0.017 rows=0 loops=1)
                                ->  Limit  (cost=589.71..589.83 rows=50 width=39) (actual time=0.015..0.016 rows=0 loops=1)
                                      InitPlan 2
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.009..0.009 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.003 rows=50 loops=1)
                                      ->  Sort  (cost=588.57..588.70 rows=50 width=39) (actual time=0.015..0.015 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'go'::text) ELSE GREATEST(similarity(search_terms.name, 'go'::text), similarity(search_terms.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            ->  GroupAggregate  (cost=583.91..587.16 rows=50 width=39) (actual time=0.013..0.013 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  ->  Sort  (cost=583.91..584.04 rows=50 width=68) (actual time=0.012..0.013 rows=0 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        ->  Result  (cost=400.74..582.50 rows=50 width=68) (actual time=0.010..0.011 rows=0 loops=1)
                                                              One-Time Filter: ((InitPlan 2).col1 < 50)
                                                              ->  Bitmap Heap Scan on search_terms  (cost=400.74..582.50 rows=50 width=68) (never executed)
                                                                    Recheck Cond: ((name % 'go'::text) OR (attr_path % 'go'::text))
                                                                    Filter: ((lower(name) !~~ 'go%'::text) AND (lower(attr_path) !~~ 'go%'::text))
                                                                    ->  BitmapOr  (cost=400.74..400.74 rows=50 width=0) (never executed)
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..200.36 rows=25 width=0) (never executed)
                                                                                Index Cond: (name % 'go'::text)
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..200.36 rows=25 width=0) (never executed)
                                                                                Index Cond: (attr_path % 'go'::text)
Planning:
  Buffers: shared hit=6
Planning Time: 0.974 ms
Execution Time: 1.676 ms
```

### batched fetch, latest — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 13.311 ms

```
Limit  (cost=4107.60..104214.45 rows=50 width=1377) (actual time=4.836..13.187 rows=50 loops=1)
  Buffers: shared hit=22759
  ->  Unique  (cost=4107.60..104214.45 rows=50 width=1377) (actual time=4.835..13.181 rows=50 loops=1)
        Buffers: shared hit=22759
        ->  Incremental Sort  (cost=4107.60..104212.78 rows=667 width=1377) (actual time=4.834..13.141 rows=172 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 6  Sort Method: quicksort  Average Memory: 55kB  Peak Memory: 55kB
              Buffers: shared hit=22759
              ->  Nested Loop  (cost=2064.83..104190.98 rows=667 width=1377) (actual time=3.455..12.985 rows=175 loops=1)
                    Buffers: shared hit=22759
                    ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.009..0.016 rows=50 loops=1)
                    ->  Nested Loop  (cost=2064.83..2083.68 rows=13 width=1359) (actual time=0.249..0.259 rows=4 loops=50)
                          Buffers: shared hit=22759
                          ->  Nested Loop  (cost=2064.55..2079.81 rows=13 width=1314) (actual time=0.247..0.253 rows=4 loops=50)
                                Buffers: shared hit=22234
                                ->  Nested Loop  (cost=2064.12..2073.19 rows=13 width=331) (actual time=0.244..0.246 rows=4 loops=50)
                                      Join Filter: (variants.version_id = versions_1.id)
                                      Buffers: shared hit=21534
                                      ->  Nested Loop  (cost=2063.69..2071.75 rows=1 width=45) (actual time=0.242..0.242 rows=1 loops=50)
                                            Buffers: shared hit=21246
                                            ->  Nested Loop  (cost=2063.27..2071.30 rows=1 width=22) (actual time=0.239..0.239 rows=1 loops=50)
                                                  Buffers: shared hit=21046
                                                  ->  Limit  (cost=2062.85..2062.85 rows=1 width=24) (actual time=0.236..0.236 rows=1 loops=50)
                                                        Buffers: shared hit=20846
                                                        ->  Sort  (cost=2062.85..2063.06 rows=84 width=24) (actual time=0.236..0.236 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=20846
                                                              ->  Nested Loop  (cost=0.86..2062.43 rows=84 width=24) (actual time=0.012..0.225 rows=44 loops=50)
                                                                    Buffers: shared hit=20846
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.003..0.007 rows=12 loops=50)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Rows Removed by Filter: 0
                                                                          Buffers: shared hit=238
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..32.45 rows=13 width=8) (actual time=0.002..0.003 rows=4 loops=612)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=2691
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.001..0.001 rows=1 loops=2223)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=8892
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=2223)
                                                                            Buffers: shared hit=9025
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=2223)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=9025
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=50)
                                                        Index Cond: (id = versions_1.id)
                                                        Buffers: shared hit=200
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                                  Index Cond: (id = versions.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.002..0.003 rows=4 loops=50)
                                            Index Cond: (version_id = versions.id)
                                            Buffers: shared hit=288
                                ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=175)
                                      Index Cond: (id = variants.meta_id)
                                      Buffers: shared hit=700
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=175)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=525
Planning:
  Buffers: shared hit=115
Planning Time: 17.717 ms
Execution Time: 13.311 ms
```

### batched fetch, all versions — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 16.242 ms

```
Limit  (cost=116.02..1461.80 rows=1000 width=1392) (actual time=4.421..16.046 rows=632 loops=1)
  Buffers: shared hit=13112
  ->  Unique  (cost=116.02..5788.49 rows=4215 width=1392) (actual time=4.419..15.991 rows=632 loops=1)
        Buffers: shared hit=13112
        ->  Incremental Sort  (cost=116.02..5756.88 rows=4215 width=1392) (actual time=4.419..15.424 rows=2298 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 19  Sort Method: quicksort  Average Memory: 69kB  Peak Memory: 75kB
              Pre-sorted Groups: 28  Sort Method: quicksort  Average Memory: 558kB  Peak Memory: 558kB
              Buffers: shared hit=13112
              ->  Nested Loop  (cost=1.99..5568.36 rows=4215 width=1392) (actual time=0.885..11.817 rows=2298 loops=1)
                    Buffers: shared hit=13112
                    ->  Nested Loop  (cost=1.70..4907.06 rows=4215 width=1337) (actual time=0.047..6.653 rows=2298 loops=1)
                          Buffers: shared hit=12416
                          ->  Nested Loop  (cost=1.28..2759.90 rows=4215 width=354) (actual time=0.040..3.052 rows=2298 loops=1)
                                Buffers: shared hit=3224
                                ->  Nested Loop  (cost=0.85..506.12 rows=1600 width=64) (actual time=0.033..0.584 rows=632 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=438
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.021..0.140 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.016 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.35 rows=32 width=33) (actual time=0.003..0.006 rows=13 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=238
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.002..0.003 rows=4 loops=632)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=2786
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=2298)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=9192
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=2298)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 2066  Misses: 232  Evictions: 0  Overflows: 0  Memory Usage: 37kB
                          Buffers: shared hit=696
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=232)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=696
Planning:
  Buffers: shared hit=69
Planning Time: 10.370 ms
Execution Time: 16.242 ms
```

### ranked terms — q=python

Parameters: `["python","python"]` — Execution Time: 417.892 ms

```
Limit  (cost=21243.63..21243.75 rows=50 width=44) (actual time=416.783..416.926 rows=50 loops=1)
  Buffers: shared hit=2961, temp read=482 written=483
  CTE prefix
    ->  Limit  (cost=20542.93..20543.05 rows=50 width=39) (actual time=416.670..416.809 rows=50 loops=1)
          Buffers: shared hit=2961, temp read=482 written=483
          ->  Sort  (cost=20542.93..20722.10 rows=71670 width=39) (actual time=416.669..416.804 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_1.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms_1.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms_1.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms_1.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_1.name = search_terms_1.attr_path) THEN similarity(search_terms_1.name, 'python'::text) ELSE GREATEST(similarity(search_terms_1.name, 'python'::text), similarity(search_terms_1.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms_1.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_1.name
                Sort Method: top-N heapsort  Memory: 30kB
                Buffers: shared hit=2961, temp read=482 written=483
                ->  Finalize GroupAggregate  (cost=17022.94..18162.10 rows=71670 width=39) (actual time=378.350..407.024 rows=69881 loops=1)
                      Group Key: search_terms_1.package_id, search_terms_1.name
                      Buffers: shared hit=2961, temp read=482 written=483
                      ->  Sort  (cost=17022.94..17128.56 rows=42246 width=39) (actual time=378.341..385.048 rows=69881 loops=1)
                            Sort Key: search_terms_1.package_id, search_terms_1.name
                            Sort Method: external merge  Disk: 3856kB
                            Buffers: shared hit=2961, temp read=482 written=483
                            ->  Gather  (cost=9130.01..13777.07 rows=42246 width=39) (actual time=320.699..353.415 rows=69881 loops=1)
                                  Workers Planned: 1
                                  Workers Launched: 1
                                  Buffers: shared hit=2961
                                  ->  Partial HashAggregate  (cost=8130.01..8552.47 rows=42246 width=39) (actual time=316.259..325.541 rows=34940 loops=2)
                                        Group Key: search_terms_1.package_id, search_terms_1.name
                                        Batches: 1  Memory Usage: 5137kB
                                        Buffers: shared hit=2961
                                        Worker 0:  Batches: 1  Memory Usage: 5137kB
                                        ->  Parallel Seq Scan on search_terms search_terms_1  (cost=0.00..5912.09 rows=42246 width=68) (actual time=39.388..81.729 rows=35022 loops=2)
                                              Filter: ((lower(name) ~~ 'python%'::text) OR (lower(attr_path) ~~ 'python%'::text))
                                              Rows Removed by Filter: 90637
                                              Buffers: shared hit=2961
  ->  Sort  (cost=700.58..700.79 rows=86 width=44) (actual time=416.781..416.787 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=2961, temp read=482 written=483
        ->  GroupAggregate  (cost=696.09..697.81 rows=86 width=44) (actual time=416.745..416.767 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=2961, temp read=482 written=483
              ->  Sort  (cost=696.09..696.31 rows=86 width=42) (actual time=416.741..416.746 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=2961, temp read=482 written=483
                    ->  Append  (cost=0.00..693.33 rows=86 width=42) (actual time=416.675..416.731 rows=50 loops=1)
                          Buffers: shared hit=2961, temp read=482 written=483
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=416.674..416.689 rows=50 loops=1)
                                Buffers: shared hit=2961, temp read=482 written=483
                          ->  Subquery Scan on fuzzy  (cost=691.45..691.90 rows=36 width=39) (actual time=0.033..0.035 rows=0 loops=1)
                                ->  Limit  (cost=691.45..691.54 rows=36 width=39) (actual time=0.032..0.034 rows=0 loops=1)
                                      InitPlan 2
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.009..0.009 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.004 rows=50 loops=1)
                                      ->  Sort  (cost=690.32..690.41 rows=36 width=39) (actual time=0.032..0.033 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'python'::text) ELSE GREATEST(similarity(search_terms.name, 'python'::text), similarity(search_terms.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            ->  GroupAggregate  (cost=687.04..689.38 rows=36 width=39) (actual time=0.016..0.017 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  ->  Sort  (cost=687.04..687.13 rows=36 width=68) (actual time=0.015..0.016 rows=0 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        ->  Result  (cost=504.36..686.11 rows=36 width=68) (actual time=0.011..0.012 rows=0 loops=1)
                                                              One-Time Filter: ((InitPlan 2).col1 < 50)
                                                              ->  Bitmap Heap Scan on search_terms  (cost=504.36..686.11 rows=36 width=68) (never executed)
                                                                    Recheck Cond: ((name % 'python'::text) OR (attr_path % 'python'::text))
                                                                    Filter: ((lower(name) !~~ 'python%'::text) AND (lower(attr_path) !~~ 'python%'::text))
                                                                    ->  BitmapOr  (cost=504.35..504.35 rows=50 width=0) (never executed)
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..252.17 rows=25 width=0) (never executed)
                                                                                Index Cond: (name % 'python'::text)
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..252.17 rows=25 width=0) (never executed)
                                                                                Index Cond: (attr_path % 'python'::text)
Planning:
  Buffers: shared hit=6
Planning Time: 0.939 ms
Execution Time: 417.892 ms
```

### batched fetch, latest — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 12.210 ms

```
Limit  (cost=4107.60..104214.45 rows=50 width=1377) (actual time=7.944..12.093 rows=49 loops=1)
  Buffers: shared hit=17592
  ->  Unique  (cost=4107.60..104214.45 rows=50 width=1377) (actual time=7.943..12.087 rows=49 loops=1)
        Buffers: shared hit=17592
        ->  Incremental Sort  (cost=4107.60..104212.78 rows=667 width=1377) (actual time=7.942..12.052 rows=124 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 4  Sort Method: quicksort  Average Memory: 65kB  Peak Memory: 65kB
              Buffers: shared hit=17592
              ->  Nested Loop  (cost=2064.83..104190.98 rows=667 width=1377) (actual time=2.886..11.889 rows=124 loops=1)
                    Buffers: shared hit=17592
                    ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.012..0.068 rows=50 loops=1)
                    ->  Nested Loop  (cost=2064.83..2083.68 rows=13 width=1359) (actual time=0.222..0.236 rows=2 loops=50)
                          Buffers: shared hit=17592
                          ->  Nested Loop  (cost=2064.55..2079.81 rows=13 width=1314) (actual time=0.219..0.230 rows=2 loops=50)
                                Buffers: shared hit=17220
                                ->  Nested Loop  (cost=2064.12..2073.19 rows=13 width=331) (actual time=0.215..0.217 rows=2 loops=50)
                                      Join Filter: (variants.version_id = versions_1.id)
                                      Buffers: shared hit=16724
                                      ->  Nested Loop  (cost=2063.69..2071.75 rows=1 width=45) (actual time=0.212..0.212 rows=1 loops=50)
                                            Buffers: shared hit=16508
                                            ->  Nested Loop  (cost=2063.27..2071.30 rows=1 width=22) (actual time=0.208..0.208 rows=1 loops=50)
                                                  Buffers: shared hit=16312
                                                  ->  Limit  (cost=2062.85..2062.85 rows=1 width=24) (actual time=0.205..0.205 rows=1 loops=50)
                                                        Buffers: shared hit=16116
                                                        ->  Sort  (cost=2062.85..2063.06 rows=84 width=24) (actual time=0.204..0.204 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=16116
                                                              ->  Nested Loop  (cost=0.86..2062.43 rows=84 width=24) (actual time=0.017..0.194 rows=34 loops=50)
                                                                    Buffers: shared hit=16116
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.007..0.012 rows=10 loops=50)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Rows Removed by Filter: 2
                                                                          Buffers: shared hit=230
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..32.45 rows=13 width=8) (actual time=0.002..0.003 rows=3 loops=511)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=2134
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.002..0.002 rows=1 loops=1715)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=6860
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=1715)
                                                                            Buffers: shared hit=6892
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=1715)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=6892
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=49)
                                                        Index Cond: (id = versions_1.id)
                                                        Buffers: shared hit=196
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.004..0.004 rows=1 loops=49)
                                                  Index Cond: (id = versions.package_id)
                                                  Buffers: shared hit=196
                                      ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.001..0.002 rows=3 loops=49)
                                            Index Cond: (version_id = versions.id)
                                            Buffers: shared hit=216
                                ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.004..0.004 rows=1 loops=124)
                                      Index Cond: (id = variants.meta_id)
                                      Buffers: shared hit=496
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=124)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=372
Planning:
  Buffers: shared hit=115
Planning Time: 234.137 ms
Execution Time: 12.210 ms
```

### batched fetch, all versions — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 12.940 ms

```
Limit  (cost=116.02..1461.80 rows=1000 width=1392) (actual time=3.614..12.739 rows=634 loops=1)
  Buffers: shared hit=12207
  ->  Unique  (cost=116.02..5788.49 rows=4215 width=1392) (actual time=3.613..12.686 rows=634 loops=1)
        Buffers: shared hit=12207
        ->  Incremental Sort  (cost=116.02..5756.88 rows=4215 width=1392) (actual time=3.612..12.149 rows=2158 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 19  Sort Method: quicksort  Average Memory: 126kB  Peak Memory: 126kB
              Pre-sorted Groups: 13  Sort Method: quicksort  Average Memory: 873kB  Peak Memory: 873kB
              Buffers: shared hit=12207
              ->  Nested Loop  (cost=1.99..5568.36 rows=4215 width=1392) (actual time=0.067..8.799 rows=2158 loops=1)
                    Buffers: shared hit=12207
                    ->  Nested Loop  (cost=1.70..4907.06 rows=4215 width=1337) (actual time=0.056..7.420 rows=2158 loops=1)
                          Buffers: shared hit=11694
                          ->  Nested Loop  (cost=1.28..2759.90 rows=4215 width=354) (actual time=0.049..3.428 rows=2158 loops=1)
                                Buffers: shared hit=3062
                                ->  Nested Loop  (cost=0.85..506.12 rows=1600 width=64) (actual time=0.041..0.716 rows=634 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=418
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.027..0.212 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.011..0.019 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.35 rows=32 width=33) (actual time=0.004..0.007 rows=13 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=218
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.002..0.003 rows=3 loops=634)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=2644
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=2158)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=8632
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=2158)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 1987  Misses: 171  Evictions: 0  Overflows: 0  Memory Usage: 27kB
                          Buffers: shared hit=513
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=171)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=513
Planning:
  Buffers: shared hit=69
Planning Time: 11.609 ms
Execution Time: 12.940 ms
```

### ranked terms — q=hello

Parameters: `["hello","hello"]` — Execution Time: 87.979 ms

```
Limit  (cost=3180.11..3180.23 rows=50 width=44) (actual time=87.841..87.851 rows=14 loops=1)
  Buffers: shared hit=1178
  CTE prefix
    ->  Limit  (cost=2501.79..2501.91 rows=50 width=39) (actual time=0.060..0.064 rows=5 loops=1)
          Buffers: shared hit=7
          ->  Sort  (cost=2501.79..2504.99 rows=1279 width=39) (actual time=0.060..0.063 rows=5 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_1.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms_1.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms_1.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms_1.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_1.name = search_terms_1.attr_path) THEN similarity(search_terms_1.name, 'hello'::text) ELSE GREATEST(similarity(search_terms_1.name, 'hello'::text), similarity(search_terms_1.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms_1.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_1.name
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=7
                ->  HashAggregate  (cost=2446.51..2459.30 rows=1279 width=39) (actual time=0.051..0.058 rows=5 loops=1)
                      Group Key: search_terms_1.package_id, search_terms_1.name
                      Batches: 1  Memory Usage: 73kB
                      Buffers: shared hit=7
                      ->  Bitmap Heap Scan on search_terms search_terms_1  (cost=50.03..2379.36 rows=1279 width=68) (actual time=0.029..0.032 rows=5 loops=1)
                            Recheck Cond: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                            Filter: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                            Heap Blocks: exact=1
                            Buffers: shared hit=7
                            ->  BitmapOr  (cost=50.03..50.03 rows=1254 width=0) (actual time=0.020..0.021 rows=0 loops=1)
                                  Buffers: shared hit=6
                                  ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.013..0.013 rows=5 loops=1)
                                        Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                        Buffers: shared hit=3
                                  ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..44.96 rows=1254 width=0) (actual time=0.006..0.007 rows=5 loops=1)
                                        Index Cond: ((lower(attr_path) >= 'hello'::text) AND (lower(attr_path) < 'hellp'::text))
                                        Buffers: shared hit=3
  ->  Sort  (cost=678.19..678.44 rows=100 width=44) (actual time=87.840..87.845 rows=14 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=1178
        ->  GroupAggregate  (cost=672.87..674.87 rows=100 width=44) (actual time=87.827..87.837 rows=14 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=1178
              ->  Sort  (cost=672.87..673.12 rows=100 width=42) (actual time=87.824..87.829 rows=14 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=1178
                    ->  Append  (cost=0.00..669.55 rows=100 width=42) (actual time=0.062..87.822 rows=14 loops=1)
                          Buffers: shared hit=1178
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=0.062..0.064 rows=5 loops=1)
                                Buffers: shared hit=7
                          ->  Subquery Scan on fuzzy  (cost=667.42..668.05 rows=50 width=39) (actual time=87.749..87.755 rows=9 loops=1)
                                Buffers: shared hit=1171
                                ->  Limit  (cost=667.42..667.55 rows=50 width=39) (actual time=87.748..87.752 rows=9 loops=1)
                                      Buffers: shared hit=1171
                                      InitPlan 2
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.003..0.003 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.001 rows=5 loops=1)
                                      ->  Sort  (cost=666.29..666.41 rows=50 width=39) (actual time=87.747..87.750 rows=9 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'hello'::text) ELSE GREATEST(similarity(search_terms.name, 'hello'::text), similarity(search_terms.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            Buffers: shared hit=1171
                                            ->  GroupAggregate  (cost=661.63..664.88 rows=50 width=39) (actual time=87.723..87.743 rows=9 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Buffers: shared hit=1171
                                                  ->  Sort  (cost=661.63..661.75 rows=50 width=68) (actual time=87.708..87.711 rows=9 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        Buffers: shared hit=1171
                                                        ->  Result  (cost=478.46..660.22 rows=50 width=68) (actual time=40.392..87.700 rows=9 loops=1)
                                                              One-Time Filter: ((InitPlan 2).col1 < 50)
                                                              Buffers: shared hit=1171
                                                              ->  Bitmap Heap Scan on search_terms  (cost=478.46..660.22 rows=50 width=68) (actual time=40.387..87.691 rows=9 loops=1)
                                                                    Recheck Cond: ((name % 'hello'::text) OR (attr_path % 'hello'::text))
                                                                    Rows Removed by Index Recheck: 17519
                                                                    Filter: ((lower(name) !~~ 'hello%'::text) AND (lower(attr_path) !~~ 'hello%'::text))
                                                                    Rows Removed by Filter: 5
                                                                    Heap Blocks: exact=1033
                                                                    Buffers: shared hit=1171
                                                                    ->  BitmapOr  (cost=478.46..478.46 rows=50 width=0) (actual time=4.369..4.370 rows=0 loops=1)
                                                                          Buffers: shared hit=138
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..239.22 rows=25 width=0) (actual time=2.248..2.248 rows=17533 loops=1)
                                                                                Index Cond: (name % 'hello'::text)
                                                                                Buffers: shared hit=69
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..239.22 rows=25 width=0) (actual time=2.120..2.121 rows=17533 loops=1)
                                                                                Index Cond: (attr_path % 'hello'::text)
                                                                                Buffers: shared hit=69
Planning:
  Buffers: shared hit=6
Planning Time: 0.929 ms
Execution Time: 87.979 ms
```

### batched fetch, latest — q=hello (14 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,51341,242138,42681"]` — Execution Time: 2.103 ms

```
Limit  (cost=4001.41..29180.06 rows=14 width=1377) (actual time=1.656..1.992 rows=14 loops=1)
  Buffers: shared hit=2687
  ->  Unique  (cost=4001.41..29180.06 rows=14 width=1377) (actual time=1.654..1.989 rows=14 loops=1)
        Buffers: shared hit=2687
        ->  Incremental Sort  (cost=4001.41..29179.59 rows=187 width=1377) (actual time=1.653..1.973 rows=46 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 65kB  Peak Memory: 65kB
              Buffers: shared hit=2687
              ->  Nested Loop  (cost=2064.83..29173.48 rows=187 width=1377) (actual time=0.231..1.919 rows=46 loops=1)
                    Buffers: shared hit=2687
                    ->  Function Scan on unnest hits  (cost=0.00..0.14 rows=14 width=12) (actual time=0.007..0.009 rows=14 loops=1)
                    ->  Nested Loop  (cost=2064.83..2083.68 rows=13 width=1359) (actual time=0.125..0.135 rows=3 loops=14)
                          Buffers: shared hit=2687
                          ->  Nested Loop  (cost=2064.55..2079.81 rows=13 width=1314) (actual time=0.122..0.130 rows=3 loops=14)
                                Buffers: shared hit=2549
                                ->  Nested Loop  (cost=2064.12..2073.19 rows=13 width=331) (actual time=0.118..0.121 rows=3 loops=14)
                                      Join Filter: (variants.version_id = versions_1.id)
                                      Buffers: shared hit=2365
                                      ->  Nested Loop  (cost=2063.69..2071.75 rows=1 width=45) (actual time=0.116..0.117 rows=1 loops=14)
                                            Buffers: shared hit=2289
                                            ->  Nested Loop  (cost=2063.27..2071.30 rows=1 width=22) (actual time=0.113..0.113 rows=1 loops=14)
                                                  Buffers: shared hit=2233
                                                  ->  Limit  (cost=2062.85..2062.85 rows=1 width=24) (actual time=0.109..0.109 rows=1 loops=14)
                                                        Buffers: shared hit=2177
                                                        ->  Sort  (cost=2062.85..2063.06 rows=84 width=24) (actual time=0.109..0.109 rows=1 loops=14)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=2177
                                                              ->  Nested Loop  (cost=0.86..2062.43 rows=84 width=24) (actual time=0.015..0.103 rows=15 loops=14)
                                                                    Buffers: shared hit=2177
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.004..0.006 rows=5 loops=14)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Buffers: shared hit=56
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..32.45 rows=13 width=8) (actual time=0.002..0.003 rows=3 loops=75)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=359
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.002..0.002 rows=1 loops=216)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=864
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.003..0.003 rows=1 loops=216)
                                                                            Buffers: shared hit=898
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=216)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=898
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=14)
                                                        Index Cond: (id = versions_1.id)
                                                        Buffers: shared hit=56
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=14)
                                                  Index Cond: (id = versions.package_id)
                                                  Buffers: shared hit=56
                                      ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.001..0.003 rows=3 loops=14)
                                            Index Cond: (version_id = versions.id)
                                            Buffers: shared hit=76
                                ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=46)
                                      Index Cond: (id = variants.meta_id)
                                      Buffers: shared hit=184
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=46)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=138
Planning:
  Buffers: shared hit=115
Planning Time: 20.167 ms
Execution Time: 2.103 ms
```

### batched fetch, all versions — q=hello (14 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,51341,242138,42681"]` — Execution Time: 1.920 ms

```
Limit  (cost=127.83..1534.52 rows=1000 width=1392) (actual time=0.336..1.832 rows=75 loops=1)
  Buffers: shared hit=1983
  ->  Unique  (cost=127.83..1787.72 rows=1180 width=1392) (actual time=0.335..1.824 rows=75 loops=1)
        Buffers: shared hit=1983
        ->  Incremental Sort  (cost=127.83..1778.87 rows=1180 width=1392) (actual time=0.334..1.765 rows=216 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 5  Sort Method: quicksort  Average Memory: 88kB  Peak Memory: 88kB
              Pre-sorted Groups: 3  Sort Method: quicksort  Average Memory: 50kB  Peak Memory: 54kB
              Buffers: shared hit=1983
              ->  Nested Loop  (cost=1.98..1726.10 rows=1180 width=1392) (actual time=0.060..1.316 rows=216 loops=1)
                    Buffers: shared hit=1983
                    ->  Nested Loop  (cost=1.70..1375.00 rows=1180 width=1337) (actual time=0.055..0.858 rows=216 loops=1)
                          Buffers: shared hit=1335
                          ->  Nested Loop  (cost=1.28..773.89 rows=1180 width=354) (actual time=0.047..0.472 rows=216 loops=1)
                                Buffers: shared hit=471
                                ->  Nested Loop  (cost=0.85..142.84 rows=448 width=64) (actual time=0.035..0.143 rows=75 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=112
                                      ->  Nested Loop  (cost=0.42..118.27 rows=14 width=43) (actual time=0.025..0.062 rows=14 loops=1)
                                            Buffers: shared hit=56
                                            ->  Function Scan on unnest hits  (cost=0.00..0.14 rows=14 width=12) (actual time=0.007..0.009 rows=14 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=14)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=56
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.35 rows=32 width=33) (actual time=0.003..0.004 rows=5 loops=14)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=56
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.002..0.003 rows=3 loops=75)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=359
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=216)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=864
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=216)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=648
Planning:
  Buffers: shared hit=69
Planning Time: 10.943 ms
Execution Time: 1.920 ms
```

## Name lookups (/v2/resolve, /v1/resolve, /v2/pkg, /v1/pkg)

### pick latest version — name=go

Parameters: `["go"]` — Execution Time: 8.341 ms

```
Limit  (cost=2720.13..2720.13 rows=1 width=24) (actual time=8.213..8.218 rows=1 loops=1)
  Buffers: shared hit=15087
  ->  Sort  (cost=2720.13..2720.44 rows=123 width=24) (actual time=8.212..8.216 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=15087
        ->  Nested Loop  (cost=163.07..2719.51 rows=123 width=24) (actual time=1.207..8.092 rows=644 loops=1)
              Buffers: shared hit=15087
              ->  Nested Loop  (cost=162.65..1268.38 rows=123 width=27) (actual time=1.186..3.907 rows=644 loops=1)
                    Buffers: shared hit=6708
                    ->  Nested Loop  (cost=162.22..1210.52 rows=124 width=8) (actual time=1.180..2.648 rows=719 loops=1)
                          Buffers: shared hit=3832
                          ->  HashAggregate  (cost=161.79..163.03 rows=124 width=4) (actual time=1.174..1.289 rows=719 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=956
                                ->  Append  (cost=1.28..161.48 rows=124 width=4) (actual time=0.032..0.979 rows=976 loops=1)
                                      Buffers: shared hit=956
                                      ->  Nested Loop  (cost=1.28..83.39 rows=16 width=4) (actual time=0.031..0.812 rows=719 loops=1)
                                            Buffers: shared hit=895
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.025..0.100 rows=191 loops=1)
                                                  Buffers: shared hit=23
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.014 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'go'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.009..0.059 rows=191 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=19
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.002..0.003 rows=4 loops=191)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=872
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..77.47 rows=108 width=4) (actual time=0.008..0.078 rows=257 loops=1)
                                            Index Cond: (attr_path = 'go'::text)
                                            Buffers: shared hit=61
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=719)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=2876
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=719)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=2876
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=644)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 644
                    Buffers: shared hit=3221
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.002..0.002 rows=1 loops=644)
                      Index Cond: (version_id = versions.id)
                      Filter: (NOT broken)
                      Buffers: shared hit=2576
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=644)
                      Buffers: shared hit=2582
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=644)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=2582
Planning:
  Buffers: shared hit=94
Planning Time: 14.456 ms
Execution Time: 8.341 ms
```

### pick latest version — name=python

Parameters: `["python"]` — Execution Time: 8.659 ms

```
Limit  (cost=2720.13..2720.13 rows=1 width=24) (actual time=8.537..8.541 rows=1 loops=1)
  Buffers: shared hit=11224
  ->  Sort  (cost=2720.13..2720.44 rows=123 width=24) (actual time=8.535..8.539 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=11224
        ->  Nested Loop  (cost=163.07..2719.51 rows=123 width=24) (actual time=0.819..8.451 rows=409 loops=1)
              Buffers: shared hit=11224
              ->  Nested Loop  (cost=162.65..1268.38 rows=123 width=27) (actual time=0.798..5.809 rows=409 loops=1)
                    Buffers: shared hit=5897
                    ->  Nested Loop  (cost=162.22..1210.52 rows=124 width=8) (actual time=0.792..2.127 rows=642 loops=1)
                          Buffers: shared hit=3329
                          ->  HashAggregate  (cost=161.79..163.03 rows=124 width=4) (actual time=0.786..0.901 rows=642 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=761
                                ->  Append  (cost=1.28..161.48 rows=124 width=4) (actual time=0.031..0.661 rows=645 loops=1)
                                      Buffers: shared hit=761
                                      ->  Nested Loop  (cost=1.28..83.39 rows=16 width=4) (actual time=0.031..0.599 rows=642 loops=1)
                                            Buffers: shared hit=756
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.025..0.092 rows=176 loops=1)
                                                  Buffers: shared hit=22
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.014..0.014 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'python'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.008..0.054 rows=176 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=18
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.002..0.002 rows=4 loops=176)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=734
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..77.47 rows=108 width=4) (actual time=0.008..0.009 rows=3 loops=1)
                                            Index Cond: (attr_path = 'python'::text)
                                            Buffers: shared hit=5
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=642)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=2568
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.005..0.005 rows=1 loops=642)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=2568
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=409)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 409
                    Buffers: shared hit=2046
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.002..0.002 rows=1 loops=409)
                      Index Cond: (version_id = versions.id)
                      Filter: (NOT broken)
                      Buffers: shared hit=1636
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=409)
                      Buffers: shared hit=1645
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=409)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=1645
Planning:
  Buffers: shared hit=94
Planning Time: 16.449 ms
Execution Time: 8.659 ms
```

### pick latest version — name=python311

Parameters: `["python311"]` — Execution Time: 0.841 ms

```
Limit  (cost=2720.13..2720.13 rows=1 width=24) (actual time=0.765..0.767 rows=1 loops=1)
  Buffers: shared hit=1378
  ->  Sort  (cost=2720.13..2720.44 rows=123 width=24) (actual time=0.764..0.765 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=1378
        ->  Nested Loop  (cost=163.07..2719.51 rows=123 width=24) (actual time=0.115..0.748 rows=51 loops=1)
              Buffers: shared hit=1378
              ->  Nested Loop  (cost=162.65..1268.38 rows=123 width=27) (actual time=0.092..0.389 rows=51 loops=1)
                    Buffers: shared hit=711
                    ->  Nested Loop  (cost=162.22..1210.52 rows=124 width=8) (actual time=0.085..0.241 rows=87 loops=1)
                          Buffers: shared hit=363
                          ->  HashAggregate  (cost=161.79..163.03 rows=124 width=4) (actual time=0.077..0.089 rows=87 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=15
                                ->  Append  (cost=1.28..161.48 rows=124 width=4) (actual time=0.022..0.061 rows=87 loops=1)
                                      Buffers: shared hit=15
                                      ->  Nested Loop  (cost=1.28..83.39 rows=16 width=4) (actual time=0.012..0.012 rows=0 loops=1)
                                            Buffers: shared hit=3
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.012..0.012 rows=0 loops=1)
                                                  Buffers: shared hit=3
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.011..0.011 rows=0 loops=1)
                                                        Index Cond: (lower(name) = 'python311'::text)
                                                        Buffers: shared hit=3
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (never executed)
                                                        Index Cond: (package_id = p.id)
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (never executed)
                                                  Index Cond: (version_id = ve.id)
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..77.47 rows=108 width=4) (actual time=0.010..0.040 rows=87 loops=1)
                                            Index Cond: (attr_path = 'python311'::text)
                                            Buffers: shared hit=12
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.001..0.001 rows=1 loops=87)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=348
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=87)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=348
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=51)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 51
                    Buffers: shared hit=256
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.002..0.002 rows=1 loops=51)
                      Index Cond: (version_id = versions.id)
                      Filter: (NOT broken)
                      Buffers: shared hit=204
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=51)
                      Buffers: shared hit=207
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=51)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=207
Planning:
  Buffers: shared hit=94
Planning Time: 16.016 ms
Execution Time: 0.841 ms
```

### pick latest version — name=hello

Parameters: `["hello"]` — Execution Time: 0.387 ms

```
Limit  (cost=2720.13..2720.13 rows=1 width=24) (actual time=0.305..0.307 rows=1 loops=1)
  Buffers: shared hit=443
  ->  Sort  (cost=2720.13..2720.44 rows=123 width=24) (actual time=0.304..0.306 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=443
        ->  Nested Loop  (cost=163.07..2719.51 rows=123 width=24) (actual time=0.111..0.294 rows=19 loops=1)
              Buffers: shared hit=443
              ->  Nested Loop  (cost=162.65..1268.38 rows=123 width=27) (actual time=0.089..0.156 rows=19 loops=1)
                    Buffers: shared hit=192
                    ->  Nested Loop  (cost=162.22..1210.52 rows=124 width=8) (actual time=0.083..0.119 rows=19 loops=1)
                          Buffers: shared hit=116
                          ->  HashAggregate  (cost=161.79..163.03 rows=124 width=4) (actual time=0.077..0.082 rows=19 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=40
                                ->  Append  (cost=1.28..161.48 rows=124 width=4) (actual time=0.030..0.066 rows=38 loops=1)
                                      Buffers: shared hit=40
                                      ->  Nested Loop  (cost=1.28..83.39 rows=16 width=4) (actual time=0.029..0.051 rows=19 loops=1)
                                            Buffers: shared hit=33
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.023..0.025 rows=5 loops=1)
                                                  Buffers: shared hit=8
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.014 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'hello'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.007..0.009 rows=5 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=4
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.003..0.004 rows=4 loops=5)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=25
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..77.47 rows=108 width=4) (actual time=0.007..0.012 rows=19 loops=1)
                                            Index Cond: (attr_path = 'hello'::text)
                                            Buffers: shared hit=7
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=19)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=76
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.002..0.002 rows=1 loops=19)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Buffers: shared hit=76
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=19)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 19
                    Buffers: shared hit=96
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.002..0.002 rows=1 loops=19)
                      Index Cond: (version_id = versions.id)
                      Filter: (NOT broken)
                      Buffers: shared hit=76
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=19)
                      Buffers: shared hit=79
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=19)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=79
Planning:
  Buffers: shared hit=94
Planning Time: 15.078 ms
Execution Time: 0.387 ms
```

### every version — name=go

Parameters: `["go"]` — Execution Time: 8.130 ms

```
Limit  (cost=1427.89..1428.20 rows=124 width=1384) (actual time=7.787..7.888 rows=719 loops=1)
  Buffers: shared hit=14617
  ->  Sort  (cost=1427.89..1428.20 rows=124 width=1384) (actual time=7.785..7.833 rows=719 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 737kB
        Buffers: shared hit=14617
        ->  Nested Loop  (cost=163.77..1423.58 rows=124 width=1384) (actual time=1.074..7.030 rows=719 loops=1)
              Buffers: shared hit=14617
              ->  Nested Loop  (cost=163.49..1386.69 rows=124 width=1329) (actual time=1.069..5.929 rows=719 loops=1)
                    Buffers: shared hit=12460
                    ->  Nested Loop  (cost=163.07..1323.52 rows=124 width=346) (actual time=1.062..4.779 rows=719 loops=1)
                          Buffers: shared hit=9584
                          ->  Nested Loop  (cost=162.65..1268.38 rows=124 width=323) (actual time=1.057..3.691 rows=719 loops=1)
                                Buffers: shared hit=6708
                                ->  Nested Loop  (cost=162.22..1210.52 rows=124 width=298) (actual time=1.052..2.522 rows=719 loops=1)
                                      Buffers: shared hit=3832
                                      ->  HashAggregate  (cost=161.79..163.03 rows=124 width=4) (actual time=1.046..1.156 rows=719 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=956
                                            ->  Append  (cost=1.28..161.48 rows=124 width=4) (actual time=0.034..0.875 rows=976 loops=1)
                                                  Buffers: shared hit=956
                                                  ->  Nested Loop  (cost=1.28..83.39 rows=16 width=4) (actual time=0.033..0.718 rows=719 loops=1)
                                                        Buffers: shared hit=895
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.026..0.097 rows=191 loops=1)
                                                              Buffers: shared hit=23
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.014..0.015 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'go'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.009..0.056 rows=191 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=19
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.002..0.003 rows=4 loops=191)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=872
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..77.47 rows=108 width=4) (actual time=0.009..0.080 rows=257 loops=1)
                                                        Index Cond: (attr_path = 'go'::text)
                                                        Buffers: shared hit=61
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.001..0.001 rows=1 loops=719)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=2876
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=719)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=2876
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=719)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=2876
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=719)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=2876
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=719)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=2157
Planning:
  Buffers: shared hit=116
Planning Time: 25.433 ms
Execution Time: 8.130 ms
```

### every version — name=python

Parameters: `["python"]` — Execution Time: 7.229 ms

```
Limit  (cost=1427.89..1428.20 rows=124 width=1384) (actual time=6.898..6.989 rows=642 loops=1)
  Buffers: shared hit=12959
  ->  Sort  (cost=1427.89..1428.20 rows=124 width=1384) (actual time=6.896..6.940 rows=642 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 1282kB
        Buffers: shared hit=12959
        ->  Nested Loop  (cost=163.77..1423.58 rows=124 width=1384) (actual time=0.830..6.210 rows=642 loops=1)
              Buffers: shared hit=12959
              ->  Nested Loop  (cost=163.49..1386.69 rows=124 width=1329) (actual time=0.824..5.282 rows=642 loops=1)
                    Buffers: shared hit=11033
                    ->  Nested Loop  (cost=163.07..1323.52 rows=124 width=346) (actual time=0.817..4.234 rows=642 loops=1)
                          Buffers: shared hit=8465
                          ->  Nested Loop  (cost=162.65..1268.38 rows=124 width=323) (actual time=0.812..3.235 rows=642 loops=1)
                                Buffers: shared hit=5897
                                ->  Nested Loop  (cost=162.22..1210.52 rows=124 width=298) (actual time=0.807..2.160 rows=642 loops=1)
                                      Buffers: shared hit=3329
                                      ->  HashAggregate  (cost=161.79..163.03 rows=124 width=4) (actual time=0.800..0.909 rows=642 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=761
                                            ->  Append  (cost=1.28..161.48 rows=124 width=4) (actual time=0.032..0.676 rows=645 loops=1)
                                                  Buffers: shared hit=761
                                                  ->  Nested Loop  (cost=1.28..83.39 rows=16 width=4) (actual time=0.031..0.618 rows=642 loops=1)
                                                        Buffers: shared hit=756
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.025..0.105 rows=176 loops=1)
                                                              Buffers: shared hit=22
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.015..0.015 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'python'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.008..0.066 rows=176 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=18
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.002..0.002 rows=4 loops=176)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=734
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..77.47 rows=108 width=4) (actual time=0.007..0.008 rows=3 loops=1)
                                                        Index Cond: (attr_path = 'python'::text)
                                                        Buffers: shared hit=5
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.002..0.002 rows=1 loops=642)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=2568
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=642)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=2568
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=642)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=2568
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=642)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=2568
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=642)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=1926
Planning:
  Buffers: shared hit=116
Planning Time: 18.100 ms
Execution Time: 7.229 ms
```

### every version — name=python311

Parameters: `["python311"]` — Execution Time: 1.066 ms

```
Limit  (cost=1427.89..1428.20 rows=124 width=1384) (actual time=0.937..0.949 rows=87 loops=1)
  Buffers: shared hit=1668
  ->  Sort  (cost=1427.89..1428.20 rows=124 width=1384) (actual time=0.935..0.942 rows=87 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 199kB
        Buffers: shared hit=1668
        ->  Nested Loop  (cost=163.77..1423.58 rows=124 width=1384) (actual time=0.113..0.843 rows=87 loops=1)
              Buffers: shared hit=1668
              ->  Nested Loop  (cost=163.49..1386.69 rows=124 width=1329) (actual time=0.108..0.703 rows=87 loops=1)
                    Buffers: shared hit=1407
                    ->  Nested Loop  (cost=163.07..1323.52 rows=124 width=346) (actual time=0.102..0.553 rows=87 loops=1)
                          Buffers: shared hit=1059
                          ->  Nested Loop  (cost=162.65..1268.38 rows=124 width=323) (actual time=0.096..0.412 rows=87 loops=1)
                                Buffers: shared hit=711
                                ->  Nested Loop  (cost=162.22..1210.52 rows=124 width=298) (actual time=0.088..0.260 rows=87 loops=1)
                                      Buffers: shared hit=363
                                      ->  HashAggregate  (cost=161.79..163.03 rows=124 width=4) (actual time=0.080..0.093 rows=87 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=15
                                            ->  Append  (cost=1.28..161.48 rows=124 width=4) (actual time=0.023..0.063 rows=87 loops=1)
                                                  Buffers: shared hit=15
                                                  ->  Nested Loop  (cost=1.28..83.39 rows=16 width=4) (actual time=0.012..0.013 rows=0 loops=1)
                                                        Buffers: shared hit=3
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.012..0.012 rows=0 loops=1)
                                                              Buffers: shared hit=3
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.012 rows=0 loops=1)
                                                                    Index Cond: (lower(name) = 'python311'::text)
                                                                    Buffers: shared hit=3
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (never executed)
                                                                    Index Cond: (package_id = p.id)
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (never executed)
                                                              Index Cond: (version_id = ve.id)
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..77.47 rows=108 width=4) (actual time=0.010..0.042 rows=87 loops=1)
                                                        Index Cond: (attr_path = 'python311'::text)
                                                        Buffers: shared hit=12
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.001..0.001 rows=1 loops=87)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=348
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=87)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=348
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=87)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=348
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=87)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=348
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=87)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=261
Planning:
  Buffers: shared hit=116
Planning Time: 18.809 ms
Execution Time: 1.066 ms
```

### every version — name=hello

Parameters: `["hello"]` — Execution Time: 0.406 ms

```
Limit  (cost=1427.89..1428.20 rows=124 width=1384) (actual time=0.306..0.310 rows=19 loops=1)
  Buffers: shared hit=401
  ->  Sort  (cost=1427.89..1428.20 rows=124 width=1384) (actual time=0.304..0.307 rows=19 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 63kB
        Buffers: shared hit=401
        ->  Nested Loop  (cost=163.77..1423.58 rows=124 width=1384) (actual time=0.109..0.277 rows=19 loops=1)
              Buffers: shared hit=401
              ->  Nested Loop  (cost=163.49..1386.69 rows=124 width=1329) (actual time=0.104..0.241 rows=19 loops=1)
                    Buffers: shared hit=344
                    ->  Nested Loop  (cost=163.07..1323.52 rows=124 width=346) (actual time=0.097..0.200 rows=19 loops=1)
                          Buffers: shared hit=268
                          ->  Nested Loop  (cost=162.65..1268.38 rows=124 width=323) (actual time=0.093..0.159 rows=19 loops=1)
                                Buffers: shared hit=192
                                ->  Nested Loop  (cost=162.22..1210.52 rows=124 width=298) (actual time=0.087..0.124 rows=19 loops=1)
                                      Buffers: shared hit=116
                                      ->  HashAggregate  (cost=161.79..163.03 rows=124 width=4) (actual time=0.081..0.085 rows=19 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=40
                                            ->  Append  (cost=1.28..161.48 rows=124 width=4) (actual time=0.033..0.070 rows=38 loops=1)
                                                  Buffers: shared hit=40
                                                  ->  Nested Loop  (cost=1.28..83.39 rows=16 width=4) (actual time=0.032..0.054 rows=19 loops=1)
                                                        Buffers: shared hit=33
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.025..0.028 rows=5 loops=1)
                                                              Buffers: shared hit=8
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.014..0.015 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'hello'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.008..0.009 rows=5 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=4
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.003..0.005 rows=4 loops=5)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=25
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..77.47 rows=108 width=4) (actual time=0.007..0.012 rows=19 loops=1)
                                                        Index Cond: (attr_path = 'hello'::text)
                                                        Buffers: shared hit=7
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.002..0.002 rows=1 loops=19)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=76
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=19)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=76
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=19)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=76
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=19)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=76
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=19)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=57
Planning:
  Buffers: shared hit=116
Planning Time: 19.374 ms
Execution Time: 0.406 ms
```

