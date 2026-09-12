// The dev stats overlay (SPEC-002 §4.6, §6.2). Its content is a closed list —
// sixteen rows and two buttons, nothing else — because every later performance
// claim in this project is read off it. The fourteenth is SPEC-007's `persist`
// row (§7, M7); the next two are SPEC-008's seed and layout hash (§7), which is
// how "the same planet every landing" is checked. `e2e/SPEC-008.spec.ts` is
// what asserts their content; here they only have to be present and formatted.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

/** The rows of §4.6.1, in order, with the text format each one must match. */
const ROWS: ReadonlyArray<readonly [string, RegExp]> = [
  ['debug-fps', /^fps \d+$/],
  ['debug-frame-ms', /^ms \d+\.\d$/],
  ['debug-updates', /^upd [0-5]$/],
  ['debug-dropped', /^dropped \d+\.\d{2}s$/],
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

test('holds exactly the sixteen rows and the two buttons, in order (AC-27 … AC-30)', async ({ page }) => {
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
 * `loop.stats.frame`, the current scene's own render count, the simulated
 * clock and the wall clock, all read in one evaluate so they belong to the
 * same instant.
 */
async function frameAndRenders(
  page: Page,
): Promise<{ frame: number; renders: number; simulated: number; dropped: number; now: number }> {
  return page.evaluate(() => {
    const stats = window.__reallm.stats();
    return {
      frame: stats.frame,
      renders: Number(stats.sceneInfo?.['renders'] ?? 0),
      simulated: Number(stats.sceneInfo?.['spin'] ?? 0),
      dropped: stats.droppedTime,
      now: performance.now(),
    };
  });
}

/**
 * Wait until the loop has advanced past `frames` animation frames, and answer
 * the reading that spans them: how many frames and renders it took, how far
 * the simulation advanced inside it, and how long it lasted on the wall clock.
 *
 * The sample used to be a flat second, which assumed a ~60 Hz frame. Neither
 * preset can hold one here: SPEC-017 put a post-processing chain behind
 * `Renderer.render()` and this container has no GPU, so `high`'s sixteen
 * full-screen passes at 720p cost the software rasteriser ~110 ms a frame, and
 * `low` — which takes the direct path — still drops to ~20 Hz whenever the
 * suite runs several browsers at once. Neither claim below is about the frame
 * *rate*: one is a ratio of renders to frames, the other a ratio of simulated
 * to real time. So the window is counted in frames and both are measured over
 * it, whatever rate the host manages.
 */
async function overFrames(
  page: Page,
  frames: number,
): Promise<{ frames: number; renders: number; simulated: number; dropped: number; wall: number }> {
  const before = await frameAndRenders(page);
  await expect
    .poll(async () => (await frameAndRenders(page)).frame - before.frame, { timeout: 30_000 })
    .toBeGreaterThan(frames);
  const after = await frameAndRenders(page);
  return {
    frames: after.frame - before.frame,
    renders: after.renders - before.renders,
    simulated: (after.simulated - before.simulated) / MENU_SPIN_RATE,
    dropped: after.dropped - before.dropped,
    wall: (after.now - before.now) / 1000,
  };
}

test('quality.targetFps 30 skips every second render, updates untouched (AC-57)', async ({ page }) => {
  await start(page, '/?debug&quality=low');
  expect((await page.evaluate(() => window.__reallm.stats())).preset).toBe('low');

  const { frames, renders, simulated, dropped, wall } = await overFrames(page, 40);

  expect(frames).toBeGreaterThan(20); // the loop really ran
  expect(renders / frames).toBeGreaterThan(0.4);
  expect(renders / frames).toBeLessThan(0.6);
  // The fixed updates kept their own rate: the render skip halves the draws
  // and leaves the simulation alone, so the seconds the starfield turned
  // through are the seconds the window actually lasted — minus whatever the
  // five-step cap explicitly threw away on a hitch (E23). Halving the updates
  // along with the renders, which is the regression this guards, would leave
  // `simulated` at half of `wall` and fail here at any frame rate.
  expect(simulated + dropped).toBeGreaterThan(wall * 0.9);
  expect(simulated).toBeLessThan(wall * 1.05);
});

test('the other presets render every frame (AC-57)', async ({ page }) => {
  await start(page, '/?debug&quality=high');
  const { frames, renders } = await overFrames(page, 20);

  expect(frames).toBeGreaterThan(20);
  expect(renders / frames).toBeGreaterThan(0.9);
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
