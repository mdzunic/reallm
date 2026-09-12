// The animated salvager (SPEC-019 §4.1) — a clone of the rigged character
// model (PLAN R7-1), tinted with the save's appearance swatches, driven by the
// pure `core/CharacterState` machine. Read-only over `PlayerEntity`; the scene
// never talks to it directly — `SurfaceView.sync` forwards the frame.
//
// Degraded models never throw (19-a): a model with only an `Idle` clip plays
// `Idle` for every state (one warning per missing clip), and a model with no
// clips at all skips the mixer and stays in its bind pose (one warning).
import * as THREE from 'three';
import {
  characterState,
  createCharacterPrev,
  pickClip,
  type CharacterAnim,
  type CharacterPrev,
} from '@/core/CharacterState';
import { log } from '@/core/Log';
import type { ModelId } from '@/data/assets';
import type { PlayerEntity } from '@/entities/Player';

/** The slice of `Assets` these views need; `Assets` satisfies it (Decisions #4). */
export interface CharacterAssets {
  model(id: ModelId): THREE.Object3D;
  animations(id: ModelId): THREE.AnimationClip[];
}

/** §4.1 (*initial tuning*): crossfade, run-speed mapping, blink opacity. */
const CROSSFADE_SECONDS = 0.12;
const RUN_FULL_SPEED = 6;
const RUN_TIMESCALE_MIN = 0.6;
const RUN_TIMESCALE_MAX = 1.6;
const BLINK_OPACITY = 0.35;

const ANIMS: readonly CharacterAnim[] = ['idle', 'run', 'attack', 'hit', 'death'];

/**
 * §4.1: `color = primary`; `emissive` = the secondary swatch rescaled so its
 * largest channel is 1, at intensity 2 — the visor and lamps glow in the
 * swatch's hue (the swatches are dark; unscaled they would not read). A
 * secondary that is effectively black stays black at intensity 0 (no divide
 * by zero). `CreationScene.#applyTint` calls the same function (AC-24).
 */
export function tintSalvager(material: THREE.MeshStandardMaterial, primary: string, secondary: string): void {
  material.color.set(primary);
  const emissive = material.emissive.set(secondary);
  const brightest = Math.max(emissive.r, emissive.g, emissive.b);
  if (brightest < 1 / 255) {
    emissive.setRGB(0, 0, 0);
    material.emissiveIntensity = 0;
  } else {
    emissive.multiplyScalar(1 / brightest);
    material.emissiveIntensity = 2;
  }
}

export class CharacterView {
  readonly root: THREE.Object3D;
  readonly #prev: CharacterPrev;
  readonly #mixer: THREE.AnimationMixer | null;
  readonly #actions = new Map<CharacterAnim, THREE.AnimationAction>();
  readonly #meshes: THREE.Mesh[] = [];
  /** The per-view material clones — the cached template is never mutated. */
  readonly #materials: THREE.MeshStandardMaterial[] = [];
  #current: THREE.AnimationAction | null = null;
  #shadows: boolean;

  constructor(
    parent: THREE.Object3D,
    assets: CharacterAssets,
    modelId: ModelId,
    appearance: { primary: string; secondary: string },
    shadows: boolean,
  ) {
    this.root = assets.model(modelId);
    this.#shadows = shadows;
    this.#prev = createCharacterPrev({ alive: true, vx: 0, vz: 0, hp: 1, fireCooldown: 0 });

    // Clone every material once (AC-25) so the tint and the blink never touch
    // the cached template; `transparent` stays on for the opacity blink.
    this.root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      this.#meshes.push(mesh);
      const source = mesh.material;
      const clones = (Array.isArray(source) ? source : [source]).map((entry) =>
        (entry as THREE.MeshStandardMaterial).clone(),
      );
      for (const clone of clones) {
        clone.transparent = true;
        tintSalvager(clone, appearance.primary, appearance.secondary);
        this.#materials.push(clone);
      }
      mesh.material = Array.isArray(source) ? clones : (clones[0] as THREE.MeshStandardMaterial);
    });

    // §4.1: resolve all five clips once. A missing clip warns and falls back
    // to the resolved idle; no idle at all skips the mixer entirely (19-a).
    const clips = assets.animations(modelId);
    const names = clips.map((clip) => clip.name);
    const idleName = pickClip(names, 'idle');
    if (idleName === null) {
      this.#mixer = null;
      log.warn('view', `character model "${modelId}" has no usable idle clip; staying in the bind pose`);
    } else {
      const mixer = new THREE.AnimationMixer(this.root);
      this.#mixer = mixer;
      const idleClip = clips.find((clip) => clip.name === idleName) as THREE.AnimationClip;
      for (const anim of ANIMS) {
        const name = anim === 'idle' ? idleName : pickClip(names, anim);
        if (name === null) log.warn('view', `character clip for "${anim}" missing; falling back to "${idleName}"`);
        const clip = name === null ? idleClip : (clips.find((entry) => entry.name === name) as THREE.AnimationClip);
        const action = mixer.clipAction(clip);
        // §4.1: attack and hit play once and clamp; death plays once and
        // holds. Only on the anim's own clip — a shared idle fallback loops.
        if (clip !== idleClip && (anim === 'attack' || anim === 'hit' || anim === 'death')) {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
        }
        this.#actions.set(anim, action);
      }
      this.#play('idle', 1);
    }

    parent.add(this.root);
  }

  /** Position, facing, animation and the invulnerability blink, per frame. */
  sync(player: PlayerEntity, time: number, dt: number, y: number): void {
    this.root.position.set(player.x, y, player.z);
    // The model's front faces +Z (PLAN R7-1); facing is θ from +X toward +Z.
    this.root.rotation.y = Math.PI / 2 - player.facing;

    for (const mesh of this.#meshes) {
      mesh.castShadow = this.#shadows;
      mesh.receiveShadow = this.#shadows;
    }

    const anim = characterState(this.#prev, player, time);
    if (this.#mixer !== null) {
      const speed = Math.hypot(player.vx, player.vz) / RUN_FULL_SPEED;
      this.#play(anim, Math.min(RUN_TIMESCALE_MAX, Math.max(RUN_TIMESCALE_MIN, speed)));
      this.#mixer.update(dt);
    }

    // The current blink rule, now on the clones (AC-26).
    const blinking = player.invulnUntil > time && Math.sin(time * 30) > 0;
    const opacity = blinking ? BLINK_OPACITY : 1;
    for (const material of this.#materials) material.opacity = opacity;
  }

  /** SPEC-017 §4.8: a preset change flips the shadow map while the surface is up. */
  setShadows(enabled: boolean): void {
    this.#shadows = enabled;
    for (const mesh of this.#meshes) {
      mesh.castShadow = enabled;
      mesh.receiveShadow = enabled;
    }
  }

  #play(anim: CharacterAnim, runTimescale: number): void {
    const action = this.#actions.get(anim);
    if (action === undefined) return;
    if (anim === 'run') action.timeScale = runTimescale;
    if (action === this.#current) return;
    const previous = this.#current;
    action.reset().play();
    if (previous !== null) action.crossFadeFrom(previous, CROSSFADE_SECONDS, false);
    this.#current = action;
  }

  dispose(): void {
    this.#mixer?.stopAllAction();
    this.root.parent?.remove(this.root);
    // The clones inherited the template's `shared` tag, so `disposeObject3D`
    // would walk past them — they are this view's own and are freed by hand.
    // Geometry and textures stay with the cache (D-33).
    for (const material of this.#materials) material.dispose();
    this.#materials.length = 0;
  }
}
