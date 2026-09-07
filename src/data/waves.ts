// Attack waves (SPEC-009 §4.6). A wave is a script of spawn groups measured in
// seconds from the moment the wave starts: surface waves back `defend` stages
// and the ambient pressure a mission can turn on, flight waves are the hostiles
// the outbound trip throws at the ship.
//
// Flight kill objectives are sized against these counts: E12 wants at least
// twice the required kills in the air, which invariant §7.6 checks.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { EnemyId } from '@/data/enemies';

export interface WaveDef<Id extends string = string> {
  readonly id: Id;
  readonly domain: 'surface' | 'flight';
  /** Ordered by `atSecond`, relative to the start of the wave. */
  readonly groups: readonly {
    readonly enemy: EnemyId;
    readonly count: number;
    readonly atSecond: number;
    readonly elite?: boolean;
  }[];
  /** Surface ambient waves repeat from the top after this long. */
  readonly loopAfterSeconds?: number;
  /** Distance from the player (surface) or depth ahead of the ship (flight). */
  readonly spawnBand: readonly [number, number];
}

export const WAVES = {
  /** `c3_s2` runs under this while the player harvests (PLAN §6). */
  thessaly_reaping: {
    id: 'thessaly_reaping',
    domain: 'surface',
    groups: [
      { enemy: 'hive_drone', count: 6, atSecond: 0 },
      { enemy: 'spore_hound', count: 4, atSecond: 20 },
      { enemy: 'hive_drone', count: 8, atSecond: 40 },
      { enemy: 'spore_spitter', count: 2, atSecond: 55 },
    ],
    loopAfterSeconds: 70,
    spawnBand: [25, 45],
  },

  /** The 240 s defence of `c6_m2`; it does not loop, it ends the campaign. */
  eden_final: {
    id: 'eden_final',
    domain: 'surface',
    groups: [
      { enemy: 'hive_drone', count: 8, atSecond: 0 },
      { enemy: 'hive_warrior', count: 4, atSecond: 30 },
      { enemy: 'hive_spitter', count: 3, atSecond: 60 },
      { enemy: 'hive_drone', count: 10, atSecond: 90 },
      { enemy: 'hive_warrior', count: 6, atSecond: 130, elite: true },
      { enemy: 'hive_spitter', count: 4, atSecond: 170 },
      { enemy: 'hive_drone', count: 12, atSecond: 200 },
    ],
    spawnBand: [30, 55],
  },

  /** Cinder-4 is the tutorial jump: asteroids only, nothing shooting back. */
  cinder4_flight: {
    id: 'cinder4_flight',
    domain: 'flight',
    groups: [],
    spawnBand: [120, 200],
  },
  vetra_flight: {
    id: 'vetra_flight',
    domain: 'flight',
    groups: [{ enemy: 'scav_fighter', count: 2, atSecond: 45 }],
    spawnBand: [120, 200],
  },
  thessaly_flight: {
    id: 'thessaly_flight',
    domain: 'flight',
    groups: [
      { enemy: 'scav_fighter', count: 3, atSecond: 40 },
      { enemy: 'scav_fighter', count: 3, atSecond: 90 },
    ],
    spawnBand: [120, 200],
  },
  /** 18 fighters against `c4_s2`'s 8 kills (E12: waves spawn ≥ 2× required). */
  ferrum_flight: {
    id: 'ferrum_flight',
    domain: 'flight',
    groups: [
      { enemy: 'scav_fighter', count: 4, atSecond: 20 },
      { enemy: 'scav_fighter', count: 4, atSecond: 50 },
      { enemy: 'scav_fighter', count: 6, atSecond: 90 },
      { enemy: 'scav_fighter', count: 4, atSecond: 120 },
    ],
    spawnBand: [120, 200],
  },
  /** 30 interceptors against `c5_m1`'s 10; the last group is the arrival wave
   *  that blocks landing until it is cleared (E12). */
  hive_flight: {
    id: 'hive_flight',
    domain: 'flight',
    groups: [
      { enemy: 'hive_interceptor', count: 4, atSecond: 15 },
      { enemy: 'hive_interceptor', count: 6, atSecond: 45 },
      { enemy: 'hive_interceptor', count: 6, atSecond: 80 },
      { enemy: 'hive_interceptor', count: 8, atSecond: 120 },
      { enemy: 'hive_interceptor', count: 6, atSecond: 160 },
    ],
    spawnBand: [120, 200],
  },
  eden_flight: {
    id: 'eden_flight',
    domain: 'flight',
    groups: [
      { enemy: 'hive_interceptor', count: 4, atSecond: 40 },
      { enemy: 'hive_interceptor', count: 4, atSecond: 90 },
    ],
    spawnBand: [120, 200],
  },
} as const satisfies Record<string, WaveDef>;

export type WaveId = keyof typeof WAVES;
export type Wave = WaveDef<WaveId>;
