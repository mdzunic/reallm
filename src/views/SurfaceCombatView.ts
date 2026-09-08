// The entity → mesh view of SPEC-011's browser verification harness
// (`scenes/SurfaceCombatDemo.ts`). Read-only over entity state, per SPEC-001
// §4: it may see `entities/` and `data/` but never `systems/` — everything it
// needs each frame arrives through `SurfaceFrame`. SPEC-012 replaces it with
// the real surface views.
//
// Enemies are procedural primitives (CLAUDE.md: no asset packs for enemies),
// one mesh + material per live entity keyed by `EnemyEntity.id`, recycled
// through a per-archetype free list so a long spawner run does not churn GPU
// buffers. Projectiles and loot orbs are index-synced arrays of small meshes.
import * as THREE from 'three';
import { disposeObject3D } from '@/core/Disposer';
import type { Pool } from '@/core/Pool';
import type { Archetype } from '@/data/enemies';
import type { EnemyEntity } from '@/entities/Enemy';
import type { PlayerEntity } from '@/entities/Player';
import type { ProjectileEntity } from '@/entities/Projectile';
import type { ObstacleCircle } from '@/entities/World';

/** What the scene hands over every frame; a structural slice of its world. */
export interface SurfaceFrame {
  player: PlayerEntity;
  enemies: Pool<EnemyEntity>;
  projectiles: Pool<ProjectileEntity>;
  orbs: readonly { x: number; z: number; kind: 'resource' | 'item' | 'gear' }[];
  time: number;
}

export interface SurfaceLook {
  palette: { ground: string; sky: string; fog: string; accent: string };
  fogDensity: number;
  halfSize: number;
  obstacles: readonly ObstacleCircle[];
  /** The boss nest ring, or `null` for a planet without one. */
  nest: { x: number; z: number; radius: number } | null;
}

const ELITE_EMISSIVE = new THREE.Color('#c9a227');
const FLASH_EMISSIVE = new THREE.Color('#ffffff');
const WINDUP_EMISSIVE = new THREE.Color('#ff5533');

interface EnemyMeshRec {
  root: THREE.Group;
  body: THREE.Mesh;
  material: THREE.MeshLambertMaterial;
  archetype: Archetype;
}

/** One shared unit geometry per archetype; instances scale to `e.radius`. */
function archetypeGeometry(archetype: Archetype): THREE.BufferGeometry {
  switch (archetype) {
    case 'swarm':
      return new THREE.SphereGeometry(1, 10, 8);
    case 'rusher':
      return new THREE.ConeGeometry(0.9, 2.4, 8);
    case 'ranged':
      return new THREE.BoxGeometry(1.4, 1.6, 1.4);
    case 'boss':
      return new THREE.SphereGeometry(1, 14, 12);
    default:
      return new THREE.CylinderGeometry(0.9, 1.1, 1.6, 8);
  }
}

export class SurfaceCombatView {
  readonly #scene: THREE.Scene;
  readonly #root = new THREE.Group();

  readonly #geometries = new Map<Archetype, THREE.BufferGeometry>();
  readonly #enemyMeshes = new Map<number, EnemyMeshRec>();
  readonly #freeLists = new Map<Archetype, EnemyMeshRec[]>();
  /** Scratch for the per-frame mark-and-sweep; reused, never reallocated. */
  readonly #seen = new Set<number>();
  readonly #stale: number[] = [];

  readonly #player: THREE.Group;
  readonly #playerMaterial: THREE.MeshLambertMaterial;
  readonly #telegraph: THREE.Mesh;

  readonly #projectileMeshes: THREE.Mesh[] = [];
  readonly #projectileGeometry = new THREE.SphereGeometry(1, 6, 5);
  readonly #playerShot = new THREE.MeshBasicMaterial({ color: '#ffe9a0' });
  readonly #enemyShot = new THREE.MeshBasicMaterial({ color: '#7fff8a' });

  readonly #orbMeshes: THREE.Mesh[] = [];
  readonly #orbGeometry = new THREE.OctahedronGeometry(0.28);
  readonly #orbMaterial = new THREE.MeshBasicMaterial({ color: '#8ad7ff' });

