#!/usr/bin/env node
// The PWA app icons (SPEC-015 §10.1, D-14). The mark is not new art: it is
// `public/favicon.svg` — the ReaLLM tab icon, already recorded as this
// repository's own CC0 work — rasterized at three sizes, so the icon on a home
// screen is the icon in the tab.
//
// Pure Node, deterministic to the byte: the shapes are analytic signed distance
// fields sampled on a fixed 4 × 4 grid per pixel and written with `node:zlib` at
// a fixed deflate level, so a second run on a clean tree changes nothing
// (AC-62). No Blender, no browser, no network — the same route
// `textures/grid.png` and `noise.png` took.
//
//   node scripts/assets/icons.mjs
//
// Every constant below is exported and pinned by `tests/assets/icons.test.ts`.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- the mark

/**
 * `public/favicon.svg` on its own 64-unit viewBox, in draw order. The four
 * colours are the shipped ones: `#0b0f14` is the page background and the
 * `theme-color` (D-9), `#e6edf3` is `--ink` (`src/style.css`).
 */
export const MARK = {
  /** The design square every radius below is measured on. */
  units: 64,
  field: '#0b0f14',
  accent: '#39c5cf',
  ink: '#e6edf3',
  /** `<circle r="18" stroke-width="4">` — no fill. */
  ring: { radius: 18, stroke: 4 },
  /** `<circle r="6">`, filled. */
  core: { radius: 6 },
  /** `M32 6v8 …` — four cardinal segments, round caps. */
  ticks: { inner: 18, outer: 26, stroke: 4 },
  /** The favicon's own `rx`, carried by the two non-maskable icons. */
  cornerRadius: 12,
};

/**
 * The three files, their pixel size, and how much of the canvas the mark fills.
 *
 * `icon-512.png` is the maskable one. At scale 1 the tick tips sit at radius
 * 26/32 of the half-canvas — a 52/64 = 81 % diameter, just outside the 80 %
 * safe circle a launcher may crop to — so it draws at 0.70, which puts the
 * tips (caps included) at 28 × 0.70 / 32 = 61 % of the half-canvas. It also
 * drops the corner radius: the launcher applies its own mask, and a rounded
 * field under a circular mask shows four transparent nicks (15-k).
 */
export const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 1, cornerRadius: MARK.cornerRadius, purpose: 'any' },
  { file: 'icon-512.png', size: 512, scale: 0.7, cornerRadius: 0, purpose: 'any maskable' },
  { file: 'apple-touch-icon-180.png', size: 180, scale: 1, cornerRadius: MARK.cornerRadius, purpose: 'apple-touch-icon' },
];

/** A maskable icon may be cropped to this fraction of its width (W3C). */
export const MASKABLE_SAFE_FRACTION = 0.8;

/**
 * The outermost drawn radius, as a fraction of the canvas *width*, for a mark
 * at `scale`. The tick's round cap reaches half a stroke past its end point, so
 * this is the real outer edge of ink, not the path's end.
 */
export function outerInkFraction(scale) {
  return ((MARK.ticks.outer + MARK.ticks.stroke / 2) * scale) / MARK.units;
}

// ------------------------------------------------------------ the rasterizer

/** Samples per axis inside one pixel; 16 samples in total. */
export const SUPERSAMPLE = 4;
/** Fixed so two runs deflate to the same bytes (AC-62). */
export const DEFLATE_LEVEL = 9;

function parseHex(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** Distance from `(x, y)` to a segment `(ax, ay)–(bx, by)`. */
function distanceToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq));
  const px = x - (ax + t * dx);
  const py = y - (ay + t * dy);
  return Math.sqrt(px * px + py * py);
}

/** Distance from `(x, y)` to a rounded rectangle `0…size` with radius `r`. */
function distanceToRoundedRect(x, y, size, r) {
  const half = size / 2;
  const qx = Math.abs(x - half) - (half - r);
  const qy = Math.abs(y - half) - (half - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * The colour at one sample point, or `null` for "no ink here". Draw order is
 * the SVG's: field, ring, core, ticks — the last one that claims the sample
 * wins, which is what a painter's-algorithm rasterizer would do anyway.
 */
function sample(x, y, icon) {
  const { size, scale, cornerRadius } = icon;
  const centre = size / 2;
  /** One design unit in pixels, after the mark's own scale. */
  const unit = (size / MARK.units) * scale;
  const dx = x - centre;
  const dy = y - centre;
  const radius = Math.hypot(dx, dy) / unit;

  let colour = null;
  if (distanceToRoundedRect(x, y, size, (cornerRadius * size) / MARK.units) <= 0) colour = MARK.field;
  else return null; // outside the field the icon is transparent, ticks included

  if (Math.abs(radius - MARK.ring.radius) <= MARK.ring.stroke / 2) colour = MARK.accent;
  if (radius <= MARK.core.radius) colour = MARK.ink;

  // Four cardinal capsules. In design units, measured from the centre.
  const ux = dx / unit;
  const uy = dy / unit;
  const half = MARK.ticks.stroke / 2;
  const { inner, outer } = MARK.ticks;
  const onTick =
    distanceToSegment(ux, uy, 0, -inner, 0, -outer) <= half ||
    distanceToSegment(ux, uy, 0, inner, 0, outer) <= half ||
    distanceToSegment(ux, uy, -inner, 0, -outer, 0) <= half ||
    distanceToSegment(ux, uy, inner, 0, outer, 0) <= half;
  if (onTick) colour = MARK.accent;
  return colour;
}

/** One icon as straight-alpha RGBA rows. */
export function renderIcon(icon) {
  const { size } = icon;
  const rgba = new Uint8Array(size * size * 4);
  const cache = new Map();
  const rgbOf = (hex) => {
    let value = cache.get(hex);
    if (value === undefined) {
      value = parseHex(hex);
      cache.set(hex, value);
    }
    return value;
  };
  const step = 1 / SUPERSAMPLE;
  const total = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const colour = sample(px + (sx + 0.5) * step, py + (sy + 0.5) * step, icon);
          if (colour === null) continue;
          const [cr, cg, cb] = rgbOf(colour);
          r += cr;
          g += cg;
          b += cb;
          hits++;
        }
      }
      const at = (py * size + px) * 4;
      if (hits === 0) continue;
      // Straight alpha: the colour is the average of the samples that had ink.
      rgba[at] = Math.round(r / hits);
      rgba[at + 1] = Math.round(g / hits);
      rgba[at + 2] = Math.round(b / hits);
      rgba[at + 3] = Math.round((hits / total) * 255);
    }
  }
  return rgba;
}

// -------------------------------------------------------------- PNG writing

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 8-bit RGBA, no interlace, one filter-0 byte per scanline. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: DEFLATE_LEVEL })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------------- main

export const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'icons');

export function build(outDir = OUT_DIR) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const icon of ICONS) {
    const png = encodePng(icon.size, icon.size, renderIcon(icon));
    writeFileSync(join(outDir, icon.file), png);
    written.push({ file: icon.file, bytes: png.length });
  }
  return written;
}

// `node scripts/assets/icons.mjs` builds; importing it does not.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const { file, bytes } of build()) console.log(`${`public/icons/${file}`.padEnd(38)} ${String(bytes).padStart(7)} B`);
  console.log('\nOK — three icons from the favicon mark. Deterministic: a second run writes the same bytes.');
}
