# Serving query plans

Recorded 2026-11-02 against `ep-purple-river-auzjl04j.c-10.us-east-1.aws.neon.tech` with `node tools/explain-plans.mjs`.
Regenerate after changing apps/web/lib/search.ts or the indexes, and diff.
Warm plans (second run); see the script for what each statement is.

Table sizes: packages=253727, versions=1497814, variants=3909649, search_terms=254320

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
  similarity() over every prefix match was ~0.4 s for `python`, 70k rows. Check
  `python313Packages.` too: at 12k matches it is just over the probe's threshold, and a
  `Bitmap Heap Scan` + `top-N heapsort` in its nested arm means the planner expects fewer
  than 50 rows there — `search_terms_same_name_stats` is missing or was never analyzed
  (`(name = attr_path) IS TRUE` should estimate ~99.8% of the table). `-` has no
  trigrams and takes the scoring path with no probe. The `fuzzy` arm must sit under a
  `One-Time Filter` and show `(never executed)` whenever the prefix tier is full (`go`,
  `python`); it runs for `hello` and `-`. A `%` in the prefix arms, or a fuzzy arm that
  ran for `python`, is a regression: `%` is cheap to index but every GIN candidate is
  rechecked with similarity() — ~1.1 s of CPU for `python` when both tiers were one
  OR'd WHERE.

## Phrase search (/v2/search, /v1/search)

### ranked terms — q=go

Parameters: `["go","go"]` — Execution Time: 2.830 ms

```
Limit  (cost=2448.59..2448.71 rows=50 width=44) (actual time=1.862..1.879 rows=50 loops=1)
  Buffers: shared hit=60
  CTE breadth
    ->  Aggregate  (cost=18.08..18.09 rows=1 width=1) (actual time=0.278..0.279 rows=1 loops=1)
          Buffers: shared hit=34
          ->  Limit  (cost=0.42..17.77 rows=25 width=4) (actual time=0.033..0.248 rows=455 loops=1)
                Buffers: shared hit=34
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..17.77 rows=25 width=4) (actual time=0.033..0.211 rows=455 loops=1)
                      Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                      Filter: (lower(name) ~~ 'go%'::text)
                      Buffers: shared hit=34
  CTE prefix
    ->  Limit  (cost=381.25..381.37 rows=50 width=39) (actual time=1.753..1.767 rows=50 loops=1)
          Buffers: shared hit=60
          ->  Sort  (cost=381.25..381.45 rows=79 width=39) (actual time=1.753..1.762 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'go'::text) ELSE GREATEST(similarity(search_terms_3.name, 'go'::text), similarity(search_terms_3.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: top-N heapsort  Memory: 30kB
                Buffers: shared hit=60
                ->  GroupAggregate  (cost=373.62..378.76 rows=79 width=39) (actual time=0.761..1.672 rows=440 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Buffers: shared hit=60
                      ->  Sort  (cost=373.62..373.82 rows=79 width=68) (actual time=0.719..0.749 rows=455 loops=1)
                            Sort Key: search_terms_3.package_id, search_terms_3.name
                            Sort Method: quicksort  Memory: 51kB
                            Buffers: shared hit=60
                            ->  Append  (cost=9.68..371.13 rows=79 width=68) (actual time=0.332..0.552 rows=455 loops=1)
                                  Buffers: shared hit=60
                                  ->  Result  (cost=9.68..285.41 rows=51 width=68) (actual time=0.331..0.494 rows=455 loops=1)
                                        One-Time Filter: (NOT (InitPlan 2).col1)
                                        Buffers: shared hit=60
                                        InitPlan 2
                                          ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=0.279..0.280 rows=1 loops=1)
                                                Buffers: shared hit=34
                                        ->  Bitmap Heap Scan on search_terms search_terms_3  (cost=9.68..285.41 rows=51 width=68) (actual time=0.050..0.162 rows=455 loops=1)
                                              Recheck Cond: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                              Filter: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                              Heap Blocks: exact=16
                                              Buffers: shared hit=26
                                              ->  BitmapOr  (cost=9.66..9.66 rows=79 width=0) (actual time=0.042..0.042 rows=0 loops=1)
                                                    Buffers: shared hit=10
                                                    ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.81 rows=39 width=0) (actual time=0.020..0.021 rows=455 loops=1)
                                                          Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                                          Buffers: shared hit=5
                                                    ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.82 rows=40 width=0) (actual time=0.020..0.020 rows=455 loops=1)
                                                          Index Cond: ((lower(attr_path) >= 'go'::text) AND (lower(attr_path) < 'gp'::text))
                                                          Buffers: shared hit=5
                                  ->  Result  (cost=8.88..16.76 rows=2 width=68) (actual time=0.003..0.004 rows=0 loops=1)
                                        One-Time Filter: (InitPlan 3).col1
                                        InitPlan 3
                                          ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.002..0.002 rows=1 loops=1)
                                        ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=68) (never executed)
                                              Recheck Cond: ((lower(name) = 'go'::text) OR (lower(attr_path) = 'go'::text))
                                              ->  BitmapOr  (cost=8.86..8.86 rows=2 width=0) (never executed)
                                                    ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                          Index Cond: (lower(name) = 'go'::text)
                                                    ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                          Index Cond: (lower(attr_path) = 'go'::text)
                                  ->  Result  (cost=29.62..33.64 rows=1 width=68) (actual time=0.001..0.002 rows=0 loops=1)
                                        One-Time Filter: (InitPlan 4).col1
                                        InitPlan 4
                                          ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                        ->  Bitmap Heap Scan on search_terms search_terms_5  (cost=29.62..33.64 rows=1 width=68) (never executed)
                                              Recheck Cond: (((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text)) AND ((name = attr_path) IS FALSE))
                                              Filter: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                              ->  BitmapAnd  (cost=29.60..29.60 rows=1 width=0) (never executed)
                                                    ->  BitmapOr  (cost=9.63..9.63 rows=79 width=0) (never executed)
                                                          ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.81 rows=39 width=0) (never executed)
                                                                Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                                          ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.82 rows=40 width=0) (never executed)
                                                                Index Cond: ((lower(attr_path) >= 'go'::text) AND (lower(attr_path) < 'gp'::text))
                                                    ->  Bitmap Index Scan on search_terms_alias_idx  (cost=0.00..19.71 rows=693 width=0) (never executed)
                                  ->  Subquery Scan on "*SELECT* 4"  (cost=16.13..16.17 rows=3 width=68) (actual time=0.007..0.008 rows=0 loops=1)
                                        ->  Limit  (cost=16.13..16.14 rows=3 width=72) (actual time=0.006..0.007 rows=0 loops=1)
                                              InitPlan 5
                                                ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                              ->  Sort  (cost=16.11..16.12 rows=3 width=72) (actual time=0.006..0.006 rows=0 loops=1)
                                                    Sort Key: ((lower(search_terms_6.name) <-> 'go'::text)), search_terms_6.name
                                                    Sort Method: quicksort  Memory: 25kB
                                                    ->  Result  (cost=4.31..16.09 rows=3 width=72) (actual time=0.001..0.001 rows=0 loops=1)
                                                          One-Time Filter: (InitPlan 5).col1
                                                          ->  Bitmap Heap Scan on search_terms search_terms_6  (cost=4.31..16.08 rows=3 width=68) (never executed)
                                                                Recheck Cond: ((lower(name) ~~ 'go%'::text) AND ((name = attr_path) IS TRUE) AND (top_level_attr IS NOT NULL))
                                                                ->  Bitmap Index Scan on search_terms_top_level_name_knn_idx  (cost=0.00..4.31 rows=3 width=0) (never executed)
                                                                      Index Cond: (lower(name) ~~ 'go%'::text)
                                  ->  Subquery Scan on "*SELECT* 5"  (cost=18.48..18.76 rows=22 width=68) (actual time=0.004..0.005 rows=0 loops=1)
                                        ->  Limit  (cost=18.48..18.54 rows=22 width=72) (actual time=0.003..0.004 rows=0 loops=1)
                                              InitPlan 6
                                                ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                              ->  Sort  (cost=18.46..18.52 rows=22 width=72) (actual time=0.003..0.004 rows=0 loops=1)
                                                    Sort Key: ((lower(search_terms_7.name) <-> 'go'::text)), search_terms_7.name
                                                    Sort Method: quicksort  Memory: 25kB
                                                    ->  Result  (cost=0.42..17.97 rows=22 width=72) (actual time=0.001..0.001 rows=0 loops=1)
                                                          One-Time Filter: (InitPlan 6).col1
                                                          ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_7  (cost=0.42..17.86 rows=22 width=68) (never executed)
                                                                Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                                                Filter: ((top_level_attr IS NULL) AND ((name = attr_path) IS TRUE) AND (lower(name) ~~ 'go%'::text))
  ->  Sort  (cost=2049.12..2049.37 rows=100 width=44) (actual time=1.861..1.866 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=60
        ->  GroupAggregate  (cost=2043.80..2045.80 rows=100 width=44) (actual time=1.821..1.842 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=60
              ->  Sort  (cost=2043.80..2044.05 rows=100 width=42) (actual time=1.818..1.822 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=60
                    ->  Append  (cost=0.00..2040.48 rows=100 width=42) (actual time=1.756..1.806 rows=50 loops=1)
                          Buffers: shared hit=60
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=1.756..1.772 rows=50 loops=1)
                                Buffers: shared hit=60
                          ->  Subquery Scan on fuzzy  (cost=2038.36..2038.98 rows=50 width=39) (actual time=0.027..0.029 rows=0 loops=1)
                                ->  Limit  (cost=2038.36..2038.48 rows=50 width=39) (actual time=0.027..0.028 rows=0 loops=1)
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.008..0.008 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.004 rows=50 loops=1)
                                      ->  Sort  (cost=2037.22..2037.35 rows=51 width=39) (actual time=0.026..0.027 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'go'::text) ELSE GREATEST(similarity(search_terms.name, 'go'::text), similarity(search_terms.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            ->  GroupAggregate  (cost=2032.46..2035.77 rows=51 width=39) (actual time=0.015..0.016 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  ->  Sort  (cost=2032.46..2032.59 rows=51 width=68) (actual time=0.015..0.016 rows=0 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        ->  Result  (cost=1845.75..2031.01 rows=51 width=68) (actual time=0.010..0.010 rows=0 loops=1)
                                                              One-Time Filter: ((InitPlan 8).col1 < 50)
                                                              ->  Bitmap Heap Scan on search_terms  (cost=1845.75..2031.01 rows=51 width=68) (never executed)
                                                                    Recheck Cond: ((name % 'go'::text) OR (attr_path % 'go'::text))
                                                                    Filter: ((lower(name) !~~ 'go%'::text) AND (lower(attr_path) !~~ 'go%'::text))
                                                                    ->  BitmapOr  (cost=1845.74..1845.74 rows=51 width=0) (never executed)
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..922.86 rows=25 width=0) (never executed)
                                                                                Index Cond: (name % 'go'::text)
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..922.86 rows=25 width=0) (never executed)
                                                                                Index Cond: (attr_path % 'go'::text)
Planning:
  Buffers: shared hit=4
Planning Time: 1.359 ms
Execution Time: 2.830 ms
```

### batched fetch, latest — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 13.103 ms

