// SPEC-044 §6.2 — focus and flow, in the browser: a modal line read by
// keyboard, Enter on a non-modal one, creation by keyboard and its Back, the
// station's tablist, the next step to the star map, the pad terminal as a
// modal, a danger sheet's focus, the gear card's and the stay card's focus,
// the one controls sheet, Save & Quit's cost, the player-facing credits, the
// storage block, and the board's words. Every case that is about keys drives
// the keys; the words and the rules are pinned in node
// (`tests/ui/helpers.test.ts`, `tests/ui/dialogue.test.ts`,
// `tests/ui/controls.test.ts`), and this proves the wiring.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const URL = '/?seed=123';
const DEBUG_URL = '/?debug&seed=123';

/**
 * `intro_command` as the panel shows it (`data/dialogue.ts`): a modal transmission of three lines.
 * SPEC-048 §4.1: the first is filled from the bound save — instance 62 on a first run, and the name.
 */
const INTRO_LINES = [
  { speaker: 'Earth Command', text: 'Earth Command to tug CR-62. Vance, you are cleared for the Cinder-4 approach.' },
  { speaker: 'Earth Command', text: 'Survey, extract, report. Answer one question: can we live out there.' },
  { speaker: 'ARIA', text: 'I am ARIA. I fly the ship and I keep you honest. Try not to make that hard.' },
];

/** What `prepare` writes into the fresh slot-0 save before anything is entered. */
interface Prep {
  active?: string[];
  done?: string[];
  flags?: string[];
  oil?: number;
}

/** Chapter 1 finished, its interlude already watched — Vetra open, `c2_m1` on its board. */
const CHAPTER_ONE_DONE: Prep = {
  done: ['c1_m1', 'c1_m2', 'c1_m3'],
  flags: ['c1_oil', 'chapter1_done', 'interlude1_seen'],
  oil: 200,
};

async function prepare(page: Page, prep: Prep): Promise<void> {
  await page.evaluate(
    ({ creation, prep }) => {
      const bridge = window.__reallm.save();
      bridge.create(0, creation, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      if (prep.done !== undefined) save.progress.missionsDone = [...prep.done];
      if (prep.flags !== undefined) save.progress.flags = [...prep.flags];
      if (prep.active !== undefined) save.progress.missionsActive = prep.active.map((id) => ({ id, stage: 0, counters: {} }));
      if (prep.oil !== undefined) save.resources['oil'] = prep.oil;
    },
    { creation: CREATION, prep },
  );
}

/** The scene is up and its fade has let go, so a press lands. */
async function settle(page: Page, scene: string): Promise<void> {
  await expect(page.getByTestId('scene-label')).toHaveText(scene, COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
}

/** The station for the save already bound, its board up. */
async function station(page: Page): Promise<void> {
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await settle(page, 'station');
  await expect(page.getByTestId('mission-board')).toBeVisible();
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

/** The bound save on `planet`'s surface, past any first line. */
async function land(page: Page, planet = 'cinder4'): Promise<void> {
  await page.evaluate((id) => window.__reallm.go('surface', { planet: id, firstLanding: false }, { force: true }), planet);
  await settle(page, 'surface');
  await dismiss(page);
}

/** The `data-testid` of whatever holds focus, or `null`. */
async function focused(page: Page): Promise<string | null> {
  return page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['testid'] ?? null);
}

/** Tab until `id` holds focus — the keyboard's own way there. */
async function tabTo(page: Page, id: string, most = 80): Promise<void> {
  for (let i = 0; i < most; i++) {
    if ((await focused(page)) === id) return;
    await page.keyboard.press('Tab');
  }
  expect(await focused(page), `Tab reached ${id}`).toBe(id);
}

async function slotKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('reallm:slot:')).sort());
}

/** The dialogue panel as the page shows it: who speaks, and how much of the line is out. */
interface LineState {
  readonly shown: boolean;
  readonly speaker: string;
  readonly text: string;
}

/**
 * One keydown: the line as the press found it, and as DialogueUI's own
 * listener left it; `played` when the press went on to the game's keyboard
 * driver (on `window`, after the line's listener) and was swallowed there as a
 * bound key — the game took it as play.
 */
interface LinePress {
  readonly code: string;
  readonly repeat: boolean;
  readonly before: LineState;
  readonly after: LineState;
  readonly played: boolean;
}

/** What `playWatched` saw in the task that opened the dialogue. */
interface Opened {
  readonly role: string | null;
  readonly modal: string | null;
  readonly focused: string | null;
  readonly cue: boolean;
  readonly line: LineState;
}

/**
 * Plays `id` and, in the same task, starts logging every keydown with the line
 * as the press found it (a capture listener on `window`, before anything else)
 * and as DialogueUI left it (a `document` listener added after DialogueUI's
 * own, so it runs straight after it in the same dispatch — even for a press
 * the line stopped). The judgement is read in the page, at the press: a round
 * trip on a loaded container can take half a second, and a line types for
 * about 1.7 s while a non-modal one moves on by itself once its hold runs out
 * (`holdMs`: at least 3 s from when it is whole, SPEC-045 §4.1), so what the
 * test reads afterwards could be the line's own doing rather than the key's.
 */
