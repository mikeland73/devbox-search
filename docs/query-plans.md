# Serving query plans

Recorded 2026-09-24 with `node tools/explain-plans.mjs` against a Neon branch of the production database (same data, taken today) with migration 0005 applied — the plans production will have once it is.
Regenerate after changing apps/web/lib/search.ts or the indexes, and diff.
Warm plans (second run); see the script for what each statement is.

Table sizes: packages=251024, versions=1470957, variants=3840412, search_terms=251614

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
- **Ranked terms** is two tiers. The `breadth` probe is an index scan of
  `search_terms_name_lower_idx` stopped by its LIMIT, and it gates the `prefix` arms with
  `One-Time Filter`s. For a narrow phrase (`go`, `hello`) only the first arm runs: a
  `BitmapOr` of `search_terms_name_lower_idx` and `search_terms_attr_path_lower_idx`. For a
  broad one (`python`) that arm shows `(never executed)`, the alias arm scans
  `search_terms_alias_idx` (a few hundred rows), and the two nearest-match arms are
  `Index Scan`s of `search_terms_top_level_name_knn_idx` / `search_terms_nested_name_knn_idx`
  ordered by `<->` under an `Incremental Sort` and a `Limit` of 50. A seq scan or a
  full-arm `Sort` of tens of thousands of rows here is the old cost coming back:
  similarity() over every prefix match was ~0.4 s for `python`, 70k rows. `-` has no
  trigrams and takes the scoring path with no probe. The `fuzzy` arm must sit under a
  `One-Time Filter` and show `(never executed)` whenever the prefix tier is full (`go`,
  `python`); it runs for `hello` and `-`. A `%` in the prefix arms, or a fuzzy arm that
  ran for `python`, is a regression: `%` is cheap to index but every GIN candidate is
  rechecked with similarity() — ~1.1 s of CPU for `python` when both tiers were one
  OR'd WHERE.

## Phrase search (/v2/search, /v1/search)

### ranked terms — q=go

Parameters: `["go","go"]` — Execution Time: 3.122 ms

```
Limit  (cost=2142.67..2142.79 rows=50 width=44) (actual time=2.155..2.177 rows=50 loops=1)
  Buffers: shared hit=47
  CTE breadth
    ->  Aggregate  (cost=35.59..35.61 rows=1 width=1) (actual time=0.299..0.300 rows=1 loops=1)
          Buffers: shared hit=24
          ->  Limit  (cost=0.42..34.54 rows=84 width=4) (actual time=0.038..0.267 rows=450 loops=1)
                Buffers: shared hit=24
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..34.54 rows=84 width=4) (actual time=0.037..0.226 rows=450 loops=1)
                      Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                      Filter: (lower(name) ~~ 'go%'::text)
                      Buffers: shared hit=24
  CTE prefix
    ->  Limit  (cost=1187.72..1187.85 rows=50 width=39) (actual time=2.051..2.064 rows=50 loops=1)
          Buffers: shared hit=47
          ->  Sort  (cost=1187.72..1188.22 rows=200 width=39) (actual time=2.051..2.059 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'go'::text) ELSE GREATEST(similarity(search_terms_3.name, 'go'::text), similarity(search_terms_3.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: top-N heapsort  Memory: 30kB
                Buffers: shared hit=47
                ->  HashAggregate  (cost=1179.08..1181.08 rows=200 width=39) (actual time=1.915..1.972 rows=435 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Batches: 1  Memory Usage: 109kB
                      Buffers: shared hit=47
                      ->  Append  (cost=10.27..1164.32 rows=281 width=68) (actual time=0.369..0.709 rows=450 loops=1)
                            Buffers: shared hit=47
                            ->  Result  (cost=10.27..460.43 rows=109 width=68) (actual time=0.368..0.643 rows=450 loops=1)
                                  One-Time Filter: (NOT (InitPlan 2).col1)
                                  Buffers: shared hit=47
                                  InitPlan 2
                                    ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=0.301..0.301 rows=1 loops=1)
                                          Buffers: shared hit=24
                                  ->  Bitmap Heap Scan on search_terms search_terms_3  (cost=10.27..460.43 rows=109 width=68) (actual time=0.065..0.282 rows=450 loops=1)
                                        Recheck Cond: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                        Filter: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                        Heap Blocks: exact=13
                                        Buffers: shared hit=23
                                        ->  BitmapOr  (cost=10.25..10.25 rows=136 width=0) (actual time=0.050..0.051 rows=0 loops=1)
                                              Buffers: shared hit=10
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..5.39 rows=97 width=0) (actual time=0.021..0.021 rows=450 loops=1)
                                                    Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                                    Buffers: shared hit=5
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.81 rows=39 width=0) (actual time=0.028..0.029 rows=450 loops=1)
                                                    Index Cond: ((lower(attr_path) >= 'go'::text) AND (lower(attr_path) < 'gp'::text))
                                                    Buffers: shared hit=5
                            ->  Result  (cost=9.34..224.92 rows=60 width=68) (actual time=0.002..0.003 rows=0 loops=1)
                                  One-Time Filter: (InitPlan 3).col1
                                  InitPlan 3
                                    ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.001..0.001 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=9.34..224.92 rows=60 width=68) (never executed)
                                        Recheck Cond: ((lower(name) = 'go'::text) OR (lower(attr_path) = 'go'::text))
                                        ->  BitmapOr  (cost=9.32..9.32 rows=60 width=0) (never executed)
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.86 rows=59 width=0) (never executed)
                                                    Index Cond: (lower(name) = 'go'::text)
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                    Index Cond: (lower(attr_path) = 'go'::text)
                            ->  Result  (cost=10.27..460.77 rows=108 width=68) (actual time=0.001..0.002 rows=0 loops=1)
                                  One-Time Filter: (InitPlan 4).col1
                                  InitPlan 4
                                    ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_5  (cost=10.27..460.77 rows=108 width=68) (never executed)
                                        Recheck Cond: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                        Filter: ((name <> attr_path) AND ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text)))
                                        ->  BitmapOr  (cost=10.25..10.25 rows=136 width=0) (never executed)
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..5.39 rows=97 width=0) (never executed)
                                                    Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.81 rows=39 width=0) (never executed)
                                                    Index Cond: ((lower(attr_path) >= 'go'::text) AND (lower(attr_path) < 'gp'::text))
                            ->  Subquery Scan on "*SELECT* 4"  (cost=8.33..8.40 rows=2 width=68) (actual time=0.012..0.013 rows=0 loops=1)
                                  ->  Limit  (cost=8.33..8.38 rows=2 width=72) (actual time=0.011..0.012 rows=0 loops=1)
                                        InitPlan 5
                                          ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=8.31..8.36 rows=2 width=72) (actual time=0.011..0.011 rows=0 loops=1)
                                              Sort Key: ((lower(search_terms_6.name) <-> 'go'::text)), search_terms_6.name
                                              Presorted Key: ((lower(search_terms_6.name) <-> 'go'::text))
                                              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                              ->  Result  (cost=0.28..8.30 rows=1 width=72) (actual time=0.001..0.001 rows=0 loops=1)
                                                    One-Time Filter: (InitPlan 5).col1
                                                    ->  Index Scan using search_terms_top_level_name_knn_idx on search_terms search_terms_6  (cost=0.28..8.30 rows=1 width=68) (never executed)
                                                          Index Cond: (lower(name) ~~ 'go%'::text)
                                                          Order By: (lower(name) <-> 'go'::text)
                            ->  Subquery Scan on "*SELECT* 5"  (cost=8.34..8.40 rows=2 width=68) (actual time=0.005..0.005 rows=0 loops=1)
                                  ->  Limit  (cost=8.34..8.38 rows=2 width=72) (actual time=0.004..0.005 rows=0 loops=1)
                                        InitPlan 6
                                          ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=8.32..8.36 rows=2 width=72) (actual time=0.004..0.004 rows=0 loops=1)
                                              Sort Key: ((lower(search_terms_7.name) <-> 'go'::text)), search_terms_7.name
                                              Presorted Key: ((lower(search_terms_7.name) <-> 'go'::text))
                                              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                              ->  Result  (cost=0.28..8.31 rows=1 width=72) (actual time=0.001..0.001 rows=0 loops=1)
                                                    One-Time Filter: (InitPlan 6).col1
                                                    ->  Index Scan using search_terms_nested_name_knn_idx on search_terms search_terms_7  (cost=0.28..8.30 rows=1 width=68) (never executed)
                                                          Index Cond: (lower(name) ~~ 'go%'::text)
                                                          Order By: (lower(name) <-> 'go'::text)
  ->  Sort  (cost=919.21..919.46 rows=100 width=44) (actual time=2.154..2.166 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=47
        ->  GroupAggregate  (cost=913.89..915.89 rows=100 width=44) (actual time=2.114..2.136 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=47
              ->  Sort  (cost=913.89..914.14 rows=100 width=42) (actual time=2.111..2.115 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=47
                    ->  Append  (cost=0.00..910.57 rows=100 width=42) (actual time=2.054..2.098 rows=50 loops=1)
                          Buffers: shared hit=47
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=2.053..2.068 rows=50 loops=1)
                                Buffers: shared hit=47
                          ->  Subquery Scan on fuzzy  (cost=908.44..909.07 rows=50 width=39) (actual time=0.024..0.025 rows=0 loops=1)
                                ->  Limit  (cost=908.44..908.57 rows=50 width=39) (actual time=0.023..0.024 rows=0 loops=1)
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.008..0.008 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.004 rows=50 loops=1)
                                      ->  Sort  (cost=907.31..907.58 rows=109 width=39) (actual time=0.023..0.024 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'go'::text) ELSE GREATEST(similarity(search_terms.name, 'go'::text), similarity(search_terms.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            ->  GroupAggregate  (cost=896.60..903.69 rows=109 width=39) (actual time=0.014..0.015 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  ->  Sort  (cost=896.60..896.88 rows=109 width=68) (actual time=0.013..0.014 rows=0 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        ->  Result  (cost=520.07..892.91 rows=109 width=68) (actual time=0.010..0.010 rows=0 loops=1)
                                                              One-Time Filter: ((InitPlan 8).col1 < 50)
                                                              ->  Bitmap Heap Scan on search_terms  (cost=520.07..892.91 rows=109 width=68) (never executed)
                                                                    Recheck Cond: ((name % 'go'::text) OR (attr_path % 'go'::text))
                                                                    Filter: ((lower(name) !~~ 'go%'::text) AND (lower(attr_path) !~~ 'go%'::text))
                                                                    ->  BitmapOr  (cost=520.06..520.06 rows=109 width=0) (never executed)
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..260.15 rows=84 width=0) (never executed)
                                                                                Index Cond: (name % 'go'::text)
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..259.86 rows=25 width=0) (never executed)
                                                                                Index Cond: (attr_path % 'go'::text)
Planning:
  Buffers: shared hit=4
Planning Time: 1.466 ms
Execution Time: 3.122 ms
```

