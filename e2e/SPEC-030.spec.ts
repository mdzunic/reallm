// SPEC-030's browser acceptance run (§6.2): shelters placed, the sheltered
// and hidden chip, a forced storm doing nothing inside a shelter, the edge
// walk against the wall, and the budget sweep (which lives in
// e2e/surface-env.spec.ts per D-17). The rules themselves are pinned in node;
// this is the composed wiring on `?scene=surface&planet=cinder4&debug`.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const URL = '/?debug&scene=surface&planet=cinder4&seed=123';

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

async function settle(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
}

/** The player's current HP, off the HUD bar's `value/max` text. */
async function hp(page: Page): Promise<number> {
  const text = (await page.locator('[data-testid="hud-hp"]').textContent()) ?? '';
  return Number(/(\d+)\s*\//.exec(text)?.[1] ?? -1);
}

test('shelters are placed: the debug count reads ≥ 2 (§6.2 case 1)', async ({ page }) => {
  await start(page, URL);
  await settle(page);
  expect(Number((await info(page))['shelters'])).toBeGreaterThanOrEqual(2);
});

test('goto-shelter shows the chip; holding fire turns it HIDDEN (§6.2 case 2)', async ({ page }) => {
  await start(page, URL);
  await settle(page);

  // Before entering: the chip is in the DOM and hidden (D-11).
  await expect(page.getByTestId('sheltered')).toBeAttached();
  await expect(page.getByTestId('sheltered')).toBeHidden();

  await page.getByTestId('surface-goto-shelter').click();
  await expect(page.getByTestId('sheltered')).toBeVisible();
  await expect.poll(async () => (await info(page))['sheltered']).toBe(1);
  // 2 s without firing: the trail is cold and the chip reads HIDDEN.
  await expect.poll(async () => (await info(page))['hidden'], { timeout: 10_000 }).toBe(1);
  await expect(page.getByTestId('sheltered')).toContainText('HIDDEN');
});

test('a forced storm does nothing inside a shelter and bites outside (§6.2 case 3)', async ({ page }) => {
  await start(page, URL);
  await settle(page);

  await page.getByTestId('surface-goto-shelter').click();
  // D-18: clear the neighbourhood so the HP reading is about the weather.
  await page.getByTestId('surface-smite').click();
  await page.getByTestId('surface-storm').click();
  // Cinder-4's highest-dps cycle storm is the heatwave (D-15).
  await expect(page.locator('.hud-weather')).toContainText('Heatwave');

  const before = await hp(page);
  expect(before).toBeGreaterThan(0);
  await page.waitForTimeout(3000);
  expect(await hp(page)).toBe(before);

  // Outside, the same storm drains HP within 4 s.
  await page.getByTestId('surface-goto-pad').click();
  await expect
    .poll(async () => await hp(page), { timeout: 8_000 })
    .toBeLessThan(before);
});

/**
 * §4.9 (AC-41): the roof lift, asserted on the scene graph rather than on the
 * HUD. Seed 7 is the one thing this case needs from the layout — it puts a
 * *wreck* nearest the pad, so `surface-goto-shelter` lands inside a hull
 * rather than a cave, and the wreck's dome is the part two QA rounds caught
 * occluding the player. Nothing in the DOM reports the lift, so the roof
 * instance is read straight off `InstancedMesh.instanceMatrix`.
 */
const WRECK_URL = '/?debug&scene=surface&planet=cinder4&seed=7';

/** Where three hands a freshly constructed `Scene` to a devtools extension. */
interface SceneLike {
  traverse(visit: (object: Record<string, unknown>) => void): void;
}

/**
 * The world position of every instance in the scene whose uniform scale has
 * been collapsed to ~0 — i.e. every lifted shelter roof. Nothing else in the
 * surface scene parks an instance at zero scale (an unused pool slot sits
 * outside `count`), so the list is exactly the lifted roofs.
 */
async function liftedRoofs(page: Page): Promise<Array<{ x: number; z: number }>> {
  return await page.evaluate(() => {
    const scenes = (window as unknown as { __spec030Scenes?: SceneLike[] }).__spec030Scenes ?? [];
    const lifted: Array<{ x: number; z: number }> = [];
    for (const scene of scenes) {
      scene.traverse((object) => {
        if (object['isInstancedMesh'] !== true) return;
        const count = object['count'] as number;
        const matrix = (object['instanceMatrix'] as { array: ArrayLike<number> }).array;
        for (let i = 0; i < count; i++) {
          const at = i * 16;
          const scale = Math.hypot(matrix[at] as number, matrix[at + 1] as number, matrix[at + 2] as number);
          if (scale < 0.01) lifted.push({ x: matrix[at + 12] as number, z: matrix[at + 14] as number });
        }
      });
    }
    return lifted;
  });
}

/** Collects the scenes three constructs, before any module has run. */
async function captureScenes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scenes: unknown[] = [];
    (window as unknown as { __spec030Scenes: unknown[] }).__spec030Scenes = scenes;
    (window as unknown as { __THREE_DEVTOOLS__: { dispatchEvent(event: Event): void } }).__THREE_DEVTOOLS__ = {
      dispatchEvent: (event: Event) => {
        const detail = (event as CustomEvent<{ type?: string }>).detail;
        if (detail?.type === 'Scene') scenes.push(detail);
      },
    };
  });
}

test('entering a wreck lifts exactly that roof instance, and leaving restores it (AC-41)', async ({ page }) => {
  await captureScenes(page);
  await start(page, WRECK_URL);
  await settle(page);
  // Unoccupied: every roof stands.
  await expect.poll(async () => (await liftedRoofs(page)).length).toBe(0);

  await page.getByTestId('surface-goto-shelter').click();
  await expect.poll(async () => (await info(page))['sheltered']).toBe(1);
  await expect.poll(async () => (await liftedRoofs(page)).length).toBe(1);

  // The lifted roof is the one the player is standing in, not another shelter's.
  const [lifted] = await liftedRoofs(page);
  const at = await info(page);
  expect(lifted).toBeDefined();
  expect(Math.hypot((lifted?.x ?? 0) - Number(at['px']), (lifted?.z ?? 0) - Number(at['pz']))).toBeLessThan(1);

  // Leaving puts it back (D-9: the previously occupied roof is restored).
  await page.getByTestId('surface-goto-pad').click();
  await expect.poll(async () => (await info(page))['sheltered']).toBe(0);
  await expect.poll(async () => (await liftedRoofs(page)).length).toBe(0);
});

test('the edge stops the player and the wall is on screen (§6.2 case 4)', async ({ page }) => {
  await start(page, URL);
  await settle(page);

  await page.getByTestId('surface-goto-edge').click();
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(1000);
  await page.keyboard.up('KeyD');
  // halfSize 180: the clamp line is ±(180 − 2).
  expect(Number((await info(page))['px'])).toBeLessThanOrEqual(178.01);
  expect(Number((await info(page))['wallVisible'])).toBeGreaterThanOrEqual(1);
});