async function playWatched(page: Page, id: string, options: { graceKey?: string } = {}): Promise<Opened> {
  return page.evaluate(
    ({ dialogue, graceKey }) => {
      window.__reallm.playDialogue(dialogue);
      const panel = document.querySelector<HTMLElement>('[data-testid="dialogue"]');
      if (panel === null) throw new Error('no dialogue panel');
      type State = { shown: boolean; speaker: string; text: string };
      const read = (): State => ({
        shown: !panel.classList.contains('is-hidden'),
        speaker: panel.querySelector('.dialogue-speaker')?.textContent ?? '',
        text: panel.querySelector('.dialogue-text')?.textContent ?? '',
      });
      const log: { code: string; repeat: boolean; before: State; after: State; played: boolean }[] = [];
      window.addEventListener(
        'keydown',
        (event) => {
          const now = read();
          log.push({ code: event.code, repeat: event.repeat, before: now, after: now, played: false });
        },
        true,
      );
      document.addEventListener('keydown', () => {
        const last = log[log.length - 1];
        if (last !== undefined) last.after = read();
      });
      // Bubble on `window`, added long after the keyboard driver's own listener
      // there; a press the line took (and stopped) never gets this far.
      window.addEventListener('keydown', (event) => {
        const last = log[log.length - 1];
        if (last !== undefined) last.played = event.defaultPrevented;
      });
      (window as unknown as { __linePresses: typeof log }).__linePresses = log;
      const opened = {
        role: panel.getAttribute('role'),
        modal: panel.getAttribute('aria-modal'),
        focused: (document.activeElement as HTMLElement | null)?.dataset['testid'] ?? null,
        cue: panel.querySelector<HTMLElement>('[data-testid="dialogue-next"]')?.hidden === false,
        line: read(),
      };
      // A press in the line's first moment — dispatched in the task that opened
      // it, so it is surely inside the 0.3 s grace (44-a).
      if (graceKey !== undefined) {
        const key = graceKey === 'Space' ? ' ' : graceKey;
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, code: graceKey, bubbles: true, cancelable: true }));
      }
      return opened;
    },
    { dialogue: id, graceKey: options.graceKey },
  );
}

/** Every keydown `playWatched` has logged so far. */
async function linePresses(page: Page): Promise<LinePress[]> {
  return page.evaluate(() => (window as unknown as { __linePresses: LinePress[] }).__linePresses);
}

/**
 * Judges presses against a dialogue's lines, from `start`: each must do what
 * one `skip()` does to the line it found (§4.1, SPEC-014 AC-72) — fill a line
 * still typing, or move a complete one on to the next (the panel hiding after
 * the last). Returns the index of the line the presses left up.
 */
function expectSkips(presses: readonly LinePress[], lines: readonly { speaker: string; text: string }[], start: number): number {
  let at = start;
  for (const [n, press] of presses.entries()) {
    const line = lines[at];
    if (line === undefined) {
      // The dialogue has ended; a press after it has no line to act on.
      expect(press.before.shown, `press ${n + 1} (${press.code}) came after the end`).toBe(false);
      continue;
    }
    expect(press.before.speaker, `press ${n + 1} (${press.code}) found line ${at + 1}`).toBe(line.speaker);
    if (press.before.text !== line.text) {
      expect(line.text.startsWith(press.before.text), `press ${n + 1} found line ${at + 1} typing`).toBe(true);
      expect(press.after, `press ${n + 1} (${press.code}) filled line ${at + 1}`).toEqual({ shown: true, speaker: line.speaker, text: line.text });
      continue;
    }
    at++;
    const next = lines[at];
    if (next === undefined) {
      expect(press.after.shown, `press ${n + 1} (${press.code}) ended the dialogue`).toBe(false);
    } else {
      expect(press.after.speaker, `press ${n + 1} (${press.code}) moved on to line ${at + 1}`).toBe(next.speaker);
      expect(press.after.text, `line ${at + 1} starts typing`).not.toBe(line.text);
      expect(next.text.startsWith(press.after.text), `line ${at + 1} starts typing`).toBe(true);
    }
  }
  return at;
}

// ------------------------------------------------------------ 1: modal line

test('1. a modal line is read by keyboard: ▸ Enter once complete, Enter advances, focus comes back', async ({ page }) => {
  await start(page, URL);
  await prepare(page, {});
  await station(page);
  const tab = page.getByTestId('station-tab-missions');
  await tab.focus();
  expect(await focused(page)).toBe('station-tab-missions');

  await page.evaluate(() => window.__reallm.playDialogue('intro_command'));
  const dialogue = page.getByTestId('dialogue');
  await expect(dialogue).toBeVisible();
  // §4.1: a modal dialogue takes focus as a dialog.
  await expect(dialogue).toHaveAttribute('role', 'dialog');
  await expect(dialogue).toHaveAttribute('aria-modal', 'true');
  expect(await focused(page)).toBe('dialogue');

  // The cue appears once the first line has typed out, and it never animates.
  // Typed out is the whole line on screen: the typewriter adds a character per
  // 25 ms tick of the page's own clock, so a starved tab types far below 40 a
  // second — a loaded gate run had 76 of SPEC-048's 77 characters up when the
  // old 10 s ran out — and the wait is for the line, not for a speed. The line
  // is modal, so it stays until a press; the cue is shown in the same tick as
  // its last character.
  await expect(dialogue.locator('.dialogue-text')).toHaveText(INTRO_LINES[0]!.text, { timeout: 30_000 });
  const cue = page.getByTestId('dialogue-next');
  await expect(cue).toBeVisible();
  await expect(cue).toHaveText('▸ Enter');
  expect(await cue.evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
  expect(await cue.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe('0s');

  // Six presses at most, 0.35 s apart: each fills a typing line or advances a
  // complete one, and the last line's advance ends the transmission.
  let presses = 0;
  while (presses < 6 && (await dialogue.isVisible())) {
    await page.keyboard.press('Enter');
    presses++;
    await page.waitForTimeout(350);
  }
  await expect(dialogue).toBeHidden();
  expect(presses).toBeLessThanOrEqual(6);
  // Focus is back where it was, and the panel is a log again.
  expect(await focused(page)).toBe('station-tab-missions');
  await expect(dialogue).toHaveAttribute('role', 'log');
  await expect(dialogue).not.toHaveAttribute('aria-modal', /.*/);
});

test('1b. Space, E and F advance a modal line too; a held key (a repeat) and a press in the first 0.3 s do not', async ({ page }) => {
  await start(page, URL);
  await prepare(page, {});
  await station(page);
  // Inside the grace: a Space in the line's first moment does nothing (44-a).
  const opened = await playWatched(page, 'intro_command', { graceKey: 'Space' });
  expect(opened.modal).toBe('true');
  expect(opened.line).toEqual({ shown: true, speaker: 'Earth Command', text: '' });
  // A repeat is not a fresh press, however late it comes (44-a).
  await page.waitForTimeout(400);
  await page.evaluate(() =>
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true, bubbles: true, cancelable: true })),
  );
  // Fresh presses, each past the grace of the line it finds.
  for (const key of ['Space', 'KeyE', 'KeyF', 'Space']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(350);
  }

  const presses = await linePresses(page);
  expect(presses.map((press) => press.code)).toEqual(['Space', 'Enter', 'Space', 'KeyE', 'KeyF', 'Space']);
  const [early, held, ...fresh] = presses as [LinePress, LinePress, ...LinePress[]];
  expect(early.after, 'a press inside the grace leaves the line alone').toEqual(early.before);
  expect(held.repeat).toBe(true);
  expect(held.after, 'a repeat leaves the line alone').toEqual(held.before);
  // Space, E, F and Space each do what one tap does — fill, then advance — and
  // none of them reaches the game behind the transmission.
  const end = expectSkips(fresh, INTRO_LINES, 0);
  expect(end).toBeGreaterThanOrEqual(1);
  for (const press of fresh) expect(press.played, `${press.code} stays the line's`).toBe(false);
});

