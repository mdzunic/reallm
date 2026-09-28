// SPEC-038 §4.1, §6.1 — the dash: its constants and cooldown formula, the
// press rule, the 5 m in twelve 60 Hz steps, the 0.3 s of i-frames, the stop
// at a rock or the wall (E59), and what `Combat` holds while it runs — no shot,
// no push-out, no knockback — while the weather still lands. The steps run in
// the scene's order: movement, then `combat.update` (38-b).
import { describe, expect, it } from 'vitest';
import { CLASSES } from '@/data/index';
import { CircleObstacles, NO_OBSTACLES } from '@/entities/World';
import { makePlayer } from '@/entities/Player';
import {
  CASUAL_DASH_MULT,
  DASH_AGILITY_CUT,
  DASH_COOLDOWN,
  DASH_COOLDOWN_MIN,
  DASH_DISTANCE,
  DASH_IFRAMES,
  DASH_SECONDS,
  dashCooldown,
  isDashing,
  stepDash,
  tryDash,
} from '@/systems/Dash';
import { WINDUP_SECONDS } from '@/systems/EnemyAi';
import { STEP, harness, type Harness } from './combatFixtures';

const FAR = 1000;
const scratch = { x: 0, z: 0 };

/** One scene step: the dash moves the player, then combat runs (§4.1). */
function sceneStep(h: Harness, edge = FAR): void {
  const p = h.world.player;
  if (isDashing(p, h.world.time)) stepDash(p, h.world.obstacles, edge, h.world.time, STEP, scratch);
  h.step();
}

function run(h: Harness, seconds: number, edge = FAR): void {
  for (let i = 0; i < Math.round(seconds / STEP); i++) sceneStep(h, edge);
}

describe('the dash constants and cooldown (SPEC-038 §3, §4.1)', () => {
  it('pins the initial tuning', () => {
    expect(DASH_DISTANCE).toBe(5);
    expect(DASH_SECONDS).toBe(0.2);
    expect(DASH_IFRAMES).toBe(0.3);
    expect(DASH_COOLDOWN).toBe(1.4);
    expect(DASH_AGILITY_CUT).toBe(0.03);
    expect(DASH_COOLDOWN_MIN).toBe(0.8);
    expect(CASUAL_DASH_MULT).toBe(0.8);
  });

  it('is max(0.8, 1.4 × (1 − 0.03 × agility) × the passive × casual 0.8)', () => {
    // A Marine at agility 1 on normal: 1.4 × 0.97.
    expect(dashCooldown(CLASSES.marine.passive, 1, 'normal')).toBeCloseTo(1.358, 10);
    // A Scout at agility 4: 1.4 × 0.88 × 0.8.
    expect(dashCooldown(CLASSES.scout.passive, 4, 'normal')).toBeCloseTo(0.9856, 10);
    // A Scout at agility 10 sits on the floor.
    expect(dashCooldown(CLASSES.scout.passive, 10, 'normal')).toBe(0.8);
    // Casual is ×0.8, and still floored (38-m).
    expect(dashCooldown(CLASSES.marine.passive, 1, 'casual')).toBeCloseTo(1.358 * 0.8, 10);
    expect(dashCooldown(CLASSES.scout.passive, 10, 'casual')).toBe(0.8);
    expect(CLASSES.scout.passive.dashCooldownMult).toBe(0.8);
  });
});

describe('tryDash (SPEC-038 §4.1)', () => {
  it('starts a dash, and refuses one inside the cooldown without touching anything', () => {
    const p = makePlayer(0, 0, 100);
    expect(tryDash(p, 3, 4, 10, 1.358)).toBe(true);
    expect(p.dashX).toBeCloseTo(0.6, 10);
    expect(p.dashZ).toBeCloseTo(0.8, 10);
    expect(p.dashUntil).toBeCloseTo(10.2, 10);
    expect(p.dashReadyAt).toBeCloseTo(11.358, 10);
    expect(p.invulnUntil).toBeCloseTo(10.3, 10);
    expect(isDashing(p, 10.1)).toBe(true);
    expect(isDashing(p, 10.2)).toBe(false);

    const before = { ...p };
    expect(tryDash(p, 1, 0, 11, 1.358)).toBe(false);
    expect(p).toEqual(before);
    // Ready again once the cooldown has run.
    expect(tryDash(p, 1, 0, 11.358, 1.358)).toBe(true);
  });

  it('keeps longer i-frames it already has (max, not overwrite)', () => {
    const p = makePlayer(0, 0, 100);
    p.invulnUntil = 5; // a respawn's 2 s, say
    expect(tryDash(p, 1, 0, 4, 1)).toBe(true);
    expect(p.invulnUntil).toBe(5);
  });
});

