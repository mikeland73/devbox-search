# Serving query plans

Recorded 2026-09-17 against `ep-bitter-dream-au22wc7j.c-10.us-east-1.aws.neon.tech` with `node tools/explain-plans.mjs`.
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

Parameters: `["go","go"]` — Execution Time: 1.646 ms

```
Limit  (cost=2821.18..2821.30 rows=50 width=44) (actual time=1.250..1.258 rows=50 loops=1)
  Buffers: shared hit=21
  CTE prefix
    ->  Limit  (cost=2538.65..2538.77 rows=50 width=39) (actual time=1.173..1.181 rows=50 loops=1)
          Buffers: shared hit=21
          ->  Sort  (cost=2538.65..2541.85 rows=1279 width=39) (actual time=1.173..1.176 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_1.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms_1.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms_1.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms_1.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_1.name = search_terms_1.attr_path) THEN similarity(search_terms_1.name, 'go'::text) ELSE GREATEST(similarity(search_terms_1.name, 'go'::text), similarity(search_terms_1.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms_1.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_1.name
                Sort Method: top-N heapsort  Memory: 30kB
                Buffers: shared hit=21
                ->  HashAggregate  (cost=2483.37..2496.16 rows=1279 width=39) (actual time=1.014..1.076 rows=424 loops=1)
                      Group Key: search_terms_1.package_id, search_terms_1.name
                      Batches: 1  Memory Usage: 97kB
                      Buffers: shared hit=21
                      ->  Bitmap Heap Scan on search_terms search_terms_1  (cost=50.41..2416.22 rows=1279 width=68) (actual time=0.062..0.191 rows=439 loops=1)
                            Recheck Cond: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                            Filter: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                            Heap Blocks: exact=11
                            Buffers: shared hit=21
                            ->  BitmapOr  (cost=50.41..50.41 rows=1293 width=0) (actual time=0.053..0.053 rows=0 loops=1)
                                  Buffers: shared hit=10
                                  ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.81 rows=39 width=0) (actual time=0.030..0.030 rows=439 loops=1)
                                        Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                        Buffers: shared hit=5
                                  ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..44.96 rows=1254 width=0) (actual time=0.022..0.022 rows=439 loops=1)
                                        Index Cond: ((lower(attr_path) >= 'go'::text) AND (lower(attr_path) < 'gp'::text))
                                        Buffers: shared hit=5
  ->  Sort  (cost=282.41..282.66 rows=100 width=44) (actual time=1.249..1.253 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=21
        ->  HashAggregate  (cost=278.08..279.08 rows=100 width=44) (actual time=1.225..1.233 rows=50 loops=1)
              Group Key: prefix.package_id
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=21
              ->  Append  (cost=0.00..277.33 rows=100 width=42) (actual time=1.176..1.210 rows=50 loops=1)
                    Buffers: shared hit=21
                    ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=1.175..1.190 rows=50 loops=1)
                          Buffers: shared hit=21
                    ->  Subquery Scan on fuzzy  (cost=275.21..275.83 rows=50 width=39) (actual time=0.014..0.015 rows=0 loops=1)
                          ->  Limit  (cost=275.21..275.33 rows=50 width=39) (actual time=0.013..0.014 rows=0 loops=1)
                                InitPlan 2
                                  ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.008..0.008 rows=1 loops=1)
                                        ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.003 rows=50 loops=1)
                                ->  Sort  (cost=274.07..274.20 rows=50 width=39) (actual time=0.013..0.014 rows=0 loops=1)
                                      Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'go'::text) ELSE GREATEST(similarity(search_terms.name, 'go'::text), similarity(search_terms.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                      Sort Method: quicksort  Memory: 25kB
                                      ->  GroupAggregate  (cost=269.41..272.66 rows=50 width=39) (actual time=0.011..0.012 rows=0 loops=1)
                                            Group Key: search_terms.package_id, search_terms.name
                                            ->  Sort  (cost=269.41..269.54 rows=50 width=68) (actual time=0.010..0.011 rows=0 loops=1)
                                                  Sort Key: search_terms.package_id, search_terms.name
                                                  Sort Method: quicksort  Memory: 25kB
                                                  ->  Result  (cost=86.24..268.00 rows=50 width=68) (actual time=0.009..0.009 rows=0 loops=1)
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
Planning Time: 0.912 ms
Execution Time: 1.646 ms
```

### batched fetch, latest — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 3.747 ms

