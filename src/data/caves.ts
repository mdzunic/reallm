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
import type { SwatchId } from '@/data/cosmetics';
import type { CacheId, CacheSlot, FlagId, PlanetId, ResourceId } from '@/data/ids';
import type { ItemId } from '@/data/items';
import type { RecipeId } from '@/data/recipes';

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

/**
 * §3: what a cache pays. SPEC-056 §3 extends it with the treasure: a vault's
 * tokens, relic and archive shard, a world puzzle's blueprint, and a suit
 * swatch. None of the five enters the pack — tokens go through `Progression`,
 * a relic and a blueprint derive from `progress.claimed`, a swatch is the
 * device's (`settings.unlocks`) and a shard is a clue's flag.
 */
export interface CacheReward {
  readonly resources?: Partial<Record<ResourceId, number>>;
  readonly items?: readonly { readonly itemId: ItemId; readonly qty: number }[];
  /** SPEC-056 §4.2: vaults only — `TREASURE_TOKENS_PER_VAULT`. */
  readonly tokens?: number;
  /** SPEC-056 §4.3: an item with `relic: true`, racked on the claim. */
  readonly relic?: ItemId;
  /** SPEC-056 §4.5: a recipe whose `requires` is this cache. */
  readonly blueprint?: RecipeId;
  /** SPEC-056 §4.6: unlocked on this device when the cache opens. */
  readonly swatch?: SwatchId;
  /** SPEC-056 §4.7: `shard_<planet>`, the vault's archive log. */
  readonly shard?: FlagId;
}

/** SPEC-056 §4.2: what every vault pays in tokens — 30 over the six, counted by `treasureTokens()`. */
export const TREASURE_TOKENS_PER_VAULT = 5;

