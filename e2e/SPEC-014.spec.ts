// SPEC-014 §4.4: the star map's touch targets are DOM buttons projected over
// the Three spheres. The projection runs in `onEnter()`, *before* the scene's
// first render — a stale `camera.matrixWorldInverse` once put every button
// thousands of pixels off-screen while the spheres drew correctly underneath,
// so this suite pins the part no other test touches: the buttons land inside
// the viewport immediately on entry, and clicking one actually selects it
// (AC-50, AC-52, AC-53).
import { expect, test, type Page } from '@playwright/test';
import { start } from './start';

const PLANETS = ['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden'];

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/** One transition, plus the frame that actually draws the scene we landed in. */
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

test.describe('star map nodes', () => {
  // 0 ms fades (D-16); node placement is JS projection, not CSS motion.
  test.use({ reducedMotion: 'reduce' });

  test('all six node buttons land inside the viewport on entry (AC-50, AC-52)', async ({ page }) => {
    await start(page);
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);

    const viewport = page.viewportSize();
    if (!viewport) throw new Error('viewport size unavailable');
    for (const planet of PLANETS) {
      const node = page.locator(`[data-testid="map-node-${planet}"]`);
      await expect(node).toBeVisible();
      const box = await node.boundingBox();
      if (!box) throw new Error(`map-node-${planet} has no box`);
      // Inside the viewport — not at the projection of a stale view matrix.
      expect(box.x, `${planet} left`).toBeGreaterThanOrEqual(0);
      expect(box.y, `${planet} top`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${planet} right`).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height, `${planet} bottom`).toBeLessThanOrEqual(viewport.height);
    }
  });

  test('tapping a node selects it and the info panel follows (AC-52, AC-53)', async ({ page }) => {
    await start(page);
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);

    // Cinder-4 is the default selection; Vetra is a click away.
    await expect(page.locator('[data-testid="map-node-cinder4"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="starmap-info-name"]')).toHaveText('Cinder-4');

    await page.locator('[data-testid="map-node-vetra"]').click();
    await expect(page.locator('[data-testid="map-node-vetra"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="map-node-cinder4"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-testid="starmap-info-name"]')).toHaveText('Vetra');
  });
});

test.describe('depart confirm sheet', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a triple-tap on the sheet charges fuel exactly once (AC-56)', async ({ page }) => {
    await start(page);
    await page.evaluate((creation) => {
      const data = window.__reallm.save().create(0, creation);
      // A fresh save's 60 oil covers one trip; the bug needs room for three.
      data.resources['oil'] = 200;
    }, CREATION);
    expect(await go(page, 'station', {})).toBe(true);
    expect(await go(page, 'starmap', undefined)).toBe(true);

    // Fuel and oil exactly as the info panel states them (AC-53).
    const fuelLine = await page.locator('[data-testid="starmap-fuel"]').textContent();
    const stated = /Fuel: (\d+) oil \(have (\d+)\)/.exec(fuelLine ?? '');
    if (!stated) throw new Error(`unexpected fuel line: ${fuelLine ?? 'null'}`);
    const fuel = Number(stated[1]);
    const oil = Number(stated[2]);
    expect(fuel).toBeGreaterThan(0);
    expect(oil).toBeGreaterThanOrEqual(3 * fuel); // the bug needs room to triple-charge

    await page.locator('[data-testid="starmap-depart"]').click();
    await expect(page.locator('[data-testid="confirm-yes"]')).toBeVisible();
    // Three synchronous taps on the same button. The second and third land on a
    // detached-but-listening node — exactly how a fast double-tap once re-ran
    // `payFuel` through the sheet's confirm callback and drained oil 3×.
    await page.evaluate(() => {
      const yes = document.querySelector('[data-testid="confirm-yes"]');
      if (!(yes instanceof HTMLButtonElement)) throw new Error('confirm button missing');
      yes.click();
      yes.click();
      yes.click();
    });

    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
    const after = await page.evaluate(() => window.__reallm.save().current?.resources['oil']);
    expect(after).toBe(oil - fuel);
  });
});

test.describe('reduce motion', () => {
  test('the in-app toggle drives html.reduce-motion both ways (AC-88, AC-110)', async ({ page }) => {
    await start(page);
    // Playwright's default is no OS preference, so the setting starts off.
    await expect(page.locator('html')).not.toHaveClass(/reduce-motion/);

    await page.locator('[data-testid="menu-settings"]').click();
    const toggle = page.locator('[data-testid="settings-reduce-motion"]');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(page.locator('html')).toHaveClass(/reduce-motion/);

    // Not just a class: an animated affordance actually goes static (AC-66).
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'toast toast-info';
      probe.dataset['testid'] = 'motion-probe';
      probe.textContent = 'probe';
      document.getElementById('ui')?.append(probe);
    });
    const animation = await page.evaluate(
      () => getComputedStyle(document.querySelector('[data-testid="motion-probe"]')!).animationName,
    );
    expect(animation).toBe('none');

    await toggle.uncheck();
    await expect(page.locator('html')).not.toHaveClass(/reduce-motion/);
  });

  test.describe('with the OS preference set', () => {
    test.use({ reducedMotion: 'reduce' });

    test('prefers-reduced-motion arrives through the same class (AC-110)', async ({ page }) => {
      await start(page);
      await expect(page.locator('html')).toHaveClass(/reduce-motion/);
    });
  });
});
