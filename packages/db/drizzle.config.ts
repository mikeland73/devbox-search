import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // `||` so an empty value falls through rather than sticking (see client.ts).
    url: process.env["DATABASE_URL_DIRECT"] || process.env["DATABASE_URL"] || "",
  },
  // Keep generated SQL readable in review — this package's migrations are
  // reviewed as pure DDL.
  breakpoints: true,
  strict: true,
} satisfies Config;
