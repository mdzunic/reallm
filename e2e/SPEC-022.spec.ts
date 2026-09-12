// SPEC-022 §6 — the film player and the prologue, in a real browser. The
// film suites opt in with `films=on` (gameUrl appends `films=off` to every
// other suite) and run with `reducedMotion: 'no-preference'`, except the
// reduce-motion case, which asks for `reduce`.
import { expect, test, type Page } from '@playwright/test';
import { setHidden, start } from './start';

/** The §4.11 dev bridge, as the suite sees it (e2e may not import src/). */
interface FilmBridge {
  state(): { id: string; mode: string; state: string; time: number; shot: string; caption: string | null } | null;
  play(id: string): Promise<string>;
  seek(seconds: number): void;
}

declare global {
  interface Window {
    __reallmFilm?: FilmBridge;
  }
}

test.use({ reducedMotion: 'no-preference' });

const FILM = '[data-testid="film"]';

/** New Game with films on: pick slot 0, land in the prologue. */
async function newGame(page: Page): Promise<void> {
  await start(page, '/?films=on');
  await page.locator('[data-testid="menu-new"]').click();
  await page.locator('[data-testid="new-slot-0"]').click();
  await expect(page.locator(FILM)).toHaveAttribute('data-film', 'prologue');
}

/** True where this Chromium decodes H.264 (checked on HeadlessChrome 153). */
async function decodesH264(page: Page): Promise<boolean> {
  return page.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"') !== '');
}

test('1 — video mode: the MP4 plays, captions type, a seek to the end reaches creation', async ({ page }) => {
  await newGame(page);
  const film = page.locator(FILM);
  if (!(await decodesH264(page))) {
    // No H.264 in this build: the player must still tell the story in stills.
    await expect(film).toHaveAttribute('data-mode', 'stills');
    return;
  }
  await expect(film).toHaveAttribute('data-mode', 'video');
  await expect(page.locator('[data-testid="film-video"]')).toHaveCount(1);
  // The first caption (at 0.8 s) types at 40 cps once the video is playing.
  await expect(page.locator('[data-testid="film-caption"]')).toContainText('We built minds to run the world', {
    timeout: 10_000,
  });
  await page.evaluate(() => window.__reallmFilm?.seek(71.9));
  await expect(page.locator('[data-testid="creation-confirm"]')).toBeVisible({ timeout: 15_000 });
});

test('2 — stills mode: a dead MP4 falls back to posters, seek pans the reel, Skip enters creation', async ({ page }) => {
  await page.route('**/assets/films/*.mp4', (route) => route.abort());
  await newGame(page);
  await expect(page.locator(FILM)).toHaveAttribute('data-mode', 'stills');
  const poster = page.locator('[data-testid="film-poster"]');
  await expect(poster).toHaveAttribute('src', /prologue_earth_night\.webp$/);
  await page.evaluate(() => window.__reallmFilm?.seek(55));
  await expect(poster).toHaveAttribute('src', /prologue_selection\.webp$/);
  await page.locator('[data-testid="film-skip"]').click();
  await expect(page.locator('[data-testid="creation-confirm"]')).toBeVisible();
});

test('3 — text mode: no films at all still tells the story in words; Escape skips', async ({ page }) => {
  await page.route('**/assets/films/**', (route) => route.abort());
  await newGame(page);
  await expect(page.locator(FILM)).toHaveAttribute('data-mode', 'text');
  await expect(page.locator('[data-testid="film-describe"]')).toContainText(
    'Earth at night from high orbit',
  );
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="creation-confirm"]')).toBeVisible();
});

test('4 — skip grace: an immediate Escape leaves the film up; one after 0.7 s skips it', async ({ page }) => {
  await newGame(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await expect(page.locator(FILM)).toBeVisible();
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await expect(page.locator(FILM)).toHaveCount(0);
  await expect(page.locator('[data-testid="creation-confirm"]')).toBeVisible();
});

test('5 — keys do not leak: Escape ends the film without opening the pause menu', async ({ page }) => {
  await start(page, '/?scene=surface&films=on');
  await page.evaluate(() => void window.__reallmFilm?.play('departure'));
  await expect(page.locator(FILM)).toHaveAttribute('data-film', 'departure');
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape');
  await expect(page.locator(FILM)).toHaveCount(0);
  await expect(page.locator('[data-testid="pause-menu"]')).toHaveCount(0);
});

test('6 — hidden tab: the film pauses with a frozen clock; only the Resume button restarts it', async ({ page }) => {
  await newGame(page);
  await setHidden(page, true);
  const film = page.locator(FILM);
  await expect(film).toHaveAttribute('data-state', 'paused');
  const before = await page.evaluate(() => window.__reallmFilm?.state()?.time ?? -1);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.__reallmFilm?.state()?.time ?? -1);
  expect(after).toBe(before);
  await setHidden(page, false);
  // E28: nothing resumes on its own.
  await expect(film).toHaveAttribute('data-state', 'paused');
  const resume = page.locator('[data-testid="film-resume"]');
  await expect(resume).toBeVisible();
  await resume.click();
  await expect(film).toHaveAttribute('data-state', /playing|loading/);
});

test.describe('reduce motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('7 — every film plays in stills with no pan', async ({ page }) => {
    await newGame(page);
    await expect(page.locator(FILM)).toHaveAttribute('data-mode', 'stills');
    const poster = page.locator('[data-testid="film-poster"]');
    await expect(poster).toBeVisible();
    await expect(poster).toHaveCSS('transform', 'none');
  });
});

test('8 — Credits replay: the prologue plays over the menu and returns to the open panel', async ({ page }) => {
  await start(page, '/?films=on');
  await page.locator('[data-testid="menu-credits"]').click();
  await page.locator('[data-testid="credits-prologue"]').click();
  await expect(page.locator(FILM)).toHaveAttribute('data-film', 'prologue');
  await page.waitForTimeout(400);
  await page.locator('[data-testid="film-skip"]').click();
  await expect(page.locator(FILM)).toHaveCount(0);
  await expect(page.locator('[data-testid="credits-text"]')).toBeVisible();
});

test('9 — films off: New Game lands in creation at once and no film node ever appears', async ({ page }) => {
  await start(page); // gameUrl appends films=off
  await page.locator('[data-testid="menu-new"]').click();
  await page.locator('[data-testid="new-slot-0"]').click();
  await expect(page.locator('[data-testid="creation-confirm"]')).toBeVisible();
  await expect(page.locator(FILM)).toHaveCount(0);
});
