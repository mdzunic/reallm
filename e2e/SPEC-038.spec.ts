// SPEC-038 §6.2 — Threat I in a real browser: the dash on each scheme, the
// rusher's charge and its lane, the dash tip, a stormed survive stage running
// its wave, the forced storm's ramp, the difficulty row, the auto-fire
// default, the population on `low`, and the telegraph layer inside the medium
// budget with all three kinds live (AC-39). The rules are pinned in node —
// tests/systems/dash.test.ts, telegraph.test.ts, enemyAi.test.ts,
// combat.test.ts, weather.test.ts, missions.test.ts, spawn.test.ts and
// threat.test.ts.
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { awaitGate, COLD_START, gameUrl, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** The words §4.9 pins; `e2e/` may not import `src/`. */
const DASH_TIP_KEYBOARD = 'Right-click or V to dash through it';

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
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
 * A slot-0 save with `c1_m1` done (so SPEC-035's first-landing ramp is over),
 * plus whatever missions `active` names, then a landing on Cinder-4 through
 * the scene machine. The page must already be past the gate.
 */
async function landOnCinder(page: Page, active: string[] = []): Promise<void> {
  await page.evaluate(
    ({ creation, missions }) => {
      const bridge = window.__reallm.save();
      bridge.create(0, creation, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      save.progress.missionsDone.push('c1_m1');
      for (const id of missions) save.progress.missionsActive.push({ id, stage: 0, counters: {} });
    },
    { creation: CREATION, missions: active },
  );
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4' }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
  await dismiss(page);
}

/**
 * The world clock (`sceneInfo.viewTime`) on the first rendered frame where
 * `sceneInfo[key] ≥ min` — read in the same frame, so a slow container that
 * runs the game behind the wall clock measures game seconds, not wall ones.
 */
async function viewTimeWhen(page: Page, key: string, min: number, timeout = 15_000): Promise<number> {
  const handle = await page.waitForFunction(
    ({ key: name, min: floor }) => {
      const info = window.__reallm.stats().sceneInfo ?? {};
      return Number(info[name] ?? -Infinity) >= floor ? Number(info['viewTime'] ?? 0) || 1e-6 : false;
    },
    { key, min },
    { polling: 'raf', timeout },
  );
  return Number(await handle.jsonValue());
}

/** The `[events]` debug lines `?debug` writes for every emit (SPEC-004 §4.6). */
function eventLines(messages: ConsoleMessage[], name: string): string[] {
  return messages.filter((m) => m.type() === 'debug' && m.text().startsWith(`[events] ${name}`)).map((m) => m.text());
}

const press = (page: Page, id: string): Promise<void> => page.getByTestId(id).dispatchEvent('click');

// ------------------------------------------------------------- 1, 2: the dash

test('1, 2. V and the right mouse button dash 5 m, and qb-dash rings its cooldown', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, '/?debug&seed=123');
  await landOnCinder(page);
  const cell = page.getByTestId('qb-dash');
  await expect(cell).toBeVisible();
  await expect(cell).toContainText('V');
  expect(Number((await sceneInfo(page))['dashes'])).toBe(0);
  const before = await sceneInfo(page);

  await page.keyboard.press('KeyV');
  const pressedAt = await viewTimeWhen(page, 'dashes', 1);
  // The ring shows: `--cd` starts near 1 and the cell reads as cooling — both
  // read in the frame the cell is first seen cooling. The Marine's cooldown is
  // 1.358 s of game time, which a loaded GPU-less run can spend between two
  // round trips now that it draws every frame it gets (SPEC-040 §4.2).
  const ring = await (
    await page.waitForFunction(
      () => {
        const node = document.querySelector<HTMLElement>('[data-testid="qb-dash"]');
        return node !== null && node.classList.contains('is-cooling') ? { cd: Number(node.style.getPropertyValue('--cd')) } : false;
      },
      null,
      { polling: 'raf', timeout: 15_000 },
    )
  ).jsonValue();
  expect(ring.cd).toBeGreaterThan(0);
  // 0.2 s later the dash is done; the salvager went 5 m (± the 0.1 m rounding).
  await viewTimeWhen(page, 'viewTime', pressedAt + 0.3);
  const after = await sceneInfo(page);
  const distance = Math.hypot(Number(after['px']) - Number(before['px']), Number(after['pz']) - Number(before['pz']));
  expect(distance).toBeGreaterThanOrEqual(4.5);
  expect(distance).toBeLessThanOrEqual(5.5);

  // Ready again within 1.5 s of game time: the Marine's is 1.358 s.
  const readyAt = Number(
    await (
      await page.waitForFunction(
        () => {
          const node = document.querySelector('[data-testid="qb-dash"]');
          if (node === null || node.classList.contains('is-cooling')) return false;
          return Number(window.__reallm.stats().sceneInfo?.['viewTime'] ?? 0);
        },
        null,
        { polling: 'raf', timeout: 15_000 },
      )
    ).jsonValue(),
  );
  expect(readyAt - pressedAt).toBeLessThanOrEqual(1.5);

  // 2. A right-button press on the canvas dashes too.
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.click(Math.round(size.width / 2), Math.round(size.height / 2), { button: 'right' });
  await expect.poll(async () => Number((await sceneInfo(page))['dashes'])).toBe(2);
});

// ------------------------------------------------------------------ 3: touch

test.describe('3. on touch', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test('DASH sits in the thumb arc’s corner cell, and a tap dashes', async ({ page }) => {
    await page.goto(gameUrl('/?debug&seed=123'));
    await awaitGate(page);
    await page.locator('[data-testid="boot-start"]').tap();
    await expect(page.locator('[data-testid="boot-overlay"]')).toBeHidden();
    await expect(page.locator('[data-testid="scene-label"]')).toBeVisible(COLD_START);
    await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
    await landOnCinder(page);
    expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('touch');
    const button = page.getByTestId('touch-dash');
    await expect(button).toBeVisible();
    expect(await button.evaluate((node) => node.parentElement?.dataset['testid'])).toBe('arc-primary');
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(56);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);
    // The keyboard bar's cell is not in the bar on touch.
    await expect(page.getByTestId('qb-dash')).toHaveCount(0);
    await button.tap();
    await expect.poll(async () => Number((await sceneInfo(page))['dashes'])).toBe(1);
    await expect(page.getByTestId('arc-primary')).toHaveClass(/is-cooling/);
  });
});

