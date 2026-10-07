// SPEC-017 §6 and SPEC-018 — the surface rig, shadow map, blob layer, planet
// grade, and now the environment: terrain off the shared height field, entity
// Y in sync(), the weather grade and the lightning gate. The scene graph is
// plain three.js objects, so what the GPU would be handed is readable here.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Assets } from '@/core/Assets';
import { Pool } from '@/core/Pool';
import { hash01 } from '@/core/Noise';
import { hash32 } from '@/core/Rng';
import { QUALITY, type QualitySettings } from '@/core/Quality';
import { DRONE_SHOT, ENEMIES, FLARE_SHOT, ITEMS, PLANETS, THROWN_SHOT, type PlanetDef, type ShotLook } from '@/data/index';
import { makeEnemy, type EnemyEntity } from '@/entities/Enemy';
import { makePlayer } from '@/entities/Player';
import { makeProjectile, type ProjectileEntity } from '@/entities/Projectile';
import { makeDeployable, type DeployableEntity } from '@/entities/Deployable';
import { INSTANCES_PER_PART } from '@/views/ProceduralMeshes';
import { groundLayer } from '@/views/ProceduralTextures';
import {
  GEAR_PICKUP_COLOR,
  GHOST_COVER,
  HEAD_COVER,
  ITEM_PICKUP_COLOR,
  lobLift,
  presetOf,
  RESOURCE_GLOW,
  SHOT_DRAW,
  shotHeadGain,
  SurfaceView,
  type SurfaceFrame,
  type ViewLayout,
  type ViewPickup,
} from '@/views/SurfaceView';

const LAYOUT: ViewLayout = {
  shelters: [],
  hash: 0x18a7c3d1,
  halfSize: 60,
  pois: [
    { kind: 'landing_pad', x: 0, z: 0, radius: 5 },
    { kind: 'scan', x: 12, z: -8, radius: 2 },
  ],
  obstacles: [
    { x: 4, z: 4, radius: 1.2, kind: 'rock' },
    { x: -6, z: 9, radius: 1, kind: 'spire' },
  ],
  nodes: [{ resource: 'oil', x: 3, z: -3 }],
  props: [{ x: 8, z: 8, rot: 0.3, scale: 1, kind: 'rock_small' }],
};

/** A plain `bug` recipe with no `look.emissive`, and the boss that has one. */
const SKITTER = ENEMIES.dust_skitter;
const WURM = ENEMIES.dune_wurm;

function setup(
  quality: QualitySettings = QUALITY.medium,
  planet: PlanetDef = PLANETS.cinder4,
): { scene: THREE.Scene; view: SurfaceView } {
  const scene = new THREE.Scene();
  return { scene, view: new SurfaceView(scene, LAYOUT, planet, quality) };
}

function frame(enemies: Pool<EnemyEntity>, follower: SurfaceFrame['follower'] = null): SurfaceFrame {
  return {
    player: makePlayer(2, -2, 100),
    follower,
    enemies,
    projectiles: new Pool<ProjectileEntity>(() => makeProjectile()),
    deployables: new Pool<DeployableEntity>(() => makeDeployable()),
    pickups: new Pool<ViewPickup>(() => ({ kind: 'resource', x: 0, z: 0, seed: 0, resource: 'oil' })),
    nodes: [{ resource: 'oil', x: 3, z: -3, capacity: 10, remaining: 5, harvesting: false }],
    time: 1,
    dt: 1 / 60,
  };
}

function spawn(pool: Pool<EnemyEntity>, def: EnemyEntity['def'], patch: Partial<EnemyEntity> = {}): EnemyEntity {
  const e = pool.alloc();
  Object.assign(e, makeEnemy(), { def, id: pool.size, state: 'chase', x: 5, z: -3 }, patch);
  return e;
}

const follower = { x: 1, z: 1, alive: true } as SurfaceFrame['follower'];

/** Every light in the scene, by constructor name, sorted. */
function lights(scene: THREE.Scene): string[] {
  const found: string[] = [];
  scene.traverse((node) => {
    if ((node as THREE.Light).isLight === true) found.push(node.constructor.name);
  });
  return found.sort();
}

function directionals(scene: THREE.Scene): THREE.DirectionalLight[] {
  const found: THREE.DirectionalLight[] = [];
  scene.traverse((node) => {
    if ((node as THREE.DirectionalLight).isDirectionalLight === true) found.push(node as THREE.DirectionalLight);
  });
  return found;
}

function hemisphere(scene: THREE.Scene): THREE.HemisphereLight {
  let found: THREE.HemisphereLight | null = null;
  scene.traverse((node) => {
    if ((node as THREE.HemisphereLight).isHemisphereLight === true) found = node as THREE.HemisphereLight;
  });
  if (found === null) throw new Error('no hemisphere light');
  return found;
}

/** The enemy part meshes: faceted, and sized for the per-part instance cap. */
function enemyParts(scene: THREE.Scene): THREE.InstancedMesh[] {
  const found: THREE.InstancedMesh[] = [];
  scene.traverse((node) => {
    const mesh = node as THREE.InstancedMesh;
    if (mesh.isInstancedMesh !== true) return;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (material.flatShading === true && mesh.instanceMatrix.count === INSTANCES_PER_PART) found.push(mesh);
  });
  return found;
}

function blobLayer(scene: THREE.Scene): THREE.InstancedMesh {
  let found: THREE.InstancedMesh | null = null;
  scene.traverse((node) => {
    const mesh = node as THREE.InstancedMesh;
    if (mesh.isInstancedMesh !== true || mesh.renderOrder !== 1) return;
    if ((mesh.material as THREE.MeshBasicMaterial).isMeshBasicMaterial === true) found = mesh;
  });
  if (found === null) throw new Error('no blob-shadow layer under the view');
  return found;
}

/** The §4.1 sun direction for a planet's look, matching the view's formula. */
function sunDir(planet: PlanetDef): { x: number; y: number; z: number } {
  const sun = planet.surface.look.light.sun;
  const azimuth = (sun.azimuth * Math.PI) / 180;
  const elevation = (sun.elevation * Math.PI) / 180;
  return {
    x: Math.cos(elevation) * Math.sin(azimuth),
    y: Math.sin(elevation),
    z: Math.cos(elevation) * Math.cos(azimuth),
  };
}

describe('the surface rig (SPEC-017 §4.5, SPEC-018 §4.1)', () => {
  it('is a hemisphere, a warm key, a cool rim, the torch and the muzzle light — and no ambient', () => {
    const { scene, view } = setup();
    // SPEC-019 §4.4 adds the pulsed muzzle PointLight, created once at
    // construction (never re-parented) so no shader recompile lands mid-combat.
    expect(lights(scene)).toEqual([
      'DirectionalLight',
      'DirectionalLight',
      'HemisphereLight',
      'PointLight',
      'PointLight',
    ]);
    view.dispose();
  });

  it('reads the look: sun colour and intensity, hemisphere sky/ground/ambient', () => {
    const { scene, view } = setup();
    const look = PLANETS.cinder4.surface.look;
    const key = directionals(scene).find((light) => light.intensity === look.light.sun.intensity);
    expect(key).toBeDefined();
    expect(key?.color.getHexString()).toBe(new THREE.Color(look.light.sun.color).getHexString());
    const hemi = hemisphere(scene);
    expect(hemi.intensity).toBeCloseTo(look.light.ambient, 6);
    expect(hemi.color.getHexString()).toBe(new THREE.Color(look.light.sky).getHexString());
    view.dispose();
  });

  it('parents the torch to the player group, so it rides along without sync()', () => {
    const { scene, view } = setup();
    let siblings = 0;
    scene.traverse((node) => {
      if ((node as THREE.PointLight).isPointLight !== true) return;
      siblings = node.parent?.children.length ?? 0;
    });
    // The player group: capsule body, nose cone and the torch.
    expect(siblings).toBe(3);
    view.dispose();
  });

  it('walks the key with the player along the look sun direction × 60 (§4.1)', () => {
    const { scene, view } = setup();
    view.sync(frame(new Pool<EnemyEntity>(() => makeEnemy())));
    const dir = sunDir(PLANETS.cinder4);
    const key = directionals(scene).find((light) => light.intensity === PLANETS.cinder4.surface.look.light.sun.intensity);
    expect(key).toBeDefined();
    expect(key?.position.x).toBeCloseTo(2 + dir.x * 60, 5); // player.x + dir × 60
    expect(key?.position.y).toBeCloseTo(dir.y * 60, 5);
    expect(key?.position.z).toBeCloseTo(-2 + dir.z * 60, 5);
    expect(key?.target.position.x).toBeCloseTo(2, 5);
    expect(key?.target.position.z).toBeCloseTo(-2, 5);
    // The target has to be in the graph or three never updates its matrix.
    expect(key?.target.parent).not.toBeNull();
    view.dispose();
  });
});

describe('applyQuality (SPEC-017 §4.5, §4.8, AC-72 … AC-74)', () => {
  it('high switches the shadow map on, sizes its camera, and assigns an environment', () => {
    const { scene, view } = setup();
    const pool = new Pool<EnemyEntity>(() => makeEnemy());
    spawn(pool, SKITTER);
    view.sync(frame(pool)); // builds the enemy part meshes
    view.applyQuality(QUALITY.high);

    const key = directionals(scene).find((light) => light.castShadow);
    expect(key).toBeDefined();
    expect(key?.shadow.mapSize.width).toBe(1024);
    expect(key?.shadow.mapSize.height).toBe(1024);
    const camera = key?.shadow.camera as THREE.OrthographicCamera;
    expect([camera.left, camera.right, camera.top, camera.bottom]).toEqual([-34, 34, 34, -34]);
    expect(camera.near).toBe(1);
    expect(camera.far).toBe(120);
    expect(key?.shadow.bias).toBeCloseTo(-0.0005, 6);
    expect(key?.shadow.normalBias).toBeCloseTo(0.6, 6);
    expect(scene.environment).not.toBeNull();
    expect(scene.environmentIntensity).toBeCloseTo(0.6, 6);
    expect(enemyParts(scene).length).toBeGreaterThan(0);
    expect(enemyParts(scene).every((mesh) => mesh.castShadow && mesh.receiveShadow)).toBe(true);
    view.dispose();
  });

  it('low clears the environment and leaves nothing casting', () => {
    const { scene, view } = setup(QUALITY.high);
    const pool = new Pool<EnemyEntity>(() => makeEnemy());
    spawn(pool, SKITTER);
    view.sync(frame(pool));
    expect(scene.environment).not.toBeNull();
    expect(enemyParts(scene).every((mesh) => mesh.castShadow)).toBe(true);

    view.applyQuality(QUALITY.low);
    expect(scene.environment).toBeNull();
    expect(directionals(scene).some((light) => light.castShadow)).toBe(false);
    expect(enemyParts(scene).some((mesh) => mesh.castShadow)).toBe(false);
    view.dispose();
  });

  it('medium keeps the environment but never the shadow map', () => {
    const { scene, view } = setup(QUALITY.medium);
    expect(scene.environment).not.toBeNull();
    expect(directionals(scene).some((light) => light.castShadow)).toBe(false);
    view.dispose();
  });

  it('fades the blobs when a real shadow map lands, and brings them back when it goes', () => {
    const { scene, view } = setup(QUALITY.medium);
    const material = blobLayer(scene).material as THREE.MeshBasicMaterial;
    expect(material.opacity).toBeCloseTo(0.35, 6);
    view.applyQuality(QUALITY.high);
    expect(material.opacity).toBeCloseTo(0.18, 6);
    view.applyQuality(QUALITY.low);
    expect(material.opacity).toBeCloseTo(0.35, 6);
    view.dispose();
  });
});

describe('the blob layer (SPEC-017 §4.6, AC-76 … AC-79)', () => {
  it('is one instanced plane with a 32² falloff map, above the ground and unculled', () => {
    const { scene, view } = setup();
    const mesh = blobLayer(scene);
    expect(mesh.instanceMatrix.count).toBe(2 + INSTANCES_PER_PART);
    expect(mesh.position.y).toBeCloseTo(0.02, 6);
    expect(mesh.frustumCulled).toBe(false);
    const material = mesh.material as THREE.MeshBasicMaterial;
    expect(material.color.getHex()).toBe(0x000000);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    const map = material.map as THREE.DataTexture;
    expect(map.image.width).toBe(32);
    expect(map.image.height).toBe(32);
    // Opaque at the centre, gone at the rim — computed in JS, no canvas.
    const data = map.image.data as unknown as Uint8Array;
    expect(data[(16 * 32 + 16) * 4 + 3]).toBeGreaterThan(200);
    expect(data[3]).toBe(0);
    view.dispose();
  });

  it('writes one instance per live entity, at the scales of §4.6', () => {
    const { scene, view } = setup();
    const pool = new Pool<EnemyEntity>(() => makeEnemy());
    spawn(pool, SKITTER);
    spawn(pool, SKITTER, { elite: true });
    spawn(pool, SKITTER, { state: 'dead' });
    spawn(pool, WURM, { specialKind: 'burrow_dig' });
    view.sync(frame(pool, follower));

    const mesh = blobLayer(scene);
    // Player + follower + the two live enemies; a corpse and a burrowed wurm
    // have nothing above the ground to cast from.
    expect(mesh.count).toBe(4);

    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const widthAt = (i: number): number => {
      mesh.getMatrixAt(i, matrix);
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      return scale.x;
    };
    expect(widthAt(0)).toBeCloseTo(1.4, 5); // the player
    expect(widthAt(1)).toBeCloseTo(1, 5); // the follower
    expect(widthAt(2)).toBeCloseTo(SKITTER.look.scale * 1.6, 5);
    expect(widthAt(3)).toBeCloseTo(SKITTER.look.scale * 1.6 * 1.3, 5); // elite
    view.dispose();
  });

  it('clamps to capacity rather than overrunning the layer', () => {
    const { scene, view } = setup();
    const pool = new Pool<EnemyEntity>(() => makeEnemy());
    for (let i = 0; i < 100; i++) spawn(pool, SKITTER);
    view.sync(frame(pool));
    expect(blobLayer(scene).count).toBe(2 + INSTANCES_PER_PART);
    view.dispose();
  });
});

describe('the planet grade (SPEC-017 §4.1, AC-81)', () => {
  it('is a warmer, crisper look pulled a little toward the planet fog', () => {
    const { view } = setup();
    expect(view.look.exposure).toBeCloseTo(1.05, 6);
    expect(view.look.contrast).toBeCloseTo(1.04, 6);
    expect(view.look.saturation).toBeCloseTo(1.05, 6);
    const tint = view.look.tint as [number, number, number];
    expect(tint).toHaveLength(3);
    for (const component of tint) expect(Math.abs(component - 1)).toBeLessThanOrEqual(0.08 + 1e-9);
    // Cinder-4's fog is a warm ochre, so the tint leans red over blue.
    expect(tint[0]).toBeGreaterThan(tint[2]);
    view.dispose();
  });

  it('differs per planet', () => {
    const warm = setup(QUALITY.medium, PLANETS.cinder4);
    const cold = setup(QUALITY.medium, PLANETS.vetra);
    expect(warm.view.look.tint).not.toEqual(cold.view.look.tint);
    warm.view.dispose();
    cold.view.dispose();
  });
});

