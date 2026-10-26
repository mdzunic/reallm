// SPEC-073 §7 — the Refit on desktop: every glyph drawn as its icon, the
// drawn lockup, settings as a sheet, the compact board, the 15° star map, the
// compact pause frame and the death card's icon.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, frames, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 0 },
  difficulty: 'normal',
} as const;

/** The glyphs the UI prints as pictures (SPEC-073 §3) — prose arrows and chevrons aside. */
const GLYPHS = ['◈', '⛨', '▣', '▲', '✓', '✗', '♥', '⛭', '🛢', '🌾', '💧', '⚡', '🔒', '✚', '☂', '↯', '✸', '☼'];

async function settle(page: Page, scene: string): Promise<void> {
  await expect(page.getByTestId('scene-label')).toHaveText(scene, COLD_START);
  await expect(page.getByTestId('transition-fade')).toHaveCSS('pointer-events', 'none', COLD_START);
  await frames(page, 4);
}

async function go(page: Page, scene: string, params: unknown = {}): Promise<void> {
  await page.evaluate(({ scene, params }) => window.__reallm.go(scene, params, { force: true }), { scene, params });
  await settle(page, scene);
}

async function withSave(page: Page): Promise<void> {
  await page.evaluate((creation) => {
    const save = window.__reallm.save().create(0, creation, 123);
    save.player.tokens = 340;
    save.resources['oil'] = 180;
    save.resources['wheat'] = 60;
    save.resources['water'] = 45;
    save.resources['lithium'] = 12;
  }, CREATION);
}

/**
 * E139: every text node under `#ui` that holds a glyph sits alone in a
 * `.glyph[data-icon]` whose mask is painted. Returns what does not.
 */
async function unpainted(page: Page): Promise<string[]> {
  return page.evaluate((glyphs) => {
    const out: string[] = [];
    const root = document.getElementById('ui');
    if (root === null) return ['no #ui'];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      if (!glyphs.some((glyph) => text.includes(glyph))) continue;
      const parent = node.parentElement;
      const style = parent === null ? null : getComputedStyle(parent);
      const mask = style === null ? 'none' : style.maskImage || style.getPropertyValue('-webkit-mask-image');
      if (parent === null || !parent.matches('.glyph[data-icon]') || !mask.includes('url(')) {
        out.push(`${parent?.className ?? '?'}: ${text.slice(0, 40)}`);
      }
    }
    return out;
  }, GLYPHS);
}

test('1. every glyph on the station, the star map and both HUDs draws as its icon (§3, E139)', async ({ page }) => {
  test.setTimeout(240_000);
  await start(page, '/?seed=123');
  await withSave(page);
  await go(page, 'station');
  for (const tab of ['missions', 'shop', 'character', 'depot']) {
    await page.getByTestId(`station-tab-${tab}`).click();
    await frames(page, 2);
    expect(await unpainted(page), `station ${tab}`).toEqual([]);
  }
  await go(page, 'starmap', undefined);
  expect(await unpainted(page), 'star map').toEqual([]);
  await go(page, 'surface', { planet: 'cinder4' });
  await page.evaluate(() => window.__reallm.toast('Cache opened · +5 ◈', 'good', 8000));
  await frames(page, 2);
  expect(await unpainted(page), 'surface').toEqual([]);
  await go(page, 'flight', { destination: 'cinder4' });
  expect(await unpainted(page), 'flight').toEqual([]);
});

test('2. the boot card and the menu wear the drawn lockup and still read ReaLLM (§4.1)', async ({ page }) => {
  await page.goto('/?quality=low&films=off');
  const boot = page.locator('.boot-title');
  await expect(boot).toHaveText('ReaLLM', COLD_START);
  await expect(boot.locator('svg.brand-wordmark')).toHaveCount(1);
  await expect(boot.locator('svg.brand-mark')).toHaveCount(1);
  await page.getByTestId('boot-start').click();
  await settle(page, 'menu');
  const title = page.locator('.screen-menu .screen-title');
  await expect(title).toHaveText('ReaLLM');
  await expect(title.locator('svg.brand-wordmark')).toBeVisible();
  // Every other screen title leads with the reticle.
  await withSave(page);
  await go(page, 'station');
  await expect(page.locator('.screen-station .screen-title svg.screen-mark')).toHaveCount(1);
  await expect(page.locator('.screen-station .screen-title')).toHaveText('Command Relay');
});

