// SPEC-039 §6.2 — builds that matter, in a real browser: the shop's honest
// numbers (stat and compare lines, the gear card), the Refit line, the ship
// rows' role and gate lines, the board's boss-drop line, a boss's signature
// drop and its lithium fallback on the surface, attribute points on the
// character panel, the one damage formula, and the Quartermaster's scope.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

async function go(page: Page, id: string, params: unknown = {}, force = false): Promise<boolean> {
  return page.evaluate(
    async ({ id, params, force }) => {
      const ok = await window.__reallm.go(id, params, force ? { force: true } : undefined);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return ok;
    },
    { id, params, force },
  );
}

/** What a case changes on the fresh save before it opens a screen. */
interface SavePatch {
  level?: number;
  xp?: number;
  hp?: number;
  primary?: string;
}

/** A fresh marine 6/5/1/1 in slot 0, with `patch` applied to the live save. */
async function newSave(page: Page, patch: SavePatch = {}): Promise<void> {
  await page.evaluate(
    ({ creation, patch }) => {
      const data = window.__reallm.save().create(0, creation, 123);
      if (patch.level !== undefined) data.player.level = patch.level;
      if (patch.xp !== undefined) data.player.xp = patch.xp;
      if (patch.hp !== undefined) data.player.hp = patch.hp;
      if (patch.primary !== undefined) data.equipped.primary = patch.primary;
    },
    { creation: CREATION, patch },
  );
}

async function station(page: Page, tab: 'missions' | 'shop' | 'character'): Promise<void> {
  expect(await go(page, 'station', {})).toBe(true);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  await page.locator(`[data-testid="station-tab-${tab}"]`).click();
}

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
    else await dialogue.click({ force: true });
    await page.waitForTimeout(120);
  }
}

