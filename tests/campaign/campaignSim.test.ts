// The campaign simulation (SPEC-010 §7, SPEC-016 §4). The executable proof that
// the game is completable: scripted players walk the whole campaign through the
// real `Missions`, `Flight`, `Economy` and `Progression`, and have to reach
// `campaign_done` without the station ever bailing them out.
//
// One describe per player of §4.1, plus determinism (D-6). Each computes its
// run once. The worst case files one verdict and its escape run the other,
// because E24 makes them mutually exclusive inside a save: `campaign_done`
// locks `c6_m2`, so a single run can only file one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameEvents } from '@/core/Events';
import { setLogSink, type LogSink } from '@/core/Log';
import { MISSIONS, PLANETS, TUNING, UPGRADES } from '@/data/index';
import { COMPLETIONIST_LEVEL, completionistTokens, totalTokenSink, worstCaseTokensBefore } from '@/systems/Balance';
import { LAUNCH_SECONDS } from '@/systems/Flight';
import { runCampaign, type Jump, type RunOptions, type RunReport } from './harness';

const mute: LogSink = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

beforeAll(() => {
  setLogSink(mute);
});

afterAll(() => {
  setLogSink(console);
});

const ALL_MISSIONS = Object.values(MISSIONS).map((mission) => mission.id);
const MAIN_MISSIONS = Object.values(MISSIONS)
  .filter((mission) => mission.type === 'main')
  .map((mission) => mission.id);

const WORST_CASE: RunOptions = { ending: 'ending_stay' };
const ESCAPE: RunOptions = { ending: 'ending_escape' };
const FASTEST: RunOptions = { ending: 'ending_stay', throttle: 1.2 };
const BASE_HOLD: RunOptions = { ending: 'ending_escape', sides: true, killXp: true };
const COMPLETIONIST: RunOptions = {
  ...BASE_HOLD,
  extraPurchases: {
    3: [
      { kind: 'ship', id: 'cargo', tier: 1 },
      { kind: 'ship', id: 'cargo', tier: 2 },
    ],
  },
};

/** D-2: inclusive, and never `toBeCloseTo` — its default precision is tighter. */
function expectWithin(actual: number, expected: number, tolerance = 0.1): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

/** §4.4 / D-2: the flown length of a trip that nothing holds. */
function tripSeconds(jump: Jump, engine: number, throttle: number): number {
  const speedMult = UPGRADES.engine.metrics.speedMult[engine] ?? 1;
  return LAUNCH_SECONDS + PLANETS[jump.planet].travelSeconds / speedMult / throttle;
}

/**
 * D-2: `save.ship.engine` at each departure, in `jumps` order — read off the
 * run's bus as the last engine bought before the trip's `flight:arrived`,
 * since nothing is bought in flight. A new save's engine is 0 (SPEC-007).
 */
function enginesAtDeparture(run: RunReport): number[] {
  const engines: number[] = [];
  let engine = 0;
  for (const event of run.events) {
    if (event.name === 'shop:purchased') {
      const bought = event.payload as GameEvents['shop:purchased'];
      if (bought.kind === 'ship' && bought.id === 'engine') engine = bought.tier ?? engine;
    } else if (event.name === 'flight:arrived') {
      engines.push(engine);
    }
  }
  expect(engines).toHaveLength(run.jumps.length);
  expect(engine).toBe(run.save.ship.engine);
  return engines;
}

function tokensOf(purchases: readonly string[]): number {
  return purchases.reduce((total, entry) => total + Number(entry.split('@')[1] ?? 0), 0);
}

/** §4.7, every run: five vouchers, one subsidy call per trip, and no oil from it. */
function expectEveryRunRules(run: RunReport): void {
  expect(run.vouchers).toBe(5);
  expect(run.subsidyCalls).toBe(run.jumps.length);
  expect(run.subsidyOil).toBe(0);
}

