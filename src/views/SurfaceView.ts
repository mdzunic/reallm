// The surface world view (SPEC-012 §4.10, SPEC-018) — entity → mesh, read-only
// over the frame the scene hands in. SPEC-018 gives it the environment: the
// shared height field, textured splat terrain tiles, sculpted props and POIs,
// deterministic scatter and decals, the berm-and-silhouette boundary, storm
// sprites and the weather grade. Budget (§4.11, medium): ≤ 80 scene draws,
// ≤ 120 k triangles.
//
// The simulation stays on y = 0 (SPEC-012 §2): every height here is visual,
// sampled from `field.heightAt` — the one sampler the tiles, entities, scatter
// and boundary all share, so nothing ever floats or clips a seam.
//
// SPEC-053 adds the foliage: trees drawn through the seam on
// `#foliageMaterial` (wind, the dither, the head cut-out, LOD by preset, and
// canopies that thin over enemies and pickups), undergrowth, streamed ground
// cover, contact shadows, landmark models, and a ground with detail, shade
// under the canopies and Eden's seam.
import * as THREE from 'three';
import { disposeObject3D } from '@/core/Disposer';
import type { Assets } from '@/core/Assets';
import { buildHeightField, type HeightField } from '@/core/HeightField';
import { log } from '@/core/Log';
import { hash01 } from '@/core/Noise';
import { hash32 } from '@/core/Rng';
import type { Look, QualityPreset, QualitySettings } from '@/core/Quality';
import type { Pool } from '@/core/Pool';
import type { ModelId } from '@/data/assets';
import type { DarkLook, PlanetDef, ResourceId } from '@/data/index';
import { isBuried, type EnemyEntity } from '@/entities/Enemy';
import type { FollowerEntity } from '@/entities/Follower';
import type { PlayerEntity } from '@/entities/Player';
import type { ProjectileEntity } from '@/entities/Projectile';
import type { TelegraphEntity } from '@/entities/Telegraph';
import { DEPLOYABLE_CAPACITY, type DeployableEntity } from '@/entities/Deployable';
import { CharacterView } from '@/views/CharacterView';
import { CombatFx } from '@/views/CombatFx';
import { Flashlight, type FlashlightMode } from '@/views/Flashlight';
import { buildEnvironment, skyParamsFor } from '@/views/Environment';
import { FollowerView } from '@/views/FollowerView';
import { EnemyMeshes, INSTANCES_PER_PART } from '@/views/ProceduralMeshes';
import { ScavBody } from '@/views/ScavBody';
import { groundLayer, type GroundLayer } from '@/views/ProceduralTextures';
import { buildScatter, buildDecals } from '@/views/Scatter';
import { buildArenaWall } from '@/views/ArenaWall';
import {
  CANOPY_FADE,
  CANOPY_FADE_RANGE,
  CANOPY_FADE_SECONDS,
  CUTOUT_HEAD_LIFT,
  TRUNK_UNIT_RADIUS,
  WIND_SWAY,
  createCoverMaterial,
  createFoliageMaterial,
  cutoutUniform,
  foliageUniforms,
  type FoliageMaterial,
} from '@/views/Foliage';
import { GroundCover, crossedQuads } from '@/views/GroundCover';
import {
  CULL_REFRESH_DISTANCE,
  CulledInstances,
  InstanceGrid,
  cullMargin,
  extendByFrustum,
  frustumGroundCorners,
  viewRect,
  type CullMaster,
  type CullRect,
} from '@/views/InstanceCuller';
import {
  boundaryGeometry,
  foliageAtlas,
  foliageFromModel,
  isTreeContract,
  LANDMARK_FOOTPRINT,
  LANDMARK_MODELS,
  LANDMARK_SCALE,
  obstacleModelIds,
  ORCHARD_MODEL,
  poiGeometry,
  proceduralObstacle,
  propFromModel,
  shelterGeometry,
  variantIndex,
  type ObstacleKind,
  type PoiKind,
  type PropGeometry,
} from '@/views/SurfaceProps';
import { StormParticles, STORM_LOOK, type ParticleKind } from '@/views/StormParticles';
import { TelegraphView } from '@/views/TelegraphView';
import {
  buildTerrainTiles,
  createTerrainMaterial,
  setGroundDetail,
  setTerrainLayers,
  terrainUniforms,
  type TerrainOptions,
} from '@/views/TerrainMesh';

export type { ObstacleKind, PoiKind } from '@/views/SurfaceProps';
export type { ParticleKind } from '@/views/StormParticles';

// Structural mirrors of the `systems/` shapes this view reads. Views must not
// import `systems` (SPEC-001 §4), and the scene passes the real objects — the
// compiler checks the fit at the call site.
export interface ViewWeather {
  fogMult: number;
  particles: ParticleKind;
  /** 0..1; what drives the grade's vignette (SPEC-018 §4.9). */
  visibility: number;
}

/** What `setWeather` writes and the scene forwards to `renderer.setLook`. */
export interface ViewGrade {
  vignette: number;
  tint: [number, number, number];
  desaturate: number;
}

/** SPEC-053 §3: one placed grove, orchard or cluster, as the view reads it. */
export interface ViewFeature {
  kind: 'grove' | 'orchard' | 'cluster';
  x: number;
  z: number;
  radius: number;
  /** An orchard's half-extents along x and z. */
  halfW?: number;
  halfD?: number;
  pieces: number;
}

export interface ViewLayout {
  /** The pinned layout hash — the seed every decoration stream derives from. */
  hash: number;
  halfSize: number;
  /** `poi` and `instance` are the layout's own (SPEC-053: Eden's seam, a landmark's yaw). */
  pois: readonly { kind: PoiKind; x: number; z: number; radius: number; poi?: string; instance?: number }[];
  /** A `tree`'s radius is its trunk; `feature` names the grove, orchard or cluster that placed it (SPEC-053). */
  obstacles: readonly { x: number; z: number; radius: number; kind: ObstacleKind; feature?: ViewFeature['kind'] }[];
  nodes: readonly { resource: ResourceId; x: number; z: number }[];
  props: readonly { x: number; z: number; rot: number; scale: number; kind: string }[];
  /** SPEC-030: the placed shelters, in `layout.shelters` order. */
  shelters: readonly {
    kind: 'cave' | 'wreck';
    x: number;
    z: number;
    rx: number;
    rz: number;
    angle: number;
    gapAngle: number;
  }[];
  /** SPEC-053 §4.3: the placed features; absent reads as none. */
  features?: readonly ViewFeature[];
}

export interface ViewNode {
  resource: ResourceId;
  x: number;
  z: number;
  capacity: number;
  remaining: number;
  harvesting: boolean;
}

export interface ViewPickup {
  kind: 'resource' | 'item' | 'gear';
  x: number;
  z: number;
  seed: number;
  resource: ResourceId;
}

export interface SurfaceFrame {
  player: PlayerEntity;
  follower: FollowerEntity | null;
  enemies: Pool<EnemyEntity>;
  projectiles: Pool<ProjectileEntity>;
  /** SPEC-029 §4.12: mines and charges, drawn as one instanced mesh. */
  deployables: Pool<DeployableEntity>;
  pickups: Pool<ViewPickup>;
  nodes: readonly ViewNode[];
  /**
   * SPEC-038 §4.2: the ground telegraphs and the world clock they were stamped
   * on — not the view clock, which a held beat runs ahead of `world.time`.
   */
  telegraphs?: { pool: Pool<TelegraphEntity>; time: number };
  time: number;
  /** The rendered-frame delta; 0 while hit-stop freezes the view (SPEC-019 §4.7). */
  dt: number;
  /**
   * SPEC-053 §4.1.2: the camera that draws, and its draw target in device
   * pixels (`Math.round(size × dpr)` from `renderer.size`) — the space of
   * `gl_FragCoord`. The scene passes one preallocated object, rewritten each
   * frame; absent, the head cut-out is off.
   */
  screen?: { camera: THREE.PerspectiveCamera; width: number; height: number };
}

// ------------------------------------------------------------- SPEC-019 §4.7

/** One camera shake: amplitude decays to zero at `until` over `duration`. */
export interface ShakeState {
  amplitude: number;
  until: number;
  duration: number;
}

/**
 * SPEC-045 §4.3: `settings.cameraShake` as a 0…1 multiplier. Anything that is
 * not a positive number reads as 0 — the still camera, never a full one.
 */
function shakeScale(scale: number): number {
  return scale > 0 ? Math.min(1, scale) : 0;
}

/**
 * §4.7, pure so `tests/views/` can pin it: the decaying offset, deterministic
 * from view time, times `scale` (SPEC-045 §4.3, `settings.cameraShake`). At 0
 * it is exactly the zero vector — no `-0` from a negative sine (19-g).
 */
export function shakeOffset(shake: ShakeState, time: number, scale: number, out: THREE.Vector3): void {
  const k = shakeScale(scale);
  if (k === 0 || shake.duration <= 0 || time >= shake.until) {
    out.set(0, 0, 0);
    return;
  }
  const decay = Math.min(1, Math.max(0, (shake.until - time) / shake.duration));
  out.set(Math.sin(37 * time), 0, Math.cos(29 * time)).multiplyScalar(shake.amplitude * decay * k);
}

// ------------------------------------------------------------- SPEC-015 §9

/**
 * The walk bob (SPEC-015 §9): the camera rises and falls with the player's
 * stride, up to `amplitude` metres at `speedFull` and nothing at a standstill.
 * `frequency` is radians per second of view time, so it is two steps a second
 * at a walk.
 */
export const CAMERA_BOB = { amplitude: 0.035, frequency: 7.5, speedFull: 4 } as const;

/**
 * AC-41: how far the bob may move the camera this frame, times `scale`
 * (SPEC-045 §4.3, `settings.cameraShake`). At 0 it is exactly zero — not
 * "small", zero — so the whole term drops out.
 */
export function cameraBobAmplitude(speed: number, scale: number): number {
  const k = shakeScale(scale);
  if (k === 0) return 0;
  const safe = Number.isFinite(speed) ? Math.max(0, speed) : 0;
  return CAMERA_BOB.amplitude * Math.min(1, safe / CAMERA_BOB.speedFull) * k;
}

/**
 * The bob's Y offset at `time`. Applied to the camera position only, after the
 * frustum is captured — the same discipline `shakeOffset` follows, so spawn
 * culling and the aim ray are bit-identical whether it moves or not (§4.7).
 */
export function cameraBob(speed: number, time: number, scale: number): number {
  const amplitude = cameraBobAmplitude(speed, scale);
  return amplitude === 0 ? 0 : amplitude * Math.sin(time * CAMERA_BOB.frequency);
}

/** SPEC-012 §4.3: look-at bias, metres ahead of the player in the movement direction. */
export const LOOK_AHEAD = 2;
/**
 * How fast the look-ahead swings onto a new heading, or back onto a player who
 * stopped, per second (*initial tuning*). The player's velocity is a step — 0
 * to full speed in one update — so a bias that followed it directly turned the
 * camera the full 2 m on the first frame of a single tap of W and straight back
 * on the release.
 */
export const LOOK_AHEAD_RATE = 3;

/**
 * Walks `lead` toward the look-ahead of a player moving at `(vx, vz)` at
 * `1 − e^(−LOOK_AHEAD_RATE·dt)`, in place. Pure and allocation-free.
 */
export function stepLookAhead(lead: { x: number; z: number }, vx: number, vz: number, dt: number): void {
  const speed = Math.hypot(vx, vz);
  const tx = speed > 0.01 ? (vx / speed) * LOOK_AHEAD : 0;
  const tz = speed > 0.01 ? (vz / speed) * LOOK_AHEAD : 0;
  const k = 1 - Math.exp(-LOOK_AHEAD_RATE * dt);
  lead.x += (tx - lead.x) * k;
  lead.z += (tz - lead.z) * k;
}

/** How far the storm sheet's opacity swings either side of its mean (SPEC-015 §9). */
export const STORM_FLICKER = 0.12;
/** The sheet never goes fully opaque: the player has to be able to see (SPEC-012 §4.12). */
export const STORM_OPACITY_MAX = 0.85;

/**
 * AC-43: the storm overlay's opacity. `mean` is what the weather and the
 * shelter factor say it should be; the flicker is a symmetric term around it,
 * so the average over time *is* the mean — and under reduce motion the term is
 * dropped and the mean is what is drawn, with nothing left moving.
 */
export function stormOverlayOpacity(mean: number, time: number, reduceMotion: boolean): number {
  const base = Number.isFinite(mean) ? Math.min(STORM_OPACITY_MAX, Math.max(0, mean)) : 0;
  if (reduceMotion || base === 0) return base;
  // Two incommensurate sines, so the flicker never settles into a loop the eye
  // can follow; their mean is zero, which is what keeps `base` the mean.
  const flicker = (Math.sin(time * 5.3) + Math.sin(time * 8.7)) * 0.5;
  return Math.min(STORM_OPACITY_MAX, Math.max(0, base * (1 + STORM_FLICKER * flicker)));
}

/**
 * §4.7, pure: while `frames > 0` the previous view time is returned (frozen)
 * and a frame is consumed; otherwise the state tracks the world clock. The
 * fixed-step simulation never sees this (SPEC-002).
 */
export function advanceViewTime(state: { frames: number; time: number }, worldTime: number): number {
  if (state.frames > 0) {
    state.frames--;
    return state.time;
  }
  state.time = worldTime;
  return worldTime;
}

/** 19-h: the swatches a bare `?scene=surface` jump runs on. */
const DEFAULT_APPEARANCE = { primary: '#b7472a', secondary: '#2a3b4c' };
/** §4.4 / 19-k: the VFX pool's share of the preset's particle budget. */
const FX_CAPACITY_MAX = 512;
const FX_CAPACITY_PER_PARTICLE = 4;
/** SPEC-029 §4.6: the lob arc peaks at `min(4, 0.25 · distance)`. */
export const LOB_ARC_MAX = 4;
export const LOB_ARC_PER_METRE = 0.25;
/** SPEC-029 §4.12: deployable blink periods — armed mine, and a charge's last second. */
const MINE_BLINK_SECONDS = 0.5;
const CHARGE_BLINK_SECONDS = 0.25;
/** §4.5: projectile head/ghost instancing caps. */
const PROJECTILE_CAPACITY = 256;
const GHOST_CAPACITY = 512;
/** §4.5: the two trailing ghosts, seconds behind the head along −v. */
const GHOST_LAG_A = 0.03;
const GHOST_LAG_B = 0.06;
const GHOST_GAIN_A = 1.2;
const GHOST_GAIN_B = 0.6;

/** Node/pickup colours per resource; the scene reuses them for pickup sparkles. */
export const RESOURCE_COLORS: Record<ResourceId, string> = {
  oil: '#3a3a3a',
  wheat: '#e0c060',
  water: '#5ab8e8',
  lithium: '#c8b8ff',
};

// -------------------------------------------------------- SPEC-017 §4.5–§4.7

/** How far along the sun direction the key light sits, in metres (§4.1). */
const KEY_DISTANCE = 60;
/** Half-extent of the orthographic shadow camera — a little past the draw distance. */
const SHADOW_EXTENT = 34;
/** Blob-shadow opacity with no shadow map, and with one (§4.6). */
const BLOB_OPACITY_ALONE = 0.35;
const BLOB_OPACITY_WITH_MAP = 0.18;
/** Player, follower and every live enemy: 2 + the per-part instance cap = 66. */
const BLOB_CAPACITY = 2 + INSTANCES_PER_PART;

/** SPEC-027 §4.4 — the light pillar and the ground route (*initial tuning*). */
const PILLAR_HEIGHT = 14;
const ROUTE_CAPACITY = 48;
/** One marker every 2.5 m of the smoothed path, lifted clear of the ground. */
const ROUTE_SPACING = 2.5;
const ROUTE_LIFT = 0.05;
/** The travelling wave: periods per second, and the phase one marker adds. */
const ROUTE_WAVE_SPEED = 0.6;
const ROUTE_WAVE_STEP = 1 / 6;
/** How dark the trough of the wave gets; 1 is the marker's own brightness. */
const ROUTE_DIM = 0.45;
const BLOB_SCALE_PLAYER = 1.4;
const BLOB_SCALE_FOLLOWER = 1;
const BLOB_SCALE_ENEMY = 1.6;
const BLOB_SCALE_ELITE = 1.3;
/** How far the planet's fog colour pulls the grade off neutral (§4.1). */
const TINT_TOWARD_FOG = 0.08;
/** Projectile base colour: past 1, so the shots clear the bloom threshold (§4.7). */
const PROJECTILE_GAIN = 2.5;
/** Image-based lighting on the surface is a fill light, not the key (§4.4). */
const ENVIRONMENT_INTENSITY = 0.6;
/** §4.5: the cool rim's intensity on the surface. */
const RIM_INTENSITY = 0.6;
/** §4.5: the torch riding the player group — `PointLight(0xffc98a, 6, 14, 2)`. */
const TORCH_INTENSITY = 6;
const TORCH_DISTANCE = 14;
/** SPEC-054 §4.5: with the `fake` flashlight on below, the torch widens to this, over this many metres. */
const FAKE_TORCH_INTENSITY = 10;
const FAKE_TORCH_DISTANCE = 10;

/** SPEC-054 §4.4: what the view needs of the cave it shows below (`UndergroundView`). */
export interface CaveView {
  readonly root: THREE.Object3D;
  /** The dust motes, once per rendered frame. */
  sync(px: number, pz: number, time: number): void;
  /** The walls draw through SPEC-046's culling, from the camera the scene placed. */
  setView(targetX: number, targetZ: number, camDistance: number, fovDeg: number, aspect: number, frustum: THREE.Frustum): void;
}

// ------------------------------------------------------------ SPEC-018 §4.8

