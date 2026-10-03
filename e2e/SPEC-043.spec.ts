// SPEC-043 §6.2 — missions worth replaying, in the browser: a bonus on the
// board, a contract's label and badge, a contract played on Cinder-4 (its
// modifier in force, its banner row, its 20 lithium), a bonus earned and a
// bonus missed, the hard difficulty from Settings, on a boss and from
// creation, and a best time recorded on the surface and shown on the board.
// The words and the numbers are pinned in node (`tests/ui/helpers.test.ts`,
// `tests/systems/missions.test.ts`); what this proves is the wiring.
//
// Each case binds a fresh save through the save bridge, edits it in memory,
// and lands with `__reallm.go('surface', { planet: 'cinder4', firstLanding:
// false }, { force: true })` on a `?debug` page, whose strip compresses time.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const URL = '/?debug&seed=123';

/** `CONTRACTS`' names by id — `e2e/` may not import `src/`. */
const CONTRACT_NAMES: Readonly<Record<string, string>> = {
  elite_surge: 'Elite surge',
  swarm: 'Swarm',
  storm_front: 'Storm front',
  no_cover: 'No cover',
};

/** `ENEMIES.dune_wurm.hp` (1,800) × hard's 1.25, rounded. */
const HARD_WURM_HP = Math.round(1800 * 1.25);

/** What `prepare` writes into the fresh slot-0 save before anything is entered. */
interface Prep {
  active?: string[];
  done?: string[];
  flags?: string[];
  difficulty?: string;
}

/** Chapter 1 finished, its interlude already watched — so the station plays no film. */
const CHAPTER_ONE_DONE: Prep = {
  done: ['c1_m1', 'c1_m2', 'c1_m3'],
  flags: ['c1_oil', 'chapter1_done', 'interlude1_seen'],
};

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

/** A debug-strip press in the page — no pointer, so nothing on top of the strip intercepts it. */
async function press(page: Page, id: string): Promise<void> {
  await page.evaluate((testId) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (button === null) throw new Error(`no ${testId} on the debug strip`);
    button.click();
  }, id);
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

async function prepare(page: Page, prep: Prep): Promise<void> {
  await page.evaluate(
    ({ creation, prep }) => {
      const bridge = window.__reallm.save();
      bridge.create(0, { ...creation, difficulty: prep.difficulty ?? creation.difficulty }, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      if (prep.done !== undefined) save.progress.missionsDone = [...prep.done];
      if (prep.flags !== undefined) save.progress.flags = [...prep.flags];
      if (prep.active !== undefined) save.progress.missionsActive = prep.active.map((id) => ({ id, stage: 0, counters: {} }));
    },
    { creation: CREATION, prep },
  );
}

/** Lands the bound save on Cinder-4 through the scene machine, past any first line. */
async function landNow(page: Page): Promise<void> {
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
  await expect(page.getByTestId('scene-label')).toHaveText('surface', COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
  await dismiss(page);
}

/** A fresh save prepared by `prep`, landed on Cinder-4 with the debug strip up. */
async function land(page: Page, prep: Prep = {}): Promise<void> {
  await start(page, URL);
  await prepare(page, prep);
  await landNow(page);
}

/** The station's mission board, for the save already bound. */
async function board(page: Page): Promise<void> {
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await expect(page.getByTestId('scene-label')).toHaveText('station', COLD_START);
  await dismiss(page);
  await page.getByTestId('station-tab-missions').click();
  await expect(page.getByTestId('mission-board')).toBeVisible();
}

/**
 * `surface-finish-stage` until `id` has left `missionsActive` — completed. A
 * replay is in `missionsDone` before it starts, so that list cannot say so.
 */
async function finish(page: Page, id: string): Promise<void> {
  const done = (): Promise<boolean> =>
    page.evaluate(
      (mission) => window.__reallm.save().current?.progress.missionsActive.every((entry) => entry.id !== mission) === true,
      id,
    );
  expect(await done(), `${id} is not running`).toBe(false);
  for (let i = 0; i < 6 && !(await done()); i++) {
    await press(page, 'surface-finish-stage');
    await page.waitForTimeout(250);
  }
  await expect.poll(done).toBe(true);
}

/** Auto-fire off before boot, so nothing the player shoots drops lithium of its own. */
async function autoFireOff(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ version: 1, autoFire: 'off' })));
}

// ---------------------------------------------------------------- 1: board

test('1. a new save’s board shows c1_m2’s bonus, and none on c1_m1', async ({ page }) => {
  await start(page, URL);
  await prepare(page, {});
  await board(page);
  await expect(page.getByTestId('mission-c1_m2-bonus')).toHaveText('Bonus: Under 4:00 → +2 Frag Grenade');
  await expect(page.getByTestId('mission-c1_m3-bonus')).toHaveText('Bonus: No deaths → +1 Demolition Charge');
  await expect(page.getByTestId('mission-c1_m1-bonus')).toHaveCount(0);
});

