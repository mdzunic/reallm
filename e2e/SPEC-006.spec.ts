// The audio layer in a real browser (SPEC-006). The mixing maths, the voice
// limiter and the reactions table are unit-tested in node
// (`tests/core/audioReactions.test.ts`, §8); what only a browser can show is
// the part that touches an AudioContext — the unlock boundary, the buses
// reaching `localStorage`, and what a bank that will not decode does to
// `play()`.
//
// The CC0 sound files are out of SPEC-006's scope, so nothing under
// `public/assets/audio/` exists yet and every bank ends in the 06-e failure
// path. That is why the decode-failure case (AC-60) is the one this suite can
// pin hardest, and why AC-9 is asserted on the first call — the one that starts
// the load — rather than on a bank that has already given up. §9's device
// acceptance is what covers audible playback.
import { expect, test } from '@playwright/test';
import { awaitGate, passGate, start } from './start';

const SETTINGS_KEY = 'reallm:settings';

/** The `[audio]` warnings `core/Log.ts` writes, in arrival order. */
function audioWarnings(messages: string[]): string[] {
  return messages.filter((text) => text.startsWith('[audio]'));
}

test('play() before the gate returns null and unlocked is false (AC-6)', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  await page.goto('/');
  await awaitGate(page);

  // The bridge exists from module load, so the pre-gesture state is reachable.
  const before = await page.evaluate(() => ({
    unlocked: window.__reallm.audio().unlocked,
    voice: window.__reallm.audio().play('ui_blip'),
  }));
  expect(before.unlocked).toBe(false);
  expect(before.voice).toBeNull();

  // AC-26: a track asked for before the gesture is remembered, not played, and
  // asking again for the same one is still a no-op.
  await page.evaluate(() => {
    window.__reallm.audio().music('menu');
    window.__reallm.audio().music('menu');
  });
  expect(crashes).toEqual([]);
});

test('the boot tap unlocks, and audio:unlocked is emitted exactly once (AC-7, AC-8)', async ({ page }) => {
  const events: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'debug') events.push(message.text());
  });

  await page.goto('/?debug');
  await passGate(page);
  await expect(page.locator('[data-testid="scene-label"]')).toBeVisible();

  expect(await page.evaluate(() => window.__reallm.audio().unlocked)).toBe(true);
  // A second unlock cannot emit again: `unlocked` already reads true (AC-8).
  expect(events.filter((text) => text.startsWith('[events] audio:unlocked'))).toHaveLength(1);
});

test('after unlock the first play returns a Voice, and a dead bank then returns null with one warning (AC-9, AC-60)', async ({
  page,
}) => {
  const messages: string[] = [];
  page.on('console', (message) => messages.push(message.text()));
  await start(page);

  // AC-9: the first call is what builds the bank and starts its load; Howler
  // queues the play and hands back a sound, so there is a Voice to return.
  expect(await page.evaluate(() => window.__reallm.audio().play('ui_blip') !== null)).toBe(true);

  // 06-e: neither source decodes here, so the bank gives up and says so once.
  await expect
    .poll(() => audioWarnings(messages).filter((text) => text.includes('"ui" sound bank')).length)
    .toBe(1);

  // AC-60: every later call is refused, and the warning is not repeated.
  const refusals = await page.evaluate(() => {
    const audio = window.__reallm.audio();
    return [0, 1, 2, 3, 4].map(() => audio.play('ui_blip'));
  });
  expect(refusals).toEqual([null, null, null, null, null]);
  expect(audioWarnings(messages).filter((text) => text.includes('"ui" sound bank'))).toHaveLength(1);
});

test('setBus clamps, ignores NaN, persists and is read back on the next boot (AC-14, AC-16, AC-18)', async ({
  page,
}) => {
  await start(page);

  const stored = await page.evaluate(() => {
    const audio = window.__reallm.audio();
    audio.setBus('music', 0.25);
    audio.setBus('master', 4); // clamped to 1
    audio.setBus('sfx', Number.NaN); // ignored outright
    return JSON.parse(localStorage.getItem('reallm:settings') ?? '{}') as Record<string, unknown>;
  });
  expect(stored['music']).toBe(0.25);
  expect(stored['master']).toBe(1);
  // AC-18: the refused write never reached storage…
  expect(stored['sfx']).toBeUndefined();
  // …and AC-14: the merge-write kept what the other stores had put there.
  expect(stored['version']).toBe(1);

  // AC-16: re-read at construction, so the values survive a reload.
  await start(page);
  const reloaded = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>,
    SETTINGS_KEY,
  );
  expect(reloaded['music']).toBe(0.25);
  expect(reloaded['master']).toBe(1);
});

test('the whole layer survives a scene cycle, a duck and a teardown without throwing (AC-13, AC-54, AC-59)', async ({
  page,
}) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));
  await start(page);

  // AC-28: the menu warms both tracks it can move to; resolving is the whole
  // contract, since neither of them can actually load here (AC-27).
  await page.evaluate(() => window.__reallm.audio().preloadMusic(['menu', 'station']));

  // The pause menu's duck, and the surface listener a positioned sound needs.
  await page.evaluate(() => window.__reallm.go('station', {}));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  await page.evaluate(() => {
    const audio = window.__reallm.audio();
    audio.setListener(10, 10);
    audio.duck(true);
    audio.duck(false);
    // AC-35: 60 m from the listener is past the 45 m cut-off.
    audio.play('bug_pop', { x: 70, z: 10 });
  });

  // AC-59: `stop()` disposes the audio layer, and a second one is a no-op.
  await page.evaluate(() => {
    window.__reallm.stop();
    window.__reallm.stop();
  });
  expect(crashes).toEqual([]);
});
