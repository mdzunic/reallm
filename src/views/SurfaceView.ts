// The surface world view (SPEC-012 §4.10) — entity → mesh, read-only over the
// frame the scene hands in. Budget shape: ground 1, obstacles and props
// instanced per kind, one small mesh per POI, nodes 2 instanced meshes,
// pickups 3, projectiles 1, storm particles 1, player + follower, plus the
// enemy recipe parts — ≤ 80 draw calls on medium (AC-54).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { disposeObject3D } from '@/core/Disposer';
import type { Pool } from '@/core/Pool';
import type { Look, QualitySettings } from '@/core/Quality';
import type { PlanetDef, ResourceId } from '@/data/index';
import type { EnemyEntity } from '@/entities/Enemy';
import type { FollowerEntity } from '@/entities/Follower';
import type { PlayerEntity } from '@/entities/Player';
import type { ProjectileEntity } from '@/entities/Projectile';
import { buildEnvironment, skyParamsFor } from '@/views/Environment';
import { EnemyMeshes, INSTANCES_PER_PART } from '@/views/ProceduralMeshes';

// Structural mirrors of the `systems/` shapes this view reads. Views must not
// import `systems` (SPEC-001 §4), and the scene passes the real objects — the
// compiler checks the fit at the call site.
export type ObstacleKind = 'rock' | 'ruin' | 'spire' | 'vent' | 'tree';
export type PoiKind = 'landing_pad' | 'scan' | 'reach' | 'deliver' | 'arena' | 'defend' | 'escort_start' | 'landmark';
export type ParticleKind = 'sand' | 'snow' | 'spores' | 'ash' | 'heat' | 'none';

export interface ViewWeather {
  fogMult: number;
  particles: ParticleKind;
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
}

const RESOURCE_COLORS: Record<ResourceId, string> = {
  oil: '#3a3a3a',
  wheat: '#e0c060',
  water: '#5ab8e8',
  lithium: '#c8b8ff',
};

const PARTICLE_COLORS: Record<ParticleKind, string> = {
  sand: '#e0b070',
  // 17-f: pure white snow sat above the 0.85 bloom threshold and smeared the
  // whole storm into a glow. Held just under it, it reads as snow again.
  snow: '#e6ecf2',
  spores: '#b0e080',
  ash: '#909090',
  heat: '#ffd0a0',
  none: '#ffffff',
};

const PARTICLE_COUNT = 150;
const PARTICLE_BOX = 44;

// -------------------------------------------------------- SPEC-017 §4.5–§4.7

/** The shadow-casting key light's offset from the player, in metres. */
const KEY_OFFSET = { x: 28, y: 46, z: 18 } as const;
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

const scratchMatrix = new THREE.Matrix4();
const scratchColor = new THREE.Color();

function obstacleGeometry(kind: ObstacleKind): THREE.BufferGeometry {
  switch (kind) {
    case 'rock':
      return new THREE.DodecahedronGeometry(1);
    case 'ruin':
      return new THREE.BoxGeometry(1.6, 1.2, 1.2);
    case 'spire':
      return new THREE.ConeGeometry(0.8, 2.6, 6);
    case 'vent': {
      const g = new THREE.CylinderGeometry(0.7, 1.1, 1.2, 8);
      g.translate(0, 0.6, 0);
      return g;
    }
    case 'tree': {
      const trunk = new THREE.CylinderGeometry(0.15, 0.22, 1.2, 6);
      trunk.translate(0, 0.6, 0);
      const crown = new THREE.ConeGeometry(0.9, 1.8, 7);
      crown.translate(0, 2, 0);
      return mergeGeometries([trunk, crown]);
    }
  }
}

function poiGeometry(kind: PoiKind): THREE.BufferGeometry {
  switch (kind) {
    case 'landing_pad': {
      const g = new THREE.CylinderGeometry(5, 5.4, 0.4, 16);
      g.translate(0, 0.2, 0);
      return g;
    }
    case 'scan': {
      const mast = new THREE.CylinderGeometry(0.12, 0.2, 3, 6);
      mast.translate(0, 1.5, 0);
      const dish = new THREE.SphereGeometry(0.5, 8, 6);
      dish.translate(0, 3.1, 0);
      return mergeGeometries([mast, dish]);
    }
    case 'reach': {
      const g = new THREE.ConeGeometry(0.8, 2.4, 5);
      g.translate(0, 1.2, 0);
      return g;
    }
    case 'deliver': {
      const g = new THREE.BoxGeometry(1.6, 1.6, 1.6);
      g.translate(0, 0.8, 0);
      return g;
    }
    case 'arena': {
      const g = new THREE.TorusGeometry(1, 0.04, 6, 48); // scaled to the radius
      g.rotateX(-Math.PI / 2);
      g.translate(0, 0.1, 0);
      return g;
    }
    case 'defend': {
      const base = new THREE.CylinderGeometry(1.2, 1.5, 1, 8);
      base.translate(0, 0.5, 0);
      const mast = new THREE.CylinderGeometry(0.15, 0.15, 3, 6);
      mast.translate(0, 2.5, 0);
      return mergeGeometries([base, mast]);
    }
    case 'escort_start': {
      const g = new THREE.CylinderGeometry(0.5, 0.7, 2.2, 6);
      g.translate(0, 1.1, 0);
      return g;
    }
    case 'landmark': {
      const a = new THREE.BoxGeometry(1.4, 1.8, 0.5);
      a.translate(-0.5, 0.9, 0);
      const b = new THREE.BoxGeometry(0.5, 1.1, 1.2);
      b.translate(0.7, 0.55, 0.3);
      return mergeGeometries([a, b]);
    }
  }
}

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

