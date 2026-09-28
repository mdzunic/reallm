// SPEC-038 §4.2, §6.1 — the ground-telegraph primitive: the shapes'
// coverage, the pool and its capacity, resolution at `hitAt` (once), a ring's
// travelling band, the charge lane that never lands by itself, the follower
// (E60), cancelling with the owner, and the reset on reuse.
import { describe, expect, it } from 'vitest';
import { setLogSink } from '@/core/Log';
import {
  HIT_FOLLOWER,
  HIT_PLAYER,
  makeTelegraph,
  resetTelegraph,
  ringRadius,
  TELEGRAPH_CAPACITY,
  telegraphCovers,
  telegraphProgress,
  type TelegraphEntity,
} from '@/entities/Telegraph';
import { CircleObstacles } from '@/entities/World';
import { STEP, harness, type Harness } from './combatFixtures';

/** A telegraph put straight into the pool, the way `h.shot` puts a projectile. */
function draw(h: Harness, patch: Partial<TelegraphEntity>): TelegraphEntity {
  const t = h.combat.telegraphs.alloc();
  resetTelegraph(t);
  Object.assign(t, { startAt: h.world.time, hitAt: h.world.time + 0.5, damage: 10, source: 'dust_skitter' }, patch);
  if (patch.lockAt === undefined) t.lockAt = t.hitAt;
  return t;
}

function steps(h: Harness, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / STEP); i++) h.step();
}

describe('telegraphCovers (SPEC-038 §3)', () => {
  it('a circle covers what its radius plus the target’s reaches', () => {
    const t = makeTelegraph();
    t.kind = 'circle';
    t.radius = 2;
    expect(telegraphCovers(t, 0, 0, 0.5, 0)).toBe(true);
    expect(telegraphCovers(t, 2.4, 0, 0.5, 0)).toBe(true);
    expect(telegraphCovers(t, 2.6, 0, 0.5, 0)).toBe(false);
  });

  it('a line is its lane: inside, beside and beyond the end', () => {
    const t = makeTelegraph();
    t.kind = 'line';
    t.dirX = 1;
    t.dirZ = 0;
    t.length = 10;
    t.width = 2.8;
    expect(telegraphCovers(t, 5, 0, 0.5, 0), 'inside').toBe(true);
    expect(telegraphCovers(t, 5, 1.85, 0.5, 0), 'grazing the side').toBe(true);
    expect(telegraphCovers(t, 5, 2, 0.5, 0), 'beside').toBe(false);
    expect(telegraphCovers(t, 10.4, 0, 0.5, 0), 'at the far end').toBe(true);
    expect(telegraphCovers(t, 10.6, 0, 0.5, 0), 'beyond the end').toBe(false);
    expect(telegraphCovers(t, -0.6, 0, 0.5, 0), 'behind the origin').toBe(false);
    // Turned: the lane follows its direction.
    t.dirX = 0;
    t.dirZ = 1;
    expect(telegraphCovers(t, 0, 5, 0.5, 0)).toBe(true);
    expect(telegraphCovers(t, 5, 0, 0.5, 0)).toBe(false);
  });

  it('a ring is nothing before hitAt, then a band travelling at ringSpeed', () => {
    const t = makeTelegraph();
    t.kind = 'ring';
    t.hitAt = 1;
    t.ringSpeed = 10;
    t.band = 1;
    t.ringMax = 8;
    expect(telegraphCovers(t, 0, 0, 0.5, 0.5)).toBe(false);
    expect(ringRadius(t, 1.3)).toBeCloseTo(3, 10);
    expect(telegraphCovers(t, 3, 0, 0.5, 1.3)).toBe(true);
    expect(telegraphCovers(t, 5, 0, 0.5, 1.3)).toBe(false);
    expect(telegraphCovers(t, 5, 0, 0.5, 1.5)).toBe(true);
    expect(telegraphCovers(t, 3, 0, 0.5, 1.5)).toBe(false);
  });

  it('progress runs 0 at startAt to 1 at hitAt, clamped', () => {
    const t = makeTelegraph();
    t.startAt = 2;
    t.hitAt = 3;
    expect(telegraphProgress(t, 1)).toBe(0);
    expect(telegraphProgress(t, 2.5)).toBeCloseTo(0.5, 10);
    expect(telegraphProgress(t, 4)).toBe(1);
  });
});

