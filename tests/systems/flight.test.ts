// systems/Flight + systems/Missions (SPEC-013 §6). Every case §6 lists, one
// `describe` each, in the order it lists them, plus the throttle/steering pins
// of §4.1–§4.2 and the mission engine's own contract (§4.8).
//
// The harness builds the real stack — save, EventBus, Progression, Economy,
// Missions, Flight — over a synthetic planet where a case needs a controlled
// sky (no asteroids, no waves, no storms), and the real `PLANETS` rows where
// the case is about the shipped numbers. All randomness runs through a fixed
// `Rng(7)`; the loop steps a fixed 1/60 s like the game's own update.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { Input } from '@/core/Input';
import { PressEdges } from '@/core/PressEdges';
import { QUALITY } from '@/core/Renderer';
import { Rng } from '@/core/Rng';
import { newSave, type CharacterCreation, type Save } from '@/core/Save';
import { ENEMIES, MISSIONS, PLANETS, TUNING, UPGRADES, type Difficulty, type MissionId, type PlanetDef } from '@/data/index';
import { Economy } from '@/systems/Economy';
import {
  burstAim,
  CONVERGE_DEPTH,
  ENEMY_SHOT_RADIUS,
  enemyShotEta,
  FIGHTER_BURST,
  FIGHTER_LEAVE_SECONDS,
  Flight,
  HAZARD_FLASH_SECONDS,
  LAUNCH_SECONDS,
  PLANE,
  RAIL,
  SHIP_RADIUS,
  THREAT_BOX,
  type FlightConfig,
  type FlightInput,
  type Hazard,
} from '@/systems/Flight';
import { Missions } from '@/systems/Missions';
import { Progression } from '@/systems/Progression';
import { engineVolume, runSkip, THROTTLES } from '@/systems/Flight';
import {
  FIELD_LANE_HALF_WIDTH,
  FIELD_ROCK_RADIUS,
  fieldLaneX,
  ROCK_SALVAGE_OIL,
  ROCK_SALVAGE_PER_TRIP,
  type FlightPhase,
} from '@/systems/Flight';

const DT = 1 / 60;

const PILOT: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
};

/** A planet with an empty sky: same id and scope, hazards stay the test's own. */
function quietPlanet(base: PlanetDef, travelSeconds: number): PlanetDef {
  return { ...base, travelSeconds, flight: { asteroidDensity: 0, waves: ['cinder4_flight'], ionStorm: false } };
}

/** The base planet's waves without its asteroids, so timing is deterministic. */
function wavesOnly(base: PlanetDef): PlanetDef {
  return { ...base, flight: { ...base.flight, asteroidDensity: 0, ionStorm: false } };
}

interface World {
  save: Save;
  events: EventBus<GameEvents>;
  progression: Progression;
  economy: Economy;
  missions: Missions;
  flight: Flight;
  of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]>;
}

interface WorldOptions {
  planet?: PlanetDef;
  ship?: Partial<Save['ship']>;
  aria?: { level: 1 | 2 | 3; enabled: boolean } | null;
  difficulty?: Difficulty;
  accept?: MissionId[];
  seed?: number;
  /** SPEC-039 §4.3: the pilot's companionMult, as the flight scene passes it. */
  companionMult?: number;
  /** SPEC-058 §4.4: the save's iteration, as the flight scene passes it. */
  iteration?: number;
  /** SPEC-066 §4.9: `visits === 0`, as the flight scene passes it. */
  firstTrip?: boolean;
  /** The quality preset; medium when absent. */
  quality?: FlightConfig['quality'];
}

function world(options: WorldOptions = {}): World {
  const save = newSave(0, { ...PILOT, difficulty: options.difficulty ?? 'normal' }, 42, 1_700_000_000_000);
  Object.assign(save.ship, options.ship ?? {});
  if (options.aria === null) save.companions = [];
  else if (options.aria !== undefined) save.companions = [{ id: 'aria', ...options.aria }];
  for (const id of options.accept ?? []) save.progress.missionsActive.push({ id, stage: 0, counters: {} });

  const events = new EventBus<GameEvents>({ dev: false });
  const emitted: Array<{ name: string; payload: unknown }> = [];
  events.onAny((name, payload) => emitted.push({ name: name as string, payload }));
  const progression = new Progression(save, events);
  const economy = new Economy(save, events, progression);
  const planet = options.planet ?? PLANETS.cinder4;
  const missions = new Missions(save, economy, events, 'flight', planet.id);
  const cfg: FlightConfig = {
    planet,
    ship: save.ship,
    companions: save.companions,
    quality: options.quality ?? QUALITY.medium,
    difficulty: save.meta.difficulty,
    ...(options.companionMult === undefined ? {} : { companionMult: options.companionMult }),
    ...(options.iteration === undefined ? {} : { iteration: options.iteration }),
    ...(options.firstTrip === undefined ? {} : { firstTrip: options.firstTrip }),
  };
  const flight = new Flight(cfg, economy, progression, missions, events, new Rng(options.seed ?? 7));
  return {
    save,
    events,
    progression,
    economy,
    missions,
    flight,
    of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]> {
      return emitted.filter((entry) => entry.name === name).map((entry) => entry.payload as GameEvents[K]);
    },
  };
}

const IDLE: FlightInput = { steerX: 0, steerY: 0, fire: false, aimX: 0, aimY: 0, throttleUp: false, throttleDown: false };

/** Step `seconds` of fixed updates; per-step overrides win over `input`. */
function step(flight: Flight, seconds: number, input: Partial<FlightInput> = {}): void {
  const frame: FlightInput = { ...IDLE, ...input };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    flight.update(DT, frame);
    // Throttle presses are edges: one notch, not one per frame.
    frame.throttleUp = false;
    frame.throttleDown = false;
  }
}

/** A hand-placed hazard; the pool recycles, so every field is overwritten. */
function inject(flight: Flight, fields: Partial<Hazard> & Pick<Hazard, 'kind' | 'depth'>): Hazard {
  const hazard = flight.hazards.alloc();
  Object.assign(hazard, {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    vDepth: 0,
    radius: 1,
    hp: 1,
    def: undefined,
    elite: false,
    ttl: undefined,
    fireCooldown: undefined,
    pattern: undefined,
    holdDepth: undefined,
    hitFlash: 0,
    burstLeft: undefined,
    burstAt: undefined,
    shotDamage: undefined,
  });
  return Object.assign(hazard, fields);
}

/** A fighter that neither fires nor leaves: it descends forever, blocking arrival. */
function blocker(flight: Flight): Hazard {
  return inject(flight, {
    kind: 'fighter',
    depth: 60,
    def: ENEMIES.scav_fighter,
    radius: ENEMIES.scav_fighter.radius,
    hp: ENEMIES.scav_fighter.hp,
    ttl: 1_000_000,
    holdDepth: -1_000_000,
  });
}

// ------------------------------------------------------- duration & throttle

describe('duration by engine tier and throttle', () => {
  it('pins cinder4: 90 s at tier 0 / throttle 1', () => {
    expect(world().flight.duration()).toBe(90);
  });

  it('pins cinder4: 90 / 1.15 at tier 1', () => {
    expect(world({ ship: { engine: 1 } }).flight.duration()).toBeCloseTo(90 / 1.15, 10);
  });

  it('pins cinder4: 75 s at throttle 1.2', () => {
    const { flight } = world();
    step(flight, DT, { throttleUp: true });
    expect(flight.ship.throttle).toBe(1.2);
    expect(flight.duration()).toBe(75);
  });

  it('flies the whole pinned trip: launch 3 s, cruise 90 s, arrived', () => {
    const w = world();
    step(w.flight, LAUNCH_SECONDS - DT);
    expect(w.flight.phase).toBe('launch');
    step(w.flight, 2 * DT);
    expect(w.flight.phase).toBe('cruise');
    step(w.flight, 90 + DT);
    expect(w.flight.phase).toBe('arrived');
    expect(w.of('flight:arrived')).toEqual([{ planet: 'cinder4' }]);
    expect(w.flight.time).toBeCloseTo(LAUNCH_SECONDS + 90, 0);
  });

  // Review 2026-10, B-03: the flight scene reads the throttle through
  // `PressEdges`, as the surface reads its presses. `justPressed` is a
  // per-frame latch, so a frame of two fixed steps (30 fps rAF, every frame on
  // a phone in Low Power Mode) once moved the throttle two notches per tap.
  it('one tap is one notch on a two-step frame: 0.8 → 1, not 1.2 (PressEdges)', () => {
    /** `Game.#frame` with the scene's own wiring: begin, N steps, end. */
    function frames(flight: Flight, direct: boolean): (steps: number) => void {
      const input = new Input();
      const edges = new PressEdges();
      let frame = 0;
      const tap = (steps: number): void => {
        input.beginFrame(1 / 30);
        for (let i = 0; i < steps; i++) {
          edges.beginStep(input.state.buttons, frame);
          const buttons = input.state.buttons;
          flight.update(DT, {
            ...IDLE,
            throttleUp: direct ? buttons.throttleUp.justPressed : edges.pressed('throttleUp'),
            throttleDown: direct ? buttons.throttleDown.justPressed : edges.pressed('throttleDown'),
          });
        }
        input.endFrame(steps > 0);
        frame++;
      };
      return (steps: number): void => {
        input.pressAction('throttleDown', 'touch');
        tap(steps);
        input.releaseAction('throttleDown', 'touch');
        tap(1);
        expect(flight.ship.throttle).toBe(0.8);
        input.pressAction('throttleUp', 'touch');
        tap(steps);
        input.releaseAction('throttleUp', 'touch');
        tap(1);
      };
    }

    const sampled = world().flight;
    step(sampled, LAUNCH_SECONDS + DT);
    frames(sampled, false)(2);
    expect(sampled.ship.throttle).toBe(1);

    // The latch read straight off the buttons is the hazard PressEdges exists for.
    const direct = world().flight;
    step(direct, LAUNCH_SECONDS + DT);
    frames(direct, true)(1);
    expect(direct.ship.throttle).toBe(1);
    frames(direct, true)(2);
    expect(direct.ship.throttle).toBe(1.2);
  });

  it('lerps a throttle change in over one second, not instantly (AC-55)', () => {
    const { flight } = world();
    step(flight, LAUNCH_SECONDS + DT);
    step(flight, DT, { throttleUp: true });
    expect(flight.ship.throttle).toBe(1.2);
    expect(flight.throttleLive).toBeLessThan(1.01);
    step(flight, 0.5);
    expect(flight.throttleLive).toBeGreaterThan(1.05);
    expect(flight.throttleLive).toBeLessThan(1.15);
    step(flight, 0.6);
    expect(flight.throttleLive).toBeCloseTo(1.2, 5);
  });

  it('scales fighter approach and interceptor dive with the throttle (AC-56)', () => {
    const w = world({ planet: quietPlanet(PLANETS.hive, 300) });
    step(w.flight, LAUNCH_SECONDS + DT);
    // A fighter still approaching (25/s) and an already-aimed diving interceptor (55/s).
    const fighter = inject(w.flight, {
      kind: 'fighter',
      depth: 90,
      def: ENEMIES.scav_fighter,
      radius: ENEMIES.scav_fighter.radius,
      hp: ENEMIES.scav_fighter.hp,
      ttl: 1_000,
      holdDepth: 5,
      fireCooldown: 1_000,
      vDepth: -25,
    });
    const interceptor = inject(w.flight, {
      kind: 'interceptor',
      depth: 160,
      x: 4,
      y: 3,
      vx: -1,
      vy: -1,
      vDepth: -55,
      def: ENEMIES.hive_interceptor,
      radius: ENEMIES.hive_interceptor.radius,
      hp: ENEMIES.hive_interceptor.hp,
      pattern: 1, // already re-aimed
    });
    step(w.flight, DT, { throttleUp: true });
    step(w.flight, 1.1); // the lerp completes at one notch per second
    expect(w.flight.throttleLive).toBeCloseTo(1.2, 5);
    expect(fighter.vDepth).toBeCloseTo(-25 * 1.2, 3);
    // The interceptor scales its whole dive vector, so the aim line holds.
    expect(interceptor.vDepth).toBeCloseTo(-55 * 1.2, 3);
    expect(interceptor.vx).toBeCloseTo(-1 * 1.2, 3);
    expect(interceptor.vy).toBeCloseTo(-1 * 1.2, 3);
  });
});

