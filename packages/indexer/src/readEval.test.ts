import { mkdtempSync, rmSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { constants as bufferConstants } from "node:buffer";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readEvalArchive } from "./readEval.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "readEval-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes {"a0":{...},"a1":{...},...} gzipped, streaming so the test itself never holds the text. */
async function writeArchive(path: string, entries: number, pad: string): Promise<void> {
  async function* chunks() {
    yield "{";
    for (let i = 0; i < entries; i++) {
      yield `${i > 0 ? "," : ""}${JSON.stringify(`a${i}`)}:{"name":"pkg-${i}","version":"1.0","meta":{"description":${JSON.stringify(pad)}}}`;
    }
    yield "}";
  }
  await pipeline(Readable.from(chunks()), createGzip({ level: 1 }), createWriteStream(path));
}

describe("readEvalArchive", () => {
  test("yields the top-level attr map with values intact", async () => {
    const path = join(dir, "small.json.gz");
    await writeArchive(path, 3, "x");
    const map = await readEvalArchive(path);
    expect(Object.keys(map)).toEqual(["a0", "a1", "a2"]);
    expect(map["a1"]).toEqual({ name: "pkg-1", version: "1.0", meta: { description: "x" } });
  });

  test("rejects malformed JSON instead of returning a partial map", async () => {
    const path = join(dir, "bad.json.gz");
    await pipeline(Readable.from(['{"a":{"name":1}, "b": {']), createGzip(), createWriteStream(path));
    await expect(readEvalArchive(path)).rejects.toThrow();
  });

  // A Linux eval is ~575 MB of JSON, past V8's MAX_STRING_LENGTH (~536 MB), so
  // reading it as text throws RangeError. Generate one just over the limit.
  // ~10 s and ~600 MB of temp disk; the fixture compresses to a few MB.
  test(
    "reads an archive whose JSON exceeds V8's max string length",
    async () => {
      const path = join(dir, "huge.json.gz");
      const pad = "d".repeat(64 * 1024);
      const entries = Math.ceil(bufferConstants.MAX_STRING_LENGTH / (pad.length + 80)) + 16;
      await writeArchive(path, entries, pad);

      const map = await readEvalArchive(path);
      expect(Object.keys(map)).toHaveLength(entries);
      expect((map[`a${entries - 1}`] as { name: string }).name).toBe(`pkg-${entries - 1}`);
    },
    120_000,
  );
});
