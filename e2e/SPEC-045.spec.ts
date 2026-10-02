// SPEC-045 §6.2 — settings and accessibility in the browser: a line that holds
// by its length from the moment it is whole, Manual speed, the comms log, the
// settings panel's sections and per-scheme rows, reduce motion as a preset,
// UI scale and its default, text size, the ultrawide box, plain text, the
// colour-blind preset and the toast glyphs, the glossary's words, the
// formatter's units, the legacy button rule, the interface bus and mono,
// brightness, and inverted flight steering. The rules are pinned in node
// (`tests/core/settings.test.ts`, `tests/ui/settings.test.ts`,
// `tests/ui/dialogue.test.ts`, `tests/ui/commsLog.test.ts`,
// `tests/systems/format.test.ts`, `tests/ui/theme.test.ts`); this proves the
// wiring. Cases run at 1280 × 720 on the keyboard scheme unless they say
// otherwise, on `?debug`, with a save bound through the save bridge.
import { expect, test, type Page } from '@playwright/test';
import { awaitGate, COLD_START, frames, gameUrl, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const URL = '/?debug&seed=123';

/** `c3_m3_done` (`data/dialogue.ts`): Earth Command's 82-character line, then ARIA's. */
const C3_DONE = [
  { speaker: 'Earth Command', text: 'Ferrum is unlocked. You will need a shield rated two before we clear the approach.' },
  { speaker: 'ARIA', text: 'Three worlds. Three bosses. You have never once asked why they are always waiting for you.' },
] as const;

/** `c2_m3_done`: two lines, the first short. */
const C2_DONE = ['Thessaly is unlocked. Voucher sent.', 'Vent readings are clean. Vetra will hold. Two down.'] as const;

/** §4.7's rule for the player's text: a number never runs into its unit. */
const GLUED_UNIT = /\d(%|s\b|m\b|h\b|min\b)/;

/** The six sections, in §4.2's order. */
const SECTIONS = ['audio', 'display', 'controls', 'accessibility', 'gameplay', 'data'] as const;

/** A landscape phone: coarse pointer, touch points (SPEC-036 §4.2). */
const PHONE = { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true } as const;

/** Settings stored before the page loads, as a returning player's would be. */
async function prime(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.addInitScript((stored) => {
    if (sessionStorage.getItem('spec045:primed') !== null) return;
    sessionStorage.setItem('spec045:primed', '1');
    localStorage.setItem('reallm:settings', JSON.stringify({ version: 1, ...stored }));
  }, patch);
}

async function settle(page: Page, scene: string): Promise<void> {
  await expect(page.getByTestId('scene-label')).toHaveText(scene, COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
}

/** A fresh slot-0 save, bound; chapter 1 under way so the board has a mission. */
async function bind(page: Page): Promise<void> {
  await page.evaluate((creation) => {
    const bridge = window.__reallm.save();
    bridge.create(0, creation, 123);
    const save = bridge.current;
    if (save === null) throw new Error('no save bound');
    save.resources['oil'] = 200;
  }, CREATION);
}

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

/** The bound save on Cinder-4's surface, past any first line. */
async function land(page: Page): Promise<void> {
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
  await settle(page, 'surface');
  await dismiss(page);
}

/** Escape pauses a running surface or flight (SPEC-036 §4.4). */
async function pause(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
}

/** Opens the settings panel from the pause menu. */
async function pauseSettings(page: Page): Promise<void> {
  await pause(page);
  await page.getByTestId('pause-settings').click();
  await expect(page.getByTestId('settings-panel')).toBeVisible();
}

/** Closes the settings panel and the pause menu under it. */
async function resume(page: Page): Promise<void> {
  if (await page.getByTestId('settings-panel').isVisible()) await page.getByTestId('settings-close').click();
  await page.getByTestId('pause-resume').click();
  await expect(page.getByTestId('pause-menu')).toBeHidden();
}

async function stationSettings(page: Page): Promise<void> {
  await page.getByTestId('station-tab-settings').click();
  await expect(page.getByTestId('settings-panel')).toBeVisible();
}

async function storedSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('reallm:settings') ?? '{}') as Record<string, unknown>);
}

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
}