```
Limit  (cost=2218.69..56873.92 rows=50 width=1378) (actual time=4.785..12.990 rows=50 loops=1)
  Buffers: shared hit=23427
  ->  Unique  (cost=2218.69..56873.92 rows=50 width=1378) (actual time=4.784..12.984 rows=50 loops=1)
        Buffers: shared hit=23427
        ->  Incremental Sort  (cost=2218.69..56872.15 rows=706 width=1378) (actual time=4.783..12.948 rows=171 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 6  Sort Method: quicksort  Average Memory: 55kB  Peak Memory: 55kB
              Buffers: shared hit=23427
              ->  Nested Loop  (cost=1103.52..56848.84 rows=706 width=1378) (actual time=3.459..12.803 rows=174 loops=1)
                    Buffers: shared hit=23427
                    ->  Nested Loop  (cost=1103.24..56638.78 rows=706 width=1323) (actual time=3.453..12.560 rows=174 loops=1)
                          Buffers: shared hit=22905
                          ->  Nested Loop  (cost=1102.81..56273.43 rows=706 width=340) (actual time=3.446..12.213 rows=174 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                Buffers: shared hit=22209
                                ->  Nested Loop  (cost=1102.38..56194.50 rows=50 width=53) (actual time=3.440..12.017 rows=50 loops=1)
                                      Buffers: shared hit=21903
                                      ->  Nested Loop  (cost=1101.96..56172.27 rows=50 width=30) (actual time=3.433..11.911 rows=50 loops=1)
                                            Buffers: shared hit=21703
                                            ->  Nested Loop  (cost=1101.54..55750.02 rows=50 width=12) (actual time=3.425..11.775 rows=50 loops=1)
                                                  Buffers: shared hit=21503
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.014 rows=50 loops=1)
                                                  ->  Limit  (cost=1101.53..1114.97 rows=1 width=25) (actual time=0.235..0.235 rows=1 loops=50)
                                                        Buffers: shared hit=21503
                                                        ->  Incremental Sort  (cost=1101.53..2203.28 rows=82 width=25) (actual time=0.234..0.234 rows=1 loops=50)
                                                              Sort Key: versions_1.prerelease, (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Presorted Key: versions_1.prerelease
                                                              Full-sort Groups: 50  Sort Methods: top-N heapsort, quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                                              Pre-sorted Groups: 9  Sort Method: top-N heapsort  Average Memory: 25kB  Peak Memory: 25kB
                                                              Buffers: shared hit=21503
                                                              ->  Nested Loop  (cost=0.86..2201.80 rows=82 width=25) (actual time=0.012..0.224 rows=46 loops=50)
                                                                    Buffers: shared hit=21503
                                                                    ->  Index Scan using versions_latest_idx on versions versions_1  (cost=0.43..68.04 rows=33 width=20) (actual time=0.003..0.006 rows=13 loops=50)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Buffers: shared hit=251
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..36.09 rows=14 width=8) (actual time=0.002..0.003 rows=4 loops=630)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=2819
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.09 rows=14 width=0) (actual time=0.001..0.001 rows=1 loops=2287)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=9148
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=2287)
                                                                            Buffers: shared hit=9285
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=2287)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=9285
                                            ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=50)
                                                  Index Cond: (id = versions_1.id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=200
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.40 rows=14 width=299) (actual time=0.001..0.003 rows=3 loops=50)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=306
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=174)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=696
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=174)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=522
Planning:
  Buffers: shared hit=115
Planning Time: 13.945 ms
Execution Time: 13.103 ms
```

### batched fetch, all versions — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 12.739 ms

```
Limit  (cost=119.91..1568.91 rows=1000 width=1393) (actual time=3.563..12.539 rows=649 loops=1)
  Buffers: shared hit=13537
  ->  Unique  (cost=119.91..5979.69 rows=4044 width=1393) (actual time=3.561..12.482 rows=649 loops=1)
        Buffers: shared hit=13537
        ->  Incremental Sort  (cost=119.91..5949.36 rows=4044 width=1393) (actual time=3.560..11.920 rows=2361 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 21  Sort Method: quicksort  Average Memory: 70kB  Peak Memory: 75kB
              Pre-sorted Groups: 27  Sort Method: quicksort  Average Memory: 581kB  Peak Memory: 581kB
              Buffers: shared hit=13537
              ->  Nested Loop  (cost=1.99..5769.66 rows=4044 width=1393) (actual time=0.059..8.318 rows=2361 loops=1)
                    Buffers: shared hit=13537
                    ->  Nested Loop  (cost=1.70..5121.54 rows=4044 width=1338) (actual time=0.050..6.825 rows=2361 loops=1)
                          Buffers: shared hit=12811
                          ->  Nested Loop  (cost=1.28..3028.84 rows=4044 width=355) (actual time=0.044..3.216 rows=2361 loops=1)
                                Buffers: shared hit=3367
                                ->  Nested Loop  (cost=0.85..507.87 rows=1633 width=64) (actual time=0.036..0.633 rows=649 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=457
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.023..0.170 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.009..0.016 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.38 rows=33 width=33) (actual time=0.003..0.007 rows=13 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=257
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.40 rows=14 width=299) (actual time=0.002..0.003 rows=4 loops=649)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=2910
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=2361)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=9444
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=2361)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 2119  Misses: 242  Evictions: 0  Overflows: 0  Memory Usage: 38kB
                          Buffers: shared hit=726
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=242)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=726
Planning:
  Buffers: shared hit=69
Planning Time: 8.311 ms
Execution Time: 12.739 ms
```

### ranked terms — q=python

Parameters: `["python","python"]` — Execution Time: 39.838 ms

```
Limit  (cost=22077.05..22077.18 rows=50 width=44) (actual time=39.627..39.649 rows=50 loops=1)
  Buffers: shared hit=3692
  CTE breadth
    ->  Aggregate  (cost=789.01..789.02 rows=1 width=1) (actual time=5.328..5.330 rows=1 loops=1)
          Buffers: shared hit=398
          ->  Limit  (cost=0.42..664.01 rows=10000 width=4) (actual time=0.025..4.730 rows=10000 loops=1)
                Buffers: shared hit=398
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..4754.63 rows=71644 width=4) (actual time=0.025..3.947 rows=10000 loops=1)
                      Index Cond: ((lower(name) >= 'python'::text) AND (lower(name) < 'pythoo'::text))
                      Filter: (lower(name) ~~ 'python%'::text)
                      Buffers: shared hit=398
  CTE prefix
    ->  Limit  (cost=15845.47..15845.60 rows=50 width=39) (actual time=39.525..39.541 rows=50 loops=1)
          Buffers: shared hit=3692
          ->  Sort  (cost=15845.47..15876.35 rows=12349 width=39) (actual time=39.525..39.537 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'python'::text) ELSE GREATEST(similarity(search_terms_3.name, 'python'::text), similarity(search_terms_3.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: top-N heapsort  Memory: 30kB
                Buffers: shared hit=3692
                ->  HashAggregate  (cost=15311.76..15435.25 rows=12349 width=39) (actual time=39.401..39.483 rows=203 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Batches: 1  Memory Usage: 433kB
                      Buffers: shared hit=3692
                      ->  Append  (cost=0.02..8828.69 rows=123487 width=68) (actual time=5.360..38.494 rows=247 loops=1)
                            Buffers: shared hit=3692
                            ->  Result  (cost=0.02..8049.98 rows=123049 width=68) (actual time=5.332..5.333 rows=0 loops=1)
                                  One-Time Filter: (NOT (InitPlan 2).col1)
                                  Buffers: shared hit=398
                                  InitPlan 2
                                    ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=5.329..5.330 rows=1 loops=1)
                                          Buffers: shared hit=398
                                  ->  Seq Scan on search_terms search_terms_3  (cost=0.02..8049.98 rows=123049 width=68) (never executed)
                                        Filter: ((lower(name) ~~ 'python%'::text) OR (lower(attr_path) ~~ 'python%'::text))
                            ->  Result  (cost=8.88..16.76 rows=2 width=68) (actual time=0.028..0.035 rows=16 loops=1)
                                  One-Time Filter: (InitPlan 3).col1
                                  Buffers: shared hit=8
                                  InitPlan 3
                                    ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=68) (actual time=0.026..0.029 rows=16 loops=1)
                                        Recheck Cond: ((lower(name) = 'python'::text) OR (lower(attr_path) = 'python'::text))
                                        Heap Blocks: exact=2
                                        Buffers: shared hit=8
                                        ->  BitmapOr  (cost=8.86..8.86 rows=2 width=0) (actual time=0.020..0.021 rows=0 loops=1)
                                              Buffers: shared hit=6
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.014..0.014 rows=16 loops=1)
                                                    Index Cond: (lower(name) = 'python'::text)
                                                    Buffers: shared hit=3
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.005..0.005 rows=1 loops=1)
                                                    Index Cond: (lower(attr_path) = 'python'::text)
                                                    Buffers: shared hit=3
                            ->  Result  (cost=0.30..49.71 rows=336 width=68) (actual time=0.257..0.405 rows=167 loops=1)
                                  One-Time Filter: (InitPlan 4).col1
                                  Buffers: shared hit=160
                                  InitPlan 4
                                    ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Index Scan using search_terms_alias_idx on search_terms search_terms_5  (cost=0.30..49.71 rows=336 width=68) (actual time=0.255..0.385 rows=167 loops=1)
                                        Filter: ((lower(name) ~~ 'python%'::text) OR (lower(attr_path) ~~ 'python%'::text))
                                        Rows Removed by Filter: 431
                                        Buffers: shared hit=160
                            ->  Subquery Scan on "*SELECT* 4"  (cost=1.76..76.99 rows=50 width=68) (actual time=0.954..0.960 rows=14 loops=1)
                                  Buffers: shared hit=198
                                  ->  Limit  (cost=1.76..76.49 rows=50 width=72) (actual time=0.953..0.957 rows=14 loops=1)
                                        Buffers: shared hit=198
                                        InitPlan 5
                                          ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=1.74..12870.94 rows=8610 width=72) (actual time=0.952..0.954 rows=14 loops=1)
                                              Sort Key: ((lower(search_terms_6.name) <-> 'python'::text)), search_terms_6.name
                                              Presorted Key: ((lower(search_terms_6.name) <-> 'python'::text))
                                              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                              Buffers: shared hit=198
                                              ->  Result  (cost=0.28..12483.53 rows=8610 width=72) (actual time=0.165..0.942 rows=14 loops=1)
                                                    One-Time Filter: (InitPlan 5).col1
                                                    Buffers: shared hit=198
                                                    ->  Index Scan using search_terms_top_level_name_knn_idx on search_terms search_terms_6  (cost=0.28..12440.48 rows=8610 width=68) (actual time=0.162..0.913 rows=14 loops=1)
                                                          Index Cond: (lower(name) ~~ 'python%'::text)
                                                          Rows Removed by Index Recheck: 13
                                                          Order By: (lower(name) <-> 'python'::text)
                                                          Buffers: shared hit=198
                            ->  Subquery Scan on "*SELECT* 5"  (cost=0.60..17.81 rows=50 width=68) (actual time=31.143..31.736 rows=50 loops=1)
                                  Buffers: shared hit=2928
                                  ->  Limit  (cost=0.60..17.31 rows=50 width=72) (actual time=31.142..31.728 rows=50 loops=1)
                                        Buffers: shared hit=2928
                                        InitPlan 6
                                          ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=0.58..21004.35 rows=62839 width=72) (actual time=31.141..31.723 rows=50 loops=1)
                                              Sort Key: ((lower(search_terms_7.name) <-> 'python'::text)), search_terms_7.name
                                              Presorted Key: ((lower(search_terms_7.name) <-> 'python'::text))
                                              Full-sort Groups: 2  Sort Methods: top-N heapsort, quicksort  Average Memory: 29kB  Peak Memory: 29kB
                                              Pre-sorted Groups: 1  Sort Method: top-N heapsort  Average Memory: 27kB  Peak Memory: 27kB
                                              Buffers: shared hit=2928
                                              ->  Result  (cost=0.28..18179.26 rows=62839 width=72) (actual time=30.900..31.646 rows=170 loops=1)
                                                    One-Time Filter: (InitPlan 6).col1
                                                    Buffers: shared hit=2928
                                                    ->  Index Scan using search_terms_nested_name_knn_idx on search_terms search_terms_7  (cost=0.28..17865.06 rows=62839 width=68) (actual time=30.885..31.239 rows=170 loops=1)
                                                          Index Cond: (lower(name) ~~ 'python%'::text)
                                                          Rows Removed by Index Recheck: 12
                                                          Order By: (lower(name) <-> 'python'::text)
                                                          Buffers: shared hit=2928
  ->  Sort  (cost=5442.43..5442.68 rows=100 width=44) (actual time=39.626..39.632 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=3692
        ->  GroupAggregate  (cost=5437.11..5439.11 rows=100 width=44) (actual time=39.592..39.614 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=3692
              ->  Sort  (cost=5437.11..5437.36 rows=100 width=42) (actual time=39.588..39.593 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=3692
                    ->  Append  (cost=0.00..5433.79 rows=100 width=42) (actual time=39.528..39.576 rows=50 loops=1)
                          Buffers: shared hit=3692
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=39.527..39.542 rows=50 loops=1)
                                Buffers: shared hit=3692
                          ->  Subquery Scan on fuzzy  (cost=5431.66..5432.29 rows=50 width=39) (actual time=0.026..0.028 rows=0 loops=1)
                                ->  Limit  (cost=5431.66..5431.79 rows=50 width=39) (actual time=0.026..0.027 rows=0 loops=1)
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.009..0.009 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.004 rows=50 loops=1)
                                      ->  Sort  (cost=5430.53..5437.08 rows=2620 width=39) (actual time=0.025..0.026 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'python'::text) ELSE GREATEST(similarity(search_terms.name, 'python'::text), similarity(search_terms.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            ->  HashAggregate  (cost=5317.30..5343.50 rows=2620 width=39) (actual time=0.022..0.023 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Batches: 1  Memory Usage: 121kB
                                                  ->  Result  (cost=1975.99..5179.75 rows=2620 width=68) (actual time=0.011..0.012 rows=0 loops=1)
                                                        One-Time Filter: ((InitPlan 8).col1 < 50)
                                                        ->  Bitmap Heap Scan on search_terms  (cost=1975.99..5179.75 rows=2620 width=68) (never executed)
                                                              Recheck Cond: ((name % 'python'::text) OR (attr_path % 'python'::text))
                                                              Filter: ((lower(name) !~~ 'python%'::text) AND (lower(attr_path) !~~ 'python%'::text))
                                                              ->  BitmapOr  (cost=1975.99..1975.99 rows=5118 width=0) (never executed)
                                                                    ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..987.34 rows=2559 width=0) (never executed)
                                                                          Index Cond: (name % 'python'::text)
                                                                    ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..987.34 rows=2560 width=0) (never executed)
                                                                          Index Cond: (attr_path % 'python'::text)
Planning:
  Buffers: shared hit=4
Planning Time: 1.370 ms
Execution Time: 39.838 ms
```

