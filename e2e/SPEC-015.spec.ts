// SPEC-015 §12 — the parts that only a browser can answer: the dynamic-viewport
// canvas, the on-screen keyboard's reflow (AC-29), the rotate overlay and its
// auto-pause (AC-30, AC-32, AC-33) and the settings benchmark row (AC-20).
//
// This file is the one §12 runs in both Playwright projects (D-8), and the two
// runs are not the same test:
//
//   - `chromium` is Desktop Chrome. It reports `navigator.maxTouchPoints === 0`
//     however narrow its window is, so the cases that need the shipped phone
//     heuristic (`maxTouchPoints > 0 && min(w, h) < 620`, D-5) rewrite that one
//     property in an init script and resize the window to a phone's shape.
//   - `mobile` is Playwright's `Pixel 5`: real touch points, a 393×851 screen
//     and a 2.75 device pixel ratio, on the Android user agent. Nothing is
//     faked there — which also means it is the run that meets AC-33's boot-tap
//     fullscreen, and a fullscreen window cannot be resized (`leaveFullscreen`).
//
// A handful of cases only make sense on one side; each says which and why.
// The keyboard is emulated the only way a headless run can do it: a CDP
// device-metrics override that shrinks the visual viewport the way a keyboard
// does, which is the in-container half of AC-29's evidence — the
// physical-handset pass is owed before `m7` (D-15, docs/playtest-log.md).
import { expect, test, type Page } from '@playwright/test';
import { frames, gameUrl, passGate, start } from './start';

const PHONE = { width: 740, height: 360 };
const PHONE_PORTRAIT = { width: 360, height: 740 };

/** A character, for the cases that need a live save bound (SPEC-007 §3). */
const CREATION = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
} as const;

/**
 * Playwright changes the viewport by resizing the *window*, and a window the
 * boot tap took fullscreen refuses that outright ("To resize
 * minimized/maximized/fullscreen window, restore it to normal state first").
 * On the `mobile` project the tap does exactly that — AC-33 requests fullscreen
 * on Android when `settings.fullscreen !== false`, and `Pixel 5` is Android.
 *
 * Orientation is not about fullscreen: E22 is about the device being turned,
 * and AC-33 says leaving fullscreen changes nothing else. So the cases that
 * rotate the client step out of it first, which is also the state a player who
 * dismissed it is in. A no-op on a client that never entered fullscreen.
 */
async function leaveFullscreen(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // A refusal is not a test failure: the only thing that matters downstream is
    // that the window is resizable, and a client that was never fullscreen — or
    // that left it between the read and the call — already is.
    try {
      if (document.fullscreenElement !== null) await document.exitFullscreen();
    } catch {
      /* not fullscreen after all */
    }
  });
  await frames(page, 3);
}

/** The canvas's CSS box, which is what `100dvh` decides. */
async function canvasBox(page: Page): Promise<{ width: number; height: number; scrollY: number }> {
  await frames(page, 3);
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas#game') as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    return { width: box.width, height: box.height, scrollY: window.scrollY };
  });
}

