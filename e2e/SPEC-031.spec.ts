// SPEC-031 §6.2 — the console shell, the wallet and the item pictures, in
// four groups: the frame at every mandated size, the wallet's live numbers,
// the pictures on every surface, and the glyph fallback with no files at all.
import { expect, test, type Page } from '@playwright/test';
import { gameUrl, passGate, start } from './start';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 0 },
  difficulty: 'normal',
} as const;

async function go(page: Page, id: string, params: unknown = {}): Promise<boolean> {
  return page.evaluate(
    async ({ id, params }) => {
      const ok = await window.__reallm.go(id, params);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return ok;
    },
    { id, params },
  );
}

/** A save with the §6.2 wallet fixture: 340 tokens, 180/60/45/12. */
async function withSave(page: Page): Promise<void> {
  await page.evaluate((creation) => {
    const data = window.__reallm.save().create(0, creation);
    data.player.tokens = 340;
    data.resources['oil'] = 180;
    data.resources['wheat'] = 60;
    data.resources['water'] = 45;
    data.resources['lithium'] = 12;
  }, CREATION);
}

/** Group 1 — the frame's invariants on whatever screen is up. */
async function checkFrame(page: Page, width: number, height: number, touch = false): Promise<void> {
  const measured = await page.evaluate(() => {
    const doc = document.documentElement;
    const screens = document.querySelectorAll('[data-testid="screen"]:not(.overlay-pause)');
    const visible = [...screens].filter((node) => getComputedStyle(node).display !== 'none');
    const frame = visible[0]?.querySelector('.screen-frame');
    const head = frame?.querySelector('.screen-head');
    const body = frame?.querySelector('.screen-body');
    const centreOf = (el: Element | null | undefined): number => {
      if (!el) return -1;
      const r = el.getBoundingClientRect();
      return r.x + r.width / 2;
    };
    const title = frame?.querySelector('.screen-title');
    const boxes = [...(visible[0]?.querySelectorAll('button, input, [role="button"]') ?? [])]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const host = el.closest('.screen-body');
        const scrollable = host !== null && host.scrollHeight > host.clientHeight;
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height, scrollable, id: (el as HTMLElement).dataset['testid'] ?? el.className };
      });
    const tabs = [...(visible[0]?.querySelectorAll('.screen-tab') ?? [])].map((el) => el.getBoundingClientRect().height);
    return {
      count: visible.length,
      scrollW: doc.scrollWidth,
      clientW: doc.clientWidth,
      headCentre: centreOf(head),
      bodyCentre: centreOf(body),
      titleClipped: title instanceof HTMLElement ? title.scrollWidth > title.clientWidth + 1 : false,
      boxes,
      tabs,
    };
  });
  expect(measured.count, 'exactly one screen root').toBe(1);
  expect(measured.scrollW, 'no horizontal scroll').toBeLessThanOrEqual(measured.clientW);
  expect(Math.abs(measured.headCentre - measured.bodyCentre), 'head and body share a centre').toBeLessThanOrEqual(2);
  expect(measured.titleClipped, 'the title is unclipped').toBe(false);
  for (const box of measured.boxes) {
    expect(box.x, `${box.id} left`).toBeGreaterThanOrEqual(-0.5);
    expect(box.right, `${box.id} right`).toBeLessThanOrEqual(width + 0.5);
    // Content inside the body's own scroll is reachable by scrolling; only
    // the frame's chrome must sit fully inside the viewport vertically.
    if (!box.scrollable) {
      expect(box.y, `${box.id} top`).toBeGreaterThanOrEqual(-0.5);
      expect(box.bottom, `${box.id} bottom`).toBeLessThanOrEqual(height + 0.5);
    }
  }
  for (const tab of measured.tabs) expect(tab, 'tab height').toBeGreaterThanOrEqual(touch ? 56 : 44);
}

const SIZES: readonly [number, number][] = [
  [1920, 1080],
  [800, 600],
  [320, 640],
];

