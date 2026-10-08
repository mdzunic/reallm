// SPEC-068 (PLAN R28): traps and helpers — where the layout seed puts them
// (§4.1, E126) and what they do once the scene runs them (§4.2–§4.5,
// E127–E131). The runtime cases drive a real `Combat` through the harness,
// with the hazards' bodies in the grid as the scene puts them.
import { describe, expect, it } from 'vitest';
import { Rng, RngRoot } from '@/core/Rng';
import { DIFFICULTY_RULES, HAZARDS, PLANETS, PLANET_IDS, type HazardId, type PlanetId } from '@/data/index';
import type { HazardEntity } from '@/entities/Hazard';
import { descentPoint, descentShelter } from '@/systems/Underground';
import {
  HAZARD_ACTIVE_RADIUS,
  HAZARD_ARENA_RING,
  HAZARD_CHAIN_FUSE,
  HAZARD_GAP,
  HAZARD_PAD_CLEARING,
  HAZARD_PLAYER_GRACE,
  Hazards,
  isHelper,
  isTrap,
  placeHazards,
  type HazardSpot,
} from '@/systems/Hazards';
import {
  CORRIDOR,
  generateLayout,
  insideShelter,
  isReachable,
  layoutHash,
  ObstacleGrid,
  segmentDistance,
  type Layout,
} from '@/systems/Layout';
import { deathCause } from '@/systems/UiHelpers';
import { harness, type Harness } from './combatFixtures';

const SEEDS = [20121, 7, 99];

const layoutFor = (planet: PlanetId, seed: number): Layout => generateLayout(PLANETS[planet], new RngRoot(seed).layout(planet));

function spot(id: HazardId, x: number, z: number): HazardSpot {
  return { id, x, z, yaw: 0, scale: 1, arena: false };
}

/** A harness whose grid holds the hazards' bodies, with the hazards attached as the scene does. */
function rig(spots: readonly HazardSpot[], options?: Parameters<typeof harness>[0]): { h: Harness; hazards: Hazards } {
  const h = harness(options);
  const hazards = new Hazards(spots, h.events, new Rng(7));
  // The very bodies the hazards own, so a burst's `gone` reaches the grid.
  h.world.obstacles = new ObstacleGrid({ obstacles: [...hazards.bodies] });
  hazards.bind(h.world);
  h.combat.hazards = hazards;
  return { h, hazards };
}

/** The player far from everything, so nothing aggroes and nothing is in range by accident. */
function park(h: Harness, x = -30, z = 0): void {
  h.world.player.x = x;
  h.world.player.z = z;
}