### batched fetch, latest — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 13.156 ms

```
Limit  (cost=4130.51..104793.00 rows=50 width=1377) (actual time=4.916..13.036 rows=50 loops=1)
  Buffers: shared hit=22850
  ->  Unique  (cost=4130.51..104793.00 rows=50 width=1377) (actual time=4.915..13.031 rows=50 loops=1)
        Buffers: shared hit=22850
        ->  Incremental Sort  (cost=4130.51..104791.32 rows=672 width=1377) (actual time=4.914..12.991 rows=172 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 6  Sort Method: quicksort  Average Memory: 55kB  Peak Memory: 55kB
              Buffers: shared hit=22850
              ->  Nested Loop  (cost=2076.40..104769.33 rows=672 width=1377) (actual time=3.559..12.839 rows=175 loops=1)
                    Buffers: shared hit=22850
                    ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.007..0.016 rows=50 loops=1)
                    ->  Nested Loop  (cost=2076.40..2095.25 rows=13 width=1359) (actual time=0.246..0.256 rows=4 loops=50)
                          Buffers: shared hit=22850
                          ->  Nested Loop  (cost=2076.12..2091.38 rows=13 width=1314) (actual time=0.244..0.251 rows=4 loops=50)
                                Buffers: shared hit=22325
                                ->  Nested Loop  (cost=2075.69..2084.76 rows=13 width=331) (actual time=0.241..0.244 rows=4 loops=50)
                                      Join Filter: (variants.version_id = versions_1.id)
                                      Buffers: shared hit=21625
                                      ->  Nested Loop  (cost=2075.26..2083.32 rows=1 width=45) (actual time=0.239..0.240 rows=1 loops=50)
                                            Buffers: shared hit=21336
                                            ->  Nested Loop  (cost=2074.84..2082.87 rows=1 width=22) (actual time=0.237..0.237 rows=1 loops=50)
                                                  Buffers: shared hit=21136
                                                  ->  Limit  (cost=2074.42..2074.42 rows=1 width=24) (actual time=0.235..0.235 rows=1 loops=50)
                                                        Buffers: shared hit=20936
                                                        ->  Sort  (cost=2074.42..2074.63 rows=85 width=24) (actual time=0.234..0.234 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=20936
                                                              ->  Nested Loop  (cost=0.86..2073.99 rows=85 width=24) (actual time=0.011..0.224 rows=45 loops=50)
                                                                    Buffers: shared hit=20936
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.003..0.007 rows=12 loops=50)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Rows Removed by Filter: 0
                                                                          Buffers: shared hit=240
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..32.45 rows=13 width=8) (actual time=0.002..0.003 rows=4 loops=614)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=2707
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.001..0.001 rows=1 loops=2232)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=8928
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=2232)
                                                                            Buffers: shared hit=9061
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=2232)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=9061
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=50)
                                                        Index Cond: (id = versions_1.id)
                                                        Buffers: shared hit=200
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                                  Index Cond: (id = versions.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.001..0.003 rows=4 loops=50)
                                            Index Cond: (version_id = versions.id)
                                            Buffers: shared hit=289
                                ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=175)
                                      Index Cond: (id = variants.meta_id)
                                      Buffers: shared hit=700
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=175)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=525
Planning:
  Buffers: shared hit=112
Planning Time: 12.376 ms
Execution Time: 13.156 ms
```

### batched fetch, all versions — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 12.948 ms

```
Limit  (cost=116.51..1458.29 rows=1000 width=1392) (actual time=3.629..12.753 rows=634 loops=1)
  Buffers: shared hit=13178
  ->  Unique  (cost=116.51..5813.71 rows=4246 width=1392) (actual time=3.628..12.700 rows=634 loops=1)
        Buffers: shared hit=13178
        ->  Incremental Sort  (cost=116.51..5781.86 rows=4246 width=1392) (actual time=3.627..12.147 rows=2307 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 21  Sort Method: quicksort  Average Memory: 70kB  Peak Memory: 75kB
              Pre-sorted Groups: 26  Sort Method: quicksort  Average Memory: 561kB  Peak Memory: 561kB
              Buffers: shared hit=13178
              ->  Nested Loop  (cost=1.99..5591.75 rows=4246 width=1392) (actual time=0.052..8.609 rows=2307 loops=1)
                    Buffers: shared hit=13178
                    ->  Nested Loop  (cost=1.70..4929.67 rows=4246 width=1337) (actual time=0.043..7.117 rows=2307 loops=1)
                          Buffers: shared hit=12470
                          ->  Nested Loop  (cost=1.28..2768.89 rows=4246 width=354) (actual time=0.037..3.218 rows=2307 loops=1)
                                Buffers: shared hit=3242
                                ->  Nested Loop  (cost=0.85..506.15 rows=1603 width=64) (actual time=0.031..0.593 rows=634 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=440
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.019..0.143 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.016 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.36 rows=32 width=33) (actual time=0.003..0.006 rows=13 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=240
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.002..0.003 rows=4 loops=634)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=2802
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=2307)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=9228
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=2307)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 2071  Misses: 236  Evictions: 0  Overflows: 0  Memory Usage: 37kB
                          Buffers: shared hit=708
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=236)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=708
Planning:
  Buffers: shared hit=68
Planning Time: 7.885 ms
Execution Time: 12.948 ms
```

### ranked terms — q=python

Parameters: `["python","python"]` — Execution Time: 35.942 ms

