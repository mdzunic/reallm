// The campaign harness (SPEC-010 §7, SPEC-016 §4). A scripted player who walks
// the whole campaign through the real runtime: `Missions` counts every
// objective and pays every reward, `Flight` flies every trip, and `Economy` and
// `Progression` keep the books. The harness stands in for the player and the
// planet only — it reports what a scene would report (a kill, a scan, a
// pickup), answers the verdict, and steps the timers — so what it proves is
// what a player meets. R16 was a runtime problem no table-level model could see.
//
// The players it plays are §4.1's: the worst case (main missions, mission XP
// only, the recommended loadout, the least-discounted character), the fastest
// ship, and the completionist with and without a bigger hold. Everything that
// refuses or stalls is one line in `problems` (§4.5); empty is the pass.
//
// Nothing here writes the save's progress itself. Completions, flags, vouchers
// and rewards all come from the systems it drives; the board's `acceptMission`
// and the landing's visit count are the only save writes, and both are what
// the station and the flight scene do.
import { EventBus, type GameEvents } from '@/core/Events';
import { QUALITY } from '@/core/Quality';
import { RngRoot } from '@/core/Rng';
import { newSave, nextCreation, nextInstance, type CharacterCreation, type Save } from '@/core/Save';
import {
  ENEMIES,
  MISSIONS,
  PLANETS,
  type EnemyId,
  type MissionDef,
  type MissionId,
  type Objective,
  type PlanetDef,
  type PlanetId,
  type PoiId,
  type ResourceId,
} from '@/data/index';
import { LOADOUT_CHAPTERS, RECOMMENDED_LOADOUT, type LoadoutChapter, type LoadoutEntry } from '@/systems/Balance';
import { computePlayerStats } from '@/systems/Combat';
import { Economy, refuelVoucherText } from '@/systems/Economy';
import { Flight, type FlightInput } from '@/systems/Flight';
import type { LayoutPoi } from '@/systems/Layout';
import { Missions, type MissionContext, type ObjectiveProgress } from '@/systems/Missions';
import { Progression } from '@/systems/Progression';
import { acceptMission, missionStatus } from '@/systems/UiHelpers';

export type Ending = 'ending_stay' | 'ending_escape';

export interface RunOptions {
  /** The verdict the run files (PLAN §5, E24). */
  ending: Ending;
  /** Side missions too, each on the first landing that offers it (default false). */
  sides?: boolean;
  /** Kill XP per §4.2 (default false: mission XP only — the worst case). */
  killXp?: boolean;
  /** The notch every trip is flown at (default 1). */
  throttle?: 0.8 | 1 | 1.2;
  /** Bought after RECOMMENDED_LOADOUT[chapter], before that chapter's first jump. */
  extraPurchases?: Partial<Record<1 | 2 | 3 | 4 | 5 | 6, readonly LoadoutEntry[]>>;
  /** The newSave seed, and so the flight streams (default 1234). */
  seed?: number;
  /**
   * SPEC-058 §4.9: the instance the run plays (default 1). Above 1 the
   * harness first plays the instance before it — these options at
   * `iteration − 1` — and begins this one from that finished save the way
   * `SaveStore.beginNextIteration` does (`nextInstance` on its
   * `nextCreation`): the old seed, the lineage, the containment of a real
   * next instance, and nothing economic carried.
   */
  iteration?: number;
}

export interface Jump {
  planet: PlanetId;
  cost: number;
  oilAfter: number;
  /** Flight.time and Flight.holdSeconds at arrival: simulated seconds from launch, and the part spent holding. */
  seconds: number;
  holdSeconds: number;
}

export interface CollectStart {
  mission: MissionId;
  resource: ResourceId;
  /** In the hold when the objective's first pickup was made. */
  held: number;
  amount: number;
  cap: number;
}

export interface RunReport {
  save: Save;
  /** Every refusal and stall, in order (§4.5, D-1). Empty is the pass. */
  problems: string[];
  subsidyOil: number;
  subsidyCalls: number;
  jumps: Jump[];
  /** From mission:completed, in order. */
  missionsDone: MissionId[];
  /** `${kind}:${id}[:tier]@${tokens}`, in purchase order. */
  purchases: string[];
  lowestOil: number;
  collects: CollectStart[];
  /** ui:toast events whose text is a refuelVoucherText (D-3). */
  vouchers: number;
  /** The sums of the positive and the negative tokens:changed deltas. */
  tokensEarned: number;
  tokensSpent: number;
  /** Every event on the run's bus, in order (recorded with onAny, D-5). */
  events: Array<{ name: keyof GameEvents; payload: unknown }>;
  /** SPEC-032: whether Economy.serviceMode was ever on. */
  serviceModeSeen: boolean;
}

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
const DEFAULT_SEED = 1234;
const CREATED_AT = 1_700_000_000_000;