describe('placeHazards — the layout seed (§4.1)', () => {
  it('is deterministic for a layout and never moves the layout or its hash', () => {
    for (const planet of PLANET_IDS) {
      const layout = layoutFor(planet, 20121);
      const before = layoutHash(layout);
      const obstacles = layout.obstacles.length;
      const a = placeHazards(layout, PLANETS[planet]);
      const b = placeHazards(layoutFor(planet, 20121), PLANETS[planet]);
      expect(a, planet).toEqual(b);
      expect(layoutHash(layout), planet).toBe(before);
      expect(layout.obstacles.length, planet).toBe(obstacles);
    }
  });

  it('places some of each of a planet’s three hazards, within the rows’ bounds', () => {
    for (const planet of PLANET_IDS) {
      for (const seed of SEEDS) {
        const layout = layoutFor(planet, seed);
        const spots = placeHazards(layout, PLANETS[planet]);
        const arenas = layout.pois.filter((p) => p.kind === 'arena').length;
        for (const row of PLANETS[planet].surface.hazards) {
          const n = spots.filter((s) => s.id === row.id).length;
          expect(n, `${planet}/${seed}/${row.id}`).toBeGreaterThan(0);
          expect(n).toBeLessThanOrEqual(row.groups * row.per[1] + row.arena * arenas);
        }
      }
    }
  });

  it('E126: keeps out of the pad clearing, the corridors, POIs, nodes, shelters and obstacles', () => {
    for (const planet of PLANET_IDS) {
      for (const seed of SEEDS) {
        const layout = layoutFor(planet, seed);
        const spots = placeHazards(layout, PLANETS[planet]);
        const pad = layout.pad;
        const descentAt = descentShelter(layout);
        const descent = descentAt === null ? null : descentPoint(descentAt);
        for (const s of spots) {
          const def = HAZARDS[s.id];
          const foot = isTrap(def) ? def.reach : def.radius;
          const where = `${planet}/${seed}/${s.id}@${s.x.toFixed(1)},${s.z.toFixed(1)}`;
          expect(Math.hypot(s.x - pad.x, s.z - pad.z), where).toBeGreaterThanOrEqual(HAZARD_PAD_CLEARING + foot);
          for (const poi of layout.pois) {
            if (poi.kind === 'landing_pad' || poi.kind === 'arena') continue;
            expect(Math.hypot(s.x - poi.x, s.z - poi.z), where).toBeGreaterThanOrEqual(poi.radius + foot);
            if (!s.arena) {
              expect(segmentDistance(s.x, s.z, pad.x, pad.z, poi.x, poi.z), where).toBeGreaterThanOrEqual(CORRIDOR + foot);
            }
          }
          for (const node of layout.nodes) expect(Math.hypot(s.x - node.x, s.z - node.z), where).toBeGreaterThanOrEqual(foot);
          for (const shelter of layout.shelters) expect(insideShelter(shelter, s.x, s.z, foot), where).toBe(false);
          if (descent !== null) expect(Math.hypot(s.x - descent.x, s.z - descent.z), where).toBeGreaterThan(foot);
          for (const o of layout.obstacles) {
            const gap = isHelper(def) ? HAZARD_GAP : 0;
            expect(Math.hypot(s.x - o.x, s.z - o.z), where).toBeGreaterThanOrEqual(o.radius + def.radius + gap - 1e-9);
          }
        }
        // Bodies keep a passable gap between themselves too.
        for (let i = 0; i < spots.length; i++) {
          for (let j = i + 1; j < spots.length; j++) {
            const a = spots[i] as HazardSpot;
            const b = spots[j] as HazardSpot;
            const reach = HAZARDS[a.id].radius + HAZARDS[b.id].radius + HAZARD_GAP;
            expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(reach - 1e-9);
          }
        }
      }
    }
  });

  it('puts traps outside every arena and helpers flagged `arena` inside its ring', () => {
    for (const planet of PLANET_IDS) {
      const layout = layoutFor(planet, 20121);
      const spots = placeHazards(layout, PLANETS[planet]);
      const arenaRadius = PLANETS[planet].surface.pois.find((p) => p.kind === 'arena')?.radius ?? 0;
      for (const arena of layout.pois.filter((p) => p.kind === 'arena')) {
        for (const s of spots) {
          const d = Math.hypot(s.x - arena.x, s.z - arena.z);
          if (isTrap(HAZARDS[s.id])) expect(d, `${planet} ${s.id}`).toBeGreaterThan(arenaRadius + HAZARDS[s.id].reach);
          if (s.arena) {
            expect(d).toBeGreaterThanOrEqual(arenaRadius * HAZARD_ARENA_RING[0] - 1e-9);
            expect(d).toBeLessThanOrEqual(arenaRadius * HAZARD_ARENA_RING[1] + 1e-9);
          }
        }
      }
    }
  });

  it('E126: the helpers’ bodies leave every POI reachable from the pad', () => {
    for (const planet of PLANET_IDS) {
      const layout = layoutFor(planet, 20121);
      const probe = new Hazards(placeHazards(layout, PLANETS[planet]), harness().events, new Rng(1));
      const solid = { ...layout, obstacles: [...layout.obstacles, ...probe.bodies] };
      for (const poi of layout.pois) {
        if (poi.kind === 'landing_pad') continue;
        expect(isReachable(solid, poi), `${planet} ${poi.poi}`).toBe(isReachable(layout, poi));
      }
    }
  });
});