test('1c. a modal above a line has the keys: Enter and E in the pause menu leave the transmission alone', async ({ page }) => {
  await start(page, DEBUG_URL);
  await prepare(page, {});
  await land(page);
  const opened = await playWatched(page, 'intro_command');
  expect(opened.modal).toBe('true');
  expect(opened.focused).toBe('dialogue');
  await page.waitForTimeout(350);
  // A story line is no back-stack entry, so Escape pauses over it.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  expect(await focused(page)).toBe('pause-resume');
  // Focus on the pause menu itself, off its buttons, as a click on its empty
  // space leaves it: the keys still belong to the pause menu, not the line.
  await page.evaluate(() => document.querySelector('[data-testid="pause-menu"]')?.closest<HTMLElement>('[aria-modal="true"]')?.focus());
  await page.keyboard.press('Enter');
  await page.keyboard.press('KeyE');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  const paused = (await linePresses(page)).filter((press) => press.code === 'Enter' || press.code === 'KeyE');
  expect(paused.map((press) => press.code)).toEqual(['Enter', 'KeyE']);
  for (const press of paused) expect(press.after, `${press.code} under the pause menu`).toEqual(press.before);

  // Resumed, focus is back on the line, and Enter reads it again.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeHidden();
  expect(await focused(page)).toBe('dialogue');
  await page.keyboard.press('Enter');
  const resumed = (await linePresses(page)).filter((press) => press.code === 'Enter').slice(1);
  expect(resumed).toHaveLength(1);
  expectSkips(resumed, INTRO_LINES, 0);
});

// -------------------------------------------------------- 2: non-modal line

test('2. a non-modal line on the surface: Space keeps its gameplay meaning, Enter advances', async ({ page }) => {
  await start(page, DEBUG_URL);
  await prepare(page, {});
  await land(page);
  const lines = [
    { speaker: 'Scav', text: 'Off-worlder. Listen. The worms hunt by vibration — walk, do not run.' },
    { speaker: 'ARIA', text: 'He is dehydrated. Keep moving.' },
  ];
  const opened = await playWatched(page, 'c1_m1_stage2');
  expect(opened.line.speaker).toBe('Scav');
  // A non-modal line takes no focus, stays a log, and shows no cue.
  expect(opened.role).toBe('log');
  expect(opened.modal).toBeNull();
  expect(opened.focused).not.toBe('dialogue');
  expect(opened.cue).toBe(false);
  // Past the 0.3 s grace, Space and then Enter twice — a few round trips, well
  // inside the 6 s a non-modal line waits before it moves on by itself.
  await page.waitForTimeout(350);
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  const [space, ...enters] = (await linePresses(page)) as [LinePress, ...LinePress[]];
  expect(space.code).toBe('Space');
  // Space is the player's: the line neither fills nor moves on, and the game
  // takes the press as play.
  expect(space.before.speaker).toBe('Scav');
  expect(space.after).toEqual(space.before);
  expect(space.played).toBe(true);
  // Enter fills the Scav's line and then moves it on to ARIA — or, if the line
  // had finished typing first, moves it on at once — and the game never sees it.
  expect(enters.map((press) => press.code)).toEqual(['Enter', 'Enter']);
  expect(expectSkips(enters, lines, 0)).toBeGreaterThanOrEqual(1);
  for (const press of enters) expect(press.played).toBe(false);
});

// ------------------------------------------------------ 3: creation by keys

