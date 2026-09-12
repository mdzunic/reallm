// SPEC-020 §4.7 — the flight view's render budget on `medium`, and the two
// things about the trip only a browser can show: the sky window tinting during
// an ion storm (20-g), and the engine glows actually reaching the frame.
//
// Time does not pass for real here either: `window.__reallmFlight` (dev builds
// only, SPEC-013 §4.9) warps the simulation, tops the asteroid field up to the
// preset's cap and parks a hazard that never lets the trip arrive, so a 150 s
// flight costs milliseconds.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

/** The dev flight hook, reached through a cast so no two suites redeclare it. */
interface FlightHook {
  phase(): string;
  state(): { progress: number; storm: boolean; holding: boolean };
  warp(seconds: number): void;
  blockArrival(): void;
  clearSky(): void;
  /** SPEC-020 AC-15: top the field up to `quality.asteroidCap`. */
  fillAsteroids(): void;
}

const CINDER4 = '/?debug&scene=flight&planet=cinder4&quality=medium';
/** Ferrum is an `ionStorm` world; its first storm window opens inside 70 s. */
const FERRUM = '/?debug&scene=flight&planet=ferrum&quality=medium';

async function afterFrames(page: Page, frames: number): Promise<{ drawCalls: number; triangles: number; sceneInfo: Record<string, number | string> | null }> {
  const from = (await page.evaluate(() => window.__reallm.stats())).frame;
  await page.waitForFunction((target) => window.__reallm.stats().frame >= target, from + frames);
  return page.evaluate(() => window.__reallm.stats());
}

/** The scene mounts its hook on enter; every suite waits for it before driving. */
async function awaitFlightHook(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
}

test('the medium flight frame stays inside the §4.7 budget with the field full (AC-15)', async ({ page }) => {
  await start(page, CINDER4);
  await awaitFlightHook(page);
  // A fighter that never leaves puts a ship — and its engine glow — in frame,
  // and keeps the trip from arriving while the field fills.
  await page.evaluate(() => {
    const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
    hook.blockArrival();
    hook.fillAsteroids();
  });

  const stats = await afterFrames(page, 30);
  // The field really is at `asteroidCap` (60 on medium) when the frame is read.
  expect(Number(stats.sceneInfo?.['hazards'] ?? 0)).toBeGreaterThanOrEqual(60);
  expect(stats.drawCalls).toBeGreaterThan(8); // the dressing actually drew
  expect(stats.drawCalls).toBeLessThanOrEqual(56); // 40 scene + 16 post
  expect(stats.triangles).toBeGreaterThan(5_000);
  expect(stats.triangles).toBeLessThanOrEqual(80_000);
});

test('a trip whose art never loads keeps its primitives and flies anyway (AC-9, 20-h)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  // Only the trip's own files: the five boot-manifest entries still have to
  // load, or the gate never opens and there is no scene to judge.
  await page.route(/\/assets\/models\/(fighter|interceptor|cockpit|asteroid)\.glb$/, (route) => route.abort());
  await page.route('**/assets/textures/flight/**', (route) => route.abort());
  await page.route('**/assets/textures/sprites/**', (route) => route.abort());

  await start(page, CINDER4);
  await awaitFlightHook(page);
  await page.evaluate(() => {
    const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
    hook.blockArrival();
    hook.fillAsteroids();
  });

  // The scene is still up and still drawing the field: SPEC-013's primitives
  // stand in for every model and map that never arrived, and nothing threw.
  const stats = await afterFrames(page, 30);
  expect(Number(stats.sceneInfo?.['hazards'] ?? 0)).toBeGreaterThanOrEqual(60);
  expect(stats.drawCalls).toBeGreaterThan(5);
  expect(stats.triangles).toBeGreaterThan(1_000);
  expect(errors).toEqual([]);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
});

test('the sky window shifts toward the planet accent during an ion storm (AC-14, 20-g)', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page, FERRUM);
  await awaitFlightHook(page);
  await expect(page.locator('[data-testid="debug-scene"]')).toContainText('skyTint=0');

  // Warp in slices, sweeping the sky each time so an idle ship survives the
  // trip out to the storm window (§4.5: gap 40–70 s, length 15–25 s).
  const stormed = await page.evaluate(() => {
    const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
    hook.blockArrival();
    for (let step = 0; step < 60 && !hook.state().storm; step++) {
      hook.clearSky();
      hook.warp(2);
      if (hook.phase() === 'recalled' || hook.phase() === 'arrived') break;
    }
    return hook.state().storm;
  });
  expect(stormed).toBe(true);

  // The tint ramps over the frames that follow, not inside the warp.
  await page.waitForFunction(() => Number(window.__reallm.stats().sceneInfo?.['skyTint'] ?? 0) > 0.5, undefined, {
    timeout: 10_000,
  });
  await expect(page.locator('[data-testid="debug-scene"]')).toHaveText(/^scene flight(?: [\w-]+=[^\s]+)*$/);
});
