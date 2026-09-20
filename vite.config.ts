// SPEC-001 §3. `vitest/config` rather than `vite` so the `test` block is typed;
// it re-exports Vite's own defineConfig.
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
// The extension is explicit: Vite's native config loader warns without it.
import { VitePWA } from './vite-pwa.ts';

export default defineConfig({
  base: './',
  /**
   * SPEC-015 §10 — the offline app. The options are §10's, field for field;
   * `VitePWA` itself is this repository's implementation of them rather than
   * `vite-plugin-pwa`, because adding a dependency was not available to the
   * build that wrote this (see `vite-pwa.ts` for the whole of the difference,
   * and `docs/BUGS.md` for what swapping in the plugin costs).
   *
   * §10's `manifest` block is not here: the manifest ships as
   * `public/manifest.webmanifest`, linked from `index.html` (AC-49), so it is
   * the same file in `npm run dev` and in a build, and `tests/ui/manifest.test.ts`
   * reads it off disk. `includeAssets` precaches it along with the icons.
   */
  plugins: [
    VitePWA({
      registerType: 'prompt',
      // §10's list, plus the manifest itself: the icons and the favicon are
      // already `**/*.{png,svg}`, but no glob pattern ends in `.webmanifest`
      // and an installed app that has never been online should still have one.
      includeAssets: ['assets/**/*', 'manifest.webmanifest'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,glb,webm,mp3,mp4,png,webp,svg,json}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
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