/** The bounding box of the first element matching `selector`, or `null` when it is not laid out. */
async function box(page: Page, selector: string): Promise<Box | null> {
  return page.evaluate((query) => {
    const node = document.querySelector(query);
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width };
  }, selector);
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** The computed font size of the first match, in px. */
async function fontSize(page: Page, selector: string): Promise<number> {
  return page.evaluate((query) => {
    const node = document.querySelector(query);
    if (node === null) throw new Error(`${query} is not in the page`);
    return Number.parseFloat(getComputedStyle(node).fontSize);
  }, selector);
}

/** Visible `.ui-btn`s under `root` whose label overflows the button. */
async function clippedButtons(page: Page, root: string): Promise<string[]> {
  return page.evaluate((query) => {
    const out: string[] = [];
    for (const scope of document.querySelectorAll(query)) {
      for (const button of scope.querySelectorAll<HTMLElement>('.ui-btn')) {
        if (button.getClientRects().length === 0) continue;
        if (button.scrollWidth > button.clientWidth + 1) out.push(button.dataset['testid'] ?? button.textContent ?? '?');
      }
    }
    return out;
  }, root);
}

/** The visible text of every element matching `selector`. */
async function textOf(page: Page, selector: string): Promise<string> {
  return page.evaluate((query) => [...document.querySelectorAll<HTMLElement>(query)].map((node) => node.innerText).join('\n'), selector);
}

// ------------------------------------------------------- 1–3: the dialogue