describe('Hazards — helpers (§4.3, E128, E129)', () => {
  it('a player shot that stops on a volatile lights its fuse; it bursts for 70 % of max HP, an elite 35 %, a boss 2.5 %', () => {
    const { h, hazards } = rig([spot('fuel_drum', 0, 0)]);
    park(h);
    const near = h.spawn('dust_skitter', 2.5, 0);
    // Off the shot's line (z ≈ 0.1), so the shot reaches the drum.
    const elite = h.spawn('dust_skitter', -1.5, 2.5, true);
    const boss = h.spawn('dune_wurm', 0, -3.2);
    const far = h.spawn('dust_skitter', 0, -9);
    for (const e of [near, elite, boss, far]) e.state = 'idle';
    h.shot({ x: -6, z: 0.1, vx: 40, owner: 'player', damage: 1, ttl: 1 });
    // 5.4 m at 40 m/s: the shot meets the drum within 0.15 s, inside its fuse.
    h.run(0.2);
    const drum = hazards.list[0] as HazardEntity;
    expect(drum.state).toBe('warn');
    expect(h.of('hazard:warn')).toEqual([{ hazard: 'fuel_drum', archetype: 'volatile', x: 0, z: 0 }]);
    const before = { near: near.hp, elite: elite.hp, boss: boss.hp };
    const pins: Array<[typeof near, number, number]> = [[near, 2.5, 0], [elite, -1.5, 2.5], [boss, 0, -3.2], [far, 0, -9]];
    while (drum.state === 'warn') {
      for (const [e, x, z] of pins) {
        e.x = x;
        e.z = z;
      }
      h.step();
    }
    expect(drum.state).toBe('spent');
    expect(before.near - Math.max(0, near.hp)).toBeGreaterThanOrEqual(Math.min(before.near, Math.round(0.7 * near.maxHp)));
    expect(before.elite - elite.hp).toBe(Math.round(0.35 * elite.maxHp));
    expect(before.boss - boss.hp).toBe(Math.round(0.025 * boss.maxHp));
    expect(far.hp).toBe(far.maxHp);
    const burst = h.of('hazard:burst');
    expect(burst).toHaveLength(1);
    expect(burst[0]).toMatchObject({ hazard: 'fuel_drum', archetype: 'volatile', reach: 4.5, dirX: 0, dirZ: 0 });
    // The drum is gone: nothing stops at it any more.
    expect(h.world.obstacles.hitsCircle(0, 0, 0.3)).toBe(false);
  });

  it('a hazard kill is the player’s kill — `enemy:killed` with XP', () => {
    const { h } = rig([spot('fuel_drum', 0, 0)]);
    park(h);
    const e = h.spawn('dust_skitter', 2, 0);
    e.hp = 1;
    h.shot({ x: -6, z: 0, vx: 40, owner: 'player', damage: 1, ttl: 1 });
    h.run(0.6);
    const killed = h.of('enemy:killed');
    expect(killed).toHaveLength(1);
    expect(killed[0]?.enemyId).toBe('dust_skitter');
    expect(killed[0]?.xp).toBeGreaterThan(0);
  });

  it('an enemy shot stops at a helper without setting it off', () => {
    const { h, hazards } = rig([spot('fuel_drum', 0, 0)]);
    park(h);
    h.shot({ x: -6, z: 0, vx: 40, owner: 'enemy', enemyId: 'scav_raider', damage: 5, ttl: 1 });
    h.run(0.3);
    expect((hazards.list[0] as HazardEntity).state).toBe('idle');
    expect(h.world.projectiles.size).toBe(0);
  });

  it('a toppler falls the way the shot flew, crushes its lane and staggers what survives', () => {
    const { h, hazards } = rig([spot('balanced_rock', 0, 0)]);
    park(h, -20, 0);
    const inLane = h.spawn('dust_skitter', 5, 0.5);
    const elite = h.spawn('dust_skitter', 3, -0.8, true);
    const beside = h.spawn('dust_skitter', 4, 4);
    const behind = h.spawn('dust_skitter', -4, 3);
    for (const e of [inLane, elite, beside, behind]) e.state = 'idle';
    // Shot from the west, flying east: the rock falls east.
    h.shot({ x: -6, z: 0, vx: 40, owner: 'player', damage: 1, ttl: 1 });
    h.run(0.2);
    const rock = hazards.list[0] as HazardEntity;
    expect(rock.state).toBe('falling');
    expect(rock.dirX).toBeCloseTo(1, 6);
    expect(rock.dirZ).toBeCloseTo(0, 6);
    // Idle skitters wander; hold everyone where the test put them for the landing.
    const pins: Array<[typeof inLane, number, number]> = [[inLane, 5, 0.5], [elite, 3, -0.8], [beside, 4, 4], [behind, -4, 3]];
    while (rock.state === 'falling') {
      for (const [e, x, z] of pins) {
        e.x = x;
        e.z = z;
      }
      h.step();
    }
    expect(rock.state).toBe('spent');
    expect(inLane.state).toBe('dead');
    expect(elite.hp).toBe(elite.maxHp - Math.round(0.5 * elite.maxHp));
    expect(elite.slowMult).toBeCloseTo(0.3, 6);
    expect(elite.slowUntil).toBeGreaterThan(h.world.time);
    expect(beside.hp).toBe(beside.maxHp);
    expect(behind.hp).toBe(behind.maxHp);
    // Its stump stays solid.
    expect(h.world.obstacles.hitsCircle(0, 0, 0.3)).toBe(true);
    expect(h.of('hazard:burst')[0]).toMatchObject({ archetype: 'topple', dirX: 1, reach: 8 });
  });

  it('E129: a burst sets off the volatile, the mine and the toppler it reaches — each once', () => {
    const { h, hazards } = rig([spot('fuel_drum', 0, 0), spot('fuel_drum', 3.5, 0), spot('scav_mine', -3, 0), spot('balanced_rock', 0, 4)]);
    park(h);
    hazards.shotAt(-0.6, 0, 1, 0);
    h.run(3);
    const states = hazards.list.map((x) => x.state);
    expect(states).toEqual(['spent', 'spent', 'spent', 'spent']);
    expect(h.of('hazard:burst')).toHaveLength(4);
    // The toppler fell away from the drum that reached it: north (+z).
    const rock = hazards.list[3] as HazardEntity;
    expect(rock.dirZ).toBeGreaterThan(0.9);
    // Nothing fires twice.
    hazards.shotAt(-0.6, 0, 1, 0);
    h.run(1);
    expect(h.of('hazard:burst')).toHaveLength(4);
  });

  it('the player’s blast sets off helpers and a mine on a short fuse, and never hurts the player itself (E42)', () => {
    const { h, hazards } = rig([spot('fuel_drum', 3, 0), spot('scav_mine', -3, 0)]);
    h.world.player.x = 0;
    h.world.player.z = 9;
    h.step();
    h.combat.explode(0, 0, 4, 10, 0.4);
    const [drum, mine] = hazards.list as [HazardEntity, HazardEntity];
    expect(drum.state).toBe('warn');
    expect(mine.state).toBe('warn');
    expect(mine.hitAt - mine.startAt).toBeCloseTo(HAZARD_CHAIN_FUSE, 6);
    expect(h.of('player:damaged')).toHaveLength(0);
  });
});

