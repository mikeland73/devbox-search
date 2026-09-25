# Serving query plans

Recorded 2026-09-25 against `ep-proud-sound-aue02y8j.c-10.us-east-1.aws.neon.tech` with `node tools/explain-plans.mjs`.
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

Parameters: `["go","go"]` — Execution Time: 2.819 ms

```
Limit  (cost=1114.30..1114.42 rows=50 width=44) (actual time=1.674..1.687 rows=50 loops=1)
  Buffers: shared hit=47
  CTE breadth
    ->  Aggregate  (cost=17.67..17.68 rows=1 width=1) (actual time=0.268..0.268 rows=1 loops=1)
          Buffers: shared hit=24
          ->  Limit  (cost=0.42..17.36 rows=25 width=4) (actual time=0.036..0.238 rows=450 loops=1)
                Buffers: shared hit=24
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..17.36 rows=25 width=4) (actual time=0.035..0.202 rows=450 loops=1)
                      Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                      Filter: (lower(name) ~~ 'go%'::text)
                      Buffers: shared hit=24
  CTE prefix
    ->  Limit  (cost=377.02..377.14 rows=50 width=39) (actual time=1.572..1.583 rows=50 loops=1)
          Buffers: shared hit=47
          ->  Sort  (cost=377.02..377.21 rows=78 width=39) (actual time=1.572..1.579 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'go'::text) ELSE GREATEST(similarity(search_terms_3.name, 'go'::text), similarity(search_terms_3.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: top-N heapsort  Memory: 30kB
                Buffers: shared hit=47
                ->  GroupAggregate  (cost=369.49..374.56 rows=78 width=39) (actual time=0.643..1.492 rows=435 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Buffers: shared hit=47
                      ->  Sort  (cost=369.49..369.69 rows=78 width=69) (actual time=0.604..0.631 rows=450 loops=1)
                            Sort Key: search_terms_3.package_id, search_terms_3.name
                            Sort Method: quicksort  Memory: 51kB
                            Buffers: shared hit=47
                            ->  Append  (cost=9.66..367.04 rows=78 width=69) (actual time=0.326..0.528 rows=450 loops=1)
                                  Buffers: shared hit=47
                                  ->  Result  (cost=9.66..281.95 rows=50 width=69) (actual time=0.325..0.479 rows=450 loops=1)
                                        One-Time Filter: (NOT (InitPlan 2).col1)
                                        Buffers: shared hit=47
                                        InitPlan 2
                                          ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=0.269..0.269 rows=1 loops=1)
                                                Buffers: shared hit=24
                                        ->  Bitmap Heap Scan on search_terms search_terms_3  (cost=9.66..281.95 rows=50 width=69) (actual time=0.054..0.159 rows=450 loops=1)
                                              Recheck Cond: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                              Filter: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                              Heap Blocks: exact=13
                                              Buffers: shared hit=23
                                              ->  BitmapOr  (cost=9.64..9.64 rows=77 width=0) (actual time=0.046..0.047 rows=0 loops=1)
                                                    Buffers: shared hit=10
                                                    ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.81 rows=39 width=0) (actual time=0.024..0.024 rows=450 loops=1)
                                                          Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                                          Buffers: shared hit=5
                                                    ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.81 rows=39 width=0) (actual time=0.021..0.021 rows=450 loops=1)
                                                          Index Cond: ((lower(attr_path) >= 'go'::text) AND (lower(attr_path) < 'gp'::text))
                                                          Buffers: shared hit=5
                                  ->  Result  (cost=8.88..16.76 rows=2 width=69) (actual time=0.002..0.003 rows=0 loops=1)
                                        One-Time Filter: (InitPlan 3).col1
                                        InitPlan 3
                                          ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.001..0.001 rows=1 loops=1)
                                        ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=69) (never executed)
                                              Recheck Cond: ((lower(name) = 'go'::text) OR (lower(attr_path) = 'go'::text))
                                              ->  BitmapOr  (cost=8.86..8.86 rows=2 width=0) (never executed)
                                                    ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                          Index Cond: (lower(name) = 'go'::text)
                                                    ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                          Index Cond: (lower(attr_path) = 'go'::text)
                                  ->  Result  (cost=29.40..33.42 rows=1 width=69) (actual time=0.001..0.002 rows=0 loops=1)
                                        One-Time Filter: (InitPlan 4).col1
                                        InitPlan 4
                                          ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Bitmap Heap Scan on search_terms search_terms_5  (cost=29.40..33.42 rows=1 width=69) (never executed)
                                              Recheck Cond: (((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text)) AND ((name = attr_path) IS FALSE))
                                              Filter: ((lower(name) ~~ 'go%'::text) OR (lower(attr_path) ~~ 'go%'::text))
                                              ->  BitmapAnd  (cost=29.38..29.38 rows=1 width=0) (never executed)
                                                    ->  BitmapOr  (cost=9.62..9.62 rows=77 width=0) (never executed)
                                                          ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.81 rows=39 width=0) (never executed)
                                                                Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                                          ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.81 rows=39 width=0) (never executed)
                                                                Index Cond: ((lower(attr_path) >= 'go'::text) AND (lower(attr_path) < 'gp'::text))
                                                    ->  Bitmap Index Scan on search_terms_alias_idx  (cost=0.00..19.50 rows=646 width=0) (never executed)
                                  ->  Subquery Scan on "*SELECT* 4"  (cost=16.13..16.17 rows=3 width=69) (actual time=0.005..0.006 rows=0 loops=1)
                                        ->  Limit  (cost=16.13..16.14 rows=3 width=73) (actual time=0.004..0.005 rows=0 loops=1)
                                              InitPlan 5
                                                ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                              ->  Sort  (cost=16.11..16.12 rows=3 width=73) (actual time=0.004..0.005 rows=0 loops=1)
                                                    Sort Key: ((lower(search_terms_6.name) <-> 'go'::text)), search_terms_6.name
                                                    Sort Method: quicksort  Memory: 25kB
                                                    ->  Result  (cost=4.31..16.09 rows=3 width=73) (actual time=0.001..0.001 rows=0 loops=1)
                                                          One-Time Filter: (InitPlan 5).col1
                                                          ->  Bitmap Heap Scan on search_terms search_terms_6  (cost=4.31..16.07 rows=3 width=69) (never executed)
                                                                Recheck Cond: ((lower(name) ~~ 'go%'::text) AND ((name = attr_path) IS TRUE) AND (top_level_attr IS NOT NULL))
                                                                ->  Bitmap Index Scan on search_terms_top_level_name_knn_idx  (cost=0.00..4.31 rows=3 width=0) (never executed)
                                                                      Index Cond: (lower(name) ~~ 'go%'::text)
                                  ->  Subquery Scan on "*SELECT* 5"  (cost=18.07..18.35 rows=22 width=69) (actual time=0.003..0.004 rows=0 loops=1)
                                        ->  Limit  (cost=18.07..18.13 rows=22 width=73) (actual time=0.003..0.003 rows=0 loops=1)
                                              InitPlan 6
                                                ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                              ->  Sort  (cost=18.05..18.11 rows=22 width=73) (actual time=0.003..0.003 rows=0 loops=1)
                                                    Sort Key: ((lower(search_terms_7.name) <-> 'go'::text)), search_terms_7.name
                                                    Sort Method: quicksort  Memory: 25kB
                                                    ->  Result  (cost=0.42..17.56 rows=22 width=73) (actual time=0.001..0.001 rows=0 loops=1)
                                                          One-Time Filter: (InitPlan 6).col1
                                                          ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_7  (cost=0.42..17.45 rows=22 width=69) (never executed)
                                                                Index Cond: ((lower(name) >= 'go'::text) AND (lower(name) < 'gp'::text))
                                                                Filter: ((top_level_attr IS NULL) AND ((name = attr_path) IS TRUE) AND (lower(name) ~~ 'go%'::text))
  ->  Sort  (cost=719.48..719.73 rows=100 width=44) (actual time=1.673..1.677 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=47
        ->  GroupAggregate  (cost=714.16..716.16 rows=100 width=44) (actual time=1.631..1.651 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=47
              ->  Sort  (cost=714.16..714.41 rows=100 width=42) (actual time=1.628..1.632 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=47
                    ->  Append  (cost=0.00..710.83 rows=100 width=42) (actual time=1.574..1.613 rows=50 loops=1)
                          Buffers: shared hit=47
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=1.574..1.589 rows=50 loops=1)
                                Buffers: shared hit=47
                          ->  Subquery Scan on fuzzy  (cost=708.71..709.33 rows=50 width=39) (actual time=0.018..0.019 rows=0 loops=1)
                                ->  Limit  (cost=708.71..708.83 rows=50 width=39) (actual time=0.018..0.019 rows=0 loops=1)
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.008..0.008 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.003 rows=50 loops=1)
                                      ->  Sort  (cost=707.57..707.70 rows=50 width=39) (actual time=0.017..0.018 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'go'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'go'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'go%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'go%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'go'::text) ELSE GREATEST(similarity(search_terms.name, 'go'::text), similarity(search_terms.attr_path, 'go'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            ->  GroupAggregate  (cost=702.91..706.16 rows=50 width=39) (actual time=0.015..0.015 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  ->  Sort  (cost=702.91..703.04 rows=50 width=69) (actual time=0.014..0.015 rows=0 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        ->  Result  (cost=519.74..701.50 rows=50 width=69) (actual time=0.009..0.009 rows=0 loops=1)
                                                              One-Time Filter: ((InitPlan 8).col1 < 50)
                                                              ->  Bitmap Heap Scan on search_terms  (cost=519.74..701.50 rows=50 width=69) (never executed)
                                                                    Recheck Cond: ((name % 'go'::text) OR (attr_path % 'go'::text))
                                                                    Filter: ((lower(name) !~~ 'go%'::text) AND (lower(attr_path) !~~ 'go%'::text))
                                                                    ->  BitmapOr  (cost=519.74..519.74 rows=50 width=0) (never executed)
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..259.86 rows=25 width=0) (never executed)
                                                                                Index Cond: (name % 'go'::text)
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..259.86 rows=25 width=0) (never executed)
                                                                                Index Cond: (attr_path % 'go'::text)
Planning:
  Buffers: shared hit=4
Planning Time: 1.358 ms
Execution Time: 2.819 ms
```

### batched fetch, latest — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 12.881 ms

