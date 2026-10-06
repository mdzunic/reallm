// SPEC-054 §6.2 — the underground in a real browser: the surface unchanged,
// the seal, the descent behind its held fade, the light, the loose cache, death
// and recall through the surface, the refusals, a stage that starts below
// (E83), a cave position at the pad's coordinates reaching nothing, loot left
// behind, the medium budget, and Eden's machine room — its racks, trays,
// cradles in the save's colours and the hum on the weather-loop channel. The
// rules are pinned in node — tests/systems/underground,
// light, interactables, enemyAi, combat, spawn, economy, missions,
// exploration, tests/ui/helpers, map and tests/views/flashlight,
// undergroundView.
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { COLD_START, frames, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** The e2e seed's pins (`e2e/` may not import `src/`; tests/systems/underground.test.ts derives them). */
const LAYOUT_HASH = 2726625427;
const CAVE_HASH = { cinder4: 2655388326, eden: 2449418380 } as const;
const SEALED = 'Sealed — finish "Dry Land" first';
/** The game runs at a fraction of the wall clock on a GPU-less container. */
const SLOW = { timeout: 90_000 } as const;

async function info(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

/** A debug-strip button, clicked from script so no overlay can take the pointer. */
async function tap(page: Page, id: string): Promise<void> {
  await page.evaluate((testid) => (document.querySelector(`[data-testid="${testid}"]`) as HTMLElement).click(), id);
}

/** One key press held across a few rendered frames, so a fixed step reads its edge. */
async function press(page: Page, code: string): Promise<void> {
  await page.keyboard.down(code);
  await frames(page, 4);
  await page.keyboard.up(code);
  await frames(page, 2);
}

async function untilInfo(page: Page, key: string, value: number | string, options = SLOW): Promise<void> {
  await page.waitForFunction(
    ({ name, want }) => window.__reallm.stats().sceneInfo?.[name] === want,
    { name: key, want: value },
    { polling: 'raf', ...options },
  );
}

/** Click through any open dialogue, as the other surface suites do. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.locator('[data-testid="dialogue"]');
  const advance = page.locator('[data-testid="dialogue-advance"]');
  for (let i = 0; i < 25; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(120);
  }
}

interface Landing {
  done?: readonly string[];
  active?: { id: string; stage: number; counters: Record<string, number> };
  /** The creation's two swatches, for a test that reads them back off the cradles (§4.12). */
  appearance?: { primary: string; secondary: string };
}

/** A slot-0 save on seed 123, then a landing through the scene machine; the page must be past the gate. */
async function land(page: Page, planet: string, landing: Landing = { done: ['c1_m1'] }): Promise<void> {
  const creation = { ...CREATION, appearance: { ...CREATION.appearance, ...landing.appearance } };
  await page.evaluate(
    ({ creation, done, active }) => {
      const bridge = window.__reallm.save();
      bridge.create(0, creation, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      save.progress.missionsDone.push(...done);
      if (active !== null) save.progress.missionsActive.push(active);
    },
    { creation, done: [...(landing.done ?? [])], active: landing.active ?? null },
  );
  await page.evaluate((id) => window.__reallm.go('surface', { planet: id }, { force: true }), planet);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', COLD_START);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
  await dismiss(page);
}

async function descend(page: Page): Promise<void> {
  await tap(page, 'surface-descend');
  await untilInfo(page, 'level', 'underground');
  await untilInfo(page, 'held', 0);
}

/**
 * Every toast the rack shows, recorded the moment it lands with its classes,
 * its text and whether it is visible. A toast lives 2.5 s, and on this
 * GPU-less container a few slow frames can outlast it before a poll looks, so
 * the suite asks what was shown rather than what is still up.
 */
async function recordToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rack = document.querySelector('[data-testid="toasts"]');
    if (rack === null) throw new Error('no toast rack');
    const shown: string[] = [];
    Object.assign(window, { __toastsShown: shown });
    new MutationObserver(() => {
      for (const node of Array.from(rack.children)) if (node.checkVisibility()) shown.push(`${node.className}|${node.textContent ?? ''}`);
    }).observe(rack, { childList: true });
  });
}

