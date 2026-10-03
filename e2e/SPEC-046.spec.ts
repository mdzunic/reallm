// SPEC-046 §6.2 — props that look like their art, and only what is on screen,
// in a real browser: the culled layers draw a few hundred of a planet's
// thousand-odd static instances and follow the camera, both variants stay
// inside the draw budget, the tug stands on every pad and stops the salvager
// at its hull with the terminal still in reach, and `medium` renders sharp on
// a 3× screen until the governor steps it back.
//
// The rules themselves are pinned in node — `tests/views/instanceCuller.test.ts`
// (the rect, the margin, the grid, the compaction), `tests/views/surfaceView.test.ts`
// (variants, materials, fades through the masters, the tug),
// `tests/systems/layout.test.ts` (`tugObstacle`), `tests/core/quality.test.ts`
// (`effectiveMaxDpr`). §6.2 case 7, the spawn ratchet, lives in
// `e2e/surface-env.spec.ts` with the other medium budgets.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, start } from './start';

const PLANET_IDS = ['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden'] as const;

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

/**
 * Click through any open dialogue, as the other surface suites do. A beat can
 * close itself between the visibility read and the click — that is the loop
 * ending, not an error.
 */
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

async function land(page: Page, url: string): Promise<void> {
  await start(page, url);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await dismiss(page);
}

// ------------------------------------------------------------------- 1: culled

test('1. Thessaly draws a few hundred of its static instances, and says what the cull cost', async ({ page }) => {
  await land(page, '/?debug&scene=surface&planet=thessaly&quality=medium');
  await afterFrames(page, 30);
  const drawn = await info(page, 'instancesDrawn');
  // The planet holds 1,130 static instances — the scatter, the ring, the props,
  // the shelters; the rig sees a few percent of the arena.
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan(300);
  const cullMs = await info(page, 'cullMs');
  expect(Number.isFinite(cullMs)).toBe(true);
  expect(cullMs).toBeGreaterThanOrEqual(0);
});

// --------------------------------------------------------- 2, 3: moving, variants

