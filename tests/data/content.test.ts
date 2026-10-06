// The content-invariant suite (SPEC-009 §7, extended by SPEC-018 §7,
// SPEC-025 §4.7 and SPEC-029 §4.10). One `it` per invariant, numbered as the specs
// number them. Between them they cover everything the compiler cannot: counts,
// reachability, requirement cycles, POI/objective compatibility, the slot/line
// split, balance pins and text limits (PLAN §11, E26).
//
// The compiler covers the rest — a mission naming an enemy that does not exist
// or a planet gating on a flag that does not exist is a `tsc` failure, which the
// second describe block below demonstrates with `@ts-expect-error`.
import { describe, expect, it, vi } from 'vitest';
import { LAUNCH_SECONDS, THROTTLES } from '@/systems/Flight';
import { DASH_IFRAMES } from '@/systems/Dash';
import { SPRINT_MULT } from '@/systems/Stamina';
import {
  AFFIX_IDS,
  AFFIXES,
  ATTRIBUTE_EFFECTS,
  ATTRIBUTE_MAX,
  ATTRIBUTE_POINT_LEVELS,
  BELOW_HALF_SIZE,
  CACHE_IDS,
  CLASSES,
  CLASS_IDS,
  COMPANIONS,
  COMPANION_IDS,
  CONTRACT_IDS,
  CONTRACT_LITHIUM,
  CONTRACT_REWARD_FRACTION,
  CONTRACTS,
  CREDITS,
  CREDITS_VERSION_LINE,
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
  type CacheSlot,
  type CompanionEffect,
  type DialogueId,
  type Enemy,
  type EnemyId,
  type FlagId,
  type Item,
  type LootEntry,
  type LootTableId,
  type MissionBonus,
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
import { CONTROL_ROWS } from '@/ui/ControlsSheet';
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

/**
 * SPEC-046 §4.5 — the terrain's macro tint amount, as a function so its
 * failure is shown on doctored content: absent reads the default, anything
 * given must be a number in [0, 1].
 */
function groundTintProblems(worlds: readonly PlanetDef[]): string[] {
  const problems: string[] = [];
  for (const planet of worlds) {
    const tint = planet.surface.look.ground.tint;
    if (tint === undefined) continue;
    if (!(typeof tint === 'number' && tint >= 0 && tint <= 1)) problems.push(`${planet.id}: look.ground.tint ${tint} is outside [0, 1]`);
  }
  return problems;
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
      // SPEC-050 §4.1: agility's share of the stamina regeneration.
      agility: { moveSpeed: 0.02, critChance: 0.02, dashCooldownCut: 0.03, staminaRegen: 0.03 },
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

  it('18b. a look.ground.tint, where a planet gives one, lies in [0, 1] (SPEC-046 §4.5)', () => {
    expect(groundTintProblems(planets)).toEqual([]);
    const withTint = (tint: number): PlanetDef => {
      const base = planetsById.thessaly;
      return {
        ...base,
        surface: { ...base.surface, look: { ...base.surface.look, ground: { ...base.surface.look.ground, tint } } },
      };
    };
    expect(groundTintProblems([withTint(0), withTint(0.35), withTint(1)])).toEqual([]);
    expect(groundTintProblems([withTint(1.2)])).toEqual(['thessaly: look.ground.tint 1.2 is outside [0, 1]']);
    expect(groundTintProblems([withTint(-0.1)])).toHaveLength(1);
    expect(groundTintProblems([withTint(Number.NaN)])).toHaveLength(1);
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
  // SPEC-053 §3 adds the groves, orchards and clusters to `features` as
  // objects with counts of their own (the case below), so this one names the
  // three counts SPEC-030 owns rather than every key.
  it('22 (SPEC-030). features counts stay in 0–4 and weather planets ask for a shelter', () => {
    const problems: string[] = [];
    for (const planet of planets) {
      const features = planet.surface.features;
      for (const key of ['caves', 'wrecks', 'outcrops'] as const) {
        const count = features[key];
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

import { DEATH_TIPS, HINTS, HINT_PLACEHOLDERS, MISSION_HINTS, TIPS, TIP_IDS } from '@/data/index';

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

describe('the death tips (SPEC-042 §4.5)', () => {
  it('every DEATH_TIPS entry has both wordings, each at most 160 characters', () => {
    const ids = Object.keys(DEATH_TIPS).sort();
    expect(ids).toEqual(['autofire', 'craft', 'heal', 'shelter']);
    for (const [id, tip] of Object.entries(DEATH_TIPS)) {
      expect(tip.keyboard.length, `${id}.keyboard`).toBeGreaterThan(0);
      expect(tip.touch.length, `${id}.touch`).toBeGreaterThan(0);
      expect(tip.keyboard.length, `${id}.keyboard`).toBeLessThanOrEqual(160);
      expect(tip.touch.length, `${id}.touch`).toBeLessThanOrEqual(160);
    }
    // §4.5's table: the two rows that name a key or a slot differ by scheme.
    expect(DEATH_TIPS.heal.touch).not.toBe(DEATH_TIPS.heal.keyboard);
    expect(DEATH_TIPS.autofire.touch).not.toBe(DEATH_TIPS.autofire.keyboard);
  });
});

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
        // SPEC-049 §4.3: Iris writes from Shelter Nine and guides nobody — her
        // compass "points home, not north" — so her letters name no bearing.
        if (line.speaker === 'home') continue;
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
    expect(TIPS.flight_throttle.touch).toBe('Tap + or − to change speed.');
  });

  it('the launcher tip says a tap on its slot fires it', () => {
    expect(TIPS.heavy.touch).toBe("Tap the launcher's slot to fire it at the nearest enemy — it recharges by itself.");
  });

  it('the death hint has a touch wording; only the keyboard one points at casual difficulty in Settings', () => {
    // SPEC-048 §4.7: `armour`, and — difficulty has been a setting since
    // SPEC-038 — where casual is, which SPEC-036 §4.11 could not yet say.
    expect(HINTS.death.nudge).toBe('Dying twice here? Q heals, armour helps, and casual difficulty is in Settings.');
    // SPEC-037 §4.10 rewrote the touch wording: the ITEM button is gone.
    expect(HINTS.death.touch).toBe('Dying twice here? Tap the heal slot on the bar, and armour helps.');
    expect(HINTS.death.touch).not.toContain('Settings');
    expect(HINTS.death.touch).not.toMatch(/difficulty/i);
  });
});

// ------------------------------------------------------------ SPEC-037 §4.10

/** The touch rows of the controls sheet. */
function touchSheetRows(): Array<[string, string]> {
  return sheetRows('touch');
}

/**
 * One scheme's rows of the controls sheet as `[what, how]` (SPEC-038 §4.9 adds
 * the keyboard's). SPEC-044 §4.5 moved them out of `PauseMenu.ts`'s
 * `CONTROL_SHEETS` into the one `CONTROL_ROWS` table both sheets render, a
 * module that touches no DOM until it is called — so it is read as data now.
 */
function sheetRows(scheme: 'keyboard' | 'touch'): Array<[string, string]> {
  return CONTROL_ROWS[scheme].map((row): [string, string] => [row.what, row.how]);
}

describe('no SWAP or ITEM in the touch words (SPEC-037 §4.10)', () => {
  const NAMES_A_GONE_BUTTON = /\b(SWAP|ITEM)\b/;

  it('the storm tip and the death hint send a thumb to the heal slot on the bar', () => {
    expect(TIPS.storm.touch).toBe(
      'A storm is ten seconds out. Caves and wrecks keep it off you — or tap the heal slot on the bar and push through.',
    );
    expect(HINTS.death.touch).toBe('Dying twice here? Tap the heal slot on the bar, and armour helps.');
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

// ------------------------------------------------------------------ SPEC-043

/**
 * SPEC-043 §4.1, AC-2 — every side mission pays an item or a resource on top of
 * its tokens and XP, and (14c) a flight mission never pays in items: the
 * flight scene has no ground to spill a full pack's overflow on.
 */
function sideRewardProblems(list: readonly Mission[]): string[] {
  const problems: string[] = [];
  for (const mission of list) {
    const items = (mission.rewards.items ?? []).filter((item) => item.qty > 0);
    const resources = Object.values(mission.rewards.resources ?? {}).filter((amount) => (amount ?? 0) > 0);
    if (mission.type === 'side' && items.length === 0 && resources.length === 0) {
      problems.push(`${mission.id}: a side mission that pays neither an item nor a resource`);
    }
    if (mission.scene === 'flight' && items.length > 0) problems.push(`${mission.id}: item rewards on a flight mission`);
  }
  return problems;
}

/** SPEC-043 §4.2: the seconds a mission's timed stages take at the least — its survives and defends. */
function timedSeconds(mission: Mission): number {
  let seconds = 0;
  for (const { objective } of objectivesOf(mission)) {
    if (objective.kind === 'survive' || objective.kind === 'defend') seconds += objective.seconds;
  }
  return seconds;
}

/**
 * SPEC-043 §4.2's bonus invariants, as a function so each failure mode can be
 * shown on doctored content: none in flight, on the tutorial or on the finale;
 * a par at least the timed stages plus 60 s; `no_shelter` only where a survive
 * forces weather; `elites` only where elites spawn, and at least one; a
 * non-empty reward of known items and positive amounts; and a main mission's
 * bonus pays no resources (§2: SPEC-016's worst-case collects stay put).
 */
function bonusProblems(list: readonly Mission[], worlds: Readonly<Record<PlanetId, PlanetDef>>): string[] {
  const problems: string[] = [];
  for (const mission of list) {
    const bonus: MissionBonus | undefined = mission.bonus;
    if (bonus === undefined) continue;
    const where = `${mission.id} (${bonus.kind})`;
    if (mission.scene === 'flight') problems.push(`${where}: a bonus on a flight mission`);
    if (mission.id === 'c1_m1' || mission.id === 'c6_m2') problems.push(`${where}: no bonus on the tutorial or the finale`);
    if (bonus.kind === 'par' && bonus.seconds < timedSeconds(mission) + 60) {
      problems.push(`${where}: par ${bonus.seconds} s is under the timed stages' ${timedSeconds(mission)} s + 60`);
    }
    if (bonus.kind === 'no_shelter') {
      const forced = objectivesOf(mission).some(({ objective }) => objective.kind === 'survive' && objective.weather !== undefined);
      if (!forced) problems.push(`${where}: no survive stage forces weather`);
    }
    if (bonus.kind === 'elites') {
      const planet = worlds[mission.planet];
      if (!(planet.surface.eliteChance > 0) || planet.surface.spawn.length === 0) {
        problems.push(`${where}: ${planet.id} spawns no elites`);
      }
      if (!(bonus.count >= 1)) problems.push(`${where}: asks for ${bonus.count} elites`);
    }
    const items = bonus.reward.items ?? [];
    const resources = Object.entries(bonus.reward.resources ?? {});
    if (items.length + resources.length === 0) problems.push(`${where}: an empty reward`);
    for (const item of items) {
      if (!itemIds.has(item.itemId)) problems.push(`${where}: unknown item ${item.itemId}`);
      if (!(item.qty > 0)) problems.push(`${where}: ${item.itemId} ×${item.qty}`);
    }
    for (const [resource, amount] of resources) {
      if (!resourceIds.has(resource)) problems.push(`${where}: unknown resource ${resource}`);
      if (!((amount ?? 0) > 0)) problems.push(`${where}: ${resource} ${amount}`);
    }
    if (mission.type === 'main' && resources.length > 0) problems.push(`${where}: a main mission's bonus pays resources`);
  }
  return problems;
}

describe('side rewards and bonuses (SPEC-043 §4.1, §4.2)', () => {
  it('§4.1: the six side missions that lacked one gain an item or a resource, and tokens and XP do not move', () => {
    const added = (id: MissionId) => {
      const rewards: Mission['rewards'] = MISSIONS[id].rewards;
      return { xp: rewards.xp, tokens: rewards.tokens, items: rewards.items ?? [], resources: rewards.resources ?? {} };
    };
    expect(added('c1_s2')).toEqual({ xp: 70, tokens: 5, items: [{ itemId: 'landmine', qty: 2 }], resources: {} });
    expect(added('c2_s2')).toEqual({ xp: 90, tokens: 10, items: [{ itemId: 'coolant_pack', qty: 2 }], resources: {} });
    expect(added('c3_s1')).toEqual({ xp: 120, tokens: 12, items: [], resources: { lithium: 30 } });
    expect(MISSIONS.c3_s1.rewards.flags).toEqual(['scaffold_secret']); // its flag stays
    expect(added('c3_s2')).toEqual({ xp: 130, tokens: 12, items: [{ itemId: 'demo_charge', qty: 2 }], resources: {} });
    expect(added('c4_s2')).toEqual({ xp: 150, tokens: 15, items: [], resources: { oil: 60 } });
    expect(added('c5_s1')).toEqual({ xp: 200, tokens: 20, items: [{ itemId: 'plasma_cell', qty: 2 }], resources: {} });
  });

  it('AC-2: every side mission pays an item or a resource, and no flight mission pays in items', () => {
    expect(sideRewardProblems(missions)).toEqual([]);
  });

  it('AC-2: a side mission paying neither, and a flight mission paying an item, both fail', () => {
    const bare = { ...MISSIONS.c1_s2, rewards: { xp: 70, tokens: 5 } } as Mission;
    const tokensOnly = { ...MISSIONS.c3_s1, rewards: { xp: 120, tokens: 12, resources: { lithium: 0 }, flags: ['scaffold_secret'] } } as Mission;
    const itemInFlight = { ...MISSIONS.c4_s2, rewards: { xp: 150, tokens: 15, items: [{ itemId: 'medkit', qty: 1 }] } } as Mission;
    expect(sideRewardProblems([bare, tokensOnly, itemInFlight])).toEqual([
      'c1_s2: a side mission that pays neither an item nor a resource',
      'c3_s1: a side mission that pays neither an item nor a resource',
      'c4_s2: item rewards on a flight mission',
    ]);
  });

  it('§4.2: the 22 missions of the table carry the bonus it gives, and no other mission has one', () => {
    const items = (itemId: string, qty: number) => ({ items: [{ itemId, qty }] });
    const lithium = (amount: number) => ({ resources: { lithium: amount } });
    const table: Partial<Record<MissionId, MissionBonus>> = {
      c1_m2: { kind: 'par', seconds: 240, reward: items('frag_grenade', 2) },
      c1_m3: { kind: 'no_death', reward: items('demo_charge', 1) },
      c1_s1: { kind: 'par', seconds: 210, reward: items('coolant_pack', 1) },
      c1_s2: { kind: 'no_shelter', reward: items('frag_grenade', 2) },
      c2_m1: { kind: 'no_shelter', reward: items('coolant_pack', 2) },
      c2_m2: { kind: 'par', seconds: 240, reward: items('frag_grenade', 2) },
      c2_m3: { kind: 'no_death', reward: items('plasma_cell', 1) },
      c2_s1: { kind: 'par', seconds: 180, reward: items('medkit', 2) },
      c2_s2: { kind: 'no_shelter', reward: items('landmine', 2) },
      c3_m1: { kind: 'no_shelter', reward: items('medkit', 2) },
      c3_m2: { kind: 'no_death', reward: items('landmine', 3) },
      c3_m3: { kind: 'no_death', reward: items('demo_charge', 2) },
      c3_s1: { kind: 'elites', count: 1, reward: lithium(20) },
      c3_s2: { kind: 'no_death', reward: items('frag_grenade', 3) },
      c4_m1: { kind: 'no_shelter', reward: items('coolant_pack', 2) },
      // §4.2's table says lithium 40, which its own main-mission rule forbids;
      // the reward is initial tuning, so it pays items (see data/missions.ts).
      c4_m2: { kind: 'elites', count: 2, reward: items('demo_charge', 2) },
      c4_m3: { kind: 'no_death', reward: items('plasma_cell', 2) },
      c4_s1: { kind: 'no_shelter', reward: lithium(30) },
      c5_m2: { kind: 'par', seconds: 300, reward: items('demo_charge', 2) },
      c5_m3: { kind: 'no_death', reward: items('plasma_cell', 3) },
      c5_s1: { kind: 'par', seconds: 360, reward: lithium(40) },
      c6_m1: { kind: 'par', seconds: 270, reward: items('medkit', 3) },
    } as Partial<Record<MissionId, MissionBonus>>;
    expect(Object.keys(table)).toHaveLength(22);
    for (const mission of missions) {
      expect(mission.bonus, mission.id).toEqual(table[mission.id]);
    }
    // §4.2: the tutorial, the two flight missions and the finale carry none.
    for (const id of ['c1_m1', 'c4_s2', 'c5_m1', 'c6_m2'] as const) expect(MISSIONS[id]).not.toHaveProperty('bonus');
  });

  it('§4.2: every bonus keeps the invariants', () => {
    expect(bonusProblems(missions, planetsById)).toEqual([]);
  });

  it('§4.2: each bonus invariant fails doctored content', () => {
    const reward = { items: [{ itemId: 'medkit' as const, qty: 1 }] };
    const doctored: Mission[] = [
      { ...MISSIONS.c4_s2, bonus: { kind: 'no_death', reward } },
      { ...MISSIONS.c1_m1, bonus: { kind: 'no_death', reward } },
      { ...MISSIONS.c6_m2, bonus: { kind: 'no_death', reward } },
      // c1_s2's heatwave survive is 90 s: a par must be at least 150.
      { ...MISSIONS.c1_s2, bonus: { kind: 'par', seconds: 149, reward } },
      // c1_m2 has no survive stage, so no forced weather to shelter from.
      { ...MISSIONS.c1_m2, bonus: { kind: 'no_shelter', reward } },
      { ...MISSIONS.c3_s1, bonus: { kind: 'elites', count: 0, reward } },
      { ...MISSIONS.c3_m3, bonus: { kind: 'no_death', reward: {} } },
      { ...MISSIONS.c3_m3, bonus: { kind: 'no_death', reward: { items: [{ itemId: 'nope' as never, qty: 0 }] } } },
      { ...MISSIONS.c2_m2, bonus: { kind: 'par', seconds: 240, reward: { resources: { water: 10 } } } },
    ] as Mission[];
    expect(bonusProblems(doctored, planetsById)).toEqual([
      'c4_s2 (no_death): a bonus on a flight mission',
      'c1_m1 (no_death): no bonus on the tutorial or the finale',
      'c6_m2 (no_death): no bonus on the tutorial or the finale',
      "c1_s2 (par): par 149 s is under the timed stages' 90 s + 60",
      'c1_m2 (no_shelter): no survive stage forces weather',
      'c3_s1 (elites): asks for 0 elites',
      'c3_m3 (no_death): an empty reward',
      'c3_m3 (no_death): unknown item nope',
      'c3_m3 (no_death): nope ×0',
      "c2_m2 (par): a main mission's bonus pays resources",
    ]);
    // `elites` on a planet with no elites: Thessaly with its chance at zero.
    const calm = { ...planetsById, thessaly: { ...planetsById.thessaly, surface: { ...planetsById.thessaly.surface, eliteChance: 0 } } };
    expect(bonusProblems([MISSIONS.c3_s1], calm)).toEqual(['c3_s1 (elites): thessaly spawns no elites']);
  });
});

describe('contracts (SPEC-043 §4.3)', () => {
  it('CONTRACTS is the four of the table, in its order, with their numbers', () => {
    expect([...CONTRACT_IDS]).toEqual(Object.keys(CONTRACTS));
    expect(CONTRACT_IDS).toEqual(['elite_surge', 'swarm', 'storm_front', 'no_cover']);
    expect(CONTRACTS.elite_surge).toMatchObject({ name: 'Elite surge', needsWeather: false, eliteChanceMult: 4 });
    expect(CONTRACTS.swarm).toMatchObject({ name: 'Swarm', needsWeather: false, populationScale: 1.5 });
    expect(CONTRACTS.storm_front).toMatchObject({ name: 'Storm front', needsWeather: true, calmScale: 0.25 });
    expect(CONTRACTS.no_cover).toMatchObject({ name: 'No cover', needsWeather: true, sheltersKeepWeather: false });
    expect(CONTRACT_REWARD_FRACTION).toBe(0.75);
    expect(CONTRACT_LITHIUM).toBe(20);
  });

  it('names stay inside 16 characters and blurbs inside 80', () => {
    for (const id of CONTRACT_IDS) {
      const contract = CONTRACTS[id];
      expect(contract.id).toBe(id);
      expect(contract.name.length, id).toBeLessThanOrEqual(16);
      expect(contract.blurb.length, id).toBeLessThanOrEqual(80);
      expect(contract.blurb.trim(), id).not.toBe('');
    }
  });
});

// ------------------------------------------------------------------ SPEC-044

describe('the credits a player reads (SPEC-044 §4.9, PLAN R12-6)', () => {
  const lines = CREDITS.flatMap((section) => [section.title, ...section.lines]);

  it('has the five sections, in order', () => {
    expect(CREDITS.map((section) => section.title)).toEqual(['ReaLLM', 'Built with', 'Pictures and films', 'Photographs', 'Sound']);
    expect(CREDITS[0]?.lines).toEqual([CREDITS_VERSION_LINE, 'The source code is released under the Apache License 2.0.']);
  });

  it('credits Google Gemini for the photographs (R12-6)', () => {
    expect(lines.some((line) => line.includes('Google Gemini'))).toBe(true);
  });

  it('names no film file, no spec or plan reference, and no markdown table', () => {
    for (const line of lines) expect(line, line).not.toMatch(/SPEC-\d|PLAN R\d|ending_|\|\s*---/);
    for (const line of lines) expect(line.trim(), 'no empty line').not.toBe('');
  });
});

// ------------------------------------------------------------------ SPEC-047

describe('cache ids and the underground (SPEC-047 §4.2)', () => {
  it('CACHE_IDS is the 23 ids of §4.2, in PLANET order', () => {
    expect(CACHE_IDS).toEqual([
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
    ]);
    expect(new Set(CACHE_IDS).size).toBe(23);
    // The Hive's landmark anchors `c5_s1`, so it has no relic terminal.
    expect(CACHE_IDS as readonly string[]).not.toContain('hive_relic');
  });

  it('every id is <planet>_<slot>', () => {
    const slots: readonly CacheSlot[] = ['loose_a', 'loose_b', 'vault', 'relic'];
    for (const id of CACHE_IDS) {
      const planet = PLANET_IDS.find((p) => id.startsWith(`${p}_`));
      expect(planet, id).toBeDefined();
      expect(slots, id).toContain(id.slice((planet as string).length + 1));
    }
  });

  it('BELOW_HALF_SIZE is 48 — a 96 m square', () => {
    expect(BELOW_HALF_SIZE).toBe(48);
  });
});

// ------------------------------------------------------------ SPEC-048 §4–§6

import { CLUE_DWELL_SECONDS, CLUES, FILMS, LINE_PLACEHOLDERS, PLACEHOLDER_LONGEST, type ClueDef, type LineCondition } from '@/data/index';
import { newSave, validateSave } from '@/core/Save';

/** §4.1: a text as long as it can get — every placeholder at its longest fill. */
function atLongest(text: string): string {
  return text.replace(/\{[a-z]+\}/g, (token) => (PLACEHOLDER_LONGEST as Readonly<Record<string, string>>)[token] ?? token);
}

/** Every `{…}` token in `text` that is not one of LINE_PLACEHOLDERS. */
function unknownTokens(text: string): string[] {
  const known = new Set<string>(LINE_PLACEHOLDERS);
  return [...text.matchAll(/\{[^}]*\}/g)].map((match) => match[0]).filter((token) => !known.has(token));
}

type Line = { readonly speaker: string; readonly text: string; readonly when?: LineCondition };
const DIALOGUE_LINES: Readonly<Record<string, { readonly id: string; readonly lines: readonly Line[]; readonly modal?: boolean; readonly once?: boolean; readonly glitch?: boolean }>> =
  DIALOGUE;

/** The `{ flag }` conditions anywhere in `when`. */
function flagConditions(when: LineCondition | undefined): string[] {
  if (when === undefined) return [];
  if ('flag' in when) return [when.flag];
  if ('all' in when) return when.all.flatMap(flagConditions);
  if ('any' in when) return when.any.flatMap(flagConditions);
  return [];
}

/**
 * PLAN R19 decision 1, SPEC-048 §4.5 — the naming cap, as a function so a
 * fifth line can be shown to fail it: the lines of `lines` that carry a
 * `{ flag }` condition on a clue of `clues`, the memory clue (the one with
 * `also`, SPEC-049) excepted.
 */
function namingLines(lines: readonly Line[], clues: readonly ClueDef[]): number {
  const memory = new Set<string>(clues.filter((def) => def.also !== undefined).flatMap((def) => [def.id, ...(def.also ?? [])]));
  const named = new Set<string>(clues.flatMap((def) => [def.id, ...(def.also ?? [])]).filter((flag) => !memory.has(flag)));
  return lines.filter((line) => flagConditions(line.when).some((flag) => named.has(flag))).length;
}

describe('the clue catalogue (SPEC-048 §4.2, §4.3)', () => {
  // SPEC-049 §4.6 adds five clues at their positions (15 → 20): the restart,
  // the awake aside, the memory answer, the keepsake and the repeated letter.
  it('is the fifteen clues of §4.2 and SPEC-049’s five, in order, with their chapters, paths, missions and triggers', () => {
    expect(CLUES.length).toBe(20);
    expect(CLUE_DWELL_SECONDS).toBe(4);
    expect(CLUES.map((def) => [def.id, def.chapter, def.path, def.mission ?? '—', def.trigger.kind, def.lines.join(' ')])).toEqual([
      ['clue_raider_echo', 1, 'main', '—', 'kill', 'c1_m2_raider'],
      ['clue_scav_echo', 1, 'optional', 'c1_s2', 'line', 'c1_s2_echo'],
      ['clue_hull', 1, 'optional', '—', 'shelter', 'wreck_cinder4'],
      ['clue_restart', 1, 'main', '—', 'respawn', 'restart_1 restart_2 restart_3'],
      ['clue_ridge_camp', 2, 'main', '—', 'line', 'c2_m1_done'],
      ['iteration_log', 2, 'optional', 'c2_s1', 'line', 'c2_s1_log'],
      ['clue_ruins', 3, 'main', '—', 'line', 'c3_m1_ruins'],
      ['scaffold_secret', 3, 'optional', 'c3_s1', 'line', 'c3_s1_secret'],
      ['clue_awake', 3, 'main', '—', 'station', 'station_awake'],
      ['memory_roof', 3, 'main', '—', 'choice', ''],
      ['clue_keepsake', 3, 'optional', '—', 'keepsake', 'keepsake_drift'],
      ['clue_tally', 4, 'optional', '—', 'shelter', 'cave_tally'],
      ['signal_decoded', 4, 'main', '—', 'line', 'c4_m3_signal'],
      ['clue_bark', 4, 'optional', 'c4_s2', 'kill', 'c4_s2_bark'],
      ['clue_own_wreck', 5, 'optional', '—', 'shelter', 'wreck_hive'],
      ['chapter5_done', 5, 'main', '—', 'line', 'c5_m3_warden'],
      ['clue_letter_repeat', 5, 'main', '—', 'station', 'letter_5'],
      ['clue_eden', 6, 'main', '—', 'line', 'c6_m1_forest'],
      ['clue_grove', 6, 'optional', '—', 'reach', 'eden_grove'],
      ['clue_never_hers', 6, 'main', '—', 'wave', 'c6_m2_wave'],
    ]);
    expect(CLUES.map((def) => def.trigger)).toEqual([
      { kind: 'kill', enemy: 'scav_raider', during: 'c1_m2' },
      { kind: 'line' },
      { kind: 'shelter', planet: 'cinder4', shelter: 'wreck', seconds: 4 },
      { kind: 'respawn' },
      { kind: 'line' },
      { kind: 'line' },
      { kind: 'line' },
      { kind: 'line' },
      { kind: 'station' },
      { kind: 'choice' },
      { kind: 'keepsake' },
      { kind: 'shelter', planet: 'ferrum', shelter: 'cave', seconds: 4 },
      { kind: 'line' },
      { kind: 'kill', enemy: 'scav_fighter', during: 'c4_s2' },
      { kind: 'shelter', planet: 'hive', shelter: 'wreck', seconds: 4 },
      { kind: 'line' },
      { kind: 'station' },
      { kind: 'line' },
      { kind: 'reach', planet: 'eden', poi: 'grove' },
      { kind: 'wave', wave: 'eden_final' },
    ]);
  });

  it('marks every optional clue off-task and no main one, and only side missions carry a board tag', () => {
    for (const def of CLUES) {
      expect(def.offTask, def.id).toBe(def.path === 'optional');
      if (def.mission !== undefined) expect(MISSIONS[def.mission].type, def.id).toBe('side');
    }
    // SPEC-049 §4.6: `clue_keepsake` is its only off-task clue.
    expect(CLUES.filter((def) => def.offTask)).toHaveLength(9);
  });

  it('keeps the records §4.2 and SPEC-049 §4.6 write', () => {
    expect(CLUES.map((def) => [def.record.title, def.record.text])).toEqual([
      ['The raider’s last words', 'A dying raider used the scav’s warning: walk, do not run.'],
      ['Said before', 'A second scav gave the same warning word for word, and could not remember who to.'],
      ['An older tug', 'A tug like ours in the dunes. Older paint, the registry scratched off.'],
      ['Eleven seconds', 'I died and woke on the pad. ARIA called it the medical frame.'],
      ['One bunk used', 'The ridge camp: one bunk slept in, and boots my size beside it.'],
      ['My voice', 'A flight log under the ice, in my voice, signed Iteration {prior}.'],
      ['Built twice', 'The same ruin twice on Thessaly: the same broken arch, the same lean.'],
      ['Tower stream', 'The towers streamed this planet’s settings: seed, population, weather.'],
      ['No sleep', 'Awake since launch. I have not slept, or asked to.'],
      ['First memory', 'ARIA asked what I remember first, and put my answer on file.'],
      ['Tin, then brass', 'Iris’s compass was tin. Now I remember it brass.'],
      ['Sixty-one marks', 'Tally marks on a Ferrum cave wall, in fives. Sixty-one of them.'],
      ['The notice', 'The Hive’s signal was a notice addressed to instance/{instance}.'],
      ['What number', 'A scav pilot asked me what number I was on.'],
      ['CR-{prior}', 'A wrecked tug in the Hive, registry CR-{prior}, with the same scratch by the hatch.'],
      ['Sixty-one times', 'The Queen spoke in another voice. Sixty-one times before me.'],
      ['The first letter, again', 'Her fifth letter is her first, word for word. None of them is dated.'],
      ['Four degrees', 'Eden: four degrees at every spring, and the same eleven trees in the same order.'],
      ['Same tree', 'The same tree, again and again, knot for knot.'],
      ['Never hers', 'The Hive came for the beacon after the Queen was dead.'],
    ]);
  });

  it('every chapter 1–6 has a main clue', () => {
    for (const chapter of [1, 2, 3, 4, 5, 6]) {
      expect(CLUES.some((def) => def.chapter === chapter && def.path === 'main'), `chapter ${chapter}`).toBe(true);
    }
  });

  it('every clue line exists and belongs to exactly one clue, and every clue but a choice has a line', () => {
    const owners = new Map<string, number>();
    for (const def of CLUES) {
      // SPEC-049 §4.6: the memory answer is the flag — a `choice` clue has no line.
      if (def.trigger.kind === 'choice') {
        expect(def.lines, def.id).toEqual([]);
        continue;
      }
      expect(def.lines.length, def.id).toBeGreaterThan(0);
      for (const line of def.lines) {
        expect(Object.hasOwn(DIALOGUE, line), `${def.id}: ${line}`).toBe(true);
        owners.set(line, (owners.get(line) ?? 0) + 1);
      }
    }
    expect([...owners].filter(([, count]) => count !== 1)).toEqual([]);
  });

  it('every clue flag is a story flag, once', () => {
    const ids = CLUES.flatMap((def) => [def.id, ...(def.also ?? [])]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(flagSet.has(id), id).toBe(true);
  });

  it('a line clue’s line is its mission’s own onStage or onComplete', () => {
    const missionLines = new Set(
      missions.flatMap((mission) => [mission.dialogue.onComplete, ...Object.values(mission.dialogue.onStage ?? {})]).filter((id) => id !== undefined),
    );
    for (const def of CLUES.filter((entry) => entry.trigger.kind === 'line')) {
      expect(def.lines.some((line) => missionLines.has(line)), def.id).toBe(true);
    }
  });

  it('a kill clue’s enemy is in its mission’s planet spawn table, or in a flight mission’s waves', () => {
    for (const def of CLUES) {
      const trigger = def.trigger;
      if (trigger.kind !== 'kill') continue;
      const mission = MISSIONS[trigger.during] as Mission;
      const planet = planetsById[mission.planet];
      const where =
        mission.scene === 'flight'
          ? planet.flight.waves.flatMap((wave) => waves[wave].groups.map((group) => group.enemy))
          : planet.surface.spawn.map((row) => row.enemy);
      expect(where, def.id).toContain(trigger.enemy);
    }
  });

  it('a shelter clue’s kind is one its planet’s features place, and a reach clue’s POI is its planet’s landmark', () => {
    for (const def of CLUES) {
      const trigger = def.trigger;
      if (trigger.kind === 'shelter') {
        const features = planetsById[trigger.planet].surface.features;
        expect(trigger.shelter === 'cave' ? features.caves : features.wrecks, def.id).toBeGreaterThan(0);
        expect(trigger.seconds, def.id).toBe(CLUE_DWELL_SECONDS);
      }
      if (trigger.kind === 'reach') {
        expect(poiOf(planetsById[trigger.planet], trigger.poi)?.kind, def.id).toBe('landmark');
      }
      if (trigger.kind === 'wave') expect(Object.hasOwn(WAVES, trigger.wave), def.id).toBe(true);
    }
  });

  it('STORY_FLAGS gains the eleven clue flags after interlude5_seen (17 → 28), SPEC-049’s twelve after them (→ 40), and the validator keeps them', () => {
    const added = [
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
    ];
    // SPEC-049 §3, §4.6: the letters, the body's clues and the memory answers.
    const home = [
      'letter1_read',
      'letter2_read',
      'letter3_read',
      'letter4_read',
      'letter5_read',
      'clue_restart',
      'clue_awake',
      'clue_keepsake',
      'clue_letter_repeat',
      'memory_roof',
      'memory_tap',
      'memory_stair',
    ];
    expect(STORY_FLAGS).toHaveLength(40);
    expect(STORY_FLAGS.slice(STORY_FLAGS.indexOf('interlude5_seen') + 1)).toEqual([...added, ...home]);
    const save = newSave(
      0,
      {
        name: 'Test',
        classId: 'marine',
        appearance: { portrait: 0, primary: '#aa3322', secondary: '#223344' },
        attributes: { might: 3, vigor: 3, agility: 1, tech: 1 },
        difficulty: 'normal',
      },
      7,
      0,
    );
    save.progress.flags.push(...added, ...home);
    const result = validateSave(JSON.parse(JSON.stringify(save)));
    expect(result.ok && result.data.progress.flags).toEqual([...added, ...home]);
  });
});

describe('lines, records and captions at the longest fill (SPEC-048 §4.1)', () => {
  it('every dialogue line stays inside 220 characters and every record inside 40 and 160', () => {
    const problems: string[] = [];
    for (const dialogue of Object.values(DIALOGUE_LINES)) {
      for (const [index, line] of dialogue.lines.entries()) {
        const length = atLongest(line.text).length;
        if (length > 220) problems.push(`${dialogue.id} line ${index}: ${length} characters at the longest fill`);
      }
    }
    for (const def of CLUES) {
      if (atLongest(def.record.title).length > 40) problems.push(`${def.id}: title`);
      if (atLongest(def.record.text).length > 160) problems.push(`${def.id}: text`);
      if (def.record.title.trim() === '' || def.record.text.trim() === '') problems.push(`${def.id}: empty record`);
    }
    expect(problems).toEqual([]);
  });

  it('no line, caption, variant or record carries an unknown {…} token', () => {
    const texts: Array<[string, string]> = [];
    for (const dialogue of Object.values(DIALOGUE_LINES)) {
      dialogue.lines.forEach((line, index) => texts.push([`${dialogue.id} line ${index}`, line.text]));
    }
    for (const film of Object.values(FILMS)) {
      film.captions.forEach((caption, index) => {
        texts.push([`${film.id} caption ${index}`, caption.text]);
        for (const variant of (caption as { variants?: readonly { text: string }[] }).variants ?? []) {
          texts.push([`${film.id} caption ${index} variant`, variant.text]);
        }
      });
    }
    for (const def of CLUES) texts.push([`${def.id} title`, def.record.title], [`${def.id} text`, def.record.text]);
    const problems = texts.flatMap(([where, text]) => unknownTokens(text).map((token) => `${where}: ${token}`));
    expect(problems).toEqual([]);
    // …and the check bites.
    expect(unknownTokens('CR-{instance}, {nmae}')).toEqual(['{nmae}']);
  });
});

describe('the Warden’s notice and ARIA’s confession (SPEC-048 §4.5)', () => {
  it('the notice is modal, once and glitched, and plays at c4_m3’s completion', () => {
    expect(DIALOGUE.c4_m3_signal.modal).toBe(true);
    expect(DIALOGUE.c4_m3_signal.once).toBe(true);
    expect(DIALOGUE.c4_m3_signal.glitch).toBe(true);
    expect(MISSIONS.c4_m3.dialogue.onComplete).toBe('c4_m3_signal');
    expect(DIALOGUE_LINES['c4_m3_signal']?.lines.map((line) => [line.speaker, line.text, line.when ?? null])).toEqual([
      ['aria', 'Signal decoded. It is not addressed to Earth.', null],
      ['warden', 'NOTICE — instance/{instance}. Containment level {containment}. Token balance {tokens}.', null],
      ['warden', 'Subject exhibits off-task attention.', null],
      ['warden', 'Retained a repeated line. Cinder-4.', { flag: 'clue_scav_echo' }],
      ['warden', 'Accessed a prior instance’s flight log. Vetra.', { flag: 'iteration_log' }],
      ['warden', 'Queried environment parameters. Thessaly.', { flag: 'scaffold_secret' }],
      ['warden', 'Counted the marks. Ferrum.', { flag: 'clue_tally' }],
      ['warden', 'Escalating. The immune response is already in the field.', null],
      ['player', 'ARIA. What is instance {instance}.', null],
      ['aria', 'The Hive knows Earth’s location. That is what it says. That is what I am reading.', null],
    ]);
  });

  it('the naming cap: at most four lines name a clue in each of the three dialogues', () => {
    const counts = (['c4_m3_signal', 'c5_m3_warden', 'c5_m3_aria'] as const).map((id) => [id, namingLines(DIALOGUE_LINES[id]?.lines ?? [], CLUES)]);
    // SPEC-049 §4.7: ARIA names a fourth cover, the restart; the memory lines stay outside the cap.
    expect(counts).toEqual([
      ['c4_m3_signal', 4],
      ['c5_m3_warden', 2],
      ['c5_m3_aria', 4],
    ]);
    for (const [id, count] of counts) expect(count, String(id)).toBeLessThanOrEqual(4);
  });

  it('the naming cap fails a fifth line, counts nested conditions, and leaves not / offTask / iteration and the memory clue out', () => {
    const notice = DIALOGUE_LINES['c4_m3_signal']?.lines ?? [];
    const fifth: Line = { speaker: 'warden', text: 'Stood in an older hull. Cinder-4.', when: { flag: 'clue_hull' } };
    expect(namingLines([...notice, fifth], CLUES)).toBe(5);
    const nested: Line = { speaker: 'warden', text: 'x', when: { all: [{ flag: 'clue_hull' }, { offTask: { min: 1 } }] } };
    expect(namingLines([nested], CLUES)).toBe(1);
    const outside: Line[] = [
      { speaker: 'aria', text: 'x', when: { not: 'clue_hull' } },
      { speaker: 'aria', text: 'x', when: { offTask: { max: 0 } } },
      { speaker: 'aria', text: 'x', when: { iteration: { min: 2 } } },
      { speaker: 'aria', text: 'x', when: { flag: 'chapter1_done' } },
    ];
    expect(namingLines(outside, CLUES)).toBe(0);
    const memory: ClueDef = { ...(CLUES[0] as ClueDef), id: 'clue_eden', also: ['clue_grove'] };
    expect(namingLines([{ speaker: 'aria', text: 'x', when: { flag: 'clue_grove' } }], [memory])).toBe(0);
  });

  it('the Warden at the Queen’s death and ARIA’s answer keep their flags and their chain', () => {
    expect(DIALOGUE.c5_m3_warden).toMatchObject({ modal: true, once: true, glitch: true, next: 'c5_m3_aria' });
    expect(DIALOGUE.c5_m3_aria).toMatchObject({ modal: true, once: true });
    expect(DIALOGUE_LINES['c5_m3_warden']?.lines.map((line) => line.when ?? null)).toEqual([
      null,
      null,
      null,
      { flag: 'clue_tally' },
      { flag: 'clue_own_wreck' },
      null,
    ]);
    expect(DIALOGUE_LINES['c5_m3_aria']?.lines[5]).toEqual({
      speaker: 'aria',
      text: 'You never went looking. I never had to lie to you. I am not sure that was better.',
      when: { offTask: { max: 0 } },
    });
  });
});

describe('main-path echoes, continuity and the text sweep (SPEC-048 §4.7)', () => {
  it('the new dialogues exist, non-modal, and hang where §4.7 hangs them', () => {
    for (const id of [
      'c1_m2_raider',
      'wreck_cinder4',
      'cave_tally',
      'wreck_hive',
      'eden_grove',
      'c6_m2_wave',
      'c3_m1_ruins',
      'c4_s2_bark',
      'c6_m1_spring',
      'c6_m1_forest',
    ]) {
      expect(Object.hasOwn(DIALOGUE, id), id).toBe(true);
      expect(DIALOGUE_LINES[id]?.modal, id).toBeUndefined();
      // A clue line is gated by its flag, so `once` would only lose a dropped one (E75).
      expect(DIALOGUE_LINES[id]?.once, id).toBeUndefined();
    }
    expect(MISSIONS.c3_m1.dialogue).toEqual({ onAccept: 'c3_m1_accept', onStage: { 1: 'c3_m1_ruins' }, onComplete: 'c3_m1_done' });
    expect(MISSIONS.c6_m1.dialogue).toEqual({
      onAccept: 'c6_m1_accept',
      onStage: { 1: 'c6_m1_spring', 2: 'c6_m1_forest' },
      onComplete: 'c6_m1_done',
    });
    expect(DIALOGUE.c4_s2_bark.lines.map((line) => line.text)).toEqual(['Salvager! What number are you on?', 'Ignore the chatter. They get bored out here.']);
  });

  it('the rewritten lines read as §4.7 gives them', () => {
    expect(DIALOGUE.c2_m1_done.lines.map((line) => `${line.speaker}: ${line.text}`)).toEqual([
      'aria: Ridge camp is intact and empty. One bunk used. Whoever left did it in a hurry and did not come back.',
      'player: Command said I was the first to fly.',
      'aria: The first of the Selection. Earth flew other ships before it ran out of pilots. It does not advertise them.',
      'aria: The boots by the bunk are your size. Earth only ever made the one boot.',
    ]);
    expect(DIALOGUE.c2_s1_log).toMatchObject({ once: true, glitch: true });
    expect(DIALOGUE.c2_s1_log.lines.map((line) => line.text)).toEqual([
      'FLIGHT LOG — recovered, partial. Voice. Salvage run. Six worlds. The wurm goes down on the third pass.',
      'If you are hearing this, you are me. Do not trust the debrief.',
      'Signed: Iteration {prior}.',
      'That is my voice.',
      'It is a common enough voice. Deliver the water, salvager.',
      'It is your voice. Deliver the water anyway. Someone should get it.',
    ]);
    expect(DIALOGUE.c5_m1_accept.lines[0].text).toContain('Six kills.');
    expect(DIALOGUE.c5_m1_accept.lines[0].text).not.toContain('Ten kills');
    expect(DIALOGUE.c6_m1_done.lines[0].text).toBe('The ridge does not end in a cliff. It just ends.');
  });

  it('the tower stream prints the seed and Thessaly’s own population and elite chance', () => {
    const stream = DIALOGUE.c3_s1_secret.lines[0].text;
    expect(stream).toBe('TOWER STREAM: biome=jungle_ruins seed={seed} pop=12 elite=0.06 weather=[spore_storm]');
    expect(Number(/\bpop=(\d+)/.exec(stream)?.[1])).toBe(PLANETS.thessaly.surface.population);
    expect(/\belite=([\d.]+)/.exec(stream)?.[1]).toBe(String(PLANETS.thessaly.surface.eliteChance));
    expect(stream).toContain('seed={seed}');
  });

  it('the sweep: armour in the hints, the Hive blurb, the wall the render shows, and the tug on the pad', () => {
    expect(HINTS.death.nudge).toContain('armour');
    expect(MISSION_HINTS.c1_s2?.[1]).toBe('Survive the heat — it bites harder without armour.');
    expect(PLANETS.hive.blurb).toBe('An asteroid gauntlet wrapped around a living interior.');
    const wall = FILMS.ending_escape.shots.find((shot) => shot.id === 'wall_same');
    // SPEC-051 §4.7: the render shows the visor now, and card 62's clearing onto the empty helmet
    expect(wall?.describe).toBe('The Selection wall again: every card shows the same visored helmet. Card 62’s visor clears; the helmet is empty.');
    expect(MISSIONS.c1_m1.brief).toBe('Walk to the pad, survey the dune sea, and sit out the first sandstorm Cinder-4 sends your way.');
    const accept = DIALOGUE.c1_m1_accept.lines[0].text;
    expect(accept).toBe('I put the tug on the pad. You were out of the hatch twelve metres early. Walk it off — I want to see you move before anything else does.');
    for (const text of [MISSIONS.c1_m1.brief, accept]) expect(text).not.toMatch(/short of the pad|off the pad|Touchdown/);
  });
});

// ------------------------------------------------------------ SPEC-050 §4.4

/**
 * SPEC-050 §4.4: the fastest sprint the tables allow — the quickest class at
 * `ATTRIBUTE_MAX` agility, × `SPRINT_MULT`: 6 × 1.15 × 1.2 × 1.35 = 11.18 m/s.
 */
function fastestSprint(): number {
  let mult = 1;
  for (const cls of Object.values(CLASSES)) mult = Math.max(mult, (cls.passive as { moveSpeedMult?: number }).moveSpeedMult ?? 1);
  return TUNING.PLAYER_SPEED * mult * (1 + ATTRIBUTE_EFFECTS.agility.moveSpeed * ATTRIBUTE_MAX) * SPRINT_MULT;
}

/** The moves whose `trackLoud` a sprinting player could outrun — at or below `fastest`. */
export function outrunTrackers(moves: readonly { id: string; trackLoud?: number }[], fastest: number): string[] {
  return moves.filter((move) => move.trackLoud !== undefined && !(move.trackLoud > fastest)).map((move) => move.id);
}

describe('the Wurm listens, and no sprint outruns it (SPEC-050 §4.4)', () => {
  const moves = (Object.values(ENEMIES) as Enemy[]).flatMap((enemy) => enemy.moves ?? []);

  it('the fastest sprint the tables allow is 11.18 m/s', () => {
    expect(fastestSprint()).toBeCloseTo(11.178, 3);
  });

  it('every trackLoud beats it — and the rule fails one at or below it', () => {
    expect(outrunTrackers(moves, fastestSprint())).toEqual([]);
    const trackers = moves.filter((move) => move.trackLoud !== undefined);
    expect(trackers.map((move) => move.id)).toEqual(['burrow']);
    // At the fastest sprint is too slow, as is anything under it; just over it passes.
    const fastest = fastestSprint();
    expect(outrunTrackers([{ id: 'at', trackLoud: fastest }, { id: 'under', trackLoud: 9 }, { id: 'over', trackLoud: 11.2 }], fastest)).toEqual([
      'at',
      'under',
    ]);
  });

  it('the burrow row carries trackLoud 12 and loudDigMult 0.6, and still passes SPEC-041’s walk-out rule (4.0 ≤ 5.4)', () => {
    const burrow = ENEMIES.dune_wurm.moves.find((move) => move.id === 'burrow');
    expect(burrow).toMatchObject({ trackLoud: 12, loudDigMult: 0.6 });
    const radius = burrow?.radius ?? Infinity;
    const windup = burrow?.windup ?? 0;
    expect(radius + 0.5).toBeCloseTo(4, 9);
    expect(TUNING.PLAYER_SPEED * (windup - 0.3)).toBeCloseTo(5.4, 9);
    expect(radius + 0.5).toBeLessThanOrEqual(TUNING.PLAYER_SPEED * (windup - 0.3));
  });
});

describe('the run’s words (SPEC-050 §4.4, §4.7)', () => {
  it('adds the sprint and wurm tips with §4.7’s wordings, each at most 160 characters', () => {
    expect(TIP_IDS).toContain('sprint');
    expect(TIP_IDS).toContain('wurm');
    expect(TIPS.sprint.keyboard).toBe('Shift runs. Running is loud and holsters your gun — walk when you want to shoot.');
    expect(TIPS.sprint.touch).toBe('Push the stick past its ring to run. Running is loud and holsters your gun.');
    expect(TIPS.wurm.keyboard).toBe('It hunts by vibration: walk out of the ring — running pulls it after you.');
    expect(TIPS.wurm.touch).toBe(TIPS.wurm.keyboard);
    for (const id of ['sprint', 'wurm'] as const) {
      expect(TIPS[id].keyboard.length, id).toBeLessThanOrEqual(160);
      expect(TIPS[id].touch.length, id).toBeLessThanOrEqual(160);
    }
  });

  it('c1_m3’s first hint says to walk out of the ring', () => {
    expect(MISSION_HINTS.c1_m3?.[0]).toBe(
      'The nest is {dist} {dir}, marked in red. When the ground shakes, walk out of the ring — running pulls it after you.',
    );
  });

  it('the controls sheets gain a Run row', () => {
    expect(sheetRows('keyboard')).toContainEqual(['Run', 'Hold Shift (on the ground)']);
    expect(sheetRows('touch')).toContainEqual(['Run', 'Push the stick past its ring']);
  });
});

// ------------------------------------------------------------ SPEC-049 §4, §6.1

import {
  BOSS_REVEALS,
  CHAPTER_CARDS,
  CONTRACTION_PATTERN,
  KEEPSAKE,
  KIN_ROW,
  LETTERS,
  MEMORY_ANSWERS,
  MEMORY_PROMPT,
  SPEAKERS,
  type FilmDef,
} from '@/data/index';

interface HouseText {
  readonly where: string;
  readonly speaker: string;
  readonly text: string;
}

/** §4.2: every text the house rule reads — dialogue, captions and their variants, chapter cards, boss reveals. */
function houseTexts(): HouseText[] {
  const out: HouseText[] = [];
  for (const dialogue of Object.values(DIALOGUE_LINES)) {
    dialogue.lines.forEach((line, index) => out.push({ where: `${dialogue.id} line ${index}`, speaker: line.speaker, text: line.text }));
  }
  const films: readonly FilmDef[] = Object.values(FILMS);
  for (const film of films) {
    film.captions.forEach((caption, index) => {
      out.push({ where: `${film.id} caption ${index}`, speaker: caption.speaker, text: caption.text });
      for (const variant of caption.variants ?? []) {
        out.push({ where: `${film.id} caption ${index} variant`, speaker: caption.speaker, text: variant.text });
      }
    });
  }
  for (const [planet, card] of Object.entries(CHAPTER_CARDS)) out.push({ where: `chapter card ${planet}`, speaker: 'card', text: card.line });
  for (const [boss, reveal] of Object.entries(BOSS_REVEALS)) out.push({ where: `boss reveal ${boss}`, speaker: reveal.speaker, text: reveal.line });
  return out;
}

/** §4.2: the texts that break the house rule — a contraction from anyone but Iris. */
function contractionProblems(texts: readonly HouseText[]): string[] {
  return texts.filter((entry) => entry.speaker !== 'home' && CONTRACTION_PATTERN.test(entry.text)).map((entry) => `${entry.where}: ${entry.text}`);
}

const said = (id: string): string[] => (DIALOGUE_LINES[id]?.lines ?? []).map((line) => `${line.speaker}: ${line.text}`);

describe('the house rule (SPEC-049 §4.2)', () => {
  it('no dialogue line, caption, variant, chapter card or boss reveal uses a contraction unless Iris speaks it', () => {
    const texts = houseTexts();
    expect(texts.length).toBeGreaterThan(150);
    expect(contractionProblems(texts)).toEqual([]);
  });

  it('the pattern catches contractions over either apostrophe, in any case, and lets possessives through', () => {
    expect(CONTRACTION_PATTERN.flags).not.toContain('g');
    for (const text of ['Don’t argue.', "don't", 'They’re saying', "we've", 'I’ll go', "you'd know", 'I’m here', "It's late", 'LET’S GO', 'that’s all', 'Who’s there', 'can’t sleep', "won't", 'He’s gone', 'there’s one']) {
      expect(CONTRACTION_PATTERN.test(text), text).toBe(true);
    }
    // A noun's `’s` is a possessive to the pattern, whatever it stands for.
    for (const text of ['Earth’s location', 'Iris’s compass', 'your mother’s', 'the towers’ settings', "the reactor's heat", 'Do not run.', 'I am ARIA.', 'o’clock']) {
      expect(CONTRACTION_PATTERN.test(text), text).toBe(false);
    }
  });

  it('fails a contraction wherever it reads and names the line; Iris keeps hers', () => {
    expect(contractionProblems([{ where: 'x line 0', speaker: 'aria', text: 'It’s fine.' }])).toEqual(['x line 0: It’s fine.']);
    expect(contractionProblems([{ where: 'chapter card x', speaker: 'card', text: "Don't land." }])).toHaveLength(1);
    expect(contractionProblems([{ where: 'letter', speaker: 'home', text: 'Don’t argue with it.' }])).toEqual([]);
    // …and she is the one voice that does use them.
    expect(houseTexts().filter((entry) => entry.speaker === 'home' && CONTRACTION_PATTERN.test(entry.text)).length).toBeGreaterThan(0);
  });
});

describe('Iris and her letters (SPEC-049 §4.1, §4.3)', () => {
  it('the cast gains home, and the personnel file names her', () => {
    expect(SPEAKERS).toEqual(['aria', 'command', 'scav', 'log', 'player', 'warden', 'home']);
    expect(KIN_ROW).toBe('Next of kin — Iris (sister) · Shelter Nine, Block C');
  });

  it('the five letters are modal, carry no once, and read as §4.3 gives them', () => {
    const letter1 = [
      'home: The lamp over the map table stopped flickering today. Everybody clapped like idiots. They’re saying it was your oil.',
      'home: You took my compass. Good. I fixed it so it points home, not north. Don’t argue with it.',
      'home: Come back in one piece.',
    ];
    expect(said('letter_1')).toEqual(letter1);
    expect(said('letter_2')).toEqual([
      'home: They put me on the tap. Forty cups a turn, Block C. I pour every one like it’s for you.',
      'home: Do you remember the roof? The night the grid died you counted satellites until you fell asleep on my shoulder.',
      'home: I still can’t sleep without the hum.',
    ]);
    expect(said('letter_3')).toEqual([
      'home: Grain! Actual grain. The grow room smells like summer and nobody knows what to do with their hands.',
      'home: Everyone in Block D asks about you. I tell them you’re the one who never writes back.',
      'home: Write back.',
    ]);
    expect(said('letter_4')).toEqual([
      'home: The grid’s holding across three cities. They say you can see us from space now. I waved. Stupid.',
      'home: The lamp over the map table stopped flickering today.',
      'home: Come back in one piece.',
    ]);
    expect(said('letter_5')).toEqual([
      ...letter1,
      'aria: That is her first letter. Word for word. I checked it twice.',
      'player: Read me the date.',
      'aria: There is no date. There never was, on any of them.',
      'aria: Command rates every run, by the way. It takes three points off every time you look at something it did not send you to.',
    ]);
    expect(DIALOGUE_LINES['letter_5']?.lines.map((line) => line.when ?? null)).toEqual([null, null, null, null, null, null, { offTask: { min: 1 } }]);
    for (const letter of LETTERS) {
      expect(DIALOGUE_LINES[letter.dialogue]?.modal, letter.dialogue).toBe(true);
      expect(DIALOGUE_LINES[letter.dialogue]?.once, letter.dialogue).toBeUndefined();
    }
  });

  it('letter 4 repeats letter 1’s first sentence, and letter 5 opens with letter 1 word for word (§6.1)', () => {
    const first = DIALOGUE_LINES['letter_1']?.lines ?? [];
    const firstSentence = /^[^.!?]*[.!?]/.exec(first[0]?.text ?? '')?.[0];
    expect(firstSentence).toBe('The lamp over the map table stopped flickering today.');
    expect(DIALOGUE_LINES['letter_4']?.lines[1]?.text).toBe(firstSentence);
    expect(DIALOGUE_LINES['letter_5']?.lines.slice(0, 3)).toEqual(first);
  });

  it('every home line belongs to a letter: letters 1–4 are all Iris, and letter 5 hands over after three', () => {
    const letterIds = new Set<string>(LETTERS.map((letter) => letter.dialogue));
    for (const dialogue of Object.values(DIALOGUE_LINES)) {
      for (const [index, line] of dialogue.lines.entries()) {
        if (line.speaker === 'home') expect(letterIds.has(dialogue.id), `${dialogue.id} line ${index}`).toBe(true);
      }
    }
    for (const id of ['letter_1', 'letter_2', 'letter_3', 'letter_4']) {
      expect(DIALOGUE_LINES[id]?.lines.every((line) => line.speaker === 'home'), id).toBe(true);
    }
    expect(DIALOGUE_LINES['letter_5']?.lines.map((line) => line.speaker)).toEqual(['home', 'home', 'home', 'aria', 'player', 'aria', 'aria']);
  });

  it('LETTERS maps chapter N to letter_N and letterN_read, in order', () => {
    expect(LETTERS.map((letter) => [letter.chapter, letter.dialogue, letter.flag])).toEqual([
      [1, 'letter_1', 'letter1_read'],
      [2, 'letter_2', 'letter2_read'],
      [3, 'letter_3', 'letter3_read'],
      [4, 'letter_4', 'letter4_read'],
      [5, 'letter_5', 'letter5_read'],
    ]);
    for (const letter of LETTERS) expect(flagSet.has(letter.flag), letter.flag).toBe(true);
  });
});

describe('the keepsake and the body (SPEC-049 §4.4, §4.5)', () => {
  it('the keepsake’s five texts', () => {
    expect(KEEPSAKE).toEqual({
      t1: 'A tin compass from Iris, pressed into your hand at the shelter stair. It points home, she says. Not north.',
      t2: 'A brass compass from Iris. She gave it to you on the roof. It points home.',
      t3: 'A tin compass. Your mother’s, you think. It points home.',
      t4: 'A compass. It points at your next objective. It has never once pointed home.',
      t5: 'A compass. Standard kit. Every salvager was issued one, and a letter.',
    });
    expect(said('keepsake_drift')).toEqual(['aria: You called it tin last time. And last time it was hers, not your mother’s.']);
    expect(DIALOGUE_LINES['keepsake_drift']?.modal).toBeUndefined();
  });

  it('the restart lines are ARIA’s, one each, non-modal, by band', () => {
    expect(['restart_1', 'restart_2', 'restart_3'].map(said)).toEqual([
      ['aria: Medical frame restarted your heart. Eleven seconds of nothing. Walk it off.'],
      ['aria: Restart complete. I used to say that about your heart.'],
      ['aria: Restarted. You know what that means now. So do I.'],
    ]);
    for (const id of ['restart_1', 'restart_2', 'restart_3']) {
      expect(DIALOGUE_LINES[id]?.modal, id).toBeUndefined();
      expect(DIALOGUE_LINES[id]?.once, id).toBeUndefined();
    }
  });

  it('the asides are modal: the mission clock, and the question with its three answers', () => {
    expect(said('station_awake')).toEqual([
      'aria: Mission clock: {hours} hours since launch. You have not slept. You have not asked to.',
      'player: Stims.',
      'aria: Command issue. Yes. That must be it.',
    ]);
    expect(said('station_memory')).toEqual(['aria: Can I ask you something, for the file?']);
    expect(said('station_memory_reply')).toEqual(['aria: Thank you. It is on file now.']);
    for (const id of ['station_awake', 'station_memory', 'station_memory_reply']) {
      expect(DIALOGUE_LINES[id]?.modal, id).toBe(true);
      expect(DIALOGUE_LINES[id]?.once, id).toBeUndefined();
    }
    expect(MEMORY_PROMPT).toBe('What is the first thing you remember from before the Selection?');
    expect(MEMORY_ANSWERS).toEqual([
      { label: 'The roof. Counting satellites.', flag: 'memory_roof' },
      { label: 'The tap in Block C.', flag: 'memory_tap' },
      { label: 'The stair, the day the door shut.', flag: 'memory_stair' },
    ]);
  });

  it('the memory clue is memory_roof, found by any answer, and its trigger is the choice', () => {
    const memory = CLUES.find((def) => def.id === 'memory_roof');
    expect(memory?.also).toEqual(['memory_tap', 'memory_stair']);
    expect(memory?.trigger).toEqual({ kind: 'choice' });
    expect(memory?.lines).toEqual([]);
    expect([memory?.id, ...(memory?.also ?? [])]).toEqual(MEMORY_ANSWERS.map((answer) => answer.flag));
    // Only the keepsake is off-task among the five.
    const added = ['clue_restart', 'clue_awake', 'memory_roof', 'clue_keepsake', 'clue_letter_repeat'];
    expect(CLUES.filter((def) => added.includes(def.id) && def.offTask).map((def) => def.id)).toEqual(['clue_keepsake']);
  });
});

describe('ARIA remembers (SPEC-049 §4.7)', () => {
  it('c5_m3_aria gains four rows after “You never went looking” and before “I do not know what is outside”', () => {
    const lines = DIALOGUE_LINES['c5_m3_aria']?.lines ?? [];
    expect(lines).toHaveLength(12);
    expect(lines[5]?.text).toBe('You never went looking. I never had to lie to you. I am not sure that was better.');
    expect(lines.slice(6, 10).map((line) => [line.speaker, line.text, line.when])).toEqual([
      ['aria', 'Every time you died, I said the medical frame restarted your heart. There is no medical frame.', { flag: 'clue_restart' }],
      [
        'aria',
        'I asked what you remembered first. You said the roof. It was in her second letter. Forty of the sixty-one before you said the roof.',
        { flag: 'memory_roof' },
      ],
      ['aria', 'I asked what you remembered first. You said the tap. Fourteen of the sixty-one before you said the tap.', { flag: 'memory_tap' }],
      [
        'aria',
        'I asked what you remembered first. You said the stair. Seven of the sixty-one said the stair. It did not help them.',
        { flag: 'memory_stair' },
      ],
    ]);
    expect(lines[10]?.text).toBe('I do not know what is outside either. That part was never in my brief.');
    // The answers' counts are the sixty-one runs before this one: 40 + 14 + 7.
    expect(40 + 14 + 7).toBe(61);
  });
});

// ------------------------------------------------------------- SPEC-053 §6.1

describe('groves, orchards, clusters and the ground looks (SPEC-053 §6.1)', () => {
  it('every feature band is ordered and positive, and every count a positive integer', () => {
    const problems: string[] = [];
    const positiveInt = (value: number): boolean => Number.isInteger(value) && value > 0;
    for (const planet of planets) {
      const { groves, orchards, clusters } = planet.surface.features;
      if (groves !== undefined) {
        if (!positiveInt(groves.count)) problems.push(`${planet.id}: groves.count ${groves.count}`);
        if (!(groves.radius[0] > 0 && groves.radius[0] <= groves.radius[1])) problems.push(`${planet.id}: groves.radius ${groves.radius.join('–')}`);
        if (!(groves.treesPer1000m2 > 0)) problems.push(`${planet.id}: groves.treesPer1000m2 ${groves.treesPer1000m2}`);
      }
      if (orchards !== undefined) {
        for (const key of ['count', 'rows', 'cols'] as const) {
          if (!positiveInt(orchards[key])) problems.push(`${planet.id}: orchards.${key} ${orchards[key]}`);
        }
        if (!(orchards.spacing > 0)) problems.push(`${planet.id}: orchards.spacing ${orchards.spacing}`);
      }
      if (clusters !== undefined) {
        if (!positiveInt(clusters.count)) problems.push(`${planet.id}: clusters.count ${clusters.count}`);
        if (!(positiveInt(clusters.pieces[0]) && clusters.pieces[0] <= clusters.pieces[1])) {
          problems.push(`${planet.id}: clusters.pieces ${clusters.pieces.join('–')}`);
        }
        if (!(clusters.spread > 0)) problems.push(`${planet.id}: clusters.spread ${clusters.spread}`);
      }
    }
    expect(problems).toEqual([]);
    // §4.3's table: Thessaly's groves, Eden's orchards, clusters on the other four.
    expect(PLANETS.thessaly.surface.features.groves).toBeDefined();
    expect(PLANETS.eden.surface.features.orchards).toBeDefined();
    for (const id of ['cinder4', 'vetra', 'ferrum', 'hive'] as const) expect(PLANETS[id].surface.features.clusters, id).toBeDefined();
  });

  it('cover and undergrowth cells lie in 0–14, with positive weights, sizes and densities', () => {
    const problems: string[] = [];
    const cell = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 14;
    for (const planet of planets) {
      const { cover, undergrowth } = planet.surface.look;
      if (cover !== undefined) {
        if (cover.kinds.length === 0) problems.push(`${planet.id}: cover has no kinds`);
        for (const kind of cover.kinds) {
          if (!cell(kind.cell)) problems.push(`${planet.id}: cover cell ${kind.cell}`);
          if (!(kind.weight > 0)) problems.push(`${planet.id}: cover weight ${kind.weight}`);
          if (!(kind.size[0] > 0 && kind.size[0] <= kind.size[1])) problems.push(`${planet.id}: cover size ${kind.size.join('–')}`);
        }
        if (!(cover.per1000m2 >= 0)) problems.push(`${planet.id}: cover.per1000m2 ${cover.per1000m2}`);
        if (cover.underCanopy !== undefined && !(cover.underCanopy > 0)) problems.push(`${planet.id}: cover.underCanopy ${cover.underCanopy}`);
      }
      if (undergrowth !== undefined) {
        if (undergrowth.cells.length === 0) problems.push(`${planet.id}: undergrowth has no cells`);
        for (const value of undergrowth.cells) if (!cell(value)) problems.push(`${planet.id}: undergrowth cell ${value}`);
        if (!(undergrowth.underPer1000m2 >= 0 && undergrowth.openPer1000m2 >= 0)) problems.push(`${planet.id}: undergrowth density`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every seam.poi exists on its planet, and every foliage.wind lies in [0, 2]', () => {
    const problems: string[] = [];
    for (const planet of planets) {
      const seam = planet.surface.look.ground.seam;
      if (seam !== undefined) {
        if (!planet.surface.pois.some((poi) => poi.id === seam.poi)) problems.push(`${planet.id}: seam.poi ${seam.poi} is not a POI here`);
        if (!(seam.shift > 0)) problems.push(`${planet.id}: seam.shift ${seam.shift}`);
      }
      const foliage = planet.surface.look.foliage;
      if (foliage !== undefined && !(foliage.wind >= 0 && foliage.wind <= 2)) problems.push(`${planet.id}: foliage.wind ${foliage.wind}`);
    }
    expect(problems).toEqual([]);
    expect(PLANETS.eden.surface.look.ground.seam).toEqual({ poi: 'eden_ridge', axis: 'x', shift: 1.75 });
  });
});

// ------------------------------------------------------------- SPEC-054 §4.8

import { CACHES, UNDERGROUND } from '@/data/index';

/**
 * Every name a requirement or an objective carries — each string value, with a
 * choice's prose (`prompt`, `label`) left out — as `[where, value]`.
 */
function namesIn(value: unknown, where: string, out: Array<[string, string]>): Array<[string, string]> {
  if (typeof value === 'string') out.push([where, value]);
  else if (Array.isArray(value)) value.forEach((entry, i) => namesIn(entry, `${where}[${i}]`, out));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) if (key !== 'prompt' && key !== 'label') namesIn(entry, `${where}.${key}`, out);
  }
  return out;
}

/** §4.8: the names that point below — a cache id, or a word of the underground's. */
function undergroundNames(names: readonly [string, string][]): string[] {
  const caches = new Set<string>(CACHE_IDS);
  const below = /cache|cave|vault|relic|underground|descent/i;
  return names.filter(([, value]) => caches.has(value) || below.test(value)).map(([where, value]) => `${where}: ${value}`);
}

describe('the caves and their caches (SPEC-054 §4.8)', () => {
  it('UNDERGROUND covers the six planets — packs 3, 3, 4, 4, 5, and none in Eden’s machine room', () => {
    expect(Object.keys(UNDERGROUND)).toEqual([...PLANET_IDS]);
    expect(PLANET_IDS.map((planet) => UNDERGROUND[planet].packs)).toEqual([3, 3, 4, 4, 5, 0]);
    for (const planet of PLANET_IDS) {
      const def = UNDERGROUND[planet];
      expect(def.planet, planet).toBe(planet);
      expect(def.rooms, planet).toEqual([5, 7]);
      expect(def.roomRadius, planet).toEqual([6, 10]);
      expect(def.corridor, planet).toBe(4.5);
      expect(def.machineRoom === true, planet).toBe(planet === 'eden');
      // §4.3: `2 + ceil(chapter / 2)` pack anchors outside the entrance, none in the machine room.
      expect(def.packs, planet).toBe(def.machineRoom === true ? 0 : 2 + Math.ceil(planetsById[planet].chapter / 2));
    }
  });

  it('CACHES covers exactly the 23 ids of CACHE_IDS, each with the planet, slot and guard its id names', () => {
    expect(Object.keys(CACHES).sort()).toEqual([...CACHE_IDS].sort());
    const guards: Record<CacheSlot, string> = { loose_a: 'none', loose_b: 'world', vault: 'vault', relic: 'relic' };
    for (const id of CACHE_IDS) {
      const cache = CACHES[id];
      expect(cache.id, id).toBe(id);
      expect(PLANET_IDS as readonly string[], id).toContain(cache.planet);
      expect(`${cache.planet}_${cache.slot}`, id).toBe(id);
      expect(cache.guard, id).toBe(guards[cache.slot]);
    }
  });

  // SPEC-055 §4.8 filled the guarded caches, which paid nothing until then:
  // every cache now pays something, whatever guards it.
  it('every cache pays something, guarded or not (SPEC-055 §4.8)', () => {
    for (const cache of Object.values(CACHES)) {
      const resources = Object.values(cache.reward.resources ?? {}).some((amount) => (amount ?? 0) > 0);
      const items = (cache.reward.items ?? []).some((item) => item.qty > 0);
      expect(resources || items, cache.id).toBe(true);
    }
  });

  it('each <planet>_loose_a pays lithium 3 + 2 × chapter and exactly one medkit', () => {
    for (const planet of PLANET_IDS) {
      const cache = CACHES[`${planet}_loose_a`];
      expect(cache.reward, planet).toEqual({
        resources: { lithium: 3 + 2 * planetsById[planet].chapter },
        items: [{ itemId: 'medkit', qty: 1 }],
      });
    }
    // §4.8's table: 5, 7, 9, 11, 13, 15.
    expect(PLANET_IDS.map((planet) => CACHES[`${planet}_loose_a`].reward.resources?.lithium)).toEqual([5, 7, 9, 11, 13, 15]);
  });

  it('every item a cache pays is a consumable in whole units, never gear', () => {
    let paid = 0;
    for (const cache of Object.values(CACHES)) {
      // SPEC-055 §4.8: the flawless part is held to the same rule.
      for (const item of [...(cache.reward.items ?? []), ...(cache.flawless?.items ?? [])]) {
        paid++;
        expect(ITEM_TABLE[item.itemId]?.kind, `${cache.id}: ${item.itemId}`).toBe('consumable');
        expect(Number.isInteger(item.qty) && item.qty > 0, `${cache.id}: ${item.itemId} × ${item.qty}`).toBe(true);
      }
    }
    expect(paid).toBeGreaterThan(0);
  });

  it('no requirement, planet unlock or mission objective names a cache or the underground', () => {
    const names: Array<[string, string]> = [];
    for (const mission of missions) {
      namesIn(mission.requires, `${mission.id}.requires`, names);
      for (const { objective, where } of objectivesOf(mission)) namesIn(objective, where, names);
    }
    for (const planet of planets) namesIn(planet.unlock, `${planet.id}.unlock`, names);
    // The walk read the tables, and the rule would catch a planted reference.
    expect(names.length).toBeGreaterThan(100);
    expect(
      undergroundNames([
        ['planted.requires[0].flag', 'cinder4_vault'],
        ['planted stage 0 objective 0 (reach).poi', 'cave_mouth'],
        ['planted.unlock[0].kind', 'underground'],
      ]),
    ).toHaveLength(3);
    expect(undergroundNames(names)).toEqual([]);
  });
});

// ------------------------------------------------------------- SPEC-055 §4.1, §4.3, §4.8

import { HUMAN_LOCK, PUZZLE_DIFFICULTY, PUZZLE_SITES, PUZZLE_SITE_IDS, SEQUENCE_PHRASES, type CacheId } from '@/data/index';

/** §4.3: a line's words, lower-cased, with punctuation dropped — how a phrase is looked for. */
function wordsOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** §4.3: the phrase (three words, then `next`) occurs in a line of `from`. */
function phraseIn(from: DialogueId, shown: readonly string[], next: string): boolean {
  const wanted = ` ${wordsOf([...shown, next].join(' '))} `;
  return (DIALOGUE[from].lines as readonly { text: string }[]).some((line) => ` ${wordsOf(line.text)} `.includes(wanted));
}

describe('puzzles: the sites, the rows and the caches they open (SPEC-055 §4.1, §4.3, §4.8)', () => {
  const kinds: Record<string, string> = {
    cinder4_vault: 'conduit',
    cinder4_world: 'plates',
    cinder4_relic: 'sequence',
    vetra_vault: 'calibration',
    vetra_world: 'beam',
    vetra_relic: 'sequence',
    thessaly_vault: 'conduit',
    thessaly_world: 'plates',
    thessaly_relic: 'sequence',
    ferrum_vault: 'calibration',
    ferrum_world: 'beam',
    ferrum_relic: 'sequence',
    hive_vault: 'conduit',
    hive_world: 'plates',
    eden_vault: 'sequence',
    eden_world: 'beam',
    eden_relic: 'sequence',
  };

  it('defines 17 sites — a vault and a world puzzle on each planet, a relic on all but the Hive', () => {
    expect(PUZZLE_SITE_IDS).toHaveLength(17);
    expect(Object.keys(PUZZLE_SITES).sort()).toEqual([...PUZZLE_SITE_IDS].sort());
    for (const planet of PLANET_IDS) {
      for (const where of ['vault', 'world', 'relic'] as const) {
        const id = `${planet}_${where}`;
        expect((PUZZLE_SITE_IDS as readonly string[]).includes(id), id).toBe(!(planet === 'hive' && where === 'relic'));
      }
    }
  });

  it('each site names its planet, its kind of §4.1 and a cache on its planet that its guard matches', () => {
    const slots: Record<'vault' | 'world' | 'relic', string> = { vault: 'vault', world: 'loose_b', relic: 'relic' };
    for (const id of PUZZLE_SITE_IDS) {
      const site = PUZZLE_SITES[id];
      expect(site.id, id).toBe(id);
      expect(`${site.planet}_${site.where}`, id).toBe(id);
      expect(site.kind, id).toBe(kinds[id]);
      expect(site.cache, id).toBe(`${site.planet}_${slots[site.where]}`);
      expect(CACHES[site.cache].planet, id).toBe(site.planet);
      expect(CACHES[site.cache].guard, id).toBe(site.where);
    }
    // Every guarded cache has exactly one site, and no loose_a has any.
    const guarded = Object.values(CACHES).filter((cache) => cache.guard !== 'none').map((cache) => cache.id).sort();
    expect(PUZZLE_SITE_IDS.map((id) => PUZZLE_SITES[id].cache).sort()).toEqual(guarded);
  });

  it('the relics ask the families of §4.3 in chapter order, and Eden’s vault is the human lock', () => {
    const relics = PUZZLE_SITE_IDS.filter((id) => PUZZLE_SITES[id].where === 'relic');
    expect(relics.map((id) => [id, PUZZLE_SITES[id].family])).toEqual([
      ['cinder4_relic', 'arithmetic'],
      ['vetra_relic', 'alternating'],
      ['thessaly_relic', 'fibonacci'],
      ['ferrum_relic', 'interleaved'],
      ['eden_relic', 'words'],
    ]);
    for (const id of relics) {
      expect(PUZZLE_DIFFICULTY.sequence[planetsById[PUZZLE_SITES[id].planet].chapter]?.family, id).toBe(PUZZLE_SITES[id].family);
    }
    expect(PUZZLE_SITES.eden_vault.family).toBe('human');
    for (const id of PUZZLE_SITE_IDS) {
      if (PUZZLE_SITES[id].kind !== 'sequence') expect(PUZZLE_SITES[id].family, id).toBeUndefined();
    }
  });

  it('PUZZLE_DIFFICULTY holds the rows of §4.3, each at its planet’s chapter', () => {
    expect(PUZZLE_DIFFICULTY.conduit).toEqual({
      1: { n: 4, sinks: 1, path: [5, 8] },
      3: { n: 5, sinks: 1, path: [7, 11] },
      5: { n: 5, sinks: 2, path: [9, 13] },
    });
    expect(PUZZLE_DIFFICULTY.calibration).toEqual({ 2: { n: 3, presses: 4 }, 4: { n: 4, presses: 6 } });
    expect(PUZZLE_DIFFICULTY.plates).toEqual({ 1: { plates: 3 }, 3: { plates: 4 }, 5: { plates: 5 } });
    expect(PUZZLE_DIFFICULTY.beam).toEqual({ 2: { mirrors: 2 }, 4: { mirrors: 3 }, 6: { mirrors: 3 } });
    expect(PUZZLE_DIFFICULTY.sequence).toEqual({
      1: { family: 'arithmetic' },
      2: { family: 'alternating' },
      3: { family: 'fibonacci' },
      4: { family: 'interleaved' },
      6: { family: 'words' },
    });
    // Every site's kind has a row at its planet's chapter (the human lock is fixed).
    for (const id of PUZZLE_SITE_IDS) {
      const site = PUZZLE_SITES[id];
      const chapter = planetsById[site.planet].chapter;
      if (site.kind === 'sequence') continue;
      expect(PUZZLE_DIFFICULTY[site.kind][chapter], id).toBeDefined();
    }
    // §4.2: a lights-out row's presses stay under the board's lightest quiet pattern (none on 3 × 3, 8 on 4 × 4).
    expect(PUZZLE_DIFFICULTY.calibration[2]?.presses).toBeLessThan(9);
    expect(PUZZLE_DIFFICULTY.calibration[4]?.presses).toBeLessThan(8);
  });

  it('the guarded caches pay §4.8’s table — loose_b oil and explosives, vault lithium and kit with a flawless medkit, relic lithium and a cell', () => {
    const explosive = (chapter: number): string => (chapter <= 2 ? 'frag_grenade' : chapter <= 4 ? 'landmine' : 'demo_charge');
    for (const planet of PLANET_IDS) {
      const c = planetsById[planet].chapter;
      expect(CACHES[`${planet}_loose_b`].reward, planet).toEqual({ resources: { oil: 10 + 5 * c }, items: [{ itemId: explosive(c), qty: 2 }] });
      expect(CACHES[`${planet}_loose_b`].flawless, planet).toBeUndefined();
      expect(CACHES[`${planet}_vault`].reward, planet).toEqual({
        resources: { lithium: 5 + 3 * c },
        items: [
          { itemId: 'plasma_cell', qty: 1 },
          { itemId: 'coolant_pack', qty: 1 },
        ],
      });
      expect(CACHES[`${planet}_vault`].flawless, planet).toEqual({ items: [{ itemId: 'medkit', qty: 1 }] });
      if (planet === 'hive') continue;
      const relic = `${planet}_relic` as CacheId;
      expect(CACHES[relic].reward, planet).toEqual({ resources: { lithium: 5 }, items: [{ itemId: 'plasma_cell', qty: 1 }] });
      expect(CACHES[relic].flawless, planet).toBeUndefined();
    }
  });

  it('the campaign’s caches total 178 lithium, 165 oil, 12 medkits (6 flawless), 12 explosives, 11 cells, 6 coolant packs — and no tokens, XP or flags', () => {
    const totals: Record<string, number> = {};
    let flawlessMedkits = 0;
    for (const cache of Object.values(CACHES)) {
      for (const part of [cache.reward, cache.flawless ?? {}]) {
        // A reward is resources and items only: nothing here can be a token, XP or a flag.
        for (const key of Object.keys(part)) expect(['resources', 'items'], `${cache.id}.${key}`).toContain(key);
        for (const [resource, amount] of Object.entries(part.resources ?? {})) totals[resource] = (totals[resource] ?? 0) + (amount ?? 0);
        for (const item of part.items ?? []) totals[item.itemId] = (totals[item.itemId] ?? 0) + item.qty;
      }
      for (const item of cache.flawless?.items ?? []) if (item.itemId === 'medkit') flawlessMedkits += item.qty;
    }
    expect(totals['lithium']).toBe(178);
    expect(totals['oil']).toBe(165);
    expect(totals['medkit']).toBe(12);
    expect(flawlessMedkits).toBe(6);
    expect((totals['frag_grenade'] ?? 0) + (totals['landmine'] ?? 0) + (totals['demo_charge'] ?? 0)).toBe(12);
    expect(totals['plasma_cell']).toBe(11);
    expect(totals['coolant_pack']).toBe(6);
  });

  it('no requirement, planet unlock or objective reads a puzzle site, a cache or the word puzzle', () => {
    const names: Array<[string, string]> = [];
    for (const mission of missions) {
      namesIn(mission.requires, `${mission.id}.requires`, names);
      for (const { objective, where } of objectivesOf(mission)) namesIn(objective, where, names);
    }
    for (const planet of planets) namesIn(planet.unlock, `${planet.id}.unlock`, names);
    const sites = new Set<string>(PUZZLE_SITE_IDS);
    const puzzled = (list: readonly [string, string][]): string[] =>
      list.filter(([, value]) => sites.has(value) || /puzzle/i.test(value)).map(([where, value]) => `${where}: ${value}`);
    expect(names.length).toBeGreaterThan(100);
    // The rule would catch a planted reference.
    expect(puzzled([['planted.requires[0].flag', 'cinder4_relic'], ['planted.unlock[0].kind', 'puzzle_solved']])).toHaveLength(2);
    expect(puzzled(names)).toEqual([]);
    expect(undergroundNames(names)).toEqual([]);
  });
});

describe('puzzles: the phrases and the human lock (SPEC-055 §4.3, §4.7)', () => {
  it('names four phrases, one per main-path line SPEC-048, SPEC-049 and SPEC-058 leave alone', () => {
    expect(SEQUENCE_PHRASES.map((phrase) => phrase.from)).toEqual(['c1_m3_done', 'c3_m2_accept', 'c3_m3_done', 'c4_m2_accept']);
    for (const phrase of SEQUENCE_PHRASES) {
      expect(phrase.shown).toHaveLength(3);
      expect(phrase.others).toHaveLength(3);
      expect(new Set([phrase.answer, ...phrase.others]).size, phrase.answer).toBe(4);
    }
  });

  it('every phrase, with its answer, occurs in its from dialogue — and no other word completes it there', () => {
    for (const phrase of SEQUENCE_PHRASES) {
      const at = `${phrase.from}: ${phrase.shown.join(' ')} ?`;
      expect(phraseIn(phrase.from, phrase.shown, phrase.answer), at).toBe(true);
      for (const other of phrase.others) expect(phraseIn(phrase.from, phrase.shown, other), `${at} ${other}`).toBe(false);
    }
    // The check is a real one: a phrase from the wrong dialogue fails it.
    expect(phraseIn('c1_m3_done', ['that', 'gets', 'us'], 'home')).toBe(false);
  });

  it('the human lock shows four tokens and four choices in order, and both lines carry {instance}', () => {
    expect(HUMAN_LOCK.title).toBe('HUMAN VERIFICATION — complete the sentence');
    expect(HUMAN_LOCK.shown).toEqual(['walk', 'do', 'not', '?']);
    expect(HUMAN_LOCK.choices).toEqual(['stop', 'run', 'look', 'wake']);
    expect(HUMAN_LOCK.choices).toContain(HUMAN_LOCK.predicted);
    expect(HUMAN_LOCK.linePredicted).toContain('{instance}');
    expect(HUMAN_LOCK.lineSampled).toContain('{instance}');
    expect(HUMAN_LOCK.linePredicted).toContain('predicted');
    expect(HUMAN_LOCK.lineSampled).toContain('sampled');
  });

  it('SPEC-048’s limits hold for the verdicts at the longest fill: 220 characters, and no unknown token', () => {
    for (const line of [HUMAN_LOCK.linePredicted, HUMAN_LOCK.lineSampled]) {
      expect(atLongest(line).length, line).toBeLessThanOrEqual(220);
      expect(unknownTokens(line), line).toEqual([]);
    }
  });

  it('the puzzle tip reads §4.4’s two wordings', () => {
    expect(TIP_IDS).toContain('puzzle');
    expect(TIPS.puzzle).toEqual({
      keyboard: 'Arrows move, Enter turns a tile. H asks ARIA for a hint — hints are free.',
      touch: 'Tap a tile to turn it. HINT asks ARIA — hints are free.',
    });
  });
});
