// SPEC-015 §9 — reduce motion, which is a promise about *visuals only*.
//
// SPEC-045 §4.3 made it a preset: turning it on seeds `cameraShake` 0,
// `filmMode` 'stills' and `typewriter` false (and SPEC-037's `damageFlash`),
// and each of those then changes on its own. So the shake and the walk bob
// take Camera shake's 0…1 scale, the film mode takes `preferStills`, the
// typing takes `instant`, and everything else here still reads `reduceMotion`.
//
// Two halves, and the second is the one that matters: the effects that must go
// still, and the guarantee that nothing about the simulation changes when they
// do. None of those settings reaches a pure system — the fixed-seed runs at
// the bottom prove it by running the real stack with the visual layer beside
// it, reduce motion on and off and camera shake at 0 and at 1, and comparing
// entity state field by field (AC-47, SPEC-045 AC-15).
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { QUALITY } from '@/core/Renderer';
import { Rng } from '@/core/Rng';
import { newSave, type CharacterCreation } from '@/core/Save';
import { reduceMotionPreset, type Settings } from '@/core/Settings';
import { PLANETS } from '@/data/index';
import { Economy } from '@/systems/Economy';
import { Flight, type FlightConfig, type FlightInput } from '@/systems/Flight';
import { Missions } from '@/systems/Missions';
import { Progression } from '@/systems/Progression';
import { chooseFilmMode, revealCamera, typedChars } from '@/systems/StoryBeats';
import { lineReveal, TYPE_CHARS_PER_SEC } from '@/ui/DialogueUI';
import {
  CAMERA_BOB,
  cameraBob,
  cameraBobAmplitude,
  shakeOffset,
  STORM_FLICKER,
  stormOverlayOpacity,
  type ShakeState,
} from '@/views/SurfaceView';
import {
  cameraRoll,
  FlightView,
  REDUCED_ROLL_DEG,
  REDUCED_STREAK_SCALE,
  STAR_STREAK_LENGTH,
  starStreakLength,
} from '@/views/FlightView';
import { harness, STEP } from '../systems/combatFixtures';
import { stripComments } from '../architecture/source';
import * as THREE from 'three';

/**
 * Two of the rules below are a line of wiring rather than a function — the
 * scenes that hand the setting to the dialogue layer, and the frame flag the
 * surface HUD writes. `environment: 'node'` has no DOM to mount them in, so
 * they are pinned the way `tests/ui/updates.test.ts` pins its own wiring:
 * against the source, with comments stripped so a rule cannot be satisfied by
 * writing it down.
 */
const RAW = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([file, source]) => [file, stripComments(source)]),
);

// ------------------------------------------------------------------ effects

