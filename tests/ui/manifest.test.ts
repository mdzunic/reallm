// SPEC-015 §10 / AC-49 — the web app manifest, read off the file that ships.
// Every field is an explicit literal here: `display`, `orientation` and the two
// colours are what decide whether an installed ReaLLM opens full-bleed and
// landscape, and none of them is visible in a normal browser run.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HTML = readFileSync(new URL('../../index.html', import.meta.url).pathname, 'utf8');
const MANIFEST = JSON.parse(readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url).pathname, 'utf8')) as {
  name: string;
  short_name: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  start_url: string;
  scope: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
};

describe('the web app manifest (SPEC-015 §10, AC-49)', () => {
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

  it('ships a 192 any icon and a 512 any-maskable one', () => {
    expect(MANIFEST.icons).toHaveLength(2);
    const [small, large] = MANIFEST.icons as [(typeof MANIFEST.icons)[number], (typeof MANIFEST.icons)[number]];
    expect(small).toEqual({ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' });
    expect(large).toEqual({ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' });
    // …and each `src` is a file that exists, at exactly the size it claims
    // (read from the PNG's IHDR — `tests/assets/icons.test.ts` does the rest).
    for (const icon of MANIFEST.icons) {
      const bytes = readFileSync(new URL(`../../public/${icon.src}`, import.meta.url).pathname);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(`${view.getUint32(16, false)}x${view.getUint32(20, false)}`, icon.src).toBe(icon.sizes);
    }
  });

  it('is linked from index.html', () => {
    expect(HTML).toContain('<link rel="manifest" href="manifest.webmanifest" />');
  });
});