test.describe('the viewport shell (AC-25, AC-26)', () => {
  test('sizes the canvas to the dynamic viewport and refuses page gestures', async ({ page }) => {
    await start(page);
    const shell = await page.evaluate(() => {
      const canvas = document.querySelector('canvas#game') as HTMLCanvasElement;
      const ui = document.getElementById('ui') as HTMLElement;
      const canvasStyle = getComputedStyle(canvas);
      const uiStyle = getComputedStyle(ui);
      const html = getComputedStyle(document.documentElement);
      return {
        canvasPosition: canvasStyle.position,
        canvasTouchAction: canvasStyle.touchAction,
        canvasHeight: canvasStyle.height,
        uiPosition: uiStyle.position,
        uiPointerEvents: uiStyle.pointerEvents,
        uiTouchAction: uiStyle.touchAction,
        overscroll: html.overscrollBehaviorY,
        viewportHeight: window.innerHeight,
      };
    });
    expect(shell.canvasPosition).toBe('fixed');
    expect(shell.canvasTouchAction).toBe('none');
    expect(shell.uiPosition).toBe('fixed');
    expect(shell.uiPointerEvents).toBe('none');
    expect(shell.uiTouchAction).toBe('none');
    // AC-26: no rubber-band and no pull-to-refresh on the document.
    expect(shell.overscroll).toBe('none');
    // `100dvh` resolves to the viewport height, to the pixel.
    expect(Math.round(Number.parseFloat(shell.canvasHeight))).toBe(shell.viewportHeight);
  });

  test('clamps the backing store to the preset maxDpr on a high-density screen (AC-2)', async ({ page, isMobile }) => {
    // Only a phone context has a device ratio above 1 to clamp — `Pixel 5`
    // reports 2.75, where Desktop Chrome reports 1 and the clamp is invisible.
    test.skip(isMobile !== true, 'a desktop client renders at dpr 1, so there is nothing to clamp');
    await start(page);
    // `start()` runs on `low`, whose maxDpr is 1 (§3), so the renderer draws a
    // 2.75× screen into a 1× backing store rather than 7.5× the pixels.
    const stats = await page.evaluate(() => window.__reallm.stats());
    expect(stats.preset).toBe('low');
    expect(stats.deviceDpr).toBeGreaterThan(1);
    expect(stats.dpr).toBe(Math.min(stats.deviceDpr, 1));
  });
});

test.describe('the on-screen keyboard (AC-29)', () => {
  test('shrinks the canvas and restores it with no offset left behind', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'the device-metrics override is a CDP call');
    await page.setViewportSize(PHONE);
    await start(page, '/?scene=creation');
    // The name field is the one place a keyboard ever opens (SPEC-014 §4.3).
    const name = page.locator('[data-testid="creation-name"]');
    await expect(name).toBeVisible();
    await name.click();

    const before = await canvasBox(page);
    expect(before.height).toBeGreaterThan(0);

    // A software keyboard does not resize the *window*; it shrinks the visual
    // viewport, which is what `100dvh` follows. A device-metrics override with
    // a shorter screen is the closest a headless client gets to that.
    const client = await page.context().newCDPSession(page);
    const KEYBOARD_PX = 140;
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: PHONE.width,
      height: PHONE.height - KEYBOARD_PX,
      deviceScaleFactor: 0,
      mobile: true,
    });
    const shrunk = await canvasBox(page);
    expect(shrunk.height).toBeLessThan(before.height);
    expect(Math.abs(shrunk.height - (before.height - KEYBOARD_PX))).toBeLessThanOrEqual(1);

    // The keyboard closes: the visual viewport comes back, through the same
    // override rather than a window resize, because that is what a keyboard is.
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: PHONE.width,
      height: PHONE.height,
      deviceScaleFactor: 0,
      mobile: true,
    });
    const after = await canvasBox(page);
    // Back within a pixel, and nothing scrolled the page under the canvas.
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
    expect(after.scrollY).toBe(0);
    await client.send('Emulation.clearDeviceMetricsOverride');
    await client.detach();
  });
});

