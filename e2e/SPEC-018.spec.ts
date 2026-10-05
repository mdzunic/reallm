// SPEC-018 QA regression — the boundary the berm + silhouette ring exist to
// hide (§4.9, AC-58, AC-59). The player's move is clamped to halfSize - 2
// (HeightField §4.2's apron starts there), so that clamp position is exactly
// where a human tester stands for the "no clear colour visible" sweep. This
// pins the clamp itself and that the frame is still full of drawn geometry at
// that position, on the two planets with the smallest and largest halfSize
// (Hive 160, Ferrum 200) so a future regression in the apron/clamp math on
// either extreme fails here instead of only in a manual pass.
//
// SPEC-053 §4.10: a cluster, a grove or an orchard can now stand on the 190 m
// line this case used to walk from the spawn — at the suite's seed the Hive's
// has a spire on it — so it starts from `surface-goto-edge` and pushes +x
// against the wall for 2 s instead. The clamp, the draws and the triangles it
// asserts there are the same.
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

/** A debug-strip button, clicked in the page (the strip may sit under the HUD). */
async function press(page: Page, id: string): Promise<void> {
  await page.evaluate((testId) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (button === null) throw new Error(`no ${testId} on the debug strip`);
    button.click();
  }, id);
}

/**
 * From `surface-goto-edge`, holds moveRight + moveDown together — a pure +x
 * walk (Surface.ts's vx=(move.x-move.y)·inv·speed) — into the wall for 2 s,
 * then reads where the clamp left the salvager.
 */
async function pushIntoPositiveXBoundary(page: Page, target: number): Promise<{ px: number; pz: number }> {
  // Pressed until it takes: the strip ignores a press while a beat holds the step.
  await expect
    .poll(
      async () => {
        await press(page, 'surface-goto-edge');
        return Number((await page.evaluate(() => window.__reallm.stats().sceneInfo))?.px);
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(target);
  await page.keyboard.down('KeyD');
  await page.keyboard.down('KeyS');
  try {
    await page.waitForTimeout(2_000);
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

    const { px } = await pushIntoPositiveXBoundary(page, halfSizeMinus2);
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
