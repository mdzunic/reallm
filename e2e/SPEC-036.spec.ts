// SPEC-036 §6.2 — touch that works, in a real browser: the flight's touch aim,
// the boot scheme and tips per scheme, the rotate block, one back-stack for
// Escape and the system Back, pause on blur, the launcher tap, the stick and a
// cancelled finger, the short landscape screen and pause frame, the film wake
// lock, the pad terminal's hold, the words of the controls sheet and the zone
// ghosts. The rules themselves are pinned in node — `tests/core/input.test.ts`,
// `backGuard.test.ts`, `stateMachine.test.ts`, `settings.test.ts`,
// `wakeLock.test.ts`, `tests/systems/*` and `tests/data/content.test.ts`.
//
// Viewports and touch are set per case with `test.use`. A phone context passes
// the gate with a *tap*: every press sets the input scheme (§4.2), and a mouse
// click on START is a mouse's press.
import { devices, expect, test, type Page } from '@playwright/test';
import { awaitGate, COLD_START, frames, gameUrl, start, type InputSnapshot } from './start';

/** §6.2 case 12/13: the short landscape phones. */
const SHORT_LANDSCAPE: readonly [number, number][] = [
  [844, 390],
  [800, 360],
  [750, 342],
  [802, 293],
  [667, 375],
];

/** A landscape phone: coarse pointer, no hover, touch points (§4.2). */
const PHONE = { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true } as const;

/** `use()` inside a describe may not carry `defaultBrowserType`. */
const { defaultBrowserType: _pixelBrowser, ...PIXEL_5 } = devices['Pixel 5'];

/** The words the spec pins; `e2e/` may not import `src/`. */
const ZONES_TOUCH = 'Left thumb moves, right thumb aims — auto-fire shoots for you.';
const MOVE_TOUCH = 'Drag on the left to move. Drag on the right to aim — or let auto-fire do it.';

const CREATION = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 0 },
  difficulty: 'normal',
} as const;

async function sceneInfo(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => window.__reallm.stats().sceneInfo ?? {});
}

async function input(page: Page): Promise<InputSnapshot> {
  return page.evaluate(() => window.__reallm.input());
}

async function settle(page: Page, scene: string): Promise<void> {
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText(scene, COLD_START);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
}

/** Navigate and pass the gate with a tap, as a phone does (§4.2). */
async function startTouch(page: Page, url = '/'): Promise<void> {
  await page.goto(gameUrl(url));
  await awaitGate(page);
  await page.locator('[data-testid="boot-start"]').tap();
  await expect(page.locator('[data-testid="boot-overlay"]')).toBeHidden();
  await expect(page.locator('[data-testid="scene-label"]')).toBeVisible(COLD_START);
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none', COLD_START);
}

interface Finger {
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';
  id: number;
  x: number;
  y: number;
}

/**
 * Several thumbs at once, dispatched on the touch surface itself — beyond what
 * `page.touchscreen` drives. Same listeners, same handlers; the events bubble
 * to `window`, where the driver reads their `pointerType`.
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

/** The `data-testid` of the topmost element at the centre of `testid`, walking up from the hit. */
async function topmostAt(page: Page, testid: string): Promise<string[]> {
  return page.evaluate((id) => {
    const target = document.querySelector(`[data-testid="${id}"]`);
    if (target === null) return [];
    const box = target.getBoundingClientRect();
    const out: string[] = [];
    for (let node = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); node !== null; node = node.parentElement) {
      const tag = (node as HTMLElement).dataset?.['testid'];
      if (tag !== undefined) out.push(tag);
    }
    return out;
  }, testid);
}

/** Whether `testid` lies wholly inside the viewport. */
async function inViewport(page: Page, testid: string): Promise<boolean> {
  return page.evaluate((id) => {
    const target = document.querySelector(`[data-testid="${id}"]`);
    if (target === null) return false;
    const box = target.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.left >= -0.5 && box.top >= -0.5 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5;
  }, testid);
}

