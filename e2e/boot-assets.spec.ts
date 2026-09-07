// Boot-time asset loading in a real browser (SPEC-003 §4.3, D-30, D-31): the
// progress the boot overlay shows, and what happens when a fetch fails.
//
// SPEC-002 §4.5 added the start gate after the load, so reaching a scene now
// goes through the shared helper (D-K). No assertion below changed.
import { expect, test } from '@playwright/test';
import { passGate } from './start';

test('the boot overlay reports asset progress (AC-45)', async ({ page }) => {
  // Slow the assets down so the counter is observable rather than a flash.
  await page.route('**/assets/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });

  await page.goto('/');
  await expect(page.locator('[data-testid="boot-progress"]')).toHaveText(/Loading \d+\/\d+/);
  await passGate(page);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
});

test('a failed asset offers Retry, which fetches only what is missing (AC-46, AC-47, AC-48)', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes('/assets/')) fetched.push(path);
  });

  let offline = true;
  await page.route('**/assets/textures/noise.png', async (route) => {
    if (offline) await route.abort();
    else await route.continue();
  });

  await page.goto('/');
  // Visible, not merely present: the panel's copy is in the markup from the
  // start, so waiting on the text alone would race the load itself.
  await expect(page.locator('[data-testid="boot-error"]')).toBeVisible();
  await expect(page.locator('[data-testid="boot-error"]')).toContainText('Could not load assets — check connection');
  // The items before the failing one did get through.
  expect(fetched.some((path) => path.endsWith('crate.glb'))).toBe(true);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveCount(0);

  offline = false;
  fetched.length = 0;
  await page.locator('[data-testid="boot-retry"]').click();

  await passGate(page);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
  expect(fetched.some((path) => path.endsWith('noise.png'))).toBe(true);
  expect(fetched.filter((path) => !path.endsWith('noise.png'))).toEqual([]);
});