```
Limit  (cost=33055.95..33056.08 rows=50 width=44) (actual time=35.701..35.722 rows=50 loops=1)
  Buffers: shared hit=3634
  CTE breadth
    ->  Aggregate  (cost=797.17..797.18 rows=1 width=1) (actual time=5.317..5.318 rows=1 loops=1)
          Buffers: shared hit=396
          ->  Limit  (cost=0.42..672.17 rows=10000 width=4) (actual time=0.021..4.721 rows=10000 loops=1)
                Buffers: shared hit=396
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..4778.12 rows=71123 width=4) (actual time=0.020..3.918 rows=10000 loops=1)
                      Index Cond: ((lower(name) >= 'python'::text) AND (lower(name) < 'pythoo'::text))
                      Filter: (lower(name) ~~ 'python%'::text)
                      Buffers: shared hit=396
  CTE prefix
    ->  Limit  (cost=31441.52..31441.64 rows=50 width=39) (actual time=35.604..35.620 rows=50 loops=1)
          Buffers: shared hit=3634
          ->  Sort  (cost=31441.52..31502.47 rows=24382 width=39) (actual time=35.603..35.616 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'python'::text) ELSE GREATEST(similarity(search_terms_3.name, 'python'::text), similarity(search_terms_3.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: top-N heapsort  Memory: 31kB
                Buffers: shared hit=3634
                ->  HashAggregate  (cost=30387.74..30631.56 rows=24382 width=39) (actual time=35.424..35.562 rows=202 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Batches: 1  Memory Usage: 817kB
                      Buffers: shared hit=3634
                      ->  Append  (cost=0.02..17586.93 rows=243825 width=68) (actual time=5.340..34.533 rows=244 loops=1)
                            Buffers: shared hit=3634
                            ->  Result  (cost=0.02..7993.30 rows=122171 width=68) (actual time=5.320..5.322 rows=0 loops=1)
                                  One-Time Filter: (NOT (InitPlan 2).col1)
                                  Buffers: shared hit=396
                                  InitPlan 2
                                    ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=5.318..5.319 rows=1 loops=1)
                                          Buffers: shared hit=396
                                  ->  Seq Scan on search_terms search_terms_3  (cost=0.02..7993.30 rows=122171 width=68) (never executed)
                                        Filter: ((lower(name) ~~ 'python%'::text) OR (lower(attr_path) ~~ 'python%'::text))
                            ->  Result  (cost=8.88..16.76 rows=2 width=68) (actual time=0.019..0.025 rows=15 loops=1)
                                  One-Time Filter: (InitPlan 3).col1
                                  Buffers: shared hit=7
                                  InitPlan 3
                                    ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=68) (actual time=0.017..0.019 rows=15 loops=1)
                                        Recheck Cond: ((lower(name) = 'python'::text) OR (lower(attr_path) = 'python'::text))
                                        Heap Blocks: exact=1
                                        Buffers: shared hit=7
                                        ->  BitmapOr  (cost=8.86..8.86 rows=2 width=0) (actual time=0.011..0.012 rows=0 loops=1)
                                              Buffers: shared hit=6
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.006..0.006 rows=15 loops=1)
                                                    Index Cond: (lower(name) = 'python'::text)
                                                    Buffers: shared hit=3
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.004..0.005 rows=1 loops=1)
                                                    Index Cond: (lower(attr_path) = 'python'::text)
                                                    Buffers: shared hit=3
                            ->  Result  (cost=0.30..7995.55 rows=121560 width=68) (actual time=0.238..0.423 rows=166 loops=1)
                                  One-Time Filter: (InitPlan 4).col1
                                  Buffers: shared hit=156
                                  InitPlan 4
                                    ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Index Scan using search_terms_alias_idx on search_terms search_terms_5  (cost=0.30..7995.55 rows=121560 width=68) (actual time=0.237..0.402 rows=166 loops=1)
                                        Filter: ((lower(name) ~~ 'python%'::text) OR (lower(attr_path) ~~ 'python%'::text))
                                        Rows Removed by Filter: 429
                                        Buffers: shared hit=156
                            ->  Subquery Scan on "*SELECT* 4"  (cost=159.80..160.32 rows=42 width=68) (actual time=0.702..0.708 rows=13 loops=1)
                                  Buffers: shared hit=140
                                  ->  Limit  (cost=159.80..159.90 rows=42 width=72) (actual time=0.701..0.705 rows=13 loops=1)
                                        Buffers: shared hit=140
                                        InitPlan 5
                                          ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                        ->  Sort  (cost=159.78..159.88 rows=42 width=72) (actual time=0.700..0.702 rows=13 loops=1)
                                              Sort Key: ((lower(search_terms_6.name) <-> 'python'::text)), search_terms_6.name
                                              Sort Method: quicksort  Memory: 26kB
                                              Buffers: shared hit=140
                                              ->  Result  (cost=4.71..158.65 rows=42 width=72) (actual time=0.645..0.690 rows=13 loops=1)
                                                    One-Time Filter: (InitPlan 5).col1
                                                    Buffers: shared hit=140
                                                    ->  Bitmap Heap Scan on search_terms search_terms_6  (cost=4.71..158.44 rows=42 width=68) (actual time=0.641..0.652 rows=13 loops=1)
                                                          Recheck Cond: ((lower(name) ~~ 'python%'::text) AND (name = attr_path) AND (top_level_attr IS NOT NULL))
                                                          Rows Removed by Index Recheck: 13
                                                          Heap Blocks: exact=18
                                                          Buffers: shared hit=140
                                                          ->  Bitmap Index Scan on search_terms_top_level_name_knn_idx  (cost=0.00..4.70 rows=42 width=0) (actual time=0.618..0.618 rows=26 loops=1)
                                                                Index Cond: (lower(name) ~~ 'python%'::text)
                                                                Buffers: shared hit=122
                            ->  Subquery Scan on "*SELECT* 5"  (cost=4.22..201.87 rows=50 width=68) (actual time=27.433..28.031 rows=50 loops=1)
                                  Buffers: shared hit=2935
                                  ->  Limit  (cost=4.22..201.37 rows=50 width=72) (actual time=27.432..28.023 rows=50 loops=1)
                                        Buffers: shared hit=2935
                                        InitPlan 6
                                          ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=4.20..1242.26 rows=314 width=72) (actual time=27.431..28.017 rows=50 loops=1)
                                              Sort Key: ((lower(search_terms_7.name) <-> 'python'::text)), search_terms_7.name
                                              Presorted Key: ((lower(search_terms_7.name) <-> 'python'::text))
                                              Full-sort Groups: 2  Sort Methods: top-N heapsort, quicksort  Average Memory: 29kB  Peak Memory: 29kB
                                              Pre-sorted Groups: 1  Sort Method: top-N heapsort  Average Memory: 26kB  Peak Memory: 26kB
                                              Buffers: shared hit=2935
                                              ->  Result  (cost=0.28..1228.13 rows=314 width=72) (actual time=27.247..27.938 rows=170 loops=1)
                                                    One-Time Filter: (InitPlan 6).col1
                                                    Buffers: shared hit=2935
                                                    ->  Index Scan using search_terms_nested_name_knn_idx on search_terms search_terms_7  (cost=0.28..1226.56 rows=314 width=68) (actual time=27.232..27.567 rows=170 loops=1)
                                                          Index Cond: (lower(name) ~~ 'python%'::text)
                                                          Rows Removed by Index Recheck: 12
                                                          Order By: (lower(name) <-> 'python'::text)
                                                          Buffers: shared hit=2935
  ->  Sort  (cost=817.13..817.32 rows=76 width=44) (actual time=35.700..35.704 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=3634
        ->  GroupAggregate  (cost=813.24..814.76 rows=76 width=44) (actual time=35.664..35.685 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=3634
              ->  Sort  (cost=813.24..813.43 rows=76 width=42) (actual time=35.659..35.664 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=3634
                    ->  Append  (cost=0.00..810.86 rows=76 width=42) (actual time=35.607..35.650 rows=50 loops=1)
                          Buffers: shared hit=3634
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=35.606..35.621 rows=50 loops=1)
                                Buffers: shared hit=3634
                          ->  Subquery Scan on fuzzy  (cost=809.16..809.48 rows=26 width=39) (actual time=0.022..0.024 rows=0 loops=1)
                                ->  Limit  (cost=809.16..809.22 rows=26 width=39) (actual time=0.022..0.023 rows=0 loops=1)
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.009..0.009 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.004 rows=50 loops=1)
                                      ->  Sort  (cost=808.02..808.09 rows=26 width=39) (actual time=0.021..0.022 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'python'::text) ELSE GREATEST(similarity(search_terms.name, 'python'::text), similarity(search_terms.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            ->  GroupAggregate  (cost=805.72..807.41 rows=26 width=39) (actual time=0.017..0.018 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  ->  Sort  (cost=805.72..805.79 rows=26 width=68) (actual time=0.016..0.017 rows=0 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        ->  Result  (cost=623.35..805.11 rows=26 width=68) (actual time=0.011..0.012 rows=0 loops=1)
                                                              One-Time Filter: ((InitPlan 8).col1 < 50)
                                                              ->  Bitmap Heap Scan on search_terms  (cost=623.35..805.11 rows=26 width=68) (never executed)
                                                                    Recheck Cond: ((name % 'python'::text) OR (attr_path % 'python'::text))
                                                                    Filter: ((lower(name) !~~ 'python%'::text) AND (lower(attr_path) !~~ 'python%'::text))
                                                                    ->  BitmapOr  (cost=623.35..623.35 rows=50 width=0) (never executed)
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..311.67 rows=25 width=0) (never executed)
                                                                                Index Cond: (name % 'python'::text)
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..311.67 rows=25 width=0) (never executed)
                                                                                Index Cond: (attr_path % 'python'::text)
Planning:
  Buffers: shared hit=4
Planning Time: 1.338 ms
Execution Time: 35.942 ms
```

### batched fetch, latest — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 10.648 ms

