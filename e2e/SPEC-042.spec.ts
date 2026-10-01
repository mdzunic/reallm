// SPEC-042 §6.2 — feedback in play, in the browser: the mission banner and
// its hold on the dialogue, the pause that freezes it, loot toasts, effect
// chips, the low-HP edge (and the low hull), the death overlay's cause, tip and
// skip guard, the stage toast, the wave line, the level glow and XP numbers,
// the shop's results and compare arrows, the boss and target frames, haptics on
// a phone, and the flight recall's detail line. The words themselves are pinned
// in node (`tests/ui/helpers.test.ts`); what this proves is the wiring.
//
// Where a criterion is a duration on the scene's clock, it is read off
// `sceneInfo.viewTime` rather than the wall clock: a software-GL host runs the
// fixed step slower than real time, and the banner, the wave line, the target
// frame and the death guard all count scene seconds.
import { expect, test, type Page } from '@playwright/test';
import { awaitGate, COLD_START, gameUrl, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const URL = '/?debug&seed=123';
const DONE_LINE = 'Dune sea logged, storm survived.';
const RECALL_DETAIL = "Hull breached — ARIA flew you home. The jump's fuel is spent; your cargo is safe.";

interface FlightHook {
  phase(): string;
  state(): { shield: number; hull: number };
  hit(amount: number): void;
  blockArrival(): void;
  clearSky(): void;
}

/** What `prepare` writes into the fresh slot-0 save before anything is entered. */
interface Prep {
  active?: string[];
  /** The stage every `active` mission stands on; 0 by default. */
  stage?: number;
  done?: string[];
  inventory?: Array<{ itemId: string; qty: number }>;
  quick?: Record<string, string | null>;
  resources?: Record<string, number>;
  primary?: string;
  xp?: number;
}

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

/** The scene clock — world time plus held time (`sceneInfo.viewTime`). */
async function viewTime(page: Page): Promise<number> {
  return Number((await sceneInfo(page))['viewTime']);
}

/** Waits, frame by frame, until the scene clock reaches `at`. */
async function untilView(page: Page, at: number, timeout = 20_000): Promise<void> {
  await page.waitForFunction((t) => Number(window.__reallm.stats().sceneInfo?.['viewTime']) >= t, at, { polling: 'raf', timeout });
}

/** A debug-strip press in the page — no pointer, so the input scheme never moves. */
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
      bridge.create(0, creation, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      if (prep.active !== undefined) save.progress.missionsActive = prep.active.map((id) => ({ id, stage: prep.stage ?? 0, counters: {} }));
      if (prep.done !== undefined) save.progress.missionsDone = prep.done;
      if (prep.inventory !== undefined) save.inventory = prep.inventory;
      if (prep.quick !== undefined) Object.assign(save.quick, prep.quick);
      if (prep.resources !== undefined) Object.assign(save.resources, prep.resources);
      if (prep.primary !== undefined) save.equipped.primary = prep.primary;
      if (prep.xp !== undefined) save.player.xp = prep.xp;
    },
    { creation: CREATION, prep },
  );
}

/** A fresh save prepared by `prep`, landed on Cinder-4 (or `planet`) with the debug strip up. */
async function land(page: Page, prep: Prep = {}, url = URL, planet: 'cinder4' | 'hive' = 'cinder4'): Promise<void> {
  await start(page, url);
  await prepare(page, prep);
  await page.evaluate((id) => window.__reallm.go('surface', { planet: id, firstLanding: false }, { force: true }), planet);
  await expect(page.getByTestId('scene-label')).toHaveText('surface', COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
}

/** Auto-fire off before boot, so nothing but the test hits an enemy. */
async function autoFireOff(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ version: 1, autoFire: 'off' })));
}

/** `c1_m1`'s three stages through the stage shortcut, until the mission is done. */
async function finishDryLand(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const done = await page.evaluate(() => window.__reallm.save().current?.progress.missionsDone.includes('c1_m1') === true);
    if (done) return;
    await press(page, 'surface-finish-stage');
    await page.waitForTimeout(250);
  }
  await expect
    .poll(() => page.evaluate(() => window.__reallm.save().current?.progress.missionsDone.includes('c1_m1') === true))
    .toBe(true);
}

// ------------------------------------------------------------- 1, 2: banner