test.describe('orientation (AC-30, AC-32, AC-33)', () => {
  test('shows the rotate overlay in portrait on a phone, and pauses once', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.addInitScript(() => {
      // The shipped heuristic reads `maxTouchPoints`; a desktop Chromium
      // reports 0 however narrow its window is (D-5).
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
    });
    await start(page, '/?scene=surface&planet=cinder4');
    await leaveFullscreen(page);

    const rotate = page.locator('[data-testid="rotate-overlay"]');
    const pause = page.locator('[data-testid="pause-menu"]');
    await expect(rotate).not.toHaveClass(/is-visible/);
    await expect(pause).toBeHidden();

    // E22: turning the phone mid-fight opens the pause menu through the same
    // path the pause button uses, so the player is not killed while rotating.
    await page.setViewportSize(PHONE_PORTRAIT);
    await frames(page, 3);
    await expect(rotate).toHaveClass(/is-visible/);
    await expect(pause).toBeVisible();

    // AC-33: back to landscape hides the overlay and leaves the menu up.
    const frameBefore = await page.evaluate(() => window.__reallm.stats().frame);
    await page.setViewportSize(PHONE);
    await frames(page, 3);
    await expect(rotate).not.toHaveClass(/is-visible/);
    await expect(pause).toBeVisible();
    // …and the loop kept running the whole time.
    const frameAfter = await page.evaluate(() => window.__reallm.stats().frame);
    expect(frameAfter).toBeGreaterThan(frameBefore);
  });

  test('emits ui:orientation only when the orientation actually changed (AC-31, AC-32)', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
    });
    await start(page, '/?scene=surface&planet=cinder4');
    await leaveFullscreen(page);
    const pause = page.locator('[data-testid="pause-menu"]');
    await expect(pause).toBeHidden();

    // A resize that stays landscape is not a rotation: nothing opens.
    await page.setViewportSize({ width: 700, height: 340 });
    await frames(page, 3);
    await expect(pause).toBeHidden();
    await page.setViewportSize({ width: 820, height: 380 });
    await frames(page, 3);
    await expect(pause).toBeHidden();

    // The rotation opens it once, and a further portrait resize does not
    // re-open it after the player dismisses it (AC-32: once per transition).
    await page.setViewportSize(PHONE_PORTRAIT);
    await frames(page, 3);
    await expect(pause).toBeVisible();
    await page.locator('[data-testid="pause-resume"]').click();
    await expect(pause).toBeHidden();
    await page.setViewportSize({ width: 340, height: 700 });
    await frames(page, 3);
    await expect(pause).toBeHidden();
  });

  test('leaves the overlay down on a desktop-shaped client, however narrow', async ({ page, isMobile }) => {
    // Half of D-5's pair, and the half only a no-touch client can show: the
    // `mobile` project reports real touch points, where the correct answer is
    // the opposite one — asserted in the case below.
    test.skip(isMobile === true, 'the phone project has touch points and is the other half of D-5');
    await page.setViewportSize(PHONE_PORTRAIT);
    await start(page, '/?scene=surface&planet=cinder4');
    // No touch points: a narrow desktop window is not a phone held sideways.
    await expect(page.locator('[data-testid="rotate-overlay"]')).not.toHaveClass(/is-visible/);
  });

  test('raises the overlay on a real phone, with nothing monkeypatched (AC-30)', async ({ page, isMobile }) => {
    // The other half, and the reason the `mobile` project exists: every input
    // to D-5's heuristic here is the context's own — `Pixel 5` reports its
    // touch points and its 393-px-wide portrait screen, and no init script
    // rewrites either. The desktop project cannot reach this state at all.
    test.skip(isMobile !== true, 'a Desktop Chrome context reports no touch points (D-5)');
    await start(page, '/?scene=surface&planet=cinder4');
    const client = await page.evaluate(() => ({
      touchPoints: navigator.maxTouchPoints,
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(client.touchPoints).toBeGreaterThan(0);
    expect(client.width).toBeLessThan(client.height);
    await expect(page.locator('[data-testid="rotate-overlay"]')).toHaveClass(/is-visible/);
  });

  test('mounts the overlay only in the gameplay scenes (AC-30)', async ({ page }) => {
    await start(page);
    await expect(page.locator('[data-testid="rotate-overlay"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: true }, { force: true }))).toBe(true);
    await expect(page.locator('[data-testid="rotate-overlay"]')).toHaveCount(1);
  });
});

test.describe('fullscreen (AC-36, AC-37)', () => {
  test('the toggle writes the setting, and the row is absent where the API is', async ({ page }) => {
    await start(page);
    await page.locator('[data-testid="menu-settings"]').click();
    const box = page.locator('[data-testid="settings-fullscreen"]');
    const enabled = await page.evaluate(() => document.fullscreenEnabled);
    if (!enabled) {
      // AC-37: iOS reports `fullscreenEnabled` false and the row is not built.
      await expect(box).toHaveCount(0);
      return;
    }
    const stored = async (): Promise<boolean | null | undefined> =>
      page.evaluate(() => {
        const raw = localStorage.getItem('reallm:settings');
        return raw === null ? undefined : (JSON.parse(raw) as { fullscreen?: boolean | null }).fullscreen;
      });
    // Never chosen: the setting is absent or null, and the boot tap did not
    // write it (AC-34) — on the phone project it *did* enter fullscreen on that
    // tap, which makes this the assertion that the two are separate.
    expect(await stored() ?? null).toBeNull();

    // So the box shows the live state until something is chosen: unchecked on a
    // desktop client, checked on the phone whose boot tap went fullscreen.
    // Toggling it away from wherever it starts is what proves the toggle is the
    // writer, and flipping back proves it writes the other value too (AC-37).
    const initial = await box.isChecked();
    await box.setChecked(!initial);
    expect(await stored()).toBe(!initial);
    await box.setChecked(initial);
    expect(await stored()).toBe(initial);
  });

  test('leaving fullscreen does not pause, and the next resize re-evaluates (AC-36, 15-f)', async ({ page }) => {
    await start(page, '/?scene=surface&planet=cinder4');
    const before = await page.evaluate(() => window.__reallm.stats());
    expect(before.state).toBe('running');

    // A system gesture or Escape leaves fullscreen; the browser reports it as
    // `fullscreenchange` and nothing else. Nothing in the game listens for it,
    // which is the point: exiting fullscreen is not a pause.
    //
    // The phone project has a real fullscreen to leave — the boot tap took it
    // (AC-33) — so it leaves it for real first; a desktop client never entered
    // one, and the dispatched event is the whole of what it would have seen.
    await leaveFullscreen(page);
    await page.evaluate(() => document.dispatchEvent(new Event('fullscreenchange')));
    await frames(page, 3);
    const after = await page.evaluate(() => window.__reallm.stats());
    expect(after.state).toBe('running');
    expect(after.frame).toBeGreaterThan(before.frame);
    await expect(page.locator('[data-testid="pause-menu"]')).toBeHidden();

    // …and the next resize re-measures, which is where the rotate and
    // fullscreen state are re-evaluated.
    await page.setViewportSize({ width: 900, height: 500 });
    await frames(page, 3);
    const resized = await page.evaluate(() => window.__reallm.stats());
    expect(resized.width).toBe(900);
    expect(resized.state).toBe('running');
  });
});

/**
 * The boot tap's three platform requests, recorded and refused (AC-33, AC-34).
 *
 * `e2e/boot-gate.spec.ts` is SPEC-002's baseline and pins the two it already
 * had — the wake lock on every client and fullscreen on Android — and AC-37
 * requires it to stay green unchanged, so it stays exactly as SPEC-002 wrote
 * it. What SPEC-015 *adds* to that tap is pinned here instead: the landscape
 * lock that follows the fullscreen request, and the `settings.fullscreen:
 * false` opt-out.
 */
async function stubPlatformRequests(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { __asked: string[] }).__asked = calls;
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request(type: string) {
          calls.push(`wakeLock:${type}`);
          return Promise.reject(new Error('denied by the test'));
        },
      },
    });
    // On the prototype: `document.documentElement` does not exist yet when an
    // init script runs.
    Element.prototype.requestFullscreen = function requestFullscreen(): Promise<void> {
      calls.push('fullscreen');
      return Promise.reject(new Error('denied by the test'));
    };
    Object.defineProperty(screen, 'orientation', {
      configurable: true,
      value: {
        lock(to: string) {
          calls.push(`lock:${to}`);
          return Promise.reject(new Error('denied by the test'));
        },
      },
    });
  });
}

