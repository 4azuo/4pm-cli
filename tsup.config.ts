/**
 * tsup config — bundle the CLI with the @4pm/* source packages AND its npm deps
 * so `dist/index.js` is fully self-contained (the auto-update self-download
 * tarball ships no node_modules — ADR-0015).
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

/** Absolute path to the react-devtools-core build stub (see the alias note below). */
const devtoolsStub = fileURLToPath(
  new URL("./build/react-devtools-core.stub.mjs", import.meta.url),
);

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  // Force a single self-contained `dist/index.js` (ADR-0015). tsup defaults ESM
  // `splitting` to true, which emits a shared `chunk-*.js` that index.js STATICALLY
  // imports — so a dist copied/extracted without that sibling fails at load with
  // ERR_MODULE_NOT_FOUND. Disabling splitting folds the chunk into index.js, matching
  // the "single ESM output needs no extra assets" intent below and removing that
  // whole failure class (release packaging copies the full dist either way).
  splitting: false,
  // Bundle workspace packages (main points at src/*.ts) and `ws` (only runtime
  // dep) so the output needs nothing installed on the worker machine.
  // Bundle the TUI stack (ink/react + their deps) too so the self-download tarball
  // stays self-contained (ADR-0015/0057). yoga-layout (ink's layout engine) inlines
  // its wasm as base64, so the single ESM output needs no extra assets.
  noExternal: [/^@4pm\//, "ws", "ink", "react", "react/jsx-runtime"],
  // ink's reconciler only `await import('./devtools.js')` when process.env['DEV'] ===
  // 'true' (ADR-0057), and that module top-level `import`s the optional `react-devtools-core`
  // we don't install. With splitting off esbuild inlines the dynamic-import target and would
  // hoist that external import into index.js ⇒ ERR_MODULE_NOT_FOUND at load. `define` can't
  // prune the guard (ink uses bracket access `process.env['DEV']`, which the dotted define
  // doesn't match), so alias the dep to a no-op stub instead — bundled, self-contained, and
  // only ever reached (as a no-op) under DEV=true. `define` stays as a belt for any dotted use.
  define: { "process.env.DEV": '"false"' },
  esbuildOptions(options) {
    options.alias = { ...options.alias, "react-devtools-core": devtoolsStub };
  },
  // `ws` is CommonJS and calls require("events"/"stream"/...) at runtime. In an
  // ESM bundle `require` is undefined, so esbuild's shim throws "Dynamic require
  // of X is not supported". Define a real require (+ __filename/__dirname) so the
  // shim delegates to Node's loader instead of throwing.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
  // The version is read at runtime from the sibling package.json (ADR-0052) — no
  // build-time env baking. package.json ships alongside dist/ in both the npm-global
  // package and the self-download tarball.
});
