// SPEC-026 §6.2 — the two maps in a real browser. What only a composed scene
// can show: the minimap's backing store against its CSS box, ground that stays
// lit across a reload, the hold the full map puts on the simulation, and the
// key that took over pin cycling.
//
// The projection, the icon table and the mask itself are pinned in node
// (`tests/ui/map.test.ts`, `tests/systems/exploration.test.ts`).
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const CREATION = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

const num = async (page: Page, key: string): Promise<number> => Number((await info(page))[key] ?? Number.NaN);

/**
 * `mmExplored` as the live save's copy of the mask would read back: SPEC-025
 * §4.5's base64url bitset of `ceil(n² / 8)` bytes, popcounted over the n × n
 * grid and rounded the way `debugInfo()` rounds the live mask.
 */
async function savedExplored(page: Page): Promise<number> {
  return page.evaluate(() => {
    const code = window.__reallm.save().current?.progress.explored['cinder4'];
    if (code === undefined) return 0;
    const bytes = Uint8Array.from(atob(code.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    let lit = 0;
    for (const byte of bytes) for (let bits = byte; bits !== 0; bits &= bits - 1) lit++;
    const n = Math.floor(Math.sqrt(bytes.length * 8));
    return Math.round((lit / (n * n)) * 1000) / 10;
  });
}

/** Create the slot-0 save and land on Cinder-4 through the bridge. */
async function land(page: Page): Promise<void> {
  await start(page, '/?debug&seed=123');
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: true }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
}

/**
 * A real page reload, then back onto the planet the way a returning player
 * gets there: the menu's Load button binds the stored save (`load()` alone only
 * parses it), and the station is where a loaded run stands.
 */
async function reload(page: Page): Promise<void> {
  await start(page, '/?debug&seed=123');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
  await page.getByTestId('menu-load').click();
  await page.getByTestId('load-slot-0').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
  expect(
    await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true })),
  ).toBe(true);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
}

/** Click through any open dialogue: the first tap fills the line, the next advances. */
async function dismiss(page: Page): Promise<void> {
  const dialogue = page.locator('[data-testid="dialogue"]');
  for (let i = 0; i < 30; i++) {
    if (!(await dialogue.isVisible().catch(() => false))) return;
    await dialogue.click({ force: true });
    await page.waitForTimeout(120);
  }
}

test('1. landing: the minimap is backed to its CSS box, and the ground under the ship is lit', async ({ page }) => {
  await land(page);

  const minimap = page.locator('[data-testid="minimap"]');
  await expect(minimap).toHaveCount(1);
  const box = await minimap.evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    return {
      css: rect.width,
      round: Math.round(rect.width) === Math.round(rect.height),
      width: canvas.width,
      height: canvas.height,
      want: Math.round(rect.width * Math.min(window.devicePixelRatio, 2)),
      radius: getComputedStyle(canvas).borderRadius,
    };
  });
  // §4.3: `clamp(128px, 24vmin, 184px)`, square, round, and backed at
  // `round(css × min(dpr, 2))`.
  expect(box.css).toBeGreaterThanOrEqual(128);
  expect(box.css).toBeLessThanOrEqual(184);
  expect(box.round).toBe(true);
  expect(box.radius).toBe('50%');
  expect(box.width).toBe(box.want);
  expect(box.height).toBe(box.want);

  // §4.4: the spawn reveal ran, and the terrain layer was built exactly once.
  await expect.poll(async () => num(page, 'mmExplored')).toBeGreaterThan(0);
  expect(await num(page, 'mmTerrainBuilds')).toBe(1);
});

test('2. the full map holds the simulation, and Escape closes it without pausing', async ({ page }) => {
  await land(page);
  await dismiss(page);

  const map = page.locator('[data-testid="map-screen"]');
  await page.keyboard.press('KeyM');
  await expect(map).toBeVisible();
  await expect.poll(async () => num(page, 'mapOpen')).toBe(1);

  // §4.6: nothing moves while it is open — a full second of D leaves the
  // player exactly where they stood.
  const before = await info(page);
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(1000);
  await page.keyboard.up('KeyD');
  const after = await info(page);
  expect([after['px'], after['pz']]).toEqual([before['px'], before['pz']]);

  // §4.5: the legend names what is on this planet, the pad included.
  await expect(page.locator('[data-testid="map-legend"]')).toContainText('Landing pad');
  await expect(page.locator('[data-testid="map-explored"]')).toContainText('Explored');

  // §4.5, Keys: Escape closes the map and stops there.
  await page.keyboard.press('Escape');
  await expect(map).toBeHidden();
  await expect(page.locator('[data-testid="pause-menu"]')).toBeHidden();
  expect(await num(page, 'mapOpen')).toBe(0);

  // …and the simulation is running again.
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(600);
  await page.keyboard.up('KeyD');
  expect(Number((await info(page))['px'])).not.toBe(Number(after['px']));
});

