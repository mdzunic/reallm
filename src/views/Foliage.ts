// The foliage seam's materials (SPEC-053 §4.1): the trees, the undergrowth and
// the ground cover draw SPEC-052's leaf-and-grass atlas on a Lambert material
// whose `onBeforeCompile` adds three things the stock shader lacks.
//
// * Wind. The vertex shader sways every vertex by the square of its height in
//   the unit model, so a trunk's base stands still and the crown moves most.
// * A dithered fade. Alpha-tested leaves cannot be sorted, so a canopy that
//   thins over an enemy (E82) keeps `transparent: false` and its depth, and
//   throws away pixels on a 4 × 4 ordered dither instead: one comparison a
//   fragment. `bayer4` below is its pure twin, so the shader and the tests agree.
// * A cut-out. Every tree fragment nearer the camera than the salvager's head,
//   within `CUTOUT_RADIUS` of it on screen, is discarded on the same dither —
//   the salvager is visible under any canopy (§4.1.2).
//
// Glow parts keep SPEC-046's glow material, and the cover material has neither
// the fade nor the cut-out: ground clumps stand below the head.
import * as THREE from 'three';

/** The tree contract's trunk radius at the unit canopy: a tree draws at `radius / TRUNK_UNIT_RADIUS`. */
export const TRUNK_UNIT_RADIUS = 0.14;
/** Model units of sway at the crown top, × `look.foliage.wind` (*initial tuning*). */
export const WIND_SWAY = 0.025;
/** Metres around the salvager's head the canopy opens, projected (*initial tuning*). */
export const CUTOUT_RADIUS = 1.6;
/** The salvager's head, in metres above `heightAt`. */
export const CUTOUT_HEAD_LIFT = 1.6;
/** E82: what a canopy over an enemy or a pickup thins to, … */
export const CANOPY_FADE = 0.35;
/** …within this many metres of the player, … */
export const CANOPY_FADE_RANGE = 25;
/** …over this long, each way. */
export const CANOPY_FADE_SECONDS = 0.2;
/** The 4 × 4 Bayer index matrix, row-major (row = y mod 4, column = x mod 4). */
export const BAYER4: readonly number[] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** §4.1: the atlas's alpha test — the cards' cut-out edge. */
const ALPHA_TEST = 0.45;
/** The model height the sway reaches full strength at: the tallest crown's top. */
const SWAY_HEIGHT = 2.4;
/** The dither's side: a 4 × 4 ordered matrix. */
const BAYER_SIZE = 4;
/** SPEC-052 §3.3: 4 × 4 cells of 128 px with 4 px gutters — the gutter as a share of a cell. */
const ATLAS_GRID = 4;
const CELL_INSET = 4 / 128;

/**
 * The foliage seam's material type. SPEC-053 §4.1 draws leaves and grass with
 * Lambert, not three's standard material: an alpha-tested atlas over a large
 * share of the screen, lit cheaply. This module is the one place it is built.
 */
export type FoliageMaterial = THREE.MeshLambertMaterial;

export interface FoliageUniforms {
  uWind: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  /** x, y: window px, origin bottom-left; z: radius px; w: window depth of the head (0 = off). */
  uCutout: THREE.IUniform<THREE.Vector4>;
}

/** The uniform record `createFoliageMaterial` / `createCoverMaterial` park on `userData`. */
export function foliageUniforms(material: THREE.Material): FoliageUniforms {
  return material.userData['foliageUniforms'] as FoliageUniforms;
}

/**
 * Pure: the 4 × 4 Bayer threshold in [0, 1) for a pixel —
 * `BAYER4[(floor(y) mod 4) × 4 + (floor(x) mod 4)] / 16`, the modulo
 * non-negative so negative pixels wrap.
 */
export function bayer4(x: number, y: number): number {
  const column = ((Math.floor(x) % BAYER_SIZE) + BAYER_SIZE) % BAYER_SIZE;
  const row = ((Math.floor(y) % BAYER_SIZE) + BAYER_SIZE) % BAYER_SIZE;
  return (BAYER4[row * BAYER_SIZE + column] as number) / 16;
}

const scratchHead = new THREE.Vector3();

/**
 * Pure and allocation-free (§4.1.2): writes the cut-out uniform for a head at
 * world `head`, seen by `camera`, into `out`, for a draw target of
 * `width × height` device pixels, and returns `out`.
 * x = (ndc.x + 1) / 2 × width; y = (ndc.y + 1) / 2 × height;
 * z = CUTOUT_RADIUS × camera.projectionMatrix.elements[5] × height / (2 × depth); w = ndc.z × 0.5 + 0.5;
 * `depth` is the head's distance in front of the camera along its view axis.
 * Writes (0, 0, 0, 0) when depth ≤ camera.near.
 */
export function cutoutUniform(
  camera: THREE.PerspectiveCamera,
  head: THREE.Vector3,
  width: number,
  height: number,
  out: THREE.Vector4,
): THREE.Vector4 {
  const view = scratchHead.copy(head).applyMatrix4(camera.matrixWorldInverse);
  const depth = -view.z;
  if (!(depth > camera.near)) return out.set(0, 0, 0, 0);
  const ndc = view.applyMatrix4(camera.projectionMatrix);
  out.x = ((ndc.x + 1) / 2) * width;
  out.y = ((ndc.y + 1) / 2) * height;
  out.z = (CUTOUT_RADIUS * (camera.projectionMatrix.elements[5] as number) * height) / (2 * depth);
  out.w = ndc.z * 0.5 + 0.5;
  return out;
}