describe('materials (SPEC-017 §4.7, SPEC-018)', () => {
  it('is standard or basic all the way down — the point cloud is gone', () => {
    const { scene, view } = setup();
    const kinds = new Set<string>();
    scene.traverse((node) => {
      const material = (node as THREE.Mesh).material;
      if (material === undefined) return;
      for (const entry of Array.isArray(material) ? material : [material]) kinds.add(entry.type);
    });
    expect([...kinds].sort()).toEqual(['MeshBasicMaterial', 'MeshStandardMaterial']);
    view.dispose();
  });

  it('keeps the player capsule transparent so the invulnerability blink still writes opacity', () => {
    const { scene, view } = setup();
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    f.time = 0.05; // sin(time × 30) > 0 — mid-blink
    f.player.invulnUntil = 1;
    view.sync(f);
    let capsule: THREE.MeshStandardMaterial | undefined;
    scene.traverse((node) => {
      const material = (node as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (material?.type === 'MeshStandardMaterial' && material.transparent && material.opacity < 1) capsule = material;
    });
    expect(capsule).toBeDefined();
    view.dispose();
  });

  it('the terrain receives, the obstacles cast, and the landing pad does not', () => {
    const { scene, view } = setup();
    let groundReceives = false;
    let pad: THREE.Mesh | undefined;
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      const geometry = mesh.geometry as THREE.BufferGeometry & { type?: string };
      if (geometry.type === 'PlaneGeometry' && mesh.name === 'terrain' && mesh.receiveShadow) groundReceives = true;
      if (mesh.name === 'poi:landing_pad') pad = mesh;
    });
    expect(groundReceives).toBe(true);
    expect(pad).toBeDefined();
    expect(pad?.castShadow).toBe(false);
    view.dispose();
  });
});

describe('the environment (SPEC-018)', () => {
  it('hangs everything under one root and stays inside the mesh budget', () => {
    const { scene, view } = setup();
    expect(scene.children.length).toBe(1);
    let meshes = 0;
    scene.traverse((node) => {
      if ((node as THREE.Mesh).isMesh === true) meshes++;
    });
    expect(meshes).toBeLessThanOrEqual(60);
    view.dispose();
  });

  it('dispose removes the root and leaves fog and background null', () => {
    const { scene, view } = setup();
    view.dispose();
    expect(scene.children.length).toBe(0);
    expect(scene.fog).toBeNull();
    expect(scene.background).toBeNull();
  });

  it('dispose frees the shadow map of the key light, which the geometry walk cannot see (SPEC-040 AC-27)', () => {
    const { scene, view } = setup(QUALITY.high);
    const key = directionals(scene).find((light) => light.castShadow);
    expect(key).toBeDefined();
    // What the renderer allocates on the first shadow pass: a colour target
    // and its depth texture, both freed when the target is.
    const map = new THREE.WebGLRenderTarget(1024, 1024);
    map.depthTexture = new THREE.DepthTexture(1024, 1024);
    (key as THREE.DirectionalLight).shadow.map = map;
    let freed = false;
    map.addEventListener('dispose', () => {
      freed = true;
    });
    view.dispose();
    expect(freed).toBe(true);
  });

  it('sync puts the player on the height field (§4.3)', () => {
    const { scene, view } = setup();
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    f.player.x = 33;
    f.player.z = -27; // outside the pad clearing, where relief is non-zero
    view.sync(f);
    const h = view.field.heightAt(33, -27);
    expect(h).not.toBe(0);
    // The player group is the one holding the point-light torch.
    let playerY: number | null = null;
    scene.traverse((node) => {
      if ((node as THREE.PointLight).isPointLight === true) playerY = node.parent?.position.y ?? null;
    });
    expect(playerY).not.toBeNull();
    expect(Math.abs((playerY as unknown as number) - h)).toBeLessThanOrEqual(1e-4);
    view.dispose();
  });

  it('setWeather writes the grade (§4.9)', () => {
    const { view } = setup();
    view.setWeather({ fogMult: 3, particles: 'sand', visibility: 0.4 }, 1);
    expect(view.grade.vignette).toBeCloseTo(0.5 * 0.6, 6);
    expect(view.grade.desaturate).toBeCloseTo(0.35, 6);
    expect(view.grade.tint[0]).toBeCloseTo(1.05, 6);
    expect(view.grade.tint[2]).toBeCloseTo(0.8, 6);
    view.setWeather({ fogMult: 1, particles: 'none', visibility: 1 }, 0);
    expect(view.grade.vignette).toBeCloseTo(0, 6);
    expect(view.grade.tint).toEqual([1, 1, 1]);
    view.dispose();
  });

  it('lightning flashes the hemisphere ×4, and is a no-op under reduce motion (18-j)', () => {
    const { scene, view } = setup();
    const base = PLANETS.cinder4.surface.look.light.ambient;
    view.setWeather({ fogMult: 1.8, particles: 'ash', visibility: 0.7 }, 1);
    // Find a 2.5 s window whose roll passes, exactly as the view rolls it.
    const seed = hash32(LAYOUT.hash, 'lightning');
    let tick = -1;
    for (let candidate = 0; candidate < 400; candidate++) {
      if (hash01(seed, candidate) < 0.15) {
        tick = candidate;
        break;
      }
    }
    expect(tick).toBeGreaterThanOrEqual(0);
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    f.time = tick * 2.5 + 0.01;
    view.sync(f);
    expect(hemisphere(scene).intensity).toBeCloseTo(base * 4, 6);
    // Two frames later the flash has passed.
    f.time = tick * 2.5 + 0.2;
    view.sync(f);
    expect(hemisphere(scene).intensity).toBeCloseTo(base, 6);
    // Reduce motion: the same window stays dark.
    view.reduceMotion = true;
    f.time = tick * 2.5 + 0.01;
    view.sync(f);
    expect(hemisphere(scene).intensity).toBeCloseTo(base, 6);
    view.dispose();
  });

  it('setGroundTextures swaps layers without a recompile (§4.10)', () => {
    const { scene, view } = setup();
    let terrain: THREE.Mesh | undefined;
    scene.traverse((node) => {
      if ((node as THREE.Mesh).name === 'terrain') terrain = node as THREE.Mesh;
    });
    expect(terrain).toBeDefined();
    const material = terrain?.material as THREE.MeshStandardMaterial;
    const version = material.version;
    const a = { ...groundLayer('rock', 32), tileMetres: 4 };
    const b = { ...groundLayer('basalt', 32), tileMetres: 6 };
    view.setGroundTextures(a, b);
    expect(material.map).toBe(a.albedo);
    expect(material.version).toBe(version); // no needsUpdate, no recompile
    view.dispose();
  });
});

// ------------------------------------------------------------- SPEC-019 §4.5

import { makeFollower } from '@/entities/Follower';
import { FOLLOWERS } from '@/data/index';
import { advanceViewTime, shakeOffset, type ShakeState } from '@/views/SurfaceView';

/** The streak mesh: the capsule-geometry instanced mesh, heads and ghosts together. */
function projectileMesh(scene: THREE.Scene): THREE.InstancedMesh[] {
  const found: THREE.InstancedMesh[] = [];
  scene.traverse((node) => {
    const mesh = node as THREE.InstancedMesh;
    if (mesh.isInstancedMesh !== true) return;
    if ((mesh.geometry as THREE.BufferGeometry & { type?: string }).type === 'CapsuleGeometry') found.push(mesh);
  });
  return found;
}

/** The round shots' mesh: the other instanced mesh on the streaks' material. */
function roundShotMesh(scene: THREE.Scene): THREE.InstancedMesh {
  const streaks = projectileMesh(scene)[0] as THREE.InstancedMesh;
  let found: THREE.InstancedMesh | undefined;
  scene.traverse((node) => {
    const mesh = node as THREE.InstancedMesh;
    if (mesh.isInstancedMesh === true && mesh !== streaks && mesh.material === streaks.material) found = mesh;
  });
  expect(found).toBeDefined();
  return found as THREE.InstancedMesh;
}

describe('projectiles (SPEC-019 AC-59 … AC-63)', () => {
  it('orients the capsule along vx/vz and pushes the plain tracer\'s colour × its head gain', () => {
    const { scene, view } = setup();
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    const shot = f.projectiles.alloc();
    Object.assign(shot, { x: 2, z: 3, vx: 6, vz: 8, radius: 0.12, owner: 'player' });
    view.sync(f);
    // One mesh holds the streaks — the head, then its two trailing ghosts.
    expect(projectileMesh(scene)).toHaveLength(1);
    const heads = projectileMesh(scene)[0] as THREE.InstancedMesh;
    const ghosts = heads;
    expect(heads.count).toBe(3);
    const matrix = new THREE.Matrix4();
    heads.getMatrixAt(0, matrix);
    // The rotated X basis must point along the (normalised) velocity.
    const basisX = new THREE.Vector3().setFromMatrixColumn(matrix, 0).normalize();
    expect(basisX.x).toBeCloseTo(0.6, 5);
    expect(basisX.z).toBeCloseTo(0.8, 5);
    expect(basisX.y).toBeCloseTo(0, 5);
    // The look's colour × its head gain; the material stays white.
    const color = heads.instanceColor as THREE.InstancedBufferAttribute;
    const base = new THREE.Color('#ffe9a0');
    expect(color.getX(0)).toBeCloseTo(base.r * shotHeadGain({ shape: 'tracer', color: '#ffe9a0' }), 4);
    expect(((heads.material as THREE.MeshBasicMaterial).color as THREE.Color).getHex()).toBe(0xffffff);

    // Ghosts trail at p − v · 0.03 and p − v · 0.06, at × 1.2 and × 0.6.
    ghosts.getMatrixAt(1, matrix);
    expect(matrix.elements[12]).toBeCloseTo(2 - 6 * 0.03, 5);
    expect(matrix.elements[14]).toBeCloseTo(3 - 8 * 0.03, 5);
    ghosts.getMatrixAt(2, matrix);
    expect(matrix.elements[12]).toBeCloseTo(2 - 6 * 0.06, 5);
    const ghostColor = ghosts.instanceColor as THREE.InstancedBufferAttribute;
    expect(ghostColor.getX(1)).toBeCloseTo(base.r * 1.2, 4);
    expect(ghostColor.getX(2)).toBeCloseTo(base.r * 0.6, 4);
    view.dispose();
  });

  it('a zero-velocity shot takes the owner facing and its ghosts collapse onto the head (19-j)', () => {
    const { scene, view } = setup();
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    f.player.facing = Math.PI / 2; // +Z
    const shot = f.projectiles.alloc();
    Object.assign(shot, { x: 4, z: -1, vx: 0, vz: 0, radius: 0.12, owner: 'player' });
    view.sync(f);
    const heads = projectileMesh(scene)[0] as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    heads.getMatrixAt(0, matrix);
    const basisX = new THREE.Vector3().setFromMatrixColumn(matrix, 0).normalize();
    expect(basisX.z).toBeCloseTo(1, 5); // facing π/2 points +Z
    heads.getMatrixAt(1, matrix);
    expect(matrix.elements[12]).toBeCloseTo(4, 5);
    expect(matrix.elements[14]).toBeCloseTo(-1, 5);
    view.dispose();
  });
});

