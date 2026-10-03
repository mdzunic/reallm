// SPEC-048 §6.2 — the story listens, in the browser: placeholders filled from
// the bound save, the Warden's notice naming what was found and holding the
// world, a shelter clue found by standing in a wreck, a dropped clue line
// firing again (E75), Notes and its marker, the board's `Irregular reading`,
// a replay that plays its accept line only, the scavenger bodies, ARIA's
// covers after her confession, a caption variant and the Gauntlet's six kills.
// The rules are pinned in node (`tests/systems/storyContext.test.ts`,
// `tests/systems/clues.test.ts`, `tests/data/content.test.ts`); this proves the
// wiring. Saves are prepared through `__reallm.save()`, as
// `e2e/SPEC-012-missions.spec.ts` does, and flags are pushed into
// `save().current.progress.flags`.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, frames, start } from './start';

// Lines land whole (typewriter off), so each press advances one.
test.use({ reducedMotion: 'reduce' });

const CREATION = {
  name: 'Vega',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const URL = '/?debug&seed=123';

interface Prep {
  done?: string[];
  active?: Array<{ id: string; stage: number }>;
  flags?: string[];
}

/** A fresh slot-0 save named Vega, bound, with `prep` written into it. */
async function prepare(page: Page, prep: Prep = {}): Promise<void> {
  await page.evaluate(
    ({ creation, prep }) => {
      const bridge = window.__reallm.save();
      bridge.create(0, creation, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      if (prep.done !== undefined) save.progress.missionsDone = [...prep.done];
      if (prep.active !== undefined) save.progress.missionsActive = prep.active.map(({ id, stage }) => ({ id, stage, counters: {} }));
      if (prep.flags !== undefined) save.progress.flags.push(...prep.flags);
      save.resources['oil'] = 200;
    },
    { creation: CREATION, prep },
  );
}

async function settle(page: Page, scene: string): Promise<void> {
  await expect(page.getByTestId('scene-label')).toHaveText(scene, COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
}

async function land(page: Page, planet: string, firstLanding = false): Promise<void> {
  await page.evaluate(({ planet, firstLanding }) => window.__reallm.go('surface', { planet, firstLanding }, { force: true }), {
    planet,
    firstLanding,
  });
  await settle(page, 'surface');
}

async function station(page: Page): Promise<void> {
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await settle(page, 'station');
  await expect(page.getByTestId('mission-board')).toBeVisible();
}

const info = async (page: Page): Promise<Record<string, number | string>> =>
  page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});

const flags = (page: Page): Promise<string[]> => page.evaluate(() => [...(window.__reallm.save().current?.progress.flags ?? [])]);

/**
 * Presses a `?debug` strip shortcut in the page — the strip is this suite's
 * travel compressor, not what it tests, and an actionable click waits for
 * stable frames a GPU-less run hands out a few a second.
 */
const tap = (page: Page, id: string): Promise<void> =>
  page.evaluate((testId) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (button === null) throw new Error(`the debug strip has no ${testId} button`);
    button.click();
  }, id);

const play = (page: Page, id: string): Promise<void> => page.evaluate((dialogue) => window.__reallm.playDialogue(dialogue), id);

/** Click through every line on screen — `›` advances a non-modal line, a tap a modal one. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.getByTestId('dialogue');
  const advance = page.getByTestId('dialogue-advance');
  for (let i = 0; i < 40; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(150);
  }
  await expect(dialogue).toBeHidden();
}

/**
 * A first landing with c1_m1 at stage 0 queues its accept line as the scene
 * enters, ahead of anything the case plays. At Normal speed it held for ~8 s of
 * wall clock — longer than a GPU runner takes to land, shorter than a GPU-less
 * one — so the cases that play behind it run at Manual and move it on here.
 */
async function passAcceptLine(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="dialogue"] .dialogue-text')).toContainText('I put the tug on the pad.', COLD_START);
  await dismiss(page);
}

/** The comms log's lines, oldest first, as `speaker|text`. */
async function commsLines(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="comms-log"] .comms-line')].map(
      (node) => `${node.querySelector('.comms-speaker')?.textContent ?? ''}|${node.querySelector('.comms-text')?.textContent ?? ''}`,
    ),
  );
}

/** Escape pauses a running surface (SPEC-036 §4.4); `pause-comms` opens the log over the menu. */
async function pauseComms(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.getByTestId('pause-comms').click();
  await expect(page.getByTestId('comms-log')).toBeVisible();
}