test('3. creation by keyboard: Enter on a class removes the reason, Enter twice on might-plus keeps its focus', async ({ page }) => {
  await start(page, '/?scene=creation');
  await settle(page, 'creation');
  // Nothing is preselected, and the disabled Confirm says why.
  await expect(page.getByTestId('creation-confirm')).toBeDisabled();
  await expect(page.getByTestId('creation-confirm-reason')).toHaveText('Choose a class to continue');
  for (const id of ['marine', 'engineer', 'scout']) {
    await expect(page.getByTestId(`class-${id}`)).toHaveAttribute('aria-pressed', 'false');
  }
  // Back sits left of Confirm in the footer.
  const order = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.creation-foot [data-testid]')].map((node) => node.dataset['testid']),
  );
  expect(order.indexOf('creation-back')).toBeLessThan(order.indexOf('creation-confirm'));

  await tabTo(page, 'class-marine');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('creation-confirm-reason')).toHaveCount(0);
  await expect(page.getByTestId('creation-confirm')).toBeEnabled();
  expect(await focused(page)).toBe('class-marine');
  // The class card spells its base attributes.
  await expect(page.getByTestId('class-marine').locator('.class-base')).toHaveText('Might 3 · Vigor 3 · Agility 1 · Tech 1');

  await tabTo(page, 'attr-might-plus');
  const before = Number(await page.getByTestId('attr-might').textContent());
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('attr-might')).toHaveText(String(before + 2));
  expect(await focused(page)).toBe('attr-might-plus');

  // Each attribute row says what a point buys.
  await expect(page.getByTestId('attr-might-desc')).toHaveText('Might — +4 % damage per point');
  await expect(page.getByTestId('attr-vigor-desc')).toHaveText('Vigor — +8 max HP per point');
  await expect(page.getByTestId('attr-agility-desc')).toHaveText('Agility — +2 % speed · +2 % crit chance · −3 % dash cooldown per point');
  await expect(page.getByTestId('attr-tech-desc')).toHaveText('Tech — +10 % companion effect · −3 % prices per point');

  // 44-c: the last point spent disables might-plus; focus moves to a neighbour, not the page.
  for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
  await expect(page.getByTestId('attr-might-plus')).toBeDisabled();
  const after = await focused(page);
  expect(after).not.toBeNull();
  expect(after).not.toBe('attr-might-plus');
});

// ------------------------------------------------------- 4: creation's Back

test('4. creation Back: a changed form asks, Leave reaches the menu and writes nothing; Escape does the same', async ({ page }) => {
  await start(page, '/?scene=creation');
  await settle(page, 'creation');
  expect(await slotKeys(page)).toEqual([]);
  const sheet = page.getByTestId('confirm-sheet');

  await page.getByTestId('creation-name').fill('Vance');
  await page.getByTestId('creation-back').click();
  await expect(sheet).toContainText('Leave without creating a salvager?');
  await expect(page.getByTestId('confirm-yes')).toHaveText('Leave');
  await expect(page.getByTestId('confirm-no')).toHaveText('Stay');
  // `focus: 'cancel'` — Stay takes focus.
  expect(await focused(page)).toBe('confirm-no');
  await page.getByTestId('confirm-yes').click();
  await settle(page, 'menu');
  expect(await slotKeys(page)).toEqual([]);
  expect(await page.evaluate(() => window.__reallm.save().current)).toBeNull();

  // Escape is the same Back, through the back-stack.
  await page.evaluate(() => window.__reallm.go('creation', { slot: 1 }));
  await settle(page, 'creation');
  await page.getByTestId('creation-name').fill('Vance');
  await page.keyboard.press('Escape');
  await expect(sheet).toContainText('Leave without creating a salvager?');
  // Escape on the sheet is Stay: one layer per press.
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('scene-label')).toHaveText('creation');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await focused(page)).toBe('confirm-yes');
  await page.keyboard.press('Enter');
  await settle(page, 'menu');
  expect(await slotKeys(page)).toEqual([]);

  // 44-g: an untouched form goes straight to the menu — by Escape, and by the system Back.
  await page.evaluate(() => window.__reallm.go('creation', { slot: 2 }));
  await settle(page, 'creation');
  await page.keyboard.press('Escape');
  await settle(page, 'menu');
  await expect(sheet).toHaveCount(0);
  await page.evaluate(() => window.__reallm.go('creation', { slot: 2 }));
  await settle(page, 'creation');
  const url = page.url();
  await page.goBack();
  await settle(page, 'menu');
  expect(page.url()).toBe(url);
  expect(await slotKeys(page)).toEqual([]);
});

// ------------------------------------------------------- 5: station tablist

test('5. the station sections are a tablist: ArrowDown then Enter opens the Shop and keeps focus on its tab', async ({ page }) => {
  await start(page, URL);
  await prepare(page, {});
  await station(page);
  await expect(page.locator('[role="tablist"] [role="tab"]')).toHaveCount(3);
  await expect(page.locator('[role="tablist"]')).toHaveAttribute('aria-label', 'Station');

  await page.getByTestId('station-tab-missions').focus();
  await page.keyboard.press('ArrowDown');
  expect(await focused(page)).toBe('station-tab-shop');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('shop')).toBeVisible();
  expect(await focused(page)).toBe('station-tab-shop');
  await expect(page.getByTestId('station-tab-shop')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('station-tab-shop')).toHaveAttribute('tabindex', '0');
  await expect(page.getByTestId('station-tab-missions')).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByTestId('station-tab-missions')).toHaveAttribute('tabindex', '-1');

  // The panel is the tablist's tabpanel, labelled by the selected tab.
  const panel = page.getByTestId('station-root');
  await expect(panel).toHaveAttribute('role', 'tabpanel');
  await expect(panel).toHaveAttribute('id', 'station-panel');
  await expect(panel).toHaveAttribute('aria-labelledby', 'station-tab-shop');
  await expect(page.getByTestId('station-tab-shop')).toHaveAttribute('aria-controls', 'station-panel');

  // Home, End and the wrap; ArrowUp walks back.
  await page.keyboard.press('End');
  expect(await focused(page)).toBe('station-tab-character');
  await page.keyboard.press('ArrowRight');
  expect(await focused(page)).toBe('station-tab-missions');
  await page.keyboard.press('ArrowUp');
  expect(await focused(page)).toBe('station-tab-character');
  await page.keyboard.press('Home');
  expect(await focused(page)).toBe('station-tab-missions');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('mission-board')).toBeVisible();
  expect(await focused(page)).toBe('station-tab-missions');

  // The actions follow a rule as plain buttons: no tab role, no pressed state.
  await expect(page.locator('.screen-rail .screen-rail-rule')).toHaveCount(1);
  const labels: Record<string, string> = { starmap: 'Star Map ›', settings: 'Settings', quit: 'Quit to menu' };
  for (const [id, label] of Object.entries(labels)) {
    const action = page.getByTestId(`station-tab-${id}`);
    await expect(action).toHaveText(label);
    expect(await action.getAttribute('role')).toBeNull();
    expect(await action.getAttribute('aria-pressed')).toBeNull();
  }
});

