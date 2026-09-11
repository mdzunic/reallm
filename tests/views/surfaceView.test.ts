// SPEC-017 §6 — the surface lighting rig, the shadow map, the blob layer and
// the planet grade, pinned in node. The scene graph is plain three.js objects,
// so what the GPU would be handed is readable here: which lights exist, what
// casts, how many blobs a frame writes, and what a preset change does to all of
// it. The browser run confirms it looks right; this suite pins the mechanics a
// screenshot cannot.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Pool } from '@/core/Pool';
import { QUALITY, type QualitySettings } from '@/core/Quality';
import { ENEMIES, PLANETS, type PlanetDef } from '@/data/index';
import { makeEnemy, type EnemyEntity } from '@/entities/Enemy';
import { makePlayer } from '@/entities/Player';
import { makeProjectile, type ProjectileEntity } from '@/entities/Projectile';
import { INSTANCES_PER_PART } from '@/views/ProceduralMeshes';
import { SurfaceView, type SurfaceFrame, type ViewLayout, type ViewPickup } from '@/views/SurfaceView';

const LAYOUT: ViewLayout = {
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
    pickups: new Pool<ViewPickup>(() => ({ kind: 'resource', x: 0, z: 0, seed: 0, resource: 'oil' })),
    nodes: [{ resource: 'oil', x: 3, z: -3, capacity: 10, remaining: 5, harvesting: false }],
    telegraph: null,
    time: 1,
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

describe('the surface rig (SPEC-017 §4.5, AC-70, AC-71)', () => {
  it('is a hemisphere, a warm key, a cool rim and a torch — and no ambient', () => {
    const { scene, view } = setup();
    expect(lights(scene)).toEqual(['DirectionalLight', 'DirectionalLight', 'HemisphereLight', 'PointLight']);
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

  it('walks the key and its target with the player', () => {
    const { scene, view } = setup();
    view.sync(frame(new Pool<EnemyEntity>(() => makeEnemy())));
    // The warm key is the one that moved off its fixed rim position.
    const key = directionals(scene).find((light) => light.position.x > 0);
    expect(key).toBeDefined();
    expect(key?.position.x).toBeCloseTo(2 + 28, 5); // player.x + the §4.5 offset
    expect(key?.position.y).toBeCloseTo(46, 5);
    expect(key?.position.z).toBeCloseTo(-2 + 18, 5);
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

describe('materials (SPEC-017 §4.7, AC-84 … AC-86)', () => {
  it('is standard, basic or points all the way down', () => {
    const { scene, view } = setup();
    const kinds = new Set<string>();
    scene.traverse((node) => {
      const material = (node as THREE.Mesh).material;
      if (material === undefined) return;
      for (const entry of Array.isArray(material) ? material : [material]) kinds.add(entry.type);
    });
    expect([...kinds].sort()).toEqual(['MeshBasicMaterial', 'MeshStandardMaterial', 'PointsMaterial']);
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
      if (material?.type === 'MeshStandardMaterial' && material.transparent) capsule = material;
    });
    expect(capsule).toBeDefined();
    expect(capsule?.opacity).toBeLessThan(1);
    view.dispose();
  });

  it('the ground receives, the obstacles cast, and the landing pad does not', () => {
    const { scene, view } = setup();
    let groundReceives = false;
    let pad: THREE.Mesh | undefined;
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      const geometry = mesh.geometry as THREE.BufferGeometry & { type?: string };
      if (geometry.type === 'PlaneGeometry' && mesh.receiveShadow) groundReceives = true;
      // The pad is the one cylinder sitting at the layout's origin POI.
      if (geometry.type === 'CylinderGeometry' && mesh.position.x === 0 && mesh.position.z === 0) pad = mesh;
    });
    expect(groundReceives).toBe(true);
    expect(pad).toBeDefined();
    expect(pad?.castShadow).toBe(false);
    view.dispose();
  });
});