// ------------------------------------------------------------ 1: placeholders

test('1. intro_command is filled from the bound save: tug CR-62, and the salvager’s name (§4.1)', async ({ page }) => {
  await start(page, URL);
  await prepare(page);
  await station(page);
  await play(page, 'intro_command');
  const text = page.locator('[data-testid="dialogue"] .dialogue-text');
  await expect(text).toHaveText('Earth Command to tug CR-62. Vega, you are cleared for the Cinder-4 approach.');
  // The log keeps the filled text, not the template (§4.1).
  await dismiss(page);
  await page.getByTestId('station-tab-comms').click();
  expect(await commsLines(page)).toContain('Earth Command|Earth Command to tug CR-62. Vega, you are cleared for the Cinder-4 approach.');
});

// ------------------------------------------------------------- 2: the notice

test('2. the notice holds the world and names the echo and the log, not the towers (§4.5)', async ({ page }) => {
  await start(page, URL);
  await prepare(page, { flags: ['clue_scav_echo', 'iteration_log'] });
  await land(page, 'ferrum');
  await dismiss(page);
  await play(page, 'c4_m3_signal');
  const dialogue = page.getByTestId('dialogue');
  const text = dialogue.locator('.dialogue-text');
  await expect(dialogue).toHaveClass(/is-modal/);
  await expect(text).toHaveText('Signal decoded. It is not addressed to Earth.');
  await expect.poll(async () => (await info(page))['held']).toBe(1);
  await page.waitForTimeout(350); // SPEC-044's key grace
  await page.keyboard.press('Enter');
  await expect(text).toContainText('instance/62. Containment level 4. Token balance');
  // Enter through every line: eight of them with two clues found.
  let presses = 1;
  while ((await dialogue.isVisible()) && presses < 12) {
    await page.waitForTimeout(350);
    await page.keyboard.press('Enter');
    presses++;
  }
  await expect(dialogue).toBeHidden();
  expect(presses).toBe(8);
  await expect.poll(async () => (await info(page))['held']).toBe(0);
  await pauseComms(page);
  const lines = await commsLines(page);
  expect(lines).toContain('???|Retained a repeated line. Cinder-4.');
  expect(lines).toContain('???|Accessed a prior instance’s flight log. Vetra.');
  expect(lines.some((line) => line.includes('Queried environment parameters. Thessaly.'))).toBe(false);
  expect(lines).toContain('You|ARIA. What is instance 62.');
});

test('2b. c4_m3’s completion plays the notice first, and the banner shows when it ends (§4.5, SPEC-042 §4.1)', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, URL);
  await prepare(page, { done: ['c4_m1', 'c4_m2'], active: [{ id: 'c4_m3', stage: 1 }] });
  await land(page, 'ferrum');
  await dismiss(page);
  const dialogue = page.getByTestId('dialogue');
  const banner = page.getByTestId('mission-complete');
  await tap(page, 'surface-finish-stage');
  await expect(dialogue).toBeVisible();
  await expect(dialogue).toHaveClass(/is-modal/);
  await expect(dialogue.locator('.dialogue-text')).toHaveText('Signal decoded. It is not addressed to Earth.');
  await expect(banner).toBeHidden();
  for (let i = 0; i < 12 && (await dialogue.isVisible()); i++) {
    await dialogue.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(150);
    if (await dialogue.isVisible()) await expect(banner).toBeHidden();
  }
  await expect(dialogue).toBeHidden();
  await expect(banner).toBeVisible();
  await expect(page.getByTestId('mission-complete-title')).toHaveText('Reactor Womb');
});

// ---------------------------------------- 3 and 5: a dwell clue, then Notes

