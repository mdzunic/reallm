// data/tuning (SPEC-009 §4.13). Pinned as explicit literals, not snapshots: a
// change to a tunable must be deliberate and visible in the diff (SPEC-016 §2).
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '@/data/ids';
import { BELOW_HALF_SIZE, DIFFICULTY_RULES, TUNING } from '@/data/tuning';

describe('TUNING', () => {
  it('carries the SPEC-009 §4.13 values', () => {
    expect(TUNING).toEqual({
      XP_BASE: 100,
      XP_PER_LEVEL: 50,
      LEVEL_CAP: 30,
      TOKENS_PER_LEVEL: 25,
      CARGO_BASE: 400,
      START_OIL: 60,
      DEATH_RESOURCE_LOSS: 0.1,
      REPLAY_REWARD_FRACTION: 0.5,
      DISCOUNT_CAP: 0.4,
      PICKUP_RADIUS: 1.5,
      PLAYER_BASE_HP: 100,
      PLAYER_SPEED: 6,
      INVULN_AFTER_HIT: 0.3,
      INVULN_AFTER_RESPAWN: 2,
      SCAN_SECONDS: 3,
      ELITE_HP_MULT: 3,
      ELITE_DMG_MULT: 1.5,
      STORM_WARNING_SECONDS: 10,
      SHIELD_REGEN_DELAY: 3,
      HOLD_PATTERN_MAX_SECONDS: 90,
    });
  });

  it('SPEC-047 §2: the underground size is its own export, not a TUNING key', () => {
    expect(BELOW_HALF_SIZE).toBe(48);
    expect(Object.keys(TUNING)).not.toContain('BELOW_HALF_SIZE');
  });

  it('fractions stay fractions and multipliers stay above one', () => {
    for (const k of ['DEATH_RESOURCE_LOSS', 'REPLAY_REWARD_FRACTION', 'DISCOUNT_CAP'] as const) {
      expect(TUNING[k]).toBeGreaterThan(0);
      expect(TUNING[k]).toBeLessThanOrEqual(1);
    }
    expect(TUNING.ELITE_HP_MULT).toBeGreaterThan(1);
    expect(TUNING.ELITE_DMG_MULT).toBeGreaterThan(1);
  });
});

describe('DIFFICULTY_RULES (SPEC-043 §4.4)', () => {
  it('is keyed by exactly the difficulties the save knows', () => {
    // `data/` cannot import `core/`, so the table spells the keys out and this
    // pins them to `DIFFICULTIES` — four since SPEC-059 §4.2.1 put story first.
    expect(Object.keys(DIFFICULTY_RULES).sort()).toEqual([...DIFFICULTIES].sort());
    expect(DIFFICULTIES).toEqual(['story', 'casual', 'normal', 'hard']);
  });

  it('casual and normal keep their numbers, and hard multiplies what exists', () => {
    // SPEC-059 §4.2.1: every row carries the three new columns; casual, normal
    // and hard keep every value they had, and their new ones are what SPEC-038
    // applied for casual alone. SPEC-066 §4.8: every row gains `depotLoss` —
    // a tenth of the depot on hard, nothing elsewhere.
    expect(DIFFICULTY_RULES).toEqual({
      story: { enemyHpMult: 0.6, enemyDamageMult: 0, eliteChanceMult: 1, deathLoss: 0, weatherMult: 0, allyDamageMult: 0, assisted: true, depotLoss: 0 },
      casual: { enemyHpMult: 1, enemyDamageMult: 0.7, eliteChanceMult: 1, deathLoss: 0, weatherMult: 0.7, allyDamageMult: 1, assisted: true, depotLoss: 0 },
      normal: { enemyHpMult: 1, enemyDamageMult: 1, eliteChanceMult: 1, deathLoss: 0.1, weatherMult: 1, allyDamageMult: 1, assisted: false, depotLoss: 0 },
      hard: { enemyHpMult: 1.25, enemyDamageMult: 1.3, eliteChanceMult: 2, deathLoss: 0.2, weatherMult: 1, allyDamageMult: 1, assisted: false, depotLoss: 0.1 },
    });
    expect(DIFFICULTY_RULES.normal.deathLoss).toBe(TUNING.DEATH_RESOURCE_LOSS);
  });
});