/** The stored settings object, as the next boot reads it. */
async function storedSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('reallm:settings') ?? '{}') as Record<string, unknown>);
}

/**
 * Stored settings for the first boot of the page — once, so a reload inside
 * the test reads what the game itself wrote back. Storage on the initial
 * `about:blank` throws, and that document is simply skipped.
 */
async function seedSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.addInitScript((values) => {
    try {
      if (sessionStorage.getItem('reallm-e2e-seeded') !== null) return;
      sessionStorage.setItem('reallm-e2e-seeded', '1');
      localStorage.setItem('reallm:settings', JSON.stringify({ version: 1, ...values }));
    } catch {
      /* a document with no storage of its own */
    }
  }, patch);
}

/**
 * Playwright resizes a phone by resizing its window, which a fullscreen window
 * refuses; the Android boot tap takes one (SPEC-015 AC-33). Step out first.
 */
async function leaveFullscreen(page: Page): Promise<void> {
  await page.evaluate(async () => {
    try {
      if (document.fullscreenElement !== null) await document.exitFullscreen();
    } catch {
      /* not fullscreen after all */
    }
  });
  await frames(page, 3);
}

// ------------------------------------------------------------ 1: flight aim

test.describe('1. the flight aims straight ahead on touch (§4.1)', () => {
  test.use(PHONE);

  test('the thumb steers, the reticle keeps to the ship’s lane, and nothing writes the hover aim', async ({ page }) => {
    await startTouch(page, '/?scene=flight&planet=cinder4');
    await settle(page, 'flight');
    expect((await input(page)).scheme).toBe('touch');
    // A tap on the play surface ends the launch shot (SPEC-032 §4.2).
    await fingers(page, [
      { type: 'pointerdown', id: 9, x: 700, y: 120 },
      { type: 'pointerup', id: 9, x: 700, y: 120 },
    ]);
    await expect.poll(async () => Number((await sceneInfo(page))['launch']), { timeout: 20_000 }).toBe(1);

    const samples: Array<Record<string, number | string>> = [];
    let state = await fingers(page, [{ type: 'pointerdown', id: 1, x: 150, y: 300 }]);
    for (const x of [175, 200, 230, 260, 260, 230, 200, 175, 150]) {
      state = await fingers(page, [{ type: 'pointermove', id: 1, x, y: 300 }]);
      expect(state.aim.hasPointer, 'a finger is never a hover').toBe(false);
      await frames(page, 3);
      samples.push(await sceneInfo(page));
    }
    state = await fingers(page, [{ type: 'pointerup', id: 1, x: 150, y: 300 }]);
    expect(state.aim.hasPointer).toBe(false);
    expect(state.scheme).toBe('touch');

    for (const info of samples) {
      expect(Math.abs(Number(info['reticleX']) - Number(info['shipX'])), 'reticleX follows shipX').toBeLessThanOrEqual(0.5);
      expect(Math.abs(Number(info['reticleY']) - Number(info['shipY'])), 'reticleY follows shipY').toBeLessThanOrEqual(0.5);
    }
    // The thumb really steered: the ship moved, and the reticle went with it.
    const xs = samples.map((info) => Number(info['shipX']));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.2);
  });
});

// ------------------------------------------------- 2, 3: boot scheme, tips

