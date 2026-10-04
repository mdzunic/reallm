// The foliage atlas without Blender (SPEC-052 §3.3, §4.6): the stand-in build
// (scripts/assets/README.md §7) of `scripts/assets/blender/foliage.py`, step for
// step — the same sixteen painters with the same parameters, drawing the same
// mulberry32 numbers in the same order — so it writes the file Blender would.
//
// textures/foliage/atlas.webp is 512 × 512 RGBA: a 4 × 4 grid of 128 px cells,
// row-major from the top-left (SPEC-052 §3.3). SPEC-053 binds it at runtime as
// the map of the trees' `Foliage` material and of the ground cover.
//   0, 1   jungle broad-leaf clusters    seen from above, any 90° rotation
//   2, 3   temperate leaf clusters       seen from above, any 90° rotation
//   4, 5   fern fronds                   base at the bottom edge, tip at the top
//   6, 7   lush grass; 8 dry grass;      tufts standing on the bottom edge
//   9      meadow flowers in grass
//   10, 11 frost fern, ash frond         fronds, base at the bottom edge
//   12, 13 hive tendrils, moss mound     standing on the bottom edge
//   14     broad-leaf ground plant       a rosette seen from above
//   15     bark                          opaque; fibres run along v, and its
//                                        120 px interior tiles both ways
//
// How it is painted: each cell at 4× supersampling (512 px), from seeded
// primitives — ribbons (a polyline spine with a half-width along it: leaves,
// pinnae, blades, stems, tendrils) and blobs (a radius around a centre: flower
// heads, the moss mound) — composited front over back with a soft contact
// shadow, then box-filtered to 128 px. Leaves are signed-distance leaf shapes
// with a midrib, veins and a value gradient; colours are mid-value, near-neutral
// greens and browns, because the runtime tints bring each planet's hue. Alpha is
// coverage; the 4 px gutter's alpha is 0, and the RGB of every pixel under
// alpha 0.5 is dilated, cell by cell, from the cell's own covered pixels, so
// mips never bleed a neighbour's colour or a black fringe.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { encodePng } from '../icons.mjs';
import { Rand, lattice, lin, nameSeed, pnoise, smoothstep as ss, toSrgb } from './tex.mjs';

export const ATLAS_SIZE = 512;
export const CELL = 128;
export const GUTTER = 4;
/** Supersampling per axis: a cell is painted at CELL × SS and box-filtered down. */
export const SS = 4;
export const QUALITY = 90;
export const ATLAS_FILE = 'textures/foliage/atlas.webp';

/** Each planet's `palette.ground` (src/data/planets.ts), for the preview sheet. */
export const GROUNDS = {
  cinder4: '#c19a5b',
  vetra: '#dbe9f2',
  thessaly: '#4f6b39',
  ferrum: '#3a2f2a',
  hive: '#3a2f4a',
  eden: '#6f9f5a',
};

const PI = Math.PI;
const TAU = 2 * Math.PI;
const UP = -PI / 2; // screen space: x right, y down, so "up" is −π/2
const clip = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

// ------------------------------------------------------------------ canvas

/** One cell, supersampled: coverage and premultiplied linear colour, row 0 at the top. */
class Canvas {
  constructor(name, res) {
    this.name = name;
    this.cell = res.cell;
    this.ss = res.ss;
    this.gutter = res.gutter;
    this.n = res.cell * res.ss;
    this.lo = res.gutter / res.cell; // the inner box, in cell units (0..1 across the cell)
    this.hi = 1 - this.lo;
    this.px = 1 / res.cell; // one output pixel, in cell units
    const size = this.n * this.n;
    this.a = new Float64Array(size);
    this.r = new Float64Array(size);
    this.g = new Float64Array(size);
    this.b = new Float64Array(size);
    const seed = nameSeed(name);
    const g1 = pnoise(this.n, 16, seed + 1);
    const g2 = pnoise(this.n, 48, seed + 2);
    this.grain = new Float64Array(size);
    for (let i = 0; i < size; i++) this.grain[i] = 0.6 * g1[i] + 0.4 * g2[i];
  }
}

// -------------------------------------------------------------- geometry

/** Arc-length parameter 0..1 at each point of a polyline. */
function arcParams(pts) {
  const s = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    total += Math.sqrt(dx * dx + dy * dy);
    s.push(total);
  }
  return s.map((d) => (total > 0 ? d / total : 0));
}

/**
 * A spine from (x, y) leaving at angle `a`: `steps` equal steps whose heading
 * at parameter s is a + bend·s + curl·s^pw, plus `kink` once s passes `at`.
 */
function path(x, y, a, length, steps, bend = 0, curl = 0, pw = 2, kink = 0, at = 2) {
  const pts = [[x, y]];
  const step = length / steps;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) / steps;
    const h = a + bend * s + curl * s ** pw + (s > at ? kink : 0);
    x += step * Math.cos(h);
    y += step * Math.sin(h);
    pts.push([x, y]);
  }
  return pts;
}

/** The point and heading at arc parameter `t` along a polyline. */
function pointAt(pts, t) {
  const s = arcParams(pts);
  let k = 0;
  while (k < pts.length - 2 && s[k + 1] < t) k++;
  const span = s[k + 1] - s[k];
  const f = span > 0 ? clip((t - s[k]) / span, 0, 1) : 0;
  const dx = pts[k + 1][0] - pts[k][0];
  const dy = pts[k + 1][1] - pts[k][1];
  return [pts[k][0] + f * dx, pts[k][1] + f * dy, Math.atan2(dy, dx)];
}

/**
 * The largest scale ≤ 1 about the spine's first point that keeps every point,
 * widened by its half-width, inside [lo, hi]²; `free` lifts the bottom bound
 * for things rooted in the bottom gutter.
 */
function fitScale(pts, wf, lo, hi, free = false) {
  const s = arcParams(pts);
  const [bx, by] = pts[0];
  let lam = 1;
  for (let i = 0; i < pts.length; i++) {
    const w = wf(s[i]);
    const ox = pts[i][0] - bx;
    const oy = pts[i][1] - by;
    if (ox + w > 0) lam = Math.min(lam, (hi - bx) / (ox + w));
    if (ox - w < 0) lam = Math.min(lam, (lo - bx) / (ox - w));
    if (oy + w > 0 && !free) lam = Math.min(lam, (hi - by) / (oy + w));
    if (oy - w < 0) lam = Math.min(lam, (lo - by) / (oy - w));
  }
  return Math.max(lam, 0.1);
}

function scaled(pts, lam) {
  const [bx, by] = pts[0];
  return pts.map(([x, y]) => [bx + lam * (x - bx), by + lam * (y - by)]);
}

/** Fit a ribbon into the cell's inner box (less `margin`): its spine and width, both scaled. */
function fitted(cv, pts, wf, margin, free = false) {
  const lam = fitScale(pts, wf, cv.lo + margin, cv.hi - margin, free);
  return [scaled(pts, lam), (s) => lam * wf(s), lam];
}

function shuffle(r, items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = r.integers(0, i + 1);
    const t = items[i];
    items[i] = items[j];
    items[j] = t;
  }
  return items;
}

