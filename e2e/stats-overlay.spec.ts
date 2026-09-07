// The dev stats overlay (SPEC-002 §4.6, §6.2). Its content is a closed list —
// thirteen rows and two buttons, nothing else — because every later performance
// claim in this project is read off it.
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

test('holds exactly the thirteen rows and the two buttons, in order (AC-27 … AC-30)', async ({ page }) => {
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

test('records one frame:order per second and the dev bridge agrees (AC-54, AC-56)', async ({ page }) => {
  await start(page, '/?debug');
  const events = page.locator('[data-testid="debug-events"]');
  await expect(events).toHaveText(/frame:order/, { timeout: 5000 });

  const observed = await page.evaluate(() => {
    const text = document.querySelector('[data-testid="debug-events"]')?.textContent ?? '';
    const line = text.split('\n').filter((entry) => entry.includes('frame:order')).pop() ?? '';
    return { line, trace: window.__reallm.trace() };
  });

  expect(observed.line).toMatch(/^\d+\.\d{2} frame:order input:begin>(?:update>)+render>ui:flush>input:end$/);
  expect(observed.trace[0]).toBe('input:begin');
  expect(observed.trace.slice(-3)).toEqual(['render', 'ui:flush', 'input:end']);
  expect(observed.trace.slice(1, -3).every((phase) => phase === 'update')).toBe(true);
  expect(observed.line.endsWith(observed.trace.join('>'))).toBe(true);
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
