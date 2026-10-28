// SPEC-076 §6.2 (PLAN R33): the story pass in a real browser — the station's
// level reads the fiction's "Threat level" until the notice and tears into
// "Containment level" once after it, letter 3's "Write back." gets an answer,
// a tow has ARIA's word on it, and the first salvage signal and the nav limit
// each get one line a save. The text rules are pinned in node
// (`tests/data/content.test.ts`); this proves the wiring.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, frames, start } from './start';

const CREATION = {
  name: 'Vega',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const URL = '/?debug&seed=123';

interface FlightHook {
  warp(seconds: number): void;
  clearSky(): void;
  park(x: number, y: number): void;
}

/** A fresh slot-0 save named Vega, bound, holding `flags`. */
async function prepare(page: Page, flags: readonly string[] = []): Promise<void> {
  await page.evaluate(
    ({ creation, flags }) => {
      const bridge = window.__reallm.save();
      bridge.create(0, creation, 123);
      bridge.current?.progress.flags.push(...(flags as string[]));
    },
    { creation: CREATION, flags },
  );
}

async function station(page: Page, params: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate((p) => window.__reallm.go('station', p, { force: true }), params);
  await expect(page.getByTestId('scene-label')).toHaveText('station', COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
}

const flags = (page: Page): Promise<string[]> => page.evaluate(() => [...(window.__reallm.save().current?.progress.flags ?? [])]);
const text = (page: Page) => page.locator('[data-testid="dialogue"] .dialogue-text');
const level = (page: Page) => page.getByTestId('containment-level');

async function enter(page: Page): Promise<void> {
  await page.waitForTimeout(350);
  await page.keyboard.press('Enter');
}

/** The labels the header shows, in order: recorded from before the entry by a MutationObserver. */
async function watchLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __labels: string[] }).__labels = seen;
    const note = (): void => {
      const text = document.querySelector('[data-testid="containment-level"]')?.textContent ?? null;
      if (text !== null && seen.at(-1) !== text) seen.push(text);
    };
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

const labels = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __labels: string[] }).__labels);

// The chapters a notice comes after, read and answered: a quiet station entry
// at level 3 (Ferrum waits on a rated shield, so Thessaly is the highest open).
const AFTER_THE_NOTICE = [
  'chapter1_done',
  'chapter2_done',
  'chapter3_done',
  'letter1_read',
  'letter2_read',
  'letter3_read',
  'reply_none',
  'clue_awake',
  'memory_roof',
  'signal_decoded',
] as const;

// ---------------------------------------------------------------- 1: the label

test.describe('1. the level’s name (P-01, §4.1)', () => {
  test('reads "Threat level" before the notice, tears into "Containment level" once after it, and stays', async ({ page }) => {
    await start(page, URL);
    await prepare(page, ['chapter1_done']);
    await station(page);
    await expect(level(page)).toHaveText('Threat level 2');

    await prepare(page, AFTER_THE_NOTICE);
    await watchLabels(page);
    await station(page);
    await expect(level(page)).toHaveText('Containment level 3', { timeout: 5_000 });
    await expect(level(page)).toHaveClass(/is-torn/);
    // The level-2 header of the entry before may still be up as the observer starts.
    expect((await labels(page)).filter((label) => label.endsWith(' 3'))).toEqual(['Threat level 3', 'Containment level 3']);
    expect(await flags(page)).toContain('containment_named');

    // Torn once: the next entry opens on the Warden's word, with no tear.
    await watchLabels(page);
    await station(page);
    await expect(level(page)).toHaveText('Containment level 3');
    await expect(level(page)).not.toHaveClass(/is-torn/);
    expect(await labels(page)).toEqual(['Containment level 3']);
  });

  test.describe('under reduce motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('changes the words at once, with no tear', async ({ page }) => {
      await start(page, URL);
      await prepare(page, AFTER_THE_NOTICE);
      await station(page);
      await expect(level(page)).toHaveText('Containment level 3');
      await expect(level(page)).not.toHaveClass(/is-torn/);
      expect(await flags(page)).toContain('containment_named');
    });
  });
});

// ---------------------------------------------------------- 2: write back