// ------------------------------------------------------------ primitives

/**
 * Paint a ribbon: every pixel near the spine finds its nearest segment, giving
 * s (0..1 along), v (signed distance across, + on the right of the direction of
 * travel) and the half-width w(s); the edge distance |v| − w is the SDF. Before
 * the ribbon goes on, whatever lies under its rim darkens by `halo` over
 * `reach` (a soft contact shadow).
 */
function ribbon(cv, pts, wf, colour, halo = 0, reach = 0) {
  const n = cv.n;
  const s = arcParams(pts);
  let wmax = 0;
  for (let i = 0; i <= 32; i++) wmax = Math.max(wmax, wf(i / 32));
  const pad = wmax + reach + 2 / n;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const i0 = Math.max(0, Math.floor((minX - pad) * n));
  const i1 = Math.min(n, Math.ceil((maxX + pad) * n));
  const j0 = Math.max(0, Math.floor((minY - pad) * n));
  const j1 = Math.min(n, Math.ceil((maxY + pad) * n));
  if (i1 <= i0 || j1 <= j0) return;
  const out = [0, 0, 0];
  for (let j = j0; j < j1; j++) {
    const y = (j + 0.5) / n;
    for (let i = i0; i < i1; i++) {
      const x = (i + 0.5) / n;
      let best = Infinity;
      let bs = 0;
      let bv = 0;
      for (let k = 0; k + 1 < pts.length; k++) {
        const ax = pts[k][0];
        const ay = pts[k][1];
        const dx = pts[k + 1][0] - ax;
        const dy = pts[k + 1][1] - ay;
        const ll = dx * dx + dy * dy;
        if (ll <= 0) continue;
        const t = clip(((x - ax) * dx + (y - ay) * dy) / ll, 0, 1);
        const qx = x - ax - t * dx;
        const qy = y - ay - t * dy;
        const d = Math.sqrt(qx * qx + qy * qy);
        if (d < best) {
          best = d;
          bs = s[k] + t * (s[k + 1] - s[k]);
          bv = dx * qy - dy * qx < 0 ? -d : d;
        }
      }
      const w = wf(bs);
      const e = best - w;
      const at = j * n + i;
      if (halo > 0 && reach > 0) {
        const h = 1 - halo * (1 - ss(0, reach, e));
        cv.r[at] *= h;
        cv.g[at] *= h;
        cv.b[at] *= h;
      }
      const m = clip(0.5 - e * n, 0, 1);
      if (m > 0) {
        colour(bs, bv, w, x, y, cv.grain[at], out);
        cv.r[at] = cv.r[at] * (1 - m) + out[0] * m;
        cv.g[at] = cv.g[at] * (1 - m) + out[1] * m;
        cv.b[at] = cv.b[at] * (1 - m) + out[2] * m;
        cv.a[at] = cv.a[at] * (1 - m) + m;
      }
    }
  }
}

/** Paint a blob: radius rf(θ) around (cx, cy); the colour sees (d, θ, rf(θ)). */
function blob(cv, cx, cy, rf, colour, halo = 0, reach = 0) {
  const n = cv.n;
  let rmax = 0;
  for (let i = 0; i < 64; i++) rmax = Math.max(rmax, rf((TAU * i) / 64 - PI));
  const pad = rmax * 1.05 + reach + 2 / n;
  const i0 = Math.max(0, Math.floor((cx - pad) * n));
  const i1 = Math.min(n, Math.ceil((cx + pad) * n));
  const j0 = Math.max(0, Math.floor((cy - pad) * n));
  const j1 = Math.min(n, Math.ceil((cy + pad) * n));
  if (i1 <= i0 || j1 <= j0) return;
  const out = [0, 0, 0];
  for (let j = j0; j < j1; j++) {
    const y = (j + 0.5) / n;
    for (let i = i0; i < i1; i++) {
      const x = (i + 0.5) / n;
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const ang = Math.atan2(dy, dx);
      const rad = rf(ang);
      const e = d - rad;
      const at = j * n + i;
      if (halo > 0 && reach > 0) {
        const h = 1 - halo * (1 - ss(0, reach, e));
        cv.r[at] *= h;
        cv.g[at] *= h;
        cv.b[at] *= h;
      }
      const m = clip(0.5 - e * n, 0, 1);
      if (m > 0) {
        colour(d, ang, rad, x, y, cv.grain[at], out);
        cv.r[at] = cv.r[at] * (1 - m) + out[0] * m;
        cv.g[at] = cv.g[at] * (1 - m) + out[1] * m;
        cv.b[at] = cv.b[at] * (1 - m) + out[2] * m;
        cv.a[at] = cv.a[at] * (1 - m) + m;
      }
    }
  }
}

// ---------------------------------------------------------------- shapes

/**
 * A leaf's half-width along its midrib: W·sin(π·s^p)^k, the tip drawn out by
 * `tip`, with optional saw teeth, lobes and a wavy margin.
 */
function leafWidth(W, p, k, tip = 0, teeth = 0, depth = 0, lobes = 0, lobe = 0, waves = 0, wave = 0) {
  return (s) => {
    const q = clip(s, 0, 1);
    let w = W * Math.max(Math.sin(PI * q ** p), 0) ** k * (1 - tip * ss(0.55, 1, q));
    if (teeth > 0) w *= 1 - depth * (q * teeth - Math.floor(q * teeth));
    if (lobes > 0) w *= 1 - lobe + lobe * Math.abs(Math.cos(PI * q * lobes));
    if (waves > 0) w *= 1 + wave * Math.sin(PI * q * waves);
    return w;
  };
}

/** A blade: W at the base, tapering to a point. */
function bladeWidth(W, q) {
  return (s) => W * (1 - clip(s, 0, 1)) ** q;
}

/** A stem: W at the base, (1 − taper)·W at the end. */
function stemWidth(W, taper) {
  return (s) => W * (1 - taper * clip(s, 0, 1));
}

/** A twisting ribbon: narrowing to the tip, its width beating as it turns. */
function tendrilWidth(W, twist, phase) {
  return (s) => {
    const q = clip(s, 0, 1);
    return W * (1 - 0.8 * q) * (0.5 + 0.5 * Math.abs(Math.cos(PI * twist * q + phase)));
  };
}

// --------------------------------------------------------------- colours

function tint(base, value, hue) {
  return [base[0] * (1 + value) * (1 + 0.05 * hue), base[1] * (1 + value), base[2] * (1 + value) * (1 - 0.05 * hue)];
}

/** Which half of a leaf leaving at angle `a` faces the light (from the top-left). */
function litSide(a) {
  return -Math.sin(a) * -0.6 + Math.cos(a) * -0.8 > 0 ? 1 : -1;
}

/**
 * A leaf: a value gradient from base to tip, a lit and a shaded half, a darker
 * rim, pinnate veins sweeping toward the tip, a gloss band on the lit half, a
 * paler midrib, grain, and an optional darkening toward a cluster's heart.
 */
