// The pooled combat VFX (SPEC-019 §4.4): one instanced quad mesh of additive
// sprites for every burst kind, a 24-quad scorch-decal ring buffer, and one
// pulsed muzzle point light. Everything is allocated at construction —
// `burst()` writes into typed arrays through a ring head and never allocates
// or throws, past capacity it overwrites the oldest particle (19-d, 19-e).
//
// Per-particle spread is deterministic from the particle's ring index
// (`hash01`), never `Math.random` (SPEC-008 §4.3). The quads billboard toward
// the fixed surface camera, which never rotates (SPEC-012 §4.3).
//
// SPEC-056 §4.4, §4.5: the Seed Drum's spore clouds are one instanced
// translucent disc (1 draw), and the flares an additive ground disc and an
// emissive billboard, each instanced for two (2 draws) — and no `THREE.Light`,
// so SPEC-054's light count never moves mid-level.
import * as THREE from 'three';
import { hash01 } from '@/core/Noise';
import { decalAtlas, particleSprite } from '@/views/ProceduralTextures';

export type FxKind = 'hit' | 'death' | 'spawn' | 'pickup' | 'dust_ring' | 'muzzle' | 'blast' | 'dash';

/** §4.4 — the burst table (*initial tuning*). */
interface BurstDef {
  count: number;
  life: number;
  speedMin: number;
  speedMax: number;
  /** 'cone' rises, 'hemisphere' scatters, 'outward'/'radial' hug the ground. */
  spread: 'cone' | 'hemisphere' | 'outward' | 'radial' | 'up' | 'still';
  gravity: number;
  size: number;
  /** Metres above the ground the particles are born at. */
  origin: number;
}

const BURSTS: Record<FxKind, BurstDef> = {
  hit: { count: 6, life: 0.35, speedMin: 4, speedMax: 7, spread: 'cone', gravity: -9, size: 0.12, origin: 0.9 },
  death: { count: 14, life: 0.6, speedMin: 3, speedMax: 6, spread: 'hemisphere', gravity: -9, size: 0.18, origin: 0.6 },
  spawn: { count: 8, life: 0.5, speedMin: 1, speedMax: 2, spread: 'outward', gravity: 0, size: 0.3, origin: 0.2 },
  pickup: { count: 5, life: 0.4, speedMin: 1.5, speedMax: 1.5, spread: 'up', gravity: -2, size: 0.1, origin: 0.5 },
  dust_ring: { count: 24, life: 0.8, speedMin: 6, speedMax: 6, spread: 'radial', gravity: -6, size: 0.35, origin: 0.25 },
  muzzle: { count: 3, life: 0.08, speedMin: 0, speedMax: 0, spread: 'still', gravity: 0, size: 0.4, origin: 0.9 },
  // SPEC-029 §4.12: the blast; callers scale it by `radius / 3.5`.
  blast: { count: 30, life: 0.5, speedMin: 5, speedMax: 9, spread: 'hemisphere', gravity: -4, size: 0.6, origin: 0.4 },
  // SPEC-038 §4.1: the dash's afterimages, laid along the path by `dash()`.
  dash: { count: 15, life: 0.3, speedMin: 0, speedMax: 0, spread: 'still', gravity: 0, size: 0.34, origin: 0.9 },
};

/** SPEC-038 §4.1: three streaks, this many sprites each, this far apart across the path. */
const DASH_STREAKS = 3;
const DASH_STREAK_SPRITES = 5;
const DASH_STREAK_GAP = 0.32;
/** The streaks drift back along the path while they fade. */
const DASH_DRIFT = 1.5;

/** The §4.4 death flash: a second short burst at × 3 brightness. */
const DEATH_FLASH_COUNT = 4;
const DEATH_FLASH_LIFE = 0.12;
const DEATH_FLASH_GAIN = 3;

/** Scorch decals (§4.4): ring of 24, 20 s fade, just above the ground. */
const SCORCH_CAPACITY = 24;
const SCORCH_LIFE = 20;
const SCORCH_LIFT = 0.02;
const SCORCH_SIZE = 1.6;

