// SPEC-064 §6.1 — the scav raiders in the salvager's suit, in node: every row
// of `raiderPose`, the pool of eight with its overflow, the fall and the fade,
// the tint, program and rim, the aim, glint and recoil, and how `SurfaceView`
// hands raiders to the view — or, with no model, builds none.
//
// The model goes through the real `Assets`, behind an injected loader (D-29),
// so every raider is the `SkeletonUtils` clone `Assets.model` makes. Its stand-in
// salvager is one skinned box on one bone, whose five clips each drive the
// bone's position somewhere of their own — reading the bone after a `sync`
// says which clip is on, and how far into it.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Assets, type AssetManifest } from '@/core/Assets';
import { setLogSink, type LogSink } from '@/core/Log';
import { Pool } from '@/core/Pool';
import { QUALITY } from '@/core/Quality';
import { ENEMIES, PLANETS } from '@/data/index';
import { makeDeployable, type DeployableEntity } from '@/entities/Deployable';
import { makeEnemy, type EnemyEntity } from '@/entities/Enemy';
import { makePlayer } from '@/entities/Player';
import { makeProjectile, type ProjectileEntity } from '@/entities/Projectile';
import {
  ELITE_GOLD,
  ELITE_SCALE,
  ELITE_TINT,
  FLASH_RIM_SCALE,
  HOSTILE_RIM_UNIFORM,
  INSTANCES_PER_PART,
  RIM_INTENSITY,
} from '@/views/ProceduralMeshes';
import { SCAV_BODY_TINT } from '@/views/ScavBody';
import {
  RAIDER_FADE,
  RAIDER_MUZZLE,
  RAIDER_POOL,
  RAIDER_TRACER,
  raiderPose,
  ScavRaiderViews,
} from '@/views/ScavRaiders';
import { shotHeadGain, SurfaceView, type SurfaceFrame, type ViewLayout, type ViewPickup } from '@/views/SurfaceView';

// ------------------------------------------------------------------ the model

/** Where each clip puts the `hips` bone: its first frame, then its last. */
const POSE = {
  idle: [0, 0, 0],
  run: [0, 1, 0],
  attackFrom: [5, 0, 0],
  attackTo: [6, 0, 0],
  hitFrom: [0, 0, 7],
  hitTo: [0, 0, 8],
  deathFrom: [0, -1, 0],
  deathTo: [0, -2, 0],
} as const;

function clip(name: string, duration: number, from: readonly number[], to: readonly number[]): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [new THREE.VectorKeyframeTrack('hips.position', [0, duration], [...from, ...to])]);
}

/** The committed model's five clips and their lengths (SPEC-019 §4.1). */
const CLIPS = [
  clip('Idle', 2, POSE.idle, POSE.idle),
  clip('Run', 0.8, POSE.run, POSE.run),
  clip('Attack', 0.5, POSE.attackFrom, POSE.attackTo),
  clip('Hit', 0.4, POSE.hitFrom, POSE.hitTo),
  clip('Death', 1.2, POSE.deathFrom, POSE.deathTo),
];

/** The template material — what the cache holds, and every clone must leave alone. */
let template: THREE.MeshStandardMaterial;

/** One skinned mesh on one bone, 1.8 m tall, like `SalvagerMesh` standing on its `hips`. */
function salvager(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'Salvager';
  const hips = new THREE.Bone();
  hips.name = 'hips';
  template = new THREE.MeshStandardMaterial({ color: '#888888', emissive: '#223344', emissiveIntensity: 2 });
  const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(0.8, 1.8, 0.6).translate(0, 0.9, 0), template);
  mesh.name = 'SalvagerMesh';
  root.add(hips, mesh);
  mesh.bind(new THREE.Skeleton([hips]));
  return root;
}

/** A model that is not the salvager: a crate, with no skin and no clips. */
function crate(): THREE.Group {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  return root;
}

const MANIFEST: AssetManifest = { models: { character: 'assets/models/character.glb' }, textures: {}, audio: {} };

/** The real registry, loaded through a fake loader; `clones` counts every `model()` it handed out. */
async function loaded(model: () => THREE.Group = salvager, clips = CLIPS): Promise<{ assets: Assets; clones: () => number }> {
  const assets = new Assets({ gltf: { loadAsync: async () => ({ scene: model(), animations: clips }) } });
  await assets.load(MANIFEST);
  let clones = 0;
  const original = assets.model.bind(assets);
  (assets as { model: Assets['model'] }).model = (id) => {
    clones++;
    return original(id);
  };
  return { assets, clones: () => clones };
}

// ---------------------------------------------------------------- the helpers

const flat = (): number => 0;

function raider(pool: Pool<EnemyEntity>, id: number, patch: Partial<EnemyEntity> = {}): EnemyEntity {
  const e = pool.alloc();
  Object.assign(e, makeEnemy(), { def: ENEMIES.scav_raider, id, state: 'wander', x: id * 3, z: -id }, patch);
  return e;
}

/** Takes enemy `id` out of the pool, as the sweep, a dismissal or a despawn does. */
function remove(pool: Pool<EnemyEntity>, id: number): void {
  for (let i = 0; i < pool.size; i++) {
    if (pool.at(i).id === id) {
      pool.free(i);
      return;
    }
  }
}

/** The raider clones under `parent`, live, falling or parked. */
function clones(parent: THREE.Object3D): THREE.Object3D[] {
  return parent.getObjectByName('scav-raiders')?.children ?? [];
}