test.describe('1. the mission banner', () => {
  // The whole line lands at once, so the observer below sees it the frame it starts.
  test.use({ reducedMotion: 'reduce' });

  test('reads what c1_m1 paid and the next offer, goes within 5 s, and the done line waits for it', async ({ page }) => {
    test.setTimeout(150_000);
    await land(page, { active: ['c1_m1'] });
    await dismiss(page);
    // In the page, every frame and every mutation: when the banner rose and
    // fell, on both clocks, and when `c1_m1_done` first reached the screen.
    await page.evaluate((doneLine) => {
      const rec: { up?: number; upView?: number; down?: number; downView?: number; done?: number; doneWhileUp?: boolean } = {};
      (window as unknown as { __spec042: typeof rec }).__spec042 = rec;
      const view = (): number => Number(window.__reallm.stats().sceneInfo?.['viewTime']);
      const check = (): void => {
        const banner = document.querySelector('[data-testid="mission-complete"]');
        const up = banner !== null && !banner.classList.contains('is-hidden');
        const now = performance.now();
        if (up && rec.up === undefined) {
          rec.up = now;
          rec.upView = view();
        }
        if (!up && rec.up !== undefined && rec.down === undefined) {
          rec.down = now;
          rec.downView = view();
        }
        const dialogue = document.querySelector('[data-testid="dialogue"]');
        const text = document.querySelector('.dialogue-text')?.textContent ?? '';
        if (rec.done === undefined && dialogue !== null && !dialogue.classList.contains('is-hidden') && text.startsWith(doneLine)) {
          rec.done = now;
          rec.doneWhileUp = up;
        }
      };
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      const frame = (): void => {
        check();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, DONE_LINE);

    // Stage by stage, with every line cleared in between, so nothing is on
    // screen at the completion: without the hold, the done line would start
    // the moment it was queued.
    for (let stage = 0; stage < 3; stage++) {
      await press(page, 'surface-finish-stage');
      await page.waitForTimeout(250);
      if (stage < 2) await dismiss(page);
    }
    const banner = page.getByTestId('mission-complete');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Mission complete');
    await expect(page.getByTestId('mission-complete-title')).toHaveText('Dry Land');
    const rewards = page.getByTestId('mission-complete-rewards');
    await expect(rewards).toContainText('+100 XP');
    await expect(rewards).toContainText('+10 tokens');
    await expect(rewards).toContainText('+20 oil');
    await expect(page.getByTestId('mission-complete-next')).toHaveText('Next: Black Gold — at the pad terminal');
    // Non-modal: it takes no pointer, and it is the top centre's last row.
    await expect(banner).toHaveCSS('pointer-events', 'none');
    // Under reduce motion it neither fades in nor out (case 2 times the fade).
    await expect(banner).toHaveCSS('animation-name', 'none');
    expect(await banner.evaluate((node) => node.parentElement?.classList.contains('hud-tc') === true && node.nextElementSibling === null)).toBe(true);

    // While it is up the queue is held: the done line, queued behind it with
    // nothing else on screen, does not start.
    await expect(page.getByTestId('dialogue')).toBeHidden();

    await expect(banner).toBeHidden({ timeout: 20_000 });
    type Record042 = { up?: number; upView?: number; down?: number; downView?: number; done?: number; doneWhileUp?: boolean };
    const record = async (): Promise<Record042> => page.evaluate(() => (window as unknown as { __spec042: Record042 }).__spec042);
    const shown = await record();
    const sceneSeconds = (shown.downView ?? NaN) - (shown.upView ?? NaN);
    expect(sceneSeconds, 'the banner’s scene seconds').toBeGreaterThan(3.5);
    expect(sceneSeconds, 'the banner’s scene seconds').toBeLessThanOrEqual(5);

    // Then the line it held: the stage line queued ahead of it, then ARIA's.
    for (let i = 0; i < 10 && (await record()).done === undefined; i++) {
      await page.waitForTimeout(400);
      await dismiss(page);
    }
    await expect.poll(async () => (await record()).done, { timeout: 20_000 }).toBeDefined();
    // The release starts it at once — in the very tick the banner goes — and
    // never while the banner is on screen.
    const after = await record();
    expect(after.doneWhileUp).toBe(false);
    expect(after.done as number).toBeGreaterThanOrEqual(after.down as number);
  });
});

test('2. a pause freezes the banner: still up 1 s after a 3 s pause', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page, { active: ['c1_m1'] });
  await finishDryLand(page);
  const banner = page.getByTestId('mission-complete');
  await expect(banner).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.waitForTimeout(3_000);
  await page.getByTestId('pause-resume').click();
  await expect(page.getByTestId('pause-menu')).toBeHidden();
  await page.waitForTimeout(1_000);
  await expect(banner).toBeVisible();

  // §4.1: then it fades out over 150 ms — an animation of its own, from
  // opaque to clear, read off the element the moment `is-fading` lands.
  const fade = await banner.evaluate(
    (node) =>
      new Promise<{ name: string; duration: unknown; to: unknown } | null>((resolve) => {
        const seen = (): boolean => {
          if (!node.classList.contains('is-fading')) return false;
          const animation = node.getAnimations()[0] as CSSAnimation | undefined;
          const keyframes = animation?.effect?.getKeyframes() ?? [];
          resolve(
            animation === undefined
              ? null
              : { name: animation.animationName, duration: animation.effect?.getTiming().duration, to: keyframes.at(-1)?.['opacity'] },
          );
          return true;
        };
        if (seen()) return;
        const observer = new MutationObserver(() => {
          if (seen()) observer.disconnect();
        });
        observer.observe(node, { attributes: true, attributeFilter: ['class'] });
      }),
  );
  expect(fade).toEqual({ name: 'mission-banner-out', duration: 150, to: '0' });
  await expect(banner).toBeHidden();
});

// ------------------------------------------- the modal chain and the beat

