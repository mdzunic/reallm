// SPEC-049 §6.2 — someone waiting, in the browser: Iris on the personnel file,
// her letters at the station (one per entry, oldest first), letter 5's copy and
// its rating line, ARIA's mission clock and her memory question, the keepsake
// that drifts between openings of the Character tab, the restart line at the
// first respawn, and the confession naming both. The rules are pinned in node
// (`tests/systems/home.test.ts`, `tests/data/content.test.ts`,
// `tests/systems/storyContext.test.ts`); this proves the wiring.
//
// Saves are prepared through `__reallm.save()`, and the station is entered with
// `__reallm.go('station', {})` under the default `films=off`, as §6.2 says.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, start } from './start';

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

const KIN = 'Next of kin — Iris (sister) · Shelter Nine, Block C';
const LETTER_1 = [
  'The lamp over the map table stopped flickering today. Everybody clapped like idiots. They’re saying it was your oil.',
  'You took my compass. Good. I fixed it so it points home, not north. Don’t argue with it.',
  'Come back in one piece.',
];
const KEEPSAKE = {
  t1: 'A tin compass from Iris, pressed into your hand at the shelter stair. It points home, she says. Not north.',
  t2: 'A brass compass from Iris. She gave it to you on the roof. It points home.',
  t3: 'A tin compass. Your mother’s, you think. It points home.',
  t4: 'A compass. It points at your next objective. It has never once pointed home.',
  t5: 'A compass. Standard kit. Every salvager was issued one, and a letter.',
};
// Review 2026-10 S-02: the drift line on T2 names the stair and the roof; on T3, the mother.
const DRIFT = 'You called it tin last time. And last time she gave it to you at the stair, not on the roof.';
// Review 2026-10 S-14: the cover explains the walk back.
const RESTART_1 = 'Medical frame restarted your heart. Eleven seconds of nothing, and the suit walked you back. Do not ask me how.';

interface Prep {
  flags?: string[];
  playtimeSec?: number;
  endingSeen?: boolean;
}

/** A fresh slot-0 save named Vega, bound, with `prep` written into it. */
async function prepare(page: Page, prep: Prep = {}): Promise<void> {
  await page.evaluate(
    ({ creation, prep }) => {
      const bridge = window.__reallm.save();
      bridge.create(0, creation, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      if (prep.flags !== undefined) save.progress.flags.push(...prep.flags);
      if (prep.playtimeSec !== undefined) save.meta.playtimeSec = prep.playtimeSec;
      if (prep.endingSeen !== undefined) save.progress.endingSeen = prep.endingSeen;
    },
    { creation: CREATION, prep },
  );
}

async function settle(page: Page, scene: string): Promise<void> {
  await expect(page.getByTestId('scene-label')).toHaveText(scene, COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
}

/** An entry through the bridge, as §6.2 enters every station. */
async function station(page: Page): Promise<void> {
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await settle(page, 'station');
  await expect(page.getByTestId('station-root')).toBeVisible();
}

const flags = (page: Page): Promise<string[]> => page.evaluate(() => [...(window.__reallm.save().current?.progress.flags ?? [])]);

const dialogue = (page: Page) => page.getByTestId('dialogue');
const text = (page: Page) => page.locator('[data-testid="dialogue"] .dialogue-text');
const speaker = (page: Page) => page.locator('[data-testid="dialogue"] .dialogue-speaker');

/** Past SPEC-044's key grace, then Enter: one line on. */
async function enter(page: Page): Promise<void> {
  await page.waitForTimeout(350);
  await page.keyboard.press('Enter');
}

/** Reads a modal dialogue line by line — each must show, in order — and Enters past each. */
async function readModal(page: Page, lines: readonly string[]): Promise<void> {
  for (const line of lines) {
    await expect(text(page)).toHaveText(line);
    await enter(page);
  }
}

/** Enter until no line is up. */
async function finish(page: Page): Promise<void> {
  for (let i = 0; i < 12 && (await dialogue(page).isVisible()); i++) await enter(page);
  await expect(dialogue(page)).toBeHidden();
}

/**
 * A non-modal line moved on by its `›`. The line can end on its own between the
 * visibility check and the click, so a click that finds nothing is not a
 * failure (the SPEC-048 `dismiss` idiom); the line being gone is the assertion.
 */
async function advanceAway(page: Page): Promise<void> {
  const advance = page.getByTestId('dialogue-advance');
  for (let i = 0; i < 4 && (await dialogue(page).isVisible().catch(() => false)); i++) {
    await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(200);
  }
  await expect(dialogue(page)).toBeHidden();
}

/** The comms log's lines, oldest first, as `speaker|text`. */
async function commsLines(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="comms-log"] .comms-line')].map(
      (node) => `${node.querySelector('.comms-speaker')?.textContent ?? ''}|${node.querySelector('.comms-text')?.textContent ?? ''}`,
    ),
  );
}