// ------------------------------------------------------------------ shaders

/** §4.1: the sway — by the square of the unit height, phased by where the instance stands. */
const WIND_VERTEX = /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
	float windPhase = dot( instanceMatrix[ 3 ].xz, vec2( 0.37, 0.61 ) );
#else
	float windPhase = 0.0;
#endif
	transformed.xz += uWind * pow( clamp( position.y / ${SWAY_HEIGHT.toFixed(1)}, 0.0, 1.0 ), 2.0 ) * vec2( sin( uTime * 1.3 + windPhase ), cos( uTime * 1.1 + 1.7 * windPhase ) );`;

/** §4.1.1: the GLSL twin of `bayer4`, from the same table in the same order. */
const BAYER_GLSL = /* glsl */ `
const float BAYER4[ 16 ] = float[ 16 ]( ${BAYER4.map((value) => value.toFixed(1)).join(', ')} );
float bayer4( vec2 p ) {
	vec2 cell = mod( floor( p ), 4.0 );
	return BAYER4[ int( cell.y ) * 4 + int( cell.x ) ] / 16.0;
}`;

/** §4.1.1, §4.1.2: the dither above the instance's fade, then the cut-out on the same threshold. */
const DITHER_FRAGMENT = /* glsl */ `#include <alphatest_fragment>
	float ditherD = bayer4( gl_FragCoord.xy );
	if ( ditherD >= vFade ) discard;
	if ( gl_FragCoord.z < uCutout.w && distance( gl_FragCoord.xy, uCutout.xy ) < uCutout.z * ( 0.75 + 0.25 * ditherD ) ) discard;`;

/**
 * Both faces of a card light by its authored normal: SPEC-052 bends the
 * leaves' normals out of the canopy and the clumps' point up, and three's
 * double-sided flip would turn every card seen from behind dark.
 */
const TWO_SIDED_NORMAL = /* glsl */ `#include <normal_fragment_begin>
#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
	normal = normalize( vNormal );
#endif`;

/** The atlas samples with v down from the top-left, as glTF does (SPEC-052 §3.3). */
function useAtlas(atlas: THREE.Texture): void {
  if (atlas.flipY) {
    atlas.flipY = false;
    atlas.needsUpdate = true;
  }
}

function makeUniforms(): FoliageUniforms {
  return { uWind: { value: 0 }, uTime: { value: 0 }, uCutout: { value: new THREE.Vector4(0, 0, 0, 0) } };
}

/**
 * `#foliageMaterial` (§4.1): the atlas, alpha-tested, double-sided, coloured by
 * the model's vertex colours and `tint` — opaque and in the depth buffer at
 * every fade. Every mesh drawing it is a `CulledInstances` layer with fades.
 */
export function createFoliageMaterial(atlas: THREE.Texture, tint: string): FoliageMaterial {
  useAtlas(atlas);
  const material = new THREE.MeshLambertMaterial({
    map: atlas,
    color: tint,
    alphaTest: ALPHA_TEST,
    side: THREE.DoubleSide,
    vertexColors: true,
    transparent: false,
    depthWrite: true,
  });
  const uniforms = makeUniforms();
  material.userData['foliageUniforms'] = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uWind;\nuniform float uTime;\nattribute float instanceFade;\nvarying float vFade;',
      )
      .replace('#include <begin_vertex>', `${WIND_VERTEX}\n\tvFade = instanceFade;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec4 uCutout;\nvarying float vFade;${BAYER_GLSL}`)
      .replace('#include <alphatest_fragment>', DITHER_FRAGMENT)
      .replace('#include <normal_fragment_begin>', TWO_SIDED_NORMAL);
  };
  material.customProgramCacheKey = () => 'foliage/1';
  return material;
}

/**
 * The cover material (§4.1, §4.5): the same atlas and sway, the cell index an
 * instanced `uvCell` attribute mapped to that cell's rectangle. No fade, no
 * dither and no cut-out — undergrowth and ground cover draw on it.
 */
export function createCoverMaterial(atlas: THREE.Texture): FoliageMaterial {
  useAtlas(atlas);
  const material = new THREE.MeshLambertMaterial({
    map: atlas,
    alphaTest: ALPHA_TEST,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  const uniforms = makeUniforms();
  material.userData['foliageUniforms'] = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWind;\nuniform float uTime;\nattribute float uvCell;')
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
#ifdef USE_MAP
	float coverCell = floor( uvCell + 0.5 );
	vec2 cellOrigin = vec2( mod( coverCell, ${ATLAS_GRID.toFixed(1)} ), floor( coverCell / ${ATLAS_GRID.toFixed(1)} ) );
	vMapUv = ( cellOrigin + ${CELL_INSET} + uv * ( 1.0 - ${(2 * CELL_INSET).toFixed(4)} ) ) / ${ATLAS_GRID.toFixed(1)};
#endif`,
      )
      .replace('#include <begin_vertex>', WIND_VERTEX);
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', TWO_SIDED_NORMAL);
  };
  material.customProgramCacheKey = () => 'cover/1';
  return material;
}
