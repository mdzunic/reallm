// The stand-in build of SPEC-052's ground (scripts/assets/README.md §7): the
// four re-authored layers — `jungle_floor`, `grass`, `moss`, `chitin` — and
// `detail_nr`, written where Blender cannot run. It mirrors
// `scripts/assets/blender/ground.py` step for step:
//
//   * the fields: `Graph.torus` + `Graph.field` ported — 4D gradient (Perlin)
//     fBm in the manner of Blender's 4D Noise Texture (Scale, Detail,
//     Roughness, Lacunarity 2, Distortion, normalized to about [0, 1])
//     evaluated on the Clifford torus, so every field tiles exactly. It is not
//     Cycles bit for bit, and is not meant to be;
//   * the recipes: the same maths, and the same scatter — every leaf, twig and
//     pore is drawn from `tex.Rand(tex.name_seed(…))`, the stream `tex.mjs`
//     reproduces exactly — so both builds put the same things in the same
//     places, wrapped around the tile;
//   * `build_layer`: cavity from the periodic blur, albedo × cavity × height
//     shading, sRGB, OpenGL normals at the recipe's strength, roughness
//     clipped to 0.02..1, saved at ground.py's qualities.
//
// The other eight layers keep their committed Blender bakes; this never
// writes them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { encodePng } from '../icons.mjs';
import { Rand, blur, lattice, lin, nameSeed, normals, smoothstep as ss, toBytes, toSrgb } from './tex.mjs';

/** ground.py's constants (SPEC-052 §3.1). */
export const SIZE = 512;
export const DETAIL_SIZE = 256;
export const ALBEDO_QUALITY = 90;
/** snow, soil, moss, flesh */
export const SMOOTH_QUALITY = 92;
export const NR_QUALITY = 92;
export const SMOOTH = new Set(['snow', 'soil', 'moss', 'flesh']);

const TAU = 2 * Math.PI;

// ------------------------------------------------------------ 4D noise
// Blender's Noise Texture, 4D, type fBm, normalized: Jenkins lookup3 hashes,
// 32 gradients, the quintic fade, `perlin_signed = 0.8344 × perlin`.

const rot = (x, k) => (x << k) | (x >>> (32 - k));

function hash4(kx, ky, kz, kw) {
  let a = (0xdeadbeef + (4 << 2) + 13) | 0;
  let b = a;
  let c = a;
  c = (c + kw) | 0;
  b = (b + kz) | 0;
  a = (a + ky) | 0;
  a = (a - c) | 0; a ^= rot(c, 4); c = (c + b) | 0;
  b = (b - a) | 0; b ^= rot(a, 6); a = (a + c) | 0;
  c = (c - b) | 0; c ^= rot(b, 8); b = (b + a) | 0;
  a = (a - c) | 0; a ^= rot(c, 16); c = (c + b) | 0;
  b = (b - a) | 0; b ^= rot(a, 19); a = (a + c) | 0;
  c = (c - b) | 0; c ^= rot(b, 4); b = (b + a) | 0;
  a = (a + kx) | 0;
  return final3(a, b, c);
}

function final3(a, b, c) {
  c ^= b; c = (c - rot(b, 14)) | 0;
  a ^= c; a = (a - rot(c, 11)) | 0;
  b ^= a; b = (b - rot(a, 25)) | 0;
  c ^= b; c = (c - rot(b, 16)) | 0;
  a ^= c; a = (a - rot(c, 4)) | 0;
  b ^= a; b = (b - rot(a, 14)) | 0;
  c ^= b; c = (c - rot(b, 24)) | 0;
  return c >>> 0;
}

function hash2(kx, ky) {
  const a = (0xdeadbeef + (2 << 2) + 13) | 0;
  return final3((a + kx) | 0, (a + ky) | 0, a);
}

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
const floatBits = (x) => {
  F32[0] = x;
  return U32[0];
};

/** `random_float4_offset(seed)`: where the distortion samples its noise. */
function randomOffset4(seed) {
  return [0, 1, 2, 3].map((k) => 100 + (hash2(floatBits(seed), floatBits(k)) / 0xffffffff) * 100);
}
const DISTORT = [0, 1, 2, 3].map(randomOffset4);

function grad4(hash, x, y, z, w) {
  const h = hash & 31;
  const u = h < 24 ? x : y;
  const v = h < 16 ? y : z;
  const s = h < 8 ? z : w;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v) + (h & 4 ? -s : s);
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a, b, t) => (1 - t) * a + t * b;