test.describe('1. the mission banner after a modal onComplete, and behind a beat', () => {
  // Lines land whole, so each tap advances one.
  test.use({ reducedMotion: 'reduce' });

  /** Taps the modal line on screen until `done` reads true — at most 12 taps. */
  async function tapUntil(page: Page, done: () => Promise<boolean>): Promise<void> {
    const dialogue = page.getByTestId('dialogue');
    for (let i = 0; i < 12 && !(await done()); i++) {
      await dialogue.click({ force: true, timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(150);
    }
  }
  /** ARIA has the line: the Warden's dialogue (his lines, then the player's) has none of hers. */
  const ariaSpeaks = (page: Page) => async (): Promise<boolean> =>
    (await page.getByTestId('dialogue').getAttribute('data-speaker')) === 'aria';
  const closed = (page: Page) => async (): Promise<boolean> => !(await page.getByTestId('dialogue').isVisible());

  test('1c. the Queen: the Warden, then ARIA, both modal, and only then the banner (42-d)', async ({ page }) => {
    test.setTimeout(150_000);
    await land(page, { done: ['c5_m1', 'c5_m2'], active: ['c5_m3'] }, URL, 'hive');
    await dismiss(page);
    const dialogue = page.getByTestId('dialogue');
    const banner = page.getByTestId('mission-complete');
    await expect(dialogue).toBeHidden();

    await press(page, 'surface-finish-stage');
    await expect(dialogue).toBeVisible();
    await expect(dialogue).toHaveAttribute('data-speaker', 'warden');
    await expect(dialogue).toHaveClass(/is-modal/);
    await expect(banner).toBeHidden();

    await tapUntil(page, ariaSpeaks(page));
    await expect(dialogue).toHaveAttribute('data-speaker', 'aria');
    await expect(dialogue).toHaveClass(/is-modal/);
    await expect(banner).toBeHidden();

    await tapUntil(page, closed(page));
    await expect(dialogue).toBeHidden();
    await expect(banner).toBeVisible();
    await expect(page.getByTestId('mission-complete-title')).toHaveText('Her Majesty');
    await expect(page.getByTestId('mission-complete-rewards')).toContainText('+600 XP');
  });

  test('1d. the Queen, with ARIA’s answer already heard: the chain ends at the Warden, and the banner still shows', async ({ page }) => {
    test.setTimeout(150_000);
    await land(page, { done: ['c5_m1', 'c5_m2'], active: ['c5_m3'] }, URL, 'hive');
    await dismiss(page);
    const dialogue = page.getByTestId('dialogue');
    const banner = page.getByTestId('mission-complete');
    // `c5_m3_aria` is `once`: heard here, it is dropped from the chain later.
    await page.evaluate(() => window.__reallm.playDialogue('c5_m3_aria'));
    await expect(dialogue).toHaveAttribute('data-speaker', 'aria');
    await tapUntil(page, closed(page));
    await expect(dialogue).toBeHidden();

    await press(page, 'surface-finish-stage');
    await expect(dialogue).toHaveAttribute('data-speaker', 'warden');
    await expect(banner).toBeHidden();
    await tapUntil(page, closed(page));
    await expect(dialogue).toBeHidden();
    await expect(banner).toBeVisible();
    await expect(page.getByTestId('mission-complete-title')).toHaveText('Her Majesty');
  });

  test('1e. a banner up when the boss reveal starts hides for the whole beat, its clock waits, and so does its line (42-c)', async ({ page }) => {
    test.setTimeout(150_000);
    // Films on: the reveal is one of them (SPEC-023 §4.4). `c1_m1` is tracked,
    // so the stage shortcut finishes it; `c1_m3` wants the wurm, so the arena
    // spawns it — and its reveal — once the player stands at the nest. The
    // shortcuts are refused while a beat holds (SPEC-023), so the banner goes
    // up first and the beat starts under it.
    await land(page, { active: ['c1_m1', 'c1_m3'] }, '/?films=on&debug&seed=123');
    await dismiss(page);
    // In the page, every frame and every mutation: whether the banner showed
    // before the reveal, with it, and after it, for how many scene seconds in
    // all — and where `c1_m1_done` first reached the screen.
    await page.evaluate((doneLine) => {
      const rec = {
        before: false,
        overlap: false,
        revealSeen: false,
        after: false,
        gone: false,
        shown: 0,
        done: null as null | { reveal: boolean; up: boolean; gone: boolean },
      };
      (window as unknown as { __spec042: typeof rec }).__spec042 = rec;
      const view = (): number => Number(window.__reallm.stats().sceneInfo?.['viewTime']);
      const state = (): { reveal: boolean; up: boolean } => {
        const node = document.querySelector('[data-testid="mission-complete"]');
        return {
          reveal: document.querySelector('[data-testid="boss-reveal"]') !== null,
          up: node !== null && !node.classList.contains('is-hidden') && !node.classList.contains('is-held'),
        };
      };
      const check = (): void => {
        const { reveal, up } = state();
        if (reveal) {
          rec.revealSeen = true;
          if (up) rec.overlap = true;
        } else if (up) {
          if (rec.revealSeen) rec.after = true;
          else rec.before = true;
        } else if (rec.after) {
          rec.gone = true;
        }
        const dialogue = document.querySelector('[data-testid="dialogue"]');
        const text = document.querySelector('.dialogue-text')?.textContent ?? '';
        if (rec.done === null && dialogue !== null && !dialogue.classList.contains('is-hidden') && text.startsWith(doneLine)) {
          rec.done = { reveal, up, gone: rec.gone };
        }
      };
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      let last = view();
      let wasUp = false;
      const frame = (): void => {
        const now = view();
        if (wasUp) rec.shown += now - last;
        check();
        wasUp = state().up;
        last = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, DONE_LINE);
    type Rec = {
      before: boolean;
      overlap: boolean;
      revealSeen: boolean;
      after: boolean;
      gone: boolean;
      shown: number;
      done: null | { reveal: boolean; up: boolean; gone: boolean };
    };
    const rec = (): Promise<Rec> => page.evaluate(() => (window as unknown as { __spec042: Rec }).__spec042);

    // Stage by stage, every line cleared in between (as in case 1), so nothing
    // is on screen at the completion: the done line waits on the banner alone.
    for (let stage = 0; stage < 3; stage++) {
      await press(page, 'surface-finish-stage');
      await page.waitForTimeout(250);
      if (stage < 2) await dismiss(page);
    }
    await expect.poll(async () => (await rec()).before, { timeout: 10_000 }).toBe(true);
    await press(page, 'surface-goto-boss');
    await expect.poll(async () => (await rec()).revealSeen, { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await rec()).gone, { timeout: 40_000 }).toBe(true);
    const seen = await rec();
    expect(seen.overlap, 'the banner on screen with the reveal').toBe(false);
    expect(seen.after, 'the banner back once the reveal is over').toBe(true);
    // Its 4 s count only while it shows — the reveal's own seconds do not.
    expect(seen.shown, 'the banner’s scene seconds on screen').toBeGreaterThan(3.5);
    expect(seen.shown, 'the banner’s scene seconds on screen').toBeLessThanOrEqual(5);
    // The done line waited through the reveal and the rest of the banner — a
    // reveal speaks through its own caption, and two texts at once halve both.
    await expect.poll(async () => (await rec()).done, { timeout: 30_000 }).not.toBeNull();
    expect((await rec()).done).toEqual({ reveal: false, up: false, gone: true });
  });
});

test('1f. flight: a flight mission finished in flight shows the same banner, with no next line', async ({ page }) => {
  test.setTimeout(150_000);
  // Auto-fire off and mouse steer off, as SPEC-041's case 6: the one fighter
  // stands until the trigger is held, and the ship holds still while the
  // pointer finds it.
  await page.addInitScript(() =>
    localStorage.setItem('reallm:settings', JSON.stringify({ version: 1, autoFire: 'off', flightMouseSteer: false })),
  );
  await start(page);
  await prepare(page, { resources: { oil: 400 } });
  // `c4_s2` one scav fighter short: the still fighter below is its eighth.
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) throw new Error('no save bound');
    save.progress.missionsActive = [{ id: 'c4_s2', stage: 0, counters: { '0:0': 7 } }];
  });
  await page.evaluate(() => window.__reallm.go('flight', { destination: 'ferrum' }, { force: true }));
  await expect(page.getByTestId('scene-label')).toHaveText('flight', COLD_START);
  await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
  // The guns wake after the launch, and the chase camera settles with them.
  await page.waitForFunction(() => (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight.phase() !== 'launch', null, {
    timeout: 20_000,
  });
  // One still scav fighter dead ahead, and nothing else in the sky.
  await page.evaluate(() => {
    const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
    hook.clearSky();
    hook.blockArrival();
  });
  // The pointer down the screen's middle a few pixels at a time — three frames
  // each, so the step has read it — until ARIA's 6° cone takes the fighter;
  // then on the lead pip, where a shot fired now meets it.
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const frames = (): Promise<void> =>
    page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done())))));
  for (let k = 0; k <= 30 && Number((await sceneInfo(page))['lead']) !== 1; k++) {
    await page.mouse.move(viewport.width / 2, viewport.height * (0.4 + 0.01 * k));
    await frames();
  }
  const pip = page.getByTestId('lead-pip');
  await expect(pip).toBeVisible({ timeout: 10_000 });
  const at = await pip.boundingBox();
  if (at === null) throw new Error('the lead pip has no box');
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);

  const banner = page.getByTestId('mission-complete');
  await expect(banner).toBeHidden();
  await page.keyboard.down('Space');
  try {
    await expect(banner).toBeVisible({ timeout: 30_000 });
  } finally {
    await page.keyboard.up('Space');
  }
  await expect(page.getByTestId('scene-label')).toHaveText('flight');
  await expect(banner).toContainText('Mission complete');
  await expect(page.getByTestId('mission-complete-title')).toHaveText('Salvage Rights');
  await expect(page.getByTestId('mission-complete-rewards')).toHaveText('+150 XP · +15 tokens');
  // There is no pad in the sky, so no next line.
  await expect(page.getByTestId('mission-complete-next')).toBeHidden();
  await expect(banner).toHaveCSS('pointer-events', 'none');
  expect(await banner.evaluate((node) => node.parentElement?.classList.contains('hud-tc') === true && node.nextElementSibling === null)).toBe(true);
  await expect(banner).toBeHidden({ timeout: 20_000 });
});

