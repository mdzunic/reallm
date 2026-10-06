// SPEC-054 §6.3 — the flashlight on a phone: at every `PHONE_VIEWPORTS` size,
// below, LIGHT sits inside SPEC-037's action cell, fully visible and topmost at
// its centre, clear of every other HUD element and the stick; a tap toggles the
// light; and the light chip stays clear of the wallet and the toasts.
import { expect, test, type Page } from '@playwright/test';
import { PHONE_VIEWPORTS } from './phone';
import { awaitGate, COLD_START, frames, gameUrl } from './start';

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function box(page: Page, selector: string): Promise<Box | null> {
  return page.locator(selector).first().boundingBox();
}

async function light(page: Page): Promise<number> {
  return page.evaluate(() => Number(window.__reallm.stats().sceneInfo?.['light']));
}

for (const viewport of PHONE_VIEWPORTS) {
  test.describe(`SPEC-054 touch below at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true, isMobile: true });
    test.setTimeout(180_000);

    test('LIGHT sits in the arc, clear of the rest, and a tap toggles the light', async ({ page }) => {
      // The gate passed with a tap, so the scheme is touch from the first frame.
      await page.goto(gameUrl('/?scene=surface&planet=cinder4&debug'));
      await awaitGate(page);
      await page.locator('[data-testid="boot-start"]').tap();
      await expect(page.locator('[data-testid="boot-overlay"]')).toBeHidden();
      await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', COLD_START);
      await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
      expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('touch');
      await page.evaluate(() => (document.querySelector('[data-testid="surface-descend"]') as HTMLElement).click());
      await page.waitForFunction(() => window.__reallm.stats().sceneInfo?.['level'] === 'underground', undefined, COLD_START);
      await page.waitForFunction(() => window.__reallm.stats().sceneInfo?.['held'] === 0, undefined, COLD_START);
      await frames(page, 10);

      const button = page.locator('[data-testid="touch-light"]');
      await expect(button).toBeVisible();
      await expect(button).toHaveText('LIGHT');
      const own = (await button.boundingBox()) as Box;
      const cell = (await box(page, '[data-testid="arc-action"]')) as Box;
      expect(own.x).toBeGreaterThanOrEqual(cell.x - 1);
      expect(own.y).toBeGreaterThanOrEqual(cell.y - 1);
      expect(own.x + own.width).toBeLessThanOrEqual(cell.x + cell.width + 1);
      expect(own.y + own.height).toBeLessThanOrEqual(cell.y + cell.height + 1);
      expect(own.x).toBeGreaterThanOrEqual(0);
      expect(own.y + own.height).toBeLessThanOrEqual(viewport.height);
      const topmost = await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return hit?.closest('[data-testid="touch-light"]') !== null;
      }, { x: own.x + own.width / 2, y: own.y + own.height / 2 });
      expect(topmost).toBe(true);
      for (const other of ['arc-primary', 'arc-slots', 'touch-stick', 'hud-wallet', 'hud-light']) {
        const rect = await box(page, `[data-testid="${other}"]`);
        if (rect !== null) expect(overlaps(own, rect), other).toBe(false);
      }
      // USE is hidden while LIGHT shows.
      await expect(page.locator('[data-testid="touch-interact"]')).toBeHidden();

      const before = await light(page);
      await button.tap();
      await page.waitForFunction((was) => Number(window.__reallm.stats().sceneInfo?.['light']) !== was, before, COLD_START);

      // The chip clears the wallet and every toast.
      const chip = (await box(page, '[data-testid="hud-light"]')) as Box;
      const wallet = await box(page, '[data-testid="hud-wallet"]');
      if (wallet !== null) expect(overlaps(chip, wallet)).toBe(false);
      for (const toast of await page.locator('.toast-rack .toast').all()) {
        const rect = await toast.boundingBox();
        if (rect !== null) expect(overlaps(chip, rect)).toBe(false);
      }
    });
  });
}
