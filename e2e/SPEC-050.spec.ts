// SPEC-050 §6.2 — walk, do not run, in a real browser: a run in combat drains
// the stamina to exhaustion and the ring beside the salvager says so, a travel
// run on Eden costs nothing at ×1.35, the run holsters the gun and draws it
// 0.25 s after, the dash costs 30, the keyboard toggle, the stick pushed past
// its ring, Shift keeping the flight's throttle, the Wurm's burrow ring
// following a running salvager and not a walking one, the two tips, and the
// medium budget with all of it on screen. The rules are pinned in node —
// tests/systems/stamina.test.ts, combat.test.ts, enemyAi.test.ts,
// dash.test.ts, shelter.test.ts, threat.test.ts, tests/core/input.test.ts and
// tests/data/content.test.ts.
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { awaitGate, COLD_START, frames, gameUrl, start, type InputSnapshot } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** The words §4.7 pins; `e2e/` may not import `src/`. */
const SPRINT_TIP_KEYBOARD = 'Shift runs. Running is loud and holsters your gun — walk when you want to shoot.';
const WURM_TIP = 'It hunts by vibration: walk out of the ring — running pulls it after you.';

/**
 * The third tip of a landing shows 24 s of game time in; a GPU-less run under
 * load moves the game at a third of the wall clock.
 */
const TIP_WAIT_MS = 150_000;

/** A landscape phone: coarse pointer, no hover, touch points (SPEC-036 §4.2). */
const PHONE = { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true } as const;

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

async function info(page: Page, key: string): Promise<number> {
  return Number((await sceneInfo(page))[key]);
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

/**
 * A slot-0 save with `c1_m1` done (so SPEC-035's first-landing ramp is over),
 * then a landing on Cinder-4 through the scene machine. The page must already
 * be past the gate.
 */
async function landOnCinder(page: Page): Promise<void> {
  await page.evaluate((creation) => {
    const bridge = window.__reallm.save();
    bridge.create(0, creation, 123);
    const save = bridge.current;
    if (save === null) throw new Error('no save bound');
    save.progress.missionsDone.push('c1_m1');
  }, CREATION);
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4' }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
  await dismiss(page);
}

/**
 * The world clock (`sceneInfo.viewTime`) on the first rendered frame where
 * `sceneInfo[key] ≥ min` — read in the same frame, so a slow container that
 * runs the game behind the wall clock measures game seconds, not wall ones.
 * The wall-clock budget is wide for the same reason: a starved GPU-less run
 * draws a few frames a second, and the loop's five-step ceiling then moves the
 * game at a third of the wall clock.
 */
async function viewTimeWhen(page: Page, key: string, min: number, timeout = 60_000): Promise<number> {
  const handle = await page.waitForFunction(
    ({ key: name, min: floor }) => {
      const sample = window.__reallm.stats().sceneInfo ?? {};
      return Number(sample[name] ?? -Infinity) >= floor ? Number(sample['viewTime'] ?? 0) || 1e-6 : false;
    },
    { key, min },
    { polling: 'raf', timeout },
  );
  return Number(await handle.jsonValue());
}

/** Waits until `seconds` of game time have passed from now. */
async function gameSeconds(page: Page, seconds: number): Promise<void> {
  const now = await info(page, 'viewTime');
  await viewTimeWhen(page, 'viewTime', now + seconds);
}

type Sample = Record<string, number>;
interface Sampler {
  __samples: Sample[];
  __sampling: boolean;
}

/** Records `keys` of `sceneInfo` on every rendered frame until `stopSampling`. */
async function startSampling(page: Page, keys: readonly string[]): Promise<void> {
  await page.evaluate((names) => {
    const scope = window as unknown as Sampler;
    scope.__samples = [];
    scope.__sampling = true;
    const tick = (): void => {
      if (!scope.__sampling) return;
      const sample = window.__reallm.stats().sceneInfo ?? {};
      const row: Record<string, number> = {};
      for (const name of names) row[name] = Number(sample[name]);
      scope.__samples.push(row);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, keys);
}

async function stopSampling(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const scope = window as unknown as Sampler;
    scope.__sampling = false;
    return scope.__samples;
  });
}

interface KeyClock {
  __keyAt: Record<string, number>;
}

/**
 * Records the view clock when each key's first keydown reaches the page, so a
 * measurement leaves out Playwright's own latency — on a starved run a key
 * round trip can take half a second of wall clock, while the game runs on.
 */
async function watchKeys(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as KeyClock;
    scope.__keyAt = {};
    window.addEventListener(
      'keydown',
      (event) => {
        if (scope.__keyAt[event.code] !== undefined) return;
        scope.__keyAt[event.code] = Number(window.__reallm.stats().sceneInfo?.['viewTime'] ?? Number.NaN);
      },
      true,
    );
  });
}