/** The clone standing at enemy `e`'s position. */
function cloneOf(parent: THREE.Object3D, e: { x: number; z: number }): THREE.Object3D {
  const found = clones(parent).find((root) => root.visible && root.position.x === e.x && root.position.z === e.z);
  if (found === undefined) throw new Error(`no clone at ${e.x}, ${e.z}`);
  return found;
}

function hipsOf(root: THREE.Object3D): THREE.Vector3 {
  return (root.getObjectByName('hips') as THREE.Bone).position;
}

function materialOf(root: THREE.Object3D): THREE.MeshStandardMaterial {
  let found: THREE.MeshStandardMaterial | null = null;
  root.traverse((node) => {
    if ((node as THREE.SkinnedMesh).isSkinnedMesh === true) found = (node as THREE.SkinnedMesh).material as THREE.MeshStandardMaterial;
  });
  if (found === null) throw new Error('no skinned mesh');
  return found;
}

function glintOf(root: THREE.Object3D): THREE.Sprite {
  return root.getObjectByName('muzzle_glint') as THREE.Sprite;
}

type Shader = Parameters<NonNullable<THREE.MeshStandardMaterial['onBeforeCompile']>>[0];

/** Runs a material's `onBeforeCompile` over the chunk names it patches. */
function compiled(material: THREE.MeshStandardMaterial): { fragment: string; uniforms: Record<string, THREE.IUniform> } {
  const shader = {
    vertexShader: '#include <common>\n#include <begin_vertex>\n',
    fragmentShader: '#include <common>\n#include <emissivemap_fragment>\n',
    uniforms: {},
  } as unknown as Shader;
  material.onBeforeCompile(shader, null as never);
  return { fragment: shader.fragmentShader, uniforms: shader.uniforms };
}

function expectVector(actual: THREE.Vector3, expected: readonly number[]): void {
  expect(actual.x).toBeCloseTo(expected[0] as number, 5);
  expect(actual.y).toBeCloseTo(expected[1] as number, 5);
  expect(actual.z).toBeCloseTo(expected[2] as number, 5);
}

let restore: LogSink | null = null;
const warnings: unknown[][] = [];

function captureWarnings(): void {
  warnings.length = 0;
  restore = setLogSink({
    debug: () => undefined,
    info: () => undefined,
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
    error: () => undefined,
  });
}

afterEach(() => {
  if (restore !== null) setLogSink(restore);
  restore = null;
});

// --------------------------------------------------------------- the pose

describe('raiderPose (§4.3), every row', () => {
  const still = { speed: 0, hitFlash: 0 } as const;

  it('pins the constants of §3', () => {
    expect(RAIDER_POOL).toBe(8);
    expect(RAIDER_FADE).toBe(0.4);
    expect(RAIDER_TRACER).toBe('#ffc27a');
    expect(RAIDER_MUZZLE).toEqual({ x: -0.12, y: 1.12, z: 0.925 });
  });

  it('a new hit restarts hit — from no last frame, or from one that was not flashing', () => {
    expect(raiderPose({ ...still, state: 'chase', hitFlash: 0.15 }, null)).toEqual({ anim: 'hit', hold: false, restart: true, timeScale: 1 });
    expect(raiderPose({ ...still, state: 'chase', hitFlash: 0.15 }, { state: 'chase', hitFlash: 0 })).toMatchObject({ anim: 'hit', restart: true });
    // It outranks every other row — the windup's aim included.
    expect(raiderPose({ ...still, state: 'windup', hitFlash: 0.1 }, { state: 'windup', hitFlash: 0 })).toMatchObject({ anim: 'hit', restart: true });
  });

  it('a flash that is still running restarts nothing', () => {
    expect(raiderPose({ ...still, state: 'chase', hitFlash: 0.1 }, { state: 'chase', hitFlash: 0.15 })).toMatchObject({ anim: 'idle', restart: false });
  });

  it('windup holds attack (the aim)', () => {
    expect(raiderPose({ ...still, state: 'windup' }, null)).toEqual({ anim: 'attack', hold: true, restart: false, timeScale: 1 });
    expect(raiderPose({ ...still, state: 'windup', speed: 4 }, { state: 'windup', hitFlash: 0 })).toMatchObject({ anim: 'attack', hold: true });
  });

  it('leaving windup restarts attack (the recoil: the shot left this step)', () => {
    expect(raiderPose({ ...still, state: 'strafe' }, { state: 'windup', hitFlash: 0 })).toEqual({
      anim: 'attack',
      hold: false,
      restart: true,
      timeScale: 1,
    });
    // Whatever it leaves for, moving or not.
    expect(raiderPose({ ...still, state: 'chase', speed: 5 }, { state: 'windup', hitFlash: 0 })).toMatchObject({ anim: 'attack', restart: true });
  });

  it('leaving windup for dead does not', () => {
    expect(raiderPose({ ...still, state: 'dead' }, { state: 'windup', hitFlash: 0 })).toMatchObject({ anim: 'idle', restart: false });
  });

  it('runs above 0.2 m/s at speed / 6, clamped: speed 3 at 0.6 and speed 12 at 1.6', () => {
    expect(raiderPose({ state: 'strafe', speed: 3, hitFlash: 0 }, null)).toEqual({ anim: 'run', hold: false, restart: false, timeScale: 0.6 });
    expect(raiderPose({ state: 'chase', speed: 12, hitFlash: 0 }, null)).toMatchObject({ anim: 'run', timeScale: 1.6 });
    expect(raiderPose({ state: 'chase', speed: 7.2, hitFlash: 0 }, null).timeScale).toBeCloseTo(1.2, 9);
  });

  it('still is idle — at 0.2 m/s too', () => {
    expect(raiderPose({ ...still, state: 'wander' }, null)).toEqual({ anim: 'idle', hold: false, restart: false, timeScale: 1 });
    expect(raiderPose({ state: 'strafe', speed: 0.2, hitFlash: 0 }, { state: 'strafe', hitFlash: 0 })).toMatchObject({ anim: 'idle' });
  });

  it('writes into the pose it is handed, so the per-frame caller allocates nothing', () => {
    const out = { anim: 'run' as const, hold: true, restart: true, timeScale: 9 };
    const pose = raiderPose({ ...still, state: 'idle' }, null, out);
    expect(pose).toBe(out);
    expect(pose).toEqual({ anim: 'idle', hold: false, restart: false, timeScale: 1 });
  });
});

