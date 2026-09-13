// SPEC-028's browser acceptance run (§6.2): the quick bar's six slots, weapon
// switching by key, wheel and tap, the heal refusals and the spend, the empty
// utility toast, the long-press picker, the touch layout, and the character
// panel's Loadout block at the station. The rules themselves are pinned in
// node (`tests/systems/loadout.test.ts`); this is the composed wiring.
import { devices, expect, test, type Page } from '@playwright/test';
import { start } from './start';

/** §6.2: a fresh save on Cinder-4 with the debug strip up. */
const URL = '/?debug&scene=surface&planet=cinder4&seed=123';

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

/** Wait for a `?scene=` jump to have finished fading in (SPEC-003 AC-14). */
async function settle(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
}

test('the bar shows the six slots with names, counts and states (§6.2 case 1)', async ({ page }) => {
  await start(page, URL);
  await settle(page);

  const bar = page.locator('[data-testid="quickbar"]');
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('qb-sidearm')).toContainText('Pistol');
  await expect(page.getByTestId('qb-primary')).toContainText('Repeater');
  await expect(page.getByTestId('qb-heavy')).toHaveClass(/is-empty/);
  await expect(page.getByTestId('qb-heal')).toContainText('Ration');
  await expect(page.getByTestId('qb-heal')).toContainText('×3');

  // The primary starts active: border class and the state text.
  await expect(page.getByTestId('qb-primary')).toHaveClass(/is-active/);
  await expect(page.getByTestId('qb-heavy')).toContainText('EMPTY');

  // ≥ 48 px slots, and the old bottom-left consumable box is gone.
  const box = await page.getByTestId('qb-primary').boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(48);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
  await expect(page.locator('.hud-consumable')).toHaveCount(0);

  // Key hints show for the keyboard scheme.
  await expect(page.getByTestId('qb-heal')).toContainText('Q');
});

test('keys, R and the wheel switch weapons (§6.2 case 2)', async ({ page }) => {
  await start(page, URL);
  await settle(page);

  await page.keyboard.press('Digit1');
  await expect.poll(async () => (await info(page))['weaponSlot']).toBe('sidearm');
  expect((await info(page))['weapon']).toBe('pistol_service');
  await expect(page.getByTestId('qb-sidearm')).toHaveClass(/is-active/);

  await page.keyboard.press('Digit2');
  await expect.poll(async () => (await info(page))['weaponSlot']).toBe('primary');

  // R cycles forward, skipping the empty heavy slot back to the sidearm.
  await page.keyboard.press('KeyR');
  await expect.poll(async () => (await info(page))['weaponSlot']).toBe('sidearm');

  // A wheel notch over the canvas changes the slot again.
  const viewport = page.viewportSize();
  await page.mouse.move((viewport?.width ?? 800) / 2, (viewport?.height ?? 600) / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(async () => (await info(page))['weaponSlot']).toBe('primary');
});

test('the heal slot refuses at full HP, spends when hurt, and C toasts empty (§6.2 cases 3–4)', async ({ page }) => {
  await start(page, URL);
  await settle(page);
  expect((await info(page))['qHeal']).toBe(3);

  // At full HP nothing is spent and the toast says so.
  await page.keyboard.press('KeyQ');
  await expect(page.getByTestId('toasts')).toContainText('HP full');
  expect((await info(page))['qHeal']).toBe(3);

  // Hurt, the same key spends exactly one ration.
  await page.getByTestId('surface-hurt').click();
  await page.keyboard.press('KeyQ');
  await expect.poll(async () => (await info(page))['qHeal']).toBe(2);

  // A tap on the consumable slot uses it too (§4.5: acts on release).
  await page.getByTestId('surface-hurt').click();
  await page.getByTestId('qb-heal').click();
  await expect.poll(async () => (await info(page))['qHeal']).toBe(1);

  // §6.2 case 4: the utility slot is empty until something eligible is carried.
  await page.keyboard.press('KeyC');
  await expect(page.getByTestId('toasts')).toContainText('No utility items');
  expect((await info(page))['qUtility']).toBe(0);
});

test('a long press on the heal slot opens the picker and choosing closes it (§6.2 case 5)', async ({ page }) => {
  await start(page, URL);
  await settle(page);

  const heal = page.getByTestId('qb-heal');
  const box = await heal.boundingBox();
  if (box === null) throw new Error('qb-heal has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();

  const picker = page.locator('[data-testid="quick-picker"]');
  await expect(picker).toBeVisible();
  // §4.6: it lists the eligible carried items with counts, plus Empty.
  await expect(page.getByTestId('quick-pick-wheat_ration')).toContainText('×3');
  await expect(page.getByTestId('quick-pick-empty')).toBeVisible();

  // The hold keeps the simulation still while it is open (28-d).
  expect((await info(page))['mapOpen']).toBe(0);

  await page.getByTestId('quick-pick-wheat_ration').click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId('qb-heal')).toContainText('Ration');

  // A second visit proves the choice lands in the save: Empty clears the slot,
  // and the bar and the qHeal counter follow it.
  const box2 = await heal.boundingBox();
  if (box2 === null) throw new Error('qb-heal has no box');
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await expect(picker).toBeVisible();
  await page.getByTestId('quick-pick-empty').click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId('qb-heal')).toHaveClass(/is-empty/);
  await expect.poll(async () => (await info(page))['qHeal']).toBe(0);
});