```
Limit  (cost=4130.51..104793.00 rows=50 width=1377) (actual time=4.705..12.772 rows=50 loops=1)
  Buffers: shared hit=22850
  ->  Unique  (cost=4130.51..104793.00 rows=50 width=1377) (actual time=4.704..12.766 rows=50 loops=1)
        Buffers: shared hit=22850
        ->  Incremental Sort  (cost=4130.51..104791.32 rows=672 width=1377) (actual time=4.703..12.729 rows=172 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 6  Sort Method: quicksort  Average Memory: 55kB  Peak Memory: 55kB
              Buffers: shared hit=22850
              ->  Nested Loop  (cost=2076.40..104769.33 rows=672 width=1377) (actual time=3.349..12.582 rows=175 loops=1)
                    Buffers: shared hit=22850
                    ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.015 rows=50 loops=1)
                    ->  Nested Loop  (cost=2076.40..2095.25 rows=13 width=1359) (actual time=0.241..0.251 rows=4 loops=50)
                          Buffers: shared hit=22850
                          ->  Nested Loop  (cost=2076.12..2091.38 rows=13 width=1314) (actual time=0.239..0.246 rows=4 loops=50)
                                Buffers: shared hit=22325
                                ->  Nested Loop  (cost=2075.69..2084.76 rows=13 width=331) (actual time=0.236..0.238 rows=4 loops=50)
                                      Join Filter: (variants.version_id = versions_1.id)
                                      Buffers: shared hit=21625
                                      ->  Nested Loop  (cost=2075.26..2083.32 rows=1 width=45) (actual time=0.234..0.234 rows=1 loops=50)
                                            Buffers: shared hit=21336
                                            ->  Nested Loop  (cost=2074.84..2082.87 rows=1 width=22) (actual time=0.232..0.232 rows=1 loops=50)
                                                  Buffers: shared hit=21136
                                                  ->  Limit  (cost=2074.42..2074.42 rows=1 width=24) (actual time=0.229..0.229 rows=1 loops=50)
                                                        Buffers: shared hit=20936
                                                        ->  Sort  (cost=2074.42..2074.63 rows=85 width=24) (actual time=0.229..0.229 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=20936
                                                              ->  Nested Loop  (cost=0.86..2073.99 rows=85 width=24) (actual time=0.013..0.219 rows=45 loops=50)
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
                                      ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.002..0.003 rows=4 loops=50)
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
Planning Time: 20.427 ms
Execution Time: 12.881 ms
```

### batched fetch, all versions — q=go (50 hits)

Parameters: `["35171,35225,35172,35184,35203,35208,35209,35233,35234,35238,35241,35252,35263,35409,35430,35547,35585,35589,35177,35178,35183,35191,35196,272526,35201,35202,35206,35210,35240,35245,35248,35250,35174,35185,35213,35231,35251,35260,35261,35266,35273,35299,35304,35376,35378,35384,35390,35392,35400,35401"]` — Execution Time: 13.480 ms

```
Limit  (cost=116.51..1458.29 rows=1000 width=1392) (actual time=4.185..13.286 rows=634 loops=1)
  Buffers: shared hit=13178
  ->  Unique  (cost=116.51..5813.71 rows=4246 width=1392) (actual time=4.184..13.233 rows=634 loops=1)
        Buffers: shared hit=13178
        ->  Incremental Sort  (cost=116.51..5781.86 rows=4246 width=1392) (actual time=4.183..12.707 rows=2307 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 21  Sort Method: quicksort  Average Memory: 70kB  Peak Memory: 75kB
              Pre-sorted Groups: 26  Sort Method: quicksort  Average Memory: 561kB  Peak Memory: 561kB
              Buffers: shared hit=13178
              ->  Nested Loop  (cost=1.99..5591.75 rows=4246 width=1392) (actual time=0.053..8.665 rows=2307 loops=1)
                    Buffers: shared hit=13178
                    ->  Nested Loop  (cost=1.70..4929.67 rows=4246 width=1337) (actual time=0.045..7.202 rows=2307 loops=1)
                          Buffers: shared hit=12470
                          ->  Nested Loop  (cost=1.28..2768.89 rows=4246 width=354) (actual time=0.039..3.320 rows=2307 loops=1)
                                Buffers: shared hit=3242
                                ->  Nested Loop  (cost=0.85..506.15 rows=1603 width=64) (actual time=0.032..0.621 rows=634 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=440
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.020..0.133 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.007..0.014 rows=50 loops=1)
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
Planning Time: 10.128 ms
Execution Time: 13.480 ms
```

### ranked terms — q=python

Parameters: `["python","python"]` — Execution Time: 39.353 ms

```
Limit  (cost=17553.70..17553.83 rows=50 width=44) (actual time=39.134..39.156 rows=50 loops=1)
  Buffers: shared hit=3551
  CTE breadth
    ->  Aggregate  (cost=783.03..783.05 rows=1 width=1) (actual time=5.398..5.399 rows=1 loops=1)
          Buffers: shared hit=396
          ->  Limit  (cost=0.42..658.03 rows=10000 width=4) (actual time=0.021..4.794 rows=10000 loops=1)
                Buffers: shared hit=396
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..4846.04 rows=73685 width=4) (actual time=0.020..3.941 rows=10000 loops=1)
                      Index Cond: ((lower(name) >= 'python'::text) AND (lower(name) < 'pythoo'::text))
                      Filter: (lower(name) ~~ 'python%'::text)
                      Buffers: shared hit=396
  CTE prefix
    ->  Limit  (cost=15953.64..15953.77 rows=50 width=39) (actual time=39.028..39.045 rows=50 loops=1)
          Buffers: shared hit=3551
          ->  Sort  (cost=15953.64..15985.20 rows=12623 width=39) (actual time=39.028..39.040 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'python'::text) ELSE GREATEST(similarity(search_terms_3.name, 'python'::text), similarity(search_terms_3.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: top-N heapsort  Memory: 30kB
                Buffers: shared hit=3551
                ->  HashAggregate  (cost=15408.09..15534.32 rows=12623 width=39) (actual time=38.897..38.988 rows=202 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Batches: 1  Memory Usage: 433kB
                      Buffers: shared hit=3551
                      ->  Append  (cost=0.02..8780.96 rows=126231 width=69) (actual time=5.426..37.973 rows=244 loops=1)
                            Buffers: shared hit=3551
                            ->  Result  (cost=0.02..7993.30 rows=125806 width=69) (actual time=5.402..5.404 rows=0 loops=1)
                                  One-Time Filter: (NOT (InitPlan 2).col1)
                                  Buffers: shared hit=396
                                  InitPlan 2
                                    ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=5.400..5.400 rows=1 loops=1)
                                          Buffers: shared hit=396
                                  ->  Seq Scan on search_terms search_terms_3  (cost=0.02..7993.30 rows=125806 width=69) (never executed)
                                        Filter: ((lower(name) ~~ 'python%'::text) OR (lower(attr_path) ~~ 'python%'::text))
                            ->  Result  (cost=8.88..16.76 rows=2 width=69) (actual time=0.023..0.028 rows=15 loops=1)
                                  One-Time Filter: (InitPlan 3).col1
                                  Buffers: shared hit=7
                                  InitPlan 3
                                    ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=69) (actual time=0.020..0.022 rows=15 loops=1)
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
                            ->  Result  (cost=0.30..47.06 rows=323 width=69) (actual time=0.246..0.404 rows=166 loops=1)
                                  One-Time Filter: (InitPlan 4).col1
                                  Buffers: shared hit=156
                                  InitPlan 4
                                    ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Index Scan using search_terms_alias_idx on search_terms search_terms_5  (cost=0.30..47.06 rows=323 width=69) (actual time=0.244..0.382 rows=166 loops=1)
                                        Filter: ((lower(name) ~~ 'python%'::text) OR (lower(attr_path) ~~ 'python%'::text))
                                        Rows Removed by Filter: 429
                                        Buffers: shared hit=156
                            ->  Subquery Scan on "*SELECT* 4"  (cost=1.72..75.23 rows=50 width=69) (actual time=0.751..0.757 rows=13 loops=1)
                                  Buffers: shared hit=157
                                  ->  Limit  (cost=1.72..74.73 rows=50 width=73) (actual time=0.750..0.753 rows=13 loops=1)
                                        Buffers: shared hit=157
                                        InitPlan 5
                                          ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=1.70..12801.83 rows=8766 width=73) (actual time=0.749..0.750 rows=13 loops=1)
                                              Sort Key: ((lower(search_terms_6.name) <-> 'python'::text)), search_terms_6.name
                                              Presorted Key: ((lower(search_terms_6.name) <-> 'python'::text))
                                              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                              Buffers: shared hit=157
                                              ->  Result  (cost=0.28..12407.43 rows=8766 width=73) (actual time=0.537..0.727 rows=13 loops=1)
                                                    One-Time Filter: (InitPlan 5).col1
                                                    Buffers: shared hit=157
                                                    ->  Index Scan using search_terms_top_level_name_knn_idx on search_terms search_terms_6  (cost=0.28..12363.60 rows=8766 width=69) (actual time=0.533..0.700 rows=13 loops=1)
                                                          Index Cond: (lower(name) ~~ 'python%'::text)
                                                          Rows Removed by Index Recheck: 13
                                                          Order By: (lower(name) <-> 'python'::text)
                                                          Buffers: shared hit=157
                            ->  Subquery Scan on "*SELECT* 5"  (cost=0.60..17.45 rows=50 width=69) (actual time=30.752..31.353 rows=50 loops=1)
                                  Buffers: shared hit=2835
                                  ->  Limit  (cost=0.60..16.95 rows=50 width=73) (actual time=30.751..31.345 rows=50 loops=1)
                                        Buffers: shared hit=2835
                                        InitPlan 6
                                          ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=0.58..21175.50 rows=64731 width=73) (actual time=30.749..31.339 rows=50 loops=1)
                                              Sort Key: ((lower(search_terms_7.name) <-> 'python'::text)), search_terms_7.name
                                              Presorted Key: ((lower(search_terms_7.name) <-> 'python'::text))
                                              Full-sort Groups: 2  Sort Methods: top-N heapsort, quicksort  Average Memory: 29kB  Peak Memory: 29kB
                                              Pre-sorted Groups: 1  Sort Method: top-N heapsort  Average Memory: 26kB  Peak Memory: 26kB
                                              Buffers: shared hit=2835
                                              ->  Result  (cost=0.28..18266.56 rows=64731 width=73) (actual time=30.561..31.262 rows=170 loops=1)
                                                    One-Time Filter: (InitPlan 6).col1
                                                    Buffers: shared hit=2835
                                                    ->  Index Scan using search_terms_nested_name_knn_idx on search_terms search_terms_7  (cost=0.28..17942.90 rows=64731 width=69) (actual time=30.546..30.887 rows=170 loops=1)
                                                          Index Cond: (lower(name) ~~ 'python%'::text)
                                                          Rows Removed by Index Recheck: 12
                                                          Order By: (lower(name) <-> 'python'::text)
                                                          Buffers: shared hit=2835
  ->  Sort  (cost=816.89..817.08 rows=75 width=44) (actual time=39.133..39.138 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=3551
        ->  GroupAggregate  (cost=813.05..814.55 rows=75 width=44) (actual time=39.088..39.119 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=3551
              ->  Sort  (cost=813.05..813.24 rows=75 width=42) (actual time=39.083..39.089 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=3551
                    ->  Append  (cost=0.00..810.72 rows=75 width=42) (actual time=39.031..39.075 rows=50 loops=1)
                          Buffers: shared hit=3551
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=39.030..39.045 rows=50 loops=1)
                                Buffers: shared hit=3551
                          ->  Subquery Scan on fuzzy  (cost=809.03..809.34 rows=25 width=39) (actual time=0.022..0.024 rows=0 loops=1)
                                ->  Limit  (cost=809.03..809.09 rows=25 width=39) (actual time=0.022..0.023 rows=0 loops=1)
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.009..0.009 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.004 rows=50 loops=1)
                                      ->  Sort  (cost=807.90..807.96 rows=25 width=39) (actual time=0.021..0.022 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'python'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'python'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'python%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'python%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'python'::text) ELSE GREATEST(similarity(search_terms.name, 'python'::text), similarity(search_terms.attr_path, 'python'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            ->  GroupAggregate  (cost=805.69..807.32 rows=25 width=39) (actual time=0.017..0.019 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  ->  Sort  (cost=805.69..805.75 rows=25 width=69) (actual time=0.016..0.017 rows=0 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        ->  Result  (cost=623.35..805.11 rows=25 width=69) (actual time=0.011..0.012 rows=0 loops=1)
                                                              One-Time Filter: ((InitPlan 8).col1 < 50)
                                                              ->  Bitmap Heap Scan on search_terms  (cost=623.35..805.11 rows=25 width=69) (never executed)
                                                                    Recheck Cond: ((name % 'python'::text) OR (attr_path % 'python'::text))
                                                                    Filter: ((lower(name) !~~ 'python%'::text) AND (lower(attr_path) !~~ 'python%'::text))
                                                                    ->  BitmapOr  (cost=623.35..623.35 rows=50 width=0) (never executed)
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..311.67 rows=25 width=0) (never executed)
                                                                                Index Cond: (name % 'python'::text)
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..311.67 rows=25 width=0) (never executed)
                                                                                Index Cond: (attr_path % 'python'::text)
Planning:
  Buffers: shared hit=4
Planning Time: 1.444 ms
Execution Time: 39.353 ms
```

