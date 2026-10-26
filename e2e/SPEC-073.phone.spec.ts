// SPEC-073 §7 — the Refit on a phone: at every `PHONE_VIEWPORTS` size the
// station rail is a row of icon-over-label tabs, each at least 56 px tall with
// its whole label (E140), and the star map draws every planet round (E141).
import { expect, test, type Page } from '@playwright/test';
import { PHONE_VIEWPORTS } from './phone';
import { awaitGate, COLD_START, frames, gameUrl } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 0 },
  difficulty: 'normal',
} as const;

async function go(page: Page, scene: string, params: unknown = {}): Promise<void> {
  await page.evaluate(({ scene, params }) => window.__reallm.go(scene, params, { force: true }), { scene, params });
  await expect(page.getByTestId('scene-label')).toHaveText(scene, COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
  await frames(page, 4);
}

for (const viewport of PHONE_VIEWPORTS) {
  test.describe(`SPEC-073 at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true, isMobile: true });
    test.setTimeout(150_000);

    test('station tabs are 56 px icon-over-label keys with whole labels, and the planets are round', async ({ page }) => {
      // The gate passed with a tap, so the scheme is touch from the first frame.
      await page.goto(gameUrl('/?seed=123'));
      await awaitGate(page);
      await page.locator('[data-testid="boot-start"]').tap();
      await expect(page.locator('[data-testid="boot-overlay"]')).toBeHidden();
      // A go() issued mid-fade is refused (SPEC-003 D-2): let the menu settle.
      await expect(page.getByTestId('scene-label')).toHaveText('menu', COLD_START);
      await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
      await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
      await go(page, 'station');

      const tabs = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.screen-rail .screen-tab, .screen-rail .screen-action')]
          .filter((node) => node.getBoundingClientRect().width > 0)
          .map((node) => {
            const label = node.querySelector<HTMLElement>('.screen-tab-label') ?? node;
            const box = node.getBoundingClientRect();
            const icon = node.querySelector('.glyph[data-icon]')?.getBoundingClientRect() ?? null;
            const text = label.getBoundingClientRect();
            return {
              id: node.dataset['testid'] ?? '',
              height: box.height,
              clipped: label.scrollWidth > label.clientWidth + 1 || getComputedStyle(label).textOverflow === 'ellipsis',
              iconAbove: icon === null ? null : icon.bottom <= text.top + 1,
              inside: box.left >= -0.5 && box.right <= window.innerWidth + 0.5,
            };
          }),
      );
      expect(tabs.length).toBeGreaterThanOrEqual(8);
      for (const tab of tabs) {
        expect(tab.height, `${tab.id} height`).toBeGreaterThanOrEqual(56);
        expect(tab.clipped, `${tab.id} clipped`).toBe(false);
        expect(tab.inside, `${tab.id} on screen`).toBe(true);
        if (viewport.height <= 500) expect(tab.iconAbove, `${tab.id} icon over label`).toBe(true);
      }

      await go(page, 'starmap', undefined);
      const info = await page.evaluate(() => window.__reallm.stats().sceneInfo);
      expect(Number(info?.['roundness'])).toBeLessThanOrEqual(0.03);
    });
  });
}
