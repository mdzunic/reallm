// SPEC-012 §6 — the spawn director, driven with a fake spawner and frustum
// (AC-12..AC-17): population scaling and maxAlive, the ×3 objective weighting,
// the 20 s forced spawn, far-unaggroed despawn, and the wave schedule.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { Pool } from '@/core/Pool';
import { QUALITY } from '@/core/Renderer';
import { Rng, RngRoot } from '@/core/Rng';
import { ENEMIES, PLANETS, WAVES, type EnemyId } from '@/data/index';
import { makeEnemy, type EnemyEntity } from '@/entities/Enemy';
import { generateLayout, type Layout } from '@/systems/Layout';
import {
  DESPAWN_SECONDS,
  FORCED_SPAWN_SECONDS,
  RING_MAX,
  RING_MIN,
  SpawnDirector,
  populationTarget,
  pickSpawn,
  type FrustumXZ,
} from '@/systems/Spawn';

const STEP = 1 / 60;
const NOWHERE: FrustumXZ = { contains: () => false };
const PLAYER = { x: 0, z: 0 };

interface Harness {
  director: SpawnDirector;
  pool: Pool<EnemyEntity>;
  layout: Layout;
  events: EventBus<GameEvents>;
  recorded: { name: string; payload: unknown }[];
  spawned: { id: EnemyId; x: number; z: number; elite: boolean }[];
  run(seconds: number, player?: { x: number; z: number }, frustum?: FrustumXZ, wantSpawns?: boolean): void;
  living(): EnemyEntity[];
}

function harness(planet: keyof typeof PLANETS = 'cinder4', quality: keyof typeof QUALITY = 'high', seed = 5): Harness {
  const pool = new Pool(makeEnemy);
  const layout = generateLayout(PLANETS[planet], new RngRoot(seed).layout(planet));
  const events = new EventBus<GameEvents>({ dev: false });
  const recorded: { name: string; payload: unknown }[] = [];
  events.onAny((name, payload) => recorded.push({ name: name as string, payload }));
  const spawned: Harness['spawned'] = [];
  let nextId = 1;
  const spawner = {
    spawnEnemy(id: EnemyId, x: number, z: number, elite: boolean): EnemyEntity {
      const e = pool.alloc();
      e.id = nextId++;
      e.def = ENEMIES[id];
      e.x = x;
      e.z = z;
      e.elite = elite;
      e.state = ENEMIES[id].archetype === 'static' ? 'idle' : 'wander';
      e.aggro = false;
      e.hp = ENEMIES[id].hp;
      spawned.push({ id, x, z, elite });
      return e;
    },
  };
  const director = new SpawnDirector(PLANETS[planet], layout, pool, QUALITY[quality], new Rng(seed), events, spawner);
  return {
    director,
    pool,
    layout,
    events,
    recorded,
    spawned,
    run(seconds, player = PLAYER, frustum = NOWHERE, wantSpawns = true): void {
      const steps = Math.round(seconds / STEP);
      for (let i = 0; i < steps; i++) {
        director.update(STEP, player, frustum, wantSpawns);
        // The pool sweep Combat runs each step: reclaim the dead.
        for (let j = pool.size - 1; j >= 0; j--) {
          if (pool.at(j).state === 'dead') pool.free(j);
        }
      }
    },
    living(): EnemyEntity[] {
      const out: EnemyEntity[] = [];
      for (let i = 0; i < pool.size; i++) {
        if (pool.at(i).state !== 'dead') out.push(pool.at(i));
      }
      return out;
    },
  };
}

describe('SpawnDirector — population (AC-12)', () => {
  it('fills to the preset-scaled target and holds there', () => {
    const h = harness('cinder4', 'high'); // maxEnemies 32 ⇒ ×1 ⇒ P = 14
    expect(populationTarget(PLANETS.cinder4, QUALITY.high)).toBe(14);
    h.run(30);
    expect(h.director.alive).toBe(14);
    h.run(10);
    expect(h.director.alive).toBe(14);
  });

  it('scales with quality.maxEnemies', () => {
    expect(populationTarget(PLANETS.cinder4, QUALITY.low)).toBe(Math.round((14 * 12) / 32));
    expect(populationTarget(PLANETS.cinder4, QUALITY.medium)).toBe(Math.round((14 * 20) / 32));
    const h = harness('cinder4', 'low');
    h.run(30);
    expect(h.director.alive).toBe(populationTarget(PLANETS.cinder4, QUALITY.low));
  });

  it('respects each row maxAlive', () => {
    const h = harness('cinder4', 'high');
    h.run(60);
    const counts = new Map<string, number>();
    for (const e of h.living()) counts.set(e.def.id, (counts.get(e.def.id) ?? 0) + 1);
    for (const row of PLANETS.cinder4.surface.spawn) {
      expect(counts.get(row.enemy) ?? 0).toBeLessThanOrEqual(row.maxAlive);
    }
  });

  it('spawns nothing while missions veto it, and nothing on empty Eden', () => {
    const h = harness('cinder4');
    h.run(20, PLAYER, NOWHERE, false);
    expect(h.director.alive).toBe(0);
    const eden = harness('eden');
    eden.run(20);
    expect(eden.director.alive).toBe(0);
  });
});

