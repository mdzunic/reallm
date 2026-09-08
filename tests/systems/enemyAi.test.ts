// systems/EnemyAi (SPEC-011 §4.5, §5): the archetype state machines, leashing,
// aggro spread, the stuck side-step, boss phases, the wurm burrow, the queen
// acid volley and the arena leash — all simulated at the fixed 60 Hz step.
import { describe, expect, it } from 'vitest';
import type { EnemyEntity } from '@/entities/Enemy';
import { CircleObstacles } from '@/entities/World';
import {
  ARENA_RESET_TOAST,
  POST_ATTACK_PAUSE,
  WINDUP_SECONDS,
} from '@/systems/EnemyAi';
import { STEP, harness, type Harness } from './combatFixtures';

/** Steps until `predicate` holds, or -1; bounded by `seconds`. */
function runUntil(h: Harness, seconds: number, predicate: () => boolean): number {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    h.step();
    if (predicate()) return i + 1;
  }
  return -1;
}

function hitAt(h: Harness, e: EnemyEntity, damage = 1): void {
  // A shot spawned inside the enemy hits on the next step (11-b).
  h.shot({ x: e.x, z: e.z, vx: 40, damage, ttl: 0.05 });
}

// ------------------------------------------------------------------- swarm

describe('swarm archetype (dust_skitter)', () => {
  it('wanders near its spawn while the target is outside aggro', () => {
    const h = harness();
    const e = h.spawn('dust_skitter', 30, 0);
    h.run(4);
    expect(e.aggro).toBe(false);
    expect(['wander', 'idle']).toContain(e.state);
    expect(Math.hypot(e.x - 30, e.z)).toBeLessThan(9.5); // point within 8 m of spawn
    expect(h.of('player:damaged')).toHaveLength(0);
  });

  it('chases when the target enters aggroRadius', () => {
    const h = harness();
    const e = h.spawn('dust_skitter', 12, 0);
    h.step();
    expect(e.aggro).toBe(true);
    expect(e.state).toBe('chase');
  });

  it('storm visibility narrows the aggro radius (SPEC-012 §4.6)', () => {
    const h = harness();
    // Sandstorm visibility 0.4: 18 m aggro shrinks to 7.2 — 12 m is unseen.
    h.world.aggroMult = 0.4;
    const e = h.spawn('dust_skitter', 12, 0);
    h.run(1);
    expect(e.aggro).toBe(false);
    // The storm lifts: the same enemy acquires at the full radius again.
    h.world.aggroMult = 1;
    h.step();
    expect(e.aggro).toBe(true);
  });

  it('adds the lateral sine offset (±1 m, 1.5 Hz) while chasing', () => {
    const h = harness();
    const e = h.spawn('dust_skitter', 14, 0);
    let maxZ = 0;
    for (let i = 0; i < 60; i++) {
      h.step();
      maxZ = Math.max(maxZ, Math.abs(e.z));
    }
    expect(maxZ).toBeGreaterThan(0.2); // it weaves…
    expect(maxZ).toBeLessThan(2.5); // …within the sine bound
  });

  it('winds up 0.25 s, hits at range + 0.2, re-arms i-frames and knocks back (§4.2)', () => {
    const h = harness();
    const e = h.spawn('dust_skitter', 1.5, 0);
    expect(runUntil(h, 1, () => e.state === 'windup')).toBeGreaterThan(0);
    const windupStart = h.world.time;
    expect(runUntil(h, 1, () => h.of('player:damaged').length > 0)).toBeGreaterThan(0);
    const windup = h.world.time - windupStart;
    expect(windup).toBeGreaterThanOrEqual(WINDUP_SECONDS.swarm - 1e-6);
    expect(windup).toBeLessThan(WINDUP_SECONDS.swarm + 0.1);
    const hit = h.of('player:damaged')[0];
    expect(hit).toEqual({ amount: 4, source: { kind: 'enemy', enemyId: 'dust_skitter' }, hp: 180 });
    expect(h.world.player.invulnUntil).toBeCloseTo(h.world.time + 0.3 - STEP, 1);
    expect(h.world.player.x).toBeLessThan(-0.2); // knocked away from the attacker
    expect(e.state).toBe('attack');
  });

  it('respects the attack cooldown between hits', () => {
    const h = harness();
    h.spawn('dust_skitter', 1.5, 0);
    h.run(2.5);
    // 0.8 s cooldown + 0.3 s i-frames: at most 3 hits land in 2.5 s.
    expect(h.of('player:damaged').length).toBeLessThanOrEqual(3);
    expect(h.of('player:damaged').length).toBeGreaterThanOrEqual(2);
  });
});

// ------------------------------------------------------------------ rusher

