/**
 * Shared HTTP concerns for the route handlers.
 *
 * Error bodies are byte-compatible with Go's http.Error: the message
 * followed by a newline, served as text/plain; charset=utf-8. The devbox CLI
 * only checks status codes, but the shadow diff compares bodies.
 *
 * Sanctioned hygiene change #5: every response carries Cache-Control and an
 * ETag so the Vercel CDN can absorb hot traffic (which is also what masks
 * Neon cold starts), and OPTIONS/method handling is explicit rather than
 * falling through.
 */

import { createHash } from "node:crypto";

/** One hour at the edge, a day of stale-while-revalidate. */
export const CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";

/** Errors should not be cached at the edge for long. */
const ERROR_CACHE_CONTROL = "public, max-age=0, s-maxage=60";

const ALLOWED_METHODS = "GET, HEAD, OPTIONS";

/**
 * A JSON response with caching headers and a weak ETag.
 *
 * Go marshalled with SetEscapeHTML(false); JSON.stringify already does not
 * escape HTML, so the bytes match.
 */
export function json(body: unknown, init: { status?: number; cacheControl?: string } = {}): Response {
  const text = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(text).digest("base64url").slice(0, 27)}"`;
  return new Response(text, {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": init.cacheControl ?? CACHE_CONTROL,
      ETag: etag,
    },
  });
}

/** An HTML page with the same caching headers and weak ETag as {@link json}. */
export function html(body: string, init: { cacheControl?: string } = {}): Response {
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": init.cacheControl ?? CACHE_CONTROL,
      ETag: etag,
    },
  });
}

/** A plain-text error body identical to Go's http.Error output. */
export function httpError(message: string, status: number): Response {
  return new Response(message + "\n", {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": ERROR_CACHE_CONTROL,
    },
  });
}

export const badRequest = (message: string): Response => httpError("400 Bad Request: " + message, 400);
export const notFound = (message: string): Response => httpError("404 Not Found: " + message, 404);

export function serverError(message: string, err: unknown): Response {
  console.error(`500 Internal Server Error: ${message}:`, err);
  return httpError("500 Internal Server Error" + (message === "" ? "" : ": " + message), 500);
}

/** 204 with an Allow header, matching Go's options(). */
export function optionsResponse(): Response {
  return new Response(null, { status: 204, headers: { Allow: ALLOWED_METHODS } });
}

/** 405 with an Allow header, matching Go's methodNotAllowed(). */
export function methodNotAllowed(): Response {
  return new Response("405 Method Not Allowed\n", {
    status: 405,
    headers: {
      Allow: ALLOWED_METHODS,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * The query description Go embedded in 404 messages, e.g.
 * `name = "python" && version = "3.11"`. Field order and quoting follow
 * Query.String() so the bodies match byte for byte.
 */
export function describeQuery(q: {
  phrase?: string;
  name?: string;
  version?: string;
  system?: string;
}): string {
  const fields: string[] = [];
  if (q.phrase !== undefined && q.phrase !== "") {
    fields.push(`phrase = ${quote(q.phrase)} = ${quote(ftsQuery(q.phrase))}`);
  }
  if (q.name !== undefined && q.name !== "") fields.push(`name = ${quote(q.name)}`);
  if (q.version !== undefined && q.version !== "") fields.push(`version = ${quote(q.version)}`);
  if (q.system !== undefined && q.system !== "") fields.push(`system = ${quote(q.system)}`);
  return fields.join(" && ");
}

/**
 * The FTS5 query string the old service built. It no longer drives the
 * search (pg_trgm does), but Query.String() embedded it in 404 bodies, so it
 * is reproduced for byte compatibility.
 */
function ftsQuery(phrase: string): string {
  const escaped = phrase.replaceAll('"', '""');
  return `^"${escaped}" OR ^"${escaped}"* OR "${escaped}" OR "${escaped}"*`;
}

/** Go's %q verb for the strings that appear in these messages. */
function quote(s: string): string {
  return JSON.stringify(s);
}

/**
 * Wraps a GET handler with the method handling every endpoint shares.
 * HEAD is served by returning the GET response; the platform drops the body.
 */
export function handleGet(handler: (request: Request) => Promise<Response>) {
  return {
    GET: handler,
    HEAD: handler,
    OPTIONS: async () => optionsResponse(),
    POST: async () => methodNotAllowed(),
    PUT: async () => methodNotAllowed(),
    PATCH: async () => methodNotAllowed(),
    DELETE: async () => methodNotAllowed(),
  };
}
