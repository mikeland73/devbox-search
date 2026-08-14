/**
 * Tests for the shadow-diff classifier (tools/shadow-diff.mjs).
 *
 * The gate for the migration is that every resolve divergence classifies
 * into a sanctioned change class, so the classifier's precision is what makes
 * the gate meaningful: it must NOT absorb an unexplained difference.
 */

import { describe, expect, test } from "vitest";
// @ts-expect-error - plain .mjs tool module, no types
import { classify } from "../../../tools/shadow-diff.mjs";

const rev = (s: string) => s.repeat(40).slice(0, 40);

function v2Resolve(version: string, revs: Record<string, string>, broken = false) {
  const systems: Record<string, unknown> = {};
  for (const [system, r] of Object.entries(revs)) {
    systems[system] = {
      flake_installable: {
        ref: { type: "github", owner: "NixOS", repo: "nixpkgs", rev: r },
        attr_path: "python311",
      },
      last_updated: "2026-08-01T16:34:20Z",
      ...(broken ? { broken: true } : {}),
    };
  }
  return { name: "python", version, summary: "s", systems };
}

/**
 * The package's versions as the new service reports them (/v1/pkg), newest
 * first under the new total order. This is the classifier's corroboration for
 * `latest` divergences.
 */
function known(...versions: Array<string | { version: string; broken: boolean }>) {
  return {
    versions: versions.map((v) => (typeof v === "string" ? { version: v, broken: false } : v)),
  };
}

describe("sanctioned classes", () => {
  test("#1 boundary matching: 3.1 stopped matching 3.11", () => {
    const path = "/v2/resolve?name=python&version=3.1";
    const old = v2Resolve("3.11.15", { "x86_64-linux": rev("a") });
    const next = v2Resolve("3.1.5", { "x86_64-linux": rev("a") });
    expect(classify(path, old, next)).toBe("boundary-matching");
  });

  test("#2 single hash: same version, four revs collapse to one", () => {
    const path = "/v2/resolve?name=python&version=3.11.9";
    const old = v2Resolve("3.11.9", {
      "aarch64-darwin": rev("a"),
      "aarch64-linux": rev("b"),
      "x86_64-darwin": rev("c"),
      "x86_64-linux": rev("d"),
    });
    const next = v2Resolve("3.11.9", {
      "aarch64-darwin": rev("e"),
      "aarch64-linux": rev("e"),
      "x86_64-darwin": rev("e"),
      "x86_64-linux": rev("e"),
    });
    expect(classify(path, old, next)).toBe("single-hash");
  });

  test("#3 broken skip: latest was broken, now isn't", () => {
    const path = "/v2/resolve?name=foo&version=latest";
    const old = v2Resolve("2.0.0", { "x86_64-linux": rev("a") }, true);
    const next = v2Resolve("1.9.0", { "x86_64-linux": rev("b") }, false);
    expect(classify(path, old, next)).toBe("broken-skip");
  });

  test("#4 sort order: latest resolves to a version the new order ranks higher", () => {
    const path = "/v2/resolve?name=_389-ds-base&version=latest";
    const old = v2Resolve("3.0.5", { "x86_64-linux": rev("a") });
    const next = v2Resolve("3.1.1", { "x86_64-linux": rev("b") });
    expect(classify(path, old, next, known("3.1.1", "3.0.5", "2.4.0"))).toBe("sort-order");
  });

  test("#3 broken skip in the v2 shape, which carries no broken field", () => {
    // The only evidence that this downgrade is sanctioned is the new service
    // reporting the old answer as broken.
    const path = "/v2/resolve?name=foo&version=latest";
    const old = v2Resolve("2.0.0", { "x86_64-linux": rev("a") });
    const next = v2Resolve("1.9.0", { "x86_64-linux": rev("b") });
    const versions = known({ version: "2.0.0", broken: true }, { version: "1.9.0", broken: false });
    expect(classify(path, old, next, versions)).toBe("broken-skip");
  });

  test("v1 array-shaped responses are classified too", () => {
    const path = "/v1/resolve?name=python&version=3.1";
    expect(classify(path, [{ version: "3.11.15" }], [{ version: "3.1.5" }])).toBe(
      "boundary-matching",
    );
  });
});