const asked = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __asked: string[] }).__asked);

test.describe('the boot tap on Android (AC-33, AC-34)', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  });

  test('asks for the lock, then fullscreen, then landscape — and swallows all three refusals', async ({ page }) => {
    await stubPlatformRequests(page);
    await page.goto(gameUrl('/'));
    await passGate(page);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
    // AC-34: the lock is attempted once the fullscreen request has *settled* —
    // here by rejecting — and its own rejection is a warning and nothing else.
    await expect.poll(() => asked(page)).toEqual(['wakeLock:screen', 'fullscreen', 'lock:landscape']);
  });

  test('skips fullscreen and the lock when the player turned fullscreen off', async ({ page }) => {
    await stubPlatformRequests(page);
    await page.addInitScript(() => {
      // `settings.fullscreen` is tri-state: `null` is "never chosen" and is
      // still attempted; only an explicit `false` opts out (AC-33).
      localStorage.setItem('reallm:settings', JSON.stringify({ version: 1, fullscreen: false }));
    });
    await page.goto(gameUrl('/'));
    await passGate(page);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
    // The wake lock is not conditional on fullscreen — SPEC-002's boot-tap
    // request stands on every client (AC-37) — but nothing else is asked for.
    expect(await asked(page)).toEqual(['wakeLock:screen']);
  });
});