// --------------------------------------------------------------- the pool

describe('the pool (§4.5, E114)', () => {
  it('9 live raiders place 8, and the newest is the stand-in wherever it sits in the pool', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    for (const id of [5, 9, 1, 3, 7, 2, 8, 4, 6]) raider(pool, id);
    const placed = views.sync(pool, 1 / 60, 0, flat);
    expect(views.counts).toEqual({ live: 8, falling: 0, standIn: 1, tracers: 0 });
    expect([...placed].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(clones(parent)).toHaveLength(RAIDER_POOL);
    // A raider that already holds a slot keeps it; the stand-in waits for one to free.
    remove(pool, 2);
    expect(views.sync(pool, 1 / 60, 0, flat).has(9)).toBe(true);
    expect(views.counts).toMatchObject({ live: 8, falling: 0, standIn: 0 });
    views.dispose();
  });

  it('every raider is its own SkeletonUtils clone of the model: its own skeleton, the cache’s geometry', async () => {
    const parent = new THREE.Group();
    const { assets, clones: built } = await loaded();
    const views = new ScavRaiderViews(parent, assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    raider(pool, 1);
    raider(pool, 2);
    views.sync(pool, 1 / 60, 0, flat);
    expect(built()).toBe(2);
    const meshes = clones(parent).map((root) => {
      const found: THREE.SkinnedMesh[] = [];
      root.traverse((node) => {
        if ((node as THREE.SkinnedMesh).isSkinnedMesh === true) found.push(node as THREE.SkinnedMesh);
      });
      expect(found).toHaveLength(1); // one mesh with one material: one draw
      expect(Array.isArray(found[0]?.material)).toBe(false);
      return found[0] as THREE.SkinnedMesh;
    });
    const [a, b] = meshes as [THREE.SkinnedMesh, THREE.SkinnedMesh];
    expect(a.skeleton).not.toBe(b.skeleton);
    expect(a.skeleton.bones[0]).not.toBe(b.skeleton.bones[0]);
    expect(a.geometry).toBe(b.geometry); // the model's own triangles, shared
    expect(a.geometry.userData['shared']).toBe(true);
    views.dispose();
  });

  it('builds clones on first use and keeps them: steady play builds nothing more', async () => {
    const parent = new THREE.Group();
    const { assets, clones: built } = await loaded();
    const views = new ScavRaiderViews(parent, assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    for (let id = 1; id <= 3; id++) raider(pool, id);
    for (let frame = 0; frame < 30; frame++) views.sync(pool, 1 / 60, frame / 60, flat);
    expect(built()).toBe(3);
    // One leaves (no fall) and another arrives: the freed clone is reused.
    remove(pool, 2);
    views.sync(pool, 1 / 60, 0, flat);
    raider(pool, 4);
    views.sync(pool, 1 / 60, 0, flat);
    expect(built()).toBe(3);
    expect(views.counts).toMatchObject({ live: 3, falling: 0, standIn: 0 });
    views.dispose();
  });

  it('after a fall, a new raider takes the falling slot', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    for (let id = 1; id <= RAIDER_POOL; id++) raider(pool, id);
    views.sync(pool, 0.1, 0, flat);
    views.fall(3);
    remove(pool, 3);
    views.sync(pool, 0.1, 0.1, flat);
    expect(views.counts).toMatchObject({ live: 7, falling: 1, standIn: 0 });
    raider(pool, 9);
    const placed = views.sync(pool, 0.1, 0.2, flat);
    expect(placed.has(9)).toBe(true);
    expect(views.counts).toMatchObject({ live: 8, falling: 0, standIn: 0 });
    expect(clones(parent)).toHaveLength(RAIDER_POOL);
    views.dispose();
  });

  it('past the pool the oldest falling copy goes first, then the newest raiders are stand-ins', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    for (let id = 1; id <= RAIDER_POOL; id++) raider(pool, id);
    views.sync(pool, 0.1, 0, flat);
    const first = cloneOf(parent, pool.at(0));
    const second = cloneOf(parent, pool.at(1));
    views.fall(1);
    remove(pool, 1);
    views.sync(pool, 0.1, 0.1, flat);
    views.fall(2);
    remove(pool, 2);
    views.sync(pool, 0.1, 0.2, flat);
    expect(views.counts).toMatchObject({ live: 6, falling: 2 });

    // One newcomer: the copy that fell first gives its clone up.
    const newcomer = raider(pool, 9);
    views.sync(pool, 0.1, 0.3, flat);
    expect(views.counts).toMatchObject({ live: 7, falling: 1, standIn: 0 });
    expect(cloneOf(parent, newcomer)).toBe(first);
    expect(second.visible).toBe(true); // still falling, where raider 2 stood
    expect(second.position.x).toBe(2 * 3);

    // Two more: one takes the last falling copy, the newest is the stand-in.
    raider(pool, 10);
    const newest = raider(pool, 11);
    const placed = views.sync(pool, 0.1, 0.4, flat);
    expect(views.counts).toEqual({ live: RAIDER_POOL, falling: 0, standIn: 1, tracers: 0 });
    expect(placed.has(10)).toBe(true);
    expect(placed.has(newest.id)).toBe(false);
    views.dispose();
  });

  it('a raider dismissed or despawned leaves the placed set the next frame, with no fall (64-a)', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    raider(pool, 1);
    const gone = raider(pool, 2);
    views.sync(pool, 0.1, 0, flat);
    const root = cloneOf(parent, gone);
    remove(pool, 2);
    const placed = views.sync(pool, 0.1, 0.1, flat);
    expect(placed.has(2)).toBe(false);
    expect(views.counts).toMatchObject({ live: 1, falling: 0 });
    expect(root.visible).toBe(false);
    views.dispose();
  });

  it('skips the dead and the buried, as EnemyMeshes does, and every other recipe', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    raider(pool, 1, { state: 'dead' });
    raider(pool, 2, { specialKind: 'burrow_dig' });
    const skitter = pool.alloc();
    Object.assign(skitter, makeEnemy(), { def: ENEMIES.dust_skitter, id: 3, state: 'chase' });
    expect(views.sync(pool, 0.1, 0, flat).size).toBe(0);
    expect(views.counts).toMatchObject({ live: 0, falling: 0, standIn: 0 });
    views.dispose();
  });
});

