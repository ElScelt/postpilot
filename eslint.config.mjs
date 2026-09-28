import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

export default defineConfig([
  ...nextVitals,
  // The mistakes that type information catches and a test can miss: a promise nobody
  // awaits lets a Redis write or a QStash call fail silently, and a switch that forgets
  // a post status handles it by accident.
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", {
        // node:test runs a test whether or not its promise is awaited.
        allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "describe", "it", "suite"] }],
      }],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  globalIgnores([".next/**", "node_modules/**"]),
]);
