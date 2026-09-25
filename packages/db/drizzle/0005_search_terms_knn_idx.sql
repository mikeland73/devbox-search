CREATE INDEX "search_terms_top_level_name_knn_idx" ON "search_terms" USING gist (lower("name") gist_trgm_ops) WHERE ("search_terms"."name" = "search_terms"."attr_path") IS TRUE AND "search_terms"."top_level_attr" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "search_terms_nested_name_knn_idx" ON "search_terms" USING gist (lower("name") gist_trgm_ops) WHERE ("search_terms"."name" = "search_terms"."attr_path") IS TRUE AND "search_terms"."top_level_attr" IS NULL;--> statement-breakpoint
CREATE INDEX "search_terms_alias_idx" ON "search_terms" USING btree ("package_id") WHERE ("search_terms"."name" = "search_terms"."attr_path") IS FALSE;--> statement-breakpoint
-- Hand-written: drizzle does not model statistics objects. The planner
-- estimates the (name = attr_path) IS TRUE / IS FALSE predicates above from
-- these, and they are empty until ANALYZE (see searchTerms in schema.ts).
CREATE STATISTICS "search_terms_same_name_stats" ON (("name" = "attr_path")) FROM "search_terms";--> statement-breakpoint
ANALYZE "search_terms";
