# Serving query plans

Recorded 2026-09-17 against `ep-calm-queen-auynflld.c-10.us-east-1.aws.neon.tech` with `node tools/explain-plans.mjs`.
Regenerate after changing apps/web/lib/search.ts or the indexes, and diff.
Warm plans (second run); see the script for what each statement is.

Table sizes: packages=248898, versions=1447425, variants=3783544, search_terms=249485

## What to look for

- **Name lookups** must be index walks: `packages_name_lower_idx` -> `versions` ->
  `variants_identity_key`, unioned with `variants_attr_path_idx`. A `Hash Join` or
  `Seq Scan on variants` here means the name/attr_path predicate has become an OR
  across two tables again (#26: ~4 s per lookup).
- **Batched fetch** must be one `Nested Loop` over `hits` with an index scan on
  `versions (package_id, ...)` per hit — never one query per hit.
- **Ranked terms** uses a `BitmapOr` of the trigram indexes for short phrases (`go`).
  Broad phrases (`python` matches every `python3Packages.*` attr_path by similarity)
  fall back to a parallel seq scan of `search_terms` and cost ~0.8 s; that is the
  remaining search latency, and a semantic question (whether attr_path similarity
  should apply to nested attributes at all), not a plan regression.

## Phrase search (/v2/search, /v1/search, /search)

### ranked terms — q=go

Parameters: `["go","go"]` — Execution Time: 105.526 ms

```
Limit  (cost=768.82..768.95 rows=50 width=39) (actual time=105.304..105.313 rows=50 loops=1)
  Buffers: shared hit=2160
  ->  Sort  (cost=768.82..769.02 rows=78 width=39) (actual time=105.302..105.307 rows=50 loops=1)
        Sort Key: (max((((CASE WHEN (lower(name) = 'go'::text) THEN 1000 WHEN (lower(attr_path) = 'go'::text) THEN 900 WHEN (lower(name) ~~ 'go%'::text) THEN 800 WHEN (lower(attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * GREATEST(similarity(name, 'go'::text), similarity(attr_path, 'go'::text)))) + (CASE WHEN (top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, name
        Sort Method: top-N heapsort  Memory: 31kB
        Buffers: shared hit=2160
        ->  GroupAggregate  (cost=761.69..766.37 rows=78 width=39) (actual time=103.833..105.197 rows=452 loops=1)
              Group Key: package_id, name
              Buffers: shared hit=2160
              ->  Sort  (cost=761.69..761.89 rows=78 width=68) (actual time=103.818..103.848 rows=467 loops=1)
                    Sort Key: package_id, name
                    Sort Method: quicksort  Memory: 51kB
                    Buffers: shared hit=2160
                    ->  Bitmap Heap Scan on search_terms  (cost=439.60..759.24 rows=78 width=68) (actual time=7.437..103.722 rows=467 loops=1)
                          Recheck Cond: ((name % 'go'::text) OR (attr_path % 'go'::text) OR (lower(name) ~~ 'go%'::text))
                          Rows Removed by Index Recheck: 20474
                          Filter: ((name % 'go'::text) OR (attr_path % 'go'::text) OR (lower(name) ~~ 'go%'::text))
                          Heap Blocks: exact=2038
                          Buffers: shared hit=2160
                          ->  BitmapOr  (cost=439.60..439.60 rows=92 width=0) (actual time=3.478..3.480 rows=0 loops=1)
                                Buffers: shared hit=122
                                ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..217.36 rows=26 width=0) (actual time=1.853..1.853 rows=22440 loops=1)
                                      Index Cond: (name % 'go'::text)
                                      Buffers: shared hit=58
                                ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..217.36 rows=26 width=0) (actual time=1.590..1.590 rows=22441 loops=1)
                                      Index Cond: (attr_path % 'go'::text)
                                      Buffers: shared hit=58
                                ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.82 rows=40 width=0) (actual time=0.034..0.035 rows=439 loops=1)
                                      Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                      Buffers: shared hit=6
Planning:
  Buffers: shared hit=4
Planning Time: 0.658 ms
Execution Time: 105.526 ms
```

### batched fetch, latest — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401,35408"]` — Execution Time: 1.452 ms

```
Limit  (cost=318.53..882.72 rows=50 width=1383) (actual time=0.927..1.357 rows=50 loops=1)
  Buffers: shared hit=1930
  ->  Incremental Sort  (cost=318.53..8352.55 rows=712 width=1383) (actual time=0.926..1.352 rows=50 loops=1)
        Sort Key: hits.ord, variants.system, variants.attr_path
        Presorted Key: hits.ord
        Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 62kB  Peak Memory: 62kB
        Buffers: shared hit=1930
        ->  Nested Loop  (cost=154.77..8329.01 rows=712 width=1383) (actual time=0.517..1.300 rows=54 loops=1)
              Buffers: shared hit=1930
              ->  Nested Loop  (cost=154.49..8117.15 rows=712 width=1328) (actual time=0.499..1.206 rows=54 loops=1)
                    Buffers: shared hit=1768
                    ->  Nested Loop  (cost=154.07..7754.65 rows=712 width=339) (actual time=0.491..1.089 rows=54 loops=1)
                          Join Filter: (variants.version_id = v.id)
                          Buffers: shared hit=1552
                          ->  Nested Loop  (cost=153.64..7680.97 rows=50 width=53) (actual time=0.486..1.025 rows=16 loops=1)
                                Buffers: shared hit=1483
                                ->  Nested Loop  (cost=153.22..7658.62 rows=50 width=30) (actual time=0.479..0.987 rows=16 loops=1)
                                      Buffers: shared hit=1419
                                      ->  Nested Loop  (cost=152.78..7640.65 rows=50 width=12) (actual time=0.469..0.925 rows=16 loops=1)
                                            Buffers: shared hit=1355
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.011 rows=16 loops=1)
                                            ->  Limit  (cost=152.78..152.78 rows=1 width=20) (actual time=0.057..0.057 rows=1 loops=16)
                                                  Buffers: shared hit=1355
                                                  ->  Sort  (cost=152.78..152.86 rows=33 width=20) (actual time=0.056..0.056 rows=1 loops=16)
                                                        Sort Key: (EXISTS(SubPlan 1)) DESC, v.sort_key DESC
                                                        Sort Method: top-N heapsort  Memory: 25kB
                                                        Buffers: shared hit=1355
                                                        ->  Index Scan using versions_semver_idx on versions v  (cost=0.43..152.62 rows=33 width=20) (actual time=0.008..0.051 rows=20 loops=16)
                                                              Index Cond: (package_id = hits.package_id)
                                                              Filter: (NOT prerelease)
                                                              Rows Removed by Filter: 1
                                                              Buffers: shared hit=1355
                                                              SubPlan 1
                                                                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..31.47 rows=14 width=0) (actual time=0.002..0.002 rows=1 loops=319)
                                                                      Index Cond: (version_id = v.id)
                                                                      Filter: (NOT broken)
                                                                      Buffers: shared hit=1276
                                      ->  Memoize  (cost=0.44..8.46 rows=1 width=18) (actual time=0.004..0.004 rows=1 loops=16)
                                            Cache Key: v.id
                                            Cache Mode: logical
                                            Hits: 0  Misses: 16  Evictions: 0  Overflows: 0  Memory Usage: 2kB
                                            Buffers: shared hit=64
                                            ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.003 rows=1 loops=16)
                                                  Index Cond: (id = v.id)
                                                  Buffers: shared hit=64
                                ->  Index Scan using packages_pkey on packages  (cost=0.42..0.45 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=16)
                                      Index Cond: (id = versions.package_id)
                                      Buffers: shared hit=64
                          ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.30 rows=14 width=298) (actual time=0.002..0.003 rows=3 loops=16)
                                Index Cond: (version_id = versions.id)
                                Buffers: shared hit=69
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.002..0.002 rows=1 loops=54)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=216
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=54)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=162
Planning:
  Buffers: shared hit=80
Planning Time: 5.300 ms
Execution Time: 1.452 ms
```

### batched fetch, all versions — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401,35408"]` — Execution Time: 5.446 ms

```
Limit  (cost=118.76..1454.74 rows=1000 width=1398) (actual time=3.328..5.209 rows=1000 loops=1)
  Buffers: shared hit=6003
  ->  Incremental Sort  (cost=118.76..5895.53 rows=4324 width=1398) (actual time=3.327..5.134 rows=1000 loops=1)
        Sort Key: hits.ord, versions.sort_key DESC, variants.system, variants.attr_path
        Presorted Key: hits.ord
        Full-sort Groups: 5  Sort Method: quicksort  Average Memory: 90kB  Peak Memory: 90kB
        Pre-sorted Groups: 8  Sort Method: quicksort  Average Memory: 737kB  Peak Memory: 737kB
        Buffers: shared hit=6003
        ->  Nested Loop  (cost=1.99..5701.37 rows=4324 width=1398) (actual time=0.053..3.768 rows=1047 loops=1)
              Buffers: shared hit=6003
              ->  Nested Loop  (cost=1.70..5066.18 rows=4324 width=1343) (actual time=0.044..3.044 rows=1047 loops=1)
                    Buffers: shared hit=5532
                    ->  Nested Loop  (cost=1.28..2864.66 rows=4324 width=354) (actual time=0.038..1.326 rows=1047 loops=1)
                          Buffers: shared hit=1344
                          ->  Nested Loop  (cost=0.85..512.47 rows=1635 width=64) (actual time=0.030..0.226 rows=278 loops=1)
                                Join Filter: (versions.package_id = hits.package_id)
                                Buffers: shared hit=122
                                ->  Nested Loop  (cost=0.42..422.38 rows=50 width=43) (actual time=0.019..0.051 rows=14 loops=1)
                                      Buffers: shared hit=56
                                      ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.007..0.010 rows=14 loops=1)
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=14)
                                            Index Cond: (id = hits.package_id)
                                            Buffers: shared hit=56
                                ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.39 rows=33 width=33) (actual time=0.003..0.009 rows=20 loops=14)
                                      Index Cond: (package_id = packages.id)
                                      Buffers: shared hit=66
                          ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.30 rows=14 width=298) (actual time=0.002..0.003 rows=4 loops=278)
                                Index Cond: (version_id = versions.id)
                                Buffers: shared hit=1222
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.001..0.001 rows=1 loops=1047)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=4188
              ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=1047)
                    Cache Key: variants.commit_seq
                    Cache Mode: logical
                    Hits: 890  Misses: 157  Evictions: 0  Overflows: 0  Memory Usage: 25kB
                    Buffers: shared hit=471
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=157)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=471
Planning:
  Buffers: shared hit=58
Planning Time: 4.037 ms
Execution Time: 5.446 ms
```

### ranked terms — q=python

Parameters: `["python","python"]` — Execution Time: 1552.366 ms

```
Limit  (cost=20670.54..20670.67 rows=50 width=39) (actual time=1552.101..1552.191 rows=50 loops=1)
  Buffers: shared hit=3265
  ->  Sort  (cost=20670.54..20847.90 rows=70942 width=39) (actual time=1552.099..1552.185 rows=50 loops=1)
        Sort Key: (max((((CASE WHEN (lower(name) = 'python'::text) THEN 1000 WHEN (lower(attr_path) = 'python'::text) THEN 900 WHEN (lower(name) ~~ 'python%'::text) THEN 800 WHEN (lower(attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * GREATEST(similarity(name, 'python'::text), similarity(attr_path, 'python'::text)))) + (CASE WHEN (top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, name
        Sort Method: top-N heapsort  Memory: 31kB
        Buffers: shared hit=3265
        ->  Finalize GroupAggregate  (cost=8547.36..18313.90 rows=70942 width=39) (actual time=1139.374..1522.029 rows=69537 loops=1)
              Group Key: package_id, name
              Buffers: shared hit=3265
              ->  Gather Merge  (cost=8547.36..17160.29 rows=59226 width=39) (actual time=1139.370..1494.160 rows=69537 loops=1)
                    Workers Planned: 2
                    Workers Launched: 2
                    Buffers: shared hit=3265
                    ->  Partial GroupAggregate  (cost=7547.33..9324.11 rows=29613 width=39) (actual time=1123.286..1322.008 rows=23179 loops=3)
                          Group Key: package_id, name
                          Buffers: shared hit=3265
                          ->  Sort  (cost=7547.33..7621.36 rows=29613 width=68) (actual time=1123.273..1127.178 rows=23234 loops=3)
                                Sort Key: package_id, name
                                Sort Method: quicksort  Memory: 2720kB
                                Buffers: shared hit=3265
                                Worker 0:  Sort Method: quicksort  Memory: 2664kB
                                Worker 1:  Sort Method: quicksort  Memory: 2689kB
                                ->  Parallel Seq Scan on search_terms  (cost=0.00..5347.98 rows=29613 width=68) (actual time=103.078..1114.597 rows=23234 loops=3)
                                      Filter: ((name % 'python'::text) OR (attr_path % 'python'::text) OR (lower(name) ~~ 'python%'::text))
                                      Rows Removed by Filter: 59928
                                      Buffers: shared hit=3177
Planning:
  Buffers: shared hit=4
Planning Time: 0.736 ms
Execution Time: 1552.366 ms
```

### batched fetch, latest — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 1.618 ms

```
Limit  (cost=318.53..882.72 rows=50 width=1383) (actual time=1.023..1.518 rows=50 loops=1)
  Buffers: shared hit=2179
  ->  Incremental Sort  (cost=318.53..8352.55 rows=712 width=1383) (actual time=1.022..1.513 rows=50 loops=1)
        Sort Key: hits.ord, variants.system, variants.attr_path
        Presorted Key: hits.ord
        Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 85kB  Peak Memory: 85kB
        Buffers: shared hit=2179
        ->  Nested Loop  (cost=154.77..8329.01 rows=712 width=1383) (actual time=0.347..1.459 rows=52 loops=1)
              Buffers: shared hit=2179
              ->  Nested Loop  (cost=154.49..8117.15 rows=712 width=1328) (actual time=0.342..1.369 rows=52 loops=1)
                    Buffers: shared hit=2023
                    ->  Nested Loop  (cost=154.07..7754.65 rows=712 width=339) (actual time=0.336..1.260 rows=52 loops=1)
                          Join Filter: (variants.version_id = v.id)
                          Buffers: shared hit=1815
                          ->  Nested Loop  (cost=153.64..7680.97 rows=50 width=53) (actual time=0.333..1.203 rows=19 loops=1)
                                Buffers: shared hit=1737
                                ->  Nested Loop  (cost=153.22..7658.62 rows=50 width=30) (actual time=0.325..1.145 rows=19 loops=1)
                                      Buffers: shared hit=1661
                                      ->  Nested Loop  (cost=152.78..7640.65 rows=50 width=12) (actual time=0.317..1.079 rows=19 loops=1)
                                            Buffers: shared hit=1585
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.007..0.009 rows=20 loops=1)
                                            ->  Limit  (cost=152.78..152.78 rows=1 width=20) (actual time=0.053..0.053 rows=1 loops=20)
                                                  Buffers: shared hit=1585
                                                  ->  Sort  (cost=152.78..152.86 rows=33 width=20) (actual time=0.053..0.053 rows=1 loops=20)
                                                        Sort Key: (EXISTS(SubPlan 1)) DESC, v.sort_key DESC
                                                        Sort Method: top-N heapsort  Memory: 25kB
                                                        Buffers: shared hit=1585
                                                        ->  Index Scan using versions_semver_idx on versions v  (cost=0.43..152.62 rows=33 width=20) (actual time=0.008..0.048 rows=18 loops=20)
                                                              Index Cond: (package_id = hits.package_id)
                                                              Filter: (NOT prerelease)
                                                              Rows Removed by Filter: 6
                                                              Buffers: shared hit=1585
                                                              SubPlan 1
                                                                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..31.47 rows=14 width=0) (actual time=0.002..0.002 rows=1 loops=370)
                                                                      Index Cond: (version_id = v.id)
                                                                      Filter: (NOT broken)
                                                                      Buffers: shared hit=1480
                                      ->  Memoize  (cost=0.44..8.46 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=19)
                                            Cache Key: v.id
                                            Cache Mode: logical
                                            Hits: 0  Misses: 19  Evictions: 0  Overflows: 0  Memory Usage: 3kB
                                            Buffers: shared hit=76
                                            ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=19)
                                                  Index Cond: (id = v.id)
                                                  Buffers: shared hit=76
                                ->  Index Scan using packages_pkey on packages  (cost=0.42..0.45 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=19)
                                      Index Cond: (id = versions.package_id)
                                      Buffers: shared hit=76
                          ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.30 rows=14 width=298) (actual time=0.001..0.002 rows=3 loops=19)
                                Index Cond: (version_id = versions.id)
                                Buffers: shared hit=78
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.002..0.002 rows=1 loops=52)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=208
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=52)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=156
Planning:
  Buffers: shared hit=80
Planning Time: 4.574 ms
Execution Time: 1.618 ms
```

### batched fetch, all versions — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 7.069 ms

```
Limit  (cost=118.76..1454.74 rows=1000 width=1398) (actual time=3.594..6.800 rows=1000 loops=1)
  Buffers: shared hit=6857
  ->  Incremental Sort  (cost=118.76..5895.53 rows=4324 width=1398) (actual time=3.593..6.724 rows=1000 loops=1)
        Sort Key: hits.ord, versions.sort_key DESC, variants.system, variants.attr_path
        Presorted Key: hits.ord
        Full-sort Groups: 3  Sort Method: quicksort  Average Memory: 185kB  Peak Memory: 195kB
        Pre-sorted Groups: 3  Sort Method: quicksort  Average Memory: 1293kB  Peak Memory: 1293kB
        Buffers: shared hit=6857
        ->  Nested Loop  (cost=1.99..5701.37 rows=4324 width=1398) (actual time=0.057..4.956 rows=1278 loops=1)
              Buffers: shared hit=6857
              ->  Nested Loop  (cost=1.70..5066.18 rows=4324 width=1343) (actual time=0.047..4.059 rows=1278 loops=1)
                    Buffers: shared hit=6476
                    ->  Nested Loop  (cost=1.28..2864.66 rows=4324 width=354) (actual time=0.040..1.729 rows=1278 loops=1)
                          Buffers: shared hit=1364
                          ->  Nested Loop  (cost=0.85..512.47 rows=1635 width=64) (actual time=0.031..0.295 rows=315 loops=1)
                                Join Filter: (versions.package_id = hits.package_id)
                                Buffers: shared hit=49
                                ->  Nested Loop  (cost=0.42..422.38 rows=50 width=43) (actual time=0.020..0.038 rows=5 loops=1)
                                      Buffers: shared hit=20
                                      ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.009 rows=5 loops=1)
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (actual time=0.004..0.004 rows=1 loops=5)
                                            Index Cond: (id = hits.package_id)
                                            Buffers: shared hit=20
                                ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.39 rows=33 width=33) (actual time=0.006..0.025 rows=63 loops=5)
                                      Index Cond: (package_id = packages.id)
                                      Buffers: shared hit=29
                          ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.30 rows=14 width=298) (actual time=0.002..0.003 rows=4 loops=315)
                                Index Cond: (version_id = versions.id)
                                Buffers: shared hit=1315
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.001..0.001 rows=1 loops=1278)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=5112
              ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=1278)
                    Cache Key: variants.commit_seq
                    Cache Mode: logical
                    Hits: 1151  Misses: 127  Evictions: 0  Overflows: 0  Memory Usage: 20kB
                    Buffers: shared hit=381
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=127)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=381
Planning:
  Buffers: shared hit=58
Planning Time: 3.652 ms
Execution Time: 7.069 ms
```

## Name lookups (/v2/resolve, /v1/resolve, /v2/pkg, /v1/pkg)

### pick latest version — name=go

Parameters: `["go"]` — Execution Time: 4.850 ms

```
Limit  (cost=1308.86..1308.86 rows=1 width=19) (actual time=4.779..4.782 rows=1 loops=1)
  Buffers: shared hit=9107
  ->  Sort  (cost=1308.86..1309.18 rows=127 width=19) (actual time=4.778..4.780 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=9107
        ->  Nested Loop  (cost=102.60..1308.22 rows=127 width=19) (actual time=1.051..4.681 rows=632 loops=1)
              Buffers: shared hit=9107
              ->  Nested Loop  (cost=102.18..1252.08 rows=127 width=23) (actual time=1.044..3.507 rows=632 loops=1)
                    Buffers: shared hit=6578
                    ->  Nested Loop  (cost=101.75..1192.34 rows=128 width=4) (actual time=1.038..2.400 rows=707 loops=1)
                          Buffers: shared hit=3750
                          ->  HashAggregate  (cost=101.32..102.61 rows=129 width=4) (actual time=1.030..1.114 rows=707 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=922
                                ->  Append  (cost=1.28..101.00 rows=129 width=4) (actual time=0.031..0.863 rows=961 loops=1)
                                      Buffers: shared hit=922
                                      ->  Nested Loop  (cost=1.28..82.66 rows=16 width=4) (actual time=0.030..0.714 rows=707 loops=1)
                                            Buffers: shared hit=862
                                            ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.022..0.086 rows=187 loops=1)
                                                  Buffers: shared hit=19
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.011..0.012 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'go'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (actual time=0.008..0.051 rows=187 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=15
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.30 rows=14 width=8) (actual time=0.002..0.003 rows=4 loops=187)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=843
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..17.70 rows=113 width=4) (actual time=0.008..0.076 rows=254 loops=1)
                                            Index Cond: (attr_path = 'go'::text)
                                            Buffers: shared hit=60
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=707)
                                Index Cond: (id = va.id)
                                Filter: (NOT broken)
                                Buffers: shared hit=2828
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=707)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=2828
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=632)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 0
                    Buffers: shared hit=2529
Planning:
  Buffers: shared hit=76
Planning Time: 6.210 ms
Execution Time: 4.850 ms
```

### pick latest version — name=python

Parameters: `["python"]` — Execution Time: 3.931 ms

```
Limit  (cost=1308.86..1308.86 rows=1 width=19) (actual time=3.861..3.864 rows=1 loops=1)
  Buffers: shared hit=7502
  ->  Sort  (cost=1308.86..1309.18 rows=127 width=19) (actual time=3.860..3.862 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=7502
        ->  Nested Loop  (cost=102.60..1308.22 rows=127 width=19) (actual time=0.823..3.793 rows=409 loops=1)
              Buffers: shared hit=7502
              ->  Nested Loop  (cost=102.18..1252.08 rows=127 width=23) (actual time=0.814..3.008 rows=409 loops=1)
                    Buffers: shared hit=5865
                    ->  Nested Loop  (cost=101.75..1192.34 rows=128 width=4) (actual time=0.808..2.001 rows=639 loops=1)
                          Buffers: shared hit=3309
                          ->  HashAggregate  (cost=101.32..102.61 rows=129 width=4) (actual time=0.800..0.877 rows=639 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=753
                                ->  Append  (cost=1.28..101.00 rows=129 width=4) (actual time=0.031..0.671 rows=642 loops=1)
                                      Buffers: shared hit=753
                                      ->  Nested Loop  (cost=1.28..82.66 rows=16 width=4) (actual time=0.031..0.614 rows=639 loops=1)
                                            Buffers: shared hit=749
                                            ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.022..0.091 rows=175 loops=1)
                                                  Buffers: shared hit=21
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.010..0.011 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'python'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (actual time=0.010..0.056 rows=175 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=17
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.30 rows=14 width=8) (actual time=0.002..0.002 rows=4 loops=175)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=728
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..17.70 rows=113 width=4) (actual time=0.007..0.008 rows=3 loops=1)
                                            Index Cond: (attr_path = 'python'::text)
                                            Buffers: shared hit=4
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.001..0.001 rows=1 loops=639)
                                Index Cond: (id = va.id)
                                Filter: (NOT broken)
                                Buffers: shared hit=2556
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=639)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=2556
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=409)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 0
                    Buffers: shared hit=1637
Planning:
  Buffers: shared hit=76
Planning Time: 6.311 ms
Execution Time: 3.931 ms
```

### pick latest version — name=python311

Parameters: `["python311"]` — Execution Time: 0.560 ms

```
Limit  (cost=1308.86..1308.86 rows=1 width=19) (actual time=0.497..0.499 rows=1 loops=1)
  Buffers: shared hit=916
  ->  Sort  (cost=1308.86..1309.18 rows=127 width=19) (actual time=0.497..0.498 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=916
        ->  Nested Loop  (cost=102.60..1308.22 rows=127 width=19) (actual time=0.098..0.485 rows=51 loops=1)
              Buffers: shared hit=916
              ->  Nested Loop  (cost=102.18..1252.08 rows=127 width=23) (actual time=0.090..0.384 rows=51 loops=1)
                    Buffers: shared hit=711
                    ->  Nested Loop  (cost=101.75..1192.34 rows=128 width=4) (actual time=0.083..0.243 rows=87 loops=1)
                          Buffers: shared hit=363
                          ->  HashAggregate  (cost=101.32..102.61 rows=129 width=4) (actual time=0.074..0.085 rows=87 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=15
                                ->  Append  (cost=1.28..101.00 rows=129 width=4) (actual time=0.019..0.057 rows=87 loops=1)
                                      Buffers: shared hit=15
                                      ->  Nested Loop  (cost=1.28..82.66 rows=16 width=4) (actual time=0.010..0.010 rows=0 loops=1)
                                            Buffers: shared hit=3
                                            ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.010..0.010 rows=0 loops=1)
                                                  Buffers: shared hit=3
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.010..0.010 rows=0 loops=1)
                                                        Index Cond: (lower(name) = 'python311'::text)
                                                        Buffers: shared hit=3
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (never executed)
                                                        Index Cond: (package_id = p.id)
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.30 rows=14 width=8) (never executed)
                                                  Index Cond: (version_id = ve.id)
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..17.70 rows=113 width=4) (actual time=0.009..0.039 rows=87 loops=1)
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
                    Heap Fetches: 0
                    Buffers: shared hit=205
Planning:
  Buffers: shared hit=76
Planning Time: 4.928 ms
Execution Time: 0.560 ms
```

### pick latest version — name=hello

Parameters: `["hello"]` — Execution Time: 0.273 ms

```
Limit  (cost=1308.86..1308.86 rows=1 width=19) (actual time=0.206..0.207 rows=1 loops=1)
  Buffers: shared hit=263
  ->  Sort  (cost=1308.86..1309.18 rows=127 width=19) (actual time=0.205..0.206 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=263
        ->  Nested Loop  (cost=102.60..1308.22 rows=127 width=19) (actual time=0.096..0.197 rows=19 loops=1)
              Buffers: shared hit=263
              ->  Nested Loop  (cost=102.18..1252.08 rows=127 width=23) (actual time=0.089..0.154 rows=19 loops=1)
                    Buffers: shared hit=186
                    ->  Nested Loop  (cost=101.75..1192.34 rows=128 width=4) (actual time=0.083..0.119 rows=19 loops=1)
                          Buffers: shared hit=110
                          ->  HashAggregate  (cost=101.32..102.61 rows=129 width=4) (actual time=0.075..0.079 rows=19 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=34
                                ->  Append  (cost=1.28..101.00 rows=129 width=4) (actual time=0.030..0.064 rows=38 loops=1)
                                      Buffers: shared hit=34
                                      ->  Nested Loop  (cost=1.28..82.66 rows=16 width=4) (actual time=0.029..0.049 rows=19 loops=1)
                                            Buffers: shared hit=29
                                            ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.021..0.024 rows=5 loops=1)
                                                  Buffers: shared hit=8
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.011..0.011 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'hello'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (actual time=0.007..0.009 rows=5 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=4
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.30 rows=14 width=8) (actual time=0.003..0.004 rows=4 loops=5)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=21
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..17.70 rows=113 width=4) (actual time=0.006..0.010 rows=19 loops=1)
                                            Index Cond: (attr_path = 'hello'::text)
                                            Buffers: shared hit=5
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=19)
                                Index Cond: (id = va.id)
                                Filter: (NOT broken)
                                Buffers: shared hit=76
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.002..0.002 rows=1 loops=19)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Buffers: shared hit=76
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=19)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 0
                    Buffers: shared hit=77
Planning:
  Buffers: shared hit=76
Planning Time: 4.948 ms
Execution Time: 0.273 ms
```

### every version — name=go

Parameters: `["go"]` — Execution Time: 8.041 ms

```
Limit  (cost=1418.76..1419.08 rows=129 width=1390) (actual time=7.706..7.801 rows=707 loops=1)
  Buffers: shared hit=14355
  ->  Sort  (cost=1418.76..1419.08 rows=129 width=1390) (actual time=7.704..7.745 rows=707 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 725kB
        Buffers: shared hit=14355
        ->  Nested Loop  (cost=103.30..1414.24 rows=129 width=1390) (actual time=1.068..7.041 rows=707 loops=1)
              Buffers: shared hit=14355
              ->  Nested Loop  (cost=103.02..1375.86 rows=129 width=1335) (actual time=1.063..6.019 rows=707 loops=1)
                    Buffers: shared hit=12234
                    ->  Nested Loop  (cost=102.60..1310.18 rows=129 width=346) (actual time=1.056..4.698 rows=707 loops=1)
                          Buffers: shared hit=9406
                          ->  Nested Loop  (cost=102.18..1252.52 rows=129 width=323) (actual time=1.051..3.640 rows=707 loops=1)
                                Buffers: shared hit=6578
                                ->  Nested Loop  (cost=101.75..1192.34 rows=129 width=298) (actual time=1.045..2.485 rows=707 loops=1)
                                      Buffers: shared hit=3750
                                      ->  HashAggregate  (cost=101.32..102.61 rows=129 width=4) (actual time=1.038..1.136 rows=707 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=922
                                            ->  Append  (cost=1.28..101.00 rows=129 width=4) (actual time=0.037..0.868 rows=961 loops=1)
                                                  Buffers: shared hit=922
                                                  ->  Nested Loop  (cost=1.28..82.66 rows=16 width=4) (actual time=0.037..0.719 rows=707 loops=1)
                                                        Buffers: shared hit=862
                                                        ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.028..0.093 rows=187 loops=1)
                                                              Buffers: shared hit=19
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.016..0.017 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'go'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (actual time=0.009..0.052 rows=187 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=15
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.30 rows=14 width=8) (actual time=0.002..0.003 rows=4 loops=187)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=843
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..17.70 rows=113 width=4) (actual time=0.008..0.075 rows=254 loops=1)
                                                        Index Cond: (attr_path = 'go'::text)
                                                        Buffers: shared hit=60
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.001..0.001 rows=1 loops=707)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=2828
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=707)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=2828
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.45 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=707)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=2828
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.001..0.001 rows=1 loops=707)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=2828
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=707)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=2121
Planning:
  Buffers: shared hit=96
Planning Time: 7.259 ms
Execution Time: 8.041 ms
```

### every version — name=python

Parameters: `["python"]` — Execution Time: 7.343 ms

```
Limit  (cost=1418.76..1419.08 rows=129 width=1390) (actual time=7.012..7.102 rows=639 loops=1)
  Buffers: shared hit=12894
  ->  Sort  (cost=1418.76..1419.08 rows=129 width=1390) (actual time=7.010..7.052 rows=639 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 1275kB
        Buffers: shared hit=12894
        ->  Nested Loop  (cost=103.30..1414.24 rows=129 width=1390) (actual time=0.817..6.300 rows=639 loops=1)
              Buffers: shared hit=12894
              ->  Nested Loop  (cost=103.02..1375.86 rows=129 width=1335) (actual time=0.811..5.356 rows=639 loops=1)
                    Buffers: shared hit=10977
                    ->  Nested Loop  (cost=102.60..1310.18 rows=129 width=346) (actual time=0.803..4.297 rows=639 loops=1)
                          Buffers: shared hit=8421
                          ->  Nested Loop  (cost=102.18..1252.52 rows=129 width=323) (actual time=0.797..3.227 rows=639 loops=1)
                                Buffers: shared hit=5865
                                ->  Nested Loop  (cost=101.75..1192.34 rows=129 width=298) (actual time=0.791..2.148 rows=639 loops=1)
                                      Buffers: shared hit=3309
                                      ->  HashAggregate  (cost=101.32..102.61 rows=129 width=4) (actual time=0.784..0.901 rows=639 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=753
                                            ->  Append  (cost=1.28..101.00 rows=129 width=4) (actual time=0.035..0.659 rows=642 loops=1)
                                                  Buffers: shared hit=753
                                                  ->  Nested Loop  (cost=1.28..82.66 rows=16 width=4) (actual time=0.034..0.601 rows=639 loops=1)
                                                        Buffers: shared hit=749
                                                        ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.026..0.089 rows=175 loops=1)
                                                              Buffers: shared hit=21
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.015..0.015 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'python'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (actual time=0.009..0.051 rows=175 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=17
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.30 rows=14 width=8) (actual time=0.002..0.002 rows=4 loops=175)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=728
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..17.70 rows=113 width=4) (actual time=0.008..0.008 rows=3 loops=1)
                                                        Index Cond: (attr_path = 'python'::text)
                                                        Buffers: shared hit=4
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.001..0.001 rows=1 loops=639)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=2556
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=639)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=2556
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.45 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=639)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=2556
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.001..0.001 rows=1 loops=639)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=2556
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=639)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=1917
Planning:
  Buffers: shared hit=96
Planning Time: 5.326 ms
Execution Time: 7.343 ms
```

### every version — name=python311

Parameters: `["python311"]` — Execution Time: 1.171 ms

```
Limit  (cost=1418.76..1419.08 rows=129 width=1390) (actual time=1.037..1.051 rows=87 loops=1)
  Buffers: shared hit=1668
  ->  Sort  (cost=1418.76..1419.08 rows=129 width=1390) (actual time=1.036..1.042 rows=87 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 199kB
        Buffers: shared hit=1668
        ->  Nested Loop  (cost=103.30..1414.24 rows=129 width=1390) (actual time=0.117..0.938 rows=87 loops=1)
              Buffers: shared hit=1668
              ->  Nested Loop  (cost=103.02..1375.86 rows=129 width=1335) (actual time=0.112..0.789 rows=87 loops=1)
                    Buffers: shared hit=1407
                    ->  Nested Loop  (cost=102.60..1310.18 rows=129 width=346) (actual time=0.106..0.632 rows=87 loops=1)
                          Buffers: shared hit=1059
                          ->  Nested Loop  (cost=102.18..1252.52 rows=129 width=323) (actual time=0.100..0.427 rows=87 loops=1)
                                Buffers: shared hit=711
                                ->  Nested Loop  (cost=101.75..1192.34 rows=129 width=298) (actual time=0.093..0.276 rows=87 loops=1)
                                      Buffers: shared hit=363
                                      ->  HashAggregate  (cost=101.32..102.61 rows=129 width=4) (actual time=0.084..0.099 rows=87 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=15
                                            ->  Append  (cost=1.28..101.00 rows=129 width=4) (actual time=0.025..0.068 rows=87 loops=1)
                                                  Buffers: shared hit=15
                                                  ->  Nested Loop  (cost=1.28..82.66 rows=16 width=4) (actual time=0.014..0.014 rows=0 loops=1)
                                                        Buffers: shared hit=3
                                                        ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.013..0.014 rows=0 loops=1)
                                                              Buffers: shared hit=3
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.013 rows=0 loops=1)
                                                                    Index Cond: (lower(name) = 'python311'::text)
                                                                    Buffers: shared hit=3
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (never executed)
                                                                    Index Cond: (package_id = p.id)
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.30 rows=14 width=8) (never executed)
                                                              Index Cond: (version_id = ve.id)
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..17.70 rows=113 width=4) (actual time=0.010..0.045 rows=87 loops=1)
                                                        Index Cond: (attr_path = 'python311'::text)
                                                        Buffers: shared hit=12
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.002..0.002 rows=1 loops=87)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=348
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=87)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=348
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.45 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=87)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=348
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.001..0.001 rows=1 loops=87)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=348
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=87)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=261
Planning:
  Buffers: shared hit=96
Planning Time: 6.270 ms
Execution Time: 1.171 ms
```

### every version — name=hello

Parameters: `["hello"]` — Execution Time: 0.374 ms

```
Limit  (cost=1418.76..1419.08 rows=129 width=1390) (actual time=0.288..0.292 rows=19 loops=1)
  Buffers: shared hit=395
  ->  Sort  (cost=1418.76..1419.08 rows=129 width=1390) (actual time=0.286..0.289 rows=19 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 63kB
        Buffers: shared hit=395
        ->  Nested Loop  (cost=103.30..1414.24 rows=129 width=1390) (actual time=0.100..0.261 rows=19 loops=1)
              Buffers: shared hit=395
              ->  Nested Loop  (cost=103.02..1375.86 rows=129 width=1335) (actual time=0.095..0.224 rows=19 loops=1)
                    Buffers: shared hit=338
                    ->  Nested Loop  (cost=102.60..1310.18 rows=129 width=346) (actual time=0.089..0.186 rows=19 loops=1)
                          Buffers: shared hit=262
                          ->  Nested Loop  (cost=102.18..1252.52 rows=129 width=323) (actual time=0.085..0.153 rows=19 loops=1)
                                Buffers: shared hit=186
                                ->  Nested Loop  (cost=101.75..1192.34 rows=129 width=298) (actual time=0.079..0.116 rows=19 loops=1)
                                      Buffers: shared hit=110
                                      ->  HashAggregate  (cost=101.32..102.61 rows=129 width=4) (actual time=0.072..0.076 rows=19 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=34
                                            ->  Append  (cost=1.28..101.00 rows=129 width=4) (actual time=0.029..0.061 rows=38 loops=1)
                                                  Buffers: shared hit=34
                                                  ->  Nested Loop  (cost=1.28..82.66 rows=16 width=4) (actual time=0.028..0.046 rows=19 loops=1)
                                                        Buffers: shared hit=29
                                                        ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.022..0.024 rows=5 loops=1)
                                                              Buffers: shared hit=8
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.014 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'hello'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (actual time=0.006..0.007 rows=5 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=4
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.30 rows=14 width=8) (actual time=0.002..0.004 rows=4 loops=5)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=21
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..17.70 rows=113 width=4) (actual time=0.006..0.011 rows=19 loops=1)
                                                        Index Cond: (attr_path = 'hello'::text)
                                                        Buffers: shared hit=5
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.002..0.002 rows=1 loops=19)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=76
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=19)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=76
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.45 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=19)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=76
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.002..0.002 rows=1 loops=19)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=76
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=19)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=57
Planning:
  Buffers: shared hit=96
Planning Time: 6.049 ms
Execution Time: 0.374 ms
```