```
Limit  (cost=4130.51..104793.00 rows=50 width=1377) (actual time=6.256..10.539 rows=49 loops=1)
  Buffers: shared hit=17675
  ->  Unique  (cost=4130.51..104793.00 rows=50 width=1377) (actual time=6.255..10.533 rows=49 loops=1)
        Buffers: shared hit=17675
        ->  Incremental Sort  (cost=4130.51..104791.32 rows=672 width=1377) (actual time=6.254..10.500 rows=127 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 4  Sort Method: quicksort  Average Memory: 69kB  Peak Memory: 69kB
              Buffers: shared hit=17675
              ->  Nested Loop  (cost=2076.40..104769.33 rows=672 width=1377) (actual time=2.026..10.382 rows=127 loops=1)
                    Buffers: shared hit=17675
                    ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.007..0.015 rows=50 loops=1)
                    ->  Nested Loop  (cost=2076.40..2095.25 rows=13 width=1359) (actual time=0.201..0.207 rows=3 loops=50)
                          Buffers: shared hit=17675
                          ->  Nested Loop  (cost=2076.12..2091.38 rows=13 width=1314) (actual time=0.199..0.203 rows=3 loops=50)
                                Buffers: shared hit=17294
                                ->  Nested Loop  (cost=2075.69..2084.76 rows=13 width=331) (actual time=0.196..0.197 rows=3 loops=50)
                                      Join Filter: (variants.version_id = versions_1.id)
                                      Buffers: shared hit=16786
                                      ->  Nested Loop  (cost=2075.26..2083.32 rows=1 width=45) (actual time=0.194..0.194 rows=1 loops=50)
                                            Buffers: shared hit=16566
                                            ->  Nested Loop  (cost=2074.84..2082.87 rows=1 width=22) (actual time=0.191..0.191 rows=1 loops=50)
                                                  Buffers: shared hit=16370
                                                  ->  Limit  (cost=2074.42..2074.42 rows=1 width=24) (actual time=0.187..0.187 rows=1 loops=50)
                                                        Buffers: shared hit=16174
                                                        ->  Sort  (cost=2074.42..2074.63 rows=85 width=24) (actual time=0.187..0.187 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=16174
                                                              ->  Nested Loop  (cost=0.86..2073.99 rows=85 width=24) (actual time=0.012..0.177 rows=34 loops=50)
                                                                    Buffers: shared hit=16174
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.004..0.008 rows=10 loops=50)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Rows Removed by Filter: 2
                                                                          Buffers: shared hit=231
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..32.45 rows=13 width=8) (actual time=0.002..0.003 rows=3 loops=512)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=2143
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.002..0.002 rows=1 loops=1721)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=6884
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=1721)
                                                                            Buffers: shared hit=6916
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=1721)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=6916
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.004..0.004 rows=1 loops=49)
                                                        Index Cond: (id = versions_1.id)
                                                        Buffers: shared hit=196
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=49)
                                                  Index Cond: (id = versions.package_id)
                                                  Buffers: shared hit=196
                                      ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.001..0.002 rows=3 loops=49)
                                            Index Cond: (version_id = versions.id)
                                            Buffers: shared hit=220
                                ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=127)
                                      Index Cond: (id = variants.meta_id)
                                      Buffers: shared hit=508
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=127)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=381
Planning:
  Buffers: shared hit=112
Planning Time: 12.270 ms
Execution Time: 10.648 ms
```

### batched fetch, all versions — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 11.965 ms

```
Limit  (cost=116.51..1458.29 rows=1000 width=1392) (actual time=3.251..11.695 rows=635 loops=1)
  Buffers: shared hit=12245
  ->  Unique  (cost=116.51..5813.71 rows=4246 width=1392) (actual time=3.250..11.642 rows=635 loops=1)
        Buffers: shared hit=12245
        ->  Incremental Sort  (cost=116.51..5781.86 rows=4246 width=1392) (actual time=3.249..11.082 rows=2164 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 19  Sort Method: quicksort  Average Memory: 126kB  Peak Memory: 126kB
              Pre-sorted Groups: 13  Sort Method: quicksort  Average Memory: 882kB  Peak Memory: 882kB
              Buffers: shared hit=12245
              ->  Nested Loop  (cost=1.99..5591.75 rows=4246 width=1392) (actual time=0.054..7.628 rows=2164 loops=1)
                    Buffers: shared hit=12245
                    ->  Nested Loop  (cost=1.70..4929.67 rows=4246 width=1337) (actual time=0.044..6.406 rows=2164 loops=1)
                          Buffers: shared hit=11729
                          ->  Nested Loop  (cost=1.28..2768.89 rows=4246 width=354) (actual time=0.038..2.932 rows=2164 loops=1)
                                Buffers: shared hit=3073
                                ->  Nested Loop  (cost=0.85..506.15 rows=1603 width=64) (actual time=0.032..0.641 rows=635 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=420
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.020..0.190 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.016 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.36 rows=32 width=33) (actual time=0.003..0.006 rows=13 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=220
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.002..0.003 rows=3 loops=635)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=2653
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=2164)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=8656
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=2164)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 1992  Misses: 172  Evictions: 0  Overflows: 0  Memory Usage: 27kB
                          Buffers: shared hit=516
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=172)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=516
Planning:
  Buffers: shared hit=68
Planning Time: 5.729 ms
Execution Time: 11.965 ms
```

### ranked terms — q=hello

Parameters: `["hello","hello"]` — Execution Time: 89.689 ms