/** One simulated step, the fixed update of SPEC-002. */
const STEP = 1 / 60;
/** §4.4 step 4: long enough for any trip plus the 90 s holding cap. */
const TRIP_LIMIT_SECONDS = 900;
/** §4.2: each required kill stands in for the fighting around it. */
const KILL_XP_MULT = 3;
/** The simulation's POIs are stubs at the origin (§2). */
const STUB_RADIUS = 5;

const IDLE_INPUT: FlightInput = Object.freeze({
  steerX: 0,
  steerY: 0,
  fire: false,
  aimX: 0,
  aimY: 0,
  throttleUp: false,
  throttleDown: false,
  autoFire: false,
  mouseSteer: false,
});

/**
 * D-3: a voucher toast is the text `refuelVoucherText` writes around a whole
 * number. The copy is read off the function, never restated here.
 */
const VOUCHER_SENTINEL = 918_273_645;
const VOUCHER_SAMPLE = refuelVoucherText(VOUCHER_SENTINEL);
const VOUCHER_AT = VOUCHER_SAMPLE.indexOf(String(VOUCHER_SENTINEL));
const VOUCHER_PREFIX = VOUCHER_SAMPLE.slice(0, VOUCHER_AT);
const VOUCHER_SUFFIX = VOUCHER_SAMPLE.slice(VOUCHER_AT + String(VOUCHER_SENTINEL).length);

function isVoucherText(text: string): boolean {
  if (VOUCHER_AT < 0) return false;
  if (!text.startsWith(VOUCHER_PREFIX) || !text.endsWith(VOUCHER_SUFFIX)) return false;
  const middle = text.slice(VOUCHER_PREFIX.length, text.length - VOUCHER_SUFFIX.length);
  return /^\d+$/.test(middle);
}

const MISSION_LIST: readonly MissionDef<MissionId>[] = Object.values(MISSIONS);
const PLANET_TABLE: Readonly<Record<PlanetId, PlanetDef>> = PLANETS;

/** The kind the planet's table gives a POI, for the stub the context hands back. */
function poiKind(planet: PlanetId | null, poi: PoiId): LayoutPoi['kind'] {
  if (planet === null) return 'landmark';
  return PLANET_TABLE[planet].surface.pois.find((def) => def.id === poi)?.kind ?? 'landmark';
}

function planetOfChapter(chapter: Chapter): PlanetId {
  const planet = Object.values(PLANETS).find((candidate) => candidate.chapter === chapter);
  if (planet === undefined) throw new Error(`no planet for chapter ${chapter}`);
  return planet.id;
}

/** Everything one run holds; built per call, so no run leaks into the next (16-e). */
interface Run {
  readonly options: RunOptions;
  readonly sides: boolean;
  readonly killXp: boolean;
  readonly save: Save;
  readonly bus: EventBus<GameEvents>;
  readonly progression: Progression;
  readonly economy: Economy;
  readonly report: RunReport;
  readonly ctx: MissionContext;
}

/** The save a run starts from: a fresh one, or the next instance of the run before it (SPEC-058 §4.9). */
function startingSave(options: RunOptions): Save {
  const iteration = options.iteration ?? 1;
  if (iteration <= 1) return newSave(0, WORST_CASE_CREATION, options.seed ?? DEFAULT_SEED, CREATED_AT);
  const predecessor = runCampaign({ ...options, iteration: iteration - 1 }).save;
  // The ending's overlay is the scene's; the harness has no screen to watch it on.
  predecessor.progress.endingSeen = true;
  return nextInstance(predecessor, nextCreation(predecessor), CREATED_AT);
}

