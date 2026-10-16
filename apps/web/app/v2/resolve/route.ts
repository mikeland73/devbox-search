/**
 * GET /v2/resolve?name={name}&version={version}[&system={system}]
 *
 * The devbox CLI's critical path: resolves a Devbox package reference to a
 * nixpkgs flake reference (go@latest -> github:NixOS/nixpkgs/c38deaa#go_1_21).
 * Port of internal/api/resolve.go.
 *
 * Both parameters are required. `version` may be an exact version, a partial
 * version, an npm-style range (sanctioned change #1), or "latest". `system`
 * restricts which version may be chosen to those on that system; the
 * response still lists every system the chosen version is on.
 */

import {
  describeQuery,
  badRequest,
  handleGet,
  json,
  notAvailableOnSystem,
  notFound,
  serverError,
  systemParam,
} from "@/lib/http";
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
  const system = systemParam(params);
  if (system instanceof Response) return system;

  let pkgs: ResultPackage[];
  try {
    pkgs = await resolve({ name, version, availableOn: system });
  } catch (err) {
    return serverError("error resolving package", err);
  }
  if (pkgs.length === 0) {
    const message = `no package found for: ${describeQuery(normalizeQuery({ name, version, system }))}`;
    if (system !== "") {
      // Only on a miss: tell "not on this system" apart from "not at all".
      let anywhere: ResultPackage[];
      try {
        anywhere = await resolve({ name, version });
      } catch (err) {
        return serverError("error resolving package", err);
      }
      if (anywhere.length > 0) {
        return notAvailableOnSystem(message, system, [...new Set(anywhere.map((p) => p.system))].sort());
      }
    }
    return notFound(message);
  }

  // Sanctioned change #2: prefer one commit that contains this version on
  // every system, instead of emitting up to four different revs.
  return json(renderV2Resolve(await singleHashAcrossSystems(pkgs)));
});
