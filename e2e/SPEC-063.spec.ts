// SPEC-063 §6.3 — who flies them, in a real browser: "Wreckers" after
// "Outbound" on the first departure to Vetra, each film with its own Skip;
// the contact card and the comms line on the first scav fighter group, over a
// flight that never stops; nothing on a later trip; the interceptors' contact
// on the first flight to the Hive; and, with films off, the line without the
// card.
//
// Save setup follows `e2e/SPEC-023.spec.ts`: a fresh slot-0 save with flags
// pushed onto `progress.flags`, films opted into with `films=on` and the MP4s
// aborted, so every film runs in the deterministic stills mode. The star map
// is entered straight from the save, so no station beat (an interlude, a
// letter) plays in front of the departure. The trip is warped through the
// dev flight hook (SPEC-013), which steps the real simulation at 1/60 s.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

test.use({ reducedMotion: 'no-preference' });

const FILM = '[data-testid="film"]';
const CHAPTER_CARD = '[data-testid="chapter-card"]';
const CONTACT_CARD = '[data-testid="contact-card"]';
const MP4S = '**/assets/films/*.mp4';

const CREATION = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** §4.3, word for word. */
const SCAV_EPITHET = 'A tug, rebuilt to take tugs';
const HIVE_EPITHET = 'Grown, not flown';
const SCAV_LINE = 'Tug, drop your hold and turn for home. Nobody has to burn today.';
const ARIA_SCAV_LINE = 'Scav fighters. The crews you met on Cinder-4, in tugs they stripped. They want the hold. Shoot back.';
const ARIA_HIVE_LINE = 'Nobody is flying those. The Hive grows them, and they ram. Keep them off the nose.';

interface FlightHook {
  phase(): string;
  state(): { progress: number; hostiles: number };
  warp(seconds: number): void;
}

declare global {
  interface Window {
    /** Every text the dialogue layer's line has shown, armed before the game boots. */
    __spec063Lines?: string[];
  }
}

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

/** `sceneInfo.contacts`, comma-separated in the debug row, as the list it is. */
const contacts = async (page: Page): Promise<string[]> =>
  String((await info(page))['contacts'] ?? '')
    .split(',')
    .filter((id) => id !== '');

/** True once a line the dialogue layer typed reads `text` whole. */
const lineShown = (page: Page, text: string): Promise<boolean> =>
  page.evaluate((line) => (window.__spec063Lines ?? []).some((seen) => seen.includes(line)), text);

/** As SPEC-023's: the scene is on screen and its transition has settled. */
async function settled(page: Page, scene: string): Promise<void> {
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText(scene);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
}

interface Setup {
  url?: string;
  flags: string[];
  visits?: Record<string, number>;
  reduceMotion?: boolean;
}

/**
 * A fresh slot-0 save with `flags`, the oil for any jump, mouse steer off (so
 * the steer keys drive the ship whatever the pointer did) and the dialogue
 * recorder armed — then the star map, entered straight from the save.
 */
