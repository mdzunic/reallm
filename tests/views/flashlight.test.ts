// SPEC-054 §4.5, §6.1 — the flashlight's three builds, pinned in node. The
// scene graph is plain three.js objects, so what joins the scene, what `setOn`
// writes and where `sync` aims are all readable here; the browser run and the
// e2e suite confirm the light count holds across swaps.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { UNDERGROUND } from '@/data/caves';
import {
  CONE_OPACITY,
  CONE_SEGMENTS,
  COOKIE_LENGTH,
  COOKIE_OPACITY,
  COOKIE_SIZE,
  COOKIE_WIDTH,
  FLASHLIGHT_SHADOW_SIZE,
  FLASHLIGHT_TURN_RATE,
  Flashlight,
  easeAim,
  flashlightCookie,
  type FlashlightMode,
} from '@/views/Flashlight';

const LOOK = UNDERGROUND.cinder4.look.flashlight;
const FRAME = 1 / 60;

/** Scene → actor group → player group: how `SurfaceView` hosts the flashlight. */
function hosted(): { scene: THREE.Scene; actors: THREE.Group; player: THREE.Group } {
  const scene = new THREE.Scene();
  const actors = new THREE.Group();
  const player = new THREE.Group();
  scene.add(actors);
  actors.add(player);
  return { scene, actors, player };
}

function lightsUnder(root: THREE.Object3D): THREE.Light[] {
  const out: THREE.Light[] = [];
  root.traverse((node) => {
    if ((node as THREE.Light).isLight === true) out.push(node as THREE.Light);
  });
  return out;
}

function meshesUnder(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh === true) out.push(node as THREE.Mesh);
  });
  return out;
}

function inGraph(root: THREE.Object3D, object: THREE.Object3D): boolean {
  let found = false;
  root.traverse((node) => {
    if (node === object) found = true;
  });
  return found;
}

function worldOf(object: THREE.Object3D): THREE.Vector3 {
  object.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
}

function triangles(geometry: THREE.BufferGeometry): number {
  return (geometry.index?.count ?? (geometry.getAttribute('position') as THREE.BufferAttribute).count) / 3;
}

function spotOf(scene: THREE.Scene): THREE.SpotLight {
  const spots = lightsUnder(scene).filter((light): light is THREE.SpotLight => (light as THREE.SpotLight).isSpotLight === true);
  expect(spots).toHaveLength(1);
  return spots[0] as THREE.SpotLight;
}

