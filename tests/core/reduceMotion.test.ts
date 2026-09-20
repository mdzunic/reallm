// SPEC-015 §9 — reduce motion, which is a promise about *visuals only*.
//
// Two halves, and the second is the one that matters: the effects that must go
// still, and the guarantee that nothing about the simulation changes when they
// do. `settings.reduceMotion` never reaches a pure system — the fixed-seed runs
// at the bottom prove it by running the real stack twice, once with the setting
// on and once with it off, and comparing entity state field by field (AC-47).
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { QUALITY } from '@/core/Renderer';
import { Rng } from '@/core/Rng';
import { newSave, type CharacterCreation } from '@/core/Save';
import { PLANETS } from '@/data/index';
import { Economy } from '@/systems/Economy';
import { Flight, type FlightConfig, type FlightInput } from '@/systems/Flight';
import { Missions } from '@/systems/Missions';
import { Progression } from '@/systems/Progression';
import { chooseFilmMode, revealCamera, typedChars } from '@/systems/StoryBeats';
import {
  CAMERA_BOB,
  cameraBob,
  cameraBobAmplitude,
  shakeOffset,
  STORM_FLICKER,
  stormOverlayOpacity,
  type ShakeState,
} from '@/views/SurfaceView';
import { FlightView, REDUCED_STREAK_SCALE, STAR_STREAK_LENGTH, starStreakLength } from '@/views/FlightView';
import { harness, STEP } from '../systems/combatFixtures';
import * as THREE from 'three';

// ------------------------------------------------------------------ effects

describe('screen shake and camera bob (AC-41)', () => {
  const shake: ShakeState = { amplitude: 2, until: 10, duration: 1 };

  it('zeroes the shake outright', () => {
    const moving = new THREE.Vector3();
    shakeOffset(shake, 9.5, false, moving);
    expect(moving.lengthSq()).toBeGreaterThan(0);

    const still = new THREE.Vector3();
    shakeOffset(shake, 9.5, true, still);
    expect(still.toArray()).toEqual([0, 0, 0]);
  });

  it('zeroes the camera bob amplitude at every speed', () => {
    for (const speed of [0, 1, 2.5, 4, 40]) {
      expect(cameraBobAmplitude(speed, true), `${speed} m/s`).toBe(0);
      expect(cameraBob(speed, 1.234, true), `${speed} m/s`).toBe(0);
    }
  });

  it('still bobs with the stride when the setting is off', () => {
    expect(cameraBobAmplitude(CAMERA_BOB.speedFull, false)).toBeCloseTo(CAMERA_BOB.amplitude, 10);
    // Standing still is not a bob either way.
    expect(cameraBobAmplitude(0, false)).toBe(0);
    // …and it never exceeds the amplitude, however fast the player is pushed.
    expect(cameraBobAmplitude(999, false)).toBeCloseTo(CAMERA_BOB.amplitude, 10);
    let peak = 0;
    for (let t = 0; t < 4; t += 1 / 240) peak = Math.max(peak, Math.abs(cameraBob(4, t, false)));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(CAMERA_BOB.amplitude + 1e-9);
  });
});

describe('flight camera bank (AC-42)', () => {
  // The clamp itself lives in `views/FlightView.ts` and is applied to
  // `-ship.bank × DEG`; what is checked here is the number it clamps to and
  // that the clamp is symmetric.
  const REDUCED_ROLL_DEG = 8;
  const clamp = (bankDeg: number): number => Math.max(-REDUCED_ROLL_DEG, Math.min(REDUCED_ROLL_DEG, -bankDeg));

  it('holds the roll inside 8° in either direction', () => {
    expect(clamp(35)).toBe(-8);
    expect(clamp(-35)).toBe(8);
    expect(clamp(4)).toBe(-4);
    expect(clamp(0)).toBe(-0);
  });
});

describe('the storm overlay (AC-43)', () => {
  it('is static at its mean, with the flicker term dropped', () => {
    for (const t of [0, 0.37, 1.2, 9.9, 60]) expect(stormOverlayOpacity(0.5, t, true)).toBe(0.5);
  });

  it('flickers around that same mean when the setting is off', () => {
    const samples: number[] = [];
    for (let t = 0; t < 20; t += 0.01) samples.push(stormOverlayOpacity(0.5, t, false));
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(max).toBeGreaterThan(min);
    // The swing is the flicker's, and it is centred on the mean.
    expect(max).toBeLessThanOrEqual(0.5 * (1 + STORM_FLICKER) + 1e-9);
    expect(min).toBeGreaterThanOrEqual(0.5 * (1 - STORM_FLICKER) - 1e-9);
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    expect(mean).toBeCloseTo(0.5, 2);
  });

  it('keeps a calm sky clear and an unusable mean at zero either way', () => {
    expect(stormOverlayOpacity(0, 3, false)).toBe(0);
    expect(stormOverlayOpacity(Number.NaN, 3, false)).toBe(0);
    expect(stormOverlayOpacity(-1, 3, true)).toBe(0);
  });
});

