/// <reference types="vite/client" />
/**
 * SPEC-015 §10 — types for `virtual:pwa-register`, the service-worker
 * registration module `main.ts` imports. It is `vite-plugin-pwa`'s own virtual
 * module, so its types come from the package rather than from a declaration
 * written here: `registerSW(options)` returns `updateSW(reloadPage?)`, the one
 * call that applies a waiting build (AC-52).
 */
/// <reference types="vite-plugin-pwa/client" />

/** Injected by vite.config.ts `define` from package.json's version (SPEC-001 §3). */
declare const __APP_VERSION__: string;
