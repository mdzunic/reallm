// The flashlight below (SPEC-054 §4.5) — one of three builds, chosen by the
// preset's `QualitySettings.flashlight`:
//
//   'fake'         no light at all: an additive cookie on the ground 7 m
//                  ahead and a faint open cone (low; the torch widens instead)
//   'spot'         one `SpotLight` from `DarkLook.flashlight`, no shadow
//   'spot-shadow'  the same spot casting a 512² shadow, with the 64² cookie
//                  as its `map` (three only projects a spot's map through its
//                  shadow, so the cookie needs the shadow anyway)
//
// It is built once, at a visit's first descent behind the fade, and stays in
// the graph for the rest of the visit: three recompiles every lit program
// when the light count changes, so `setOn` only ever writes an intensity (an
// opacity for 'fake') and never `visible`, `castShadow` or the count (§4.5).
//
// The player group turns with the facing every frame, but the beam eases
// toward it at 12 rad/s — so nothing here rides the group. The light, its
// target and the fake rig hang off the group's parent and are placed from the
// world coordinates `sync` is handed.
import * as THREE from 'three';
import type { QualitySettings } from '@/core/Quality';
import type { DarkLook } from '@/data/caves';

export type FlashlightMode = QualitySettings['flashlight'];

/** §4.5 (*initial tuning*): the most the beam turns toward the facing, in rad/s. */
export const FLASHLIGHT_TURN_RATE = 12;
/** §4.5: the fake ground cookie — metres along the aim and across it — and its opacity while on. */
export const COOKIE_LENGTH = 7;
export const COOKIE_WIDTH = 5;
export const COOKIE_OPACITY = 0.45;
/** §4.5: the fake beam, an open cone of this many triangles, at this opacity while on. */
export const CONE_SEGMENTS = 32;
export const CONE_OPACITY = 0.08;
/** §4.5: the cookie's texels per side, and the `spot-shadow` shadow map's. */
export const COOKIE_SIZE = 64;
export const FLASHLIGHT_SHADOW_SIZE = 512;
/** The fake cookie floats this far above the floor so it never fights it. */
const COOKIE_LIFT = 0.04;
/** The cookie's full-strength core, as a share of its radius. */
const COOKIE_CORE = 0.15;
/** A small depth bias, so the walls the beam grazes do not stripe themselves. */
const SHADOW_BIAS = -0.0005;
const SHADOW_NEAR = 0.2;

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const scratchVector = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchYaw = new THREE.Quaternion();
const scratchInverse = new THREE.Matrix4();

/** An angle wrapped into (−π, π]. */
function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * §4.5, pure: the heading the beam holds after `dt` seconds of turning from
 * `aim` toward `facing` — the shortest way round, at no more than
 * `FLASHLIGHT_TURN_RATE`. `dt` ≤ 0 holds. Exported for its own test.
 */
export function easeAim(aim: number, facing: number, dt: number): number {
  if (!(dt > 0)) return aim;
  const delta = wrapAngle(facing - aim);
  const step = FLASHLIGHT_TURN_RATE * dt;
  return wrapAngle(aim + Math.max(-step, Math.min(step, delta)));
}

/**
 * §4.5: the cookie — 64² RGBA computed in JS (never a canvas, so it builds in
 * a node test), white at the core and rolling off to black at the rim. Radial
 * in texture space: the spot projects it round, and the fake's 7 × 5 m quad
 * stretches it into the beam's ellipse on the ground. Alpha is opaque, so the
 * additive quad adds exactly the falloff.
 */
export function flashlightCookie(size = COOKIE_SIZE): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - centre, y - centre) / centre;
      const t = Math.min(1, Math.max(0, (1 - r) / (1 - COOKIE_CORE)));
      const value = Math.round(255 * t * t * (3 - 2 * t));
      const at = (y * size + x) * 4;
      data[at] = value;
      data[at + 1] = value;
      data[at + 2] = value;
      data[at + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The fake beam in its rig's frame (the salvager's feet at the origin, the aim
 * along +x): an open cone, apex at the light, its axis through the ground
 * point `aimAhead` ahead, opening at the spot's angle.
 */
function coneGeometry(look: DarkLook['flashlight']): THREE.BufferGeometry {
  const length = Math.hypot(look.aimAhead, look.height);
  const radius = length * Math.tan(look.angle);
  // Open-ended with a zero top radius: one triangle per segment.
  const cone = new THREE.ConeGeometry(radius, length, CONE_SEGMENTS, 1, true);
  cone.translate(0, -length / 2, 0); // apex at the origin, opening down −y
  scratchVector.set(look.aimAhead, -look.height, 0).normalize();
  cone.applyQuaternion(scratchQuat.setFromUnitVectors(scratchScale.set(0, -1, 0), scratchVector));
  cone.translate(0, look.height, 0);
  return cone;
}

export class Flashlight {
  /** The mode it was built in; a preset change rebuilds it (§4.5, 54-g). */
  readonly mode: FlashlightMode;
  /** The lights it adds to the scene: 1 for the spot modes, 0 for 'fake'. */
  readonly lightCount: 0 | 1;
  readonly #look: DarkLook['flashlight'];
  /** Where everything hangs: the player group's parent, else the group. */
  readonly #host: THREE.Object3D;
  readonly #light: THREE.SpotLight | null = null;
  /** 'fake': the cookie and the cone, turned by the aim about the salvager's feet. */
  readonly #rig: THREE.Group | null = null;
  readonly #cookieMaterial: THREE.MeshBasicMaterial | null = null;
  readonly #coneMaterial: THREE.MeshBasicMaterial | null = null;
  readonly #cookie: THREE.DataTexture | null = null;
  #aim = 0;
  #aimed = false;
  #on = true;

