# Serving query plans

Recorded 2026-10-05 against `ep-purple-river-auzjl04j.c-10.us-east-1.aws.neon.tech` with `node tools/explain-plans.mjs`.
Regenerate after changing apps/web/lib/search.ts or the indexes, and diff.
Warm plans (second run); see the script for what each statement is.

Table sizes: packages=251469, versions=1477090, variants=3855709, search_terms=252059

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
- **System filter** (`?system=`) adds one check per package: `versions` by package_id,
  then `variants_identity_key (version_id, system)` until one hits. In each tier it is a
  `Nested Loop Semi Join` over the already *sorted* groups, stopped by the `Limit`, so it
  probes about 50 packages; a `Filter: EXISTS(SubPlan …)` on the `GroupAggregate`
  instead means the `OFFSET 0` fence was lost and every candidate is probed (437 for
  `go`). In the nearest-match arms it is a semi-join per scanned row under their `Limit`.

## Phrase search (/v2/search, /v1/search)

### ranked terms — q=go

Parameters: `["go","go"]` — Execution Time: 2.563 ms

```
Limit  (cost=1344.85..1344.97 rows=50 width=44) (actual time=1.677..1.691 rows=50 loops=1)
  Buffers: shared hit=53
  CTE breadth
    ->  Aggregate  (cost=18.08..18.09 rows=1 width=1) (actual time=0.267..0.268 rows=1 loops=1)
          Buffers: shared hit=28
          ->  Limit  (cost=0.42..17.77 rows=25 width=4) (actual time=0.033..0.238 rows=452 loops=1)
                Buffers: shared hit=28
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..17.77 rows=25 width=4) (actual time=0.032..0.202 rows=452 loops=1)
                      Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                      Filter: (lower(name) ~~ 'go%'::text)
                      Buffers: shared hit=28
  CTE prefix
    ->  Limit  (cost=377.65..377.78 rows=50 width=39) (actual time=1.581..1.593 rows=50 loops=1)
          Buffers: shared hit=53
          ->  Sort  (cost=377.65..377.85 rows=78 width=39) (actual time=1.580..1.589 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'go'::text) ELSE GREATEST(similarity(search_terms_3.name, 'go'::text), similarity(search_terms_3.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: top-N heapsort  Memory: 30kB
                Buffers: shared hit=53
                ->  GroupAggregate  (cost=370.13..375.20 rows=78 width=39) (actual time=0.644..1.501 rows=437 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Buffers: shared hit=53
                      ->  Sort  (cost=370.13..370.33 rows=78 width=68) (actual time=0.605..0.634 rows=452 loops=1)
                            Sort Key: search_terms_3.package_id, search_terms_3.name
                            Sort Method: quicksort  Memory: 51kB
                            Buffers: shared hit=53
                            ->  Append  (cost=9.66..367.68 rows=78 width=68) (actual time=0.320..0.525 rows=452 loops=1)
                                  Buffers: shared hit=53
                                  ->  Result  (cost=9.66..281.97 rows=50 width=68) (actual time=0.320..0.475 rows=452 loops=1)
                                        One-Time Filter: (NOT (InitPlan 2).col1)
                                        Buffers: shared hit=53
                                        InitPlan 2
                                          ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=0.268..0.269 rows=1 loops=1)
                                                Buffers: shared hit=28
                                        ->  Bitmap Heap Scan on search_terms search_terms_3  (cost=9.66..281.97 rows=50 width=68) (actual time=0.049..0.155 rows=452 loops=1)
                                              Recheck Cond: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                              Filter: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                              Heap Blocks: exact=15
                                              Buffers: shared hit=25
                                              ->  BitmapOr  (cost=9.64..9.64 rows=78 width=0) (actual time=0.041..0.042 rows=0 loops=1)
                                                    Buffers: shared hit=10
                                                    ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.81 rows=39 width=0) (actual time=0.021..0.021 rows=452 loops=1)
                                                          Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                                          Buffers: shared hit=5
                                                    ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.81 rows=39 width=0) (actual time=0.020..0.020 rows=452 loops=1)
                                                          Index Cond: ((lower(attr_path) >= 'go'::text) AND (lower(attr_path) < 'gp'::text))
                                                          Buffers: shared hit=5
                                  ->  Result  (cost=8.88..16.76 rows=2 width=68) (actual time=0.001..0.002 rows=0 loops=1)
                                        One-Time Filter: (InitPlan 3).col1
                                        InitPlan 3
                                          ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=68) (never executed)
                                              Recheck Cond: ((lower(name) = 'go'::text) OR (lower(attr_path) = 'go'::text))
                                              ->  BitmapOr  (cost=8.86..8.86 rows=2 width=0) (never executed)
                                                    ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                          Index Cond: (lower(name) = 'go'::text)
                                                    ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                          Index Cond: (lower(attr_path) = 'go'::text)
                                  ->  Result  (cost=29.61..33.63 rows=1 width=68) (actual time=0.001..0.002 rows=0 loops=1)
                                        One-Time Filter: (InitPlan 4).col1
                                        InitPlan 4
                                          ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Bitmap Heap Scan on search_terms search_terms_5  (cost=29.61..33.63 rows=1 width=68) (never executed)
                                              Recheck Cond: (((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text)) AND ((name = attr_path) IS FALSE))
                                              Filter: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                              ->  BitmapAnd  (cost=29.59..29.59 rows=1 width=0) (never executed)
                                                    ->  BitmapOr  (cost=9.62..9.62 rows=78 width=0) (never executed)
                                                          ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.81 rows=39 width=0) (never executed)
                                                                Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                                          ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.81 rows=39 width=0) (never executed)
                                                                Index Cond: ((lower(attr_path) >= 'go'::text) AND (lower(attr_path) < 'gp'::text))
                                                    ->  Bitmap Index Scan on search_terms_alias_idx  (cost=0.00..19.71 rows=688 width=0) (never executed)
                                  ->  Subquery Scan on "*SELECT* 4"  (cost=16.13..16.17 rows=3 width=68) (actual time=0.005..0.006 rows=0 loops=1)
                                        ->  Limit  (cost=16.13..16.14 rows=3 width=72) (actual time=0.005..0.006 rows=0 loops=1)
                                              InitPlan 5
                                                ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                              ->  Sort  (cost=16.11..16.12 rows=3 width=72) (actual time=0.004..0.005 rows=0 loops=1)
                                                    Sort Key: ((lower(search_terms_6.name) <-> 'go'::text)), search_terms_6.name
                                                    Sort Method: quicksort  Memory: 25kB
                                                    ->  Result  (cost=4.31..16.09 rows=3 width=72) (actual time=0.001..0.001 rows=0 loops=1)
                                                          One-Time Filter: (InitPlan 5).col1
                                                          ->  Bitmap Heap Scan on search_terms search_terms_6  (cost=4.31..16.07 rows=3 width=68) (never executed)
                                                                Recheck Cond: ((lower(name) ~~ 'go%'::text) AND ((name = attr_path) IS TRUE) AND (top_level_attr IS NOT NULL))
                                                                ->  Bitmap Index Scan on search_terms_top_level_name_knn_idx  (cost=0.00..4.31 rows=3 width=0) (never executed)
                                                                      Index Cond: (lower(name) ~~ 'go%'::text)
                                  ->  Subquery Scan on "*SELECT* 5"  (cost=18.48..18.76 rows=22 width=68) (actual time=0.003..0.004 rows=0 loops=1)
                                        ->  Limit  (cost=18.48..18.54 rows=22 width=72) (actual time=0.003..0.003 rows=0 loops=1)
                                              InitPlan 6
                                                ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                              ->  Sort  (cost=18.46..18.52 rows=22 width=72) (actual time=0.003..0.003 rows=0 loops=1)
                                                    Sort Key: ((lower(search_terms_7.name) <-> 'go'::text)), search_terms_7.name
                                                    Sort Method: quicksort  Memory: 25kB
                                                    ->  Result  (cost=0.42..17.97 rows=22 width=72) (actual time=0.001..0.001 rows=0 loops=1)
                                                          One-Time Filter: (InitPlan 6).col1
                                                          ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_7  (cost=0.42..17.86 rows=22 width=68) (never executed)
                                                                Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                                                Filter: ((top_level_attr IS NULL) AND ((name = attr_path) IS TRUE) AND (lower(name) ~~ 'go%'::text))
  ->  Sort  (cost=948.98..949.23 rows=100 width=44) (actual time=1.676..1.680 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=53
        ->  GroupAggregate  (cost=943.66..945.66 rows=100 width=44) (actual time=1.635..1.656 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=53
              ->  Sort  (cost=943.66..943.91 rows=100 width=42) (actual time=1.633..1.636 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=53
                    ->  Append  (cost=0.00..940.33 rows=100 width=42) (actual time=1.583..1.621 rows=50 loops=1)
                          Buffers: shared hit=53
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=1.582..1.598 rows=50 loops=1)
                                Buffers: shared hit=53
                          ->  Subquery Scan on fuzzy  (cost=938.21..938.83 rows=50 width=39) (actual time=0.017..0.018 rows=0 loops=1)
                                ->  Limit  (cost=938.21..938.33 rows=50 width=39) (actual time=0.017..0.018 rows=0 loops=1)
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.008..0.008 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.003 rows=50 loops=1)
                                      ->  Sort  (cost=937.07..937.20 rows=50 width=39) (actual time=0.016..0.017 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'go'::text) ELSE GREATEST(similarity(search_terms.name, 'go'::text), similarity(search_terms.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            ->  GroupAggregate  (cost=932.41..935.66 rows=50 width=39) (actual time=0.014..0.015 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  ->  Sort  (cost=932.41..932.54 rows=50 width=68) (actual time=0.014..0.014 rows=0 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        ->  Result  (cost=749.24..931.00 rows=50 width=68) (actual time=0.009..0.009 rows=0 loops=1)
                                                              One-Time Filter: ((InitPlan 8).col1 < 50)
                                                              ->  Bitmap Heap Scan on search_terms  (cost=749.24..931.00 rows=50 width=68) (never executed)
                                                                    Recheck Cond: ((name % 'go'::text) OR (attr_path % 'go'::text))
                                                                    Filter: ((lower(name) !~~ 'go%'::text) AND (lower(attr_path) !~~ 'go%'::text))
                                                                    ->  BitmapOr  (cost=749.24..749.24 rows=50 width=0) (never executed)
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..374.61 rows=25 width=0) (never executed)
                                                                                Index Cond: (name % 'go'::text)
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..374.61 rows=25 width=0) (never executed)
                                                                                Index Cond: (attr_path % 'go'::text)
Planning:
  Buffers: shared hit=4
Planning Time: 1.718 ms
Execution Time: 2.563 ms
```

### batched fetch, latest — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 13.862 ms

```
Limit  (cost=4373.99..110956.88 rows=50 width=1376) (actual time=4.821..13.755 rows=50 loops=1)
  Buffers: shared hit=23154
  ->  Unique  (cost=4373.99..110956.88 rows=50 width=1376) (actual time=4.820..13.749 rows=50 loops=1)
        Buffers: shared hit=23154
        ->  Incremental Sort  (cost=4373.99..110955.16 rows=690 width=1376) (actual time=4.819..13.709 rows=172 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 6  Sort Method: quicksort  Average Memory: 55kB  Peak Memory: 55kB
              Buffers: shared hit=23154
              ->  Nested Loop  (cost=2199.06..110932.47 rows=690 width=1376) (actual time=3.461..13.394 rows=175 loops=1)
                    Buffers: shared hit=23154
                    ->  Nested Loop  (cost=2198.78..110727.16 rows=690 width=1321) (actual time=3.455..13.135 rows=175 loops=1)
                          Buffers: shared hit=22629
                          ->  Nested Loop  (cost=2198.36..110375.62 rows=690 width=338) (actual time=3.448..12.763 rows=175 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                Buffers: shared hit=21929
                                ->  Nested Loop  (cost=2197.93..110300.02 rows=50 width=53) (actual time=3.444..12.554 rows=50 loops=1)
                                      Buffers: shared hit=21591
                                      ->  Nested Loop  (cost=2197.51..110277.78 rows=50 width=30) (actual time=3.438..12.441 rows=50 loops=1)
                                            Buffers: shared hit=21391
                                            ->  Nested Loop  (cost=2197.08..109855.53 rows=50 width=12) (actual time=3.431..12.287 rows=50 loops=1)
                                                  Buffers: shared hit=21191
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.007..0.014 rows=50 loops=1)
                                                  ->  Limit  (cost=2197.08..2197.08 rows=1 width=24) (actual time=0.245..0.245 rows=1 loops=50)
                                                        Buffers: shared hit=21191
                                                        ->  Sort  (cost=2197.08..2197.29 rows=84 width=24) (actual time=0.245..0.245 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=21191
                                                              ->  Nested Loop  (cost=0.86..2196.66 rows=84 width=24) (actual time=0.012..0.234 rows=45 loops=50)
                                                                    Buffers: shared hit=21191
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.003..0.007 rows=12 loops=50)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Rows Removed by Filter: 0
                                                                          Buffers: shared hit=244
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..36.36 rows=14 width=8) (actual time=0.002..0.003 rows=4 loops=618)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=2782
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.36 rows=14 width=0) (actual time=0.002..0.002 rows=1 loops=2247)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=9016
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=2247)
                                                                            Buffers: shared hit=9121
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=2247)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=9121
                                            ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Index Cond: (id = versions_1.id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=200
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.34 rows=14 width=297) (actual time=0.001..0.003 rows=4 loops=50)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=338
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=175)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=700
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=175)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=525
Planning:
  Buffers: shared hit=115
Planning Time: 13.525 ms
Execution Time: 13.862 ms
```

### batched fetch, all versions — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 12.550 ms

```
Limit  (cost=118.21..1490.17 rows=1000 width=1391) (actual time=3.512..12.358 rows=638 loops=1)
  Buffers: shared hit=13321
  ->  Unique  (cost=118.21..5898.28 rows=4213 width=1391) (actual time=3.510..12.305 rows=638 loops=1)
        Buffers: shared hit=13321
        ->  Incremental Sort  (cost=118.21..5866.69 rows=4213 width=1391) (actual time=3.510..11.770 rows=2322 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 21  Sort Method: quicksort  Average Memory: 70kB  Peak Memory: 75kB
              Pre-sorted Groups: 26  Sort Method: quicksort  Average Memory: 566kB  Peak Memory: 566kB
              Buffers: shared hit=13321
              ->  Nested Loop  (cost=1.99..5678.28 rows=4213 width=1391) (actual time=0.052..8.292 rows=2322 loops=1)
                    Buffers: shared hit=13321
                    ->  Nested Loop  (cost=1.70..5030.68 rows=4213 width=1336) (actual time=0.044..6.903 rows=2322 loops=1)
                          Buffers: shared hit=12610
                          ->  Nested Loop  (cost=1.28..2884.20 rows=4213 width=353) (actual time=0.038..3.246 rows=2322 loops=1)
                                Buffers: shared hit=3322
                                ->  Nested Loop  (cost=0.85..506.22 rows=1610 width=64) (actual time=0.031..0.578 rows=638 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=445
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.020..0.130 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.015 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.36 rows=32 width=33) (actual time=0.003..0.007 rows=13 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=245
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.34 rows=14 width=297) (actual time=0.002..0.003 rows=4 loops=638)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=2877
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=2322)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=9288
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=2322)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 2085  Misses: 237  Evictions: 0  Overflows: 0  Memory Usage: 38kB
                          Buffers: shared hit=711
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=237)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=711
Planning:
  Buffers: shared hit=69
Planning Time: 8.400 ms
Execution Time: 12.550 ms
```

### ranked terms — q=python

Parameters: `["python","python"]` — Execution Time: 35.860 ms

