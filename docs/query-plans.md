# Serving query plans

Recorded 2026-09-17 against `ep-calm-queen-auynflld.c-10.us-east-1.aws.neon.tech` with `node tools/explain-plans.mjs`.
Regenerate after changing apps/web/lib/search.ts or the indexes, and diff.
Warm plans (second run); see the script for what each statement is.

Table sizes: packages=250044, versions=1462271, variants=3818870, search_terms=250632

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

Parameters: `["go","go"]` — Execution Time: 108.614 ms

```
Limit  (cost=1469.40..1469.52 rows=50 width=39) (actual time=108.369..108.378 rows=50 loops=1)
  Buffers: shared hit=2342
  ->  Sort  (cost=1469.40..1469.60 rows=79 width=39) (actual time=108.367..108.372 rows=50 loops=1)
        Sort Key: (max((((CASE WHEN (lower(name) = 'go'::text) THEN 1000 WHEN (lower(attr_path) = 'go'::text) THEN 900 WHEN (lower(name) ~~ 'go%'::text) THEN 800 WHEN (lower(attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * GREATEST(similarity(name, 'go'::text), similarity(attr_path, 'go'::text)))) + (CASE WHEN (top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, name
        Sort Method: top-N heapsort  Memory: 31kB
        Buffers: shared hit=2342
        ->  GroupAggregate  (cost=1462.17..1466.91 rows=79 width=39) (actual time=106.886..108.263 rows=454 loops=1)
              Group Key: package_id, name
              Buffers: shared hit=2342
              ->  Sort  (cost=1462.17..1462.37 rows=79 width=68) (actual time=106.873..106.903 rows=469 loops=1)
                    Sort Key: package_id, name
                    Sort Method: quicksort  Memory: 52kB
                    Buffers: shared hit=2342
                    ->  Bitmap Heap Scan on search_terms  (cost=1136.61..1459.68 rows=79 width=68) (actual time=8.537..106.779 rows=469 loops=1)
                          Recheck Cond: ((name % 'go'::text) OR (attr_path % 'go'::text) OR (lower(name) ~~ 'go%'::text))
                          Rows Removed by Index Recheck: 20677
                          Filter: ((name % 'go'::text) OR (attr_path % 'go'::text) OR (lower(name) ~~ 'go%'::text))
                          Heap Blocks: exact=2056
                          Buffers: shared hit=2342
                          ->  BitmapOr  (cost=1136.61..1136.61 rows=93 width=0) (actual time=4.519..4.520 rows=0 loops=1)
                                Buffers: shared hit=286
                                ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..565.86 rows=26 width=0) (actual time=2.475..2.475 rows=22645 loops=1)
                                      Index Cond: (name % 'go'::text)
                                      Buffers: shared hit=140
                                ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..565.86 rows=26 width=0) (actual time=2.011..2.012 rows=22646 loops=1)
                                      Index Cond: (attr_path % 'go'::text)
                                      Buffers: shared hit=140
                                ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.82 rows=40 width=0) (actual time=0.031..0.031 rows=441 loops=1)
                                      Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                      Buffers: shared hit=6
Planning:
  Buffers: shared hit=4
Planning Time: 0.651 ms
Execution Time: 108.614 ms
```

### batched fetch, latest — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 3.966 ms

