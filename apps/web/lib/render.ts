/**
 * Response builders, ported line-by-line from the Go handlers
 * (internal/api/handler.go, resolve.go, legacy/handler.go, legacy/types.go).
 *
 * The response shapes are frozen: shipped devbox CLIs parse them. The two
 * things that most easily break compatibility are handled centrally here:
 *
 *   - Go's `omitempty` omits zero values ENTIRELY. It never emits null,
 *     false, "" or [] for an omitempty field. {@link omitEmpty} reproduces
 *     that; anything not marked omitempty in the Go struct is always present.
 *   - Timestamps: v1 uses unix seconds (a number), v2 uses RFC 3339 WITHOUT
 *     fractional seconds.
 */

import type { ResultPackage } from "./search";

/**
 * Drops keys whose values Go would have omitted under `omitempty`:
 * undefined, null, "", false, 0, and empty arrays. Nested objects are left
 * alone (Go omitempty does not recurse into structs).
 */
export function omitEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (value === "" || value === false || value === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

/** RFC 3339 without fractional seconds, as Go's time.Time marshals here. */
export function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Unix seconds, as the v1 API's last_updated. */
export function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

// ---------------------------------------------------------------------------
// Grouping (port of nixpkgs.Group)
// ---------------------------------------------------------------------------

/**
 * Groups *consecutive* runs of packages sharing a key, preserving order.
 * Faithful port of Go's Group: it does not sort, so a key that recurs
 * non-consecutively produces multiple groups — behavior the response shapes
 * depend on.
 */
export function group<T>(items: T[], key: (item: T) => string): T[][] {
  if (items.length === 0) return [];
  const groups: T[][] = [];
  let start = 0;
  let current = key(items[0]!);
  for (const [i, item] of items.entries()) {
    const k = key(item);
    if (k === current) continue;
    groups.push(items.slice(start, i));
    start = i;
    current = k;
  }
  groups.push(items.slice(start));
  return groups;
}

export const byName = (p: ResultPackage): string => p.name;
export const byVersion = (p: ResultPackage): string => p.version;
export const bySystem = (p: ResultPackage): string => p.system;

// ---------------------------------------------------------------------------
// v2 responses
// ---------------------------------------------------------------------------

/**
 * /v2/resolve. `outputs` is omitempty; everything else is always present.
 *
 * Sanctioned change #2 (single-hash resolution) is applied by the caller
 * choosing one commit for all systems; the shape is unchanged either way.
 */
export function renderV2Resolve(pkgs: ResultPackage[]): unknown {
  const systems: Record<string, unknown> = {};
  for (const pkg of pkgs) {
    // There can be more than one attribute path per name+version+system.
    // Always use the first (rows arrive sorted by attribute path).
    if (systems[pkg.system] !== undefined) continue;
    systems[pkg.system] = {
      flake_installable: {
        ref: { type: "github", owner: "NixOS", repo: "nixpkgs", rev: pkg.commitHash },
        attr_path: pkg.attrPath,
      },
      last_updated: rfc3339(pkg.lastUpdated),
      ...(pkg.outputs.length > 0 ? { outputs: pkg.outputs.map(renderOutput) } : {}),
    };
  }
  return {
    name: pkgs[0]!.name,
    version: pkgs[0]!.version,
    summary: pkgs[0]!.summary,
    systems,
  };
}

/** nixpkgs.Output with omitempty on every field. */
function renderOutput(o: { name: string; path: string; default: boolean }): unknown {
  return omitEmpty({ name: o.name, path: o.path, default: o.default });
}

/** /v2/search. */
export function renderV2Search(query: string, pkgs: ResultPackage[]): unknown {
  return {
    query,
    total_results: pkgs.length,
    results: pkgs.map((p) => ({
      name: p.name,
      summary: p.summary,
      last_updated: rfc3339(p.lastUpdated),
    })),
  };
}

/** /v2/pkg. */
export function renderV2Pkg(pkgs: ResultPackage[]): unknown {
  const releases = group(pkgs, byVersion).map((groupPkgs) => {
    const platforms: Array<Record<string, unknown>> = [];
    let lastUpdated = new Date(0);
    for (const pkg of groupPkgs) {
      const { arch, os } = archOs(pkg.system);
      // More than one package per system is possible when a package has
      // multiple attribute paths; only the first is used.
      if (platforms.some((p) => p["arch"] === arch && p["os"] === os)) continue;
      if (pkg.lastUpdated > lastUpdated) lastUpdated = pkg.lastUpdated;
      platforms.push({
        arch,
        os,
        system: pkg.system,
        attribute_path: pkg.attrPath,
        commit_hash: pkg.commitHash,
        date: rfc3339(pkg.lastUpdated),
        outputs: pkg.outputs.map(renderOutput),
      });
    }
    return {
      version: groupPkgs[0]!.version,
      last_updated: rfc3339(lastUpdated),
      platforms,
      platforms_summary: summarizePlatforms(groupPkgs),
      outputs_summary: summarizeOutputs(groupPkgs),
    };
  });

  return {
    name: pkgs[0]!.name,
    summary: pkgs[0]!.summary,
    homepage_url: pkgs[0]!.homepage,
    license: pkgs[0]!.license,
    releases,
  };
}

function archOs(system: string): { arch: string; os: string } {
  switch (system) {
    case "x86_64-linux":
      return { arch: "x86-64", os: "Linux" };
    case "x86_64-darwin":
      return { arch: "x86-64", os: "macOS" };
    case "aarch64-linux":
      return { arch: "arm64", os: "Linux" };
    case "aarch64-darwin":
      return { arch: "arm64", os: "macOS" };
    default:
      // Go leaves both empty for unknown systems.
      return { arch: "", os: "" };
  }
}

/**
 * Summarizes supported platforms for display, e.g.
 * "Linux and macOS (Intel only)". Port of summarizePlatforms.
 */
export function summarizePlatforms(pkgs: ResultPackage[]): string {
  let aarch64Darwin = false;
  let x86_64Darwin = false;
  let linux = false;
  for (const pkg of pkgs) {
    switch (pkg.system) {
      case "aarch64-darwin":
        aarch64Darwin = true;
        break;
      case "x86_64-darwin":
        x86_64Darwin = true;
        break;
      case "aarch64-linux":
      case "x86_64-linux":
        linux = true;
        break;
    }
  }

  const platforms: string[] = [];
  if (linux) platforms.push("Linux");
  if (aarch64Darwin && x86_64Darwin) platforms.push("macOS");
  else if (aarch64Darwin) platforms.push("macOS (Apple Silicon only)");
  else if (x86_64Darwin) platforms.push("macOS (Intel only)");

  if (platforms.length === 1) return platforms[0]!;
  if (platforms.length === 2) return platforms[0] + " and " + platforms[1];
  return "";
}

/**
 * Summarizes outputs for display, e.g. "out, bin, debug (Linux only)".
 * Port of summarizeOutputs, including the rule that an all-default set is
 * summarized as "" (nothing worth telling the user).
 */
export function summarizeOutputs(pkgs: ResultPackage[]): string {
  const byOutputName = new Map<string, Map<string, { default: boolean }>>();
  for (const pkg of pkgs) {
    for (const out of pkg.outputs) {
      let bySystem = byOutputName.get(out.name);
      if (bySystem === undefined) {
        bySystem = new Map();
        byOutputName.set(out.name, bySystem);
      }
      bySystem.set(pkg.system, { default: out.default });
    }
  }

  const unique = [...byOutputName].map(([name, systems]) => {
    let linux = false;
    let darwin = false;
    let isDefault = false;
    for (const [system, out] of systems) {
      const os = system.split("-")[1] ?? "";
      linux ||= os === "linux";
      darwin ||= os === "darwin";
      isDefault ||= out.default;
    }
    return { name, linux, darwin, default: isDefault };
  });
  unique.sort((a, b) => {
    if (a.default !== b.default) return a.default ? -1 : 1; // defaults first
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  let allDefault = true;
  const summary = unique.map((out) => {
    allDefault &&= out.default;
    if (out.darwin && out.linux) return out.name;
    if (out.darwin) return out.name + " (macOS only)";
    if (out.linux) return out.name + " (Linux only)";
    return "";
  });

  // Don't show the outputs if they're all installed by default anyway.
  if (allDefault) return "";
  return summary.join(", ");
}

// ---------------------------------------------------------------------------
// v1 (legacy) responses
// ---------------------------------------------------------------------------

/** Platforms devbox supports; others are filtered from v1 responses. */
function supportedPlatform(p: string): boolean {
  return p === "aarch64-darwin" || p === "aarch64-linux" || p === "x86_64-darwin" || p === "x86_64-linux";
}

/** legacy packageInfo, every field omitempty. */
function renderPackageInfo(pkg: ResultPackage, opts: { withSystem: boolean; group?: ResultPackage[] }): unknown {
  const base: Record<string, unknown> = {
    commit_hash: pkg.commitHash,
    last_updated: unixSeconds(pkg.lastUpdated),
    version: pkg.version,
    platforms: pkg.platforms.filter(supportedPlatform),
    summary: pkg.summary,
    description: pkg.description,
    homepage: pkg.homepage,
    license: pkg.license,
  };
  if (opts.withSystem) {
    base["system"] = pkg.system;
    base["store_hash"] = pkg.storeHash;
    base["store_name"] = pkg.storeName;
    base["store_version"] = pkg.storeVersion;
    base["meta_name"] = pkg.metaName;
    base["meta_version"] = pkg.metaVersion;
    base["attr_paths"] = opts.group!.map((p) => p.attrPath);
    const programs = opts.group!.filter((p) => p.program !== "").map((p) => p.program);
    base["programs"] = programs;
    base["broken"] = pkg.broken;
    base["insecure"] = pkg.insecure;
  }
  return omitEmpty(base);
}

/**
 * legacy packageVersion list: one entry per version, each with a per-system
 * map. Port of pkgsToLegacyPackageVersions.
 */
export function renderLegacyVersions(pkgs: ResultPackage[]): unknown[] {
  return group(pkgs, byVersion).map((versionGroup) => {
    const first = versionGroup[0]!;
    const systems: Record<string, unknown> = {};
    for (const systemGroup of group(versionGroup, bySystem)) {
      systems[systemGroup[0]!.system] = renderPackageInfo(systemGroup[0]!, {
        withSystem: true,
        group: systemGroup,
      });
    }
    return {
      ...omitEmpty({
        commit_hash: first.commitHash,
        last_updated: unixSeconds(first.lastUpdated),
        version: first.version,
        platforms: first.platforms.filter(supportedPlatform),
        summary: first.summary,
        description: first.description,
        homepage: first.homepage,
        license: first.license,
      }),
      // `name` is NOT omitempty in the Go struct.
      name: first.name,
      ...(Object.keys(systems).length > 0 ? { systems } : {}),
    };
  });
}

/** /v1/search. */
export function renderV1Search(pkgs: ResultPackage[]): unknown {
  const packages = group(pkgs, byName).map((nameGroup) => {
    const versions = renderLegacyVersions(nameGroup);
    return {
      name: nameGroup[0]!.name,
      num_versions: versions.length,
      ...(versions.length > 0 ? { versions } : {}),
    };
  });
  return {
    num_results: packages.length,
    ...(packages.length > 0 ? { packages } : {}),
  };
}
