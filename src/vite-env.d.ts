/// <reference types="vite/client" />

/** Injected by vite.config.ts `define` from package.json's version (SPEC-001 §3). */
declare const __APP_VERSION__: string;

/**
 * SPEC-015 §10 — the service-worker registration module, supplied by the PWA
 * plugin (`vite-pwa.ts`). The shape is `vite-plugin-pwa`'s own, so the import in
 * `main.ts` needs no edit if this repository ever swaps its local plugin for the
 * package: `registerSW` returns the one call that applies a waiting build.
 */
declare module 'virtual:pwa-register' {
  export interface RegisterSWOptions {
    /** Register at once rather than on `window.load`. Default `false`. */
    immediate?: boolean;
    /** A new build is installed and waiting behind the current one (15-c). */
    onNeedRefresh?: () => void;
    /** The first install finished; the app now works offline. */
    onOfflineReady?: () => void;
    onRegisteredSW?: (swScriptUrl: string, registration: ServiceWorkerRegistration | undefined) => void;
    onRegisterError?: (error: unknown) => void;
  }

  /** @returns `updateSW(reloadPage?)` — activates the waiting build (AC-52). */
  export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
}