describe('shot looks (SPEC-019 §4.5)', () => {
  /** One shot at (0, 0) flying +X at `speed`, drawn alone; the mesh it landed on and its instance colours. */
  function drawOne(look: ShotLook | null, owner: ProjectileEntity['owner'] = 'player', speed = 20) {
    const { scene, view } = setup();
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    const shot = f.projectiles.alloc();
    Object.assign(shot, { x: 0, z: 0, vx: speed, vz: 0, radius: 0.15, owner, shot: look });
    view.sync(f);
    const streaks = projectileMesh(scene)[0] as THREE.InstancedMesh;
    const rounds = roundShotMesh(scene);
    return { view, streaks, rounds };
  }

  function colourAt(mesh: THREE.InstancedMesh, i: number): THREE.Color {
    const c = mesh.instanceColor as THREE.InstancedBufferAttribute;
    return new THREE.Color(c.getX(i), c.getY(i), c.getZ(i));
  }

  function scaleAt(mesh: THREE.InstancedMesh, i: number): THREE.Vector3 {
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(i, m);
    const scale = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    return scale;
  }

  it('every weapon\'s shot draws in its own colour × its head gain, a streak on the capsules and a round shot on the ellipsoids', () => {
    for (const item of Object.values(ITEMS)) {
      if (item.kind !== 'weapon') continue;
      const { view, streaks, rounds } = drawOne(item.shot);
      const round = SHOT_DRAW[item.shot.shape].round;
      const mesh = round ? rounds : streaks;
      expect(mesh.count, item.id).toBe(1 + SHOT_DRAW[item.shot.shape].ghosts);
      expect((round ? streaks : rounds).count, item.id).toBe(0);
      expect((round ? streaks : rounds).visible, item.id).toBe(false);
      const want = new THREE.Color(item.shot.color).multiplyScalar(shotHeadGain(item.shot));
      const got = colourAt(mesh, 0);
      expect(got.r, item.id).toBeCloseTo(want.r, 4);
      expect(got.g, item.id).toBeCloseTo(want.g, 4);
      expect(got.b, item.id).toBeCloseTo(want.b, 4);
      view.dispose();
    }
  });

  it('an enemy shot stays green, and a bare player shot is the plain tracer', () => {
    const enemy = drawOne(null, 'enemy');
    expect(colourAt(enemy.streaks, 0).g).toBeCloseTo(new THREE.Color('#7fff8a').g * shotHeadGain({ shape: 'tracer', color: '#7fff8a' }), 4);
    expect(enemy.rounds.count).toBe(0);
    enemy.view.dispose();
    const plain = drawOne(null, 'player');
    expect(colourAt(plain.streaks, 0).b).toBeCloseTo(new THREE.Color('#ffe9a0').b * shotHeadGain({ shape: 'tracer', color: '#ffe9a0' }), 4);
    plain.view.dispose();
  });

  it('a head gain falls from × 2.5 with chroma: a pale look still blooms, a saturated one floors at × 1', () => {
    expect(shotHeadGain({ shape: 'tracer', color: '#ffffff' })).toBe(2.5);
    expect(shotHeadGain({ shape: 'tracer', color: '#ffe9a0' })).toBeCloseTo(2.5 - 2 * (95 / 255), 9);
    expect(shotHeadGain({ shape: 'needle', color: '#ff0000' })).toBe(1);
    // Every pale look (chroma ≤ 0.2) clears the surface's 1.5 bloom threshold in luminance.
    for (const look of [ITEMS.weapon_kinetic.shot, ITEMS.launcher_rocket.shot, ITEMS.relic_seeker.shot, DRONE_SHOT]) {
      const c = new THREE.Color(look.color).multiplyScalar(shotHeadGain(look));
      expect(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, look.color).toBeGreaterThan(1.5);
    }
  });

  it('a head covers the ground and its ghosts glow over it, fading by the shape\'s fade', () => {
    const { view, streaks } = drawOne(ITEMS.pistol_service.shot);
    const cover = streaks.geometry.getAttribute('shotCover') as THREE.InstancedBufferAttribute;
    expect(cover.getX(0)).toBe(HEAD_COVER);
    expect(cover.getX(1)).toBeCloseTo(GHOST_COVER, 6);
    expect(cover.getX(2)).toBeCloseTo(GHOST_COVER * SHOT_DRAW.tracer.fade, 6);
    // Premultiplied: src + dst · (1 − cover), one material for both shot meshes.
    const material = streaks.material as THREE.MeshBasicMaterial;
    expect(material.blending).toBe(THREE.CustomBlending);
    expect(material.blendSrc).toBe(THREE.OneFactor);
    expect(material.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
    expect(material.depthWrite).toBe(false);
    view.dispose();
  });

  it('a needle is longer and thinner than a tracer at the same speed, and a dart shorter', () => {
    const tracer = drawOne({ shape: 'tracer', color: '#ffffff' }, 'player', 30);
    const needle = drawOne({ shape: 'needle', color: '#ffffff' }, 'player', 30);
    const dart = drawOne({ shape: 'dart', color: '#ffffff' }, 'player', 30);
    const t = scaleAt(tracer.streaks, 0);
    const n = scaleAt(needle.streaks, 0);
    const d = scaleAt(dart.streaks, 0);
    expect(n.x).toBeGreaterThan(t.x * 1.5);
    expect(n.y).toBeLessThan(t.y);
    expect(d.x).toBeLessThan(t.x);
    for (const v of [tracer, needle, dart]) v.view.dispose();
  });

  it('a rocket trails five exhaust puffs in its trail colour that grow and fade', () => {
    const look = ITEMS.launcher_rocket.shot;
    const { view, rounds } = drawOne(look);
    expect(rounds.count).toBe(6);
    const trail = new THREE.Color(look.trail);
    expect(colourAt(rounds, 1).g).toBeCloseTo(trail.g * 1.2, 4);
    for (let k = 2; k <= 5; k++) {
      expect(scaleAt(rounds, k).y).toBeGreaterThan(scaleAt(rounds, k - 1).y);
      expect(colourAt(rounds, k).r).toBeLessThan(colourAt(rounds, k - 1).r);
    }
    view.dispose();
  });

  it('the drone, a thrown frag and a flare have looks of their own', () => {
    expect(SHOT_DRAW[THROWN_SHOT.shape].round).toBe(true);
    expect(SHOT_DRAW[FLARE_SHOT.shape].round).toBe(true);
    expect(DRONE_SHOT.color).not.toBe(ITEMS.weapon_kinetic.shot.color);
    const { view, rounds } = drawOne(FLARE_SHOT);
    expect(rounds.count).toBe(1 + SHOT_DRAW.ball.ghosts);
    view.dispose();
  });

  it('a lob\'s ghosts ride the arc behind its head (SPEC-029 §4.6)', () => {
    const shot = makeProjectile();
    // 14 m/s over 1 s: H = 3.5. Head at t = 0.5, ghost 0.1 s behind at t = 0.4.
    Object.assign(shot, { vx: 14, vz: 0, lob: true, flight: 1, ttl: 0.5 });
    expect(lobLift(shot, 14, 0)).toBeCloseTo(3.5, 6);
    expect(lobLift(shot, 14, 0.1)).toBeCloseTo(4 * 3.5 * 0.4 * 0.6, 6);
    // At launch a ghost does not dip below the head's start.
    shot.ttl = 1;
    expect(lobLift(shot, 14, 0.1)).toBe(0);
    shot.lob = false;
    expect(lobLift(shot, 14, 0)).toBe(0);
  });
});

describe('the follower view (SPEC-019 AC-30 … AC-33)', () => {
  it('hovers the procedural probe at 0.8 + 0.1·sin(2t) above the field, with a blooming glow', () => {
    const { scene, view } = setup();
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()), makeFollower(FOLLOWERS.science_probe, 7, -5));
    f.time = 0.6;
    view.sync(f);
    // No assets in this setup → the procedural probe (19-l): its glow material
    // must clear SPEC-017's bloom threshold (0.85).
    let glow: THREE.MeshStandardMaterial | undefined;
    let probeY: number | null = null;
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      const material = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (material?.name === 'Glow') {
        glow = material;
        probeY = mesh.parent?.position.y ?? null;
      }
    });
    expect(glow).toBeDefined();
    expect((glow as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(0.85);
    const expected = 0.8 + 0.1 * Math.sin(1.2) + view.field.heightAt(7, -5);
    expect(probeY).not.toBeNull();
    expect(probeY as unknown as number).toBeCloseTo(expected, 5);
    view.dispose();
  });
});

describe('shake and hit-stop (SPEC-019 §4.7, AC-89 … AC-94)', () => {
  it('shakeOffset decays to zero at until, deterministic from view time', () => {
    const shake: ShakeState = { amplitude: 0.5, until: 2, duration: 0.5 };
    const out = new THREE.Vector3();
    shakeOffset(shake, 1.6, 1, out);
    const expectedDecay = (2 - 1.6) / 0.5;
    expect(out.x).toBeCloseTo(0.5 * expectedDecay * Math.sin(37 * 1.6), 6);
    expect(out.y).toBe(0);
    expect(out.z).toBeCloseTo(0.5 * expectedDecay * Math.cos(29 * 1.6), 6);
    // Deterministic: the same time gives the same offset.
    const again = new THREE.Vector3();
    shakeOffset(shake, 1.6, 1, again);
    expect(again.equals(out)).toBe(true);
    // At and past `until` the offset is exactly zero.
    shakeOffset(shake, 2, 1, out);
    expect(out.length()).toBe(0);
  });

  it('camera shake at 0 forces the offset to zero (AC-90, 19-g; SPEC-045 §4.3)', () => {
    // Reduce motion sets Camera shake to 0, the scale `shakeOffset` takes.
    const shake: ShakeState = { amplitude: 0.5, until: 2, duration: 0.5 };
    const out = new THREE.Vector3(9, 9, 9);
    shakeOffset(shake, 1.6, 0, out);
    expect(out.toArray()).toEqual([0, 0, 0]);
  });

  it('advanceViewTime freezes the view clock for exactly two frames (AC-93, AC-94)', () => {
    const state = { frames: 0, time: 0 };
    expect(advanceViewTime(state, 1.0)).toBe(1.0);
    state.frames = 2; // an elite kill lands
    expect(advanceViewTime(state, 1.016)).toBe(1.0); // frozen
    expect(advanceViewTime(state, 1.033)).toBe(1.0); // frozen
    expect(advanceViewTime(state, 1.05)).toBe(1.05); // released
    expect(state.frames).toBe(0);
    expect(advanceViewTime(state, 1.066)).toBe(1.066);
  });
});

// ------------------------------------------------------------- SPEC-027 §4.4

/** The pillar: the one additive cylinder the guidance layer stands up. */
function pillar(scene: THREE.Scene): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh !== true || (mesh as THREE.InstancedMesh).isInstancedMesh === true) return;
    if ((mesh.geometry as THREE.CylinderGeometry).type === 'CylinderGeometry') found = mesh;
  });
  return found;
}

/** The route markers: the instanced disc mesh, capacity 48. */
function routeMarkers(scene: THREE.Scene): THREE.InstancedMesh | null {
  let found: THREE.InstancedMesh | null = null;
  scene.traverse((node) => {
    const mesh = node as THREE.InstancedMesh;
    if (mesh.isInstancedMesh !== true) return;
    if (mesh.geometry.type === 'CircleGeometry') found = mesh;
  });
  return found;
}

/** A straight route of `metres`, as the scene's `(x, z)` pair buffer. */
function straightRoute(metres: number): { route: Float32Array; routeLength: number } {
  const route = new Float32Array(96);
  route[0] = 0;
  route[1] = 0;
  route[2] = metres;
  route[3] = 0;
  return { route, routeLength: 2 };
}

describe('the guidance layer (SPEC-027 §4.4, AC-29..AC-34)', () => {
  it('builds nothing until it is asked to, and nothing at all for a null guide', () => {
    const { scene, view } = setup();
    expect(pillar(scene)).toBeNull();
    view.setGuide({ beacon: null, route: null, routeLength: 0, pulse: true });
    expect(pillar(scene)).toBeNull();
    expect(routeMarkers(scene)?.visible ?? false).toBe(false);
  });

  it('stands one additive pillar on the target, on the ground, and pulses its opacity', () => {
    const { scene, view } = setup();
    view.sync(frame(new Pool<EnemyEntity>(() => makeEnemy())));
    view.setGuide({ beacon: { x: 12, z: -8 }, route: null, routeLength: 0, pulse: true });
    const mesh = pillar(scene) as THREE.Mesh;
    expect(mesh).not.toBeNull();
    const geometry = mesh.geometry as THREE.CylinderGeometry;
    expect(geometry.parameters.radiusTop).toBe(0.35);
    expect(geometry.parameters.height).toBe(14);
    expect(geometry.parameters.radialSegments).toBe(12);
    expect(geometry.parameters.openEnded).toBe(true);
    // The vertical fade is four-component vertex colour, opaque at the base.
    const colors = geometry.getAttribute('color');
    expect(colors.itemSize).toBe(4);
    // A cylinder's origin is its middle, so it stands from `heightAt` upward.
    expect(mesh.position.y).toBeCloseTo(view.field.heightAt(12, -8) + 7, 5);
    expect(mesh.position.x).toBe(12);
    expect(mesh.position.z).toBe(-8);
    const material = mesh.material as THREE.MeshBasicMaterial;
    expect(material.blending).toBe(THREE.AdditiveBlending);
    expect(material.depthWrite).toBe(false);
    // §4.4: `0.35 + 0.25·sin(2π·t)` on the view clock `sync` last saw (t = 1).
    expect(material.opacity).toBeCloseTo(0.35 + 0.25 * Math.sin(Math.PI * 2), 5);

    // …and a flat 0.5 when nothing may move (27-j).
    view.reduceMotion = true;
    view.setGuide({ beacon: { x: 12, z: -8 }, route: null, routeLength: 0, pulse: true });
    expect(material.opacity).toBe(0.5);
  });

  it('lays route markers every 2.5 m, capped at 48, in one instanced draw', () => {
    const { scene, view } = setup();
    view.sync(frame(new Pool<EnemyEntity>(() => makeEnemy())));
    const short = straightRoute(10);
    view.setGuide({ beacon: null, ...short, pulse: true });
    const markers = routeMarkers(scene) as THREE.InstancedMesh;
    expect(markers).not.toBeNull();
    expect(markers.instanceMatrix.count).toBe(48);
    // 0, 2.5, 5, 7.5 and 10 m along a 10 m segment.
    expect(markers.count).toBe(5);
    expect(markers.visible).toBe(true);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    markers.getMatrixAt(1, matrix);
    position.setFromMatrixPosition(matrix);
    expect(position.x).toBeCloseTo(2.5, 5);
    expect(position.y).toBeCloseTo(view.field.heightAt(2.5, 0) + 0.05, 5);

    // A route far longer than the capacity stops at 48 rather than growing.
    view.setGuide({ beacon: null, ...straightRoute(400), pulse: true });
    expect(markers.count).toBe(48);

    // Two draw calls at most, and the triangles they cost: 24 for the pillar
    // (12 radial segments, open-ended) and 12 per disc (AC-34).
    const discs = markers.geometry.getIndex()?.count ?? 0;
    expect(discs / 3).toBe(12);
    expect(48 * 12 + 24).toBeLessThan(1600);

    // `route: null` takes the markers off the screen without disposing them.
    view.setGuide({ beacon: null, route: null, routeLength: 0, pulse: true });
    expect(markers.count).toBe(0);
    expect(markers.visible).toBe(false);
    expect(routeMarkers(scene)).toBe(markers);
  });

  it('travels a brightness wave along the markers, and holds it still under reduce motion', () => {
    const { scene, view } = setup();
    view.sync(frame(new Pool<EnemyEntity>(() => makeEnemy())));
    view.setGuide({ beacon: null, ...straightRoute(40), pulse: true });
    const markers = routeMarkers(scene) as THREE.InstancedMesh;
    const colors = markers.instanceColor as THREE.InstancedBufferAttribute;
    const wave = new Set<number>();
    for (let i = 0; i < markers.count; i++) wave.add(Math.round(colors.getX(i) * 1000));
    expect(wave.size).toBeGreaterThan(1);

    view.reduceMotion = true;
    view.setGuide({ beacon: null, ...straightRoute(40), pulse: true });
    const still = new Set<number>();
    for (let i = 0; i < markers.count; i++) still.add(Math.round(colors.getX(i) * 1000));
    expect(still).toEqual(new Set([1000]));
  });
});

// ---------------------------------------------------------------- SPEC-029