/** Grow-and-hide instanced sync; `place` composes into `scratchMatrix`. */
function syncInstances(mesh: THREE.InstancedMesh, count: number, place: (index: number) => void): void {
  const n = Math.min(count, mesh.instanceMatrix.count);
  for (let i = 0; i < n; i++) {
    place(i);
    mesh.setMatrixAt(i, scratchMatrix);
  }
  mesh.count = n;
  mesh.visible = n > 0;
  if (n > 0) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }
}

export class SurfaceView {
  readonly #scene: THREE.Scene;
  readonly #root = new THREE.Group();
  readonly enemies: EnemyMeshes;
  /** The planet's base grade; `SurfaceScene` forwards it on enter (§4.1). */
  readonly look: Readonly<Partial<Look>>;

  readonly #baseFog: number;
  #fog: THREE.FogExp2;

  /** §4.5: hemisphere fill, warm key (the caster), cool rim, player torch. */
  readonly #key: THREE.DirectionalLight;
  readonly #keyTarget = new THREE.Object3D();
  readonly #palette: PlanetDef['surface']['palette'];
  #environment: THREE.DataTexture | null = null;

  readonly #blobs: THREE.InstancedMesh;
  readonly #blobMaterial: THREE.MeshBasicMaterial;

  readonly #player: THREE.Group;
  readonly #playerMaterial: THREE.MeshStandardMaterial;
  readonly #follower: THREE.Mesh;
  readonly #telegraph: THREE.Mesh;
  readonly #arenaRing: THREE.Mesh;

  readonly #nodeCrystals: THREE.InstancedMesh;
  readonly #pickupMeshes: Record<'resource' | 'item' | 'gear', THREE.InstancedMesh>;
  readonly #projectileMesh: THREE.InstancedMesh;
  readonly #particles: THREE.Points;
  readonly #particleMaterial: THREE.PointsMaterial;
  readonly #particlePositions: Float32Array;
  #particleKind: ParticleKind = 'none';
  #particleIntensity = 0;

