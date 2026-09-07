// WebGL context loss (SPEC-002 §4.4, §4.7, E7). iOS Safari drops a context
// under memory pressure and a desktop GPU reset does the same; the simulators in
// the stats overlay are the only way to exercise the recovery by hand, so the
// suite drives exactly those.
import { expect, test } from '@playwright/test';
import { frames, start } from './start';

const panel = '[data-testid="context-lost"]';
const reload = '[data-testid="context-lost-reload"]';

test('the simulator shows the panel, and the scene keeps running after the restore (AC-45, AC-46, AC-48)', async ({
  page,
}) => {
  await start(page, '/?debug');
  await frames(page, 3);
  const before = await page.evaluate(() => window.__reallm.stats());

  await page.locator('[data-testid="debug-lose-context"]').click();
  await expect(page.locator(panel)).toBeVisible();
  await expect(page.locator(panel)).toContainText('Graphics context lost. Recovering…');
  await expect(page.locator('[data-testid="debug-state"]')).toHaveText('state context-lost');
  // Paused: nothing simulates against a context that is gone, so the frame
  // counter stops while the panel is up.
  const lost = await page.evaluate(() => window.__reallm.stats().frame);
  await frames(page, 2);
  expect(await page.evaluate(() => window.__reallm.stats().frame)).toBe(lost);

  // The simulator restores after 1000 ms.
  await expect(page.locator(panel)).toBeHidden({ timeout: 5000 });
  await expect(page.locator('[data-testid="debug-state"]')).toHaveText('state running');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');

  await frames(page, 5);
  const after = await page.evaluate(() => window.__reallm.stats());
  expect(after.frame).toBeGreaterThan(before.frame);
  // The Reload offer never appeared: the context came back inside the 5 s.
  await expect(page.locator(reload)).toHaveCount(0);
});

test('a context that never returns offers Reload after 5 s (AC-47, AC-49)', async ({ page }) => {
  test.setTimeout(30_000);
  await start(page, '/?debug');

  await page.locator('[data-testid="debug-lose-context-fatal"]').click();
  await expect(page.locator(panel)).toBeVisible();
  await expect(page.locator(reload)).toHaveCount(0); // not straight away

  await expect(page.locator(reload)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(reload)).toHaveText('Reload');

  // It really reloads: the page comes back at the gate.
  await page.locator(reload).click();
  await expect(page.locator('[data-testid="boot-start"]')).toBeVisible();
});

test('the dev bridge drives the same path (AC-46)', async ({ page }) => {
  await start(page, '/?debug');
  await page.evaluate(() => window.__reallm.loseContext(600));
  await expect(page.locator(panel)).toBeVisible();
  await expect(page.locator(panel)).toBeHidden({ timeout: 5000 });
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
});