test('2–3. on Cinder-4 the drawn set follows the camera, the fade still works, and both variants fit 96 draws', async ({ page }) => {
  test.setTimeout(120_000);
  // A fixed session seed, so the occluder the shortcut finds is the same one.
  await land(page, '/?debug&scene=surface&planet=cinder4&quality=medium&seed=123');
  // Case 3 measures with the models in: both variants of each kind drawing.
  await expect.poll(async () => (await sceneInfo(page))['propSource'], COLD_START).toBe('glb');
  await afterFrames(page, 30);
  const atSpawn = await info(page, 'instancesDrawn');
  expect(atSpawn).toBeGreaterThan(0);
  expect((await page.evaluate(() => window.__reallm.stats())).drawCalls).toBeLessThanOrEqual(96);

  await press(page, 'surface-goto-occluder');
  // Case 2: the camera moved, so the culled layers drew another set…
  await expect.poll(() => info(page, 'instancesDrawn'), { timeout: 15_000 }).not.toBe(atSpawn);
  // …and SPEC-035's fade still reaches the prop in the way.
  await expect.poll(() => info(page, 'occluders'), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await afterFrames(page, 30);
  expect((await page.evaluate(() => window.__reallm.stats())).drawCalls).toBeLessThanOrEqual(96);
});

// --------------------------------------------------------------------- 4: tug

/** The eight walks the keys give, as world directions (Surface's camera-relative mapping). */
const WALKS: ReadonlyArray<{ keys: readonly string[]; x: number; z: number }> = [
  { keys: ['KeyW'], x: -Math.SQRT1_2, z: -Math.SQRT1_2 },
  { keys: ['KeyS'], x: Math.SQRT1_2, z: Math.SQRT1_2 },
  { keys: ['KeyD'], x: Math.SQRT1_2, z: -Math.SQRT1_2 },
  { keys: ['KeyA'], x: -Math.SQRT1_2, z: Math.SQRT1_2 },
  { keys: ['KeyW', 'KeyD'], x: 0, z: -1 },
  { keys: ['KeyW', 'KeyA'], x: -1, z: 0 },
  { keys: ['KeyS', 'KeyD'], x: 1, z: 0 },
  { keys: ['KeyS', 'KeyA'], x: 0, z: 1 },
];

/**
 * Hold a walk toward the pad's centre (the origin) for `ms`, re-aimed every
 * tenth of a second with whichever of the eight key walks points closest.
 */
async function walkToPad(page: Page, ms: number): Promise<void> {
  const held = new Set<string>();
  const until = Date.now() + ms;
  try {
    while (Date.now() < until) {
      const at = await sceneInfo(page);
      const px = Number(at['px'] ?? 0);
      const pz = Number(at['pz'] ?? 0);
      const length = Math.hypot(px, pz);
      let best = WALKS[0] as (typeof WALKS)[number];
      let bestDot = -Infinity;
      for (const walk of WALKS) {
        const dot = length > 1e-6 ? (-px * walk.x - pz * walk.z) / length : 0;
        if (dot > bestDot) {
          bestDot = dot;
          best = walk;
        }
      }
      for (const key of [...held]) {
        if (best.keys.includes(key)) continue;
        await page.keyboard.up(key);
        held.delete(key);
      }
      for (const key of best.keys) {
        if (held.has(key)) continue;
        await page.keyboard.down(key);
        held.add(key);
      }
      await page.waitForTimeout(100);
    }
  } finally {
    for (const key of held) await page.keyboard.up(key);
  }
}

for (const planet of PLANET_IDS) {
  test(`4. ${planet}: the tug stands on the pad and stops a walk at its hull, with the terminal in reach`, async ({ page }) => {
    test.setTimeout(120_000);
    // Nothing fires while the salvager walks: the walk is the measurement.
    await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off' })));
    await land(page, `/?debug&scene=surface&planet=${planet}&quality=medium`);
    await expect.poll(() => info(page, 'tug'), COLD_START).toBe(1);
    const spawn = await sceneInfo(page);
    expect(Math.hypot(Number(spawn['px']), Number(spawn['pz']))).toBeGreaterThan(10); // 12 m out

    await walkToPad(page, 4_000);
    await page.waitForTimeout(200);
    const at = await sceneInfo(page);
    const distance = Math.hypot(Number(at['px']), Number(at['pz']));
    // Stopped at the 3.5 m hull plus the salvager's half metre — not on the pad's centre.
    expect(distance, `${planet}: ${distance.toFixed(2)} m from the pad`).toBeGreaterThanOrEqual(3.9);
    expect(distance, `${planet}: ${distance.toFixed(2)} m from the pad`).toBeLessThanOrEqual(6);
    await expect(page.getByTestId('hud-interact')).toContainText('Open pad terminal', { timeout: 10_000 });
  });
}

// ---------------------------------------------------------------- 5: goto pad

test('5. surface-goto-pad stands the salvager 5 m out, clear of the hull, and E opens the terminal', async ({ page }) => {
  await land(page, '/?debug&scene=surface&planet=cinder4');
  await press(page, 'surface-goto-pad');
  await expect.poll(async () => {
    const at = await sceneInfo(page);
    return Math.round(Math.hypot(Number(at['px']), Number(at['pz'])) * 10) / 10;
  }).toBe(5);
  const terminal = page.getByTestId('pad-terminal');
  for (let i = 0; i < 6 && !(await terminal.isVisible()); i++) {
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(400);
  }
  await expect(terminal).toBeVisible();
});

// ------------------------------------------------------------------- 6: sharp

test.describe('sharp rendering (§4.7)', () => {
  // A 3× phone's ratio. The canvas is small for the reason SPEC-040's governor
  // cases give: on a CPU rasteriser a large 2× frame alone outlasts the loop's
  // 250 ms frame cap, which the governor's clock cannot see past.
  test.use({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 3 });

  test('6. medium renders at 1.5, at 2 with Sharp rendering, and the governor steps it back under load', async ({ page }) => {
    test.setTimeout(150_000);
    await land(page, '/?scene=surface&planet=cinder4&quality=medium');
    const stats = (): Promise<{ dpr: number; deviceDpr: number; preset: string }> =>
      page.evaluate(() => {
        const s = window.__reallm.stats();
        return { dpr: s.dpr, deviceDpr: s.deviceDpr, preset: s.preset };
      });
    expect(await stats()).toMatchObject({ dpr: 1.5, deviceDpr: 3, preset: 'medium' });

    await page.keyboard.press('Escape');
    await page.getByTestId('pause-settings').click();
    const sharp = page.getByTestId('settings-sharp-render');
    await expect(sharp).not.toBeChecked();
    await sharp.click();
    await expect(sharp).toBeChecked();
    await expect.poll(async () => (await stats()).dpr).toBe(2);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('reallm:settings') ?? '{}') as Record<string, unknown>);
    expect(stored['sharpRender']).toBe(true);
    await page.getByTestId('settings-close').click();
    await page.getByTestId('pause-resume').click();
    await expect(page.getByTestId('pause-menu')).toBeHidden();

    // SPEC-040's governor: the dpr rung first, 2 → 1.75, within 30 s.
    await page.evaluate(() => window.__reallm.slowDraw(40));
    const loadedAt = Date.now();
    await expect.poll(async () => (await stats()).dpr, { timeout: 30_000, intervals: [500] }).toBeLessThan(2);
    expect(Date.now() - loadedAt).toBeLessThanOrEqual(30_000);
    expect((await stats()).preset).toBe('medium');
  });
});
