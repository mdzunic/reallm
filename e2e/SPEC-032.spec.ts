// SPEC-032 §6.2: travel and service mode in a real browser — the launch shot
// (its progress, its skip, its reduce-motion form and its draw budget), the
// skippable run from the depart sheet and the pause menu with the autopilot
// card, and the hidden service override: the menu code, the badge, the
// station's supplies, the unlocks on the star map and the off switch.
//
// The launch shot runs on the launch phase's 3 s clock, which is real time
// here; the cases that need it read `sceneInfo.launch` straight after the
// scene is up, well inside that window.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const ON_TOAST = 'Service override accepted — requisition limits lifted.';
const OFF_TOAST = 'Service override released.';
const SERVICE_LINE = 'Earth Command service override: every world reachable, the hold kept full, and any run skippable.';

/** One transition, plus the frame that draws the scene we landed in. */
async function go(page: Page, id: string, params: unknown = {}): Promise<boolean> {
  return page.evaluate(
    async ({ id, params }) => {
      const ok = await window.__reallm.go(id, params);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return ok;
    },
    { id, params },
  );
}

/** A bound save; `patch` edits it in the page before any scene reads it. */
async function createPilot(page: Page, patch: { oil?: number; tokens?: number; visits?: Record<string, number>; flags?: string[]; active?: string[] } = {}): Promise<void> {
  await page.evaluate(
    ({ creation, patch }) => {
      const data = window.__reallm.save().create(0, creation) as unknown as {
        resources: Record<string, number>;
        player: { tokens: number };
        progress: { visits: Record<string, number>; flags: string[]; missionsActive: Array<{ id: string; stage: number; counters: Record<string, number> }> };
      };
      data.resources['oil'] = patch.oil ?? 200;
      if (patch.tokens !== undefined) data.player.tokens = patch.tokens;
      Object.assign(data.progress.visits, patch.visits ?? {});
      data.progress.flags.push(...(patch.flags ?? []));
      for (const id of patch.active ?? []) data.progress.missionsActive.push({ id, stage: 0, counters: {} });
    },
    { creation: CREATION, patch },
  );
}

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

async function launch(page: Page): Promise<number> {
  return Number((await sceneInfo(page))['launch'] ?? Number.NaN);
}

/** Resolve after `count` animation frames. */
async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, count);
}

/** Types the service code on the menu. */
async function typeCode(page: Page): Promise<void> {
  for (const key of ['a', 's', 'd', 'f']) await page.keyboard.press(key);
}

/** Station → star map → the named world's depart sheet. */
async function openDepartSheet(page: Page, planet = 'cinder4'): Promise<void> {
  expect(await go(page, 'station', {})).toBe(true);
  expect(await go(page, 'starmap', undefined)).toBe(true);
  await page.locator(`[data-testid="map-node-${planet}"]`).click();
  await page.locator('[data-testid="starmap-depart"]').click();
  await expect(page.locator('[data-testid="confirm-sheet"]')).toBeVisible();
}

test.describe('the launch shot', () => {
  test('runs from outside to the cockpit inside the draw budget (1)', async ({ page }) => {
    await start(page, '/?debug&scene=flight&planet=cinder4&quality=medium');
    expect(await launch(page)).toBeLessThan(1);
    // Inside the shot the tug is drawn: the frame still fits 40 + 16 draws.
    const during = await page.evaluate(() => window.__reallm.stats());
    expect(Number(during.sceneInfo?.['launch'])).toBeLessThan(1);
    expect(during.drawCalls).toBeLessThanOrEqual(56);
    expect(during.triangles).toBeLessThanOrEqual(80_000);
    await page.waitForFunction(() => Number(window.__reallm.stats().sceneInfo?.['launch']) === 1, undefined, { timeout: 10_000 });
    const after = await page.evaluate(() => window.__reallm.stats());
    expect(after.drawCalls).toBeLessThanOrEqual(56);
  });

  test('a fresh key ends it at once; Space never does (2)', async ({ page }) => {
    await start(page, '/?debug&scene=flight&planet=cinder4');
    expect(await launch(page)).toBeLessThan(1);
    await expect(page.locator('[data-testid="skip-landing"]')).toBeVisible();
    await page.keyboard.press('KeyF');
    await frames(page, 2);
    expect(await launch(page)).toBe(1);
    await expect(page.locator('[data-testid="skip-landing"]')).toBeHidden();

    // A fresh run: Space leaves the shot running.
    expect(await page.evaluate(() => window.__reallm.go('flight', { destination: 'cinder4' }, { force: true }))).toBe(true);
    await frames(page, 1);
    expect(await launch(page)).toBeLessThan(1);
    await page.keyboard.press('Space');
    await frames(page, 2);
    expect(await launch(page)).toBeLessThan(1);
  });

  test.describe('reduce motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('holds the camera still through the shot (3)', async ({ page }) => {
      await start(page, '/?debug&scene=flight&planet=cinder4');
      const seen = new Set<number>();
      for (let i = 0; i < 30 && (await launch(page)) < 1; i++) {
        seen.add(Number((await sceneInfo(page))['cameraZ']));
        await frames(page, 4);
      }
      expect(seen.size).toBe(1);
      expect([...seen][0]).toBe(2.5);
    });
  });
});

