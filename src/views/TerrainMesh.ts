// Terrain tiles and the two-layer splat ground material (SPEC-018 §4.3, §4.4).
//
// The ground is 60 m `PlaneGeometry` tiles whose vertices are written in world
// space from the one shared `HeightField` — never `computeVertexNormals` per
// tile (18-e), so adjacent tiles agree on borders exactly and frustum culling
// keeps 4–9 of them on screen instead of one 65 k-triangle plane.
//
// The material is a single `MeshStandardMaterial` whose `onBeforeCompile`
// replaces only the sampling chunks — map, roughness, tangent normal,
// emissive — with a height-weighted two-layer blend. Lights, shadows, fog,
// IBL and tone mapping stay three's own.
import * as THREE from 'three';
import type { HeightField } from '@/core/HeightField';
import type { SurfaceLook } from '@/data/planets';
import type { GroundLayer } from '@/views/ProceduralTextures';

export const TERRAIN_TILE = 60;
/** PlaneGeometry segments per tile — 2 m quads, matching `HEIGHT_CELL`. */
const TILE_SEGMENTS = 30;

const scratchNormal = { x: 0, y: 1, z: 0 };

/**
 * All tiles covering the field's square, vertices in world space with the mesh
 * at the origin — bounding spheres still cull, and border vertices land on the
 * same grid nodes from both sides.
 */
export function buildTerrainTiles(field: HeightField, material: THREE.Material): THREE.Mesh[] {
  const side = (field.n - 1) * field.cell;
  const tiles = Math.ceil(side / TERRAIN_TILE);
  const meshes: THREE.Mesh[] = [];

  for (let tz = 0; tz < tiles; tz++) {
    for (let tx = 0; tx < tiles; tx++) {
      const geometry = new THREE.PlaneGeometry(TERRAIN_TILE, TERRAIN_TILE, TILE_SEGMENTS, TILE_SEGMENTS);
      geometry.rotateX(-Math.PI / 2);
      const centreX = field.origin + tx * TERRAIN_TILE + TERRAIN_TILE / 2;
      const centreZ = field.origin + tz * TERRAIN_TILE + TERRAIN_TILE / 2;
      geometry.translate(centreX, 0, centreZ);

      const position = geometry.getAttribute('position') as THREE.BufferAttribute;
      const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
      const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
      const count = position.count;
      const colors = new Float32Array(count * 3);
      const splats = new Float32Array(count);

      for (let i = 0; i < count; i++) {
        const x = position.getX(i);
        const z = position.getZ(i);
        position.setY(i, field.heightAt(x, z));
        field.normalAt(x, z, scratchNormal);
        normal.setXYZ(i, scratchNormal.x, scratchNormal.y, scratchNormal.z);
        // Metre UVs: the material's texture repeat turns them into tiling.
        uv.setXY(i, x, z);

        // Cavity tint and splat weight from the nearest grid node — vertices
        // sit on nodes, so "nearest" is exact inside the grid.
        const ix = Math.min(field.n - 1, Math.max(0, Math.round((x - field.origin) / field.cell)));
        const iz = Math.min(field.n - 1, Math.max(0, Math.round((z - field.origin) / field.cell)));
        const at = iz * field.n + ix;
        const occlusion = Math.max(0, field.occlusion[at] as number);
        const flat = field.flats[at] as number;
        const tint = (1 + (0.72 - 1) * occlusion) * (1 + (1.06 - 1) * flat);
        colors[i * 3] = tint;
        colors[i * 3 + 1] = tint;
        colors[i * 3 + 2] = tint;
        splats[i] = field.splat[at] as number;
      }
      position.needsUpdate = true;
      normal.needsUpdate = true;
      uv.needsUpdate = true;
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.setAttribute('splat', new THREE.BufferAttribute(splats, 1));
      geometry.computeBoundingSphere();

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = 'terrain';
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      meshes.push(mesh);
    }
  }
  return meshes;
}

// ------------------------------------------------------------------ material

interface TerrainUniforms {
  mapB: THREE.IUniform<THREE.Texture>;
  normalMapB: THREE.IUniform<THREE.Texture>;
  uTileRatio: THREE.IUniform<number>;
  uHeightBlend: THREE.IUniform<number>;
  uMacroScale: THREE.IUniform<number>;
  uMacroTint: THREE.IUniform<THREE.Color>;
  uCrackColor: THREE.IUniform<THREE.Color>;
  uTime: THREE.IUniform<number>;
}

/** The uniform record `createTerrainMaterial` parks on `userData` for updates. */
export function terrainUniforms(material: THREE.MeshStandardMaterial): TerrainUniforms {
  return material.userData['terrainUniforms'] as TerrainUniforms;
}

