// The stand-in build of SPEC-052's item pictures (scripts/assets/README.md §7):
// the seven subjects `scripts/assets/blender/items.py` appends to SUBJECTS for
// SPEC-056 — five relics, a road flare and an auto-injector — rendered where
// Blender cannot run, by three.js in Playwright's Chromium (WebGL, SwiftShader).
// It mirrors items.py step for step:
//
//   * the builders: `weapon()` and the seven new ones, part for part — the same
//     sizes, positions, rotations, colours, roughness, metal and emission —
//     over ports of lib/common.py's `box` (a one-segment bevel is a chamfer:
//     the hull of the 24 offset corners), `cyl` (bmesh `create_cone`: radius1
//     at −depth/2, the first vertex on +Y, bevelled rims), `sphere`, `torus`
//     and `place` (Blender's Euler 'XYZ' is three's 'ZYX'), flat-shaded and
//     drawn from both sides, as EEVEE draws bmesh faces;
//   * `fit_camera`: orthographic, at the framing's azimuth and elevation, the
//     ortho scale fitted to the parts' bounding-box corners over FILL;
//   * `rig()`: the three suns, the dim world, AgX, a transparent film;
//   * `with_backdrop` and `save_budgeted`, through webp.mjs's libwebp.
//
// Calibrated against the 26 committed EEVEE renders, which it re-renders
// to within a few 8-bit levels per part: EEVEE drew those with no cast
// shadows, so neither does this; it filters 4 × 4 supersamples with EEVEE's
// film filter; and it maps the radiance through Blender's AgX (below), not
// three's AgX, whose 16.5-stop polynomial lifts the darks by 10–30 levels.
//
// The other 26 pictures keep their committed Blender renders; this never
// rewrites them. It rewrites the manifest with every picture on disk, in
// SUBJECTS order, so after a full run it lists all 33.
//
// Deterministic: no randomness, no clock (PLAN R7).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { encodePng } from '../icons.mjs';

// ---------------------------------------------------------------- constants

/** items.py's constants. */
export const SIZE = 384;
export const FILL = 0.86;
export const MAX_BYTES = 36 * 1024;
/** `save_budgeted`: step the quality down until the file fits. */
export const QUALITIES = [82, 72, 60, 48, 36];

/** SPEC-035 §4.15 — the camera per item kind: [azimuth°, elevation°]. */
export const FRAMING = {
  weapon: [90.0, 8.0],
  other: [145.0, 12.0],
};

export const BACKDROP_COLOUR = '#9fb6d4';
export const BACKDROP_ALPHA = 0.18;

/** `rig()`: three suns ([energy, colour, rotation_euler°]) and the world. */
export const RIG = {
  world: '#1a222c',
  worldStrength: 0.5,
  suns: [
    { name: 'key', energy: 3.2, colour: '#fff0dc', rot: [55, 0, -30] },
    { name: 'rim', energy: 5.4, colour: '#9cc4ff', rot: [70, 0, 160] },
    { name: 'fill', energy: 0.9, colour: '#ffffff', rot: [80, 0, 70] },
  ],
};

/** Samples per axis per pixel. */
export const SUPERSAMPLE = 4;
/**
 * EEVEE's film filter: a Gaussian of σ = 0.284 × filter_size (1.5 px, the
 * default), over samples within filter_size of the pixel centre.
 */
export const FILM_FILTER = { size: 1.5, sigma: 0.284 * 1.5 };

/**
 * Blender's AgX view (Eary Chow's LUT, "AgX Base sRGB"): Rec.2020, the AgX
 * inset, a log2 encoding over 25 stops around middle grey, Troy Sobotka's
 * power sigmoid through a pivot, the outset, a 2.4 decode and the sRGB
 * encoding. The sigmoid's pivot, slope and powers were fitted to the 26
 * committed renders (RMSE per channel 10 against 17 for three's AgX, mostly
 * facet edges and WebP noise; part means within a few levels); exposure 1.
 */
export const AGX = { minEv: -12.47393, maxEv: 12.5260688, pivotX: 0.4, pivotY: 0.464, slope: 3.7, toe: 1.24, shoulder: 2.1, decode: 2.4 };

// The shared palette (items.py).
const GUNMETAL = '#3a4450';
const STEEL = '#6a7480';
const DARK = '#242b33';
const GRIP = '#2e2620';
const GREEN = '#46c973';

// SPEC-052 §4.8: the relic finish and the seven subjects' own colours.
const BRASS = '#b08d57';
const SERIAL = '#2a2118';
const FROST = '#bfe3f2';
const SLAG = '#6a4632';