/** The silhouette ring band past the arena edge, in metres. */
const RING_INNER = 6;
const RING_OUTER = 28;
/** Ring instances spaced ≈ 12 m along the square boundary. */
const RING_SPACING = 12;
const RING_MIN = 80;
const RING_MAX = 140;
/** SPEC-012 §4.3 — the fixed camera the storm quads billboard toward. */
const CAMERA_PITCH = (55 * Math.PI) / 180;
const CAMERA_YAW = (45 * Math.PI) / 180;
/** §4.9: lightning rolls once per 2.5 s window, flashes ×4 for two frames. */
const LIGHTNING_WINDOW = 2.5;
const LIGHTNING_FLASH_SECONDS = 0.05;

const scratchMatrix = new THREE.Matrix4();
const scratchColor = new THREE.Color();
const scratchColor2 = new THREE.Color();
const scratchVector = new THREE.Vector3();
const scratchPosition2 = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale2 = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
/** §4.5: the two ghost taps — seconds behind the head, colour gain. */
const GHOST_TRAIL: readonly (readonly [number, number])[] = [
  [GHOST_LAG_A, GHOST_GAIN_A],
  [GHOST_LAG_B, GHOST_GAIN_B],
];

/**
 * AC-24: fill (0..1) → the node crystal's scale — height is the visible fill
 * readout, footprint shrinks with it. Pure, so the mapping pins in node.
 */
export function nodeCrystalScale(fill: number, out: { x: number; y: number; z: number }): void {
  out.x = 0.6 + fill * 0.6;
  out.y = 0.25 + fill * 1.1;
  out.z = 0.6 + fill * 0.6;
}

const scratchScale = { x: 0, y: 0, z: 0 };

/**
 * The blob-shadow falloff, 32 × 32 RGBA, computed in JS — deliberately not on a
 * canvas, so the whole view constructs inside a node test (§4.6).
 */
function radialAlpha(size = 32): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - centre, y - centre) / centre;
      // Smooth to nothing at the rim; no hard edge to give the trick away.
      const t = Math.min(1, Math.max(0, 1 - r));
      const at = (y * size + x) * 4;
      data[at] = 255;
      data[at + 1] = 255;
      data[at + 2] = 255;
      data[at + 3] = Math.round(255 * t * t * (3 - 2 * t));
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** `[1, 1, 1]` pulled `amount` of the way toward `colour`, in linear space. */
function tintToward(colour: THREE.Color, amount: number): [number, number, number] {
  return [1 + (colour.r - 1) * amount, 1 + (colour.g - 1) * amount, 1 + (colour.b - 1) * amount];
}

/** The §4.1 sun direction: degrees → a unit vector, y up. */
function sunDirection(sun: { azimuth: number; elevation: number }): { x: number; y: number; z: number } {
  const azimuth = (sun.azimuth * Math.PI) / 180;
  const elevation = (sun.elevation * Math.PI) / 180;
  return {
    x: Math.cos(elevation) * Math.sin(azimuth),
    y: Math.sin(elevation),
    z: Math.cos(elevation) * Math.cos(azimuth),
  };
}

/**
 * The nearest preset for the SPEC-018 scatter cap, from the settings object.
 * Exported since SPEC-015 AC-5: the thresholds are read off `maxParticles`, so
 * a retune of that row has to keep mapping each shipped preset to its own name
 * — which is a test, not a comment (`tests/views/surfaceView.test.ts`).
 */
export function presetOf(quality: QualitySettings): QualityPreset {
  return quality.maxParticles <= 60 ? 'low' : quality.maxParticles <= 150 ? 'medium' : 'high';
}

/** The fixed camera's orientation — the storm quads' billboard (§4.9). */
function cameraBillboard(): THREE.Quaternion {
  const eye = scratchVector.set(
    Math.cos(CAMERA_PITCH) * Math.sin(CAMERA_YAW),
    Math.sin(CAMERA_PITCH),
    Math.cos(CAMERA_PITCH) * Math.cos(CAMERA_YAW),
  );
  scratchMatrix.lookAt(eye, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
  return new THREE.Quaternion().setFromRotationMatrix(scratchMatrix);
}

// ------------------------------------------------- SPEC-035 §4.5 (occluders)

/** A prop that can hide the player, as the pure `occludes` test of §3 sees it. */
export interface OccluderProp {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
}

/** §4.5: a fade takes this long, each way. */
export const OCCLUDER_FADE_SECONDS = 0.2;

/**
 * SPEC-035 §4.5 — the per-instance opacity the prop material multiplies into
 * its alpha, exactly the way `EnemyMeshes` carries its per-instance emissive.
 *
 * While nothing is faded the material stays opaque and the alpha is ignored, so
 * a planet with no occluder pays nothing: the only cost of the fade is a
 * `transparent` / `depthWrite` flip on one shared material (§4.14).
 */
function injectInstanceFade(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute float instanceFade;\nvarying float vInstanceFade;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceFade = instanceFade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying float vInstanceFade;\n#include <common>')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vInstanceFade;');
  };
  material.customProgramCacheKey = () => 'prop-fade/1';
}

/**
 * 18-d: a procedural rock embeds half its radius, so its instance matrix is
 * lifted by `scale × ROCK_LIFT`; a GLB prop has its origin at its base and
 * takes no lift (§4.10).
 */
const ROCK_LIFT = 0.5;

/**
 * SPEC-046 §4.8: the parked tug — the boot set's ship model, scaled to sit on
 * the pad (*initial tuning*). Nose toward world +z, as the glTF faces.
 */
export const TUG_SCALE = 2.8;
/** The pad slab's top face above the ground (`SurfaceProps` builds it 0.4 m thick). */
const PAD_TOP = 0.4;
/** Mirrors `systems/Layout.TUG_RADIUS` — views must not import systems. */
export const TUG_FADE_RADIUS = 3.5;

// ------------------------------------------------------------- SPEC-053

/** §4.7: the contact shadows' opacity, under every obstacle, tree and landmark. */
export const CONTACT_OPACITY = 0.28;
/** §4.7: a contact shadow's radius — × an obstacle's radius, a tree's canopy, a landmark's footprint. */
const CONTACT_OBSTACLE = 1.4;
const CONTACT_TREE = 0.9;
const CONTACT_LANDMARK = 1.2;
/** §4.7: how far above the ground a contact shadow lies. */
const CONTACT_LIFT = 0.05;
/** §4.2: a `tree_small` prop draws at `prop.scale × 0.8`; every other small prop at × 0.5. */
const SMALL_TREE_SCALE = 0.8;
const SMALL_PROP_SCALE = 0.5;
/** E82: how often the canopy fade asks which trees hold an enemy or a pickup. */
const CANOPY_QUERY_SECONDS = 0.1;
/** §4.5: the cover's wind when the look gives the foliage none. */
const COVER_WIND = 0.6;
/** §4.4: an undergrowth clump — three quads crossed at 60°, 1.25 m across before its 0.8–1.6 scale. */
const UNDERGROWTH_WIDTH = 1.25;
const UNDERGROWTH_HEIGHT = 1;
const UNDERGROWTH_SCALE: readonly [number, number] = [0.8, 1.6];
/** §4.4: undergrowth keeps clear of obstacles + 0.4, POIs + 1, nodes + 1.5, shelters + 1 and the pad's 15 m… */
const UNDERGROWTH_OBSTACLE = 0.4;
const UNDERGROWTH_POI = 1;
const UNDERGROWTH_NODE = 1.5;
const UNDERGROWTH_SHELTER = 1;
const UNDERGROWTH_PAD = 15;
/** …grows within this share of a canopy's radius under a tree, and off the arena's outer 3 m. */
const UNDERGROWTH_CANOPY = 0.8;
const UNDERGROWTH_WALL = 3;

/** Triangles one instance of `geometry` draws. */
function trianglesOf(geometry: THREE.BufferGeometry): number {
  return (geometry.index?.count ?? (geometry.getAttribute('position') as THREE.BufferAttribute).count) / 3;
}

/** True when (x, z) lies inside the shelter's interior ellipse grown by `grow` (as `systems/Layout.insideShelter`). */
function insideShelter(shelter: ViewLayout['shelters'][number], x: number, z: number, grow: number): boolean {
  const dx = x - shelter.x;
  const dz = z - shelter.z;
  const cos = Math.cos(-shelter.angle);
  const sin = Math.sin(-shelter.angle);
  const u = dx * cos - dz * sin;
  const v = dx * sin + dz * cos;
  return (u / (shelter.rx + grow)) ** 2 + (v / (shelter.rz + grow)) ** 2 <= 1;
}

/** §4.6: the seam's line — its POI's instance 0, along its axis — or `null` for a look with none. */
function seamLine(layout: ViewLayout, look: PlanetDef['surface']['look']): number | null {
  const seam = look.ground.seam;
  if (seam === undefined) return null;
  const poi = layout.pois.find((entry) => entry.poi === seam.poi && (entry.instance ?? 0) === 0);
  if (poi === undefined) return null;
  return seam.axis === 'z' ? poi.z : poi.x;
}

/**
 * §4.4: the undergrowth, placed once — `openPer1000m2` across the arena and
 * `underPer1000m2` more within 0.8 of each canopy, deterministic from
 * `hash32(layout.hash, 'undergrowth')`, every second candidate dropped on
 * `low`, none inside an obstacle + 0.4 m, a POI + 1 m, a node + 1.5 m, a
 * shelter + 1 m or the pad's 15 m. Matrices, ± 8 % shades and atlas cells.
 */
function placeUndergrowth(
  layout: ViewLayout,
  field: HeightField,
  spec: NonNullable<PlanetDef['surface']['look']['undergrowth']>,
  preset: QualityPreset,
): { matrices: Float32Array; colors: Float32Array; cells: Float32Array; count: number } {
  const seed = hash32(layout.hash, 'undergrowth');
  const reach = layout.halfSize - UNDERGROWTH_WALL;
  const trees = layout.obstacles.filter((o) => o.kind === 'tree');
  const candidates: { x: number; z: number }[] = [];
  const open = Math.round((spec.openPer1000m2 * (2 * layout.halfSize) ** 2) / 1000);
  for (let i = 0; i < open; i++) {
    candidates.push({ x: (hash01(seed, i, 0) * 2 - 1) * reach, z: (hash01(seed, i, 1) * 2 - 1) * reach });
  }
  // Under the canopies: each tree's share of `underPer1000m2 × canopy area`,
  // carried so the total rounds once, each within 0.8 of its canopy radius.
  let owed = 0;
  let k = 0;
  for (const tree of trees) {
    const canopy = tree.radius / TRUNK_UNIT_RADIUS;
    owed += (spec.underPer1000m2 * Math.PI * canopy * canopy) / 1000;
    const within = UNDERGROWTH_CANOPY * canopy;
    for (; owed >= 0.5; owed -= 1, k++) {
      const d = within * Math.sqrt(hash01(seed, k, 5));
      const angle = hash01(seed, k, 6) * Math.PI * 2;
      candidates.push({ x: tree.x + Math.cos(angle) * d, z: tree.z + Math.sin(angle) * d });
    }
  }
  const matrices: number[] = [];
  const colors: number[] = [];
  const cells: number[] = [];
  candidates.forEach((at, i) => {
    if (preset === 'low' && i % 2 === 1) return;
    const { x, z } = at;
    if (Math.abs(x) > reach || Math.abs(z) > reach || Math.hypot(x, z) < UNDERGROWTH_PAD) return;
    if (layout.obstacles.some((o) => Math.hypot(x - o.x, z - o.z) < o.radius + UNDERGROWTH_OBSTACLE)) return;
    if (layout.pois.some((poi) => Math.hypot(x - poi.x, z - poi.z) < poi.radius + UNDERGROWTH_POI)) return;
    if (layout.nodes.some((node) => Math.hypot(x - node.x, z - node.z) < UNDERGROWTH_NODE)) return;
    if (layout.shelters.some((shelter) => insideShelter(shelter, x, z, UNDERGROWTH_SHELTER))) return;
    const scale = UNDERGROWTH_SCALE[0] + (UNDERGROWTH_SCALE[1] - UNDERGROWTH_SCALE[0]) * hash01(seed, i, 2);
    scratchQuat.setFromAxisAngle(Y_AXIS, hash01(seed, i, 3) * Math.PI * 2);
    scratchPosition2.set(x, field.heightAt(x, z), z);
    scratchScale2.setScalar(scale);
    scratchMatrix.compose(scratchPosition2, scratchQuat, scratchScale2);
    matrices.push(...scratchMatrix.elements);
    const shade = 0.92 + 0.16 * hash01(seed, i, 4);
    colors.push(shade, shade, shade);
    cells.push(spec.cells[Math.min(spec.cells.length - 1, Math.floor(hash01(seed, i, 7) * spec.cells.length))] as number);
  });
  return { matrices: new Float32Array(matrices), colors: new Float32Array(colors), cells: new Float32Array(cells), count: cells.length };
}

/** SPEC-035 §4.5 / SPEC-046 §4.6: one instance of a culled layer — `setPropModels` re-points it. */
interface InstanceTarget {
  readonly kind: 'instance';
  layer: CulledInstances | null;
  index: number;
}

/** A whole mesh that fades by swapping in a per-view clone of its material (a landmark, the tug). */
interface FadePart {
  readonly mesh: THREE.Mesh;
  readonly base: THREE.Material;
  faded: THREE.Material | null;
}

type OccluderTarget = InstanceTarget | { readonly kind: 'mesh'; readonly parts: readonly FadePart[] };

/** SPEC-046 §4.2: one instance of a prop kind — its obstacles first, then its small props. */
interface PropInstance {
  readonly x: number;
  readonly z: number;
  /** A tree's is `radius / TRUNK_UNIT_RADIUS` — its canopy's radius (SPEC-053 §4.2). */
  readonly scale: number;
  readonly rot: number;
  /** The layout's own kind string (`rock`, `rock_small`) — `variantIndex`'s key. */
  readonly layoutKind: string;
  /** Its place among `layoutKind`'s instances, in layout order. */
  readonly ordinal: number;
  readonly small: boolean;
  /** SPEC-053 §4.9: an orchard tree — `ORCHARD_MODEL`, never a hashed variant. */
  readonly orchard: boolean;
  /** Its SPEC-035 fade; created with the occluder candidate, pointed at a layer once one holds it. */
  readonly target: InstanceTarget;
}

/** One drawn layer of a kind: a body, its glow, and the kind instances it holds, by master index. */
interface PropLayer {
  readonly body: CulledInstances;
  readonly glow: CulledInstances | null;
  readonly members: readonly number[];
  /** SPEC-053 §4.1: a foliage layer's two geometries; the preset picks which one it draws. */
  readonly lods: { readonly body: THREE.BufferGeometry; readonly lod1: THREE.BufferGeometry } | null;
}

/** SPEC-053 §4.8: one landmark POI — its meshes, its occluder slot, and whether it draws its model yet. */
interface LandmarkEntry {
  readonly mesh: THREE.Mesh;
  glow: THREE.Mesh | null;
  readonly occluder: number;
  readonly yaw: number;
  fromModel: boolean;
}

/**
 * SPEC-040 §4.6 / SPEC-046 §4.2: one instanced prop or obstacle kind, as built
 * — what a late GLB set swaps into (`setPropModels`) and what `propSource`
 * reads.
 */
interface PropKind {
  readonly kind: ObstacleKind;
  readonly seed: number;
  /** `PROP_MODELS`' variants for this kind in this biome; empty when it has none. */
  readonly ids: readonly ModelId[];
  /** The variants that loaded as tree contracts — never drawable (SPEC-046 §4.1). */
  readonly undrawable: Set<ModelId>;
  readonly instances: readonly PropInstance[];
  /** 16 floats per instance, in `instances` order — what every layer of the kind draws. */
  readonly matrices: Float32Array;
  /** The matrices carry the procedural rock's lift (18-d), which a model's geometry gives back. */
  lifted: boolean;
  layers: PropLayer[];
  /** The kind draws from its models now. */
  fromModel: boolean;
}

/** The geometry's top, in its own units — how tall an occluder candidate stands. */
function topOf(geometry: THREE.BufferGeometry): number {
  geometry.computeBoundingBox();
  return geometry.boundingBox?.max.y ?? 1;
}

/** The geometry's bounding sphere — a culled layer's `localSphere`. */
function sphereOf(geometry: THREE.BufferGeometry): THREE.Sphere {
  geometry.computeBoundingSphere();
  return geometry.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 1);
}

/** The §4.7 glow accents per obstacle kind (colour, emissive intensity). */
function obstacleGlow(kind: ObstacleKind, biome: PlanetDef['biome'], accent: string): THREE.MeshStandardMaterial {
  let color = accent;
  let intensity = 1;
  if (kind === 'vent') {
    color = '#ff6a2a';
    intensity = 3;
  } else if (kind === 'spire') {
    intensity = biome === 'hive' ? 1.5 : 0.4;
  }
  return new THREE.MeshStandardMaterial({
    color: '#000000',
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
  });
}

export class SurfaceView {
  readonly #scene: THREE.Scene;
  readonly #root = new THREE.Group();
  /**
   * SPEC-054 §4.1: the view in three groups under the one root. The surface
   * environment — terrain, props, scatter, decals, POIs, shelters, nodes, the
   * wall, the boundary and the storm particles — hides below; the actors —
   * the player, enemies, shots, pickups, deployables, effects, telegraphs and
   * guidance — draw on every level; and the light rig (hemisphere, key, its
   * target, rim) is never hidden, so a level swap changes intensities only.
   */
  readonly #envRoot = new THREE.Group();
  readonly #actorRoot = new THREE.Group();
  readonly #lightRig = new THREE.Group();
  readonly enemies: EnemyMeshes;
  /** The planet's base grade; `SurfaceScene` forwards it on enter (§4.1). */
  readonly look: Readonly<Partial<Look>>;
  /** The shared height field every ground touch samples (SPEC-018 §4.2). */
  readonly field: HeightField;
  /** 18-j / AC: the scene mirrors `settings.reduceMotion` here — no lightning. */
  reduceMotion = false;

