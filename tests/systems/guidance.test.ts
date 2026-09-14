// SPEC-027 §6.1 — the pure guidance module: which point an objective means,
// how the focus row is chosen, the compass words and distance wording, the
// escalation clock, and the path search.
//
// Everything here runs in node: `systems/Guidance.ts` imports no `three`, no
// DOM and no `Math.random`, which is what makes the whole escalation testable
// without a browser (AC-1; the architecture suite pins the imports themselves).
import { describe, expect, it } from 'vitest';
import * as Guidance from '@/systems/Guidance';
import {
  bearingWord,
  buildPathGrid,
  distanceText,
  fillHint,
  findPath,
  focusObjective,
  objectiveTarget,
  padTarget,
  HEADWAY_METRES,
  NUDGE_REPEAT_SECONDS,
  PATH_MAX_POINTS,
  STUCK_LEVELS,
  StuckTracker,
  type GuideContext,
  type GuidePoi,
} from '@/systems/Guidance';
import { HINTS, HINT_PLACEHOLDERS } from '@/data/index';
import type { Objective } from '@/data/index';
import type { ObjectiveProgress } from '@/systems/Missions';

// --------------------------------------------------------------- the context

const POIS: GuidePoi[] = [
  { poi: 'landing_pad', instance: 0, kind: 'landing_pad', x: 0, z: 0, radius: 6, label: 'Landing Pad', scanned: false },
  // The nearer instance is already scanned, so `scan` must skip it (27-b).
  { poi: 'dune_sea', instance: 0, kind: 'scan', x: 20, z: 0, radius: 8, label: 'Dune Sea', scanned: true },
  { poi: 'dune_sea', instance: 1, kind: 'scan', x: -40, z: 0, radius: 8, label: 'Dune Sea', scanned: false },
  { poi: 'beacon', instance: 0, kind: 'deliver', x: 0, z: 50, radius: 6, label: 'Survey Beacon', scanned: false },
  { poi: 'wurm_nest', instance: 0, kind: 'arena', x: 0, z: -60, radius: 20, label: 'Wurm Nest', scanned: false },
  { poi: 'probe_site', instance: 0, kind: 'escort_start', x: 15, z: 15, radius: 8, label: 'Probe Site', scanned: false },
  { poi: 'hive_mouth', instance: 0, kind: 'arena', x: -15, z: 30, radius: 20, label: 'Hive Mouth', scanned: false },
];

function makeCtx(patch: Partial<GuideContext> = {}): GuideContext {
  return {
    player: { x: 10, z: 0 },
    pois: POIS,
    nodes: [
      { resource: 'oil', x: 14, z: 0, remaining: 0 }, // nearest, but drained
      { resource: 'oil', x: 25, z: 0, remaining: 40 },
      { resource: 'wheat', x: -5, z: 5, remaining: 30 },
    ],
    nearestEnemy: (id, maxRange) => (id === 'scav_raider' && maxRange >= 20 ? { x: 12, z: 18 } : null),
    follower: { x: 60, z: 60, alive: true },
    held: () => 0,
    arenaFor: (enemy) => (enemy === 'dune_wurm' ? (POIS[4] as GuidePoi) : null),
    ...patch,
  };
}

const ROW = { value: 0, target: 1 };

function progress(objective: Objective, done: boolean, value = 0, target = 1): ObjectiveProgress {
  return { objective, value, target, done };
}

// ------------------------------------------------------------------- exports

describe('the module surface (SPEC-027 AC-1)', () => {
  it('exports exactly the runtime names of §3', () => {
    expect(Object.keys(Guidance).sort()).toEqual(
      [
        'HEADWAY_METRES',
        'NUDGE_REPEAT_SECONDS',
        'PATH_CELL',
        'PATH_INFLATE',
        'PATH_MAX_EXPANSIONS',
        'PATH_MAX_POINTS',
        'STUCK_LEVELS',
        'StuckTracker',
        'bearingWord',
        'buildPathGrid',
        'distanceText',
        'fillHint',
        'findPath',
        'focusObjective',
        'objectiveTarget',
        'padTarget',
      ].sort(),
    );
  });
});