/** Signed 4D Perlin noise in about [-1, 1] (`perlin_signed`). */
function snoise4(x, y, z, w) {
  const X = Math.floor(x);
  const Y = Math.floor(y);
  const Z = Math.floor(z);
  const W = Math.floor(w);
  const fx = x - X;
  const fy = y - Y;
  const fz = z - Z;
  const fw = w - W;
  const gx = fx - 1;
  const gy = fy - 1;
  const gz = fz - 1;
  const gw = fw - 1;
  const X1 = X + 1;
  const Y1 = Y + 1;
  const Z1 = Z + 1;
  const W1 = W + 1;
  const u = fade(fx);
  const v = fade(fy);
  const t = fade(fz);
  const s = fade(fw);
  const lo = mix(
    mix(mix(grad4(hash4(X, Y, Z, W), fx, fy, fz, fw), grad4(hash4(X1, Y, Z, W), gx, fy, fz, fw), u),
      mix(grad4(hash4(X, Y1, Z, W), fx, gy, fz, fw), grad4(hash4(X1, Y1, Z, W), gx, gy, fz, fw), u), v),
    mix(mix(grad4(hash4(X, Y, Z1, W), fx, fy, gz, fw), grad4(hash4(X1, Y, Z1, W), gx, fy, gz, fw), u),
      mix(grad4(hash4(X, Y1, Z1, W), fx, gy, gz, fw), grad4(hash4(X1, Y1, Z1, W), gx, gy, gz, fw), u), v),
    t,
  );
  const hi = mix(
    mix(mix(grad4(hash4(X, Y, Z, W1), fx, fy, fz, gw), grad4(hash4(X1, Y, Z, W1), gx, fy, fz, gw), u),
      mix(grad4(hash4(X, Y1, Z, W1), fx, gy, fz, gw), grad4(hash4(X1, Y1, Z, W1), gx, gy, fz, gw), u), v),
    mix(mix(grad4(hash4(X, Y, Z1, W1), fx, fy, gz, gw), grad4(hash4(X1, Y, Z1, W1), gx, fy, gz, gw), u),
      mix(grad4(hash4(X, Y1, Z1, W1), fx, gy, gz, gw), grad4(hash4(X1, Y1, Z1, W1), gx, gy, gz, gw), u), v),
    t,
  );
  return 0.8344 * mix(lo, hi, s);
}

/** Normalized fBm (`perlin_fbm(..., normalize=True)`), lacunarity 2. */
function fbm4(x, y, z, w, detail, rough) {
  let fscale = 1;
  let amp = 1;
  let maxamp = 0;
  let sum = 0;
  const octaves = Math.floor(detail);
  for (let i = 0; i <= octaves; i++) {
    sum += snoise4(fscale * x, fscale * y, fscale * z, fscale * w) * amp;
    maxamp += amp;
    amp *= rough;
    fscale *= 2;
  }
  const rmd = detail - octaves;
  if (rmd !== 0) {
    const sum2 = sum + snoise4(fscale * x, fscale * y, fscale * z, fscale * w) * amp;
    return mix((0.5 * sum) / maxamp + 0.5, (0.5 * sum2) / (maxamp + amp) + 0.5, rmd);
  }
  return (0.5 * sum) / maxamp + 0.5;
}

/**
 * One field on the Clifford torus (`Graph.torus` + `Graph.field`): texel
 * (x, y), row 0 at the top, sits at UV ((x + ½)/n, 1 − (y + ½)/n), mapped to
 * (cos 2πu, sin 2πu, cos 2πv, sin 2πv)/2π, offset by the seed, times Scale.
 */
