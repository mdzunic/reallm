// SPEC-040 §6.2 — phones at full quality, in a real browser: frames paced by
// the clock and idle when nothing moves, the adaptive governor, the frame-rate
// and adaptive-quality settings, no blur in play, a planet's assets leaving
// with it, films that wait for a stall, and a benchmark record that says it
// timed the GPU.
//
// The rules themselves are pinned in node — the pacer and the governor over
// fake clocks (`tests/core/frameSkip.test.ts`, `tests/core/quality.test.ts`),
// the benchmark over a fake frame source (`tests/core/benchmark.test.ts`), the
// release and the prop swap over fake loaders and a scene graph
// (`tests/core/assets.test.ts`, `tests/views/surfaceView.test.ts`). What only a
// browser shows is what those rules add up to on a real page.
//
// Every count below is read inside the page, in one task: a round trip per
// sample would stretch a "second" by the transport.
import { expect, test, type Page } from '@playwright/test';
import { COLD_START, passGate, start } from './start';

const ADAPT_TOAST = 'Graphics lowered to keep the game smooth.';

/** Drawn frames (`stats().renders`) over `ms` of wall clock, and how long that really was. */
async function rendersOver(page: Page, ms: number): Promise<{ renders: number; ms: number }> {
  return page.evaluate(async (wait) => {
    const before = window.__reallm.stats().renders;
    const t0 = performance.now();
    await new Promise((resolve) => setTimeout(resolve, wait));
    return { renders: window.__reallm.stats().renders - before, ms: performance.now() - t0 };
  }, ms);
}

/**
 * The most frames a pacer may draw in `ms` at `perSecond` — the spec's "at most
 * N in a second" when the window really was a second, and the same rate when a
 * busy main thread stretched the timer a little past it.
 */
function drawCeiling(ms: number, perSecond: number, oneSecond: number): number {
  return Math.max(oneSecond, Math.ceil((ms / 1000) * perSecond) + 1);
}

/** `go()` through the dev bridge, then the scene label (force skips the §4.2 graph, D-11). */
async function go(page: Page, id: string, params: unknown, force = false): Promise<void> {
  expect(
    await page.evaluate(
      ({ id, params, force }) => window.__reallm.go(id, params, force ? { force: true } : undefined),
      { id, params, force },
    ),
  ).toBe(true);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText(id, COLD_START);
}

/**
 * Every toast text the page shows from now on, kept after it expires — a toast
 * is up for 2.5 s, and a poll must not be able to miss it.
 */
async function watchToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __seenToasts: string[] }).__seenToasts = seen;
    const record = (): void => {
      for (const node of document.querySelectorAll('.toast')) {
        const text = node.textContent ?? '';
        if (!seen.includes(text)) seen.push(text);
      }
    };
    new MutationObserver(record).observe(document.body, { childList: true, subtree: true, characterData: true });
    record();
  });
}

async function seenToasts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __seenToasts: string[] }).__seenToasts);
}

/** `reallm:settings` as stored, or `{}`. */
async function storedSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('reallm:settings') ?? '{}') as Record<string, unknown>);
}

/** Polls `memory().textures` until two readings half a second apart agree. */
async function settledTextures(page: Page): Promise<number> {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const now = await page.evaluate(() => window.__reallm.memory().textures);
    if (now === last) return now;
    last = now;
    await page.waitForTimeout(500);
  }
  throw new Error(`memory().textures never settled (last ${last})`);
}

async function propSource(page: Page): Promise<string> {
  return page.evaluate(() => String(window.__reallm.stats().sceneInfo?.['propSource'] ?? ''));
}

// ------------------------------------------------------------------- 1, 2

