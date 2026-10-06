// The id unions of SPEC-009 §3: the ones that are *not* the keys of a content
// table, plus the derived aliases that make every cross-reference in `data/` a
// compile-time check (SPEC-009 §2, first decision).
//
// The rest — `ItemId`, `EnemyId`, `PoiId`, `WaveId`, `MissionId`, `DialogueId`,
// `LootTableId`, `RecipeId`, `FollowerId` — are `keyof typeof <TABLE>` and live
// in their own modules, so this file stays the leaf everything else imports:
// `ids.ts` first, then the leaf tables, then missions, then planets (§2).
// `data/index.ts` re-exports all of them in one place.
//
// Data modules are plain objects: no imports, no functions (SPEC-001 §4, §8).

/** PLAN §4: fuel, consumable crafting, support crafting, tier-3 energy tech. */
export const RESOURCE_IDS = ['oil', 'wheat', 'water', 'lithium'] as const;
/**
 * Already a union, unlike the placeholder aliases this file used to carry:
 * `Save.resources` is a `Record<ResourceId, number>` and SPEC-007's validator
 * clamps it key by key, neither of which means anything against a bare `string`.
 */
export type ResourceId = (typeof RESOURCE_IDS)[number];

/** Order and spelling follow PLAN §5. */
export const PLANET_IDS = ['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden'] as const;
export type PlanetId = (typeof PLANET_IDS)[number];

/**
 * SPEC-047 §4.2: the four kinds of cache a planet's caves hold (SPEC-054). The
 * slot of an id is its suffix; SPEC-054's `CACHES[id].slot` carries it as data.
 */
export type CacheSlot = 'loose_a' | 'loose_b' | 'vault' | 'relic';

/**
 * SPEC-047 §4.2: every cache a save may claim, in `PLANET_IDS` order. The Hive
 * has no relic terminal — its landmark anchors `c5_s1` — so there are 23.
 * Declared before SPEC-054 builds the caves so the validator can keep a claim.
 */
export const CACHE_IDS = [
  'cinder4_loose_a',
  'cinder4_loose_b',
  'cinder4_vault',
  'cinder4_relic',
  'vetra_loose_a',
  'vetra_loose_b',
  'vetra_vault',
  'vetra_relic',
  'thessaly_loose_a',
  'thessaly_loose_b',
  'thessaly_vault',
  'thessaly_relic',
  'ferrum_loose_a',
  'ferrum_loose_b',
  'ferrum_vault',
  'ferrum_relic',
  'hive_loose_a',
  'hive_loose_b',
  'hive_vault',
  'eden_loose_a',
  'eden_loose_b',
  'eden_vault',
  'eden_relic',
] as const;
export type CacheId = (typeof CACHE_IDS)[number];

/** The three classes of PLAN §4; `data/characters.ts` carries their stats. */
export const CLASS_IDS = ['marine', 'engineer', 'scout'] as const;
export type ClassId = (typeof CLASS_IDS)[number];

/** The five ship systems of PLAN §4 and §8, each a 0–3 tier in the save. */
export const SHIP_SYSTEMS = ['engine', 'hull', 'shield', 'cargo', 'weapon'] as const;
export type ShipSystem = (typeof SHIP_SYSTEMS)[number];

/** PLAN §4: the six storm kinds, one or two per planet cycle. */
export const WEATHER_IDS = [
  'sandstorm',
  'heatwave',
  'blizzard',
  'avalanche',
  'spore_storm',
  'radiation_storm',
] as const;
export type WeatherId = (typeof WEATHER_IDS)[number];

/**
 * SPEC-038 §3: the difficulty a run is played on — `save.meta.difficulty`, the
 * creation choice and the flight config. Changeable in Settings (PLAN §4).
 * SPEC-043 §4.4 appends `hard`; `core/Save.ts` re-exports both names.
 */
