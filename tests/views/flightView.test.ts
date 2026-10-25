// PLAN R8 (SPEC-020 §4.8) — the flight view's art swap, pinned in node. The
// scene graph is plain three.js, so what the GPU would draw is readable here:
// the primitives stand until `useArt()`, which puts up the sky window, dresses
// the planet (maps, atmosphere, clouds), instances one mesh per rock shape,
// merges each ship model into one geometry with a group per material and
// swaps the cockpit — and whatever is missing keeps its primitive.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Pool } from '@/core/Pool';
import type { QualitySettings } from '@/core/Renderer';
import { Rng } from '@/core/Rng';
import { PLANETS } from '@/data/index';
import {
  FlightView,
  HIT_FLASH_NAME,
  launchRunUp,
  mergeModel,
  SKY_WINDOW,
  VIEW_CORRIDOR,
  VIEW_LATERAL_SPEED,
  wrapAround,
  type FlightFrame,
  type FrameBurst,
  type FrameHazard,
  type FrameMissile,
  type FramePickup,
  type FrameShot,
} from '@/views/FlightView';
import { COURSE, RAIL } from '@/systems/Flight';

const QUALITY = { starfieldPoints: 40, asteroidCap: 12, maxParticles: 24, post: 'lite' } as unknown as QualitySettings;

function setup(quality: QualitySettings = QUALITY): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; view: FlightView } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 600);
  const view = new FlightView(scene, camera, { planet: PLANETS.cinder4, quality, reduceMotion: false, rng: new Rng(7) });
  return { scene, camera, view };
}

function frame(): FlightFrame {
  return {
    ship: { x: 0, y: 0, vy: 0, bank: 0, alive: true },
    hazards: new Pool<FrameHazard>(() => ({ kind: 'asteroid', x: 0, y: 0, depth: 0, radius: 1 })),
    shots: new Pool<FrameShot>(() => ({ x: 0, y: 0, depth: 0, vDepth: 0 })),
    bursts: new Pool<FrameBurst>(() => ({ x: 0, y: 0, depth: 0, size: 1 })),
    progress: 0.5,
    stormActive: false,
    throttleLive: 1,
    time: 1,
  };
}

function rock(f: FlightFrame, radius: number): void {
  Object.assign(f.hazards.alloc(), { kind: 'asteroid', x: 1, y: 2, depth: 60, radius });
}

function ship(f: FlightFrame, kind: 'fighter' | 'interceptor', depth: number): void {
  Object.assign(f.hazards.alloc(), { kind, x: 0, y: 0, depth, radius: 1 });
}

/** Where instance `slot` of `mesh` was written, in world space. */
function instanceAt(mesh: THREE.InstancedMesh, slot: number): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(slot, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

/** The per-instance colour gain written at `slot` (r = g = b by construction). */
function gainAt(mesh: THREE.InstancedMesh, slot: number): number {
  return (mesh.instanceColor as THREE.InstancedBufferAttribute).getX(slot);
}

function instanced(scene: THREE.Scene): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  scene.traverse((node) => {
    if (node instanceof THREE.InstancedMesh) out.push(node);
  });
  return out;
}

/** The asteroid meshes: instanced, per-instance colour, sized by `asteroidCap`. */
function rocks(scene: THREE.Scene): THREE.InstancedMesh[] {
  return instanced(scene).filter((mesh) => mesh.instanceMatrix.count === QUALITY.asteroidCap);
}

function planetOf(scene: THREE.Scene): THREE.Mesh {
  return scene.children.find((node) => node.position.z === -320) as THREE.Mesh;
}

function model(parts: Array<[THREE.BufferGeometry, string]>): THREE.Group {
  const root = new THREE.Group();
  parts.forEach(([geometry, name], i) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ name }));
    mesh.position.x = i * 3;
    root.add(mesh);
  });
  return root;
}