### batched fetch, latest — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 11.602 ms

```
Limit  (cost=4130.51..104793.00 rows=50 width=1377) (actual time=6.805..11.474 rows=49 loops=1)
  Buffers: shared hit=17675
  ->  Unique  (cost=4130.51..104793.00 rows=50 width=1377) (actual time=6.803..11.468 rows=49 loops=1)
        Buffers: shared hit=17675
        ->  Incremental Sort  (cost=4130.51..104791.32 rows=672 width=1377) (actual time=6.802..11.434 rows=127 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 4  Sort Method: quicksort  Average Memory: 69kB  Peak Memory: 69kB
              Buffers: shared hit=17675
              ->  Nested Loop  (cost=2076.40..104769.33 rows=672 width=1377) (actual time=2.529..11.305 rows=127 loops=1)
                    Buffers: shared hit=17675
                    ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.009..0.017 rows=50 loops=1)
                    ->  Nested Loop  (cost=2076.40..2095.25 rows=13 width=1359) (actual time=0.218..0.225 rows=3 loops=50)
                          Buffers: shared hit=17675
                          ->  Nested Loop  (cost=2076.12..2091.38 rows=13 width=1314) (actual time=0.216..0.220 rows=3 loops=50)
                                Buffers: shared hit=17294
                                ->  Nested Loop  (cost=2075.69..2084.76 rows=13 width=331) (actual time=0.212..0.214 rows=3 loops=50)
                                      Join Filter: (variants.version_id = versions_1.id)
                                      Buffers: shared hit=16786
                                      ->  Nested Loop  (cost=2075.26..2083.32 rows=1 width=45) (actual time=0.210..0.210 rows=1 loops=50)
                                            Buffers: shared hit=16566
                                            ->  Nested Loop  (cost=2074.84..2082.87 rows=1 width=22) (actual time=0.207..0.207 rows=1 loops=50)
                                                  Buffers: shared hit=16370
                                                  ->  Limit  (cost=2074.42..2074.42 rows=1 width=24) (actual time=0.203..0.203 rows=1 loops=50)
                                                        Buffers: shared hit=16174
                                                        ->  Sort  (cost=2074.42..2074.63 rows=85 width=24) (actual time=0.203..0.203 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=16174
                                                              ->  Nested Loop  (cost=0.86..2073.99 rows=85 width=24) (actual time=0.015..0.193 rows=34 loops=50)
                                                                    Buffers: shared hit=16174
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.005..0.009 rows=10 loops=50)
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
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=49)
                                                        Index Cond: (id = versions_1.id)
                                                        Buffers: shared hit=196
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=49)
                                                  Index Cond: (id = versions.package_id)
                                                  Buffers: shared hit=196
                                      ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.002..0.002 rows=3 loops=49)
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
Planning Time: 18.823 ms
Execution Time: 11.602 ms
```

### batched fetch, all versions — q=python (50 hits)

Parameters: `["113125,113133,113126,113128,115769,113132,113130,182211,113134,113127,113131,113129,144106,155721,167017,114993,169824,174570,180462,121545,130664,140883,152209,163594,113437,113601,114071,115023,115037,167503,167540,167741,168535,169306,169865,169884,171515,171561,171824,172863,173875,174633,174660,176746,176800,177119,178411,179650,180538,180567"]` — Execution Time: 11.585 ms

```
Limit  (cost=116.51..1458.29 rows=1000 width=1392) (actual time=3.040..11.391 rows=635 loops=1)
  Buffers: shared hit=12245
  ->  Unique  (cost=116.51..5813.71 rows=4246 width=1392) (actual time=3.038..11.338 rows=635 loops=1)
        Buffers: shared hit=12245
        ->  Incremental Sort  (cost=116.51..5781.86 rows=4246 width=1392) (actual time=3.038..10.721 rows=2164 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 19  Sort Method: quicksort  Average Memory: 126kB  Peak Memory: 126kB
              Pre-sorted Groups: 13  Sort Method: quicksort  Average Memory: 882kB  Peak Memory: 882kB
              Buffers: shared hit=12245
              ->  Nested Loop  (cost=1.99..5591.75 rows=4246 width=1392) (actual time=0.057..7.503 rows=2164 loops=1)
                    Buffers: shared hit=12245
                    ->  Nested Loop  (cost=1.70..4929.67 rows=4246 width=1337) (actual time=0.047..6.307 rows=2164 loops=1)
                          Buffers: shared hit=11729
                          ->  Nested Loop  (cost=1.28..2768.89 rows=4246 width=354) (actual time=0.041..2.917 rows=2164 loops=1)
                                Buffers: shared hit=3073
                                ->  Nested Loop  (cost=0.85..506.15 rows=1603 width=64) (actual time=0.034..0.646 rows=635 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=420
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.021..0.189 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.015 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.36 rows=32 width=33) (actual time=0.003..0.007 rows=13 loops=50)
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
Planning Time: 10.049 ms
Execution Time: 11.585 ms
```

### ranked terms — q=python313Packages.

Parameters: `["python313Packages.","python313Packages."]` — Execution Time: 24.815 ms