describe('lobs and deployables (SPEC-029 §4.6, §4.12)', () => {
  it('draws a lob at 0.9 + h + 4·H·t·(1−t), peaking at H = min(4, 0.25·distance)', () => {
    const { scene, view } = setup();
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    const shot = f.projectiles.alloc();
    // 14 m/s over 1 s of flight → 14 m of distance → H = min(4, 3.5) = 3.5.
    Object.assign(shot, { x: 0, z: 0, vx: 14, vz: 0, radius: 0.15, owner: 'player', lob: true, flight: 1, ttl: 0.5, targetX: 7, targetZ: 0 });
    view.sync(f);
    const heads = projectileMesh(scene)[0] as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    heads.getMatrixAt(0, matrix);
    const h = view.field.heightAt(0, 0);
    // t = 1 − ttl/flight = 0.5, so the arc term is 4 · 3.5 · 0.25 = 3.5.
    expect(matrix.elements[13]).toBeCloseTo(0.9 + h + 3.5, 4);
    view.dispose();
  });

  it('draws the deployables as one instanced mesh of pool size, capacity 8', () => {
    const { scene, view } = setup();
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    const mine = f.deployables.alloc();
    Object.assign(mine, { kind: 'mine', x: 2, z: 2, armed: true, armAt: 0, fuseAt: Infinity });
    const charge = f.deployables.alloc();
    Object.assign(charge, { kind: 'charge', x: -2, z: 3, armed: true, armAt: 0, fuseAt: 3 });
    view.sync(f);
    const boxes: THREE.InstancedMesh[] = [];
    scene.traverse((node) => {
      const mesh = node as THREE.InstancedMesh;
      if (mesh.isInstancedMesh === true && (mesh.geometry as { type?: string }).type === 'BoxGeometry' && mesh.instanceMatrix.count === 8) {
        boxes.push(mesh);
      }
    });
    expect(boxes).toHaveLength(1); // one mesh, one draw call
    const mesh = boxes[0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(2);
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(0, matrix);
    expect(matrix.elements[0]).toBeCloseTo(0.35, 5); // the mine disc
    mesh.getMatrixAt(1, matrix);
    expect(matrix.elements[0]).toBeCloseTo(0.3, 5); // the charge box
    view.dispose();
  });
});

// ---------------------------------------------------------------- SPEC-030

describe('SPEC-030 — shelter instancing and the occupied roof (AC-40, AC-41, AC-42)', () => {
  const SHELTERED: ViewLayout = {
    ...LAYOUT,
    shelters: [
      { kind: 'cave', x: 20, z: 20, rx: 6, rz: 6, angle: 0, gapAngle: Math.PI },
      { kind: 'cave', x: -20, z: 20, rx: 6, rz: 6, angle: 0, gapAngle: 0 },
      { kind: 'wreck', x: 0, z: -25, rx: 6.5, rz: 3.2, angle: 0.4, gapAngle: 0.4 + Math.PI / 2 },
    ],
    obstacles: [
      ...LAYOUT.obstacles,
      // Collision-only kinds and debris, as the generator now emits them.
      { x: 26, z: 20, radius: 1.1, kind: 'cave_wall' },
      { x: 5, z: -25, radius: 0.9, kind: 'wreck_hull' },
      { x: 9, z: -25, radius: 1, kind: 'debris' },
    ],
  };

  function instancedMeshes(scene: THREE.Scene): THREE.InstancedMesh[] {
    const found: THREE.InstancedMesh[] = [];
    scene.traverse((node) => {
      if ((node as THREE.InstancedMesh).isInstancedMesh === true) found.push(node as THREE.InstancedMesh);
    });
    return found;
  }

  function setupSheltered(): { scene: THREE.Scene; view: SurfaceView } {
    const scene = new THREE.Scene();
    return { scene, view: new SurfaceView(scene, SHELTERED, PLANETS.cinder4, QUALITY.medium) };
  }

  it('draws shelters as one instanced mesh per kind and part — ≤ 6 draws', () => {
    const bare = instancedMeshes(setup().scene).length;
    const withShelters = instancedMeshes(setupSheltered().scene).length;
    // Two caves and a wreck: cave body+roof, wreck body+roof+glow, plus the
    // one debris instancer — and never more than 6 shelter parts.
    expect(withShelters - bare).toBeGreaterThanOrEqual(4);
    expect(withShelters - bare).toBeLessThanOrEqual(7); // ≤ 6 shelter parts + debris
  });

  it('collision-only wall kinds are not drawn by the obstacle instancer (AC-42)', () => {
    // The wall circles appear in obstacles but no instanced mesh grows for
    // them: rebuilding with the wall kinds stripped changes nothing.
    const stripped: ViewLayout = {
      ...SHELTERED,
      obstacles: SHELTERED.obstacles.filter((o) => o.kind !== 'cave_wall' && o.kind !== 'wreck_hull'),
    };
    const sceneA = new THREE.Scene();
    void new SurfaceView(sceneA, SHELTERED, PLANETS.cinder4, QUALITY.medium);
    const sceneB = new THREE.Scene();
    void new SurfaceView(sceneB, stripped, PLANETS.cinder4, QUALITY.medium);
    expect(instancedMeshes(sceneA).length).toBe(instancedMeshes(sceneB).length);
  });

  it('setOccupiedShelter scales the occupied roof to zero and restores the previous one (AC-41)', () => {
    const { view, scene } = setupSheltered();
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const meshes = instancedMeshes(scene);
    const roofScale = (index: number): number => {
      // Find the roof mesh holding this shelter's instance by probing all
      // instanced meshes for a near-zero scale after occupying.
      let smallest = Infinity;
      for (const mesh of meshes) {
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          scale.setFromMatrixScale(matrix);
          smallest = Math.min(smallest, scale.x);
        }
      }
      void index;
      return smallest;
    };
    expect(roofScale(0)).toBeGreaterThan(0.01); // nothing hidden yet
    view.setOccupiedShelter(0);
    expect(roofScale(0)).toBeLessThan(0.01); // one roof gone
    view.setOccupiedShelter(2); // the wreck: previous roof restored
    expect(roofScale(2)).toBeLessThan(0.01);
    view.setOccupiedShelter(null);
    expect(roofScale(0)).toBeGreaterThan(0.01); // all roofs back
  });

  it('wallVisible counts the chunks inside a frustum (AC-37)', () => {
    const { view } = setupSheltered();
    const everything = new THREE.Frustum(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6),
      new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6),
      new THREE.Plane(new THREE.Vector3(1, 0, 0), 1e6),
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e6),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6),
    );
    view.updateWallVisibility(everything);
    expect(view.wallVisible).toBe(8);
    const nothing = new THREE.Frustum(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -1e6),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -1e6),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -1e6),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -1e6),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -1e6),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -1e6),
    );
    view.updateWallVisibility(nothing);
    expect(view.wallVisible).toBe(0);
  });
});

// SPEC-015 AC-5: the scatter cap's preset inference reads `maxParticles`
// alone, so the three thresholds and the three shipped rows have to agree.
describe('presetOf (SPEC-015 AC-5)', () => {
  it('maps every shipped preset back to its own name', () => {
    expect(presetOf(QUALITY.low)).toBe('low');
    expect(presetOf(QUALITY.medium)).toBe('medium');
    expect(presetOf(QUALITY.high)).toBe('high');
  });
});

describe('setPropModels (SPEC-040 §4.6, E72)', () => {
  /** A one-mesh unit prop, the way the Blender drop exports them. */
  function rockModel(): THREE.Group {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.DodecahedronGeometry(1), new THREE.MeshStandardMaterial({ color: '#a89a88' })));
    return group;
  }

  /** Cinder-4 is a desert: `rock` has a model (`desert_rock_a`), `spire` has none. */
  function fakeAssets(): { assets: Assets; land(): void } {
    let landed = false;
    const assets = {
      hasModel: (id: string) => landed && id === 'desert_rock_a',
      model: () => rockModel(),
    } as unknown as Assets;
    return {
      assets,
      land: () => {
        landed = true;
      },
    };
  }

  /** The instanced prop bodies — the meshes that carry the occluder fade — by their first instance. */
  function props(scene: THREE.Scene): Map<string, THREE.InstancedMesh> {
    const out = new Map<string, THREE.InstancedMesh>();
    const at = new THREE.Vector3();
    scene.traverse((node) => {
      const mesh = node as THREE.InstancedMesh;
      if (mesh.isInstancedMesh !== true || mesh.geometry.getAttribute('instanceFade') === undefined) return;
      at.setFromMatrixPosition(new THREE.Matrix4().fromArray(mesh.instanceMatrix.array, 0));
      out.set(`${Math.round(at.x)},${Math.round(at.z)}`, mesh);
    });
    return out;
  }

  const ROCK = '4,4';
  const SMALL_ROCK = '8,8';
  const SPIRE = '-6,9';

  it('rebuilds a modelled kind into its variant mesh and disposes the procedural ones; a kind with no model is left alone', () => {
    // SPEC-046 §4.2 replaced the in-place swap: the kind's obstacle and small
    // prop meshes give way to one mesh per loaded variant, which they share —
    // only `_a` lands here, so `_b`'s instance draws with it too (46-b).
    const scene = new THREE.Scene();
    const fake = fakeAssets();
    const view = new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium, fake.assets);
    expect(view.propSource).toBe('procedural');
    const occluders = view.occluderProps;

    const before = props(scene);
    expect([...before.keys()].sort()).toEqual([SPIRE, ROCK, SMALL_ROCK].sort());
    const snapshot = new Map(
      [...before].map(([key, mesh]) => [key, { mesh, geometry: mesh.geometry, matrix: [...mesh.instanceMatrix.array.slice(0, 16)] }]),
    );
    const disposed = new Set<THREE.BufferGeometry>();
    for (const { geometry } of snapshot.values()) geometry.addEventListener('dispose', () => disposed.add(geometry));
    const triangles = (geometry: THREE.BufferGeometry): number => (geometry.getAttribute('position') as THREE.BufferAttribute).count / 3;

    fake.land();
    view.setPropModels(fake.assets);

    const after = props(scene);
    // Both rocks now draw from one model mesh, the obstacle first.
    const rock = after.get(ROCK) as THREE.InstancedMesh;
    expect(after.has(SMALL_ROCK)).toBe(false);
    expect(rock.count).toBe(2);
    expect(triangles(rock.geometry)).toBe(36); // a dodecahedron, not the procedural rock
    expect([...rock.instanceMatrix.array.slice(0, 16)]).toEqual(snapshot.get(ROCK)?.matrix);
    expect([...rock.instanceMatrix.array.slice(16, 32)]).toEqual(snapshot.get(SMALL_ROCK)?.matrix);
    for (const key of [ROCK, SMALL_ROCK]) {
      const was = snapshot.get(key) as NonNullable<ReturnType<typeof snapshot.get>>;
      expect(disposed.has(was.geometry), key).toBe(true);
      expect(was.mesh.parent, key).toBeNull();
    }
    const spire = after.get(SPIRE) as THREE.InstancedMesh;
    expect(spire).toBe(snapshot.get(SPIRE)?.mesh);
    expect(spire.geometry).toBe(snapshot.get(SPIRE)?.geometry);
    expect(disposed.has(spire.geometry)).toBe(false);
    expect(view.propSource).toBe('glb');
    // Every occluder candidate stays, in its place.
    expect(view.occluderProps).toBe(occluders);
    expect(view.occluderProps).toHaveLength(3);

    // A second call has nothing left to rebuild.
    view.setPropModels(fake.assets);
    expect(props(scene).get(ROCK)).toBe(rock);
    expect(rock.geometry.getAttribute('position')).toBeDefined();
  });

  it('stands a swapped rock on the ground: its geometry gives back the procedural lift', () => {
    const scene = new THREE.Scene();
    const fake = fakeAssets();
    const view = new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium, fake.assets);
    fake.land();
    view.setPropModels(fake.assets);
    const rock = props(scene).get(ROCK) as THREE.InstancedMesh;
    rock.geometry.computeBoundingBox();
    const model = new THREE.DodecahedronGeometry(1);
    model.computeBoundingBox();
    // Half a unit comes off the model, as 18-d's lift put half a unit on.
    expect(rock.geometry.boundingBox?.min.y).toBeCloseTo((model.boundingBox?.min.y ?? 0) - 0.5, 5);
    expect(rock.geometry.boundingBox?.max.y).toBeCloseTo((model.boundingBox?.max.y ?? 0) - 0.5, 5);
  });

  it('draws from the models from the start when the set had landed, and then has nothing to do', () => {
    const scene = new THREE.Scene();
    const fake = fakeAssets();
    fake.land();
    const view = new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium, fake.assets);
    expect(view.propSource).toBe('glb');
    const geometry = (props(scene).get(ROCK) as THREE.InstancedMesh).geometry;
    view.setPropModels(fake.assets);
    expect((props(scene).get(ROCK) as THREE.InstancedMesh).geometry).toBe(geometry);
  });

  it('reads glb for a planet whose kinds have no models at all', () => {
    const scene = new THREE.Scene();
    const layout: ViewLayout = { ...LAYOUT, obstacles: [{ x: -6, z: 9, radius: 1, kind: 'spire' }], props: [] };
    const view = new SurfaceView(scene, layout, PLANETS.cinder4, QUALITY.medium);
    expect(view.propSource).toBe('glb');
  });
});

// ---------------------------------------------------------------- SPEC-046

import { vi } from 'vitest';
import { TUG_RADIUS } from '@/systems/Layout';
import { CulledInstances } from '@/views/InstanceCuller';
import { LANDMARK_SCALE, variantIndex } from '@/views/SurfaceProps';
import { TUG_FADE_RADIUS, TUG_SCALE } from '@/views/SurfaceView';

