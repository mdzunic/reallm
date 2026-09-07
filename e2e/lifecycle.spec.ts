// Page lifecycle in a real browser (SPEC-002 §4.4, §6.2). A phone that locks
// mid-game is the case that matters: the loop must stop, and coming back must
// not fire a minute of catch-up updates at the player (E6).
import { expect, test, type Page } from '@playwright/test';
import { frames, start } from './start';

/** A synthetic visibilitychange; a real one needs a second tab. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { value, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('hiding pauses the loop and logs app:paused (AC-38, AC-39)', async ({ page }) => {
  await start(page, '/?debug');
  await frames(page, 5);

  await setHidden(page, true);
  await expect(page.locator('[data-testid="debug-events"]')).toContainText('app:paused');
  await expect(page.locator('[data-testid="debug-state"]')).toHaveText('state hidden');

  // The frame counter stops: no updates, no renders behind a hidden tab.
  const first = await page.evaluate(() => window.__reallm.stats().frame);
  await page.waitForTimeout(250);
  const second = await page.evaluate(() => window.__reallm.stats().frame);
  expect(second).toBe(first);
});

test('becoming visible resumes without a catch-up burst (AC-40, AC-41, E6)', async ({ page }) => {
  await start(page, '/?debug');
  await frames(page, 5);
  const before = await page.evaluate(() => window.__reallm.stats());

  await setHidden(page, true);
  await page.waitForTimeout(1200); // stands in for a locked phone
  await setHidden(page, false);

  await expect(page.locator('[data-testid="debug-events"]')).toContainText('app:resumed');
  await expect(page.locator('[data-testid="debug-state"]')).toHaveText('state running');

  // Sample the first frames after the resume: none of them may run a burst.
  const samples = await page.evaluate(async () => {
    const seen: number[] = [];
    for (let i = 0; i < 12; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      seen.push(window.__reallm.stats().updates);
    }
    return seen;
  });
  expect(Math.max(...samples)).toBeLessThanOrEqual(5);
  expect(samples[0]).toBeLessThanOrEqual(1);

  const after = await page.evaluate(() => window.__reallm.stats());
  expect(after.frame).toBeGreaterThan(before.frame);
  // The hidden interval was discarded, not simulated and not counted as dropped.
  expect(after.droppedTime).toBeCloseTo(before.droppedTime, 5);
});

test('a pausable scene stays in its pause menu until the player asks (AC-40, SPEC-003 D-38)', async ({ page }) => {
  await start(page, '/?scene=flight&planet=cinder4');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  const menu = page.locator('[data-testid="pause-menu"]');

  await setHidden(page, true);
  await expect(menu).toBeVisible();
  await setHidden(page, false);
  await expect(menu).toBeVisible(); // the loop is back; the game is not

  await page.locator('[data-testid="pause-resume"]').click();
  await expect(menu).toBeHidden();
});

test('blur and pagehide run their hooks (AC-42, AC-43)', async ({ page }) => {
  await start(page, '/?debug');
  const events = page.locator('[data-testid="debug-events"]');

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(events).toContainText('app:blur');

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect(events).toContainText('app:pagehide');
});