/** The muzzle light pulse: intensity 8 decaying to 0 over 80 ms. */
const MUZZLE_INTENSITY = 8;
const MUZZLE_DECAY_SECONDS = 0.08;
const MUZZLE_LIGHT_HEIGHT = 1.2;

const DEFAULT_CAPACITY = 512;

/** SPEC-056 §3: a ground effect that ends at a world time — a burning flare. */
export interface TimedGround {
  readonly x: number;
  readonly z: number;
  readonly until: number;
}

/** SPEC-056 §4.4: a spore cloud — a timed ground effect with its radius. */
export interface TimedCloud extends TimedGround {
  readonly radius: number;
}

/** SPEC-056 §4.4: the most clouds the disc draws — `MAX_LINGER_CLOUDS`. */
export const CLOUD_CAPACITY = 6;
/** SPEC-056 §4.5: the most flares the disc and the glow draw — `MAX_FLARES`. */
export const FLARE_CAPACITY = 2;
/** SPEC-056 §4.5 (*initial tuning*): the flare's lit ground — 12 m, additive, no fog. */
export const FLARE_DISC_RADIUS = 12;
export const FLARE_DISC_COLOR = '#ffcf8a';
export const FLARE_DISC_OPACITY = 0.35;
/** The flare itself: a bright billboard this wide, this high off the ground. */
const FLARE_GLOW_SIZE = 0.9;
const FLARE_GLOW_LIFT = 0.35;
const FLARE_GLOW_GAIN = 2.2;
/** The spore cloud's tint and veil (*initial tuning*). */
const CLOUD_COLOR = '#a6d86a';
const CLOUD_OPACITY = 0.3;
const GROUND_LIFT = 0.04;

const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchColor = new THREE.Color();

/** A unit quad whose UVs read the atlas' scorch tile (`DECAL_TILE.scorch`). */
function scorchGeometry(): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  const uv = geometry.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5 + uv.getX(i) * 0.5, uv.getY(i) * 0.5);
  return geometry;
}

export class CombatFx {
  readonly #capacity: number;
  readonly #billboard: THREE.Quaternion;
  readonly #mesh: THREE.InstancedMesh;
  readonly #material: THREE.MeshBasicMaterial;

  // One particle per slot, columns in typed arrays (SPEC-001 §7).
  readonly #x: Float32Array;
  readonly #z: Float32Array;
  readonly #y0: Float32Array;
  readonly #vx: Float32Array;
  readonly #vy: Float32Array;
  readonly #vz: Float32Array;
  readonly #gravity: Float32Array;
  readonly #born: Float32Array;
  readonly #life: Float32Array;
  readonly #size: Float32Array;
  readonly #r: Float32Array;
  readonly #g: Float32Array;
  readonly #b: Float32Array;
  #head = 0;

  readonly #scorches: THREE.InstancedMesh;
  readonly #scorchMaterial: THREE.MeshBasicMaterial;
  readonly #scorchX = new Float32Array(SCORCH_CAPACITY);
  readonly #scorchZ = new Float32Array(SCORCH_CAPACITY);
  readonly #scorchBorn = new Float32Array(SCORCH_CAPACITY);
  readonly #scorchScale = new Float32Array(SCORCH_CAPACITY).fill(1);
  #scorchHead = 0;
  #scorchCount = 0;

  readonly #clouds: THREE.InstancedMesh;
  readonly #cloudMaterial: THREE.MeshBasicMaterial;
  readonly #flareDiscs: THREE.InstancedMesh;
  readonly #flareDiscMaterial: THREE.MeshBasicMaterial;
  readonly #flareGlows: THREE.InstancedMesh;
  readonly #flareGlowMaterial: THREE.MeshBasicMaterial;
  readonly #flareColor = new THREE.Color(FLARE_DISC_COLOR);

  readonly #light: THREE.PointLight;
  #lightFiredAt = -Infinity;
  #lightX = 0;
  #lightZ = 0;

  /** The last `sync` time — what a `burst` between frames is born at. */
  #time = 0;

