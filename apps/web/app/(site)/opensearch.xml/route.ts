/**
 * GET /opensearch.xml — lets a browser add nixsearch as a search engine,
 * so `nix<tab>python` in the address bar goes straight to the results.
 */

import { handleGet } from "@/lib/http";
import { CACHE_CONTROL } from "@/lib/http";
import { esc } from "@/lib/site/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE } = handleGet(async (request) => {
  const origin = new URL(request.url).origin;
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>nixsearch</ShortName>
  <Description>Search every version of every nixpkgs package</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="text/html" method="get" template="${esc(origin)}/search?q={searchTerms}"/>
  <Url type="application/json" method="get" template="${esc(origin)}/v2/search?q={searchTerms}"/>
</OpenSearchDescription>
`;
  return new Response(body, {
    headers: {
      "Content-Type": "application/opensearchdescription+xml",
      "Cache-Control": CACHE_CONTROL,
    },
  });
});