test.describe('2, 3. a phone boots on touch, and tips are remembered per scheme (§4.2)', () => {
  test.use(PHONE);

  test('2. before any canvas touch the scheme is touch, the layer is up and the zones tip speaks of thumbs', async ({ page }) => {
    await page.goto(gameUrl('/?scene=surface&planet=cinder4'));
    await awaitGate(page);
    // Nothing has touched the page: the boot scheme is the device's own answer.
    expect((await input(page)).scheme).toBe('touch');
    await page.locator('[data-testid="boot-start"]').tap();
    await settle(page, 'surface');
    expect((await input(page)).scheme).toBe('touch');
    await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();
    await expect(page.locator('[data-testid="aria-hint"]')).toHaveText(ZONES_TOUCH, { timeout: 20_000 });
    // §4.12: showing the zones tip records it and the touch `move` tip it covers.
    await expect.poll(async () => (await storedSettings(page))['tipsSeen']).toEqual(
      expect.arrayContaining(['zones@touch', 'move@touch']),
    );
  });

  test('3. a keyboard `move` seen before still leaves the touch wording due, once', async ({ page }) => {
    await seedSettings(page, { tipsSeen: ['move'], zonesShown: 2 });
    await startTouch(page, '/?scene=surface&planet=cinder4');
    await settle(page, 'surface');
    await expect(page.locator('[data-testid="aria-hint"]')).toHaveText(MOVE_TOUCH, { timeout: 20_000 });
    await expect.poll(async () => (await storedSettings(page))['tipsSeen']).toEqual(['move', 'move@touch']);
    // zonesShown was already 2: no ghosts this landing.
    await expect(page.locator('[data-testid="touch-zone-move"]')).toBeHidden();
  });
});

// ------------------------------------------------------------ 4, 5: rotate

test.describe('4. a surface entered upright holds until the phone is turned (§4.3)', () => {
  test.use(PIXEL_5);

  test('held from the first step with no pause menu, covered, and playing once landscape', async ({ page }) => {
    await startTouch(page, '/?scene=surface&planet=cinder4');
    await settle(page, 'surface');
    const rotate = page.locator('[data-testid="rotate-overlay"]');
    await expect(rotate).toHaveClass(/is-visible/);
    await expect.poll(async () => Number((await sceneInfo(page))['held'])).toBe(1);
    await expect(page.locator('[data-testid="pause-menu"]')).toBeHidden();

    // The cover is the whole viewport, near-black, above everything the player could press.
    const cover = await rotate.evaluate((el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      return {
        zIndex: style.zIndex,
        background: style.backgroundColor,
        full: box.left <= 0 && box.top <= 0 && box.right >= innerWidth && box.bottom >= innerHeight,
        topmost: hit !== null && el.contains(hit),
      };
    });
    expect(cover).toEqual({ zIndex: '51', background: 'rgba(0, 0, 0, 0.92)', full: true, topmost: true });

    // A thumb on the stick moves nothing, and the world clock stands still.
    const before = await sceneInfo(page);
    await fingers(page, [
      { type: 'pointerdown', id: 1, x: 60, y: 600 },
      { type: 'pointermove', id: 1, x: 120, y: 540 },
    ]);
    await page.waitForTimeout(2000);
    const after = await sceneInfo(page);
    await fingers(page, [{ type: 'pointerup', id: 1, x: 120, y: 540 }]);
    expect(after['px']).toBe(before['px']);
    expect(after['pz']).toBe(before['pz']);
    expect(after['viewTime']).toBe(before['viewTime']);
    expect(Number(after['held'])).toBe(1);

    // Turned to landscape: the cover goes, the hold ends, and play starts — no pause menu.
    await leaveFullscreen(page);
    await page.setViewportSize({ width: 727, height: 393 });
    await frames(page, 3);
    await expect(rotate).not.toHaveClass(/is-visible/);
    await expect.poll(async () => Number((await sceneInfo(page))['held'])).toBe(0);
    await expect(page.locator('[data-testid="pause-menu"]')).toBeHidden();
    const running = Number((await sceneInfo(page))['viewTime']);
    await expect.poll(async () => Number((await sceneInfo(page))['viewTime'])).toBeGreaterThan(running);
  });
});

