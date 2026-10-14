// Node ESM loader shim for `scripts/test-trust-live.mjs`.
//
// The app's src/ modules are written for Vite, so they read config from
// `import.meta.env`. Plain node has no such object, so this loader rewrites
// that access to a global the test populates before importing anything. It
// exists so the live test can run the *actual shipped modules* — no copies, no
// stubs of the code under test, nothing that can drift from what is deployed.
export async function load(url, context, next) {
  const result = await next(url, context);
  if (!url.includes("/src/")) return result;
  let source = result.source?.toString?.() ?? "";
  if (!source.includes("import.meta.env")) return result;
  source = source.replaceAll("import.meta.env", "(globalThis.__VITE_ENV__ ?? {})");
  return { ...result, source, format: "module", shortCircuit: true };
}