  constructor(scene: THREE.Scene, look: SurfaceLook) {
    this.#scene = scene;
    scene.add(this.#root);
    scene.background = new THREE.Color(look.palette.sky);
    scene.fog = new THREE.FogExp2(look.palette.fog, look.fogDensity);

    const sun = new THREE.DirectionalLight(0xfff2dd, 2);
    sun.position.set(30, 60, 20);
    this.#root.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(look.halfSize * 2, look.halfSize * 2),
      new THREE.MeshLambertMaterial({ color: look.palette.ground }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.#root.add(ground);

    // Rocks: one shared geometry and material, a mesh per obstacle circle.
    const rockGeometry = new THREE.DodecahedronGeometry(1);
    const rockMaterial = new THREE.MeshLambertMaterial({ color: look.palette.accent });
    for (const rock of look.obstacles) {
      const mesh = new THREE.Mesh(rockGeometry, rockMaterial);
      mesh.position.set(rock.x, rock.radius * 0.6, rock.z);
      mesh.scale.setScalar(rock.radius);
      this.#root.add(mesh);
    }

    if (look.nest !== null) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(look.nest.radius, 0.4, 6, 48),
        new THREE.MeshBasicMaterial({ color: look.palette.accent }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(look.nest.x, 0.1, look.nest.z);
      this.#root.add(ring);
    }

    // The player: a capsule body with a nose cone showing `facing`.
    this.#playerMaterial = new THREE.MeshLambertMaterial({ color: '#4a8ad0' });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 0.8, 3, 8), this.#playerMaterial);
    body.position.y = 0.9;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.6, 6), this.#playerMaterial);
    nose.rotation.z = -Math.PI / 2;
    nose.position.set(0.6, 0.9, 0);
    this.#player = new THREE.Group();
    this.#player.add(body, nose);
    this.#root.add(this.#player);

    // The wurm's resurface telegraph: a ground ring shown while it aims.
    this.#telegraph = new THREE.Mesh(
      new THREE.RingGeometry(3.4, 4, 32),
      new THREE.MeshBasicMaterial({ color: '#ff5533', side: THREE.DoubleSide }),
    );
    this.#telegraph.rotation.x = -Math.PI / 2;
    this.#telegraph.position.y = 0.05;
    this.#telegraph.visible = false;
    this.#root.add(this.#telegraph);
  }