test.describe('5. turned upright mid-play, and back (§4.3, E65)', () => {
  test.use({ viewport: { width: 727, height: 393 }, hasTouch: true, isMobile: true });

  test('the cover goes over the pause menu, and turning back leaves the pause menu topmost', async ({ page }) => {
    await startTouch(page, '/?scene=surface&planet=cinder4');
    await settle(page, 'surface');
    const rotate = page.locator('[data-testid="rotate-overlay"]');
    const pause = page.locator('[data-testid="pause-menu"]');
    await expect(rotate).not.toHaveClass(/is-visible/);
    await expect(pause).toBeHidden();

    await page.setViewportSize({ width: 393, height: 727 });
    await frames(page, 3);
    await expect(rotate).toHaveClass(/is-visible/);
    // E22: the turn paused the game, and the pause menu is under the cover.
    await expect(pause).toBeVisible();
    expect(await topmostAt(page, 'pause-resume')).toContain('rotate-overlay');
    expect(Number((await sceneInfo(page))['held'])).toBe(1);

    await page.setViewportSize({ width: 727, height: 393 });
    await frames(page, 3);
    await expect(rotate).not.toHaveClass(/is-visible/);
    await expect(pause).toBeVisible();
    expect((await topmostAt(page, 'pause-resume'))[0]).toBe('pause-resume');
  });
});

// ------------------------------------------------------ 6, 7: Escape, Back

test.describe('6. one Escape for every layer (§4.4)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('on the surface: pause, then Settings closes alone, then the game resumes', async ({ page }) => {
    await start(page, '/?scene=surface&planet=cinder4');
    await settle(page, 'surface');
    const pause = page.locator('[data-testid="pause-menu"]');
    const settings = page.locator('[data-testid="settings-panel"]');

    await page.keyboard.press('Escape');
    await expect(pause).toBeVisible();
    await page.locator('[data-testid="pause-settings"]').click();
    await expect(settings).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await expect(pause).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(pause).toBeHidden();
    // Resumed, not merely hidden: the world clock runs again.
    const at = Number((await sceneInfo(page))['viewTime']);
    await expect.poll(async () => Number((await sceneInfo(page))['viewTime'])).toBeGreaterThan(at);
  });

  test('on the star map Escape reaches the station', async ({ page }) => {
    await start(page, '/?scene=starmap');
    await settle(page, 'starmap');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  });

  test('at the menu Escape closes the open sub-panel', async ({ page }) => {
    await start(page);
    await page.locator('[data-testid="menu-credits"]').click();
    await expect(page.locator('[data-testid="credits-text"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="credits-text"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
  });
});

test.describe('7. the system Back routes as Escape does (§4.4, E66)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('on the surface Back pauses, and Back again resumes, without leaving the page', async ({ page }) => {
    await start(page, '/?scene=surface&planet=cinder4');
    await settle(page, 'surface');
    const pause = page.locator('[data-testid="pause-menu"]');
    const url = page.url();

    await page.goBack();
    await expect(pause).toBeVisible();
    expect(await page.evaluate(() => window.__reallm.scene())).toBe('surface');
    expect(page.url()).toBe(url);

    await page.goBack();
    await expect(pause).toBeHidden();
    expect(await page.evaluate(() => window.__reallm.scene())).toBe('surface');
    const at = Number((await sceneInfo(page))['viewTime']);
    await expect.poll(async () => Number((await sceneInfo(page))['viewTime'])).toBeGreaterThan(at);
  });

  test('at the menu root with nothing open, Back leaves the game’s page', async ({ page }) => {
    await start(page);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
    const url = page.url();
    await page.goBack();
    await expect.poll(() => page.url()).not.toBe(url);
    expect(page.url()).not.toContain('localhost');
  });
});

// ---------------------------------------------------------- 8: pause on blur