// ----------------------------------------------------------------- steering

describe('steering', () => {
  it('accelerates, caps at lateralSpeed, and damps by e^(−6 dt) (AC-57, AC-58)', () => {
    const { flight } = world();
    step(flight, 1, { steerX: 1 });
    expect(flight.ship.vx).toBeCloseTo(RAIL.lateralSpeed, 1);
    const before = flight.ship.vx;
    step(flight, DT);
    expect(flight.ship.vx).toBeCloseTo(before * Math.exp(-6 * DT), 5);
  });

  it('clamps to the plane with a soft bounce (velocity × −0.3) (AC-59)', () => {
    const { flight } = world();
    step(flight, 3, { steerX: 1 });
    expect(flight.ship.x).toBe(PLANE.halfW);
    expect(flight.ship.vx).toBeLessThanOrEqual(0);
  });

  it('banks at −vx / lateralSpeed × 35° (AC-61)', () => {
    const { flight } = world();
    step(flight, 1, { steerX: 1 });
    expect(flight.ship.bank).toBeCloseTo((-flight.ship.vx / RAIL.lateralSpeed) * 35, 5);
  });

  it('mouse steer accelerates by clamp((reticle − ship) / 4) (AC-60)', () => {
    // Far reticle: (8 − 0) / 4 clamps to 1 — full deflection.
    const far = world().flight;
    step(far, 2 * DT, { mouseSteer: true, aimX: 8, aimY: 0 });
    expect(far.ship.vx).toBeCloseTo(2 * DT * RAIL.lateralAccel, 1);
    // Near reticle: (1 − 0) / 4 = 0.25 — a quarter of it.
    const near = world().flight;
    step(near, 2 * DT, { mouseSteer: true, aimX: 1, aimY: 0 });
    expect(near.ship.vx).toBeCloseTo(2 * DT * RAIL.lateralAccel * 0.25, 1);
    // And the chase actually moves the ship toward the reticle.
    step(far, 2, { mouseSteer: true, aimX: 8, aimY: 0 });
    expect(far.ship.x).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------- asteroids

describe('asteroid collision', () => {
  it('collides at hitDepth for round(10 × radius) through the shield (AC-6)', () => {
    const w = world();
    step(w.flight, LAUNCH_SECONDS + DT);
    inject(w.flight, { kind: 'asteroid', depth: RAIL.hitDepth + 0.5, vDepth: -60, radius: 2.4, hp: 36 });
    step(w.flight, 3 * DT);
    const hits = w.of('ship:damaged');
    expect(hits.length).toBe(1);
    expect(hits[0]).toEqual({ shield: w.flight.ship.maxShield - 24, hull: w.flight.ship.maxHull, source: 'asteroid' });
  });

  it('does not collide when passing beside, and is removed past depth −5 (AC-66)', () => {
    const w = world();
    step(w.flight, LAUNCH_SECONDS + DT);
    inject(w.flight, { kind: 'asteroid', depth: RAIL.hitDepth + 0.5, vDepth: -60, radius: 2, hp: 30, x: 6, y: 0 });
    const before = w.flight.hazards.size;
    step(w.flight, 0.5);
    expect(w.of('ship:damaged')).toEqual([]);
    expect(w.flight.hazards.size).toBeLessThan(before);
  });

  it('spawns with the pinned stats: radius float(1,4), hp round(radius × 15), drift ≤ 1.5 (AC-63 … AC-65)', () => {
    const { flight } = world();
    for (let i = 0; i < 200; i++) {
      const rock = flight.spawnAsteroid();
      expect(rock.radius).toBeGreaterThanOrEqual(1);
      expect(rock.radius).toBeLessThan(4);
      expect(rock.hp).toBe(Math.round(rock.radius * 15));
      expect(rock.depth).toBe(RAIL.spawnDepth);
      expect(rock.vDepth).toBeLessThanOrEqual(-RAIL.baseSpeed);
      expect(rock.vDepth).toBeGreaterThan(-(RAIL.baseSpeed + 15));
      expect(Math.abs(rock.vx)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(rock.vy)).toBeLessThanOrEqual(1.5);
    }
  });
});

describe('spawn bias', () => {
  it('puts ≥ 60 % of 1,000 asteroids inside the threat box (AC-4, AC-112)', () => {
    const { flight } = world();
    let inside = 0;
    for (let i = 0; i < 1000; i++) {
      const rock = flight.spawnAsteroid();
      if (Math.abs(rock.x - flight.ship.x) <= THREAT_BOX && Math.abs(rock.y - flight.ship.y) <= THREAT_BOX) inside++;
      flight.hazards.clear();
    }
    expect(inside).toBeGreaterThanOrEqual(600);
  });
});

// ------------------------------------------------------------------- damage

describe('damage, shield, hull', () => {
  it('routes shield → hull and regenerates at the ARIA rate after 3 s (AC-13, AC-14)', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 90), aria: { level: 1, enabled: true } });
    step(w.flight, LAUNCH_SECONDS + DT);
    w.flight.hit(50, 'enemy', { kind: 'enemy', enemyId: 'scav_fighter' });
    expect(w.flight.ship.shield).toBe(0);
    expect(w.flight.ship.hull).toBe(w.flight.ship.maxHull - 10);
    step(w.flight, TUNING.SHIELD_REGEN_DELAY - 0.5);
    expect(w.flight.ship.shield).toBe(0); // still inside the delay
    step(w.flight, 2.5);
    // 2 s of regen at level-1 ARIA's 2/s.
    expect(w.flight.ship.shield).toBeCloseTo(4, 0);
    expect(w.flight.ship.hull).toBe(w.flight.ship.maxHull - 10); // hull never regenerates (AC-17)
  });

  it('does not regenerate with ARIA disabled (AC-16)', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 90), aria: { level: 1, enabled: false } });
    step(w.flight, LAUNCH_SECONDS + DT);
    w.flight.hit(10, 'enemy', { kind: 'enemy', enemyId: 'scav_fighter' });
    step(w.flight, 10);
    expect(w.flight.ship.shield).toBe(w.flight.ship.maxShield - 10);
  });

  it('applies ×0.7 on casual (AC-18)', () => {
    const w = world({ difficulty: 'casual' });
    step(w.flight, LAUNCH_SECONDS + DT);
    w.flight.hit(20, 'asteroid', { kind: 'asteroid' });
    expect(w.flight.ship.shield).toBe(w.flight.ship.maxShield - 14);
  });

  it('setDifficulty moves the next hit, both ways (SPEC-038 §4.6)', () => {
    const w = world({ difficulty: 'normal' });
    step(w.flight, LAUNCH_SECONDS + DT);
    w.flight.setDifficulty('casual');
    w.flight.hit(20, 'asteroid', { kind: 'asteroid' });
    expect(w.flight.ship.shield).toBe(w.flight.ship.maxShield - 14);
    w.flight.setDifficulty('normal');
    w.flight.hit(10, 'asteroid', { kind: 'asteroid' });
    expect(w.flight.ship.shield).toBe(w.flight.ship.maxShield - 24);
  });

  it('hard multiplies incoming damage by 1.3, from the config and from setDifficulty (SPEC-043 §4.4)', () => {
    const w = world({ difficulty: 'hard' });
    step(w.flight, LAUNCH_SECONDS + DT);
    w.flight.hit(20, 'enemy', { kind: 'enemy', enemyId: 'scav_fighter' });
    expect(w.flight.ship.shield).toBeCloseTo(w.flight.ship.maxShield - 26, 9);
    const v = world({ difficulty: 'normal' });
    step(v.flight, LAUNCH_SECONDS + DT);
    v.flight.setDifficulty('hard');
    v.flight.hit(10, 'asteroid', { kind: 'asteroid' });
    expect(v.flight.ship.shield).toBeCloseTo(v.flight.ship.maxShield - 13, 9);
  });

  it('story changes nothing on a hit and emits nothing, so damage never recalls the ship (SPEC-059 §4.2.2)', () => {
    const w = world({ difficulty: 'normal' });
    step(w.flight, LAUNCH_SECONDS + DT);
    w.flight.setDifficulty('story');
    const { shield, hull, shieldRegenAt } = w.flight.ship;
    const damaged = w.of('ship:damaged').length;
    w.flight.hit(30, 'asteroid', { kind: 'asteroid' });
    w.flight.hit(9999, 'enemy', { kind: 'enemy', enemyId: 'scav_fighter' });
    w.flight.hit(1, 'storm', { kind: 'storm' });
    expect(w.flight.ship.shield).toBe(shield);
    expect(w.flight.ship.hull).toBe(hull);
    expect(w.flight.ship.shieldRegenAt).toBe(shieldRegenAt);
    expect(w.flight.ship.alive).toBe(true);
    expect(w.of('ship:damaged')).toHaveLength(damaged);
    expect(w.of('player:died')).toEqual([]);
    expect(w.of('flight:recalled')).toEqual([]);
    // A story config is the same from its first hit.
    const v = world({ difficulty: 'story' });
    step(v.flight, LAUNCH_SECONDS + DT);
    v.flight.hit(30, 'asteroid', { kind: 'asteroid' });
    expect(v.flight.ship.shield).toBe(v.flight.ship.maxShield);
    expect(v.of('ship:damaged')).toEqual([]);
  });

  it('setDifficulty(\'normal\', 2) multiplies incoming damage by 1.15 — containment’s step (SPEC-058 §4.4)', () => {
    const w = world({ difficulty: 'normal' });
    step(w.flight, LAUNCH_SECONDS + DT);
    w.flight.setDifficulty('normal', 2);
    w.flight.hit(20, 'enemy', { kind: 'enemy', enemyId: 'scav_fighter' });
    expect(w.flight.ship.shield).toBeCloseTo(w.flight.ship.maxShield - 23, 9);
    // And back: the iteration defaults to 1.
    w.flight.setDifficulty('normal');
    w.flight.hit(10, 'asteroid', { kind: 'asteroid' });
    expect(w.flight.ship.shield).toBeCloseTo(w.flight.ship.maxShield - 33, 9);
  });

  it('the config’s iteration scales from the first hit, on top of the difficulty, capped at three steps (SPEC-058 §4.4)', () => {
    const w = world({ difficulty: 'hard', iteration: 2 });
    step(w.flight, LAUNCH_SECONDS + DT);
    w.flight.hit(20, 'enemy', { kind: 'enemy', enemyId: 'scav_fighter' });
    expect(w.flight.ship.shield).toBeCloseTo(w.flight.ship.maxShield - 20 * 1.3 * 1.15, 9);
    const v = world({ difficulty: 'normal', iteration: 9 });
    step(v.flight, LAUNCH_SECONDS + DT);
    v.flight.hit(10, 'asteroid', { kind: 'asteroid' });
    expect(v.flight.ship.shield).toBeCloseTo(v.flight.ship.maxShield - 10 * 1.15 ** 3, 9);
  });

  it('flight enemies keep their table HP on hard — only their hits change (SPEC-043 §2)', () => {
    // No ARIA and no trigger: nothing the ship does takes HP off a hazard.
    const w = world({ planet: PLANETS.hive, difficulty: 'hard', aria: null });
    const ships = (): { hp: number; table: number }[] => {
      const out: { hp: number; table: number }[] = [];
      for (let i = 0; i < w.flight.hazards.size; i++) {
        const hazard = w.flight.hazards.at(i);
        if (hazard.def !== undefined) out.push({ hp: hazard.hp, table: hazard.def.hp });
      }
      return out;
    };
    for (let t = 0; t < 180 && ships().length === 0; t++) step(w.flight, 1);
    expect(ships().length).toBeGreaterThan(0);
    for (const ship of ships()) expect(ship.hp).toBe(ship.table);
  });

  it('pins maxShield and maxHull to the upgrade tables with ARIA level 3 (AC-73, AC-74)', () => {
    const w = world({ ship: { shield: 2, hull: 3 }, aria: { level: 3, enabled: true } });
    expect(w.flight.ship.maxShield).toBe(UPGRADES.shield.metrics['shieldHp']![2]);
    expect(w.flight.ship.maxHull).toBeCloseTo(UPGRADES.hull.metrics['hullHp']![3] * 1.1, 10);
  });
});