```
Limit  (cost=8524.82..8528.13 rows=50 width=1377) (actual time=3.598..3.651 rows=50 loops=1)
  Buffers: shared hit=4106
  ->  Unique  (cost=8524.82..8528.13 rows=50 width=1377) (actual time=3.597..3.646 rows=50 loops=1)
        Buffers: shared hit=4106
        ->  Sort  (cost=8524.82..8526.48 rows=662 width=1377) (actual time=3.596..3.607 rows=174 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Sort Method: quicksort  Memory: 197kB
              Buffers: shared hit=4106
              ->  Hash Join  (cost=255.52..8493.80 rows=662 width=1377) (actual time=1.282..3.382 rows=177 loops=1)
                    Hash Cond: (variants.commit_seq = commit_hash.seq)
                    Buffers: shared hit=4106
                    ->  Nested Loop  (cost=160.63..8397.18 rows=662 width=1322) (actual time=0.487..2.542 rows=177 loops=1)
                          Buffers: shared hit=4074
                          ->  Nested Loop  (cost=160.21..8059.60 rows=662 width=339) (actual time=0.477..2.217 rows=177 loops=1)
                                Join Filter: (variants.version_id = v.id)
                                Buffers: shared hit=3366
                                ->  Nested Loop  (cost=159.78..7987.73 rows=50 width=53) (actual time=0.470..2.018 rows=50 loops=1)
                                      Buffers: shared hit=3086
                                      ->  Nested Loop  (cost=159.36..7965.50 rows=50 width=30) (actual time=0.457..1.912 rows=50 loops=1)
                                            Buffers: shared hit=2886
                                            ->  Nested Loop  (cost=158.92..7947.53 rows=50 width=12) (actual time=0.445..1.765 rows=50 loops=1)
                                                  Buffers: shared hit=2686
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.009..0.097 rows=50 loops=1)
                                                  ->  Limit  (cost=158.92..158.92 rows=1 width=20) (actual time=0.033..0.033 rows=1 loops=50)
                                                        Buffers: shared hit=2686
                                                        ->  Sort  (cost=158.92..159.00 rows=32 width=20) (actual time=0.033..0.033 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, v.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=2686
                                                              ->  Index Scan using versions_semver_idx on versions v  (cost=0.43..158.76 rows=32 width=20) (actual time=0.006..0.029 rows=12 loops=50)
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
                    ->  Hash  (cost=59.95..59.95 rows=2795 width=53) (actual time=0.784..0.784 rows=2795 loops=1)
                          Buckets: 4096  Batches: 1  Memory Usage: 284kB
                          Buffers: shared hit=32
                          ->  Seq Scan on commits commit_hash  (cost=0.00..59.95 rows=2795 width=53) (actual time=0.017..0.321 rows=2795 loops=1)
                                Buffers: shared hit=32
Planning:
  Buffers: shared hit=90
Planning Time: 13.883 ms
Execution Time: 3.747 ms
```

### batched fetch, all versions — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 12.991 ms

```
Limit  (cost=115.50..1465.75 rows=1000 width=1392) (actual time=3.795..12.786 rows=632 loops=1)
  Buffers: shared hit=13108
  ->  Unique  (cost=115.50..5762.22 rows=4182 width=1392) (actual time=3.794..12.727 rows=632 loops=1)
        Buffers: shared hit=13108
        ->  Incremental Sort  (cost=115.50..5730.86 rows=4182 width=1392) (actual time=3.793..12.157 rows=2298 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 19  Sort Method: quicksort  Average Memory: 69kB  Peak Memory: 75kB
              Pre-sorted Groups: 28  Sort Method: quicksort  Average Memory: 558kB  Peak Memory: 558kB
              Buffers: shared hit=13108
              ->  Nested Loop  (cost=1.99..5544.05 rows=4182 width=1392) (actual time=0.109..8.335 rows=2298 loops=1)
                    Buffers: shared hit=13108
                    ->  Nested Loop  (cost=1.70..4883.55 rows=4182 width=1337) (actual time=0.049..6.854 rows=2298 loops=1)
                          Buffers: shared hit=12415
                          ->  Nested Loop  (cost=1.28..2750.99 rows=4182 width=354) (actual time=0.042..3.119 rows=2298 loops=1)
                                Buffers: shared hit=3223
                                ->  Nested Loop  (cost=0.85..506.11 rows=1598 width=64) (actual time=0.035..0.621 rows=632 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=438
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.022..0.156 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.016 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.35 rows=32 width=33) (actual time=0.003..0.007 rows=13 loops=50)
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
Planning Time: 10.533 ms
Execution Time: 12.991 ms
```

### ranked terms — q=python

Parameters: `["python","python"]` — Execution Time: 401.526 ms

