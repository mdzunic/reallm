// Tear-down (SPEC-002 §4.2 teardown rules, §6.2). `Game.stop()` is what
// `import.meta.hot.dispose` calls, so a hot update never leaves two loops
// rendering over each other (02-d, AC-61); if it left anything running, this is
// where it would show.
import { expect, test } from '@playwright/test';
import { frames, start } from './start';

test('stop() freezes the frame counter and is idempotent (AC-58, AC-59, AC-60)', async ({ page }) => {
  await start(page, '/?debug');
  await frames(page, 5);
  const running = await page.evaluate(() => window.__reallm.stats().frame);
  expect(running).toBeGreaterThan(0);

  await page.evaluate(() => window.__reallm.stop());
  const stopped = await page.evaluate(() => window.__reallm.stats().frame);
  await page.waitForTimeout(300);
  const later = await page.evaluate(() => window.__reallm.stats().frame);
  expect(later).toBe(stopped);

  // A second call throws nothing and changes nothing.
  await expect(page.evaluate(() => {
    window.__reallm.stop();
    return window.__reallm.stats().frame;
  })).resolves.toBe(stopped);
  expect(await page.evaluate(() => window.__reallm.stats().state)).toBe('stopped');
});

test('stop() releases the listeners it registered (AC-58)', async ({ page }) => {
  await start(page, '/?debug');
  await page.evaluate(() => window.__reallm.stop());

  // The overlay is gone with the rest of the tear-down, and the toggles that
  // drove it no longer answer.
  await expect(page.locator('.overlay-debug')).toHaveCount(0);
  await page.keyboard.press('Backquote');
  await expect(page.locator('.overlay-debug')).toHaveCount(0);

  // The scene goes with it. `stop()` is the hot-update path, so a scene left
  // mounted here would have its DOM layer sitting under the reloaded module's.
  await expect(page.locator('[data-testid="scene-label"]')).toHaveCount(0);
  await expect(page.locator('.scene-layer')).toHaveCount(0);

  // Hiding the page no longer reaches a loop that is not there.
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
  });
  expect(errors).toEqual([]);
});
