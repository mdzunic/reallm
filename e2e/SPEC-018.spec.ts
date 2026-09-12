// SPEC-018 QA regression — the boundary the berm + silhouette ring exist to
// hide (§4.9, AC-58, AC-59). The player's move is clamped to halfSize - 2
// (HeightField §4.2's apron starts there), so that clamp position is exactly
// where a human tester stands for the "no clear colour visible" sweep. This
// pins the clamp itself and that the frame is still full of drawn geometry at
// that position, on the two planets with the smallest and largest halfSize
// (Hive 160, Ferrum 200) so a future regression in the apron/clamp math on
// either extreme fails here instead of only in a manual pass.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

interface Clamp {
  readonly planet: string;
  readonly halfSizeMinus2: number;
}

const PLANETS: readonly Clamp[] = [
  { planet: 'hive', halfSizeMinus2: 158 },
  { planet: 'ferrum', halfSizeMinus2: 198 },
];

/** Holds moveRight + moveDown together, which cancels to a pure +x walk (Surface.ts's vx=(move.x-move.y)·inv·speed). */
async function walkToPositiveXBoundary(page: Page, target: number): Promise<{ px: number; pz: number }> {
  await page.keyboard.down('KeyD');
  await page.keyboard.down('KeyS');
  try {
    // Wall-clock speed only holds when the fixed-step loop keeps up with real
    // time; under a full parallel `npm run e2e` run this suite shares five
    // workers with the software-GL-heaviest files in the repo (SPEC-006's
    // audio ramps, SPEC-011's spawn load), and the loop's five-steps-per-frame
    // ceiling means simulated time can fall tens of seconds behind wall clock
    // (`docs/playtest-log.md`, SPEC-017 — this is the same class of
    // contention flake already tracked there, not a bug in the clamp). 150 s
    // covers a 198 m walk at 6 m/s even with ~30 s of dropped time.
    await expect
      .poll(async () => (await page.evaluate(() => window.__reallm.stats().sceneInfo))?.px, { timeout: 150_000, intervals: [1000] })
      .toBeGreaterThanOrEqual(target);
  } finally {
    await page.keyboard.up('KeyD');
    await page.keyboard.up('KeyS');
  }
  // Let the clamp settle for a couple of frames once the keys are up.
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => window.__reallm.stats().sceneInfo);
  return { px: Number(info?.px ?? 0), pz: Number(info?.pz ?? 0) };
}

for (const { planet, halfSizeMinus2 } of PLANETS) {
  test(`${planet}: the player clamps at halfSize - 2 and the frame still draws real geometry there (AC-59)`, async ({ page }) => {
    test.setTimeout(180_000);
    await start(page, `/?debug&scene=surface&planet=${planet}&quality=low`);

    const { px } = await walkToPositiveXBoundary(page, halfSizeMinus2);
    // The clamp is exact (±0.5 m for the last frame's step before the poll saw it).
    expect(px).toBeGreaterThanOrEqual(halfSizeMinus2);
    expect(px).toBeLessThan(halfSizeMinus2 + 1);

    // Standing at the clamp is not standing in an empty frame: the berm, the
    // silhouette ring and the terrain tiles beyond the player are still being
    // drawn. A regression that stopped generating boundary geometry out there
    // (or that let the player walk past it into the clear-colour void) would
    // collapse this to a near-zero, "nothing but the player capsule" frame.
    const stats = await page.evaluate(() => window.__reallm.stats());
    expect(stats.drawCalls).toBeGreaterThan(15);
    expect(stats.triangles).toBeGreaterThan(5_000);
  });
}