```
Limit  (cost=20929.13..20929.25 rows=50 width=44) (actual time=400.641..400.738 rows=50 loops=1)
  Buffers: shared hit=2961, temp read=482 written=483
  CTE prefix
    ->  Limit  (cost=20542.93..20543.05 rows=50 width=39) (actual time=400.526..400.621 rows=50 loops=1)
          Buffers: shared hit=2961, temp read=482 written=483
          ->  Sort  (cost=20542.93..20722.10 rows=71670 width=39) (actual time=400.526..400.616 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_1.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms_1.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms_1.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms_1.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_1.name = search_terms_1.attr_path) THEN similarity(search_terms_1.name, 'python'::text) ELSE GREATEST(similarity(search_terms_1.name, 'python'::text), similarity(search_terms_1.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms_1.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_1.name
                Sort Method: top-N heapsort  Memory: 30kB
                Buffers: shared hit=2961, temp read=482 written=483
                ->  Finalize GroupAggregate  (cost=17022.94..18162.10 rows=71670 width=39) (actual time=362.890..391.132 rows=69849 loops=1)
                      Group Key: search_terms_1.package_id, search_terms_1.name
                      Buffers: shared hit=2961, temp read=482 written=483
                      ->  Sort  (cost=17022.94..17128.56 rows=42246 width=39) (actual time=362.880..369.258 rows=69849 loops=1)
                            Sort Key: search_terms_1.package_id, search_terms_1.name
                            Sort Method: external merge  Disk: 3856kB
                            Buffers: shared hit=2961, temp read=482 written=483
                            ->  Gather  (cost=9130.01..13777.07 rows=42246 width=39) (actual time=312.900..342.863 rows=69849 loops=1)
                                  Workers Planned: 1
                                  Workers Launched: 1
                                  Buffers: shared hit=2961
                                  ->  Partial HashAggregate  (cost=8130.01..8552.47 rows=42246 width=39) (actual time=307.326..315.596 rows=34924 loops=2)
                                        Group Key: search_terms_1.package_id, search_terms_1.name
                                        Batches: 1  Memory Usage: 5137kB
                                        Buffers: shared hit=2961
                                        Worker 0:  Batches: 1  Memory Usage: 5137kB
                                        ->  Parallel Seq Scan on search_terms search_terms_1  (cost=0.00..5912.09 rows=42246 width=68) (actual time=39.299..80.248 rows=35006 loops=2)
                                              Filter: ((lower(name) ~~ 'python%'::text) OR (lower(attr_path) ~~ 'python%'::text))
                                              Rows Removed by Filter: 90415
                                              Buffers: shared hit=2961
  ->  Sort  (cost=386.08..386.29 rows=86 width=44) (actual time=400.640..400.645 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=2961, temp read=482 written=483
        ->  GroupAggregate  (cost=381.59..383.31 rows=86 width=44) (actual time=400.590..400.613 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=2961, temp read=482 written=483
              ->  Sort  (cost=381.59..381.81 rows=86 width=42) (actual time=400.586..400.592 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=2961, temp read=482 written=483
                    ->  Append  (cost=0.00..378.83 rows=86 width=42) (actual time=400.531..400.579 rows=50 loops=1)
                          Buffers: shared hit=2961, temp read=482 written=483
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=400.530..400.545 rows=50 loops=1)
                                Buffers: shared hit=2961, temp read=482 written=483
                          ->  Subquery Scan on fuzzy  (cost=376.95..377.40 rows=36 width=39) (actual time=0.024..0.026 rows=0 loops=1)
                                ->  Limit  (cost=376.95..377.04 rows=36 width=39) (actual time=0.023..0.025 rows=0 loops=1)
                                      InitPlan 2
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.008..0.008 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.004 rows=50 loops=1)
                                      ->  Sort  (cost=375.82..375.91 rows=36 width=39) (actual time=0.021..0.022 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'python'::text) ELSE GREATEST(similarity(search_terms.name, 'python'::text), similarity(search_terms.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            ->  GroupAggregate  (cost=372.54..374.88 rows=36 width=39) (actual time=0.014..0.015 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  ->  Sort  (cost=372.54..372.63 rows=36 width=68) (actual time=0.013..0.014 rows=0 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        ->  Result  (cost=189.86..371.61 rows=36 width=68) (actual time=0.010..0.011 rows=0 loops=1)
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
Planning Time: 0.935 ms
Execution Time: 401.526 ms
```

### batched fetch, latest — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 3.166 ms

```
Limit  (cost=8524.82..8528.13 rows=50 width=1377) (actual time=3.018..3.058 rows=49 loops=1)
  Buffers: shared hit=3413
  ->  Unique  (cost=8524.82..8528.13 rows=50 width=1377) (actual time=3.017..3.053 rows=49 loops=1)
        Buffers: shared hit=3413
        ->  Sort  (cost=8524.82..8526.48 rows=662 width=1377) (actual time=3.016..3.024 rows=125 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Sort Method: quicksort  Memory: 161kB
              Buffers: shared hit=3413
              ->  Hash Join  (cost=255.52..8493.80 rows=662 width=1377) (actual time=1.086..2.930 rows=125 loops=1)
                    Hash Cond: (variants.commit_seq = commit_hash.seq)
                    Buffers: shared hit=3413
                    ->  Nested Loop  (cost=160.63..8397.18 rows=662 width=1322) (actual time=0.404..2.214 rows=125 loops=1)
                          Buffers: shared hit=3381
                          ->  Nested Loop  (cost=160.21..8059.60 rows=662 width=339) (actual time=0.399..1.972 rows=125 loops=1)
                                Join Filter: (variants.version_id = v.id)
                                Buffers: shared hit=2881
                                ->  Nested Loop  (cost=159.78..7987.73 rows=50 width=53) (actual time=0.395..1.831 rows=49 loops=1)
                                      Buffers: shared hit=2666
                                      ->  Nested Loop  (cost=159.36..7965.50 rows=50 width=30) (actual time=0.389..1.698 rows=49 loops=1)
                                            Buffers: shared hit=2470
                                            ->  Nested Loop  (cost=158.92..7947.53 rows=50 width=12) (actual time=0.379..1.549 rows=49 loops=1)
                                                  Buffers: shared hit=2274
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.007..0.012 rows=50 loops=1)
                                                  ->  Limit  (cost=158.92..158.92 rows=1 width=20) (actual time=0.030..0.030 rows=1 loops=50)
                                                        Buffers: shared hit=2274
                                                        ->  Sort  (cost=158.92..159.00 rows=32 width=20) (actual time=0.030..0.030 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, v.sort_key DESC
                                                              Sort Method: quicksort  Memory: 25kB
                                                              Buffers: shared hit=2274
                                                              ->  Index Scan using versions_semver_idx on versions v  (cost=0.43..158.76 rows=32 width=20) (actual time=0.006..0.027 rows=10 loops=50)
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
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=49)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=196
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.27 rows=13 width=298) (actual time=0.001..0.002 rows=3 loops=49)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=215
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=125)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=500
                    ->  Hash  (cost=59.95..59.95 rows=2795 width=53) (actual time=0.678..0.678 rows=2795 loops=1)
                          Buckets: 4096  Batches: 1  Memory Usage: 284kB
                          Buffers: shared hit=32
                          ->  Seq Scan on commits commit_hash  (cost=0.00..59.95 rows=2795 width=53) (actual time=0.013..0.308 rows=2795 loops=1)
                                Buffers: shared hit=32
Planning:
  Buffers: shared hit=90
Planning Time: 13.658 ms
Execution Time: 3.166 ms
```

