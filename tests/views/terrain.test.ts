// SPEC-018 AC (terrain): world-space tiles off the shared field, exact border
// agreement, metre UVs, and the splat material's compile-time surgery — all
// checked in node, where the shader strings are just strings.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildHeightField, type HeightFieldLayout } from '@/core/HeightField';
import { PLANETS } from '@/data/index';
import { groundLayer } from '@/views/ProceduralTextures';
import { TERRAIN_TILE, buildTerrainTiles, createTerrainMaterial, setTerrainLayers, terrainUniforms } from '@/views/TerrainMesh';

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
    expect(material.customProgramCacheKey()).toBe('terrain/1');
    // No cracks on Cinder-4: the uniform is black, the emissive chunk untouched.
    expect(uniforms.uCrackColor.value.getHex()).toBe(0x000000);
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
    expect(A2.albedo.repeat.x).toBeCloseTo(1 / 3, 6);
    // `needsUpdate` was never touched: the program key and version held.
    expect(material.version).toBe(version);
  });
});
