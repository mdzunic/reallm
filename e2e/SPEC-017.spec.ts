// SPEC-017 — two gaps the static review could trace but not run (review.json
// `unverified`): AC-70's scene-cycle memory check runs on `low` (`E2E_PRESET`),
// where `quality.ibl` is false and `UiScene.useEnvironment` never builds a
// `DataTexture` — so `scene-cycle.spec.ts` never exercises the environment
// disposal path SPEC-017 added. And AC-75's claim that a preset change from the
// surface pause menu reaches the shadow map and environment immediately is
// traced through five hops of source but never driven. Both are exercised here.
import { expect, test } from '@playwright/test';
import { start } from './start';

/** One transition, plus the frame that actually draws the scene we landed in. */
async function go(page: import('@playwright/test').Page, id: string, params: unknown = {}): Promise<boolean> {
  return page.evaluate(
    async ({ id, params }) => {
      const ok = await window.__reallm.go(id, params);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return ok;
    },
    { id, params },
  );
}

test.describe('scene cycling with image-based lighting live (AC-69, AC-70)', () => {
  test.use({ reducedMotion: 'reduce' });

  test('station ↔ starmap 20 times on medium leaves GPU memory where it started', async ({ page }) => {
    // `medium` runs the composer on every transition (SPEC-017), and this
    // container rasterises it on the CPU (docs/playtest-log.md, "SPEC-017"):
    // 42 transitions at that cost need more than Playwright's 60 s default,
    // the same reason `post-chain.spec.ts`'s multi-scene case raises its own.
    test.setTimeout(180_000);
    await start(page, '/?debug&quality=medium');
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
    expect((await page.evaluate(() => window.__reallm.stats())).preset).toBe('medium');

    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);
    expect(await go(page, 'station', {})).toBe(true);
    await page.waitForTimeout(400);
    const baseline = await page.evaluate(() => window.__reallm.memory());
    expect(baseline.geometries).toBeGreaterThan(0);
    expect(baseline.textures).toBeGreaterThan(0);

    for (let cycle = 0; cycle < 20; cycle++) {
      expect(await go(page, 'starmap', undefined)).toBe(true);
      expect(await go(page, 'station', {})).toBe(true);
    }

    await page.waitForTimeout(400);
    const after = await page.evaluate(() => window.__reallm.memory());
    expect(Math.abs(after.geometries - baseline.geometries)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.textures - baseline.textures)).toBeLessThanOrEqual(2);
  });
});

test('a preset change from the surface pause menu reaches the shadow map and environment immediately (AC-75)', async ({
  page,
}) => {
  await start(page, '/?debug&quality=low&scene=surface&planet=cinder4');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');

  const before = await page.evaluate(() => window.__reallm.stats());
  expect(before.preset).toBe('low');
  // `low` has no shadow map and no environment: the direct path, few draws.

  await page.keyboard.press('Escape');
  await page.locator('[data-testid="pause-settings"]').click();
  const highButton = page.locator('[data-testid="settings-quality-high"]');
  await highButton.click();
  await page.locator('[data-testid="settings-close"]').click();
  await page.locator('[data-testid="pause-resume"]').click();

  // `setQuality` -> `#apply(true)` -> `renderer:resized` -> the surface's
  // `Disposer`-owned subscription -> `view.applyQuality`, all inside one tick;
  // the readout after a short settle should already reflect `high`.
  await expect
    .poll(async () => (await page.evaluate(() => window.__reallm.stats())).preset)
    .toBe('high');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.__reallm.stats());

  // `high` builds a 1024^2 shadow map and an environment map on top of the
  // direct path's few draws: both push geometries/textures and draw calls up
  // by a wide margin, which is what "reaches the shadow map and environment
  // immediately" cashes out to from outside the renderer.
  expect(after.drawCalls).toBeGreaterThan(before.drawCalls);
  expect(after.geometries).toBeGreaterThan(before.geometries);
  expect(after.textures).toBeGreaterThan(before.textures);
});
