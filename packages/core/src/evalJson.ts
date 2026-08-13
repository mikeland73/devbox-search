/**
 * Decodes the JSON produced by evaluating nixpkgs with nix-env into cleaned,
 * canonical package records, and provides the canonical serializer + hashing
 * used for content-addressed metadata dedup and cheap variant diffing.
 *
 * Ported from axiom/devbox-search internal/nixpkgs/{eval,hydra}.go. Two input
 * schemas are supported:
 *
 *   - "nix-env": a map of attribute path -> package, as output by
 *     `nix-env -qa --meta --out-path --json`.
 *   - "hydra": the same map wrapped in a top-level object under a "packages"
 *     field (Hydra's packages.json).
 *
 * The legacy pkgmeta.nix array schema is not ported; it only exists in old
 * archived files that the new pipeline never reads.
 */

import { createHash } from "node:crypto";
import { canonicalName } from "./devpkg.js";
import { normalize, splitStorePath } from "./normalize.js";

/** A store path that's the result of building a package. */
export interface Output {
  /**
   * The output's name. Nix appends the name to the output's store path
   * unless it's the default name of "out". Conventionally names follow the
   * various "make install" directories such as "bin", "lib", "man", etc.
   */
  name: string;
  /** The absolute store path (with the /nix/store/ prefix) of the output. */
  path: string;
  /** Whether Nix installs this output by default. */
  default: boolean;
}

/** A cleaned package record for one attribute path on one system. */
export interface EvalPackage {
  storeHash: string;
  storeName: string;
  storeVersion: string;
  metaName: string;
  metaVersion: string[];
  attrPath: string;
  system: string;
  program: string;
  summary: string;
  description: string;
  homepage: string;
  license: string;
  broken: boolean;
  insecure: boolean;
  platforms: string[];
  /** The order matters: the first output is the default. */
  outputs: Output[];
}

/** The result of evaluating nixpkgs at a specific commit on a specific system. */
export interface Eval {
  commit: string;
  system: string;
  committedAt: Date;
  count: number;
  packages: EvalPackage[];
}

// ---------------------------------------------------------------------------
// Tolerant JSON access
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function bool(v: unknown): boolean {
  return v === true;
}

/**
 * Flattens a "one or many" field to an array of non-array values: a single
 * value wraps into an array, arrays flatten recursively (an old nixpkgs bug
 * produced nested platform arrays such as [["a"],["b"]]), and null/undefined
 * become an empty array. Port of Go's oneOrMany.
 */