// ---------------------------------------------------------- 6: next step

test('6. the next step: an accepted c2_m1 says where to go, and its Star Map opens on Vetra with Depart focused', async ({ page }) => {
  await start(page, URL);
  await prepare(page, CHAPTER_ONE_DONE);
  await station(page);
  const rail = page.getByTestId('station-tab-starmap');
  // No mission active: the rail's Star Map is a plain action.
  await expect(rail).not.toHaveClass(/is-primary/);

  await page.getByTestId('mission-c2_m1-accept').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toasts')).toContainText("Accepted 'Whiteout'");
  const row = page.getByTestId('mission-c2_m1');
  await expect(row.getByTestId('board-next')).toHaveText('Next: Star Map → depart for Vetra');
  // 44-d: Accept became Star Map, Pin and Abandon; focus followed the row.
  expect(await page.evaluate(() => document.activeElement?.closest('[data-testid="mission-c2_m1"]') !== null)).toBe(true);
  const actions = await row.locator('.board-actions .ui-btn').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset['testid']));
  expect(actions).toEqual(['mission-c2_m1-go', 'mission-c2_m1-pin', 'mission-c2_m1-abandon']);
  await expect(page.getByTestId('mission-c2_m1-go')).toHaveText('Star Map');
  await expect(page.getByTestId('mission-c2_m1-go')).toHaveClass(/is-primary/);
  // A mission is active: the rail's Star Map is the primary now.
  await expect(rail).toHaveClass(/is-primary/);

  await page.getByTestId('mission-c2_m1-go').focus();
  await page.keyboard.press('Enter');
  await settle(page, 'starmap');
  await expect(page.getByTestId('starmap-info-name')).toHaveText('Vetra');
  await expect(page.getByTestId('map-node-vetra')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => focused(page)).toBe('starmap-depart');

  // A world with work waiting carries the ◆, and says so.
  await expect(page.getByTestId('map-node-vetra-missions')).toHaveText('◆');
  await expect(page.getByTestId('map-node-vetra')).toHaveAttribute('aria-label', /missions waiting/);
  await expect(page.getByTestId('map-node-cinder4-missions')).toBeVisible(); // its side missions are open
  await expect(page.getByTestId('map-node-ferrum-missions')).toHaveCount(0);
  await expect(page.getByTestId('map-node-ferrum')).not.toHaveAttribute('aria-label', /missions waiting/);
});

test('6b. with nothing given, the map opens on the tracked mission’s planet; a locked one falls back to Back', async ({ page }) => {
  await start(page, URL);
  await prepare(page, { ...CHAPTER_ONE_DONE, active: ['c1_s1'] });
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await settle(page, 'station');
  await page.evaluate(() => window.__reallm.go('starmap', undefined));
  await settle(page, 'starmap');
  // The tracked mission is Cinder-4's, ahead of Vetra's newer work.
  await expect(page.getByTestId('starmap-info-name')).toHaveText('Cinder-4');
  await expect.poll(() => focused(page)).toBe('starmap-depart');
  // 44-h: a locked planet given is ignored.
  await page.getByTestId('starmap-back').click();
  await settle(page, 'station');
  await page.evaluate(() => window.__reallm.go('starmap', { planet: 'ferrum' }));
  await settle(page, 'starmap');
  await expect(page.getByTestId('starmap-info-name')).toHaveText('Cinder-4');
  // Arrows onto a locked world: Depart disables and focus moves to Back.
  for (let i = 0; i < 6 && (await page.getByTestId('starmap-info-name').textContent()) !== 'Ferrum'; i++) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(page.getByTestId('starmap-depart')).toBeDisabled();
  expect(await focused(page)).toBe('starmap-back');
});

// -------------------------------------------------------- 7: pad terminal