describe('Worst case', () => {
  let run: RunReport;

  beforeAll(() => {
    run = runCampaign(WORST_CASE);
  });

  it('runs with the service override off (SPEC-032)', () => {
    // Service mode unlocks every world and waives the skip rules; a campaign
    // proven with it on proves nothing about the shipped game.
    expect(run.serviceModeSeen).toBe(false);
  });

  it('finishes, with nothing refusing along the way', () => {
    expect(run.problems).toEqual([]);
    expect(run.missionsDone).toEqual(MAIN_MISSIONS);
    expect(run.missionsDone).toHaveLength(17);
    expect(run.save.progress.flags).toContain('campaign_done');
  });

  it('never needs the station subsidy (E1, AC-28)', () => {
    // The station is asked on every visit — that is the rule — and answers
    // "you can already get somewhere" every single time.
    expect(run.subsidyCalls).toBe(6);
    expect(run.subsidyOil).toBe(0);
    expect(run.lowestOil).toBeGreaterThanOrEqual(0);
  });

  it('pays its own way, chapter by chapter, on the boss vouchers alone', () => {
    expect(run.jumps.map((jump) => jump.planet)).toEqual(['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden']);
    // Chapters 1–4 pay the table price; the tier-1 engine bought before the
    // Hive thins the last two jumps by a tenth (§4.6).
    expect(run.jumps.map((jump) => jump.cost)).toEqual([40, 60, 80, 100, 108, 108]);
    expect(run.jumps.every((jump) => jump.oilAfter >= 0)).toBe(true);
    expect(run.lowestOil).toBe(TUNING.START_OIL - PLANETS.cinder4.fuelCost);
    expect(run.vouchers).toBe(5);
  });

  it('buys the whole recommended loadout out of worst-case income', () => {
    expect(run.purchases).toEqual([
      'gear:armor_composite@39',
      'companion:scanner_drone@20',
      'gear:weapon_laser@39',
      'ship:hull:1@30',
      'ship:shield:1@49',
      'ship:shield:2@88',
      'companion:combat_drone@30',
      'gear:weapon_plasma@78',
      'ship:hull:2@59',
      'ship:engine:1@30',
      'gear:armor_reactive@78',
      'ship:weapon:1@39',
      'companion:field_medic@30',
    ]);
    // The Ferrum gate is the one the whole model exists for (E2).
    expect(run.save.ship.shield).toBe(2);
    expect(run.save.equipped).toEqual({
      armor: 'armor_reactive',
      sidearm: 'pistol_service',
      primary: 'weapon_plasma',
      heavy: null,
    });
    expect(run.save.player.tokens).toBeGreaterThanOrEqual(0);
  });

  it('lands on the level the balance model predicts', () => {
    // §5: main-mission XP alone is 5,480, which is level 13.
    expect(run.save.player.xp).toBe(5480);
    expect(run.save.player.level).toBe(13);
    // Everything earned, less everything the loadout cost, is what is left.
    const earned = worstCaseTokensBefore(7);
    const spent = tokensOf(run.purchases);
    expect(earned).toBe(970);
    expect(run.save.player.tokens).toBe(earned - spent);
  });

  it('earns and spends exactly what the books say', () => {
    expect(run.tokensEarned).toBe(970);
    expect(run.tokensSpent).toBe(609);
    expect(run.save.player.tokens).toBe(361);
  });

  it('starts every collect objective inside the base hold (E3)', () => {
    expect(run.collects).toEqual([
      { mission: 'c1_m2', resource: 'oil', held: 40, amount: 150, cap: 400 },
      { mission: 'c2_m2', resource: 'water', held: 20, amount: 200, cap: 400 },
      { mission: 'c3_m1', resource: 'wheat', held: 20, amount: 250, cap: 400 },
      { mission: 'c4_m2', resource: 'lithium', held: 0, amount: 200, cap: 400 },
    ]);
    for (const collect of run.collects) expect(collect.held + collect.amount).toBeLessThanOrEqual(collect.cap);
  });

  it('flies every trip for as long as the formula says, except the Hive (D-2)', () => {
    const engines = enginesAtDeparture(run);
    run.jumps.forEach((jump, i) => {
      if (jump.planet !== 'hive') expectWithin(jump.seconds, tripSeconds(jump, engines[i] ?? 0, 1));
    });
  });

  it('holds over the Hive until the Gauntlet is survived (R16)', () => {
    const hive = run.jumps.find((jump) => jump.planet === 'hive');
    expect(hive).toBeDefined();
    expectWithin(hive?.seconds ?? 0, 180.0);
    expectWithin(hive?.holdSeconds ?? 0, 3.1);
    expect(run.missionsDone).toContain('c5_m1');
    expect(run.problems).not.toContain('hive: landed with c5_m1 open');
  });

  it('files one verdict, and only one (E24)', () => {
    expect(run.save.progress.flags).toContain('ending_stay');
    expect(run.save.progress.flags).not.toContain('ending_escape');
  });

  it('pays five vouchers, asks the subsidy once per trip and takes nothing from it', () => {
    expectEveryRunRules(run);
  });
});

