// SPEC-053 §6.1 — the foliage seam's pure parts and its materials: the 4 × 4
// Bayer dither and its JS twin, the coverage each fade keeps, the cut-out
// uniform against three's own projection, and the patched Lambert shaders,
// read as strings in node the way tests/views/terrain.test.ts reads the
// ground's.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BAYER4,
  CANOPY_FADE,
  CANOPY_FADE_RANGE,
  CANOPY_FADE_SECONDS,
  CUTOUT_HEAD_LIFT,
  CUTOUT_RADIUS,
  TRUNK_UNIT_RADIUS,
  WIND_SWAY,
  bayer4,
  createCoverMaterial,
  createFoliageMaterial,
  cutoutUniform,
  foliageUniforms,
} from '@/views/Foliage';

type Shader = Parameters<NonNullable<THREE.Material['onBeforeCompile']>>[0];

/** The material's `onBeforeCompile` run over three's own Lambert source. */
function patched(material: THREE.Material): { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> } {
  const shader = {
    uniforms: {} as Record<string, unknown>,
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
  material.onBeforeCompile(shader as unknown as Shader, undefined as never);
  return shader;
}

function atlas(): THREE.Texture {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.flipY = true; // what TextureLoader hands out
  return texture;
}

describe('the constants (§3)', () => {
  it('pin the tree contract, the sway, the cut-out and the canopy fade', () => {
    expect(TRUNK_UNIT_RADIUS).toBe(0.14);
    expect(WIND_SWAY).toBe(0.025);
    expect(CUTOUT_RADIUS).toBe(1.6);
    expect(CUTOUT_HEAD_LIFT).toBe(1.6);
    expect(CANOPY_FADE).toBe(0.35);
    expect(CANOPY_FADE_RANGE).toBe(25);
    expect(CANOPY_FADE_SECONDS).toBe(0.2);
    expect(BAYER4).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
  });
});

describe('bayer4 (§4.1.1)', () => {
  it('covers the sixteen values k/16 exactly once over x, y in 0…3', () => {
    const seen: number[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) seen.push(bayer4(x, y) * 16);
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, k) => k));
  });

  it('matches BAYER4’s orientation: rows by y, columns by x', () => {
    expect(bayer4(0, 0)).toBe(0);
    expect(bayer4(1, 0)).toBe(0.5);
    expect(bayer4(0, 1)).toBe(0.75);
    expect(bayer4(3, 3)).toBe(5 / 16);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) expect(bayer4(x, y)).toBe((BAYER4[y * 4 + x] as number) / 16);
  });

  it('tiles every 4 px, wraps negative pixels and floors fractional ones', () => {
    for (let y = -4; y < 8; y++) {
      for (let x = -4; x < 8; x++) {
        expect(bayer4(x + 4, y)).toBe(bayer4(x, y));
        expect(bayer4(x, y + 4)).toBe(bayer4(x, y));
      }
    }
    expect(bayer4(-1, -1)).toBe(bayer4(3, 3));
    expect(bayer4(2.7, 1.2)).toBe(bayer4(2, 1));
    // A pixel centre sits at n + 0.5; the floor maps it to n.
    expect(bayer4(10.5, 7.5)).toBe(bayer4(10, 7));
  });

  it('keeps 0, 6, 8 and 16 of each 4 × 4 block at fades 0, 0.35, 0.5 and 1 — a lower fade drops a superset', () => {
    const kept = (fade: number): Set<number> => {
      const out = new Set<number>();
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (bayer4(x, y) < fade) out.add(y * 4 + x);
      return out;
    };
    expect([0, CANOPY_FADE, 0.5, 1].map((fade) => kept(fade).size)).toEqual([0, 6, 8, 16]);
    // Nothing is discarded at fade 1 (53-o): the top threshold is 15/16.
    expect(Math.max(...BAYER4) / 16).toBeLessThan(1);
    for (const pixel of kept(CANOPY_FADE)) expect(kept(0.5).has(pixel)).toBe(true);
  });
});