test.describe('skippable runs', () => {
  test('a route never landed on refuses the skip (4)', async ({ page }) => {
    await start(page);
    await createPilot(page, { visits: { cinder4: 0 } });
    await openDepartSheet(page);
    await expect(page.locator('[data-testid="depart-skip"]')).toBeDisabled();
    await expect(page.locator('[data-testid="depart-skip-reason"]')).toHaveText('Autopilot needs a route — fly this run once.');
  });

  test('a skip pays the fuel, shows the autopilot card and lands on the surface (5)', async ({ page }) => {
    await start(page);
    await createPilot(page, { oil: 200, visits: { cinder4: 1 } });
    await openDepartSheet(page);
    await expect(page.locator('[data-testid="depart-skip"]')).toBeEnabled();
    await page.locator('[data-testid="depart-skip"]').click();
    await expect(page.locator('[data-testid="autopilot-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="autopilot-card"]')).toContainText('AUTOPILOT');
    await expect(page.locator('[data-testid="autopilot-card"]')).toContainText('arriving at Cinder-4');
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', { timeout: 15_000 });
    const data = await page.evaluate(() => window.__reallm.save().current);
    expect(data?.resources['oil']).toBe(200 - 40);
    expect(data?.progress.location).toBe('surface');
    expect(data?.progress.currentPlanet).toBe('cinder4');
  });

  test('a flight mission refuses the skip by name (6)', async ({ page }) => {
    await start(page);
    await createPilot(page, { oil: 400, visits: { hive: 1 }, flags: ['chapter4_done'], active: ['c5_m1'] });
    await openDepartSheet(page, 'hive');
    await expect(page.locator('[data-testid="depart-skip"]')).toBeDisabled();
    await expect(page.locator('[data-testid="depart-skip-reason"]')).toHaveText('Gauntlet needs a flown run.');
  });

  test('the pause menu skips a run and lands on the surface (7)', async ({ page }) => {
    await start(page);
    await createPilot(page, { oil: 200, visits: { cinder4: 1 } });
    await openDepartSheet(page);
    await page.locator('[data-testid="confirm-yes"]').click();
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="pause-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="pause-skip-run"]')).toBeVisible();
    await page.locator('[data-testid="pause-skip-run"]').click();
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', { timeout: 15_000 });
    expect(await page.evaluate(() => window.__reallm.save().current?.progress.location)).toBe('surface');
  });

  test('the pause menu hides the entry when the rule refuses', async ({ page }) => {
    await start(page);
    await createPilot(page, { oil: 200 });
    await openDepartSheet(page);
    await page.locator('[data-testid="confirm-yes"]').click();
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="pause-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="pause-skip-run"]')).toBeHidden();
  });
});

