// SPEC-012 on a phone-shaped, touch-capable context (AC-11, and the
// automatable half of AC-73): the scheme flips on the first finger, the stick
// moves the pilot camera-relative, an aim drag is rotated by the 45° camera
// yaw, and the pad terminal round-trips a mission accept by tap alone. What
// this cannot prove — real-device feel and fps — stays on the §7 playtest.
import { expect, test, type Page } from '@playwright/test';
import { start, type InputSnapshot } from './start';

test.use({ hasTouch: true, viewport: { width: 420, height: 800 } });

const CREATION = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

const info = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

async function land(page: Page): Promise<void> {
  await start(page, '/?debug&seed=123');
  await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
  await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: true }, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
}

interface Finger {
  type: 'pointerdown' | 'pointermove' | 'pointerup';
  x: number;
  y: number;
}

/** Drive the touch surface directly, the `touch-controls.spec.ts` way. */
async function finger(page: Page, steps: readonly Finger[]): Promise<InputSnapshot> {
  return page.evaluate((events) => {
    const surface = document.querySelector('[data-testid="touch-surface"]');
    if (surface === null) throw new Error('the touch surface is not mounted');
    for (const step of events) {
      surface.dispatchEvent(
        new PointerEvent(step.type, {
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
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

/** A touch button press: the buttons listen for pointerdown/up, not click. */
async function tapButton(page: Page, testid: string): Promise<void> {
  const button = page.locator(`[data-testid="${testid}"]`);
  await button.dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'touch', bubbles: true });
  await page.waitForTimeout(80);
  await button.dispatchEvent('pointerup', { pointerId: 2, pointerType: 'touch', bubbles: true });
}

test('touch drives the surface: stick, yaw-rotated aim drag, terminal by tap (AC-11, AC-73)', async ({ page }) => {
  test.setTimeout(120_000);
  await land(page);

  // The first finger flips the scheme and mounts the layer (SPEC-005 AC-19).
  await finger(page, [
    { type: 'pointerdown', x: 100, y: 700 },
    { type: 'pointerup', x: 100, y: 700 },
  ]);
  await expect.poll(async () => (await page.evaluate(() => window.__reallm.input())).scheme).toBe('touch');
  await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();

  // The stick: hold up for a second — screen-up is world (−1,−1)/√2, so both
  // coordinates fall (§4.3, movement rotated by the camera yaw).
  const before = await info(page);
  await finger(page, [
    { type: 'pointerdown', x: 100, y: 700 },
    { type: 'pointermove', x: 100, y: 620 },
  ]);
  await page.waitForTimeout(1000);
  const mid = await finger(page, [{ type: 'pointerup', x: 100, y: 620 }]);
  expect(mid.scheme).toBe('touch');
  const after = await info(page);
  expect(Number(after['px'])).toBeLessThan(Number(before['px']) - 1);
  expect(Number(after['pz'])).toBeLessThan(Number(before['pz']) - 1);

  // AC-11: an aim drag to screen-right must point the shot at world (+x, −z)
  // — the drag direction rotated by the 45° camera yaw, not raw screen axes.
  await finger(page, [
    { type: 'pointerdown', x: 300, y: 400 },
    { type: 'pointermove', x: 390, y: 400 },
  ]);
  await expect
    .poll(async () => {
      const input = await page.evaluate(() => window.__reallm.input());
      return input.aim.dragging && input.aim.dirX > 0.9;
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const s = await info(page);
      const dx = Number(s['aimX']) - Number(s['px']);
      const dz = Number(s['aimZ']) - Number(s['pz']);
      return dx > 1 && dz < -1 && Math.abs(dx + dz) < 1;
    })
    .toBe(true);
  await finger(page, [{ type: 'pointerup', x: 390, y: 400 }]);

  // AC-73's accept/return flow by tap alone: onto the pad, the USE button
  // opens the terminal, a tap accepts c1_m1, a tap returns to the ship.
  await page.locator('[data-testid="surface-goto-pad"]').dispatchEvent('click');
  const terminal = page.locator('[data-testid="pad-terminal"]');
  for (let i = 0; i < 5; i++) {
    if (await terminal.isVisible()) break;
    await tapButton(page, 'touch-interact');
    await page.waitForTimeout(400);
  }
  await expect(terminal).toBeVisible();
  await page.locator('[data-testid="terminal-accept-c1_m1"]').dispatchEvent('click');
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const active = window.__reallm.save().current?.progress.missionsActive ?? [];
        return active.find((m) => m.id === 'c1_m1')?.stage ?? -1;
      }),
    )
    .toBe(1);
  await page.locator('[data-testid="terminal-return"]').dispatchEvent('click');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
});
