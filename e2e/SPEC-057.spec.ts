// SPEC-057 §6.2 — the remains in a real browser. Placement, the bookkeeping,
// the recovery's arithmetic and the words are proved in node
// (`tests/systems/remains.test.ts`, `tests/ui/helpers.test.ts`); what only a
// browser shows is the path a player takes: a death that leaves a pack on the
// ground, the walk back that takes it home, a second death that loses it, a
// full hold, the body after the reveal, casual's kinder deaths, a reload, the
// remains staying put on another planet and below, a death below and in a boss
// stage, the tip, and a Recall that leaves them alone.
//
// Each case lands on Cinder-4 (seed 123: the pad at the origin, the spawn 12 m
// east of it) through `?debug`, with a bound save holding 200 oil and nothing
// else. A death at the spawn would be recovered by the respawn that stands on
// it, so the deaths that must leave remains happen at `surface-goto-pad` — 5 m
// out from the pad toward the spawn, 7 m from where the salvager comes back.
import { expect, test, type Page } from '@playwright/test';
import { start, type SaveSnapshot } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

type Remains = NonNullable<SaveSnapshot['progress']['remains']>;

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

const current = (page: Page): Promise<SaveSnapshot | null> => page.evaluate(() => window.__reallm.save().current);

const remainsOf = async (page: Page): Promise<Remains | null> => (await current(page))?.progress.remains ?? null;

/** What a case changes in the bound save before it lands, and the device's tips already seen. */
interface Setup {
  difficulty?: string;
  flags?: string[];
  missionsDone?: string[];
  remains?: Remains;
  tipsSeen?: string[];
}

/**
 * A save in slot 0 with 200 oil and nothing else, then a landing on Cinder-4.
 * Auto-fire is off, so no kill drops anything into the hold.
 */
async function land(page: Page, setup: Setup = {}): Promise<void> {
  await page.addInitScript(
    (tipsSeen) => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off', ...(tipsSeen === null ? {} : { tipsSeen }) })),
    setup.tipsSeen ?? null,
  );
  await start(page, '/?debug&seed=123');
  await page.evaluate(
    ({ creation, setup }) => {
      const save = window.__reallm.save().create(0, creation, 123);
      save.resources = { oil: 200, wheat: 0, water: 0, lithium: 0 };
      save.progress.flags.push(...(setup.flags ?? []));
      save.progress.missionsDone.push(...(setup.missionsDone ?? []));
      if (setup.remains !== undefined) save.progress.remains = setup.remains;
    },
    { creation: { ...CREATION, difficulty: setup.difficulty ?? 'normal' }, setup },
  );
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await recordToasts(page);
}

/**
 * Every toast the rack shows from here on, as SPEC-054's suite records them: a
 * toast lives 2.5 s, which a starved host can spend between two assertions.
 */
async function recordToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rack = document.querySelector('[data-testid="toasts"]');
    if (rack === null) throw new Error('no toast rack');
    const shown: string[] = [];
    Object.assign(window, { __remainsToasts: shown });
    new MutationObserver(() => {
      for (const node of Array.from(rack.children)) {
        // The message alone: not the kind's leading glyph, nor a repeat's `×n`.
        let text = '';
        for (const child of Array.from(node.childNodes)) if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? '';
        if (!shown.includes(text)) shown.push(text);
      }
    }).observe(rack, { childList: true });
  });
}

const toastsShown = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __remainsToasts?: string[] }).__remainsToasts ?? []);

/** Waits until the rack has shown a toast reading exactly `text`. */
async function toastShown(page: Page, text: string): Promise<void> {
  await expect.poll(async () => toastsShown(page), { timeout: 10_000 }).toContain(text);
}

/**
 * `surface-hurt` until the death overlay is up — a hit inside the i-frames is
 * ignored, so the count of presses is not fixed, and the respawn's 2 s of
 * them are game time, which a starved host stretches.
 */