describe('rusher archetype (wurmling)', () => {
  it('winds up 0.35 s and pauses 0.4 s after the attack', () => {
    const h = harness();
    const e = h.spawn('wurmling', 1.8, 0);
    expect(runUntil(h, 1, () => e.state === 'windup')).toBeGreaterThan(0);
    const windupStart = h.world.time;
    expect(runUntil(h, 1, () => e.state === 'attack')).toBeGreaterThan(0);
    expect(h.world.time - windupStart).toBeGreaterThanOrEqual(WINDUP_SECONDS.rusher - 1e-6);
    h.run(POST_ATTACK_PAUSE.rusher - 0.05);
    expect(e.state).toBe('attack'); // still frozen in the post-attack pause
    h.run(0.15);
    expect(e.state).toBe('chase');
  });

  it('leashes beyond leashRadius: 1.2× speed, invulnerable, heals on arrival', () => {
    const h = harness();
    h.world.player.x = 80; // out of aggro, so it stays home after the return
    const e = h.spawn('wurmling', 0, 0);
    e.hp = 10;
    e.x = 50; // dragged 50 m from spawn; leashRadius is 45
    e.aggro = true;
    e.state = 'chase';
    h.step();
    expect(e.state).toBe('leash');
    expect(e.invulnerable).toBe(true);
    // Damage while leashing is ignored (11-f).
    hitAt(h, e, 100);
    h.run(0.2);
    expect(e.hp).toBe(10);
    // Return speed is 1.2×: ~6 m/s for the wurmling.
    const x0 = e.x;
    h.run(1);
    expect(x0 - e.x).toBeGreaterThan(5.5);
    expect(x0 - e.x).toBeLessThan(6.5);
    h.run(9);
    expect(e.state).toBe('wander');
    expect(e.hp).toBe(e.maxHp); // healed to full on arrival
    expect(e.invulnerable).toBe(false);
  });

  it('leashes when the target is beyond leashRadius from its spawn (AC de-aggro)', () => {
    const h = harness();
    const e = h.spawn('wurmling', 0, 0);
    e.x = 10; // mid-chase, away from its spawn
    e.aggro = true;
    e.state = 'chase';
    h.world.player.x = 60;
    h.step();
    expect(e.state).toBe('leash');
  });

  it('drops to wander when the player dies', () => {
    const h = harness();
    const e = h.spawn('wurmling', 10, 0);
    h.step();
    expect(e.state).toBe('chase');
    h.combat.damagePlayer(10_000, { kind: 'fall' });
    h.step();
    expect(e.aggro).toBe(false);
    expect(e.state).toBe('wander');
  });

  it('keeps wandering after the player dies even with a live follower in aggro range', () => {
    const h = harness({ follower: true });
    const e = h.spawn('wurmling', 10, 0);
    h.step();
    expect(e.state).toBe('chase');
    h.combat.damagePlayer(10_000, { kind: 'fall' });
    const x0 = e.x;
    const z0 = e.z;
    // The follower sits at (0, -2), inside the 20 m aggroRadius. Re-acquiring
    // it would flip wander→chase every step and freeze the enemy in place.
    let moved = 0;
    for (let i = 0; i < Math.round(3 / STEP); i++) {
      h.step();
      expect(e.state).toBe('wander');
      moved = Math.max(moved, Math.hypot(e.x - x0, e.z - z0));
    }
    expect(e.aggro).toBe(false);
    expect(moved).toBeGreaterThan(0.5); // it wanders — not frozen mid-flip
  });
});

// ------------------------------------------------------------------ ranged

describe('ranged archetype (scav_raider)', () => {
  it('keeps distance in [6, range] for 90 % of steps over a 5 s simulation', () => {
    const h = harness();
    const e = h.spawn('scav_raider', 10, 0);
    const steps = Math.round(5 / STEP);
    let inBand = 0;
    for (let i = 0; i < steps; i++) {
      h.step();
      const d = Math.hypot(e.x - h.world.player.x, e.z - h.world.player.z);
      if (d >= 6 && d <= 12) inBand++;
    }
    expect(inBand / steps).toBeGreaterThanOrEqual(0.9);
  });

  it('telegraphs 0.5 s then fires at the target’s current position, no leading', () => {
    const h = harness();
    const e = h.spawn('scav_raider', 10, 0);
    expect(runUntil(h, 3, () => e.state === 'windup')).toBeGreaterThan(0);
    const windupStart = h.world.time;
    expect(runUntil(h, 2, () => h.world.projectiles.size > 0)).toBeGreaterThan(0);
    expect(h.world.time - windupStart).toBeGreaterThanOrEqual(WINDUP_SECONDS.ranged - 1e-6);
    const p = h.world.projectiles.at(0);
    expect(p.owner).toBe('enemy');
    expect(p.enemyId).toBe('scav_raider');
    // Aimed straight at the player's position at fire time (moving player is not led).
    const speed = Math.hypot(p.vx, p.vz);
    const toPlayerX = (h.world.player.x - e.x) / Math.hypot(h.world.player.x - e.x, h.world.player.z - e.z);
    expect(speed).toBeCloseTo(14, 5);
    expect(p.vx / speed).toBeCloseTo(toPlayerX, 1);
  });

  it('retreats when the target is closer than 4 m', () => {
    const h = harness();
    const e = h.spawn('scav_raider', 3, 0);
    h.step(); // aggro + strafe entry
    const before = Math.hypot(e.x, e.z);
    // It telegraphs its queued shot first (0.5 s), then opens the distance.
    h.run(2);
    expect(Math.hypot(e.x, e.z)).toBeGreaterThan(before + 2);
  });
});

