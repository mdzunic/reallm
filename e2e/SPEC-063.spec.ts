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
//
// What the card did is recorded in the page, by a mutation observer armed
// before the game boots: the moment it mounted, what it read and looked like
// then, whether the chapter card was still up, and when it began to fade and
// was removed. A round trip from here can take longer than the card lives on
// a loaded GPU-less host, so nothing about its timing is read from outside.
// Once the first group has made contact the page keeps the sky clear, so the
// idle ship is neither shot down nor holed by a rock — a recall clears the
// dialogue queue — before the lines have played; the contact has fired by
// then, and the trip runs on underneath.
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
  clearSky(): void;
}

/** One contact card's life, as the page saw it (performance.now() ms). */
interface CardRecord {
  enemy: string | null;
  texts: string[];
  /** The chapter card was still in the page when this card mounted (E111). */
  chapterUp: boolean;
  isStatic: boolean;
  /** The computed `transition-duration` at mount. */
  transition: string;
  at: number;
  /** When `is-visible` came off — the fade out began. */
  fadeAt: number | null;
  goneAt: number | null;
}

declare global {
  interface Window {
    /** Every text the dialogue layer's line has shown, armed before the game boots. */
    __spec063Lines?: string[];
    __spec063Cards?: Array<CardRecord & { node: Element; seenVisible: boolean }>;
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

/** Every contact card the page has mounted, in order. */
const cards = (page: Page): Promise<CardRecord[]> =>
  page.evaluate(() => (window.__spec063Cards ?? []).map(({ node: _node, seenVisible: _seen, ...record }) => record));

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
 * the steer keys drive the ship whatever the pointer did), typed text off (a
 * line lands whole — on a loaded host the typing interval starves, and which
 * lines play is what is under test) and the recorder armed — then the star
 * map, entered straight from the save.
 */
async function newSaveAtStarmap(page: Page, setup: Setup): Promise<void> {
  await page.route(MP4S, (route) => route.abort());
  await page.addInitScript((reduceMotion) => {
    const settings: Record<string, unknown> = { version: 1, flightMouseSteer: false, typewriter: false };
    if (reduceMotion) settings['reduceMotion'] = true;
    localStorage.setItem('reallm:settings', JSON.stringify(settings));
    const seen: string[] = [];
    window.__spec063Lines = seen;
    const cards: NonNullable<typeof window.__spec063Cards> = [];
    window.__spec063Cards = cards;
    new MutationObserver((records) => {
      const now = performance.now();
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement) || !node.matches('[data-testid="contact-card"]')) continue;
            cards.push({
              node,
              seenVisible: node.classList.contains('is-visible'),
              enemy: node.getAttribute('data-enemy'),
              texts: [...node.querySelectorAll('p')].map((p) => p.textContent ?? ''),
              chapterUp: document.querySelector('[data-testid="chapter-card"]') !== null,
              isStatic: node.classList.contains('is-static'),
              transition: getComputedStyle(node).transitionDuration,
              at: now,
              fadeAt: null,
              goneAt: null,
            });
          }
          for (const node of record.removedNodes) {
            const card = cards.find((entry) => entry.node === node);
            if (card !== undefined && card.goneAt === null) card.goneAt = now;
          }
        } else if (record.type === 'attributes') {
          const card = cards.find((entry) => entry.node === record.target);
          if (card === undefined) continue;
          const visible = card.node.classList.contains('is-visible');
          if (visible) card.seenVisible = true;
          else if (card.seenVisible && card.fadeAt === null) card.fadeAt = now;
        }
      }
      const text = document.querySelector('[data-testid="dialogue"] .dialogue-text')?.textContent ?? '';
      if (text !== '' && seen[seen.length - 1] !== text) seen.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
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

/** Waits for the page's first contact card to have mounted, and returns its record. */
async function firstCard(page: Page): Promise<CardRecord> {
  await page.waitForFunction(() => (window.__spec063Cards ?? []).length > 0, null, { timeout: 20_000 });
  const [card] = await cards(page);
  if (card === undefined) throw new Error('no contact card was recorded');
  return card;
}

/**
 * Clears the sky through the flight hook now and every 200 ms after (see the
 * header). A rock spawns 220 m out and an interceptor 160 m out, each seconds
 * from the ship, so nothing reaches it.
 */
const keepSkyClear = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const clear = (): void => (window as unknown as { __reallmFlight?: FlightHook }).__reallmFlight?.clearSky();
    clear();
    setInterval(clear, 200);
  });