```
Limit  (cost=20846.85..20846.97 rows=50 width=44) (actual time=35.643..35.664 rows=50 loops=1)
  Buffers: shared hit=3673
  CTE breadth
    ->  Aggregate  (cost=790.14..790.15 rows=1 width=1) (actual time=5.264..5.265 rows=1 loops=1)
          Buffers: shared hit=396
          ->  Limit  (cost=0.42..665.14 rows=10000 width=4) (actual time=0.022..4.680 rows=10000 loops=1)
                Buffers: shared hit=396
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..4729.23 rows=71140 width=4) (actual time=0.021..3.896 rows=10000 loops=1)
                      Index Cond: ((lower(name) >= 'python'::text) AND (lower(name) < 'pythoo'::text))
                      Filter: (lower(name) ~~ 'python%'::text)
                      Buffers: shared hit=396
  CTE prefix
    ->  Limit  (cost=15735.01..15735.14 rows=50 width=39) (actual time=35.537..35.554 rows=50 loops=1)
          Buffers: shared hit=3673
          ->  Sort  (cost=15735.01..15765.67 rows=12262 width=39) (actual time=35.537..35.549 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'python'::text) ELSE GREATEST(similarity(search_terms_3.name, 'python'::text), similarity(search_terms_3.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: top-N heapsort  Memory: 30kB
                Buffers: shared hit=3673
                ->  HashAggregate  (cost=15205.06..15327.68 rows=12262 width=39) (actual time=35.412..35.495 rows=202 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Batches: 1  Memory Usage: 433kB
                      Buffers: shared hit=3673
                      ->  Append  (cost=0.02..8767.56 rows=122619 width=68) (actual time=5.290..34.524 rows=244 loops=1)
                            Buffers: shared hit=3673
                            ->  Result  (cost=0.02..7993.30 rows=122183 width=68) (actual time=5.268..5.270 rows=0 loops=1)
                                  One-Time Filter: (NOT (InitPlan 2).col1)
                                  Buffers: shared hit=396
                                  InitPlan 2
                                    ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=5.265..5.266 rows=1 loops=1)
                                          Buffers: shared hit=396
                                  ->  Seq Scan on search_terms search_terms_3  (cost=0.02..7993.30 rows=122183 width=68) (never executed)
                                        Filter: ((lower(name) ~~ 'python%'::text) OR (lower(attr_path) ~~ 'python%'::text))
                            ->  Result  (cost=8.88..16.76 rows=2 width=68) (actual time=0.021..0.027 rows=15 loops=1)
                                  One-Time Filter: (InitPlan 3).col1
                                  Buffers: shared hit=7
                                  InitPlan 3
                                    ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=68) (actual time=0.019..0.021 rows=15 loops=1)
                                        Recheck Cond: ((lower(name) = 'python'::text) OR (lower(attr_path) = 'python'::text))
                                        Heap Blocks: exact=1
                                        Buffers: shared hit=7
                                        ->  BitmapOr  (cost=8.86..8.86 rows=2 width=0) (actual time=0.013..0.014 rows=0 loops=1)
                                              Buffers: shared hit=6
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.008..0.008 rows=15 loops=1)
                                                    Index Cond: (lower(name) = 'python'::text)
                                                    Buffers: shared hit=3
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.005..0.005 rows=1 loops=1)
                                                    Index Cond: (lower(attr_path) = 'python'::text)
                                                    Buffers: shared hit=3
                            ->  Result  (cost=0.30..49.58 rows=334 width=68) (actual time=0.259..0.403 rows=166 loops=1)
                                  One-Time Filter: (InitPlan 4).col1
                                  Buffers: shared hit=156
                                  InitPlan 4
                                    ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                  ->  Index Scan using search_terms_alias_idx on search_terms search_terms_5  (cost=0.30..49.58 rows=334 width=68) (actual time=0.257..0.382 rows=166 loops=1)
                                        Filter: ((lower(name) ~~ 'python%'::text) OR (lower(attr_path) ~~ 'python%'::text))
                                        Rows Removed by Filter: 429
                                        Buffers: shared hit=156
                            ->  Subquery Scan on "*SELECT* 4"  (cost=1.76..77.01 rows=50 width=68) (actual time=0.967..0.972 rows=13 loops=1)
                                  Buffers: shared hit=195
                                  ->  Limit  (cost=1.76..76.51 rows=50 width=72) (actual time=0.965..0.969 rows=13 loops=1)
                                        Buffers: shared hit=195
                                        InitPlan 5
                                          ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=1.74..12782.67 rows=8549 width=72) (actual time=0.965..0.966 rows=13 loops=1)
                                              Sort Key: ((lower(search_terms_6.name) <-> 'python'::text)), search_terms_6.name
                                              Presorted Key: ((lower(search_terms_6.name) <-> 'python'::text))
                                              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                              Buffers: shared hit=195
                                              ->  Result  (cost=0.28..12398.00 rows=8549 width=72) (actual time=0.335..0.951 rows=13 loops=1)
                                                    One-Time Filter: (InitPlan 5).col1
                                                    Buffers: shared hit=195
                                                    ->  Index Scan using search_terms_top_level_name_knn_idx on search_terms search_terms_6  (cost=0.28..12355.26 rows=8549 width=68) (actual time=0.331..0.923 rows=13 loops=1)
                                                          Index Cond: (lower(name) ~~ 'python%'::text)
                                                          Rows Removed by Index Recheck: 13
                                                          Order By: (lower(name) <-> 'python'::text)
                                                          Buffers: shared hit=195
                            ->  Subquery Scan on "*SELECT* 5"  (cost=0.60..17.82 rows=50 width=68) (actual time=27.218..27.827 rows=50 loops=1)
                                  Buffers: shared hit=2919
                                  ->  Limit  (cost=0.60..17.32 rows=50 width=72) (actual time=27.217..27.818 rows=50 loops=1)
                                        Buffers: shared hit=2919
                                        InitPlan 6
                                          ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=0.58..20857.38 rows=62396 width=72) (actual time=27.215..27.812 rows=50 loops=1)
                                              Sort Key: ((lower(search_terms_7.name) <-> 'python'::text)), search_terms_7.name
                                              Presorted Key: ((lower(search_terms_7.name) <-> 'python'::text))
                                              Full-sort Groups: 2  Sort Methods: top-N heapsort, quicksort  Average Memory: 29kB  Peak Memory: 29kB
                                              Pre-sorted Groups: 1  Sort Method: top-N heapsort  Average Memory: 27kB  Peak Memory: 27kB
                                              Buffers: shared hit=2919
                                              ->  Result  (cost=0.28..18052.18 rows=62396 width=72) (actual time=27.026..27.737 rows=170 loops=1)
                                                    One-Time Filter: (InitPlan 6).col1
                                                    Buffers: shared hit=2919
                                                    ->  Index Scan using search_terms_nested_name_knn_idx on search_terms search_terms_7  (cost=0.28..17740.20 rows=62396 width=68) (actual time=27.011..27.364 rows=170 loops=1)
                                                          Index Cond: (lower(name) ~~ 'python%'::text)
                                                          Rows Removed by Index Recheck: 12
                                                          Order By: (lower(name) <-> 'python'::text)
                                                          Buffers: shared hit=2919
  ->  Sort  (cost=4321.56..4321.81 rows=100 width=44) (actual time=35.642..35.647 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=3673
        ->  GroupAggregate  (cost=4316.24..4318.24 rows=100 width=44) (actual time=35.606..35.628 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=3673
              ->  Sort  (cost=4316.24..4316.49 rows=100 width=42) (actual time=35.602..35.607 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=3673
                    ->  Append  (cost=0.00..4312.92 rows=100 width=42) (actual time=35.541..35.591 rows=50 loops=1)
                          Buffers: shared hit=3673
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=35.540..35.554 rows=50 loops=1)
                                Buffers: shared hit=3673
                          ->  Subquery Scan on fuzzy  (cost=4310.79..4311.42 rows=50 width=39) (actual time=0.029..0.031 rows=0 loops=1)
                                ->  Limit  (cost=4310.79..4310.92 rows=50 width=39) (actual time=0.029..0.030 rows=0 loops=1)
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.009..0.009 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.004 rows=50 loops=1)
                                      ->  Sort  (cost=4309.66..4316.16 rows=2601 width=39) (actual time=0.028..0.029 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'python'::text) ELSE GREATEST(similarity(search_terms.name, 'python'::text), similarity(search_terms.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            ->  HashAggregate  (cost=4197.24..4223.25 rows=2601 width=39) (actual time=0.022..0.023 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Batches: 1  Memory Usage: 121kB
                                                  ->  Result  (cost=879.30..4060.69 rows=2601 width=68) (actual time=0.011..0.012 rows=0 loops=1)
                                                        One-Time Filter: ((InitPlan 8).col1 < 50)
                                                        ->  Bitmap Heap Scan on search_terms  (cost=879.30..4060.69 rows=2601 width=68) (never executed)
                                                              Recheck Cond: ((name % 'python'::text) OR (attr_path % 'python'::text))
                                                              Filter: ((lower(name) !~~ 'python%'::text) AND (lower(attr_path) !~~ 'python%'::text))
                                                              ->  BitmapOr  (cost=879.30..879.30 rows=5082 width=0) (never executed)
                                                                    ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..439.00 rows=2541 width=0) (never executed)
                                                                          Index Cond: (name % 'python'::text)
                                                                    ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..439.00 rows=2542 width=0) (never executed)
                                                                          Index Cond: (attr_path % 'python'::text)
Planning:
  Buffers: shared hit=4
Planning Time: 1.326 ms
Execution Time: 35.860 ms
```

### batched fetch, latest — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 11.412 ms

```
Limit  (cost=4373.99..110956.88 rows=50 width=1376) (actual time=6.646..11.302 rows=49 loops=1)
  Buffers: shared hit=17766
  ->  Unique  (cost=4373.99..110956.88 rows=50 width=1376) (actual time=6.645..11.297 rows=49 loops=1)
        Buffers: shared hit=17766
        ->  Incremental Sort  (cost=4373.99..110955.16 rows=690 width=1376) (actual time=6.644..11.262 rows=127 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 4  Sort Method: quicksort  Average Memory: 69kB  Peak Memory: 69kB
              Buffers: shared hit=17766
              ->  Nested Loop  (cost=2199.06..110932.47 rows=690 width=1376) (actual time=2.458..11.138 rows=127 loops=1)
                    Buffers: shared hit=17766
                    ->  Nested Loop  (cost=2198.78..110727.16 rows=690 width=1321) (actual time=2.452..10.873 rows=127 loops=1)
                          Buffers: shared hit=17385
                          ->  Nested Loop  (cost=2198.36..110375.62 rows=690 width=338) (actual time=2.444..10.509 rows=127 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                Buffers: shared hit=16877
                                ->  Nested Loop  (cost=2197.93..110300.02 rows=50 width=53) (actual time=2.440..10.318 rows=49 loops=1)
                                      Buffers: shared hit=16650
                                      ->  Nested Loop  (cost=2197.51..110277.78 rows=50 width=30) (actual time=2.433..10.142 rows=49 loops=1)
                                            Buffers: shared hit=16454
                                            ->  Nested Loop  (cost=2197.08..109855.53 rows=50 width=12) (actual time=2.427..9.978 rows=49 loops=1)
                                                  Buffers: shared hit=16258
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.016 rows=50 loops=1)
                                                  ->  Limit  (cost=2197.08..2197.08 rows=1 width=24) (actual time=0.199..0.199 rows=1 loops=50)
                                                        Buffers: shared hit=16258
                                                        ->  Sort  (cost=2197.08..2197.29 rows=84 width=24) (actual time=0.198..0.198 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=16258
                                                              ->  Nested Loop  (cost=0.86..2196.66 rows=84 width=24) (actual time=0.014..0.189 rows=35 loops=50)
                                                                    Buffers: shared hit=16258
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.004..0.011 rows=10 loops=50)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Rows Removed by Filter: 2
                                                                          Buffers: shared hit=233
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..36.36 rows=14 width=8) (actual time=0.002..0.003 rows=3 loops=514)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=2165
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.36 rows=14 width=0) (actual time=0.001..0.001 rows=1 loops=1727)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=6914
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=1727)
                                                                            Buffers: shared hit=6940
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=1727)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=6940
                                            ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=49)
                                                  Index Cond: (id = versions_1.id)
                                                  Buffers: shared hit=196
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=49)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=196
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.34 rows=14 width=297) (actual time=0.002..0.003 rows=3 loops=49)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=227
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=127)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=508
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=127)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=381
Planning:
  Buffers: shared hit=115
Planning Time: 14.594 ms
Execution Time: 11.412 ms
```

### batched fetch, all versions — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 12.867 ms

```
Limit  (cost=118.21..1490.17 rows=1000 width=1391) (actual time=3.871..12.666 rows=637 loops=1)
  Buffers: shared hit=12290
  ->  Unique  (cost=118.21..5898.28 rows=4213 width=1391) (actual time=3.869..12.612 rows=637 loops=1)
        Buffers: shared hit=12290
        ->  Incremental Sort  (cost=118.21..5866.69 rows=4213 width=1391) (actual time=3.868..12.061 rows=2170 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 19  Sort Method: quicksort  Average Memory: 126kB  Peak Memory: 126kB
              Pre-sorted Groups: 13  Sort Method: quicksort  Average Memory: 890kB  Peak Memory: 890kB
              Buffers: shared hit=12290
              ->  Nested Loop  (cost=1.99..5678.28 rows=4213 width=1391) (actual time=0.123..8.675 rows=2170 loops=1)
                    Buffers: shared hit=12290
                    ->  Nested Loop  (cost=1.70..5030.68 rows=4213 width=1336) (actual time=0.110..7.399 rows=2170 loops=1)
                          Buffers: shared hit=11777
                          ->  Nested Loop  (cost=1.28..2884.20 rows=4213 width=353) (actual time=0.042..3.743 rows=2170 loops=1)
                                Buffers: shared hit=3097
                                ->  Nested Loop  (cost=0.85..506.22 rows=1610 width=64) (actual time=0.035..0.814 rows=637 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=422
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.022..0.197 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.016 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.36 rows=32 width=33) (actual time=0.004..0.007 rows=13 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=222
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.34 rows=14 width=297) (actual time=0.002..0.003 rows=3 loops=637)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=2675
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=2170)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=8680
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=2170)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 1999  Misses: 171  Evictions: 0  Overflows: 0  Memory Usage: 27kB
                          Buffers: shared hit=513
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=171)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=513
Planning:
  Buffers: shared hit=69
Planning Time: 6.004 ms
Execution Time: 12.867 ms
```

### ranked terms — q=python313Packages.

Parameters: `["python313Packages.","python313Packages."]` — Execution Time: 26.278 ms

```
Limit  (cost=38890.58..38890.70 rows=50 width=44) (actual time=23.810..26.085 rows=50 loops=1)
  Buffers: shared hit=2836
  CTE breadth
    ->  Aggregate  (cost=1116.45..1116.46 rows=1 width=1) (actual time=5.623..5.625 rows=1 loops=1)
          Buffers: shared hit=513
          ->  Limit  (cost=0.42..991.45 rows=10000 width=4) (actual time=0.018..5.030 rows=10000 loops=1)
                Buffers: shared hit=513
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..1259.43 rows=12704 width=4) (actual time=0.017..4.238 rows=10000 loops=1)
                      Index Cond: ((lower(name) >= 'python313packages.'::text) AND (lower(name) < 'python313packages/'::text))
                      Filter: (lower(name) ~~ 'python313packages.%'::text)
                      Buffers: shared hit=513
  CTE prefix
    ->  Limit  (cost=5897.11..5897.23 rows=50 width=39) (actual time=18.621..18.642 rows=50 loops=1)
          Buffers: shared hit=2792
          ->  Sort  (cost=5897.11..5903.34 rows=2494 width=39) (actual time=18.621..18.637 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'python313packages.'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'python313packages.'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'python313packages.%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'python313packages.%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'python313Packages.'::text) ELSE GREATEST(similarity(search_terms_3.name, 'python313Packages.'::text), similarity(search_terms_3.attr_path, 'python313Packages.'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: quicksort  Memory: 28kB
                Buffers: shared hit=2792
                ->  HashAggregate  (cost=5789.32..5814.26 rows=2494 width=39) (actual time=18.587..18.617 rows=50 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Batches: 1  Memory Usage: 121kB
                      Buffers: shared hit=2792
                      ->  Append  (cost=694.50..4479.97 rows=24940 width=68) (actual time=18.426..18.457 rows=50 loops=1)
                            Buffers: shared hit=2792
                            ->  Result  (cost=694.50..4058.03 rows=24770 width=68) (actual time=5.627..5.629 rows=0 loops=1)
                                  One-Time Filter: (NOT (InitPlan 2).col1)
                                  Buffers: shared hit=513
                                  InitPlan 2
                                    ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=5.624..5.625 rows=1 loops=1)
                                          Buffers: shared hit=513
                                  ->  Bitmap Heap Scan on search_terms search_terms_3  (cost=694.50..4058.03 rows=24770 width=68) (never executed)
                                        Recheck Cond: ((lower(name) ~~ 'python313packages.%'::text) OR (lower(attr_path) ~~ 'python313packages.%'::text))
                                        Filter: ((lower(name) ~~ 'python313packages.%'::text) OR (lower(attr_path) ~~ 'python313packages.%'::text))
                                        ->  BitmapOr  (cost=694.49..694.49 rows=20126 width=0) (never executed)
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..341.03 rows=10061 width=0) (never executed)
                                                    Index Cond: ((lower(name) >= 'python313packages.'::text) AND (lower(name) < 'python313packages/'::text))
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..341.07 rows=10065 width=0) (never executed)
                                                    Index Cond: ((lower(attr_path) >= 'python313packages.'::text) AND (lower(attr_path) < 'python313packages/'::text))
                            ->  Result  (cost=8.88..16.76 rows=2 width=68) (actual time=0.018..0.020 rows=0 loops=1)
                                  One-Time Filter: (InitPlan 3).col1
                                  Buffers: shared hit=6
                                  InitPlan 3
                                    ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=68) (actual time=0.016..0.017 rows=0 loops=1)
                                        Recheck Cond: ((lower(name) = 'python313packages.'::text) OR (lower(attr_path) = 'python313packages.'::text))
                                        Buffers: shared hit=6
                                        ->  BitmapOr  (cost=8.86..8.86 rows=2 width=0) (actual time=0.012..0.013 rows=0 loops=1)
                                              Buffers: shared hit=6
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.006..0.006 rows=0 loops=1)
                                                    Index Cond: (lower(name) = 'python313packages.'::text)
                                                    Buffers: shared hit=3
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.005..0.005 rows=0 loops=1)
                                                    Index Cond: (lower(attr_path) = 'python313packages.'::text)
                                                    Buffers: shared hit=3
                            ->  Result  (cost=0.30..49.58 rows=68 width=68) (actual time=0.385..0.386 rows=0 loops=1)
                                  One-Time Filter: (InitPlan 4).col1
                                  Buffers: shared hit=156
                                  InitPlan 4
                                    ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Index Scan using search_terms_alias_idx on search_terms search_terms_5  (cost=0.30..49.58 rows=68 width=68) (actual time=0.383..0.383 rows=0 loops=1)
                                        Filter: ((lower(name) ~~ 'python313packages.%'::text) OR (lower(attr_path) ~~ 'python313packages.%'::text))
                                        Rows Removed by Filter: 595
                                        Buffers: shared hit=156
                            ->  Subquery Scan on "*SELECT* 4"  (cost=3.55..168.55 rows=50 width=68) (actual time=0.362..0.365 rows=0 loops=1)
                                  Buffers: shared hit=46
                                  ->  Limit  (cost=3.55..168.05 rows=50 width=72) (actual time=0.361..0.363 rows=0 loops=1)
                                        Buffers: shared hit=46
                                        InitPlan 5
                                          ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.001..0.001 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=3.53..5027.17 rows=1527 width=72) (actual time=0.360..0.361 rows=0 loops=1)
                                              Sort Key: ((lower(search_terms_6.name) <-> 'python313packages.'::text)), search_terms_6.name
                                              Presorted Key: ((lower(search_terms_6.name) <-> 'python313packages.'::text))
                                              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                              Buffers: shared hit=46
                                              ->  Result  (cost=0.28..4958.45 rows=1527 width=72) (actual time=0.299..0.300 rows=0 loops=1)
                                                    One-Time Filter: (InitPlan 5).col1
                                                    Buffers: shared hit=46
                                                    ->  Index Scan using search_terms_top_level_name_knn_idx on search_terms search_terms_6  (cost=0.28..4950.82 rows=1527 width=68) (actual time=0.296..0.297 rows=0 loops=1)
                                                          Index Cond: (lower(name) ~~ 'python313packages.%'::text)
                                                          Order By: (lower(name) <-> 'python313packages.'::text)
                                                          Buffers: shared hit=46
                            ->  Subquery Scan on "*SELECT* 5"  (cost=1.48..62.35 rows=50 width=68) (actual time=12.030..12.046 rows=50 loops=1)
                                  Buffers: shared hit=2071
                                  ->  Limit  (cost=1.48..61.85 rows=50 width=72) (actual time=12.028..12.037 rows=50 loops=1)
                                        Buffers: shared hit=2071
                                        InitPlan 6
                                          ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=1.46..13456.15 rows=11142 width=72) (actual time=12.027..12.030 rows=50 loops=1)
                                              Sort Key: ((lower(search_terms_7.name) <-> 'python313packages.'::text)), search_terms_7.name
                                              Presorted Key: ((lower(search_terms_7.name) <-> 'python313packages.'::text))
                                              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 32kB  Peak Memory: 32kB
                                              Buffers: shared hit=2071
                                              ->  Result  (cost=0.28..12954.83 rows=11142 width=72) (actual time=11.755..11.992 rows=60 loops=1)
                                                    One-Time Filter: (InitPlan 6).col1
                                                    Buffers: shared hit=2071
                                                    ->  Index Scan using search_terms_nested_name_knn_idx on search_terms search_terms_7  (cost=0.28..12899.12 rows=11142 width=68) (actual time=11.740..11.843 rows=60 loops=1)
                                                          Index Cond: (lower(name) ~~ 'python313packages.%'::text)
                                                          Order By: (lower(name) <-> 'python313packages.'::text)
                                                          Buffers: shared hit=2071
  ->  Sort  (cost=31876.88..31877.13 rows=100 width=44) (actual time=23.808..26.061 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=2836
        ->  GroupAggregate  (cost=31871.56..31873.56 rows=100 width=44) (actual time=23.770..26.040 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=2836
              ->  Sort  (cost=31871.56..31871.81 rows=100 width=42) (actual time=23.762..26.014 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=2836
                    ->  Append  (cost=0.00..31868.23 rows=100 width=42) (actual time=18.624..26.000 rows=50 loops=1)
                          Buffers: shared hit=2836
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=18.623..18.638 rows=50 loops=1)
                                Buffers: shared hit=2792
                          ->  Subquery Scan on fuzzy  (cost=31866.11..31866.73 rows=50 width=39) (actual time=5.108..7.356 rows=0 loops=1)
                                Buffers: shared hit=44
                                ->  Limit  (cost=31866.11..31866.23 rows=50 width=39) (actual time=5.107..7.354 rows=0 loops=1)
                                      Buffers: shared hit=44
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.008..0.009 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.004 rows=50 loops=1)
                                      ->  Sort  (cost=31864.97..32135.64 rows=108266 width=39) (actual time=5.105..7.352 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'python313packages.'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'python313packages.'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'python313packages.%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'python313packages.%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'python313Packages.'::text) ELSE GREATEST(similarity(search_terms.name, 'python313Packages.'::text), similarity(search_terms.attr_path, 'python313Packages.'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            Buffers: shared hit=44
                                            ->  Finalize GroupAggregate  (cost=15377.06..28268.46 rows=108266 width=39) (actual time=5.098..7.344 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Buffers: shared hit=44
                                                  ->  Gather Merge  (cost=15377.06..26707.06 rows=63831 width=39) (actual time=5.097..7.342 rows=0 loops=1)
                                                        Workers Planned: 1
                                                        Workers Launched: 1
                                                        Buffers: shared hit=44
                                                        ->  Partial GroupAggregate  (cost=14377.05..18526.07 rows=63831 width=39) (actual time=0.063..0.063 rows=0 loops=2)
                                                              Group Key: search_terms.package_id, search_terms.name
                                                              Buffers: shared hit=44
                                                              ->  Sort  (cost=14377.05..14536.63 rows=63831 width=68) (actual time=0.062..0.062 rows=0 loops=2)
                                                                    Sort Key: search_terms.package_id, search_terms.name
                                                                    Sort Method: quicksort  Memory: 25kB
                                                                    Buffers: shared hit=44
                                                                    Worker 0:  Sort Method: quicksort  Memory: 25kB
                                                                    ->  Result  (cost=0.00..6661.21 rows=63831 width=68) (actual time=0.002..0.002 rows=0 loops=2)
                                                                          One-Time Filter: ((InitPlan 8).col1 < 50)
                                                                          ->  Parallel Seq Scan on search_terms  (cost=0.00..6661.21 rows=63831 width=68) (never executed)
                                                                                Filter: (((name % 'python313Packages.'::text) OR (attr_path % 'python313Packages.'::text)) AND (lower(name) !~~ 'python313packages.%'::text) AND (lower(attr_path) !~~ 'python313packages.%'::text))
Planning:
  Buffers: shared hit=4
Planning Time: 1.790 ms
Execution Time: 26.278 ms
```

