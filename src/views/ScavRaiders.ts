// Cinder-4's scav raiders in the salvager's suit (SPEC-064, PLAN R25). The only
// human enemy is drawn from `character.glb` — the model the dying scavenger and
// SPEC-048's bodies already wear — in the bodies' dusty tint, holding the rifle
// the model already holds. It aims through a windup while a glint grows at the
// muzzle, recoils as the shot leaves, flinches on a hit, and falls: Death once,
// a fade, gone, so the only bodies that stay are SPEC-048's.
//
// To everything but its look a raider is still an instanced enemy: the
// simulation, the elite plates and the blob shadows read the entity. Every cue
// `EnemyMeshes` writes per instance — the flash, the elite gold, the
// invulnerable dimming, the hostile rim and the rim below — is written here on
// the clone's own material instead. The one it does not wear is the 1.15×
// windup swell: the aim and the glint telegraph the same windup (§2).
//
// At most `RAIDER_POOL` clones are skinned, falling copies included. They are
// built on first use and kept, so steady play allocates nothing per frame. A
// raider this view cannot place — the pool full, or a model with no skin — is
// left out of the set `sync` returns, and `EnemyMeshes` draws it as the
// procedural `scav` stand-in (E113, E114).
import * as THREE from 'three';
import { pickClip, type CharacterAnim } from '@/core/CharacterState';
import { log } from '@/core/Log';
import type { Pool } from '@/core/Pool';
import { isBuried, type BrainState, type EnemyEntity } from '@/entities/Enemy';
import {
  CROSSFADE_SECONDS,
  RUN_FULL_SPEED,
  RUN_TIMESCALE_MAX,
  RUN_TIMESCALE_MIN,
  tintSalvager,
  type CharacterAssets,
} from '@/views/CharacterView';
import {
  ELITE_GOLD,
  ELITE_SCALE,
  ELITE_TINT,
  FLASH_EMISSIVE,
  FLASH_RIM_SCALE,
  HOSTILE_RIM_UNIFORM,
  hostileRimChunk,
  TINT_EMISSIVE,
} from '@/views/ProceduralMeshes';
import { particleSprite } from '@/views/ProceduralTextures';
import { SCAV_BODY_TINT } from '@/views/ScavBody';

/** §3: the most raiders skinned at once, live and falling together. */
export const RAIDER_POOL = 8;
/** §3: the falling copy's fade, in seconds, after Death's 1.2 s. */
export const RAIDER_FADE = 0.4;
/** §3: a raider's tracer — amber gunfire where the spitters spit green. */
export const RAIDER_TRACER = '#ffc27a';
/** §3: the rifle's muzzle in glTF model space (× scale) — where the Attack clip's first frame holds it. */
export const RAIDER_MUZZLE = { x: -0.12, y: 1.12, z: 0.925 } as const;

export interface RaiderPose {
  anim: CharacterAnim; // 'idle' | 'run' | 'attack' | 'hit'
  hold: boolean; // attack held on its first frame (the aim)
  restart: boolean; // play `anim` from its start this frame
  timeScale: number;
}

/** §4.3: a ground speed above this runs, in m/s. */
const RUN_SPEED = 0.2;
/**
 * SPEC-038 §4.3, restated because views may not import `systems/`: a ranged
 * windup lasts 0.5 s × its multipliers — the enemy's `windupScale` and the
 * world's `windupMult`, which the scene hands in.
 */
const RAIDER_WINDUP = 0.5;
/** Death's length on a model that has no Death clip: the fall still runs its course, in the pose it died in. */
const RAIDER_DEATH = 1.2;
/** Float drift in summed frame deltas must not keep a finished copy one frame longer. */
const FALL_EPSILON = 1e-6;
/** §4.3: the glint is 0.06 m across, in the tracer's amber, bright enough to catch the bloom (*initial tuning*). */
const GLINT_SIZE = 0.06;
const GLINT_GAIN = 3;
/** §4.4: every raider material compiles to one program. */
const RAIDER_PROGRAM = 'raider/1';
/** A clone's bounding sphere, as a share of the model's height — wide enough for a body lying in any direction. */
const BOUNDS_PER_HEIGHT = 1.5;
/** At most this many raiders wait for a slot in one frame; the rest are stand-ins. */
const WAITING_CAPACITY = 64;