```
Limit  (cost=8539.11..8542.62 rows=50 width=1385) (actual time=3.802..3.851 rows=50 loops=1)
  Buffers: shared hit=4104
  ->  Unique  (cost=8539.11..8542.62 rows=50 width=1385) (actual time=3.801..3.846 rows=50 loops=1)
        Buffers: shared hit=4104
        ->  Sort  (cost=8539.11..8540.86 rows=702 width=1385) (actual time=3.800..3.811 rows=174 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Sort Method: quicksort  Memory: 197kB
              Buffers: shared hit=4104
              ->  Hash Join  (cost=254.32..8505.92 rows=702 width=1385) (actual time=1.201..3.643 rows=177 loops=1)
                    Hash Cond: (variants.commit_seq = commit_hash.seq)
                    Buffers: shared hit=4104
                    ->  Nested Loop  (cost=160.42..8410.18 rows=702 width=1330) (actual time=0.520..2.913 rows=177 loops=1)
                          Buffers: shared hit=4072
                          ->  Nested Loop  (cost=160.00..8052.72 rows=702 width=341) (actual time=0.512..2.447 rows=177 loops=1)
                                Join Filter: (variants.version_id = v.id)
                                Buffers: shared hit=3364
                                ->  Nested Loop  (cost=159.57..7977.45 rows=50 width=53) (actual time=0.508..2.213 rows=50 loops=1)
                                      Buffers: shared hit=3097
                                      ->  Nested Loop  (cost=159.15..7954.98 rows=50 width=30) (actual time=0.501..2.109 rows=50 loops=1)
                                            Buffers: shared hit=2897
                                            ->  Nested Loop  (cost=158.71..7937.02 rows=50 width=12) (actual time=0.492..1.953 rows=50 loops=1)
                                                  Buffers: shared hit=2697
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.014 rows=50 loops=1)
                                                  ->  Limit  (cost=158.71..158.71 rows=1 width=20) (actual time=0.038..0.038 rows=1 loops=50)
                                                        Buffers: shared hit=2697
                                                        ->  Sort  (cost=158.71..158.79 rows=33 width=20) (actual time=0.038..0.038 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, v.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=2697
                                                              ->  Index Scan using versions_semver_idx on versions v  (cost=0.43..158.54 rows=33 width=20) (actual time=0.007..0.034 rows=12 loops=50)
                                                                    Index Cond: (package_id = hits.package_id)
                                                                    Filter: (NOT prerelease)
                                                                    Rows Removed by Filter: 0
                                                                    Buffers: shared hit=2697
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..33.98 rows=14 width=0) (actual time=0.002..0.002 rows=1 loops=612)
                                                                            Index Cond: (version_id = v.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=2454
                                            ->  Memoize  (cost=0.44..8.46 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Cache Key: v.id
                                                  Cache Mode: logical
                                                  Hits: 0  Misses: 50  Evictions: 0  Overflows: 0  Memory Usage: 6kB
                                                  Buffers: shared hit=200
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=50)
                                                        Index Cond: (id = v.id)
                                                        Buffers: shared hit=200
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.45 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=200
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.33 rows=14 width=300) (actual time=0.002..0.004 rows=4 loops=50)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=267
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.002..0.002 rows=1 loops=177)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=708
                    ->  Hash  (cost=59.51..59.51 rows=2751 width=53) (actual time=0.677..0.677 rows=2790 loops=1)
                          Buckets: 4096  Batches: 1  Memory Usage: 283kB
                          Buffers: shared hit=32
                          ->  Seq Scan on commits commit_hash  (cost=0.00..59.51 rows=2751 width=53) (actual time=0.014..0.305 rows=2790 loops=1)
                                Buffers: shared hit=32
Planning:
  Buffers: shared hit=80
Planning Time: 5.484 ms
Execution Time: 3.966 ms
```

### batched fetch, all versions — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 12.729 ms

```
Limit  (cost=120.43..1483.70 rows=1000 width=1400) (actual time=3.509..12.534 rows=632 loops=1)
  Buffers: shared hit=13105
  ->  Unique  (cost=120.43..6011.11 rows=4321 width=1400) (actual time=3.507..12.481 rows=632 loops=1)
        Buffers: shared hit=13105
        ->  Incremental Sort  (cost=120.43..5978.71 rows=4321 width=1400) (actual time=3.507..11.934 rows=2298 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 19  Sort Method: quicksort  Average Memory: 69kB  Peak Memory: 75kB
              Pre-sorted Groups: 28  Sort Method: quicksort  Average Memory: 558kB  Peak Memory: 558kB
              Buffers: shared hit=13105
              ->  Nested Loop  (cost=2.00..5784.70 rows=4321 width=1400) (actual time=0.055..8.525 rows=2298 loops=1)
                    Buffers: shared hit=13105
                    ->  Nested Loop  (cost=1.71..5141.86 rows=4321 width=1345) (actual time=0.046..7.127 rows=2298 loops=1)
                          Buffers: shared hit=12394
                          ->  Nested Loop  (cost=1.28..2941.58 rows=4321 width=356) (actual time=0.039..3.317 rows=2298 loops=1)
                                Buffers: shared hit=3202
                                ->  Nested Loop  (cost=0.85..512.68 rows=1652 width=64) (actual time=0.030..0.595 rows=632 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=435
                                      ->  Nested Loop  (cost=0.42..422.50 rows=50 width=43) (actual time=0.018..0.138 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.007..0.015 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.39 rows=33 width=33) (actual time=0.003..0.007 rows=13 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=235
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.33 rows=14 width=300) (actual time=0.002..0.003 rows=4 loops=632)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=2767
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.001..0.001 rows=1 loops=2298)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=9192
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=2298)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 2061  Misses: 237  Evictions: 0  Overflows: 0  Memory Usage: 38kB
                          Buffers: shared hit=711
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=237)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=711
Planning:
  Buffers: shared hit=58
Planning Time: 4.819 ms
Execution Time: 12.729 ms
```

### ranked terms — q=python