describe('resolution (SPEC-038 §4.2)', () => {
  it('a circle resolves exactly once, at hitAt, through damagePlayer', () => {
    const h = harness();
    draw(h, { kind: 'circle', x: 0.5, z: 0, radius: 1.5, source: 'wurmling' });
    steps(h, 0.45);
    expect(h.of('player:damaged')).toHaveLength(0);
    expect(h.combat.telegraphs.size).toBe(1);
    steps(h, 0.1);
    expect(h.of('player:damaged')).toHaveLength(1);
    expect(h.of('player:damaged')[0]).toMatchObject({ source: { kind: 'enemy', enemyId: 'wurmling' }, from: { x: 0.5, z: 0 } });
    expect(h.combat.telegraphs.size).toBe(0);
    steps(h, 1);
    expect(h.of('player:damaged')).toHaveLength(1);
  });

  it('deals a melee blow’s amount, and knocks the player 1 m from the centre', () => {
    const h = harness();
    h.save.meta.difficulty = 'casual';
    draw(h, { kind: 'circle', x: -0.5, z: 0, radius: 2, damage: 20, elite: true });
    steps(h, 0.55);
    // 20 × 1.5 (elite) × 0.7 (casual), no armour on the Marine's scrap plate.
    expect(h.of('player:damaged')[0]?.amount).toBe(21);
    expect(h.world.player.x).toBeCloseTo(1, 5);
  });

  it('i-frames block a telegraph hit, and the telegraph still goes', () => {
    const h = harness();
    h.world.player.invulnUntil = 100;
    draw(h, { kind: 'circle', x: 0, z: 0, radius: 2 });
    steps(h, 0.6);
    expect(h.of('player:damaged')).toHaveLength(0);
    expect(h.combat.telegraphs.size).toBe(0);
    expect(h.world.player.x).toBe(0); // a blocked hit moves nobody
  });

  it('a ring hits the player once as its band passes, and goes past ringMax', () => {
    const h = harness();
    h.world.player.x = 5;
    const t = draw(h, { kind: 'ring', x: 0, z: 0, hitAt: h.world.time + 0.1, ringSpeed: 10, band: 1, ringMax: 8 });
    steps(h, 0.3);
    expect(h.of('player:damaged')).toHaveLength(0); // the band is at 2 m
    steps(h, 0.4);
    // The band crossed 5 m once — and the 1 m shove outward does not buy a second hit.
    expect(h.of('player:damaged')).toHaveLength(1);
    expect(t.hitMask & HIT_PLAYER).toBe(HIT_PLAYER);
    expect(h.combat.telegraphs.size).toBe(1);
    steps(h, 0.3);
    expect(h.of('player:damaged')).toHaveLength(1);
    expect(h.combat.telegraphs.size).toBe(0); // gone past ringMax + band / 2
  });

  it('a blocked ring still marks the player as passed', () => {
    const h = harness();
    h.world.player.x = 3;
    const t = draw(h, { kind: 'ring', x: 0, z: 0, hitAt: h.world.time, ringSpeed: 10, band: 1, ringMax: 8 });
    h.world.player.invulnUntil = h.world.time + 0.4;
    steps(h, 0.35);
    expect(t.hitMask & HIT_PLAYER).toBe(HIT_PLAYER);
    steps(h, 0.5);
    expect(h.of('player:damaged')).toHaveLength(0);
  });

  it('a bodyResolved line never resolves by itself, and goes when its owner leaves the charge', () => {
    const h = harness();
    const e = h.spawn('wurmling', -6, 0);
    e.aggro = true;
    e.state = 'chargeWindup';
    draw(h, { kind: 'line', x: -6, z: 0, dirX: 1, dirZ: 0, length: 10, width: 2.8, bodyResolved: true, ownerId: e.id, hitAt: h.world.time + 0.1 });
    for (let i = 0; i < 60; i++) {
      e.stateTime = 0; // held in its windup
      h.step();
    }
    expect(h.of('player:damaged')).toHaveLength(0);
    expect(h.combat.telegraphs.size).toBe(1);
    e.state = 'chase';
    e.cooldown = 99;
    h.step();
    expect(h.combat.telegraphs.size).toBe(0);
  });

  it('hits the follower only with hitsFollower (E60), as an enemy blow on it', () => {
    for (const hitsFollower of [false, true]) {
      const h = harness({ follower: true });
      const follower = h.world.follower;
      if (follower === null) throw new Error('no follower');
      const hp = follower.hp;
      // Over the follower at (0, −2), clear of the player at the origin.
      draw(h, { kind: 'circle', x: 0, z: -2.6, radius: 1, damage: 12, hitsFollower });
      steps(h, 0.6);
      expect(h.of('player:damaged')).toHaveLength(0);
      expect(follower.hp, `hitsFollower ${String(hitsFollower)}`).toBe(hitsFollower ? hp - 12 : hp);
      if (hitsFollower) expect(HIT_FOLLOWER).toBe(2);
    }
  });

  it('a following line takes its owner’s position and facing until lockAt', () => {
    const h = harness();
    const e = h.spawn('wurmling', -5, 0);
    e.aggro = true;
    e.state = 'chargeWindup';
    const t = draw(h, {
      kind: 'line',
      x: -5,
      z: 0,
      length: 10,
      width: 2.8,
      bodyResolved: true,
      ownerId: e.id,
      hitAt: h.world.time + 0.5,
      lockAt: h.world.time + 0.2,
    });
    e.stateTime = 0;
    e.x = -4;
    e.facing = Math.PI / 2;
    h.step();
    // It follows the body and the facing the brain turned this step.
    expect(t.x).toBeCloseTo(e.x, 10);
    expect(t.dirX).toBeCloseTo(Math.cos(e.facing), 10);
    expect(t.dirZ).toBeCloseTo(Math.sin(e.facing), 10);
    steps(h, 0.25);
    const locked = { x: t.x, z: t.z, dirX: t.dirX, dirZ: t.dirZ };
    e.x = -2;
    e.facing = 0;
    e.stateTime = 0;
    h.step();
    expect({ x: t.x, z: t.z, dirX: t.dirX, dirZ: t.dirZ }).toEqual(locked);
  });
});

