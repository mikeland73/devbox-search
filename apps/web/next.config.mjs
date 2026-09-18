/** @type {import('next').NextConfig} */
const nextConfig = {
  // Route handlers run on the Node runtime: the neon-http driver and the
  // response builders both assume Node APIs.
  serverExternalPackages: ["@neondatabase/serverless", "pg"],
  poweredByHeader: false,
  // Don't 308 `/pkg/` to `/pkg`. The Go service path.Clean'd every request,
  // so `/pkg/`, `/v2/resolve/` and `/readyz/` were served by the same handler
  // as their slash-less form (a 400 for `/pkg/`, not a redirect). With the
  // redirect off, Next matches a trailing-slash path against the same route,
  // which is exactly that behaviour (#45).
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
