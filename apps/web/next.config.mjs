/** @type {import('next').NextConfig} */
const nextConfig = {
  // Route handlers run on the Node runtime: the neon-http driver and the
  // response builders both assume Node APIs.
  serverExternalPackages: ["@neondatabase/serverless", "pg"],
  poweredByHeader: false,
};

export default nextConfig;
