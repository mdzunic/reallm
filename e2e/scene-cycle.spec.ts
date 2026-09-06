// SPEC-003 §6: cycling scenes must not grow GPU memory. The numbers come from
// the `?debug` readout (`geo <n> tex <n>` from `renderer.gl.info.memory`,
// D-41), which is the same thing a developer watches on a phone.
//
// Transitions are driven through the dev-only `window.__reallm` bridge so the
// test awaits the transition's own outcome instead of racing the UI.
import { expect, test, type Page } from '@playwright/test';

interface SceneBridge {
  go(id: string, params: unknown, opts?: { force?: boolean }): Promise<boolean>;
  scene(): string | null;
  memory(): { geometries: number; textures: number };
}

declare global {
  interface Window {
    __reallm: SceneBridge;
  }
}

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

async function memory(page: Page): Promise<{ geo: number; tex: number }> {
  const text = (await page.locator('[data-testid="debug-memory"]').textContent()) ?? '';
  const match = /geo (\d+) tex (\d+)/.exec(text);
  if (!match) throw new Error(`unexpected ?debug readout: "${text}"`);
  return { geo: Number(match[1]), tex: Number(match[2]) };
}

test.describe('scene cycling', () => {
  // 0 ms fades, so 40 transitions do not cost 24 s of wall clock (D-16).
  test.use({ reducedMotion: 'reduce' });

  test('station ↔ starmap 20 times leaves GPU memory where it started (AC-33, AC-34)', async ({ page }) => {
    await page.goto('/?debug');
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');

    expect(await go(page, 'station', {})).toBe(true);
    // The baseline is taken after one full cycle, once every geometry and
    // texture either scene builds has been uploaded at least once.
    expect(await go(page, 'starmap', undefined)).toBe(true);
    expect(await go(page, 'station', {})).toBe(true);
    const baseline = await memory(page);
    expect(baseline.geo).toBeGreaterThan(0); // the readout is live, not stuck at 0
    expect(baseline.tex).toBeGreaterThan(0);

    for (let cycle = 0; cycle < 20; cycle++) {
      expect(await go(page, 'starmap', undefined)).toBe(true);
      expect(await go(page, 'station', {})).toBe(true);
    }

    const after = await memory(page);
    expect(Math.abs(after.geo - baseline.geo)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.tex - baseline.tex)).toBeLessThanOrEqual(2);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  });
});

test('the fade covers the screen for its whole 300 ms (AC-38, AC-39)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
  const fade = page.locator('[data-testid="transition-fade"]');
  await expect(fade).toHaveCSS('pointer-events', 'none');

  const started = Date.now();
  const transition = page.evaluate(() => window.__reallm.go('station', {}));
  // While it runs, the overlay swallows every pointer event (D-15).
  await expect(fade).toHaveCSS('pointer-events', 'auto');
  await expect(transition).resolves.toBe(true);

  // Two 300 ms fades, so the round trip cannot be instant (D-13).
  expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  await expect(fade).toHaveCSS('pointer-events', 'none');
});
