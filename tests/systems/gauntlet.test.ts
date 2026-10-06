// SPEC-034 §4.4, §6.1 — the Hive Gauntlet, flown.
//
// `c5_m1` (survive 180 s, put six interceptors down) gates every Hive mission,
// and nothing tested it: the campaign harness of SPEC-016 *emits* the kills and
// the dev skip completes the flight, so the design review was the first thing
// ever to fly it — and cleared it in 0 of 8 runs with any ship. Three things
// were wrong at once: the shot sweep let a third of perfectly aimed shots
// through a diving target (§4.3), the interceptors carried chapter-5 scaled HP
// (§4.4), and ten kills was more than the trip's dive time allows.
//
// This flies the real `Flight` and `Missions` with the autopilot of §4.4, so the
// claim is about the trip's numbers and not about a model of them.
//
// SPEC-041 §6.1 adds the Ferrum run, where fighters now fire bracketing bursts
// (§4.8) and ARIA level 2 chases the lead point (§4.7). `c4_s2` asks for eight
// scav fighters; a pilot who never leads anything takes them down with the
// level-2 assist, and with level 1 — the reticle left to the raw aim — it
// still has to come through the bursts without a recall.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { QUALITY } from '@/core/Renderer';
import { Rng, hash32 } from '@/core/Rng';
import { newSave, type CharacterCreation, type Save } from '@/core/Save';
import { MISSIONS, PLANETS, WAVES } from '@/data/index';
import { LOADOUT_CHAPTERS, RECOMMENDED_LOADOUT } from '@/systems/Balance';
import { Economy } from '@/systems/Economy';
import { Flight, type FlightConfig } from '@/systems/Flight';
import { Missions } from '@/systems/Missions';
import { Progression } from '@/systems/Progression';
import { Pilot, type PilotAim } from './flightPilot';

const DT = 1 / 60;
/** Long enough for the 200 s trip plus R16's 90 s holding cap, and no longer. */
const LIMIT_SECONDS = 320;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

const PILOT: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
};

interface Run {
  completed: boolean;
  recalled: boolean;
  kills: number;
  seconds: number;
}

/**
 * One Hive trip, built the way the flight scene builds it: the chapter-5
 * recommended ship (`RECOMMENDED_LOADOUT` through chapter 5 — hull 2, shield 2,
 * engine 1, weapon 0), ARIA at level 1 (no aim assist, §4.7), `QUALITY.medium`,
 * normal difficulty, and `c5_m1` accepted.
 */
function fly(seed: number, aim: PilotAim, iteration = 1): Run {
  const save: Save = newSave(0, PILOT, seed, 1_700_000_000_000);
  // SPEC-058 §4.4: a later instance's trip, built as the flight scene builds it.
  save.meta.iteration = iteration;
  save.ship = { ...save.ship, hull: 2, shield: 2, engine: 1, weapon: 0 };
  save.companions = [{ id: 'aria', level: 1, enabled: true }];
  save.progress.missionsActive.push({ id: 'c5_m1', stage: 0, counters: {} });

  const events = new EventBus<GameEvents>({ dev: false });
  let completed = false;
  let kills = 0;
  events.on('mission:completed', ({ id }) => {
    if (id === 'c5_m1') completed = true;
  }, {});
  events.on('enemy:killed', ({ enemyId }) => {
    if (enemyId === 'hive_interceptor') kills++;
  }, {});

  const progression = new Progression(save, events);
  const economy = new Economy(save, events, progression);
  const planet = PLANETS.hive;
  const missions = new Missions(save, economy, events, 'flight', planet.id);
  const cfg: FlightConfig = {
    planet,
    ship: save.ship,
    companions: save.companions,
    quality: QUALITY.medium,
    difficulty: save.meta.difficulty,
    iteration: save.meta.iteration,
  };
  const flight = new Flight(cfg, economy, progression, missions, events, new Rng(hash32(seed, 'flight')));
  const pilot = new Pilot(new Rng(hash32(seed, 'pilot')), aim);

  let seconds = 0;
  while (seconds < LIMIT_SECONDS && flight.phase !== 'arrived' && flight.phase !== 'recalled') {
    flight.update(DT, pilot.frame(flight));
    seconds += DT;
  }
  const run: Run = { completed, recalled: flight.phase === 'recalled', kills, seconds };
  missions.dispose();
  return run;
}