describe('Hazards — what the player takes (§4.5, E127)', () => {
  function drumBeside(difficulty: 'normal' | 'story' | 'hard'): { h: Harness; hazards: Hazards } {
    const r = rig([spot('fuel_drum', 0, 0)], {
      patch: (save) => {
        save.meta.difficulty = difficulty;
      },
    });
    r.h.world.player.x = 2;
    r.h.world.player.z = 0;
    return r;
  }

  it('takes the hazard’s share of max HP × the difficulty, named as the source', () => {
    for (const difficulty of ['normal', 'hard'] as const) {
      const { h, hazards } = drumBeside(difficulty);
      const maxHp = h.world.stats.maxHp;
      hazards.shotAt(-0.6, 0, 1, 0);
      h.run(0.5);
      const hits = h.of('player:damaged');
      expect(hits, difficulty).toHaveLength(1);
      const expected = Math.round(HAZARDS.fuel_drum.player * maxHp * DIFFICULTY_RULES[difficulty].enemyDamageMult);
      expect(hits[0]?.amount).toBe(expected);
      expect(hits[0]?.source).toEqual({ kind: 'hazard', hazard: 'fuel_drum' });
    }
  });

  it('story deals nothing; the i-frames (a dash) let it pass', () => {
    const story = drumBeside('story');
    story.hazards.shotAt(-0.6, 0, 1, 0);
    story.h.run(0.5);
    expect(story.h.of('player:damaged')).toHaveLength(0);

    const dash = drumBeside('normal');
    dash.hazards.shotAt(-0.6, 0, 1, 0);
    dash.h.world.player.invulnUntil = 10;
    dash.h.run(0.5);
    expect(dash.h.of('player:damaged')).toHaveLength(0);
  });

  it('a chain hurts the player once: a second hazard hit waits out the grace', () => {
    // The player trips the first; its burst sets off the second, out of trip
    // range but close enough that its burst, 0.3 s later, covers the player too.
    const { h, hazards } = rig([spot('scav_mine', 0, 0), spot('scav_mine', 3.2, 0)]);
    h.world.player.x = 0.3;
    h.run(2);
    expect(hazards.list.every((m) => m.state === 'spent')).toBe(true);
    expect(h.of('hazard:burst')).toHaveLength(2);
    expect(h.of('player:damaged')).toHaveLength(1);
    // After the grace, the next hazard lands again.
    const more = rig([spot('scav_mine', 0, 0)]);
    more.h.world.player.x = 0.5;
    more.h.run(1.2);
    expect(more.h.of('player:damaged')).toHaveLength(1);
    expect(HAZARD_PLAYER_GRACE).toBe(1);
  });

  it('the death overlay names the hazard', () => {
    expect(deathCause({ kind: 'hazard', hazard: 'lava_vent' })).toBe('Killed by a lava vent');
  });
});