test('1. paused, the surface draws at most 6 frames a second; resumed, it draws again (AC-11, 40-e)', async ({ page }) => {
  // `start()` runs on `low`, the preset AC-11's 31-a-second ceiling names.
  await start(page, '/?scene=surface&planet=cinder4');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="pause-menu"]')).toBeVisible();
  const paused = await rendersOver(page, 1000);
  expect(paused.renders, `${paused.renders} draws in ${Math.round(paused.ms)} ms`).toBeLessThanOrEqual(
    drawCeiling(paused.ms, 5, 6),
  );
  // …but the frozen frame under the menu is still drawn (SPEC-003 D-39).
  expect(paused.renders).toBeGreaterThan(0);

  await page.locator('[data-testid="pause-resume"]').click();
  await expect(page.locator('[data-testid="pause-menu"]')).toBeHidden();
  const playing = await rendersOver(page, 1000);
  expect(playing.renders).toBeGreaterThan(0);
  // `low` targets 30: at most 31 draws in a second of play, on any screen.
  expect(playing.renders, `${playing.renders} draws in ${Math.round(playing.ms)} ms`).toBeLessThanOrEqual(
    drawCeiling(playing.ms, 30, 31),
  );
});

test('2. with the frame rate set to 30, play draws at most 31 frames a second (AC-18, 40-h)', async ({ page }) => {
  await start(page, '/?quality=medium&scene=surface&planet=cinder4');
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
  expect(await page.evaluate(() => window.__reallm.stats().preset)).toBe('medium');

  await page.keyboard.press('Escape');
  await page.locator('[data-testid="pause-settings"]').click();
  await page.locator('[data-testid="settings-framerate-30"]').click();
  await expect(page.locator('[data-testid="settings-framerate-30"]')).toHaveAttribute('aria-pressed', 'true');
  expect((await storedSettings(page))['frameRate']).toBe(30);
  await page.locator('[data-testid="settings-close"]').click();
  await page.locator('[data-testid="pause-resume"]').click();
  await expect(page.locator('[data-testid="pause-menu"]')).toBeHidden();

  const playing = await rendersOver(page, 1000);
  expect(playing.renders).toBeGreaterThan(0);
  expect(playing.renders, `${playing.renders} draws in ${Math.round(playing.ms)} ms`).toBeLessThanOrEqual(
    drawCeiling(playing.ms, 30, 31),
  );
});

// ---------------------------------------------------------------- 3, 4: E68

test.describe('the governor (E68)', () => {
  // The governor's clock is frame time summed, and the loop caps a frame at
  // 250 ms (SPEC-002 E23), so a frame slower than that counts for less than
  // the wall clock the 30 s bound is read on. `high` plus the busy-wait costs
  // this container's CPU rasteriser 95 ms a frame at 480 × 270 alone, and
  // well past the cap when three other workers are rasterising too. A small
  // canvas, and the two cases one after the other rather than loading each
  // other, keep it under the cap. The preset, the post chain and the
  // busy-wait are unchanged.
  test.describe.configure({ mode: 'default' });
  test.use({ viewport: { width: 320, height: 180 } });

  test('3. a device that cannot hold high steps down within 30 s, with a toast, and stores nothing (AC-19)', async ({ page }) => {
    test.setTimeout(120_000);
    // A stored `quality: null` the governor could have overwritten, and did not.
    await page.addInitScript(() => localStorage.setItem('reallm:settings', JSON.stringify({ quality: null })));
    await start(page, '/?quality=high');
    expect(await page.evaluate(() => window.__reallm.stats().preset)).toBe('high');
    await watchToasts(page);
    await page.evaluate(() => window.__reallm.slowDraw(40));

    await go(page, 'surface', { planet: 'cinder4', firstLanding: true }, true);
    const landedAt = Date.now();
    await expect
      .poll(() => page.evaluate(() => window.__reallm.stats().preset), { timeout: 30_000, intervals: [500] })
      .not.toBe('high');
    expect(Date.now() - landedAt).toBeLessThanOrEqual(30_000);

    const stats = await page.evaluate(() => window.__reallm.stats());
    expect(stats.adaptSteps).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await seenToasts(page)).some((text) => text.includes(ADAPT_TOAST))).toBe(true);
    // Nothing the governor does is persisted (40-g): the next boot starts where
    // the player and the benchmark left it.
    expect((await storedSettings(page))['quality'] ?? null).toBeNull();
  });

  test('4. with adaptive quality off, high stays high (AC-17)', async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() =>
      localStorage.setItem('reallm:settings', JSON.stringify({ quality: null, adaptiveQuality: false })),
    );
    await start(page, '/?quality=high');
    await page.evaluate(() => window.__reallm.slowDraw(40));
    await go(page, 'surface', { planet: 'cinder4', firstLanding: true }, true);

    await page.waitForTimeout(20_000);
    const stats = await page.evaluate(() => window.__reallm.stats());
    // The frames were as slow as case 3's — every draw busy-waits 40 ms — so it
    // is the setting that held the preset, not a fast machine.
    expect(stats.renderMs).toBeGreaterThanOrEqual(40);
    expect(stats.preset).toBe('high');
    expect(stats.adaptSteps).toBe(0);
  });
});