```
Limit  (cost=39603.48..39603.61 rows=50 width=44) (actual time=22.432..24.613 rows=50 loops=1)
  Buffers: shared hit=2787
  CTE breadth
    ->  Aggregate  (cost=1091.68..1091.69 rows=1 width=1) (actual time=5.652..5.653 rows=1 loops=1)
          Buffers: shared hit=472
          ->  Limit  (cost=0.42..966.68 rows=10000 width=4) (actual time=0.021..5.048 rows=10000 loops=1)
                Buffers: shared hit=472
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..1227.95 rows=12704 width=4) (actual time=0.021..4.222 rows=10000 loops=1)
                      Index Cond: ((lower(name) >= 'python313packages.'::text) AND (lower(name) < 'python313packages/'::text))
                      Filter: (lower(name) ~~ 'python313packages.%'::text)
                      Buffers: shared hit=472
  CTE prefix
    ->  Limit  (cost=5894.57..5894.69 rows=50 width=39) (actual time=17.940..17.958 rows=50 loops=1)
          Buffers: shared hit=2743
          ->  Sort  (cost=5894.57..5900.80 rows=2494 width=39) (actual time=17.940..17.954 rows=50 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'python313packages.'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'python313packages.'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'python313packages.%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'python313packages.%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'python313Packages.'::text) ELSE GREATEST(similarity(search_terms_3.name, 'python313Packages.'::text), similarity(search_terms_3.attr_path, 'python313Packages.'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: quicksort  Memory: 28kB
                Buffers: shared hit=2743
                ->  HashAggregate  (cost=5786.78..5811.72 rows=2494 width=39) (actual time=17.907..17.934 rows=50 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Batches: 1  Memory Usage: 121kB
                      Buffers: shared hit=2743
                      ->  Append  (cost=694.52..4477.58 rows=24937 width=69) (actual time=17.704..17.739 rows=50 loops=1)
                            Buffers: shared hit=2743
                            ->  Result  (cost=694.52..4058.04 rows=24771 width=69) (actual time=5.657..5.659 rows=0 loops=1)
                                  One-Time Filter: (NOT (InitPlan 2).col1)
                                  Buffers: shared hit=472
                                  InitPlan 2
                                    ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=5.654..5.654 rows=1 loops=1)
                                          Buffers: shared hit=472
                                  ->  Bitmap Heap Scan on search_terms search_terms_3  (cost=694.52..4058.04 rows=24771 width=69) (never executed)
                                        Recheck Cond: ((lower(name) ~~ 'python313packages.%'::text) OR (lower(attr_path) ~~ 'python313packages.%'::text))
                                        Filter: ((lower(name) ~~ 'python313packages.%'::text) OR (lower(attr_path) ~~ 'python313packages.%'::text))
                                        ->  BitmapOr  (cost=694.50..694.50 rows=20126 width=0) (never executed)
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..341.04 rows=10062 width=0) (never executed)
                                                    Index Cond: ((lower(name) >= 'python313packages.'::text) AND (lower(name) < 'python313packages/'::text))
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..341.07 rows=10065 width=0) (never executed)
                                                    Index Cond: ((lower(attr_path) >= 'python313packages.'::text) AND (lower(attr_path) < 'python313packages/'::text))
                            ->  Result  (cost=8.88..16.76 rows=2 width=69) (actual time=0.019..0.020 rows=0 loops=1)
                                  One-Time Filter: (InitPlan 3).col1
                                  Buffers: shared hit=6
                                  InitPlan 3
                                    ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=69) (actual time=0.017..0.018 rows=0 loops=1)
                                        Recheck Cond: ((lower(name) = 'python313packages.'::text) OR (lower(attr_path) = 'python313packages.'::text))
                                        Buffers: shared hit=6
                                        ->  BitmapOr  (cost=8.86..8.86 rows=2 width=0) (actual time=0.011..0.012 rows=0 loops=1)
                                              Buffers: shared hit=6
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.006..0.006 rows=0 loops=1)
                                                    Index Cond: (lower(name) = 'python313packages.'::text)
                                                    Buffers: shared hit=3
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.004..0.004 rows=0 loops=1)
                                                    Index Cond: (lower(attr_path) = 'python313packages.'::text)
                                                    Buffers: shared hit=3
                            ->  Result  (cost=0.30..47.06 rows=64 width=69) (actual time=0.378..0.379 rows=0 loops=1)
                                  One-Time Filter: (InitPlan 4).col1
                                  Buffers: shared hit=156
                                  InitPlan 4
                                    ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                  ->  Index Scan using search_terms_alias_idx on search_terms search_terms_5  (cost=0.30..47.06 rows=64 width=69) (actual time=0.376..0.377 rows=0 loops=1)
                                        Filter: ((lower(name) ~~ 'python313packages.%'::text) OR (lower(attr_path) ~~ 'python313packages.%'::text))
                                        Rows Removed by Filter: 595
                                        Buffers: shared hit=156
                            ->  Subquery Scan on "*SELECT* 4"  (cost=3.56..168.80 rows=50 width=69) (actual time=0.218..0.220 rows=0 loops=1)
                                  Buffers: shared hit=31
                                  ->  Limit  (cost=3.56..168.30 rows=50 width=73) (actual time=0.217..0.219 rows=0 loops=1)
                                        Buffers: shared hit=31
                                        InitPlan 5
                                          ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=3.54..4982.05 rows=1511 width=73) (actual time=0.216..0.217 rows=0 loops=1)
                                              Sort Key: ((lower(search_terms_6.name) <-> 'python313packages.'::text)), search_terms_6.name
                                              Presorted Key: ((lower(search_terms_6.name) <-> 'python313packages.'::text))
                                              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                              Buffers: shared hit=31
                                              ->  Result  (cost=0.28..4914.05 rows=1511 width=73) (actual time=0.208..0.209 rows=0 loops=1)
                                                    One-Time Filter: (InitPlan 5).col1
                                                    Buffers: shared hit=31
                                                    ->  Index Scan using search_terms_top_level_name_knn_idx on search_terms search_terms_6  (cost=0.28..4906.50 rows=1511 width=69) (actual time=0.207..0.207 rows=0 loops=1)
                                                          Index Cond: (lower(name) ~~ 'python313packages.%'::text)
                                                          Order By: (lower(name) <-> 'python313packages.'::text)
                                                          Buffers: shared hit=31
                            ->  Subquery Scan on "*SELECT* 5"  (cost=1.47..62.24 rows=50 width=69) (actual time=11.431..11.451 rows=50 loops=1)
                                  Buffers: shared hit=2078
                                  ->  Limit  (cost=1.47..61.74 rows=50 width=73) (actual time=11.430..11.441 rows=50 loops=1)
                                        Buffers: shared hit=2078
                                        InitPlan 6
                                          ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Incremental Sort  (cost=1.45..13453.38 rows=11160 width=73) (actual time=11.429..11.434 rows=50 loops=1)
                                              Sort Key: ((lower(search_terms_7.name) <-> 'python313packages.'::text)), search_terms_7.name
                                              Presorted Key: ((lower(search_terms_7.name) <-> 'python313packages.'::text))
                                              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 32kB  Peak Memory: 32kB
                                              Buffers: shared hit=2078
                                              ->  Result  (cost=0.28..12951.28 rows=11160 width=73) (actual time=11.177..11.397 rows=60 loops=1)
                                                    One-Time Filter: (InitPlan 6).col1
                                                    Buffers: shared hit=2078
                                                    ->  Index Scan using search_terms_nested_name_knn_idx on search_terms search_terms_7  (cost=0.28..12895.48 rows=11160 width=69) (actual time=11.163..11.251 rows=60 loops=1)
                                                          Index Cond: (lower(name) ~~ 'python313packages.%'::text)
                                                          Order By: (lower(name) <-> 'python313packages.'::text)
                                                          Buffers: shared hit=2078
  ->  Sort  (cost=32617.10..32617.35 rows=100 width=44) (actual time=22.431..24.594 rows=50 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=2787
        ->  GroupAggregate  (cost=32611.78..32613.78 rows=100 width=44) (actual time=22.390..24.570 rows=50 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=2787
              ->  Sort  (cost=32611.78..32612.03 rows=100 width=42) (actual time=22.381..24.544 rows=50 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=2787
                    ->  Append  (cost=0.00..32608.46 rows=100 width=42) (actual time=17.944..24.529 rows=50 loops=1)
                          Buffers: shared hit=2787
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=17.943..17.957 rows=50 loops=1)
                                Buffers: shared hit=2743
                          ->  Subquery Scan on fuzzy  (cost=32606.33..32606.96 rows=50 width=39) (actual time=4.406..6.566 rows=0 loops=1)
                                Buffers: shared hit=44
                                ->  Limit  (cost=32606.33..32606.46 rows=50 width=39) (actual time=4.405..6.565 rows=0 loops=1)
                                      Buffers: shared hit=44
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.008..0.009 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.004 rows=50 loops=1)
                                      ->  Sort  (cost=32605.20..32883.78 rows=111434 width=39) (actual time=4.404..6.563 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'python313packages.'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'python313packages.'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'python313packages.%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'python313packages.%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'python313Packages.'::text) ELSE GREATEST(similarity(search_terms.name, 'python313Packages.'::text), similarity(search_terms.attr_path, 'python313Packages.'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            Buffers: shared hit=44
                                            ->  Finalize GroupAggregate  (cost=15622.57..28903.44 rows=111434 width=39) (actual time=4.398..6.555 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Buffers: shared hit=44
                                                  ->  Gather Merge  (cost=15622.57..27295.86 rows=65765 width=39) (actual time=4.397..6.554 rows=0 loops=1)
                                                        Workers Planned: 1
                                                        Workers Launched: 1
                                                        Buffers: shared hit=44
                                                        ->  Partial GroupAggregate  (cost=14622.56..18897.29 rows=65765 width=39) (actual time=0.038..0.039 rows=0 loops=2)
                                                              Group Key: search_terms.package_id, search_terms.name
                                                              Buffers: shared hit=44
                                                              ->  Sort  (cost=14622.56..14786.98 rows=65765 width=69) (actual time=0.037..0.038 rows=0 loops=2)
                                                                    Sort Key: search_terms.package_id, search_terms.name
                                                                    Sort Method: quicksort  Memory: 25kB
                                                                    Buffers: shared hit=44
                                                                    Worker 0:  Sort Method: quicksort  Memory: 25kB
                                                                    ->  Result  (cost=0.00..6661.21 rows=65765 width=69) (actual time=0.001..0.002 rows=0 loops=2)
                                                                          One-Time Filter: ((InitPlan 8).col1 < 50)
                                                                          ->  Parallel Seq Scan on search_terms  (cost=0.00..6661.21 rows=65765 width=69) (never executed)
                                                                                Filter: (((name % 'python313Packages.'::text) OR (attr_path % 'python313Packages.'::text)) AND (lower(name) !~~ 'python313packages.%'::text) AND (lower(attr_path) !~~ 'python313packages.%'::text))
Planning:
  Buffers: shared hit=4
Planning Time: 1.442 ms
Execution Time: 24.815 ms
```

### batched fetch, latest — q=python313Packages. (50 hits)

Parameters: `["150986,152209,150834,152035,152503,152537,152607,144825,145013,147350,147764,147765,147997,148046,148297,148334,150150,150536,150586,150612,150629,150655,150684,150771,150780,150816,150824,150979,151062,151063,151070,151177,151212,151252,151267,151284,151298,151520,151586,151651,151873,272730,152489,152502,152504,152533,152553,152573,152630,152993"]` — Execution Time: 6.035 ms

```
Limit  (cost=4130.51..104793.00 rows=50 width=1377) (actual time=1.367..5.916 rows=50 loops=1)
  Buffers: shared hit=8298
  ->  Unique  (cost=4130.51..104793.00 rows=50 width=1377) (actual time=1.366..5.910 rows=50 loops=1)
        Buffers: shared hit=8298
        ->  Incremental Sort  (cost=4130.51..104791.32 rows=672 width=1377) (actual time=1.365..5.871 rows=181 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 6  Sort Method: quicksort  Average Memory: 62kB  Peak Memory: 62kB
              Buffers: shared hit=8298
              ->  Nested Loop  (cost=2076.40..104769.33 rows=672 width=1377) (actual time=0.113..5.706 rows=183 loops=1)
                    Buffers: shared hit=8298
                    ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.014 rows=50 loops=1)
                    ->  Nested Loop  (cost=2076.40..2095.25 rows=13 width=1359) (actual time=0.101..0.113 rows=4 loops=50)
                          Buffers: shared hit=8298
                          ->  Nested Loop  (cost=2076.12..2091.38 rows=13 width=1314) (actual time=0.100..0.107 rows=4 loops=50)
                                Buffers: shared hit=7749
                                ->  Nested Loop  (cost=2075.69..2084.76 rows=13 width=331) (actual time=0.096..0.099 rows=4 loops=50)
                                      Join Filter: (variants.version_id = versions_1.id)
                                      Buffers: shared hit=7017
                                      ->  Nested Loop  (cost=2075.26..2083.32 rows=1 width=45) (actual time=0.094..0.095 rows=1 loops=50)
                                            Buffers: shared hit=6737
                                            ->  Nested Loop  (cost=2074.84..2082.87 rows=1 width=22) (actual time=0.091..0.092 rows=1 loops=50)
                                                  Buffers: shared hit=6537
                                                  ->  Limit  (cost=2074.42..2074.42 rows=1 width=24) (actual time=0.088..0.088 rows=1 loops=50)
                                                        Buffers: shared hit=6337
                                                        ->  Sort  (cost=2074.42..2074.63 rows=85 width=24) (actual time=0.088..0.088 rows=1 loops=50)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=6337
                                                              ->  Nested Loop  (cost=0.86..2073.99 rows=85 width=24) (actual time=0.014..0.084 rows=13 loops=50)
                                                                    Buffers: shared hit=6337
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.004..0.005 rows=3 loops=50)
                                                                          Index Cond: (package_id = hits.package_id)
                                                                          Filter: (NOT prerelease)
                                                                          Buffers: shared hit=206
                                                                    ->  Index Scan using variants_identity_key on variants variants_1  (cost=0.43..32.45 rows=13 width=8) (actual time=0.002..0.004 rows=4 loops=173)
                                                                          Index Cond: (version_id = versions_1.id)
                                                                          Buffers: shared hit=797
                                                                    SubPlan 1
                                                                      ->  Index Scan using variants_identity_key on variants b  (cost=0.43..32.45 rows=13 width=0) (actual time=0.002..0.002 rows=1 loops=650)
                                                                            Index Cond: (version_id = versions_1.id)
                                                                            Filter: (NOT broken)
                                                                            Buffers: shared hit=2600
                                                                    SubPlan 2
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=650)
                                                                            Buffers: shared hit=2734
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=650)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=2734
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.003..0.003 rows=1 loops=50)
                                                        Index Cond: (id = versions_1.id)
                                                        Buffers: shared hit=200
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                                  Index Cond: (id = versions.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.002..0.003 rows=4 loops=50)
                                            Index Cond: (version_id = versions.id)
                                            Buffers: shared hit=280
                                ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=183)
                                      Index Cond: (id = variants.meta_id)
                                      Buffers: shared hit=732
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=183)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=549
Planning:
  Buffers: shared hit=112
Planning Time: 19.196 ms
Execution Time: 6.035 ms
```

### batched fetch, all versions — q=python313Packages. (50 hits)

Parameters: `["150986,152209,150834,152035,152503,152537,152607,144825,145013,147350,147764,147765,147997,148046,148297,148334,150150,150536,150586,150612,150629,150655,150684,150771,150780,150816,150824,150979,151062,151063,151070,151177,151212,151252,151267,151284,151298,151520,151586,151651,151873,272730,152489,152502,152504,152533,152553,152573,152630,152993"]` — Execution Time: 4.311 ms