  constructor(parent: THREE.Object3D, billboard: THREE.Quaternion, capacity: number = DEFAULT_CAPACITY) {
    this.#capacity = Math.max(1, capacity);
    this.#x = new Float32Array(this.#capacity);
    this.#z = new Float32Array(this.#capacity);
    this.#y0 = new Float32Array(this.#capacity);
    this.#vx = new Float32Array(this.#capacity);
    this.#vy = new Float32Array(this.#capacity);
    this.#vz = new Float32Array(this.#capacity);
    this.#gravity = new Float32Array(this.#capacity);
    this.#born = new Float32Array(this.#capacity).fill(-Infinity);
    this.#life = new Float32Array(this.#capacity);
    this.#size = new Float32Array(this.#capacity);
    this.#r = new Float32Array(this.#capacity);
    this.#g = new Float32Array(this.#capacity);
    this.#b = new Float32Array(this.#capacity);

    this.#billboard = billboard.clone();
    this.#material = new THREE.MeshBasicMaterial({
      map: particleSprite('dot'),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.#mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.#material, this.#capacity);
    this.#mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#mesh.setColorAt(0, scratchColor.set('#ffffff'));
    this.#mesh.count = 0;
    this.#mesh.visible = false;
    this.#mesh.frustumCulled = false;
    parent.add(this.#mesh);

    this.#scorchMaterial = new THREE.MeshBasicMaterial({
      map: decalAtlas(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.#scorches = new THREE.InstancedMesh(scorchGeometry(), this.#scorchMaterial, SCORCH_CAPACITY);
    this.#scorches.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#scorches.setColorAt(0, scratchColor.set('#ffffff'));
    this.#scorches.count = 0;
    this.#scorches.visible = false;
    this.#scorches.frustumCulled = false;
    this.#scorches.renderOrder = 1;
    parent.add(this.#scorches);

    // SPEC-056 §4.4: the spore clouds — one translucent disc, instanced for six.
    this.#cloudMaterial = new THREE.MeshBasicMaterial({
      color: CLOUD_COLOR,
      transparent: true,
      opacity: CLOUD_OPACITY,
      depthWrite: false,
    });
    this.#clouds = groundDiscs(this.#cloudMaterial, CLOUD_CAPACITY, parent);
    // SPEC-056 §4.5: the flares — the lit ground and the flare itself, two each.
    this.#flareDiscMaterial = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: FLARE_DISC_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.#flareDiscs = groundDiscs(this.#flareDiscMaterial, FLARE_CAPACITY, parent);
    this.#flareGlowMaterial = new THREE.MeshBasicMaterial({
      map: particleSprite('dot'),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.#flareGlows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.#flareGlowMaterial, FLARE_CAPACITY);
    this.#flareGlows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#flareGlows.setColorAt(0, scratchColor.set('#ffffff'));
    this.#flareGlows.count = 0;
    this.#flareGlows.visible = false;
    this.#flareGlows.frustumCulled = false;
    parent.add(this.#flareGlows);

    // §4.4: created once, parented once, never added or removed at runtime —
    // so no shader recompile lands mid-combat (19-k discussion, Decisions #15).
    this.#light = new THREE.PointLight(0xffffff, 0, 8, 2);
    parent.add(this.#light);
  }

  /** SPEC-056 §4.4: the draws the clouds take this frame — 0 or 1. */
  get cloudDraws(): number {
    return this.#clouds.visible ? 1 : 0;
  }

  /** SPEC-056 §4.5: the draws the flares take this frame — 0 or 2, never a light. */
  get flareDraws(): number {
    return (this.#flareDiscs.visible ? 1 : 0) + (this.#flareGlows.visible ? 1 : 0);
  }

  /**
   * SPEC-056 §4.4, §4.5: the clouds and the flares still burning at `time` —
   * the world clock their `until` is stamped on. A cloud is a veil of its
   * radius; a flare lights 12 m of ground and glows at its centre, the ground
   * flickering unless `still` (reduce motion). Allocates nothing.
   */
  syncTreasure(
    flares: readonly TimedGround[],
    clouds: readonly TimedCloud[],
    time: number,
    ground: (x: number, z: number) => number,
    still: boolean,
  ): void {
    let n = 0;
    for (let k = 0; k < clouds.length && n < CLOUD_CAPACITY; k++) {
      const c = clouds[k] as TimedCloud;
      if (time >= c.until) continue;
      scratchPosition.set(c.x, ground(c.x, c.z) + GROUND_LIFT, c.z);
      scratchScale.set(c.radius, 1, c.radius);
      scratchMatrix.compose(scratchPosition, IDENTITY_QUAT, scratchScale);
      this.#clouds.setMatrixAt(n, scratchMatrix);
      n++;
    }
    finish(this.#clouds, n);

    let f = 0;
    for (let k = 0; k < flares.length && f < FLARE_CAPACITY; k++) {
      const flare = flares[k] as TimedGround;
      if (time >= flare.until) continue;
      const floor = ground(flare.x, flare.z);
      const flicker = still ? 1 : 0.85 + 0.15 * Math.sin(time * 23 + k * 1.7) * Math.sin(time * 7.3 + k);
      scratchPosition.set(flare.x, floor + GROUND_LIFT, flare.z);
      scratchScale.set(FLARE_DISC_RADIUS, 1, FLARE_DISC_RADIUS);
      scratchMatrix.compose(scratchPosition, IDENTITY_QUAT, scratchScale);
      this.#flareDiscs.setMatrixAt(f, scratchMatrix);
      this.#flareDiscs.setColorAt(f, scratchColor.copy(this.#flareColor).multiplyScalar(flicker));
      scratchPosition.set(flare.x, floor + FLARE_GLOW_LIFT, flare.z);
      scratchScale.set(FLARE_GLOW_SIZE, FLARE_GLOW_SIZE, 1);
      scratchMatrix.compose(scratchPosition, this.#billboard, scratchScale);
      this.#flareGlows.setMatrixAt(f, scratchMatrix);
      this.#flareGlows.setColorAt(f, scratchColor.copy(this.#flareColor).multiplyScalar(FLARE_GLOW_GAIN * flicker));
      f++;
    }
    finish(this.#flareDiscs, f);
    finish(this.#flareGlows, f);
  }

  /** §4.4: emit one burst at `(x, z)`. Never allocates, never throws (19-d). */
  burst(kind: FxKind, x: number, z: number, color: number, scale = 1): void {
    const def = BURSTS[kind];
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    this.#emit(def, x, z, r, g, b, scale, def.count, 1, def.life);
    // SPEC-029 §4.12: a blast carries the death flash too — 4 sprites at ×3.
    if (kind === 'death' || kind === 'blast') {
      this.#emit(def, x, z, r, g, b, scale * 1.4, DEATH_FLASH_COUNT, DEATH_FLASH_GAIN, DEATH_FLASH_LIFE);
    }
    if (kind === 'muzzle') {
      this.#light.color.setRGB(r, g, b);
      this.#light.intensity = MUZZLE_INTENSITY;
      this.#lightFiredAt = this.#time;
      this.#lightX = x;
      this.#lightZ = z;
    }
  }

  /**
   * SPEC-038 §4.1: the dash — three afterimage streaks along the path from
   * `(x, z)` for `distance` m in `(dirX, dirZ)`, drawn once per dash from the
   * same pool (no draw call of its own). The scene skips it under reduce motion.
   */
  dash(x: number, z: number, dirX: number, dirZ: number, distance: number, color: number): void {
    const def = BURSTS.dash;
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    for (let streak = 0; streak < DASH_STREAKS; streak++) {
      const across = (streak - (DASH_STREAKS - 1) / 2) * DASH_STREAK_GAP;
      for (let k = 0; k < DASH_STREAK_SPRITES; k++) {
        const along = ((k + 0.5) / DASH_STREAK_SPRITES) * distance;
        const slot = this.#head;
        this.#head = (this.#head + 1) % this.#capacity;
        this.#x[slot] = x + dirX * along - dirZ * across;
        this.#z[slot] = z + dirZ * along + dirX * across;
        this.#y0[slot] = def.origin - Math.abs(across) * 0.8;
        this.#vx[slot] = -dirX * DASH_DRIFT;
        this.#vy[slot] = 0;
        this.#vz[slot] = -dirZ * DASH_DRIFT;
        this.#gravity[slot] = 0;
        this.#born[slot] = this.#time;
        // The streak's tail fades first: later sprites along the path live longer.
        this.#life[slot] = def.life * (0.55 + (0.45 * (k + 1)) / DASH_STREAK_SPRITES);
        this.#size[slot] = def.size * (0.7 + (0.3 * (k + 1)) / DASH_STREAK_SPRITES);
        this.#r[slot] = r;
        this.#g[slot] = g;
        this.#b[slot] = b;
      }
    }
  }

  /**
   * A scorch decal at `(x, z)`, fading over 20 s; the ring wraps (§4.4).
   * SPEC-029 §4.12: `scale` multiplies the 1.6 m base — `radius / 1.6` for a
   * blast, so the mark is as wide as the blast was.
   */
  scorch(x: number, z: number, scale = 1): void {
    const slot = this.#scorchHead % SCORCH_CAPACITY;
    this.#scorchHead = (this.#scorchHead + 1) % SCORCH_CAPACITY;
    this.#scorchCount = Math.min(SCORCH_CAPACITY, this.#scorchCount + 1);
    this.#scorchX[slot] = x;
    this.#scorchZ[slot] = z;
    this.#scorchBorn[slot] = this.#time;
    this.#scorchScale[slot] = scale;
  }

  #emit(
    def: BurstDef,
    x: number,
    z: number,
    r: number,
    g: number,
    b: number,
    scale: number,
    count: number,
    gain: number,
    life: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const slot = this.#head;
      this.#head = (this.#head + 1) % this.#capacity; // past capacity: the oldest goes
      const speed = def.speedMin + hash01(11, slot, 1) * (def.speedMax - def.speedMin);
      const azimuth =
        def.spread === 'radial' ? (i / count) * Math.PI * 2 : hash01(13, slot, 2) * Math.PI * 2;
      let vx = 0;
      let vy = 0;
      let vz = 0;
      if (def.spread === 'cone') {
        vx = Math.cos(azimuth) * speed * 0.35;
        vy = speed;
        vz = Math.sin(azimuth) * speed * 0.35;
      } else if (def.spread === 'hemisphere') {
        const elevation = hash01(17, slot, 3) * (Math.PI / 2);
        vx = Math.cos(azimuth) * Math.cos(elevation) * speed;
        vy = Math.sin(elevation) * speed;
        vz = Math.sin(azimuth) * Math.cos(elevation) * speed;
      } else if (def.spread === 'outward' || def.spread === 'radial') {
        vx = Math.cos(azimuth) * speed;
        vz = Math.sin(azimuth) * speed;
      } else if (def.spread === 'up') {
        vx = (hash01(19, slot, 4) - 0.5) * 0.6;
        vy = speed;
        vz = (hash01(23, slot, 5) - 0.5) * 0.6;
      }
      this.#x[slot] = x;
      this.#z[slot] = z;
      this.#y0[slot] = def.origin;
      this.#vx[slot] = vx;
      this.#vy[slot] = vy;
      this.#vz[slot] = vz;
      this.#gravity[slot] = def.gravity;
      this.#born[slot] = this.#time;
      this.#life[slot] = life;
      this.#size[slot] = def.size * scale;
      this.#r[slot] = r * gain;
      this.#g[slot] = g * gain;
      this.#b[slot] = b * gain;
    }
  }

  /** Integrate, billboard and fade every live particle — no allocation. */
  sync(time: number, ground: (x: number, z: number) => number): void {
    this.#time = time;
    const mesh = this.#mesh;
    let n = 0;
    for (let slot = 0; slot < this.#capacity; slot++) {
      const age = time - (this.#born[slot] as number);
      const life = this.#life[slot] as number;
      if (age < 0 || age >= life || life <= 0) continue;
      const x = (this.#x[slot] as number) + (this.#vx[slot] as number) * age;
      const z = (this.#z[slot] as number) + (this.#vz[slot] as number) * age;
      const size = this.#size[slot] as number;
      const floor = ground(x, z);
      let y =
        floor +
        (this.#y0[slot] as number) +
        (this.#vy[slot] as number) * age +
        0.5 * (this.#gravity[slot] as number) * age * age;
      const rest = floor + size / 2;
      if (y < rest) y = rest;
      const fade = 1 - age / life;
      scratchPosition.set(x, y, z);
      scratchScale.set(size, size, 1);
      scratchMatrix.compose(scratchPosition, this.#billboard, scratchScale);
      mesh.setMatrixAt(n, scratchMatrix);
      mesh.setColorAt(
        n,
        scratchColor.setRGB((this.#r[slot] as number) * fade, (this.#g[slot] as number) * fade, (this.#b[slot] as number) * fade),
      );
      n++;
    }
    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }

    this.#syncScorches(time, ground);

    // The muzzle pulse: 8 → 0 over 80 ms, driven by view time.
    const lightAge = time - this.#lightFiredAt;
    this.#light.intensity = MUZZLE_INTENSITY * Math.max(0, 1 - lightAge / MUZZLE_DECAY_SECONDS);
    this.#light.position.set(this.#lightX, ground(this.#lightX, this.#lightZ) + MUZZLE_LIGHT_HEIGHT, this.#lightZ);
  }

  #syncScorches(time: number, ground: (x: number, z: number) => number): void {
    const mesh = this.#scorches;
    const count = this.#scorchCount;
    for (let slot = 0; slot < count; slot++) {
      const age = time - (this.#scorchBorn[slot] as number);
      const x = this.#scorchX[slot] as number;
      const z = this.#scorchZ[slot] as number;
      const alive = age >= 0 && age < SCORCH_LIFE;
      // §4.4: the fade is instanceColor darkening; an expired slot collapses
      // to nothing until the ring reuses it.
      const fade = alive ? 1 - age / SCORCH_LIFE : 0;
      const size = SCORCH_SIZE * (this.#scorchScale[slot] as number);
      scratchPosition.set(x, ground(x, z) + SCORCH_LIFT, z);
      scratchScale.set(alive ? size : 0, 1, alive ? size : 0);
      scratchMatrix.compose(scratchPosition, IDENTITY_QUAT, scratchScale);
      mesh.setMatrixAt(slot, scratchMatrix);
      mesh.setColorAt(slot, scratchColor.setScalar(fade));
    }
    mesh.count = count;
    mesh.visible = count > 0;
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.#mesh.parent?.remove(this.#mesh);
    this.#mesh.geometry.dispose();
    this.#material.dispose(); // the sprite map and atlas are shared, session-lifetime
    this.#mesh.dispose();
    this.#scorches.parent?.remove(this.#scorches);
    this.#scorches.geometry.dispose();
    this.#scorchMaterial.dispose();
    this.#scorches.dispose();
    for (const mesh of [this.#clouds, this.#flareDiscs, this.#flareGlows]) {
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.#cloudMaterial.dispose();
    this.#flareDiscMaterial.dispose();
    this.#flareGlowMaterial.dispose(); // the sprite map is shared, session-lifetime
    this.#light.parent?.remove(this.#light);
    this.#light.dispose();
  }
}

const IDENTITY_QUAT = new THREE.Quaternion();

/** SPEC-056: a flat unit disc on XZ, instanced `capacity` times under `parent`, hidden until synced. */
function groundDiscs(material: THREE.MeshBasicMaterial, capacity: number, parent: THREE.Object3D): THREE.InstancedMesh {
  const geometry = new THREE.CircleGeometry(1, 40);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, scratchColor.set('#ffffff'));
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  parent.add(mesh);
  return mesh;
}

/** The instance count drawn, and the upload flags when there is anything to draw. */
function finish(mesh: THREE.InstancedMesh, count: number): void {
  mesh.count = count;
  mesh.visible = count > 0;
  if (count > 0) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }
}
