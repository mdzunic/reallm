// SPEC-018 AC (terrain): world-space tiles off the shared field, exact border
// agreement, metre UVs, and the splat material's compile-time surgery — all
// checked in node, where the shader strings are just strings.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildHeightField, type HeightFieldLayout } from '@/core/HeightField';
import { PLANETS } from '@/data/index';
import { groundLayer } from '@/views/ProceduralTextures';
import {
  CANOPY_SHADE,
  DETAIL_STRENGTH,
  MACRO_PATCH_METRES,
  macroPatchAt,
  macroTintAt,
  type TerrainMacro,
  DETAIL_TILE_METRES,
  TERRAIN_TILE,
  TERRAIN_TINT_AMOUNT,
  buildTerrainTiles,
  createTerrainMaterial,
  setGroundDetail,
  setTerrainLayers,
  terrainUniforms,
} from '@/views/TerrainMesh';

const LAYOUT: HeightFieldLayout = {
  halfSize: 40,
  hash: 0x5eed1234,
  pois: [{ x: 20, z: -12, radius: 6 }],
};

const RELIEF = { amplitude: 0.5, wavelength: 24, ridged: 0.5, bermHeight: 5 };
const field = buildHeightField(LAYOUT, RELIEF);
const layerA = groundLayer('sand', 32);
const layerB = groundLayer('cracked_earth', 32);
const A = { ...layerA, tileMetres: 4 };
const B = { ...layerB, tileMetres: 5.5 };

function tiles(): THREE.Mesh[] {
  return buildTerrainTiles(field, new THREE.MeshStandardMaterial());
}

describe('buildTerrainTiles (SPEC-018 §4.3)', () => {
  it('is PlaneGeometry(60, 60, 30, 30) pieces covering the apron, at the origin', () => {
    const meshes = tiles();
    const side = (field.n - 1) * field.cell;
    expect(meshes.length).toBe(Math.ceil(side / TERRAIN_TILE) ** 2);
    for (const mesh of meshes) {
      const geometry = mesh.geometry as THREE.PlaneGeometry;
      expect(geometry.type).toBe('PlaneGeometry');
      expect(geometry.parameters.width).toBe(60);
      expect(geometry.parameters.height).toBe(60);
      expect(geometry.parameters.widthSegments).toBe(30);
      expect(geometry.parameters.heightSegments).toBe(30);
      // World-space vertices, mesh untransformed — bounding spheres still cull.
      expect(mesh.position.length()).toBe(0);
      expect(mesh.matrixAutoUpdate).toBe(false);
      expect(mesh.receiveShadow).toBe(true);
      expect(mesh.castShadow).toBe(false);
      expect(geometry.boundingSphere).not.toBeNull();
    }
  });

  it('takes heights and normals from the field, with metre UVs and a splat attribute', () => {
    const mesh = tiles()[0] as THREE.Mesh;
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const normal = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const uv = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
    const splat = mesh.geometry.getAttribute('splat') as THREE.BufferAttribute;
    const color = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(splat.itemSize).toBe(1);
    expect(color.itemSize).toBe(3);
    const out = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < position.count; i += 13) {
      const x = position.getX(i);
      const z = position.getZ(i);
      expect(position.getY(i)).toBeCloseTo(field.heightAt(x, z), 5);
      field.normalAt(x, z, out);
      expect(normal.getX(i)).toBeCloseTo(out.x, 5);
      expect(normal.getY(i)).toBeCloseTo(out.y, 5);
      expect(normal.getZ(i)).toBeCloseTo(out.z, 5);
      expect(uv.getX(i)).toBeCloseTo(x, 6);
      expect(uv.getY(i)).toBeCloseTo(z, 6);
      expect(splat.getX(i)).toBeGreaterThanOrEqual(0);
      expect(splat.getX(i)).toBeLessThanOrEqual(1);
      expect(color.getX(i)).toBeGreaterThan(0.5);
    }
  });

  it('adjacent tiles agree on border positions and normals exactly', () => {
    const seen = new Map<string, [number, number, number, number]>();
    let shared = 0;
    for (const mesh of tiles()) {
      const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const normal = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
      for (let i = 0; i < position.count; i++) {
        const key = `${position.getX(i)}|${position.getZ(i)}`;
        const entry: [number, number, number, number] = [position.getY(i), normal.getX(i), normal.getY(i), normal.getZ(i)];
        const before = seen.get(key);
        if (before === undefined) {
          seen.set(key, entry);
        } else {
          shared++;
          expect(entry).toEqual(before); // exact — both came from the one field
        }
      }
    }
    expect(shared).toBeGreaterThan(100); // the borders actually overlapped
  });
});

