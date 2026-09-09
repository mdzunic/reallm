// SPEC-001 §3. `vitest/config` rather than `vite` so the `test` block is typed;
// it re-exports Vite's own defineConfig.
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Injected for save.meta.appVersion (SPEC-007); declared in src/vite-env.d.ts.
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0') },
  server: {
    // 5173 is what the factory's QA stage and playwright.config.ts expect.
    // PORT is for a developer who already has another Vite app on 5173:
    // `PORT=5199 npm run e2e` (playwright.config.ts reads the same variable).
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
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
