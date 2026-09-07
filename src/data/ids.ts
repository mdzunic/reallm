// Shared content ids. SPEC-009 lands the full planet table in `data/planets.ts`;
// scene params (SPEC-003 §3) only need the id union, so the ids live here with
// the other cross-cutting ones. Order and spelling follow PLAN §5.
//
// Data modules are plain objects: no imports, no functions (SPEC-001 §4, §8).

export const PLANET_IDS = ['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden'] as const;

export type PlanetId = (typeof PLANET_IDS)[number];

// The ids `GameEvents` (SPEC-004 §3.2) references before their content tables
// exist. Each one is a placeholder alias; SPEC-009 narrows it to the
// string-literal union derived from its table, and nothing but the alias body
// changes then — no event name and no payload field moves (SPEC-004 D-3).
// Types only: `data/` imports nothing and carries no runtime code
// (SPEC-001 §4, §8).

/** SPEC-009 narrows this to the union of `data/resources.ts` keys. */
export type ResourceId = string;
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
