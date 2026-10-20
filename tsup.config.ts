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
  // `agent-helper` (ADR-0499): the standalone helper agent processes run (git credential helper, gh/glab
  // shim token source, ssh ProxyCommand) — bundled on its own so the daemon can copy it to the run dir.
  entry: { index: "src/index.ts", "agent-helper": "src/agent-helper.ts" },
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  clean: true,
  // The scaffolder copies the `project-sample/` template into new projects (core/scaffold.ts).
  // tsup bundles JS only, so copy the template dir alongside the bundle as `dist/project-sample`
  // — it then travels with `dist/` through every channel (npm-global, container image, the
  // ADR-0015 self-download tarball) and `sampleDir()` resolves it relative to `dist/`.
  onSuccess: async () => {
    const { cp, rename } = await import("node:fs/promises");
    await cp(
      new URL("project-sample", import.meta.url),
      new URL("dist/project-sample", import.meta.url),
      { recursive: true },
    );
    // `npm publish` and `pnpm deploy` (the container image) always drop a package's `.gitignore` files, so the
    // template's ships as `gitignore`; the scaffold writes it back as `.gitignore` (scaffold.ts `PACKAGED_GITIGNORE`
    // — ADR-0568).
    await rename(new URL("dist/project-sample/.gitignore", import.meta.url), new URL("dist/project-sample/gitignore", import.meta.url));
    // The book templates the scaffold resets tracking files to (kept out of the projects — ADR-0563).
    await cp(new URL("book-templates", import.meta.url), new URL("dist/book-templates", import.meta.url), { recursive: true });
  },
  // Force a single self-contained `dist/index.js` (ADR-0015). tsup defaults ESM
  // `splitting` to true, which emits a shared `chunk-*.js` that index.js STATICALLY
  // imports — so a dist copied/extracted without that sibling fails at load with
  // ERR_MODULE_NOT_FOUND. Disabling splitting folds the chunk into index.js, matching
  // the "single ESM output needs no extra assets" intent below and removing that
  // whole failure class (release packaging copies the full dist either way).
  splitting: false,
  // Bundle workspace packages (main points at src/*.ts) plus the runtime deps `ws`
  // and `zod` so the output needs nothing installed on the worker machine. tsup
  // externalizes package.json `dependencies` by default, so every runtime dep that
  // must ship inside the single file has to be listed here — otherwise it stays a
  // bare `import` and the npm-global/self-download install throws ERR_MODULE_NOT_FOUND
  // at load (`zod` is imported at top level, so it crashes immediately).
  // Bundle the TUI stack (ink/react + their deps) too so the self-download tarball
  // stays self-contained (ADR-0015/0057). yoga-layout (ink's layout engine) inlines
  // its wasm as base64, so the single ESM output needs no extra assets.
  // NOTE: `@aws-sdk/client-s3` is intentionally left external — it is loaded via a
  // lazy `await import(...)` only on the S3 code path (see core), not at load time.
  // `tar` (self-update extraction, ADR-0305) is bundled too so the self-download tarball stays
  // self-contained — the old code shelled out to the system `tar`, which is absent/inconsistent
  // (busybox) in minimal worker containers.
  // `jsonc-parser` edits `.vscode/tasks.json` / settings JSONC in place for package installs (ADR-0460).
  // `mermaid` parses the sequence diagrams an intake writes before they are committed (ADR-0580); it is
  // `await import`ed, so its module body runs only when a check first runs (its code still loads with the file).
  noExternal: [/^@4pm\//, "ws", "zod", "ink", "react", "react/jsx-runtime", "tar", "jsonc-parser", "mermaid"],
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