describe('FlightView art (PLAN R8)', () => {
  it('keeps every primitive when nothing arrived', () => {
    const { scene, view } = setup();
    const before = instanced(scene).map((mesh) => mesh.geometry);
    view.useArt({});
    expect(instanced(scene).map((mesh) => mesh.geometry)).toEqual(before);
    expect((planetOf(scene).material as THREE.MeshStandardMaterial).map).toBeInstanceOf(THREE.DataTexture);
  });

  it('puts the sky window behind everything and keeps it on the camera', () => {
    const { scene, camera, view } = setup();
    const sky = new THREE.Texture();
    view.useArt({ sky });
    const dome = scene.children.find(
      (node) => node instanceof THREE.Mesh && (node.material as THREE.MeshBasicMaterial).map === sky,
    ) as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
    expect(dome).toBeDefined();
    expect(dome.geometry.parameters).toMatchObject(SKY_WINDOW);
    expect(dome.material.side).toBe(THREE.BackSide);
    expect(dome.material.depthTest).toBe(false);
    expect(dome.material.depthWrite).toBe(false);
    expect(dome.material.fog).toBe(false);
    expect(dome.renderOrder).toBeLessThan(0);
    const f = frame();
    f.ship.x = 4;
    view.update(f, 1 / 60);
    expect(dome.position.equals(camera.position)).toBe(true);
  });

  it('dresses the planet with its maps, an additive atmosphere and a cloud layer', () => {
    const { scene, view } = setup();
    const map = new THREE.Texture();
    const normalMap = new THREE.Texture();
    const emissiveMap = new THREE.Texture();
    const clouds = new THREE.Texture();
    view.useArt({ planet: { map, normalMap, emissiveMap }, clouds });
    const planet = planetOf(scene);
    const material = planet.material as THREE.MeshStandardMaterial;
    expect(material.map).toBe(map);
    expect(material.normalMap).toBe(normalMap);
    expect(material.emissiveMap).toBe(emissiveMap);
    expect(material.fog).toBe(false);
    const [atmosphere, layer] = planet.children as THREE.Mesh[];
    expect((atmosphere?.material as THREE.ShaderMaterial).blending).toBe(THREE.AdditiveBlending);
    expect((atmosphere?.material as THREE.ShaderMaterial).depthWrite).toBe(false);
    expect((layer?.material as THREE.MeshStandardMaterial).alphaMap).toBe(clouds);
    expect((layer?.material as THREE.MeshStandardMaterial).transparent).toBe(true);
    // the §4.1 scale rule still drives the whole dressed sphere
    const f = frame();
    f.progress = 1;
    view.update(f, 1 / 60);
    expect(planet.scale.x).toBeCloseTo(6);
  });

  it('instances one mesh per rock shape and fills them from the hazard pool', () => {
    const { scene, view } = setup();
    view.useArt({ asteroid: model([[new THREE.SphereGeometry(1, 8, 6), 'RockA'], [new THREE.SphereGeometry(1, 6, 4), 'RockB']]) });
    const meshes = rocks(scene);
    expect(meshes.map((mesh) => (mesh.material as THREE.Material).name)).toEqual(['RockA', 'RockB']);
    const f = frame();
    for (const radius of [0.8, 1.3, 2.05, 2.9, 3.4]) rock(f, radius);
    view.update(f, 1 / 60);
    expect(meshes.reduce((n, mesh) => n + mesh.count, 0)).toBe(5);
    expect(meshes.every((mesh) => mesh.instanceColor !== null)).toBe(true);
  });

  it('draws rocks again after a frame without any (the count is not the capacity)', () => {
    const { scene, view } = setup();
    const f = frame();
    view.update(f, 1 / 60);
    for (const radius of [1, 2, 3]) rock(f, radius);
    view.update(f, 1 / 60);
    expect(rocks(scene).reduce((n, mesh) => n + mesh.count, 0)).toBe(3);
  });

  it('merges a ship model into one geometry with a group per material', () => {
    const ship = model([[new THREE.BoxGeometry(1, 1, 2), 'Hull'], [new THREE.SphereGeometry(0.2, 8, 6), 'Glow']]);
    const merged = mergeModel(ship);
    expect(merged?.geometry.groups.map((group) => group.materialIndex)).toEqual([0, 1]);
    expect(merged?.materials.map((material) => material.name)).toEqual(['Hull', 'Glow']);
    expect(Object.keys(merged?.geometry.attributes ?? {}).sort()).toEqual(['normal', 'position', 'uv']);
    // the second part's transform is baked in
    merged?.geometry.computeBoundingBox();
    expect(merged?.geometry.boundingBox?.max.x).toBeCloseTo(3.2);

    const { scene, view } = setup();
    view.useArt({ fighter: ship });
    const fighters = instanced(scene).filter((mesh) => Array.isArray(mesh.material));
    expect(fighters).toHaveLength(1);
    expect((fighters[0]?.material as THREE.Material[]).map((material) => material.name)).toEqual(['Hull', 'Glow']);
  });

  it('swaps the cockpit frame for the model and lets it go on dispose', () => {
    const { scene, camera, view } = setup();
    const cockpit = model([[new THREE.BoxGeometry(2, 0.3, 0.3), 'Cockpit']]);
    view.useArt({ cockpit });
    const frameGroup = camera.children[0] as THREE.Group;
    expect(frameGroup.children).toEqual([cockpit]);
    view.dispose();
    expect(camera.children).not.toContain(frameGroup);
    expect(scene.fog).toBeNull();
    expect(scene.background).toBeNull();
  });
});