/** Waits until the rack has shown a `kind` toast whose text holds `text`. */
async function toastShown(page: Page, kind: string, text: string): Promise<void> {
  await page.waitForFunction(
    ({ cls, want }) =>
      ((window as unknown as { __toastsShown?: string[] }).__toastsShown ?? []).some((entry) => {
        const [classes = '', shownText = ''] = entry.split('|');
        return classes.split(' ').includes(cls) && shownText.includes(want);
      }),
    { cls: `toast-${kind}`, want: text },
    SLOW,
  );
}

function eventLines(messages: ConsoleMessage[], name: string): string[] {
  return messages.filter((m) => m.type() === 'debug' && m.text().startsWith(`[events] ${name}`)).map((m) => m.text());
}

test.describe('SPEC-054 the underground', () => {
  test.setTimeout(240_000);

  test('1, 2: the surface is unchanged, and the descent is sealed until Dry Land is done', async ({ page }) => {
    await start(page, '/?debug');
    await land(page, 'cinder4', {});
    const surface = await info(page);
    expect(surface['layoutHash']).toBe(LAYOUT_HASH);
    expect(surface['level']).toBe('surface');
    await tap(page, 'surface-goto-descent');
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText(SEALED, SLOW);
    await press(page, 'KeyE');
    await frames(page, 20);
    expect((await info(page))['level']).toBe('surface');
  });

  test('3: going down holds the fade, then the cave, the spot and the light chip', async ({ page }) => {
    await start(page, '/?debug&quality=medium');
    await land(page, 'cinder4');
    await tap(page, 'surface-goto-descent');
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText('Descend', SLOW);
    await page.keyboard.down('KeyE');
    await untilInfo(page, 'held', 1);
    await page.keyboard.up('KeyE');
    await untilInfo(page, 'level', 'underground');
    await untilInfo(page, 'held', 0);
    const below = await info(page);
    expect(below['caveHash']).toBe(CAVE_HASH.cinder4);
    expect(below['flashlight']).toBe('spot');
    expect(below['light']).toBe(1);
    await expect(page.locator('[data-testid="hud-light"]')).toHaveText('◐ Light on · L');
  });

  // AC-11, AC-12, AC-13: every animation frame of the swap, recorded in the
  // page — the fade's opacity, the level and the hold. On Eden, so no pack
  // interrupts the held key. The recorded swap is the ascent after a first
  // descent: that descent builds the flashlight, and on this GPU-less
  // container the first frame drawn with its programs holds the main thread
  // for seconds — long enough to swallow a 300 ms fade without one frame.
  test('3: the swap fades out, changes the level under black, fades in, holds the step and lets go of a held key; reduced motion swaps at once', async ({ page }) => {
    await start(page, '/?debug');
    await land(page, 'eden');
    await descend(page);
    await frames(page, 10);
    const record = (): Promise<void> =>
      page.evaluate(() => {
        const log: Array<[string, number, number]> = [];
        Object.assign(window, { __swapLog: log });
        const fade = document.querySelector('[data-testid="transition-fade"]') as HTMLElement;
        const step = (): void => {
          const s = window.__reallm.stats().sceneInfo ?? {};
          log.push([String(s['level']), Number(s['held']), Number(getComputedStyle(fade).opacity)]);
          if (log.length < 2_000) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    const recorded = (): Promise<Array<[string, number, number]>> =>
      page.evaluate(() => (window as unknown as { __swapLog: Array<[string, number, number]> }).__swapLog.splice(0));
    const moveX = (): Promise<number> => page.evaluate(() => window.__reallm.input().move.x);

    await page.keyboard.down('KeyD');
    await page.waitForFunction(() => window.__reallm.input().move.x === 1, undefined, SLOW);
    await record();
    await tap(page, 'surface-ascend');
    await untilInfo(page, 'level', 'surface');
    await untilInfo(page, 'held', 0);
    // AC-13: the key is still down, but the swap released it.
    expect(await moveX()).toBe(0);
    await page.keyboard.up('KeyD');
    await frames(page, 4);
    const log = await recorded();

    const start0 = log.findIndex(([, held]) => held === 1);
    const flip = log.findIndex(([level]) => level === 'surface');
    const end = log.findIndex(([level, held]) => level === 'surface' && held === 0);
    expect(start0).toBeGreaterThanOrEqual(0);
    expect(flip).toBeGreaterThan(start0);
    expect(end).toBeGreaterThan(flip);
    // AC-12: held from the first frame of the swap to the last.
    expect(log.slice(start0, end).every(([, held]) => held === 1)).toBe(true);
    // AC-11: the fade-out climbs through partial opacity to black, the level
    // changes only under black, and the fade-in falls through partial opacity.
    const partial = (o: number): boolean => o > 0.05 && o < 0.95;
    expect(log.slice(start0, flip).some(([, , o]) => partial(o))).toBe(true);
    expect(log[flip]?.[2]).toBeGreaterThanOrEqual(0.99);
    expect(log.slice(flip, end).some(([, , o]) => partial(o))).toBe(true);
    expect(log[end]?.[2]).toBeLessThanOrEqual(0.01);

    // AC-11: with reduced motion the swap is instant — no frame shows the fade.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await record();
    await tap(page, 'surface-descend');
    await untilInfo(page, 'level', 'underground');
    await untilInfo(page, 'held', 0);
    await frames(page, 4);
    expect((await recorded()).every(([, , o]) => o <= 0.01)).toBe(true);
  });

  // Eden's machine room holds no packs, so nothing can hurt the salvager while
  // the tip queue and the light count are read.
  test('3, 4: the dark tip shows; L and the swaps change the light, never the light count', async ({ page }) => {
    await start(page, '/?debug&quality=medium');
    await land(page, 'eden');
    await descend(page);
    expect((await info(page))['caveHash']).toBe(CAVE_HASH.eden);
    await expect(page.locator('[data-testid="aria-hint"]')).toContainText('L switches your light', { timeout: 150_000 });
    const lights = (await info(page))['lights'];
    await press(page, 'KeyL');
    await untilInfo(page, 'light', 0);
    await expect(page.locator('[data-testid="hud-light"]')).toHaveText('○ Light off · L');
    expect((await info(page))['lights']).toBe(lights);
    await press(page, 'KeyL');
    await untilInfo(page, 'light', 1);
    await tap(page, 'surface-ascend');
    await untilInfo(page, 'level', 'surface');
    await untilInfo(page, 'held', 0);
    expect((await info(page))['lights']).toBe(lights);
    await expect(page.locator('[data-testid="hud-light"]')).toBeHidden();
    await descend(page);
    expect((await info(page))['lights']).toBe(lights);
  });

  test('5: the loose cache opens once, and the claim survives a reload', async ({ page }) => {
    const messages: ConsoleMessage[] = [];
    page.on('console', (message) => void messages.push(message));
    await start(page, '/?debug');
    await land(page, 'cinder4');
    await recordToasts(page);
    await descend(page);
    await tap(page, 'surface-goto-cache');
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText('Open cache', SLOW);
    await press(page, 'KeyE');
    await untilInfo(page, 'claimed', 1);
    expect(eventLines(messages, 'cache:opened').some((line) => line.includes('cinder4_loose_a'))).toBe(true);
    await toastShown(page, 'good', 'Cache opened · ');
    expect(await page.evaluate(() => window.__reallm.save().current?.progress.claimed ?? [])).toContain('cinder4_loose_a');
    await press(page, 'KeyE');
    await frames(page, 10);
    expect(eventLines(messages, 'cache:opened')).toHaveLength(1);
    expect((await info(page))['claimed']).toBe(1);

    await page.evaluate(() => window.__reallm.save().flush());
    await start(page, '/?debug');
    const loaded = await page.evaluate(() => window.__reallm.save().load(0));
    expect(loaded.ok).toBe(true);
    expect(loaded.data?.progress.claimed ?? []).toContain('cinder4_loose_a');
  });

  // On Eden, where no pack can take the salvager's life before the test does.
  test('6: death below respawns at the pad on the surface; Recall below comes up and counts', async ({ page }) => {
    await start(page, '/?debug');
    await land(page, 'eden');
    await descend(page);
    const recalls = (await info(page))['recalls'];
    for (let i = 0; i < 12 && (await info(page))['level'] === 'underground'; i++) {
      await tap(page, 'surface-hurt');
      await frames(page, 30);
    }
    await untilInfo(page, 'level', 'surface');
    await page.waitForFunction(() => Math.hypot(Number(window.__reallm.stats().sceneInfo?.['px']), Number(window.__reallm.stats().sceneInfo?.['pz'])) < 16, undefined, SLOW);
    expect((await info(page))['recalls']).toBe(recalls);

    await page.waitForTimeout(2_500); // the respawn's i-frames, so the next descent is not refused for a dead player
    await descend(page);
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="pause-recall"]').click();
    await page.locator('[data-testid="confirm-yes"]').click();
    await untilInfo(page, 'level', 'surface');
    expect((await info(page))['recalls']).toBe(Number(recalls) + 1);
  });

  // E83. Waterless opens on a hunt, so the descent is allowed; the dev
  // shortcut finishes the hunt below, and its survive stage — 90 s under a
  // forced heatwave, with its storm wave — starts down there.
  test('E83: a stage that starts below holds its clock, its storm and its wave until the ascent, and says the way up', async ({ page }) => {
    await start(page, '/?debug');
    await land(page, 'cinder4', { done: ['c1_m1'], active: { id: 'c1_s2', stage: 0, counters: {} } });
    await descend(page);
    await tap(page, 'surface-finish-stage');
    const tracker = page.locator('[data-testid="objective-tracker"]');
    await expect(tracker).toContainText('Stage 2/2', SLOW);
    await expect(tracker).toContainText(/Return to the surface — \d+ m/, SLOW);
    // Five seconds on the game's clock below — a calm Cinder-4 rolls 90 s at least.
    const from = Number((await info(page))['viewTime']);
    await page.waitForFunction((t) => Number(window.__reallm.stats().sceneInfo?.['viewTime']) >= t + 5, from, SLOW);
    expect(await info(page)).toMatchObject({ level: 'underground', stormWave: '-', weatherPhase: 'calm' });

    await tap(page, 'surface-ascend');
    await untilInfo(page, 'level', 'surface');
    await untilInfo(page, 'held', 0);
    await untilInfo(page, 'stormWave', 'cinder4_storm');
    await untilInfo(page, 'weatherPhase', 'active');
    // The 90 s start at the ascent: had they run below, 5 of them would be gone.
    await expect(tracker).toContainText(/Waterless — Survive \((90|89|88) s\)/, SLOW);
  });

  test('7: a running clock refuses the descent with its reason', async ({ page }) => {
    await start(page, '/?debug');
    await land(page, 'cinder4', { done: ['c1_m1'], active: { id: 'c1_s2', stage: 1, counters: {} } });
    await tap(page, 'surface-goto-descent');
    await expect(page.locator('[data-testid="hud-interact"]')).toContainText('Not now — the clock is running on "', SLOW);
  });

  test('8, 9: the cave at the pad’s coordinates reaches nothing, and loot left at a descent is said', async ({ page }) => {
    const messages: ConsoleMessage[] = [];
    page.on('console', (message) => void messages.push(message));
    await start(page, '/?debug');
    await land(page, 'cinder4');
    await recordToasts(page);
    // 9: an item at the feet, and a descent before the step that would collect it.
    await page.evaluate(() => {
      (document.querySelector('[data-testid="surface-drop-item"]') as HTMLElement).click();
      (document.querySelector('[data-testid="surface-descend"]') as HTMLElement).click();
    });
    await untilInfo(page, 'level', 'underground');
    await untilInfo(page, 'held', 0);
    await toastShown(page, 'warn', 'Loot left behind');
    const before = eventLines(messages, 'poi:reached').length;
    await tap(page, 'surface-goto-origin');
    await frames(page, 30);
    await press(page, 'KeyE');
    await frames(page, 10);
    expect(eventLines(messages, 'poi:reached').slice(before).some((line) => line.includes('landing_pad'))).toBe(false);
    await expect(page.locator('[data-testid="pad-terminal"]')).toBeHidden();
  });

  for (const planet of ['cinder4', 'eden'] as const) {
    test(`10, 11: ${planet} below on medium stays in budget${planet === 'eden' ? ', with no enemies and six cradles' : ''}`, async ({ page }) => {
      await start(page, `/?scene=surface&planet=${planet}&debug&quality=medium`);
      await dismiss(page);
      await descend(page);
      await frames(page, 30);
      const stats = await page.evaluate(() => window.__reallm.stats());
      expect(stats.drawCalls).toBeLessThanOrEqual(96);
      expect(stats.triangles).toBeLessThanOrEqual(130_000);
      const below = await info(page);
      if (planet === 'eden') {
        expect(below['caveEnemies']).toBe(0);
        expect(below['cradles']).toBe(6);
      } else {
        // §4.12: a cave is rock, with no trays or cradles, and below the
        // weather-loop channel is silent everywhere but Eden.
        expect(below).toMatchObject({ caveWallModel: 'rock', caveTrays: 0, cradles: 0, cradleSuit: '-', weatherLoop: '-' });
      }
    });
  }

  // §4.12: swatches far from the view's defaults, so a suit that ignored the
  // save could not pass.
  test('11: Eden’s machine room — racks and trays, six cradles in the save’s colours, and film_hum only below', async ({ page }) => {
    const swatches = { primary: '#3fa34d', secondary: '#d4af37' };
    await start(page, '/?debug');
    await land(page, 'eden', { done: ['c1_m1'], appearance: swatches });
    // The channel is a real voice only once the gate's gesture has unlocked audio.
    await page.waitForFunction(() => window.__reallm.audio().unlocked === true, undefined, SLOW);
    expect(await info(page)).toMatchObject({ weatherLoop: '-', weatherLoopVolume: 0, weatherLoopPlaying: 0 });
    await descend(page);
    await untilInfo(page, 'weatherLoop', 'film_hum');
    await untilInfo(page, 'weatherLoopVolume', 0.5);
    await untilInfo(page, 'weatherLoopPlaying', 1);

    await tap(page, 'surface-goto-vault');
    await frames(page, 30);
    const vault = await info(page);
    expect(Number(vault['vaultRoom'])).toBeGreaterThan(0);
    expect(vault['caveRoom']).toBe(vault['vaultRoom']);
    expect(vault).toMatchObject({
      caveWallModel: 'cave_rack',
      cradles: 6,
      cradleSuit: `${swatches.primary}/${swatches.secondary}`,
      caveEnemies: 0,
      weatherLoop: 'film_hum',
      weatherLoopVolume: 0.5,
      weatherLoopPlaying: 1,
    });
    expect(Number(vault['caveTrays'])).toBeGreaterThan(0);
    // The row as drawn, and the tray down the corridor into it, kept beside
    // the run's results for whoever reads them.
    const shoot = async (name: string): Promise<void> => {
      const path = test.info().outputPath(`${name}.png`);
      await page.screenshot({ path });
      await test.info().attach(name, { path, contentType: 'image/png' });
    };
    await shoot('eden-vault');
    await tap(page, 'surface-goto-corridor');
    await frames(page, 30);
    expect((await info(page))['caveRoom']).toBe(-1);
    await shoot('eden-corridor');

    await tap(page, 'surface-ascend');
    await untilInfo(page, 'level', 'surface');
    await untilInfo(page, 'held', 0);
    expect(await info(page)).toMatchObject({ weatherLoop: '-', weatherLoopVolume: 0, weatherLoopPlaying: 0, caveRoom: -1 });
  });
});
