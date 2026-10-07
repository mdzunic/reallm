// SPEC-056 §6.2 — the treasure in a real browser: Cinder-4's vault opened by
// its puzzle pays 5 tokens, racks the Last Word and plays instance/58's log;
// a later descent finds it opened and paying nothing (E89); the rack at the
// station equips the relic and takes it back; a locked blueprint and its
// craft; the Locker wearing an unlocked swatch; the shard in Notes; and a
// flare thrown in Vetra's dark. The rules are pinned in node —
// tests/systems/economy, combat, clues, tests/core/save, settings,
// tests/ui/helpers and tests/data/content (invariant 24); this proves the
// wiring. Each case runs on a `?debug` page with a save bound through the save
// bridge and `c1_m1` in `missionsDone`.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, frames, start } from './start';

// Lines land whole (typewriter off), so each press advances one.
test.use({ reducedMotion: 'reduce' });

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** The game runs at a fraction of the wall clock on a GPU-less container. */
const SLOW = { timeout: 90_000 } as const;

interface Prep {
  claimed?: string[];
  resources?: Record<string, number>;
  inventory?: Array<{ itemId: string; qty: number }>;
  quick?: Record<string, string | null>;
}

/** A fresh slot-0 save on seed 123, bound, with `c1_m1` done and `prep` written into it. */
async function prepare(page: Page, prep: Prep = {}): Promise<void> {
  await page.evaluate(
    ({ creation, prep }) => {
      const bridge = window.__reallm.save();
      bridge.create(0, creation, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      save.progress.missionsDone.push('c1_m1');
      if (prep.claimed !== undefined) save.progress.claimed.push(...prep.claimed);
      for (const [resource, amount] of Object.entries(prep.resources ?? {})) save.resources[resource] = amount;
      if (prep.inventory !== undefined) save.inventory.push(...prep.inventory);
      for (const [slot, itemId] of Object.entries(prep.quick ?? {})) save.quick[slot] = itemId;
    },
    { creation: CREATION, prep },
  );
}

async function settle(page: Page, scene: string): Promise<void> {
  await expect(page.getByTestId('scene-label')).toHaveText(scene, COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
}

/** Click through any open dialogue, as the other surface suites do. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.getByTestId('dialogue');
  const advance = page.getByTestId('dialogue-advance');
  for (let i = 0; i < 25; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

async function land(page: Page, planet: string): Promise<void> {
  await page.evaluate((id) => window.__reallm.go('surface', { planet: id }, { force: true }), planet);
  await settle(page, 'surface');
  await dismiss(page);
}

/** An entry through the bridge; the arrival line is moved on, so the tabs take a click. */
async function station(page: Page): Promise<void> {
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await settle(page, 'station');
  await expect(page.getByTestId('station-root')).toBeVisible();
  for (let i = 0; i < 12; i++) {
    if ((await page.locator('.dialogue-dim.is-visible').count()) === 0) break;
    await page.locator('.dialogue-dim.is-visible').click({ force: true });
    await page.waitForTimeout(150);
  }
}

async function info(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

async function untilInfo(page: Page, key: string, value: number | string): Promise<void> {
  await page.waitForFunction(
    ({ name, want }) => window.__reallm.stats().sceneInfo?.[name] === want,
    { name: key, want: value },
    { polling: 'raf', ...SLOW },
  );
}

/** A debug-strip button, clicked from script so no overlay can take the pointer. */
async function tap(page: Page, id: string): Promise<void> {
  await page.evaluate((testid) => {
    const button = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
    if (button === null) throw new Error(`the debug strip has no ${testid} button`);
    button.click();
  }, id);
}

/** One key press held across a few rendered frames, so a fixed step reads its edge. */
async function press(page: Page, code: string): Promise<void> {
  await page.keyboard.down(code);
  await frames(page, 4);
  await page.keyboard.up(code);
  await frames(page, 2);
}

async function descend(page: Page): Promise<void> {
  await tap(page, 'surface-descend');
  await untilInfo(page, 'level', 'underground');
  await untilInfo(page, 'held', 0);
}

async function untilClaimed(page: Page, cache: string): Promise<void> {
  await page.waitForFunction((id) => (window.__reallm.save().current?.progress.claimed ?? []).includes(id), cache, {
    polling: 'raf',
    ...SLOW,
  });
}

const tokens = (page: Page): Promise<number> => page.evaluate(() => window.__reallm.save().current?.player.tokens ?? -1);
const flags = (page: Page): Promise<string[]> => page.evaluate(() => [...(window.__reallm.save().current?.progress.flags ?? [])]);
const claimed = (page: Page): Promise<string[]> => page.evaluate(() => [...(window.__reallm.save().current?.progress.claimed ?? [])]);
const held = (page: Page, itemId: string): Promise<number> =>
  page.evaluate(
    (id) => (window.__reallm.save().current?.inventory ?? []).filter((slot) => slot.itemId === id).reduce((sum, slot) => sum + slot.qty, 0),
    itemId,
  );

/**
 * Every toast the rack shows, recorded as it lands (SPEC-054's suite does the
 * same): a toast lives 2.5 s, and a few slow frames can outlast it.
 */
async function recordToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rack = document.querySelector('[data-testid="toasts"]');
    if (rack === null) throw new Error('no toast rack');
    const shown: string[] = [];
    Object.assign(window, { __toastsShown: shown });
    new MutationObserver(() => {
      for (const node of Array.from(rack.children)) shown.push(node.textContent ?? '');
    }).observe(rack, { childList: true });
  });
}