// SPEC-020 §4.3 / §4.1 — what this spec adds on top of the R8 dressing.
describe('FlightView fx (SPEC-020 §4.3)', () => {
  /** The engine-glow mesh: the only 0.6 m quad with depth testing switched off. */
  function glows(scene: THREE.Scene): THREE.InstancedMesh {
    return instanced(scene).find(
      (mesh) =>
        mesh.geometry instanceof THREE.PlaneGeometry &&
        (mesh.material as THREE.MeshBasicMaterial).depthTest === false,
    ) as THREE.InstancedMesh;
  }

  /** Ours are capsules, theirs are spheres; both carry the head and two ghosts. */
  function shotMeshes(scene: THREE.Scene): { ours: THREE.InstancedMesh; theirs: THREE.InstancedMesh } {
    const list = instanced(scene);
    return {
      ours: list.find((mesh) => mesh.geometry instanceof THREE.CapsuleGeometry) as THREE.InstancedMesh,
      theirs: list.find((mesh) => mesh.geometry instanceof THREE.SphereGeometry) as THREE.InstancedMesh,
    };
  }

  it('hangs an engine glow behind every fighter and interceptor nozzle (AC-10)', () => {
    const { scene, view } = setup();
    const f = frame();
    ship(f, 'fighter', 40);
    ship(f, 'interceptor', 40);
    view.update(f, 1 / 60);

    const mesh = glows(scene);
    expect(mesh.count).toBe(2);
    // The models' noses are +Z (§4.8), so the nozzle — and the glow behind it —
    // is at −Z: further from the camera than the hull it belongs to.
    expect(instanceAt(mesh, 0).z).toBeCloseTo(-40 - 1.3 * 1.2);
    expect(instanceAt(mesh, 1).z).toBeCloseTo(-40 - 2.1 * 1.4);
    const material = mesh.material as THREE.MeshBasicMaterial;
    expect(material.blending).toBe(THREE.AdditiveBlending);
    expect(material.color.getHex()).toBe(new THREE.Color(0x9fe3ff).getHex());
    expect(material.depthWrite).toBe(false);
    // Nose-on hazards put their own hull between the camera and the nozzle, so
    // a depth-tested quad there is never rasterised (round-3 QA measured 0 px).
    expect(material.depthTest).toBe(false);
    expect((mesh.geometry as THREE.PlaneGeometry).parameters.width).toBe(0.6);
    expect((mesh.geometry as THREE.PlaneGeometry).parameters.height).toBe(0.6);

    // A frame with nothing on it puts the glows away again.
    f.hazards.clear();
    view.update(f, 1 / 60);
    expect(glows(scene).count).toBe(0);
  });

  it('draws each shot as a bright head and two dim ghosts (AC-11)', () => {
    const { scene, view } = setup();
    const f = frame();
    Object.assign(f.shots.alloc(), { x: 1, y: 2, depth: 30, vDepth: 100 });
    Object.assign(f.hazards.alloc(), { kind: 'enemy_shot', x: 0, y: 0, depth: 20, vDepth: -60, radius: 0.4 });
    view.update(f, 1 / 60);

    const { ours, theirs } = shotMeshes(scene);
    expect(ours.count).toBe(3);
    expect(theirs.count).toBe(3);
    // `p + v · lag` in depth, against the bolt's own signed velocity (§4.3).
    expect(instanceAt(ours, 0).z).toBeCloseTo(-30);
    expect(instanceAt(ours, 1).z).toBeCloseTo(-(30 + 100 * 0.02));
    expect(instanceAt(ours, 2).z).toBeCloseTo(-(30 + 100 * 0.04));
    expect(instanceAt(theirs, 1).z).toBeCloseTo(-(20 + -60 * 0.02));
    // × 2.5 puts the head over SPEC-017's bloom threshold; the ghosts trail it.
    [2.5, 1.2, 0.6].forEach((gain, tap) => expect(gainAt(ours, tap)).toBeCloseTo(gain));
    expect(gainAt(theirs, 0)).toBeCloseTo(2.5);
    for (const mesh of [ours, theirs]) {
      expect((mesh.material as THREE.MeshBasicMaterial).blending).toBe(THREE.AdditiveBlending);
      // Room for 64 bolts × 3 taps each.
      expect(mesh.instanceMatrix.count).toBe(64 * 3);
    }
  });

  it('explodes into a sprite pool of `maxParticles` plus a four-sprite flash (AC-12)', () => {
    const { scene, view } = setup();
    // No `Points` cloud is left for the explosions: only the starfield.
    const points: THREE.Points[] = [];
    scene.traverse((node) => {
      if (node instanceof THREE.Points) points.push(node);
    });
    expect(points).toHaveLength(1);

    const pool = instanced(scene).filter(
      // SPEC-069/070's beacons, canister lights and missile glows are named sprite meshes of their own.
      (mesh) => mesh.geometry instanceof THREE.PlaneGeometry && (mesh.material as THREE.MeshBasicMaterial).depthTest !== false && mesh.name === '',
    );
    expect(pool.map((mesh) => mesh.instanceMatrix.count)).toEqual([QUALITY.maxParticles, 16]);
    for (const mesh of pool) expect((mesh.material as THREE.MeshBasicMaterial).blending).toBe(THREE.AdditiveBlending);

    const f = frame();
    Object.assign(f.bursts.alloc(), { x: 0, y: 0, depth: 20, size: 1 });
    const dt = 1 / 60;
    view.update(f, dt);
    const [particles, flash] = pool as [THREE.InstancedMesh, THREE.InstancedMesh];
    expect(particles.count).toBe(11); // round(6 + size · 5)
    expect(flash.count).toBe(4);
    // Both fade with their own life — 0.7 s for the pool, 0.12 s for the
    // flash — and the flash burns at × 3 (SPEC-019 §4.4 `death`).
    expect(gainAt(particles, 0)).toBeCloseTo((0.7 - dt) / 0.7);
    expect(gainAt(flash, 0)).toBeCloseTo(3 * ((0.12 - dt) / 0.12));
    // The bursts pool is drained by the view, and the sprites expire.
    expect(f.bursts.size).toBe(0);
    view.update(f, 1);
    expect(particles.count).toBe(0);
    expect(flash.count).toBe(0);
  });

  it('hangs a two-element lens flare on the sun, and only where post runs (AC-13, 20-a)', () => {
    const lit = setup();
    const sun = lit.scene.children.find(
      (node) => node instanceof THREE.DirectionalLight && node.children.length > 0,
    ) as THREE.DirectionalLight;
    expect(sun).toBeDefined();
    const flare = sun.children[0] as THREE.Object3D & { readonly isLensflare?: boolean };
    expect(flare.type).toBe('Lensflare');
    expect(sun.position.z).toBeLessThan(-320); // past the planet's far shoulder

    const off = setup({ ...QUALITY, post: 'off' } as unknown as QualitySettings);
    expect(off.scene.children.some((node) => node instanceof THREE.DirectionalLight && node.children.length > 0)).toBe(false);

    // Review 2026-10 V-17: through MSAA the flare's framebuffer copy is a
    // WebGL error every frame, so `full` at a low dpr hangs no flare.
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 600);
    const msaa = new FlightView(scene, camera, {
      planet: PLANETS.cinder4,
      quality: { ...QUALITY, post: 'full' } as unknown as QualitySettings,
      reduceMotion: false,
      rng: new Rng(7),
      msaa: true,
    });
    expect(scene.children.some((node) => node instanceof THREE.DirectionalLight && node.children.length > 0)).toBe(false);
    msaa.dispose();

    // The flare's framebuffer textures and its elements' maps are outside the
    // geometry/material walk `disposeObject3D` does, so the view frees them.
    const releasable = flare as unknown as { dispose: () => void };
    let released = false;
    releasable.dispose = (): void => {
      released = true;
    };
    lit.view.dispose();
    expect(released).toBe(true);
  });

  it('shifts the sky window toward the planet accent during an ion storm (AC-14, 20-g)', () => {
    const { scene, view } = setup();
    view.useArt({ sky: new THREE.Texture() });
    const dome = scene.children.find(
      (node) => node instanceof THREE.Mesh && node.renderOrder === -10,
    ) as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
    expect(dome.material.color.getHex()).toBe(0xffffff);

    const f = frame();
    f.stormActive = true;
    for (let i = 0; i < 60; i++) view.update(f, 1 / 60);
    expect(view.stormTint).toBeCloseTo(1);
    const accent = new THREE.Color(PLANETS.cinder4.surface.palette.accent);
    expect(dome.material.color.getHex()).toBe(accent.getHex());

    // It clears again when the storm passes.
    f.stormActive = false;
    for (let i = 0; i < 60; i++) view.update(f, 1 / 60);
    expect(view.stormTint).toBe(0);
    expect(dome.material.color.getHex()).toBe(0xffffff);
  });
});

