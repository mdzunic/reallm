// The scavenger bodies (SPEC-048 §4.8). The scavengers were voices from empty
// sand; now one lies by Cinder-4's pad while `c1_m1` runs, and when the second
// scav repeats the first one's warning (`c1_s2_echo`) an identical body lies
// beside the player. The second body being the same body is the clue.
//
// A body is a view, not an entity: nothing to fight, collide with or update.
// It is a clone of the salvager model (SPEC-019) in the scav tint — a black
// secondary leaves the visor dark — posed once on the last frame of its
// `Death` clip by a throwaway mixer, and never touched again. One skinned mesh,
// one material: one draw call and 2 616 triangles.
import * as THREE from 'three';
import { pickClip } from '@/core/CharacterState';
import { log } from '@/core/Log';
import { tintSalvager, type CharacterAssets } from '@/views/CharacterView';

/** §3: the scav's dusty suit; the black secondary leaves the visor unlit. */
export const SCAV_BODY_TINT = { primary: '#4f4a3d', secondary: '#000000' } as const;
/** §3 (*initial tuning*): the pad body, from the pad's centre — 5.4 m, outside SPEC-046's 3.5 m tug. */
export const SCAV_PAD_OFFSET = { x: -5, z: 2 } as const;
/** §3: how far from the player the echo body lies, in metres. */
export const SCAV_ECHO_DISTANCE = 6;
/** §3: the circle the echo body's spot must keep clear, in metres (placement only — it has no collision). */
export const SCAV_BODY_RADIUS = 0.6;

/** §4.8: the eight bearings `echoBodySpot` tries, 45° apart. */
const ECHO_BEARINGS = 8;

export class ScavBody {
  readonly root: THREE.Object3D;
  /** The `Death` clip's duration the pose was taken at, or null when the model has none (bind pose). */
  readonly posedAt: number | null;
  readonly #meshes: THREE.Mesh[] = [];
  /** The per-body material clones — the cached template is never written. */
  readonly #materials: THREE.MeshStandardMaterial[] = [];

  /**
   * `y` is the ground height at `(x, z)`; `facing` is θ from +X toward +Z, as
   * every entity's is, and the model's front faces +Z (PLAN R7-1).
   */
  constructor(
    parent: THREE.Object3D,
    assets: CharacterAssets,
    x: number,
    z: number,
    facing: number,
    shadows: boolean,
    y = 0,
  ) {
    this.root = assets.model('character');
    this.root.name = 'scav_body';
    this.root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      this.#meshes.push(mesh);
      const source = mesh.material;
      const clones = (Array.isArray(source) ? source : [source]).map((entry) => (entry as THREE.MeshStandardMaterial).clone());
      for (const clone of clones) {
        tintSalvager(clone, SCAV_BODY_TINT.primary, SCAV_BODY_TINT.secondary);
        this.#materials.push(clone);
      }
      mesh.material = Array.isArray(source) ? clones : (clones[0] as THREE.MeshStandardMaterial);
    });

    // §4.8: the last frame of `Death`, once. The action is never stopped — a
    // stop would hand the bones back their bind pose — and the mixer is simply
    // dropped: nothing holds it, and nothing updates the body again.
    const clips = assets.animations('character');
    const name = pickClip(
      clips.map((clip) => clip.name),
      'death',
    );
    const clip = name === null ? undefined : clips.find((entry) => entry.name === name);
    if (clip === undefined) {
      this.posedAt = null;
      log.warn('view', 'the scav body has no death clip; it stays in the bind pose');
    } else {
      const mixer = new THREE.AnimationMixer(this.root);
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
      mixer.setTime(clip.duration);
      this.posedAt = mixer.time;
    }

    this.root.position.set(x, y, z);
    this.root.rotation.y = Math.PI / 2 - facing;
    this.setShadows(shadows);
    parent.add(this.root);
  }

  /** As `CharacterView`'s: a shadow caster on `high` only, following a preset change. */
  setShadows(enabled: boolean): void {
    for (const mesh of this.#meshes) {
      mesh.castShadow = enabled;
      mesh.receiveShadow = enabled;
    }
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    // The clones carry the template's `shared` tag, so `disposeObject3D` would
    // walk past them — they are this body's own (CharacterView does the same).
    for (const material of this.#materials) material.dispose();
    this.#materials.length = 0;
    // SPEC-040 AC-27: the cloned skeleton's bone texture is ours to free.
    for (const mesh of this.#meshes) {
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh === true) (mesh as THREE.SkinnedMesh).skeleton?.dispose();
    }
  }
}

/**
 * §4.8, pure: where the echo body lies — `SCAV_ECHO_DISTANCE` from the player
 * on the first of eight bearings 45° apart, starting with the one toward the
 * camera (`cameraYaw`: the camera sits at `(sin yaw, cos yaw)` from its
 * target), whose spot `clear` accepts. With none clear it takes the camera's
 * bearing anyway — the scene passes the bearing toward the pad as `fallback`.
 * The body faces the player.
 */
export function echoBodySpot(
  px: number,
  pz: number,
  cameraYaw: number,
  clear: (x: number, z: number) => boolean,
  fallback?: number,
): { x: number; z: number; facing: number } {
  const spot = (bearing: number): { x: number; z: number; facing: number } => {
    const x = px + Math.sin(bearing) * SCAV_ECHO_DISTANCE;
    const z = pz + Math.cos(bearing) * SCAV_ECHO_DISTANCE;
    return { x, z, facing: Math.atan2(pz - z, px - x) };
  };
  for (let i = 0; i < ECHO_BEARINGS; i++) {
    const bearing = cameraYaw + (i * 2 * Math.PI) / ECHO_BEARINGS;
    const candidate = spot(bearing);
    if (clear(candidate.x, candidate.z)) return candidate;
  }
  return spot(fallback ?? cameraYaw);
}

/** §4.8: the bearing from the player toward a point, in `echoBodySpot`'s convention (sin along x, cos along z). */
export function bearingToward(px: number, pz: number, x: number, z: number): number {
  return Math.atan2(x - px, z - pz);
}
