// SPEC-012 §6 — the spawn director, driven with a fake spawner and frustum
// (AC-12..AC-17): population scaling and maxAlive, the ×3 objective weighting,
// the 20 s forced spawn, far-unaggroed despawn, and the wave schedule.
// SPEC-041 §6.1 adds packs: their sizes and caps, E64's dropped member, one
// elite roll per pack and its rate per roll, no packs under a ramp, E14 single,
// and pack aggro.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { Pool } from '@/core/Pool';
import { QUALITY } from '@/core/Renderer';
import { Rng, RngRoot } from '@/core/Rng';
import { AFFIXES, ENEMIES, PLANETS, WAVES, type AffixId, type EnemyId } from '@/data/index';
import { makeEnemy, type EnemyEntity } from '@/entities/Enemy';
import { generateLayout, type Layout } from '@/systems/Layout';
import {
  DESPAWN_SECONDS,
  ELITE_CHANCE_CAP,
  FORCED_SPAWN_SECONDS,
  PACK_OVERSHOOT,
  PACK_RADIUS,
  RING_MAX,
  RING_MIN,
  SpawnDirector,
  populationTarget,
  pickSpawn,
  type FrustumXZ,
} from '@/systems/Spawn';
import { harness as combatHarness } from './combatFixtures';

const STEP = 1 / 60;
const NOWHERE: FrustumXZ = { contains: () => false };
const PLAYER = { x: 0, z: 0 };

interface Harness {
  director: SpawnDirector;
  pool: Pool<EnemyEntity>;
  layout: Layout;
  events: EventBus<GameEvents>;
  recorded: { name: string; payload: unknown }[];
  /**
   * Every spawn in order. The director stamps `packId` on the entity after
   * `spawnEnemy` returns, and a freed slot is reused, so `step()` copies it
   * here at the end of the update that made it (-1 until then).
   */
  spawned: {
    id: EnemyId;
    x: number;
    z: number;
    elite: boolean;
    affixA: AffixId | null;
    affixB: AffixId | null;
    entity: EnemyEntity;
    packId: number;
  }[];
  /** One director update, then the packIds of what it spawned. */
  step(player?: { x: number; z: number }, frustum?: FrustumXZ, wantSpawns?: boolean): void;
  run(seconds: number, player?: { x: number; z: number }, frustum?: FrustumXZ, wantSpawns?: boolean): void;
  living(): EnemyEntity[];
}