describe('createTerrainMaterial (SPEC-018 §4.4)', () => {
  it('is one MeshStandardMaterial with the §4.4 settings and uniforms', () => {
    const material = createTerrainMaterial(A, B, PLANETS.cinder4.surface.look, PLANETS.cinder4.surface.palette);
    expect(material.type).toBe('MeshStandardMaterial');
    expect(material.map).toBe(A.albedo);
    expect(material.normalMap).toBe(A.normalRough);
    expect(material.roughness).toBe(1);
    expect(material.metalness).toBe(0);
    expect(material.vertexColors).toBe(true);
    expect(material.envMapIntensity).toBeCloseTo(0.25, 6);
    expect(material.normalScale.x).toBeCloseTo(0.8, 6);
    expect(A.albedo.repeat.x).toBeCloseTo(1 / 4, 6);
    const uniforms = terrainUniforms(material);
    expect(uniforms.mapB.value).toBe(B.albedo);
    expect(uniforms.normalMapB.value).toBe(B.normalRough);
    expect(uniforms.uTileRatio.value).toBeCloseTo(4 / 5.5, 6);
    expect(uniforms.uHeightBlend.value).toBeCloseTo(1.5, 6);
    expect(uniforms.uMacroScale.value).toBeCloseTo(0.137, 6);
    // SPEC-046 §4.5: the macro tint pulls at 35 % unless the look says otherwise.
    expect(TERRAIN_TINT_AMOUNT).toBe(0.35);
    expect(uniforms.uTintAmount.value).toBe(0.35);
    expect(material.customProgramCacheKey()).toBe('terrain/1');
    // No cracks on Cinder-4: the uniform is black, the emissive chunk untouched.
    expect(uniforms.uCrackColor.value.getHex()).toBe(0x000000);
  });

  it("takes a look's own tint amount, with no change to the program key (SPEC-046 §4.5)", () => {
    const base = PLANETS.cinder4.surface.look;
    const look = { ...base, ground: { ...base.ground, tint: 0.6 } };
    const material = createTerrainMaterial(A, B, look, PLANETS.cinder4.surface.palette);
    expect(terrainUniforms(material).uTintAmount.value).toBe(0.6);
    expect(material.customProgramCacheKey()).toBe('terrain/1');
    const none = createTerrainMaterial(A, B, { ...base, ground: { ...base.ground, tint: 0 } }, PLANETS.cinder4.surface.palette);
    expect(terrainUniforms(none).uTintAmount.value).toBe(0);
  });

  it('multiplies the albedo by mix(1, uMacroTint, uTintAmount) (SPEC-046 §4.5)', () => {
    const material = createTerrainMaterial(A, B, PLANETS.cinder4.surface.look, PLANETS.cinder4.surface.palette);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>',
    };
    material.onBeforeCompile?.(shader as unknown as Parameters<NonNullable<THREE.Material['onBeforeCompile']>>[0], undefined as never);
    expect(shader.fragmentShader).toContain('uniform float uTintAmount;');
    expect(shader.fragmentShader).toContain('* mix( vec3( 1.0 ), uMacroTint, uTintAmount );');
    expect(shader.fragmentShader).not.toMatch(/\*\s*uMacroTint;/);
    expect(shader.uniforms['uTintAmount']).toBe(terrainUniforms(material).uTintAmount);
  });

  it('the cracks variant keys a different program and a hot uniform', () => {
    const material = createTerrainMaterial(A, B, PLANETS.ferrum.surface.look, PLANETS.ferrum.surface.palette);
    expect(material.customProgramCacheKey()).toBe('terrain/1+cracks');
    const crack = terrainUniforms(material).uCrackColor.value;
    expect(crack.r).toBeGreaterThan(1); // #ff6a2a × 3 clears the bloom threshold
  });

  it('replaces only map, roughnessmap, normal_fragment_maps and emissivemap', () => {
    const CHUNKS = [
      'map_fragment',
      'color_fragment',
      'alphamap_fragment',
      'roughnessmap_fragment',
      'metalnessmap_fragment',
      'normal_fragment_begin',
      'normal_fragment_maps',
      'emissivemap_fragment',
      'lights_fragment_begin',
      'fog_fragment',
    ];
    const material = createTerrainMaterial(A, B, PLANETS.ferrum.surface.look, PLANETS.ferrum.surface.palette);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n#include <fog_vertex>',
      fragmentShader: CHUNKS.map((chunk) => `#include <${chunk}>`).join('\n'),
    };
    material.onBeforeCompile?.(shader as unknown as Parameters<NonNullable<THREE.Material['onBeforeCompile']>>[0], undefined as never);
    const survivors = CHUNKS.filter((chunk) => shader.fragmentShader.includes(`#include <${chunk}>`));
    expect(survivors).toEqual([
      'color_fragment',
      'alphamap_fragment',
      'metalnessmap_fragment',
      'normal_fragment_begin',
      'lights_fragment_begin',
      'fog_fragment',
    ]);
    // The vertex side only gains the splat plumbing.
    expect(shader.vertexShader).toContain('attribute float splat');
    expect(shader.vertexShader).toContain('vSplat = splat');
    expect(shader.vertexShader).toContain('#include <fog_vertex>');
    expect(shader.uniforms['mapB']).toBeDefined();
    expect(shader.uniforms['uTime']).toBeDefined();
  });

  it('setTerrainLayers swaps textures with no recompile and no define change', () => {
    const material = createTerrainMaterial(A, B, PLANETS.cinder4.surface.look, PLANETS.cinder4.surface.palette);
    const version = material.version;
    const A2 = { ...groundLayer('rock', 32), tileMetres: 3 };
    const B2 = { ...groundLayer('basalt', 32), tileMetres: 6 };
    setTerrainLayers(material, A2, B2);
    expect(material.map).toBe(A2.albedo);
    expect(material.normalMap).toBe(A2.normalRough);
    expect(terrainUniforms(material).mapB.value).toBe(B2.albedo);
    expect(terrainUniforms(material).uTileRatio.value).toBeCloseTo(0.5, 6);
    // SPEC-046 §4.5: the tint amount is the planet's, not the layers'.
    expect(terrainUniforms(material).uTintAmount.value).toBe(0.35);
    expect(A2.albedo.repeat.x).toBeCloseTo(1 / 3, 6);
    // `needsUpdate` was never touched: the program key and version held.
    expect(material.version).toBe(version);
  });
});

