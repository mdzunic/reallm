// SPEC-018 AC (procedural textures): every layer builds as the two packed
// DataTextures, deterministically, with unit normals and the session cache —
// all inspectable in node because nothing touches a canvas.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GROUND_LAYER_IDS } from '@/data/ids';
import { PLANET_IDS, PLANETS } from '@/data/index';
import { buildGroundLayer, decalAtlas, groundLayer, particleSprite, planetDisc, prewarm } from '@/views/ProceduralTextures';

const SIZE = 64; // small grids keep the suite fast; the shape rules are size-free

function bytes(texture: THREE.DataTexture): Uint8Array {
  return texture.image.data as unknown as Uint8Array;
}

describe('groundLayer (SPEC-018 §4.5)', () => {
  it('builds every GroundLayerId as albedo+height (sRGB) and normal+roughness (linear)', () => {
    for (const id of GROUND_LAYER_IDS) {
      const layer = groundLayer(id, SIZE);
      expect(layer.albedo.image.width, id).toBe(SIZE);
      expect(layer.albedo.image.height, id).toBe(SIZE);
      expect(layer.normalRough.image.width, id).toBe(SIZE);
      expect(layer.albedo.colorSpace, id).toBe(THREE.SRGBColorSpace);
      expect(layer.normalRough.colorSpace, id).toBe(THREE.NoColorSpace);
      for (const texture of [layer.albedo, layer.normalRough]) {
        expect(texture.wrapS, id).toBe(THREE.RepeatWrapping);
        expect(texture.wrapT, id).toBe(THREE.RepeatWrapping);
        expect(texture.generateMipmaps, id).toBe(true);
        expect(texture.anisotropy, id).toBeLessThanOrEqual(4);
        expect(texture.userData['shared'], id).toBe(true);
      }
      expect(layer.tileMetres).toBeGreaterThan(0);
    }
  });

  it('decodes to unit-length normal texels (±0.03)', () => {
    for (const id of GROUND_LAYER_IDS) {
      const data = bytes(groundLayer(id, SIZE).normalRough);
      for (let i = 0; i < SIZE * SIZE; i += 97) {
        const nx = (data[i * 4] as number) / 127.5 - 1;
        const ny = (data[i * 4 + 1] as number) / 127.5 - 1;
        const nz = (data[i * 4 + 2] as number) / 127.5 - 1;
        expect(Math.abs(Math.hypot(nx, ny, nz) - 1), id).toBeLessThanOrEqual(0.03);
      }
    }
  });

  it('is deterministic: two uncached builds are byte-identical', () => {
    const a = buildGroundLayer('sand', SIZE);
    const b = buildGroundLayer('sand', SIZE);
    expect(bytes(a.albedo)).toEqual(bytes(b.albedo));
    expect(bytes(a.normalRough)).toEqual(bytes(b.normalRough));
    // And different layers are different fields, not palette swaps of one.
    expect(bytes(buildGroundLayer('rock', SIZE).albedo)).not.toEqual(bytes(a.albedo));
  });

  it('caches per `${id}:${size}` for the session, and prewarm fills the cache', () => {
    const first = groundLayer('snow', SIZE);
    expect(groundLayer('snow', SIZE)).toBe(first);
    expect(groundLayer('snow', SIZE).albedo).toBe(first.albedo);
    prewarm(['ice', 'moss']);
    expect(groundLayer('ice')).toBe(groundLayer('ice'));
  });

  it('is seamless: opposite edges continue each other', () => {
    const data = bytes(groundLayer('rock', SIZE).albedo);
    // The lattice period divides the texture, so texel (0, y) is one step past
    // texel (SIZE−1, y) in a periodic field — the wrap seam stays below the
    // in-row texel-to-texel contrast.
    let seam = 0;
    let interior = 0;
    for (let y = 0; y < SIZE; y++) {
      seam += Math.abs((data[(y * SIZE + 0) * 4] as number) - (data[(y * SIZE + SIZE - 1) * 4] as number));
      interior += Math.abs((data[(y * SIZE + SIZE / 2) * 4] as number) - (data[(y * SIZE + SIZE / 2 - 1) * 4] as number));
    }
    expect(seam / SIZE).toBeLessThanOrEqual(interior / SIZE + 4);
  });

  it('follows the alpha rule: height everywhere, masks on lava_rock and flesh', () => {
    // Flesh veins are sparse: most alpha texels sit near zero, unlike its soft
    // fbm height, which would spread across the mid-range.
    const flesh = bytes(groundLayer('flesh', SIZE).albedo);
    let dark = 0;
    for (let i = 0; i < SIZE * SIZE; i++) if ((flesh[i * 4 + 3] as number) < 32) dark++;
    expect(dark / (SIZE * SIZE)).toBeGreaterThan(0.5);
  });
});