test('3, 5. four seconds in a Cinder-4 wreck find the older tug, and Notes records it (§4.3, §4.4)', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, URL);
  await prepare(page);
  await land(page, 'cinder4', true);
  await dismiss(page);
  expect(Number((await info(page))['shelters'])).toBeGreaterThan(0);
  await tap(page, 'surface-goto-wreck');
  await expect(page.locator('[data-testid="dialogue"] .dialogue-text')).toContainText('Tug-class hull. Earth pattern, older paint.', {
    timeout: 15_000,
  });
  await expect.poll(() => flags(page)).toContain('clue_hull');
  await expect.poll(async () => (await info(page))['cluesFound']).toBe(1);

  // 5. The marker, the count, the rating and the record.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await expect(page.getByTestId('pause-comms').getByTestId('notes-new')).toBeVisible();
  await page.getByTestId('pause-comms').click();
  await expect(page.getByTestId('comms-log')).toBeVisible();
  // It opens on the log.
  await expect(page.getByTestId('comms-tab-comms')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('comms-tab-notes')).toHaveAttribute('aria-selected', 'false');
  await page.getByTestId('comms-tab-notes').click();
  await expect(page.getByTestId('notes-count')).toHaveText('Recorded 1 of 15');
  await expect(page.getByTestId('notes-rating')).toHaveText('Command rating 0.97 — a good run');
  await expect(page.getByTestId('notes-clue-clue_hull')).toContainText('An older tug');
  await expect(page.getByTestId('notes-clue-clue_hull')).toContainText('A tug like ours in the dunes.');
  await expect(page.getByTestId('notes-chapter-1').locator('.notes-missing')).toHaveCount(2);
  await expect(page.getByTestId('notes-chapter-1').locator('.notes-missing').first()).toHaveText('— not recorded —');
  // CSS uppercases the header lines; the text is written in sentence case.
  expect(await page.getByTestId('notes-count').evaluate((node) => getComputedStyle(node).textTransform)).toBe('uppercase');
  // The arrow keys switch the tabs.
  await page.getByTestId('comms-tab-notes').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('comms-tab-comms')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('comms-tab-comms')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('comms-tab-notes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('notes-count')).toBeVisible();
  // Reopened, the dot is gone.
  await page.getByTestId('comms-log-close').click();
  await expect(page.getByTestId('comms-log')).toBeHidden();
  await page.getByTestId('pause-resume').click();
  await expect(page.getByTestId('pause-menu')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await expect(page.getByTestId('pause-comms').getByTestId('notes-new')).toHaveCount(0);
});

// ------------------------------------------------------------------- 4: E75

test.describe('4. a clue line dropped by a full queue fires again at its next dwell (E75)', () => {
  // Manual speed: a line waits for its press, so the five queued lines stay
  // queued for as long as the case needs them to.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('spec048:primed') !== null) return;
      sessionStorage.setItem('spec048:primed', '1');
      localStorage.setItem('reallm:settings', JSON.stringify({ version: 1, dialogueSpeed: 'manual' }));
    });
  });

  test('the flag stays unset while the queue is full, and is set on the dwell after it empties', async ({ page }) => {
    test.setTimeout(150_000);
    await start(page, URL);
    await prepare(page);
    await land(page, 'cinder4', true);
    await dismiss(page);
    for (let i = 0; i < 5; i++) await play(page, 'c1_s1_done');
    await expect(page.locator('[data-testid="dialogue"] .dialogue-text')).toContainText('Rations pressed and stowed.');
    await tap(page, 'surface-goto-wreck');
    // The dwell reaches the trigger, which fires into the full queue and starts its count again.
    await expect.poll(async () => Number((await info(page))['clueDwell']), { timeout: 20_000 }).toBeGreaterThanOrEqual(3.5);
    await expect.poll(async () => Number((await info(page))['clueDwell']), { timeout: 10_000 }).toBeLessThan(3);
    await page.waitForTimeout(1_000);
    expect(await flags(page)).not.toContain('clue_hull');
    expect((await info(page))['cluesFound']).toBe(0);
    // Out of the wreck, the queue emptied…
    await tap(page, 'surface-goto-pad');
    await dismiss(page);
    // …and back in: this dwell's line plays, and its start sets the flag.
    await tap(page, 'surface-goto-wreck');
    await expect.poll(() => flags(page), { timeout: 20_000 }).toContain('clue_hull');
    await expect(page.locator('[data-testid="dialogue"] .dialogue-text')).toContainText('Tug-class hull.');
  });
});

// -------------------------------------------------------------- 6: the board

test('6. the board reads Irregular reading on c1_s2 until its clue is found (§4.4)', async ({ page }) => {
  await start(page, URL);
  await prepare(page, { done: ['c1_m1'] });
  await station(page);
  const tag = page.getByTestId('mission-c1_s2-irregular');
  await expect(tag).toHaveText('Irregular reading');
  // The other side mission of the chapter carries no clue of its own.
  await expect(page.getByTestId('mission-c1_s1-irregular')).toHaveCount(0);
  await page.evaluate(() => window.__reallm.save().current?.progress.flags.push('clue_scav_echo'));
  await page.getByTestId('station-tab-shop').click();
  await page.getByTestId('station-tab-missions').click();
  await expect(page.getByTestId('mission-board')).toBeVisible();
  await expect(page.getByTestId('mission-c1_s2')).toBeVisible();
  await expect(tag).toHaveCount(0);
});