// --------------------------------------------------------------- 3, 4: loot

test('3. loot: a pickup says what it was, and a full pack says so once', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page);
  await press(page, 'surface-drop-item');
  await expect(page.locator('.toast', { hasText: 'Picked up Coolant Pack' })).toBeVisible({ timeout: 10_000 });

  // Twenty single wheat rations: no stack has room for a coolant pack.
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) throw new Error('no save bound');
    save.inventory = Array.from({ length: 20 }, () => ({ itemId: 'wheat_ration', qty: 1 }));
  });
  await press(page, 'surface-drop-item');
  const refused = page.locator('.toast', { hasText: 'Inventory full — Coolant Pack left on the ground' });
  await expect(refused).toBeVisible({ timeout: 10_000 });
  // The pickup retries every 0.5 s while the player stands on it: one toast,
  // never merged into a `×N`.
  for (let i = 0; i < 8; i++) {
    expect(await refused.count()).toBeLessThanOrEqual(1);
    await expect(refused.locator('.toast-count')).toHaveCount(0);
    await page.waitForTimeout(250);
  }
});

test('4. effects: a coolant pack from the gadget slot shows its 30 s, and counts down', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page, { inventory: [{ itemId: 'coolant_pack', qty: 2 }], quick: { utility: 'coolant_pack' } });
  const chip = page.getByTestId('hud-effect-hazard_immunity');
  await expect(chip).toBeHidden();
  await page.keyboard.press('KeyC');
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await expect(chip).toContainText('☂');
  await expect(chip).toContainText('30 s');
  await expect(chip).toHaveAttribute('aria-label', /^Hazard immunity, \d+ seconds$/);
  // Inside the top-left column's `Lv N` row, after the level.
  expect(await chip.evaluate((node) => node.closest('.hud-level-row')?.querySelector('.hud-level') !== null)).toBe(true);
  const seconds = async (): Promise<number> => Number(/(\d+) s/.exec((await chip.textContent()) ?? '')?.[1] ?? NaN);
  const start = await viewTime(page);
  await untilView(page, start + 2);
  expect(await seconds()).toBeLessThanOrEqual(28);
});