### batched fetch, latest — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,275383,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538"]` — Execution Time: 10.937 ms

```
Limit  (cost=2218.69..56873.92 rows=50 width=1378) (actual time=6.725..10.832 rows=50 loops=1)
  Buffers: shared hit=18112
  ->  Unique  (cost=2218.69..56873.92 rows=50 width=1378) (actual time=6.724..10.826 rows=50 loops=1)
        Buffers: shared hit=18112
        ->  Incremental Sort  (cost=2218.69..56872.15 rows=706 width=1378) (actual time=6.723..10.797 rows=123 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 4  Sort Method: quicksort  Average Memory: 65kB  Peak Memory: 65kB
              Buffers: shared hit=18112
              ->  Nested Loop  (cost=1103.52..56848.84 rows=706 width=1378) (actual time=2.449..10.680 rows=126 loops=1)
                    Buffers: shared hit=18112
                    ->  Nested Loop  (cost=1103.24..56638.78 rows=706 width=1323) (actual time=2.443..10.259 rows=126 loops=1)
                          Buffers: shared hit=17734
                          ->  Nested Loop  (cost=1102.81..56273.43 rows=706 width=340) (actual time=2.436..9.982 rows=126 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                Buffers: shared hit=17230
                                ->  Nested Loop  (cost=1102.38..56194.50 rows=50 width=53) (actual time=2.431..9.830 rows=50 loops=1)
                                      Buffers: shared hit=17003
                                      ->  Nested Loop  (cost=1101.96..56172.27 rows=50 width=30) (actual time=2.424..9.679 rows=50 loops=1)
                                            Buffers: shared hit=16803
                                            ->  Nested Loop  (cost=1101.54..55750.02 rows=50 width=12) (actual time=2.417..9.533 rows=50 loops=1)
                                                  Buffers: shared hit=16603
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.015 rows=50 loops=1)
                                                  ->  Limit  (cost=1101.53..1114.97 rows=1 width=25) (actual time=0.190..0.190 rows=1 loops=50)
                                                        Buffers: shared hit=16603
                                                        ->  Incremental Sort  (cost=1101.53..2203.28 rows=82 width=25) (actual time=0.190..0.190 rows=1 loops=50)
                                                              Sort Key: versions_1.prerelease, (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Presorted Key: versions_1.prerelease
                                                              Full-sort Groups: 50  Sort Methods: top-N heapsort, quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                                              Pre-sorted Groups: 3  Sort Method: top-N heapsort  Average Memory: 25kB  Peak Memory: 25kB
                                                              Buffers: shared hit=16603
                                                              ->  Nested Loop  (cost=0.86..2201.80 rows=82 width=25) (actual time=0.013..0.181 rows=35 loops=50)
                                                                    Buffers: shared hit=16603
                                                                    ->  Index Scan using versions_latest_idx on versions versions_1  (cost=0.43..68.04 rows=33 width=20) (actual time=0.004..0.007 rows=11 loops=50)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Buffers: shared hit=238
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..36.09 rows=14 width=8) (actual time=0.002..0.003 rows=3 loops=529)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=2237
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.09 rows=14 width=0) (actual time=0.001..0.001 rows=1 loops=1762)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=7048
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=1762)
                                                                            Buffers: shared hit=7080
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=1762)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=7080
                                            ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Index Cond: (id = versions_1.id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=50)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=200
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.40 rows=14 width=299) (actual time=0.001..0.002 rows=3 loops=50)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=227
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=126)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=504
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=126)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=378
Planning:
  Buffers: shared hit=115
Planning Time: 15.419 ms
Execution Time: 10.937 ms
```

### batched fetch, all versions — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,275383,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538"]` — Execution Time: 11.753 ms

```
Limit  (cost=119.91..1568.91 rows=1000 width=1393) (actual time=3.280..11.555 rows=647 loops=1)
  Buffers: shared hit=12489
  ->  Unique  (cost=119.91..5979.69 rows=4044 width=1393) (actual time=3.279..11.499 rows=647 loops=1)
        Buffers: shared hit=12489
        ->  Incremental Sort  (cost=119.91..5949.36 rows=4044 width=1393) (actual time=3.277..10.966 rows=2202 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 19  Sort Method: quicksort  Average Memory: 126kB  Peak Memory: 126kB
              Pre-sorted Groups: 13  Sort Method: quicksort  Average Memory: 912kB  Peak Memory: 912kB
              Buffers: shared hit=12489
              ->  Nested Loop  (cost=1.99..5769.66 rows=4044 width=1393) (actual time=0.061..7.692 rows=2202 loops=1)
                    Buffers: shared hit=12489
                    ->  Nested Loop  (cost=1.70..5121.54 rows=4044 width=1338) (actual time=0.051..6.409 rows=2202 loops=1)
                          Buffers: shared hit=11973
                          ->  Nested Loop  (cost=1.28..3028.84 rows=4044 width=355) (actual time=0.044..3.098 rows=2202 loops=1)
                                Buffers: shared hit=3165
                                ->  Nested Loop  (cost=0.85..507.87 rows=1633 width=64) (actual time=0.036..0.658 rows=647 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=436
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.022..0.187 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.016 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.38 rows=33 width=33) (actual time=0.003..0.007 rows=13 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=236
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.40 rows=14 width=299) (actual time=0.002..0.003 rows=3 loops=647)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=2729
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=2202)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=8808
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=2202)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 2030  Misses: 172  Evictions: 0  Overflows: 0  Memory Usage: 27kB
                          Buffers: shared hit=516
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=172)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=516
Planning:
  Buffers: shared hit=69
Planning Time: 8.462 ms
Execution Time: 11.753 ms
```

### ranked terms — q=python313Packages.

Parameters: `["python313Packages.","python313Packages."]` — Execution Time: 31.176 ms

