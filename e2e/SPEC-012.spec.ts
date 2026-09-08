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

/** Steer toward the nearest enemy by `nearDx/nearDz` (the SPEC-011 pattern). */
async function hunt(page: Page, seconds: number, done: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (await done()) return;
    const s = await info(page);
    const dx = Number(s['nearDx'] ?? 0);
    const dz = Number(s['nearDz'] ?? 0);
    const key = dx >= 0 ? (dz >= 0 ? 'KeyS' : 'KeyD') : (dz >= 0 ? 'KeyA' : 'KeyW');
    await page.keyboard.down(key);
    await page.waitForTimeout(600);
    await page.keyboard.up(key);
    await page.waitForTimeout(200);
  }
}

test('mouse aim projects onto the ground plane (AC-10)', async ({ page }) => {
  await land(page, { fresh: true });
  const vp = page.viewportSize() as { width: number; height: number };
  const cx = vp.width / 2;
  const cy = vp.height / 2;

  // Standing still, the screen centre IS the camera's ground look-at — the
  // player. The projection must land on the pilot, not merely near them.
  await page.mouse.move(cx, cy);
  await expect
    .poll(async () => {
      const s = await info(page);
      return Math.hypot(Number(s['aimX']) - Number(s['px']), Number(s['aimZ']) - Number(s['pz']));
    })
    .toBeLessThan(2);

  // Screen-right at the fixed 45° yaw is world (+x, −z) in equal parts: the
  // centre row of the screen images the ground line parallel to camera-right.
  await page.mouse.move(cx + 250, cy);
  await expect
    .poll(async () => {
      const s = await info(page);
      const dx = Number(s['aimX']) - Number(s['px']);
      const dz = Number(s['aimZ']) - Number(s['pz']);
      return dx > 2 && dz < -2 && Math.abs(dx + dz) < 0.5;
    })
    .toBe(true);
});

test('a full hold bounces the pickup with one throttled CARGO FULL toast (AC-19, AC-70)', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page, { fresh: true });

  // Every resource at its per-resource cap: any resource orb now blocks.
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) throw new Error('no save');
    for (const key of Object.keys(save.resources)) save.resources[key] = 9999;
  });

  // Walk onto a victim and smite it — loot scatters at the feet, magnetizes,
  // and the cap refuses it. The full path: Pickups → ui:toast → the shared rack.
  const rack = page.locator('[data-testid="toasts"]');
  const cargoFull = rack.locator('.toast', { hasText: 'CARGO FULL' });
  await expect.poll(async () => Number((await info(page))['enemies'] ?? 0), { timeout: 30_000 }).toBeGreaterThan(0);
  await hunt(page, 100, async () => {
    if ((await cargoFull.count()) > 0) return true;
    const s = await info(page);
    if (Math.hypot(Number(s['nearDx'] ?? 99), Number(s['nearDz'] ?? 99)) < 2.5) {
      await page.locator('[data-testid="surface-smite"]').click();
      await page.waitForTimeout(400);
    }
    return (await cargoFull.count()) > 0;
  });
  await expect(cargoFull.first()).toBeVisible();
  // AC-19: the blocked orb keeps knocking every frame, yet the throttle admits
  // one toast per 3 s — a single rack row right after the first appears.
  expect(await cargoFull.count()).toBe(1);
});

