// SPEC-051 §6.2 — the retaken films, in the browser: the log captions the two
// endings gained, chapter 5's board with its caption and its poster, the
// prologue's timing held for SPEC-022's seeks, and the posters on disk. The
// pictures are rendered by hand on the Blender machine (SPEC-051 §1); what a
// browser proves is that the data, the manifest and the committed files agree.
//
// Each case binds a first-run save (instance 62) on the menu, where the story
// director already stands, and plays through `window.__reallmFilm`. Films run
// in stills (`filmMode: 'stills'`): this container's Chromium cannot composite
// H.264 into the film layer (SPEC-022's suite explains), and posters are what
// cases 3 and 4 read anyway. Reduce motion lands each caption whole.
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

test.use({ reducedMotion: 'reduce' });

type FilmBridge = { play(id: string): Promise<string>; seek(seconds: number): void };

const CREATION = {
  name: 'Vega',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** The menu with films on, in stills, and a first-run save bound to slot 0. */
async function ready(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ filmMode: 'stills' })));
  await start(page, '/?films=on');
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
}

const seek = (page: Page, seconds: number): Promise<void> =>
  page.evaluate((at) => (window as unknown as { __reallmFilm: FilmBridge }).__reallmFilm.seek(at), seconds);

/** Plays `id` through the dev bridge and seeks it to `at`. */
async function play(page: Page, id: string, at: number): Promise<void> {
  await page.evaluate((film) => void (window as unknown as { __reallmFilm: FilmBridge }).__reallmFilm.play(film), id);
  await expect(page.getByTestId('film')).toHaveAttribute('data-film', id);
  await expect(page.getByTestId('film')).toHaveAttribute('data-mode', 'stills');
  await seek(page, at);
}

const caption = (page: Page) => page.getByTestId('film-caption').locator('.film-caption-text');

test('1. Next of kin: the escape ending’s point shot logs one template and 62 recipients (§4.7)', async ({ page }) => {
  await ready(page);
  await play(page, 'ending_escape', 30);
  await expect(caption(page)).toHaveText('NEXT OF KIN — 1 template. 62 recipients.');
});

test('2. Mail: the stay ending’s last shot queues letter 1 for No. 63 (§4.7)', async ({ page }) => {
  await ready(page);
  await play(page, 'ending_stay', 31);
  await expect(caption(page)).toHaveText('MAIL QUEUED — No. 63: “The lamp over the map table stopped flickering today.”');
});

test('3. The board: chapter 5 ends on the Selection wall, with its caption and its poster (§4.5)', async ({ page }) => {
  await ready(page);
  await play(page, 'interlude_c5', 13);
  await expect(caption(page)).toHaveText('There is a new card on the board. Nobody has told me whose.');
  await seek(page, 14);
  await expect(page.getByTestId('film-poster')).toHaveAttribute('src', /films\/posters\/interlude_c5_board\.webp$/);
});

test('4. No drift in time: the prologue’s still at 76 s is the Selection, and 92.9 s ends it (§4.7, SPEC-022)', async ({ page }) => {
  await ready(page);
  await play(page, 'prologue', 76);
  await expect(page.getByTestId('film-poster')).toHaveAttribute('src', /prologue_selection\.webp$/);
  await seek(page, 92.9);
  await expect(page.getByTestId('film')).toHaveCount(0, { timeout: 15_000 });
});

test('5. Posters on disk: the cockpit’s is gone, and every poster the manifest lists is served (§4.9)', async ({ request }) => {
  // Asked for as an image: the dev server answers a missing path with
  // index.html (200) when a request accepts anything, so the probe accepts
  // WebP only — a missing poster is then a 404, as on a static host.
  const image = { headers: { accept: 'image/webp' } };
  expect((await request.get('/assets/films/posters/interlude_c5_cockpit.webp', image)).status()).toBe(404);
  const manifest = (await (await request.get('/assets/films/manifest.json')).json()) as {
    films: Record<string, { shots: Array<{ poster: string }> }>;
  };
  const posters = Object.values(manifest.films).flatMap((film) => film.shots.map((shot) => shot.poster));
  expect(posters).toContain('films/posters/interlude_c5_board.webp');
  for (const poster of posters) {
    const response = await request.get(`/assets/${poster}`, image);
    expect(response.status(), poster).toBe(200);
    expect(response.headers()['content-type'], poster).toContain('image/webp');
  }
});