function field(size, kind, scale, seed, { detail = 4, rough = 0.55, distortion = 0 } = {}) {
  if (kind !== 'fbm') throw new Error(`ground stand-in: no '${kind}' field (its recipes read fbm only)`);
  const out = new Float32Array(size * size);
  const r = 1 / TAU;
  const cu = new Float64Array(size);
  const su = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    cu[i] = Math.cos((TAU * (i + 0.5)) / size) * r;
    su[i] = Math.sin((TAU * (i + 0.5)) / size) * r;
  }
  for (let y = 0; y < size; y++) {
    const yv = size - 1 - y; // v = 1 − (y + ½)/n
    const pz = (cu[yv] + seed * 2.37) * scale;
    const pw = (su[yv] + seed * 1.37) * scale;
    for (let x = 0; x < size; x++) {
      let px = (cu[x] + seed * 3.13) * scale;
      let py = (su[x] + seed * 1.71) * scale;
      let qz = pz;
      let qw = pw;
      if (distortion !== 0) {
        const d = DISTORT;
        const dx = snoise4(px + d[0][0], py + d[0][1], qz + d[0][2], qw + d[0][3]) * distortion;
        const dy = snoise4(px + d[1][0], py + d[1][1], qz + d[1][2], qw + d[1][3]) * distortion;
        const dz = snoise4(px + d[2][0], py + d[2][1], qz + d[2][2], qw + d[2][3]) * distortion;
        const dw = snoise4(px + d[3][0], py + d[3][1], qz + d[3][2], qw + d[3][3]) * distortion;
        px += dx;
        py += dy;
        qz += dz;
        qw += dw;
      }
      out[y * size + x] = fbm4(px, py, qz, qw, detail, rough);
    }
  }
  return out;
}

/** `bake_fields(specs, size)`: [kind, scale, seed, kwargs] → one Float32Array each. */
function bakeFields(specs, size = SIZE) {
  return specs.map(([kind, scale, seed, kw]) => field(size, kind, scale, seed, kw));
}

// ------------------------------------------------------------- helpers
// numpy's idioms on Float32Arrays: a scalar field is n×n, a colour field
// n×n×3 (linear RGB), row 0 at the top.

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const wrap = (i, n) => ((i % n) + n) % n;

/** `ramp(t, stops)`: np.interp per channel between linear stop colours. */
function ramp(t, stops) {
  const pos = stops.map(([p]) => p);
  const cols = stops.map(([, hex]) => lin(hex));
  const last = pos.length - 1;
  const out = new Float32Array(t.length * 3);
  for (let i = 0; i < t.length; i++) {
    const x = clamp(t[i], 0, 1);
    let c0 = cols[0];
    let c1 = cols[0];
    let f = 0;
    if (x >= pos[last]) {
      c0 = c1 = cols[last];
    } else if (x > pos[0]) {
      let k = 0;
      while (x >= pos[k + 1]) k++;
      c0 = cols[k];
      c1 = cols[k + 1];
      f = (x - pos[k]) / (pos[k + 1] - pos[k]);
    }
    for (let ch = 0; ch < 3; ch++) out[i * 3 + ch] = c0[ch] + (c1[ch] - c0[ch]) * f;
  }
  return out;
}

/** `mixc(a, b, t)`: a, b colour fields or one [r, g, b]; t clipped to 0..1. */
function mixc(a, b, t) {
  const out = new Float32Array(t.length * 3);
  for (let i = 0; i < t.length; i++) {
    const f = clamp(t[i], 0, 1);
    for (let ch = 0; ch < 3; ch++) {
      const x = a.length === 3 ? a[ch] : a[i * 3 + ch];
      const y = b.length === 3 ? b[ch] : b[i * 3 + ch];
      out[i * 3 + ch] = x * (1 - f) + y * f;
    }
  }
  return out;
}

/** Scale every pixel of a colour field by a scalar field (`alb * k[..., None]`). */
function shadeBy(alb, k) {
  for (let i = 0; i < k.length; i++) for (let ch = 0; ch < 3; ch++) alb[i * 3 + ch] *= k[i];
  return alb;
}

/** A new scalar field from a per-pixel function of the given fields. */
function map(n, fn) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i);
  return out;
}

/** `sample(f, x, y)`: bilinear, wrapped around the tile; (x, y) in texels, row 0 at the top. */
function sample(f, n, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = wrap(x0, n);
  const ya = wrap(y0, n);
  const xb = (xa + 1) % n;
  const yb = (ya + 1) % n;
  return (f[ya * n + xa] * (1 - fx) + f[ya * n + xb] * fx) * (1 - fy) + (f[yb * n + xa] * (1 - fx) + f[yb * n + xb] * fx) * fy;
}

/**
 * Visit the texels within `reach` of (cx, cy) on an n×n tile, the window
 * wrapped around the tile, as `fn(index, dx, dy)` with (dx, dy) the texel's
 * offset from the centre — ground.py's `window()`.
 */
function stamp(n, cx, cy, reach, fn) {
  const y0 = Math.floor(cy - reach);
  const y1 = Math.ceil(cy + reach);
  const x0 = Math.floor(cx - reach);
  const x1 = Math.ceil(cx + reach);
  for (let y = y0; y <= y1; y++) {
    const row = wrap(y, n) * n;
    for (let x = x0; x <= x1; x++) fn(row + wrap(x, n), x - cx, y - cy);
  }
}