async function keyAt(page: Page, code: string): Promise<number> {
  return page.evaluate((name) => (window as unknown as KeyClock).__keyAt[name] ?? Number.NaN, code);
}

/** The `[events]` debug lines `?debug` writes for every emit (SPEC-004 §4.6). */
function eventLines(messages: ConsoleMessage[], name: string): string[] {
  return messages.filter((m) => m.type() === 'debug' && m.text().startsWith(`[events] ${name}`)).map((m) => m.text());
}

const press = (page: Page, id: string): Promise<void> => page.getByTestId(id).dispatchEvent('click');

/** The tip strip's text, empty while it is down. */
async function ariaHint(page: Page): Promise<string> {
  return (await page.locator('[data-testid="aria-hint"]').innerText().catch(() => '')) ?? '';
}

// ------------------------------------------------------- 1, 9: the run in combat

test('1, 9. a run in combat drains to exhaustion, the ring says so, and a fresh profile is taught the sprint tip', async ({ page }) => {
  test.setTimeout(300_000);
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => void messages.push(message));
  await start(page, '/?debug&seed=123');
  await landOnCinder(page);
  expect(await info(page, 'stamina')).toBe(100);
  await press(page, 'surface-spawn-pack');
  await watchKeys(page);
  await startSampling(page, ['viewTime', 'sprinting', 'stamina', 'exhausted']);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await viewTimeWhen(page, 'exhausted', 1);
  const samples = await stopSampling(page);
  const pressedAt = Math.max(await keyAt(page, 'ShiftLeft'), await keyAt(page, 'KeyW'));

  // Within 0.5 s of the keys the salvager runs, and the pool is falling.
  const run = samples.find((s) => s.sprinting === 1) as Sample;
  expect(run).toBeDefined();
  expect(run.viewTime - pressedAt).toBeLessThanOrEqual(0.5);
  const later = samples.find((s) => s.viewTime >= run.viewTime + 0.4) as Sample;
  expect(later.stamina).toBeLessThan(run.stamina);

  // 25 a second empties it in 4 s: exhausted within 4.8 s, with the event.
  const exhausted = samples.find((s) => s.exhausted === 1) as Sample;
  expect(exhausted.viewTime - run.viewTime).toBeLessThanOrEqual(4.8);
  expect(exhausted.stamina).toBe(0);
  await expect.poll(() => eventLines(messages, 'player:exhausted').length).toBe(1);
  expect(await info(page, 'sprinting')).toBe(0);

  // The ring beside the salvager: up, amber and dashed — `is-exhausted`.
  const ring = page.getByTestId('hud-stamina');
  await expect(ring).toBeVisible();
  await expect(ring).toHaveClass(/is-exhausted/);
  await expect(ring).toHaveAttribute('role', 'meter');
  expect(Number(await ring.getAttribute('aria-valuenow'))).toBeLessThan(30);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');

  // §6.2 case 9: the first in-combat sprint queued the sprint tip. Tips wait
  // 12 s of game time behind each other (SPEC-027) and the landing's `move`
  // and `pad` go first, so it shows about 24 s in — a minute and more of wall
  // clock on a starved run.
  await expect.poll(() => ariaHint(page), { timeout: TIP_WAIT_MS }).toContain(SPRINT_TIP_KEYBOARD);
});

// ----------------------------------------------------------- 2: the travel run

test('2. a travel run on Eden costs nothing, runs 8.26 m/s, and the ring stays hidden', async ({ page }) => {
  await start(page, '/?debug&scene=surface&planet=eden&seed=123');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await dismiss(page);
  const ring = page.getByTestId('hud-stamina');
  await expect(ring).toBeHidden();

  await startSampling(page, ['viewTime', 'sprinting', 'stamina', 'speed', 'loud']);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  const runAt = await viewTimeWhen(page, 'sprinting', 1);
  await viewTimeWhen(page, 'viewTime', runAt + 2);
  const samples = await stopSampling(page);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');

  const running = samples.filter((s) => s.sprinting === 1);
  expect(running.length).toBeGreaterThan(5);
  // Out of combat a run spends nothing, and it is loud.
  for (const s of running) expect(s.stamina).toBe(100);
  expect(running.every((s) => s.loud === 1)).toBe(true);
  // The Marine's 6.12 m/s walk × 1.35: 8.26 on every unobstructed step, and
  // never faster (a rock only takes speed away).
  const speeds = running.slice(1).map((s) => s.speed);
  const atSprint = speeds.filter((v) => Math.abs(v - 8.26) <= 0.05).length;
  expect(atSprint, speeds.join(', ')).toBeGreaterThanOrEqual(Math.ceil(speeds.length / 2));
  expect(Math.max(...speeds), speeds.join(', ')).toBeLessThanOrEqual(8.31);
  await expect(ring).toBeHidden();
});

