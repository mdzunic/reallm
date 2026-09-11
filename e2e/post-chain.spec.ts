// SPEC-017 §6 — what the post chain actually costs, measured on the running
// game rather than argued from the source. The stats overlay counts the whole
// frame now (`gl.info.autoReset = false`, one `reset()` per rendered frame), so
// the difference between two presets on the *same* scene is the chain and
// nothing else:
//
//   low     direct path                                            + 0
//   medium  bloom 13 + output 1 + FXAA 1 + grade 1                 + 16
//   high    bloom 13 + output 1 + grade 1 (MSAA instead of FXAA)    + 15
//
// Two conditions make that subtraction honest, and both are pinned here: the
// menu's own draw count may not vary with the preset (D-11), and the ratio is
// forced to 1 so `high` takes its MSAA branch (the `dpr <= 1.5` rule) rather
// than falling back to FXAA. The sample is taken after 30 rendered frames, past
// the one frame where PMREM filters the environment map (17-o).
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const PRESETS = ['low', 'medium', 'high'] as const;

interface Sample {
  draws: number;
  tris: number;
  dpr: number;
}

/** Load the menu on `preset` and read the stats after 30 rendered frames. */
async function sample(page: Page, preset: (typeof PRESETS)[number]): Promise<Sample> {
  await start(page, `/?debug&quality=${preset}`);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
  const stats = await page.evaluate(() => window.__reallm.stats());
  expect(stats.preset).toBe(preset);
  const from = stats.frame;
  await expect
    .poll(async () => (await page.evaluate(() => window.__reallm.stats().frame)) - from, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(30);
  const after = await page.evaluate(() => window.__reallm.stats());
  return { draws: after.drawCalls, tris: after.triangles, dpr: after.dpr };
}

test.describe('the post chain', () => {
  // `high` clamps to dpr 2 and `medium` to 1.5; at a device ratio of 1 every
  // preset lands on 1, which is both the MSAA branch and the cheapest frame.
  test.use({ deviceScaleFactor: 1 });

  test('costs exactly 16 quads with FXAA and 15 with MSAA (AC-47, AC-48)', async ({ page }) => {
    const low = await sample(page, 'low');
    const medium = await sample(page, 'medium');
    const high = await sample(page, 'high');

    for (const [preset, reading] of [
      ['low', low],
      ['medium', medium],
      ['high', high],
    ] as const) {
      expect(reading.dpr, preset).toBe(1);
      expect(reading.draws, preset).toBeGreaterThan(0); // the readout is live
    }

    // bloom 13 + output 1 + FXAA 1 + grade 1.
    expect(medium.draws - low.draws).toBe(16);
    // bloom 13 + output 1 + grade 1; MSAA resolves in the target, not a pass.
    expect(high.draws - low.draws).toBe(15);

    // Each pass draws one fullscreen triangle, so the triangle counter is an
    // independent instrument on the same claim — and it is what would move if
    // the menu's own backdrop differed between presets (D-11, AC-49).
    expect(medium.tris - low.tris).toBe(16);
    expect(high.tris - low.tris).toBe(15);
  });

  test('runs over the real scenes, not only the menu backdrop', async ({ page }) => {
    // The gameplay suites run on `low` (`e2e/start.ts`), so this is where the
    // composer meets the two scenes that actually load something: the surface,
    // with its lighting rig and blob shadows, and the trip, with its sky window
    // and planet. Both have to come up and keep drawing through the chain.
    test.setTimeout(180_000);
    for (const scene of ['surface', 'flight'] as const) {
      await start(page, `/?debug&quality=medium&scene=${scene}&planet=cinder4`);
      await expect(page.locator('[data-testid="scene-label"]')).toHaveText(scene);
      const from = await page.evaluate(() => window.__reallm.stats().frame);
      await expect
        .poll(async () => (await page.evaluate(() => window.__reallm.stats().frame)) - from, { timeout: 60_000 })
        .toBeGreaterThan(10);
      const stats = await page.evaluate(() => window.__reallm.stats());
      expect(stats.preset, scene).toBe('medium');
      // Sixteen quads on top of whatever the scene itself draws, and the scene
      // is still drawing: a chain that had fallen over would leave one or the
      // other of these at the floor.
      expect(stats.drawCalls, scene).toBeGreaterThan(16);
      expect(stats.triangles, scene).toBeGreaterThan(16);
    }
  });

  test('the chain survives a scene change without growing (17-l)', async ({ page }) => {
    await start(page, '/?debug&quality=medium');
    const menu = await page.evaluate(() => window.__reallm.stats().drawCalls);
    expect(await page.evaluate(() => window.__reallm.go('station', {}))).toBe(true);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
    const from = await page.evaluate(() => window.__reallm.stats().frame);
    await expect
      .poll(async () => (await page.evaluate(() => window.__reallm.stats().frame)) - from, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(30);
    const station = await page.evaluate(() => window.__reallm.stats().drawCalls);
    // Both scenes pay for the same one chain: whatever the backdrops cost, the
    // frame is still a single composer run.
    expect(station).toBeGreaterThan(16);
    expect(menu).toBeGreaterThan(16);
  });
});
