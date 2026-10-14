// Node ESM loader shim for the live tests (`scripts/test-trust-live.mjs`,
// `scripts/audit-e2e.mjs`).
//
// Two jobs, both about running the *actual shipped* src/ modules under plain
// node instead of copying them:
//
//   1. `import.meta.env` → a global the test populates before importing
//      anything (Vite provides that object in the browser; node does not).
//   2. JSON imports. Vite imports `src/data/taxonomy.json` bare, which is valid
//      for the bundler but needs an explicit import attribute under node's ESM
//      loader. Without this, any module that touches the taxonomy (the rules
//      filter, and everything that imports it) cannot be loaded by a test.
export async function load(url, context, next) {
  if (url.endsWith(".json")) {
    return next(url, { ...context, importAttributes: { type: "json" } });
  }
  const result = await next(url, context);
  if (!url.includes("/src/")) return result;
  let source = result.source?.toString?.() ?? "";
  if (!source.includes("import.meta.env")) return result;
  source = source.replaceAll("import.meta.env", "(globalThis.__VITE_ENV__ ?? {})");
  return { ...result, source, format: "module", shortCircuit: true };
}