describe('hull 0', () => {
  it('enters the recalled phase and emits player:died then flight:recalled (AC-19 … AC-24)', () => {
    const w = world({ accept: ['c5_m1'] });
    step(w.flight, LAUNCH_SECONDS + DT);
    w.save.resources.wheat = 120; // cargo aboard
    w.flight.hit(10_000, 'asteroid', { kind: 'asteroid' });
    expect(w.flight.phase).toBe('recalled');
    expect(w.flight.ship.alive).toBe(false);
    expect(w.of('player:died')).toEqual([{ cause: { kind: 'asteroid' }, scene: 'flight' }]);
    expect(w.of('flight:recalled')).toEqual([{ planet: 'cinder4' }]);
    expect(w.save.resources.wheat).toBe(120); // cargo kept (E5)
    // Dead ship: nothing advances any more.
    step(w.flight, 1);
    expect(w.flight.phase).toBe('recalled');
  });
});

// -------------------------------------------------------------------- waves

describe('waves, arrival and holding', () => {
  it('spawns groups at throttle-scaled seconds (AC-11)', () => {
    // Vetra: 2 fighters at 45 s of 110 s.
    const w = world({ planet: wavesOnly(PLANETS.vetra) });
    step(w.flight, LAUNCH_SECONDS + DT);
    step(w.flight, 44);
    expect(w.flight.hostiles).toBe(0);
    step(w.flight, 1.2);
    expect(w.flight.hostiles).toBe(2);

    // At throttle 1.2 the same group arrives near 45 / 1.2 ≈ 37.5 s (the first
    // second of the trip still lerps up through 1.0 … 1.2).
    const fast = world({ planet: wavesOnly(PLANETS.vetra) });
    step(fast.flight, LAUNCH_SECONDS + DT, { throttleUp: true });
    step(fast.flight, 36.5);
    expect(fast.flight.hostiles).toBe(0);
    step(fast.flight, 1.5);
    expect(fast.flight.hostiles).toBe(2);
  });

  it('lets fighters leave after their 25 s, not counted as killed (AC-67)', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 90) });
    step(w.flight, LAUNCH_SECONDS + DT);
    inject(w.flight, {
      kind: 'fighter',
      depth: 90,
      def: ENEMIES.scav_fighter,
      radius: ENEMIES.scav_fighter.radius,
      hp: ENEMIES.scav_fighter.hp,
      ttl: FIGHTER_LEAVE_SECONDS,
      holdDepth: 55,
      fireCooldown: FIGHTER_LEAVE_SECONDS + 5, // holds its fire for the whole stay
    });
    step(w.flight, FIGHTER_LEAVE_SECONDS - 1);
    expect(w.flight.hostiles).toBe(1);
    step(w.flight, 2);
    expect(w.flight.hostiles).toBe(0);
    expect(w.of('enemy:killed')).toEqual([]);
    expect(w.of('ship:damaged')).toEqual([]);
  });

  it('blocks landing while a wave enemy is alive, then lands when it clears (AC-25)', () => {
    const w = world({ planet: quietPlanet(PLANETS.hive, 20) });
    step(w.flight, LAUNCH_SECONDS + DT);
    blocker(w.flight);
    step(w.flight, 25);
    expect(w.flight.phase).toBe('holding');
    expect(w.of('flight:arrived')).toEqual([]);
    // Clear the sky: the next update lands.
    w.flight.hazards.clear();
    step(w.flight, 2 * DT);
    expect(w.flight.phase).toBe('arrived');
  });

  it('spawns a frac-1 group on the arrival frame instead of skipping it', () => {
    // Vetra's group at 45 s of a 45 s trip lands exactly on the frame progress
    // crosses 1: it must still spawn and hold the ship, not vanish unspawned.
    const w = world({ planet: { ...wavesOnly(PLANETS.vetra), travelSeconds: 45 } });
    step(w.flight, LAUNCH_SECONDS + 45 + 2 * DT);
    expect(w.flight.phase).toBe('holding');
    expect(w.flight.hostiles).toBe(2);
  });

  it('holds the landing while an accepted main flight mission is unfinished (E12, PLAN R16)', () => {
    // A 20 s Hive run cannot fit the gauntlet's 180 s survive — which is what
    // an upgraded engine does to the real 200 s trip (PLAN R16).
    const w = world({ planet: quietPlanet(PLANETS.hive, 20), accept: ['c5_m1'] });
    step(w.flight, LAUNCH_SECONDS + 22);
    w.flight.hazards.clear(); // an empty sky: the mission is the only hold left
    step(w.flight, 2 * DT);
    expect(w.flight.phase).toBe('holding');
    expect(w.of('flight:arrived')).toEqual([]);
    // Drop the mission and the same frame's check lets the ship down.
    w.missions.abandon('c5_m1');
    step(w.flight, 2 * DT);
    expect(w.flight.phase).toBe('arrived');
  });

  it('never holds a landing for a side flight mission (13-j)', () => {
    const w = world({ planet: quietPlanet(PLANETS.ferrum, 20), accept: ['c4_s2'] });
    step(w.flight, LAUNCH_SECONDS + 22);
    w.flight.hazards.clear();
    step(w.flight, 2 * DT);
    expect(w.flight.phase).toBe('arrived');
    // It stays accepted for the next trip out (13-g).
    expect(w.save.progress.missionsActive.map((m) => m.id)).toContain('c4_s2');
  });

  it('lands anyway at the 90 s cap with the main mission still open (13-k)', () => {
    const w = world({ planet: quietPlanet(PLANETS.hive, 20), accept: ['c5_m1'] });
    step(w.flight, LAUNCH_SECONDS + 22);
    w.flight.hazards.clear();
    step(w.flight, TUNING.HOLD_PATTERN_MAX_SECONDS + 2);
    expect(w.flight.phase).toBe('arrived');
    expect(w.save.progress.missionsActive.map((m) => m.id)).toContain('c5_m1');
  });

  it('caps the holding pattern at 90 s and lands anyway (AC-26)', () => {
    const w = world({ planet: quietPlanet(PLANETS.hive, 20) });
    step(w.flight, LAUNCH_SECONDS + DT);
    blocker(w.flight);
    step(w.flight, 20 + TUNING.HOLD_PATTERN_MAX_SECONDS - 2);
    expect(w.flight.phase).toBe('holding');
    step(w.flight, 4);
    expect(w.flight.phase).toBe('arrived');
    expect(w.flight.holdSeconds).toBeGreaterThanOrEqual(TUNING.HOLD_PATTERN_MAX_SECONDS);
  });
});

// ---------------------------------------------------------------- ram damage

// ------------------------------------------------------ SPEC-063 §4.5, §6.2

describe('flight:groupSpawned (SPEC-063 §4.5, §6.2)', () => {
  interface Trip {
    groups: Array<GameEvents['flight:groupSpawned']>;
    /** The step each event came on, and the step `hostiles` first rose above 0. */
    eventSteps: number[];
    firstHostileStep: number;
    phase: string;
  }

  /**
   * One trip at throttle 1, stepped a frame at a time until it lands. The hull
   * is topped up every step so a ram or a burst cannot end the trip early —
   * what is under test is which groups announce themselves, and when.
   */
  function flyToArrival(planet: PlanetDef): Trip {
    const w = world({ planet: wavesOnly(planet), ship: { engine: 0 } });
    const eventSteps: number[] = [];
    let firstHostileStep = -1;
    for (let i = 0; i < 600 / DT && w.flight.phase !== 'arrived' && w.flight.phase !== 'recalled'; i++) {
      const before = w.of('flight:groupSpawned').length;
      w.flight.update(DT, IDLE);
      w.flight.ship.hull = w.flight.ship.maxHull;
      if (w.of('flight:groupSpawned').length > before) eventSteps.push(i);
      if (firstHostileStep < 0 && w.flight.hostiles > 0) firstHostileStep = i;
    }
    return { groups: w.of('flight:groupSpawned'), eventSteps, firstHostileStep, phase: w.flight.phase };
  }

  it('a Vetra trip emits one, for its two scav fighters, on the step the hostiles first rise', () => {
    const trip = flyToArrival(PLANETS.vetra);
    expect(trip.phase).toBe('arrived');
    expect(trip.groups).toEqual([{ enemy: 'scav_fighter', count: 2 }]);
    expect(trip.firstHostileStep).toBeGreaterThan(0);
    expect(trip.eventSteps).toEqual([trip.firstHostileStep]);
  });

  it('a Cinder-4 trip emits none', () => {
    const trip = flyToArrival(PLANETS.cinder4);
    expect(trip.phase).toBe('arrived');
    expect(trip.groups).toEqual([]);
  });

  it('a Hive trip emits five, in the table’s order: 4, 6, 6, 8 and 6 interceptors', () => {
    const trip = flyToArrival(PLANETS.hive);
    expect(trip.phase).toBe('arrived');
    expect(trip.groups).toEqual([4, 6, 6, 8, 6].map((count) => ({ enemy: 'hive_interceptor', count })));
    expect(trip.eventSteps).toHaveLength(5);
    expect(trip.eventSteps[0]).toBe(trip.firstHostileStep);
  });
});

describe('interceptor ram', () => {
  it('rams at hitDepth for a flat 15 through the shield (AC-10)', () => {
    const w = world({ planet: quietPlanet(PLANETS.hive, 300) });
    step(w.flight, LAUNCH_SECONDS + DT);
    // Aimed dead-on and past the re-aim depth: the next half second rams.
    inject(w.flight, {
      kind: 'interceptor',
      depth: 10,
      vDepth: -55,
      def: ENEMIES.hive_interceptor,
      radius: ENEMIES.hive_interceptor.radius,
      hp: ENEMIES.hive_interceptor.hp,
      pattern: 1,
    });
    step(w.flight, 0.5);
    expect(w.flight.hostiles).toBe(0); // the interceptor dies with the ram
    // AC-10 pins the flat 15 — not ENEMIES.hive_interceptor.damage (34), which
    // SPEC-009's chapter scaling owns, nor the 12 §4.4 annotates.
    expect(w.flight.ship.shield).toBe(w.flight.ship.maxShield - 15);
    expect(w.flight.ship.hull).toBe(w.flight.ship.maxHull);
    expect(w.of('ship:damaged').at(-1)).toEqual({ shield: w.flight.ship.maxShield - 15, hull: w.flight.ship.maxHull, source: 'enemy' });
    expect(w.of('enemy:killed')).toEqual([]); // a ram is not a player kill
  });
});

// -------------------------------------------------------------------- shots

