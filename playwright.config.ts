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

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  // Playwright's default is 30 s, which the cold-start budget of `awaitGate`
  // (e2e/start.ts) could eat on its own on a slow container. The long suites
  // already set their own — 90 s, 150 s, 540 s — so this floor hides no hang
  // that the default was catching.
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