test.describe('the boot tap on desktop (AC-34)', () => {
  test('never attempts the landscape lock off Android', async ({ page, isMobile }) => {
    // `mobile` is a Pixel 5 on the Android UA, where the lock is correct and the
    // case above covers it.
    test.skip(isMobile, 'the Android path is covered by the describe above');
    await stubPlatformRequests(page);
    await page.goto(gameUrl('/'));
    await passGate(page);
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('menu');
    // Desktop gets neither fullscreen nor the orientation lock: both are the
    // Android branch, and the rotate overlay is the answer everywhere else.
    expect(await asked(page)).toEqual(['wakeLock:screen']);
  });
});

test.describe('the update flow (AC-51, AC-52)', () => {
  test('banners the waiting build and offers Update on the menu and the station only', async ({ page }) => {
    await start(page);
    const banner = page.locator('[data-testid="update-overlay"]');
    const menuUpdate = page.locator('[data-testid="menu-update"]');
    // Nothing waiting: no banner, no button. That is the correct answer to
    // "no update exists" (SPEC-014 AC-103).
    await expect(banner).toBeHidden();
    await expect(menuUpdate).toHaveCount(0);

    // A build lands while the menu is open. Only `app:update-ready` says so —
    // in `prompt` mode `controllerchange` never fires (D-10).
    await page.evaluate(() => {
      (window as unknown as { __applied: number }).__applied = 0;
      window.__reallm.offerUpdate(() => {
        (window as unknown as { __applied: number }).__applied++;
      });
    });
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText('Update ready — restart at the station to update');
    await expect(menuUpdate).toBeVisible();

    // The station is the other screen that offers it (15-c).
    expect(await page.evaluate(() => window.__reallm.go('station', {}, { force: true }))).toBe(true);
    await expect(page.locator('[data-testid="station-tab-update"]')).toBeVisible();
    // …and the gameplay scenes are not: a restart mid-run would lose progress.
    expect(await page.evaluate(() => window.__reallm.go('surface', { planet: 'cinder4', firstLanding: true }, { force: true }))).toBe(true);
    await expect(page.locator('[data-testid="station-tab-update"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="menu-update"]')).toHaveCount(0);

    // Nothing reloaded on its own the whole time, and the button is what applies it.
    expect(await page.evaluate(() => (window as unknown as { __applied: number }).__applied)).toBe(0);
    expect(await page.evaluate(() => window.__reallm.go('menu', { reason: 'quit' }, { force: true }))).toBe(true);
    await page.locator('[data-testid="menu-update"]').click();
    expect(await page.evaluate(() => (window as unknown as { __applied: number }).__applied)).toBe(1);
  });
});

