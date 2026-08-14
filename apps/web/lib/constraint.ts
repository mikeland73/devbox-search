/**
 * Version constraints (sanctioned API change #1).
 *
 * The old service treated the `version` parameter as a raw string prefix
 * (`version LIKE 'v%'`), so `3.1` also matched `3.11`. This module replaces
 * that with dot-boundary semantics — a partial version is a range:
 *
 *   3       -> >=3.0.0   <4.0.0
 *   3.1     -> >=3.1.0   <3.2.0
 *   3.1.4   -> ==3.1.4
 *
 * and additionally accepts npm-style ranges in the same parameter, so the
 * constraint feature ships without a new endpoint:
 *
 *   ^3.11   -> >=3.11.0  <4.0.0
 *   ~3.11.2 -> >=3.11.2  <3.12.0
 *   >=1.2 <2
 *
 * Anything that isn't expressible this way (dates like `2024-01-05`, patch
 * letters like `1.1.1w`) returns null, and the caller falls back to
 * prefix-with-boundary matching in SQL.
 */

export interface SemverTuple {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers without the leading "-", or "". */
  prerelease: string;
}

export interface Bound {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
  /** Whether the bound itself satisfies the constraint. */
  inclusive: boolean;
}

export interface Constraint {
  min: Bound | null;
  max: Bound | null;
  /**
   * True when the constraint came from an exact version (`3.1.4`), which
   * makes a prerelease match permissible if the user asked for one.
   */
  exact: boolean;
  /** The original text, for diagnostics. */
  source: string;
}

const rePartial = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/;
const reOperator = /^(>=|<=|>|<|=|\^|~)?\s*(.*)$/;

/**
 * Parses a version constraint. Returns null when the input cannot be
 * expressed as a semver range (the caller then uses prefix matching).
 */
export function parseConstraint(input: string): Constraint | null {
  const text = input.trim();
  if (text === "" || text === "latest") return null;

  // A space- or comma-separated conjunction of comparators, e.g. ">=1.2 <2".
  const parts = text.split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length === 0) return null;

  let min: Bound | null = null;
  let max: Bound | null = null;
  let exact = false;

  for (const part of parts) {
    const m = reOperator.exec(part);
    if (m === null) return null;
    const op = m[1] ?? "";
    const rest = m[2] ?? "";
    const parsed = rePartial.exec(rest);
    if (parsed === null) return null;

    const major = Number(parsed[1]);
    const minorGiven = parsed[2] !== undefined;
    const patchGiven = parsed[3] !== undefined;
    const minor = minorGiven ? Number(parsed[2]) : 0;
    const patch = patchGiven ? Number(parsed[3]) : 0;
    const pre = parsed[4] ?? "";
    if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
      return null;
    }
    // A prerelease suffix is only meaningful on a fully-specified version.
    // Without this, date versions parse as a major with a prerelease:
    // "2024-01-05" would become 2024 + pre "01-05" and be treated as a
    // range, when it must fall back to prefix matching instead.
    if (pre !== "" && !(minorGiven && patchGiven)) return null;

    switch (op) {
      case "":
      case "=": {
        // A bare version: exact when fully specified, otherwise the
        // dot-boundary range that gives change #1 its name.
        if (patchGiven) {
          exact = true;
          min = { major, minor, patch, prerelease: pre, inclusive: true };
          max = { major, minor, patch, prerelease: pre, inclusive: true };
        } else if (minorGiven) {
          min = { major, minor, patch: 0, prerelease: pre, inclusive: true };
          max = { major, minor: minor + 1, patch: 0, prerelease: "", inclusive: false };
        } else {
          min = { major, minor: 0, patch: 0, prerelease: pre, inclusive: true };
          max = { major: major + 1, minor: 0, patch: 0, prerelease: "", inclusive: false };
        }
        break;
      }
      case "^": {
        // Caret: compatible-with, i.e. no major bump. For 0.x, npm treats
        // the minor as the breaking component.
        min = { major, minor, patch, prerelease: pre, inclusive: true };
        max =
          major > 0
            ? { major: major + 1, minor: 0, patch: 0, prerelease: "", inclusive: false }
            : minorGiven
              ? { major: 0, minor: minor + 1, patch: 0, prerelease: "", inclusive: false }
              : { major: 1, minor: 0, patch: 0, prerelease: "", inclusive: false };
        break;
      }
      case "~": {
        // Tilde: allow patch-level changes when a minor is given.
        min = { major, minor, patch, prerelease: pre, inclusive: true };
        max = minorGiven
          ? { major, minor: minor + 1, patch: 0, prerelease: "", inclusive: false }
          : { major: major + 1, minor: 0, patch: 0, prerelease: "", inclusive: false };
        break;
      }
      case ">":
        min = { major, minor, patch, prerelease: pre, inclusive: false };
        break;
      case ">=":
        min = { major, minor, patch, prerelease: pre, inclusive: true };
        break;
      case "<":
        max = { major, minor, patch, prerelease: pre, inclusive: false };
        break;
      case "<=":
        max = { major, minor, patch, prerelease: pre, inclusive: true };
        break;
      default:
        return null;
    }
  }

  if (min === null && max === null) return null;
  return { min, max, exact, source: text };
}

/** Compares two semver tuples by precedence (SemVer 2.0.0 §11). */
export function compareTuples(a: SemverTuple, b: SemverTuple): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  // A version without a prerelease outranks one with it.
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const nx = Number(x);
      const ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (xNum !== yNum) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Reports whether a version satisfies a constraint.
 *
 * Prereleases are excluded unless the constraint itself names one or is an
 * exact match, matching npm's rule that `^1.0.0` should not silently resolve
 * to `2.0.0-rc.1`. The caller's separate `latest` prerelease fallback is
 * unaffected.
 */
export function satisfies(constraint: Constraint, version: SemverTuple): boolean {
  if (version.prerelease !== "" && !constraint.exact) {
    const boundNamesPrerelease =
      (constraint.min?.prerelease ?? "") !== "" || (constraint.max?.prerelease ?? "") !== "";
    if (!boundNamesPrerelease) return false;
  }

  if (constraint.min !== null) {
    const cmp = compareTuples(version, constraint.min);
    if (cmp < 0 || (cmp === 0 && !constraint.min.inclusive)) return false;
  }
  if (constraint.max !== null) {
    const cmp = compareTuples(version, constraint.max);
    if (cmp > 0 || (cmp === 0 && !constraint.max.inclusive)) return false;
  }
  return true;
}