```
Limit  (cost=39158.14..39158.27 rows=50 width=44) (actual time=28.500..30.987 rows=50 loops=1)
  Buffers: shared hit=3018
  CTE breadth
    ->  Aggregate  (cost=1118.37..1118.38 rows=1 width=1) (actual time=7.620..7.622 rows=1 loops=1)
          Buffers: shared hit=682
          ->  Limit  (cost=0.42..993.37 rows=10000 width=4) (actual time=0.022..6.976 rows=10000 loops=1)
                Buffers: shared hit=682
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..1270.80 rows=12794 width=4) (actual time=0.022..6.126 rows=10000 loops=1)
                      Index Cond: ((lower(name) >= 'python313packages.'::text) AND (lower(name) < 'python313packages/'::text))
                      Filter: (lower(name) ~~ 'python313packages.%'::text)
                      Buffers: shared hit=682
  CTE prefix
    ->  Limit  (cost=5941.55..5941.68 rows=50 width=39) (actual time=23.394..23.412 rows=50 loops=1)
          Buffers: shared hit=2974
          ->  Sort  (cost=5941.55..5947.83 rows=2512 width=39) (actual time=23.394..23.407 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'python313packages.'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'python313packages.'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'python313packages.%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'python313packages.%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'python313Packages.'::text) ELSE GREATEST(similarity(search_terms_3.name, 'python313Packages.'::text), similarity(search_terms_3.attr_path, 'python313Packages.'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: quicksort  Memory: 28kB
                Buffers: shared hit=2974
                ->  HashAggregate  (cost=5832.98..5858.10 rows=2512 width=39) (actual time=23.360..23.387 rows=50 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Batches: 1  Memory Usage: 121kB
                      Buffers: shared hit=2974
                      ->  Append  (cost=704.02..4514.45 rows=25115 width=68) (actual time=23.198..23.227 rows=50 loops=1)
                            Buffers: shared hit=2974
                            ->  Result  (cost=704.02..4091.38 rows=24945 width=68) (actual time=7.626..7.628 rows=0 loops=1)
                                  One-Time Filter: (NOT (InitPlan 2).col1)
                                  Buffers: shared hit=682
                                  InitPlan 2
                                    ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=7.623..7.624 rows=1 loops=1)
                                          Buffers: shared hit=682
                                  ->  Bitmap Heap Scan on search_terms search_terms_3  (cost=704.02..4091.38 rows=24945 width=68) (never executed)
                                        Recheck Cond: ((lower(name) ~~ 'python313packages.%'::text) OR (lower(attr_path) ~~ 'python313packages.%'::text))
                                        Filter: ((lower(name) ~~ 'python313packages.%'::text) OR (lower(attr_path) ~~ 'python313packages.%'::text))
                                        ->  BitmapOr  (cost=704.00..704.00 rows=20268 width=0) (never executed)
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..345.75 rows=10133 width=0) (never executed)
                                                    Index Cond: ((lower(name) >= 'python313packages.'::text) AND (lower(name) < 'python313packages/'::text))
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..345.78 rows=10136 width=0) (never executed)
                                                    Index Cond: ((lower(attr_path) >= 'python313packages.'::text) AND (lower(attr_path) < 'python313packages/'::text))
                            ->  Result  (cost=8.88..16.76 rows=2 width=68) (actual time=0.022..0.024 rows=0 loops=1)
                                  One-Time Filter: (InitPlan 3).col1
                                  Buffers: shared hit=6
                                  InitPlan 3
                                    ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=68) (actual time=0.020..0.021 rows=0 loops=1)
                                        Recheck Cond: ((lower(name) = 'python313packages.'::text) OR (lower(attr_path) = 'python313packages.'::text))
                                        Buffers: shared hit=6
                                        ->  BitmapOr  (cost=8.86..8.86 rows=2 width=0) (actual time=0.015..0.016 rows=0 loops=1)
                                              Buffers: shared hit=6
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.008..0.009 rows=0 loops=1)
                                                    Index Cond: (lower(name) = 'python313packages.'::text)
                                                    Buffers: shared hit=3
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.006..0.006 rows=0 loops=1)
                                                    Index Cond: (lower(attr_path) = 'python313packages.'::text)
                                                    Buffers: shared hit=3
                            ->  Result  (cost=0.30..49.71 rows=68 width=68) (actual time=0.401..0.402 rows=0 loops=1)
                                  One-Time Filter: (InitPlan 4).col1
                                  Buffers: shared hit=160
                                  InitPlan 4
                                    ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Index Scan using search_terms_alias_idx on search_terms search_terms_5  (cost=0.30..49.71 rows=68 width=68) (actual time=0.400..0.400 rows=0 loops=1)
                                        Filter: ((lower(name) ~~ 'python313packages.%'::text) OR (lower(attr_path) ~~ 'python313packages.%'::text))
                                        Rows Removed by Filter: 598
                                        Buffers: shared hit=160
                            ->  Subquery Scan on "*SELECT* 4"  (cost=3.56..168.67 rows=50 width=68) (actual time=2.528..2.530 rows=0 loops=1)
                                  Buffers: shared hit=47
                                  ->  Limit  (cost=3.56..168.17 rows=50 width=72) (actual time=2.527..2.529 rows=0 loops=1)
                                        Buffers: shared hit=47
                                        InitPlan 5
                                          ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=3.54..5063.87 rows=1537 width=72) (actual time=2.526..2.527 rows=0 loops=1)
                                              Sort Key: ((lower(search_terms_6.name) <-> 'python313packages.'::text)), search_terms_6.name
                                              Presorted Key: ((lower(search_terms_6.name) <-> 'python313packages.'::text))
                                              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                              Buffers: shared hit=47
                                              ->  Result  (cost=0.28..4994.70 rows=1537 width=72) (actual time=2.509..2.509 rows=0 loops=1)
                                                    One-Time Filter: (InitPlan 5).col1
                                                    Buffers: shared hit=47
                                                    ->  Index Scan using search_terms_top_level_name_knn_idx on search_terms search_terms_6  (cost=0.28..4987.02 rows=1537 width=68) (actual time=2.507..2.507 rows=0 loops=1)
                                                          Index Cond: (lower(name) ~~ 'python313packages.%'::text)
                                                          Order By: (lower(name) <-> 'python313packages.'::text)
                                                          Buffers: shared hit=47
                            ->  Subquery Scan on "*SELECT* 5"  (cost=1.48..62.35 rows=50 width=68) (actual time=12.617..12.634 rows=50 loops=1)
                                  Buffers: shared hit=2079
                                  ->  Limit  (cost=1.48..61.85 rows=50 width=72) (actual time=12.616..12.626 rows=50 loops=1)
                                        Buffers: shared hit=2079
                                        InitPlan 6
                                          ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.001..0.001 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=1.46..13549.68 rows=11221 width=72) (actual time=12.615..12.620 rows=50 loops=1)
                                              Sort Key: ((lower(search_terms_7.name) <-> 'python313packages.'::text)), search_terms_7.name
                                              Presorted Key: ((lower(search_terms_7.name) <-> 'python313packages.'::text))
                                              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 32kB  Peak Memory: 32kB
                                              Buffers: shared hit=2079
                                              ->  Result  (cost=0.28..13044.81 rows=11221 width=72) (actual time=12.326..12.579 rows=61 loops=1)
                                                    One-Time Filter: (InitPlan 6).col1
                                                    Buffers: shared hit=2079
                                                    ->  Index Scan using search_terms_nested_name_knn_idx on search_terms search_terms_7  (cost=0.28..12988.70 rows=11221 width=68) (actual time=12.311..12.422 rows=61 loops=1)
                                                          Index Cond: (lower(name) ~~ 'python313packages.%'::text)
                                                          Order By: (lower(name) <-> 'python313packages.'::text)
                                                          Buffers: shared hit=2079
  ->  Sort  (cost=32098.09..32098.34 rows=100 width=44) (actual time=28.499..30.968 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=3018
        ->  GroupAggregate  (cost=32092.77..32094.77 rows=100 width=44) (actual time=28.461..30.947 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=3018
              ->  Sort  (cost=32092.77..32093.02 rows=100 width=42) (actual time=28.453..30.922 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=3018
                    ->  Append  (cost=0.00..32089.44 rows=100 width=42) (actual time=23.398..30.908 rows=50 loops=1)
                          Buffers: shared hit=3018
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=23.397..23.411 rows=50 loops=1)
                                Buffers: shared hit=2974
                          ->  Subquery Scan on fuzzy  (cost=32087.32..32087.94 rows=50 width=39) (actual time=5.025..7.490 rows=0 loops=1)
                                Buffers: shared hit=44
                                ->  Limit  (cost=32087.32..32087.44 rows=50 width=39) (actual time=5.024..7.489 rows=0 loops=1)
                                      Buffers: shared hit=44
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.008..0.009 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.004 rows=50 loops=1)
                                      ->  Sort  (cost=32086.18..32358.77 rows=109035 width=39) (actual time=5.023..7.487 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'python313packages.'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'python313packages.'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'python313packages.%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'python313packages.%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'python313Packages.'::text) ELSE GREATEST(similarity(search_terms.name, 'python313Packages.'::text), similarity(search_terms.attr_path, 'python313Packages.'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            Buffers: shared hit=44
                                            ->  Finalize GroupAggregate  (cost=15481.23..28464.12 rows=109035 width=39) (actual time=5.015..7.478 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Buffers: shared hit=44
                                                  ->  Gather Merge  (cost=15481.23..26891.64 rows=64284 width=39) (actual time=5.014..7.476 rows=0 loops=1)
                                                        Workers Planned: 1
                                                        Workers Launched: 1
                                                        Buffers: shared hit=44
                                                        ->  Partial GroupAggregate  (cost=14481.22..18659.68 rows=64284 width=39) (actual time=0.044..0.044 rows=0 loops=2)
                                                              Group Key: search_terms.package_id, search_terms.name
                                                              Buffers: shared hit=44
                                                              ->  Sort  (cost=14481.22..14641.93 rows=64284 width=68) (actual time=0.043..0.043 rows=0 loops=2)
                                                                    Sort Key: search_terms.package_id, search_terms.name
                                                                    Sort Method: quicksort  Memory: 25kB
                                                                    Buffers: shared hit=44
                                                                    Worker 0:  Sort Method: quicksort  Memory: 25kB
                                                                    ->  Result  (cost=0.00..6708.44 rows=64284 width=68) (actual time=0.001..0.001 rows=0 loops=2)
                                                                          One-Time Filter: ((InitPlan 8).col1 < 50)
                                                                          ->  Parallel Seq Scan on search_terms  (cost=0.00..6708.44 rows=64284 width=68) (never executed)
                                                                                Filter: (((name % 'python313Packages.'::text) OR (attr_path % 'python313Packages.'::text)) AND (lower(name) !~~ 'python313packages.%'::text) AND (lower(attr_path) !~~ 'python313packages.%'::text))
Planning:
  Buffers: shared hit=4
Planning Time: 1.450 ms
Execution Time: 31.176 ms
```

### batched fetch, latest — q=python313Packages. (50 hits)

Parameters: `["150986,152209,150834,152035,152503,152537,152607,144825,145013,147350,147764,147765,147997,148046,148297,148334,150150,150536,150586,150612,150629,150655,150684,150771,150780,150816,150824,274938,150979,151062,151063,151070,151177,151212,151252,151267,151284,151298,151520,151586,151651,151873,272730,152489,152502,152504,152533,152553,152573,152630"]` — Execution Time: 5.391 ms

```
Limit  (cost=2218.69..56873.92 rows=50 width=1378) (actual time=1.287..5.289 rows=50 loops=1)
  Buffers: shared hit=8221
  ->  Unique  (cost=2218.69..56873.92 rows=50 width=1378) (actual time=1.286..5.283 rows=50 loops=1)
        Buffers: shared hit=8221
        ->  Incremental Sort  (cost=2218.69..56872.15 rows=706 width=1378) (actual time=1.285..5.247 rows=173 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 6  Sort Method: quicksort  Average Memory: 61kB  Peak Memory: 61kB
              Buffers: shared hit=8221
              ->  Nested Loop  (cost=1103.52..56848.84 rows=706 width=1378) (actual time=0.102..5.091 rows=175 loops=1)
                    Buffers: shared hit=8221
                    ->  Nested Loop  (cost=1103.24..56638.78 rows=706 width=1323) (actual time=0.098..4.824 rows=175 loops=1)
                          Buffers: shared hit=7696
                          ->  Nested Loop  (cost=1102.81..56273.43 rows=706 width=340) (actual time=0.091..4.422 rows=175 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                Buffers: shared hit=6996
                                ->  Nested Loop  (cost=1102.38..56194.50 rows=50 width=53) (actual time=0.088..4.216 rows=50 loops=1)
                                      Buffers: shared hit=6691
                                      ->  Nested Loop  (cost=1101.96..56172.27 rows=50 width=30) (actual time=0.082..4.083 rows=50 loops=1)
                                            Buffers: shared hit=6491
                                            ->  Nested Loop  (cost=1101.54..55750.02 rows=50 width=12) (actual time=0.076..3.947 rows=50 loops=1)
                                                  Buffers: shared hit=6291
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.014 rows=50 loops=1)
                                                  ->  Limit  (cost=1101.53..1114.97 rows=1 width=25) (actual time=0.078..0.078 rows=1 loops=50)
                                                        Buffers: shared hit=6291
                                                        ->  Incremental Sort  (cost=1101.53..2203.28 rows=82 width=25) (actual time=0.078..0.078 rows=1 loops=50)
                                                              Sort Key: versions_1.prerelease, (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Presorted Key: versions_1.prerelease
                                                              Full-sort Groups: 50  Sort Methods: top-N heapsort, quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                                              Pre-sorted Groups: 1  Sort Method: top-N heapsort  Average Memory: 25kB  Peak Memory: 25kB
                                                              Buffers: shared hit=6291
                                                              ->  Nested Loop  (cost=0.86..2201.80 rows=82 width=25) (actual time=0.013..0.075 rows=13 loops=50)
                                                                    Buffers: shared hit=6291
                                                                    ->  Index Scan using versions_latest_idx on versions versions_1  (cost=0.43..68.04 rows=33 width=20) (actual time=0.003..0.004 rows=3 loops=50)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Buffers: shared hit=217
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..36.09 rows=14 width=8) (actual time=0.003..0.004 rows=4 loops=173)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=847
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.09 rows=14 width=0) (actual time=0.001..0.001 rows=1 loops=637)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=2548
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=637)
                                                                            Buffers: shared hit=2679
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=637)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=2679
                                            ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=50)
                                                  Index Cond: (id = versions_1.id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=200
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.40 rows=14 width=299) (actual time=0.001..0.003 rows=4 loops=50)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=305
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=175)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=700
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=175)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=525
Planning:
  Buffers: shared hit=115
Planning Time: 13.989 ms
Execution Time: 5.391 ms
```

### batched fetch, all versions — q=python313Packages. (50 hits)

Parameters: `["150986,152209,150834,152035,152503,152537,152607,144825,145013,147350,147764,147765,147997,148046,148297,148334,150150,150536,150586,150612,150629,150655,150684,150771,150780,150816,150824,274938,150979,151062,151063,151070,151177,151212,151252,151267,151284,151298,151520,151586,151651,151873,272730,152489,152502,152504,152533,152553,152573,152630"]` — Execution Time: 4.821 ms

```
Limit  (cost=119.91..1568.91 rows=1000 width=1393) (actual time=0.453..4.709 rows=173 loops=1)
  Buffers: shared hit=4003
  ->  Unique  (cost=119.91..5979.69 rows=4044 width=1393) (actual time=0.452..4.692 rows=173 loops=1)
        Buffers: shared hit=4003
        ->  Incremental Sort  (cost=119.91..5949.36 rows=4044 width=1393) (actual time=0.451..4.505 rows=637 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 14  Sort Method: quicksort  Average Memory: 105kB  Peak Memory: 105kB
              Pre-sorted Groups: 2  Sort Method: quicksort  Average Memory: 65kB  Peak Memory: 101kB
              Buffers: shared hit=4003
              ->  Nested Loop  (cost=1.99..5769.66 rows=4044 width=1393) (actual time=0.058..3.331 rows=637 loops=1)
                    Buffers: shared hit=4003
                    ->  Nested Loop  (cost=1.70..5121.54 rows=4044 width=1338) (actual time=0.048..2.884 rows=637 loops=1)
                          Buffers: shared hit=3814
                          ->  Nested Loop  (cost=1.28..3028.84 rows=4044 width=355) (actual time=0.041..1.451 rows=637 loops=1)
                                Buffers: shared hit=1266
                                ->  Nested Loop  (cost=0.85..507.87 rows=1633 width=64) (actual time=0.033..0.435 rows=173 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=419
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.024..0.161 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.009..0.014 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.38 rows=33 width=33) (actual time=0.003..0.004 rows=3 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=219
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.40 rows=14 width=299) (actual time=0.003..0.005 rows=4 loops=173)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=847
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=637)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=2548
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=637)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 574  Misses: 63  Evictions: 0  Overflows: 0  Memory Usage: 10kB
                          Buffers: shared hit=189
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=63)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=189
Planning:
  Buffers: shared hit=69
Planning Time: 8.575 ms
Execution Time: 4.821 ms
```