test('1. a whole line holds by its length, counted from when it is whole (§4.1)', async ({ page }) => {
  await prime(page, { typewriter: false, dialogueSpeed: 'slow' });
  await start(page, URL);
  await bind(page);
  await station(page);
  // Timed in the page, so the reading is the layer's own clock: the first
  // line lands whole at once (no typewriter), and holds 5.3 s × 1.5.
  const timing = await page.evaluate(
    async ({ first, second }) => {
      const text = (): string => document.querySelector('[data-testid="dialogue"] .dialogue-text')?.textContent ?? '';
      window.__reallm.playDialogue('c3_m3_done');
      const began = performance.now();
      let firstAt = -1;
      let secondAt = -1;
      let firstStillAt7 = false;
      while (performance.now() - began < 14_000) {
        const now = text();
        if (firstAt < 0 && now === first) firstAt = performance.now();
        if (firstAt >= 0 && performance.now() - firstAt >= 7_000 && performance.now() - firstAt < 7_400 && now === first) firstStillAt7 = true;
        if (now === second) {
          secondAt = performance.now();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return { firstAt, secondAt, firstStillAt7 };
    },
    { first: C3_DONE[0].text, second: C3_DONE[1].text },
  );
  expect(C3_DONE[0].text).toHaveLength(82);
  expect(timing.firstAt).toBeGreaterThan(0);
  expect(timing.firstStillAt7, 'the first line is still up 7 s after it appeared').toBe(true);
  expect(timing.secondAt - timing.firstAt).toBeGreaterThanOrEqual(7_000);
  expect(timing.secondAt - timing.firstAt, 'the second line shows by 9.5 s').toBeLessThanOrEqual(9_500);
});

test('2. under Manual a non-modal line waits, says so, and Enter moves it on (§4.1)', async ({ page }) => {
  test.setTimeout(150_000);
  // The line lands whole at once: this case is about the wait, not the typing.
  await prime(page, { dialogueSpeed: 'manual', typewriter: false });
  await start(page, URL);
  await bind(page);
  await station(page);
  await page.evaluate(() => window.__reallm.playDialogue('c2_m3_done'));
  const text = page.locator('[data-testid="dialogue"] .dialogue-text');
  await expect(text).toHaveText(C2_DONE[0]);
  await page.waitForTimeout(15_000);
  await expect(text).toHaveText(C2_DONE[0]);
  await expect(page.getByTestId('dialogue-next')).toBeVisible();
  await expect(page.getByTestId('dialogue-next')).toHaveText('▸ Enter');
  // Enter belongs to a focused control when one has focus (SPEC-044 §4.3).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Enter');
  await expect(text).toHaveText(C2_DONE[1]);
});

test('3. the comms log lists the lines shown, opens from the rail and the pause menu, and empties at the menu (§4.1)', async ({
  page,
}) => {
  await prime(page, { typewriter: false });
  await start(page, URL);
  await bind(page);
  await station(page);
  await page.evaluate(() => window.__reallm.playDialogue('c3_m3_done'));
  const text = page.locator('[data-testid="dialogue"] .dialogue-text');
  await expect(text).toHaveText(C3_DONE[0].text);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(400); // SPEC-044's key grace
  await page.keyboard.press('Enter');
  await expect(text).toHaveText(C3_DONE[1].text);
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dialogue')).toBeHidden();

  // The rail's action, then Escape: closed, and focus back on the rail.
  await page.getByTestId('station-tab-comms').click();
  const log = page.getByTestId('comms-log');
  await expect(log).toBeVisible();
  const lines = log.locator('.comms-line');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0).locator('.comms-speaker')).toHaveText(C3_DONE[0].speaker);
  await expect(lines.nth(0).locator('.comms-text')).toHaveText(C3_DONE[0].text);
  await expect(lines.nth(1).locator('.comms-speaker')).toHaveText(C3_DONE[1].speaker);
  await expect(lines.nth(1).locator('.comms-text')).toHaveText(C3_DONE[1].text);
  // The speaker reads in the dialogue's colour for that speaker.
  const colours = await page.evaluate(() => {
    const speaker = document.querySelector('[data-testid="comms-log"] .comms-line[data-speaker="aria"] .comms-speaker');
    const shield = getComputedStyle(document.documentElement).getPropertyValue('--shield').trim();
    const probe = document.createElement('span');
    probe.style.color = shield;
    document.body.append(probe);
    const want = getComputedStyle(probe).color;
    probe.remove();
    return { got: speaker === null ? null : getComputedStyle(speaker).color, want };
  });
  expect(colours.got).toBe(colours.want);
  await page.keyboard.press('Escape');
  await expect(log).toHaveCount(0);
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['testid'] ?? null)).toBe('station-tab-comms');

  // On the surface: Escape, then the pause menu's Comms log.
  await land(page);
  await pause(page);
  await page.getByTestId('pause-comms').click();
  await expect(log).toBeVisible();
  await expect(log.locator('.comms-text').filter({ hasText: C3_DONE[1].text })).toHaveCount(1);
  await page.getByTestId('comms-log-close').click();
  await expect(log).toHaveCount(0);
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['testid'] ?? null)).toBe('pause-comms');
  await page.getByTestId('pause-resume').click();

  // The main menu ends the run the log belongs to (45-g).
  await page.evaluate(() => window.__reallm.go('menu', {}, { force: true }));
  await settle(page, 'menu');
  await station(page);
  await page.getByTestId('station-tab-comms').click();
  await expect(log).toBeVisible();
  await expect(log.locator('.comms-empty')).toHaveText('No transmissions yet.');
  await expect(log.locator('.comms-line')).toHaveCount(0);
});

// ------------------------------------------------------------ 4: sections

test('4a. the panel shows six sections in order, with the keyboard rows (§4.2)', async ({ page }) => {
  await start(page, URL);
  await bind(page);
  await station(page);
  await stationSettings(page);
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="settings-panel"] [data-testid^="settings-section-"]')].map(
      (node) => node.dataset['testid'],
    ),
  );
  expect(ids).toEqual(SECTIONS.map((id) => `settings-section-${id}`));
  const panel = page.getByTestId('settings-panel');
  await expect(panel.getByTestId('settings-section-audio').locator('.settings-section-title')).toHaveText('Audio');
  await expect(panel.getByTestId('settings-mouse-steer')).toHaveCount(1);
  await expect(panel.getByTestId('settings-ui-scale')).toHaveCount(1);
  await expect(panel.getByTestId('settings-joystick-side')).toHaveCount(0);
  await expect(panel.getByTestId('settings-button-scale')).toHaveCount(0);
  await expect(panel.getByTestId('settings-haptics')).toHaveCount(0);
  // Controls opens with SPEC-044's sheet; Gameplay with the difficulty row.
  await expect(panel.getByTestId('settings-section-controls').locator('button').first()).toHaveAttribute('data-testid', 'settings-controls');
  await expect(panel.getByTestId('settings-section-gameplay').locator('.settings-seg').first()).toHaveAttribute('data-testid', 'settings-difficulty');
});

