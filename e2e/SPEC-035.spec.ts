// SPEC-035 §6.2 — the first hour, in a real browser.
//
// What only a composed scene can show: the camera's distance by input scheme and
// the fog span that follows it, a prop fading out of the way of the salvager, the
// hit-direction wedge, the first landing's ramp, the three tips, the flight HUD's
// bars, the next-mission prompt, the sounds the guns finally make, and the seven
// screen fixes. The rules themselves are pinned in node —
// `tests/ui/helpers.test.ts`, `tests/systems/spawn.test.ts`, `weather.test.ts`,
// `combat.test.ts`, `tests/core/audio.test.ts`, `audioReactions.test.ts`,
// `tests/data/content.test.ts`, `tests/views/proceduralMeshes.test.ts`.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const SURFACE = '/?debug&scene=surface&planet=cinder4&seed=123';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

/**
 * Click through any open non-modal dialogue, as the other surface suites do.
 * A beat can close itself between the visibility read and the click, which
 * throws rather than failing the check — that is the loop ending, not an error.
 */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.locator('[data-testid="dialogue"]');
  // SPEC-037 §4.3: a non-modal line lets taps through; its `›` advances it.
  const advance = page.locator('[data-testid="dialogue-advance"]');
  for (let i = 0; i < 25; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(120);
  }
}

async function land(page: Page, url = SURFACE): Promise<void> {
  await start(page, url);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await dismiss(page);
}

/** A fresh save on slot 0, then a landing on Cinder-4 through the real route. */
async function landFresh(page: Page, url = '/?debug&seed=123'): Promise<void> {
  await start(page, url);
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: true }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
  await dismiss(page);
}

const press = (page: Page, id: string): Promise<void> => page.locator(`[data-testid="${id}"]`).click();

/** Every sprite Howler currently has a sound object for, live or spent. */
async function sprites(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const howler = (window as unknown as { Howler?: { _howls: Array<{ _sounds: Array<{ _sprite: string }> }> } }).Howler;
    if (howler === undefined) return [];
    return howler._howls.flatMap((howl) => howl._sounds.map((sound) => sound._sprite)).filter((name) => name !== '');
  });
}

// ------------------------------------------------------------------- 1, 2: camera

test('1, 2. the camera sits 22 m out on the keyboard scheme, and the fog starts there', async ({ page }) => {
  await land(page);
  const info = await sceneInfo(page);
  expect(Number(info['camDistance'])).toBeCloseTo(22, 1);
  // §6.2 case 2: the near plane is the camera's own distance, so nothing between
  // the camera and the salvager is ever hazed.
  expect(Math.abs(Number(info['fogNear']) - Number(info['camDistance']))).toBeLessThanOrEqual(0.5);
});