describe('shot sweep', () => {
  it('hits a fighter at depth 60 and pays the kill (AC-110, AC-12, AC-69)', () => {
    const w = world();
    step(w.flight, LAUNCH_SECONDS + DT);
    inject(w.flight, {
      kind: 'fighter',
      depth: 60,
      def: ENEMIES.scav_fighter,
      radius: ENEMIES.scav_fighter.radius,
      hp: 5,
      ttl: 30,
      holdDepth: 40, // approaching straight down the middle — no strafe yet
    });
    const xpBefore = w.save.player.xp;
    step(w.flight, 1.5, { fire: true, aimX: 0, aimY: 0 });
    const killed = w.of('enemy:killed');
    expect(killed.length).toBe(1);
    expect(killed[0]!.enemyId).toBe('scav_fighter');
    expect(killed[0]!.xp).toBe(ENEMIES.scav_fighter.xp);
    expect(w.save.player.xp).toBe(xpBefore + ENEMIES.scav_fighter.xp);
  });

  // Review 2026-10 (G-20): flight kills paid XP only — `flight_salvage` was
  // never rolled.
  describe('salvage (review 2026-10, G-20)', () => {
    /** Shoot down `count` weak fighters, one at a time, straight ahead. */
    const downFighters = (w: World, count: number): void => {
      for (let i = 0; i < count; i++) {
        inject(w.flight, {
          kind: 'fighter',
          depth: 60,
          def: ENEMIES.scav_fighter,
          radius: ENEMIES.scav_fighter.radius,
          hp: 5,
          ttl: 30,
          holdDepth: 40,
        });
        const before = w.of('enemy:killed').length;
        for (let t = 0; t < 3 && w.of('enemy:killed').length === before; t += DT) step(w.flight, DT, { fire: true, aimX: 0, aimY: 0 });
        expect(w.of('enemy:killed').length).toBe(before + 1);
      }
    };

    it('a downed ship rolls flight_salvage into the hold as a pickup: oil and lithium, in the table\'s ranges', () => {
      const w = world();
      step(w.flight, LAUNCH_SECONDS + DT);
      const oil = w.save.resources.oil;
      const lithium = w.save.resources.lithium;
      downFighters(w, 12);
      const salvage = w.of('resource:collected');
      expect(salvage.length).toBeGreaterThan(0);
      for (const drop of salvage) {
        expect(drop.source).toBe('pickup');
        expect(['oil', 'lithium']).toContain(drop.resource);
      }
      const gotOil = w.save.resources.oil - oil;
      const gotLithium = w.save.resources.lithium - lithium;
      expect(gotOil).toBeGreaterThan(0);
      expect(gotOil).toBeLessThanOrEqual(12 * 3);
      expect(gotLithium).toBeLessThanOrEqual(12 * 2);
      expect(gotOil + gotLithium).toBe(salvage.reduce((sum, drop) => sum + drop.amount, 0));
    });

    it('the cargo cap applies: a full hold takes nothing', () => {
      const w = world();
      const cap = w.economy.cargoCap();
      w.save.resources.oil = cap;
      w.save.resources.lithium = cap;
      step(w.flight, LAUNCH_SECONDS + DT);
      downFighters(w, 12);
      expect(w.save.resources.oil).toBe(cap);
      expect(w.save.resources.lithium).toBe(cap);
      expect(w.of('resource:collected').length).toBeGreaterThan(0);
      for (const drop of w.of('resource:collected')) expect(drop.blocked).toBe('cargo_full');
    });
  });

  /**
   * SPEC-034 §4.3, §6.1 — the tunnelling case.
   *
   * The sweep tested the hazard's *current* depth against `[from, to]`, the
   * segment the shot travelled. A hazard closing at its own `vDepth` can cross
   * that segment from the other side within the same step and be tested at
   * neither end of it, so a third of perfectly aimed shots at a diving
   * interceptor passed straight through — which is why `c5_m1` cleared in 0 of 8
   * simulated runs with any ship. The gap closes from both ends now.
   */
  function tunnelHits(kind: 'interceptor' | 'asteroid'): number {
    let hits = 0;
    for (let shot = 0; shot < 400; shot++) {
      const w = world({ planet: quietPlanet(PLANETS.hive, 300), seed: 1000 + shot });
      step(w.flight, LAUNCH_SECONDS + DT);
      // A target diving from 150 m straight down the middle, out of reach of the
      // ship itself for the whole flight of one shot. Its HP is raised so the
      // count is of *hits*, not of kills.
      const depth = 150 - (shot % 40) * 0.25; // a different phase every shot
      const hazard =
        kind === 'interceptor'
          ? inject(w.flight, {
              kind: 'interceptor',
              depth,
              def: ENEMIES.hive_interceptor,
              radius: ENEMIES.hive_interceptor.radius,
              hp: 10_000,
              vDepth: -55,
            })
          : inject(w.flight, { kind: 'asteroid', depth, radius: 2, hp: 10_000, vDepth: -60 });
      const hpBefore = hazard.hp;
      // Perfect lead: where the target will be when the shot reaches it.
      step(w.flight, DT, { fire: true, aimX: 0, aimY: 0 });
      // Long enough for the shot and the target to meet, whatever the phase.
      step(w.flight, 2, { aimX: 0, aimY: 0 });
      if (hazard.hp < hpBefore) hits++;
    }
    return hits;
  }

  it('0 of 400 perfectly aimed shots pass through a closing interceptor (SPEC-034 §4.3)', () => {
    expect(tunnelHits('interceptor')).toBe(400);
  });

  it('…and none through a closing asteroid either', () => {
    expect(tunnelHits('asteroid')).toBe(400);
  });

  it('alternates two guns at the weapon fire rate (AC-28)', () => {
    const w = world();
    step(w.flight, LAUNCH_SECONDS + DT);
    step(w.flight, 2 * DT, { fire: true });
    expect(w.flight.shots.size).toBe(1);
    const first = w.flight.shots.at(0).x;
    step(w.flight, 1 / (UPGRADES.weapon.metrics['fireRate']![0] as number), { fire: true });
    expect(w.flight.shots.size).toBe(2);
    // One gun each side of the nose.
    expect(Math.sign(w.flight.shots.at(1).x)).toBe(-Math.sign(first));
  });
});

// --------------------------------------------------------------- aim assist

describe('aim assist', () => {
  it('snaps only to the nearest ship in the 6° cone, never an asteroid (AC-30, AC-31, AC-111)', () => {
    const w = world({ aria: { level: 2, enabled: true } });
    step(w.flight, LAUNCH_SECONDS + DT);
    // Nearest ship right of center, a farther ship left, an asteroid dead ahead.
    inject(w.flight, { kind: 'fighter', depth: 50, x: 2, def: ENEMIES.scav_fighter, radius: 1.2, hp: 98, ttl: 30, holdDepth: 40 });
    inject(w.flight, { kind: 'fighter', depth: 100, x: -2, def: ENEMIES.scav_fighter, radius: 1.2, hp: 98, ttl: 30, holdDepth: 40 });
    inject(w.flight, { kind: 'asteroid', depth: 30, x: 0, radius: 3, hp: 45, vDepth: 0 });
    w.flight.update(DT, { ...IDLE });
    // Toward the near fighter's projection (positive x), not the far one's.
    expect(w.flight.reticle.x).toBeGreaterThan(0.5);
  });

  it('ignores ships outside the cone', () => {
    const w = world({ aria: { level: 2, enabled: true } });
    step(w.flight, LAUNCH_SECONDS + DT);
    inject(w.flight, { kind: 'fighter', depth: 60, x: 8, def: ENEMIES.scav_fighter, radius: 1.2, hp: 98, ttl: 30, holdDepth: 40 });
    w.flight.update(DT, { ...IDLE, aimX: 0.5, aimY: -0.25 });
    expect(w.flight.reticle).toEqual({ x: 0.5, y: -0.25 });
  });

  it('does not move the reticle below ARIA level 2, but still keys auto-fire (AC-32)', () => {
    const w = world({ aria: { level: 1, enabled: true } });
    step(w.flight, LAUNCH_SECONDS + DT);
    inject(w.flight, { kind: 'fighter', depth: 50, x: 1, def: ENEMIES.scav_fighter, radius: 1.2, hp: 98, ttl: 30, holdDepth: 40 });
    step(w.flight, 2 * DT, { autoFire: true });
    expect(w.flight.reticle).toEqual({ x: 0, y: 0 });
    expect(w.flight.shots.size).toBeGreaterThan(0);
  });

  it('auto-fires on an asteroid within 3 m of the ship (AC-82)', () => {
    const w = world();
    step(w.flight, LAUNCH_SECONDS + DT);
    inject(w.flight, { kind: 'asteroid', depth: 100, x: 2, y: 0, radius: 2, hp: 30, vDepth: 0 });
    step(w.flight, 2 * DT, { autoFire: true });
    expect(w.flight.shots.size).toBeGreaterThan(0);
    const idle = world();
    step(idle.flight, LAUNCH_SECONDS + 2 * DT, { autoFire: true });
    expect(idle.flight.shots.size).toBe(0);
  });
});

// -------------------------------------------------------------------- storm

describe('ion storms', () => {
  it('opens 15–25 s windows, blocks regen, and ticks 1 hull per 5 s at shield 0 (AC-50, AC-51, AC-15, AC-71)', () => {
    const storms: PlanetDef = {
      ...PLANETS.ferrum,
      flight: { asteroidDensity: 0, waves: ['cinder4_flight'], ionStorm: true },
    };
    const w = world({ planet: storms, ship: { shield: 2 }, aria: { level: 1, enabled: true } });
    step(w.flight, LAUNCH_SECONDS + DT);
    // §4.5: the first window opens 40–70 s in.
    let waited = 0;
    while (!w.flight.stormActive && waited < 75) {
      step(w.flight, 1);
      waited += 1;
    }
    expect(w.flight.stormActive).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(39);

    // Shield to zero: regen stays blocked, the storm ticks the hull.
    w.flight.hit(w.flight.ship.maxShield, 'enemy', { kind: 'enemy', enemyId: 'scav_fighter' });
    expect(w.flight.ship.shield).toBe(0);
    const hull = w.flight.ship.hull;
    step(w.flight, 5.5);
    if (w.flight.stormActive) {
      expect(w.flight.ship.shield).toBe(0); // AC-15: no regen in a storm
      const storm = w.of('ship:damaged').filter((hit) => hit.source === 'storm');
      expect(storm.length).toBeGreaterThanOrEqual(1);
      expect(w.flight.ship.hull).toBeLessThan(hull);
    }

    // The window closes within 25 s of opening.
    step(w.flight, 26);
    expect(w.flight.stormActive).toBe(false);
  });

  it('never storms on a planet without ionStorm', () => {
    const w = world();
    step(w.flight, LAUNCH_SECONDS + 80);
    expect(w.flight.stormActive).toBe(false);
  });
});

// ----------------------------------------------------------------- missions

