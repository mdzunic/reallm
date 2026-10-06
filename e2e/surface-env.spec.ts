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
// maxEnemies (20) was the ceiling, but the ambient population is the planet's:
// SPEC-038 §4.4 made it the design count on every preset, capped by
// `maxEnemies` — Cinder-4 is 10 on medium — so the poll waits for the
// director's own ceiling instead. The true 32-enemy worst case is pinned in
// node by tests/views/enemyRecipes.test.ts (AC-98).
const CINDER4_MEDIUM_POPULATION = 10; // populationTarget(cinder4, medium), SPEC-038 §4.4

/**
 * SPEC-035 §4.7 halves Cinder-4's ambient population until `c1_m1` is done, so
 * the spawn-heavy worst case this test exists to measure is only reachable with
 * the tutorial behind the player. `sceneInfo.ramp` is what proves the ramp is
 * off; the ramp itself is covered by `e2e/SPEC-035.spec.ts`.
 */

/** The pilot `endRamp` binds to a slot; the stats below are the §6 pin's. */
const RAMP_PILOT = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

async function endRamp(page: Page): Promise<void> {
  // A `?scene=` jump has no bound save (the scene builds a throwaway one), so
  // the ramp is only reachable through a real slot.
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation), RAMP_PILOT);
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save !== null && !save.progress.missionsDone.includes('c1_m1')) save.progress.missionsDone.push('c1_m1');
  });
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4' }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect
    .poll(async () => Number((await page.evaluate(() => window.__reallm.stats().sceneInfo ?? {}))['ramp'] ?? 1), { timeout: 15_000 })
    .toBe(0);
}

test('the spawn-heavy medium frame stays within 96 draws and 130 k triangles', async ({ page }) => {
  test.setTimeout(150_000);
  // SPEC-040 §4.3: this container cannot hold 60 on `medium`, so after 15 s in
  // play the adaptive governor would step the session down to `low` — and the
  // budget below would be measured on the wrong preset. The budget is about
  // `medium`, so the governor is off for it (E68, 40-g). SPEC-038 §4.7 turned
  // auto-fire on by default; the field this case measures is a full one, so the
  // salvager holds its fire while the director fills it.
  await page.addInitScript(() =>
    localStorage.setItem('reallm:settings', JSON.stringify({ adaptiveQuality: false, autoFire: 'off' })),
  );
  await start(page, URL);
  await endRamp(page);
  await page.waitForFunction(
    (target) => Number(window.__reallm.stats().sceneInfo?.['enemies'] ?? 0) >= target,
    CINDER4_MEDIUM_POPULATION,
    { timeout: 90_000, polling: 250 },
  );
  // The next 30 frames, each one read in the page as it lands. Since SPEC-040
  // §4.2 a host without a GPU draws every frame it gets, and a round trip per
  // frame (three of them, as `afterFrames` makes) waits out a draw each — on a
  // loaded run, thirty of those outlast the test.
  const { maxDraws, maxTriangles } = await page.evaluate(
    (count) =>
      new Promise<{ maxDraws: number; maxTriangles: number }>((resolve) => {
        const from = window.__reallm.stats().frame;
        let seen = from;
        let maxDraws = 0;
        let maxTriangles = 0;
        const sample = (): void => {
          const stats = window.__reallm.stats();
          if (stats.frame !== seen) {
            seen = stats.frame;
            maxDraws = Math.max(maxDraws, stats.drawCalls);
            maxTriangles = Math.max(maxTriangles, stats.triangles);
          }
          if (seen - from >= count) resolve({ maxDraws, maxTriangles });
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    30,
  );
  expect(maxDraws).toBeLessThanOrEqual(96); // 80 scene + 16 post
  expect(maxTriangles).toBeLessThanOrEqual(130_000);
});

// SPEC-030 D-17 / AC-44: with the wall and the shelters in place, every
// planet stays inside the medium budget after 30 frames (§6.2 case 5).
const PLANET_IDS = ['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden'] as const;

for (const planet of PLANET_IDS) {
  test(`${planet} stays within 96 draws and 130 k triangles on medium (SPEC-030 AC-44)`, async ({ page }) => {
    await start(page, `/?debug&scene=surface&planet=${planet}&quality=medium`);
    const stats = await afterFrames(page, 30);
    expect(stats.drawCalls).toBeGreaterThan(10);
    expect(stats.drawCalls).toBeLessThanOrEqual(96); // 80 scene + 16 post
    expect(stats.triangles).toBeLessThanOrEqual(130_000);
    // SPEC-046 §6.2 case 7, the spawn ratchet — the same frame, 30 frames after
    // landing at the spawn: with only what is on screen drawn it sits far under
    // the budget (≈ 20–35 k), and this holds the gain at 60 k, so a layer that
    // stops culling fails here instead of in a frame-time chart.
    expect(stats.triangles, `${planet}: SPEC-046 spawn ratchet`).toBeLessThanOrEqual(60_000);
  });
}

// SPEC-057 §4.6: the remains — the body, the costlier look (2 616 triangles
// under its pillar) — on screen 6 m from the spawn, and the same frame stays
// inside the §4.11 budget. The remains' own share is at most 3 draws and
// 2 700 triangles.
test('the medium frame stays inside the §4.11 budget with the remains on screen (SPEC-057 §4.6)', async ({ page }) => {
  await start(page, '/?debug&seed=123&quality=medium');
  await page.evaluate(() => {
    const save = window.__reallm.save().create(
      0,
      {
        name: 'Vance',
        classId: 'marine',
        appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
        attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
        difficulty: 'normal',
      },
      123,
    );
    save.progress.flags.push('signal_decoded');
    // Seed 123 lands the salvager at (11.9, 1.7): these lie 6 m off, outside the 2 m reach.
    save.progress.remains = { planet: 'cinder4', x: 6, z: 1, resources: { oil: 20 }, restart: 1 };
  });
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  const stats = await afterFrames(page, 30);
  const info = (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};
  expect(info['remainsDrawn']).toBe('body');
  // The tag is up only while the remains are on screen and within 30 m.
  expect(info['remainsTag']).toBe(1);
  expect(Number(info['remainsDraws'])).toBeLessThanOrEqual(3);
  expect(Number(info['remainsTris'])).toBeLessThanOrEqual(2700);
  expect(stats.drawCalls).toBeGreaterThan(10);
  expect(stats.drawCalls).toBeLessThanOrEqual(96); // 80 scene + 16 post
  expect(stats.triangles).toBeLessThanOrEqual(120_000);
});

test('the debug-scene row still parses on the environment build', async ({ page }) => {
  await start(page, URL);
  await afterFrames(page, 30);
  await expect(page.locator('[data-testid="debug-scene"]')).toHaveText(/^scene surface(?: [\w-]+=[^\s]+)*$/);
  // The layout row carries the pinned hash format — nothing leaked into it.
  await expect(page.locator('[data-testid="debug-layout"]')).toHaveText(/^layout [a-z0-9_]+ [0-9a-f]{8}$/);
});
