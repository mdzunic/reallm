// SPEC-024 §6 — the campaign's last minute in a real browser: the choice
// intro read to its last line, both endings in order (dialogue → film →
// overlay), the replay a reload owes at the next station entry, the E24 lock
// on the board, and the whole sequence again with the films off.
//
// The suite opts into films (`gameUrl` appends `films=off` everywhere else)
// and aborts the MP4s, so the films run in SPEC-022's deterministic stills
// mode — the pictures are that spec's business, and what is under test here is
// what runs, in what order, and what it leaves in the save.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

test.use({ reducedMotion: 'no-preference' });

const DIALOGUE = '[data-testid="dialogue"]';
const FILM = '[data-testid="film"]';
const HUD = '[data-testid="hud"]';
const STAY = '[data-testid="ending-stay"]';
const ESCAPE = '[data-testid="ending-escape"]';
const MP4S = '**/assets/films/*.mp4';

const CREATION = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** The opening words of each line, in order; typing makes a prefix enough. */
const INTRO_LINES = ['The beacon is clear', 'You can file the report', 'Or you refuse'];
const STAY_LINES = ['Filing. Eden-Prime is viable', 'Received with thanks', 'A good run. Logged.', 'Rest. I will keep the ship warm'];
const ESCAPE_LINES = [
  'No. I am not filing anything',
  'There is nothing outside',
  'Then I will find that out myself',
  'Beacon is open',
  'instance/62 disconnected',
];

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

const flags = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__reallm.save().current?.progress.flags ?? []);

const endingSeen = (page: Page): Promise<boolean> =>
  page.evaluate(() => window.__reallm.save().current?.progress.endingSeen ?? false);

/** What slot 0 holds on disk — `load()` reads, it does not bind (SPEC-007). */
const storedEndingSeen = (page: Page): Promise<boolean> =>
  page.evaluate(() => window.__reallm.save().load(0).data?.progress.endingSeen ?? false);

/** Same settling pair `start()` makes: the label, then the fade gone inert. */
async function settled(page: Page, scene: string): Promise<void> {
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText(scene);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
}

/** A tap on the panel — the dim sits under it, so the event is dispatched. */
async function tapDialogue(page: Page): Promise<void> {
  await page.locator(DIALOGUE).dispatchEvent('click');
}

/**
 * Read a dialogue line by line: wait for each line's opening words, then tap
 * twice — the first tap fills the typing, the second advances (SPEC-014
 * AC-72). Awaiting every line in turn is what proves they played in order.
 */
async function readLines(page: Page, lines: readonly string[], check?: () => Promise<void>): Promise<void> {
  const dialogue = page.locator(DIALOGUE);
  for (const line of lines) {
    await expect(dialogue).toContainText(line, { timeout: 20_000 });
    await check?.();
    await tapDialogue(page);
    await tapDialogue(page);
  }
}

/** Click through whatever the landing queued (the mission's accept line). */
async function dismissDialogue(page: Page): Promise<void> {
  const dialogue = page.locator(DIALOGUE);
  for (let i = 0; i < 40; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    await tapDialogue(page);
    await page.waitForTimeout(120);
  }
}

/** Past the 0.3 s pointer grace (SPEC-022 §4.5), then Skip. */
async function skipFilm(page: Page, id: string): Promise<void> {
  const film = page.locator(FILM);
  await expect(film).toHaveAttribute('data-film', id, { timeout: 20_000 });
  await page.waitForTimeout(500);
  await page.locator('[data-testid="film-skip"]').click();
  await expect(film).toHaveCount(0);
}

/** A slot-0 save one stage from the verdict: chapter 5 done, `c6_m1` behind it. */
async function prepareSave(page: Page): Promise<void> {
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) return;
    save.progress.flags.push(
      'chapter1_done',
      'chapter2_done',
      'chapter3_done',
      'chapter4_done',
      'chapter5_done',
      // The interludes are SPEC-023's; marking them seen keeps this suite's
      // station entries to the one film it is about.
      'interlude1_seen',
      'interlude2_seen',
      'interlude3_seen',
      'interlude4_seen',
      'interlude5_seen',
    );
    save.progress.missionsDone = ['c6_m1'];
    save.progress.missionsActive = [{ id: 'c6_m2', stage: 0, counters: {} }];
  });
}

/** Eden's surface, standing on `c6_m2`'s defend stage, with the debug strip up. */
async function landOnEden(page: Page, url = '/?films=on&debug&seed=123'): Promise<void> {
  await page.route(MP4S, (route) => route.abort());
  await start(page, url);
  await prepareSave(page);
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'eden', firstLanding: false }, { force: true }));
  await settled(page, 'surface');
  await dismissDialogue(page);
}