describe('the flashlight’s builds (SPEC-054 §4.5)', () => {
  it("'spot' adds exactly one SpotLight from the look, no shadow, and off leaves it in the graph at intensity 0", () => {
    const { scene, player } = hosted();
    const flashlight = new Flashlight(player, 'spot', LOOK);
    expect(flashlight.mode).toBe('spot');
    expect(flashlight.lightCount).toBe(1);
    expect(lightsUnder(scene)).toHaveLength(1);
    expect(meshesUnder(scene)).toHaveLength(0);
    const spot = spotOf(scene);
    expect(spot.color.getHex()).toBe(new THREE.Color(LOOK.color).getHex());
    expect(spot.intensity).toBe(45);
    expect(spot.distance).toBe(24);
    expect(spot.angle).toBe(0.42);
    expect(spot.penumbra).toBe(0.5);
    expect(spot.decay).toBe(1.3);
    expect(spot.castShadow).toBe(false);
    expect(spot.map).toBeNull();
    // The target is in the graph, so the renderer keeps its world matrix.
    expect(inGraph(scene, spot.target)).toBe(true);

    flashlight.setOn(false);
    expect(flashlight.on).toBe(false);
    expect(inGraph(scene, spot)).toBe(true);
    expect(spot.intensity).toBe(0);
    expect(spot.visible).toBe(true);
    expect(spot.castShadow).toBe(false);
    expect(lightsUnder(scene)).toHaveLength(1);
    flashlight.setOn(true);
    expect(spot.intensity).toBe(45);
    expect(lightsUnder(scene)).toHaveLength(1);
    flashlight.dispose();
  });

  it("'fake' adds no light and two meshes: a 7 × 5 m additive cookie and a 32-triangle open cone at 0.08", () => {
    const { scene, player } = hosted();
    const flashlight = new Flashlight(player, 'fake', LOOK);
    expect(flashlight.mode).toBe('fake');
    expect(flashlight.lightCount).toBe(0);
    expect(lightsUnder(scene)).toHaveLength(0);
    const meshes = meshesUnder(scene);
    expect(meshes).toHaveLength(2);
    const cookie = meshes.find((m) => m.name === 'flashlight-cookie') as THREE.Mesh;
    const cone = meshes.find((m) => m.name === 'flashlight-cone') as THREE.Mesh;
    expect(cookie).toBeDefined();
    expect(cone).toBeDefined();

    const cookieMaterial = cookie.material as THREE.MeshBasicMaterial;
    expect(cookieMaterial.blending).toBe(THREE.AdditiveBlending);
    expect(cookieMaterial.depthWrite).toBe(false);
    expect(cookieMaterial.opacity).toBe(COOKIE_OPACITY);
    const map = cookieMaterial.map as THREE.DataTexture;
    expect(map).toBeInstanceOf(THREE.DataTexture);
    expect([map.image.width, map.image.height]).toEqual([COOKIE_SIZE, COOKIE_SIZE]);
    cookie.geometry.computeBoundingBox();
    const size = (cookie.geometry.boundingBox as THREE.Box3).getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(COOKIE_LENGTH, 5);
    expect(size.z).toBeCloseTo(COOKIE_WIDTH, 5);
    expect(size.y).toBeCloseTo(0, 5); // flat on the floor

    const coneMaterial = cone.material as THREE.MeshBasicMaterial;
    expect(triangles(cone.geometry)).toBe(CONE_SEGMENTS);
    expect(CONE_SEGMENTS).toBe(32);
    expect(coneMaterial.opacity).toBe(CONE_OPACITY);
    expect(CONE_OPACITY).toBe(0.08);
    expect(coneMaterial.blending).toBe(THREE.AdditiveBlending);
    expect(coneMaterial.depthWrite).toBe(false);

    // Off writes opacity only: both meshes stay in the graph, visible.
    flashlight.setOn(false);
    expect(cookieMaterial.opacity).toBe(0);
    expect(coneMaterial.opacity).toBe(0);
    expect(meshesUnder(scene)).toHaveLength(2);
    expect(cookie.visible && cone.visible).toBe(true);
    expect(lightsUnder(scene)).toHaveLength(0);
    flashlight.setOn(true);
    expect(cookieMaterial.opacity).toBe(COOKIE_OPACITY);
    expect(coneMaterial.opacity).toBe(CONE_OPACITY);
    flashlight.dispose();
  });

  it("'spot-shadow' sets castShadow, a 512² shadow map and the 64² cookie as its map — and off/on keeps them", () => {
    const { scene, player } = hosted();
    const flashlight = new Flashlight(player, 'spot-shadow', LOOK);
    expect(flashlight.lightCount).toBe(1);
    const spot = spotOf(scene);
    expect(spot.castShadow).toBe(true);
    expect(spot.shadow.mapSize.x).toBe(FLASHLIGHT_SHADOW_SIZE);
    expect(spot.shadow.mapSize.y).toBe(512);
    expect(spot.map).not.toBeNull();
    const map = spot.map as THREE.DataTexture;
    expect([map.image.width, map.image.height]).toEqual([64, 64]);
    flashlight.setOn(false);
    expect(spot.intensity).toBe(0);
    expect(spot.castShadow).toBe(true);
    expect(spot.map).toBe(map);
    flashlight.setOn(true);
    expect(spot.intensity).toBe(45);
    flashlight.dispose();
  });

  it('the cookie is white at the core and black at the rim and corners, opaque throughout', () => {
    const cookie = flashlightCookie();
    const { data, width } = cookie.image as { data: Uint8Array; width: number };
    const at = (x: number, y: number): number => (y * width + x) * 4;
    const centre = at(32, 32);
    expect(data[centre]).toBeGreaterThan(250);
    expect(data[at(0, 0)]).toBe(0);
    expect(data[at(0, 32)]).toBeLessThan(10);
    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(255);
    // A falloff, not a step: the halfway texel sits between the two.
    expect(data[at(48, 32)]).toBeGreaterThan(20);
    expect(data[at(48, 32)]).toBeLessThan(235);
    cookie.dispose();
  });
});