Parameters: `["python","python"]` — Execution Time: 1112.366 ms

```
Limit  (cost=20820.88..20821.00 rows=50 width=39) (actual time=1111.401..1112.307 rows=50 loops=1)
  Buffers: shared hit=3289
  ->  Sort  (cost=20820.88..20999.57 rows=71478 width=39) (actual time=1111.399..1112.301 rows=50 loops=1)
        Sort Key: (max((((CASE WHEN (lower(name) = 'python'::text) THEN 1000 WHEN (lower(attr_path) = 'python'::text) THEN 900 WHEN (lower(name) ~~ 'python%'::text) THEN 800 WHEN (lower(attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * GREATEST(similarity(name, 'python'::text), similarity(attr_path, 'python'::text)))) + (CASE WHEN (top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, name
        Sort Method: top-N heapsort  Memory: 31kB
        Buffers: shared hit=3289
        ->  Finalize GroupAggregate  (cost=8606.01..18446.43 rows=71478 width=39) (actual time=794.266..1096.432 rows=69851 loops=1)
              Group Key: package_id, name
              Buffers: shared hit=3289
              ->  Gather Merge  (cost=8606.01..17284.09 rows=59674 width=39) (actual time=794.246..1059.285 rows=69851 loops=1)
                    Workers Planned: 2
                    Workers Launched: 2
                    Buffers: shared hit=3289
                    ->  Partial GroupAggregate  (cost=7605.99..9396.21 rows=29837 width=39) (actual time=779.735..954.113 rows=23284 loops=3)
                          Group Key: package_id, name
                          Buffers: shared hit=3289
                          ->  Sort  (cost=7605.99..7680.58 rows=29837 width=68) (actual time=779.720..782.406 rows=23338 loops=3)
                                Sort Key: package_id, name
                                Sort Method: quicksort  Memory: 2693kB
                                Buffers: shared hit=3289
                                Worker 0:  Sort Method: quicksort  Memory: 2706kB
                                Worker 1:  Sort Method: quicksort  Memory: 2706kB
                                ->  Parallel Seq Scan on search_terms  (cost=0.00..5388.38 rows=29837 width=68) (actual time=33.976..765.964 rows=23338 loops=3)
                                      Filter: ((name % 'python'::text) OR (attr_path % 'python'::text) OR (lower(name) ~~ 'python%'::text))
                                      Rows Removed by Filter: 60206
                                      Buffers: shared hit=3201
Planning:
  Buffers: shared hit=4
Planning Time: 0.712 ms
Execution Time: 1112.366 ms
```

### batched fetch, latest — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 3.423 ms

```
Limit  (cost=8539.11..8542.62 rows=50 width=1385) (actual time=3.285..3.329 rows=49 loops=1)
  Buffers: shared hit=3412
  ->  Unique  (cost=8539.11..8542.62 rows=50 width=1385) (actual time=3.284..3.324 rows=49 loops=1)
        Buffers: shared hit=3412
        ->  Sort  (cost=8539.11..8540.86 rows=702 width=1385) (actual time=3.283..3.292 rows=125 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Sort Method: quicksort  Memory: 161kB
              Buffers: shared hit=3412
              ->  Hash Join  (cost=254.32..8505.92 rows=702 width=1385) (actual time=1.051..3.190 rows=125 loops=1)
                    Hash Cond: (variants.commit_seq = commit_hash.seq)
                    Buffers: shared hit=3412
                    ->  Nested Loop  (cost=160.42..8410.18 rows=702 width=1330) (actual time=0.376..2.480 rows=125 loops=1)
                          Buffers: shared hit=3380
                          ->  Nested Loop  (cost=160.00..8052.72 rows=702 width=341) (actual time=0.350..2.181 rows=125 loops=1)
                                Join Filter: (variants.version_id = v.id)
                                Buffers: shared hit=2880
                                ->  Nested Loop  (cost=159.57..7977.45 rows=50 width=53) (actual time=0.347..2.022 rows=49 loops=1)
                                      Buffers: shared hit=2667
                                      ->  Nested Loop  (cost=159.15..7954.98 rows=50 width=30) (actual time=0.340..1.853 rows=49 loops=1)
                                            Buffers: shared hit=2471
                                            ->  Nested Loop  (cost=158.71..7937.02 rows=50 width=12) (actual time=0.331..1.662 rows=49 loops=1)
                                                  Buffers: shared hit=2275
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.007..0.013 rows=50 loops=1)
                                                  ->  Limit  (cost=158.71..158.71 rows=1 width=20) (actual time=0.032..0.032 rows=1 loops=50)
                                                        Buffers: shared hit=2275
                                                        ->  Sort  (cost=158.71..158.79 rows=33 width=20) (actual time=0.032..0.032 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, v.sort_key DESC
                                                              Sort Method: quicksort  Memory: 25kB
                                                              Buffers: shared hit=2275
                                                              ->  Index Scan using versions_semver_idx on versions v  (cost=0.43..158.54 rows=33 width=20) (actual time=0.008..0.029 rows=10 loops=50)
                                                                    Index Cond: (package_id = hits.package_id)
                                                                    Filter: (NOT prerelease)
                                                                    Rows Removed by Filter: 2
                                                                    Buffers: shared hit=2275
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..33.98 rows=14 width=0) (actual time=0.002..0.002 rows=1 loops=511)
                                                                            Index Cond: (version_id = v.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=2045
                                            ->  Memoize  (cost=0.44..8.46 rows=1 width=18) (actual time=0.004..0.004 rows=1 loops=49)
                                                  Cache Key: v.id
                                                  Cache Mode: logical
                                                  Hits: 0  Misses: 49  Evictions: 0  Overflows: 0  Memory Usage: 6kB
                                                  Buffers: shared hit=196
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=49)
                                                        Index Cond: (id = v.id)
                                                        Buffers: shared hit=196
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.45 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=49)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=196
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.33 rows=14 width=300) (actual time=0.002..0.002 rows=3 loops=49)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=213
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.002..0.002 rows=1 loops=125)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=500
                    ->  Hash  (cost=59.51..59.51 rows=2751 width=53) (actual time=0.670..0.670 rows=2790 loops=1)
                          Buckets: 4096  Batches: 1  Memory Usage: 283kB
                          Buffers: shared hit=32
                          ->  Seq Scan on commits commit_hash  (cost=0.00..59.51 rows=2751 width=53) (actual time=0.011..0.301 rows=2790 loops=1)
                                Buffers: shared hit=32
Planning:
  Buffers: shared hit=80
Planning Time: 2.481 ms
Execution Time: 3.423 ms
```

