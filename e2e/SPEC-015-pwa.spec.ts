// SPEC-015 §10 — offline and installability, against a *real build*.
//
// This file runs only in the `pwa` project (playwright.config.ts), whose
// `webServer` is `vite preview` over `dist/`: a dev server has no precache
// manifest and registers no worker, so there would be nothing to go offline
// with (D-13). The default `chromium` project ignores this file and its
// dev-server flow is unchanged.
//
// The manifest, icon and service-worker cases here are the in-container half of
// AC-58; the physical Android and iOS installs stay owed before `m7` (D-15).
//
// Every navigation goes through `gameUrl()`, for the `?quality=low` the rest of
// the suite uses (e2e/start.ts): this container has no GPU, and a preset that
// runs the post chain costs 60–140 ms a frame on its software rasteriser.
// Nothing here is about the renderer — a worker caches the same bytes and a save
// is the same JSON at any preset. The `films=off` it also adds is a dev-only
// flag (SPEC-022 §4.11) and does nothing against a build; see the offline case.
import { expect, test, type Page } from '@playwright/test';
import { awaitGate, COLD_START, gameUrl, passGate } from './start';

/**
 * How long a worker gets to reach `activated` on a cold preview server. The
 * install precaches the whole app — ≈ 21 MB over 181 entries — so this is a
 * download budget, not a handshake.
 */
const SW_TIMEOUT_MS = 60_000;
/** The two worker cases wait for that install on top of a normal boot. */
const SW_TEST_TIMEOUT_MS = 240_000;

interface ManifestJson {
  name?: string;
  short_name?: string;
  display?: string;
  orientation?: string;
  background_color?: string;
  theme_color?: string;
  start_url?: string;
  scope?: string;
  icons?: Array<{ src: string; sizes: string; type?: string; purpose?: string }>;
}

/** The manifest the served page links to, fetched the way a browser would. */
async function servedManifest(page: Page): Promise<{ url: string; json: ManifestJson }> {
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href, 'index.html links a manifest').not.toBeNull();
  const url = new URL(href as string, page.url()).toString();
  const response = await page.request.get(url);
  expect(response.status(), url).toBe(200);
  return { url, json: (await response.json()) as ManifestJson };
}

/** Width and height from a PNG's IHDR, fetched over HTTP. */
async function servedPngSize(page: Page, url: string): Promise<{ status: number; width: number; height: number }> {
  const response = await page.request.get(url);
  const body = await response.body();
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return { status: response.status(), width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

/** The fields of slot 0 this file compares across a reload (SPEC-007 §3). */
interface StoredSlot {
  version: number;
  meta: { slot: number; seed: number; createdAt: number; updatedAt: number };
  player: unknown;
  progress: unknown;
  inventory: unknown;
  equipped: unknown;
}

/** Slot 0 as the game left it in `localStorage`, or `null` when unwritten. */
async function readSlot0(page: Page): Promise<StoredSlot | null> {
  const raw = await page.evaluate(() => localStorage.getItem('reallm:slot:0'));
  return raw === null ? null : (JSON.parse(raw) as StoredSlot);
}

/** Resolves to the worker's state, or `null` when none ever registers. */
async function workerState(page: Page): Promise<string | null> {
  return page.evaluate(async (timeout) => {
    if (!('serviceWorker' in navigator)) return null;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const registration = await navigator.serviceWorker.getRegistration();
      const worker = registration?.active ?? registration?.waiting ?? registration?.installing ?? null;
      if (worker?.state === 'activated') return 'activated';
      if (worker !== null) await new Promise((resolve) => setTimeout(resolve, 200));
      else await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.active?.state ?? null;
  }, SW_TIMEOUT_MS);
}

/**
 * What CacheStorage holds, as `{cacheName: entryCount}`.
 *
 * `activated` is not the same as "precached", and the gap between them is not
 * theoretical: a precache manifest that lists one url under two revisions makes
 * Workbox's `addToCacheList` throw inside `precacheAndRoute`, *before* the
 * install handler is attached — so the worker activates having cached nothing,
 * the app works perfectly online, and offline is silently dead. That shipped
 * here once (docs/playtest-log.md §SPEC-015, the precache collision note), and
 * the state assertion above went green through all of it.
 */
async function cacheEntryCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    const counts: Record<string, number> = {};
    for (const name of await caches.keys()) counts[name] = (await (await caches.open(name)).keys()).length;
    return counts;
  });
}