describe('the Hive Gauntlet is winnable (SPEC-034 §4.4)', () => {
  it('asks for six interceptor kills against a trip that spawns thirty', () => {
    const objective = MISSIONS.c5_m1.stages[0]?.[1];
    expect(objective).toEqual({ kind: 'kill', enemy: 'hive_interceptor', amount: 6 });
    expect(MISSIONS.c5_m1.stages[0]?.[0]).toEqual({ kind: 'survive', seconds: 180 });
    // E12's bound: the waves spawn at least twice what the objective asks for.
    const spawned = WAVES.hive_flight.groups.reduce((sum, group) => sum + group.count, 0);
    expect(spawned).toBe(30);
    expect(spawned).toBeGreaterThanOrEqual(2 * 6);
  });

  it('completes for a pilot who never leads the target, in at least 14 of 16 seeds', () => {
    const runs = SEEDS.map((seed) => fly(seed, 'none'));
    const won = runs.filter((run) => run.completed).length;
    expect(runs.filter((run) => run.recalled)).toEqual([]);
    expect(won, `no-lead wins: ${runs.map((r) => `${r.kills}`).join(' ')}`).toBeGreaterThanOrEqual(14);
  });

  it('completes for a pilot who leads it, in all 16', () => {
    const runs = SEEDS.map((seed) => fly(seed, 'lead'));
    expect(runs.filter((run) => run.recalled)).toEqual([]);
    const won = runs.filter((run) => run.completed).length;
    expect(won, `lead wins: ${runs.map((r) => `${r.kills}`).join(' ')}`).toBe(16);
  });

  it('at iteration 4 — containment’s cap, every hit ×1.52, the interceptors at their HP — still completes in at least 12 of 16 (SPEC-058 §4.4)', () => {
    const runs = SEEDS.map((seed) => fly(seed, 'none', 4));
    const won = runs.filter((run) => run.completed).length;
    expect(won, `iteration-4 wins: ${runs.map((r) => `${r.completed ? 'W' : r.recalled ? 'R' : '-'}${r.kills}`).join(' ')}`).toBeGreaterThanOrEqual(12);
  });
});

// ------------------------------------------------------------ SPEC-041 §6.1

/** The ship `RECOMMENDED_LOADOUT` has a player own through `chapter`: each system at its highest listed tier. */
function recommendedShip(base: Save['ship'], chapter: number): Save['ship'] {
  const ship = { ...base };
  for (const step of LOADOUT_CHAPTERS) {
    if (step > chapter) continue;
    for (const entry of RECOMMENDED_LOADOUT[step]) {
      if (entry.kind === 'ship' && entry.tier > ship[entry.id]) ship[entry.id] = entry.tier;
    }
  }
  return ship;
}

/**
 * One Ferrum trip, built the way `fly` builds the Hive's: the chapter-4
 * recommended ship, ARIA at `aria`, `QUALITY.medium`, normal difficulty, and
 * `c4_s2` accepted (its `c4_m1` requirement done), flown with aim `none`.
 */
function flyFerrum(seed: number, aria: 1 | 2): Run {
  const save: Save = newSave(0, PILOT, seed, 1_700_000_000_000);
  save.ship = recommendedShip(save.ship, 4);
  save.companions = [{ id: 'aria', level: aria, enabled: true }];
  save.progress.missionsDone.push('c4_m1');
  save.progress.missionsActive.push({ id: 'c4_s2', stage: 0, counters: {} });

  const events = new EventBus<GameEvents>({ dev: false });
  let completed = false;
  let kills = 0;
  events.on('mission:completed', ({ id }) => {
    if (id === 'c4_s2') completed = true;
  }, {});
  events.on('enemy:killed', ({ enemyId }) => {
    if (enemyId === 'scav_fighter') kills++;
  }, {});

  const progression = new Progression(save, events);
  const economy = new Economy(save, events, progression);
  const planet = PLANETS.ferrum;
  const missions = new Missions(save, economy, events, 'flight', planet.id);
  const cfg: FlightConfig = {
    planet,
    ship: save.ship,
    companions: save.companions,
    quality: QUALITY.medium,
    difficulty: save.meta.difficulty,
  };
  const flight = new Flight(cfg, economy, progression, missions, events, new Rng(hash32(seed, 'flight')));
  const pilot = new Pilot(new Rng(hash32(seed, 'pilot')), 'none');

  let seconds = 0;
  while (seconds < LIMIT_SECONDS && flight.phase !== 'arrived' && flight.phase !== 'recalled') {
    flight.update(DT, pilot.frame(flight));
    seconds += DT;
  }
  const run: Run = { completed, recalled: flight.phase === 'recalled', kills, seconds };
  missions.dispose();
  return run;
}

describe('the Ferrum run against fighter bursts (SPEC-041 §6.1)', () => {
  it('flies the chapter-4 recommended ship: hull 1, shield 2, engine 0, guns 0', () => {
    expect(recommendedShip(newSave(0, PILOT, 1, 1_700_000_000_000).ship, 4)).toEqual({ engine: 0, hull: 1, shield: 2, cargo: 0, weapon: 0 });
    expect(MISSIONS.c4_s2.stages).toEqual([[{ kind: 'kill', enemy: 'scav_fighter', amount: 8 }]]);
  });

  it('completes c4_s2 with ARIA level 2 for a pilot who never leads, in at least 14 of 16 seeds', () => {
    const runs = SEEDS.map((seed) => flyFerrum(seed, 2));
    const won = runs.filter((run) => run.completed).length;
    expect(won, `ARIA 2 kills: ${runs.map((r) => `${r.kills}${r.recalled ? 'R' : ''}`).join(' ')}`).toBeGreaterThanOrEqual(14);
  });

  it('finishes the trip without a recall with ARIA level 1, in at least 14 of 16 seeds', () => {
    const runs = SEEDS.map((seed) => flyFerrum(seed, 1));
    const home = runs.filter((run) => !run.recalled).length;
    expect(home, `ARIA 1 recalled at: ${runs.filter((r) => r.recalled).map((r) => r.seconds.toFixed(0)).join(' ')}`).toBeGreaterThanOrEqual(14);
  });
});
