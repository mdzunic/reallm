// SPEC-012's browser acceptance run: what only a composed scene can show.
// Layout determinism across a real reload (AC-74), the pad terminal as the
// accept/return surface with a press-toggle that stays deterministic across
// repeated presses (§4.11 — the round-2 review's double-fire regression), a
// mission accepted and progressed end to end, the station round trip keeping
// mission state (AC-50, AC-51), and the HUD/minimap wiring (AC-55.., AC-60..).
// The systems themselves are pinned in node (`tests/systems/`); the five-
// mission campaign walk on desktop and phone is the §7 playtest.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const CREATION = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

/** Create (or reload) the slot-0 save and land on Cinder-4 through the bridge. */
async function land(page: Page, opts: { fresh: boolean }): Promise<void> {
  await start(page, '/?debug&seed=123');
  await page.evaluate(
    ({ creation, fresh }) => {
      const save = window.__reallm.save();
      if (fresh) save.create(0, creation, 123);
      else save.load(0);
    },
    { creation: CREATION, fresh: opts.fresh },
  );
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: true }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
}

test('the layout is identical across reloads, and follows the seed (AC-1, AC-74)', async ({ page }) => {
  await land(page, { fresh: true });
  const first = Number((await info(page))['layoutHash']);
  expect(Number.isFinite(first)).toBe(true);

  // A real reload: same save, same seed, same hash.
  await land(page, { fresh: false });
  expect(Number((await info(page))['layoutHash'])).toBe(first);

  // A different seed is a different world.
  await start(page, '/?debug&seed=124');
  await page.evaluate((creation) => void window.__reallm.save().create(1, creation, 124), CREATION);
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: true }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  expect(Number((await info(page))['layoutHash'])).not.toBe(first);
});

test('the HUD and minimap mount with the scene (AC-55, AC-60..AC-70)', async ({ page }) => {
  await land(page, { fresh: true });

  // The shared HUD's readouts (§4.12): HP at the landing heal, level, tokens,
  // the four resource counters, and the minimap canvas at its §4.12 backing
  // resolution — 160 px, 1 px = 1 m.
  await expect(page.locator('[data-testid="hud-hp"]')).toContainText('184/184');
  // The oil counter shows the save's real balance (a fresh save starts stocked).
  const oil = await page.evaluate(() => window.__reallm.save().current?.resources['oil'] ?? -1);
  await expect(page.locator('[data-testid="res-oil"]')).toHaveText(String(oil));
  const minimap = page.locator('[data-testid="minimap"]');
  await expect(minimap).toHaveCount(1);
  expect(await minimap.evaluate((el) => [(el as HTMLCanvasElement).width, (el as HTMLCanvasElement).height])).toEqual([
    160, 160,
  ]);
});

test('the pad terminal toggles deterministically, accepts a mission, and the round trip keeps it (AC-50, AC-51)', async ({ page }) => {
  await land(page, { fresh: true });

  // Onto the pad: the interact prompt appears, and E opens the terminal.
  await page.locator('[data-testid="surface-goto-pad"]').click();
  const terminal = page.locator('[data-testid="pad-terminal"]');
  await page.keyboard.press('KeyE');
  await expect(terminal).toBeVisible();

  // §4.11 + the PressEdges contract: each further press flips it exactly once
  // — no frame shape may swallow the open or bounce it straight closed.
  await page.keyboard.press('KeyE');
  await expect(terminal).toBeHidden();
  await page.keyboard.press('KeyE');
  await expect(terminal).toBeVisible();

  // Accept c1_m1. Its stage 0 is "reach landing_pad" — the player is standing
  // on the pad, so the stage completes without a walk-out-and-back.
  await page.locator('[data-testid="terminal-accept-c1_m1"]').click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const active = window.__reallm.save().current?.progress.missionsActive ?? [];
        return active.find((m) => m.id === 'c1_m1')?.stage ?? -1;
      }),
    )
    .toBe(1);

  // The pinned objective line moved on to stage 1's scan (AC-65).
  await expect(page.locator('[data-testid="hud"] .hud-objective')).toContainText('Scan');

  // §4.11: Return to ship saves and lands in the station.
  await page.locator('[data-testid="terminal-return"]').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  expect(
    await page.evaluate(() => {
      const save = window.__reallm.save().current;
      return save === null ? null : { location: save.progress.location, planet: save.progress.currentPlanet };
    }),
  ).toEqual({ location: 'station', planet: null });

  // E18/E19: the mission survives the round trip with its counters. The go()
  // waits for the station's entry fade — a transition in flight refuses it.
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
  expect(
    await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true })),
  ).toBe(true);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  expect(
    await page.evaluate(() => {
      const active = window.__reallm.save().current?.progress.missionsActive ?? [];
      return active.find((m) => m.id === 'c1_m1')?.stage ?? -1;
    }),
  ).toBe(1);
  await expect(page.locator('[data-testid="hud"] .hud-objective')).toContainText('Scan');
});

test('death shows SIGNAL LOST with the loss, and respawns at the pad with full HP (AC-45..AC-47)', async ({ page }) => {
  await land(page, { fresh: true });

  // Some cargo to lose (normal difficulty loses a fraction on death).
  await page.locator('[data-testid="surface-goto-pad"]').click();
  const before = await info(page);

  for (let i = 0; i < 4; i++) {
    await page.locator('[data-testid="surface-hurt"]').click();
    await page.waitForTimeout(400);
  }
  await expect(page.locator('[data-testid="death-overlay"]')).toBeVisible();
  await expect(page.locator('[data-testid="death-overlay"]')).toContainText('SIGNAL LOST');

  // §4.8: back up at the spawn point, full HP.
  await expect(page.locator('[data-testid="death-overlay"]')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('[data-testid="hud-hp"]')).toContainText('184/184');
  const after = await info(page);
  // Respawn is at `playerSpawn`, not wherever the pilot died (the pad here).
  expect([after['px'], after['pz']]).not.toEqual([before['px'], before['pz']]);
});