  constructor(playerGroup: THREE.Object3D, mode: FlashlightMode, look: DarkLook['flashlight']) {
    this.mode = mode;
    this.#look = look;
    this.#host = playerGroup.parent ?? playerGroup;
    if (mode === 'fake') {
      this.lightCount = 0;
      this.#cookie = flashlightCookie();
      this.#cookieMaterial = new THREE.MeshBasicMaterial({
        color: look.color,
        map: this.#cookie,
        transparent: true,
        opacity: COOKIE_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.#coneMaterial = new THREE.MeshBasicMaterial({
        color: look.color,
        transparent: true,
        opacity: CONE_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      // Additive: the order of the two faces does not matter, so one pass.
      this.#coneMaterial.forceSinglePass = true;
      const quad = new THREE.PlaneGeometry(COOKIE_LENGTH, COOKIE_WIDTH);
      quad.rotateX(-Math.PI / 2);
      quad.translate(look.aimAhead, COOKIE_LIFT, 0);
      const cookie = new THREE.Mesh(quad, this.#cookieMaterial);
      cookie.name = 'flashlight-cookie';
      const cone = new THREE.Mesh(coneGeometry(look), this.#coneMaterial);
      cone.name = 'flashlight-cone';
      const rig = new THREE.Group();
      rig.name = 'flashlight';
      rig.add(cookie, cone);
      this.#rig = rig;
      this.#host.add(rig);
      return;
    }
    this.lightCount = 1;
    const light = new THREE.SpotLight(look.color, look.intensity, look.distance, look.angle, look.penumbra, look.decay);
    light.name = 'flashlight';
    light.target.name = 'flashlight-target';
    if (mode === 'spot-shadow') {
      light.castShadow = true;
      light.shadow.mapSize.set(FLASHLIGHT_SHADOW_SIZE, FLASHLIGHT_SHADOW_SIZE);
      light.shadow.bias = SHADOW_BIAS;
      light.shadow.camera.near = SHADOW_NEAR;
      this.#cookie = flashlightCookie();
      light.map = this.#cookie;
    }
    light.position.set(0, look.height, 0);
    light.target.position.set(look.aimAhead, 0, 0);
    this.#light = light;
    // The target joins the graph too, so the renderer keeps its world matrix.
    this.#host.add(light, light.target);
  }

  /** Whether the beam is on (§4.5): built on; the scene drives it. */
  get on(): boolean {
    return this.#on;
  }

  /** The heading the beam holds now, in radians — what `sync` eased toward the facing. */
  get aim(): number {
    return this.#aim;
  }

  /**
   * §4.5: on and off write the intensity — the opacities for 'fake' — and
   * nothing else, so the light count and every program stay as they are.
   */
  setOn(on: boolean): void {
    this.#on = on;
    if (this.#light !== null) this.#light.intensity = on ? this.#look.intensity : 0;
    if (this.#cookieMaterial !== null) this.#cookieMaterial.opacity = on ? COOKIE_OPACITY : 0;
    if (this.#coneMaterial !== null) this.#coneMaterial.opacity = on ? CONE_OPACITY : 0;
  }

  /**
   * §4.5: the light `height` above (x, z) and its target `aimAhead` along the
   * aim, which turns toward `facing` at no more than 12 rad/s — and snaps on
   * the first call. World coordinates; allocates nothing. The easing is
   * information, not motion, so it runs under reduced motion too (54-i).
   */
  sync(x: number, z: number, facing: number, dt: number): void {
    if (!this.#aimed) {
      this.#aim = wrapAngle(facing);
      this.#aimed = true;
    } else {
      this.#aim = easeAim(this.#aim, facing, dt);
    }
    const look = this.#look;
    const cos = Math.cos(this.#aim);
    const sin = Math.sin(this.#aim);
    // World → the host's frame; the identity for a host at the origin.
    const host = this.#host;
    host.updateWorldMatrix(true, false);
    scratchInverse.copy(host.matrixWorld).invert();
    const light = this.#light;
    if (light !== null) {
      light.position.copy(scratchVector.set(x, look.height, z).applyMatrix4(scratchInverse));
      light.target.position.copy(
        scratchVector.set(x + cos * look.aimAhead, 0, z + sin * look.aimAhead).applyMatrix4(scratchInverse),
      );
    }
    const rig = this.#rig;
    if (rig !== null) {
      rig.position.copy(scratchVector.set(x, 0, z).applyMatrix4(scratchInverse));
      // Local +x onto (cos, sin) is a turn of −aim about y, under the host's own.
      host.matrixWorld.decompose(scratchVector, scratchQuat, scratchScale);
      rig.quaternion.copy(scratchQuat.invert()).multiply(scratchYaw.setFromAxisAngle(Y_AXIS, -this.#aim));
    }
  }

  /** Takes out everything it added and frees what it built (the shadow map included). */
  dispose(): void {
    const light = this.#light;
    if (light !== null) {
      light.removeFromParent();
      light.target.removeFromParent();
      light.dispose();
    }
    const rig = this.#rig;
    if (rig !== null) {
      rig.removeFromParent();
      rig.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh === true) mesh.geometry.dispose();
      });
    }
    this.#cookieMaterial?.dispose();
    this.#coneMaterial?.dispose();
    this.#cookie?.dispose();
  }
}