// ------------------------------------------------------------------ static

describe('static archetype (hive_egg)', () => {
  it('never moves, never attacks, takes damage and yields xp/loot on death', () => {
    const h = harness();
    const e = h.spawn('hive_egg', 1.5, 0);
    h.run(3);
    expect(e.x).toBe(1.5);
    expect(e.state).toBe('idle');
    expect(h.of('player:damaged')).toHaveLength(0);
    hitAt(h, e, 50);
    h.run(0.2);
    expect(e.aggro).toBe(false); // damage does not aggro a static
    expect(e.hp).toBe(e.maxHp - 50);
    h.combat.killEnemy(e, 'player');
    expect(h.of('enemy:killed')[0]?.xp).toBe(5);
    expect(h.save.player.xp).toBe(5);
  });
});

// -------------------------------------------------------- targets & aggro

describe('target selection and aggro (§4.5)', () => {
  it('compares dist(player) against dist(follower) × 1.4, player preferred at equal', () => {
    const h = harness({ follower: true });
    const f = h.world.follower;
    if (f === null) throw new Error('follower missing');
    // Equal distances → player.
    f.x = 6;
    f.z = 0;
    const even = h.spawn('dust_skitter', 3, 0);
    h.step();
    expect(even.target).toBe('player');
    // Follower much closer than the 1.4 bias → follower.
    const near = h.spawn('dust_skitter', 7, 0);
    h.step();
    expect(near.target).toBe('follower');
  });

  it('enemies can hit the follower', () => {
    const h = harness({ follower: true });
    const f = h.world.follower;
    if (f === null) throw new Error('follower missing');
    // Probe inside followDistance of the player, so it stands still.
    h.world.player.x = 8;
    h.world.player.z = -2;
    f.x = 8;
    f.z = 0;
    const e = h.spawn('dust_skitter', 9.5, 0); // follower well inside the 1.4 bias
    e.aggro = true;
    e.state = 'chase';
    h.run(3);
    expect(f.hp).toBeLessThan(f.def.hp);
  });

  it('spreads aggro to same-species enemies within 8 m on damage', () => {
    const h = harness();
    const a = h.spawn('dust_skitter', 30, 0);
    const b = h.spawn('dust_skitter', 34, 0);
    const c = h.spawn('dust_skitter', 50, 0);
    const other = h.spawn('wurmling', 33, 0); // different species, inside 8 m
    h.run(0.1);
    expect(a.aggro).toBe(false);
    hitAt(h, a);
    h.step();
    expect(a.aggro).toBe(true);
    expect(b.aggro).toBe(true);
    expect(c.aggro).toBe(false); // 20 m away
    expect(other.aggro).toBe(false); // different species
  });
});

// ------------------------------------------------------------- stuck (11-d)

describe('stuck on an obstacle (11-d)', () => {
  it('side-steps after 1.5 s under 0.3 m/s in chase', () => {
    // A rock wall dead ahead the wurmling cannot round with the ±60° samples.
    const h = harness({ obstacles: new CircleObstacles([{ x: 4, z: 0, radius: 3 }]) });
    const e = h.spawn('wurmling', 0, 0);
    h.step();
    expect(e.state).toBe('chase');
    h.world.player.x = 10;
    expect(runUntil(h, 3, () => e.sideUntil > 0)).toBeGreaterThan(0);
    expect(Math.abs(e.wanderZ)).toBeGreaterThan(1); // side-step target is perpendicular
  });
});

// -------------------------------------------------------------------- boss