// SPEC-041 §4.9 — a hazard a shot hit without killing it flashes white.
describe('FlightView hit flash (SPEC-041 §4.9)', () => {
  /** The white twins: one per rock shape and one per ship class, named for the flash. */
  function twins(scene: THREE.Scene): THREE.InstancedMesh[] {
    return instanced(scene).filter((mesh) => mesh.name === HIT_FLASH_NAME);
  }

  function hazard(f: FlightFrame, fields: FrameHazard): void {
    Object.assign(f.hazards.alloc(), fields);
  }

  it('draws a hazard with hitFlash white, and the rest in their own colours', () => {
    const { scene, view } = setup();
    const f = frame();
    hazard(f, { kind: 'fighter', x: 1, y: 2, depth: 40, radius: 1.2, hitFlash: 0.05 });
    hazard(f, { kind: 'fighter', x: -3, y: 0, depth: 50, radius: 1.2, hitFlash: 0 });
    hazard(f, { kind: 'interceptor', x: 0, y: -1, depth: 30, radius: 1, hitFlash: 0.1 });
    hazard(f, { kind: 'asteroid', x: 4, y: 1, depth: 70, radius: 2, hitFlash: 0.02 });
    view.update(f, 1 / 60);

    const lit = twins(scene).filter((mesh) => mesh.visible);
    expect(lit).toHaveLength(3); // the rock's, the fighter's and the interceptor's
    for (const mesh of lit) {
      expect(mesh.count).toBe(1);
      // Flat white: unlit, untinted, untouched by tone mapping.
      const material = mesh.material as THREE.MeshBasicMaterial;
      expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
      expect(material.color.getHex()).toBe(0xffffff);
      expect(material.map).toBeNull();
      expect(material.toneMapped).toBe(false);
    }

    // The flashing fighter is drawn by the twin, the other one by its own mesh.
    const twin = lit.find((mesh) => mesh.geometry instanceof THREE.ConeGeometry) as THREE.InstancedMesh;
    const fighters = instanced(scene).find((mesh) => mesh !== twin && mesh.geometry === twin.geometry) as THREE.InstancedMesh;
    expect(instanceAt(twin, 0).toArray()).toEqual([1, 2, -40]);
    expect(fighters.count).toBe(1);
    expect(instanceAt(fighters, 0).toArray()).toEqual([-3, 0, -50]);
    // The rock's twin carries the rock where it is.
    const rock = lit.find((mesh) => mesh.geometry instanceof THREE.IcosahedronGeometry) as THREE.InstancedMesh;
    expect(instanceAt(rock, 0).toArray()).toEqual([4, 1, -70]);
    expect(rocks(scene).reduce((n, mesh) => n + mesh.count, 0)).toBe(0);

    // Once the flash runs out every twin goes dark — hidden, so no draw at all.
    for (let i = 0; i < f.hazards.size; i++) f.hazards.at(i).hitFlash = 0;
    view.update(f, 1 / 60);
    expect(twins(scene).every((mesh) => !mesh.visible && mesh.count === 0)).toBe(true);
    expect(fighters.count).toBe(2);
    expect(rocks(scene).reduce((n, mesh) => n + mesh.count, 0)).toBe(1);
  });

  it('keeps a twin per rock shape and the ship models’ shapes once the art arrives', () => {
    const { scene, view } = setup();
    const ship = model([[new THREE.BoxGeometry(1, 1, 2), 'Hull'], [new THREE.SphereGeometry(0.2, 8, 6), 'Glow']]);
    view.useArt({ asteroid: model([[new THREE.SphereGeometry(1, 8, 6), 'RockA'], [new THREE.SphereGeometry(1, 6, 4), 'RockB']]), fighter: ship });
    const shapes = rocks(scene).map((mesh) => mesh.geometry);
    const fighters = instanced(scene).find((mesh) => Array.isArray(mesh.material)) as THREE.InstancedMesh;
    const geometries = twins(scene).map((mesh) => mesh.geometry);
    expect(geometries).toEqual(expect.arrayContaining([...shapes, fighters.geometry]));
    expect(twins(scene)).toHaveLength(shapes.length + 2); // + the fighter's and the interceptor's

    // A flashing fighter draws its whole merged model white, in one draw.
    const f = frame();
    hazard(f, { kind: 'fighter', x: 0, y: 0, depth: 40, radius: 1.2, hitFlash: 0.05 });
    view.update(f, 1 / 60);
    const lit = twins(scene).filter((mesh) => mesh.visible);
    expect(lit).toHaveLength(1);
    expect(lit[0]?.geometry).toBe(fighters.geometry);
    expect(Array.isArray(lit[0]?.material)).toBe(false);
    expect(fighters.count).toBe(0);
  });
});