export function runCampaign(options: RunOptions): RunReport {
  const save = startingSave(options);
  const bus = new EventBus<GameEvents>();
  const progression = new Progression(save, bus);
  const economy = new Economy(save, bus, progression);

  const report: RunReport = {
    save,
    problems: [],
    subsidyOil: 0,
    subsidyCalls: 0,
    jumps: [],
    missionsDone: [],
    purchases: [],
    lowestOil: save.resources.oil,
    collects: [],
    vouchers: 0,
    tokensEarned: 0,
    tokensSpent: 0,
    events: [],
    serviceModeSeen: economy.serviceMode,
  };

  const stopRecording = bus.onAny((name, payload) => {
    report.events.push({ name, payload });
    if (name === 'mission:completed') {
      report.missionsDone.push((payload as GameEvents['mission:completed']).id);
    } else if (name === 'tokens:changed') {
      const { delta } = payload as GameEvents['tokens:changed'];
      if (delta > 0) report.tokensEarned += delta;
      else report.tokensSpent -= delta;
    } else if (name === 'ui:toast') {
      if (isVoucherText((payload as GameEvents['ui:toast']).text)) report.vouchers += 1;
    }
  });

  const stub = (poi: PoiId): LayoutPoi => ({ poi, instance: 0, x: 0, z: 0, radius: STUB_RADIUS, kind: poiKind(save.progress.currentPlanet, poi) });
  const ctx: MissionContext = {
    player: { x: 0, z: 0, alive: true },
    poiAt: (poi) => [stub(poi)],
    heldResource: (resource) => save.resources[resource],
    nearPoi: (poi) => stub(poi),
    follower: { x: 0, z: 0, alive: true },
    // SPEC-054 §3: the campaign harness never descends (§4.13's pins hold).
    level: 'surface',
  };

  const run: Run = {
    options,
    sides: options.sides ?? false,
    killXp: options.killXp ?? false,
    save,
    bus,
    progression,
    economy,
    report,
    ctx,
  };

  for (const chapter of CHAPTERS) {
    if (!playChapter(run, chapter)) break;
  }

  report.serviceModeSeen ||= economy.serviceMode;
  stopRecording();
  return report;
}

/** §4.4, steps 1–6 for one chapter. False when the run has to stop. */
function playChapter(run: Run, chapter: Chapter): boolean {
  const { save, economy, report } = run;
  const planet = planetOfChapter(chapter);
  /** Flight missions of this planet already taken this chapter, so a failed one is not flown forever. */
  const boarded = new Set<MissionId>();

  for (let trip = 0; ; trip++) {
    // 1. Station: the fuel floor, then — on the chapter's first trip — the shop.
    report.subsidyCalls += 1;
    report.subsidyOil += economy.applyStationSubsidy();
    if (trip === 0) {
      if ((LOADOUT_CHAPTERS as readonly number[]).includes(chapter)) {
        buyAll(run, chapter, RECOMMENDED_LOADOUT[chapter as LoadoutChapter]);
      }
      buyAll(run, chapter, run.options.extraPurchases?.[chapter] ?? []);
    }

    // 2. Board: the destination's flight missions can only be taken here.
    for (const def of boardable(run, planet)) {
      boarded.add(def.id);
      acceptMission(save, def);
      run.bus.emit('mission:accepted', { id: def.id });
    }

    // 3. Depart.
    report.serviceModeSeen ||= economy.serviceMode;
    const depart = economy.canDepart(planet);
    if (!depart.ok) {
      report.problems.push(
        depart.reason === 'locked'
          ? `chapter ${chapter}: ${planet} is locked on ${(depart.missing ?? []).map((requirement) => JSON.stringify(requirement)).join(', ')}`
          : `chapter ${chapter}: ${depart.needOil ?? 0} oil short of ${planet}`,
      );
      return false;
    }
    const cost = economy.fuelCost(planet);
    if (!economy.payFuel(planet)) {
      report.problems.push(`chapter ${chapter}: payFuel(${planet}) refused`);
      return false;
    }

    // 4. Fly.
    if (!fly(run, planet, cost)) return false;

    // 5. Land.
    land(run, planet);

    // 6. Again? A flight mission this landing unlocked (`c4_s2`) is flown next.
    if (!run.sides || !boardable(run, planet).some((def) => !boarded.has(def.id))) return true;
  }
}

/** §4.4 step 2: the destination's flight missions the board offers right now. */
function boardable(run: Run, planet: PlanetId): MissionDef<MissionId>[] {
  return MISSION_LIST.filter(
    (def) =>
      def.planet === planet &&
      def.scene === 'flight' &&
      (run.sides || def.type === 'main') &&
      missionStatus(run.save, def, 'station') === 'available',
  );
}

