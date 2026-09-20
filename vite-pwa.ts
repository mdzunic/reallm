// SPEC-015 §10 — the service worker, the precache manifest and the
// `virtual:pwa-register` module, as a Vite plugin that lives in this repository.
//
// Why it is here and not `vite-plugin-pwa`
// ----------------------------------------
// §10 configures `vite-plugin-pwa`. Adding it means editing `package.json`,
// which this build stage may not touch; the answer to asking was "satisfy the
// criteria without it". So the option shape below is §10's, field for field,
// and the behaviour is the subset of the plugin those fields describe:
//
//   - `registerType: 'prompt'` — a new build installs and then *waits*. Nothing
//     calls `skipWaiting()` on its own, so no page ever reloads under the
//     player (15-c); `updateSW(true)` is the only thing that applies it.
//   - `includeAssets` — extra `public/` paths to precache, on top of whatever
//     the glob patterns match.
//   - `workbox.globPatterns` — what of the built output to precache.
//   - `workbox.maximumFileSizeToCacheInBytes` — a bigger file is left out of
//     the precache (and named in the build summary) rather than failing it.
//   - `workbox.navigateFallback` — the document served for every navigation,
//     which is what makes an offline reload reach the boot gate (AC-56).
//
// Swapping in the real plugin is `import { VitePWA } from 'vite-plugin-pwa'` in
// `vite.config.ts` and deleting this file: the options object is unchanged, the
// emitted worker is `sw.js` at the site root either way, and `main.ts` imports
// the same `virtual:pwa-register`. What is *not* reproduced here is Workbox
// itself — no per-entry revisions (the cache is versioned as a whole by the
// hash of everything in it), no runtime-caching routes, no precache
// cache-busting parameters. None of those is in §10.
//
// The manifest is not this plugin's: it ships as `public/manifest.webmanifest`
// and is linked from `index.html` (AC-49), so it exists in `npm run dev` too,
// where no worker is ever registered.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

export interface VitePwaOptions {
  /** `'prompt'`: a waiting build is offered, never applied on its own (15-c). */
  registerType: 'prompt';
  /** Globs under `public/` to precache even when `globPatterns` misses them. */
  includeAssets: string[];
  workbox: {
    /** Globs over the built output — what the worker precaches. */
    globPatterns: string[];
    /** Files larger than this are left out of the precache. */
    maximumFileSizeToCacheInBytes: number;
    /** The document every navigation is answered with. */
    navigateFallback: string;
  };
}

const VIRTUAL_ID = 'virtual:pwa-register';
const RESOLVED_ID = '\0virtual:pwa-register';
const SW_FILE = 'sw.js';
/** Every cache this app owns starts with it, so `activate` can drop the old ones. */
const CACHE_PREFIX = 'reallm-precache-';

