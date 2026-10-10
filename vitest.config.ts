/**
 * vitest config — resolve the `@4pm/*` imports to the vendored trimmed subset (`vendor/`), the same
 * mapping `tsconfig.json` uses, so tests of code that imports the shared packages run standalone.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Absolute path of one vendored package entry. */
const vendor = (pkg: string): string => fileURLToPath(new URL(`./vendor/@4pm/${pkg}/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@4pm/constants": vendor("constants"),
      "@4pm/dto": vendor("dto"),
      "@4pm/validation": vendor("validation"),
      "@4pm/utils": vendor("utils"),
      "@4pm/ws": vendor("ws"),
    },
  },
});
