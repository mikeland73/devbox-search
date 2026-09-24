/**
 * GET /resolve?name=&version= — where the removed v1 alias used to be.
 *
 * The question it answered is now a page, so this redirects to the package
 * page with the constraint applied. Old links keep meaning what they meant.
 */

import { handleGet, redirect } from "@/lib/http";
import { pkgPath, resolvePath } from "@/lib/site/links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) => {
  const params = new URL(request.url).searchParams;
  const name = (params.get("name") ?? "").trim();
  const version = (params.get("version") ?? "").trim();
  if (name === "") return redirect("/");
  return redirect(version === "" ? pkgPath(name) : resolvePath(name, version));
});