### batched fetch, all versions — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 11.368 ms

```
Limit  (cost=115.50..1465.75 rows=1000 width=1392) (actual time=2.988..11.174 rows=634 loops=1)
  Buffers: shared hit=12204
  ->  Unique  (cost=115.50..5762.22 rows=4182 width=1392) (actual time=2.987..11.121 rows=634 loops=1)
        Buffers: shared hit=12204
        ->  Incremental Sort  (cost=115.50..5730.86 rows=4182 width=1392) (actual time=2.986..10.577 rows=2158 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 19  Sort Method: quicksort  Average Memory: 126kB  Peak Memory: 126kB
              Pre-sorted Groups: 13  Sort Method: quicksort  Average Memory: 873kB  Peak Memory: 873kB
              Buffers: shared hit=12204
              ->  Nested Loop  (cost=1.99..5544.05 rows=4182 width=1392) (actual time=0.059..7.372 rows=2158 loops=1)
                    Buffers: shared hit=12204
                    ->  Nested Loop  (cost=1.70..4883.55 rows=4182 width=1337) (actual time=0.049..6.186 rows=2158 loops=1)
                          Buffers: shared hit=11694
                          ->  Nested Loop  (cost=1.28..2750.99 rows=4182 width=354) (actual time=0.043..2.839 rows=2158 loops=1)
                                Buffers: shared hit=3062
                                ->  Nested Loop  (cost=0.85..506.11 rows=1598 width=64) (actual time=0.036..0.638 rows=634 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=418
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.023..0.187 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.014 rows=50 loops=1)
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
Planning Time: 10.096 ms
Execution Time: 11.368 ms
```

### ranked terms — q=hello

Parameters: `["hello","hello"]` — Execution Time: 85.961 ms

```
Limit  (cost=2862.03..2862.16 rows=50 width=44) (actual time=85.825..85.834 rows=14 loops=1)
  Buffers: shared hit=1100
  CTE prefix
    ->  Limit  (cost=2501.79..2501.91 rows=50 width=39) (actual time=0.058..0.062 rows=5 loops=1)
          Buffers: shared hit=7
          ->  Sort  (cost=2501.79..2504.99 rows=1279 width=39) (actual time=0.058..0.061 rows=5 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_1.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms_1.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms_1.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms_1.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_1.name = search_terms_1.attr_path) THEN similarity(search_terms_1.name, 'hello'::text) ELSE GREATEST(similarity(search_terms_1.name, 'hello'::text), similarity(search_terms_1.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms_1.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_1.name
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=7
                ->  HashAggregate  (cost=2446.51..2459.30 rows=1279 width=39) (actual time=0.050..0.056 rows=5 loops=1)
                      Group Key: search_terms_1.package_id, search_terms_1.name
                      Batches: 1  Memory Usage: 73kB
                      Buffers: shared hit=7
                      ->  Bitmap Heap Scan on search_terms search_terms_1  (cost=50.03..2379.36 rows=1279 width=68) (actual time=0.027..0.031 rows=5 loops=1)
                            Recheck Cond: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                            Filter: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                            Heap Blocks: exact=1
                            Buffers: shared hit=7
                            ->  BitmapOr  (cost=50.03..50.03 rows=1254 width=0) (actual time=0.019..0.020 rows=0 loops=1)
                                  Buffers: shared hit=6
                                  ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.012..0.013 rows=5 loops=1)
                                        Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                        Buffers: shared hit=3
                                  ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..44.96 rows=1254 width=0) (actual time=0.006..0.006 rows=5 loops=1)
                                        Index Cond: ((lower(attr_path) >= 'hello'::text) AND (lower(attr_path) < 'hellp'::text))
                                        Buffers: shared hit=3
  ->  Sort  (cost=360.12..360.37 rows=100 width=44) (actual time=85.824..85.828 rows=14 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=1100
        ->  HashAggregate  (cost=355.80..356.80 rows=100 width=44) (actual time=85.814..85.821 rows=14 loops=1)
              Group Key: prefix.package_id
              Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=1100
              ->  Append  (cost=0.00..355.05 rows=100 width=42) (actual time=0.061..85.809 rows=14 loops=1)
                    Buffers: shared hit=1100
                    ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=0.060..0.062 rows=5 loops=1)
                          Buffers: shared hit=7
                    ->  Subquery Scan on fuzzy  (cost=352.92..353.55 rows=50 width=39) (actual time=85.738..85.744 rows=9 loops=1)
                          Buffers: shared hit=1093
                          ->  Limit  (cost=352.92..353.05 rows=50 width=39) (actual time=85.737..85.741 rows=9 loops=1)
                                Buffers: shared hit=1093
                                InitPlan 2
                                  ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.002..0.003 rows=1 loops=1)
                                        ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.001 rows=5 loops=1)
                                ->  Sort  (cost=351.79..351.91 rows=50 width=39) (actual time=85.737..85.739 rows=9 loops=1)
                                      Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'hello'::text) ELSE GREATEST(similarity(search_terms.name, 'hello'::text), similarity(search_terms.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                      Sort Method: quicksort  Memory: 25kB
                                      Buffers: shared hit=1093
                                      ->  GroupAggregate  (cost=347.13..350.38 rows=50 width=39) (actual time=85.714..85.732 rows=9 loops=1)
                                            Group Key: search_terms.package_id, search_terms.name
                                            Buffers: shared hit=1093
                                            ->  Sort  (cost=347.13..347.25 rows=50 width=68) (actual time=85.699..85.701 rows=9 loops=1)
                                                  Sort Key: search_terms.package_id, search_terms.name
                                                  Sort Method: quicksort  Memory: 25kB
                                                  Buffers: shared hit=1093
                                                  ->  Result  (cost=163.96..345.72 rows=50 width=68) (actual time=38.682..85.689 rows=9 loops=1)
                                                        One-Time Filter: ((InitPlan 2).col1 < 50)
                                                        Buffers: shared hit=1093
                                                        ->  Bitmap Heap Scan on search_terms  (cost=163.96..345.72 rows=50 width=68) (actual time=38.677..85.680 rows=9 loops=1)
                                                              Recheck Cond: ((name % 'hello'::text) OR (attr_path % 'hello'::text))
                                                              Rows Removed by Index Recheck: 17510
                                                              Filter: ((lower(name) !~~ 'hello%'::text) AND (lower(attr_path) !~~ 'hello%'::text))
                                                              Rows Removed by Filter: 5
                                                              Heap Blocks: exact=1029
                                                              Buffers: shared hit=1093
                                                              ->  BitmapOr  (cost=163.96..163.96 rows=50 width=0) (actual time=3.903..3.904 rows=0 loops=1)
                                                                    Buffers: shared hit=64
                                                                    ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..81.97 rows=25 width=0) (actual time=1.998..1.998 rows=17524 loops=1)
                                                                          Index Cond: (name % 'hello'::text)
                                                                          Buffers: shared hit=32
                                                                    ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..81.97 rows=25 width=0) (actual time=1.904..1.904 rows=17524 loops=1)
                                                                          Index Cond: (attr_path % 'hello'::text)
                                                                          Buffers: shared hit=32
Planning:
  Buffers: shared hit=6
Planning Time: 0.939 ms
Execution Time: 85.961 ms
```