// ------------------------------------------------------------ 2: contracts

test.describe('2. the contract label', () => {
  test('a finished chapter’s replay is a contract: its label on the button, its name in the badge', async ({ page }) => {
    await start(page, URL);
    await prepare(page, CHAPTER_ONE_DONE);
    await board(page);
    const replay = page.getByTestId('mission-c1_m2-replay');
    await expect(replay).toHaveText(/^Contract · (Elite surge|Swarm|Storm front|No cover) · 75 % \+ 20 lithium$/);
    const badge = page.getByTestId('mission-c1_m2-contract');
    const name = (await badge.textContent()) ?? '';
    expect(Object.values(CONTRACT_NAMES)).toContain(name);
    await expect(replay).toHaveText(`Contract · ${name} · 75 % + 20 lithium`);
    // The blurb rides as its title; the rewards line is the contract's payout.
    expect(((await badge.getAttribute('title')) ?? '').length).toBeGreaterThan(0);
    await expect(page.getByTestId('mission-c1_m2').locator('.board-rewards')).toHaveText('+112 XP · +11 ◈ · +20 lithium');
  });

  test('without chapter1_done the replay keeps its wording', async ({ page }) => {
    await start(page, URL);
    await prepare(page, { done: ['c1_m1', 'c1_m2'] });
    await board(page);
    // SPEC-044 §4.11: a plain replay sits in the planet's Completed fold, and
    // its badge reads `50 % rewards`.
    await page.getByTestId('board-done-cinder4').locator('summary').click();
    await expect(page.getByTestId('mission-c1_m2-replay')).toHaveText(/^Replay/);
    await expect(page.getByTestId('mission-c1_m2-replay')).toContainText('50 % rewards');
    await expect(page.getByTestId('mission-c1_m2-contract')).toHaveCount(0);
  });
});

test('3. a contract accepted at the board runs its modifier on Cinder-4, and pays its row and 20 lithium', async ({ page }) => {
  test.setTimeout(150_000);
  await autoFireOff(page);
  await start(page, URL);
  await prepare(page, CHAPTER_ONE_DONE);
  await board(page);
  const name = (await page.getByTestId('mission-c1_m2-contract').textContent()) ?? '';
  const id = Object.keys(CONTRACT_NAMES).find((key) => CONTRACT_NAMES[key] === name);
  expect(id, `a contract named ${name}`).toBeDefined();
  await page.getByTestId('mission-c1_m2-replay').click();
  expect(await page.evaluate(() => window.__reallm.save().current?.progress.missionsActive.map((entry) => entry.id))).toEqual(['c1_m2']);

  await landNow(page);
  // The modifier the board named is the one in force for this landing.
  await expect.poll(async () => String((await sceneInfo(page))['contract'])).toBe(id);

  const lithium = (): Promise<number> => page.evaluate(() => window.__reallm.save().current?.resources['lithium'] ?? NaN);
  const before = await lithium();
  await finish(page, 'c1_m2');
  await expect(page.getByTestId('mission-complete-contract')).toHaveText(`Contract · ${name}`);
  await expect(page.getByTestId('mission-complete-rewards')).toHaveText('+112 XP · +11 tokens · +20 lithium · contract');
  expect(await lithium()).toBe(before + 20);
  // The contract leaves with its mission.
  await expect.poll(async () => String((await sceneInfo(page))['contract'])).toBe('-');
});

// --------------------------------------------------------------- 4, 5: bonus

test('4. c1_m3 finished with no death earns its bonus: the banner row, and the charge in the pack', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page, { done: ['c1_m1', 'c1_m2'], active: ['c1_m3'] });
  const charges = (): Promise<number> =>
    page.evaluate(() => window.__reallm.save().current?.inventory.find((slot) => slot.itemId === 'demo_charge')?.qty ?? 0);
  expect(await charges()).toBe(0);
  await finish(page, 'c1_m3');
  await expect(page.getByTestId('mission-complete-bonus')).toHaveText('Bonus: No deaths — +1 Demolition Charge');
  await expect(page.getByTestId('mission-complete-time')).toHaveText(/^Time \d+:\d{2}$/);
  await expect(page.getByTestId('mission-complete-contract')).toBeHidden();
  expect(await charges()).toBe(1);
});