### ranked terms — q=hello

Parameters: `["hello","hello"]` — Execution Time: 91.289 ms

```
Limit  (cost=2204.03..2204.16 rows=50 width=44) (actual time=91.056..91.076 rows=15 loops=1)
  Buffers: shared hit=1538
  CTE breadth
    ->  Aggregate  (cost=8.76..8.77 rows=1 width=1) (actual time=0.025..0.027 rows=1 loops=1)
          Buffers: shared hit=4
          ->  Limit  (cost=0.42..8.45 rows=25 width=4) (actual time=0.018..0.023 rows=5 loops=1)
                Buffers: shared hit=4
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..8.45 rows=25 width=4) (actual time=0.018..0.022 rows=5 loops=1)
                      Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                      Filter: (lower(name) ~~ 'hello%'::text)
                      Buffers: shared hit=4
  CTE prefix
    ->  Limit  (cost=68.30..68.42 rows=50 width=39) (actual time=0.076..0.089 rows=5 loops=1)
          Buffers: shared hit=11
          ->  Sort  (cost=68.30..68.50 rows=79 width=39) (actual time=0.076..0.088 rows=5 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'hello'::text) ELSE GREATEST(similarity(search_terms_3.name, 'hello'::text), similarity(search_terms_3.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=11
                ->  HashAggregate  (cost=65.02..65.81 rows=79 width=39) (actual time=0.072..0.084 rows=5 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Batches: 1  Memory Usage: 24kB
                      Buffers: shared hit=11
                      ->  Append  (cost=8.91..60.87 rows=79 width=68) (actual time=0.043..0.063 rows=5 loops=1)
                            Buffers: shared hit=11
                            ->  Result  (cost=8.91..12.93 rows=51 width=68) (actual time=0.043..0.048 rows=5 loops=1)
                                  One-Time Filter: (NOT (InitPlan 2).col1)
                                  Buffers: shared hit=11
                                  InitPlan 2
                                    ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=0.026..0.027 rows=1 loops=1)
                                          Buffers: shared hit=4
                                  ->  Bitmap Heap Scan on search_terms search_terms_3  (cost=8.91..12.93 rows=51 width=68) (actual time=0.014..0.017 rows=5 loops=1)
                                        Recheck Cond: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                                        Filter: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                                        Heap Blocks: exact=1
                                        Buffers: shared hit=7
                                        ->  BitmapOr  (cost=8.89..8.89 rows=1 width=0) (actual time=0.009..0.011 rows=0 loops=1)
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
                            ->  Result  (cost=8.88..12.90 rows=1 width=68) (actual time=0.001..0.002 rows=0 loops=1)
                                  One-Time Filter: (InitPlan 4).col1
                                  InitPlan 4
                                    ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_5  (cost=8.88..12.90 rows=1 width=68) (never executed)
                                        Recheck Cond: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                                        Filter: (((name = attr_path) IS FALSE) AND ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text)))
                                        ->  BitmapOr  (cost=8.86..8.86 rows=1 width=0) (never executed)
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                    Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                    Index Cond: ((lower(attr_path) >= 'hello'::text) AND (lower(attr_path) < 'hellp'::text))
                            ->  Subquery Scan on "*SELECT* 4"  (cost=8.51..8.54 rows=3 width=68) (actual time=0.003..0.004 rows=0 loops=1)
                                  ->  Limit  (cost=8.51..8.51 rows=3 width=72) (actual time=0.003..0.004 rows=0 loops=1)
                                        InitPlan 5
                                          ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Sort  (cost=8.49..8.49 rows=3 width=72) (actual time=0.003..0.003 rows=0 loops=1)
                                              Sort Key: ((lower(search_terms_6.name) <-> 'hello'::text)), search_terms_6.name
                                              Sort Method: quicksort  Memory: 25kB
                                              ->  Result  (cost=0.42..8.46 rows=3 width=72) (actual time=0.001..0.001 rows=0 loops=1)
                                                    One-Time Filter: (InitPlan 5).col1
                                                    ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_6  (cost=0.42..8.45 rows=3 width=68) (never executed)
                                                          Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                                          Filter: ((top_level_attr IS NOT NULL) AND ((name = attr_path) IS TRUE) AND (lower(name) ~~ 'hello%'::text))
                            ->  Subquery Scan on "*SELECT* 5"  (cost=9.07..9.34 rows=22 width=68) (actual time=0.002..0.003 rows=0 loops=1)
                                  ->  Limit  (cost=9.07..9.12 rows=22 width=72) (actual time=0.002..0.003 rows=0 loops=1)
                                        InitPlan 6
                                          ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Sort  (cost=9.05..9.10 rows=22 width=72) (actual time=0.001..0.002 rows=0 loops=1)
                                              Sort Key: ((lower(search_terms_7.name) <-> 'hello'::text)), search_terms_7.name
                                              Sort Method: quicksort  Memory: 25kB
                                              ->  Result  (cost=0.42..8.56 rows=22 width=72) (actual time=0.000..0.001 rows=0 loops=1)
                                                    One-Time Filter: (InitPlan 6).col1
                                                    ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_7  (cost=0.42..8.45 rows=22 width=68) (never executed)
                                                          Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                                          Filter: ((top_level_attr IS NULL) AND ((name = attr_path) IS TRUE) AND (lower(name) ~~ 'hello%'::text))
  ->  Sort  (cost=2126.84..2127.09 rows=100 width=44) (actual time=91.055..91.059 rows=15 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 26kB
        Buffers: shared hit=1538
        ->  GroupAggregate  (cost=2121.52..2123.52 rows=100 width=44) (actual time=91.042..91.052 rows=15 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=1538
              ->  Sort  (cost=2121.52..2121.77 rows=100 width=42) (actual time=91.038..91.042 rows=15 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=1538
                    ->  Append  (cost=0.00..2118.20 rows=100 width=42) (actual time=0.078..91.036 rows=15 loops=1)
                          Buffers: shared hit=1538
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=0.078..0.080 rows=5 loops=1)
                                Buffers: shared hit=11
                          ->  Subquery Scan on fuzzy  (cost=2116.07..2116.70 rows=50 width=39) (actual time=90.947..90.953 rows=10 loops=1)
                                Buffers: shared hit=1527
                                ->  Limit  (cost=2116.07..2116.20 rows=50 width=39) (actual time=90.946..90.950 rows=10 loops=1)
                                      Buffers: shared hit=1527
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.001 rows=5 loops=1)
                                      ->  Sort  (cost=2114.94..2115.06 rows=51 width=39) (actual time=90.945..90.947 rows=10 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'hello'::text) ELSE GREATEST(similarity(search_terms.name, 'hello'::text), similarity(search_terms.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            Buffers: shared hit=1527
                                            ->  GroupAggregate  (cost=2110.17..2113.49 rows=51 width=39) (actual time=90.920..90.940 rows=10 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Buffers: shared hit=1527
                                                  ->  Sort  (cost=2110.17..2110.30 rows=51 width=68) (actual time=90.907..90.909 rows=10 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        Buffers: shared hit=1527
                                                        ->  Result  (cost=1923.46..2108.73 rows=51 width=68) (actual time=42.701..90.896 rows=10 loops=1)
                                                              One-Time Filter: ((InitPlan 8).col1 < 50)
                                                              Buffers: shared hit=1527
                                                              ->  Bitmap Heap Scan on search_terms  (cost=1923.46..2108.73 rows=51 width=68) (actual time=42.697..90.888 rows=10 loops=1)
                                                                    Recheck Cond: ((name % 'hello'::text) OR (attr_path % 'hello'::text))
                                                                    Rows Removed by Index Recheck: 17553
                                                                    Filter: ((lower(name) !~~ 'hello%'::text) AND (lower(attr_path) !~~ 'hello%'::text))
                                                                    Rows Removed by Filter: 5
                                                                    Heap Blocks: exact=1049
                                                                    Buffers: shared hit=1527
                                                                    ->  BitmapOr  (cost=1923.46..1923.46 rows=51 width=0) (actual time=7.388..7.388 rows=0 loops=1)
                                                                          Buffers: shared hit=478
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..961.72 rows=25 width=0) (actual time=3.742..3.742 rows=17568 loops=1)
                                                                                Index Cond: (name % 'hello'::text)
                                                                                Buffers: shared hit=239
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..961.72 rows=25 width=0) (actual time=3.645..3.645 rows=17568 loops=1)
                                                                                Index Cond: (attr_path % 'hello'::text)
                                                                                Buffers: shared hit=239
Planning:
  Buffers: shared hit=4
Planning Time: 1.409 ms
Execution Time: 91.289 ms
```

### batched fetch, latest — q=hello (15 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,275101,51341,242138,42681"]` — Execution Time: 1.979 ms

```
Limit  (cost=2167.21..17062.35 rows=15 width=1378) (actual time=1.521..1.883 rows=15 loops=1)
  Buffers: shared hit=2839
  ->  Unique  (cost=2167.21..17062.35 rows=15 width=1378) (actual time=1.520..1.880 rows=15 loops=1)
        Buffers: shared hit=2839
        ->  Incremental Sort  (cost=2167.21..17061.82 rows=212 width=1378) (actual time=1.520..1.868 rows=47 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 64kB  Peak Memory: 64kB
              Buffers: shared hit=2839
              ->  Nested Loop  (cost=1103.52..17054.82 rows=212 width=1378) (actual time=0.260..1.817 rows=47 loops=1)
                    Buffers: shared hit=2839
                    ->  Nested Loop  (cost=1103.24..16991.74 rows=212 width=1323) (actual time=0.254..1.747 rows=47 loops=1)
                          Buffers: shared hit=2698
                          ->  Nested Loop  (cost=1102.81..16882.03 rows=212 width=340) (actual time=0.247..1.645 rows=47 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                Buffers: shared hit=2510
                                ->  Nested Loop  (cost=1102.38..16858.35 rows=15 width=53) (actual time=0.244..1.589 rows=15 loops=1)
                                      Buffers: shared hit=2424
                                      ->  Nested Loop  (cost=1101.96..16851.68 rows=15 width=30) (actual time=0.238..1.549 rows=15 loops=1)
                                            Buffers: shared hit=2364
                                            ->  Nested Loop  (cost=1101.54..16725.01 rows=15 width=12) (actual time=0.231..1.505 rows=15 loops=1)
                                                  Buffers: shared hit=2304
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.15 rows=15 width=12) (actual time=0.006..0.009 rows=15 loops=1)
                                                  ->  Limit  (cost=1101.53..1114.97 rows=1 width=25) (actual time=0.099..0.099 rows=1 loops=15)
                                                        Buffers: shared hit=2304
                                                        ->  Incremental Sort  (cost=1101.53..2203.28 rows=82 width=25) (actual time=0.099..0.099 rows=1 loops=15)
                                                              Sort Key: versions_1.prerelease, (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Presorted Key: versions_1.prerelease
                                                              Full-sort Groups: 15  Sort Methods: top-N heapsort, quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                                              Pre-sorted Groups: 1  Sort Method: top-N heapsort  Average Memory: 25kB  Peak Memory: 25kB
                                                              Buffers: shared hit=2304
                                                              ->  Nested Loop  (cost=0.86..2201.80 rows=82 width=25) (actual time=0.014..0.094 rows=15 loops=15)
                                                                    Buffers: shared hit=2304
                                                                    ->  Index Scan using versions_latest_idx on versions versions_1  (cost=0.43..68.04 rows=33 width=20) (actual time=0.004..0.005 rows=5 loops=15)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Buffers: shared hit=64
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..36.09 rows=14 width=8) (actual time=0.002..0.003 rows=3 loops=80)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=390
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.09 rows=14 width=0) (actual time=0.001..0.001 rows=1 loops=227)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=908
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.003 rows=1 loops=227)
                                                                            Buffers: shared hit=942
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=227)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=942
                                            ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=15)
                                                  Index Cond: (id = versions_1.id)
                                                  Buffers: shared hit=60
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=15)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=60
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.40 rows=14 width=299) (actual time=0.001..0.003 rows=3 loops=15)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=86
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=47)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=188
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=47)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=141
Planning:
  Buffers: shared hit=115
Planning Time: 15.042 ms
Execution Time: 1.979 ms
```