/** [mean, population standard deviation] — numpy's `mean()`, `std()`. */
function meanStd(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m += a[i];
  m /= a.length;
  let v = 0;
  for (let i = 0; i < a.length; i++) v += (a[i] - m) ** 2;
  return [m, Math.sqrt(v / a.length)];
}

// ------------------------------------------------------------- recipes
// Each takes its baked fields and returns [albedo (linear n×n×3), height,
// roughness (a field or a number), mask (or null), normal strength]. Field
// thresholds are taken in standard deviations of the field (`norm`), so the
// Cycles bake and this port, whose fBm differ in detail, cut the same share.

const N = SIZE * SIZE;

/** A field in standard deviations about its mean. */
function norm(f) {
  const [m, sd] = meanStd(f);
  return map(f.length, (i) => (f[i] - m) / sd);
}

/** Over-composite one colour onto `alb` at texel `i` with coverage `cov`. */
function over(alb, i, colour, k, cov) {
  for (let ch = 0; ch < 3; ch++) alb[i * 3 + ch] = alb[i * 3 + ch] * (1 - cov) + colour[ch] * k * cov;
}

const LITTER = 1150; // leaves and twigs on the jungle floor
const TWIG_SHARE = 0.06;

/**
 * A leaf: pointed at the tip, broadest toward the stalk, a lighter midrib,
 * darker toward its edges. It lies 0.1 above whatever it covers — hard-edged
 * in the height (the stack), antialiased in the colour.
 */
function leaf(r, alb, h, cover, hues) {
  const cx = r.uniform(0, SIZE);
  const cy = r.uniform(0, SIZE);
  const ang = r.uniform(0, TAU);
  const length = r.uniform(26, 56);
  const width = length * r.uniform(0.32, 0.48);
  const pick = r.random();
  const hue = hues[pick < 0.45 ? 0 : pick < 0.8 ? 1 : 2];
  const val = r.uniform(0.7, 1.12);
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const half = length / 2;
  stamp(SIZE, cx, cy, half + 1, (i, dx, dy) => {
    const a = dx * ca + dy * sa;
    const b = -dx * sa + dy * ca;
    const s = a / half;
    if (Math.abs(s) >= 1) return;
    const hw = (width / 2) * (1 - s * s) ** 0.7 * (1.1 - 0.3 * s);
    const cov = clamp(hw - Math.abs(b) + 0.5, 0, 1);
    if (cov <= 0) return;
    const across = Math.min(Math.abs(b) / Math.max(hw, 1e-3), 1);
    const rib = s < 0.8 ? clamp(1 - Math.abs(b) / 0.8, 0, 1) : 0;
    over(alb, i, hue, val * (1 - 0.3 * across * across) * (1 + 0.2 * rib) * (0.92 + 0.12 * s), cov);
    if (cov >= 0.5) {
      h[i] += 0.1;
      cover[i] = 1;
    }
  });
}

/** A twig: three bent segments, round in section. */
function twig(r, alb, h, cover, bark) {
  let x = r.uniform(0, SIZE);
  let y = r.uniform(0, SIZE);
  let ang = r.uniform(0, TAU);
  const seg = r.uniform(8, 20);
  const half = r.uniform(0.7, 1.2);
  const val = r.uniform(0.8, 1.2);
  const pts = [[x, y]];
  for (let k = 0; k < 3; k++) {
    ang += r.uniform(-0.35, 0.35);
    x += seg * Math.cos(ang);
    y += seg * Math.sin(ang);
    pts.push([x, y]);
  }
  const cx = (pts[0][0] + pts[3][0]) / 2;
  const cy = (pts[0][1] + pts[3][1]) / 2;
  const reach = Math.max(...pts.map(([px, py]) => Math.hypot(px - cx, py - cy))) + half + 1;
  stamp(SIZE, cx, cy, reach, (i, dx, dy) => {
    let d = Infinity;
    for (let k = 0; k < 3; k++) {
      const ax = pts[k][0] - cx;
      const ay = pts[k][1] - cy;
      const ex = pts[k + 1][0] - pts[k][0];
      const ey = pts[k + 1][1] - pts[k][1];
      const t = clamp(((dx - ax) * ex + (dy - ay) * ey) / (ex * ex + ey * ey), 0, 1);
      d = Math.min(d, Math.hypot(dx - ax - t * ex, dy - ay - t * ey));
    }
    const cov = clamp(half - d + 0.5, 0, 1);
    if (cov <= 0) return;
    const round = Math.sqrt(Math.max(0, 1 - (d / half) ** 2));
    over(alb, i, bark, val * (0.75 + 0.35 * round), cov);
    h[i] += cov * (0.1 + 0.06 * round);
    if (cov >= 0.5) cover[i] = 1;
  });
}