function leafColour(st, col, light, length, px, ao = null) {
  const lw = (0.5 * px * st.veins) / length; // a 0.5 px vein, in vein-phase units
  return (s, v, w, x, y, grain, out) => {
    const ww = Math.max(w, 1e-6);
    const t = Math.abs(v) / ww;
    let k = st.grad[0] + (st.grad[1] - st.grad[0]) * s;
    k *= 1 + st.side * clip((v * light) / (0.3 * ww), -1, 1);
    k *= 1 - st.rim * ss(0.72, 1, t);
    const phi = (s - st.sweep * t ** 1.3) * st.veins;
    const dphi = Math.abs(phi - Math.floor(phi + 0.5));
    const vl = (1 - ss(0.5 * lw, 1.5 * lw, dphi)) * ss(0.06, 0.2, t) * (1 - ss(0.75, 0.95, t)) * ss(0.03, 0.12, s) * (1 - ss(0.85, 0.97, s));
    k *= 1 + st.vein * vl;
    const hl = Math.exp(-(((t - 0.42) / 0.2) ** 2)) * ss(0.08, 0.35, s) * (1 - ss(0.7, 0.95, s)) * (v * light > 0 ? 1 : 0);
    k *= 1 + st.gloss * hl;
    if (ao !== null) {
      const ox = x - ao[0];
      const oy = y - ao[1];
      k *= ao[4] + (1 - ao[4]) * ss(ao[2], ao[3], Math.sqrt(ox * ox + oy * oy));
    }
    k *= 0.9 + 0.2 * grain;
    const mw = st.ribw * (1 - 0.75 * s);
    const mr = (1 - ss(0.6 * mw, 1.4 * mw, Math.abs(v))) * (1 - ss(0.8, 1, s));
    for (let c = 0; c < 3; c++) {
      const base = col[c] * k;
      out[c] = base + (base * st.rib - base) * mr;
    }
  };
}

/** A blade or stem: dark at the root, a lit and a shaded half, toward `tip` colour at the end. */
function bladeColour(col, tipCol, light, side, root, px) {
  return (s, v, w, x, y, grain, out) => {
    const ww = Math.max(w, 0.35 * px);
    let k = root + (1 - root) * ss(0, 0.45, s);
    k *= 1 + side * clip((v * light) / (0.5 * ww), -1, 1);
    k *= 0.9 + 0.2 * grain;
    const f = ss(0.35, 1, s);
    for (let c = 0; c < 3; c++) out[c] = (col[c] + (tipCol[c] - col[c]) * f) * k;
  };
}

/** Flat colour with grain: twigs, rachises, petioles. */
function flatColour(col, k0, k1) {
  return (s, v, w, x, y, grain, out) => {
    const k = (k0 + (k1 - k0) * s) * (0.9 + 0.2 * grain);
    for (let c = 0; c < 3; c++) out[c] = col[c] * k;
  };
}

const JUNGLE = { base: lin('#4d6744'), rib: 1.75, ribw: 0.011, vein: -0.2, veins: 9, sweep: 0.18, side: 0.18, rim: 0.3, gloss: 0.6, grad: [0.7, 1.05] };
const TEMPERATE = { base: lin('#6e8557'), rib: 1.45, ribw: 0.006, vein: 0.16, veins: 7, sweep: 0.15, side: 0.13, rim: 0.22, gloss: 0.12, grad: [0.78, 1.06] };
const TEMPERATE_B = { ...TEMPERATE, base: lin('#77895a'), veins: 6, sweep: 0.12 };
const FERN = { base: lin('#62784f'), rib: 1.3, ribw: 0.004, vein: 0.12, veins: 6, sweep: 0.1, side: 0.12, rim: 0.18, gloss: 0, grad: [0.85, 1.08] };
const FERN_B = { ...FERN, base: lin('#596f4f') };
const FROST = { base: lin('#a3b3ae'), rib: 1.25, ribw: 0.004, vein: 0.1, veins: 5, sweep: 0.1, side: 0.1, rim: -0.35, gloss: 0, grad: [0.88, 1.25] };
const ASH = { base: lin('#4f4945'), rib: 1.35, ribw: 0.004, vein: 0, veins: 4, sweep: 0.1, side: 0.12, rim: 0.2, gloss: 0, grad: [0.8, 1.6] };
const ROSETTE = { base: lin('#5b7350'), rib: 1.8, ribw: 0.009, vein: 0.22, veins: 8, sweep: 0.2, side: 0.14, rim: 0.2, gloss: 0.18, grad: [0.75, 1.05] };

const TWIG = lin('#5a5040');
const STALK = lin('#5f6a45');
const GRASS = lin('#6a8250');
const GRASS_TIP = lin('#9aa86c');
const DRY = lin('#968a66');
const DRY_TIP = lin('#bdb08a');
const SEED = lin('#8a7754');
const PETALS = [lin('#e6e2d2'), lin('#dccb8e'), lin('#cbbcd2')];
const EYE = lin('#9a7a40');
const HIVE = lin('#7c6f7a');
const HIVE_TIP = lin('#a89aa2');
const MOSS = lin('#5d6e45');
const MOSS_DEEP = lin('#38432b');
const MOSS_TIP = lin('#8d9c60');
const CAPSULE = lin('#8e7650');
const BARK_DARK = lin('#3b332c');
const BARK_LIGHT = lin('#6f665a');
const KNOT = lin('#5a4c3f');

// -------------------------------------------------------------- painters

/** A leaf from (x, y) at angle a, fitted into the cell, with its colour and a contact shadow. */
function leaf(cv, x, y, a, length, shape, bend, st, value, hue, ao, margin) {
  const wf = leafWidth(...shape);
  const [pts, wf2, lam] = fitted(cv, path(x, y, a, length, 14, bend), wf, margin);
  ribbon(cv, pts, wf2, leafColour(st, tint(st.base, value, hue), litSide(a), length * lam, cv.px, ao), 0.35, 3 * cv.px);
}

/** 0 — jungle broad-leaf cluster A: an umbrella of six or seven broad, glossy leaves on stalks. */
function jungleLeafA(cv, r) {
  const cx = 0.5 + r.uniform(-0.03, 0.03);
  const cy = 0.5 + r.uniform(-0.03, 0.03);
  const count = r.integers(6, 8);
  const a0 = r.uniform(0, TAU);
  const leaves = [];
  for (let i = 0; i < count; i++) {
    const a = a0 + (TAU * i) / count + r.uniform(-0.2, 0.2);
    const stalk = r.uniform(0.03, 0.07);
    const length = r.uniform(0.4, 0.5);
    const width = length * r.uniform(0.34, 0.42);
    const bend = r.uniform(-0.25, 0.25);
    const value = r.uniform(-0.1, 0.1);
    const hue = r.uniform(-1, 1);
    leaves.push([a, stalk, length, width, bend, value, hue]);
  }
  shuffle(r, leaves);
  for (const [a, stalk] of leaves) {
    ribbon(cv, [[cx, cy], [cx + stalk * Math.cos(a), cy + stalk * Math.sin(a)]], stemWidth(0.007, 0.3), flatColour(STALK, 0.7, 1), 0.3, 2 * cv.px);
  }
  for (const [a, stalk, length, width, bend, value, hue] of leaves) {
    const bx = cx + stalk * Math.cos(a);
    const by = cy + stalk * Math.sin(a);
    leaf(cv, bx, by, a, length, [width, 0.72, 0.75, 0.45], bend, JUNGLE, value, hue, [cx, cy, 0, 0.32, 0.6], 1.5 * cv.px);
  }
  blob(cv, cx, cy, () => 0.016, (d, ang, rad, x, y, grain, out) => {
    const k = (0.55 + 0.35 * (1 - d / rad)) * (0.9 + 0.2 * grain);
    for (let c = 0; c < 3; c++) out[c] = STALK[c] * k;
  }, 0.3, 2 * cv.px);
}