/**
 * Presses a `?debug` strip shortcut in the page — the strip is this suite's
 * travel compressor, and an actionable click waits for stable frames a GPU-less
 * run hands out a few a second.
 */
const tap = (page: Page, id: string): Promise<void> =>
  page.evaluate((testId) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (button === null) throw new Error(`the debug strip has no ${testId} button`);
    button.click();
  }, id);

// ------------------------------------------------------------- 1: creation

test('1. creation names Iris after the Name row, the same for every class, read-only and unsaved (§4.1)', async ({ page }) => {
  await start(page, URL);
  await page.getByTestId('menu-new').click();
  await page.getByTestId('new-slot-0').click();
  await expect(page.getByTestId('creation-name')).toBeVisible(COLD_START);
  await settle(page, 'creation');
  const kin = page.getByTestId('creation-kin');
  await expect(kin).toHaveText(KIN);
  // A paragraph, right after the Name row.
  expect(await kin.evaluate((node) => node.tagName)).toBe('P');
  expect(await kin.evaluate((node) => node.previousElementSibling?.contains(document.querySelector('[data-testid="creation-name"]')) ?? false)).toBe(true);
  for (const id of ['marine', 'engineer', 'scout']) {
    await page.getByTestId(`class-${id}`).click();
    await expect(page.getByTestId(`class-${id}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(kin).toHaveText(KIN);
  }
  await page.getByTestId('creation-name').fill('Vance');
  await expect(kin).toHaveText(KIN);
  // Not a control: nothing in it takes input or focus.
  expect(await kin.locator('input, button, select, textarea, [tabindex]').count()).toBe(0);
  expect(await kin.getAttribute('tabindex')).toBeNull();
  await expect(kin.locator('.creation-kin-value')).toHaveText('Iris (sister) · Shelter Nine, Block C');

  // …and nothing of it reaches the save.
  await page.getByTestId('creation-confirm').click();
  await settle(page, 'station');
  const saved = await page.evaluate(() => JSON.stringify(window.__reallm.save().current));
  expect(saved).toContain('Vance');
  expect(saved).not.toContain('Iris');
  expect(saved).not.toContain('Shelter Nine');
});

// -------------------------------------------------------------- 2: letter 1

test('2. chapter 1 done: the entry plays letter 1, from Iris, on paper; its start marks it read (§4.1, §4.3)', async ({ page }) => {
  await start(page, URL);
  await prepare(page, { flags: ['chapter1_done'] });
  await station(page);
  await expect(dialogue(page)).toBeVisible();
  await expect(dialogue(page)).toHaveClass(/is-modal/);
  await expect(dialogue(page)).toHaveClass(/dialogue-letter/);
  await expect(speaker(page)).toHaveText('Iris');
  await expect(text(page)).toHaveText(LETTER_1[0] as string);
  expect(await flags(page)).toContain('letter1_read');
  // §3: the paper and the ink are the tokens.
  const style = await dialogue(page).evaluate((node) => ({ bg: getComputedStyle(node).backgroundColor, ink: getComputedStyle(node).color }));
  expect(style).toEqual({ bg: 'rgb(43, 38, 32)', ink: 'rgb(239, 228, 207)' });
  await readModal(page, LETTER_1);
  await expect(dialogue(page)).toBeHidden();

  // 49-i: logged like any line, named Iris, in the letter's ink.
  await page.getByTestId('station-tab-comms').click();
  await expect(page.getByTestId('comms-log')).toBeVisible();
  const lines = await commsLines(page);
  expect(lines.filter((line) => line.startsWith('Iris|'))).toEqual(LETTER_1.map((line) => `Iris|${line}`));
  const ink = await page
    .locator('[data-testid="comms-log"] .comms-line[data-speaker="home"] .comms-speaker')
    .first()
    .evaluate((node) => getComputedStyle(node).color);
  expect(ink).toBe('rgb(239, 228, 207)');
});

// ------------------------------------------------------------------- 3: E78

test('3. two letters due: one per entry, the oldest first; Notes says the other is waiting (E78)', async ({ page }) => {
  await start(page, URL);
  await prepare(page, { flags: ['chapter1_done', 'chapter2_done'] });
  await station(page);
  await expect(text(page)).toHaveText(LETTER_1[0] as string);
  await readModal(page, LETTER_1);
  await page.waitForTimeout(500);
  await expect(dialogue(page)).toBeHidden();
  let now = await flags(page);
  expect(now).toContain('letter1_read');
  expect(now).not.toContain('letter2_read');

  // Notes: the Letters section after the chapters, the read one in her words.
  await page.getByTestId('station-tab-comms').click();
  await page.getByTestId('comms-tab-notes').click();
  const letters = page.getByTestId('notes-letters');
  await expect(letters).toBeVisible();
  await expect(letters).toContainText('Letters');
  await expect(page.getByTestId('notes-letter-1')).toContainText('The lamp over the map table stopped flickering today.');
  await expect(page.getByTestId('notes-letter-1')).toContainText('Come back in one piece.');
  await expect(page.getByTestId('notes-letter-2')).toHaveText('Waiting at the station');
  await expect(page.getByTestId('notes-letter-3')).toHaveCount(0);
  await page.getByTestId('comms-log-close').click();
  await expect(page.getByTestId('comms-log')).toBeHidden();

  // The next entry plays the next letter.
  await station(page);
  await expect(text(page)).toHaveText('They put me on the tap. Forty cups a turn, Block C. I pour every one like it’s for you.');
  await expect(speaker(page)).toHaveText('Iris');
  now = await flags(page);
  expect(now).toContain('letter2_read');
  await finish(page);
});

// --------------------------------------------------------------- 4: letter 5

test('4. letter 5 is letter 1 again, then ARIA, the date, and the rating with an off-task clue found (§4.3)', async ({ page }) => {
  await start(page, URL);
  await prepare(page, {
    flags: [
      'chapter1_done',
      'chapter2_done',
      'chapter3_done',
      'chapter4_done',
      'chapter5_done',
      'letter1_read',
      'letter2_read',
      'letter3_read',
      'letter4_read',
      'clue_hull',
    ],
  });
  await station(page);
  await expect(speaker(page)).toHaveText('Iris');
  await expect(dialogue(page)).toHaveClass(/dialogue-letter/);
  await readModal(page, LETTER_1);
  // The style switches per line: ARIA reads on glass, in her own name.
  await expect(speaker(page)).toHaveText('ARIA');
  await expect(dialogue(page)).not.toHaveClass(/dialogue-letter/);
  await readModal(page, [
    'That is her first letter. Word for word. I checked it twice.',
    'Read me the date.',
    'There is no date. There never was, on any of them.',
    'Command rates every run, by the way. It takes three points off every time you look at something it did not send you to.',
  ]);
  const now = await flags(page);
  expect(now).toContain('letter5_read');
  expect(now).toContain('clue_letter_repeat');
});

// ---------------------------------------------------------- 5: the asides

test('5. chapter 3 done: the mission clock, then the memory question on the next entry, then neither (§4.5)', async ({ page }) => {
  await start(page, URL);
  await prepare(page, {
    flags: ['chapter1_done', 'chapter2_done', 'chapter3_done', 'letter1_read', 'letter2_read', 'letter3_read'],
    playtimeSec: 9000,
  });
  await station(page);
  await expect(dialogue(page)).toHaveClass(/is-modal/);
  await readModal(page, [
    'Mission clock: 150 hours since launch. You have not slept. You have not asked to.',
    'Stims.',
    'Command issue. Yes. That must be it.',
  ]);
  await page.waitForTimeout(500);
  await expect(dialogue(page)).toBeHidden();
  expect(await flags(page)).toContain('clue_awake');
  // One entry, one aside: no question behind it.
  await expect(page.getByTestId('dialogue-choice-0')).toHaveCount(0);

  // The next entry asks.
  await station(page);
  await readModal(page, ['Can I ask you something, for the file?']);
  await expect(text(page)).toHaveText('What is the first thing you remember from before the Selection?');
  await expect(page.getByTestId('dialogue-choice-0')).toHaveText('1. The roof. Counting satellites.');
  await expect(page.getByTestId('dialogue-choice-1')).toHaveText('2. The tap in Block C.');
  await expect(page.getByTestId('dialogue-choice-2')).toHaveText('3. The stair, the day the door shut.');
  // It cannot be dismissed: Escape and the system Back leave it open.
  const depth = await page.evaluate(() => window.__reallm.backDepth());
  const url = page.url();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await expect(page.getByTestId('dialogue-choice-0')).toBeVisible();
  await page.goBack();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('dialogue-choice-0')).toBeVisible();
  expect(page.url()).toBe(url);
  await expect(page.getByTestId('scene-label')).toHaveText('station');
  expect(await page.evaluate(() => window.__reallm.backDepth())).toBe(depth);
  expect((await flags(page)).filter((flag) => flag.startsWith('memory_'))).toEqual([]);

  // The reply is on screen and waits: the click that chose the answer is not
  // also the box's tap that would end it (lines land whole here).
  await page.getByTestId('dialogue-choice-0').click();
  await expect(text(page)).toHaveText('Thank you. It is on file now.');
  await page.waitForTimeout(500);
  await expect(text(page)).toBeVisible();
  await expect(dialogue(page)).toHaveClass(/is-modal/);
  const answered = await flags(page);
  expect(answered).toContain('memory_roof');
  expect(answered).not.toContain('memory_tap');
  expect(answered).not.toContain('memory_stair');
  await finish(page);
  // The memory clue is on file under its id.
  await page.getByTestId('station-tab-comms').click();
  await page.getByTestId('comms-tab-notes').click();
  await expect(page.getByTestId('notes-clue-memory_roof')).toContainText('First memory');
  await page.getByTestId('comms-log-close').click();

  // A third entry plays neither.
  const before = await flags(page);
  await station(page);
  await page.waitForTimeout(1_000);
  await expect(dialogue(page)).toBeHidden();
  await expect(page.getByTestId('dialogue-choice-0')).toHaveCount(0);
  expect(await flags(page)).toEqual(before);
});

// -------------------------------------------------------------- 6: keepsake

test('6. the keepsake reads T1, then T2 with ARIA’s drift line and its clue, then T3 with no line (§4.4)', async ({ page }) => {
  await start(page, URL);
  await prepare(page, { flags: ['chapter1_done', 'chapter2_done', 'letter1_read', 'letter2_read'] });
  await station(page);
  await expect(dialogue(page)).toBeHidden();
  const keepsake = page.getByTestId('char-keepsake');

  await page.getByTestId('station-tab-character').click();
  await expect(keepsake).toContainText('Keepsake');
  await expect(keepsake.locator('.char-keepsake-text')).toHaveText(KEEPSAKE.t1);
  await page.waitForTimeout(300);
  await expect(dialogue(page)).toBeHidden();

  await page.getByTestId('station-tab-shop').click();
  await page.getByTestId('station-tab-character').click();
  await expect(keepsake.locator('.char-keepsake-text')).toHaveText(KEEPSAKE.t2);
  await expect(text(page)).toHaveText(DRIFT);
  await expect(speaker(page)).toHaveText('ARIA');
  await expect(dialogue(page)).not.toHaveClass(/is-modal/);
  await expect.poll(() => flags(page)).toContain('clue_keepsake');
  // Moved on by its `›`, so the third opening has nothing on screen to confuse.
  await advanceAway(page);

  await page.getByTestId('station-tab-shop').click();
  await page.getByTestId('station-tab-character').click();
  await expect(keepsake.locator('.char-keepsake-text')).toHaveText(KEEPSAKE.t3);
  await page.waitForTimeout(600);
  await expect(dialogue(page)).toBeHidden();
});

// --------------------------------------------------------------- 7: restart

test('7. the session’s first respawn plays the restart line and finds its clue; the second plays nothing (§4.5)', async ({ page }) => {
  test.setTimeout(150_000);
  await start(page, URL);
  await prepare(page);
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4' }, { force: true }));
  await settle(page, 'surface');
  const death = page.getByTestId('death-overlay');

  const dieAndRespawn = async (): Promise<void> => {
    for (let i = 0; i < 10 && !(await death.isVisible()); i++) {
      await tap(page, 'surface-hurt');
      await page.waitForTimeout(400);
    }
    await expect(death).toBeVisible();
    // Review 2026-10 S-14: before the notice the overlay speaks the cover.
    await expect(page.getByTestId('death-respawn')).toHaveText('Medical frame…');
    await expect(death).toBeHidden({ timeout: 15_000 });
  };

  await dieAndRespawn();
  await expect(text(page)).toHaveText(RESTART_1);
  await expect(speaker(page)).toHaveText('ARIA');
  await expect(dialogue(page)).not.toHaveClass(/is-modal/);
  await expect.poll(() => flags(page)).toContain('clue_restart');
  await advanceAway(page);

  // 49-e: only the session's first respawn speaks.
  await dieAndRespawn();
  await page.waitForTimeout(800);
  await expect(dialogue(page)).toBeHidden();
  expect((await flags(page)).filter((flag) => flag === 'clue_restart')).toHaveLength(1);
});

// ---------------------------------------------------------- 8: confession

test('8. with the restart and the roof on file, the confession names the medical frame and the answer (§4.7)', async ({ page }) => {
  await start(page, URL);
  await prepare(page, { flags: ['clue_restart', 'memory_roof'] });
  await station(page);
  await expect(dialogue(page)).toBeHidden();
  await page.evaluate(() => window.__reallm.playDialogue('c5_m3_aria'));
  await expect(dialogue(page)).toHaveClass(/is-modal/);
  await expect(text(page)).toHaveText('She is not lying. I am part of the system. I have kept you on task since the first sand.');
  // Enter through it: nine lines with no optional clue, the restart and the roof
  // (review 2026-10 S-15 and S-06 name the Warden, the raiders and the fighters).
  let presses = 0;
  while ((await dialogue(page).isVisible()) && presses < 14) {
    await enter(page);
    presses++;
  }
  await expect(dialogue(page)).toBeHidden();
  expect(presses).toBe(9);
  await page.getByTestId('station-tab-comms').click();
  const lines = (await commsLines(page)).join('\n');
  expect(lines).toContain('There is no medical frame.');
  expect(lines).toContain('Forty of the sixty-one before you said the roof.');
  expect(lines).toContain('The voice in her is the Warden.');
  expect(lines).toContain('So you only heard the lies everyone hears.');
  expect(lines).not.toContain('You said the tap.');
  expect(lines).not.toContain('You said the stair.');
});

// ------------------------------------------------------------ 9: escape (49-h)

test('9. an escape the entry still owes ends it at the menu: no letter and no aside play (§4.3, 49-h)', async ({ page }) => {
  await start(page, URL);
  // A reload inside the escape: the verdict is filed, the ending not yet seen,
  // and a letter and the mission clock would both be due on a normal entry.
  await prepare(page, {
    flags: ['chapter1_done', 'chapter2_done', 'chapter3_done', 'campaign_done', 'ending_escape'],
    playtimeSec: 9000,
    endingSeen: false,
  });
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await expect(page.getByTestId('menu-new')).toBeVisible(COLD_START);
  await settle(page, 'menu');
  await page.waitForTimeout(800);
  await expect(dialogue(page)).toBeHidden();
  const now = await flags(page);
  expect(now).not.toContain('letter1_read');
  expect(now).not.toContain('clue_awake');
  expect(await page.evaluate(() => window.__reallm.save().current?.progress.endingSeen ?? false)).toBe(true);
});

// ------------------------------------------- 10: the later keepsake, the clock

test('10. the keepsake reads T4 on every view after the signal and T5 after chapter 5; the clock stops at 9999 hours (§4.4, §4.5)', async ({ page }) => {
  await start(page, URL);
  const keepsake = page.getByTestId('char-keepsake').locator('.char-keepsake-text');
  const view = async (): Promise<void> => {
    await page.getByTestId('station-tab-shop').click();
    await page.getByTestId('station-tab-character').click();
  };

  await prepare(page, { flags: ['chapter1_done', 'chapter2_done', 'letter1_read', 'letter2_read', 'signal_decoded'] });
  await station(page);
  await expect(dialogue(page)).toBeHidden();
  for (let i = 0; i < 3; i++) {
    await view();
    await expect(keepsake).toHaveText(KEEPSAKE.t4);
  }
  // T4 is not a drift: no line, no clue.
  await page.waitForTimeout(600);
  await expect(dialogue(page)).toBeHidden();
  expect(await flags(page)).not.toContain('clue_keepsake');

  await prepare(page, {
    flags: [
      'chapter1_done',
      'chapter2_done',
      'chapter3_done',
      'chapter4_done',
      'chapter5_done',
      'letter1_read',
      'letter2_read',
      'letter3_read',
      'letter4_read',
      'letter5_read',
      'signal_decoded',
      'clue_awake',
      'memory_roof',
    ],
  });
  await station(page);
  await expect(dialogue(page)).toBeHidden();
  for (let i = 0; i < 2; i++) {
    await view();
    await expect(keepsake).toHaveText(KEEPSAKE.t5);
  }

  // `min(9999, floor(playtimeSec / 60))`: a very long run reads the cap.
  await prepare(page, {
    flags: ['chapter1_done', 'chapter2_done', 'chapter3_done', 'letter1_read', 'letter2_read', 'letter3_read'],
    playtimeSec: 10_000_000,
  });
  await station(page);
  await expect(text(page)).toHaveText('Mission clock: 9999 hours since launch. You have not slept. You have not asked to.');
  await finish(page);
  expect(await flags(page)).toContain('clue_awake');
});

// ------------------------------------------ 11: the answer from the keyboard

test('11. Enter on a focused answer sets only its flag, and the reply waits on screen (§4.5)', async ({ page }) => {
  await start(page, URL);
  await prepare(page, {
    flags: ['chapter1_done', 'chapter2_done', 'chapter3_done', 'letter1_read', 'letter2_read', 'letter3_read', 'clue_awake'],
  });
  await station(page);
  await readModal(page, ['Can I ask you something, for the file?']);
  await expect(page.getByTestId('dialogue-choice-0')).toBeFocused();
  await page.getByTestId('dialogue-choice-2').focus();
  await enter(page);
  await expect(text(page)).toHaveText('Thank you. It is on file now.');
  await page.waitForTimeout(500);
  await expect(text(page)).toBeVisible();
  await expect(dialogue(page)).toHaveClass(/is-modal/);
  expect((await flags(page)).filter((flag) => flag.startsWith('memory_'))).toEqual(['memory_stair']);
  await finish(page);
  // The stair is filed under the memory clue's id.
  await page.getByTestId('station-tab-comms').click();
  await page.getByTestId('comms-tab-notes').click();
  await expect(page.getByTestId('notes-clue-memory_roof')).toContainText('First memory');
  await expect(page.getByTestId('notes-clue-memory_stair')).toHaveCount(0);
});