// ---------------------------------------------------------------- 5: blur

test.describe('no blur in play (AC-22)', () => {
  // As `SPEC-020.spec.ts` does: a host may report reduced transparency on its
  // own, which takes the station's glass away for a different reason.
  test.beforeEach(async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }],
    });
  });

  test('5. the tracker, the dialogue and a toast blur nothing on the surface; the station keeps its glass', async ({ page }) => {
    // `medium`: under `low` the station drops its blur too (SPEC-020 20-a).
    await start(page, '/?quality=medium&scene=surface&planet=cinder4');
    await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');
    await page.evaluate(() => window.__reallm.playDialogue('c1_m1_accept'));
    await expect(page.getByTestId('dialogue')).toBeVisible();
    await page.evaluate(() => window.__reallm.toast('Nothing blurs in play', 'info', 60_000));
    await expect(page.locator('.toast', { hasText: 'Nothing blurs in play' })).toBeVisible();

    const play = await page.evaluate(() => {
      const style = (el: Element | null): CSSStyleDeclaration | null => (el === null ? null : getComputedStyle(el));
      const toast = [...document.querySelectorAll('.toast')].find((node) => node.textContent?.includes('Nothing blurs in play')) ?? null;
      const tracker = style(document.querySelector('[data-testid="objective-tracker"]'));
      const dialogue = style(document.querySelector('[data-testid="dialogue"]'));
      const toastStyle = style(toast);
      const blurred = [...document.querySelectorAll('#ui *')]
        .filter((node) => !['none', ''].includes(getComputedStyle(node).backdropFilter))
        .map((node) => node.className);
      return {
        dataPlay: document.documentElement.dataset['play'] ?? null,
        tracker: tracker?.backdropFilter ?? 'missing',
        dialogue: dialogue?.backdropFilter ?? 'missing',
        toast: toastStyle?.backdropFilter ?? 'missing',
        blurred,
        dialogueFill: dialogue?.backgroundColor ?? 'missing',
        toastFill: toastStyle?.backgroundColor ?? 'missing',
      };
    });
    expect(play.dataPlay).toBe('surface');
    expect(play.tracker).toBe('none');
    expect(play.dialogue).toBe('none');
    expect(play.toast).toBe('none');
    expect(play.blurred).toEqual([]);
    // The opaque `--panel` (#111820) in place of the glass.
    expect(play.dialogueFill).toBe('rgb(17, 24, 32)');
    expect(play.toastFill).toBe('rgb(17, 24, 32)');

    await go(page, 'station', {});
    await expect(page.locator('[data-testid="station-root"]')).toBeVisible();
    const station = await page.evaluate(() => ({
      dataPlay: document.documentElement.dataset['play'] ?? null,
      panel: getComputedStyle(document.querySelector('[data-testid="station-root"]') as Element).backdropFilter,
    }));
    expect(station).toEqual({ dataPlay: null, panel: 'blur(6px)' });
  });
});

// -------------------------------------------------------------- 6: assets

test('6. the station holds its texture count across two planets (AC-27)', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page, '/?scene=surface&planet=cinder4');
  // The planet's set is in: props from their GLBs, the ground with them.
  await expect.poll(() => propSource(page), COLD_START).toBe('glb');
  await go(page, 'station', {});
  const afterCinder = await settledTextures(page);

  await go(page, 'surface', { planet: 'vetra', firstLanding: true }, true);
  await expect.poll(() => propSource(page), COLD_START).toBe('glb');
  // Vetra's ground textures are on the GPU: the frames after the swap drew them.
  await page.waitForTimeout(1000);
  const onVetra = await settledTextures(page);
  await go(page, 'station', {});
  const afterVetra = await settledTextures(page);

  expect(onVetra, 'vetra drew textures the station does not').toBeGreaterThan(afterVetra);
  expect(Math.abs(afterVetra - afterCinder), `station ${afterCinder} → ${afterVetra}`).toBeLessThanOrEqual(2);
});

