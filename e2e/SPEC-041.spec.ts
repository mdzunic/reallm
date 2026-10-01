// SPEC-041 §6.2 — Threat II in the browser: a boss that moves, a ring that
// seals, a death that comes back at the arena's mouth, a recall that opens it,
// an elite's nameplate, and flight's lead pip and hit marks. The move runtime,
// the seal's clamp, packs and affixes, the bursts and the bot suites are pinned
// in node (`tests/systems/bossMoves.test.ts`, `combat.test.ts`,
// `spawn.test.ts`, `flight.test.ts`, `threat.test.ts`); what this proves is the
// wiring only the running game shows.
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { COLD_START, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const MP4S = '**/assets/films/*.mp4';
/** Cinder-4's nest: the arena radius §6.2's distances are measured against. */
const NEST_RADIUS = 20;

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

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

/** A debug-strip press, in the page: a locator click waits out frames a slow host does not have. */
async function press(page: Page, id: string): Promise<void> {
  await page.evaluate((testId) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (button === null) throw new Error(`no ${testId} on the debug strip`);
    button.click();
  }, id);
}

/**
 * A slot-0 save with `c1_m1` and `c1_m2` done and whatever `active` names at
 * stage 0, landed on Cinder-4 through the scene machine; returns where the
 * player stands — at the pad. Auto-fire is off unless `autoFire` says so, so a
 * fight only moves when the test moves it.
 */
async function land(page: Page, url: string, active: string[], autoFire = false): Promise<{ x: number; z: number }> {
  await page.route(MP4S, (route) => route.abort());
  if (!autoFire) await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off' })));
  await start(page, url);
  await page.evaluate(
    ({ creation, missions }) => {
      const bridge = window.__reallm.save();
      bridge.create(0, creation, 123);
      const save = bridge.current;
      if (save === null) throw new Error('no save bound');
      save.progress.missionsDone = ['c1_m1', 'c1_m2'];
      save.progress.missionsActive = missions.map((id) => ({ id, stage: 0, counters: {} }));
    },
    { creation: CREATION, missions: active },
  );
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
  await dismiss(page);
  const info = await sceneInfo(page);
  return { x: Number(info['px']), z: Number(info['pz']) };
}

/** `c1_m3` at its boss stage: into the nest, past the reveal if one plays. */
async function enterFight(page: Page): Promise<void> {
  await press(page, 'surface-goto-boss');
  const reveal = page.locator('[data-testid="boss-reveal"]');
  if (await reveal.isVisible({ timeout: 8_000 }).catch(() => false)) {
    // The Skip button takes a pointer press at once; press until the beat is gone.
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
  await expect.poll(async () => String((await sceneInfo(page))['boss'] ?? '-'), { timeout: 15_000 }).not.toBe('-');
}

const distanceFrom = (info: Record<string, number | string>, at: { x: number; z: number }): number =>
  Math.hypot(Number(info['px']) - at.x, Number(info['pz']) - at.z);

/** The player's distance from the nest's centre (`sceneInfo.arenaDist`). */
const fromNest = (info: Record<string, number | string>): number => Number(info['arenaDist']);

// -------------------------------------------------------------- 1–4: bosses

test('1. Moves: the wurm draws a telegraph and lands sand_rush or tail_slam within 10 s', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page, '/?films=on&debug&seed=123', ['c1_m3']);
  await enterFight(page);
  // Watched in the page on every frame: a telegraph lives about a second of
  // game time, which a polling round trip on a slow host can step over.
  await page.waitForFunction(() => Number(window.__reallm.stats().sceneInfo?.['telegraphs'] ?? 0) >= 1, null, {
    polling: 'raf',
    timeout: 10_000,
  });
  await expect.poll(async () => String((await sceneInfo(page))['bossMove']), { timeout: 10_000 }).toMatch(/^(sand_rush|tail_slam)$/);
});

