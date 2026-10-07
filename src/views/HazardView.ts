// The hazards on screen (SPEC-068 §4.7, PLAN R28). Read-only over the fixed
// hazard list and the warnings pool `systems/Hazards.ts` rebuilds every step:
// - per hazard id, one `InstancedMesh` per part (`views/HazardMeshes.ts`) —
//   the body, a toppler's shaft, the glow — plus a vent's eruption plume;
// - one soft contact shadow under every standing helper;
// - the warnings, through a `TelegraphView` of their own in the caution colour,
//   so a trap never reads as an enemy's attack and never takes a slot from one.
// Only hazards within `HAZARD_DRAW_RADIUS` of the focus are written, and a part
// with none is hidden, so a planet's thirty-odd hazards cost a handful of draws
// near the player and nothing elsewhere. Allocates nothing per frame.
import * as THREE from 'three';
import type { Pool } from '@/core/Pool';
import { HAZARDS, type HazardId } from '@/data/hazards';
import type { PlanetId } from '@/data/ids';
import type { HazardEntity } from '@/entities/Hazard';
import type { TelegraphEntity } from '@/entities/Telegraph';
import { hazardGeometry } from '@/views/HazardMeshes';
import { TelegraphView } from '@/views/TelegraphView';

/** §4.7: the hazards' warnings wear caution amber on every preset — never the hostile rim. */
export const HAZARD_CAUTION = '#ffc23a';
/**
 * §4.7: where the ground is pale or itself amber the caution fades into it —
 * Vetra's snow turns it beige, Cinder-4's sand swallows it — so those two take
 * a deeper orange and a pale lemon, as V-02 overrides the enemies' rim.
 */
export const HAZARD_CAUTION_OVERRIDES: Readonly<Partial<Record<PlanetId, string>>> = {
  vetra: '#ff9a00',
  cinder4: '#fff27a',
};
/** §4.7: hazards farther than this from the focus are not drawn. */
export const HAZARD_DRAW_RADIUS = 48;
/** §4.7: a vent's plume rises and fades over this many seconds after it lands. */
export const PLUME_SECONDS = 0.9;
/** §4.7: the plume's opacity; it fades by thinning, so one material serves every ground. */
const PLUME_OPACITY = 0.62;
/** §4.7: a fallen shaft sinks away over this long after it lands. */
const SINK_SECONDS = 0.7;
/** The most warnings drawn at once (the pool's own cap). */
const WARNING_CAPACITY = 32;
const CONTACT_ALPHA = 0.42;

interface KindMeshes {
  readonly id: HazardId;
  readonly members: readonly number[];
  readonly body: THREE.InstancedMesh;
  readonly shaft: THREE.InstancedMesh | null;
  readonly shaftBase: number;
  readonly glow: THREE.InstancedMesh;
  readonly plume: THREE.InstancedMesh | null;
  readonly glowColor: THREE.Color;
}

const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchTip = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchAxis = new THREE.Vector3();
const scratchColor = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const scratchSphere = new THREE.Sphere();

