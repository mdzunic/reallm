// SPEC-005 in a real browser (§6). `tests/core/input.test.ts` already proves
// every driver against fake targets in node; this file is what only a browser
// can settle: real `KeyboardEvent`/`PointerEvent` dispatch against `window`,
// `document` and the actual canvas, and the touch layer's DOM.
// `e2e/touch-controls.spec.ts` already guards the scheme/mount contract
// (AC-19, AC-20) and the surface stick/aim/flight-layout basics (AC-11, AC-13,
// AC-14, AC-15, AC-27); this file fills what QA found still open: the
// keyboard/mouse driver end to end, the floating-stick drift past 1.6x the
// radius, a tap's queued edge pair, every touch button's hit size, the
// `setPointerCapture` fallback, the flight touch zones and the keyboard
// aim-assist blend.
import { expect, test, type Page } from '@playwright/test';
import { gameUrl, start, type InputSnapshot } from './start';

async function settle(page: Page, scene: string): Promise<void> {
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText(scene);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
}

test.describe('keyboard/mouse driver against the real DOM', () => {
  test('bindings, repeat and the editable-target guard (AC-4, AC-5, AC-7, AC-8)', async ({ page }) => {
    await start(page, '/?scene=surface');
    await settle(page, 'surface');

    // AC-4, AC-8: WASD combine into a normalized diagonal.
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyD');
    let state = await page.evaluate<InputSnapshot>(() => window.__reallm.input());
    expect(state.move.x).toBeCloseTo(Math.SQRT1_2, 5);
    expect(state.move.y).toBeCloseTo(Math.SQRT1_2, 5);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('KeyD');

    // AC-5: an auto-repeat keydown is not a fresh press.
    const repeatIgnored = await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', repeat: true, bubbles: true, cancelable: true }));
      return window.__reallm.input().move;
    });
    expect(repeatIgnored).toEqual({ x: 0, y: 0 });

    // AC-7: a key typed into an editable element never reaches the game.
    const editable = await page.evaluate(() => {
      const input = document.createElement('input');
      document.body.append(input);
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true, cancelable: true }));
      const move = { ...window.__reallm.input().move };
      input.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true, cancelable: true }));
      input.remove();
      return move;
    });
    expect(editable).toEqual({ x: 0, y: 0 });
  });

  test('preventDefault only in a gameplay scene, never for an unbound key (AC-6)', async ({ page }) => {
    await start(page, '/?scene=surface');
    await settle(page, 'surface');

    const inGameplay = await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
      window.dispatchEvent(ev);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true, cancelable: true }));
      return ev.defaultPrevented;
    });
    expect(inGameplay).toBe(true);

    const unbound = await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { code: 'KeyZ', bubbles: true, cancelable: true });
      window.dispatchEvent(ev);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyZ', bubbles: true, cancelable: true }));
      return ev.defaultPrevented;
    });
    expect(unbound).toBe(false);

    await page.evaluate(() => window.__reallm.go('menu', { reason: 'quit' }, { force: true }));
    await settle(page, 'menu');
    const inMenu = await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
      window.dispatchEvent(ev);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true, cancelable: true }));
      return ev.defaultPrevented;
    });
    expect(inMenu).toBe(false);
  });

  test('mouse fire, the reserved right button, and aim NDC (AC-23, AC-24, AC-26)', async ({ page }) => {
    await start(page, '/?scene=surface');
    await settle(page, 'surface');

    const result = await page.evaluate(() => {
      const canvas = document.getElementById('game') as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent('pointermove', { pointerType: 'mouse', clientX: rect.width - 10, clientY: 10, bubbles: true, cancelable: true }),
      );
      const aim = { ...window.__reallm.input().aim };

      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', button: 0, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
      const downFire = window.__reallm.input().buttons['fire']?.down;
      window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse', button: 0, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
      const upFire = window.__reallm.input().buttons['fire']?.down;

      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', button: 2, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
      const anyDownAfterButton2 = Object.values(window.__reallm.input().buttons).some((b) => b.down);
      const ctx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      canvas.dispatchEvent(ctx);
      window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse', button: 2, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));

      return { aim, downFire, upFire, anyDownAfterButton2, ctxPrevented: ctx.defaultPrevented };
    });

    expect(result.aim.hasPointer).toBe(true);
    expect(result.aim.ndcX).toBeGreaterThan(0.9);
    expect(result.aim.ndcY).toBeGreaterThan(0.9);
    expect(result.downFire).toBe(true);
    expect(result.upFire).toBe(false);
    expect(result.anyDownAfterButton2).toBe(false);
    expect(result.ctxPrevented).toBe(true);
  });

  test('the scheme follows the last-used device, including pen (AC-19)', async ({ page }) => {
    await start(page, '/?scene=surface');
    await settle(page, 'surface');

    const schemes = await page.evaluate(() => {
      const canvas = document.getElementById('game') as HTMLCanvasElement;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyM', bubbles: true, cancelable: true }));
      const keyboard = window.__reallm.input().scheme;

      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'pen', pointerId: 501, clientX: 5, clientY: 5, bubbles: true, cancelable: true }));
      const pen = window.__reallm.input().scheme;
      window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'pen', pointerId: 501, clientX: 5, clientY: 5, bubbles: true, cancelable: true }));

      canvas.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 6, clientY: 6, bubbles: true, cancelable: true }));
      const mouse = window.__reallm.input().scheme;
      return { keyboard, pen, mouse };
    });
    expect(schemes).toEqual({ keyboard: 'keyboard', pen: 'touch', mouse: 'keyboard' });
  });

  test('releaseAll on blur, a hidden tab, pointercancel and a scene transition (AC-10)', async ({ page }) => {
    await start(page, '/?scene=surface');
    await settle(page, 'surface');

    const blur = await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true, cancelable: true }));
      const before = { ...window.__reallm.input().move };
      window.dispatchEvent(new Event('blur'));
      const after = { ...window.__reallm.input().move };
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true, cancelable: true })); // must not resurrect it
      const afterStaleKeyUp = { ...window.__reallm.input().move };
      return { before, after, afterStaleKeyUp };
    });
    expect(blur.before).toEqual({ x: 0, y: 1 });
    expect(blur.after).toEqual({ x: 0, y: 0 });
    expect(blur.afterStaleKeyUp).toEqual({ x: 0, y: 0 });

    const hidden = await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', bubbles: true, cancelable: true }));
      const before = { ...window.__reallm.input().move };
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      const after = { ...window.__reallm.input().move };
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', bubbles: true, cancelable: true }));
      return { before, after };
    });
    expect(hidden.before).toEqual({ x: 1, y: 0 });
    expect(hidden.after).toEqual({ x: 0, y: 0 });

    const cancel = await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true, cancelable: true }));
      const before = { ...window.__reallm.input().move };
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'mouse', bubbles: true, cancelable: true }));
      const after = { ...window.__reallm.input().move };
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', bubbles: true, cancelable: true }));
      return { before, after };
    });
    expect(cancel.before).toEqual({ x: -1, y: 0 });
    expect(cancel.after).toEqual({ x: 0, y: 0 });

    const transition = await page.evaluate(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', bubbles: true, cancelable: true }));
      const before = { ...window.__reallm.input().move };
      await window.__reallm.go('station', {}, { force: true });
      await new Promise((r) => setTimeout(r, 300));
      const after = { ...window.__reallm.input().move };
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyS', bubbles: true, cancelable: true }));
      return { before, after };
    });
    expect(transition.before).toEqual({ x: 0, y: -1 });
    expect(transition.after).toEqual({ x: 0, y: 0 });
  });

  test('two sources holding one action release independently (AC-22)', async ({ page }) => {
    await start(page, '/?scene=station');

    const result = await page.evaluate(() => {
      const canvas = document.getElementById('game') as HTMLCanvasElement;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true }));
      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', button: 0, clientX: 1, clientY: 1, bubbles: true, cancelable: true }));
      const bothHeld = window.__reallm.input().buttons['fire']?.down;
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true, cancelable: true }));
      const stillHeld = window.__reallm.input().buttons['fire']?.down;
      window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse', button: 0, clientX: 1, clientY: 1, bubbles: true, cancelable: true }));
      const released = window.__reallm.input().buttons['fire']?.down;
      return { bothHeld, stillHeld, released };
    });
    expect(result).toEqual({ bothHeld: true, stillHeld: true, released: false });
  });
});

