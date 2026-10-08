// QA codification for the MAIN-07a410f repair: c9bd891 only touched
// tests/views/dressing.test.ts (the SPEC-067 keepout check was rewritten to
// collect breaches into a list and assert once, so it stays inside the vitest
// timeout under parallel load), so no product code changed. This file pins
// the two product-level acceptance criteria that gate the fix: the app still
// boots to its main screen, and the primary flow — new game through character
// creation, the station, the star map, a flight and landing on a planet's
// surface — still runs end to end with live, responsive gameplay.
import { expect, test } from '@playwright/test';
import { COLD_START, gameUrl, passGate, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

test('the shell boots to the main menu with no console errors (AC-1)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(gameUrl('/'));
  await expect(page).toHaveTitle('ReaLLM');
  await passGate(page);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
  await expect(page.locator('[data-testid="menu-new"]')).toBeVisible();

  expect(errors).toEqual([]);
});

test('new game through creation, the station, a flight and landing on the surface, with live movement (AC-2)', async ({
  page,
}) => {
  await start(page);

  // Menu → New Game → slot 1 (no prologue film in the suite's URL).
  await page.locator('[data-testid="menu-new"]').click();
  await page.locator('[data-testid="new-slot-0"]').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('creation');

  // Character creation: pick a class and confirm.
  await page.getByTestId('class-marine').click();
  const confirm = page.getByTestId('creation-confirm');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station', COLD_START);

  // The station opens with an ARIA transmission; clear it the way a player
  // taps through dialogue, then head to the star map.
  const dialogue = page.locator('[data-testid="dialogue"]');
  for (let i = 0; i < 10 && (await dialogue.isVisible().catch(() => false)); i++) {
    await dialogue.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(150);
  }
  await page.getByTestId('station-tab-starmap').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('starmap', COLD_START);

  // Cinder-4 is pre-selected with enough fuel for a new save; depart.
  await page.getByTestId('starmap-depart').click();
  await page.getByTestId('confirm-yes').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight', COLD_START);

  // Fly the trip out via the dev skip (SPEC-001 §9) and land.
  await page.getByTestId('dev-skip-flight').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', { timeout: 20_000 });

  // The surface simulation is live: holding a movement key actually moves
  // the player, not just a scene swap with a frozen world.
  const before = await page.evaluate(() => window.__reallm.stats().sceneInfo);
  await page.keyboard.down('d');
  await page.waitForTimeout(600);
  await page.keyboard.up('d');
  const after = await page.evaluate(() => window.__reallm.stats().sceneInfo);

  const moved = Math.hypot(Number(after?.['px']) - Number(before?.['px']), Number(after?.['pz']) - Number(before?.['pz']));
  expect(moved).toBeGreaterThan(1);
});