/** jungle_floor — leaf litter: leaves in three hues and twigs over dark fbm soil. */
function jungleFloor([soil, tone, grain]) {
  const alb = ramp(soil, [[0, '#1a120b'], [1, '#36261a']]);
  const h = new Float32Array(N);
  const cover = new Float32Array(N);
  const hues = [lin('#6f4526'), lin('#7d6436'), lin('#4f6034')];
  const bark = lin('#4f3f2e');
  const r = new Rand(nameSeed('ground/jungle_floor'));
  for (let k = 0; k < LITTER; k++) {
    if (r.random() < TWIG_SHARE) twig(r, alb, h, cover, bark);
    else leaf(r, alb, h, cover, hues);
  }
  shadeBy(alb, map(N, (i) => (0.86 + 0.28 * tone[i]) * (0.95 + 0.1 * grain[i])));
  const height = map(N, (i) => 0.06 + h[i]);
  const rough = map(N, (i) => 0.86 - 0.24 * cover[i]);
  return [alb, height, rough, null, 4.0];
}

const STREAK_TAPS = 12; // each side of the texel
const STREAK_STEP = 1.2; // texels between taps: ±14 texels, 8× the blade fbm's width

/** grass — blades: fbm smeared 8× along a drifting direction, clover patches. */
function grass([blade, drift, patch, tone]) {
  const zd = norm(drift);
  const streak = new Float32Array(N);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const th = 0.7 + 0.3 * zd[i];
      const ex = Math.cos(th) * STREAK_STEP;
      const ey = Math.sin(th) * STREAK_STEP;
      let sum = 0;
      let wsum = 0;
      for (let k = -STREAK_TAPS; k <= STREAK_TAPS; k++) {
        const w = 1 - Math.abs(k) / (STREAK_TAPS + 1);
        sum += w * sample(blade, SIZE, x + k * ex, y + k * ey);
        wsum += w;
      }
      streak[i] = sum / wsum;
    }
  }
  const z = norm(streak);
  // two tiers of blades: crisp in the height (two hard steps), softly
  // antialiased in the colour
  const lo = map(N, (i) => ss(0.15, 0.35, z[i]));
  const hi = map(N, (i) => ss(0.8, 1.0, z[i]));
  const zt = norm(tone);
  const dry = map(N, (i) => 0.55 * ss(0.8, 2.2, zt[i]) * lo[i]);
  let alb = ramp(map(N, (i) => 0.4 * (0.5 + 0.2 * z[i]) + 0.6 * (0.15 + 0.4 * lo[i] + 0.45 * hi[i])), [[0, '#1f3d17'], [0.5, '#3d7529'], [1, '#79ad4a']]);
  alb = mixc(alb, lin('#9c9550'), dry);
  const height = map(N, (i) => 0.25 + 0.25 * (z[i] > 0.25 ? 1 : 0) + 0.25 * (z[i] > 0.9 ? 1 : 0));
  const rough = new Float32Array(N).fill(0.74);
  // clover: trefoils scattered over the whole tile, kept where the patch field is high
  const zp = norm(patch);
  const clover = map(N, (i) => ss(0.95, 1.4, zp[i]));
  const leafCol = lin('#5f9a5c');
  const r = new Rand(nameSeed('ground/grass'));
  for (let k = 0; k < 5000; k++) {
    const cx = r.uniform(0, SIZE);
    const cy = r.uniform(0, SIZE);
    const ang = r.uniform(0, TAU);
    const rad = r.uniform(2.2, 3.4);
    const val = r.uniform(0.8, 1.15);
    if (clover[wrap(Math.floor(cy), SIZE) * SIZE + wrap(Math.floor(cx), SIZE)] < 0.5) continue;
    for (let j = 0; j < 3; j++) {
      const lx = cx + Math.cos(ang + (j * TAU) / 3) * rad * 0.95;
      const ly = cy + Math.sin(ang + (j * TAU) / 3) * rad * 0.95;
      stamp(SIZE, lx, ly, rad + 1, (i, dx, dy) => {
        const d = Math.hypot(dx, dy);
        const cov = clamp(rad - d + 0.5, 0, 1);
        if (cov <= 0) return;
        over(alb, i, leafCol, val * (1.08 - 0.3 * (d / rad) ** 2), cov);
        if (cov >= 0.5) {
          height[i] = 0.9;
          rough[i] = 0.6;
        }
      });
    }
  }
  return [alb, height, rough, null, 3.0];
}