test('2. Seal: inside with the boss alive the ring seals, and walking away for 3 s stays inside it', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page, '/?debug&seed=123', ['c1_m3']);
  await enterFight(page);
  await expect.poll(async () => Number((await sceneInfo(page))['sealed']), { timeout: 10_000 }).toBe(1);
  // S + A walks world +z — away from the nest, which `surface-goto-boss` puts
  // 12 m north of the player. Three seconds at 6 m/s would carry them to 30 m.
  await page.keyboard.down('KeyS');
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(3_000);
  const info = await sceneInfo(page);
  await page.keyboard.up('KeyS');
  await page.keyboard.up('KeyA');
  expect(Number(info['sealed'])).toBe(1);
  expect(fromNest(info)).toBeLessThanOrEqual(NEST_RADIUS);
});

test('3. Respawn: a death in the arena comes back at its mouth, 25–27 m out, unsealed (E63)', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page, '/?debug&seed=123', ['c1_m3']);
  await enterFight(page);
  await expect.poll(async () => Number((await sceneInfo(page))['sealed']), { timeout: 10_000 }).toBe(1);
  const death = page.locator('[data-testid="death-overlay"]');
  for (let i = 0; i < 12 && !(await death.isVisible()); i++) {
    await press(page, 'surface-hurt');
    await page.waitForTimeout(400);
  }
  await expect(death).toBeVisible({ timeout: 10_000 });
  await expect(death).toBeHidden({ timeout: 15_000 });
  const info = await sceneInfo(page);
  const out = fromNest(info);
  expect(out).toBeGreaterThanOrEqual(NEST_RADIUS + 6 - 1);
  expect(out).toBeLessThanOrEqual(NEST_RADIUS + 6 + 1);
  expect(Number(info['sealed'])).toBe(0);
});

test('4. Recall: Recall to pad mid-fight returns to the pad and opens the seal', async ({ page }) => {
  test.setTimeout(120_000);
  const pad = await land(page, '/?debug&seed=123', ['c1_m3']);
  await enterFight(page);
  await expect.poll(async () => Number((await sceneInfo(page))['sealed']), { timeout: 10_000 }).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="pause-recall"]')).toBeVisible();
  await page.locator('[data-testid="pause-recall"]').click();
  await page.locator('[data-testid="confirm-yes"]').click();
  await expect.poll(async () => distanceFrom(await sceneInfo(page), pad), { timeout: 10_000 }).toBeLessThan(3);
  expect(Number((await sceneInfo(page))['sealed'])).toBe(0);
});

// ------------------------------------------------------------------ 5: plate

test('5. Plate: Spawn elite raises an elite-plate reading Alpha and its affix', async ({ page }) => {
  test.setTimeout(90_000);
  await land(page, '/?debug&seed=123', []);
  await press(page, 'surface-spawn-elite');
  const plate = page.locator('[data-testid="elite-plate"]:not(.is-hidden)').first();
  await expect(plate).toBeVisible({ timeout: 10_000 });
  await expect(plate).toContainText('Alpha Dust Skitter');
  // Cinder-4 is chapter 1: one affix from the swarm's pool.
  await expect(plate).toContainText(/Swift|Bulwark|Mender|Volatile/);
  await expect.poll(async () => Number((await sceneInfo(page))['elitePlates'] ?? 0)).toBeGreaterThanOrEqual(1);
});

// ----------------------------------------------------------- 6–7: flight

interface FlightHook {
  phase(): string;
  blockArrival(): void;
}

