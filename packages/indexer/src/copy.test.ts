import { describe, expect, test } from "vitest";
import { encodeCopyField, encodeCopyRow } from "./copy.js";

describe("encodeCopyField", () => {
  test("null becomes the COPY NULL marker", () => {
    expect(encodeCopyField(null)).toBe("\\N");
  });

  test("booleans use Postgres text-format literals", () => {
    expect(encodeCopyField(true)).toBe("t");
    expect(encodeCopyField(false)).toBe("f");
  });

  test("bytea uses hex input syntax with the escape doubled", () => {
    // The leading backslash of \x must itself be escaped for COPY text format,
    // otherwise Postgres reads \x as an escape sequence.
    expect(encodeCopyField(Uint8Array.from([0x04, 0x01, 0xff]))).toBe("\\\\x0401ff");
  });

  test("bytea respects byteOffset for views into a larger buffer", () => {
    const backing = Uint8Array.from([9, 9, 1, 2, 3, 9]);
    expect(encodeCopyField(backing.subarray(2, 5))).toBe("\\\\x010203");
  });

  test("objects and arrays serialize as JSON for jsonb columns", () => {
    expect(encodeCopyField(["a", "b"])).toBe('["a","b"]');
    expect(encodeCopyField({ name: "out", default: true })).toBe('{"name":"out","default":true}');
  });

  test("escapes the characters COPY treats specially", () => {
    expect(encodeCopyField("a\tb")).toBe("a\\tb");
    expect(encodeCopyField("a\nb")).toBe("a\\nb");
    expect(encodeCopyField("a\r\nb")).toBe("a\\r\\nb");
    expect(encodeCopyField("a\\b")).toBe("a\\\\b");
    // A literal "\N" in data must not be read back as NULL.
    expect(encodeCopyField("\\N")).toBe("\\\\N");
  });

  test("leaves ordinary text (including unicode) alone", () => {
    expect(encodeCopyField("qué")).toBe("qué");
    expect(encodeCopyField("python3Packages.requests")).toBe("python3Packages.requests");
    expect(encodeCopyField(42)).toBe("42");
  });
});

describe("encodeCopyRow", () => {
  test("joins with tabs and terminates with a newline", () => {
    expect(encodeCopyRow([1, "go", null, true])).toBe("1\tgo\t\\N\tt\n");
  });

  test("embedded tabs in values cannot break the column count", () => {
    const line = encodeCopyRow(["a\tb", "c"]);
    expect(line.split("\t")).toHaveLength(2);
    expect(line).toBe("a\\tb\tc\n");
  });
});