```
Limit  (cost=116.51..1458.29 rows=1000 width=1392) (actual time=0.392..4.205 rows=173 loops=1)
  Buffers: shared hit=3989
  ->  Unique  (cost=116.51..5813.71 rows=4246 width=1392) (actual time=0.391..4.189 rows=173 loops=1)
        Buffers: shared hit=3989
        ->  Incremental Sort  (cost=116.51..5781.86 rows=4246 width=1392) (actual time=0.390..3.996 rows=650 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 14  Sort Method: quicksort  Average Memory: 101kB  Peak Memory: 101kB
              Pre-sorted Groups: 4  Sort Method: quicksort  Average Memory: 83kB  Peak Memory: 101kB
              Buffers: shared hit=3989
              ->  Nested Loop  (cost=1.99..5591.75 rows=4246 width=1392) (actual time=0.053..2.774 rows=650 loops=1)
                    Buffers: shared hit=3989
                    ->  Nested Loop  (cost=1.70..4929.67 rows=4246 width=1337) (actual time=0.044..2.395 rows=650 loops=1)
                          Buffers: shared hit=3803
                          ->  Nested Loop  (cost=1.28..2768.89 rows=4246 width=354) (actual time=0.038..1.250 rows=650 loops=1)
                                Buffers: shared hit=1203
                                ->  Nested Loop  (cost=0.85..506.15 rows=1603 width=64) (actual time=0.031..0.377 rows=173 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=406
                                      ->  Nested Loop  (cost=0.42..418.38 rows=50 width=43) (actual time=0.022..0.153 rows=50 loops=1)
                                            Buffers: shared hit=200
                                            ->  Function Scan on unnest hits  (cost=0.00..0.50 rows=50 width=12) (actual time=0.008..0.013 rows=50 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.36 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=50)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=200
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.36 rows=32 width=33) (actual time=0.003..0.004 rows=3 loops=50)
                                            Index Cond: (package_id = packages.id)
                                            Buffers: shared hit=206
                                ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.003..0.004 rows=4 loops=173)
                                      Index Cond: (version_id = versions.id)
                                      Buffers: shared hit=797
                          ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=650)
                                Index Cond: (id = variants.meta_id)
                                Buffers: shared hit=2600
                    ->  Memoize  (cost=0.29..0.31 rows=1 width=53) (actual time=0.000..0.000 rows=1 loops=650)
                          Cache Key: variants.commit_seq
                          Cache Mode: logical
                          Hits: 588  Misses: 62  Evictions: 0  Overflows: 0  Memory Usage: 10kB
                          Buffers: shared hit=186
                          ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.001..0.001 rows=1 loops=62)
                                Index Cond: (seq = variants.commit_seq)
                                Buffers: shared hit=186
Planning:
  Buffers: shared hit=68
Planning Time: 10.265 ms
Execution Time: 4.311 ms
```

### ranked terms — q=hello

Parameters: `["hello","hello"]` — Execution Time: 89.498 ms

```
Limit  (cost=874.28..874.40 rows=50 width=44) (actual time=89.279..89.299 rows=14 loops=1)
  Buffers: shared hit=1212
  CTE breadth
    ->  Aggregate  (cost=8.76..8.77 rows=1 width=1) (actual time=0.028..0.029 rows=1 loops=1)
          Buffers: shared hit=4
          ->  Limit  (cost=0.42..8.45 rows=25 width=4) (actual time=0.020..0.025 rows=5 loops=1)
                Buffers: shared hit=4
                ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_1  (cost=0.42..8.45 rows=25 width=4) (actual time=0.019..0.024 rows=5 loops=1)
                      Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                      Filter: (lower(name) ~~ 'hello%'::text)
                      Buffers: shared hit=4
  CTE prefix
    ->  Limit  (cost=68.19..68.32 rows=50 width=39) (actual time=0.083..0.096 rows=5 loops=1)
          Buffers: shared hit=11
          ->  Sort  (cost=68.19..68.39 rows=78 width=39) (actual time=0.083..0.095 rows=5 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_3.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms_3.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms_3.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms_3.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_3.name = search_terms_3.attr_path) THEN similarity(search_terms_3.name, 'hello'::text) ELSE GREATEST(similarity(search_terms_3.name, 'hello'::text), similarity(search_terms_3.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms_3.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_3.name
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=11
                ->  HashAggregate  (cost=64.96..65.74 rows=78 width=39) (actual time=0.078..0.091 rows=5 loops=1)
                      Group Key: search_terms_3.package_id, search_terms_3.name
                      Batches: 1  Memory Usage: 24kB
                      Buffers: shared hit=11
                      ->  Append  (cost=8.90..60.86 rows=78 width=69) (actual time=0.046..0.068 rows=5 loops=1)
                            Buffers: shared hit=11
                            ->  Result  (cost=8.90..12.92 rows=50 width=69) (actual time=0.046..0.052 rows=5 loops=1)
                                  One-Time Filter: (NOT (InitPlan 2).col1)
                                  Buffers: shared hit=11
                                  InitPlan 2
                                    ->  CTE Scan on breadth  (cost=0.00..0.02 rows=1 width=1) (actual time=0.029..0.029 rows=1 loops=1)
                                          Buffers: shared hit=4
                                  ->  Bitmap Heap Scan on search_terms search_terms_3  (cost=8.90..12.92 rows=50 width=69) (actual time=0.015..0.018 rows=5 loops=1)
                                        Recheck Cond: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                                        Filter: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                                        Heap Blocks: exact=1
                                        Buffers: shared hit=7
                                        ->  BitmapOr  (cost=8.88..8.88 rows=1 width=0) (actual time=0.010..0.011 rows=0 loops=1)
                                              Buffers: shared hit=6
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.003..0.003 rows=5 loops=1)
                                                    Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                                    Buffers: shared hit=3
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.007..0.007 rows=5 loops=1)
                                                    Index Cond: ((lower(attr_path) >= 'hello'::text) AND (lower(attr_path) < 'hellp'::text))
                                                    Buffers: shared hit=3
                            ->  Result  (cost=8.88..16.76 rows=2 width=69) (actual time=0.001..0.003 rows=0 loops=1)
                                  One-Time Filter: (InitPlan 3).col1
                                  InitPlan 3
                                    ->  CTE Scan on breadth breadth_1  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_4  (cost=8.88..16.76 rows=2 width=69) (never executed)
                                        Recheck Cond: ((lower(name) = 'hello'::text) OR (lower(attr_path) = 'hello'::text))
                                        ->  BitmapOr  (cost=8.86..8.86 rows=2 width=0) (never executed)
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                    Index Cond: (lower(name) = 'hello'::text)
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                    Index Cond: (lower(attr_path) = 'hello'::text)
                            ->  Result  (cost=8.88..12.90 rows=1 width=69) (actual time=0.001..0.002 rows=0 loops=1)
                                  One-Time Filter: (InitPlan 4).col1
                                  InitPlan 4
                                    ->  CTE Scan on breadth breadth_2  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.001 rows=1 loops=1)
                                  ->  Bitmap Heap Scan on search_terms search_terms_5  (cost=8.88..12.90 rows=1 width=69) (never executed)
                                        Recheck Cond: ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text))
                                        Filter: (((name = attr_path) IS FALSE) AND ((lower(name) ~~ 'hello%'::text) OR (lower(attr_path) ~~ 'hello%'::text)))
                                        ->  BitmapOr  (cost=8.86..8.86 rows=1 width=0) (never executed)
                                              ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                    Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                              ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (never executed)
                                                    Index Cond: ((lower(attr_path) >= 'hello'::text) AND (lower(attr_path) < 'hellp'::text))
                            ->  Subquery Scan on "*SELECT* 4"  (cost=8.51..8.54 rows=3 width=69) (actual time=0.004..0.005 rows=0 loops=1)
                                  ->  Limit  (cost=8.51..8.51 rows=3 width=73) (actual time=0.003..0.005 rows=0 loops=1)
                                        InitPlan 5
                                          ->  CTE Scan on breadth breadth_3  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Sort  (cost=8.49..8.49 rows=3 width=73) (actual time=0.003..0.003 rows=0 loops=1)
                                              Sort Key: ((lower(search_terms_6.name) <-> 'hello'::text)), search_terms_6.name
                                              Sort Method: quicksort  Memory: 25kB
                                              ->  Result  (cost=0.42..8.46 rows=3 width=73) (actual time=0.001..0.001 rows=0 loops=1)
                                                    One-Time Filter: (InitPlan 5).col1
                                                    ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_6  (cost=0.42..8.45 rows=3 width=69) (never executed)
                                                          Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                                          Filter: ((top_level_attr IS NOT NULL) AND ((name = attr_path) IS TRUE) AND (lower(name) ~~ 'hello%'::text))
                            ->  Subquery Scan on "*SELECT* 5"  (cost=9.07..9.34 rows=22 width=69) (actual time=0.002..0.004 rows=0 loops=1)
                                  ->  Limit  (cost=9.07..9.12 rows=22 width=73) (actual time=0.002..0.003 rows=0 loops=1)
                                        InitPlan 6
                                          ->  CTE Scan on breadth breadth_4  (cost=0.00..0.02 rows=1 width=1) (actual time=0.000..0.000 rows=1 loops=1)
                                        ->  Sort  (cost=9.05..9.10 rows=22 width=73) (actual time=0.002..0.002 rows=0 loops=1)
                                              Sort Key: ((lower(search_terms_7.name) <-> 'hello'::text)), search_terms_7.name
                                              Sort Method: quicksort  Memory: 25kB
                                              ->  Result  (cost=0.42..8.56 rows=22 width=73) (actual time=0.001..0.001 rows=0 loops=1)
                                                    One-Time Filter: (InitPlan 6).col1
                                                    ->  Index Scan using search_terms_name_lower_idx on search_terms search_terms_7  (cost=0.42..8.45 rows=22 width=69) (never executed)
                                                          Index Cond: ((lower(name) >= 'hello'::text) AND (lower(name) < 'hellp'::text))
                                                          Filter: ((top_level_attr IS NULL) AND ((name = attr_path) IS TRUE) AND (lower(name) ~~ 'hello%'::text))
  ->  Sort  (cost=797.19..797.44 rows=100 width=44) (actual time=89.278..89.282 rows=14 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=1212
        ->  GroupAggregate  (cost=791.87..793.87 rows=100 width=44) (actual time=89.265..89.274 rows=14 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=1212
              ->  Sort  (cost=791.87..792.12 rows=100 width=42) (actual time=89.261..89.265 rows=14 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=1212
                    ->  Append  (cost=0.00..788.55 rows=100 width=42) (actual time=0.085..89.260 rows=14 loops=1)
                          Buffers: shared hit=1212
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=0.085..0.086 rows=5 loops=1)
                                Buffers: shared hit=11
                          ->  Subquery Scan on fuzzy  (cost=786.42..787.05 rows=50 width=39) (actual time=89.165..89.170 rows=9 loops=1)
                                Buffers: shared hit=1201
                                ->  Limit  (cost=786.42..786.55 rows=50 width=39) (actual time=89.164..89.167 rows=9 loops=1)
                                      Buffers: shared hit=1201
                                      InitPlan 8
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.002..0.003 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.001 rows=5 loops=1)
                                      ->  Sort  (cost=785.29..785.41 rows=50 width=39) (actual time=89.163..89.165 rows=9 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = 'hello'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = 'hello'::text) THEN 900 WHEN (lower(search_terms.name) ~~ 'hello%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ 'hello%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, 'hello'::text) ELSE GREATEST(similarity(search_terms.name, 'hello'::text), similarity(search_terms.attr_path, 'hello'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            Buffers: shared hit=1201
                                            ->  GroupAggregate  (cost=780.63..783.88 rows=50 width=39) (actual time=89.141..89.159 rows=9 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Buffers: shared hit=1201
                                                  ->  Sort  (cost=780.63..780.75 rows=50 width=69) (actual time=89.127..89.130 rows=9 loops=1)
                                                        Sort Key: search_terms.package_id, search_terms.name
                                                        Sort Method: quicksort  Memory: 25kB
                                                        Buffers: shared hit=1201
                                                        ->  Result  (cost=597.46..779.22 rows=50 width=69) (actual time=41.320..89.117 rows=9 loops=1)
                                                              One-Time Filter: ((InitPlan 8).col1 < 50)
                                                              Buffers: shared hit=1201
                                                              ->  Bitmap Heap Scan on search_terms  (cost=597.46..779.22 rows=50 width=69) (actual time=41.316..89.109 rows=9 loops=1)
                                                                    Recheck Cond: ((name % 'hello'::text) OR (attr_path % 'hello'::text))
                                                                    Rows Removed by Index Recheck: 17526
                                                                    Filter: ((lower(name) !~~ 'hello%'::text) AND (lower(attr_path) !~~ 'hello%'::text))
                                                                    Rows Removed by Filter: 5
                                                                    Heap Blocks: exact=1035
                                                                    Buffers: shared hit=1201
                                                                    ->  BitmapOr  (cost=597.46..597.46 rows=50 width=0) (actual time=4.619..4.620 rows=0 loops=1)
                                                                          Buffers: shared hit=166
                                                                          ->  Bitmap Index Scan on search_terms_name_trgm_idx  (cost=0.00..298.72 rows=25 width=0) (actual time=2.315..2.315 rows=17540 loops=1)
                                                                                Index Cond: (name % 'hello'::text)
                                                                                Buffers: shared hit=83
                                                                          ->  Bitmap Index Scan on search_terms_attr_path_trgm_idx  (cost=0.00..298.72 rows=25 width=0) (actual time=2.303..2.303 rows=17540 loops=1)
                                                                                Index Cond: (attr_path % 'hello'::text)
                                                                                Buffers: shared hit=83
Planning:
  Buffers: shared hit=4
Planning Time: 1.352 ms
Execution Time: 89.498 ms
```