### batched fetch, all versions — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 11.745 ms

```
Limit  (cost=120.43..1483.70 rows=1000 width=1400) (actual time=3.089..11.547 rows=634 loops=1)
  Buffers: shared hit=12198
  ->  Unique  (cost=120.43..6011.11 rows=4321 width=1400) (actual time=3.088..11.493 rows=634 loops=1)
        Buffers: shared hit=12198
        ->  Incremental Sort  (cost=120.43..5978.71 rows=4321 width=1400) (actual time=3.087..10.946 rows=2158 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 19  Sort Method: quicksort  Average Memory: 126kB  Peak Memory: 126kB
              Pre-sorted Groups: 13  Sort Method: quicksort  Average Memory: 873kB  Peak Memory: 873kB
              Buffers: shared hit=12198
              ->  Nested Loop  (cost=2.00..5784.70 rows=4321 width=1400) (actual time=0.059..7.687 rows=2158 loops=1)
                    Buffers: shared hit=12198
                    ->  Nested Loop  (cost=1.71..5141.86 rows=4321 width=1345) (actual time=0.049..6.454 rows=2158 loops=1)
                          Buffers: shared hit=11685
                          ->  Nested Loop  (cost=1.28..2941.58 rows=4321 width=356) (actual time=0.042..3.076 rows=2158 loops=1)
                                Buffers: shared hit=3053
                                ->  Nested Loop  (cost=0.85..512.68 rows=1652 width=64) (actual time=0.033..0.716 rows=634 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=417
                                      ->  Nested Loop  (cost=0.42..422.50 rows=50 width=43) (actual time=0.023..0.216 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.016 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.39 rows=33 width=33) (actual time=0.004..0.008 rows=13 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=217
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.33 rows=14 width=300) (actual time=0.002..0.003 rows=3 loops=634)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=2636
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.001..0.001 rows=1 loops=2158)
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
  Buffers: shared hit=58
Planning Time: 2.133 ms
Execution Time: 11.745 ms
```

## Name lookups (/v2/resolve, /v1/resolve, /v2/pkg, /v1/pkg)

### pick latest version — name=go

Parameters: `["go"]` — Execution Time: 5.170 ms

