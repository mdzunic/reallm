// The dash (SPEC-038 §4.1): a 5 m burst in 0.2 s with 0.3 s of i-frames from
// the press, on a cooldown that falls with agility, is ×0.8 for the Scout and
// ×0.8 on casual, and never drops below 0.8 s. Pure: the surface step moves the
// player along `dashX/dashZ` while `isDashing`, and `Combat` reads the same
// clock to hold its fire, its push-out and its knockback.
import type { ClassPassive, Difficulty } from '@/data/index';
import type { PlayerEntity } from '@/entities/Player';

// ------------------------------------------------------------ initial tuning

/** Metres covered by one dash. */
export const DASH_DISTANCE = 5;
/** Seconds the movement takes — 25 m/s. */
export const DASH_SECONDS = 0.2;
/** Seconds of i-frames, counted from the press. */
export const DASH_IFRAMES = 0.3;
/** The base cooldown, in seconds. */
export const DASH_COOLDOWN = 1.4;
/**
 * Per agility point. SPEC-039 moves the value into
 * `ATTRIBUTE_EFFECTS.agility.dashCooldownCut` (data/characters.ts) and this
 * constant then reads it; the name and the value stay.
 */
export const DASH_AGILITY_CUT = 0.03;
/** The floor: invulnerable time stays at or below 37.5 % of the clock. */
export const DASH_COOLDOWN_MIN = 0.8;
/** Casual's dash cooldown multiplier (§4.6). */
export const CASUAL_DASH_MULT = 0.8;

/**
 * `max(0.8, 1.4 × (1 − 0.03 × agility) × (passive.dashCooldownMult ?? 1) ×
 * (casual ? 0.8 : 1))` — a Marine at agility 1 on normal waits 1.358 s, a Scout
 * at 4 waits 0.9856 s, and a Scout at 10 sits on the 0.8 s floor.
 */
export function dashCooldown(passive: ClassPassive, agility: number, difficulty: Difficulty): number {
  const raw =
    DASH_COOLDOWN *
    (1 - DASH_AGILITY_CUT * agility) *
    (passive.dashCooldownMult ?? 1) *
    (difficulty === 'casual' ? CASUAL_DASH_MULT : 1);
  return Math.max(DASH_COOLDOWN_MIN, raw);
}

/**
 * Starts a dash along `(dirX, dirZ)` when `time ≥ dashReadyAt`: the movement
 * runs to `time + DASH_SECONDS`, the next dash waits `cooldown`, and direct hits
 * are ignored until at least `time + DASH_IFRAMES`. False, and nothing changes,
 * inside the cooldown or for a direction with no length.
 */
export function tryDash(p: PlayerEntity, dirX: number, dirZ: number, time: number, cooldown: number): boolean {
  if (time < p.dashReadyAt) return false;
  const length = Math.hypot(dirX, dirZ);
  if (length < 1e-6) return false;
  p.dashX = dirX / length;
  p.dashZ = dirZ / length;
  p.dashUntil = time + DASH_SECONDS;
  p.dashReadyAt = time + cooldown;
  p.invulnUntil = Math.max(p.invulnUntil, time + DASH_IFRAMES);
  return true;
}

/** True while the current dash's movement runs. */
export function isDashing(p: PlayerEntity, time: number): boolean {
  return time < p.dashUntil;
}

/** The collision a dash step runs — `ObstacleGrid` satisfies it. */
export interface DashObstacles {
  resolveCircle(x: number, z: number, r: number, out: { x: number; z: number }): boolean;
  hitsCircle(x: number, z: number, r: number): boolean;
}

/**
 * One fixed step of a running dash (§4.1): `DASH_DISTANCE / DASH_SECONDS`
 * (25 m/s) along `dashX/dashZ`, never scaled by the storm, with walking's
 * collision — resolve out of any obstacle first, then the axis slide, then the
 * wall clamp at `±edge`. A step the slide blocks on both axes, or that the wall
 * shortens, ends the movement where it stands (E59); the i-frames run on. The
 * last step covers only what is left, so a dash is 5 m whatever the step phase.
 * Writes `vx/vz` for the camera and the facing; `scratch` is the resolve's out.
 */
export function stepDash(
  p: PlayerEntity,
  obstacles: DashObstacles,
  edge: number,
  time: number,
  dt: number,
  scratch: { x: number; z: number },
): void {
  const speed = DASH_DISTANCE / DASH_SECONDS;
  p.vx = p.dashX * speed;
  p.vz = p.dashZ * speed;
  if (obstacles.resolveCircle(p.x, p.z, p.radius, scratch)) {
    p.x = scratch.x;
    p.z = scratch.z;
  }
  const travel = Math.max(0, Math.min(dt, p.dashUntil - time)) * speed;
  const nx = p.x + p.dashX * travel;
  const nz = p.z + p.dashZ * travel;
  const blockedX = obstacles.hitsCircle(nx, p.z, p.radius);
  if (!blockedX) p.x = nx;
  const blockedZ = obstacles.hitsCircle(p.x, nz, p.radius);
  if (!blockedZ) p.z = nz;
  const cx = Math.max(-edge, Math.min(edge, p.x));
  const cz = Math.max(-edge, Math.min(edge, p.z));
  const clamped = cx !== p.x || cz !== p.z;
  p.x = cx;
  p.z = cz;
  if ((blockedX && blockedZ) || clamped) p.dashUntil = time;
}