// ------------------------------------------------------------------- targets

describe('objectiveTarget (SPEC-027 §4.1, AC-2, AC-3, AC-4)', () => {
  it('reach targets the nearest instance of the POI', () => {
    const target = objectiveTarget({ kind: 'reach', poi: 'landing_pad' }, ROW, makeCtx());
    expect(target).toMatchObject({ kind: 'poi', x: 0, z: 0, radius: 6, label: 'Landing Pad', key: 'poi:landing_pad:0' });
  });

  it('scan skips an instance that is already scanned (27-b)', () => {
    const target = objectiveTarget({ kind: 'scan', poi: 'dune_sea', count: 2 }, ROW, makeCtx());
    expect(target).toMatchObject({ x: -40, label: 'Dune Sea', key: 'poi:dune_sea:1' });
  });

  it('collect targets the nearest node that still holds the resource', () => {
    const target = objectiveTarget({ kind: 'collect', resource: 'oil', amount: 150 }, ROW, makeCtx());
    expect(target).toMatchObject({ kind: 'node', x: 25, z: 0, radius: 2.5, label: 'Oil node', key: 'node:oil:0' });
  });

  it('kill targets the nearest enemy within 80 m, and keeps its key while it moves (AC-4)', () => {
    const first = objectiveTarget({ kind: 'kill', enemy: 'scav_raider', amount: 6 }, ROW, makeCtx());
    expect(first).toMatchObject({ kind: 'enemy', x: 12, z: 18, radius: 6, key: 'enemy:scav_raider:0' });
    expect(first?.label).toBe('Scav Raider');
    const moved = objectiveTarget(
      { kind: 'kill', enemy: 'scav_raider', amount: 6 },
      ROW,
      makeCtx({ nearestEnemy: () => ({ x: -30, z: 44 }) }),
    );
    expect(moved?.key).toBe(first?.key);
    expect(moved?.x).not.toBe(first?.x);
  });

  it('boss targets the arena POI that hosts it (D-19)', () => {
    const target = objectiveTarget({ kind: 'boss', enemy: 'dune_wurm' }, ROW, makeCtx());
    expect(target).toMatchObject({ kind: 'poi', x: 0, z: -60, radius: 20, label: 'Wurm Nest' });
  });

  it('defend targets its POI', () => {
    const target = objectiveTarget({ kind: 'defend', poi: 'beacon', seconds: 60, wave: 'eden_final' }, ROW, makeCtx());
    expect(target).toMatchObject({ kind: 'poi', label: 'Survey Beacon' });
  });

  it('deliver targets the POI with the amount in hold, and a node without it', () => {
    const objective: Objective = { kind: 'deliver', poi: 'beacon', resource: 'oil', amount: 100 };
    expect(objectiveTarget(objective, ROW, makeCtx({ held: () => 100 }))).toMatchObject({ label: 'Survey Beacon' });
    expect(objectiveTarget(objective, ROW, makeCtx({ held: () => 99 }))).toMatchObject({ kind: 'node', label: 'Oil node' });
  });

  it('escort targets the follower while it lags, and the destination once it is close (27-m)', () => {
    const objective: Objective = { kind: 'escort', from: 'probe_site', to: 'hive_mouth', follower: 'science_probe' };
    const far = objectiveTarget(objective, ROW, makeCtx());
    expect(far).toMatchObject({ kind: 'follower', radius: 3, label: 'Science Probe', key: 'follower:science_probe:0' });
    const near = objectiveTarget(objective, ROW, makeCtx({ follower: { x: 12, z: 2, alive: true } }));
    expect(near).toMatchObject({ kind: 'poi', label: 'Hive Mouth' });
    const dead = objectiveTarget(objective, ROW, makeCtx({ follower: { x: 60, z: 60, alive: false } }));
    expect(dead).toMatchObject({ kind: 'poi', label: 'Hive Mouth' });
  });

  it('survive and choice have no target (AC-3)', () => {
    expect(objectiveTarget({ kind: 'survive', seconds: 60 }, ROW, makeCtx())).toBeNull();
    expect(
      objectiveTarget({ kind: 'choice', prompt: 'Well?', options: [{ label: 'Stay', flags: [] }] }, ROW, makeCtx()),
    ).toBeNull();
  });

  it('collect with every node drained and kill with nothing in range are null (AC-3, 27-c, 27-d)', () => {
    const drained = makeCtx({ nodes: [{ resource: 'oil', x: 4, z: 0, remaining: 0 }] });
    expect(objectiveTarget({ kind: 'collect', resource: 'oil', amount: 20 }, ROW, drained)).toBeNull();
    const empty = makeCtx({ nearestEnemy: () => null });
    expect(objectiveTarget({ kind: 'kill', enemy: 'scav_raider', amount: 6 }, ROW, empty)).toBeNull();
  });
});