```
Limit  (cost=1386.08..1386.08 rows=1 width=19) (actual time=5.086..5.089 rows=1 loops=1)
  Buffers: shared hit=9284
  ->  Sort  (cost=1386.08..1386.40 rows=130 width=19) (actual time=5.084..5.087 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=9284
        ->  Nested Loop  (cost=151.36..1385.43 rows=130 width=19) (actual time=1.151..4.983 rows=644 loops=1)
              Buffers: shared hit=9284
              ->  Nested Loop  (cost=150.93..1327.64 rows=130 width=23) (actual time=1.143..3.727 rows=644 loops=1)
                    Buffers: shared hit=6707
                    ->  Nested Loop  (cost=150.51..1266.47 rows=131 width=4) (actual time=1.137..2.571 rows=719 loops=1)
                          Buffers: shared hit=3831
                          ->  HashAggregate  (cost=150.08..151.40 rows=132 width=4) (actual time=1.130..1.220 rows=719 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=953
                                ->  Append  (cost=1.28..149.75 rows=132 width=4) (actual time=0.031..0.941 rows=976 loops=1)
                                      Buffers: shared hit=953
                                      ->  Nested Loop  (cost=1.28..82.85 rows=16 width=4) (actual time=0.030..0.786 rows=719 loops=1)
                                            Buffers: shared hit=890
                                            ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.023..0.095 rows=191 loops=1)
                                                  Buffers: shared hit=23
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.012 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'go'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (actual time=0.009..0.058 rows=191 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=19
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.33 rows=14 width=8) (actual time=0.002..0.003 rows=4 loops=191)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=867
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..66.24 rows=116 width=4) (actual time=0.008..0.078 rows=257 loops=1)
                                            Index Cond: (attr_path = 'go'::text)
                                            Buffers: shared hit=63
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=719)
                                Index Cond: (id = va.id)
                                Filter: (NOT broken)
                                Buffers: shared hit=2877
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=719)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=2876
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=644)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 0
                    Buffers: shared hit=2577
Planning:
  Buffers: shared hit=76
Planning Time: 1.639 ms
Execution Time: 5.170 ms
```

### pick latest version — name=python

Parameters: `["python"]` — Execution Time: 4.034 ms

```
Limit  (cost=1386.08..1386.08 rows=1 width=19) (actual time=3.952..3.955 rows=1 loops=1)
  Buffers: shared hit=7536
  ->  Sort  (cost=1386.08..1386.40 rows=130 width=19) (actual time=3.950..3.953 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=7536
        ->  Nested Loop  (cost=151.36..1385.43 rows=130 width=19) (actual time=0.836..3.887 rows=409 loops=1)
              Buffers: shared hit=7536
              ->  Nested Loop  (cost=150.93..1327.64 rows=130 width=23) (actual time=0.827..3.103 rows=409 loops=1)
                    Buffers: shared hit=5899
                    ->  Nested Loop  (cost=150.51..1266.47 rows=131 width=4) (actual time=0.821..2.065 rows=642 loops=1)
                          Buffers: shared hit=3331
                          ->  HashAggregate  (cost=150.08..151.40 rows=132 width=4) (actual time=0.814..0.906 rows=642 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=763
                                ->  Append  (cost=1.28..149.75 rows=132 width=4) (actual time=0.032..0.691 rows=645 loops=1)
                                      Buffers: shared hit=763
                                      ->  Nested Loop  (cost=1.28..82.85 rows=16 width=4) (actual time=0.031..0.633 rows=642 loops=1)
                                            Buffers: shared hit=759
                                            ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.023..0.092 rows=176 loops=1)
                                                  Buffers: shared hit=22
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.012 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'python'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (actual time=0.009..0.058 rows=176 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=18
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.33 rows=14 width=8) (actual time=0.002..0.003 rows=4 loops=176)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=737
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..66.24 rows=116 width=4) (actual time=0.007..0.008 rows=3 loops=1)
                                            Index Cond: (attr_path = 'python'::text)
                                            Buffers: shared hit=4
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
                    Heap Fetches: 0
                    Buffers: shared hit=1637
Planning:
  Buffers: shared hit=76
Planning Time: 1.629 ms
Execution Time: 4.034 ms
```

### pick latest version — name=python311

Parameters: `["python311"]` — Execution Time: 0.575 ms

