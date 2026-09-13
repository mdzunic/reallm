// SPEC-025 §6.2 — the version-2 save in a real browser. Two things only this
// can prove: that the character panel actually renders the four gear cards a
// fresh save lands with, and that a v1 save sitting in real `localStorage` from
// before PLAN R10 comes back through the Load menu as a version-2 save with its
// old rifle in the primary slot (E38).
//
// The migration itself is proved field by field in `tests/core/save.test.ts`;
// what is under test here is the path a returning player takes — stored JSON,
// the menu's Load button, the live save the scenes then mutate.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/**
 * The v1 fixture of `tests/fixtures/save-v1.json`, slotted to 0. `e2e/` may not
 * import `src/` or `tests/`, so it is written out here — which is the point:
 * this is the JSON a build from before R10 left in the browser.
 */
const V1_SAVE = {
  version: 1,
  meta: {
    slot: 0,
    seed: 987654321,
    createdAt: 1700100000000,
    updatedAt: 1700103600000,
    playtimeSec: 3600,
    difficulty: 'normal',
    iteration: 1,
    appVersion: '0.0.0',
  },
  player: {
    name: 'Vance',
    classId: 'marine',
    appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
    attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
    level: 9,
    xp: 1240,
    tokens: 40,
    hp: 150,
  },
  resources: { oil: 210, wheat: 80, water: 65, lithium: 12 },
  inventory: [
    { itemId: 'wheat_ration', qty: 5 },
    { itemId: 'coolant_pack', qty: 2 },
  ],
  equipped: { weapon: 'weapon_plasma', armor: 'armor_composite' },
  ship: { engine: 2, hull: 1, shield: 2, cargo: 1, weapon: 2 },
  companions: [
    { id: 'aria', level: 2, enabled: true },
    { id: 'combat_drone', level: 1, enabled: false },
  ],
  progress: {
    missionsDone: ['c1_m1', 'c1_m2', 'c1_m3', 'c2_m1'],
    missionsActive: [{ id: 'c2_m2', stage: 0, counters: { '0:0': 120, '0:1': 3 } }],
    flags: ['c1_oil', 'chapter1_done'],
    currentPlanet: 'vetra',
    location: 'station',
    poisDiscovered: ['cinder4:dune_sea:0', 'vetra:ridge_camp:0'],
    visits: { cinder4: 3, vetra: 1 },
    endingSeen: false,
  },
} as const;

/** Walks to the station past the arrival dialogue, which covers the tabs. */
async function dismissDialogue(page: Page): Promise<void> {
  for (let i = 0; i < 12; i++) {
    if ((await page.locator('.dialogue-dim.is-visible').count()) === 0) return;
    await page.locator('.dialogue-dim.is-visible').click({ force: true });
    await page.waitForTimeout(150);
  }
}

test('a fresh save shows four gear cards in the character panel (§6.2)', async ({ page }) => {
  await start(page, '/?debug&scene=station');
  await page.evaluate((creation) => window.__reallm.save().create(0, creation), CREATION);
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  await dismissDialogue(page);

  await page.getByTestId('station-tab-character').click();
  await expect(page.getByTestId('character-panel')).toBeVisible();

  // The three weapon slots and the armor, in that order — the heavy one empty
  // until a launcher is bought (SPEC-029).
  await expect(page.getByTestId('equipped-sidearm')).toContainText('Service Pistol');
  await expect(page.getByTestId('equipped-primary')).toContainText('Kinetic Repeater');
  await expect(page.getByTestId('equipped-heavy')).toContainText('Empty');
  await expect(page.getByTestId('equipped-armor')).toContainText('Scrap Plate');

  // §4.8: the shop reads all four slots, so the pistol in the sidearm — a slot
  // version 1 did not have — is badged `equipped` and not offered for sale.
  await page.getByTestId('station-tab-shop').click();
  await page.getByTestId('shop-tab-gear').click();
  await expect(page.getByTestId('shop-gear-pistol_service')).toContainText('equipped');
  await expect(page.getByTestId('shop-gear-weapon_kinetic')).toContainText('equipped');
  await expect(page.getByTestId('shop-gear-armor_scrap')).toContainText('equipped');
  await expect(page.getByTestId('shop-gear-weapon_laser')).not.toContainText('equipped');
});

test('a v1 save in storage loads as version 2 with its rifle in the primary slot (§6.2, E38)', async ({ page }) => {
  await start(page, '/?debug');
  await page.evaluate((fixture) => localStorage.setItem('reallm:slot:0', JSON.stringify(fixture)), V1_SAVE);

  // Through the Load menu, the way a returning player reaches it. `menu` is the
  // boot scene (SPEC-003), so the store is re-listed by reopening the sub-panel.
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
  await expect(page.locator('[data-testid="menu-root"]')).toBeVisible();
  await page.getByTestId('menu-load').click();
  await page.getByTestId('load-slot-0').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');

  const loaded = await page.evaluate(() => {
    const current = window.__reallm.save().current;
    return {
      version: current?.version,
      equipped: current?.equipped,
      activeWeapon: current?.activeWeapon,
      quick: current?.quick,
      explored: current?.progress.explored,
      name: current?.player.name,
    };
  });

  expect(loaded.version).toBe(2);
  expect(loaded.equipped).toEqual({
    armor: 'armor_composite',
    sidearm: 'pistol_service',
    primary: 'weapon_plasma',
    heavy: null,
  });
  expect(loaded.activeWeapon).toBe('primary');
  // The pack carried rations and a coolant pack, so two quick slots fill
  // themselves on the way up (§4.3).
  expect(loaded.quick).toEqual({ heal: 'wheat_ration', explosive: null, utility: 'coolant_pack' });
  expect(loaded.explored).toEqual({});
  expect(loaded.name).toBe('Vance');

  // And the character came with it: the old rifle beside the new pistol.
  await dismissDialogue(page);
  await page.getByTestId('station-tab-character').click();
  await expect(page.getByTestId('equipped-primary')).toContainText('Plasma Lance');
  await expect(page.getByTestId('equipped-sidearm')).toContainText('Service Pistol');
});
