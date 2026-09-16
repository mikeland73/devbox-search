/**
 * Applies pending migrations using the direct (unpooled) connection.
 *
 * Usage: DATABASE_URL_DIRECT=... node --experimental-strip-types src/migrate.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createImportClient } from "./client.js";

export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

/**
 * Every migration statement, in journal order. For tests that apply the DDL
 * to an in-process Postgres: reading the journal (rather than naming files)
 * means a new migration is exercised the moment drizzle-kit generates it.
 */
export function migrationStatements(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  return journal.entries.flatMap((entry) =>
    readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
}

export async function runMigrations(connectionString?: string): Promise<void> {
  const { db, pool } = createImportClient(connectionString);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

// Run when invoked directly (not when imported by tests).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runMigrations();
  console.log("migrations applied");
}
