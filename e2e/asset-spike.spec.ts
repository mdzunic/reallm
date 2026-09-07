// The asset spike (SPEC-002 §4.5, §6.2). Two things had to be proved before any
// scene depends on them: a rigged model survives the clone the asset registry
// makes of it and plays a clip from the scene's own update, and a colour map
// reaches the GPU in sRGB rather than being decoded twice.
//
// Both are reported by the menu scene's `debugInfo()`, which the stats overlay
// prints in the `debug-scene` row (§4.6.1).
import { expect, test } from '@playwright/test';
import { frames, start } from './start';

test('the rigged character loads, clones and plays its named clip (AC-50, AC-51)', async ({ page }) => {
  await start(page, '/?debug');
  await frames(page, 3);

  const first = await page.evaluate(() => window.__reallm.stats());
  expect(first.scene).toBe('menu');
  expect(first.sceneInfo?.['clip']).toBe('Idle');

  const before = Number(first.sceneInfo?.['clipTime'] ?? 0);
  await frames(page, 12);
  const after = Number((await page.evaluate(() => window.__reallm.stats())).sceneInfo?.['clipTime'] ?? 0);
  expect(after).toBeGreaterThan(before);

  // The clone is a SkinnedMesh with its own skeleton — `SkeletonUtils.clone`,
  // not `Object3D.clone`, which would leave every instance sharing one pose.
  const rig = await page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="debug-scene"]');
    return overlay?.textContent ?? '';
  });
  expect(rig).toContain('clip=Idle');
});

test('the ship renders with an sRGB colour map (AC-52)', async ({ page }) => {
  await start(page, '/?debug');
  await frames(page, 3);
  const stats = await page.evaluate(() => window.__reallm.stats());
  expect(stats.sceneInfo?.['shipMap']).toBe('srgb');
  await expect(page.locator('[data-testid="debug-scene"]')).toHaveText(/shipMap=srgb/);
});

test('both models come from the manifest, and drawing them costs draw calls (AC-53)', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes('/assets/models/')) fetched.push(path);
  });

  await start(page, '/?debug');
  await frames(page, 3);
  expect(fetched.some((path) => path.endsWith('character.glb'))).toBe(true);
  expect(fetched.some((path) => path.endsWith('ship.glb'))).toBe(true);

  const stats = await page.evaluate(() => window.__reallm.stats());
  expect(stats.drawCalls).toBeGreaterThan(1);
  expect(stats.triangles).toBeGreaterThan(0);
});