/** A 64² radial falloff, white with alpha — the contact shadow's map. */
function contactTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const d = Math.min(1, Math.hypot(dx, dy) * 2);
      const a = Math.pow(1 - d, 1.6);
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(a * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/** A part with no instance this frame is hidden; one with some uploads. */
function finish(mesh: THREE.InstancedMesh | null): void {
  if (mesh === null) return;
  mesh.visible = mesh.count > 0;
  if (!mesh.visible) return;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
}

function easeIn(t: number): number {
  return t * t;
}

export class HazardView {
  readonly root = new THREE.Group();
  readonly #list: readonly HazardEntity[];
  readonly #kinds: KindMeshes[] = [];
  readonly #warnings: TelegraphView;
  readonly #shadows: THREE.InstancedMesh;
  readonly #ground: (x: number, z: number) => number;
  readonly #materials: THREE.Material[] = [];
  readonly #geometries: THREE.BufferGeometry[] = [];
  readonly #contactMap: THREE.DataTexture;

  constructor(parent: THREE.Object3D, list: readonly HazardEntity[], planet: PlanetId, ground: (x: number, z: number) => number) {
    this.root.name = 'surface-hazards';
    this.#list = list;
    this.#ground = ground;
    parent.add(this.root);

    const bodyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.05 });
    const metalMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.4 });
    const glowMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
    // Normal blending, not additive: an additive plume vanishes on Vetra's
    // snow and Eden's lawn. It fades by thinning and sinking instead of alpha.
    const plumeMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: PLUME_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.#materials.push(bodyMaterial, metalMaterial, glowMaterial, plumeMaterial);
    const plumeGeometry = new THREE.CylinderGeometry(0.55, 1, 1, 12, 1, true);
    plumeGeometry.translate(0, 0.5, 0);
    this.#geometries.push(plumeGeometry);

    const byId = new Map<HazardId, number[]>();
    for (let i = 0; i < list.length; i++) {
      const h = list[i] as HazardEntity;
      let members = byId.get(h.id);
      if (members === undefined) {
        members = [];
        byId.set(h.id, members);
      }
      members.push(i);
    }
    for (const [id, members] of byId) {
      const def = HAZARDS[id];
      const geometry = hazardGeometry(def);
      this.#geometries.push(geometry.body, geometry.glow);
      const metal = def.look.shape === 'drum' || def.look.shape === 'tank' || def.look.shape === 'tripmine';
      const body = new THREE.InstancedMesh(geometry.body, metal ? metalMaterial : bodyMaterial, members.length);
      body.name = `hazard-${id}`;
      body.castShadow = true;
      let shaft: THREE.InstancedMesh | null = null;
      if (geometry.shaft !== null) {
        this.#geometries.push(geometry.shaft);
        shaft = new THREE.InstancedMesh(geometry.shaft, bodyMaterial, members.length);
        shaft.name = `hazard-${id}-shaft`;
        shaft.castShadow = true;
      }
      const glow = new THREE.InstancedMesh(geometry.glow, glowMaterial, members.length);
      glow.name = `hazard-${id}-glow`;
      glow.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(members.length * 3), 3);
      let plume: THREE.InstancedMesh | null = null;
      if (def.archetype === 'vent') {
        plume = new THREE.InstancedMesh(plumeGeometry, plumeMaterial, members.length);
        plume.name = `hazard-${id}-plume`;
        plume.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(members.length * 3), 3);
        plume.frustumCulled = false;
      }
      for (const mesh of [body, shaft, glow, plume]) {
        if (mesh === null) continue;
        mesh.count = 0;
        mesh.visible = false;
        // The instances spread over the whole arena; the radius cut below is the cull.
        mesh.frustumCulled = false;
        this.root.add(mesh);
      }
      this.#kinds.push({
        id,
        members,
        body,
        shaft,
        shaftBase: geometry.shaftBase,
        glow,
        plume,
        glowColor: new THREE.Color(def.look.glow),
      });
    }

    this.#contactMap = contactTexture();
    const contactGeometry = new THREE.PlaneGeometry(1, 1);
    contactGeometry.rotateX(-Math.PI / 2);
    this.#geometries.push(contactGeometry);
    const contactMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: this.#contactMap,
      transparent: true,
      opacity: CONTACT_ALPHA,
      depthWrite: false,
    });
    this.#materials.push(contactMaterial);
    this.#shadows = new THREE.InstancedMesh(contactGeometry, contactMaterial, Math.max(1, list.length));
    this.#shadows.name = 'hazard-contact';
    this.#shadows.count = 0;
    this.#shadows.visible = false;
    this.#shadows.frustumCulled = false;
    this.#shadows.renderOrder = -1;
    this.root.add(this.#shadows);

    this.#warnings = new TelegraphView(this.root, WARNING_CAPACITY, planet, HAZARD_CAUTION_OVERRIDES[planet] ?? HAZARD_CAUTION);
  }

  /** Draw calls this layer issues this frame (for the budget pins). */
  get drawCalls(): number {
    if (!this.root.visible) return 0;
    let n = this.#warnings.drawCalls + (this.#shadows.visible ? 1 : 0);
    for (const k of this.#kinds) {
      if (k.body.visible) n++;
      if (k.shaft?.visible === true) n++;
      if (k.glow.visible) n++;
      if (k.plume?.visible === true) n++;
    }
    return n;
  }

  /**
   * Per rendered frame: `time` is the world clock the hazards were stamped
   * on, `(fx, fz)` the focus (the player), `frustum` the camera's — a hazard
   * whose bounds it misses is not written. Reduce motion stills the idle
   * glow's breathing; a warning still brightens, because it is information.
   */
  sync(
    warnings: Pool<TelegraphEntity>,
    time: number,
    fx: number,
    fz: number,
    frustum: THREE.Frustum | null,
    reduceMotion: boolean,
  ): void {
    if (!this.root.visible) return;
    const near = HAZARD_DRAW_RADIUS * HAZARD_DRAW_RADIUS;
    const shadows = this.#shadows;
    shadows.count = 0;
    for (const k of this.#kinds) {
      k.body.count = 0;
      k.glow.count = 0;
      if (k.shaft !== null) k.shaft.count = 0;
      if (k.plume !== null) k.plume.count = 0;
      for (let m = 0; m < k.members.length; m++) {
        const index = k.members[m] as number;
        const h = this.#list[index] as HazardEntity;
        const dx = h.x - fx;
        const dz = h.z - fz;
        if (dx * dx + dz * dz > near) continue;
        if (frustum !== null) {
          // Tall enough for a standing shaft, wide enough for a falling one or a plume.
          const reach = h.def.archetype === 'topple' || h.def.archetype === 'vent' ? h.def.reach : h.def.look.height;
          scratchSphere.center.set(h.x, this.#ground(h.x, h.z) + h.def.look.height * 0.5, h.z);
          scratchSphere.radius = Math.max(reach, h.def.look.height) + 1;
          if (!frustum.intersectsSphere(scratchSphere)) continue;
        }
        this.#drawOne(k, h, index, time, reduceMotion);
        if (h.def.archetype === 'topple' || (h.def.archetype === 'volatile' && h.state !== 'spent')) {
          const y = this.#ground(h.x, h.z) + 0.03;
          scratchPosition.set(h.x, y, h.z);
          scratchQuaternion.identity();
          const size = h.def.radius * 3.2 * h.scale;
          scratchScale.set(size, 1, size);
          scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
          shadows.setMatrixAt(shadows.count++, scratchMatrix);
        }
      }
      finish(k.body);
      finish(k.shaft);
      finish(k.glow);
      finish(k.plume);
    }
    shadows.visible = shadows.count > 0;
    if (shadows.visible) shadows.instanceMatrix.needsUpdate = true;
    this.#warnings.sync(warnings, time, this.#ground, reduceMotion);
  }

  #drawOne(k: KindMeshes, h: HazardEntity, index: number, time: number, reduceMotion: boolean): void {
    const def = h.def;
    const y = this.#ground(h.x, h.z);
    const progress = h.hitAt > h.startAt ? Math.min(1, Math.max(0, (time - h.startAt) / (h.hitAt - h.startAt))) : 1;
    const breathe = reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(time * 2.2 + index * 1.7);
    let glow = 0;
    let swell = 1;
    switch (def.archetype) {
      case 'vent':
        glow = h.state === 'warn' ? 0.9 + 2.6 * progress : 0.45 + 0.35 * breathe;
        if (h.state === 'warn' && !reduceMotion) swell = 1 + 0.03 * Math.sin(time * 40);
        break;
      case 'mine': {
        if (h.state === 'spent') return;
        // Idle: a short blink a second; armed: a fast strobe.
        const rate = h.state === 'warn' ? 9 : 0.8;
        const on = (time * rate + index * 0.37) % 1 < (h.state === 'warn' ? 0.5 : 0.14);
        glow = on ? (h.state === 'warn' ? 3.2 : 2.2) : 0.15;
        if (h.state === 'warn') swell = 1 + 0.12 * progress;
        break;
      }
      case 'volatile':
        if (h.state === 'spent') return;
        glow = h.state === 'warn' ? ((time * 14) % 1 < 0.5 ? 3.6 : 1.2) : 0.7 + 0.5 * breathe;
        if (h.state === 'warn') swell = 1 + 0.16 * progress;
        break;
      case 'topple':
        // The weak point — where to shoot — breathes until it gives.
        glow = h.state === 'idle' ? 0.8 + 0.9 * breathe : 0;
        break;
    }
    scratchPosition.set(h.x, y, h.z);
    scratchQuaternion.setFromAxisAngle(UP, h.yaw);
    scratchScale.set(h.scale * swell, h.scale * swell, h.scale * swell);
    scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
    k.body.setMatrixAt(k.body.count++, scratchMatrix);
    if (glow > 0) {
      k.glow.setMatrixAt(k.glow.count, scratchMatrix);
      scratchColor.copy(k.glowColor).multiplyScalar(glow);
      k.glow.setColorAt(k.glow.count, scratchColor);
      k.glow.count++;
    }
    if (k.shaft !== null) this.#drawShaft(k, h, y, time, progress);
    if (k.plume !== null && h.burstAt > -Infinity) {
      const age = time - h.burstAt;
      if (age >= 0 && age < PLUME_SECONDS) {
        const t = age / PLUME_SECONDS;
        // Rises fast, then thins from the base up as it spends itself.
        const thin = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
        const radius = def.reach * (0.5 + 0.3 * t) * (0.25 + 0.75 * thin);
        const height = 1 + 5.5 * Math.sqrt(t);
        scratchPosition.set(h.x, y + def.look.height * 0.5 + (1 - thin) * 2, h.z);
        scratchQuaternion.setFromAxisAngle(UP, h.yaw + t * 2);
        scratchScale.set(radius, height * (0.4 + 0.6 * thin), radius);
        scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
        k.plume.setMatrixAt(k.plume.count, scratchMatrix);
        scratchColor.copy(k.glowColor).multiplyScalar(1.15);
        k.plume.setColorAt(k.plume.count, scratchColor);
        k.plume.count++;
      }
    }
  }

  /** A toppler's shaft: upright, tipping about its foot along the fall, then sinking away. */
  #drawShaft(k: KindMeshes, h: HazardEntity, y: number, time: number, progress: number): void {
    const shaft = k.shaft as THREE.InstancedMesh;
    let tip = 0;
    let sink = 0;
    if (h.state === 'falling') tip = easeIn(progress);
    else if (h.state === 'spent') {
      const age = time - h.burstAt;
      if (age >= SINK_SECONDS) return;
      tip = 1;
      sink = age / SINK_SECONDS;
    }
    const base = k.shaftBase * h.scale;
    scratchPosition.set(h.x, y + base * (1 - 0.8 * tip) - sink * 1.4, h.z);
    scratchQuaternion.setFromAxisAngle(UP, h.yaw);
    if (tip > 0) {
      // Tipping +Y toward d = (dirX, dirZ) is a turn about up × d = (dirZ, 0, −dirX).
      scratchAxis.set(h.dirZ, 0, -h.dirX).normalize();
      scratchTip.setFromAxisAngle(scratchAxis, tip * Math.PI * 0.5);
      scratchQuaternion.premultiply(scratchTip);
    }
    const s = h.scale * (1 - 0.3 * sink);
    scratchScale.set(s, s, s);
    scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
    shaft.setMatrixAt(shaft.count++, scratchMatrix);
  }

  dispose(): void {
    this.#warnings.dispose();
    this.root.parent?.remove(this.root);
    for (const k of this.#kinds) {
      k.body.dispose();
      k.shaft?.dispose();
      k.glow.dispose();
      k.plume?.dispose();
    }
    this.#shadows.dispose();
    for (const g of this.#geometries) g.dispose();
    for (const m of this.#materials) m.dispose();
    this.#contactMap.dispose();
  }
}