```
Limit  (cost=876.18..876.30 rows=50 width=44) (actual time=89.383..89.404 rows=14 loops=1)
  Buffers: shared hit=1212
  CTE breadth
    ->  Aggregate  (cost=8.76..8.77 rows=1 width=1) (actual time=0.032..0.033 rows=1 loops=1)
          Buffers: shared hit=4
          ->  Limit  (cost=0.42..8.45 rows=25 width=4) (actual time=0.024..0.029 rows=5 loops=1)
                Buffers: shared hit=4
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..8.45 rows=25 width=4) (actual time=0.023..0.027 rows=5 loops=1)
                      Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                      Filter: (lower(name) ~~ 'hello%'::text)
                      Buffers: shared hit=4
  CTE prefix
    ->  Limit  (cost=70.09..70.21 rows=50 width=39) (actual time=0.088..0.102 rows=5 loops=1)
          Buffers: shared hit=11
          ->  Sort  (cost=70.09..70.35 rows=106 width=39) (actual time=0.088..0.101 rows=5 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'hello'::text) ELSE GREATEST(similarity(search_terms_3.name, 'hello'::text), similarity(search_terms_3.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=11
                ->  HashAggregate  (cost=65.51..66.57 rows=106 width=39) (actual time=0.084..0.097 rows=5 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Batches: 1  Memory Usage: 24kB
                      Buffers: shared hit=11
                      ->  Append  (cost=8.90..59.94 rows=106 width=68) (actual time=0.051..0.075 rows=5 loops=1)
                            Buffers: shared hit=11
                            ->  Result  (cost=8.90..12.92 rows=50 width=68) (actual time=0.051..0.056 rows=5 loops=1)
                                  One-Time Filter: (NOT (InitPlan 2).col1)
                                  Buffers: shared hit=11
                                  InitPlan 2
                                    ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=0.033..0.033 rows=1 loops=1)
                                          Buffers: shared hit=4
                                  ->  Bitmap Heap Scan on search_terms search_terms_3  (cost=8.90..12.92 rows=50 width=68) (actual time=0.015..0.019 rows=5 loops=1)
                                        Recheck Cond: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                                        Filter: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                                        Heap Blocks: exact=1
                                        Buffers: shared hit=7
                                        ->  BitmapOr  (cost=8.88..8.88 rows=1 width=0) (actual time=0.010..0.011 rows=0 loops=1)
                                              Buffers: shared hit=6
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.003..0.003 rows=5 loops=1)
                                                    Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                                    Buffers: shared hit=3
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.006..0.006 rows=5 loops=1)
                                                    Index Cond: ((lower(attr_path) >= 'hello'::text) AND (lower(attr_path) < 'hellp'::text))
                                                    Buffers: shared hit=3
                            ->  Result  (cost=8.88..16.76 rows=2 width=68) (actual time=0.001..0.003 rows=0 loops=1)
                                  One-Time Filter: (InitPlan 3).col1
                                  InitPlan 3
                                    ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=68) (never executed)
                                        Recheck Cond: ((lower(name) = 'hello'::text) OR (lower(attr_path) = 'hello'::text))
                                        ->  BitmapOr  (cost=8.86..8.86 rows=2 width=0) (never executed)
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                    Index Cond: (lower(name) = 'hello'::text)
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                    Index Cond: (lower(attr_path) = 'hello'::text)
                            ->  Result  (cost=8.90..12.93 rows=50 width=68) (actual time=0.001..0.002 rows=0 loops=1)
                                  One-Time Filter: (InitPlan 4).col1
                                  InitPlan 4
                                    ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_5  (cost=8.90..12.93 rows=50 width=68) (never executed)
                                        Recheck Cond: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                                        Filter: ((name <> attr_path) AND ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text)))
                                        ->  BitmapOr  (cost=8.88..8.88 rows=1 width=0) (never executed)
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                    Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                    Index Cond: ((lower(attr_path) >= 'hello'::text) AND (lower(attr_path) < 'hellp'::text))
                            ->  Subquery Scan on "*SELECT* 4"  (cost=8.33..8.40 rows=2 width=68) (actual time=0.005..0.007 rows=0 loops=1)
                                  ->  Limit  (cost=8.33..8.38 rows=2 width=72) (actual time=0.005..0.007 rows=0 loops=1)
                                        InitPlan 5
                                          ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=8.31..8.36 rows=2 width=72) (actual time=0.005..0.005 rows=0 loops=1)
                                              Sort Key: ((lower(search_terms_6.name) <-> 'hello'::text)), search_terms_6.name
                                              Presorted Key: ((lower(search_terms_6.name) <-> 'hello'::text))
                                              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                              ->  Result  (cost=0.28..8.30 rows=1 width=72) (actual time=0.001..0.001 rows=0 loops=1)
                                                    One-Time Filter: (InitPlan 5).col1
                                                    ->  Index Scan using search_terms_top_level_name_knn_idx on search_terms search_terms_6  (cost=0.28..8.30 rows=1 width=68) (never executed)
                                                          Index Cond: (lower(name) ~~ 'hello%'::text)
                                                          Order By: (lower(name) <-> 'hello'::text)
                            ->  Subquery Scan on "*SELECT* 5"  (cost=8.34..8.40 rows=2 width=68) (actual time=0.003..0.005 rows=0 loops=1)
                                  ->  Limit  (cost=8.34..8.38 rows=2 width=72) (actual time=0.003..0.004 rows=0 loops=1)
                                        InitPlan 6
                                          ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=8.32..8.36 rows=2 width=72) (actual time=0.002..0.003 rows=0 loops=1)
                                              Sort Key: ((lower(search_terms_7.name) <-> 'hello'::text)), search_terms_7.name
                                              Presorted Key: ((lower(search_terms_7.name) <-> 'hello'::text))
                                              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                              ->  Result  (cost=0.28..8.31 rows=1 width=72) (actual time=0.001..0.001 rows=0 loops=1)
                                                    One-Time Filter: (InitPlan 6).col1
                                                    ->  Index Scan using search_terms_nested_name_knn_idx on search_terms search_terms_7  (cost=0.28..8.30 rows=1 width=68) (never executed)
                                                          Index Cond: (lower(name) ~~ 'hello%'::text)
                                                          Order By: (lower(name) <-> 'hello'::text)
  ->  Sort  (cost=797.19..797.44 rows=100 width=44) (actual time=89.382..89.386 rows=14 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=1212
        ->  GroupAggregate  (cost=791.87..793.87 rows=100 width=44) (actual time=89.369..89.378 rows=14 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=1212
              ->  Sort  (cost=791.87..792.12 rows=100 width=42) (actual time=89.365..89.369 rows=14 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=1212
                    ->  Append  (cost=0.00..788.55 rows=100 width=42) (actual time=0.090..89.363 rows=14 loops=1)
                          Buffers: shared hit=1212
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=0.090..0.092 rows=5 loops=1)
                                Buffers: shared hit=11
                          ->  Subquery Scan on fuzzy  (cost=786.42..787.05 rows=50 width=39) (actual time=89.263..89.268 rows=9 loops=1)
                                Buffers: shared hit=1201
                                ->  Limit  (cost=786.42..786.55 rows=50 width=39) (actual time=89.262..89.266 rows=9 loops=1)
                                      Buffers: shared hit=1201
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.002..0.003 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.001 rows=5 loops=1)
                                      ->  Sort  (cost=785.29..785.41 rows=50 width=39) (actual time=89.261..89.263 rows=9 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'hello'::text) ELSE GREATEST(similarity(search_terms.name, 'hello'::text), similarity(search_terms.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            Buffers: shared hit=1201
                                            ->  GroupAggregate  (cost=780.63..783.88 rows=50 width=39) (actual time=89.239..89.257 rows=9 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Buffers: shared hit=1201
                                                  ->  Sort  (cost=780.63..780.75 rows=50 width=68) (actual time=89.224..89.226 rows=9 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        Buffers: shared hit=1201
                                                        ->  Result  (cost=597.46..779.22 rows=50 width=68) (actual time=41.566..89.216 rows=9 loops=1)
                                                              One-Time Filter: ((InitPlan 8).col1 < 50)
                                                              Buffers: shared hit=1201
                                                              ->  Bitmap Heap Scan on search_terms  (cost=597.46..779.22 rows=50 width=68) (actual time=41.562..89.208 rows=9 loops=1)
                                                                    Recheck Cond: ((name % 'hello'::text) OR (attr_path % 'hello'::text))
                                                                    Rows Removed by Index Recheck: 17526
                                                                    Filter: ((lower(name) !~~ 'hello%'::text) AND (lower(attr_path) !~~ 'hello%'::text))
                                                                    Rows Removed by Filter: 5
                                                                    Heap Blocks: exact=1035
                                                                    Buffers: shared hit=1201
                                                                    ->  BitmapOr  (cost=597.46..597.46 rows=50 width=0) (actual time=4.874..4.875 rows=0 loops=1)
                                                                          Buffers: shared hit=166
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..298.72 rows=25 width=0) (actual time=2.408..2.408 rows=17540 loops=1)
                                                                                Index Cond: (name % 'hello'::text)
                                                                                Buffers: shared hit=83
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..298.72 rows=25 width=0) (actual time=2.466..2.466 rows=17540 loops=1)
                                                                                Index Cond: (attr_path % 'hello'::text)
                                                                                Buffers: shared hit=83
Planning:
  Buffers: shared hit=4
Planning Time: 1.311 ms
Execution Time: 89.689 ms
```

### batched fetch, latest — q=hello (14 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,51341,242138,42681"]` — Execution Time: 1.980 ms

```
Limit  (cost=4023.72..29342.04 rows=14 width=1377) (actual time=1.430..1.882 rows=14 loops=1)
  Buffers: shared hit=2687
  ->  Unique  (cost=4023.72..29342.04 rows=14 width=1377) (actual time=1.429..1.880 rows=14 loops=1)
        Buffers: shared hit=2687
        ->  Incremental Sort  (cost=4023.72..29341.57 rows=188 width=1377) (actual time=1.429..1.868 rows=46 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 65kB  Peak Memory: 65kB
              Buffers: shared hit=2687
              ->  Nested Loop  (cost=2076.40..29335.41 rows=188 width=1377) (actual time=0.175..1.817 rows=46 loops=1)
                    Buffers: shared hit=2687
                    ->  Function Scan on unnest hits  (cost=0.00..0.14 rows=14 width=12) (actual time=0.006..0.009 rows=14 loops=1)
                    ->  Nested Loop  (cost=2076.40..2095.25 rows=13 width=1359) (actual time=0.116..0.128 rows=3 loops=14)
                          Buffers: shared hit=2687
                          ->  Nested Loop  (cost=2076.12..2091.38 rows=13 width=1314) (actual time=0.114..0.122 rows=3 loops=14)
                                Buffers: shared hit=2549
                                ->  Nested Loop  (cost=2075.69..2084.76 rows=13 width=331) (actual time=0.111..0.114 rows=3 loops=14)
                                      Join Filter: (variants.version_id = versions_1.id)
                                      Buffers: shared hit=2365
                                      ->  Nested Loop  (cost=2075.26..2083.32 rows=1 width=45) (actual time=0.109..0.110 rows=1 loops=14)
                                            Buffers: shared hit=2289
                                            ->  Nested Loop  (cost=2074.84..2082.87 rows=1 width=22) (actual time=0.107..0.107 rows=1 loops=14)
                                                  Buffers: shared hit=2233
                                                  ->  Limit  (cost=2074.42..2074.42 rows=1 width=24) (actual time=0.104..0.104 rows=1 loops=14)
                                                        Buffers: shared hit=2177
                                                        ->  Sort  (cost=2074.42..2074.63 rows=85 width=24) (actual time=0.103..0.103 rows=1 loops=14)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=2177
                                                              ->  Nested Loop  (cost=0.86..2073.99 rows=85 width=24) (actual time=0.013..0.098 rows=15 loops=14)
                                                                    Buffers: shared hit=2177
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.004..0.005 rows=5 loops=14)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Buffers: shared hit=56
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..32.45 rows=13 width=8) (actual time=0.002..0.003 rows=3 loops=75)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=359
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.001..0.001 rows=1 loops=216)
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
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.003 rows=1 loops=14)
                                                        Index Cond: (id = versions_1.id)
                                                        Buffers: shared hit=56
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=14)
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
  Buffers: shared hit=112
Planning Time: 10.438 ms
Execution Time: 1.980 ms
```

