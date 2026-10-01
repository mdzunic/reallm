// The content-invariant suite (SPEC-009 §7, extended by SPEC-018 §7,
// SPEC-025 §4.7 and SPEC-029 §4.10). One `it` per invariant, numbered as the specs
// number them. Between them they cover everything the compiler cannot: counts,
// reachability, requirement cycles, POI/objective compatibility, the slot/line
// split, balance pins and text limits (PLAN §11, E26).
//
// The compiler covers the rest — a mission naming an enemy that does not exist
// or a planet gating on a flag that does not exist is a `tsc` failure, which the
// second describe block below demonstrates with `@ts-expect-error`.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { LAUNCH_SECONDS, THROTTLES } from '@/systems/Flight';
import { DASH_IFRAMES } from '@/systems/Dash';
import {
  AFFIX_IDS,
  AFFIXES,
  ATTRIBUTE_EFFECTS,
  ATTRIBUTE_MAX,
  ATTRIBUTE_POINT_LEVELS,
  CLASSES,
  CLASS_IDS,
  COMPANIONS,
  COMPANION_IDS,
  CREATION_POINTS,
  DIALOGUE,
  EFFECT_KEYS_BY_DOMAIN,
  ENEMIES,
  FOLLOWERS,
  GROUND_LAYER_IDS,
  ITEMS,
  LOOT_TABLES,
  MISSIONS,
  PLANETS,
  PLANET_IDS,
  QUICK_PREFERENCE,
  QUICK_SLOTS,
  QUICK_SLOT_OF_EFFECT,
  RECIPES,
  RESOURCE_IDS,
  SHIP_SYSTEMS,
  SIGNATURE_FALLBACK_LITHIUM,
  SLOT_OF_LINE,
  STORY_FLAGS,
  TUNING,
  UPGRADES,
  WAVES,
  type CompanionEffect,
  type DialogueId,
  type Enemy,
  type EnemyId,
  type FlagId,
  type Item,
  type LootEntry,
  type LootTableId,
  type MissionDef,
  type MissionId,
  type Objective,
  type PlanetDef,
  type PlanetId,
  type PoiDef,
  type PoiId,
  type Requirement,
  type ResourceId,
  type WaveDef,
  type WaveId,
} from '@/data/index';
import { iconGlyph } from '@/ui/icons';

type Mission = MissionDef<MissionId>;

// Read through the schema types rather than the `as const` literal types: an
// invariant asks whether an optional field is set, and on a literal type an
// absent optional is not a property at all.
const missions: readonly Mission[] = Object.values(MISSIONS);
const enemies: readonly Enemy[] = Object.values(ENEMIES);
const items: readonly Item[] = Object.values(ITEMS);
const ITEM_TABLE: Readonly<Record<string, Item | undefined>> = ITEMS;
const lootTables: Readonly<Record<LootTableId, readonly LootEntry[]>> = LOOT_TABLES;
const waves: Readonly<Record<WaveId, WaveDef<WaveId>>> = WAVES;
const planetsById: Readonly<Record<PlanetId, PlanetDef>> = PLANETS;
const planets: readonly PlanetDef[] = Object.values(planetsById);

const flagSet = new Set<string>(STORY_FLAGS);
const missionIds = new Set<string>(Object.keys(MISSIONS));
const enemyIds = new Set<string>(Object.keys(ENEMIES));
const itemIds = new Set<string>(Object.keys(ITEMS));
const resourceIds = new Set<string>(RESOURCE_IDS);
const shipSystems = new Set<string>(SHIP_SYSTEMS);

/** Every objective of a mission, flattened, with its stage index for messages. */
function objectivesOf(mission: Mission): { objective: Objective; where: string }[] {
  return mission.stages.flatMap((stage, stageIndex) =>
    stage.map((objective, objectiveIndex) => ({
      objective,
      where: `${mission.id} stage ${stageIndex} objective ${objectiveIndex} (${objective.kind})`,
    })),
  );
}

function poiOf(planet: PlanetDef, id: PoiId): PoiDef | undefined {
  return planet.surface.pois.find((poi) => poi.id === id);
}

/** The waves a mission can pull enemies from: its own, its stages', its planet's. */
function wavesFor(mission: Mission): WaveId[] {
  const out: WaveId[] = [];
  if (mission.waves !== undefined) out.push(mission.waves);
  for (const { objective } of objectivesOf(mission)) {
    if (objective.kind === 'defend') out.push(objective.wave);
  }
  const ambient = planetsById[mission.planet].surface.ambientWaves;
  if (ambient !== undefined) out.push(ambient);
  return out;
}

/** How many of `enemy` a wave list spawns in total. */
function countIn(waveIdList: readonly WaveId[], enemy: EnemyId): number {
  let total = 0;
  for (const id of waveIdList) {
    for (const group of waves[id].groups) {
      if (group.enemy === enemy) total += group.count;
    }
  }
  return total;
}

/**
 * SPEC-038 §4.5 — the storm-wave invariant, as a function so its failure modes
 * can be shown on doctored content: a surface survive with `weather` (other than
 * `c1_m1`'s, the first landing's ramp) must name a wave; that wave may only
 * spawn enemies from the planet's own `surface.spawn` table; and a flight
 * mission's survive names none.
 */
function stormWaveProblems(
  list: readonly Mission[],
  table: Readonly<Record<WaveId, WaveDef<WaveId>>>,
  worlds: Readonly<Record<PlanetId, PlanetDef>>,
): string[] {
  const problems: string[] = [];
  for (const mission of list) {
    mission.stages.forEach((stage, index) => {
      for (const objective of stage) {
        if (objective.kind !== 'survive') continue;
        const where = `${mission.id} stage ${index}`;
        if (mission.scene === 'flight') {
          if (objective.waves !== undefined) problems.push(`${where}: a flight survive cannot name a wave`);
          continue;
        }
        if (objective.waves === undefined) {
          if (objective.weather !== undefined && mission.id !== 'c1_m1') {
            problems.push(`${where}: a ${objective.weather} survive names no storm wave`);
          }
          continue;
        }
        const planet = worlds[mission.planet];
        const roster = new Set<string>(planet.surface.spawn.map((row) => row.enemy));
        for (const group of table[objective.waves].groups) {
          if (!roster.has(group.enemy)) {
            problems.push(`${where}: ${objective.waves} spawns ${group.enemy}, which is not in ${planet.id}’s spawn table`);
          }
        }
      }
    });
  }
  return [...new Set(problems)];
}

