// SPEC-050 §4.1, §6.1 — stamina: the constants, the regeneration formula, the
// in-combat drain, the regen delay and the calm multiplier, exhaustion and its
// recovery, the draw delay and the noise clock a sprint leaves behind, and the
// spend that exhausts. Everything runs at the fixed 60 Hz step from a fresh
// `makePlayer`, the way the surface's movement step calls it.
import { describe, expect, it } from 'vitest';
import { CLASSES } from '@/data/index';
import { makePlayer, type PlayerEntity } from '@/entities/Player';
import {
  canSpend,
  CASUAL_STAMINA_MULT,
  DASH_STAMINA,
  isHolstered,
  isLoud,
  LOUD_SECONDS,
  resetStamina,
  spend,
  SPRINT_DRAIN,
  SPRINT_DRAW_SECONDS,
  SPRINT_MULT,
  SPRINT_NOISE,
  STAMINA_CALM_MULT,
  STAMINA_MAX,
  STAMINA_RECOVER,
  STAMINA_REGEN,
  STAMINA_REGEN_DELAY,
  staminaRegen,
  stepStamina,
} from '@/systems/Stamina';

const STEP = 1 / 60;
/** A Marine at agility 1 on normal: 20 × 1.03. */
const REGEN = 20.6;

interface Run {
  wants?: boolean;
  moving?: boolean;
  inCombat?: boolean;
  drainMult?: number;
  regen?: number;
}

/** `seconds` of fixed steps from `from`; returns the clock after them. */
function run(p: PlayerEntity, seconds: number, opts: Run = {}, from = 0): number {
  let time = from;
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    stepStamina(
      p,
      opts.wants ?? true,
      opts.moving ?? true,
      opts.inCombat ?? true,
      opts.drainMult ?? 1,
      opts.regen ?? REGEN,
      time,
      STEP,
    );
    time += STEP;
  }
  return time;
}

describe('the stamina constants (SPEC-050 §3)', () => {
  it('pins the initial tuning', () => {
    expect(STAMINA_MAX).toBe(100);
    expect(SPRINT_MULT).toBe(1.35);
    expect(SPRINT_DRAIN).toBe(25);
    expect(STAMINA_REGEN).toBe(20);
    expect(STAMINA_REGEN_DELAY).toBe(0.8);
    expect(STAMINA_CALM_MULT).toBe(1.5);
    expect(STAMINA_RECOVER).toBe(30);
    expect(DASH_STAMINA).toBe(30);
    expect(SPRINT_DRAW_SECONDS).toBe(0.25);
    expect(SPRINT_NOISE).toBe(1.5);
    expect(LOUD_SECONDS).toBe(1.5);
    expect(CASUAL_STAMINA_MULT).toBe(1.25);
  });

  it('makePlayer starts full, quiet, not sprinting and with no draw delay (§3)', () => {
    const p = makePlayer(0, 0, 100);
    expect(p.stamina).toBe(100);
    expect(p.staminaSpentAt).toBe(-Infinity);
    expect(p.exhausted).toBe(false);
    expect(p.sprinting).toBe(false);
    expect(p.drawAt).toBe(0);
    expect(p.loudUntil).toBe(-Infinity);
  });

  it('resetStamina puts back exactly makePlayer’s values (the respawn and the recall, §4.1)', () => {
    const p = makePlayer(0, 0, 100);
    Object.assign(p, { stamina: 3, staminaSpentAt: 12, exhausted: true, sprinting: true, drawAt: 40, loudUntil: 41 });
    resetStamina(p);
    expect(p).toEqual(makePlayer(0, 0, 100));
  });
});

describe('staminaRegen (SPEC-050 §4.1)', () => {
  it('is 20 × (1 + 0.03 × agility), ×1.25 on casual', () => {
    expect(staminaRegen(1, 'normal')).toBeCloseTo(20.6, 10);
    expect(staminaRegen(9, 'normal')).toBeCloseTo(25.4, 10);
    expect(staminaRegen(1, 'hard')).toBeCloseTo(20.6, 10);
    expect(staminaRegen(1, 'casual')).toBeCloseTo(20.6 * 1.25, 10);
    expect(staminaRegen(9, 'casual')).toBeCloseTo(25.4 * 1.25, 10);
  });
});

