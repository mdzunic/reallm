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
