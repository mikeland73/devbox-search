/**
 * Regenerates docs/apis/README.md from docs/apis/openapi.yaml and the route
 * handlers. Run with `pnpm --filter @devbox-search/web gen:api-docs`; pass
 * --check to only verify the committed copy is current (exit 1 otherwise).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { generateApiDocs, README_PATH } from "../lib/apiDocs";

const check = process.argv.includes("--check");
const markdown = await generateApiDocs();
const displayPath = relative(process.cwd(), README_PATH);

if (check) {
  let current = "";
  try {
    current = readFileSync(README_PATH, "utf8");
  } catch {
    // Missing counts as stale.
  }
  if (current !== markdown) {
    console.error(`${displayPath} is out of date; run pnpm --filter @devbox-search/web gen:api-docs`);
    process.exit(1);
  }
  console.log(`${displayPath} is up to date`);
} else {
  writeFileSync(README_PATH, markdown);
  console.log(`wrote ${displayPath}`);
}
