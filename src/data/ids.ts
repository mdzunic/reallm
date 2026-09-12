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
 * `SaveV1.resources` is a `Record<ResourceId, number>` and SPEC-007's validator
 * clamps it key by key, neither of which means anything against a bare `string`.
 */
export type ResourceId = (typeof RESOURCE_IDS)[number];

/** Order and spelling follow PLAN §5. */
export const PLANET_IDS = ['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden'] as const;
export type PlanetId = (typeof PLANET_IDS)[number];

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
] as const;
export type FlagId = (typeof STORY_FLAGS)[number];

/** PLAN §5 cast. `warden` speaks through the Hive Queen and system notices. */
export const SPEAKERS = ['aria', 'command', 'scav', 'log', 'player', 'warden'] as const;
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