/** 1 — jungle broad-leaf cluster B: a twig across the cell with broad leaves alternating along it. */
function jungleLeafB(cv, r) {
  const sx = r.uniform(0.16, 0.24);
  const sy = r.uniform(0.76, 0.84);
  const a = -PI / 4 + r.uniform(-0.15, 0.15);
  const bend = r.uniform(-0.35, 0.35);
  const twig = path(sx, sy, a, 0.72, 16, bend);
  const leaves = [];
  for (let i = 0; i < 7; i++) {
    const k = 2 + 2 * i;
    const side = i % 2 === 0 ? 1 : -1;
    const heading = a + bend * (k / 16);
    const la = heading + side * r.uniform(0.75, 1.05);
    const length = r.uniform(0.33, 0.42) * (1 - 0.2 * (k / 16));
    const width = length * r.uniform(0.38, 0.45);
    const lb = r.uniform(-0.3, 0.3);
    const value = r.uniform(-0.1, 0.1);
    const hue = r.uniform(-1, 1);
    leaves.push([twig[k][0], twig[k][1], la, length, width, lb, value, hue]);
  }
  const end = twig[16];
  leaves.push([end[0], end[1], a + bend, r.uniform(0.26, 0.3), 0.12, r.uniform(-0.2, 0.2), r.uniform(-0.1, 0.1), r.uniform(-1, 1)]);
  ribbon(cv, twig, stemWidth(0.009, 0.5), flatColour(TWIG, 0.75, 1), 0.3, 2 * cv.px);
  for (const [x, y, la, length, width, lb, value, hue] of leaves) {
    leaf(cv, x, y, la, length, [width, 0.72, 0.75, 0.45], lb, JUNGLE, value, hue, null, 1.5 * cv.px);
  }
}

/** How far from (cx, cy) along angle a before leaving the box [lo, hi]². */
function reachTo(cx, cy, a, lo, hi) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  let t = 10;
  if (c > 1e-9) t = Math.min(t, (hi - cx) / c);
  if (c < -1e-9) t = Math.min(t, (lo - cx) / c);
  if (s > 1e-9) t = Math.min(t, (hi - cy) / s);
  if (s < -1e-9) t = Math.min(t, (lo - cy) / s);
  return t;
}

/**
 * Twigs radiating from (cx, cy), each reaching `reach` of the way to the edge
 * of the cell (so the ones toward the corners run longer and the cluster fills
 * the square), with leaves alternating along it and one at its end.
 */
function sprays(cv, r, cx, cy, twigs, reach, leafLen, shape, st, per) {
  const a0 = r.uniform(0, TAU);
  const leaves = [];
  const stems = [];
  for (let i = 0; i < twigs; i++) {
    const a = a0 + (TAU * i) / twigs + r.uniform(-0.2, 0.2);
    const length = reachTo(cx, cy, a, cv.lo, cv.hi) * r.uniform(reach[0], reach[1]);
    const bend = r.uniform(-0.4, 0.4);
    const twig = path(cx, cy, a, length, 16, bend);
    stems.push(twig);
    for (let j = 0; j < per; j++) {
      const k = 3 + Math.floor((13 * j) / per);
      const side = (i + j) % 2 === 0 ? 1 : -1;
      const heading = a + bend * (k / 16);
      const la = heading + side * r.uniform(0.6, 1.0);
      const l = r.uniform(leafLen[0], leafLen[1]);
      const lb = r.uniform(-0.3, 0.3);
      leaves.push([twig[k][0], twig[k][1], la, l, lb, r.uniform(-0.1, 0.1), r.uniform(-1, 1)]);
    }
    const end = twig[16];
    leaves.push([end[0], end[1], a + bend, r.uniform(leafLen[0], leafLen[1]), r.uniform(-0.2, 0.2), r.uniform(-0.1, 0.1), r.uniform(-1, 1)]);
  }
  for (const twig of stems) ribbon(cv, twig, stemWidth(0.006, 0.5), flatColour(TWIG, 0.75, 1), 0.3, 2 * cv.px);
  shuffle(r, leaves);
  for (const [x, y, la, l, lb, value, hue] of leaves) {
    leaf(cv, x, y, la, l, [l * shape[0], shape[1], shape[2], shape[3], shape[4], shape[5]], lb, st, value, hue, [cx, cy, 0, 0.3, 0.7], 1.5 * cv.px);
  }
}

/** 2 — temperate leaf cluster A: six leafy twigs radiating from the middle; small, pointed, serrate leaves. */
function temperateLeafA(cv, r) {
  const cx = 0.5 + r.uniform(-0.03, 0.03);
  const cy = 0.5 + r.uniform(-0.03, 0.03);
  sprays(cv, r, cx, cy, 6, [0.6, 0.72], [0.12, 0.16], [0.4, 0.85, 0.95, 0.3, 9, 0.08], TEMPERATE, 5);
}

/** 3 — temperate leaf cluster B: seven twigs, rounder leaves, a denser and paler crown. */
function temperateLeafB(cv, r) {
  const cx = 0.5 + r.uniform(-0.04, 0.04);
  const cy = 0.5 + r.uniform(-0.04, 0.04);
  sprays(cv, r, cx, cy, 7, [0.55, 0.68], [0.11, 0.14], [0.52, 0.8, 0.65, 0.1, 7, 0.06], TEMPERATE_B, 4);
}

/**
 * A frond: a rachis from the bottom gutter to the top of the cell, pinnae in
 * (sub)opposite pairs along it — short at the base, longest a third of the way
 * up, tapering to the tip — then the rachis drawn over their bases.
 */
