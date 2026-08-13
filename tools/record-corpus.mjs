#!/usr/bin/env node
/**
 * Phase-0 shadow-corpus recorder: replays a fixed request list against the
 * live search.devbox.sh service and stores byte-exact golden responses.
 *
 * The corpus feeds two things later in the migration:
 *   - golden tests for the ported response builders (PR 4)
 *   - the shadow-diff gate (every resolve divergence must classify into a
 *     sanctioned change class)
 *
 * Usage: node tools/record-corpus.mjs [outDir] [baseUrl]
 * Defaults: outDir=$HOME/devbox-search-data/shadow-corpus baseUrl=https://search.devbox.sh
 *
 * Output: <outDir>/corpus.jsonl, one JSON object per line:
 *   { id, path, status, headers: {selected}, body, bodyBase64?, recordedAt }
 * body is the exact response text; bodyBase64 is set instead when the body
 * is not valid UTF-8.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outDir = process.argv[2] ?? join(process.env.HOME, "devbox-search-data", "shadow-corpus");
const baseUrl = process.argv[3] ?? "https://search.devbox.sh";

// Names chosen to cover: canonical-name grouping (python/go/nodejs), plain
// attr paths, dotted attr paths (nodePackages.*), attr-path-vs-name lookups
// (python311), multi-output packages, prerelease-heavy packages, unicode,
// misses, and error shapes.
const NAMES = ["python", "go", "hello", "nodejs", "ruby", "php", "python311", "nodePackages.typescript", "gcc", "openssl"];
const VERSIONS = ["latest", "3", "3.11", "3.11.9", "1.22", "18", "9.99.99", ""];

const requests = [];
const add = (path) => requests.push(path);

add("/readyz");

// v2/resolve: the devbox CLI critical path.
for (const name of NAMES) {
  add(`/v2/resolve?name=${encodeURIComponent(name)}&version=latest`);
}
add("/v2/resolve?name=python&version=3");
add("/v2/resolve?name=python&version=3.11");
add("/v2/resolve?name=python&version=3.11.9");
add("/v2/resolve?name=python&version=3.1"); // old prefix semantics match 3.1*, incl. 3.11 (sanctioned change #1 target)
add("/v2/resolve?name=go&version=1.22");
add("/v2/resolve?name=go&version=1.2"); // prefix quirk: matches 1.2, 1.21, 1.22...
add("/v2/resolve?name=nodejs&version=18");
add("/v2/resolve?name=openssl&version=3");
add("/v2/resolve?name=hello&version=2.12.1");
add("/v2/resolve?name=doesnotexist12345&version=latest"); // miss shape
add("/v2/resolve?name=python&version=9.99.99"); // version miss shape
add("/v2/resolve?name=python"); // missing version error shape
add("/v2/resolve?version=latest"); // missing name error shape
add("/v2/resolve?name=python&version=%25"); // LIKE wildcard hygiene probe
add("/v2/resolve?name=python&version=3_11"); // LIKE underscore probe

// v1/resolve and /resolve (+system).
for (const path of ["/v1/resolve", "/resolve"]) {
  add(`${path}?name=python&version=latest`);
  add(`${path}?name=python&version=3.11`);
  add(`${path}?name=go&version=latest`);
  add(`${path}?name=hello&version=latest`);
  add(`${path}?name=python&version=latest&system=aarch64-darwin`);
  add(`${path}?name=python&version=3.11&system=x86_64-linux`);
  add(`${path}?name=doesnotexist12345&version=latest`);
  add(`${path}?name=python`); // missing version shape
}

// v2/pkg.
for (const name of ["go", "python", "hello", "nodePackages.typescript", "openssl", "doesnotexist12345"]) {
  add(`/v2/pkg?name=${encodeURIComponent(name)}`);
}
add("/v2/pkg"); // missing name error shape

// v1/pkg + legacy /pkg (path form takes everything after the first segment).
add("/v1/pkg?name=go");
add("/v1/pkg?name=python");
add("/v1/pkg?name=doesnotexist12345");
add("/pkg/go");
add("/pkg/nodePackages.typescript"); // dots in path
add("/pkg?name=hello");
add("/pkg/"); // empty name shape

// Search endpoints.
for (const q of ["go", "python", "sqlite", "web server", "qué", "c++"]) {
  add(`/v2/search?q=${encodeURIComponent(q)}`);
  add(`/v1/search?q=${encodeURIComponent(q)}`);
}
add("/db/search?q=go");
add("/v2/search?q="); // empty query error shape
add("/search?q=go");
add("/search?q=python&v=3.11");
add("/search?q=python&v=latest");
add("/search?q=go&v=latest");

async function main() {
  await mkdir(outDir, { recursive: true });
  const lines = [];
  let failures = 0;
  for (const [i, path] of requests.entries()) {
    const url = baseUrl + path;
    try {
      const res = await fetch(url, {
        headers: { "Accept-Encoding": "identity", "User-Agent": "devbox-search-shadow-recorder/1" },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const text = buf.toString("utf8");
      const utf8Ok = Buffer.from(text, "utf8").equals(buf);
      const headers = {};
      for (const h of ["content-type", "cache-control", "etag", "content-encoding"]) {
        const v = res.headers.get(h);
        if (v !== null) headers[h] = v;
      }
      const entry = {
        id: i,
        path,
        status: res.status,
        headers,
        ...(utf8Ok ? { body: text } : { bodyBase64: buf.toString("base64") }),
        recordedAt: new Date().toISOString(),
      };
      lines.push(JSON.stringify(entry));
      console.log(`${res.status} ${path} (${buf.length}B)`);
    } catch (err) {
      failures++;
      console.error(`FAIL ${path}: ${err}`);
    }
    await new Promise((r) => setTimeout(r, 150)); // be polite
  }
  const outFile = join(outDir, "corpus.jsonl");
  await writeFile(outFile, lines.join("\n") + "\n");
  console.log(`\nwrote ${lines.length} responses to ${outFile} (${failures} failures)`);
  if (failures > 0) process.exitCode = 1;
}

await main();