// --------------------------------------------------------------- the fall

describe('the fall (§4.5, E115)', () => {
  it('Death plays once from the current pose, then the copy fades over RAIDER_FADE and is gone after 1.2 + 0.4 s', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1, { x: 4, z: -2, facing: 1 });
    views.sync(pool, 0.1, 0, flat);
    const root = cloneOf(parent, e);
    const material = materialOf(root);
    views.fall(1);
    remove(pool, 1);
    // It is no longer placed, and nothing in the simulation moves it.
    expect(views.sync(pool, 0.1, 0.1, flat).has(1)).toBe(false);
    for (let frame = 1; frame < 12; frame++) views.sync(pool, 0.1, 0.1 * frame, flat);
    expect(views.counts).toMatchObject({ live: 0, falling: 1 });
    expect(root.position.toArray()).toEqual([4, 0, -2]);
    expect(root.rotation.y).toBeCloseTo(Math.PI / 2 - 1, 6);
    // 1.2 s in, Death has played to its last frame and clamped there.
    expectVector(hipsOf(root), POSE.deathTo);
    expect(material.opacity).toBe(1);
    views.sync(pool, 0.2, 1.4, flat); // 1.4 s: halfway through the fade
    expect(material.opacity).toBeCloseTo(0.5, 5);
    expect(views.counts.falling).toBe(1);
    expect(root.visible).toBe(true);
    views.sync(pool, 0.2, 1.6, flat); // 1.6 s: gone, its slot free
    expect(views.counts).toMatchObject({ live: 0, falling: 0 });
    expect(root.visible).toBe(false);
    expect(material.opacity).toBe(1); // whole again for the next raider
    views.dispose();
  });

  it('a raider killed mid-flinch crossfades into Death, and loses the flash on the way down', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1);
    views.sync(pool, 0.1, 0, flat);
    e.hitFlash = 0.15;
    views.sync(pool, 0.1, 0.1, flat);
    const root = cloneOf(parent, e);
    expect(materialOf(root).color.getHex()).toBe(0xffffff);
    views.fall(1);
    remove(pool, 1);
    expect(`#${materialOf(root).color.getHexString()}`).toBe(SCAV_BODY_TINT.primary);
    views.sync(pool, 0.06, 0.16, flat); // halfway through the 0.12 s crossfade: between the two poses
    const mid = hipsOf(root);
    expect(mid.z).toBeGreaterThan(0.5);
    expect(mid.y).toBeLessThan(-0.1);
    views.sync(pool, 0.6, 0.76, flat);
    expect(hipsOf(root).z).toBeCloseTo(0, 6); // Death alone
    views.dispose();
  });

  it('a fall for a stand-in, an unknown id or a copy already falling changes nothing', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    raider(pool, 1);
    views.sync(pool, 0.1, 0, flat);
    views.fall(42);
    views.fall(1);
    views.fall(1);
    remove(pool, 1);
    views.sync(pool, 0.1, 0.1, flat);
    expect(views.counts).toMatchObject({ live: 0, falling: 1 });
    views.dispose();
  });
});

// ---------------------------------------------------------- tint and rim