test('3. settings opens as a sheet over a scrim, with one frame on screen (§4.3)', async ({ page }) => {
  await start(page, '/');
  await page.getByTestId('menu-settings').click();
  const sheet = page.getByTestId('settings-panel');
  await expect(sheet).toBeVisible();
  await expect(page.locator('.settings-scrim')).toBeVisible();
  expect(await page.locator('.screen-frame:visible').count()).toBe(1);
  expect(await sheet.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(17, 24, 32)');
  await page.getByTestId('settings-close').click();
  await expect(page.locator('.settings-scrim')).toBeHidden();
});

test('4. the board heads the planet with its disc and count, and its rows read short (§4.6)', async ({ page }) => {
  await start(page, '/?seed=123');
  await withSave(page);
  await go(page, 'station');
  const head = page.locator('.board-group').first().locator('.board-planet');
  await expect(head.locator('.board-planet-name')).toHaveText('Cinder-4');
  await expect(head.locator('.board-planet-chapter')).toHaveText('Chapter 1 · Desert');
  await expect(head.locator('.board-planet-count')).toHaveText(/^\d+ open · \d+ locked$/);
  expect(await head.locator('.board-planet-disc').evaluate((node) => getComputedStyle(node).backgroundImage)).toContain('radial-gradient');
  const bonus = page.getByTestId('mission-c1_m2-bonus');
  await expect(bonus).toHaveText('Under 4:00 → +2 Frag Grenade');
  await expect(bonus.locator('.glyph[data-icon="timer"]')).toHaveCount(1);
  await expect(page.getByTestId('mission-c1_m3-drop')).toHaveText('Rocket Launcher');
  await expect(page.getByTestId('mission-c1_m3').locator('.board-locked')).toHaveText('After Black Gold');
  // One line a row: the head, the rewards and the status share a top edge.
  const row = page.getByTestId('mission-c1_m3');
  const [head1, rewards] = await Promise.all([row.locator('.board-head').boundingBox(), row.locator('.board-rewards').boundingBox()]);
  expect(Math.abs((head1?.y ?? 0) + (head1?.height ?? 0) / 2 - ((rewards?.y ?? 0) + (rewards?.height ?? 0) / 2))).toBeLessThanOrEqual(12);
});

test('5. the class cards show an emblem, a tagline and two perks (§4.7)', async ({ page }) => {
  await start(page, '/');
  await go(page, 'creation', { slot: 1 });
  const marine = page.getByTestId('class-marine');
  await expect(marine.locator('.class-emblem svg')).toHaveCount(1);
  await expect(marine.locator('.class-tagline')).toHaveText('Hits harder, lasts longer.');
  await expect(marine.locator('.class-perk')).toHaveText(['+10 % damage', '+20 HP']);
  await expect(marine).toHaveAttribute('title', /^Line infantry, reassigned to salvage\./);
  // The blurb is the card's description: read, not drawn (a 1 × 1 px box).
  await expect(marine.locator('.sr-only .class-blurb')).toHaveCount(1);
  expect((await marine.locator('.sr-only').boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
});

test('6. the star map draws every planet round through a 15° lens (§4.8, E141)', async ({ page }) => {
  await start(page, '/?seed=123');
  await withSave(page);
  await go(page, 'station');
  await go(page, 'starmap', undefined);
  const info = await page.evaluate(() => window.__reallm.stats().sceneInfo);
  expect(Number(info?.['fov'])).toBe(15);
  expect(Number(info?.['roundness'])).toBeLessThanOrEqual(0.03);
});

test('7. pause is a compact frame, and the death card leads with its icon (§4.4, §4.9)', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page, '/?debug&seed=123');
  await withSave(page);
  await go(page, 'surface', { planet: 'cinder4' });
  await page.keyboard.press('Escape');
  const frame = page.locator('.screen-pause .screen-frame');
  await expect(frame).toBeVisible();
  expect((await frame.boundingBox())?.width ?? 0).toBeLessThanOrEqual(322);
  await expect(page.getByTestId('pause-resume').locator('.glyph[data-icon="resume"]')).toHaveCount(1);
  await page.getByTestId('pause-resume').click();
  await expect(frame).toBeHidden();
  const death = page.getByTestId('death-overlay');
  for (let i = 0; i < 12 && !(await death.isVisible()); i++) {
    await page.getByTestId('surface-hurt').click({ force: true });
    await page.waitForTimeout(350);
  }
  await expect(death).toBeVisible();
  await expect(death.locator('.death-title')).toHaveText('SIGNAL LOST');
  await expect(death.locator('.death-title .glyph[data-icon="error"]')).toHaveCount(1);
});
