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

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** How far the ship moves in `ms` of real time, in metres on the plane. */
async function drift(page: Page, ms: number): Promise<number> {
  const a = await sceneInfo(page);
  await page.waitForTimeout(ms);
  const b = await sceneInfo(page);
  return Math.hypot(Number(b['shipX']) - Number(a['shipX']), Number(b['shipY']) - Number(a['shipY']));
}

/** A steering key held for a quarter second — a tap, as a player gives one. */
async function tap(page: Page, code: string): Promise<void> {
  await page.keyboard.down(code);
  await page.waitForTimeout(250);
  await page.keyboard.up(code);
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

  test('departing with a mouse click, mouse steer neither runs the ship away nor tows it home (§4.1, PC-01)', async ({ page }) => {
    test.setTimeout(120_000);
    // The shipped settings, mouse steer on; only auto-fire is off, so no shot muddies the sky.
    await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off' })));
    await start(page, '/?debug&films=off&quality=medium');
    await page.evaluate((creation) => {
      window.__reallm.save().create(0, creation).resources['oil'] = 200;
    }, CREATION);
    for (const id of ['station', 'starmap']) {
      expect(await page.evaluate(async (id) => window.__reallm.go(id, id === 'station' ? {} : undefined), id)).toBe(true);
    }
    // Real clicks, as a player departs: the pointer is left on the confirm
    // sheet's Depart, well off the centre of the screen.
    await page.locator('[data-testid="starmap-depart"]').click();
    await page.locator('[data-testid="confirm-yes"]').click();
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight', { timeout: 20_000 });
    await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
    const clear = (): Promise<void> => page.evaluate(() => (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight.clearSky());
    await expect.poll(async () => String((await sceneInfo(page))['phase']), { timeout: 20_000 }).toBe('cruise');
    await clear();

    // A pointer still where the click left it steers nothing.
    expect(await drift(page, 2_000)).toBeLessThan(0.3);
    expect(Number((await sceneInfo(page))['offLine'])).toBeLessThan(1);

    // A tap coasts a few metres and stops.
    await tap(page, 'KeyW');
    await page.waitForTimeout(2_500);
    await clear();
    expect(await drift(page, 1_000)).toBeLessThan(0.3);

    // The old runaway: the pointer moved onto the centre, then a tap. The
    // cockpit pitches with the ship's speed, and the steer once read through
    // it; now the ship settles and stays inside the corridor.
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    await page.mouse.move(viewport.width / 2, viewport.height / 2, { steps: 4 });
    await tap(page, 'KeyS');
    await page.waitForTimeout(2_500);
    await clear();
    expect(await drift(page, 1_000)).toBeLessThan(0.3);
    expect(Number((await sceneInfo(page))['offLine'])).toBeLessThan(16);

    // A small pointer move, inside the 4 m dead zone (about 25 px on a 720 px
    // tall window), aims without steering.
    await page.mouse.move(viewport.width / 2 + 15, viewport.height / 2 - 10, { steps: 2 });
    expect(await drift(page, 1_500)).toBeLessThan(0.3);
    await page.mouse.move(viewport.width / 2, viewport.height / 2, { steps: 2 });

    // Mouse steer still steers: a pointer above the nose climbs, and back on
    // the nose the ship comes to rest.
    const startY = Number((await sceneInfo(page))['shipY']);
    await page.mouse.move(viewport.width / 2, viewport.height * 0.3, { steps: 4 });
    await expect.poll(async () => Number((await sceneInfo(page))['shipY']), { timeout: 5_000, intervals: [100] }).toBeGreaterThan(startY + 5);
    await page.mouse.move(viewport.width / 2, viewport.height / 2, { steps: 4 });
    await page.waitForTimeout(2_500);
    await clear();
    expect(await drift(page, 1_000)).toBeLessThan(0.3);

    const info = await sceneInfo(page);
    expect(info['phase']).toBe('cruise');
    expect(info['recallCause']).toBe('-');
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