### batched fetch, latest — q=python313Packages. (50 hits)

Parameters: `["150986,152209,150834,152035,152503,152537,152607,144825,145013,147350,147764,147765,147997,148046,148297,148334,150150,150536,150586,150612,150629,150655,150684,150771,150780,150816,150824,150979,151062,151063,151070,151177,151212,151252,151267,151284,151298,151520,151586,151651,151873,272730,152489,152502,152504,152533,152553,152573,152630,152993"]` — Execution Time: 6.007 ms

```
Limit  (cost=4373.99..110956.88 rows=50 width=1376) (actual time=1.387..5.895 rows=50 loops=1)
  Buffers: shared hit=8779
  ->  Unique  (cost=4373.99..110956.88 rows=50 width=1376) (actual time=1.385..5.889 rows=50 loops=1)
        Buffers: shared hit=8779
        ->  Incremental Sort  (cost=4373.99..110955.16 rows=690 width=1376) (actual time=1.385..5.850 rows=180 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 6  Sort Method: quicksort  Average Memory: 62kB  Peak Memory: 62kB
              Buffers: shared hit=8779
              ->  Nested Loop  (cost=2199.06..110932.47 rows=690 width=1376) (actual time=0.127..5.689 rows=182 loops=1)
                    Buffers: shared hit=8779
                    ->  Nested Loop  (cost=2198.78..110727.16 rows=690 width=1321) (actual time=0.121..5.432 rows=182 loops=1)
                          Buffers: shared hit=8233
                          ->  Nested Loop  (cost=2198.36..110375.62 rows=690 width=338) (actual time=0.115..5.011 rows=182 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                Buffers: shared hit=7505
                                ->  Nested Loop  (cost=2197.93..110300.02 rows=50 width=53) (actual time=0.111..4.717 rows=50 loops=1)
                                      Buffers: shared hit=7114
                                      ->  Nested Loop  (cost=2197.51..110277.78 rows=50 width=30) (actual time=0.105..4.570 rows=50 loops=1)
                                            Buffers: shared hit=6914
                                            ->  Nested Loop  (cost=2197.08..109855.53 rows=50 width=12) (actual time=0.100..4.422 rows=50 loops=1)
                                                  Buffers: shared hit=6714
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.011..0.017 rows=50 loops=1)
                                                  ->  Limit  (cost=2197.08..2197.08 rows=1 width=24) (actual time=0.088..0.088 rows=1 loops=50)
                                                        Buffers: shared hit=6714
                                                        ->  Sort  (cost=2197.08..2197.29 rows=84 width=24) (actual time=0.087..0.087 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=6714
                                                              ->  Nested Loop  (cost=0.86..2196.66 rows=84 width=24) (actual time=0.015..0.083 rows=13 loops=50)
                                                                    Buffers: shared hit=6714
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.003..0.005 rows=3 loops=50)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Buffers: shared hit=207
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..36.36 rows=14 width=8) (actual time=0.002..0.004 rows=4 loops=174)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=915
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.36 rows=14 width=0) (actual time=0.002..0.002 rows=1 loops=653)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=2729
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=653)
                                                                            Buffers: shared hit=2746
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=653)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=2746
                                            ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Index Cond: (id = versions_1.id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=200
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.34 rows=14 width=297) (actual time=0.003..0.005 rows=4 loops=50)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=391
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=182)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=728
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=182)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=546
Planning:
  Buffers: shared hit=115
Planning Time: 21.518 ms
Execution Time: 6.007 ms
```

### batched fetch, all versions — q=python313Packages. (50 hits)

Parameters: `["150986,152209,150834,152035,152503,152537,152607,144825,145013,147350,147764,147765,147997,148046,148297,148334,150150,150536,150586,150612,150629,150655,150684,150771,150780,150816,150824,150979,151062,151063,151070,151177,151212,151252,151267,151284,151298,151520,151586,151651,151873,272730,152489,152502,152504,152533,152553,152573,152630,152993"]` — Execution Time: 4.750 ms

```
Limit  (cost=118.21..1490.17 rows=1000 width=1391) (actual time=0.509..4.635 rows=174 loops=1)
  Buffers: shared hit=4114
  ->  Unique  (cost=118.21..5898.28 rows=4213 width=1391) (actual time=0.508..4.619 rows=174 loops=1)
        Buffers: shared hit=4114
        ->  Incremental Sort  (cost=118.21..5866.69 rows=4213 width=1391) (actual time=0.507..4.464 rows=653 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 14  Sort Method: quicksort  Average Memory: 101kB  Peak Memory: 101kB
              Pre-sorted Groups: 4  Sort Method: quicksort  Average Memory: 83kB  Peak Memory: 101kB
              Buffers: shared hit=4114
              ->  Nested Loop  (cost=1.99..5678.28 rows=4213 width=1391) (actual time=0.056..3.220 rows=653 loops=1)
                    Buffers: shared hit=4114
                    ->  Nested Loop  (cost=1.70..5030.68 rows=4213 width=1336) (actual time=0.047..2.798 rows=653 loops=1)
                          Buffers: shared hit=3934
                          ->  Nested Loop  (cost=1.28..2884.20 rows=4213 width=353) (actual time=0.040..1.477 rows=653 loops=1)
                                Buffers: shared hit=1322
                                ->  Nested Loop  (cost=0.85..506.22 rows=1610 width=64) (actual time=0.032..0.521 rows=174 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=407
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.023..0.283 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.014 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.005..0.005 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.36 rows=32 width=33) (actual time=0.003..0.004 rows=3 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=207
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.34 rows=14 width=297) (actual time=0.002..0.004 rows=4 loops=174)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=915
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=653)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=2612
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=653)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 593  Misses: 60  Evictions: 0  Overflows: 0  Memory Usage: 10kB
                          Buffers: shared hit=180
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=60)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=180
Planning:
  Buffers: shared hit=69
Planning Time: 8.183 ms
Execution Time: 4.750 ms
```

### ranked terms — q=hello

Parameters: `["hello","hello"]` — Execution Time: 87.848 ms

```
Limit  (cost=1103.78..1103.90 rows=50 width=44) (actual time=87.604..87.629 rows=14 loops=1)
  Buffers: shared hit=1270
  CTE breadth
    ->  Aggregate  (cost=8.76..8.77 rows=1 width=1) (actual time=0.026..0.028 rows=1 loops=1)
          Buffers: shared hit=4
          ->  Limit  (cost=0.42..8.45 rows=25 width=4) (actual time=0.018..0.024 rows=5 loops=1)
                Buffers: shared hit=4
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..8.45 rows=25 width=4) (actual time=0.018..0.022 rows=5 loops=1)
                      Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                      Filter: (lower(name) ~~ 'hello%'::text)
                      Buffers: shared hit=4
  CTE prefix
    ->  Limit  (cost=68.19..68.32 rows=50 width=39) (actual time=0.078..0.094 rows=5 loops=1)
          Buffers: shared hit=11
          ->  Sort  (cost=68.19..68.39 rows=78 width=39) (actual time=0.077..0.093 rows=5 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'hello'::text) ELSE GREATEST(similarity(search_terms_3.name, 'hello'::text), similarity(search_terms_3.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=11
                ->  HashAggregate  (cost=64.96..65.74 rows=78 width=39) (actual time=0.073..0.089 rows=5 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Batches: 1  Memory Usage: 24kB
                      Buffers: shared hit=11
                      ->  Append  (cost=8.90..60.86 rows=78 width=68) (actual time=0.044..0.069 rows=5 loops=1)
                            Buffers: shared hit=11
                            ->  Result  (cost=8.90..12.92 rows=50 width=68) (actual time=0.044..0.050 rows=5 loops=1)
                                  One-Time Filter: (NOT (InitPlan 2).col1)
                                  Buffers: shared hit=11
                                  InitPlan 2
                                    ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=0.028..0.028 rows=1 loops=1)
                                          Buffers: shared hit=4
                                  ->  Bitmap Heap Scan on search_terms search_terms_3  (cost=8.90..12.92 rows=50 width=68) (actual time=0.014..0.018 rows=5 loops=1)
                                        Recheck Cond: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                                        Filter: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                                        Heap Blocks: exact=1
                                        Buffers: shared hit=7
                                        ->  BitmapOr  (cost=8.88..8.88 rows=1 width=0) (actual time=0.009..0.011 rows=0 loops=1)
                                              Buffers: shared hit=6
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.003..0.003 rows=5 loops=1)
                                                    Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                                    Buffers: shared hit=3
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.005..0.006 rows=5 loops=1)
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
                            ->  Result  (cost=8.88..12.90 rows=1 width=68) (actual time=0.001..0.003 rows=0 loops=1)
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
                            ->  Subquery Scan on "*SELECT* 4"  (cost=8.51..8.54 rows=3 width=68) (actual time=0.004..0.006 rows=0 loops=1)
                                  ->  Limit  (cost=8.51..8.51 rows=3 width=72) (actual time=0.003..0.005 rows=0 loops=1)
                                        InitPlan 5
                                          ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                        ->  Sort  (cost=8.49..8.49 rows=3 width=72) (actual time=0.003..0.003 rows=0 loops=1)
                                              Sort Key: ((lower(search_terms_6.name) <-> 'hello'::text)), search_terms_6.name
                                              Sort Method: quicksort  Memory: 25kB
                                              ->  Result  (cost=0.42..8.46 rows=3 width=72) (actual time=0.001..0.001 rows=0 loops=1)
                                                    One-Time Filter: (InitPlan 5).col1
                                                    ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_6  (cost=0.42..8.45 rows=3 width=68) (never executed)
                                                          Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                                          Filter: ((top_level_attr IS NOT NULL) AND ((name = attr_path) IS TRUE) AND (lower(name) ~~ 'hello%'::text))
                            ->  Subquery Scan on "*SELECT* 5"  (cost=9.07..9.34 rows=22 width=68) (actual time=0.002..0.004 rows=0 loops=1)
                                  ->  Limit  (cost=9.07..9.12 rows=22 width=72) (actual time=0.002..0.003 rows=0 loops=1)
                                        InitPlan 6
                                          ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Sort  (cost=9.05..9.10 rows=22 width=72) (actual time=0.002..0.002 rows=0 loops=1)
                                              Sort Key: ((lower(search_terms_7.name) <-> 'hello'::text)), search_terms_7.name
                                              Sort Method: quicksort  Memory: 25kB
                                              ->  Result  (cost=0.42..8.56 rows=22 width=72) (actual time=0.001..0.001 rows=0 loops=1)
                                                    One-Time Filter: (InitPlan 6).col1
                                                    ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_7  (cost=0.42..8.45 rows=22 width=68) (never executed)
                                                          Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                                          Filter: ((top_level_attr IS NULL) AND ((name = attr_path) IS TRUE) AND (lower(name) ~~ 'hello%'::text))
  ->  Sort  (cost=1026.69..1026.94 rows=100 width=44) (actual time=87.603..87.608 rows=14 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=1270
        ->  GroupAggregate  (cost=1021.37..1023.37 rows=100 width=44) (actual time=87.590..87.600 rows=14 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=1270
              ->  Sort  (cost=1021.37..1021.62 rows=100 width=42) (actual time=87.586..87.591 rows=14 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=1270
                    ->  Append  (cost=0.00..1018.05 rows=100 width=42) (actual time=0.080..87.584 rows=14 loops=1)
                          Buffers: shared hit=1270
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=0.079..0.081 rows=5 loops=1)
                                Buffers: shared hit=11
                          ->  Subquery Scan on fuzzy  (cost=1015.92..1016.55 rows=50 width=39) (actual time=87.493..87.499 rows=9 loops=1)
                                Buffers: shared hit=1259
                                ->  Limit  (cost=1015.92..1016.05 rows=50 width=39) (actual time=87.493..87.497 rows=9 loops=1)
                                      Buffers: shared hit=1259
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.002..0.003 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.001 rows=5 loops=1)
                                      ->  Sort  (cost=1014.79..1014.91 rows=50 width=39) (actual time=87.492..87.494 rows=9 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'hello'::text) ELSE GREATEST(similarity(search_terms.name, 'hello'::text), similarity(search_terms.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            Buffers: shared hit=1259
                                            ->  GroupAggregate  (cost=1010.13..1013.38 rows=50 width=39) (actual time=87.469..87.487 rows=9 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Buffers: shared hit=1259
                                                  ->  Sort  (cost=1010.13..1010.25 rows=50 width=68) (actual time=87.455..87.457 rows=9 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        Buffers: shared hit=1259
                                                        ->  Result  (cost=826.96..1008.72 rows=50 width=68) (actual time=39.870..87.445 rows=9 loops=1)
                                                              One-Time Filter: ((InitPlan 8).col1 < 50)
                                                              Buffers: shared hit=1259
                                                              ->  Bitmap Heap Scan on search_terms  (cost=826.96..1008.72 rows=50 width=68) (actual time=39.866..87.438 rows=9 loops=1)
                                                                    Recheck Cond: ((name % 'hello'::text) OR (attr_path % 'hello'::text))
                                                                    Rows Removed by Index Recheck: 17530
                                                                    Filter: ((lower(name) !~~ 'hello%'::text) AND (lower(attr_path) !~~ 'hello%'::text))
                                                                    Rows Removed by Filter: 5
                                                                    Heap Blocks: exact=1039
                                                                    Buffers: shared hit=1259
                                                                    ->  BitmapOr  (cost=826.96..826.96 rows=50 width=0) (actual time=5.044..5.044 rows=0 loops=1)
                                                                          Buffers: shared hit=220
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..413.47 rows=25 width=0) (actual time=2.571..2.571 rows=17544 loops=1)
                                                                                Index Cond: (name % 'hello'::text)
                                                                                Buffers: shared hit=110
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..413.47 rows=25 width=0) (actual time=2.473..2.473 rows=17544 loops=1)
                                                                                Index Cond: (attr_path % 'hello'::text)
                                                                                Buffers: shared hit=110
Planning:
  Buffers: shared hit=4
Planning Time: 1.394 ms
Execution Time: 87.848 ms
```

### batched fetch, latest — q=hello (14 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,51341,242138,42681"]` — Execution Time: 1.835 ms