test.describe('8. a lost focus pauses (§4.5, E67)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('a blur pauses the surface, and focus resumes nothing', async ({ page }) => {
    await start(page, '/?scene=surface&planet=cinder4');
    await settle(page, 'surface');
    const pause = page.locator('[data-testid="pause-menu"]');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(pause).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await frames(page, 5);
    await expect(pause).toBeVisible();

    // The setting is on the panel, where its rows are today.
    await page.locator('[data-testid="pause-settings"]').click();
    const toggle = page.locator('[data-testid="settings-pause-on-blur"]');
    await expect(toggle).toBeChecked();
    await expect(toggle).toHaveAttribute('aria-label', 'Pause when the game loses focus');
    await expect(page.locator('[data-testid="settings-panel"]')).toContainText('Pause when the game loses focus');
  });

  test('with pauseOnBlur off, a blur releases input and play goes on', async ({ page }) => {
    await seedSettings(page, { pauseOnBlur: false });
    await start(page, '/?scene=surface&planet=cinder4');
    await settle(page, 'surface');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await frames(page, 10);
    await expect(page.locator('[data-testid="pause-menu"]')).toBeHidden();
    const at = Number((await sceneInfo(page))['viewTime']);
    await expect.poll(async () => Number((await sceneInfo(page))['viewTime'])).toBeGreaterThan(at);
  });
});

// ---------------------------------------------------------- 9: launcher tap

test.describe('9. a launcher tap fires it on touch (§4.6)', () => {
  test.use(PHONE);

  test('one charge flies, the weapon in hand stays, and a second tap says it is recharging', async ({ page }) => {
    await startTouch(page, '/?debug&scene=surface&planet=cinder4');
    await settle(page, 'surface');
    // The debug strip is pressed without a pointer, so the scheme stays touch.
    await page.locator('[data-testid="surface-arsenal"]').dispatchEvent('click');
    await page.locator('[data-testid="surface-spawn-pack"]').dispatchEvent('click');
    await expect.poll(async () => (await sceneInfo(page))['charges']).toBe(1);
    expect((await sceneInfo(page))['weaponSlot']).toBe('primary');

    await page.evaluate(() => {
      const audio = window.__reallm.audio();
      const scope = window as unknown as { __launcherVoices: number };
      scope.__launcherVoices = 0;
      const play = audio.play.bind(audio);
      (audio as { play: typeof audio.play }).play = (id, opts) => {
        const voice = play(id, opts);
        if (id === 'shot_launcher' && voice !== null) scope.__launcherVoices++;
        return voice;
      };
    });

    await page.getByTestId('qb-heavy').tap();
    await expect.poll(async () => page.evaluate(() => (window as unknown as { __launcherVoices: number }).__launcherVoices)).toBe(1);
    await expect.poll(async () => (await sceneInfo(page))['charges']).toBe(0);
    expect((await sceneInfo(page))['weaponSlot']).toBe('primary');
    expect((await input(page)).scheme).toBe('touch');

    // 36-j: nothing fires while it recharges, and it says so.
    await page.getByTestId('qb-heavy').tap();
    await expect(page.locator('[data-testid="toasts"]')).toContainText('Launcher recharging');
    await frames(page, 10);
    expect(await page.evaluate(() => (window as unknown as { __launcherVoices: number }).__launcherVoices)).toBe(1);
    expect((await sceneInfo(page))['weaponSlot']).toBe('primary');
  });
});

// ------------------------------------------------------- 10, 11: the stick

