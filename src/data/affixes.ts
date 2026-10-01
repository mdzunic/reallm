// Elite affixes (SPEC-041 §4.6, PLAN R18 decision 6). Every elite rolls one
// affix on the planets of chapters 1–3 and two on chapters 4–6, distinct and
// drawn uniformly from the entries whose `archetypes` include its own. Each one
// asks the player a different question — kill it first (mender), flank or
// pierce it (bulwark), dodge sideways (volley), do not stand by the body
// (volatile), keep your distance (swift) — and the elite's nameplate says which.
//
// The numbers below are *initial tuning*. What an affix does lives in
// `systems/Combat.ts` and `systems/EnemyAi.ts`; this table only says who may
// carry it and what it is called.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).

export type AffixId = 'swift' | 'bulwark' | 'volley' | 'mender' | 'volatile';

/** The archetypes an affix can serve — the three that roll elites on the ground. */
export type AffixArchetype = 'swarm' | 'rusher' | 'ranged';

export interface AffixDef {
  readonly id: AffixId;
  /** What the nameplate's second line reads. */
  readonly name: string;
  readonly archetypes: readonly AffixArchetype[];
}

/** §4.6, Pools: `volley` needs a gun, `bulwark` and `volatile` a body that closes. */
export const AFFIXES = {
  swift: { id: 'swift', name: 'Swift', archetypes: ['swarm', 'rusher', 'ranged'] },
  bulwark: { id: 'bulwark', name: 'Bulwark', archetypes: ['swarm', 'rusher'] },
  volley: { id: 'volley', name: 'Volley', archetypes: ['ranged'] },
  mender: { id: 'mender', name: 'Mender', archetypes: ['swarm', 'rusher', 'ranged'] },
  volatile: { id: 'volatile', name: 'Volatile', archetypes: ['swarm', 'rusher'] },
} as const satisfies Readonly<Record<AffixId, AffixDef>>;

/** Every affix id, in the table's order — the order `rollAffixes` draws over. */
export const AFFIX_IDS = ['swift', 'bulwark', 'volley', 'mender', 'volatile'] as const satisfies readonly AffixId[];

/** `swift`: speed × this on top of the elite ×1.1, and every windup × the scale. */
export const SWIFT_SPEED_MULT = 1.35;
export const SWIFT_WINDUP_SCALE = 0.8;
/** `bulwark`: a shot arriving within ±60° of the facing (cos ≥ 0.5) deals ×0.25. */
export const BULWARK_ARC_COS = 0.5;
export const BULWARK_DAMAGE_MULT = 0.25;
/** `volley`: three shots at 0 and ±0.25 rad, at ×1.2 projectile speed. */
export const VOLLEY_SPREAD = 0.25;
export const VOLLEY_SPEED_MULT = 1.2;
/** `mender`: every 0.5 s, others within 8 m regain 1.5 % of their max HP. */
export const MENDER_RADIUS = 8;
export const MENDER_PULSE_SECONDS = 0.5;
export const MENDER_HEAL_FRACTION = 0.015;
/** `volatile`: at its death a radius-3 circle lands 1 s later for ×1.5 its species' damage. */
export const VOLATILE_RADIUS = 3;
export const VOLATILE_FUSE = 1.0;
export const VOLATILE_DAMAGE_MULT = 1.5;