async function die(page: Page): Promise<void> {
  const death = page.getByTestId('death-overlay');
  for (let i = 0; i < 40 && !(await death.isVisible()); i++) {
    await page.getByTestId('surface-hurt').click();
    await page.waitForTimeout(400);
  }
  await expect(death).toBeVisible();
}

/** The overlay's 2.5 s run out (game time), and the salvager is back. */
async function respawned(page: Page): Promise<void> {
  await expect(page.getByTestId('death-overlay')).toBeHidden({ timeout: 30_000 });
}

/** Dies 5 m out from the pad, where the respawn at the spawn does not stand on the remains. */
async function dieByThePad(page: Page): Promise<void> {
  await page.getByTestId('surface-goto-pad').click();
  await die(page);
}

test('1. drop: the overlay names the pack, and the remains, the minimap icon and the tracker row follow', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page);
  expect(await remainsOf(page)).toBeNull();
  await dieByThePad(page);
  await expect(page.getByTestId('death-remains')).toHaveText('Your pack holds 20 oil — reach it before you fall again.');
  const dropped = await remainsOf(page);
  expect(dropped).toMatchObject({ planet: 'cinder4', resources: { oil: 20 }, restart: 1 });
  expect((await current(page))?.resources.oil).toBe(180);
  // §4.1 step 1, AC: `stats.lastDeath` is where the remains lie.
  expect((await current(page))?.meta.stats.lastDeath['cinder4']).toEqual({ x: dropped?.x, z: dropped?.z });

  await respawned(page);
  const after = await info(page);
  expect(after['remains']).toBe(`cinder4:${dropped?.x},${dropped?.z}`);
  expect(after['remainsHeld']).toBe(20);
  expect(after['remainsLook']).toBe('pack');
  expect(after['remainsDrawn']).toBe('pack');
  // §4.5: on the minimap (it repaints at 4 Hz), and under the objectives.
  await expect.poll(async () => (await info(page))['mmRemains'], { timeout: 10_000 }).toBe(1);
  await expect(page.getByTestId('tracker-remains')).toBeVisible();
  await expect(page.getByTestId('tracker-remains')).toHaveText(/^Recover your pack — \d+ m$/);
  // §4.6: the pack's tag, and the budget with the remains on screen.
  await expect(page.getByTestId('remains-tag')).toHaveText("Vance's pack");
  await expect.poll(async () => (await info(page))['remainsTag'], { timeout: 10_000 }).toBe(1);
  const budget = await info(page);
  expect(Number(budget['remainsDraws'])).toBeGreaterThan(0);
  expect(Number(budget['remainsDraws'])).toBeLessThanOrEqual(3);
  expect(Number(budget['remainsTris'])).toBeLessThanOrEqual(2700);
  // AC: the remains are not an obstacle — the salvager walks onto them (case 2) and nothing collides.
});

test('2. recover: surface-goto-remains takes the 20 oil back, the remains go and the toast says so', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page);
  await dieByThePad(page);
  await respawned(page);
  expect((await current(page))?.resources.oil).toBe(180);
  await page.getByTestId('surface-goto-remains').click();
  // "Within 1 s" is game time; a starved container gets longer to reach it.
  await expect.poll(async () => (await current(page))?.resources.oil, { timeout: 10_000 }).toBe(200);
  expect(await remainsOf(page)).toBeNull();
  // Exactly this: nothing was left, so no `— the rest stays` suffix.
  await toastShown(page, 'Recovered: 20 oil');
  expect((await current(page))?.meta.stats.recoveries).toBe(1);
  const after = await info(page);
  expect(after['remains']).toBe('-');
  expect(after['remainsHeld']).toBe(0);
  expect(after['remainsDrawn']).toBe('-');
  await expect(page.getByTestId('tracker-remains')).toBeHidden();
});