/** The pictures items.py rendered before SPEC-052, in SUBJECTS order; never rewritten here. */
export const COMMITTED = [
  'pistol_service', 'pistol_magnum', 'weapon_kinetic', 'weapon_laser', 'weapon_plasma', 'weapon_lithium',
  'mg_scrap', 'mg_rotary', 'launcher_rocket', 'launcher_grenade', 'armor_scrap', 'armor_composite',
  'armor_reactive', 'armor_ablative', 'wheat_ration', 'medkit', 'coolant_pack', 'plasma_cell', 'frag_grenade',
  'landmine', 'demo_charge', 'scanner_drone', 'combat_drone', 'field_medic', 'quartermaster', 'aria',
];

// --------------------------------------------------------------- primitives
// A part is a primitive, the `place` transforms applied to it in order, and
// its material — built into geometry inside the page.

const box = (sx, sy, sz, bevel = 0) => ({ prim: 'box', args: [sx, sy, sz, bevel], transforms: [] });
const cyl = (r1, r2, depth, n = 10, caps = true, bevel = 0) => ({ prim: 'cyl', args: [r1, r2, depth, n, caps, bevel], transforms: [] });
const sphere = (radius, segs = 12, rings = 8) => ({ prim: 'sphere', args: [radius, segs, rings], transforms: [] });
const torus = (major, minor, n = 24, m = 8) => ({ prim: 'torus', args: [major, minor, n, m], transforms: [] });
const place = (part, loc = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) => ({ ...part, transforms: [...part.transforms, { loc, rot, scale }] });

/** items.py's `add`: one object, one `mat_flat`. */
function add(part, name, colour, rough = 0.55, metal = 0.6, emissive = null, strength = 0.0) {
  return { ...part, name, mat: { colour, rough, metal, emissive, strength } };
}

// ----------------------------------------------------------------- builders
// Blender's frame: metres-ish around the origin, +Y forward (the barrel), +Z up.

function weapon({
  body_len = 0.9, body_h = 0.16, barrel_len = 0.5, barrel_r = 0.035, grip_back = 0.25,
  magazine = true, drum = false, shroud = false, tube = false, sight = false, cell = null, stock = false, twin = false,
} = {}) {
  const parts = [];
  parts.push(add(place(box(0.09, body_len, body_h, 0.012), [0, 0, 0.1]), 'body', GUNMETAL));
  const barrels = !twin ? [[0.0, 0.1]] : [[-0.028, 0.1], [0.028, 0.1]];
  barrels.forEach(([bx, bz], i) => {
    parts.push(add(place(cyl(barrel_r, barrel_r, barrel_len, 12, true, 0.004), [bx, body_len / 2 + barrel_len / 2, bz], [90, 0, 0]), `barrel${i}`, STEEL));
  });
  parts.push(add(place(box(0.07, 0.09, 0.22, 0.01), [0, -body_len / 2 + grip_back, -0.06], [-18, 0, 0]), 'grip', GRIP, 0.8, 0.0));
  if (magazine) parts.push(add(place(box(0.06, 0.12, 0.2, 0.008), [0, 0.05, -0.08], [8, 0, 0]), 'magazine', DARK));
  if (drum) parts.push(add(place(cyl(0.12, 0.12, 0.1, 16, true, 0.008), [0, -0.05, -0.05], [0, 90, 0]), 'drum', DARK));
  if (shroud) parts.push(add(place(cyl(0.06, 0.06, barrel_len * 0.7, 10, false), [0, body_len / 2 + barrel_len * 0.3, 0.1], [90, 0, 0]), 'shroud', DARK, 0.7));
  if (tube) parts.push(add(place(cyl(0.075, 0.085, body_len * 1.1, 12, true, 0.006), [0, 0.1, 0.12], [90, 0, 0]), 'tube', GUNMETAL));
  if (sight) parts.push(add(place(box(0.03, 0.12, 0.07, 0.006), [0, 0.1, 0.22], [0, 0, 0]), 'sight', DARK));
  if (stock) parts.push(add(place(box(0.07, 0.24, 0.12, 0.01), [0, -body_len / 2 - 0.1, 0.06], [6, 0, 0]), 'stock', GRIP, 0.8, 0.0));
  if (cell !== null) parts.push(add(place(box(0.1, 0.16, 0.08, 0.008), [0, 0.12, 0.16], [0, 0, 0]), 'cell', cell, 0.3, 0.1, cell, 3.0));
  return parts;
}

// SPEC-052 §4.8 — the relic finish: brass furniture (the grip and the stock
// re-clad, a brass band at the muzzle), an engraved serial plate on the
// receiver and one emissive line in the twist colour, at items.py's
// LINE_STRENGTH.
const LINE_STRENGTH = 1.5;

