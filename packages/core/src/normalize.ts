/**
 * String normalization shared by ingest and query paths.
 *
 * Ported from axiom/devbox-search internal/nixpkgs/eval.go. Every string that
 * is stored in the database or compared against it must go through
 * {@link normalize} so that lookups behave identically on both sides.
 */

/**
 * Unicode-normalizes a string to NFD and trims leading/trailing whitespace.
 *
 * NFD decomposes combining characters into separate characters, making search
 * easier: "é" (é) becomes "é" (e + ´), so a query such as
 * "que" matches both "que" and "qué".
 *
 * Trimming matches Go's strings.TrimSpace (the Unicode White_Space property),
 * which differs slightly from JavaScript's String.prototype.trim (Go trims
 * U+0085, does not trim U+FEFF).
 */
export function normalize(s: string): string {
  return s.normalize("NFD").replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

/**
 * Escapes the SQL LIKE wildcards `%` and `_` (and the escape character itself)
 * for use with `LIKE ... ESCAPE '\'`.
 *
 * The Go service interpolated user version strings into LIKE patterns without
 * escaping; doing so here is sanctioned hygiene change #5.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * Splits a Nix store path into its hash, name and version components in the
 * same way that Nix does. The path may begin with /nix/store. Note that the
 * version will contain any file extension from the path (e.g. ".drv").
 *
 * Faithful port of SplitStorePath in eval.go, which mirrors Nix's
 * builtins.parseDrvName: the name/version boundary is the first dash that is
 * followed by a non-letter character.
 *
 * See https://nixos.org/manual/nix/stable/language/builtins.html#builtins-parseDrvName
 */
export function splitStorePath(path: string): {
  hash: string;
  name: string;
  version: string;
} {
  if (path.startsWith("/nix/store/")) {
    path = path.slice("/nix/store/".length);
  }
  if (path.length < 32) {
    return { hash: "", name: "", version: "" };
  }
  const hash = path.slice(0, 32);
  if (path.length < 34) {
    return { hash, name: "", version: "" };
  }
  const name = path.slice(33);

  // The Go original iterates runes with byte indexes; store names are ASCII
  // in practice but we iterate code points with index tracking for parity.
  // Note the Go quirk that a dash at index 0 can never split (dashIndex != 0).
  let dashIndex = 0;
  let i = 0;
  for (const r of name) {
    if (dashIndex !== 0 && !/\p{L}/u.test(r)) {
      return { hash, name: name.slice(0, dashIndex), version: name.slice(i) };
    }
    dashIndex = 0;
    if (r === "-") {
      dashIndex = i;
    }
    i += r.length;
  }
  return { hash, name, version: "" };
}
