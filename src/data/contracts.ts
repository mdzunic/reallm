// Contracts (SPEC-043 §4.3, PLAN R18 decision 8). Once a chapter is finished,
// a replay of one of its surface missions on a planet where enemies live runs
// as a contract: one modifier, rolled per landing from the seed and shown on
// the board before departure, for 75 % of the mission's XP and tokens plus 20
// lithium — better than a plain replay, still under a first run.
//
// The numbers below are *initial tuning*. What a modifier does on the surface
// lives in the scene (`elite_surge` through the spawn director's `eliteMult`,
// `swarm` through its ramp, `storm_front` through `Weather.setCalmScale`,
// `no_cover` through the shelter gates); this table only says what each one
// is, what it is called, and where it may be offered.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).

export type ContractId = 'elite_surge' | 'swarm' | 'storm_front' | 'no_cover';

export interface ContractDef<Id extends string = string> {
  readonly id: Id;
  /** ≤ 16 characters — the board's contract badge and the banner's row. */
  readonly name: string;
  /** ≤ 80 characters — the badge's `title`. */
  readonly blurb: string;
  /** Offered only on planets whose `surface.weather` is not null. */
  readonly needsWeather: boolean;
  /** Multiplies the ambient elite chance (the spawn director's `eliteMult`). */
  readonly eliteChanceMult?: number;
  /** Multiplies the ambient population target (the director's ramp). */
  readonly populationScale?: number;
  /** Multiplies every calm window rolled while it is in force. */
  readonly calmScale?: number;
  /** `false`: a shelter still hides the player, but no longer keeps the weather off. */
  readonly sheltersKeepWeather?: false;
}

/** §4.3, in table order — the order `contractFor` picks over. */
export const CONTRACTS = {
  elite_surge: {
    id: 'elite_surge',
    name: 'Elite surge',
    blurb: 'Four times the elites, and their lithium with them.',
    needsWeather: false,
    eliteChanceMult: 4,
  },
  swarm: {
    id: 'swarm',
    name: 'Swarm',
    blurb: 'Half as many hostiles again on the ground.',
    needsWeather: false,
    populationScale: 1.5,
  },
  storm_front: {
    id: 'storm_front',
    name: 'Storm front',
    blurb: 'The calm between storms is a quarter as long.',
    needsWeather: true,
    calmScale: 0.25,
  },
  no_cover: {
    id: 'no_cover',
    name: 'No cover',
    blurb: 'Caves and wrecks still hide you, but the weather gets in.',
    needsWeather: true,
    sheltersKeepWeather: false,
  },
} as const satisfies Readonly<Record<ContractId, ContractDef<ContractId>>>;

/** Every contract id, in the table's order. */
export const CONTRACT_IDS = ['elite_surge', 'swarm', 'storm_front', 'no_cover'] as const satisfies readonly ContractId[];

/** §4.3: a contract pays this share of the mission's XP and tokens, floored. */
export const CONTRACT_REWARD_FRACTION = 0.75;
/**
 * SPEC-066 §4.5 (PLAN R27 decision 5): a contract on a boss mission — one with
 * a `boss` objective in any stage — pays this share of its tokens instead.
 */
export const CONTRACT_BOSS_TOKEN_FRACTION = 0.5;
/** §4.3: and this much lithium on top, as a reward — past the cargo cap. */
export const CONTRACT_LITHIUM = 20;
