// The balance model (SPEC-010 §5). Pure arithmetic over the content tables: no
// save, no events, nothing to construct. `tests/systems/balance.test.ts` turns
// it into the invariant suite that makes a design regression a failing build,
// and the debug overlay reads the same numbers.
//
// The model is deliberately pessimistic. "Worst case" is a player who does the
// main missions and nothing else: no side missions, no kill XP, no salvage. If
// the recommended loadout still fits inside that budget, then every real player
// can afford to be somewhere it does — which is the whole content of E2, the
// "spent everything and cannot pass the Ferrum gate" case.
//
// Everything here is derived from `data/`, so a retuned reward or price moves
// the model with it and the test catches what that breaks; the numbers the
// spec's table pins (55 · 125 · 210 · 315 · 480 · 670 …) are asserted as
// explicit literals in the test, not restated here.
//
// Pure: no `three`, no DOM, no `Math.random` (SPEC-001 §4, §7).
import {
  CACHE_IDS,
  CACHES,
  COMPANIONS,
  ITEMS,
  LOOT_TABLES,
  MISSIONS,
  PLANETS,
  UPGRADES,
  type CacheReward,
  type Companion,
  type CompanionId,
  type Item,
  type ItemId,
  type LootEntry,
  type LootTableId,
  type MissionDef,
  type MissionId,
  type PlanetDef,
  type PlanetId,
  type ShipSystem,
  type Upgrade,
} from '@/data/index';
import { TOKENS_PER_LEVEL, levelForXp } from '@/systems/Progression';

const MISSION_TABLE: Readonly<Record<MissionId, MissionDef>> = MISSIONS;
const ITEM_TABLE: Readonly<Record<ItemId, Item>> = ITEMS;
const UPGRADE_TABLE: Readonly<Record<ShipSystem, Upgrade>> = UPGRADES;
const COMPANION_TABLE: Readonly<Record<CompanionId, Companion>> = COMPANIONS;
const LOOT_TABLE: Readonly<Record<LootTableId, readonly LootEntry[]>> = LOOT_TABLES;
const PLANET_TABLE: Readonly<Record<PlanetId, PlanetDef>> = PLANETS;

const missions: readonly MissionDef[] = Object.values(MISSION_TABLE);

/**
 * The chapters the loadout table covers. Chapter 1 needs nothing bought: the
 * class starter gear is what Cinder-4 is balanced against.
 */
export const LOADOUT_CHAPTERS = [2, 3, 4, 5, 6] as const;
export type LoadoutChapter = (typeof LOADOUT_CHAPTERS)[number];

/**
 * One line of the §5 table. SPEC-010 §3 writes the id as a bare `string`; it is
 * narrowed to the three id unions here so a renamed item or a mistyped ship
 * system is a compile error rather than a silently-zero price — the same reason
 * SPEC-009 §2 derives its ids from the tables.
 */
export type LoadoutEntry =
  | { readonly kind: 'ship'; readonly id: ShipSystem; readonly tier: 1 | 2 | 3 }
  | { readonly kind: 'gear'; readonly id: ItemId }
  | { readonly kind: 'companion'; readonly id: CompanionId };

/**
 * §5: what a player should own *before* setting out for that chapter,
 * cumulative and undiscounted. Chapter 4's shield tier 2 is the one hard gate —
 * Ferrum refuses to unlock without it (PLAN §5).
 *
 * SPEC-039 §4.2: the Laser Carbine closes chapter 2 — no boss hands it out any
 * more, and the threat past Cinder-4 is tuned for it. Appended after the
 * scanner, so the order the loadout is bought in does not move.
 */
export const RECOMMENDED_LOADOUT: Record<LoadoutChapter, readonly LoadoutEntry[]> = {
  2: [
    { kind: 'gear', id: 'armor_composite' },
    { kind: 'companion', id: 'scanner_drone' },
    { kind: 'gear', id: 'weapon_laser' },
  ],
  3: [
    { kind: 'ship', id: 'hull', tier: 1 },
    { kind: 'ship', id: 'shield', tier: 1 },
  ],
  4: [
    { kind: 'ship', id: 'shield', tier: 2 },
    { kind: 'companion', id: 'combat_drone' },
  ],
  5: [
    { kind: 'gear', id: 'weapon_plasma' },
    { kind: 'ship', id: 'hull', tier: 2 },
    { kind: 'ship', id: 'engine', tier: 1 },
  ],
  6: [
    { kind: 'gear', id: 'armor_reactive' },
    { kind: 'ship', id: 'weapon', tier: 1 },
    { kind: 'companion', id: 'field_medic' },
  ],
};

/** The undiscounted token price of one loadout line. */
export function entryCost(entry: LoadoutEntry): number {
  if (entry.kind === 'ship') return UPGRADE_TABLE[entry.id].tiers[entry.tier - 1]?.tokens ?? 0;
  if (entry.kind === 'gear') return ITEM_TABLE[entry.id].price?.tokens ?? 0;
  return COMPANION_TABLE[entry.id].cost;
}

/** §5: everything the table asks for through `chapter`, added up. */
export function loadoutCost(chapter: number): number {
  let total = 0;
  for (const step of LOADOUT_CHAPTERS) {
    if (step > chapter) continue;
    for (const entry of RECOMMENDED_LOADOUT[step]) total += entryCost(entry);
  }
  return total;
}

function sumRewards(pick: (mission: MissionDef) => boolean, of: 'tokens' | 'xp'): number {
  return missions.filter(pick).reduce((total, mission) => total + mission.rewards[of], 0);
}

