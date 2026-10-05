// SPEC-053 §6.2 — trees, groves and ground in a real browser: the trees draw
// through the foliage seam, a grove and an orchard keep the foliage and frame
// budgets on `medium`, a trunk stops a walk, a canopy over an enemy thins
// (E82), `low` draws LOD1 and no cover, the wind stills under reduce motion,
// and every planet keeps SPEC-046's spawn ratchet.
//
// The rules themselves are pinned in node — tests/views/foliage.test.ts (the
// dither, the cut-out), tests/views/groundCover.test.ts, tests/views/terrain.test.ts
// (detail, seam, shade), tests/views/surfaceView.test.ts (scale, LOD, the
// canopy fade) and tests/systems/layout.test.ts (the features and their pins).
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, start } from './start';

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

async function info(page: Page, key: string): Promise<number> {
  return Number((await sceneInfo(page))[key] ?? Number.NaN);
}

/** A debug-strip button, clicked in the page (the strip may sit under the HUD). */
async function press(page: Page, id: string): Promise<void> {
  await page.evaluate((testId) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (button === null) throw new Error(`no ${testId} on the debug strip`);
    button.click();
  }, id);
}

/** Wait until `count` more frames have been drawn. */
async function afterFrames(page: Page, count: number): Promise<void> {
  const from = (await page.evaluate(() => window.__reallm.stats())).frame;
  await page.waitForFunction((target) => window.__reallm.stats().frame >= target, from + count, { timeout: 60_000 });
}

/** Click through any open dialogue, as the other surface suites do. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.locator('[data-testid="dialogue"]');
  const advance = page.locator('[data-testid="dialogue-advance"]');
  for (let i = 0; i < 25; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(120);
  }
}

/**
 * Settings for a measurement: the budgets are `medium`'s, so SPEC-040's
 * governor stays off (40-g), and nothing fires while the suite stands still.
 */
async function settings(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript(
    (patch) => localStorage.setItem('reallm:settings', JSON.stringify({ adaptiveQuality: false, autoFire: 'off', ...patch })),
    extra,
  );
}

async function land(page: Page, url: string): Promise<void> {
  await start(page, url);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await dismiss(page);
}

