// Hazards (SPEC-068, PLAN R28): the traps that fire on their own and the
// helpers the player sets off with a shot. Every planet has one kind of trap
// and two kinds of helper; `planets.ts` says how many groups of each the
// layout seed places, and `systems/Hazards.ts` places and runs them.
//
// Four archetypes share the rules (SPEC-068 §4.2):
// - `vent`: erupts on its own cycle, behind a filling circle;
// - `mine`: triggers when anything comes within `radius`, bursts `warn` later;
// - `topple`: a solid prop that falls the way the shot that hit it flew and
//   crushes a lane `reach` long and `width` wide;
// - `volatile`: a solid prop that bursts in a circle `warn` after a hit.
//
// Damage is a share of max HP, so a hazard means the same thing on every
// planet: the player's share is scaled by the difficulty's `enemyDamageMult`,
// an elite takes half the enemy share, and a boss takes its own small share
// (*initial tuning*, PLAN R28 decision 4).
//
// Data modules are plain objects: no imports, no functions (SPEC-001 §4, §8).

export type HazardArchetype = 'vent' | 'mine' | 'topple' | 'volatile';

/** The procedural shape `views/HazardMeshes.ts` builds for a hazard (SPEC-068 §4.8). */
export type HazardShape =
  | 'mound'
  | 'tripmine'
  | 'pod'
  | 'hoodoo'
  | 'column'
  | 'prism'
  | 'spire'
  | 'trunk'
  | 'drum'
  | 'tank'
  | 'bulb';

export interface HazardDef {
  readonly archetype: HazardArchetype;
  /** The death overlay's words, `Killed by ${name}`, and the tip's. */
  readonly name: string;
  /**
   * The prop's circle, in metres: a helper's solid body, which stops shots
   * and bodies; a mine's trigger; a vent's mouth.
   */
  readonly radius: number;
  /** Where it lands: a vent's, a mine's or a volatile's circle radius; a toppler's lane length. */
  readonly reach: number;
  /** A toppler's lane width, in metres. */
  readonly width?: number;
  /** Seconds of warning: a vent's charge, a mine's or a volatile's fuse, a toppler's fall. */
  readonly warn: number;
  /** A vent's seconds between eruptions, drawn per cycle. */
  readonly period?: readonly [number, number];
  /** The share of the player's max HP a hit takes, before the difficulty. */
  readonly player: number;
  /** The share of an enemy's max HP a hit takes; an elite takes half. */
  readonly enemy: number;
  /** The share of a boss's max HP a hit takes. */
  readonly boss: number;
  /** Enemies hit move at `mult` of their speed for `seconds` (a boss at half the effect). */
  readonly chill?: { readonly mult: number; readonly seconds: number };
  readonly look: {
    readonly shape: HazardShape;
    readonly body: string;
    readonly accent: string;
    /** The warning light, a vent's mouth, a fuse's flash. */
    readonly glow: string;
    /** Standing height, in metres. */
    readonly height: number;
  };
}

/** SPEC-068 §3: every toppler staggers what it lands on. */
const TOPPLE_STAGGER = { mult: 0.3, seconds: 2 } as const;