/** A synthetic click on the debug strip, so a line over it never intercepts. */
async function strip(page: Page, testid: string): Promise<void> {
  await page.evaluate((id) => {
    (document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click();
  }, testid);
}

/** Land on Cinder-4, wake the Wurm, walk to it and smite until it has dropped. */
async function killTheWurm(page: Page): Promise<Record<string, number | string>> {
  expect(await go(page, 'surface', { planet: 'cinder4', firstLanding: false }, true)).toBe(true);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await dismiss(page);
  const fresh = await sceneInfo(page);
  expect([Number(fresh['signatureDrops']), Number(fresh['signatureFallbacks'])]).toEqual([0, 0]);

  await strip(page, 'surface-spawn-boss');
  await expect.poll(async () => String((await sceneInfo(page))['boss'] ?? '-'), { timeout: 15_000 }).toMatch(/^p\d /);
  await strip(page, 'surface-goto-boss');
  // Smite takes the nearest enemy each press; the Wurm goes when it is nearest.
  await expect
    .poll(
      async () => {
        const info = await sceneInfo(page);
        if (Number(info['signatureDrops']) + Number(info['signatureFallbacks']) > 0) return true;
        await strip(page, 'surface-smite');
        return false;
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(true);
  return sceneInfo(page);
}

test('1. rows: every gear row prints its stat line, and the compare line against a different worn piece', async ({ page }) => {
  await start(page, '/?debug');
  await newSave(page);
  await station(page, 'shop');
  await page.locator('[data-testid="shop-tab-gear"]').click();

  await expect(page.locator('[data-testid="shop-gear-weapon_laser-stats"]')).toContainText('DPS 72');
  await expect(page.locator('[data-testid="shop-gear-mg_scrap-stats"]')).toContainText('110 firing · 64 sustained');
  const compare = page.locator('[data-testid="shop-gear-mg_scrap-compare"]');
  await expect(compare).toContainText('DPS 36 → 64');
  await expect(compare).not.toContainText('T0');
  // Armour prints its own line; a launcher its sustained DPS.
  await expect(page.locator('[data-testid="shop-gear-armor_composite-stats"]')).toHaveText('armor 15 · −13 % damage · hazard 25 %');
  await expect(page.locator('[data-testid="shop-gear-launcher_rocket-stats"]')).toContainText('DPS 15 sustained');
  // The same piece worn, or an empty slot, prints no compare line.
  await expect(page.locator('[data-testid="shop-gear-weapon_kinetic-compare"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="shop-gear-launcher_rocket-compare"]')).toHaveCount(0);
  // Every gear row carries a stat line.
  const rows = await page.locator('[data-testid^="shop-gear-"][data-testid$="-stats"]').count();
  const gear = await page.locator('article[data-testid^="shop-gear-"]').count();
  expect(rows).toBe(gear);
});

test("2. card: the Scrap Chaingun's card shows 64 sustained and compares against the Kinetic Repeater", async ({ page }) => {
  await start(page, '/?debug');
  await newSave(page);
  await station(page, 'shop');
  await page.locator('[data-testid="shop-tab-gear"]').click();
  await page.locator('[data-testid="shop-gear-mg_scrap-details"]').click();
  const card = page.locator('[data-testid="gear-card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('64 sustained');
  await expect(card.locator('.gear-card-compare')).toContainText('DPS 36 → 64');
  await expect(card.locator('.gear-card-compare')).toContainText('damage 12 → 11');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
});

test('3. refit: a new save reads Vetra and its loadout, and ready once the three are bought', async ({ page }) => {
  await start(page, '/?debug');
  await newSave(page);
  await station(page, 'shop');
  const refit = page.locator('[data-testid="shop-refit"]');
  await expect(refit).toHaveText('Refit for Vetra: Composite Weave 39 · Scanner Drone 20 · Laser Carbine 39');
  for (const part of ['Vetra', 'Composite Weave', 'Scanner Drone', 'Laser Carbine']) await expect(refit).toContainText(part);

  await page.evaluate(() => {
    const data = window.__reallm.save().current;
    if (data === null) throw new Error('no save');
    data.player.tokens += 200;
  });
  const buy = async (tab: 'gear' | 'companions', testid: string): Promise<void> => {
    await page.locator(`[data-testid="shop-tab-${tab}"]`).click();
    await page.locator(`[data-testid="${testid}"]`).click();
    await page.locator('[data-testid="confirm-yes"]').click();
    await expect(page.locator('[data-testid="confirm-sheet"]')).toHaveCount(0);
  };
  await buy('gear', 'shop-gear-armor_composite-buy');
  await expect(refit).toHaveText('Refit for Vetra: Scanner Drone 20 · Laser Carbine 39');
  await buy('companions', 'shop-companion-scanner_drone-buy');
  await buy('gear', 'shop-gear-weapon_laser-buy');
  await expect(refit).toHaveText('Refit for Vetra: ready');

  // 39-k: with every planet of chapter ≥ 2 landed on, there is no line.
  await page.evaluate(() => {
    const data = window.__reallm.save().current;
    if (data === null) throw new Error('no save');
    for (const planet of ['vetra', 'thessaly', 'ferrum', 'hive', 'eden']) data.progress.visits[planet] = 1;
  });
  await page.locator('[data-testid="shop-tab-ship"]').click();
  await expect(page.locator('[data-testid="shop-refit"]')).toHaveCount(0);
});

test('4. ship rows: each says what it acts on, and the shield row names the Ferrum gate', async ({ page }) => {
  await start(page, '/?debug');
  await newSave(page);
  await station(page, 'shop');
  await expect(page.locator('[data-testid="shop-ship-hull-role"]')).toHaveText('Flight: hull points');
  await expect(page.locator('[data-testid="shop-ship-shield-role"]')).toHaveText('Flight: shield points');
  await expect(page.locator('[data-testid="shop-ship-weapon-role"]')).toHaveText('Flight: nose guns');
  await expect(page.locator('[data-testid="shop-ship-engine-role"]')).toHaveText('Flight time and fuel per jump');
  await expect(page.locator('[data-testid="shop-ship-cargo-role"]')).toHaveText('The hold, on every planet');
  await expect(page.locator('[data-testid="shop-ship-shield-gate"]')).toHaveText('Required for Ferrum');
  await expect(page.locator('[data-testid="shop-ship-hull-gate"]')).toHaveCount(0);

  // With the gate met, the line goes.
  await page.evaluate(() => {
    const data = window.__reallm.save().current;
    if (data === null) throw new Error('no save');
    data.ship['shield'] = 2;
  });
  await page.locator('[data-testid="shop-tab-gear"]').click();
  await page.locator('[data-testid="shop-tab-ship"]').click();
  await expect(page.locator('[data-testid="shop-ship-shield-gate"]')).toHaveCount(0);
});

test('5. board: the Wurm mission names its drop, and 25 lithium once the piece is owned', async ({ page }) => {
  await start(page, '/?debug');
  await newSave(page);
  await station(page, 'missions');
  await expect(page.locator('[data-testid="mission-c1_m3-drop"]')).toHaveText('Boss drop: Rocket Launcher');
  // A mission with no boss objective has no drop line.
  await expect(page.locator('[data-testid="mission-c1_m1-drop"]')).toHaveCount(0);

  await page.evaluate(() => {
    const data = window.__reallm.save().current;
    if (data === null) throw new Error('no save');
    data.inventory.push({ itemId: 'launcher_rocket', qty: 1 });
  });
  await page.locator('[data-testid="station-tab-missions"]').click();
  await expect(page.locator('[data-testid="mission-c1_m3-drop"]')).toHaveText('Boss drop: 25 lithium');
});

test('6. the drop: a first kill drops the Rocket Launcher, an owned one pays lithium instead', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, '/?debug');
  await newSave(page);

  const first = await killTheWurm(page);
  expect([Number(first['signatureDrops']), Number(first['signatureFallbacks'])]).toEqual([1, 0]);

  await page.evaluate(() => {
    const data = window.__reallm.save().current;
    if (data === null) throw new Error('no save');
    data.inventory.push({ itemId: 'launcher_rocket', qty: 1 });
  });
  const again = await killTheWurm(page);
  expect([Number(again['signatureDrops']), Number(again['signatureFallbacks'])]).toEqual([0, 1]);
});

test('7. points: a level-5 save has one to spend, and a point of vigor adds 8 max HP', async ({ page }) => {
  await start(page, '/?debug');
  // Level 5: 100 + 20 + 8 × 5 + 4 × 4 = 176 HP, full.
  await newSave(page, { level: 5, xp: 900, hp: 176 });
  await station(page, 'character');
  const points = page.locator('[data-testid="char-attr-points"]');
  await expect(points).toHaveText('1 attribute point to spend');
  await expect(page.locator('[data-testid="character-stats"]')).toContainText('♥ 176/176 HP');

  // A cancelled sheet spends nothing.
  await page.locator('[data-testid="char-attr-vigor-plus"]').click();
  await expect(page.locator('[data-testid="confirm-sheet"]')).toContainText('Spend a point on Vigor?');
  await expect(page.locator('[data-testid="confirm-sheet"]')).toContainText('Points cannot be moved later.');
  await page.locator('[data-testid="confirm-no"]').click();
  await expect(points).toHaveText('1 attribute point to spend');

  await page.locator('[data-testid="char-attr-vigor-plus"]').click();
  await page.locator('[data-testid="confirm-yes"]').click();
  await expect(points).toHaveCount(0);
  await expect(page.locator('[data-testid="char-attr-vigor-plus"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="character-stats"]')).toContainText('♥ 184/184 HP');
  const vigor = await page.evaluate(() => window.__reallm.save().current?.player.attributes['vigor']);
  expect(vigor).toBe(6);
});

test('8. damage: a marine 6/5/1/1 at level 17 with the Lithium Edge reads 72', async ({ page }) => {
  await start(page, '/?debug');
  await newSave(page, { level: 17, xp: 8_400, primary: 'weapon_lithium' });
  await station(page, 'character');
  await expect(page.locator('[data-testid="character-stats"]')).toContainText('⚔ 72 damage');
});

test('9. quartermaster: its effect is on shop prices, not craft', async ({ page }) => {
  await start(page, '/?debug');
  await newSave(page);
  await station(page, 'shop');
  await page.locator('[data-testid="shop-tab-companions"]').click();
  const row = page.locator('[data-testid="shop-companion-quartermaster"]');
  await expect(row).toContainText('−5 % shop prices');
  await expect(row).toContainText('shop prices');
  await expect(row).not.toContainText('craft');
});
