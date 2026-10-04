// The dev stats overlay (SPEC-002 §4.6, §6.2). Its content is a closed list —
// eighteen rows and two buttons, nothing else — because every later performance
// claim in this project is read off it. SPEC-007's `persist` row is §7 (M7);
// SPEC-008's seed and layout hash (§7) are how "the same planet every landing"
// is checked, and `e2e/SPEC-008.spec.ts` asserts their content. The `update` and
// `render` medians are SPEC-015 D-13: §5 budgets the simulation at ≤ 6 ms and
// the draw at ≤ 8 ms on the surface, and a phone playtest has no profiler to
// read them with. Here every row only has to be present and formatted.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

/** The rows of §4.6.1, in order, with the text format each one must match. */
const ROWS: ReadonlyArray<readonly [string, RegExp]> = [
  ['debug-fps', /^fps \d+$/],
  ['debug-frame-ms', /^ms \d+\.\d$/],
  ['debug-updates', /^upd [0-5]$/],
  ['debug-dropped', /^dropped \d+\.\d{2}s$/],
  // SPEC-015 §5, D-13: the two rows §5's update/render budgets are stated in.
  ['debug-update-ms', /^update \d+\.\d{2}ms$/],
  ['debug-render-ms', /^render \d+\.\d{2}ms$/],
  ['debug-draws', /^draws \d+$/],
  ['debug-tris', /^tris \d+$/],
  ['debug-memory', /^geo \d+ tex \d+$/],
  ['debug-preset', /^preset (?:low|medium|high)$/],
  ['debug-dpr', /^dpr \d+\.\d{2} of \d+\.\d{2}$/],
  ['debug-size', /^size \d+x\d+$/],
  ['debug-scene', /^scene menu(?: [\w-]+=[^\s]+)*$/],
  ['debug-state', /^state (?:running|paused|hidden|context-lost|stopped)$/],
  // SPEC-007 §7: `unknown` until `navigator.storage.persist()` has answered,
  // which it only does after the first save of a session.
  ['debug-persist', /^persist (?:granted|denied|unknown)$/],
  // SPEC-008 §7: the menu has no planet under it, so the layout row is `-`
  // there; the hash appears on a landing.
  ['debug-seed', /^seed \d+$/],
  ['debug-layout', /^layout (?:-|[a-z0-9_]+ [0-9a-f]{8})$/],
  ['debug-events', /\d+\.\d{2} \S+/],
];

/** The twelve names of §4.6.2 and nothing else. */
const EVENT_NAMES = [
  'boot:assets',
  'boot:started',
  'app:paused',
  'app:resumed',
  'app:blur',
  'app:pagehide',
  'renderer:resized',
  'renderer:context-lost',
  'renderer:context-restored',
  'scene:transition',
  'scene:entered',
  'frame:order',
];

async function overlayChildren(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...(document.querySelector('.overlay-debug')?.children ?? [])].map((node) => node.getAttribute('data-testid') ?? ''),
  );
}

test('holds exactly the eighteen rows and the two buttons, in order (AC-27 … AC-30)', async ({ page }) => {
  await start(page, '/?debug');

  for (const [id, format] of ROWS) {
    await expect(page.locator(`[data-testid="${id}"]`), id).toHaveText(format);
  }

  await expect(page.locator('[data-testid="debug-lose-context"]')).toHaveText('Simulate context loss');
  await expect(page.locator('[data-testid="debug-lose-context-fatal"]')).toHaveText(
    'Simulate context loss (no restore)',
  );

  // Nothing else is part of the overlay.
  expect(await overlayChildren(page)).toEqual([
    ...ROWS.map(([id]) => id),
    'debug-lose-context',
    'debug-lose-context-fatal',
  ]);
});

test('sits in the top-left corner, below the scene label (AC-28)', async ({ page }) => {
  await start(page, '/?debug');
  const panel = await page.locator('.overlay-debug').boundingBox();
  const label = await page.locator('[data-testid="scene-label"]').boundingBox();
  expect(panel).not.toBeNull();
  expect(label).not.toBeNull();
  expect(panel?.x).toBeLessThan(200);
  // Below the label, and not overlapping it.
  expect(panel?.y ?? 0).toBeGreaterThanOrEqual((label?.y ?? 0) + (label?.height ?? 0));
  await expect(page.locator('.overlay-debug')).toHaveCSS('font-family', /mono/i);
});