for (const [width, height] of SIZES) {
  test(`frame: every screen holds its grid at ${width}×${height} (AC-12, AC-13, AC-24)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await start(page);
    await withSave(page);
    await checkFrame(page, width, height); // menu

    expect(await go(page, 'station', {})).toBe(true);
    await checkFrame(page, width, height);
    // The station header keeps its channel and containment line (AC-14).
    await expect(page.locator('.screen-channel')).toContainText('COMMAND RELAY · CONTAINMENT LEVEL 1');
    await expect(page.locator('[data-testid="containment-level"]')).toHaveText('Containment level 1');
    for (const tab of ['shop', 'character', 'missions']) {
      await page.locator(`[data-testid="station-tab-${tab}"]`).click();
      await checkFrame(page, width, height);
    }

    expect(await go(page, 'starmap', undefined)).toBe(true);
    await checkFrame(page, width, height);
    // AC-24's must-check: the whole Depart box actually receives the pointer.
    const depart = await page.locator('[data-testid="starmap-depart"]').boundingBox();
    if (!depart) throw new Error('no depart box');
    const hits = await page.evaluate(
      ({ x, y, w, h }) => {
        const probes: string[] = [];
        for (const fx of [0.1, 0.5, 0.9]) {
          for (const fy of [0.2, 0.5, 0.8]) {
            const el = document.elementFromPoint(x + w * fx, y + h * fy);
            probes.push((el?.closest('[data-testid]') as HTMLElement | null)?.dataset['testid'] ?? 'none');
          }
        }
        return probes;
      },
      { x: depart.x, y: depart.y, w: depart.width, h: depart.height },
    );
    for (const hit of hits) expect(hit, 'Depart is operable across its box').toBe('starmap-depart');
  });
}

test('frame: the menu, creation and a paused surface mount one screen each (AC-12, AC-16, AC-17, AC-18)', async ({
  page,
}) => {
  await start(page);
  // The save panel lives inside the frame now (AC-16).
  const panel = await page.locator('[data-testid="save-panel"]').boundingBox();
  const frame = await page.locator('.screen-frame').boundingBox();
  if (!panel || !frame) throw new Error('no panel or frame box');
  expect(panel.x).toBeGreaterThanOrEqual(frame.x);
  expect(panel.x + panel.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
  await expect(page.locator('.save-panel')).toHaveCSS('position', 'static');

  // AC-17: the build label is the footer's right-hand item on DOM screens.
  const label = await page.locator('[data-testid="version-label"]').boundingBox();
  const foot = await page.locator('.screen-foot').boundingBox();
  if (!label || !foot) throw new Error('no label or foot box');
  expect(label.y).toBeGreaterThanOrEqual(foot.y - 1);
  expect(label.x + label.width / 2).toBeGreaterThan(foot.x + foot.width / 2);

  // AC-18: the scene tag is invisible without ?debug, but still Playwright-visible.
  await expect(page.locator('[data-testid="scene-label"]')).toBeVisible();
  await expect(page.locator('[data-testid="scene-label"]')).toHaveCSS('opacity', '0');

  await withSave(page);
  expect(await go(page, 'station', {})).toBe(true);
  expect(await go(page, 'starmap', undefined)).toBe(true);
  expect(await go(page, 'flight', { destination: 'cinder4' })).toBe(true);
  expect(await go(page, 'surface', { planet: 'cinder4' })).toBe(true);
  // In gameplay the label is the corner tag again (AC-17).
  await expect(page.locator('[data-testid="version-label"]')).toHaveCSS('position', 'absolute');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="pause-menu"]')).toBeVisible();
  await expect(page.locator('.screen.overlay-pause .screen-channel')).toContainText('SYSTEM HOLD');
});

test('with ?debug the scene tag reads again (AC-18)', async ({ page }) => {
  await start(page, '/?debug');
  const opacity = await page
    .locator('[data-testid="scene-label"]')
    .evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(opacity).toBeGreaterThan(0);
});

test('wallet: the strip follows the save across tabs and purchases (AC-26, AC-28, AC-29, AC-30, AC-31)', async ({
  page,
}) => {
  await start(page);
  await withSave(page);
  expect(await go(page, 'station', {})).toBe(true);

  const tokens = page.locator('.screen-status [data-testid="wallet-tokens"]');
  await expect(tokens).toContainText('340');
  await expect(page.locator('.screen-status [data-testid="wallet-oil"]')).toContainText('180/400');
  await page.locator('[data-testid="station-tab-shop"]').click();
  await expect(tokens).toContainText('340');

  // The gear price prints its unit (AC-28)…
  await page.locator('[data-testid="shop-tab-gear"]').click();
  await expect(page.locator('[data-testid="shop-gear-pistol_magnum"] .shop-price')).toHaveText(/\d+( → \d+)? tokens/);

  // …the craft row prints each cost against what is held (AC-30)…
  await page.locator('[data-testid="shop-tab-craft"]').click();
  const craftRow = page.locator('[data-testid="shop-craft-medkit"]');
  await expect(craftRow.locator('.shop-price')).toHaveText('10 wheat (60 held) + 10 water (45 held)');
  await craftRow.locator('[data-testid="shop-craft-medkit-plus"]').click();
  await craftRow.locator('[data-testid="shop-craft-medkit-plus"]').click();
  await expect(craftRow.locator('.shop-price')).toContainText('30 wheat (60 held)');
  // …and the craft sheet carries one balance line per resource.
  await craftRow.locator('[data-testid="shop-craft-medkit-buy"]').click();
  await expect(page.locator('.sheet-body')).toContainText('Wheat 60 → 30');
  await expect(page.locator('.sheet-body')).toContainText('Water 45 → 15');
  await page.locator('[data-testid="confirm-no"]').click();

  // A purchase moves the strip with no tab change (AC-26, AC-30).
  await page.locator('[data-testid="shop-tab-ship"]').click();
  await page.locator('[data-testid="shop-ship-cargo-buy"]').click();
  await expect(page.locator('.sheet-body')).toContainText(/Tokens 340 → \d+/);
  await page.locator('[data-testid="confirm-yes"]').click();
  await expect(tokens).not.toContainText('340');

  // The depart sheet names the tank (AC-31).
  expect(await go(page, 'starmap', undefined)).toBe(true);
  await page.locator('[data-testid="starmap-depart"]').click();
  await expect(page.locator('.sheet-body')).toContainText(/Fuel: \d+ oil, charged now — you hold 180\. The return trip is free\./);
  await page.locator('[data-testid="confirm-no"]').click();
});

test('wallet: an unaffordable row prints the exact shortfall (AC-29)', async ({ page }) => {
  await start(page);
  await page.evaluate((creation) => {
    const data = window.__reallm.save().create(0, creation);
    data.player.tokens = 10;
    data.resources['lithium'] = 12;
    // The tier-3 prerequisite is met by wearing the tier below it.
    data.equipped['armor'] = 'armor_reactive';
  }, CREATION);
  expect(await go(page, 'station', {})).toBe(true);
  await page.locator('[data-testid="station-tab-shop"]').click();
  await page.locator('[data-testid="shop-tab-gear"]').click();
  await expect(page.locator('[data-testid="shop-gear-armor_ablative"] .shop-reason')).toHaveText(
    'Need 120 more tokens · Need 68 more lithium',
  );
  await expect(page.locator('[data-testid="shop-gear-armor_ablative-buy"]')).toBeDisabled();
  await expect(page.locator('[data-testid="shop-gear-pistol_magnum"] .shop-reason')).toHaveText('Need 40 more tokens');
  // Every other refusal keeps failText's generic line.
  await expect(page.locator('[data-testid="shop-gear-weapon_plasma"] .shop-reason')).toHaveText('Requires the previous tier');
});

test('wallet: a resource at cap carries the CARGO FULL treatment (AC-27)', async ({ page }) => {
  await start(page);
  await withSave(page);
  await page.evaluate(() => {
    const data = window.__reallm.save().current;
    if (!data) throw new Error('no save');
    data.resources['oil'] = 400;
  });
  expect(await go(page, 'station', {})).toBe(true);
  const oil = page.locator('.screen-status [data-testid="wallet-oil"]');
  await expect(oil).toHaveClass(/at-cap/);
  await expect(oil).toHaveAttribute('aria-label', '400 of 400 oil — cargo full');
  await expect(oil).toContainText('400/400');
  const cues = await oil.evaluate((el) => ({
    marker: getComputedStyle(el, '::after').content,
    weight: getComputedStyle(el.querySelector('.wallet-value') as Element).fontWeight,
  }));
  expect(cues.marker).toContain('▲');
  expect(cues.weight).toBe('700');
  await expect(page.locator('.screen-status [data-testid="wallet-wheat"]')).not.toHaveClass(/at-cap/);
});

test.describe('wallet at 380 px', () => {
  test.use({ viewport: { width: 380, height: 800 } });

  test('drops the /cap denominators and never scrolls (AC-32)', async ({ page }) => {
    await start(page);
    await withSave(page);
    expect(await go(page, 'station', {})).toBe(true);
    const oil = page.locator('.screen-status [data-testid="wallet-oil"]');
    await expect(oil).toContainText('180');
    const capWidth = await oil.locator('.wallet-cap').evaluate((el) => el.getBoundingClientRect().width);
    expect(capWidth).toBe(0);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(scroll).toBe(true);
  });
});

test('pictures: the quick bar, shop rows and gear card carry the icon (AC-38, AC-39)', async ({ page }) => {
  await start(page);
  await withSave(page);
  expect(await go(page, 'station', {})).toBe(true);
  expect(await go(page, 'starmap', undefined)).toBe(true);
  expect(await go(page, 'flight', { destination: 'cinder4' })).toBe(true);
  expect(await go(page, 'surface', { planet: 'cinder4' })).toBe(true);

  // The primary slot shows the icon box with the short name still under it.
  const primary = page.locator('[data-testid="qb-primary"]');
  await expect(primary.locator('[data-testid="icon-weapon_kinetic"]')).toBeVisible();
  await expect(primary).toContainText('Repeater');

  expect(await go(page, 'station', { arrivedFrom: 'cinder4' }, )).toBe(true);
  await page.locator('[data-testid="station-tab-shop"]').click();
  await page.locator('[data-testid="shop-tab-gear"]').click();
  await expect(page.locator('[data-testid="shop-gear-pistol_magnum"] [data-testid="icon-pistol_magnum"]')).toBeVisible();
  await page.locator('[data-testid="shop-tab-craft"]').click();
  await expect(page.locator('[data-testid="shop-craft-medkit"] [data-testid="icon-medkit"]')).toBeVisible();

  // A tap on the row head opens the gear card (AC-39).
  await page.locator('[data-testid="shop-tab-gear"]').click();
  await page.locator('[data-testid="shop-gear-pistol_magnum"] .shop-row-head').click();
  const card = page.locator('[data-testid="gear-card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Hand Cannon');
  await expect(card).toContainText(/DPS \d+/);
  await expect(card).toContainText('T0 → T2'); // the compare line vs the Service Pistol
  // Escape closes it with nothing charged.
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  const before = await page.evaluate(() => window.__reallm.save().current?.player.tokens);

  // Buying from the card drops the wallet and closes the card.
  await page.locator('[data-testid="shop-gear-pistol_magnum-details"]').click();
  await expect(card).toBeVisible();
  await page.locator('[data-testid="gear-card-buy"]').click();
  await page.locator('[data-testid="confirm-yes"]').click();
  await expect(card).toHaveCount(0);
  const after = await page.evaluate(() => window.__reallm.save().current?.player.tokens);
  expect(after).toBeLessThan(before ?? 0);
  await expect(page.locator('.screen-status [data-testid="wallet-tokens"]')).toContainText(String(after));

  // The character panel's gear card wears its icon box (AC-38).
  await page.locator('[data-testid="station-tab-character"]').click();
  await expect(page.locator('[data-testid="loadout-primary"] .icon').first()).toBeVisible();
});

test('fallback: with items/ aborted every surface draws its glyph and logs no error (AC-40)', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    // The net::ERR_FAILED lines are this test's own aborts, not the app's.
    if (message.type() === 'error' && !message.text().includes('net::ERR_FAILED')) errors.push(message.text());
  });
  const itemRequests: string[] = [];
  await page.route('**/assets/items/**', async (route) => {
    itemRequests.push(new URL(route.request().url()).pathname);
    await route.abort();
  });
  await page.goto(gameUrl('/'));
  await passGate(page);
  await withSave(page);
  expect(await go(page, 'station', {})).toBe(true);
  await page.locator('[data-testid="station-tab-shop"]').click();
  await page.locator('[data-testid="shop-tab-gear"]').click();
  const box = page.locator('[data-testid="shop-gear-pistol_magnum"] [data-testid="icon-pistol_magnum"]');
  await expect(box.locator('.icon-glyph')).toBeVisible();
  const size = await box.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  expect(size).toEqual({ w: 40, h: 40 });
  // One manifest request for the whole session, no per-file speculation.
  expect(itemRequests.filter((path) => path.endsWith('manifest.json'))).toHaveLength(1);
  expect(itemRequests.filter((path) => path.endsWith('.webp'))).toHaveLength(0);
  expect(errors).toEqual([]);
});
