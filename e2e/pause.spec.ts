// Pause in the real app (SPEC-003 §4.5). The `?scene=` dev flag jumps straight
// into a pausable scene, which is the one thing `{ force: true }` exists for
// (D-11); the pause menu it opens is the scene's own UI layer (D-1).
//
// SPEC-002 §4.5 applies `?scene=` after its start gate, so every navigation
// here goes through the shared helper (D-K, AC-26). No assertion below changed.
import { expect, test } from '@playwright/test';
import { start } from './start';

test('Escape opens the pause menu, and only an explicit action closes it (AC-79, AC-82)', async ({ page }) => {
  await start(page, '/?scene=surface&planet=cinder4');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');

  const menu = page.locator('[data-testid="pause-menu"]');
  await expect(menu).toBeHidden();

  await page.keyboard.press('Escape');
  await expect(menu).toBeVisible();

  await page.locator('[data-testid="pause-resume"]').click();
  await expect(menu).toBeHidden();

  // Escape toggles the same way from the keyboard.
  await page.keyboard.press('Escape');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('hiding the tab pauses, and coming back does not resume (AC-78, AC-81, E6)', async ({ page }) => {
  await start(page, '/?scene=flight&planet=cinder4');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  const menu = page.locator('[data-testid="pause-menu"]');

  const setHidden = (hidden: boolean): Promise<void> =>
    page.evaluate((value) => {
      Object.defineProperty(document, 'hidden', { value, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);

  await setHidden(true);
  await expect(menu).toBeVisible();

  await setHidden(false);
  // Still paused: the player has to ask for the game back (D-38).
  await expect(menu).toBeVisible();

  await page.locator('[data-testid="pause-resume"]').click();
  await expect(menu).toBeHidden();
});

test('a non-pausable scene has no pause menu at all (AC-80)', async ({ page }) => {
  await start(page, '/?scene=station');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="pause-menu"]')).toHaveCount(0);
});