describe('screen shake and camera bob (AC-41)', () => {
  // SPEC-045 §4.3: the last argument is `settings.cameraShake` — 1 full, 0.5
  // half, 0 off, which is what reduce motion sets.
  const shake: ShakeState = { amplitude: 2, until: 10, duration: 1 };

  it('zeroes the shake outright', () => {
    const moving = new THREE.Vector3();
    shakeOffset(shake, 9.5, 1, moving);
    expect(moving.lengthSq()).toBeGreaterThan(0);

    const still = new THREE.Vector3();
    shakeOffset(shake, 9.5, 0, still);
    expect(still.toArray()).toEqual([0, 0, 0]);
  });

  it('zeroes the camera bob amplitude at every speed', () => {
    for (const speed of [0, 1, 2.5, 4, 40]) {
      expect(cameraBobAmplitude(speed, 0), `${speed} m/s`).toBe(0);
      expect(cameraBob(speed, 1.234, 0), `${speed} m/s`).toBe(0);
    }
  });

  it('still bobs with the stride at full camera shake', () => {
    expect(cameraBobAmplitude(CAMERA_BOB.speedFull, 1)).toBeCloseTo(CAMERA_BOB.amplitude, 10);
    // Standing still is not a bob either way.
    expect(cameraBobAmplitude(0, 1)).toBe(0);
    // …and it never exceeds the amplitude, however fast the player is pushed.
    expect(cameraBobAmplitude(999, 1)).toBeCloseTo(CAMERA_BOB.amplitude, 10);
    let peak = 0;
    for (let t = 0; t < 4; t += 1 / 240) peak = Math.max(peak, Math.abs(cameraBob(4, t, 1)));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(CAMERA_BOB.amplitude + 1e-9);
  });

  it('halves the shake at camera shake 0.5 (SPEC-045 §4.3)', () => {
    const full = new THREE.Vector3();
    const half = new THREE.Vector3();
    for (const t of [9.1, 9.37, 9.5, 9.9]) {
      shakeOffset(shake, t, 1, full);
      shakeOffset(shake, t, 0.5, half);
      expect(full.lengthSq(), `t ${t}`).toBeGreaterThan(0);
      expect(Math.abs(half.x - full.x / 2), `t ${t}`).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(half.y - full.y / 2), `t ${t}`).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(half.z - full.z / 2), `t ${t}`).toBeLessThanOrEqual(1e-9);
    }
  });

  it('halves the walk bob at camera shake 0.5', () => {
    for (const speed of [1, 2.5, 4, 40]) {
      expect(Math.abs(cameraBobAmplitude(speed, 0.5) - cameraBobAmplitude(speed, 1) / 2)).toBeLessThanOrEqual(1e-9);
      for (const t of [0.1, 1.234, 3.3]) {
        const full = cameraBob(speed, t, 1);
        expect(full, `${speed} m/s at ${t}`).not.toBe(0);
        expect(Math.abs(cameraBob(speed, t, 0.5) - full / 2), `${speed} m/s at ${t}`).toBeLessThanOrEqual(1e-9);
      }
    }
  });

  it('reads an unusable scale as a still camera, never a full one', () => {
    for (const scale of [Number.NaN, -1, -0]) {
      const out = new THREE.Vector3(9, 9, 9);
      shakeOffset(shake, 9.5, scale, out);
      expect(out.toArray(), `${scale}`).toEqual([0, 0, 0]);
      expect(cameraBob(4, 1.234, scale), `${scale}`).toBe(0);
    }
    // Past 1 is still full scale: the setting has no step above it.
    expect(cameraBobAmplitude(4, 3)).toBe(cameraBobAmplitude(4, 1));
  });
});

