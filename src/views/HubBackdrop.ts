// The hub scenes' shared backdrop (SPEC-020 §4.4). The station, menu, creation
// screen and star map all sit in the same place — a dock ring above a landing
// pad, in front of the station's nebula window — so the pieces live here once
// and each scene composes the ones it wants into its own single `Group`.
//
// Everything starts as a procedural module with emissive strips, because the
// models are not in the boot manifest (PLAN R6-5, `data/assets.ts`): `loadHubArt`
// fetches them on `enter()` and hands them over when they land. A hub that
// never gets them keeps what it built (20-e), and `props` never moves either
// way — the swap replaces meshes one for one.
import * as THREE from 'three';
import type { Assets } from '@/core/Assets';
import { disposeObject3D } from '@/core/Disposer';
import { log } from '@/core/Log';
import { HUB_ASSETS } from '@/data/assets';
import { SKY_WINDOW } from '@/views/FlightView';

/** §4.4 (*initial tuning*): the key + rim pair every hub backdrop is lit by. */
const KEY = { color: 0xdfe8ff, intensity: 1.8, at: [2, 3, 2] } as const;
const RIM = { color: 0x4c9aff, intensity: 0.6, at: [-3, 1.5, -4] } as const;
/** The window sits far enough out that nothing in a hub can reach it. */
const SKY_RADIUS = 60;
/** The lit strips on the procedural modules, so they read before the art lands. */
const RING_EMISSIVE = 0x8fd8ff;
const DOCK_EMISSIVE = 0xffb347;

/** The backdrop art the hub scenes wait for; any field may stay null (20-e). */
export interface HubArt {
  readonly sky: THREE.Texture | null;
  readonly ring: THREE.Object3D | null;
  readonly dock: THREE.Object3D | null;
}

/**
 * §4.4: the key and the rim, added to the backdrop group so they live and die
 * with it. Lights hold no GPU memory, so the group's disposal is enough.
 */
export function addHubLights(group: THREE.Group): void {
  const key = new THREE.DirectionalLight(KEY.color, KEY.intensity);
  key.position.set(...KEY.at);
  const rim = new THREE.DirectionalLight(RIM.color, RIM.intensity);
  rim.position.set(...RIM.at);
  group.add(key, rim);
}

/** §4.4: the station window on R8's `SKY_WINDOW` geometry, behind everything. */
export function hubSkyMesh(texture: THREE.Texture): THREE.Mesh {
  const { phiStart, phiLength, thetaStart, thetaLength } = SKY_WINDOW;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 32, 24, phiStart, phiLength, thetaStart, thetaLength),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

/** §4.4: the dock ring when `station_ring.glb` is not there — lit strips on a torus. */
export function proceduralRing(): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.TorusGeometry(2.2, 0.16, 12, 64),
    new THREE.MeshStandardMaterial({
      color: 0x4a5a6c,
      roughness: 0.6,
      metalness: 0.5,
      emissive: RING_EMISSIVE,
      emissiveIntensity: 0.35,
    }),
  );
}

/** §4.4: the landing pad when `dock.glb` is not there. */
export function proceduralDock(): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.1, 0.18, 20),
    new THREE.MeshStandardMaterial({
      color: 0x2c3947,
      roughness: 0.9,
      emissive: DOCK_EMISSIVE,
      emissiveIntensity: 0.25,
    }),
  );
}

/**
 * Put `model` where `module` stood and let the module go — the backdrop keeps
 * its shape, so `props` keeps its value (20-e). The model is a clone from the
 * asset cache, so the group's own disposal frees it and walks past the shared
 * geometry and materials behind it (SPEC-003 D-33).
 */
export function swapModule(group: THREE.Group, module: THREE.Object3D, model: THREE.Object3D): void {
  model.position.copy(module.position);
  model.rotation.copy(module.rotation);
  model.scale.copy(module.scale);
  group.remove(module);
  disposeObject3D(module);
  group.add(model);
}

/** A load that joined another pass in flight may not hold every id. */
function pick<T>(get: () => T): T | null {
  try {
    return get();
  } catch {
    return null;
  }
}

/**
 * Fetch the whole hub set — the window, the ring and the pad — and hand it over
 * once, unless the caller has gone. Returns nothing: the scene's disposer owns
 * the cancel through `alive`, the same shape `FlightScene.#dress` uses for the
 * trip's art.
 */
export function loadHubArt(assets: Assets, alive: () => boolean, onReady: (art: HubArt) => void): void {
  void assets
    .load(HUB_ASSETS)
    .then(() => {
      if (!alive()) return;
      onReady({
        sky: pick(() => assets.texture('sky_station')),
        ring: pick(() => assets.model('station_ring')),
        dock: pick(() => assets.model('dock')),
      });
    })
    .catch((cause: unknown) => log.warn('scene', 'the hub backdrop art did not load; the modules stay', cause));
}

/**
 * The window alone — what the menu, the creation screen and the star map put
 * behind themselves. They never draw the ring or the pad, and the boot suites
 * measure every request the first screen makes (PLAN R6-5), so they fetch one
 * texture rather than the station's three files.
 */
export function loadHubSky(assets: Assets, alive: () => boolean, onReady: (sky: THREE.Texture) => void): void {
  void assets
    .load({ models: {}, textures: HUB_ASSETS.textures, audio: {} })
    .then(() => {
      if (!alive()) return;
      const sky = pick(() => assets.texture('sky_station'));
      if (sky !== null) onReady(sky);
    })
    .catch((cause: unknown) => log.warn('scene', 'the hub window did not load; the backdrop stays bare', cause));
}
