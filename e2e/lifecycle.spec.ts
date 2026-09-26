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
  // would let the browser run several before the first sample. Each frame's
  // timestamp comes back with it: that is the clock the loop itself reads, and
  // the first one is the last paused frame, where the loop's clock stood.
  const FRAMES = 12;
  const { samples, stamps, dropped } = await page.evaluate(async (count) => {
    const seen: number[] = [];
    const times = [Number(document.timeline.currentTime)];
    const droppedAtResume = window.__reallm.stats().droppedTime;
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < count; i++) {
      times.push(await new Promise<number>((resolve) => requestAnimationFrame(resolve)));
      seen.push(window.__reallm.stats().updates);
    }
    return { samples: seen, stamps: times, dropped: window.__reallm.stats().droppedTime - droppedAtResume };
  }, FRAMES);

  await expect(page.locator('[data-testid="debug-events"]')).toContainText('app:resumed');
  await expect(page.locator('[data-testid="debug-state"]')).toHaveText('state running');

  // What those frames pay for by the loop's own rules (SPEC-002 §4.1): each
  // delta clamped to 250 ms, then at most five 1/60 s steps, and whatever is
  // still owed thrown away (E23). At 60 fps that is a dozen or so updates and
  // nothing dropped; a busy machine's slower frames pay for more of both.
  const STEP = 1 / 60;
  let owed = 0;
  let droppable = 0;
  for (let i = 1; i < stamps.length; i++) {
    const dt = Math.min(((stamps[i] as number) - (stamps[i - 1] as number)) / 1000, 0.25);
    owed += dt;
    // Four steps, not five: the accumulator carries up to one step in.
    droppable += Math.max(0, dt - 4 * STEP);
  }
  expect(stamps[0]).toBeGreaterThan(0);

  // The step cap holds, and the hidden 1.2 s was never replayed: no more
  // updates than the frames since the resume pay for, where replaying 1.2 s
  // would add up to seventy.
  const total = samples.reduce((sum, updates) => sum + updates, 0);
  expect(Math.max(...samples)).toBeLessThanOrEqual(5);
  expect(total).toBeLessThanOrEqual(Math.ceil(owed / STEP) + 1);

  const after = await page.evaluate(() => window.__reallm.stats());
  expect(after.frame).toBeGreaterThan(paused.frame);
  expect(after.frame).toBeGreaterThan(before.frame);
  // Decisive: nothing was thrown away that those frames do not explain. Hidden
  // time that reached the loop would be owed at the step cap in the first frame
  // after the resume — a 16 ms frame that explains none — and land here.
  expect(dropped).toBeLessThanOrEqual(droppable + 1e-6);
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