test.describe('4b. on the touch scheme', () => {
  test.use(PHONE);

  test('the panel shows Joystick side and Button size, and hides Mouse steer and UI scale (§4.2)', async ({ page }) => {
    await page.goto(gameUrl('/'));
    await awaitGate(page);
    await page.getByTestId('boot-start').tap();
    await expect(page.getByTestId('boot-overlay')).toBeHidden();
    await settle(page, 'menu');
    expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('touch');
    await page.getByTestId('menu-settings').tap();
    const panel = page.getByTestId('settings-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('settings-button-scale-125')).toHaveCount(1);
    await expect(panel.getByTestId('settings-joystick-side-left')).toHaveCount(1);
    await expect(panel.getByTestId('settings-mouse-steer')).toHaveCount(0);
    await expect(panel.getByTestId('settings-ui-scale')).toHaveCount(0);
    // The default 1 reads as 100 %, pressed.
    await expect(panel.getByTestId('settings-button-scale-100')).toHaveAttribute('aria-pressed', 'true');
  });
});

// --------------------------------------------------------- 5: the preset

test('5. Reduce motion presses the preset, and one of its four changes alone (§4.3)', async ({ page }) => {
  await start(page, URL);
  await bind(page);
  await station(page);
  await stationSettings(page);
  const panel = page.getByTestId('settings-panel');
  await expect(panel.getByTestId('settings-camera-shake-100')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('settings-typewriter')).toBeChecked();

  await panel.getByTestId('settings-reduce-motion').click();
  await expect(panel.getByTestId('settings-reduce-motion')).toBeChecked();
  await expect(panel.getByTestId('settings-camera-shake-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('settings-damage-flash-subtle')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('settings-film-mode-stills')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('settings-typewriter')).not.toBeChecked();

  await panel.getByTestId('settings-film-mode-video').click();
  await expect(panel.getByTestId('settings-film-mode-video')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('settings-reduce-motion')).toBeChecked();
  await expect(panel.getByTestId('settings-camera-shake-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('settings-damage-flash-subtle')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('settings-typewriter')).not.toBeChecked();

  expect(await storedSettings(page)).toMatchObject({
    reduceMotion: true,
    cameraShake: 0,
    damageFlash: 'subtle',
    filmMode: 'video',
    typewriter: false,
  });
  await expect(page.locator('html')).toHaveClass(/reduce-motion/);
});

// ---------------------------------------------------------- 6–9: scaling

/** Sets the UI scale through the pause menu's settings panel, then resumes. */
async function setUiScale(page: Page, percent: number): Promise<void> {
  await pauseSettings(page);
  await page.getByTestId(`settings-ui-scale-${percent}`).click();
  await expect(page.getByTestId(`settings-ui-scale-${percent}`)).toHaveAttribute('aria-pressed', 'true');
  await resume(page);
  await frames(page, 3);
}

const CORNERS = ['.hud-tl', '.hud-tr', '.hud-tc', '.hud-bl', '.hud-br', '.hud-bc'] as const;

test('6a. at 150 % the quick bar is 1.5 × as wide about the same centre, and every box stays in view (§4.4)', async ({ page }) => {
  await start(page, URL);
  await bind(page);
  await land(page);
  const before = await box(page, '.quickbar');
  if (before === null) throw new Error('the quick bar is not laid out');
  await setUiScale(page, 150);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim())).toBe('1.5');
  const after = await box(page, '.quickbar');
  if (after === null) throw new Error('the quick bar is not laid out');
  expect(Math.abs(after.width - before.width * 1.5), `${before.width} → ${after.width}`).toBeLessThanOrEqual(2);
  expect(Math.abs((after.left + after.right) / 2 - (before.left + before.right) / 2)).toBeLessThanOrEqual(2);
  for (const corner of CORNERS) {
    const rect = await box(page, `[data-testid="hud"] ${corner}`);
    if (rect === null) continue;
    expect(rect.left, `${corner} left`).toBeGreaterThanOrEqual(-0.5);
    expect(rect.top, `${corner} top`).toBeGreaterThanOrEqual(-0.5);
    expect(rect.right, `${corner} right`).toBeLessThanOrEqual(1280.5);
    expect(rect.bottom, `${corner} bottom`).toBeLessThanOrEqual(720.5);
  }
});

test.describe('6b. at 1920 × 1080', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('at 115 % and 130 % the HUD boxes, the interact prompt and the toast rack do not overlap (§4.4)', async ({ page }) => {
    await start(page, URL);
    await bind(page);
    await land(page);
    for (const percent of [115, 130]) {
      await setUiScale(page, percent);
      await page.evaluate(() => window.__reallm.toast('Saved', 'good'));
      await expect(page.locator('.toast')).toHaveCount(1);
      const named: Array<[string, string]> = [
        ['top-left', '[data-testid="hud"] .hud-tl'],
        ['top-centre', '[data-testid="hud"] .hud-tc'],
        ['quick bar', '[data-testid="hud"] .hud-bc'],
        ['interact', '[data-testid="hud-interact"]'],
        ['minimap', '[data-testid="minimap"]'],
        ['toasts', '[data-testid="toasts"]'],
      ];
      const boxes: Array<[string, Box]> = [];
      for (const [name, selector] of named) {
        const rect = await box(page, selector);
        if (rect !== null) boxes.push([name, rect]);
      }
      expect(boxes.map(([name]) => name)).toEqual(expect.arrayContaining(['top-left', 'top-centre', 'quick bar', 'minimap', 'toasts']));
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const [a, rectA] = boxes[i] as [string, Box];
          const [b, rectB] = boxes[j] as [string, Box];
          expect(overlaps(rectA, rectB), `${a} and ${b} at ${percent} %`).toBe(false);
        }
      }
      await page.waitForTimeout(100);
    }
  });
});

