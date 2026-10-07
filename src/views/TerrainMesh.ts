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
//
// PLAN R28 / SPEC-067: the tiles also bake the planet's macro patch field —
// two hues, light and dark patches and large patches of layer B — into their
// vertex tint and splat, so the ground stops reading as one tiling plate. It
// is vertex data, computed once: no define, no program key, no fetch.
//
// SPEC-053 §4.6: on `medium` and `high` the same chunks also add a 1.2 m
// detail normal and a rotated second sample of layer A against the tile, and
// Eden's look adds the seam on every preset. The tiles' vertex tint darkens
// under every canopy, computed once when they are built.
import * as THREE from 'three';
import type { HeightField } from '@/core/HeightField';
import { fbm2 } from '@/core/Noise';
import type { SurfaceLook } from '@/data/planets';
import type { GroundLayer } from '@/views/ProceduralTextures';

export const TERRAIN_TILE = 60;
/**
 * SPEC-046 §4.5: how far the macro tint pulls the albedo toward the planet's
 * ground colour. At full strength it multiplied Cinder-4's blue channel by
 * 0.20 and gave Thessaly and Eden one green; at 0.35 the hue survives in the
 * light and the fog, and the layers' own colours come back (*initial tuning*).
 * `look.ground.tint` overrides it per planet.
 */
export const TERRAIN_TINT_AMOUNT = 0.35;
/** PlaneGeometry segments per tile — 2 m quads, matching `HEIGHT_CELL`. */
const TILE_SEGMENTS = 30;

/** SPEC-053 §4.6: the detail normal repeats every this many metres… */
export const DETAIL_TILE_METRES = 1.2;
/** …and its xy is added to the ground's normal at this strength. */
export const DETAIL_STRENGTH = 0.35;
/** SPEC-053 §4.6: how much a canopy darkens the ground at its heart. */
export const CANOPY_SHADE = 0.3;
/** The canopy bucket grid's cell, in metres. */
const SHADE_CELL = 16;
/** §4.6: the anti-tiling sample's rotation and scale — R(37°) · uv · 0.43. */
const ANTI_TILE_ANGLE = (37 * Math.PI) / 180;
const ANTI_TILE_SCALE = 0.43;

/** SPEC-053 §4.6: every tree's position and canopy radius, for the shade under it. */
export interface TerrainShade {
  canopies: readonly { x: number; z: number; r: number }[];
}

/**
 * PLAN R28 / SPEC-067: the macro patch field a planet's look asks for
 * (`look.dressing.macro`), seeded from `hash32(layout.hash, 'macro')`.
 */
export interface TerrainMacro {
  seed: number;
  /** Two hues (sRGB) the tint drifts between, each used at luminance 1. */
  hues: readonly [string, string];
  /** 0..1: how far the tint moves toward the hue. */
  strength: number;
  /** ± how much the value patches lighten and darken. */
  value: number;
  /** 0..1: how much layer B the large patches add to the splat. */
  patches: number;
}

/** SPEC-067: the hue patches' scale, in metres (*initial tuning*)… */
export const MACRO_HUE_METRES = 46;
/** …the light and dark patches'… */
export const MACRO_VALUE_METRES = 15;
/** …and layer B's patches' — cracked-earth flats, ice sheets, mud. */
export const MACRO_PATCH_METRES = 30;

const scratchNormal = { x: 0, y: 1, z: 0 };

/** GLSL's `smoothstep`, edges in either order. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** §4.6: the canopies bucketed by 16 m cell — each in every cell its disc reaches. */
function canopyBuckets(shade: TerrainShade): Map<number, number[]> {
  const buckets = new Map<number, number[]>();
  shade.canopies.forEach((canopy, index) => {
    const x0 = Math.floor((canopy.x - canopy.r) / SHADE_CELL);
    const x1 = Math.floor((canopy.x + canopy.r) / SHADE_CELL);
    const z0 = Math.floor((canopy.z - canopy.r) / SHADE_CELL);
    const z1 = Math.floor((canopy.z + canopy.r) / SHADE_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const key = (cx + 0x8000) * 0x10000 + (cz + 0x8000);
        let bucket = buckets.get(key);
        if (bucket === undefined) {
          bucket = [];
          buckets.set(key, bucket);
        }
        bucket.push(index);
      }
    }
  });
  return buckets;
}

/**
 * §4.6: the strongest `smoothstep(r, 0.3 r, d)` over the canopies whose disc
 * holds (x, z) — 1 within 0.3 of a radius, 0 at the rim.
 */