test('prints the scene id and its debugInfo() pairs (AC-31)', async ({ page }) => {
  await start(page, '/?debug');
  const row = page.locator('[data-testid="debug-scene"]');
  await expect(row).toHaveText(/^scene menu /);
  // The menu placeholder reports its prop count and the rotating prop's angle.
  await expect(row).toHaveText(/props=1/);

  expect(await page.evaluate(() => window.__reallm.go('station', {}))).toBe(true);
  await expect(row).toHaveText(/^scene station props=3/);
});

test('the event log holds at most the last twelve permitted names (AC-32)', async ({ page }) => {
  await start(page, '/?debug');
  // Enough transitions to overflow the twelve-entry window.
  for (const [id, params] of [
    ['station', {}],
    ['starmap', undefined],
    ['station', {}],
    ['starmap', undefined],
  ] as const) {
    expect(await page.evaluate(([i, p]) => window.__reallm.go(i, p), [id, params] as const)).toBe(true);
  }

  const text = (await page.locator('[data-testid="debug-events"]').textContent()) ?? '';
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.length).toBeLessThanOrEqual(12);

  let previous = -1;
  for (const line of lines) {
    const match = /^(\d+\.\d{2}) ([\w:]+)/.exec(line);
    expect(match, line).not.toBeNull();
    expect(EVENT_NAMES).toContain(match?.[2]);
    // Oldest first.
    const at = Number(match?.[1]);
    expect(at).toBeGreaterThanOrEqual(previous);
    previous = at;
  }
});

/** The newest `frame:order` line, the bridge's trace, and whether they agree. */
async function lastTrace(page: Page): Promise<{ line: string; trace: string[]; agrees: boolean }> {
  return page.evaluate(() => {
    const text = document.querySelector('[data-testid="debug-events"]')?.textContent ?? '';
    const line = text.split('\n').filter((entry) => entry.includes('frame:order')).pop() ?? '';
    const trace = window.__reallm.trace();
    return { line, trace, agrees: line !== '' && line.endsWith(trace.join('>')) };
  });
}

test('records one frame:order per second and the dev bridge agrees (AC-54, AC-56)', async ({ page }) => {
  await start(page, '/?debug');
  const events = page.locator('[data-testid="debug-events"]');
  // A frame runs 0 to 5 fixed updates (§4.2), and a traced frame that happened
  // to be short enough for none is a legitimate `input:begin>render>…` line —
  // so wait for one that did update, which is the interesting case.
  await expect
    .poll(async () => ((await events.textContent()) ?? '').includes('frame:order input:begin>update>'), {
      timeout: 15_000,
    })
    .toBe(true);

  // The line is formatted at the next 4 Hz refresh while `trace()` is written
  // during the frame itself (§4.6.2), so the two agree from one refresh after
  // the recording until the next one is taken — poll for that window rather
  // than assuming which side of it a single read lands on.
  await expect
    .poll(async () => (await lastTrace(page)).agrees, { timeout: 10_000 })
    .toBe(true);

  const observed = await lastTrace(page);
  expect(observed.line).toMatch(/^\d+\.\d{2} frame:order input:begin>(?:update>)*render>ui:flush>input:end$/);
  expect(observed.trace[0]).toBe('input:begin');
  expect(observed.trace.slice(-3)).toEqual(['render', 'ui:flush', 'input:end']);
  expect(observed.trace.slice(1, -3).every((phase) => phase === 'update')).toBe(true);
});

test.describe('immediate refreshes', () => {
  // 0 ms fades, so `go()` resolves right after `scene:entered` and the row
  // below cannot have been updated by an ordinary 250 ms tick in between.
  test.use({ reducedMotion: 'reduce' });

  test('the rows refresh on scene:entered without waiting for the next tick (AC-33)', async ({ page }) => {
    await start(page, '/?debug');
    const row = page.locator('[data-testid="debug-scene"]');
    await expect(row).toHaveText(/^scene menu/);

    expect(await page.evaluate(() => window.__reallm.go('station', {}))).toBe(true);
    // Read once, with no retry: the refresh has to have happened already.
    expect(await row.textContent()).toMatch(/^scene station/);
  });
});

/**
 * `MenuScene.onUpdate` turns the starfield by `this.elapsed * 0.008`, and
 * `elapsed` is only ever advanced by `Scene.update(dt)` — one fixed step at a
 * time. The `spin` pair the menu reports is therefore the simulated clock in
 * radians, and dividing it by this rate reads it back in simulated seconds.
 */
const MENU_SPIN_RATE = 0.008;