test.describe('autoFire settings (AC-18)', () => {
  test('touch (default) enables only on the touch scheme; on/off force it', async ({ page }) => {
    await start(page, '/?scene=surface');
    await settle(page, 'surface');

    const touchDefault = await page.evaluate(() => {
      const canvas = document.getElementById('game') as HTMLCanvasElement;
      const onKeyboard = window.__reallm.input().autoFire;
      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 900, clientX: 5, clientY: 5, bubbles: true, cancelable: true }));
      const onTouch = window.__reallm.input().autoFire;
      window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 900, clientX: 5, clientY: 5, bubbles: true, cancelable: true }));
      return { onKeyboard, onTouch };
    });
    expect(touchDefault).toEqual({ onKeyboard: false, onTouch: true });
  });

  test('"on" and "off" override the scheme', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'on' })));
    await start(page, '/?scene=surface');
    await settle(page, 'surface');
    expect(await page.evaluate(() => window.__reallm.input().autoFire)).toBe(true);

    await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off' })));
    await page.evaluate(() => localStorage.setItem('reallm:settings', JSON.stringify({ autoFire: 'off' })));
    await page.reload();
    await start(page, '/?scene=surface');
    await settle(page, 'surface');
    const offOnTouch = await page.evaluate(() => {
      const canvas = document.getElementById('game') as HTMLCanvasElement;
      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 901, clientX: 5, clientY: 5, bubbles: true, cancelable: true }));
      const autoFire = window.__reallm.input().autoFire;
      window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 901, clientX: 5, clientY: 5, bubbles: true, cancelable: true }));
      return autoFire;
    });
    expect(offOnTouch).toBe(false);
  });
});