```
Limit  (cost=4260.88..31067.76 rows=14 width=1376) (actual time=1.419..1.737 rows=14 loops=1)
  Buffers: shared hit=2737
  ->  Unique  (cost=4260.88..31067.76 rows=14 width=1376) (actual time=1.418..1.734 rows=14 loops=1)
        Buffers: shared hit=2737
        ->  Incremental Sort  (cost=4260.88..31067.28 rows=193 width=1376) (actual time=1.417..1.722 rows=46 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 65kB  Peak Memory: 65kB
              Buffers: shared hit=2737
              ->  Nested Loop  (cost=2199.06..31060.93 rows=193 width=1376) (actual time=0.177..1.673 rows=46 loops=1)
                    Buffers: shared hit=2737
                    ->  Nested Loop  (cost=2198.78..31003.51 rows=193 width=1321) (actual time=0.172..1.605 rows=46 loops=1)
                          Buffers: shared hit=2599
                          ->  Nested Loop  (cost=2198.36..30905.17 rows=193 width=338) (actual time=0.165..1.506 rows=46 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                Buffers: shared hit=2415
                                ->  Nested Loop  (cost=2197.93..30884.01 rows=14 width=53) (actual time=0.162..1.447 rows=14 loops=1)
                                      Buffers: shared hit=2332
                                      ->  Nested Loop  (cost=2197.51..30877.78 rows=14 width=30) (actual time=0.157..1.411 rows=14 loops=1)
                                            Buffers: shared hit=2276
                                            ->  Nested Loop  (cost=2197.08..30759.55 rows=14 width=12) (actual time=0.151..1.372 rows=14 loops=1)
                                                  Buffers: shared hit=2220
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.14 rows=14 width=12) (actual time=0.006..0.008 rows=14 loops=1)
                                                  ->  Limit  (cost=2197.08..2197.08 rows=1 width=24) (actual time=0.097..0.097 rows=1 loops=14)
                                                        Buffers: shared hit=2220
                                                        ->  Sort  (cost=2197.08..2197.29 rows=84 width=24) (actual time=0.097..0.097 rows=1 loops=14)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=2220
                                                              ->  Nested Loop  (cost=0.86..2196.66 rows=84 width=24) (actual time=0.013..0.092 rows=16 loops=14)
                                                                    Buffers: shared hit=2220
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.004..0.005 rows=5 loops=14)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Buffers: shared hit=57
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..36.36 rows=14 width=8) (actual time=0.002..0.003 rows=3 loops=76)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=374
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.36 rows=14 width=0) (actual time=0.001..0.001 rows=1 loops=218)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=878
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=218)
                                                                            Buffers: shared hit=906
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=218)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=906
                                            ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=14)
                                                  Index Cond: (id = versions_1.id)
                                                  Buffers: shared hit=56
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=14)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=56
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.34 rows=14 width=297) (actual time=0.002..0.003 rows=3 loops=14)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=83
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=46)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=184
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=46)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=138
Planning:
  Buffers: shared hit=115
Planning Time: 13.575 ms
Execution Time: 1.835 ms
```

### batched fetch, all versions — q=hello (14 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,51341,242138,42681"]` — Execution Time: 1.809 ms

```
Limit  (cost=130.34..1564.73 rows=1000 width=1391) (actual time=0.365..1.721 rows=76 loops=1)
  Buffers: shared hit=2013
  ->  Unique  (cost=130.34..1822.92 rows=1180 width=1391) (actual time=0.364..1.713 rows=76 loops=1)
        Buffers: shared hit=2013
        ->  Incremental Sort  (cost=130.34..1814.07 rows=1180 width=1391) (actual time=0.363..1.659 rows=218 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 5  Sort Method: quicksort  Average Memory: 88kB  Peak Memory: 88kB
              Pre-sorted Groups: 3  Sort Method: quicksort  Average Memory: 50kB  Peak Memory: 54kB
              Buffers: shared hit=2013
              ->  Nested Loop  (cost=1.98..1761.29 rows=1180 width=1391) (actual time=0.049..1.214 rows=218 loops=1)
                    Buffers: shared hit=2013
                    ->  Nested Loop  (cost=1.70..1410.19 rows=1180 width=1336) (actual time=0.043..0.868 rows=218 loops=1)
                          Buffers: shared hit=1359
                          ->  Nested Loop  (cost=1.28..808.99 rows=1180 width=353) (actual time=0.036..0.466 rows=218 loops=1)
                                Buffers: shared hit=487
                                ->  Nested Loop  (cost=0.85..142.86 rows=451 width=64) (actual time=0.029..0.135 rows=76 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=113
                                      ->  Nested Loop  (cost=0.42..118.27 rows=14 width=43) (actual time=0.020..0.055 rows=14 loops=1)
                                            Buffers: shared hit=56
                                            ->  Function Scan on unnest hits  (cost=0.00..0.14 rows=14 width=12) (actual time=0.006..0.008 rows=14 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=14)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=56
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.36 rows=32 width=33) (actual time=0.003..0.004 rows=5 loops=14)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=57
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.34 rows=14 width=297) (actual time=0.002..0.004 rows=3 loops=76)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=374
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=218)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=872
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=218)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=654
Planning:
  Buffers: shared hit=69
Planning Time: 7.898 ms
Execution Time: 1.809 ms
```

### ranked terms — q=-

Parameters: `["-","-"]` — Execution Time: 889.419 ms

```
Limit  (cost=7698.67..7698.79 rows=50 width=44) (actual time=888.071..889.270 rows=0 loops=1)
  Buffers: shared hit=2982
  CTE prefix
    ->  Limit  (cost=17.44..17.57 rows=50 width=39) (actual time=0.024..0.028 rows=0 loops=1)
          Buffers: shared hit=6
          ->  Sort  (cost=17.44..17.57 rows=50 width=39) (actual time=0.023..0.027 rows=0 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_1.name) = '-'::text) THEN 1000 WHEN (lower(search_terms_1.attr_path) = '-'::text) THEN 900 WHEN (lower(search_terms_1.name) ~~ '-%'::text) THEN 800 WHEN (lower(search_terms_1.attr_path) ~~ '-%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_1.name = search_terms_1.attr_path) THEN similarity(search_terms_1.name, '-'::text) ELSE GREATEST(similarity(search_terms_1.name, '-'::text), similarity(search_terms_1.attr_path, '-'::text)) END)) + (CASE WHEN (search_terms_1.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_1.name
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=6
                ->  HashAggregate  (cost=15.53..16.03 rows=50 width=39) (actual time=0.021..0.024 rows=0 loops=1)
                      Group Key: search_terms_1.package_id, search_terms_1.name
                      Batches: 1  Memory Usage: 24kB
                      Buffers: shared hit=6
                      ->  Bitmap Heap Scan on search_terms search_terms_1  (cost=8.88..12.90 rows=50 width=68) (actual time=0.019..0.022 rows=0 loops=1)
                            Recheck Cond: ((lower(name) ~~ '-%'::text) OR (lower(attr_path) ~~ '-%'::text))
                            Filter: ((lower(name) ~~ '-%'::text) OR (lower(attr_path) ~~ '-%'::text))
                            Buffers: shared hit=6
                            ->  BitmapOr  (cost=8.88..8.88 rows=1 width=0) (actual time=0.016..0.018 rows=0 loops=1)
                                  Buffers: shared hit=6
                                  ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.011..0.011 rows=0 loops=1)
                                        Index Cond: ((lower(name) >= '-'::text) AND (lower(name) < '.'::text))
                                        Buffers: shared hit=3
                                  ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.004..0.004 rows=0 loops=1)
                                        Index Cond: ((lower(attr_path) >= '-'::text) AND (lower(attr_path) < '.'::text))
                                        Buffers: shared hit=3
  ->  Sort  (cost=7681.10..7681.35 rows=100 width=44) (actual time=888.070..889.263 rows=0 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=2982
        ->  GroupAggregate  (cost=7675.78..7677.78 rows=100 width=44) (actual time=887.970..889.163 rows=0 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=2982
              ->  Sort  (cost=7675.78..7676.03 rows=100 width=42) (actual time=887.969..889.161 rows=0 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=2982
                    ->  Append  (cost=0.00..7672.46 rows=100 width=42) (actual time=887.966..889.158 rows=0 loops=1)
                          Buffers: shared hit=2982
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=0.025..0.025 rows=0 loops=1)
                                Buffers: shared hit=6
                          ->  Subquery Scan on fuzzy  (cost=7670.33..7670.96 rows=50 width=39) (actual time=887.939..889.130 rows=0 loops=1)
                                Buffers: shared hit=2976
                                ->  Limit  (cost=7670.33..7670.46 rows=50 width=39) (actual time=887.939..889.129 rows=0 loops=1)
                                      Buffers: shared hit=2976
                                      InitPlan 2
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.002..0.003 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.000 rows=0 loops=1)
                                      ->  Sort  (cost=7669.20..7669.32 rows=50 width=39) (actual time=887.938..889.127 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = '-'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = '-'::text) THEN 900 WHEN (lower(search_terms.name) ~~ '-%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ '-%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, '-'::text) ELSE GREATEST(similarity(search_terms.name, '-'::text), similarity(search_terms.attr_path, '-'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            Buffers: shared hit=2976
                                            ->  Finalize GroupAggregate  (cost=7661.92..7667.79 rows=50 width=39) (actual time=887.935..889.123 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Buffers: shared hit=2976
                                                  ->  Gather Merge  (cost=7661.92..7667.07 rows=29 width=39) (actual time=887.934..889.122 rows=0 loops=1)
                                                        Workers Planned: 1
                                                        Workers Launched: 1
                                                        Buffers: shared hit=2976
                                                        ->  Partial GroupAggregate  (cost=6661.91..6663.80 rows=29 width=39) (actual time=878.277..878.279 rows=0 loops=2)
                                                              Group Key: search_terms.package_id, search_terms.name
                                                              Buffers: shared hit=2976
                                                              ->  Sort  (cost=6661.91..6661.99 rows=29 width=68) (actual time=878.276..878.277 rows=0 loops=2)
                                                                    Sort Key: search_terms.package_id, search_terms.name
                                                                    Sort Method: quicksort  Memory: 25kB
                                                                    Buffers: shared hit=2976
                                                                    Worker 0:  Sort Method: quicksort  Memory: 25kB
                                                                    ->  Result  (cost=0.00..6661.21 rows=29 width=68) (actual time=878.245..878.245 rows=0 loops=2)
                                                                          One-Time Filter: ((InitPlan 2).col1 < 50)
                                                                          Buffers: shared hit=2961
                                                                          ->  Parallel Seq Scan on search_terms  (cost=0.00..6661.21 rows=29 width=68) (actual time=878.242..878.243 rows=0 loops=2)
                                                                                Filter: (((name % '-'::text) OR (attr_path % '-'::text)) AND (lower(name) !~~ '-%'::text) AND (lower(attr_path) !~~ '-%'::text))
                                                                                Rows Removed by Filter: 126030
                                                                                Buffers: shared hit=2961
Planning:
  Buffers: shared hit=30
Planning Time: 9.962 ms
Execution Time: 889.419 ms
```

### batched fetch, latest — q=- (0 hits)

Parameters: `[""]` — Execution Time: 0.107 ms

```
Limit  (cost=2219.08..2219.31 rows=1 width=1376) (actual time=0.012..0.013 rows=0 loops=1)
  ->  Unique  (cost=2219.08..2219.31 rows=1 width=1376) (actual time=0.011..0.012 rows=0 loops=1)
        ->  Incremental Sort  (cost=2219.08..2219.27 rows=14 width=1376) (actual time=0.011..0.012 rows=0 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
              ->  Nested Loop  (cost=2199.06..2218.81 rows=14 width=1376) (actual time=0.004..0.005 rows=0 loops=1)
                    ->  Nested Loop  (cost=2198.78..2214.65 rows=14 width=1321) (actual time=0.004..0.005 rows=0 loops=1)
                          ->  Nested Loop  (cost=2198.36..2207.51 rows=14 width=338) (actual time=0.004..0.005 rows=0 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                ->  Nested Loop  (cost=2197.93..2206.00 rows=1 width=53) (actual time=0.004..0.004 rows=0 loops=1)
                                      ->  Nested Loop  (cost=2197.51..2205.56 rows=1 width=30) (actual time=0.004..0.004 rows=0 loops=1)
                                            ->  Nested Loop  (cost=2197.08..2197.11 rows=1 width=12) (actual time=0.003..0.004 rows=0 loops=1)
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.01 rows=1 width=12) (actual time=0.003..0.003 rows=0 loops=1)
                                                  ->  Limit  (cost=2197.08..2197.08 rows=1 width=24) (never executed)
                                                        ->  Sort  (cost=2197.08..2197.29 rows=84 width=24) (never executed)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              ->  Nested Loop  (cost=0.86..2196.66 rows=84 width=24) (never executed)
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (never executed)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..36.36 rows=14 width=8) (never executed)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.36 rows=14 width=0) (never executed)
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
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.34 rows=14 width=297) (never executed)
                                      Index Cond: (version_id = versions.id)
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (never executed)
                                Index Cond: (id = variants.meta_id)
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (never executed)
                          Index Cond: (seq = variants.commit_seq)
Planning:
  Buffers: shared hit=115
Planning Time: 14.860 ms
Execution Time: 0.107 ms
```

### batched fetch, all versions — q=- (0 hits)

Parameters: `[""]` — Execution Time: 0.080 ms

```
Limit  (cost=127.95..129.65 rows=84 width=1391) (actual time=0.017..0.019 rows=0 loops=1)
  ->  Unique  (cost=127.95..129.65 rows=84 width=1391) (actual time=0.017..0.018 rows=0 loops=1)
        ->  Incremental Sort  (cost=127.95..129.02 rows=84 width=1391) (actual time=0.016..0.017 rows=0 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
              ->  Nested Loop  (cost=1.98..125.26 rows=84 width=1391) (actual time=0.004..0.005 rows=0 loops=1)
                    ->  Nested Loop  (cost=1.70..100.27 rows=84 width=1336) (actual time=0.004..0.005 rows=0 loops=1)
                          ->  Nested Loop  (cost=1.28..57.47 rows=84 width=353) (actual time=0.004..0.004 rows=0 loops=1)
                                ->  Nested Loop  (cost=0.85..10.21 rows=32 width=64) (actual time=0.003..0.004 rows=0 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      ->  Nested Loop  (cost=0.42..8.45 rows=1 width=43) (actual time=0.003..0.004 rows=0 loops=1)
                                            ->  Function Scan on unnest hits  (cost=0.00..0.01 rows=1 width=12) (actual time=0.003..0.003 rows=0 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (never executed)
                                                  Index Cond: (id = hits.package_id)
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.36 rows=32 width=33) (never executed)
                                            Index Cond: (package_id = packages.id)
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.34 rows=14 width=297) (never executed)
                                      Index Cond: (version_id = versions.id)
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (never executed)
                                Index Cond: (id = variants.meta_id)
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (never executed)
                          Index Cond: (seq = variants.commit_seq)
Planning:
  Buffers: shared hit=69
Planning Time: 17.919 ms
Execution Time: 0.080 ms
```

## Name lookups (/v2/resolve, /v1/resolve, /v2/pkg, /v1/pkg)

### pick latest version — name=go

Parameters: `["go"]` — Execution Time: 8.116 ms

```
Limit  (cost=2836.78..2836.78 rows=1 width=24) (actual time=8.016..8.021 rows=1 loops=1)
  Buffers: shared hit=15289
  ->  Sort  (cost=2836.78..2837.09 rows=126 width=24) (actual time=8.014..8.019 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=15289
        ->  Nested Loop  (cost=204.21..2836.15 rows=126 width=24) (actual time=1.093..7.893 rows=653 loops=1)
              Buffers: shared hit=15289
              ->  Nested Loop  (cost=203.79..1336.31 rows=126 width=27) (actual time=1.072..3.859 rows=653 loops=1)
                    Buffers: shared hit=6793
                    ->  Nested Loop  (cost=203.36..1277.03 rows=127 width=8) (actual time=1.066..2.642 rows=728 loops=1)
                          Buffers: shared hit=3881
                          ->  HashAggregate  (cost=202.93..204.20 rows=127 width=4) (actual time=1.059..1.186 rows=728 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=969
                                ->  Append  (cost=1.28..202.61 rows=127 width=4) (actual time=0.029..0.885 rows=988 loops=1)
                                      Buffers: shared hit=969
                                      ->  Nested Loop  (cost=1.28..83.80 rows=16 width=4) (actual time=0.029..0.731 rows=728 loops=1)
                                            Buffers: shared hit=905
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.022..0.093 rows=192 loops=1)
                                                  Buffers: shared hit=24
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.012 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'go'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.008..0.056 rows=192 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=20
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.34 rows=14 width=8) (actual time=0.002..0.003 rows=4 loops=192)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=881
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..118.18 rows=111 width=4) (actual time=0.007..0.078 rows=260 loops=1)
                                            Index Cond: (attr_path = 'go'::text)
                                            Buffers: shared hit=64
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=728)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=2912
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=728)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=2912
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=653)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 653
                    Buffers: shared hit=3266
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.36 rows=14 width=0) (actual time=0.002..0.002 rows=1 loops=653)
                      Index Cond: (version_id = versions.id)
                      Filter: (NOT broken)
                      Buffers: shared hit=2612
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=653)
                      Buffers: shared hit=2618
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=653)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=2618
Planning:
  Buffers: shared hit=94
Planning Time: 11.318 ms
Execution Time: 8.116 ms
```

### pick latest version — name=python

Parameters: `["python"]` — Execution Time: 6.075 ms