### batched fetch, latest — q=hello (14 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,51341,242138,42681"]` — Execution Time: 0.727 ms

```
Limit  (cost=322.35..2424.17 rows=14 width=1377) (actual time=0.497..0.643 rows=14 loops=1)
  Buffers: shared hit=865
  ->  Unique  (cost=322.35..2424.17 rows=14 width=1377) (actual time=0.496..0.641 rows=14 loops=1)
        Buffers: shared hit=865
        ->  Incremental Sort  (cost=322.35..2423.71 rows=185 width=1377) (actual time=0.495..0.630 rows=46 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 65kB  Peak Memory: 65kB
              Buffers: shared hit=865
              ->  Nested Loop  (cost=160.91..2417.68 rows=185 width=1377) (actual time=0.081..0.584 rows=46 loops=1)
                    Buffers: shared hit=865
                    ->  Nested Loop  (cost=160.63..2362.63 rows=185 width=1322) (actual time=0.076..0.518 rows=46 loops=1)
                          Buffers: shared hit=727
                          ->  Nested Loop  (cost=160.21..2268.29 rows=185 width=339) (actual time=0.069..0.424 rows=46 loops=1)
                                Join Filter: (variants.version_id = v.id)
                                Buffers: shared hit=543
                                ->  Nested Loop  (cost=159.78..2248.17 rows=14 width=53) (actual time=0.066..0.368 rows=14 loops=1)
                                      Buffers: shared hit=468
                                      ->  Nested Loop  (cost=159.36..2241.94 rows=14 width=30) (actual time=0.060..0.331 rows=14 loops=1)
                                            Buffers: shared hit=412
                                            ->  Nested Loop  (cost=158.92..2225.31 rows=14 width=12) (actual time=0.052..0.283 rows=14 loops=1)
                                                  Buffers: shared hit=356
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.14 rows=14 width=12) (actual time=0.007..0.008 rows=14 loops=1)
                                                  ->  Limit  (cost=158.92..158.92 rows=1 width=20) (actual time=0.019..0.019 rows=1 loops=14)
                                                        Buffers: shared hit=356
                                                        ->  Sort  (cost=158.92..159.00 rows=32 width=20) (actual time=0.019..0.019 rows=1 loops=14)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, v.sort_key DESC
                                                              Sort Method: quicksort  Memory: 25kB
                                                              Buffers: shared hit=356
                                                              ->  Index Scan using versions_semver_idx on versions v  (cost=0.43..158.76 rows=32 width=20) (actual time=0.007..0.016 rows=5 loops=14)
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
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=14)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=56
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.27 rows=13 width=298) (actual time=0.001..0.003 rows=3 loops=14)
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
Planning Time: 13.514 ms
Execution Time: 0.727 ms
```

### batched fetch, all versions — q=hello (14 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,51341,242138,42681"]` — Execution Time: 1.634 ms