/**
 * SPEC-040 §4.2 at a 30 target: `paceFrame` draws a stepped frame once its draw
 * credit reaches a period less `PACING_SLACK_MS` (`core/FrameSkip.ts`, 2 ms).
 * Outside idle the credit is never less than the time since the last draw,
 * until that time passes two periods and the credit is capped — still over
 * the bar. So a stepped frame that ends at least that long after the last
 * draw is always drawn, whatever the frames before it did. The half
 * millisecond on top keeps the sampler's sum of frame times, which is not the
 * pacer's, off the edge.
 */
const DUE_AT_30_MS = 1000 / 30 - 2 + 0.5;

/** One reading of the paced 30 fps menu, frame by frame (see the test below). */
interface PacedWindow {
  /** Seconds between the first and the last sampled frame, on the rAF clock. */
  wall: number;
  renders: number;
  /** Seconds the starfield turned through: the fixed steps that ran. */
  simulated: number;
  /** Seconds the five-step cap threw away inside the window (E23). */
  dropped: number;
  /** Frames that ran at least one fixed step. */
  stepped: number;
  /** Stepped frames that ended `DUE_AT_30_MS` or more after the last draw. */
  due: number;
  /** The due frames that were not drawn, as `+ms since draw (steps)`. */
  missed: string[];
}

/**
 * Samples `frames` of the loop's frames on the menu. The game's loop callback is
 * registered before the sampler's, so each sample reads the frame the loop has
 * just finished, and every rAF callback of a frame is handed the same
 * timestamp, so the sampler's frame times are the loop's. A frame the counter
 * did not advance by exactly one — a paused frame, or one the sampler missed —
 * forgets the last draw until the next one the sampler sees.
 */
function pacedWindow(page: Page, frames: number): Promise<PacedWindow> {
  return page.evaluate(
    ({ frames, dueMs, spinRate }) =>
      new Promise<PacedWindow>((resolve) => {
        type Stats = ReturnType<typeof window.__reallm.stats>;
        const spin = (stats: Stats): number => Number(stats.sceneInfo?.['spin'] ?? 0);
        // The window opens on the first sampled frame: its renders, spin and
        // dropped time are the baseline, not part of the reading.
        let first: Stats | null = null;
        let previous: Stats | null = null;
        let firstAt = 0;
        let lastAt = 0;
        let sinceDraw: number | null = null;
        let stepped = 0;
        let due = 0;
        const missed: string[] = [];
        const sample = (at: number): void => {
          const now = window.__reallm.stats();
          if (first === null || previous === null) {
            first = now;
            firstAt = at;
          } else if (now.frame !== previous.frame + 1) {
            sinceDraw = null;
          } else {
            const drawn = now.renders > previous.renders;
            if (sinceDraw !== null) sinceDraw += at - lastAt;
            if (now.updates > 0) {
              stepped++;
              if (sinceDraw !== null && sinceDraw >= dueMs) {
                due++;
                if (!drawn) missed.push(`+${sinceDraw.toFixed(1)}ms (${now.updates})`);
              }
            }
            if (drawn) sinceDraw = 0;
          }
          previous = now;
          lastAt = at;
          if (now.frame - first.frame < frames) {
            requestAnimationFrame(sample);
            return;
          }
          resolve({
            wall: (at - firstAt) / 1000,
            renders: now.renders - first.renders,
            simulated: (spin(now) - spin(first)) / spinRate,
            dropped: now.droppedTime - first.droppedTime,
            stepped,
            due,
            missed,
          });
        };
        requestAnimationFrame(sample);
      }),
    { frames, dueMs: DUE_AT_30_MS, spinRate: MENU_SPIN_RATE },
  );
}