test.describe('touch layer: gaps the static review flagged', () => {
  test.use({ hasTouch: true });

  test('a tap in the aim zone queues exactly one press+release edge pair (AC-2, AC-12)', async ({ page }) => {
    // The queued edge lives for exactly one `beginFrame()`..`endFrame()` pair,
    // which the running game's own render loop publishes and clears within a
    // single synchronous tick — no external read can land inside that window.
    // An isolated `Input`/`TouchControls` pair with nobody else driving its
    // frames lets the test step `beginFrame`/`endFrame` itself and observe the
    // pulse directly, using the exact same production modules the app ships.
    await page.goto(gameUrl('/'));
    const result = await page.evaluate(async () => {
      const { Input } = await import('/src/core/Input.ts');
      const { createSettings } = await import('/src/core/Settings.ts');
      const { TouchControls } = await import('/src/ui/TouchControls.ts');
      const input = new Input();
      const root = document.createElement('div');
      document.body.append(root);
      const tc = new TouchControls(root, input, createSettings());
      input.setScheme('touch');
      tc.show('surface');
      const surface = root.querySelector('[data-testid="touch-surface"]') as HTMLElement;

      function dispatch(type: string, x: number, y: number): void {
        surface.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
      }
      // Aim zone: x past 45% of a 1280-wide surface.
      dispatch('pointerdown', 900, 400);
      dispatch('pointerup', 900, 400);
      input.beginFrame(1 / 60);
      const published = { ...input.state.buttons['fire'] };
      input.endFrame();
      const cleared = { justPressed: input.state.buttons['fire']?.justPressed, justReleased: input.state.buttons['fire']?.justReleased };
      tc.dispose();
      root.remove();
      return { published, cleared };
    });
    expect(result.published).toMatchObject({ down: false, justPressed: true, justReleased: true });
    expect(result.cleared).toEqual({ justPressed: false, justReleased: false });
  });

  test('the floating stick origin follows the thumb past 1.6x the radius (AC-11)', async ({ page }) => {
    await start(page, '/?scene=surface');
    await settle(page, 'surface');
    await page.touchscreen.tap(240, 400);
    await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();

    const stick = page.locator('[data-testid="touch-stick"]');
    const surface = page.locator('[data-testid="touch-surface"]');

    async function fingers(steps: readonly { type: string; x: number; y: number }[]): Promise<InputSnapshot> {
      return page.evaluate((events) => {
        const el = document.querySelector('[data-testid="touch-surface"]');
        if (el === null) throw new Error('not mounted');
        for (const step of events) {
          el.dispatchEvent(
            new PointerEvent(step.type, { pointerId: 7, pointerType: 'touch', clientX: step.x, clientY: step.y, bubbles: true, cancelable: true }),
          );
        }
        return window.__reallm.input();
      }, steps);
    }
    void surface;

    const originX = 240;
    const originY = 400;
    await fingers([{ type: 'pointerdown', x: originX, y: originY }]);
    // Well past the 89.6 px drift threshold (56 px radius x 1.6).
    const far = await fingers([{ type: 'pointermove', x: originX + 200, y: originY }]);
    expect(far.move).toEqual({ x: 1, y: 0 });
    let transform = await stick.evaluate((el) => el.style.transform);
    expect(transform).toBe(`translate(${originX + 200 - 89.6}px, ${originY}px)`);

    // Dragging further still keeps full deflection and the origin keeps following.
    const further = await fingers([{ type: 'pointermove', x: originX + 260, y: originY }]);
    expect(further.move).toEqual({ x: 1, y: 0 });
    transform = await stick.evaluate((el) => el.style.transform);
    expect(transform).toBe(`translate(${originX + 260 - 89.6}px, ${originY}px)`);

    await fingers([{ type: 'pointerup', x: originX + 260, y: originY }]);
  });

  test('every touch button meets the 56 px hit size, not just pause (AC-16)', async ({ page }) => {
    await start(page, '/?scene=flight');
    await settle(page, 'flight');
    await page.touchscreen.tap(240, 400);
    await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();

    for (const testId of ['touch-throttleUp', 'touch-throttleDown', 'touch-pause']) {
      const box = await page.locator(`[data-testid="${testId}"]`).boundingBox();
      expect(box?.width ?? 0, testId).toBeGreaterThanOrEqual(56);
      expect(box?.height ?? 0, testId).toBeGreaterThanOrEqual(56);
    }
  });

  test('setPointerCapture is called for a zone pointer, and losing it does not freeze tracking (AC-25)', async ({ page }) => {
    await start(page, '/?scene=surface');
    await settle(page, 'surface');
    await page.touchscreen.tap(240, 400);
    await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();

    const result = await page.evaluate(() => {
      const surface = document.querySelector('[data-testid="touch-surface"]') as HTMLElement;
      const calls: number[] = [];
      const original = surface.setPointerCapture.bind(surface);
      surface.setPointerCapture = (id: number) => {
        calls.push(id);
        return original(id); // a synthetic id the browser never granted: exercises the catch path
      };
      function dispatch(type: string, x: number, y: number): void {
        surface.dispatchEvent(new PointerEvent(type, { pointerId: 55, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
      }
      dispatch('pointerdown', 200, 400);
      dispatch('pointermove', 220, 420);
      const midDrag = { ...window.__reallm.input().move };
      dispatch('pointerup', 220, 420);
      const afterUp = { ...window.__reallm.input().move };
      surface.setPointerCapture = original;
      return { calls, midDrag, afterUp };
    });
    expect(result.calls).toEqual([55]);
    expect(result.midDrag).not.toEqual({ x: 0, y: 0 });
    expect(result.afterUp).toEqual({ x: 0, y: 0 });
  });

  test('flight touch: the steer zone returns to 0 with no stick, the fire zone holds on contact (AC-28)', async ({ page }) => {
    await start(page, '/?scene=flight');
    await settle(page, 'flight');
    await page.touchscreen.tap(240, 400);
    await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();

    const result = await page.evaluate(() => {
      const surface = document.querySelector('[data-testid="touch-surface"]') as HTMLElement;
      const stick = document.querySelector('[data-testid="touch-stick"]') as HTMLElement;
      function dispatch(type: string, id: number, x: number, y: number): void {
        surface.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
      }
      // Steer zone: left 60 % of a 1280-wide surface.
      dispatch('pointerdown', 10, 300, 400);
      dispatch('pointermove', 10, 340, 360);
      const steering = { move: { ...window.__reallm.input().move }, stickHidden: stick.classList.contains('is-hidden') };
      dispatch('pointerup', 10, 340, 360);
      const afterSteerRelease = { ...window.__reallm.input().move };

      // Fire zone: right 40 % — hold-to-fire the instant it is touched.
      dispatch('pointerdown', 11, 1000, 400);
      const fireOnDown = window.__reallm.input().buttons['fire']?.down;
      dispatch('pointerup', 11, 1000, 400);
      const fireAfterRelease = window.__reallm.input().buttons['fire']?.down;
      return { steering, afterSteerRelease, fireOnDown, fireAfterRelease };
    });
    expect(result.steering.stickHidden).toBe(true);
    expect(result.steering.move.x).toBeCloseTo(Math.SQRT1_2, 5);
    expect(result.steering.move.y).toBeCloseTo(Math.SQRT1_2, 5);
    expect(result.afterSteerRelease).toEqual({ x: 0, y: 0 });
    expect(result.fireOnDown).toBe(true);
    expect(result.fireAfterRelease).toBe(false);
  });
});

test.describe('isolated Input/TouchControls (no scene wires these yet)', () => {
  // No scene calls `setInteractHint` or `setEnabled` yet (SPEC-012/014 land the
  // callers), so there is nothing in the running game to drive these from. The
  // production modules are exercised directly instead — the same technique the
  // AC-12 test above uses — which is still a real browser DOM, just not the
  // shared game singleton.
  test('setInteractHint shows, labels and re-hides the interact button (AC-17)', async ({ page }) => {
    await page.goto(gameUrl('/'));
    const result = await page.evaluate(async () => {
      const { Input } = await import('/src/core/Input.ts');
      const { createSettings } = await import('/src/core/Settings.ts');
      const { TouchControls } = await import('/src/ui/TouchControls.ts');
      const input = new Input();
      input.setScheme('touch');
      const root = document.createElement('div');
      document.body.append(root);
      const tc = new TouchControls(root, input, createSettings());
      tc.show('surface');
      const button = root.querySelector('[data-testid="touch-interact"]') as HTMLElement;
      const before = button.classList.contains('is-hidden');
      tc.setInteractHint('SCAN');
      const shown = { hidden: button.classList.contains('is-hidden'), label: button.textContent };
      tc.setInteractHint(null);
      const after = button.classList.contains('is-hidden');
      tc.dispose();
      root.remove();
      return { before, shown, after };
    });
    expect(result.before).toBe(true);
    expect(result.shown).toEqual({ hidden: false, label: 'SCAN' });
    expect(result.after).toBe(true);
  });

  test('setEnabled(false) reads released and does not replay on re-enable (AC-21)', async ({ page }) => {
    await page.goto(gameUrl('/'));
    const result = await page.evaluate(async () => {
      const { Input } = await import('/src/core/Input.ts');
      const input = new Input();
      input.pressAction('fire', 'keyboard');
      input.setMove(1, 0, 'keyboard');
      const before = { down: input.state.buttons['fire']?.down, move: { ...input.state.move } };
      input.setEnabled(false);
      const whileDisabled = { down: input.state.buttons['fire']?.down, move: { ...input.state.move } };
      input.pressAction('interact', 'keyboard'); // driver writes are dropped while disabled
      const writeWhileDisabled = input.state.buttons['interact']?.down;
      input.setEnabled(true);
      const afterReenable = { fire: input.state.buttons['fire']?.down, interact: input.state.buttons['interact']?.down };
      return { before, whileDisabled, writeWhileDisabled, afterReenable };
    });
    expect(result.before).toEqual({ down: true, move: { x: 1, y: 0 } });
    expect(result.whileDisabled).toEqual({ down: false, move: { x: 0, y: 0 } });
    expect(result.writeWhileDisabled).toBe(false);
    expect(result.afterReenable).toEqual({ fire: false, interact: false });
  });
});

test.describe('flight aim-assist (AC-29)', () => {
  test('mouse aim blends keyboard steering toward the reticle only when the setting is on', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ flightMouseSteer: true })));
    await start(page, '/?scene=flight');
    await settle(page, 'flight');

    const withAssist = await page.evaluate(() => {
      const canvas = document.getElementById('game') as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent('pointermove', { pointerType: 'mouse', clientX: rect.width - 5, clientY: 5, bubbles: true, cancelable: true }),
      );
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true, cancelable: true }));
      const move = { ...window.__reallm.input().move };
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true, cancelable: true }));
      return move;
    });
    // Pure keyboard-up would be (0, 1); the reticle in the top-right corner
    // pulls it away from a pure axis on both components.
    expect(withAssist.x).toBeGreaterThan(0.01);
    expect(withAssist.y).toBeLessThan(1);
    expect(withAssist.y).toBeGreaterThan(0.5);
  });

  test('turning the setting off leaves keyboard steering alone', async ({ page }) => {
    // Written out rather than relying on the default: SPEC-007 §3 ships
    // `flightMouseSteer` on, and what AC-29 asks is that the blend follow the
    // setting — so both halves of it name the value they are testing.
    await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ flightMouseSteer: false })));
    await start(page, '/?scene=flight');
    await settle(page, 'flight');

    const withoutAssist = await page.evaluate(() => {
      const canvas = document.getElementById('game') as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent('pointermove', { pointerType: 'mouse', clientX: rect.width - 5, clientY: 5, bubbles: true, cancelable: true }),
      );
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true, cancelable: true }));
      const move = { ...window.__reallm.input().move };
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true, cancelable: true }));
      return move;
    });
    expect(withoutAssist).toEqual({ x: 0, y: 1 });
  });
});