function oneOrMany(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(oneOrMany);
  return [v];
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decodes nix-env or Hydra eval JSON. Accepts the already-parsed JSON value.
 * Throws a TypeError when the top-level shape is not one of the two supported
 * schemas.
 */
export function decodeEvalJson(json: unknown, commit: string, committedAt: Date): Eval {
  const top = asRecord(json);
  if (top === null) {
    throw new TypeError("eval JSON top level is not an object (the legacy pkgmeta.nix array schema is not supported)");
  }
  // Hydra's packages.json wraps the attribute-path map in a "packages" field.
  const packagesField = asRecord(top["packages"]);
  const attrMap = typeof top["version"] === "number" && packagesField !== null ? packagesField : top;

  const eval_: Eval = {
    commit: normalize(commit),
    system: "",
    committedAt,
    count: 0,
    packages: [],
  };

  for (const [rawAttrPath, rawPkg] of Object.entries(attrMap)) {
    const pkg = asRecord(rawPkg);
    if (pkg === null) continue;
    const cleaned = cleanPackage(normalize(rawAttrPath), pkg);
    // The eval's system is the first package's system. All packages in one
    // eval should have the same system.
    if (eval_.system === "") {
      eval_.system = cleaned.system;
    }
    eval_.packages.push(cleaned);
  }
  eval_.count = eval_.packages.length;
  return eval_;
}

function cleanPackage(attrPath: string, pkg: Record<string, unknown>): EvalPackage {
  const meta = asRecord(pkg["meta"]) ?? {};

  // A platform can sometimes be a JSON object (a structured platform
  // definition). Filter those out so we have a sorted, deduplicated list of
  // strings.
  const platforms = oneOrMany(meta["platforms"])
    .filter((p): p is string => typeof p === "string")
    .map(normalize)
    .sort();
  const dedupedPlatforms = platforms.filter((p, i) => i === 0 || p !== platforms[i - 1]);

  // Some packages have multiple licenses. Right now we can only show one, so
  // pick the first. Prefer a structured license object with a SpdxID, as
  // these are more accurate than licenses that are just a string.
  let license = "";
  const licenses = oneOrMany(meta["license"]);
  for (const l of licenses) {
    const spdxId = str(asRecord(l)?.["spdxId"]);
    if (spdxId !== "") {
      license = spdxId;
      break;
    }
  }
  if (license === "") {
    for (const l of licenses) {
      if (typeof l === "string" && l !== "") {
        license = l;
        break;
      }
    }
  }

  // Some packages also have multiple homepages. We can only show one, so pick
  // the first non-empty.
  let homepage = "";
  for (const h of oneOrMany(meta["homepage"])) {
    if (typeof h === "string" && h !== "") {
      homepage = h;
      break;
    }
  }

  // When system is missing, assume x86_64-linux since this is what Hydra
  // outputs.
  const system = str(pkg["system"]) || "x86_64-linux";

  const outputs = convertOutputs(pkg, meta);
  const storeHash = outputs.length > 0 ? splitStorePath(outputs[0]!.path).hash : "";

  return {
    storeHash,
    storeName: normalize(str(pkg["pname"])),
    storeVersion: normalize(str(pkg["version"])),
    metaName: normalize(str(meta["name"])),
    // MetaVersion is normally an array of parsed version components in the
    // legacy schema. For nix-env JSON the entire string is one component.
    metaVersion: [normalize(str(meta["version"]))],
    attrPath,
    system: normalize(system),
    program: normalize(str(meta["mainProgram"])),
    summary: normalize(str(meta["description"])),
    description: normalize(str(meta["longDescription"])),
    homepage: normalize(homepage),
    license: normalize(license),
    broken: bool(meta["broken"]),
    insecure: bool(meta["insecure"]),
    platforms: dedupedPlatforms,
    outputs,
  };
}

/**
 * Uses the outputName, outputsToInstall, and outputs fields to reconstruct
 * the ordering of package outputs. The first output is the default.
 *
 * One deliberate change from the Go port: Go appended the non-default
 * remainder in random map-iteration order; here it is sorted by name so that
 * contentHash() is deterministic.
 */
function convertOutputs(pkg: Record<string, unknown>, meta: Record<string, unknown>): Output[] {
  const outputsMap = asRecord(pkg["outputs"]) ?? {};
  const remaining = new Map<string, string>();
  for (const [name, path] of Object.entries(outputsMap)) {
    remaining.set(name, str(path));
  }
  const out: Output[] = [];

  // Put the default output first, if it exists.
  const outputName = str(pkg["outputName"]);
  if (outputName !== "") {
    out.push({ name: outputName, path: remaining.get(outputName) ?? "", default: true });
    remaining.delete(outputName);
  }

  // Append outputsToInstall next (maintaining the order), because those are
  // the defaults that nix profile installs.
  for (const name of oneOrMany(meta["outputsToInstall"])) {
    if (typeof name !== "string" || name === outputName) continue;
    out.push({ name, path: remaining.get(name) ?? "", default: true });
    remaining.delete(name);
  }

  // Add the rest, sorted by name. These are only installed if the user
  // explicitly asks for them.
  for (const name of [...remaining.keys()].sort()) {
    out.push({ name, path: remaining.get(name)!, default: false });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canonical serialization + hashing
// ---------------------------------------------------------------------------

/**
 * Serializes a JSON-compatible value deterministically: object keys are
 * sorted, arrays keep their order, and strings use standard JSON escaping
 * (no HTML escaping, matching Go's encoder with SetEscapeHTML(false)).
 * undefined object values are omitted, like JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",") + "]";
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(rec).sort()) {
      const v = rec[key];
      if (v === undefined) continue;
      parts.push(JSON.stringify(key) + ":" + canonicalJson(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new TypeError(`value is not JSON-compatible: ${typeof value}`);
}

/** Hex-encoded SHA-256. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Content-address of the deduplicated metadata blob (the meta table):
 * summary, description, homepage, license, and platforms.
 */
export function metaHash(pkg: EvalPackage): string {
  return sha256Hex(
    canonicalJson({
      description: pkg.description,
      homepage: pkg.homepage,
      license: pkg.license,
      platforms: pkg.platforms,
      summary: pkg.summary,
    }),
  );
}

/**
 * Content-address over everything stored for a variant (all fields except
 * its identity key of name/version/system/attr_path). Two evals of the same
 * variant with equal contentHash need no database write.
 */
export function contentHash(pkg: EvalPackage): string {
  return sha256Hex(
    canonicalJson({
      broken: pkg.broken,
      description: pkg.description,
      homepage: pkg.homepage,
      insecure: pkg.insecure,
      license: pkg.license,
      metaName: pkg.metaName,
      metaVersion: pkg.metaVersion,
      outputs: pkg.outputs.map((o) => ({ default: o.default, name: o.name, path: o.path })),
      platforms: pkg.platforms,
      program: pkg.program,
      storeHash: pkg.storeHash,
      storeName: pkg.storeName,
      storeVersion: pkg.storeVersion,
      summary: pkg.summary,
    }),
  );
}

/** The Devbox canonical name for a cleaned package (see devpkg.ts). */
export function packageName(pkg: EvalPackage): string {
  return canonicalName(pkg.attrPath);
}

/** The Devbox version for a cleaned package. */
export function packageVersion(pkg: EvalPackage): string {
  return pkg.storeVersion;
}
