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
import { QUALITY } from '@/core/Renderer';
import { Rng } from '@/core/Rng';
import { newSave, type CharacterCreation, type SaveV1 } from '@/core/Save';
import { ENEMIES, MISSIONS, PLANETS, TUNING, UPGRADES, type MissionId, type PlanetDef } from '@/data/index';
import { Economy } from '@/systems/Economy';
import {
  FIGHTER_LEAVE_SECONDS,
  Flight,
  LAUNCH_SECONDS,
  PLANE,
  RAIL,
  THREAT_BOX,
  type FlightConfig,
  type FlightInput,
  type Hazard,
} from '@/systems/Flight';
import { Missions } from '@/systems/Missions';
import { Progression } from '@/systems/Progression';

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
  save: SaveV1;
  events: EventBus<GameEvents>;
  progression: Progression;
  economy: Economy;
  missions: Missions;
  flight: Flight;
  of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]>;
}

interface WorldOptions {
  planet?: PlanetDef;
  ship?: Partial<SaveV1['ship']>;
  aria?: { level: 1 | 2 | 3; enabled: boolean } | null;
  difficulty?: 'casual' | 'normal';
  accept?: MissionId[];
  seed?: number;
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
  const missions = new Missions(save, { scene: 'flight', planet: planet.id }, economy, events);
  const cfg: FlightConfig = {
    planet,
    ship: save.ship,
    companions: save.companions,
    quality: QUALITY.medium,
    difficulty: save.meta.difficulty,
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
    expect(w.missions.active).toEqual(['c5_m1']);
  });

  it('counts survive through launch, cruise and holding (AC-88, AC-113)', () => {
    const w = world({ planet: quietPlanet(PLANETS.hive, 20), accept: ['c5_m1'] });
    step(w.flight, LAUNCH_SECONDS + DT);
    blocker(w.flight);
    step(w.flight, 30); // 20 s cruise + 10 s holding, after the 3 s launch
    expect(w.flight.phase).toBe('holding');
    const entry = w.save.progress.missionsActive.find((m) => m.id === 'c5_m1')!;
    // §4.8: the timer is flight time while alive — the launch seconds count.
    expect(entry.counters['0:0']).toBeCloseTo(LAUNCH_SECONDS + 30, 0);
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

    // Replay at 50 % (SPEC-010 §4.7): re-accept, complete again.
    w.save.progress.missionsActive.push({ id: 'c4_s2', stage: 0, counters: {} });
    const replayBefore = w.save.player.tokens;
    for (let i = 0; i < 8; i++) w.events.emit('enemy:killed', { enemyId: 'scav_fighter', elite: false, x: 0, z: 0, xp: 12 });
    expect(w.of('mission:completed').at(-1)).toEqual({ id: 'c4_s2', replay: true });
    expect(w.save.player.tokens).toBeGreaterThanOrEqual(replayBefore + Math.floor(def.rewards.tokens * TUNING.REPLAY_REWARD_FRACTION));
  });

  it('resets stages on recall and keeps the missions accepted (AC-86, AC-103)', () => {
    const w = world({ planet: quietPlanet(PLANETS.hive, 300), accept: ['c5_m1'] });
    step(w.flight, LAUNCH_SECONDS + 10);
    w.events.emit('enemy:killed', { enemyId: 'hive_interceptor', elite: false, x: 0, z: 0, xp: 10 });
    const entry = w.save.progress.missionsActive.find((m) => m.id === 'c5_m1')!;
    expect(entry.counters['0:0']).toBeGreaterThan(5);
    expect(entry.counters['0:1']).toBe(1);
    w.flight.hit(10_000, 'asteroid', { kind: 'asteroid' });
    expect(w.of('mission:stageReset')).toEqual([{ id: 'c5_m1', stage: 0, reason: 'death' }]);
    expect(entry.counters['0:0']).toBeUndefined();
    expect(entry.counters['0:1']).toBeUndefined();
    expect(w.save.progress.missionsActive.map((m) => m.id)).toContain('c5_m1');
  });

  it('restarts a loaded survive counter but keeps a loaded kill counter', () => {
    const save = newSave(0, PILOT, 42, 1_700_000_000_000);
    save.progress.missionsActive.push({ id: 'c5_m1', stage: 0, counters: { '0:0': 120, '0:1': 4 } });
    const events = new EventBus<GameEvents>({ dev: false });
    const progression = new Progression(save, events);
    const economy = new Economy(save, events, progression);
    new Missions(save, { scene: 'flight', planet: 'hive' }, economy, events);
    const entry = save.progress.missionsActive[0]!;
    expect(entry.counters['0:0']).toBeUndefined();
    expect(entry.counters['0:1']).toBe(4);
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