// ------------------------------------------------------------- 7: replays

test('7. a replay of c1_m1 plays its accept line only, and its banner still shows (§4.6, E76)', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, URL);
  await prepare(page, { done: ['c1_m1'] });
  await land(page, 'cinder4');
  await dismiss(page);
  await tap(page, 'surface-goto-pad');
  const terminal = page.getByTestId('pad-terminal');
  for (let i = 0; i < 5 && !(await terminal.isVisible()); i++) {
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(400);
  }
  await expect(terminal).toBeVisible();
  await page.getByTestId('terminal-accept-c1_m1').click();
  await page.getByTestId('terminal-close').click();
  await expect(terminal).toBeHidden();
  // Stage 0 (the pad) completes where the salvager stands; finish the other two.
  const banner = page.getByTestId('mission-complete');
  for (let i = 0; i < 4 && !(await banner.isVisible()); i++) {
    await tap(page, 'surface-finish-stage');
    await page.waitForTimeout(400);
  }
  await expect(banner).toBeVisible();
  await expect(page.getByTestId('mission-complete-title')).toHaveText('Dry Land');
  await dismiss(page);
  await page.waitForTimeout(500);
  await pauseComms(page);
  const lines = (await commsLines(page)).join('\n');
  expect(lines).toContain('I put the tug on the pad. You were out of the hatch twelve metres early.');
  expect(lines).not.toContain('Off-worlder. Listen.');
  expect(lines).not.toContain('Dune sea logged, storm survived.');
});

// --------------------------------------------------------------- 8: bodies

test('8. one scav lies by the pad while c1_m1 runs, the echo lays an identical one down, and none once it is done (§4.8)', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ version: 1, dialogueSpeed: 'manual' })));
  await start(page, URL);
  await prepare(page, { active: [{ id: 'c1_m1', stage: 0 }] });
  await land(page, 'cinder4', true);
  await expect.poll(async () => (await info(page))['scavBodies']).toBe(1);
  await passAcceptLine(page);
  await play(page, 'c1_s2_echo');
  await expect(page.locator('[data-testid="dialogue"] .dialogue-text')).toContainText('Off-worlder. Listen.');
  await expect.poll(async () => (await info(page))['scavBodies']).toBe(2);
  // The echo found its clue as it started.
  await expect.poll(() => flags(page)).toContain('clue_scav_echo');
  await dismiss(page);
  // A second echo in the visit lays no third body.
  await play(page, 'c1_s2_echo');
  await page.waitForTimeout(300);
  expect((await info(page))['scavBodies']).toBe(2);
  await dismiss(page);

  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) throw new Error('no save bound');
    save.progress.missionsActive = [];
    save.progress.missionsDone = ['c1_m1'];
  });
  await station(page);
  await land(page, 'cinder4');
  await frames(page, 5);
  expect((await info(page))['scavBodies']).toBe(0);
});

test('8b. with both bodies down the medium frame stays inside SPEC-015 §5 (96 draws, 130 k triangles)', async ({ page }) => {
  test.setTimeout(150_000);
  // SPEC-040 §4.3: a GPU-less container would step the governor down to `low`
  // while the echo plays; the budget is `medium`'s, so the preset holds still.
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ adaptiveQuality: false, dialogueSpeed: 'manual' })));
  await start(page, '/?debug&seed=123&quality=medium');
  await prepare(page, { active: [{ id: 'c1_m1', stage: 0 }] });
  await land(page, 'cinder4', true);
  await passAcceptLine(page);
  await play(page, 'c1_s2_echo');
  await expect.poll(async () => (await info(page))['scavBodies']).toBe(2);
  await dismiss(page);
  const from = (await page.evaluate(() => window.__reallm.stats())).frame;
  await page.waitForFunction((target) => window.__reallm.stats().frame >= target, from + 30);
  const stats = await page.evaluate(() => window.__reallm.stats());
  expect(stats.preset).toBe('medium');
  expect(stats.drawCalls).toBeGreaterThan(10);
  expect(stats.drawCalls).toBeLessThanOrEqual(96); // 80 scene + 16 post
  expect(stats.triangles).toBeLessThanOrEqual(130_000);
});

// ---------------------------------------------------------------- 9: covers