describe('the flashlight’s aim (SPEC-054 §4.5)', () => {
  for (const mode of ['spot', 'spot-shadow', 'fake'] as FlashlightMode[]) {
    it(`'${mode}': sync aims ${LOOK.aimAhead} m along the facing, ${LOOK.height} m up, wherever the salvager stands`, () => {
      const { scene, player } = hosted();
      for (const [x, z, facing] of [
        [0, 0, 0],
        [12.5, -7, Math.PI / 2],
        [-30, 18, -2.4],
        [4, 4, Math.PI],
      ] as const) {
        // The view turns the player group with the facing every frame; the
        // flashlight must not inherit that turn.
        player.position.set(x, 0, z);
        player.rotation.y = -facing;
        const fresh = new Flashlight(player, mode, LOOK);
        fresh.sync(x, z, facing, FRAME); // the first sync snaps
        const ahead = new THREE.Vector3(x + Math.cos(facing) * LOOK.aimAhead, 0, z + Math.sin(facing) * LOOK.aimAhead);
        if (mode === 'fake') {
          const cookie = meshesUnder(scene).find((m) => m.name === 'flashlight-cookie') as THREE.Mesh;
          cookie.geometry.computeBoundingBox();
          const centre = (cookie.geometry.boundingBox as THREE.Box3).getCenter(new THREE.Vector3());
          cookie.updateWorldMatrix(true, false);
          centre.applyMatrix4(cookie.matrixWorld);
          expect(centre.x).toBeCloseTo(ahead.x, 4);
          expect(centre.z).toBeCloseTo(ahead.z, 4);
        } else {
          const spot = spotOf(scene);
          const light = worldOf(spot);
          const target = worldOf(spot.target);
          expect(light.x).toBeCloseTo(x, 5);
          expect(light.y).toBeCloseTo(LOOK.height, 5);
          expect(light.z).toBeCloseTo(z, 5);
          expect(target.distanceTo(ahead)).toBeLessThan(1e-4);
        }
        fresh.dispose();
      }
    });
  }

  it('eases toward a new facing at no more than 12 rad/s: a 180° turn takes more than one frame', () => {
    const { scene, player } = hosted();
    const flashlight = new Flashlight(player, 'spot', LOOK);
    flashlight.sync(0, 0, 0, FRAME);
    expect(flashlight.aim).toBe(0);
    flashlight.sync(0, 0, Math.PI, FRAME);
    expect(Math.abs(flashlight.aim)).toBeCloseTo(FLASHLIGHT_TURN_RATE * FRAME, 6);
    const spot = spotOf(scene);
    const target = worldOf(spot.target);
    // One frame in, the beam still points nearly where it did.
    expect(target.x).toBeGreaterThan(6.8);
    let frames = 1;
    while (Math.abs(Math.abs(flashlight.aim) - Math.PI) > 1e-9 && frames < 100) {
      flashlight.sync(0, 0, Math.PI, FRAME);
      frames++;
    }
    expect(frames).toBe(Math.ceil(Math.PI / (FLASHLIGHT_TURN_RATE * FRAME)));
    const arrived = worldOf(spot.target);
    expect(arrived.x).toBeCloseTo(-LOOK.aimAhead, 5);
    expect(arrived.z).toBeCloseTo(0, 5);
    // dt = 0 holds the aim, whatever the facing says.
    flashlight.sync(0, 0, 1, 0);
    expect(Math.abs(flashlight.aim)).toBeCloseTo(Math.PI, 9);
    flashlight.dispose();
  });

  it('easeAim turns the shortest way round, holds on dt ≤ 0, and lands exactly on the facing', () => {
    const step = FLASHLIGHT_TURN_RATE * FRAME;
    /** The signed gap between two headings, wrapped into (−π, π]. */
    const gap = (a: number, b: number): number => Math.atan2(Math.sin(a - b), Math.cos(a - b));
    // From 3.0 to −3.0 the short way is up through π, not down through 0; the
    // result stays wrapped, so it reads as 3.2 − 2π.
    const next = easeAim(3, -3, FRAME);
    expect(gap(next, 3 + step)).toBeCloseTo(0, 9);
    expect(next).toBeGreaterThan(-Math.PI);
    expect(next).toBeLessThanOrEqual(Math.PI);
    expect(gap(easeAim(-3, 3, FRAME), -3 - step)).toBeCloseTo(0, 9);
    expect(easeAim(0.5, 0.55, FRAME)).toBeCloseTo(0.55, 12);
    expect(easeAim(1, 2, 0)).toBe(1);
    expect(easeAim(1, 2, -1)).toBe(1);
    expect(easeAim(1, 2, Number.NaN)).toBe(1);
    // A long frame still turns at most the rate allows.
    expect(easeAim(0, 1, 0.05)).toBeCloseTo(0.6, 9);
  });

  it('hangs off the player group itself when it has no parent, and still aims in world space', () => {
    const player = new THREE.Group();
    player.position.set(5, 0, -3);
    player.rotation.y = 1.1;
    const flashlight = new Flashlight(player, 'spot', LOOK);
    const scene = new THREE.Scene();
    scene.add(player);
    const spot = spotOf(scene);
    expect(spot.parent).toBe(player);
    flashlight.sync(5, -3, 0.7, FRAME);
    const target = worldOf(spot.target);
    expect(target.x).toBeCloseTo(5 + Math.cos(0.7) * LOOK.aimAhead, 4);
    expect(target.z).toBeCloseTo(-3 + Math.sin(0.7) * LOOK.aimAhead, 4);
    expect(worldOf(spot).y).toBeCloseTo(LOOK.height, 5);
    flashlight.dispose();
    expect(player.children).toHaveLength(0);
  });
});

