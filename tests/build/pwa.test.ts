// SPEC-015 §10 — the PWA build seam, as a test.
//
// Three halves, and only the last of them needs a build:
//
// 1. the dependency itself (AC-48) — `vite-plugin-pwa` at the `^1.3.0` PLAN
//    §2 locks, resolved exactly in the lockfile, with no hand-rolled worker or
//    in-repo plugin left beside it.
// 2. the options (AC-48, AC-56) and the registration (AC-53), read from the
//    exported `PWA_OPTIONS` object and `src/main.ts`. These values are only
//    ever exercised by a real build and a real browser, so pinning the object
//    the plugin is actually handed is the cheap half of proving them.
// 3. the emitted `dist/` output (AC-49, AC-56, AC-57) — one manifest, one
//    `<link rel="manifest">`, a Workbox worker with the navigation fallback
//    bound, and a precache that stays inside both budgets.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PWA_OPTIONS } from '../../vite.config.ts';

const root = (path: string): string => new URL(`../../${path}`, import.meta.url).pathname;
const read = (path: string): string => readFileSync(root(path), 'utf8');
const MAIN = read('src/main.ts');
const PACKAGE = JSON.parse(read('package.json')) as { devDependencies: Record<string, string> };
const LOCK = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string; dev?: boolean }> };

const DIST = root('dist');
/** MiB — SPEC-015 §10's ceiling on everything the worker precaches (AC-57). */
const PRECACHE_BUDGET = 25 * 1024 * 1024;

/** Every file under `dir`, as paths relative to it, depth-first. */
function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

describe('the dependency (AC-48)', () => {
  it('is `vite-plugin-pwa` at the ^1.3.0 PLAN §2 locks, as a devDependency', () => {
    expect(PACKAGE.devDependencies['vite-plugin-pwa']).toBe('^1.3.0');
  });

  it('records an exact resolution inside that range in the lockfile', () => {
    const entry = LOCK.packages['node_modules/vite-plugin-pwa'];
    expect(entry, 'package-lock.json resolves vite-plugin-pwa').toBeDefined();
    expect(entry?.dev).toBe(true);
    expect(entry?.version).toMatch(/^1\.[3-9]\d*\.\d+$/);
    // Workbox comes in as the plugin's own dependency; it is what generates the
    // worker, and its absence would mean the plugin is not really installed.
    expect(LOCK.packages['node_modules/workbox-build']?.version).toMatch(/^7\./);
  });

  it('leaves no hand-rolled service worker or in-repo PWA plugin behind', () => {
    // The substitute this repository shipped before the dependency was granted.
    // `dist/sw.js` is Workbox output and is not source; nothing under `src/`
    // or at the root may be a worker any more.
    expect(existsSync(root('vite-pwa.ts'))).toBe(false);
    expect(existsSync(root('vite-pwa-glob.ts'))).toBe(false);
    expect(existsSync(root('public/sw.js'))).toBe(false);
    expect(existsSync(root('src/sw.ts'))).toBe(false);
  });
});

describe('the plugin is configured as §10 writes it (AC-48, AC-56)', () => {
  it("registers in 'prompt' mode — a waiting build is offered, never applied", () => {
    // 15-c: nothing but the Update button may take a new build live. In
    // `prompt` mode Workbox's generated worker calls `skipWaiting()` only from
    // its `SKIP_WAITING` message handler, which `updateSW(true)` posts.
    expect(PWA_OPTIONS.registerType).toBe('prompt');
  });

  it('precaches the built output §10 names, and the assets beside it', () => {
    expect(PWA_OPTIONS.workbox.globPatterns).toEqual(['**/*.{js,css,html,glb,webm,mp3,mp4,png,webp,svg,json}']);
    expect(PWA_OPTIONS.includeAssets).toEqual(['assets/**/*']);
  });

  it('caps a single precached file at 8 MB — the largest asset is a 3 MB film', () => {
    expect(PWA_OPTIONS.workbox.maximumFileSizeToCacheInBytes).toBe(8 * 1024 * 1024);
  });

  it('answers every navigation with the precached index.html (AC-58)', () => {
    expect(PWA_OPTIONS.workbox.navigateFallback).toBe('index.html');
  });
});

