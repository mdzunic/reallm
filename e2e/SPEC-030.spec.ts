// SPEC-030's browser acceptance run (§6.2): shelters placed, the sheltered
// and hidden chip, a forced storm doing nothing inside a shelter, the edge
// walk against the wall, and the budget sweep (which lives in
// e2e/surface-env.spec.ts per D-17). The rules themselves are pinned in node;
// this is the composed wiring on `?scene=surface&planet=cinder4&debug`.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const URL = '/?debug&scene=surface&planet=cinder4&seed=123';

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

async function settle(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
}

/** The player's current HP, off the HUD bar's `value/max` text. */
async function hp(page: Page): Promise<number> {
  const text = (await page.locator('[data-testid="hud-hp"]').textContent()) ?? '';
  return Number(/(\d+)\s*\//.exec(text)?.[1] ?? -1);
}

test('shelters are placed: the debug count reads ≥ 2 (§6.2 case 1)', async ({ page }) => {
  await start(page, URL);
  await settle(page);
  expect(Number((await info(page))['shelters'])).toBeGreaterThanOrEqual(2);
});

test('goto-shelter shows the chip; holding fire turns it HIDDEN (§6.2 case 2)', async ({ page }) => {
  await start(page, URL);
  await settle(page);

  // Before entering: the chip is in the DOM and hidden (D-11).
  await expect(page.getByTestId('sheltered')).toBeAttached();
  await expect(page.getByTestId('sheltered')).toBeHidden();

  await page.getByTestId('surface-goto-shelter').click();
  await expect(page.getByTestId('sheltered')).toBeVisible();
  await expect.poll(async () => (await info(page))['sheltered']).toBe(1);
  // 2 s without firing: the trail is cold and the chip reads HIDDEN.
  await expect.poll(async () => (await info(page))['hidden'], { timeout: 10_000 }).toBe(1);
  await expect(page.getByTestId('sheltered')).toContainText('HIDDEN');
});

test('a forced storm does nothing inside a shelter and bites outside (§6.2 case 3)', async ({ page }) => {
  await start(page, URL);
  await settle(page);

  await page.getByTestId('surface-goto-shelter').click();
  // D-18: clear the neighbourhood so the HP reading is about the weather.
  await page.getByTestId('surface-smite').click();
  await page.getByTestId('surface-storm').click();
  // Cinder-4's highest-dps cycle storm is the heatwave (D-15).
  await expect(page.locator('.hud-weather')).toContainText('Heatwave');

  const before = await hp(page);
  expect(before).toBeGreaterThan(0);
  await page.waitForTimeout(3000);
  expect(await hp(page)).toBe(before);

  // Outside, the same storm drains HP within 4 s.
  await page.getByTestId('surface-goto-pad').click();
  await expect
    .poll(async () => await hp(page), { timeout: 8_000 })
    .toBeLessThan(before);
});

test('the edge stops the player and the wall is on screen (§6.2 case 4)', async ({ page }) => {
  await start(page, URL);
  await settle(page);

  await page.getByTestId('surface-goto-edge').click();
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(1000);
  await page.keyboard.up('KeyD');
  // halfSize 180: the clamp line is ±(180 − 2).
  expect(Number((await info(page))['px'])).toBeLessThanOrEqual(178.01);
  expect(Number((await info(page))['wallVisible'])).toBeGreaterThanOrEqual(1);
});
