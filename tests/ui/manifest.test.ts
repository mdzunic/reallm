// SPEC-015 §10 / AC-49, AC-50 — the web app manifest.
//
// `vite-plugin-pwa` owns it: the `manifest` literal in `vite.config.ts` is what
// the plugin emits and links, so there is no file on disk to read and this test
// reads the option object itself (D-10). Every field is an explicit literal
// here — `display`, `orientation` and the two colours are what decide whether an
// installed ReaLLM opens full-bleed and landscape, and none of them is visible
// in a normal browser run. The *served* copy is checked in `e2e/SPEC-015-pwa`.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHARE_URL } from '@/systems/Share';
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

// ------------------------------------------------------- SPEC-059 §4.6

/** §4.6.1: the copy every description tag carries. */
const DESCRIPTION = 'Earth sent the Selection to find a new home. Six worlds, one salvager, and a feeling you have done this before.';
const OG_IMAGE_ALT = 'A wall of Selection cards, one of them stamped 62.';

/** §4.6.1's sixteen tags, in their order, as `[selector attribute, its value, content or href]`. */
const PREVIEW_TAGS: readonly (readonly [string, string, string])[] = [
  ['name', 'description', DESCRIPTION],
  ['rel', 'canonical', 'https://mdzunic.github.io/reallm/'],
  ['property', 'og:type', 'website'],
  ['property', 'og:site_name', 'ReaLLM'],
  ['property', 'og:title', 'ReaLLM'],
  ['property', 'og:description', DESCRIPTION],
  ['property', 'og:url', 'https://mdzunic.github.io/reallm/'],
  ['property', 'og:image', 'https://mdzunic.github.io/reallm/og.png'],
  ['property', 'og:image:width', '1200'],
  ['property', 'og:image:height', '630'],
  ['property', 'og:image:alt', OG_IMAGE_ALT],
  ['name', 'twitter:card', 'summary_large_image'],
  ['name', 'twitter:title', 'ReaLLM'],
  ['name', 'twitter:description', DESCRIPTION],
  ['name', 'twitter:image', 'https://mdzunic.github.io/reallm/og.png'],
  ['name', 'twitter:image:alt', OG_IMAGE_ALT],
];

/** Every `<meta>`/`<link>` tag of the source HTML, comments stripped, as attribute maps in order. */
function headTags(): Record<string, string>[] {
  const html = HTML.replaceAll(/<!--[\s\S]*?-->/g, '');
  return [...html.matchAll(/<(?:meta|link)\s([^>]*?)\s*\/?>/g)].map((match) =>
    Object.fromEntries([...(match[1] as string).matchAll(/([\w:-]+)="([^"]*)"/g)].map((attr) => [attr[1] as string, attr[2] as string])),
  );
}

/** Big-endian reads over the bytes `readFileSync` gives (`tests/node-fs.d.ts` types them `Uint8Array`). */
const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** A PNG's IHDR chunk name and its width × height. */
function pngSize(bytes: Uint8Array): string {
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  return chunk === 'IHDR' ? `${view(bytes).getUint32(16, false)}x${view(bytes).getUint32(20, false)}` : `not a PNG (${chunk})`;
}

/** A baseline or progressive JPEG's frame size, from its first SOF marker. */
function jpegSize(bytes: Uint8Array): string | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const data = view(bytes);
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] as number;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return `${data.getUint16(at + 7, false)}x${data.getUint16(at + 5, false)}`;
    }
    at += 2 + data.getUint16(at + 2, false);
  }
  return null;
}

describe('link previews and the install sheet (SPEC-059 §4.6)', () => {
  it('carries the sixteen tags of §4.6.1, in order, after the theme-color meta', () => {
    const tags = headTags();
    const theme = tags.findIndex((tag) => tag['name'] === 'theme-color');
    expect(theme).toBeGreaterThanOrEqual(0);
    const preview = tags.slice(theme + 1, theme + 1 + PREVIEW_TAGS.length);
    expect(preview.map((tag) => [tag['rel'] !== undefined ? 'rel' : tag['property'] !== undefined ? 'property' : 'name', tag['rel'] ?? tag['property'] ?? tag['name'], tag['href'] ?? tag['content']])).toEqual(
      PREVIEW_TAGS.map((entry) => [...entry]),
    );
  });

  it('names SHARE_URL as the canonical URL, and its og.png as the image — absolute, as Open Graph requires', () => {
    const tags = headTags();
    expect(tags.find((tag) => tag['rel'] === 'canonical')?.['href']).toBe(SHARE_URL);
    expect(tags.find((tag) => tag['property'] === 'og:image')?.['content']).toBe(`${SHARE_URL}og.png`);
    expect(tags.find((tag) => tag['name'] === 'twitter:image')?.['content']).toBe(`${SHARE_URL}og.png`);
  });

  it('gives the manifest its description, id, category and three JPEG screenshots (§4.6.2)', () => {
    expect(MANIFEST.description).toBe(DESCRIPTION);
    expect(MANIFEST.id).toBe('/reallm/');
    expect(MANIFEST.categories).toEqual(['games']);
    expect(MANIFEST.screenshots).toEqual([
      { src: 'screenshots/wide-1.jpg', sizes: '1280x720', type: 'image/jpeg', form_factor: 'wide', label: 'A salvager on Cinder-4' },
      { src: 'screenshots/wide-2.jpg', sizes: '1280x720', type: 'image/jpeg', form_factor: 'wide', label: 'The ruins of Thessaly' },
      { src: 'screenshots/narrow-1.jpg', sizes: '1280x720', type: 'image/jpeg', form_factor: 'narrow', label: 'Playing on a phone' },
    ]);
  });

  it('ships og.png at 1200 × 630 within 1 MB, and each screenshot at 1280 × 720 within 350 KB (§4.6.3)', () => {
    const og = readFileSync(root('public/og.png'));
    expect(pngSize(og)).toBe('1200x630');
    expect(statSync(root('public/og.png')).size).toBeLessThanOrEqual(1024 * 1024);
    for (const shot of MANIFEST.screenshots) {
      const bytes = readFileSync(root(`public/${shot.src}`));
      expect(jpegSize(bytes), shot.src).toBe('1280x720');
      expect(bytes.length, shot.src).toBeLessThanOrEqual(350 * 1024);
    }
  });
});