// ------------------------------------------------------------- 3: the holster

test('3. a run holsters the gun: no shot while running, and the first after it 0.25 s later', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page, '/?debug&seed=123');
  await landOnCinder(page);
  await press(page, 'surface-spawn-pack');
  // The pack is aggroed within 10 m, and auto-fire is on by default: it shoots.
  await expect.poll(() => info(page, 'shots'), { timeout: 60_000 }).toBeGreaterThan(0);

  await startSampling(page, ['viewTime', 'sprinting', 'shots']);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  const runAt = await viewTimeWhen(page, 'sprinting', 1);
  await viewTimeWhen(page, 'viewTime', runAt + 1);
  await page.keyboard.up('ShiftLeft');
  const shotsAtRelease = await info(page, 'shots');
  await expect.poll(() => info(page, 'shots'), { timeout: 60_000 }).toBeGreaterThan(shotsAtRelease);
  await page.keyboard.up('KeyW');
  const samples = await stopSampling(page);

  const start0 = samples.findIndex((s) => s.sprinting === 1);
  let end = start0;
  while ((samples[end + 1]?.sprinting ?? 0) === 1) end++;
  const run = samples.slice(start0, end + 1);
  expect((run.at(-1)?.viewTime ?? 0) - (run[0]?.viewTime ?? 0)).toBeGreaterThanOrEqual(0.9);
  // Not one shot while running…
  for (const s of run) expect(s.shots, `${s.viewTime}`).toBe(run[0]?.shots);
  // …and the first after it no earlier than 0.25 s past the last running frame.
  const last = run.at(-1) as Sample;
  const shot = samples.slice(end + 1).find((s) => s.shots > last.shots);
  expect(shot).toBeDefined();
  expect((shot as Sample).viewTime - last.viewTime).toBeGreaterThanOrEqual(0.25 - 1e-3);
});

// ------------------------------------------------------------ 4: the dash cost

test('4. an exhausted dash press does nothing; at 30 or more the dash costs 30', async ({ page }) => {
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => void messages.push(message));
  await start(page, '/?debug&seed=123');
  await landOnCinder(page);
  const dashes = await info(page, 'dashes');

  await press(page, 'surface-exhaust');
  await expect.poll(() => info(page, 'exhausted')).toBe(1);
  expect(await info(page, 'stamina')).toBe(0);
  expect(eventLines(messages, 'player:exhausted')).toHaveLength(1);
  await page.keyboard.press('KeyV');
  await frames(page, 10);
  expect(await info(page, 'dashes')).toBe(dashes);
  expect(eventLines(messages, 'player:dashed')).toHaveLength(0);

  // Back at 30 the dash is allowed again, and takes its 30. The sampler has
  // frames of its own before the press, whatever the pool has reached by then.
  await startSampling(page, ['viewTime', 'stamina', 'exhausted', 'dashes']);
  await frames(page, 2);
  await page.waitForFunction(
    () => {
      const sample = window.__reallm.stats().sceneInfo ?? {};
      return Number(sample['stamina']) >= 30 && Number(sample['exhausted']) === 0;
    },
    null,
    { polling: 'raf', timeout: 60_000 },
  );
  await page.keyboard.press('KeyV');
  await expect.poll(() => info(page, 'dashes')).toBe(dashes + 1);
  await frames(page, 2);
  const samples = await stopSampling(page);
  const at = samples.findIndex((s) => s.dashes === dashes + 1);
  expect(at).toBeGreaterThan(0);
  const before = samples[at - 1] as Sample;
  const after = samples[at] as Sample;
  expect(before.stamina).toBeGreaterThanOrEqual(30);
  expect(before.exhausted).toBe(0);
  expect(after.stamina - before.stamina).toBeGreaterThanOrEqual(-31);
  expect(after.stamina - before.stamina).toBeLessThanOrEqual(-29);
});

// --------------------------------------------------------------- 5: the toggle