describe('the pool (SPEC-038 §4.2, 38-c, 38-d)', () => {
  it('holds at most 32: the 33rd request is refused and the charge that asked is cancelled', () => {
    const lines: string[] = [];
    const previous = setLogSink({ debug: () => undefined, info: () => undefined, warn: (...args: unknown[]) => void lines.push(args.join(' ')), error: () => undefined });
    try {
      expect(TELEGRAPH_CAPACITY).toBe(32);
      const h = harness();
      for (let i = 0; i < TELEGRAPH_CAPACITY; i++) draw(h, { kind: 'circle', x: 50, z: 50, radius: 1, hitAt: 1e9 });
      const e = h.spawn('wurmling', 5, 0);
      e.aggro = true;
      e.state = 'chase';
      h.step();
      expect(h.combat.telegraphs.size).toBe(TELEGRAPH_CAPACITY);
      expect(e.state).toBe('chase');
      expect(e.cooldown).toBeGreaterThan(2);
      expect(h.of('enemy:windup')).toHaveLength(0);
      expect(lines.some((line) => line.includes('telegraph pool full'))).toBe(true);
    } finally {
      setLogSink(previous);
    }
  });

  it('an owner’s death frees its lane at once, and nothing resolves', () => {
    const h = harness();
    const e = h.spawn('wurmling', 5, 0);
    e.aggro = true;
    e.state = 'chase';
    h.step();
    expect(e.state).toBe('chargeWindup');
    expect(h.combat.telegraphs.size).toBe(1);
    h.combat.killEnemy(e, 'player');
    expect(h.combat.telegraphs.size).toBe(0);
    steps(h, 1);
    expect(h.of('player:damaged')).toHaveLength(0);
  });

  it('a leash or a dismissal frees it too', () => {
    // A dismissal: the spawn director recycles the body without a kill.
    const h = harness();
    const e = h.spawn('wurmling', 5, 0);
    e.aggro = true;
    e.state = 'chase';
    h.step();
    expect(h.combat.telegraphs.size).toBe(1);
    e.state = 'dead';
    h.step();
    expect(h.combat.telegraphs.size).toBe(0);

    // A leash: dragged past its leash radius mid-windup.
    const g = harness();
    const r = g.spawn('wurmling', 5, 0);
    r.aggro = true;
    r.state = 'chase';
    g.step();
    expect(g.combat.telegraphs.size).toBe(1);
    r.spawnX = 100;
    g.step();
    expect(r.state).toBe('leash');
    expect(g.combat.telegraphs.size).toBe(0);
  });

  it('resets every field on reuse', () => {
    const h = harness();
    const dirty = h.combat.telegraphs.alloc();
    Object.assign(dirty, {
      kind: 'ring',
      x: 9,
      z: 9,
      dirX: 0,
      dirZ: -1,
      radius: 9,
      length: 9,
      width: 9,
      band: 9,
      ringSpeed: 9,
      ringMax: 9,
      startAt: 9,
      hitAt: 9,
      lockAt: 9,
      damage: 9,
      elite: true,
      ownerId: 9,
      source: 'hive_queen',
      bodyResolved: true,
      hitsFollower: false,
      hitMask: 3,
    } satisfies TelegraphEntity);
    h.combat.telegraphs.free(0);
    const e = h.spawn('wurmling', 5, 0);
    e.aggro = true;
    e.state = 'chase';
    h.step();
    const t = h.combat.telegraphs.at(0);
    expect(t).toBe(dirty); // the recycled object
    expect(t).toEqual({
      kind: 'line',
      x: e.x,
      z: e.z,
      dirX: Math.cos(e.facing),
      dirZ: Math.sin(e.facing),
      radius: 0,
      length: 10,
      width: 2 * (0.6 + 0.3 + 0.5),
      band: 0,
      ringSpeed: 0,
      ringMax: 0,
      startAt: h.world.time,
      hitAt: h.world.time + 0.5,
      lockAt: h.world.time + 0.5 - 0.15,
      damage: 9 * 1.3,
      elite: false,
      ownerId: e.id,
      source: 'wurmling',
      bodyResolved: true,
      hitsFollower: true,
      hitMask: 0,
    });
  });
});

describe('the lane of a charge behind a rock (SPEC-038 §4.3)', () => {
  it('draws no lane when the line to the target is blocked', () => {
    const h = harness({ obstacles: new CircleObstacles([{ x: 2.5, z: 0, radius: 1 }]) });
    const e = h.spawn('wurmling', 5, 0);
    e.aggro = true;
    e.state = 'chase';
    h.step();
    expect(e.state).not.toBe('chargeWindup');
    expect(h.combat.telegraphs.size).toBe(0);
  });
});