// ---------------------------------------------------------------- SPEC-053

/** The shader as the GPU sees it under `defines`: `#ifdef` / `#else` / `#endif` resolved, nesting kept. */
function preprocess(source: string, defines: readonly string[]): string {
  const kept: string[] = [];
  const stack: boolean[] = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    const active = stack.every(Boolean);
    if (trimmed.startsWith('#ifdef ')) stack.push(defines.includes(trimmed.slice(7).trim()));
    else if (trimmed.startsWith('#else')) stack.push(!(stack.pop() ?? true));
    else if (trimmed.startsWith('#endif')) stack.pop();
    else if (active) kept.push(line);
  }
  return kept.join('\n');
}

describe('detail, anti-tiling, the seam and canopy shade (SPEC-053 §4.6)', () => {
  type Shader = Parameters<NonNullable<THREE.Material['onBeforeCompile']>>[0];
  const CHUNKS = '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n#include <emissivemap_fragment>';

  function compiled(material: THREE.MeshStandardMaterial): string {
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: CHUNKS };
    material.onBeforeCompile(shader as unknown as Shader, undefined as never);
    return shader.fragmentShader;
  }

  it('compiles terrain/2 with TERRAIN_DETAIL and TERRAIN_ANTITILE on medium and high, terrain/1 without', () => {
    expect(DETAIL_TILE_METRES).toBe(1.2);
    expect(DETAIL_STRENGTH).toBe(0.35);
    const cinder = PLANETS.cinder4.surface;
    const detailed = createTerrainMaterial(A, B, cinder.look, cinder.palette, { detail: true });
    expect(detailed.customProgramCacheKey()).toBe('terrain/2+detail');
    expect(detailed.defines).toMatchObject({ STANDARD: '', TERRAIN_DETAIL: '', TERRAIN_ANTITILE: '' });
    const low = createTerrainMaterial(A, B, cinder.look, cinder.palette, { detail: false });
    expect(low.customProgramCacheKey()).toBe('terrain/1');
    expect(low.defines).toEqual({ STANDARD: '' });
    const ferrum = PLANETS.ferrum.surface;
    expect(createTerrainMaterial(A, B, ferrum.look, ferrum.palette, { detail: true }).customProgramCacheKey()).toBe('terrain/2+detail+cracks');
    // The detail normal every 1.2 m in layer A's UVs, at 0.35.
    const uniforms = terrainUniforms(detailed);
    expect(uniforms.uDetailRatio.value).toBeCloseTo(4 / 1.2, 9);
    expect(uniforms.uDetailStrength.value).toBe(0.35);
    // The flat 1 × 1 stand-in: (128, 128, 255, 128).
    expect(Array.from((uniforms.detailMap.value as THREE.DataTexture).image.data as Uint8Array)).toEqual([128, 128, 255, 128]);
  });

  it('samples the detail normal, layer A again at R(37°) · uv · 0.43, and blends by the macro sample', () => {
    const cinder = PLANETS.cinder4.surface;
    const fragment = compiled(createTerrainMaterial(A, B, cinder.look, cinder.palette, { detail: true }));
    expect(fragment).toContain('texture2D( detailMap, terrainNrUv * uDetailRatio )');
    expect(fragment).toContain('mapN.xy += detailN.xy * uDetailStrength;');
    expect(fragment).toContain(`mat2( ${Math.cos((37 * Math.PI) / 180).toFixed(8)}, ${Math.sin((37 * Math.PI) / 180).toFixed(8)}`);
    expect(fragment).toContain('ANTI_ROTATION * terrainUv * 0.43');
    expect(fragment).toContain('ANTI_ROTATION * terrainNrUv * 0.43');
    expect(fragment).toContain('0.5 * smoothstep( 0.35, 0.65, macro.g )');
    // Three more fetches than the low program: albedo and normal again, and the detail.
    const fetches = (text: string, defines: readonly string[]): number =>
      (preprocess(text, defines).match(/texture2D\(/g) ?? []).length;
    const low = compiled(createTerrainMaterial(A, B, cinder.look, cinder.palette));
    expect(fetches(fragment, ['TERRAIN_DETAIL', 'TERRAIN_ANTITILE']) - fetches(low, [])).toBe(3);
  });

  it('defines TERRAIN_SEAM with a seam, on every preset, past its line by its shift', () => {
    const eden = PLANETS.eden.surface;
    for (const detail of [false, true]) {
      const material = createTerrainMaterial(A, B, eden.look, eden.palette, { detail, seam: { at: 42.5, shift: 1.75 } });
      expect(material.defines).toHaveProperty('TERRAIN_SEAM');
      expect(material.customProgramCacheKey()).toBe(detail ? 'terrain/2+detail+seam' : 'terrain/1+seam');
      expect(terrainUniforms(material).uSeamAt.value).toBe(42.5);
      expect(terrainUniforms(material).uSeamShift.value).toBe(1.75);
      expect(terrainUniforms(material).uTileA.value).toBe(4);
      const fragment = compiled(material);
      expect(fragment).toContain('if ( vMapUv.x * uTileA > uSeamAt ) {');
      expect(fragment).toContain('terrainUv += uSeamShift / uTileA;');
    }
    // No seam, no define.
    expect(createTerrainMaterial(A, B, eden.look, eden.palette, { detail: true }).defines).not.toHaveProperty('TERRAIN_SEAM');
  });

  it('setGroundDetail swaps the detail map in with no program change', () => {
    const cinder = PLANETS.cinder4.surface;
    const material = createTerrainMaterial(A, B, cinder.look, cinder.palette, { detail: true });
    const version = material.version;
    const key = material.customProgramCacheKey();
    const detail = new THREE.Texture();
    setGroundDetail(material, detail);
    expect(terrainUniforms(material).detailMap.value).toBe(detail);
    expect(detail.wrapS).toBe(THREE.RepeatWrapping);
    expect(detail.wrapT).toBe(THREE.RepeatWrapping);
    expect(material.version).toBe(version);
    expect(material.customProgramCacheKey()).toBe(key);
  });

  it('darkens the vertex tint × 0.7 at a canopy’s centre and leaves it × 1 at its radius', () => {
    expect(CANOPY_SHADE).toBe(0.3);
    const plain = buildTerrainTiles(field, new THREE.MeshStandardMaterial());
    const mesh = plain[0] as THREE.Mesh;
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    // A vertex well inside the first tile, and the canopy centred on it.
    const centre = 31 * 15 + 15;
    const x = position.getX(centre);
    const z = position.getZ(centre);
    const r = 4;
    const shaded = buildTerrainTiles(field, new THREE.MeshStandardMaterial(), { canopies: [{ x, z, r }] })[0] as THREE.Mesh;
    const tint = (m: THREE.Mesh, i: number): number => (m.geometry.getAttribute('color') as THREE.BufferAttribute).getX(i);
    expect(tint(shaded, centre) / tint(mesh, centre)).toBeCloseTo(0.7, 6);
    // Two nodes (4 m) along x is the rim: untouched.
    const rim = centre + 2;
    expect(Math.hypot(position.getX(rim) - x, position.getZ(rim) - z)).toBeCloseTo(r, 6);
    expect(tint(shaded, rim) / tint(mesh, rim)).toBeCloseTo(1, 6);
    // One node (2 m, half the radius) is in between.
    const half = tint(shaded, centre + 1) / tint(mesh, centre + 1);
    expect(half).toBeGreaterThan(0.7);
    expect(half).toBeLessThan(1);
    // Overlapping canopies take the strongest, never the product.
    const twice = buildTerrainTiles(field, new THREE.MeshStandardMaterial(), { canopies: [{ x, z, r }, { x, z, r: r * 2 }] })[0] as THREE.Mesh;
    expect(tint(twice, centre) / tint(mesh, centre)).toBeCloseTo(0.7, 6);
  });
});

