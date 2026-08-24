import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// A dedicated, separate gate for the official Obsidian plugin guidelines
// linter (`npm run lint:obsidian`), kept apart from the project's own
// eslint.config.mjs so its recommended rule set never silently changes the
// behavior of the primary `npm run lint` gate. Scoped to shipped source
// only -- test files are never part of what gets submitted for community
// review, so they are excluded here (main.js is built only from non-test
// modules) rather than reviewed against plugin-store guidelines that don't
// apply to them.
export default defineConfig([
  // A global ignore (no `files`) excludes test files from every config
  // object below, including obsidianmd.configs.recommended's own file
  // globs -- a `files`+`ignores` pair on just the local block below would
  // only narrow that one block, not the plugin's own recommended configs.
  { ignores: ["src/**/*.test.ts"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript's own checker already reports undefined identifiers
      // (including ambient global types like `BufferEncoding` from
      // @types/node); the base `no-undef` rule has no type information and
      // false-positives on those, which is why typescript-eslint's own
      // docs recommend disabling it for TS files.
      "no-undef": "off",
    },
  },
]);