describe('SpawnDirector — placement (AC-13)', () => {
  it('spawns on the 25–40 m ring, outside the frustum when possible', () => {
    const h = harness('cinder4', 'high');
    // Half-plane frustum: everything east of the player is "on screen".
    const east: FrustumXZ = { contains: (x) => x > PLAYER.x };
    const player = { x: 100, z: 40 }; // away from the pad's 20 m clearance
    h.run(30, player, { contains: (x) => x > player.x });
    expect(h.spawned.length).toBeGreaterThan(5);
    for (const s of h.spawned) {
      const d = Math.hypot(s.x - player.x, s.z - player.z);
      expect(d).toBeGreaterThanOrEqual(RING_MIN - 1e-9);
      expect(d).toBeLessThanOrEqual(RING_MAX + 1e-9);
      expect(s.x).toBeLessThanOrEqual(player.x); // best effort held: room exists west
    }
    void east;
  });
});

describe('SpawnDirector — objective weighting (AC-14)', () => {
  it('triples the weight of objective ids over 10 000 picks, within 10 %', () => {
    const rng = new Rng(77);
    const alive = new Map<EnemyId, number>();
    // Uncap the table so the ratio is pure weight: maxAlive never binds.
    const table = PLANETS.cinder4.surface.spawn.map((row) => ({ ...row, maxAlive: Infinity }));
    let raiders = 0;
    for (let i = 0; i < 10_000; i++) {
      if (pickSpawn(table, alive, ['scav_raider'], rng) === 'scav_raider') raiders++;
    }
    // scav_raider at weight 2×3 = 6 of 6+6+3 = 15 → 40 %.
    expect(raiders / 10_000).toBeGreaterThan(0.36);
    expect(raiders / 10_000).toBeLessThan(0.44);

    let unweighted = 0;
    for (let i = 0; i < 10_000; i++) {
      if (pickSpawn(table, alive, [], rng) === 'scav_raider') unweighted++;
    }
    // weight 2 of 11 → ≈ 18 %.
    expect(unweighted / 10_000).toBeGreaterThan(0.15);
    expect(unweighted / 10_000).toBeLessThan(0.22);
  });

  it('drops rows at their maxAlive from the pick', () => {
    const rng = new Rng(3);
    const alive = new Map<EnemyId, number>([['dust_skitter', 10]]);
    for (let i = 0; i < 200; i++) {
      expect(pickSpawn(PLANETS.cinder4.surface.spawn, alive, [], rng)).not.toBe('dust_skitter');
    }
    const full = new Map<EnemyId, number>([
      ['dust_skitter', 10],
      ['wurmling', 5],
      ['scav_raider', 4],
    ]);
    expect(pickSpawn(PLANETS.cinder4.surface.spawn, full, [], rng)).toBeNull();
  });
});

describe('SpawnDirector — forced objective spawn (AC-15)', () => {
  it('spawns an objective enemy after 20 s without one', () => {
    const h = harness('cinder4', 'low'); // small P: raiders may never roll
    h.director.setObjectiveEnemies(['scav_raider']);
    // Fill the field, then recycle every raider by walking away… instead,
    // simply count raider spawn times: after any 20 s gap one must arrive.
    h.run(FORCED_SPAWN_SECONDS - 1);
    const before = h.spawned.filter((s) => s.id === 'scav_raider').length;
    h.run(2);
    const after = h.spawned.filter((s) => s.id === 'scav_raider').length;
    expect(after).toBeGreaterThanOrEqual(Math.max(1, before));
    // And it keeps coming while the objective is starved: kill them all and
    // wait the window again.
    for (const e of h.living()) {
      if (e.def.id === 'scav_raider') e.state = 'dead';
    }
    const count = h.spawned.length;
    h.run(FORCED_SPAWN_SECONDS + 1);
    expect(h.spawned.slice(count).some((s) => s.id === 'scav_raider')).toBe(true);
  });
});

describe('SpawnDirector — despawn (AC-16)', () => {
  it('recycles far un-aggroed enemies after 10 s, and only those', () => {
    const h = harness('cinder4', 'high');
    h.run(30);
    expect(h.director.alive).toBe(14);
    // The player teleports far away: everything is now > 70 m and un-aggroed…
    const far = { x: -160, z: -160 };
    // …except one enemy that is aggroed and one that stays close.
    const kept = h.living();
    (kept[0] as EnemyEntity).aggro = true;
    const near = kept[1] as EnemyEntity;
    near.x = far.x + 10;
    near.z = far.z;

    // No new spawns (missionsWantSpawns false) so the cull is observable.
    h.run(DESPAWN_SECONDS + 1, far, NOWHERE, false);
    const left = h.living();
    expect(left).toContain(kept[0]);
    expect(left).toContain(near);
    expect(left.length).toBe(2);
  });

  it('never recycles a boss', () => {
    const h = harness('cinder4', 'high');
    h.director.spawnBoss('dune_wurm', { x: 120, z: 0 });
    h.run(DESPAWN_SECONDS + 1, { x: -160, z: -160 }, NOWHERE, false);
    expect(h.living().some((e) => e.def.id === 'dune_wurm')).toBe(true);
  });
});