const brass = (part, name) => add(part, name, BRASS, 0.35, 0.9);

function relic(parts, twist, { line, plate, muzzle, side = 0.045 }) {
  const out = parts.map((part) => (part.name === 'grip' || part.name === 'stock'
    ? { ...part, mat: { colour: BRASS, rough: 0.35, metal: 0.9, emissive: null, strength: 0.0 } }
    : part));
  const [py, pz] = plate;
  out.push(brass(place(box(0.008, 0.15, 0.05, 0.003), [side + 0.002, py, pz]), 'plate'));
  for (let i = 0; i < 4; i++) out.push(add(place(box(0.004, 0.016, 0.02), [side + 0.006, py - 0.045 + i * 0.03, pz]), `serial${i}`, SERIAL, 0.6, 0.3));
  const [y0, y1, lz] = line;
  out.push(add(place(box(0.006, y1 - y0, 0.026, 0.002), [side + 0.001, (y0 + y1) / 2, lz]), 'line', twist, 0.3, 0.1, twist, LINE_STRENGTH));
  const [radius, length, my, mz] = muzzle;
  out.push(brass(place(cyl(radius, radius, length, 16, true, 0.004), [0, my, mz], [90, 0, 0]), 'muzzle'));
  return out;
}

function relicLastWord() {
  const parts = weapon({ body_len: 0.56, barrel_len: 0.42, body_h: 0.14, magazine: false, sight: true });
  parts.push(brass(place(cyl(0.07, 0.07, 0.15, 12, true, 0.008), [0, 0.15, 0.085], [90, 0, 0]), 'cylinder'));
  return relic(parts, '#e5484d', { line: [-0.24, 0.06, 0.135], plate: [-0.1, 0.07], muzzle: [0.045, 0.04, 0.68, 0.1] });
}

function relicColdCoil() {
  const parts = weapon({ body_len: 1.0, barrel_len: 0.6, drum: true, magazine: false });
  for (let i = 0; i < 8; i++) parts.push(add(place(torus(0.068, 0.018, 16, 6), [0, 0.6 + i * 0.058, 0.1], [70, 0, 0]), `coil${i}`, FROST, 0.3, 0.5));
  return relic(parts, '#7fdcff', { line: [-0.42, 0.42, 0.145], plate: [-0.3, 0.07], muzzle: [0.046, 0.04, 1.08, 0.1] });
}

function relicSeedDrum() {
  const parts = weapon({ body_len: 0.7, barrel_len: 0.0, tube: true, sight: true, magazine: false });
  parts.push(add(place(cyl(0.17, 0.17, 0.13, 16, true, 0.012), [0, 0.1, -0.07], [0, 90, 0]), 'pod', DARK, 0.5));
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    parts.push(add(place(cyl(0.034, 0.034, 0.15, 10), [0, 0.1 + Math.cos(angle) * 0.105, -0.07 + Math.sin(angle) * 0.105], [0, 90, 0]),
      `seed${i}`, '#8fe06a', 0.3, 0.1, '#8fe06a', 1.5));
  }
  parts.push(brass(place(cyl(0.045, 0.045, 0.16, 12, true, 0.006), [0, 0.1, -0.07], [0, 90, 0]), 'hub'));
  return relic(parts, '#8fe06a', { line: [-0.2, 0.4, 0.145], plate: [-0.18, 0.095], muzzle: [0.092, 0.05, 0.46, 0.12], side: 0.086 });
}

function relicSlagVent() {
  const parts = weapon({ body_len: 1.0, barrel_len: 0.6, drum: true, shroud: true, magazine: false, twin: true, stock: true });
  for (let i = 0; i < 6; i++) parts.push(add(place(box(0.17, 0.03, 0.3, 0.004), [0, 0.53 + i * 0.065, 0.1]), `fin${i}`, SLAG, 0.45, 0.6));
  return relic(parts, '#ff6a2a', { line: [-0.42, 0.42, 0.145], plate: [-0.3, 0.07], muzzle: [0.07, 0.04, 1.08, 0.1] });
}

function relicSeeker() {
  const parts = weapon({ body_len: 0.8, barrel_len: 0.0, tube: true, sight: true, magazine: false });
  parts.push(add(place(sphere(0.082, 16, 12), [0, 0.54, 0.12], [0, 0, 0], [1, 1.45, 1]), 'dome', '#6b4e94', 0.15, 0.3));
  parts.push(brass(place(cyl(0.091, 0.091, 0.05, 16, true, 0.004), [0, -0.3, 0.12], [90, 0, 0]), 'band'));
  return relic(parts, '#b07ad8', { line: [-0.24, 0.44, 0.145], plate: [-0.12, 0.095], muzzle: [0.09, 0.05, 0.52, 0.12], side: 0.086 });
}

