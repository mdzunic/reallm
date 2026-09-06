// data/tuning (SPEC-009 §4.13). Pinned as explicit literals, not snapshots: a
// change to a tunable must be deliberate and visible in the diff (SPEC-016 §2).
import { describe, expect, it } from 'vitest';
import { TUNING } from '@/data/tuning';

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

  it('fractions stay fractions and multipliers stay above one', () => {
    for (const k of ['DEATH_RESOURCE_LOSS', 'REPLAY_REWARD_FRACTION', 'DISCOUNT_CAP'] as const) {
      expect(TUNING[k]).toBeGreaterThan(0);
      expect(TUNING[k]).toBeLessThanOrEqual(1);
    }
    expect(TUNING.ELITE_HP_MULT).toBeGreaterThan(1);
    expect(TUNING.ELITE_DMG_MULT).toBeGreaterThan(1);
  });
});