function frond(cv, r, f) {
  const bx = 0.5 + r.uniform(-0.03, 0.03);
  const by = 1 - 0.5 * cv.lo;
  const lean = r.uniform(-0.06, 0.06);
  const bend = f.bend * (r.random() < 0.5 ? -1 : 1) * r.uniform(0.7, 1);
  const length = (by - cv.lo - 2 * cv.px) * 1.02;
  const kink = f.kink * (r.random() < 0.5 ? -1 : 1);
  const raw = path(bx, by, UP + lean, length, 24, bend, 0, 2, kink, 0.5);
  const [spine, rw] = fitted(cv, raw, stemWidth(f.rachis, 0.75), 1.5 * cv.px, true);
  const pinnae = [];
  for (let i = 0; i < f.pairs; i++) {
    const t = f.start + ((1 - f.start) * (i + 0.5)) / f.pairs;
    const env = Math.max(Math.sin(PI * clip((t + 0.12) / 1.1, 0, 1)), 0) ** 0.9;
    for (const side of [-1, 1]) {
      const st = clip(t + side * f.offset, 0, 0.98);
      const skip = r.random() < f.skip;
      const angle = (f.angle[0] + (f.angle[1] - f.angle[0]) * st) * r.uniform(0.92, 1.08);
      const length = f.reach * env * r.uniform(0.82, 1);
      const value = r.uniform(-0.1, 0.1);
      const hue = r.uniform(-1, 1);
      if (!skip) pinnae.push([st, side, angle, length, value, hue]);
    }
  }
  for (const [st, side, angle, length, value, hue] of pinnae) {
    const [x, y, heading] = pointAt(spine, st);
    const a = heading + side * angle;
    const shape = [length * f.shape[0], f.shape[1], f.shape[2], f.shape[3], f.shape[4], f.shape[5], f.shape[6], f.shape[7]];
    leaf(cv, x, y, a, length, shape, -side * f.curve, f.style, value, hue, null, 1.5 * cv.px);
  }
  ribbon(cv, spine, rw, flatColour(f.stem, 0.7, 1.1), 0.25, 2 * cv.px);
}

/** 4 — fern frond A: broad, lanceolate, lobed pinnae curving toward the tip. */
function fernFrondA(cv, r) {
  frond(cv, r, { pairs: 14, start: 0.07, offset: 0.008, reach: 0.44, angle: [1.3, 0.8], curve: 0.3, bend: 0.22, kink: 0, skip: 0,
    shape: [0.14, 0.8, 0.85, 0.35, 0, 0, 7, 0.25], style: FERN, stem: lin('#56603f'), rachis: 0.009 });
}

/** 5 — fern frond B: narrower and longer-lobed, subopposite pinnae, the tip nodding to one side. */
function fernFrondB(cv, r) {
  frond(cv, r, { pairs: 17, start: 0.06, offset: 0.025, reach: 0.38, angle: [1.15, 0.75], curve: 0.45, bend: 0.4, kink: 0, skip: 0,
    shape: [0.12, 0.8, 0.95, 0.4, 0, 0, 9, 0.3], style: FERN_B, stem: lin('#535c40'), rachis: 0.008 });
}

/** 10 — frost fern (Vetra): straight, pale and crisp; narrow saw-toothed pinnae with bright rims and white tips. */
function frostFern(cv, r) {
  frond(cv, r, { pairs: 12, start: 0.08, offset: 0, reach: 0.42, angle: [1.05, 0.8], curve: 0.05, bend: 0.06, kink: 0, skip: 0,
    shape: [0.13, 0.75, 1.3, 0, 6, 0.35, 0, 0], style: FROST, stem: lin('#8c9a98'), rachis: 0.008 });
}

/** 11 — ash frond (Ferrum): a crooked dark rachis, few drooping ragged pinnae, ash-pale tips. */
function ashFrond(cv, r) {
  frond(cv, r, { pairs: 9, start: 0.12, offset: 0.03, reach: 0.4, angle: [1.45, 1.05], curve: -0.35, bend: 0.12, kink: 0.35, skip: 0.3,
    shape: [0.13, 0.8, 0.9, 0.2, 5, 0.18, 0, 0], style: ASH, stem: lin('#3e3835'), rachis: 0.01 });
}

/**
 * A tuft: blades rooted in the bottom gutter, fanning out and drooping. `kinks`
 * is the chance a blade has snapped and flops over.
 */
function tuft(cv, r, g) {
  const blades = [];
  for (let i = 0; i < g.count; i++) {
    const bx = r.uniform(g.x[0], g.x[1]);
    const height = r.uniform(g.h[0], g.h[1]) * (cv.hi - cv.lo);
    const lean = (bx - 0.5) * g.fan + r.uniform(-g.jitter, g.jitter);
    const droop = g.droop * r.uniform(0.3, 1) * (lean < 0 ? -1 : 1);
    const width = r.uniform(g.w[0], g.w[1]);
    const value = r.uniform(-0.12, 0.12);
    const hue = r.uniform(-1, 1);
    let kink = 0;
    let at = 2;
    if (r.random() < g.kinks) {
      kink = (lean < 0 ? -1 : 1) * r.uniform(0.6, 1.3);
      at = r.uniform(0.45, 0.8);
    }
    blades.push([bx, height, lean, droop, width, value, hue, kink, at]);
  }
  shuffle(r, blades);
  for (const [bx, height, lean, droop, width, value, hue, kink, at] of blades) {
    const raw = path(bx, 1 - 0.5 * cv.lo, UP + lean, height, 12, 0, droop, 2, kink, at);
    const [pts, wf] = fitted(cv, raw, bladeWidth(width, 0.6), 1.5 * cv.px, true);
    const colour = bladeColour(tint(g.col, value, hue), tint(g.tip, value, hue), litSide(UP + lean), 0.12, g.root, cv.px);
    ribbon(cv, pts, wf, colour, 0.25, 2 * cv.px);
  }
}

/** 6 — lush grass A: a full tuft fanning from the middle. */
function lushGrassA(cv, r) {
  tuft(cv, r, { count: 36, x: [0.24, 0.76], h: [0.5, 0.95], fan: 1.6, jitter: 0.18, droop: 0.9, w: [0.011, 0.017], kinks: 0, col: GRASS, tip: GRASS_TIP, root: 0.45 });
}

/** 7 — lush grass B: a wider, shorter, more upright strip of finer blades. */
function lushGrassB(cv, r) {
  tuft(cv, r, { count: 60, x: [0.07, 0.93], h: [0.32, 0.72], fan: 0.7, jitter: 0.16, droop: 0.5, w: [0.008, 0.012], kinks: 0, col: GRASS, tip: GRASS_TIP, root: 0.5 });
}

/** Thin stems from the bottom gutter, each ending in a head painted by `head(x, y, angle, i)`. */
function stalks(cv, r, count, x, h, width, col, head) {
  const made = [];
  for (let i = 0; i < count; i++) {
    const bx = r.uniform(x[0], x[1]);
    const height = r.uniform(h[0], h[1]) * (cv.hi - cv.lo);
    const lean = (bx - 0.5) * 0.8 + r.uniform(-0.12, 0.12);
    const droop = r.uniform(-0.25, 0.25);
    made.push([bx, height, lean, droop]);
  }
  for (let i = 0; i < made.length; i++) {
    const [bx, height, lean, droop] = made[i];
    const raw = path(bx, 1 - 0.5 * cv.lo, UP + lean, height, 10, 0, droop, 2);
    const [pts, wf] = fitted(cv, raw, stemWidth(width, 0.3), 8 * cv.px, true);
    ribbon(cv, pts, wf, flatColour(col, 0.6, 1), 0.2, 2 * cv.px);
    const tipPt = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    head(tipPt[0], tipPt[1], Math.atan2(tipPt[1] - prev[1], tipPt[0] - prev[0]), i);
  }
}