function canopyCover(shade: TerrainShade, buckets: Map<number, number[]>, x: number, z: number): number {
  const bucket = buckets.get((Math.floor(x / SHADE_CELL) + 0x8000) * 0x10000 + (Math.floor(z / SHADE_CELL) + 0x8000));
  if (bucket === undefined) return 0;
  let strongest = 0;
  for (let i = 0; i < bucket.length; i++) {
    const canopy = shade.canopies[bucket[i] as number] as TerrainShade['canopies'][number];
    const d = Math.hypot(x - canopy.x, z - canopy.z);
    if (d >= canopy.r) continue;
    const s = smoothstep(canopy.r, 0.3 * canopy.r, d);
    if (s > strongest) strongest = s;
  }
  return strongest;
}

/** SPEC-067: an sRGB hue in linear space, scaled to luminance 1 — a multiplier that shifts hue, not value. */
function unitHue(color: string): THREE.Color {
  const hue = new THREE.Color(color);
  const luminance = 0.2126 * hue.r + 0.7152 * hue.g + 0.0722 * hue.b;
  return luminance > 0 ? hue.multiplyScalar(1 / luminance) : hue.setScalar(1);
}

/**
 * SPEC-067, pure: the macro field at (x, z) — the hue mix into `out` (a
 * multiplier around 1) and the value factor as the return. Allocates nothing.
 */
export function macroTintAt(
  macro: TerrainMacro,
  hueA: THREE.Color,
  hueB: THREE.Color,
  x: number,
  z: number,
  out: THREE.Color,
): number {
  const h = smoothstep(-0.3, 0.3, fbm2(macro.seed, x / MACRO_HUE_METRES, z / MACRO_HUE_METRES, 3));
  const k = macro.strength;
  out.r = 1 + (hueA.r + (hueB.r - hueA.r) * h - 1) * k;
  out.g = 1 + (hueA.g + (hueB.g - hueA.g) * h - 1) * k;
  out.b = 1 + (hueA.b + (hueB.b - hueA.b) * h - 1) * k;
  const v = Math.min(1, Math.max(-1, 1.8 * fbm2(macro.seed + 1, x / MACRO_VALUE_METRES, z / MACRO_VALUE_METRES, 3)));
  return 1 + macro.value * v;
}

/** SPEC-067, pure: how much layer B the large patches add at (x, z), 0..`macro.patches`. */
export function macroPatchAt(macro: TerrainMacro, x: number, z: number): number {
  return macro.patches * smoothstep(0.06, 0.3, fbm2(macro.seed + 2, x / MACRO_PATCH_METRES, z / MACRO_PATCH_METRES, 3));
}

const scratchHue = new THREE.Color();

/**
 * All tiles covering the field's square, vertices in world space with the mesh
 * at the origin — bounding spheres still cull, and border vertices land on the
 * same grid nodes from both sides. SPEC-053 §4.6: with `shade`, each vertex's
 * tint is multiplied by `1 − CANOPY_SHADE × s` for the canopies over it.
 * PLAN R28 / SPEC-067: with `macro`, the tint also takes the hue and value
 * patches, and the splat layer B's large patches — the same at every border.
 */
export function buildTerrainTiles(
  field: HeightField,
  material: THREE.Material,
  shade?: TerrainShade,
  macro?: TerrainMacro,
): THREE.Mesh[] {
  const side = (field.n - 1) * field.cell;
  const tiles = Math.ceil(side / TERRAIN_TILE);
  const meshes: THREE.Mesh[] = [];
  const buckets = shade === undefined || shade.canopies.length === 0 ? null : canopyBuckets(shade);
  const hueA = macro === undefined ? null : unitHue(macro.hues[0]);
  const hueB = macro === undefined ? null : unitHue(macro.hues[1]);

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
        let tint = (1 + (0.72 - 1) * occlusion) * (1 + (1.06 - 1) * flat);
        if (shade !== undefined && buckets !== null) tint *= 1 - CANOPY_SHADE * canopyCover(shade, buckets, x, z);
        let splat = field.splat[at] as number;
        if (macro !== undefined && hueA !== null && hueB !== null) {
          tint *= macroTintAt(macro, hueA, hueB, x, z, scratchHue);
          colors[i * 3] = tint * scratchHue.r;
          colors[i * 3 + 1] = tint * scratchHue.g;
          colors[i * 3 + 2] = tint * scratchHue.b;
          splat = Math.min(1, splat + macroPatchAt(macro, x, z));
        } else {
          colors[i * 3] = tint;
          colors[i * 3 + 1] = tint;
          colors[i * 3 + 2] = tint;
        }
        splats[i] = splat;
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
  /** SPEC-046 §4.5: 0 leaves the albedo alone, 1 multiplies it by `uMacroTint`. */
  uTintAmount: THREE.IUniform<number>;
  uCrackColor: THREE.IUniform<THREE.Color>;
  uTime: THREE.IUniform<number>;
  /** SPEC-053 §4.6: the micro normal — a flat 1 × 1 until `ground_detail` lands. */
  detailMap: THREE.IUniform<THREE.Texture>;
  /** Layer A's tile over `DETAIL_TILE_METRES`: the detail's repeat in layer A's UVs. */
  uDetailRatio: THREE.IUniform<number>;
  uDetailStrength: THREE.IUniform<number>;
  /** Layer A's tile in metres — UVs back to metres, for the seam. */
  uTileA: THREE.IUniform<number>;
  /** The seam's line (m along its axis) and how far past it both layers move (m). */
  uSeamAt: THREE.IUniform<number>;
  uSeamShift: THREE.IUniform<number>;
}