```
Limit  (cost=127.27..1537.20 rows=1000 width=1392) (actual time=0.309..1.553 rows=75 loops=1)
  Buffers: shared hit=1983
  ->  Unique  (cost=127.27..1779.71 rows=1172 width=1392) (actual time=0.308..1.546 rows=75 loops=1)
        Buffers: shared hit=1983
        ->  Incremental Sort  (cost=127.27..1770.92 rows=1172 width=1392) (actual time=0.307..1.493 rows=216 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 5  Sort Method: quicksort  Average Memory: 88kB  Peak Memory: 88kB
              Pre-sorted Groups: 3  Sort Method: quicksort  Average Memory: 50kB  Peak Memory: 54kB
              Buffers: shared hit=1983
              ->  Nested Loop  (cost=1.98..1718.55 rows=1172 width=1392) (actual time=0.049..1.078 rows=216 loops=1)
                    Buffers: shared hit=1983
                    ->  Nested Loop  (cost=1.70..1369.83 rows=1172 width=1337) (actual time=0.042..0.769 rows=216 loops=1)
                          Buffers: shared hit=1335
                          ->  Nested Loop  (cost=1.28..772.19 rows=1172 width=354) (actual time=0.036..0.408 rows=216 loops=1)
                                Buffers: shared hit=471
                                ->  Nested Loop  (cost=0.85..142.83 rows=448 width=64) (actual time=0.029..0.128 rows=75 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=112
                                      ->  Nested Loop  (cost=0.42..118.27 rows=14 width=43) (actual time=0.021..0.053 rows=14 loops=1)
                                            Buffers: shared hit=56
                                            ->  Function Scan on unnest hits  (cost=0.00..0.14 rows=14 width=12) (actual time=0.006..0.008 rows=14 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=14)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=56
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.35 rows=32 width=33) (actual time=0.003..0.004 rows=5 loops=14)
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
Planning Time: 10.740 ms
Execution Time: 1.634 ms
```

## Name lookups (/v2/resolve, /v1/resolve, /v2/pkg, /v1/pkg)

### pick latest version — name=go

Parameters: `["go"]` — Execution Time: 5.364 ms

```
Limit  (cost=1312.81..1312.81 rows=1 width=19) (actual time=5.275..5.278 rows=1 loops=1)
  Buffers: shared hit=9929
  ->  Sort  (cost=1312.81..1313.11 rows=121 width=19) (actual time=5.274..5.276 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=9929
        ->  Nested Loop  (cost=162.43..1312.20 rows=121 width=19) (actual time=1.122..5.174 rows=644 loops=1)
              Buffers: shared hit=9929
              ->  Nested Loop  (cost=162.01..1258.39 rows=121 width=23) (actual time=1.115..3.771 rows=644 loops=1)
                    Buffers: shared hit=6708
                    ->  Nested Loop  (cost=161.58..1201.43 rows=122 width=4) (actual time=1.110..2.604 rows=719 loops=1)
                          Buffers: shared hit=3832
                          ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=1.104..1.295 rows=719 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=956
                                ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.031..0.921 rows=976 loops=1)
                                      Buffers: shared hit=956
                                      ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.031..0.769 rows=719 loops=1)
                                            Buffers: shared hit=895
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.024..0.108 rows=191 loops=1)
                                                  Buffers: shared hit=23
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.013 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'go'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.009..0.062 rows=191 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=19
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (actual time=0.002..0.003 rows=4 loops=191)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=872
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.007..0.075 rows=257 loops=1)
                                            Index Cond: (attr_path = 'go'::text)
                                            Buffers: shared hit=61
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=719)
                                Index Cond: (id = va.id)
                                Filter: (NOT broken)
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
Planning:
  Buffers: shared hit=92
Planning Time: 15.019 ms
Execution Time: 5.364 ms
```

### pick latest version — name=python

Parameters: `["python"]` — Execution Time: 4.126 ms

```
Limit  (cost=1312.81..1312.81 rows=1 width=19) (actual time=4.052..4.055 rows=1 loops=1)
  Buffers: shared hit=7943
  ->  Sort  (cost=1312.81..1313.11 rows=121 width=19) (actual time=4.051..4.054 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=7943
        ->  Nested Loop  (cost=162.43..1312.20 rows=121 width=19) (actual time=0.814..3.981 rows=409 loops=1)
              Buffers: shared hit=7943
              ->  Nested Loop  (cost=162.01..1258.39 rows=121 width=23) (actual time=0.806..3.123 rows=409 loops=1)
                    Buffers: shared hit=5897
                    ->  Nested Loop  (cost=161.58..1201.43 rows=122 width=4) (actual time=0.800..2.097 rows=642 loops=1)
                          Buffers: shared hit=3329
                          ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=0.794..0.879 rows=642 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=761
                                ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.030..0.658 rows=645 loops=1)
                                      Buffers: shared hit=761
                                      ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.030..0.599 rows=642 loops=1)
                                            Buffers: shared hit=756
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.023..0.088 rows=176 loops=1)
                                                  Buffers: shared hit=22
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.012 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'python'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.008..0.052 rows=176 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=18
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (actual time=0.001..0.002 rows=4 loops=176)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=734
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.007..0.008 rows=3 loops=1)
                                            Index Cond: (attr_path = 'python'::text)
                                            Buffers: shared hit=5
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=642)
                                Index Cond: (id = va.id)
                                Filter: (NOT broken)
                                Buffers: shared hit=2568
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=642)
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
Planning Time: 15.418 ms
Execution Time: 4.126 ms
```

### pick latest version — name=python311

Parameters: `["python311"]` — Execution Time: 0.579 ms