// ------------------------------------------------------------ 7: film stall

test.describe('a film that trickles (AC-32, AC-34)', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('7. a prologue whose bytes stop after 6 s is video at 5.5 s and stills by 11 s', async ({ page }) => {
    test.setTimeout(90_000);
    // The prologue's MP4 answers with a stream: a 64 KB chunk each second for
    // six seconds, then nothing — the body never ends, so no complete file can
    // ever reach the video element. Everything else fetches as usual.
    await page.addInitScript(() => {
      const w = window as unknown as { __filmFetchAt: number | null; __stillsAt: number | null };
      w.__filmFetchAt = null;
      w.__stillsAt = null;
      const original = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!/prologue\.mp4(?:$|\?)/.test(url)) return original(input, init);
        w.__filmFetchAt = performance.now();
        let sent = 0;
        let timer = 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            timer = window.setInterval(() => {
              controller.enqueue(new Uint8Array(64 * 1024));
              if (++sent >= 6) window.clearInterval(timer);
            }, 1000);
          },
          cancel() {
            window.clearInterval(timer);
          },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } }));
      };
      // When the layer flips to stills, on the page's own clock.
      new MutationObserver(() => {
        const film = document.querySelector('[data-testid="film"]');
        if (w.__stillsAt === null && film?.getAttribute('data-mode') === 'stills') w.__stillsAt = performance.now();
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-mode'], childList: true });
    });

    await start(page, '/?films=on');
    await page.locator('[data-testid="menu-new"]').click();
    await page.locator('[data-testid="new-slot-0"]').click();
    const film = page.locator('[data-testid="film"]');
    await expect(film).toHaveAttribute('data-film', 'prologue');
    await expect(film).toHaveAttribute('data-mode', 'video');
    await page.waitForFunction(() => (window as unknown as { __filmFetchAt: number | null }).__filmFetchAt !== null);

    // 5.5 s after the request: bytes arrived a second ago, so the load is alive.
    await page.waitForFunction(
      () => performance.now() - ((window as unknown as { __filmFetchAt: number }).__filmFetchAt ?? 0) >= 5500,
      undefined,
      { polling: 50, timeout: 15_000 },
    );
    await expect(film).toHaveAttribute('data-mode', 'video', { timeout: 100 });
    // …with a video element that has been given no file at all.
    expect(
      await page.evaluate(() => {
        const video = document.querySelector('[data-testid="film-video"]') as HTMLVideoElement | null;
        return video === null ? 'missing' : video.getAttribute('src') ?? '';
      }),
    ).toBe('');

    // Four seconds after the last byte (6 s), the load has stalled: stills.
    await expect(film).toHaveAttribute('data-mode', 'stills', { timeout: 15_000 });
    const at = await page.evaluate(() => {
      const w = window as unknown as { __filmFetchAt: number; __stillsAt: number };
      return w.__stillsAt - w.__filmFetchAt;
    });
    expect(at, `stills after ${Math.round(at)} ms`).toBeGreaterThan(9_000);
    expect(at, `stills after ${Math.round(at)} ms`).toBeLessThanOrEqual(11_000);
    await expect(page.locator('[data-testid="film-video"]')).toHaveCount(0);
  });
});

// ------------------------------------------------------------ 8: settings