// SPEC-052 §4.8 — the two consumables: built along +Z, then tilted as a whole.
const FLARE_TILT = [45, 0, -135];
const STIM_TILT = [60, 0, 65];

const tilted = (part, loc, tilt) => place(place(part, loc), [0, 0, 0], tilt);

function flare() {
  const t = FLARE_TILT;
  return [
    add(tilted(cyl(0.045, 0.045, 0.6, 16, true, 0.006), [0, 0, 0.3], t), 'tube', '#c4352b', 0.75, 0.0),
    add(tilted(cyl(0.0465, 0.0465, 0.05, 16), [0, 0, 0.42], t), 'label', '#e6dfcc', 0.8, 0.0),
    add(tilted(cyl(0.053, 0.053, 0.13, 16, true, 0.008), [0, 0, -0.02], t), 'cap', DARK, 0.6, 0.1),
    add(tilted(cyl(0.04, 0.04, 0.012, 16), [0, 0, -0.088], t), 'striker', '#8c8273', 0.9, 0.0),
    add(tilted(cyl(0.044, 0.014, 0.11, 12), [0, 0, 0.655], t), 'tip', '#ff5a3c', 0.3, 0.0, '#ff5a3c', 2.5),
  ];
}

function stim() {
  const t = STIM_TILT;
  return [
    add(tilted(cyl(0.065, 0.065, 0.46, 16, true, 0.01), [0, 0, 0.23], t), 'body', '#8d969f', 0.45, 0.1),
    add(tilted(cyl(0.0665, 0.0665, 0.05, 16), [0, 0, 0.37], t), 'band', GREEN, 0.3, 0.1, GREEN, 1.6),
    add(tilted(box(0.03, 0.05, 0.17, 0.008), [0.052, 0, 0.19], t), 'window', '#d4eef2', 0.08, 0.0),
    add(tilted(box(0.032, 0.03, 0.11, 0.006), [0.054, 0, 0.19], t), 'dose', GREEN, 0.2, 0.0),
    add(tilted(cyl(0.05, 0.04, 0.07, 16, true, 0.006), [0, 0, -0.035], t), 'tip', DARK, 0.5, 0.2),
    add(tilted(cyl(0.06, 0.055, 0.05, 16, true, 0.006), [0, 0, 0.485], t), 'cap', GUNMETAL, 0.45, 0.6),
  ];
}

/** items.py's SUBJECTS after `aria`, in order: id → [framing, builder]. */
export const SUBJECTS = {
  relic_last_word: ['weapon', relicLastWord],
  relic_cold_coil: ['weapon', relicColdCoil],
  relic_seed_drum: ['weapon', relicSeedDrum],
  relic_slag_vent: ['weapon', relicSlagVent],
  relic_seeker: ['weapon', relicSeeker],
  flare: ['other', flare],
  stim: ['other', stim],
};

/** Every id items.py's SUBJECTS lists, in order — what a full manifest holds. */
export const ALL_IDS = [...COMMITTED, ...Object.keys(SUBJECTS)];

// ------------------------------------------------------------------- render

/** Routed inside the browser, never fetched. */
const ORIGIN = 'https://reallm-items.invalid';
const THREE_DIR = join(import.meta.dirname, '..', '..', '..', 'node_modules', 'three');

/** A page in the codec's browser that serves three from node_modules. */
async function openStage(codec) {
  const context = await codec.page.context().browser().newContext();
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') {
      const imports = { three: '/three/build/three.module.js', 'three/addons/': '/three/examples/jsm/' };
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><script type="importmap">${JSON.stringify({ imports })}</script><title>items</title>` });
    }
    if (path.startsWith('/three/')) {
      const file = join(THREE_DIR, path.slice('/three/'.length));
      return existsSync(file) ? route.fulfill({ contentType: 'text/javascript', body: readFileSync(file) }) : route.fulfill({ status: 404 });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${ORIGIN}/`);
  return { page, close: () => context.close() };
}

/**
 * Runs inside the page: builds the parts, fits the camera, renders linear
 * radiance (premultiplied by coverage) at SUPERSAMPLE × the size into a float
 * target, and resolves it through the film filter. Resolves to base64 Float32
 * RGBA, row 0 at the top.
 */
