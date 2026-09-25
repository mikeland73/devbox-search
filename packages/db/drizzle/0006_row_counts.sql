CREATE TABLE "row_counts" (
	"table_name" text PRIMARY KEY NOT NULL,
	"row_count" bigint NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Hand-written: the first counts, so /status has numbers before the next
-- import. The same statement as REFRESH_ROW_COUNTS in schema.ts, which
-- every import and the seed run from now on.
INSERT INTO "row_counts" ("table_name", "row_count", "counted_at")
VALUES ('packages', (SELECT count(*) FROM "packages"), now()),
       ('versions', (SELECT count(*) FROM "versions"), now()),
       ('variants', (SELECT count(*) FROM "variants"), now()),
       ('variant_ranges', (SELECT count(*) FROM "variant_ranges"), now()),
       ('meta', (SELECT count(*) FROM "meta"), now()),
       ('search_terms', (SELECT count(*) FROM "search_terms"), now()),
       ('commits', (SELECT count(*) FROM "commits"), now());
