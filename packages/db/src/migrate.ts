/**
 * Applies pending migrations using the direct (unpooled) connection.
 *
 * Usage: DATABASE_URL_DIRECT=... node --experimental-strip-types src/migrate.ts
 */

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createImportClient } from "./client.js";

export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

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