describe('missions in flight', () => {
  it('runs only accepted missions matching the scene and planet (AC-84)', () => {
    const w = world({ planet: quietPlanet(PLANETS.hive, 30), accept: ['c5_m1', 'c4_s2', 'c1_m1'] });
    expect(w.missions.active.map((m) => m.id)).toEqual(['c5_m1']);
  });

  it('counts survive through launch, cruise and holding (AC-88, AC-113)', () => {
    const w = world({ planet: quietPlanet(PLANETS.hive, 20), accept: ['c5_m1'] });
    step(w.flight, LAUNCH_SECONDS + DT);
    blocker(w.flight);
    step(w.flight, 30); // 20 s cruise + 10 s holding, after the 3 s launch
    expect(w.flight.phase).toBe('holding');
    // §4.8: the timer is flight time while alive — the launch seconds count.
    // It lives in `timers` (E19: counters persist, timers do not), so the
    // elapsed seconds are read through the runtime's progress view.
    const survive = w.missions.currentObjectives('c5_m1')[0]!;
    expect(survive.objective.kind).toBe('survive');
    expect(survive.value).toBeCloseTo(LAUNCH_SECONDS + 30, 0);
  });

  it('counts kills for the named enemy only (AC-113)', () => {
    const w = world({ planet: quietPlanet(PLANETS.hive, 300), accept: ['c5_m1'] });
    step(w.flight, LAUNCH_SECONDS + DT);
    w.events.emit('enemy:killed', { enemyId: 'scav_fighter', elite: false, x: 0, z: 0, xp: 12 });
    w.events.emit('enemy:killed', { enemyId: 'hive_interceptor', elite: false, x: 0, z: 0, xp: 10 });
    const entry = w.save.progress.missionsActive.find((m) => m.id === 'c5_m1')!;
    expect(entry.counters['0:1']).toBe(1);
  });

  it('pays completion immediately, then half on replay (AC-87)', () => {
    const w = world({ planet: PLANETS.ferrum, accept: ['c4_s2'] });
    const def = MISSIONS.c4_s2;
    const before = w.save.player.tokens;
    for (let i = 0; i < 8; i++) w.events.emit('enemy:killed', { enemyId: 'scav_fighter', elite: false, x: 0, z: 0, xp: 12 });
    expect(w.of('mission:completed')).toEqual([{ id: 'c4_s2', replay: false }]);
    expect(w.save.progress.missionsDone).toContain('c4_s2');
    expect(w.save.progress.missionsActive.find((m) => m.id === 'c4_s2')).toBeUndefined();
    expect(w.save.player.tokens).toBeGreaterThanOrEqual(before + def.rewards.tokens);

    // Replay at 50 % (SPEC-010 §4.7): re-accept, complete again. The runtime
    // owns its own state, so the second run goes through `accept` — a raw push
    // into the save is not an acceptance — and that is the path the station
    // takes anyway. `c4_s2` requires `c4_m1`, which the first flight implies.
    w.save.progress.missionsDone.push('c4_m1');
    expect(w.missions.accept('c4_s2')).toEqual({ ok: true });
    const replayBefore = w.save.player.tokens;
    for (let i = 0; i < 8; i++) w.events.emit('enemy:killed', { enemyId: 'scav_fighter', elite: false, x: 0, z: 0, xp: 12 });
    expect(w.of('mission:completed').at(-1)).toEqual({ id: 'c4_s2', replay: true });
    expect(w.save.player.tokens).toBeGreaterThanOrEqual(replayBefore + Math.floor(def.rewards.tokens * TUNING.REPLAY_REWARD_FRACTION));
  });

  it('finishes the gauntlet before the Hive at every engine tier (PLAN R16)', () => {
    // The bug this pins: the trip is `travelSeconds / speedMult / throttle`, so
    // an upgraded engine lands the ship long before `c5_m1`'s 180 s survive and
    // every Hive surface mission stays locked behind a mission that can no
    // longer be finished. No waves here — the hold under test is the mission's.
    const hive: PlanetDef = { ...PLANETS.hive, flight: { asteroidDensity: 0, waves: [], ionStorm: false } };
    for (const engine of [0, 1, 2, 3] as const) {
      const w = world({ planet: hive, ship: { engine }, accept: ['c5_m1'] });
      for (let i = 0; i < 10; i++) w.events.emit('enemy:killed', { enemyId: 'hive_interceptor', elite: false, x: 0, z: 0, xp: 0 });
      step(w.flight, 179); // one second short of the survive, on every tier
      expect(w.save.progress.missionsDone).not.toContain('c5_m1');
      expect(w.flight.phase).not.toBe('arrived');
      step(w.flight, 40); // past the slowest trip's remainder
      expect(w.save.progress.missionsDone).toContain('c5_m1');
      expect(w.flight.phase).toBe('arrived');
    }
  });

  it('resets stages on recall and keeps the missions accepted (AC-86, AC-103)', () => {
    const w = world({ planet: quietPlanet(PLANETS.hive, 300), accept: ['c5_m1'] });
    step(w.flight, LAUNCH_SECONDS + 10);
    w.events.emit('enemy:killed', { enemyId: 'hive_interceptor', elite: false, x: 0, z: 0, xp: 10 });
    const entry = w.save.progress.missionsActive.find((m) => m.id === 'c5_m1')!;
    expect(w.missions.currentObjectives('c5_m1')[0]!.value).toBeGreaterThan(5);
    expect(entry.counters['0:1']).toBe(1);
    w.flight.hit(10_000, 'asteroid', { kind: 'asteroid' });
    // E5 is a whole-stage reset, and exactly one — the scene asks for it, and
    // the runtime's own `player:died` rule (E4, surface) stays out of flight.
    // (The entry announces its own timed restart on load first, E19.)
    expect(w.of('mission:stageReset').filter((r) => r.reason === 'death')).toEqual([
      { id: 'c5_m1', stage: 0, reason: 'death' },
    ]);
    expect(w.missions.currentObjectives('c5_m1')[0]!.value).toBe(0);
    expect(entry.counters['0:1']).toBeUndefined();
    expect(w.save.progress.missionsActive.map((m) => m.id)).toContain('c5_m1');
  });

  it('restarts a loaded survive timer but keeps a loaded kill counter (E19)', () => {
    const save = newSave(0, PILOT, 42, 1_700_000_000_000);
    // E19: a part-run survive persists nothing — only the kill count does.
    save.progress.missionsActive.push({ id: 'c5_m1', stage: 0, counters: { '0:1': 4 } });
    const events = new EventBus<GameEvents>({ dev: false });
    const recorded: string[] = [];
    events.onAny((name) => recorded.push(name as string));
    const progression = new Progression(save, events);
    const economy = new Economy(save, events, progression);
    const missions = new Missions(save, economy, events, 'flight', 'hive');
    const entry = save.progress.missionsActive[0]!;
    expect(missions.currentObjectives('c5_m1')[0]!.value).toBe(0);
    expect(entry.counters['0:1']).toBe(4);
    // The timed stage announces its restart, so the HUD can say so.
    expect(recorded).toContain('mission:stageReset');
  });

  it('reports the longest live survive objective for the HUD hint (AC-89)', () => {
    const w = world({ planet: quietPlanet(PLANETS.hive, 300), accept: ['c5_m1'] });
    expect(w.missions.longestSurvive()).toBe(180);
    const line = w.missions.objective()!;
    expect(line.title).toBe(MISSIONS.c5_m1.title);
    expect(line.target).toBe(180);
  });
});

// ---------------------------------------------------------------- no elites

describe('flight enemies', () => {
  it('spawns no elites (AC-70)', () => {
    const w = world({ planet: PLANETS.ferrum, ship: { shield: 2 } });
    step(w.flight, LAUNCH_SECONDS + 25, { steerX: 1 });
    expect(w.flight.hostiles).toBeGreaterThan(0);
    for (let i = 0; i < w.flight.hazards.size; i++) {
      expect(w.flight.hazards.at(i).elite).not.toBe(true);
    }
  });
});

// ------------------------------------------------------------------ SPEC-032

describe('runSkip (SPEC-032 §4.3)', () => {
  const fresh = (): Save => newSave(0, PILOT, 42, 1_700_000_000_000);

  it('refuses a route that was never landed on', () => {
    const save = fresh();
    expect(runSkip(save, 'cinder4')).toEqual({ ok: false, reason: 'never_flown' });
    save.progress.visits.cinder4 = 0;
    expect(runSkip(save, 'cinder4')).toEqual({ ok: false, reason: 'never_flown' });
  });

  it('allows a route with a landing behind it', () => {
    const save = fresh();
    save.progress.visits.cinder4 = 2;
    expect(runSkip(save, 'cinder4')).toEqual({ ok: true });
  });

  it('refuses the run a flight mission for that planet is, by name', () => {
    const save = fresh();
    save.progress.visits.ferrum = 1;
    save.progress.visits.cinder4 = 1;
    save.progress.missionsActive.push({ id: 'c4_s2', stage: 0, counters: {} });
    expect(runSkip(save, 'ferrum')).toEqual({ ok: false, reason: 'flight_mission', mission: 'c4_s2' });
    // The same mission rides a different trip only.
    expect(runSkip(save, 'cinder4')).toEqual({ ok: true });
  });

  it('lets service mode override both refusals', () => {
    const save = fresh();
    expect(runSkip(save, 'eden', { service: true })).toEqual({ ok: true });
    save.progress.visits.ferrum = 1;
    save.progress.missionsActive.push({ id: 'c4_s2', stage: 0, counters: {} });
    expect(runSkip(save, 'ferrum', { service: true })).toEqual({ ok: true });
    expect(runSkip(save, 'ferrum', { service: false }).ok).toBe(false);
  });
});

describe('Flight.fastForward (SPEC-032 §4.5)', () => {
  it('reaches arrived inside the limit and emits flight:arrived exactly once', () => {
    const w = world();
    const limit = 1200;
    const simulated = w.flight.fastForward(limit);
    expect(w.flight.phase).toBe('arrived');
    expect(simulated).toBeLessThan(limit);
    expect(simulated).toBeGreaterThan(LAUNCH_SECONDS);
    expect(w.of('flight:arrived')).toEqual([{ planet: 'cinder4' }]);
    // Over: a second call simulates nothing and says nothing.
    expect(w.flight.fastForward(limit)).toBe(0);
    expect(w.of('flight:arrived')).toHaveLength(1);
  });

  it('counts survive timers through the same update steps a flown trip takes', () => {
    const w = world({ planet: quietPlanet(PLANETS.hive, 20), accept: ['c5_m1'] });
    const simulated = w.flight.fastForward(1200);
    expect(simulated).toBeGreaterThanOrEqual(20);
    const survive = w.missions.currentObjectives('c5_m1')[0]!;
    expect(survive.objective.kind).toBe('survive');
    expect(survive.value).toBeGreaterThanOrEqual(20);
  });

  it('stops at the limit when the trip is not over', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300) });
    const simulated = w.flight.fastForward(10);
    expect(simulated).toBeCloseTo(10, 1);
    expect(w.flight.phase).toBe('cruise');
  });

  it('does nothing to a recalled flight', () => {
    const w = world();
    step(w.flight, LAUNCH_SECONDS + 1);
    w.flight.hit(10_000, 'asteroid', { kind: 'asteroid' });
    expect(w.flight.phase).toBe('recalled');
    const time = w.flight.time;
    const progress = w.flight.progress;
    expect(w.flight.fastForward(1200)).toBe(0);
    expect(w.flight.phase).toBe('recalled');
    expect(w.flight.time).toBe(time);
    expect(w.flight.progress).toBe(progress);
    expect(w.of('flight:arrived')).toHaveLength(0);
  });
});

// ------------------------------------------------------ SPEC-035 §4.11: sound

describe('engineVolume (SPEC-035 §4.11)', () => {
  it('is 0.6 at the slowest notch, 0.8 at the middle and 1 at the fastest', () => {
    const [slow, mid, fast] = THROTTLES;
    expect(engineVolume(slow as number)).toBeCloseTo(0.6, 6);
    expect(engineVolume(mid as number)).toBeCloseTo(0.8, 6);
    expect(engineVolume(fast as number)).toBeCloseTo(1, 6);
  });

  it('clamps, so nothing outside the three notches pushes the voice past full', () => {
    expect(engineVolume(0.2)).toBeCloseTo(0.6, 6);
    expect(engineVolume(9)).toBeCloseTo(1, 6);
  });
});

describe('weapon:fired on the rail (SPEC-035 §4.11)', () => {
  it('emits one event per shot, with line "ship" and the gun it left', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 120) });
    step(w.flight, LAUNCH_SECONDS + 0.1);
    const before = w.of('weapon:fired').length;
    const shotsBefore = w.flight.shots.size;
    step(w.flight, 1, { fire: true });
    const fired = w.of('weapon:fired');
    expect(fired.length).toBeGreaterThan(before);
    expect(w.flight.shots.size).toBeGreaterThan(shotsBefore);
    for (const event of fired) expect(event.line).toBe('ship');
    // Two guns alternate, so consecutive shots leave from either side of centre.
    expect(new Set(fired.map((e) => e.x)).size).toBeGreaterThan(1);
  });

  it('emits nothing while the trigger is off', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 120) });
    step(w.flight, LAUNCH_SECONDS + 2);
    expect(w.of('weapon:fired')).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ SPEC-039