// SPEC-071 — the launch from the cockpit: no exterior shot, a run-up from
// still to cruise.
describe('FlightView launch run-up (SPEC-071)', () => {
  function launchSetup(reduceMotion: boolean): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; view: FlightView } {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 600);
    const view = new FlightView(scene, camera, { planet: PLANETS.cinder4, quality: QUALITY, reduceMotion, rng: new Rng(7) });
    return { scene, camera, view };
  }

  /** The z of every star head, copied. */
  function starDepths(scene: THREE.Scene): number[] {
    const stars = scene.children.find((node) => (node as THREE.Points).isPoints === true) as THREE.Points;
    return Array.from((stars.geometry.getAttribute('position').array as Float32Array).filter((_, i) => i % 3 === 2));
  }

  it('runs up along a smoothstep: still at 0, cruise at 1, monotonic between', () => {
    expect(launchRunUp(0)).toBe(0);
    expect(launchRunUp(0.5)).toBeCloseTo(0.5, 9);
    expect(launchRunUp(1)).toBe(1);
    expect(launchRunUp(Number.NaN)).toBe(1);
    let last = -1;
    for (let i = 0; i <= 20; i++) {
      const value = launchRunUp(i / 20);
      expect(value).toBeGreaterThanOrEqual(last);
      last = value;
    }
  });

  it('opens in the cockpit on the cruise rig, with no tug at any frame of the launch', () => {
    const { scene, camera, view } = launchSetup(false);
    expect(camera.position.z).toBe(2.5);
    view.setLaunch(0);
    for (let i = 0; i <= 180; i++) {
      view.setLaunch(i / 180);
      view.update(frame(), 1 / 60);
      expect(scene.getObjectByName('launch-tug')).toBeUndefined();
      expect(camera.position.z).toBe(2.5);
      expect((camera.children[0] as THREE.Group).visible).toBe(true);
    }
    expect(view.launch).toBe(1);
  });

  it('holds the stars still at the start and streams them once the run-up is over', () => {
    const { scene, view } = launchSetup(false);
    view.setLaunch(0);
    const before = starDepths(scene);
    view.update(frame(), 1 / 60);
    expect(starDepths(scene)).toEqual(before);
    view.endLaunch();
    view.update(frame(), 1 / 60);
    expect(starDepths(scene)).not.toEqual(before);
  });

  it('shakes the cockpit at the start, settles by the end, and never shakes under reduce motion', () => {
    const rollAt = (reduceMotion: boolean, progress: number): number => {
      const { view } = launchSetup(reduceMotion);
      view.setLaunch(progress);
      view.update(frame(), 1 / 60);
      return view.cameraRollDeg;
    };
    expect(Math.abs(rollAt(false, 0))).toBeGreaterThan(0);
    expect(rollAt(false, 1)).toBeCloseTo(0, 9);
    expect(rollAt(true, 0)).toBeCloseTo(0, 9);
  });

  it('ends once and stays ended (E138)', () => {
    const { view } = launchSetup(false);
    view.setLaunch(0.4);
    expect(view.launch).toBeCloseTo(0.4, 9);
    view.endLaunch();
    view.endLaunch();
    expect(view.launch).toBe(1);
    view.setLaunch(2);
    expect(view.launch).toBe(1);
    view.dispose();
  });
});

