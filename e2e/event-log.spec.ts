// The `?debug` console logger of SPEC-004 §4.6 (AC-29). One `onAny`
// subscription registered by `Game`, writing `log.debug('events', name,
// payload)`, so a developer can watch the bus without touching a system.
//
// This is deliberately *not* the stats overlay's event log: that one is the
// bounded twelve-line display of SPEC-002 §4.6.2 and gains no names from this
// (D-4). `e2e/stats-overlay.spec.ts` pins it and stays untouched.
import { expect, test, type ConsoleMessage } from '@playwright/test';
import { setHidden, start } from './start';

/** The `[events]` debug lines the log tag of `core/Log.ts` produces. */
function collectEventLines(messages: ConsoleMessage[]): string[] {
  return messages.filter((m) => m.type() === 'debug' && m.text().startsWith('[events]')).map((m) => m.text());
}

test('?debug writes every emitted event to the console (AC-29a)', async ({ page }) => {
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => void messages.push(message));

  await start(page, '/?debug');
  await page.evaluate(() => window.__reallm.go('station', {}));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');

  // A `void` payload from a different emitter, to show it is every event and
  // not just the scene machine's.
  await setHidden(page, true);

  const lines = collectEventLines(messages);
  expect(lines.some((line) => line.startsWith('[events] scene:transition'))).toBe(true);
  // …with its payload after the name.
  expect(lines.some((line) => line.includes('scene:entered') && line.includes('station'))).toBe(true);
  expect(lines.some((line) => line.startsWith('[events] app:paused'))).toBe(true);
});

test('without ?debug nothing subscribes (AC-29c)', async ({ page }) => {
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => void messages.push(message));

  await start(page);
  await page.evaluate(() => window.__reallm.go('station', {}));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');

  expect(collectEventLines(messages)).toEqual([]);
});