describe('boss phases (dune_wurm, hive_queen)', () => {
  it('triggers each phase once at its HP fraction and summons a 6 m ring', () => {
    const h = harness();
    const boss = h.spawn('dune_wurm', 8, 0);
    boss.aggro = true;
    boss.hp = boss.maxHp * 0.35; // below the 0.4 threshold
    h.step();
    expect(h.of('boss:phase')).toEqual([{ boss: 'dune_wurm', phase: 2 }]);
    const summons = h.of('enemy:spawned').filter((s) => s.enemyId === 'wurmling');
    expect(summons).toHaveLength(6);
    for (let i = 0; i < h.world.enemies.size; i++) {
      const e = h.world.enemies.at(i);
      if (e.def.id !== 'wurmling') continue;
      expect(Math.hypot(e.spawnX - 8, e.spawnZ)).toBeCloseTo(6, 6);
    }
    h.run(5);
    expect(h.of('boss:phase')).toHaveLength(1); // never re-triggers
  });

  it('burrows on phase 2: invulnerable 4 s, resurfaces 5 m from the player, shockwave r 4', () => {
    const h = harness();
    const boss = h.spawn('dune_wurm', 8, 0);
    boss.aggro = true;
    boss.hp = boss.maxHp * 0.35;
    h.step();
    expect(boss.state).toBe('special');
    expect(boss.specialKind).toBe('burrow_dig');
    expect(boss.invulnerable).toBe(true);
    // Clear the phase summons so nothing shoves the player during the dig.
    for (let i = h.world.enemies.size - 1; i >= 0; i--) {
      const e = h.world.enemies.at(i);
      if (e.def.id === 'wurmling') h.combat.killEnemy(e, 'script');
    }
    // Kill during the special is impossible: damage is ignored (11-f).
    const hpBefore = boss.hp;
    hitAt(h, boss, 100_000);
    h.run(0.2);
    expect(boss.hp).toBe(hpBefore);
    // Dig 3 s → telegraph 1 s at a point 5 m from the player.
    h.run(3);
    expect(boss.specialKind).toBe('burrow_telegraph');
    expect(Math.hypot(boss.wanderX, boss.wanderZ)).toBeCloseTo(5, 6); // player at origin
    // Step onto the telegraph: the resurface shockwave hits within 4 m.
    h.world.player.x = boss.wanderX;
    h.world.player.z = boss.wanderZ;
    h.run(1.1);
    expect(boss.specialKind).toBe('none');
    expect(boss.invulnerable).toBe(false);
    expect(boss.x).toBeCloseTo(boss.wanderX, 6);
    expect(h.of('player:damaged').some((d) => d.source.kind === 'enemy' && d.source.enemyId === 'dune_wurm')).toBe(true);
  });

  it('hive queen phase 2 gains the acid volley: 3-spread every 2 s', () => {
    const h = harness();
    // West of the player, so the volley angles sit around 0 without wrapping.
    const queen = h.spawn('hive_queen', -10, 0);
    queen.aggro = true;
    queen.state = 'chase';
    queen.hp = queen.maxHp * 0.45;
    h.step();
    expect(h.of('boss:phase')).toEqual([{ boss: 'hive_queen', phase: 2 }]);
    expect(queen.invulnerable).toBe(true); // the 1.5 s phase special
    h.run(1.55);
    expect(queen.invulnerable).toBe(false);
    // First volley: exactly three enemy shots in flight, spread around the aim.
    expect(runUntil(h, 1, () => h.world.projectiles.size > 0)).toBeGreaterThan(0);
    expect(h.world.projectiles.size).toBe(3);
    const angles = [];
    for (let i = 0; i < 3; i++) {
      const p = h.world.projectiles.at(i);
      angles.push(Math.atan2(p.vz, p.vx));
      expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(12, 5);
    }
    expect(Math.max(...angles) - Math.min(...angles)).toBeCloseTo(0.6, 3);
    expect(queen.acidCooldown).toBeCloseTo(2, 1);
  });

  it('resets when pulled out of the arena for 8 s (11-e)', () => {
    const h = harness({ arena: { x: 0, z: 0, radius: 20, locked: true } });
    const boss = h.spawn('dune_wurm', 10, 0);
    boss.aggro = true;
    boss.state = 'chase';
    boss.hp = boss.maxHp * 0.5; // damaged, but above the phase threshold
    boss.x = 30; // dragged out; the player kites from beyond
    h.world.player.x = 40;
    const steps = runUntil(h, 10, () => h.of('ui:toast').some((t) => t.text === ARENA_RESET_TOAST));
    expect(steps).toBeGreaterThan(Math.round(8 / STEP) - 2); // the full 8 s elapsed
    expect(boss.hp).toBe(boss.maxHp);
    expect(boss.phase).toBe(1);
    expect(boss.x).toBeCloseTo(10, 6); // back at its spawn, checked the reset step
    expect(boss.aggro).toBe(false);
  });
});