describe('ship guns and ARIA (SPEC-039 §4.3, §4.4, §4.5)', () => {
  /** Hits a guns tier needs on a real target, through the shot sweep. */
  function hitsToKill(kind: 'fighter' | 'interceptor', tier: 0 | 1 | 2 | 3): number {
    const w = world({ planet: quietPlanet(PLANETS.hive, 300), ship: { weapon: tier } });
    step(w.flight, LAUNCH_SECONDS + DT);
    const def = kind === 'fighter' ? ENEMIES.scav_fighter : ENEMIES.hive_interceptor;
    const hazard =
      kind === 'fighter'
        ? // Straight down the middle, never holding: every aimed shot connects.
          inject(w.flight, { kind, depth: 120, def, radius: def.radius, hp: def.hp, ttl: 60, holdDepth: -1_000_000 })
        : // Parked at the guns' convergence depth.
          inject(w.flight, { kind, depth: 80, def, radius: def.radius, hp: def.hp });
    let hits = 0;
    let hp = hazard.hp;
    for (let i = 0; i < 600; i++) {
      step(w.flight, DT, { fire: true, aimX: 0, aimY: 0 });
      if (w.of('enemy:killed').length > 0) return hits + 1;
      if (hazard.hp < hp) {
        hits++;
        hp = hazard.hp;
      }
    }
    return Number.POSITIVE_INFINITY;
  }

  it('Ship Guns tier 1 deals 14', () => {
    expect(UPGRADES.weapon.metrics['damage']).toEqual([10, 14, 17, 22]);
  });

  it('a scav fighter takes 4 hits at tier 0, 3 at tiers 1 and 2, and 2 at tier 3', () => {
    expect(ENEMIES.scav_fighter.hp).toBe(40);
    expect(([0, 1, 2, 3] as const).map((tier) => hitsToKill('fighter', tier))).toEqual([4, 3, 3, 2]);
  });

  it('an interceptor takes 2 hits until tier 3, which kills it in 1', () => {
    expect(ENEMIES.hive_interceptor.hp).toBe(20);
    expect(([0, 1, 2, 3] as const).map((tier) => hitsToKill('interceptor', tier))).toEqual([2, 2, 2, 1]);
  });

  it('the carry: 600 held steps fire exactly 40 shots at tier 0 and 50 at tier 2', () => {
    for (const [tier, shots] of [
      [0, 40],
      [2, 50],
    ] as const) {
      const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), ship: { weapon: tier } });
      step(w.flight, LAUNCH_SECONDS + DT);
      const before = w.of('weapon:fired').length;
      for (let i = 0; i < 600; i++) w.flight.update(DT, { ...IDLE, fire: true });
      expect(w.of('weapon:fired').length - before, `tier ${tier}`).toBe(shots);
    }
  });

  it('a released trigger banks at most one step', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300) });
    step(w.flight, LAUNCH_SECONDS + DT);
    step(w.flight, DT, { fire: true });
    step(w.flight, 10);
    expect(w.flight.ship.fireCooldown).toBeCloseTo(-1 / 60, 10);
  });

  it("ARIA's shield regeneration scales with companionMult", () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 90), aria: { level: 1, enabled: true }, companionMult: 2.25 });
    step(w.flight, LAUNCH_SECONDS + DT);
    w.flight.hit(50, 'enemy', { kind: 'enemy', enemyId: 'scav_fighter' });
    step(w.flight, TUNING.SHIELD_REGEN_DELAY + 2);
    // 2 s of regeneration at level-1 ARIA's 2/s × 2.25.
    expect(w.flight.ship.shield).toBeCloseTo(9, 0);
    // Absent, it is 1: the §4.6 rate.
    const plain = world({ planet: quietPlanet(PLANETS.cinder4, 90), aria: { level: 1, enabled: true } });
    step(plain.flight, LAUNCH_SECONDS + DT);
    plain.flight.hit(50, 'enemy', { kind: 'enemy', enemyId: 'scav_fighter' });
    step(plain.flight, TUNING.SHIELD_REGEN_DELAY + 2);
    expect(plain.flight.ship.shield).toBeCloseTo(4, 0);
  });

  it('companionMult never touches the hull bonus', () => {
    const scaled = world({ ship: { hull: 1 }, aria: { level: 3, enabled: true }, companionMult: 2.25 });
    const plain = world({ ship: { hull: 1 }, aria: { level: 3, enabled: true } });
    expect(scaled.flight.ship.maxHull).toBe(plain.flight.ship.maxHull);
  });
});

// ------------------------------------------------------------------ SPEC-041

/** The raw aim that puts `target` dead centre: its current projection to the convergence depth. */
function onTarget(flight: Flight, target: Hazard): Pick<FlightInput, 'aimX' | 'aimY'> {
  const ship = flight.ship;
  const scale = CONVERGE_DEPTH / target.depth;
  return { aimX: ship.x + (target.x - ship.x) * scale, aimY: ship.y + (target.y - ship.y) * scale };
}

/**
 * A fighter crossing the view: 60 m out, closing at 25 m/s and sliding at
 * (6, −1.5) m/s — it never reaches a hold depth, so nothing resets its slide.
 * Its HP is raised so a case counts hits, not kills.
 */
function crossing(flight: Flight): Hazard {
  return inject(flight, {
    kind: 'fighter',
    x: -3,
    y: 1,
    depth: 60,
    vx: 6,
    vy: -1.5,
    vDepth: -25,
    def: ENEMIES.scav_fighter,
    radius: ENEMIES.scav_fighter.radius,
    hp: 10_000,
    ttl: 1_000,
    holdDepth: -1_000_000,
  });
}

/** A fighter holding still at `depth` (a speed-0 definition: no strafe); its cooldown runs out on the next step. */
function holder(flight: Flight, depth = 60): Hazard {
  return inject(flight, {
    kind: 'fighter',
    depth,
    holdDepth: depth,
    def: { ...ENEMIES.scav_fighter, speed: 0 },
    radius: ENEMIES.scav_fighter.radius,
    hp: ENEMIES.scav_fighter.hp,
    ttl: 1_000,
    pattern: 0,
    fireCooldown: DT / 2,
    burstLeft: 0,
    burstAt: 0,
  });
}

function enemyShots(flight: Flight): Hazard[] {
  const out: Hazard[] = [];
  for (let i = 0; i < flight.hazards.size; i++) {
    const hazard = flight.hazards.at(i);
    if (hazard.kind === 'enemy_shot') out.push(hazard);
  }
  return out;
}

describe('the lead point (SPEC-041 §4.7)', () => {
  it('leads a crossing fighter to where a shot fired now meets it, projected to the convergence depth', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), aria: { level: 1, enabled: true } });
    step(w.flight, LAUNCH_SECONDS + DT);
    w.flight.update(DT, { ...IDLE });
    expect(w.flight.lead.active).toBe(false); // nothing in the cone
    const fighter = crossing(w.flight);
    const { x, y, depth, vx, vy, vDepth } = fighter;
    const ship = { x: w.flight.ship.x, y: w.flight.ship.y };
    w.flight.update(DT, { ...IDLE, ...onTarget(w.flight, fighter) });
    const t = depth / (RAIL.laserSpeed - vDepth);
    const meet = RAIL.laserSpeed * t;
    expect(w.flight.lead.active).toBe(true);
    expect(w.flight.lead.x).toBeCloseTo(ship.x + ((x + vx * t - ship.x) * CONVERGE_DEPTH) / meet, 10);
    expect(w.flight.lead.y).toBeCloseTo(ship.y + ((y + vy * t - ship.y) * CONVERGE_DEPTH) / meet, 10);
    // Pinned: from the middle, 60 m out closing at 25, sliding (6, −1.5) → (−5/6, 11/18),
    // where the current projection is (−4, 4/3).
    expect(w.flight.lead.x).toBeCloseTo(-5 / 6, 10);
    expect(w.flight.lead.y).toBeCloseTo(11 / 18, 10);
  });

  it('puts a shot fired through it on the crossing fighter, where the current projection misses', () => {
    function oneShot(throughLead: boolean): number {
      const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), aria: { level: 1, enabled: true } });
      step(w.flight, LAUNCH_SECONDS + DT);
      const fighter = crossing(w.flight);
      w.flight.update(DT, { ...IDLE, ...onTarget(w.flight, fighter) });
      const aim = throughLead ? { aimX: w.flight.lead.x, aimY: w.flight.lead.y } : onTarget(w.flight, fighter);
      w.flight.update(DT, { ...IDLE, ...aim, fire: true });
      expect(w.flight.shots.size).toBe(1);
      step(w.flight, 1, aim);
      return w.of('flight:hazardHit').length;
    }
    expect(oneShot(true)).toBe(1);
    expect(oneShot(false)).toBe(0);
  });

  it('drops the lead with its target, and when the trip ends', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), aria: { level: 1, enabled: true } });
    step(w.flight, LAUNCH_SECONDS + DT);
    const fighter = crossing(w.flight);
    w.flight.update(DT, { ...IDLE, ...onTarget(w.flight, fighter) });
    expect(w.flight.lead.active).toBe(true);
    w.flight.update(DT, { ...IDLE, aimX: 10, aimY: -6 }); // out of the 6° cone
    expect(w.flight.lead.active).toBe(false);
    w.flight.update(DT, { ...IDLE, ...onTarget(w.flight, fighter) });
    expect(w.flight.lead.active).toBe(true);
    w.flight.hit(10_000, 'asteroid', { kind: 'asteroid' });
    expect(w.flight.phase).toBe('recalled');
    expect(w.flight.lead.active).toBe(false);
  });
});

describe('the ARIA lead (SPEC-041 §4.7)', () => {
  it('at level 2 chases the lead point at 20/s, not the current projection', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), aria: { level: 2, enabled: true } });
    step(w.flight, LAUNCH_SECONDS + DT);
    const fighter = crossing(w.flight);
    const chase = Math.min(1, 20 * DT);
    for (let i = 0; i < 20; i++) {
      const before = { ...w.flight.reticle };
      w.flight.update(DT, { ...IDLE, ...onTarget(w.flight, fighter) });
      const { lead, reticle } = w.flight;
      expect(lead.active).toBe(true);
      expect(reticle.x).toBeCloseTo(before.x + (lead.x - before.x) * chase, 10);
      expect(reticle.y).toBeCloseTo(before.y + (lead.y - before.y) * chase, 10);
    }
    // Metres from where the target is now: the snap of SPEC-013 is gone.
    const now = onTarget(w.flight, fighter);
    expect(Math.hypot(w.flight.reticle.x - now.aimX, w.flight.reticle.y - now.aimY)).toBeGreaterThan(2);
  });

  it('at level 1 leaves the reticle to the raw aim, the lead still worked out for the pip', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), aria: { level: 1, enabled: true } });
    step(w.flight, LAUNCH_SECONDS + DT);
    const fighter = crossing(w.flight);
    for (let i = 0; i < 20; i++) {
      const aim = onTarget(w.flight, fighter);
      w.flight.update(DT, { ...IDLE, ...aim });
      expect(w.flight.reticle).toEqual({ x: aim.aimX, y: aim.aimY });
      expect(w.flight.lead.active).toBe(true);
    }
    expect(w.flight.ariaEnabled).toBe(true);
  });

  it('with ARIA disabled: no pip and no snap, while the cone still keys auto-fire (41-k)', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), aria: { level: 2, enabled: false } });
    step(w.flight, LAUNCH_SECONDS + DT);
    const fighter = crossing(w.flight);
    const aim = onTarget(w.flight, fighter);
    w.flight.update(DT, { ...IDLE, ...aim, autoFire: true });
    expect(w.flight.ariaEnabled).toBe(false); // the scene shows the pip only while this is true
    expect(w.flight.reticle).toEqual({ x: aim.aimX, y: aim.aimY });
    expect(w.flight.shots.size).toBe(1);
  });
});

