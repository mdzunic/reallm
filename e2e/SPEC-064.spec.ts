// SPEC-064 §6.3 — Cinder-4's raiders in the salvager's suit, in the browser.
// Six spawned raiders are skinned and the medium frame stays inside 96 draws
// and 130 k triangles; smitten, they fall, and are gone within two seconds,
// the budget holding throughout; their shots are drawn as amber tracers; and
// without the salvager model every raider is the procedural stand-in. Case 5,
// the existing pins, is `surface-env.spec.ts`'s spawn-heavy case and
// `SPEC-048.spec.ts`'s case 8b, which this spec leaves unmoved.
//
// Times are read on `sceneInfo.viewTime`, the clock the raiders' mixers run on.
// A GPU-less container draws a medium frame in 60–140 ms, so the simulation
// trails the wall clock (`e2e/start.ts`): "within 0.5 s" is the game's half
// second, not the host's.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const URL = '/?scene=surface&planet=cinder4&debug&quality=medium';

/**
 * At least `scav_raider`'s `maxAlive` on Cinder-4 (4): with that many raiders
 * up, the director adds none of its own, so the counts below are exact.
 */
const RAIDERS = 6;

interface Raiders {
  live: number;
  falling: number;
  standIn: number;
  tracers: number;
}

interface Sample extends Raiders {
  frame: number;
  viewTime: number;
  drawCalls: number;
  triangles: number;
}

test.beforeEach(async ({ page }) => {
  // SPEC-040 §4.3: on a GPU-less host the governor would step the session down
  // to `low`, and the budget is `medium`'s. SPEC-038 §4.9: auto-fire would
  // shoot the raiders this suite counts.
  await page.addInitScript(() =>
    localStorage.setItem('reallm:settings', JSON.stringify({ adaptiveQuality: false, autoFire: 'off' })),
  );
});

/** `sceneInfo.scavRaiders`, parsed, and the view clock. */
async function raiders(page: Page): Promise<Raiders & { viewTime: number }> {
  return page.evaluate(() => {
    const info = window.__reallm.stats().sceneInfo ?? {};
    const counts = JSON.parse(String(info['scavRaiders'] ?? 'null')) as Raiders | null;
    if (counts === null) throw new Error('sceneInfo has no scavRaiders');
    return { ...counts, viewTime: Number(info['viewTime'] ?? 0) };
  });
}

/**
 * Clears the field with `surface-smite`, then presses `surface-spawn-raider`
 * `count` times — all in one task, so no step of the simulation runs between
 * the presses and the raiders spawned are the only ones alive. A press is a
 * click in the page: the strip is a travel compressor here, and an actionable
 * click waits for stable frames a GPU-less run hands out a few a second.
 */
async function clearAndSpawn(page: Page, count: number): Promise<void> {
  await page.evaluate((n) => {
    const press = (id: string): void => {
      const button = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
      if (button === null) throw new Error(`the debug strip has no ${id} button`);
      button.click();
    };
    for (let i = 0; i < 64; i++) press('surface-smite');
    for (let i = 0; i < n; i++) press('surface-spawn-raider');
  }, count);
}

/**
 * Every rendered frame, read in the page as it lands, until `viewSeconds` of
 * the view clock have passed — after Smite has been pressed `smites` times
 * first. A round trip per frame would wait out a draw each on a loaded run.
 */