describe('SPEC-046 — props in their own colours, both variants, only what is on screen, the tug', () => {
  /** A unit prop with an authored `COLOR_0`, the way the Blender drop exports it. */
  function model(geometry: THREE.BufferGeometry, rgb: readonly [number, number, number]): THREE.Group {
    const colors = new Float32Array((geometry.getAttribute('position') as THREE.BufferAttribute).count * 3);
    for (let i = 0; i < colors.length; i += 3) colors.set(rgb, i);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true })));
    return group;
  }

  /** The tug: `SalvageTug` with a `Hull` and a `Glow` mesh, y from −0.23 to 0.56. */
  function shipModel(): THREE.Group {
    const ship = new THREE.Group();
    ship.name = 'SalvageTug';
    const hullGeometry = new THREE.BoxGeometry(2.5, 0.79, 2.04);
    hullGeometry.translate(0, (0.56 - 0.23) / 2, 0.16);
    const hull = new THREE.Mesh(hullGeometry, new THREE.MeshStandardMaterial({ name: 'Hull' }));
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.2), new THREE.MeshStandardMaterial({ name: 'Glow' }));
    glow.position.set(0, 0.1, -0.7);
    ship.add(hull, glow);
    return ship;
  }

  const SHIP_MATERIALS = new Map<string, THREE.Material>();
  /** Fake assets: whatever of the two desert rock variants and the ship are "loaded". */
  function assetsWith(ids: readonly string[]): Assets {
    return {
      hasModel: (id: string) => ids.includes(id),
      model: (id: string) => {
        if (id === 'desert_rock_a') return model(new THREE.DodecahedronGeometry(1), [0.8, 0.6, 0.4]);
        if (id === 'desert_rock_b') return model(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), [0.2, 0.4, 0.9]);
        if (id === 'ship') {
          // A clone shares the cache's materials and geometry, tagged shared,
          // as `Assets.model` hands them out (SPEC-003 D-33).
          const ship = shipModel();
          ship.traverse((node) => {
            const mesh = node as THREE.Mesh;
            if (mesh.isMesh !== true) return;
            const name = (mesh.material as THREE.Material).name;
            const shared = SHIP_MATERIALS.get(name) ?? (mesh.material as THREE.Material);
            shared.userData['shared'] = true;
            mesh.geometry.userData['shared'] = true;
            SHIP_MATERIALS.set(name, shared);
            mesh.material = shared;
          });
          return ship;
        }
        throw new Error(`no ${id}`);
      },
    } as unknown as Assets;
  }

  /** Every prop body — the instanced meshes carrying the occluder fade. */
  function bodies(scene: THREE.Scene): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    scene.traverse((node) => {
      const mesh = node as THREE.InstancedMesh;
      if (mesh.isInstancedMesh === true && mesh.geometry.getAttribute('instanceFade') !== undefined) out.push(mesh);
    });
    return out;
  }

  function translationOf(mesh: THREE.InstancedMesh, slot: number): THREE.Vector3 {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(slot, matrix);
    return new THREE.Vector3().setFromMatrixPosition(matrix);
  }

  /** The mesh drawing the instance at (x, z), and its slot. */
  function find(scene: THREE.Scene, x: number, z: number): { mesh: THREE.InstancedMesh; slot: number } {
    for (const mesh of bodies(scene)) {
      for (let slot = 0; slot < mesh.count; slot++) {
        const at = translationOf(mesh, slot);
        if (Math.abs(at.x - x) < 1e-4 && Math.abs(at.z - z) < 1e-4) return { mesh, slot };
      }
    }
    throw new Error(`nothing drawn at ${x}, ${z}`);
  }

  /** The scene's fixed rig around `target`, and its frustum. */
  function rig(target: { x: number; z: number }, distance = 22, fov = 40, aspect = 16 / 9): THREE.Frustum {
    const pitch = (55 * Math.PI) / 180;
    const yaw = (45 * Math.PI) / 180;
    const camera = new THREE.PerspectiveCamera(fov, aspect, 1, 130);
    camera.position.set(
      target.x + distance * Math.cos(pitch) * Math.sin(yaw),
      distance * Math.sin(pitch),
      target.z + distance * Math.cos(pitch) * Math.cos(yaw),
    );
    camera.lookAt(target.x, 0, target.z);
    camera.updateMatrixWorld();
    return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  }

  /** Walk every fade to its target: one long step of `sync`. */
  function settle(view: SurfaceView): void {
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    f.dt = 1;
    view.sync(f);
  }

  it('draws a two-instance kind as two variant meshes on the white, smooth GLB material', () => {
    // The suite's layout: the rock obstacle picks `_b`, the small rock `_a`.
    expect(variantIndex(LAYOUT.hash, 'rock', 0, 2)).toBe(1);
    expect(variantIndex(LAYOUT.hash, 'rock_small', 0, 2)).toBe(0);
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium, assetsWith(['desert_rock_a', 'desert_rock_b']));
    const rocks = bodies(scene).filter((mesh) => (mesh.material as THREE.MeshStandardMaterial).color.getHex() === 0xffffff);
    expect(rocks).toHaveLength(2);
    const material = rocks[0]?.material as THREE.MeshStandardMaterial;
    expect(rocks[1]?.material).toBe(material);
    expect(material.flatShading).toBe(false);
    expect(material.vertexColors).toBe(true);
    expect(material.roughness).toBeCloseTo(0.85, 6);
    expect(material.metalness).toBeCloseTo(0.05, 6);
    const obstacle = find(scene, 4, 4);
    const small = find(scene, 8, 8);
    expect(obstacle.mesh).not.toBe(small.mesh);
    expect(obstacle.mesh.geometry.getAttribute('position').count / 3).toBe(12); // `_b`, the box
    expect(small.mesh.geometry.getAttribute('position').count / 3).toBe(36); // `_a`, the dodecahedron
    // Each vertex carries its authored COLOR_0, which the white material keeps.
    const color = obstacle.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect([color.getX(0), color.getY(0), color.getZ(0)].map((v) => Math.round(v * 100) / 100)).toEqual([0.2, 0.4, 0.9]);
    expect(view.propSource).toBe('glb');

    // The transforms are the variant-free build's: positions, rotations, scales.
    const single = new THREE.Scene();
    new SurfaceView(single, LAYOUT, PLANETS.cinder4, QUALITY.medium, assetsWith(['desert_rock_a']));
    for (const [x, z] of [[4, 4], [8, 8]] as const) {
      const a = new THREE.Matrix4();
      const b = new THREE.Matrix4();
      const one = find(single, x, z);
      const two = find(scene, x, z);
      one.mesh.getMatrixAt(one.slot, a);
      two.mesh.getMatrixAt(two.slot, b);
      expect(b.elements).toEqual(a.elements);
    }
    view.dispose();
  });

  it('a procedural body keeps the accent, and nothing in the world is flat-shaded any more', () => {
    const scene = new THREE.Scene();
    const sheltered: ViewLayout = {
      ...LAYOUT,
      shelters: [{ kind: 'cave', x: 20, z: 20, rx: 6, rz: 6, angle: 0, gapAngle: Math.PI }],
    };
    const view = new SurfaceView(scene, sheltered, PLANETS.cinder4, QUALITY.medium);
    const accent = new THREE.Color(PLANETS.cinder4.surface.palette.accent).getHex();
    const rock = find(scene, 4, 4).mesh.material as THREE.MeshStandardMaterial;
    expect(rock.color.getHex()).toBe(accent);
    expect(rock.flatShading).toBe(false);
    // The ring, the wall's rock and hull, the shelter roof: smooth, all of them.
    let ring: THREE.MeshStandardMaterial | null = null;
    const wall = new Set<THREE.Material>();
    let materials = 0;
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      const material = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (material === undefined) return;
      materials++;
      expect(material.flatShading === true, `${mesh.name || mesh.type}`).toBe(false);
      if (mesh.name === 'boundary-ring') ring = material;
      if (mesh.parent?.name.startsWith('wall-chunk') === true) wall.add(material);
    });
    expect(materials).toBeGreaterThan(10);
    expect(ring).not.toBeNull();
    expect(wall.size).toBe(2); // rock and hull
    view.dispose();
  });

  it('both body materials carry the fade, and one faded occluder turns both transparent together and back', () => {
    const scene = new THREE.Scene();
    // Cinder-4's rock draws from its models; its spire has none and stays sculpted.
    const view = new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium, assetsWith(['desert_rock_a', 'desert_rock_b']));
    const glb = find(scene, 4, 4).mesh.material as THREE.MeshStandardMaterial;
    const accent = find(scene, -6, 9).mesh.material as THREE.MeshStandardMaterial;
    expect(glb).not.toBe(accent);
    for (const material of [glb, accent]) {
      expect(material.customProgramCacheKey()).toBe('prop-fade/1');
      const shader = { vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>' };
      material.onBeforeCompile(shader as unknown as Parameters<THREE.Material['onBeforeCompile']>[0], undefined as never);
      expect(shader.vertexShader).toContain('attribute float instanceFade');
      expect(shader.fragmentShader).toContain('diffuseColor.a *= vInstanceFade');
      expect(material.transparent).toBe(false);
    }
    // Only the sculpted spire (candidate 1) occludes.
    const flags = new Uint8Array(view.occluderProps.length);
    flags[1] = 1;
    view.setOccluding(flags, 0.3);
    settle(view);
    expect(view.fadedOccluders).toBe(1);
    for (const material of [glb, accent]) {
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
    }
    const spire = find(scene, -6, 9);
    expect((spire.mesh.geometry.getAttribute('instanceFade') as THREE.BufferAttribute).getX(spire.slot)).toBeCloseTo(0.3, 6);
    flags[1] = 0;
    settle(view);
    expect(view.fadedOccluders).toBe(0);
    for (const material of [glb, accent]) {
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(true);
    }
    view.dispose();
  });

  it('setPropModels splits a procedural kind into its variant meshes, keeping every matrix and fade, and disposes the procedural geometry', () => {
    let landed = false;
    const both = assetsWith(['desert_rock_a', 'desert_rock_b']);
    const assets = {
      hasModel: (id: string) => landed && both.hasModel(id as never),
      model: (id: string) => both.model(id as never),
    } as unknown as Assets;
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium, assets);
    const before = { obstacle: find(scene, 4, 4), small: find(scene, 8, 8) };
    expect(before.obstacle.mesh).not.toBe(before.small.mesh); // the sculpted obstacle and small rock
    const matrices = [before.obstacle, before.small].map(({ mesh, slot }) => {
      const m = new THREE.Matrix4();
      mesh.getMatrixAt(slot, m);
      return [...m.elements];
    });
    const disposed: THREE.BufferGeometry[] = [];
    for (const { mesh } of [before.obstacle, before.small]) mesh.geometry.addEventListener('dispose', () => disposed.push(mesh.geometry));
    // Both rocks are mid-fade when the set lands (candidates 0 and 2; the spire is 1).
    const flags = new Uint8Array(view.occluderProps.length);
    flags[0] = 1;
    flags[2] = 1;
    view.setOccluding(flags, 0.3);
    settle(view);

    landed = true;
    view.setPropModels(assets);

    const after = { obstacle: find(scene, 4, 4), small: find(scene, 8, 8) };
    expect(after.obstacle.mesh).not.toBe(after.small.mesh); // `_b` and `_a`, one mesh each
    expect(after.obstacle.mesh.geometry.getAttribute('position').count / 3).toBe(12);
    expect(after.small.mesh.geometry.getAttribute('position').count / 3).toBe(36);
    [after.obstacle, after.small].forEach(({ mesh, slot }, i) => {
      const m = new THREE.Matrix4();
      mesh.getMatrixAt(slot, m);
      expect([...m.elements]).toEqual(matrices[i]);
      expect((mesh.geometry.getAttribute('instanceFade') as THREE.BufferAttribute).getX(slot)).toBeCloseTo(0.3, 6);
      expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xffffff);
    });
    expect(disposed).toHaveLength(2);
    expect(before.obstacle.mesh.parent).toBeNull();
    expect(before.small.mesh.parent).toBeNull();
    expect(view.occluderProps).toHaveLength(3);
    // The fades keep walking on the new layers: clearing the flags brings them back.
    view.setOccluding(new Uint8Array(view.occluderProps.length), 0.3);
    settle(view);
    expect((after.obstacle.mesh.geometry.getAttribute('instanceFade') as THREE.BufferAttribute).getX(after.obstacle.slot)).toBe(1);
    view.dispose();
  });

  it('a variant that never loads draws with the first one that did; with none the kind stays sculpted', () => {
    const scene = new THREE.Scene();
    new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium, assetsWith(['desert_rock_b']));
    // The small rock picked `_a`, which is missing: it shares `_b`'s mesh.
    expect(find(scene, 4, 4).mesh).toBe(find(scene, 8, 8).mesh);
    expect(find(scene, 8, 8).mesh.geometry.getAttribute('position').count / 3).toBe(12);
    const none = new THREE.Scene();
    const view = new SurfaceView(none, LAYOUT, PLANETS.cinder4, QUALITY.medium, assetsWith([]));
    expect(find(none, 4, 4).mesh).not.toBe(find(none, 8, 8).mesh);
    expect(view.propSource).toBe('procedural');
  });

  it('a tree-contract model is not drawable, and does not hold propSource at procedural (46-c)', () => {
    const tree = (): THREE.Group => {
      const group = new THREE.Group();
      const leaf = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
      leaf.name = 'Leaf';
      group.add(leaf);
      return group;
    };
    const assets = { hasModel: (id: string) => id.startsWith('jungle_tree_'), model: () => tree() } as unknown as Assets;
    const layout: ViewLayout = { ...LAYOUT, obstacles: [{ x: 4, z: 4, radius: 1.2, kind: 'tree' }], props: [] };
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, layout, PLANETS.thessaly, QUALITY.medium, assets);
    const material = find(scene, 4, 4).mesh.material as THREE.MeshStandardMaterial;
    expect(material.color.getHex()).toBe(new THREE.Color(PLANETS.thessaly.surface.palette.accent).getHex());
    expect(view.propSource).toBe('glb');
    view.dispose();
  });

  it('a landmark draws at 0.4 × its radius, and its occluder grows with it (§4.3)', () => {
    for (const [planet, radius] of [
      [PLANETS.cinder4, 6],
      [PLANETS.hive, 7],
      [PLANETS.ferrum, 6],
    ] as const) {
      const layout: ViewLayout = {
        ...LAYOUT,
        pois: [...LAYOUT.pois, { kind: 'landmark', x: -20, z: 15, radius }],
        obstacles: [],
        props: [],
      };
      const scene = new THREE.Scene();
      const view = new SurfaceView(scene, layout, planet, QUALITY.medium);
      let landmark: THREE.Mesh | null = null;
      let glow: THREE.Mesh | null = null;
      scene.traverse((node) => {
        if (node.name === 'poi:landmark') landmark = node as THREE.Mesh;
        if (node.name === 'poi-glow:landmark') glow = node as THREE.Mesh;
      });
      const mesh = landmark as unknown as THREE.Mesh;
      expect(mesh.scale.x, planet.id).toBeCloseTo(LANDMARK_SCALE * radius, 6);
      if (glow !== null) expect((glow as THREE.Mesh).scale.x, planet.id).toBeCloseTo(LANDMARK_SCALE * radius, 6);
      mesh.geometry.computeBoundingBox();
      const occluder = view.occluderProps[0];
      expect(occluder?.radius, planet.id).toBeCloseTo(radius * 0.5, 6);
      expect(occluder?.height, planet.id).toBeCloseTo((mesh.geometry.boundingBox?.max.y ?? 0) * LANDMARK_SCALE * radius, 6);
      view.dispose();
    }
  });

  it('setView refreshes once for the same view, again a metre on, and when the distance, field of view or aspect moves', () => {
    const refresh = vi.spyOn(CulledInstances.prototype, 'refresh');
    try {
      const { view } = setup();
      const layers = (): number => refresh.mock.calls.length;
      const target = { x: 2, z: -2 };
      const frustum = rig(target);
      view.setView(target.x, target.z, 22, 40, 16 / 9, frustum);
      const perRefresh = layers();
      expect(perRefresh).toBeGreaterThan(3); // props, glows, scatter, ring
      view.setView(target.x, target.z, 22, 40, 16 / 9, frustum);
      view.setView(target.x + 0.6, target.z, 22, 40, 16 / 9, frustum);
      expect(layers()).toBe(perRefresh);
      view.setView(target.x + 1, target.z, 22, 40, 16 / 9, frustum);
      expect(layers()).toBe(perRefresh * 2);
      view.setView(target.x + 1, target.z, 17, 40, 16 / 9, frustum);
      expect(layers()).toBe(perRefresh * 3);
      view.setView(target.x + 1, target.z, 17, 48, 16 / 9, frustum);
      expect(layers()).toBe(perRefresh * 4);
      view.setView(target.x + 1, target.z, 17, 48, 0.75, frustum);
      expect(layers()).toBe(perRefresh * 5);
      // The shadow map coming on moves every pad: the next view refreshes.
      view.applyQuality(QUALITY.high);
      view.setView(target.x + 1, target.z, 17, 48, 0.75, frustum);
      expect(layers()).toBe(perRefresh * 6);
      view.dispose();
    } finally {
      refresh.mockRestore();
    }
  });

  it('refreshes when the look-ahead swings the view a metre at its corners, though the target moved less', () => {
    const refresh = vi.spyOn(CulledInstances.prototype, 'refresh');
    try {
      const { view } = setup();
      // The scene's camera: anchored at the player, turned toward a 2 m look-ahead.
      const anchored = (bias: { x: number; z: number }): THREE.Frustum => {
        const pitch = (55 * Math.PI) / 180;
        const yaw = (45 * Math.PI) / 180;
        const camera = new THREE.PerspectiveCamera(40, 16 / 9, 1, 130);
        camera.position.set(22 * Math.cos(pitch) * Math.sin(yaw), 22 * Math.sin(pitch), 22 * Math.cos(pitch) * Math.cos(yaw));
        camera.lookAt(bias.x, 0, bias.z);
        camera.updateMatrixWorld();
        return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      };
      const east = { x: 2, z: 0 };
      view.setView(east.x, east.z, 22, 40, 16 / 9, anchored(east));
      const once = refresh.mock.calls.length;
      // A 28° turn: the look-at point moves 0.97 m, the far corners over 2 m.
      const turn = (28 * Math.PI) / 180;
      const turned = { x: 2 * Math.cos(turn), z: 2 * Math.sin(turn) };
      expect(Math.hypot(turned.x - east.x, turned.z - east.z)).toBeLessThan(1);
      view.setView(turned.x, turned.z, 22, 40, 16 / 9, anchored(turned));
      expect(refresh.mock.calls.length).toBe(once * 2);
      // Holding that heading changes nothing more.
      view.setView(turned.x, turned.z, 22, 40, 16 / 9, anchored(turned));
      expect(refresh.mock.calls.length).toBe(once * 2);
      view.dispose();
    } finally {
      refresh.mockRestore();
    }
  });

  it('reports instancesDrawn and cullMs, and draws only part of a large layout at the spawn', () => {
    const layout: ViewLayout = { ...LAYOUT, halfSize: 160 };
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, layout, PLANETS.thessaly, QUALITY.medium);
    const all = view.instancesDrawn;
    expect(all).toBeGreaterThan(600); // 600 tufts + 240 spores + the ring, before any view
    view.setView(12, 0, 22, 40, 16 / 9, rig({ x: 12, z: 0 }));
    expect(view.instancesDrawn).toBeGreaterThan(0);
    expect(view.instancesDrawn).toBeLessThan(all / 3);
    expect(view.cullMs).toBeGreaterThanOrEqual(0);
    expect(Math.round(view.cullMs * 100) / 100).toBe(view.cullMs);
    view.dispose();
  });

  it('an occluder faded, or a roof lifted, while off screen is faded or lifted when it is drawn again (46-d)', () => {
    const layout: ViewLayout = {
      ...LAYOUT,
      halfSize: 120,
      obstacles: [...LAYOUT.obstacles, { x: 80, z: 80, radius: 1.5, kind: 'rock' }],
      shelters: [{ kind: 'cave', x: -70, z: -70, rx: 6, rz: 6, angle: 0, gapAngle: 0 }],
    };
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, layout, PLANETS.cinder4, QUALITY.medium);
    // Looking at the spawn: neither the far rock nor the cave is drawn.
    view.setView(0, 0, 22, 40, 16 / 9, rig({ x: 0, z: 0 }));
    expect(() => find(scene, 80, 80)).toThrow();
    // The far rock is occluder 1 (rocks first, in layout order); the cave is last.
    const flags = new Uint8Array(view.occluderProps.length);
    flags[1] = 1;
    view.setOccluding(flags, 0.3);
    settle(view);
    view.setOccupiedShelter(0);
    // Walk over: both come into view, faded and lifted.
    view.setView(80, 80, 22, 40, 16 / 9, rig({ x: 80, z: 80 }));
    const rock = find(scene, 80, 80);
    expect((rock.mesh.geometry.getAttribute('instanceFade') as THREE.BufferAttribute).getX(rock.slot)).toBeCloseTo(0.3, 6);
    view.setView(-70, -70, 22, 40, 16 / 9, rig({ x: -70, z: -70 }));
    let smallest = Infinity;
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    scene.traverse((node) => {
      const mesh = node as THREE.InstancedMesh;
      if (mesh.isInstancedMesh !== true || !mesh.visible) return;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        scale.setFromMatrixScale(matrix);
        smallest = Math.min(smallest, scale.x);
      }
    });
    expect(smallest).toBeLessThan(0.01); // the roof, drawn lifted
    view.dispose();
  });

  it('parks the ship on the pad: scale 2.8, nose to +z, its lowest vertex on the slab, an occluder (§4.8)', () => {
    expect(TUG_SCALE).toBe(2.8);
    expect(TUG_FADE_RADIUS).toBe(TUG_RADIUS);
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium, assetsWith(['ship']));
    expect(view.tugDrawn).toBe(true);
    let tug: THREE.Object3D | null = null;
    scene.traverse((node) => {
      if (node.name === 'tug') tug = node;
    });
    const ship = tug as unknown as THREE.Object3D;
    expect(ship.scale.toArray()).toEqual([2.8, 2.8, 2.8]);
    expect(ship.rotation.y).toBe(0);
    const h = view.field.heightAt(0, 0);
    ship.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(ship);
    expect(box.min.y).toBeCloseTo(h + 0.4, 5);
    expect(ship.position.x).toBe(0);
    expect(ship.position.z).toBe(0);
    // Two meshes, receiving always, casting only with the shadow map on.
    const meshes: THREE.Mesh[] = [];
    ship.traverse((node) => {
      if ((node as THREE.Mesh).isMesh === true) meshes.push(node as THREE.Mesh);
    });
    expect(meshes).toHaveLength(2);
    expect(meshes.every((mesh) => mesh.receiveShadow && !mesh.castShadow)).toBe(true);
    view.applyQuality(QUALITY.high);
    expect(meshes.every((mesh) => mesh.castShadow)).toBe(true);
    // The last occluder candidate: the hull's circle, as tall as the ship stands.
    const occluder = view.occluderProps.at(-1);
    expect(occluder).toEqual({ x: 0, z: 0, radius: 3.5, height: expect.closeTo(0.4 + 0.79 * 2.8, 4) as unknown as number });
    // Fading swaps in per-view clones; the cache's materials are never written.
    const bases = meshes.map((mesh) => mesh.material as THREE.Material);
    const flags = new Uint8Array(view.occluderProps.length);
    flags[flags.length - 1] = 1;
    view.setOccluding(flags, 0.3);
    settle(view);
    const faded = meshes.map((mesh) => mesh.material as THREE.Material);
    faded.forEach((material, i) => {
      expect(material).not.toBe(bases[i]);
      expect(material.opacity).toBeCloseTo(0.3, 6);
    });
    expect(bases.every((material) => material.opacity === 1 && !material.transparent)).toBe(true);
    flags[flags.length - 1] = 0;
    settle(view);
    meshes.forEach((mesh, i) => expect(mesh.material).toBe(bases[i]));
    const freed = new Set<THREE.Material>();
    for (const material of [...faded, ...bases]) material.addEventListener('dispose', () => freed.add(material));
    view.dispose();
    expect(faded.every((material) => freed.has(material))).toBe(true);
    expect(bases.some((material) => freed.has(material))).toBe(false);
  });

  it('draws no tug without the ship model (46-n)', () => {
    expect(setup().view.tugDrawn).toBe(false);
    const scene = new THREE.Scene();
    let named = 0;
    new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium, assetsWith(['desert_rock_a'])).occluderProps.forEach(() => named++);
    scene.traverse((node) => {
      if (node.name === 'tug') named = -1;
    });
    expect(named).toBe(3);
  });
});