/** 8 — dry grass: thin straw blades, some snapped and flopping, and a few seed heads. */
function dryGrass(cv, r) {
  tuft(cv, r, { count: 30, x: [0.15, 0.85], h: [0.5, 0.95], fan: 1.2, jitter: 0.2, droop: 0.6, w: [0.006, 0.01], kinks: 0.3, col: DRY, tip: DRY_TIP, root: 0.5 });
  const heads = [];
  for (let i = 0; i < 5; i++) heads.push([r.uniform(0.1, 0.16), r.uniform(-0.3, 0.3), r.uniform(-0.1, 0.1)]);
  stalks(cv, r, 5, [0.3, 0.7], [0.72, 0.9], 0.004, DRY, (x, y, a, i) => {
    const [length, bend, value] = heads[i];
    leaf(cv, x, y, a, length, [0.013, 0.6, 0.7, 0], bend, { ...ASH, base: SEED, rim: 0.15, grad: [0.85, 1.15] }, value, 0, null, 1.5 * cv.px);
  });
}

/** 9 — meadow flowers in grass: short blades, and seven stems ending in round petalled heads. */
function meadowFlowers(cv, r) {
  const flowers = [];
  for (let i = 0; i < 7; i++) {
    flowers.push([r.uniform(0.04, 0.055), r.integers(5, 9), r.uniform(0, TAU), r.integers(0, 3), r.uniform(-0.08, 0.08)]);
  }
  stalks(cv, r, 7, [0.14, 0.86], [0.45, 0.85], 0.005, lin('#5d7046'), (x, y, a, i) => {
    const [rad, petals, phase, kind, value] = flowers[i];
    const petal = tint(PETALS[kind], value, 0);
    const rf = (ang) => rad * (0.68 + 0.32 * Math.abs(Math.cos((petals * ang) / 2 + phase)) ** 0.7);
    blob(cv, x, y, rf, (d, ang, rr, px, py, grain, out) => {
      const u = d / rad;
      const eye = 1 - ss(0.26, 0.36, u);
      const k = (0.82 + 0.25 * ss(0.3, 0.9, u)) * (0.92 + 0.16 * grain);
      for (let c = 0; c < 3; c++) out[c] = (petal[c] + (EYE[c] - petal[c]) * eye) * k;
    }, 0.3, 2 * cv.px);
  });
  tuft(cv, r, { count: 36, x: [0.08, 0.92], h: [0.22, 0.58], fan: 1.0, jitter: 0.2, droop: 0.7, w: [0.009, 0.014], kinks: 0, col: GRASS, tip: GRASS_TIP, root: 0.5 });
}

/** 12 — hive tendril: five twisting ribbons rising from the root and curling at their tips; ribbed. */
function hiveTendril(cv, r) {
  const tendrils = [];
  for (let i = 0; i < 5; i++) {
    const bx = 0.3 + (0.4 * i) / 4 + r.uniform(-0.04, 0.04);
    const lean = (bx - 0.5) * 1.4 + r.uniform(-0.15, 0.15);
    const length = r.uniform(0.85, 1.15);
    const dir = r.random() < 0.5 ? -1 : 1;
    const curl = dir * r.uniform(4, 6);
    const bend = -dir * r.uniform(0.2, 0.6);
    const width = r.uniform(0.032, 0.042);
    const twist = r.uniform(1.5, 3);
    const phase = r.uniform(0, PI);
    const value = r.uniform(-0.1, 0.1);
    tendrils.push([bx, lean, length, curl, bend, width, twist, phase, value]);
  }
  shuffle(r, tendrils);
  for (const [bx, lean, length, curl, bend, width, twist, phase, value] of tendrils) {
    const raw = path(bx, 1 - 0.5 * cv.lo, UP + lean, length, 48, bend, curl, 3);
    const [pts, wf, lam] = fitted(cv, raw, tendrilWidth(width, twist, phase), 1.5 * cv.px, true);
    const col = tint(HIVE, value, 0);
    const tip = tint(HIVE_TIP, value, 0);
    const rings = (length * lam) / 0.018;
    ribbon(cv, pts, wf, (s, v, w, x, y, grain, out) => {
      const t = Math.abs(v) / Math.max(w, 1e-6);
      const rib = 0.5 + 0.5 * Math.cos(TAU * s * rings);
      let k = (0.5 + 0.5 * ss(0, 0.3, s)) * (0.82 + 0.22 * rib);
      k *= 1 + 0.25 * ss(0.6, 1, t) - 0.18 * (v < 0 ? 1 : 0);
      k *= 0.9 + 0.2 * grain;
      const f = ss(0.4, 1, s);
      for (let c = 0; c < 3; c++) out[c] = (col[c] + (tip[c] - col[c]) * f) * k;
    }, 0.35, 3 * cv.px);
  }
}

/** 13 — moss clump: a dense low mound of short strands, with a few spore stalks above it. */
function mossClump(cv, r) {
  const cx = 0.5 + r.uniform(-0.02, 0.02);
  const cy = 1 - cv.lo;
  const ra = r.uniform(0.4, 0.44);
  const rb = r.uniform(0.36, 0.42);
  const bumps = [r.uniform(0, TAU), r.uniform(0, TAU), r.uniform(0, TAU)];
  const dome = (ang) => {
    const c = Math.cos(ang) / ra;
    const s = Math.sin(ang) / rb;
    const rr = 1 / Math.sqrt(c * c + s * s);
    return rr * (1 + 0.06 * Math.sin(5 * ang + bumps[0]) + 0.04 * Math.sin(9 * ang + bumps[1]) + 0.025 * Math.sin(17 * ang + bumps[2]));
  };
  blob(cv, cx, cy, (ang) => 0.92 * dome(ang), (d, ang, rad, x, y, grain, out) => {
    const k = (0.6 + 0.4 * ss(0.2, 1, d / rad)) * (0.85 + 0.3 * grain);
    for (let c = 0; c < 3; c++) out[c] = MOSS_DEEP[c] * k;
  });
  const strands = [];
  for (let i = 0; i < 900; i++) {
    const ang = -PI + PI * r.random();
    const depth = Math.sqrt(r.random());
    const length = r.uniform(0.018, 0.034);
    const width = r.uniform(0.003, 0.0048);
    const wobble = r.uniform(-0.5, 0.5);
    const value = r.uniform(-0.12, 0.12);
    const hue = r.uniform(-1, 1);
    strands.push([ang, depth, length, width, wobble, value, hue]);
  }
  strands.sort((p, q) => p[1] - q[1]);
  for (const [ang, depth, length, width, wobble, value, hue] of strands) {
    const rad = dome(ang) * depth * 0.95;
    const x = cx + rad * Math.cos(ang);
    const y = cy + rad * Math.sin(ang);
    const a = ang + wobble;
    const [pts, wf] = fitted(cv, path(x, y, a, length, 4, wobble * 0.5), bladeWidth(width, 0.5), 1.5 * cv.px, true);
    const col = tint(MOSS, value, hue);
    const tip = tint(MOSS_TIP, value, hue);
    const shade = 0.55 + 0.45 * depth;
    ribbon(cv, pts, wf, bladeColour(col, tip, litSide(a), 0.1, shade, cv.px), 0.2, 1.5 * cv.px);
  }
  for (let i = 0; i < 9; i++) {
    const ang = -PI + PI * r.uniform(0.15, 0.85);
    const x = cx + dome(ang) * 0.8 * Math.cos(ang);
    const y = cy + dome(ang) * 0.8 * Math.sin(ang);
    const a = UP + r.uniform(-0.35, 0.35);
    const length = r.uniform(0.1, 0.18);
    const [pts, wf] = fitted(cv, path(x, y, a, length, 6, r.uniform(-0.4, 0.4)), stemWidth(0.0028, 0.2), 6 * cv.px);
    ribbon(cv, pts, wf, flatColour(lin('#7a6a48'), 0.8, 1.1), 0, 0);
    const end = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    const ca = Math.atan2(end[1] - prev[1], end[0] - prev[0]) + r.uniform(-0.5, 0.5);
    leaf(cv, end[0], end[1], ca, 0.03, [0.008, 0.6, 0.6, 0], 0, { ...ASH, base: CAPSULE, rim: 0.2, grad: [0.9, 1.15] }, r.uniform(-0.1, 0.1), 0, null, 1.5 * cv.px);
  }
}

