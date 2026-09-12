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
import * as THREE from 'three';
import { disposeObject3D } from '@/core/Disposer';
import type { Assets } from '@/core/Assets';
import { buildHeightField, type HeightField } from '@/core/HeightField';
import { log } from '@/core/Log';
import { hash01 } from '@/core/Noise';
import { hash32 } from '@/core/Rng';
import type { Look, QualityPreset, QualitySettings } from '@/core/Quality';
import type { Pool } from '@/core/Pool';
import type { PlanetDef, ResourceId } from '@/data/index';
import type { EnemyEntity } from '@/entities/Enemy';
import type { FollowerEntity } from '@/entities/Follower';
import type { PlayerEntity } from '@/entities/Player';
import type { ProjectileEntity } from '@/entities/Projectile';
import { CharacterView } from '@/views/CharacterView';
import { CombatFx } from '@/views/CombatFx';
import { buildEnvironment, skyParamsFor } from '@/views/Environment';
import { FollowerView } from '@/views/FollowerView';
import { EnemyMeshes, INSTANCES_PER_PART } from '@/views/ProceduralMeshes';
import { groundLayer, type GroundLayer } from '@/views/ProceduralTextures';
import { buildScatter, buildDecals } from '@/views/Scatter';
import {
  boundaryGeometry,
  obstacleGeometry,
  poiGeometry,
  type ObstacleKind,
  type PoiKind,
} from '@/views/SurfaceProps';
import { StormParticles, STORM_LOOK, type ParticleKind } from '@/views/StormParticles';
import { buildTerrainTiles, createTerrainMaterial, setTerrainLayers, terrainUniforms } from '@/views/TerrainMesh';

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

export interface ViewLayout {
  /** The pinned layout hash — the seed every decoration stream derives from. */
  hash: number;
  halfSize: number;
  pois: readonly { kind: PoiKind; x: number; z: number; radius: number }[];
  obstacles: readonly { x: number; z: number; radius: number; kind: ObstacleKind }[];
  nodes: readonly { resource: ResourceId; x: number; z: number }[];
  props: readonly { x: number; z: number; rot: number; scale: number; kind: string }[];
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
  pickups: Pool<ViewPickup>;
  nodes: readonly ViewNode[];
  /** The wurm's resurface telegraph, or `null`. */
  telegraph: { x: number; z: number } | null;
  time: number;
  /** The rendered-frame delta; 0 while hit-stop freezes the view (SPEC-019 §4.7). */
  dt: number;
}

// ------------------------------------------------------------- SPEC-019 §4.7

/** One camera shake: amplitude decays to zero at `until` over `duration`. */
export interface ShakeState {
  amplitude: number;
  until: number;
  duration: number;
}

/**
 * §4.7, pure so `tests/views/` can pin it: the decaying offset, deterministic
 * from view time; reduce motion forces it to zero (19-g).
 */