describe('the flashlight’s dispose (SPEC-054 §4.5)', () => {
  for (const mode of ['spot', 'spot-shadow', 'fake'] as FlashlightMode[]) {
    it(`'${mode}': removes everything it added and frees what it built`, () => {
      const { scene, actors, player } = hosted();
      const before = actors.children.length;
      const flashlight = new Flashlight(player, mode, LOOK);
      expect(actors.children.length).toBeGreaterThan(before);
      const freed: string[] = [];
      const built: { name: string; target: THREE.EventDispatcher<{ dispose: object }> }[] = [];
      for (const mesh of meshesUnder(actors)) {
        built.push({ name: `${mesh.name}:geometry`, target: mesh.geometry as never });
        built.push({ name: `${mesh.name}:material`, target: mesh.material as never });
        const map = (mesh.material as THREE.MeshBasicMaterial).map;
        if (map !== null) built.push({ name: `${mesh.name}:map`, target: map as never });
      }
      const spot = lightsUnder(actors)[0] as THREE.SpotLight | undefined;
      if (spot?.map) built.push({ name: 'cookie', target: spot.map as never });
      for (const entry of built) entry.target.addEventListener('dispose', () => freed.push(entry.name));

      flashlight.dispose();
      expect(actors.children).toHaveLength(before);
      expect(actors.children).toEqual([player]);
      expect(lightsUnder(scene)).toHaveLength(0);
      expect(meshesUnder(scene)).toHaveLength(0);
      expect(new Set(freed)).toEqual(new Set(built.map((entry) => entry.name)));
      if (mode === 'fake') expect(built.length).toBeGreaterThanOrEqual(5);
      if (mode === 'spot-shadow') expect(freed).toContain('cookie');
    });
  }
});