test('7. the pad terminal: E opens it on the first Accept, Enter accepts, Tab stays inside, Escape closes it', async ({ page }) => {
  await start(page, DEBUG_URL);
  await prepare(page, { done: ['c1_m1'] });
  await land(page);
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="surface-goto-pad"]');
    if (button === null) throw new Error('no surface-goto-pad on the debug strip');
    button.click();
  });
  const terminal = page.getByTestId('pad-terminal');
  for (let i = 0; i < 6 && !(await terminal.isVisible()); i++) {
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(400);
  }
  await expect(terminal).toBeVisible();
  await expect(terminal).toHaveAttribute('role', 'dialog');
  await expect(terminal).toHaveAttribute('aria-modal', 'true');
  await expect.poll(() => focused(page)).toBe('terminal-accept-c1_m2');
  const depth = await page.evaluate(() => window.__reallm.backDepth());
  expect(depth).toBeGreaterThanOrEqual(1);

  // The offer says what it is.
  const row = page.getByTestId('terminal-row-c1_m2');
  await expect(row).toContainText('Main');
  await expect(row).toContainText('+150 XP');
  await expect(page.getByTestId('terminal-brief-c1_m2')).toHaveText('Cinder-4 sits on oil and the raiders sit on the oil.');
  // c1_m1 is a replay here, after the new work, and says so.
  await expect(page.getByTestId('terminal-row-c1_m1')).toContainText('Replay · 50 %');
  // A tap on the title shows the whole brief.
  await row.locator('.terminal-offer-title').click();
  await expect(page.getByTestId('terminal-brief-c1_m2')).toHaveText(
    'Cinder-4 sits on oil and the raiders sit on the oil. Pull 150 units out of the ground and put six of them in it.',
  );
  await page.getByTestId('terminal-accept-c1_m2').focus();

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toasts')).toContainText("Accepted 'Black Gold'");
  await expect(page.getByTestId('terminal-accept-c1_m2')).toHaveCount(0);
  // The active mission reads by stage, the tracked one marked, and no ◈.
  await expect(terminal.locator('.terminal-active')).toContainText('Black Gold — Stage 1/');
  await expect(terminal.locator('.terminal-active')).toContainText('Tracked');
  await expect(terminal.locator('.terminal-active')).not.toContainText('◈');
  expect(await page.evaluate(() => document.querySelector('[data-testid="pad-terminal"]')?.contains(document.activeElement) === true)).toBe(true);

  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.querySelector('[data-testid="pad-terminal"]')?.contains(document.activeElement) === true),
      `Tab ${i + 1} stays inside the terminal`,
    ).toBe(true);
  }
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.querySelector('[data-testid="pad-terminal"]')?.contains(document.activeElement) === true)).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(terminal).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__reallm.backDepth())).toBe(depth - 1);
  await expect(page.getByTestId('pause-menu')).toBeHidden();
});

// ----------------------------------------------------------- 8: danger focus

test('8. the board’s Abandon opens its sheet on Cancel, so Enter keeps the mission', async ({ page }) => {
  await start(page, URL);
  await prepare(page, { active: ['c1_m1'] });
  await station(page);
  await page.getByTestId('mission-c1_m1-abandon').focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByTestId('confirm-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.sheet')).toHaveAttribute('aria-modal', 'true');
  expect(await focused(page)).toBe('confirm-no');
  await page.keyboard.press('Enter');
  await expect(sheet).toHaveCount(0);
  expect(await page.evaluate(() => window.__reallm.save().current?.progress.missionsActive.map((entry) => entry.id))).toEqual(['c1_m1']);
  // The sheet gave focus back to the button that opened it.
  expect(await focused(page)).toBe('mission-c1_m1-abandon');
});

// ------------------------------------------- 8b, 8c: the gear card and the stay card

/** True while focus is inside the element with testid `id`. */
async function focusInside(page: Page, id: string): Promise<boolean> {
  return page.evaluate((testid) => document.querySelector(`[data-testid="${testid}"]`)?.contains(document.activeElement) ?? false, id);
}

test('8b. the gear card opens on its first button that takes focus: Close while Buy is out of reach, Buy once it is not', async ({ page }) => {
  await start(page, URL);
  await prepare(page, {});
  await station(page);
  await page.getByTestId('station-tab-shop').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('shop-tab-gear').focus();
  await page.keyboard.press('Enter');
  const details = page.getByTestId('shop-gear-pistol_magnum-details');
  await details.focus();
  await page.keyboard.press('Enter');
  const card = page.getByTestId('gear-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-modal', 'true');
  // A fresh save holds no tokens: the Hand Cannon's 50 are out of reach, so
  // its Buy is disabled and cannot take focus — Close does (§4.3).
  await expect(page.getByTestId('gear-card-buy')).toBeDisabled();
  expect(await focused(page)).toBe('gear-card-close');
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await focusInside(page, 'gear-card'), `Tab ${i + 1} stays in the card`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  expect(await focused(page)).toBe('shop-gear-pistol_magnum-details');

  // With the tokens in hand, Buy is the first button and takes focus.
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) throw new Error('no save bound');
    save.player.tokens = 500;
  });
  await page.keyboard.press('Enter');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('gear-card-buy')).toBeEnabled();
  expect(await focused(page)).toBe('gear-card-buy');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  expect(await focused(page)).toBe('shop-gear-pistol_magnum-details');
});

test('8c. the stay-ending card is a modal on Continue, and Enter continues', async ({ page }) => {
  // SPEC-024 case 7's replay path: the stay chosen and filed, the report not
  // yet seen, films off — the station plays the card on entry.
  await start(page, '/?films=off&debug&seed=123');
  await prepare(page, {
    done: ['c6_m1', 'c6_m2'],
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
      'campaign_done',
      'ending_stay',
    ],
  });
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await settle(page, 'station');
  const card = page.getByTestId('ending-stay');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveAttribute('role', 'dialog');
  await expect(card).toHaveAttribute('aria-modal', 'true');
  await expect.poll(() => focused(page)).toBe('ending-continue');
  await page.keyboard.press('Tab');
  expect(await focusInside(page, 'ending-stay')).toBe(true);
  await page.keyboard.press('Enter');
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => window.__reallm.save().current?.progress.endingSeen)).toBe(true);
});

// ------------------------------------------------------------ 9: controls

