// SPEC-023 §6 — the four chapter beats in a real browser: the departure and
// the chapter card on the first trip to a world, the interlude the station
// owes (and the catch-up that keeps an old save to one film), and the boss
// reveal with its held simulation.
//
// The suite opts into films (`gameUrl` appends `films=off` everywhere else)
// and aborts the MP4s, so every film runs in the deterministic stills mode —
// the pictures are SPEC-022's business, and what is under test here is which
// beat fires, when, and what it leaves behind in the save.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

test.use({ reducedMotion: 'no-preference' });

const FILM = '[data-testid="film"]';
const CARD = '[data-testid="chapter-card"]';
const REVEAL = '[data-testid="boss-reveal"]';
const MP4S = '**/assets/films/*.mp4';

const CREATION = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

/**
 * Waits until `scene` is on screen *and* its transition has settled — the fade
 * still runs after the label appears (SPEC-003 AC-14) and a `go()` issued
 * during it is refused (D-2), so every click that leaves a scene waits here
 * first. Same pair of assertions `start()` makes.
 */
async function settled(page: Page, scene: string): Promise<void> {
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText(scene);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
}

const flags = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__reallm.save().current?.progress.flags ?? []);

/** A fresh slot-0 save, films on and the MP4s dead; no scene assumed yet. */
async function newSave(page: Page, url = '/?films=on&seed=123'): Promise<void> {
  await page.route(MP4S, (route) => route.abort());
  await start(page, url);
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
}

async function enterStation(page: Page, params: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate((p) => window.__reallm.go('station', p, { force: true }), params);
  await settled(page, 'station');
}

/** Star map → select Cinder-4 → Depart → confirm. Leaves the fuel paid. */
async function departForCinder4(page: Page): Promise<void> {
  await page.locator('[data-testid="station-tab-starmap"]').click();
  await settled(page, 'starmap');
  await page.locator('[data-testid="map-node-cinder4"]').click();
  await page.locator('[data-testid="starmap-depart"]').click();
  await page.locator('[data-testid="confirm-yes"]').click();
}

test('1 — departure and card: the first trip to Cinder-4 plays the film, then the chapter card', async ({ page }) => {
  await newSave(page);
  await enterStation(page);
  await departForCinder4(page);

  // §4.1: the film plays after the fuel is paid and before the flight scene.
  const film = page.locator(FILM);
  await expect(film).toHaveAttribute('data-film', 'departure');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('starmap');
  await page.waitForTimeout(500); // out past the 0.3 s pointer grace (SPEC-022 §4.5)
  await page.locator('[data-testid="film-skip"]').click();
  await expect(film).toHaveCount(0);

  // §4.2: the card over the launch — chapter, title, line and containment.
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  await expect(card).toContainText('CHAPTER 1');
  await expect(card).toContainText('CINDER-4');
  await expect(card).toContainText('Oil and grain under the dunes.');
  await expect(card).toContainText('containment level 1');
  // The card does not hold the flight (§4.2, Decisions): the trip is running
  // under it — frames are ticking and the game is not paused behind a beat —
  // and the launch timeline runs out on its own further down.
  const frame = (await page.evaluate(() => window.__reallm.stats())).frame;
  await page.waitForTimeout(300);
  const stats = await page.evaluate(() => window.__reallm.stats());
  expect(stats).toMatchObject({ state: 'running', scene: 'flight' });
  expect(stats.frame).toBeGreaterThan(frame);
  await expect(card).toBeVisible();
  // 4.5 s on screen plus a 0.6 s fade, after the 0.3 s delay.
  await expect(card).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  await expect.poll(async () => (await info(page))['phase'], { timeout: 20_000 }).toBe('cruise');
});

test('2 — a later trip: a world already landed on departs straight into the flight', async ({ page }) => {
  await newSave(page);
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save !== null) save.progress.visits['cinder4'] = 1;
  });
  await enterStation(page);
  await departForCinder4(page);

  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
  await expect(page.locator(FILM)).toHaveCount(0);
  // Past the card's 0.3 s delay: nothing is scheduled at all.
  await page.waitForTimeout(600);
  await expect(page.locator(CARD)).toHaveCount(0);
});

test('3 — interlude: the first return after chapter 1 plays it, marks it seen, and never plays it twice', async ({
  page,
}) => {
  await newSave(page);
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save !== null) save.progress.flags.push('c1_oil', 'chapter1_done');
  });
  await enterStation(page, { arrivedFrom: 'cinder4' });

  const film = page.locator(FILM);
  await expect(film).toHaveAttribute('data-film', 'interlude_c1');
  await page.waitForTimeout(500); // the pointer grace (SPEC-022 §4.5)
  await page.locator('[data-testid="film-skip"]').click();
  await expect(film).toHaveCount(0);
  // Skipping counts as seen, and the save is asked to write it (§4.3).
  expect(await flags(page)).toContain('interlude1_seen');

  // The star map and back: the flags decide, and they say it has been seen.
  await page.locator('[data-testid="station-tab-starmap"]').click();
  await settled(page, 'starmap');
  await page.locator('[data-testid="starmap-back"]').click();
  await settled(page, 'station');
  await page.waitForTimeout(600);
  await expect(film).toHaveCount(0);
});