```
Limit  (cost=1312.81..1312.81 rows=1 width=19) (actual time=0.511..0.512 rows=1 loops=1)
  Buffers: shared hit=967
  ->  Sort  (cost=1312.81..1313.11 rows=121 width=19) (actual time=0.509..0.511 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=967
        ->  Nested Loop  (cost=162.43..1312.20 rows=121 width=19) (actual time=0.100..0.497 rows=51 loops=1)
              Buffers: shared hit=967
              ->  Nested Loop  (cost=162.01..1258.39 rows=121 width=23) (actual time=0.090..0.382 rows=51 loops=1)
                    Buffers: shared hit=711
                    ->  Nested Loop  (cost=161.58..1201.43 rows=122 width=4) (actual time=0.083..0.240 rows=87 loops=1)
                          Buffers: shared hit=363
                          ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=0.075..0.087 rows=87 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=15
                                ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.020..0.058 rows=87 loops=1)
                                      Buffers: shared hit=15
                                      ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.011..0.011 rows=0 loops=1)
                                            Buffers: shared hit=3
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.010..0.011 rows=0 loops=1)
                                                  Buffers: shared hit=3
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.010..0.010 rows=0 loops=1)
                                                        Index Cond: (lower(name) = 'python311'::text)
                                                        Buffers: shared hit=3
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (never executed)
                                                        Index Cond: (package_id = p.id)
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (never executed)
                                                  Index Cond: (version_id = ve.id)
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.009..0.039 rows=87 loops=1)
                                            Index Cond: (attr_path = 'python311'::text)
                                            Buffers: shared hit=12
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.001..0.001 rows=1 loops=87)
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
Planning Time: 14.433 ms
Execution Time: 0.579 ms
```

### pick latest version — name=hello

Parameters: `["hello"]` — Execution Time: 0.266 ms

```
Limit  (cost=1312.81..1312.81 rows=1 width=19) (actual time=0.201..0.203 rows=1 loops=1)
  Buffers: shared hit=288
  ->  Sort  (cost=1312.81..1313.11 rows=121 width=19) (actual time=0.200..0.201 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=288
        ->  Nested Loop  (cost=162.43..1312.20 rows=121 width=19) (actual time=0.089..0.192 rows=19 loops=1)
              Buffers: shared hit=288
              ->  Nested Loop  (cost=162.01..1258.39 rows=121 width=23) (actual time=0.083..0.147 rows=19 loops=1)
                    Buffers: shared hit=192
                    ->  Nested Loop  (cost=161.58..1201.43 rows=122 width=4) (actual time=0.079..0.113 rows=19 loops=1)
                          Buffers: shared hit=116
                          ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=0.073..0.077 rows=19 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=40
                                ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.027..0.062 rows=38 loops=1)
                                      Buffers: shared hit=40
                                      ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.026..0.047 rows=19 loops=1)
                                            Buffers: shared hit=33
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.020..0.022 rows=5 loops=1)
                                                  Buffers: shared hit=8
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.010..0.011 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'hello'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.007..0.008 rows=5 loops=1)
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
Planning Time: 14.924 ms
Execution Time: 0.266 ms
```

### every version — name=go

Parameters: `["go"]` — Execution Time: 8.402 ms

```
Limit  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=8.067..8.169 rows=719 loops=1)
  Buffers: shared hit=14617
  ->  Sort  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=8.066..8.112 rows=719 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 737kB
        Buffers: shared hit=14617
        ->  Nested Loop  (cost=163.13..1412.85 rows=123 width=1384) (actual time=1.068..7.361 rows=719 loops=1)
              Buffers: shared hit=14617
              ->  Nested Loop  (cost=162.85..1376.25 rows=123 width=1329) (actual time=1.063..6.319 rows=719 loops=1)
                    Buffers: shared hit=12460
                    ->  Nested Loop  (cost=162.43..1313.53 rows=123 width=346) (actual time=1.057..5.115 rows=719 loops=1)
                          Buffers: shared hit=9584
                          ->  Nested Loop  (cost=162.01..1258.83 rows=123 width=323) (actual time=1.052..3.936 rows=719 loops=1)
                                Buffers: shared hit=6708
                                ->  Nested Loop  (cost=161.58..1201.43 rows=123 width=298) (actual time=1.047..2.592 rows=719 loops=1)
                                      Buffers: shared hit=3832
                                      ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=1.036..1.151 rows=719 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=956
                                            ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.032..0.865 rows=976 loops=1)
                                                  Buffers: shared hit=956
                                                  ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.031..0.708 rows=719 loops=1)
                                                        Buffers: shared hit=895
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.025..0.094 rows=191 loops=1)
                                                              Buffers: shared hit=23
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.014 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'go'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.010..0.056 rows=191 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=19
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (actual time=0.002..0.003 rows=4 loops=191)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=872
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.008..0.077 rows=257 loops=1)
                                                        Index Cond: (attr_path = 'go'::text)
                                                        Buffers: shared hit=61
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.002..0.002 rows=1 loops=719)
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
  Buffers: shared hit=114
Planning Time: 18.717 ms
Execution Time: 8.402 ms
```

### every version — name=python

Parameters: `["python"]` — Execution Time: 7.394 ms

