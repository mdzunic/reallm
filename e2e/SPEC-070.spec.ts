// SPEC-070 §6.2: homing missiles in a real browser. The unit suite proves the
// lock, the flight, the sweep, the splash and the drops; what only a browser
// shows is the wiring — the bracket on a locked ship, F firing one, the rack
// emptying in the HUD, the refusal's line, and the MSL button on touch.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

interface FlightHook {
  phase(): string;
  warp(seconds: number): void;
  clearSky(): void;
  blockArrival(): void;
  setMissiles(count: number): void;
}

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

test.describe('homing missiles (SPEC-070)', () => {
  test('a still fighter ahead is locked, F downs it, and the empty rack refuses (§4.2–§4.6)', async ({ page }) => {
    test.setTimeout(90_000);
    // Auto-fire off, so only the missile can down the fighter; no pointer, so the guns look down the ship's lane.
    await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off', flightMouseSteer: false })));
    await start(page, '/?debug&scene=flight&planet=cinder4&quality=medium');
    await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
    await page.evaluate(() => {
      const flight = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
      flight.warp(3.1);
      flight.clearSky();
      flight.blockArrival();
    });
    await expect(page.getByTestId('hud-missiles')).toHaveAttribute('data-count', '1');
    await expect(page.getByTestId('hud-lock')).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => Number((await sceneInfo(page))['lock'])).toBe(1);
    await page.keyboard.press('KeyF');
    await expect(page.getByTestId('hud-missiles')).toHaveAttribute('data-count', '0');
    await expect.poll(async () => Number((await sceneInfo(page))['hostiles']), { timeout: 20_000 }).toBe(0);
    // Nothing to lock and nothing in the rack: the bracket goes, and F says why.
    await expect(page.getByTestId('hud-lock')).toBeHidden();
    await page.keyboard.press('KeyF');
    await expect(page.getByTestId('hud-refusal')).toHaveText('Rack empty');
  });

  test('the right mouse button fires one too (§4.5)', async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off', flightMouseSteer: false })));
    await start(page, '/?debug&scene=flight&planet=cinder4&quality=medium');
    await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
    await page.evaluate(() => {
      const flight = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
      flight.warp(3.1);
      flight.clearSky();
      flight.blockArrival();
    });
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    // Find the fighter with the pointer as SPEC-041's case does: down the middle until the lock takes it.
    for (let k = 0; k <= 16 && Number((await sceneInfo(page))['lock']) !== 1; k++) {
      await page.mouse.move(viewport.width / 2, viewport.height * (0.4 + 0.035 * k));
      await page.waitForTimeout(150);
    }
    await expect.poll(async () => Number((await sceneInfo(page))['lock'])).toBe(1);
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await expect(page.getByTestId('hud-missiles')).toHaveAttribute('data-count', '0');
  });

  test.describe('on touch', () => {
    test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

    test('MSL shows beside the throttle pair and dims with an empty rack (§4.5)', async ({ page }) => {
      await start(page, '/?scene=flight&planet=cinder4');
      await page.touchscreen.tap(240, 300);
      await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
      const msl = page.getByTestId('touch-missile');
      await expect(msl).toBeVisible();
      await expect(msl).toHaveText('MSL');
      await expect(msl).toHaveAttribute('data-count', '1');
      const box = await msl.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(56);
      await page.evaluate(() => (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight.setMissiles(0));
      await expect(msl).toHaveClass(/is-empty/);
    });
  });
});