### batched fetch, all versions — q=hello (14 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,51341,242138,42681"]` — Execution Time: 1.677 ms

```
Limit  (cost=128.53..1532.33 rows=1000 width=1392) (actual time=0.308..1.594 rows=75 loops=1)
  Buffers: shared hit=1983
  ->  Unique  (cost=128.53..1797.65 rows=1189 width=1392) (actual time=0.307..1.586 rows=75 loops=1)
        Buffers: shared hit=1983
        ->  Incremental Sort  (cost=128.53..1788.73 rows=1189 width=1392) (actual time=0.306..1.533 rows=216 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 5  Sort Method: quicksort  Average Memory: 88kB  Peak Memory: 88kB
              Pre-sorted Groups: 3  Sort Method: quicksort  Average Memory: 50kB  Peak Memory: 54kB
              Buffers: shared hit=1983
              ->  Nested Loop  (cost=1.98..1735.49 rows=1189 width=1392) (actual time=0.046..1.111 rows=216 loops=1)
                    Buffers: shared hit=1983
                    ->  Nested Loop  (cost=1.70..1381.72 rows=1189 width=1337) (actual time=0.041..0.797 rows=216 loops=1)
                          Buffers: shared hit=1335
                          ->  Nested Loop  (cost=1.28..776.64 rows=1189 width=354) (actual time=0.034..0.429 rows=216 loops=1)
                                Buffers: shared hit=471
                                ->  Nested Loop  (cost=0.85..142.84 rows=449 width=64) (actual time=0.027..0.127 rows=75 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=112
                                      ->  Nested Loop  (cost=0.42..118.27 rows=14 width=43) (actual time=0.017..0.051 rows=14 loops=1)
                                            Buffers: shared hit=56
                                            ->  Function Scan on unnest hits  (cost=0.00..0.14 rows=14 width=12) (actual time=0.006..0.008 rows=14 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=14)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=56
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.36 rows=32 width=33) (actual time=0.003..0.004 rows=5 loops=14)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=56
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.002..0.003 rows=3 loops=75)
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
Planning Time: 6.508 ms
Execution Time: 1.677 ms
```

### ranked terms — q=-

Parameters: `["-","-"]` — Execution Time: 924.185 ms

```
Limit  (cost=7698.67..7698.79 rows=50 width=44) (actual time=922.416..924.068 rows=0 loops=1)
  Buffers: shared hit=2982
  CTE prefix
    ->  Limit  (cost=17.44..17.57 rows=50 width=39) (actual time=0.019..0.022 rows=0 loops=1)
          Buffers: shared hit=6
          ->  Sort  (cost=17.44..17.57 rows=50 width=39) (actual time=0.019..0.021 rows=0 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_1.name) = '-'::text) THEN 1000 WHEN (lower(search_terms_1.attr_path) = '-'::text) THEN 900 WHEN (lower(search_terms_1.name) ~~ '-%'::text) THEN 800 WHEN (lower(search_terms_1.attr_path) ~~ '-%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_1.name = search_terms_1.attr_path) THEN similarity(search_terms_1.name, '-'::text) ELSE GREATEST(similarity(search_terms_1.name, '-'::text), similarity(search_terms_1.attr_path, '-'::text)) END)) + (CASE WHEN (search_terms_1.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_1.name
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=6
                ->  HashAggregate  (cost=15.53..16.03 rows=50 width=39) (actual time=0.017..0.019 rows=0 loops=1)
                      Group Key: search_terms_1.package_id, search_terms_1.name
                      Batches: 1  Memory Usage: 24kB
                      Buffers: shared hit=6
                      ->  Bitmap Heap Scan on search_terms search_terms_1  (cost=8.88..12.90 rows=50 width=68) (actual time=0.016..0.017 rows=0 loops=1)
                            Recheck Cond: ((lower(name) ~~ '-%'::text) OR (lower(attr_path) ~~ '-%'::text))
                            Filter: ((lower(name) ~~ '-%'::text) OR (lower(attr_path) ~~ '-%'::text))
                            Buffers: shared hit=6
                            ->  BitmapOr  (cost=8.88..8.88 rows=1 width=0) (actual time=0.013..0.014 rows=0 loops=1)
                                  Buffers: shared hit=6
                                  ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.009..0.009 rows=0 loops=1)
                                        Index Cond: ((lower(name) >= '-'::text) AND (lower(name) < '.'::text))
                                        Buffers: shared hit=3
                                  ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.003..0.003 rows=0 loops=1)
                                        Index Cond: ((lower(attr_path) >= '-'::text) AND (lower(attr_path) < '.'::text))
                                        Buffers: shared hit=3
  ->  Sort  (cost=7681.10..7681.35 rows=100 width=44) (actual time=922.414..924.063 rows=0 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=2982
        ->  GroupAggregate  (cost=7675.78..7677.78 rows=100 width=44) (actual time=922.412..924.061 rows=0 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=2982
              ->  Sort  (cost=7675.78..7676.03 rows=100 width=42) (actual time=922.411..924.060 rows=0 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=2982
                    ->  Append  (cost=0.00..7672.46 rows=100 width=42) (actual time=922.410..924.058 rows=0 loops=1)
                          Buffers: shared hit=2982
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=0.020..0.020 rows=0 loops=1)
                                Buffers: shared hit=6
                          ->  Subquery Scan on fuzzy  (cost=7670.33..7670.96 rows=50 width=39) (actual time=922.389..924.036 rows=0 loops=1)
                                Buffers: shared hit=2976
                                ->  Limit  (cost=7670.33..7670.46 rows=50 width=39) (actual time=922.388..924.034 rows=0 loops=1)
                                      Buffers: shared hit=2976
                                      InitPlan 2
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.000 rows=0 loops=1)
                                      ->  Sort  (cost=7669.20..7669.32 rows=50 width=39) (actual time=922.387..924.032 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = '-'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = '-'::text) THEN 900 WHEN (lower(search_terms.name) ~~ '-%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ '-%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, '-'::text) ELSE GREATEST(similarity(search_terms.name, '-'::text), similarity(search_terms.attr_path, '-'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            Buffers: shared hit=2976
                                            ->  Finalize GroupAggregate  (cost=7661.92..7667.79 rows=50 width=39) (actual time=922.386..924.031 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Buffers: shared hit=2976
                                                  ->  Gather Merge  (cost=7661.92..7667.07 rows=29 width=39) (actual time=922.385..924.030 rows=0 loops=1)
                                                        Workers Planned: 1
                                                        Workers Launched: 1
                                                        Buffers: shared hit=2976
                                                        ->  Partial GroupAggregate  (cost=6661.91..6663.80 rows=29 width=39) (actual time=913.769..913.770 rows=0 loops=2)
                                                              Group Key: search_terms.package_id, search_terms.name
                                                              Buffers: shared hit=2976
                                                              ->  Sort  (cost=6661.91..6661.99 rows=29 width=68) (actual time=913.767..913.767 rows=0 loops=2)
                                                                    Sort Key: search_terms.package_id, search_terms.name
                                                                    Sort Method: quicksort  Memory: 25kB
                                                                    Buffers: shared hit=2976
                                                                    Worker 0:  Sort Method: quicksort  Memory: 25kB
                                                                    ->  Result  (cost=0.00..6661.21 rows=29 width=68) (actual time=913.747..913.747 rows=0 loops=2)
                                                                          One-Time Filter: ((InitPlan 2).col1 < 50)
                                                                          Buffers: shared hit=2961
                                                                          ->  Parallel Seq Scan on search_terms  (cost=0.00..6661.21 rows=29 width=68) (actual time=913.745..913.745 rows=0 loops=2)
                                                                                Filter: (((name % '-'::text) OR (attr_path % '-'::text)) AND (lower(name) !~~ '-%'::text) AND (lower(attr_path) !~~ '-%'::text))
                                                                                Rows Removed by Filter: 125807
                                                                                Buffers: shared hit=2961
Planning:
  Buffers: shared hit=30
Planning Time: 2.111 ms
Execution Time: 924.185 ms
```

### batched fetch, latest — q=- (0 hits)

Parameters: `[""]` — Execution Time: 0.097 ms