```
Limit  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=7.024..7.123 rows=642 loops=1)
  Buffers: shared hit=12959
  ->  Sort  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=7.022..7.074 rows=642 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 1282kB
        Buffers: shared hit=12959
        ->  Nested Loop  (cost=163.13..1412.85 rows=123 width=1384) (actual time=0.810..6.328 rows=642 loops=1)
              Buffers: shared hit=12959
              ->  Nested Loop  (cost=162.85..1376.25 rows=123 width=1329) (actual time=0.805..5.398 rows=642 loops=1)
                    Buffers: shared hit=11033
                    ->  Nested Loop  (cost=162.43..1313.53 rows=123 width=346) (actual time=0.797..4.318 rows=642 loops=1)
                          Buffers: shared hit=8465
                          ->  Nested Loop  (cost=162.01..1258.83 rows=123 width=323) (actual time=0.792..3.312 rows=642 loops=1)
                                Buffers: shared hit=5897
                                ->  Nested Loop  (cost=161.58..1201.43 rows=123 width=298) (actual time=0.788..2.213 rows=642 loops=1)
                                      Buffers: shared hit=3329
                                      ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=0.781..0.885 rows=642 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=761
                                            ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.030..0.654 rows=645 loops=1)
                                                  Buffers: shared hit=761
                                                  ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.030..0.596 rows=642 loops=1)
                                                        Buffers: shared hit=756
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.024..0.089 rows=176 loops=1)
                                                              Buffers: shared hit=22
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.014..0.014 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'python'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.007..0.051 rows=176 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=18
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (actual time=0.002..0.002 rows=4 loops=176)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=734
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.008..0.009 rows=3 loops=1)
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
Planning Time: 17.328 ms
Execution Time: 7.394 ms
```

### every version — name=python311

Parameters: `["python311"]` — Execution Time: 1.038 ms

```
Limit  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=0.912..0.925 rows=87 loops=1)
  Buffers: shared hit=1668
  ->  Sort  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=0.911..0.917 rows=87 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 199kB
        Buffers: shared hit=1668
        ->  Nested Loop  (cost=163.13..1412.85 rows=123 width=1384) (actual time=0.107..0.818 rows=87 loops=1)
              Buffers: shared hit=1668
              ->  Nested Loop  (cost=162.85..1376.25 rows=123 width=1329) (actual time=0.102..0.684 rows=87 loops=1)
                    Buffers: shared hit=1407
                    ->  Nested Loop  (cost=162.43..1313.53 rows=123 width=346) (actual time=0.096..0.537 rows=87 loops=1)
                          Buffers: shared hit=1059
                          ->  Nested Loop  (cost=162.01..1258.83 rows=123 width=323) (actual time=0.091..0.402 rows=87 loops=1)
                                Buffers: shared hit=711
                                ->  Nested Loop  (cost=161.58..1201.43 rows=123 width=298) (actual time=0.084..0.255 rows=87 loops=1)
                                      Buffers: shared hit=363
                                      ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=0.076..0.089 rows=87 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=15
                                            ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.021..0.060 rows=87 loops=1)
                                                  Buffers: shared hit=15
                                                  ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.011..0.011 rows=0 loops=1)
                                                        Buffers: shared hit=3
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.011..0.011 rows=0 loops=1)
                                                              Buffers: shared hit=3
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.010..0.010 rows=0 loops=1)
                                                                    Index Cond: (lower(name) = 'python311'::text)
                                                                    Buffers: shared hit=3
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (never executed)
                                                                    Index Cond: (package_id = p.id)
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (never executed)
                                                              Index Cond: (version_id = ve.id)
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.010..0.040 rows=87 loops=1)
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
Planning Time: 18.535 ms
Execution Time: 1.038 ms
```

### every version — name=hello

Parameters: `["hello"]` — Execution Time: 0.450 ms

```
Limit  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=0.357..0.362 rows=19 loops=1)
  Buffers: shared hit=401
  ->  Sort  (cost=1417.12..1417.43 rows=123 width=1384) (actual time=0.356..0.359 rows=19 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 63kB
        Buffers: shared hit=401
        ->  Nested Loop  (cost=163.13..1412.85 rows=123 width=1384) (actual time=0.100..0.330 rows=19 loops=1)
              Buffers: shared hit=401
              ->  Nested Loop  (cost=162.85..1376.25 rows=123 width=1329) (actual time=0.095..0.292 rows=19 loops=1)
                    Buffers: shared hit=344
                    ->  Nested Loop  (cost=162.43..1313.53 rows=123 width=346) (actual time=0.089..0.190 rows=19 loops=1)
                          Buffers: shared hit=268
                          ->  Nested Loop  (cost=162.01..1258.83 rows=123 width=323) (actual time=0.085..0.157 rows=19 loops=1)
                                Buffers: shared hit=192
                                ->  Nested Loop  (cost=161.58..1201.43 rows=123 width=298) (actual time=0.080..0.120 rows=19 loops=1)
                                      Buffers: shared hit=116
                                      ->  HashAggregate  (cost=161.15..162.38 rows=123 width=4) (actual time=0.075..0.080 rows=19 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=40
                                            ->  Append  (cost=1.28..160.85 rows=123 width=4) (actual time=0.029..0.065 rows=38 loops=1)
                                                  Buffers: shared hit=40
                                                  ->  Nested Loop  (cost=1.28..83.36 rows=16 width=4) (actual time=0.029..0.050 rows=19 loops=1)
                                                        Buffers: shared hit=33
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.023..0.026 rows=5 loops=1)
                                                              Buffers: shared hit=8
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.013 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'hello'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.007..0.009 rows=5 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=4
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.27 rows=13 width=8) (actual time=0.003..0.004 rows=4 loops=5)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=25
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..76.87 rows=107 width=4) (actual time=0.006..0.011 rows=19 loops=1)
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
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.005..0.005 rows=1 loops=19)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=76
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=19)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=57
Planning:
  Buffers: shared hit=114
Planning Time: 18.052 ms
Execution Time: 0.450 ms
```