/** moss — cushions: two layers of smoothed fbm thresholds, domed, dark crevices between. */
function moss([fa, fb, fibre, tone]) {
  // each layer's clumps are the smoothed threshold of its field; pressed
  // together the higher dome wins, so neighbours meet in a crease, and the
  // gaps where neither layer rises are the crevices
  const za = norm(fa);
  const zb = norm(fb);
  const dome = map(N, (i) => Math.max(ss(-0.9, 1.6, za[i]), ss(-0.9, 1.6, zb[i])));
  const height = map(N, (i) => 0.25 + 0.22 * dome[i]);
  const crevice = map(N, (i) => 1 - ss(0, 0.2, dome[i]));
  let alb = ramp(map(N, (i) => 0.15 + 0.75 * dome[i] + 0.3 * (fibre[i] - 0.5) + 0.3 * (tone[i] - 0.5)), [[0, '#263d1b'], [0.45, '#4b6e2e'], [0.8, '#6f9238'], [1, '#93ac4c']]);
  alb = mixc(alb, lin('#131d0c'), map(N, (i) => 0.6 * crevice[i]));
  return [alb, height, 0.86, null, 20.0];
}

/** Signed distance (texels) to a field's level `at` (its mean): + above. */
function stepDistance(f) {
  const [m, sd] = meanStd(f);
  const out = new Float32Array(N);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const gx = (f[y * SIZE + wrap(x + 1, SIZE)] - f[y * SIZE + wrap(x - 1, SIZE)]) * 0.5;
      const gy = (f[wrap(y + 1, SIZE) * SIZE + x] - f[wrap(y - 1, SIZE) * SIZE + x]) * 0.5;
      out[y * SIZE + x] = (f[y * SIZE + x] - m) / (Math.hypot(gx, gy) + 1e-3 * sd);
    }
  }
  return out;
}

const PLATE_STEPS = [0.26, 0.2, 0.14]; // the height each field's terrace step adds
const PORES = 360;

/** chitin — plates from smoothed fbm terracing: lit rims, shadowed steps, pores. */
function chitin([pa, pb, pc, grain, tone]) {
  // each field is terraced once, at its mean, into a smoothed step 2.4
  // texels wide; the plates are the regions the three steps cut the tile
  // into, each at its own height
  const sd = [pa, pb, pc].map(stepDistance);
  const height = map(N, (i) => 0.25 + PLATE_STEPS[0] * ss(-1.2, 1.2, sd[0][i]) + PLATE_STEPS[1] * ss(-1.2, 1.2, sd[1][i]) + PLATE_STEPS[2] * ss(-1.2, 1.2, sd[2][i]));
  const rim = new Float32Array(N); // the lit edge on the upper side of a step
  const shadow = new Float32Array(N); // the plate below it, in its shade
  const near = new Float32Array(N); // distance to the nearest step
  const tones = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => lattice(k, 5, 11));
  const plate = new Float32Array(N); // a tone per plate: which side of each step it lies on
  for (let i = 0; i < N; i++) {
    let id = 0;
    near[i] = Infinity;
    for (let k = 0; k < 3; k++) {
      const d = sd[k][i];
      if (d > 0) {
        rim[i] = Math.max(rim[i], 1 - ss(0.5, 4, d));
        id += 4 >> k;
      } else {
        shadow[i] = Math.max(shadow[i], 1 - ss(0, 5, -d));
      }
      near[i] = Math.min(near[i], Math.abs(d));
    }
    plate[i] = tones[id];
  }
  let alb = ramp(map(N, (i) => 0.08 + 0.4 * plate[i] + 0.4 * ss(0, 18, near[i]) + 0.2 * (tone[i] - 0.5) + 0.12 * (grain[i] - 0.5)), [[0, '#2e2140'], [0.5, '#4a3566'], [1, '#6d5090']]);
  alb = mixc(alb, lin('#8d73b6'), map(N, (i) => 0.5 * rim[i]));
  alb = mixc(alb, lin('#150c1e'), map(N, (i) => 0.85 * shadow[i]));
  const r = new Rand(nameSeed('ground/chitin'));
  for (let k = 0; k < PORES; k++) {
    const cx = r.uniform(0, SIZE);
    const cy = r.uniform(0, SIZE);
    const rad = r.uniform(1.0, 2.2);
    stamp(SIZE, cx, cy, rad + 1, (i, dx, dy) => {
      const cov = clamp(rad - Math.hypot(dx, dy) + 0.5, 0, 1);
      if (cov <= 0) return;
      for (let ch = 0; ch < 3; ch++) alb[i * 3 + ch] *= 1 - 0.75 * cov;
      if (cov >= 0.5) height[i] -= 0.06;
    });
  }
  const rough = map(N, (i) => (shadow[i] > 0.5 ? 0.55 : 0.3));
  return [alb, height, rough, null, 6.0];
}

