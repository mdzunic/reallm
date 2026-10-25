// SPEC-069 §6.3: free flight in a real browser. The unit suite proves the
// steering, the tank, the approach rule and the signals; what only a browser
// shows is the wiring — real keys move the ship off the line and nothing pulls
// it back, the course marker turns to an edge arrow pointing home, the fuel bar
// burns, an empty tank shows the tow card and the station's own banner, and a
// canister flown into is taken.
//
// `window.__reallmFlight` (dev builds only) warps the simulation and places the
// ship and canisters, so a 90 s trip costs milliseconds.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

interface FlightHook {
  phase(): string;
  warp(seconds: number): void;
  clearSky(): void;
  park(x: number, y: number): void;
  setFuel(fuel: number): void;
  dropPickup(kind: 'fuel' | 'oil' | 'missile', dx: number, dy: number, depth: number): void;
}

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

/** The flight scene on Cinder-4, past its 3 s launch, with an empty sky. */
async function cruise(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off', flightMouseSteer: false })));
  await start(page, '/?debug&scene=flight&planet=cinder4&quality=medium');
  await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
  await page.evaluate(() => {
    const flight = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
    flight.warp(3.1);
    flight.clearSky();
  });
  await expect.poll(async () => Number((await sceneInfo(page))['launch'])).toBe(1);
}

test.describe('free flight (SPEC-069)', () => {
  test('held keys take the ship far off the line, and nothing pulls it back (§4.1)', async ({ page }) => {
    test.setTimeout(90_000);
    await cruise(page);
    await page.keyboard.down('KeyD');
    await expect.poll(async () => Number((await sceneInfo(page))['shipX']), { timeout: 30_000, intervals: [100] }).toBeGreaterThan(40);
    await page.keyboard.up('KeyD');
    // The coast carries it a little further, then it stays: no drift back.
    await page.waitForTimeout(1_500);
    const settled = Number((await sceneInfo(page))['shipX']);
    expect(settled).toBeGreaterThan(40);
    await page.waitForTimeout(1_500);
    expect(Number((await sceneInfo(page))['shipX'])).toBeGreaterThanOrEqual(settled - 0.01);
    // Past the corridor the tank burns extra, and the bar says so.
    await expect(page.getByTestId('hud-fuel')).toHaveClass(/is-burning/);
  });

  test('the course marker sits on the line ahead, and rides the edge pointing home from far off (§4.5)', async ({ page }) => {
    await cruise(page);
    const course = page.getByTestId('flight-course');
    await expect(course).toHaveAttribute('data-state', 'on');
    await expect(course).toContainText('Cinder-4');
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    await page.evaluate(() => (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight.park(140, 0));
    await expect(course).toHaveAttribute('data-state', 'edge');
    await expect(course).toContainText('140 m');
    // The line is to the left of a ship 140 m right of it.
    const box = await course.boundingBox();
    if (box === null) throw new Error('no course marker box');
    expect(box.x + box.width / 2).toBeLessThan(viewport.width / 2);
    await expect(page.getByTestId('hud-fuel')).toHaveClass(/is-burning/);
  });

  test('an empty tank is a tow: the card, then the station names it (§4.2, E133)', async ({ page }) => {
    test.setTimeout(60_000);
    await cruise(page);
    await page.evaluate(() => {
      const flight = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
      flight.setFuel(0.05);
      flight.park(150, 0);
      flight.warp(5);
    });
    expect((await sceneInfo(page))['recallCause']).toBe('fuel');
    await expect(page.getByTestId('flight-towed')).toBeVisible();
    await expect(page.getByTestId('flight-explosion')).not.toHaveClass(/is-visible/);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station', { timeout: 20_000 });
    await expect(page.getByTestId('recall-banner')).toHaveText('Towed home');
  });

  test('a trip flown on the line arrives with about a third of the tank (§4.2)', async ({ page }) => {
    test.setTimeout(60_000);
    await cruise(page);
    const fuel = await page.evaluate(() => {
      const flight = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
      for (let s = 0; s < 200 && flight.phase() !== 'arrived'; s++) {
        flight.clearSky();
        flight.warp(1);
      }
      return { phase: flight.phase(), fuel: Number(window.__reallm.stats().sceneInfo?.['fuel']) };
    });
    expect(fuel.phase).toBe('arrived');
    // The stats row was written by the last rendered frame; the tank stops at arrival either way.
    await expect.poll(async () => Number((await sceneInfo(page))['fuel'])).toBeCloseTo(0.35, 1);
  });

  test('a canister flown into is taken (§4.4)', async ({ page }) => {
    await cruise(page);
    await page.evaluate(() => {
      const flight = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
      flight.setFuel(0.5);
      flight.dropPickup('fuel', 2, 0, 40);
      flight.warp(1.5);
    });
    await expect.poll(async () => String((await sceneInfo(page))['signals'])).toMatch(/\/1$/);
    await expect.poll(async () => Number((await sceneInfo(page))['fuel'])).toBeGreaterThan(0.65);
    await expect(page.locator('[data-testid="toasts"]')).toContainText('Fuel cell');
  });
});
