// The touch layer end to end (SPEC-005 §6). Everything else about the input
// system is unit-tested in node; what only a browser can show is the pair of
// rules that decide whether the layer exists at all: the scheme follows the
// last-used device (AC-19) and the controls render only while that scheme is
// touch (AC-20).
//
// The context is touch-capable. SPEC-036 §4.2 boots a device whose primary
// pointer is coarse with no hover on the touch scheme, so the case that pins a
// keyboard start makes that query answer no — a touchscreen laptop, a touch
// device with a keyboard, where nothing is assumed until a finger lands — and
// a phone-shaped context pins the other half: the layer is up before any touch.
import { expect, test, type Page } from '@playwright/test';
import { awaitGate, COLD_START, gameUrl, start, type InputSnapshot } from './start';

test.use({ hasTouch: true });

/** SPEC-036 §4.2: the boot scheme's media query. */
const COARSE_POINTER_QUERY = '(hover: none) and (pointer: coarse)';

/**
 * A touchscreen laptop: touch-capable, but its primary pointer is a mouse, so
 * `matchMedia(COARSE_POINTER_QUERY)` does not match and the page boots on the
 * keyboard (SPEC-036 §4.13).
 */
async function touchscreenLaptop(page: Page): Promise<void> {
  await page.addInitScript((query) => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (asked: string): MediaQueryList => {
      const list = original(asked);
      if (asked !== query) return list;
      return new Proxy(list, {
        get: (target, key) => {
          if (key === 'matches') return false;
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    };
  }, COARSE_POINTER_QUERY);
}

/** Wait for a `?scene=` jump to have finished fading in (SPEC-003 AC-14). */
async function settle(page: Page, scene: string): Promise<void> {
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText(scene);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
}

interface Finger {
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';
  id: number;
  x: number;
  y: number;
}

/**
 * Two thumbs at once is beyond `page.touchscreen`, which drives one finger, so
 * the multi-touch cases dispatch the pointer events themselves. Same listeners,
 * same handlers — only the source of the events differs.
 */
async function fingers(page: Page, steps: readonly Finger[]): Promise<InputSnapshot> {
  return page.evaluate((events) => {
    const surface = document.querySelector('[data-testid="touch-surface"]');
    if (surface === null) throw new Error('the touch surface is not mounted');
    for (const step of events) {
      surface.dispatchEvent(
        new PointerEvent(step.type, {
          pointerId: step.id,
          pointerType: 'touch',
          isPrimary: step.id === 1,
          clientX: step.x,
          clientY: step.y,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    return window.__reallm.input();
  }, steps);
}

/** The viewport the tests reason about, so the 45 % zone split is arithmetic. */
async function viewport(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

test('the surface layout appears with the first touch, and not before (AC-19, AC-20)', async ({ page }) => {
  await touchscreenLaptop(page);
  await start(page, '/?scene=surface');
  await settle(page, 'surface');

  // Booted on the keyboard scheme: the layer is not in the DOM at all.
  await expect(page.locator('[data-testid="touch-controls"]')).toHaveCount(0);

  await page.touchscreen.tap(240, 400);
  await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();

  // The surface layout: item and pause, no throttle, and no interact button
  // until a scene sets a hint (AC-17, AC-27).
  await expect(page.locator('[data-testid="touch-useItem"]')).toBeVisible();
  await expect(page.locator('[data-testid="touch-pause"]')).toBeVisible();
  await expect(page.locator('[data-testid="touch-interact"]')).toBeHidden();
  await expect(page.locator('[data-testid="touch-throttleUp"]')).toBeHidden();
  await expect(page.locator('[data-testid="touch-reticle"]')).toBeHidden();

  // AC-16: a thumb-sized hit box, and the rules that stop a long press from
  // selecting text or opening the iOS callout.
  const pause = page.locator('[data-testid="touch-pause"]');
  const box = await pause.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(56);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);
  await expect(pause).toHaveCSS('touch-action', 'none');
  await expect(pause).toHaveCSS('user-select', 'none');

  // AC-26: neither the canvas nor the UI layer may scroll or pinch-zoom.
  await expect(page.locator('canvas#game')).toHaveCSS('touch-action', 'none');
  await expect(page.locator('#ui')).toHaveCSS('touch-action', 'none');

  // …and a key hands the scheme back, which takes the layer away again (AC-20).
  await page.keyboard.press('KeyM');
  await expect(page.locator('[data-testid="touch-controls"]')).toHaveCount(0);
});

test('a thumb in the move zone raises a floating stick and steers (AC-11)', async ({ page }) => {
  await start(page, '/?scene=surface');
  await settle(page, 'surface');
  await page.touchscreen.tap(240, 400);
  await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();

  const size = await viewport(page);
  const stick = page.locator('[data-testid="touch-stick"]');
  await expect(stick).toBeHidden();

  // Land inside the left 45 %: the stick appears where the thumb is.
  const originX = Math.round(size.width * 0.2);
  const originY = Math.round(size.height * 0.6);
  await fingers(page, [{ type: 'pointerdown', id: 1, x: originX, y: originY }]);
  await expect(stick).toBeVisible();
  await expect(stick).toHaveCSS('transform', new RegExp(`${originX}, ${originY}\\)$`));

  // Push it up and to the right; y is up in `move`, screen y is down.
  const pushed = await fingers(page, [{ type: 'pointermove', id: 1, x: originX + 40, y: originY - 40 }]);
  expect(pushed.move.x).toBeGreaterThan(0.4);
  expect(pushed.move.y).toBeGreaterThan(0.4);
  expect(Math.hypot(pushed.move.x, pushed.move.y)).toBeLessThanOrEqual(1.0001);

  // AC-15: a second finger in the same zone is ignored until the first lifts.
  const second = await fingers(page, [
    { type: 'pointerdown', id: 2, x: originX - 20, y: originY },
    { type: 'pointermove', id: 2, x: originX - 100, y: originY },
  ]);
  expect(second.move.x).toBeCloseTo(pushed.move.x, 5);
  expect(second.move.y).toBeCloseTo(pushed.move.y, 5);

  // Lifting returns the steering to zero and takes the stick away.
  const lifted = await fingers(page, [{ type: 'pointerup', id: 1, x: originX + 40, y: originY - 40 }]);
  expect(lifted.move).toEqual({ x: 0, y: 0 });
  await expect(stick).toBeHidden();
});

test('a drag in the aim zone aims and holds fire, alongside the stick (AC-13, AC-14)', async ({ page }) => {
  await start(page, '/?scene=surface');
  await settle(page, 'surface');
  await page.touchscreen.tap(240, 400);
  await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();

  const size = await viewport(page);
  const moveX = Math.round(size.width * 0.2);
  const aimX = Math.round(size.width * 0.75);
  const y = Math.round(size.height * 0.6);

  // One thumb steers, the other aims — at the same time (AC-14).
  const both = await fingers(page, [
    { type: 'pointerdown', id: 1, x: moveX, y },
    { type: 'pointermove', id: 1, x: moveX + 40, y },
    { type: 'pointerdown', id: 2, x: aimX, y },
    // Inside the 12 px slop this is still a tap, not a drag.
    { type: 'pointermove', id: 2, x: aimX + 6, y },
  ]);
  expect(both.move.x).toBeGreaterThan(0.4);
  expect(both.aim.dragging).toBe(false);
  expect(both.buttons['fire']?.down).toBe(false);

  // Past the slop it becomes a drag: fire is held and the direction is set.
  const dragging = await fingers(page, [{ type: 'pointermove', id: 2, x: aimX + 60, y: y - 60 }]);
  expect(dragging.aim.dragging).toBe(true);
  expect(dragging.buttons['fire']?.down).toBe(true);
  expect(dragging.aim.dirX).toBeCloseTo(Math.SQRT1_2, 5);
  expect(dragging.aim.dirY).toBeCloseTo(Math.SQRT1_2, 5);
  expect(dragging.move.x).toBeGreaterThan(0.4); // the other thumb never stopped

  const released = await fingers(page, [{ type: 'pointerup', id: 2, x: aimX + 60, y: y - 60 }]);
  expect(released.aim.dragging).toBe(false);
  expect(released.buttons['fire']?.down).toBe(false);
  expect(released.move.x).toBeGreaterThan(0.4);
});

test('the flight layout swaps the buttons for throttle and a reticle (AC-27, AC-28)', async ({ page }) => {
  await start(page, '/?scene=flight');
  await settle(page, 'flight');

  await page.touchscreen.tap(240, 400);
  await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();
  await expect(page.locator('[data-testid="touch-throttleUp"]')).toBeVisible();
  await expect(page.locator('[data-testid="touch-throttleDown"]')).toBeVisible();
  await expect(page.locator('[data-testid="touch-pause"]')).toBeVisible();
  await expect(page.locator('[data-testid="touch-reticle"]')).toBeVisible();
  await expect(page.locator('[data-testid="touch-useItem"]')).toBeHidden();
  await expect(page.locator('[data-testid="touch-interact"]')).toBeHidden();
});

test.describe('on a phone (SPEC-036 §4.2)', () => {
  test.use({ viewport: { width: 844, height: 390 }, isMobile: true });

  test('the layer is mounted before any touch lands', async ({ page }) => {
    await page.goto(gameUrl('/?scene=surface'));
    await awaitGate(page);
    // Nothing has touched the page yet: the scheme is the device's own answer.
    expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('touch');
    // START is a tap, as on a phone — a mouse click would be a mouse's press.
    await page.locator('[data-testid="boot-start"]').tap();
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface', COLD_START);
    await settle(page, 'surface');
    await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();
    await expect(page.locator('[data-testid="touch-pause"]')).toBeVisible();
    expect(await page.evaluate(() => window.__reallm.input().scheme)).toBe('touch');
  });
});