/** CONTACT of `systems/StoryBeats.ts`, in ms — the card's hold and its fade. */
const SHOW_MS = 3500;
const FADE_MS = 400;
/** A timer never fires early; on a loaded GPU-less host it can fire this late. */
const LATE_MS = 2000;

interface Held {
  before: { progress: number; x: number };
  after: { progress: number; x: number };
  cardUp: boolean;
}

/**
 * §4.5, no hold: the moment the first card mounts, in the page, hold the steer
 * key for a second of real time and read the trip's progress and the ship's x
 * on either side of it — with the card still up at the end.
 */
function heldUnderCard(page: Page): Promise<Held> {
  return page.evaluate(async () => {
    const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
    const read = (): { progress: number; x: number } => ({
      progress: hook.state().progress,
      x: Number(window.__reallm.stats().sceneInfo?.['shipX']),
    });
    const deadline = performance.now() + 20_000;
    while ((window.__spec063Cards ?? []).length === 0 && performance.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10));
    }
    const key = (type: 'keydown' | 'keyup'): boolean =>
      window.dispatchEvent(new KeyboardEvent(type, { code: 'KeyD', key: 'd', bubbles: true, cancelable: true }));
    key('keydown');
    const before = read();
    await new Promise((done) => setTimeout(done, 1000));
    const after = read();
    key('keyup');
    return { before, after, cardUp: document.querySelector('[data-testid="contact-card"]') !== null };
  });
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

  // §6.3 case 2: warp to the first group — while the chapter card is still
  // up over the launch, so the contact card waits for it (E111).
  const warped = await warpToFirstGroup(page);
  expect(warped.hostiles).toBeGreaterThan(0);
  expect(warped).toMatchObject({ chapterUp: true, contactUp: false });
  await keepSkyClear(page);

  // §4.5, no hold: the trip advances and the steer key moves the ship under the card.
  const held = await heldUnderCard(page);
  expect(held.cardUp).toBe(true);
  expect(held.after.progress).toBeGreaterThan(held.before.progress);
  expect(held.after.x).toBeGreaterThan(held.before.x);
  expect(await page.evaluate(() => window.__reallm.stats().state)).toBe('running');

  const card = await firstCard(page);
  expect(card).toMatchObject({
    enemy: 'scav_fighter',
    texts: ['CONTACT', 'SCAV FIGHTER', SCAV_EPITHET],
    chapterUp: false,
    isStatic: false,
    transition: '0.4s',
  });

  // §4.5: the scav's line and ARIA's, non-modal through the shared layer.
  await expect.poll(() => lineShown(page, SCAV_LINE), { timeout: 20_000 }).toBe(true);
  await expect(page.locator('[data-testid="dialogue"]')).not.toHaveClass(/is-modal/);
  await expect.poll(() => lineShown(page, ARIA_SCAV_LINE), { timeout: 30_000 }).toBe(true);
  expect(await contacts(page)).toEqual(['scav_fighter']);

  // The card holds CONTACT.show, then fades out over CONTACT.fade and is
  // removed — each timed from the mount, since the two timers slip apart.
  await expect(page.locator(CONTACT_CARD)).toHaveCount(0, { timeout: 10_000 });
  const [life] = await cards(page);
  if (life?.fadeAt == null || life.goneAt === null) throw new Error('the card did not fade and go');
  expect(life.fadeAt - life.at).toBeGreaterThanOrEqual(SHOW_MS - 20);
  expect(life.fadeAt - life.at).toBeLessThanOrEqual(SHOW_MS + LATE_MS);
  expect(life.goneAt - life.at).toBeGreaterThanOrEqual(SHOW_MS + FADE_MS - 20);
  expect(life.goneAt - life.at).toBeLessThanOrEqual(SHOW_MS + FADE_MS + LATE_MS);
  expect(life.goneAt).toBeGreaterThan(life.fadeAt);
  // One card on this trip, and the session key holds it (63-c).
  expect(await cards(page)).toHaveLength(1);
});