// ----------------------------------------------------------- 5, 6: danger

test('5. low HP: the red edge and an urgent heal slot; in flight the hull drives the edge', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page, { inventory: [{ itemId: 'medkit', qty: 2 }], quick: { heal: 'medkit' } });
  const edge = page.getByTestId('hud-lowhp');
  await expect(edge).toBeHidden();
  await expect(page.getByTestId('qb-heal')).not.toHaveClass(/is-urgent/);
  await press(page, 'surface-hp-low');
  await expect(edge).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('qb-heal')).toHaveClass(/is-urgent/);
  // Static: never animated.
  await expect(edge).toHaveCSS('animation-name', 'none');
  await expect(edge).toHaveCSS('pointer-events', 'none');

  await page.evaluate(() => window.__reallm.go('flight', { destination: 'cinder4' }, { force: true }));
  await expect(page.getByTestId('scene-label')).toHaveText('flight', COLD_START);
  await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
  await expect(page.getByTestId('hud-lowhp')).toBeHidden();
  await page.evaluate(() => {
    const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
    const { shield, hull } = hook.state();
    hook.hit(shield + hull * 0.8); // the shield, then 80 % of the hull: 20 % left
  });
  await expect(page.getByTestId('hud-lowhp')).toBeVisible({ timeout: 10_000 });
});