### batched fetch, all versions — q=hello (15 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,275101,51341,242138,42681"]` — Execution Time: 1.786 ms

```
Limit  (cost=130.99..1640.18 rows=1000 width=1393) (actual time=0.309..1.700 rows=80 loops=1)
  Buffers: shared hit=2103
  ->  Unique  (cost=130.99..1961.63 rows=1213 width=1393) (actual time=0.308..1.692 rows=80 loops=1)
        Buffers: shared hit=2103
        ->  Incremental Sort  (cost=130.99..1952.54 rows=1213 width=1393) (actual time=0.308..1.636 rows=227 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 5  Sort Method: quicksort  Average Memory: 88kB  Peak Memory: 88kB
              Pre-sorted Groups: 3  Sort Method: quicksort  Average Memory: 52kB  Peak Memory: 54kB
              Buffers: shared hit=2103
              ->  Nested Loop  (cost=1.98..1898.64 rows=1213 width=1393) (actual time=0.046..1.181 rows=227 loops=1)
                    Buffers: shared hit=2103
                    ->  Nested Loop  (cost=1.70..1537.71 rows=1213 width=1338) (actual time=0.041..0.850 rows=227 loops=1)
                          Buffers: shared hit=1422
                          ->  Nested Loop  (cost=1.28..910.01 rows=1213 width=355) (actual time=0.035..0.477 rows=227 loops=1)
                                Buffers: shared hit=514
                                ->  Nested Loop  (cost=0.85..153.56 rows=490 width=64) (actual time=0.028..0.141 rows=80 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=124
                                      ->  Nested Loop  (cost=0.42..126.72 rows=15 width=43) (actual time=0.019..0.056 rows=15 loops=1)
                                            Buffers: shared hit=60
                                            ->  Function Scan on unnest hits  (cost=0.00..0.15 rows=15 width=12) (actual time=0.007..0.009 rows=15 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=15)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=60
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.38 rows=33 width=33) (actual time=0.003..0.004 rows=5 loops=15)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=64
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.40 rows=14 width=299) (actual time=0.002..0.003 rows=3 loops=80)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=390
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=227)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=908
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=227)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=681
Planning:
  Buffers: shared hit=69
Planning Time: 8.241 ms
Execution Time: 1.786 ms
```

### ranked terms — q=-

Parameters: `["-","-"]` — Execution Time: 956.844 ms

```
Limit  (cost=7746.26..7746.39 rows=50 width=44) (actual time=955.044..956.713 rows=0 loops=1)
  Buffers: shared hit=3003
  CTE prefix
    ->  Limit  (cost=17.54..17.66 rows=50 width=39) (actual time=0.018..0.021 rows=0 loops=1)
          Buffers: shared hit=6
          ->  Sort  (cost=17.54..17.67 rows=51 width=39) (actual time=0.018..0.020 rows=0 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_1.name) = '-'::text) THEN 1000 WHEN (lower(search_terms_1.attr_path) = '-'::text) THEN 900 WHEN (lower(search_terms_1.name) ~~ '-%'::text) THEN 800 WHEN (lower(search_terms_1.attr_path) ~~ '-%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_1.name = search_terms_1.attr_path) THEN similarity(search_terms_1.name, '-'::text) ELSE GREATEST(similarity(search_terms_1.name, '-'::text), similarity(search_terms_1.attr_path, '-'::text)) END)) + (CASE WHEN (search_terms_1.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_1.name
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=6
                ->  HashAggregate  (cost=15.58..16.09 rows=51 width=39) (actual time=0.016..0.018 rows=0 loops=1)
                      Group Key: search_terms_1.package_id, search_terms_1.name
                      Batches: 1  Memory Usage: 24kB
                      Buffers: shared hit=6
                      ->  Bitmap Heap Scan on search_terms search_terms_1  (cost=8.89..12.91 rows=51 width=68) (actual time=0.015..0.017 rows=0 loops=1)
                            Recheck Cond: ((lower(name) ~~ '-%'::text) OR (lower(attr_path) ~~ '-%'::text))
                            Filter: ((lower(name) ~~ '-%'::text) OR (lower(attr_path) ~~ '-%'::text))
                            Buffers: shared hit=6
                            ->  BitmapOr  (cost=8.89..8.89 rows=1 width=0) (actual time=0.012..0.013 rows=0 loops=1)
                                  Buffers: shared hit=6
                                  ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.008..0.009 rows=0 loops=1)
                                        Index Cond: ((lower(name) >= '-'::text) AND (lower(name) < '.'::text))
                                        Buffers: shared hit=3
                                  ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.003..0.004 rows=0 loops=1)
                                        Index Cond: ((lower(attr_path) >= '-'::text) AND (lower(attr_path) < '.'::text))
                                        Buffers: shared hit=3
  ->  Sort  (cost=7728.60..7728.85 rows=100 width=44) (actual time=955.043..956.708 rows=0 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=3003
        ->  GroupAggregate  (cost=7723.28..7725.28 rows=100 width=44) (actual time=955.041..956.706 rows=0 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=3003
              ->  Sort  (cost=7723.28..7723.53 rows=100 width=42) (actual time=955.040..956.704 rows=0 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=3003
                    ->  Append  (cost=0.00..7719.96 rows=100 width=42) (actual time=955.038..956.702 rows=0 loops=1)
                          Buffers: shared hit=3003
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=0.019..0.019 rows=0 loops=1)
                                Buffers: shared hit=6
                          ->  Subquery Scan on fuzzy  (cost=7717.83..7718.46 rows=50 width=39) (actual time=955.018..956.681 rows=0 loops=1)
                                Buffers: shared hit=2997
                                ->  Limit  (cost=7717.83..7717.96 rows=50 width=39) (actual time=955.017..956.679 rows=0 loops=1)
                                      Buffers: shared hit=2997
                                      InitPlan 2
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.002..0.003 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.000 rows=0 loops=1)
                                      ->  Sort  (cost=7716.70..7716.82 rows=51 width=39) (actual time=955.016..956.677 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = '-'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = '-'::text) THEN 900 WHEN (lower(search_terms.name) ~~ '-%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ '-%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, '-'::text) ELSE GREATEST(similarity(search_terms.name, '-'::text), similarity(search_terms.attr_path, '-'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            Buffers: shared hit=2997
                                            ->  Finalize GroupAggregate  (cost=7709.19..7715.25 rows=51 width=39) (actual time=955.015..956.675 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Buffers: shared hit=2997
                                                  ->  Gather Merge  (cost=7709.19..7714.51 rows=30 width=39) (actual time=955.014..956.674 rows=0 loops=1)
                                                        Workers Planned: 1
                                                        Workers Launched: 1
                                                        Buffers: shared hit=2997
                                                        ->  Partial GroupAggregate  (cost=6709.18..6711.13 rows=30 width=39) (actual time=947.683..947.684 rows=0 loops=2)
                                                              Group Key: search_terms.package_id, search_terms.name
                                                              Buffers: shared hit=2997
                                                              ->  Sort  (cost=6709.18..6709.25 rows=30 width=68) (actual time=947.682..947.682 rows=0 loops=2)
                                                                    Sort Key: search_terms.package_id, search_terms.name
                                                                    Sort Method: quicksort  Memory: 25kB
                                                                    Buffers: shared hit=2997
                                                                    Worker 0:  Sort Method: quicksort  Memory: 25kB
                                                                    ->  Result  (cost=0.00..6708.44 rows=30 width=68) (actual time=947.665..947.665 rows=0 loops=2)
                                                                          One-Time Filter: ((InitPlan 2).col1 < 50)
                                                                          Buffers: shared hit=2982
                                                                          ->  Parallel Seq Scan on search_terms  (cost=0.00..6708.44 rows=30 width=68) (actual time=947.663..947.663 rows=0 loops=2)
                                                                                Filter: (((name % '-'::text) OR (attr_path % '-'::text)) AND (lower(name) !~~ '-%'::text) AND (lower(attr_path) !~~ '-%'::text))
                                                                                Rows Removed by Filter: 127160
                                                                                Buffers: shared hit=2982
Planning:
  Buffers: shared hit=30
Planning Time: 8.798 ms
Execution Time: 956.844 ms
```

### batched fetch, latest — q=- (0 hits)

Parameters: `[""]` — Execution Time: 0.103 ms

```
Limit  (cost=1137.15..1137.38 rows=1 width=1378) (actual time=0.013..0.014 rows=0 loops=1)
  ->  Unique  (cost=1137.15..1137.38 rows=1 width=1378) (actual time=0.012..0.013 rows=0 loops=1)
        ->  Incremental Sort  (cost=1137.15..1137.34 rows=14 width=1378) (actual time=0.011..0.012 rows=0 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
              ->  Nested Loop  (cost=1103.52..1136.88 rows=14 width=1378) (actual time=0.004..0.005 rows=0 loops=1)
                    ->  Nested Loop  (cost=1103.24..1132.72 rows=14 width=1323) (actual time=0.004..0.005 rows=0 loops=1)
                          ->  Nested Loop  (cost=1102.81..1125.47 rows=14 width=340) (actual time=0.004..0.005 rows=0 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                ->  Nested Loop  (cost=1102.38..1123.89 rows=1 width=53) (actual time=0.004..0.005 rows=0 loops=1)
                                      ->  Nested Loop  (cost=1101.96..1123.45 rows=1 width=30) (actual time=0.004..0.004 rows=0 loops=1)
                                            ->  Nested Loop  (cost=1101.54..1115.00 rows=1 width=12) (actual time=0.004..0.004 rows=0 loops=1)
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.01 rows=1 width=12) (actual time=0.003..0.004 rows=0 loops=1)
                                                  ->  Limit  (cost=1101.53..1114.97 rows=1 width=25) (never executed)
                                                        ->  Incremental Sort  (cost=1101.53..2203.28 rows=82 width=25) (never executed)
                                                              Sort Key: versions_1.prerelease, (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Presorted Key: versions_1.prerelease
                                                              ->  Nested Loop  (cost=0.86..2201.80 rows=82 width=25) (never executed)
                                                                    ->  Index Scan using versions_latest_idx on versions versions_1  (cost=0.43..68.04 rows=33 width=20) (never executed)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..36.09 rows=14 width=8) (never executed)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.09 rows=14 width=0) (never executed)
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
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.40 rows=14 width=299) (never executed)
                                      Index Cond: (version_id = versions.id)
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (never executed)
                                Index Cond: (id = variants.meta_id)
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (never executed)
                          Index Cond: (seq = variants.commit_seq)
Planning:
  Buffers: shared hit=115
Planning Time: 14.783 ms
Execution Time: 0.103 ms
```

### batched fetch, all versions — q=- (0 hits)

Parameters: `[""]` — Execution Time: 0.088 ms

```
Limit  (cost=130.62..132.28 rows=82 width=1393) (actual time=0.014..0.015 rows=0 loops=1)
  ->  Unique  (cost=130.62..132.28 rows=82 width=1393) (actual time=0.013..0.014 rows=0 loops=1)
        ->  Incremental Sort  (cost=130.62..131.67 rows=82 width=1393) (actual time=0.013..0.013 rows=0 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
              ->  Nested Loop  (cost=1.98..128.02 rows=82 width=1393) (actual time=0.004..0.005 rows=0 loops=1)
                    ->  Nested Loop  (cost=1.70..103.62 rows=82 width=1338) (actual time=0.004..0.004 rows=0 loops=1)
                          ->  Nested Loop  (cost=1.28..61.18 rows=82 width=355) (actual time=0.004..0.004 rows=0 loops=1)
                                ->  Nested Loop  (cost=0.85..10.24 rows=33 width=64) (actual time=0.004..0.004 rows=0 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      ->  Nested Loop  (cost=0.42..8.45 rows=1 width=43) (actual time=0.004..0.004 rows=0 loops=1)
                                            ->  Function Scan on unnest hits  (cost=0.00..0.01 rows=1 width=12) (actual time=0.003..0.003 rows=0 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (never executed)
                                                  Index Cond: (id = hits.package_id)
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.38 rows=33 width=33) (never executed)
                                            Index Cond: (package_id = packages.id)
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.40 rows=14 width=299) (never executed)
                                      Index Cond: (version_id = versions.id)
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (never executed)
                                Index Cond: (id = variants.meta_id)
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (never executed)
                          Index Cond: (seq = variants.commit_seq)
Planning:
  Buffers: shared hit=69
Planning Time: 8.849 ms
Execution Time: 0.088 ms
```