// ---------------------------------------------------------- PLAN R28 / SPEC-067

describe('the macro patch field (SPEC-067)', () => {
  const MACRO: TerrainMacro = { seed: 0x6d61, hues: ['#e07040', '#d8d4cc'], strength: 0.6, value: 0.3, patches: 0.6 };
  const tint = (m: THREE.Mesh): THREE.BufferAttribute => m.geometry.getAttribute('color') as THREE.BufferAttribute;
  const splat = (m: THREE.Mesh): THREE.BufferAttribute => m.geometry.getAttribute('splat') as THREE.BufferAttribute;

  it('multiplies each vertex tint by the field’s hue and value, and adds layer B’s patches to the splat', () => {
    const plain = buildTerrainTiles(field, new THREE.MeshStandardMaterial());
    const dressed = buildTerrainTiles(field, new THREE.MeshStandardMaterial(), undefined, MACRO);
    const hueA = new THREE.Color(MACRO.hues[0]);
    const hueB = new THREE.Color(MACRO.hues[1]);
    hueA.multiplyScalar(1 / (0.2126 * hueA.r + 0.7152 * hueA.g + 0.0722 * hueA.b));
    hueB.multiplyScalar(1 / (0.2126 * hueB.r + 0.7152 * hueB.g + 0.0722 * hueB.b));
    const out = new THREE.Color();
    let hued = 0;
    let patched = 0;
    for (let t = 0; t < plain.length; t++) {
      const a = plain[t] as THREE.Mesh;
      const b = dressed[t] as THREE.Mesh;
      const position = a.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < position.count; i += 7) {
        const x = position.getX(i);
        const z = position.getZ(i);
        const value = macroTintAt(MACRO, hueA, hueB, x, z, out);
        expect(value).toBeGreaterThanOrEqual(1 - MACRO.value - 1e-9);
        expect(value).toBeLessThanOrEqual(1 + MACRO.value + 1e-9);
        expect(tint(b).getX(i)).toBeCloseTo(tint(a).getX(i) * value * out.r, 5);
        expect(tint(b).getY(i)).toBeCloseTo(tint(a).getY(i) * value * out.g, 5);
        expect(tint(b).getZ(i)).toBeCloseTo(tint(a).getZ(i) * value * out.b, 5);
        if (Math.abs(out.r - out.b) > 0.05) hued++;
        const patch = macroPatchAt(MACRO, x, z);
        expect(patch).toBeGreaterThanOrEqual(0);
        expect(patch).toBeLessThanOrEqual(MACRO.patches);
        expect(splat(b).getX(i)).toBeCloseTo(Math.min(1, splat(a).getX(i) + patch), 6);
        if (patch > 0.3) patched++;
      }
    }
    // The field really varies: some ground is pulled warm, some carries layer B's patches.
    expect(hued).toBeGreaterThan(0);
    expect(patched).toBeGreaterThan(0);
    expect(MACRO_PATCH_METRES).toBeGreaterThanOrEqual(20);
  });

  it('keeps tile borders in exact agreement, and leaves the material and its program key alone', () => {
    const seen = new Map<string, [number, number, number, number]>();
    let shared = 0;
    for (const mesh of buildTerrainTiles(field, new THREE.MeshStandardMaterial(), undefined, MACRO)) {
      const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < position.count; i++) {
        const key = `${position.getX(i)}|${position.getZ(i)}`;
        const entry: [number, number, number, number] = [tint(mesh).getX(i), tint(mesh).getY(i), tint(mesh).getZ(i), splat(mesh).getX(i)];
        const before = seen.get(key);
        if (before === undefined) seen.set(key, entry);
        else {
          shared++;
          expect(entry).toEqual(before);
        }
      }
    }
    expect(shared).toBeGreaterThan(100);
    const material = createTerrainMaterial(A, B, PLANETS.cinder4.surface.look, PLANETS.cinder4.surface.palette);
    expect(material.customProgramCacheKey()).toBe('terrain/1');
  });
});