test.describe('1. the touch scheme brings the camera in', () => {
  test.use({ hasTouch: true, viewport: { width: 800, height: 420 } });

  test('camDistance eases from 22 to 17 once a finger has touched the canvas', async ({ page }) => {
    // SPEC-036 §4.13: a touchscreen laptop — touch-capable, but its primary
    // pointer is a mouse, so the page boots on the keyboard (SPEC-036 §4.2)
    // and the first finger is what flips it.
    await page.addInitScript(() => {
      const query = '(hover: none) and (pointer: coarse)';
      const original = window.matchMedia.bind(window);
      window.matchMedia = (asked: string): MediaQueryList => {
        const list = original(asked);
        if (asked !== query) return list;
        return new Proxy(list, {
          get: (target, key) => {
          if (key === 'matches') return false;
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
        });
      };
    });
    await landFresh(page);
    expect(Number((await sceneInfo(page))['camDistance'])).toBeCloseTo(22, 1);
    // A real touch point on the canvas is what flips the scheme; the touch
    // controls are not mounted until it has (SPEC-005 §4.1).
    await page.touchscreen.tap(160, 300);
    await expect.poll(async () => page.evaluate(() => window.__reallm.input().scheme), { timeout: 15_000 }).toBe('touch');
    await expect
      .poll(async () => Number((await sceneInfo(page))['camDistance']), { timeout: 15_000 })
      .toBeCloseTo(17, 1);
    // §4.4: the fog's near plane came with it.
    const info = await sceneInfo(page);
    expect(Math.abs(Number(info['fogNear']) - 17)).toBeLessThanOrEqual(0.5);
  });
});

// ---------------------------------------------------------------------- 3: bloom

test('3. the surface raises the bloom threshold to 1.5 on medium', async ({ page }) => {
  await land(page, `${SURFACE}&quality=medium`);
  expect(Number((await sceneInfo(page))['bloomThreshold'])).toBeCloseTo(1.5, 5);
});

// ------------------------------------------------------------------- 4: occluder

test('4. a prop between the camera and the salvager fades, and comes back', async ({ page }) => {
  await land(page);
  expect(Number((await sceneInfo(page))['occluders'])).toBe(0);
  await press(page, 'surface-goto-occluder');
  await expect.poll(async () => Number((await sceneInfo(page))['occluders']), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  // Stepping clear returns every fade to opaque.
  await press(page, 'surface-goto-pad');
  await expect.poll(async () => Number((await sceneInfo(page))['occluders']), { timeout: 15_000 }).toBe(0);
});

// -------------------------------------------------------------- 5: hit direction

test('5. a hit from off screen shows one wedge, and it is gone after 1.2 s', async ({ page }) => {
  await land(page);
  const wedge = page.locator('.hud-hit-dir');
  await expect(wedge).toHaveCount(0);
  await press(page, 'surface-hurt-from');
  await expect(wedge).toHaveCount(1);
  await expect(wedge.first()).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(wedge).toHaveCount(0);
});

// --------------------------------------------------------------------- 6: ramp

test('6. the first landing on Cinder-4 ramps in until c1_m1 is done', async ({ page }) => {
  test.setTimeout(180_000);
  await landFresh(page);
  // A fresh save has never finished `c1_m1`, so the ramp is on.
  expect(Number((await sceneInfo(page))['ramp'])).toBe(1);

  // The ambient cycle stays calm and draws no rusher for 30 s of game time.
  const from = await page.evaluate(() => window.__reallm.stats().frame);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const info = await sceneInfo(page);
    expect(info['weatherPhase']).toBe('calm');
    expect(Number(info['rushers'])).toBe(0);
    const frames = (await page.evaluate(() => window.__reallm.stats().frame)) - from;
    if (frames >= 30 * 60) break;
    await page.waitForTimeout(500);
  }

  // Finishing `c1_m1` ends it. The mission is accepted at the pad terminal and
  // walked through with the debug strip's stage shortcut.
  await press(page, 'surface-goto-pad');
  await page.waitForTimeout(400);
  await page.keyboard.press('KeyE');
  await page.locator('[data-testid="terminal-accept-c1_m1"]').click();
  await page.locator('[data-testid="terminal-close"]').click();
  await dismiss(page);
  for (let i = 0; i < 6; i++) {
    if (Number((await sceneInfo(page))['ramp']) === 0) break;
    await press(page, 'surface-finish-stage');
    await page.waitForTimeout(600);
    await dismiss(page);
  }
  await expect.poll(async () => Number((await sceneInfo(page))['ramp']), { timeout: 20_000 }).toBe(0);
});

// --------------------------------------------------------------------- 7: tips

test('7. the first flight teaches its controls, and a second session says nothing', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page, '/?debug&seed=123');
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
  await page.evaluate(() => window.__reallm.go('flight', { destination: 'cinder4' }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  const hint = page.locator('[data-testid="aria-hint"]');
  // The launch shot ends on a tap; the steer tip lands with the controls.
  await page.locator('canvas#game').click({ position: { x: 400, y: 300 }, force: true });
  await expect(hint).toContainText(/steers/i, { timeout: 30_000 });
  // …and the throttle tip 12 s of game time later.
  await expect(hint).toContainText(/slows down|change speed/i, { timeout: 90_000 });

  // Both are per device: a reload sees neither again.
  await start(page, '/?debug&seed=123');
  await page.evaluate(() => window.__reallm.go('flight', { destination: 'cinder4' }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  await page.locator('canvas#game').click({ position: { x: 400, y: 300 }, force: true });
  await page.waitForTimeout(3000);
  await expect(hint).toHaveText('');
  await expect(hint).toHaveClass(/is-hidden/);
});

test('7. the first enemy hit on the surface teaches the combat tip', async ({ page }) => {
  test.setTimeout(120_000);
  await landFresh(page);
  await press(page, 'surface-hurt-from');
  // The `move` tip is already on the strip, and SPEC-027 §4.5 spaces tips 12 s
  // apart; this waits for the queue rather than racing it. SPEC-038 §4.9
  // reworded the tip for auto-fire on: the gun fires on its own.
  await expect
    .poll(async () => page.locator('[data-testid="aria-hint"]').innerText(), { timeout: 60_000 })
    .toMatch(/fires on its own/i);
});

// ---------------------------------------------------------------- 8: flight HUD

test('8. the flight HUD hides the salvager’s HP and labels the hull', async ({ page }) => {
  await start(page, '/?debug&seed=123');
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
  await page.evaluate(() => window.__reallm.go('flight', { destination: 'cinder4' }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  await expect(page.locator('[data-testid="hud-hp"]')).toBeHidden();
  const hull = page.locator('[data-testid="hud-hull"]');
  await expect(hull).toBeVisible();
  await expect(hull).toHaveAttribute('aria-label', 'Hull');
  await expect(hull.locator('.glyph')).toHaveText('⛭');
});

// -------------------------------------------------------------------- 9: next

test('9. with nothing active the tracker names the next mission and where it is taken', async ({ page }) => {
  await landFresh(page);
  // A fresh save offers `Dry Land`; the pad terminal is where it is taken.
  await expect(page.locator('[data-testid="objective-tracker"]')).toContainText('Next: Dry Land — at the pad terminal');

  // With `c1_m1` behind the player, `Black Gold` is next.
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save !== null && !save.progress.missionsDone.includes('c1_m1')) save.progress.missionsDone.push('c1_m1');
  });
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4' }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await dismiss(page);
  await expect(page.locator('[data-testid="objective-tracker"]')).toContainText('Next: Black Gold — at the pad terminal');
});

// -------------------------------------------------------------------- 10: sound

test('10. the guns, the blast and the engine are audible', async ({ page }) => {
  test.setTimeout(120_000);
  await landFresh(page);
  await page.waitForFunction(() => window.__reallm.audio().unlocked === true);

  // A rifle shot: the marine starts on `weapon_kinetic`.
  await page.keyboard.down('Space');
  await page.waitForTimeout(700);
  await page.keyboard.up('Space');
  await expect.poll(async () => (await sprites(page)).includes('shot_rifle'), { timeout: 20_000 }).toBe(true);

  // A blast: the arsenal puts a grenade in the explosive slot, and `G` throws it.
  await press(page, 'surface-arsenal');
  await page.waitForTimeout(200);
  await page.keyboard.press('KeyG');
  await expect.poll(async () => (await sprites(page)).includes('explosion'), { timeout: 20_000 }).toBe(true);

  // The engine hum starts with the cockpit, at the end of the launch shot.
  await page.evaluate(() => window.__reallm.go('flight', { destination: 'cinder4' }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  await page.locator('canvas#game').click({ position: { x: 400, y: 300 }, force: true });
  await expect.poll(async () => (await sprites(page)).includes('engine_hum'), { timeout: 30_000 }).toBe(true);
});

// -------------------------------------------------------- 11, 12, 13: the station

/** A save at the station with one mission active, one done and one available. */
async function station(page: Page): Promise<void> {
  await start(page, '/?debug&seed=123');
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) return;
    save.progress.missionsDone.push('c1_m1');
    save.progress.missionsActive.push({ id: 'c1_m2', stage: 0, counters: {} });
    save.player.tokens = 4000;
  });
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
}

test('11. the board shows its briefs, sorts replays last and puts Abandon at the end', async ({ page }) => {
  await station(page);
  await page.locator('[data-testid="station-tab-missions"]').click();

  // The active row's brief is open without a tap…
  const active = page.locator('[data-testid="mission-c1_m2"]');
  await expect(active.locator('.board-brief')).toBeVisible();
  // …and a tap still folds it.
  await active.locator('.board-head').click();
  await expect(active.locator('.board-brief')).toHaveCount(0);

  // A replayable row sits below every available one inside the planet group.
  const order = await page.evaluate(() => {
    const group = document.querySelector('[data-testid="mission-board"] .board-group');
    if (group === null) return [];
    return [...group.querySelectorAll('.board-row')].map((row) => row.className);
  });
  const available = order.findIndex((cls) => cls.includes('is-available'));
  const replayable = order.findIndex((cls) => cls.includes('is-replayable'));
  expect(available).toBeGreaterThanOrEqual(0);
  expect(replayable).toBeGreaterThan(available);

  // `Abandon` is the last control of the active row.
  const lastId = await active.locator('.board-actions .ui-btn').last().getAttribute('data-testid');
  expect(lastId).toBe('mission-c1_m2-abandon');
});

test('12. the ship shop prints no metric key', async ({ page }) => {
  await station(page);
  await page.locator('[data-testid="station-tab-shop"]').click();
  await page.locator('[data-testid="shop-tab-ship"]').click();
  const text = (await page.locator('[data-testid="shop"]').innerText()) ?? '';
  expect(text).not.toMatch(/[a-z]+(Mult|Hp|Cap)\b/);
  // …and it does say what the tier does.
  expect(text).toMatch(/Speed \+\d+ %/);
});

test('13. the station header says each thing once, and the footer is not an engine', async ({ page }) => {
  await station(page);
  const head = page.locator('.screen-head');
  await expect(page.locator('[data-testid="containment-level"]')).toHaveCount(1);
  await expect(head.locator('.containment-level')).toHaveCount(1);
  expect((await head.innerText()).match(/Containment level/gi) ?? []).toHaveLength(1);
  expect((await head.innerText()).match(/Command Relay/gi) ?? []).toHaveLength(1);
  await expect(page.locator('.screen-channel')).toHaveText('SUPPLY · REFIT · DISPATCH');
  await expect(page.locator('[data-testid="version-label"]')).not.toContainText('M0 engine');
});

// -------------------------------------------------------------------- 14: menu

test('14. New Game opens over the menu without moving a button', async ({ page }) => {
  await start(page, '/?debug');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
  const ids = ['menu-new', 'menu-load', 'menu-settings', 'menu-credits'];
  const before = await Promise.all(ids.map((id) => page.locator(`[data-testid="${id}"]`).boundingBox()));
  await page.locator('[data-testid="menu-new"]').click();
  await expect(page.locator('[data-testid="new-slot-0"]')).toBeVisible();
  await expect(page.locator('.menu-list')).toHaveCount(1);
  // §4.13: the storage block is out of sight, and the column has not moved.
  await expect(page.locator('[data-testid="menu-storage"]')).toBeHidden();
  const after = await Promise.all(ids.map((id) => page.locator(`[data-testid="${id}"]`).boundingBox()));
  for (let i = 0; i < ids.length; i++) {
    expect(after[i]?.x).toBeCloseTo(before[i]?.x ?? -1, 0);
    expect(after[i]?.y).toBeCloseTo(before[i]?.y ?? -1, 0);
    expect(after[i]?.width).toBeCloseTo(before[i]?.width ?? -1, 0);
  }
});

// ---------------------------------------------------------------- 15: creation

test('15. creation’s portrait buttons are at least 64 px', async ({ page }) => {
  await start(page, '/?debug&scene=creation');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('creation');
  const buttons = page.locator('.portrait-row .portrait');
  const count = await buttons.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = await buttons.nth(i).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(64);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(64);
  }
});