test.describe('the settings benchmark row (AC-20)', () => {
  test('re-detects, applies the measured preset and shows the ms/frame', async ({ page }) => {
    // No `?quality=`, so the boot benchmark itself runs (AC-17, AC-19).
    await page.goto('/?debug&films=off');
    await passGate(page);
    await expect(page.locator('[data-testid="scene-label"]')).toBeVisible();

    // It ran, and it reached one of the four §4.5 outcomes. Which one depends
    // on the machine: this container has no GPU, so Chromium rasterises the
    // stress scene on the CPU and the frame gaps read as a throttled tab
    // (`hidden-abort`, 15-a) — which is exactly the outcome the spec says must
    // *not* be persisted. The persistence rules themselves are pinned in node
    // (`tests/core/benchmark.test.ts`), where the frame source is a number.
    await expect(page.locator('[data-testid="debug-events"]')).toContainText(
      /benchmark:(measured|slow-abort|hidden-abort|unsupported)/,
      { timeout: 15_000 },
    );
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('reallm:settings');
      return raw === null ? null : (JSON.parse(raw) as { benchmark: { preset: string; msPerFrame: number } | null }).benchmark;
    });
    if (stored !== null) expect(['low', 'medium', 'high']).toContain(stored.preset);

    await page.locator('[data-testid="menu-settings"]').click();
    const row = page.locator('[data-testid="settings-benchmark"]');
    await expect(row).toBeVisible();
    // AC-20: the row reads the stored measurement, or an em dash when the run
    // measured nothing worth keeping.
    await expect(row).toHaveText(stored === null ? 'Benchmark: —' : /Benchmark: (low|medium|high) · \d+\.\d ms\/frame/);

    await page.locator('[data-testid="settings-redetect"]').click();
    // The run is bounded at 2 s (twice over, with the one hidden-tab retry);
    // the toast names what it found either way.
    await expect(page.locator('.toast').filter({ hasText: /Detected quality/ })).toBeVisible({ timeout: 20_000 });

    // …and `Re-detect` put the setting back to auto, so a measurement takes
    // effect rather than sitting behind a preset the player once chose.
    const quality = await page.evaluate(() => {
      const raw = localStorage.getItem('reallm:settings');
      return raw === null ? null : (JSON.parse(raw) as { quality: string | null }).quality;
    });
    expect(quality).toBeNull();
    expect(['low', 'medium', 'high']).toContain(await page.evaluate(() => window.__reallm.stats().preset));
  });

  test('skips the benchmark entirely when ?quality= names a preset (AC-17)', async ({ page }) => {
    await page.goto(gameUrl('/'));
    await passGate(page);
    await expect(page.locator('[data-testid="scene-label"]')).toBeVisible();
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('reallm:settings');
      return raw === null ? null : (JSON.parse(raw) as { benchmark: unknown }).benchmark;
    });
    expect(stored ?? null).toBeNull();
    expect(await page.evaluate(() => window.__reallm.stats().preset)).toBe('low');
  });
});

// ----------------------------------------------------- reduce motion (§9)
//
// The unit half is `tests/core/reduceMotion.test.ts`, which drives every pure
// decision the setting feeds — shake, bob, flight bank, storm opacity, streak
// length, film mode — and `tests/architecture/` proves no system or entity
// module reads it (AC-42, D-14). What only a browser can answer is the DOM
// contract itself: the `reduce-motion` class on `<html>`, the CSS rules that
// gate on it, and the typewriter, which is a timer and not a number.

test.describe('reduce motion, on (AC-38, AC-40, AC-41)', () => {
  test.use({ reducedMotion: 'reduce' });

  test('takes the class from the OS and turns the HUD pulse into a static outline', async ({ page }) => {
    await start(page, '/?scene=surface&planet=cinder4');
    // AC-38: the single DOM contract, defaulted from the media query. Nothing
    // is written to `settings` until the panel toggle overrides it — the class
    // is the contract, not a stored value.
    await expect(page.locator('html')).toHaveClass(/\breduce-motion\b/);

    // AC-40: the low-hull pulse. `is-low-hp` is the class the HUD itself sets
    // below a quarter hull (ui/Hud.ts); setting it here is how the rule is read
    // without spending a scene getting shot.
    const pulse = await page.evaluate(() => {
      const hud = document.querySelector('[data-testid="hud"]') as HTMLElement;
      hud.classList.add('is-low-hp');
      const fill = hud.querySelector('.bar-hp') as HTMLElement;
      const style = getComputedStyle(fill);
      return { animation: style.animationName, outline: style.outlineStyle, width: style.outlineWidth };
    });
    expect(pulse.animation).toBe('none');
    // …and the state is still visible, as a colour change rather than a beat.
    expect(pulse.outline).toBe('solid');
    expect(pulse.width).not.toBe('0px');
  });

  test('plays a story film as its posters, and types its caption whole (AC-41)', async ({ page }) => {
    await start(page, '/?films=on');
    await page.locator('[data-testid="menu-new"]').click();
    await page.locator('[data-testid="new-slot-0"]').click();
    const film = page.locator('[data-testid="film"]');
    await expect(film).toHaveAttribute('data-film', 'prologue', { timeout: 30_000 });
    // SPEC-022 §4.4: `stills` is the reduce-motion mode, and it is the whole
    // answer — no `<video>` is built, so there is nothing left to pan.
    await expect(film).toHaveAttribute('data-mode', 'stills');
    await expect(page.locator('[data-testid="film-poster"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="film-video"]')).toHaveCount(0);

    // The typewriter: the caption is whole the moment it appears. Sampled on
    // consecutive frames it never grows — the control case below is the same
    // read with the setting off, where it does.
    const caption = page.locator('[data-testid="film-caption"]');
    await expect(caption).toContainText('We built minds to run the world', { timeout: 30_000 });
    const first = (await caption.textContent()) ?? '';
    expect(first.length).toBeGreaterThan(20);
    await frames(page, 4);
    expect((await caption.textContent()) ?? '').toBe(first);
  });
});