```
Limit  (cost=2095.51..2095.72 rows=1 width=1377) (actual time=0.012..0.013 rows=0 loops=1)
  ->  Unique  (cost=2095.51..2095.72 rows=1 width=1377) (actual time=0.011..0.012 rows=0 loops=1)
        ->  Incremental Sort  (cost=2095.51..2095.69 rows=13 width=1377) (actual time=0.011..0.012 rows=0 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
              ->  Nested Loop  (cost=2076.40..2095.27 rows=13 width=1377) (actual time=0.004..0.005 rows=0 loops=1)
                    ->  Nested Loop  (cost=2076.12..2091.40 rows=13 width=1322) (actual time=0.004..0.005 rows=0 loops=1)
                          ->  Nested Loop  (cost=2075.70..2084.79 rows=13 width=339) (actual time=0.004..0.005 rows=0 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                ->  Nested Loop  (cost=2075.27..2083.34 rows=1 width=53) (actual time=0.004..0.004 rows=0 loops=1)
                                      ->  Nested Loop  (cost=2074.85..2082.90 rows=1 width=30) (actual time=0.004..0.004 rows=0 loops=1)
                                            ->  Nested Loop  (cost=2074.42..2074.45 rows=1 width=12) (actual time=0.003..0.004 rows=0 loops=1)
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.01 rows=1 width=12) (actual time=0.003..0.003 rows=0 loops=1)
                                                  ->  Limit  (cost=2074.42..2074.42 rows=1 width=24) (never executed)
                                                        ->  Sort  (cost=2074.42..2074.63 rows=85 width=24) (never executed)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              ->  Nested Loop  (cost=0.86..2073.99 rows=85 width=24) (never executed)
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (never executed)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..32.45 rows=13 width=8) (never executed)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (never executed)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (never executed)
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (never executed)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                            ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (never executed)
                                                  Index Cond: (id = versions_1.id)
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (never executed)
                                            Index Cond: (id = versions.package_id)
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (never executed)
                                      Index Cond: (version_id = versions.id)
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (never executed)
                                Index Cond: (id = variants.meta_id)
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (never executed)
                          Index Cond: (seq = variants.commit_seq)
Planning:
  Buffers: shared hit=112
Planning Time: 10.273 ms
Execution Time: 0.097 ms
```

### batched fetch, all versions — q=- (0 hits)

Parameters: `[""]` — Execution Time: 0.080 ms

```
Limit  (cost=126.65..128.37 rows=85 width=1392) (actual time=0.013..0.014 rows=0 loops=1)
  ->  Unique  (cost=126.65..128.37 rows=85 width=1392) (actual time=0.012..0.013 rows=0 loops=1)
        ->  Incremental Sort  (cost=126.65..127.73 rows=85 width=1392) (actual time=0.012..0.013 rows=0 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
              ->  Nested Loop  (cost=1.98..123.92 rows=85 width=1392) (actual time=0.004..0.005 rows=0 loops=1)
                    ->  Nested Loop  (cost=1.70..98.63 rows=85 width=1337) (actual time=0.004..0.005 rows=0 loops=1)
                          ->  Nested Loop  (cost=1.28..55.38 rows=85 width=354) (actual time=0.004..0.004 rows=0 loops=1)
                                ->  Nested Loop  (cost=0.85..10.21 rows=32 width=64) (actual time=0.004..0.004 rows=0 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      ->  Nested Loop  (cost=0.42..8.45 rows=1 width=43) (actual time=0.004..0.004 rows=0 loops=1)
                                            ->  Function Scan on unnest hits  (cost=0.00..0.01 rows=1 width=12) (actual time=0.003..0.004 rows=0 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (never executed)
                                                  Index Cond: (id = hits.package_id)
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.36 rows=32 width=33) (never executed)
                                            Index Cond: (package_id = packages.id)
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (never executed)
                                      Index Cond: (version_id = versions.id)
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (never executed)
                                Index Cond: (id = variants.meta_id)
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (never executed)
                          Index Cond: (seq = variants.commit_seq)
Planning:
  Buffers: shared hit=68
Planning Time: 5.922 ms
Execution Time: 0.080 ms
```

## Name lookups (/v2/resolve, /v1/resolve, /v2/pkg, /v1/pkg)

### pick latest version — name=go

Parameters: `["go"]` — Execution Time: 8.349 ms

```
Limit  (cost=2741.78..2741.78 rows=1 width=24) (actual time=8.258..8.263 rows=1 loops=1)
  Buffers: shared hit=15153
  ->  Sort  (cost=2741.78..2742.09 rows=124 width=24) (actual time=8.257..8.261 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=15153
        ->  Nested Loop  (cost=163.70..2741.16 rows=124 width=24) (actual time=1.336..8.138 rows=647 loops=1)
              Buffers: shared hit=15153
              ->  Nested Loop  (cost=163.28..1277.92 rows=124 width=27) (actual time=1.315..4.030 rows=647 loops=1)
                    Buffers: shared hit=6735
                    ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=8) (actual time=1.309..2.764 rows=722 loops=1)
                          Buffers: shared hit=3847
                          ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=1.303..1.437 rows=722 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=959
                                ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.030..0.954 rows=979 loops=1)
                                      Buffers: shared hit=959
                                      ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.030..0.803 rows=722 loops=1)
                                            Buffers: shared hit=898
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.025..0.095 rows=191 loops=1)
                                                  Buffers: shared hit=23
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.014 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'go'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.009..0.055 rows=191 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=19
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.002..0.003 rows=4 loops=191)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=875
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.010..0.075 rows=257 loops=1)
                                            Index Cond: (attr_path = 'go'::text)
                                            Buffers: shared hit=61
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=722)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=2888
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=722)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=2888
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=647)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 647
                    Buffers: shared hit=3236
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.002..0.002 rows=1 loops=647)
                      Index Cond: (version_id = versions.id)
                      Filter: (NOT broken)
                      Buffers: shared hit=2588
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=647)
                      Buffers: shared hit=2594
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=647)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=2594
Planning:
  Buffers: shared hit=92
Planning Time: 8.136 ms
Execution Time: 8.349 ms
```

### pick latest version — name=python

Parameters: `["python"]` — Execution Time: 6.009 ms

```
Limit  (cost=2741.78..2741.78 rows=1 width=24) (actual time=5.923..5.926 rows=1 loops=1)
  Buffers: shared hit=11360
  ->  Sort  (cost=2741.78..2742.09 rows=124 width=24) (actual time=5.921..5.924 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=11360
        ->  Nested Loop  (cost=163.70..2741.16 rows=124 width=24) (actual time=0.822..5.841 rows=415 loops=1)
              Buffers: shared hit=11360
              ->  Nested Loop  (cost=163.28..1277.92 rows=124 width=27) (actual time=0.802..3.196 rows=415 loops=1)
                    Buffers: shared hit=5955
                    ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=8) (actual time=0.796..2.105 rows=648 loops=1)
                          Buffers: shared hit=3363
                          ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=0.789..0.882 rows=648 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=771
                                ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.027..0.662 rows=651 loops=1)
                                      Buffers: shared hit=771
                                      ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.026..0.603 rows=648 loops=1)
                                            Buffers: shared hit=766
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.021..0.087 rows=177 loops=1)
                                                  Buffers: shared hit=23
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.013 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'python'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.006..0.050 rows=177 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=19
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.001..0.002 rows=4 loops=177)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=743
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.008..0.009 rows=3 loops=1)
                                            Index Cond: (attr_path = 'python'::text)
                                            Buffers: shared hit=5
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=648)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=2592
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=648)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=2592
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=415)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 415
                    Buffers: shared hit=2076
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.002..0.002 rows=1 loops=415)
                      Index Cond: (version_id = versions.id)
                      Filter: (NOT broken)
                      Buffers: shared hit=1660
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=415)
                      Buffers: shared hit=1669
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=415)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=1669
Planning:
  Buffers: shared hit=92
Planning Time: 8.142 ms
Execution Time: 6.009 ms
```

### pick latest version — name=python311

Parameters: `["python311"]` — Execution Time: 0.887 ms

```
Limit  (cost=2741.78..2741.78 rows=1 width=24) (actual time=0.806..0.808 rows=1 loops=1)
  Buffers: shared hit=1378
  ->  Sort  (cost=2741.78..2742.09 rows=124 width=24) (actual time=0.805..0.807 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=1378
        ->  Nested Loop  (cost=163.70..2741.16 rows=124 width=24) (actual time=0.112..0.788 rows=51 loops=1)
              Buffers: shared hit=1378
              ->  Nested Loop  (cost=163.28..1277.92 rows=124 width=27) (actual time=0.090..0.407 rows=51 loops=1)
                    Buffers: shared hit=711
                    ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=8) (actual time=0.084..0.260 rows=87 loops=1)
                          Buffers: shared hit=363
                          ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=0.076..0.088 rows=87 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=15
                                ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.022..0.059 rows=87 loops=1)
                                      Buffers: shared hit=15
                                      ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.011..0.012 rows=0 loops=1)
                                            Buffers: shared hit=3
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.011..0.011 rows=0 loops=1)
                                                  Buffers: shared hit=3
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.010..0.010 rows=0 loops=1)
                                                        Index Cond: (lower(name) = 'python311'::text)
                                                        Buffers: shared hit=3
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (never executed)
                                                        Index Cond: (package_id = p.id)
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (never executed)
                                                  Index Cond: (version_id = ve.id)
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.010..0.040 rows=87 loops=1)
                                            Index Cond: (attr_path = 'python311'::text)
                                            Buffers: shared hit=12
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=87)
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
  Buffers: shared hit=92
Planning Time: 8.467 ms
Execution Time: 0.887 ms
```

