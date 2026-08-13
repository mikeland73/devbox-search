/**
 * Version ordering, prerelease detection, and semver parsing.
 *
 * The comparator here is NOT a port of the old Go cascade
 * (semver -> PEP 440 -> simple split), which was not transitive (sanctioned
 * API change #4 replaces it). Instead it defines a single clean total order
 * close to Nix's builtins.compareVersions:
 *
 *   - A version splits into components: runs of digits and runs of other
 *     characters. `.`, `-` and `_` are separators and are discarded, and a
 *     digit/non-digit transition also splits (so "3.11.0a2" and "3.11.0-a2"
 *     both split into [3, 11, 0, "a", 2]).
 *   - A leading "v" directly followed by a digit is stripped.
 *   - Components compare by class first:
 *       prerelease tag < end-of-version < other alpha < numeric
 *     Known prerelease tags are exactly the PEP 440 pre-release spellings
 *     that the ported prerelease() function detects (a, b, c, rc, alpha,
 *     beta, pre, preview), compared lexicographically among themselves.
 *     Placing them below end-of-version gives semver-style behavior:
 *     "1.0.0-rc1" < "1.0.0". Other alpha components sort above
 *     end-of-version like Nix does ("1.0" < "1.0q"), and numbers sort
 *     above letters ("1.0pre" < "1.0.1").
 *   - Numeric components compare numerically ("01" == "1").
 *
 * sortKey() encodes a version into bytes whose bytewise order is exactly
 * compareVersions() order, so `latest` becomes max(sort_key) in SQL with no
 * re-sort step in the import pipeline.
 *
 * prerelease() and parseGoSemver() ARE faithful ports of the Go code
 * (internal/nixpkgs/version.go and golang.org/x/mod/semver): the prerelease
 * boolean stored in the database must keep matching the old service's
 * filtering behavior exactly.
 */

import { Buffer } from "node:buffer";

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/** Known prerelease tag components, matching the PEP 440 pre_l spellings. */
const PRERELEASE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "b",
  "c",
  "rc",
  "alpha",
  "beta",
  "pre",
  "preview",
]);

type ComponentClass = "pretag" | "alpha" | "numeric";