test.describe('7a. a large screen and a tall window', () => {
  test.use({ viewport: { width: 1920, height: 1000 }, screen: { width: 1920, height: 1080 } });

  test('default UI scale to 115 %, without storing it (§4.4)', async ({ page }) => {
    await start(page, '/');
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim()))
      .toBe('1.15');
    expect((await storedSettings(page))['uiScale']).toBeUndefined();
  });
});

test('7b. the default 1280 × 720 window reads 100 % (§4.4)', async ({ page }) => {
  await start(page, '/');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim())).toBe('1');
  expect((await storedSettings(page))['uiScale']).toBeUndefined();
});

interface TextWalk {
  readonly pauseSettings: number;
  readonly dialogue: number;
  readonly toast: number;
  readonly boardRewards: number;
  readonly starmapLine: number;
  readonly hudHp: number;
  readonly clipped: string[];
}

/** The station, a dialogue, a toast, the star map, then the surface's HUD and pause menu. */
async function walkText(page: Page): Promise<TextWalk> {
  await start(page, URL);
  await bind(page);
  await station(page);
  const boardRewards = await fontSize(page, '.board-rewards');
  const clipped = await clippedButtons(page, '[data-testid="screen"]');
  await stationSettings(page);
  clipped.push(...(await clippedButtons(page, '[data-testid="settings-panel"]')));
  await page.getByTestId('settings-close').click();
  await page.evaluate(() => window.__reallm.playDialogue('c2_m3_done'));
  await expect(page.getByTestId('dialogue')).toBeVisible();
  const dialogue = await fontSize(page, '[data-testid="dialogue"] .dialogue-text');
  await page.evaluate(() => window.__reallm.toast('Saved', 'good'));
  await expect(page.locator('.toast')).toHaveCount(1);
  const toast = await fontSize(page, '.toast');
  await page.evaluate(() => window.__reallm.go('starmap', undefined, { force: true }));
  await settle(page, 'starmap');
  const starmapLine = await fontSize(page, '.starmap-line');
  await land(page);
  const hudHp = await fontSize(page, '[data-testid="hud-hp"] .bar-text');
  await pause(page);
  const pauseSize = await fontSize(page, '[data-testid="pause-settings"]');
  clipped.push(...(await clippedButtons(page, '[data-testid="pause-menu"]')));
  return { pauseSettings: pauseSize, dialogue, toast, boardRewards, starmapLine, hudHp, clipped };
}