// ---------------------------------------------------------------- SPEC-053

import { CANOPY_FADE, TRUNK_UNIT_RADIUS, WIND_SWAY, foliageUniforms } from '@/views/Foliage';
import { CONTACT_OPACITY } from '@/views/SurfaceView';

describe('SPEC-053 — trees through the foliage seam, the canopy fade, the cut-out and the ground', () => {
  /** A strip of `n` indexed triangle pairs with atlas uvs and white COLOR_0. */
  function strip(n: number, y: number): THREE.BufferGeometry {
    const geometry = new THREE.PlaneGeometry(1, 1, n, 1).translate(0, y, 0);
    const count = (geometry.getAttribute('position') as THREE.BufferAttribute).count;
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3));
    return geometry;
  }

  /** SPEC-052's contract with `leaves` triangle pairs of Leaf (so models tell apart), LOD1 two pairs, and a Glow when asked. */
  function tree(leaves: number, glow = false): THREE.Group {
    const group = new THREE.Group();
    const foliage = new THREE.MeshStandardMaterial({ name: 'Foliage', vertexColors: true });
    const parts: [string, THREE.BufferGeometry, THREE.Material][] = [
      ['Bark', strip(2, 0.5), foliage],
      ['Leaf', strip(leaves, 1.8), foliage],
      ['Bark_LOD1', strip(1, 0.5), foliage],
      ['Leaf_LOD1', strip(1, 1.8), foliage],
    ];
    if (glow) parts.push(['Glow', new THREE.BoxGeometry(0.1, 0.1, 0.1).translate(0, 1.5, 0), new THREE.MeshStandardMaterial({ name: 'Glow' })]);
    for (const [name, geometry, material] of parts) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      group.add(mesh);
    }
    return group;
  }

  /** A landmark in metres: a 4 m body, 5 m tall. */
  function landmark(): THREE.Group {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(4, 5, 4).translate(0, 2.5, 0), new THREE.MeshStandardMaterial({ name: 'Body' })));
    return group;
  }

  const ATLAS = new THREE.Texture();
  /** Leaf pairs per model id, so each tree's mesh tells which model it draws. */
  const LEAVES: Record<string, number> = {
    jungle_tree_a: 10,
    jungle_tree_b: 11,
    jungle_tree_c: 12,
    temperate_tree_a: 13,
    temperate_tree_b: 14,
    temperate_tree_c: 15,
  };

  function assets(models: readonly string[], atlas = true): Assets {
    return {
      loaded: false,
      hasModel: (id: string) => models.includes(id),
      model: (id: string) => {
        if (id.startsWith('landmark_')) return landmark();
        const leaves = LEAVES[id];
        if (leaves === undefined) throw new Error(`no ${id}`);
        return tree(leaves, id.startsWith('jungle_tree_'));
      },
      hasTexture: (id: string) => atlas && id === 'foliage_atlas',
      texture: () => ATLAS,
    } as unknown as Assets;
  }

  const JUNGLE = ['jungle_tree_a', 'jungle_tree_b', 'jungle_tree_c'];
  const TEMPERATE = ['temperate_tree_a', 'temperate_tree_b', 'temperate_tree_c'];

  const GROVE: ViewLayout = {
    ...LAYOUT,
    obstacles: [
      { x: 10, z: 10, radius: 0.7, kind: 'tree', feature: 'grove' },
      { x: 14, z: -4, radius: 0.5, kind: 'tree' },
      { x: 4, z: 4, radius: 1.2, kind: 'rock' },
    ],
    props: [{ x: -8, z: 8, rot: 0.2, scale: 1, kind: 'tree_small' }],
  };

  const pairs = (geometry: THREE.BufferGeometry): number => (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;

  /** The scene's fixed rig around `target`, and its frustum. */
  function rig(target: { x: number; z: number }, distance = 22, fov = 40, aspect = 16 / 9): THREE.Frustum {
    const pitch = (55 * Math.PI) / 180;
    const yaw = (45 * Math.PI) / 180;
    const camera = new THREE.PerspectiveCamera(fov, aspect, 1, 130);
    camera.position.set(
      target.x + distance * Math.cos(pitch) * Math.sin(yaw),
      distance * Math.sin(pitch),
      target.z + distance * Math.cos(pitch) * Math.cos(yaw),
    );
    camera.lookAt(target.x, 0, target.z);
    camera.updateMatrixWorld();
    return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  }

  /** Every tree mesh — the instanced meshes on `#foliageMaterial`. */
  function trees(scene: THREE.Scene): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    scene.traverse((node) => {
      const mesh = node as THREE.InstancedMesh;
      if (mesh.isInstancedMesh === true && (mesh.material as THREE.Material).type === 'MeshLambertMaterial' && mesh.name.startsWith('tree:')) out.push(mesh);
    });
    return out;
  }

  /** The instance at (x, z) among `meshes`: its mesh, slot and matrix. */
  function at(meshes: THREE.InstancedMesh[], x: number, z: number): { mesh: THREE.InstancedMesh; slot: number; matrix: THREE.Matrix4 } {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    for (const mesh of meshes) {
      for (let slot = 0; slot < mesh.count; slot++) {
        mesh.getMatrixAt(slot, matrix);
        position.setFromMatrixPosition(matrix);
        if (Math.abs(position.x - x) < 1e-4 && Math.abs(position.z - z) < 1e-4) return { mesh, slot, matrix };
      }
    }
    throw new Error(`no tree at ${x}, ${z}`);
  }

  function frameWith(pool: Pool<EnemyEntity>, x: number, z: number): SurfaceFrame {
    const f = frame(pool);
    f.player = makePlayer(x, z, 100);
    return f;
  }

  it('draws each tree at radius / 0.14 and a small tree at prop.scale × 0.8, on #foliageMaterial (§4.1, §4.2)', () => {
    expect(TRUNK_UNIT_RADIUS).toBe(0.14);
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, GROVE, PLANETS.thessaly, QUALITY.medium, assets(JUNGLE));
    expect(view.treeSource).toBe('glb');
    expect(view.propSource).toBe('glb');
    const meshes = trees(scene);
    expect(meshes.length).toBeGreaterThan(0);
    const scale = new THREE.Vector3();
    at(meshes, 10, 10).matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    expect(scale.x).toBeCloseTo(0.7 / 0.14, 5);
    at(meshes, 14, -4).matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    expect(scale.x).toBeCloseTo(0.5 / 0.14, 5);
    at(meshes, -8, 8).matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    expect(scale.x).toBeCloseTo(0.8, 5);
    // One mesh per variant; the material is the atlas's Lambert, alpha-tested and opaque.
    const material = meshes[0]?.material as THREE.MeshLambertMaterial;
    expect(meshes.every((mesh) => mesh.material === material)).toBe(true);
    expect(material.map).toBe(ATLAS);
    expect(material.transparent).toBe(false);
    view.dispose();
  });

  it('stays procedural while the atlas is missing, and swaps to the seam when it lands (53-a, 53-i)', () => {
    const scene = new THREE.Scene();
    const early = assets(JUNGLE, false);
    const view = new SurfaceView(scene, GROVE, PLANETS.thessaly, QUALITY.medium, early);
    expect(view.treeSource).toBe('procedural');
    expect(trees(scene)).toHaveLength(0);
    // A tree contract does not hold propSource back (SPEC-046 46-c).
    expect(view.propSource).toBe('glb');
    const occluders = view.occluderProps;
    const before = occluders.map((o) => `${o.x},${o.z}`);
    view.setPropModels(assets(JUNGLE));
    expect(view.treeSource).toBe('glb');
    expect(trees(scene).length).toBeGreaterThan(0);
    // SPEC-035's list keeps its length and order (§4.1).
    expect(view.occluderProps).toBe(occluders);
    expect(view.occluderProps.map((o) => `${o.x},${o.z}`)).toEqual(before);
    view.dispose();
  });

  it('draws every orchard tree as ORCHARD_MODEL at one scale and yaw 0 (§4.9)', () => {
    const orchard: ViewLayout = {
      ...LAYOUT,
      obstacles: [
        { x: 20, z: 20, radius: 0.5, kind: 'tree', feature: 'orchard' },
        { x: 27, z: 20, radius: 0.5, kind: 'tree', feature: 'orchard' },
        { x: 34, z: 20, radius: 0.5, kind: 'tree', feature: 'orchard' },
        { x: -20, z: -20, radius: 0.8, kind: 'tree' },
      ],
      props: [],
    };
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, orchard, PLANETS.eden, QUALITY.medium, assets(TEMPERATE));
    const meshes = trees(scene);
    const rows = [20, 27, 34].map((x) => at(meshes, x, 20));
    const mesh = rows[0]?.mesh as THREE.InstancedMesh;
    expect(rows.every((row) => row.mesh === mesh)).toBe(true);
    // temperate_tree_c's 15 leaf pairs + 2 bark pairs.
    expect(pairs(mesh.geometry)).toBe((15 + 2) * 2);
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (const row of rows) {
      row.matrix.decompose(new THREE.Vector3(), quaternion, scale);
      expect(scale.x).toBeCloseTo(0.5 / 0.14, 6);
      expect(quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
    }
    // The wild tree is not the orchard's.
    expect(at(meshes, -20, -20).mesh).not.toBe(mesh);
    view.dispose();
  });

  it('draws lod1 on low and the body on medium and high, swapped in place; glows are LOD0 (§4.1, 53-b)', () => {
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, GROVE, PLANETS.thessaly, QUALITY.low, assets(JUNGLE));
    expect(view.treeLod).toBe(1);
    const meshes = trees(scene);
    // LOD1: Bark_LOD1 + Leaf_LOD1, one pair each.
    for (const mesh of meshes) expect(pairs(mesh.geometry)).toBe(2 * 2);
    const glows = (): THREE.InstancedMesh[] => {
      const out: THREE.InstancedMesh[] = [];
      scene.traverse((node) => {
        const mesh = node as THREE.InstancedMesh;
        if (mesh.isInstancedMesh === true && mesh.name.startsWith('tree-glow:') && mesh.visible && mesh.count > 0) out.push(mesh);
      });
      return out;
    };
    // jungle_tree_a's pods are LOD0's: none on low.
    const glowCount = glows().length;
    expect(glowCount).toBe(0);
    view.applyQuality(QUALITY.medium);
    expect(view.treeLod).toBe(0);
    const after = trees(scene);
    expect(after).toEqual(meshes); // the same meshes, re-pointed
    for (const mesh of after) expect(pairs(mesh.geometry)).toBeGreaterThan(2 * 2);
    expect(after.every((mesh) => mesh.geometry.getAttribute('instanceFade') !== undefined)).toBe(true);
    expect(glows().length).toBeGreaterThan(glowCount);
    view.applyQuality(QUALITY.low);
    for (const mesh of trees(scene)) expect(pairs(mesh.geometry)).toBe(2 * 2);
    view.dispose();
  });

  it('thins a canopy holding an enemy within 25 m to 0.35 over 0.2 s, and back (E82)', () => {
    expect(CANOPY_FADE).toBe(0.35);
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, GROVE, PLANETS.thessaly, QUALITY.medium, assets(JUNGLE));
    const pool = new Pool<EnemyEntity>(() => makeEnemy());
    const enemy = spawn(pool, SKITTER, { x: 11, z: 11 }); // inside the 5 m canopy at (10, 10)
    const fadeOf = (): number => {
      const { mesh, slot } = at(trees(scene), 10, 10);
      return (mesh.geometry.getAttribute('instanceFade') as THREE.BufferAttribute).getX(slot);
    };
    const step = (dt: number): void => {
      const f = frameWith(pool, 0, 0);
      f.dt = dt;
      view.sync(f);
    };
    step(0.05);
    expect(view.canopyHolders).toBe(1);
    expect(view.canopyFaded).toBeGreaterThanOrEqual(view.canopyHolders);
    expect(fadeOf()).toBeLessThan(1);
    expect(fadeOf()).toBeGreaterThan(CANOPY_FADE);
    for (let i = 0; i < 3; i++) step(0.05);
    expect(fadeOf()).toBeCloseTo(CANOPY_FADE, 6);
    // The far tree, holding nothing, never moved.
    const far = at(trees(scene), 14, -4);
    expect((far.mesh.geometry.getAttribute('instanceFade') as THREE.BufferAttribute).getX(far.slot)).toBe(1);
    // The enemy dies: back to 1 over 0.2 s, once the next 0.1 s query has seen it go.
    enemy.state = 'dead';
    for (let i = 0; i < 6; i++) step(0.05);
    expect(view.canopyHolders).toBe(0);
    expect(fadeOf()).toBeCloseTo(1, 6);
    expect(view.canopyFaded).toBe(0);
    // Out of range: the same enemy alive again, the player 40 m away, holds nothing.
    enemy.state = 'chase';
    for (let i = 0; i < 4; i++) {
      const f = frameWith(pool, 40, 40);
      f.dt = 0.05;
      view.sync(f);
    }
    expect(view.canopyHolders).toBe(0);
    view.dispose();
  });

  it('a pickup under a canopy holds it too; a hit-stop frame asks nothing it cannot step', () => {
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, GROVE, PLANETS.thessaly, QUALITY.medium, assets(JUNGLE));
    const f = frameWith(new Pool<EnemyEntity>(() => makeEnemy()), 0, 0);
    const pickup = f.pickups.alloc();
    Object.assign(pickup, { kind: 'resource', x: 10, z: 9, seed: 1, resource: 'oil' });
    f.dt = 0;
    view.sync(f);
    expect(view.canopyHolders).toBe(0); // a frozen frame does not query
    f.dt = 0.02;
    view.sync(f);
    expect(view.canopyHolders).toBe(1);
    expect(view.canopyFaded).toBe(1);
    view.dispose();
  });

  it('SPEC-035’s fade leaves foliage-drawn trees alone and still fades the rock (§4.1, 53-d)', () => {
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, GROVE, PLANETS.thessaly, QUALITY.medium, assets(JUNGLE));
    const flags = new Uint8Array(view.occluderProps.length).fill(1);
    view.setOccluding(flags, 0.3);
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    f.dt = 1;
    view.sync(f);
    const fadeAt = (x: number, z: number): number => {
      const { mesh, slot } = at(trees(scene), x, z);
      return (mesh.geometry.getAttribute('instanceFade') as THREE.BufferAttribute).getX(slot);
    };
    expect(fadeAt(10, 10)).toBe(1);
    expect(fadeAt(14, -4)).toBe(1);
    // Only the rock counts as faded; the trees' candidates are not this fade's.
    expect(view.fadedOccluders).toBe(1);
    view.occluderProps.forEach((_, i) => {
      const prop = view.occluderProps[i] as (typeof view.occluderProps)[number];
      const isTree = GROVE.obstacles.some((o) => o.kind === 'tree' && o.x === prop.x && o.z === prop.z) || (prop.x === -8 && prop.z === 8);
      expect(view.occluderFades(i), `${prop.x},${prop.z}`).toBe(!isTree);
    });
    view.dispose();
  });

  it('writes the cut-out for a living player with a screen, and (0, 0, 0, 0) without either (§4.1.2, 53-n)', () => {
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, GROVE, PLANETS.thessaly, QUALITY.medium, assets(JUNGLE));
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 200);
    camera.position.set(12, 18, 12);
    camera.lookAt(2, 0, -2);
    camera.updateMatrixWorld();
    const uniforms = foliageUniforms((trees(scene)[0] as THREE.InstancedMesh).material as THREE.Material);
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    f.screen = { camera, width: 1600, height: 900 };
    view.sync(f);
    const cut = uniforms.uCutout.value;
    expect(cut.w).toBeGreaterThan(0);
    expect(cut.w).toBeLessThan(1);
    expect(cut.z).toBeGreaterThan(0);
    // Dead: off.
    f.player.alive = false;
    view.sync(f);
    expect(cut.toArray()).toEqual([0, 0, 0, 0]);
    // Alive, but no screen: off.
    f.player.alive = true;
    delete f.screen;
    view.sync(f);
    expect(cut.toArray()).toEqual([0, 0, 0, 0]);
    view.dispose();
  });

  it('sways the trees and the cover by WIND_SWAY × the look’s wind, and not at all under reduce motion (§4.1, 53-c)', () => {
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, GROVE, PLANETS.thessaly, QUALITY.medium, assets(JUNGLE));
    const uniforms = foliageUniforms((trees(scene)[0] as THREE.InstancedMesh).material as THREE.Material);
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    view.sync(f);
    expect(uniforms.uWind.value).toBeCloseTo(WIND_SWAY * (PLANETS.thessaly.surface.look.foliage?.wind ?? 0), 9);
    expect(view.wind).toBe(uniforms.uWind.value);
    expect(uniforms.uTime.value).toBe(f.time);
    view.reduceMotion = true;
    view.sync(f);
    expect(uniforms.uWind.value).toBe(0);
    expect(view.wind).toBe(0);
    view.dispose();
  });

  it('draws a landmark model at scale 1 with its hashed yaw, its occluder as tall as the model (§4.8)', () => {
    const layout: ViewLayout = {
      ...LAYOUT,
      pois: [...LAYOUT.pois, { kind: 'landmark', x: -20, z: 15, radius: 6, poi: 'overgrown_ruin', instance: 2 }],
      obstacles: [],
      props: [],
    };
    for (const loaded of [true, false]) {
      const scene = new THREE.Scene();
      const view = new SurfaceView(scene, layout, PLANETS.thessaly, QUALITY.medium, assets(loaded ? ['landmark_jungle'] : []));
      let mesh: THREE.Mesh | null = null;
      scene.traverse((node) => {
        if (node.name === 'poi:landmark') mesh = node as THREE.Mesh;
      });
      const landmarkMesh = mesh as unknown as THREE.Mesh;
      if (loaded) {
        expect(landmarkMesh.scale.toArray()).toEqual([1, 1, 1]);
        expect(landmarkMesh.rotation.y).toBeCloseTo(hash01(hash32(layout.hash, 'landmark'), 2) * Math.PI * 2, 9);
        expect(view.occluderProps[0]?.height).toBeCloseTo(5, 6);
      } else {
        expect(landmarkMesh.scale.x).toBeCloseTo(0.4 * 6, 6); // SPEC-046's body until it lands
        view.setPropModels(assets(['landmark_jungle']));
        expect(landmarkMesh.scale.toArray()).toEqual([1, 1, 1]);
        expect(view.occluderProps[0]?.height).toBeCloseTo(5, 6);
      }
      view.dispose();
    }
  });

  it('lays one culled contact shadow under every obstacle, tree and landmark, at 0.28 (§4.7)', () => {
    expect(CONTACT_OPACITY).toBe(0.28);
    const layout: ViewLayout = {
      ...GROVE,
      halfSize: 120,
      pois: [...LAYOUT.pois, { kind: 'landmark', x: -20, z: 15, radius: 6 }],
      obstacles: [...GROVE.obstacles, { x: 90, z: 90, radius: 2, kind: 'rock' }, { x: 0, z: 30, radius: 1, kind: 'cave_wall' }],
    };
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, layout, PLANETS.thessaly, QUALITY.medium, assets(JUNGLE));
    let shadows: THREE.InstancedMesh | null = null;
    scene.traverse((node) => {
      if (node.name === 'contact-shadows') shadows = node as THREE.InstancedMesh;
    });
    const mesh = shadows as unknown as THREE.InstancedMesh;
    const material = mesh.material as THREE.MeshBasicMaterial;
    expect(material.opacity).toBe(0.28);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(mesh.renderOrder).toBe(1);
    // Two trees, two rocks and the landmark — the cave wall is collision only.
    expect(mesh.count).toBe(5);
    const radii = new Map<string, number>();
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      matrix.decompose(position, new THREE.Quaternion(), scale);
      radii.set(`${Math.round(position.x)},${Math.round(position.z)}`, scale.x);
      expect(position.y).toBeCloseTo(view.field.heightAt(position.x, position.z) + 0.05, 5);
    }
    expect(radii.get('10,10')).toBeCloseTo((0.9 * 0.7) / 0.14, 5);
    expect(radii.get('4,4')).toBeCloseTo(1.4 * 1.2, 5);
    expect(radii.get('-20,15')).toBeCloseTo(1.2 * 4, 5);
    // It culls: looking at the far rock draws that one and not the grove.
    view.setView(90, 90, 22, 40, 16 / 9, rig({ x: 90, z: 90 }));
    expect(mesh.count).toBe(1);
    view.dispose();
  });

  it('foliageTris and foliageDraws add up the trees, their glows, the undergrowth, the cover and the shadows (§4.10)', () => {
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, { ...GROVE, halfSize: 80 }, PLANETS.thessaly, QUALITY.medium, assets(JUNGLE));
    view.setView(8, 4, 22, 40, 16 / 9, rig({ x: 8, z: 4 }));
    let triangles = 0;
    let draws = 0;
    scene.traverse((node) => {
      const mesh = node as THREE.InstancedMesh;
      if (mesh.isInstancedMesh !== true || !mesh.visible || mesh.count === 0) return;
      const foliage =
        mesh.name.startsWith('tree:') ||
        mesh.name.startsWith('tree-glow:') ||
        mesh.name === 'undergrowth' ||
        mesh.name === 'contact-shadows' ||
        mesh.name === 'ground-cover';
      if (!foliage) return;
      triangles += mesh.count * pairs(mesh.geometry);
      draws++;
    });
    expect(view.coverDrawn).toBeGreaterThan(0);
    expect(view.foliageTris).toBe(triangles);
    expect(view.foliageDraws).toBe(draws);
    view.dispose();
  });

  it('builds the undergrowth on its atlas cells, and half of it on low (§4.4)', () => {
    const spec = PLANETS.thessaly.surface.look.undergrowth;
    expect(spec).toBeDefined();
    const count = (quality: QualitySettings): { total: number; cells: Set<number> } => {
      const scene = new THREE.Scene();
      const view = new SurfaceView(scene, { ...GROVE, halfSize: 80 }, PLANETS.thessaly, quality, assets(JUNGLE));
      let mesh: THREE.InstancedMesh | null = null;
      scene.traverse((node) => {
        if (node.name === 'undergrowth') mesh = node as THREE.InstancedMesh;
      });
      const undergrowth = mesh as unknown as THREE.InstancedMesh;
      expect(pairs(undergrowth.geometry)).toBe(6); // three crossed quads
      const cells = new Set<number>();
      const attribute = undergrowth.geometry.getAttribute('uvCell') as THREE.BufferAttribute;
      for (let i = 0; i < undergrowth.count; i++) cells.add(attribute.getX(i));
      // Never inside an obstacle + 0.4, a POI + 1, a node + 1.5 or the pad's 15 m; 1–2 m across.
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      for (let i = 0; i < undergrowth.count; i++) {
        undergrowth.getMatrixAt(i, matrix);
        matrix.decompose(position, new THREE.Quaternion(), scale);
        const { x, z } = position;
        expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(15);
        for (const o of GROVE.obstacles) expect(Math.hypot(x - o.x, z - o.z)).toBeGreaterThanOrEqual(o.radius + 0.4);
        for (const poi of GROVE.pois) expect(Math.hypot(x - poi.x, z - poi.z)).toBeGreaterThanOrEqual(poi.radius + 1);
        for (const node of GROVE.nodes) expect(Math.hypot(x - node.x, z - node.z)).toBeGreaterThanOrEqual(1.5);
        expect(scale.x * 1.25).toBeGreaterThanOrEqual(1 - 1e-6);
        expect(scale.x * 1.25).toBeLessThanOrEqual(2 + 1e-6);
        expect(position.y).toBeCloseTo(view.field.heightAt(x, z), 5);
      }
      view.dispose();
      return { total: undergrowth.count, cells };
    };
    const medium = count(QUALITY.medium);
    const low = count(QUALITY.low);
    expect(medium.total).toBeGreaterThan(20);
    const allowed: readonly number[] = spec?.cells ?? [];
    expect([...medium.cells].every((cell) => allowed.includes(cell))).toBe(true);
    expect(Math.abs(low.total - medium.total / 2)).toBeLessThanOrEqual(medium.total * 0.15);
  });

  it('grows underPer1000m2 × canopy area of undergrowth under each tree, within 0.8 of its canopy (§4.4)', () => {
    const base: PlanetDef = PLANETS.thessaly;
    const planet: PlanetDef = {
      ...base,
      surface: { ...base.surface, look: { ...base.surface.look, undergrowth: { cells: [4], underPer1000m2: 1000, openPer1000m2: 0 } } },
    };
    const layout: ViewLayout = { ...LAYOUT, halfSize: 80, obstacles: [{ x: 40, z: -30, radius: 0.7, kind: 'tree' }], props: [] };
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, layout, planet, QUALITY.medium, assets(JUNGLE));
    let mesh: THREE.InstancedMesh | null = null;
    scene.traverse((node) => {
      if (node.name === 'undergrowth') mesh = node as THREE.InstancedMesh;
    });
    const undergrowth = mesh as unknown as THREE.InstancedMesh;
    const canopy = 0.7 / 0.14;
    const area = Math.PI * canopy * canopy; // ≈ 78.5 m² → ≈ 79 candidates
    // A few fall inside the trunk + 0.4 m and are dropped.
    expect(undergrowth.count).toBeGreaterThan(0.85 * area);
    expect(undergrowth.count).toBeLessThanOrEqual(Math.round(area));
    const matrix = new THREE.Matrix4();
    const at = new THREE.Vector3();
    for (let i = 0; i < undergrowth.count; i++) {
      undergrowth.getMatrixAt(i, matrix);
      at.setFromMatrixPosition(matrix);
      expect(Math.hypot(at.x - 40, at.z + 30)).toBeLessThanOrEqual(0.8 * canopy + 1e-6);
    }
    view.dispose();
  });

  it('a planet with no foliage builds no tree, undergrowth or grove layer; its cover follows its look (53-h)', () => {
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, LAYOUT, PLANETS.cinder4, QUALITY.medium, assets([]));
    expect(trees(scene)).toHaveLength(0);
    let undergrowth = false;
    let cover = false;
    scene.traverse((node) => {
      if (node.name === 'undergrowth') undergrowth = true;
      if (node.name === 'ground-cover') cover = true;
    });
    expect(undergrowth).toBe(false);
    expect(cover).toBe(true); // Cinder-4's dry grass
    expect(view.treeSource).toBe('procedural');
    expect(view.seamAt).toBeNull();
    view.dispose();
  });

  it('reports Eden’s seam at eden_ridge instance 0’s x, and rebuilds the terrain once when low and medium swap (§4.6, 53-b)', () => {
    const layout: ViewLayout = {
      ...LAYOUT,
      pois: [...LAYOUT.pois, { kind: 'scan', x: 42.5, z: -30, radius: 8, poi: 'eden_ridge', instance: 0 }],
    };
    const scene = new THREE.Scene();
    const view = new SurfaceView(scene, layout, PLANETS.eden, QUALITY.medium);
    expect(view.seamAt).toBe(42.5);
    const terrain = (): THREE.MeshStandardMaterial => {
      let material: THREE.MeshStandardMaterial | null = null;
      scene.traverse((node) => {
        if (node.name === 'terrain') material = (node as THREE.Mesh).material as THREE.MeshStandardMaterial;
      });
      return material as unknown as THREE.MeshStandardMaterial;
    };
    const medium = terrain();
    expect(medium.customProgramCacheKey()).toBe('terrain/2+detail+seam');
    view.applyQuality(QUALITY.high);
    expect(terrain()).toBe(medium); // high keeps the detail: nothing to rebuild
    view.applyQuality(QUALITY.low);
    const low = terrain();
    expect(low).not.toBe(medium);
    expect(low.customProgramCacheKey()).toBe('terrain/1+seam');
    view.dispose();
  });
});

