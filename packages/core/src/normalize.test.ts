import { describe, expect, test } from "vitest";
import { escapeLike, normalize, splitStorePath } from "./normalize.js";

describe("normalize", () => {
  test("NFD-decomposes combining characters", () => {
    // U+00E9 is precomposed \u00e9; NFD decomposes it to e + U+0301.
    expect(normalize("\u00e9")).toBe("e\u0301");
    expect(normalize("qu\u00e9")).toBe("que\u0301");
    expect(normalize("ascii")).toBe("ascii");
  });

  test("trims whitespace like Go's strings.TrimSpace", () => {
    expect(normalize("  hello \t\n")).toBe("hello");
    // NBSP (U+00A0) and NEL (U+0085) have the White_Space property.
    expect(normalize("\u00a0hello\u0085")).toBe("hello");
    expect(normalize("a b")).toBe("a b");
    expect(normalize("")).toBe("");
  });
});

describe("escapeLike", () => {
  test("escapes LIKE wildcards and the escape character", () => {
    expect(escapeLike("3.1")).toBe("3.1");
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("%_\\")).toBe("\\%\\_\\\\");
  });
});

describe("splitStorePath", () => {
  // Ported from Go's TestSplitStorePath (eval_test.go). Name and version are
  // verified by passing the input WITHOUT the hash into:
  //
  //   nix eval --expr 'builtins.parseDrvName "<INPUT>"'
  const cases: Array<[string, string, string, string]> = [
    ["", "", "", ""],
    ["libcxxabi-11.1.0", "", "", ""],
    ["04bkn190n3gm6k8lc44wcww3wi84sxjy", "04bkn190n3gm6k8lc44wcww3wi84sxjy", "", ""],
    ["04bkn190n3gm6k8lc44wcww3wi84sxjy-", "04bkn190n3gm6k8lc44wcww3wi84sxjy", "", ""],
    ["04bkn190n3gm6k8lc44wcww3wi84sxjy-libcxxabi", "04bkn190n3gm6k8lc44wcww3wi84sxjy", "libcxxabi", ""],
    [
      "/nix/store/04bkn190n3gm6k8lc44wcww3wi84sxjy-libcxxabi-11.1.0",
      "04bkn190n3gm6k8lc44wcww3wi84sxjy",
      "libcxxabi",
      "11.1.0",
    ],
    ["04bkn190n3gm6k8lc44wcww3wi84sxjy-libcxxabi-", "04bkn190n3gm6k8lc44wcww3wi84sxjy", "libcxxabi-", ""],
    [
      "nlysgnb0w8vg4md7x0zvgfcba32ars9l-apple-framework-Foundation",
      "nlysgnb0w8vg4md7x0zvgfcba32ars9l",
      "apple-framework-Foundation",
      "",
    ],
    [
      "nlysgnb0w8vg4md7x0zvgfcba32ars9l-apple-framework-Foundation-",
      "nlysgnb0w8vg4md7x0zvgfcba32ars9l",
      "apple-framework-Foundation-",
      "",
    ],
    [
      "nlysgnb0w8vg4md7x0zvgfcba32ars9l-apple-framework-Foundation-11.0.0",
      "nlysgnb0w8vg4md7x0zvgfcba32ars9l",
      "apple-framework-Foundation",
      "11.0.0",
    ],
    [
      "nlysgnb0w8vg4md7x0zvgfcba32ars9l-apple-framework-Foundation-11.0.0-",
      "nlysgnb0w8vg4md7x0zvgfcba32ars9l",
      "apple-framework-Foundation",
      "11.0.0-",
    ],
    [
      "jvp004wlg7j05dzx67f6dgh7sjz1lwck-go-1.19.6.drv",
      "jvp004wlg7j05dzx67f6dgh7sjz1lwck",
      "go",
      "1.19.6.drv",
    ],
  ];

  test.each(cases)("%s", (input, hash, name, version) => {
    expect(splitStorePath(input)).toEqual({ hash, name, version });
  });
});
