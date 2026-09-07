// Resize and DPR (SPEC-002 §4.3, §6.2). The one thing that must never happen is
// a drawing buffer whose shape disagrees with the CSS box — that is what makes
// a phone render a stretched picture.
import { expect, test, type Page } from '@playwright/test';
import { frames, start } from './start';

interface Measurement {
  bufferWidth: number;
  bufferHeight: number;
  cssWidth: number;
  cssHeight: number;
  styleWidth: string;
  styleHeight: string;
  dpr: number;
}

async function measure(page: Page): Promise<Measurement> {
  await frames(page, 3); // the pending resize is applied at the start of a render
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas#game') as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    return {
      bufferWidth: canvas.width,
      bufferHeight: canvas.height,
      cssWidth: box.width,
      cssHeight: box.height,
      styleWidth: canvas.style.width,
      styleHeight: canvas.style.height,
      dpr: window.__reallm.stats().dpr,
    };
  });
}

function expectMatchesCss(m: Measurement): void {
  expect(Math.abs(m.bufferWidth - Math.round(m.cssWidth * m.dpr))).toBeLessThanOrEqual(1);
  expect(Math.abs(m.bufferHeight - Math.round(m.cssHeight * m.dpr))).toBeLessThanOrEqual(1);
  // `setSize(w, h, false)`: CSS owns the layout size and the renderer never
  // writes it (AC-14).
  expect(m.styleWidth).toBe('');
  expect(m.styleHeight).toBe('');
}

test('the drawing buffer tracks CSS size × dpr through resizes and rotation (AC-13, AC-14)', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await start(page, '/?debug');
  expectMatchesCss(await measure(page));

  await page.setViewportSize({ width: 760, height: 520 });
  const resized = await measure(page);
  expect(resized.cssWidth).toBeCloseTo(760, 0);
  expectMatchesCss(resized);

  // A device rotation is a viewport whose axes swapped.
  await page.setViewportSize({ width: 520, height: 760 });
  const rotated = await measure(page);
  expect(rotated.cssHeight).toBeGreaterThan(rotated.cssWidth);
  expectMatchesCss(rotated);
});

test('the effective dpr is the clamp of the preset (AC-12, AC-16)', async ({ page }) => {
  await start(page, '/?debug&quality=low');
  const low = await page.evaluate(() => window.__reallm.stats());
  expect(low.preset).toBe('low');
  expect(low.dpr).toBe(Math.min(low.deviceDpr, 1));
  await expect(page.locator('[data-testid="debug-preset"]')).toHaveText('preset low');
  await expect(page.locator('[data-testid="debug-dpr"]')).toHaveText(
    `dpr ${low.dpr.toFixed(2)} of ${low.deviceDpr.toFixed(2)}`,
  );

  // `?quality=` overrides the stored preset without persisting it (AC-67).
  const stored = await page.evaluate(() => window.localStorage.getItem('reallm:settings'));
  expect(stored).toBeNull();
});

test('the size row reports CSS pixels (AC-12)', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await start(page, '/?debug');
  await frames(page, 3);
  const stats = await page.evaluate(() => window.__reallm.stats());
  await expect(page.locator('[data-testid="debug-size"]')).toHaveText(`size ${stats.width}x${stats.height}`);
  expect(stats.width).toBe(900);
});

test('every applied resize emits renderer:resized (AC-15)', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await start(page, '/?debug');
  const events = page.locator('[data-testid="debug-events"]');
  await expect(events).toContainText('renderer:resized');

  // A rotation goes down the same path, so the event fires again and the
  // reported size follows. (`ui:orientation`, emitted beside it, has no
  // consumer until SPEC-015 §6 and is not one of the twelve names §4.6.2
  // permits in this log.)
  const before = ((await events.textContent()) ?? '').split('renderer:resized').length;
  await page.setViewportSize({ width: 600, height: 900 });
  await frames(page, 3);
  const after = ((await events.textContent()) ?? '').split('renderer:resized').length;
  expect(after).toBeGreaterThan(before);

  const rotated = await page.evaluate(() => window.__reallm.stats());
  expect(rotated.height).toBeGreaterThan(rotated.width);
});
