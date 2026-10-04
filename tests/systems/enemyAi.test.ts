// systems/EnemyAi (SPEC-011 §4.5, §5): the archetype state machines, leashing,
// aggro spread, the stuck side-step, boss phases and the arena leash — all
// simulated at the fixed 60 Hz step. SPEC-041 moved the wurm's burrow and the
// queen's acid into boss moves; their cases live in `bossMoves.test.ts`.
import { describe, expect, it } from 'vitest';
import type { EnemyEntity } from '@/entities/Enemy';
import { CircleObstacles } from '@/entities/World';
import {
  ARENA_RESET_TOAST,
  ATTACK_REACH_BONUS,
  CHARGE,
  POST_ATTACK_PAUSE,
  SWARM_WINDUP_TRACK,
  WINDUP_SECONDS,
} from '@/systems/EnemyAi';
import { damageReduction } from '@/systems/Combat';
import { isDashing, stepDash, tryDash } from '@/systems/Dash';
import { LOUD_TRACK_LOCK } from '@/entities/Telegraph';
import { SPRINT_NOISE } from '@/systems/Stamina';
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
    // SPEC-035 §4.6: a melee blow now carries the attacker's position as `from`.
    expect(hit).toEqual({
      amount: 4,
      source: { kind: 'enemy', enemyId: 'dust_skitter' },
      hp: 180,
      from: { x: e.x, z: e.z },
    });
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
      // SPEC-038 §4.4: the band follows the range, 13 m now.
      if (d >= 6 && d <= 13) inBand++;
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
    expect(speed).toBeCloseTo(15, 5); // SPEC-038 §4.4: 15 m/s
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