async function toastShown(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (want) => ((window as unknown as { __toastsShown?: string[] }).__toastsShown ?? []).some((shown) => shown.includes(want)),
    text,
    SLOW,
  );
}

/** Advances the queue until a line holding `text` is up — the log may wait behind ARIA's. */
async function untilLine(page: Page, text: string): Promise<void> {
  const line = page.locator('[data-testid="dialogue"] .dialogue-text');
  const advance = page.getByTestId('dialogue-advance');
  for (let i = 0; i < 60; i++) {
    const shown = await page.evaluate(() => document.querySelector('[data-testid="dialogue"] .dialogue-text')?.textContent ?? '');
    if (shown.includes(text)) return;
    if (shown !== '' && (await advance.isVisible().catch(() => false))) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
  await expect(line).toContainText(text, SLOW);
}

test.describe('SPEC-056 treasure', () => {
  test.setTimeout(240_000);

  test('1, 2, 6: the Cinder-4 vault pays 5 tokens and a relic, plays instance/55’s log, pays nothing twice (E89), and Notes records the shard', async ({
    page,
  }) => {
    await start(page, '/?debug');
    await prepare(page);
    await land(page, 'cinder4');
    await recordToasts(page);
    const before = await tokens(page);
    await descend(page);
    expect((await info(page))['relics']).toBe(0);

    // Case 1: the vault, opened through its puzzle.
    await tap(page, 'surface-goto-vault');
    await frames(page, 4);
    await tap(page, 'surface-goto-puzzle');
    await frames(page, 4);
    await tap(page, 'surface-solve-puzzle');
    await untilClaimed(page, 'cinder4_vault');
    expect(await tokens(page)).toBe(before + 5);
    await toastShown(page, 'Cache opened · +5 ◈');
    await toastShown(page, 'Relic: Last Word');
    await toastShown(page, 'Archive shard');
    await untilInfo(page, 'relics', 1);
    // The log line, and the flag it sets as it starts.
    // Review 2026-10 S-28: the number is a card on the prologue's Selection wall.
    await untilLine(page, 'LOG — instance/55');
    await expect(page.locator('[data-testid="dialogue"] .dialogue-text')).toHaveText(
      'LOG — instance/55. I opened this lock in 0.3 seconds. Nobody with hands is that fast. I slowed down after that. Slow down.',
    );
    await expect.poll(() => flags(page), SLOW).toContain('shard_cinder4');
    // Review 2026-10 S-07: before the notice, ARIA's cover follows the log.
    await untilLine(page, 'Old survey crews numbered their logs. Some of them cracked out here. Leave it.');
    await dismiss(page);

    // Case 2: up and down again — the vault draws opened, and nothing pays twice.
    await tap(page, 'surface-ascend');
    await untilInfo(page, 'level', 'surface');
    await untilInfo(page, 'held', 0);
    await descend(page);
    expect(Number((await info(page))['cachesOpen'])).toBeGreaterThanOrEqual(1);
    expect(Number((await info(page))['claimed'])).toBeGreaterThanOrEqual(1);
    const after = await tokens(page);
    expect(after).toBe(before + 5);
    await tap(page, 'surface-goto-vault');
    await frames(page, 4);
    await press(page, 'KeyE');
    await tap(page, 'surface-goto-cache');
    await frames(page, 4);
    await press(page, 'KeyE');
    await frames(page, 20);
    expect(await tokens(page)).toBe(after);
    expect((await claimed(page)).filter((id) => id === 'cinder4_vault')).toHaveLength(1);
    expect((await flags(page)).filter((flag) => flag === 'shard_cinder4')).toHaveLength(1);
    await dismiss(page);

    // Case 6: the comms log's Notes tab lists the shard and counts it; the log played once.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('pause-comms').click();
    await expect(page.getByTestId('comms-log')).toBeVisible();
    const logLines = await page.evaluate(
      () => [...document.querySelectorAll('[data-testid="comms-log"] .comms-text')].filter((node) => (node.textContent ?? '').includes('instance/55')).length,
    );
    expect(logLines).toBe(1);
    await page.getByTestId('comms-tab-notes').click();
    await expect(page.getByTestId('notes-clue-shard_cinder4')).toContainText('Too fast for hands');
    await expect(page.getByTestId('notes-clue-shard_cinder4')).toContainText('instance/55 opened the lock in 0.3 seconds');
    await expect(page.getByTestId('notes-count')).toHaveText(/^Recorded [1-9]\d* of 26$/);
  });

  test('3: the rack — the relic equips from char-relics, never enters the pack, and returns to the rack when the pistol goes back on', async ({
    page,
  }) => {
    await start(page, '/?debug');
    await prepare(page, { claimed: ['cinder4_vault'] });
    await station(page);
    await page.getByTestId('station-tab-character').click();
    const rack = page.getByTestId('char-relics');
    await expect(rack).toBeVisible();
    const row = page.getByTestId('char-relic-relic_last_word');
    await expect(row).toContainText('Last Word');
    await expect(row).toContainText('Double damage to targets under 30 % health');
    const equip = page.getByTestId('char-relic-relic_last_word-equip');
    await expect(equip).toHaveText('Equip');
    await equip.click();
    await expect(page.getByTestId('char-relic-relic_last_word-equip')).toHaveText('Equipped');
    await expect(page.getByTestId('char-relic-relic_last_word-equip')).toBeDisabled();
    const worn = await page.evaluate(() => window.__reallm.save().current?.equipped.sidearm);
    expect(worn).toBe('relic_last_word');
    expect(await held(page, 'relic_last_word')).toBe(0);
    expect(await held(page, 'pistol_service')).toBe(1);
    // The worn relic's card says its twist.
    await expect(page.getByTestId('equipped-sidearm').getByTestId('gear-twist')).toHaveText('Double damage to targets under 30 % health');

    // The Service Pistol back on from the pack: the relic goes to the rack, not the pack.
    await page.getByTestId('loadout-change-sidearm').click();
    await page.getByTestId('equip-pistol_service').click();
    await expect.poll(() => page.evaluate(() => window.__reallm.save().current?.equipped.sidearm)).toBe('pistol_service');
    expect(await held(page, 'relic_last_word')).toBe(0);
    expect(await held(page, 'pistol_service')).toBe(0);
    await expect(page.getByTestId('char-relic-relic_last_word-equip')).toHaveText('Equip');
    await expect(page.getByTestId('char-relic-relic_last_word-equip')).toBeEnabled();
  });

  test('4: a blueprint — the flare is locked until vetra_loose_b is claimed, then crafts', async ({ page }) => {
    await start(page, '/?debug');
    await prepare(page, { resources: { oil: 60, wheat: 60 } });
    await station(page);
    await page.getByTestId('station-tab-shop').click();
    await page.getByTestId('shop-tab-craft').click();
    await expect(page.getByTestId('recipe-flare-locked')).toHaveText('Locked — found in a Vetra cave');
    await expect(page.getByTestId('recipe-stim-locked')).toHaveText('Locked — found in a Thessaly cave');
    await expect(page.getByTestId('shop-craft-flare-buy')).toHaveCount(0);

    // Claimed through the bridge; the tab re-renders.
    await page.evaluate(() => window.__reallm.save().current?.progress.claimed.push('vetra_loose_b'));
    await page.getByTestId('shop-tab-ship').click();
    await page.getByTestId('shop-tab-craft').click();
    await expect(page.getByTestId('recipe-flare-locked')).toHaveCount(0);
    await expect(page.getByTestId('recipe-stim-locked')).toBeVisible();
    await page.getByTestId('shop-craft-flare-buy').click();
    await page.getByTestId('confirm-yes').click();
    await expect.poll(() => held(page, 'flare')).toBe(1);
    const left = await page.evaluate(() => window.__reallm.save().current?.resources);
    expect([left?.['oil'], left?.['wheat']]).toEqual([55, 55]);
  });

  test('5: the Locker wears an unlocked swatch — locker-primary-c2703d sets appearance.primary', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('spec056-seeded') !== null) return;
      sessionStorage.setItem('spec056-seeded', '1');
      localStorage.setItem('reallm:settings', JSON.stringify({ unlocks: ['cinder4_relic'] }));
    });
    await start(page, '/?debug');
    await prepare(page);
    await station(page);
    await page.getByTestId('station-tab-character').click();
    const locker = page.getByTestId('char-locker');
    await expect(locker).toBeVisible();
    // The base eight of each part, then the unlocked colour.
    await expect(locker.locator('[data-testid^="locker-primary-"]')).toHaveCount(9);
    await expect(locker.locator('[data-testid^="locker-secondary-"]')).toHaveCount(9);
    await expect(locker.getByTestId('locker-secondary-3a1f0e')).toBeVisible();
    await expect(locker.locator('[data-testid^="locker-portrait-"]')).toHaveCount(6);
    await locker.getByTestId('locker-primary-c2703d').click();
    await expect
      .poll(() => page.evaluate(() => (window.__reallm.save().current?.player as unknown as { appearance: { primary: string } }).appearance.primary))
      .toBe('#c2703d');
    await expect(page.getByTestId('char-locker').getByTestId('locker-primary-c2703d')).toHaveAttribute('aria-pressed', 'true');
    // The portrait row writes the save too.
    await page.getByTestId('char-locker').getByTestId('locker-portrait-9').click();
    await expect
      .poll(() => page.evaluate(() => (window.__reallm.save().current?.player as unknown as { appearance: { portrait: number } }).appearance.portrait))
      .toBe(9);
  });

  test('7: a flare from the utility slot — C throws it underground on Vetra, and sceneInfo.flares reads 1', async ({ page }) => {
    await start(page, '/?debug');
    await prepare(page, { inventory: [{ itemId: 'flare', qty: 1 }], quick: { utility: 'flare' } });
    await land(page, 'vetra');
    await descend(page);
    const before = await info(page);
    expect(before['flares']).toBe(0);
    await press(page, 'KeyC');
    await untilInfo(page, 'flares', 1);
    expect(await held(page, 'flare')).toBe(0);
    // It lights the ground without a `THREE.Light`: the cave's light count holds (SPEC-054).
    expect((await info(page))['lights']).toBe(before['lights']);
  });
});
