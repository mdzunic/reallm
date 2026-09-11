// The renderer: its drawing surface, resize and DPR (SPEC-002 §4.3, §6.2). The
// one thing that must never happen is a drawing buffer whose shape disagrees
// with the CSS box — that is what makes a phone render a stretched picture.
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

/** The timestamp of the newest `renderer:resized` line in the debug event log. */
async function lastResizeAt(page: Page): Promise<number> {
  const text = (await page.locator('[data-testid="debug-events"]').textContent()) ?? '';
  const stamps = text
    .split('\n')
    .filter((line) => line.includes('renderer:resized'))
    .map((line) => Number(/^(\d+\.\d{2})/.exec(line)?.[1] ?? -1));
  return stamps.length === 0 ? -1 : Math.max(...stamps);
}

/**
 * What the live GL context reports, not what was asked for. Asserting on the
 * constructor arguments would have missed the whole defect this covers: three
 * hardcodes `alpha: true` in the attributes it passes to `getContext()`, so the
 * renderer's own options are not evidence of anything.
 */
async function contextAttributes(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas#game') as HTMLCanvasElement;
    // Asking again for the same context type hands back the live context; the
    // attributes argument is ignored on every call after the first.
    const attributes = (canvas.getContext('webgl2') as WebGL2RenderingContext).getContextAttributes();
    return {
      alpha: attributes?.alpha ?? null,
      stencil: attributes?.stencil ?? null,
      antialias: attributes?.antialias ?? null,
      powerPreference: attributes?.powerPreference ?? null,
      canvases: document.querySelectorAll('canvas').length,
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

test('the one context is opaque, stencil-free and high-performance (AC-11)', async ({ page }) => {
  await start(page, '/?debug&quality=high');
  const high = await contextAttributes(page);
  // One canvas, therefore one renderer: nothing else in the app makes a context.
  expect(high.canvases).toBe(1);
  // The compositor blends a transparent buffer on every frame, and a stencil
  // buffer nothing uses still costs bandwidth: both are fill rate a phone does
  // not have to spare (SPEC-002 §2).
  expect(high.alpha).toBe(false);
  expect(high.stencil).toBe(false);
  expect(high.powerPreference).toBe('high-performance');
  // SPEC-017 D-2: context MSAA never reaches the offscreen target the post
  // chain draws into, so it is off on every preset now and `high` buys its
  // anti-aliasing as `samples` on that target instead (or FXAA past dpr 1.5).
  expect(high.antialias).toBe(false);

  await start(page, '/?debug&quality=medium');
  const medium = await contextAttributes(page);
  expect(medium.alpha).toBe(false);
  expect(medium.stencil).toBe(false);
  expect(medium.antialias).toBe(false);
});

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

  // A rotation goes down the same path, so the event fires again and the
  // reported size follows. (`ui:orientation`, emitted beside it, has no
  // consumer until SPEC-015 §6 and is not one of the twelve names §4.6.2
  // permits in this log.) The log keeps only the last twelve entries, so this
  // compares timestamps rather than counting occurrences.
  const before = await lastResizeAt(page);
  await page.setViewportSize({ width: 600, height: 900 });
  await frames(page, 3);
  await expect.poll(() => lastResizeAt(page)).toBeGreaterThan(before);

  const rotated = await page.evaluate(() => window.__reallm.stats());
  expect(rotated.height).toBeGreaterThan(rotated.width);
});