import { UNDERGROUND } from '@/data/index';
import { DESCENT_MOUTH_SCALE } from '@/views/SurfaceView';

describe('the descent’s shaft mouth (SPEC-054 §4.2)', () => {
  const SPOT = { x: 14, z: -9 };
  const BEACON = UNDERGROUND.vetra.look.beacons.color;

  function mouthOf(scene: THREE.Scene): THREE.Mesh | undefined {
    return scene.getObjectByName('descent-mouth') as THREE.Mesh | undefined;
  }

  /** Drawn only if it and every parent up to the scene are visible. */
  function drawn(node: THREE.Object3D): boolean {
    for (let at: THREE.Object3D | null = node; at !== null; at = at.parent) if (!at.visible) return false;
    return true;
  }

  /** `cave_shaft` once `land()` runs: a GLB-like body and glow, as SPEC-052 commits them. */
  function shaftAssets(): { assets: Assets; land(): void } {
    let landed = false;
    const shaft = (): THREE.Group => {
      const root = new THREE.Group();
      for (const [name, size, y] of [
        ['Body', [2.8, 0.4, 2.8], 0],
        ['Glow', [2.2, 0.05, 2.2], 0.4],
      ] as const) {
        const geometry = new THREE.BoxGeometry(...size);
        geometry.translate(0, y + size[1] / 2, 0);
        const material = new THREE.MeshStandardMaterial();
        material.name = name;
        root.add(new THREE.Mesh(geometry, material));
      }
      return root;
    };
    const assets = {
      hasModel: (id: string) => landed && id === 'cave_shaft',
      model: () => shaft(),
    } as unknown as Assets;
    return {
      assets,
      land: () => {
        landed = true;
      },
    };
  }

  it('draws nothing until the scene names a descent, and nothing for a seed without one (E87)', () => {
    const { scene, view } = setup();
    expect(mouthOf(scene)).toBeUndefined();
    expect(view.descentMouth).toBe('-');
    view.setDescent(null, BEACON);
    expect(mouthOf(scene)).toBeUndefined();
    expect(view.descentMouth).toBe('-');
    view.dispose();
  });

  it('stands the stand-in ring on the ground at the descent, at 60 %, glowing in the cave’s beacon colour', () => {
    const { scene, view } = setup(QUALITY.medium, PLANETS.vetra);
    view.setDescent(SPOT, BEACON);
    const mouth = mouthOf(scene);
    expect(mouth).toBeDefined();
    if (mouth === undefined) return;
    expect(view.descentMouth).toBe('procedural');
    expect(mouth.position.x).toBe(SPOT.x);
    expect(mouth.position.z).toBe(SPOT.z);
    expect(mouth.position.y).toBeCloseTo(view.field.heightAt(SPOT.x, SPOT.z), 6);
    expect(mouth.scale.toArray()).toEqual([DESCENT_MOUTH_SCALE, DESCENT_MOUTH_SCALE, DESCENT_MOUTH_SCALE]);
    const material = mouth.material as THREE.MeshStandardMaterial;
    expect(material.emissive.getHexString()).toBe(new THREE.Color(BEACON).getHexString());
    expect(material.emissiveIntensity).toBeGreaterThan(0);
    expect(drawn(mouth)).toBe(true);
    view.dispose();
  });

  it('goes with the surface below and comes back with it', () => {
    const { scene, view } = setup(QUALITY.medium, PLANETS.vetra);
    view.setDescent(SPOT, BEACON);
    const mouth = mouthOf(scene) as THREE.Mesh;
    view.setLevel('underground', null, UNDERGROUND.vetra.look);
    expect(drawn(mouth)).toBe(false);
    view.setLevel('surface', null, null);
    expect(drawn(mouth)).toBe(true);
    view.dispose();
  });

  it('swaps the stand-in for `cave_shaft` when the planet’s lazy set lands, freeing the old geometry', () => {
    const scene = new THREE.Scene();
    const fake = shaftAssets();
    const view = new SurfaceView(scene, LAYOUT, PLANETS.vetra, QUALITY.medium, fake.assets);
    view.setDescent(SPOT, BEACON);
    const mouth = mouthOf(scene) as THREE.Mesh;
    const standIn = mouth.geometry;
    let freed = false;
    standIn.addEventListener('dispose', () => {
      freed = true;
    });
    view.setPropModels(fake.assets);
    expect(view.descentMouth).toBe('procedural');
    fake.land();
    view.setPropModels(fake.assets);
    expect(view.descentMouth).toBe('glb');
    expect(mouth.geometry).not.toBe(standIn);
    expect(freed).toBe(true);
    // Once is enough: a later landing leaves the model's geometry alone.
    const model = mouth.geometry;
    view.setPropModels(fake.assets);
    expect(mouth.geometry).toBe(model);
    view.dispose();
  });

  it('draws the model at once when the set has already landed, and a new descent replaces the old mouth', () => {
    const scene = new THREE.Scene();
    const fake = shaftAssets();
    fake.land();
    const view = new SurfaceView(scene, LAYOUT, PLANETS.vetra, QUALITY.medium, fake.assets);
    view.setDescent(SPOT, BEACON);
    expect(view.descentMouth).toBe('glb');
    view.setDescent({ x: -3, z: 5 }, BEACON);
    const mouths: THREE.Object3D[] = [];
    scene.traverse((node) => {
      if (node.name === 'descent-mouth') mouths.push(node);
    });
    expect(mouths).toHaveLength(1);
    expect(mouths[0]?.position.x).toBe(-3);
    view.setDescent(null, BEACON);
    expect(mouthOf(scene)).toBeUndefined();
    view.dispose();
  });
});

