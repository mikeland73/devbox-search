/**
 * The site's URL shapes, in one place so pages and redirects cannot drift.
 *
 * #80 freed these paths by removing the unversioned API aliases, so a page
 * now lives at the name a person would guess. Names are percent-encoded per
 * segment; nothing in the index contains a slash (a trigram search for `/`
 * matches none of the 250k names and attribute paths), which is what makes
 * `/pkg/<name>/<version>` unambiguous.
 */

export function pkgPath(name: string): string {
  return `/pkg/${encodeURIComponent(name)}`;
}

export function releasePath(name: string, version: string): string {
  return `/pkg/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

export function resolvePath(name: string, version: string): string {
  return `${pkgPath(name)}?v=${encodeURIComponent(version)}`;
}

export function searchPath(q: string): string {
  return `/search?q=${encodeURIComponent(q)}`;
}

/** `/v2/pkg?name=…`, the JSON twin of a package page. */
export function pkgJson(name: string): string {
  return `/v2/pkg?name=${encodeURIComponent(name)}`;
}

export function resolveJson(name: string, version: string): string {
  return `/v2/resolve?name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}`;
}

/**
 * Splits a devbox-style reference (`python@3.11`) into its parts. The
 * version is everything after the first `@`, untouched, so ranges like
 * `^1.22` and `>=3.10 <3.12` survive.
 */
export function splitRef(ref: string): { name: string; version?: string } {
  const at = ref.indexOf("@");
  if (at <= 0) return { name: ref };
  return { name: ref.slice(0, at), version: ref.slice(at + 1) };
}
