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
