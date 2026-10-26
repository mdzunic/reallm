// SPEC-058 §4.4, §6.1 — containment: how much tighter the Warden runs a later
// instance. The steps cap at three, so the multipliers stop at ×1.52 and the
// elite bonus at six points; iteration 1 is untouched, which is what keeps
// every earlier pin, bot band and SPEC-016 literal where it was.
import { describe, expect, it } from 'vitest';
import { CONTAINMENT, containment, containmentLabel, containmentLevel, containmentSteps, containmentTearDue } from '@/systems/Containment';

describe('containment (SPEC-058 §4.4)', () => {
  it('CONTAINMENT is ×1.15 HP and damage and +2 points of elite chance a step, at most three steps', () => {
    expect(CONTAINMENT).toEqual({ hpStep: 1.15, damageStep: 1.15, eliteStep: 0.02, maxSteps: 3 });
  });

  it('steps are min(max(0, i − 1), 3) at iterations 1–5, and stay at 3 to the validator’s 99', () => {
    expect([1, 2, 3, 4, 5].map(containmentSteps)).toEqual([0, 1, 2, 3, 3]);
    expect(containmentSteps(99)).toBe(3);
    // Below the validator's floor there is nothing to scale.
    expect(containmentSteps(0)).toBe(0);
  });

  it('the multipliers follow §4.4’s table at iterations 1–5', () => {
    const table = [
      { iteration: 1, mult: 1 },
      { iteration: 2, mult: 1.15 },
      { iteration: 3, mult: 1.3225 },
      { iteration: 4, mult: 1.520875 },
      { iteration: 5, mult: 1.520875 },
    ];
    for (const { iteration, mult } of table) {
      const c = containment(iteration);
      expect(c.hpMult, `hp at ${iteration}`).toBeCloseTo(mult, 12);
      expect(c.damageMult, `damage at ${iteration}`).toBeCloseTo(mult, 12);
    }
  });

  it('iteration 1 is exactly 1, 1 and 0 — no earlier pin moves', () => {
    expect(containment(1)).toEqual({ hpMult: 1, damageMult: 1, eliteBonus: 0 });
  });

  it('the elite bonus is two points a step: 0, 0.02, 0.04, 0.06, 0.06', () => {
    expect([1, 2, 3, 4, 5].map((i) => containment(i).eliteBonus)).toEqual([0, 0.02, 0.04, 0.06, 0.06]);
  });

  it('with hard (SPEC-043’s ×1.25 HP, ×1.3 damage) the ceiling is §4.4’s 1.90 / 1.98', () => {
    const top = containment(4);
    expect(Math.round(1.25 * top.hpMult * 100) / 100).toBe(1.9);
    expect(Math.round(1.3 * top.damageMult * 100) / 100).toBe(1.98);
    expect(Math.round(1.25 * containment(2).hpMult * 100) / 100).toBe(1.44);
    expect(Math.round(1.3 * containment(3).damageMult * 100) / 100).toBe(1.72);
  });

  it('containmentLevel is the chapter plus the capped steps', () => {
    expect(containmentLevel(1, 2)).toBe(2);
    expect(containmentLevel(6, 9)).toBe(9);
    expect(containmentLevel(4, 1)).toBe(4);
    expect(containmentLevel(1, 99)).toBe(4);
  });
});

describe('the label and its tear (PLAN R33, review 2026-10 P-01)', () => {
  it('reads "Threat level" on a first run until the notice, and "Containment level" after it or on a next instance', () => {
    expect(containmentLabel(new Set(), 1)).toBe('Threat level');
    expect(containmentLabel(new Set(['signal_decoded']), 1)).toBe('Containment level');
    expect(containmentLabel(new Set(), 2)).toBe('Containment level');
    expect(containmentLabel(new Set(), 7)).toBe('Containment level');
  });

  it('tears once, on a first run, at the first entry after the notice', () => {
    expect(containmentTearDue(new Set(), 1)).toBe(false);
    expect(containmentTearDue(new Set(['signal_decoded']), 1)).toBe(true);
    expect(containmentTearDue(new Set(['signal_decoded', 'containment_named']), 1)).toBe(false);
    // A next instance's notice opens its run: there is nothing to tear.
    expect(containmentTearDue(new Set(['signal_decoded']), 2)).toBe(false);
  });
});