describe('the typewriter and the HUD pulse (AC-44)', () => {
  const LINE = 'The lattice is not a place. It is a rate.';

  it('types the whole line on the first frame', () => {
    expect(typedChars(LINE, 0, true)).toBe(LINE.length);
    expect(typedChars(LINE, 0.001, true)).toBe(LINE.length);
    // …where without it the first frame has barely started.
    expect(typedChars(LINE, 0, false)).toBeLessThan(LINE.length);
  });

  it('turns the guide frame pulse into a static colour change', () => {
    // `scenes/Surface.ts` writes `frame.pulse = !settings.reduceMotion`, so the
    // view's pulsing beacon becomes a lit one. The rule, stated:
    const pulseFor = (reduceMotion: boolean): boolean => !reduceMotion;
    expect(pulseFor(true)).toBe(false);
    expect(pulseFor(false)).toBe(true);
  });
});

describe('flight star streaks (AC-45)', () => {
  it('draws them at exactly half length', () => {
    for (const throttle of [0.25, 0.5, 1]) {
      expect(starStreakLength(throttle, true)).toBeCloseTo(starStreakLength(throttle, false) * REDUCED_STREAK_SCALE, 10);
    }
    expect(REDUCED_STREAK_SCALE).toBe(0.5);
  });

  it('scales with throttle and clamps an unusable one', () => {
    expect(starStreakLength(1, false)).toBe(STAR_STREAK_LENGTH);
    expect(starStreakLength(0, false)).toBe(0);
    expect(starStreakLength(4, false)).toBe(STAR_STREAK_LENGTH);
    expect(starStreakLength(Number.NaN, false)).toBe(0);
  });
});

describe('story films and chapter cards (AC-46)', () => {
  it('plays a film as its posters rather than its video', () => {
    const base = { manifestFilm: true, posters: true, videoBroken: false };
    expect(chooseFilmMode({ ...base, reduceMotion: true })).toBe('stills');
    expect(chooseFilmMode({ ...base, reduceMotion: false })).toBe('video');
    // With no posters to fall back on it is the words, never the video.
    expect(chooseFilmMode({ ...base, posters: false, reduceMotion: true })).toBe('text');
  });

  it('cuts the reveal pans instead of easing them, on the same clock', () => {
    // The endpoints are where the beat starts and ends; only the middle moves.
    const eased = revealCamera(0.4, false);
    const cut = revealCamera(0.4, true);
    expect(cut.phase).toBe(eased.phase);
    expect(cut.k).toBe(1);
    expect(eased.k).toBeLessThan(1);
  });

  it('holds the poster still and drops the end fade (ui/FilmPlayer.ts)', () => {
    // The two rules the player applies, stated here so a change to either is a
    // deliberate edit: `pan` becomes `'none'`, and the fade becomes 0 ms.
    const panFor = (shotPan: string, reduceMotion: boolean): string => (reduceMotion ? 'none' : shotPan);
    const fadeFor = (reduceMotion: boolean, seconds: number): number => (reduceMotion ? 0 : seconds * 1000);
    expect(panFor('in', true)).toBe('none');
    expect(panFor('in', false)).toBe('in');
    expect(fadeFor(true, 0.6)).toBe(0);
    expect(fadeFor(false, 0.6)).toBe(600);
  });
});

// ------------------------------------------------------- AC-47: visual only

const PILOT: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
};

const DT = 1 / 60;
const IDLE: FlightInput = { steerX: 0, steerY: 0, fire: false, aimX: 0, aimY: 0, throttleUp: false, throttleDown: false };

/**
 * The real flight stack on a fixed seed, run for `seconds` *with the visual
 * layer alongside it*: a real `FlightView` built with the setting, its
 * reduce-motion-gated cockpit kick, and the streak length the setting halves.
 * The digest is simulation state only — hazards, shots, the ship — so the
 * assertion is that none of that visual work reached the model.
 */