describe('fighter bursts (SPEC-041 §4.8)', () => {
  it('fires three rounds 0.12 s apart at leads 1, 0.5 and 0, each dealing 8', () => {
    expect(FIGHTER_BURST).toEqual({ rounds: 3, interval: 0.12, leads: [1, 0.5, 0], damageMult: 0.45 });
    expect(ENEMIES.scav_fighter.damage).toBe(18);
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), aria: null });
    step(w.flight, LAUNCH_SECONDS + DT);
    const fighter = holder(w.flight);
    fighter.fireCooldown = 0.2; // the ship is under way by the time it opens up
    const steer = { steerX: 1, steerY: -0.5 };
    const rounds: Array<{ at: number; k: number; damage: number }> = [];
    for (let i = 0; i < 40; i++) {
      w.flight.update(DT, { ...IDLE, ...steer });
      // A round fired this step has not moved yet, and nothing moves the ship
      // after the fighters fire — so the ship here is the ship the round saw.
      const ship = w.flight.ship;
      for (const shot of enemyShots(w.flight)) {
        if (shot.depth !== fighter.depth) continue;
        const k = rounds.length;
        const eta = enemyShotEta(shot.depth);
        const lead = FIGHTER_BURST.leads[k] as number;
        expect(Math.abs(ship.vx)).toBeGreaterThan(3);
        expect(shot.x + shot.vx * eta).toBeCloseTo(ship.x + lead * ship.vx * eta, 9);
        expect(shot.y + shot.vy * eta).toBeCloseTo(ship.y + lead * ship.vy * eta, 9);
        expect(shot.vDepth).toBe(-45);
        rounds.push({ at: w.flight.time, k, damage: shot.shotDamage ?? 0 });
      }
    }
    expect(rounds.map((round) => round.k)).toEqual([0, 1, 2]);
    expect(rounds.map((round) => round.damage)).toEqual([8, 8, 8]); // round(18 × 0.45)
    const first = rounds[0]!.at;
    for (const round of rounds) {
      expect(round.at - first).toBeGreaterThanOrEqual(round.k * FIGHTER_BURST.interval - 1e-9);
      expect(round.at - first).toBeLessThan(round.k * FIGHTER_BURST.interval + DT);
    }
  });

  it('lands every round on a still ship for its 8, and casual takes ×0.7 off each (41-l)', () => {
    for (const [difficulty, each] of [
      ['normal', 8],
      ['casual', 8 * 0.7],
    ] as const) {
      const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), aria: null, difficulty });
      step(w.flight, LAUNCH_SECONDS + DT);
      holder(w.flight);
      step(w.flight, 1.9); // the burst lands; the next opens 2 s after it
      expect(w.of('ship:damaged'), difficulty).toHaveLength(3);
      expect(w.flight.ship.shield).toBeCloseTo(w.flight.ship.maxShield - 3 * each, 9);
    }
  });

  it('in the flight loop, a steady 10 m/s drift takes the lead-1 round and slips the other two', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), aria: null });
    step(w.flight, LAUNCH_SECONDS + DT);
    holder(w.flight);
    const ship = w.flight.ship;
    // x(t) = −8 + 10 t at 10 m/s: written so that the step's own damping and
    // integration (no steer input) land the ship exactly on the line.
    const damping = Math.exp(-6 * DT);
    for (let i = 1; i <= 114; i++) {
      ship.vx = 10 / damping;
      ship.x = -8 + 10 * (i - 1) * DT;
      w.flight.update(DT, IDLE);
      expect(ship.x).toBeCloseTo(-8 + 10 * i * DT, 9);
      expect(ship.vx).toBeCloseTo(10, 9);
    }
    expect(w.of('ship:damaged')).toHaveLength(1);
  });

  it('drops the unfired rounds of a fighter that dies mid-burst (41-j)', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), aria: null });
    step(w.flight, LAUNCH_SECONDS + DT);
    const fighter = holder(w.flight);
    w.flight.update(DT, IDLE);
    expect(enemyShots(w.flight)).toHaveLength(1); // round one is away
    expect(fighter.burstLeft).toBe(2);
    // A shot a metre short of it kills it on the next step, before round two is due.
    Object.assign(w.flight.shots.alloc(), { x: 0, y: 0, depth: fighter.depth - 1, vDepth: RAIL.laserSpeed, damage: 1_000, vx: 0, vy: 0 });
    w.flight.update(DT, IDLE);
    expect(w.of('enemy:killed')).toHaveLength(1);
    expect(w.flight.hostiles).toBe(0);
    step(w.flight, 1.9);
    // Round one flew on and landed; rounds two and three were never fired.
    expect(w.of('ship:damaged')).toHaveLength(1);
    expect(enemyShots(w.flight)).toHaveLength(0);
  });

  it('…and of one that leaves mid-burst (41-j)', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), aria: null });
    step(w.flight, LAUNCH_SECONDS + DT);
    const fighter = holder(w.flight);
    fighter.ttl = 1.5 * DT; // it breaks off on the step after round one
    step(w.flight, 2);
    expect(w.flight.hostiles).toBe(0);
    expect(w.of('enemy:killed')).toEqual([]);
    expect(w.of('ship:damaged')).toHaveLength(1);
  });
});

/**
 * SPEC-041 §4.8's acceptance geometry, measured on `burstAim` — the rule the
 * fighters fire by. A burst opens at every 10 ms phase across 2 s (the weave's
 * period) from every hold depth; each round flies straight to its aim point
 * and lands if the ship is within the two radii of it when it arrives. The
 * ship's path is scripted, not flown: the weave peaks at 31 m/s, past what
 * the rail lets a ship do, which is why this is geometry and not a trip.
 */
describe('burst geometry (SPEC-041 §4.8)', () => {
  type Path = (t: number) => { x: number; vx: number };

  function landing(path: Path): number {
    const aim = { x: 0, y: 0 };
    let rounds = 0;
    let landed = 0;
    for (let depth = 50; depth <= 70; depth += 2.5) {
      for (let phase = 0; phase < 200; phase++) {
        for (let k = 0; k < FIGHTER_BURST.rounds; k++) {
          const fired = phase * 0.01 + k * FIGHTER_BURST.interval;
          const now = path(fired);
          burstAim(k, depth, { x: now.x, y: 0, vx: now.vx, vy: 0 }, aim);
          const then = path(fired + enemyShotEta(depth));
          rounds++;
          if (Math.hypot(aim.x - then.x, aim.y) < ENEMY_SHOT_RADIUS + SHIP_RADIUS) landed++;
        }
      }
    }
    return landed / rounds;
  }

  it('hits a still ship with ≥ 95 % of rounds', () => {
    expect(landing(() => ({ x: 0, vx: 0 }))).toBeGreaterThanOrEqual(0.95);
  });

  it('hits a steady 10 m/s drift with 10–35 % — the lead-1 round', () => {
    const rate = landing((t) => ({ x: 10 * t, vx: 10 }));
    expect(rate).toBeGreaterThanOrEqual(0.1);
    expect(rate).toBeLessThanOrEqual(0.35);
  });

  it('hits a ±10 m / 0.5 Hz weave with ≤ 10 %', () => {
    const omega = Math.PI; // 0.5 Hz
    const rate = landing((t) => ({ x: 10 * Math.sin(omega * t), vx: 10 * omega * Math.cos(omega * t) }));
    expect(rate).toBeLessThanOrEqual(0.1);
  });
});

describe('flight hit feedback (SPEC-041 §4.9)', () => {
  it('emits flight:hazardHit on every hit — lethal on the kill — and flashes the hazard on the others', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), aria: null });
    step(w.flight, LAUNCH_SECONDS + DT);
    const fighter = holder(w.flight);
    fighter.fireCooldown = Number.POSITIVE_INFINITY; // a target, not a threat
    const flashes: number[] = [];
    for (let i = 0; i < 120 && w.of('enemy:killed').length === 0; i++) {
      const before = w.of('flight:hazardHit').length;
      w.flight.update(DT, { ...IDLE, fire: true });
      const hits = w.of('flight:hazardHit');
      if (hits.length > before && hits.at(-1)?.lethal === false) flashes.push(fighter.hitFlash ?? 0);
    }
    // 40 HP at 10 a shot: three hits that do not kill, then the kill.
    expect(w.of('flight:hazardHit')).toEqual([
      { kind: 'fighter', x: 0, y: 0, lethal: false },
      { kind: 'fighter', x: 0, y: 0, lethal: false },
      { kind: 'fighter', x: 0, y: 0, lethal: false },
      { kind: 'fighter', x: 0, y: 0, lethal: true },
    ]);
    // Set to 0.1 s by the hit, then counted down by the same step's hazard pass.
    expect(flashes).toHaveLength(3);
    for (const flash of flashes) expect(flash).toBeCloseTo(HAZARD_FLASH_SECONDS - DT, 9);
  });

  it('runs a flash out in 0.1 s, and flashes a rock the same way', () => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300), aria: null });
    step(w.flight, LAUNCH_SECONDS + DT);
    const rock = inject(w.flight, { kind: 'asteroid', depth: 60, x: 0, y: 0, radius: 3, hp: 45, vDepth: 0 });
    for (let i = 0; i < 60 && w.of('flight:hazardHit').length === 0; i++) w.flight.update(DT, { ...IDLE, fire: true });
    expect(w.of('flight:hazardHit')).toEqual([{ kind: 'asteroid', x: 0, y: 0, lethal: false }]);
    expect(rock.hitFlash).toBeGreaterThan(0);
    step(w.flight, HAZARD_FLASH_SECONDS);
    expect(rock.hitFlash).toBe(0);
  });
});

// ------------------------------------------------------- SPEC-066 §4.9, §6.3

