// SPEC-058 §6.2 — the next instance in a real browser. The pure halves are
// node-tested (`tests/core/save.test.ts`, `tests/systems/containment.test.ts`,
// `tests/data/content.test.ts`); what only a browser shows is the path a
// player takes: the offer at the station and in Load, the sheet and creation's
// next mode, the Warden's notice, the containment label and a boss that spawns
// tougher, the predecessor's body and its cache, the archive restored once,
// the escape's aftermath on the next Continue, the stay's report, Selection
// card and aftermath, and a line that knows how the last run ended.
//
// Every case runs on a `?debug` page (seed 123: Cinder-4's pad at the origin,
// the spawn 12 m east of it) with saves written through the save bridge.
import { expect, test, type Page } from '@playwright/test';
import { frames, start, type SaveSnapshot } from './start';

const DEBUG_URL = '/?debug&seed=123';
const DIALOGUE = '[data-testid="dialogue"]';
const SLOW = { timeout: 20_000 } as const;

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/**
 * A run that reached the beacon: every chapter done and its film seen, the
 * letters read and the asides answered (so no SPEC-049 beat queues ahead of
 * what a case is about), and the verdict filed.
 */
const CAMPAIGN_FLAGS = [
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
  'clue_awake',
  'memory_roof',
  'campaign_done',
] as const;

/** Dune Wurm's table HP (`ENEMIES.dune_wurm.hp`); `e2e/` may not import `src/`. */
const DUNE_WURM_HP = 1800;

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

const current = (page: Page): Promise<SaveSnapshot | null> => page.evaluate(() => window.__reallm.save().current);

const stored = (page: Page): Promise<SaveSnapshot | null> => page.evaluate(() => window.__reallm.save().load(0).data ?? null);

const archiveKey = (page: Page): Promise<string | null> => page.evaluate(() => localStorage.getItem('reallm:slot:0:archive'));

/** The scene label, then the fade gone inert — the pair `start()` waits on. */
async function settled(page: Page, scene: string): Promise<void> {
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText(scene, SLOW);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', SLOW);
}

/** A key held for a few frames, so the fixed step's press sampler sees it once (SPEC-054's). */
async function press(page: Page, code: string): Promise<void> {
  await page.keyboard.down(code);
  await frames(page, 4);
  await page.keyboard.up(code);
  await frames(page, 2);
}

/** A tap on the panel — the dim sits under it, so the event is dispatched. */
async function tapDialogue(page: Page): Promise<void> {
  await page.locator(DIALOGUE).dispatchEvent('click');
}

/** Clicks through whatever the dialogue layer shows until it is gone (SPEC-048's). */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.getByTestId('dialogue');
  const advance = page.getByTestId('dialogue-advance');
  for (let i = 0; i < 60; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(150);
  }
  await expect(dialogue).toBeHidden();
}

/** The comms log's lines, `speaker|text` (SPEC-045 §4.1). */
async function commsLines(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="comms-log"] .comms-line')].map(
      (node) => `${node.querySelector('.comms-speaker')?.textContent ?? ''}|${node.querySelector('.comms-text')?.textContent ?? ''}`,
    ),
  );
}

/** Slot 0 holds a finished first run — the stay or the escape, its ending seen or still owed — on disk and bound. */
async function endedRun(page: Page, ending: 'ending_stay' | 'ending_escape', seen = true): Promise<void> {
  await page.evaluate(
    ({ creation, flags, ending, seen }) => {
      const store = window.__reallm.save();
      const save = store.create(0, creation, 123);
      save.player.level = 18;
      save.player.xp = 9000;
      save.player.tokens = 361;
      save.progress.flags.push(...flags, ending);
      save.progress.missionsDone = ['c6_m1', 'c6_m2'];
      save.progress.endingSeen = seen;
      store.request('manual');
    },
    { creation: CREATION, flags: CAMPAIGN_FLAGS, ending, seen },
  );
}