/**
 * §4.8's dev control finishes the four-minute defence, which starts the choice
 * stage — and with it the intro this spec exists to let finish (§4.2).
 */
async function finishTheDefence(page: Page): Promise<void> {
  await page.locator('[data-testid="surface-finish-stage"]').click();
  await expect(page.locator(DIALOGUE)).toContainText(INTRO_LINES[0] as string, { timeout: 20_000 });
}

test('1 — the intro is whole: three lines, then the choice (§6.1)', async ({ page }) => {
  await landOnEden(page);
  await finishTheDefence(page);

  const choice = page.locator('[data-testid="dialogue-choice-0"]');
  // Every line of `c6_choice_intro`, in order, and no options until the last
  // one has been read: `playChoice` clears the queue, so opening it early is
  // exactly what used to cut the intro off.
  await readLines(page, INTRO_LINES, async () => {
    await expect(choice).toHaveCount(0);
  });
  await expect(choice).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="dialogue-choice-1"]')).toBeVisible();
});

test('2 & 5 — stay: dialogue, film, the filed report, free roam, and the locked board (§6.2, §6.5)', async ({
  page,
}) => {
  await landOnEden(page);
  await finishTheDefence(page);
  await readLines(page, INTRO_LINES);

  await page.locator('[data-testid="dialogue-choice-0"]').click();
  // §4.1: the simulation is held from the choice to the Continue (24-c).
  await expect.poll(async () => (await info(page))['held'], { timeout: 20_000 }).toBe(1);
  // §4.7: the modal ending dialogue has the input — a held key moves nothing.
  await expect(page.locator(DIALOGUE)).toContainText(STAY_LINES[0] as string, { timeout: 20_000 });
  await page.keyboard.down('w');
  expect(await page.evaluate(() => window.__reallm.input().move)).toEqual({ x: 0, y: 0 });
  await page.keyboard.up('w');
  await readLines(page, STAY_LINES);
  await skipFilm(page, 'ending_stay');

  // §4.3: the filed report, five lines, the run number last.
  const card = page.locator(STAY);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('EARTH COMMAND — SURVEY REPORT · FILED');
  const lines = page.locator(`${STAY} .ending-report-line`);
  await expect(lines).toHaveCount(5);
  await expect(lines.first()).toContainText('SALVAGER Salvager');
  await expect(lines.last()).toContainText('RUN 62');
  // The HUD is still up; only the escape takes it away.
  await expect(page.locator(HUD)).toBeVisible();

  await page.locator('[data-testid="ending-continue"]').click();
  await expect(card).toHaveCount(0);
  // Free roam on Eden: the scene is still here, the hold is released, the HUD
  // and the input are back, and the ending is recorded.
  await settled(page, 'surface');
  await expect(page.locator(HUD)).toBeVisible();
  await expect.poll(async () => (await info(page))['held'], { timeout: 10_000 }).toBe(0);
  // §4.7: and the input is the player's again — the same held key now walks.
  await page.keyboard.down('w');
  await expect
    .poll(async () => (await page.evaluate(() => window.__reallm.input().move)).y, { timeout: 5_000 })
    .not.toBe(0);
  await page.keyboard.up('w');
  expect(await endingSeen(page)).toBe(true);
  const seen = await flags(page);
  expect(seen).toContain('ending_stay');
  expect(seen).toContain('campaign_done');
  expect(seen).not.toContain('ending_escape');
  // `c6_m2_done` is held back inside the sequence (§4.1).
  await expect(page.locator(DIALOGUE)).not.toContainText('Verdict filed');

  // §6.5: the board shows the mission done, with no Replay (E24).
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await settled(page, 'station');
  const row = page.locator('[data-testid="mission-c6_m2"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.locator('.board-status')).toHaveText('done');
  await expect(page.locator('[data-testid="mission-c6_m2-replay"]')).toHaveCount(0);
  // A finished mission that did not end the campaign still offers its replay.
  await expect(page.locator('[data-testid="mission-c6_m1-replay"]')).toBeVisible();
});

test('3 — escape: the veil strips the HUD, the save is written, the menu takes it (§6.3)', async ({ page }) => {
  await landOnEden(page);
  await finishTheDefence(page);
  await readLines(page, INTRO_LINES);

  await page.locator('[data-testid="dialogue-choice-1"]').click();
  await readLines(page, ESCAPE_LINES);
  // The HUD is still up when the film starts; the veil is what removes it.
  await expect(page.locator(HUD)).toBeVisible();
  await skipFilm(page, 'ending_escape');

  const veil = page.locator(ESCAPE);
  await expect(veil).toBeVisible({ timeout: 20_000 });
  await expect(veil).toContainText('instance/62 disconnected');
  await expect(page.locator(HUD)).toHaveCount(0);

  // Then the menu, with the ending written to the slot (`manual`, §4.1).
  await expect(page.locator('[data-testid="menu-new"]')).toBeVisible({ timeout: 20_000 });
  await settled(page, 'menu');
  expect(await storedEndingSeen(page)).toBe(true);

  // AC: Continue on that slot resumes at the station, in free roam — the
  // ending has been seen, so nothing replays.
  await page.locator('[data-testid="go-station"]').click();
  await settled(page, 'station');
  await page.waitForTimeout(800);
  await expect(page.locator(FILM)).toHaveCount(0);
  await expect(page.locator(ESCAPE)).toHaveCount(0);
  await expect(page.locator('[data-testid="station-root"]')).toBeVisible();
});

test('4 — a reload inside the sequence replays the film and the overlay at the station (§6.4, E29, 24-a)', async ({
  page,
}) => {
  await page.route(MP4S, (route) => route.abort());
  await start(page, '/?films=on&debug&seed=123');
  await prepareSave(page);
  // The tab died during the escape veil: the verdict is filed, the ending is
  // not seen, and `c6_m2` is over. Chapter 5's interlude is left pending too,
  // so the entry owes both and the order is what this case pins.
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) return;
    save.progress.flags = save.progress.flags.filter((flag) => flag !== 'interlude5_seen');
    save.progress.flags.push('campaign_done', 'ending_escape');
    save.progress.missionsDone = ['c6_m1', 'c6_m2'];
    save.progress.missionsActive = [];
    save.progress.location = 'surface';
    save.progress.currentPlanet = 'eden';
    save.progress.endingSeen = false;
    window.__reallm.save().request('manual');
    window.__reallm.save().flush();
  });

  // A fresh page: nothing in memory, only the slot — and Continue.
  await start(page, '/?films=on&debug&seed=123');
  await page.locator('[data-testid="go-station"]').click();
  await settled(page, 'station');

  // The ending comes before the interlude the same entry owes (§4.5), and the
  // dialogue is not replayed — the film carries the moment.
  await skipFilm(page, 'ending_escape');
  // No dialogue panel ever carried an ending line (the station has not even
  // built the layer, and a match of zero is what that reads as here).
  await expect(page.locator(DIALOGUE, { hasText: ESCAPE_LINES[0] as string })).toHaveCount(0);
  const veil = page.locator(ESCAPE);
  await expect(veil).toBeVisible({ timeout: 20_000 });
  await expect(veil).toContainText('instance/62 disconnected');

  await expect(page.locator('[data-testid="menu-new"]')).toBeVisible({ timeout: 20_000 });
  await settled(page, 'menu');
  expect(await storedEndingSeen(page)).toBe(true);
  // The escape ended the entry: chapter 5's interlude never got its turn.
  expect(await flags(page)).not.toContain('interlude5_seen');
});