// Pixel 5 emulation, minus `defaultBrowserType`, which a describe-level
// `use()` may not carry. Landscape: the gameplay scenes mount RotateOverlay
// over a portrait phone.
const { defaultBrowserType: _ignored, ...PIXEL_5 } = devices['Pixel 5 landscape'];

test.describe('touch (§6.2 case 6)', () => {
  test.use(PIXEL_5);

  test('a tap selects a weapon slot; SWAP and ITEM are on screen', async ({ page }) => {
    await start(page, URL);
    await settle(page);

    // The layer mounts with the first touch (SPEC-005 AC-20) — on the bare
    // canvas, clear of the tracker, the minimap and the bar.
    const size = page.viewportSize();
    await page.touchscreen.tap(Math.round((size?.width ?? 800) / 2), Math.round((size?.height ?? 400) * 0.45));
    await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();
    await expect(page.getByTestId('touch-weaponNext')).toBeVisible();
    await expect(page.getByTestId('touch-useItem')).toBeVisible();

    // 56 px slots on the touch scheme, and the key hints are gone.
    const box = await page.getByTestId('qb-primary').boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(56);
    await expect(page.locator('[data-testid="qb-heal"] .qb-key')).toHaveClass(/is-hidden/);

    await page.getByTestId('qb-sidearm').tap();
    await expect(page.getByTestId('qb-sidearm')).toHaveClass(/is-active/);
    await expect.poll(async () => (await info(page))['weaponSlot']).toBe('sidearm');
  });
});

test('the character panel shows the Loadout block at the station (§6.2 case 7)', async ({ page }) => {
  await start(page, '/?debug&scene=station');
  await page.evaluate(() =>
    window.__reallm.save().create(0, {
      name: 'Salvager',
      classId: 'marine',
      appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
      attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
      difficulty: 'normal',
    }),
  );
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  // The arrival dialogue covers the tabs on a fresh save.
  for (let i = 0; i < 12; i++) {
    if ((await page.locator('.dialogue-dim.is-visible').count()) === 0) break;
    await page.locator('.dialogue-dim.is-visible').click({ force: true });
    await page.waitForTimeout(150);
  }

  await page.getByTestId('station-tab-character').click();
  await expect(page.getByTestId('character-panel')).toBeVisible();
  await expect(page.getByTestId('loadout-primary')).toContainText('Kinetic Repeater');
  await expect(page.getByTestId('loadout-sidearm')).toContainText('Service Pistol');
  await expect(page.getByTestId('loadout-heavy')).toContainText('buy a launcher');
  await expect(page.getByTestId('loadout-armor')).toContainText('Scrap Plate');
  await expect(page.getByTestId('loadout-quick-heal')).toContainText('Wheat Ration');
});
