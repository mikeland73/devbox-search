/**
 * Keeps docs/apis in step with the code: every route.ts must be in the
 * OpenAPI spec (and vice versa), and the committed README must match what
 * the generator produces today.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  checkCoverage,
  discoverRoutes,
  fsRouteToSpecPaths,
  generateApiDocs,
  loadSpec,
  oneLine,
  README_PATH,
} from "./apiDocs";

describe("route discovery", () => {
  test("maps Next.js route directories to OpenAPI paths", () => {
    expect(fsRouteToSpecPaths("v2/resolve")).toEqual(["/v2/resolve"]);
    expect(fsRouteToSpecPaths("pkg/[[...name]]")).toEqual(["/pkg", "/pkg/{name}"]);
    expect(fsRouteToSpecPaths("a/[...rest]")).toEqual(["/a/{rest}"]);
    expect(fsRouteToSpecPaths("(group)/x/[id]")).toEqual(["/x/{id}"]);
    expect(fsRouteToSpecPaths("")).toEqual(["/"]);
  });

  test("every route.ts is documented in openapi.yaml, and nothing else is", () => {
    expect(checkCoverage(loadSpec(), discoverRoutes())).toEqual([]);
  });
});

describe("oneLine", () => {
  test("collapses newlines and escapes table-cell delimiters", () => {
    expect(oneLine("  a\n  b  ")).toBe("a b");
    expect(oneLine("a | b")).toBe("a \\| b");
  });

  test("escapes backslashes so an input `\\|` cannot become a live delimiter", () => {
    expect(oneLine("a \\ b")).toBe("a \\\\ b");
    expect(oneLine("a \\| b")).toBe("a \\\\\\| b");
  });
});

describe("docs/apis/README.md", () => {
  test("is what the generator produces (run: pnpm --filter @devbox-search/web gen:api-docs)", async () => {
    const generated = await generateApiDocs();
    expect(readFileSync(README_PATH, "utf8")).toBe(generated);
  }, 120_000);
});
