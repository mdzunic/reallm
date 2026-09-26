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
//
// It also names the WebGL renderer the run draws with, because that decides how
// fast every frame-counting and in-game-timer suite can go (start.ts,
// `E2E_PRESET`). CI sets `E2E_REQUIRE_GPU`: its e2e runners were picked for
// their GPU (.github/workflows/check.yml), and a run that fell back to a CPU
// rasteriser fails here in one line instead of as a wall of timeouts.
import { chromium, type Browser } from '@playwright/test';
import { E2E_PRESET, GATE_TIMEOUT_MS } from './start';

/** How many navigations the warm-up gets before it declares the server broken. */
const ATTEMPTS = 3;

/** The renderer strings of the CPU rasterisers Chromium can end up on. */
const SOFTWARE_GL = /SwiftShader|llvmpipe|lavapipe|softpipe/i;

/** What `UNMASKED_RENDERER_WEBGL` reads in a fresh page of `browser`. */
async function webglRenderer(browser: Browser): Promise<string> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (gl === null) return 'no WebGL 2 context';
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL));
    });
  } finally {
    await page.close();
  }
}

export default async function globalSetup(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 5173);
  const url = `http://localhost:${port}/?quality=${E2E_PRESET}`;
  // The same Chromium build the projects launch (`E2E_CHANNEL`, playwright.config.ts).
  const browser = await chromium.launch({ channel: process.env['E2E_CHANNEL'] || undefined });
  const started = Date.now();
  try {
    const renderer = await webglRenderer(browser);
    console.log(`[e2e] WebGL renderer: ${renderer}`);
    const onGpu = renderer.startsWith('ANGLE') && !SOFTWARE_GL.test(renderer);
    if (process.env['E2E_REQUIRE_GPU'] && !onGpu) {
      throw new Error(
        `[e2e] E2E_REQUIRE_GPU is set, but WebGL is not on a GPU here (${renderer}). ` +
          'The default headless shell never uses one: set E2E_CHANNEL=chromium, on a host that has a GPU.',
      );
    }
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
