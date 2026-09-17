ALTER TABLE "variants" ALTER COLUMN "store_hash" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_store_hash_nonempty" CHECK ("variants"."store_hash" <> '');