/** 14 — broad-leaf ground plant: a rosette seen from above, an outer whorl under a younger inner one. */
function groundPlant(cv, r) {
  const cx = 0.5 + r.uniform(-0.02, 0.02);
  const cy = 0.5 + r.uniform(-0.02, 0.02);
  const a0 = r.uniform(0, TAU);
  const whorls = [[6, 0.44, 0.44, 0], [5, 0.3, 0.46, 0.5]];
  const leaves = [];
  for (const [count, reach, wr, offset] of whorls) {
    for (let i = 0; i < count; i++) {
      const a = a0 + (TAU * (i + offset)) / count + r.uniform(-0.15, 0.15);
      const length = reach * r.uniform(0.92, 1.05);
      const bend = r.uniform(-0.2, 0.2);
      const value = r.uniform(-0.08, 0.08) + (offset > 0 ? 0.08 : 0);
      const hue = r.uniform(-1, 1);
      leaves.push([a, length, length * wr, bend, value, hue]);
    }
  }
  for (const [a, length, width, bend, value, hue] of leaves) {
    leaf(cv, cx, cy, a, length, [width, 1.25, 0.6, 0, 0, 0, 0, 0, 6, 0.04], bend, ROSETTE, value, hue, [cx, cy, 0, 0.28, 0.55], 1.5 * cv.px);
  }
  blob(cv, cx, cy, () => 0.022, (d, ang, rad, x, y, grain, out) => {
    const k = (0.75 + 0.3 * (1 - d / rad)) * (0.9 + 0.2 * grain);
    for (let c = 0; c < 3; c++) out[c] = ROSETTE.base[c] * 1.2 * k;
  }, 0.3, 2 * cv.px);
}

/** Periodic value noise at tile coordinates (u, v), period 1 both ways, cx × cy lattice cells. */
function vnoiseAt(u, v, cx, cy, seed) {
  const tx = u * cx;
  const ty = v * cy;
  const x0 = Math.floor(tx);
  const y0 = Math.floor(ty);
  let fx = tx - x0;
  let fy = ty - y0;
  fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const ix0 = ((x0 % cx) + cx) % cx;
  const iy0 = ((y0 % cy) + cy) % cy;
  const ix1 = (ix0 + 1) % cx;
  const iy1 = (iy0 + 1) % cy;
  const a = lattice(ix0, iy0, seed);
  const b = lattice(ix1, iy0, seed);
  const c = lattice(ix0, iy1, seed);
  const d = lattice(ix1, iy1, seed);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * 15 — bark: opaque, two tones of grey-brown. Ridged fibres run along v and
 * part around three knots with growth rings. Every field is periodic over the
 * 120 px interior (the cell's grain is not used), so it tiles both ways and a
 * trunk can wrap it with no seam.
 */
function bark(cv, r) {
  const seed = nameSeed(cv.name);
  const knots = [];
  for (let i = 0; i < 3; i++) knots.push([r.random(), r.random(), r.uniform(0.035, 0.055), r.uniform(0.07, 0.11)]);
  const n = cv.n;
  const inner = cv.gutter * cv.ss;
  const size = n - 2 * inner;
  for (let j = inner; j < n - inner; j++) {
    const v = (j - inner + 0.5) / size;
    for (let i = inner; i < n - inner; i++) {
      const u = (i - inner + 0.5) / size;
      let wu = u;
      let wv = v;
      let ring = 0;
      let inKnot = 0;
      for (const [kx, ky, rx, ry] of knots) {
        let dx = u - kx;
        let dy = v - ky;
        dx -= Math.floor(dx + 0.5);
        dy -= Math.floor(dy + 0.5);
        const q = Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
        const g = Math.exp(-0.5 * ((dx / (2.2 * rx)) ** 2 + (dy / (2.2 * ry)) ** 2));
        wu -= 0.85 * dx * g;
        wv -= 0.3 * dy * g;
        const inside = 1 - ss(0.85, 1.05, q);
        ring = Math.max(ring, inside * (0.5 + 0.5 * Math.cos(q * 4 * TAU)) * ss(0.12, 0.3, q));
        inKnot = Math.max(inKnot, inside);
      }
      const f1 = vnoiseAt(wu, wv, 36, 2, seed + 11);
      const f2 = vnoiseAt(wu, wv, 96, 5, seed + 12);
      const f3 = vnoiseAt(u, v, 10, 10, seed + 13);
      const tone = 0.62 * f1 + 0.38 * f2;
      const ridge = ss(0.4, 0.66, tone);
      const furrow = 1 - ss(0.2, 0.36, tone);
      const at = j * n + i;
      const f4 = vnoiseAt(u, v, 40, 40, seed + 14);
      const k = (0.86 + 0.28 * f3) * (1 - 0.55 * furrow) * (0.92 + 0.16 * f4);
      const out = [0, 0, 0];
      for (let c = 0; c < 3; c++) out[c] = BARK_DARK[c] + (BARK_LIGHT[c] - BARK_DARK[c]) * ridge;
      const kn = 0.55 + 0.45 * ring;
      for (let c = 0; c < 3; c++) out[c] = out[c] + (KNOT[c] * kn - out[c]) * inKnot;
      cv.r[at] = out[0] * k;
      cv.g[at] = out[1] * k;
      cv.b[at] = out[2] * k;
      cv.a[at] = 1;
    }
  }
}

/** The sixteen cells, row-major from the top-left (SPEC-052 §3.3); the name seeds each one. */
export const CELLS = [
  ['jungle_leaf_a', jungleLeafA],
  ['jungle_leaf_b', jungleLeafB],
  ['temperate_leaf_a', temperateLeafA],
  ['temperate_leaf_b', temperateLeafB],
  ['fern_frond_a', fernFrondA],
  ['fern_frond_b', fernFrondB],
  ['lush_grass_a', lushGrassA],
  ['lush_grass_b', lushGrassB],
  ['dry_grass', dryGrass],
  ['meadow_flowers', meadowFlowers],
  ['frost_fern', frostFern],
  ['ash_frond', ashFrond],
  ['hive_tendril', hiveTendril],
  ['moss_clump', mossClump],
  ['ground_plant', groundPlant],
  ['bark', bark],
];
/** The one opaque cell. */
const OPAQUE = 'bark';

// ---------------------------------------------------------------- finish

const NEIGHBOURS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

/**
 * Grow colour from the `known` pixels into the rest of a cell, one ring of
 * 8-neighbours at a time, each new pixel taking the mean of its known
 * neighbours — so every pixel ends with the colour of its nearest covered one.
 */
function dilate(chans, known, size) {
  const count = new Float64Array(size * size);
  const sums = chans.map(() => new Float64Array(size * size));
  for (const ch of chans) for (let i = 0; i < ch.length; i++) if (!known[i]) ch[i] = 0;
  for (;;) {
    let grew = false;
    count.fill(0);
    for (const s of sums) s.fill(0);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const at = y * size + x;
        for (const [dy, dx] of NEIGHBOURS) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= size || xx < 0 || xx >= size) continue;
          const from = yy * size + xx;
          if (!known[from]) continue;
          count[at] += 1;
          for (let c = 0; c < chans.length; c++) sums[c][at] += chans[c][from];
        }
      }
    }
    const grow = new Uint8Array(size * size);
    for (let i = 0; i < grow.length; i++) {
      if (!known[i] && count[i] > 0) {
        grow[i] = 1;
        grew = true;
      }
    }
    if (!grew) break;
    for (let i = 0; i < grow.length; i++) {
      if (grow[i]) {
        for (let c = 0; c < chans.length; c++) chans[c][i] = sums[c][i] / count[i];
        known[i] = 1;
      }
    }
  }
  return chans;
}