### batched fetch, latest — q=hello (14 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,51341,242138,42681"]` — Execution Time: 1.861 ms

```
Limit  (cost=4023.72..29342.04 rows=14 width=1377) (actual time=1.478..1.764 rows=14 loops=1)
  Buffers: shared hit=2687
  ->  Unique  (cost=4023.72..29342.04 rows=14 width=1377) (actual time=1.477..1.762 rows=14 loops=1)
        Buffers: shared hit=2687
        ->  Incremental Sort  (cost=4023.72..29341.57 rows=188 width=1377) (actual time=1.476..1.749 rows=46 loops=1)
              Sort Key: hits.ord, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 65kB  Peak Memory: 65kB
              Buffers: shared hit=2687
              ->  Nested Loop  (cost=2076.40..29335.41 rows=188 width=1377) (actual time=0.180..1.699 rows=46 loops=1)
                    Buffers: shared hit=2687
                    ->  Function Scan on unnest hits  (cost=0.00..0.14 rows=14 width=12) (actual time=0.006..0.008 rows=14 loops=1)
                    ->  Nested Loop  (cost=2076.40..2095.25 rows=13 width=1359) (actual time=0.111..0.120 rows=3 loops=14)
                          Buffers: shared hit=2687
                          ->  Nested Loop  (cost=2076.12..2091.38 rows=13 width=1314) (actual time=0.109..0.115 rows=3 loops=14)
                                Buffers: shared hit=2549
                                ->  Nested Loop  (cost=2075.69..2084.76 rows=13 width=331) (actual time=0.106..0.108 rows=3 loops=14)
                                      Join Filter: (variants.version_id = versions_1.id)
                                      Buffers: shared hit=2365
                                      ->  Nested Loop  (cost=2075.26..2083.32 rows=1 width=45) (actual time=0.104..0.104 rows=1 loops=14)
                                            Buffers: shared hit=2289
                                            ->  Nested Loop  (cost=2074.84..2082.87 rows=1 width=22) (actual time=0.101..0.101 rows=1 loops=14)
                                                  Buffers: shared hit=2233
                                                  ->  Limit  (cost=2074.42..2074.42 rows=1 width=24) (actual time=0.098..0.098 rows=1 loops=14)
                                                        Buffers: shared hit=2177
                                                        ->  Sort  (cost=2074.42..2074.63 rows=85 width=24) (actual time=0.098..0.098 rows=1 loops=14)
                                                              Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions_1.sort_key DESC
                                                              Sort Method: top-N heapsort  Memory: 25kB
                                                              Buffers: shared hit=2177
                                                              ->  Nested Loop  (cost=0.86..2073.99 rows=85 width=24) (actual time=0.013..0.093 rows=15 loops=14)
                                                                    Buffers: shared hit=2177
                                                                    ->  Index Scan using versions_semver_idx on versions versions_1  (cost=0.43..66.18 rows=32 width=19) (actual time=0.004..0.005 rows=5 loops=14)
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
                                                                      ->  Aggregate  (cost=8.45..8.46 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=216)
                                                                            Buffers: shared hit=898
                                                                            ->  Index Scan using variant_ranges_variant_id_first_seq_pk on variant_ranges r  (cost=0.43..8.45 rows=1 width=4) (actual time=0.002..0.002 rows=0 loops=216)
                                                                                  Index Cond: (variant_id = variants_1.id)
                                                                                  Filter: (NOT seeded)
                                                                                  Rows Removed by Filter: 1
                                                                                  Buffers: shared hit=898
                                                  ->  Index Scan using versions_pkey on versions  (cost=0.43..8.45 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=14)
                                                        Index Cond: (id = versions_1.id)
                                                        Buffers: shared hit=56
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=14)
                                                  Index Cond: (id = versions.package_id)
                                                  Buffers: shared hit=56
                                      ->  Index Scan using variants_identity_key on variants  (cost=0.43..1.28 rows=13 width=298) (actual time=0.001..0.002 rows=3 loops=14)
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
Planning Time: 18.078 ms
Execution Time: 1.861 ms
```

### batched fetch, all versions — q=hello (14 hits)

Parameters: `["51324,51326,51325,51327,51328,87526,51329,51330,51319,51323,54432,51341,242138,42681"]` — Execution Time: 1.745 ms

```
Limit  (cost=128.53..1532.33 rows=1000 width=1392) (actual time=0.386..1.662 rows=75 loops=1)
  Buffers: shared hit=1983
  ->  Unique  (cost=128.53..1797.65 rows=1189 width=1392) (actual time=0.385..1.654 rows=75 loops=1)
        Buffers: shared hit=1983
        ->  Incremental Sort  (cost=128.53..1788.73 rows=1189 width=1392) (actual time=0.384..1.600 rows=216 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 5  Sort Method: quicksort  Average Memory: 88kB  Peak Memory: 88kB
              Pre-sorted Groups: 3  Sort Method: quicksort  Average Memory: 50kB  Peak Memory: 54kB
              Buffers: shared hit=1983
              ->  Nested Loop  (cost=1.98..1735.49 rows=1189 width=1392) (actual time=0.047..1.176 rows=216 loops=1)
                    Buffers: shared hit=1983
                    ->  Nested Loop  (cost=1.70..1381.72 rows=1189 width=1337) (actual time=0.041..0.868 rows=216 loops=1)
                          Buffers: shared hit=1335
                          ->  Nested Loop  (cost=1.28..776.64 rows=1189 width=354) (actual time=0.035..0.507 rows=216 loops=1)
                                Buffers: shared hit=471
                                ->  Nested Loop  (cost=0.85..142.84 rows=449 width=64) (actual time=0.028..0.200 rows=75 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      Buffers: shared hit=112
                                      ->  Nested Loop  (cost=0.42..118.27 rows=14 width=43) (actual time=0.020..0.055 rows=14 loops=1)
                                            Buffers: shared hit=56
                                            ->  Function Scan on unnest hits  (cost=0.00..0.14 rows=14 width=12) (actual time=0.006..0.008 rows=14 loops=1)
                                            ->  Index Scan using packages_pkey on packages  (cost=0.42..8.44 rows=1 width=31) (actual time=0.003..0.003 rows=1 loops=14)
                                                  Index Cond: (id = hits.package_id)
                                                  Buffers: shared hit=56
                                      ->  Index Scan using versions_package_version_key on versions  (cost=0.43..1.36 rows=32 width=33) (actual time=0.008..0.009 rows=5 loops=14)
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
Planning Time: 9.998 ms
Execution Time: 1.745 ms
```

### ranked terms — q=-

Parameters: `["-","-"]` — Execution Time: 882.215 ms