/** Buys `entries` in order; a refusal is a problem and the rest is still bought. */
function buyAll(run: Run, chapter: Chapter, entries: readonly LoadoutEntry[]): void {
  const { economy, report } = run;
  for (const entry of entries) {
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

/**
 * §4.4 step 4: the trip, flown by the real `Flight` the way the scene builds it
 * (D-5). False when it did not arrive, which stops the run (16-d).
 */
function fly(run: Run, planet: PlanetId, cost: number): boolean {
  const { save, economy, report, bus } = run;
  const oilAfter = save.resources.oil;
  const visits = save.progress.visits[planet] ?? 0;
  const missions = new Missions(save, economy, bus, 'flight', planet);
  const flight = new Flight(
    {
      planet: PLANETS[planet],
      ship: save.ship,
      companions: save.companions,
      quality: QUALITY.medium,
      difficulty: save.meta.difficulty,
      // SPEC-058 §4.4: a later instance's containment, as the flight scene passes it.
      iteration: save.meta.iteration,
      companionMult: computePlayerStats(save).companionMult,
    },
    economy,
    run.progression,
    missions,
    bus,
    new RngRoot(save.meta.seed).visit(planet, visits, save.meta.iteration).fork('flight'),
  );

  // One throttle edge per notch away from 1.
  const throttle = run.options.throttle ?? 1;
  if (throttle !== 1) {
    flight.update(STEP, { ...IDLE_INPUT, throttleUp: throttle > 1, throttleDown: throttle < 1 });
  }

  // The kills a flight mission asks for; `fastForward` credits none.
  for (const state of missions.active.slice()) {
    for (const progress of missions.currentObjectives(state.id)) {
      if (progress.objective.kind !== 'kill' || progress.done) continue;
      killMany(run, progress.objective.enemy, progress.target - progress.value);
    }
  }

  flight.fastForward(TRIP_LIMIT_SECONDS);
  if (flight.phase !== 'arrived') {
    report.problems.push(`${planet}: the trip ended ${flight.phase}`);
    missions.dispose();
    return false;
  }
  report.jumps.push({ planet, cost, oilAfter, seconds: flight.time, holdSeconds: flight.holdSeconds });

  // 16-c: a flight mission still open on arrival is the R16 class of problem.
  for (const entry of save.progress.missionsActive.slice()) {
    const def = MISSIONS[entry.id];
    if (def.planet !== planet || def.scene !== 'flight') continue;
    report.problems.push(`${planet}: landed with ${entry.id} open`);
    missions.abandon(entry.id);
  }
  missions.dispose();
  report.lowestOil = Math.min(report.lowestOil, save.resources.oil);
  return true;
}

/** §4.4 step 5: every mission the pad offers, one at a time, until none is left. */
function land(run: Run, planet: PlanetId): void {
  const { save, economy, report, bus } = run;
  save.progress.visits[planet] = (save.progress.visits[planet] ?? 0) + 1;
  save.progress.currentPlanet = planet;
  save.progress.location = 'surface';
  const missions = new Missions(save, economy, bus, 'surface', planet);
  // An abandoned mission is offered again, so each is tried once per landing.
  const tried = new Set<MissionId>();
  for (;;) {
    const next = missions
      .available()
      .find(
        (def) =>
          !tried.has(def.id as MissionId) &&
          !(save.progress.missionsDone as readonly string[]).includes(def.id) &&
          (run.sides || def.type === 'main'),
      );
    if (next === undefined) break;
    const id = next.id as MissionId;
    tried.add(id);
    const accepted = missions.accept(id);
    if (!accepted.ok) {
      report.problems.push(`${id}: accept refused with ${accepted.reason}`);
      continue;
    }
    play(run, missions, id);
    report.lowestOil = Math.min(report.lowestOil, save.resources.oil);
  }
  missions.dispose();
  save.progress.location = 'station';
}

/** The mission's stage as the save stores it, or null once it has left `missionsActive`. */
function stageOf(save: Save, id: MissionId): number | null {
  return save.progress.missionsActive.find((entry) => entry.id === id)?.stage ?? null;
}

/** §4.3 and D-4: one mission, stage by stage, until it completes or is abandoned. */
function play(run: Run, missions: Missions, id: MissionId): void {
  const { save, report } = run;
  const def = MISSIONS[id];
  for (;;) {
    const stage = stageOf(save, id);
    if (stage === null) return; // completed
    const objectives = def.stages[stage] ?? [];

    for (let index = 0; index < objectives.length; index++) {
      if (stageOf(save, id) !== stage) break;
      const progress = missions.currentObjectives(id)[index];
      if (progress === undefined || progress.done) continue;
      if (!satisfy(run, missions, id, progress)) {
        missions.abandon(id);
        return;
      }
    }

    const budget = stepBudget(objectives) * 60 + 60;
    for (let step = 0; step < budget && stageOf(save, id) === stage; step++) missions.update(STEP, run.ctx);
    if (stageOf(save, id) === stage) {
      report.problems.push(`${id}: stage ${stage} did not finish`);
      missions.abandon(id);
      return;
    }
  }
}

/**
 * D-4's `S`: the longest `survive` or `defend` timer of the stage; 1 for a
 * `deliver` or an `escort` with no longer timer; 0 otherwise.
 */
function stepBudget(objectives: readonly Objective[]): number {
  let seconds = 0;
  for (const objective of objectives) {
    if (objective.kind === 'survive' || objective.kind === 'defend') seconds = Math.max(seconds, objective.seconds);
    else if (objective.kind === 'deliver' || objective.kind === 'escort') seconds = Math.max(seconds, 1);
  }
  return seconds;
}

/**
 * §4.3: report one unfinished objective the way the scene would. False when the
 * mission cannot finish and has to be abandoned (§4.5).
 */
function satisfy(run: Run, missions: Missions, id: MissionId, progress: ObjectiveProgress): boolean {
  const { bus, report } = run;
  const objective = progress.objective;
  switch (objective.kind) {
    case 'reach':
      bus.emit('poi:reached', { poi: objective.poi, instance: 0 });
      return true;
    case 'scan':
      for (let instance = 0; instance < objective.count; instance++) bus.emit('poi:scanned', { poi: objective.poi, instance });
      return true;
    case 'collect': {
      const amount = progress.target - progress.value;
      report.collects.push({
        mission: id,
        resource: objective.resource,
        held: run.save.resources[objective.resource],
        amount,
        cap: run.economy.cargoCap(),
      });
      return pickUp(run, id, objective.resource, amount);
    }
    case 'kill':
      killMany(run, objective.enemy, progress.target - progress.value);
      return true;
    case 'boss':
      kill(run, objective.enemy, 1);
      bus.emit('boss:defeated', { boss: objective.enemy });
      return true;
    case 'deliver': {
      // E16: the player tops up at a node and hands over the whole amount.
      const short = objective.amount - run.save.resources[objective.resource];
      return short <= 0 || pickUp(run, id, objective.resource, short);
    }
    case 'choice': {
      const option = objective.options.findIndex((candidate) => (candidate.flags as readonly string[]).includes(run.options.ending));
      if (option < 0) {
        report.problems.push(`${id}: no option files ${run.options.ending}`);
        return false;
      }
      missions.choose(id, option);
      return true;
    }
    case 'survive':
    case 'defend':
    case 'escort':
      // Stepped by `play`.
      return true;
  }
}

/** One harvest from the planet's nodes. False — with its problem — when the hold blocked any of it. */
function pickUp(run: Run, id: MissionId, resource: ResourceId, need: number): boolean {
  const held = run.save.resources[resource];
  const cap = run.economy.cargoCap();
  const { added, shipped, blocked } = run.economy.addResource(resource, need, 'pickup');
  if (blocked <= 0) return true;
  run.report.problems.push(`${id}: the hold took ${added + shipped} of ${need} ${resource} (${held} aboard, cap ${cap})`);
  return false;
}

function killMany(run: Run, enemy: EnemyId, count: number): void {
  for (let n = 0; n < count; n++) kill(run, enemy, KILL_XP_MULT);
}

/** `Combat.killEnemy`'s order: the kill, then its XP (§4.2 — only with `killXp`). */
function kill(run: Run, enemy: EnemyId, xpMult: number): void {
  const xp = ENEMIES[enemy].xp;
  run.bus.emit('enemy:killed', { enemyId: enemy, elite: false, x: 0, z: 0, xp });
  if (run.killXp) run.progression.addXp(xpMult * xp, 'kill');
}