describe('focusObjective (SPEC-027 §4.1, AC-5, AC-6, AC-7)', () => {
  const reach: Objective = { kind: 'reach', poi: 'landing_pad' };
  const survive: Objective = { kind: 'survive', seconds: 60 };

  it('returns the first undone row whose target resolves', () => {
    const focus = focusObjective([progress(reach, true), progress(survive, false), progress(reach, false)], makeCtx());
    expect(focus).toMatchObject({ index: 2 });
    expect(focus?.target).toMatchObject({ label: 'Landing Pad' });
  });

  it('falls back to the first undone row with no target at all (AC-6)', () => {
    const focus = focusObjective([progress(reach, true), progress(survive, false, 12, 60)], makeCtx());
    expect(focus).toEqual({ index: 1, target: null });
  });

  it('is null when every row is done (AC-7, 27-p)', () => {
    expect(focusObjective([progress(reach, true), progress(survive, true)], makeCtx())).toBeNull();
  });
});

describe('padTarget (SPEC-027 §4.1 last row, AC-8, D-11)', () => {
  it('points at the pad terminal from outside its radius', () => {
    expect(padTarget(makeCtx())).toMatchObject({ kind: 'poi', radius: 6, label: 'Pad terminal' });
  });

  it('is null while the player stands on the pad (27-o)', () => {
    expect(padTarget(makeCtx({ player: { x: 2, z: 1 } }))).toBeNull();
  });
});

// ---------------------------------------------------------- words and numbers

describe('bearingWord (SPEC-027 §4.8, AC-9, AC-10, D-8)', () => {
  it('names the eight map directions, with screen-up (−1, −1) reading north', () => {
    expect(bearingWord(-1, -1)).toBe('north');
    expect(bearingWord(0, -1)).toBe('north-east');
    expect(bearingWord(1, -1)).toBe('east');
    expect(bearingWord(1, 0)).toBe('south-east');
    expect(bearingWord(1, 1)).toBe('south');
    expect(bearingWord(0, 1)).toBe('south-west');
    expect(bearingWord(-1, 1)).toBe('west');
    expect(bearingWord(-1, 0)).toBe('north-west');
  });

  it('rounds sector boundaries the way D-8 specifies', () => {
    // A map bearing of `deg` clockwise from map-up, as a world offset.
    const at = (deg: number): string => {
      const radians = (deg * Math.PI) / 180;
      const u = Math.sin(radians);
      const v = -Math.cos(radians);
      return bearingWord((u + v) * Math.SQRT1_2, (v - u) * Math.SQRT1_2);
    };
    expect(at(0)).toBe('north');
    expect(at(22.4)).toBe('north');
    expect(at(22.5)).toBe('north-east'); // exactly on the boundary, rounded up
    expect(at(45)).toBe('north-east');
    expect(at(-22.4)).toBe('north');
    expect(at(-22.5)).toBe('north');
    expect(at(-45)).toBe('north-west');
    expect(at(360)).toBe('north');
  });
});