describe('tint and rim (§4.2, §4.4)', () => {
  it('the clone’s material colour is #4f4a3d, its emissive black, transparent, and the template is untouched', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1);
    views.sync(pool, 0.1, 0, flat);
    const material = materialOf(cloneOf(parent, e));
    expect(material).not.toBe(template);
    expect(`#${material.color.getHexString()}`).toBe('#4f4a3d');
    expect(material.emissive.getHex()).toBe(0);
    expect(material.emissiveIntensity).toBe(0);
    expect(material.transparent).toBe(true);
    expect(template.color.getHexString()).toBe('888888');
    expect(template.emissiveIntensity).toBe(2);
    // At rest it adds no glow of its own: the visor stays dark.
    expect(compiled(material).uniforms['uRaiderEmissive']?.value.getHex()).toBe(0);
    views.dispose();
  });

  it('its program cache key is raider/1, and the rim is the enemies’ own: shared colour, after the emissive', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    raider(pool, 1);
    raider(pool, 2);
    views.sync(pool, 0.1, 0, flat);
    const [a, b] = clones(parent).map(materialOf) as [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
    expect(a).not.toBe(b);
    expect(a.customProgramCacheKey()).toBe('raider/1');
    expect(b.customProgramCacheKey()).toBe('raider/1');
    const { fragment, uniforms } = compiled(a);
    expect(uniforms['uHostileRim']).toBe(HOSTILE_RIM_UNIFORM);
    const emissiveAt = fragment.indexOf('totalEmissiveRadiance += uRaiderEmissive;');
    expect(emissiveAt).toBeGreaterThan(0);
    expect(fragment.indexOf('hostileRim')).toBeGreaterThan(emissiveAt);
    expect(fragment).toContain(`${RIM_INTENSITY.toFixed(6)} * hostileRim * uRimScale`);
    // Each clone scales its own rim.
    expect(compiled(b).uniforms['uRimScale']).not.toBe(uniforms['uRimScale']);
    views.dispose();
  });

  it('while flashing, its rim-scale uniform is FLASH_RIM_SCALE, its colour white and its emissive 2.5', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1);
    views.sync(pool, 0.1, 0, flat);
    const material = materialOf(cloneOf(parent, e));
    const uniforms = compiled(material).uniforms;
    expect(uniforms['uRimScale']?.value).toBe(1);
    e.hitFlash = 0.15;
    views.sync(pool, 0.1, 0.1, flat);
    expect(uniforms['uRimScale']?.value).toBeCloseTo(FLASH_RIM_SCALE, 6);
    expect(material.color.getHex()).toBe(0xffffff);
    expect((uniforms['uRaiderEmissive']?.value as THREE.Color).toArray()).toEqual([2.5, 2.5, 2.5]);
    e.hitFlash = 0;
    views.sync(pool, 0.1, 0.2, flat);
    expect(uniforms['uRimScale']?.value).toBe(1);
    views.dispose();
  });

  it('an elite wears the tint halfway to gold and the gold glow; invulnerable halves both; rimOf scales the rim below', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1, { elite: true });
    views.sync(pool, 0.1, 0, flat);
    const material = materialOf(cloneOf(parent, e));
    const uniforms = compiled(material).uniforms;
    const tint = ENEMIES.scav_raider.look.tint;
    const eliteColor = new THREE.Color(tint).lerp(new THREE.Color(ELITE_TINT), 0.5);
    const eliteGlow = new THREE.Color(tint).multiplyScalar(0.15);
    eliteGlow.r += ELITE_GOLD[0];
    eliteGlow.g += ELITE_GOLD[1];
    eliteGlow.b += ELITE_GOLD[2];
    expect(material.color.equals(eliteColor)).toBe(true);
    expect((uniforms['uRaiderEmissive']?.value as THREE.Color).equals(eliteGlow)).toBe(true);

    e.invulnerable = true;
    views.sync(pool, 0.1, 0.1, flat);
    expect(material.color.r).toBeCloseTo(eliteColor.r * 0.5, 6);
    expect((uniforms['uRaiderEmissive']?.value as THREE.Color).g).toBeCloseTo(eliteGlow.g * 0.5, 6);
    e.invulnerable = false;
    e.elite = false;
    views.sync(pool, 0.1, 0.2, flat);
    expect(`#${material.color.getHexString()}`).toBe('#4f4a3d');

    // SPEC-054 §4.6: below, the rim follows the enemies' rule — the flash on top of it.
    views.rimOf = (enemy) => (enemy === e ? 0.6 : 1);
    views.sync(pool, 0.1, 0.3, flat);
    expect(uniforms['uRimScale']?.value).toBeCloseTo(0.6, 6);
    e.hitFlash = 0.1;
    views.sync(pool, 0.1, 0.4, flat);
    expect(uniforms['uRimScale']?.value).toBeCloseTo(FLASH_RIM_SCALE * 0.6, 6);
    views.dispose();
  });

  it('casts shadows only when asked, and follows a preset change', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: true });
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1);
    views.sync(pool, 0.1, 0, flat);
    let mesh: THREE.Mesh | null = null;
    cloneOf(parent, e).traverse((node) => {
      if ((node as THREE.SkinnedMesh).isSkinnedMesh === true) mesh = node as THREE.Mesh;
    });
    expect((mesh as unknown as THREE.Mesh).castShadow).toBe(true);
    views.setShadows(false);
    expect((mesh as unknown as THREE.Mesh).castShadow).toBe(false);
    expect((mesh as unknown as THREE.Mesh).receiveShadow).toBe(false);
    views.dispose();
  });

  it('dispose takes the clones out and frees their materials and skeletons, never the template', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1);
    views.sync(pool, 0.1, 0, flat);
    const root = cloneOf(parent, e);
    const material = materialOf(root);
    let skinned: THREE.SkinnedMesh | null = null;
    root.traverse((node) => {
      if ((node as THREE.SkinnedMesh).isSkinnedMesh === true) skinned = node as THREE.SkinnedMesh;
    });
    const skeleton = (skinned as unknown as THREE.SkinnedMesh).skeleton;
    let freed = 0;
    material.addEventListener('dispose', () => freed++);
    let templateFreed = false;
    template.addEventListener('dispose', () => {
      templateFreed = true;
    });
    let boneTexture = false;
    const original = skeleton.dispose.bind(skeleton);
    skeleton.dispose = () => {
      boneTexture = true;
      original();
    };
    views.dispose();
    expect(parent.getObjectByName('scav-raiders')).toBeUndefined();
    expect(freed).toBe(1);
    expect(boneTexture).toBe(true);
    expect(templateFreed).toBe(false);
  });
});