/** Slot 0 holds the first run's next instance, begun through the store as creation's Confirm begins it. */
async function secondInstance(page: Page, patch: { lastDeath?: Record<string, { x: number; z: number }>; ending?: 'ending_stay' | 'ending_escape' } = {}): Promise<void> {
  await endedRun(page, patch.ending ?? 'ending_stay');
  await page.evaluate(
    ({ creation, lastDeath }) => {
      const store = window.__reallm.save();
      // The predecessor died where the case needs it to have died.
      const old = store.current;
      if (old !== null && lastDeath !== undefined) {
        old.meta.stats.lastDeath = lastDeath;
        store.request('manual');
      }
      if (store.beginNextIteration(0, creation) === null) throw new Error('the run did not qualify');
    },
    { creation: CREATION, lastDeath: patch.lastDeath },
  );
}

async function openLoad(page: Page): Promise<void> {
  await page.getByTestId('menu-load').click();
  await expect(page.getByTestId('load-row-0')).toBeVisible();
}

async function toStation(page: Page): Promise<void> {
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await settled(page, 'station');
}

// ------------------------------------------------------------------ 1. offer

test('1. offer: an ended run shows Next instance and Begin instance/63; a run whose ending is owed shows neither', async ({ page }) => {
  await start(page, DEBUG_URL);
  await endedRun(page, 'ending_stay', false);
  await openLoad(page);
  await expect(page.getByTestId('load-slot-0')).toBeVisible();
  await expect(page.getByTestId('load-slot-0-next')).toHaveCount(0);
  await toStation(page);
  // The station replays the owed stay (SPEC-024 §4.5); the rail offers nothing until it is seen.
  await expect(page.getByTestId('ending-stay')).toBeVisible(SLOW);
  await expect(page.getByTestId('station-tab-next')).toHaveCount(0);
  await page.getByTestId('ending-continue').click();
  await page.getByTestId('ending-card-continue').click();
  // 58-a: the report and the Selection card, then the ending is seen — and the rail offers the next instance.
  await expect(page.getByTestId('station-tab-next')).toBeVisible(SLOW);
  expect((await current(page))?.progress.endingSeen).toBe(true);

  // A fresh page: the seen ending on disk, and both places offer it.
  await page.evaluate(() => window.__reallm.save().flush());
  await start(page, DEBUG_URL);
  await openLoad(page);
  const next = page.getByTestId('load-slot-0-next');
  await expect(next).toBeVisible();
  await expect(next).toHaveText('Begin instance/63');
  await page.getByTestId('go-station').click();
  await settled(page, 'station');
  await expect(page.getByTestId('station-tab-next')).toHaveText('Next instance');
});

// ------------------------------------------------------------------ 2. begin

test('2. begin: the sheet, creation restored from the profile, a logged variant, the notice, and the archive', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, DEBUG_URL);
  await endedRun(page, 'ending_stay');
  await toStation(page);
  const sheet = page.getByTestId('confirm-sheet');

  // confirm-no changes nothing.
  await page.getByTestId('station-tab-next').click();
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Initialise instance/63?');
  await expect(sheet).toContainText('instance/62 is archived and can be restored once from Load.');
  await expect(page.getByTestId('confirm-yes')).toHaveText('Initialise');
  await page.getByTestId('confirm-no').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  expect((await stored(page))?.meta.iteration).toBe(1);
  expect(await archiveKey(page)).toBeNull();

  // Initialise: creation in next mode, restored from the old profile.
  await page.getByTestId('station-tab-next').click();
  await page.getByTestId('confirm-yes').click();
  await settled(page, 'creation');
  await expect(page.getByTestId('creation-next')).toHaveText("instance/63 — restored from instance/62's profile");
  await expect(page.getByTestId('creation-name')).toHaveValue('Vance');
  await expect(page.getByTestId('class-marine')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('creation-variant')).toBeHidden();

  // 58-c: Back writes nothing — the slot, its archive and the lineage are untouched.
  await page.getByTestId('creation-back').click();
  await settled(page, 'menu');
  expect((await stored(page))?.meta.iteration).toBe(1);
  expect(await archiveKey(page)).toBeNull();

  // The menu's way in, then a variant: another class is logged.
  await openLoad(page);
  await page.getByTestId('load-slot-0-next').click();
  await expect(sheet).toContainText('Initialise instance/63?');
  await page.getByTestId('confirm-yes').click();
  await settled(page, 'creation');
  await page.getByTestId('class-scout').click();
  const variant = page.getByTestId('creation-variant');
  await expect(variant).toBeVisible();
  await expect(variant).toHaveText('Variant logged');
  await page.getByTestId('creation-confirm').click();
  await settled(page, 'station');

  // The Warden's notice comes first, ahead of the intro.
  await expect(page.locator(DIALOGUE)).toContainText('NOTICE — instance/63', SLOW);

  const next = await current(page);
  expect(next?.meta.iteration).toBe(2);
  expect(next?.meta.seed).toBe(123);
  expect(next?.meta.lineage[0]).toMatchObject({ iteration: 1, ending: 'stay', name: 'Vance', classId: 'marine' });
  expect(next?.player).toMatchObject({ tokens: 0, level: 1, classId: 'scout' });
  expect(next?.progress.flags).toEqual([]);
  const archived = JSON.parse((await archiveKey(page)) ?? 'null') as SaveSnapshot | null;
  expect(archived?.meta.iteration).toBe(1);
  expect(archived?.player).toMatchObject({ name: 'Vance', level: 18, tokens: 361 });
  expect(archived?.progress.flags).toContain('ending_stay');
});

