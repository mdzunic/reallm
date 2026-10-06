// The underground (SPEC-054 §3, §4.4, §4.8): each planet's cave and the
// caches it holds. Plain data, like every other table here — the cave itself
// is generated from the save's layout stream by `systems/Underground.ts`, and
// what a cache pays goes through `Economy.claimCache`.
//
// Every number below is *initial tuning*. SPEC-055 fills the guarded caches'
// rewards and SPEC-056 extends `CacheReward`; nothing here is a requirement,
// a planet unlock or an objective (`tests/data/content.test.ts` holds that).
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { CacheId, CacheSlot, PlanetId, ResourceId } from '@/data/ids';
import type { ItemId } from '@/data/items';

/** §4.4: how a cave is lit — darkness, the grade, the flashlight and the beacons. */
export interface DarkLook {
  /** The background and the fog's colour. */
  readonly background: string;
  /** The linear fog runs from the camera distance over this many metres. */
  readonly fogSpan: number;
  /** The hemisphere's two colours and its intensity below. */
  readonly ambient: { readonly sky: string; readonly ground: string; readonly intensity: number };
  /** The cool rim's intensity below. */
  readonly rim: number;
  /** `scene.environmentIntensity` below. */
  readonly ibl: number;
  /** What the scene hands `renderer.setLook` below. */
  readonly grade: {
    readonly exposure: number;
    readonly bloomThreshold: number;
    readonly bloomStrength: number;
    readonly vignette: number;
    readonly grain: number;
    readonly lift: readonly [number, number, number];
  };
  /** The `SpotLight` of the `spot` modes, and where it aims. */
  readonly flashlight: {
    readonly color: string;
    readonly intensity: number;
    readonly distance: number;
    readonly angle: number;
    readonly penumbra: number;
    readonly decay: number;
    /** Metres ahead of the salvager, along the facing. */
    readonly aimAhead: number;
    /** Metres above the ground the light rides at. */
    readonly height: number;
  };
  /** The biome's beacon: its colour, emissive strength and ground spill. */
  readonly beacons: { readonly color: string; readonly emissive: number; readonly spill: number };
  /** Multiplies the planet's first ground layer on the cave floor. */
  readonly floor: string;
}

/** §3: one planet's cave. */
export interface UndergroundDef {
  readonly planet: PlanetId;
  /** How many rooms, both ends included. */
  readonly rooms: readonly [number, number];
  /** A room's radius band, in metres. */
  readonly roomRadius: readonly [number, number];
  /** Every corridor's width, in metres. */
  readonly corridor: number;
  /** How many pack anchors the cave lays out (and how many packs a descent spawns). */
  readonly packs: number;
  readonly look: DarkLook;
  /** Eden: the machine room (§4.12) — racks for walls, the cradle row, the hum. */
  readonly machineRoom?: true;
}

/** §3: what a cache pays. SPEC-056 extends it. */
export interface CacheReward {
  readonly resources?: Partial<Record<ResourceId, number>>;
  readonly items?: readonly { readonly itemId: ItemId; readonly qty: number }[];
}

/** §3: one cache — its planet, its slot and what keeps it shut. */
export interface CacheDef {
  readonly id: CacheId;
  readonly planet: PlanetId;
  readonly slot: CacheSlot;
  /** `none` opens on `interact`; the rest wait for SPEC-055's puzzles. */
  readonly guard: 'none' | 'world' | 'vault' | 'relic';
  readonly reward: CacheReward;
}

// ------------------------------------------------------------------ the look

/** §4.4: the grade below, shared by every planet. */
const GRADE = {
  exposure: 1.35,
  bloomThreshold: 0.9,
  bloomStrength: 0.5,
  vignette: 0.5,
  grain: 0.015,
  lift: [0.012, 0.014, 0.02],
} as const;

/** §4.4: the flashlight, shared by every planet. */
const FLASHLIGHT = {
  color: '#fff2d8',
  intensity: 45,
  distance: 24,
  angle: 0.42,
  penumbra: 0.5,
  decay: 1.3,
  aimAhead: 7,
  height: 1.7,
} as const;

/** §4.4: the hemisphere below, shared by every planet. */
const AMBIENT = { sky: '#1a2230', ground: '#07080b', intensity: 0.12 } as const;

/** §4.4: the parts of `DarkLook` every planet shares; the beacon and the floor are the biome's. */
const DARK = {
  background: '#05060a',
  fogSpan: 24,
  ambient: AMBIENT,
  rim: 0.15,
  ibl: 0.12,
  grade: GRADE,
  flashlight: FLASHLIGHT,
} as const;

// ----------------------------------------------------------------- the caves

/** §4.3: the room count, the room radius band and the corridor width every cave shares. */
const ROOMS = [5, 7] as const;
const ROOM_RADIUS = [6, 10] as const;
const CORRIDOR = 4.5;

