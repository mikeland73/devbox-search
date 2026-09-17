# Serving query plans

Recorded 2026-09-17 against `ep-quiet-frost-auekuzix.c-10.us-east-1.aws.neon.tech` with `node tools/explain-plans.mjs`.
Regenerate after changing apps/web/lib/search.ts or the indexes, and diff.
Warm plans (second run); see the script for what each statement is.

Table sizes: packages=250255, versions=1465337, variants=3826673, search_terms=250843

## What to look for

- **Name lookups** must be index walks: `packages_name_lower_idx` -> `versions` ->
  `variants_identity_key`, unioned with `variants_attr_path_idx`. A `Hash Join` or
  `Seq Scan on variants` here means the name/attr_path predicate has become an OR
  across two tables again (#26: ~4 s per lookup).
- **Batched fetch** must be one `Nested Loop` over `hits` with an index scan on
  `versions (package_id, ...)` per hit — never one query per hit.
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

Parameters: `["go","go"]` — Execution Time: 1.688 ms

```
Limit  (cost=2813.99..2815.30 rows=50 width=42) (actual time=1.251..1.270 rows=50 loops=1)
  Buffers: shared hit=21
  CTE prefix
    ->  Limit  (cost=2538.65..2538.77 rows=50 width=39) (actual time=1.221..1.228 rows=50 loops=1)
          Buffers: shared hit=21
          ->  Sort  (cost=2538.65..2541.85 rows=1279 width=39) (actual time=1.220..1.223 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_1.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms_1.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms_1.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms_1.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_1.name = search_terms_1.attr_path) THEN similarity(search_terms_1.name, 'go'::text) ELSE GREATEST(similarity(search_terms_1.name, 'go'::text), similarity(search_terms_1.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms_1.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_1.name
                Sort Method: top-N heapsort  Memory: 30kB
                Buffers: shared hit=21
                ->  HashAggregate  (cost=2483.37..2496.16 rows=1279 width=39) (actual time=1.065..1.133 rows=424 loops=1)
                      Group Key: search_terms_1.package_id, search_terms_1.name
                      Batches: 1  Memory Usage: 97kB
                      Buffers: shared hit=21
                      ->  Bitmap Heap Scan on search_terms search_terms_1  (cost=50.41..2416.22 rows=1279 width=68) (actual time=0.080..0.210 rows=439 loops=1)
                            Recheck Cond: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                            Filter: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                            Heap Blocks: exact=11
                            Buffers: shared hit=21
                            ->  BitmapOr  (cost=50.41..50.41 rows=1293 width=0) (actual time=0.064..0.065 rows=0 loops=1)
                                  Buffers: shared hit=10
                                  ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.81 rows=39 width=0) (actual time=0.041..0.041 rows=439 loops=1)
                                        Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                        Buffers: shared hit=5
                                  ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..44.96 rows=1254 width=0) (actual time=0.022..0.022 rows=439 loops=1)
                                        Index Cond: ((lower(attr_path) >= 'go'::text) AND (lower(attr_path) < 'gp'::text))
                                        Buffers: shared hit=5
  ->  Merge Append  (cost=275.22..277.84 rows=100 width=42) (actual time=1.250..1.262 rows=50 loops=1)
        Sort Key: prefix.rank DESC, prefix.name
        Buffers: shared hit=21
        ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=1.223..1.228 rows=50 loops=1)
              Buffers: shared hit=21
        ->  Subquery Scan on fuzzy  (cost=275.21..275.83 rows=50 width=39) (actual time=0.026..0.028 rows=0 loops=1)
              ->  Limit  (cost=275.21..275.33 rows=50 width=39) (actual time=0.026..0.027 rows=0 loops=1)
                    InitPlan 2
                      ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.018..0.018 rows=1 loops=1)
                            ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.013 rows=50 loops=1)
                    ->  Sort  (cost=274.07..274.20 rows=50 width=39) (actual time=0.026..0.026 rows=0 loops=1)
                          Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'go'::text) ELSE GREATEST(similarity(search_terms.name, 'go'::text), similarity(search_terms.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                          Sort Method: quicksort  Memory: 25kB
                          ->  GroupAggregate  (cost=269.41..272.66 rows=50 width=39) (actual time=0.023..0.024 rows=0 loops=1)
                                Group Key: search_terms.package_id, search_terms.name
                                ->  Sort  (cost=269.41..269.54 rows=50 width=68) (actual time=0.023..0.023 rows=0 loops=1)
                                      Sort Key: search_terms.package_id, search_terms.name
                                      Sort Method: quicksort  Memory: 25kB
                                      ->  Result  (cost=86.24..268.00 rows=50 width=68) (actual time=0.019..0.020 rows=0 loops=1)
                                            One-Time Filter: ((InitPlan 2).col1 < 50)
                                            ->  Bitmap Heap Scan on search_terms  (cost=86.24..268.00 rows=50 width=68) (never executed)
                                                  Recheck Cond: ((name % 'go'::text) OR (attr_path % 'go'::text))
                                                  Filter: ((lower(name) !~~ 'go%'::text) AND (lower(attr_path) !~~ 'go%'::text))
                                                  ->  BitmapOr  (cost=86.24..86.24 rows=50 width=0) (never executed)
                                                        ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..43.11 rows=25 width=0) (never executed)
                                                              Index Cond: (name % 'go'::text)
                                                        ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..43.11 rows=25 width=0) (never executed)
                                                              Index Cond: (attr_path % 'go'::text)
Planning:
  Buffers: shared hit=6
Planning Time: 1.003 ms
Execution Time: 1.688 ms
```

### batched fetch, latest — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 3.823 ms

```
Limit  (cost=8524.82..8528.13 rows=50 width=1377) (actual time=3.650..3.699 rows=50 loops=1)
  Buffers: shared hit=4106
  ->  Unique  (cost=8524.82..8528.13 rows=50 width=1377) (actual time=3.649..3.694 rows=50 loops=1)
        Buffers: shared hit=4106
        ->  Sort  (cost=8524.82..8526.48 rows=662 width=1377) (actual time=3.648..3.659 rows=174 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Sort Method: quicksort  Memory: 197kB
              Buffers: shared hit=4106
              ->  Hash Join  (cost=255.52..8493.80 rows=662 width=1377) (actual time=1.206..3.506 rows=177 loops=1)
                    Hash Cond: (variants.commit_seq = commit_hash.seq)
                    Buffers: shared hit=4106
                    ->  Nested Loop  (cost=160.63..8397.18 rows=662 width=1322) (actual time=0.486..2.740 rows=177 loops=1)
                          Buffers: shared hit=4074
                          ->  Nested Loop  (cost=160.21..8059.60 rows=662 width=339) (actual time=0.480..2.400 rows=177 loops=1)
                                Join Filter: (variants.version_id = v.id)
                                Buffers: shared hit=3366
                                ->  Nested Loop  (cost=159.78..7987.73 rows=50 width=53) (actual time=0.473..2.196 rows=50 loops=1)
                                      Buffers: shared hit=3086
                                      ->  Nested Loop  (cost=159.36..7965.50 rows=50 width=30) (actual time=0.467..2.081 rows=50 loops=1)
                                            Buffers: shared hit=2886
                                            ->  Nested Loop  (cost=158.92..7947.53 rows=50 width=12) (actual time=0.460..1.935 rows=50 loops=1)
                                                  Buffers: shared hit=2686
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.010..0.016 rows=50 loops=1)
                                                  ->  Limit  (cost=158.92..158.92 rows=1 width=20) (actual time=0.038..0.038 rows=1 loops=50)
                                                        Buffers: shared hit=2686
                                                        ->  Sort  (cost=158.92..159.00 rows=32 width=20) (actual time=0.038..0.038 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, v.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=2686
                                                              ->  Index Scan using versions_semver_idx on versions v  (cost=0.43..158.76 rows=32 width=20) (actual time=0.006..0.034 rows=12 loops=50)
                                                                    Index Cond: (package_id = hits.package_id)
                                                                    Filter: (NOT prerelease)
                                                                    Rows Removed by Filter: 0
                                                                    Buffers: shared hit=2686
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.002..0.002 rows=1 loops=612)
                                                                            Index Cond: (version_id = v.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=2448
                                            ->  Memoize  (cost=0.44..8.46 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Cache Key: v.id
                                                  Cache Mode: logical
                                                  Hits: 0  Misses: 50  Evictions: 0  Overflows: 0  Memory Usage: 6kB
                                                  Buffers: shared hit=200
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=50)
                                                        Index Cond: (id = v.id)
                                                        Buffers: shared hit=200
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=200
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.27 rows=13 width=298) (actual time=0.001..0.003 rows=4 loops=50)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=280
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=177)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=708
                    ->  Hash  (cost=59.95..59.95 rows=2795 width=53) (actual time=0.693..0.693 rows=2795 loops=1)
                          Buckets: 4096  Batches: 1  Memory Usage: 284kB
                          Buffers: shared hit=32
                          ->  Seq Scan on commits commit_hash  (cost=0.00..59.95 rows=2795 width=53) (actual time=0.016..0.316 rows=2795 loops=1)
                                Buffers: shared hit=32
Planning:
  Buffers: shared hit=90
Planning Time: 15.427 ms
Execution Time: 3.823 ms
```

### batched fetch, all versions — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 12.356 ms

```
Limit  (cost=115.50..1465.75 rows=1000 width=1392) (actual time=3.535..12.164 rows=632 loops=1)
  Buffers: shared hit=13108
  ->  Unique  (cost=115.50..5762.22 rows=4182 width=1392) (actual time=3.533..12.112 rows=632 loops=1)
        Buffers: shared hit=13108
        ->  Incremental Sort  (cost=115.50..5730.86 rows=4182 width=1392) (actual time=3.532..11.582 rows=2298 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 19  Sort Method: quicksort  Average Memory: 69kB  Peak Memory: 75kB
              Pre-sorted Groups: 28  Sort Method: quicksort  Average Memory: 558kB  Peak Memory: 558kB
              Buffers: shared hit=13108
              ->  Nested Loop  (cost=1.99..5544.05 rows=4182 width=1392) (actual time=0.073..8.158 rows=2298 loops=1)
                    Buffers: shared hit=13108
                    ->  Nested Loop  (cost=1.70..4883.55 rows=4182 width=1337) (actual time=0.064..6.704 rows=2298 loops=1)
                          Buffers: shared hit=12415
                          ->  Nested Loop  (cost=1.28..2750.99 rows=4182 width=354) (actual time=0.057..3.015 rows=2298 loops=1)
                                Buffers: shared hit=3223
                                ->  Nested Loop  (cost=0.85..506.11 rows=1598 width=64) (actual time=0.035..0.567 rows=632 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=438
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.022..0.128 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.015 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.35 rows=32 width=33) (actual time=0.003..0.006 rows=13 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=238
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.27 rows=13 width=298) (actual time=0.002..0.003 rows=4 loops=632)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=2785
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=2298)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=9192
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=2298)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 2067  Misses: 231  Evictions: 0  Overflows: 0  Memory Usage: 37kB
                          Buffers: shared hit=693
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=231)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=693
Planning:
  Buffers: shared hit=68
Planning Time: 11.963 ms
Execution Time: 12.356 ms
```

### ranked terms — q=python

Parameters: `["python","python"]` — Execution Time: 412.481 ms

```
Limit  (cost=20920.01..20921.35 rows=50 width=42) (actual time=411.274..411.377 rows=50 loops=1)
  Buffers: shared hit=2961, temp read=482 written=483
  CTE prefix
    ->  Limit  (cost=20542.93..20543.05 rows=50 width=39) (actual time=411.234..411.327 rows=50 loops=1)
          Buffers: shared hit=2961, temp read=482 written=483
          ->  Sort  (cost=20542.93..20722.10 rows=71670 width=39) (actual time=411.233..411.322 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_1.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms_1.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms_1.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms_1.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_1.name = search_terms_1.attr_path) THEN similarity(search_terms_1.name, 'python'::text) ELSE GREATEST(similarity(search_terms_1.name, 'python'::text), similarity(search_terms_1.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms_1.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_1.name
                Sort Method: top-N heapsort  Memory: 30kB
                Buffers: shared hit=2961, temp read=482 written=483
                ->  Finalize GroupAggregate  (cost=17022.94..18162.10 rows=71670 width=39) (actual time=373.593..401.755 rows=69849 loops=1)
                      Group Key: search_terms_1.package_id, search_terms_1.name
                      Buffers: shared hit=2961, temp read=482 written=483
                      ->  Sort  (cost=17022.94..17128.56 rows=42246 width=39) (actual time=373.584..380.065 rows=69849 loops=1)
                            Sort Key: search_terms_1.package_id, search_terms_1.name
                            Sort Method: external merge  Disk: 3856kB
                            Buffers: shared hit=2961, temp read=482 written=483
                            ->  Gather  (cost=9130.01..13777.07 rows=42246 width=39) (actual time=320.142..350.394 rows=69849 loops=1)
                                  Workers Planned: 1
                                  Workers Launched: 1
                                  Buffers: shared hit=2961
                                  ->  Partial HashAggregate  (cost=8130.01..8552.47 rows=42246 width=39) (actual time=314.344..324.420 rows=34924 loops=2)
                                        Group Key: search_terms_1.package_id, search_terms_1.name
                                        Batches: 1  Memory Usage: 5137kB
                                        Buffers: shared hit=2961
                                        Worker 0:  Batches: 1  Memory Usage: 5137kB
                                        ->  Parallel Seq Scan on search_terms search_terms_1  (cost=0.00..5912.09 rows=42246 width=68) (actual time=40.820..79.226 rows=35006 loops=2)
                                              Filter: ((lower(name) ~~ 'python%'::text) OR (lower(attr_path) ~~ 'python%'::text))
                                              Rows Removed by Filter: 90415
                                              Buffers: shared hit=2961
  ->  Merge Append  (cost=376.96..379.27 rows=86 width=42) (actual time=411.273..411.284 rows=50 loops=1)
        Sort Key: prefix.rank DESC, prefix.name
        Buffers: shared hit=2961, temp read=482 written=483
        ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=411.237..411.243 rows=50 loops=1)
              Buffers: shared hit=2961, temp read=482 written=483
        ->  Subquery Scan on fuzzy  (cost=376.95..377.40 rows=36 width=39) (actual time=0.034..0.036 rows=0 loops=1)
              ->  Limit  (cost=376.95..377.04 rows=36 width=39) (actual time=0.033..0.034 rows=0 loops=1)
                    InitPlan 2
                      ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.018..0.018 rows=1 loops=1)
                            ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.001..0.014 rows=50 loops=1)
                    ->  Sort  (cost=375.82..375.91 rows=36 width=39) (actual time=0.032..0.033 rows=0 loops=1)
                          Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'python'::text) ELSE GREATEST(similarity(search_terms.name, 'python'::text), similarity(search_terms.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                          Sort Method: quicksort  Memory: 25kB
                          ->  GroupAggregate  (cost=372.54..374.88 rows=36 width=39) (actual time=0.024..0.025 rows=0 loops=1)
                                Group Key: search_terms.package_id, search_terms.name
                                ->  Sort  (cost=372.54..372.63 rows=36 width=68) (actual time=0.023..0.024 rows=0 loops=1)
                                      Sort Key: search_terms.package_id, search_terms.name
                                      Sort Method: quicksort  Memory: 25kB
                                      ->  Result  (cost=189.86..371.61 rows=36 width=68) (actual time=0.020..0.021 rows=0 loops=1)
                                            One-Time Filter: ((InitPlan 2).col1 < 50)
                                            ->  Bitmap Heap Scan on search_terms  (cost=189.86..371.61 rows=36 width=68) (never executed)
                                                  Recheck Cond: ((name % 'python'::text) OR (attr_path % 'python'::text))
                                                  Filter: ((lower(name) !~~ 'python%'::text) AND (lower(attr_path) !~~ 'python%'::text))
                                                  ->  BitmapOr  (cost=189.85..189.85 rows=50 width=0) (never executed)
                                                        ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..94.92 rows=25 width=0) (never executed)
                                                              Index Cond: (name % 'python'::text)
                                                        ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..94.92 rows=25 width=0) (never executed)
                                                              Index Cond: (attr_path % 'python'::text)
Planning:
  Buffers: shared hit=6
Planning Time: 0.949 ms
Execution Time: 412.481 ms
```

### batched fetch, latest — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 3.287 ms

```
Limit  (cost=8524.82..8528.13 rows=50 width=1377) (actual time=3.154..3.194 rows=49 loops=1)
  Buffers: shared hit=3413
  ->  Unique  (cost=8524.82..8528.13 rows=50 width=1377) (actual time=3.153..3.189 rows=49 loops=1)
        Buffers: shared hit=3413
        ->  Sort  (cost=8524.82..8526.48 rows=662 width=1377) (actual time=3.152..3.161 rows=125 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Sort Method: quicksort  Memory: 161kB
              Buffers: shared hit=3413
              ->  Hash Join  (cost=255.52..8493.80 rows=662 width=1377) (actual time=1.030..3.057 rows=125 loops=1)
                    Hash Cond: (variants.commit_seq = commit_hash.seq)
                    Buffers: shared hit=3413
                    ->  Nested Loop  (cost=160.63..8397.18 rows=662 width=1322) (actual time=0.335..2.328 rows=125 loops=1)
                          Buffers: shared hit=3381
                          ->  Nested Loop  (cost=160.21..8059.60 rows=662 width=339) (actual time=0.329..2.083 rows=125 loops=1)
                                Join Filter: (variants.version_id = v.id)
                                Buffers: shared hit=2881
                                ->  Nested Loop  (cost=159.78..7987.73 rows=50 width=53) (actual time=0.324..1.940 rows=49 loops=1)
                                      Buffers: shared hit=2666
                                      ->  Nested Loop  (cost=159.36..7965.50 rows=50 width=30) (actual time=0.317..1.792 rows=49 loops=1)
                                            Buffers: shared hit=2470
                                            ->  Nested Loop  (cost=158.92..7947.53 rows=50 width=12) (actual time=0.309..1.626 rows=49 loops=1)
                                                  Buffers: shared hit=2274
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.007..0.013 rows=50 loops=1)
                                                  ->  Limit  (cost=158.92..158.92 rows=1 width=20) (actual time=0.032..0.032 rows=1 loops=50)
                                                        Buffers: shared hit=2274
                                                        ->  Sort  (cost=158.92..159.00 rows=32 width=20) (actual time=0.032..0.032 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, v.sort_key DESC
                                                              Sort Method: quicksort  Memory: 25kB
                                                              Buffers: shared hit=2274
                                                              ->  Index Scan using versions_semver_idx on versions v  (cost=0.43..158.76 rows=32 width=20) (actual time=0.007..0.029 rows=10 loops=50)
                                                                    Index Cond: (package_id = hits.package_id)
                                                                    Filter: (NOT prerelease)
                                                                    Rows Removed by Filter: 2
                                                                    Buffers: shared hit=2274
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.002..0.002 rows=1 loops=511)
                                                                            Index Cond: (version_id = v.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=2044
                                            ->  Memoize  (cost=0.44..8.46 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=49)
                                                  Cache Key: v.id
                                                  Cache Mode: logical
                                                  Hits: 0  Misses: 49  Evictions: 0  Overflows: 0  Memory Usage: 6kB
                                                  Buffers: shared hit=196
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=49)
                                                        Index Cond: (id = v.id)
                                                        Buffers: shared hit=196
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=49)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=196
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.27 rows=13 width=298) (actual time=0.001..0.002 rows=3 loops=49)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=215
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=125)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=500
                    ->  Hash  (cost=59.95..59.95 rows=2795 width=53) (actual time=0.691..0.692 rows=2795 loops=1)
                          Buckets: 4096  Batches: 1  Memory Usage: 284kB
                          Buffers: shared hit=32
                          ->  Seq Scan on commits commit_hash  (cost=0.00..59.95 rows=2795 width=53) (actual time=0.014..0.312 rows=2795 loops=1)
                                Buffers: shared hit=32
Planning:
  Buffers: shared hit=90
Planning Time: 14.292 ms
Execution Time: 3.287 ms
```

### batched fetch, all versions — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 11.996 ms

```
Limit  (cost=115.50..1465.75 rows=1000 width=1392) (actual time=3.166..11.796 rows=634 loops=1)
  Buffers: shared hit=12204
  ->  Unique  (cost=115.50..5762.22 rows=4182 width=1392) (actual time=3.164..11.743 rows=634 loops=1)
        Buffers: shared hit=12204
        ->  Incremental Sort  (cost=115.50..5730.86 rows=4182 width=1392) (actual time=3.163..11.198 rows=2158 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 19  Sort Method: quicksort  Average Memory: 126kB  Peak Memory: 126kB
              Pre-sorted Groups: 13  Sort Method: quicksort  Average Memory: 873kB  Peak Memory: 873kB
              Buffers: shared hit=12204
              ->  Nested Loop  (cost=1.99..5544.05 rows=4182 width=1392) (actual time=0.060..7.832 rows=2158 loops=1)
                    Buffers: shared hit=12204
                    ->  Nested Loop  (cost=1.70..4883.55 rows=4182 width=1337) (actual time=0.049..6.562 rows=2158 loops=1)
                          Buffers: shared hit=11694
                          ->  Nested Loop  (cost=1.28..2750.99 rows=4182 width=354) (actual time=0.043..3.064 rows=2158 loops=1)
                                Buffers: shared hit=3062
                                ->  Nested Loop  (cost=0.85..506.11 rows=1598 width=64) (actual time=0.036..0.657 rows=634 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=418
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.023..0.194 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.016 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.35 rows=32 width=33) (actual time=0.003..0.007 rows=13 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=218
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.27 rows=13 width=298) (actual time=0.002..0.003 rows=3 loops=634)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=2644
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=2158)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=8632
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=2158)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 1988  Misses: 170  Evictions: 0  Overflows: 0  Memory Usage: 27kB
                          Buffers: shared hit=510
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=170)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=510
Planning:
  Buffers: shared hit=68
Planning Time: 11.902 ms
Execution Time: 11.996 ms
```

### ranked terms — q=hello

Parameters: `["hello","hello"]` — Execution Time: 90.584 ms

```
Limit  (cost=2854.85..2856.16 rows=50 width=42) (actual time=90.452..90.466 rows=14 loops=1)
  Buffers: shared hit=1100
  CTE prefix
    ->  Limit  (cost=2501.79..2501.91 rows=50 width=39) (actual time=0.101..0.104 rows=5 loops=1)
          Buffers: shared hit=7
          ->  Sort  (cost=2501.79..2504.99 rows=1279 width=39) (actual time=0.101..0.103 rows=5 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_1.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms_1.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms_1.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms_1.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_1.name = search_terms_1.attr_path) THEN similarity(search_terms_1.name, 'hello'::text) ELSE GREATEST(similarity(search_terms_1.name, 'hello'::text), similarity(search_terms_1.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms_1.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_1.name
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=7
                ->  HashAggregate  (cost=2446.51..2459.30 rows=1279 width=39) (actual time=0.092..0.098 rows=5 loops=1)
                      Group Key: search_terms_1.package_id, search_terms_1.name
                      Batches: 1  Memory Usage: 73kB
                      Buffers: shared hit=7
                      ->  Bitmap Heap Scan on search_terms search_terms_1  (cost=50.03..2379.36 rows=1279 width=68) (actual time=0.027..0.040 rows=5 loops=1)
                            Recheck Cond: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                            Filter: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                            Heap Blocks: exact=1
                            Buffers: shared hit=7
                            ->  BitmapOr  (cost=50.03..50.03 rows=1254 width=0) (actual time=0.019..0.020 rows=0 loops=1)
                                  Buffers: shared hit=6
                                  ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.013..0.013 rows=5 loops=1)
                                        Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                        Buffers: shared hit=3
                                  ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..44.96 rows=1254 width=0) (actual time=0.006..0.006 rows=5 loops=1)
                                        Index Cond: ((lower(attr_path) >= 'hello'::text) AND (lower(attr_path) < 'hellp'::text))
                                        Buffers: shared hit=3
  ->  Merge Append  (cost=352.93..355.56 rows=100 width=42) (actual time=90.450..90.460 rows=14 loops=1)
        Sort Key: prefix.rank DESC, prefix.name
        Buffers: shared hit=1100
        ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=0.103..0.105 rows=5 loops=1)
              Buffers: shared hit=7
        ->  Subquery Scan on fuzzy  (cost=352.92..353.55 rows=50 width=39) (actual time=90.346..90.352 rows=9 loops=1)
              Buffers: shared hit=1093
              ->  Limit  (cost=352.92..353.05 rows=50 width=39) (actual time=90.345..90.349 rows=9 loops=1)
                    Buffers: shared hit=1093
                    InitPlan 2
                      ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.004..0.004 rows=1 loops=1)
                            ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.002 rows=5 loops=1)
                    ->  Sort  (cost=351.79..351.91 rows=50 width=39) (actual time=90.344..90.347 rows=9 loops=1)
                          Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'hello'::text) ELSE GREATEST(similarity(search_terms.name, 'hello'::text), similarity(search_terms.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                          Sort Method: quicksort  Memory: 25kB
                          Buffers: shared hit=1093
                          ->  GroupAggregate  (cost=347.13..350.38 rows=50 width=39) (actual time=90.320..90.340 rows=9 loops=1)
                                Group Key: search_terms.package_id, search_terms.name
                                Buffers: shared hit=1093
                                ->  Sort  (cost=347.13..347.25 rows=50 width=68) (actual time=90.308..90.310 rows=9 loops=1)
                                      Sort Key: search_terms.package_id, search_terms.name
                                      Sort Method: quicksort  Memory: 25kB
                                      Buffers: shared hit=1093
                                      ->  Result  (cost=163.96..345.72 rows=50 width=68) (actual time=38.562..90.298 rows=9 loops=1)
                                            One-Time Filter: ((InitPlan 2).col1 < 50)
                                            Buffers: shared hit=1093
                                            ->  Bitmap Heap Scan on search_terms  (cost=163.96..345.72 rows=50 width=68) (actual time=38.556..90.288 rows=9 loops=1)
                                                  Recheck Cond: ((name % 'hello'::text) OR (attr_path % 'hello'::text))
                                                  Rows Removed by Index Recheck: 17510
                                                  Filter: ((lower(name) !~~ 'hello%'::text) AND (lower(attr_path) !~~ 'hello%'::text))
                                                  Rows Removed by Filter: 5
                                                  Heap Blocks: exact=1029
                                                  Buffers: shared hit=1093
                                                  ->  BitmapOr  (cost=163.96..163.96 rows=50 width=0) (actual time=3.793..3.794 rows=0 loops=1)
                                                        Buffers: shared hit=64
                                                        ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..81.97 rows=25 width=0) (actual time=1.929..1.929 rows=17524 loops=1)
                                                              Index Cond: (name % 'hello'::text)
                                                              Buffers: shared hit=32
                                                        ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..81.97 rows=25 width=0) (actual time=1.864..1.864 rows=17524 loops=1)
                                                              Index Cond: (attr_path % 'hello'::text)
                                                              Buffers: shared hit=32
Planning:
  Buffers: shared hit=6
Planning Time: 0.926 ms
Execution Time: 90.584 ms
```

### batched fetch, latest — q=hello (14 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,51341,242138,42681"]` — Execution Time: 0.870 ms

```
Limit  (cost=322.35..2424.17 rows=14 width=1377) (actual time=0.619..0.780 rows=14 loops=1)
  Buffers: shared hit=865
  ->  Unique  (cost=322.35..2424.17 rows=14 width=1377) (actual time=0.614..0.774 rows=14 loops=1)
        Buffers: shared hit=865
        ->  Incremental Sort  (cost=322.35..2423.71 rows=185 width=1377) (actual time=0.614..0.762 rows=46 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 65kB  Peak Memory: 65kB
              Buffers: shared hit=865
              ->  Nested Loop  (cost=160.91..2417.68 rows=185 width=1377) (actual time=0.089..0.711 rows=46 loops=1)
                    Buffers: shared hit=865
                    ->  Nested Loop  (cost=160.63..2362.63 rows=185 width=1322) (actual time=0.084..0.641 rows=46 loops=1)
                          Buffers: shared hit=727
                          ->  Nested Loop  (cost=160.21..2268.29 rows=185 width=339) (actual time=0.076..0.537 rows=46 loops=1)
                                Join Filter: (variants.version_id = v.id)
                                Buffers: shared hit=543
                                ->  Nested Loop  (cost=159.78..2248.17 rows=14 width=53) (actual time=0.072..0.473 rows=14 loops=1)
                                      Buffers: shared hit=468
                                      ->  Nested Loop  (cost=159.36..2241.94 rows=14 width=30) (actual time=0.066..0.354 rows=14 loops=1)
                                            Buffers: shared hit=412
                                            ->  Nested Loop  (cost=158.92..2225.31 rows=14 width=12) (actual time=0.057..0.304 rows=14 loops=1)
                                                  Buffers: shared hit=356
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.14 rows=14 width=12) (actual time=0.007..0.009 rows=14 loops=1)
                                                  ->  Limit  (cost=158.92..158.92 rows=1 width=20) (actual time=0.021..0.021 rows=1 loops=14)
                                                        Buffers: shared hit=356
                                                        ->  Sort  (cost=158.92..159.00 rows=32 width=20) (actual time=0.020..0.020 rows=1 loops=14)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, v.sort_key DESC
                                                              Sort Method: quicksort  Memory: 25kB
                                                              Buffers: shared hit=356
                                                              ->  Index Scan using versions_semver_idx on versions v  (cost=0.43..158.76 rows=32 width=20) (actual time=0.007..0.017 rows=5 loops=14)
                                                                    Index Cond: (package_id = hits.package_id)
                                                                    Filter: (NOT prerelease)
                                                                    Buffers: shared hit=356
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.002..0.002 rows=1 loops=75)
                                                                            Index Cond: (version_id = v.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=300
                                            ->  Memoize  (cost=0.44..8.46 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=14)
                                                  Cache Key: v.id
                                                  Cache Mode: logical
                                                  Hits: 0  Misses: 14  Evictions: 0  Overflows: 0  Memory Usage: 2kB
                                                  Buffers: shared hit=56
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=14)
                                                        Index Cond: (id = v.id)
                                                        Buffers: shared hit=56
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.008..0.008 rows=1 loops=14)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=56
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.27 rows=13 width=298) (actual time=0.002..0.003 rows=3 loops=14)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=75
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=46)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=184
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=46)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=138
Planning:
  Buffers: shared hit=90
Planning Time: 15.422 ms
Execution Time: 0.870 ms
```

### batched fetch, all versions — q=hello (14 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,51341,242138,42681"]` — Execution Time: 1.736 ms

```
Limit  (cost=127.27..1537.20 rows=1000 width=1392) (actual time=0.334..1.651 rows=75 loops=1)
  Buffers: shared hit=1983
  ->  Unique  (cost=127.27..1779.71 rows=1172 width=1392) (actual time=0.332..1.643 rows=75 loops=1)
        Buffers: shared hit=1983
        ->  Incremental Sort  (cost=127.27..1770.92 rows=1172 width=1392) (actual time=0.332..1.590 rows=216 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 5  Sort Method: quicksort  Average Memory: 88kB  Peak Memory: 88kB
              Pre-sorted Groups: 3  Sort Method: quicksort  Average Memory: 50kB  Peak Memory: 54kB
              Buffers: shared hit=1983
              ->  Nested Loop  (cost=1.98..1718.55 rows=1172 width=1392) (actual time=0.048..1.166 rows=216 loops=1)
                    Buffers: shared hit=1983
                    ->  Nested Loop  (cost=1.70..1369.83 rows=1172 width=1337) (actual time=0.043..0.851 rows=216 loops=1)
                          Buffers: shared hit=1335
                          ->  Nested Loop  (cost=1.28..772.19 rows=1172 width=354) (actual time=0.036..0.479 rows=216 loops=1)
                                Buffers: shared hit=471
                                ->  Nested Loop  (cost=0.85..142.83 rows=448 width=64) (actual time=0.029..0.160 rows=75 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=112
                                      ->  Nested Loop  (cost=0.42..118.27 rows=14 width=43) (actual time=0.020..0.067 rows=14 loops=1)
                                            Buffers: shared hit=56
                                            ->  Function Scan on unnest hits  (cost=0.00..0.14 rows=14 width=12) (actual time=0.006..0.008 rows=14 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=14)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=56
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.35 rows=32 width=33) (actual time=0.004..0.005 rows=5 loops=14)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=56
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.27 rows=13 width=298) (actual time=0.002..0.003 rows=3 loops=75)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=359
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=216)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=864
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=216)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=648
Planning:
  Buffers: shared hit=68
Planning Time: 12.908 ms
Execution Time: 1.736 ms
```

## Name lookups (/v2/resolve, /v1/resolve, /v2/pkg, /v1/pkg)

### pick latest version — name=go

Parameters: `["go"]` — Execution Time: 6.207 ms

```
Limit  (cost=1312.81..1312.81 rows=1 width=19) (actual time=6.106..6.110 rows=1 loops=1)
  Buffers: shared hit=9929
  ->  Sort  (cost=1312.81..1313.11 rows=121 width=19) (actual time=6.105..6.108 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=9929
        ->  Nested Loop  (cost=162.43..1312.20 rows=121 width=19) (actual time=1.103..5.964 rows=644 loops=1)
              Buffers: shared hit=9929
              ->  Nested Loop  (cost=162.01..1258.39 rows=121 width=23) (actual time=1.092..4.360 rows=644 loops=1)
                    Buffers: shared hit=6708
                    ->  Nested Loop  (cost=161.58..1201.43 rows=122 width=4) (actual time=1.087..3.027 rows=719 loops=1)
                          Buffers: shared hit=3832
                          ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=1.081..1.209 rows=719 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=956
                                ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.033..0.904 rows=976 loops=1)
                                      Buffers: shared hit=956
                                      ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.032..0.752 rows=719 loops=1)
                                            Buffers: shared hit=895
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.025..0.099 rows=191 loops=1)
                                                  Buffers: shared hit=23
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.013 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'go'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.010..0.060 rows=191 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=19
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (actual time=0.002..0.003 rows=4 loops=191)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=872
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.008..0.076 rows=257 loops=1)
                                            Index Cond: (attr_path = 'go'::text)
                                            Buffers: shared hit=61
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=719)
                                Index Cond: (id = va.id)
                                Filter: (NOT broken)
                                Buffers: shared hit=2876
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.002..0.002 rows=1 loops=719)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=2876
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=644)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 644
                    Buffers: shared hit=3221
Planning:
  Buffers: shared hit=92
Planning Time: 15.453 ms
Execution Time: 6.207 ms
```

### pick latest version — name=python

Parameters: `["python"]` — Execution Time: 4.558 ms

```
Limit  (cost=1312.81..1312.81 rows=1 width=19) (actual time=4.466..4.470 rows=1 loops=1)
  Buffers: shared hit=7943
  ->  Sort  (cost=1312.81..1313.11 rows=121 width=19) (actual time=4.465..4.467 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=7943
        ->  Nested Loop  (cost=162.43..1312.20 rows=121 width=19) (actual time=0.870..4.397 rows=409 loops=1)
              Buffers: shared hit=7943
              ->  Nested Loop  (cost=162.01..1258.39 rows=121 width=23) (actual time=0.863..3.435 rows=409 loops=1)
                    Buffers: shared hit=5897
                    ->  Nested Loop  (cost=161.58..1201.43 rows=122 width=4) (actual time=0.857..2.199 rows=642 loops=1)
                          Buffers: shared hit=3329
                          ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=0.851..0.942 rows=642 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=761
                                ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.032..0.721 rows=645 loops=1)
                                      Buffers: shared hit=761
                                      ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.032..0.664 rows=642 loops=1)
                                            Buffers: shared hit=756
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.024..0.098 rows=176 loops=1)
                                                  Buffers: shared hit=22
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.014..0.016 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'python'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.008..0.058 rows=176 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=18
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (actual time=0.002..0.003 rows=4 loops=176)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=734
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.007..0.008 rows=3 loops=1)
                                            Index Cond: (attr_path = 'python'::text)
                                            Buffers: shared hit=5
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=642)
                                Index Cond: (id = va.id)
                                Filter: (NOT broken)
                                Buffers: shared hit=2568
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.002..0.002 rows=1 loops=642)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=2568
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=409)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 409
                    Buffers: shared hit=2046
Planning:
  Buffers: shared hit=92
Planning Time: 16.463 ms
Execution Time: 4.558 ms
```

### pick latest version — name=python311

Parameters: `["python311"]` — Execution Time: 0.616 ms

```
Limit  (cost=1312.81..1312.81 rows=1 width=19) (actual time=0.546..0.549 rows=1 loops=1)
  Buffers: shared hit=967
  ->  Sort  (cost=1312.81..1313.11 rows=121 width=19) (actual time=0.545..0.547 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=967
        ->  Nested Loop  (cost=162.43..1312.20 rows=121 width=19) (actual time=0.108..0.530 rows=51 loops=1)
              Buffers: shared hit=967
              ->  Nested Loop  (cost=162.01..1258.39 rows=121 width=23) (actual time=0.099..0.416 rows=51 loops=1)
                    Buffers: shared hit=711
                    ->  Nested Loop  (cost=161.58..1201.43 rows=122 width=4) (actual time=0.092..0.268 rows=87 loops=1)
                          Buffers: shared hit=363
                          ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=0.083..0.099 rows=87 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=15
                                ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.027..0.066 rows=87 loops=1)
                                      Buffers: shared hit=15
                                      ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.017..0.018 rows=0 loops=1)
                                            Buffers: shared hit=3
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.017..0.017 rows=0 loops=1)
                                                  Buffers: shared hit=3
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.016..0.016 rows=0 loops=1)
                                                        Index Cond: (lower(name) = 'python311'::text)
                                                        Buffers: shared hit=3
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (never executed)
                                                        Index Cond: (package_id = p.id)
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (never executed)
                                                  Index Cond: (version_id = ve.id)
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.010..0.041 rows=87 loops=1)
                                            Index Cond: (attr_path = 'python311'::text)
                                            Buffers: shared hit=12
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=87)
                                Index Cond: (id = va.id)
                                Filter: (NOT broken)
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
Planning:
  Buffers: shared hit=92
Planning Time: 16.476 ms
Execution Time: 0.616 ms
```

### pick latest version — name=hello

Parameters: `["hello"]` — Execution Time: 0.289 ms

```
Limit  (cost=1312.81..1312.81 rows=1 width=19) (actual time=0.219..0.221 rows=1 loops=1)
  Buffers: shared hit=288
  ->  Sort  (cost=1312.81..1313.11 rows=121 width=19) (actual time=0.218..0.219 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=288
        ->  Nested Loop  (cost=162.43..1312.20 rows=121 width=19) (actual time=0.106..0.210 rows=19 loops=1)
              Buffers: shared hit=288
              ->  Nested Loop  (cost=162.01..1258.39 rows=121 width=23) (actual time=0.100..0.164 rows=19 loops=1)
                    Buffers: shared hit=192
                    ->  Nested Loop  (cost=161.58..1201.43 rows=122 width=4) (actual time=0.094..0.130 rows=19 loops=1)
                          Buffers: shared hit=116
                          ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=0.088..0.092 rows=19 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=40
                                ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.042..0.077 rows=38 loops=1)
                                      Buffers: shared hit=40
                                      ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.041..0.063 rows=19 loops=1)
                                            Buffers: shared hit=33
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.035..0.037 rows=5 loops=1)
                                                  Buffers: shared hit=8
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.024..0.025 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'hello'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.008..0.009 rows=5 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=4
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (actual time=0.003..0.004 rows=4 loops=5)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=25
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.006..0.011 rows=19 loops=1)
                                            Index Cond: (attr_path = 'hello'::text)
                                            Buffers: shared hit=7
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=19)
                                Index Cond: (id = va.id)
                                Filter: (NOT broken)
                                Buffers: shared hit=76
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=19)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Buffers: shared hit=76
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=19)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 19
                    Buffers: shared hit=96
Planning:
  Buffers: shared hit=92
Planning Time: 16.124 ms
Execution Time: 0.289 ms
```

### every version — name=go

Parameters: `["go"]` — Execution Time: 9.755 ms

```
Limit  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=9.421..9.529 rows=719 loops=1)
  Buffers: shared hit=14617
  ->  Sort  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=9.419..9.471 rows=719 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 737kB
        Buffers: shared hit=14617
        ->  Nested Loop  (cost=163.13..1412.85 rows=123 width=1384) (actual time=1.178..7.995 rows=719 loops=1)
              Buffers: shared hit=14617
              ->  Nested Loop  (cost=162.85..1376.25 rows=123 width=1329) (actual time=1.173..6.838 rows=719 loops=1)
                    Buffers: shared hit=12460
                    ->  Nested Loop  (cost=162.43..1313.53 rows=123 width=346) (actual time=1.167..5.577 rows=719 loops=1)
                          Buffers: shared hit=9584
                          ->  Nested Loop  (cost=162.01..1258.83 rows=123 width=323) (actual time=1.162..4.307 rows=719 loops=1)
                                Buffers: shared hit=6708
                                ->  Nested Loop  (cost=161.58..1201.43 rows=123 width=298) (actual time=1.157..2.814 rows=719 loops=1)
                                      Buffers: shared hit=3832
                                      ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=1.150..1.300 rows=719 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=956
                                            ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.035..0.960 rows=976 loops=1)
                                                  Buffers: shared hit=956
                                                  ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.035..0.795 rows=719 loops=1)
                                                        Buffers: shared hit=895
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.028..0.115 rows=191 loops=1)
                                                              Buffers: shared hit=23
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.016..0.019 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'go'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.009..0.066 rows=191 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=19
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (actual time=0.002..0.003 rows=4 loops=191)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=872
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.007..0.082 rows=257 loops=1)
                                                        Index Cond: (attr_path = 'go'::text)
                                                        Buffers: shared hit=61
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.002..0.002 rows=1 loops=719)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=2876
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.002..0.002 rows=1 loops=719)
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
  Buffers: shared hit=114
Planning Time: 19.892 ms
Execution Time: 9.755 ms
```

### every version — name=python

Parameters: `["python"]` — Execution Time: 7.363 ms

```
Limit  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=7.027..7.124 rows=642 loops=1)
  Buffers: shared hit=12959
  ->  Sort  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=7.025..7.074 rows=642 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 1282kB
        Buffers: shared hit=12959
        ->  Nested Loop  (cost=163.13..1412.85 rows=123 width=1384) (actual time=0.817..6.251 rows=642 loops=1)
              Buffers: shared hit=12959
              ->  Nested Loop  (cost=162.85..1376.25 rows=123 width=1329) (actual time=0.811..5.293 rows=642 loops=1)
                    Buffers: shared hit=11033
                    ->  Nested Loop  (cost=162.43..1313.53 rows=123 width=346) (actual time=0.804..4.225 rows=642 loops=1)
                          Buffers: shared hit=8465
                          ->  Nested Loop  (cost=162.01..1258.83 rows=123 width=323) (actual time=0.799..3.279 rows=642 loops=1)
                                Buffers: shared hit=5897
                                ->  Nested Loop  (cost=161.58..1201.43 rows=123 width=298) (actual time=0.794..2.205 rows=642 loops=1)
                                      Buffers: shared hit=3329
                                      ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=0.788..0.908 rows=642 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=761
                                            ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.030..0.660 rows=645 loops=1)
                                                  Buffers: shared hit=761
                                                  ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.029..0.602 rows=642 loops=1)
                                                        Buffers: shared hit=756
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.023..0.088 rows=176 loops=1)
                                                              Buffers: shared hit=22
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.013 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'python'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.007..0.051 rows=176 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=18
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (actual time=0.002..0.002 rows=4 loops=176)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=734
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.007..0.009 rows=3 loops=1)
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
  Buffers: shared hit=114
Planning Time: 18.956 ms
Execution Time: 7.363 ms
```

### every version — name=python311

Parameters: `["python311"]` — Execution Time: 1.045 ms

```
Limit  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=0.928..0.941 rows=87 loops=1)
  Buffers: shared hit=1668
  ->  Sort  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=0.927..0.933 rows=87 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 199kB
        Buffers: shared hit=1668
        ->  Nested Loop  (cost=163.13..1412.85 rows=123 width=1384) (actual time=0.108..0.821 rows=87 loops=1)
              Buffers: shared hit=1668
              ->  Nested Loop  (cost=162.85..1376.25 rows=123 width=1329) (actual time=0.102..0.686 rows=87 loops=1)
                    Buffers: shared hit=1407
                    ->  Nested Loop  (cost=162.43..1313.53 rows=123 width=346) (actual time=0.097..0.538 rows=87 loops=1)
                          Buffers: shared hit=1059
                          ->  Nested Loop  (cost=162.01..1258.83 rows=123 width=323) (actual time=0.092..0.403 rows=87 loops=1)
                                Buffers: shared hit=711
                                ->  Nested Loop  (cost=161.58..1201.43 rows=123 width=298) (actual time=0.084..0.256 rows=87 loops=1)
                                      Buffers: shared hit=363
                                      ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=0.076..0.090 rows=87 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=15
                                            ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.022..0.059 rows=87 loops=1)
                                                  Buffers: shared hit=15
                                                  ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.012..0.012 rows=0 loops=1)
                                                        Buffers: shared hit=3
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.012..0.012 rows=0 loops=1)
                                                              Buffers: shared hit=3
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.011..0.011 rows=0 loops=1)
                                                                    Index Cond: (lower(name) = 'python311'::text)
                                                                    Buffers: shared hit=3
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (never executed)
                                                                    Index Cond: (package_id = p.id)
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (never executed)
                                                              Index Cond: (version_id = ve.id)
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.010..0.039 rows=87 loops=1)
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
  Buffers: shared hit=114
Planning Time: 18.453 ms
Execution Time: 1.045 ms
```

### every version — name=hello

Parameters: `["hello"]` — Execution Time: 0.463 ms

```
Limit  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=0.367..0.371 rows=19 loops=1)
  Buffers: shared hit=401
  ->  Sort  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=0.366..0.369 rows=19 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 63kB
        Buffers: shared hit=401
        ->  Nested Loop  (cost=163.13..1412.85 rows=123 width=1384) (actual time=0.175..0.339 rows=19 loops=1)
              Buffers: shared hit=401
              ->  Nested Loop  (cost=162.85..1376.25 rows=123 width=1329) (actual time=0.169..0.303 rows=19 loops=1)
                    Buffers: shared hit=344
                    ->  Nested Loop  (cost=162.43..1313.53 rows=123 width=346) (actual time=0.163..0.264 rows=19 loops=1)
                          Buffers: shared hit=268
                          ->  Nested Loop  (cost=162.01..1258.83 rows=123 width=323) (actual time=0.158..0.227 rows=19 loops=1)
                                Buffers: shared hit=192
                                ->  Nested Loop  (cost=161.58..1201.43 rows=123 width=298) (actual time=0.152..0.190 rows=19 loops=1)
                                      Buffers: shared hit=116
                                      ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=0.146..0.151 rows=19 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=40
                                            ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.095..0.135 rows=38 loops=1)
                                                  Buffers: shared hit=40
                                                  ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.095..0.119 rows=19 loops=1)
                                                        Buffers: shared hit=33
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.026..0.029 rows=5 loops=1)
                                                              Buffers: shared hit=8
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.016..0.017 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'hello'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.008..0.009 rows=5 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=4
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (actual time=0.016..0.017 rows=4 loops=5)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=25
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.007..0.011 rows=19 loops=1)
                                                        Index Cond: (attr_path = 'hello'::text)
                                                        Buffers: shared hit=7
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.002..0.002 rows=1 loops=19)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=76
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=19)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=76
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=19)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=76
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=19)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=76
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=19)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=57
Planning:
  Buffers: shared hit=114
Planning Time: 18.292 ms
Execution Time: 0.463 ms
```