test.describe('installability, from the served build (AC-58)', () => {
  test('serves a manifest carrying every AC-49 field', async ({ page }) => {
    await page.goto(gameUrl('/'));
    const { json } = await servedManifest(page);
    expect(json.name).toBe('ReaLLM');
    expect(json.short_name).toBe('ReaLLM');
    expect(json.display).toBe('standalone');
    expect(json.orientation).toBe('landscape');
    expect(json.background_color).toBe('#000000');
    expect(json.theme_color).toBe('#0b0f14');
    expect(json.start_url).toBe('./');
    expect(json.scope).toBe('./');
    expect(json.icons).toHaveLength(2);
  });

  test('serves both manifest icons and the apple-touch-icon at their claimed sizes', async ({ page }) => {
    await page.goto(gameUrl('/'));
    const { url, json } = await servedManifest(page);
    for (const icon of json.icons ?? []) {
      const resolved = new URL(icon.src, url).toString();
      const png = await servedPngSize(page, resolved);
      expect(png.status, resolved).toBe(200);
      expect(`${png.width}x${png.height}`, resolved).toBe(icon.sizes);
    }
    // iOS never reads the manifest icons; this is the one it uses (AC-28).
    const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    expect(touch).toBe('icons/apple-touch-icon-180.png');
    const png = await servedPngSize(page, new URL(touch as string, page.url()).toString());
    expect(png.status).toBe(200);
    expect(png.width).toBe(180);
    expect(png.height).toBe(180);
  });

  test('reports no installability blocker: scope, icons and secure context', async ({ page }) => {
    await page.goto(gameUrl('/'));
    const { url, json } = await servedManifest(page);
    // `start_url` has to be inside `scope`, or the browser refuses to install.
    const scope = new URL(json.scope as string, url).toString();
    const start = new URL(json.start_url as string, url).toString();
    expect(start.startsWith(scope)).toBe(true);
    // A maskable icon of at least 192 px is the other hard requirement.
    const maskable = (json.icons ?? []).filter((icon) => (icon.purpose ?? '').includes('maskable'));
    expect(maskable.length).toBeGreaterThan(0);
    expect(Math.min(...maskable.map((icon) => Number.parseInt(icon.sizes, 10)))).toBeGreaterThanOrEqual(192);
    // localhost counts as a secure context, which is what a worker needs.
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  });

  test('registers a service worker that reaches activated, and precaches', async ({ page }) => {
    test.setTimeout(SW_TEST_TIMEOUT_MS);
    await page.goto(gameUrl('/'));
    await awaitGate(page);
    expect(await workerState(page)).toBe('activated');
    // …and it actually filled a cache while doing it (see `cacheEntryCounts`).
    // The count is not pinned: it is the precache manifest's length, which
    // every added asset moves. That it is *populated* is the whole assertion.
    const counts = await cacheEntryCounts(page);
    const precaches = Object.entries(counts).filter(([name]) => name.includes('precache'));
    expect(precaches, `caches: ${JSON.stringify(counts)}`).toHaveLength(1);
    expect(precaches[0]?.[1]).toBeGreaterThan(100);
  });
});