test('6 & 7. Pip and hit feedback: a still fighter ahead shows the pip, and fire marks the reticle', async ({ page }) => {
  test.setTimeout(120_000);
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => void messages.push(message));
  // A new save carries ARIA level 1, enabled: the pip is hers. Auto-fire off,
  // so the fighter stands until the trigger is held; mouse steer off, so the
  // ship holds still while the pointer looks for it.
  await page.addInitScript(() =>
    localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off', flightMouseSteer: false })),
  );
  await start(page, '/?debug&scene=flight&planet=cinder4&quality=medium');
  await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
  await page.evaluate(() => (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight.blockArrival());
  // The pointer on the fighter, dead ahead: down the screen's vertical middle
  // until the 6° cone takes it. The chase camera sits above and behind the
  // ship, so the screen's centre itself aims about 9° high.
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  for (let k = 0; k <= 16 && Number((await sceneInfo(page))['lead']) !== 1; k++) {
    await page.mouse.move(viewport.width / 2, viewport.height * (0.4 + 0.035 * k));
    await page.waitForTimeout(150);
  }
  const pip = page.locator('[data-testid="lead-pip"]');
  await expect(pip).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => Number((await sceneInfo(page))['lead'])).toBe(1);
  // The pip is where a shot fired now meets the fighter: aim there (ARIA level
  // 1 never moves the reticle for the pilot).
  const at = await pip.boundingBox();
  if (at === null) throw new Error('the lead pip has no box');
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);

  // The guns wake after the launch; then hold fire at it.
  await page.waitForFunction(() => (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight.phase() !== 'launch', null, {
    timeout: 15_000,
  });
  // The marks last 0.1 s and 0.25 s of game time, so they are caught as they
  // happen — each with the trip's progress, the flight's own clock: a loaded
  // host runs the game behind the wall clock, and §6.2's 2 s are game seconds.
  await page.evaluate(() => {
    const reticle = document.querySelector('[data-testid="reticle"]');
    const seen = ((window as unknown as { __marks: { mark: string; progress: number }[] }).__marks = []);
    if (reticle === null) return;
    new MutationObserver(() => {
      for (const mark of ['is-hit', 'is-kill']) {
        if (!reticle.classList.contains(mark) || seen.some((s) => s.mark === mark)) continue;
        seen.push({ mark, progress: Number(window.__reallm.stats().sceneInfo?.['progress'] ?? 0) });
      }
    }).observe(reticle, { attributes: true, attributeFilter: ['class'] });
  });
  const firedAt = Number((await sceneInfo(page))['progress']);
  // Hold fire on Space, which leaves the pointer — and so the aim — where it is.
  await page.keyboard.down('Space');
  const marks = (): Promise<string[]> =>
    page.evaluate(() => (window as unknown as { __marks: { mark: string }[] }).__marks.map((s) => s.mark));
  await expect.poll(marks, { timeout: 20_000, intervals: [50] }).toContain('is-hit');
  await expect.poll(marks, { timeout: 30_000, intervals: [100] }).toContain('is-kill');
  await page.keyboard.up('Space');
  // Cinder-4's trip is 90 s at throttle 1: progress × 90 is game seconds (±0.09 s).
  const hitAt = await page.evaluate(
    () => (window as unknown as { __marks: { mark: string; progress: number }[] }).__marks.find((s) => s.mark === 'is-hit')?.progress ?? 1,
  );
  expect((hitAt - firedAt) * 90).toBeLessThanOrEqual(2 + 0.1);
  const events = messages.filter((m) => m.type() === 'debug' && m.text().startsWith('[events] flight:hazardHit'));
  expect(events.length).toBeGreaterThanOrEqual(2);
});

// ------------------------------------------------------------------- AC-37

test('AC-37. a boss fight with telegraphs live and six plates stays inside the medium budget', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page, '/?debug&seed=123&quality=medium', ['c1_m3']);
  await enterFight(page);
  for (let i = 0; i < 6; i++) await press(page, 'surface-spawn-elite');
  // The dev strip's circle and ring, with the wurm's own moves on top: every
  // telegraph kind can be live at once.
  await press(page, 'surface-telegraphs');
  const draws = await page.waitForFunction(
    () => {
      const stats = window.__reallm.stats();
      const info = stats.sceneInfo ?? {};
      return Number(info['elitePlates']) === 6 && Number(info['telegraphDraws']) >= 2 ? stats.drawCalls : false;
    },
    null,
    { polling: 'raf', timeout: 30_000 },
  );
  expect(Number(await draws.jsonValue())).toBeLessThanOrEqual(96); // 80 scene + 16 post
});
