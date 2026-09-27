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
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { QUALITY } from '@/core/Renderer';
import { Rng, hash32 } from '@/core/Rng';
import { newSave, type CharacterCreation, type Save } from '@/core/Save';
import { MISSIONS, PLANETS, WAVES } from '@/data/index';
import { Economy } from '@/systems/Economy';
import { Flight, type FlightConfig } from '@/systems/Flight';
import { Missions } from '@/systems/Missions';
import { Progression } from '@/systems/Progression';
import { Pilot, type PilotAim } from './pilot';

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
function fly(seed: number, aim: PilotAim): Run {
  const save: Save = newSave(0, PILOT, seed, 1_700_000_000_000);
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
});