test('8. at 140 % the reading text is 1.4 × as large, the HUD readouts are not, and no button clips (§4.4)', async ({ browser }) => {
  test.setTimeout(240_000);
  const plain = await browser.newPage();
  const base = await walkText(plain);
  await plain.close();
  const large = await browser.newPage();
  await prime(large, { textScale: 1.4 });
  const scaled = await walkText(large);
  await large.close();
  for (const key of ['pauseSettings', 'dialogue', 'toast', 'boardRewards', 'starmapLine'] as const) {
    expect(Math.abs(scaled[key] - base[key] * 1.4), `${key}: ${base[key]} → ${scaled[key]}`).toBeLessThanOrEqual(0.5);
  }
  expect(scaled.hudHp).toBe(base.hudHp);
  expect(scaled.clipped).toEqual([]);
});

test.describe('9. wider than 21 : 9', () => {
  test.use({ viewport: { width: 2560, height: 1080 } });

  test('the corner boxes sit on a centred 16 : 9 box, and the vignette still spans the screen (§4.4)', async ({ page }) => {
    await start(page, URL);
    await bind(page);
    await land(page);
    const topLeft = await box(page, '[data-testid="hud"] .hud-tl');
    const bottomRight = await box(page, '[data-testid="hud"] .hud-br');
    if (topLeft === null || bottomRight === null) throw new Error('the corner boxes are not laid out');
    expect(topLeft.left).toBeGreaterThanOrEqual(319);
    expect(bottomRight.right).toBeLessThanOrEqual(2241);
    const vignette = await page.evaluate(() => {
      const node = document.querySelector('.hud-vignette');
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      return { left: rect.left, width: rect.width };
    });
    expect(vignette).toEqual({ left: 0, width: 2560 });
  });
});

// ------------------------------------------------------ 10–12: text, colour

test('10. plain text: no uppercase, tight tracking, and a taller reading line (§4.5)', async ({ page }) => {
  await prime(page, { plainText: true });
  await start(page, URL);
  await expect(page.locator('html')).toHaveClass(/plain-text/);
  await bind(page);
  await station(page);
  await page.evaluate(() => window.__reallm.playDialogue('c2_m3_done'));
  await expect(page.getByTestId('dialogue')).toBeVisible();
  const line = await page.evaluate(() => {
    const node = document.querySelector('[data-testid="dialogue"] .dialogue-text') as HTMLElement;
    const style = getComputedStyle(node);
    return { lineHeight: Number.parseFloat(style.lineHeight), fontSize: Number.parseFloat(style.fontSize) };
  });
  expect(Math.abs(line.lineHeight - line.fontSize * 1.55)).toBeLessThanOrEqual(0.5);
  await land(page);
  await pause(page);
  const button = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('[data-testid="pause-settings"]') as HTMLElement);
    return {
      transform: style.textTransform,
      spacing: style.letterSpacing === 'normal' ? 0 : Number.parseFloat(style.letterSpacing),
      fontSize: Number.parseFloat(style.fontSize),
    };
  });
  expect(button.transform).toBe('none');
  expect(button.spacing).toBeLessThanOrEqual(button.fontSize * 0.02 + 0.01);
});

