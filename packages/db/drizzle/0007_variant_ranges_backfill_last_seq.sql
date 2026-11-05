-- Which part of a range the indexer's backfill wrote (schema.ts). Nullable
-- with no default, so this is a catalog-only change: no table rewrite.
ALTER TABLE "variant_ranges" ADD COLUMN "backfill_last_seq" integer;