test.describe('10, 11. the stick’s curve and a cancelled finger (§4.7)', () => {
  test.use(PHONE);

  test('10. 34 px of travel is full speed; 8 px is nothing', async ({ page }) => {
    await startTouch(page, '/?scene=surface&planet=cinder4');
    await settle(page, 'surface');
    let state = await fingers(page, [
      { type: 'pointerdown', id: 1, x: 100, y: 250 },
      { type: 'pointermove', id: 1, x: 134, y: 250 },
    ]);
    expect(Math.hypot(state.move.x, state.move.y)).toBeGreaterThanOrEqual(0.99);
    await fingers(page, [{ type: 'pointerup', id: 1, x: 134, y: 250 }]);

    state = await fingers(page, [
      { type: 'pointerdown', id: 2, x: 100, y: 250 },
      { type: 'pointermove', id: 2, x: 108, y: 250 },
    ]);
    expect(state.move).toEqual({ x: 0, y: 0 });
    await fingers(page, [{ type: 'pointerup', id: 2, x: 108, y: 250 }]);
  });

  test('11. a cancelled finger drops its own role and no other', async ({ page }) => {
    await startTouch(page, '/?scene=surface&planet=cinder4');
    await settle(page, 'surface');
    // Finger 1 on the stick, finger 2 dragging in the aim zone.
    const both = await fingers(page, [
      { type: 'pointerdown', id: 1, x: 100, y: 250 },
      { type: 'pointermove', id: 1, x: 134, y: 250 },
      { type: 'pointerdown', id: 2, x: 600, y: 200 },
      { type: 'pointermove', id: 2, x: 650, y: 150 },
    ]);
    expect(both.aim.dragging).toBe(true);
    expect(both.buttons['fire']?.down).toBe(true);

    const cancelledAim = await fingers(page, [{ type: 'pointercancel', id: 2, x: 650, y: 150 }]);
    expect(cancelledAim.move).toEqual(both.move);
    expect(cancelledAim.aim.dragging).toBe(false);

    await fingers(page, [
      { type: 'pointerdown', id: 2, x: 600, y: 200 },
      { type: 'pointermove', id: 2, x: 650, y: 150 },
    ]);
    const cancelledStick = await fingers(page, [{ type: 'pointercancel', id: 1, x: 134, y: 250 }]);
    expect(cancelledStick.buttons['fire']?.down).toBe(true);
    expect(cancelledStick.aim.dragging).toBe(true);
    expect(cancelledStick.move).toEqual({ x: 0, y: 0 });
    await fingers(page, [{ type: 'pointerup', id: 2, x: 650, y: 150 }]);
  });
});

// ------------------------------------------- 12, 13: short landscape screens

for (const [width, height] of SHORT_LANDSCAPE) {
  test.describe(`12, 13. a short landscape phone at ${width}×${height} (§4.8)`, () => {
    test.use({ viewport: { width, height }, hasTouch: true, isMobile: true });

    test('12. every station tab is on screen and pressable, and the body keeps half the height', async ({ page }) => {
      await startTouch(page);
      await page.evaluate((creation) => void window.__reallm.save().create(0, creation), CREATION);
      expect(await page.evaluate(() => window.__reallm.go('station', {}))).toBe(true);
      await settle(page, 'station');
      const tabs = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid^="station-tab-"]')].map((el) => el.dataset['testid'] ?? ''),
      );
      expect(tabs.length).toBeGreaterThanOrEqual(6);
      for (const tab of tabs) {
        expect(await inViewport(page, tab), `${tab} inside the viewport`).toBe(true);
        expect((await topmostAt(page, tab))[0], `${tab} topmost at its centre`).toBe(tab);
      }
      const share = await page.evaluate(() => {
        const screens = [...document.querySelectorAll('[data-testid="screen"]')].filter((node) => getComputedStyle(node).display !== 'none');
        const body = screens[0]?.querySelector('.screen-body');
        return (body?.getBoundingClientRect().height ?? 0) / innerHeight;
      });
      expect(share).toBeGreaterThanOrEqual(0.5);
    });

    test('13. with Controls open, Resume is on screen and topmost', async ({ page }) => {
      await startTouch(page, '/?scene=surface&planet=cinder4');
      await settle(page, 'surface');
      await page.locator('[data-testid="touch-pause"]').tap();
      await expect(page.locator('[data-testid="pause-menu"]')).toBeVisible();
      await page.locator('[data-testid="pause-controls"]').tap();
      await expect(page.locator('[data-testid="pause-sheet"]')).toBeVisible();
      expect(await inViewport(page, 'pause-resume')).toBe(true);
      expect((await topmostAt(page, 'pause-resume'))[0]).toBe('pause-resume');
    });
  });
}

