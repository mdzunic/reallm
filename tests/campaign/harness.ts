// The campaign harness (SPEC-010 §7, SPEC-016 §4). A scripted player who does
// the *worst case* the balance model of SPEC-010 §5 is written against: main
// missions only, in order, no side missions, no kill XP, no salvaging beyond
// what an objective asks for. If that player finishes the campaign without ever
// needing the station subsidy, every real player can.
//
// The script drives the real `Economy` and `Progression` against the real
// content tables. What it stands in for is `systems/Missions.ts` (SPEC-012),
// which does not exist yet: accepting a mission, counting its objectives and
// calling `applyRewards` are that module's job, so this file does the smallest
// honest version of each —
//   - an objective with an economy effect is played out through `Economy`
//     (`collect` is a pickup, `deliver` is an atomic spend);
//   - an objective without one (kill, boss, scan, reach, survive, escort,
//     defend) is simply satisfied, which is what "no kill XP" means;
//   - a `choice` sets the flags of the option the run picked, the way SPEC-012
//     will when the player answers the prompt.
// When `Missions` lands it replaces the middle of `playMission` and the
// assertions in `campaignSim.test.ts` stay as they are.
import type { GameEvents } from '@/core/Events';
import { newSave, type CharacterCreation, type Save } from '@/core/Save';
import {
  MISSIONS,
  PLANETS,
  type MissionDef,
  type MissionId,
  type Objective,
  type PlanetId,
  type ResourceId,
} from '@/data/index';
import { LOADOUT_CHAPTERS, RECOMMENDED_LOADOUT, type LoadoutChapter, type LoadoutEntry } from '@/systems/Balance';
import { Economy } from '@/systems/Economy';
import { Progression, type EventSink } from '@/systems/Progression';

const CHAPTERS = [1, 2, 3, 4, 5, 6] as const;
type Chapter = (typeof CHAPTERS)[number];

/**
 * The least-discounted character the game can create: a marine (no ship
 * discount) with the single point of tech its class base carries. Every other
 * build pays less for the same loadout.
 */
const WORST_CASE_CREATION: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#c8c8c8', secondary: '#c8c8c8' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
};

export interface RunOptions {
  /** Which side of the Eden verdict this run files (PLAN §5). */
  ending: 'ending_stay' | 'ending_escape';
}

export interface Jump {
  planet: PlanetId;
  cost: number;
  oilAfter: number;
}

export interface RunReport {
  save: Save;
  /** Everything that refused, in the order it refused. Empty is the pass. */
  problems: string[];
  /** Oil the E1 subsidy handed out across the run, and how often it was asked. */
  subsidyOil: number;
  subsidyCalls: number;
  jumps: Jump[];
  missionsDone: MissionId[];
  purchases: string[];
  /** The least oil the hold held, sampled after every jump and every mission. */
  lowestOil: number;
  events: Array<{ name: keyof GameEvents; payload: unknown }>;
}

const missions: readonly MissionDef<MissionId>[] = Object.values(MISSIONS);

function planetOfChapter(chapter: Chapter): PlanetId {
  const planet = Object.values(PLANETS).find((candidate) => candidate.chapter === chapter);
  if (planet === undefined) throw new Error(`no planet for chapter ${chapter}`);
  return planet.id;
}

/** The chapter's main missions, in table order — which is dependency order. */
function mainMissionsOf(chapter: Chapter): readonly MissionDef<MissionId>[] {
  return missions.filter((mission) => mission.type === 'main' && mission.chapter === chapter);
}

export function runCampaign(options: RunOptions): RunReport {
  const save = newSave(0, WORST_CASE_CREATION, 1234, 1_700_000_000_000);
  const events: RunReport['events'] = [];
  const sink: EventSink = {
    emit(name, ...args) {
      events.push({ name, payload: (args as unknown[])[0] });
    },
  };
  const progression = new Progression(save, sink);
  const economy = new Economy(save, sink, progression);

  const report: RunReport = {
    save,
    problems: [],
    subsidyOil: 0,
    subsidyCalls: 0,
    jumps: [],
    missionsDone: [],
    purchases: [],
    lowestOil: save.resources.oil,
    events,
  };

  for (const chapter of CHAPTERS) {
    const planet = planetOfChapter(chapter);

    // ---- at the station: the fuel floor, then the shop, then the jump.
    report.subsidyCalls += 1;
    report.subsidyOil += economy.applyStationSubsidy();
    buyLoadout(economy, chapter, report);

    const depart = economy.canDepart(planet);
    if (!depart.ok) {
      report.problems.push(
        depart.reason === 'locked'
          ? `chapter ${chapter}: ${planet} is locked on ${(depart.missing ?? []).map(describe).join(', ')}`
          : `chapter ${chapter}: ${depart.needOil ?? 0} oil short of ${planet}`,
      );
      break;
    }
    const cost = economy.fuelCost(planet);
    if (!economy.payFuel(planet)) {
      report.problems.push(`chapter ${chapter}: payFuel(${planet}) refused`);
      break;
    }
    save.progress.currentPlanet = planet;
    save.progress.location = 'surface';
    report.jumps.push({ planet, cost, oilAfter: save.resources.oil });
    report.lowestOil = Math.min(report.lowestOil, save.resources.oil);

    // ---- on the planet: this chapter's main missions, in order.
    for (const mission of mainMissionsOf(chapter)) {
      playMission(economy, save, mission, options, report);
      report.lowestOil = Math.min(report.lowestOil, save.resources.oil);
    }

    // The return trip is free (PLAN §4).
    save.progress.location = 'station';
  }

  return report;
}

