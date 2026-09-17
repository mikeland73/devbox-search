import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// The `@/` alias the route handlers use (tsconfig paths), so tests can
// import them directly.
export default defineConfig({
  resolve: { alias: { "@": resolve(import.meta.dirname) } },
});
