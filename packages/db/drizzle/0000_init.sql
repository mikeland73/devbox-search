-- pg_trgm backs the search_terms GIN indexes below (it replaces sqlite FTS5).
-- Supported on Neon. This statement is hand-added to the generated migration:
-- drizzle-kit does not emit extensions, and it must run before any
-- gin_trgm_ops index. Regenerating only ever appends new migration files, so
-- it stays put.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "commit_systems" (
	"commit_seq" integer NOT NULL,
	"system" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commit_systems_commit_seq_system_pk" PRIMARY KEY("commit_seq","system")
);
--> statement-breakpoint
CREATE TABLE "commits" (
	"seq" integer PRIMARY KEY NOT NULL,
	"hash" char(40) NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "meta_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"hash" char(64) NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"homepage" text DEFAULT '' NOT NULL,
	"license" text DEFAULT '' NOT NULL,
	"platforms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "meta_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "packages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_terms" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "search_terms_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"package_id" integer NOT NULL,
	"name" text NOT NULL,
	"attr_path" text NOT NULL,
	"top_level_attr" text
);
--> statement-breakpoint
CREATE TABLE "variant_ranges" (
	"variant_id" integer NOT NULL,
	"first_seq" integer NOT NULL,
	"last_seq" integer,
	"seeded" boolean DEFAULT false NOT NULL,
	CONSTRAINT "variant_ranges_variant_id_first_seq_pk" PRIMARY KEY("variant_id","first_seq")
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "variants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"version_id" integer NOT NULL,
	"system" text NOT NULL,
	"attr_path" text NOT NULL,
	"meta_id" integer NOT NULL,
	"commit_seq" integer NOT NULL,
	"store_hash" text DEFAULT '' NOT NULL,
	"store_name" text DEFAULT '' NOT NULL,
	"meta_name" text DEFAULT '' NOT NULL,
	"meta_version" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"program" text DEFAULT '' NOT NULL,
	"broken" boolean DEFAULT false NOT NULL,
	"insecure" boolean DEFAULT false NOT NULL,
	"outputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_hash" char(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"package_id" integer NOT NULL,
	"version" text NOT NULL,
	"sort_key" "bytea" NOT NULL,
	"prerelease" boolean DEFAULT false NOT NULL,
	"semver_major" integer,
	"semver_minor" integer,
	"semver_patch" integer,
	"semver_pre" text
);
--> statement-breakpoint
ALTER TABLE "commit_systems" ADD CONSTRAINT "commit_systems_commit_seq_commits_seq_fk" FOREIGN KEY ("commit_seq") REFERENCES "public"."commits"("seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_terms" ADD CONSTRAINT "search_terms_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_ranges" ADD CONSTRAINT "variant_ranges_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_ranges" ADD CONSTRAINT "variant_ranges_first_seq_commits_seq_fk" FOREIGN KEY ("first_seq") REFERENCES "public"."commits"("seq") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_ranges" ADD CONSTRAINT "variant_ranges_last_seq_commits_seq_fk" FOREIGN KEY ("last_seq") REFERENCES "public"."commits"("seq") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_meta_id_meta_id_fk" FOREIGN KEY ("meta_id") REFERENCES "public"."meta"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_commit_seq_commits_seq_fk" FOREIGN KEY ("commit_seq") REFERENCES "public"."commits"("seq") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commits_hash_key" ON "commits" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "commits_committed_at_idx" ON "commits" USING btree ("committed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "packages_name_key" ON "packages" USING btree ("name");--> statement-breakpoint
CREATE INDEX "packages_name_lower_idx" ON "packages" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "search_terms_key" ON "search_terms" USING btree ("name","attr_path");--> statement-breakpoint
CREATE INDEX "search_terms_name_trgm_idx" ON "search_terms" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_terms_attr_path_trgm_idx" ON "search_terms" USING gin ("attr_path" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_terms_name_lower_idx" ON "search_terms" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "variant_ranges_open_idx" ON "variant_ranges" USING btree ("variant_id") WHERE "variant_ranges"."last_seq" IS NULL;--> statement-breakpoint
CREATE INDEX "variant_ranges_span_idx" ON "variant_ranges" USING btree ("first_seq","last_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_identity_key" ON "variants" USING btree ("version_id","system","attr_path");--> statement-breakpoint
CREATE INDEX "variants_attr_path_idx" ON "variants" USING btree ("attr_path");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_package_version_key" ON "versions" USING btree ("package_id","version");--> statement-breakpoint
CREATE INDEX "versions_latest_idx" ON "versions" USING btree ("package_id","prerelease","sort_key" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "versions_semver_idx" ON "versions" USING btree ("package_id","semver_major","semver_minor","semver_patch");