test('3 — a later trip to Vetra plays neither film, and its fighters make no contact', async ({ page }) => {
  test.setTimeout(120_000);
  await newSaveAtStarmap(page, { flags: ['chapter1_done'], visits: { vetra: 1 } });
  await depart(page, 'vetra');

  await settled(page, 'flight');
  await expect(page.locator(FILM)).toHaveCount(0);
  const warped = await warpToFirstGroup(page);
  expect(warped.hostiles).toBeGreaterThan(0);
  await keepSkyClear(page);
  // Past a card's whole life: nothing was scheduled, the chapter card included.
  await page.waitForTimeout(SHOW_MS + FADE_MS);
  expect(await cards(page)).toEqual([]);
  await expect(page.locator(CHAPTER_CARD)).toHaveCount(0);
  expect(await contacts(page)).toEqual([]);
  expect(await lineShown(page, SCAV_LINE)).toBe(false);
  expect(await lineShown(page, ARIA_SCAV_LINE)).toBe(false);
  await expect(page.locator(FILM)).toHaveCount(0);
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
  await keepSkyClear(page);
  const card = await firstCard(page);
  expect(card).toMatchObject({ enemy: 'hive_interceptor', texts: ['CONTACT', 'HIVE INTERCEPTOR', HIVE_EPITHET], chapterUp: false });
  await expect.poll(() => lineShown(page, ARIA_HIVE_LINE), { timeout: 20_000 }).toBe(true);
  expect(await contacts(page)).toEqual(['hive_interceptor']);

  // The trip's second group — 45 s of 200, a fraction of 0.225 — makes no
  // contact of its own (63-c). Past 0.25 it has spawned (SPEC-013 §4.4, and
  // tests/systems/flight.test.ts); half a second at a time, the sky cleared
  // after each, so nothing reaches the ship.
  const second = await page.evaluate(() => {
    const hook = (window as unknown as { __reallmFlight: FlightHook }).__reallmFlight;
    for (let i = 0; i < 400 && hook.state().progress < 0.25 && hook.phase() === 'cruise'; i++) {
      hook.warp(0.5);
      hook.clearSky();
    }
    return { progress: hook.state().progress, phase: hook.phase() };
  });
  expect(second.progress).toBeGreaterThanOrEqual(0.25);
  expect(second.phase).toBe('cruise');
  await page.waitForTimeout(SHOW_MS + FADE_MS);
  expect(await cards(page)).toHaveLength(1);
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
  await keepSkyClear(page);
  expect(await contacts(page)).toEqual(['scav_fighter']);
  await expect.poll(() => lineShown(page, ARIA_SCAV_LINE), { timeout: 30_000 }).toBe(true);
  expect(await cards(page)).toEqual([]);
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
    await keepSkyClear(page);
    const card = await firstCard(page);
    expect(card).toMatchObject({ enemy: 'scav_fighter', isStatic: true, transition: '0s' });
    await expect(page.locator(CONTACT_CARD)).toHaveCount(0, { timeout: 10_000 });
    const [life] = await cards(page);
    // No fade: the card is removed `CONTACT.show` after it went up, in one cut.
    expect(life?.fadeAt).toBeNull();
    const gone = (life?.goneAt ?? Number.NaN) - (life?.at ?? Number.NaN);
    expect(gone).toBeGreaterThanOrEqual(SHOW_MS - 20);
    expect(gone).toBeLessThanOrEqual(SHOW_MS + LATE_MS);
  });
});