function describe(requirement: { kind: string }): string {
  return JSON.stringify(requirement);
}

/** Buys everything §5 recommends before this chapter, in table order. */
function buyLoadout(economy: Economy, chapter: number, report: RunReport): void {
  if (!(LOADOUT_CHAPTERS as readonly number[]).includes(chapter)) return;
  for (const entry of RECOMMENDED_LOADOUT[chapter as LoadoutChapter]) {
    const price = economy.price(entry.kind, entry.id, entry.kind === 'ship' ? entry.tier : undefined);
    const result = buy(economy, entry);
    if (!result.ok) {
      report.problems.push(`chapter ${chapter}: ${entry.kind} ${entry.id} refused with ${result.reason}`);
      continue;
    }
    report.purchases.push(`${entry.kind}:${entry.id}${entry.kind === 'ship' ? `:${entry.tier}` : ''}@${price?.tokens ?? 0}`);
  }
}

function buy(economy: Economy, entry: LoadoutEntry): { ok: true } | { ok: false; reason: string } {
  if (entry.kind === 'companion') return economy.buyCompanion(entry.id);
  if (entry.kind === 'ship') {
    const bought = economy.buyShipTier(entry.id);
    if (!bought.ok) return bought;
    return bought.tier === entry.tier ? { ok: true } : { ok: false, reason: `bought tier ${bought.tier}, wanted ${entry.tier}` };
  }
  const bought = economy.buyGear(entry.id);
  if (!bought.ok) return bought;
  // A bought piece is worn, not carried: the one it replaces goes to the hold.
  return economy.equip(entry.id);
}

function playMission(
  economy: Economy,
  save: Save,
  mission: MissionDef<MissionId>,
  options: RunOptions,
  report: RunReport,
): void {
  const missing = economy.missingRequirements(mission.requires);
  if (missing.length > 0) {
    report.problems.push(`${mission.id}: accepted with ${missing.map(describe).join(', ')} unmet`);
    return;
  }
  const replay = report.missionsDone.includes(mission.id);
  for (const stage of mission.stages) {
    for (const objective of stage) satisfy(economy, save, mission, objective, options, report);
  }
  economy.applyRewards(mission, replay);
  save.progress.missionsDone.push(mission.id);
  report.missionsDone.push(mission.id);
}

function satisfy(
  economy: Economy,
  save: Save,
  mission: MissionDef<MissionId>,
  objective: Objective,
  options: RunOptions,
  report: RunReport,
): void {
  switch (objective.kind) {
    case 'collect': {
      // Harvested from the planet's nodes, which invariant §7.7 keeps stocked.
      const { blocked } = economy.addResource(objective.resource, objective.amount, 'pickup');
      if (blocked > 0) {
        report.problems.push(`${mission.id}: the hold filled with ${blocked} ${objective.resource} still to collect`);
      }
      break;
    }
    case 'deliver': {
      // E16: the player tops up at a node and hands over the whole amount.
      const short = objective.amount - save.resources[objective.resource];
      if (short > 0) topUp(economy, mission, objective.resource, short, report);
      if (!economy.spendResources(costOf(objective.resource, objective.amount), `deliver:${objective.poi}`)) {
        report.problems.push(`${mission.id}: could not deliver ${objective.amount} ${objective.resource}`);
      }
      break;
    }
    case 'choice': {
      // SPEC-012 sets these when the player answers; the run picks its side.
      const option = objective.options.find((candidate) => candidate.flags.includes(options.ending));
      if (option === undefined) {
        report.problems.push(`${mission.id}: no option files ${options.ending}`);
        break;
      }
      for (const flag of option.flags) {
        if (!save.progress.flags.includes(flag)) save.progress.flags.push(flag);
      }
      break;
    }
    default:
      // reach, scan, kill, boss, survive, defend, escort: no economy effect,
      // and the worst case takes no XP from the kills along the way.
      break;
  }
}

function costOf(resource: ResourceId, amount: number): Partial<Record<ResourceId, number>> {
  const cost: Partial<Record<ResourceId, number>> = {};
  cost[resource] = amount;
  return cost;
}

function topUp(economy: Economy, mission: MissionDef<MissionId>, resource: ResourceId, amount: number, report: RunReport): void {
  const { blocked } = economy.addResource(resource, amount, 'pickup');
  if (blocked > 0) report.problems.push(`${mission.id}: the hold filled ${blocked} short of a delivery`);
}