const FBM = 'fbm';
/** ground.py's LAYERS rows for the four layers this stand-in builds. */
const LAYERS = {
  moss: [[[FBM, 14, 14, { detail: 1 }], [FBM, 14, 15, { detail: 1 }], [FBM, 96, 16, { detail: 1 }], [FBM, 3, 17, { detail: 2 }]], moss],
  jungle_floor: [[[FBM, 6, 18, { detail: 6 }], [FBM, 3, 19, { detail: 2 }], [FBM, 40, 20, { detail: 2 }]], jungleFloor],
  chitin: [[[FBM, 5, 24, { detail: 1, distortion: 0.3 }], [FBM, 6, 25, { detail: 1, distortion: 0.3 }], [FBM, 7, 26, { detail: 1, distortion: 0.3 }], [FBM, 48, 27, { detail: 2 }], [FBM, 3, 34, {}]], chitin],
  grass: [[[FBM, 72, 28, { detail: 1 }], [FBM, 2, 29, { detail: 2 }], [FBM, 6, 30, { detail: 3 }], [FBM, 3, 35, { detail: 3 }]], grass],
};

// ---------------------------------------------------------------- build

async function save(codec, out, rel, channels, size, quality) {
  const bytes = await codec.encode(toBytes(channels, size * size), size, size, quality);
  const path = join(out, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return bytes.length;
}

/** Split an n×n×3 field into three channel arrays. */
function planes(rgb, n) {
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) out[ch][i] = rgb[i * 3 + ch];
  return out;
}

/** `build_layer`: bake, recipe, cavity and height shading, pack and save. */
async function buildLayer(name, out, codec) {
  const [specs, recipe] = LAYERS[name];
  const [albedo, rawHeight, rawRough, mask, strength] = recipe(bakeFields(specs));
  const height = map(N, (i) => clamp(rawHeight[i], 0, 1));
  const rough = typeof rawRough === 'number' ? new Float32Array(N).fill(rawRough) : rawRough;
  const soft = blur(height, SIZE, SIZE, 3.0);
  const srgb = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const cavity = clamp((soft[i] - height[i]) * 4.0, 0, 1);
    const k = (1 - 0.35 * cavity) * (0.86 + 0.14 * height[i]);
    for (let ch = 0; ch < 3; ch++) srgb[i * 3 + ch] = toSrgb(albedo[i * 3 + ch] * k);
  }
  const alpha = mask === null ? height : map(N, (i) => clamp(mask[i], 0, 1));
  const normal = normals(height, SIZE, SIZE, strength).map((v) => v * 0.5 + 0.5);
  const base = `textures/ground/${name}`;
  const a = await save(codec, out, `${base}_albedo.webp`, [...planes(srgb, N), alpha], SIZE, SMOOTH.has(name) ? SMOOTH_QUALITY : ALBEDO_QUALITY);
  const b = await save(codec, out, `${base}_nr.webp`, [...planes(normal, N), map(N, (i) => clamp(rough[i], 0.02, 1))], SIZE, NR_QUALITY);
  console.log(`ASSET ${base}_albedo.webp ${a} bytes; ${name}_nr.webp ${b} bytes`);
  return { files: [`${base}_albedo.webp`, `${base}_nr.webp`], albedo: srgb, normal };
}

const PEBBLES = 30;

/**
 * detail_nr's height: fine grit — fbm bands at scales 24 and 64 — and a
 * sparse field of low pebbles. Returns [grit, height].
 */