async function renderInPage(spec) {
  const THREE = await import('three');
  const { ConvexGeometry } = await import('three/addons/geometries/ConvexGeometry.js');
  const rad = Math.PI / 180;

  /** Rings of `profile` [r, z] revolved n times; every triangle faces away from `centreOf`. */
  function revolve(profile, n, conv, capFirst, capLast, centreOf = () => [0, 0, 0]) {
    const pos = [];
    // create_cone's vertices sit at (sin φ, cos φ) from +Y; lathe's at (cos a, sin a) from +X.
    const ang = (k) => {
      const a = (2 * Math.PI * k) / n;
      return conv === 'cone' ? [Math.sin(a), Math.cos(a)] : [Math.cos(a), Math.sin(a)];
    };
    const tri = (a, b, c) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * nx + ny * ny + nz * nz < 1e-24) return;
      const m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      const o = centreOf(m);
      if (nx * (m[0] - o[0]) + ny * (m[1] - o[1]) + nz * (m[2] - o[2]) < 0) pos.push(...a, ...c, ...b);
      else pos.push(...a, ...b, ...c);
    };
    const last = profile.length - 1;
    for (let k = 0; k < n; k++) {
      const [c0, s0] = ang(k);
      const [c1, s1] = ang(k + 1);
      for (let j = 0; j < last; j++) {
        const [ra, za] = profile[j];
        const [rb, zb] = profile[j + 1];
        const a = [ra * c0, ra * s0, za], b = [ra * c1, ra * s1, za], c = [rb * c1, rb * s1, zb], d = [rb * c0, rb * s0, zb];
        tri(a, b, c);
        tri(a, c, d);
      }
      if (capFirst && profile[0][0] > 1e-9) {
        const [r, z] = profile[0];
        tri([0, 0, z], [r * c1, r * s1, z], [r * c0, r * s0, z]);
      }
      if (capLast && profile[last][0] > 1e-9) {
        const [r, z] = profile[last];
        tri([0, 0, z], [r * c0, r * s0, z], [r * c1, r * s1, z]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }

  function geometry(part) {
    let g;
    if (part.prim === 'box') {
      // create_cube scaled, every edge bevelled once at `bevel`: the hull of
      // each corner's three offset points.
      const [sx, sy, sz, bevel] = part.args;
      const X = sx / 2, Y = sy / 2, Z = sz / 2;
      const b = Math.min(bevel, X * 0.999, Y * 0.999, Z * 0.999);
      const pts = [];
      for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) {
        if (b > 0) {
          pts.push(new THREE.Vector3(i * X, j * (Y - b), k * (Z - b)));
          pts.push(new THREE.Vector3(i * (X - b), j * Y, k * (Z - b)));
          pts.push(new THREE.Vector3(i * (X - b), j * (Y - b), k * Z));
        } else pts.push(new THREE.Vector3(i * X, j * Y, k * Z));
      }
      g = new ConvexGeometry(pts);
    } else if (part.prim === 'cyl') {
      // A bevelled rim offsets the cap inward (b / cos(π/n) at a vertex) and
      // slides the side down its edge until it is b from the rim; the sides
      // stay sharp (their angle is under common.cyl's 0.9 rad for n > 6).
      const [r1, r2, depth, n, caps, bevel] = part.args;
      const h = depth / 2;
      let profile = [[r1, -h], [r2, h]];
      if (bevel > 0 && caps && depth > 0) {
        const k = 1 / Math.cos(Math.PI / n);
        const L = Math.hypot(r2 - r1, depth);
        const t = bevel / Math.sqrt(1 - (((r2 - r1) * Math.sin(Math.PI / n)) / L) ** 2);
        const dr = (r2 - r1) / L, dz = depth / L;
        profile = [[r1 - bevel * k, -h], [r1 + dr * t, -h + dz * t], [r2 - dr * t, h - dz * t], [r2 - bevel * k, h]];
      }
      g = revolve(profile, n, 'cone', caps, caps);
    } else if (part.prim === 'sphere') {
      const [r, segs, rings] = part.args;
      const profile = [];
      for (let a = 0; a <= rings; a++) profile.push([r * Math.sin((Math.PI * a) / rings), r * Math.cos((Math.PI * a) / rings)]);
      g = revolve(profile, segs, 'cone', false, false);
    } else if (part.prim === 'torus') {
      const [major, minor, n, m] = part.args;
      const profile = [];
      for (let k = 0; k <= m; k++) profile.push([major + minor * Math.cos((2 * Math.PI * k) / m), minor * Math.sin((2 * Math.PI * k) / m)]);
      g = revolve(profile, n, 'lathe', false, false, ([x, y]) => {
        const r = Math.hypot(x, y) || 1;
        return [(major * x) / r, (major * y) / r, 0];
      });
    } else throw new Error(`unknown primitive ${part.prim}`);
    for (const t of part.transforms) {
      const euler = new THREE.Euler(t.rot[0] * rad, t.rot[1] * rad, t.rot[2] * rad, 'ZYX');
      g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...t.loc), new THREE.Quaternion().setFromEuler(euler), new THREE.Vector3(...t.scale)));
    }
    if (g.index) g = g.toNonIndexed();
    g.deleteAttribute('uv');
    g.computeVertexNormals();
    g.computeBoundingBox();
    return g;
  }

  const { size, supersample: ss, fill, rig } = spec;
  const W = size * ss;
  if (!window.stage) {
    window.stage = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: false, alpha: true });
  }
  const renderer = window.stage;
  const scene = new THREE.Scene();
  const meshes = spec.parts.map((part) => {
    const m = part.mat;
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(m.colour), roughness: m.rough, metalness: m.metal, flatShading: true, side: THREE.DoubleSide,
      emissive: new THREE.Color(m.emissive ?? '#000000'), emissiveIntensity: m.emissive ? m.strength : 0,
    });
    const mesh = new THREE.Mesh(geometry(part), material);
    scene.add(mesh);
    return mesh;
  });

  // fit_camera: the union of the parts' boxes centres the view; their corners
  // in camera space set the ortho scale.
  const [azimuth, elevation] = spec.framing;
  const az = azimuth * rad, el = elevation * rad;
  const direction = new THREE.Vector3(Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el));
  const lo = new THREE.Vector3(1e9, 1e9, 1e9), hi = new THREE.Vector3(-1e9, -1e9, -1e9);
  const corners = [];
  for (const mesh of meshes) {
    const bb = mesh.geometry.boundingBox;
    for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
      const corner = new THREE.Vector3(x, y, z);
      corners.push(corner);
      lo.min(corner);
      hi.max(corner);
    }
  }
  const centre = lo.clone().add(hi).multiplyScalar(0.5);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.up.set(0, 0, 1); // to_track_quat('-Z', 'Y') in a Z-up world
  camera.position.copy(centre).addScaledVector(direction, 6.0);
  camera.lookAt(centre);
  camera.updateMatrixWorld(true);
  let span = 0;
  for (const corner of corners) {
    const local = corner.clone().applyMatrix4(camera.matrixWorldInverse);
    span = Math.max(span, Math.abs(local.x) * 2, Math.abs(local.y) * 2);
  }
  const ortho = Math.max(span, 1e-3) / fill;
  Object.assign(camera, { left: -ortho / 2, right: ortho / 2, top: ortho / 2, bottom: -ortho / 2 });
  camera.updateProjectionMatrix();

  // rig(): a sun shines down its local −Z, turned by its rotation_euler; its
  // strength is irradiance, as a DirectionalLight's intensity is.
  for (const sun of rig.suns) {
    const light = new THREE.DirectionalLight(new THREE.Color(sun.colour), sun.energy);
    const travel = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(sun.rot[0] * rad, sun.rot[1] * rad, sun.rot[2] * rad, 'ZYX'));
    light.position.copy(centre).addScaledVector(travel, -10);
    light.target.position.copy(centre);
    scene.add(light, light.target);
  }
  // The world: a uniform environment, lighting diffuse and specular alike.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const sky = new THREE.Scene();
  sky.background = new THREE.Color(rig.world);
  const environment = pmrem.fromScene(sky, 0);
  scene.environment = environment.texture;
  scene.environmentIntensity = rig.worldStrength;

  const target = new THREE.WebGLRenderTarget(W, W, { type: THREE.FloatType, depthBuffer: true });
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, camera);
  const raw = new Float32Array(W * W * 4);
  renderer.readRenderTargetPixels(target, 0, 0, W, W, raw);
  renderer.setRenderTarget(null);
  target.dispose();
  environment.dispose();
  pmrem.dispose();
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }

  // The film filter, separable: per output pixel, the normalised Gaussian
  // weights of the supersamples within `filter.size` of its centre.
  const { size: reach, sigma } = spec.filter;
  const taps = [];
  for (let i = 0; i < size; i++) {
    const c = i + 0.5;
    const list = [];
    let sum = 0;
    for (let s = Math.max(0, Math.floor((c - reach) * ss)); s <= Math.min(W - 1, Math.ceil((c + reach) * ss)); s++) {
      const d = (s + 0.5) / ss - c;
      if (Math.abs(d) > reach) continue;
      const w = Math.exp((-0.5 * d * d) / (sigma * sigma));
      list.push([s, w]);
      sum += w;
    }
    taps.push(list.map(([s, w]) => [s, w / sum]));
  }
  const rows = new Float32Array(W * size * 4);
  for (let y = 0; y < W; y++) {
    const src = (W - 1 - y) * W * 4; // GL's row 0 is the bottom
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [s, w] of taps[i]) {
        const at = src + s * 4;
        r += w * raw[at]; g += w * raw[at + 1]; b += w * raw[at + 2]; a += w * raw[at + 3];
      }
      const o = (y * size + i) * 4;
      rows[o] = r; rows[o + 1] = g; rows[o + 2] = b; rows[o + 3] = a;
    }
  }
  const out = new Float32Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [s, w] of taps[j]) {
        const at = (s * size + x) * 4;
        r += w * rows[at]; g += w * rows[at + 1]; b += w * rows[at + 2]; a += w * rows[at + 3];
      }
      const o = (j * size + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  const bytes = new Uint8Array(out.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** One subject's premultiplied linear RGBA, SIZE², row 0 at the top. */
async function renderLinear(stage, parts, kind) {
  const spec = { parts, framing: FRAMING[kind], size: SIZE, supersample: SUPERSAMPLE, fill: FILL, rig: RIG, filter: FILM_FILTER };
  const b64 = await stage.page.evaluate(renderInPage, spec);
  const bytes = Buffer.from(b64, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

// ---------------------------------------------------------- view transform

// GLSL-style column matrices (each row below is a column): M·v = Σ c_k v_k.
const SRGB_TO_REC2020 = [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]];
const REC2020_TO_SRGB = [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]];
const AGX_INSET = [
  [0.856627153315983, 0.137318972929847, 0.11189821299995],
  [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
  [0.0482516061458583, 0.101439036467562, 0.811302368396859],
];
const AGX_OUTSET = [
  [1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
  [-0.11060664309660323, 1.157823702216272, -0.11060664309660294],
  [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405],
];
const mul = (cols, v) => [0, 1, 2].map((i) => cols[0][i] * v[0] + cols[1][i] * v[1] + cols[2][i] * v[2]);

/** Troy Sobotka's sigmoid: through (pivotX, pivotY) at `slope`, reaching (0, 0) and (1, 1) with the toe and shoulder powers. */
function sigmoid(x, { pivotX: xp, pivotY: yp, slope: m, toe, shoulder }) {
  const hyperbolic = (t, p) => t / (1 + t ** p) ** (1 / p);
  if (x >= xp) {
    const scale = m * (1 - xp) * (((m * (1 - xp)) / (1 - yp)) ** shoulder - 1) ** (-1 / shoulder);
    return yp + scale * hyperbolic((m * (x - xp)) / scale, shoulder);
  }
  const scale = m * xp * (((m * xp) / yp) ** toe - 1) ** (-1 / toe);
  return yp - scale * hyperbolic((m * (xp - x)) / scale, toe);
}

/** Scene-linear sRGB → display sRGB in 0..1, through `AGX`. */
export function agx(rgb, view = AGX) {
  let c = mul(AGX_INSET, mul(SRGB_TO_REC2020, rgb));
  c = c.map((v) => Math.min(Math.max((Math.log2(Math.max(v, 1e-10)) - view.minEv) / (view.maxEv - view.minEv), 0), 1));
  c = mul(AGX_OUTSET, c.map((v) => sigmoid(v, view)));
  c = mul(REC2020_TO_SRGB, c.map((v) => Math.max(0, v) ** view.decode));
  return c.map((v) => {
    const l = Math.min(Math.max(v, 0), 1);
    return l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  });
}

const byte = (v) => Math.round(Math.min(Math.max(v, 0), 1) * 255);

/**
 * The film as `render_png` reads it back: the colour un-premultiplied and
 * view-transformed, straight alpha, both through the 8-bit PNG.
 */
function filmPixels(linear) {
  const out = new Float32Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = linear[i * 4 + 3];
    if (a <= 1e-6) continue;
    const c = agx([linear[i * 4] / a, linear[i * 4 + 1] / a, linear[i * 4 + 2] / a]);
    for (let k = 0; k < 3; k++) out[i * 4 + k] = byte(c[k]) / 255;
    out[i * 4 + 3] = byte(a) / 255;
  }
  return out;
}

function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * `with_backdrop`: the faint radial halo under the subject — BACKDROP_ALPHA
 * in the middle (`tex.radial`'s distance), nothing past smoothstep(0.1, 1).
 * Resolves to straight 8-bit RGBA, as `save_webp` stores it.
 */
function withBackdrop(rgba) {
  const back = [1, 3, 5].map((i) => Number.parseInt(BACKDROP_COLOUR.slice(i, i + 2), 16) / 255);
  const out = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const u = ((x + 0.5) / SIZE - 0.5) * 2;
      const v = ((y + 0.5) / SIZE - 0.5) * 2;
      const bgA = (1 - smoothstep(0.1, 1.0, Math.sqrt(u * u + v * v))) * BACKDROP_ALPHA;
      const fgA = rgba[i + 3];
      const outA = fgA + bgA * (1 - fgA);
      const safe = Math.max(outA, 1e-5);
      for (let k = 0; k < 3; k++) out[i + k] = byte((rgba[i + k] * fgA + back[k] * bgA * (1 - fgA)) / safe);
      out[i + 3] = byte(outA);
      // libwebp's lossy encoder, as Blender calls it (`exact` off), flattens
      // the colour under fully transparent pixels; Chromium's opaque colour
      // pass cannot, so the corners take the halo's colour here instead of
      // black — invisible, and no hard circle for VP8 to spend bytes on.
      if (out[i + 3] === 0) for (let k = 0; k < 3; k++) out[i + k] = byte(back[k]);
    }
  }
  return out;
}

/** `save_budgeted`: WebP under MAX_BYTES, stepping the quality down. */
async function saveBudgeted(codec, path, rgba) {
  let bytes;
  let quality;
  for (quality of QUALITIES) {
    bytes = await codec.encode(rgba, SIZE, SIZE, quality);
    if (bytes.length <= MAX_BYTES) break;
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
  return { bytes: bytes.length, quality };
}

/** items.py's manifest: `json.dump({'items': ids}, fh)` and a newline, byte for byte. */
export function manifestText(ids) {
  return `{"items": [${ids.map((id) => JSON.stringify(id)).join(', ')}]}\n`;
}

/** The contact sheet, on the navy the tiles are seen against (items.py's `--preview`). */
function writeSheet(path, tiles) {
  const cols = 6;
  const rows = Math.ceil(tiles.length / cols);
  const width = cols * SIZE;
  const navy = [0x10, 0x17, 0x20];
  const rgba = new Uint8Array(rows * SIZE * width * 4);
  for (let p = 0; p < rgba.length; p += 4) {
    rgba.set(navy, p);
    rgba[p + 3] = 255;
  }
  tiles.forEach((tile, k) => {
    const r0 = Math.floor(k / cols) * SIZE;
    const c0 = (k % cols) * SIZE;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = (y * SIZE + x) * 4;
        const at = ((r0 + y) * width + c0 + x) * 4;
        const a = tile[i + 3] / 255;
        for (let ch = 0; ch < 3; ch++) rgba[at + ch] = Math.round(tile[i + ch] * a + navy[ch] * (1 - a));
      }
    }
  });
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, encodePng(width, rows * SIZE, rgba));
}