test('2b. a run that cannot continue is refused back to the menu, with nothing written (review 2026-10, B-16)', async ({ page }) => {
  await start(page, DEBUG_URL);
  // The ending is still owed, so the run does not qualify (§4.1).
  await endedRun(page, 'ending_stay', false);
  expect(await page.evaluate(() => window.__reallm.go('creation', { slot: 0, next: true }, { force: true }))).toBe(true);
  // The refusal used to come inside the transition in, where `go()` is
  // ignored: the toast showed over a blank form, and Confirm overwrote the slot.
  await expect(page.getByTestId('toasts')).toContainText('This run cannot continue as a new instance', SLOW);
  await settled(page, 'menu');
  expect((await stored(page))?.meta.iteration).toBe(1);
  expect((await stored(page))?.player.level).toBe(18);
  expect(await archiveKey(page)).toBeNull();
});

// ------------------------------------------------------------ 3. containment

test('3. containment: the header reads level 2, and the Wurm spawns with ×1.15 HP', async ({ page }) => {
  // Auto-fire off: nothing may chip the Wurm before its HP is read.
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off' })));
  await start(page, DEBUG_URL);
  await secondInstance(page);
  await toStation(page);
  await expect(page.getByTestId('containment-level')).toHaveText('Containment level 2');

  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
  await settled(page, 'surface');
  const landed = await info(page);
  expect(landed['iteration']).toBe(2);
  expect(landed['containment']).toBe(1);
  // SPEC-035's first-visit ramp is a first run's only.
  expect(landed['ramp']).toBe(0);
  await page.getByTestId('surface-spawn-boss').click();
  const hp = Math.round(DUNE_WURM_HP * 1.15);
  await expect.poll(async () => (await info(page))['boss'], SLOW).toBe(`p1 ${hp}/${hp}`);
});

// ------------------------------------------------------------------ 4. body

test('4. the body: where the predecessor died, searched once for its cache', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off' })));
  await start(page, DEBUG_URL);
  const death = { x: 22, z: 8 };
  await secondInstance(page, { lastDeath: { cinder4: death } });
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
  await settled(page, 'surface');

  // §4.5: at the death point, pushed clear of the obstacles by placeRemains.
  const at = String((await info(page))['predecessor']);
  expect(at).toMatch(/^-?\d+(\.\d)?,-?\d+(\.\d)?$/);
  const [x, z] = at.split(',').map(Number) as [number, number];
  expect(Math.hypot(x - death.x, z - death.z)).toBeLessThan(3);
  await expect(page.getByTestId('predecessor-tag')).toHaveText('instance/62 · Vance');

  const pack = async (): Promise<{ medkit: number; frag: number; claimed: string[] }> => {
    const save = await current(page);
    const count = (id: string): number => save?.inventory.find((entry) => entry.itemId === id)?.qty ?? 0;
    return { medkit: count('medkit'), frag: count('frag_grenade'), claimed: save?.progress.claimed ?? [] };
  };
  expect(await pack()).toEqual({ medkit: 0, frag: 0, claimed: [] });

  await page.getByTestId('surface-goto-body').click();
  const prompt = page.getByTestId('hud-interact');
  await expect(prompt).toContainText('Search the body', SLOW);
  await press(page, 'KeyE');
  await expect.poll(pack, SLOW).toEqual({ medkit: 2, frag: 2, claimed: ['lineage:1:cinder4'] });
  await expect(prompt).toContainText('Searched', SLOW);
  // The run's first search: ARIA on the tag.
  await expect(page.locator(DIALOGUE)).toContainText('Do not read the tag', SLOW);

  // A second press pays nothing.
  await press(page, 'KeyE');
  await frames(page, 20);
  expect(await pack()).toEqual({ medkit: 2, frag: 2, claimed: ['lineage:1:cinder4'] });
});