export function shakeOffset(shake: ShakeState, time: number, reduceMotion: boolean, out: THREE.Vector3): void {
  if (reduceMotion || shake.duration <= 0 || time >= shake.until) {
    out.set(0, 0, 0);
    return;
  }
  const decay = Math.min(1, Math.max(0, (shake.until - time) / shake.duration));
  out.set(Math.sin(37 * time), 0, Math.cos(29 * time)).multiplyScalar(shake.amplitude * decay);
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
/** §4.5: projectile head/ghost instancing caps. */
const PROJECTILE_CAPACITY = 256;
const GHOST_CAPACITY = 512;
/** §4.5: the two trailing ghosts, seconds behind the head along −v. */
const GHOST_LAG_A = 0.03;
const GHOST_LAG_B = 0.06;
const GHOST_GAIN_A = 1.2;
const GHOST_GAIN_B = 0.6;

const RESOURCE_COLORS: Record<ResourceId, string> = {
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

/** The nearest preset for the SPEC-018 scatter cap, from the settings object. */
function presetOf(quality: QualitySettings): QualityPreset {
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
  readonly enemies: EnemyMeshes;
  /** The planet's base grade; `SurfaceScene` forwards it on enter (§4.1). */
  readonly look: Readonly<Partial<Look>>;
  /** The shared height field every ground touch samples (SPEC-018 §4.2). */
  readonly field: HeightField;
  /** 18-j / AC: the scene mirrors `settings.reduceMotion` here — no lightning. */
  reduceMotion = false;

  readonly #baseFog: number;
  #fog: THREE.FogExp2;

  /** §4.5: hemisphere fill, the look's sun as key (the caster), cool rim, torch. */
  readonly #key: THREE.DirectionalLight;
  readonly #keyTarget = new THREE.Object3D();
  readonly #hemi: THREE.HemisphereLight;
  readonly #hemiBase: number;
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
  readonly #telegraph: THREE.Mesh;
  readonly #arenaRing: THREE.Mesh;
  #fx: CombatFx;
  #fxCapacity: number;

  readonly #groundMaterial: THREE.MeshStandardMaterial;
  readonly #padGlowMaterial: THREE.MeshStandardMaterial;
  readonly #pad: { x: number; z: number } | null;

  readonly #nodeCrystals: THREE.InstancedMesh;
  readonly #pickupMeshes: Record<'resource' | 'item' | 'gear', THREE.InstancedMesh>;
  readonly #projectileMesh: THREE.InstancedMesh;
  readonly #ghostMesh: THREE.InstancedMesh;
  #storm: StormParticles;
  #stormCapacity: number;
  readonly #billboard: THREE.Quaternion;
  #particleKind: ParticleKind = 'none';
  #particleIntensity = 0;

  readonly #grade: ViewGrade = { vignette: 0, tint: [1, 1, 1], desaturate: 0 };

  /** The ground sampler handed to enemies and the storm — bound once (§4.3). */
  readonly #ground = (x: number, z: number): number => this.field.heightAt(x, z);

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
    scene.add(this.#root);
    const palette = planet.surface.palette;
    const look = planet.surface.look;
    this.#palette = palette;
    scene.background = new THREE.Color(palette.sky);
    this.#baseFog = planet.surface.fogDensity;
    this.#fog = new THREE.FogExp2(palette.fog, this.#baseFog);
    scene.fog = this.#fog;
    this.#lightningSeed = hash32(layout.hash, 'lightning');
    // SPEC-017 §4.1: the planet's own grade — a touch hotter and crisper than
    // the hubs, pulled 8 % toward its fog colour so each world reads different.
    this.look = {
      exposure: 1.05,
      contrast: 1.04,
      saturation: 1.05,
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
    this.#hemi = new THREE.HemisphereLight(look.light.sky, look.light.ground, look.light.ambient);
    this.#key = new THREE.DirectionalLight(look.light.sun.color, look.light.sun.intensity);
    this.#sunDir = sunDirection(look.light.sun);
    this.#key.position.set(this.#sunDir.x * KEY_DISTANCE, this.#sunDir.y * KEY_DISTANCE, this.#sunDir.z * KEY_DISTANCE);
    this.#key.target = this.#keyTarget;
    const rim = new THREE.DirectionalLight(0x7fa6ff, 0.6);
    rim.position.set(-30, 20, -24);
    this.#root.add(this.#hemi, this.#key, this.#keyTarget, rim);

    // SPEC-018 §4.3–§4.4: terrain tiles under one splat material. Procedural
    // layers first; the lazy asset drop swaps them through `setGroundTextures`.
    const [layerAId, layerBId] = look.ground.layers;
    const a: GroundLayer = { ...groundLayer(layerAId), tileMetres: look.ground.tileMetres[0] };
    const b: GroundLayer = { ...groundLayer(layerBId), tileMetres: look.ground.tileMetres[1] };
    this.#groundMaterial = createTerrainMaterial(a, b, look, palette);
    for (const tile of buildTerrainTiles(this.field, this.#groundMaterial)) this.#root.add(tile);

    // Obstacles and props: instanced per kind (§4.10), sculpted per biome
    // (SPEC-018 §4.7), glow parts as their own instanced meshes.
    const accent = new THREE.MeshStandardMaterial({
      color: palette.accent,
      flatShading: true,
      roughness: 0.85,
      metalness: 0.05,
      vertexColors: true,
    });
    const byKind = new Map<string, { x: number; z: number; scale: number; rot: number }[]>();
    for (const o of layout.obstacles) {
      const list = byKind.get(o.kind) ?? [];
      list.push({ x: o.x, z: o.z, scale: o.radius, rot: (o.x * 7 + o.z * 3) % Math.PI });
      byKind.set(o.kind, list);
    }
    for (const prop of layout.props) {
      const kind = prop.kind.replace('_small', '');
      const list = byKind.get(`${kind}#prop`) ?? [];
      list.push({ x: prop.x, z: prop.z, scale: prop.scale * 0.5, rot: prop.rot });
      byKind.set(`${kind}#prop`, list);
    }
    for (const [key, list] of byKind) {
      const small = key.endsWith('#prop');
      const kind = key.replace('#prop', '') as ObstacleKind;
      const prop = obstacleGeometry(kind, planet.biome, hash32(layout.hash, 'prop', kind), assets, small);
      const mesh = new THREE.InstancedMesh(prop.body, accent, list.length);
      list.forEach((entry, i) => {
        const h = this.field.heightAt(entry.x, entry.z);
        // 18-d: bases sit at h; procedural rocks embed half their radius. A GLB
        // prop has its origin at the base centre, so it takes no lift (§4.10).
        const lift = prop.fromModel !== true && kind === 'rock' ? entry.scale * 0.5 : 0;
        scratchMatrix.makeRotationY(entry.rot);
        scratchMatrix.scale(scratchVector.set(entry.scale, entry.scale, entry.scale));
        scratchMatrix.setPosition(entry.x, h + lift, entry.z);
        mesh.setMatrixAt(i, scratchMatrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.#root.add(mesh);
      if (prop.glow !== undefined) {
        const glow = new THREE.InstancedMesh(prop.glow, obstacleGlow(kind, planet.biome, palette.accent), list.length);
        glow.instanceMatrix.copy(mesh.instanceMatrix);
        glow.instanceMatrix.needsUpdate = true;
        glow.castShadow = false;
        this.#root.add(glow);
      }
    }

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
    let pad: { x: number; z: number } | null = null;
    for (const poi of layout.pois) {
      const prop = poiGeometry(poi.kind, planet.biome, assets);
      const mesh = new THREE.Mesh(prop.body, poiMaterial);
      mesh.name = `poi:${poi.kind}`;
      const h = this.field.heightAt(poi.x, poi.z); // ≈ 0 on flattened ground
      if (poi.kind === 'arena') mesh.scale.setScalar(poi.radius * 0.2);
      mesh.position.set(poi.x, h, poi.z);
      // The pad is flat on the ground: its own shadow would only stripe it.
      mesh.castShadow = poi.kind !== 'landing_pad';
      mesh.receiveShadow = true;
      this.#root.add(mesh);
      if (prop.glow !== undefined) {
        const glow = new THREE.Mesh(prop.glow, poi.kind === 'landing_pad' ? this.#padGlowMaterial : poiGlowMaterial);
        glow.name = `poi-glow:${poi.kind}`;
        glow.scale.copy(mesh.scale);
        glow.position.copy(mesh.position);
        this.#root.add(glow);
      }
      if (poi.kind === 'landing_pad') pad = { x: poi.x, z: poi.z };
    }
    this.#pad = pad;

    // SPEC-018 §4.6: scatter and decals, deterministic from the layout hash.
    for (const mesh of buildScatter(layout, this.field, look, presetOf(quality), palette)) this.#root.add(mesh);
    this.#root.add(buildDecals(layout, this.field, look));

    // SPEC-018 §4.8: the silhouette ring past the berm hides the void.
    this.#buildBoundaryRing(layout, planet);

    // The arena lock ring — visible only while a boss fight seals the arena.
    this.#arenaRing = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.15, 6, 64),
      new THREE.MeshBasicMaterial({ color: '#ff5533' }),
    );
    this.#arenaRing.rotation.x = -Math.PI / 2;
    this.#arenaRing.position.y = 0.3;
    this.#arenaRing.visible = false;
    this.#root.add(this.#arenaRing);

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
    this.#root.add(this.#nodeCrystals);

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
      this.#root.add(mesh);
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
      this.#root.add(mesh);
    }

    // SPEC-019 §4.4: the combat VFX pool, sized from the preset (19-k). Built
    // before the player group so its point light precedes the torch in
    // traversal order — instruments that walk the lights find the torch last.
    this.#billboard = cameraBillboard();
    this.#fxCapacity = Math.min(FX_CAPACITY_MAX, FX_CAPACITY_PER_PARTICLE * quality.maxParticles);
    this.#fx = new CombatFx(this.#root, this.#billboard, this.#fxCapacity);

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
    const torch = new THREE.PointLight(0xffc98a, 6, 14, 2);
    torch.position.y = 1.6;
    this.#player.add(torch);
    this.#root.add(this.#player);

    // SPEC-019 §4.1: the animated salvager replaces the capsule when the boot
    // assets are in. The player group stays — it carries the torch and is
    // positioned every frame — but the capsule and nose leave it; the
    // character root joins the view root so nothing is transformed twice.
    if (assets !== undefined && assets.loaded) {
      try {
        this.#character = new CharacterView(
          this.#root,
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

    // The wurm's resurface telegraph.
    this.#telegraph = new THREE.Mesh(
      new THREE.RingGeometry(3.4, 4, 32),
      new THREE.MeshBasicMaterial({ color: '#ff5533', side: THREE.DoubleSide }),
    );
    this.#telegraph.rotation.x = -Math.PI / 2;
    this.#telegraph.position.y = 0.05;
    this.#telegraph.visible = false;
    this.#root.add(this.#telegraph);

    // Storm sprites (SPEC-018 §4.9): instanced quads, camera-fixed billboard.
    this.#stormCapacity = quality.maxParticles;
    this.#storm = new StormParticles(this.#root, this.#billboard, quality.maxParticles);

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
    this.#root.add(this.#blobs);

    this.enemies = new EnemyMeshes(this.#root, { shadows: quality.shadowMapSize > 0 });
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
    setTerrainLayers(this.#groundMaterial, a, b);
  }

  /** SPEC-018 §4.8: 80–140 instanced silhouettes on the apron, past the berm. */
  #buildBoundaryRing(layout: ViewLayout, planet: PlanetDef): void {
    const look = planet.surface.look;
    const seed = hash32(layout.hash, 'boundary');
    const perimeter = 8 * (layout.halfSize + (RING_INNER + RING_OUTER) / 2);
    const count = Math.min(RING_MAX, Math.max(RING_MIN, Math.round(perimeter / RING_SPACING)));
    const mesh = new THREE.InstancedMesh(
      boundaryGeometry(look.boundary),
      new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9, metalness: 0, vertexColors: true }),
      count,
    );
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
      mesh.setMatrixAt(i, scratchMatrix);
      const shade = 0.8 + hash01(seed, i, 4) * 0.3;
      mesh.setColorAt(i, scratchColor.setScalar(shade));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'boundary-ring';
    mesh.computeBoundingSphere();
    this.#root.add(mesh);
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
    this.#blobMaterial.opacity = size > 0 ? BLOB_OPACITY_WITH_MAP : BLOB_OPACITY_ALONE;

    // 18-p: the storm capacity is the preset's particle budget.
    if (quality.maxParticles !== this.#stormCapacity) {
      this.#storm.dispose();
      this.#stormCapacity = quality.maxParticles;
      this.#storm = new StormParticles(this.#root, this.#billboard, quality.maxParticles);
      this.#storm.set(this.#particleKind, this.#particleIntensity);
    }

    // SPEC-019 19-k: the VFX pool follows its own `min(512, 4 · maxParticles)`
    // number and is rebuilt only when a preset change moves it; live particles
    // are dropped (they live ≤ 0.8 s). The storm pool above keeps its own cap.
    const fxCapacity = Math.min(FX_CAPACITY_MAX, FX_CAPACITY_PER_PARTICLE * quality.maxParticles);
    if (fxCapacity !== this.#fxCapacity) {
      this.#fx.dispose();
      this.#fxCapacity = fxCapacity;
      this.#fx = new CombatFx(this.#root, this.#billboard, fxCapacity);
    }

    if (quality.ibl) {
      if (this.#environment === null) this.#environment = buildEnvironment(skyParamsFor(this.#palette));
      this.#scene.environment = this.#environment;
      this.#scene.environmentIntensity = ENVIRONMENT_INTENSITY;
    } else {
      this.#clearEnvironment();
    }
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
   */
  setWeather(effects: ViewWeather, intensity: number): void {
    this.#fog.density = this.#baseFog * (1 + (effects.fogMult - 1) * intensity);
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

  /** The boss arena lock ring (SPEC-011 11-e). */
  setArena(arena: { x: number; z: number; radius: number } | null): void {
    this.#arenaRing.visible = arena !== null;
    if (arena !== null) {
      this.#arenaRing.position.set(arena.x, 0.3 + this.field.heightAt(arena.x, arena.z), arena.z);
      this.#arenaRing.scale.setScalar(arena.radius);
    }
  }

  sync(frame: SurfaceFrame): void {
    const p = frame.player;
    const ground = this.#ground;
    const playerGround = ground(p.x, p.z);
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
      this.#followerView = new FollowerView(this.#root, this.#assets, follower.def?.model ?? 'procedural');
    }
    this.#followerView?.sync(follower, frame.time, follower === null ? 0 : ground(follower.x, follower.z));

    this.enemies.sync(frame.enemies, frame.time, ground);

    this.#telegraph.visible = frame.telegraph !== null;
    if (frame.telegraph !== null) {
      this.#telegraph.position.set(
        frame.telegraph.x,
        0.05 + ground(frame.telegraph.x, frame.telegraph.z),
        frame.telegraph.z,
      );
    }

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
    this.#fx.sync(frame.time, ground);
    this.#syncPickups(frame);
    this.#syncProjectiles(frame);
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
    this.#hemi.intensity = this.#hemiBase * (flash ? 4 : 1);
  }

  /** §4.6: player, follower and every live enemy, in one instanced layer. */
  #syncBlobs(frame: SurfaceFrame): void {
    const mesh = this.#blobs;
    let n = 0;
    const write = (x: number, z: number, scale: number): void => {
      if (n >= BLOB_CAPACITY) return;
      scratchMatrix.makeScale(scale, 1, scale);
      scratchMatrix.setPosition(x, this.field.heightAt(x, z), z);
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
      if (e.state === 'dead' || e.specialKind === 'burrow_dig') continue;
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
        scratchMatrix.setPosition(pickup.x, bob + this.field.heightAt(pickup.x, pickup.z), pickup.z);
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
      const y = 0.9 + this.field.heightAt(shot.x, shot.z);
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

  dispose(): void {
    this.enemies.dispose();
    this.#storm.dispose();
    this.#fx.dispose();
    this.#character?.dispose();
    this.#character = null;
    this.#followerView?.dispose();
    this.#followerView = null;
    this.#scene.remove(this.#root);
    disposeObject3D(this.#root);
    this.#clearEnvironment();
    this.#scene.fog = null;
    this.#scene.background = null;
  }
}