test('3. a minimap tap opens the map; the close button, M and a tap outside close it', async ({ page }) => {
  await land(page);
  await dismiss(page);
  const map = page.locator('[data-testid="map-screen"]');

  await page.locator('[data-testid="minimap"]').click();
  await expect(map).toBeVisible();
  await page.locator('[data-testid="map-close"]').click();
  await expect(map).toBeHidden();

  // §4.5: M toggles, and `+` / `map-zoom` swap fit for 2× while it is open.
  await page.keyboard.press('KeyM');
  await expect(map).toBeVisible();
  const zoom = page.locator('[data-testid="map-zoom"]');
  await expect(zoom).toHaveText('Zoom 2×');
  await zoom.click();
  await expect(zoom).toHaveText('Fit');
  await page.keyboard.press('Equal');
  await expect(zoom).toHaveText('Zoom 2×');
  await page.keyboard.press('KeyM');
  await expect(map).toBeHidden();

  // §4.5, Touch: a tap that lands on neither the map nor the panel closes it.
  await page.locator('[data-testid="minimap"]').click();
  await expect(map).toBeVisible();
  await map.click({ position: { x: 4, y: 4 } });
  await expect(map).toBeHidden();
});

test('4. travel lights ground; a reload and a station round trip both land on it', async ({ page }) => {
  test.setTimeout(150_000);
  await land(page);
  await dismiss(page);
  const landed = await num(page, 'mmExplored');
  expect(landed).toBeGreaterThan(0);

  // Accept c1_m1 so the objective shortcut has somewhere to go, then travel.
  await page.locator('[data-testid="surface-goto-pad"]').click();
  await page.keyboard.press('KeyE');
  await expect(page.locator('[data-testid="pad-terminal"]')).toBeVisible();
  await page.locator('[data-testid="terminal-accept-c1_m1"]').click();
  await page.locator('[data-testid="terminal-close"]').click();
  await dismiss(page);
  await page.locator('[data-testid="surface-goto-objective"]').click();
  await expect.poll(async () => num(page, 'mmExplored'), { timeout: 15_000 }).toBeGreaterThan(landed);

  // §4.4: the mask reaches the live save at most once a second while it
  // changes — a second of game time, which a slow host stretches past any
  // fixed wall-clock wait — so the save is taken once it holds everything lit.
  const walked = await num(page, 'mmExplored');
  await expect.poll(() => savedExplored(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(walked);
  await page.evaluate(() => window.__reallm.save().request('manual'));
  expect(await page.evaluate(() => window.__reallm.save().flush())).toBe(true);

  // A real reload lands on the same lit ground (AC: `mmExplored` after a
  // reload is at least what it was before).
  await reload(page);
  expect(await num(page, 'mmExplored')).toBeGreaterThanOrEqual(walked);

  // …and so does a station round trip: walking lights a fresh crescent, and
  // the scene writes the mask on exit rather than waiting for a timer.
  await dismiss(page);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
  await expect.poll(async () => num(page, 'mmExplored'), { timeout: 10_000 }).toBeGreaterThan(walked);
  const lit = await num(page, 'mmExplored');

  await page.locator('[data-testid="surface-goto-pad"]').click();
  await page.keyboard.press('KeyE');
  await expect(page.locator('[data-testid="pad-terminal"]')).toBeVisible();
  await page.locator('[data-testid="terminal-return"]').click();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
  expect(
    await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true })),
  ).toBe(true);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  expect(await num(page, 'mmExplored')).toBeGreaterThanOrEqual(lit);
});

test('5. T cycles the tracked mission, and a Track button pins one from the map', async ({ page }) => {
  test.setTimeout(150_000);
  // The chapter's two side missions and its second main all hang off c1_m1, so
  // the board only ever offers one mission to a pilot who has just landed.
  // Marking it done is how this run gets two acceptances at one terminal.
  await start(page, '/?debug&seed=123');
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
  await page.evaluate(() => {
    const save = window.__reallm.save().current;
    if (save === null) throw new Error('no save');
    save.progress.missionsDone.push('c1_m1');
  });
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: true }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  await dismiss(page);

  await page.locator('[data-testid="surface-goto-pad"]').click();
  await page.keyboard.press('KeyE');
  await expect(page.locator('[data-testid="pad-terminal"]')).toBeVisible();
  await page.locator('[data-testid="terminal-accept-c1_m2"]').click();
  await dismiss(page);
  await page.locator('[data-testid="terminal-accept-c1_s1"]').click();
  await dismiss(page);
  await page.locator('[data-testid="terminal-close"]').click();
  await dismiss(page);

  const line = page.locator('[data-testid="hud"] .hud-objective');
  const title = async (): Promise<string> => ((await line.textContent()) ?? '').split('—')[0] ?? '';
  const first = await title();
  expect(first.trim().length).toBeGreaterThan(0);
  // §4.7: T cycles the pin — the HUD line changes title.
  await page.keyboard.press('KeyT');
  await expect.poll(title, { timeout: 10_000 }).not.toBe(first);
  // …and cycling round comes back to where it started: one pin, two missions.
  await page.keyboard.press('KeyT');
  await expect.poll(title, { timeout: 10_000 }).toBe(first);

  // §4.5: the map's own Track button pins the mission it belongs to.
  await page.keyboard.press('KeyM');
  await expect(page.locator('[data-testid="map-screen"]')).toBeVisible();
  await page.locator('[data-testid="map-track-c1_s1"]').click();
  await expect(page.locator('[data-testid="map-track-c1_s1"]')).toHaveText('Tracked');
  await page.keyboard.press('KeyM');
  await expect(page.locator('[data-testid="map-screen"]')).toBeHidden();
  await expect.poll(title, { timeout: 10_000 }).toContain('Grain Silo');
});