  readonly #baseFog: number;
  /**
   * SPEC-035 §4.4: linear, not exponential. Exponential fog has no near
   * distance, so it hazed the one thing the player has to see. `SurfaceScene`
   * owns the arithmetic (`surfaceFogRange`) and drives it through
   * `setFogRange` — views take numbers, never `systems/` imports.
   */
  #fog: THREE.Fog;
  /** The storm-lerped fog multiplier the scene feeds `surfaceFogRange`. */
  #fogMult = 1;

  /** §4.5: hemisphere fill, the look's sun as key (the caster), cool rim, torch. */
  readonly #key: THREE.DirectionalLight;
  readonly #keyTarget = new THREE.Object3D();
  readonly #hemi: THREE.HemisphereLight;
  readonly #hemiBase: number;
  /** SPEC-054 §4.4: the hemisphere's intensity on this level — the base above, the dark look's below. */
  #hemiLevel: number;
  /** The cool rim and the torch on the player group, kept for the level swap (SPEC-054 §4.4, §4.5). */
  readonly #rim: THREE.DirectionalLight;
  readonly #torch: THREE.PointLight;
  /** The planet's own colours and the key's intensity — what coming up puts back. */
  readonly #surfaceColors: { sky: string; fog: string; hemiSky: string; hemiGround: string; key: number };
  /** SPEC-054 §4.4: the level on show, the cave drawn below, and the dark look in force. */
  #level: 'surface' | 'underground' = 'surface';
  #cave: CaveView | null = null;
  #dark: DarkLook | null = null;
  /** SPEC-054 §4.5: the flashlight, built at a visit's first descent and kept until the view goes. */
  #flashlight: Flashlight | null = null;
  #flashlightLook: DarkLook['flashlight'] | null = null;
  #flashlightOn = false;
  readonly #sunDir: { x: number; y: number; z: number };
  readonly #palette: PlanetDef['surface']['palette'];
  readonly #lightningSeed: number;
  #environment: THREE.DataTexture | null = null;

  readonly #blobs: THREE.InstancedMesh;
  readonly #blobMaterial: THREE.MeshBasicMaterial;

  readonly #player: THREE.Group;
  readonly #playerMaterial: THREE.MeshStandardMaterial;
  /** SPEC-019 §4.1: the animated salvager; `null` keeps the capsule fallback. */
  #character: CharacterView | null = null;
  readonly #assets: Assets | undefined;
  /** SPEC-019 §4.8: built on the first frame that carries a follower. */
  #followerView: FollowerView | null = null;
  /** SPEC-048 §4.8: the scavenger bodies placed this visit — the pad's, then the echo's. */
  readonly #scavBodies: ScavBody[] = [];
  /** Whether the preset casts shadows — what a body placed mid-visit is built with. */
  #shadowsOn = false;
  readonly #biome: PlanetDef['biome'];
  /** The layout hash every variant pick derives from (SPEC-046 §4.2). */
  readonly #layoutHash: number;
  /** SPEC-040 §4.6: every instanced prop and obstacle kind, in build order. */
  readonly #propKinds: PropKind[] = [];
  /**
   * SPEC-046 §4.1: a GLB body draws its authored `COLOR_0` under white; a
   * procedural body (and a shelter body) keeps the planet's accent. Neither is
   * flat-shaded, both carry SPEC-035's fade, and they flip together.
   */
  readonly #glbMaterial: THREE.MeshStandardMaterial;
  readonly #accentMaterial: THREE.MeshStandardMaterial;

  // SPEC-046 §4.6 — every static instanced layer, drawn through compaction,
  // and the view they were last refreshed for.
  readonly #culled: CulledInstances[] = [];
  readonly #cullView = { x: 0, z: 0, distance: -1, fov: -1, aspect: -1, frustum: null as THREE.Frustum | null };
  readonly #cullRect: CullRect = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  /** The frustum's ground corners at the last refresh, and the ones `setView` was just handed. */
  readonly #cullCorners = new Float32Array(8);
  readonly #viewCorners = new Float32Array(8);
  /** A layer was built or rebuilt, or the shadow pad moved, since the last refresh. */
  #cullDirty = true;
  #cullMs = 0;
  /** `1 / tan(sun elevation)` while the shadow map is on — how far a metre of caster throws (§4.6). */
  #shadowReach = 0;
  readonly #sunSlope: number;

  /** SPEC-046 §4.8: the parked tug, when the ship model is in. */
  #tug: THREE.Object3D | null = null;
  readonly #tugMeshes: THREE.Mesh[] = [];
  readonly #arenaRing: THREE.Mesh;
  #fx: CombatFx;
  /** SPEC-038 §4.2: the ground telegraphs — at most three draws, none while the pool is empty. */
  readonly #telegraphs: TelegraphView;
  #fxCapacity: number;

  #groundMaterial: THREE.MeshStandardMaterial;
  readonly #padGlowMaterial: THREE.MeshStandardMaterial;
  readonly #pad: { x: number; z: number } | null;

  readonly #nodeCrystals: THREE.InstancedMesh;
  readonly #pickupMeshes: Record<'resource' | 'item' | 'gear', THREE.InstancedMesh>;
  readonly #projectileMesh: THREE.InstancedMesh;
  readonly #deployableMesh: THREE.InstancedMesh;
  readonly #ghostMesh: THREE.InstancedMesh;
  #storm: StormParticles;
  #stormCapacity: number;
  readonly #billboard: THREE.Quaternion;
  #particleKind: ParticleKind = 'none';
  #particleIntensity = 0;

  readonly #grade: ViewGrade = { vignette: 0, tint: [1, 1, 1], desaturate: 0 };

  // SPEC-035 §4.5 — occluder fading. `#occluders` is the candidate list the
  // scene tests with the pure `occludes`; the parallel arrays hold what each
  // candidate is (an instance of a culled layer, or whole meshes — a landmark,
  // the tug), whether it is occluding right now, and how far its fade has
  // travelled.
  readonly #occluders: OccluderProp[] = [];
  readonly #occluderTargets: OccluderTarget[] = [];
  #occluding: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  #occluderFade = new Float32Array(0);
  #occluderOpacity = 1;
  #fadedOccluders = 0;
  /** Both body materials are transparent only while something is faded. */
  #propsTransparent = false;

  // SPEC-030 §4.8–§4.9 — the arena wall and the shelters.
  #wall: THREE.Group | null = null;
  #wallChunks: THREE.InstancedMesh[] = [];
  #wallVisible = 0;
  /** Per shelter index: the roof instance to lift when occupied (§4.9), in its layer's master. */
  readonly #roofSlots: { layer: CulledInstances; slot: number }[] = [];
  readonly #roofMatrices: THREE.Matrix4[] = [];
  #occupiedShelter: number | null = null;
  #shelterMeshes: THREE.InstancedMesh[] = [];