```
Limit  (cost=2836.78..2836.78 rows=1 width=24) (actual time=5.983..5.986 rows=1 loops=1)
  Buffers: shared hit=11504
  ->  Sort  (cost=2836.78..2837.09 rows=126 width=24) (actual time=5.981..5.984 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=11504
        ->  Nested Loop  (cost=204.21..2836.15 rows=126 width=24) (actual time=0.868..5.898 rows=421 loops=1)
              Buffers: shared hit=11504
              ->  Nested Loop  (cost=203.79..1336.31 rows=126 width=27) (actual time=0.847..3.205 rows=421 loops=1)
                    Buffers: shared hit=6021
                    ->  Nested Loop  (cost=203.36..1277.03 rows=127 width=8) (actual time=0.841..2.108 rows=654 loops=1)
                          Buffers: shared hit=3405
                          ->  HashAggregate  (cost=202.93..204.20 rows=127 width=4) (actual time=0.835..0.933 rows=654 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=787
                                ->  Append  (cost=1.28..202.61 rows=127 width=4) (actual time=0.028..0.701 rows=657 loops=1)
                                      Buffers: shared hit=787
                                      ->  Nested Loop  (cost=1.28..83.80 rows=16 width=4) (actual time=0.028..0.643 rows=654 loops=1)
                                            Buffers: shared hit=782
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.022..0.094 rows=179 loops=1)
                                                  Buffers: shared hit=25
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.013 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'python'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.007..0.058 rows=179 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=21
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.34 rows=14 width=8) (actual time=0.002..0.002 rows=4 loops=179)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=757
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..118.18 rows=111 width=4) (actual time=0.006..0.007 rows=3 loops=1)
                                            Index Cond: (attr_path = 'python'::text)
                                            Buffers: shared hit=5
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.001..0.001 rows=1 loops=654)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=2617
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=654)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=2616
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=421)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 421
                    Buffers: shared hit=2106
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.36 rows=14 width=0) (actual time=0.002..0.002 rows=1 loops=421)
                      Index Cond: (version_id = versions.id)
                      Filter: (NOT broken)
                      Buffers: shared hit=1684
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=421)
                      Buffers: shared hit=1693
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=421)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=1693
Planning:
  Buffers: shared hit=94
Planning Time: 11.206 ms
Execution Time: 6.075 ms
```

### pick latest version — name=python311

Parameters: `["python311"]` — Execution Time: 0.974 ms

```
Limit  (cost=2836.78..2836.78 rows=1 width=24) (actual time=0.874..0.876 rows=1 loops=1)
  Buffers: shared hit=1450
  ->  Sort  (cost=2836.78..2837.09 rows=126 width=24) (actual time=0.872..0.875 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=1450
        ->  Nested Loop  (cost=204.21..2836.15 rows=126 width=24) (actual time=0.134..0.856 rows=54 loops=1)
              Buffers: shared hit=1450
              ->  Nested Loop  (cost=203.79..1336.31 rows=126 width=27) (actual time=0.108..0.435 rows=54 loops=1)
                    Buffers: shared hit=744
                    ->  Nested Loop  (cost=203.36..1277.03 rows=127 width=8) (actual time=0.100..0.275 rows=90 loops=1)
                          Buffers: shared hit=384
                          ->  HashAggregate  (cost=202.93..204.20 rows=127 width=4) (actual time=0.087..0.101 rows=90 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=22
                                ->  Append  (cost=1.28..202.61 rows=127 width=4) (actual time=0.023..0.069 rows=90 loops=1)
                                      Buffers: shared hit=22
                                      ->  Nested Loop  (cost=1.28..83.80 rows=16 width=4) (actual time=0.012..0.013 rows=0 loops=1)
                                            Buffers: shared hit=3
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.012..0.013 rows=0 loops=1)
                                                  Buffers: shared hit=3
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.012 rows=0 loops=1)
                                                        Index Cond: (lower(name) = 'python311'::text)
                                                        Buffers: shared hit=3
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (never executed)
                                                        Index Cond: (package_id = p.id)
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.34 rows=14 width=8) (never executed)
                                                  Index Cond: (version_id = ve.id)
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..118.18 rows=111 width=4) (actual time=0.010..0.048 rows=90 loops=1)
                                            Index Cond: (attr_path = 'python311'::text)
                                            Buffers: shared hit=19
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=90)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=361
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.002..0.002 rows=1 loops=90)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=360
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=54)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 54
                    Buffers: shared hit=271
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.36 rows=14 width=0) (actual time=0.002..0.002 rows=1 loops=54)
                      Index Cond: (version_id = versions.id)
                      Filter: (NOT broken)
                      Buffers: shared hit=216
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.003..0.003 rows=1 loops=54)
                      Buffers: shared hit=219
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=54)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=219
Planning:
  Buffers: shared hit=94
Planning Time: 14.935 ms
Execution Time: 0.974 ms
```

### pick latest version — name=hello

Parameters: `["hello"]` — Execution Time: 0.424 ms

```
Limit  (cost=2836.78..2836.78 rows=1 width=24) (actual time=0.335..0.338 rows=1 loops=1)
  Buffers: shared hit=446
  ->  Sort  (cost=2836.78..2837.09 rows=126 width=24) (actual time=0.334..0.336 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=446
        ->  Nested Loop  (cost=204.21..2836.15 rows=126 width=24) (actual time=0.135..0.324 rows=19 loops=1)
              Buffers: shared hit=446
              ->  Nested Loop  (cost=203.79..1336.31 rows=126 width=27) (actual time=0.110..0.179 rows=19 loops=1)
                    Buffers: shared hit=195
                    ->  Nested Loop  (cost=203.36..1277.03 rows=127 width=8) (actual time=0.105..0.142 rows=19 loops=1)
                          Buffers: shared hit=119
                          ->  HashAggregate  (cost=202.93..204.20 rows=127 width=4) (actual time=0.098..0.102 rows=19 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=43
                                ->  Append  (cost=1.28..202.61 rows=127 width=4) (actual time=0.044..0.087 rows=38 loops=1)
                                      Buffers: shared hit=43
                                      ->  Nested Loop  (cost=1.28..83.80 rows=16 width=4) (actual time=0.043..0.068 rows=19 loops=1)
                                            Buffers: shared hit=33
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.033..0.035 rows=5 loops=1)
                                                  Buffers: shared hit=8
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.023..0.024 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'hello'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.007..0.008 rows=5 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=4
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.34 rows=14 width=8) (actual time=0.004..0.006 rows=4 loops=5)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=25
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..118.18 rows=111 width=4) (actual time=0.006..0.013 rows=19 loops=1)
                                            Index Cond: (attr_path = 'hello'::text)
                                            Buffers: shared hit=10
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
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..36.36 rows=14 width=0) (actual time=0.002..0.002 rows=1 loops=19)
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
Planning Time: 11.157 ms
Execution Time: 0.424 ms
```

### every version — name=go

Parameters: `["go"]` — Execution Time: 9.529 ms

```
Limit  (cost=1499.71..1500.03 rows=127 width=1383) (actual time=9.111..9.214 rows=728 loops=1)
  Buffers: shared hit=14801
  ->  Sort  (cost=1499.71..1500.03 rows=127 width=1383) (actual time=9.110..9.158 rows=728 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 746kB
        Buffers: shared hit=14801
        ->  Nested Loop  (cost=204.91..1495.27 rows=127 width=1383) (actual time=1.248..8.347 rows=728 loops=1)
              Buffers: shared hit=14801
              ->  Nested Loop  (cost=204.63..1457.48 rows=127 width=1328) (actual time=1.242..7.116 rows=728 loops=1)
                    Buffers: shared hit=12617
                    ->  Nested Loop  (cost=204.21..1392.78 rows=127 width=345) (actual time=1.234..5.776 rows=728 loops=1)
                          Buffers: shared hit=9705
                          ->  Nested Loop  (cost=203.79..1336.31 rows=127 width=322) (actual time=1.227..4.418 rows=728 loops=1)
                                Buffers: shared hit=6793
                                ->  Nested Loop  (cost=203.36..1277.03 rows=127 width=297) (actual time=1.221..2.977 rows=728 loops=1)
                                      Buffers: shared hit=3881
                                      ->  HashAggregate  (cost=202.93..204.20 rows=127 width=4) (actual time=1.212..1.351 rows=728 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=969
                                            ->  Append  (cost=1.28..202.61 rows=127 width=4) (actual time=0.036..1.010 rows=988 loops=1)
                                                  Buffers: shared hit=969
                                                  ->  Nested Loop  (cost=1.28..83.80 rows=16 width=4) (actual time=0.036..0.838 rows=728 loops=1)
                                                        Buffers: shared hit=905
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.029..0.110 rows=192 loops=1)
                                                              Buffers: shared hit=24
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.016..0.017 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'go'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.009..0.063 rows=192 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=20
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.34 rows=14 width=8) (actual time=0.002..0.003 rows=4 loops=192)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=881
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..118.18 rows=111 width=4) (actual time=0.008..0.082 rows=260 loops=1)
                                                        Index Cond: (attr_path = 'go'::text)
                                                        Buffers: shared hit=64
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=301) (actual time=0.002..0.002 rows=1 loops=728)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=2912
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.002..0.002 rows=1 loops=728)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=2912
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=728)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=2912
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=728)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=2912
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=728)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=2184
Planning:
  Buffers: shared hit=116
Planning Time: 14.151 ms
Execution Time: 9.529 ms
```

### every version — name=python

Parameters: `["python"]` — Execution Time: 7.817 ms

```
Limit  (cost=1499.71..1500.03 rows=127 width=1383) (actual time=7.455..7.547 rows=654 loops=1)
  Buffers: shared hit=13215
  ->  Sort  (cost=1499.71..1500.03 rows=127 width=1383) (actual time=7.453..7.497 rows=654 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 1306kB
        Buffers: shared hit=13215
        ->  Nested Loop  (cost=204.91..1495.27 rows=127 width=1383) (actual time=1.070..6.714 rows=654 loops=1)
              Buffers: shared hit=13215
              ->  Nested Loop  (cost=204.63..1457.48 rows=127 width=1328) (actual time=1.063..5.741 rows=654 loops=1)
                    Buffers: shared hit=11253
                    ->  Nested Loop  (cost=204.21..1392.78 rows=127 width=345) (actual time=1.054..4.590 rows=654 loops=1)
                          Buffers: shared hit=8637
                          ->  Nested Loop  (cost=203.79..1336.31 rows=127 width=322) (actual time=1.048..3.589 rows=654 loops=1)
                                Buffers: shared hit=6021
                                ->  Nested Loop  (cost=203.36..1277.03 rows=127 width=297) (actual time=1.041..2.458 rows=654 loops=1)
                                      Buffers: shared hit=3405
                                      ->  HashAggregate  (cost=202.93..204.20 rows=127 width=4) (actual time=1.033..1.148 rows=654 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=787
                                            ->  Append  (cost=1.28..202.61 rows=127 width=4) (actual time=0.034..0.881 rows=657 loops=1)
                                                  Buffers: shared hit=787
                                                  ->  Nested Loop  (cost=1.28..83.80 rows=16 width=4) (actual time=0.033..0.808 rows=654 loops=1)
                                                        Buffers: shared hit=782
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.026..0.107 rows=179 loops=1)
                                                              Buffers: shared hit=25
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.015..0.016 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'python'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.008..0.062 rows=179 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=21
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.34 rows=14 width=8) (actual time=0.002..0.003 rows=4 loops=179)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=757
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..118.18 rows=111 width=4) (actual time=0.008..0.009 rows=3 loops=1)
                                                        Index Cond: (attr_path = 'python'::text)
                                                        Buffers: shared hit=5
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=301) (actual time=0.002..0.002 rows=1 loops=654)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=2617
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=654)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=2616
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=654)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=2616
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=654)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=2616
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=654)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=1962
Planning:
  Buffers: shared hit=116
Planning Time: 15.963 ms
Execution Time: 7.817 ms
```

### every version — name=python311

Parameters: `["python311"]` — Execution Time: 1.117 ms

```
Limit  (cost=1499.71..1500.03 rows=127 width=1383) (actual time=0.986..0.999 rows=90 loops=1)
  Buffers: shared hit=1734
  ->  Sort  (cost=1499.71..1500.03 rows=127 width=1383) (actual time=0.984..0.991 rows=90 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 205kB
        Buffers: shared hit=1734
        ->  Nested Loop  (cost=204.91..1495.27 rows=127 width=1383) (actual time=0.120..0.888 rows=90 loops=1)
              Buffers: shared hit=1734
              ->  Nested Loop  (cost=204.63..1457.48 rows=127 width=1328) (actual time=0.115..0.747 rows=90 loops=1)
                    Buffers: shared hit=1464
                    ->  Nested Loop  (cost=204.21..1392.78 rows=127 width=345) (actual time=0.109..0.594 rows=90 loops=1)
                          Buffers: shared hit=1104
                          ->  Nested Loop  (cost=203.79..1336.31 rows=127 width=322) (actual time=0.105..0.450 rows=90 loops=1)
                                Buffers: shared hit=744
                                ->  Nested Loop  (cost=203.36..1277.03 rows=127 width=297) (actual time=0.098..0.284 rows=90 loops=1)
                                      Buffers: shared hit=384
                                      ->  HashAggregate  (cost=202.93..204.20 rows=127 width=4) (actual time=0.089..0.103 rows=90 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=22
                                            ->  Append  (cost=1.28..202.61 rows=127 width=4) (actual time=0.024..0.071 rows=90 loops=1)
                                                  Buffers: shared hit=22
                                                  ->  Nested Loop  (cost=1.28..83.80 rows=16 width=4) (actual time=0.012..0.013 rows=0 loops=1)
                                                        Buffers: shared hit=3
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.012..0.013 rows=0 loops=1)
                                                              Buffers: shared hit=3
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.012 rows=0 loops=1)
                                                                    Index Cond: (lower(name) = 'python311'::text)
                                                                    Buffers: shared hit=3
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (never executed)
                                                                    Index Cond: (package_id = p.id)
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.34 rows=14 width=8) (never executed)
                                                              Index Cond: (version_id = ve.id)
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..118.18 rows=111 width=4) (actual time=0.011..0.050 rows=90 loops=1)
                                                        Index Cond: (attr_path = 'python311'::text)
                                                        Buffers: shared hit=19
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=301) (actual time=0.002..0.002 rows=1 loops=90)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=361
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=90)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=360
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=90)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=360
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=90)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=360
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=90)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=270
Planning:
  Buffers: shared hit=116
Planning Time: 12.555 ms
Execution Time: 1.117 ms
```

### every version — name=hello

Parameters: `["hello"]` — Execution Time: 0.461 ms

```
Limit  (cost=1499.71..1500.03 rows=127 width=1383) (actual time=0.361..0.365 rows=19 loops=1)
  Buffers: shared hit=404
  ->  Sort  (cost=1499.71..1500.03 rows=127 width=1383) (actual time=0.359..0.363 rows=19 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 63kB
        Buffers: shared hit=404
        ->  Nested Loop  (cost=204.91..1495.27 rows=127 width=1383) (actual time=0.161..0.331 rows=19 loops=1)
              Buffers: shared hit=404
              ->  Nested Loop  (cost=204.63..1457.48 rows=127 width=1328) (actual time=0.133..0.271 rows=19 loops=1)
                    Buffers: shared hit=347
                    ->  Nested Loop  (cost=204.21..1392.78 rows=127 width=345) (actual time=0.107..0.213 rows=19 loops=1)
                          Buffers: shared hit=271
                          ->  Nested Loop  (cost=203.79..1336.31 rows=127 width=322) (actual time=0.095..0.167 rows=19 loops=1)
                                Buffers: shared hit=195
                                ->  Nested Loop  (cost=203.36..1277.03 rows=127 width=297) (actual time=0.088..0.128 rows=19 loops=1)
                                      Buffers: shared hit=119
                                      ->  HashAggregate  (cost=202.93..204.20 rows=127 width=4) (actual time=0.081..0.086 rows=19 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=43
                                            ->  Append  (cost=1.28..202.61 rows=127 width=4) (actual time=0.031..0.071 rows=38 loops=1)
                                                  Buffers: shared hit=43
                                                  ->  Nested Loop  (cost=1.28..83.80 rows=16 width=4) (actual time=0.031..0.054 rows=19 loops=1)
                                                        Buffers: shared hit=33
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.023..0.026 rows=5 loops=1)
                                                              Buffers: shared hit=8
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.014 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'hello'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.007..0.009 rows=5 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=4
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.34 rows=14 width=8) (actual time=0.003..0.005 rows=4 loops=5)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=25
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..118.18 rows=111 width=4) (actual time=0.007..0.013 rows=19 loops=1)
                                                        Index Cond: (attr_path = 'hello'::text)
                                                        Buffers: shared hit=10
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=301) (actual time=0.002..0.002 rows=1 loops=19)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=76
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.002..0.002 rows=1 loops=19)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=76
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=19)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=76
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=19)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=76
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.003..0.003 rows=1 loops=19)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=57
Planning:
  Buffers: shared hit=116
Planning Time: 16.912 ms
Execution Time: 0.461 ms
```

## System filter (/v2/search?system=, /v2/resolve?system=)

### ranked terms — q=go, system=aarch64-darwin

Parameters: `["go","go","aarch64-darwin"]` — Execution Time: 2.710 ms

