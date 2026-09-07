// Page lifecycle in a real browser (SPEC-002 §4.4, §6.2). A phone that locks
// mid-game is the case that matters: the loop must stop, and coming back must
// not fire a minute of catch-up updates at the player (E6).
import { expect, test } from '@playwright/test';
import { frames, setHidden, start } from './start';

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
  const paused = await page.evaluate(() => window.__reallm.stats());

  // The resume and the frames that follow it happen in one page task, so these
  // really are the first frames after the resume — a round trip in between
  // would let the browser run several before the first sample.
  const FRAMES = 12;
  const samples = await page.evaluate(async (count) => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const seen: number[] = [];
    for (let i = 0; i < count; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      seen.push(window.__reallm.stats().updates);
    }
    return seen;
  }, FRAMES);

  await expect(page.locator('[data-testid="debug-events"]')).toContainText('app:resumed');
  await expect(page.locator('[data-testid="debug-state"]')).toHaveText('state running');

  // The step cap holds, and the hidden 1.2 s was never replayed: twelve frames
  // of ordinary 60 Hz work is a dozen or so updates, while replaying 1.2 s
  // would be about seventy.
  const total = samples.reduce((sum, updates) => sum + updates, 0);
  expect(Math.max(...samples)).toBeLessThanOrEqual(5);
  expect(total).toBeLessThan(2 * FRAMES);

  const after = await page.evaluate(() => window.__reallm.stats());
  expect(after.frame).toBeGreaterThan(paused.frame);
  expect(after.frame).toBeGreaterThan(before.frame);
  // Decisive: a catch-up would have clamped the delta to 250 ms, run five steps
  // and left the remaining ~950 ms in droppedTime.
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