function detailHeight([band24, band64]) {
  const n = DETAIL_SIZE * DETAIL_SIZE;
  const grit = map(n, (i) => 0.75 * band24[i] + 0.25 * band64[i]);
  const pebble = new Float32Array(n);
  const r = new Rand(nameSeed('ground/detail_nr'));
  for (let k = 0; k < PEBBLES; k++) {
    const cx = r.uniform(0, DETAIL_SIZE);
    const cy = r.uniform(0, DETAIL_SIZE);
    const rad = r.uniform(4.5, 8);
    const squash = r.uniform(0.6, 1.0);
    const ang = r.uniform(0, TAU);
    const tall = r.uniform(0.15, 0.25);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    stamp(DETAIL_SIZE, cx, cy, rad + 1, (i, dx, dy) => {
      const a = (dx * ca + dy * sa) / rad;
      const b = (-dx * sa + dy * ca) / (rad * squash);
      const q = 1 - (a * a + b * b);
      if (q > 0) pebble[i] = Math.max(pebble[i], tall * q * q);
    });
  }
  return [grit, map(n, (i) => 0.5 + 0.5 * (grit[i] - 0.5) + pebble[i])];
}

const DETAIL = [[FBM, 24, 41, { detail: 1 }], [FBM, 64, 42, { detail: 0 }]];

/** `build_detail`: a 256² OpenGL micro normal at strength 3, A = 0.5 + 0.25 × (grit − 0.5). */
async function buildDetail(out, codec) {
  const n = DETAIL_SIZE * DETAIL_SIZE;
  const [grit, height] = detailHeight(bakeFields(DETAIL, DETAIL_SIZE));
  const normal = normals(height, DETAIL_SIZE, DETAIL_SIZE, 3.0).map((v) => v * 0.5 + 0.5);
  const alpha = map(n, (i) => 0.5 + 0.25 * (grit[i] - 0.5));
  const rel = 'textures/ground/detail_nr.webp';
  const bytes = await save(codec, out, rel, [...planes(normal, n), alpha], DETAIL_SIZE, NR_QUALITY);
  console.log(`ASSET ${rel} ${bytes} bytes`);
  return { files: [rel], normal };
}

/** A preview tile: rolled by half (a broken seam would cross the middle), sampled down to `cell` px. */
function tile(rgb, size, cell) {
  const step = size / cell;
  const out = new Float32Array(cell * cell * 3);
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const sy = (y * step + size / 2) % size;
      const sx = (x * step + size / 2) % size;
      for (let ch = 0; ch < 3; ch++) out[(y * cell + x) * 3 + ch] = rgb[(sy * size + sx) * 3 + ch];
    }
  }
  return out;
}

/** The ids this stand-in builds: the four SPEC-052 layers and `detail_nr`. */
export const IDS = [...Object.keys(LAYERS), 'detail_nr'];

/**
 * Rebuild the SPEC-052 ground files under `out` (public/assets): each
 * selected layer's `_albedo` + `_nr` and `detail_nr.webp`. `only` narrows the
 * ids (empty: all of `IDS`); `preview` (a directory, or null) also gets
 * `sheet_ground.png`; `codec` is an open `openCodec()`, left open. Resolves to
 * the paths written, relative to `out`.
 */
export async function build({ out, only = [], preview = null, codec }) {
  const wanted = (id) => only.length === 0 || only.includes(id);
  const written = [];
  const tiles = [];
  const cell = SIZE / 2;
  for (const name of Object.keys(LAYERS)) {
    if (!wanted(name)) continue;
    const layer = await buildLayer(name, out, codec);
    written.push(...layer.files);
    tiles.push(tile(layer.albedo, SIZE, cell), tile(layer.normal, SIZE, cell));
  }
  if (wanted('detail_nr')) {
    const detail = await buildDetail(out, codec);
    written.push(...detail.files);
    tiles.push(tile(detail.normal, DETAIL_SIZE, cell));
  }
  if (preview && tiles.length > 0) {
    const cols = 6;
    const rows = Math.ceil(tiles.length / cols);
    const width = cols * cell;
    const rgba = new Uint8Array(rows * cell * width * 4);
    tiles.forEach((t, k) => {
      const r0 = Math.floor(k / cols) * cell;
      const c0 = (k % cols) * cell;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const at = ((r0 + y) * width + c0 + x) * 4;
          for (let ch = 0; ch < 3; ch++) rgba[at + ch] = Math.round(clamp(t[(y * cell + x) * 3 + ch], 0, 1) * 255);
          rgba[at + 3] = 255;
        }
      }
    });
    mkdirSync(preview, { recursive: true });
    const path = join(preview, 'sheet_ground.png');
    writeFileSync(path, encodePng(width, rows * cell, rgba));
    console.log(`PREVIEW ${path}`);
  }
  return written;
}