describe('distanceText (SPEC-027 §4.8, AC-11, D-9)', () => {
  it('rounds to the metre below 100 m and to 10 m above it', () => {
    expect(distanceText(8.4)).toBe('8 m');
    expect(distanceText(83.7)).toBe('84 m');
    expect(distanceText(142)).toBe('140 m');
    expect(distanceText(1449)).toBe('1450 m');
  });

  it('reads 0 m for a negative or non-finite input', () => {
    expect(distanceText(-3)).toBe('0 m');
    expect(distanceText(Number.NaN)).toBe('0 m');
    expect(distanceText(Number.POSITIVE_INFINITY)).toBe('0 m');
  });
});

describe('fillHint (SPEC-027 §4.8, AC-12, D-13)', () => {
  it('substitutes every placeholder it is given', () => {
    const template = '{label} {dir} {dist} {resource} {amount} {need} {enemy}';
    expect(
      fillHint(template, {
        '{label}': 'Dune Sea',
        '{dir}': 'north',
        '{dist}': '84 m',
        '{resource}': 'oil',
        '{amount}': '100',
        '{need}': '12',
        '{enemy}': 'Scav Raider',
      }),
    ).toBe('Dune Sea north 84 m oil 100 12 Scav Raider');
  });

  it('leaves a token whose value is missing, so the fallback chain can see it', () => {
    const filled = fillHint(HINTS.collect.nudge, { '{resource}': 'oil' });
    expect(filled).toContain('oil');
    expect(HINT_PLACEHOLDERS.some((token) => filled.includes(token))).toBe(true);
    // The fallback needs only `{resource}`, so it fills completely.
    const fallback = fillHint(HINTS.collect.fallback ?? '', { '{resource}': 'oil' });
    expect(HINT_PLACEHOLDERS.some((token) => fallback.includes(token))).toBe(false);
  });
});

// ------------------------------------------------------------- stuck tracker

describe('StuckTracker (SPEC-027 §4.6, AC-49..AC-55)', () => {
  /** A fake clock: `steps` fixed steps of `dt` with a constant distance. */
  function run(tracker: StuckTracker, seconds: number, distance: number | null, busy = false): Guidance.StuckEvent[] {
    const out: Guidance.StuckEvent[] = [];
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      const event = tracker.update(dt, distance, busy);
      if (event !== 'none') out.push(event);
    }
    return out;
  }

  it('reaches pulse, nudge and route at 45, 90 and 150 s, once each and in order', () => {
    const tracker = new StuckTracker();
    tracker.reset('poi:dune_sea:0', 80);
    expect(run(tracker, 44, 80)).toEqual([]);
    expect(tracker.level).toBe(0);
    expect(run(tracker, 2, 80)).toEqual(['pulse']);
    expect(tracker.level).toBe(1);
    expect(run(tracker, 45, 80)).toEqual(['nudge']);
    expect(tracker.level).toBe(2);
    expect(run(tracker, 60, 80)).toEqual(['route']);
    expect(tracker.level).toBe(3);
    expect(STUCK_LEVELS).toEqual([45, 90, 150]);
  });

  it('repeats the nudge every 120 s after the route (AC-50, AC-59)', () => {
    const tracker = new StuckTracker();
    tracker.reset('poi:dune_sea:0', 80);
    run(tracker, 151, 80);
    expect(tracker.level).toBe(3);
    expect(run(tracker, NUDGE_REPEAT_SECONDS - 2, 80)).toEqual([]);
    expect(run(tracker, 3, 80)).toEqual(['nudge']);
    expect(run(tracker, NUDGE_REPEAT_SECONDS + 1, 80)).toEqual(['nudge']);
  });

  it('headway of 10 m resets the clock and the level (AC-51)', () => {
    const tracker = new StuckTracker();
    tracker.reset('poi:dune_sea:0', 80);
    run(tracker, 100, 80);
    expect(tracker.level).toBe(2);
    expect(tracker.update(1 / 60, 80 - HEADWAY_METRES, false)).toBe('none');
    expect(tracker.level).toBe(0);
    expect(tracker.idle).toBe(0);
    // The new best is 70 m, so standing at 71 m is not headway again.
    expect(run(tracker, 46, 71)).toEqual(['pulse']);
  });

  it('busy pauses everything (AC-49)', () => {
    const tracker = new StuckTracker();
    tracker.reset('poi:dune_sea:0', 80);
    expect(run(tracker, 300, 80, true)).toEqual([]);
    expect(tracker.idle).toBe(0);
    expect(tracker.level).toBe(0);
  });

  it('a null distance still accrues idle time and never makes headway (AC-54, D-23)', () => {
    const tracker = new StuckTracker();
    tracker.reset(null, null);
    expect(run(tracker, 46, null)).toEqual(['pulse']);
    expect(tracker.idle).toBeGreaterThan(45);
  });

  it('reset is a no-op while the key is unchanged, and starts over on a new one (AC-53, D-22)', () => {
    const tracker = new StuckTracker();
    tracker.reset('poi:dune_sea:0', 80);
    run(tracker, 46, 80);
    expect(tracker.level).toBe(1);
    tracker.reset('poi:dune_sea:0', 80);
    expect(tracker.level).toBe(1);
    expect(tracker.idle).toBeGreaterThan(45);
    tracker.reset('poi:beacon:0', 50);
    expect(tracker.level).toBe(0);
    expect(tracker.idle).toBe(0);
  });

  it('progress() clears the clock and the level (AC-52)', () => {
    const tracker = new StuckTracker();
    tracker.reset('poi:dune_sea:0', 80);
    run(tracker, 95, 80);
    expect(tracker.level).toBe(2);
    tracker.progress();
    expect(tracker.level).toBe(0);
    expect(tracker.idle).toBe(0);
  });

  it('advance() pushes the clock for ?debug, one crossing per update (AC-55, D-22)', () => {
    const tracker = new StuckTracker();
    tracker.reset('poi:dune_sea:0', 80);
    tracker.advance(60);
    expect(tracker.update(1 / 60, 80, false)).toBe('pulse');
    tracker.advance(60);
    expect(tracker.update(1 / 60, 80, false)).toBe('nudge');
    tracker.advance(60);
    expect(tracker.update(1 / 60, 80, false)).toBe('route');
  });
});

