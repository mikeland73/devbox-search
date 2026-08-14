/**
 * Thin wrapper around `nix-env`, keeping the invocation the Go indexer used
 * verbatim (internal/nixpkgs/eval.go Evaluate).
 *
 * Two details that are load-bearing:
 *   - packages-config.nix forces nix-env to descend into attribute sets it
 *     would otherwise skip, which is how nodePackages.* etc. get indexed;
 *   - darwin systems evaluate fine on Linux runners, because this is pure
 *     evaluation, not building.
 *
 * Output is written straight to a zstd file rather than buffered: the JSON is
 * ~1-2 GB uncompressed.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

/** The allowUnfree/allowInsecure config the old indexer passed. */
export const BASE_CONFIG =
  "{ allowInsecure = true; allowInsecurePredicate = (pkg: true); allowUnfree = true; allowUnfreePredicate = (pkg: true); }";

/**
 * Builds the `--arg config` expression, merging nixpkgs' own
 * packages-config.nix when the checkout has it.
 */
export function configExpression(nixpkgsDir: string): string {
  const configPath = join(nixpkgsDir, "pkgs/top-level/packages-config.nix");
  return existsSync(configPath) ? `(import ${configPath}) // ${BASE_CONFIG}` : BASE_CONFIG;
}

/** The exact nix-env argument vector, kept identical to the Go indexer's. */
export function nixEnvArgs(nixpkgsDir: string, system: string): string[] {
  return [
    "--file",
    join(nixpkgsDir, "default.nix"),
    "--query",
    "--available",
    "--meta",
    "--out-path",
    "--show-trace",
    "--json",
    "--arg",
    "config",
    configExpression(nixpkgsDir),
    "--argstr",
    "system",
    system,
  ];
}

export interface EvaluateOptions {
  nixpkgsDir: string;
  system: string;
  /** Where to write the gzipped JSON. */
  outputPath: string;
  /** Extra environment, e.g. GC_INITIAL_HEAP_SIZE. */
  env?: NodeJS.ProcessEnv;
  onProgress?: (message: string) => void;
}

export interface EvaluateResult {
  outputPath: string;
  bytes: number;
}

/**
 * Runs nix-env and streams its stdout through gzip into outputPath.
 *
 * Rejects with the tail of stderr on failure — nix's evaluation errors are
 * long, and the last lines are the useful part.
 */
export async function evaluate(options: EvaluateOptions): Promise<EvaluateResult> {
  const log = options.onProgress ?? (() => {});
  const args = nixEnvArgs(options.nixpkgsDir, options.system);
  log(`nix-env ${args.join(" ")}`);

  const child = spawn("nix-env", args, {
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
    // Keep only the tail; a failing eval can emit megabytes of trace.
    if (stderrChunks.length > 200) stderrChunks.splice(0, stderrChunks.length - 200);
  });

  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`nix-env exited with code ${code}:\n${stderrChunks.join("").slice(-8000)}`));
    });
  });

  await Promise.all([
    pipeline(child.stdout, createGzip({ level: 9 }), createWriteStream(options.outputPath)),
    exited,
  ]);

  const { size } = await stat(options.outputPath);
  log(`wrote ${options.outputPath} (${(size / 1e6).toFixed(1)} MB compressed)`);
  return { outputPath: options.outputPath, bytes: size };
}

/** The archive key for an eval, matching the old S3 layout. */
export function archiveKey(system: string, committedAt: Date, hash: string): string {
  return `${system}/${Math.floor(committedAt.getTime() / 1000)}-${hash}.json.gz`;
}
