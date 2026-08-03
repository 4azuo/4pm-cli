/**
 * Build-time stub for `react-devtools-core` (ADR-0015/0057). ink's reconciler only
 * `await import('./devtools.js')` when `process.env.DEV === 'true'`, and that module does
 * a top-level `import devtools from 'react-devtools-core'`. The CLI never enables ink DEV
 * devtools, and the package is an optional dep we don't install. With `splitting: false`
 * esbuild would otherwise hoist that external import into `dist/index.js` and crash at load
 * (ERR_MODULE_NOT_FOUND). Aliasing it to this no-op keeps the single bundle self-contained;
 * the stub is only ever touched if someone runs with DEV=true, where it stays a harmless no-op.
 */
export default { connectToDevTools() {} };