test.describe('service mode', () => {
  test('asdf on the menu turns it on, and the setting survives a reload (8, 13)', async ({ page }) => {
    await start(page);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
    await expect(page.locator('[data-testid="service-badge"]')).toBeHidden();
    await typeCode(page);
    const badge = page.locator('[data-testid="service-badge"]');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('SERVICE');
    const toasts = page.locator('[data-testid="toasts"]');
    await expect(toasts).toContainText(ON_TOAST);

    // 13: nothing the mode shows speaks of what the endings keep.
    for (const text of [ON_TOAST, OFF_TOAST, SERVICE_LINE, (await badge.textContent()) ?? '']) {
      expect(text).not.toMatch(/simulation|instance|model|debug|cheat/i);
    }

    await start(page);
    await expect(page.locator('[data-testid="service-badge"]')).toBeVisible();
  });

  test('a 3 s press on the build label toggles it, and is not a stats tap (§4.6)', async ({ page }) => {
    await start(page);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
    const label = page.locator('[data-testid="version-label"]');
    const box = await label.boundingBox();
    if (box === null) throw new Error('the build label has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(3_300);
    await page.mouse.up();
    await expect(page.locator('[data-testid="service-badge"]')).toBeVisible();
    await expect(page.locator('[data-testid="toasts"]')).toContainText(ON_TOAST);
    // Four taps inside the five-tap window: had the press counted, this would
    // be the fifth and the stats overlay would open.
    for (let tap = 0; tap < 4; tap++) await label.click();
    await frames(page, 2);
    await expect(page.locator('.overlay-debug')).toHaveCount(0);
    // A short press is only a tap.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(300);
    await page.mouse.up();
    await expect(page.locator('[data-testid="service-badge"]')).toBeVisible();
  });

  test('typing the code into a text field does nothing (9)', async ({ page }) => {
    await start(page);
    expect(await go(page, 'creation', { slot: 0 })).toBe(true);
    const name = page.locator('[data-testid="creation-name"]');
    await name.click();
    await name.fill('');
    await name.pressSequentially('asdf');
    await expect(name).toHaveValue('asdf');
    await frames(page, 2);
    await expect(page.locator('[data-testid="service-badge"]')).toBeHidden();
  });

  test('the station fills the hold and the wallet (10)', async ({ page }) => {
    await start(page);
    await typeCode(page);
    await expect(page.locator('[data-testid="service-badge"]')).toBeVisible();
    await createPilot(page, { oil: 10, tokens: 0 });
    expect(await go(page, 'station', {})).toBe(true);
    await expect(page.locator('.screen-status [data-testid="wallet-oil"]')).toContainText('400/400');
    const tokens = await page.evaluate(() => (window.__reallm.save().current as unknown as { player: { tokens: number } }).player.tokens);
    expect(tokens).toBeGreaterThanOrEqual(5000);
    await expect(page.locator('.screen-status [data-testid="wallet-tokens"]')).toContainText(/5[\s,.]?000/);
    // The badge rides every scene.
    await expect(page.locator('[data-testid="service-badge"]')).toBeVisible();
  });

  test('every world is reachable, its real requirements still listed; off locks it again (11, 12)', async ({ page }) => {
    await start(page);
    await typeCode(page);
    await createPilot(page, { oil: 10 });
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);
    await page.locator('[data-testid="map-node-eden"]').click();
    await expect(page.locator('[data-testid="starmap-info-name"]')).toHaveText('Eden-Prime');
    await expect(page.locator('[data-testid="starmap-depart"]')).toBeEnabled();
    await expect(page.locator('.starmap-reqs .req-unmet').first()).toBeVisible();

    // 12: off in settings — the badge goes, and Eden locks with its reason.
    expect(await go(page, 'station', {})).toBe(true);
    await page.locator('[data-testid="station-tab-settings"]').click();
    const toggle = page.locator('[data-testid="settings-service"]');
    await expect(toggle).toBeVisible();
    await expect(page.locator('[data-testid="settings-panel"]')).toContainText(SERVICE_LINE);
    await expect(toggle).toBeChecked();
    // A click, not `uncheck()`: switching it off re-renders the panel without
    // the section, so there is no checkbox left to read the new state from.
    await toggle.click();
    await expect(page.locator('[data-testid="service-badge"]')).toBeHidden();
    await expect(page.locator('[data-testid="toasts"]')).toContainText(OFF_TOAST);
    await expect(page.locator('[data-testid="settings-service"]')).toHaveCount(0);
    await page.locator('[data-testid="settings-close"]').click();
    expect(await go(page, 'starmap', undefined)).toBe(true);
    await page.locator('[data-testid="map-node-eden"]').click();
    await expect(page.locator('[data-testid="starmap-depart"]')).toBeDisabled();
    await expect(page.locator('[data-testid="depart-reason"]')).not.toHaveText('');
  });
});