// --------------------------------------------------------------- 16: quick bar

test('16. every filled quick-bar slot shows its name, at a real height', async ({ page }) => {
  await landFresh(page);
  await press(page, 'surface-arsenal');
  await page.waitForTimeout(300);
  const names = page.locator('.qb-slot:not(.is-empty) .qb-name');
  const count = await names.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const name = names.nth(i);
    await expect(name).toBeVisible();
    const box = await name.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(0);
  }
  // §4.13: the slot itself is 48 × 64 on a desktop.
  const slot = await page.locator('[data-testid="qb-primary"]').boundingBox();
  expect(slot?.width ?? 0).toBeCloseTo(48, 0);
  expect(slot?.height ?? 0).toBeCloseTo(64, 0);
});

// --------------------------------------------------------------- 17: gear card

test('17. the gear card is at most 420 px wide at 1280', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await station(page);
  await page.locator('[data-testid="station-tab-shop"]').click();
  await page.locator('[data-testid="shop-tab-gear"]').click();
  await page.locator('[data-testid="shop-gear-pistol_magnum"] .shop-row-head').click();
  const card = page.locator('[data-testid="gear-card"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/gear-card-sheet/);
  const box = await card.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(420);
});

// ------------------------------------------------------------------- 18: items

test('18. every item surface draws a picture, not a glyph', async ({ page }) => {
  // §4.15: the render drop is committed, so the manifest is served and every
  // id resolves — the glyph fallback of SPEC-031 31-i is no longer reached.
  const response = await page.request.get('/assets/items/manifest.json');
  expect(response.ok()).toBe(true);
  expect(((await response.json()) as { items: string[] }).items).toHaveLength(26);
  await station(page);
  await page.locator('[data-testid="station-tab-shop"]').click();
  await page.locator('[data-testid="shop-tab-gear"]').click();
  await expect(page.locator('[data-testid="icon-pistol_magnum"] img')).toBeVisible();
  await page.locator('[data-testid="shop-gear-pistol_magnum"] .shop-row-head').click();
  await expect(page.locator('[data-testid="gear-card"] .icon img')).toBeVisible();
  // No surface may fall back to a glyph once every id resolves.
  await expect(page.locator('[data-testid="shop"] .icon-glyph')).toHaveCount(0);

  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4' }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await dismiss(page);
  await expect(page.locator('[data-testid="qb-primary"] .icon img')).toBeVisible();
  await expect(page.locator('.qb-slot:not(.is-empty) .icon-glyph')).toHaveCount(0);
});