// ------------------------------------------------------------------ 4: charge

test('4. a charger winds up: a lane on the ground, and enemy:windup says charge', async ({ page }) => {
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => void messages.push(message));
  await start(page, '/?debug&seed=123');
  await landOnCinder(page);
  const from = Number((await sceneInfo(page))['viewTime']);
  await press(page, 'surface-spawn-charger');
  const drawnAt = await viewTimeWhen(page, 'telegraphs', 1, 20_000);
  expect(drawnAt - from).toBeLessThanOrEqual(3);
  await expect.poll(() => eventLines(messages, 'enemy:windup').some((line) => line.includes('charge'))).toBe(true);
});

// ---------------------------------------------------------------- 5: dash tip

test('5. in a fresh profile the first charge teaches the dash', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, '/?debug&seed=123');
  await landOnCinder(page);
  await press(page, 'surface-spawn-charger');
  // The move tip is on the strip first; SPEC-027 spaces tips 12 s apart.
  await expect
    .poll(async () => page.locator('[data-testid="aria-hint"]').innerText(), { timeout: 60_000 })
    .toContain(DASH_TIP_KEYBOARD);
});

// -------------------------------------------------------------- 6: storm wave

test('6. c1_s2’s survive stage runs cinder4_storm, and it goes with the stage', async ({ page }) => {
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => void messages.push(message));
  await start(page, '/?debug&seed=123');
  await landOnCinder(page, ['c1_s2']);
  expect((await sceneInfo(page))['stormWave']).toBe('-');
  await press(page, 'surface-finish-stage');
  await expect.poll(async () => (await sceneInfo(page))['stormWave']).toBe('cinder4_storm');
  await expect.poll(() => eventLines(messages, 'wave:started').some((line) => line.includes('cinder4_storm'))).toBe(true);
  await press(page, 'surface-finish-stage');
  await expect.poll(async () => (await sceneInfo(page))['stormWave']).toBe('-');
});

// -------------------------------------------------------------------- 7: ramp