// --------------------------------------------------------------- path search

describe('findPath (SPEC-027 §4.7, AC-61..AC-64)', () => {
  /** A wall of circles across `z = 0`, open past `gapFrom` on the +x side. */
  function wallGrid(halfSize: number, gapFrom: number) {
    const obstacles = [];
    for (let x = -halfSize; x <= gapFrom; x += 2) obstacles.push({ x, z: 0, radius: 1.5, kind: 'rock' as const });
    return buildPathGrid({ halfSize, obstacles });
  }

  /** A ring of circles around `(x, z)` — a target nothing can walk to. */
  function enclosedGrid(halfSize: number, x: number, z: number) {
    const obstacles = [];
    for (let a = 0; a < 64; a++) {
      const angle = (a / 64) * Math.PI * 2;
      obstacles.push({ x: x + Math.cos(angle) * 8, z: z + Math.sin(angle) * 8, radius: 1.6, kind: 'rock' as const });
    }
    return buildPathGrid({ halfSize, obstacles });
  }

  it('detours around a wall of circles and ends on the target', () => {
    const grid = wallGrid(40, 20);
    const out = new Float32Array(96);
    const points = findPath(grid, 0, -15, 0, 15, out);
    expect(points).toBeGreaterThan(2);
    expect(points).toBeLessThanOrEqual(PATH_MAX_POINTS);
    // Around the open end: some waypoint is well past the wall's last circle.
    let maxX = -Infinity;
    for (let i = 0; i < points; i++) maxX = Math.max(maxX, out[i * 2] as number);
    expect(maxX).toBeGreaterThan(20);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(-15);
    expect(out[(points - 1) * 2]).toBeCloseTo(0, 5);
    expect(out[(points - 1) * 2 + 1]).toBeCloseTo(15, 5);
  });

  it('finds the straight line across open ground', () => {
    const grid = buildPathGrid({ halfSize: 40, obstacles: [] });
    const out = new Float32Array(96);
    expect(findPath(grid, -20, -20, 20, 20, out)).toBe(2);
  });

  it('returns 0 for an enclosed target (27-a)', () => {
    const grid = enclosedGrid(40, 20, 20);
    const out = new Float32Array(96);
    expect(findPath(grid, -20, -20, 20, 20, out)).toBe(0);
  });

  it('gives up inside the expansion budget rather than walking a whole planet', () => {
    // ~10 000 free cells with the target walled off: the search cannot reach it
    // and stops at PATH_MAX_EXPANSIONS instead of exhausting the map.
    const grid = enclosedGrid(100, 40, 40);
    const out = new Float32Array(96);
    const started = performance.now();
    expect(findPath(grid, -80, -80, 40, 40, out)).toBe(0);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('never writes more than 48 points (AC-63)', () => {
    // A serpentine: 33 walls, alternating which side the gap is on, so the
    // smoothed path needs far more turns than the cap allows.
    const halfSize = 100;
    const obstacles = [];
    for (let i = 0; i < 33; i++) {
      const z = -96 + i * 6;
      const openLeft = i % 2 === 0;
      for (let x = -halfSize; x <= halfSize; x += 2) {
        if (openLeft && x < -halfSize + 16) continue;
        if (!openLeft && x > halfSize - 16) continue;
        obstacles.push({ x, z, radius: 1.2, kind: 'rock' as const });
      }
    }
    const grid = buildPathGrid({ halfSize, obstacles });
    // A longer buffer with a sentinel tail: nothing may be written past 96.
    const out = new Float32Array(120).fill(-999);
    const points = findPath(grid, 0, -98, 0, 98, out);
    expect(points).toBeGreaterThan(2);
    expect(points).toBeLessThanOrEqual(PATH_MAX_POINTS);
    for (let i = 96; i < out.length; i++) expect(out[i]).toBe(-999);
  });

  it('refuses to cut a corner between two touching obstacles', () => {
    // Two rocks on a diagonal leave a diagonal gap a circle cannot pass; an
    // 8-connected search without the corner rule would walk straight through.
    const grid = buildPathGrid({
      halfSize: 20,
      obstacles: [
        { x: 0, z: 2, radius: 1.2, kind: 'rock' },
        { x: 2, z: 0, radius: 1.2, kind: 'rock' },
      ],
    });
    const out = new Float32Array(96);
    const points = findPath(grid, -2, -2, 4, 4, out);
    expect(points).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------- SPEC-030

describe('SPEC-030 — survive points at the nearest shelter (AC-48)', () => {
  const SHELTERS = [
    { x: 40, z: 0, label: 'Cave', radius: 5.7 },
    { x: 15, z: 0, label: 'Wreck', radius: 2.9 },
  ];

  it('resolves to the nearest shelter while stormActive is true and shelters exist', () => {
    const ctx = makeCtx({ shelters: SHELTERS, stormActive: true });
    // The player stands at (10, 0): the wreck at 15 is nearer than the cave.
    const target = objectiveTarget({ kind: 'survive', seconds: 60 }, ROW, ctx);
    expect(target).toEqual({
      kind: 'shelter',
      x: 15,
      z: 0,
      radius: 2.9,
      label: 'Wreck',
      key: 'shelter:1:0',
    });
  });

  it('the key carries the shelter index, so the stuck clock survives a re-pick', () => {
    const ctx = makeCtx({ shelters: SHELTERS, stormActive: true, player: { x: 39, z: 0 } });
    const target = objectiveTarget({ kind: 'survive', seconds: 60 }, ROW, ctx);
    expect(target?.key).toBe('shelter:0:0');
    expect(target?.label).toBe('Cave');
  });

  it('returns null without a storm, without shelters, or with an empty list', () => {
    expect(objectiveTarget({ kind: 'survive', seconds: 60 }, ROW, makeCtx({ shelters: SHELTERS }))).toBeNull();
    expect(objectiveTarget({ kind: 'survive', seconds: 60 }, ROW, makeCtx({ stormActive: true }))).toBeNull();
    expect(
      objectiveTarget({ kind: 'survive', seconds: 60 }, ROW, makeCtx({ stormActive: true, shelters: [] })),
    ).toBeNull();
  });
});