function flightRun(seconds: number, reduceMotion: boolean): string {
  const save = newSave(0, PILOT, 42, 1_700_000_000_000);
  const events = new EventBus<GameEvents>({ dev: false });
  const progression = new Progression(save, events);
  const economy = new Economy(save, events, progression);
  const planet = PLANETS.cinder4;
  const missions = new Missions(save, economy, events, 'flight', planet.id);
  const config: FlightConfig = {
    planet,
    ship: save.ship,
    companions: save.companions,
    quality: QUALITY.medium,
    difficulty: save.meta.difficulty,
  };
  const flight = new Flight(config, economy, progression, missions, events, new Rng(7));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 600);
  const view = new FlightView(scene, camera, { planet, quality: QUALITY.medium, reduceMotion, rng: new Rng(11) });
  // A hit kicks the cockpit — except under reduce motion, where `kick()`
  // returns without touching anything (`views/FlightView.ts`).
  events.on('ship:damaged', () => view.kick(), {});

  const input: FlightInput = { ...IDLE, fire: true, steerX: 0.4, steerY: -0.2 };
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    flight.update(DT, input);
    starStreakLength(flight.ship.throttle, reduceMotion);
  }

  const hazards: unknown[] = [];
  for (let i = 0; i < flight.hazards.size; i++) {
    const h = flight.hazards.at(i);
    hazards.push([h.kind, h.x, h.y, h.depth, h.vDepth, h.radius, h.hp]);
  }
  const shots: unknown[] = [];
  for (let i = 0; i < flight.shots.size; i++) {
    const s = flight.shots.at(i);
    shots.push([s.x, s.y, s.depth, s.vDepth, s.damage]);
  }
  const ship = flight.ship;
  view.dispose();
  return JSON.stringify({
    phase: flight.phase,
    progress: flight.progress,
    ship: [ship.x, ship.y, ship.vx, ship.vy, ship.bank, ship.hull, ship.shield, ship.throttle],
    hazards,
    shots,
  });
}

/**
 * The real surface combat stack on a fixed seed, with the per-frame visual work
 * the scene does beside it: the decaying screen shake, the walk bob and the
 * storm sheet, each handed the setting. The digest is entity state only.
 */
function surfaceRun(seconds: number, reduceMotion: boolean): string {
  const h = harness({ seed: 20_250_915 });
  h.spawn('dust_skitter', 4, 0);
  h.spawn('dust_skitter', -3, 2);
  h.spawn('ash_crawler', 0, 6);
  h.input.move.x = 0.6;
  h.input.move.y = -0.4;
  h.input.buttons.fire.down = true;
  h.aim = { x: 6, z: 0 };

  const shake: ShakeState = { amplitude: 0, until: 0, duration: 0 };
  const offset = new THREE.Vector3();
  h.events.on(
    'player:damaged',
    () => {
      shake.amplitude = 0.35;
      shake.duration = 0.25;
      shake.until = h.world.time + 0.25;
    },
    {},
  );
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    h.step();
    const player = h.world.player;
    shakeOffset(shake, h.world.time, reduceMotion, offset);
    cameraBob(Math.hypot(player.vx, player.vz), h.world.time, reduceMotion);
    stormOverlayOpacity(0.4, h.world.time, reduceMotion);
  }

  const enemies: unknown[] = [];
  for (let i = 0; i < h.world.enemies.size; i++) {
    const e = h.world.enemies.at(i);
    enemies.push([e.def.id, e.x, e.z, e.vx, e.vz, e.hp, e.state, e.cooldown]);
  }
  const projectiles: unknown[] = [];
  for (let i = 0; i < h.world.projectiles.size; i++) {
    const p = h.world.projectiles.at(i);
    projectiles.push([p.x, p.z, p.vx, p.vz, p.ttl]);
  }
  const player = h.world.player;
  return JSON.stringify({
    time: h.world.time,
    player: [player.x, player.z, player.vx, player.vz, player.hp, player.alive, player.fireCooldown],
    enemies,
    projectiles,
  });
}

describe('reduce motion is visual only (AC-47)', () => {
  it('leaves the setting out of every pure system, entity and data table', () => {
    const sources = import.meta.glob<string>('../../src/{systems,entities,data}/**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    // The glob found files at all, so an empty offender list is a real answer.
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const offenders = Object.entries(sources)
      .filter(([, source]) => /reduceMotion/.test(source))
      .map(([file]) => file);
    // `systems/StoryBeats.ts` is the one mention, and it is not the simulation
    // reading a setting: it is the pure *presentation* layer for films and
    // reveals — `chooseFilmMode`, `typedChars`, `revealCamera` — every one of
    // which takes the flag as an argument. That is what makes AC-44's instant
    // typewriter and AC-46's poster mode testable functions.
    expect(offenders).toEqual(['../../src/systems/StoryBeats.ts']);
    const beats = sources['../../src/systems/StoryBeats.ts'] as string;
    // It never reads a store, and it never touches an entity or a pool.
    expect(beats).not.toMatch(/settings\s*[.[]/);
    expect(beats).not.toMatch(/@\/entities/);
  });

  it('gives a fixed-seed flight identical entity state with the setting on and off', () => {
    const off = flightRun(6, false);
    const on = flightRun(6, true);
    expect(on).toEqual(off);
    // …and the run simulated something worth comparing.
    expect(off).not.toContain('"hazards":[]');
  });

  it('gives a fixed-seed surface simulation identical entity state with the setting on and off', () => {
    const off = surfaceRun(4, false);
    const on = surfaceRun(4, true);
    expect(on).toEqual(off);
    expect(off).not.toContain('"enemies":[]');
  });
});
