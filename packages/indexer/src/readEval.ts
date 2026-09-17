/**
 * Reads a gzipped nix-env eval archive into the attr-path -> package map.
 *
 * Streamed, not `JSON.parse(await text(...))`: a Linux eval is ~575 MB of
 * JSON, past V8's ~536 MB string limit, so materializing the text throws
 * `RangeError: Invalid string length` (the darwin evals at ~500 MB only just
 * fit and are growing). The parsed object is fine — it's the single string
 * that can't exist. Top-level entries are parsed one at a time and assembled
 * into a plain object, which is what decodeEvalJson expects.
 */

import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import streamObject from "stream-json/streamers/stream-object.js";

export async function readEvalArchive(path: string): Promise<Record<string, unknown>> {
  const attrMap: Record<string, unknown> = {};
  const entries = streamObject.withParserAsStream();
  entries.on("data", ({ key, value }: { key: string; value: unknown }) => {
    attrMap[key] = value;
  });
  await pipeline(createReadStream(path), createGunzip(), entries);
  return attrMap;
}