test('8. the frame-rate and adaptive-quality rows write their settings; the dev server has no offline play (AC-17, AC-18, AC-29)', async ({ page }) => {
  await start(page, '/');
  await page.locator('[data-testid="menu-settings"]').click();

  await expect(page.locator('[data-testid="settings-framerate-60"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-testid="settings-framerate-30"]').click();
  await expect(page.locator('[data-testid="settings-framerate-30"]')).toHaveAttribute('aria-pressed', 'true');
  expect((await storedSettings(page))['frameRate']).toBe(30);
  await page.locator('[data-testid="settings-framerate-60"]').click();
  expect((await storedSettings(page))['frameRate']).toBe(60);

  const adaptive = page.locator('[data-testid="settings-adaptive-quality"]');
  await expect(adaptive).toBeChecked();
  await adaptive.click();
  await expect(adaptive).not.toBeChecked();
  expect((await storedSettings(page))['adaptiveQuality']).toBe(false);
  await adaptive.click();
  expect((await storedSettings(page))['adaptiveQuality']).toBe(true);

  // A dev server registers no worker (SPEC-015 D-13).
  await expect(page.locator('[data-testid="settings-offline"]')).toHaveText('Offline play: not in this build');
});

// ------------------------------------------------------ 9: old benchmark

test('9. a stored benchmark without method: gpu runs the benchmark again, and what it stores says gpu (AC-4)', async ({ page }) => {
  // A record from before SPEC-040: it measured frame gaps, which vsync floors.
  await page.addInitScript(() =>
    localStorage.setItem(
      'reallm:settings',
      JSON.stringify({ quality: null, benchmark: { preset: 'low', msPerFrame: 16.7, at: 1_700_000_000_000 } }),
    ),
  );
  // No `?quality=`, which would skip the run (SPEC-015 AC-17).
  await page.goto('/?debug&films=off');
  await passGate(page);
  await expect(page.locator('[data-testid="scene-label"]')).toBeVisible(COLD_START);

  const events = page.locator('[data-testid="debug-events"]');
  await expect(events).toContainText(/benchmark:(measured|slow-abort|hidden-abort|unsupported)/, { timeout: 15_000 });
  const reason = /benchmark:([a-z-]+)/.exec((await events.textContent()) ?? '')?.[1];
  const stored = (await storedSettings(page))['benchmark'] as Record<string, unknown> | null | undefined;
  if (reason === 'measured' || reason === 'slow-abort') {
    // A run that saw the device replaced the record, and says how it measured.
    expect(stored?.['method']).toBe('gpu');
    expect(['low', 'medium', 'high']).toContain(stored?.['preset']);
  } else {
    // A run that measured nothing wrote nothing (SPEC-015 §4.5): the old record
    // is still the only one on disk, and it is still not believed.
    expect(stored).toEqual({ preset: 'low', msPerFrame: 16.7, at: 1_700_000_000_000 });
  }
});

// --------------------------------------------------- 10: props, every time

test('10. Thessaly draws its props from the GLBs within 2 s of every landing (E72, AC-25)', async ({ page }) => {
  test.setTimeout(120_000);
  // Every surface entry and the moment its props read `glb`, on the page's
  // own clock, from the first frame — the bridge is up before the gate.
  await page.addInitScript(() => {
    type Bridge = { scene(): string | null; stats(): { sceneInfo: Record<string, number | string> | null } };
    const w = window as unknown as { __reallm?: Bridge; __landings: Array<{ entered: number; glb: number | null }> };
    w.__landings = [];
    let onSurface = false;
    const tick = (): void => {
      const bridge = w.__reallm;
      const surface = bridge?.scene() === 'surface';
      if (surface && !onSurface) w.__landings.push({ entered: performance.now(), glb: null });
      onSurface = surface;
      const last = w.__landings[w.__landings.length - 1];
      if (surface && last !== undefined && last.glb === null && bridge?.stats().sceneInfo?.['propSource'] === 'glb') {
        last.glb = performance.now();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const landing = async (index: number): Promise<number> => {
    await page.waitForFunction(
      (i) => {
        const landings = (window as unknown as { __landings: Array<{ glb: number | null }> }).__landings;
        return landings[i]?.glb !== null && landings[i]?.glb !== undefined;
      },
      index,
      { timeout: 30_000 },
    );
    return page.evaluate((i) => {
      const entry = (window as unknown as { __landings: Array<{ entered: number; glb: number }> }).__landings[i];
      return (entry?.glb ?? Infinity) - (entry?.entered ?? 0);
    }, index);
  };

  // A fresh landing: nothing of Thessaly's set has ever been fetched.
  await start(page, '/?scene=surface&planet=thessaly');
  const first = await landing(0);
  expect(first, `first landing: glb after ${Math.round(first)} ms`).toBeLessThanOrEqual(2000);

  // Off the planet — its set is released — and back.
  await go(page, 'station', {});
  await go(page, 'surface', { planet: 'thessaly', firstLanding: false }, true);
  const second = await landing(1);
  expect(second, `landing after the release: glb after ${Math.round(second)} ms`).toBeLessThanOrEqual(2000);
});
