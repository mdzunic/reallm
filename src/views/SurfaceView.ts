// The surface world view (SPEC-012 §4.10) — entity → mesh, read-only over the
// frame the scene hands in. Budget shape: ground 1, obstacles and props
// instanced per kind, one small mesh per POI, nodes 2 instanced meshes,
// pickups 3, projectiles 1, storm particles 1, player + follower, plus the
// enemy recipe parts — ≤ 80 draw calls on medium (AC-54).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { disposeObject3D } from '@/core/Disposer';
import type { Pool } from '@/core/Pool';
import type { PlanetDef, ResourceId } from '@/data/index';
import type { EnemyEntity } from '@/entities/Enemy';
import type { FollowerEntity } from '@/entities/Follower';
import type { PlayerEntity } from '@/entities/Player';
import type { ProjectileEntity } from '@/entities/Projectile';
import { EnemyMeshes } from '@/views/ProceduralMeshes';

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
  snow: '#ffffff',
  spores: '#b0e080',
  ash: '#909090',
  heat: '#ffd0a0',
  none: '#ffffff',
};

const PARTICLE_COUNT = 150;
const PARTICLE_BOX = 44;

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

  readonly #baseFog: number;
  #fog: THREE.FogExp2;

  readonly #player: THREE.Group;
  readonly #playerMaterial: THREE.MeshLambertMaterial;
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

  constructor(scene: THREE.Scene, layout: ViewLayout, planet: PlanetDef) {
    this.#scene = scene;
    scene.add(this.#root);
    const palette = planet.surface.palette;
    scene.background = new THREE.Color(palette.sky);
    this.#baseFog = planet.surface.fogDensity;
    this.#fog = new THREE.FogExp2(palette.fog, this.#baseFog);
    scene.fog = this.#fog;

    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(40, 70, 25);
    this.#root.add(sun, new THREE.AmbientLight(0x8899aa, 1.6));

    // Ground: one mesh (§4.10).
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(layout.halfSize * 2, layout.halfSize * 2),
      new THREE.MeshLambertMaterial({ color: palette.ground }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.#root.add(ground);

    // Obstacles and props: instanced per kind (§4.10, ≤ 8 draw calls).
    const accent = new THREE.MeshLambertMaterial({ color: palette.accent });
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
      this.#root.add(mesh);
    }

    // POIs: one small mesh per instance, the arena ring scaled to its radius.
    const poiMaterial = new THREE.MeshLambertMaterial({ color: palette.accent });
    const padMaterial = new THREE.MeshLambertMaterial({ color: '#7a8aa0' });
    for (const poi of layout.pois) {
      const mesh = new THREE.Mesh(poiGeometry(poi.kind), poi.kind === 'landing_pad' ? padMaterial : poiMaterial);
      if (poi.kind === 'arena') mesh.scale.setScalar(poi.radius);
      mesh.position.set(poi.x, 0, poi.z);
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
      new THREE.MeshLambertMaterial(),
      Math.max(1, layout.nodes.length),
    );
    layout.nodes.forEach((node, i) => this.#nodeCrystals.setColorAt(i, scratchColor.set(RESOURCE_COLORS[node.resource])));
    this.#root.add(this.#nodeCrystals);

    // Pickups: three instanced meshes (§4.10).
    const pickupMaterial = new THREE.MeshLambertMaterial();
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
      this.#root.add(mesh);
    }

    // Projectiles: one instanced mesh, owner colour per instance.
    this.#projectileMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 6, 5),
      new THREE.MeshBasicMaterial(),
      256,
    );
    this.#projectileMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#projectileMesh.setColorAt(0, scratchColor.set('#ffffff'));
    this.#projectileMesh.count = 0;
    this.#projectileMesh.frustumCulled = false;
    this.#root.add(this.#projectileMesh);

    // The player: capsule body + nose cone showing facing.
    this.#playerMaterial = new THREE.MeshLambertMaterial({ color: '#4a8ad0', transparent: true });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 0.8, 3, 8), this.#playerMaterial);
    body.position.y = 0.9;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.6, 6), this.#playerMaterial);
    nose.rotation.z = -Math.PI / 2;
    nose.position.set(0.6, 0.9, 0);
    this.#player = new THREE.Group();
    this.#player.add(body, nose);
    this.#root.add(this.#player);

    // The escort probe.
    this.#follower = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 10, 8),
      new THREE.MeshLambertMaterial({ color: '#c0d8e8' }),
    );
    this.#follower.visible = false;
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

    this.enemies = new EnemyMeshes(this.#root);
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
    this.#scene.fog = null;
    this.#scene.background = null;
  }
}
