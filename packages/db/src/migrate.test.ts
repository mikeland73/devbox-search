import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type pg from "pg";
import { MIGRATIONS_FOLDER, pendingMigrations } from "./migrate.js";

/** A pool that answers the two queries pendingMigrations makes. */
function poolWith(state: { table: boolean; lastCreatedAt?: string }): pg.Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes("to_regclass")) return { rows: [{ exists: state.table }] };
      return { rows: state.lastCreatedAt === undefined ? [] : [{ created_at: state.lastCreatedAt }] };
    },
  } as unknown as pg.Pool;
}

// Tags in journal order, from the real journal so the test tracks new migrations.
const tags = (
  JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  }
).entries.map((e) => e.tag);

describe("pendingMigrations", () => {
  test("everything is pending on a database without the migrations table", async () => {
    expect(await pendingMigrations(poolWith({ table: false }))).toEqual(tags);
  });

  test("everything is pending when the table exists but is empty", async () => {
    expect(await pendingMigrations(poolWith({ table: true }))).toEqual(tags);
  });

  test("only entries newer than the last applied row are pending", async () => {
    // 0001_semver_bigint was generated at 1789581801306; a database that
    // stopped there has 0002/0003 unapplied — the shape a real catch-up has.
    const pending = await pendingMigrations(poolWith({ table: true, lastCreatedAt: "1789581801306" }));
    expect(pending).toEqual(tags.slice(2));
  });

  test("nothing is pending when the head is applied", async () => {
    const pending = await pendingMigrations(poolWith({ table: true, lastCreatedAt: String(Number.MAX_SAFE_INTEGER) }));
    expect(pending).toEqual([]);
  });
});