```
Limit  (cost=7698.67..7698.79 rows=50 width=44) (actual time=881.207..882.100 rows=0 loops=1)
  Buffers: shared hit=2982
  CTE prefix
    ->  Limit  (cost=17.44..17.57 rows=50 width=39) (actual time=0.017..0.020 rows=0 loops=1)
          Buffers: shared hit=6
          ->  Sort  (cost=17.44..17.57 rows=50 width=39) (actual time=0.016..0.019 rows=0 loops=1)
                Sort Key: (max((((CASE WHEN (lower(search_terms_1.name) = '-'::text) THEN 1000 WHEN (lower(search_terms_1.attr_path) = '-'::text) THEN 900 WHEN (lower(search_terms_1.name) ~~ '-%'::text) THEN 800 WHEN (lower(search_terms_1.attr_path) ~~ '-%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms_1.name = search_terms_1.attr_path) THEN similarity(search_terms_1.name, '-'::text) ELSE GREATEST(similarity(search_terms_1.name, '-'::text), similarity(search_terms_1.attr_path, '-'::text)) END)) + (CASE WHEN (search_terms_1.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms_1.name
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=6
                ->  HashAggregate  (cost=15.53..16.03 rows=50 width=39) (actual time=0.015..0.017 rows=0 loops=1)
                      Group Key: search_terms_1.package_id, search_terms_1.name
                      Batches: 1  Memory Usage: 24kB
                      Buffers: shared hit=6
                      ->  Bitmap Heap Scan on search_terms search_terms_1  (cost=8.88..12.90 rows=50 width=69) (actual time=0.014..0.015 rows=0 loops=1)
                            Recheck Cond: ((lower(name) ~~ '-%'::text) OR (lower(attr_path) ~~ '-%'::text))
                            Filter: ((lower(name) ~~ '-%'::text) OR (lower(attr_path) ~~ '-%'::text))
                            Buffers: shared hit=6
                            ->  BitmapOr  (cost=8.88..8.88 rows=1 width=0) (actual time=0.011..0.013 rows=0 loops=1)
                                  Buffers: shared hit=6
                                  ->  Bitmap Index Scan on search_terms_name_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.007..0.008 rows=0 loops=1)
                                        Index Cond: ((lower(name) >= '-'::text) AND (lower(name) < '.'::text))
                                        Buffers: shared hit=3
                                  ->  Bitmap Index Scan on search_terms_attr_path_lower_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.003..0.004 rows=0 loops=1)
                                        Index Cond: ((lower(attr_path) >= '-'::text) AND (lower(attr_path) < '.'::text))
                                        Buffers: shared hit=3
  ->  Sort  (cost=7681.10..7681.35 rows=100 width=44) (actual time=881.206..882.095 rows=0 loops=1)
        Sort Key: (max(prefix.rank)) DESC, (min(prefix.name))
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=2982
        ->  GroupAggregate  (cost=7675.78..7677.78 rows=100 width=44) (actual time=881.203..882.092 rows=0 loops=1)
              Group Key: prefix.package_id
              Buffers: shared hit=2982
              ->  Sort  (cost=7675.78..7676.03 rows=100 width=42) (actual time=881.203..882.090 rows=0 loops=1)
                    Sort Key: prefix.package_id
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=2982
                    ->  Append  (cost=0.00..7672.46 rows=100 width=42) (actual time=881.201..882.089 rows=0 loops=1)
                          Buffers: shared hit=2982
                          ->  CTE Scan on prefix  (cost=0.00..1.00 rows=50 width=44) (actual time=0.018..0.018 rows=0 loops=1)
                                Buffers: shared hit=6
                          ->  Subquery Scan on fuzzy  (cost=7670.33..7670.96 rows=50 width=39) (actual time=881.182..882.069 rows=0 loops=1)
                                Buffers: shared hit=2976
                                ->  Limit  (cost=7670.33..7670.46 rows=50 width=39) (actual time=881.181..882.067 rows=0 loops=1)
                                      Buffers: shared hit=2976
                                      InitPlan 2
                                        ->  Aggregate  (cost=1.12..1.14 rows=1 width=8) (actual time=0.002..0.003 rows=1 loops=1)
                                              ->  CTE Scan on prefix prefix_1  (cost=0.00..1.00 rows=50 width=0) (actual time=0.000..0.000 rows=0 loops=1)
                                      ->  Sort  (cost=7669.20..7669.32 rows=50 width=39) (actual time=881.180..882.065 rows=0 loops=1)
                                            Sort Key: (max((((CASE WHEN (lower(search_terms.name) = '-'::text) THEN 1000 WHEN (lower(search_terms.attr_path) = '-'::text) THEN 900 WHEN (lower(search_terms.name) ~~ '-%'::text) THEN 800 WHEN (lower(search_terms.attr_path) ~~ '-%'::text) THEN 700 ELSE 0 END)::double precision + ('100'::double precision * CASE WHEN (search_terms.name = search_terms.attr_path) THEN similarity(search_terms.name, '-'::text) ELSE GREATEST(similarity(search_terms.name, '-'::text), similarity(search_terms.attr_path, '-'::text)) END)) + (CASE WHEN (search_terms.top_level_attr IS NOT NULL) THEN 25 ELSE 0 END)::double precision))) DESC, search_terms.name
                                            Sort Method: quicksort  Memory: 25kB
                                            Buffers: shared hit=2976
                                            ->  Finalize GroupAggregate  (cost=7661.92..7667.79 rows=50 width=39) (actual time=881.178..882.062 rows=0 loops=1)
                                                  Group Key: search_terms.package_id, search_terms.name
                                                  Buffers: shared hit=2976
                                                  ->  Gather Merge  (cost=7661.92..7667.07 rows=29 width=39) (actual time=881.176..882.060 rows=0 loops=1)
                                                        Workers Planned: 1
                                                        Workers Launched: 1
                                                        Buffers: shared hit=2976
                                                        ->  Partial GroupAggregate  (cost=6661.91..6663.80 rows=29 width=39) (actual time=874.077..874.078 rows=0 loops=2)
                                                              Group Key: search_terms.package_id, search_terms.name
                                                              Buffers: shared hit=2976
                                                              ->  Sort  (cost=6661.91..6661.99 rows=29 width=69) (actual time=874.076..874.076 rows=0 loops=2)
                                                                    Sort Key: search_terms.package_id, search_terms.name
                                                                    Sort Method: quicksort  Memory: 25kB
                                                                    Buffers: shared hit=2976
                                                                    Worker 0:  Sort Method: quicksort  Memory: 25kB
                                                                    ->  Result  (cost=0.00..6661.21 rows=29 width=69) (actual time=874.059..874.059 rows=0 loops=2)
                                                                          One-Time Filter: ((InitPlan 2).col1 < 50)
                                                                          Buffers: shared hit=2961
                                                                          ->  Parallel Seq Scan on search_terms  (cost=0.00..6661.21 rows=29 width=69) (actual time=874.057..874.057 rows=0 loops=2)
                                                                                Filter: (((name % '-'::text) OR (attr_path % '-'::text)) AND (lower(name) !~~ '-%'::text) AND (lower(attr_path) !~~ '-%'::text))
                                                                                Rows Removed by Filter: 125807
                                                                                Buffers: shared hit=2961
Planning:
  Buffers: shared hit=30
Planning Time: 8.539 ms
Execution Time: 882.215 ms
```

### batched fetch, latest — q=- (0 hits)