// ------------------------------------------------- the transform and the aim

describe('placing a raider (§4.2, §4.3)', () => {
  it('faces its facing (π/2 − facing), stands on the ground, × 1.3 when elite, and never swells in a windup', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1, { x: 3, z: -2, facing: 0.75 });
    views.sync(pool, 0.1, 0, (x, z) => (x === 3 && z === -2 ? 1.5 : 0));
    const root = cloneOf(parent, e);
    expect(root.position.toArray()).toEqual([3, 1.5, -2]);
    expect(root.rotation.y).toBeCloseTo(Math.PI / 2 - 0.75, 6);
    expect(root.scale.toArray()).toEqual([1, 1, 1]);
    e.state = 'windup';
    views.sync(pool, 0.1, 0.1, flat);
    expect(root.scale.x).toBe(1); // no 1.15 swell
    e.elite = true;
    views.sync(pool, 0.1, 0.2, flat);
    expect(root.scale.x).toBeCloseTo(ELITE_SCALE, 9);
    expect(root.scale.y).toBeCloseTo(1.3, 9);
    views.dispose();
  });

  it('a windup holds Attack’s first frame while the glint grows from nothing to full', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1);
    views.sync(pool, 0.1, 0, flat);
    const root = cloneOf(parent, e);
    const glint = glintOf(root);
    expect(glint.visible).toBe(false);
    // The glint stands at the muzzle in the clone's frame, 0.06 m across.
    expect(glint.parent).toBe(root);
    expect(glint.position.toArray()).toEqual([RAIDER_MUZZLE.x, RAIDER_MUZZLE.y, RAIDER_MUZZLE.z]);
    expect(glint.scale.x).toBeCloseTo(0.06, 9);
    expect((glint.material as THREE.SpriteMaterial).blending).toBe(THREE.AdditiveBlending);

    e.state = 'windup';
    for (const stateTime of [0, 0.125, 0.25, 0.375, 0.5]) {
      e.stateTime = stateTime;
      views.sync(pool, 0.125, stateTime, flat);
      expect(glint.visible).toBe(true);
      expect((glint.material as THREE.SpriteMaterial).opacity).toBeCloseTo(stateTime / 0.5, 6);
    }
    // Past the 0.12 s crossfade from idle: the aim alone, held on frame 0.
    expectVector(hipsOf(root), POSE.attackFrom);
    views.sync(pool, 0.3, 0.8, flat);
    expectVector(hipsOf(root), POSE.attackFrom);
    views.dispose();
  });

  it('the glint spans the windup as its multipliers stretch it — a swift elite’s 0.8, casual’s 1.25', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1, { state: 'windup', stateTime: 0.2, windupScale: 0.8 });
    views.sync(pool, 0.1, 0, flat);
    const glint = glintOf(cloneOf(parent, e));
    expect((glint.material as THREE.SpriteMaterial).opacity).toBeCloseTo(0.2 / 0.4, 6);
    views.windupMult = 1.25;
    views.sync(pool, 0.1, 0.1, flat);
    expect((glint.material as THREE.SpriteMaterial).opacity).toBeCloseTo(0.2 / 0.5, 6);
    e.stateTime = 0.9; // a windup the simulation let run long still reads full, never past it
    views.sync(pool, 0.1, 0.2, flat);
    expect((glint.material as THREE.SpriteMaterial).opacity).toBe(1);
    views.dispose();
  });

  it('when the windup ends in a shot, Attack plays from its start and the muzzle flashes once, at the rifle', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const flashes: Array<[number, number]> = [];
    views.onMuzzle = (x, z) => flashes.push([x, z]);
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1, { state: 'windup', x: 4, z: 6, facing: 0.4, elite: true });
    views.sync(pool, 0.3, 0, flat);
    views.sync(pool, 0.3, 0.3, flat);
    const root = cloneOf(parent, e);
    expectVector(hipsOf(root), POSE.attackFrom);
    expect(flashes).toEqual([]);

    // A volley's three shots or one: the windup ends once (64-c).
    e.state = 'strafe';
    e.vx = 2;
    views.sync(pool, 0.25, 0.55, flat);
    expect(hipsOf(root).x).toBeCloseTo(5.5, 5); // a quarter second into the recoil, from its start
    expect(glintOf(root).visible).toBe(false);
    expect(flashes).toHaveLength(1);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(4, 0, 6);
    muzzle.rotation.y = Math.PI / 2 - 0.4;
    muzzle.scale.setScalar(ELITE_SCALE);
    muzzle.updateMatrixWorld(true);
    const at = muzzle.localToWorld(new THREE.Vector3(RAIDER_MUZZLE.x, RAIDER_MUZZLE.y, RAIDER_MUZZLE.z));
    expect(flashes[0]?.[0]).toBeCloseTo(at.x, 6);
    expect(flashes[0]?.[1]).toBeCloseTo(at.z, 6);

    // The recoil plays out though the raider runs, then the run takes over.
    views.sync(pool, 0.2, 0.75, flat);
    expect(hipsOf(root).x).toBeCloseTo(5.9, 5);
    views.sync(pool, 0.1, 0.85, flat); // the recoil has finished: the run fades in
    views.sync(pool, 0.2, 1.05, flat);
    expectVector(hipsOf(root), POSE.run);
    expect(flashes).toHaveLength(1);
    views.dispose();
  });

  it('a hit flinches from Hit’s start, and plays it out under a flash that keeps running', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1, { hitFlash: 0.15 });
    views.sync(pool, 0.1, 0, flat);
    const root = cloneOf(parent, e);
    expect(hipsOf(root).z).toBeCloseTo(7.25, 5);
    e.hitFlash = 0.05;
    views.sync(pool, 0.1, 0.1, flat);
    expect(hipsOf(root).z).toBeCloseTo(7.5, 5);
    e.hitFlash = 0;
    views.sync(pool, 0.1, 0.2, flat);
    expect(hipsOf(root).z).toBeCloseTo(7.75, 5);
    // Finished, it hands back to idle.
    views.sync(pool, 0.2, 0.4, flat);
    views.sync(pool, 0.2, 0.6, flat);
    expectVector(hipsOf(root), POSE.idle);
    views.dispose();
  });

  it('a raider placed during a hold idles, and its mixer runs on the render dt (64-b)', async () => {
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded()).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1, { state: 'idle' });
    views.sync(pool, 0.016, 5, flat);
    expectVector(hipsOf(cloneOf(parent, e)), POSE.idle);
    expect(views.counts.live).toBe(1);
    views.dispose();
  });
});