  constructor(scene: THREE.Scene, layout: ViewLayout, planet: PlanetDef, quality: QualitySettings) {
    this.#scene = scene;
    scene.add(this.#root);
    const palette = planet.surface.palette;
    this.#palette = palette;
    scene.background = new THREE.Color(palette.sky);
    this.#baseFog = planet.surface.fogDensity;
    this.#fog = new THREE.FogExp2(palette.fog, this.#baseFog);
    scene.fog = this.#fog;
    // SPEC-017 §4.1: the planet's own grade — a touch hotter and crisper than
    // the hubs, pulled 8 % toward its fog colour so each world reads different.
    this.look = {
      exposure: 1.05,
      contrast: 1.04,
      saturation: 1.05,
      tint: tintToward(new THREE.Color(palette.fog), TINT_TOWARD_FOG),
    };

    // §4.5: a hemisphere for the bounce, a warm key that follows the player and
    // carries the shadow map, a cool rim from behind, and a torch on the
    // player. No ambient — `SurfaceScene` sets `ownsLighting`.
    const hemi = new THREE.HemisphereLight(palette.sky, palette.ground, 0.55);
    this.#key = new THREE.DirectionalLight(0xffe0b8, 2.6);
    this.#key.position.set(KEY_OFFSET.x, KEY_OFFSET.y, KEY_OFFSET.z);
    this.#key.target = this.#keyTarget;
    const rim = new THREE.DirectionalLight(0x7fa6ff, 0.6);
    rim.position.set(-30, 20, -24);
    this.#root.add(hemi, this.#key, this.#keyTarget, rim);

    // Ground: one mesh (§4.10).
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(layout.halfSize * 2, layout.halfSize * 2),
      new THREE.MeshStandardMaterial({ color: palette.ground, roughness: 0.95, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.#root.add(ground);

    // Obstacles and props: instanced per kind (§4.10, ≤ 8 draw calls).
    const accent = new THREE.MeshStandardMaterial({
      color: palette.accent,
      flatShading: true,
      roughness: 0.85,
      metalness: 0.05,
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
      const kind = key.replace('#prop', '') as ObstacleKind;
      const mesh = new THREE.InstancedMesh(obstacleGeometry(kind), accent, list.length);
      list.forEach((entry, i) => {
        scratchMatrix.makeRotationY(entry.rot);
        scratchMatrix.scale(new THREE.Vector3(entry.scale, entry.scale, entry.scale));
        scratchMatrix.setPosition(entry.x, kind === 'rock' ? entry.scale * 0.5 : 0, entry.z);
        mesh.setMatrixAt(i, scratchMatrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.#root.add(mesh);
    }

    // POIs: one small mesh per instance, the arena ring scaled to its radius.
    const poiMaterial = new THREE.MeshStandardMaterial({ color: palette.accent, roughness: 0.6, metalness: 0.3 });
    const padMaterial = new THREE.MeshStandardMaterial({ color: '#7a8aa0', roughness: 0.5, metalness: 0.6 });
    for (const poi of layout.pois) {
      const mesh = new THREE.Mesh(poiGeometry(poi.kind), poi.kind === 'landing_pad' ? padMaterial : poiMaterial);
      if (poi.kind === 'arena') mesh.scale.setScalar(poi.radius);
      mesh.position.set(poi.x, 0, poi.z);
      // The pad is flat on the ground: its own shadow would only stripe it.
      mesh.castShadow = poi.kind !== 'landing_pad';
      this.#root.add(mesh);
    }

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

    // Projectiles: one instanced mesh, owner colour per instance. §4.7: the
    // base colour is pushed past 1 so `instanceColor` lands above the bloom
    // threshold and the shots actually glow; on `low` there is no bloom and the
    // clamp to white in the framebuffer is the whole effect.
    this.#projectileMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 6, 5),
      new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(PROJECTILE_GAIN) }),
      256,
    );
    this.#projectileMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#projectileMesh.setColorAt(0, scratchColor.set('#ffffff'));
    this.#projectileMesh.count = 0;
    this.#projectileMesh.frustumCulled = false;
    this.#root.add(this.#projectileMesh);

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

    // The escort probe.
    this.#follower = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 10, 8),
      new THREE.MeshStandardMaterial({ color: '#c0d8e8', roughness: 0.4, metalness: 0.6 }),
    );
    this.#follower.visible = false;
    this.#follower.castShadow = true;
    this.#root.add(this.#follower);

    // The wurm's resurface telegraph.
    this.#telegraph = new THREE.Mesh(
      new THREE.RingGeometry(3.4, 4, 32),
      new THREE.MeshBasicMaterial({ color: '#ff5533', side: THREE.DoubleSide }),
    );
    this.#telegraph.rotation.x = -Math.PI / 2;
    this.#telegraph.position.y = 0.05;
    this.#telegraph.visible = false;
    this.#root.add(this.#telegraph);

    // Storm particles: one Points cloud around the player (§4.6).
    this.#particlePositions = new Float32Array(PARTICLE_COUNT * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.#particlePositions, 3));
    this.#particleMaterial = new THREE.PointsMaterial({ size: 0.35, transparent: true, opacity: 0.8 });
    this.#particles = new THREE.Points(geometry, this.#particleMaterial);
    this.#particles.visible = false;
    this.#particles.frustumCulled = false;
    this.#root.add(this.#particles);

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
    this.#blobMaterial.opacity = size > 0 ? BLOB_OPACITY_WITH_MAP : BLOB_OPACITY_ALONE;

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

  /** Fog, overlay hue and particle look, lerped by the scene over 3 s (§4.6). */
  setWeather(effects: ViewWeather, intensity: number): void {
    this.#fog.density = this.#baseFog * (1 + (effects.fogMult - 1) * intensity);
    this.#particleKind = effects.particles;
    this.#particleIntensity = intensity;
    if (effects.particles !== 'none') {
      this.#particleMaterial.color.set(PARTICLE_COLORS[effects.particles]);
      this.#particleMaterial.opacity = 0.8 * intensity;
    }
    this.#particles.visible = effects.particles !== 'none' && intensity > 0.02;
  }

  /** The boss arena lock ring (SPEC-011 11-e). */
  setArena(arena: { x: number; z: number; radius: number } | null): void {
    this.#arenaRing.visible = arena !== null;
    if (arena !== null) {
      this.#arenaRing.position.set(arena.x, 0.3, arena.z);
      this.#arenaRing.scale.setScalar(arena.radius);
    }
  }

  sync(frame: SurfaceFrame): void {
    const p = frame.player;
    this.#player.visible = p.alive;
    this.#player.position.set(p.x, 0, p.z);
    this.#player.rotation.y = -p.facing;
    const blinking = p.invulnUntil > frame.time && Math.sin(frame.time * 30) > 0;
    this.#playerMaterial.opacity = blinking ? 0.35 : 1;

    // §4.5: the key and its target ride the player, so the 68 m shadow camera
    // always covers what is on screen.
    this.#key.position.set(p.x + KEY_OFFSET.x, KEY_OFFSET.y, p.z + KEY_OFFSET.z);
    this.#keyTarget.position.set(p.x, 0, p.z);

    const follower = frame.follower;
    this.#follower.visible = follower !== null && follower.alive;
    if (follower !== null) this.#follower.position.set(follower.x, 0.8 + Math.sin(frame.time * 2) * 0.1, follower.z);

    this.enemies.sync(frame.enemies, frame.time);

    this.#telegraph.visible = frame.telegraph !== null;
    if (frame.telegraph !== null) this.#telegraph.position.set(frame.telegraph.x, 0.05, frame.telegraph.z);

    // Nodes: fill drives crystal height (AC-24); a harvested node glows white.
    frame.nodes.forEach((node, i) => {
      const fill = node.capacity <= 0 ? 0 : node.remaining / node.capacity;
      nodeCrystalScale(fill, scratchScale);
      scratchMatrix.makeScale(scratchScale.x, scratchScale.y, scratchScale.z);
      scratchMatrix.setPosition(node.x, 0, node.z);
      this.#nodeCrystals.setMatrixAt(i, scratchMatrix);
      scratchColor.set(RESOURCE_COLORS[node.resource]);
      if (node.harvesting) scratchColor.lerp(scratchColor.clone().set('#ffffff'), 0.4 + 0.2 * Math.sin(frame.time * 8));
      this.#nodeCrystals.setColorAt(i, scratchColor);
    });
    this.#nodeCrystals.instanceMatrix.needsUpdate = true;
    if (this.#nodeCrystals.instanceColor !== null) this.#nodeCrystals.instanceColor.needsUpdate = true;

    this.#syncPickups(frame);
    this.#syncProjectiles(frame);
    this.#syncParticles(frame);
    this.#syncBlobs(frame);
  }

  /** §4.6: player, follower and every live enemy, in one instanced layer. */
  #syncBlobs(frame: SurfaceFrame): void {
    const mesh = this.#blobs;
    let n = 0;
    const write = (x: number, z: number, scale: number): void => {
      if (n >= BLOB_CAPACITY) return;
      scratchMatrix.makeScale(scale, 1, scale);
      scratchMatrix.setPosition(x, 0, z);
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
        scratchMatrix.setPosition(pickup.x, bob, pickup.z);
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

  #syncProjectiles(frame: SurfaceFrame): void {
    const pool = frame.projectiles;
    const mesh = this.#projectileMesh;
    syncInstances(mesh, pool.size, (i) => {
      const shot = pool.at(i);
      const scale = Math.max(0.12, shot.radius);
      scratchMatrix.makeScale(scale, scale, scale);
      scratchMatrix.setPosition(shot.x, 0.9, shot.z);
      mesh.setColorAt(i, scratchColor.set(shot.owner === 'enemy' ? '#7fff8a' : '#ffe9a0'));
    });
  }

  /** Deterministic drift from index + time — no random per frame (SPEC-001 §7). */
  #syncParticles(frame: SurfaceFrame): void {
    if (!this.#particles.visible) return;
    const p = frame.player;
    const half = PARTICLE_BOX / 2;
    const falling = this.#particleKind === 'snow' || this.#particleKind === 'ash' || this.#particleKind === 'spores';
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const seedA = i * 12.9898;
      const seedB = i * 78.233;
      const drift = falling ? 6 : 18;
      const x = ((seedA * 37 + frame.time * drift) % PARTICLE_BOX) - half;
      const z = ((seedB * 17 + frame.time * drift * 0.6) % PARTICLE_BOX) - half;
      const y = falling
        ? PARTICLE_BOX * 0.25 - ((seedA * 11 + frame.time * 4) % (PARTICLE_BOX * 0.25))
        : 0.5 + (Math.sin(seedB + frame.time * 2) + 1) * 2;
      this.#particlePositions[i * 3] = p.x + x;
      this.#particlePositions[i * 3 + 1] = y;
      this.#particlePositions[i * 3 + 2] = p.z + z;
    }
    (this.#particles.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    void this.#particleIntensity;
  }

  dispose(): void {
    this.enemies.dispose();
    this.#scene.remove(this.#root);
    disposeObject3D(this.#root);
    this.#clearEnvironment();
    this.#scene.fog = null;
    this.#scene.background = null;
  }
}