async function sampleFrames(page: Page, viewSeconds: number, smites = 0): Promise<{ before: Sample; samples: Sample[] }> {
  return page.evaluate(
    ({ seconds, presses }) =>
      new Promise<{ before: Sample; samples: Sample[] }>((resolve) => {
        const read = (): Sample => {
          const stats = window.__reallm.stats();
          const info = stats.sceneInfo ?? {};
          const counts = JSON.parse(String(info['scavRaiders'] ?? 'null')) as Raiders;
          return {
            ...counts,
            frame: stats.frame,
            viewTime: Number(info['viewTime'] ?? 0),
            drawCalls: stats.drawCalls,
            triangles: stats.triangles,
          };
        };
        const before = read();
        for (let i = 0; i < presses; i++) document.querySelector<HTMLButtonElement>('[data-testid="surface-smite"]')?.click();
        const samples: Sample[] = [];
        let seen = before.frame;
        const sample = (): void => {
          const now = read();
          if (now.frame !== seen) {
            seen = now.frame;
            samples.push(now);
          }
          if (samples.length > 0 && now.viewTime - before.viewTime >= seconds) resolve({ before, samples });
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    { seconds: viewSeconds, presses: smites },
  );
}

// -------------------------------------------------------------- 1: they render

test('1. six raiders render skinned, and the medium frame stays within 96 draws and 130 k triangles', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, URL);
  await clearAndSpawn(page, RAIDERS);
  await expect.poll(async () => (await raiders(page)).live, { timeout: 30_000 }).toBe(6);
  expect((await raiders(page)).standIn).toBe(0);
  const { samples } = await sampleFrames(page, 0.75);
  expect(samples.length).toBeGreaterThan(0);
  for (const sample of samples) {
    expect(sample.live).toBe(6);
    expect(sample.drawCalls).toBeLessThanOrEqual(96); // 80 scene + 16 post
    expect(sample.triangles).toBeLessThanOrEqual(130_000);
  }
  const stats = await page.evaluate(() => window.__reallm.stats());
  expect(stats.preset).toBe('medium');
  expect(stats.drawCalls).toBeGreaterThan(10); // the surface actually drew
});

// ---------------------------------------------------------------- 2: they fall

test('2. smitten, they fall: falling reads the number killed within 0.5 s and 0 by 2 s, inside the budget throughout', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await start(page, URL);
  await clearAndSpawn(page, RAIDERS);
  await expect.poll(async () => (await raiders(page)).live, { timeout: 30_000 }).toBe(6);
  // Any raider the clear smote is still falling; let those copies go first.
  await expect.poll(async () => (await raiders(page)).falling, { timeout: 30_000 }).toBe(0);

  const { before, samples } = await sampleFrames(page, 2.5, RAIDERS);
  expect(before.live).toBe(6);
  const first = samples[0] as Sample;
  // Smite takes the nearest enemy; the raiders stand 8 m out, so they are it.
  const killed = before.live + before.standIn - (first.live + first.standIn);
  expect(killed).toBeGreaterThan(0);
  expect(killed).toBeLessThanOrEqual(8);
  const early = samples.filter((sample) => sample.viewTime - before.viewTime <= 0.5);
  expect(early.length).toBeGreaterThan(0);
  expect(early.some((sample) => sample.falling === killed)).toBe(true);
  const late = samples.filter((sample) => sample.viewTime - before.viewTime >= 2);
  expect(late.length).toBeGreaterThan(0);
  for (const sample of late) expect(sample.falling).toBe(0);
  for (const sample of samples) {
    expect(sample.live + sample.falling).toBeLessThanOrEqual(8);
    expect(sample.drawCalls).toBeLessThanOrEqual(96); // 80 scene + 16 post
    expect(sample.triangles).toBeLessThanOrEqual(130_000);
  }
});

// ----------------------------------------------------------- 3: amber tracers

test('3. with raiders in range and the salvager standing still, tracers rise above 0 within 5 s', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, URL);
  await clearAndSpawn(page, RAIDERS);
  await expect.poll(async () => (await raiders(page)).live, { timeout: 30_000 }).toBe(6);
  const from = (await raiders(page)).viewTime;
  // The wall-clock budget is generous; the 5 s is measured on the view clock.
  await expect.poll(async () => (await raiders(page)).tracers, { timeout: 60_000, intervals: [50] }).toBeGreaterThan(0);
  expect((await raiders(page)).viewTime - from).toBeLessThanOrEqual(5);
});

// --------------------------------------------------------------- 4: no model

test('4. without the salvager model every raider is the stand-in, and none is skinned (E113)', async ({ page }) => {
  test.setTimeout(150_000);
  // An aborted request would hold the boot on its Retry panel — the boot set is
  // all or nothing (SPEC-003 D-30) — so the block answers with a model that is
  // not the salvager: the crate, with no skin and no clips. The surface still
  // comes up, and the raider view has nothing it could skin.
  let served = false;
  await page.route('**/models/character.glb', async (route) => {
    served = true;
    await route.fulfill({ path: 'public/assets/models/crate.glb', contentType: 'model/gltf-binary' });
  });
  await start(page, URL);
  expect(served).toBe(true);
  await clearAndSpawn(page, RAIDERS);
  await expect.poll(async () => (await raiders(page)).standIn, { timeout: 30_000 }).toBe(RAIDERS);
  const counts = await raiders(page);
  expect(counts.live).toBe(0);
  expect(counts.falling).toBe(0);
});