// --------------------------------------------------------------------- main

/**
 * Renders the seven SPEC-052 pictures `only` names (all of them when it is
 * empty; ids of other generators are ignored) into `<out>/items/`, rewrites
 * the manifest from the pictures on disk, and resolves to the paths written,
 * relative to `out`. `codec` is webp.mjs's, already open; it stays open.
 */
export async function build({ out, only = [], preview = null, codec }) {
  const wanted = (id) => only.length === 0 || only.includes(id);
  const ids = Object.keys(SUBJECTS).filter(wanted);
  if (ids.length === 0) return [];
  const stage = await openStage(codec);
  const written = [];
  const tiles = [];
  try {
    for (const id of ids) {
      const [kind, builder] = SUBJECTS[id];
      const rgba = withBackdrop(filmPixels(await renderLinear(stage, builder(), kind)));
      const rel = `items/${id}.webp`;
      const { bytes, quality } = await saveBudgeted(codec, join(out, rel), rgba);
      console.log(`ASSET ${rel} ${bytes} bytes`);
      if (quality !== QUALITIES[0]) console.log(`NOTE ${rel} saved at quality ${quality} to fit ${MAX_BYTES} bytes`);
      written.push(rel);
      tiles.push(rgba);
    }
  } finally {
    await stage.close();
  }
  // §4.13: the manifest names the pictures that exist, in SUBJECTS order.
  const present = ALL_IDS.filter((id) => existsSync(join(out, 'items', `${id}.webp`)));
  writeFileSync(join(out, 'items', 'manifest.json'), manifestText(present));
  console.log('ASSET items/manifest.json');
  written.push('items/manifest.json');
  if (preview) {
    const path = join(preview, 'sheet_items.png');
    writeSheet(path, tiles);
    console.log(`PREVIEW ${path}`);
  }
  return written;
}
