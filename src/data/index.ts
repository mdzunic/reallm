// The content barrel (SPEC-009 §5). Every data module is imported statically —
// there is no async content loading — and re-exported here so a consumer names
// one module instead of twelve, and so the id unions have a single import site.
//
// `CONTENT` is the same tables in one object, for code that wants to walk the
// whole content set (the invariant test, the campaign simulation of SPEC-016).
//
// The id unions of §3 that name a table — `ClassId`, `CompanionId`, `PlanetId`,
// `ShipSystem`, `WeatherId` — are declared as arrays in `ids.ts` and the tables
// that use them are `satisfies Record<ThatUnion, Def>`, which is stronger than
// `keyof typeof`: it makes a missing entry a compile error rather than a
// narrower union. `tests/data/content.test.ts` pins that the keys and the arrays
// still agree. Every other table derives its ids with `keyof typeof`.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
export * from '@/data/assets';
export * from '@/data/characters';
export * from '@/data/companions';
export * from '@/data/dialogue';
export * from '@/data/enemies';
export * from '@/data/followers';
export * from '@/data/ids';
export * from '@/data/items';
export * from '@/data/loot';
export * from '@/data/missions';
export * from '@/data/planets';
export * from '@/data/pois';
export * from '@/data/recipes';
export * from '@/data/tuning';
export * from '@/data/upgrades';
export * from '@/data/waves';

import { ASSETS } from '@/data/assets';
import { CLASSES } from '@/data/characters';
import { COMPANIONS } from '@/data/companions';
import { DIALOGUE } from '@/data/dialogue';
import { ENEMIES } from '@/data/enemies';
import { FOLLOWERS } from '@/data/followers';
import { ITEMS } from '@/data/items';
import { LOOT_TABLES } from '@/data/loot';
import { MISSIONS } from '@/data/missions';
import { PLANETS } from '@/data/planets';
import { POI_LABELS } from '@/data/pois';
import { RECIPES } from '@/data/recipes';
import { TUNING } from '@/data/tuning';
import { UPGRADES } from '@/data/upgrades';
import { WAVES } from '@/data/waves';

import type { EnemyId } from '@/data/enemies';
import type { WeatherId } from '@/data/ids';

/**
 * What hurt the player (SPEC-011 §3). Declared here rather than in
 * `systems/Combat.ts` — which re-exports it — because `core/Events.ts` carries
 * it in `player:damaged`/`player:died` payloads and `core/` may not import
 * `systems/` (SPEC-001 §4). `ids.ts` stays the leaf: `EnemyId` is derived from
 * a table, so only the barrel can name it without a cycle.
 */
export type DamageSource =
  | { kind: 'enemy'; enemyId: EnemyId }
  | { kind: 'weather'; weather: WeatherId }
  | { kind: 'projectile'; enemyId: EnemyId }
  | { kind: 'fall' }
  // The two flight-only causes (SPEC-013 §4.3, §4.5): an asteroid has no
  // `EnemyId` and a storm is the ship's weather, not the suit's.
  | { kind: 'asteroid' }
  | { kind: 'storm' };

export const CONTENT = {
  assets: ASSETS,
  classes: CLASSES,
  companions: COMPANIONS,
  dialogue: DIALOGUE,
  enemies: ENEMIES,
  followers: FOLLOWERS,
  items: ITEMS,
  loot: LOOT_TABLES,
  missions: MISSIONS,
  planets: PLANETS,
  poiLabels: POI_LABELS,
  recipes: RECIPES,
  tuning: TUNING,
  upgrades: UPGRADES,
  waves: WAVES,
} as const;
