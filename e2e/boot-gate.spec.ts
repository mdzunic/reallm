// The boot gate (SPEC-002 §4.5, SPEC-031 §4.1–§4.3, §6.2). Nothing about the
// game starts before a user gesture — that is what lets the browser start an
// AudioContext (E21) — and since SPEC-031 the gesture is the START THE GAME
// control alone (E46): a stray tap anywhere else must not start the game.
import { expect, test } from '@playwright/test';
import { awaitGate, COLD_START, frames, gameUrl, passGate, start } from './start';

const overlay = '[data-testid="boot-overlay"]';
const progress = '[data-testid="boot-progress"]';
const gate = '[data-testid="boot-start"]';
const label = '[data-testid="scene-label"]';

/** Progress text and bar width read in one synchronous pass, so they agree. */
async function sample(page: import('@playwright/test').Page): Promise<{ text: string; width: string }> {
  return page.evaluate(() => ({
    text: document.querySelector('[data-testid="boot-progress"]')?.textContent ?? '',
    width: (document.querySelector('[data-testid="boot-bar"]') as HTMLElement).style.width,
  }));
}

test('the overlay shows a percentage whose bar width agrees (SPEC-031 AC-3)', async ({ page }) => {
  // Slow the assets down so the counter is observable rather than a flash.
  await page.route('**/assets/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });

  await page.goto(gameUrl('/'));
  // The overlay is built by `main.ts`, so these two waits span cold start.
  await expect(page.locator(overlay)).toBeVisible(COLD_START);
  await expect(page.locator(progress)).toHaveText(/Loading \d+ %/, COLD_START);

  const during = await sample(page);
  const counts = /Loading (\d+) %/.exec(during.text);
  expect(counts).not.toBeNull();
  const percent = Number(counts?.[1]);
  expect(during.text).not.toMatch(/\d+\/\d+/); // never a raw count (AC-1)
  expect(during.width).toBe(`${percent}%`);

  await awaitGate(page);
  const finished = await sample(page);
  expect(finished.text).toBe('Loading 100 %');
  expect(finished.width).toBe('100%');
});

test('the overlay fills the viewport and stacks its column in order (AC-2)', async ({ page }) => {
  await page.goto(gameUrl('/'));
  await expect(page.locator(overlay)).toBeVisible(COLD_START);
  const shape = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="boot-overlay"]') as HTMLElement;
    const style = getComputedStyle(root);
    return {
      position: style.position,
      inset: style.inset,
      children: Array.from(root.children).map((child) => child.className.split(' ')[0]),
    };
  });
  expect(shape.position).toBe('fixed');
  expect(shape.inset).toBe('0px');
  expect(shape.children).toEqual([
    'boot-title',
    'boot-tagline',
    'boot-bar-track',
    'boot-progress',
    'boot-slow',
    'boot-error',
    'ui-btn',
    'boot-foot',
  ]);
  await expect(page.locator('.boot-title')).toHaveText('ReaLLM');
  await expect(page.locator('.boot-tagline')).toHaveText('EARTH COMMAND · SALVAGE DIVISION');
});

test('START THE GAME appears only after the load, and only the control passes the gate (AC-8, AC-9)', async ({
  page,
}) => {
  await page.goto(gameUrl('/'));
  // Before the manifest is in, there is no gate and no scene.
  await expect(page.locator(overlay)).toBeVisible(COLD_START);

  await awaitGate(page);
  await expect(page.locator(gate)).toHaveText('START THE GAME');
  await expect(page.locator(label)).toHaveCount(0); // the loop has not started

  // A pointer anywhere else does not pass the gate (E46) — the centre-bottom
  // of the viewport is empty space well away from the control.
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport size unavailable');
  const box = await page.locator(gate).boundingBox();
  if (!box) throw new Error('the start control has no box');
  const y = Math.min(viewport.height - 4, box.y + box.height + 40);
  await page.mouse.click(viewport.width / 2, y);
  // Nor does a key that is not Enter or Space.
  await page.keyboard.press('KeyA');
  await expect(page.locator(overlay)).toBeVisible();
  await expect(page.locator(label)).toHaveCount(0);

  await page.locator(gate).click();
  await expect(page.locator(overlay)).toBeHidden();
  await expect(page.locator(label)).toHaveText('menu');
});

test('a fresh Enter passes the gate (AC-8)', async ({ page }) => {
  await page.goto(gameUrl('/'));
  await awaitGate(page);
  await page.keyboard.press('Enter');
  await expect(page.locator(overlay)).toBeHidden();
  await expect(page.locator(label)).toHaveText('menu');
});

test('later gestures do nothing (02-i)', async ({ page }) => {
  await start(page);
  await page.keyboard.press('Space');
  await page.mouse.click(20, 200);
  await expect(page.locator(overlay)).toBeHidden();
  await expect(page.locator(label)).toHaveText('menu');
});