// SPEC-045 §4.3 — the cockpit kick takes Camera shake's scale, with no
// reduce-motion guard of its own: the scene passes `settings.cameraShake`,
// which reduce motion sets to 0.
describe('FlightView cockpit kick (SPEC-045 §4.3)', () => {
  /** The degrees the horizon rolled on the frame after `kicks` kicks at `strength`. */
  function rollAfter(strength: number, kicks = 1): number {
    const { view } = setup();
    for (let i = 0; i < kicks; i++) view.kick(strength);
    view.update(frame(), 1 / 60);
    const roll = view.cameraRollDeg;
    view.dispose();
    return roll;
  }

  it('changes nothing at 0, and kicks less at half than at full', () => {
    const still = rollAfter(1, 0);
    expect(rollAfter(0)).toBe(still);
    expect(rollAfter(0, 20)).toBe(still);
    const full = Math.abs(rollAfter(1) - still);
    const half = Math.abs(rollAfter(0.5) - still);
    expect(full).toBeGreaterThan(0);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
  });

  it('at half, never shakes more than half as hard as full, however many hits land', () => {
    // The ceiling scales with the kick, so a storm of hits at 0.5 tops out at
    // half of full's, less the frame's decay.
    const still = rollAfter(1, 0);
    const full = Math.abs(rollAfter(1, 20) - still);
    const half = Math.abs(rollAfter(0.5, 20) - still);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThanOrEqual(full / 2);
  });
});