describe('the first trip’s asteroid lane (SPEC-066 §4.9)', () => {
  const FIELD = PLANETS.cinder4.flight.firstTripField;
  if (FIELD === undefined) throw new Error('cinder4 has no firstTripField');

  /** The trip second the flight has covered — `#covered`, read through `progress`. */
  const tripSecond = (flight: Flight): number => flight.progress * PLANETS.cinder4.travelSeconds;

  /** Cinder-4 with its field and waves, without the ambient rocks: every asteroid is a field rock. */
  const fieldOnly: PlanetDef = { ...PLANETS.cinder4, flight: { ...PLANETS.cinder4.flight, asteroidDensity: 0 } };

  it('fieldLaneX swings once across the window: 0, +4, 0 and 0 at its start, quarter, half and end', () => {
    expect(fieldLaneX(FIELD, 20)).toBeCloseTo(0, 9);
    expect(fieldLaneX(FIELD, 26.25)).toBeCloseTo(4, 9);
    expect(fieldLaneX(FIELD, 32.5)).toBeCloseTo(0, 9);
    expect(fieldLaneX(FIELD, 45)).toBeCloseTo(0, 9);
  });

  for (const seed of [1, 2, 3, 4]) {
    it(`seed ${seed}: rocks spawn only in [20, 45] s, never drift, sit outside the lane on arrival, and miss a ship that holds it`, () => {
      const w = world({ planet: fieldOnly, seed, firstTrip: true });
      const live = new Set<Hazard>();
      const tracked: Array<{ rock: Hazard; x: number; radius: number; arrived: number | null }> = [];
      const spawnedAt: number[] = [];
      while (w.flight.phase !== 'arrived' && w.flight.phase !== 'recalled' && w.flight.time < 200) {
        // Hold the lane: the centre at the trip second now.
        w.flight.ship.x = fieldLaneX(FIELD, tripSecond(w.flight));
        w.flight.ship.vx = 0;
        w.flight.update(DT, IDLE);
        const now = new Set<Hazard>();
        for (let i = 0; i < w.flight.hazards.size; i++) {
          const hazard = w.flight.hazards.at(i);
          now.add(hazard);
          if (hazard.kind !== 'asteroid' || live.has(hazard)) continue;
          spawnedAt.push(tripSecond(w.flight));
          expect(hazard.vx).toBe(0);
          expect(hazard.vy).toBe(0);
          expect(hazard.radius).toBeGreaterThanOrEqual(FIELD_ROCK_RADIUS[0]);
          expect(hazard.radius).toBeLessThanOrEqual(FIELD_ROCK_RADIUS[1]);
          tracked.push({ rock: hazard, x: hazard.x, radius: hazard.radius, arrived: null });
        }
        for (const entry of tracked) {
          if (entry.arrived === null && now.has(entry.rock) && entry.rock.depth <= RAIL.hitDepth) {
            entry.arrived = tripSecond(w.flight);
            expect(entry.rock.x).toBe(entry.x); // never drifted
          }
        }
        live.clear();
        for (const hazard of now) live.add(hazard);
      }
      expect(w.flight.phase).toBe('arrived');
      expect(w.flight.fieldRocks).toBeGreaterThan(0);
      expect(spawnedAt).toHaveLength(w.flight.fieldRocks);
      for (const at of spawnedAt) {
        expect(at).toBeGreaterThanOrEqual(FIELD.fromSecond);
        expect(at).toBeLessThanOrEqual(FIELD.toSecond);
      }
      // Every rock reached the ship's plane (none was rammed), outside the
      // lane by its own radius at the second it got there — inside one step.
      for (const entry of tracked) {
        expect(entry.arrived).not.toBeNull();
        const gap = Math.abs(entry.x - fieldLaneX(FIELD, entry.arrived as number));
        expect(gap).toBeGreaterThanOrEqual(FIELD_LANE_HALF_WIDTH + entry.radius - 0.05);
      }
      expect(w.of('ship:damaged')).toEqual([]);
    });
  }

  it('holds the lane at the fast throttle and on a faster engine too (66-k)', () => {
    for (const engine of [0, 3] as const) {
      const w = world({ planet: fieldOnly, seed: 5, firstTrip: true, ship: { engine } });
      step(w.flight, DT, { throttleUp: true });
      while (w.flight.phase !== 'arrived' && w.flight.phase !== 'recalled' && w.flight.time < 200) {
        w.flight.ship.x = fieldLaneX(FIELD, tripSecond(w.flight));
        w.flight.ship.vx = 0;
        w.flight.update(DT, IDLE);
      }
      expect(w.flight.phase).toBe('arrived');
      expect(w.flight.fieldRocks).toBeGreaterThan(0);
      expect(w.of('ship:damaged')).toEqual([]);
    }
  });

  it('field rocks count against the preset’s asteroidCap', () => {
    const cap = 3;
    const { flight } = world({ seed: 2, firstTrip: true, quality: { ...QUALITY.medium, asteroidCap: cap } });
    let most = 0;
    while (flight.phase !== 'arrived' && flight.phase !== 'recalled' && flight.time < 200) {
      flight.update(DT, IDLE);
      let rocks = 0;
      for (let i = 0; i < flight.hazards.size; i++) if (flight.hazards.at(i).kind === 'asteroid') rocks++;
      most = Math.max(most, rocks);
    }
    expect(flight.fieldRocks).toBeGreaterThan(0);
    expect(most).toBe(cap);
  });

  /**
   * A running FNV-1a over every step's sky — each hazard's kind, position and
   * size — and the ship, for a pilot who sits still with auto-fire on.
   */
  const KIND_CODE = { asteroid: 1, fighter: 2, interceptor: 3, enemy_shot: 4 } as const;
  function tripDigest(flight: Flight): string {
    let hash = 0x811c9dc5;
    const fold = (value: number): void => {
      hash = Math.imul(hash ^ (Math.round(value * 1e4) | 0), 0x01000193) >>> 0;
    };
    let steps = 0;
    while (steps < 200 * 60 && flight.phase !== 'arrived' && flight.phase !== 'recalled') {
      flight.update(DT, { ...IDLE, autoFire: true });
      steps++;
      fold(flight.hazards.size);
      for (let i = 0; i < flight.hazards.size; i++) {
        const hazard = flight.hazards.at(i);
        fold(KIND_CODE[hazard.kind]);
        fold(hazard.x);
        fold(hazard.y);
        fold(hazard.depth);
        fold(hazard.radius);
      }
      fold(flight.ship.x);
      fold(flight.ship.hull);
      fold(flight.ship.shield);
    }
    return `${flight.phase}/${steps}/0x${hash.toString(16)}`;
  }

  // Measured on `a15fbeb`, before the field existed: the trips as they were.
  const TODAY = {
    cinder4: ['arrived/5582/0x2d3476fd', 'arrived/5582/0x5e43634a', 'arrived/5582/0x3697bc6', 'arrived/5582/0xe8202369'],
    vetra: ['recalled/3392/0x81190751', 'recalled/3275/0x9cdd5b9c', 'recalled/3416/0xd54fecd7', 'recalled/3413/0xa17a04f8'],
  } as const;

  it('without firstTrip, a later Cinder-4 trip and a Vetra first trip spawn no field rock and fly today’s sky step for step', () => {
    for (const seed of [1, 2, 3, 4]) {
      for (const firstTrip of [false, undefined]) {
        const later = world({ seed, ...(firstTrip === undefined ? {} : { firstTrip }) });
        expect(tripDigest(later.flight), `cinder4 seed ${seed} firstTrip ${String(firstTrip)}`).toBe(TODAY.cinder4[seed - 1]);
        expect(later.flight.fieldRocks).toBe(0);
      }
      const vetra = world({ planet: PLANETS.vetra, seed, firstTrip: true });
      expect(tripDigest(vetra.flight), `vetra seed ${seed}`).toBe(TODAY.vetra[seed - 1]);
      expect(vetra.flight.fieldRocks).toBe(0);
    }
  });

  it('the field fork draws nothing from the trip’s stream, and the first trip flies today’s sky until the field opens', () => {
    const rng = new Rng(3);
    const w = world({ seed: 3 });
    // Construction forks 'field' (and 'storm', 'salvage') without a draw.
    new Flight(
      { planet: PLANETS.cinder4, ship: w.save.ship, companions: w.save.companions, quality: QUALITY.medium, difficulty: 'normal', firstTrip: true },
      w.economy,
      w.progression,
      w.missions,
      w.events,
      rng,
    );
    expect(rng.next()).toBe(new Rng(3).next());

    const first = world({ seed: 3, firstTrip: true }).flight;
    const later = world({ seed: 3, firstTrip: false }).flight;
    const sky = (flight: Flight): string =>
      Array.from({ length: flight.hazards.size }, (_, i) => flight.hazards.at(i))
        .map((hazard) => `${hazard.kind}:${hazard.x}:${hazard.y}:${hazard.depth}`)
        .join('|');
    while (tripSecond(first) < FIELD.fromSecond - 0.5) {
      first.update(DT, { ...IDLE, autoFire: true });
      later.update(DT, { ...IDLE, autoFire: true });
      expect(sky(first)).toBe(sky(later));
    }
    expect(first.fieldRocks).toBe(0);
  });

  it('an idle pilot with auto-fire on who reaches Cinder-4 without the field, on seeds 1–16, reaches it with the field', () => {
    const fly = (seed: number, firstTrip: boolean): { phase: FlightPhase; fieldRocks: number } => {
      const { flight } = world({ seed, firstTrip });
      while (flight.phase !== 'arrived' && flight.phase !== 'recalled' && flight.time < 200) flight.update(DT, { ...IDLE, autoFire: true });
      return { phase: flight.phase, fieldRocks: flight.fieldRocks };
    };
    const lost: number[] = [];
    let arrivedWithout = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const without = fly(seed, false);
      if (without.phase !== 'arrived') continue;
      arrivedWithout++;
      const withField = fly(seed, true);
      expect(withField.fieldRocks, `seed ${seed}`).toBeGreaterThan(0);
      if (withField.phase !== 'arrived') lost.push(seed);
    }
    expect(arrivedWithout).toBe(16);
    expect(lost).toEqual([]);
  });
});

describe('rock salvage (SPEC-066 §4.9, E125)', () => {
  /** A quiet sky, so the only rocks are the test's own. */
  const quiet = (): World => {
    const w = world({ planet: quietPlanet(PLANETS.cinder4, 300) });
    step(w.flight, LAUNCH_SECONDS + DT);
    return w;
  };

  /** Shoot down one rock of `radius`, straight ahead at depth 60. */
  const downRock = (w: World, radius: number): void => {
    inject(w.flight, { kind: 'asteroid', depth: 60, x: 0, y: 0, radius, hp: 1, vDepth: 0 });
    const lethal = (): number => w.of('flight:hazardHit').filter((hit) => hit.lethal).length;
    const before = lethal();
    for (let i = 0; i < 180 && lethal() === before; i++) w.flight.update(DT, { ...IDLE, fire: true });
    expect(lethal()).toBe(before + 1);
  };

  it('a radius-3.5 rock shot down adds 2 oil, through one pickup resource:collected', () => {
    const w = quiet();
    const oil = w.save.resources.oil;
    downRock(w, 3.5);
    expect(w.save.resources.oil).toBe(oil + ROCK_SALVAGE_OIL);
    expect(w.of('resource:collected')).toEqual([{ resource: 'oil', amount: 2, total: oil + 2, source: 'pickup' }]);
    expect(w.flight.rockSalvage).toBe(2);
  });

  it('a radius-2.5 rock adds nothing', () => {
    const w = quiet();
    const oil = w.save.resources.oil;
    downRock(w, 2.5);
    expect(w.save.resources.oil).toBe(oil);
    expect(w.of('resource:collected')).toEqual([]);
    expect(w.flight.rockSalvage).toBe(0);
  });

  it('the eleventh big rock of a trip adds nothing: 20 a trip', () => {
    const w = quiet();
    const oil = w.save.resources.oil;
    for (let i = 0; i < 10; i++) downRock(w, 3.5);
    expect(w.flight.rockSalvage).toBe(ROCK_SALVAGE_PER_TRIP);
    expect(w.save.resources.oil).toBe(oil + 20);
    downRock(w, 3.5);
    expect(w.flight.rockSalvage).toBe(20);
    expect(w.save.resources.oil).toBe(oil + 20);
    expect(w.of('resource:collected')).toHaveLength(10);
  });

  it('with oil one under the cap a rock adds 1, and the count rises by 1', () => {
    const w = quiet();
    const cap = w.economy.cargoCap();
    w.save.resources.oil = cap - 1;
    downRock(w, 3.5);
    expect(w.save.resources.oil).toBe(cap);
    expect(w.flight.rockSalvage).toBe(1);
  });

  it('a full hold adds nothing and uses none of the 20 (E125)', () => {
    const w = quiet();
    const cap = w.economy.cargoCap();
    w.save.resources.oil = cap;
    downRock(w, 3.5);
    downRock(w, 3.9);
    expect(w.save.resources.oil).toBe(cap);
    expect(w.flight.rockSalvage).toBe(0);
    // Room again: the trip's count was never spent.
    w.save.resources.oil = cap - 10;
    downRock(w, 3.5);
    expect(w.save.resources.oil).toBe(cap - 8);
    expect(w.flight.rockSalvage).toBe(2);
  });

  it('a rammed big rock adds nothing, and still hurts (66-l)', () => {
    const w = quiet();
    const oil = w.save.resources.oil;
    inject(w.flight, { kind: 'asteroid', depth: RAIL.hitDepth + 0.5, vDepth: -60, radius: 3.5, hp: 53 });
    step(w.flight, 3 * DT);
    expect(w.of('ship:damaged')).toHaveLength(1);
    expect(w.save.resources.oil).toBe(oil);
    expect(w.of('resource:collected')).toEqual([]);
    expect(w.flight.rockSalvage).toBe(0);
  });

  it('a new Flight starts at 0 rock salvage and 0 field rocks', () => {
    const { flight } = world({ firstTrip: true });
    expect(flight.rockSalvage).toBe(0);
    expect(flight.fieldRocks).toBe(0);
  });
});