test('6. death: the cause and a tip, and no respawn on a press inside the first second', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page);
  await press(page, 'surface-hp-low');
  const death = page.getByTestId('death-overlay');
  for (let i = 0; i < 12 && !(await death.isVisible()); i++) {
    await page.waitForTimeout(400);
    await press(page, 'surface-hurt-from');
  }
  await expect(death).toBeVisible();
  await expect(page.getByTestId('death-cause')).toHaveText('Killed by Dust Skitter');
  await expect(page.getByTestId('death-tip')).toBeVisible();
  // A skitter's bite restarts no timed stage: no restarts line.
  await expect(page.getByTestId('death-restarts')).toHaveText('');
  // The 2.5 s auto-respawn is unchanged.
  await expect(death).toBeHidden({ timeout: 15_000 });

  // The guard, timed on the scene clock inside the page — a round trip per
  // assertion would eat the second being measured. A second death, then Space
  // at 0.5 s (ignored) and at 1.2 s (respawns, well before 2.5 s).
  const run = await page.evaluate(
    () =>
      new Promise<{ early?: number; upAfterEarly?: boolean; late?: number; gone?: number }>((resolve) => {
        const out: { early?: number; upAfterEarly?: boolean; late?: number; gone?: number } = {};
        const overlay = document.querySelector('[data-testid="death-overlay"]') as HTMLElement;
        const view = (): number => Number(window.__reallm.stats().sceneInfo?.['viewTime']);
        const click = (id: string): void => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)?.click();
        const key = (type: 'keydown' | 'keyup'): boolean => window.dispatchEvent(new KeyboardEvent(type, { code: 'Space', key: ' ' }));
        const hp = (): number => {
          const [now, max] = (document.querySelector('[data-testid="hud-hp"] .bar-text')?.textContent ?? '1/1').split('/').map(Number);
          return (now ?? 1) / Math.max(1, max ?? 1);
        };
        let at: number | null = null;
        let step = 0;
        let lastHurt = -Infinity;
        const started = performance.now();
        const frame = (): void => {
          const v = view();
          const up = overlay.classList.contains('is-visible');
          if (at === null) {
            if (up) at = v;
            else if (performance.now() - lastHurt > 350) {
              click(hp() > 0.3 ? 'surface-hp-low' : 'surface-hurt-from');
              lastHurt = performance.now();
            }
          } else if (step === 0 && v >= at + 0.5) {
            key('keydown');
            out.early = v - at;
            step = 1;
          } else if (step === 1) {
            key('keyup');
            step = 2;
          } else if (step === 2 && v >= at + 0.8) {
            out.upAfterEarly = up;
            step = 3;
          } else if (step === 3 && v >= at + 1.2) {
            key('keydown');
            out.late = v - at;
            step = 4;
          } else if (step === 4) {
            key('keyup');
            step = 5;
          } else if (step === 5 && !up) {
            out.gone = v - at;
            resolve(out);
            return;
          }
          if (performance.now() - started > 60_000 || (at !== null && v > at + 6)) {
            resolve(out);
            return;
          }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
  expect(run.early ?? NaN, 'the first press, scene seconds into the death').toBeLessThan(0.9);
  expect(run.upAfterEarly, 'still down after the press at 0.5 s').toBe(true);
  expect(run.late ?? NaN).toBeGreaterThanOrEqual(1.2);
  expect(run.gone ?? NaN, 'respawned by the press at 1.2 s, not the 2.5 s timer').toBeLessThan(2.2);
});

test('6b. a death in a timed stage names the stage it restarts, and the respawn clears the line', async ({ page }) => {
  test.setTimeout(120_000);
  // `c1_m1` on its third stage: sit out the sandstorm — a timed stage, which a
  // death restarts (SPEC-012 E4).
  await land(page, { active: ['c1_m1'], stage: 2 });
  await dismiss(page);
  const death = page.getByTestId('death-overlay');
  for (let i = 0; i < 12 && !(await death.isVisible()); i++) {
    await press(page, 'surface-hurt');
    await page.waitForTimeout(400);
  }
  await expect(death).toBeVisible();
  await expect(page.getByTestId('death-cause')).toHaveText(/^Killed by /);
  await expect(page.getByTestId('death-restarts')).toHaveText('Restarts: Survive');
  // The 2.5 s auto-respawn takes the overlay, and the line with it.
  await expect(death).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId('death-restarts')).toHaveText('');
});

// ------------------------------------------------------ 7, 8: progress beats

test('7. a new stage of the tracked mission toasts its first objective', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page, { active: ['c1_m1'] });
  await press(page, 'surface-finish-stage');
  await expect(page.locator('.toast', { hasText: 'Stage 2/3 — Scan Dune Sea' })).toBeVisible({ timeout: 10_000 });
});

test('8. a wave says so for 3 s under the weather banner', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page);
  const wave = page.getByTestId('hud-wave');
  await expect(wave).toBeHidden();
  await press(page, 'surface-start-wave');
  const up = await page.waitForFunction(
    () => {
      const node = document.querySelector('[data-testid="hud-wave"]');
      return node !== null && !node.classList.contains('is-hidden') ? Number(window.__reallm.stats().sceneInfo?.['viewTime']) : false;
    },
    null,
    { polling: 'raf', timeout: 10_000 },
  );
  await expect(wave).toHaveText('▲ Wave incoming');
  // In the top centre, under the weather banner and the shelter chip.
  expect(await wave.evaluate((node) => node.previousElementSibling?.getAttribute('data-testid'))).toBe('sheltered');
  const down = await page.waitForFunction(
    () => {
      const node = document.querySelector('[data-testid="hud-wave"]');
      return node?.classList.contains('is-hidden') === true ? Number(window.__reallm.stats().sceneInfo?.['viewTime']) : false;
    },
    null,
    { polling: 'raf', timeout: 15_000 },
  );
  const seconds = Number(await down.jsonValue()) - Number(await up.jsonValue());
  expect(seconds).toBeGreaterThan(2.5);
  expect(seconds).toBeLessThanOrEqual(3.5);
});

// ---------------------------------------------------------------- 9: levels

