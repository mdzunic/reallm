// SPEC-015 §10 — the PWA build seam, as a test.
//
// Two halves, and neither of them needs a build to run:
//
// 1. the glob matcher the precache is selected with, which is pure and unit
//    tested here the way every pure module in this repository is. A mistake in
//    it is silent: a pattern that stops matching `index.html` does not fail a
//    build, it ships an app that cannot start offline.
// 2. the configuration itself (AC-48) and the registration (AC-51), read off
//    `vite.config.ts`, `vite-pwa.ts` and `src/main.ts` as text — the same way
//    `tests/ui/manifest.test.ts` reads the manifest and `index.html`. These
//    values are only ever exercised by a real build and a real browser, so the
//    one place they can be pinned cheaply is the source that declares them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesAny } from '../../vite-pwa-glob.ts';

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url).pathname, 'utf8');
const VITE_CONFIG = read('vite.config.ts');
const PLUGIN = read('vite-pwa.ts');
const MAIN = read('src/main.ts');

/** §10's own pattern, which is what the built output is matched against. */
const GLOB_PATTERNS = ['**/*.{js,css,html,glb,webm,mp3,mp4,png,webp,svg,json}'];

describe('the precache glob (SPEC-015 §10)', () => {
  const globs = GLOB_PATTERNS.map(globToRegExp);

  it('matches the app shell at the root — `**/` also means no directory at all', () => {
    // The one that matters most: `navigateFallback` is `index.html`, so a
    // `**/` that demanded a directory would leave the shell out of the cache
    // and every offline navigation would fail.
    expect(matchesAny(globs, 'index.html')).toBe(true);
    expect(matchesAny(globs, 'sw.js')).toBe(true);
  });

  it('matches hashed chunks, styles and every asset extension §10 lists', () => {
    for (const path of [
      'assets/index-D-1HYXB4.js',
      'assets/three-l_qCNqL0.js',
      'assets/index-DdROrKIk.css',
      'assets/models/station.glb',
      'assets/audio/music/menu.webm',
      'assets/audio/music/menu.mp3',
      'assets/films/prologue.mp4',
      'icons/icon-512.png',
      'assets/portraits/marine_0.webp',
      'favicon.svg',
      'assets/data/whatever.json',
    ]) {
      expect(matchesAny(globs, path), path).toBe(true);
    }
  });

  it('leaves alone what §10 does not list', () => {
    for (const path of ['assets/LICENSES.md', 'manifest.webmanifest', 'assets/audio/.gitkeep', 'notes.txt']) {
      expect(matchesAny(globs, path), path).toBe(false);
    }
  });

  it('is anchored: a pattern matches the whole path or nothing', () => {
    const one = globToRegExp('assets/*.js');
    expect(one.test('assets/index.js')).toBe(true);
    // `*` is one segment, so it does not cross a `/`…
    expect(one.test('assets/deep/index.js')).toBe(false);
    // …and neither end is a substring match.
    expect(one.test('public/assets/index.js')).toBe(false);
    expect(one.test('assets/index.js.map')).toBe(false);
  });

  it('reads `{a,b}` as alternation and `?` as one character', () => {
    expect(matchesAny([globToRegExp('*.{png,webp}')], 'icon.webp')).toBe(true);
    expect(matchesAny([globToRegExp('*.{png,webp}')], 'icon.svg')).toBe(false);
    expect(matchesAny([globToRegExp('icon-19?.png')], 'icon-192.png')).toBe(true);
    expect(matchesAny([globToRegExp('icon-19?.png')], 'icon-1920.png')).toBe(false);
  });

  it('matches nothing when there are no patterns', () => {
    expect(matchesAny([], 'index.html')).toBe(false);
  });
});

describe('the plugin is configured as §10 writes it (AC-48)', () => {
  it("registers in 'prompt' mode — a waiting build is offered, never applied", () => {
    expect(VITE_CONFIG).toContain("registerType: 'prompt'");
    // 15-c: nothing but the Update button may take a new build live, so the
    // worker must never call skipWaiting() outside its message handler. The
    // prose above and below it says so in the same words, which is why this
    // counts the call — `self.` — and not the name.
    expect([...PLUGIN.matchAll(/self\.skipWaiting\(\)/g)]).toHaveLength(1);
    expect(PLUGIN).toContain("if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();");
  });

  it('precaches the built output §10 names, and the assets beside it', () => {
    expect(VITE_CONFIG).toContain(`globPatterns: ${JSON.stringify(GLOB_PATTERNS).replace(/"/g, "'")}`);
    expect(VITE_CONFIG).toContain("includeAssets: ['assets/**/*', 'manifest.webmanifest']");
  });

  it('caps a single precached file at 8 MB — the largest asset is a 3 MB film', () => {
    expect(VITE_CONFIG).toContain('maximumFileSizeToCacheInBytes: 8 * 1024 * 1024');
  });

  it('answers every navigation with the precached index.html (AC-56)', () => {
    expect(VITE_CONFIG).toContain("navigateFallback: 'index.html'");
    expect(PLUGIN).toContain("if (request.mode === 'navigate')");
  });
});

describe('the registration (AC-51)', () => {
  it('goes through `virtual:pwa-register`', () => {
    expect(MAIN).toContain("import { registerSW } from 'virtual:pwa-register';");
  });

  it('offers the waiting build on `onNeedRefresh` and applies it only on demand', () => {
    expect(MAIN).toContain('const updateSW = registerSW({');
    expect(MAIN).toContain('onNeedRefresh: () => offerAppUpdate(() => void updateSW(true)),');
    // AC-51: the offer is a toast plus the typed event — `controllerchange`
    // never fires in `prompt` mode, so the UI listens to the event (D-10).
    expect(MAIN).toContain("events.emit('app:update-ready');");
    expect(MAIN).toContain("events.emit('ui:toast', { text: UPDATE_BANNER_TEXT");
  });

  it('registers nothing in a dev server, so the dev-server e2e flow is unchanged', () => {
    expect(PLUGIN).toContain('return isBuild ? BUILD_REGISTER_SW : DEV_REGISTER_SW;');
    expect(PLUGIN).toContain('// SPEC-015 §10: no service worker in a dev server.');
  });
});
