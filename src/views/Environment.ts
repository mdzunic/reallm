// The procedural environment map (SPEC-017 §4.4) — what gives every
// `MeshStandardMaterial` in the game something to reflect. A 128 × 64
// equirectangular half-float gradient built from the planet's own palette: a
// ground half, a horizon band, a sky half, a sun lobe and an optional rim
// bounce. Three PMREM-filters it once on first use (≈ 0.34 MB) and the result
// costs no per-frame draw.
//
// A `RoomEnvironment` would have been free to write and wrong to look at: it
// lights everything like a photo studio, whatever planet you are standing on.
// This is ≈ 32 KB of arithmetic instead, deterministic, and it wears the
// palette the scene is already drawing.
import * as THREE from 'three';

export interface SkyParams {
  sky: string;
  horizon: string;
  ground: string;
  sunDir: [number, number, number];
  sunColor: string;
  sunIntensity: number;
  rimColor?: string;
}

/** The hub scenes' environment: a cool, neutral interior sky (§4.4). */
export const NEUTRAL_SKY: SkyParams = {
  sky: '#3a4a66',
  horizon: '#1c2430',
  ground: '#0b0f14',
  sunDir: normalize(0.3, 0.8, 0.5),
  sunColor: '#dfe8ff',
  sunIntensity: 4,
};

/** A planet's palette as sky parameters: fog is the horizon, accent the rim. */
export function skyParamsFor(palette: { ground: string; sky: string; fog: string; accent: string }): SkyParams {
  return {
    sky: palette.sky,
    horizon: palette.fog,
    ground: palette.ground,
    sunDir: normalize(0.45, 0.75, 0.3),
    sunColor: '#fff0d0',
    sunIntensity: 6,
    rimColor: palette.accent,
  };
}

function normalize(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/** Three's `equirectUv` in reverse: texel centre → the direction it holds. */
function directionAt(u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  const latitude = (v - 0.5) * Math.PI;
  const longitude = (u - 0.5) * Math.PI * 2;
  const cos = Math.cos(latitude);
  return out.set(cos * Math.cos(longitude), Math.sin(latitude), cos * Math.sin(longitude));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const SUN_EXPONENT = 48;
const RIM_EXPONENT = 4;
const RIM_STRENGTH = 0.25;

/**
 * An equirectangular half-float `DataTexture` for `scene.environment`. Pure and
 * deterministic: the same params always produce byte-identical texels, which is
 * what makes the map testable in node. Never tagged `userData.shared`, so its
 * owner — and only its owner — frees it (D-10).
 */
export function buildEnvironment(params: SkyParams, width = 128, height = 64): THREE.DataTexture {
  const sky = new THREE.Color(params.sky);
  const horizon = new THREE.Color(params.horizon);
  const ground = new THREE.Color(params.ground);
  const sun = new THREE.Color(params.sunColor);
  const rim = params.rimColor === undefined ? null : new THREE.Color(params.rimColor);
  const [sx, sy, sz] = normalize(params.sunDir[0], params.sunDir[1], params.sunDir[2]);

  const data = new Uint16Array(width * height * 4);
  const dir = new THREE.Vector3();
  const colour = new THREE.Color();
  for (let j = 0; j < height; j++) {
    // `DataTexture.flipY` is false, so row 0 is v = 0 — the south pole.
    const v = (j + 0.5) / height;
    for (let i = 0; i < width; i++) {
      directionAt((i + 0.5) / width, v, dir);
      const y = dir.y;
      if (y < 0) colour.copy(ground).lerp(horizon, smoothstep(-0.25, 0.05, y));
      else colour.copy(horizon).lerp(sky, smoothstep(0.02, 0.6, y));

      const alignment = dir.x * sx + dir.y * sy + dir.z * sz;
      const lobe = Math.pow(Math.max(0, alignment), SUN_EXPONENT) * params.sunIntensity;
      let r = colour.r + sun.r * lobe;
      let g = colour.g + sun.g * lobe;
      let b = colour.b + sun.b * lobe;
      if (rim !== null) {
        // The bounce off the far side: broad, dim, and the planet's accent hue.
        const bounce = Math.pow(Math.max(0, -alignment), RIM_EXPONENT) * RIM_STRENGTH;
        r += rim.r * bounce;
        g += rim.g * bounce;
        b += rim.b * bounce;
      }
      const at = (j * width + i) * 4;
      data[at] = THREE.DataUtils.toHalfFloat(r);
      data[at + 1] = THREE.DataUtils.toHalfFloat(g);
      data[at + 2] = THREE.DataUtils.toHalfFloat(b);
      data[at + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