test('3. lose: a second death before the walk back forfeits the pack, and the new one holds 10 % of 180', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page);
  await dieByThePad(page);
  await respawned(page);
  // Far from both the spawn and the first pack, so neither is recovered.
  await page.getByTestId('surface-goto-edge').click();
  await die(page);
  await toastShown(page, 'Your earlier pack is gone: 20 oil.');
  await expect(page.getByTestId('death-remains')).toHaveText('Your pack holds 18 oil — reach it before you fall again.');
  expect(await remainsOf(page)).toMatchObject({ planet: 'cinder4', resources: { oil: 18 }, restart: 2 });
  expect((await current(page))?.resources.oil).toBe(162);
  await respawned(page);
  expect((await info(page))['remainsHeld']).toBe(18);
});

test('4. a full hold takes what fits; the rest stays with the pack, retried while standing there', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page);
  await dieByThePad(page);
  await respawned(page);
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save !== null) save.resources.oil = 395;
  });
  await page.getByTestId('surface-goto-remains').click();
  await expect.poll(async () => (await info(page))['remainsHeld'], { timeout: 10_000 }).toBe(15);
  expect((await current(page))?.resources.oil).toBe(400);
  await toastShown(page, 'Recovered: 5 oil — the rest stays with your pack');
  expect((await current(page))?.meta.stats.recoveries).toBe(1);
  // E93: room again while standing there — the next retry takes the rest.
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save !== null) save.resources.oil = 300;
  });
  await expect.poll(async () => remainsOf(page), { timeout: 10_000 }).toBeNull();
  expect((await current(page))?.resources.oil).toBe(315);
  expect((await current(page))?.meta.stats.recoveries).toBe(2);
});

test('5. the body: with signal_decoded the remains are the salvager’s own, tagged with the restart', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page, { flags: ['signal_decoded'] });
  expect((await info(page))['remainsLook']).toBe('body');
  await dieByThePad(page);
  await expect(page.getByTestId('death-remains')).toHaveText('Your body holds 20 oil — reach it before you fall again.');
  await expect(page.getByTestId('remains-tag')).toHaveText('instance/62 · restart 1');
  const shown = await info(page);
  expect(shown['remainsLook']).toBe('body');
  expect(shown['remainsDrawn']).toBe('body');
  // Frozen on Death's last frame: the pose time is the clip's, never 0.
  expect(Number(shown['remainsPosedAt'])).toBeGreaterThan(0);
  expect(Number(shown['remainsDraws'])).toBeLessThanOrEqual(3);
  expect(Number(shown['remainsTris'])).toBeLessThanOrEqual(2700);
  await respawned(page);
  await expect(page.getByTestId('tracker-remains')).toHaveText(/^Recover your body — \d+ m$/);
});

test('6. casual: a death takes nothing and leaves the remains already lying as they were', async ({ page }) => {
  test.setTimeout(120_000);
  const lying: Remains = { planet: 'cinder4', x: -100, z: 100, resources: { water: 7 }, restart: 3 };
  await land(page, { difficulty: 'casual', remains: lying });
  expect(await remainsOf(page)).toEqual(lying);
  await dieByThePad(page);
  await expect(page.getByTestId('death-remains')).toHaveText('');
  await expect(page.getByTestId('death-remains')).toBeHidden();
  expect(await remainsOf(page)).toEqual(lying);
  expect((await current(page))?.resources.oil).toBe(200);
  expect((await toastsShown(page)).filter((text) => text.includes('is gone'))).toEqual([]);
});

test('7. reload: the remains survive a reload and the next landing names the same point', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page);
  await dieByThePad(page);
  const dropped = await remainsOf(page);
  expect(dropped).not.toBeNull();
  await respawned(page);
  const before = (await info(page))['remains'];
  expect(before).toBe(`cinder4:${dropped?.x},${dropped?.z}`);

  // A reload is a `pagehide`: the autosave carries the remains. Back the way a
  // returning player comes: the menu's Load binds the stored save (`load()`
  // alone only parses it) and — SPEC-059 §4.1.3 — a run that stood on a
  // planet resumes at its pad, with no flight.
  await start(page, '/?debug&seed=123');
  const loaded = await page.evaluate(() => window.__reallm.save().load(0));
  expect(loaded.ok).toBe(true);
  expect(loaded.data?.progress.remains).toEqual(dropped);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
  await page.getByTestId('menu-load').click();
  await page.getByTestId('load-slot-0').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
  expect(await remainsOf(page)).toEqual(dropped);
  expect((await info(page))['resumed']).toBe(1);
  expect((await info(page))['remains']).toBe(before);
  expect((await info(page))['remainsHeld']).toBe(20);
});