/** Box-filter a canvas to the cell, unpremultiply, clear the gutter, dilate. Returns [r, g, b, a] (linear rgb). */
function finish(cv, opaque) {
  const { cell, ss: k, gutter } = cv;
  const n = cv.n;
  const down = (src) => {
    const out = new Float64Array(cell * cell);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        let sum = 0;
        for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) sum += src[(y * k + yy) * n + x * k + xx];
        out[y * cell + x] = sum / (k * k);
      }
    }
    return out;
  };
  const A = down(cv.a);
  const chans = [down(cv.r), down(cv.g), down(cv.b)];
  const known = new Uint8Array(cell * cell);
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const at = y * cell + x;
      const inner = y >= gutter && y < cell - gutter && x >= gutter && x < cell - gutter;
      for (const ch of chans) ch[at] = A[at] > 0 ? ch[at] / A[at] : 0;
      A[at] = inner ? (opaque ? 1 : clip(A[at], 0, 1)) : 0;
      known[at] = A[at] >= 0.5 ? 1 : 0;
    }
  }
  dilate(chans, known, cell);
  return [...chans, A];
}

/**
 * Paint the whole atlas. `res` overrides the resolution (cell, gutter, ss) for
 * a reduced-size comparison with foliage.py; the shipped atlas uses the
 * constants. Returns { size, r, g, b, a }: linear rgb and coverage, row 0 at the top.
 */
export function paintAtlas(res = { cell: CELL, gutter: GUTTER, ss: SS }) {
  const size = res.cell * 4;
  const atlas = { size, r: new Float64Array(size * size), g: new Float64Array(size * size), b: new Float64Array(size * size), a: new Float64Array(size * size) };
  CELLS.forEach(([name, paint], index) => {
    const cv = new Canvas(name, res);
    paint(cv, new Rand(nameSeed(name)));
    const [r, g, b, a] = finish(cv, name === OPAQUE);
    const ox = (index % 4) * res.cell;
    const oy = Math.floor(index / 4) * res.cell;
    for (let y = 0; y < res.cell; y++) {
      for (let x = 0; x < res.cell; x++) {
        const from = y * res.cell + x;
        const to = (oy + y) * size + ox + x;
        atlas.r[to] = r[from];
        atlas.g[to] = g[from];
        atlas.b[to] = b[from];
        atlas.a[to] = a[from];
      }
    }
  });
  return atlas;
}

/** The atlas as straight 8-bit RGBA, sRGB colour — what `save_webp` is handed, rounded as Blender rounds. */
export function atlasBytes(atlas) {
  const count = atlas.size * atlas.size;
  const out = new Uint8Array(count * 4);
  const byte = (v) => Math.round(clip(v, 0, 1) * 255);
  for (let i = 0; i < count; i++) {
    out[i * 4] = byte(toSrgb(atlas.r[i]));
    out[i * 4 + 1] = byte(toSrgb(atlas.g[i]));
    out[i * 4 + 2] = byte(toSrgb(atlas.b[i]));
    out[i * 4 + 3] = byte(atlas.a[i]);
  }
  return out;
}

/**
 * The preview sheet: the atlas over 30 % grey and over each planet's
 * `palette.ground`, then its alpha alone — a 4 × 2 grid, straight 8-bit RGBA.
 */
export function previewSheet(rgba, size) {
  const backs = [[0.3, 0.3, 0.3], ...Object.values(GROUNDS).map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255))];
  const width = size * 4;
  const out = new Uint8Array(width * size * 2 * 4);
  for (let tile = 0; tile < 8; tile++) {
    const ox = (tile % 4) * size;
    const oy = Math.floor(tile / 4) * size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const from = (y * size + x) * 4;
        const to = ((oy + y) * width + ox + x) * 4;
        const a = rgba[from + 3] / 255;
        for (let c = 0; c < 3; c++) {
          const v = tile < 7 ? (rgba[from + c] / 255) * a + backs[tile][c] * (1 - a) : a;
          out[to + c] = Math.round(clip(v, 0, 1) * 255);
        }
        out[to + 3] = 255;
      }
    }
  }
  return { width, height: size * 2, data: out };
}

/**
 * Build the atlas into `out` (public/assets): `only` narrows to ids (the one id
 * is 'atlas'; empty means everything), `preview` is a directory for
 * sheet_foliage.png or null, `codec` an open stand-in codec (webp.mjs's
 * `openCodec()`, left open). Logs the `ASSET` line foliage.py prints and
 * returns the paths written, relative to `out`.
 */
export async function build({ out, only = [], preview = null, codec }) {
  if (only.length > 0 && !only.includes('atlas')) return [];
  const atlas = paintAtlas();
  const rgba = atlasBytes(atlas);
  const bytes = await codec.encode(rgba, ATLAS_SIZE, ATLAS_SIZE, QUALITY);
  const path = join(out, ATLAS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`ASSET ${ATLAS_FILE} ${bytes.length} bytes`);
  if (preview) {
    const sheet = previewSheet(rgba, ATLAS_SIZE);
    const file = join(preview, 'sheet_foliage.png');
    mkdirSync(preview, { recursive: true });
    writeFileSync(file, encodePng(sheet.width, sheet.height, sheet.data));
    console.log(`PREVIEW ${file}`);
  }
  return [ATLAS_FILE];
}
