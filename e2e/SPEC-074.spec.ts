// SPEC-074 §6.2 (PLAN R31): the first ten minutes in a real browser — Dry
// Land's storm brings the first fight, a first trip departs on one Depart,
// the tutorial trip strays without burning and says why, creation keeps its
// Confirm in view, the phone station keeps its board clear of the build label
// and the opening lines, and the flight HUD is the ship's.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, frames, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const CORRIDOR_TIP = "Relay keeps a first run's tank full. From the next trip, straying off the course line burns fuel — the marker points back.";

interface FlightHook {
  phase(): string;
  warp(seconds: number): void;
  clearSky(): void;
  park(x: number, y: number): void;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const intersects = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox();
  if (found === null) throw new Error(`${selector} has no box`);
  return found;
}

/** A pressed debug-strip button, by test id. */
async function press(page: Page, id: string): Promise<void> {
  await page.evaluate((testid) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
    if (button === null) throw new Error(`no ${testid} on the debug strip`);
    button.click();
  }, id);
}

/** A new pilot, bound, with `oil` in the hold. */
async function pilot(page: Page, oil = 200): Promise<void> {
  await page.evaluate(
    ({ creation, oil }) => {
      window.__reallm.save().create(0, creation, 123).resources['oil'] = oil;
    },
    { creation: CREATION, oil },
  );
}

async function go(page: Page, id: string, params: unknown = {}): Promise<void> {
  await expect
    .poll(() => page.evaluate(async ({ id, params }) => window.__reallm.go(id, params).catch(() => false), { id, params }), { timeout: 10_000 })
    .toBe(true);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText(id, COLD_START);
}

// ---------------------------------------------------------- 1: the first fight

test('1. Dry Land’s first storm brings skitters to the player within 10 s (§4.1)', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page, '/?debug&seed=123&films=off');
  await page.evaluate((creation) => {
    const bridge = window.__reallm.save();
    bridge.create(0, creation, 123);
    bridge.current?.progress.missionsActive.push({ id: 'c1_m1', stage: 0, counters: {} });
  }, CREATION);
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4' }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
  // The first landing's ramp holds the ambient field (SPEC-035 §4.7); waves ignore it.
  expect(Number((await sceneInfo(page))['ramp'])).toBe(1);
  // Reach the pad, scan the dune sea: the storm stage.
  await press(page, 'surface-finish-stage');
  await press(page, 'surface-finish-stage');
  await expect.poll(async () => (await sceneInfo(page))['stormWave']).toBe('cinder4_first_storm');
  const before = Number((await sceneInfo(page))['enemies']);
  await expect
    .poll(
      async () => {
        const info = await sceneInfo(page);
        const near = Math.hypot(Number(info['nearDx'] ?? 999), Number(info['nearDz'] ?? 999));
        return Number(info['enemies']) >= before + 3 && near <= 30;
      },
      { timeout: 10_000, intervals: [250] },
    )
    .toBe(true);
});

// --------------------------------------------- 2, 3: one Depart, the tutorial trip

test('2, 3. a first trip departs on one Depart, and the tutorial trip strays without burning and says why (§4.2, §4.3)', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off', flightMouseSteer: false })));
  await start(page, '/?debug&films=off&quality=medium');
  await pilot(page);
  await go(page, 'station', {});
  await go(page, 'starmap', undefined);
  await page.locator('[data-testid="starmap-depart"]').click();
  // No sheet: on a route never flown it would only have said "fly this run once".
  await expect(page.locator('[data-testid="confirm-sheet"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight', { timeout: 20_000 });
  await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
  await page.evaluate(() => {
    const flight = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
    flight.warp(3.1);
    flight.clearSky();
    flight.park(150, 0);
  });
  await frames(page, 3);
  // 150 m off the line, the tank does not burn extra, and ARIA says why.
  await expect(page.getByTestId('hud-fuel')).not.toHaveClass(/is-burning/);
  await expect(page.locator('[data-testid="aria-hint"]')).toContainText(CORRIDOR_TIP, { timeout: 45_000 });
  const info = await sceneInfo(page);
  expect(info['phase']).toBe('cruise');
  expect(info['recallCause']).toBe('-');
  expect(Number(info['fuel'])).toBeGreaterThan(0.35);
});