test('11. toasts lead with their glyph, and the colour-blind preset recolours good and danger (§4.5)', async ({ page }) => {
  await start(page, URL);
  await bind(page);
  await station(page);
  await page.evaluate(() => {
    window.__reallm.toast('Saved', 'good');
    window.__reallm.toast('Not enough tokens', 'error');
    window.__reallm.toast('Cargo nearly full', 'warn');
    window.__reallm.toast('Quality: low', 'info');
  });
  await expect(page.locator('.toast-good .glyph')).toHaveText('✓');
  await expect(page.locator('.toast-error .glyph')).toHaveText('✗');
  await expect(page.locator('.toast-warn .glyph')).toHaveText('▲');
  await expect(page.locator('.toast-info .glyph')).toHaveCount(0);

  await stationSettings(page);
  await page.getByTestId('settings-colour-preset-colour-blind').click();
  await expect(page.getByTestId('settings-colour-preset-colour-blind')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveClass(/colour-blind/);
  await page.evaluate(() => {
    window.__reallm.toast('Saved again', 'good', 20_000);
    window.__reallm.toast('Still not enough tokens', 'error', 20_000);
  });
  await expect(page.locator('.toast-good').first()).toHaveCSS('border-top-color', 'rgb(63, 182, 255)');
  await expect(page.locator('.toast-error').first()).toHaveCSS('border-top-color', 'rgb(255, 138, 31)');
  expect((await storedSettings(page))['colourPreset']).toBe('colour-blind');
});

test('12a. the salvager has Health, and the third slot is the Gadget slot (§4.6)', async ({ page }) => {
  await start(page, URL);
  await bind(page);
  await land(page);
  await expect(page.getByTestId('hud-hp')).toHaveAttribute('aria-label', 'Health');
  await page.getByTestId('qb-utility').evaluate((slot) => {
    slot.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true }));
  });
  const picker = page.getByTestId('quick-picker');
  await expect(picker).toBeVisible();
  await expect(picker.locator('.quick-picker-title')).toHaveText('Gadget slot');
  await expect(picker).toHaveAttribute('aria-label', 'Choose the gadget slot');
});

test.describe('12b. the touch throttle', () => {
  test.use(PHONE);

  test('reads + and − (§4.6)', async ({ page }) => {
    await page.goto(gameUrl('/?scene=flight&planet=cinder4'));
    await awaitGate(page);
    await page.getByTestId('boot-start').tap();
    await expect(page.getByTestId('boot-overlay')).toBeHidden();
    await settle(page, 'flight');
    await expect(page.getByTestId('touch-throttleUp')).toHaveText('+');
    await expect(page.getByTestId('touch-throttleDown')).toHaveText('−');
  });
});

// ------------------------------------------------------------ 13: formats

test('13. no screen runs a number into its unit (§4.7)', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page, URL);
  await bind(page);
  await station(page);
  for (const tab of ['missions', 'shop', 'character']) {
    await page.getByTestId(`station-tab-${tab}`).click();
    await frames(page, 2);
    const text = await textOf(page, '[data-testid="screen"]');
    expect(text, `station ${tab}`).not.toMatch(GLUED_UNIT);
  }
  await stationSettings(page);
  expect(await textOf(page, '[data-testid="settings-panel"]'), 'settings').not.toMatch(GLUED_UNIT);
  await page.getByTestId('settings-close').click();

  await page.evaluate(() => window.__reallm.go('starmap', undefined, { force: true }));
  await settle(page, 'starmap');
  expect(await textOf(page, '[data-testid="screen"]'), 'star map').not.toMatch(GLUED_UNIT);

  await land(page);
  await page.getByTestId('surface-storm').click();
  await expect(page.locator('.hud-weather')).toContainText('▲');
  expect(await textOf(page, '[data-testid="hud"]'), 'surface HUD').not.toMatch(GLUED_UNIT);

  await page.evaluate(() => window.__reallm.go('flight', { destination: 'cinder4' }, { force: true }));
  await settle(page, 'flight');
  await expect(page.getByTestId('hud-throttle')).toHaveText('Throttle 1.0×');
  expect(await textOf(page, '[data-testid="hud"]'), 'flight HUD').not.toMatch(GLUED_UNIT);
});

// ------------------------------------------------------------- 14: legacy

test('14. Resume is styled like Settings beside it (§4.8)', async ({ page }) => {
  await start(page, URL);
  await bind(page);
  await land(page);
  await pause(page);
  const styles = await page.evaluate(() =>
    ['pause-resume', 'pause-settings'].map((id) => {
      const style = getComputedStyle(document.querySelector(`[data-testid="${id}"]`) as HTMLElement);
      return { radius: style.borderTopLeftRadius, fontSize: style.fontSize, background: style.backgroundColor };
    }),
  );
  expect(styles[0]).toEqual(styles[1]);
});

// ------------------------------------------------------- 15–17: §4.9

