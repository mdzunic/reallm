// SPEC-017 §6 — the procedural environment map, pinned in node. The texture is
// plain arithmetic over a `Uint16Array`, so everything that matters about it is
// readable here: the flags three needs to treat it as an equirect HDR source,
// the determinism that lets a planet look the same on every landing, and the
// two terms (sun lobe, rim bounce) the gradient is built from.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PLANETS } from '@/data/index';
import { buildEnvironment, NEUTRAL_SKY, skyParamsFor, type SkyParams } from '@/views/Environment';

const params: SkyParams = {
  sky: '#3a4a66',
  horizon: '#1c2430',
  ground: '#0b0f14',
  sunDir: [0.45, 0.75, 0.3],
  sunColor: '#fff0d0',
  sunIntensity: 6,
};

function texels(texture: THREE.DataTexture): Uint16Array {
  return texture.image.data as unknown as Uint16Array;
}

/** Linear luminance of texel `i`, decoded from the half-float payload. */
function luminance(data: Uint16Array, i: number): number {
  const r = THREE.DataUtils.fromHalfFloat(data[i * 4] as number);
  const g = THREE.DataUtils.fromHalfFloat(data[i * 4 + 1] as number);
  const b = THREE.DataUtils.fromHalfFloat(data[i * 4 + 2] as number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Three's `equirectUv`, inverted: which direction texel `i` holds. */
function directionOf(i: number, width: number, height: number): THREE.Vector3 {
  const u = ((i % width) + 0.5) / width;
  const v = (Math.floor(i / width) + 0.5) / height;
  const latitude = (v - 0.5) * Math.PI;
  const longitude = (u - 0.5) * Math.PI * 2;
  const cos = Math.cos(latitude);
  return new THREE.Vector3(cos * Math.cos(longitude), Math.sin(latitude), cos * Math.sin(longitude));
}

function brightest(texture: THREE.DataTexture): number {
  const data = texels(texture);
  let best = 0;
  let bestValue = -1;
  for (let i = 0; i < data.length / 4; i++) {
    const value = luminance(data, i);
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

describe('buildEnvironment (SPEC-017 §4.4, AC-62 … AC-65)', () => {
  it('is a 128 × 64 half-float equirect three can PMREM-filter', () => {
    const texture = buildEnvironment(params);
    expect(texture.image.width).toBe(128);
    expect(texture.image.height).toBe(64);
    expect(texels(texture)).toHaveLength(128 * 64 * 4);
    expect(texture.mapping).toBe(THREE.EquirectangularReflectionMapping);
    expect(texture.type).toBe(THREE.HalfFloatType);
    // Already linear: the sRGB → linear conversion happened once, in JS.
    expect(texture.colorSpace).toBe(THREE.LinearSRGBColorSpace);
    expect(texture.minFilter).toBe(THREE.LinearFilter);
    expect(texture.magFilter).toBe(THREE.LinearFilter);
    expect(texture.generateMipmaps).toBe(false);
    // `needsUpdate` is a setter with no getter; the version bump is its trace.
    expect(texture.version).toBeGreaterThan(0);
    // D-10: the owner frees it, so `disposeObject3D` must never skip it.
    expect(texture.userData['shared']).toBeUndefined();
    texture.dispose();
  });

  it('takes an explicit size', () => {
    const texture = buildEnvironment(params, 32, 16);
    expect(texture.image.width).toBe(32);
    expect(texture.image.height).toBe(16);
    texture.dispose();
  });

  it('is deterministic: the same params produce byte-identical texels', () => {
    const a = buildEnvironment(params);
    const b = buildEnvironment(params);
    expect(texels(a)).toEqual(texels(b));
    expect(texels(a)).not.toBe(texels(b)); // two textures, not one shared buffer
    a.dispose();
    b.dispose();
  });

  it('puts its brightest texel on the sun direction', () => {
    const texture = buildEnvironment(params);
    const sun = new THREE.Vector3(...params.sunDir).normalize();
    const found = directionOf(brightest(texture), 128, 64);
    // Within one texel of the sun: 128 × 64 is ≈ 2.8° a side.
    expect(found.dot(sun)).toBeGreaterThan(0.99);
    texture.dispose();
  });

  it('adds the rim term only when a rim colour is given', () => {
    const plain = buildEnvironment(params);
    const rimmed = buildEnvironment({ ...params, rimColor: '#c04ad0' });
    const away = new THREE.Vector3(...params.sunDir).normalize().negate();
    const plainData = texels(plain);
    const rimmedData = texels(rimmed);

    let compared = 0;
    for (let i = 0; i < plainData.length / 4; i++) {
      // The band facing away from the sun, where the bounce actually lands.
      if (directionOf(i, 128, 64).dot(away) < 0.9) continue;
      compared++;
      expect(luminance(plainData, i), `texel ${i}`).toBeLessThan(luminance(rimmedData, i));
    }
    expect(compared).toBeGreaterThan(4); // the band is not empty

    // Everywhere the bounce cannot reach, the two are the same picture.
    const front = new THREE.Vector3(...params.sunDir).normalize();
    for (let i = 0; i < plainData.length / 4; i++) {
      if (directionOf(i, 128, 64).dot(front) < 0.2) continue;
      expect(plainData[i * 4], `texel ${i}`).toBe(rimmedData[i * 4]);
    }
    plain.dispose();
    rimmed.dispose();
  });
});

describe('the parameter sets (SPEC-017 §4.4, AC-66)', () => {
  it('skyParamsFor reads the planet palette: fog is the horizon, accent the rim', () => {
    const palette = PLANETS.cinder4.surface.palette;
    const sky = skyParamsFor(palette);
    expect(sky.sky).toBe(palette.sky);
    expect(sky.horizon).toBe(palette.fog);
    expect(sky.ground).toBe(palette.ground);
    expect(sky.rimColor).toBe(palette.accent);
    expect(sky.sunColor).toBe('#fff0d0');
    expect(sky.sunIntensity).toBe(6);
    expect(new THREE.Vector3(...sky.sunDir).length()).toBeCloseTo(1, 6);
    // The direction of §4.4, normalised.
    const expected = new THREE.Vector3(0.45, 0.75, 0.3).normalize();
    expect(new THREE.Vector3(...sky.sunDir).dot(expected)).toBeCloseTo(1, 6);
  });

  it('NEUTRAL_SKY is the hub set, and carries no rim', () => {
    expect(NEUTRAL_SKY.sky).toBe('#3a4a66');
    expect(NEUTRAL_SKY.horizon).toBe('#1c2430');
    expect(NEUTRAL_SKY.ground).toBe('#0b0f14');
    expect(NEUTRAL_SKY.sunColor).toBe('#dfe8ff');
    expect(NEUTRAL_SKY.sunIntensity).toBe(4);
    expect(NEUTRAL_SKY.rimColor).toBeUndefined();
    const expected = new THREE.Vector3(0.3, 0.8, 0.5).normalize();
    expect(new THREE.Vector3(...NEUTRAL_SKY.sunDir).dot(expected)).toBeCloseTo(1, 6);
  });
});