test('4 — catch-up: three pending chapters play the newest film and mark all three seen (E30)', async ({ page }) => {
  await newSave(page);
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save !== null) save.progress.flags.push('chapter1_done', 'chapter2_done', 'chapter3_done');
  });
  await enterStation(page, { arrivedFrom: 'thessaly' });

  const film = page.locator(FILM);
  await expect(film).toHaveAttribute('data-film', 'interlude_c3');
  await page.waitForTimeout(500); // the pointer grace (SPEC-022 §4.5)
  await page.locator('[data-testid="film-skip"]').click();
  await expect(film).toHaveCount(0);
  const seen = await flags(page);
  expect(seen).toContain('interlude1_seen');
  expect(seen).toContain('interlude2_seen');
  expect(seen).toContain('interlude3_seen');
});

/** The surface, standing on `c1_m3`'s boss stage, with the debug strip up. */
async function landOnBossStage(page: Page): Promise<void> {
  await newSave(page, '/?films=on&debug&seed=123');
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) return;
    save.progress.missionsDone = ['c1_m1', 'c1_m2'];
    save.progress.missionsActive = [{ id: 'c1_m3', stage: 0, counters: {} }];
  });
  await page.evaluate(() =>
    window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true }),
  );
  await settled(page, 'surface');
  await dismissDialogue(page);
}

test('5 & 6 — the reveal holds the simulation once per boss per session', async ({ page }) => {
  await landOnBossStage(page);

  await page.locator('[data-testid="surface-goto-boss"]').click();
  const reveal = page.locator(REVEAL);
  // §4.4: the hold phase shows the name, the epithet and one caption.
  await expect(reveal).toContainText('DUNE WURM', { timeout: 15_000 });
  await expect(reveal).toContainText('It hunts by vibration');
  await expect(page.locator('[data-testid="reveal-caption"]')).toContainText('There it is');

  // The simulation is held: over a second, the boss does not move, its HP does
  // not change, and the beat counter stays up — while the view clock runs on.
  const hp = await page.locator('[data-testid="hud-hp"]').textContent();
  const before = await info(page);
  expect(before['held']).toBe(1);
  await page.waitForTimeout(1000);
  // Nothing can touch the player during a held beat — the debug hurt included.
  await page.locator('[data-testid="surface-hurt"]').click();
  const after = await info(page);
  expect(after['boss']).toBe(before['boss']);
  expect(after['nearDx']).toBe(before['nearDx']);
  expect(after['nearDz']).toBe(before['nearDz']);
  expect(after['held']).toBe(1);
  expect(Number(after['viewTime'])).toBeGreaterThan(Number(before['viewTime']));
  expect(await page.locator('[data-testid="hud-hp"]').textContent()).toBe(hp);

  // Skip restores the camera and the simulation at once.
  await page.locator('[data-testid="reveal-skip"]').click();
  await expect(reveal).toHaveCount(0);
  expect((await info(page))['held']).toBe(0);
  expect((await info(page))['boss']).not.toBe('-');

  // §6 case 6: die, walk back in, and the boss wakes without a second reveal.
  const death = page.locator('[data-testid="death-overlay"]');
  for (let i = 0; i < 12 && !(await death.isVisible()); i++) {
    await page.locator('[data-testid="surface-hurt"]').click();
    await page.waitForTimeout(150);
  }
  await expect(death).toBeVisible({ timeout: 10_000 });
  await expect(death).toBeHidden({ timeout: 15_000 });
  await expect.poll(async () => (await info(page))['boss'], { timeout: 10_000 }).toBe('-');

  await page.locator('[data-testid="surface-goto-boss"]').click();
  await expect.poll(async () => (await info(page))['boss'], { timeout: 15_000 }).not.toBe('-');
  await expect(reveal).toHaveCount(0);
  expect((await info(page))['held']).toBe(0);
});

test('7 — the reveal takes Escape as its skip, and the key never reaches the pause menu', async ({ page }) => {
  await landOnBossStage(page);
  await page.locator('[data-testid="surface-goto-boss"]').click();
  const reveal = page.locator(REVEAL);
  await expect(reveal).toContainText('DUNE WURM', { timeout: 15_000 });

  // SPEC-022 §4.5's key grace is 0.6 s of *wall* time since the overlay went
  // up, and the hold is 1 s of simulation — which, on a frame that runs five
  // steps, is less than that. Wait the grace out rather than race it.
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape');
  await expect(reveal).toHaveCount(0);
  expect((await info(page))['held']).toBe(0);
  // The menu node exists on every pausable scene; visible is what pause means.
  await expect(page.locator('[data-testid="pause-menu"]')).toBeHidden();
});

test('8 — films off: no beat plays and no flag is written (23-f)', async ({ page }) => {
  // `gameUrl` appends `films=off`; the save is one station entry from an
  // interlude and one departure from the departure film and the card.
  await start(page, '/?seed=123');
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save !== null) save.progress.flags.push('chapter1_done');
  });
  await enterStation(page, { arrivedFrom: 'cinder4' });
  await page.waitForTimeout(800);
  await expect(page.locator(FILM)).toHaveCount(0);
  expect(await flags(page)).toEqual(['chapter1_done']);

  await departForCinder4(page);
  await settled(page, 'flight');
  await page.waitForTimeout(800);
  await expect(page.locator(FILM)).toHaveCount(0);
  await expect(page.locator(CARD)).toHaveCount(0);
  expect(await flags(page)).toEqual(['chapter1_done']);
});

/** Click through the landing's accept dialogue; chapter-1 beats are non-modal. */
async function dismissDialogue(page: Page): Promise<void> {
  const dialogue = page.locator('[data-testid="dialogue"]');
  for (let i = 0; i < 30; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    await dialogue.click({ force: true });
    await page.waitForTimeout(120);
  }
}