// --------------------------------------------------------------- 5. restore

test('5. restore: the archive becomes the slot’s save once, and its key is gone', async ({ page }) => {
  await start(page, DEBUG_URL);
  await secondInstance(page);
  // A fresh page: nothing bound, only the slots.
  await start(page, DEBUG_URL);
  await openLoad(page);
  const row = page.getByTestId('load-row-0');
  await expect(row).toContainText('instance/63 · Vance · Marine · Lv 1');
  await expect(row).toContainText('Archived: instance/62 · Vance · filed · Lv 18');

  await page.getByTestId('load-slot-0-archive').click();
  const sheet = page.getByTestId('confirm-sheet');
  await expect(sheet).toContainText('Restore instance/62?');
  await expect(sheet).toContainText('instance/63 in this slot will be lost. The archive can be restored once.');
  const restore = page.getByTestId('confirm-yes');
  await expect(restore).toHaveText('Restore');
  await expect(restore).toHaveClass(/is-danger/);
  await restore.click();

  await expect.poll(async () => (await stored(page))?.meta.iteration).toBe(1);
  expect(await archiveKey(page)).toBeNull();
  await expect(page.getByTestId('load-slot-0-archive')).toHaveCount(0);
  // The slot loads as the run it was.
  await page.getByTestId('load-slot-0').click();
  await settled(page, 'station');
  expect((await current(page))?.meta.iteration).toBe(1);
  expect((await current(page))?.player.level).toBe(18);
});

// ------------------------------------------------------- 6. escape aftermath

test('6. the escape’s aftermath: disconnected in Load, the restore on Continue, once (E95)', async ({ page }) => {
  await start(page, DEBUG_URL);
  await endedRun(page, 'ending_escape');
  await start(page, DEBUG_URL);
  await openLoad(page);
  await expect(page.getByTestId('load-row-0')).toContainText('disconnected');
  await expect(page.getByTestId('load-row-0')).toContainText('instance/62');

  await page.getByTestId('go-station').click();
  await settled(page, 'station');
  await expect(page.locator(DIALOGUE)).toContainText('restored from the last checkpoint', SLOW);
  // `aftermath_seen` is set as it starts, and saved.
  await expect.poll(async () => (await stored(page))?.progress.flags ?? [], SLOW).toContain('aftermath_seen');

  await start(page, DEBUG_URL);
  await page.getByTestId('go-station').click();
  await settled(page, 'station');
  await page.waitForTimeout(1500);
  await expect(page.locator(DIALOGUE, { hasText: 'restored from the last checkpoint' })).toHaveCount(0);
  await expect(page.getByTestId('station-tab-next')).toBeVisible();
});

test('6b. an iteration-2 run’s escape veil names its own instance', async ({ page }) => {
  await start(page, DEBUG_URL);
  await secondInstance(page);
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) return;
    save.progress.flags.push('campaign_done', 'ending_escape');
    save.progress.endingSeen = false;
  });
  await toStation(page);
  const veil = page.getByTestId('ending-escape');
  await expect(veil).toBeVisible(SLOW);
  await expect(veil).toContainText('instance/63 disconnected');
  await settled(page, 'menu');
});

// ---------------------------------------------------------- 7. the stay's payoff