test.describe('2. Write back (S-11, §4.2)', () => {
  // Lines land whole (typewriter off), so each press advances one.
  test.use({ reducedMotion: 'reduce' });

  test('letter 3 ends in a choice; the answer is the reply, ARIA queues it, and it is not asked again', async ({ page }) => {
    await start(page, URL);
    await prepare(page, ['chapter1_done', 'chapter2_done', 'chapter3_done', 'letter1_read', 'letter2_read']);
    await station(page);
    for (const line of [
      'Grain! Actual grain. The grow room smells like summer and nobody knows what to do with their hands.',
      'Everyone in Block D asks about you. I tell them you’re the one who never writes back.',
      'Write back.',
    ]) {
      await expect(text(page)).toHaveText(line);
      await enter(page);
    }
    await expect(text(page)).toHaveText('Iris asked you to write back. What do you send?');
    await expect(page.getByTestId('dialogue-choice-0')).toHaveText('1. Tell her about the wurm.');
    await expect(page.getByTestId('dialogue-choice-1')).toHaveText('2. Tell her I am coming home.');
    await expect(page.getByTestId('dialogue-choice-2')).toHaveText('3. Say nothing.');
    await page.getByTestId('dialogue-choice-1').click();
    await expect(text(page)).toHaveText('Queued for the next relay drop. It goes home with the grain.');
    const answered = await flags(page);
    expect(answered).toContain('reply_home');
    expect(answered).not.toContain('reply_wurm');
    expect(answered).not.toContain('reply_none');
    // Then the aside chapter 3 owes, as before.
    await enter(page);
    await expect(text(page)).toContainText('Mission clock:');
    for (let i = 0; i < 6 && (await page.getByTestId('dialogue').isVisible()); i++) await enter(page);

    await station(page);
    await page.waitForTimeout(600);
    await expect(page.getByTestId('dialogue-choice-0')).toHaveCount(0);
  });

  test('a quit before the answer asks again at the next entry, without the letter', async ({ page }) => {
    await start(page, URL);
    await prepare(page, ['chapter1_done', 'chapter2_done', 'chapter3_done', 'letter1_read', 'letter2_read', 'letter3_read', 'clue_awake']);
    await station(page);
    await expect(text(page)).toHaveText('Iris asked you to write back. What do you send?');
    await page.getByTestId('dialogue-choice-2').click();
    await expect(text(page)).toHaveText('I will mark it read.');
    expect(await flags(page)).toContain('reply_none');
  });
});

// ---------------------------------------------------------------- 3: the tow

test.describe('3. a tow has ARIA’s word on it (ST-03, §4.3)', () => {
  test.use({ reducedMotion: 'reduce' });

  test('before the notice a doubt with its cover, after it what it was', async ({ page }) => {
    await start(page, URL);
    await prepare(page, ['chapter1_done']);
    await station(page, { arrivedFrom: 'vetra', recalled: true, towed: true });
    await expect(page.getByTestId('recall-banner')).toHaveText('Towed home');
    await expect(page.getByTestId('dialogue')).toContainText('Relay pulled us back on a line I did not know we had.', { timeout: 10_000 });

    await prepare(page, AFTER_THE_NOTICE);
    await station(page, { arrivedFrom: 'vetra', recalled: true, towed: true });
    await expect(page.getByTestId('dialogue')).toContainText('That was not a tow. Nothing pulled us.', { timeout: 10_000 });
  });
});

// -------------------------------------------------------- 4: the flight lines

test.describe('4. ARIA in flight (ST-06, §4.5)', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the nav limit gets its line once a save, and the first salvage signal gets one too', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off', flightMouseSteer: false })));
    await start(page, '/?debug&seed=123&films=off');
    // A bound save, so the flags the trip sets are the ones read back.
    await prepare(page, ['chapter1_done']);
    await page.evaluate(() => window.__reallm.go('flight', { destination: 'vetra' }, { force: true }));
    await expect(page.getByTestId('scene-label')).toHaveText('flight', COLD_START);
    await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
    await page.evaluate(() => {
      const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
      hook.warp(3.1);
      hook.clearSky();
      hook.park(220, 0);
    });
    await frames(page, 3);
    await expect(page.getByTestId('dialogue')).toContainText('That is the edge of the map. Past it there is nothing I can plot.', { timeout: 10_000 });
    await expect.poll(() => flags(page)).toContain('aria_nav_limit');

    // On through the first signal: one line, and its flag.
    await page.evaluate(() => {
      const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
      hook.park(0, 0);
      hook.warp(25);
      hook.clearSky();
    });
    await expect.poll(() => flags(page), { timeout: 15_000 }).toContain('aria_signals');
  });
});