// SPEC-040 §4.2 supersedes D-3's tick parity: 30 is paced by the clock. A
// 60 Hz display draws every second frame, as before; a host that cannot reach
// 60 — this container, with several browsers at once — draws every frame it
// gets, up to 30 a second, where parity would have halved it again (40-c).
//
// The lower half of that used to be counted over the whole window, as at least
// 0.8 × min(frames, 30 × seconds) draws. That holds for a steady frame rate and
// not for a bursty one, because the minimum of two sums is not the sum of the
// minima. The macOS CI runner's frames come in bursts faster than 30 a second
// between stalls of 100–250 ms (the five-step cap drops time inside the
// window): about 30 frames a second on average, while the pacer, correctly,
// draws about every second frame of a burst and one frame per stall. That read
// 41–42 draws against floors of 43–46 on about one CI job in six. So the claim
// is read frame by frame instead: every stepped frame that is due is drawn.
test('quality.targetFps 30 draws at most 30 frames a second, updates untouched (AC-57, SPEC-040 §4.2)', async ({ page }) => {
  await start(page, '/?debug&quality=low');
  expect((await page.evaluate(() => window.__reallm.stats())).preset).toBe('low');

  const { wall, renders, simulated, dropped, stepped, due, missed } = await pacedWindow(page, 90);

  expect(stepped).toBeGreaterThan(20); // the loop really ran, and was sampled
  expect(due).toBeGreaterThan(10); // and the claim below was really put to it
  expect(missed, `${due} due frames, ${renders} draws in ${wall.toFixed(2)} s`).toEqual([]);
  // At most 30 a second, give or take the one the credit carried in.
  expect(renders).toBeLessThanOrEqual(Math.ceil(wall * 30) + 1);
  // The fixed updates kept their own rate: the pacer drops draws and leaves
  // the simulation alone, so the seconds the starfield turned through are the
  // seconds the window actually lasted — minus whatever the five-step cap
  // explicitly threw away on a hitch (E23). Dropping updates along with the
  // draws, which is the regression this guards, would leave `simulated` short
  // of `wall` and fail here at any frame rate.
  expect(simulated + dropped).toBeGreaterThan(wall * 0.9);
  expect(simulated).toBeLessThan(wall * 1.05);
});

// SPEC-040 §4.2: at a 60 target every frame that ran a fixed step is drawn.
// A frame that ran none is not (40-d), and on a 60 Hz display that is no rare
// case: the frame and the fixed step share one period, so the accumulator sits
// on the step boundary and frames run 0, 1 or 2 steps in turn. Counted against
// all frames, a correct pacer drew 0.6–0.95 of them (0.81 and 0.87 on the
// macOS CI runner), so the claim is read frame by frame, off the steps each
// frame ran. The game's loop callback is registered before the sampler's, so
// each sample reads the frame the loop has just finished.
test('the other presets render every frame (AC-57)', async ({ page }) => {
  await start(page, '/?debug&quality=high');
  const { stepped, drawn } = await page.evaluate(
    (frames) =>
      new Promise<{ stepped: number; drawn: number }>((resolve) => {
        let previous = window.__reallm.stats();
        let stepped = 0;
        let drawn = 0;
        let seen = 0;
        const sample = (): void => {
          const now = window.__reallm.stats();
          if (now.frame === previous.frame + 1 && now.updates > 0) {
            stepped++;
            if (now.renders > previous.renders) drawn++;
          }
          previous = now;
          if (++seen < frames) requestAnimationFrame(sample);
          else resolve({ stepped, drawn });
        };
        requestAnimationFrame(sample);
      }),
    60,
  );

  expect(stepped).toBeGreaterThan(20); // the loop really ran, and was sampled
  // The pacer's 2 ms of slack forgives a frame a little early, not one that a
  // busy host delivers 3 ms early, so a few stepped frames may go undrawn.
  // Pacing `high` at 30, the regression this guards, leaves about half.
  expect(drawn / stepped).toBeGreaterThan(0.9);
});

test('the backtick key toggles it on desktop (AC-34)', async ({ page }) => {
  await start(page, '/?debug');
  const panel = page.locator('.overlay-debug');
  await expect(panel).toBeVisible();

  await page.keyboard.press('Backquote');
  await expect(panel).toHaveCount(0); // removed from the DOM, not just hidden

  await page.keyboard.press('Backquote');
  await expect(panel).toBeVisible();
});

test('five taps on the version label toggle it, and the counter resets (AC-35)', async ({ page }) => {
  await start(page);
  const panel = page.locator('.overlay-debug');
  const label = page.locator('[data-testid="version-label"]');
  await expect(panel).toHaveCount(0); // no ?debug and showFps is false
  await expect(label).toHaveCSS('pointer-events', 'auto');

  for (let tap = 0; tap < 5; tap++) await label.click();
  await expect(panel).toBeVisible();

  // Four taps, a pause longer than the window, then one more: no toggle.
  for (let tap = 0; tap < 4; tap++) await label.click();
  await page.waitForTimeout(2200);
  await label.click();
  await expect(panel).toBeVisible();
});

test('does no overlay work while hidden (AC-27, AC-37)', async ({ page }) => {
  await start(page);
  await expect(page.locator('.overlay-debug')).toHaveCount(0);
  await expect(page.locator('[data-testid="debug-fps"]')).toHaveCount(0);
  // The game is still running: the overlay's absence costs nothing and breaks
  // nothing.
  const stats = await page.evaluate(() => window.__reallm.stats());
  expect(stats.state).toBe('running');
});
