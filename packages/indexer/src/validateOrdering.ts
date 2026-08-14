/**
 * Seed-time validation that needs no database: scan the compact sqlite DB and
 * diff the new byte-comparable sort_key ordering against sqlite's dense-int
 * version_sort, enumerating every divergence.
 *
 * Sanctioned change #4 replaced a non-transitive comparator, so divergences
 * are expected. The plan requires them to be enumerated and eyeballed rather
 * than gated, which is what this produces. It also reports prerelease-flag
 * divergences, where the expectation IS zero (prerelease() is a faithful
 * port).
 *
 *   node --experimental-strip-types src/validateOrdering.ts <compact.db> [--out report.txt]
 */

import { createWriteStream } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { isPrerelease } from "@devbox-search/core";
import { compareVersionOrder, packageKey } from "./seedTransform.js";
import { NAME_VERSION_SQL } from "./sqliteQueries.js";

export interface OrderingReport {
  packages: number;
  versions: number;
  packagesWithDivergence: number;
  divergences: Array<{ package: string; a: string; b: string }>;
  prereleaseDivergences: Array<{ package: string; version: string; old: boolean; new: boolean }>;
}

export function validateOrdering(
  sqlitePath: string,
  onProgress: (m: string) => void = () => {},
): OrderingReport {
  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    // Same query the seed's versions pass runs, so this report describes
    // exactly the row set that will be seeded.
    const stmt = sqlite.prepare<[], {
      name: string;
      version: string;
      version_sort: number;
      prerelease: number;
    }>(NAME_VERSION_SQL);

    const report: OrderingReport = {
      packages: 0,
      versions: 0,
      packagesWithDivergence: 0,
      divergences: [],
      prereleaseDivergences: [],
    };

    let currentPackage = "";
    let buffered: Array<{ version: string; versionSort: number }> = [];
    const flush = () => {
      if (currentPackage === "") return;
      report.packages++;
      if (buffered.length < 2) return;
      const found = compareVersionOrder(buffered);
      if (found.length > 0) report.packagesWithDivergence++;
      for (const d of found) {
        report.divergences.push({ package: currentPackage, a: d.a, b: d.b });
      }
    };

    for (const row of stmt.iterate()) {
      // Bucket by lower(name): sqlite's NOCASE collation makes case
      // variants one package, and GROUP BY can emit different spellings
      // for different versions of that same package.
      if (packageKey(row.name) !== currentPackage) {
        flush();
        currentPackage = packageKey(row.name);
        buffered = [];
        if (report.packages % 25_000 === 0 && report.packages > 0) {
          onProgress(`  ${report.packages} packages, ${report.divergences.length} divergences`);
        }
      }
      buffered.push({ version: row.version, versionSort: row.version_sort });
      report.versions++;

      const isPre = isPrerelease(row.version);
      if (isPre !== (row.prerelease === 1)) {
        report.prereleaseDivergences.push({
          package: row.name,
          version: row.version,
          old: row.prerelease === 1,
          new: isPre,
        });
      }
    }
    flush();
    return report;
  } finally {
    sqlite.close();
  }
}

export async function writeOrderingReport(report: OrderingReport, path: string): Promise<void> {
  const out = createWriteStream(path);
  const write = (s: string) => out.write(s + "\n");
  write("# Version ordering validation: new sort_key vs sqlite version_sort\n");
  write(`packages scanned:          ${report.packages}`);
  write(`name+version pairs:        ${report.versions}`);
  write(`packages with divergence:  ${report.packagesWithDivergence}`);
  write(`divergent pairs:           ${report.divergences.length}`);
  write(`prerelease divergences:    ${report.prereleaseDivergences.length} (expected 0)\n`);
  write("## Divergent pairs");
  write("Each line: the new order says a < b; sqlite's version_sort said b < a.\n");
  for (const d of report.divergences) {
    write(`${d.package}\t${d.a}\t<\t${d.b}`);
  }
  write("\n## Prerelease flag divergences\n");
  for (const d of report.prereleaseDivergences) {
    write(`${d.package}@${d.version}\tsqlite=${d.old}\tnew=${d.new}`);
  }
  await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
}

if (process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sqlitePath = process.argv[2];
  if (sqlitePath === undefined) {
    console.error("usage: validateOrdering.ts <compact.db> [--out report.txt]");
    process.exit(2);
  }
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx === -1 ? "ordering-report.txt" : process.argv[outIdx + 1]!;
  const report = validateOrdering(sqlitePath, (m) => console.log(m));
  await writeOrderingReport(report, outPath);
  console.log(
    `packages=${report.packages} versions=${report.versions} ` +
      `divergentPairs=${report.divergences.length} packagesWithDivergence=${report.packagesWithDivergence} ` +
      `prereleaseDivergences=${report.prereleaseDivergences.length}`,
  );
  console.log(`report written to ${outPath}`);
}
