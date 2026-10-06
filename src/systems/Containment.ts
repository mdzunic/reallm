// Containment (SPEC-058 §4.4): how much tighter the Warden runs a later
// instance. PLAN §5's deferred rule — enemy HP and damage ×1.15 and elite
// chance +2 points per iteration — compounded without bound, and
// `meta.iteration` reaches 99; PLAN R21 decision 2 caps it at three steps, so
// ×1.52 is the ceiling and iteration 1 is untouched (every multiplier 1, the
// bonus 0, so no pin of an earlier spec moves).
//
// Pure — no `three`, no DOM (SPEC-001 §4). Each consumer reads the bound
// save's `meta.iteration` once, at construction: the iteration never changes
// mid-visit.

/** §3: the per-step multipliers and the cap. */
export const CONTAINMENT = { hpStep: 1.15, damageStep: 1.15, eliteStep: 0.02, maxSteps: 3 } as const;

/** §4.4: `min(max(0, iteration − 1), 3)` — 0 at iteration 1, 3 from iteration 4 on. */
export function containmentSteps(iteration: number): number {
  return Math.min(Math.max(0, iteration - 1), CONTAINMENT.maxSteps);
}

/** §4.4's table: what the enemies of an instance are scaled by. */
export interface Containment {
  /** Surface enemies' HP; flight enemies keep theirs (SPEC-034). */
  readonly hpMult: number;
  /** Every enemy hit, on the surface and in flight. */
  readonly damageMult: number;
  /** Added to the planet's `eliteChance` in every ambient roll, before `eliteMult`. */
  readonly eliteBonus: number;
}

/** §4.4: `hpStep^s`, `damageStep^s` and `eliteStep × s`, `s = containmentSteps(iteration)`. */
export function containment(iteration: number): Containment {
  const steps = containmentSteps(iteration);
  return {
    hpMult: CONTAINMENT.hpStep ** steps,
    damageMult: CONTAINMENT.damageStep ** steps,
    eliteBonus: CONTAINMENT.eliteStep * steps,
  };
}

/**
 * §4.4: the label the chapter card, the station header and SPEC-048's
 * `{containment}` print — the chapter plus the same capped steps the enemies
 * are scaled by, so the number is one a player can trust.
 */
export function containmentLevel(chapter: number, iteration: number): number {
  return chapter + containmentSteps(iteration);
}