const ANIMS: readonly CharacterAnim[] = ['idle', 'run', 'attack', 'hit', 'death'];

const FLASH_COLOR = new THREE.Color('#ffffff');
const ELITE_COLOR = new THREE.Color(ELITE_TINT);
/** §4.4: "the tinted material's own colour" — what `tintSalvager` gave every clone. */
const SUIT_COLOR = new THREE.Color(SCAV_BODY_TINT.primary);
const GLINT_COLOR = new THREE.Color(RAIDER_TRACER).multiplyScalar(GLINT_GAIN);
const scratchColor = new THREE.Color();

/**
 * Pure (§4.3): the clip for a live raider this frame, given its last frame's
 * state. In priority order: a new hit flinches; a windup holds the aim; the
 * frame the windup ends in anything but death is the recoil; moving runs at
 * `speed / 6`, clamped 0.6–1.6; anything else idles. `out` is written and
 * returned, so the per-frame caller allocates nothing.
 */
export function raiderPose(
  now: { state: BrainState; speed: number; hitFlash: number }, // speed = Math.hypot(e.vx, e.vz), the ground speed now
  prev: { state: BrainState; hitFlash: number } | null,
  out: RaiderPose = { anim: 'idle', hold: false, restart: false, timeScale: 1 },
): RaiderPose {
  out.hold = false;
  out.restart = false;
  out.timeScale = 1;
  if (now.hitFlash > 0 && (prev === null || prev.hitFlash <= 0)) {
    out.anim = 'hit';
    out.restart = true;
  } else if (now.state === 'windup') {
    out.anim = 'attack';
    out.hold = true;
  } else if (prev !== null && prev.state === 'windup' && now.state !== 'dead') {
    // The recoil: the shot left this step.
    out.anim = 'attack';
    out.restart = true;
  } else if (now.speed > RUN_SPEED) {
    out.anim = 'run';
    out.timeScale = Math.min(RUN_TIMESCALE_MAX, Math.max(RUN_TIMESCALE_MIN, now.speed / RUN_FULL_SPEED));
  } else {
    out.anim = 'idle';
  }
  return out;
}

/** The per-clone values the injected chunk reads (§4.4). */
interface RaiderUniforms {
  /** Added after the emissive map: the flash, or the elite's glow; black otherwise. */
  readonly emissive: { value: THREE.Color };
  /** The hostile rim's scale: 1, `FLASH_RIM_SCALE` while flashing, × `rimOf` below. */
  readonly rimScale: { value: number };
}

/**
 * §4.4: the clone's material, patched like `EnemyMeshes`' — the per-raider
 * emissive lands after the model's emissive map, then the shared rim on top —
 * with its per-material uniforms in place of the per-instance attribute.
 */