// ------------------------------------------------------ 14: film wake lock

test.describe('14. a film holds the screen on, and Back leaves it alone (§4.9, §4.4)', () => {
  test.use({ viewport: { width: 1280, height: 720 }, reducedMotion: 'no-preference' });

  test('the prologue takes one lock, and a skip hands it back', async ({ page }) => {
    await page.addInitScript(() => {
      const counts = { requests: 0, releases: 0 };
      (window as unknown as { __wake: typeof counts }).__wake = counts;
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          request: async () => {
            counts.requests++;
            return {
              release: async () => {
                counts.releases++;
              },
            };
          },
        },
      });
    });
    // Posters, not the video: the film runs the same timeline either way.
    await page.route('**/assets/films/*.mp4', (route) => route.abort());
    const wake = (): Promise<{ requests: number; releases: number }> =>
      page.evaluate(() => ({ ...(window as unknown as { __wake: { requests: number; releases: number } }).__wake }));

    await start(page, '/?films=on');
    // The boot tap's own lock goes back on the first scene (SPEC-015 §7).
    await expect.poll(async () => (await wake()).releases).toBe(1);
    const before = await wake();

    await page.locator('[data-testid="menu-new"]').click();
    await page.locator('[data-testid="new-slot-0"]').click();
    await expect(page.locator('[data-testid="film"]')).toHaveAttribute('data-film', 'prologue');
    await expect.poll(async () => (await wake()).requests).toBe(before.requests + 1);
    expect((await wake()).releases).toBe(before.releases);

    // §4.4, 36-e: the film owns the screen — a system Back does nothing to it,
    // and the page stays where it is.
    const url = page.url();
    await page.goBack();
    await frames(page, 5);
    await expect(page.locator('[data-testid="film"]')).toHaveAttribute('data-film', 'prologue');
    expect(page.url()).toBe(url);
    expect((await wake()).releases).toBe(before.releases);

    // Past the skip grace (SPEC-022 §4.5), then skip.
    await page.waitForTimeout(400);
    await page.locator('[data-testid="film-skip"]').click();
    await expect(page.locator('[data-testid="film"]')).toHaveCount(0);
    await expect.poll(async () => (await wake()).releases).toBe(before.releases + 1);
    expect((await wake()).requests).toBe(before.requests + 1);
  });
});

// ------------------------------------------------------ 15: the pad terminal

test.describe('15. the pad terminal holds the world (§4.10)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('open, it holds; Escape, E and Close each close it, and the pause menu stays down', async ({ page }) => {
    await start(page, '/?debug&scene=surface&planet=cinder4');
    await settle(page, 'surface');
    await expect.poll(async () => Number((await sceneInfo(page))['held'])).toBe(0);
    await page.locator('[data-testid="surface-goto-pad"]').click();
    const terminal = page.locator('[data-testid="pad-terminal"]');

    const open = async (): Promise<void> => {
      for (let i = 0; i < 6; i++) {
        if (await terminal.isVisible()) break;
        await page.keyboard.press('KeyE');
        await page.waitForTimeout(300);
      }
      await expect(terminal).toBeVisible();
      await expect.poll(async () => Number((await sceneInfo(page))['held'])).toBe(1);
    };
    const closed = async (): Promise<void> => {
      await expect(terminal).toBeHidden();
      await expect.poll(async () => Number((await sceneInfo(page))['held'])).toBe(0);
      await expect(page.locator('[data-testid="pause-menu"]')).toBeHidden();
    };

    await open();
    // Held: the world clock stands still while it is open.
    const at = (await sceneInfo(page))['viewTime'];
    await page.waitForTimeout(500);
    expect((await sceneInfo(page))['viewTime']).toBe(at);
    await page.keyboard.press('Escape');
    await closed();

    await open();
    await page.keyboard.press('KeyE');
    await closed();

    await open();
    await page.locator('[data-testid="terminal-close"]').click();
    await closed();
  });
});