describe('the registration (AC-53)', () => {
  it('goes through `virtual:pwa-register`', () => {
    expect(MAIN).toContain("import { registerSW } from 'virtual:pwa-register';");
  });

  it('offers the waiting build on `onNeedRefresh` and applies it only on demand', () => {
    expect(MAIN).toContain('const updateSW = registerSW({');
    expect(MAIN).toContain('onNeedRefresh: () => offerAppUpdate(() => void updateSW(true)),');
    // AC-53: the offer is a toast plus the typed event — `controllerchange`
    // never fires in `prompt` mode, so the UI listens to the event (D-10).
    expect(MAIN).toContain("events.emit('app:update-ready');");
    expect(MAIN).toContain("events.emit('ui:toast', { text: UPDATE_BANNER_TEXT");
  });

  it('never applies a build itself: `updateSW` is called from exactly one place', () => {
    // AC-55 — a worker update mid-mission is a toast and nothing more. The one
    // call site is the `offerAppUpdate` callback above, behind the buttons.
    expect([...MAIN.matchAll(/updateSW\(/g)]).toHaveLength(1);
    expect(MAIN).toContain('updateSW(true)');
  });
});

// The emitted output. `npm run check` runs the tests *before* the build, so on
// a tree that has never been built there is no `dist/` to read and these skip;
// they run for anyone who has built (including straight after `npm run build`),
// and the same ground is covered end to end against `vite preview` by the
// `pwa` Playwright project in `e2e/SPEC-015-pwa.spec.ts`.
const built = existsSync(DIST) && existsSync(join(DIST, 'index.html'));

describe.skipIf(!built)('the emitted build (AC-49, AC-56, AC-57)', () => {
  const html = built ? readFileSync(join(DIST, 'index.html'), 'utf8') : '';
  const sw = built && existsSync(join(DIST, 'sw.js')) ? readFileSync(join(DIST, 'sw.js'), 'utf8') : '';
  /** Workbox's precache manifest, as `{url, revision}` in emission order. */
  const entries = [...sw.matchAll(/\{url:"([^"]+)",revision:("[0-9a-f]+"|null)\}/g)].map((match) => ({
    url: match[1] as string,
    revision: match[2] as string,
  }));
  /** …and each url once, which is what the worker actually stores. */
  const precached = [...new Set(entries.map((entry) => entry.url))];

  it('ships exactly one manifest, and exactly one link to it (AC-49)', () => {
    const manifests = built ? walk(DIST).filter((path) => path.endsWith('.webmanifest')) : [];
    expect(manifests).toEqual(['manifest.webmanifest']);
    // Comments stripped: the one `index.html` carries explains why the source
    // has no link of its own, and names the tag while doing it.
    const tags = html.replaceAll(/<!--[\s\S]*?-->/g, '');
    expect([...tags.matchAll(/<link[^>]+rel="manifest"/g)]).toHaveLength(1);
  });

  it('emits the manifest the option literal describes (AC-50)', () => {
    const json = JSON.parse(readFileSync(join(DIST, 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>;
    for (const [key, value] of Object.entries(PWA_OPTIONS.manifest)) {
      expect(json[key], key).toEqual(value);
    }
  });

  it('never lists one url under two revisions — that throws on install (AC-58)', () => {
    // The failure this guards is total and silent at build time: Workbox's
    // `addToCacheList` throws `add-to-cache-list-conflicting-entries` when the
    // same url arrives with two different cache keys, the worker script dies
    // while evaluating `precacheAndRoute`, and nothing is ever cached — so the
    // build succeeds, the app works online, and offline never works at all.
    // `includeAssets` globs `public/` and gives each file an md5 `revision`,
    // while the `globPatterns` pass over `dist/` nulls the revision of anything
    // `dontCacheBustURLsMatching` covers; this repository keeps its game assets
    // in `public/assets/`, the one directory that default covers, so the two
    // passes meet on every one of them.
    const revisions = new Map<string, Set<string>>();
    for (const entry of entries) {
      const seen = revisions.get(entry.url) ?? new Set<string>();
      seen.add(entry.revision);
      revisions.set(entry.url, seen);
    }
    const conflicting = [...revisions].filter(([, seen]) => seen.size > 1).map(([url]) => url);
    expect(conflicting).toEqual([]);
  });

  it('is a Workbox worker with the navigation fallback bound (AC-56)', () => {
    expect(sw, 'dist/sw.js').not.toBe('');
    expect(sw).toContain('workbox');
    expect(sw).toContain('createHandlerBoundToURL("index.html")');
    expect(precached).toContain('index.html');
  });

  it('precaches every shipped file of the extensions §10 lists (AC-56)', () => {
    // A file over `maximumFileSizeToCacheInBytes` is dropped from the precache
    // *silently* — the build succeeds and the app simply cannot open that
    // asset offline. So the assertion is on the files, not on the manifest:
    // nothing shipped of a precachable extension may exceed the cap.
    const extensions = /\.\{([^}]+)\}$/.exec(PWA_OPTIONS.workbox.globPatterns[0] as string)?.[1]?.split(',') ?? [];
    expect(extensions.length).toBeGreaterThan(0);
    const cap = PWA_OPTIONS.workbox.maximumFileSizeToCacheInBytes;
    for (const path of walk(DIST)) {
      if (!extensions.some((extension) => path.endsWith(`.${extension}`))) continue;
      // The worker and its Workbox runtime are not precache entries themselves.
      if (path === 'sw.js' || /^workbox-[\da-f]+\.js$/.test(path)) continue;
      expect(statSync(join(DIST, path)).size, path).toBeLessThanOrEqual(cap);
      expect(precached, path).toContain(path);
    }
  });

  it('keeps the whole precache inside the 25 MB budget (AC-57)', () => {
    expect(precached.length).toBeGreaterThan(0);
    const total = precached.reduce((sum, url) => sum + statSync(join(DIST, url)).size, 0);
    expect(total).toBeLessThanOrEqual(PRECACHE_BUDGET);
  });
});