describe('the drain (SPEC-050 §4.1)', () => {
  it('is 25 a second in combat while moving, and the player sprints', () => {
    const p = makePlayer(0, 0, 100);
    run(p, 1);
    expect(p.sprinting).toBe(true);
    expect(p.stamina).toBeCloseTo(75, 6);
  });

  it('is 20 a second at the Scout’s drainMult of 0.8 — 5 s from full, against 4', () => {
    expect(CLASSES.scout.passive.sprintDrainMult).toBe(0.8);
    const scout = makePlayer(0, 0, 100);
    run(scout, 1, { drainMult: 0.8 });
    expect(scout.stamina).toBeCloseTo(80, 6);
    const marine = makePlayer(0, 0, 100);
    run(marine, 3.95);
    expect(marine.exhausted).toBe(false);
    run(marine, 0.1, {}, 3.95);
    expect(marine.exhausted).toBe(true);
    const full = makePlayer(0, 0, 100);
    run(full, 4.95, { drainMult: 0.8 });
    expect(full.exhausted).toBe(false);
    run(full, 0.1, { drainMult: 0.8 }, 4.95);
    expect(full.exhausted).toBe(true);
  });

  it('spends nothing out of combat, standing still, or when the run is not wanted', () => {
    for (const opts of [{ inCombat: false }, { moving: false }, { wants: false }] satisfies Run[]) {
      const p = makePlayer(0, 0, 100);
      run(p, 2, opts);
      expect(p.stamina, JSON.stringify(opts)).toBe(100);
      expect(p.staminaSpentAt, JSON.stringify(opts)).toBe(-Infinity);
    }
  });

  it('a standing player never sprints, and so is never holstered or loud (50-a)', () => {
    const p = makePlayer(0, 0, 100);
    run(p, 1, { moving: false });
    expect(p.sprinting).toBe(false);
    expect(isHolstered(p, 1)).toBe(false);
    expect(isLoud(p, 1)).toBe(false);
  });

  it('a dead player never sprints', () => {
    const p = makePlayer(0, 0, 100);
    p.alive = false;
    run(p, 1);
    expect(p.sprinting).toBe(false);
    expect(p.stamina).toBe(100);
  });

  it('starts draining on the step combat starts (50-l)', () => {
    const p = makePlayer(0, 0, 100);
    const t = run(p, 1, { inCombat: false });
    expect(p.sprinting).toBe(true);
    expect(p.stamina).toBe(100);
    run(p, 1, { inCombat: true }, t);
    expect(p.stamina).toBeCloseTo(75, 6);
  });
});

describe('the regeneration (SPEC-050 §4.1)', () => {
  it('waits 0.8 s after the last spend, then runs at regenPerSec in combat', () => {
    const p = makePlayer(0, 0, 100);
    let t = run(p, 2); // 50 left, spent until the last step
    expect(p.stamina).toBeCloseTo(50, 6);
    t = run(p, 0.75, { wants: false }, t);
    expect(p.stamina).toBeCloseTo(50, 6);
    t = run(p, 1.05, { wants: false }, t); // 0.8 s after the spend, then about a second of regen
    expect(p.stamina).toBeGreaterThan(50 + REGEN * 0.95);
    expect(p.stamina).toBeLessThan(50 + REGEN * 1.05);
  });

  it('0 → 100 takes 100 / 20.6 = 4.85 s after the delay, and stops at 100', () => {
    const p = makePlayer(0, 0, 100);
    spend(p, 100, 0);
    run(p, STAMINA_REGEN_DELAY + 4.8, { wants: false });
    expect(p.stamina).toBeLessThan(100);
    run(p, 0.2, { wants: false }, STAMINA_REGEN_DELAY + 4.8);
    expect(p.stamina).toBe(100);
  });

  it('is ×1.5 out of combat', () => {
    const fight = makePlayer(0, 0, 100);
    const calm = makePlayer(0, 0, 100);
    spend(fight, 80, 0);
    spend(calm, 80, 0);
    run(fight, 2, { wants: false, inCombat: true });
    run(calm, 2, { wants: false, inCombat: false });
    expect(calm.stamina - 20).toBeCloseTo((fight.stamina - 20) * 1.5, 6);
  });

  it('keeps running during a calm sprint, which spends nothing', () => {
    const p = makePlayer(0, 0, 100);
    spend(p, 60, 0);
    run(p, 2, { inCombat: false });
    expect(p.sprinting).toBe(true);
    expect(p.stamina).toBeGreaterThan(40);
  });
});

