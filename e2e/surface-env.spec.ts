// SPEC-018 — the surface environment's render budget on `medium` (§4.11):
// after 30 rendered frames on Cinder-4 the frame stays within 96 draw calls
// (80 scene + 16 post) and 120 k triangles, and the `debug-scene` row still
// parses like every other suite expects.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const URL = '/?debug&scene=surface&planet=cinder4&quality=medium';

async function afterFrames(page: Page, frames: number): Promise<{ drawCalls: number; triangles: number }> {
  const from = (await page.evaluate(() => window.__reallm.stats())).frame;
  await page.waitForFunction((target) => window.__reallm.stats().frame >= target, from + frames);
  return page.evaluate(() => window.__reallm.stats());
}

test('the medium frame stays inside the §4.11 budget after 30 frames', async ({ page }) => {
  await start(page, URL);
  const stats = await afterFrames(page, 30);
  expect(stats.drawCalls).toBeGreaterThan(10); // the environment actually drew
  expect(stats.drawCalls).toBeLessThanOrEqual(96); // 80 scene + 16 post
  expect(stats.triangles).toBeGreaterThan(10_000); // terrain + props + ring
  expect(stats.triangles).toBeLessThanOrEqual(120_000);
});

// SPEC-019 AC-96: the spawn-heavy case — the sculpted enemies, the character,
// projectiles and the VFX pool together stay inside the frame budget once the
// director has a real field up. The AC's "enemies ≥ 12" assumed medium's
// maxEnemies (20) was the ceiling, but SPEC-012 §4.5 scales the ambient
// population by the planet: Cinder-4 is `round(14 · 20 / 32)` = 9 on medium,
// so 12 is unreachable on the pinned URL and the poll waits for the
// director's own ceiling instead. The true 32-enemy worst case is pinned in
// node by tests/views/enemyRecipes.test.ts (AC-98).
const CINDER4_MEDIUM_POPULATION = 9; // populationTarget(cinder4, medium), SPEC-012 §4.5

test('the spawn-heavy medium frame stays within 96 draws and 130 k triangles', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, URL);
  await page.waitForFunction(
    (target) => Number(window.__reallm.stats().sceneInfo?.['enemies'] ?? 0) >= target,
    CINDER4_MEDIUM_POPULATION,
    { timeout: 90_000, polling: 250 },
  );
  let maxDraws = 0;
  let maxTriangles = 0;
  for (let i = 0; i < 30; i++) {
    const stats = await afterFrames(page, 1);
    maxDraws = Math.max(maxDraws, stats.drawCalls);
    maxTriangles = Math.max(maxTriangles, stats.triangles);
  }
  expect(maxDraws).toBeLessThanOrEqual(96); // 80 scene + 16 post
  expect(maxTriangles).toBeLessThanOrEqual(130_000);
});

test('the debug-scene row still parses on the environment build', async ({ page }) => {
  await start(page, URL);
  await afterFrames(page, 30);
  await expect(page.locator('[data-testid="debug-scene"]')).toHaveText(/^scene surface(?: [\w-]+=[^\s]+)*$/);
  // The layout row carries the pinned hash format — nothing leaked into it.
  await expect(page.locator('[data-testid="debug-layout"]')).toHaveText(/^layout [a-z0-9_]+ [0-9a-f]{8}$/);
});