test.describe('reduce motion, off — the control (AC-38, AC-40, AC-41)', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('leaves the class off, the pulse animating and the typewriter typing', async ({ page }) => {
    await start(page, '/?scene=surface&planet=cinder4');
    await expect(page.locator('html')).not.toHaveClass(/\breduce-motion\b/);

    const pulse = await page.evaluate(() => {
      const hud = document.querySelector('[data-testid="hud"]') as HTMLElement;
      hud.classList.add('is-low-hp');
      return getComputedStyle(hud.querySelector('.bar-hp') as HTMLElement).animationName;
    });
    expect(pulse).toBe('hud-pulse');

  });

  test('types the film caption a character at a time (AC-41)', async ({ page }) => {
    // Stills mode either way, so the two runs differ only in the setting under
    // test. SPEC-022 §6 explains the abort: decoding H.264 into a positioned
    // layer crashes this container's renderer process, and the caption timer is
    // the same one in both modes.
    await page.route('**/assets/films/*.mp4', (route) => route.abort());
    await start(page, '/?films=on');
    await page.locator('[data-testid="menu-new"]').click();
    await page.locator('[data-testid="new-slot-0"]').click();
    const caption = page.locator('[data-testid="film-caption"]');
    // The same sampling as the reduce-motion case, and here it grows — which is
    // what makes that assertion mean something. 40 cps, so a handful of frames
    // is plenty to see the line lengthen.
    await expect(caption).toContainText('Earth Command', { timeout: 30_000 });
    const lengths: number[] = [];
    for (let i = 0; i < 6; i++) {
      lengths.push(((await caption.textContent()) ?? '').length);
      await frames(page, 4);
    }
    expect(Math.max(...lengths)).toBeGreaterThan(Math.min(...lengths));
  });
});

// ------------------------------------------- the iOS install explainer (AC-61)

test.describe('the iOS install hint (AC-61)', () => {
  // The cadence is SPEC-007 §4.7's: iOS Safari, not already standalone, on a
  // save written at the station, at most once a fortnight. `isIosSafari()`
  // reads the user agent and rules out the iOS Chrome/Firefox/Edge shells, so
  // an iPhone Safari agent is the whole of what this needs.
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  });

  test('explains Share → Add to Home Screen once, and stays dismissed', async ({ page }) => {
    await start(page, '/?scene=station');
    const sheet = page.locator('[data-testid="install-hint"]');
    // Nothing has been saved yet, so nothing has been offered.
    await expect(sheet).toBeHidden();

    // A station save is the trigger SPEC-007 §4.7 defines; the toast says why
    // and this sheet says how. `manual` skips the autosave debounce (§4.5).
    await page.evaluate((creation) => void window.__reallm.save().create(0, creation, 123), CREATION);
    await page.evaluate(() => {
      window.__reallm.save().request('manual');
      window.__reallm.save().flush();
    });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await expect(sheet).toContainText('Share');
    await expect(sheet).toContainText('Add to Home Screen');
    await expect(page.locator('[data-testid="toasts"]')).toContainText(/home screen/i);

    // Dismissible, not modal: the game was never blocked and the sheet goes.
    expect((await page.evaluate(() => window.__reallm.stats())).state).toBe('running');
    await page.locator('[data-testid="install-hint-close"]').click();
    await expect(sheet).toBeHidden();

    // …and the cadence holds: a second save inside the fortnight offers nothing.
    await page.evaluate(() => {
      window.__reallm.save().request('manual');
      window.__reallm.save().flush();
    });
    await frames(page, 10);
    await expect(sheet).toBeHidden();
  });
});