function harness(planet: keyof typeof PLANETS = 'cinder4', quality: keyof typeof QUALITY = 'high', seed = 5, shelters = true): Harness {
  const pool = new Pool(makeEnemy);
  const generated = generateLayout(PLANETS[planet], new RngRoot(seed).layout(planet));
  // SPEC-041 §6.1: the pack-size cases stand on open ground, where E64 has
  // nothing to drop a member for.
  const layout: Layout = shelters ? generated : { ...generated, shelters: [] };
  const events = new EventBus<GameEvents>({ dev: false });
  const recorded: { name: string; payload: unknown }[] = [];
  events.onAny((name, payload) => recorded.push({ name: name as string, payload }));
  const spawned: Harness['spawned'] = [];
  let nextId = 1;
  const spawner = {
    spawnEnemy(id: EnemyId, x: number, z: number, elite: boolean, affixA: AffixId | null = null, affixB: AffixId | null = null): EnemyEntity {
      const e = pool.alloc();
      e.id = nextId++;
      e.def = ENEMIES[id];
      e.x = x;
      e.z = z;
      e.elite = elite;
      e.state = ENEMIES[id].archetype === 'static' ? 'idle' : 'wander';
      e.aggro = false;
      e.hp = ENEMIES[id].hp;
      e.fromWave = false; // mirrors Combat.spawnEnemy's pooled reset (SPEC-030)
      e.summonedBy = 0; // …and SPEC-034 §4.6's
      e.spawnX = x;
      e.spawnZ = z;
      e.affixA = affixA;
      e.affixB = affixB;
      spawned.push({ id, x, z, elite, affixA, affixB, entity: e, packId: -1 });
      return e;
    },
  };
  const director = new SpawnDirector(PLANETS[planet], layout, pool, QUALITY[quality], new Rng(seed), events, spawner);
  let stamped = 0;
  const step = (player = PLAYER, frustum = NOWHERE, wantSpawns = true): void => {
    director.update(STEP, player, frustum, wantSpawns);
    for (; stamped < spawned.length; stamped++) {
      const record = spawned[stamped] as Harness['spawned'][number];
      record.packId = record.entity.packId;
    }
  };
  return {
    director,
    pool,
    layout,
    events,
    recorded,
    spawned,
    step,
    run(seconds, player = PLAYER, frustum = NOWHERE, wantSpawns = true): void {
      const steps = Math.round(seconds / STEP);
      for (let i = 0; i < steps; i++) {
        step(player, frustum, wantSpawns);
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
  // SPEC-041 §4.5: a pack may carry the field past the target, by at most
  // `PACK_OVERSHOOT` — the target is a floor the director refills, not a cap.
  it('fills to the planet target and holds there, a pack carrying it at most 4 past', () => {
    const h = harness('cinder4', 'high'); // SPEC-038 §4.4: P = 10 on every preset
    expect(populationTarget(PLANETS.cinder4, QUALITY.high)).toBe(10);
    h.run(30);
    expect(h.director.alive).toBeGreaterThanOrEqual(10);
    expect(h.director.alive).toBeLessThanOrEqual(10 + PACK_OVERSHOOT);
    const held = h.director.alive;
    h.run(10);
    expect(h.director.alive).toBe(held);
  });

  it('is the design count on every preset, capped by quality.maxEnemies (SPEC-038 §4.4)', () => {
    // Cinder-4 was 14 on high, 9 on medium and 5 on low; the device no longer
    // decides how hard the planet is.
    for (const preset of ['low', 'medium', 'high'] as const) {
      expect(populationTarget(PLANETS.cinder4, QUALITY[preset]), preset).toBe(10);
      for (const planet of Object.values(PLANETS)) {
        expect(populationTarget(planet, QUALITY[preset]), `${planet.id} on ${preset}`).toBe(
          Math.min(planet.surface.population, QUALITY[preset].maxEnemies),
        );
      }
    }
    // The Hive's 15 is the one design count a preset cuts: 12 on low.
    expect(populationTarget(PLANETS.hive, QUALITY.low)).toBe(12);
    expect(populationTarget(PLANETS.hive, QUALITY.medium)).toBe(15);
    // Review 2026-10 (G-07): Vetra 11 → 13, out of its trough; `low` caps it
    // at 12, as it does Ferrum's 13.
    expect(populationTarget(PLANETS.vetra, QUALITY.medium)).toBe(13);
    expect(populationTarget(PLANETS.vetra, QUALITY.low)).toBe(12);
    const h = harness('cinder4', 'low');
    h.run(30);
    expect(h.director.alive).toBeGreaterThanOrEqual(populationTarget(PLANETS.cinder4, QUALITY.low));
    expect(h.director.alive).toBeLessThanOrEqual(populationTarget(PLANETS.cinder4, QUALITY.low) + PACK_OVERSHOOT);
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
    // SPEC-041 §4.5: a single or a pack's leader stands on the ring point
    // `#place` cleared; the members within `PACK_RADIUS` of it.
    const leaders = new Map<number, { x: number; z: number }>();
    for (const s of h.spawned) {
      const pack = s.packId;
      const leader = pack === 0 ? undefined : leaders.get(pack);
      if (leader !== undefined) {
        expect(Math.hypot(s.x - leader.x, s.z - leader.z)).toBeLessThanOrEqual(PACK_RADIUS + 1e-9);
        continue;
      }
      if (pack !== 0) leaders.set(pack, { x: s.x, z: s.z });
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
    expect(h.director.alive).toBeGreaterThanOrEqual(10);
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


// ------------------------------------------------------------- SPEC-030

describe('SPEC-030 — waves flag their enemies and spawns avoid shelters (AC-29)', () => {
  it('wave spawns carry fromWave = true; ambient ones false', () => {
    const h = harness('cinder4', 'high');
    h.run(5); // ambient fill
    for (const e of h.living()) expect(e.fromWave).toBe(false);
    const ambientCount = h.living().length;
    h.director.startWave('thessaly_reaping', { x: 0, z: 0 });
    h.run(6); // the wave's groups spawn on their schedule
    const flagged = h.living().filter((e) => e.fromWave);
    expect(flagged.length).toBeGreaterThan(0);
    // Ambient enemies spawned before and after keep false.
    expect(h.living().filter((e) => !e.fromWave).length).toBeGreaterThanOrEqual(ambientCount);
  });

  it('#place rejects candidates within max(rx, rz) + 4 of a shelter centre', () => {
    const h = harness('cinder4', 'high');
    const shelters = h.layout.shelters;
    expect(shelters.length).toBeGreaterThan(0);
    // Park the player beside a shelter so the 25–40 m ring sweeps across it.
    const s = shelters[0] as (typeof shelters)[number];
    const player = { x: s.x + 30, z: s.z };
    h.run(60, player);
    // SPEC-038 §4.4: Cinder-4 fields 10, so the sweep is its full field.
    expect(h.spawned.length).toBeGreaterThanOrEqual(10);
    for (const spawn of h.spawned) {
      for (const shelter of shelters) {
        expect(
          Math.hypot(spawn.x - shelter.x, spawn.z - shelter.z),
          `spawn at ${spawn.x},${spawn.z}`,
        ).toBeGreaterThanOrEqual(Math.max(shelter.rx, shelter.rz) + 4 - 1e-9);
      }
    }
  });
});

// ---------------------------------------------------------------- SPEC-034

/**
 * SPEC-034 §4.8 — a wave *is* the attack.
 *
 * Eden's finale spawned un-aggroed on a 30–55 m ring and leashed to its own
 * spawn point, so in simulation 0 of 47 enemies came in and the beacon took no
 * damage in 240 s: the last fight of the campaign was a four-minute wait. A wave
 * enemy now comes in aggroed, anchored at the wave's centre, and the far-straggler
 * cull leaves it alone.
 */
describe('waves attack (SPEC-034 §4.8)', () => {
  it('a wave enemy spawns aggroed and anchored at the wave centre', () => {
    const h = harness('eden', 'high');
    const centre = { x: 12, z: -8 };
    h.director.startWave('eden_final', centre);
    h.run(1, PLAYER, NOWHERE, false);
    const wave = h.living().filter((e) => e.fromWave);
    expect(wave.length).toBeGreaterThan(0);
    for (const e of wave) {
      expect(e.aggro).toBe(true);
      expect(e.spawnX).toBe(centre.x);
      expect(e.spawnZ).toBe(centre.z);
    }
  });

  it("a 'player' wave anchors at where the player stood when it spawned", () => {
    const h = harness('eden', 'high');
    const player = { x: -30, z: 40 };
    h.director.startWave('eden_final', 'player');
    h.run(1, player, NOWHERE, false);
    for (const e of h.living().filter((entity) => entity.fromWave)) {
      expect(e.spawnX).toBe(player.x);
      expect(e.spawnZ).toBe(player.z);
    }
  });

  it("eden_final's band is 25–40 m, so the wave arrives inside aggro range", () => {
    expect(WAVES.eden_final.spawnBand).toEqual([25, 40]);
    const h = harness('eden', 'high');
    h.director.startWave('eden_final', { x: 0, z: 0 });
    h.run(1, PLAYER, NOWHERE, false);
    for (const spawn of h.spawned) {
      const d = Math.hypot(spawn.x, spawn.z);
      expect(d).toBeGreaterThanOrEqual(25 - 1e-6);
      expect(d).toBeLessThanOrEqual(40 + 1e-6);
    }
  });

  it('#cullFar never recycles a wave enemy', () => {
    const h = harness('eden', 'high');
    h.director.startWave('eden_final', { x: 0, z: 0 });
    h.run(1, PLAYER, NOWHERE, false);
    const wave = h.living().filter((e) => e.fromWave);
    expect(wave.length).toBeGreaterThan(0);
    // Far *and* un-aggroed for well past `DESPAWN_SECONDS`: the two conditions
    // the cull recycles on. An ambient enemy in the same state would be gone.
    for (const e of wave) {
      e.x = 400;
      e.z = 0;
      e.aggro = false;
    }
    h.run(DESPAWN_SECONDS + 2, PLAYER, NOWHERE, false);
    expect(h.living().filter((e) => e.fromWave).length).toBe(wave.length);
  });

  it('stopWave with dismiss recycles the survivors silently, with their burst', () => {
    const h = harness('eden', 'high');
    const handle = h.director.startWave('eden_final', { x: 0, z: 0 });
    h.run(1, PLAYER, NOWHERE, false);
    const before = h.living().length;
    expect(before).toBeGreaterThan(0);
    const dismissed = h.director.stopWave(handle, { dismiss: true });
    expect(dismissed).toBe(before);
    expect(h.living()).toEqual([]);
    // No kill, no XP, no loot — one burst each and nothing else.
    expect(h.recorded.filter((r) => r.name === 'enemy:killed')).toEqual([]);
    expect(h.recorded.filter((r) => r.name === 'enemy:dismissed')).toHaveLength(before);
  });

  it('stopWave without dismiss leaves the survivors alone', () => {
    const h = harness('eden', 'high');
    const handle = h.director.startWave('eden_final', { x: 0, z: 0 });
    h.run(1, PLAYER, NOWHERE, false);
    const before = h.living().length;
    expect(h.director.stopWave(handle)).toBe(0);
    expect(h.living()).toHaveLength(before);
    expect(h.recorded.filter((r) => r.name === 'enemy:dismissed')).toEqual([]);
  });

  /**
   * SPEC-034 §4.6, E57 / 34-d: the Queen's twelve drones kept attacking through
   * the modal lines her death plays. They leave with her, before the Warden
   * speaks, and no damage lands after the death.
   */
  it('dismissSummons takes a boss’s living summons and nothing else', () => {
    // Cinder-4, whose population fills the field: Eden's is 0 by design.
    const h = harness('cinder4', 'high');
    h.run(6); // a few ambient enemies, which belong to no boss
    const ambient = h.living().length;
    expect(ambient).toBeGreaterThan(0);
    // Two bosses' worth of summons, stamped the way `Combat.#summonRing` does.
    const summons = h.living();
    for (let i = 0; i < 3; i++) (summons[i] as EnemyEntity).summonedBy = 77;
    (summons[3] as EnemyEntity).summonedBy = 99;

    expect(h.director.dismissSummons(77)).toBe(3);
    expect(h.living()).toHaveLength(ambient - 3);
    expect(h.recorded.filter((r) => r.name === 'enemy:killed')).toEqual([]);
    expect(h.recorded.filter((r) => r.name === 'enemy:dismissed')).toHaveLength(3);
    // The other boss's summon is untouched, and a second call takes nothing.
    expect(h.director.dismissSummons(77)).toBe(0);
    expect(h.living().some((e) => e.summonedBy === 99)).toBe(true);
  });
});

// --------------------------------------------- SPEC-035 §4.7: the first landing

describe('SpawnDirector — the first-visit ramp (SPEC-035 §4.7)', () => {
  it('halves the ambient target and lets it back up when the ramp clears', () => {
    const h = harness('cinder4', 'high'); // SPEC-038 §4.4: P = 10
    expect(h.director.populationTarget).toBe(10);
    h.director.setRamp({ populationScale: 0.5, excludeArchetypes: ['rusher'] });
    // The first visit keeps 5 (it was 14 → 7).
    expect(h.director.populationTarget).toBe(5);
    h.run(60);
    expect(h.director.alive).toBe(5);
    h.director.setRamp(null);
    expect(h.director.populationTarget).toBe(10);
    h.run(30);
    // SPEC-041 §4.5: with the ramp gone, packs return — and may overshoot.
    expect(h.director.alive).toBeGreaterThanOrEqual(10);
    expect(h.director.alive).toBeLessThanOrEqual(10 + PACK_OVERSHOOT);
  });

  it('never rounds the target below one', () => {
    const h = harness('cinder4', 'low');
    h.director.setRamp({ populationScale: 0.01, excludeArchetypes: [] });
    expect(h.director.populationTarget).toBe(1);
  });

  it('never draws an excluded archetype ambiently over 10 000 picks', () => {
    const rng = new Rng(9);
    const alive = new Map<EnemyId, number>();
    const drawn = new Set<EnemyId | null>();
    for (let i = 0; i < 10_000; i++) {
      drawn.add(pickSpawn(PLANETS.cinder4.surface.spawn, alive, [], rng, [], ['rusher']));
    }
    // `wurmling` is Cinder-4's rusher; the other two rows still come up.
    expect(drawn.has('wurmling')).toBe(false);
    expect(drawn.has('dust_skitter')).toBe(true);
    expect(drawn.has('scav_raider')).toBe(true);
  });

  it('spawns no excluded archetype through a whole ramped run', () => {
    const h = harness('cinder4', 'high');
    h.director.setRamp({ populationScale: 0.5, excludeArchetypes: ['rusher'] });
    h.run(120);
    expect(h.spawned.some((s) => s.id === 'wurmling')).toBe(false);
    expect(h.spawned.length).toBeGreaterThan(0);
  });

  it('still force-spawns an excluded archetype the mission asked for (E14)', () => {
    const h = harness('cinder4', 'high');
    h.director.setRamp({ populationScale: 0.5, excludeArchetypes: ['rusher'] });
    h.director.setObjectiveEnemies(['wurmling']);
    h.run(FORCED_SPAWN_SECONDS + 1);
    expect(h.spawned.some((s) => s.id === 'wurmling')).toBe(true);
  });
});

// ------------------------------------------------------------- SPEC-041 §4.5

/** The spawns grouped into rolls: a pack is one roll, a single is one. */
function rollsOf(spawned: Harness['spawned']): Harness['spawned'][number][][] {
  const rolls: Harness['spawned'][number][][] = [];
  const byPack = new Map<number, Harness['spawned'][number][]>();
  for (const s of spawned) {
    const pack = s.packId;
    const open = pack === 0 ? undefined : byPack.get(pack);
    if (open !== undefined) {
      open.push(s);
      continue;
    }
    const roll = [s];
    rolls.push(roll);
    if (pack !== 0) byPack.set(pack, roll);
  }
  return rolls;
}

/** Run the director with the field killed off every step, so it spawns a roll every 0.5 s. */
function churn(h: Harness, seconds: number, player = { x: 100, z: 40 }): void {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    h.step(player, NOWHERE, true);
    for (let j = h.pool.size - 1; j >= 0; j--) h.pool.free(j);
  }
}

describe('SpawnDirector — packs (SPEC-041 §4.5)', () => {
  it('a pack row spawns between its min and max around one point, sharing one packId', () => {
    const h = harness('cinder4', 'high', 5, false);
    churn(h, 120);
    const rolls = rollsOf(h.spawned);
    const sizes = new Map<EnemyId, Set<number>>();
    for (const roll of rolls) {
      const lead = roll[0] as Harness['spawned'][number];
      const row = PLANETS.cinder4.surface.spawn.find((r) => r.enemy === lead.id);
      const pack = (row as { pack?: readonly [number, number] } | undefined)?.pack;
      for (const member of roll) expect(member.id).toBe(lead.id);
      if (pack === undefined) {
        // Ranged rows come alone.
        expect(roll).toHaveLength(1);
        expect(lead.packId).toBe(0);
        continue;
      }
      // An empty field caps nothing: every pack is its rolled size.
      expect(roll.length).toBeGreaterThanOrEqual(pack[0]);
      expect(roll.length).toBeLessThanOrEqual(pack[1]);
      expect(lead.packId).toBeGreaterThan(0);
      const seen = sizes.get(lead.id) ?? new Set<number>();
      seen.add(roll.length);
      sizes.set(lead.id, seen);
    }
    expect([...(sizes.get('dust_skitter') ?? [])].sort()).toEqual([3, 4, 5]);
    expect([...(sizes.get('wurmling') ?? [])].sort()).toEqual([1, 2]);
  });

  it('the Hive’s drones come in fours to sixes', () => {
    const h = harness('hive', 'high', 5, false);
    churn(h, 120);
    const drones = rollsOf(h.spawned).filter((roll) => roll[0]?.id === 'hive_drone');
    expect(drones.length).toBeGreaterThan(10);
    for (const roll of drones) {
      expect(roll.length).toBeGreaterThanOrEqual(4);
      expect(roll.length).toBeLessThanOrEqual(6);
    }
  });

  it('caps a pack by the row’s maxAlive room and by P + 4', () => {
    // maxAlive: 8 skitters alive leave room for 2 of Cinder-4's 10.
    const h = harness('cinder4', 'high');
    for (let i = 0; i < 8; i++) {
      const e = h.pool.alloc();
      Object.assign(e, makeEnemy(), { id: 10_000 + i, def: ENEMIES.dust_skitter, state: 'wander', x: 300, z: 300 });
    }
    // A table where only the skitter row can come up.
    const only = { ...PLANETS.cinder4, surface: { ...PLANETS.cinder4.surface, spawn: [PLANETS.cinder4.surface.spawn[0]] } };
    const capped = new SpawnDirector(only as never, h.layout, h.pool, QUALITY.high, new Rng(11), h.events, {
      spawnEnemy: (id: EnemyId, x: number, z: number) => {
        const e = h.pool.alloc();
        Object.assign(e, makeEnemy(), { id: h.pool.size + 20_000, def: ENEMIES[id], state: 'wander', x, z });
        return e;
      },
    });
    capped.update(STEP, { x: 100, z: 40 }, NOWHERE, true);
    let skitters = 0;
    for (let i = 0; i < h.pool.size; i++) if (h.pool.at(i).def.id === 'dust_skitter') skitters++;
    expect(skitters).toBe(10);

    // P + 4: with the field at 9 of 10, a pack brings it to 14 at most.
    const p = harness('cinder4', 'high');
    for (let i = 0; i < 9; i++) {
      const e = p.pool.alloc();
      Object.assign(e, makeEnemy(), { id: 30_000 + i, def: ENEMIES.scav_raider, state: 'wander', x: 300, z: 300 });
    }
    const field = new SpawnDirector(only as never, p.layout, p.pool, QUALITY.high, new Rng(12), p.events, {
      spawnEnemy: (id: EnemyId, x: number, z: number) => {
        const e = p.pool.alloc();
        Object.assign(e, makeEnemy(), { id: p.pool.size + 40_000, def: ENEMIES[id], state: 'wander', x, z });
        return e;
      },
    });
    for (let i = 0; i < 200; i++) field.update(STEP, { x: 100, z: 40 }, NOWHERE, true);
    expect(field.alive).toBeGreaterThan(9);
    expect(field.alive).toBeLessThanOrEqual(10 + PACK_OVERSHOOT);
  });

  it('drops a member whose point is blocked, and keeps the leader on its cleared point (E64)', () => {
    const h = harness('cinder4', 'high');
    // Rocks everywhere a skitter's own circle could stand, but none in the
    // leader's wider placement check: every member is blocked.
    h.director.setObstacles({ circleHits: (_x, _z, r) => r < ENEMIES.dust_skitter.radius + 0.25 });
    churn(h, 60);
    const skitters = rollsOf(h.spawned).filter((roll) => roll[0]?.id === 'dust_skitter');
    expect(skitters.length).toBeGreaterThan(3);
    for (const roll of skitters) expect(roll).toHaveLength(1);
  });

  it('rolls the elite once per pack, for its leader alone, with its affixes', () => {
    const h = harness('ferrum', 'high', 21);
    churn(h, 900);
    let elites = 0;
    for (const roll of rollsOf(h.spawned)) {
      roll.forEach((member, k) => {
        if (k > 0) {
          expect(member.elite).toBe(false);
          expect(member.affixA).toBeNull();
        }
      });
      const lead = roll[0] as Harness['spawned'][number];
      if (!lead.elite) {
        expect(lead.affixA).toBeNull();
        continue;
      }
      elites++;
      // Ferrum is chapter 4: two distinct affixes from the archetype's pool.
      expect(lead.affixA).not.toBeNull();
      expect(lead.affixB).not.toBeNull();
      expect(lead.affixA).not.toBe(lead.affixB);
      for (const affix of [lead.affixA, lead.affixB] as AffixId[]) {
        expect(AFFIXES[affix].archetypes as readonly string[]).toContain(ENEMIES[lead.id].archetype);
      }
    }
    expect(elites).toBeGreaterThan(10);
  });

  it('finds elites on 5 % ± 1.5 % of ≥ 2,000 Cinder-4 rolls (SPEC-011 AC-40, per roll)', () => {
    const h = harness('cinder4', 'high', 8);
    churn(h, 1100);
    const rolls = rollsOf(h.spawned);
    expect(rolls.length).toBeGreaterThanOrEqual(2000);
    const elites = rolls.filter((roll) => roll[0]?.elite === true).length;
    const rate = elites / rolls.length;
    expect(rate, `${elites} of ${rolls.length}`).toBeGreaterThanOrEqual(0.035);
    expect(rate, `${elites} of ${rolls.length}`).toBeLessThanOrEqual(0.065);
    // Chapter 1: one affix each.
    for (const roll of rolls) {
      const lead = roll[0] as Harness['spawned'][number];
      if (lead.elite) {
        expect(lead.affixA).not.toBeNull();
        expect(lead.affixB).toBeNull();
      }
    }
  });

  it('spawns no packs while a SPEC-035 ramp is set', () => {
    const h = harness('cinder4', 'high');
    h.director.setRamp({ populationScale: 1, excludeArchetypes: [] });
    churn(h, 60);
    expect(h.spawned.length).toBeGreaterThan(50);
    for (const s of h.spawned) expect(s.packId).toBe(0);
    expect(rollsOf(h.spawned).every((roll) => roll.length === 1)).toBe(true);
  });

  it('keeps E14’s forced objective spawn single', () => {
    const h = harness('cinder4', 'low');
    // The field already holds its target in raiders, so nothing ambient
    // comes: only E14 can bring the starved skitter.
    for (let i = 0; i < 12; i++) {
      const e = h.pool.alloc();
      // Close enough to the player that the far-cull never takes them.
      Object.assign(e, makeEnemy(), { id: 50_000 + i, def: ENEMIES.scav_raider, state: 'wander', x: 110, z: 40 });
    }
    h.director.setObjectiveEnemies(['dust_skitter']);
    h.run(FORCED_SPAWN_SECONDS + 1, { x: 100, z: 40 });
    const skitters = h.spawned.filter((s) => s.id === 'dust_skitter');
    expect(skitters).toHaveLength(1);
    for (const s of skitters) expect(s.packId).toBe(0);
  });

  it('wave groups keep their counts and their elite flags, and their elites roll affixes', () => {
    const h = harness('eden', 'high');
    h.director.startWave('eden_final', { x: 0, z: 0 });
    h.run(1, PLAYER, NOWHERE, false);
    expect(h.spawned).toHaveLength(8);
    for (const s of h.spawned) expect(s.packId).toBe(0);
    const elites = h.spawned.filter((s) => s.elite);
    for (const s of elites) {
      expect(s.affixA).not.toBeNull();
      expect(s.affixB).not.toBeNull(); // Eden is chapter 6
    }
  });

  it('counts the distinct live packs', () => {
    const h = harness('cinder4', 'high');
    h.run(30);
    const packs = new Set<number>();
    for (const e of h.living()) if (e.packId > 0) packs.add(e.packId);
    expect(h.director.packs).toBe(packs.size);
    expect(h.director.packs).toBeGreaterThan(0);
  });
});

describe('pack aggro (SPEC-041 §4.5)', () => {
  it('a member that acquires the player by proximity aggroes the whole pack', () => {
    const h = combatHarness();
    const pack = [h.spawn('dust_skitter', 19, 0), h.spawn('dust_skitter', 21, 0), h.spawn('dust_skitter', 22, 1)];
    for (const e of pack) {
      e.packId = 7;
      e.wanderX = e.x;
      e.wanderZ = e.z;
      e.wanderAt = Infinity;
    }
    const stranger = h.spawn('dust_skitter', 22, -1); // no pack
    stranger.wanderAt = Infinity;
    // Only the first is inside the skitter's 18 m aggro radius… after it walks in.
    h.world.player.x = 1;
    h.step();
    expect(pack[0]?.aggro).toBe(true);
    expect(pack[1]?.aggro).toBe(true);
    expect(pack[2]?.aggro).toBe(true);
    expect(stranger.aggro).toBe(false);
  });
});

// ------------------------------------------------------------- SPEC-043 §4.4

describe('SpawnDirector — eliteMult and the swarm (SPEC-043 §4.3, §4.4)', () => {
  /** The share of ambient rolls — a single or a pack's leader — that came up elite. */
  function eliteRate(mult: number, seconds: number): { rate: number; rolls: number } {
    const h = harness('cinder4', 'high', 8);
    h.director.eliteMult = mult;
    churn(h, seconds);
    const rolls = rollsOf(h.spawned);
    return { rate: rolls.filter((roll) => roll[0]?.elite === true).length / rolls.length, rolls: rolls.length };
  }

  it('eliteMult 2 doubles the ambient elite rate over 10 000 seeded rolls', () => {
    const base = eliteRate(1, 5600);
    const doubled = eliteRate(2, 5600);
    expect(base.rolls).toBeGreaterThanOrEqual(10_000);
    expect(doubled.rolls).toBeGreaterThanOrEqual(10_000);
    // Cinder-4's 5 %, and 10 % at ×2 — each within a percentage point.
    expect(Math.abs(base.rate - 0.05), `${base.rate}`).toBeLessThanOrEqual(0.01);
    expect(Math.abs(doubled.rate - 0.1), `${doubled.rate}`).toBeLessThanOrEqual(0.01);
    expect(doubled.rate / base.rate).toBeGreaterThan(1.7);
    expect(doubled.rate / base.rate).toBeLessThan(2.3);
  });

  it('the chance is capped at 0.5 however much multiplies it (43-g)', () => {
    const hive = harness('hive', 'high');
    expect(hive.director.eliteChance).toBe(PLANETS.hive.surface.eliteChance);
    // Hard ×2 with elite_surge ×4 on the Hive: 0.08 × 8 = 0.64 → 0.5.
    hive.director.eliteMult = 2 * 4;
    expect(hive.director.eliteChance).toBe(ELITE_CHANCE_CAP);
    expect(ELITE_CHANCE_CAP).toBe(0.5);
    const capped = eliteRate(40, 5600);
    expect(Math.abs(capped.rate - 0.5), `${capped.rate}`).toBeLessThanOrEqual(0.02);
  });

  it('setRamp({ populationScale: 1.5 }) raises the target, still capped by maxEnemies', () => {
    const high = harness('cinder4', 'high'); // P = 10, maxEnemies 32
    high.director.setRamp({ populationScale: 1.5, excludeArchetypes: [] });
    expect(high.director.populationTarget).toBe(15);
    high.director.setRamp(null);
    expect(high.director.populationTarget).toBe(10);
    const low = harness('cinder4', 'low'); // maxEnemies 12
    low.director.setRamp({ populationScale: 1.5, excludeArchetypes: [] });
    expect(low.director.populationTarget).toBe(QUALITY.low.maxEnemies);
  });

  it('the swarm’s field fills to its raised target, and its pack rows still come as packs', () => {
    const h = harness('cinder4', 'high');
    h.director.setRamp({ populationScale: 1.5, excludeArchetypes: [] });
    h.run(60);
    expect(h.director.alive).toBeGreaterThanOrEqual(15);
    expect(h.director.alive).toBeLessThanOrEqual(15 + PACK_OVERSHOOT);
    expect(h.spawned.some((s) => s.packId > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------- SPEC-053

import { ObstacleGrid } from '@/systems/Layout';

describe('ring spawns among the groves (SPEC-053 §6.1, E81)', () => {
  it('500 ring spawns on Thessaly (seed 5) never stand inside an obstacle circle', () => {
    const h = harness('thessaly', 'high', 5);
    // The scene hands the director its obstacle grid; the trunks are in it.
    h.director.setObstacles(new ObstacleGrid(h.layout));
    // Stand in the middle of the biggest grove, so the 25–40 m ring sweeps the trees.
    const grove = [...h.layout.features].filter((f) => f.kind === 'grove').sort((a, b) => b.pieces - a.pieces)[0];
    expect(grove).toBeDefined();
    const player = { x: grove?.x ?? 0, z: grove?.z ?? 0 };
    for (let round = 0; round < 200 && h.spawned.length < 500; round++) churn(h, 10, player);
    expect(h.spawned.length).toBeGreaterThanOrEqual(500);
    const trees = h.layout.obstacles.filter((o) => o.kind === 'tree').length;
    expect(trees).toBeGreaterThan(100);
    for (const s of h.spawned.slice(0, 500)) {
      for (const o of h.layout.obstacles) {
        expect(Math.hypot(s.x - o.x, s.z - o.z), `${s.id} at ${s.x.toFixed(2)}, ${s.z.toFixed(2)}`).toBeGreaterThan(o.radius);
      }
    }
  });
});

// ---------------------------------------------------------------- SPEC-054

describe('a cave’s packs: spawnPackAt (SPEC-054 §4.7)', () => {
  /** What the scene passes below: placed, `BELOW_LEASH` 24 m, `BELOW_MAX_ALIVE` 12 − the live count. */
  const BELOW = { placed: true, leash: 24, cap: 12 } as const;

  /** One `spawnPackAt` and the records of what it stood up, the pool emptied after. */
  function packAt(h: Harness, id: EnemyId, x: number, z: number, cap: number = BELOW.cap): Harness['spawned'] {
    const before = h.spawned.length;
    const n = h.director.spawnPackAt(id, x, z, { ...BELOW, cap });
    const made = h.spawned.slice(before);
    expect(made).toHaveLength(n);
    return made;
  }

  function emptyPool(h: Harness): void {
    for (let j = h.pool.size - 1; j >= 0; j--) h.pool.free(j);
  }

  it('follows SPEC-041’s sizes: skitters 3–5, wurmlings 1–2 and the Hive’s drones 4–6 as one pack; a raider alone', () => {
    const h = harness('cinder4', 'high', 5, false);
    const sizes = new Map<EnemyId, Set<number>>();
    for (let i = 0; i < 200; i++) {
      for (const id of ['dust_skitter', 'wurmling', 'scav_raider'] as const) {
        const made = packAt(h, id, 10, -10);
        const seen = sizes.get(id) ?? new Set<number>();
        seen.add(made.length);
        sizes.set(id, seen);
        const lead = made[0]?.entity as EnemyEntity;
        for (const m of made) {
          expect(m.id).toBe(id);
          expect(m.entity.packId).toBe(lead.packId);
        }
        // A pack row shares a pack's id, so it aggroes together; a ranged row comes alone.
        if (id === 'scav_raider') expect(lead.packId).toBe(0);
        else expect(lead.packId).toBeGreaterThan(0);
        emptyPool(h);
      }
    }
    expect([...(sizes.get('dust_skitter') ?? [])].sort()).toEqual([3, 4, 5]);
    expect([...(sizes.get('wurmling') ?? [])].sort()).toEqual([1, 2]);
    expect([...(sizes.get('scav_raider') ?? [])]).toEqual([1]);

    const hive = harness('hive', 'high', 5, false);
    const drones = new Set<number>();
    for (let i = 0; i < 200; i++) {
      drones.add(packAt(hive, 'hive_drone', 0, 30).length);
      emptyPool(hive);
    }
    expect([...drones].sort()).toEqual([4, 5, 6]);
  });

  it('rolls the elite once, for the leader alone, at the director’s eliteChance with the chapter’s affixes', () => {
    const h = harness('ferrum', 'high', 21, false);
    h.director.eliteMult = 40; // Ferrum's 0.07 × 40, capped at 0.5 (SPEC-043 §4.4)
    expect(h.director.eliteChance).toBe(ELITE_CHANCE_CAP);
    let elites = 0;
    const packs = 1000;
    for (let i = 0; i < packs; i++) {
      const made = packAt(h, 'ash_crawler', -20, 5);
      made.forEach((member, k) => {
        if (k === 0) return;
        expect(member.elite).toBe(false);
        expect(member.affixA).toBeNull();
      });
      const lead = made[0] as Harness['spawned'][number];
      if (lead.elite) {
        elites++;
        // Ferrum is chapter 4: two distinct affixes from the archetype's pool.
        expect(lead.affixA).not.toBeNull();
        expect(lead.affixB).not.toBeNull();
        expect(lead.affixA).not.toBe(lead.affixB);
      }
      emptyPool(h);
    }
    // One roll at 0.5 per pack — two rolls for a leader would read about 0.75.
    expect(Math.abs(elites / packs - 0.5), `${elites} of ${packs}`).toBeLessThanOrEqual(0.05);
  });

  it('trims the pack to cap; a cap of 0 or less spawns nothing', () => {
    const h = harness('cinder4', 'high', 5, false);
    for (let i = 0; i < 50; i++) {
      expect(packAt(h, 'dust_skitter', 0, 0, 2)).toHaveLength(2); // never fewer than 3 untrimmed
      emptyPool(h);
      const one = packAt(h, 'dust_skitter', 0, 0, 1);
      expect(one).toHaveLength(1);
      expect(one[0]?.entity.packId).toBeGreaterThan(0);
      emptyPool(h);
    }
    const before = h.spawned.length;
    expect(h.director.spawnPackAt('dust_skitter', 0, 0, { ...BELOW, cap: 0 })).toBe(0);
    expect(h.director.spawnPackAt('scav_raider', 0, 0, { ...BELOW, cap: -3 })).toBe(0);
    expect(h.spawned.length).toBe(before);
    expect(h.pool.size).toBe(0);
  });

  it('stamps every member placed, leashed 24 m from the anchor it shares as its spawn point', () => {
    const h = harness('cinder4', 'high', 5, false);
    const made = packAt(h, 'dust_skitter', 7, -3);
    expect(made.length).toBeGreaterThanOrEqual(3);
    expect(made[0]?.x).toBe(7); // the leader stands on the anchor
    expect(made[0]?.z).toBe(-3);
    for (const m of made) {
      expect(m.entity.placed).toBe(true);
      expect(m.entity.leash).toBe(24);
      expect(m.entity.spawnX).toBe(7);
      expect(m.entity.spawnZ).toBe(-3);
      expect(Math.hypot(m.x - 7, m.z + 3)).toBeLessThanOrEqual(PACK_RADIUS + 1e-9);
    }
    // The director's own spawns carry no stamp, whatever a recycled slot held.
    emptyPool(h);
    h.run(5, { x: 100, z: 40 });
    expect(h.living().length).toBeGreaterThan(0);
    for (const e of h.living()) {
      expect(e.placed).toBe(false);
      expect(e.leash).toBe(e.def.leashRadius);
    }
  });

  it('pulls a blocked member back toward the anchor instead of dropping it, clear of the grid', () => {
    const h = harness('cinder4', 'high', 5, false);
    // A wall 1.5 m round the anchor: a skitter's circle is clear only within 1.1 m of it.
    const hits = (x: number, z: number, r: number): boolean => Math.hypot(x - 20, z - 20) + r > 1.5;
    h.director.setObstacles({ circleHits: hits });
    let pulled = 0;
    for (let i = 0; i < 100; i++) {
      const made = packAt(h, 'dust_skitter', 20, 20);
      expect(made.length).toBeGreaterThanOrEqual(3); // none dropped
      for (const m of made.slice(1)) {
        expect(hits(m.x, m.z, ENEMIES.dust_skitter.radius)).toBe(false);
        if (Math.hypot(m.x - 20, m.z - 20) < 1.1) pulled++;
      }
      emptyPool(h);
    }
    expect(pulled).toBeGreaterThan(100);
  });

  it('a surface shelter does not crowd a cave pack: its clearance is not below', () => {
    const h = harness('cinder4', 'high', 5); // with the surface's shelters
    const shelter = h.layout.shelters[0];
    expect(shelter).toBeDefined();
    const x = shelter?.x ?? 0;
    const z = shelter?.z ?? 0;
    for (let i = 0; i < 50; i++) {
      expect(packAt(h, 'dust_skitter', x, z).length).toBeGreaterThanOrEqual(3);
      emptyPool(h);
    }
  });

  it('placed enemies are never culled — an unplaced pack on the same spot is', () => {
    const h = harness('cinder4', 'high', 5, false);
    const cave = packAt(h, 'dust_skitter', 0, 0).map((m) => m.entity);
    h.director.spawnElitePack('dust_skitter', 2, 0, 3); // the debug pack: not placed
    const loose = h.living().filter((e) => !cave.includes(e));
    expect(loose.length).toBeGreaterThan(0);
    // Far off and un-aggroed for well past DESPAWN_SECONDS, with no ambient spawns.
    h.run(DESPAWN_SECONDS + 5, { x: 150, z: 150 }, NOWHERE, false);
    const left = h.living();
    for (const e of cave) expect(left).toContain(e);
    for (const e of loose) expect(left).not.toContain(e);
    expect(left).toHaveLength(cave.length);
  });

  it('missionsWantSpawns false adds no ambient enemy — no ring spawn, no E14 — and never refills a pack', () => {
    const h = harness('cinder4', 'high', 5);
    h.director.setObjectiveEnemies(['scav_raider']);
    const cave = packAt(h, 'wurmling', 0, 0).map((m) => m.entity);
    const count = h.spawned.length;
    h.run(FORCED_SPAWN_SECONDS + 5, PLAYER, NOWHERE, false);
    expect(h.spawned.length).toBe(count);
    // The pack dies; below, nothing takes its place.
    for (const e of cave) e.state = 'dead';
    h.run(FORCED_SPAWN_SECONDS + 5, PLAYER, NOWHERE, false);
    expect(h.spawned.length).toBe(count);
    expect(h.director.alive).toBe(0);
  });
});

// ------------------------------------------------------------- SPEC-058 §4.4

describe('SpawnDirector — eliteBonus (SPEC-058 §4.4)', () => {
  it('defaults to 0, so the planet’s chance reads as before', () => {
    const h = harness('cinder4', 'high');
    expect(h.director.eliteBonus).toBe(0);
    expect(h.director.eliteChance).toBe(PLANETS.cinder4.surface.eliteChance);
  });

  it('at 0.02 the Cinder-4 elite rate is 7 % ± 1.5 % over ≥ 2,000 rolls, pack leaders included', () => {
    const h = harness('cinder4', 'high', 8);
    h.director.eliteBonus = 0.02;
    expect(h.director.eliteChance).toBeCloseTo(0.07, 12);
    churn(h, 1100);
    const rolls = rollsOf(h.spawned);
    expect(rolls.length).toBeGreaterThanOrEqual(2000);
    const rate = rolls.filter((roll) => roll[0]?.elite === true).length / rolls.length;
    expect(rate, `${rate}`).toBeGreaterThanOrEqual(0.055);
    expect(rate, `${rate}`).toBeLessThanOrEqual(0.085);
    // The bonus rides the leader's one roll; the members never roll.
    for (const roll of rolls) for (const member of roll.slice(1)) expect(member.elite).toBe(false);
  });

  it('adds before eliteMult — (chance + bonus) × mult — and the cap holds at 0.5', () => {
    const h = harness('hive', 'high');
    h.director.eliteBonus = 0.06;
    h.director.eliteMult = 2;
    expect(h.director.eliteChance).toBeCloseTo((PLANETS.hive.surface.eliteChance + 0.06) * 2, 12);
    h.director.eliteMult = 2 * 4;
    expect(h.director.eliteChance).toBe(ELITE_CHANCE_CAP);
    expect(ELITE_CHANCE_CAP).toBe(0.5);
  });

  it('wave groups keep their own flags whatever the bonus', () => {
    const plain = harness('eden', 'high');
    plain.director.startWave('eden_final', { x: 0, z: 0 });
    plain.run(1, PLAYER, NOWHERE, false);
    const bonus = harness('eden', 'high');
    bonus.director.eliteBonus = 0.06;
    bonus.director.startWave('eden_final', { x: 0, z: 0 });
    bonus.run(1, PLAYER, NOWHERE, false);
    expect(bonus.spawned.map((s) => [s.id, s.elite])).toEqual(plain.spawned.map((s) => [s.id, s.elite]));
  });
});