/** SPEC-053 §4.6: what a preset and a look ask the terrain to compile. */
export interface TerrainOptions {
  /** `medium` and `high`: the detail normal and the anti-tiling sample. */
  detail: boolean;
  /** Eden: past `at` along `axis` (default x), both layers' UVs move by `shift` metres. */
  seam?: { at: number; shift: number; axis?: 'x' | 'z' };
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
uniform float uTintAmount;
uniform vec3 uCrackColor;
varying float vSplat;
#ifdef TERRAIN_DETAIL
uniform sampler2D detailMap;
uniform float uDetailRatio;
uniform float uDetailStrength;
#endif
#ifdef TERRAIN_ANTITILE
const mat2 ANTI_ROTATION = mat2( ${Math.cos(ANTI_TILE_ANGLE).toFixed(8)}, ${Math.sin(ANTI_TILE_ANGLE).toFixed(8)}, ${(-Math.sin(ANTI_TILE_ANGLE)).toFixed(8)}, ${Math.cos(ANTI_TILE_ANGLE).toFixed(8)} );
#endif
#ifdef TERRAIN_SEAM
uniform float uTileA;
uniform float uSeamAt;
uniform float uSeamShift;
#endif
`;

const MAP_CHUNK = /* glsl */ `
vec2 terrainUv = vMapUv;
vec2 terrainNrUv = vNormalMapUv;
#ifdef TERRAIN_SEAM
#ifdef TERRAIN_SEAM_Z
if ( vMapUv.y * uTileA > uSeamAt ) {
#else
if ( vMapUv.x * uTileA > uSeamAt ) {
#endif
	terrainUv += uSeamShift / uTileA;
	terrainNrUv += uSeamShift / uTileA;
}
#endif
vec4 texA = texture2D( map, terrainUv );
vec4 texB = texture2D( mapB, terrainUv * uTileRatio );
vec3 macro = texture2D( map, terrainUv * uMacroScale ).rgb;
#ifdef TERRAIN_ANTITILE
float antiTile = 0.5 * smoothstep( 0.35, 0.65, macro.g );
texA = mix( texA, texture2D( map, ANTI_ROTATION * terrainUv * ${ANTI_TILE_SCALE.toFixed(2)} ), antiTile );
#endif
float splatW = smoothstep( 0.3, 0.7, clamp( vSplat + ( 0.5 - texA.a ) * uHeightBlend, 0.0, 1.0 ) );
vec3 albedo = mix( texA.rgb, texB.rgb, splatW ) * mix( vec3( 1.0 ), macro * 2.0, 0.35 ) * mix( vec3( 1.0 ), uMacroTint, uTintAmount );
diffuseColor.rgb *= albedo;
`;

const ROUGHNESS_CHUNK = /* glsl */ `
float roughnessFactor = roughness;
vec4 nrA = texture2D( normalMap, terrainNrUv );
#ifdef TERRAIN_ANTITILE
nrA = mix( nrA, texture2D( normalMap, ANTI_ROTATION * terrainNrUv * ${ANTI_TILE_SCALE.toFixed(2)} ), antiTile );
#endif
vec4 nrB = texture2D( normalMapB, terrainNrUv * uTileRatio );
roughnessFactor *= mix( nrA.a, nrB.a, splatW );
`;

const NORMAL_CHUNK = /* glsl */ `
vec3 mapN = mix( nrA.xyz, nrB.xyz, splatW ) * 2.0 - 1.0;
mapN.xy *= normalScale;
#ifdef TERRAIN_DETAIL
vec3 detailN = texture2D( detailMap, terrainNrUv * uDetailRatio ).xyz * 2.0 - 1.0;
mapN.xy += detailN.xy * uDetailStrength;
#endif
normal = normalize( tbn * mapN );
`;

/**
 * SPEC-053 §4.6: the detail map until `ground_detail` lands — one flat texel
 * (128, 128, 255, 128), shared by every terrain and never disposed.
 */
let flatDetail: THREE.DataTexture | null = null;

function flatDetailTexture(): THREE.DataTexture {
  if (flatDetail !== null) return flatDetail;
  flatDetail = new THREE.DataTexture(new Uint8Array([128, 128, 255, 128]), 1, 1, THREE.RGBAFormat);
  flatDetail.needsUpdate = true;
  flatDetail.userData['shared'] = true;
  return flatDetail;
}

const EMISSIVE_CHUNK = /* glsl */ `
float crack = smoothstep( 0.55, 0.9, texB.a ) * splatW;
totalEmissiveRadiance += uCrackColor * crack * ( 0.8 + 0.2 * sin( uTime * 0.7 + vMapUv.x * 0.9 ) );
`;

/**
 * `palette.ground` in linear space, scaled to luminance 1 then capped at
 * channel ≤ 1: the hue pulls toward the planet without pushing a bright
 * palette's albedo past 1, which blew Vetra's snow out to a white field
 * (*initial tuning*).
 */
function macroTint(ground: string): THREE.Color {
  const color = new THREE.Color(ground).convertSRGBToLinear();
  const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  if (luminance > 0) color.multiplyScalar(1 / luminance);
  else color.setScalar(1);
  const max = Math.max(color.r, color.g, color.b);
  if (max > 1) color.multiplyScalar(1 / max);
  return color;
}

export function createTerrainMaterial(
  a: GroundLayer,
  b: GroundLayer,
  look: SurfaceLook,
  palette: { ground: string },
  options?: TerrainOptions,
): THREE.MeshStandardMaterial {
  const cracks = look.ground.cracks;
  const detail = options?.detail === true;
  const seam = options?.seam;
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
    // A uniform, not a define: the program key stays `terrain/1…`.
    uTintAmount: { value: look.ground.tint ?? TERRAIN_TINT_AMOUNT },
    uCrackColor: {
      value: cracks === undefined ? new THREE.Color(0, 0, 0) : new THREE.Color(cracks.color).multiplyScalar(cracks.intensity),
    },
    uTime: { value: 0 },
    detailMap: { value: flatDetailTexture() },
    uDetailRatio: { value: a.tileMetres / DETAIL_TILE_METRES },
    uDetailStrength: { value: DETAIL_STRENGTH },
    uTileA: { value: a.tileMetres },
    uSeamAt: { value: seam?.at ?? 0 },
    uSeamShift: { value: seam?.shift ?? 0 },
  };
  material.userData['terrainUniforms'] = uniforms;
  // SPEC-053 §4.6: detail and anti-tiling on `medium` and `high`; the seam on
  // every preset. Added to the material's own (`STANDARD`), never replacing them.
  const defines: Record<string, unknown> = { ...material.defines };
  if (detail) {
    defines['TERRAIN_DETAIL'] = '';
    defines['TERRAIN_ANTITILE'] = '';
  }
  if (seam !== undefined) {
    defines['TERRAIN_SEAM'] = '';
    if (seam.axis === 'z') defines['TERRAIN_SEAM_Z'] = '';
  }
  material.defines = defines;

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
  const key = `terrain/${detail ? '2+detail' : '1'}${cracks !== undefined ? '+cracks' : ''}${
    seam === undefined ? '' : seam.axis === 'z' ? '+seam-z' : '+seam'
  }`;
  material.customProgramCacheKey = () => key;
  return material;
}

/**
 * SPEC-053 §4.6, 53-i: `ground_detail` landed — swap it in through the
 * uniform, so nothing recompiles. The ground repeats it, so it wraps.
 */
export function setGroundDetail(material: THREE.MeshStandardMaterial, detail: THREE.Texture): void {
  if (detail.wrapS !== THREE.RepeatWrapping || detail.wrapT !== THREE.RepeatWrapping) {
    detail.wrapS = THREE.RepeatWrapping;
    detail.wrapT = THREE.RepeatWrapping;
    detail.needsUpdate = true;
  }
  terrainUniforms(material).detailMap.value = detail;
}

/**
 * Swap both layers in place — same defines, so no shader recompile: the maps
 * stay set, only which texture object each slot points at changes (§4.10).
 * The tint amount is the planet's, not the layers', so it stays (SPEC-046).
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
  uniforms.uTileA.value = a.tileMetres;
  uniforms.uDetailRatio.value = a.tileMetres / DETAIL_TILE_METRES;
}