interface Component {
  cls: ComponentClass;
  /** Digits with leading zeros stripped, or the (tag-lowercased) text. */
  text: string;
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isSeparator(c: string): boolean {
  // Codepoints below 0x05 are also treated as separators so that component
  // payloads can never collide with the sort-key class/terminator bytes.
  return c === "." || c === "-" || c === "_" || (c.codePointAt(0) ?? 0) < 0x05;
}

/**
 * Splits a version string into its ordered components. Exported for tests
 * and for the seed-time ordering diff report.
 */
export function splitVersionComponents(version: string): Component[] {
  let v = version;
  if (v.length >= 2 && v[0] === "v" && isDigit(v[1]!)) {
    v = v.slice(1);
  }

  const components: Component[] = [];
  let i = 0;
  while (i < v.length) {
    const c = v[i]!;
    if (isSeparator(c)) {
      i++;
      continue;
    }
    const numeric = isDigit(c);
    let j = i;
    while (j < v.length && !isSeparator(v[j]!) && isDigit(v[j]!) === numeric) {
      j++;
    }
    const run = v.slice(i, j);
    if (numeric) {
      const stripped = run.replace(/^0+(?=.)/, "");
      components.push({ cls: "numeric", text: stripped });
    } else {
      const lower = run.toLowerCase();
      if (PRERELEASE_TAGS.has(lower)) {
        components.push({ cls: "pretag", text: lower });
      } else {
        components.push({ cls: "alpha", text: run });
      }
    }
    i = j;
  }
  return components;
}

// ---------------------------------------------------------------------------
// Comparator
// ---------------------------------------------------------------------------

// Class ranks. end-of-version sits between pretag and alpha.
const RANK_PRETAG = 0;
const RANK_END = 1;
const RANK_ALPHA = 2;
const RANK_NUMERIC = 3;

function rankOf(c: Component | undefined): number {
  if (c === undefined) return RANK_END;
  switch (c.cls) {
    case "pretag":
      return RANK_PRETAG;
    case "alpha":
      return RANK_ALPHA;
    case "numeric":
      return RANK_NUMERIC;
  }
}

// Numeric length as used for ordering. The sort key stores the digit count in
// a single byte, so runs longer than 255 digits compare pseudo-numerically
// (byte-for-byte); the comparator mirrors that so the two always agree.
function numericLength(text: string): number {
  return Math.min(text.length, 255);
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Compares two versions under the clean total order described in the module
 * doc. Returns -1, 0, or +1. Consistent with bytewise sortKey() order.
 */
export function compareVersions(v: string, w: string): number {
  const a = splitVersionComponents(v);
  const b = splitVersionComponents(w);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ca = a[i];
    const cb = b[i];
    const ra = rankOf(ca);
    const rb = rankOf(cb);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (ca === undefined || cb === undefined) continue;
    let n = 0;
    if (ca.cls === "numeric") {
      n = numericLength(ca.text) - numericLength(cb.text);
      if (n === 0) n = compareBytes(ca.text, cb.text);
    } else {
      n = compareBytes(ca.text, cb.text);
    }
    if (n !== 0) return n < 0 ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Sort key
// ---------------------------------------------------------------------------

const KEY_PRETAG = 0x01;
const KEY_END = 0x02;
const KEY_ALPHA = 0x03;
const KEY_NUMERIC = 0x04;

/**
 * Encodes a version into a byte string whose unsigned bytewise order equals
 * compareVersions() order. Stored in the versions.sort_key bytea column;
 * `latest` is then a plain max(sort_key) lookup.
 *
 * Layout: each component is a class byte followed by its payload, and the
 * whole key ends with a terminator byte that sorts between the prerelease-tag
 * class and the alpha class (so "1.0-rc1" < "1.0" < "1.0q" < "1.0.1").
 * Numeric payloads are a digit-count byte followed by the ASCII digits
 * (leading zeros stripped), making longer numbers sort after shorter ones.
 */
export function sortKey(version: string): Uint8Array {
  const components = splitVersionComponents(version);
  const parts: Buffer[] = [];
  for (const c of components) {
    switch (c.cls) {
      case "pretag":
        parts.push(Buffer.from([KEY_PRETAG]), Buffer.from(c.text, "utf8"));
        break;
      case "alpha":
        parts.push(Buffer.from([KEY_ALPHA]), Buffer.from(c.text, "utf8"));
        break;
      case "numeric":
        parts.push(Buffer.from([KEY_NUMERIC, numericLength(c.text)]), Buffer.from(c.text, "ascii"));
        break;
    }
  }
  parts.push(Buffer.from([KEY_END]));
  return Uint8Array.from(Buffer.concat(parts));
}

/** Compares two sort keys bytewise (unsigned). Returns -1, 0, or +1. */
export function compareSortKeys(a: Uint8Array, b: Uint8Array): number {
  return Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

// ---------------------------------------------------------------------------
// Prerelease detection (faithful port of Go's nixpkgs.Prerelease)
// ---------------------------------------------------------------------------

/**
 * rePythonVersion is the regular expression from PEP 440 which defines the
 * standard Python versioning scheme, as used by the Go service.
 *
 * See https://peps.python.org/pep-0440/#appendix-b-parsing-version-strings-with-regular-expressions
 *
 * Go's `\s` matches only [\t\n\f\r ], which is spelled out here because
 * JavaScript's \s matches more characters.
 */
const rePythonVersion =
  /^[\t\n\f\r ]*v?(?:(?:(?<epoch>[0-9]+)!)?(?<release>[0-9]+(?:\.[0-9]+)*)(?<pre>[-_.]?(?<pre_l>a|b|c|rc|alpha|beta|pre|preview)[-_.]?(?<pre_n>[0-9]+)?)?(?<post>(?:-(?<post_n1>[0-9]+))|(?:[-_.]?(?<post_l>post|rev|r)[-_.]?(?<post_n2>[0-9]+)?))?(?<dev>[-_.]?(?<dev_l>dev)[-_.]?(?<dev_n>[0-9]+)?)?)(?:\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?[\t\n\f\r ]*$/;

/**
 * Returns the prerelease portion of a version, or "" if the version does not
 * look like a prerelease. Faithful port of Go's nixpkgs.Prerelease including
 * its quirks: the golang.org/x/mod/semver path only applies to "v"-prefixed
 * versions and returns the prerelease with its leading "-" (e.g. "-rc1").
 *
 * This feeds the `prerelease` boolean column, which must keep matching the
 * old service's filtering behavior exactly.
 */
export function prerelease(v: string): string {
  // Try semver first because it's the most accurate.
  const goSemver = parseGoSemver(v);
  if (goSemver !== null) {
    return goSemver.prerelease === "" ? "" : "-" + goSemver.prerelease;
  }

  // Attempt to parse a prerelease from a Python-ish version.
  const matches = rePythonVersion.exec(v.toLowerCase());
  const pre = matches?.groups?.["pre"];
  if (pre !== undefined && pre !== "") {
    return pre.replace(/^[-_.]+/, "");
  }

  // Finally, a dumb check to see if the version ends with common
  // prerelease strings.
  for (const s of ["alpha", "beta", "pre", "preview", "rc"]) {
    if (v.endsWith(s)) {
      return s;
    }
  }
  return "";
}

/** Reports whether prerelease(v) is non-empty. */
export function isPrerelease(v: string): boolean {
  return prerelease(v) !== "";
}

// ---------------------------------------------------------------------------
// Semver parsing
// ---------------------------------------------------------------------------

export interface GoSemver {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers without the leading "-", or "". */
  prerelease: string;
  /** Build metadata without the leading "+", or "". */
  build: string;
}

/**
 * Parses a version using golang.org/x/mod/semver's lax rules: a mandatory
 * leading "v", optional minor/patch ("v1" == "v1.0.0"), and strict
 * prerelease/build identifier syntax. Returns null when invalid. Used only to
 * reproduce Go's Prerelease behavior.
 */
export function parseGoSemver(v: string): GoSemver | null {
  if (!v.startsWith("v")) return null;
  let rest = v.slice(1);

  const parseInt_ = (s: string): [string, string] | null => {
    let i = 0;
    while (i < s.length && isDigit(s[i]!)) i++;
    if (i === 0) return null;
    if (s[0] === "0" && i !== 1) return null;
    return [s.slice(0, i), s.slice(i)];
  };

  const major = parseInt_(rest);
  if (major === null) return null;
  rest = major[1];

  let minor: string = "0";
  let patch: string = "0";
  if (rest.startsWith(".")) {
    const m = parseInt_(rest.slice(1));
    if (m === null) return null;
    minor = m[0];
    rest = m[1];
    if (rest.startsWith(".")) {
      const p = parseInt_(rest.slice(1));
      if (p === null) return null;
      patch = p[0];
      rest = p[1];
    }
  }

  let pre = "";
  if (rest.startsWith("-")) {
    const end = rest.indexOf("+");
    pre = end === -1 ? rest.slice(1) : rest.slice(1, end);
    rest = end === -1 ? "" : rest.slice(end);
    for (const id of pre.split(".")) {
      if (id === "" || !/^[0-9A-Za-z-]+$/.test(id)) return null;
      if (/^[0-9]+$/.test(id) && id.length > 1 && id[0] === "0") return null;
    }
  }

  let build = "";
  if (rest.startsWith("+")) {
    build = rest.slice(1);
    rest = "";
    for (const id of build.split(".")) {
      if (id === "" || !/^[0-9A-Za-z-]+$/.test(id)) return null;
    }
  }

  if (rest !== "") return null;
  return {
    major: Number(major[0]),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre,
    build,
  };
}

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers without the leading "-", or "". */
  prerelease: string;
}

/**
 * Strict SemVer 2.0.0 regex (from semver.org) with an optional leading "v".
 * Build metadata is accepted and discarded (it has no precedence).
 */
const reStrictSemver =
  /^v?(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?:[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Strictly parses a full SemVer 2.0.0 version (optionally "v"-prefixed).
 * Returns null for anything else — partial versions ("3.11"), date versions
 * ("2024-01-05"), and so on. Feeds the nullable semver_major/minor/patch/pre
 * columns that power npm-style range queries; unparseable versions fall back
 * to prefix-with-boundary matching.
 */
export function parseSemver(v: string): Semver | null {
  const m = reStrictSemver.exec(v);
  if (m === null || m.groups === undefined) return null;
  const major = Number(m.groups["major"]);
  const minor = Number(m.groups["minor"]);
  const patch = Number(m.groups["patch"]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { major, minor, patch, prerelease: m.groups["prerelease"] ?? "" };
}