describe('nodes and pickups read on their ground (review 2026-10 V-09)', () => {
  /** The program a material would compile, as far as the injection goes. */
  function compiled(material: THREE.MeshStandardMaterial): string {
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>',
      fragmentShader: '#include <common>\n#include <emissivemap_fragment>',
    };
    material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
    return shader.fragmentShader;
  }

  function instanced(scene: THREE.Scene, test: (mesh: THREE.InstancedMesh) => boolean): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    scene.traverse((node) => {
      const mesh = node as THREE.InstancedMesh;
      if (mesh.isInstancedMesh === true && test(mesh)) out.push(mesh);
    });
    return out;
  }

  it('the node crystals and the pickups glow in their instance colour × 0.5 with a rim, in the meshes they already had', () => {
    const { scene, view } = setup();
    const f = frame(new Pool(makeEnemy));
    const before = instanced(scene, () => true).length;
    view.sync(f);
    expect(RESOURCE_GLOW).toBe(0.5);
    const crystals = instanced(scene, (mesh) => mesh.geometry.type === 'OctahedronGeometry' && mesh.instanceMatrix.count === LAYOUT.nodes.length);
    expect(crystals).toHaveLength(1);
    const glow = compiled((crystals[0] as THREE.InstancedMesh).material as THREE.MeshStandardMaterial);
    expect(glow).toContain('totalEmissiveRadiance += vColor.rgb * 0.500');
    expect(glow).toContain('glowRim');
    // The old near-black emissive is gone; the material still draws its instance colours.
    const material = (crystals[0] as THREE.InstancedMesh).material as THREE.MeshStandardMaterial;
    expect(material.emissive.getHex()).toBe(0x000000);
    // The orbs share the glow, and no mesh was added for it.
    const orbs = instanced(scene, (mesh) => mesh.geometry.type === 'OctahedronGeometry' && mesh.instanceMatrix.count === 128);
    expect(orbs).toHaveLength(1);
    expect(compiled((orbs[0] as THREE.InstancedMesh).material as THREE.MeshStandardMaterial)).toContain('glowRim');
    expect(instanced(scene, () => true).length).toBe(before);
    view.dispose();
  });

  it('a gear pickup is gold, an item stays blue, and an orb wears its resource', () => {
    const { scene, view } = setup();
    const f = frame(new Pool(makeEnemy));
    for (const [kind, x] of [['resource', 1], ['item', 2], ['gear', 3]] as const) {
      Object.assign(f.pickups.alloc(), { kind, x, z: 0, seed: 0, resource: 'water' });
    }
    view.sync(f);
    const colourOf = (geometry: string): number => {
      // The item and gear meshes hold 64 each (§4.10).
      const mesh = instanced(scene, (m) => m.geometry.type === geometry && m.count > 0 && m.instanceMatrix.count === 64)[0] as THREE.InstancedMesh;
      const colour = new THREE.Color();
      mesh.getColorAt(0, colour);
      return colour.getHex();
    };
    expect(colourOf('ConeGeometry')).toBe(new THREE.Color(GEAR_PICKUP_COLOR).getHex());
    expect(colourOf('BoxGeometry')).toBe(new THREE.Color(ITEM_PICKUP_COLOR).getHex());
    expect(GEAR_PICKUP_COLOR).not.toBe(ITEM_PICKUP_COLOR);
    view.dispose();
  });
});
