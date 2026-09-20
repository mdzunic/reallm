// SPEC-001 §3. The e2e suite runs in two situations:
//   - `npm run e2e` / the factory's regression gate: no dev server is running,
//     so `webServer` starts one;
//   - the factory's QA stage: the container entrypoint has already started the
//     dev server on 5173, so `reuseExistingServer` must stay true.
//
// PORT overrides 5173 for a developer whose machine already serves another
// Vite app there (`PORT=5199 npm run e2e`); vite.config.ts reads the same
// variable, so the dev server this starts listens where the tests look.
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PORT ?? 5173);
/**
 * SPEC-015 D-13: the offline and installability cases need a *real build* — a
 * dev server has no precache manifest and serves no service worker, so there is
 * nothing to go offline with. They run in their own project against
 * `vite preview` over `dist/`, on Vite's own preview port.
 */
const previewPort = Number(process.env.PREVIEW_PORT ?? 4173);
const PWA_SPEC = /SPEC-015-pwa\.spec\.ts/;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  // Opens the game once, before the first test, so the dev server's cold start
  // is not charged to whichever test happened to be scheduled first.
  globalSetup: './e2e/global-setup.ts',
  // Playwright's default is 30 s, which the cold-start budget of `awaitGate`
  // (e2e/start.ts) could eat on its own on a slow container — twice over, now
  // that a page which never evaluated `main.ts` is reloaded once and waited for
  // again. The long suites already set their own — 90 s, 150 s, 540 s — so this
  // floor hides no hang that the default was catching.
  timeout: 120_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    // The dev-server project, unchanged — it ignores the preview-only file.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: PWA_SPEC },
    // SPEC-015 AC-56: the build-backed project, and only that one file.
    {
      name: 'pwa',
      testMatch: PWA_SPEC,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${previewPort}` },
    },
  ],
  webServer: [
    {
      command: 'npm run dev',
      url: `http://localhost:${port}`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      // A real build, served the way a deploy would serve it. `--strictPort`
      // so a preview already on 4173 is reused rather than silently answered
      // from somewhere else.
      command: `npm run build && npx vite preview --port ${previewPort} --strictPort`,
      url: `http://localhost:${previewPort}`,
      reuseExistingServer: true,
      timeout: 300_000,
    },
  ],
});
