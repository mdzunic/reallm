// SPEC-001 §9: dev builds put a "Skip to planet" button on the flight HUD. It
// fast-forwards the trip through the real rail model — so the arrival, the
// visit count and the landing's save write are the ones a flown trip makes —
// and lands at once. Production builds do not carry it (`import.meta.env.DEV`);
// this suite runs against the dev server, like every other.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

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

test('the dev skip button flies the trip out and lands with the visit counted', async ({ page }) => {
  await start(page);
  await page.evaluate((creation) => {
    const data = window.__reallm.save().create(0, creation);
    data.resources['oil'] = 200;
  }, CREATION);
  expect(await go(page, 'station', {})).toBe(true);
  expect(await go(page, 'starmap', undefined)).toBe(true);
  await page.locator('[data-testid="starmap-depart"]').click();
  await page.locator('[data-testid="confirm-yes"]').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');

  await page.locator('[data-testid="dev-skip-flight"]').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', { timeout: 10_000 });
  await expect(page.locator('[data-testid="dev-skip-flight"]')).toHaveCount(0);
  const progress = await page.evaluate(() => window.__reallm.save().current?.progress);
  expect(progress?.visits['cinder4']).toBe(1);
  expect(progress?.currentPlanet).toBe('cinder4');
  expect(progress?.location).toBe('surface');
});