  // SPEC-027 §4.4 — the guidance layer. Both meshes are built the first time
  // `setGuide` wants one and reused for the life of the view; the clock they
  // animate on is the frame time `sync()` last saw.
  #pillar: THREE.Mesh | null = null;
  #routeMarkers: THREE.InstancedMesh | null = null;
  #guideTime = 0;
  readonly #pillarMaterial = new THREE.MeshBasicMaterial({
    color: '#ffc857',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });
  readonly #routeMaterial = new THREE.MeshBasicMaterial({
    color: '#ffc857',
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  // SPEC-053 — the foliage seam, the ground beneath it, and the landmarks.
  readonly #layout: ViewLayout;
  readonly #look: PlanetDef['surface']['look'];
  /** The preset in force: trees' LOD, cover capacity, undergrowth and terrain detail follow it. */
  #preset: QualityPreset;
  /** `#foliageMaterial` and the cover material, built once the atlas is in. */
  #foliageMaterial: FoliageMaterial | null = null;
  #coverMaterial: FoliageMaterial | null = null;
  /** The `tree` kind, when the planet has any. */
  #trees: PropKind | null = null;
  /** E82, per tree instance in `#trees.instances` order: its fade, its target, and the grid that finds it. */
  #canopyFade = new Float32Array(0);
  #canopyTarget = new Float32Array(0);
  #canopyGrid: InstanceGrid | null = null;
  #canopyCandidates = new Int32Array(0);
  #canopyHeld = new Int32Array(0);
  #canopyHeldCount = 0;
  #canopyClock = CANOPY_QUERY_SECONDS;
  #canopyFaded = 0;
  readonly #canopyRect: CullRect = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  /** `WIND_SWAY × look.foliage.wind` (or the cover's 0.6), and what `sync` last wrote: 0 under reduce motion. */
  readonly #windAmplitude: number;
  #wind = 0;
  readonly #head = new THREE.Vector3();
  #undergrowth: CulledInstances | null = null;
  #cover: GroundCover | null = null;
  readonly #coverRect: CullRect = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  #contact: CulledInstances | null = null;
  readonly #landmarks: LandmarkEntry[] = [];
  readonly #landmarkMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, metalness: 0.05, vertexColors: true });
  #landmarkGlow: THREE.Material | null = null;
  /** The terrain's tiles and current layers, so a preset change can rebuild its material once (53-b). */
  readonly #tiles: THREE.Mesh[] = [];
  #groundLayers: { a: GroundLayer; b: GroundLayer };
  #groundDetail: THREE.Texture | null = null;
  readonly #seamAt: number | null;

  /**
   * The ground sampler handed to enemies and the storm — bound once (§4.3).
   * SPEC-054 §4.4: below, the cave is flat, so every sample reads 0.
   */
  readonly #ground = (x: number, z: number): number => (this.#flat ? 0 : this.field.heightAt(x, z));
  /** SPEC-054 §4.4: true while the cave is shown — heights read 0. */
  #flat = false;

  constructor(
    scene: THREE.Scene,
    layout: ViewLayout,
    planet: PlanetDef,
    quality: QualitySettings,
    assets?: Assets,
    appearance?: { primary: string; secondary: string },
  ) {
    this.#scene = scene;
    this.#assets = assets;
    this.#shadowsOn = quality.shadowMapSize > 0;
    this.#biome = planet.biome;
    this.#lightRig.name = 'surface-lights';
    this.#envRoot.name = 'surface-env';
    this.#actorRoot.name = 'surface-actors';
    this.#root.add(this.#lightRig, this.#envRoot, this.#actorRoot);
    scene.add(this.#root);
    const palette = planet.surface.palette;
    const look = planet.surface.look;
    this.#palette = palette;
    // SPEC-053: what the foliage, cover and terrain read again after the build.
    this.#layout = layout;
    this.#look = look;
    this.#preset = presetOf(quality);
    this.#windAmplitude = WIND_SWAY * (look.foliage?.wind ?? COVER_WIND);
    scene.background = new THREE.Color(palette.sky);
    this.#baseFog = planet.surface.fogDensity;
    // A placeholder span: `SurfaceScene` calls `setFogRange` before its first
    // render, and again whenever the storm or the camera distance moves.
    this.#fog = new THREE.Fog(palette.fog, 0, layout.halfSize * 2);
    scene.fog = this.#fog;
    this.#lightningSeed = hash32(layout.hash, 'lightning');
    this.#layoutHash = layout.hash;
    // SPEC-017 §4.1: the planet's own grade — a touch hotter and crisper than
    // the hubs, pulled 8 % toward its fog colour so each world reads different.
    this.look = {
      exposure: 1.05,
      contrast: 1.04,
      saturation: 1.05,
      // SPEC-035 §4.3: the shared 0.85 turned sunlit snow into a whiteout on
      // medium and high. The hubs keep the default; only daylight moves.
      bloomThreshold: 1.5,
      tint: tintToward(new THREE.Color(palette.fog), TINT_TOWARD_FOG),
    };

    // SPEC-018 §4.2: the height field, once per visit, from the layout hash.
    this.field = buildHeightField(
      { halfSize: layout.halfSize, hash: layout.hash, pois: layout.pois },
      look.relief,
    );

    // §4.5 / SPEC-018 §4.1: hemisphere and key from the planet's look; the cool
    // rim stays fixed. No ambient — `SurfaceScene` sets `ownsLighting`.
    this.#hemiBase = look.light.ambient;
    this.#hemiLevel = look.light.ambient;
    this.#surfaceColors = {
      sky: palette.sky,
      fog: palette.fog,
      hemiSky: look.light.sky,
      hemiGround: look.light.ground,
      key: look.light.sun.intensity,
    };
    this.#hemi = new THREE.HemisphereLight(look.light.sky, look.light.ground, look.light.ambient);
    this.#key = new THREE.DirectionalLight(look.light.sun.color, look.light.sun.intensity);
    this.#sunDir = sunDirection(look.light.sun);
    this.#sunSlope = 1 / Math.tan((Math.max(1, look.light.sun.elevation) * Math.PI) / 180);
    this.#key.position.set(this.#sunDir.x * KEY_DISTANCE, this.#sunDir.y * KEY_DISTANCE, this.#sunDir.z * KEY_DISTANCE);
    this.#key.target = this.#keyTarget;
    const rim = new THREE.DirectionalLight(0x7fa6ff, RIM_INTENSITY);
    rim.position.set(-30, 20, -24);
    this.#rim = rim;
    this.#lightRig.add(this.#hemi, this.#key, this.#keyTarget, rim);

    // SPEC-018 §4.3–§4.4: terrain tiles under one splat material. Procedural
    // layers first; the lazy asset drop swaps them through `setGroundTextures`.
    // SPEC-053 §4.6: detail on `medium` and `high`, Eden's seam on every
    // preset, and the shade under every canopy baked into the tiles once.
    const [layerAId, layerBId] = look.ground.layers;
    const a: GroundLayer = { ...groundLayer(layerAId), tileMetres: look.ground.tileMetres[0] };
    const b: GroundLayer = { ...groundLayer(layerBId), tileMetres: look.ground.tileMetres[1] };
    this.#groundLayers = { a, b };
    this.#seamAt = seamLine(layout, look);
    this.#groundMaterial = createTerrainMaterial(a, b, look, palette, this.#terrainOptions());
    const canopies: { x: number; z: number; r: number }[] = [];
    for (const o of layout.obstacles) if (o.kind === 'tree') canopies.push({ x: o.x, z: o.z, r: o.radius / TRUNK_UNIT_RADIUS });
    for (const tile of buildTerrainTiles(this.field, this.#groundMaterial, { canopies })) {
      this.#envRoot.add(tile);
      this.#tiles.push(tile);
    }
    if (assets?.hasTexture?.('ground_detail') === true) this.#setDetail(assets.texture('ground_detail'));

    // Obstacles and props: instanced per kind and variant (§4.10, SPEC-046
    // §4.2), sculpted per biome where no model is drawable (SPEC-018 §4.7),
    // glow parts as their own instanced meshes.
    this.#glbMaterial = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.85,
      metalness: 0.05,
      vertexColors: true,
    });
    this.#accentMaterial = new THREE.MeshStandardMaterial({
      color: palette.accent,
      roughness: 0.85,
      metalness: 0.05,
      vertexColors: true,
    });
    // SPEC-035 §4.5: the per-instance opacity the fade writes into, on both.
    injectInstanceFade(this.#glbMaterial);
    injectInstanceFade(this.#accentMaterial);
    // SPEC-053 §4.1: the trees' and the ground clumps' materials, once the atlas is in.
    const atlas = foliageAtlas(assets);
    if (atlas !== null) this.#makeFoliageMaterials(atlas);
    this.#buildProps(layout, assets);

    // POIs: one small sculpted mesh per instance (SPEC-018 §4.7); glow parts
    // share one emissive material, the pad ring its own pulsing one.
    const poiMaterial = new THREE.MeshStandardMaterial({
      color: palette.accent,
      roughness: 0.6,
      metalness: 0.3,
      vertexColors: true,
    });
    const poiGlowMaterial = new THREE.MeshStandardMaterial({
      color: '#000000',
      emissive: new THREE.Color(palette.accent),
      emissiveIntensity: 2,
    });
    this.#padGlowMaterial = new THREE.MeshStandardMaterial({
      color: '#000000',
      emissive: new THREE.Color('#8ad7ff'),
      emissiveIntensity: 1.2,
    });
    this.#landmarkGlow = poiGlowMaterial;
    let pad: { x: number; z: number } | null = null;
    const landmarkSeed = hash32(layout.hash, 'landmark');
    let landmarks = 0;
    for (const poi of layout.pois) {
      const prop = poiGeometry(poi.kind, planet.biome, assets);
      // SPEC-053 §4.8: an authored landmark draws in its own colours, at scale 1.
      const modelled = poi.kind === 'landmark' && prop.fromModel === true;
      const mesh = new THREE.Mesh(prop.body, modelled ? this.#landmarkMaterial : poiMaterial);
      mesh.name = `poi:${poi.kind}`;
      const h = this.field.heightAt(poi.x, poi.z); // ≈ 0 on flattened ground
      if (poi.kind === 'arena') mesh.scale.setScalar(poi.radius * 0.2);
      // SPEC-046 §4.3: a 1–3 m landmark read as nothing on its 6–7 m trigger.
      if (poi.kind === 'landmark' && !modelled) mesh.scale.setScalar(LANDMARK_SCALE * poi.radius);
      mesh.position.set(poi.x, h, poi.z);
      // SPEC-035 §4.5: only landmarks join the occluder list — every other POI
      // is something the player is being sent to and must be able to see.
      if (poi.kind === 'landmark') {
        // SPEC-053 §4.8: yawed by `hash01(hash32(layout.hash, 'landmark'), instance) × 2π`.
        const yaw = hash01(landmarkSeed, poi.instance ?? landmarks) * Math.PI * 2;
        landmarks++;
        if (modelled) mesh.rotation.y = yaw;
        this.#landmarks.push({ mesh, glow: null, occluder: this.#occluders.length, yaw, fromModel: modelled });
        this.#occluders.push({
          x: poi.x,
          z: poi.z,
          radius: poi.radius * 0.5,
          height: topOf(prop.body) * mesh.scale.y,
        });
        this.#occluderTargets.push({ kind: 'mesh', parts: [{ mesh, base: mesh.material as THREE.Material, faded: null }] });
      }
      // The pad is flat on the ground: its own shadow would only stripe it.
      mesh.castShadow = poi.kind !== 'landing_pad';
      mesh.receiveShadow = true;
      this.#envRoot.add(mesh);
      if (prop.glow !== undefined) {
        const glow = new THREE.Mesh(prop.glow, poi.kind === 'landing_pad' ? this.#padGlowMaterial : poiGlowMaterial);
        glow.name = `poi-glow:${poi.kind}`;
        glow.scale.copy(mesh.scale);
        glow.rotation.copy(mesh.rotation);
        glow.position.copy(mesh.position);
        this.#envRoot.add(glow);
        if (poi.kind === 'landmark') (this.#landmarks.at(-1) as LandmarkEntry).glow = glow;
      }
      if (poi.kind === 'landing_pad') pad = { x: poi.x, z: poi.z };
    }
    this.#pad = pad;
    // SPEC-053 §4.7: a contact shadow under every obstacle, tree and landmark.
    this.#buildContactShadows(layout);

    // SPEC-018 §4.6: scatter and decals, deterministic from the layout hash.
    // SPEC-046 §4.6: the scatter draws only what is on screen.
    for (const mesh of buildScatter(layout, this.field, look, presetOf(quality), palette)) {
      const total = mesh.count;
      const matrices = (mesh.instanceMatrix.array as Float32Array).slice(0, total * 16);
      const colors = mesh.instanceColor === null ? null : (mesh.instanceColor.array as Float32Array).slice(0, total * 3);
      this.#addCulled(mesh, colors === null ? { matrices } : { matrices, colors }, sphereOf(mesh.geometry));
    }
    this.#envRoot.add(buildDecals(layout, this.field, look));
    // SPEC-053 §4.4, §4.5: undergrowth and ground cover, on the atlas.
    this.#buildGroundClumps();

    // SPEC-018 §4.8: the silhouette ring past the berm hides the void.
    this.#buildBoundaryRing(layout, planet);

    // SPEC-030 §4.8: the arena wall, chunked for culling; §4.9: the shelters.
    const wall = buildArenaWall(layout, this.field, planet.surface.look);
    this.#wall = wall.group;
    this.#wallChunks = wall.chunks;
    this.#envRoot.add(wall.group);
    this.#buildShelters(layout, planet, assets);
    // SPEC-046 §4.8: the salvager's tug, parked on the pad.
    this.#buildTug(assets, quality.shadowMapSize > 0);

    // The arena lock ring — visible only while a boss fight seals the arena.
    this.#arenaRing = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.15, 6, 64),
      new THREE.MeshBasicMaterial({ color: '#ff5533' }),
    );
    this.#arenaRing.rotation.x = -Math.PI / 2;
    this.#arenaRing.position.y = 0.3;
    this.#arenaRing.visible = false;
    this.#envRoot.add(this.#arenaRing);

    // Nodes: crystals whose height shows the fill level (AC-24).
    const crystal = new THREE.OctahedronGeometry(0.7);
    crystal.translate(0, 0.7, 0);
    this.#nodeCrystals = new THREE.InstancedMesh(
      crystal,
      new THREE.MeshStandardMaterial({
        roughness: 0.25,
        metalness: 0.1,
        emissive: new THREE.Color(0x222233),
        emissiveIntensity: 0.4,
      }),
      Math.max(1, layout.nodes.length),
    );
    this.#nodeCrystals.receiveShadow = true;
    layout.nodes.forEach((node, i) => this.#nodeCrystals.setColorAt(i, scratchColor.set(RESOURCE_COLORS[node.resource])));
    this.#envRoot.add(this.#nodeCrystals);

    // Pickups: three instanced meshes (§4.10).
    const pickupMaterial = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.5 });
    this.#pickupMeshes = {
      resource: new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.28), pickupMaterial, 128),
      item: new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), pickupMaterial, 64),
      gear: new THREE.InstancedMesh(new THREE.ConeGeometry(0.3, 0.6, 4), pickupMaterial, 64),
    };
    for (const mesh of Object.values(this.#pickupMeshes)) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, scratchColor.set('#ffffff'));
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      this.#actorRoot.add(mesh);
    }

    // Projectiles (SPEC-019 §4.5): emissive capsules oriented along their
    // velocity, plus a second instanced mesh of trailing ghosts. The owner
    // colour is pushed × 2.5 through `instanceColor` (the material stays
    // white) so the product clears the bloom threshold; on `low` there is no
    // bloom and the clamp to white in the framebuffer is the whole effect.
    const capsule = new THREE.CapsuleGeometry(0.07, 1, 2, 6);
    capsule.rotateZ(-Math.PI / 2); // axis +X, so the velocity yaw orients it
    const shotMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.#projectileMesh = new THREE.InstancedMesh(capsule, shotMaterial, PROJECTILE_CAPACITY);
    this.#ghostMesh = new THREE.InstancedMesh(capsule, shotMaterial, GHOST_CAPACITY);
    for (const mesh of [this.#projectileMesh, this.#ghostMesh]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, scratchColor.set('#ffffff'));
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.#actorRoot.add(mesh);
    }

    // SPEC-029 §4.12: mines and charges — one instanced mesh, capacity 8, one
    // draw call. A mine is a 0.35 m disc-flat block, a charge a 0.3 m box;
    // the emissive centre blinks through `instanceColor` in #syncDeployables.
    this.#deployableMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: '#8a8378', emissive: new THREE.Color(0xff5533), emissiveIntensity: 0.35, roughness: 0.6, metalness: 0.3 }),
      DEPLOYABLE_CAPACITY,
    );
    this.#deployableMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#deployableMesh.setColorAt(0, scratchColor.set('#ffffff'));
    this.#deployableMesh.count = 0;
    this.#deployableMesh.frustumCulled = false;
    this.#deployableMesh.receiveShadow = true;
    this.#actorRoot.add(this.#deployableMesh);

    // SPEC-019 §4.4: the combat VFX pool, sized from the preset (19-k). Built
    // before the player group so its point light precedes the torch in
    // traversal order — instruments that walk the lights find the torch last.
    this.#billboard = cameraBillboard();
    this.#fxCapacity = Math.min(FX_CAPACITY_MAX, FX_CAPACITY_PER_PARTICLE * quality.maxParticles);
    this.#fx = new CombatFx(this.#actorRoot, this.#billboard, this.#fxCapacity);
    this.#telegraphs = new TelegraphView(this.#actorRoot);

    // The player: capsule body + nose cone showing facing. `transparent` stays
    // on so the invulnerability blink can keep writing `opacity` (§4.7).
    this.#playerMaterial = new THREE.MeshStandardMaterial({
      color: '#4a8ad0',
      transparent: true,
      roughness: 0.45,
      metalness: 0.35,
    });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 0.8, 3, 8), this.#playerMaterial);
    body.position.y = 0.9;
    body.castShadow = true;
    body.receiveShadow = true;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.6, 6), this.#playerMaterial);
    nose.rotation.z = -Math.PI / 2;
    nose.position.set(0.6, 0.9, 0);
    nose.castShadow = true;
    nose.receiveShadow = true;
    this.#player = new THREE.Group();
    this.#player.add(body, nose);
    // The torch rides the player group, so it moves without `sync()` touching it.
    const torch = new THREE.PointLight(0xffc98a, TORCH_INTENSITY, TORCH_DISTANCE, 2);
    torch.position.y = 1.6;
    this.#torch = torch;
    this.#player.add(torch);
    this.#actorRoot.add(this.#player);

    // SPEC-019 §4.1: the animated salvager replaces the capsule when the boot
    // assets are in. The player group stays — it carries the torch and is
    // positioned every frame — but the capsule and nose leave it; the
    // character root joins the view root so nothing is transformed twice.
    if (assets !== undefined && assets.loaded) {
      try {
        this.#character = new CharacterView(
          this.#actorRoot,
          assets,
          'character',
          appearance ?? DEFAULT_APPEARANCE,
          quality.shadowMapSize > 0,
        );
        this.#player.remove(body, nose);
        body.geometry.dispose();
        nose.geometry.dispose();
        this.#playerMaterial.dispose();
      } catch (cause) {
        log.warn('view', 'character model unavailable; the capsule stays', cause);
      }
    }

    // Storm sprites (SPEC-018 §4.9): instanced quads, camera-fixed billboard.
    this.#stormCapacity = quality.maxParticles;
    this.#storm = new StormParticles(this.#envRoot, this.#billboard, quality.maxParticles);

    // §4.6: one instanced blob layer on every preset — the thing that actually
    // grounds a character, at one draw call and one 32² texture. The shadow map
    // is a `high`-only luxury on top of it, and fades the blobs when it lands.
    const blobGeometry = new THREE.PlaneGeometry(1, 1);
    blobGeometry.rotateX(-Math.PI / 2);
    this.#blobMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: radialAlpha(),
      transparent: true,
      depthWrite: false,
      opacity: BLOB_OPACITY_ALONE,
    });
    this.#blobs = new THREE.InstancedMesh(blobGeometry, this.#blobMaterial, BLOB_CAPACITY);
    this.#blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#blobs.position.y = 0.02;
    this.#blobs.renderOrder = 1;
    this.#blobs.frustumCulled = false;
    this.#blobs.count = 0;
    this.#actorRoot.add(this.#blobs);

    this.enemies = new EnemyMeshes(this.#actorRoot, { shadows: quality.shadowMapSize > 0 });
    this.applyQuality(quality);
  }

  /** The weather grade the scene forwards through `renderer.setLook` (§4.9). */
  get grade(): Readonly<ViewGrade> {
    return this.#grade;
  }

  /**
   * §4.10: the lazy asset drop landed — swap the committed layers in without a
   * recompile (same defines, same program).
   */
  setGroundTextures(a: GroundLayer, b: GroundLayer): void {
    this.#groundLayers = { a, b };
    setTerrainLayers(this.#groundMaterial, a, b);
  }

  /**
   * SPEC-030 §4.9: shelters render as one `InstancedMesh` per kind and part —
   * cave body, cave roof, wreck body, wreck roof, and up to two glows — ≤ 6
   * draw calls (AC-40). Instances rotate so the geometry's canonical entrance
   * (local +x for a cave, local +z for a wreck's breach) lands on `gapAngle`.
   * SPEC-046 §4.6: each part draws through compaction; the body fades and the
   * roof lifts through the masters.
   */
  #buildShelters(layout: ViewLayout, planet: PlanetDef, assets?: Assets): void {
    const shelters = layout.shelters;
    this.#roofSlots.length = 0;
    this.#roofMatrices.length = 0;
    this.#shelterMeshes.length = 0;
    if (shelters.length === 0) return;
    // SPEC-046 §4.1: no flat shading; the roofs keep their computed normals.
    const roofMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.85,
      metalness: 0.05,
      vertexColors: true,
    });
    const glowMaterial = new THREE.MeshStandardMaterial({
      color: '#000000',
      emissive: new THREE.Color(planet.surface.palette.accent),
      emissiveIntensity: 1.4,
    });
    for (const kind of ['cave', 'wreck'] as const) {
      const mine: number[] = [];
      shelters.forEach((s, index) => {
        if (s.kind === kind) mine.push(index);
      });
      if (mine.length === 0) continue;
      const geometry = shelterGeometry(kind, planet.biome, hash32(layout.hash, 'shelter', kind), assets);
      const matrices = new Float32Array(mine.length * 16);
      mine.forEach((index, i) => {
        const s = shelters[index] as ViewLayout['shelters'][number];
        let rotation = kind === 'cave' ? -s.gapAngle : -s.angle;
        if (kind === 'wreck') {
          // The breach sits at local +z → world bearing angle + π/2 under
          // this rotation; a gap nearer the other long side flips the hull π.
          const toNear = Math.atan2(Math.sin(s.gapAngle - s.angle - Math.PI / 2), Math.cos(s.gapAngle - s.angle - Math.PI / 2));
          if (Math.abs(toNear) > Math.PI / 2) rotation += Math.PI;
        }
        scratchMatrix.makeRotationY(rotation);
        scratchMatrix.setPosition(s.x, this.field.heightAt(s.x, s.z), s.z);
        scratchMatrix.toArray(matrices, i * 16);
        this.#roofMatrices[index] = scratchMatrix.clone();
      });
      // SPEC-035 §4.5: the body fades like any other prop; the roof keeps its
      // SPEC-030 lift and is never faded on top of it (35-c).
      const bodyTop = topOf(geometry.body);
      const body = this.#addCulled(
        new THREE.InstancedMesh(geometry.body, this.#accentMaterial, mine.length),
        { matrices, fades: new Float32Array(mine.length).fill(1) },
        sphereOf(geometry.body),
      );
      // The roof's master is its own: the lift writes into it.
      const roof = this.#addCulled(
        new THREE.InstancedMesh(geometry.roof, roofMaterial, mine.length),
        { matrices: matrices.slice() },
        sphereOf(geometry.roof),
      );
      const glow =
        geometry.glow === undefined
          ? null
          : this.#addCulled(new THREE.InstancedMesh(geometry.glow, glowMaterial, mine.length), { matrices }, sphereOf(geometry.glow));
      mine.forEach((index, i) => {
        const s = shelters[index] as ViewLayout['shelters'][number];
        this.#occluders.push({ x: s.x, z: s.z, radius: Math.max(s.rx, s.rz), height: Math.max(0.5, bodyTop) });
        this.#occluderTargets.push({ kind: 'instance', layer: body, index: i });
        this.#roofSlots[index] = { layer: roof, slot: i };
      });
      for (const layer of [body, roof, ...(glow === null ? [] : [glow])]) {
        layer.mesh.receiveShadow = true;
        this.#shelterMeshes.push(layer.mesh);
      }
    }
  }

  /**
   * SPEC-030 §4.9: scale the occupied shelter's roof instance to zero and
   * restore the previously occupied one, so the player stays visible under
   * the 55° camera (AC-41; instant even under reduce motion, 30-j). SPEC-046
   * §4.6: through the roof layer's master, so a roof lifted while off screen
   * is lifted when it is drawn again (46-d).
   */
  setOccupiedShelter(index: number | null): void {
    if (index === this.#occupiedShelter) return;
    const previous = this.#occupiedShelter;
    this.#occupiedShelter = index;
    if (previous !== null) {
      const entry = this.#roofSlots[previous];
      const matrix = this.#roofMatrices[previous];
      if (entry !== undefined && matrix !== undefined) entry.layer.setMatrix(entry.slot, matrix);
    }
    if (index !== null) {
      const entry = this.#roofSlots[index];
      const matrix = this.#roofMatrices[index];
      if (entry !== undefined && matrix !== undefined) {
        scratchMatrix.copy(matrix);
        scratchMatrix.scale(scratchVector.set(1e-6, 1e-6, 1e-6));
        entry.layer.setMatrix(entry.slot, scratchMatrix);
      }
    }
  }

  /** SPEC-030 D-22: wall chunks inside the frustum on the last render. */
  get wallVisible(): number {
    return this.#wallVisible;
  }

  /** The scene calls this each render with its own frustum (D-22). */
  updateWallVisibility(frustum: THREE.Frustum): void {
    let count = 0;
    const wall = this.#wall;
    if (wall !== null) {
      for (const chunk of wall.children) {
        const sphere = chunk.userData['sphere'] as THREE.Sphere | undefined;
        if (sphere !== undefined && frustum.intersectsSphere(sphere)) count++;
      }
    }
    this.#wallVisible = count;
  }

  /** SPEC-018 §4.8: 80–140 instanced silhouettes on the apron, past the berm. */
  #buildBoundaryRing(layout: ViewLayout, planet: PlanetDef): void {
    const look = planet.surface.look;
    const seed = hash32(layout.hash, 'boundary');
    const perimeter = 8 * (layout.halfSize + (RING_INNER + RING_OUTER) / 2);
    const count = Math.min(RING_MAX, Math.max(RING_MIN, Math.round(perimeter / RING_SPACING)));
    const geometry = boundaryGeometry(look.boundary);
    // SPEC-046 §4.1: no flat shading — the bodies keep their builders' normals.
    const mesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, vertexColors: true }),
      count,
    );
    const matrices = new Float32Array(count * 16);
    const shades = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Around the square boundary: an angle walk with jitter, pushed out to a
      // jittered band between +6 and +28 m past halfSize.
      const angle = ((i + hash01(seed, i, 0) * 0.8) / count) * Math.PI * 2;
      const band = layout.halfSize + RING_INNER + hash01(seed, i, 1) * (RING_OUTER - RING_INNER);
      // Project the direction onto the square: scale so max(|x|,|z|) = band.
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      const stretch = band / Math.max(Math.abs(dx), Math.abs(dz));
      const x = dx * stretch;
      const z = dz * stretch;
      const scale = 2.5 + hash01(seed, i, 2) * 3.5;
      scratchMatrix.makeRotationY(hash01(seed, i, 3) * Math.PI * 2);
      scratchMatrix.scale(scratchVector.set(scale, scale, scale));
      scratchMatrix.setPosition(x, this.field.heightAt(x, z), z);
      scratchMatrix.toArray(matrices, i * 16);
      const shade = 0.8 + hash01(seed, i, 4) * 0.3;
      shades[i * 3] = shade;
      shades[i * 3 + 1] = shade;
      shades[i * 3 + 2] = shade;
    }
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'boundary-ring';
    this.#addCulled(mesh, { matrices, colors: shades }, sphereOf(geometry));
  }

  /** SPEC-046 §4.6: one static instanced layer under the root, drawn through compaction. */
  #addCulled(mesh: THREE.InstancedMesh, master: CullMaster, localSphere: THREE.Sphere): CulledInstances {
    const layer = new CulledInstances(mesh, master, localSphere);
    this.#envRoot.add(mesh);
    this.#culled.push(layer);
    this.#cullDirty = true;
    return layer;
  }

  /** Takes a layer out of the scene and the cull list, freeing its geometry (and a glow's own material). */
  #dropLayer(layer: CulledInstances, ownMaterial: boolean): void {
    const mesh = layer.mesh;
    this.#envRoot.remove(mesh);
    mesh.geometry.dispose();
    if (ownMaterial) (mesh.material as THREE.Material).dispose();
    mesh.dispose();
    const at = this.#culled.indexOf(layer);
    if (at >= 0) this.#culled.splice(at, 1);
    this.#cullDirty = true;
  }

  /**
   * §4.5: the preset decides the shadow map and the environment, and both can
   * change while the scene is up — `SurfaceScene` re-runs this on
   * `renderer:resized`, which `setQuality` emits with `force` (17-d).
   */
  applyQuality(quality: QualitySettings): void {
    const size = quality.shadowMapSize;
    this.#key.castShadow = size > 0;
    if (size > 0) {
      const shadow = this.#key.shadow;
      shadow.mapSize.set(size, size);
      const camera = shadow.camera;
      camera.left = -SHADOW_EXTENT;
      camera.right = SHADOW_EXTENT;
      camera.top = SHADOW_EXTENT;
      camera.bottom = -SHADOW_EXTENT;
      camera.near = 1;
      camera.far = 120;
      camera.updateProjectionMatrix();
      // 17-h: a normal bias does the work on flat low-poly faces; the depth
      // bias only takes the last sliver of acne.
      shadow.bias = -0.0005;
      shadow.normalBias = 0.6;
    } else {
      // Frees the depth texture the map was holding.
      this.#key.shadow.dispose();
    }
    this.enemies.setShadows(size > 0);
    this.#character?.setShadows(size > 0);
    this.#shadowsOn = size > 0;
    for (const body of this.#scavBodies) body.setShadows(size > 0);
    this.#blobMaterial.opacity = size > 0 ? BLOB_OPACITY_WITH_MAP : BLOB_OPACITY_ALONE;
    // SPEC-030 AC-38 / SPEC-017 §4.5: casters on high only; receivers always.
    for (const mesh of this.#wallChunks) mesh.castShadow = size > 0;
    for (const mesh of this.#shelterMeshes) mesh.castShadow = size > 0;
    for (const mesh of this.#tugMeshes) mesh.castShadow = size > 0;
    // SPEC-046 §4.6 (46-h): with a shadow map, a caster off screen can throw
    // its shadow on screen, so every layer's pad grows by its shadow's reach.
    const reach = size > 0 ? this.#sunSlope : 0;
    if (reach !== this.#shadowReach) {
      this.#shadowReach = reach;
      this.#cullDirty = true;
    }

    // 18-p: the storm capacity is the preset's particle budget.
    if (quality.maxParticles !== this.#stormCapacity) {
      this.#storm.dispose();
      this.#stormCapacity = quality.maxParticles;
      this.#storm = new StormParticles(this.#envRoot, this.#billboard, quality.maxParticles);
      this.#storm.set(this.#particleKind, this.#particleIntensity);
    }

    // SPEC-019 19-k: the VFX pool follows its own `min(512, 4 · maxParticles)`
    // number and is rebuilt only when a preset change moves it; live particles
    // are dropped (they live ≤ 0.8 s). The storm pool above keeps its own cap.
    const fxCapacity = Math.min(FX_CAPACITY_MAX, FX_CAPACITY_PER_PARTICLE * quality.maxParticles);
    if (fxCapacity !== this.#fxCapacity) {
      this.#fx.dispose();
      this.#fxCapacity = fxCapacity;
      this.#fx = new CombatFx(this.#actorRoot, this.#billboard, fxCapacity);
    }

    if (quality.ibl) {
      if (this.#environment === null) this.#environment = buildEnvironment(skyParamsFor(this.#palette));
      this.#scene.environment = this.#environment;
      // SPEC-054 §4.4: below, the map stays dimmed to the dark look's.
      this.#scene.environmentIntensity = this.#dark?.ibl ?? ENVIRONMENT_INTENSITY;
    } else {
      this.#clearEnvironment();
    }

    // SPEC-054 §4.5 (54-g): a flashlight already built follows the preset's
    // mode — the one moment the light count may change after the first descent.
    const flashLook = this.#flashlightLook;
    if (flashLook !== null) this.ensureFlashlight(quality.flashlight, flashLook);

    // SPEC-053 53-b: a preset change swaps the trees' LOD in place, rebuilds
    // the cover at its capacity and the undergrowth at its density, and the
    // terrain material once when the detail comes or goes.
    const preset = presetOf(quality);
    if (preset !== this.#preset) {
      const lowChanged = (this.#preset === 'low') !== (preset === 'low');
      this.#preset = preset;
      this.#applyTreeLod();
      if (lowChanged) this.#rebuildGround();
      if (this.#undergrowth !== null && lowChanged) {
        this.#dropLayer(this.#undergrowth, false);
        this.#undergrowth = null;
      }
      if (this.#cover !== null) {
        this.#cover.dispose();
        this.#cover = null;
      }
      this.#buildGroundClumps();
    }
  }

  /** 53-b: the terrain material for the new preset, its layers and detail carried over, on every tile. */
  #rebuildGround(): void {
    const old = this.#groundMaterial;
    const { a, b } = this.#groundLayers;
    const material = createTerrainMaterial(a, b, this.#look, this.#palette, this.#terrainOptions());
    if (this.#groundDetail !== null) setGroundDetail(material, this.#groundDetail);
    for (const tile of this.#tiles) tile.material = material;
    this.#groundMaterial = material;
    old.dispose();
  }

  /** D-10: clear the reference first, then free the texture. */
  #clearEnvironment(): void {
    if (this.#scene.environment === this.#environment) this.#scene.environment = null;
    this.#environment?.dispose();
    this.#environment = null;
  }

  /**
   * Fog, storm sprites and the grade, lerped by the scene over 3 s (§4.6).
   * §4.9: `visibility` drives the vignette; the kind picks the tint.
   * SPEC-030 D-5: inside a shelter the scene dampens `intensity` ×0.25 but
   * passes the raw storm through `fogIntensity`, so the fog keeps raging.
   */
  setWeather(effects: ViewWeather, intensity: number, fogIntensity = intensity): void {
    // SPEC-035 §4.4: the storm thickens the fog through this multiplier, which
    // shortens the linear span; the scene reads it back for `surfaceFogRange`.
    this.#fogMult = 1 + (effects.fogMult - 1) * fogIntensity;
    this.#particleKind = effects.particles;
    this.#particleIntensity = intensity;
    this.#storm.set(effects.particles, intensity);

    this.#grade.vignette = 0.5 * (1 - effects.visibility) * intensity;
    this.#grade.desaturate = 0.35 * intensity;
    const tint = effects.particles === 'none' ? null : STORM_LOOK[effects.particles].tint;
    for (let i = 0; i < 3; i++) {
      this.#grade.tint[i] = tint === null ? 1 : 1 + ((tint[i] as number) - 1) * intensity;
    }
  }

  /** SPEC-035 §4.4: the planet's own fog density, unscaled — the span's input. */
  get fogDensity(): number {
    return this.#baseFog;
  }

  /** SPEC-035 §4.4: the storm-lerped multiplier `setWeather` last wrote. */
  get fogMult(): number {
    return this.#fogMult;
  }

  /** SPEC-035 §4.4: the near plane in force — what `sceneInfo.fogNear` reports. */
  get fogNear(): number {
    return this.#fog.near;
  }

  /**
   * SPEC-035 §4.4 — the linear fog's span, from `surfaceFogRange`. The scene
   * calls it on entry, on every storm step and whenever the camera distance
   * eases, so nothing between the camera and the salvager is ever hazed.
   */
  setFogRange(near: number, far: number): void {
    this.#fog.near = near;
    this.#fog.far = Math.max(near + 1e-3, far);
  }

  // ------------------------------------------------------- SPEC-054 §4.4

  /** Where a cave view hangs its root: beside the environment, under the view's one root. */
  get levelRoot(): THREE.Object3D {
    return this.#root;
  }

  /** The level on show. */
  get level(): 'surface' | 'underground' {
    return this.#level;
  }

  /** The visual ground height at (x, z) on the level on show — 0 everywhere below. */
  heightAt(x: number, z: number): number {
    return this.#ground(x, z);
  }

  /**
   * SPEC-054 §4.4 — swap what the camera sees. Going down hides the
   * environment and shows `cave`; the background and the fog take
   * `look.background`; the hemisphere takes `look.ambient`, the key drops to 0
   * (it stays in the graph, `castShadow` untouched) and the rim to `look.rim`;
   * the environment map dims to `look.ibl`; and every height sample reads 0.
   * Coming up puts every surface value back. No light joins or leaves the
   * graph here, so no program recompiles; the scene drives the linear fog's
   * span (`darkFogRange` below) and the grade.
   */
  setLevel(id: 'surface' | 'underground', cave: CaveView | null, look: DarkLook | null): void {
    const below = id === 'underground' && look !== null;
    this.#level = below ? 'underground' : 'surface';
    if (this.#cave !== null && this.#cave !== cave) this.#cave.root.visible = false;
    this.#cave = below ? cave : null;
    this.#dark = below ? look : null;
    this.#envRoot.visible = !below;
    if (cave !== null) cave.root.visible = below;
    this.#flat = below;
    const colors = this.#surfaceColors;
    const background = this.#scene.background;
    if (background instanceof THREE.Color) background.set(below ? look.background : colors.sky);
    this.#fog.color.set(below ? look.background : colors.fog);
    this.#hemi.color.set(below ? look.ambient.sky : colors.hemiSky);
    this.#hemi.groundColor.set(below ? look.ambient.ground : colors.hemiGround);
    this.#hemiLevel = below ? look.ambient.intensity : this.#hemiBase;
    this.#hemi.intensity = this.#hemiLevel;
    this.#key.intensity = below ? 0 : colors.key;
    this.#rim.intensity = below ? look.rim : RIM_INTENSITY;
    this.#scene.environmentIntensity = below ? look.ibl : ENVIRONMENT_INTENSITY;
    this.#applyTorch();
  }

  // ------------------------------------------------------- SPEC-054 §4.5

  /**
   * The flashlight in `mode`: built the first time (a visit's first descent,
   * behind its fade), rebuilt when the mode changes (a quality change, 54-g),
   * kept otherwise. True when it was built or rebuilt — the moment the light
   * count may have moved, which the scene answers with a program compile.
   */
  ensureFlashlight(mode: FlashlightMode, look: DarkLook['flashlight']): boolean {
    const current = this.#flashlight;
    if (current !== null && current.mode === mode) return false;
    current?.dispose();
    const flashlight = new Flashlight(this.#player, mode, look);
    flashlight.setOn(this.#flashlightOn && this.#level === 'underground');
    this.#flashlight = flashlight;
    this.#flashlightLook = look;
    this.#applyTorch();
    return true;
  }

  /** On below with the light on; at intensity 0 above or off. Intensities only (§4.5). */
  setFlashlightOn(on: boolean): void {
    this.#flashlightOn = on;
    this.#flashlight?.setOn(on && this.#level === 'underground');
    this.#applyTorch();
  }

  /** The flashlight's mode, or `null` before the visit's first descent (`sceneInfo.flashlight`). */
  get flashlightMode(): FlashlightMode | null {
    return this.#flashlight?.mode ?? null;
  }

  /**
   * §4.5: the torch widens to 10 over 10 m while the `fake` flashlight shines
   * below — the fake mode adds no light of its own — and is the surface's
   * 6 over 14 m everywhere else. Intensity and distance are uniforms.
   */
  #applyTorch(): void {
    const wide = this.#level === 'underground' && this.#flashlightOn && this.#flashlight?.mode === 'fake';
    this.#torch.intensity = wide ? FAKE_TORCH_INTENSITY : TORCH_INTENSITY;
    this.#torch.distance = wide ? FAKE_TORCH_DISTANCE : TORCH_DISTANCE;
  }

  /**
   * SPEC-027 §4.4 — the two world-space halves of the guidance layer: a light
   * pillar standing on the focus target, and the ground route the escalation's
   * last step draws. Both objects are built on first use and reused; a `null`
   * takes its half off the screen without disposing anything, so switching
   * `guidance` mid-visit costs nothing (27-t).
   *
   * `pulse` asks for the animation (the scene passes the player's reduce-motion
   * setting through it); a static pillar and a still wave are what 27-j wants.
   * Budget: 2 draw calls (AC-34), and neither half allocates per frame.
   */
  setGuide(guide: { beacon: { x: number; z: number } | null; route: Float32Array | null; routeLength: number; pulse: boolean }): void {
    const animate = guide.pulse && !this.reduceMotion;
    const time = this.#guideTime;

    const beacon = guide.beacon;
    if (beacon === null) {
      if (this.#pillar !== null) this.#pillar.visible = false;
    } else {
      const pillar = this.#buildPillar();
      pillar.visible = true;
      pillar.position.set(beacon.x, this.#ground(beacon.x, beacon.z) + PILLAR_HEIGHT / 2, beacon.z);
      // §4.4: `0.35 + 0.25·sin(2π·t)`, or a flat 0.5 when nothing may move.
      this.#pillarMaterial.opacity = animate ? 0.35 + 0.25 * Math.sin(time * Math.PI * 2) : 0.5;
    }

    const route = guide.route;
    const markers = this.#buildRoute();
    if (route === null || guide.routeLength < 2) {
      markers.count = 0;
      markers.visible = false;
      return;
    }
    // Walk the polyline and drop a disc every 2.5 m of it, up to the capacity;
    // the instances past the end are simply not drawn (`count`), never rebuilt.
    let placed = 0;
    let walked = 0;
    let nextAt = 0;
    for (let i = 0; i < guide.routeLength - 1 && placed < ROUTE_CAPACITY; i++) {
      const ax = route[i * 2] as number;
      const az = route[i * 2 + 1] as number;
      const bx = route[i * 2 + 2] as number;
      const bz = route[i * 2 + 3] as number;
      const length = Math.hypot(bx - ax, bz - az);
      if (length <= 0) continue;
      while (nextAt <= walked + length && placed < ROUTE_CAPACITY) {
        const t = (nextAt - walked) / length;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        scratchMatrix.makeTranslation(x, this.#ground(x, z) + ROUTE_LIFT, z);
        markers.setMatrixAt(placed, scratchMatrix);
        // The travelling brightness wave: one period every six markers.
        const wave = animate ? 0.5 + 0.5 * Math.sin((time * ROUTE_WAVE_SPEED - placed * ROUTE_WAVE_STEP) * Math.PI * 2) : 1;
        markers.setColorAt(placed, scratchColor.setScalar(ROUTE_DIM + (1 - ROUTE_DIM) * wave));
        placed++;
        nextAt += ROUTE_SPACING;
      }
      walked += length;
    }
    markers.count = placed;
    markers.visible = placed > 0;
    markers.instanceMatrix.needsUpdate = true;
    if (markers.instanceColor !== null) markers.instanceColor.needsUpdate = true;
  }

  /** The pillar, built once: 24 triangles, additive, alpha fading upward. */
  #buildPillar(): THREE.Mesh {
    const existing = this.#pillar;
    if (existing !== null) return existing;
    const geometry = new THREE.CylinderGeometry(0.35, 0.35, PILLAR_HEIGHT, 12, 1, true);
    // The vertical fade is four-component vertex colour: opaque at the ground,
    // gone at the top, which costs no texture and no second draw.
    const position = geometry.getAttribute('position');
    const colors = new Float32Array(position.count * 4);
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i) / PILLAR_HEIGHT + 0.5; // 0 at the base, 1 at the top
      colors[i * 4] = 1;
      colors[i * 4 + 1] = 1;
      colors[i * 4 + 2] = 1;
      colors[i * 4 + 3] = Math.max(0, 1 - y) ** 1.5;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    const mesh = new THREE.Mesh(geometry, this.#pillarMaterial);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    this.#actorRoot.add(mesh);
    this.#pillar = mesh;
    return mesh;
  }

  /** The route markers, built once: one instanced disc mesh, capacity 48. */
  #buildRoute(): THREE.InstancedMesh {
    const existing = this.#routeMarkers;
    if (existing !== null) return existing;
    const geometry = new THREE.CircleGeometry(0.28, 12);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(geometry, this.#routeMaterial, ROUTE_CAPACITY);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    mesh.count = 0;
    // One `setColorAt` up front, so `instanceColor` exists before the wave runs.
    mesh.setColorAt(0, scratchColor.setScalar(1));
    this.#actorRoot.add(mesh);
    this.#routeMarkers = mesh;
    return mesh;
  }

  /** The boss arena lock ring (SPEC-011 11-e). */
  setArena(arena: { x: number; z: number; radius: number } | null): void {
    this.#arenaRing.visible = arena !== null;
    if (arena !== null) {
      this.#arenaRing.position.set(arena.x, 0.3 + this.#ground(arena.x, arena.z), arena.z);
      this.#arenaRing.scale.setScalar(arena.radius);
    }
  }

  // ------------------------------------------------ SPEC-040 §4.6, SPEC-046 §4.2

  /**
   * SPEC-046 §4.2: every prop and obstacle kind. A kind gathers its instances
   * in layout order — its obstacles, then its small props — and draws one
   * mesh per variant from its models when one is drawable, or SPEC-018's two
   * sculpted meshes (obstacles, small props) when none is. The occluder
   * candidates go in today's order, so `occluderProps` keeps its length and
   * order whichever way a kind is drawn.
   */
  #buildProps(layout: ViewLayout, assets: Assets | undefined): void {
    const groups = new Map<ObstacleKind, PropInstance[]>();
    /** Today's occluder order: obstacle kinds, then small-prop kinds, each by first appearance. */
    const order: { kind: ObstacleKind; small: boolean }[] = [];
    const ordinals = new Map<string, number>();
    const place = (
      kind: ObstacleKind,
      layoutKind: string,
      small: boolean,
      x: number,
      z: number,
      scale: number,
      rot: number,
      orchard: boolean,
    ): void => {
      let list = groups.get(kind);
      if (list === undefined) {
        list = [];
        groups.set(kind, list);
      }
      if (!order.some((group) => group.kind === kind && group.small === small)) order.push({ kind, small });
      const ordinal = ordinals.get(layoutKind) ?? 0;
      ordinals.set(layoutKind, ordinal + 1);
      list.push({ x, z, scale, rot, layoutKind, ordinal, small, orchard, target: { kind: 'instance', layer: null, index: -1 } });
    };
    for (const o of layout.obstacles) {
      // SPEC-030 D-19: shelter walls are collision-only — the shelter body is
      // their visual; `debris` draws like any other kind.
      if (o.kind === 'cave_wall' || o.kind === 'wreck_hull') continue;
      // SPEC-053 §4.2: a tree's radius is its trunk, so it draws at the
      // contract's scale, `radius / 0.14` — its canopy's radius; §4.9: every
      // orchard tree stands at yaw 0.
      const tree = o.kind === 'tree';
      const orchard = tree && o.feature === 'orchard';
      place(o.kind, o.kind, false, o.x, o.z, tree ? o.radius / TRUNK_UNIT_RADIUS : o.radius, orchard ? 0 : (o.x * 7 + o.z * 3) % Math.PI, orchard);
    }
    for (const prop of layout.props) {
      const kind = prop.kind.replace('_small', '') as ObstacleKind;
      place(kind, prop.kind, true, prop.x, prop.z, prop.scale * (kind === 'tree' ? SMALL_TREE_SCALE : SMALL_PROP_SCALE), prop.rot, false);
    }

    const plans = new Map<ObstacleKind, { prop: PropKind; shapes: (PropGeometry | null)[]; shapeOf: readonly number[] }>();
    for (const [kind, instances] of groups) {
      const prop: PropKind = {
        kind,
        seed: hash32(layout.hash, 'prop', kind),
        ids: obstacleModelIds(kind, this.#biome),
        undrawable: new Set(),
        instances,
        matrices: new Float32Array(instances.length * 16),
        lifted: false,
        layers: [],
        fromModel: false,
      };
      if (kind === 'tree') this.#adoptTrees(prop);
      const variants = this.#variantShapes(prop, assets);
      let shapes: (PropGeometry | null)[];
      let shapeOf: readonly number[];
      if (variants.some((shape) => shape !== null)) {
        prop.fromModel = true;
        shapes = variants;
        shapeOf = this.#variantOf(prop, variants);
      } else {
        // 18-d: the procedural rock embeds half its radius, lifted back out.
        prop.lifted = kind === 'rock';
        shapes = [
          instances.some((p) => !p.small) ? proceduralObstacle(kind, this.#biome, prop.seed, false) : null,
          instances.some((p) => p.small) ? proceduralObstacle(kind, this.#biome, prop.seed, true) : null,
        ];
        shapeOf = instances.map((p) => (p.small ? 1 : 0));
      }
      instances.forEach((entry, i) => {
        // 18-d: bases sit at h. A GLB prop has its origin at the base centre,
        // so it takes no lift (§4.10).
        const lift = prop.lifted ? entry.scale * ROCK_LIFT : 0;
        scratchMatrix.makeRotationY(entry.rot);
        scratchMatrix.scale(scratchVector.set(entry.scale, entry.scale, entry.scale));
        scratchMatrix.setPosition(entry.x, this.field.heightAt(entry.x, entry.z) + lift, entry.z);
        scratchMatrix.toArray(prop.matrices, i * 16);
      });
      plans.set(kind, { prop, shapes, shapeOf });
      this.#propKinds.push(prop);
    }

    // SPEC-035 §4.5: the cylinder the pure test uses — the instance's own
    // footprint, as tall as its geometry reaches above the ground.
    const tops = new Map<PropGeometry, number>();
    for (const { kind, small } of order) {
      const plan = plans.get(kind);
      if (plan === undefined) continue;
      plan.prop.instances.forEach((entry, i) => {
        if (entry.small !== small) return;
        const shape = plan.shapes[plan.shapeOf[i] as number];
        if (shape === null || shape === undefined) return;
        let top = tops.get(shape);
        if (top === undefined) {
          top = topOf(shape.body);
          tops.set(shape, top);
        }
        const lift = plan.prop.lifted ? entry.scale * ROCK_LIFT : 0;
        this.#occluders.push({ x: entry.x, z: entry.z, radius: entry.scale, height: Math.max(0.5, top * entry.scale + lift) });
        this.#occluderTargets.push(entry.target);
      });
    }

    for (const { prop, shapes, shapeOf } of plans.values()) {
      prop.layers = this.#propLayers(prop, shapes, shapeOf, prop.fromModel ? this.#glbMaterial : this.#accentMaterial);
    }
  }

  /**
   * SPEC-046 §4.2: each of the kind's variants as a prop body, or `null` where
   * its model is not loaded — or loaded as a tree contract, which is noted so
   * `propSource` stops waiting for it (§4.1). SPEC-053 §4.1: a tree contract
   * draws through the foliage seam once the atlas is in — until then it is
   * noted the same way, and `setPropModels` asks again — and the trees of a
   * planet with orchards gain `ORCHARD_MODEL` as one more shape, after the
   * variants.
   */
  #variantShapes(prop: PropKind, assets: Assets | undefined): (PropGeometry | null)[] {
    const atlas = prop.kind === 'tree' && this.#foliageMaterial !== null ? foliageAtlas(assets) : null;
    const shape = (id: ModelId): PropGeometry | null => {
      if (assets === undefined || prop.undrawable.has(id) || !assets.hasModel(id)) return null;
      const model = assets.model(id);
      if (prop.kind === 'tree' && isTreeContract(model)) {
        if (atlas !== null) return foliageFromModel(model);
        prop.undrawable.add(id);
        return null;
      }
      const drawable = propFromModel(model);
      if (drawable === null) prop.undrawable.add(id);
      return drawable;
    };
    const shapes = prop.ids.map(shape);
    if (prop.kind === 'tree' && prop.instances.some((entry) => entry.orchard)) shapes.push(shape(ORCHARD_MODEL));
    return shapes;
  }

  /**
   * SPEC-046 §4.2: each instance's variant by hash; one whose model is missing
   * draws the first loaded one. SPEC-053 §4.9: an orchard tree draws the
   * orchard's shape, never a hashed variant, while it is loaded.
   */
  #variantOf(prop: PropKind, variants: readonly (PropGeometry | null)[]): number[] {
    const n = prop.ids.length;
    const first = variants.findIndex((shape) => shape !== null);
    const orchard = variants.length > n && variants[n] !== null ? n : -1;
    return prop.instances.map((entry) => {
      if (entry.orchard && orchard >= 0) return orchard;
      const v = variantIndex(this.#layoutHash, entry.layoutKind, entry.ordinal, n);
      return variants[v] === null || variants[v] === undefined ? first : v;
    });
  }

  /**
   * SPEC-053 E82: the tree kind's canopy-fade state — every instance at 1 —
   * and the grid that finds the trees around the player.
   */
  #adoptTrees(prop: PropKind): void {
    const count = prop.instances.length;
    this.#trees = prop;
    this.#canopyFade = new Float32Array(count).fill(1);
    this.#canopyTarget = new Float32Array(count).fill(1);
    this.#canopyCandidates = new Int32Array(count);
    this.#canopyHeld = new Int32Array(count);
    const xz = new Float32Array(count * 2);
    prop.instances.forEach((entry, i) => {
      xz[i * 2] = entry.x;
      xz[i * 2 + 1] = entry.z;
    });
    this.#canopyGrid = new InstanceGrid(CANOPY_FADE_RANGE, xz);
  }

  /**
   * One layer per shape that holds instances — a body on `material`, plus a
   * glow when the shape has one — whose masters copy the kind's matrices and
   * each member's current fade. Points every member's occluder target at its
   * new layer and index. A shape nothing draws is disposed.
   */
  #propLayers(prop: PropKind, shapes: readonly (PropGeometry | null)[], shapeOf: readonly number[], material: THREE.Material): PropLayer[] {
    const layers: PropLayer[] = [];
    shapes.forEach((shape, s) => {
      if (shape === null) return;
      const members: number[] = [];
      shapeOf.forEach((of, i) => {
        if (of === s) members.push(i);
      });
      if (members.length === 0) {
        shape.body.dispose();
        shape.lod1?.dispose();
        shape.glow?.dispose();
        return;
      }
      // SPEC-053 §4.1: a tree from the seam draws on `#foliageMaterial`, its
      // fade the canopy's (E82) — SPEC-035's never reaches it — and its LOD
      // the preset's.
      const foliage = shape.foliage === true && this.#foliageMaterial !== null;
      const lods = foliage ? { body: shape.body, lod1: shape.lod1 ?? shape.body } : null;
      const matrices = new Float32Array(members.length * 16);
      const fades = new Float32Array(members.length);
      members.forEach((member, j) => {
        for (let e = 0; e < 16; e++) matrices[j * 16 + e] = prop.matrices[member * 16 + e] as number;
        const target = (prop.instances[member] as PropInstance).target;
        // E72: a fade in flight carries across a rebuild.
        if (foliage) fades[j] = this.#canopyFade[member] ?? 1;
        else fades[j] = target.layer === null ? 1 : target.layer.fadeAt(target.index);
      });
      const geometry = lods === null ? shape.body : this.#preset === 'low' ? lods.lod1 : lods.body;
      const mesh = new THREE.InstancedMesh(geometry, foliage ? (this.#foliageMaterial as THREE.Material) : material, members.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (foliage) mesh.name = `tree:${s}`;
      const body = this.#addCulled(mesh, { matrices, fades }, sphereOf(geometry));
      members.forEach((member, j) => {
        const target = (prop.instances[member] as PropInstance).target;
        target.layer = body;
        target.index = j;
      });
      let glow: CulledInstances | null = null;
      if (shape.glow !== undefined) {
        // §4.7: the emissive parts, instanced on the body's own matrices.
        const glowMesh = new THREE.InstancedMesh(shape.glow, obstacleGlow(prop.kind, this.#biome, this.#palette.accent), members.length);
        glowMesh.castShadow = false;
        if (foliage) glowMesh.name = `tree-glow:${s}`;
        glow = this.#addCulled(glowMesh, { matrices }, sphereOf(shape.glow));
        // SPEC-053 §4.1: a tree's glow is LOD0's; `low` draws its LOD1 alone.
        if (lods !== null && this.#preset === 'low') this.#setCulledActive(glow, false);
      }
      layers.push({ body, glow, members, lods });
    });
    return layers;
  }

  /**
   * SPEC-040 §4.6, E72: the planet's prop models, swapped in after the view was
   * built — the set landed later than the surface would wait for it. SPEC-046
   * §4.2: each kind still drawn from its stand-ins that now has a drawable
   * model is rebuilt into its variant meshes — the procedural meshes and their
   * geometry disposed, every instance keeping its matrix, its fade and its
   * occluder candidate — so no position, collision, fade or layout hash moves.
   * A kind with no drawable model, or already drawn from its models, is left
   * alone.
   */
  setPropModels(assets: Assets): void {
    let rebuilt = false;
    // SPEC-053 53-i: the shared set's atlas makes the trees, the undergrowth
    // and the cover drawable; its detail normal swaps into the ground.
    const atlas = foliageAtlas(assets);
    if (atlas !== null && this.#foliageMaterial === null) {
      this.#makeFoliageMaterials(atlas);
      // A tree contract waited for the atlas, not forever.
      for (const prop of this.#propKinds) if (prop.kind === 'tree') prop.undrawable.clear();
    }
    if (this.#groundDetail === null && assets.hasTexture?.('ground_detail') === true) this.#setDetail(assets.texture('ground_detail'));
    for (const prop of this.#propKinds) {
      if (prop.fromModel || prop.ids.length === 0) continue;
      const variants = this.#variantShapes(prop, assets);
      if (!variants.some((shape) => shape !== null)) continue;
      if (prop.lifted) {
        // The matrices still carry the procedural rock's lift; the model's own
        // geometry gives it back, so the rock stands on the ground (18-d).
        for (const shape of variants) {
          shape?.body.translate(0, -ROCK_LIFT, 0);
          shape?.glow?.translate(0, -ROCK_LIFT, 0);
        }
      }
      const old = prop.layers;
      prop.layers = this.#propLayers(prop, variants, this.#variantOf(prop, variants), this.#glbMaterial);
      for (const layer of old) {
        this.#dropLayer(layer.body, false);
        if (layer.glow !== null) this.#dropLayer(layer.glow, true);
      }
      prop.fromModel = true;
      rebuilt = true;
    }
    if (this.#buildGroundClumps()) rebuilt = true;
    if (this.#swapLandmarks(assets)) rebuilt = true;
    if (rebuilt) this.#refreshCulled();
  }

  /**
   * SPEC-040 §4.6: `'glb'` once every prop kind that has a model draws it,
   * `'procedural'` while any of them still draws its stand-in. SPEC-046 §4.2:
   * a variant that loaded as a tree contract is not drawable, so a kind whose
   * models all did holds nothing up.
   */
  get propSource(): 'glb' | 'procedural' {
    for (const prop of this.#propKinds) {
      if (prop.fromModel) continue;
      if (prop.ids.some((id) => !prop.undrawable.has(id))) return 'procedural';
    }
    return 'glb';
  }

  // ------------------------------------------------------- SPEC-053

  /** §4.1: `#foliageMaterial` and the cover material, on the atlas, once. */
  #makeFoliageMaterials(atlas: THREE.Texture): void {
    if (this.#foliageMaterial !== null) return;
    this.#foliageMaterial = createFoliageMaterial(atlas, this.#look.foliage?.tint ?? '#ffffff');
    this.#coverMaterial = createCoverMaterial(atlas);
  }

  /** §4.6: detail on `medium` and `high`; the seam, where the look has one, on every preset. */
  #terrainOptions(): TerrainOptions {
    const seam = this.#look.ground.seam;
    const options: TerrainOptions = { detail: this.#preset !== 'low' };
    if (seam !== undefined && this.#seamAt !== null) options.seam = { at: this.#seamAt, shift: seam.shift, axis: seam.axis };
    return options;
  }

  /** §4.6, 53-i: the detail normal landed — into the ground's uniform, with no recompile. */
  #setDetail(detail: THREE.Texture): void {
    this.#groundDetail = detail;
    setGroundDetail(this.#groundMaterial, detail);
  }

  /**
   * §4.7: one culled layer of the blob-shadow texture on a ground quad of
   * radius 1 — under every drawn obstacle at 1.4 × its radius, every tree at
   * 0.9 × its canopy and every landmark at 1.2 × its footprint, at
   * `heightAt + 0.05`. The collision-only kinds have nothing to ground.
   */
  #buildContactShadows(layout: ViewLayout): void {
    const spots: number[] = [];
    for (const o of layout.obstacles) {
      if (o.kind === 'cave_wall' || o.kind === 'wreck_hull') continue;
      spots.push(o.x, o.z, o.kind === 'tree' ? (CONTACT_TREE * o.radius) / TRUNK_UNIT_RADIUS : CONTACT_OBSTACLE * o.radius);
    }
    for (const poi of layout.pois) {
      if (poi.kind === 'landmark') spots.push(poi.x, poi.z, CONTACT_LANDMARK * LANDMARK_FOOTPRINT[this.#biome]);
    }
    const count = spots.length / 3;
    if (count === 0) return;
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: radialAlpha(),
      transparent: true,
      depthWrite: false,
      opacity: CONTACT_OPACITY,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = 'contact-shadows';
    mesh.renderOrder = 1;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const matrices = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) {
      const x = spots[i * 3] as number;
      const z = spots[i * 3 + 1] as number;
      const r = spots[i * 3 + 2] as number;
      scratchMatrix.makeScale(r, 1, r);
      scratchMatrix.setPosition(x, this.field.heightAt(x, z) + CONTACT_LIFT, z);
      scratchMatrix.toArray(matrices, i * 16);
    }
    this.#contact = this.#addCulled(mesh, { matrices }, sphereOf(geometry));
  }

  /**
   * §4.4, §4.5: the undergrowth (placed once, half of it on `low`) and the
   * streamed cover, each built the first time the cover material exists.
   * True when either was built now.
   */
  #buildGroundClumps(): boolean {
    const material = this.#coverMaterial;
    if (material === null) return false;
    let built = false;
    const spec = this.#look.undergrowth;
    if (this.#undergrowth === null && spec !== undefined) {
      const placed = placeUndergrowth(this.#layout, this.field, spec, this.#preset);
      const geometry = crossedQuads(3, UNDERGROWTH_WIDTH, UNDERGROWTH_HEIGHT);
      const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, placed.count));
      mesh.name = 'undergrowth';
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.#undergrowth = this.#addCulled(
        mesh,
        { matrices: placed.matrices, colors: placed.colors, extra: { name: 'uvCell', values: placed.cells } },
        sphereOf(geometry),
      );
      built = true;
    }
    const cover = this.#look.cover;
    if (this.#cover === null && cover !== undefined) {
      this.#cover = new GroundCover(this.#envRoot, this.#layout, this.field, cover, this.#preset, material);
      this.#cullDirty = true;
      built = true;
    }
    return built;
  }

  /**
   * §4.8: every landmark still drawing SPEC-046's procedural body takes its
   * model once it has landed — scale 1, its hashed yaw, its own colours and
   * glow — and its occluder grows to the model's top. True when one swapped.
   */
  #swapLandmarks(assets: Assets): boolean {
    let swapped = false;
    const id = LANDMARK_MODELS[this.#biome];
    for (const landmark of this.#landmarks) {
      if (landmark.fromModel || !assets.hasModel(id)) continue;
      const prop = propFromModel(assets.model(id));
      if (prop === null) continue;
      const mesh = landmark.mesh;
      const target = this.#occluderTargets[landmark.occluder];
      if (target !== undefined && target.kind === 'mesh') {
        for (const part of target.parts) part.faded?.dispose();
      }
      mesh.geometry.dispose();
      mesh.geometry = prop.body;
      mesh.material = this.#landmarkMaterial;
      mesh.scale.setScalar(1);
      mesh.rotation.y = landmark.yaw;
      this.#occluderTargets[landmark.occluder] = { kind: 'mesh', parts: [{ mesh, base: this.#landmarkMaterial, faded: null }] };
      const before = this.#occluders[landmark.occluder];
      if (before !== undefined) this.#occluders[landmark.occluder] = { ...before, height: topOf(prop.body) };
      if (landmark.glow !== null) {
        this.#envRoot.remove(landmark.glow);
        landmark.glow.geometry.dispose();
        landmark.glow = null;
      }
      if (prop.glow !== undefined && this.#landmarkGlow !== null) {
        const glow = new THREE.Mesh(prop.glow, this.#landmarkGlow);
        glow.name = 'poi-glow:landmark';
        glow.position.copy(mesh.position);
        glow.rotation.y = landmark.yaw;
        this.#envRoot.add(glow);
        landmark.glow = glow;
      }
      landmark.fromModel = true;
      swapped = true;
    }
    return swapped;
  }

  /** Puts a culled layer in or out of the refresh list — a tree glow off on `low`. */
  #setCulledActive(layer: CulledInstances, active: boolean): void {
    const at = this.#culled.indexOf(layer);
    if (active && at < 0) {
      this.#culled.push(layer);
      layer.mesh.count = layer.drawn;
      layer.mesh.visible = layer.drawn > 0;
      this.#cullDirty = true;
    } else if (!active && at >= 0) {
      this.#culled.splice(at, 1);
      layer.mesh.count = 0;
      layer.mesh.visible = false;
    }
  }

  /** §4.1, 53-b: every foliage layer draws its `lod1` on `low` and its body otherwise, swapped in place. */
  #applyTreeLod(): void {
    const trees = this.#trees;
    if (trees === null) return;
    const low = this.#preset === 'low';
    for (const layer of trees.layers) {
      if (layer.lods === null) continue;
      const geometry = low ? layer.lods.lod1 : layer.lods.body;
      if (layer.body.mesh.geometry !== geometry) {
        layer.body.setGeometry(geometry, sphereOf(geometry));
        this.#cullDirty = true;
      }
      if (layer.glow !== null) this.#setCulledActive(layer.glow, !low);
    }
  }

  /** True for a layer drawn on `#foliageMaterial`, which SPEC-035's fade leaves alone. */
  #isFoliage(layer: CulledInstances | null): boolean {
    return layer !== null && this.#foliageMaterial !== null && layer.mesh.material === this.#foliageMaterial;
  }

  /**
   * E82: every 0.1 s of view time, the trees within 25 m of the player whose
   * canopy disc holds a live enemy or a pickup target `CANOPY_FADE`, and the
   * rest 1; every `sync` then steps each fade toward its target at
   * `(1 − CANOPY_FADE) / CANOPY_FADE_SECONDS` a second. The query runs before
   * the step, so a new holder is already below 1 when it is counted. Allocates
   * nothing.
   */
  #stepCanopies(frame: SurfaceFrame): void {
    const trees = this.#trees;
    const grid = this.#canopyGrid;
    if (trees === null || grid === null) return;
    this.#canopyClock += frame.dt;
    // Only a frame that moves the clock asks: a frozen one (hit-stop) cannot step a new holder's fade.
    if (frame.dt > 0 && this.#canopyClock >= CANOPY_QUERY_SECONDS) {
      this.#canopyClock %= CANOPY_QUERY_SECONDS;
      this.#queryCanopies(frame, trees, grid);
    }
    const step = frame.dt <= 0 ? 0 : ((1 - CANOPY_FADE) / CANOPY_FADE_SECONDS) * frame.dt;
    const fades = this.#canopyFade;
    const targets = this.#canopyTarget;
    let faded = 0;
    for (let i = 0; i < fades.length; i++) {
      const from = fades[i] as number;
      const to = targets[i] as number;
      let value = from;
      if (from < to) value = Math.min(to, from + step);
      else if (from > to) value = Math.max(to, from - step);
      if (value !== from) {
        fades[i] = value;
        const target = (trees.instances[i] as PropInstance).target;
        if (this.#isFoliage(target.layer)) target.layer?.setFade(target.index, fades[i] as number);
      }
      if ((fades[i] as number) < 1) faded++;
    }
    this.#canopyFaded = faded;
  }

  #queryCanopies(frame: SurfaceFrame, trees: PropKind, grid: InstanceGrid): void {
    const targets = this.#canopyTarget;
    const held = this.#canopyHeld;
    for (let k = 0; k < this.#canopyHeldCount; k++) targets[held[k] as number] = 1;
    this.#canopyHeldCount = 0;
    const p = frame.player;
    const rect = this.#canopyRect;
    rect.minX = p.x - CANOPY_FADE_RANGE;
    rect.maxX = p.x + CANOPY_FADE_RANGE;
    rect.minZ = p.z - CANOPY_FADE_RANGE;
    rect.maxZ = p.z + CANOPY_FADE_RANGE;
    const count = grid.query(rect, this.#canopyCandidates);
    for (let k = 0; k < count; k++) {
      const i = this.#canopyCandidates[k] as number;
      const tree = trees.instances[i] as PropInstance;
      const dx = tree.x - p.x;
      const dz = tree.z - p.z;
      if (dx * dx + dz * dz > CANOPY_FADE_RANGE * CANOPY_FADE_RANGE) continue;
      if (!this.#isFoliage(tree.target.layer) || !this.#canopyHolds(frame, tree.x, tree.z, tree.scale)) continue;
      targets[i] = CANOPY_FADE;
      held[this.#canopyHeldCount++] = i;
    }
  }

  /** E82: a live enemy, or a pickup, inside the canopy disc of radius `r` at (x, z). */
  #canopyHolds(frame: SurfaceFrame, x: number, z: number, r: number): boolean {
    const reach = r * r;
    const enemies = frame.enemies;
    for (let i = 0; i < enemies.size; i++) {
      const e = enemies.at(i);
      if (e.state === 'dead' || isBuried(e)) continue;
      if ((e.x - x) ** 2 + (e.z - z) ** 2 <= reach) return true;
    }
    const pickups = frame.pickups;
    for (let i = 0; i < pickups.size; i++) {
      const pickup = pickups.at(i);
      if ((pickup.x - x) ** 2 + (pickup.z - z) ** 2 <= reach) return true;
    }
    return false;
  }

  /**
   * §4.1: the wind (0 under reduce motion, the next frame it changes), the
   * view clock, and the head cut-out — off with no living player or no
   * `screen` (53-n).
   */
  #syncFoliage(frame: SurfaceFrame, playerGround: number): void {
    const wind = this.reduceMotion ? 0 : this.#windAmplitude;
    this.#wind = wind;
    const foliage = this.#foliageMaterial;
    if (foliage !== null) {
      const uniforms = foliageUniforms(foliage);
      uniforms.uWind.value = wind;
      uniforms.uTime.value = frame.time;
      const cutout = uniforms.uCutout.value;
      const p = frame.player;
      const screen = frame.screen;
      if (!p.alive || screen === undefined) {
        cutout.set(0, 0, 0, 0);
      } else {
        this.#head.set(p.x, playerGround + CUTOUT_HEAD_LIFT, p.z);
        cutoutUniform(screen.camera, this.#head, screen.width, screen.height, cutout);
      }
    }
    const cover = this.#coverMaterial;
    if (cover !== null) {
      const uniforms = foliageUniforms(cover);
      uniforms.uWind.value = wind;
      uniforms.uTime.value = frame.time;
    }
  }

  /** E82: the trees below full opacity — `sceneInfo.canopyFaded`. */
  get canopyFaded(): number {
    return this.#canopyFaded;
  }

  /** E82: the trees within range whose canopy holds an enemy or a pickup — `sceneInfo.canopyHolders`. */
  get canopyHolders(): number {
    return this.#canopyHeldCount;
  }

  /** §4.5: the cover clumps drawn now — `sceneInfo.coverDrawn`. */
  get coverDrawn(): number {
    return this.#cover?.drawn ?? 0;
  }

  /** §4.1: 1 while the trees draw their LOD1 (`low`), else 0 — `sceneInfo.treeLod`. */
  get treeLod(): number {
    return this.#preset === 'low' ? 1 : 0;
  }

  /** §4.1, 53-a: `glb` once the trees draw through the seam — `sceneInfo.treeSource`. */
  get treeSource(): 'glb' | 'procedural' {
    const trees = this.#trees;
    return trees !== null && trees.layers.length > 0 && trees.layers.every((layer) => layer.lods !== null) ? 'glb' : 'procedural';
  }

  /** §4.1: the sway at the crown top in force, 0 under reduce motion — `sceneInfo.wind`. */
  get wind(): number {
    return this.#wind;
  }

  /** §4.6: the seam's line, where the look has one — `sceneInfo.seamAt`. */
  get seamAt(): number | null {
    return this.#seamAt;
  }

  /**
   * §4.10: the triangles the foliage draws now — trees and their glows,
   * undergrowth, cover and contact shadows, each as instances drawn ×
   * triangles an instance.
   */
  get foliageTris(): number {
    let triangles = 0;
    const count = (layer: CulledInstances | null): void => {
      if (layer !== null && layer.mesh.visible) triangles += layer.mesh.count * trianglesOf(layer.mesh.geometry);
    };
    for (const layer of this.#trees?.layers ?? []) {
      count(layer.body);
      count(layer.glow);
    }
    count(this.#undergrowth);
    count(this.#contact);
    triangles += this.coverDrawn * (this.#cover?.trianglesPerClump ?? 0);
    return triangles;
  }

  /** §4.10: those layers with an instance drawn — `sceneInfo.foliageDraws`. */
  get foliageDraws(): number {
    let draws = 0;
    const count = (layer: CulledInstances | null): void => {
      if (layer !== null && layer.mesh.visible && layer.mesh.count > 0) draws++;
    };
    for (const layer of this.#trees?.layers ?? []) {
      count(layer.body);
      count(layer.glow);
    }
    count(this.#undergrowth);
    count(this.#contact);
    if (this.coverDrawn > 0) draws++;
    return draws;
  }

  /**
   * SPEC-035 §4.5 / SPEC-053 §4.1: whether occluder `index` still fades — a
   * tree drawn through the foliage seam never does; the cut-out does its work.
   */
  occluderFades(index: number): boolean {
    const target = this.#occluderTargets[index];
    return target !== undefined && !(target.kind === 'instance' && this.#isFoliage(target.layer));
  }

  // ------------------------------------------------------- SPEC-046 §4.8

  /**
   * The salvager's tug on the pad: a clone of the boot set's ship, nose toward
   * +z, its lowest vertex on the slab's top face. Its materials are the
   * cache's and are never written — a fade swaps in per-view clones. The
   * collision circle is the scene's (`tugObstacle`); this is only the look.
   */
  #buildTug(assets: Assets | undefined, shadows: boolean): void {
    const pad = this.#pad;
    if (pad === null || assets === undefined || !assets.hasModel('ship')) return;
    const ship = assets.model('ship');
    ship.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(ship);
    if (bounds.isEmpty()) return;
    ship.name = 'tug';
    ship.rotation.y = 0;
    ship.scale.setScalar(TUG_SCALE);
    ship.position.set(pad.x, this.field.heightAt(pad.x, pad.z) + PAD_TOP - bounds.min.y * TUG_SCALE, pad.z);
    const parts: FadePart[] = [];
    ship.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      this.#tugMeshes.push(mesh);
      if (!Array.isArray(mesh.material)) parts.push({ mesh, base: mesh.material, faded: null });
    });
    this.#envRoot.add(ship);
    this.#tug = ship;
    // SPEC-035 §4.5: it stands between the camera and a salvager behind it.
    this.#occluders.push({
      x: pad.x,
      z: pad.z,
      radius: TUG_FADE_RADIUS,
      height: PAD_TOP + (bounds.max.y - bounds.min.y) * TUG_SCALE,
    });
    this.#occluderTargets.push({ kind: 'mesh', parts });
  }

  /** SPEC-046 §4.8: the tug is on the pad — `sceneInfo.tug`. */
  get tugDrawn(): boolean {
    return this.#tug !== null;
  }

  // ------------------------------------------------------- SPEC-048 §4.8

  /**
   * A scavenger body at `(x, z)`, on the ground, facing `facing`. It stays
   * until the view is disposed. False — and nothing placed — when the boot
   * set's character model is not in: a body is scenery, never a requirement.
   */
  addScavBody(x: number, z: number, facing: number): boolean {
    const assets = this.#assets;
    if (assets === undefined || !assets.loaded || !assets.hasModel('character')) return false;
    try {
      this.#scavBodies.push(new ScavBody(this.#envRoot, assets, x, z, facing, this.#shadowsOn, this.field.heightAt(x, z)));
      return true;
    } catch (cause) {
      log.warn('view', 'the scav body could not be built', cause);
      return false;
    }
  }

  /** SPEC-048 §4.8: the bodies on the ground — `sceneInfo.scavBodies`. */
  get scavBodies(): number {
    return this.#scavBodies.length;
  }

  // ------------------------------------------------------- SPEC-046 §4.6

  /**
   * Called by the scene with the camera it placed: the look-at point, the live
   * distance, the field of view, the aspect and the frustum. The culled layers
   * refresh when the target has moved `CULL_REFRESH_DISTANCE` since the last
   * refresh, when the distance, field of view or aspect changed, or when a
   * layer was built or rebuilt since — and when a corner of the ground the
   * frustum sees has drifted that far, which a look-ahead swinging round a
   * turn does while the target itself moves less. A steady frame is a handful
   * of comparisons.
   */
  setView(targetX: number, targetZ: number, camDistance: number, fovDeg: number, aspect: number, frustum: THREE.Frustum): void {
    // SPEC-054 §4.4: below, the cave's walls are what the camera culls.
    this.#cave?.setView(targetX, targetZ, camDistance, fovDeg, aspect, frustum);
    const view = this.#cullView;
    view.frustum = frustum;
    let stale =
      this.#cullDirty ||
      Math.hypot(targetX - view.x, targetZ - view.z) >= CULL_REFRESH_DISTANCE ||
      camDistance !== view.distance ||
      fovDeg !== view.fov ||
      aspect !== view.aspect;
    const corners = this.#viewCorners;
    const seen = frustumGroundCorners(frustum, corners);
    if (!stale && seen) {
      const last = this.#cullCorners;
      for (let i = 0; i < 8 && !stale; i += 2) {
        const dx = (corners[i] as number) - (last[i] as number);
        const dz = (corners[i + 1] as number) - (last[i + 1] as number);
        stale = dx * dx + dz * dz >= CULL_REFRESH_DISTANCE * CULL_REFRESH_DISTANCE;
      }
    }
    if (!stale) return;
    view.x = targetX;
    view.z = targetZ;
    view.distance = camDistance;
    view.fov = fovDeg;
    view.aspect = aspect;
    if (seen) this.#cullCorners.set(corners);
    this.#refreshCulled();
  }

  /**
   * Every culled layer against the last view: the rig's rect grown by the
   * layer's margin (and by its shadow on `high`, 46-h), widened to whatever
   * the frustum itself sees on the ground — the camera turns toward its
   * look-ahead — then the sphere test. A view never given one keeps drawing
   * everything.
   */
  #refreshCulled(): void {
    const view = this.#cullView;
    const frustum = view.frustum;
    if (frustum === null) return;
    const started = performance.now();
    const rect = this.#cullRect;
    for (let i = 0; i < this.#culled.length; i++) {
      const layer = this.#culled[i] as CulledInstances;
      const shadow = layer.maxHeight * this.#shadowReach;
      const margin = cullMargin(layer.maxRadius, layer.maxHeight, view.fov) + shadow;
      viewRect(view, view.distance, view.fov, view.aspect, margin, rect);
      extendByFrustum(frustum, margin, rect);
      layer.refresh(rect, frustum, CULL_REFRESH_DISTANCE + shadow);
    }
    // SPEC-053 §4.5: the cover's cells, the rect grown by a clump's metre.
    const cover = this.#cover;
    if (cover !== null) {
      const margin = 1 + CULL_REFRESH_DISTANCE;
      viewRect(view, view.distance, view.fov, view.aspect, margin, this.#coverRect);
      extendByFrustum(frustum, margin, this.#coverRect);
      cover.refresh(this.#coverRect, frustum);
    }
    this.#cullMs = Math.round((performance.now() - started) * 100) / 100;
    this.#cullDirty = false;
  }

  /** SPEC-046 §4.6: instances the culled layers draw now — `sceneInfo.instancesDrawn`. */
  get instancesDrawn(): number {
    let drawn = 0;
    for (let i = 0; i < this.#culled.length; i++) drawn += (this.#culled[i] as CulledInstances).drawn;
    return drawn;
  }

  /** SPEC-046 §4.6: the last refresh's time, in ms to two decimals — `sceneInfo.cullMs`. */
  get cullMs(): number {
    return this.#cullMs;
  }

  // ------------------------------------------------------- SPEC-035 §4.5

  /**
   * SPEC-035 §4.5 — every prop that could hide the player, as the pure
   * `occludes` of SPEC-035 §3 sees it: outcrops, scatter props, landmarks and
   * the cave and wreck bodies. The array is built once and never replaced, so
   * the scene can keep a parallel flag buffer of the same length.
   */
  get occluderProps(): readonly OccluderProp[] {
    return this.#occluders;
  }

  /** §4.5: how many props are currently faded — what `sceneInfo.occluders` reports. */
  get fadedOccluders(): number {
    return this.#fadedOccluders;
  }

  /**
   * §4.5 — which candidates are occluding right now (`1`), and what a faded one
   * fades to. `SurfaceScene` recomputes the flags every 0.1 s with `occludes`;
   * `sync` then walks the fades toward their targets over
   * `OCCLUDER_FADE_SECONDS`, each way.
   */
  setOccluding(flags: Uint8Array, opacity: number): void {
    this.#occluding = flags;
    this.#occluderOpacity = opacity;
  }

  /** §4.5: one fade step, called from `sync`. Allocates nothing. */
  #stepOccluders(dt: number): void {
    const count = this.#occluders.length;
    if (count === 0) return;
    if (this.#occluderFade.length !== count) this.#occluderFade = new Float32Array(count).fill(1);
    const step = dt <= 0 ? 0 : dt / OCCLUDER_FADE_SECONDS;
    let faded = 0;
    for (let i = 0; i < count; i++) {
      // SPEC-053 §4.1: a tree drawn through the foliage seam never fades
      // here — the head cut-out does that work, and the canopy fade (E82)
      // owns its instance fade.
      const fades = (this.#occluding[i] ?? 0) === 1 && this.occluderFades(i);
      const target = fades ? this.#occluderOpacity : 1;
      const from = this.#occluderFade[i] as number;
      let value = from;
      if (from < target) value = Math.min(target, from + step);
      else if (from > target) value = Math.max(target, from - step);
      if (value !== from) {
        this.#occluderFade[i] = value;
        this.#writeFade(i, value);
      }
      if (value < 1) faded++;
    }
    this.#fadedOccluders = faded;
    // §4.14: one flag flip on the two shared body materials, together, however
    // many props fade (SPEC-046 §4.1).
    const wantTransparent = faded > 0;
    if (wantTransparent !== this.#propsTransparent) {
      this.#propsTransparent = wantTransparent;
      this.#glbMaterial.transparent = wantTransparent;
      this.#glbMaterial.depthWrite = !wantTransparent;
      this.#accentMaterial.transparent = wantTransparent;
      this.#accentMaterial.depthWrite = !wantTransparent;
    }
  }

  /**
   * §4.5: an instance's fade in its culled layer — the master always, the slot
   * while it is drawn (SPEC-046 §4.6) — or a whole mesh's own material clone.
   */
  #writeFade(index: number, value: number): void {
    const target = this.#occluderTargets[index];
    if (target === undefined) return;
    if (target.kind === 'instance') {
      // SPEC-053 §4.1: foliage-drawn trees are the cut-out's, not this fade's.
      if (this.#isFoliage(target.layer)) return;
      target.layer?.setFade(target.index, value);
      return;
    }
    for (const part of target.parts) {
      if (value >= 1) {
        part.mesh.material = part.base;
        continue;
      }
      if (part.faded === null) {
        const clone = part.base.clone();
        clone.transparent = true;
        clone.depthWrite = false;
        part.faded = clone;
      }
      part.faded.opacity = value;
      part.mesh.material = part.faded;
    }
  }

  sync(frame: SurfaceFrame): void {
    const p = frame.player;
    const ground = this.#ground;
    // The clock `setGuide` animates the pillar and the route wave on (§4.4).
    this.#guideTime = frame.time;
    // SPEC-035 §4.5: props between the camera and the salvager fade out of the
    // way; the scene decided which ones, this walks the fades.
    this.#stepOccluders(frame.dt);
    const playerGround = ground(p.x, p.z);
    // SPEC-053 §4.1: the foliage's wind, clock and cut-out, then E82's canopy fade.
    this.#syncFoliage(frame, playerGround);
    this.#stepCanopies(frame);
    this.#player.visible = p.alive;
    this.#player.position.set(p.x, playerGround, p.z);
    this.#player.rotation.y = -p.facing;
    if (this.#character === null) {
      const blinking = p.invulnUntil > frame.time && Math.sin(frame.time * 30) > 0;
      this.#playerMaterial.opacity = blinking ? 0.35 : 1;
    } else {
      // SPEC-019 §4.1: animation, facing and the blink live in the view;
      // `dt` is 0 during hit-stop, so the mixer holds with the frame.
      this.#character.sync(p, frame.time, frame.dt, playerGround);
    }

    // §4.5: the key and its target ride the player along the look's sun
    // direction, so the 68 m shadow camera always covers what is on screen.
    this.#key.position.set(
      p.x + this.#sunDir.x * KEY_DISTANCE,
      this.#sunDir.y * KEY_DISTANCE,
      p.z + this.#sunDir.z * KEY_DISTANCE,
    );
    this.#keyTarget.position.set(p.x, 0, p.z);

    // SPEC-019 §4.8: the follower view is built on first sight, from the
    // definition's model id; the procedural probe is the fallback (19-l).
    const follower = frame.follower;
    if (follower !== null && this.#followerView === null) {
      this.#followerView = new FollowerView(this.#actorRoot, this.#assets, follower.def?.model ?? 'procedural');
    }
    this.#followerView?.sync(follower, frame.time, follower === null ? 0 : ground(follower.x, follower.z));

    this.enemies.sync(frame.enemies, frame.time, ground);

    // Nodes: fill drives crystal height (AC-24); a harvested node glows white.
    frame.nodes.forEach((node, i) => {
      const fill = node.capacity <= 0 ? 0 : node.remaining / node.capacity;
      nodeCrystalScale(fill, scratchScale);
      scratchMatrix.makeScale(scratchScale.x, scratchScale.y, scratchScale.z);
      scratchMatrix.setPosition(node.x, ground(node.x, node.z), node.z);
      this.#nodeCrystals.setMatrixAt(i, scratchMatrix);
      scratchColor.set(RESOURCE_COLORS[node.resource]);
      if (node.harvesting) scratchColor.lerp(scratchColor.clone().set('#ffffff'), 0.4 + 0.2 * Math.sin(frame.time * 8));
      this.#nodeCrystals.setColorAt(i, scratchColor);
    });
    this.#nodeCrystals.instanceMatrix.needsUpdate = true;
    if (this.#nodeCrystals.instanceColor !== null) this.#nodeCrystals.instanceColor.needsUpdate = true;

    // The splat shader's animated crack pulse (§4.4) and the pad ring pulse.
    terrainUniforms(this.#groundMaterial).uTime.value = frame.time;
    const pad = this.#pad;
    const onPad = pad !== null && p.alive && Math.hypot(p.x - pad.x, p.z - pad.z) <= 6;
    this.#padGlowMaterial.emissiveIntensity = onPad ? 1.6 + 0.8 * Math.sin(frame.time * 4) : 1.2;

    this.#syncLightning(frame.time);
    this.#storm.sync(p.x, p.z, frame.time, ground);
    // SPEC-054 §4.5: the flashlight aims along the facing, eased; §4.4: the cave's dust drifts.
    this.#flashlight?.sync(p.x, p.z, p.facing, frame.dt);
    this.#cave?.sync(p.x, p.z, frame.time);
    this.#fx.sync(frame.time, ground);
    if (frame.telegraphs !== undefined) {
      this.#telegraphs.sync(frame.telegraphs.pool, frame.telegraphs.time, ground, this.reduceMotion);
    }
    this.#syncPickups(frame);
    this.#syncProjectiles(frame);
    this.#syncDeployables(frame);
    this.#syncBlobs(frame);
  }

  /** SPEC-019 §4.6: the scene raises bursts here; views never subscribe. */
  get fx(): CombatFx {
    return this.#fx;
  }

  /**
   * §4.9: for radiation and spore storms the hemisphere jumps ×4 for two
   * frames when the 2.5 s window's roll passes; a no-op under reduce motion.
   */
  #syncLightning(time: number): void {
    const kind = this.#particleKind;
    let flash = false;
    if (!this.reduceMotion && (kind === 'ash' || kind === 'spores') && this.#particleIntensity > 0.02) {
      const tick = Math.floor(time / LIGHTNING_WINDOW);
      flash =
        hash01(this.#lightningSeed, tick) < 0.15 * this.#particleIntensity &&
        time - tick * LIGHTNING_WINDOW < LIGHTNING_FLASH_SECONDS;
    }
    this.#hemi.intensity = this.#hemiLevel * (flash ? 4 : 1);
  }

  /** §4.6: player, follower and every live enemy, in one instanced layer. */
  #syncBlobs(frame: SurfaceFrame): void {
    const mesh = this.#blobs;
    let n = 0;
    const write = (x: number, z: number, scale: number): void => {
      if (n >= BLOB_CAPACITY) return;
      scratchMatrix.makeScale(scale, 1, scale);
      scratchMatrix.setPosition(x, this.#ground(x, z), z);
      mesh.setMatrixAt(n, scratchMatrix);
      n++;
    };
    const p = frame.player;
    if (p.alive) write(p.x, p.z, BLOB_SCALE_PLAYER);
    const follower = frame.follower;
    if (follower !== null && follower.alive) write(follower.x, follower.z, BLOB_SCALE_FOLLOWER);
    for (let i = 0; i < frame.enemies.size; i++) {
      const e = frame.enemies.at(i);
      // Exactly the enemies `EnemyMeshes` draws: a corpse and a burrowed wurm
      // have nothing on the ground to cast from.
      if (e.state === 'dead' || isBuried(e)) continue;
      write(e.x, e.z, e.def.look.scale * BLOB_SCALE_ENEMY * (e.elite ? BLOB_SCALE_ELITE : 1));
    }
    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) mesh.instanceMatrix.needsUpdate = true;
  }

  #syncPickups(frame: SurfaceFrame): void {
    const pool = frame.pickups;
    const counts = { resource: 0, item: 0, gear: 0 };
    // First pass writes matrices per kind directly — one walk, three meshes.
    for (const kind of ['resource', 'item', 'gear'] as const) {
      const mesh = this.#pickupMeshes[kind];
      let n = 0;
      for (let i = 0; i < pool.size; i++) {
        const pickup = pool.at(i);
        if (pickup.kind !== kind || n >= mesh.instanceMatrix.count) continue;
        const bob = 0.4 + Math.sin(frame.time * 3 + pickup.seed) * 0.12;
        scratchMatrix.makeRotationY(frame.time + pickup.seed);
        scratchMatrix.setPosition(pickup.x, bob + this.#ground(pickup.x, pickup.z), pickup.z);
        mesh.setMatrixAt(n, scratchMatrix);
        mesh.setColorAt(n, scratchColor.set(kind === 'resource' ? RESOURCE_COLORS[pickup.resource] : '#8ad7ff'));
        n++;
      }
      counts[kind] = n;
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  /**
   * SPEC-019 §4.5: capsule heads oriented along velocity, two trailing ghosts
   * each at `p − v · 0.03` / `p − v · 0.06`. A zero-velocity shot (spawned
   * this frame) takes its yaw from the owner's facing and its ghosts collapse
   * onto the head (19-j).
   */
  #syncProjectiles(frame: SurfaceFrame): void {
    const pool = frame.projectiles;
    const heads = this.#projectileMesh;
    const ghosts = this.#ghostMesh;
    const headCount = Math.min(pool.size, heads.instanceMatrix.count);
    let ghostCount = 0;
    for (let i = 0; i < headCount; i++) {
      const shot = pool.at(i);
      const speed = Math.hypot(shot.vx, shot.vz);
      const yaw = speed > 0 ? -Math.atan2(shot.vz, shot.vx) : -(shot.owner === 'enemy' ? 0 : frame.player.facing);
      const bulk = Math.max(0.12, shot.radius) / 0.12;
      let y = 0.9 + this.#ground(shot.x, shot.z);
      // SPEC-029 §4.6: a lob arcs — `0.9 + h + 4·H·t·(1−t)` with
      // `H = min(4, 0.25 · distance)` and `t = 1 − ttl / flight`.
      if (shot.lob && shot.flight > 0) {
        const t = Math.min(1, Math.max(0, 1 - shot.ttl / shot.flight));
        const arc = Math.min(LOB_ARC_MAX, LOB_ARC_PER_METRE * speed * shot.flight);
        y += 4 * arc * t * (1 - t);
      }
      scratchPosition2.set(shot.x, y, shot.z);
      scratchQuat.setFromAxisAngle(Y_AXIS, yaw);
      scratchScale2.set((0.6 + 0.02 * speed) * bulk, bulk, bulk);
      scratchMatrix.compose(scratchPosition2, scratchQuat, scratchScale2);
      heads.setMatrixAt(i, scratchMatrix);
      scratchColor.set(shot.owner === 'enemy' ? '#7fff8a' : '#ffe9a0');
      heads.setColorAt(i, scratchColor2.copy(scratchColor).multiplyScalar(PROJECTILE_GAIN));
      for (const [lag, gain] of GHOST_TRAIL) {
        if (ghostCount >= ghosts.instanceMatrix.count) break;
        scratchPosition2.set(shot.x - shot.vx * lag, y, shot.z - shot.vz * lag);
        scratchMatrix.compose(scratchPosition2, scratchQuat, scratchScale2);
        ghosts.setMatrixAt(ghostCount, scratchMatrix);
        ghosts.setColorAt(ghostCount, scratchColor2.copy(scratchColor).multiplyScalar(gain));
        ghostCount++;
      }
    }
    heads.count = headCount;
    heads.visible = headCount > 0;
    ghosts.count = ghostCount;
    ghosts.visible = ghostCount > 0;
    if (headCount > 0) {
      heads.instanceMatrix.needsUpdate = true;
      if (heads.instanceColor !== null) heads.instanceColor.needsUpdate = true;
    }
    if (ghostCount > 0) {
      ghosts.instanceMatrix.needsUpdate = true;
      if (ghosts.instanceColor !== null) ghosts.instanceColor.needsUpdate = true;
    }
  }

  /**
   * SPEC-029 §4.12: the deployables — one instanced mesh. A mine is a 0.35 m
   * disc whose light blinks every 0.5 s once armed; a charge is a 0.3 m box
   * that blinks every 0.25 s through its last second.
   */
  #syncDeployables(frame: SurfaceFrame): void {
    const mesh = this.#deployableMesh;
    const pool = frame.deployables;
    const count = Math.min(pool.size, mesh.instanceMatrix.count);
    for (let i = 0; i < count; i++) {
      const d = pool.at(i);
      const mine = d.kind === 'mine';
      const y = this.#ground(d.x, d.z);
      scratchPosition2.set(d.x, y + (mine ? 0.04 : 0.15), d.z);
      scratchQuat.identity();
      if (mine) scratchScale2.set(0.35, 0.08, 0.35);
      else scratchScale2.set(0.3, 0.3, 0.3);
      scratchMatrix.compose(scratchPosition2, scratchQuat, scratchScale2);
      mesh.setMatrixAt(i, scratchMatrix);
      let lit = false;
      if (mine) {
        lit = d.armed && Math.floor(frame.time / MINE_BLINK_SECONDS) % 2 === 0;
      } else {
        const left = d.fuseAt - frame.time;
        lit = left <= 1 ? Math.floor(frame.time / CHARGE_BLINK_SECONDS) % 2 === 0 : true;
      }
      mesh.setColorAt(i, scratchColor2.setScalar(lit ? 2.2 : 0.55));
    }
    mesh.count = count;
    mesh.visible = count > 0;
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** SPEC-038 §4.11: the draws the telegraph layer added on the last frame (≤ 3). */
  get telegraphDraws(): number {
    return this.#telegraphs.drawCalls;
  }

  dispose(): void {
    // SPEC-054 §4.5: the flashlight's light, cookie and shadow map go with the view.
    this.#flashlight?.dispose();
    this.#flashlight = null;
    this.#cave = null;
    this.enemies.dispose();
    this.#storm.dispose();
    this.#fx.dispose();
    // SPEC-053: the cover's mesh, the LOD geometry a foliage layer is not
    // drawing (the walk below frees the one it is), and the clump materials.
    this.#cover?.dispose();
    this.#cover = null;
    for (const layer of this.#trees?.layers ?? []) {
      if (layer.lods === null) continue;
      for (const geometry of [layer.lods.body, layer.lods.lod1]) if (geometry !== layer.body.mesh.geometry) geometry.dispose();
    }
    this.#foliageMaterial?.dispose();
    this.#coverMaterial?.dispose();
    this.#landmarkMaterial.dispose();
    this.#telegraphs.dispose();
    this.#character?.dispose();
    this.#character = null;
    this.#followerView?.dispose();
    this.#followerView = null;
    for (const body of this.#scavBodies.splice(0)) body.dispose();
    this.#scene.remove(this.#root);
    disposeObject3D(this.#root);
    // The guidance meshes are built on demand, so `disposeObject3D` only reaches
    // their materials on a visit that had guidance up; disposing them here is
    // idempotent and covers the visit that never resolved a target.
    this.#pillarMaterial.dispose();
    this.#routeMaterial.dispose();
    // §4.5: a landmark's (or the tug's) fade clone sits on its mesh only while
    // it is faded, so the walk above misses the one that already faded back —
    // one clone per mesh that ever occluded the salvager. The tug's own
    // materials are the asset cache's, which the walk leaves alone.
    for (const target of this.#occluderTargets) {
      if (target.kind !== 'mesh') continue;
      for (const part of target.parts) {
        part.faded?.dispose();
        part.faded = null;
      }
    }
    // Both body materials, whichever of them no kind ended up drawing with.
    this.#glbMaterial.dispose();
    this.#accentMaterial.dispose();
    // SPEC-040 AC-27: the key's shadow map is a render target three allocates
    // on the first shadow pass — a colour and a depth texture, which the walk
    // above cannot see. Left alone, every visit on `high` kept both on the GPU.
    this.#key.dispose();
    this.#clearEnvironment();
    this.#scene.fog = null;
    this.#scene.background = null;
  }
}