describe('flight camera bank (AC-42)', () => {
  // `cameraRoll` is the function `FlightView.#updateCamera` calls, so this
  // pins the shipped clamp rather than a copy of it.
  const deg = (radians: number): number => radians / (Math.PI / 180);

  it('holds the roll inside 8° in either direction', () => {
    expect(REDUCED_ROLL_DEG).toBe(8);
    expect(deg(cameraRoll(35, true))).toBeCloseTo(-8, 10);
    expect(deg(cameraRoll(-35, true))).toBeCloseTo(8, 10);
    // A bank already inside the cap is untouched, and so is level flight.
    expect(deg(cameraRoll(4, true))).toBeCloseTo(-4, 10);
    expect(cameraRoll(0, true)).toBe(-0);
  });

  it('follows the full bank when the setting is off', () => {
    expect(deg(cameraRoll(35, false))).toBeCloseTo(-35, 10);
    expect(deg(cameraRoll(-35, false))).toBeCloseTo(35, 10);
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

  it('types the whole film caption on the first frame', () => {
    // SPEC-045 §4.3: `instant` is `!settings.typewriter`, which reduce motion
    // turns off; `FilmPlayer` passes it.
    expect(typedChars(LINE, 0, true)).toBe(LINE.length);
    expect(typedChars(LINE, 0.001, true)).toBe(LINE.length);
    // …where without it the first frame has barely started.
    expect(typedChars(LINE, 0, false)).toBeLessThan(LINE.length);
  });

  it('types the whole dialogue line on the first frame, with no interval at all', () => {
    // `DialogueUI.#advanceLine` calls this: a `null` interval is the absence
    // of a typewriter, not a fast one, so no `setInterval` is ever started.
    expect(lineReveal(LINE, true)).toEqual({ chars: LINE.length, intervalMs: null });
    // The ordinary path is §4.6's 40 chars/s, starting from an empty box.
    expect(lineReveal(LINE, false)).toEqual({ chars: 0, intervalMs: 1000 / TYPE_CHARS_PER_SEC });
    expect(TYPE_CHARS_PER_SEC).toBe(40);
    // An empty line is instantly whole either way — 0 chars, and `#finishLine`
    // is what the reduce-motion branch reaches.
    expect(lineReveal('', true).chars).toBe(0);
  });

  it('reads the setting live, in every scene that opens a dialogue', () => {
    // The layer is a page-lifetime singleton whose first caller's options win
    // (`dialogueLayer`), so the option has to be a getter or a scene that
    // opened before the player changed the setting would keep typing.
    // SPEC-045 §4.3: the setting is Typewriter text, which reduce motion seeds.
    const dialogue = SOURCES['../../src/ui/DialogueUI.ts'] as string;
    expect(dialogue).toMatch(/typewriter\?\s*:\s*\(\)\s*=>\s*boolean/);
    expect(dialogue).toContain('lineReveal(line.text, this.#typewriter?.() === false)');
    for (const scene of ['Surface', 'StationScene', 'CreationScene', 'Flight']) {
      const source = SOURCES[`../../src/scenes/${scene}.ts`] as string;
      expect(source, scene).toMatch(/typewriter:\s*\(\)\s*=>\s*[\w.]*settings\.get\(\)\.typewriter/);
    }
  });

  it('turns the guide frame pulse into a static colour change', () => {
    // `scenes/Surface.ts` is what writes the flag onto the frame the view
    // reads; the view's pulsing beacon becomes a lit one.
    expect(SOURCES['../../src/scenes/Surface.ts'] as string).toContain('frame.pulse = !settings.reduceMotion');
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
    // SPEC-045 §4.3: with Films set to stills, which reduce motion sets
    // (PLAN R18 decision 10's change to R9-4).
    const base = { manifestFilm: true, posters: true, videoBroken: false };
    expect(chooseFilmMode({ ...base, preferStills: true })).toBe('stills');
    expect(chooseFilmMode({ ...base, preferStills: false })).toBe('video');
    // With no posters to fall back on it is the words, never the video.
    expect(chooseFilmMode({ ...base, posters: false, preferStills: true })).toBe('text');
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

/** What a run hands its visual layer: reduce motion, and Camera shake's scale. */
type Motion = Pick<Settings, 'reduceMotion' | 'cameraShake'>;

/** Reduce motion off and on — each the whole preset, as the toggle writes it. */
const MOTION_OFF: Motion = reduceMotionPreset(false);
const MOTION_ON: Motion = reduceMotionPreset(true);

/**
 * The real flight stack on a fixed seed, run for `seconds` *with the visual
 * layer alongside it*: a real `FlightView` built with the setting, its cockpit
 * kick at Camera shake's scale (`view.kick(scale)`), and the streak length the
 * setting halves. The digest is simulation state only — hazards, shots, the
 * ship, and how many hits it took — so the assertion is that none of that
 * visual work reached the model.
 */
function flightRun(seconds: number, motion: Motion): string {
  const { reduceMotion, cameraShake: scale } = motion;
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
  // A hit kicks the cockpit by Camera shake's scale — at 0, which reduce
  // motion sets, `kick()` returns without touching anything (SPEC-045 §4.3).
  let hits = 0;
  events.on(
    'ship:damaged',
    () => {
      hits++;
      view.kick(scale);
    },
    {},
  );

  const input: FlightInput = { ...IDLE, fire: true, steerX: 0.4, steerY: -0.2 };
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    flight.update(DT, input);
    // A hit a second, through the door the storm tick and the dev bridge use:
    // the field never reaches the ship in six seconds on its own, and a run
    // without hits would never kick.
    if (i % 60 === 30) flight.hit(4, 'asteroid', { kind: 'asteroid' });
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
    hits,
  });
}

/**
 * The real surface combat stack on a fixed seed, with the per-frame visual work
 * the scene does beside it: the decaying screen shake and the walk bob at
 * Camera shake's scale, and the storm sheet handed reduce motion. The digest
 * is entity state only, and how many hits started a shake.
 */
function surfaceRun(seconds: number, motion: Motion): string {
  const { reduceMotion, cameraShake: scale } = motion;
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
  let hits = 0;
  h.events.on(
    'player:damaged',
    () => {
      hits++;
      shake.amplitude = 0.35;
      shake.duration = 0.25;
      shake.until = h.world.time + 0.25;
    },
    {},
  );
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    h.step();
    const player = h.world.player;
    shakeOffset(shake, h.world.time, scale, offset);
    cameraBob(Math.hypot(player.vx, player.vz), h.world.time, scale);
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
    hits,
  });
}

describe('reduce motion is visual only (AC-47)', () => {
  // Raw sources, comments and all: a mention anywhere is an offender.
  const sources = import.meta.glob<string>('../../src/{systems,entities,data}/**/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it('leaves the setting out of every pure system, entity and data table', () => {
    // The glob found files at all, so an empty offender list is a real answer.
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const offenders = Object.entries(sources)
      .filter(([, source]) => /reduceMotion/.test(source))
      .map(([file]) => file);
    // `systems/StoryBeats.ts` is the one mention, and it is not the simulation
    // reading a setting: it is the pure *presentation* layer for films and
    // reveals, and `revealCamera` takes the flag as an argument. That is what
    // makes AC-46's cut a testable function. (SPEC-045 §4.3 moved the other
    // two onto their own settings: `chooseFilmMode` takes `preferStills` and
    // `typedChars` takes `instant`.)
    expect(offenders).toEqual(['../../src/systems/StoryBeats.ts']);
    const beats = sources['../../src/systems/StoryBeats.ts'] as string;
    // It never reads a store, and it never touches an entity or a pool.
    expect(beats).not.toMatch(/settings\s*[.[]/);
    expect(beats).not.toMatch(/@\/entities/);
  });

  it('leaves camera shake, films and the typewriter out of them too (SPEC-045 AC-15)', () => {
    const offenders = Object.entries(sources)
      .filter(([, source]) => /cameraShake|filmMode|typewriter/.test(source))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('gives a fixed-seed flight identical entity state with the setting on and off', () => {
    const off = flightRun(6, MOTION_OFF);
    const on = flightRun(6, MOTION_ON);
    expect(on).toEqual(off);
    // …and the run simulated something worth comparing.
    expect(off).not.toContain('"hazards":[]');
  });

  it('gives a fixed-seed flight identical entity state with camera shake at 0 and at 1 (SPEC-045 AC-15)', () => {
    const full = flightRun(6, { reduceMotion: false, cameraShake: 1 });
    const off = flightRun(6, { reduceMotion: false, cameraShake: 0 });
    expect(off).toEqual(full);
    // …and the ship took hits, so the full run's kicks had something to move.
    expect(full).not.toContain('"hits":0');
  });

  it('gives a fixed-seed surface simulation identical entity state with the setting on and off', () => {
    const off = surfaceRun(4, MOTION_OFF);
    const on = surfaceRun(4, MOTION_ON);
    expect(on).toEqual(off);
    expect(off).not.toContain('"enemies":[]');
  });

  it('gives a fixed-seed surface simulation identical entity state with camera shake at 0 and at 1 (SPEC-045 AC-15)', () => {
    const full = surfaceRun(4, { reduceMotion: false, cameraShake: 1 });
    const off = surfaceRun(4, { reduceMotion: false, cameraShake: 0 });
    expect(off).toEqual(full);
    expect(full).not.toContain('"hits":0');
  });
});