test('nothing past the gate runs until the gesture arrives (SPEC-002 AC-22, AC-23)', async ({ page }) => {
  await page.goto(gameUrl('/?debug'));
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

test('the loop starts and the menu prop turns (SPEC-002 AC-22, AC-24)', async ({ page }) => {
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
    // SPEC-015 AC-35: the landscape lock is attempted after the fullscreen
    // request *settles*, either way, and its rejection is swallowed.
    Object.defineProperty(screen, 'orientation', {
      configurable: true,
      value: {
        lock(to: string) {
          calls.push(`lock:${to}`);
          return Promise.reject(new Error('denied by the test'));
        },
      },
    });
  });
}

const asked = (page: import('@playwright/test').Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __asked: string[] }).__asked);

/**
 * SPEC-015 AC-39 / D-7 moved the wake lock off the gate: it used to be an
 * unconditional request on the boot tap, and it is now owned by the surface and
 * flight scenes, which take it on enter and release it on exit — so there is
 * exactly one owner and "released elsewhere" is true by construction. The menu
 * is not a gameplay scene, so passing the gate into it asks the platform for
 * nothing at all on desktop. `e2e/SPEC-015.spec.ts` and `tests/core/wakeLock.test.ts`
 * cover the new owner; this pins that the gate no longer has one.
 */
test('the gate asks the platform for nothing on desktop (SPEC-015 AC-39, D-7)', async ({ page }) => {
  await stubPlatformRequests(page);
  await page.goto(gameUrl('/'));
  await awaitGate(page);
  expect(await asked(page)).toEqual([]);

  await page.locator(gate).click();
  await expect(page.locator(label)).toHaveText('menu');
  // No wake lock (the scenes own it now) and no fullscreen (Android only, D-8).
  expect(await asked(page)).toEqual([]);
});

test('a gameplay scene takes the wake lock and shrugs off the refusal (SPEC-002 AC-23, 02-f, SPEC-015 AC-38)', async ({
  page,
}) => {
  await stubPlatformRequests(page);
  await page.goto(gameUrl('/?scene=surface&planet=cinder4'));
  await awaitGate(page);
  expect(await asked(page)).toEqual([]);

  await page.locator(gate).click();
  // The refusal is swallowed: the scene enters anyway (15-e, AC-40).
  await expect(page.locator(label)).toHaveText('surface');
  expect(await asked(page)).toEqual(['wakeLock:screen']);
});

test.describe('on Android', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  });

  test('the gate asks for fullscreen, then the landscape lock (SPEC-002 AC-23, SPEC-015 AC-34, AC-35)', async ({
    page,
  }) => {
    await stubPlatformRequests(page);
    await page.goto(gameUrl('/'));
    await awaitGate(page);
    await page.locator(gate).click();
    // Both refusals are swallowed and the boot continues into the menu.
    await expect(page.locator(label)).toHaveText('menu');
    // AC-35: the lock comes *after* the request settles, in that order, and a
    // rejected lock is a warning and nothing else. Whether a real Android then
    // holds landscape is owed on hardware before `m7` (D-15).
    await expect.poll(() => asked(page)).toEqual(['fullscreen', 'lock:landscape']);
  });

  test('skips fullscreen when the player turned it off (SPEC-015 AC-34)', async ({ page }) => {
    await stubPlatformRequests(page);
    await page.addInitScript(() => {
      // `settings.fullscreen` is tri-state: `null` is "never chosen" and is
      // still attempted; only an explicit `false` opts out.
      localStorage.setItem('reallm:settings', JSON.stringify({ version: 1, fullscreen: false }));
    });
    await page.goto(gameUrl('/'));
    await awaitGate(page);
    await page.locator(gate).click();
    await expect(page.locator(label)).toHaveText('menu');
    expect(await asked(page)).toEqual([]);
  });
});

test('a failed asset shows Retry inside the same frame and no gate until the load succeeds (AC-10)', async ({
  page,
}) => {
  let offline = true;
  await page.route('**/assets/textures/noise.png', async (route) => {
    if (offline) await route.abort();
    else await route.continue();
  });

  await page.goto(gameUrl('/'));
  // Visible, not merely present: the copy is in the markup from the start.
  // Cold-start budget: this is the first DOM wait after the navigation.
  await expect(page.locator('[data-testid="boot-error"]')).toBeVisible(COLD_START);
  await expect(page.locator('[data-testid="boot-error"]')).toContainText('Could not load assets — check connection');
  await expect(page.locator(gate)).toBeHidden();
  await expect(page.locator('[data-testid="boot-slow"]')).toBeHidden();
  await expect(page.locator(label)).toHaveCount(0);

  offline = false;
  await page.locator('[data-testid="boot-retry"]').click();
  await passGate(page);
  await expect(page.locator(label)).toHaveText('menu');
});

test.describe('at 320 × 640', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('the start control sits inside the viewport (SPEC-031 §6.2)', async ({ page }) => {
    await page.goto(gameUrl('/'));
    await awaitGate(page);
    const box = await page.locator(gate).boundingBox();
    if (!box) throw new Error('the start control has no box');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(box.y + box.height).toBeLessThanOrEqual(640);
  });
});

test('the ?scene= flag is applied after the gate (SPEC-002 AC-26)', async ({ page }) => {
  await page.goto(gameUrl('/?scene=surface&planet=cinder4'));
  await awaitGate(page);
  // Still nothing: the jump target had to wait for the gesture too.
  await expect(page.locator(label)).toHaveCount(0);

  await page.locator(gate).click();
  await expect(page.locator(label)).toHaveText('surface');
});