describe('decalAtlas and particleSprite (SPEC-018 §4.5)', () => {
  it('the atlas is one cached 512² sRGB texture with four populated tiles', () => {
    const atlas = decalAtlas();
    expect(decalAtlas()).toBe(atlas);
    expect(atlas.image.width).toBe(512);
    expect(atlas.image.height).toBe(512);
    expect(atlas.colorSpace).toBe(THREE.SRGBColorSpace);
    const data = bytes(atlas);
    // Every quadrant carries some coverage at its centre region.
    for (const [cx, cy] of [
      [128, 128],
      [384, 128],
      [128, 384],
      [384, 384],
    ] as const) {
      let alpha = 0;
      for (let dy = -40; dy <= 40; dy += 8) {
        for (let dx = -40; dx <= 40; dx += 8) {
          alpha = Math.max(alpha, data[((cy + dy) * 512 + cx + dx) * 4 + 3] as number);
        }
      }
      expect(alpha).toBeGreaterThan(40);
    }
  });

  it('sprites have the §4.5 shapes and fall off to nothing at the rim', () => {
    expect(particleSprite('dot').image.width).toBe(32);
    expect(particleSprite('dot').image.height).toBe(32);
    expect(particleSprite('streak').image.width).toBe(64);
    expect(particleSprite('streak').image.height).toBe(16);
    expect(particleSprite('flake').image.width).toBe(32);
    expect(particleSprite('ember').image.width).toBe(32);
    expect(particleSprite('dot')).toBe(particleSprite('dot'));
    for (const kind of ['dot', 'streak', 'flake', 'ember'] as const) {
      const sprite = particleSprite(kind);
      const data = bytes(sprite);
      const w = sprite.image.width;
      const h = sprite.image.height;
      const centre = data[((h / 2) * w + w / 2) * 4 + 3] as number;
      expect(centre, kind).toBeGreaterThan(150);
      expect(data[3], kind).toBeLessThan(40); // the corner is transparent
    }
  });
});

// SPEC-020 §3 — the star map's globes.
describe('planetDisc (SPEC-020 §4.4)', () => {
  it('is a 256² sRGB map by default, opaque, tiling and session-cached', () => {
    const disc = planetDisc(PLANETS.cinder4);
    expect(disc.image.width).toBe(256);
    expect(disc.image.height).toBe(256);
    expect(disc.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(disc.wrapS).toBe(THREE.RepeatWrapping);
    expect(disc.userData['shared']).toBe(true);
    // Same planet, same texture — re-entering the map builds nothing.
    expect(planetDisc(PLANETS.cinder4)).toBe(disc);
    expect(planetDisc(PLANETS.cinder4, SIZE)).not.toBe(disc);
    const data = bytes(disc);
    for (let i = 0; i < 256 * 256; i += 997) expect(data[i * 4 + 3]).toBe(255);
  });

  it('wears each planet its own face, with ice at the poles and ground between', () => {
    const discs = PLANET_IDS.map((id) => planetDisc(PLANETS[id], SIZE));
    // No two worlds share a face: the seed is the planet id. Sampled at the
    // equator — every pole row is ice, whatever the world underneath.
    const equator = (SIZE / 2) * SIZE * 4;
    const signatures = discs.map((disc) => bytes(disc).slice(equator, equator + SIZE * 4).join(','));
    expect(new Set(signatures).size).toBe(PLANET_IDS.length);
    for (const [i, disc] of discs.entries()) {
      const data = bytes(disc);
      const id = PLANET_IDS[i] as string;
      // Row 0 is a pole: frozen, so bright and near-neutral.
      let poleSum = 0;
      let bandSum = 0;
      for (let x = 0; x < SIZE; x++) {
        poleSum += (data[x * 4] as number) + (data[x * 4 + 1] as number) + (data[x * 4 + 2] as number);
        const at = ((SIZE / 2) * SIZE + x) * 4;
        bandSum += (data[at] as number) + (data[at + 1] as number) + (data[at + 2] as number);
      }
      expect(poleSum / (SIZE * 3), `${id} pole`).toBeGreaterThan(180);
      expect(bandSum, `${id} equator`).toBeLessThan(poleSum);
    }
  });
});
