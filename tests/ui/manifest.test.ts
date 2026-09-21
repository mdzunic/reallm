// SPEC-015 §10 / AC-49, AC-50 — the web app manifest.
//
// `vite-plugin-pwa` owns it: the `manifest` literal in `vite.config.ts` is what
// the plugin emits and links, so there is no file on disk to read and this test
// reads the option object itself (D-10). Every field is an explicit literal
// here — `display`, `orientation` and the two colours are what decide whether an
// installed ReaLLM opens full-bleed and landscape, and none of them is visible
// in a normal browser run. The *served* copy is checked in `e2e/SPEC-015-pwa`.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PWA_OPTIONS } from '../../vite.config.ts';

const root = (path: string): string => new URL(`../../${path}`, import.meta.url).pathname;
const HTML = readFileSync(root('index.html'), 'utf8');
const MANIFEST = PWA_OPTIONS.manifest;

describe('the web app manifest (SPEC-015 §10, AC-49, AC-50)', () => {
  it('names the app and opens it standalone and landscape', () => {
    expect(MANIFEST.name).toBe('ReaLLM');
    expect(MANIFEST.short_name).toBe('ReaLLM');
    expect(MANIFEST.display).toBe('standalone');
    expect(MANIFEST.orientation).toBe('landscape');
  });

  it('carries the D-9 colours: a black splash behind the app background', () => {
    expect(MANIFEST.background_color).toBe('#000000');
    expect(MANIFEST.theme_color).toBe('#0b0f14');
    // One hex, three places: the manifest, the meta tag and the page.
    expect(HTML).toContain('<meta name="theme-color" content="#0b0f14" />');
  });

  it('scopes the app to its own directory, so a sub-path deploy still works', () => {
    expect(MANIFEST.start_url).toBe('./');
    expect(MANIFEST.scope).toBe('./');
  });

  it('ships a 192 icon and a 512 any-maskable one', () => {
    expect(MANIFEST.icons).toHaveLength(2);
    const [small, large] = MANIFEST.icons;
    expect(small).toEqual({ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' });
    expect(large).toEqual({ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' });
    // …and each `src` is a file that exists under `public/`, at exactly the
    // size it claims (read from the PNG's IHDR — `tests/assets/icons.test.ts`
    // does the rest). The plugin copies them out of `public/` unchanged.
    for (const icon of MANIFEST.icons) {
      const bytes = readFileSync(new URL(`../../public/${icon.src}`, import.meta.url).pathname);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(`${view.getUint32(16, false)}x${view.getUint32(20, false)}`, icon.src).toBe(icon.sizes);
    }
  });

  it('is the only manifest: no static file, and no link tag in the source HTML', () => {
    // D-10 — the plugin injects the one `<link rel="manifest">` at build time,
    // so a second one here would ship two. `tests/build/pwa.test.ts` counts the
    // links in the built `index.html`. Comments are stripped first: the one
    // left in `index.html` explains the absence and names the tag.
    expect(HTML.replaceAll(/<!--[\s\S]*?-->/g, '')).not.toContain('rel="manifest"');
    expect(existsSync(root('public/manifest.webmanifest'))).toBe(false);
  });
});
