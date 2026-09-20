// SPEC-015 §10.1 — the app icons' generator. The artwork is `public/favicon.svg`
// rasterized (D-14), so the geometry pinned here is the favicon's own: change
// one and the tab icon and the home-screen icon stop being the same mark.
//
// The generator is plain `.mjs` with no types of its own, so the shapes it
// exports are declared here and checked against what it actually returns.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain-JS generator, deliberately untyped (see above).
import * as icons from '../../scripts/assets/icons.mjs';

interface IconSpec {
  file: string;
  size: number;
  scale: number;
  cornerRadius: number;
  purpose: string;
}

const MARK = icons.MARK as {
  units: number;
  field: string;
  accent: string;
  ink: string;
  ring: { radius: number; stroke: number };
  core: { radius: number };
  ticks: { inner: number; outer: number; stroke: number };
  cornerRadius: number;
};
const ICONS = icons.ICONS as IconSpec[];
const outerInkFraction = icons.outerInkFraction as (scale: number) => number;
const MASKABLE_SAFE_FRACTION = icons.MASKABLE_SAFE_FRACTION as number;

const SVG = readFileSync(new URL('../../public/favicon.svg', import.meta.url).pathname, 'utf8');
const ICON_DIR = new URL('../../public/icons/', import.meta.url);

/** Width and height straight out of a PNG's IHDR — no decoder needed. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(new URL(file, ICON_DIR).pathname);
  expect(bytes.subarray(0, 8).toString('hex'), `${file} is a PNG`).toBe('89504e470d0a1a0a');
  expect(bytes.subarray(12, 16).toString('ascii'), `${file} starts with IHDR`).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('the mark (SPEC-015 D-14)', () => {
  it('is the favicon geometry, unit for unit (AC-63)', () => {
    expect(MARK.units).toBe(64);
    expect(MARK.ring).toEqual({ radius: 18, stroke: 4 });
    expect(MARK.core).toEqual({ radius: 6 });
    expect(MARK.ticks).toEqual({ inner: 18, outer: 26, stroke: 4 });
    expect(MARK.cornerRadius).toBe(12);
  });

  it('is the favicon colours, which are the app colours (D-9)', () => {
    expect(MARK.field).toBe('#0b0f14');
    expect(MARK.accent).toBe('#39c5cf');
    expect(MARK.ink).toBe('#e6edf3');
  });

  it('matches what public/favicon.svg actually draws', () => {
    expect(SVG).toContain('viewBox="0 0 64 64"');
    expect(SVG).toContain(`<rect width="64" height="64" rx="${MARK.cornerRadius}" fill="${MARK.field}"/>`);
    expect(SVG).toContain(`r="${MARK.ring.radius}" fill="none" stroke="${MARK.accent}" stroke-width="${MARK.ring.stroke}"`);
    expect(SVG).toContain(`r="${MARK.core.radius}" fill="${MARK.ink}"`);
    // `M32 6v8` — a tick from radius 26 in to radius 18, stroke 4, round caps.
    const centre = MARK.units / 2;
    expect(SVG).toContain(`d="M${centre} ${centre - MARK.ticks.outer}v${MARK.ticks.outer - MARK.ticks.inner}`);
    expect(SVG).toContain(`stroke-width="${MARK.ticks.stroke}" stroke-linecap="round"`);
  });
});

describe('the three icons (SPEC-015 §10.1)', () => {
  it('pins the layout constants per icon (AC-63)', () => {
    expect(ICONS).toEqual([
      { file: 'icon-192.png', size: 192, scale: 1, cornerRadius: 12, purpose: 'any' },
      { file: 'icon-512.png', size: 512, scale: 0.7, cornerRadius: 0, purpose: 'any maskable' },
      { file: 'apple-touch-icon-180.png', size: 180, scale: 1, cornerRadius: 12, purpose: 'apple-touch-icon' },
    ] satisfies IconSpec[]);
  });

  it('keeps the maskable icon inside the 80 % safe circle (AC-50, AC-63, 15-k)', () => {
    const maskable = ICONS.find((icon) => icon.purpose.includes('maskable')) as IconSpec;
    expect(maskable.size).toBe(512);
    // The safe circle's radius is half the safe diameter, as a fraction of width.
    const safeRadius = MASKABLE_SAFE_FRACTION / 2;
    expect(outerInkFraction(maskable.scale)).toBeLessThan(safeRadius);
    // …and the reason it had to shrink: at scale 1 it would not have been.
    expect(outerInkFraction(1)).toBeGreaterThan(safeRadius);
  });

  it('leaves the maskable field square, so no mask can nick a corner (15-k)', () => {
    const maskable = ICONS.find((icon) => icon.purpose.includes('maskable')) as IconSpec;
    expect(maskable.cornerRadius).toBe(0);
  });

  it('writes each file at the pixel size the manifest and the link claim (AC-50)', () => {
    expect(pngSize('icon-192.png')).toEqual({ width: 192, height: 192 });
    expect(pngSize('icon-512.png')).toEqual({ width: 512, height: 512 });
    expect(pngSize('apple-touch-icon-180.png')).toEqual({ width: 180, height: 180 });
  });
});

describe('the rasterizer', () => {
  it('draws the field, the ring, the core and the ticks in the right places', () => {
    const icon = ICONS[0] as IconSpec;
    const rgba = icons.renderIcon(icon) as Uint8Array;
    const at = (x: number, y: number): [number, number, number, number] => {
      const i = (y * icon.size + x) * 4;
      return [rgba[i] as number, rgba[i + 1] as number, rgba[i + 2] as number, rgba[i + 3] as number];
    };
    const centre = icon.size / 2;
    const unit = icon.size / MARK.units;
    // The core disc.
    expect(at(centre, centre)).toEqual([0xe6, 0xed, 0xf3, 255]);
    // Between the core and the ring: the field.
    expect(at(Math.round(centre + 12 * unit), centre)).toEqual([0x0b, 0x0f, 0x14, 255]);
    // On the ring.
    expect(at(Math.round(centre + MARK.ring.radius * unit), centre)).toEqual([0x39, 0xc5, 0xcf, 255]);
    // On a tick, between ring and tip.
    expect(at(Math.round(centre + 22 * unit), centre)).toEqual([0x39, 0xc5, 0xcf, 255]);
    expect(at(centre, Math.round(centre - 22 * unit))).toEqual([0x39, 0xc5, 0xcf, 255]);
    // The rounded corner is cut away.
    expect(at(0, 0)[3]).toBe(0);
    // …and the middle of an edge is not.
    expect(at(0, centre)[3]).toBe(255);
  });

  it('is deterministic: two renders of the same icon are byte-identical (AC-62)', () => {
    const icon = ICONS[2] as IconSpec;
    expect(Buffer.from(icons.renderIcon(icon) as Uint8Array)).toEqual(Buffer.from(icons.renderIcon(icon) as Uint8Array));
    const a = icons.encodePng(icon.size, icon.size, icons.renderIcon(icon)) as Buffer;
    const b = icons.encodePng(icon.size, icon.size, icons.renderIcon(icon)) as Buffer;
    expect(a.equals(b)).toBe(true);
    // …and that is what is committed.
    expect(a.equals(readFileSync(new URL(icon.file, ICON_DIR).pathname))).toBe(true);
  });
});

describe('the licence rows (AC-50, AC-64)', () => {
  const LICENSES = readFileSync(new URL('../../public/assets/LICENSES.md', import.meta.url).pathname, 'utf8');

  it('records every icon as original CC0 art of this repository', () => {
    for (const icon of ICONS) expect(LICENSES).toContain(`\`icons/${icon.file}\``);
  });
});
