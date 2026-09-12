// SPEC-017 §6 and SPEC-018 — the surface rig, shadow map, blob layer, planet
// grade, and now the environment: terrain off the shared height field, entity
// Y in sync(), the weather grade and the lightning gate. The scene graph is
// plain three.js objects, so what the GPU would be handed is readable here.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Pool } from '@/core/Pool';
import { hash01 } from '@/core/Noise';
import { hash32 } from '@/core/Rng';
import { QUALITY, type QualitySettings } from '@/core/Quality';
import { ENEMIES, PLANETS, type PlanetDef } from '@/data/index';
import { makeEnemy, type EnemyEntity } from '@/entities/Enemy';
import { makePlayer } from '@/entities/Player';
import { makeProjectile, type ProjectileEntity } from '@/entities/Projectile';
import { INSTANCES_PER_PART } from '@/views/ProceduralMeshes';
import { groundLayer } from '@/views/ProceduralTextures';
import { SurfaceView, type SurfaceFrame, type ViewLayout, type ViewPickup } from '@/views/SurfaceView';

const LAYOUT: ViewLayout = {
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
    pickups: new Pool<ViewPickup>(() => ({ kind: 'resource', x: 0, z: 0, seed: 0, resource: 'oil' })),
    nodes: [{ resource: 'oil', x: 3, z: -3, capacity: 10, remaining: 5, harvesting: false }],
    telegraph: null,
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

/** The projectile head mesh: the capsule-geometry instanced mesh. */
function projectileMesh(scene: THREE.Scene): THREE.InstancedMesh[] {
  const found: THREE.InstancedMesh[] = [];
  scene.traverse((node) => {
    const mesh = node as THREE.InstancedMesh;
    if (mesh.isInstancedMesh !== true) return;
    if ((mesh.geometry as THREE.BufferGeometry & { type?: string }).type === 'CapsuleGeometry') found.push(mesh);
  });
  return found;
}

describe('projectiles (SPEC-019 AC-59 … AC-63)', () => {
  it('orients the capsule along vx/vz and pushes the owner colour × 2.5', () => {
    const { scene, view } = setup();
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    const shot = f.projectiles.alloc();
    Object.assign(shot, { x: 2, z: 3, vx: 6, vz: 8, radius: 0.12, owner: 'player' });
    view.sync(f);
    const [heads, ghosts] = projectileMesh(scene) as [THREE.InstancedMesh, THREE.InstancedMesh];
    expect(heads.count).toBe(1);
    expect(ghosts.count).toBe(2); // two trailing ghosts per shot
    const matrix = new THREE.Matrix4();
    heads.getMatrixAt(0, matrix);
    // The rotated X basis must point along the (normalised) velocity.
    const basisX = new THREE.Vector3().setFromMatrixColumn(matrix, 0).normalize();
    expect(basisX.x).toBeCloseTo(0.6, 5);
    expect(basisX.z).toBeCloseTo(0.8, 5);
    expect(basisX.y).toBeCloseTo(0, 5);
    // Owner colour × 2.5 clears the bloom threshold; the material stays white.
    const color = heads.instanceColor as THREE.InstancedBufferAttribute;
    const base = new THREE.Color('#ffe9a0');
    expect(color.getX(0)).toBeCloseTo(base.r * 2.5, 4);
    expect(((heads.material as THREE.MeshBasicMaterial).color as THREE.Color).getHex()).toBe(0xffffff);

    // Ghosts trail at p − v · 0.03 and p − v · 0.06, at × 1.2 and × 0.6.
    ghosts.getMatrixAt(0, matrix);
    expect(matrix.elements[12]).toBeCloseTo(2 - 6 * 0.03, 5);
    expect(matrix.elements[14]).toBeCloseTo(3 - 8 * 0.03, 5);
    ghosts.getMatrixAt(1, matrix);
    expect(matrix.elements[12]).toBeCloseTo(2 - 6 * 0.06, 5);
    const ghostColor = ghosts.instanceColor as THREE.InstancedBufferAttribute;
    expect(ghostColor.getX(0)).toBeCloseTo(base.r * 1.2, 4);
    expect(ghostColor.getX(1)).toBeCloseTo(base.r * 0.6, 4);
    view.dispose();
  });

  it('a zero-velocity shot takes the owner facing and its ghosts collapse onto the head (19-j)', () => {
    const { scene, view } = setup();
    const f = frame(new Pool<EnemyEntity>(() => makeEnemy()));
    f.player.facing = Math.PI / 2; // +Z
    const shot = f.projectiles.alloc();
    Object.assign(shot, { x: 4, z: -1, vx: 0, vz: 0, radius: 0.12, owner: 'player' });
    view.sync(f);
    const [heads, ghosts] = projectileMesh(scene) as [THREE.InstancedMesh, THREE.InstancedMesh];
    const matrix = new THREE.Matrix4();
    heads.getMatrixAt(0, matrix);
    const basisX = new THREE.Vector3().setFromMatrixColumn(matrix, 0).normalize();
    expect(basisX.z).toBeCloseTo(1, 5); // facing π/2 points +Z
    ghosts.getMatrixAt(0, matrix);
    expect(matrix.elements[12]).toBeCloseTo(4, 5);
    expect(matrix.elements[14]).toBeCloseTo(-1, 5);
    view.dispose();
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
    shakeOffset(shake, 1.6, false, out);
    const expectedDecay = (2 - 1.6) / 0.5;
    expect(out.x).toBeCloseTo(0.5 * expectedDecay * Math.sin(37 * 1.6), 6);
    expect(out.y).toBe(0);
    expect(out.z).toBeCloseTo(0.5 * expectedDecay * Math.cos(29 * 1.6), 6);
    // Deterministic: the same time gives the same offset.
    const again = new THREE.Vector3();
    shakeOffset(shake, 1.6, false, again);
    expect(again.equals(out)).toBe(true);
    // At and past `until` the offset is exactly zero.
    shakeOffset(shake, 2, false, out);
    expect(out.length()).toBe(0);
  });

  it('reduce motion forces the offset to zero (AC-90, 19-g)', () => {
    const shake: ShakeState = { amplitude: 0.5, until: 2, duration: 0.5 };
    const out = new THREE.Vector3(9, 9, 9);
    shakeOffset(shake, 1.6, true, out);
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