test('the minimap shows discovered POIs, objective marks, gated nodes and near enemies (AC-55..AC-59)', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page, { fresh: true });

  // AC-56: the pad is discovered on landing and sits inside the 160 m window.
  await expect.poll(async () => Number((await info(page))['mmPois'] ?? 0)).toBeGreaterThanOrEqual(1);
  // AC-58, the gate's closed half: a marine with no scanner drone sees no nodes.
  expect(Number((await info(page))['mmNodes'] ?? -1)).toBe(0);

  // AC-57: accepting c1_m1 pins its scan POI — a mark in-window or an edge
  // arrow beyond it.
  await page.locator('[data-testid="surface-goto-pad"]').click();
  await page.keyboard.press('KeyE');
  await expect(page.locator('[data-testid="pad-terminal"]')).toBeVisible();
  await page.locator('[data-testid="terminal-accept-c1_m1"]').click();
  await page.locator('[data-testid="terminal-close"]').click();
  await expect
    .poll(async () => {
      const s = await info(page);
      return Number(s['mmObjectives'] ?? 0) + Number(s['mmArrows'] ?? 0);
    })
    .toBeGreaterThanOrEqual(1);

  // AC-58, open half: a scanner drone at L2 turns the node layer on.
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) throw new Error('no save');
    save.companions.push({ id: 'scanner_drone', level: 2, enabled: true });
  });
  await expect.poll(async () => Number((await info(page))['mmNodes'] ?? 0), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

  // AC-59: enemies appear once within 25 m — walk at the nearest one.
  await expect.poll(async () => Number((await info(page))['enemies'] ?? 0), { timeout: 30_000 }).toBeGreaterThan(0);
  await hunt(page, 90, async () => {
    const s = await info(page);
    return Math.hypot(Number(s['nearDx'] ?? 99), Number(s['nearDz'] ?? 99)) < 18;
  });
  await expect.poll(async () => Number((await info(page))['mmEnemies'] ?? 0), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
});

test('death sweeps the pad ring and resets a live boss (AC-48, AC-49)', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page, { fresh: true });
  await page.locator('[data-testid="surface-goto-pad"]').click();

  // A live boss and at least one enemy inside the 40 m sweep.
  await page.locator('[data-testid="surface-spawn-boss"]').click();
  await expect.poll(async () => (await info(page))['boss']).not.toBe('-');
  await expect.poll(async () => Number((await info(page))['enemiesNearPad'] ?? 0), { timeout: 45_000 }).toBeGreaterThanOrEqual(1);

  for (let i = 0; i < 4; i++) {
    await page.locator('[data-testid="surface-hurt"]').click();
    await page.waitForTimeout(400);
  }
  await expect(page.locator('[data-testid="death-overlay"]')).toBeVisible();
  await expect(page.locator('[data-testid="death-overlay"]')).toBeHidden({ timeout: 10_000 });

  // §4.8 step 2, observed: the sweep removed what stood near the pad, and the
  // boss is gone without a defeat (silent despawn, arena torn down).
  const s = await info(page);
  expect(Number(s['despawnedAtDeath'])).toBeGreaterThanOrEqual(1);
  expect(s['boss']).toBe('-');
});

test('death restarts a timed survive stage (AC-49)', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page, { fresh: true });

  // Accept c1_m1 on the pad (reach completes standing there), then scan.
  await page.locator('[data-testid="surface-goto-pad"]').click();
  await page.keyboard.press('KeyE');
  await expect(page.locator('[data-testid="pad-terminal"]')).toBeVisible();
  await page.locator('[data-testid="terminal-accept-c1_m1"]').click();
  await page.locator('[data-testid="terminal-close"]').click();
  await dismissDialogues(page);
  await page.locator('[data-testid="surface-goto-objective"]').click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const active = window.__reallm.save().current?.progress.missionsActive ?? [];
        return active.find((m) => m.id === 'c1_m1')?.stage ?? -1;
      }),
      { timeout: 20_000 },
    )
    .toBe(2);

  // Let the survive timer run, then die: the stage must restart from zero.
  const survived = async (): Promise<number> => {
    const text = (await page.locator('[data-testid="hud"] .hud-objective').textContent()) ?? '';
    const match = /\((\d+)\/60\)/.exec(text);
    return match === null ? -1 : Number(match[1]);
  };
  await expect.poll(survived, { timeout: 30_000 }).toBeGreaterThanOrEqual(8);
  for (let i = 0; i < 4; i++) {
    await page.locator('[data-testid="surface-hurt"]').click();
    await page.waitForTimeout(400);
  }
  await expect(page.locator('[data-testid="death-overlay"]')).toBeVisible();
  await expect(page.locator('[data-testid="death-overlay"]')).toBeHidden({ timeout: 10_000 });
  const after = await survived();
  expect(after).toBeGreaterThanOrEqual(0);
  expect(after).toBeLessThanOrEqual(5);
});

/** Click through any open dialogue: first tap fills the line, the next advances. */
async function dismissDialogues(page: Page): Promise<void> {
  const dialogue = page.locator('[data-testid="dialogue"]');
  for (let i = 0; i < 40; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    await dialogue.click({ force: true });
    await page.waitForTimeout(120);
  }
}

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