### pick latest version — name=hello

Parameters: `["hello"]` — Execution Time: 0.377 ms

```
Limit  (cost=2741.78..2741.78 rows=1 width=24) (actual time=0.296..0.298 rows=1 loops=1)
  Buffers: shared hit=443
  ->  Sort  (cost=2741.78..2742.09 rows=124 width=24) (actual time=0.295..0.296 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=443
        ->  Nested Loop  (cost=163.70..2741.16 rows=124 width=24) (actual time=0.107..0.285 rows=19 loops=1)
              Buffers: shared hit=443
              ->  Nested Loop  (cost=163.28..1277.92 rows=124 width=27) (actual time=0.086..0.151 rows=19 loops=1)
                    Buffers: shared hit=192
                    ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=8) (actual time=0.081..0.116 rows=19 loops=1)
                          Buffers: shared hit=116
                          ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=0.075..0.079 rows=19 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=40
                                ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.029..0.064 rows=38 loops=1)
                                      Buffers: shared hit=40
                                      ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.028..0.050 rows=19 loops=1)
                                            Buffers: shared hit=33
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.023..0.025 rows=5 loops=1)
                                                  Buffers: shared hit=8
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.013 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'hello'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.007..0.009 rows=5 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=4
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.003..0.004 rows=4 loops=5)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=25
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.006..0.011 rows=19 loops=1)
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
  Buffers: shared hit=92
Planning Time: 8.571 ms
Execution Time: 0.377 ms
```

### every version — name=go

Parameters: `["go"]` — Execution Time: 8.163 ms

```
Limit  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=7.838..7.938 rows=722 loops=1)
  Buffers: shared hit=14677
  ->  Sort  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=7.837..7.883 rows=722 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 740kB
        Buffers: shared hit=14677
        ->  Nested Loop  (cost=164.40..1434.31 rows=125 width=1384) (actual time=1.038..7.152 rows=722 loops=1)
              Buffers: shared hit=14677
              ->  Nested Loop  (cost=164.12..1397.11 rows=125 width=1329) (actual time=1.033..6.074 rows=722 loops=1)
                    Buffers: shared hit=12511
                    ->  Nested Loop  (cost=163.70..1333.50 rows=125 width=346) (actual time=1.027..4.950 rows=722 loops=1)
                          Buffers: shared hit=9623
                          ->  Nested Loop  (cost=163.28..1277.92 rows=125 width=323) (actual time=1.023..3.870 rows=722 loops=1)
                                Buffers: shared hit=6735
                                ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=298) (actual time=1.018..2.480 rows=722 loops=1)
                                      Buffers: shared hit=3847
                                      ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=1.013..1.121 rows=722 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=959
                                            ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.029..0.840 rows=979 loops=1)
                                                  Buffers: shared hit=959
                                                  ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.028..0.691 rows=722 loops=1)
                                                        Buffers: shared hit=898
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.023..0.088 rows=191 loops=1)
                                                              Buffers: shared hit=23
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.014 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'go'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.008..0.051 rows=191 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=19
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.002..0.003 rows=4 loops=191)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=875
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.008..0.071 rows=257 loops=1)
                                                        Index Cond: (attr_path = 'go'::text)
                                                        Buffers: shared hit=61
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.001..0.001 rows=1 loops=722)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=2888
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=722)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=2888
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=722)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=2888
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=722)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=2888
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=722)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=2166
Planning:
  Buffers: shared hit=114
Planning Time: 9.297 ms
Execution Time: 8.163 ms
```

### every version — name=python

Parameters: `["python"]` — Execution Time: 7.553 ms

```
Limit  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=7.185..7.297 rows=648 loops=1)
  Buffers: shared hit=13083
  ->  Sort  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=7.183..7.247 rows=648 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 1294kB
        Buffers: shared hit=13083
        ->  Nested Loop  (cost=164.40..1434.31 rows=125 width=1384) (actual time=0.800..6.357 rows=648 loops=1)
              Buffers: shared hit=13083
              ->  Nested Loop  (cost=164.12..1397.11 rows=125 width=1329) (actual time=0.795..5.396 rows=648 loops=1)
                    Buffers: shared hit=11139
                    ->  Nested Loop  (cost=163.70..1333.50 rows=125 width=346) (actual time=0.789..4.302 rows=648 loops=1)
                          Buffers: shared hit=8547
                          ->  Nested Loop  (cost=163.28..1277.92 rows=125 width=323) (actual time=0.784..3.266 rows=648 loops=1)
                                Buffers: shared hit=5955
                                ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=298) (actual time=0.779..2.156 rows=648 loops=1)
                                      Buffers: shared hit=3363
                                      ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=0.772..0.879 rows=648 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=771
                                            ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.030..0.646 rows=651 loops=1)
                                                  Buffers: shared hit=771
                                                  ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.029..0.585 rows=648 loops=1)
                                                        Buffers: shared hit=766
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.023..0.088 rows=177 loops=1)
                                                              Buffers: shared hit=23
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.014..0.014 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'python'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.006..0.051 rows=177 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=19
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.001..0.002 rows=4 loops=177)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=743
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.008..0.009 rows=3 loops=1)
                                                        Index Cond: (attr_path = 'python'::text)
                                                        Buffers: shared hit=5
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.002..0.002 rows=1 loops=648)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=2592
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=648)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=2592
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=648)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=2592
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=648)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=2592
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=648)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=1944
Planning:
  Buffers: shared hit=114
Planning Time: 11.450 ms
Execution Time: 7.553 ms
```

### every version — name=python311

Parameters: `["python311"]` — Execution Time: 1.050 ms

```
Limit  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=0.926..0.939 rows=87 loops=1)
  Buffers: shared hit=1668
  ->  Sort  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=0.925..0.931 rows=87 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 199kB
        Buffers: shared hit=1668
        ->  Nested Loop  (cost=164.40..1434.31 rows=125 width=1384) (actual time=0.109..0.832 rows=87 loops=1)
              Buffers: shared hit=1668
              ->  Nested Loop  (cost=164.12..1397.11 rows=125 width=1329) (actual time=0.105..0.695 rows=87 loops=1)
                    Buffers: shared hit=1407
                    ->  Nested Loop  (cost=163.70..1333.50 rows=125 width=346) (actual time=0.099..0.547 rows=87 loops=1)
                          Buffers: shared hit=1059
                          ->  Nested Loop  (cost=163.28..1277.92 rows=125 width=323) (actual time=0.094..0.409 rows=87 loops=1)
                                Buffers: shared hit=711
                                ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=298) (actual time=0.087..0.259 rows=87 loops=1)
                                      Buffers: shared hit=363
                                      ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=0.078..0.091 rows=87 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=15
                                            ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.023..0.061 rows=87 loops=1)
                                                  Buffers: shared hit=15
                                                  ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.012..0.012 rows=0 loops=1)
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
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.010..0.041 rows=87 loops=1)
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
Planning Time: 10.454 ms
Execution Time: 1.050 ms
```

### every version — name=hello

Parameters: `["hello"]` — Execution Time: 0.380 ms

```
Limit  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=0.289..0.294 rows=19 loops=1)
  Buffers: shared hit=401
  ->  Sort  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=0.288..0.291 rows=19 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 63kB
        Buffers: shared hit=401
        ->  Nested Loop  (cost=164.40..1434.31 rows=125 width=1384) (actual time=0.100..0.263 rows=19 loops=1)
              Buffers: shared hit=401
              ->  Nested Loop  (cost=164.12..1397.11 rows=125 width=1329) (actual time=0.096..0.229 rows=19 loops=1)
                    Buffers: shared hit=344
                    ->  Nested Loop  (cost=163.70..1333.50 rows=125 width=346) (actual time=0.091..0.192 rows=19 loops=1)
                          Buffers: shared hit=268
                          ->  Nested Loop  (cost=163.28..1277.92 rows=125 width=323) (actual time=0.087..0.160 rows=19 loops=1)
                                Buffers: shared hit=192
                                ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=298) (actual time=0.082..0.124 rows=19 loops=1)
                                      Buffers: shared hit=116
                                      ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=0.076..0.086 rows=19 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=40
                                            ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.030..0.065 rows=38 loops=1)
                                                  Buffers: shared hit=40
                                                  ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.029..0.051 rows=19 loops=1)
                                                        Buffers: shared hit=33
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.024..0.026 rows=5 loops=1)
                                                              Buffers: shared hit=8
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.014..0.014 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'hello'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.007..0.008 rows=5 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=4
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.003..0.004 rows=4 loops=5)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=25
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.006..0.011 rows=19 loops=1)
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
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=19)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=76
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=19)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=57
Planning:
  Buffers: shared hit=114
Planning Time: 10.290 ms
Execution Time: 0.380 ms
```