// ------------------------------------------------------------- 16: the words

test.describe('16. the controls sheet matches the touch controls (§4.11)', () => {
  test.use(PHONE);

  test('in flight the throttle is the ▲ / ▼ buttons, never a drag', async ({ page }) => {
    await startTouch(page, '/?scene=flight&planet=cinder4');
    await settle(page, 'flight');
    await page.locator('[data-testid="touch-pause"]').tap();
    await expect(page.locator('[data-testid="pause-menu"]')).toBeVisible();
    await page.locator('[data-testid="pause-controls"]').tap();
    const sheet = page.locator('[data-testid="pause-sheet"]');
    await expect(sheet).toContainText('▲ / ▼ buttons');
    await expect(sheet).not.toContainText('Drag up / down');
    await expect(sheet).toContainText('Tap its slot to fire it');
    await expect(sheet).toContainText('Tap the minimap');
    await expect(sheet).toContainText('Tap the tracker');
    await expect(sheet).toContainText('USE');
  });
});

// ------------------------------------------------------------- 17: the zones

test.describe('17. the zone ghosts show on the first two touch landings (§4.12)', () => {
  test.use(PHONE);

  test('first and second landing show them, a stick move or 12 s takes them down, the third shows none', async ({ page }) => {
    await startTouch(page, '/?scene=surface&planet=cinder4');
    await settle(page, 'surface');
    const move = page.locator('[data-testid="touch-zone-move"]');
    const aim = page.locator('[data-testid="touch-zone-aim"]');
    await expect(move).toBeVisible();
    await expect(aim).toBeVisible();
    await expect(move).toContainText('MOVE');
    await expect(aim).toContainText('DRAG TO AIM');
    await expect(move).toHaveCSS('pointer-events', 'none');
    await expect(aim).toHaveCSS('pointer-events', 'none');
    expect((await storedSettings(page))['zonesShown']).toBe(1);

    await fingers(page, [
      { type: 'pointerdown', id: 1, x: 100, y: 250 },
      { type: 'pointermove', id: 1, x: 130, y: 240 },
      { type: 'pointerup', id: 1, x: 130, y: 240 },
    ]);
    await expect(move).toBeHidden();
    await expect(aim).toBeHidden();

    const land = async (): Promise<void> => {
      expect(await page.evaluate(() => window.__reallm.go('station', {}))).toBe(true);
      await settle(page, 'station');
      expect(
        await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: false }, { force: true })),
      ).toBe(true);
      await settle(page, 'surface');
    };

    await land();
    await expect(move).toBeVisible();
    await expect(aim).toBeVisible();
    expect((await storedSettings(page))['zonesShown']).toBe(2);
    // Left alone, they stay a while and then go by themselves — 12 s after
    // they showed, a clock that started with the scene, before its fade-in.
    await page.waitForTimeout(4_000);
    await expect(move).toBeVisible();
    await expect(move).toBeHidden({ timeout: 12_000 });
    await expect(aim).toBeHidden();

    await land();
    await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();
    await expect(move).toBeHidden();
    await expect(aim).toBeHidden();
    expect((await storedSettings(page))['zonesShown']).toBe(2);
  });

  test('never in a ?perf run', async ({ page }) => {
    await startTouch(page, '/?perf&scene=surface&planet=cinder4');
    await settle(page, 'surface');
    await expect(page.locator('[data-testid="touch-controls"]')).toBeVisible();
    await expect(page.locator('[data-testid="touch-zone-move"]')).toBeHidden();
    await expect(page.locator('[data-testid="touch-zone-aim"]')).toBeHidden();
    expect((await storedSettings(page))['zonesShown'] ?? 0).toBe(0);
  });
});