test('9. Settings and the pause menu’s Controls both open `controls-sheet`, with the same rows', async ({ page }) => {
  await start(page, DEBUG_URL);
  await prepare(page, {});
  await station(page);
  await page.getByTestId('station-tab-settings').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-panel')).toBeVisible();
  // §4.3: the settings panel opens on Close.
  expect(await focused(page)).toBe('settings-close');
  await page.getByTestId('settings-controls').focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByTestId('controls-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Continue a transmission');
  await expect(sheet).toContainText('Back / close');
  expect(await focused(page)).toBe('controls-close');
  const rows = async (selector: string): Promise<string[]> =>
    page.locator(`${selector} .pause-sheet-row`).evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
  const fromSettings = await rows('[data-testid="controls-sheet"]');
  expect(fromSettings.length).toBeGreaterThanOrEqual(15);

  // One layer per Escape: the sheet, then the panel; focus walks back each time.
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(await focused(page)).toBe('settings-controls');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-panel')).toBeHidden();
  expect(await focused(page)).toBe('station-tab-settings');

  await land(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  // §4.3: the pause menu opens on Resume.
  expect(await focused(page)).toBe('pause-resume');
  await page.getByTestId('pause-controls').focus();
  await page.keyboard.press('Enter');
  // §4.5: the same sheet, docked in the menu's `pause-sheet` beside the
  // actions (SPEC-036 §4.8) rather than over them.
  const docked = page.getByTestId('pause-sheet').getByTestId('controls-sheet');
  await expect(docked).toBeVisible();
  await expect(page.getByTestId('controls-sheet')).toHaveCount(1);
  expect(await rows('[data-testid="pause-sheet"] [data-testid="controls-sheet"]')).toEqual(fromSettings);
  // Controls again closes it, and a closed sheet holds nothing.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('controls-sheet')).toHaveCount(0);
  await expect(page.getByTestId('pause-sheet')).toBeHidden();

  // Docked, then Settings: the panel's own sheet is then the one controls sheet.
  await page.keyboard.press('Enter');
  await expect(docked).toBeVisible();
  await page.getByTestId('pause-settings').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-panel')).toBeVisible();
  await page.getByTestId('settings-controls').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('controls-sheet')).toHaveCount(1);
  await expect(page.getByTestId('controls-sheet')).toBeVisible();
  expect(await rows('[data-testid="controls-sheet"]')).toEqual(fromSettings);
  expect(await focused(page)).toBe('controls-close');
  // One layer per Escape again, and focus walks back to the pause menu.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('controls-sheet')).toHaveCount(0);
  expect(await focused(page)).toBe('settings-controls');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-panel')).toBeHidden();
  expect(await focused(page)).toBe('pause-settings');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
});

test('9b. on the menu the settings panel keeps the arrow keys; closed, focus is back on Settings', async ({ page }) => {
  await start(page);
  await settle(page, 'menu');
  await page.getByTestId('menu-settings').focus();
  await page.keyboard.press('Enter');
  const panel = page.getByTestId('settings-panel');
  await expect(panel).toBeVisible();
  expect(await focused(page)).toBe('settings-close');
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  // The menu walks its buttons on the arrows; the modal above it is not walked out of.
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
    await page.keyboard.press(key);
    expect(await page.evaluate(() => document.querySelector('[data-testid="settings-panel"]')?.contains(document.activeElement) === true), `${key} stays inside Settings`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  expect(await focused(page)).toBe('menu-settings');
  // With the panel closed, the arrows walk the menu again.
  await page.keyboard.press('ArrowDown');
  expect(await focused(page)).not.toBe('menu-settings');
});

// --------------------------------------------------------- 10: Save & Quit

test('10. Save & Quit on Ferrum names the cost; Keep playing leaves the pause menu open', async ({ page }) => {
  await start(page, URL);
  await prepare(page, {});
  await land(page, 'ferrum');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await tabTo(page, 'pause-quit', 12);
  await expect(page.getByTestId('pause-quit')).toHaveText('Save & Quit');
  await page.keyboard.press('Enter');
  const sheet = page.getByTestId('confirm-sheet');
  await expect(sheet).toContainText('Quit to the main menu?');
  await expect(sheet).toContainText('You will resume at Command Relay. Flying back to Ferrum costs 100 oil, and timed objectives restart.');
  await expect(page.getByTestId('confirm-no')).toHaveText('Keep playing');
  await expect(page.getByTestId('confirm-yes')).toHaveText('Quit');
  expect(await focused(page)).toBe('confirm-no');
  await page.keyboard.press('Enter');
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await expect(page.getByTestId('scene-label')).toHaveText('surface');

  // Quit goes through with today's save-and-quit.
  await page.getByTestId('pause-quit').click();
  await page.getByTestId('confirm-yes').click();
  await settle(page, 'menu');
  expect(await slotKeys(page)).toContain('reallm:slot:0');
});

test('10b. in flight the sheet says the jump’s fuel is already spent', async ({ page }) => {
  await start(page, URL);
  await prepare(page, {});
  await page.evaluate(() => window.__reallm.go('flight', { destination: 'ferrum' }, { force: true }));
  await settle(page, 'flight');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.getByTestId('pause-quit').click();
  await expect(page.getByTestId('confirm-sheet')).toContainText('You will resume at Command Relay. The fuel for this jump (100 oil) is already spent.');
  await page.getByTestId('confirm-no').click();
  await expect(page.getByTestId('pause-menu')).toBeVisible();
});

// ------------------------------------------------------------- 11: credits

test('11. the credits are written for players: Google Gemini, the licences link, no file names or spec ids', async ({ page }) => {
  await start(page);
  await page.getByTestId('menu-credits').click();
  const text = page.getByTestId('credits-text');
  await expect(text).toContainText('Google Gemini');
  await expect(text).toContainText('Apache License 2.0');
  await expect(page.getByTestId('credits-prologue')).toBeVisible();
  const link = page.getByTestId('credits-licences');
  await expect(link).toHaveText('Asset licences');
  await expect(link).toHaveAttribute('href', 'assets/LICENSES.md');
  await expect(link).toHaveAttribute('target', '_blank');
  const all = (await page.locator('.credits').innerText()) ?? '';
  expect(all).not.toContain('ending_escape');
  expect(all).not.toContain('SPEC-');
  expect(all).not.toMatch(/PLAN R\d/);
  expect(all).not.toMatch(/\|\s*---/);
  // The licence file opens in a tab of its own.
  const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
  await tab.waitForLoadState('domcontentloaded');
  expect(tab.url()).toContain('assets/LICENSES.md');
  await tab.close();
});

// ------------------------------------------------------------- 12: storage

test('12. storage: a newer save offers Export only; a corrupt slot’s Delete asks, and Cancel keeps it', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    localStorage.setItem('reallm:slot:1', JSON.stringify({ version: 99, player: {} }));
    localStorage.setItem('reallm:slot:2', '{"version":1,"player":');
    localStorage.setItem('reallm:slot:2:bak', 'not a save at all');
  });
  await start(page); // a reload: the menu builds its rows from storage

  const newer = page.getByTestId('slot-1');
  await expect(newer).toContainText('Slot 2 · Save from a newer version');
  await expect(newer).not.toContainText('Corrupt');
  await expect(page.getByTestId('slot-1-export')).toBeVisible();
  await expect(page.getByTestId('slot-1-delete')).toHaveCount(0);
  await expect(page.getByTestId('slot-1-import')).toHaveCount(0);
  await expect(page.getByTestId('slot-0')).toHaveText('Slot 1 · Empty');

  const corrupt = page.getByTestId('slot-2');
  await expect(corrupt).toContainText('Slot 3 · Corrupt');
  await page.getByTestId('slot-2-delete').focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByTestId('confirm-sheet');
  await expect(sheet).toContainText('Delete slot 3 and its backup?');
  await expect(sheet).toContainText('This cannot be undone.');
  expect(await focused(page)).toBe('confirm-no');
  await page.keyboard.press('Enter');
  await expect(sheet).toHaveCount(0);
  expect(await slotKeys(page)).toEqual(['reallm:slot:1', 'reallm:slot:2', 'reallm:slot:2:bak']);

  await page.getByTestId('slot-2-delete').click();
  await page.getByTestId('confirm-yes').click();
  await expect(corrupt).toContainText('Slot 3 · Empty');
  expect(await slotKeys(page)).toEqual(['reallm:slot:1']);
});