describe('The escape run', () => {
  let escape: RunReport;
  let stay: RunReport;

  beforeAll(() => {
    escape = runCampaign(ESCAPE);
    stay = runCampaign(WORST_CASE);
  });

  it('the refusal is reachable from the same worst-case run', () => {
    expect(escape.problems).toEqual([]);
    expect(escape.subsidyOil).toBe(0);
    expect(escape.save.progress.flags).toContain('campaign_done');
    expect(escape.save.progress.flags).toContain('ending_escape');
    expect(escape.save.progress.flags).not.toContain('ending_stay');
  });

  it('differs from the stay run in exactly one flag, and ends with the same tokens', () => {
    const difference = (a: string[], b: string[]): string[] => a.filter((flag) => !b.includes(flag));
    expect(difference(escape.save.progress.flags, stay.save.progress.flags)).toEqual(['ending_escape']);
    expect(difference(stay.save.progress.flags, escape.save.progress.flags)).toEqual(['ending_stay']);
    expect(stay.save.player.tokens).toBe(escape.save.player.tokens);
  });

  it('pays five vouchers, asks the subsidy once per trip and takes nothing from it', () => {
    expectEveryRunRules(escape);
  });
});

describe('Fastest', () => {
  let run: RunReport;

  beforeAll(() => {
    run = runCampaign(FASTEST);
  });

  it('finishes with nothing refusing', () => {
    expect(run.problems).toEqual([]);
    expect(run.missionsDone).toEqual(MAIN_MISSIONS);
  });

  it('waits over the Hive for c5_m1 on the shortest trip (R16)', () => {
    const hive = run.jumps.find((jump) => jump.planet === 'hive');
    expect(hive).toBeDefined();
    expectWithin(hive?.seconds ?? 0, 180.0);
    expectWithin(hive?.holdSeconds ?? 0, 32.1);
  });

  it('flies every other trip at the 1.2 notch (D-2)', () => {
    expect(run.jumps.map((jump) => jump.planet)).toEqual(['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive', 'eden']);
    const engines = enginesAtDeparture(run);
    run.jumps.forEach((jump, i) => {
      if (jump.planet !== 'hive') expectWithin(jump.seconds, tripSeconds(jump, engines[i] ?? 0, 1.2));
    });
  });

  it('pays five vouchers, asks the subsidy once per trip and takes nothing from it', () => {
    expectEveryRunRules(run);
  });
});

describe('Completionist', () => {
  let run: RunReport;

  beforeAll(() => {
    run = runCampaign(COMPLETIONIST);
  });

  it('finishes all 26 missions with nothing refusing', () => {
    expect(run.problems).toEqual([]);
    expect(run.missionsDone).toHaveLength(26);
    expect([...run.missionsDone].sort()).toEqual([...ALL_MISSIONS].sort());
    expect(run.save.progress.flags).toContain('campaign_done');
  });

  it('flies to Ferrum twice, the second time for c4_s2', () => {
    expect(run.jumps.map((jump) => jump.planet)).toEqual(['cinder4', 'vetra', 'thessaly', 'ferrum', 'ferrum', 'hive', 'eden']);
    expect(run.jumps.map((jump) => jump.cost)).toEqual([40, 60, 80, 100, 100, 108, 108]);
  });

  it('lands on §4.7 numbers', () => {
    expect(run.save.player.xp).toBe(11135);
    expect(run.save.player.level).toBe(19);
    expect(run.tokensEarned).toBe(1224);
    expect(run.tokensSpent).toBe(683);
    expect(run.subsidyOil).toBe(0);
    expect(run.vouchers).toBe(5);
  });

  it('does not out-earn the model of the sink (PLAN §7)', () => {
    expect(run.save.player.level).toBeLessThanOrEqual(COMPLETIONIST_LEVEL);
    expect(run.tokensEarned).toBeLessThanOrEqual(completionistTokens());
    expect(run.tokensEarned).toBeLessThanOrEqual(0.7 * totalTokenSink().total);
  });

  it('pays five vouchers, asks the subsidy once per trip and takes nothing from it', () => {
    expectEveryRunRules(run);
  });
});

