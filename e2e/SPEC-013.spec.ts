// SPEC-013 §7: the flight scene in a real browser. The unit suite proves the
// rail model; what only a browser shows is the wiring — station → star map →
// depart lands in the flight scene with the HUD instruments up, a crash
// recalls to the station with the banner and the fuel charged exactly once,
// the landing cutscene skips into the surface with the visit counted, and the
// touch layout carries the flight controls (SPEC-005 owns their behaviour).
//
// Time does not pass for real here: `window.__reallmFlight` (dev builds only,
// mounted by the scene next to `window.__reallm`) warps the simulation and
// lands deterministic hits, so a 90 s trip costs milliseconds.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

interface FlightHook {
  phase(): string;
  state(): { progress: number; shield: number; hull: number; throttle: number; storm: boolean; hostiles: number; holding: boolean };
  hit(amount: number): void;
  warp(seconds: number): void;
  blockArrival(): void;
  clearSky(): void;
}

declare global {
  interface Window {
    __reallmFlight?: FlightHook;
  }
}

/** One transition, plus the frame that draws the scene we landed in. */
async function go(page: Page, id: string, params: unknown = {}): Promise<boolean> {
  return page.evaluate(
    async ({ id, params }) => {
      const ok = await window.__reallm.go(id, params);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return ok;
    },
    { id, params },
  );
}

/** A save rich enough that no station subsidy muddies the fuel arithmetic. */
async function createPilot(page: Page, oil = 200): Promise<void> {
  await page.evaluate(
    ({ creation, oil }) => {
      const data = window.__reallm.save().create(0, creation);
      data.resources['oil'] = oil;
    },
    { creation: CREATION, oil },
  );
}

test.describe('station → star map → Cinder-4 (desktop)', () => {
  test.use({ reducedMotion: 'reduce' });

  test('departing lands in the flight scene with the instruments up (AC-46, AC-36 … AC-38)', async ({ page }) => {
    await start(page);
    await createPilot(page);
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);

    const oilBefore = await page.evaluate(() => window.__reallm.save().current?.resources['oil']);
    await page.locator('[data-testid="starmap-depart"]').click();
    await page.locator('[data-testid="confirm-yes"]').click();
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');

    // Fuel paid once, at the map (SPEC-010); the flight never touches it.
    const oilAfter = await page.evaluate(() => window.__reallm.save().current?.resources['oil']);
    expect(oilAfter).toBe((oilBefore as number) - 40);

    // §4.10: shield/hull bars, throttle, trip progress, reticle — all DOM.
    const hud = page.locator('[data-testid="hud"]');
    await expect(hud.locator('.bar-shield')).toBeVisible();
    await expect(hud.locator('.bar-hull')).toBeVisible();
    await expect(page.locator('[data-testid="hud-throttle"]')).toHaveText('THR 1.0×');
    await expect(page.locator('[data-testid="hud-progress"]')).toBeVisible();
    await expect(page.locator('[data-testid="reticle"]')).toBeVisible();
    // Cinder-4 storms never and starts with an empty sky: both stay hidden.
    await expect(page.locator('[data-testid="storm-warning"]')).toBeHidden();
    await expect(page.locator('[data-testid="holding-banner"]')).toBeHidden();
  });
});

test.describe('recall on death', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a crash recalls to the station with the banner, fuel deducted exactly once (AC-48, AC-19 … AC-24)', async ({ page }) => {
    await start(page);
    await createPilot(page);
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);
    await page.locator('[data-testid="starmap-depart"]').click();
    await page.locator('[data-testid="confirm-yes"]').click();
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
    const oilInFlight = await page.evaluate(() => window.__reallm.save().current?.resources['oil']);

    // Deliberately crash: more damage than any hull carries.
    await page.evaluate(() => window.__reallmFlight?.hit(10_000));
    expect(await page.evaluate(() => window.__reallmFlight?.phase())).toBe('recalled');
    await expect(page.locator('[data-testid="flight-explosion"]')).toHaveClass(/is-visible/);

    // The 1.5 s explosion, then the station with the recall banner (E5).
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station', { timeout: 10_000 });
    await expect(page.locator('[data-testid="recall-banner"]')).toHaveText('Emergency recall');

    // Fuel charged once at departure and never again; 160 needs no subsidy.
    const oilAtStation = await page.evaluate(() => window.__reallm.save().current?.resources['oil']);
    expect(oilAtStation).toBe(oilInFlight);
    // No landing happened: the visit was never counted.
    const visits = await page.evaluate(() => window.__reallm.save().current?.progress.visits['cinder4']);
    expect(visits ?? 0).toBe(0);
  });
});

