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
/**
 * SPEC-015 D-8: the specs that need a *phone*, not a narrow desktop window.
 * §12 runs `SPEC-015.spec.ts` in both projects — the shipped rotate heuristic
 * reads `navigator.maxTouchPoints` (D-5), which a Desktop Chrome context
 * reports as 0 however small its window is, so the desktop project can only
 * ever reach those paths through a monkeypatch.
 *
 * `SPEC-012-touch.spec.ts` and `touch-controls.spec.ts` are deliberately not
 * here: both pin their own context in-file with `test.use({ hasTouch: true, … })`,
 * so listing them would run the same emulation twice and change nothing.
 */
const PHONE_SPECS = /SPEC-015\.spec\.ts/;

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
    // SPEC-015 AC-64/D-8: the same dev server, seen from a phone. `Pixel 5`
    // brings the three things the desktop project cannot fake together — real
    // touch points, a 393×851 screen and a 2.75 device pixel ratio — so the
    // rotate overlay, the auto-pause and the dpr clamp are exercised on the
    // shape they were written for rather than on a resized desktop window.
    {
      name: 'mobile',
      testMatch: PHONE_SPECS,
      // Serially, for the same reason the `pwa` project is: this file loads the
      // surface scene on most of its pages, and a second project running the
      // same wave in parallel with `chromium` starves both. One worker costs
      // about a minute and keeps the two projects out of each other's way.
      fullyParallel: false,
      use: { ...devices['Pixel 5'] },
    },
    // SPEC-015 AC-56: the build-backed project, and only that one file.
    {
      name: 'pwa',
      testMatch: PWA_SPEC,
      // Serially: every case in the file registers the worker in its own fresh
      // context, and each registration precaches the whole ≈ 21 MB app. Five of
      // those installing at once starves the preview server for no gain.
      fullyParallel: false,
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
