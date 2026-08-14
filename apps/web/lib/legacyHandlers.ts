/**
 * Handler bodies shared by the legacy endpoints, which the old service
 * served from one net/http handler with a path switch
 * (internal/api/legacy/handler.go). Each route file is a thin wrapper so
 * routing is exact (sanctioned hygiene change #5 — the old HasPrefix matcher
 * meant /resolveXYZ hit the resolve handler).
 */

import { badRequest, describeQuery, json, notFound, serverError } from "./http";
import { normalizeQuery, resolve, search, type ResultPackage } from "./search";
import { renderLegacyVersions, renderSearch, renderV1Search } from "./render";

/** /v1/resolve and /resolve — the v1 shape, with an optional system filter. */
export async function legacyResolve(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const name = params.get("name") ?? "";
  const version = params.get("version") ?? "";
  const system = params.get("system") ?? "";

  if (name === "") return badRequest("empty name (set a ?name=<value> query parameter)");
  if (version === "") return badRequest("empty version (set a ?version=<value> query parameter)");

  let pkgs: ResultPackage[];
  try {
    pkgs = await resolve({ name, version, system });
  } catch (err) {
    return serverError("error resolving package", err);
  }
  if (pkgs.length === 0) {
    return notFound(`no package found for: ${describeQuery(normalizeQuery({ name, version, system }))}`);
  }
  // Go returned only the first version entry.
  return json(renderLegacyVersions(pkgs)[0]);
}

/** /v1/pkg?name= and /pkg/{name…} — every version of one package. */
export async function legacyPkg(name: string): Promise<Response> {
  if (name === "") return badRequest("empty name (set a ?name=<value> query parameter)");

  let pkgs: ResultPackage[];
  try {
    pkgs = await search({ name });
  } catch (err) {
    return serverError("error getting package versions", err);
  }
  if (pkgs.length === 0) {
    return notFound(`no package found for: ${describeQuery(normalizeQuery({ name }))}`);
  }
  return json(renderLegacyVersions(pkgs));
}

/** /v1/search and /db/search. */
export async function legacyV1Search(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (q === "") return badRequest("empty search query (set a ?q=<term> query parameter)");

  let pkgs: ResultPackage[];
  try {
    pkgs = await search({ phrase: q });
  } catch (err) {
    return serverError("", err);
  }
  return json(renderV1Search(pkgs));
}

/**
 * /search?q=&v= — the oldest shape. When a version is given the endpoint
 * searches by exact name instead of by phrase and returns one result.
 */
export async function legacySearch(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  const v = params.get("v") ?? "";

  const query = v !== "" ? { name: q, version: v } : { phrase: q };
  if ((query as { name?: string }).name === "" && (query as { phrase?: string }).phrase === "") {
    return badRequest("empty search query (set a ?q=<term> query parameter)");
  }
  if (q === "") return badRequest("empty search query (set a ?q=<term> query parameter)");

  let pkgs: ResultPackage[];
  try {
    pkgs = v !== "" ? await resolve(query) : await search(query);
  } catch (err) {
    return serverError("", err);
  }
  return json(renderSearch(pkgs));
}