/** §3, §4.4: every planet's cave. Packs 3, 3, 4, 4, 5 — and none on Eden. */
export const UNDERGROUND: { readonly [P in PlanetId]: UndergroundDef } = {
  cinder4: {
    planet: 'cinder4',
    rooms: ROOMS,
    roomRadius: ROOM_RADIUS,
    corridor: CORRIDOR,
    packs: 3,
    look: { ...DARK, beacons: { color: '#ffb45a', emissive: 2.6, spill: 0.35 }, floor: '#5c4a3c' },
  },
  vetra: {
    planet: 'vetra',
    rooms: ROOMS,
    roomRadius: ROOM_RADIUS,
    corridor: CORRIDOR,
    packs: 3,
    look: { ...DARK, beacons: { color: '#7fe0ff', emissive: 2.6, spill: 0.35 }, floor: '#4a5560' },
  },
  thessaly: {
    planet: 'thessaly',
    rooms: ROOMS,
    roomRadius: ROOM_RADIUS,
    corridor: CORRIDOR,
    packs: 4,
    look: { ...DARK, beacons: { color: '#9dff7a', emissive: 2.6, spill: 0.35 }, floor: '#3e4a36' },
  },
  ferrum: {
    planet: 'ferrum',
    rooms: ROOMS,
    roomRadius: ROOM_RADIUS,
    corridor: CORRIDOR,
    packs: 4,
    look: { ...DARK, beacons: { color: '#ff6a3a', emissive: 2.6, spill: 0.35 }, floor: '#4a3a36' },
  },
  hive: {
    planet: 'hive',
    rooms: ROOMS,
    roomRadius: ROOM_RADIUS,
    corridor: CORRIDOR,
    packs: 5,
    look: { ...DARK, beacons: { color: '#d58cff', emissive: 2.6, spill: 0.35 }, floor: '#4a3a4e' },
  },
  eden: {
    planet: 'eden',
    rooms: ROOMS,
    roomRadius: ROOM_RADIUS,
    corridor: CORRIDOR,
    packs: 0,
    look: { ...DARK, beacons: { color: '#9fd8ff', emissive: 2.6, spill: 0.35 }, floor: '#4a5058' },
    machineRoom: true,
  },
};

// ---------------------------------------------------------------- the caches

/** §4.8: a guarded cache pays nothing until SPEC-055 fills it. */
const SEALED: CacheReward = {};

/** §4.8: what every `loose_a` pays besides its lithium — one medkit. */
const MEDKIT = [{ itemId: 'medkit', qty: 1 }] as const;

/**
 * §4.8: all 23 caches of `CACHE_IDS`, with the planet and slot their ids name.
 * A `loose_a` pays lithium `3 + 2 × chapter` — 5, 7, 9, 11, 13, 15 — and one
 * medkit.
 */
export const CACHES: { readonly [C in CacheId]: CacheDef } = {
  cinder4_loose_a: { id: 'cinder4_loose_a', planet: 'cinder4', slot: 'loose_a', guard: 'none', reward: { resources: { lithium: 5 }, items: MEDKIT } },
  cinder4_loose_b: { id: 'cinder4_loose_b', planet: 'cinder4', slot: 'loose_b', guard: 'world', reward: SEALED },
  cinder4_vault: { id: 'cinder4_vault', planet: 'cinder4', slot: 'vault', guard: 'vault', reward: SEALED },
  cinder4_relic: { id: 'cinder4_relic', planet: 'cinder4', slot: 'relic', guard: 'relic', reward: SEALED },
  vetra_loose_a: { id: 'vetra_loose_a', planet: 'vetra', slot: 'loose_a', guard: 'none', reward: { resources: { lithium: 7 }, items: MEDKIT } },
  vetra_loose_b: { id: 'vetra_loose_b', planet: 'vetra', slot: 'loose_b', guard: 'world', reward: SEALED },
  vetra_vault: { id: 'vetra_vault', planet: 'vetra', slot: 'vault', guard: 'vault', reward: SEALED },
  vetra_relic: { id: 'vetra_relic', planet: 'vetra', slot: 'relic', guard: 'relic', reward: SEALED },
  thessaly_loose_a: { id: 'thessaly_loose_a', planet: 'thessaly', slot: 'loose_a', guard: 'none', reward: { resources: { lithium: 9 }, items: MEDKIT } },
  thessaly_loose_b: { id: 'thessaly_loose_b', planet: 'thessaly', slot: 'loose_b', guard: 'world', reward: SEALED },
  thessaly_vault: { id: 'thessaly_vault', planet: 'thessaly', slot: 'vault', guard: 'vault', reward: SEALED },
  thessaly_relic: { id: 'thessaly_relic', planet: 'thessaly', slot: 'relic', guard: 'relic', reward: SEALED },
  ferrum_loose_a: { id: 'ferrum_loose_a', planet: 'ferrum', slot: 'loose_a', guard: 'none', reward: { resources: { lithium: 11 }, items: MEDKIT } },
  ferrum_loose_b: { id: 'ferrum_loose_b', planet: 'ferrum', slot: 'loose_b', guard: 'world', reward: SEALED },
  ferrum_vault: { id: 'ferrum_vault', planet: 'ferrum', slot: 'vault', guard: 'vault', reward: SEALED },
  ferrum_relic: { id: 'ferrum_relic', planet: 'ferrum', slot: 'relic', guard: 'relic', reward: SEALED },
  hive_loose_a: { id: 'hive_loose_a', planet: 'hive', slot: 'loose_a', guard: 'none', reward: { resources: { lithium: 13 }, items: MEDKIT } },
  hive_loose_b: { id: 'hive_loose_b', planet: 'hive', slot: 'loose_b', guard: 'world', reward: SEALED },
  hive_vault: { id: 'hive_vault', planet: 'hive', slot: 'vault', guard: 'vault', reward: SEALED },
  eden_loose_a: { id: 'eden_loose_a', planet: 'eden', slot: 'loose_a', guard: 'none', reward: { resources: { lithium: 15 }, items: MEDKIT } },
  eden_loose_b: { id: 'eden_loose_b', planet: 'eden', slot: 'loose_b', guard: 'world', reward: SEALED },
  eden_vault: { id: 'eden_vault', planet: 'eden', slot: 'vault', guard: 'vault', reward: SEALED },
  eden_relic: { id: 'eden_relic', planet: 'eden', slot: 'relic', guard: 'relic', reward: SEALED },
};
