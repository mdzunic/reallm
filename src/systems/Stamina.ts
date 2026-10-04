// Stamina (SPEC-050 §4.1): the pool an in-combat sprint drains and the dash
// spends, its regeneration after a short delay, and exhaustion — which refuses
// an in-combat sprint and the dash until the pool is back at 30, and never
// slows the walk. The same step owns the sprint's two side effects: the gun's
// draw after it ends (`drawAt`, §4.2) and the noise it makes (`loudUntil`,
// §4.3).
//
// Pure: no `three`, no DOM, no clock. The surface's movement step calls
// `stepStamina` once per fixed step, before it moves the player; `Combat`
// holsters on `isHolstered`, and the scene, `EnemyAi` and the telegraph pass
// read `isLoud`. Nothing here allocates.
import { ATTRIBUTE_EFFECTS, type Difficulty } from '@/data/index';
import type { PlayerEntity } from '@/entities/Player';

// ------------------------------------------------------------ initial tuning

export const STAMINA_MAX = 100;
/** The sprint's speed, × `stats.moveSpeed` — the weather slow included. */
export const SPRINT_MULT = 1.35;
/** Per second, while in combat and moving. */
export const SPRINT_DRAIN = 25;
/** Per second, after the delay. */
export const STAMINA_REGEN = 20;
/** Seconds after the last spend. */
export const STAMINA_REGEN_DELAY = 0.8;
/** Regeneration × out of combat. */
export const STAMINA_CALM_MULT = 1.5;
/** Exhausted until stamina is back here. */
export const STAMINA_RECOVER = 30;
/** What one dash costs (SPEC-038's dash; this spec adds the cost only). */
export const DASH_STAMINA = 30;
/** The gun's draw after a sprint, in seconds. */
export const SPRINT_DRAW_SECONDS = 0.25;
/** The aggro radius × while the player is loud. */
export const SPRINT_NOISE = 1.5;
/** Loud this long after the last sprinting step, in seconds. */
export const LOUD_SECONDS = 1.5;
/** Casual's regeneration multiplier. */
export const CASUAL_STAMINA_MULT = 1.25;

/**
 * `20 × (1 + 0.03 × agility) × (casual ? 1.25 : 1)` per second — a Marine at
 * agility 1 on normal regains 20.6, a Scout at agility 9 regains 25.4. The
 * per-point share is `ATTRIBUTE_EFFECTS.agility.staminaRegen` (SPEC-039's
 * table, which every per-point effect reads).
 */
export function staminaRegen(agility: number, difficulty: Difficulty): number {
  return (
    STAMINA_REGEN *
    (1 + ATTRIBUTE_EFFECTS.agility.staminaRegen * agility) *
    (difficulty === 'casual' ? CASUAL_STAMINA_MULT : 1)
  );
}

/**
 * One fixed step (§4.1). Sets `p.sprinting`, `p.stamina`, `p.exhausted`,
 * `p.drawAt` and `p.loudUntil`; returns `p.sprinting`.
 *
 * The player sprints when it is wanted (`wants` — the held action or the
 * latch, already false while explicit fire is held), the move input is past
 * the dead zone, the player is alive, and — in combat — not exhausted with
 * stamina left. Out of combat an exhausted player still sprints: a calm
 * sprint spends nothing. Every sprinting step is loud for `LOUD_SECONDS`
 * after it; the step a sprint ends starts the gun's `SPRINT_DRAW_SECONDS`.
 *
 * An in-combat sprint drains `SPRINT_DRAIN × drainMult` a second and reaching
 * 0 exhausts. Otherwise, `STAMINA_REGEN_DELAY` after the last spend, stamina
 * rises by `regenPerSec` (× `STAMINA_CALM_MULT` out of combat) up to the max,
 * and exhaustion clears at `STAMINA_RECOVER`.
 */
export function stepStamina(
  p: PlayerEntity,
  wants: boolean,
  moving: boolean,
  inCombat: boolean,
  drainMult: number,
  regenPerSec: number,
  time: number,
  dt: number,
): boolean {
  const was = p.sprinting;
  const sprinting = wants && moving && p.alive && (!inCombat || (!p.exhausted && p.stamina > 0));
  p.sprinting = sprinting;
  if (sprinting) p.loudUntil = time + LOUD_SECONDS;
  else if (was) p.drawAt = time + SPRINT_DRAW_SECONDS;

  if (sprinting && inCombat) {
    p.stamina = Math.max(0, p.stamina - SPRINT_DRAIN * drainMult * dt);
    p.staminaSpentAt = time;
    if (p.stamina <= 0) p.exhausted = true;
    return true;
  }
  if (time - p.staminaSpentAt >= STAMINA_REGEN_DELAY && p.stamina < STAMINA_MAX) {
    p.stamina = Math.min(STAMINA_MAX, p.stamina + regenPerSec * (inCombat ? 1 : STAMINA_CALM_MULT) * dt);
  }
  if (p.exhausted && p.stamina >= STAMINA_RECOVER) p.exhausted = false;
  return sprinting;
}

/** Whether `amount` may be spent: not exhausted, and at least that much left. */
export function canSpend(p: PlayerEntity, amount: number): boolean {
  return !p.exhausted && p.stamina >= amount;
}

/**
 * Spends `amount` at `time` (the regen delay restarts); returns true when this
 * spend exhausted the player — on the transition only, so `player:exhausted`
 * fires once per exhaustion.
 */
export function spend(p: PlayerEntity, amount: number, time: number): boolean {
  p.stamina = Math.max(0, p.stamina - amount);
  p.staminaSpentAt = time;
  if (p.stamina > 0 || p.exhausted) return false;
  p.exhausted = true;
  return true;
}

/** §4.3: loud while sprinting and `LOUD_SECONDS` after the last sprinting step. */
export function isLoud(p: PlayerEntity, time: number): boolean {
  return time < p.loudUntil;
}

/** §4.2: the gun is holstered while the player sprints, and through the draw after. */
export function isHolstered(p: PlayerEntity, time: number): boolean {
  return p.sprinting || time < p.drawAt;
}

/**
 * §4.1: what `makePlayer`, the respawn (E4), the recall (E55) and a landing
 * leave — a full pool, not exhausted, not sprinting, no draw delay, quiet.
 */
export function resetStamina(p: PlayerEntity): void {
  p.stamina = STAMINA_MAX;
  p.staminaSpentAt = -Infinity;
  p.exhausted = false;
  p.sprinting = false;
  p.drawAt = 0;
  p.loudUntil = -Infinity;
}