// ------------------------------------------------------------- 4: creation

for (const size of [
  { width: 1440, height: 900 },
  { width: 844, height: 390 },
] as const) {
  test(`4. creation's Confirm is on screen without a scroll at ${size.width} × ${size.height} (§4.4)`, async ({ page }) => {
    await page.setViewportSize(size);
    await start(page, '/?scene=creation');
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('creation');
    const confirm = page.locator('[data-testid="creation-confirm"]');
    await expect(confirm).toBeVisible();
    const at = await confirm.boundingBox();
    if (at === null) throw new Error('no Confirm box');
    expect(at.y).toBeGreaterThanOrEqual(0);
    expect(at.y + at.height).toBeLessThanOrEqual(size.height);
    // The frame's head names the screen; the form no longer does.
    await expect(page.locator('.creation-title')).toHaveCount(0);
    if (size.width >= 1200) {
      // Two columns: the looks beside the build.
      const looks = await box(page, '.creation-looks');
      const build = await box(page, '.creation-build');
      expect(build.x).toBeGreaterThan(looks.x + looks.width - 1);
    }
  });
}

// ------------------------------------------------------- 5: the phone station

test.describe('5. the phone station (§4.5)', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('hides the build label, and an opening line leaves the first mission row clear', async ({ page }) => {
    await start(page, '/?debug&films=off');
    await pilot(page, 60);
    await go(page, 'station', {});
    await expect(page.getByTestId('version-label')).toBeHidden();
    // A line at the station, as the first visit's opening lines play.
    await page.evaluate(() => window.__reallm.playDialogue('c1_m1_accept'));
    const line = page.locator('.dialogue:not(.is-hidden)');
    await expect(line).toBeVisible({ timeout: 10_000 });
    const row = await box(page, '[data-testid="mission-c1_m1"]');
    expect(intersects(await box(page, '.dialogue:not(.is-hidden)'), row), 'the line covers the first mission').toBe(false);
  });
});

// ------------------------------------------------------------ 6: the flight HUD

test('6. the flight HUD shows no Lv and no XP bar (§4.6)', async ({ page }) => {
  await start(page, '/?scene=flight&planet=cinder4');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  await expect(page.locator('[data-testid="hud"] .hud-level')).toBeHidden();
  await expect(page.locator('[data-testid="hud"] .bar-row:has(.bar-xp)')).toBeHidden();
  await expect(page.locator('[data-testid="hud-hull"]')).toBeVisible();
});

test.describe('6. on touch in flight (§4.6)', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test('MSL is 64 px in the thumb’s corner, with + over − beside it', async ({ page }) => {
    await start(page, '/?scene=flight&planet=cinder4');
    await page.touchscreen.tap(240, 300);
    const msl = await box(page, '[data-testid="touch-missile"]');
    const up = await box(page, '[data-testid="touch-throttleUp"]');
    const down = await box(page, '[data-testid="touch-throttleDown"]');
    expect(Math.round(msl.width)).toBeGreaterThanOrEqual(64);
    // The corner: right of the throttle pair, and as low as the lower of the two.
    expect(msl.x).toBeGreaterThanOrEqual(up.x + up.width - 1);
    expect(Math.abs(msl.y + msl.height - (down.y + down.height))).toBeLessThanOrEqual(1);
    // + over −, one column.
    expect(up.y + up.height).toBeLessThanOrEqual(down.y + 1);
    expect(Math.abs(up.x - down.x)).toBeLessThanOrEqual(1);
  });
});