test.describe('offline (AC-56, AC-57)', () => {
  /**
   * Reduce motion, for AC-46's reason and for a container one. The prologue
   * stands between `New Game` and the creation screen, and a production build
   * has no `?films=off` (that flag is dev-only, SPEC-022 §4.11). Under
   * `prefers-reduced-motion` a film plays as its posters — `chooseFilmMode()`
   * returns `stills` and no `<video>` is ever built (AC-46) — which is both the
   * behaviour this spec asks for and the only way through here: decoding the
   * 3 MB MP4 on this container's software rasteriser kills the renderer
   * process, which is why `e2e/SPEC-022.spec.ts` aborts the MP4 route for the
   * same reason ("the failure here would take the tab with it").
   */
  test.use({ reducedMotion: 'reduce' });

  test('boots from the cache after going offline, and keeps a save written there', async ({ page, context }) => {
    test.setTimeout(SW_TEST_TIMEOUT_MS);
    await page.goto(gameUrl('/'));
    await awaitGate(page);
    expect(await workerState(page)).toBe('activated');

    // AC-56: everything the first visit needs is precached, so a reload with
    // the network gone still reaches the boot gate.
    await context.setOffline(true);
    await page.reload();
    await awaitGate(page);

    // AC-57: a save written offline survives an offline reload. This is the
    // production build, so there is no `__reallm` bridge (it is `DEV` only) —
    // the save is made the way a player makes one, through the menu.
    await passGate(page);
    await page.locator('[data-testid="menu-new"]').click();
    await page.locator('[data-testid="new-slot-0"]').click();
    // The prologue, as posters (see `test.use` above). Skipping it is a tap
    // like any other and waits out the 0.3 s pointer grace (SPEC-022 §4.5).
    await expect(page.locator('[data-testid="film"]')).toHaveAttribute('data-mode', 'stills', COLD_START);
    await page.waitForTimeout(400);
    await page.locator('[data-testid="film-skip"]').click();
    await expect(page.locator('[data-testid="creation-name"]')).toBeVisible(COLD_START);
    // AC-20 of SPEC-014: no class, no Confirm.
    await page.locator('[data-testid="class-marine"]').click();
    await page.locator('[data-testid="creation-confirm"]').click();
    await expect(page.locator('[data-testid="station-root"]')).toBeVisible({ timeout: 60_000 });
    const written = await readSlot0(page);
    expect(written, 'the offline run wrote slot 0').not.toBeNull();

    await page.reload();
    await passGate(page);
    const afterReload = await readSlot0(page);
    // Everything the player made is byte-identical. `meta.updatedAt` and
    // `meta.playtimeSec` are deliberately not compared: leaving the page is a
    // `pagehide` autosave (SPEC-007 §4.5), so a save that survived a reload
    // *should* carry a later stamp than the one written a moment earlier.
    expect(afterReload?.version).toBe(written?.version);
    expect(afterReload?.meta.slot).toBe(written?.meta.slot);
    expect(afterReload?.meta.seed).toBe(written?.meta.seed);
    expect(afterReload?.meta.createdAt).toBe(written?.meta.createdAt);
    expect(afterReload?.player).toEqual(written?.player);
    expect(afterReload?.progress).toEqual(written?.progress);
    expect(afterReload?.inventory).toEqual(written?.inventory);
    expect(afterReload?.equipped).toEqual(written?.equipped);
    // …and the menu offers to continue it, which is the save being *read* back.
    await expect(page.locator('[data-testid="go-station"]')).toBeVisible();
    await context.setOffline(false);
  });
});

test.describe('an old cached build and a newer save (AC-59, 15-d)', () => {
  test('refuses a save from a newer format, and offers Update only when one waits', async ({ page }) => {
    await page.goto(gameUrl('/'));
    await awaitGate(page);
    // E9: a save stamped with a version this build does not know is refused
    // rather than half-read — which is exactly what an old cached build meets
    // when a newer one has already written the slot. The build does not have to
    // be old for that; the save being from the future is the whole of the check.
    await page.evaluate(() => {
      localStorage.setItem(
        'reallm:slot:0',
        JSON.stringify({ version: 99, meta: { slot: 0, seed: 1, playtimeSec: 0, updatedAt: Date.now(), iteration: 1, difficulty: 'normal' } }),
      );
      localStorage.removeItem('reallm:slot:0:bak');
    });
    await page.reload();
    await passGate(page);
    // The slot reads as unusable, so there is nothing to continue…
    await expect(page.locator('[data-testid="menu-new"]')).toBeVisible();
    await expect(page.locator('[data-testid="go-station"]')).toHaveCount(0);
    // …and the Update button exists exactly when a build is waiting (AC-52).
    // Nothing is waiting on a freshly served build, so it must be absent; the
    // `app:update-ready` half is pinned in `tests/ui/updates.test.ts`.
    expect(await page.locator('[data-testid="menu-update"]').count()).toBe(0);
  });
});