test('9. levels: the toast stays 4 s, the label glows, the XP bar and the panel give the numbers', async ({ page }) => {
  test.setTimeout(150_000);
  // Auto-fire off: the smite below is the one kill, and its drop lies 7 m
  // out, past the magnet — no pickup toast pushes the level's out of the rack.
  await autoFireOff(page);
  // One XP short of level 2 (150): the next kill crosses it through Progression.
  await land(page, { xp: 149 });
  const level = page.locator('[data-testid="hud"] .hud-level');
  await expect(level).toHaveText('Lv 1');
  await expect(level).not.toHaveClass(/is-levelled/);
  const xpRow = page.locator('[data-testid="hud"] .bar-row:has(.bar-xp)');
  await expect(xpRow).toHaveAttribute('title', /^XP /);
  await expect(xpRow).toHaveAttribute('aria-label', 'XP 149 / 150');
  await expect(xpRow.locator('.bar')).toHaveCSS('height', '6px');

  // When the level toast rose and fell, and the glow, in the page — read at
  // the DOM change itself, so a loaded host's long frames (both are wall-clock
  // timers) add no sampling error to the durations.
  await page.evaluate(() => {
    const rec: { toastUp?: number; toastDown?: number; glowUp?: number; glowDown?: number } = {};
    (window as unknown as { __spec042: typeof rec }).__spec042 = rec;
    const check = (): void => {
      const now = performance.now();
      const toast = [...document.querySelectorAll('.toast')].some((node) => node.textContent?.startsWith('Level 2 — ') === true);
      if (toast && rec.toastUp === undefined) rec.toastUp = now;
      if (!toast && rec.toastUp !== undefined && rec.toastDown === undefined) rec.toastDown = now;
      const glow = document.querySelector('[data-testid="hud"] .hud-level')?.classList.contains('is-levelled') === true;
      if (glow && rec.glowUp === undefined) rec.glowUp = now;
      if (!glow && rec.glowUp !== undefined && rec.glowDown === undefined) rec.glowDown = now;
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  await press(page, 'surface-spawn-pack');
  await page.waitForTimeout(300);
  await press(page, 'surface-smite');
  await expect(page.locator('.toast', { hasText: /^Level 2 — / })).toBeVisible({ timeout: 10_000 });
  await expect(level).toHaveText('Lv 2');
  // The glow is read off the page's own record: a loaded host's round trip
  // can outlast its 2 s.
  type Rec = { toastUp?: number; toastDown?: number; glowUp?: number; glowDown?: number };
  const rec = (): Promise<Rec> => page.evaluate(() => (window as unknown as { __spec042: Rec }).__spec042);
  await expect.poll(async () => (await rec()).toastDown, { timeout: 10_000 }).toBeDefined();
  await expect.poll(async () => (await rec()).glowDown, { timeout: 10_000 }).toBeDefined();
  const seen = await rec();
  expect(seen.glowUp, 'is-levelled on the level label').toBeDefined();
  const toastMs = (seen.toastDown as number) - (seen.toastUp as number);
  expect(toastMs, 'the level-up toast, ms').toBeGreaterThan(3_600);
  expect(toastMs, 'the level-up toast, ms').toBeLessThan(4_800);
  const glowMs = (seen.glowDown as number) - (seen.glowUp as number);
  expect(glowMs, 'the level glow, ms').toBeGreaterThan(1_600);
  expect(glowMs, 'the level glow, ms').toBeLessThan(2_800);

  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await expect(page.getByTestId('scene-label')).toHaveText('station', COLD_START);
  await page.getByTestId('station-tab-character').click();
  await expect(page.getByTestId('character-xp')).toHaveText(/^XP \d+ \/ 200 — \d+ to level 3$/);
});

// ---------------------------------------------------------------- 10: shop

test('10. shop: a craft says what it made, and the compare line points up', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await prepare(page, { resources: { wheat: 60, water: 60 }, primary: 'weapon_laser' });
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await expect(page.getByTestId('scene-label')).toHaveText('station', COLD_START);
  await page.getByTestId('station-tab-shop').click();
  await page.getByTestId('shop-tab-craft').click();
  await page.getByTestId('shop-craft-medkit-plus').click();
  await expect(page.getByTestId('shop-craft-medkit-qty')).toHaveText('2');
  await page.getByTestId('shop-craft-medkit-buy').click();
  await page.getByTestId('confirm-yes').click();
  await expect(page.locator('.toast', { hasText: 'Crafted Medkit ×2' })).toBeVisible();
  await expect(page.locator('.toast', { hasText: /^Purchased$/ })).toHaveCount(0);
  await expect(page.locator('.shop-price').first()).toHaveCSS('color', 'rgb(230, 237, 243)');

  await page.getByTestId('shop-tab-gear').click();
  await page.getByTestId('shop-gear-weapon_plasma-details').click();
  const card = page.getByTestId('gear-card');
  await expect(card).toBeVisible();
  const up = card.locator('.compare-up');
  expect(await up.count()).toBeGreaterThanOrEqual(1);
  await expect(up.first()).toHaveText(/^↑ /);
  // The Laser Carbine fires faster than the Plasma Lance: that part points down.
  await expect(card.locator('.compare-down', { hasText: 'fire rate 4 → 3' })).toHaveText('↓ fire rate 4 → 3');
});

// ------------------------------------------------------- 11, 12: the frames

test('11. the boss frame: the name over its own bar, and Phase 2 at the turn', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page);
  await press(page, 'surface-spawn-boss');
  const frame = page.getByTestId('hud-boss');
  await expect(frame).toBeVisible({ timeout: 15_000 });
  await expect(frame).toHaveClass(/boss-frame/);
  await expect(page.getByTestId('hud-boss-name')).toHaveText('Dune Wurm');
  const box = await frame.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(280);
  await expect(frame).toHaveAttribute('aria-label', /^Dune Wurm, \d+ of \d+ HP$/);
  await expect(frame.locator('.boss-frame-tick')).toHaveCount(1);
  await expect(frame.locator('.boss-frame-fill')).toHaveCSS('background-image', /linear-gradient/);
  await expect(page.getByTestId('hud-boss-phase')).toBeHidden();

  await press(page, 'surface-goto-boss');
  const phase = page.getByTestId('hud-boss-phase');
  for (let i = 0; i < 3; i++) {
    await press(page, 'surface-wound-boss');
    await page.waitForTimeout(300);
  }
  await expect(phase).toContainText('Phase 2', { timeout: 15_000 });
});