interface ProbeHowl {
  _src: string;
  _state: string;
  _queue: unknown[];
  _sounds: Array<{ _id: number; _sprite: string; _paused: boolean; _ended: boolean; _node: { gain: { value: number } } }>;
}

test('15. the interface bus sets the ui_* sounds, and Mono folds the mix to one channel (§4.9)', async ({ page }) => {
  await start(page, '/');
  const gains = await page.evaluate(async () => {
    const howler = (window as unknown as { Howler: { _howls: ProbeHowl[] } }).Howler;
    const audio = window.__reallm.audio() as unknown as {
      setBus(bus: string, volume: number): void;
      play(id: string, opts?: Record<string, number | boolean>): { stop(): void } | null;
    };
    audio.setBus('interface', 0.5);
    const blip = audio.play('ui_blip', { loop: true, minIntervalMs: 0 });
    const pop = audio.play('bug_pop', { loop: true, minIntervalMs: 0 });
    const gainOf = (sprite: string): number | null => {
      for (const howl of howler._howls) {
        for (const sound of howl._sounds) {
          if (sound._sprite === sprite && !sound._paused && !sound._ended) return Number(sound._node.gain.value.toFixed(4));
        }
      }
      return null;
    };
    const began = performance.now();
    // A bank decodes on its first play and replays the queued calls after.
    while (performance.now() - began < 20_000) {
      const settled = howler._howls.every((howl) => howl._state !== 'loading' && howl._queue.length === 0);
      if (settled && gainOf('ui_blip') !== null && gainOf('bug_pop') !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const out = { blip: gainOf('ui_blip'), pop: gainOf('bug_pop') };
    blip?.stop();
    pop?.stop();
    return out;
  });
  expect(gains.blip).toBeCloseTo(0.5, 3);
  expect(gains.pop).toBeCloseTo(1, 3);
  expect((await storedSettings(page))['volumeInterface']).toBe(0.5);

  await page.getByTestId('menu-settings').click();
  await page.getByTestId('settings-mono').check();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { Howler: { masterGain: { channelCount: number } } }).Howler.masterGain.channelCount))
    .toBe(1);
  await page.getByTestId('settings-mono').uncheck();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { Howler: { masterGain: { channelCount: number } } }).Howler.masterGain.channelCount))
    .toBe(2);
});

test('16. brightness scales the exposure (§4.9)', async ({ page }) => {
  await prime(page, { brightness: 0.3 });
  await start(page, '/');
  const exposure = (): Promise<number> => page.evaluate(() => (window.__reallm as unknown as { exposure(): number }).exposure());
  await expect.poll(exposure).toBeCloseTo(1.3, 3);
  await page.getByTestId('menu-settings').click();
  await page.getByTestId('settings-brightness').fill('0');
  await expect.poll(exposure).toBeCloseTo(1, 3);
  await expect(page.locator('[data-testid="settings-panel"] .settings-value')).toHaveText(/^[+−]?0 %$/);
});

test('17. Invert flight up / down turns W the other way (§4.9)', async ({ page }) => {
  // Mouse steer chases the reticle on its own (45-t); the keys are the subject here.
  await prime(page, { flightMouseSteer: false });
  await start(page, '/?debug&scene=flight&planet=cinder4');
  await settle(page, 'flight');
  // A fresh key ends the launch shot (SPEC-032 §4.2).
  await page.keyboard.press('KeyX');
  await expect.poll(async () => Number((await sceneInfo(page))['launch']), { timeout: 20_000 }).toBe(1);

  const hold = async (): Promise<number> => {
    const before = Number((await sceneInfo(page))['shipY']);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(500);
    await page.keyboard.up('KeyW');
    await frames(page, 2);
    return Number((await sceneInfo(page))['shipY']) - before;
  };
  const plain = await hold();
  expect(Math.abs(plain)).toBeGreaterThan(0.05);

  await pauseSettings(page);
  await page.getByTestId('settings-invert-flight-y').check();
  await resume(page);
  // Back to where the first press started from, so the bound is not in play.
  const inverted = await hold();
  expect(Math.abs(inverted)).toBeGreaterThan(0.05);
  expect(Math.sign(inverted)).toBe(-Math.sign(plain));
});