## Name lookups (/v2/resolve, /v1/resolve, /v2/pkg, /v1/pkg)

### pick latest version — name=go

Parameters: `["go"]` — Execution Time: 8.574 ms

```
Limit  (cost=2821.09..2821.09 rows=1 width=24) (actual time=8.480..8.485 rows=1 loops=1)
  Buffers: shared hit=15706
  ->  Sort  (cost=2821.09..2821.40 rows=125 width=24) (actual time=8.478..8.482 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=15706
        ->  Nested Loop  (cost=211.57..2820.47 rows=125 width=24) (actual time=1.153..8.342 rows=671 loops=1)
              Buffers: shared hit=15706
              ->  Nested Loop  (cost=211.15..1334.90 rows=125 width=27) (actual time=1.131..3.992 rows=671 loops=1)
                    Buffers: shared hit=6972
                    ->  Nested Loop  (cost=210.72..1275.94 rows=126 width=8) (actual time=1.125..2.705 rows=746 loops=1)
                          Buffers: shared hit=3988
                          ->  HashAggregate  (cost=210.29..211.55 rows=126 width=4) (actual time=1.118..1.241 rows=746 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=1004
                                ->  Append  (cost=1.28..209.98 rows=126 width=4) (actual time=0.032..0.934 rows=1012 loops=1)
                                      Buffers: shared hit=1004
                                      ->  Nested Loop  (cost=1.28..86.07 rows=15 width=4) (actual time=0.031..0.770 rows=746 loops=1)
                                            Buffers: shared hit=934
                                            ->  Nested Loop  (cost=0.85..76.81 rows=6 width=4) (actual time=0.025..0.100 rows=196 loops=1)
                                                  Buffers: shared hit=28
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.014 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'go'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..68.04 rows=33 width=8) (actual time=0.009..0.061 rows=196 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=24
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.40 rows=14 width=8) (actual time=0.002..0.003 rows=4 loops=196)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=906
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..123.28 rows=111 width=4) (actual time=0.007..0.083 rows=266 loops=1)
                                            Index Cond: (attr_path = 'go'::text)
                                            Buffers: shared hit=70
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=746)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=2984
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=746)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=2984
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=671)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 671
                    Buffers: shared hit=3356
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.09 rows=14 width=0) (actual time=0.002..0.002 rows=1 loops=671)
                      Index Cond: (version_id = versions.id)
                      Filter: (NOT broken)
                      Buffers: shared hit=2684
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=671)
                      Buffers: shared hit=2694
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=671)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=2694
Planning:
  Buffers: shared hit=94
Planning Time: 12.371 ms
Execution Time: 8.574 ms
```

### pick latest version — name=python

Parameters: `["python"]` — Execution Time: 6.447 ms

```
Limit  (cost=2821.09..2821.09 rows=1 width=24) (actual time=6.285..6.289 rows=1 loops=1)
  Buffers: shared hit=11805
  ->  Sort  (cost=2821.09..2821.40 rows=125 width=24) (actual time=6.283..6.287 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=11805
        ->  Nested Loop  (cost=211.57..2820.47 rows=125 width=24) (actual time=0.964..6.194 rows=433 loops=1)
              Buffers: shared hit=11805
              ->  Nested Loop  (cost=211.15..1334.90 rows=125 width=27) (actual time=0.941..3.537 rows=433 loops=1)
                    Buffers: shared hit=6166
                    ->  Nested Loop  (cost=210.72..1275.94 rows=126 width=8) (actual time=0.935..2.236 rows=669 loops=1)
                          Buffers: shared hit=3490
                          ->  HashAggregate  (cost=210.29..211.55 rows=126 width=4) (actual time=0.929..1.034 rows=669 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=814
                                ->  Append  (cost=1.28..209.98 rows=126 width=4) (actual time=0.031..0.722 rows=672 loops=1)
                                      Buffers: shared hit=814
                                      ->  Nested Loop  (cost=1.28..86.07 rows=15 width=4) (actual time=0.030..0.660 rows=669 loops=1)
                                            Buffers: shared hit=809
                                            ->  Nested Loop  (cost=0.85..76.81 rows=6 width=4) (actual time=0.024..0.099 rows=183 loops=1)
                                                  Buffers: shared hit=30
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.014 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'python'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..68.04 rows=33 width=8) (actual time=0.007..0.061 rows=183 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=26
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.40 rows=14 width=8) (actual time=0.002..0.002 rows=4 loops=183)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=779
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..123.28 rows=111 width=4) (actual time=0.007..0.008 rows=3 loops=1)
                                            Index Cond: (attr_path = 'python'::text)
                                            Buffers: shared hit=5
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.001..0.001 rows=1 loops=669)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=2676
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.002..0.002 rows=1 loops=669)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=2676
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=433)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 433
                    Buffers: shared hit=2166
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.09 rows=14 width=0) (actual time=0.002..0.002 rows=1 loops=433)
                      Index Cond: (version_id = versions.id)
                      Filter: (NOT broken)
                      Buffers: shared hit=1732
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=433)
                      Buffers: shared hit=1741
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=433)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=1741
Planning:
  Buffers: shared hit=94
Planning Time: 12.225 ms
Execution Time: 6.447 ms
```

### pick latest version — name=python311

Parameters: `["python311"]` — Execution Time: 0.905 ms

```
Limit  (cost=2821.09..2821.09 rows=1 width=24) (actual time=0.819..0.822 rows=1 loops=1)
  Buffers: shared hit=1444
  ->  Sort  (cost=2821.09..2821.40 rows=125 width=24) (actual time=0.818..0.820 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=1444
        ->  Nested Loop  (cost=211.57..2820.47 rows=125 width=24) (actual time=0.133..0.801 rows=54 loops=1)
              Buffers: shared hit=1444
              ->  Nested Loop  (cost=211.15..1334.90 rows=125 width=27) (actual time=0.108..0.430 rows=54 loops=1)
                    Buffers: shared hit=738
                    ->  Nested Loop  (cost=210.72..1275.94 rows=126 width=8) (actual time=0.100..0.272 rows=90 loops=1)
                          Buffers: shared hit=378
                          ->  HashAggregate  (cost=210.29..211.55 rows=126 width=4) (actual time=0.092..0.104 rows=90 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=18
                                ->  Append  (cost=1.28..209.98 rows=126 width=4) (actual time=0.022..0.073 rows=90 loops=1)
                                      Buffers: shared hit=18
                                      ->  Nested Loop  (cost=1.28..86.07 rows=15 width=4) (actual time=0.012..0.012 rows=0 loops=1)
                                            Buffers: shared hit=3
                                            ->  Nested Loop  (cost=0.85..76.81 rows=6 width=4) (actual time=0.011..0.012 rows=0 loops=1)
                                                  Buffers: shared hit=3
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.011..0.011 rows=0 loops=1)
                                                        Index Cond: (lower(name) = 'python311'::text)
                                                        Buffers: shared hit=3
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..68.04 rows=33 width=8) (never executed)
                                                        Index Cond: (package_id = p.id)
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.40 rows=14 width=8) (never executed)
                                                  Index Cond: (version_id = ve.id)
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..123.28 rows=111 width=4) (actual time=0.010..0.053 rows=90 loops=1)
                                            Index Cond: (attr_path = 'python311'::text)
                                            Buffers: shared hit=15
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=90)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=360
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=90)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=360
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=54)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 54
                    Buffers: shared hit=271
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.09 rows=14 width=0) (actual time=0.002..0.002 rows=1 loops=54)
                      Index Cond: (version_id = versions.id)
                      Filter: (NOT broken)
                      Buffers: shared hit=216
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=54)
                      Buffers: shared hit=219
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=54)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=219
Planning:
  Buffers: shared hit=94
Planning Time: 12.655 ms
Execution Time: 0.905 ms
```

### pick latest version — name=hello

Parameters: `["hello"]` — Execution Time: 0.393 ms

```
Limit  (cost=2821.09..2821.09 rows=1 width=24) (actual time=0.310..0.312 rows=1 loops=1)
  Buffers: shared hit=444
  ->  Sort  (cost=2821.09..2821.40 rows=125 width=24) (actual time=0.309..0.311 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=444
        ->  Nested Loop  (cost=211.57..2820.47 rows=125 width=24) (actual time=0.116..0.298 rows=19 loops=1)
              Buffers: shared hit=444
              ->  Nested Loop  (cost=211.15..1334.90 rows=125 width=27) (actual time=0.087..0.159 rows=19 loops=1)
                    Buffers: shared hit=193
                    ->  Nested Loop  (cost=210.72..1275.94 rows=126 width=8) (actual time=0.081..0.118 rows=19 loops=1)
                          Buffers: shared hit=117
                          ->  HashAggregate  (cost=210.29..211.55 rows=126 width=4) (actual time=0.076..0.080 rows=19 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=41
                                ->  Append  (cost=1.28..209.98 rows=126 width=4) (actual time=0.028..0.065 rows=38 loops=1)
                                      Buffers: shared hit=41
                                      ->  Nested Loop  (cost=1.28..86.07 rows=15 width=4) (actual time=0.027..0.050 rows=19 loops=1)
                                            Buffers: shared hit=33
                                            ->  Nested Loop  (cost=0.85..76.81 rows=6 width=4) (actual time=0.021..0.024 rows=5 loops=1)
                                                  Buffers: shared hit=8
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.012 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'hello'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..68.04 rows=33 width=8) (actual time=0.007..0.008 rows=5 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=4
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.40 rows=14 width=8) (actual time=0.003..0.005 rows=4 loops=5)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=25
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..123.28 rows=111 width=4) (actual time=0.006..0.011 rows=19 loops=1)
                                            Index Cond: (attr_path = 'hello'::text)
                                            Buffers: shared hit=8
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
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.09 rows=14 width=0) (actual time=0.001..0.001 rows=1 loops=19)
                      Index Cond: (version_id = versions.id)
                      Filter: (NOT broken)
                      Buffers: shared hit=76
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.003..0.003 rows=1 loops=19)
                      Buffers: shared hit=79
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=19)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=79
Planning:
  Buffers: shared hit=94
Planning Time: 12.012 ms
Execution Time: 0.393 ms
```

### every version — name=go

Parameters: `["go"]` — Execution Time: 8.777 ms