```
Limit  (cost=1386.08..1386.08 rows=1 width=19) (actual time=0.516..0.517 rows=1 loops=1)
  Buffers: shared hit=916
  ->  Sort  (cost=1386.08..1386.40 rows=130 width=19) (actual time=0.515..0.516 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=916
        ->  Nested Loop  (cost=151.36..1385.43 rows=130 width=19) (actual time=0.103..0.502 rows=51 loops=1)
              Buffers: shared hit=916
              ->  Nested Loop  (cost=150.93..1327.64 rows=130 width=23) (actual time=0.093..0.395 rows=51 loops=1)
                    Buffers: shared hit=711
                    ->  Nested Loop  (cost=150.51..1266.47 rows=131 width=4) (actual time=0.086..0.250 rows=87 loops=1)
                          Buffers: shared hit=363
                          ->  HashAggregate  (cost=150.08..151.40 rows=132 width=4) (actual time=0.077..0.089 rows=87 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=15
                                ->  Append  (cost=1.28..149.75 rows=132 width=4) (actual time=0.019..0.061 rows=87 loops=1)
                                      Buffers: shared hit=15
                                      ->  Nested Loop  (cost=1.28..82.85 rows=16 width=4) (actual time=0.010..0.010 rows=0 loops=1)
                                            Buffers: shared hit=3
                                            ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.010..0.010 rows=0 loops=1)
                                                  Buffers: shared hit=3
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.010..0.010 rows=0 loops=1)
                                                        Index Cond: (lower(name) = 'python311'::text)
                                                        Buffers: shared hit=3
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (never executed)
                                                        Index Cond: (package_id = p.id)
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.33 rows=14 width=8) (never executed)
                                                  Index Cond: (version_id = ve.id)
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..66.24 rows=116 width=4) (actual time=0.009..0.043 rows=87 loops=1)
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
Planning Time: 1.549 ms
Execution Time: 0.575 ms
```

### pick latest version — name=hello

Parameters: `["hello"]` — Execution Time: 0.302 ms

```
Limit  (cost=1386.08..1386.08 rows=1 width=19) (actual time=0.198..0.200 rows=1 loops=1)
  Buffers: shared hit=265
  ->  Sort  (cost=1386.08..1386.40 rows=130 width=19) (actual time=0.197..0.198 rows=1 loops=1)
        Sort Key: versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=265
        ->  Nested Loop  (cost=151.36..1385.43 rows=130 width=19) (actual time=0.093..0.190 rows=19 loops=1)
              Buffers: shared hit=265
              ->  Nested Loop  (cost=150.93..1327.64 rows=130 width=23) (actual time=0.087..0.149 rows=19 loops=1)
                    Buffers: shared hit=188
                    ->  Nested Loop  (cost=150.51..1266.47 rows=131 width=4) (actual time=0.081..0.116 rows=19 loops=1)
                          Buffers: shared hit=112
                          ->  HashAggregate  (cost=150.08..151.40 rows=132 width=4) (actual time=0.074..0.078 rows=19 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=36
                                ->  Append  (cost=1.28..149.75 rows=132 width=4) (actual time=0.029..0.064 rows=38 loops=1)
                                      Buffers: shared hit=36
                                      ->  Nested Loop  (cost=1.28..82.85 rows=16 width=4) (actual time=0.028..0.049 rows=19 loops=1)
                                            Buffers: shared hit=29
                                            ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.020..0.022 rows=5 loops=1)
                                                  Buffers: shared hit=8
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.010..0.011 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'hello'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (actual time=0.007..0.008 rows=5 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=4
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.33 rows=14 width=8) (actual time=0.003..0.005 rows=4 loops=5)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=21
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..66.24 rows=116 width=4) (actual time=0.006..0.011 rows=19 loops=1)
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
                    Heap Fetches: 0
                    Buffers: shared hit=77
Planning:
  Buffers: shared hit=76
Planning Time: 1.645 ms
Execution Time: 0.302 ms
```

### every version — name=go

Parameters: `["go"]` — Execution Time: 8.214 ms

```
Limit  (cost=1498.54..1498.87 rows=132 width=1392) (actual time=7.892..7.991 rows=719 loops=1)
  Buffers: shared hit=14616
  ->  Sort  (cost=1498.54..1498.87 rows=132 width=1392) (actual time=7.891..7.936 rows=719 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 737kB
        Buffers: shared hit=14616
        ->  Nested Loop  (cost=152.06..1493.89 rows=132 width=1392) (actual time=1.103..7.183 rows=719 loops=1)
              Buffers: shared hit=14616
              ->  Nested Loop  (cost=151.78..1454.61 rows=132 width=1337) (actual time=1.098..6.138 rows=719 loops=1)
                    Buffers: shared hit=12459
                    ->  Nested Loop  (cost=151.36..1387.40 rows=132 width=348) (actual time=1.091..4.954 rows=719 loops=1)
                          Buffers: shared hit=9583
                          ->  Nested Loop  (cost=150.93..1328.08 rows=132 width=325) (actual time=1.086..3.833 rows=719 loops=1)
                                Buffers: shared hit=6707
                                ->  Nested Loop  (cost=150.51..1266.47 rows=132 width=300) (actual time=1.080..2.600 rows=719 loops=1)
                                      Buffers: shared hit=3831
                                      ->  HashAggregate  (cost=150.08..151.40 rows=132 width=4) (actual time=1.074..1.178 rows=719 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=953
                                            ->  Append  (cost=1.28..149.75 rows=132 width=4) (actual time=0.034..0.905 rows=976 loops=1)
                                                  Buffers: shared hit=953
                                                  ->  Nested Loop  (cost=1.28..82.85 rows=16 width=4) (actual time=0.033..0.752 rows=719 loops=1)
                                                        Buffers: shared hit=890
                                                        ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.026..0.099 rows=191 loops=1)
                                                              Buffers: shared hit=23
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.015..0.016 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'go'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (actual time=0.009..0.058 rows=191 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=19
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.33 rows=14 width=8) (actual time=0.002..0.003 rows=4 loops=191)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=867
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..66.24 rows=116 width=4) (actual time=0.009..0.077 rows=257 loops=1)
                                                        Index Cond: (attr_path = 'go'::text)
                                                        Buffers: shared hit=63
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=304) (actual time=0.002..0.002 rows=1 loops=719)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=2877
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=719)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=2876
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.45 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=719)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=2876
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.001..0.001 rows=1 loops=719)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=2876
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=719)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=2157
Planning:
  Buffers: shared hit=96
Planning Time: 2.733 ms
Execution Time: 8.214 ms
```

