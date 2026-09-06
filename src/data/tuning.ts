// Cross-cutting tunables (SPEC-009 §4.13), one typed object rather than
// constants scattered through systems. Numbers marked *initial tuning* in the
// specs may change without a PLAN refinement entry as long as the invariant
// tests stay green; the tests pin them as explicit literals.
//
// Units: meters, seconds, fractions in [0, 1]. Data modules are plain objects:
// no imports, no functions (SPEC-001 §4, §8).

export interface Tuning {
  /** XP needed from level L to L+1 is XP_BASE + XP_PER_LEVEL × L (SPEC-010). */
  readonly XP_BASE: number;
  readonly XP_PER_LEVEL: number;
  readonly LEVEL_CAP: number;
  readonly TOKENS_PER_LEVEL: number;
  /** Must equal UPGRADES.cargo.metrics.cargoCap[0] (SPEC-009). */
  readonly CARGO_BASE: number;
  /** Must equal the fresh save's oil (SPEC-007 §4.1). */
  readonly START_OIL: number;
  readonly DEATH_RESOURCE_LOSS: number;
  readonly REPLAY_REWARD_FRACTION: number;
  readonly DISCOUNT_CAP: number;
  readonly PICKUP_RADIUS: number;
  readonly PLAYER_BASE_HP: number;
  readonly PLAYER_SPEED: number;
  readonly INVULN_AFTER_HIT: number;
  readonly INVULN_AFTER_RESPAWN: number;
  readonly SCAN_SECONDS: number;
  readonly ELITE_HP_MULT: number;
  readonly ELITE_DMG_MULT: number;
  readonly STORM_WARNING_SECONDS: number;
  readonly SHIELD_REGEN_DELAY: number;
  readonly HOLD_PATTERN_MAX_SECONDS: number;
}

export const TUNING = {
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
} as const satisfies Tuning;