// ------------------------------------------------- shake, bob and bank (AC-39)
//
// The three numbers §9 zeroes or clamps live on the camera, which is a Three.js
// quaternion no DOM assertion can reach — so the surface scene publishes the
// shake and bob it applied and the flight view publishes the degrees it rolled
// by, both through `debugInfo()`, the same way SPEC-020 20-g publishes
// `skyTint`. The pure decisions are pinned in `tests/core/reduceMotion.test.ts`;
// what is here is that the values the camera actually took obey them.

const sceneInfo = async (page: Page): Promise<Record<string, number | string>> =>
  (await page.evaluate(() => window.__reallm.stats())).sceneInfo ?? {};

/** Walk for `n` samples, returning what the camera offset did on each. */
async function walkSamples(page: Page, n: number): Promise<Array<{ shake: number; bob: number }>> {
  const out: Array<{ shake: number; bob: number }> = [];
  await page.keyboard.down('KeyW');
  for (let i = 0; i < n; i++) {
    await frames(page, 4);
    const info = await sceneInfo(page);
    out.push({ shake: Number(info['camShake'] ?? 0), bob: Number(info['camBob'] ?? 0) });
  }
  await page.keyboard.up('KeyW');
  return out;
}

/**
 * Bank hard one way, then the other, returning the roll the camera took.
 *
 * Through the *mouse*, not WASD: `settings.flightMouseSteer` is on by default,
 * and while a pointer is present it overrides the keyboard axis with
 * `clamp((reticle − ship) / 4)` (SPEC-020 §4.2). A headless page always has a
 * pointer, so holding a key steers by nothing at all and the samples would be
 * a flat zero — a test that passes a clamp assertion without ever approaching
 * the clamp.
 */
async function bankSamples(page: Page, n: number): Promise<number[]> {
  const out: number[] = [];
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  const midY = Math.round(size.height / 2);
  for (const x of [size.width - 5, 5]) {
    await page.mouse.move(x, midY);
    for (let i = 0; i < n; i++) {
      await frames(page, 6);
      out.push(Number((await sceneInfo(page))['roll'] ?? 0));
    }
  }
  return out;
}

test.describe('reduce motion holds the camera still (AC-39)', () => {
  test.use({ reducedMotion: 'reduce' });

  test('walking moves the camera by nothing at all', async ({ page }) => {
    await start(page, '/?scene=surface&planet=cinder4');
    const samples = await walkSamples(page, 8);
    // Not "small" — zero. `cameraBobAmplitude` returns 0 outright and
    // `shakeOffset` writes the zero vector, so the offset is never applied.
    expect(samples.every((s) => s.shake === 0)).toBe(true);
    expect(samples.every((s) => s.bob === 0)).toBe(true);
  });

  test('banking never rolls the horizon past 8°', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'mouse steer needs a pointer; the touch stick is SPEC-005 territory');
    await start(page, '/?scene=flight&planet=cinder4');
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
    const rolls = await bankSamples(page, 10);
    // The ship still banks to ±35° — the camera just stops following it that
    // far. A hair of tolerance for the hit shake, which rides on the clamp.
    expect(rolls.length).toBeGreaterThan(0);
    for (const roll of rolls) expect(Math.abs(roll)).toBeLessThanOrEqual(8.1);
    // And the steering really did happen: with the setting off the same sweep
    // passes 8° (the control below), so this is a clamp, not a still camera.
    expect(rolls.some((roll) => Math.abs(roll) > 4)).toBe(true);
  });
});

test.describe('the camera moves with the setting off — the control (AC-39)', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('walking bobs the camera, and banking rolls past 8°', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'mouse steer needs a pointer; the touch stick is SPEC-005 territory');
    await start(page, '/?scene=surface&planet=cinder4');
    const samples = await walkSamples(page, 12);
    expect(samples.some((s) => s.bob !== 0)).toBe(true);

    // A fresh page rather than `go('flight')`: the flight scene needs a trip on
    // the save, and the `?scene=` flag is what builds one (SPEC-001 §9).
    await start(page, '/?scene=flight&planet=cinder4');
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('flight');
    const rolls = await bankSamples(page, 12);
    expect(Math.max(...rolls.map(Math.abs))).toBeGreaterThan(8);
  });
});