### every version — name=python

Parameters: `["python"]` — Execution Time: 7.868 ms

```
Limit  (cost=1498.54..1498.87 rows=132 width=1392) (actual time=7.512..7.604 rows=642 loops=1)
  Buffers: shared hit=12961
  ->  Sort  (cost=1498.54..1498.87 rows=132 width=1392) (actual time=7.510..7.554 rows=642 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 1282kB
        Buffers: shared hit=12961
        ->  Nested Loop  (cost=152.06..1493.89 rows=132 width=1392) (actual time=0.860..6.747 rows=642 loops=1)
              Buffers: shared hit=12961
              ->  Nested Loop  (cost=151.78..1454.61 rows=132 width=1337) (actual time=0.853..5.693 rows=642 loops=1)
                    Buffers: shared hit=11035
                    ->  Nested Loop  (cost=151.36..1387.40 rows=132 width=348) (actual time=0.843..4.546 rows=642 loops=1)
                          Buffers: shared hit=8467
                          ->  Nested Loop  (cost=150.93..1328.08 rows=132 width=325) (actual time=0.837..3.464 rows=642 loops=1)
                                Buffers: shared hit=5899
                                ->  Nested Loop  (cost=150.51..1266.47 rows=132 width=300) (actual time=0.830..2.310 rows=642 loops=1)
                                      Buffers: shared hit=3331
                                      ->  HashAggregate  (cost=150.08..151.40 rows=132 width=4) (actual time=0.823..0.964 rows=642 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=763
                                            ->  Append  (cost=1.28..149.75 rows=132 width=4) (actual time=0.036..0.698 rows=645 loops=1)
                                                  Buffers: shared hit=763
                                                  ->  Nested Loop  (cost=1.28..82.85 rows=16 width=4) (actual time=0.035..0.638 rows=642 loops=1)
                                                        Buffers: shared hit=759
                                                        ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.027..0.096 rows=176 loops=1)
                                                              Buffers: shared hit=22
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.014..0.016 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'python'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (actual time=0.010..0.057 rows=176 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=18
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.33 rows=14 width=8) (actual time=0.002..0.003 rows=4 loops=176)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=737
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..66.24 rows=116 width=4) (actual time=0.007..0.008 rows=3 loops=1)
                                                        Index Cond: (attr_path = 'python'::text)
                                                        Buffers: shared hit=4
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=304) (actual time=0.002..0.002 rows=1 loops=642)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=2568
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=642)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=2568
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.45 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=642)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=2568
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=997) (actual time=0.001..0.001 rows=1 loops=642)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=2568
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=642)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=1926
Planning:
  Buffers: shared hit=96
Planning Time: 2.669 ms
Execution Time: 7.868 ms
```

### every version — name=python311

Parameters: `["python311"]` — Execution Time: 1.094 ms