describe('content invariants (SPEC-009 §7)', () => {
  it('1. every requirement exists, and every mission is reachable without a cycle', () => {
    expect(Object.keys(UPGRADES)).toEqual([...SHIP_SYSTEMS]);
    const problems: string[] = [];
    const check = (requirement: Requirement, where: string): void => {
      if (requirement.kind === 'flag' && !flagSet.has(requirement.flag)) {
        problems.push(`${where}: unknown flag ${requirement.flag}`);
      }
      if (requirement.kind === 'mission' && !missionIds.has(requirement.id)) {
        problems.push(`${where}: unknown mission ${requirement.id}`);
      }
      if (requirement.kind === 'ship') {
        if (!shipSystems.has(requirement.system)) problems.push(`${where}: unknown ship system ${requirement.system}`);
        if (requirement.tier < 1 || requirement.tier > 3) problems.push(`${where}: ship tier ${requirement.tier} is out of range`);
        // A gate on a tier nothing sells is a gate nobody can open (E2).
        const ladder = Object.hasOwn(UPGRADES, requirement.system) ? UPGRADES[requirement.system].tiers : [];
        if (ladder.length < requirement.tier) problems.push(`${where}: ${requirement.system} has no tier ${requirement.tier} to buy`);
      }
      if (requirement.kind === 'level' && requirement.level < 1) problems.push(`${where}: level ${requirement.level} is out of range`);
    };
    for (const mission of missions) for (const r of mission.requires) check(r, `${mission.id}.requires`);
    for (const planet of planets) for (const r of planet.unlock) check(r, `${planet.id}.unlock`);
    expect(problems).toEqual([]);

    // The mission graph, depth-first, looking for a back edge.
    const state = new Map<string, 'open' | 'closed'>();
    const cycles: string[] = [];
    const walk = (id: MissionId, path: string[]): void => {
      if (state.get(id) === 'closed') return;
      if (state.get(id) === 'open') {
        cycles.push([...path, id].join(' → '));
        return;
      }
      state.set(id, 'open');
      for (const requirement of MISSIONS[id].requires) {
        if (requirement.kind === 'mission') walk(requirement.id as MissionId, [...path, id]);
      }
      state.set(id, 'closed');
    };
    for (const mission of missions) walk(mission.id, []);
    expect(cycles).toEqual([]);

    // BFS from nothing: planet unlocks are assumed, so the only gates that bind
    // are mission and flag requirements. Ship and level requirements are economy
    // gates SPEC-010's campaign simulation proves, not content gates.
    const done = new Set<string>();
    const flags = new Set<string>();
    for (let pass = 0; pass < missions.length + 1; pass += 1) {
      for (const mission of missions) {
        if (done.has(mission.id)) continue;
        const ready = mission.requires.every(
          (r) => (r.kind === 'mission' && done.has(r.id)) || (r.kind === 'flag' && flags.has(r.flag)) || r.kind === 'ship' || r.kind === 'level',
        );
        if (!ready) continue;
        done.add(mission.id);
        for (const flag of mission.rewards.flags ?? []) flags.add(flag);
      }
    }
    expect([...missionIds].filter((id) => !done.has(id))).toEqual([]);
  });

  it('2. each chapter flag is produced by exactly one mission, and it is that chapter’s m3', () => {
    const chapterFlags = STORY_FLAGS.filter((flag) => /^chapter\d_done$/.test(flag));
    expect(chapterFlags).toEqual(['chapter1_done', 'chapter2_done', 'chapter3_done', 'chapter4_done', 'chapter5_done']);
    for (const flag of chapterFlags) {
      const granting = missions.filter((mission) => (mission.rewards.flags ?? []).includes(flag));
      expect(granting.map((mission) => mission.id)).toEqual([`c${flag[7] as string}_m3`]);
    }
    // Chapter 6 ends the campaign rather than unlocking anything (PLAN §6).
    expect(flagSet.has('chapter6_done')).toBe(false);
    expect(missions.filter((m) => m.chapter === 6).flatMap((m) => m.rewards.flags ?? [])).toEqual(['campaign_done']);
  });

  it('3. every POI a surface objective names is on the planet, in a compatible kind and count', () => {
    // Which POI kinds each objective kind accepts (§7.3). `boss` is absent
    // because a boss objective names an enemy, not a POI; invariant 5 checks
    // that its planet has exactly one arena holding it.
    const accepts: Record<'reach' | 'scan' | 'deliver' | 'defend', readonly PoiDef['kind'][]> = {
      reach: ['landing_pad', 'scan', 'reach', 'deliver', 'arena', 'defend', 'escort_start', 'landmark'],
      scan: ['scan', 'landmark'],
      deliver: ['deliver', 'arena'],
      defend: ['defend'],
    };
    const problems: string[] = [];
    for (const mission of missions) {
      if (mission.scene !== 'surface') continue;
      const planet = planetsById[mission.planet];
      const require = (id: PoiId, where: string): PoiDef | undefined => {
        const poi = poiOf(planet, id);
        if (poi === undefined) problems.push(`${where}: ${planet.id} has no POI ${id}`);
        // 09-b: a POI a mission needs but the planet places zero of.
        else if (poi.count < 1) problems.push(`${where}: ${planet.id} places ${poi.count} of ${id}`);
        return poi;
      };
      for (const { objective, where } of objectivesOf(mission)) {
        if (objective.kind === 'reach' || objective.kind === 'scan' || objective.kind === 'deliver' || objective.kind === 'defend') {
          const poi = require(objective.poi, where);
          if (poi === undefined) continue;
          if (!accepts[objective.kind].includes(poi.kind)) {
            problems.push(`${where}: ${poi.id} is a ${poi.kind}, which a ${objective.kind} objective cannot use`);
          }
          // The reactor core is an arena that also takes a delivery (§4.5).
          if (objective.kind === 'deliver' && poi.kind === 'arena' && poi.deliver !== true) {
            problems.push(`${where}: ${poi.id} is an arena without deliver: true`);
          }
          if (objective.kind === 'scan' && objective.count > poi.count) {
            problems.push(`${where}: scans ${objective.count} of ${poi.id}, which is placed ${poi.count} times`);
          }
        }
        if (objective.kind === 'escort') {
          const from = require(objective.from, `${where}.from`);
          require(objective.to, `${where}.to`);
          if (from !== undefined && from.kind !== 'escort_start') {
            problems.push(`${where}: ${from.id} is a ${from.kind}, not an escort_start`);
          }
          if (!Object.hasOwn(FOLLOWERS, objective.follower)) problems.push(`${where}: unknown follower ${objective.follower}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('4. every surface kill objective can actually find its enemy', () => {
    const problems: string[] = [];
    for (const mission of missions) {
      if (mission.scene !== 'surface') continue;
      const planet = planetsById[mission.planet];
      const spawned = new Set<string>(planet.surface.spawn.map((entry) => entry.enemy));
      const fromWaves = wavesFor(mission);
      for (const { objective, where } of objectivesOf(mission)) {
        if (objective.kind !== 'kill') continue;
        if (spawned.has(objective.enemy)) continue;
        if (countIn(fromWaves, objective.enemy) > 0) continue;
        // Eggs grow on their anchors rather than spawning: three per cluster.
        if (objective.enemy === 'hive_egg') {
          const anchors = poiOf(planet, 'egg_cluster');
          if (anchors !== undefined && anchors.count * 3 >= objective.amount) continue;
          problems.push(`${where}: ${planet.id} anchors ${(anchors?.count ?? 0) * 3} eggs for ${objective.amount} kills`);
          continue;
        }
        problems.push(`${where}: ${objective.enemy} is not in ${planet.id}'s spawn table or any wave it runs`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('5. every boss objective names a boss with exactly one arena to fight it in', () => {
    const problems: string[] = [];
    for (const mission of missions) {
      const planet = planetsById[mission.planet];
      for (const { objective, where } of objectivesOf(mission)) {
        if (objective.kind !== 'boss') continue;
        const boss = ENEMIES[objective.enemy];
        if (boss.archetype !== 'boss') problems.push(`${where}: ${boss.id} is a ${boss.archetype}, not a boss`);
        const arenas = planet.surface.pois.filter((poi) => poi.kind === 'arena' && poi.boss === objective.enemy);
        if (arenas.length !== 1) problems.push(`${where}: ${planet.id} has ${arenas.length} arenas for ${objective.enemy}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('6. flight missions fit inside the trip, and their kills inside the waves', () => {
    const problems: string[] = [];
    for (const mission of missions) {
      if (mission.scene !== 'flight') continue;
      const planet = planetsById[mission.planet];
      const flightWaves = planet.flight.waves;
      for (const { objective, where } of objectivesOf(mission)) {
        if (objective.kind === 'survive') {
          // PLAN R16 / SPEC-009 §7.6: the flight it has to fit is the *fastest*
          // one the planet allows — top engine at throttle 1.2 — plus the
          // launch the timer counts and the holding pattern that tops it up
          // before the landing. `travelSeconds` alone only describes a tier-0
          // engine at throttle 1, which is how `c5_m1` came to be unfinishable.
          const speeds = UPGRADES.engine.metrics['speedMult'] ?? [1];
          const fastest = planet.travelSeconds / Math.max(...speeds) / Math.max(...THROTTLES);
          const budget = LAUNCH_SECONDS + fastest + TUNING.HOLD_PATTERN_MAX_SECONDS;
          if (objective.seconds > budget) {
            problems.push(`${where}: survives ${objective.seconds}s of a ${Math.round(budget)}s fastest flight`);
          }
        }
        if (objective.kind === 'kill') {
          // E12: waves spawn at least twice the required kills.
          const available = countIn(flightWaves, objective.enemy);
          if (objective.amount > available * 0.5) {
            problems.push(`${where}: ${objective.amount} kills of ${objective.enemy} out of ${available} spawned`);
          }
        }
      }
    }
    // Every flight wave has emptied its script before the ship arrives.
    for (const planet of planets) {
      for (const id of planet.flight.waves) {
        const last = waves[id].groups.at(-1);
        if (last !== undefined && last.atSecond >= planet.travelSeconds) {
          problems.push(`${planet.id}: ${id}'s last group is at ${last.atSecond}s of a ${planet.travelSeconds}s trip`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('7. collect and deliver amounts fit the hold, and the ground holds three times the largest collect', () => {
    // §4.13: the base cap is the un-upgraded cargo metric, in one place only.
    expect(TUNING.CARGO_BASE).toBe(UPGRADES.cargo.metrics.cargoCap[0]);

    const problems: string[] = [];
    /** planet → resource → largest collect objective (E3). */
    const largest = new Map<PlanetId, Map<ResourceId, number>>();
    for (const mission of missions) {
      for (const { objective, where } of objectivesOf(mission)) {
        if (objective.kind === 'collect') {
          if (objective.amount > TUNING.CARGO_BASE - 100) {
            problems.push(`${where}: collects ${objective.amount} against a ${TUNING.CARGO_BASE} cap`);
          }
          const byResource = largest.get(mission.planet) ?? new Map<ResourceId, number>();
          byResource.set(objective.resource, Math.max(byResource.get(objective.resource) ?? 0, objective.amount));
          largest.set(mission.planet, byResource);
        }
        if (objective.kind === 'deliver' && objective.amount > TUNING.CARGO_BASE) {
          problems.push(`${where}: delivers ${objective.amount} against a ${TUNING.CARGO_BASE} cap`);
        }
      }
    }
    for (const planet of planets) {
      for (const [resource, amount] of largest.get(planet.id) ?? []) {
        const inGround = planet.surface.nodes
          .filter((node) => node.resource === resource)
          .reduce((sum, node) => sum + node.count * node.capacity, 0);
        if (inGround < amount * 3) {
          problems.push(`${planet.id}: ${inGround} ${resource} in the ground for a ${amount} collect objective`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('8. loot tables reference real drops, and every enemy has one', () => {
    const problems: string[] = [];
    for (const [id, entries] of Object.entries(lootTables)) {
      for (const entry of entries) {
        // SPEC-039 §4.1: a signature row carries no chance; the next case owns it.
        if (entry.kind === 'signature') continue;
        if (entry.chance <= 0 || entry.chance > 1) problems.push(`${id}: chance ${entry.chance} is outside (0, 1]`);
        if (entry.kind === 'resource') {
          if (!resourceIds.has(entry.resource)) problems.push(`${id}: unknown resource ${entry.resource}`);
          if (entry.min > entry.max) problems.push(`${id}: ${entry.resource} min ${entry.min} exceeds max ${entry.max}`);
        }
        if (entry.kind === 'item') {
          if (!itemIds.has(entry.itemId)) problems.push(`${id}: unknown item ${entry.itemId}`);
          if (entry.qty < 1) problems.push(`${id}: ${entry.itemId} qty ${entry.qty}`);
        }
      }
    }
    for (const enemy of enemies) {
      if (!Object.hasOwn(LOOT_TABLES, enemy.loot)) problems.push(`${enemy.id}: unknown loot table ${enemy.loot}`);
    }
    expect(problems).toEqual([]);
  });

  // SPEC-039 §4.1: invariant 8's signature rules. Each boss table carries
  // exactly one signature row and no other table any; each names a priced
  // weapon of the handgun, machine-gun or launcher line; the five pieces are
  // distinct; and no row anywhere hands out a rifle or an armour piece — those
  // two ladders are what the shop sells.
  it('8 (SPEC-039). signature rows name one priced side-grade per boss, and no table gives a rifle or armour', () => {
    const problems: string[] = [];
    const bossTables = new Set<string>(enemies.filter((enemy) => enemy.archetype === 'boss').map((enemy) => enemy.loot));
    const pieces: string[] = [];
    for (const [id, entries] of Object.entries(lootTables)) {
      const signatures = entries.filter((entry) => entry.kind === 'signature');
      if (bossTables.has(id) && signatures.length !== 1) problems.push(`${id}: ${signatures.length} signature rows, not 1`);
      if (!bossTables.has(id) && signatures.length > 0) problems.push(`${id}: a signature row outside a boss table`);
      for (const entry of entries) {
        if (entry.kind === 'resource') continue;
        const item: Item | undefined = ITEM_TABLE[entry.itemId];
        if (item === undefined) {
          problems.push(`${id}: unknown item ${entry.itemId}`);
          continue;
        }
        if (item.kind !== 'consumable' && (item.line === 'rifle' || item.line === 'armor')) {
          problems.push(`${id}: hands out the ${item.line} ${item.id}`);
        }
        if (entry.kind !== 'signature') continue;
        if ('chance' in entry) problems.push(`${id}: signature ${entry.itemId} carries a chance`);
        pieces.push(entry.itemId);
        if (item.kind !== 'weapon' || item.price === null || !['handgun', 'machine_gun', 'launcher'].includes(item.line)) {
          problems.push(`${id}: signature ${entry.itemId} is not a priced handgun, machine gun or launcher`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(new Set(pieces).size).toBe(pieces.length);
    expect(pieces.length).toBe(5);

    // The five bosses and their pieces (§4.1's table), frag pair and
    // consumables kept.
    const signatureOf = (table: LootTableId): string | undefined =>
      lootTables[table].find((entry) => entry.kind === 'signature')?.itemId;
    expect({
      cinder4_boss: signatureOf('cinder4_boss'),
      vetra_boss: signatureOf('vetra_boss'),
      thessaly_boss: signatureOf('thessaly_boss'),
      ferrum_boss: signatureOf('ferrum_boss'),
      hive_boss: signatureOf('hive_boss'),
    }).toEqual({
      cinder4_boss: 'launcher_rocket',
      vetra_boss: 'mg_scrap',
      thessaly_boss: 'pistol_magnum',
      ferrum_boss: 'launcher_grenade',
      hive_boss: 'mg_rotary',
    });
    for (const table of ['cinder4_boss', 'vetra_boss', 'thessaly_boss', 'ferrum_boss', 'hive_boss'] as const) {
      expect(lootTables[table].filter((entry) => entry.kind !== 'signature'), table).toEqual([
        { kind: 'item', itemId: 'frag_grenade', qty: 2, chance: 1 },
        { kind: 'item', itemId: 'medkit', qty: 2, chance: 1 },
        { kind: 'item', itemId: 'coolant_pack', qty: 1, chance: 1 },
        { kind: 'item', itemId: 'plasma_cell', qty: 1, chance: 0.5 },
        { kind: 'item', itemId: 'wheat_ration', qty: 1, chance: 0.5 },
      ]);
    }
    expect(lootTables.elite_bonus).toEqual([
      { kind: 'resource', resource: 'lithium', min: 6, max: 12, chance: 1 },
      { kind: 'item', itemId: 'frag_grenade', qty: 1, chance: 0.35 },
      { kind: 'item', itemId: 'landmine', qty: 1, chance: 0.25 },
      { kind: 'item', itemId: 'plasma_cell', qty: 1, chance: 0.1 },
    ]);
    expect(SIGNATURE_FALLBACK_LITHIUM).toBe(25);
  });

  it('9. enemy stats hold, static enemies stand still, and boss phases descend from full', () => {
    // §4.3 writes each enemy's numbers down rather than computing them at load
    // time, so nothing but this check says they were derived from the archetype
    // base and the chapter formula instead of typed in. Retuning means moving a
    // base or the formula here, which is the point: one stat block per
    // archetype, scaled (09-a).
    // SPEC-038 §4.4 moved the trash HP bases: swarm 18 → 26, rusher 45 → 70,
    // ranged 35 → 45. Damage, speed, radius and xp are unchanged.
    const archetypeBase: Record<string, { hp: number; damage: number }> = {
      swarm: { hp: 26, damage: 4 },
      rusher: { hp: 70, damage: 9 },
      ranged: { hp: 45, damage: 7 },
      static: { hp: 60, damage: 0 },
      boss: { hp: 900, damage: 18 },
      fighter: { hp: 40, damage: 8 },
      interceptor: { hp: 20, damage: 12 },
    };
    // SPEC-041 §4.2 (*initial tuning*): boss HP is its own table, sized for the
    // post-SPEC-039 kit — the player's DPS jumps at chapters 2 and 5, so no
    // single chapter factor holds a fight's length. Damage and xp keep the
    // formulas below.
    const bossHp: Record<string, number> = {
      dune_wurm: 1800,
      frost_matriarch: 4600,
      hive_broodlord: 5200,
      ash_titan: 6800,
      hive_queen: 8400,
    };
    expect(enemies.filter((enemy) => enemy.archetype === 'boss').map((enemy) => enemy.id).sort()).toEqual(
      Object.keys(bossHp).sort(),
    );
    const problems: string[] = [];
    for (const enemy of enemies) {
      const base = archetypeBase[enemy.archetype];
      if (base === undefined) problems.push(`${enemy.id}: no base for archetype ${enemy.archetype}`);
      else {
        // SPEC-034 §4.4: a flight enemy's HP is the archetype base with no
        // chapter factor — a trip's kill count is authored against its dive
        // time, not against a fifth-chapter HP pool. Damage still scales.
        const hp =
          enemy.archetype === 'boss'
            ? (bossHp[enemy.id] ?? -1)
            : enemy.domain === 'flight'
              ? base.hp
              : Math.round(base.hp * 1.35 ** (enemy.chapter - 1));
        const damage = Math.round(base.damage * 1.3 ** (enemy.chapter - 1));
        if (enemy.hp !== hp) {
          problems.push(
            enemy.archetype === 'boss'
              ? `${enemy.id}: hp ${enemy.hp}, but SPEC-041 §4.2's table says ${hp}`
              : enemy.domain === 'flight'
                ? `${enemy.id}: hp ${enemy.hp}, but an unscaled ${enemy.archetype} is ${hp}`
                : `${enemy.id}: hp ${enemy.hp}, but a chapter-${enemy.chapter} ${enemy.archetype} is ${hp}`,
          );
        }
        if (enemy.damage !== damage) problems.push(`${enemy.id}: damage ${enemy.damage}, but a chapter-${enemy.chapter} ${enemy.archetype} is ${damage}`);
        // Boss xp is the one stat §4.3 scales explicitly.
        if (enemy.archetype === 'boss' && enemy.xp !== 100 + 100 * enemy.chapter) {
          problems.push(`${enemy.id}: xp ${enemy.xp}, but a chapter-${enemy.chapter} boss is ${100 + 100 * enemy.chapter}`);
        }
      }
      if (enemy.hp <= 0) problems.push(`${enemy.id}: hp ${enemy.hp}`);
      if (enemy.speed < 0) problems.push(`${enemy.id}: speed ${enemy.speed}`);
      if (enemy.archetype === 'static' && (enemy.attack.kind !== 'none' || enemy.speed !== 0)) {
        problems.push(`${enemy.id}: static enemies neither move nor attack`);
      }
      if (enemy.domain === 'flight' && enemy.archetype !== 'fighter' && enemy.archetype !== 'interceptor') {
        problems.push(`${enemy.id}: a flight enemy cannot be a ${enemy.archetype}`);
      }
      if (enemy.archetype === 'boss') {
        const phases = enemy.phases ?? [];
        if (phases.length < 1) problems.push(`${enemy.id}: a boss needs at least one phase`);
        if (phases[0]?.hpFraction !== 1) problems.push(`${enemy.id}: phases start at ${phases[0]?.hpFraction ?? 'nothing'}, not 1`);
        for (let i = 1; i < phases.length; i += 1) {
          const previous = phases[i - 1] as { hpFraction: number };
          const phase = phases[i] as { hpFraction: number };
          if (phase.hpFraction >= previous.hpFraction) {
            problems.push(`${enemy.id}: phase ${i} at ${phase.hpFraction} does not descend from ${previous.hpFraction}`);
          }
        }
      }
      for (const phase of enemy.phases ?? []) {
        if (phase.summon === undefined) continue;
        if (!enemyIds.has(phase.summon.enemy)) problems.push(`${enemy.id}: summons unknown ${phase.summon.enemy}`);
        else if (ENEMIES[phase.summon.enemy].archetype === 'boss') problems.push(`${enemy.id}: summons a boss`);
        if (phase.summon.count < 1) problems.push(`${enemy.id}: summons ${phase.summon.count}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('9b (SPEC-038). every ranged surface enemy fires at 13 m with 15 m/s shots', () => {
    const ranged = enemies.filter((enemy) => enemy.domain === 'surface' && enemy.archetype === 'ranged');
    expect(ranged.map((enemy) => enemy.id).sort()).toEqual(
      ['hive_spitter', 'ice_spitter', 'scav_raider', 'slag_spitter', 'spore_spitter'].sort(),
    );
    for (const enemy of ranged) {
      expect(enemy.attack, enemy.id).toMatchObject({ kind: 'ranged', range: 13, projectileSpeed: 15 });
    }
  });

  it('10. planets have one pad, reachable bands, real gates and a spawn table they can support', () => {
    expect(Object.keys(PLANETS)).toEqual([...PLANET_IDS]);
    const problems: string[] = [];
    for (const planet of planets) {
      const pads = planet.surface.pois.filter((poi) => poi.kind === 'landing_pad');
      if (pads.length !== 1) problems.push(`${planet.id}: ${pads.length} landing pads`);
      for (const pad of pads) {
        if (pad.band[0] !== 0 || pad.band[1] !== 0) problems.push(`${planet.id}: the pad sits at band ${pad.band.join('–')}`);
      }
      const reach = planet.surface.halfSize - 20;
      for (const poi of planet.surface.pois) {
        if (poi.band[0] < 0 || poi.band[1] > reach || poi.band[0] > poi.band[1]) {
          problems.push(`${planet.id}.${poi.id}: band ${poi.band.join('–')} is outside 0–${reach}`);
        }
        if (poi.count < 1) problems.push(`${planet.id}.${poi.id}: count ${poi.count}`);
        if (poi.kind === 'defend' && (poi.hp ?? 0) <= 0) problems.push(`${planet.id}.${poi.id}: a defend POI needs hp`);
        if (poi.kind === 'arena' && poi.boss === undefined) problems.push(`${planet.id}.${poi.id}: an arena needs a boss`);
      }
      if (planet.fuelCost <= 0) problems.push(`${planet.id}: fuelCost ${planet.fuelCost}`);
      if (planet.travelSeconds <= 0) problems.push(`${planet.id}: travelSeconds ${planet.travelSeconds}`);
      for (const requirement of planet.unlock) {
        if (requirement.kind === 'flag' && !flagSet.has(requirement.flag)) problems.push(`${planet.id}: unknown unlock flag ${requirement.flag}`);
      }
      for (const entry of planet.surface.spawn) {
        if (entry.weight <= 0) problems.push(`${planet.id}: ${entry.enemy} spawns at weight ${entry.weight}`);
        if (entry.maxAlive < 1) problems.push(`${planet.id}: ${entry.enemy} maxAlive ${entry.maxAlive}`);
        // SPEC-041 §6.1: a pack fits its row — 1 ≤ min ≤ max ≤ maxAlive.
        if (entry.pack !== undefined) {
          const [min, max] = entry.pack;
          if (!(Number.isInteger(min) && Number.isInteger(max) && min >= 1 && min <= max && max <= entry.maxAlive)) {
            problems.push(`${planet.id}: ${entry.enemy} pack [${min}, ${max}] does not fit maxAlive ${entry.maxAlive}`);
          }
        }
        const enemy = ENEMIES[entry.enemy];
        if (enemy.domain !== 'surface') problems.push(`${planet.id}: ${enemy.id} is a ${enemy.domain} enemy`);
        if (enemy.chapter > planet.chapter) problems.push(`${planet.id} (chapter ${planet.chapter}) spawns chapter-${enemy.chapter} ${enemy.id}`);
      }
      for (const id of planet.flight.waves) {
        if (waves[id].domain !== 'flight') problems.push(`${planet.id}: ${id} is not a flight wave`);
      }
    }
    // 09-c: weather a mission forces has to be in that planet's cycle, and a
    // planet with no weather cannot be asked for any.
    for (const mission of missions) {
      const cycle: readonly string[] = planetsById[mission.planet].surface.weather?.cycle ?? [];
      const forced = [mission.weather, ...objectivesOf(mission).map(({ objective }) => (objective.kind === 'survive' ? objective.weather : undefined))];
      for (const weather of forced) {
        if (weather !== undefined && !cycle.includes(weather)) problems.push(`${mission.id}: forces ${weather}, which ${mission.planet} never has`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('11. waves spawn real enemies of their own domain, in order', () => {
    const problems: string[] = [];
    for (const [id, wave] of Object.entries(waves)) {
      let previous = -Infinity;
      for (const group of wave.groups) {
        if (group.count < 1) problems.push(`${id}: ${group.enemy} count ${group.count}`);
        if (group.atSecond < previous) problems.push(`${id}: ${group.enemy} at ${group.atSecond}s follows ${previous}s`);
        previous = group.atSecond;
        const enemy = ENEMIES[group.enemy];
        if (enemy.domain !== wave.domain) problems.push(`${id}: a ${wave.domain} wave cannot spawn ${enemy.domain} ${enemy.id}`);
      }
      if (wave.spawnBand[0] > wave.spawnBand[1]) problems.push(`${id}: spawn band ${wave.spawnBand.join('–')}`);
      if (wave.loopAfterSeconds !== undefined && wave.loopAfterSeconds <= 0) problems.push(`${id}: loops after ${wave.loopAfterSeconds}s`);
    }
    expect(problems).toEqual([]);
  });

  it('11b (SPEC-038). storm waves run in weather survive stages, from the planet’s own roster', () => {
    expect(stormWaveProblems(missions, waves, planetsById)).toEqual([]);
    // §4.5: each storm wave runs once, 18–30 m from the player.
    for (const id of ['cinder4_storm', 'vetra_storm', 'thessaly_storm', 'ferrum_storm'] as const) {
      const wave = waves[id];
      expect(wave.domain, id).toBe('surface');
      expect(wave.spawnBand, id).toEqual([18, 30]);
      expect(wave.loopAfterSeconds, id).toBeUndefined();
    }
    // The six stages that name their planet's wave, and the tutorial that names none.
    const stormOf = (id: MissionId): Array<WaveId | undefined> =>
      MISSIONS[id].stages.flat().flatMap((objective: Objective) => (objective.kind === 'survive' ? [objective.waves] : []));
    expect(stormOf('c1_s2')).toEqual(['cinder4_storm']);
    expect(stormOf('c2_m1')).toEqual(['vetra_storm']);
    expect(stormOf('c2_s2')).toEqual(['vetra_storm']);
    expect(stormOf('c3_m1')).toEqual(['thessaly_storm']);
    expect(stormOf('c4_m1')).toEqual(['ferrum_storm']);
    expect(stormOf('c4_s1')).toEqual(['ferrum_storm']);
    expect(stormOf('c1_m1')).toEqual([undefined]);
  });

  it('11c (SPEC-038). the storm-wave invariant fails on each of the three things it guards', () => {
    const c1s2 = MISSIONS.c1_s2 as Mission;
    const stripped: Mission = {
      ...c1s2,
      stages: [c1s2.stages[0] ?? [], [{ kind: 'survive', seconds: 90, weather: 'heatwave' }]],
    };
    expect(stormWaveProblems([stripped], waves, planetsById)).toEqual([
      'c1_s2 stage 1: a heatwave survive names no storm wave',
    ]);
    const foreign: Mission = {
      ...c1s2,
      stages: [c1s2.stages[0] ?? [], [{ kind: 'survive', seconds: 90, weather: 'heatwave', waves: 'vetra_storm' }]],
    };
    expect(stormWaveProblems([foreign], waves, planetsById)).toEqual([
      'c1_s2 stage 1: vetra_storm spawns frost_mite, which is not in cinder4’s spawn table',
      'c1_s2 stage 1: vetra_storm spawns ice_crawler, which is not in cinder4’s spawn table',
      'c1_s2 stage 1: vetra_storm spawns ice_spitter, which is not in cinder4’s spawn table',
    ]);
    const c5m1 = MISSIONS.c5_m1 as Mission;
    const flight: Mission = {
      ...c5m1,
      stages: [[{ kind: 'survive', seconds: 180, waves: 'hive_flight' }, ...(c5m1.stages[0] ?? []).slice(1)]],
    };
    expect(stormWaveProblems([flight], waves, planetsById)).toEqual(['c5_m1 stage 0: a flight survive cannot name a wave']);
  });

  it('12. gear tiers are unique per line, consumables stack, and tier-3 gear costs lithium', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (item.kind === 'weapon' || item.kind === 'armor') {
        // SPEC-025 §4.7: uniqueness is per *line* — a handgun and a rifle may
        // both be tier 0, which is exactly what the starter sidearm needs.
        const key = `${item.line}:${item.tier}`;
        if (seen.has(key)) problems.push(`${item.id}: a second ${key}`);
        seen.add(key);
        // PLAN §4: tiers 1–2 cost tokens, tier 3 costs tokens plus lithium.
        if (item.tier === 3 && (item.price?.resources?.lithium ?? 0) <= 0) problems.push(`${item.id}: tier-3 gear must cost lithium`);
        if (item.tier === 0 && item.price !== null) problems.push(`${item.id}: the starter tier is not for sale`);
      }
      if (item.kind === 'consumable' && item.stack < 1) problems.push(`${item.id}: stack ${item.stack}`);
      if (item.price !== null && item.price.tokens <= 0) problems.push(`${item.id}: priced at ${item.price.tokens} tokens`);
      const costs: Partial<Record<ResourceId, number>> = item.price?.resources ?? {};
      for (const [resource, amount] of Object.entries(costs)) {
        if (!resourceIds.has(resource)) problems.push(`${item.id}: unknown resource ${resource}`);
        if ((amount ?? 0) <= 0) problems.push(`${item.id}: costs ${amount} ${resource}`);
      }
    }
    expect(seen).toEqual(
      new Set([
        'handgun:0',
        'handgun:2',
        'rifle:0',
        'rifle:1',
        'rifle:2',
        'rifle:3',
        // SPEC-029 §4.1: the machine-gun and launcher ladders.
        'machine_gun:1',
        'machine_gun:3',
        'launcher:1',
        'launcher:2',
        'armor:0',
        'armor:1',
        'armor:2',
        'armor:3',
      ]),
    );
    expect(problems).toEqual([]);
  });

  it('13. companions are priced, and only claim effects their domain can honour', () => {
    expect(Object.keys(COMPANIONS)).toEqual([...COMPANION_IDS]);
    const problems: string[] = [];
    for (const companion of Object.values(COMPANIONS)) {
      if (companion.cost < 0) problems.push(`${companion.id}: cost ${companion.cost}`);
      for (const cost of companion.upgradeCosts) {
        if (cost <= 0) problems.push(`${companion.id}: upgrade cost ${cost}`);
      }
      const allowed: readonly string[] = EFFECT_KEYS_BY_DOMAIN[companion.domain];
      for (const [level, effect] of companion.levels.entries()) {
        for (const key of Object.keys(effect as CompanionEffect)) {
          if (!allowed.includes(key)) problems.push(`${companion.id} L${level + 1}: ${key} is not a ${companion.domain} effect`);
        }
      }
    }
    // PLAN §4: ARIA comes with the ship.
    expect(COMPANIONS.aria.cost).toBe(0);
    expect(problems).toEqual([]);
  });

  it('14. every dialogue id a mission names exists, and every mission opens with one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const problems: string[] = [];
      const missingAccept: string[] = [];
      for (const mission of missions) {
        const referenced: (DialogueId | undefined)[] = [
          mission.dialogue.onAccept,
          mission.dialogue.onComplete,
          ...Object.values(mission.dialogue.onStage ?? {}),
        ];
        for (const id of referenced) {
          if (id !== undefined && !Object.hasOwn(DIALOGUE, id)) problems.push(`${mission.id}: unknown dialogue ${id}`);
        }
        // SPEC-034 §4.7: stage 0's moment is the accept, which `onAccept` owns.
        // The board path never starts a stage on screen, so a stage-0 line plays
        // at the pad terminal and nowhere else — which is how the Warden's first
        // words ended up before the fight instead of at the Queen's death.
        if ((mission.dialogue.onStage as Record<string, DialogueId> | undefined)?.['0'] !== undefined) {
          problems.push(`${mission.id}: onStage[0] — stage 0's line is onAccept`);
        }
        if (mission.dialogue.onAccept === undefined) {
          missingAccept.push(mission.id);
          console.warn(`SPEC-009 §7.14: ${mission.id} has no onAccept dialogue`);
        }
      }
      expect(problems).toEqual([]);
      // §7.14 only warns about a missing `onAccept`; §8 makes an empty warning
      // list the M6 acceptance bar, which is what this pins.
      expect(missingAccept).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * SPEC-034 §4.7: `DialogueDef.next` plays a second dialogue the moment the
   * first ends. A missing id would silently swallow the rest of a beat, and a
   * loop would never let the player go, so both are compile-adjacent errors.
   */
  it('14b. every dialogue `next` exists and the chain it starts terminates', () => {
    const problems: string[] = [];
    for (const dialogue of Object.values(DIALOGUE) as { id: string; next?: string }[]) {
      if (dialogue.next === undefined) continue;
      if (!Object.hasOwn(DIALOGUE, dialogue.next)) {
        problems.push(`${dialogue.id}: next names unknown dialogue ${dialogue.next}`);
        continue;
      }
      const seen = new Set<string>([dialogue.id]);
      let at: string | undefined = dialogue.next;
      let steps = 0;
      while (at !== undefined) {
        if (seen.has(at)) {
          problems.push(`${dialogue.id}: next revisits ${at}`);
          break;
        }
        seen.add(at);
        if (++steps > 4) {
          problems.push(`${dialogue.id}: next chain runs past 4 steps`);
          break;
        }
        at = (DIALOGUE as Record<string, { next?: string }>)[at]?.next;
      }
    }
    expect(problems).toEqual([]);
  });

  /**
   * SPEC-034 §4.15, E25: an item reward drops as a pickup at the player's feet
   * when the pack is full — which the flight scene has no ground for, so a
   * flight mission may never pay in items.
   */
  it('14c. no flight mission pays in items', () => {
    const problems: string[] = [];
    for (const mission of missions) {
      if (mission.scene !== 'flight') continue;
      if ((mission.rewards.items ?? []).length > 0) problems.push(`${mission.id}: item rewards on a flight mission`);
    }
    expect(problems).toEqual([]);
  });

  it('15. mission titles, briefs and dialogue lines stay inside their budgets', () => {
    const problems: string[] = [];
    for (const mission of missions) {
      if (mission.title.length > 32) problems.push(`${mission.id}: title is ${mission.title.length} characters`);
      if (mission.brief.length > 400) problems.push(`${mission.id}: brief is ${mission.brief.length} characters`);
    }
    for (const dialogue of Object.values(DIALOGUE)) {
      for (const [index, line] of dialogue.lines.entries()) {
        if (line.text.length > 220) problems.push(`${dialogue.id} line ${index}: ${line.text.length} characters`);
        if (line.text.trim() === '') problems.push(`${dialogue.id} line ${index}: empty`);
      }
      if (dialogue.lines.length < 1) problems.push(`${dialogue.id}: no lines`);
    }
    expect(problems).toEqual([]);
  });

  it('16. missions pay out 670 main and 104 side tokens (PLAN §7)', () => {
    const sum = (type: 'main' | 'side'): number =>
      missions.filter((mission) => mission.type === type).reduce((total, mission) => total + mission.rewards.tokens, 0);
    expect(sum('main')).toBe(670);
    expect(sum('side')).toBe(104);

    // The roster the totals are a sum of, pinned alongside them: PLAN §6
    // enumerates 17 main and 9 side missions and locks the set, and §7 counts
    // the same 17 since R5 corrected a header that read "(18)". There is no
    // 18th main mission that leaves 670 intact, so the two must stay together —
    // if a refinement adds one, this pin and the totals move in the same edit.
    expect(missions.filter((mission) => mission.type === 'main')).toHaveLength(17);
    expect(missions.filter((mission) => mission.type === 'side')).toHaveLength(9);
    // PLAN §7 also fixes the shape of the main total, chapter by chapter.
    const byChapter = [1, 2, 3, 4, 5, 6].map((chapter) =>
      missions
        .filter((mission) => mission.type === 'main' && mission.chapter === chapter)
        .reduce((total, mission) => total + mission.rewards.tokens, 0),
    );
    expect(byChapter).toEqual([55, 70, 85, 105, 165, 190]);
  });

  // SPEC-039 §4.3: every attribute's per-point effects live in one table,
  // and the class passives it amended.
  it('17 (SPEC-039). ATTRIBUTE_EFFECTS holds every per-point effect', () => {
    expect(ATTRIBUTE_EFFECTS).toEqual({
      might: { damage: 0.04 },
      vigor: { maxHp: 8 },
      agility: { moveSpeed: 0.02, critChance: 0.02, dashCooldownCut: 0.03 },
      tech: { companionEffect: 0.1, priceCut: 0.03 },
    });
    expect(ATTRIBUTE_POINT_LEVELS).toBe(5);
    expect(CLASSES.marine.passive.damageMult).toBe(1.1);
    expect(CLASSES.engineer.passive).toEqual({ refitDiscount: 0.15, companionEffectMult: 1.25 });
  });

  it('17. class attributes total 8, and no attribute can be pushed past the cap', () => {
    expect(Object.keys(CLASSES)).toEqual([...CLASS_IDS]);
    for (const cls of Object.values(CLASSES)) {
      const values = Object.values(cls.baseAttributes);
      expect(values.reduce((total, value) => total + value, 0)).toBe(8);
      for (const value of values) expect(value + CREATION_POINTS).toBeLessThanOrEqual(ATTRIBUTE_MAX);
      expect(itemIds.has(cls.startingWeapon)).toBe(true);
      expect(itemIds.has(cls.startingArmor)).toBe(true);
    }
    // Creation adds five to a base of eight, so a finished character has 13.
    expect(8 + CREATION_POINTS).toBe(13);
  });

  it('18. every surface look stays inside the SPEC-018 envelope', () => {
    const layerIds = new Set<string>(GROUND_LAYER_IDS);
    for (const planet of planets) {
      const look = planet.surface.look;
      // Relief past 0.5 m would push the aim-ray error over SPEC-012's bound.
      expect(look.relief.amplitude, planet.id).toBeLessThanOrEqual(0.5);
      for (const metres of look.ground.tileMetres) expect(metres, planet.id).toBeGreaterThan(0);
      expect(look.relief.bermHeight, planet.id).toBeLessThanOrEqual(10);
      for (const layer of look.ground.layers) expect(layerIds.has(layer), `${planet.id} layer ${layer}`).toBe(true);
    }
  });

  // SPEC-025 §4.7. The slot/line split is only safe while the two agree: a
  // weapon hangs where its line says it does, both class starters are free
  // tier-0 pieces of the right slot, and every consumable has a quick slot to
  // sit in, so nothing SPEC-028 reaches for can come back undefined.
  it('19. weapon slots follow their line, the class starters are free, and every consumable has a quick slot', () => {
    const problems: string[] = [];
    for (const item of items) {
      if (item.kind !== 'weapon') continue;
      const expected: string = SLOT_OF_LINE[item.line];
      if (item.slot !== expected) problems.push(`${item.id}: a ${item.line} in the ${item.slot} slot, not ${expected}`);
    }

    for (const cls of Object.values(CLASSES)) {
      for (const [what, id, slot] of [
        ['startingWeapon', cls.startingWeapon, 'primary'],
        ['startingSidearm', cls.startingSidearm, 'sidearm'],
      ] as const) {
        const item: Item | undefined = ITEM_TABLE[id];
        if (item === undefined || item.kind !== 'weapon') {
          problems.push(`${cls.id}.${what}: ${id} is not a weapon`);
          continue;
        }
        if (item.slot !== slot) problems.push(`${cls.id}.${what}: ${id} is a ${item.slot}, not a ${slot}`);
        if (item.tier !== 0) problems.push(`${cls.id}.${what}: ${id} is tier ${item.tier}, not 0`);
        if (item.price !== null) problems.push(`${cls.id}.${what}: ${id} is for sale`);
      }
    }

    const effectKinds = new Set<string>();
    for (const item of items) {
      if (item.kind !== 'consumable') continue;
      effectKinds.add(item.effect.kind);
      if (QUICK_SLOT_OF_EFFECT[item.effect.kind] === undefined) {
        problems.push(`${item.id}: the ${item.effect.kind} effect has no quick slot`);
      }
    }
    expect(new Set(Object.keys(QUICK_SLOT_OF_EFFECT))).toEqual(effectKinds);

    for (const slot of QUICK_SLOTS) {
      for (const id of QUICK_PREFERENCE[slot]) {
        const item: Item | undefined = ITEM_TABLE[id];
        if (item === undefined || item.kind !== 'consumable') {
          problems.push(`QUICK_PREFERENCE.${slot}: ${id} is not a consumable`);
          continue;
        }
        const use: string = QUICK_SLOT_OF_EFFECT[item.effect.kind];
        if (use !== slot) problems.push(`QUICK_PREFERENCE.${slot}: ${id} belongs in ${use}`);
      }
    }

    expect(problems).toEqual([]);
  });

  // SPEC-029 §4.10, invariant 20: the explosive effects hold their bounds,
  // and every explosive item is reachable — a recipe output or a loot drop.
  it('20. explosive effects stay in bounds and every explosive is craftable or lootable', () => {
    const problems: string[] = [];
    const reachable = new Set<string>();
    for (const recipe of Object.values(RECIPES)) reachable.add(recipe.output);
    for (const table of Object.values(lootTables)) {
      for (const entry of table) {
        if (entry.kind === 'item') reachable.add(entry.itemId);
      }
    }
    for (const item of items) {
      if (item.kind !== 'consumable' || item.effect.kind !== 'explosive') continue;
      const effect = item.effect;
      if (effect.radius < 1 || effect.radius > 6) problems.push(`${item.id}: radius ${effect.radius}`);
      if (effect.damage <= 0) problems.push(`${item.id}: damage ${effect.damage}`);
      if (effect.fuse < 0) problems.push(`${item.id}: fuse ${effect.fuse}`);
      if (effect.mode === 'throw' && (effect.range === undefined || effect.range > 12)) {
        problems.push(`${item.id}: throw range ${effect.range}`);
      }
      if (effect.mode === 'mine' && (effect.trigger === undefined || effect.trigger <= 0)) {
        problems.push(`${item.id}: mine trigger ${effect.trigger}`);
      }
      if (!reachable.has(item.id)) problems.push(`${item.id}: neither crafted nor dropped`);
    }
    expect(problems).toEqual([]);
    // The three of §4.3 exist and sit on the explosive quick slot.
    for (const id of ['frag_grenade', 'landmine', 'demo_charge'] as const) {
      const item = ITEM_TABLE[id];
      expect(item !== undefined && item.kind === 'consumable' && item.effect.kind === 'explosive', id).toBe(true);
    }
  });

  // SPEC-029 §4.10, invariant 21: cooldown parameters hold, and each line
  // carries the model its slot is designed around.
  it('21. cooldown parameters hold and every line carries its model', () => {
    const problems: string[] = [];
    for (const item of items) {
      if (item.kind !== 'weapon') continue;
      const model = item.cooldown;
      if (model.kind === 'heat') {
        if (model.perShot <= 0) problems.push(`${item.id}: perShot ${model.perShot}`);
        if (model.coolPerSec <= 0) problems.push(`${item.id}: coolPerSec ${model.coolPerSec}`);
        if (model.resumeAt <= 0 || model.resumeAt >= 1) problems.push(`${item.id}: resumeAt ${model.resumeAt}`);
      } else if (model.kind === 'charges') {
        if (model.charges < 1) problems.push(`${item.id}: charges ${model.charges}`);
        if (model.rechargeSeconds <= 0) problems.push(`${item.id}: rechargeSeconds ${model.rechargeSeconds}`);
        if (model.burstInterval < 0) problems.push(`${item.id}: burstInterval ${model.burstInterval}`);
      }
      const expected: string =
        item.line === 'machine_gun' ? 'heat' : item.line === 'launcher' ? 'charges' : 'none';
      if (model.kind !== expected) problems.push(`${item.id}: a ${item.line} with cooldown ${model.kind}`);
      if (item.line === 'launcher' && item.blast === undefined) problems.push(`${item.id}: a launcher without blast`);
    }
    expect(problems).toEqual([]);
  });

  // SPEC-030 §4.1 (AC-51; the spec numbers this invariant 22, but SPEC-028's
  // short-name rule already holds that slot below): every planet's `features`
  // counts stay within 0–4, and every planet with a weather cycle asks for at
  // least one cave or wreck, so a storm always has a shelter to point at.
  it('22 (SPEC-030). features counts stay in 0–4 and weather planets ask for a shelter', () => {
    const problems: string[] = [];
    for (const planet of planets) {
      const features = planet.surface.features;
      for (const [key, count] of Object.entries(features)) {
        if (!Number.isInteger(count) || count < 0 || count > 4) {
          problems.push(`${planet.id}: features.${key} = ${count}`);
        }
      }
      if (planet.surface.weather !== null && features.caves + features.wrecks < 1) {
        problems.push(`${planet.id}: a weather cycle with no cave or wreck`);
      }
    }
    expect(problems).toEqual([]);
  });

  // SPEC-028 §3: `short` is the quick-bar label, so it has to fit a 48 px slot.
  it('22. every item carries a short name of 1–8 characters', () => {
    const problems: string[] = [];
    for (const item of items) {
      if (item.short.length < 1 || item.short.length > 8) {
        problems.push(`${item.id}: short ${JSON.stringify(item.short)} is ${item.short.length} characters`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('23 (SPEC-031). every item and companion id has a glyph, and no two weapon lines share one', () => {
    const ids = [...(Object.keys(ITEMS) as (keyof typeof ITEMS)[]), ...(Object.keys(COMPANIONS) as (keyof typeof COMPANIONS)[])];
    for (const id of ids) {
      expect(iconGlyph(id), id).not.toBe('');
    }
    // One glyph per weapon line (and one for armor): a bar of keys must read
    // at a glance, so the lines may not collide.
    const lines = new Set(items.filter((item) => item.kind !== 'consumable').map((item) => item.line));
    const glyphs = new Set([...lines].map((line) => iconGlyph(items.find((item) => item.kind !== 'consumable' && item.line === line)!.id as Parameters<typeof iconGlyph>[0])));
    expect(glyphs.size).toBe(lines.size);
    // And one per consumable effect.
    const effects = new Map<string, string>();
    for (const item of items) {
      if (item.kind !== 'consumable') continue;
      const glyph = iconGlyph(item.id as Parameters<typeof iconGlyph>[0]);
      const seen = effects.get(item.effect.kind);
      if (seen !== undefined) expect(glyph, item.id).toBe(seen);
      effects.set(item.effect.kind, glyph);
    }
    expect(new Set(effects.values()).size).toBe(effects.size);
  });
});

// `@ts-expect-error` on its own only claims that *some* error occurred on the
// line below it, so each case here pairs one with a positive assertion naming
// the union under test: the bad id sits outside it, the good id inside. Those
// two lines suppress nothing, so if an id union ever widened to `string` they
// would fail on their own rather than quietly keeping the suppression happy.
type IsAssignable<Candidate, Union> = Candidate extends Union ? true : false;

describe('boss moves can be escaped on foot (SPEC-041 §4.3)', () => {
  // `v = PLAYER_SPEED`, a 0.3 s reaction, the player's radius 0.5, and SPEC-038's
  // dash i-frames. A telegraph that cannot be escaped is a coin toss, so a
  // retune that makes one fails here, before a browser ever sees it.
  const REACTION = 0.3;
  const PLAYER_RADIUS = 0.5;
  const v = TUNING.PLAYER_SPEED;
  const bosses = (Object.values(ENEMIES) as Enemy[]).filter((enemy) => enemy.archetype === 'boss');

  it('every boss carries a move list, and the table is SPEC-041 §4.2’s', () => {
    expect(bosses.map((boss) => [boss.id, (boss.moves ?? []).map((move) => move.id)])).toEqual([
      ['dune_wurm', ['sand_rush', 'tail_slam', 'burrow']],
      ['frost_matriarch', ['shard_fan', 'frost_nova']],
      ['hive_broodlord', ['brood_stomp', 'acid_spit', 'burrow_rush']],
      ['ash_titan', ['tremor', 'fissure', 'eruption']],
      ['hive_queen', ['acid_volley', 'royal_dive', 'brood_burst']],
    ]);
    for (const enemy of Object.values(ENEMIES) as Enemy[]) {
      if (enemy.archetype !== 'boss') expect(enemy.moves, enemy.id).toBeUndefined();
    }
  });

  it('every move is fair by §4.3’s formulas', () => {
    const problems: string[] = [];
    for (const boss of bosses) {
      for (const move of boss.moves ?? []) {
        const label = `${boss.id}.${move.id}`;
        const t = move.windup - REACTION;
        const need = (value: number | undefined, name: string): number => {
          if (value === undefined || !(value > 0)) problems.push(`${label}: no ${name}`);
          return value ?? 0;
        };
        if (move.phaseMin > (boss.phases ?? []).length) problems.push(`${label}: phase ${move.phaseMin} never comes`);
        if (move.range[0] > move.range[1]) problems.push(`${label}: range ${move.range.join('–')}`);
        if (move.weight < 0 || move.windup <= 0 || move.cooldown < 0 || move.recover < 0 || move.damageMult <= 0) {
          problems.push(`${label}: a negative or empty number`);
        }
        switch (move.kind) {
          case 'slam_target':
          case 'slam_self':
          case 'burrow': {
            const radius = need(move.radius, 'radius');
            if (radius + PLAYER_RADIUS > v * t + 1e-9) problems.push(`${label}: ${radius} + 0.5 > ${v} × ${t.toFixed(2)}`);
            break;
          }
          case 'charge':
          case 'lines': {
            const width = need(move.width, 'width');
            need(move.length, 'length');
            if (move.kind === 'charge') need(move.speed, 'speed');
            else need(move.count, 'count');
            if (width / 2 + PLAYER_RADIUS > v * t + 1e-9) problems.push(`${label}: ${width} / 2 + 0.5 > ${v} × ${t.toFixed(2)}`);
            break;
          }
          case 'ring': {
            const ringSpeed = need(move.ringSpeed, 'ringSpeed');
            const ringMax = need(move.ringMax, 'ringMax');
            const band = need(move.band, 'band');
            const outrun = boss.radius + PLAYER_RADIUS + v * (t + ringMax / ringSpeed);
            if (outrun < ringMax + band / 2 + PLAYER_RADIUS - 1e-9) problems.push(`${label}: the ring cannot be outrun`);
            if (DASH_IFRAMES * ringSpeed < band + 1.0 - 1e-9) problems.push(`${label}: a dash cannot cross the band`);
            break;
          }
          case 'volley': {
            const speed = need(move.projectileSpeed, 'projectileSpeed');
            const radius = need(move.projectileRadius, 'projectileRadius');
            const count = need(move.count, 'count');
            const spread = need(move.spread, 'spread');
            need(move.projectileRange, 'projectileRange');
            if (speed > 16) problems.push(`${label}: ${speed} m/s is faster than 16`);
            if (count > 1 && 8 * Math.tan(spread / (count - 1)) < 2 * (radius + PLAYER_RADIUS) - 1e-9) {
              problems.push(`${label}: neighbouring shots leave no gap at 8 m`);
            }
            break;
          }
        }
        if ((move.kind === 'charge' || move.kind === 'volley') && !(move.lock !== undefined && move.lock < move.windup)) {
          problems.push(`${label}: a charge or a volley locks inside its windup`);
        }
        if (move.kind === 'burrow' && (move.weight !== 0 || !(move.dig ?? 0) || !(move.every ?? 0))) {
          problems.push(`${label}: the burrow is timed — weight 0, a dig and an interval`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('the tightest rows are as tight as §4.3 says, and a fault is caught', () => {
    const move = (boss: EnemyId, id: string) => (ENEMIES[boss] as Enemy).moves?.find((m) => m.id === id);
    // brood_stomp and tail_slam: 3.5 + 0.5 = 4.0 against 6 × 0.7 = 4.2.
    expect((move('hive_broodlord', 'brood_stomp')?.radius ?? 0) + PLAYER_RADIUS).toBeCloseTo(4, 10);
    expect(v * ((move('dune_wurm', 'tail_slam')?.windup ?? 0) - REACTION)).toBeCloseTo(4.2, 10);
    // eruption's dash check: 0.3 × 8 = 2.4 against 1.4 + 1.0 = 2.4.
    const eruption = move('ash_titan', 'eruption');
    expect(DASH_IFRAMES * (eruption?.ringSpeed ?? 0)).toBeCloseTo((eruption?.band ?? 0) + 1, 10);
    // A slam 0.1 s faster than tail_slam is a coin toss.
    expect(3.5 + PLAYER_RADIUS > v * (0.9 - REACTION)).toBe(true);
  });
});

describe('elite affixes (SPEC-041 §4.6)', () => {
  const archetypes = ['swarm', 'rusher', 'ranged'] as const;

  it('defines the five, each with the archetypes §4.6’s pools give it', () => {
    expect(AFFIX_IDS).toEqual(['swift', 'bulwark', 'volley', 'mender', 'volatile']);
    expect(Object.keys(AFFIXES).sort()).toEqual([...AFFIX_IDS].sort());
    expect(Object.fromEntries(AFFIX_IDS.map((id) => [id, [...AFFIXES[id].archetypes].sort()]))).toEqual({
      swift: ['ranged', 'rusher', 'swarm'],
      bulwark: ['rusher', 'swarm'],
      volley: ['ranged'],
      mender: ['ranged', 'rusher', 'swarm'],
      volatile: ['rusher', 'swarm'],
    });
    for (const id of AFFIX_IDS) expect(AFFIXES[id].name).toBe(id[0]?.toUpperCase() + id.slice(1));
  });

  it('every pool holds at least two, and no affix serves an archetype it cannot', () => {
    const elites = (Object.values(ENEMIES) as Enemy[]).filter((enemy) => enemy.domain === 'surface' && enemy.eliteAllowed);
    for (const archetype of archetypes) {
      const pool = AFFIX_IDS.filter((id) => (AFFIXES[id].archetypes as readonly string[]).includes(archetype));
      expect(pool.length, archetype).toBeGreaterThanOrEqual(2);
      // Every pool is for an archetype that actually rolls elites on the ground.
      expect(elites.some((enemy) => enemy.archetype === archetype), archetype).toBe(true);
    }
    // A volley fans a shot: only archetypes whose every elite fires one.
    for (const archetype of AFFIXES.volley.archetypes) {
      for (const enemy of elites.filter((e) => e.archetype === archetype)) expect(enemy.attack.kind, enemy.id).toBe('ranged');
    }
    // Bulwark and volatile need a body that closes: never a gun that keeps its distance.
    for (const id of ['bulwark', 'volatile'] as const) expect(AFFIXES[id].archetypes).not.toContain('ranged');
  });
});

describe('unknown ids are compile errors (SPEC-009 §6, E26)', () => {
  it('a mission objective cannot name an enemy that does not exist', () => {
    const sandGhostIsNotAnEnemy: IsAssignable<'sand_ghost', EnemyId> = false;
    const scavRaiderIsAnEnemy: IsAssignable<'scav_raider', EnemyId> = true;

    // The id must resolve against `ENEMIES`; `sand_ghost` does not, so this line
    // fails `tsc` — and if it ever stopped failing, `@ts-expect-error` would.
    // @ts-expect-error
    const bad: Objective = { kind: 'kill', enemy: 'sand_ghost', amount: 6 };
    const good: Objective = { kind: 'kill', enemy: 'scav_raider', amount: 6 };
    expect([bad.kind, good.kind]).toEqual(['kill', 'kill']);
    expect([sandGhostIsNotAnEnemy, scavRaiderIsAnEnemy]).toEqual([false, true]);
  });

  it('a planet unlock cannot name a flag that does not exist', () => {
    const chapter9IsNotAFlag: IsAssignable<'chapter9_done', FlagId> = false;
    const chapter1IsAFlag: IsAssignable<'chapter1_done', FlagId> = true;

    // @ts-expect-error
    const bad: PlanetDef['unlock'] = [{ kind: 'flag', flag: 'chapter9_done' }];
    const good: PlanetDef['unlock'] = [{ kind: 'flag', flag: 'chapter1_done' }];
    expect([bad.length, good.length]).toEqual([1, 1]);
    expect([chapter9IsNotAFlag, chapter1IsAFlag]).toEqual([false, true]);
  });
});

// ------------------------------------------------------------- SPEC-019 §4.8

import { ASSETS, FLIGHT_ASSETS, SURFACE_ASSETS, SURFACE_SHARED_ASSETS } from '@/data/index';

describe('the boot manifest stays five files (SPEC-019 AC-34 … AC-36, PLAN R6-5)', () => {
  it('no surface or flight model id leaks into ASSETS.models', () => {
    const boot = new Set(Object.keys(ASSETS.models));
    const lazy = [
      ...Object.keys(FLIGHT_ASSETS.models),
      ...Object.keys(SURFACE_SHARED_ASSETS.models),
      ...Object.values(SURFACE_ASSETS).flatMap((drop) => Object.keys(drop.models)),
    ];
    expect(lazy.filter((id) => boot.has(id))).toEqual([]);
    // The five files the boot e2e suite measures: three models, two textures.
    expect(Object.keys(ASSETS.models).length + Object.keys(ASSETS.textures).length).toBe(5);
  });

  it('the probe rides the lazily loaded shared surface set, and the follower names it', () => {
    expect(SURFACE_SHARED_ASSETS.models.probe).toBe('assets/models/probe.glb');
    expect(FOLLOWERS.science_probe.model).toBe('probe');
  });
});

// ------------------------------------------------------------- SPEC-027 §4.10

import { HINTS, HINT_PLACEHOLDERS, MISSION_HINTS, TIPS, TIP_IDS } from '@/data/index';

/** Every line the guidance layer can print, with the key that produced it. */
function guidanceTemplates(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const id of TIP_IDS) {
    out.push([`TIPS.${id}.keyboard`, TIPS[id].keyboard], [`TIPS.${id}.touch`, TIPS[id].touch]);
  }
  for (const [kind, hint] of Object.entries(HINTS)) {
    out.push([`HINTS.${kind}.nudge`, hint.nudge]);
    if (hint.fallback !== undefined) out.push([`HINTS.${kind}.fallback`, hint.fallback]);
    if (hint.touch !== undefined) out.push([`HINTS.${kind}.touch`, hint.touch]);
  }
  for (const [mission, stages] of Object.entries(MISSION_HINTS)) {
    for (const [stage, text] of Object.entries(stages ?? {})) out.push([`MISSION_HINTS.${mission}.${stage}`, text]);
  }
  return out;
}

describe('tips and hints (SPEC-027 AC-81..AC-84)', () => {
  it('every tip and hint is at most 160 characters', () => {
    const problems = guidanceTemplates()
      .filter(([, text]) => text.length > 160)
      .map(([key, text]) => `${key}: ${text.length} characters`);
    expect(problems).toEqual([]);
  });

  it('every {…} token is a member of HINT_PLACEHOLDERS', () => {
    const allowed = new Set<string>(HINT_PLACEHOLDERS);
    const problems: string[] = [];
    for (const [key, text] of guidanceTemplates()) {
      for (const match of text.matchAll(/\{[^}]*\}/g)) {
        if (!allowed.has(match[0])) problems.push(`${key}: ${match[0]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every MISSION_HINTS key names a real mission, and every stage is one of its stages (D-20)', () => {
    const problems: string[] = [];
    for (const [mission, stages] of Object.entries(MISSION_HINTS)) {
      const def = (MISSIONS as Record<string, Mission | undefined>)[mission];
      if (def === undefined) {
        problems.push(`${mission}: no such mission`);
        continue;
      }
      for (const stage of Object.keys(stages ?? {})) {
        const index = Number(stage);
        if (!Number.isInteger(index) || index < 0 || index >= def.stages.length) {
          problems.push(`${mission}: stage ${stage} is outside 0..${def.stages.length - 1}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  /**
   * SPEC-034 §6.1 pins these two numbers here, in the content suite, because
   * they are the two the spec moved and the two a retune would silently undo.
   * `tests/systems/gauntlet.test.ts` and `tests/systems/spawn.test.ts` prove
   * they *work*; this proves they are still what the spec wrote down.
   */
  it('the SPEC-034 content numbers are what §4.4 and §4.9 set', () => {
    // §4.4: the gauntlet asks for six interceptors over its 180 s, and the
    // 180 s itself is unchanged (AC-14).
    const gauntlet = MISSIONS['c5_m1'].stages[0];
    expect(gauntlet).toContainEqual({ kind: 'survive', seconds: 180 });
    expect(gauntlet).toContainEqual({ kind: 'kill', enemy: 'hive_interceptor', amount: 6 });

    // §4.4: the two flight archetypes' own HP (AC-12).
    expect(ENEMIES['hive_interceptor'].hp).toBe(20);
    expect(ENEMIES['scav_fighter'].hp).toBe(40);

    // §4.9: the final defence spawns inside 40 m, so its waves reach the
    // beacon instead of milling at the ring's far edge (AC-28).
    expect(WAVES['eden_final'].spawnBand).toEqual([25, 40]);
  });

  it('no brief and no dialogue line names a compass direction (§4.10)', () => {
    // POIs are placed at random angles (SPEC-012 §4.2), so a written bearing is
    // wrong on most seeds; the guidance layer computes `{dir}` per frame instead.
    const compass = /\b(north|south|east|west)\b/i;
    const problems: string[] = [];
    for (const mission of Object.values(MISSIONS) as Mission[]) {
      if (compass.test(mission.brief)) problems.push(`${mission.id}: brief`);
    }
    for (const dialogue of Object.values(DIALOGUE)) {
      for (const [index, line] of dialogue.lines.entries()) {
        if (compass.test(line.text)) problems.push(`${dialogue.id}: line ${index}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

// ------------------------------------------------------------ SPEC-035 §4.1

import { contrastRatio } from '@/systems/UiHelpers';

describe('enemy tints read against their own ground (SPEC-035 §4.1)', () => {
  /** The planet a chapter plays on — every chapter has exactly one. */
  const groundOfChapter = new Map<number, { planet: string; ground: string }>();
  for (const planet of Object.values(PLANETS) as PlanetDef[]) {
    groundOfChapter.set(planet.chapter, { planet: planet.id, ground: planet.surface.palette.ground });
  }

  it('black on white is 21, and a colour against itself is 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#c19a5b', '#c19a5b')).toBeCloseTo(1, 10);
  });

  /**
   * §4.1: hue camouflage is a biome's identity, so the silhouette is carried by
   * value instead. 3:1 is the floor — the WCAG ratio for large text, and about
   * where a body stops disappearing into the ground at a glance. Bosses are
   * exempt: scale, emissive and the reveal carry them.
   */
  it('every non-boss surface enemy clears 3:1 against its chapter’s ground', () => {
    const problems: string[] = [];
    for (const enemy of Object.values(ENEMIES) as Enemy[]) {
      if (enemy.domain !== 'surface' || enemy.archetype === 'boss') continue;
      const chapter = groundOfChapter.get(enemy.chapter);
      if (chapter === undefined) {
        problems.push(`${enemy.id}: chapter ${enemy.chapter} has no planet`);
        continue;
      }
      const ratio = contrastRatio(enemy.look.tint, chapter.ground);
      if (ratio < 3) {
        problems.push(`${enemy.id}: ${enemy.look.tint} on ${chapter.planet} ${chapter.ground} is ${ratio.toFixed(2)}:1`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('the three SPEC-035 tips (SPEC-035 §4.8)', () => {
  it('exist with both wordings', () => {
    for (const id of ['combat', 'flight_steer', 'flight_throttle'] as const) {
      expect(TIP_IDS).toContain(id);
      expect(TIPS[id].keyboard.length).toBeGreaterThan(0);
      expect(TIPS[id].touch.length).toBeGreaterThan(0);
      expect(TIPS[id].keyboard).not.toBe(TIPS[id].touch);
    }
  });

  /** SPEC-034 §4.3 moved throttle-down to `X`; the tip has to say so. */
  it('names X for throttle down, not Ctrl', () => {
    expect(TIPS.flight_throttle.keyboard).toContain('X');
    expect(TIPS.flight_throttle.keyboard).not.toMatch(/Ctrl/i);
  });

  // SPEC-038 §4.9: auto-fire is on for every scheme, so the tip says so.
  it('teaches that auto-fire is on', () => {
    expect(TIPS.combat.keyboard).toMatch(/fires on its own/);
    expect(TIPS.combat.touch).toMatch(/fires on its own/);
    expect(TIPS.combat.keyboard).toBe(
      'Your gun fires on its own at the nearest enemy. Hold the left mouse button to pick the target yourself.',
    );
    expect(TIPS.combat.touch).toBe(
      'Your gun fires on its own at the nearest enemy. Drag on the right to pick the target yourself.',
    );
  });
});

describe('the dash in words (SPEC-038 §4.9)', () => {
  it('adds the dash tip with both wordings', () => {
    expect(TIP_IDS).toContain('dash');
    expect(TIPS.dash.keyboard).toBe(
      'A red lane or ring marks what is about to land. Right-click or V to dash through it — nothing touches you mid-dash.',
    );
    expect(TIPS.dash.touch).toBe(
      'A red lane or ring marks what is about to land. Tap DASH to slip through it — nothing touches you mid-dash.',
    );
  });

  it('the controls sheets gain a Dash row, and the keyboard Fire row says it is automatic', () => {
    expect(sheetRows('keyboard')).toContainEqual(['Dash', 'Right mouse or V']);
    expect(sheetRows('keyboard')).toContainEqual(['Fire', 'Automatic — hold Space or Left mouse to aim']);
    expect(sheetRows('touch')).toContainEqual(['Dash', 'DASH button']);
  });
});

describe('words that match the touch controls (SPEC-036 §4.11, §4.12)', () => {
  it('adds the zones tip with both wordings', () => {
    expect(TIP_IDS).toContain('zones');
    expect(TIPS.zones.keyboard.length).toBeGreaterThan(0);
    expect(TIPS.zones.touch).toBe('Left thumb moves, right thumb aims — auto-fire shoots for you.');
    expect(TIPS.zones.keyboard).not.toBe(TIPS.zones.touch);
  });

  it('no flight tip teaches a drag up or down, which is the fire zone on touch', () => {
    for (const id of TIP_IDS.filter((tip) => tip.startsWith('flight_'))) {
      expect(TIPS[id].touch, id).not.toMatch(/drag (up|down)/i);
    }
    expect(TIPS.flight_throttle.touch).toBe('Tap ▲ or ▼ to change speed.');
  });

  it('the launcher tip says a tap on its slot fires it', () => {
    expect(TIPS.heavy.touch).toBe("Tap the launcher's slot to fire it at the nearest enemy — it recharges by itself.");
  });

  it('the death hint has a touch wording, and neither wording sends the player to Settings', () => {
    expect(HINTS.death.nudge).toBe('Dying twice here? Q heals, and armor helps.');
    // SPEC-037 §4.10 rewrote the touch wording: the ITEM button is gone.
    expect(HINTS.death.touch).toBe('Dying twice here? Tap the heal slot on the bar, and armor helps.');
    for (const text of [HINTS.death.nudge, HINTS.death.touch ?? '']) {
      expect(text).not.toContain('Settings');
      expect(text).not.toMatch(/difficulty/i);
    }
  });
});

// ------------------------------------------------------------ SPEC-037 §4.10

/**
 * The touch rows of the pause menu's controls sheet, read from the source as
 * text: the table is a `ui/` constant, which a node test may not import
 * (SPEC-001 §4). Comments are stripped before the rows are read.
 */
function touchSheetRows(): Array<[string, string]> {
  return sheetRows('touch');
}

/** One scheme's rows of the controls sheet, read the same way (SPEC-038 §4.9 adds the keyboard's). */
function sheetRows(scheme: 'keyboard' | 'touch'): Array<[string, string]> {
  const source = readFileSync(new URL('../../src/ui/PauseMenu.ts', import.meta.url).pathname, 'utf8');
  const start = source.indexOf('const CONTROL_SHEETS');
  expect(start, 'CONTROL_SHEETS in PauseMenu.ts').toBeGreaterThan(-1);
  const at = source.indexOf(`${scheme}: [`, start);
  const end = source.indexOf('\n  ],', at);
  expect(at).toBeGreaterThan(start);
  expect(end).toBeGreaterThan(at);
  const block = source.slice(at, end).replace(/\/\/[^\n]*/g, '');
  return [...block.matchAll(/\[\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/g)].map((m) => [m[1] as string, m[2] as string]);
}

describe('no SWAP or ITEM in the touch words (SPEC-037 §4.10)', () => {
  const NAMES_A_GONE_BUTTON = /\b(SWAP|ITEM)\b/;

  it('the storm tip and the death hint send a thumb to the heal slot on the bar', () => {
    expect(TIPS.storm.touch).toBe(
      'A storm is ten seconds out. Caves and wrecks keep it off you — or tap the heal slot on the bar and push through.',
    );
    expect(HINTS.death.touch).toBe('Dying twice here? Tap the heal slot on the bar, and armor helps.');
  });

  it('no touch wording in TIPS or HINTS names SWAP or ITEM', () => {
    const problems: string[] = [];
    for (const id of TIP_IDS) {
      if (NAMES_A_GONE_BUTTON.test(TIPS[id].touch)) problems.push(`TIPS.${id}.touch`);
    }
    for (const [kind, hint] of Object.entries(HINTS)) {
      // A hint without its own touch wording shows its nudge (and fallback) on touch too.
      const touchLines = hint.touch !== undefined ? [hint.touch] : [hint.nudge, hint.fallback ?? ''];
      for (const text of touchLines) if (NAMES_A_GONE_BUTTON.test(text)) problems.push(`HINTS.${kind}`);
    }
    expect(problems).toEqual([]);
  });

  it('no row of the touch controls sheet names SWAP or ITEM', () => {
    const rows = touchSheetRows();
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows).toContainEqual(['Switch weapon', 'Tap a weapon on the bar']);
    expect(rows).toContainEqual(['Heal', 'Tap the heal slot on the bar']);
    for (const [what, how] of rows) {
      expect(`${what} ${how}`, what).not.toMatch(NAMES_A_GONE_BUTTON);
    }
  });
});