describe('exhaustion (SPEC-050 §4.1, E79)', () => {
  it('sets at 0, refuses the in-combat sprint and canSpend(p, 30), and clears at 30', () => {
    const p = makePlayer(0, 0, 100);
    let t = run(p, 4.1);
    expect(p.stamina).toBe(0);
    expect(p.exhausted).toBe(true);
    expect(canSpend(p, DASH_STAMINA)).toBe(false);
    // Still holding the run in combat: refused, so the pool refills.
    t = run(p, 0.5, {}, t);
    expect(p.sprinting).toBe(false);
    t = run(p, 1.5, {}, t);
    expect(p.exhausted).toBe(true);
    expect(p.stamina).toBeLessThan(STAMINA_RECOVER);
    expect(canSpend(p, DASH_STAMINA)).toBe(false);
    // 0.8 s + 30 / 20.6 = 2.26 s after the last spend it is back at 30, and
    // the next step sprints again — and spends again.
    while (p.exhausted) t = run(p, STEP, { wants: false }, t);
    expect(p.stamina).toBeGreaterThanOrEqual(STAMINA_RECOVER);
    expect(p.stamina).toBeLessThan(STAMINA_RECOVER + 1);
    expect(canSpend(p, DASH_STAMINA)).toBe(true);
    run(p, STEP, {}, t);
    expect(p.sprinting).toBe(true);
  });

  it('never stops a calm sprint', () => {
    const p = makePlayer(0, 0, 100);
    spend(p, 100, 0);
    expect(p.exhausted).toBe(true);
    run(p, STEP, { inCombat: false }, 0);
    expect(p.sprinting).toBe(true);
  });

  it('stops the sprint of a player who exhausts in combat while still holding it (50-l)', () => {
    const p = makePlayer(0, 0, 100);
    const t = run(p, 4.05);
    expect(p.exhausted).toBe(true);
    run(p, STEP, {}, t);
    expect(p.sprinting).toBe(false);
  });
});

describe('the draw and the noise a sprint leaves (SPEC-050 §4.2, §4.3)', () => {
  it('holsters while sprinting, draws 0.25 s after the sprint ends, and is loud for 1.5 s after its last step', () => {
    const p = makePlayer(0, 0, 100);
    let t = run(p, 0.5, { inCombat: false });
    const last = t - STEP;
    expect(p.sprinting).toBe(true);
    expect(isHolstered(p, t)).toBe(true);
    expect(isLoud(p, t)).toBe(true);
    expect(p.loudUntil).toBeCloseTo(last + LOUD_SECONDS, 9);
    // The step the sprint ends starts the draw.
    stepStamina(p, false, true, false, 1, REGEN, t, STEP);
    expect(p.sprinting).toBe(false);
    expect(p.drawAt).toBeCloseTo(t + SPRINT_DRAW_SECONDS, 9);
    expect(isHolstered(p, t + 0.24)).toBe(true);
    expect(isHolstered(p, t + 0.25)).toBe(false);
    // Loud 1.5 s after the last sprinting step, and no longer.
    expect(p.loudUntil).toBeCloseTo(last + LOUD_SECONDS, 9);
    expect(isLoud(p, last + 1.49)).toBe(true);
    expect(isLoud(p, last + 1.5)).toBe(false);
    t += STEP;
    // Walking on changes neither.
    run(p, 1, { wants: false, inCombat: false }, t);
    expect(p.drawAt).toBeCloseTo(t - STEP + SPRINT_DRAW_SECONDS, 9);
  });
});

describe('spend (SPEC-050 §4.1)', () => {
  it('returns true exactly on the spend that exhausts', () => {
    const p = makePlayer(0, 0, 100);
    expect(spend(p, 30, 1)).toBe(false);
    expect(p.stamina).toBe(70);
    expect(p.staminaSpentAt).toBe(1);
    expect(spend(p, 30, 2)).toBe(false);
    expect(spend(p, 30, 3)).toBe(false);
    expect(p.stamina).toBeCloseTo(10, 9);
    expect(spend(p, 30, 4)).toBe(true);
    expect(p.stamina).toBe(0);
    expect(p.exhausted).toBe(true);
    // Already exhausted: not a new exhaustion.
    expect(spend(p, 30, 5)).toBe(false);
  });

  it('canSpend is !exhausted && stamina ≥ amount', () => {
    const p = makePlayer(0, 0, 100);
    p.stamina = 30;
    expect(canSpend(p, 30)).toBe(true);
    p.stamina = 29;
    expect(canSpend(p, 30)).toBe(false);
    p.stamina = 80;
    p.exhausted = true;
    expect(canSpend(p, 30)).toBe(false);
  });
});