Parameters: `[""]` — Execution Time: 0.109 ms

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
                                            ->  Nested Loop  (cost=2074.42..2074.45 rows=1 width=12) (actual time=0.004..0.004 rows=0 loops=1)
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
Planning Time: 18.575 ms
Execution Time: 0.109 ms
```

### batched fetch, all versions — q=- (0 hits)

Parameters: `[""]` — Execution Time: 0.094 ms

```
Limit  (cost=126.65..128.37 rows=85 width=1392) (actual time=0.017..0.018 rows=0 loops=1)
  ->  Unique  (cost=126.65..128.37 rows=85 width=1392) (actual time=0.016..0.016 rows=0 loops=1)
        ->  Incremental Sort  (cost=126.65..127.73 rows=85 width=1392) (actual time=0.015..0.016 rows=0 loops=1)
              Sort Key: hits.ord, versions.sort_key DESC, versions.version, variants.system, variants.attr_path
              Presorted Key: hits.ord
              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
              ->  Nested Loop  (cost=1.98..123.92 rows=85 width=1392) (actual time=0.004..0.005 rows=0 loops=1)
                    ->  Nested Loop  (cost=1.70..98.63 rows=85 width=1337) (actual time=0.004..0.004 rows=0 loops=1)
                          ->  Nested Loop  (cost=1.28..55.38 rows=85 width=354) (actual time=0.004..0.004 rows=0 loops=1)
                                ->  Nested Loop  (cost=0.85..10.21 rows=32 width=64) (actual time=0.004..0.004 rows=0 loops=1)
                                      Join Filter: (versions.package_id = hits.package_id)
                                      ->  Nested Loop  (cost=0.42..8.45 rows=1 width=43) (actual time=0.003..0.004 rows=0 loops=1)
                                            ->  Function Scan on unnest hits  (cost=0.00..0.01 rows=1 width=12) (actual time=0.003..0.003 rows=0 loops=1)
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
Planning Time: 11.632 ms
Execution Time: 0.094 ms
```

## Name lookups (/v2/resolve, /v1/resolve, /v2/pkg, /v1/pkg)

### pick latest version — name=go

Parameters: `["go"]` — Execution Time: 8.102 ms

```
Limit  (cost=2741.78..2741.78 rows=1 width=24) (actual time=8.012..8.016 rows=1 loops=1)
  Buffers: shared hit=15153
  ->  Sort  (cost=2741.78..2742.09 rows=124 width=24) (actual time=8.011..8.014 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=15153
        ->  Nested Loop  (cost=163.70..2741.16 rows=124 width=24) (actual time=1.095..7.890 rows=647 loops=1)
              Buffers: shared hit=15153
              ->  Nested Loop  (cost=163.28..1277.92 rows=124 width=27) (actual time=1.075..3.831 rows=647 loops=1)
                    Buffers: shared hit=6735
                    ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=8) (actual time=1.068..2.589 rows=722 loops=1)
                          Buffers: shared hit=3847
                          ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=1.063..1.169 rows=722 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=959
                                ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.031..0.889 rows=979 loops=1)
                                      Buffers: shared hit=959
                                      ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.031..0.739 rows=722 loops=1)
                                            Buffers: shared hit=898
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.025..0.093 rows=191 loops=1)
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
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.007..0.075 rows=257 loops=1)
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
Planning Time: 14.760 ms
Execution Time: 8.102 ms
```

### pick latest version — name=python

Parameters: `["python"]` — Execution Time: 6.097 ms

```
Limit  (cost=2741.78..2741.78 rows=1 width=24) (actual time=6.007..6.011 rows=1 loops=1)
  Buffers: shared hit=11360
  ->  Sort  (cost=2741.78..2742.09 rows=124 width=24) (actual time=6.005..6.009 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=11360
        ->  Nested Loop  (cost=163.70..2741.16 rows=124 width=24) (actual time=0.847..5.922 rows=415 loops=1)
              Buffers: shared hit=11360
              ->  Nested Loop  (cost=163.28..1277.92 rows=124 width=27) (actual time=0.823..3.276 rows=415 loops=1)
                    Buffers: shared hit=5955
                    ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=8) (actual time=0.817..2.095 rows=648 loops=1)
                          Buffers: shared hit=3363
                          ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=0.806..0.902 rows=648 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 89kB
                                Buffers: shared hit=771
                                ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.029..0.677 rows=651 loops=1)
                                      Buffers: shared hit=771
                                      ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.029..0.619 rows=648 loops=1)
                                            Buffers: shared hit=766
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.022..0.094 rows=177 loops=1)
                                                  Buffers: shared hit=23
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.013 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'python'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.007..0.054 rows=177 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=19
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.002..0.002 rows=4 loops=177)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=743
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.007..0.008 rows=3 loops=1)
                                            Index Cond: (attr_path = 'python'::text)
                                            Buffers: shared hit=5
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=648)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=2592
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.002..0.002 rows=1 loops=648)
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
Planning Time: 14.807 ms
Execution Time: 6.097 ms
```

### pick latest version — name=python311

Parameters: `["python311"]` — Execution Time: 0.915 ms

```
Limit  (cost=2741.78..2741.78 rows=1 width=24) (actual time=0.830..0.832 rows=1 loops=1)
  Buffers: shared hit=1378
  ->  Sort  (cost=2741.78..2742.09 rows=124 width=24) (actual time=0.829..0.831 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=1378
        ->  Nested Loop  (cost=163.70..2741.16 rows=124 width=24) (actual time=0.120..0.813 rows=51 loops=1)
              Buffers: shared hit=1378
              ->  Nested Loop  (cost=163.28..1277.92 rows=124 width=27) (actual time=0.094..0.445 rows=51 loops=1)
                    Buffers: shared hit=711
                    ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=8) (actual time=0.086..0.277 rows=87 loops=1)
                          Buffers: shared hit=363
                          ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=0.078..0.092 rows=87 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=15
                                ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.022..0.061 rows=87 loops=1)
                                      Buffers: shared hit=15
                                      ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.012..0.012 rows=0 loops=1)
                                            Buffers: shared hit=3
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.011..0.012 rows=0 loops=1)
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
                          ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=8) (actual time=0.002..0.002 rows=1 loops=87)
                                Index Cond: (id = va.id)
                                Buffers: shared hit=348
                    ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=23) (actual time=0.002..0.002 rows=1 loops=87)
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
Planning Time: 14.833 ms
Execution Time: 0.915 ms
```

### pick latest version — name=hello

Parameters: `["hello"]` — Execution Time: 0.406 ms

```
Limit  (cost=2741.78..2741.78 rows=1 width=24) (actual time=0.322..0.324 rows=1 loops=1)
  Buffers: shared hit=443
  ->  Sort  (cost=2741.78..2742.09 rows=124 width=24) (actual time=0.321..0.322 rows=1 loops=1)
        Sort Key: (EXISTS(SubPlan 1)) DESC, ((SubPlan 2)) DESC, versions.sort_key DESC
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=443
        ->  Nested Loop  (cost=163.70..2741.16 rows=124 width=24) (actual time=0.122..0.310 rows=19 loops=1)
              Buffers: shared hit=443
              ->  Nested Loop  (cost=163.28..1277.92 rows=124 width=27) (actual time=0.098..0.167 rows=19 loops=1)
                    Buffers: shared hit=192
                    ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=8) (actual time=0.086..0.124 rows=19 loops=1)
                          Buffers: shared hit=116
                          ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=0.081..0.085 rows=19 loops=1)
                                Group Key: va.id
                                Batches: 1  Memory Usage: 40kB
                                Buffers: shared hit=40
                                ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.033..0.070 rows=38 loops=1)
                                      Buffers: shared hit=40
                                      ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.032..0.055 rows=19 loops=1)
                                            Buffers: shared hit=33
                                            ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.026..0.028 rows=5 loops=1)
                                                  Buffers: shared hit=8
                                                  ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.016..0.016 rows=1 loops=1)
                                                        Index Cond: (lower(name) = 'hello'::text)
                                                        Buffers: shared hit=4
                                                  ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.008..0.009 rows=5 loops=1)
                                                        Index Cond: (package_id = p.id)
                                                        Buffers: shared hit=4
                                            ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.003..0.005 rows=4 loops=5)
                                                  Index Cond: (version_id = ve.id)
                                                  Buffers: shared hit=25
                                      ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.007..0.012 rows=19 loops=1)
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
Planning Time: 15.379 ms
Execution Time: 0.406 ms
```

### every version — name=go

Parameters: `["go"]` — Execution Time: 8.774 ms

```
Limit  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=8.404..8.534 rows=722 loops=1)
  Buffers: shared hit=14677
  ->  Sort  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=8.402..8.474 rows=722 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 740kB
        Buffers: shared hit=14677
        ->  Nested Loop  (cost=164.40..1434.31 rows=125 width=1384) (actual time=1.197..7.575 rows=722 loops=1)
              Buffers: shared hit=14677
              ->  Nested Loop  (cost=164.12..1397.11 rows=125 width=1329) (actual time=1.192..6.506 rows=722 loops=1)
                    Buffers: shared hit=12511
                    ->  Nested Loop  (cost=163.70..1333.50 rows=125 width=346) (actual time=1.185..5.310 rows=722 loops=1)
                          Buffers: shared hit=9623
                          ->  Nested Loop  (cost=163.28..1277.92 rows=125 width=323) (actual time=1.180..4.179 rows=722 loops=1)
                                Buffers: shared hit=6735
                                ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=298) (actual time=1.175..2.931 rows=722 loops=1)
                                      Buffers: shared hit=3847
                                      ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=1.168..1.287 rows=722 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=959
                                            ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.032..0.980 rows=979 loops=1)
                                                  Buffers: shared hit=959
                                                  ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.032..0.818 rows=722 loops=1)
                                                        Buffers: shared hit=898
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.026..0.099 rows=191 loops=1)
                                                              Buffers: shared hit=23
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.014..0.014 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'go'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.010..0.059 rows=191 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=19
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.002..0.003 rows=4 loops=191)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=875
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.009..0.083 rows=257 loops=1)
                                                        Index Cond: (attr_path = 'go'::text)
                                                        Buffers: shared hit=61
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.002..0.002 rows=1 loops=722)
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
Planning Time: 19.857 ms
Execution Time: 8.774 ms
```

### every version — name=python

Parameters: `["python"]` — Execution Time: 7.473 ms

```
Limit  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=7.142..7.243 rows=648 loops=1)
  Buffers: shared hit=13083
  ->  Sort  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=7.140..7.187 rows=648 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 1294kB
        Buffers: shared hit=13083
        ->  Nested Loop  (cost=164.40..1434.31 rows=125 width=1384) (actual time=0.847..6.409 rows=648 loops=1)
              Buffers: shared hit=13083
              ->  Nested Loop  (cost=164.12..1397.11 rows=125 width=1329) (actual time=0.842..5.390 rows=648 loops=1)
                    Buffers: shared hit=11139
                    ->  Nested Loop  (cost=163.70..1333.50 rows=125 width=346) (actual time=0.835..4.308 rows=648 loops=1)
                          Buffers: shared hit=8547
                          ->  Nested Loop  (cost=163.28..1277.92 rows=125 width=323) (actual time=0.830..3.294 rows=648 loops=1)
                                Buffers: shared hit=5955
                                ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=298) (actual time=0.824..2.186 rows=648 loops=1)
                                      Buffers: shared hit=3363
                                      ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=0.816..0.934 rows=648 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 89kB
                                            Buffers: shared hit=771
                                            ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.028..0.690 rows=651 loops=1)
                                                  Buffers: shared hit=771
                                                  ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.028..0.616 rows=648 loops=1)
                                                        Buffers: shared hit=766
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.022..0.092 rows=177 loops=1)
                                                              Buffers: shared hit=23
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.013 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'python'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.007..0.055 rows=177 loops=1)
                                                                    Index Cond: (package_id = p.id)
                                                                    Buffers: shared hit=19
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (actual time=0.002..0.002 rows=4 loops=177)
                                                              Index Cond: (version_id = ve.id)
                                                              Buffers: shared hit=743
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.007..0.008 rows=3 loops=1)
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
Planning Time: 17.830 ms
Execution Time: 7.473 ms
```

### every version — name=python311

Parameters: `["python311"]` — Execution Time: 3.316 ms

```
Limit  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=3.172..3.187 rows=87 loops=1)
  Buffers: shared hit=1668
  ->  Sort  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=3.171..3.178 rows=87 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 199kB
        Buffers: shared hit=1668
        ->  Nested Loop  (cost=164.40..1434.31 rows=125 width=1384) (actual time=0.126..0.975 rows=87 loops=1)
              Buffers: shared hit=1668
              ->  Nested Loop  (cost=164.12..1397.11 rows=125 width=1329) (actual time=0.121..0.803 rows=87 loops=1)
                    Buffers: shared hit=1407
                    ->  Nested Loop  (cost=163.70..1333.50 rows=125 width=346) (actual time=0.115..0.633 rows=87 loops=1)
                          Buffers: shared hit=1059
                          ->  Nested Loop  (cost=163.28..1277.92 rows=125 width=323) (actual time=0.107..0.484 rows=87 loops=1)
                                Buffers: shared hit=711
                                ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=298) (actual time=0.099..0.314 rows=87 loops=1)
                                      Buffers: shared hit=363
                                      ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=0.089..0.109 rows=87 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=15
                                            ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.024..0.073 rows=87 loops=1)
                                                  Buffers: shared hit=15
                                                  ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.013..0.014 rows=0 loops=1)
                                                        Buffers: shared hit=3
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.013..0.014 rows=0 loops=1)
                                                              Buffers: shared hit=3
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.013..0.013 rows=0 loops=1)
                                                                    Index Cond: (lower(name) = 'python311'::text)
                                                                    Buffers: shared hit=3
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (never executed)
                                                                    Index Cond: (package_id = p.id)
                                                        ->  Index Scan using variants_identity_key on variants va  (cost=0.43..1.28 rows=13 width=8) (never executed)
                                                              Index Cond: (version_id = ve.id)
                                                  ->  Index Scan using variants_attr_path_idx on variants va_1  (cost=0.43..78.08 rows=109 width=4) (actual time=0.010..0.051 rows=87 loops=1)
                                                        Index Cond: (attr_path = 'python311'::text)
                                                        Buffers: shared hit=12
                                      ->  Index Scan using variants_pkey on variants  (cost=0.43..8.45 rows=1 width=302) (actual time=0.002..0.002 rows=1 loops=87)
                                            Index Cond: (id = va.id)
                                            Buffers: shared hit=348
                                ->  Index Scan using versions_pkey on versions  (cost=0.43..0.47 rows=1 width=33) (actual time=0.002..0.002 rows=1 loops=87)
                                      Index Cond: (id = variants.version_id)
                                      Buffers: shared hit=348
                          ->  Index Scan using packages_pkey on packages  (cost=0.42..0.44 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=87)
                                Index Cond: (id = versions.package_id)
                                Buffers: shared hit=348
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.001..0.001 rows=1 loops=87)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=348
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=87)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=261
Planning:
  Buffers: shared hit=114
Planning Time: 19.440 ms
Execution Time: 3.316 ms
```

### every version — name=hello

Parameters: `["hello"]` — Execution Time: 0.403 ms

```
Limit  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=0.310..0.315 rows=19 loops=1)
  Buffers: shared hit=401
  ->  Sort  (cost=1438.66..1438.97 rows=125 width=1384) (actual time=0.309..0.312 rows=19 loops=1)
        Sort Key: versions.sort_key DESC, variants.system, variants.attr_path
        Sort Method: quicksort  Memory: 63kB
        Buffers: shared hit=401
        ->  Nested Loop  (cost=164.40..1434.31 rows=125 width=1384) (actual time=0.106..0.281 rows=19 loops=1)
              Buffers: shared hit=401
              ->  Nested Loop  (cost=164.12..1397.11 rows=125 width=1329) (actual time=0.101..0.235 rows=19 loops=1)
                    Buffers: shared hit=344
                    ->  Nested Loop  (cost=163.70..1333.50 rows=125 width=346) (actual time=0.095..0.197 rows=19 loops=1)
                          Buffers: shared hit=268
                          ->  Nested Loop  (cost=163.28..1277.92 rows=125 width=323) (actual time=0.090..0.164 rows=19 loops=1)
                                Buffers: shared hit=192
                                ->  Nested Loop  (cost=162.85..1219.61 rows=125 width=298) (actual time=0.085..0.128 rows=19 loops=1)
                                      Buffers: shared hit=116
                                      ->  HashAggregate  (cost=162.42..163.67 rows=125 width=4) (actual time=0.078..0.084 rows=19 loops=1)
                                            Group Key: va.id
                                            Batches: 1  Memory Usage: 40kB
                                            Buffers: shared hit=40
                                            ->  Append  (cost=1.28..162.11 rows=125 width=4) (actual time=0.032..0.068 rows=38 loops=1)
                                                  Buffers: shared hit=40
                                                  ->  Nested Loop  (cost=1.28..83.40 rows=16 width=4) (actual time=0.031..0.053 rows=19 loops=1)
                                                        Buffers: shared hit=33
                                                        ->  Nested Loop  (cost=0.85..74.94 rows=6 width=4) (actual time=0.025..0.027 rows=5 loops=1)
                                                              Buffers: shared hit=8
                                                              ->  Index Scan using packages_name_lower_idx on packages p  (cost=0.42..8.44 rows=1 width=4) (actual time=0.015..0.015 rows=1 loops=1)
                                                                    Index Cond: (lower(name) = 'hello'::text)
                                                                    Buffers: shared hit=4
                                                              ->  Index Scan using versions_semver_idx on versions ve  (cost=0.43..66.18 rows=32 width=8) (actual time=0.008..0.009 rows=5 loops=1)
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
                    ->  Index Scan using meta_pkey on meta  (cost=0.42..0.51 rows=1 width=991) (actual time=0.002..0.002 rows=1 loops=19)
                          Index Cond: (id = variants.meta_id)
                          Buffers: shared hit=76
              ->  Index Scan using commits_pkey on commits commit_hash  (cost=0.28..0.30 rows=1 width=53) (actual time=0.002..0.002 rows=1 loops=19)
                    Index Cond: (seq = variants.commit_seq)
                    Buffers: shared hit=57
Planning:
  Buffers: shared hit=114
Planning Time: 17.474 ms
Execution Time: 0.403 ms
```

