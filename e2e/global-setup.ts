// Runs once, after Playwright has the dev server and before the first test.
//
// Every suite starts with `page.goto()` followed by a wait for the boot gate
// (start.ts), and that first wait of the whole run is different in kind from
// every later one: it is the only one that also pays for the dev server waking
// up. A `npm run e2e` on a clean clone — which is how the merge gate runs it —
// meets a Vite server that has just been started, whose module graph has not
// been transformed, whose dependency optimisation may still be in flight, and
// whose watcher may still be draining the checkout it was pointed at. The port
// answers long before any of that is true, so `webServer.url` is not a
// readiness signal for the *app*, only for the socket.
//
// The cost of that first load landed inside whichever test happened to be
// scheduled first, and blew its budget: on the gate's container the run's first
// test sat on `[data-testid="boot-start"]` for the full 30 s and reported the
// element as absent — not hidden, absent, which means the page had not
// evaluated `src/main.ts` at all, because `main.ts` builds the whole boot
// overlay synchronously. The three tests that ran after it took 0.9–2.2 s each.
//
// So the run opens the game once here instead. Nothing is asserted away: the
// gate has to appear, and if it never does the whole run fails immediately with
// a message that names the dev server rather than an innocent test.
import { chromium } from '@playwright/test';
import { E2E_PRESET, GATE_TIMEOUT_MS } from './start';

/** How many navigations the warm-up gets before it declares the server broken. */
const ATTEMPTS = 3;

export default async function globalSetup(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 5173);
  const url = `http://localhost:${port}/?quality=${E2E_PRESET}`;
  const browser = await chromium.launch();
  const started = Date.now();
  try {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'commit' });
        await page.waitForSelector('[data-testid="boot-start"]', { state: 'visible', timeout: GATE_TIMEOUT_MS });
        console.log(`[e2e] dev server warm: boot gate in ${Date.now() - started} ms (attempt ${attempt}/${ATTEMPTS})`);
        return;
      } catch (error) {
        if (attempt === ATTEMPTS) {
          throw new Error(
            `[e2e] the app never reached its boot gate at ${url} after ${ATTEMPTS} navigations ` +
              `(${Date.now() - started} ms). The dev server is not serving a working build.`,
            { cause: error },
          );
        }
        console.warn(`[e2e] no boot gate on attempt ${attempt}/${ATTEMPTS}; reloading the dev server's first page`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