test('5. a death during c1_m3 misses its bonus', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page, { done: ['c1_m1', 'c1_m2'], active: ['c1_m3'] });
  const death = page.getByTestId('death-overlay');
  for (let i = 0; i < 12 && !(await death.isVisible()); i++) {
    await press(page, 'surface-hurt');
    await page.waitForTimeout(400);
  }
  await expect(death).toBeVisible();
  // The 2.5 s auto-respawn, then the stages.
  await expect(death).toBeHidden({ timeout: 15_000 });
  await finish(page, 'c1_m3');
  await expect(page.getByTestId('mission-complete-bonus')).toHaveText('Bonus missed: No deaths');
  expect(await page.evaluate(() => window.__reallm.save().current?.inventory.some((slot) => slot.itemId === 'demo_charge'))).toBe(false);
});

// -------------------------------------------------------------------- 6: hard

test('6. Settings switches the run to hard, and the Wurm then wakes with 1.25× its HP', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page, { done: ['c1_m1'] });
  expect((await sceneInfo(page))['difficulty']).toBe('normal');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.getByTestId('pause-settings').click();
  const hard = page.getByTestId('settings-difficulty-hard');
  await expect(hard).toHaveText('Hard');
  await hard.click();
  await expect(hard).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('settings-difficulty-line')).toHaveText(
    'Hard — tougher, deadlier hostiles and twice the elites; a death costs a fifth of your cargo.',
  );
  expect(await page.evaluate(() => window.__reallm.save().current?.meta.difficulty)).toBe('hard');
  expect((await sceneInfo(page))['difficulty']).toBe('hard');
  await page.getByTestId('settings-close').click();
  await page.getByTestId('pause-resume').click();
  await expect(page.getByTestId('pause-menu')).toBeHidden();

  // The next spawn reads the new rules: the boss comes in at round(1800 × 1.25).
  await press(page, 'surface-spawn-boss');
  await expect.poll(async () => String((await sceneInfo(page))['boss'])).toMatch(new RegExp(`^p\\d+ \\d+/${HARD_WURM_HP}$`));
  // Hard doubles the ambient elite chance: Cinder-4's 0.05 reads 0.1. The roll
  // takes the difficulty on the next step's spawn, and a boss woken from the
  // strip between steps does not wait for one — a fast runner reads it first.
  await expect.poll(async () => Number((await sceneInfo(page))['eliteChance'])).toBeCloseTo(0.1, 6);
});

test('6. creation’s difficulty-hard makes a hard save', async ({ page }) => {
  await start(page, URL);
  await page.evaluate(() => window.__reallm.go('creation', { slot: 0 }));
  await expect(page.getByTestId('creation-name')).toBeVisible(COLD_START);
  await page.getByTestId('class-marine').click();
  const hard = page.getByTestId('difficulty-hard');
  await expect(hard).toHaveText('Hard');
  await hard.click();
  await expect(page.getByTestId('difficulty-hard')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.creation-difficulty .settings-note')).toHaveText(
    'Hard — tougher, deadlier hostiles and twice the elites; a death costs a fifth of your cargo.',
  );
  await page.getByTestId('creation-confirm').click();
  await expect.poll(() => page.evaluate(() => window.__reallm.save().current?.meta.difficulty ?? null)).toBe('hard');
});

// --------------------------------------------------------------- 7: best time

test('7. c1_m2 accepted on the pad and finished records a best time, which the board then shows', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page, { done: ['c1_m1'] });
  await press(page, 'surface-goto-pad');
  const terminal = page.getByTestId('pad-terminal');
  for (let i = 0; i < 5 && !(await terminal.isVisible()); i++) {
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(400);
  }
  await expect(terminal).toBeVisible();
  await page.getByTestId('terminal-accept-c1_m2').click();
  await dismiss(page);
  await page.getByTestId('terminal-close').click();
  await expect(terminal).toBeHidden();
  await dismiss(page);

  await finish(page, 'c1_m2');
  await expect(page.getByTestId('mission-complete-time')).toHaveText(/^Time \d+:\d{2}$/);
  const best = (): Promise<unknown> =>
    page.evaluate(() => (JSON.parse(localStorage.getItem('reallm:settings') ?? '{}') as { bestTimes?: Record<string, unknown> }).bestTimes?.['c1_m2']);
  await expect.poll(best).toEqual(expect.any(Number));
  const seconds = Number(await best());
  expect(Number.isInteger(seconds) && seconds >= 1).toBe(true);

  await board(page);
  // SPEC-044 §4.11: the finished mission is in Cinder-4's Completed fold.
  await page.getByTestId('board-done-cinder4').locator('summary').click();
  const minutes = Math.floor(seconds / 60);
  await expect(page.getByTestId('mission-c1_m2-best')).toHaveText(`Best ${minutes}:${String(seconds % 60).padStart(2, '0')}`);
});
