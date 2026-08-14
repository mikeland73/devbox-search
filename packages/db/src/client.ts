/**
 * Database client factories.
 *
 * Two drivers, for two very different access patterns:
 *
 *   - neon-http (serving): one HTTP round trip per query, no connection to
 *     hold open. Right for Vercel route handlers, where connections can't be
 *     pooled across invocations. No transactions or COPY.
 *   - node-postgres (import/seed): a real session, which COPY and
 *     pg_advisory_lock both require. Must use the DIRECT (unpooled) Neon
 *     endpoint — the pooled endpoint is transaction-mode pgbouncer.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type ServingDb = ReturnType<typeof createServingClient>;
export type ImportDb = ReturnType<typeof drizzleNode<typeof schema>>;

/**
 * Creates the serving client used by the API route handlers.
 *
 * @param connectionString defaults to $DATABASE_URL. Either the pooled or the
 * direct endpoint works here since every query is a standalone HTTP request.
 */
export function createServingClient(connectionString = requireEnv("DATABASE_URL")) {
  return drizzleHttp(neon(connectionString), { schema });
}

/**
 * Creates a pooled node-postgres client plus its pool, for the indexer and
 * seed. Callers must `await pool.end()` when done.
 *
 * @param connectionString defaults to $DATABASE_URL_DIRECT, falling back to
 * $DATABASE_URL. Point this at the direct (unpooled) endpoint: COPY and
 * session-level advisory locks do not work through pgbouncer in transaction
 * mode.
 */
export function createImportClient(
  connectionString = process.env["DATABASE_URL_DIRECT"] ?? requireEnv("DATABASE_URL"),
  options: { max?: number } = {},
): { db: ImportDb; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 1,
    // Imports run long set-based statements; don't let the driver give up.
    statement_timeout: 0,
    idle_in_transaction_session_timeout: 0,
  });
  return { db: drizzleNode(pool, { schema }), pool };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

export { schema };