test('8. elsewhere and below: another planet and the underground show nothing, and the remains wait', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page, { missionsDone: ['c1_m1'] });
  await dieByThePad(page);
  const dropped = await remainsOf(page);
  await respawned(page);
  await expect(page.getByTestId('tracker-remains')).toBeVisible();

  // Below: the view, the icon, the tag and the row hide; above again, they are back.
  await page.getByTestId('surface-goto-descent').click();
  await page.getByTestId('surface-descend').click();
  await expect.poll(async () => (await info(page))['level'], { timeout: 30_000 }).toBe('underground');
  await expect.poll(async () => (await info(page))['remainsDrawn'], { timeout: 10_000 }).toBe('-');
  await expect(page.getByTestId('tracker-remains')).toBeHidden();
  await expect(page.getByTestId('remains-tag')).toBeHidden();
  expect((await info(page))['mmRemains']).toBe(0);
  expect(await remainsOf(page)).toEqual(dropped);
  await page.getByTestId('surface-ascend').click();
  await expect.poll(async () => (await info(page))['level'], { timeout: 30_000 }).toBe('surface');
  await expect(page.getByTestId('tracker-remains')).toBeVisible();
  expect((await info(page))['remainsDrawn']).toBe('pack');

  // The station, then another planet's surface: nothing there, and the set waits in the save.
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  expect(await remainsOf(page)).toEqual(dropped);
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'vetra', firstLanding: false }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  const vetra = await info(page);
  expect(vetra['remains']).toBe(`cinder4:${dropped?.x},${dropped?.z}`);
  expect(vetra['remainsDrawn']).toBe('-');
  await expect(page.getByTestId('tracker-remains')).toBeHidden();
  await expect.poll(async () => (await info(page))['mmRemains'], { timeout: 10_000 }).toBe(0);
  expect(await remainsOf(page)).toEqual(dropped);
});

test('9. a death below leaves the remains at the descent on the surface', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page, { missionsDone: ['c1_m1'] });
  await page.getByTestId('surface-goto-descent').click();
  const at = await info(page);
  const descent = { x: Number(at['px']), z: Number(at['pz']) };
  await page.getByTestId('surface-descend').click();
  await expect.poll(async () => (await info(page))['level'], { timeout: 30_000 }).toBe('underground');
  await die(page);
  const dropped = await remainsOf(page);
  expect(dropped).toMatchObject({ planet: 'cinder4', resources: { oil: 20 } });
  // `px`/`pz` are rounded to 0.1 m, as the remains are.
  expect(Math.hypot((dropped?.x ?? Infinity) - descent.x, (dropped?.z ?? Infinity) - descent.z)).toBeLessThanOrEqual(0.15);
  await respawned(page);
  expect((await info(page))['level']).toBe('surface');
  expect((await info(page))['remainsDrawn']).toBe('pack');
});

// ------------------------------------------------------- the arena entrance