describe("classifier precision (the gate would be meaningless without this)", () => {
  test("same version and same revs with any other difference is NOT sanctioned", () => {
    const path = "/v2/resolve?name=python&version=latest";
    const old = v2Resolve("3.11.9", { "x86_64-linux": rev("a") });
    const next = {
      ...v2Resolve("3.11.9", { "x86_64-linux": rev("a") }),
      summary: "a summary that silently changed",
    };
    expect(classify(path, old, next)).toBeNull();
  });

  test("a rev that simply changed (not collapsed) is NOT sanctioned", () => {
    const path = "/v2/resolve?name=python&version=3.11.9";
    const old = v2Resolve("3.11.9", { "x86_64-linux": rev("a") });
    const next = v2Resolve("3.11.9", { "x86_64-linux": rev("b") });
    expect(classify(path, old, next)).toBeNull();
  });

  test("an exact-version request resolving to a different version is NOT sanctioned", () => {
    // Nothing about the sanctioned changes permits this.
    const path = "/v2/resolve?name=python&version=3.11.9";
    const old = v2Resolve("3.11.9", { "x86_64-linux": rev("a") });
    const next = v2Resolve("3.11.10", { "x86_64-linux": rev("a") });
    expect(classify(path, old, next)).toBeNull();
  });

  test("boundary matching does not excuse a version outside the requested range", () => {
    const path = "/v2/resolve?name=python&version=3.1";
    const old = v2Resolve("3.11.15", { "x86_64-linux": rev("a") });
    // 3.2.0 is not a boundary match for "3.1".
    const next = v2Resolve("3.2.0", { "x86_64-linux": rev("a") });
    expect(classify(path, old, next)).toBeNull();
  });

  test("a latest request resolving to a bogus version is NOT sort-order", () => {
    // `latest` is the CLI's most common request; if any divergence there
    // counted as a reordering, a resolve bug would ride through the gate.
    const path = "/v2/resolve?name=python&version=latest";
    const old = v2Resolve("3.11.9", { "x86_64-linux": rev("a") });
    const next = v2Resolve("0.0.0-garbage", { "x86_64-linux": rev("b") });
    expect(classify(path, old, next, known("3.12.1", "3.11.9", "3.10.4"))).toBeNull();
  });

  test("a latest request resolving to a lower-ranked version is NOT sort-order", () => {
    // A reordering can only move the answer up: the new service returns the
    // top of the same set under the new order. Nothing else explains this.
    const path = "/v2/resolve?name=python&version=latest";
    const old = v2Resolve("3.12.1", { "x86_64-linux": rev("a") });
    const next = v2Resolve("3.10.4", { "x86_64-linux": rev("b") });
    expect(classify(path, old, next, known("3.12.1", "3.11.9", "3.10.4"))).toBeNull();
  });

  test("a latest answer that vanished from the package is NOT sort-order", () => {
    // The old answer is not in the new service's version list at all, so the
    // candidate set changed — that is not the sanctioned comparator change.
    const path = "/v2/resolve?name=python&version=latest";
    const old = v2Resolve("3.11.9", { "x86_64-linux": rev("a") });
    const next = v2Resolve("3.12.1", { "x86_64-linux": rev("b") });
    expect(classify(path, old, next, known("3.12.1", "3.10.4"))).toBeNull();
  });

  test("sort-order is not assumed when the version list is unavailable", () => {
    const path = "/v2/resolve?name=python&version=latest";
    const old = v2Resolve("3.11.9", { "x86_64-linux": rev("a") });
    const next = v2Resolve("3.12.1", { "x86_64-linux": rev("b") });
    expect(classify(path, old, next)).toBeNull();
    expect(classify(path, old, next, { versions: null })).toBeNull();
  });

  test("a downgrade to another broken version is NOT broken-skip", () => {
    const path = "/v2/resolve?name=foo&version=latest";
    const old = v2Resolve("2.0.0", { "x86_64-linux": rev("a") });
    const next = v2Resolve("1.9.0", { "x86_64-linux": rev("b") });
    const versions = known({ version: "2.0.0", broken: true }, { version: "1.9.0", broken: true });
    expect(classify(path, old, next, versions)).toBeNull();
  });

  test("missing bodies are never classified", () => {
    expect(classify("/v2/resolve?name=x&version=latest", null, v2Resolve("1.0.0", {}))).toBeNull();
    expect(classify("/v2/resolve?name=x&version=latest", v2Resolve("1.0.0", {}), null)).toBeNull();
  });
});
