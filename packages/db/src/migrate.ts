/**
 * Applies pending migrations using the direct (unpooled) connection.
 *
 * Usage: DATABASE_URL_DIRECT=... node dist/migrate.js
 *
 * Idempotent: an up-to-date database is a no-op that says so. Run by
 * .github/workflows/migrate.yml on every merge that touches drizzle/, and by
 * hand (workflow_dispatch) before a seed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";
import { createImportClient } from "./client.js";

export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

interface JournalEntry {
  tag: string;
  /** Generation time in ms; drizzle's migrator orders and de-duplicates on this. */
  when: number;
}

function journalEntries(): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

/**
 * Every migration statement, in journal order. For tests that apply the DDL
 * to an in-process Postgres: reading the journal (rather than naming files)
 * means a new migration is exercised the moment drizzle-kit generates it.
 */
export function migrationStatements(): string[] {
  return journalEntries().flatMap((entry) =>
    readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
}

/**
 * Tags drizzle's migrator will apply on the next run: every journal entry
 * newer than the last row of drizzle.__drizzle_migrations (the same rule the
 * migrator uses). A database with no migrations table has everything pending.
 */
export async function pendingMigrations(pool: pg.Pool): Promise<string[]> {
  const table = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`,
  );
  let appliedThrough = 0;
  if (table.rows[0]?.exists === true) {
    // created_at is a bigint, which pg returns as a string.
    const last = await pool.query<{ created_at: string }>(
      `SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
    );
    appliedThrough = Number(last.rows[0]?.created_at ?? 0);
  }
  return journalEntries()
    .filter((entry) => entry.when > appliedThrough)
    .map((entry) => entry.tag);
}

/** Applies pending migrations and returns the tags that were applied. */
export async function runMigrations(connectionString?: string): Promise<string[]> {
  const { db, pool } = createImportClient(connectionString);
  try {
    const pending = await pendingMigrations(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return pending;
  } finally {
    await pool.end();
  }
}

// Run when invoked directly (not when imported by tests).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const applied = await runMigrations();
  const head = journalEntries().at(-1)?.tag ?? "(no migrations)";
  if (applied.length === 0) console.log(`up to date: ${head}`);
  else console.log(`applied ${applied.length} migration(s): ${applied.join(", ")} — now at ${head}`);
}
