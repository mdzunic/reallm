// The content-invariant suite (SPEC-009 §7). Seventeen invariants, one `it`
// each, numbered as the spec numbers them. Between them they cover everything
// the compiler cannot: counts, reachability, requirement cycles, POI/objective
// compatibility, balance pins and text limits (PLAN §11, E26).
//
// The compiler covers the rest — a mission naming an enemy that does not exist
// or a planet gating on a flag that does not exist is a `tsc` failure, which the
// second describe block below demonstrates with `@ts-expect-error`.
import { describe, expect, it, vi } from 'vitest';
import {
  ATTRIBUTE_MAX,
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
  RESOURCE_IDS,
  SHIP_SYSTEMS,
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

type Mission = MissionDef<MissionId>;

// Read through the schema types rather than the `as const` literal types: an
// invariant asks whether an optional field is set, and on a literal type an
// absent optional is not a property at all.
const missions: readonly Mission[] = Object.values(MISSIONS);
const enemies: readonly Enemy[] = Object.values(ENEMIES);
const items: readonly Item[] = Object.values(ITEMS);
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
        if (objective.kind === 'survive' && objective.seconds > planet.travelSeconds) {
          problems.push(`${where}: survives ${objective.seconds}s of a ${planet.travelSeconds}s trip`);
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

  it('9. enemy stats hold, static enemies stand still, and boss phases descend from full', () => {
    // §4.3 writes each enemy's numbers down rather than computing them at load
    // time, so nothing but this check says they were derived from the archetype
    // base and the chapter formula instead of typed in. Retuning means moving a
    // base or the formula here, which is the point: one stat block per
    // archetype, scaled (09-a).
    const archetypeBase: Record<string, { hp: number; damage: number }> = {
      swarm: { hp: 18, damage: 4 },
      rusher: { hp: 45, damage: 9 },
      ranged: { hp: 35, damage: 7 },
      static: { hp: 60, damage: 0 },
      boss: { hp: 900, damage: 18 },
      fighter: { hp: 40, damage: 8 },
      interceptor: { hp: 25, damage: 12 },
    };
    const problems: string[] = [];
    for (const enemy of enemies) {
      const base = archetypeBase[enemy.archetype];
      if (base === undefined) problems.push(`${enemy.id}: no base for archetype ${enemy.archetype}`);
      else {
        const hp = Math.round(base.hp * 1.35 ** (enemy.chapter - 1));
        const damage = Math.round(base.damage * 1.3 ** (enemy.chapter - 1));
        if (enemy.hp !== hp) problems.push(`${enemy.id}: hp ${enemy.hp}, but a chapter-${enemy.chapter} ${enemy.archetype} is ${hp}`);
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

  it('12. gear tiers are unique per slot, consumables stack, and tier-3 gear costs lithium', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (item.kind === 'weapon' || item.kind === 'armor') {
        const key = `${item.kind}:${item.tier}`;
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
    expect(seen).toEqual(new Set(['weapon:0', 'weapon:1', 'weapon:2', 'weapon:3', 'armor:0', 'armor:1', 'armor:2', 'armor:3']));
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
});

// `@ts-expect-error` on its own only claims that *some* error occurred on the
// line below it, so each case here pairs one with a positive assertion naming
// the union under test: the bad id sits outside it, the good id inside. Those
// two lines suppress nothing, so if an id union ever widened to `string` they
// would fail on their own rather than quietly keeping the suppression happy.
type IsAssignable<Candidate, Union> = Candidate extends Union ? true : false;

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