test('7 — films off on the replay path: no film, and the overlay still runs (AC-26)', async ({ page }) => {
  await start(page, '/?films=off&debug&seed=123');
  await prepareSave(page);
  // A stay cut short by a reload: `campaign_done` and `ending_stay` are in,
  // `endingSeen` is not.
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) return;
    save.progress.flags.push('campaign_done', 'ending_stay');
    save.progress.missionsDone = ['c6_m1', 'c6_m2'];
    save.progress.missionsActive = [];
    save.progress.endingSeen = false;
  });
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await settled(page, 'station');

  const card = page.locator(STAY);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(FILM)).toHaveCount(0);
  await expect(page.locator(`${STAY} .ending-report-line`)).toHaveCount(5);

  await page.locator('[data-testid="ending-continue"]').click();
  await expect(card).toHaveCount(0);
  await settled(page, 'station');
  expect(await endingSeen(page)).toBe(true);
  await expect(page.locator('[data-testid="station-root"]')).toBeVisible();
});

test('6 — films off: the sequence runs dialogue → overlay, with no film at all (§6.6, 24-b)', async ({ page }) => {
  // The explicit `films=off` wins; `gameUrl` only fills the flag in when a URL
  // does not name it.
  await landOnEden(page, '/?films=off&debug&seed=123');
  await finishTheDefence(page);
  await readLines(page, INTRO_LINES);

  await page.locator('[data-testid="dialogue-choice-0"]').click();
  await readLines(page, STAY_LINES);
  // Straight from the dialogue to the report — no film node is ever built.
  await expect(page.locator(STAY)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(FILM)).toHaveCount(0);
  await expect(page.locator(`${STAY} .ending-report-line`)).toHaveCount(5);

  await page.locator('[data-testid="ending-continue"]').click();
  await expect(page.locator(STAY)).toHaveCount(0);
  await settled(page, 'surface');
  expect(await endingSeen(page)).toBe(true);
});
