// The stand-in build's texture helpers (scripts/assets/README.md §7): the
// portable half of `scripts/assets/blender/lib/tex.py` — the same seeds, the
// same mulberry32 stream and the same lattice noise, bit for bit — plus the
// numpy idioms the painters lean on (periodic blur, normals from height, sRGB
// encoding). Arrays are Float32Array, row-major, row 0 at the top.

const M32 = 0xffffffff;

/** FNV-1a over the UTF-8 bytes of `name` (`tex.name_seed`). */
export function nameSeed(name) {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(String(name), 'utf8')) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h;
}

/** mulberry32 (`tex.Rand`): `random()`, `uniform(lo, hi)`, `integers(lo, hi)`. */
export class Rand {
  constructor(seed) {
    this.a = seed >>> 0;
  }

  random() {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    const a = this.a;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
    t = (((t + (Math.imul(t ^ (t >>> 7), 61 | t) >>> 0)) >>> 0) ^ t) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(lo, hi) {
    return lo + (hi - lo) * this.random();
  }

  integers(lo, hi) {
    return lo + Math.min(Math.floor(this.random() * (hi - lo)), hi - lo - 1);
  }
}

/** lowbias32 (`tex.hash32`). */
export function hash32(x) {
  x = x >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** A float in [0, 1) per lattice point (`tex.lattice`). */
export function lattice(ix, iy, seed) {
  const h = hash32(((ix >>> 0) + hash32(((iy >>> 0) + hash32(seed >>> 0)) >>> 0)) >>> 0);
  return (h >>> 8) / 16777216;
}

/** Seamless value noise in [0, 1] (`tex.pnoise`). */
export function pnoise(size, cells, seed) {
  const out = new Float32Array(size * size);
  const i0 = new Int32Array(size);
  const i1 = new Int32Array(size);
  const f = new Float32Array(size);
  for (let k = 0; k < size; k++) {
    const t = Math.fround((k * cells) / size);
    const fl = Math.floor(t);
    let s = t - fl;
    s = s * s * s * (s * (s * 6 - 15) + 10);
    f[k] = s;
    i0[k] = ((fl % cells) + cells) % cells;
    i1[k] = (fl + 1) % cells;
  }
  for (let y = 0; y < size; y++) {
    const fy = f[y];
    for (let x = 0; x < size; x++) {
      const fx = f[x];
      const a = lattice(i0[x], i0[y], seed);
      const b = lattice(i1[x], i0[y], seed);
      const c = lattice(i0[x], i1[y], seed);
      const d = lattice(i1[x], i1[y], seed);
      out[y * size + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

/** `tex.pfbm`. */
export function pfbm(size, cells, octaves, seed, gain = 0.5) {
  const total = new Float32Array(size * size);
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = pnoise(size, cells * 2 ** o, seed + 101 * o);
    for (let i = 0; i < total.length; i++) total[i] += amp * n[i];
    norm += amp;
    amp *= gain;
  }
  for (let i = 0; i < total.length; i++) total[i] /= norm;
  return total;
}

/** `tex.smoothstep`, on one number. */
export function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * `tex.blur`'s periodic gaussian (sigma in pixels), as two wrapped 1D passes
 * instead of numpy's FFT — the same kernel on a torus.
 */
export function blur(a, width, height, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 4));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    kernel[k + radius] = Math.exp(-(k * k) / (2 * sigma * sigma));
    sum += kernel[k + radius];
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += kernel[k + radius] * a[y * width + ((((x + k) % width) + width) % width)];
      tmp[y * width + x] = s;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += kernel[k + radius] * tmp[((((y + k) % height) + height) % height) * width + x];
      out[y * width + x] = s;
    }
  }
  return out;
}

/** `tex.normals`: OpenGL tangent normals (+v up) from a periodic height, as [x, y, z] per pixel. */
export function normals(height, width, rows, strength) {
  const out = new Float32Array(width * rows * 3);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const at = (xx, yy) => height[((yy + rows) % rows) * width + ((xx + width) % width)];
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5;
      const dy = (at(x, y - 1) - at(x, y + 1)) * 0.5; // row 0 is the top: +v points up
      let nx = -dx * strength;
      let ny = -dy * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * width + x) * 3;
      out[i] = nx;
      out[i + 1] = ny;
      out[i + 2] = nz;
    }
  }
  return out;
}

/** `common._lin` on one channel. */
export function toLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** `common.encode_srgb` on one channel. */
export function toSrgb(c) {
  const a = Math.min(Math.max(c, 0), 1);
  return a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055;
}

/** '#rrggbb' (sRGB) → linear [r, g, b] (`common.lin`). */
export function lin(hex) {
  const v = hex.replace('#', '');
  return [0, 2, 4].map((i) => toLinear(parseInt(v.slice(i, i + 2), 16) / 255));
}

/** Float channels in 0..1 (already encoded) → straight 8-bit RGBA, rounding like Blender's byte images. */
export function toBytes(channels, count) {
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 4; k++) {
      const v = channels[k] === undefined ? 1 : channels[k][i];
      out[i * 4 + k] = Math.round(Math.min(Math.max(v, 0), 1) * 255);
    }
  }
  return out;
}