```
Sort  (cost=1498.01..1498.33 rows=126 width=1389) (actual time=8.527..8.565 rows=746 loops=1)
  Sort Key: versions.sort_key DESC, versions.version, versions.id, variants.system, variants.attr_path
  Sort Method: quicksort  Memory: 576kB
  Buffers: shared hit=15178
  ->  Nested Loop  (cost=212.27..1493.61 rows=126 width=1389) (actual time=1.372..7.553 rows=746 loops=1)
        Buffers: shared hit=15178
        ->  Nested Loop  (cost=211.99..1456.12 rows=126 width=1334) (actual time=1.366..6.446 rows=746 loops=1)
              Buffers: shared hit=12940
              ->  Nested Loop  (cost=211.57..1390.92 rows=126 width=351) (actual time=1.360..5.276 rows=746 loops=1)
                    Buffers: shared hit=9956
                    ->  Nested Loop  (cost=211.15..1334.90 rows=126 width=328) (actual time=1.355..4.150 rows=746 loops=1)
                          Buffers: shared hit=6972
                          ->  Nested Loop  (cost=210.72..1275.94 rows=126 width=299) (actual time=1.348..2.898 rows=746 loops=1)
                                Buffers: shared hit=3988
                                ->  HashAggregate  (cost=210.29..211.55 rows=126 width=4) (actual time=1.340..1.454 rows=746 loops=1)
                                      Group Key: va.id
                                      Batches: 1  Memory Usage: 89kB
                                      Buffers: shared hit=1004
                                      ->  Append  (cost=1.28..209.98 rows=126 width=4) (actual time=0.034..1.155 rows=1012 loops=1)
                                            Buffers: shared hit=1004
                                            ->  Nested Loop  (cost=1.28..86.07 rows=15 width=4) (actual time=0.034..0.954 rows=746 loops=1)
                                                  Buffers: shared hit=934
                                                  ->  Nested Loop  (cost=0.85..76.81 rows=6 width=4) (actual time=0.027..0.107 rows=196 loops=1)
                                                        Buffers: shared hit=28
                                                        ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.015..0.015 rows=1 loops=1)
                                                              Index Cond: (lower(name) = 'go'::text)
                                                              Buffers: shared hit=4
                                                        ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..68.04 rows=33 width=8) (actual time=0.010..0.066 rows=196 loops=1)
                                                              Index Cond: (package_id = p.id)
                                                              Buffers: shared hit=24
                                                  ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.40 rows=14 width=8) (actual time=0.002..0.004 rows=4 loops=196)
                                                        Index Cond: (version_id = ve.id)
                                                        Buffers: shared hit=906
                                            ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..123.28 rows=111 width=4) (actual time=0.010..0.122 rows=266 loops=1)
                                                  Index Cond: (attr_path = 'go'::text)
                                                  Buffers: shared hit=70
                                ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=303) (actual time=0.002..0.002 rows=1 loops=746)
                                      Index Cond: (id = va.id)
                                      Buffers: shared hit=2984
                          ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=746)
                                Index Cond: (id = variants.version_id)
                                Buffers: shared hit=2984
                    ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=746)
                          Index Cond: (id = versions.package_id)
                          Buffers: shared hit=2984
              ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=746)
                    Index Cond: (id = variants.meta_id)
                    Buffers: shared hit=2984
        ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=746)
              Index Cond: (seq = variants.commit_seq)
              Buffers: shared hit=2238
Planning:
  Buffers: shared hit=116
Planning Time: 14.663 ms
Execution Time: 8.777 ms
```

### every version — name=python

Parameters: `["python"]` — Execution Time: 7.927 ms

```
Sort  (cost=1498.01..1498.33 rows=126 width=1389) (actual time=7.568..7.606 rows=669 loops=1)
  Sort Key: versions.sort_key DESC, versions.version, versions.id, variants.system, variants.attr_path
  Sort Method: quicksort  Memory: 906kB
  Buffers: shared hit=13525
  ->  Nested Loop  (cost=212.27..1493.61 rows=126 width=1389) (actual time=0.872..6.595 rows=669 loops=1)
        Buffers: shared hit=13525
        ->  Nested Loop  (cost=211.99..1456.12 rows=126 width=1334) (actual time=0.866..5.579 rows=669 loops=1)
              Buffers: shared hit=11518
              ->  Nested Loop  (cost=211.57..1390.92 rows=126 width=351) (actual time=0.860..4.442 rows=669 loops=1)
                    Buffers: shared hit=8842
                    ->  Nested Loop  (cost=211.15..1334.90 rows=126 width=328) (actual time=0.855..3.407 rows=669 loops=1)
                          Buffers: shared hit=6166
                          ->  Nested Loop  (cost=210.72..1275.94 rows=126 width=299) (actual time=0.850..2.264 rows=669 loops=1)
                                Buffers: shared hit=3490
                                ->  HashAggregate  (cost=210.29..211.55 rows=126 width=4) (actual time=0.843..0.960 rows=669 loops=1)
                                      Group Key: va.id
                                      Batches: 1  Memory Usage: 89kB
                                      Buffers: shared hit=814
                                      ->  Append  (cost=1.28..209.98 rows=126 width=4) (actual time=0.031..0.711 rows=672 loops=1)
                                            Buffers: shared hit=814
                                            ->  Nested Loop  (cost=1.28..86.07 rows=15 width=4) (actual time=0.030..0.651 rows=669 loops=1)
                                                  Buffers: shared hit=809
                                                  ->  Nested Loop  (cost=0.85..76.81 rows=6 width=4) (actual time=0.023..0.096 rows=183 loops=1)
                                                        Buffers: shared hit=30
                                                        ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.014 rows=1 loops=1)
                                                              Index Cond: (lower(name) = 'python'::text)
                                                              Buffers: shared hit=4
                                                        ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..68.04 rows=33 width=8) (actual time=0.007..0.059 rows=183 loops=1)
                                                              Index Cond: (package_id = p.id)
                                                              Buffers: shared hit=26
                                                  ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.40 rows=14 width=8) (actual time=0.002..0.002 rows=4 loops=183)
                                                        Index Cond: (version_id = ve.id)
                                                        Buffers: shared hit=779
                                            ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..123.28 rows=111 width=4) (actual time=0.006..0.007 rows=3 loops=1)
                                                  Index Cond: (attr_path = 'python'::text)
                                                  Buffers: shared hit=5
                                ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=303) (actual time=0.002..0.002 rows=1 loops=669)
                                      Index Cond: (id = va.id)
                                      Buffers: shared hit=2676
                          ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=669)
                                Index Cond: (id = variants.version_id)
                                Buffers: shared hit=2676
                    ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=669)
                          Index Cond: (id = versions.package_id)
                          Buffers: shared hit=2676
              ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=669)
                    Index Cond: (id = variants.meta_id)
                    Buffers: shared hit=2676
        ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=669)
              Index Cond: (seq = variants.commit_seq)
              Buffers: shared hit=2007
Planning:
  Buffers: shared hit=116
Planning Time: 13.466 ms
Execution Time: 7.927 ms
```

### every version — name=python311

Parameters: `["python311"]` — Execution Time: 1.216 ms

```
Sort  (cost=1498.01..1498.33 rows=126 width=1389) (actual time=1.109..1.115 rows=90 loops=1)
  Sort Key: versions.sort_key DESC, versions.version, versions.id, variants.system, variants.attr_path
  Sort Method: quicksort  Memory: 140kB
  Buffers: shared hit=1728
  ->  Nested Loop  (cost=212.27..1493.61 rows=126 width=1389) (actual time=0.113..0.880 rows=90 loops=1)
        Buffers: shared hit=1728
        ->  Nested Loop  (cost=211.99..1456.12 rows=126 width=1334) (actual time=0.108..0.737 rows=90 loops=1)
              Buffers: shared hit=1458
              ->  Nested Loop  (cost=211.57..1390.92 rows=126 width=351) (actual time=0.102..0.575 rows=90 loops=1)
                    Buffers: shared hit=1098
                    ->  Nested Loop  (cost=211.15..1334.90 rows=126 width=328) (actual time=0.096..0.425 rows=90 loops=1)
                          Buffers: shared hit=738
                          ->  Nested Loop  (cost=210.72..1275.94 rows=126 width=299) (actual time=0.090..0.271 rows=90 loops=1)
                                Buffers: shared hit=378
                                ->  HashAggregate  (cost=210.29..211.55 rows=126 width=4) (actual time=0.082..0.095 rows=90 loops=1)
                                      Group Key: va.id
                                      Batches: 1  Memory Usage: 40kB
                                      Buffers: shared hit=18
                                      ->  Append  (cost=1.28..209.98 rows=126 width=4) (actual time=0.022..0.065 rows=90 loops=1)
                                            Buffers: shared hit=18
                                            ->  Nested Loop  (cost=1.28..86.07 rows=15 width=4) (actual time=0.011..0.012 rows=0 loops=1)
                                                  Buffers: shared hit=3
                                                  ->  Nested Loop  (cost=0.85..76.81 rows=6 width=4) (actual time=0.011..0.012 rows=0 loops=1)
                                                        Buffers: shared hit=3
                                                        ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.011..0.011 rows=0 loops=1)
                                                              Index Cond: (lower(name) = 'python311'::text)
                                                              Buffers: shared hit=3
                                                        ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..68.04 rows=33 width=8) (never executed)
                                                              Index Cond: (package_id = p.id)
                                                  ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.40 rows=14 width=8) (never executed)
                                                        Index Cond: (version_id = ve.id)
                                            ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..123.28 rows=111 width=4) (actual time=0.010..0.045 rows=90 loops=1)
                                                  Index Cond: (attr_path = 'python311'::text)
                                                  Buffers: shared hit=15
                                ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=303) (actual time=0.001..0.001 rows=1 loops=90)
                                      Index Cond: (id = va.id)
                                      Buffers: shared hit=360
                          ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=90)
                                Index Cond: (id = variants.version_id)
                                Buffers: shared hit=360
                    ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=90)
                          Index Cond: (id = versions.package_id)
                          Buffers: shared hit=360
              ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=90)
                    Index Cond: (id = variants.meta_id)
                    Buffers: shared hit=360
        ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=90)
              Index Cond: (seq = variants.commit_seq)
              Buffers: shared hit=270
Planning:
  Buffers: shared hit=116
Planning Time: 14.133 ms
Execution Time: 1.216 ms
```

### every version — name=hello

Parameters: `["hello"]` — Execution Time: 0.491 ms

```
Sort  (cost=1498.01..1498.33 rows=126 width=1389) (actual time=0.401..0.404 rows=19 loops=1)
  Sort Key: versions.sort_key DESC, versions.version, versions.id, variants.system, variants.attr_path
  Sort Method: quicksort  Memory: 56kB
  Buffers: shared hit=402
  ->  Nested Loop  (cost=212.27..1493.61 rows=126 width=1389) (actual time=0.107..0.354 rows=19 loops=1)
        Buffers: shared hit=402
        ->  Nested Loop  (cost=211.99..1456.12 rows=126 width=1334) (actual time=0.102..0.307 rows=19 loops=1)
              Buffers: shared hit=345
              ->  Nested Loop  (cost=211.57..1390.92 rows=126 width=351) (actual time=0.096..0.255 rows=19 loops=1)
                    Buffers: shared hit=269
                    ->  Nested Loop  (cost=211.15..1334.90 rows=126 width=328) (actual time=0.091..0.197 rows=19 loops=1)
                          Buffers: shared hit=193
                          ->  Nested Loop  (cost=210.72..1275.94 rows=126 width=299) (actual time=0.085..0.139 rows=19 loops=1)
                                Buffers: shared hit=117
                                ->  HashAggregate  (cost=210.29..211.55 rows=126 width=4) (actual time=0.079..0.085 rows=19 loops=1)
                                      Group Key: va.id
                                      Batches: 1  Memory Usage: 40kB
                                      Buffers: shared hit=41
                                      ->  Append  (cost=1.28..209.98 rows=126 width=4) (actual time=0.032..0.069 rows=38 loops=1)
                                            Buffers: shared hit=41
                                            ->  Nested Loop  (cost=1.28..86.07 rows=15 width=4) (actual time=0.032..0.055 rows=19 loops=1)
                                                  Buffers: shared hit=33
                                                  ->  Nested Loop  (cost=0.85..76.81 rows=6 width=4) (actual time=0.024..0.026 rows=5 loops=1)
                                                        Buffers: shared hit=8
                                                        ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.014 rows=1 loops=1)
                                                              Index Cond: (lower(name) = 'hello'::text)
                                                              Buffers: shared hit=4
                                                        ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..68.04 rows=33 width=8) (actual time=0.008..0.009 rows=5 loops=1)
                                                              Index Cond: (package_id = p.id)
                                                              Buffers: shared hit=4
                                                  ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.40 rows=14 width=8) (actual time=0.003..0.005 rows=4 loops=5)
                                                        Index Cond: (version_id = ve.id)
                                                        Buffers: shared hit=25
                                            ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..123.28 rows=111 width=4) (actual time=0.006..0.011 rows=19 loops=1)
                                                  Index Cond: (attr_path = 'hello'::text)
                                                  Buffers: shared hit=8
                                ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=303) (actual time=0.002..0.002 rows=1 loops=19)
                                      Index Cond: (id = va.id)
                                      Buffers: shared hit=76
                          ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.002..0.002 rows=1 loops=19)
                                Index Cond: (id = variants.version_id)
                                Buffers: shared hit=76
                    ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=19)
                          Index Cond: (id = versions.package_id)
                          Buffers: shared hit=76
              ->  Index Scan using meta_pkey on meta  (cost=0.42..0.52 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=19)
                    Index Cond: (id = variants.meta_id)
                    Buffers: shared hit=76
        ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=19)
              Index Cond: (seq = variants.commit_seq)
              Buffers: shared hit=57
Planning:
  Buffers: shared hit=116
Planning Time: 15.631 ms
Execution Time: 0.491 ms
```