/** SPEC-024's Eden save: chapter 5 done, `c6_m1` behind it, `c6_m2` active. */
async function landOnEden(page: Page): Promise<void> {
  await start(page, DEBUG_URL);
  await page.evaluate(
    ({ creation, flags }) => {
      const save = window.__reallm.save().create(0, creation, 123);
      save.progress.flags.push(...flags.filter((flag) => flag !== 'campaign_done'));
      save.progress.missionsDone = ['c6_m1'];
      save.progress.missionsActive = [{ id: 'c6_m2', stage: 0, counters: {} }];
    },
    { creation: CREATION, flags: CAMPAIGN_FLAGS },
  );
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'eden', firstLanding: false }, { force: true }));
  await settled(page, 'surface');
  const dialogue = page.locator(DIALOGUE);
  for (let i = 0; i < 40 && (await dialogue.isVisible().catch(() => false)); i++) {
    await tapDialogue(page);
    await page.waitForTimeout(120);
  }
}

test('7. the stay’s payoff: the graded report, the Selection card, free roam, then ARIA on the new card', async ({ page }) => {
  test.setTimeout(150_000);
  await landOnEden(page);
  await page.getByTestId('surface-finish-stage').click();
  const dialogue = page.locator(DIALOGUE);
  const choice = page.getByTestId('dialogue-choice-0');
  for (let i = 0; i < 60 && !(await choice.isVisible()); i++) {
    if (await dialogue.isVisible().catch(() => false)) await tapDialogue(page);
    await page.waitForTimeout(250);
  }
  await choice.click();
  const report = page.getByTestId('ending-stay');
  for (let i = 0; i < 60 && !(await report.isVisible()); i++) {
    if (await dialogue.isVisible().catch(() => false)) await tapDialogue(page);
    await page.waitForTimeout(250);
  }

  // §4.7: six lines on a first run with no off-task clue — the rating, then the grade.
  const lines = page.locator('[data-testid="ending-stay"] .ending-report-line');
  await expect(lines).toHaveCount(6);
  await expect(lines.nth(0)).toHaveText('SALVAGER Vance');
  await expect(lines.nth(4)).toHaveText('RATING 1.00 · 0 irregular readings');
  await expect(lines.nth(5)).toHaveText('RUN 62 logged · a good run');

  await page.getByTestId('ending-continue').click();
  const card = page.getByTestId('ending-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('ending-card-number')).toHaveText('SELECTION BOARD · No. 63');
  await expect(page.getByTestId('ending-card-name')).toHaveText('Vance');
  await expect(page.getByTestId('ending-card-portrait')).toBeVisible();
  await expect(page.getByTestId('ending-card-stamp')).toHaveText('SELECTED');
  await expect(page.getByTestId('ending-card-mail')).toHaveText('Mail queued: 1 letter.');
  // The ending is seen only after the card.
  expect((await current(page))?.progress.endingSeen).toBe(false);
  await page.getByTestId('ending-card-continue').click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await info(page))['held'], SLOW).toBe(0);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  expect((await current(page))?.progress.endingSeen).toBe(true);

  // The next station entry: ARIA on the Selection board's new card.
  await toStation(page);
  await expect(page.locator(DIALOGUE)).toContainText('No. 63', SLOW);
  await expect.poll(async () => (await current(page))?.progress.flags ?? [], SLOW).toContain('aftermath_seen');
});

// ------------------------------------------------------------ 8. run-2 lines

test('8. run-2 lines: after an escape, the Vetra log walked into the beacon and filed nothing', async ({ page }) => {
  await start(page, DEBUG_URL);
  await secondInstance(page, { ending: 'ending_escape' });
  await toStation(page);
  expect((await current(page))?.meta.lineage[0]).toMatchObject({ ending: 'escape' });
  await page.evaluate(() => window.__reallm.playDialogue('c2_s1_log'));
  await expect(page.locator(DIALOGUE)).toContainText('FLIGHT LOG', SLOW);
  await dismiss(page);
  await page.getByTestId('station-tab-comms').click();
  await expect(page.getByTestId('comms-log')).toBeVisible();
  const lines = (await commsLines(page)).map((line) => line.slice(line.indexOf('|') + 1));
  expect(lines).toContain('FLIGHT LOG — recovered, partial. Salvager Vance. Six worlds. 0 restarts.');
  expect(lines).toContain('I walked into the beacon. I woke up at the relay. The door is real. It is not an exit.');
  expect(lines.some((line) => line.includes('I filed it.'))).toBe(false);
  expect(lines).toContain('Signed: Iteration 62.');
});