```
Limit  (cost=1498.54..1498.87 rows=132 width=1392) (actual time=0.963..0.976 rows=87 loops=1)
  Buffers: shared hit=1668
  ->  Sort  (cost=1498.54..1498.87 rows=132 width=1392) (actual time=0.961..0.967 rows=87 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 199kB
        Buffers: shared hit=1668
        ->  Nested Loop  (cost=152.06..1493.89 rows=132 width=1392) (actual time=0.118..0.864 rows=87 loops=1)
              Buffers: shared hit=1668
              ->  Nested Loop  (cost=151.78..1454.61 rows=132 width=1337) (actual time=0.113..0.713 rows=87 loops=1)
                    Buffers: shared hit=1407
                    ->  Nested Loop  (cost=151.36..1387.40 rows=132 width=348) (actual time=0.106..0.561 rows=87 loops=1)
                          Buffers: shared hit=1059
                          ->  Nested Loop  (cost=150.93..1328.08 rows=132 width=325) (actual time=0.099..0.423 rows=87 loops=1)
                                Buffers: shared hit=711
                                ->  Nested Loop  (cost=150.51..1266.47 rows=132 width=300) (actual time=0.091..0.274 rows=87 loops=1)
                                      Buffers: shared hit=363
                                      ->  HashAggregate  (cost=150.08..151.40 rows=132 width=4) (actual time=0.082..0.097 rows=87 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=15
                                            ->  Append  (cost=1.28..149.75 rows=132 width=4) (actual time=0.023..0.066 rows=87 loops=1)
                                                  Buffers: shared hit=15
                                                  ->  Nested Loop  (cost=1.28..82.85 rows=16 width=4) (actual time=0.012..0.013 rows=0 loops=1)
                                                        Buffers: shared hit=3
                                                        ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.012..0.012 rows=0 loops=1)
                                                              Buffers: shared hit=3
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.012 rows=0 loops=1)
                                                                    Index Cond: (lower(name) = 'python311'::text)
                                                                    Buffers: shared hit=3
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (never executed)
                                                                    Index Cond: (package_id = p.id)
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.33 rows=14 width=8) (never executed)
                                                              Index Cond: (version_id = ve.id)
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..66.24 rows=116 width=4) (actual time=0.010..0.045 rows=87 loops=1)
                                                        Index Cond: (attr_path = 'python311'::text)
                                                        Buffers: shared hit=12
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=304) (actual time=0.002..0.002 rows=1 loops=87)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=348
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=87)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=348
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.45 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=87)
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
Planning Time: 2.788 ms
Execution Time: 1.094 ms
```

### every version — name=hello

Parameters: `["hello"]` — Execution Time: 0.379 ms

```
Limit  (cost=1498.54..1498.87 rows=132 width=1392) (actual time=0.292..0.296 rows=19 loops=1)
  Buffers: shared hit=397
  ->  Sort  (cost=1498.54..1498.87 rows=132 width=1392) (actual time=0.291..0.294 rows=19 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 63kB
        Buffers: shared hit=397
        ->  Nested Loop  (cost=152.06..1493.89 rows=132 width=1392) (actual time=0.104..0.265 rows=19 loops=1)
              Buffers: shared hit=397
              ->  Nested Loop  (cost=151.78..1454.61 rows=132 width=1337) (actual time=0.100..0.229 rows=19 loops=1)
                    Buffers: shared hit=340
                    ->  Nested Loop  (cost=151.36..1387.40 rows=132 width=348) (actual time=0.093..0.190 rows=19 loops=1)
                          Buffers: shared hit=264
                          ->  Nested Loop  (cost=150.93..1328.08 rows=132 width=325) (actual time=0.089..0.158 rows=19 loops=1)
                                Buffers: shared hit=188
                                ->  Nested Loop  (cost=150.51..1266.47 rows=132 width=300) (actual time=0.083..0.121 rows=19 loops=1)
                                      Buffers: shared hit=112
                                      ->  HashAggregate  (cost=150.08..151.40 rows=132 width=4) (actual time=0.077..0.081 rows=19 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=36
                                            ->  Append  (cost=1.28..149.75 rows=132 width=4) (actual time=0.031..0.066 rows=38 loops=1)
                                                  Buffers: shared hit=36
                                                  ->  Nested Loop  (cost=1.28..82.85 rows=16 width=4) (actual time=0.031..0.051 rows=19 loops=1)
                                                        Buffers: shared hit=29
                                                        ->  Nested Loop  (cost=0.85..74.03 rows=6 width=4) (actual time=0.023..0.026 rows=5 loops=1)
                                                              Buffers: shared hit=8
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.013 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'hello'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..65.26 rows=33 width=8) (actual time=0.007..0.009 rows=5 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=4
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.33 rows=14 width=8) (actual time=0.003..0.004 rows=4 loops=5)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=21
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..66.24 rows=116 width=4) (actual time=0.006..0.011 rows=19 loops=1)
                                                        Index Cond: (attr_path = 'hello'::text)
                                                        Buffers: shared hit=7
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=304) (actual time=0.002..0.002 rows=1 loops=19)
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
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=19)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=57
Planning:
  Buffers: shared hit=96
Planning Time: 2.862 ms
Execution Time: 0.379 ms
```

