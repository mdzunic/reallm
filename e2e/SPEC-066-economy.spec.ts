// SPEC-066 §6.10 cases 3–5 — the economy half of "pressure that holds", in a
// real browser. The rules and the words are pinned in node
// (`tests/systems/economy.test.ts`, `tests/systems/depot.test.ts`,
// `tests/ui/helpers.test.ts`, `tests/ui/deathOverlay.test.ts`); what this
// proves is the wiring a player reaches: the Cargo Racks row in the shop and
// the pack grid it grows, a boss contract's half token share on the board,
// and a hard death's tenth of the depot on the death overlay.
//
// Each case binds a fresh save through the save bridge and edits it in
// memory, as the SPEC-043 and SPEC-065 suites do.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, start, type SaveSnapshot } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** Films off, so no interlude stands between a case and its screen. */
const STATION_URL = '/?films=off&debug&seed=123';
const SURFACE_URL = '/?debug&seed=123';

/** What `prepare` writes into the fresh slot-0 save before anything is entered. */
interface Prep {
  difficulty?: string;
  tokens?: number;
  resources?: Record<string, number>;
  depot?: Record<string, number>;
  done?: string[];
  flags?: string[];
}

async function prepare(page: Page, prep: Prep): Promise<void> {
  await page.evaluate(
    ({ creation, prep }) => {
      const bridge = window.__reallm.save();
      bridge.create(0, { ...creation, difficulty: prep.difficulty ?? creation.difficulty }, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      if (prep.tokens !== undefined) save.player.tokens = prep.tokens;
      if (prep.resources !== undefined) save.resources = { ...prep.resources };
      for (const [resource, amount] of Object.entries(prep.depot ?? {})) save.depot.held[resource] = amount;
      if (prep.done !== undefined) save.progress.missionsDone = [...prep.done];
      if (prep.flags !== undefined) save.progress.flags = [...prep.flags];
    },
    { creation: CREATION, prep },
  );
}

const current = (page: Page): Promise<SaveSnapshot | null> => page.evaluate(() => window.__reallm.save().current);

/** The scene is up and its fade has let go, so a press lands. */
async function settle(page: Page, scene: string): Promise<void> {
  await expect(page.getByTestId('scene-label')).toHaveText(scene, COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
}

/** Click through any open dialogue line. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.getByTestId('dialogue');
  const advance = page.getByTestId('dialogue-advance');
  for (let i = 0; i < 30; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(120);
  }
}

/** The station for the save already bound, on `tab`. */
async function station(page: Page, tab: 'missions' | 'shop' | 'character'): Promise<void> {
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await settle(page, 'station');
  await dismiss(page);
  await page.getByTestId(`station-tab-${tab}`).click();
}

// ------------------------------------------------------------ 3: the racks

test('3. the racks: the cargo row sells pack slots, a buy grows the pack grid to 22, and the oil cap stays /400', async ({ page }) => {
  await start(page, STATION_URL);
  await prepare(page, { tokens: 200 });
  await station(page, 'shop');
  await page.getByTestId('shop-tab-ship').click();
  const row = page.getByTestId('shop-ship-cargo');
  await expect(row.locator('.shop-name')).toHaveText('Cargo Racks');
  await expect(page.getByTestId('shop-ship-cargo-role')).toHaveText('Pack slots, on every planet');
  await expect(row.locator('.shop-deltas')).toHaveText('Tier 0 → 1: Pack slots 20 → 22');

  // The pack grid draws the base 20 before the buy…
  await page.getByTestId('station-tab-character').click();
  await expect(page.locator('[data-testid="character-panel"] .inv-cell')).toHaveCount(20);

  await page.getByTestId('station-tab-shop').click();
  await page.getByTestId('shop-tab-ship').click();
  await page.getByTestId('shop-ship-cargo-buy').click();
  await page.getByTestId('confirm-yes').click();
  await expect(row.locator('.shop-deltas')).toHaveText('Tier 1 → 2: Pack slots 22 → 24');
  expect((await current(page))?.ship['cargo']).toBe(1);

  // …and 22 after it, while the hold's cap is still 400 (E123's flat cap).
  await page.getByTestId('station-tab-character').click();
  await expect(page.locator('[data-testid="character-panel"] .inv-cell')).toHaveCount(22);
  await expect(page.locator('.screen-status [data-testid="wallet-oil"] .wallet-cap')).toHaveText('/400');
});

// ------------------------------------------------- 4: a half-paid Queen

test('4. a half-paid Queen: the board labels a c5_m3 contract with both shares and pays +50 ◈', async ({ page }) => {
  await start(page, STATION_URL);
  await prepare(page, {
    done: ['c1_m1', 'c1_m2', 'c1_m3', 'c2_m1', 'c2_m2', 'c2_m3', 'c3_m1', 'c3_m2', 'c3_m3', 'c4_m1', 'c4_m2', 'c4_m3', 'c5_m1', 'c5_m2', 'c5_m3'],
    flags: [
      'chapter1_done',
      'chapter2_done',
      'chapter3_done',
      'chapter4_done',
      'chapter5_done',
      'interlude1_seen',
      'interlude2_seen',
      'interlude3_seen',
      'interlude4_seen',
      'interlude5_seen',
      'letter1_read',
      'letter2_read',
      'letter3_read',
      'letter4_read',
      'letter5_read',
    ],
  });
  await station(page, 'missions');
  await expect(page.getByTestId('mission-board')).toBeVisible();
  await expect(page.getByTestId('mission-c5_m3-replay')).toHaveText(/^Contract · .+ · 75 % XP, 50 % tokens \+ 20 lithium$/);
  await expect(page.getByTestId('mission-c5_m3').locator('.board-rewards')).toHaveText('+450 XP · +50 ◈ · +20 lithium');
  // A contract on a mission with no boss keeps R18's single share.
  await expect(page.getByTestId('mission-c5_m2-replay')).toHaveText(/^Contract · .+ · 75 % \+ 20 lithium$/);
});

// ------------------------------------------------ 5: hard at the depot

test('5. hard at the depot: a death on Cinder-4 takes a tenth of the depot, says so, and the remains carry the hold’s loss only', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Auto-fire off, so no kill drops anything into the hold before the death.
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off' })));
  await start(page, SURFACE_URL);
  await prepare(page, { difficulty: 'hard', resources: { oil: 200, wheat: 0, water: 0, lithium: 0 }, depot: { oil: 300 } });
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
  await settle(page, 'surface');
  await dismiss(page);

  // SPEC-057's case: 5 m out from the pad, so the respawn does not stand on the remains.
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="surface-goto-pad"]');
    if (button === null) throw new Error('no surface-goto-pad on the debug strip');
    button.click();
  });
  const death = page.getByTestId('death-overlay');
  for (let i = 0; i < 40 && !(await death.isVisible()); i++) {
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-testid="surface-hurt"]')?.click());
    await page.waitForTimeout(400);
  }
  await expect(death).toBeVisible();

  await expect(page.getByTestId('death-depot')).toHaveText('Depot lost: 30 oil');
  const save = await current(page);
  expect(save?.meta.difficulty).toBe('hard');
  expect(save?.depot.held['oil']).toBe(270);
  // Hard's fifth of the hold went to the remains, and nothing of the depot's tenth.
  expect(save?.resources['oil']).toBe(160);
  expect(save?.progress.remains?.resources).toEqual({ oil: 40 });
  await expect(page.getByTestId('death-remains')).toHaveText('Your pack holds 40 oil — reach it before you fall again.');

  // The overlay goes with the respawn, and the line with it.
  await expect(death).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('death-depot')).toHaveText('');
});
