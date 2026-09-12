// Pure lattice noise (SPEC-018 §3). Everything the surface environment draws —
// relief, ground textures, scatter jitter, storm flicker — samples these six
// functions, seeded through `hash32` labels, so a planet's look is as
// deterministic as its layout. No state, no allocation in the samplers that
// run per texel or per frame, and no `Math.random` anywhere (SPEC-008 §4.3).
//
// The lattice hash is FNV-free on purpose: it runs 512² × octaves times per
// texture build, so it is three `imul`s and the mulberry32 avalanche `hash32`
// already uses — identical across engines, cheap enough for a texel loop.

/** A uint32 for one lattice corner — the primitive everything below samples. */
export function latticeHash(seed: number, ix: number, iz: number): number {
  let h = (seed | 0) ^ Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return (h ^ (h >>> 14)) >>> 0;
}

/** [0, 1) from a seed and up to three integer labels (indices, cells, ticks). */
export function hash01(seed: number, a: number, b = 0, c = 0): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (a | 0), 0x85ebca6b);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ (c | 0), 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

/** The corner value in [−1, 1] the interpolators blend. */
function corner(seed: number, ix: number, iz: number): number {
  return (latticeHash(seed, ix, iz) / 4294967296) * 2 - 1;
}

/** Quintic fade — C² at the cell borders, so normals stay smooth. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Value noise in [−1, 1], quintic interpolation over the integer lattice. */
export function valueNoise2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const u = fade(x - ix);
  const v = fade(z - iz);
  const a = corner(seed, ix, iz);
  const b = corner(seed, ix + 1, iz);
  const c = corner(seed, ix, iz + 1);
  const d = corner(seed, ix + 1, iz + 1);
  const top = a + (b - a) * u;
  const bottom = c + (d - c) * u;
  return top + (bottom - top) * v;
}

/**
 * Fractional Brownian motion in [−1, 1]: octaves of value noise, each at
 * `lacunarity` times the frequency and `gain` times the amplitude of the last,
 * normalised by the total amplitude so the bound holds for any octave count.
 */
export function fbm2(seed: number, x: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let fx = x;
  let fz = z;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(seed + i, fx, fz) * amplitude;
    total += amplitude;
    amplitude *= gain;
    fx *= lacunarity;
    fz *= lacunarity;
  }
  return total > 0 ? sum / total : 0;
}

/**
 * Ridged multifractal in [0, 1]: `(1 − |noise|)²` per octave, so values crest
 * sharply along the noise zero-crossings — the shape of rock ridges.
 */
export function ridged2(seed: number, x: number, z: number, octaves = 3): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let fx = x;
  let fz = z;
  for (let i = 0; i < octaves; i++) {
    const r = 1 - Math.abs(valueNoise2(seed + i, fx, fz));
    sum += r * r * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    fx *= 2;
    fz *= 2;
  }
  return total > 0 ? sum / total : 0;
}

/**
 * Cellular noise over the 3 × 3 surrounding cells, one feature point per cell.
 * Writes into `out` — no allocation, it runs per texel: `dist` is the distance
 * to the nearest feature point, `edge` the margin to the second nearest (0 on
 * a cell border), `id` the winning cell's hash for per-cell colouring.
 */
export function voronoi2(seed: number, x: number, z: number, out: { dist: number; edge: number; id: number }): void {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  let d1 = Infinity;
  let d2 = Infinity;
  let id = 0;
  for (let cz = iz - 1; cz <= iz + 1; cz++) {
    for (let cx = ix - 1; cx <= ix + 1; cx++) {
      const h = latticeHash(seed, cx, cz);
      // Two halves of one hash: cheap, and still deterministic per cell.
      const px = cx + (h & 0xffff) / 0x10000;
      const pz = cz + (h >>> 16) / 0x10000;
      const dx = px - x;
      const dz = pz - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        id = h;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  out.dist = d1;
  out.edge = d2 - d1;
  out.id = id;
}