export const DIFFICULTIES = ['casual', 'normal', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/**
 * SPEC-043 §3: where a resource came from. Only `'pickup'` is charged against
 * the cap (SPEC-010 §4.5), and only a pickup counts toward a collect objective
 * (43-h). Declared here so `core/Events.ts` can name it on `resource:collected`;
 * `systems/Economy.ts` re-exports it.
 */
export const RESOURCE_SOURCES = ['pickup', 'reward', 'voucher', 'subsidy'] as const;
export type ResourceSource = (typeof RESOURCE_SOURCES)[number];

/** The five assistants of PLAN §4; `aria` is free from the first save. */
export const COMPANION_IDS = ['scanner_drone', 'combat_drone', 'field_medic', 'quartermaster', 'aria'] as const;
export type CompanionId = (typeof COMPANION_IDS)[number];

/**
 * Every story flag PLAN §5 and §6 name. Missions grant them, planet unlocks and
 * dialogue conditions read them; `c1_oil` is granted and never required, which
 * 09-d allows (flags are also for dialogue).
 */
export const STORY_FLAGS = [
  'c1_oil',
  'chapter1_done',
  'chapter2_done',
  'chapter3_done',
  'chapter4_done',
  'chapter5_done',
  'iteration_log',
  'scaffold_secret',
  'signal_decoded',
  'ending_stay',
  'ending_escape',
  'campaign_done',
  // PLAN R9: a chapter's interlude film has played (SPEC-021 §4.7, SPEC-023 §4.3).
  'interlude1_seen',
  'interlude2_seen',
  'interlude3_seen',
  'interlude4_seen',
  'interlude5_seen',
  // PLAN R19, SPEC-048 §4.2: one flag per clue that had none. `iteration_log`,
  // `scaffold_secret`, `signal_decoded` and `chapter5_done` stand for the other
  // four, so a found clue needs no save field and no migration.
  'clue_raider_echo',
  'clue_scav_echo',
  'clue_hull',
  'clue_ridge_camp',
  'clue_ruins',
  'clue_tally',
  'clue_bark',
  'clue_own_wreck',
  'clue_eden',
  'clue_grove',
  'clue_never_hers',
  // SPEC-049 §3: Iris's letters, read as each one starts (§4.3)…
  'letter1_read',
  'letter2_read',
  'letter3_read',
  'letter4_read',
  'letter5_read',
  // …and the body's clues and the memory answer (§4.5, §4.6). `memory_roof`
  // is the memory clue's id; `memory_tap` and `memory_stair` are its `also`.
  'clue_restart',
  'clue_awake',
  'clue_keepsake',
  'clue_letter_repeat',
  'memory_roof',
  'memory_tap',
  'memory_stair',
  // SPEC-056 §4.7: the six archive shards — each vault's log, set as it starts.
  'shard_cinder4',
  'shard_vetra',
  'shard_thessaly',
  'shard_ferrum',
  'shard_hive',
  'shard_eden',
] as const;
export type FlagId = (typeof STORY_FLAGS)[number];

/**
 * PLAN §5 cast. `warden` speaks through the Hive Queen and system notices.
 * SPEC-049 §4.1: `home` is Iris, the salvager's sister, who speaks only in her letters.
 */
export const SPEAKERS = ['aria', 'command', 'scav', 'log', 'player', 'warden', 'home'] as const;
export type SpeakerId = (typeof SPEAKERS)[number];

/**
 * Procedural mesh recipes (SPEC-009 §4.3). They live here rather than in
 * `views/` because enemies must compile before any view exists; SPEC-012 §4.9
 * builds the actual meshes from these ids.
 */
export const MESH_RECIPE_IDS = [
  'bug',
  'hound',
  'spitter',
  'crawler',
  'wraith',
  'wurmling',
  'worm_boss',
  'titan',
  'queen',
  'egg',
] as const;
export type ProceduralRecipeId = (typeof MESH_RECIPE_IDS)[number];

/**
 * Music cues `PlanetDef.music` picks from (SPEC-009 §4.5). The spec references
 * `MusicId` without defining its source, and `ASSETS.audio` is still empty
 * (SPEC-006 loads audio lazily and owns the files), so the ids are declared
 * here as cues: one calm bed per biome and three combat beds shared by chapter
 * band. SPEC-006 binds each id to a CC0 track.
 */
export const MUSIC_IDS = [
  'calm_desert',
  'calm_ice',
  'calm_jungle',
  'calm_volcanic',
  'calm_hive',
  'calm_temperate',
  'combat_light',
  'combat_heavy',
  'combat_swarm',
] as const;
export type MusicId = (typeof MUSIC_IDS)[number];

/**
 * The ground texture layers of SPEC-018 §4.5 — every planet blends two of
 * them, and `views/ProceduralTextures.ts` can synthesise each one when the
 * committed CC0 file is missing.
 */
export const GROUND_LAYER_IDS = [
  'sand',
  'cracked_earth',
  'rock',
  'snow',
  'ice',
  'moss',
  'jungle_floor',
  'basalt',
  'lava_rock',
  'chitin',
  'flesh',
  'grass',
  'soil',
] as const;
export type GroundLayerId = (typeof GROUND_LAYER_IDS)[number];

/** The instanced detail kinds of SPEC-018 §4.6. */
export type ScatterKind = 'pebbles' | 'tufts' | 'bones' | 'crystals' | 'spores' | 'slag';

/** The decal atlas tiles of SPEC-018 §4.5 (`slick` and `frost` share one). */
export type DecalKind = 'crater' | 'scorch' | 'cracks' | 'slick' | 'frost';

/** The silhouette-ring shapes of SPEC-018 §4.8. */
export type BoundaryKind = 'dunes' | 'ice_wall' | 'jungle_bank' | 'lava_ridge' | 'chitin_wall' | 'hills';

// `DamageSource` used to live here as a `string` placeholder. SPEC-011 owns
// the combat model, and its union needs `EnemyId` — a table-derived id this
// leaf file cannot name — so the real type is declared in `data/index.ts` and
// re-exported by `systems/Combat.ts`.
