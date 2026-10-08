// SPEC-068 §6.3 — traps and helpers in the browser (PLAN R28). Every planet
// lands with its hazards counted in `sceneInfo.hazards`; on Cinder-4 a shot
// balanced rock falls on a pack and the kills are the player's, a fuel drum
// does the same, and the medium frame with helpers in view holds 96 draws and
// 130 k triangles; on Ferrum a lava vent erupts while the player stands near.
// The unit cases (tests/systems/hazards.test.ts) own the numbers; this suite
// proves the scene wires them: placement, the grid, the shot path, the kill
// credit, the view and the budget.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const surface = (planet: string): string => `/?scene=surface&planet=${planet}&debug&quality=medium`;

interface Counts {
  traps: number;
  helpers: number;
  spent: number;
  live: number;
  bursts: number;
  kills: number;
  drawCalls: number;
  triangles: number;
}

test.beforeEach(async ({ page }) => {
  // SPEC-040 §4.3: no governor stepping down to `low`; auto-fire would set
  // the helpers off on its own and shoot the pack the suite counts.
  await page.addInitScript(() =>
    localStorage.setItem('reallm:settings', JSON.stringify({ adaptiveQuality: false, autoFire: 'off' })),
  );
});

async function counts(page: Page): Promise<Counts> {
  return page.evaluate(() => {
    const stats = window.__reallm.stats();
    const info = stats.sceneInfo ?? {};
    const raw = String(info['hazards'] ?? '');
    const [traps, helpers, spent, live, bursts] = raw.split('/').map(Number);
    return {
      traps: traps ?? NaN,
      helpers: helpers ?? NaN,
      spent: spent ?? NaN,
      live: live ?? NaN,
      bursts: bursts ?? NaN,
      kills: Number(info['kills'] ?? 0),
      drawCalls: stats.drawCalls,
      triangles: stats.triangles,
    };
  });
}

/** Presses debug-strip buttons in one task, so no step runs between them. */
async function press(page: Page, ...ids: string[]): Promise<void> {
  await page.evaluate((list) => {
    for (const id of list) {
      const button = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
      if (button === null) throw new Error(`the debug strip has no ${id} button`);
      button.click();
    }
  }, ids);
}

test('1. every planet lands with a trap field and helpers (§4.1)', async ({ page }) => {
  test.setTimeout(240_000);
  for (const planet of ['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden']) {
    await start(page, surface(planet));
    const c = await counts(page);
    expect(c.traps, planet).toBeGreaterThan(0);
    expect(c.helpers, planet).toBeGreaterThan(0);
    expect(c.spent, planet).toBe(0);
  }
});

test('2. a shot balanced rock falls on the pack past it, and the kills are the player’s (§4.3, E128)', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, surface('cinder4'));
  for (let i = 0; i < 32; i++) await press(page, 'surface-smite');
  await press(page, 'surface-goto-topple');
  const before = await counts(page);
  await press(page, 'surface-hazard-pack', 'surface-hazard-fire');
  await expect.poll(async () => (await counts(page)).spent, { timeout: 30_000 }).toBeGreaterThan(before.spent);
  await expect.poll(async () => (await counts(page)).kills - before.kills, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
});

test('3. a shot fuel drum bursts on the pack beside it, and the frame holds its budget (§4.3, §4.7)', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, surface('cinder4'));
  for (let i = 0; i < 32; i++) await press(page, 'surface-smite');
  await press(page, 'surface-goto-volatile');
  // The helpers in frame, standing: the medium budget of SPEC-015 holds.
  for (let i = 0; i < 10; i++) {
    const c = await counts(page);
    expect(c.drawCalls).toBeLessThanOrEqual(96); // 80 scene + 16 post
    expect(c.triangles).toBeLessThanOrEqual(130_000);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  const before = await counts(page);
  await press(page, 'surface-hazard-pack', 'surface-hazard-fire');
  await expect.poll(async () => (await counts(page)).bursts, { timeout: 30_000 }).toBeGreaterThan(before.bursts);
  await expect.poll(async () => (await counts(page)).kills - before.kills, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  const after = await counts(page);
  expect(after.drawCalls).toBeLessThanOrEqual(96);
});

test('4. a lava vent erupts while the player stands near it (§4.2)', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, surface('ferrum'));
  await press(page, 'surface-goto-trap');
  const before = await counts(page);
  // A vent's cycle is 5–9 s plus 1.2 s of warning, on the game's clock.
  await expect.poll(async () => (await counts(page)).bursts, { timeout: 60_000 }).toBeGreaterThan(before.bursts);
});