describe('createFoliageMaterial (§4.1)', () => {
  it('is an opaque, alpha-tested, double-sided Lambert material on the atlas, vertex-coloured and tinted', () => {
    const map = atlas();
    const material = createFoliageMaterial(map, '#d0e0c0');
    expect(material.type).toBe('MeshLambertMaterial');
    expect(material.map).toBe(map);
    expect(map.flipY).toBe(false); // the glTF UV convention
    expect(material.alphaTest).toBe(0.45);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.vertexColors).toBe(true);
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);
    expect(material.color.getHex()).toBe(new THREE.Color('#d0e0c0').getHex());
    expect(material.customProgramCacheKey()).toBe('foliage/1');
  });

  it('patches the dither — the sixteen BAYER4 entries in order and the >= vFade discard — and the cut-out', () => {
    const material = createFoliageMaterial(atlas(), '#ffffff');
    const shader = patched(material);
    const table = BAYER4.map((value) => value.toFixed(1)).join(', ');
    expect(shader.fragmentShader).toContain(`float[ 16 ]( ${table} )`);
    expect(shader.fragmentShader).toContain('bayer4( gl_FragCoord.xy )');
    expect(shader.fragmentShader).toMatch(/if \( ditherD >= vFade \) discard;/);
    expect(shader.fragmentShader).toContain('uniform vec4 uCutout;');
    expect(shader.fragmentShader).toContain('gl_FragCoord.z < uCutout.w');
    expect(shader.fragmentShader).toContain('uCutout.z * ( 0.75 + 0.25 * ditherD )');
    // The discard runs after the alpha test, which three keeps.
    const fragment = shader.fragmentShader;
    expect(fragment.indexOf('#include <alphatest_fragment>')).toBeLessThan(fragment.indexOf('ditherD >= vFade'));
    // The vertex side: the instance fade through, and the sway by the square of height.
    expect(shader.vertexShader).toContain('attribute float instanceFade;');
    expect(shader.vertexShader).toContain('vFade = instanceFade;');
    expect(shader.vertexShader).toContain('pow( clamp( position.y / 2.4, 0.0, 1.0 ), 2.0 )');
    expect(shader.vertexShader).toContain('dot( instanceMatrix[ 3 ].xz, vec2( 0.37, 0.61 ) )');
    const uniforms = foliageUniforms(material);
    expect(shader.uniforms['uWind']).toBe(uniforms.uWind);
    expect(shader.uniforms['uTime']).toBe(uniforms.uTime);
    expect(shader.uniforms['uCutout']).toBe(uniforms.uCutout);
    expect(uniforms.uCutout.value.toArray()).toEqual([0, 0, 0, 0]);
  });
});

describe('createCoverMaterial (§4.1, §4.5)', () => {
  it('maps an instanced uvCell to its atlas cell, sways, and has neither the dither nor the cut-out', () => {
    const map = atlas();
    const material = createCoverMaterial(map);
    expect(map.flipY).toBe(false);
    expect(material.alphaTest).toBe(0.45);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.transparent).toBe(false);
    expect(material.customProgramCacheKey()).toBe('cover/1');
    const shader = patched(material);
    expect(shader.vertexShader).toContain('attribute float uvCell;');
    expect(shader.vertexShader).toContain('vMapUv = ( cellOrigin');
    expect(shader.vertexShader).toContain('uWind * pow(');
    expect(shader.vertexShader).not.toContain('instanceFade');
    expect(shader.fragmentShader).not.toContain('uCutout');
    expect(shader.fragmentShader).not.toContain('vFade');
  });
});

