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
  mergeModel,
  SKY_WINDOW,
  type FlightFrame,
  type FrameBurst,
  type FrameHazard,
  type FrameShot,
} from '@/views/FlightView';

const QUALITY = { starfieldPoints: 40, asteroidCap: 12, maxParticles: 24 } as unknown as QualitySettings;

function setup(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; view: FlightView } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 600);
  const view = new FlightView(scene, camera, { planet: PLANETS.cinder4, quality: QUALITY, reduceMotion: false, rng: new Rng(7) });
  return { scene, camera, view };
}

function frame(): FlightFrame {
  return {
    ship: { x: 0, y: 0, vy: 0, bank: 0, alive: true },
    hazards: new Pool<FrameHazard>(() => ({ kind: 'asteroid', x: 0, y: 0, depth: 0, radius: 1 })),
    shots: new Pool<FrameShot>(() => ({ x: 0, y: 0, depth: 0 })),
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
