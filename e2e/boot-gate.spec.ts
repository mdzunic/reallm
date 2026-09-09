// The boot gate (SPEC-002 §4.5, §6.2). Nothing about the game starts before a
// user gesture — that is what lets the browser start an AudioContext (E21) —
// so this suite covers what the player sees before it and what happens after.
import { expect, test } from '@playwright/test';
import { awaitGate, COLD_START, frames, passGate, start } from './start';

const overlay = '[data-testid="boot-overlay"]';
const progress = '[data-testid="boot-progress"]';
const bar = '[data-testid="boot-bar"]';
const gate = '[data-testid="boot-start"]';
const label = '[data-testid="scene-label"]';

/** Progress text and bar width read in one synchronous pass, so they agree. */
async function sample(page: import('@playwright/test').Page): Promise<{ text: string; width: string }> {
  return page.evaluate(() => ({
    text: document.querySelector('[data-testid="boot-progress"]')?.textContent ?? '',
    width: (document.querySelector('[data-testid="boot-bar"]') as HTMLElement).style.width,
  }));
}

test('the overlay shows a progress bar whose width is done/total (AC-19)', async ({ page }) => {
  // Slow the assets down so the counter is observable rather than a flash.
  await page.route('**/assets/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });

  await page.goto('/');
  // The overlay is built by `main.ts`, so these two waits span cold start.
  await expect(page.locator(overlay)).toBeVisible(COLD_START);
  await expect(page.locator(progress)).toHaveText(/Loading \d+\/\d+/, COLD_START);

  const during = await sample(page);
  const counts = /Loading (\d+)\/(\d+)/.exec(during.text);
  expect(counts).not.toBeNull();
  const done = Number(counts?.[1]);
  const total = Number(counts?.[2]);
  expect(total).toBeGreaterThan(0);
  expect(during.width).toBe(`${Math.round((done / total) * 100)}%`);

  await awaitGate(page);
  const finished = await sample(page);
  expect(finished.text).toBe(`Loading ${total}/${total}`);
  expect(finished.width).toBe('100%');
});

test('TAP TO START appears only after the load, and a click passes the gate (AC-20, AC-21, AC-22)', async ({
  page,
}) => {
  await page.goto('/');
  // Before the manifest is in, there is no gate and no scene.
  await expect(page.locator(overlay)).toBeVisible(COLD_START);

  await awaitGate(page);
  await expect(page.locator(gate)).toHaveText('TAP TO START');
  await expect(page.locator(label)).toHaveCount(0); // the loop has not started

  await page.locator(gate).click();
  await expect(page.locator(overlay)).toBeHidden();
  await expect(page.locator(label)).toHaveText('menu');
});

test('a key press anywhere passes the gate (AC-21)', async ({ page }) => {
  await page.goto('/');
  await awaitGate(page);
  await page.keyboard.press('Space');
  await expect(page.locator(overlay)).toBeHidden();
  await expect(page.locator(label)).toHaveText('menu');
});

test('a pointerup anywhere in the document passes the gate (AC-21)', async ({ page }) => {
  await page.goto('/');
  await awaitGate(page);
  // Deliberately not on the control: the whole document is the gesture target.
  await page.mouse.click(5, 5);
  await expect(page.locator(overlay)).toBeHidden();
  await expect(page.locator(label)).toHaveText('menu');
});

test('later gestures do nothing (02-i, AC-21)', async ({ page }) => {
  await start(page);
  await page.keyboard.press('Space');
  await page.mouse.click(20, 200);
  await expect(page.locator(overlay)).toBeHidden();
  await expect(page.locator(label)).toHaveText('menu');
});

test('nothing past the gate runs until the gesture arrives (AC-22, AC-23)', async ({ page }) => {
  await page.goto('/?debug');
  await awaitGate(page);

  const events = page.locator('[data-testid="debug-events"]');
  await expect(events).toContainText('boot:assets');
  // Step 4 of §4.5 has not run: no audio unlock, no wake lock, no loop.
  await expect(events).not.toContainText('boot:started');

  await passGate(page);
  // `boot:started` is logged only after `await audio.unlock()` has returned and
  // the wake-lock and fullscreen requests have been made, so its presence is
  // the whole of step 4 having run — including a refusal of either, which is
  // ignored so the game keeps running in the page (02-f).
  await expect(events).toContainText('boot:started');
  await expect(page.locator(label)).toHaveText('menu');
  expect(await page.evaluate(() => window.__reallm.stats().state)).toBe('running');
});

test('the loop starts and the menu prop turns (AC-22, AC-24)', async ({ page }) => {
  await start(page, '/?debug');
  const first = await page.evaluate(() => window.__reallm.stats());
  expect(first.state).toBe('running');

  await frames(page, 10);
  const second = await page.evaluate(() => window.__reallm.stats());
  expect(second.frame).toBeGreaterThan(first.frame);
  expect(second.fps).toBeGreaterThan(0);

  // The rotating object of D-I: its rotation is reported by the scene's
  // debugInfo() and must have advanced between the two samples.
  const spinBefore = Number(first.sceneInfo?.['spin'] ?? 0);
  const spinAfter = Number(second.sceneInfo?.['spin'] ?? 0);
  expect(spinAfter).toBeGreaterThan(spinBefore);
});

/** Record what the gate asks the platform for, and refuse both (02-f). */
async function stubPlatformRequests(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { __asked: string[] }).__asked = calls;
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request(type: string) {
          calls.push(`wakeLock:${type}`);
          return Promise.reject(new Error('denied by the test'));
        },
      },
    });
    // On the prototype, not on `document.documentElement`, which does not
    // exist yet when an init script runs.
    Element.prototype.requestFullscreen = function requestFullscreen(): Promise<void> {
      calls.push('fullscreen');
      return Promise.reject(new Error('denied by the test'));
    };
  });
}