function injectRaiderCues(material: THREE.MeshStandardMaterial, uniforms: RaiderUniforms): void {
  material.onBeforeCompile = (shader) => {
    // SPEC-045 §4.5: the shared rim colour itself, so the colour-blind preset reaches the raiders too.
    shader.uniforms['uHostileRim'] = HOSTILE_RIM_UNIFORM;
    shader.uniforms['uRaiderEmissive'] = uniforms.emissive;
    shader.uniforms['uRimScale'] = uniforms.rimScale;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'uniform vec3 uHostileRim;\nuniform vec3 uRaiderEmissive;\nuniform float uRimScale;\n#include <common>')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\ntotalEmissiveRadiance += uRaiderEmissive;${hostileRimChunk('uRimScale')}`,
      );
  };
  material.customProgramCacheKey = () => RAIDER_PROGRAM;
}

type SlotMode = 'free' | 'live' | 'falling';

/** One pooled clone — a live raider's, a falling copy's, or free. */
interface RaiderSlot {
  readonly root: THREE.Object3D;
  readonly meshes: readonly THREE.Mesh[];
  /** Its own material clones; the cached template is never written. */
  readonly materials: readonly THREE.MeshStandardMaterial[];
  readonly uniforms: RaiderUniforms;
  readonly glint: THREE.Sprite;
  readonly glintMaterial: THREE.SpriteMaterial;
  readonly mixer: THREE.AnimationMixer | null;
  /** Each animation's own action; `null` where the model has no such clip. */
  readonly actions: Record<CharacterAnim, THREE.AnimationAction | null>;
  current: THREE.AnimationAction | null;
  /** The hit or recoil playing out: until it finishes, only a restart replaces it (§4.3). */
  oneShot: THREE.AnimationAction | null;
  mode: SlotMode;
  /** The enemy it draws, or falls for; −1 when free. */
  id: number;
  /** Placed this `sync`. */
  seen: boolean;
  /** The last frame's state and flash, for `raiderPose`; read only while `hasPrev`. */
  readonly prev: { state: BrainState; hitFlash: number };
  hasPrev: boolean;
  /** What the resting cues were last written from, kept for the fall. */
  tint: string;
  elite: boolean;
  rimBelow: number;
  /** Seconds since the fall began, the Death clip's length, and the fall's order (oldest first). */
  fallAge: number;
  fallLength: number;
  fallOrder: number;
}

export class ScavRaiderViews {
  readonly #root = new THREE.Group();
  readonly #assets: CharacterAssets;
  #shadows: boolean;
  /** §4.2: the five clips, resolved once by `pickClip` and shared by every clone. */
  readonly #clips: Record<CharacterAnim, THREE.AnimationClip | null> = {
    idle: null,
    run: null,
    attack: null,
    hit: null,
    death: null,
  };
  readonly #slots: RaiderSlot[] = [];
  /** The live raiders' slots, by enemy id. */
  readonly #live = new Map<number, RaiderSlot>();
  /** What `sync` returns: the ids drawn here, kept in step with `#live` rather than rebuilt. */
  readonly #placed = new Set<number>();
  /** Pool indices of the raiders waiting for a slot this frame. */
  readonly #waiting = new Int32Array(WAITING_CAPACITY);
  /** False once the model turned out to hold no skinned mesh: then every raider is a stand-in. */
  #usable = true;
  #fallClock = 0;
  readonly #now: { state: BrainState; speed: number; hitFlash: number } = { state: 'idle', speed: 0, hitFlash: 0 };
  readonly #pose: RaiderPose = { anim: 'idle', hold: false, restart: false, timeScale: 1 };
  /** §4.4: an elite's colour and glow, per tint — worked out once, never per frame. */
  readonly #eliteCues = new Map<string, { color: THREE.Color; emissive: THREE.Color }>();

  /** §4.5: `tracers` is written by `SurfaceView`'s shot pass; the rest by `sync`. */
  readonly counts = { live: 0, falling: 0, standIn: 0, tracers: 0 };
  /**
   * SPEC-054 §4.6, as `EnemyMeshes.rimOf`: what multiplies each raider's rim
   * scale below; `null` reads as ×1. `SurfaceView` hands the enemies' own in
   * every frame, so the scene sets one, not two.
   */
  rimOf: ((e: EnemyEntity) => number) | null = null;
  /** SPEC-038 §4.6: the world's windup multiplier (casual 1.25), so the glint spans the whole windup. */
  windupMult = 1;
  /**
   * §4.3: the muzzle flash, at the muzzle's world `(x, z)`, the frame a windup
   * ends in a shot — `SurfaceView` bursts `CombatFx`'s `'muzzle'` there.
   */
  onMuzzle: ((x: number, z: number) => void) | null = null;

  /** `assets` is the slice of `Assets` the clones need; `Assets` itself satisfies it. */
  constructor(root: THREE.Object3D, assets: CharacterAssets, opts: { shadows: boolean }) {
    this.#assets = assets;
    this.#shadows = opts.shadows;
    this.#root.name = 'scav-raiders';
    root.add(this.#root);
    const clips = assets.animations('character');
    const names = clips.map((clip) => clip.name);
    for (const anim of ANIMS) {
      const name = pickClip(names, anim);
      const clip = name === null ? undefined : clips.find((entry) => entry.name === name);
      if (clip === undefined) log.warn('view', `the scav raiders have no "${anim}" clip`);
      this.#clips[anim] = clip ?? null;
    }
  }

  /**
   * §4.2: places every live `scav` enemy it can and returns the ids it placed,
   * for `EnemyMeshes` to skip. Mixers advance by `dt` — the render delta, 0
   * through hit-stop. Allocates nothing once the pool is built.
   */
  sync(
    enemies: Pool<EnemyEntity>,
    dt: number,
    _time: number, // the view clock: unused, the mixers run on `dt`
    ground: (x: number, z: number) => number,
  ): ReadonlySet<number> {
    const slots = this.#slots;
    for (let s = 0; s < slots.length; s++) (slots[s] as RaiderSlot).seen = false;

    // The raiders that hold a slot are placed again; the rest wait their turn.
    let waiting = 0;
    let standIn = 0;
    for (let i = 0; i < enemies.size; i++) {
      const e = enemies.at(i);
      // As `EnemyMeshes`: the dead and the buried draw nothing.
      if (e.def.look.recipe !== 'scav' || e.state === 'dead' || isBuried(e)) continue;
      const slot = this.#live.get(e.id);
      if (slot !== undefined) {
        slot.seen = true;
        this.#place(slot, e, dt, ground);
      } else if (this.#usable && waiting < WAITING_CAPACITY) {
        this.#waiting[waiting++] = i;
      } else {
        standIn++;
      }
    }

    // 64-a: a raider dismissed, despawned or dead without a fall frees its slot at once.
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s] as RaiderSlot;
      if (slot.mode === 'live' && !slot.seen) this.#release(slot);
    }

    // E114: newcomers take slots oldest first, so past the pool the newest are the stand-ins.
    this.#sortWaiting(enemies, waiting);
    for (let k = 0; k < waiting; k++) {
      const e = enemies.at(this.#waiting[k] as number);
      const slot = this.#acquire();
      if (slot === null) {
        standIn++;
        continue;
      }
      slot.mode = 'live';
      slot.id = e.id;
      slot.hasPrev = false;
      slot.seen = true;
      this.#live.set(e.id, slot);
      this.#placed.add(e.id);
      this.#place(slot, e, dt, ground);
    }

    // §4.5: the falling copies run their course.
    let live = 0;
    let falling = 0;
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s] as RaiderSlot;
      if (slot.mode === 'falling') this.#stepFall(slot, dt);
      if (slot.mode === 'live') live++;
      else if (slot.mode === 'falling') falling++;
    }
    this.counts.live = live;
    this.counts.falling = falling;
    this.counts.standIn = standIn;
    return this.#placed;
  }

  /**
   * §4.5: a raider died at its last pose — its clone becomes a falling copy
   * that crossfades into Death from wherever it was (E115), takes nothing more
   * from the simulation, fades after Death's length and frees its slot. An id
   * with no clone (a stand-in, or one already falling) changes nothing.
   */
  fall(id: number): void {
    const slot = this.#live.get(id);
    if (slot === undefined) return;
    this.#live.delete(id);
    this.#placed.delete(id);
    slot.mode = 'falling';
    slot.fallAge = 0;
    slot.fallOrder = this.#fallClock++;
    slot.glint.visible = false;
    // The fight's transient cues end with it: no flash or dimming on the way down.
    this.#writeCues(slot, slot.tint, false, slot.elite, false, slot.rimBelow);
    const death = slot.actions.death;
    slot.fallLength = death === null ? RAIDER_DEATH : death.getClip().duration;
    slot.oneShot = null;
    if (death !== null) this.#start(slot, death, false);
  }

  /** SPEC-017 §4.8: a preset change flips the shadow map while the surface is up. */
  setShadows(enabled: boolean): void {
    this.#shadows = enabled;
    for (const slot of this.#slots) {
      for (const mesh of slot.meshes) {
        mesh.castShadow = enabled;
        mesh.receiveShadow = enabled;
      }
    }
  }

  dispose(): void {
    this.#root.parent?.remove(this.#root);
    for (const slot of this.#slots) {
      slot.mixer?.stopAllAction();
      // The clones carry the template's `shared` tag, so `disposeObject3D`
      // would walk past them — they are this view's own (ScavBody does the same).
      for (const material of slot.materials) material.dispose();
      // The glint's map is the shared particle sprite, which stays.
      slot.glintMaterial.dispose();
      // SPEC-040 AC-27: each clone's skeleton holds a bone texture of its own.
      for (const mesh of slot.meshes) {
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh === true) (mesh as THREE.SkinnedMesh).skeleton?.dispose();
      }
    }
    this.#slots.length = 0;
    this.#live.clear();
    this.#placed.clear();
  }

  // ------------------------------------------------------------- per raider

  /** §4.2–§4.4: transform, cues, clip, muzzle flash and glint for one live raider. */
  #place(slot: RaiderSlot, e: EnemyEntity, dt: number, ground: (x: number, z: number) => number): void {
    const root = slot.root;
    root.visible = true;
    root.position.set(e.x, ground(e.x, e.z), e.z);
    // The model's front faces +Z (PLAN R7-1); facing is θ from +X toward +Z.
    root.rotation.y = Math.PI / 2 - e.facing;
    // §4.4: the elite's 1.3, and never the windup swell.
    const scale = e.def.look.scale * (e.elite ? ELITE_SCALE : 1);
    root.scale.setScalar(scale);
    this.#writeCues(slot, e.def.look.tint, e.hitFlash > 0, e.elite, e.invulnerable, this.rimOf === null ? 1 : this.rimOf(e));

    const now = this.#now;
    now.state = e.state;
    now.speed = Math.hypot(e.vx, e.vz);
    now.hitFlash = e.hitFlash;
    const prev = slot.hasPrev ? slot.prev : null;
    this.#animate(slot, raiderPose(now, prev, this.#pose));

    // §4.3: the windup ended in a shot — the flash at the rifle, once per
    // windup however many shots a volley fires (64-c). Tied to the windup's
    // end rather than to the recoil row, so a flinch the same frame keeps it.
    if (prev !== null && prev.state === 'windup' && e.state !== 'windup' && this.onMuzzle !== null) {
      const cos = Math.cos(root.rotation.y);
      const sin = Math.sin(root.rotation.y);
      const mx = RAIDER_MUZZLE.x * scale;
      const mz = RAIDER_MUZZLE.z * scale;
      this.onMuzzle(e.x + mx * cos + mz * sin, e.z - mx * sin + mz * cos);
    }

    // §4.3: the glint grows from nothing to full over the windup, and is hidden otherwise.
    if (e.state === 'windup') {
      const length = RAIDER_WINDUP * e.windupScale * this.windupMult;
      slot.glintMaterial.opacity = length > 0 ? Math.min(1, Math.max(0, e.stateTime / length)) : 1;
      slot.glint.visible = true;
    } else {
      slot.glint.visible = false;
    }

    slot.mixer?.update(dt);
    slot.prev.state = e.state;
    slot.prev.hitFlash = e.hitFlash;
    slot.hasPrev = true;
  }

  /**
   * §4.3's clip rules. A restart plays its clip from the start, crossfading
   * from whatever was on. A hit or a recoil that has not finished keeps
   * playing through everything else. The aim holds Attack's first frame. Run
   * and idle loop, crossfading in when they change. An animation the model has
   * no clip for plays idle.
   */
  #animate(slot: RaiderSlot, pose: RaiderPose): void {
    if (slot.mixer === null) return;
    const own = slot.actions[pose.anim];
    if (own !== null && pose.restart) {
      this.#start(slot, own, false);
      slot.oneShot = own;
      return;
    }
    if (slot.oneShot !== null && slot.oneShot.isRunning()) return;
    slot.oneShot = null;
    if (own !== null && pose.hold) {
      if (slot.current !== own || !own.paused || own.time !== 0) this.#start(slot, own, true);
      return;
    }
    const action = own ?? slot.actions.idle;
    if (action === null) return;
    action.timeScale = action === slot.actions.run ? pose.timeScale : 1;
    if (action !== slot.current) this.#start(slot, action, false);
  }

  /** From the first frame — held there when `held` — crossfading from the current action (0.12 s, as `CharacterView`). */
  #start(slot: RaiderSlot, action: THREE.AnimationAction, held: boolean): void {
    const previous = slot.current;
    action.reset();
    action.play();
    action.paused = held;
    if (previous !== null && previous !== action) action.crossFadeFrom(previous, CROSSFADE_SECONDS, false);
    slot.current = action;
  }

  /**
   * §4.4: `EnemyMeshes`' per-instance values on the clone. Colour: white while
   * flashing, an elite's tint halfway to gold, else the suit; × 0.5 while
   * invulnerable. Emissive: the flash's 2.5, an elite's tint × 0.15 plus gold,
   * else black (the visor stays dark); × 0.5 while invulnerable. The rim:
   * `FLASH_RIM_SCALE` while flashing, × `rimBelow`.
   */
  #writeCues(slot: RaiderSlot, tint: string, flash: boolean, elite: boolean, invulnerable: boolean, rimBelow: number): void {
    slot.tint = tint;
    slot.elite = elite;
    slot.rimBelow = rimBelow;
    const eliteCues = elite ? this.#eliteCuesOf(tint) : null;
    const color = scratchColor;
    if (flash) color.copy(FLASH_COLOR);
    else if (eliteCues !== null) color.copy(eliteCues.color);
    else color.copy(SUIT_COLOR);
    if (invulnerable) color.multiplyScalar(0.5);
    for (const material of slot.materials) material.color.copy(color);

    const emissive = slot.uniforms.emissive.value;
    if (flash) emissive.setRGB(FLASH_EMISSIVE, FLASH_EMISSIVE, FLASH_EMISSIVE);
    else if (eliteCues !== null) emissive.copy(eliteCues.emissive);
    else emissive.setRGB(0, 0, 0);
    if (invulnerable) emissive.multiplyScalar(0.5);
    slot.uniforms.rimScale.value = (flash ? FLASH_RIM_SCALE : 1) * rimBelow;
  }

  #eliteCuesOf(tint: string): { color: THREE.Color; emissive: THREE.Color } {
    let cues = this.#eliteCues.get(tint);
    if (cues === undefined) {
      const emissive = new THREE.Color(tint).multiplyScalar(TINT_EMISSIVE);
      emissive.r += ELITE_GOLD[0];
      emissive.g += ELITE_GOLD[1];
      emissive.b += ELITE_GOLD[2];
      cues = { color: new THREE.Color(tint).lerp(ELITE_COLOR, 0.5), emissive };
      this.#eliteCues.set(tint, cues);
    }
    return cues;
  }

  /** §4.5: Death plays out, then the copy fades over `RAIDER_FADE` and frees its slot. */
  #stepFall(slot: RaiderSlot, dt: number): void {
    slot.fallAge += dt;
    slot.mixer?.update(dt);
    const fadeFrom = slot.fallLength;
    if (slot.fallAge >= fadeFrom + RAIDER_FADE - FALL_EPSILON) {
      this.#release(slot);
      return;
    }
    const opacity = slot.fallAge <= fadeFrom ? 1 : 1 - (slot.fallAge - fadeFrom) / RAIDER_FADE;
    for (const material of slot.materials) material.opacity = opacity;
  }

  // ------------------------------------------------------------- the pool

  /** A free slot; else a new clone while the pool has room; else the oldest falling copy's (E114); else none. */
  #acquire(): RaiderSlot | null {
    if (!this.#usable) return null;
    const slots = this.#slots;
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s] as RaiderSlot;
      if (slot.mode === 'free') return slot;
    }
    if (slots.length < RAIDER_POOL) return this.#grow();
    let oldest: RaiderSlot | null = null;
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s] as RaiderSlot;
      if (slot.mode === 'falling' && (oldest === null || slot.fallOrder < oldest.fallOrder)) oldest = slot;
    }
    if (oldest !== null) this.#release(oldest);
    return oldest;
  }

  /** Back to the pool: hidden, its clips stopped, its opacity whole again. */
  #release(slot: RaiderSlot): void {
    if (slot.mode === 'live') {
      this.#live.delete(slot.id);
      this.#placed.delete(slot.id);
    }
    slot.mode = 'free';
    slot.id = -1;
    slot.hasPrev = false;
    slot.root.visible = false;
    slot.glint.visible = false;
    slot.mixer?.stopAllAction();
    slot.current = null;
    slot.oneShot = null;
    for (const material of slot.materials) material.opacity = 1;
  }

  /** Insertion sort of the waiting pool indices by enemy id — ids rise with spawn order. */
  #sortWaiting(enemies: Pool<EnemyEntity>, count: number): void {
    const waiting = this.#waiting;
    for (let k = 1; k < count; k++) {
      const index = waiting[k] as number;
      const id = enemies.at(index).id;
      let j = k - 1;
      while (j >= 0 && enemies.at(waiting[j] as number).id > id) {
        waiting[j + 1] = waiting[j] as number;
        j--;
      }
      waiting[j + 1] = index;
    }
  }

  /**
   * §4.2: one more clone — `assets.model('character')`, its materials cloned,
   * made transparent so a falling copy can fade, tinted as `ScavBody` tints
   * its body and patched for the cues; one mixer over the shared clips; the
   * glint at the muzzle. `null`, once and for good, when the model holds no
   * skinned mesh: a raider that cannot aim, flinch or fall stays the stand-in.
   */
  #grow(): RaiderSlot | null {
    const root = this.#assets.model('character');
    root.name = 'scav_raider';
    const meshes: THREE.Mesh[] = [];
    const materials: THREE.MeshStandardMaterial[] = [];
    const uniforms: RaiderUniforms = { emissive: { value: new THREE.Color(0, 0, 0) }, rimScale: { value: 1 } };
    let skinned = false;
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      meshes.push(mesh);
      const source = mesh.material;
      const clones = (Array.isArray(source) ? source : [source]).map((entry) => (entry as THREE.MeshStandardMaterial).clone());
      for (const clone of clones) {
        clone.transparent = true;
        tintSalvager(clone, SCAV_BODY_TINT.primary, SCAV_BODY_TINT.secondary);
        injectRaiderCues(clone, uniforms);
        materials.push(clone);
      }
      mesh.material = Array.isArray(source) ? clones : (clones[0] as THREE.MeshStandardMaterial);
      mesh.castShadow = this.#shadows;
      mesh.receiveShadow = this.#shadows;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh !== true) return;
      skinned = true;
      // Three works a skinned mesh's bounds out once, from the first pose it
      // draws in, which a body lying where Death leaves it outgrows. One
      // sphere about the bind pose's middle covers standing, aiming and lying
      // in any direction, and costs no CPU skinning pass.
      const geometry = mesh.geometry;
      if (geometry.boundingBox === null) geometry.computeBoundingBox();
      const box = geometry.boundingBox as THREE.Box3;
      const centre = box.getCenter(new THREE.Vector3());
      (mesh as THREE.SkinnedMesh).boundingSphere = new THREE.Sphere(centre, (box.max.y - box.min.y) * BOUNDS_PER_HEIGHT);
    });
    if (!skinned) {
      for (const material of materials) material.dispose();
      this.#usable = false;
      log.warn('view', 'the character model holds no skinned mesh; the scav raiders stay procedural');
      return null;
    }

    let mixer: THREE.AnimationMixer | null = null;
    const actions: Record<CharacterAnim, THREE.AnimationAction | null> = {
      idle: null,
      run: null,
      attack: null,
      hit: null,
      death: null,
    };
    if (ANIMS.some((anim) => this.#clips[anim] !== null)) {
      mixer = new THREE.AnimationMixer(root);
      for (const anim of ANIMS) {
        const clip = this.#clips[anim];
        if (clip === null) continue;
        const action = mixer.clipAction(clip);
        // §4.3: attack, hit and death play once and clamp.
        if (anim === 'attack' || anim === 'hit' || anim === 'death') {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
        }
        actions[anim] = action;
      }
    }

    // §4.3: the glint rides the clone's frame, so it stands at the muzzle at
    // the clone's scale.
    const glintMaterial = new THREE.SpriteMaterial({
      map: particleSprite('dot'),
      color: GLINT_COLOR,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0,
    });
    const glint = new THREE.Sprite(glintMaterial);
    glint.name = 'muzzle_glint';
    glint.position.set(RAIDER_MUZZLE.x, RAIDER_MUZZLE.y, RAIDER_MUZZLE.z);
    glint.scale.setScalar(GLINT_SIZE);
    glint.visible = false;
    root.add(glint);

    root.visible = false;
    this.#root.add(root);
    const slot: RaiderSlot = {
      root,
      meshes,
      materials,
      uniforms,
      glint,
      glintMaterial,
      mixer,
      actions,
      current: null,
      oneShot: null,
      mode: 'free',
      id: -1,
      seen: false,
      prev: { state: 'idle', hitFlash: 0 },
      hasPrev: false,
      tint: SCAV_BODY_TINT.primary,
      elite: false,
      rimBelow: 1,
      fallAge: 0,
      fallLength: RAIDER_DEATH,
      fallOrder: 0,
    };
    this.#slots.push(slot);
    return slot;
  }
}