test('9. after the confession the echo ends on ARIA’s candid line, not the sand (E77)', async ({ page }) => {
  await start(page, URL);
  await prepare(page, { flags: ['chapter5_done'] });
  await station(page);
  await expect(page.getByTestId('station-tab-comms').getByTestId('notes-new')).toHaveCount(0);
  await play(page, 'c1_s2_echo');
  await expect(page.locator('[data-testid="dialogue"] .dialogue-text')).toContainText('Off-worlder. Listen.');
  // §4.3, §4.4: the station finds the clue its line carries, and its rail says so.
  await expect.poll(() => flags(page)).toContain('clue_scav_echo');
  await expect(page.getByTestId('station-tab-comms').getByTestId('notes-new')).toBeVisible();
  await dismiss(page);
  await page.getByTestId('station-tab-comms').click();
  const lines = await commsLines(page);
  expect(lines.at(-1)).toBe('ARIA|That line again. I will not blame the sand this time.');
  expect(lines.join('\n')).not.toContain('Coincidence. Sand does things to people.');
  // Opening Notes takes the dot down; the record is there, filled.
  await page.getByTestId('comms-tab-notes').click();
  await expect(page.getByTestId('notes-clue-clue_scav_echo')).toContainText('Said before');
  // The confession counts too; its chapter's section waits for the flags to reach it.
  await expect(page.getByTestId('notes-count')).toHaveText('Recorded 2 of 15');
  await page.getByTestId('comms-log-close').click();
  await expect(page.getByTestId('station-tab-comms').getByTestId('notes-new')).toHaveCount(0);
  await expect(page.getByTestId('station-tab-comms')).toBeFocused();
});

// ------------------------------------------------------- 10: caption variant

type FilmBridge = { play(id: string): Promise<string>; seek(seconds: number): void; state(): { caption: string | null } | null };

test('10. interlude_c3’s ARIA caption takes its variant with the towers read, and its own text without (§4.1)', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, '/?debug&seed=123&films=on');
  await prepare(page, { flags: ['scaffold_secret'] });
  await land(page, 'thessaly');
  const caption = page.getByTestId('film-caption');
  const playAt8 = async (): Promise<void> => {
    await page.evaluate(() => void (window as unknown as { __reallmFilm: FilmBridge }).__reallmFilm.play('interlude_c3'));
    await expect(page.getByTestId('film')).toBeVisible();
    await page.evaluate(() => (window as unknown as { __reallmFilm: FilmBridge }).__reallmFilm.seek(8));
  };
  await playAt8();
  await expect(caption).toContainText('The towers were not alien.');
  await page.evaluate(() => (window as unknown as { __reallmFilm: FilmBridge }).__reallmFilm.seek(99));
  await expect(page.getByTestId('film')).toHaveCount(0, { timeout: 10_000 });

  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) throw new Error('no save bound');
    save.progress.flags = save.progress.flags.filter((flag) => flag !== 'scaffold_secret');
  });
  await playAt8();
  await expect(caption).toContainText('The towers on Thessaly were built for someone.');
  await page.evaluate(() => (window as unknown as { __reallmFilm: FilmBridge }).__reallmFilm.seek(99));
  await expect(page.getByTestId('film')).toHaveCount(0, { timeout: 10_000 });
});

// --------------------------------------------------------------- 11: six kills

test('11. the Gauntlet asks for six kills (§4.7)', async ({ page }) => {
  await start(page, URL);
  await prepare(page);
  await station(page);
  await play(page, 'c5_m1_accept');
  await expect(page.locator('[data-testid="dialogue"] .dialogue-text')).toContainText('Six kills.');
});

// ------------------------------------------------- the ?debug shortcuts (§3)

test('the cave and landmark shortcuts find the tally on Ferrum and the grove on Eden (§4.3)', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, URL);
  await prepare(page);
  await land(page, 'ferrum');
  await dismiss(page);
  await tap(page, 'surface-goto-cave');
  await expect.poll(async () => Number((await info(page))['clueDwell']), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(() => flags(page), { timeout: 20_000 }).toContain('clue_tally');
  await expect(page.locator('[data-testid="dialogue"] .dialogue-text')).toContainText('Tally marks, in fives.');
  await dismiss(page);

  await station(page);
  await land(page, 'eden');
  await dismiss(page);
  await tap(page, 'surface-goto-landmark');
  await expect.poll(() => flags(page), { timeout: 20_000 }).toContain('clue_grove');
  await expect(page.locator('[data-testid="dialogue"] .dialogue-text')).toContainText('Same branch, same knot, same lean.');
  expect((await info(page))['cluesFound']).toBe(2);
});