test.describe('arrival and landing', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the cutscene is skippable and lands on the surface with the visit counted (AC-33 … AC-35, AC-102)', async ({ page }) => {
    await start(page);
    await createPilot(page);
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);
    await page.locator('[data-testid="starmap-depart"]').click();
    await page.locator('[data-testid="confirm-yes"]').click();
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');

    // Warp through launch and the whole 90 s cruise; Cinder-4 has no arrival
    // wave, so the trip ends in `arrived` and the cutscene begins.
    await page.evaluate(() => window.__reallmFlight?.warp(95));
    expect(await page.evaluate(() => window.__reallmFlight?.phase())).toBe('arrived');
    await expect(page.locator('[data-testid="skip-landing"]')).toBeVisible();

    // 13-f: skipped instantly; the transition fade still runs (SPEC-003).
    await page.keyboard.press('Space');
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', { timeout: 10_000 });

    const progress = await page.evaluate(() => window.__reallm.save().current?.progress);
    expect(progress?.visits['cinder4']).toBe(1);
    expect(progress?.currentPlanet).toBe('cinder4');
    expect(progress?.location).toBe('surface');
  });
});

test.describe('flight on a phone', () => {
  test.use({ viewport: { width: 740, height: 360 }, hasTouch: true, reducedMotion: 'reduce' });

  test('the touch layout carries steer zone, fire hold, throttle and pause (AC-43 … AC-45, AC-47, AC-100)', async ({ page }) => {
    await start(page);
    await createPilot(page);
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);
    await page.locator('[data-testid="starmap-depart"]').tap();
    await page.locator('[data-testid="confirm-yes"]').tap();
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');

    // A touch on the play surface flips the scheme and mounts the layer.
    await page.touchscreen.tap(200, 200);
    const controls = page.locator('[data-testid="touch-controls"]');
    await expect(controls).toBeVisible();
    await expect(controls).toHaveAttribute('data-mode', 'flight');
    for (const control of ['touch-throttleUp', 'touch-throttleDown', 'touch-pause']) {
      await expect(page.locator(`[data-testid="${control}"]`)).toBeVisible();
    }
    // Flight aims itself: the touch reticle is up, the surface stick is not.
    await expect(page.locator('[data-testid="touch-reticle"]')).toBeVisible();

    // The throttle buttons drive the model: one tap up reads 1.2× on the HUD.
    await page.locator('[data-testid="touch-throttleUp"]').tap();
    await expect(page.locator('[data-testid="hud-throttle"]')).toHaveText('THR 1.2×');
  });
});

test.describe('holding pattern HUD', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a live wave enemy raises the holding banner and the hostile count; clearing it lands (AC-25, AC-40, AC-42)', async ({ page }) => {
    await start(page);
    await createPilot(page);
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);
    await page.locator('[data-testid="starmap-depart"]').click();
    await page.locator('[data-testid="confirm-yes"]').click();
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
    await expect(page.locator('[data-testid="holding-banner"]')).toBeHidden();

    // A wave enemy that never leaves (the hook's blocker): the arrival check
    // fails at trip end and the model holds — the HUD says both things.
    await page.evaluate(() => {
      window.__reallmFlight?.blockArrival();
      window.__reallmFlight?.warp(95);
    });
    expect(await page.evaluate(() => window.__reallmFlight?.phase())).toBe('holding');
    await expect(page.locator('[data-testid="holding-banner"]')).toBeVisible();
    await expect(page.locator('[data-testid="hud-hostiles"]')).toHaveText('Hostiles: 1');

    // The sky clears → the next updates land (E12's happy half).
    await page.evaluate(() => {
      window.__reallmFlight?.clearSky();
      window.__reallmFlight?.warp(1);
    });
    expect(await page.evaluate(() => window.__reallmFlight?.phase())).toBe('arrived');
    await expect(page.locator('[data-testid="skip-landing"]')).toBeVisible();
  });
});