async function newSaveAtStarmap(page: Page, setup: Setup): Promise<void> {
  await page.route(MP4S, (route) => route.abort());
  await page.addInitScript((reduceMotion) => {
    const settings: Record<string, unknown> = { version: 1, flightMouseSteer: false };
    if (reduceMotion) settings['reduceMotion'] = true;
    localStorage.setItem('reallm:settings', JSON.stringify(settings));
    const seen: string[] = [];
    window.__spec063Lines = seen;
    new MutationObserver(() => {
      const text = document.querySelector('[data-testid="dialogue"] .dialogue-text')?.textContent ?? '';
      if (text !== '' && seen[seen.length - 1] !== text) seen.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, setup.reduceMotion === true);
  await start(page, setup.url ?? '/?films=on&seed=123');
  await page.evaluate(
    ({ creation, flags, visits }) => {
      const save = window.__reallm.save().create(0, creation, 123);
      save.resources['oil'] = 400;
      save.progress.flags.push(...flags);
      Object.assign(save.progress.visits, visits);
    },
    { creation: CREATION, flags: setup.flags, visits: setup.visits ?? {} },
  );
  await page.evaluate(() => window.__reallm.go('starmap', undefined, { force: true }));
  await settled(page, 'starmap');
}

/** Select `planet` on the map, Depart, confirm — the fuel is paid. */
async function depart(page: Page, planet: string): Promise<void> {
  await page.locator(`[data-testid="map-node-${planet}"]`).click();
  await page.locator('[data-testid="starmap-depart"]').click();
  await page.locator('[data-testid="confirm-yes"]').click();
}

/** Waits for `id` to be the film on screen, then skips it past the pointer grace (SPEC-022 §4.5). */
async function skipFilm(page: Page, id: string): Promise<void> {
  const film = page.locator(FILM);
  await expect(film).toHaveAttribute('data-film', id, { timeout: 15_000 });
  await page.waitForTimeout(500);
  await page.locator('[data-testid="film-skip"]').click();
}

interface Warped {
  hostiles: number;
  chapterUp: boolean;
  contactUp: boolean;
}

/** `warp(5)` until the first group is in the sky (§6.3 case 2), and what was up at that moment. */
async function warpToFirstGroup(page: Page): Promise<Warped> {
  await page.waitForFunction(() => (window as unknown as { __reallmFlight?: unknown }).__reallmFlight !== undefined);
  return page.evaluate(() => {
    const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
    for (let i = 0; i < 60 && hook.state().hostiles === 0; i++) hook.warp(5);
    return {
      hostiles: hook.state().hostiles,
      chapterUp: document.querySelector('[data-testid="chapter-card"]') !== null,
      contactUp: document.querySelector('[data-testid="contact-card"]') !== null,
    };
  });
}

interface CardAtMount {
  enemy: string | null;
  texts: string[];
  chapterUp: boolean;
}

/** Watched every frame: the contact card's first frame on screen, and whether the chapter card was still up then. */
async function contactCardMounts(page: Page): Promise<CardAtMount> {
  const handle = await page.waitForFunction(
    () => {
      const card = document.querySelector('[data-testid="contact-card"]');
      if (card === null) return null;
      return {
        enemy: card.getAttribute('data-enemy'),
        texts: [...card.querySelectorAll('p')].map((p) => p.textContent ?? ''),
        chapterUp: document.querySelector('[data-testid="chapter-card"]') !== null,
      };
    },
    null,
    { polling: 'raf', timeout: 20_000 },
  );
  return (await handle.jsonValue()) as CardAtMount;
}

test('1 & 2 — the first departure to Vetra plays Outbound then Wreckers, and the first fighters make contact', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await newSaveAtStarmap(page, { flags: ['chapter1_done'] });
  await depart(page, 'vetra');

  // §4.4: "Outbound", skipped — and "Wreckers" starts, with a Skip of its own (63-a).
  await skipFilm(page, 'departure');
  await expect(page.locator(FILM)).toHaveAttribute('data-film', 'wreckers', { timeout: 15_000 });
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('starmap');
  await skipFilm(page, 'wreckers');
  await expect(page.locator(FILM)).toHaveCount(0);
  await settled(page, 'flight');

  // §6.3 case 2: warp to the first group; the chapter card is still up over the
  // launch, so the contact card waits for it (E111).
  const warped = await warpToFirstGroup(page);
  expect(warped.hostiles).toBeGreaterThan(0);
  expect(warped.contactUp).toBe(false);
  const card = await contactCardMounts(page);
  expect(card).toEqual({ enemy: 'scav_fighter', texts: ['CONTACT', 'SCAV FIGHTER', SCAV_EPITHET], chapterUp: false });

  // §4.5, no hold: over a second of real time with the card up, the trip
  // advances, and the steer keys still move the ship.
  await page.keyboard.down('KeyD');
  let held: { before: { progress: number; x: number }; after: { progress: number; x: number }; cardUp: boolean };
  try {
    held = await page.evaluate(async () => {
      const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
      const read = (): { progress: number; x: number } => ({
        progress: hook.state().progress,
        x: Number(window.__reallm.stats().sceneInfo?.['shipX']),
      });
      const before = read();
      await new Promise((done) => setTimeout(done, 1000));
      return { before, after: read(), cardUp: document.querySelector('[data-testid="contact-card"]') !== null };
    });
  } finally {
    await page.keyboard.up('KeyD');
  }
  expect(held.cardUp).toBe(true);
  expect(held.after.progress).toBeGreaterThan(held.before.progress);
  expect(held.after.x).toBeGreaterThan(held.before.x);
  expect(await page.evaluate(() => window.__reallm.stats().state)).toBe('running');

  // §4.5: the scav's line and ARIA's, non-modal through the shared layer.
  await expect.poll(() => lineShown(page, SCAV_LINE), { timeout: 20_000 }).toBe(true);
  await expect(page.locator('[data-testid="dialogue"]')).not.toHaveClass(/is-modal/);
  await expect.poll(() => lineShown(page, ARIA_SCAV_LINE), { timeout: 30_000 }).toBe(true);
  expect(await contacts(page)).toEqual(['scav_fighter']);

  // The card lives CONTACT.show + CONTACT.fade, then removes itself.
  await expect(page.locator(CONTACT_CARD)).toHaveCount(0, { timeout: 10_000 });
  // 63-c: a later group of the same trip never shows another card. Vetra has
  // one group, so the session key is what holds it: the card is gone for good.
  await page.waitForTimeout(500);
  await expect(page.locator(CONTACT_CARD)).toHaveCount(0);
});

test('3 — a later trip to Vetra plays neither film, and its fighters make no contact', async ({ page }) => {
  test.setTimeout(120_000);
  await newSaveAtStarmap(page, { flags: ['chapter1_done'], visits: { vetra: 1 } });
  await depart(page, 'vetra');

  await settled(page, 'flight');
  await expect(page.locator(FILM)).toHaveCount(0);
  const warped = await warpToFirstGroup(page);
  expect(warped.hostiles).toBeGreaterThan(0);
  // Past the chapter card's window and a card's whole life: nothing was scheduled.
  await page.waitForTimeout(1_500);
  await expect(page.locator(CONTACT_CARD)).toHaveCount(0);
  await expect(page.locator(CHAPTER_CARD)).toHaveCount(0);
  expect(await contacts(page)).toEqual([]);
  expect(await lineShown(page, SCAV_LINE)).toBe(false);
});

test('4 — the first flight to the Hive: Outbound alone, then the interceptors’ contact', async ({ page }) => {
  test.setTimeout(150_000);
  await newSaveAtStarmap(page, { flags: ['chapter4_done'] });
  await depart(page, 'hive');

  // §4.4: the Hive's contact has no film, so "Outbound" is the whole departure.
  await skipFilm(page, 'departure');
  await expect(page.locator(FILM)).toHaveCount(0);
  await settled(page, 'flight');
  await expect(page.locator(FILM)).toHaveCount(0);

  const warped = await warpToFirstGroup(page);
  expect(warped.hostiles).toBeGreaterThan(0);
  const card = await contactCardMounts(page);
  expect(card).toEqual({ enemy: 'hive_interceptor', texts: ['CONTACT', 'HIVE INTERCEPTOR', HIVE_EPITHET], chapterUp: false });
  await expect.poll(() => lineShown(page, ARIA_HIVE_LINE), { timeout: 20_000 }).toBe(true);
  expect(await contacts(page)).toEqual(['hive_interceptor']);

  // The later groups of the same trip stay quiet (E110, 63-c).
  await expect(page.locator(CONTACT_CARD)).toHaveCount(0, { timeout: 10_000 });
  await page.evaluate(() => {
    const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
    for (let i = 0; i < 6 && hook.phase() !== 'arrived' && hook.phase() !== 'recalled'; i++) hook.warp(5);
  });
  await page.waitForTimeout(500);
  await expect(page.locator(CONTACT_CARD)).toHaveCount(0);
  expect(await contacts(page)).toEqual(['hive_interceptor']);
});

test('5 — films off: no film and no card, but the fighters’ contact still fires and ARIA still speaks (E109)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // `gameUrl` appends `films=off` to a URL that names no `films=`.
  await newSaveAtStarmap(page, { url: '/?seed=123', flags: ['chapter1_done'] });
  await depart(page, 'vetra');

  await settled(page, 'flight');
  await expect(page.locator(FILM)).toHaveCount(0);
  const warped = await warpToFirstGroup(page);
  expect(warped.hostiles).toBeGreaterThan(0);
  expect(await contacts(page)).toEqual(['scav_fighter']);
  await expect.poll(() => lineShown(page, ARIA_SCAV_LINE), { timeout: 30_000 }).toBe(true);
  await expect(page.locator(CONTACT_CARD)).toHaveCount(0);
  await expect(page.locator(FILM)).toHaveCount(0);
});

test.describe('6 — reduce motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the card cuts in and out, with no fade', async ({ page }) => {
    test.setTimeout(150_000);
    await newSaveAtStarmap(page, { flags: ['chapter1_done'], reduceMotion: true });
    await depart(page, 'vetra');
    await skipFilm(page, 'departure');
    await skipFilm(page, 'wreckers');
    await settled(page, 'flight');

    await warpToFirstGroup(page);
    const card = await contactCardMounts(page);
    expect(card.enemy).toBe('scav_fighter');
    const look = await page.locator(CONTACT_CARD).evaluate((node) => ({
      static: node.classList.contains('is-static'),
      opacity: getComputedStyle(node).opacity,
      transition: getComputedStyle(node).transitionDuration,
    }));
    expect(look).toEqual({ static: true, opacity: '1', transition: '0s' });
    await expect(page.locator(CONTACT_CARD)).toHaveCount(0, { timeout: 10_000 });
  });
});