```
Limit  (cost=4568.37..4568.49 rows=50 width=44) (actual time=2.442..2.459 rows=50 loops=1)
  Buffers: shared hit=913
  CTE breadth
    ->  Aggregate  (cost=18.08..18.09 rows=1 width=1) (actual time=0.265..0.265 rows=1 loops=1)
          Buffers: shared hit=28
          ->  Limit  (cost=0.42..17.77 rows=25 width=4) (actual time=0.025..0.235 rows=452 loops=1)
                Buffers: shared hit=28
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..17.77 rows=25 width=4) (actual time=0.024..0.197 rows=452 loops=1)
                      Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                      Filter: (lower(name) ~~ 'go%'::text)
                      Buffers: shared hit=28
  CTE prefix
    ->  Limit  (cost=2253.95..2919.89 rows=50 width=39) (actual time=1.889..2.361 rows=50 loops=1)
          Buffers: shared hit=913
          ->  Nested Loop Semi Join  (cost=2253.95..3039.76 rows=59 width=39) (actual time=1.888..2.356 rows=50 loops=1)
                Buffers: shared hit=913
                ->  Sort  (cost=2253.10..2253.24 rows=59 width=39) (actual time=1.778..1.789 rows=55 loops=1)
                      Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'go'::text) ELSE GREATEST(similarity(search_terms_3.name, 'go'::text), similarity(search_terms_3.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                      Sort Method: quicksort  Memory: 44kB
                      Buffers: shared hit=53
                      ->  GroupAggregate  (cost=2247.53..2251.36 rows=59 width=39) (actual time=0.624..1.634 rows=437 loops=1)
                            Group Key: search_terms_3.package_id, search_terms_3.name
                            Buffers: shared hit=53
                            ->  Sort  (cost=2247.53..2247.67 rows=59 width=68) (actual time=0.585..0.621 rows=452 loops=1)
                                  Sort Key: search_terms_3.package_id, search_terms_3.name
                                  Sort Method: quicksort  Memory: 51kB
                                  Buffers: shared hit=53
                                  ->  Append  (cost=9.66..2245.79 rows=59 width=68) (actual time=0.314..0.521 rows=452 loops=1)
                                        Buffers: shared hit=53
                                        ->  Result  (cost=9.66..281.97 rows=50 width=68) (actual time=0.314..0.471 rows=452 loops=1)
                                              One-Time Filter: (NOT (InitPlan 2).col1)
                                              Buffers: shared hit=53
                                              InitPlan 2
                                                ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=0.266..0.266 rows=1 loops=1)
                                                      Buffers: shared hit=28
                                              ->  Bitmap Heap Scan on search_terms search_terms_3  (cost=9.66..281.97 rows=50 width=68) (actual time=0.046..0.153 rows=452 loops=1)
                                                    Recheck Cond: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                                    Filter: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                                    Heap Blocks: exact=15
                                                    Buffers: shared hit=25
                                                    ->  BitmapOr  (cost=9.64..9.64 rows=78 width=0) (actual time=0.039..0.039 rows=0 loops=1)
                                                          Buffers: shared hit=10
                                                          ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.81 rows=39 width=0) (actual time=0.017..0.017 rows=452 loops=1)
                                                                Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                                                Buffers: shared hit=5
                                                          ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.81 rows=39 width=0) (actual time=0.021..0.021 rows=452 loops=1)
                                                                Index Cond: ((lower(attr_path) >= 'go'::text) AND (lower(attr_path) < 'gp'::text))
                                                                Buffers: shared hit=5
                                        ->  Result  (cost=8.88..16.76 rows=2 width=68) (actual time=0.001..0.002 rows=0 loops=1)
                                              One-Time Filter: (InitPlan 3).col1
                                              InitPlan 3
                                                ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                              ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=68) (never executed)
                                                    Recheck Cond: ((lower(name) = 'go'::text) OR (lower(attr_path) = 'go'::text))
                                                    ->  BitmapOr  (cost=8.86..8.86 rows=2 width=0) (never executed)
                                                          ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                                Index Cond: (lower(name) = 'go'::text)
                                                          ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                                Index Cond: (lower(attr_path) = 'go'::text)
                                        ->  Result  (cost=29.61..33.63 rows=1 width=68) (actual time=0.001..0.002 rows=0 loops=1)
                                              One-Time Filter: (InitPlan 4).col1
                                              InitPlan 4
                                                ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                              ->  Bitmap Heap Scan on search_terms search_terms_5  (cost=29.61..33.63 rows=1 width=68) (never executed)
                                                    Recheck Cond: (((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text)) AND ((name = attr_path) IS FALSE))
                                                    Filter: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                                    ->  BitmapAnd  (cost=29.59..29.59 rows=1 width=0) (never executed)
                                                          ->  BitmapOr  (cost=9.62..9.62 rows=78 width=0) (never executed)
                                                                ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.81 rows=39 width=0) (never executed)
                                                                      Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                                                ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.81 rows=39 width=0) (never executed)
                                                                      Index Cond: ((lower(attr_path) >= 'go'::text) AND (lower(attr_path) < 'gp'::text))
                                                          ->  Bitmap Index Scan on search_terms_alias_idx  (cost=0.00..19.71 rows=688 width=0) (never executed)
                                        ->  Subquery Scan on "*SELECT* 4"  (cost=106.89..212.72 rows=2 width=68) (actual time=0.005..0.006 rows=0 loops=1)
                                              ->  Limit  (cost=106.89..212.70 rows=2 width=72) (actual time=0.005..0.006 rows=0 loops=1)
                                                    InitPlan 5
                                                      ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                                    ->  Incremental Sort  (cost=106.87..212.68 rows=2 width=72) (actual time=0.004..0.005 rows=0 loops=1)
                                                          Sort Key: ((lower(search_terms_6.name) <-> 'go'::text)), search_terms_6.name
                                                          Presorted Key: ((lower(search_terms_6.name) <-> 'go'::text))
                                                          Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                                          ->  Result  (cost=1.14..212.59 rows=1 width=72) (actual time=0.000..0.001 rows=0 loops=1)
                                                                One-Time Filter: (InitPlan 5).col1
                                                                ->  Nested Loop Semi Join  (cost=1.14..212.59 rows=1 width=68) (never executed)
                                                                      ->  Index Scan using search_terms_top_level_name_knn_idx on search_terms search_terms_6  (cost=0.28..16.34 rows=3 width=68) (never executed)
                                                                            Index Cond: (lower(name) ~~ 'go%'::text)
                                                                            Order By: (lower(name) <-> 'go'::text)
                                                                      ->  Nested Loop  (cost=0.86..91.76 rows=15 width=4) (never executed)
                                                                            ->  Index Scan using versions_semver_idx on versions ve_2  (cost=0.43..66.18 rows=32 width=8) (never executed)
                                                                                  Index Cond: (package_id = search_terms_6.package_id)
                                                                            ->  Index Only Scan using variants_identity_key on variants va_2  (cost=0.43..0.78 rows=2 width=4) (never executed)
                                                                                  Index Cond: ((version_id = ve_2.id) AND (system = 'aarch64-darwin'::text))
                                                                                  Heap Fetches: 0
                                        ->  Subquery Scan on "*SELECT* 5"  (cost=1700.36..1700.41 rows=4 width=68) (actual time=0.002..0.004 rows=0 loops=1)
                                              ->  Limit  (cost=1700.36..1700.37 rows=4 width=72) (actual time=0.002..0.003 rows=0 loops=1)
                                                    InitPlan 6
                                                      ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                                    ->  Sort  (cost=1700.34..1700.35 rows=4 width=72) (actual time=0.002..0.003 rows=0 loops=1)
                                                          Sort Key: ((lower(search_terms_7.name) <-> 'go'::text)), search_terms_7.name
                                                          Sort Method: quicksort  Memory: 25kB
                                                          ->  Result  (cost=1.28..1700.30 rows=4 width=72) (actual time=0.001..0.001 rows=0 loops=1)
                                                                One-Time Filter: (InitPlan 6).col1
                                                                ->  Nested Loop Semi Join  (cost=1.28..1700.28 rows=4 width=68) (never executed)
                                                                      ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_7  (cost=0.42..17.86 rows=22 width=68) (never executed)
                                                                            Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                                                            Filter: ((top_level_attr IS NULL) AND ((name = attr_path) IS TRUE) AND (lower(name) ~~ 'go%'::text))
                                                                      ->  Nested Loop  (cost=0.86..90.59 rows=15 width=4) (never executed)
                                                                            ->  Index Scan using versions_semver_idx on versions ve_3  (cost=0.43..65.00 rows=32 width=8) (never executed)
                                                                                  Index Cond: (package_id = search_terms_7.package_id)
                                                                            ->  Index Only Scan using variants_identity_key on variants va_3  (cost=0.43..0.78 rows=2 width=4) (never executed)
                                                                                  Index Cond: ((version_id = ve_3.id) AND (system = 'aarch64-darwin'::text))
                                                                                  Heap Fetches: 0
                ->  Nested Loop  (cost=0.86..88.67 rows=15 width=4) (actual time=0.010..0.010 rows=1 loops=55)
                      Buffers: shared hit=860
                      ->  Index Scan using versions_semver_idx on versions ve_1  (cost=0.43..63.08 rows=32 width=8) (actual time=0.002..0.003 rows=3 loops=55)
                            Index Cond: (package_id = search_terms_3.package_id)
                            Buffers: shared hit=222
                      ->  Index Only Scan using variants_identity_key on variants va_1  (cost=0.43..0.78 rows=2 width=4) (actual time=0.002..0.002 rows=0 loops=147)
                            Index Cond: ((version_id = ve_1.id) AND (system = 'aarch64-darwin'::text))
                            Heap Fetches: 38
                            Buffers: shared hit=638
  ->  Sort  (cost=1630.39..1630.64 rows=100 width=44) (actual time=2.440..2.445 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=913
        ->  GroupAggregate  (cost=1625.06..1627.06 rows=100 width=44) (actual time=2.405..2.426 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=913
              ->  Sort  (cost=1625.06..1625.31 rows=100 width=42) (actual time=2.401..2.406 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 26kB
                    Buffers: shared hit=913
                    ->  Append  (cost=0.00..1621.74 rows=100 width=42) (actual time=1.891..2.393 rows=50 loops=1)
                          Buffers: shared hit=913
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=1.891..2.369 rows=50 loops=1)
                                Buffers: shared hit=913
                          ->  Subquery Scan on fuzzy  (cost=939.07..1620.24 rows=50 width=39) (actual time=0.016..0.018 rows=0 loops=1)
                                ->  Limit  (cost=939.07..1619.74 rows=50 width=39) (actual time=0.016..0.018 rows=0 loops=1)
                                      ->  Nested Loop Semi Join  (cost=939.07..1619.74 rows=50 width=39) (actual time=0.015..0.017 rows=0 loops=1)
                                            ->  Sort  (cost=938.21..938.33 rows=50 width=39) (actual time=0.015..0.016 rows=0 loops=1)
                                                  Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'go'::text) ELSE GREATEST(similarity(search_terms.name, 'go'::text), similarity(search_terms.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                                  Sort Method: quicksort  Memory: 25kB
                                                  InitPlan 8
                                                    ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.008..0.008 rows=1 loops=1)
                                                          ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.004 rows=50 loops=1)
                                                  ->  GroupAggregate  (cost=932.41..935.66 rows=50 width=39) (actual time=0.012..0.012 rows=0 loops=1)
                                                        Group Key: search_terms.package_id, search_terms.name
                                                        ->  Sort  (cost=932.41..932.54 rows=50 width=68) (actual time=0.011..0.012 rows=0 loops=1)
                                                              Sort Key: search_terms.package_id, search_terms.name
                                                              Sort Method: quicksort  Memory: 25kB
                                                              ->  Result  (cost=749.24..931.00 rows=50 width=68) (actual time=0.009..0.010 rows=0 loops=1)
                                                                    One-Time Filter: ((InitPlan 8).col1 < 50)
                                                                    ->  Bitmap Heap Scan on search_terms  (cost=749.24..931.00 rows=50 width=68) (never executed)
                                                                          Recheck Cond: ((name % 'go'::text) OR (attr_path % 'go'::text))
                                                                          Filter: ((lower(name) !~~ 'go%'::text) AND (lower(attr_path) !~~ 'go%'::text))
                                                                          ->  BitmapOr  (cost=749.24..749.24 rows=50 width=0) (never executed)
                                                                                ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..374.61 rows=25 width=0) (never executed)
                                                                                      Index Cond: (name % 'go'::text)
                                                                                ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..374.61 rows=25 width=0) (never executed)
                                                                                      Index Cond: (attr_path % 'go'::text)
                                            ->  Nested Loop  (cost=0.86..89.11 rows=15 width=4) (never executed)
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..63.52 rows=32 width=8) (never executed)
                                                        Index Cond: (package_id = search_terms.package_id)
                                                  ->  Index Only Scan using variants_identity_key on variants va  (cost=0.43..0.78 rows=2 width=4) (never executed)
                                                        Index Cond: ((version_id = ve.id) AND (system = 'aarch64-darwin'::text))
                                                        Heap Fetches: 0
Planning:
  Buffers: shared hit=120
Planning Time: 18.034 ms
Execution Time: 2.710 ms
```

### batched fetch, latest — q=go, system=aarch64-darwin (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35234,35238,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35206,35210,35240,35245,35248,35250,35185,35213,35231,35251,35260,35261,35266,35273,35304,35376,35378,35384,35390,35392,35400,35401,35408,35437,35439,35516,35520","aarch64-darwin"]` — Execution Time: 6.126 ms

```
Limit  (cost=1234.85..31485.42 rows=50 width=1376) (actual time=2.180..6.014 rows=50 loops=1)
  Buffers: shared hit=9371
  ->  Unique  (cost=1234.85..31485.42 rows=50 width=1376) (actual time=2.179..6.009 rows=50 loops=1)
        Buffers: shared hit=9371
        ->  Incremental Sort  (cost=1234.85..31483.69 rows=690 width=1376) (actual time=2.178..5.971 rows=179 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 6  Sort Method: quicksort  Average Memory: 56kB  Peak Memory: 56kB
              Buffers: shared hit=9371
              ->  Nested Loop  (cost=617.73..31461.01 rows=690 width=1376) (actual time=1.193..5.820 rows=181 loops=1)
                    Buffers: shared hit=9371
                    ->  Nested Loop  (cost=617.45..31255.70 rows=690 width=1321) (actual time=1.188..5.580 rows=181 loops=1)
                          Buffers: shared hit=8828
                          ->  Nested Loop  (cost=617.02..30904.15 rows=690 width=338) (actual time=1.181..5.223 rows=181 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                Buffers: shared hit=8104
                                ->  Nested Loop  (cost=616.59..30828.55 rows=50 width=53) (actual time=1.177..4.948 rows=50 loops=1)
                                      Buffers: shared hit=7765
                                      ->  Nested Loop  (cost=616.17..30806.32 rows=50 width=30) (actual time=1.172..4.843 rows=50 loops=1)
                                            Buffers: shared hit=7565
                                            ->  Nested Loop  (cost=615.74..30788.35 rows=50 width=12) (actual time=1.165..4.658 rows=50 loops=1)
                                                  Buffers: shared hit=7365
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.007..0.013 rows=50 loops=1)
                                                  ->  Limit  (cost=615.73..615.74 rows=1 width=24) (actual time=0.092..0.093 rows=1 loops=50)
                                                        Buffers: shared hit=7365
                                                        ->  Sort  (cost=615.73..615.77 rows=15 width=24) (actual time=0.092..0.092 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=7365
                                                              ->  Nested Loop  (cost=0.86..615.66 rows=15 width=24) (actual time=0.015..0.088 rows=11 loops=50)
                                                                    Buffers: shared hit=7365
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.003..0.008 rows=13 loops=50)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Rows Removed by Filter: 0
                                                                          Buffers: shared hit=245
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..10.60 rows=2 width=8) (actual time=0.002..0.002 rows=1 loops=636)
                                                                          Index Cond: ((version_id = versions_1.id) AND (system = 'aarch64-darwin'::text))
                                                                          Buffers: shared hit=2480
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..10.60 rows=2 width=0) (actual time=0.002..0.002 rows=1 loops=572)
                                                                            Index Cond: ((version_id = versions_1.id) AND (system = 'aarch64-darwin'::text))
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=2297
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=572)
                                                                            Buffers: shared hit=2334
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=572)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=2334
                                            ->  Memoize  (cost=0.44..8.46 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Cache Key: versions_1.id
                                                  Cache Mode: logical
                                                  Hits: 0  Misses: 50  Evictions: 0  Overflows: 0  Memory Usage: 6kB
                                                  Buffers: shared hit=200
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=50)
                                                        Index Cond: (id = versions_1.id)
                                                        Buffers: shared hit=200
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=200
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.34 rows=14 width=297) (actual time=0.002..0.004 rows=4 loops=50)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=339
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=181)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=724
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=181)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=543
Planning:
  Buffers: shared hit=115
Planning Time: 14.222 ms
Execution Time: 6.126 ms
```

### ranked terms — q=python, system=aarch64-darwin

Parameters: `["python","python","aarch64-darwin"]` — Execution Time: 46.621 ms

