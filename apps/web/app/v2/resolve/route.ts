/**
 * GET /v2/resolve?name={name}&version={version}
 *
 * The devbox CLI's critical path: resolves a Devbox package reference to a
 * nixpkgs flake reference (go@latest -> github:NixOS/nixpkgs/c38deaa#go_1_21).
 * Port of internal/api/resolve.go.
 *
 * Both parameters are required. `version` may be an exact version, a partial
 * version, an npm-style range (sanctioned change #1), or "latest".
 */

import { describeQuery, badRequest, handleGet, json, notFound, serverError } from "@/lib/http";
import { normalizeQuery, resolve, type ResultPackage } from "@/lib/search";
import { renderV2Resolve } from "@/lib/render";
import { singleHashAcrossSystems } from "@/lib/singleHash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) => {
  const params = new URL(request.url).searchParams;
  const name = params.get("name") ?? "";
  const version = params.get("version") ?? "";

  if (name === "") return badRequest("empty name (set a ?name=<value> query parameter)");
  if (version === "") return badRequest("empty version (set a ?version=<value> query parameter)");

  let pkgs: ResultPackage[];
  try {
    pkgs = await resolve({ name, version });
  } catch (err) {
    return serverError("error resolving package", err);
  }
  if (pkgs.length === 0) {
    return notFound(`no package found for: ${describeQuery(normalizeQuery({ name, version }))}`);
  }

  // Sanctioned change #2: prefer one commit that contains this version on
  // every system, instead of emitting up to four different revs.
  return json(renderV2Resolve(await singleHashAcrossSystems(pkgs)));
});