describe('SpawnDirector — waves (AC-17)', () => {
  it('spawns groups on schedule and emits wave:started/cleared', () => {
    const h = harness('thessaly', 'high');
    const handle = h.director.startWave('thessaly_reaping', 'player');
    expect(h.recorded.filter((r) => r.name === 'wave:started')).toEqual([
      { name: 'wave:started', payload: { wave: 'thessaly_reaping', index: 0 } },
    ]);

    h.run(1, PLAYER, NOWHERE, false);
    expect(h.spawned.filter((s) => s.id === 'hive_drone').length).toBe(6); // atSecond 0
    h.run(20, PLAYER, NOWHERE, false);
    expect(h.spawned.filter((s) => s.id === 'spore_hound').length).toBe(4); // atSecond 20

    // Wave spawns land in the wave's own band around the player.
    for (const s of h.spawned) {
      const d = Math.hypot(s.x - PLAYER.x, s.z - PLAYER.z);
      expect(d).toBeGreaterThanOrEqual(WAVES.thessaly_reaping.spawnBand[0] - 1e-9);
      expect(d).toBeLessThanOrEqual(WAVES.thessaly_reaping.spawnBand[1] + 1e-9);
    }

    // Kill everything after the last group: cleared fires with index 0.
    h.run(35, PLAYER, NOWHERE, false); // t ≈ 56: all four groups out
    for (const e of h.living()) e.state = 'dead';
    h.run(1, PLAYER, NOWHERE, false);
    const cleared = h.recorded.filter((r) => r.name === 'wave:cleared');
    expect(cleared).toEqual([{ name: 'wave:cleared', payload: { wave: 'thessaly_reaping', index: 0 } }]);

    // The loop restarts at 70 s with index 1.
    h.run(15, PLAYER, NOWHERE, false);
    const started = h.recorded.filter((r) => r.name === 'wave:started');
    expect(started.at(-1)).toEqual({ name: 'wave:started', payload: { wave: 'thessaly_reaping', index: 1 } });

    h.director.stopWave(handle);
    const total = h.spawned.length;
    h.run(80, PLAYER, NOWHERE, false);
    expect(h.spawned.length).toBe(total); // a stopped wave spawns nothing more
  });

  it('cleared waits for every wave enemy to die, and wave enemies bypass P (12-g)', () => {
    const h = harness('eden', 'high'); // population 0: every spawn is the wave's
    h.director.startWave('eden_final', { x: 0, z: 0 });
    h.run(1, PLAYER, NOWHERE, false);
    expect(h.director.alive).toBe(8); // over Eden's P of 0
    h.run(35, PLAYER, NOWHERE, false);
    expect(h.spawned.length).toBe(12); // 8 drones + 4 warriors

    // Not cleared while the last group is unspawned or anything lives.
    expect(h.recorded.filter((r) => r.name === 'wave:cleared')).toHaveLength(0);
    h.run(170, PLAYER, NOWHERE, false); // through atSecond 200
    // The full script (47 spawns) exceeds the 32 + 8 ceiling, so a tail is
    // pending (12-g). Drain the field until the delayed spawns have spilled
    // and died too — only then may cleared fire.
    for (let round = 0; round < 5; round++) {
      for (const e of h.living()) e.state = 'dead';
      h.run(1, PLAYER, NOWHERE, false);
    }
    expect(h.recorded.filter((r) => r.name === 'wave:cleared')).toHaveLength(1);
    // eden_final does not loop: no second start.
    h.run(60, PLAYER, NOWHERE, false);
    expect(h.recorded.filter((r) => r.name === 'wave:started')).toHaveLength(1);
  });

  it('delays spawns past the hard ceiling instead of dropping them (12-g)', () => {
    const h = harness('eden', 'low'); // ceiling = 12 + 8 = 20
    h.director.startWave('eden_final', { x: 0, z: 0 });
    // Run to t≈130 where 8+4+3+10+6 = 31 want to be out; none die.
    h.run(131, PLAYER, NOWHERE, false);
    expect(h.director.alive).toBe(20); // capped at maxEnemies + 8

    // Kill five: the delayed spawns spill in, keeping the total at the cap.
    let killed = 0;
    for (const e of h.living()) {
      if (killed >= 5) break;
      e.state = 'dead';
      killed++;
    }
    h.run(2, PLAYER, NOWHERE, false);
    expect(h.director.alive).toBe(20);
  });
});
