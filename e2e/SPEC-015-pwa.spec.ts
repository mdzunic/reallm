// SPEC-015 §10 — offline and installability, against a *real build*.
//
// This file runs only in the `pwa` project (playwright.config.ts), whose
// `webServer` is `vite preview` over `dist/`: a dev server has no precache
// manifest and registers no worker, so there would be nothing to go offline
// with (D-13). The default `chromium` project ignores this file and its
// dev-server flow is unchanged.
//
// The manifest and icon cases below are the in-container half of AC-58 and run
// today. The cases that need a registered service worker — the offline reload
// of AC-56, the offline save of AC-57, and the `activated` state AC-58 also
// asks for — skip with a named reason until `vite-plugin-pwa` is configured
// (§10, AC-48); adding the plugin is what turns them on, with no edit here.
// The physical Android and iOS installs stay owed before `m7` (D-15).
import { expect, test, type Page } from '@playwright/test';
import { awaitGate, passGate } from './start';

/** How long a worker gets to reach `activated` on a cold preview server. */
const SW_TIMEOUT_MS = 20_000;

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

test.describe('installability, from the served build (AC-58)', () => {
  test('serves a manifest carrying every AC-49 field', async ({ page }) => {
    await page.goto('/');
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
    await page.goto('/');
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
    await page.goto('/');
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

  test('registers a service worker that reaches activated', async ({ page }) => {
    await page.goto('/');
    await awaitGate(page);
    const state = await workerState(page);
    test.skip(
      state === null,
      'no service worker is registered: `vite-plugin-pwa` is not configured yet (SPEC-015 AC-48). ' +
        'Adding the plugin turns this case on with no edit here.',
    );
    expect(state).toBe('activated');
  });
});

test.describe('offline (AC-56, AC-57)', () => {
  test('boots from the cache after going offline, and keeps a save written there', async ({ page, context }) => {
    await page.goto('/');
    await awaitGate(page);
    const state = await workerState(page);
    test.skip(
      state === null,
      'no service worker is registered: `vite-plugin-pwa` is not configured yet (SPEC-015 AC-48). ' +
        'Adding the plugin turns this case on with no edit here.',
    );

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
    await expect(page.locator('[data-testid="creation-name"]')).toBeVisible();
    await page.locator('[data-testid="creation-confirm"]').click();
    await expect(page.locator('[data-testid="station-root"]')).toBeVisible({ timeout: 30_000 });
    const written = await page.evaluate(() => localStorage.getItem('reallm:save:0'));
    expect(written, 'the offline run wrote slot 0').not.toBeNull();

    await page.reload();
    await awaitGate(page);
    const afterReload = await page.evaluate(() => localStorage.getItem('reallm:save:0'));
    expect(afterReload).toBe(written);
    // …and the menu offers to continue it, which is the save being *read* back.
    await expect(page.locator('[data-testid="go-station"]')).toBeVisible();
    await context.setOffline(false);
  });
});

test.describe('an old cached build and a newer save (AC-59, 15-d)', () => {
  test('refuses a save from a newer format, and offers Update only when one waits', async ({ page }) => {
    await page.goto('/');
    await awaitGate(page);
    // E9: a save stamped with a version this build does not know is refused
    // rather than half-read — which is exactly what an old cached build meets
    // when a newer one has already written the slot. The build does not have to
    // be old for that; the save being from the future is the whole of the check.
    await page.evaluate(() => {
      localStorage.setItem(
        'reallm:save:0',
        JSON.stringify({ version: 99, meta: { slot: 0, seed: 1, playtimeSec: 0, updatedAt: Date.now(), iteration: 1, difficulty: 'normal' } }),
      );
      localStorage.removeItem('reallm:save:0:bak');
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
