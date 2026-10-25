// SPEC-071 §5: the launch from the cockpit in a real browser. There is no
// exterior shot to cut from: the camera is on the cruise rig from the first
// frame, a key pressed during the launch steers instead of ending anything,
// and the run-up reads 0…1 on the launch phase's own 3 s clock, which is real
// time here — so the cases read `sceneInfo` straight after the scene is up.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

async function launch(page: Page): Promise<number> {
  return Number((await sceneInfo(page))['launch'] ?? Number.NaN);
}

/** Resolve after `count` animation frames. */
async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, count);
}

/** `cameraZ` on every few frames until the launch is over. */
async function cameraZsThroughLaunch(page: Page): Promise<Set<number>> {
  const seen = new Set<number>();
  for (let i = 0; i < 60 && (await launch(page)) < 1; i++) {
    seen.add(Number((await sceneInfo(page))['cameraZ']));
    await frames(page, 3);
  }
  return seen;
}

test.describe('the launch from the cockpit', () => {
  test('opens on the cruise rig, stays there and runs up to 1 inside the draw budget (1)', async ({ page }) => {
    await start(page, '/?debug&scene=flight&planet=cinder4&quality=medium');
    expect(await launch(page)).toBeLessThan(1);
    const during = await page.evaluate(() => window.__reallm.stats());
    expect(during.drawCalls).toBeLessThanOrEqual(56);
    expect(during.triangles).toBeLessThanOrEqual(80_000);
    // No skip hint over the launch: there is nothing to skip.
    await expect(page.locator('[data-testid="skip-landing"]')).toBeHidden();
    const seen = await cameraZsThroughLaunch(page);
    expect([...seen]).toEqual([2.5]);
    await page.waitForFunction(() => Number(window.__reallm.stats().sceneInfo?.['launch']) === 1, undefined, { timeout: 10_000 });
    expect(Number((await sceneInfo(page))['cameraZ'])).toBe(2.5);
  });

  test('a key pressed during the launch steers and ends nothing (2)', async ({ page }) => {
    await start(page, '/?debug&scene=flight&planet=cinder4');
    expect(await launch(page)).toBeLessThan(1);
    const x0 = Number((await sceneInfo(page))['shipX']);
    await page.keyboard.down('KeyD');
    await frames(page, 12);
    await page.keyboard.up('KeyD');
    const info = await sceneInfo(page);
    expect(Number(info['launch'])).toBeLessThan(1);
    expect(Number(info['shipX'])).toBeGreaterThan(x0);
    await page.keyboard.press('KeyF');
    await frames(page, 2);
    expect(await launch(page)).toBeLessThan(1);
  });

  test.describe('reduce motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('keeps the camera on the rig through the run-up (3)', async ({ page }) => {
      await start(page, '/?debug&scene=flight&planet=cinder4');
      const seen = await cameraZsThroughLaunch(page);
      expect([...seen]).toEqual([2.5]);
    });
  });
});