/** `**`, `*`, `?` and `{a,b}` — the whole of what §10's patterns use. */
function globToRegExp(pattern: string): RegExp {
  const escape = (char: string): string => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` crosses directory boundaries and also matches zero of them.
        if (pattern[i + 2] === '/') {
          source += '(?:[^/]*/)*';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else if (char === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) source += '\\{';
      else {
        source += `(?:${pattern
          .slice(i + 1, close)
          .split(',')
          .map(escape)
          .join('|')})`;
        i = close;
      }
    } else source += escape(char);
  }
  return new RegExp(`^${source}$`);
}

/** Every file under `dir`, absolute, depth-first. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const toPosix = (path: string): string => path.split(sep).join('/');
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

interface PrecacheEntry {
  url: string;
  bytes: number;
  hash: string;
}

/**
 * The module `main.ts` imports. In a dev server it is a stub — `vite-plugin-pwa`
 * registers nothing in dev unless `devOptions` asks it to, and a worker caching
 * a dev server's module graph would fight HMR and the e2e suite both.
 */
const DEV_REGISTER_SW = `// SPEC-015 §10: no service worker in a dev server.
export function registerSW() {
  return async () => {};
}
`;

/**
 * The real registration. `onNeedRefresh` fires only when a *new* worker reaches
 * `installed` while an old one is still controlling the page — a first install
 * is not an update (AC-51). `updateSW(true)` tells the waiting worker to take
 * over and reloads once it has (AC-52).
 */
const BUILD_REGISTER_SW = `const SW_URL = new URL(${JSON.stringify(SW_FILE)}, document.baseURI).href;

export function registerSW(options = {}) {
  const { immediate = false, onNeedRefresh, onOfflineReady, onRegisteredSW, onRegisterError } = options;
  let registration = null;
  let reloading = false;

  const reloadOnceItTakesOver = () => {
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        if (reloading) return;
        reloading = true;
        window.location.reload();
      },
      { once: true },
    );
  };

  const updateServiceWorker = async (reloadPage = true) => {
    const waiting = registration && registration.waiting;
    if (!waiting) {
      if (reloadPage && !reloading) {
        reloading = true;
        window.location.reload();
      }
      return;
    }
    if (reloadPage) reloadOnceItTakesOver();
    waiting.postMessage({ type: 'SKIP_WAITING' });
  };

  const watch = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state !== 'installed') return;
      if (navigator.serviceWorker.controller) onNeedRefresh && onNeedRefresh();
      else onOfflineReady && onOfflineReady();
    });
  };

  const register = async () => {
    try {
      registration = await navigator.serviceWorker.register(SW_URL);
      onRegisteredSW && onRegisteredSW(SW_URL, registration);
      // A build that finished waiting while the page was closed.
      if (registration.waiting && navigator.serviceWorker.controller) {
        onNeedRefresh && onNeedRefresh();
        return;
      }
      watch(registration.installing);
      registration.addEventListener('updatefound', () => watch(registration.installing));
    } catch (error) {
      onRegisterError && onRegisterError(error);
    }
  };

  if ('serviceWorker' in navigator) {
    if (immediate || document.readyState === 'complete') void register();
    else window.addEventListener('load', () => void register(), { once: true });
  }
  return updateServiceWorker;
}
`;

/**
 * The worker itself. Cache-first for everything precached (that is the whole
 * app, so an offline load never touches the network), network-first with a
 * cache fallback for anything else, and every navigation answered with the
 * precached `navigateFallback` document.
 */
const SERVICE_WORKER = `/* ReaLLM service worker — generated by vite-pwa.ts (SPEC-015 §10). Do not edit. */
const CACHE = __CACHE_NAME__;
const CACHE_PREFIX = __CACHE_PREFIX__;
const PRECACHE = __PRECACHE__;
const NAVIGATE_FALLBACK = __NAVIGATE_FALLBACK__;
/** cache.addAll() in batches: one 176-entry call holds every response at once. */
const BATCH = 24;