describe('the dash on the ground (SPEC-038 §4.1, E59)', () => {
  it('covers 5 m (± 0.05) on open ground in twelve 60 Hz steps', () => {
    const p = makePlayer(0, 0, 100);
    let time = 0;
    expect(tryDash(p, 1, 0, time, 1.4)).toBe(true);
    for (let i = 0; i < 12; i++) {
      expect(isDashing(p, time), `step ${i}`).toBe(true);
      stepDash(p, NO_OBSTACLES, FAR, time, STEP, scratch);
      time += STEP;
    }
    expect(Math.abs(p.x - 5)).toBeLessThanOrEqual(0.05);
    expect(p.z).toBe(0);
    // A thirteenth step, should the clock round short, moves nothing that counts.
    if (isDashing(p, time)) stepDash(p, NO_OBSTACLES, FAR, time, STEP, scratch);
    expect(Math.abs(p.x - 5)).toBeLessThanOrEqual(0.05);
  });

  it('stops at a rock, and never ends inside it', () => {
    const rock = new CircleObstacles([{ x: 3, z: 0.2, radius: 1 }]);
    const p = makePlayer(0, 0, 100);
    let time = 0;
    tryDash(p, 1, 0, time, 1.4);
    for (let i = 0; i < 12; i++) {
      stepDash(p, rock, FAR, time, STEP, scratch);
      time += STEP;
    }
    expect(p.x).toBeLessThan(2); // it met the rock and went no further
    expect(rock.hitsCircle(p.x, p.z, p.radius)).toBe(false);
    expect(rock.resolveCircle(p.x, p.z, p.radius, scratch)).toBe(false);
  });

  it('ends at the wall clamp, where it stands, and keeps its i-frames', () => {
    const p = makePlayer(0, 0, 100);
    tryDash(p, 1, 0, 0, 1.4);
    let time = 0;
    for (let i = 0; i < 12 && isDashing(p, time); i++) {
      stepDash(p, NO_OBSTACLES, 2, time, STEP, scratch);
      time += STEP;
    }
    expect(p.x).toBe(2);
    expect(isDashing(p, time)).toBe(false);
    expect(time).toBeLessThan(0.2);
    expect(p.invulnUntil).toBeCloseTo(0.3, 10);
  });

  it('a diagonal dash into a rock that blocks both axes ends early (E59)', () => {
    const rock = new CircleObstacles([{ x: 1.3, z: 1.3, radius: 1 }]);
    const p = makePlayer(0, 0, 100);
    tryDash(p, 1, 1, 0, 1.4);
    let time = 0;
    let steps = 0;
    while (isDashing(p, time) && steps < 20) {
      stepDash(p, rock, FAR, time, STEP, scratch);
      time += STEP;
      steps++;
    }
    expect(steps).toBeLessThan(12);
    expect(rock.hitsCircle(p.x, p.z, p.radius)).toBe(false);
  });
});

describe('what a dash holds in combat (SPEC-038 §4.1, 38-b)', () => {
  it('its i-frames block a melee blow at +0.25 s and not at +0.35 s', () => {
    for (const [offset, lands] of [
      [0.25, false],
      [0.35, true],
    ] as const) {
      const h = harness();
      const e = h.spawn('dust_skitter', 1.2, 0);
      e.aggro = true;
      // The windup ends `offset` s after the press.
      e.state = 'windup';
      e.stateTime = WINDUP_SECONDS.swarm - offset;
      e.cooldown = 0;
      const p = h.world.player;
      // A dash straight at the skitter keeps the player inside its reach.
      tryDash(p, 0, 1, h.world.time, 1.4);
      p.dashUntil = h.world.time; // i-frames without the movement
      run(h, offset + 0.05);
      expect(h.of('player:damaged').length, `a blow at +${offset} s`).toBe(lands ? 1 : 0);
    }
  });

  it('passes through a skitter’s body — no push-out while it runs', () => {
    const h = harness();
    const e = h.spawn('dust_skitter', 2.5, 0);
    e.cooldown = 99; // it only stands in the way
    const p = h.world.player;
    tryDash(p, 1, 0, h.world.time, 1.4);
    run(h, 0.2);
    expect(p.x).toBeGreaterThan(4.5);
    expect(Math.abs(p.x - 5)).toBeLessThanOrEqual(0.3);
  });

  it('drops a knockback that lands mid-dash instead of deferring it', () => {
    const h = harness();
    const p = h.world.player;
    tryDash(p, 0, 1, h.world.time, 1.4);
    // A shot from the side lands on the dash's first step; its i-frames are up,
    // and the shove is dropped with the damage.
    h.shot({ x: p.x - 0.5, z: p.z, vx: 30, vz: 0, owner: 'enemy', enemyId: 'scav_raider', damage: 5 });
    sceneStep(h);
    expect(h.of('player:damaged')).toHaveLength(0);
    expect(Math.abs(p.x)).toBeLessThan(1e-9);
  });

  it('weather still lands during a dash', () => {
    const h = harness();
    const p = h.world.player;
    const hp = p.hp;
    tryDash(p, 1, 0, h.world.time, 1.4);
    sceneStep(h);
    h.combat.damagePlayer(3, { kind: 'weather', weather: 'heatwave' }, true);
    expect(p.hp).toBe(hp - 3);
  });

  it('no projectile spawns while dashing, and auto-fire resumes after', () => {
    const h = harness();
    h.input.autoFire = true;
    const e = h.spawn('scav_raider', 8, 0);
    e.hp = e.maxHp = 1e6;
    const p = h.world.player;
    tryDash(p, 0, 1, h.world.time, 1.4);
    let playerShots = 0;
    for (let i = 0; i < 12; i++) {
      sceneStep(h);
      for (let k = 0; k < h.world.projectiles.size; k++) if (h.world.projectiles.at(k).owner === 'player') playerShots++;
    }
    expect(playerShots).toBe(0);
    expect(h.of('weapon:fired')).toHaveLength(0);
    run(h, 0.5);
    expect(h.of('weapon:fired').length).toBeGreaterThan(0);
  });
});