// SPEC-069 §4.6 — the view keeps up with a ship anywhere on its plane.
describe('FlightView free flight (SPEC-069 §4.6)', () => {
  it('restates the corridor and the lateral top speed it reads', () => {
    expect(VIEW_CORRIDOR).toBe(COURSE.corridor);
    expect(VIEW_LATERAL_SPEED).toBe(RAIL.lateralSpeed);
  });

  it('wraps a value into centre ± half by whole periods', () => {
    expect(wrapAround(5, 0, 70)).toBe(5);
    expect(wrapAround(75, 0, 70)).toBe(-65);
    expect(wrapAround(-75, 0, 70)).toBe(65);
    expect(wrapAround(10, 200, 70)).toBe(150);
    for (const v of [-1000, -3, 0, 42, 999]) {
      const w = wrapAround(v, 123, 70);
      expect(w).toBeGreaterThanOrEqual(123 - 70);
      expect(w).toBeLessThan(123 + 70);
    }
  });

  it('keeps every star around a camera 200 m off the line', () => {
    const { scene, camera, view } = setup();
    const f = frame();
    f.ship.x = 200;
    f.ship.y = -90;
    for (let i = 0; i < 120; i++) view.update(f, 1 / 60);
    const stars = scene.children.find((node) => (node as THREE.Points).isPoints === true) as THREE.Points;
    const data = stars.geometry.getAttribute('position').array as Float32Array;
    for (let i = 0; i < data.length; i += 3) {
      const worldX = (data[i] as number) + stars.position.x;
      const worldY = (data[i + 1] as number) + stars.position.y;
      expect(Math.abs(worldX - camera.position.x)).toBeLessThanOrEqual(70.001);
      expect(Math.abs(worldY - camera.position.y)).toBeLessThanOrEqual(45.001);
    }
  });

  it('draws the beacons always, and pickups and missiles only while there are some', () => {
    const { scene, view } = setup();
    const f = frame();
    f.pickups = new Pool<FramePickup>(() => ({ kind: 'fuel', x: 0, y: 0, depth: 0 }));
    f.missiles = new Pool<FrameMissile>(() => ({ x: 0, y: 0, depth: 0, vx: 0, vy: 0, vDepth: 0 }));
    view.update(f, 1 / 60);
    const instanced = (): THREE.InstancedMesh[] =>
      scene.children.filter((node): node is THREE.InstancedMesh => (node as THREE.InstancedMesh).isInstancedMesh === true);
    const visible = (): number => instanced().filter((mesh) => mesh.visible && mesh.count > 0).length;
    const before = visible();
    Object.assign(f.pickups.alloc(), { kind: 'missile', x: 3, y: 0, depth: 80 });
    Object.assign(f.missiles.alloc(), { x: 0, y: 0, depth: 20, vx: 0, vy: 0, vDepth: 75 });
    view.update(f, 1 / 60);
    expect(visible()).toBe(before + 4); // canister + light, missile + glow
    f.pickups.clear();
    f.missiles.clear();
    view.update(f, 1 / 60);
    expect(visible()).toBe(before);
    // A canister past the draw depth is not drawn.
    Object.assign(f.pickups.alloc(), { kind: 'oil', x: 3, y: 0, depth: 700 });
    view.update(f, 1 / 60);
    expect(visible()).toBe(before);
  });
});
