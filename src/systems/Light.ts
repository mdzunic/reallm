// The light rules below (SPEC-054 §4.6): what the flashlight's cone reaches,
// and how it moves the two archetypes that care — light off hides you, light
// on draws the hunters (rushers) and holds the bugs (swarms) off, and in the
// dark auto-fire cannot reach far. Pure, so `Combat`, `EnemyAi` and the
// enemies' rim all read one answer. The scene sets `CombatWorld.light` and
// `CombatWorld.sight` below and leaves both `undefined` on the surface, where
// nothing here applies.
import type { Archetype } from '@/data/index';

// ---------------------------------------------------------- initial tuning

/** SPEC-054 §3: how far the lit cone reaches, in metres. */
export const LIGHT_RANGE = 20;
/** SPEC-054 §3: the cone's half-angle in radians (24°). */
export const LIGHT_HALF_ANGLE = 0.42;
/** SPEC-054 §3: auto-target reach in the dark — a candidate past it must be lit. */
export const DARK_SIGHT = 9;
/** SPEC-054 §3: every swarm's and rusher's aggro radius multiplier with the light off. */
export const DARK_AGGRO = 0.6;
/** SPEC-054 §3: a rusher's aggro radius multiplier inside the lit cone. */
export const LIGHT_SEEK_AGGRO = 1.6;
/** SPEC-054 §3: a swarm's chase speed multiplier inside the lit cone. */
export const LIGHT_FEAR_SPEED = 0.4;
/** SPEC-054 §3: the hostile rim of an enemy outside the lit cone. */
export const DARK_RIM_SCALE = 0.6;

/** §4.6: a target this close counts as lit whenever the light is on — its bearing is noise. */
export const LIGHT_NEAR = 0.5;

/** The cone's edge as a cosine, so a test is one dot product and no `atan2`. */
const COS_HALF_ANGLE = Math.cos(LIGHT_HALF_ANGLE);

/**
 * §4.6: whether `(x, z)` lies within `LIGHT_HALF_ANGLE` of `facing` as seen
 * from `(px, pz)` — at any range, and always within `LIGHT_NEAR`. `facing` is
 * `player.facing`, the direction `(cos f, sin f)` on XZ. This is the beam a
 * hunter sees from afar: a rusher's ×1.6 acquisition (`LIGHT_SEEK_AGGRO`)
 * reaches past `LIGHT_RANGE`, so its "in the cone" is this test, which its
 * aggro radius bounds. Never allocates.
 */
export function inLightCone(px: number, pz: number, facing: number, x: number, z: number): boolean {
  const dx = x - px;
  const dz = z - pz;
  const d = Math.hypot(dx, dz);
  if (d <= LIGHT_NEAR) return true;
  return dx * Math.cos(facing) + dz * Math.sin(facing) >= d * COS_HALF_ANGLE;
}

/**
 * §4.6: the light falls on `(x, z)` — it is `on`, the point is within
 * `LIGHT_RANGE` of `(px, pz)`, and its bearing is within `LIGHT_HALF_ANGLE` of
 * `facing`. Within `LIGHT_NEAR` it is lit whenever the light is on. Never
 * allocates.
 */
export function lit(px: number, pz: number, facing: number, on: boolean, x: number, z: number): boolean {
  if (!on) return false;
  const dx = x - px;
  const dz = z - pz;
  const d = Math.hypot(dx, dz);
  if (d <= LIGHT_NEAR) return true;
  if (d > LIGHT_RANGE) return false;
  return dx * Math.cos(facing) + dz * Math.sin(facing) >= d * COS_HALF_ANGLE;
}

// --------------------------------------------------------- SPEC-056 §4.5

/** SPEC-056 §4.5: a burning flare lights this far around it — the `flare` item's `light.radius`. */
export const FLARE_RADIUS = 12;

/** SPEC-056 §3: a landed flare — where it burns, and the world time it goes out. */
export interface FlareState {
  x: number;
  z: number;
  until: number;
}

/**
 * SPEC-056 §4.5: `(x, z)` lies within `FLARE_RADIUS` of a flare still burning
 * at `time` — what the dark-sight rule counts as lit beside the beam. A flare
 * past its `until` lights nothing. Never allocates.
 */
export function inFlare(x: number, z: number, flares: readonly FlareState[], time: number): boolean {
  for (let i = 0; i < flares.length; i++) {
    const f = flares[i] as FlareState;
    if (time >= f.until) continue;
    const dx = x - f.x;
    const dz = z - f.z;
    if (dx * dx + dz * dz <= FLARE_RADIUS * FLARE_RADIUS) return true;
  }
  return false;
}

/**
 * §4.6: what the light does to an aggro radius — `undefined` (the surface)
 * reads 1; the light off reads `DARK_AGGRO` for a swarm or a rusher; on, a
 * rusher in the cone reads `LIGHT_SEEK_AGGRO`; everything else reads 1. Ranged
 * enemies, statics and bosses always read 1, and so do wave enemies, which
 * the caller (`EnemyAi`) leaves out. It multiplies SPEC-050's `noiseMult`.
 */
export function lightAggroMult(archetype: Archetype, light: { on: boolean } | undefined, inCone: boolean): number {
  if (light === undefined || (archetype !== 'swarm' && archetype !== 'rusher')) return 1;
  if (!light.on) return DARK_AGGRO;
  return archetype === 'rusher' && inCone ? LIGHT_SEEK_AGGRO : 1;
}