test('5. with the run toggle on, one Shift tap runs and a second walks', async ({ page }) => {
  await start(page, '/?debug&seed=123');
  await landOnCinder(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.getByTestId('pause-settings').click();
  const toggle = page.getByTestId('settings-sprint-toggle');
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toHaveAttribute('aria-label', 'Run toggle');
  await toggle.check();
  await expect(toggle).toBeChecked();
  await page.getByTestId('settings-close').click();
  await page.getByTestId('pause-resume').click();
  await expect(page.getByTestId('pause-menu')).toBeHidden();

  await page.keyboard.down('KeyW');
  await page.keyboard.press('ShiftLeft');
  await expect.poll(() => info(page, 'sprinting')).toBe(1);
  // The latch holds it with no key down.
  await gameSeconds(page, 0.3);
  expect(await info(page, 'sprinting')).toBe(1);
  await page.keyboard.press('ShiftLeft');
  await expect.poll(() => info(page, 'sprinting')).toBe(0);
  await page.keyboard.up('KeyW');
});

// ------------------------------------------------------------------ 6: touch

interface Finger {
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';
  id: number;
  x: number;
  y: number;
}

/** Thumbs on the touch surface itself, as SPEC-036's suite drives them. */
async function fingers(page: Page, steps: readonly Finger[]): Promise<InputSnapshot> {
  return page.evaluate((events) => {
    const surface = document.querySelector('[data-testid="touch-surface"]');
    if (surface === null) throw new Error('the touch surface is not mounted');
    for (const step of events) {
      surface.dispatchEvent(
        new PointerEvent(step.type, {
          pointerId: step.id,
          pointerType: 'touch',
          isPrimary: step.id === 1,
          clientX: step.x,
          clientY: step.y,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    return window.__reallm.input();
  }, steps);
}

/** Navigate and pass the gate with a tap, as a phone does (SPEC-036 §4.2). */
async function startTouch(page: Page, url: string): Promise<void> {
  await page.goto(gameUrl(url));
  await awaitGate(page);
  await page.locator('[data-testid="boot-start"]').tap();
  await expect(page.locator('[data-testid="boot-overlay"]')).toBeHidden();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', COLD_START);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
}

test.describe('6. the stick runs past its ring', () => {
  test.use(PHONE);

  test('a 70 px hold for 0.3 s runs and lights the ring, 40 px walks, and with Run with the stick off it never runs', async ({ page }) => {
    test.setTimeout(180_000);
    await startTouch(page, '/?debug&scene=surface&planet=eden&seed=123');
    await dismiss(page);
    await expect(page.getByTestId('touch-controls')).toBeVisible();
    const stick = page.getByTestId('touch-stick');

    await fingers(page, [
      { type: 'pointerdown', id: 1, x: 120, y: 250 },
      { type: 'pointermove', id: 1, x: 190, y: 250 },
    ]);
    await gameSeconds(page, 0.3);
    await expect.poll(() => info(page, 'sprinting')).toBe(1);
    await expect(stick).toHaveClass(/is-sprint/);

    await fingers(page, [{ type: 'pointermove', id: 1, x: 160, y: 250 }]);
    await expect.poll(() => info(page, 'sprinting')).toBe(0);
    await expect(stick).not.toHaveClass(/is-sprint/);
    await fingers(page, [{ type: 'pointerup', id: 1, x: 160, y: 250 }]);

    // Pause → Settings → `settings-stick-sprint` off, all on touch.
    await page.getByTestId('touch-pause').tap();
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('pause-settings').tap();
    const toggle = page.getByTestId('settings-stick-sprint');
    await expect(toggle).toBeChecked();
    await expect(toggle).toHaveAttribute('aria-label', 'Run with the stick');
    await toggle.tap();
    await expect(toggle).not.toBeChecked();
    await page.getByTestId('settings-close').tap();
    await page.getByTestId('pause-resume').tap();
    await expect(page.getByTestId('pause-menu')).toBeHidden();

    await fingers(page, [
      { type: 'pointerdown', id: 1, x: 120, y: 250 },
      { type: 'pointermove', id: 1, x: 190, y: 250 },
    ]);
    await gameSeconds(page, 0.5);
    expect(await info(page, 'sprinting')).toBe(0);
    const held = await page.evaluate(() => window.__reallm.input());
    expect(held.buttons['sprint']?.down).toBe(false);
    await fingers(page, [{ type: 'pointerup', id: 1, x: 190, y: 250 }]);
  });
});

// ----------------------------------------------------------------- 7: flight

test('7. in flight ShiftLeft still raises the throttle, and runs nothing', async ({ page }) => {
  await start(page, '/?debug&scene=flight&planet=cinder4&seed=123');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  const throttle = page.locator('[data-testid="hud-throttle"]');
  const read = async (): Promise<number> => Number(((await throttle.textContent()) ?? '').replace(/[^0-9.]/g, ''));
  const before = await read();
  await page.keyboard.down('ShiftLeft');
  const held = await page.evaluate(() => window.__reallm.input());
  expect(held.buttons['throttleUp']?.down).toBe(true);
  expect(held.buttons['sprint']?.down).toBe(false);
  await page.keyboard.up('ShiftLeft');
  await expect.poll(read).toBeGreaterThan(before);
});

// ---------------------------------------------------------------- 8: the Wurm

/** The Wurm woken and wounded into phase 2, which opens its burrow. */
async function burrowing(page: Page, messages: ConsoleMessage[]): Promise<void> {
  await press(page, 'surface-spawn-boss');
  await expect.poll(async () => String((await sceneInfo(page))['boss'] ?? ''), { timeout: 60_000 }).toMatch(/^p1 /);
  for (let i = 0; i < 3; i++) await press(page, 'surface-wound-boss');
  await expect.poll(() => eventLines(messages, 'enemy:windup').some((line) => line.includes('burrow')), { timeout: 60_000 }).toBe(true);
}

test('8, 9. running pulls the burrow ring after the salvager until 0.4 s before the hit, and a fresh profile is taught the wurm tip', async ({ page }) => {
  test.setTimeout(300_000);
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => void messages.push(message));
  await start(page, '/?debug&seed=123');
  await landOnCinder(page);
  await burrowing(page, messages);

  await startSampling(page, ['viewTime', 'burrowRing', 'loud']);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyD');
  // The loud dig ends early and the ring comes down where the salvager is.
  const drawnAt = await viewTimeWhen(page, 'burrowRing', 0);
  await viewTimeWhen(page, 'viewTime', drawnAt + 1.3);
  await page.keyboard.up('KeyD');
  await page.keyboard.up('ShiftLeft');
  const samples = await stopSampling(page);

  // It lands 1.2 s after it is drawn and stops following 0.4 s before that;
  // the first frame that shows it can be up to a few steps late.
  const following = samples.filter((s) => s.burrowRing >= 0 && s.viewTime <= drawnAt + 0.8 - 5 / 60);
  expect(following.length).toBeGreaterThan(3);
  for (const s of following) {
    expect(s.loud).toBe(1);
    expect(s.burrowRing, `${s.viewTime}`).toBeLessThan(2);
  }

  // §6.2 case 9: the first burrow windup queued the wurm tip, behind the
  // landing's two, as case 1's.
  await expect.poll(() => ariaHint(page), { timeout: TIP_WAIT_MS }).toContain(WURM_TIP);
});

test('8. walking leaves the burrow ring where it came down: past 3 m within 0.9 s', async ({ page }) => {
  test.setTimeout(180_000);
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => void messages.push(message));
  await start(page, '/?debug&seed=123');
  await landOnCinder(page);
  await burrowing(page, messages);

  // A quiet dig runs its 2.5 s; the ring comes down where the salvager stands,
  // and a walk away from the moment the key lands leaves it there.
  await viewTimeWhen(page, 'burrowRing', 0);
  await watchKeys(page);
  await startSampling(page, ['viewTime', 'burrowRing', 'loud']);
  await page.keyboard.down('KeyD');
  await viewTimeWhen(page, 'burrowRing', 3.0001);
  await page.keyboard.up('KeyD');
  const samples = await stopSampling(page);
  const walkedAt = await keyAt(page, 'KeyD');
  const grown = samples.find((s) => s.burrowRing > 3) as Sample;
  expect(grown).toBeDefined();
  expect(grown.viewTime - walkedAt).toBeLessThanOrEqual(0.9);
  for (const s of samples) expect(s.loud).toBe(0);
});

// --------------------------------------------------------------- the budget

test('10. a run on medium stays inside SPEC-015 §5 — the ring is DOM, not a draw (96 draws)', async ({ page }) => {
  test.setTimeout(180_000);
  // SPEC-040 §4.3: a GPU-less container would step the governor down to `low`;
  // the budget is `medium`'s, so the preset holds still.
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ adaptiveQuality: false })));
  await start(page, '/?debug&seed=123&quality=medium');
  await landOnCinder(page);
  await press(page, 'surface-spawn-pack');
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await viewTimeWhen(page, 'sprinting', 1);
  await expect(page.getByTestId('hud-stamina')).toBeVisible();
  const from = (await page.evaluate(() => window.__reallm.stats())).frame;
  await page.waitForFunction((target) => window.__reallm.stats().frame >= target, from + 30);
  const stats = await page.evaluate(() => window.__reallm.stats());
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  expect(stats.preset).toBe('medium');
  expect(stats.drawCalls).toBeGreaterThan(10);
  expect(stats.drawCalls).toBeLessThanOrEqual(96); // 80 scene + 16 post
});