const FRAGMENT_HEADER = /* glsl */ `
uniform sampler2D mapB;
uniform sampler2D normalMapB;
uniform float uTileRatio;
uniform float uHeightBlend;
uniform float uMacroScale;
uniform float uTime;
uniform vec3 uMacroTint;
uniform vec3 uCrackColor;
varying float vSplat;
`;

const MAP_CHUNK = /* glsl */ `
vec4 texA = texture2D( map, vMapUv );
vec4 texB = texture2D( mapB, vMapUv * uTileRatio );
vec3 macro = texture2D( map, vMapUv * uMacroScale ).rgb;
float splatW = smoothstep( 0.3, 0.7, clamp( vSplat + ( 0.5 - texA.a ) * uHeightBlend, 0.0, 1.0 ) );
vec3 albedo = mix( texA.rgb, texB.rgb, splatW ) * mix( vec3( 1.0 ), macro * 2.0, 0.35 ) * uMacroTint;
diffuseColor.rgb *= albedo;
`;

const ROUGHNESS_CHUNK = /* glsl */ `
float roughnessFactor = roughness;
vec4 nrA = texture2D( normalMap, vNormalMapUv );
vec4 nrB = texture2D( normalMapB, vNormalMapUv * uTileRatio );
roughnessFactor *= mix( nrA.a, nrB.a, splatW );
`;

const NORMAL_CHUNK = /* glsl */ `
vec3 mapN = mix( nrA.xyz, nrB.xyz, splatW ) * 2.0 - 1.0;
mapN.xy *= normalScale;
normal = normalize( tbn * mapN );
`;

const EMISSIVE_CHUNK = /* glsl */ `
float crack = smoothstep( 0.55, 0.9, texB.a ) * splatW;
totalEmissiveRadiance += uCrackColor * crack * ( 0.8 + 0.2 * sin( uTime * 0.7 + vMapUv.x * 0.9 ) );
`;

/**
 * `palette.ground` in linear space, scaled to luminance 1: multiplying the
 * mid-grey albedo layers by it pulls their hue toward the planet without
 * moving their overall brightness (*initial tuning*).
 */
function macroTint(ground: string): THREE.Color {
  const color = new THREE.Color(ground).convertSRGBToLinear();
  const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  return luminance > 0 ? color.multiplyScalar(1 / luminance) : color.setScalar(1);
}

export function createTerrainMaterial(
  a: GroundLayer,
  b: GroundLayer,
  look: SurfaceLook,
  palette: { ground: string },
): THREE.MeshStandardMaterial {
  const cracks = look.ground.cracks;
  const material = new THREE.MeshStandardMaterial({
    map: a.albedo,
    normalMap: a.normalRough,
    roughness: 1,
    metalness: 0,
    vertexColors: true,
    envMapIntensity: 0.25,
  });
  material.normalScale.set(0.8, 0.8);
  a.albedo.repeat.setScalar(1 / a.tileMetres);
  a.normalRough.repeat.setScalar(1 / a.tileMetres);

  const uniforms: TerrainUniforms = {
    mapB: { value: b.albedo },
    normalMapB: { value: b.normalRough },
    uTileRatio: { value: a.tileMetres / b.tileMetres },
    uHeightBlend: { value: 1.5 },
    uMacroScale: { value: 0.137 },
    uMacroTint: { value: macroTint(palette.ground) },
    uCrackColor: {
      value: cracks === undefined ? new THREE.Color(0, 0, 0) : new THREE.Color(cracks.color).multiplyScalar(cracks.intensity),
    },
    uTime: { value: 0 },
  };
  material.userData['terrainUniforms'] = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float splat;\nvarying float vSplat;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = splat;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEADER}`)
      .replace('#include <map_fragment>', MAP_CHUNK)
      .replace('#include <roughnessmap_fragment>', ROUGHNESS_CHUNK)
      .replace('#include <normal_fragment_maps>', NORMAL_CHUNK);
    if (cracks !== undefined) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', EMISSIVE_CHUNK);
    }
  };
  material.customProgramCacheKey = () => `terrain/1${cracks !== undefined ? '+cracks' : ''}`;
  return material;
}

/**
 * Swap both layers in place — same defines, so no shader recompile: the maps
 * stay set, only which texture object each slot points at changes (§4.10).
 */
export function setTerrainLayers(material: THREE.MeshStandardMaterial, a: GroundLayer, b: GroundLayer): void {
  const uniforms = terrainUniforms(material);
  material.map = a.albedo;
  material.normalMap = a.normalRough;
  a.albedo.repeat.setScalar(1 / a.tileMetres);
  a.normalRough.repeat.setScalar(1 / a.tileMetres);
  uniforms.mapB.value = b.albedo;
  uniforms.normalMapB.value = b.normalRough;
  uniforms.uTileRatio.value = a.tileMetres / b.tileMetres;
}