/** Click through any open dialogue, as the other surface suites do. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.locator('[data-testid="dialogue"]');
  const advance = page.locator('[data-testid="dialogue-advance"]');
  for (let i = 0; i < 30; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    if (await advance.isVisible().catch(() => false)) await advance.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    else await dialogue.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(120);
  }
}

test('10. a death in a boss stage leaves the remains at the arena’s mouth, and the respawn takes them back at once', async ({ page }) => {
  test.setTimeout(150_000);
  // `c1_m3` at stage 0 — the Wurm's nest — as SPEC-041's arena cases land.
  await land(page, { missionsDone: ['c1_m1', 'c1_m2'] });
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save !== null) save.progress.missionsActive = [{ id: 'c1_m3', stage: 0, counters: {} }];
  });
  // The active list is read at entry: land again with it in place.
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', { timeout: 30_000 });
  await dismiss(page);
  // `surface-goto-boss` stands the salvager 12 m north of the nest's centre.
  await page.getByTestId('surface-goto-boss').click();
  const at = await info(page);
  const nest = { x: Number(at['px']), z: Number(at['pz']) - 12 };
  const reveal = page.locator('[data-testid="boss-reveal"]');
  if (await reveal.isVisible({ timeout: 8_000 }).catch(() => false)) {
    await expect
      .poll(
        async () => {
          await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-testid="reveal-skip"]')?.click());
          return reveal.count();
        },
        { timeout: 15_000 },
      )
      .toBe(0);
  }
  await die(page);
  const dropped = await remainsOf(page);
  expect(dropped).toMatchObject({ planet: 'cinder4', resources: { oil: 20 } });
  // E63: on the line toward the pad, the nest's 20 m radius + 6 m out.
  const out = Math.hypot((dropped?.x ?? Infinity) - nest.x, (dropped?.z ?? Infinity) - nest.z);
  expect(out).toBeGreaterThanOrEqual(25);
  expect(out).toBeLessThanOrEqual(27);
  await respawned(page);
  // The respawn stands on them: the first step takes them back.
  await expect.poll(async () => remainsOf(page), { timeout: 10_000 }).toBeNull();
  expect((await current(page))?.resources.oil).toBe(200);
  expect((await current(page))?.meta.stats.recoveries).toBe(1);
});

// ----------------------------------------------------------------- the tip

/** Every tip but `remains`, as seen on this device — so the queue holds that one alone. */
const OTHER_TIPS = [
  'move', 'map', 'track', 'pad', 'scan', 'harvest', 'deliver', 'storm', 'boss', 'death', 'quickbar', 'overheat',
  'heavy', 'explosives', 'shelter', 'combat', 'flight_steer', 'flight_throttle', 'zones', 'dash', 'sprint', 'wurm',
  'descent', 'dark', 'puzzle', 'puzzle_calibration', 'puzzle_sequence', 'puzzle_plates', 'puzzle_beam',
];

const REMAINS_TIP = 'What you carried stays where you fell. Walk back to it. Fall again first and it is gone.';

const seenTips = (page: Page): Promise<string[]> =>
  page.evaluate(() => (JSON.parse(localStorage.getItem('reallm:settings') ?? '{}') as { tipsSeen?: string[] }).tipsSeen ?? []);

test('11. the remains tip shows at the first death that leaves remains, and is remembered for the device', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page, { tipsSeen: OTHER_TIPS });
  expect(await seenTips(page)).not.toContain('remains');
  await dieByThePad(page);
  await expect(page.getByTestId('aria-hint')).toContainText(REMAINS_TIP, { timeout: 20_000 });
  await expect.poll(async () => seenTips(page), { timeout: 10_000 }).toContain('remains');
});

test('12. a Recall to pad neither creates nor forfeits: the remains lying stay as they were', async ({ page }) => {
  test.setTimeout(120_000);
  const lying: Remains = { planet: 'cinder4', x: -100, z: 100, resources: { oil: 12 }, restart: 2 };
  await land(page, { remains: lying });
  await page.getByTestId('surface-goto-edge').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="pause-recall"]')).toBeVisible();
  await page.locator('[data-testid="pause-recall"]').click();
  await page.locator('[data-testid="confirm-yes"]').click();
  await expect.poll(async () => Number((await info(page))['recalls']), { timeout: 10_000 }).toBe(1);
  expect(await remainsOf(page)).toEqual(lying);
  expect((await current(page))?.resources.oil).toBe(200);
  expect((await toastsShown(page)).filter((text) => text.includes('is gone'))).toEqual([]);
});
