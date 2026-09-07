// The M1 acceptance run of SPEC-008 §7, in a real browser: the `?debug` overlay
// shows the save seed, and landing twice on the same planet shows the same
// layout hash.
//
// The generator itself is proved in `tests/core/rng.test.ts` against pinned
// vectors. What only a browser can prove is the wiring: that the seed on screen
// is the *save's*, that the hash follows the planet the player is standing on
// through every route into the surface scene, and that leaving and coming back
// — a whole scene tear-down and rebuild in between — reproduces it.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const seedRow = (page: Page) => page.locator('[data-testid="debug-seed"]');
const layoutRow = (page: Page) => page.locator('[data-testid="debug-layout"]');

/**
 * The route back to a planet: the scene graph has no surface → surface edge, so
 * a second landing is a full lap through the station (SPEC-003 §4.2). The dock
 * is skipped when the player is already standing on it — a self-transition is
 * rejected (D-9).
 */
async function landOn(page: Page, planet: string): Promise<void> {
  if ((await page.evaluate(() => window.__reallm.scene())) !== 'station') {
    expect(await page.evaluate(() => window.__reallm.go('station', {}))).toBe(true);
  }
  for (const [id, params] of [
    ['starmap', undefined],
    ['flight', { destination: planet }],
    ['surface', { planet, firstLanding: false }],
  ] as const) {
    expect(await page.evaluate(([i, p]) => window.__reallm.go(i, p), [id, params] as const), id).toBe(true);
  }
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
}

test('shows the seed, and the layout hash of the planet under the player (SPEC-008 AC-15, AC-16)', async ({ page }) => {
  await start(page, '/?debug&scene=surface&planet=cinder4');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');

  // No save is loaded in a bare `?scene=` jump, so the root falls back to the
  // default seed — the row still has to say which number the world came from.
  await expect(seedRow(page)).toHaveText(/^seed \d+$/);
  await expect(layoutRow(page)).toHaveText(/^layout cinder4 [0-9a-f]{8}$/);

  // The overlay and the dev bridge agree about what they are showing.
  const stats = await page.evaluate(() => window.__reallm.stats());
  expect(stats.planet).toBe('cinder4');
  expect(stats.layoutSeed).not.toBeNull();
  expect(await layoutRow(page).textContent()).toBe(
    `layout cinder4 ${(stats.layoutSeed as number).toString(16).padStart(8, '0')}`,
  );
  expect(await seedRow(page).textContent()).toBe(`seed ${stats.seed}`);
});

test('landing twice on the same planet shows the same hash (SPEC-008 AC-17)', async ({ page }) => {
  await start(page, '/?debug&scene=surface&planet=cinder4');
  await expect(layoutRow(page)).toHaveText(/^layout cinder4 [0-9a-f]{8}$/);
  const first = await layoutRow(page).textContent();

  // Off the planet entirely — the scene is torn down and the row says so —
  // then all the way back down to it.
  expect(await page.evaluate(() => window.__reallm.go('station', {}))).toBe(true);
  await expect(layoutRow(page)).toHaveText('layout -');

  await landOn(page, 'cinder4');
  expect(await layoutRow(page).textContent()).toBe(first);

  // A different planet is a different world.
  await landOn(page, 'vetra');
  await expect(layoutRow(page)).toHaveText(/^layout vetra [0-9a-f]{8}$/);
  expect(await layoutRow(page).textContent()).not.toBe(first);
});

/** Boot straight onto Cinder-4 with a given seed, and read the hash off the row. */
async function hashAfterBoot(page: Page, seed: number): Promise<string> {
  await start(page, `/?debug&seed=${seed}&scene=surface&planet=cinder4`);
  await expect(seedRow(page)).toHaveText(`seed ${seed}`);
  await expect(layoutRow(page)).toHaveText(/^layout cinder4 [0-9a-f]{8}$/);
  return (await layoutRow(page).textContent()) ?? '';
}

test('the hash survives a reload of the same seed, and moves with a different one (SPEC-008 AC-17)', async ({
  page,
}) => {
  const first = await hashAfterBoot(page, 12345);
  expect(await hashAfterBoot(page, 12345)).toBe(first);
  expect(await hashAfterBoot(page, 999)).not.toBe(first);
});

test('the seed on screen is the loaded save seed (SPEC-008 AC-15)', async ({ page }) => {
  await start(page, '/?debug');
  await expect(layoutRow(page)).toHaveText('layout -'); // the menu is not a planet

  const created = await page.evaluate(
    (creation) => window.__reallm.save().create(0, creation, 4242).meta.seed,
    CREATION,
  );
  expect(created).toBe(4242);

  // The root follows the active save: creating one re-seeds the whole world.
  await expect(seedRow(page)).toHaveText('seed 4242');
  expect((await page.evaluate(() => window.__reallm.stats())).seed).toBe(4242);
});