/** Main-mission tokens paid out from chapter 1 through `chapter` (§5). */
export function guaranteedMainTokensThrough(chapter: number): number {
  return sumRewards((mission) => mission.type === 'main' && mission.chapter <= chapter, 'tokens');
}

/** Main-mission XP through `chapter` — no kills, no side missions (§5). */
export function guaranteedMainXpThrough(chapter: number): number {
  return sumRewards((mission) => mission.type === 'main' && mission.chapter <= chapter, 'xp');
}

/** Side-mission tokens through `chapter`; the completionist's extra income. */
export function sideTokensThrough(chapter: number): number {
  return sumRewards((mission) => mission.type === 'side' && mission.chapter <= chapter, 'tokens');
}

/**
 * §5: everything a worst-case player can have spent by the time chapter
 * `chapter` starts — main-mission tokens plus 25 for every level mission XP
 * alone bought.
 */
export function worstCaseTokensBefore(chapter: number): number {
  const through = chapter - 1;
  if (through < 1) return 0;
  const levels = levelForXp(guaranteedMainXpThrough(through)) - 1;
  return guaranteedMainTokensThrough(through) + TOKENS_PER_LEVEL * levels;
}

/**
 * PLAN §7: the level a completionist reaches — mission XP *and* kill XP, which
 * only a played run produces, so it is pinned rather than derived. The sink
 * invariant leans on it: 25 × 19 levels is the largest token income the design
 * admits, and the sink has to stay half again as large.
 */
export const COMPLETIONIST_LEVEL = 20;

/**
 * SPEC-056 §4.2: the tokens the caves pay — every `CACHES` row's
 * `reward.tokens`, which only the six vaults carry (5 each, 30 in all).
 * Optional income, so the worst-case model never counts it.
 */
export function treasureTokens(): number {
  let total = 0;
  for (const id of CACHE_IDS) total += (CACHES[id].reward as CacheReward).tokens ?? 0;
  return total;
}

/**
 * PLAN §7: main + side + level tokens, the most a run can earn. SPEC-056 §4.2:
 * plus the vaults' treasure — 1,249 + 30 = 1,279.
 */
export function completionistTokens(): number {
  const chapters = 6;
  return (
    guaranteedMainTokensThrough(chapters) +
    sideTokensThrough(chapters) +
    TOKENS_PER_LEVEL * (COMPLETIONIST_LEVEL - 1) +
    treasureTokens()
  );
}

/** PLAN §7: ship 1,095 + gear 500 + companions 415 = 2,010 tokens of sink. */
export function totalTokenSink(): { ship: number; gear: number; companions: number; total: number } {
  let ship = 0;
  for (const upgrade of Object.values(UPGRADE_TABLE)) {
    for (const tier of upgrade.tiers) ship += tier.tokens;
  }
  let gear = 0;
  for (const item of Object.values(ITEM_TABLE)) gear += item.price?.tokens ?? 0;
  let companions = 0;
  for (const companion of Object.values(COMPANION_TABLE)) {
    companions += companion.cost + companion.upgradeCosts[0] + companion.upgradeCosts[1];
  }
  return { ship, gear, companions, total: ship + gear + companions };
}

/** SPEC-039 §4.2: every `itemId` of a `signature` or `item` row in any loot table. */
export function lootGivenItems(): ReadonlySet<ItemId> {
  const given = new Set<ItemId>();
  for (const table of Object.values(LOOT_TABLE)) {
    for (const entry of table) {
      if (entry.kind === 'signature' || entry.kind === 'item') given.add(entry.itemId);
    }
  }
  return given;
}

/**
 * SPEC-039 §4.2: the part of the sink a player has to *decide* about — every
 * priced weapon and armour piece no loot table hands out (the rifle and armour
 * ladders), the surface and station companions' full ladders, and the most
 * expensive ship gate a planet unlock names (the Ferrum shield, tiers 1…2).
 * The invariant holds it at ≥ 0.75 × `completionistTokens()` (PLAN R18
 * decision 4b), which is what "specialization is forced" means once the free
 * drops are taken out.
 */
export function decisionSink(): { gear: number; companions: number; gate: number; total: number } {
  const given = lootGivenItems();
  let gear = 0;
  for (const item of Object.values(ITEM_TABLE)) {
    if (item.kind === 'consumable' || item.price === null || given.has(item.id)) continue;
    gear += item.price.tokens;
  }
  let companions = 0;
  for (const companion of Object.values(COMPANION_TABLE)) {
    if (companion.domain !== 'surface' && companion.domain !== 'station') continue;
    companions += companion.cost + companion.upgradeCosts[0] + companion.upgradeCosts[1];
  }
  let gate = 0;
  for (const planet of Object.values(PLANET_TABLE)) {
    for (const requirement of planet.unlock) {
      if (requirement.kind !== 'ship') continue;
      let cost = 0;
      for (const tier of UPGRADE_TABLE[requirement.system].tiers.slice(0, requirement.tier)) cost += tier.tokens;
      gate = Math.max(gate, cost);
    }
  }
  return { gear, companions, gate, total: gear + companions + gate };
}

/** The largest single `collect` objective in the campaign (E3, the cargo margin). */
export function largestCollectObjective(): number {
  let largest = 0;
  for (const mission of missions) {
    for (const stage of mission.stages) {
      for (const objective of stage) {
        if (objective.kind === 'collect') largest = Math.max(largest, objective.amount);
      }
    }
  }
  return largest;
}