```
Limit  (cost=40578.96..40579.08 rows=50 width=44) (actual time=46.322..46.350 rows=50 loops=1)
  Buffers: shared hit=6439
  CTE breadth
    ->  Aggregate  (cost=790.14..790.15 rows=1 width=1) (actual time=5.506..5.507 rows=1 loops=1)
          Buffers: shared hit=396
          ->  Limit  (cost=0.42..665.14 rows=10000 width=4) (actual time=0.019..4.878 rows=10000 loops=1)
                Buffers: shared hit=396
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..4729.23 rows=71140 width=4) (actual time=0.018..4.064 rows=10000 loops=1)
                      Index Cond: ((lower(name) >= 'python'::text) AND (lower(name) < 'pythoo'::text))
                      Filter: (lower(name) ~~ 'python%'::text)
                      Buffers: shared hit=396
  CTE prefix
    ->  Limit  (cost=31225.85..33016.97 rows=50 width=39) (actual time=44.082..45.697 rows=50 loops=1)
          Buffers: shared hit=6439
          ->  Nested Loop Semi Join  (cost=31225.85..250852.96 rows=6131 width=39) (actual time=44.081..45.691 rows=50 loops=1)
                Buffers: shared hit=6439
                ->  Sort  (cost=31224.99..31255.65 rows=12262 width=39) (actual time=44.043..44.062 rows=50 loops=1)
                      Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'python'::text) ELSE GREATEST(similarity(search_terms_3.name, 'python'::text), similarity(search_terms_3.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                      Sort Method: quicksort  Memory: 36kB
                      Buffers: shared hit=5920
                      ->  HashAggregate  (cost=30269.67..30392.29 rows=12262 width=39) (actual time=43.909..43.993 rows=197 loops=1)
                            Group Key: search_terms_3.package_id, search_terms_3.name
                            Batches: 1  Memory Usage: 433kB
                            Buffers: shared hit=5920
                            ->  Append  (cost=0.02..23832.17 rows=122619 width=68) (actual time=5.535..43.014 rows=239 loops=1)
                                  Buffers: shared hit=5920
                                  ->  Result  (cost=0.02..7993.30 rows=122183 width=68) (actual time=5.510..5.512 rows=0 loops=1)
                                        One-Time Filter: (NOT (InitPlan 2).col1)
                                        Buffers: shared hit=396
                                        InitPlan 2
                                          ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=5.508..5.509 rows=1 loops=1)
                                                Buffers: shared hit=396
                                        ->  Seq Scan on search_terms search_terms_3  (cost=0.02..7993.30 rows=122183 width=68) (never executed)
                                              Filter: ((lower(name) ~~ 'python%'::text) OR (lower(attr_path) ~~ 'python%'::text))
                                  ->  Result  (cost=8.88..16.76 rows=2 width=68) (actual time=0.023..0.029 rows=15 loops=1)
                                        One-Time Filter: (InitPlan 3).col1
                                        Buffers: shared hit=7
                                        InitPlan 3
                                          ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.001..0.001 rows=1 loops=1)
                                        ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=68) (actual time=0.020..0.023 rows=15 loops=1)
                                              Recheck Cond: ((lower(name) = 'python'::text) OR (lower(attr_path) = 'python'::text))
                                              Heap Blocks: exact=1
                                              Buffers: shared hit=7
                                              ->  BitmapOr  (cost=8.86..8.86 rows=2 width=0) (actual time=0.014..0.015 rows=0 loops=1)
                                                    Buffers: shared hit=6
                                                    ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.008..0.008 rows=15 loops=1)
                                                          Index Cond: (lower(name) = 'python'::text)
                                                          Buffers: shared hit=3
                                                    ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.005..0.005 rows=1 loops=1)
                                                          Index Cond: (lower(attr_path) = 'python'::text)
                                                          Buffers: shared hit=3
                                  ->  Result  (cost=0.30..49.58 rows=334 width=68) (actual time=0.269..0.439 rows=166 loops=1)
                                        One-Time Filter: (InitPlan 4).col1
                                        Buffers: shared hit=156
                                        InitPlan 4
                                          ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                        ->  Index Scan using search_terms_alias_idx on search_terms search_terms_5  (cost=0.30..49.58 rows=334 width=68) (actual time=0.267..0.418 rows=166 loops=1)
                                              Filter: ((lower(name) ~~ 'python%'::text) OR (lower(attr_path) ~~ 'python%'::text))
                                              Rows Removed by Filter: 429
                                              Buffers: shared hit=156
                                  ->  Subquery Scan on "*SELECT* 4"  (cost=167.23..8468.10 rows=50 width=68) (actual time=1.238..1.244 rows=8 loops=1)
                                        Buffers: shared hit=433
                                        ->  Limit  (cost=167.23..8467.60 rows=50 width=72) (actual time=1.237..1.241 rows=8 loops=1)
                                              Buffers: shared hit=433
                                              InitPlan 5
                                                ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                              ->  Incremental Sort  (cost=167.21..260964.79 rows=1571 width=72) (actual time=1.236..1.239 rows=8 loops=1)
                                                    Sort Key: ((lower(search_terms_6.name) <-> 'python'::text)), search_terms_6.name
                                                    Presorted Key: ((lower(search_terms_6.name) <-> 'python'::text))
                                                    Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                                    Buffers: shared hit=433
                                                    ->  Result  (cost=1.14..260894.09 rows=1571 width=72) (actual time=0.346..1.223 rows=8 loops=1)
                                                          One-Time Filter: (InitPlan 5).col1
                                                          Buffers: shared hit=433
                                                          ->  Nested Loop Semi Join  (cost=1.14..260886.24 rows=1571 width=68) (actual time=0.342..1.200 rows=8 loops=1)
                                                                Buffers: shared hit=433
                                                                ->  Index Scan using search_terms_top_level_name_knn_idx on search_terms search_terms_6  (cost=0.28..12355.26 rows=8549 width=68) (actual time=0.313..0.892 rows=13 loops=1)
                                                                      Index Cond: (lower(name) ~~ 'python%'::text)
                                                                      Rows Removed by Index Recheck: 13
                                                                      Order By: (lower(name) <-> 'python'::text)
                                                                      Buffers: shared hit=195
                                                                ->  Nested Loop  (cost=0.86..34.31 rows=15 width=4) (actual time=0.023..0.023 rows=1 loops=13)
                                                                      Buffers: shared hit=238
                                                                      ->  Index Scan using versions_package_version_key on versions ve_2  (cost=0.43..8.73 rows=32 width=8) (actual time=0.004..0.005 rows=3 loops=13)
                                                                            Index Cond: (package_id = search_terms_6.package_id)
                                                                            Buffers: shared hit=54
                                                                      ->  Index Only Scan using variants_identity_key on variants va_2  (cost=0.43..0.78 rows=2 width=4) (actual time=0.005..0.005 rows=0 loops=44)
                                                                            Index Cond: ((version_id = ve_2.id) AND (system = 'aarch64-darwin'::text))
                                                                            Heap Fetches: 3
                                                                            Buffers: shared hit=184
                                  ->  Subquery Scan on "*SELECT* 5"  (cost=132.31..6691.33 rows=50 width=68) (actual time=33.297..35.763 rows=50 loops=1)
                                        Buffers: shared hit=4928
                                        ->  Limit  (cost=132.31..6690.83 rows=50 width=72) (actual time=33.296..35.754 rows=50 loops=1)
                                              Buffers: shared hit=4928
                                              InitPlan 6
                                                ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.001..0.001 rows=1 loops=1)
                                              ->  Incremental Sort  (cost=132.29..1504394.85 rows=11468 width=72) (actual time=33.294..35.747 rows=50 loops=1)
                                                    Sort Key: ((lower(search_terms_7.name) <-> 'python'::text)), search_terms_7.name
                                                    Presorted Key: ((lower(search_terms_7.name) <-> 'python'::text))
                                                    Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 33kB  Peak Memory: 33kB
                                                    Pre-sorted Groups: 4  Sort Methods: top-N heapsort, quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                                    Buffers: shared hit=4928
                                                    ->  Result  (cost=1.14..1503878.79 rows=11468 width=72) (actual time=27.181..35.620 rows=113 loops=1)
                                                          One-Time Filter: (InitPlan 6).col1
                                                          Buffers: shared hit=4928
                                                          ->  Nested Loop Semi Join  (cost=1.14..1503821.45 rows=11468 width=68) (actual time=27.167..35.175 rows=113 loops=1)
                                                                Buffers: shared hit=4928
                                                                ->  Index Scan using search_terms_nested_name_knn_idx on search_terms search_terms_7  (cost=0.28..17740.20 rows=62396 width=68) (actual time=27.123..27.685 rows=170 loops=1)
                                                                      Index Cond: (lower(name) ~~ 'python%'::text)
                                                                      Rows Removed by Index Recheck: 12
                                                                      Order By: (lower(name) <-> 'python'::text)
                                                                      Buffers: shared hit=2919
                                                                ->  Nested Loop  (cost=0.86..28.05 rows=15 width=4) (actual time=0.044..0.044 rows=1 loops=170)
                                                                      Buffers: shared hit=2009
                                                                      ->  Index Scan using versions_package_version_key on versions ve_3  (cost=0.43..2.47 rows=32 width=8) (actual time=0.004..0.005 rows=2 loops=170)
                                                                            Index Cond: (package_id = search_terms_7.package_id)
                                                                            Buffers: shared hit=684
                                                                      ->  Index Only Scan using variants_identity_key on variants va_3  (cost=0.43..0.78 rows=2 width=4) (actual time=0.021..0.021 rows=0 loops=307)
                                                                            Index Cond: ((version_id = ve_3.id) AND (system = 'aarch64-darwin'::text))
                                                                            Heap Fetches: 37
                                                                            Buffers: shared hit=1325
                ->  Nested Loop  (cost=0.86..32.71 rows=15 width=4) (actual time=0.032..0.032 rows=1 loops=50)
                      Buffers: shared hit=519
                      ->  Index Scan using versions_package_version_key on versions ve_1  (cost=0.43..7.12 rows=32 width=8) (actual time=0.003..0.004 rows=2 loops=50)
                            Index Cond: (package_id = search_terms_3.package_id)
                            Buffers: shared hit=201
                      ->  Index Only Scan using variants_identity_key on variants va_1  (cost=0.43..0.78 rows=2 width=4) (actual time=0.018..0.018 rows=1 loops=75)
                            Index Cond: ((version_id = ve_1.id) AND (system = 'aarch64-darwin'::text))
                            Heap Fetches: 7
                            Buffers: shared hit=318
  ->  Sort  (cost=6771.83..6772.08 rows=100 width=44) (actual time=46.320..46.327 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=6439
        ->  GroupAggregate  (cost=6766.51..6768.51 rows=100 width=44) (actual time=45.772..46.306 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=6439
              ->  Sort  (cost=6766.51..6766.76 rows=100 width=42) (actual time=45.768..45.776 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=6439
                    ->  Append  (cost=0.00..6763.19 rows=100 width=42) (actual time=44.085..45.758 rows=50 loops=1)
                          Buffers: shared hit=6439
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=44.084..45.705 rows=50 loops=1)
                                Buffers: shared hit=6439
                          ->  Subquery Scan on fuzzy  (cost=4372.78..6761.69 rows=50 width=39) (actual time=0.042..0.045 rows=0 loops=1)
                                ->  Limit  (cost=4372.78..6761.19 rows=50 width=39) (actual time=0.041..0.045 rows=0 loops=1)
                                      ->  Nested Loop Semi Join  (cost=4372.78..66471.36 rows=1300 width=39) (actual time=0.040..0.044 rows=0 loops=1)
                                            ->  Sort  (cost=4371.93..4378.43 rows=2601 width=39) (actual time=0.040..0.043 rows=0 loops=1)
                                                  Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'python'::text) ELSE GREATEST(similarity(search_terms.name, 'python'::text), similarity(search_terms.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                                  Sort Method: quicksort  Memory: 25kB
                                                  InitPlan 8
                                                    ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.010..0.010 rows=1 loops=1)
                                                          ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.004 rows=50 loops=1)
                                                  ->  HashAggregate  (cost=4197.24..4223.25 rows=2601 width=39) (actual time=0.025..0.027 rows=0 loops=1)
                                                        Group Key: search_terms.package_id, search_terms.name
                                                        Batches: 1  Memory Usage: 121kB
                                                        ->  Result  (cost=879.30..4060.69 rows=2601 width=68) (actual time=0.012..0.013 rows=0 loops=1)
                                                              One-Time Filter: ((InitPlan 8).col1 < 50)
                                                              ->  Bitmap Heap Scan on search_terms  (cost=879.30..4060.69 rows=2601 width=68) (never executed)
                                                                    Recheck Cond: ((name % 'python'::text) OR (attr_path % 'python'::text))
                                                                    Filter: ((lower(name) !~~ 'python%'::text) AND (lower(attr_path) !~~ 'python%'::text))
                                                                    ->  BitmapOr  (cost=879.30..879.30 rows=5082 width=0) (never executed)
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..439.00 rows=2541 width=0) (never executed)
                                                                                Index Cond: (name % 'python'::text)
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..439.00 rows=2542 width=0) (never executed)
                                                                                Index Cond: (attr_path % 'python'::text)
                                            ->  Nested Loop  (cost=0.86..43.89 rows=15 width=4) (never executed)
                                                  ->  Index Scan using versions_package_version_key on versions ve  (cost=0.43..18.30 rows=32 width=8) (never executed)
                                                        Index Cond: (package_id = search_terms.package_id)
                                                  ->  Index Only Scan using variants_identity_key on variants va  (cost=0.43..0.78 rows=2 width=4) (never executed)
                                                        Index Cond: ((version_id = ve.id) AND (system = 'aarch64-darwin'::text))
                                                        Heap Fetches: 0
Planning:
  Buffers: shared hit=120
Planning Time: 17.668 ms
Execution Time: 46.621 ms
```

### batched fetch, latest — q=python, system=aarch64-darwin (50 hits)

Parameters: `["113125,113133,113128,113132,113130,182211,113134,144106,155721,167017,174570,180462,121545,130664,140883,152209,163594,171515,171824,172863,173875,174633,174660,176746,177119,178411,179650,180538,180567,180568,116643,117098,118655,120597,121591,121630,121667,121668,121720,124993,125518,127309,129596,130724,130769,130812,130813,130824,130873,131908","aarch64-darwin"]` — Execution Time: 5.314 ms

```
Limit  (cost=1234.85..31485.42 rows=50 width=1376) (actual time=2.453..5.156 rows=49 loops=1)
  Buffers: shared hit=7846
  ->  Unique  (cost=1234.85..31485.42 rows=50 width=1376) (actual time=2.452..5.150 rows=49 loops=1)
        Buffers: shared hit=7846
        ->  Incremental Sort  (cost=1234.85..31483.69 rows=690 width=1376) (actual time=2.452..5.111 rows=188 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 6  Sort Method: quicksort  Average Memory: 70kB  Peak Memory: 70kB
              Buffers: shared hit=7846
              ->  Nested Loop  (cost=617.73..31461.01 rows=690 width=1376) (actual time=0.818..4.956 rows=188 loops=1)
                    Buffers: shared hit=7846
                    ->  Nested Loop  (cost=617.45..31255.70 rows=690 width=1321) (actual time=0.812..4.648 rows=188 loops=1)
                          Buffers: shared hit=7282
                          ->  Nested Loop  (cost=617.02..30904.15 rows=690 width=338) (actual time=0.806..4.274 rows=188 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                Buffers: shared hit=6530
                                ->  Nested Loop  (cost=616.59..30828.55 rows=50 width=53) (actual time=0.802..4.069 rows=49 loops=1)
                                      Buffers: shared hit=6298
                                      ->  Nested Loop  (cost=616.17..30806.32 rows=50 width=30) (actual time=0.796..3.922 rows=49 loops=1)
                                            Buffers: shared hit=6102
                                            ->  Nested Loop  (cost=615.74..30788.35 rows=50 width=12) (actual time=0.788..3.760 rows=49 loops=1)
                                                  Buffers: shared hit=5906
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.013 rows=50 loops=1)
                                                  ->  Limit  (cost=615.73..615.74 rows=1 width=24) (actual time=0.075..0.075 rows=1 loops=50)
                                                        Buffers: shared hit=5906
                                                        ->  Sort  (cost=615.73..615.77 rows=15 width=24) (actual time=0.074..0.074 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: quicksort  Memory: 25kB
                                                              Buffers: shared hit=5906
                                                              ->  Nested Loop  (cost=0.86..615.66 rows=15 width=24) (actual time=0.016..0.071 rows=9 loops=50)
                                                                    Buffers: shared hit=5906
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.004..0.008 rows=10 loops=50)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Rows Removed by Filter: 2
                                                                          Buffers: shared hit=227
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..10.60 rows=2 width=8) (actual time=0.002..0.002 rows=1 loops=508)
                                                                          Index Cond: ((version_id = versions_1.id) AND (system = 'aarch64-darwin'::text))
                                                                          Buffers: shared hit=1946
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..10.60 rows=2 width=0) (actual time=0.002..0.002 rows=1 loops=465)
                                                                            Index Cond: ((version_id = versions_1.id) AND (system = 'aarch64-darwin'::text))
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=1862
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=465)
                                                                            Buffers: shared hit=1869
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=465)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=1869
                                            ->  Memoize  (cost=0.44..8.46 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=49)
                                                  Cache Key: versions_1.id
                                                  Cache Mode: logical
                                                  Hits: 0  Misses: 49  Evictions: 0  Overflows: 0  Memory Usage: 6kB
                                                  Buffers: shared hit=196
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=49)
                                                        Index Cond: (id = versions_1.id)
                                                        Buffers: shared hit=196
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=49)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=196
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.34 rows=14 width=297) (actual time=0.001..0.003 rows=4 loops=49)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=232
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=188)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=752
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=188)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=564
Planning:
  Buffers: shared hit=115
Planning Time: 14.344 ms
Execution Time: 5.314 ms
```

### ranked terms — q=hello, system=aarch64-darwin

Parameters: `["hello","hello","aarch64-darwin"]` — Execution Time: 89.530 ms