test('12. the target frame: an elite hit shows it, tagged, and it hides 3 s later', async ({ page }) => {
  test.setTimeout(120_000);
  await autoFireOff(page);
  await land(page);
  const target = page.getByTestId('hud-target');
  await expect(target).toBeHidden();
  await press(page, 'surface-hit-elite');
  const up = await page.waitForFunction(
    () => {
      const node = document.querySelector('[data-testid="hud-target"]');
      return node !== null && !node.classList.contains('is-hidden') ? Number(window.__reallm.stats().sceneInfo?.['viewTime']) : false;
    },
    null,
    { polling: 'raf', timeout: 10_000 },
  );
  await expect(page.getByTestId('hud-target-elite')).toHaveText('Elite');
  await expect(page.getByTestId('hud-target-name')).toHaveText('Alpha Dust Skitter');
  await expect(page.getByTestId('hud-target-affixes')).not.toHaveText('');
  const down = await page.waitForFunction(
    () => {
      const node = document.querySelector('[data-testid="hud-target"]');
      return node?.classList.contains('is-hidden') === true ? Number(window.__reallm.stats().sceneInfo?.['viewTime']) : false;
    },
    null,
    { polling: 'raf', timeout: 15_000 },
  );
  expect(Number(await down.jsonValue()) - Number(await up.jsonValue())).toBeLessThanOrEqual(3.5);
});

// ------------------------------------------------------------- 13: haptics

/** Records every `navigator.vibrate` call in `window.__vibrations`, before `main.ts` looks. */
function recordVibrations(): void {
  const calls: unknown[] = [];
  (window as unknown as { __vibrations: unknown[] }).__vibrations = calls;
  Object.defineProperty(Navigator.prototype, 'vibrate', {
    configurable: true,
    value: (pattern: unknown) => {
      calls.push(pattern);
      return true;
    },
  });
}

const vibrations = (page: Page): Promise<unknown[]> =>
  page.evaluate(() => [...(window as unknown as { __vibrations: unknown[] }).__vibrations]);
const clearVibrations = (page: Page): Promise<void> =>
  page.evaluate(() => void ((window as unknown as { __vibrations: unknown[] }).__vibrations.length = 0));

test.describe('13. haptics on a phone', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test('a hit pulses 15 ms; with Vibration unchecked nothing does', async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(recordVibrations);
    await page.goto(gameUrl(URL));
    await awaitGate(page);
    await page.getByTestId('boot-start').tap();
    await expect(page.getByTestId('boot-overlay')).toBeHidden();
    await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
    await prepare(page, {});
    await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
    await expect(page.getByTestId('scene-label')).toHaveText('surface', COLD_START);
    await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
    expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('touch');

    await clearVibrations(page);
    await page.getByTestId('surface-hurt-from').dispatchEvent('click');
    await expect.poll(() => vibrations(page)).toEqual([15]);

    // Settings → Vibration off, all by touch, so the scheme stays touch.
    await page.getByTestId('touch-pause').tap();
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('pause-settings').tap();
    const box = page.getByTestId('settings-haptics');
    await expect(box).toBeVisible();
    await expect(box).toBeChecked();
    await box.tap();
    await expect(box).not.toBeChecked();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('reallm:settings') ?? '{}').haptics)).toBe(false);
    await page.getByTestId('settings-close').tap();
    await page.getByTestId('pause-resume').tap();
    await expect(page.getByTestId('pause-menu')).toBeHidden();
    expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('touch');

    await clearVibrations(page);
    await page.waitForTimeout(500);
    await page.getByTestId('surface-hurt-from').dispatchEvent('click');
    await page.waitForTimeout(800);
    expect(await vibrations(page)).toEqual([]);
  });
});

test('13. haptics: a desktop context records nothing, and shows no Vibration row', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(recordVibrations);
  await land(page);
  expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('keyboard');
  await clearVibrations(page);
  await press(page, 'surface-hurt-from');
  await page.waitForTimeout(800);
  expect(await vibrations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.getByTestId('pause-settings').click();
  await expect(page.getByTestId('settings-panel')).toBeVisible();
  await expect(page.getByTestId('settings-haptics')).toHaveCount(0);
});

// ------------------------------------------------------- 14: recall detail

test('14. a flight death recalls to the station with the banner and the detail line', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await prepare(page, { resources: { oil: 200 } });
  await page.evaluate(() => window.__reallm.go('flight', { destination: 'cinder4' }, { force: true }));
  await expect(page.getByTestId('scene-label')).toHaveText('flight', COLD_START);
  await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
  await page.evaluate(() => (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight.hit(10_000));
  await expect(page.getByTestId('scene-label')).toHaveText('station', { timeout: 15_000 });
  await expect(page.getByTestId('recall-banner')).toHaveText('Emergency recall');
  await expect(page.getByTestId('recall-detail')).toHaveText(RECALL_DETAIL);
});