export const HAZARDS = {
  // ------------------------------------------------------------- Cinder-4
  scav_mine: {
    archetype: 'mine',
    name: 'a scav tripmine',
    radius: 1.6,
    reach: 3.5,
    warn: 0.9,
    player: 0.22,
    enemy: 0.6,
    boss: 0.02,
    look: { shape: 'tripmine', body: '#4a463a', accent: '#b0a070', glow: '#ff3b2a', height: 0.18 },
  },
  balanced_rock: {
    archetype: 'topple',
    name: 'a falling rock',
    radius: 1.0,
    reach: 8,
    width: 3,
    warn: 0.7,
    player: 0.3,
    enemy: 1,
    boss: 0.04,
    chill: TOPPLE_STAGGER,
    look: { shape: 'hoodoo', body: '#b9824c', accent: '#7a4a22', glow: '#ffd27a', height: 4.6 },
  },
  fuel_drum: {
    archetype: 'volatile',
    name: 'a fuel drum',
    radius: 0.6,
    reach: 4.5,
    warn: 0.35,
    player: 0.2,
    enemy: 0.7,
    boss: 0.025,
    look: { shape: 'drum', body: '#a8402a', accent: '#2a2622', glow: '#ffb347', height: 1.1 },
  },

  // ---------------------------------------------------------------- Vetra
  cryo_geyser: {
    archetype: 'vent',
    name: 'a cryo geyser',
    radius: 1.0,
    reach: 3,
    warn: 1.2,
    period: [6, 10],
    player: 0.15,
    enemy: 0.35,
    boss: 0.015,
    chill: { mult: 0.5, seconds: 3 },
    look: { shape: 'mound', body: '#b4cddd', accent: '#5d7f99', glow: '#8fe8ff', height: 0.5 },
  },
  ice_pillar: {
    archetype: 'topple',
    name: 'a falling ice pillar',
    radius: 0.9,
    reach: 8,
    width: 3,
    warn: 0.7,
    player: 0.3,
    enemy: 1,
    boss: 0.04,
    chill: TOPPLE_STAGGER,
    look: { shape: 'spire', body: '#cfe8f7', accent: '#6fa5c9', glow: '#bff4ff', height: 5 },
  },
  coolant_tank: {
    archetype: 'volatile',
    name: 'a coolant tank',
    radius: 0.65,
    reach: 4.5,
    warn: 0.35,
    player: 0.2,
    enemy: 0.7,
    boss: 0.025,
    chill: { mult: 0.4, seconds: 4 },
    look: { shape: 'tank', body: '#d9dfe4', accent: '#2f6f9a', glow: '#8fe8ff', height: 1.3 },
  },

  // ------------------------------------------------------------- Thessaly
  spore_pod: {
    archetype: 'mine',
    name: 'a spore pod',
    radius: 1.6,
    reach: 3.2,
    warn: 0.9,
    player: 0.22,
    enemy: 0.6,
    boss: 0.02,
    look: { shape: 'pod', body: '#6d8a3a', accent: '#c8d65a', glow: '#d8ff6a', height: 0.6 },
  },
  ruin_column: {
    archetype: 'topple',
    name: 'a falling column',
    radius: 1.0,
    reach: 8,
    width: 3,
    warn: 0.7,
    player: 0.3,
    enemy: 1,
    boss: 0.04,
    chill: TOPPLE_STAGGER,
    look: { shape: 'column', body: '#b3aa92', accent: '#6f6a58', glow: '#fff1c0', height: 5 },
  },
  gas_bloom: {
    archetype: 'volatile',
    name: 'a gas bloom',
    radius: 0.7,
    reach: 4.5,
    warn: 0.35,
    player: 0.2,
    enemy: 0.7,
    boss: 0.025,
    look: { shape: 'bulb', body: '#6f8f3c', accent: '#3d5222', glow: '#f0ff7a', height: 1.4 },
  },

  // --------------------------------------------------------------- Ferrum
  lava_vent: {
    archetype: 'vent',
    name: 'a lava vent',
    radius: 1.0,
    reach: 3,
    warn: 1.2,
    period: [5, 9],
    player: 0.15,
    enemy: 0.35,
    boss: 0.015,
    look: { shape: 'mound', body: '#4d413a', accent: '#2a1f1a', glow: '#ff7a2a', height: 0.6 },
  },
  basalt_column: {
    archetype: 'topple',
    name: 'a falling basalt column',
    radius: 1.0,
    reach: 8,
    width: 3,
    warn: 0.7,
    player: 0.3,
    enemy: 1,
    boss: 0.04,
    chill: TOPPLE_STAGGER,
    look: { shape: 'prism', body: '#7a7068', accent: '#3a322d', glow: '#ff9a4a', height: 4.8 },
  },
  magma_blister: {
    archetype: 'volatile',
    name: 'a magma blister',
    radius: 0.7,
    reach: 4.5,
    warn: 0.35,
    player: 0.2,
    enemy: 0.7,
    boss: 0.025,
    look: { shape: 'bulb', body: '#7d4636', accent: '#3a2420', glow: '#ffa040', height: 1.0 },
  },

  // -------------------------------------------------------------- The Hive
  bile_geyser: {
    archetype: 'vent',
    name: 'a bile geyser',
    radius: 1.0,
    reach: 3,
    warn: 1.2,
    period: [6, 10],
    player: 0.15,
    enemy: 0.35,
    boss: 0.015,
    look: { shape: 'mound', body: '#5a456e', accent: '#3a2a4a', glow: '#b6ff4a', height: 0.5 },
  },
  chitin_spire: {
    archetype: 'topple',
    name: 'a falling chitin spire',
    radius: 0.9,
    reach: 8,
    width: 3,
    warn: 0.7,
    player: 0.3,
    enemy: 1,
    boss: 0.04,
    chill: TOPPLE_STAGGER,
    look: { shape: 'spire', body: '#7a6696', accent: '#4a3060', glow: '#e08aff', height: 5.2 },
  },
  spore_sac: {
    archetype: 'volatile',
    name: 'a spore sac',
    radius: 0.7,
    reach: 4.5,
    warn: 0.35,
    player: 0.2,
    enemy: 0.7,
    boss: 0.025,
    look: { shape: 'bulb', body: '#9a62ad', accent: '#4a2a5a', glow: '#f0a0ff', height: 1.2 },
  },

  // ----------------------------------------------------------------- Eden
  water_main: {
    archetype: 'vent',
    name: 'a burst water main',
    radius: 0.9,
    reach: 2.8,
    warn: 1.2,
    period: [6, 10],
    player: 0.15,
    enemy: 0.35,
    boss: 0.015,
    look: { shape: 'mound', body: '#8a958a', accent: '#55625a', glow: '#9fe0ff', height: 0.4 },
  },
  dead_oak: {
    archetype: 'topple',
    name: 'a falling tree',
    radius: 0.9,
    reach: 8,
    width: 3,
    warn: 0.7,
    player: 0.3,
    enemy: 1,
    boss: 0.04,
    chill: TOPPLE_STAGGER,
    look: { shape: 'trunk', body: '#6a5644', accent: '#3a2e24', glow: '#ffe2a0', height: 5 },
  },
  fertiliser_tank: {
    archetype: 'volatile',
    name: 'a fertiliser tank',
    radius: 0.65,
    reach: 4.5,
    warn: 0.35,
    player: 0.2,
    enemy: 0.7,
    boss: 0.025,
    look: { shape: 'tank', body: '#d8d0b0', accent: '#4a7a3a', glow: '#ffe080', height: 1.2 },
  },
} as const satisfies Record<string, HazardDef>;

export type HazardId = keyof typeof HAZARDS;

/**
 * SPEC-068 §4.1: how many of a hazard the layout seed places on a planet —
 * `groups` clusters of `per` (inclusive) in the open, and `arena` more in
 * every boss arena (helpers only; traps never stand in an arena).
 */
export interface HazardPlacement {
  readonly id: HazardId;
  readonly groups: number;
  readonly per: readonly [number, number];
  readonly arena: number;
}