```
Limit  (cost=4330.86..4330.99 rows=50 width=44) (actual time=89.232..89.259 rows=9 loops=1)
  Buffers: shared hit=1533
  CTE breadth
    ->  Aggregate  (cost=8.76..8.77 rows=1 width=1) (actual time=0.042..0.044 rows=1 loops=1)
          Buffers: shared hit=4
          ->  Limit  (cost=0.42..8.45 rows=25 width=4) (actual time=0.034..0.039 rows=5 loops=1)
                Buffers: shared hit=4
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..8.45 rows=25 width=4) (actual time=0.033..0.038 rows=5 loops=1)
                      Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                      Filter: (lower(name) ~~ 'hello%'::text)
                      Buffers: shared hit=4
  CTE prefix
    ->  Limit  (cost=1946.65..2613.99 rows=50 width=39) (actual time=0.140..0.195 rows=4 loops=1)
          Buffers: shared hit=80
          ->  Nested Loop Semi Join  (cost=1946.65..2720.77 rows=58 width=39) (actual time=0.140..0.194 rows=4 loops=1)
                Buffers: shared hit=80
                ->  Sort  (cost=1945.79..1945.93 rows=58 width=39) (actual time=0.116..0.131 rows=5 loops=1)
                      Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'hello'::text) ELSE GREATEST(similarity(search_terms_3.name, 'hello'::text), similarity(search_terms_3.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                      Sort Method: quicksort  Memory: 25kB
                      Buffers: shared hit=11
                      ->  GroupAggregate  (cost=1940.32..1944.09 rows=58 width=39) (actual time=0.104..0.128 rows=5 loops=1)
                            Group Key: search_terms_3.package_id, search_terms_3.name
                            Buffers: shared hit=11
                            ->  Sort  (cost=1940.32..1940.46 rows=58 width=68) (actual time=0.092..0.107 rows=5 loops=1)
                                  Sort Key: search_terms_3.package_id, search_terms_3.name
                                  Sort Method: quicksort  Memory: 25kB
                                  Buffers: shared hit=11
                                  ->  Append  (cost=8.90..1938.62 rows=58 width=68) (actual time=0.061..0.103 rows=5 loops=1)
                                        Buffers: shared hit=11
                                        ->  Result  (cost=8.90..12.92 rows=50 width=68) (actual time=0.061..0.067 rows=5 loops=1)
                                              One-Time Filter: (NOT (InitPlan 2).col1)
                                              Buffers: shared hit=11
                                              InitPlan 2
                                                ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=0.043..0.044 rows=1 loops=1)
                                                      Buffers: shared hit=4
                                              ->  Bitmap Heap Scan on search_terms search_terms_3  (cost=8.90..12.92 rows=50 width=68) (actual time=0.016..0.019 rows=5 loops=1)
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
                                        ->  Result  (cost=8.88..12.90 rows=1 width=68) (actual time=0.001..0.003 rows=0 loops=1)
                                              One-Time Filter: (InitPlan 4).col1
                                              InitPlan 4
                                                ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.001..0.001 rows=1 loops=1)
                                              ->  Bitmap Heap Scan on search_terms search_terms_5  (cost=8.88..12.90 rows=1 width=68) (never executed)
                                                    Recheck Cond: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                                                    Filter: (((name = attr_path) IS FALSE) AND ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text)))
                                                    ->  BitmapOr  (cost=8.86..8.86 rows=1 width=0) (never executed)
                                                          ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                                Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                                          ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                                Index Cond: ((lower(attr_path) >= 'hello'::text) AND (lower(attr_path) < 'hellp'::text))
                                        ->  Subquery Scan on "*SELECT* 4"  (cost=204.73..204.75 rows=1 width=68) (actual time=0.013..0.016 rows=0 loops=1)
                                              ->  Limit  (cost=204.73..204.74 rows=1 width=72) (actual time=0.013..0.015 rows=0 loops=1)
                                                    InitPlan 5
                                                      ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.001..0.001 rows=1 loops=1)
                                                    ->  Sort  (cost=204.71..204.72 rows=1 width=72) (actual time=0.012..0.013 rows=0 loops=1)
                                                          Sort Key: ((lower(search_terms_6.name) <-> 'hello'::text)), search_terms_6.name
                                                          Sort Method: quicksort  Memory: 25kB
                                                          ->  Result  (cost=1.28..204.70 rows=1 width=72) (actual time=0.003..0.004 rows=0 loops=1)
                                                                One-Time Filter: (InitPlan 5).col1
                                                                ->  Nested Loop Semi Join  (cost=1.28..204.70 rows=1 width=68) (never executed)
                                                                      ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_6  (cost=0.42..8.45 rows=3 width=68) (never executed)
                                                                            Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                                                            Filter: ((top_level_attr IS NOT NULL) AND ((name = attr_path) IS TRUE) AND (lower(name) ~~ 'hello%'::text))
                                                                      ->  Nested Loop  (cost=0.86..91.76 rows=15 width=4) (never executed)
                                                                            ->  Index Scan using versions_semver_idx on versions ve_2  (cost=0.43..66.18 rows=32 width=8) (never executed)
                                                                                  Index Cond: (package_id = search_terms_6.package_id)
                                                                            ->  Index Only Scan using variants_identity_key on variants va_2  (cost=0.43..0.78 rows=2 width=4) (never executed)
                                                                                  Index Cond: ((version_id = ve_2.id) AND (system = 'aarch64-darwin'::text))
                                                                                  Heap Fetches: 0
                                        ->  Subquery Scan on "*SELECT* 5"  (cost=1690.94..1690.99 rows=4 width=68) (actual time=0.008..0.010 rows=0 loops=1)
                                              ->  Limit  (cost=1690.94..1690.95 rows=4 width=72) (actual time=0.008..0.010 rows=0 loops=1)
                                                    InitPlan 6
                                                      ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                                    ->  Sort  (cost=1690.92..1690.93 rows=4 width=72) (actual time=0.007..0.008 rows=0 loops=1)
                                                          Sort Key: ((lower(search_terms_7.name) <-> 'hello'::text)), search_terms_7.name
                                                          Sort Method: quicksort  Memory: 25kB
                                                          ->  Result  (cost=1.28..1690.88 rows=4 width=72) (actual time=0.001..0.001 rows=0 loops=1)
                                                                One-Time Filter: (InitPlan 6).col1
                                                                ->  Nested Loop Semi Join  (cost=1.28..1690.86 rows=4 width=68) (never executed)
                                                                      ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_7  (cost=0.42..8.45 rows=22 width=68) (never executed)
                                                                            Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                                                            Filter: ((top_level_attr IS NULL) AND ((name = attr_path) IS TRUE) AND (lower(name) ~~ 'hello%'::text))
                                                                      ->  Nested Loop  (cost=0.86..90.59 rows=15 width=4) (never executed)
                                                                            ->  Index Scan using versions_semver_idx on versions ve_3  (cost=0.43..65.00 rows=32 width=8) (never executed)
                                                                                  Index Cond: (package_id = search_terms_7.package_id)
                                                                            ->  Index Only Scan using variants_identity_key on variants va_3  (cost=0.43..0.78 rows=2 width=4) (never executed)
                                                                                  Index Cond: ((version_id = ve_3.id) AND (system = 'aarch64-darwin'::text))
                                                                                  Heap Fetches: 0
                ->  Nested Loop  (cost=0.86..88.71 rows=15 width=4) (actual time=0.012..0.012 rows=1 loops=5)
                      Buffers: shared hit=69
                      ->  Index Scan using versions_semver_idx on versions ve_1  (cost=0.43..63.12 rows=32 width=8) (actual time=0.003..0.004 rows=2 loops=5)
                            Index Cond: (package_id = search_terms_3.package_id)
                            Buffers: shared hit=20
                      ->  Index Only Scan using variants_identity_key on variants va_1  (cost=0.43..0.78 rows=2 width=4) (actual time=0.003..0.003 rows=0 loops=11)
                            Index Cond: ((version_id = ve_1.id) AND (system = 'aarch64-darwin'::text))
                            Heap Fetches: 4
                            Buffers: shared hit=49
  ->  Sort  (cost=1708.10..1708.35 rows=100 width=44) (actual time=89.231..89.236 rows=9 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=1533
        ->  GroupAggregate  (cost=1702.78..1704.78 rows=100 width=44) (actual time=89.220..89.228 rows=9 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=1533
              ->  Sort  (cost=1702.78..1703.03 rows=100 width=42) (actual time=89.214..89.220 rows=9 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=1533
                    ->  Append  (cost=0.00..1699.46 rows=100 width=42) (actual time=0.142..89.213 rows=9 loops=1)
                          Buffers: shared hit=1533
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=0.141..0.181 rows=4 loops=1)
                                Buffers: shared hit=80
                          ->  Subquery Scan on fuzzy  (cost=1016.78..1697.96 rows=50 width=39) (actual time=88.256..89.028 rows=5 loops=1)
                                Buffers: shared hit=1453
                                ->  Limit  (cost=1016.78..1697.46 rows=50 width=39) (actual time=88.256..89.027 rows=5 loops=1)
                                      Buffers: shared hit=1453
                                      ->  Nested Loop Semi Join  (cost=1016.78..1697.46 rows=50 width=39) (actual time=88.255..89.024 rows=5 loops=1)
                                            Buffers: shared hit=1453
                                            ->  Sort  (cost=1015.92..1016.05 rows=50 width=39) (actual time=87.310..87.314 rows=9 loops=1)
                                                  Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'hello'::text) ELSE GREATEST(similarity(search_terms.name, 'hello'::text), similarity(search_terms.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                                  Sort Method: quicksort  Memory: 25kB
                                                  Buffers: shared hit=1259
                                                  InitPlan 8
                                                    ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=1)
                                                          ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.001 rows=4 loops=1)
                                                  ->  GroupAggregate  (cost=1010.13..1013.38 rows=50 width=39) (actual time=87.287..87.306 rows=9 loops=1)
                                                        Group Key: search_terms.package_id, search_terms.name
                                                        Buffers: shared hit=1259
                                                        ->  Sort  (cost=1010.13..1010.25 rows=50 width=68) (actual time=87.273..87.276 rows=9 loops=1)
                                                              Sort Key: search_terms.package_id, search_terms.name
                                                              Sort Method: quicksort  Memory: 25kB
                                                              Buffers: shared hit=1259
                                                              ->  Result  (cost=826.96..1008.72 rows=50 width=68) (actual time=40.238..87.264 rows=9 loops=1)
                                                                    One-Time Filter: ((InitPlan 8).col1 < 50)
                                                                    Buffers: shared hit=1259
                                                                    ->  Bitmap Heap Scan on search_terms  (cost=826.96..1008.72 rows=50 width=68) (actual time=40.235..87.256 rows=9 loops=1)
                                                                          Recheck Cond: ((name % 'hello'::text) OR (attr_path % 'hello'::text))
                                                                          Rows Removed by Index Recheck: 17530
                                                                          Filter: ((lower(name) !~~ 'hello%'::text) AND (lower(attr_path) !~~ 'hello%'::text))
                                                                          Rows Removed by Filter: 5
                                                                          Heap Blocks: exact=1039
                                                                          Buffers: shared hit=1259
                                                                          ->  BitmapOr  (cost=826.96..826.96 rows=50 width=0) (actual time=5.333..5.334 rows=0 loops=1)
                                                                                Buffers: shared hit=220
                                                                                ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..413.47 rows=25 width=0) (actual time=2.845..2.845 rows=17544 loops=1)
                                                                                      Index Cond: (name % 'hello'::text)
                                                                                      Buffers: shared hit=110
                                                                                ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..413.47 rows=25 width=0) (actual time=2.487..2.487 rows=17544 loops=1)
                                                                                      Index Cond: (attr_path % 'hello'::text)
                                                                                      Buffers: shared hit=110
                                            ->  Nested Loop  (cost=0.86..89.11 rows=15 width=4) (actual time=0.189..0.189 rows=1 loops=9)
                                                  Buffers: shared hit=194
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..63.52 rows=32 width=8) (actual time=0.006..0.009 rows=4 loops=9)
                                                        Index Cond: (package_id = search_terms.package_id)
                                                        Buffers: shared hit=37
                                                  ->  Index Only Scan using variants_identity_key on variants va  (cost=0.43..0.78 rows=2 width=4) (actual time=0.043..0.043 rows=0 loops=37)
                                                        Index Cond: ((version_id = ve.id) AND (system = 'aarch64-darwin'::text))
                                                        Heap Fetches: 6
                                                        Buffers: shared hit=157
Planning:
  Buffers: shared hit=120
Planning Time: 17.735 ms
Execution Time: 89.530 ms
```

### batched fetch, latest — q=hello, system=aarch64-darwin (9 hits)

Parameters: `["51324,51326,51325,51327,51329,51319,51323,54432,42681","aarch64-darwin"]` — Execution Time: 0.913 ms

```
Limit  (cost=1179.99..5680.15 rows=9 width=1376) (actual time=0.783..0.812 rows=9 loops=1)
  Buffers: shared hit=876
  ->  Unique  (cost=1179.99..5680.15 rows=9 width=1376) (actual time=0.782..0.810 rows=9 loops=1)
        Buffers: shared hit=876
        ->  Incremental Sort  (cost=1179.99..5679.84 rows=124 width=1376) (actual time=0.781..0.801 rows=36 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 62kB  Peak Memory: 62kB
              Buffers: shared hit=876
              ->  Nested Loop  (cost=617.73..5675.76 rows=124 width=1376) (actual time=0.117..0.755 rows=36 loops=1)
                    Buffers: shared hit=876
                    ->  Nested Loop  (cost=617.45..5638.86 rows=124 width=1321) (actual time=0.113..0.684 rows=36 loops=1)
                          Buffers: shared hit=768
                          ->  Nested Loop  (cost=617.02..5575.69 rows=124 width=338) (actual time=0.106..0.581 rows=36 loops=1)
                                Join Filter: (variants.version_id = versions_1.id)
                                Buffers: shared hit=624
                                ->  Nested Loop  (cost=616.59..5562.08 rows=9 width=53) (actual time=0.103..0.458 rows=9 loops=1)
                                      Buffers: shared hit=566
                                      ->  Nested Loop  (cost=616.17..5558.08 rows=9 width=30) (actual time=0.098..0.435 rows=9 loops=1)
                                            Buffers: shared hit=530
                                            ->  Nested Loop  (cost=615.74..5541.91 rows=9 width=12) (actual time=0.090..0.402 rows=9 loops=1)
                                                  Buffers: shared hit=494
                                                  ->  Function Scan on unnest hits  (cost=0.00..0.09 rows=9 width=12) (actual time=0.006..0.007 rows=9 loops=1)
                                                  ->  Limit  (cost=615.73..615.74 rows=1 width=24) (actual time=0.043..0.043 rows=1 loops=9)
                                                        Buffers: shared hit=494
                                                        ->  Sort  (cost=615.73..615.77 rows=15 width=24) (actual time=0.043..0.043 rows=1 loops=9)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: quicksort  Memory: 25kB
                                                              Buffers: shared hit=494
                                                              ->  Nested Loop  (cost=0.86..615.66 rows=15 width=24) (actual time=0.017..0.039 rows=4 loops=9)
                                                                    Buffers: shared hit=494
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.006..0.007 rows=4 loops=9)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Buffers: shared hit=36
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..10.60 rows=2 width=8) (actual time=0.002..0.002 rows=1 loops=38)
                                                                          Index Cond: ((version_id = versions_1.id) AND (system = 'aarch64-darwin'::text))
                                                                          Buffers: shared hit=153
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..10.60 rows=2 width=0) (actual time=0.002..0.002 rows=1 loops=37)
                                                                            Index Cond: ((version_id = versions_1.id) AND (system = 'aarch64-darwin'::text))
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=149
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.003..0.003 rows=1 loops=37)
                                                                            Buffers: shared hit=156
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=37)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=156
                                            ->  Memoize  (cost=0.44..8.46 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=9)
                                                  Cache Key: versions_1.id
                                                  Cache Mode: logical
                                                  Hits: 0  Misses: 9  Evictions: 0  Overflows: 0  Memory Usage: 2kB
                                                  Buffers: shared hit=36
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=9)
                                                        Index Cond: (id = versions_1.id)
                                                        Buffers: shared hit=36
                                      ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=9)
                                            Index Cond: (id = versions.package_id)
                                            Buffers: shared hit=36
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.34 rows=14 width=297) (actual time=0.002..0.012 rows=4 loops=9)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=58
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=36)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=144
                    ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=36)
                          Index Cond: (seq = variants.commit_seq)
                          Buffers: shared hit=108
Planning:
  Buffers: shared hit=115
Planning Time: 13.704 ms
Execution Time: 0.913 ms
```

### pick latest version — name=go, system=aarch64-darwin

Parameters: `["go","aarch64-darwin"]` — Execution Time: 4.171 ms

```
Limit  (cost=1607.27..1607.27 rows=1 width=24) (actual time=4.078..4.082 rows=1 loops=1)
  Buffers: shared hit=6595
  ->  Sort  (cost=1607.27..1607.32 rows=22 width=24) (actual time=4.077..4.080 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=6595
        ->  Nested Loop  (cost=204.21..1607.16 rows=22 width=24) (actual time=1.074..4.041 rows=155 loops=1)
              Buffers: shared hit=6595
              ->  Nested Loop  (cost=203.79..1289.87 rows=22 width=27) (actual time=1.052..2.961 rows=155 loops=1)
                    Buffers: shared hit=4577
                    ->  Nested Loop  (cost=203.36..1277.35 rows=22 width=8) (actual time=1.046..2.528 rows=174 loops=1)
                          Buffers: shared hit=3881
                          ->  HashAggregate  (cost=202.93..204.20 rows=127 width=4) (actual time=1.039..1.138 rows=728 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=969
                                ->  Append  (cost=1.28..202.61 rows=127 width=4) (actual time=0.030..0.866 rows=988 loops=1)
                                      Buffers: shared hit=969
                                      ->  Nested Loop  (cost=1.28..83.80 rows=16 width=4) (actual time=0.029..0.714 rows=728 loops=1)
                                            Buffers: shared hit=905
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.023..0.091 rows=192 loops=1)
                                                  Buffers: shared hit=24
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.011..0.012 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'go'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.009..0.055 rows=192 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=20
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.34 rows=14 width=8) (actual time=0.002..0.003 rows=4 loops=192)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=881
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..118.18 rows=111 width=4) (actual time=0.007..0.077 rows=260 loops=1)
                                            Index Cond: (attr_path = 'go'::text)
                                            Buffers: shared hit=64
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=0 loops=728)
                                Index Cond: (id = va.id)
                                Filter: (system = 'aarch64-darwin'::text)
                                Rows Removed by Filter: 1
                                Buffers: shared hit=2912
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.57 rows=1 width=23) (actual time=0.002..0.002 rows=1 loops=174)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=696
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=155)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 155
                    Buffers: shared hit=776
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..10.60 rows=2 width=0) (actual time=0.002..0.002 rows=1 loops=155)
                      Index Cond: ((version_id = versions.id) AND (system = 'aarch64-darwin'::text))
                      Filter: (NOT broken)
                      Buffers: shared hit=620
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=155)
                      Buffers: shared hit=622
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=155)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=622
Planning:
  Buffers: shared hit=94
Planning Time: 10.771 ms
Execution Time: 4.171 ms
```

### pick latest version — name=python, system=aarch64-darwin

Parameters: `["python","aarch64-darwin"]` — Execution Time: 3.065 ms

```
Limit  (cost=1607.27..1607.27 rows=1 width=24) (actual time=2.961..2.964 rows=1 loops=1)
  Buffers: shared hit=5384
  ->  Sort  (cost=1607.27..1607.32 rows=22 width=24) (actual time=2.959..2.962 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=5384
        ->  Nested Loop  (cost=204.21..1607.16 rows=22 width=24) (actual time=0.855..2.933 rows=103 loops=1)
              Buffers: shared hit=5384
              ->  Nested Loop  (cost=203.79..1289.87 rows=22 width=27) (actual time=0.833..2.253 rows=103 loops=1)
                    Buffers: shared hit=4041
                    ->  Nested Loop  (cost=203.36..1277.35 rows=22 width=8) (actual time=0.827..1.977 rows=159 loops=1)
                          Buffers: shared hit=3405
                          ->  HashAggregate  (cost=202.93..204.20 rows=127 width=4) (actual time=0.813..0.888 rows=654 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=787
                                ->  Append  (cost=1.28..202.61 rows=127 width=4) (actual time=0.028..0.686 rows=657 loops=1)
                                      Buffers: shared hit=787
                                      ->  Nested Loop  (cost=1.28..83.80 rows=16 width=4) (actual time=0.027..0.628 rows=654 loops=1)
                                            Buffers: shared hit=782
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.021..0.088 rows=179 loops=1)
                                                  Buffers: shared hit=25
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.012..0.013 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'python'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.007..0.052 rows=179 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=21
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.34 rows=14 width=8) (actual time=0.002..0.002 rows=4 loops=179)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=757
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..118.18 rows=111 width=4) (actual time=0.007..0.008 rows=3 loops=1)
                                            Index Cond: (attr_path = 'python'::text)
                                            Buffers: shared hit=5
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.001..0.001 rows=0 loops=654)
                                Index Cond: (id = va.id)
                                Filter: (system = 'aarch64-darwin'::text)
                                Rows Removed by Filter: 1
                                Buffers: shared hit=2617
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.57 rows=1 width=23) (actual time=0.001..0.001 rows=1 loops=159)
                          Index Cond: (id = variants.version_id)
                          Filter: (NOT prerelease)
                          Rows Removed by Filter: 0
                          Buffers: shared hit=636
              ->  Index Only Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=103)
                    Index Cond: (id = versions.package_id)
                    Heap Fetches: 103
                    Buffers: shared hit=516
              SubPlan 1
                ->  Index Scan using variants_identity_key on variants b  (cost=0.43..10.60 rows=2 width=0) (actual time=0.002..0.002 rows=1 loops=103)
                      Index Cond: ((version_id = versions.id) AND (system = 'aarch64-darwin'::text))
                      Filter: (NOT broken)
                      Buffers: shared hit=412
              SubPlan 2
                ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=103)
                      Buffers: shared hit=415
                      ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=103)
                            Index Cond: (variant_id = variants.id)
                            Filter: (NOT seeded)
                            Rows Removed by Filter: 1
                            Buffers: shared hit=415
Planning:
  Buffers: shared hit=94
Planning Time: 10.664 ms
Execution Time: 3.065 ms
```

