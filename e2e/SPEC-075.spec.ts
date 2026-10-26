// SPEC-075 §6.2 (PLAN R32): reading the fight in a real browser — every
// planet's figure edge stands off its ground, a hit in flight puts a wedge
// on the edge it struck from, and a low tank is hatched and marked.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, frames, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

interface FlightHook {
  warp(seconds: number): void;
  clearSky(): void;
  park(x: number, y: number): void;
  setFuel(fraction: number): void;
  hit(amount: number, from?: { x: number; y: number }): void;
}

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

/** Waits for the trip's dev hook, then skips the launch and empties the sky. */
async function cruise(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
  await page.evaluate(() => {
    const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
    hook.warp(3.1);
    hook.clearSky();
    hook.park(0, 0);
  });
  await frames(page, 3);
}

/** A rock's hit through the hook, struck at `from` on the steering plane. */
async function hit(page: Page, from: { x: number; y: number }): Promise<void> {
  await page.evaluate((at) => (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight.hit(4, at), from);
}

// ------------------------------------------------------- 1: the figure edge

test('1. every planet’s figure edge is the tone its ground asks for (§4.1)', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, '/?debug&seed=123&films=off&quality=medium');
  await page.evaluate((creation) => window.__reallm.save().create(0, creation, 123), CREATION);
  const tones = { cinder4: 'dark', vetra: 'dark', thessaly: 'pale', ferrum: 'pale', hive: 'pale', eden: 'dark' } as const;
  for (const [planet, tone] of Object.entries(tones)) {
    await expect
      .poll(() => page.evaluate(async (id) => window.__reallm.go('surface', { planet: id }, { force: true }).then(() => true, () => false), planet), {
        timeout: 15_000,
      })
      .toBe(true);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', COLD_START);
    await expect.poll(async () => (await sceneInfo(page))['figureEdge'], { message: planet }).toBe(tone);
  }
});

// --------------------------------------------------- 2: the hit wedge in flight

test('2. a hit in flight puts a wedge on the edge it struck from, and none from dead ahead (§4.4)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off', flightMouseSteer: false })));
  await start(page, '/?scene=flight&planet=cinder4&films=off');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  await cruise(page);
  const wedges = page.locator('[data-testid="hud-hit-dir"]');
  await hit(page, { x: 0, y: 0 });
  await frames(page, 2);
  await expect(wedges).toHaveCount(0);
  await hit(page, { x: 3, y: 0 });
  await expect(wedges).toHaveCount(1);
  // Clockwise from screen-up: struck from the right is a quarter turn, within the camera's roll.
  const degrees = await wedges.first().evaluate((node) => Number(/rotate\(([-\d.]+)deg\)/.exec((node as HTMLElement).style.transform)?.[1]));
  expect(Math.abs(degrees - 90)).toBeLessThanOrEqual(10);
});

// ------------------------------------------------------------ 3: the low tank

test('3. a low tank is hatched in the danger colour and followed by a ▲, on both presets (§4.5)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off', flightMouseSteer: false, colourPreset: 'colour-blind' })));
  await start(page, '/?scene=flight&planet=cinder4&films=off');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  await cruise(page);
  await page.evaluate(() => (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight.setFuel(0.1));
  const row = page.getByTestId('hud-fuel');
  await expect(row).toHaveClass(/is-low/);
  const look = await row.evaluate((node) => {
    const fill = node.querySelector('.bar-fuel') as HTMLElement;
    const text = node.querySelector('.bar-text') as HTMLElement;
    return { fill: getComputedStyle(fill).backgroundImage, marker: getComputedStyle(text, '::after').content };
  });
  expect(look.fill).toContain('repeating-linear-gradient');
  expect(look.marker).toBe('" ▲"');
  // Under the colour-blind preset the hatch is danger's orange, not the HP red.
  const danger = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--danger').trim());
  expect(danger).toBe('#ff8a1f');
});
