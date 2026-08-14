import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/", "**/node_modules/", "**/*.config.js", "**/*.config.ts"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  },
  {
    // Plain Node scripts: no TS lib to declare the runtime globals they use.
    files: ["tools/**/*.mjs"],
    languageOptions: {
      globals: Object.fromEntries(
        ["Buffer", "URL", "console", "fetch", "process", "setTimeout"].map((g) => [g, "readonly"])
      )
    }
  }
);