  sync(frame: SurfaceFrame): void {
    this.#syncPlayer(frame);
    this.#syncEnemies(frame);
    this.#syncPool(this.#projectileMeshes, frame.projectiles.size, this.#projectileGeometry, (mesh, i) => {
      const p = frame.projectiles.at(i);
      mesh.material = p.owner === 'enemy' ? this.#enemyShot : this.#playerShot;
      mesh.position.set(p.x, 0.9, p.z);
      mesh.scale.setScalar(Math.max(0.12, p.radius));
    });
    this.#syncPool(this.#orbMeshes, frame.orbs.length, this.#orbGeometry, (mesh, i) => {
      const orb = frame.orbs[i] as { x: number; z: number };
      mesh.material = this.#orbMaterial;
      mesh.position.set(orb.x, 0.4 + Math.sin(frame.time * 3 + i) * 0.1, orb.z);
      mesh.scale.setScalar(1);
    });
  }

  #syncPlayer(frame: SurfaceFrame): void {
    const p = frame.player;
    this.#player.visible = p.alive;
    this.#player.position.set(p.x, 0, p.z);
    this.#player.rotation.y = -p.facing;
    // I-frames read as a blink; the material is the view's own, safe to write.
    const blinking = p.invulnUntil > frame.time && Math.sin(frame.time * 30) > 0;
    this.#playerMaterial.transparent = true;
    this.#playerMaterial.opacity = blinking ? 0.35 : 1;
  }

  #syncEnemies(frame: SurfaceFrame): void {
    this.#seen.clear();
    this.#telegraph.visible = false;
    const enemies = frame.enemies;
    for (let i = 0; i < enemies.size; i++) {
      const e = enemies.at(i);
      if (e.state === 'dead') continue;
      this.#seen.add(e.id);
      const rec = this.#enemyMeshes.get(e.id) ?? this.#acquire(e);
      const mat = rec.material;
      mat.color.set(e.def.look.tint);
      // Elite: gold glow; hit flash: white; windup: the red telegraph.
      if (e.hitFlash > 0) mat.emissive.copy(FLASH_EMISSIVE);
      else if (e.state === 'windup') mat.emissive.copy(WINDUP_EMISSIVE);
      else if (e.elite) mat.emissive.copy(ELITE_EMISSIVE);
      else if (e.def.look.emissive !== undefined) mat.emissive.set(e.def.look.emissive);
      else mat.emissive.setRGB(0, 0, 0);
      mat.opacity = e.invulnerable ? 0.45 : 1;

      // Swarms hop while moving (the AC-36 "hop"); windups puff up as a tell.
      let y = e.radius;
      if (rec.archetype === 'swarm' && (e.state === 'chase' || e.state === 'wander')) {
        y += Math.abs(Math.sin(frame.time * Math.PI * 3 + e.id)) * 0.5;
      }
      const scale = e.radius * (e.state === 'windup' ? 1.15 : 1);
      rec.root.position.set(e.x, y, e.z);
      rec.root.scale.setScalar(scale);
      rec.root.rotation.y = -e.facing;
      rec.root.visible = e.specialKind !== 'burrow_dig';
      if (e.specialKind === 'burrow_telegraph') {
        this.#telegraph.visible = true;
        this.#telegraph.position.set(e.wanderX, 0.05, e.wanderZ);
      }
    }
    // Sweep meshes whose entity died this step back onto the free list.
    this.#stale.length = 0;
    for (const id of this.#enemyMeshes.keys()) {
      if (!this.#seen.has(id)) this.#stale.push(id);
    }
    for (const id of this.#stale) {
      const rec = this.#enemyMeshes.get(id) as EnemyMeshRec;
      this.#enemyMeshes.delete(id);
      rec.root.visible = false;
      (this.#freeLists.get(rec.archetype) ?? this.#setFreeList(rec.archetype)).push(rec);
    }
  }

  #setFreeList(archetype: Archetype): EnemyMeshRec[] {
    const list: EnemyMeshRec[] = [];
    this.#freeLists.set(archetype, list);
    return list;
  }

  #acquire(e: EnemyEntity): EnemyMeshRec {
    const archetype = e.def.archetype;
    const free = this.#freeLists.get(archetype);
    let rec = free?.pop();
    if (rec === undefined) {
      let geometry = this.#geometries.get(archetype);
      if (geometry === undefined) {
        geometry = archetypeGeometry(archetype);
        this.#geometries.set(archetype, geometry);
      }
      const material = new THREE.MeshLambertMaterial({ transparent: true });
      const body = new THREE.Mesh(geometry, material);
      const root = new THREE.Group();
      root.add(body);
      this.#root.add(root);
      rec = { root, body, material, archetype };
    }
    rec.root.visible = true;
    this.#enemyMeshes.set(e.id, rec);
    return rec;
  }

  /** Grow-and-hide sync for the index-keyed mesh arrays (shots, orbs). */
  #syncPool(
    meshes: THREE.Mesh[],
    count: number,
    geometry: THREE.BufferGeometry,
    place: (mesh: THREE.Mesh, index: number) => void,
  ): void {
    while (meshes.length < count) {
      const mesh = new THREE.Mesh(geometry, this.#playerShot);
      this.#root.add(mesh);
      meshes.push(mesh);
    }
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i] as THREE.Mesh;
      mesh.visible = i < count;
      if (i < count) place(mesh, i);
    }
  }

  dispose(): void {
    this.#scene.remove(this.#root);
    disposeObject3D(this.#root);
    this.#scene.fog = null;
    this.#scene.background = null;
  }
}
