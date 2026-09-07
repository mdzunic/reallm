// Shared content ids. SPEC-009 lands the full planet table in `data/planets.ts`;
// scene params (SPEC-003 §3) only need the id union, so the ids live here with
// the other cross-cutting ones. Order and spelling follow PLAN §5.
//
// Data modules are plain objects: no imports, no functions (SPEC-001 §4, §8).

export const PLANET_IDS = ['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden'] as const;

export type PlanetId = (typeof PLANET_IDS)[number];

// The id sets `SaveV1` (SPEC-007 §3) indexes a record by or names a union of.
// Each one is locked by PLAN §4 and §8, so the save schema can be written
// against it now; SPEC-009 moves the table into its own `data/` module and
// derives the union from that module's keys, which is the same union.

/** The three classes of PLAN §4. */
export const CLASS_IDS = ['marine', 'engineer', 'scout'] as const;
export type ClassId = (typeof CLASS_IDS)[number];

/** PLAN §4: fuel, consumable crafting, support crafting, tier-3 energy tech. */
export const RESOURCE_IDS = ['oil', 'wheat', 'water', 'lithium'] as const;
/**
 * Already a union, unlike the placeholder aliases below: `SaveV1.resources` is
 * a `Record<ResourceId, number>` and SPEC-007's validator clamps it key by key,
 * neither of which means anything against a bare `string`.
 */
export type ResourceId = (typeof RESOURCE_IDS)[number];

/** The five ship systems of PLAN §4 and §8, each a 0–3 tier in the save. */
export const SHIP_SYSTEMS = ['engine', 'hull', 'shield', 'cargo', 'weapon'] as const;
export type ShipSystem = (typeof SHIP_SYSTEMS)[number];

/** The five assistants of PLAN §4; `aria` is free from the first save. */
export const COMPANION_IDS = ['aria', 'scanner_drone', 'combat_drone', 'field_medic', 'quartermaster'] as const;
export type CompanionId = (typeof COMPANION_IDS)[number];

// The ids `GameEvents` (SPEC-004 §3.2) references before their content tables
// exist. Each one is a placeholder alias; SPEC-009 narrows it to the
// string-literal union derived from its table, and nothing but the alias body
// changes then — no event name and no payload field moves (SPEC-004 D-3).
// Types only: `data/` imports nothing and carries no runtime code
// (SPEC-001 §4, §8).

/** SPEC-009 narrows this to the union of `data/items.ts` keys. */
export type ItemId = string;
/** SPEC-009 narrows this to the union of `data/enemies.ts` keys. */
export type EnemyId = string;
/** SPEC-009 narrows this to the union of `data/pois.ts` keys. */
export type PoiId = string;
/** SPEC-009 narrows this to the union of `data/followers.ts` keys. */
export type FollowerId = string;
/** SPEC-009 narrows this to the union of `data/weather.ts` keys. */
export type WeatherId = string;
/** SPEC-009 narrows this to the union of `data/waves.ts` keys. */
export type WaveId = string;
/** SPEC-009 narrows this to the union of `data/missions.ts` keys. */
export type MissionId = string;
/** SPEC-009 narrows this to the union of `data/dialogue.ts` keys. */
export type DialogueId = string;
/** SPEC-009 narrows this to the union of the damage sources it enumerates. */
export type DamageSource = string;