/** §3: one cache — its planet, its slot and what keeps it shut. */
export interface CacheDef {
  readonly id: CacheId;
  readonly planet: PlanetId;
  readonly slot: CacheSlot;
  /** `none` opens on `interact`; the rest open when SPEC-055's puzzle at their site is solved. */
  readonly guard: 'none' | 'world' | 'vault' | 'relic';
  readonly reward: CacheReward;
  /**
   * SPEC-055 §4.8: paid on top of `reward` only by a flawless claim — a solve
   * ARIA did not force (`Economy.claimCache(id, { flawless })`).
   */
  readonly flawless?: CacheReward;
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

/** §4.8: what every `loose_a` pays besides its lithium — one medkit. */
const MEDKIT = [{ itemId: 'medkit', qty: 1 }] as const;

/**
 * SPEC-055 §4.8 (*initial tuning*): a guarded cache's pay, `c` the planet's
 * chapter. A `loose_b` — the world puzzle's — pays oil `10 + 5c` and two of the
 * chapter's explosive (`frag_grenade` in chapters 1–2, `landmine` in 3–4,
 * `demo_charge` in 5–6). A `vault` pays lithium `5 + 3c`, a plasma cell and a
 * coolant pack, and a medkit more when it is opened flawlessly. A `relic` pays
 * lithium 5 and a plasma cell.
 */
const VAULT_ITEMS = [
  { itemId: 'plasma_cell', qty: 1 },
  { itemId: 'coolant_pack', qty: 1 },
] as const;
const VAULT_FLAWLESS: CacheReward = { items: MEDKIT };
const RELIC_RESOURCES = { lithium: 5 } as const;
const RELIC_ITEMS = [{ itemId: 'plasma_cell', qty: 1 }] as const;
const FRAG = [{ itemId: 'frag_grenade', qty: 2 }] as const;
const MINES = [{ itemId: 'landmine', qty: 2 }] as const;
const CHARGES = [{ itemId: 'demo_charge', qty: 2 }] as const;

/** SPEC-056 §4.1: what every vault adds to its base pay. */
const VAULT_TOKENS = TREASURE_TOKENS_PER_VAULT;

/**
 * §4.8: all 23 caches of `CACHE_IDS`, with the planet and slot their ids name.
 * A `loose_a` pays lithium `3 + 2 × chapter` — 5, 7, 9, 11, 13, 15 — and one
 * medkit; the guarded ones pay SPEC-055 §4.8's table above.
 *
 * SPEC-056 §4.1 adds the treasure: each vault's 5 tokens and archive shard,
 * chapters 1–5's vault relic and Eden's vault swatch, Vetra's and Thessaly's
 * world-puzzle blueprints, and each surface relic terminal's swatch of its own
 * id. Every `loose_a` and the other four `loose_b` add nothing.
 */
export const CACHES: { readonly [C in CacheId]: CacheDef } = {
  cinder4_loose_a: { id: 'cinder4_loose_a', planet: 'cinder4', slot: 'loose_a', guard: 'none', reward: { resources: { lithium: 5 }, items: MEDKIT } },
  cinder4_loose_b: { id: 'cinder4_loose_b', planet: 'cinder4', slot: 'loose_b', guard: 'world', reward: { resources: { oil: 15 }, items: FRAG } },
  cinder4_vault: {
    id: 'cinder4_vault',
    planet: 'cinder4',
    slot: 'vault',
    guard: 'vault',
    reward: { resources: { lithium: 8 }, items: VAULT_ITEMS, tokens: VAULT_TOKENS, relic: 'relic_last_word', shard: 'shard_cinder4' },
    flawless: VAULT_FLAWLESS,
  },
  cinder4_relic: { id: 'cinder4_relic', planet: 'cinder4', slot: 'relic', guard: 'relic', reward: { resources: RELIC_RESOURCES, items: RELIC_ITEMS, swatch: 'cinder4_relic' } },
  vetra_loose_a: { id: 'vetra_loose_a', planet: 'vetra', slot: 'loose_a', guard: 'none', reward: { resources: { lithium: 7 }, items: MEDKIT } },
  vetra_loose_b: { id: 'vetra_loose_b', planet: 'vetra', slot: 'loose_b', guard: 'world', reward: { resources: { oil: 20 }, items: FRAG, blueprint: 'flare' } },
  vetra_vault: {
    id: 'vetra_vault',
    planet: 'vetra',
    slot: 'vault',
    guard: 'vault',
    reward: { resources: { lithium: 11 }, items: VAULT_ITEMS, tokens: VAULT_TOKENS, relic: 'relic_cold_coil', shard: 'shard_vetra' },
    flawless: VAULT_FLAWLESS,
  },
  vetra_relic: { id: 'vetra_relic', planet: 'vetra', slot: 'relic', guard: 'relic', reward: { resources: RELIC_RESOURCES, items: RELIC_ITEMS, swatch: 'vetra_relic' } },
  thessaly_loose_a: { id: 'thessaly_loose_a', planet: 'thessaly', slot: 'loose_a', guard: 'none', reward: { resources: { lithium: 9 }, items: MEDKIT } },
  thessaly_loose_b: { id: 'thessaly_loose_b', planet: 'thessaly', slot: 'loose_b', guard: 'world', reward: { resources: { oil: 25 }, items: MINES, blueprint: 'stim' } },
  thessaly_vault: {
    id: 'thessaly_vault',
    planet: 'thessaly',
    slot: 'vault',
    guard: 'vault',
    reward: { resources: { lithium: 14 }, items: VAULT_ITEMS, tokens: VAULT_TOKENS, relic: 'relic_seed_drum', shard: 'shard_thessaly' },
    flawless: VAULT_FLAWLESS,
  },
  thessaly_relic: { id: 'thessaly_relic', planet: 'thessaly', slot: 'relic', guard: 'relic', reward: { resources: RELIC_RESOURCES, items: RELIC_ITEMS, swatch: 'thessaly_relic' } },
  ferrum_loose_a: { id: 'ferrum_loose_a', planet: 'ferrum', slot: 'loose_a', guard: 'none', reward: { resources: { lithium: 11 }, items: MEDKIT } },
  ferrum_loose_b: { id: 'ferrum_loose_b', planet: 'ferrum', slot: 'loose_b', guard: 'world', reward: { resources: { oil: 30 }, items: MINES } },
  ferrum_vault: {
    id: 'ferrum_vault',
    planet: 'ferrum',
    slot: 'vault',
    guard: 'vault',
    reward: { resources: { lithium: 17 }, items: VAULT_ITEMS, tokens: VAULT_TOKENS, relic: 'relic_slag_vent', shard: 'shard_ferrum' },
    flawless: VAULT_FLAWLESS,
  },
  ferrum_relic: { id: 'ferrum_relic', planet: 'ferrum', slot: 'relic', guard: 'relic', reward: { resources: RELIC_RESOURCES, items: RELIC_ITEMS, swatch: 'ferrum_relic' } },
  hive_loose_a: { id: 'hive_loose_a', planet: 'hive', slot: 'loose_a', guard: 'none', reward: { resources: { lithium: 13 }, items: MEDKIT } },
  hive_loose_b: { id: 'hive_loose_b', planet: 'hive', slot: 'loose_b', guard: 'world', reward: { resources: { oil: 35 }, items: CHARGES } },
  hive_vault: {
    id: 'hive_vault',
    planet: 'hive',
    slot: 'vault',
    guard: 'vault',
    reward: { resources: { lithium: 20 }, items: VAULT_ITEMS, tokens: VAULT_TOKENS, relic: 'relic_seeker', shard: 'shard_hive' },
    flawless: VAULT_FLAWLESS,
  },
  eden_loose_a: { id: 'eden_loose_a', planet: 'eden', slot: 'loose_a', guard: 'none', reward: { resources: { lithium: 15 }, items: MEDKIT } },
  eden_loose_b: { id: 'eden_loose_b', planet: 'eden', slot: 'loose_b', guard: 'world', reward: { resources: { oil: 40 }, items: CHARGES } },
  eden_vault: {
    id: 'eden_vault',
    planet: 'eden',
    slot: 'vault',
    guard: 'vault',
    reward: { resources: { lithium: 23 }, items: VAULT_ITEMS, tokens: VAULT_TOKENS, swatch: 'eden_vault', shard: 'shard_eden' },
    flawless: VAULT_FLAWLESS,
  },
  eden_relic: { id: 'eden_relic', planet: 'eden', slot: 'relic', guard: 'relic', reward: { resources: RELIC_RESOURCES, items: RELIC_ITEMS, swatch: 'eden_relic' } },
};