const asked = (page: import('@playwright/test').Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __asked: string[] }).__asked);

test('the gate asks for the wake lock and shrugs off the refusal (AC-23, 02-f)', async ({ page }) => {
  await stubPlatformRequests(page);
  await page.goto('/');
  await awaitGate(page);
  expect(await asked(page)).toEqual([]);

  await page.locator(gate).click();
  await expect(page.locator(label)).toHaveText('menu'); // both refusals ignored
  expect(await asked(page)).toEqual(['wakeLock:screen']); // no fullscreen on desktop
});

test.describe('on Android', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  });

  test('the gate also asks for fullscreen (AC-23)', async ({ page }) => {
    await stubPlatformRequests(page);
    await page.goto('/');
    await awaitGate(page);
    await page.locator(gate).click();
    await expect(page.locator(label)).toHaveText('menu');
    expect(await asked(page)).toEqual(['wakeLock:screen', 'fullscreen']);
  });
});

test('a failed asset shows Retry and no gate until the load succeeds (AC-25)', async ({ page }) => {
  let offline = true;
  await page.route('**/assets/textures/noise.png', async (route) => {
    if (offline) await route.abort();
    else await route.continue();
  });

  await page.goto('/');
  // Visible, not merely present: the copy is in the markup from the start.
  // Cold-start budget: this is the first DOM wait after the navigation.
  await expect(page.locator('[data-testid="boot-error"]')).toBeVisible(COLD_START);
  await expect(page.locator('[data-testid="boot-error"]')).toContainText('Could not load assets');
  await expect(page.locator(gate)).toBeHidden();
  await expect(page.locator(label)).toHaveCount(0);

  offline = false;
  await page.locator('[data-testid="boot-retry"]').click();
  await passGate(page);
  await expect(page.locator(label)).toHaveText('menu');
});

test('the ?scene= flag is applied after the gate (AC-26)', async ({ page }) => {
  await page.goto('/?scene=surface&planet=cinder4');
  await awaitGate(page);
  // Still nothing: the jump target had to wait for the gesture too.
  await expect(page.locator(label)).toHaveCount(0);

  await page.locator(gate).click();
  await expect(page.locator(label)).toHaveText('surface');
});