test('7. a forced storm ramps in over 10 s, to Cinder-4’s 1.3 dps', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, '/?debug&seed=123');
  await landOnCinder(page);
  await press(page, 'surface-storm');
  await expect(page.locator('.hud-weather')).toContainText('Heatwave');
  const forcedAt = Number((await sceneInfo(page))['viewTime']);
  const early = await page.waitForFunction(
    (at) => {
      const info = window.__reallm.stats().sceneInfo ?? {};
      return Number(info['viewTime']) >= at + 1 ? String(info['weatherDps']) : false;
    },
    forcedAt,
    { polling: 'raf', timeout: 20_000 },
  );
  expect(Number(await early.jsonValue())).toBeLessThanOrEqual(0.3);
  const full = await page.waitForFunction(
    (at) => {
      const info = window.__reallm.stats().sceneInfo ?? {};
      return Number(info['viewTime']) >= at + 11 ? String(info['weatherDps']) : false;
    },
    forcedAt,
    { polling: 'raf', timeout: 60_000 },
  );
  expect(Math.abs(Number(await full.jsonValue()) - 1.3)).toBeLessThanOrEqual(0.05);
});

// -------------------------------------------------------------- 8: difficulty

test('8. the pause menu’s Settings switches the run to casual, and a reload keeps it', async ({ page }) => {
  await start(page, '/?debug&seed=123');
  await landOnCinder(page);
  expect((await sceneInfo(page))['difficulty']).toBe('normal');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.getByTestId('pause-settings').click();
  const casual = page.getByTestId('settings-difficulty-casual');
  await expect(page.getByTestId('settings-difficulty')).toBeVisible();
  await expect(page.getByTestId('settings-difficulty-normal')).toHaveAttribute('aria-pressed', 'true');
  await casual.click();
  await expect(casual).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('settings-difficulty-line')).toContainText('longer wind-ups');
  expect(await page.evaluate(() => window.__reallm.save().current?.meta.difficulty)).toBe('casual');
  expect((await sceneInfo(page))['difficulty']).toBe('casual');

  await page.reload();
  await awaitGate(page);
  expect(await page.evaluate(() => window.__reallm.save().load(0).data?.meta.difficulty)).toBe('casual');
});

test('8. the main menu’s Settings with no slot bound has no difficulty row', async ({ page }) => {
  await start(page, '/');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
  expect(await page.evaluate(() => window.__reallm.save().current)).toBeNull();
  await page.getByTestId('menu-settings').click();
  await expect(page.getByTestId('settings-panel')).toBeVisible();
  await expect(page.getByTestId('settings-difficulty')).toHaveCount(0);
});

// --------------------------------------------------------------- 9: auto-fire

test('9. a fresh profile auto-fires on the keyboard scheme, and Settings says On', async ({ page }) => {
  await start(page, '/');
  expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('keyboard');
  expect(await page.evaluate(() => window.__reallm.input().autoFire)).toBe(true);
  await page.getByTestId('menu-settings').click();
  const row = page.locator('.settings-row', { hasText: 'Auto-fire' });
  await expect(row.getByRole('button', { name: 'On', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(row.getByRole('button', { name: 'Touch only', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

// -------------------------------------------------------------- 10: population

test('10. on low, Cinder-4 fields its design count of 10', async ({ page }) => {
  await start(page, '/?debug&seed=123&quality=low');
  await landOnCinder(page);
  expect(Number((await sceneInfo(page))['population'])).toBe(10);
});

// ------------------------------------------------------------ AC-39: budget

test('AC-39. with all three telegraph kinds live the medium frame stays inside 96 draws', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, '/?debug&seed=123&quality=medium');
  await landOnCinder(page);
  await press(page, 'surface-telegraphs');
  await press(page, 'surface-spawn-charger');
  const draws = await page.waitForFunction(
    () => {
      const stats = window.__reallm.stats();
      const info = stats.sceneInfo ?? {};
      return Number(info['telegraphDraws']) === 3 ? stats.drawCalls : false;
    },
    null,
    { polling: 'raf', timeout: 30_000 },
  );
  expect(Number(await draws.jsonValue())).toBeLessThanOrEqual(96); // 80 scene + 16 post
});
