/**
 * Helpers for streaming rows into Postgres with COPY ... FROM STDIN (text
 * format), which is the only way to load 3.8M rows in reasonable time and
 * with near-zero egress.
 */

import type { PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

/** A value that can appear in a COPY text-format field. */
export type CopyValue = string | number | boolean | null | Uint8Array | object;

/**
 * Escapes one field for COPY text format. Postgres reads \N as NULL and
 * requires backslash, tab, newline and carriage return to be escaped.
 */
export function encodeCopyField(value: CopyValue): string {
  if (value === null || value === undefined) return "\\N";
  let s: string;
  if (value instanceof Uint8Array) {
    // bytea in COPY text format uses the hex input syntax.
    s = "\\x" + Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex");
  } else if (typeof value === "object") {
    s = JSON.stringify(value); // jsonb columns
  } else if (typeof value === "boolean") {
    s = value ? "t" : "f";
  } else {
    s = String(value);
  }
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

/** Encodes one row as a COPY text-format line (including the newline). */
export function encodeCopyRow(values: CopyValue[]): string {
  return values.map(encodeCopyField).join("\t") + "\n";
}

/**
 * COPYs rows produced by an (async) iterable into `table (columns...)`.
 * Returns the number of rows written.
 */
export async function copyRows(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: Iterable<CopyValue[]> | AsyncIterable<CopyValue[]>,
): Promise<number> {
  let count = 0;
  const source = Readable.from(
    (async function* () {
      for await (const row of rows as AsyncIterable<CopyValue[]>) {
        count++;
        yield encodeCopyRow(row);
      }
    })(),
  );
  const sink = client.query(
    copyFrom(`COPY ${table} (${columns.map((c) => `"${c}"`).join(", ")}) FROM STDIN`),
  );
  await pipeline(source, sink);
  return count;
}