describe('Hazards — traps (§4.2, E130)', () => {
  it('a vent erupts on its cycle while the player is within the active radius, warning first', () => {
    const { h, hazards } = rig([spot('lava_vent', 0, 0)]);
    h.world.player.x = 2;
    h.world.player.z = 0;
    h.run(12);
    const warns = h.of('hazard:warn');
    const bursts = h.of('hazard:burst');
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(bursts.length).toBeGreaterThanOrEqual(1);
    expect(h.of('player:damaged').length).toBeGreaterThanOrEqual(1);
    expect((hazards.list[0] as HazardEntity).state === 'idle' || (hazards.list[0] as HazardEntity).state === 'warn').toBe(true);
  });

  it('a vent warns 1.2 s, and ×1.25 on an assisted difficulty', () => {
    const { h, hazards } = rig([spot('lava_vent', 0, 0)]);
    h.world.player.x = 10;
    const vent = hazards.list[0] as HazardEntity;
    for (let i = 0; i < 60 * 12 && vent.state !== 'warn'; i++) h.step();
    expect(vent.hitAt - vent.startAt).toBeCloseTo(1.2, 6);
    const casual = rig([spot('lava_vent', 0, 0)], {
      patch: (save) => {
        save.meta.difficulty = 'casual';
      },
    });
    casual.h.world.player.x = 10;
    const slow = casual.hazards.list[0] as HazardEntity;
    for (let i = 0; i < 60 * 12 && slow.state !== 'warn'; i++) casual.h.step();
    expect(slow.hitAt - slow.startAt).toBeCloseTo(1.5, 6);
  });

  it('E130: beyond the active radius a vent never warns and a mine never trips', () => {
    const { h } = rig([spot('cryo_geyser', 0, 0), spot('scav_mine', 10, 0)]);
    park(h, HAZARD_ACTIVE_RADIUS + 30, 0);
    const e = h.spawn('dust_skitter', 10, 0);
    e.state = 'idle';
    h.run(15);
    expect(h.of('hazard:warn')).toHaveLength(0);
  });

  it('a mine trips on a walking enemy or the player, not a static one, and goes once', () => {
    const { h, hazards } = rig([spot('scav_mine', 0, 0), spot('scav_mine', 20, 0)]);
    h.world.player.x = 10;
    const egg = h.spawn('hive_egg', 20.5, 0);
    egg.state = 'idle';
    const skitter = h.spawn('dust_skitter', 0.8, 0);
    skitter.state = 'idle';
    h.step();
    const [first, second] = hazards.list as [HazardEntity, HazardEntity];
    expect(first.state).toBe('warn');
    expect(second.state).toBe('idle');
    h.run(1.2);
    expect(first.state).toBe('spent');
    // The player walks onto the second.
    h.world.player.x = 20;
    h.world.player.z = 1;
    h.step();
    expect(second.state).toBe('warn');
  });

  it('E130: the descent drops a lit fuse without effect, and the helper stands again', () => {
    const { h, hazards } = rig([spot('fuel_drum', 0, 0)]);
    park(h);
    hazards.shotAt(-0.6, 0, 1, 0);
    h.step();
    h.combat.clearLevel();
    expect((hazards.list[0] as HazardEntity).state).toBe('idle');
    expect(hazards.warnings.size).toBe(0);
    h.run(1);
    expect(h.of('hazard:burst')).toHaveLength(0);
    expect(h.world.obstacles.hitsCircle(0, 0, 0.3)).toBe(true);
  });

  it('rebuilds the view’s warnings each step — a circle per fuse, a lane per fall', () => {
    const { h, hazards } = rig([spot('fuel_drum', 0, 0), spot('balanced_rock', 12, 0)]);
    park(h);
    hazards.shotAt(-0.6, 0, 1, 0);
    hazards.shotAt(11, 0, 1, 0);
    h.step();
    const kinds = Array.from({ length: hazards.warnings.size }, (_, i) => hazards.warnings.at(i).kind).sort();
    expect(kinds).toEqual(['circle', 'line']);
    h.run(1);
    expect(hazards.warnings.size).toBe(0);
  });
});