// ------------------------------------------------------------- no model (E113)

describe('without the model (E113)', () => {
  it('a model with no skin leaves every raider the stand-in, with one warning', async () => {
    captureWarnings();
    const parent = new THREE.Group();
    const views = new ScavRaiderViews(parent, (await loaded(crate, [])).assets, { shadows: false });
    const pool = new Pool(makeEnemy);
    for (let id = 1; id <= 3; id++) raider(pool, id);
    expect(views.sync(pool, 0.1, 0, flat).size).toBe(0);
    expect(views.sync(pool, 0.1, 0.1, flat).size).toBe(0);
    expect(views.counts).toEqual({ live: 0, falling: 0, standIn: 3, tracers: 0 });
    expect(clones(parent)).toHaveLength(0);
    // One for each of the five missing clips, then one for the missing skin — and no more.
    expect(warnings).toHaveLength(6);
    views.dispose();
  });
});

// ----------------------------------------------------------- the surface view

const LAYOUT: ViewLayout = {
  shelters: [],
  hash: 0x5ca7a1d0,
  halfSize: 60,
  pois: [{ kind: 'landing_pad', x: 0, z: 0, radius: 5 }],
  obstacles: [],
  nodes: [],
  props: [],
};

function frame(enemies: Pool<EnemyEntity>, projectiles = new Pool<ProjectileEntity>(() => makeProjectile())): SurfaceFrame {
  return {
    player: makePlayer(2, -2, 100),
    follower: null,
    enemies,
    projectiles,
    deployables: new Pool<DeployableEntity>(() => makeDeployable()),
    pickups: new Pool<ViewPickup>(() => ({ kind: 'resource', x: 0, z: 0, seed: 0, resource: 'oil' })),
    nodes: [],
    time: 1,
    dt: 1 / 60,
  };
}

/** The visible stand-in parts: the `scav` recipe's instanced meshes, by their instance count. */
function standInParts(scene: THREE.Scene): THREE.InstancedMesh[] {
  const found: THREE.InstancedMesh[] = [];
  scene.traverse((node) => {
    const mesh = node as THREE.InstancedMesh;
    if (mesh.isInstancedMesh === true && mesh.instanceMatrix.count === INSTANCES_PER_PART && mesh.visible) found.push(mesh);
  });
  return found;
}