// ---------------------------------------------------------- 13: board words

test('13. the board speaks words: no status ids, a closed Completed fold, and a contract outside it', async ({ page }) => {
  await start(page, URL);
  await prepare(page, { done: ['c1_m1'], active: ['c1_m2'] });
  await station(page);
  const statuses = await page.locator('[data-testid="mission-board"] .board-status').allTextContents();
  expect(statuses.length).toBeGreaterThan(0);
  for (const status of statuses) expect(['active', 'available', 'locked', 'replayable', 'done']).not.toContain(status);
  await expect(page.getByTestId('mission-c1_m2').locator('.board-status')).toHaveText('In progress');
  await expect(page.getByTestId('mission-c1_s1').locator('.board-status')).toHaveText('New');
  await expect(page.getByTestId('mission-c1_m3').locator('.board-status')).toHaveText('Locked');
  await expect(page.getByTestId('mission-c1_m3').locator('.board-locked')).toHaveText("Needs: Complete 'Black Gold'");
  await expect(page.getByTestId('mission-c1_m1').locator('.board-status')).toHaveText('Done · replay for 50 %');
  await expect(page.getByTestId('mission-c1_m2').locator('.badge-main')).toHaveText('Main');
  await expect(page.getByTestId('mission-c1_s1').locator('.badge-side')).toHaveText('Side');
  await expect(page.getByTestId('mission-c1_m2').locator('.badge-pin')).toHaveText('Tracked');

  // The finished row sits in the planet's fold, which starts closed.
  const fold = page.getByTestId('board-done-cinder4');
  await expect(fold).toHaveCount(1);
  expect(await fold.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
  await expect(fold.locator('summary')).toHaveText('Completed (1)');
  expect(await page.evaluate(() => document.querySelector('[data-testid="mission-c1_m1"]')?.closest('[data-testid="board-done-cinder4"]') !== null)).toBe(true);
  await expect(page.getByTestId('mission-c1_m1')).toBeHidden();
  // Opened, it shows the replay — and stays open across a refresh.
  await fold.locator('summary').click();
  await expect(page.getByTestId('mission-c1_m1-replay')).toBeVisible();
  await expect(page.getByTestId('mission-c1_m1-replay')).toContainText('50 % rewards');
  await page.getByTestId('mission-c1_m2-pin').click();
  expect(await fold.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(true);

});

test('13b. with c1_m2 done and chapter1_done set, its contract stays outside the fold, with its label', async ({ page }) => {
  await start(page, URL);
  await prepare(page, CHAPTER_ONE_DONE);
  await station(page);
  const contract = page.getByTestId('mission-c1_m2');
  await expect(contract).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('[data-testid="mission-c1_m2"]')?.closest('details') === null)).toBe(true);
  await expect(page.getByTestId('mission-c1_m2-replay')).toHaveText(/^Contract · .+ · 75 % \+ 20 lithium$/);
  await expect(page.getByTestId('mission-c1_m2-contract')).toBeVisible();
  await expect(contract.locator('.board-status')).toHaveText('Done');
  // An offer, sorted where replays go: after the planet's open work.
  const order = await page.evaluate(() => {
    const group = document.querySelector('[data-testid="mission-c1_m2"]')?.closest('.board-group');
    return [...(group?.querySelectorAll('.board-row') ?? [])].map((node) => (node as HTMLElement).dataset['testid']);
  });
  expect(order.indexOf('mission-c1_m2')).toBeGreaterThan(order.indexOf('mission-c1_s1'));
  // 44-k: every chapter-1 replay here is a contract, so Cinder-4 has nothing to fold.
  await expect(page.getByTestId('board-done-cinder4')).toHaveCount(0);
});
