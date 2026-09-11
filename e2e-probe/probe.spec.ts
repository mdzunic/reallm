import { expect, test } from '@playwright/test';
import { start } from '/work/e2e/start';

test('probe', async ({ page }) => {
  await start(page);
  const label = page.locator('[data-testid="version-label"]');
  for (let tap = 0; tap < 5; tap++) await label.click();
  await expect(page.locator('.overlay-debug')).toBeVisible();
  const info = await page.evaluate(() => {
    const l = document.querySelector('[data-testid="version-label"]') as HTMLElement;
    const o = document.querySelector('.overlay-debug') as HTMLElement;
    const ev = document.querySelector('[data-testid="debug-events"]') as HTMLElement;
    const r = (e: HTMLElement | null) => e ? { ...e.getBoundingClientRect().toJSON() } : null;
    return { label: r(l), overlay: r(o), events: r(ev), eventText: ev?.textContent?.split('\n').length, preset: (window as any).__reallm.stats().preset };
  });
  console.log(JSON.stringify(info, null, 2));
});