describe('SurfaceView and the raiders (§4.2)', () => {
  it('without the model, SurfaceView builds no ScavRaiderViews, and EnemyMeshes draws every raider as the stand-in', () => {
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium);
    expect(scene.getObjectByName('scav-raiders')).toBeUndefined();
    const pool = new Pool(makeEnemy);
    for (let id = 1; id <= 3; id++) raider(pool, id);
    view.sync(frame(pool));
    expect(view.scavRaiders).toEqual({ live: 0, falling: 0, standIn: 3, tracers: 0 });
    const parts = standInParts(scene);
    expect(parts).toHaveLength(4); // body, helmet, visor, rifle
    for (const part of parts) expect(part.count).toBe(3);
    let skinned = 0;
    scene.traverse((node) => {
      if ((node as THREE.SkinnedMesh).isSkinnedMesh === true) skinned++;
    });
    expect(skinned).toBe(0);
    view.fallRaider(1); // nothing to fall, nothing thrown
    view.dispose();
  });

  it('with the model, it draws each raider it can through ScavRaiderViews, and EnemyMeshes only the overflow', async () => {
    const scene = new THREE.Scene();
    const { assets } = await loaded();
    const view = new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium, assets);
    expect(scene.getObjectByName('scav-raiders')).toBeDefined();
    const pool = new Pool(makeEnemy);
    for (let id = 1; id <= 3; id++) raider(pool, id);
    view.sync(frame(pool));
    expect(view.scavRaiders).toMatchObject({ live: 3, falling: 0, standIn: 0 });
    expect(standInParts(scene)).toHaveLength(0);
    // Past the pool, the newest raider is the stand-in, drawn once by EnemyMeshes.
    for (let id = 4; id <= RAIDER_POOL + 1; id++) raider(pool, id);
    view.sync(frame(pool));
    expect(view.scavRaiders).toMatchObject({ live: RAIDER_POOL, falling: 0, standIn: 1 });
    const parts = standInParts(scene);
    expect(parts).toHaveLength(4);
    for (const part of parts) expect(part.count).toBe(1);
    // A killed raider falls; the stand-in takes nothing from it until a slot is free.
    view.fallRaider(2);
    remove(pool, 2);
    view.sync(frame(pool));
    expect(view.scavRaiders).toMatchObject({ live: RAIDER_POOL, falling: 0, standIn: 0 });
    view.dispose();
    expect(scene.getObjectByName('scav-raiders')).toBeUndefined();
  });

  it('bursts CombatFx’s muzzle flash in the tracer’s amber when a raider’s windup ends in a shot', async () => {
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium, (await loaded()).assets);
    const bursts: Array<{ kind: string; color: number }> = [];
    const fx = view.fx;
    const burst = fx.burst.bind(fx);
    fx.burst = (kind, x, z, color, scale) => {
      bursts.push({ kind, color });
      burst(kind, x, z, color, scale);
    };
    const pool = new Pool(makeEnemy);
    const e = raider(pool, 1, { state: 'windup' });
    view.sync(frame(pool));
    e.state = 'strafe';
    view.sync(frame(pool));
    expect(bursts).toEqual([{ kind: 'muzzle', color: 0xffc27a }]);
    view.dispose();
  });

  it('a raider’s shot draws in RAIDER_TRACER and is counted; every other enemy’s stays #7fff8a', () => {
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium);
    const shots = new Pool<ProjectileEntity>(() => makeProjectile());
    const raiderShot = shots.alloc();
    Object.assign(raiderShot, makeProjectile(), { x: 0, z: 0, vx: 15, radius: 0.25, owner: 'enemy', enemyId: 'scav_raider' });
    const spitterShot = shots.alloc();
    Object.assign(spitterShot, makeProjectile(), { x: 5, z: 5, vx: 15, radius: 0.25, owner: 'enemy', enemyId: 'ice_spitter' });
    view.sync(frame(new Pool(makeEnemy), shots));
    let streaks: THREE.InstancedMesh | null = null;
    scene.traverse((node) => {
      const mesh = node as THREE.InstancedMesh;
      if (mesh.isInstancedMesh === true && mesh.geometry.getAttribute('shotCover') !== undefined && mesh.count > 0) streaks = mesh;
    });
    const mesh = streaks as unknown as THREE.InstancedMesh;
    const colour = mesh.instanceColor as THREE.InstancedBufferAttribute;
    // Each shot is its head and two ghosts: the raider's head at 0, the spitter's at 3.
    expect(mesh.count).toBe(6);
    const amber = new THREE.Color(RAIDER_TRACER).multiplyScalar(shotHeadGain({ shape: 'tracer', color: RAIDER_TRACER }));
    const green = new THREE.Color('#7fff8a').multiplyScalar(shotHeadGain({ shape: 'tracer', color: '#7fff8a' }));
    expect(colour.getX(0)).toBeCloseTo(amber.r, 4);
    expect(colour.getY(0)).toBeCloseTo(amber.g, 4);
    expect(colour.getZ(0)).toBeCloseTo(amber.b, 4);
    expect(colour.getX(3)).toBeCloseTo(green.r, 4);
    expect(colour.getY(3)).toBeCloseTo(green.g, 4);
    // Where it is drawn is unchanged: 0.9 m over the ground, along its velocity.
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(0, matrix);
    expect(matrix.elements[13]).toBeCloseTo(0.9 + view.field.heightAt(0, 0), 5);
    expect(view.scavRaiders.tracers).toBe(1);
    view.sync(frame(new Pool(makeEnemy)));
    expect(view.scavRaiders.tracers).toBe(0);
    view.dispose();
  });
});

// ------------------------------------------------------------ the committed model

describe('character.glb (§4.6)', () => {
  it('is one skinned mesh of 2 616 triangles with the five clips the raiders play', () => {
    const glb = readFileSync(new URL('../../public/assets/models/character.glb', import.meta.url).pathname);
    const length = new DataView(glb.buffer, glb.byteOffset, glb.byteLength).getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length))) as {
      meshes: { primitives: { indices: number }[] }[];
      skins: unknown[];
      materials: unknown[];
      accessors: { count: number; max?: number[] }[];
      animations: { name: string; samplers: { input: number }[] }[];
    };
    expect(json.meshes).toHaveLength(1);
    expect(json.meshes[0]?.primitives).toHaveLength(1);
    expect(json.materials).toHaveLength(1);
    expect(json.skins).toHaveLength(1);
    const indices = json.accessors[json.meshes[0]?.primitives[0]?.indices ?? -1];
    expect((indices?.count ?? 0) / 3).toBe(2616);
    // 8 skinned raiders: at most 8 draws and 20 928 triangles (§4.6).
    expect(RAIDER_POOL * 2616).toBe(20_928);
    const lengths = Object.fromEntries(
      json.animations.map((clip) => [clip.name, json.accessors[clip.samplers[0]?.input ?? -1]?.max?.[0] ?? 0]),
    );
    expect(lengths['Idle']).toBeCloseTo(2, 3);
    expect(lengths['Run']).toBeCloseTo(0.8, 3);
    expect(lengths['Attack']).toBeCloseTo(0.5, 3);
    expect(lengths['Hit']).toBeCloseTo(0.4, 3);
    expect(lengths['Death']).toBeCloseTo(1.2, 3);
  });
});