describe('Completionist, base hold', () => {
  let run: RunReport;

  beforeAll(() => {
    run = runCampaign(BASE_HOLD);
  });

  it('finishes all 26 missions with nothing refusing', () => {
    expect(run.problems).toEqual([]);
    expect(run.missionsDone).toHaveLength(26);
    expect([...run.missionsDone].sort()).toEqual([...ALL_MISSIONS].sort());
  });

  it('ships the surplus of c3_s2 home rather than stalling on a full hold (§4.6, E56)', () => {
    // 350 wheat aboard and 300 wanted against a hold of 400: before SPEC-034 the
    // pickup blocked at 50 and nothing on the surface could shed the hoard.
    const reaping = run.collects.find((collect) => collect.mission === 'c3_s2');
    expect(reaping).toEqual({ mission: 'c3_s2', resource: 'wheat', held: 350, amount: 300, cap: 400 });
    expect(run.missionsDone).toContain('c3_s2');
    expect(run.save.resources.wheat).toBeLessThanOrEqual(400);
  });

  it('lands on the completionist numbers, less the two cargo tiers', () => {
    expect(run.save.player.xp).toBe(11135);
    expect(run.save.player.level).toBe(19);
    expect(run.tokensEarned).toBe(1224);
    expect(run.tokensSpent).toBe(609);
    expect(run.subsidyOil).toBe(0);
    expect(run.vouchers).toBe(5);
  });

  it('pays five vouchers, asks the subsidy once per trip and takes nothing from it', () => {
    expectEveryRunRules(run);
  });
});

describe('Determinism (16-e)', () => {
  it('two worst-case runs in one process emit the same events', () => {
    expect(runCampaign(WORST_CASE).events).toEqual(runCampaign(WORST_CASE).events);
  });

  it('two completionist runs in one process emit the same events', () => {
    expect(runCampaign(COMPLETIONIST).events).toEqual(runCampaign(COMPLETIONIST).events);
  });
});

describe('Bonuses and side rewards in the harness (SPEC-043 §4.7)', () => {
  let worst: RunReport;
  let completionist: RunReport;

  beforeAll(() => {
    worst = runCampaign(WORST_CASE);
    completionist = runCampaign(COMPLETIONIST);
  });

  const judged = (run: RunReport): GameEvents['mission:bonus'][] =>
    run.events.filter((event) => event.name === 'mission:bonus').map((event) => event.payload as GameEvents['mission:bonus']);

  it('the worst case earns every main bonus but the elite one — it never dies, shelters or kills an elite', () => {
    // The 17 main missions less the tutorial, the Gauntlet and the finale.
    expect(judged(worst)).toHaveLength(14);
    expect(judged(worst).filter((bonus) => !bonus.earned)).toEqual([{ id: 'c4_m2', bonus: 'elites', earned: false }]);
    // Main bonuses pay items only, so the pinned collects above start where they did.
    expect(worst.events.some((event) => event.name === 'item:noRoom')).toBe(false);
  });

  it('the completionist judges all 22, and its side resources land without a refusal', () => {
    expect(judged(completionist)).toHaveLength(22);
    expect(judged(completionist).filter((bonus) => !bonus.earned).map((bonus) => bonus.id)).toEqual(['c3_s1', 'c4_m2']);
    expect(completionist.problems).toEqual([]);
    expect(completionist.events.some((event) => event.name === 'item:noRoom')).toBe(false);
    // The harness never replays, so nothing ran as a contract.
    const completed = completionist.events.filter((event) => event.name === 'mission:completed');
    expect(completed.every((event) => (event.payload as GameEvents['mission:completed']).contract === undefined)).toBe(true);
  });
});