describe('cutoutUniform (§4.1.2)', () => {
  const WIDTH = 1600;
  const HEIGHT = 900;

  /** The fixed rig: pitch 55°, yaw 45°, `distance` from the target. */
  function rig(target: THREE.Vector3, distance: number): THREE.PerspectiveCamera {
    const pitch = (55 * Math.PI) / 180;
    const yaw = (45 * Math.PI) / 180;
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 200);
    camera.position.set(
      target.x + distance * Math.cos(pitch) * Math.sin(yaw),
      target.y + distance * Math.sin(pitch),
      target.z + distance * Math.cos(pitch) * Math.cos(yaw),
    );
    camera.lookAt(target);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    return camera;
  }

  const head = new THREE.Vector3(0, 0, 0);

  it('puts x and y in window pixels with the origin bottom-left, where three projects the head', () => {
    const camera = rig(head, 22);
    const out = cutoutUniform(camera, head, WIDTH, HEIGHT, new THREE.Vector4());
    const ndc = head.clone().project(camera);
    expect(Math.abs(out.x - ((ndc.x + 1) / 2) * WIDTH)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(out.y - ((ndc.y + 1) / 2) * HEIGHT)).toBeLessThanOrEqual(1e-6);
    // The camera looks at the head: dead centre.
    expect(out.x).toBeCloseTo(WIDTH / 2, 4);
    expect(out.y).toBeCloseTo(HEIGHT / 2, 4);
    // Off-centre, too: a head up and to the right of the target lands up and right on screen.
    const offset = new THREE.Vector3(3, 2, -3);
    const shifted = cutoutUniform(camera, offset, WIDTH, HEIGHT, new THREE.Vector4());
    const ndcShifted = offset.clone().project(camera);
    expect(Math.abs(shifted.x - ((ndcShifted.x + 1) / 2) * WIDTH)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(shifted.y - ((ndcShifted.y + 1) / 2) * HEIGHT)).toBeLessThanOrEqual(1e-6);
  });

  it('makes z the pixel length of 1.6 m across the view axis at the head’s depth', () => {
    const camera = rig(head, 22);
    const out = cutoutUniform(camera, head, WIDTH, HEIGHT, new THREE.Vector4());
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const a = head.clone().project(camera);
    const b = head.clone().addScaledVector(right, CUTOUT_RADIUS).project(camera);
    const pixels = Math.hypot(((b.x - a.x) / 2) * WIDTH, ((b.y - a.y) / 2) * HEIGHT);
    expect(Math.abs(out.z - pixels)).toBeLessThanOrEqual(0.5);
    // Twice the draw target's height, twice the radius; twice as far, half of it.
    const tall = cutoutUniform(camera, head, WIDTH, HEIGHT * 2, new THREE.Vector4());
    expect(tall.z).toBeCloseTo(out.z * 2, 6);
    const far = cutoutUniform(rig(head, 44), head, WIDTH, HEIGHT, new THREE.Vector4());
    expect(far.z).toBeCloseTo(out.z / 2, 6);
  });

  it('makes w the head’s window depth, ndc.z × 0.5 + 0.5, inside (0, 1)', () => {
    const camera = rig(head, 22);
    const out = cutoutUniform(camera, head, WIDTH, HEIGHT, new THREE.Vector4());
    const ndc = head.clone().project(camera);
    expect(out.w).toBeCloseTo(ndc.z * 0.5 + 0.5, 9);
    expect(out.w).toBeGreaterThan(0);
    expect(out.w).toBeLessThan(1);
  });

  it('writes (0, 0, 0, 0) for a head at or behind the near plane', () => {
    const camera = rig(head, 22);
    const behind = camera.position.clone().addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2), 5);
    const out = cutoutUniform(camera, behind, WIDTH, HEIGHT, new THREE.Vector4(1, 2, 3, 4));
    expect(out.toArray()).toEqual([0, 0, 0, 0]);
    // In front of the camera, but nearer than its near plane.
    const inside = camera.position.clone().addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2), -camera.near / 2);
    expect(cutoutUniform(camera, inside, WIDTH, HEIGHT, new THREE.Vector4(1, 2, 3, 4)).toArray()).toEqual([0, 0, 0, 0]);
  });

  it('returns the same out over 1,000 calls, with the same answer: nothing allocated', () => {
    const camera = rig(head, 22);
    const out = new THREE.Vector4();
    const first = cutoutUniform(camera, head, WIDTH, HEIGHT, out).toArray();
    for (let i = 0; i < 1000; i++) {
      expect(cutoutUniform(camera, head, WIDTH, HEIGHT, out)).toBe(out);
    }
    expect(out.toArray()).toEqual(first);
    // The head itself is read, never written.
    expect(head.toArray()).toEqual([0, 0, 0]);
  });
});