/** The frame's largest draws and triangles over the next `count` frames, read in the page as each lands. */
async function framePeaks(page: Page, count: number): Promise<{ draws: number; triangles: number; foliageTris: number; foliageDraws: number; cover: number }> {
  return page.evaluate(
    (frames) =>
      new Promise<{ draws: number; triangles: number; foliageTris: number; foliageDraws: number; cover: number }>((resolve) => {
        const from = window.__reallm.stats().frame;
        let seen = from;
        const peak = { draws: 0, triangles: 0, foliageTris: 0, foliageDraws: 0, cover: 0 };
        const sample = (): void => {
          const stats = window.__reallm.stats();
          if (stats.frame !== seen) {
            seen = stats.frame;
            const info = stats.sceneInfo ?? {};
            peak.draws = Math.max(peak.draws, stats.drawCalls);
            peak.triangles = Math.max(peak.triangles, stats.triangles);
            peak.foliageTris = Math.max(peak.foliageTris, Number(info['foliageTris'] ?? 0));
            peak.foliageDraws = Math.max(peak.foliageDraws, Number(info['foliageDraws'] ?? 0));
            peak.cover = Math.max(peak.cover, Number(info['coverDrawn'] ?? 0));
          }
          if (seen - from >= frames) resolve(peak);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    count,
  );
}

/**
 * `type` for every key in `codes`, in one task. Pressed one at a time, a frame
 * of a CPU rasteriser lands between two presses, and one key of a pair walks
 * the salvager diagonally off the line the pair walks.
 */
async function keys(page: Page, type: 'keydown' | 'keyup', codes: readonly string[]): Promise<void> {
  await page.evaluate(
    ({ kind, list }) => {
      for (const code of list) window.dispatchEvent(new KeyboardEvent(kind, { code, bubbles: true, cancelable: true }));
    },
    { kind: type, list: [...codes] },
  );
}

/** Hold `codes` for `seconds` of the surface's own clock, which a CPU-starved host slows with the world. */
async function hold(page: Page, codes: readonly string[], seconds: number): Promise<void> {
  const from = await info(page, 'viewTime');
  await keys(page, 'keydown', codes);
  try {
    const deadline = Date.now() + 60_000;
    while ((await info(page, 'viewTime')) - from < seconds && Date.now() < deadline) await page.waitForTimeout(100);
  } finally {
    await keys(page, 'keyup', codes);
  }
}

// --------------------------------------------------------------- 1: trees

test('1. Thessaly’s trees draw through the seam within 2 s of landing, at LOD0 on medium', async ({ page }) => {
  await settings(page);
  await start(page, '/?debug&scene=surface&planet=thessaly&quality=medium');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  // 2 s on the surface's own clock, as SPEC-052's swap is measured.
  let swappedAt = Number.NaN;
  await expect
    .poll(
      async () => {
        const at = await sceneInfo(page);
        if (at['treeSource'] === 'glb' && Number.isNaN(swappedAt)) swappedAt = Number(at['viewTime'] ?? Number.NaN);
        return at['treeSource'];
      },
      { ...COLD_START, intervals: [50] },
    )
    .toBe('glb');
  expect(swappedAt).toBeLessThanOrEqual(2);
  expect(await info(page, 'treeLod')).toBe(0);
});

// ------------------------------------------------------ 2, 3: the budgets

test('2. in a Thessaly grove on medium the foliage keeps 30 k triangles and 12 draws, the frame 96 and 130 k', async ({ page }) => {
  test.setTimeout(120_000);
  await settings(page);
  await land(page, '/?debug&scene=surface&planet=thessaly&quality=medium');
  await expect.poll(async () => (await sceneInfo(page))['treeSource'], COLD_START).toBe('glb');
  await press(page, 'surface-goto-grove');
  await expect.poll(() => info(page, 'groveR'), { timeout: 15_000 }).toBeGreaterThan(0);
  await afterFrames(page, 10);
  const peak = await framePeaks(page, 30);
  expect(peak.foliageTris).toBeLessThanOrEqual(30_000);
  expect(peak.foliageDraws).toBeLessThanOrEqual(12);
  expect(peak.draws).toBeLessThanOrEqual(96);
  expect(peak.triangles).toBeLessThanOrEqual(130_000);
  expect(peak.cover).toBeGreaterThan(0);
});

test('3. in an Eden orchard on medium the same budgets hold, and the seam has a line', async ({ page }) => {
  test.setTimeout(120_000);
  await settings(page);
  await land(page, '/?debug&scene=surface&planet=eden&quality=medium');
  await expect.poll(async () => (await sceneInfo(page))['treeSource'], COLD_START).toBe('glb');
  expect(Number.isFinite(await info(page, 'seamAt'))).toBe(true);
  await press(page, 'surface-goto-grove');
  await expect.poll(() => info(page, 'groveR'), { timeout: 15_000 }).toBeGreaterThan(0);
  await afterFrames(page, 10);
  const peak = await framePeaks(page, 30);
  expect(peak.foliageTris).toBeLessThanOrEqual(30_000);
  expect(peak.foliageDraws).toBeLessThanOrEqual(12);
  expect(peak.draws).toBeLessThanOrEqual(96);
  expect(peak.triangles).toBeLessThanOrEqual(130_000);
  expect(peak.cover).toBeGreaterThan(0);
});

// --------------------------------------------------------------- 4: trunks

test('4. a walk into a grove trunk stops at the trunk’s circle', async ({ page }) => {
  test.setTimeout(120_000);
  await settings(page);
  await land(page, '/?debug&scene=surface&planet=thessaly&quality=medium');
  await press(page, 'surface-goto-grove');
  await expect.poll(() => info(page, 'groveR'), { timeout: 15_000 }).toBeGreaterThan(0);
  const at = await sceneInfo(page);
  const trunk = { x: Number(at['groveX']), z: Number(at['groveZ']), r: Number(at['groveR']) };
  // The salvager stands east of the trunk; W + A walks straight along −x into it.
  await hold(page, ['KeyW', 'KeyA'], 2);
  await page.waitForTimeout(200);
  const after = await sceneInfo(page);
  const distance = Math.hypot(Number(after['px']) - trunk.x, Number(after['pz']) - trunk.z);
  expect(distance, `${distance.toFixed(2)} m from a ${trunk.r} m trunk`).toBeGreaterThanOrEqual(trunk.r + 0.4);
  // …and it was the trunk that stopped it: two seconds of walking would have carried it metres past.
  expect(Number(after['px'])).toBeGreaterThan(trunk.x);
});

// ------------------------------------------------------ 5: the canopy fade

test('5. a canopy over the pack thins, and never counts a holder it has not faded (E82)', async ({ page }) => {
  test.setTimeout(120_000);
  await settings(page);
  await land(page, '/?debug&scene=surface&planet=thessaly&quality=medium');
  await expect.poll(async () => (await sceneInfo(page))['treeSource'], COLD_START).toBe('glb');
  await press(page, 'surface-goto-grove');
  await expect.poll(() => info(page, 'groveR'), { timeout: 15_000 }).toBeGreaterThan(0);
  await afterFrames(page, 5);
  await press(page, 'surface-spawn-pack');
  const samples = await page.evaluate(
    () =>
      new Promise<{ faded: number; holders: number }[]>((resolve) => {
        const out: { faded: number; holders: number }[] = [];
        const timer = setInterval(() => {
          const info = window.__reallm.stats().sceneInfo ?? {};
          out.push({ faded: Number(info['canopyFaded'] ?? 0), holders: Number(info['canopyHolders'] ?? 0) });
          if (out.length >= 30) {
            clearInterval(timer);
            resolve(out);
          }
        }, 100);
      }),
  );
  expect(samples).toHaveLength(30);
  for (const sample of samples) expect(sample.faded, JSON.stringify(sample)).toBeGreaterThanOrEqual(sample.holders);
  expect(Math.max(...samples.map((sample) => sample.holders))).toBeGreaterThanOrEqual(1);
});

// ------------------------------------------------------------------ 6: low

test('6. on low the trees draw LOD1 and no cover is drawn', async ({ page }) => {
  await settings(page);
  await land(page, '/?debug&scene=surface&planet=thessaly&quality=low');
  await expect.poll(async () => (await sceneInfo(page))['treeSource'], COLD_START).toBe('glb');
  await press(page, 'surface-goto-grove');
  await afterFrames(page, 20);
  expect(await info(page, 'treeLod')).toBe(1);
  expect(await info(page, 'coverDrawn')).toBe(0);
});

// ----------------------------------------------------------------- 7: wind

test('7. the canopies sway, and stand still under reduce motion', async ({ page }) => {
  test.setTimeout(120_000);
  await settings(page);
  await land(page, '/?debug&scene=surface&planet=thessaly&quality=medium');
  await expect.poll(() => info(page, 'wind'), COLD_START).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await page.getByTestId('pause-settings').click();
  const toggle = page.getByTestId('settings-reduce-motion');
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.getByTestId('settings-close').click();
  await page.getByTestId('pause-resume').click();
  await expect(page.getByTestId('pause-menu')).toBeHidden();
  await expect.poll(() => info(page, 'wind'), { timeout: 15_000 }).toBe(0);
});

// ------------------------------------------------------- 8: every planet

const PLANET_IDS = ['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden'] as const;

for (const planet of PLANET_IDS) {
  test(`8. ${planet}: 30 frames after landing on medium, ≤ 60 k triangles and ≤ 96 draws`, async ({ page }) => {
    await start(page, `/?debug&scene=surface&planet=${planet}&quality=medium`);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
    await afterFrames(page, 30);
    const stats = await page.evaluate(() => window.__reallm.stats());
    expect(stats.triangles, `${planet}: SPEC-046 spawn ratchet`).toBeLessThanOrEqual(60_000);
    expect(stats.drawCalls).toBeLessThanOrEqual(96);
  });
}