const absolute = (path) => new URL(path, self.location.href).toString();
const PRECACHED = new Set(PRECACHE.map(absolute));
const FALLBACK = absolute(NAVIGATE_FALLBACK);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const urls = [...PRECACHED];
      for (let i = 0; i < urls.length; i += BATCH) await cache.addAll(urls.slice(i, i + BATCH));
      // No skipWaiting(): registerType 'prompt' leaves the old build in charge
      // until the player presses Update (SPEC-015 15-c).
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE && name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // The app shell. Every route is the same document, so an offline reload of
  // any URL reaches the boot gate (SPEC-015 AC-56).
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = await caches.match(FALLBACK, { cacheName: CACHE });
        return cached || fetch(request);
      })(),
    );
    return;
  }

  const key = url.origin + url.pathname;
  event.respondWith(
    (async () => {
      if (PRECACHED.has(key)) {
        const hit = await caches.match(key, { cacheName: CACHE });
        if (hit) return hit;
      }
      try {
        return await fetch(request);
      } catch (error) {
        const hit = await caches.match(key, { cacheName: CACHE });
        if (hit) return hit;
        throw error;
      }
    })(),
  );
});
`;

/** `21.27 MB`-style, matching what `scripts/assets/check.mjs` prints. */
const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

export function VitePWA(options: VitePwaOptions): Plugin {
  let config: ResolvedConfig;
  let isBuild = false;

  return {
    name: 'reallm:pwa',

    configResolved(resolved) {
      config = resolved;
      isBuild = resolved.command === 'build';
    },

    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },

    load(id) {
      if (id !== RESOLVED_ID) return null;
      return isBuild ? BUILD_REGISTER_SW : DEV_REGISTER_SW;
    },

    // After the output is written, so the summary is the last thing the build
    // prints and the entry list is what actually shipped.
    writeBundle(_outputOptions, bundle) {
      const globs = options.workbox.globPatterns.map(globToRegExp);
      const includes = options.includeAssets.map(globToRegExp);
      const limit = options.workbox.maximumFileSizeToCacheInBytes;
      const entries = new Map<string, PrecacheEntry>();
      const skipped: Array<{ url: string; bytes: number }> = [];

      const consider = (url: string, data: Uint8Array, wanted: boolean): void => {
        if (!wanted || entries.has(url)) return;
        if (data.byteLength > limit) {
          skipped.push({ url, bytes: data.byteLength });
          return;
        }
        entries.set(url, { url, bytes: data.byteLength, hash: sha256(data) });
      };

      // The bundle: index.html, the JS chunks and the CSS.
      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName === SW_FILE) continue;
        const source = output.type === 'chunk' ? output.code : output.source;
        const data = typeof source === 'string' ? new TextEncoder().encode(source) : new Uint8Array(source);
        consider(fileName, data, globs.some((glob) => glob.test(fileName)));
      }

      // `public/`, read from the source tree rather than from `dist/`: it is
      // copied verbatim, and this does not depend on when the copy happens.
      const publicDir = config.publicDir;
      if (publicDir && config.build.copyPublicDir !== false && existsSync(publicDir)) {
        for (const file of walk(publicDir)) {
          const url = toPosix(relative(publicDir, file));
          const wanted = globs.some((glob) => glob.test(url)) || includes.some((glob) => glob.test(url));
          if (!wanted) continue;
          // Size first: a 3 MB film is read only if it is going to be cached.
          if (statSync(file).size > limit) {
            skipped.push({ url, bytes: statSync(file).size });
            continue;
          }
          consider(url, readFileSync(file), true);
        }
      }

      const precache = [...entries.values()].sort((a, b) => (a.url < b.url ? -1 : 1));
      const total = precache.reduce((sum, entry) => sum + entry.bytes, 0);
      // One cache per distinct set of bytes: a build that changed nothing
      // reuses the cache, and any change at all makes a new one that `activate`
      // swaps in — which is the revision Workbox tracks per entry.
      const revision = createHash('sha256')
        .update(precache.map((entry) => `${entry.url}:${entry.hash}`).join('\n'))
        .digest('hex')
        .slice(0, 16);

      const source = SERVICE_WORKER.replace(/__CACHE_NAME__|__CACHE_PREFIX__|__PRECACHE__|__NAVIGATE_FALLBACK__/g, (token) => {
        if (token === '__CACHE_NAME__') return JSON.stringify(`${CACHE_PREFIX}${revision}`);
        if (token === '__CACHE_PREFIX__') return JSON.stringify(CACHE_PREFIX);
        if (token === '__NAVIGATE_FALLBACK__') return JSON.stringify(options.workbox.navigateFallback);
        return JSON.stringify(precache.map((entry) => entry.url));
      });
      const outDir = join(config.root, config.build.outDir);
      writeFileSync(join(outDir, SW_FILE), source);

      // AC-54: the precache summary, in the build's own output.
      const out = relative(config.root, outDir);
      console.log('');
      console.log(`PWA      generateSW (registerType: '${options.registerType}', SPEC-015 §10)`);
      console.log(`precache ${precache.length} entries (${mib(total)})`);
      for (const file of skipped) {
        console.log(`skipped  ${file.url} — ${mib(file.bytes)} over the ${mib(limit)} per-file limit`);
      }
      console.log(`files generated`);
      console.log(`  ${toPosix(join(out, SW_FILE))}`);
    },
  };
}