describe('boss phases (dune_wurm)', () => {
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

  it('resets when pulled out of the arena for 8 s (11-e)', () => {
    const h = harness({ arena: { x: 0, z: 0, radius: 20, locked: true, sealed: false } });
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

// ------------------------------------------------- SPEC-030 §4.6: hiding

/** A sealed obstacle ring around the player at the origin — no line, no entry. */
function playerRing(): { x: number; z: number; radius: number }[] {
  const ring: { x: number; z: number; radius: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2;
    ring.push({ x: Math.cos(angle) * 4, z: Math.sin(angle) * 4, radius: 1.3 });
  }
  return ring;
}

describe('SPEC-030 — hiding from enemies (AC-26..AC-28)', () => {
  it('a hidden player is not acquired at 10 m, and is acquired at 4 m with a clear line', () => {
    const h = harness();
    h.world.playerHidden = true;
    const far = h.spawn('dust_skitter', 10, 0); // inside aggroRadius 18, outside 5 m
    h.run(1);
    expect(far.aggro).toBe(false);
    const near = h.spawn('dust_skitter', 4, 0);
    h.step();
    expect(near.aggro).toBe(true);
  });

  it('a hidden player behind a wall is not acquired even inside 5 m (AC-26)', () => {
    const h = harness({ obstacles: new CircleObstacles([{ x: 2, z: 0, radius: 1.5 }]) });
    h.world.playerHidden = true;
    const e = h.spawn('dust_skitter', 4, 0); // 4 m, but the line crosses the wall
    h.run(0.2); // barely a wander step: the line stays blocked throughout
    expect(e.aggro).toBe(false);
  });

  it('hiding never widens the rule: outside aggroRadius nothing acquires at 5 m either', () => {
    const h = harness();
    h.world.playerHidden = true;
    h.world.aggroMult = 0.1; // 18 m → 1.8 m
    const e = h.spawn('dust_skitter', 4, 0);
    h.run(0.5);
    expect(e.aggro).toBe(false);
  });

  it('an aggroed rusher with no line for 3 s drops aggro and heads back toward its spawn (AC-27)', () => {
    // A sealed ring around the hidden player — the cave, as the brain sees it.
    const h = harness({ obstacles: new CircleObstacles(playerRing()) });
    const e = h.spawn('wurmling', 14, 0);
    e.aggro = true;
    e.state = 'chase';
    h.world.playerHidden = true;
    const steps = runUntil(h, 6, () => !e.aggro);
    expect(steps).toBeGreaterThan(0);
    // ≈ 3 s of blocked line (the drop waits out LOSE_TRACK_SECONDS).
    expect(steps * STEP).toBeGreaterThanOrEqual(3 - 0.1);
    expect(e.state).toBe('wander');
    expect(e.lostTrack).toBe(0);
    expect(e.invulnerable).toBe(false); // wander, not leash: no heal ride home
    const before = Math.hypot(e.x - e.spawnX, e.z - e.spawnZ);
    h.run(4);
    expect(Math.hypot(e.x - e.spawnX, e.z - e.spawnZ)).toBeLessThanOrEqual(Math.max(before, 9.5));
  });

  it('a clear line keeps the track alive (30-b) and resets lostTrack', () => {
    const h = harness();
    const e = h.spawn('wurmling', 12, 0);
    e.aggro = true;
    e.state = 'chase';
    h.world.playerHidden = true;
    h.run(4); // twice LOSE_TRACK_SECONDS, line always clear
    expect(e.aggro).toBe(true);
    expect(e.lostTrack).toBe(0);
  });

  it('lostTrack resets on any step where the player is not hidden (D-20)', () => {
    const h = harness({ obstacles: new CircleObstacles(playerRing()) });
    const e = h.spawn('wurmling', 14, 0);
    e.aggro = true;
    e.state = 'chase';
    h.world.playerHidden = true;
    h.run(2);
    expect(e.lostTrack).toBeGreaterThan(0);
    h.world.playerHidden = false;
    h.step();
    expect(e.lostTrack).toBe(0);
    expect(e.aggro).toBe(true);
  });

  it('a wave enemy ignores hiding entirely (AC-28)', () => {
    const h = harness({ obstacles: new CircleObstacles(playerRing()) });
    h.world.playerHidden = true;
    // The 5 m acquire rule does not apply…
    const fresh = h.spawn('dust_skitter', 14, 3);
    fresh.fromWave = true;
    h.step();
    expect(fresh.aggro).toBe(true);
    // …and neither does the 3 s drop rule.
    const chaser = h.spawn('wurmling', 14, 0);
    chaser.fromWave = true;
    chaser.aggro = true;
    chaser.state = 'chase';
    h.run(4);
    expect(chaser.aggro).toBe(true);
  });

  it('a boss ignores hiding entirely (AC-28)', () => {
    const h = harness({ obstacles: new CircleObstacles(playerRing()) });
    h.world.playerHidden = true;
    const boss = h.spawn('dune_wurm', 14, 0);
    boss.aggro = true;
    boss.state = 'chase';
    h.run(4);
    expect(boss.aggro).toBe(true);
  });

  it('firing reveals: lastShotAt inside 1.5 s of world time means not hidden (AC-25)', () => {
    const h = harness();
    h.spawn('dust_skitter', 5, 0);
    h.input.buttons.fire.down = true;
    h.step();
    h.input.buttons.fire.down = false;
    // The scene's rule: hidden ⇔ inside ∧ time − lastShotAt ≥ REVEAL_AFTER_SHOT.
    expect(h.world.time - h.combat.lastShotAt).toBeLessThan(1.5);
    h.run(1.6);
    expect(h.world.time - h.combat.lastShotAt).toBeGreaterThanOrEqual(1.5);
  });
});

// ---------------------------------------------------------------- SPEC-034

/**
 * SPEC-034 §4.1, §6.1 — the review's `stuck-enemy.test.ts`.
 *
 * The enemy step slides per axis against obstacles exactly as the player's
 * does, so an enemy a projectile knocked into a rock was refused every
 * direction and stood there for the rest of the visit. §4.1 resolves the body
 * out *before* the slide, so it walks out and comes back into range.
 */
describe('an enemy shot into a rock walks out again (SPEC-034 §4.1)', () => {
  it('a skitter knocked inside a rock reaches its firing range within 5 s', () => {
    const h = harness({ obstacles: new CircleObstacles([{ x: 8, z: 0, radius: 3 }]) });
    // Knocked 0.3 m past the rock's near edge (`ENEMY_KNOCKBACK`), the way a
    // projectile from the player at the origin would put it.
    const e = h.spawn('dust_skitter', 8 - 3 + 0.1, 0);
    e.aggro = true;
    e.state = 'chase';
    expect(h.world.obstacles.hitsCircle(e.x, e.z, e.radius)).toBe(true);
    // Its melee reach, from the player at the origin.
    const attack = e.def.attack;
    const reach = (attack.kind === 'none' ? 0 : attack.range) + h.world.player.radius + e.radius;
    const steps = runUntil(h, 5, () => Math.hypot(e.x - h.world.player.x, e.z - h.world.player.z) <= reach);
    expect(steps, 'steps to reach its firing range').toBeGreaterThan(0);
    expect(h.world.obstacles.hitsCircle(e.x, e.z, e.radius)).toBe(false);
  });

  it('resolves out of a rock on the first step, before the slide', () => {
    const h = harness({ obstacles: new CircleObstacles([{ x: 8, z: 0, radius: 3 }]) });
    const e = h.spawn('wurmling', 8.5, 0.5);
    e.aggro = true;
    e.state = 'chase';
    h.step();
    expect(h.world.obstacles.hitsCircle(e.x, e.z, e.radius)).toBe(false);
  });
});

// ------------------------------------------------------------ SPEC-038 §4.3

/** A Marine's walking speed: 6 × (1 + 0.02 × agility 1). */
const RETREAT = 6.12;
const scratch = { x: 0, z: 0 };

/**
 * One scene step of a moving player: the dash if one runs, else a walk at
 * `speed` along `(dx, dz)` — then combat, as the surface orders them (38-b).
 */
function walkStep(h: Harness, dx: number, dz: number, speed = RETREAT): void {
  const p = h.world.player;
  if (isDashing(p, h.world.time)) stepDash(p, h.world.obstacles, 1000, h.world.time, STEP, scratch);
  else if (p.alive) {
    const len = Math.hypot(dx, dz);
    if (len > 0) {
      p.x += (dx / len) * speed * STEP;
      p.z += (dz / len) * speed * STEP;
    }
  }
  h.step();
}

/** A wurmling aggroed and chasing, `d` m from the player along −x. */
function rusher(h: Harness, d: number): EnemyEntity {
  const e = h.spawn('wurmling', h.world.player.x - d, h.world.player.z);
  e.aggro = true;
  e.state = 'chase';
  e.facing = 0;
  return e;
}

describe('the swarm closes while it winds up (SPEC-038 §4.3)', () => {
  it('lands a windup started 1.85 m behind a player retreating at 6.12 m/s', () => {
    expect(SWARM_WINDUP_TRACK).toBe(1);
    const h = harness();
    const e = h.spawn('dust_skitter', -1.85, 0);
    e.aggro = true;
    e.state = 'windup';
    e.stateTime = 0;
    for (let i = 0; i < 30 && e.state === 'windup'; i++) walkStep(h, 1, 0);
    expect(e.state).toBe('attack');
    expect(h.of('player:damaged')).toHaveLength(1);
    // The hit check is unchanged — meleeReach + 0.2 at the end — and a rooted
    // windup would have whiffed: the player walks 1.53 m in 0.25 s.
    const reach = e.radius + 0.9 + h.world.player.radius + ATTACK_REACH_BONUS;
    expect(1.85 + RETREAT * WINDUP_SECONDS.swarm).toBeGreaterThan(reach);
  });

  it('stops closing inside half its reach, and faces the target', () => {
    const h = harness();
    const e = h.spawn('dust_skitter', -1.2, 0);
    e.aggro = true;
    e.state = 'windup';
    e.stateTime = 0;
    h.step();
    h.step();
    const reach = e.radius + 0.9 + h.world.player.radius;
    expect(Math.hypot(e.x, e.z)).toBeGreaterThan(reach * 0.5 - 0.15);
    expect(Math.cos(e.facing)).toBeGreaterThan(0.99);
  });

  it('a rusher’s melee windup stays rooted, and a straight retreat walks out of it', () => {
    const h = harness();
    const e = rusher(h, 1.85);
    e.state = 'windup';
    e.stateTime = 0;
    const x0 = e.x;
    for (let i = 0; i < 30 && e.state === 'windup'; i++) walkStep(h, 1, 0);
    expect(e.x).toBe(x0);
    expect(h.of('player:damaged')).toHaveLength(0);
  });
});

describe('the rusher’s charge (SPEC-038 §4.3)', () => {
  it('pins the initial tuning', () => {
    expect(CHARGE).toEqual({
      trigger: 6,
      windup: 0.5,
      lock: 0.15,
      turnRate: 8,
      speed: 20,
      length: 10,
      pad: 0.3,
      damageMult: 1.3,
      knockback: 1.0,
      recoverHit: 0.5,
      recoverWhiff: 0.9,
      cooldown: 2.5,
    });
  });

  it('triggers at 6 m on a clear line, cues `charge` and draws a 10 × 2.8 m lane', () => {
    const h = harness();
    const e = rusher(h, 5.9);
    h.step();
    expect(e.state).toBe('chargeWindup');
    expect(h.of('enemy:windup')).toEqual([{ enemyId: 'wurmling', kind: 'charge', x: e.x, z: e.z }]);
    const lane = h.combat.telegraphs.at(0);
    expect(lane).toMatchObject({ kind: 'line', length: 10, bodyResolved: true, ownerId: e.id });
    expect(lane.width).toBeCloseTo(2.8, 10);
    // Past 6 m it chases instead.
    const far = harness();
    const f = rusher(far, 6.5);
    far.step();
    expect(f.state).toBe('chase');
    expect(far.combat.telegraphs.size).toBe(0);
  });

  it('inside melee reach, SPEC-011’s 0.35 s melee wins — the charge is the opener', () => {
    const h = harness();
    const e = rusher(h, 1.8);
    h.step();
    expect(e.state).toBe('windup');
    expect(h.of('enemy:windup')[0]?.kind).toBe('melee');
    expect(h.combat.telegraphs.size).toBe(0);
  });

  it('turns at up to 8 rad/s, then locks 0.15 s before the charge', () => {
    const h = harness();
    const e = rusher(h, 5);
    h.step();
    expect(e.state).toBe('chargeWindup');
    const facings: Array<{ t: number; facing: number }> = [];
    // The player strafes across the lane; the rusher tracks, then commits.
    while (e.state === 'chargeWindup') {
      facings.push({ t: e.stateTime, facing: e.facing });
      walkStep(h, 0, 1, 4);
    }
    const tracking = facings.filter((f) => f.t < CHARGE.windup - CHARGE.lock - STEP);
    const locked = facings.filter((f) => f.t > CHARGE.windup - CHARGE.lock + STEP);
    expect(tracking.length).toBeGreaterThan(10);
    expect(locked.length).toBeGreaterThan(5);
    for (let i = 1; i < tracking.length; i++) {
      const turn = Math.abs((tracking[i] as { facing: number }).facing - (tracking[i - 1] as { facing: number }).facing);
      expect(turn).toBeLessThanOrEqual(CHARGE.turnRate * STEP + 1e-9);
    }
    const first = (tracking[0] as { facing: number }).facing;
    expect((tracking.at(-1) as { facing: number }).facing).not.toBeCloseTo(first, 3);
    for (const f of locked) expect(f.facing).toBe((locked[0] as { facing: number }).facing);
  });

  it('runs at 20 m/s along the locked facing for at most 10 m, and a whiff recovers 0.9 s', () => {
    const h = harness();
    const e = rusher(h, 5);
    h.step();
    // Out of the lane after the lock: nothing to touch.
    while (e.state === 'chargeWindup') {
      if (e.stateTime > CHARGE.windup - CHARGE.lock + STEP) h.world.player.z = 6;
      h.step();
    }
    expect(e.state).toBe('charge');
    const start = { x: e.x - Math.cos(e.facing) * CHARGE.speed * STEP, z: e.z - Math.sin(e.facing) * CHARGE.speed * STEP };
    let last = { x: e.x, z: e.z };
    let steps = 1;
    while (e.state === 'charge') {
      h.step();
      const moved = Math.hypot(e.x - last.x, e.z - last.z);
      expect(moved).toBeLessThanOrEqual(CHARGE.speed * STEP + 1e-9);
      last = { x: e.x, z: e.z };
      steps++;
    }
    expect(Math.hypot(e.x - start.x, e.z - start.z)).toBeCloseTo(10, 5);
    expect(steps).toBe(Math.round(CHARGE.length / (CHARGE.speed * STEP)));
    expect(h.of('player:damaged')).toHaveLength(0);
    expect(e.state).toBe('attack');
    expect(e.recoverFor).toBe(CHARGE.recoverWhiff);
    expect(e.cooldown).toBeCloseTo(CHARGE.cooldown, 5);
    expect(h.combat.telegraphs.size).toBe(0); // the lane goes with the run
    h.run(0.85);
    expect(e.state).toBe('attack');
    h.run(0.1);
    expect(e.state).toBe('chase');
  });

  it('first contact deals damage × 1.3 with 1 m of knockback, then recovers 0.5 s; the next charge waits 2.5 s', () => {
    const h = harness();
    const e = rusher(h, 5);
    h.run(1);
    const hits = h.of('player:damaged');
    expect(hits).toHaveLength(1);
    const expected = Math.max(1, Math.round(9 * 1.3 * (1 - damageReduction(h.world.stats.armor))));
    expect(hits[0]?.amount).toBe(expected);
    expect(e.chargeHit).toBe(true);
    // Stopped at the contact, and the player shoved 1 m along the run.
    expect(h.world.player.x).toBeGreaterThan(0.95);
    expect(e.recoverFor).toBe(CHARGE.recoverHit);
    // No second charge inside the cooldown, though the player stands in range.
    h.world.player.invulnUntil = 0;
    h.world.player.x = e.x + 4;
    h.world.player.z = e.z;
    const windups = h.of('enemy:windup').length;
    h.run(1.9);
    expect(h.of('enemy:windup').filter((w) => w.kind === 'charge')).toHaveLength(windups);
  });

  it('a charge meeting the follower first hits the follower (E61)', () => {
    const h = harness({ follower: true });
    const f = h.world.follower;
    if (f === null) throw new Error('no follower');
    // Rusher, follower and player on one line: the follower is met first.
    h.world.player.x = 0;
    h.world.player.z = 3;
    f.x = 0;
    f.z = 0;
    const e = h.spawn('wurmling', 0, -5);
    e.aggro = true;
    e.state = 'chase';
    e.facing = Math.PI / 2;
    const hp = f.hp;
    h.run(1);
    expect(f.hp).toBe(hp - Math.round(9 * 1.3));
    expect(h.of('player:damaged')).toHaveLength(0);
  });

  it('a charge into a rock ends as a whiff at its last clear position (E61)', () => {
    const rock = new CircleObstacles([{ x: 0, z: 1.5, radius: 0.5 }]);
    const h = harness({ obstacles: rock });
    const e = rusher(h, 5);
    h.step();
    expect(e.state).toBe('chargeWindup');
    // A rock steps into the lane after the lock.
    while (e.state === 'chargeWindup') {
      if (e.stateTime > CHARGE.windup - CHARGE.lock + STEP) {
        rock.circles[0] = { x: e.x + 3, z: e.z, radius: 0.8 };
        h.world.player.z = 4;
      }
      h.step();
    }
    while (e.state === 'charge') h.step();
    expect(e.state).toBe('attack');
    expect(e.recoverFor).toBe(CHARGE.recoverWhiff);
    expect(rock.hitsCircle(e.x, e.z, e.radius)).toBe(false);
    expect(h.of('player:damaged')).toHaveLength(0);
  });
});

describe('charge duels against a 6.12 m/s player (SPEC-038 §4.3)', () => {
  it('lands on a straight retreat started 4.5 m ahead of it', () => {
    const h = harness();
    const e = rusher(h, 4.5);
    h.step(); // the trigger, before the player moves
    expect(e.state).toBe('chargeWindup');
    for (let i = 0; i < 90 && h.of('player:damaged').length === 0; i++) walkStep(h, 1, 0);
    expect(h.of('player:damaged')).toHaveLength(1);
    expect(e.chargeHit).toBe(true); // the charge landed it, not a melee windup
  });

  it('misses a player who turns 90° a quarter-second into the windup', () => {
    const h = harness();
    const e = rusher(h, 4.5);
    h.step();
    expect(e.state).toBe('chargeWindup');
    let charged = false;
    let whiffed = false;
    for (let i = 0; i < 120; i++) {
      const turned = e.state !== 'chargeWindup' || e.stateTime >= 0.25;
      walkStep(h, turned ? 0 : 1, turned ? 1 : 0);
      charged ||= e.state === 'charge';
      whiffed ||= e.state === 'attack' && e.recoverFor === CHARGE.recoverWhiff;
    }
    expect(charged).toBe(true);
    expect(whiffed).toBe(true);
    expect(h.of('player:damaged')).toHaveLength(0);
  });

  it('deals nothing through a perpendicular dash pressed 0.3 s into the windup', () => {
    const h = harness();
    const e = rusher(h, 4.5);
    h.step();
    let dashed = false;
    let charged = false;
    for (let i = 0; i < 120; i++) {
      if (!dashed && e.state === 'chargeWindup' && e.stateTime >= 0.3) {
        dashed = tryDash(h.world.player, 0, 1, h.world.time, 1.358);
      }
      walkStep(h, 1, 0);
      charged ||= e.state === 'charge';
    }
    expect(dashed).toBe(true);
    expect(charged).toBe(true);
    expect(h.of('player:damaged')).toHaveLength(0);
  });
});

describe('casual stretches every windup (SPEC-038 §4.6)', () => {
  it('windupMult 1.25 lengthens the melee, the shot and the charge — and the lane’s lead time', () => {
    for (const [id, x, seconds] of [
      ['dust_skitter', 1.5, WINDUP_SECONDS.swarm],
      ['scav_raider', 10, WINDUP_SECONDS.ranged],
      ['wurmling', -5, CHARGE.windup],
    ] as const) {
      const h = harness();
      h.save.meta.difficulty = 'casual';
      const e = h.spawn(id, x, 0);
      e.aggro = true;
      e.state = 'chase';
      const windups = new Set<string>(['windup', 'chargeWindup']);
      expect(runUntil(h, 5, () => windups.has(e.state)), id).toBeGreaterThan(0);
      expect(h.world.windupMult).toBe(1.25);
      const start = h.world.time;
      const lane = h.combat.telegraphs.size > 0 ? h.combat.telegraphs.at(0) : null;
      expect(runUntil(h, 3, () => !windups.has(e.state)), id).toBeGreaterThan(0);
      expect(h.world.time - start, id).toBeGreaterThanOrEqual(seconds * 1.25 - STEP - 1e-6);
      expect(h.world.time - start, id).toBeLessThan(seconds * 1.25 + 2 * STEP);
      if (lane !== null) {
        expect(lane.hitAt - lane.startAt).toBeCloseTo(CHARGE.windup * 1.25, 10);
        // The lock offset does not scale.
        expect(lane.hitAt - lane.lockAt).toBeCloseTo(CHARGE.lock, 10);
      }
    }
  });
});

describe('the windup cue (SPEC-038 §4.2)', () => {
  it('names melee, charge and shot', () => {
    const kinds = new Map<string, string | undefined>();
    for (const [id, x] of [
      ['dust_skitter', 1.5],
      ['wurmling', -5],
      ['scav_raider', 10],
    ] as const) {
      const h = harness();
      const e = h.spawn(id, x, 0);
      e.aggro = true;
      e.state = 'chase';
      runUntil(h, 4, () => h.of('enemy:windup').length > 0);
      const cue = h.of('enemy:windup')[0];
      kinds.set(id, cue?.kind);
      expect(cue?.enemyId).toBe(id);
    }
    expect(Object.fromEntries(kinds)).toEqual({ dust_skitter: 'melee', wurmling: 'charge', scav_raider: 'shot' });
  });
});

// ------------------------------------------------------------- SPEC-050

describe('noise widens acquisition (SPEC-050 §4.3)', () => {
  it('a wandering dust_skitter 25 m away acquires a loud player, and not a quiet one', () => {
    const quiet = harness();
    quiet.world.noiseMult = 1;
    const calm = quiet.spawn('dust_skitter', 25, 0);
    quiet.step();
    expect(calm.aggro).toBe(false);
    expect(['wander', 'idle']).toContain(calm.state);

    const loud = harness();
    loud.world.noiseMult = SPRINT_NOISE;
    const heard = loud.spawn('dust_skitter', 25, 0);
    loud.step();
    expect(heard.aggro).toBe(true);
    expect(heard.state).toBe('chase');
  });

  it('it is aggroRadius × aggroMult × noiseMult: 27 m for a skitter, and a storm narrows it again', () => {
    const edge = harness();
    edge.world.noiseMult = SPRINT_NOISE;
    const beyond = edge.spawn('dust_skitter', 27.5, 0);
    edge.step();
    expect(beyond.aggro).toBe(false);

    const storm = harness();
    storm.world.noiseMult = SPRINT_NOISE;
    storm.world.aggroMult = 0.5; // 18 × 0.5 × 1.5 = 13.5 m
    const far = storm.spawn('dust_skitter', 15, 0);
    storm.step();
    expect(far.aggro).toBe(false);
  });
});

describe('the Wurm listens (SPEC-050 §4.4)', () => {
  /** A Wurm 30 m out, wounded into phase 2 — the step that opens its dig. */
  function digging(h: Harness): { wurm: EnemyEntity; digStart: number } {
    const wurm = h.spawn('dune_wurm', 30, 0);
    wurm.aggro = true;
    wurm.hp = wurm.maxHp * 0.35;
    h.step();
    expect(wurm.specialKind).toBe('burrow_dig');
    return { wurm, digStart: h.world.time };
  }

  it('the burrow row carries trackLoud 12 and loudDigMult 0.6', () => {
    const burrow = (harness().spawn('dune_wurm', 0, 0).def.moves ?? []).find((move) => move.kind === 'burrow');
    expect(burrow?.trackLoud).toBe(12);
    expect(burrow?.loudDigMult).toBe(0.6);
  });

  it('a quiet dig runs its 2.5 s', () => {
    const h = harness();
    const { wurm, digStart } = digging(h);
    expect(runUntil(h, 3, () => wurm.specialKind === 'burrow_telegraph')).toBeGreaterThan(0);
    expect(h.world.time - digStart).toBeCloseTo(2.5, 1);
  });

  it('a loud step during the dig ends it at digStart + 2.5 × 0.6', () => {
    const h = harness();
    const { wurm, digStart } = digging(h);
    h.run(0.5);
    h.world.player.loudUntil = h.world.time + 0.2; // one short burst is enough
    expect(runUntil(h, 3, () => wurm.specialKind === 'burrow_telegraph')).toBeGreaterThan(0);
    expect(h.world.time - digStart).toBeGreaterThanOrEqual(1.5 - 1e-9);
    expect(h.world.time - digStart).toBeLessThan(1.5 + 2 * STEP);
  });

  it('ends at once when that moment has passed', () => {
    const h = harness();
    const { wurm, digStart } = digging(h);
    h.run(2);
    expect(wurm.specialKind).toBe('burrow_dig');
    h.world.player.loudUntil = Infinity;
    h.step();
    expect(wurm.specialKind).toBe('burrow_telegraph');
    expect(h.world.time - digStart).toBeLessThan(2.1);
  });

  it('is 1.875 s on casual (2.5 × 1.25 × 0.6)', () => {
    const h = harness({ patch: (s) => void (s.meta.difficulty = 'casual') });
    const { wurm, digStart } = digging(h);
    h.world.player.loudUntil = Infinity;
    expect(runUntil(h, 3, () => wurm.specialKind === 'burrow_telegraph')).toBeGreaterThan(0);
    expect(h.world.time - digStart).toBeGreaterThanOrEqual(1.875 - 1e-9);
    expect(h.world.time - digStart).toBeLessThan(1.875 + 2 * STEP);
  });

  it('hiding does not quiet a loud player under the Wurm (50-m)', () => {
    const h = harness();
    const { wurm, digStart } = digging(h);
    h.world.playerHidden = true;
    h.world.player.loudUntil = Infinity;
    expect(runUntil(h, 3, () => wurm.specialKind === 'burrow_telegraph')).toBeGreaterThan(0);
    expect(h.world.time - digStart).toBeLessThan(1.5 + 2 * STEP);
  });

  /** The burrow's circle, drawn at the origin by a quiet dig, and its owner. */
  function circleDown(): { h: Harness; wurm: EnemyEntity } {
    const h = harness();
    const { wurm } = digging(h);
    expect(runUntil(h, 3, () => wurm.specialKind === 'burrow_telegraph')).toBeGreaterThan(0);
    expect(h.combat.telegraphs.size).toBe(1);
    return { h, wurm };
  }

  it('draws a circle that follows, locking 0.4 s before it lands', () => {
    const { h } = circleDown();
    const t = h.combat.telegraphs.at(0);
    expect(t.kind).toBe('circle');
    expect(t.followsLoud).toBe(true);
    expect(t.trackSpeed).toBe(12);
    expect(LOUD_TRACK_LOCK).toBe(0.4);
    expect(t.lockAt).toBeCloseTo(t.hitAt - LOUD_TRACK_LOCK, 9);
  });

  it('a loud player 3 m from the circle pulls it at up to 12 m/s until hitAt − 0.4, and not after', () => {
    const { h, wurm } = circleDown();
    const t = h.combat.telegraphs.at(0);
    const p = h.world.player;
    p.loudUntil = Infinity;
    p.x = t.x + 3;
    p.z = t.z;
    // One step closes 12/60 = 0.2 m of the 3.
    let x = t.x;
    let z = t.z;
    h.step();
    expect(Math.hypot(t.x - x, t.z - z)).toBeCloseTo(12 * STEP, 6);
    // Outrun it at 20 m/s: it follows at 12, never faster, until the lock.
    let moved = 0;
    let after = 0;
    while (h.combat.telegraphs.size > 0 && h.combat.telegraphs.at(0) === t && h.world.time < t.hitAt - 2 * STEP) {
      p.x += 20 * STEP;
      x = t.x;
      z = t.z;
      h.step();
      const d = Math.hypot(t.x - x, t.z - z);
      expect(d).toBeLessThanOrEqual(12 * STEP + 1e-9);
      if (h.world.time >= t.lockAt) after += d;
      else moved += d;
    }
    expect(moved).toBeGreaterThan(5);
    expect(after).toBe(0);
    // The Wurm surfaces where the circle ended up.
    const end = { x: t.x, z: t.z };
    expect(runUntil(h, 1, () => wurm.specialKind === 'none')).toBeGreaterThan(0);
    expect(wurm.x).toBeCloseTo(end.x, 9);
    expect(wurm.z).toBeCloseTo(end.z, 9);
  });

  it('a walking or standing player leaves it where it was sampled', () => {
    const { h } = circleDown();
    const t = h.combat.telegraphs.at(0);
    const at = { x: t.x, z: t.z };
    const p = h.world.player;
    for (let i = 0; i < 30; i++) {
      p.x += 6 * STEP;
      h.step();
    }
    expect(t.x).toBe(at.x);
    expect(t.z).toBe(at.z);
  });
});
