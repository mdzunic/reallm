// SPEC-001 §3. `vitest/config` rather than `vite` so the `test` block is typed;
// it re-exports Vite's own defineConfig.
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
import { VitePWA } from 'vite-plugin-pwa';
import type { VitePWAOptions } from 'vite-plugin-pwa';

/**
 * SPEC-015 §10 — the offline app: `vite-plugin-pwa` (a `^1.3.0` devDependency,
 * D-15), configured with §10's options field for field. Workbox generates the
 * worker; nothing about it is hand-written (AC-48).
 *
 * `registerType: 'prompt'` is the one that matters for the player: a new build
 * installs and then *waits*. Nothing calls `skipWaiting()` on its own, so no
 * page ever reloads mid-mission (15-c); `updateSW(true)`, behind the menu and
 * station Update buttons, is the only thing that applies it.
 *
 * The `manifest` literal is the only manifest that ships: the plugin emits it
 * and injects the one `<link rel="manifest">` into the built `index.html`
 * (D-10, AC-49), so there is no `public/manifest.webmanifest` and no link tag
 * in the source HTML. It is exported because it is the thing worth pinning:
 * `tests/ui/manifest.test.ts` and `tests/build/pwa.test.ts` read this object,
 * not a copy of it.
 */
export const PWA_OPTIONS = {
  registerType: 'prompt',
  includeAssets: ['assets/**/*'],
  workbox: {
    globPatterns: ['**/*.{js,css,html,glb,webm,mp3,mp4,png,webp,svg,json}'],
    maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
    navigateFallback: 'index.html',
    /**
     * §10's block is the three keys above; this fourth one is what makes them
     * work in *this* repository, and leaving it out ships a service worker
     * that caches nothing at all.
     *
     * Two passes build the precache manifest. `includeAssets` globs everything
     * under `public/assets/` and gives each file an md5 `revision`; the
     * `globPatterns` pass globs `dist/` and sets `revision: null` for anything
     * `dontCacheBustURLsMatching` covers, whose default here is `/^assets\//`
     * (Vite's `build.assetsDir`). ReaLLM keeps its game assets in
     * `public/assets/`, so the two passes meet on all ~170 of them and emit
     * each url twice — once keyed `url`, once keyed `url?__WB_REVISION__=…`.
     * Workbox's `addToCacheList` throws `add-to-cache-list-conflicting-entries`
     * on exactly that, and it throws while the worker is evaluating
     * `precacheAndRoute`: the build still succeeds, the worker still reaches
     * `activated`, and the app still works online — with an empty CacheStorage
     * and no offline boot at all. Measured in Chromium; the numbers either side
     * of the fix are in docs/playtest-log.md §SPEC-015.
     *
     * So the pattern is narrowed to what it is actually for: files whose *name*
     * already carries their version. That is Vite's hashed build output and
     * nothing else — `assets/index-DvFdC8v4.js`, `assets/index-nMQHEQhe.css` —
     * never the copied-through `assets/textures/noise.png`. Those now take an
     * md5 revision from both passes, which is the same md5 over the same bytes,
     * so the two entries collapse to one instead of colliding.
     * `tests/build/pwa.test.ts` fails if a url is ever emitted twice over.
     */
    dontCacheBustURLsMatching: /^assets\/[^/]+-[\w-]{8}\.(js|css)$/,
  },
  manifest: {
    name: 'ReaLLM',
    short_name: 'ReaLLM',
    display: 'standalone',
    orientation: 'landscape',
    background_color: '#000000',
    // One hex, three places: this, `index.html`'s `theme-color` meta and the
    // page background in `src/style.css` — the colour the app actually paints,
    // so an installed ReaLLM's title bar matches its boot screen.
    theme_color: '#0b0f14',
    start_url: './',
    scope: './',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  },
} satisfies Partial<VitePWAOptions>;

export default defineConfig({
  base: './',
  plugins: [VitePWA(PWA_OPTIONS)],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Injected for save.meta.appVersion (SPEC-007); declared in src/vite-env.d.ts.
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0') },
  server: {
    // 5173 is what the factory's QA stage and playwright.config.ts expect.
    // PORT is for a developer who already has another Vite app on 5173:
    // `PORT=5199 npm run e2e` (playwright.config.ts reads the same variable).
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    // The e2e run opens four pages the moment the port answers, and a cold dev
    // server transforms the whole module graph on demand — four times over, in
    // parallel, before the first boot gate can appear. Warming the entry from
    // the app's own HTML moves that work to server start-up, where nothing is
    // waiting on it. It costs a developer nothing either: `npm run dev` was
    // already going to transform these on the first page load.
    warmup: { clientFiles: ['./index.html', './src/main.ts'] },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 1500, // three is ~700 KB minified; one vendor chunk is fine
    // A separate `three` chunk (SPEC-001 §3). Rolldown takes `manualChunks`
    // only as a function; `codeSplitting` groups are its native form of the
    // same rule (the earlier name, `advancedChunks`, is deprecated).
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }] },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    mockReset: true,
  },
});
