// The enemy brains (SPEC-011 §4.5): one `updateEnemy` per fixed step, driving
// the archetype state machines — swarm, rusher, ranged, static, boss — plus the
// §5 edge cases: stuck side-steps (11-d) and the boss arena leash (11-e).
// SPEC-041 §4.1 gives every boss a move list — casts on SPEC-038's telegraphs,
// with the wurm's burrow as its one timed move — and §4.5–§4.6 add pack aggro
// and the affixes a brain carries out (swift windups, the volley's fan). Pure
// code over the entity pools; side effects that touch the player, projectiles
// or events go through `AiHooks`, which `systems/Combat.ts` implements — so
// this module never imports it at runtime.
import type { Rng, WeightedEntry } from '@/core/Rng';
import { VOLLEY_SPEED_MULT, VOLLEY_SPREAD } from '@/data/affixes';
import type { BossMove, EnemyId } from '@/data/enemies';
import { hasAffix, type EnemyEntity } from '@/entities/Enemy';
import type { CombatWorld } from '@/systems/Combat';
import { HIDDEN_DETECT_RADIUS, LOSE_TRACK_SECONDS } from '@/systems/Shelter';

// ------------------------------------------------------- tuning & constants

/** SPEC-034 §4.1: the scratch vector the obstacle resolve writes into. */
const RESOLVED = { x: 0, z: 0 };

/** §4.5 windup telegraphs, seconds by archetype. */
export const WINDUP_SECONDS = { swarm: 0.25, rusher: 0.35, ranged: 0.5, boss: 0.6 } as const;
/** §4.5: the rusher freezes this long after its hit lands; others barely pause. */
export const POST_ATTACK_PAUSE = { swarm: 0.1, rusher: 0.4, boss: 0.1 } as const;
/** §4.5: melee hit check reaches 0.2 m past the windup range. */
export const ATTACK_REACH_BONUS = 0.2;
/** §4.5: swarm lateral sine — ±1 m at 1.5 Hz while chasing. */
export const SWARM_SINE_AMPLITUDE = 1;
export const SWARM_SINE_HZ = 1.5;
/** §4.5: leash return runs at 1.2× speed, invulnerable, heals on arrival. */
export const LEASH_SPEED_MULT = 1.2;
export const LEASH_ARRIVE_DISTANCE = 0.5;
/** §4.5: separation from neighbours within 1.5 × radius sum, weight 1.2. */
export const SEPARATION_RANGE_MULT = 1.5;
export const SEPARATION_WEIGHT = 1.2;
/** §4.5: obstacle look-ahead distance. */
export const AVOID_LOOKAHEAD = 2;
/** §4.5 ranged: strafe speed, band floor and panic distance. */
export const STRAFE_SPEED = 3.5;
export const RANGED_BAND_MIN = 6;
export const RANGED_RETREAT_DISTANCE = 4;
/** §4.5: aggro spreads to same-species enemies within 8 m (done in Combat). */
export const AGGRO_SPREAD_RADIUS = 8;
/** §4.5: the follower counts as 1.4× farther when picking a target. */
export const FOLLOWER_TARGET_BIAS = 1.4;
/** 11-d: under 0.3 m/s for 1.5 s in chase → side-step 0.8 s. */
export const STUCK_SPEED = 0.3;
export const STUCK_SECONDS = 1.5;
export const SIDESTEP_SECONDS = 0.8;
export const SIDESTEP_DISTANCE = 2;
/** 11-e: beyond `arena.radius + 4` for 8 s resets the boss. */
export const ARENA_LEASH_MARGIN = 4;
export const ARENA_LEASH_SECONDS = 8;
export const ARENA_RESET_TOAST = 'The beast retreats';
/** §4.5 boss special: invulnerable 1.5 s while the phase turns over. */
export const PHASE_SPECIAL_SECONDS = 1.5;
/** SPEC-041 §3: rad/s a boss turns while it casts a charge or a volley. */
export const BOSS_TURN_RATE = 4;
/** SPEC-041 §3, 41-b: metres past the arena radius a boss charge may reach. */
export const BOSS_CHARGE_RING_MARGIN = 2;
/** SPEC-041 §4.1: a boss's first weighted move waits this long after it spawns. */
export const BOSS_FIRST_MOVE_SECONDS = 2;
/** Wander: a point within 8 m of spawn every 2–4 s, at a stroll. */
export const WANDER_RADIUS = 8;
export const WANDER_SPEED_MULT = 0.4;
/** Enemy projectile flight allowance past the firing range. Initial tuning. */
export const ENEMY_PROJECTILE_RANGE_MULT = 1.5;

/** SPEC-038 §3: what a windup is winding up — the `enemy:windup` cue's kind. SPEC-041 adds the boss kinds. */
export type WindupKind = 'melee' | 'charge' | 'shot' | 'slam' | 'lines' | 'ring' | 'volley' | 'burrow';
/** SPEC-038 §4.3: a swarm keeps closing at this × its speed while it winds up. */
export const SWARM_WINDUP_TRACK = 1;
/**
 * SPEC-038 §4.3, *initial tuning*: the rusher's charge. It triggers within
 * `trigger` m on a clear line, winds up `windup` s rooted while its facing turns
 * at up to `turnRate` rad/s — locked `lock` s before the run — then runs at
 * `speed` m/s for up to `length` m. First contact deals `damageMult` × with
 * `knockback` m and recovers `recoverHit` s; a whiff recovers `recoverWhiff` s.
 * The next charge waits `cooldown` s. `pad` widens the lane and the reach.
 */
export const CHARGE = {
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
} as const;

const TAU = Math.PI * 2;

/** Side effects the brain asks of combat (damage, projectiles, summons, UI). */
export interface AiHooks {
  /**
   * The windup completed and the hit check passed against `e.target` — or a
   * charge touched it (SPEC-038 §4.3), which passes its multiplier and its
   * knockback.
   */
  meleeHit(e: EnemyEntity, damageMult?: number, knockback?: number): void;
  /** SPEC-041 §3: a boss volley passes its move's `damageMult`; every other shot carries `e.damage`. */
  fireProjectile(
    e: EnemyEntity,
    dirX: number,
    dirZ: number,
    speed: number,
    radius: number,
    range: number,
    damageMult?: number,
  ): void;
  summonRing(e: EnemyEntity, enemy: EnemyId, count: number, radius: number): void;
  phaseStarted(e: EnemyEntity, phase: number): void;
  toast(text: string): void;
  /** SPEC-041 §4.1: a boss move landed at `(x, z)` — `boss:move`. */
  bossMove(e: EnemyEntity, move: BossMove, x: number, z: number): void;
  /** SPEC-041 §4.5: a pack member acquired the player — every live member aggroes. */
  aggroPack(packId: number): void;
  /** SPEC-038 §4.2: a windup started — `enemy:windup` and its cue. */
  windup(e: EnemyEntity, kind: WindupKind): void;
  /**
   * SPEC-038 §4.2: a lane from `e` along its facing, landing `windup` s (× the
   * casual multiplier) from now and following `e` until `lockIn` s before that.
   * False when the pool is full — the attack is cancelled (38-c).
   */
  telegraphLine(
    e: EnemyEntity,
    length: number,
    width: number,
    windup: number,
    lockIn: number,
    damageMult: number,
    bodyResolved: boolean,
  ): boolean;
  telegraphCircle(e: EnemyEntity, x: number, z: number, radius: number, windup: number, damageMult: number): boolean;
  telegraphRing(
    e: EnemyEntity,
    x: number,
    z: number,
    ringMax: number,
    ringSpeed: number,
    band: number,
    windup: number,
    damageMult: number,
  ): boolean;
  /** Frees every pending telegraph `e` drew (a death, a leash, a dismissal, the end of a charge). */
  cancelTelegraphs(e: EnemyEntity): void;
}

// ------------------------------------------------------------------ helpers

function distance(x0: number, z0: number, x1: number, z1: number): number {
  return Math.hypot(x1 - x0, z1 - z0);
}

interface TargetInfo {
  x: number;
  z: number;
  radius: number;
  alive: boolean;
}

/** §4.5: nearest of player and follower, the follower counting as 1.4× farther. */
function selectTarget(e: EnemyEntity, world: CombatWorld): void {
  const p = world.player;
  const f = world.follower;
  const dp = p.alive ? distance(e.x, e.z, p.x, p.z) : Infinity;
  const df = f !== null && f.alive ? distance(e.x, e.z, f.x, f.z) : Infinity;
  // Player preferred at equal effective distance.
  e.target = dp <= df * FOLLOWER_TARGET_BIAS ? 'player' : 'follower';
}

function targetOf(e: EnemyEntity, world: CombatWorld): TargetInfo {
  if (e.target === 'follower' && world.follower !== null) {
    const f = world.follower;
    return { x: f.x, z: f.z, radius: f.radius, alive: f.alive };
  }
  const p = world.player;
  return { x: p.x, z: p.z, radius: p.radius, alive: p.alive };
}

/** Melee reach: surface-to-surface, so big bodies and big targets both count. */
function meleeReach(e: EnemyEntity, target: TargetInfo): number {
  const range = e.def.attack.kind === 'melee' ? e.def.attack.range : 0;
  return e.radius + range + target.radius;
}

function enterState(e: EnemyEntity, state: EnemyEntity['state']): void {
  e.state = state;
  e.stateTime = 0;
}

function enterLeash(e: EnemyEntity): void {
  enterState(e, 'leash');
  e.aggro = false;
  e.invulnerable = true;
  e.stuckTime = 0;
  e.sideUntil = 0;
  e.recoverFor = 0;
  e.chargeLeft = 0;
}

function pickWanderPoint(e: EnemyEntity, world: CombatWorld, rng: Rng): void {
  const at = rng.inDisc(WANDER_RADIUS);
  e.wanderX = e.spawnX + at.x;
  e.wanderZ = e.spawnZ + at.z;
  e.wanderAt = world.time + rng.float(2, 4);
}

/**
 * Steer toward the desired velocity with the §4.5 common behaviours layered on
 * — separation, obstacle look-ahead, soft arena boundary — then integrate with
 * axis-sliding collision. Returns the speed actually achieved, for 11-d.
 */
function move(e: EnemyEntity, world: CombatWorld, dt: number, desiredX: number, desiredZ: number): number {
  let vx = desiredX;
  let vz = desiredZ;

  // Separation from neighbours within 1.5 × radius sum, weight 1.2 (AC).
  const enemies = world.enemies;
  for (let i = 0; i < enemies.size; i++) {
    const other = enemies.at(i);
    if (other === e || other.state === 'dead' || other.specialKind === 'burrow_dig') continue;
    const dx = e.x - other.x;
    const dz = e.z - other.z;
    const d = Math.hypot(dx, dz);
    const reach = SEPARATION_RANGE_MULT * (e.radius + other.radius);
    if (d >= reach || d < 1e-6) continue;
    vx += (dx / d) * SEPARATION_WEIGHT;
    vz += (dz / d) * SEPARATION_WEIGHT;
  }

  // Obstacle avoidance: sample the grid 2 m ahead; try ±60° when blocked.
  const speed = Math.hypot(vx, vz);
  if (speed > 1e-6) {
    const ax = e.x + (vx / speed) * AVOID_LOOKAHEAD;
    const az = e.z + (vz / speed) * AVOID_LOOKAHEAD;
    if (world.obstacles.hitsCircle(ax, az, e.radius)) {
      const base = Math.atan2(vz, vx);
      for (const turn of [Math.PI / 3, -Math.PI / 3]) {
        const cx = e.x + Math.cos(base + turn) * AVOID_LOOKAHEAD;
        const cz = e.z + Math.sin(base + turn) * AVOID_LOOKAHEAD;
        if (!world.obstacles.hitsCircle(cx, cz, e.radius)) {
          vx = Math.cos(base + turn) * speed;
          vz = Math.sin(base + turn) * speed;
          break;
        }
      }
    }
  }

  // Soft arena boundary: a gentle inward push past the wall, not a clamp.
  const arena = world.arena;
  if (arena !== null) {
    const dx = arena.x - e.x;
    const dz = arena.z - e.z;
    const d = Math.hypot(dx, dz);
    const overshoot = d - (arena.radius - e.radius);
    if (overshoot > 0 && d > 1e-6) {
      const push = Math.min(4, overshoot * 2);
      vx += (dx / d) * push;
      vz += (dz / d) * push;
    }
  }

  e.vx = vx;
  e.vz = vz;
  // SPEC-034 §4.1: resolve out of any obstacle *before* the slide, so a body
  // knocked into a rock is never refused every direction.
  if (world.obstacles.resolveCircle(e.x, e.z, e.radius, RESOLVED)) {
    e.x = RESOLVED.x;
    e.z = RESOLVED.z;
  }
  const beforeX = e.x;
  const beforeZ = e.z;
  const nx = e.x + vx * dt;
  const nz = e.z + vz * dt;
  // Axis slide: blocked on one axis still moves along the other. Enemy vs
  // enemy: no collision (§4.4) — separation is the only body force.
  if (!world.obstacles.hitsCircle(nx, e.z, e.radius)) e.x = nx;
  if (!world.obstacles.hitsCircle(e.x, nz, e.radius)) e.z = nz;
  // SPEC-030 §4.7: the arena wall — the same clamp the player's movement runs.
  const bounds = world.bounds;
  if (bounds !== undefined) {
    e.x = Math.max(-bounds, Math.min(bounds, e.x));
    e.z = Math.max(-bounds, Math.min(bounds, e.z));
  }
  if (Math.hypot(vx, vz) > 1e-3) e.facing = Math.atan2(vz, vx);
  return dt > 0 ? distance(beforeX, beforeZ, e.x, e.z) / dt : 0;
}

/** 11-d: track sub-0.3 m/s chase steps; side-step perpendicular for 0.8 s. */
function trackStuck(e: EnemyEntity, world: CombatWorld, dt: number, achieved: number, dirX: number, dirZ: number): void {
  if (achieved < STUCK_SPEED) e.stuckTime += dt;
  else e.stuckTime = 0;
  if (e.stuckTime >= STUCK_SECONDS && world.time >= e.sideUntil) {
    const side = (e.id & 1) === 0 ? 1 : -1;
    e.wanderX = e.x - dirZ * SIDESTEP_DISTANCE * side;
    e.wanderZ = e.z + dirX * SIDESTEP_DISTANCE * side;
    e.sideUntil = world.time + SIDESTEP_SECONDS;
    e.stuckTime = 0;
  }
}

// -------------------------------------------------------------- archetypes

/** SPEC-030 §4.6: who hiding affects — ambient, non-boss enemies (D-21). */
function heedsHiding(e: EnemyEntity): boolean {
  return !e.fromWave && e.def.archetype !== 'boss';
}

function updateWander(e: EnemyEntity, world: CombatWorld, dt: number, rng: Rng, hooks: AiHooks): void {
  // §4.5 de-aggro: a dead player ends combat outright — acquiring the live
  // follower here would undo the forced wander and flip states every step.
  if (world.player.alive) {
    selectTarget(e, world);
    const target = targetOf(e, world);
    if (target.alive) {
      const d = distance(e.x, e.z, target.x, target.z);
      // SPEC-012 §4.6: storm visibility narrows the aggro radius.
      const aggroRadius = e.def.aggroRadius * (world.aggroMult ?? 1);
      let acquires = aggroRadius > 0 && d <= aggroRadius;
      // SPEC-030 §4.6: a hidden player is acquired only within 5 m with a
      // clear line — hiding narrows the rule, it never widens it. It covers
      // the player only (30-c), and waves and bosses ignore it (AC-28).
      if (
        acquires &&
        world.playerHidden === true &&
        e.target === 'player' &&
        heedsHiding(e) &&
        (d > HIDDEN_DETECT_RADIUS || !world.obstacles.lineClear(e.x, e.z, world.player.x, world.player.z))
      ) {
        acquires = false;
      }
      if (e.aggro || acquires) {
        e.aggro = true;
        enterState(e, 'chase');
        // SPEC-041 §4.5: a pack member that acquires the player brings the
        // whole pack with it.
        if (acquires && e.packId > 0) hooks.aggroPack(e.packId);
        return;
      }
    }
  }
  if (world.time >= e.wanderAt) pickWanderPoint(e, world, rng);
  const dx = e.wanderX - e.x;
  const dz = e.wanderZ - e.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.3) return;
  const speed = e.speed * WANDER_SPEED_MULT;
  move(e, world, dt, (dx / d) * speed, (dz / d) * speed);
}

function updateChase(e: EnemyEntity, world: CombatWorld, dt: number, rng: Rng, hooks: AiHooks): void {
  const target = targetOf(e, world);
  const arch = e.def.archetype;
  const d = distance(e.x, e.z, target.x, target.z);

  // SPEC-041 §4.1: a boss whose move cooldown is spent picks a move before it
  // thinks about its melee — by weight, among those its phase and the
  // target's distance allow.
  if (arch === 'boss' && target.alive && e.moveIndex < 0 && e.moveCd <= 0) {
    const pick = pickBossMove(e, d, rng);
    if (pick >= 0) {
      startCast(e, pick, target, hooks);
      return;
    }
  }

  if (arch === 'ranged') {
    if (e.def.attack.kind === 'ranged' && d <= e.def.attack.range * 0.8) {
      enterState(e, 'strafe');
      return;
    }
  } else if (d <= meleeReach(e, target) && e.cooldown <= 0) {
    // SPEC-038 §4.3: inside melee reach the SPEC-011 melee wins; the charge is
    // the opener.
    enterState(e, 'windup');
    e.facing = Math.atan2(target.z - e.z, target.x - e.x);
    hooks.windup(e, 'melee');
    return;
  } else if (
    arch === 'rusher' &&
    target.alive &&
    d <= CHARGE.trigger &&
    e.cooldown <= 0 &&
    world.obstacles.lineClear(e.x, e.z, target.x, target.z)
  ) {
    startChargeWindup(e, target, hooks);
    return;
  }

  // 11-d: while a side-step runs, head for its point instead of the target.
  let gx = target.x;
  let gz = target.z;
  if (world.time < e.sideUntil) {
    gx = e.wanderX;
    gz = e.wanderZ;
  }
  const dirD = Math.max(1e-6, distance(e.x, e.z, gx, gz));
  const dirX = (gx - e.x) / dirD;
  const dirZ = (gz - e.z) / dirD;
  let vx = dirX * e.speed;
  let vz = dirZ * e.speed;

  // §4.5: swarms weave — a lateral ±1 m sine at 1.5 Hz while chasing.
  if (arch === 'swarm') {
    const omega = TAU * SWARM_SINE_HZ;
    const lateral = Math.cos(omega * world.time + e.id * 2.399) * omega * SWARM_SINE_AMPLITUDE;
    vx += -dirZ * lateral;
    vz += dirX * lateral;
  }

  const achieved = move(e, world, dt, vx, vz);
  trackStuck(e, world, dt, achieved, dirX, dirZ);
  e.facing = Math.atan2(target.z - e.z, target.x - e.x);
}

/**
 * SPEC-038 §4.6: a windup's length on the world's difficulty (1.25× on
 * casual). SPEC-041 §4.6: a swift elite's `windupScale` (0.8) rides on top.
 */
function windupFor(seconds: number, world: CombatWorld, e: EnemyEntity): number {
  return seconds * (world.windupMult ?? 1) * e.windupScale;
}

function updateWindup(e: EnemyEntity, world: CombatWorld, dt: number, hooks: AiHooks): void {
  const arch = e.def.archetype;
  if (arch === 'ranged') {
    if (e.stateTime < windupFor(WINDUP_SECONDS.ranged, world, e)) return;
    // §4.5: fire at the target's *current* position — no leading, by design.
    const target = targetOf(e, world);
    const d = Math.max(1e-6, distance(e.x, e.z, target.x, target.z));
    if (e.def.attack.kind === 'ranged' && target.alive) {
      const attack = e.def.attack;
      const range = attack.range * ENEMY_PROJECTILE_RANGE_MULT;
      const dirX = (target.x - e.x) / d;
      const dirZ = (target.z - e.z) / d;
      if (hasAffix(e, 'volley')) {
        // SPEC-041 §4.6: the shot becomes three, at 0 and ±0.25 rad, ×1.2
        // faster; each carries the full damage.
        const speed = attack.projectileSpeed * VOLLEY_SPEED_MULT;
        const base = Math.atan2(dirZ, dirX);
        hooks.fireProjectile(e, dirX, dirZ, speed, attack.projectileRadius, range);
        hooks.fireProjectile(e, Math.cos(base + VOLLEY_SPREAD), Math.sin(base + VOLLEY_SPREAD), speed, attack.projectileRadius, range);
        hooks.fireProjectile(e, Math.cos(base - VOLLEY_SPREAD), Math.sin(base - VOLLEY_SPREAD), speed, attack.projectileRadius, range);
      } else {
        hooks.fireProjectile(e, dirX, dirZ, attack.projectileSpeed, attack.projectileRadius, range);
      }
      e.cooldown = attack.cooldown;
    }
    enterState(e, 'strafe');
    return;
  }
  const windup = windupFor(
    arch === 'boss' ? WINDUP_SECONDS.boss : arch === 'rusher' ? WINDUP_SECONDS.rusher : WINDUP_SECONDS.swarm,
    world,
    e,
  );
  const target = targetOf(e, world);
  // SPEC-038 §4.3: a swarm keeps closing while it winds up — full speed until
  // it is inside half its reach — so walking away no longer erases the bite.
  if (arch === 'swarm') trackDuringWindup(e, world, dt, target);
  if (e.stateTime < windup) return;
  // §4.5: the hit check happens now, at range + 0.2 — a dodge steps outside it.
  const d = distance(e.x, e.z, target.x, target.z);
  if (target.alive && d <= meleeReach(e, target) + ATTACK_REACH_BONUS) hooks.meleeHit(e);
  if (e.def.attack.kind === 'melee') e.cooldown = e.def.attack.cooldown;
  e.recoverFor = 0; // the archetype's own pause
  enterState(e, 'attack');
}

/** SPEC-038 §4.3: the swarm's mobile windup — separation and the arena push apply, as in chase. */
function trackDuringWindup(e: EnemyEntity, world: CombatWorld, dt: number, target: TargetInfo): void {
  const d = distance(e.x, e.z, target.x, target.z);
  if (target.alive && d >= meleeReach(e, target) * 0.5 && d > 1e-6) {
    const speed = e.speed * SWARM_WINDUP_TRACK;
    move(e, world, dt, ((target.x - e.x) / d) * speed, ((target.z - e.z) / d) * speed);
  }
  e.facing = Math.atan2(target.z - e.z, target.x - e.x);
}

/**
 * The post-hit recover; the rusher's 0.4 s pause lives here (§4.5). SPEC-038
 * §4.3: a charge sets its own (`recoverFor`) — 0.5 s after a hit, 0.9 s after
 * a whiff.
 */
function updateAttack(e: EnemyEntity): void {
  const arch = e.def.archetype;
  const pause =
    e.recoverFor > 0
      ? e.recoverFor
      : arch === 'rusher'
        ? POST_ATTACK_PAUSE.rusher
        : arch === 'boss'
          ? POST_ATTACK_PAUSE.boss
          : POST_ATTACK_PAUSE.swarm;
  if (e.stateTime < pause) return;
  e.recoverFor = 0;
  enterState(e, 'chase');
}

// --------------------------------------------------------- SPEC-038: charge

/**
 * §4.3 — the trigger fired: face the target, cue the charge and draw the lane.
 * A lane the pool refused cancels the attack back into chase with the charge's
 * cooldown (38-c).
 */
function startChargeWindup(e: EnemyEntity, target: TargetInfo, hooks: AiHooks): void {
  e.facing = Math.atan2(target.z - e.z, target.x - e.x);
  const width = 2 * (e.radius + CHARGE.pad + 0.5);
  // SPEC-041 §4.6: a swift rusher's lane lands with its shorter windup.
  if (!hooks.telegraphLine(e, CHARGE.length, width, CHARGE.windup * e.windupScale, CHARGE.lock, CHARGE.damageMult, true)) {
    e.cooldown = CHARGE.cooldown;
    return;
  }
  enterState(e, 'chargeWindup');
  e.recoverFor = 0;
  hooks.windup(e, 'charge');
}

/** The shortest signed turn from `from` to `to`, in (−π, π]. */
function angleDelta(from: number, to: number): number {
  let delta = (to - from) % TAU;
  if (delta > Math.PI) delta -= TAU;
  else if (delta <= -Math.PI) delta += TAU;
  return delta;
}

/**
 * §4.3: rooted for the windup (× the casual multiplier), turning toward the
 * target at up to `turnRate` until `lock` s before the run — then locked. The
 * lock offset does not scale.
 */
function updateChargeWindup(e: EnemyEntity, world: CombatWorld, dt: number, hooks: AiHooks): void {
  const windup = windupFor(CHARGE.windup, world, e);
  const target = targetOf(e, world);
  if (e.stateTime < windup - CHARGE.lock) {
    const wanted = Math.atan2(target.z - e.z, target.x - e.x);
    const delta = angleDelta(e.facing, wanted);
    const most = CHARGE.turnRate * dt;
    e.facing += Math.max(-most, Math.min(most, delta));
  }
  e.vx = 0;
  e.vz = 0;
  if (e.stateTime < windup) return;
  enterState(e, 'charge');
  e.chargeLeft = CHARGE.length;
  e.chargeSpeed = CHARGE.speed;
  e.chargeReach = e.radius + world.player.radius + CHARGE.pad;
  e.chargeDamageMult = CHARGE.damageMult;
  e.chargeStops = true;
  e.chargeHit = false;
  // The first step of the run happens now, so the windup's end is the run's start.
  updateCharge(e, world, dt, hooks);
}

/**
 * The first touch along the step from `(ax, az)` in the unit direction `(ux,
 * uz)` for `length` m: the distance travelled before the centre `(cx, cz)` came
 * within `reach`, or −1 when it never does. Already within is 0.
 */
function sweptContact(ax: number, az: number, ux: number, uz: number, length: number, cx: number, cz: number, reach: number): number {
  const wx = ax - cx;
  const wz = az - cz;
  const c = wx * wx + wz * wz - reach * reach;
  if (c <= 0) return 0;
  const b = wx * ux + wz * uz;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = -b - Math.sqrt(disc);
  return s >= 0 && s <= length ? s : -1;
}

/**
 * SPEC-041 §4.1, 41-b: how far `(x, z)` may travel along the unit `(ux, uz)`
 * before it leaves the circle of `limit` around `(cx, cz)` — 0 when it is
 * already outside and not heading back in.
 */
function roomInside(x: number, z: number, ux: number, uz: number, cx: number, cz: number, limit: number): number {
  const wx = x - cx;
  const wz = z - cz;
  const b = wx * ux + wz * uz;
  const c = wx * wx + wz * wz - limit * limit;
  const disc = b * b - c;
  if (disc < 0) return 0;
  if (c > 0 && b >= 0) return 0;
  return Math.max(0, -b + Math.sqrt(disc));
}

/**
 * §4.3: the run — `min(chargeLeft, speed × dt)` along the locked facing each
 * step, with no separation and no enemy collision (38-e). The obstacle test is
 * the axis slide: a blocked axis ends it at its last clear position, and so
 * does the wall (E61). The first of the player and the follower it touches takes
 * `meleeHit` with the charge's multiplier and knockback. SPEC-041 §4.1: a
 * boss's charge does not stop there — its one contact lands (`chargeHit`) and
 * it runs on — and it ends where its centre would pass the arena ring + 2 m
 * (41-b), so it never trips its own leash.
 */
function updateCharge(e: EnemyEntity, world: CombatWorld, dt: number, hooks: AiHooks): void {
  const ux = Math.cos(e.facing);
  const uz = Math.sin(e.facing);
  let travel = Math.min(e.chargeLeft, e.chargeSpeed * dt);
  let blocked = false;
  const nx = e.x + ux * travel;
  const nz = e.z + uz * travel;
  if (world.obstacles.hitsCircle(nx, e.z, e.radius) || world.obstacles.hitsCircle(e.x, nz, e.radius)) {
    blocked = true;
    travel = 0;
  }
  const bounds = world.bounds;
  if (bounds !== undefined && travel > 0) {
    // SPEC-030 §4.7: the wall clamps it — and a clamp ends the run.
    const cx = Math.max(-bounds, Math.min(bounds, nx));
    const cz = Math.max(-bounds, Math.min(bounds, nz));
    if (cx !== nx || cz !== nz) {
      blocked = true;
      travel = Math.max(0, Math.min(travel, Math.hypot(cx - e.x, cz - e.z)));
    }
  }
  const arena = world.arena;
  if (e.def.archetype === 'boss' && arena !== null && travel > 0) {
    const room = roomInside(e.x, e.z, ux, uz, arena.x, arena.z, arena.radius + BOSS_CHARGE_RING_MARGIN - e.radius);
    if (room < travel) {
      blocked = true;
      travel = room;
    }
  }

  // E61: whichever of the player and the follower is met first along the run.
  // `chargeReach` is the player's; the lane's half-width carries over to the
  // follower's own radius.
  let hitAt = -1;
  let hitTarget: EnemyEntity['target'] = 'player';
  if (!e.chargeHit) {
    const p = world.player;
    if (p.alive) hitAt = sweptContact(e.x, e.z, ux, uz, travel, p.x, p.z, e.chargeReach);
    const f = world.follower;
    if (f !== null && f.alive) {
      const reach = e.chargeReach - p.radius + f.radius;
      const s = sweptContact(e.x, e.z, ux, uz, travel, f.x, f.z, reach);
      if (s >= 0 && (hitAt < 0 || s < hitAt)) {
        hitAt = s;
        hitTarget = 'follower';
      }
    }
  }

  const moved = hitAt >= 0 && e.chargeStops ? hitAt : travel;
  e.x += ux * moved;
  e.z += uz * moved;
  e.vx = ux * e.chargeSpeed;
  e.vz = uz * e.chargeSpeed;
  e.chargeLeft -= moved;

  if (hitAt >= 0) {
    e.target = hitTarget;
    hooks.meleeHit(e, e.chargeDamageMult, CHARGE.knockback);
    e.chargeHit = true;
    if (e.chargeStops) {
      endCharge(e, hooks);
      return;
    }
  }
  if (blocked || e.chargeLeft <= 1e-6) endCharge(e, hooks);
}

/**
 * The run is over: the lane goes, the next charge waits, and the brain
 * recovers. SPEC-041 §4.1: a boss's charge is a move — it lands where it ended
 * (`boss:move`) and recovers for the move's `recover`.
 */
function endCharge(e: EnemyEntity, hooks: AiHooks): void {
  hooks.cancelTelegraphs(e);
  e.chargeLeft = 0;
  e.vx = 0;
  e.vz = 0;
  const move = currentMove(e);
  if (move !== null) {
    finishMove(e, move, e.x, e.z, hooks);
    return;
  }
  e.recoverFor = e.chargeHit ? CHARGE.recoverHit : CHARGE.recoverWhiff;
  e.cooldown = CHARGE.cooldown;
  enterState(e, 'attack');
}

function updateStrafe(e: EnemyEntity, world: CombatWorld, dt: number, hooks: AiHooks): void {
  if (e.def.attack.kind !== 'ranged') {
    enterState(e, 'chase');
    return;
  }
  const attack = e.def.attack;
  const target = targetOf(e, world);
  const d = distance(e.x, e.z, target.x, target.z);

  // Fire cycle: every `cooldown` seconds, a 0.5 s telegraph then the shot.
  if (e.cooldown <= 0 && d <= attack.range && target.alive) {
    enterState(e, 'windup');
    e.facing = Math.atan2(target.z - e.z, target.x - e.x);
    hooks.windup(e, 'shot');
    return;
  }

  const awayX = d > 1e-6 ? (e.x - target.x) / d : 1;
  const awayZ = d > 1e-6 ? (e.z - target.z) / d : 0;
  let vx: number;
  let vz: number;
  if (d < RANGED_RETREAT_DISTANCE || d < RANGED_BAND_MIN) {
    // Retreat / reopen the band.
    vx = awayX * STRAFE_SPEED;
    vz = awayZ * STRAFE_SPEED;
  } else if (d > attack.range) {
    vx = -awayX * e.speed;
    vz = -awayZ * e.speed;
  } else {
    // Orbit at 3.5 m/s; direction fixed per entity so it reads as circling.
    const side = (e.id & 1) === 0 ? 1 : -1;
    vx = -awayZ * STRAFE_SPEED * side;
    vz = awayX * STRAFE_SPEED * side;
  }
  move(e, world, dt, vx, vz);
  e.facing = Math.atan2(target.z - e.z, target.x - e.x);
}

function updateLeash(e: EnemyEntity, world: CombatWorld, dt: number): void {
  const dx = e.spawnX - e.x;
  const dz = e.spawnZ - e.z;
  const d = Math.hypot(dx, dz);
  if (d <= LEASH_ARRIVE_DISTANCE) {
    // §4.5: heals to full on arrival.
    e.hp = e.maxHp;
    e.invulnerable = false;
    e.cooldown = 0;
    enterState(e, e.def.archetype === 'static' ? 'idle' : 'wander');
    e.wanderAt = world.time;
    return;
  }
  const speed = e.speed * LEASH_SPEED_MULT;
  move(e, world, dt, (dx / d) * speed, (dz / d) * speed);
}

// -------------------------------------------------------------------- boss

/**
 * SPEC-041 §4.1: the weighted pick's scratch — module level, so a pick never
 * allocates. `MOVE_ENTRIES` holds one reusable entry per move slot, and
 * `moveScratch` is filled with references to the eligible ones.
 */
const MOVE_ENTRIES: WeightedEntry<number>[] = [];
const moveScratch: WeightedEntry<number>[] = [];

/** The move `e` is running, or `null`. */
function currentMove(e: EnemyEntity): BossMove | null {
  const moves = e.def.moves;
  if (moves === undefined || e.moveIndex < 0) return null;
  return moves[e.moveIndex] ?? null;
}

/** The index of the boss's timed move (the burrow), or −1. */
function timedMoveIndex(e: EnemyEntity): number {
  const moves = e.def.moves;
  if (moves === undefined) return -1;
  for (let k = 0; k < moves.length; k++) {
    const move = moves[k] as BossMove;
    if (move.weight === 0 && move.every !== undefined) return k;
  }
  return -1;
}

/**
 * §4.1: the moves `e` may use now — weight above 0, `phaseMin ≤ phase` and the
 * target's distance `d` inside `range` — picked by weight on the `ai` stream.
 * −1 when none qualifies, and then no draw is taken.
 */
function pickBossMove(e: EnemyEntity, d: number, rng: Rng): number {
  const moves = e.def.moves;
  if (moves === undefined) return -1;
  moveScratch.length = 0;
  for (let k = 0; k < moves.length; k++) {
    const move = moves[k] as BossMove;
    if (move.weight <= 0 || move.phaseMin > e.phase || d < move.range[0] || d > move.range[1]) continue;
    let entry = MOVE_ENTRIES[k];
    if (entry === undefined) {
      entry = { item: k, weight: 0 };
      MOVE_ENTRIES[k] = entry;
    }
    entry.item = k;
    entry.weight = move.weight;
    moveScratch.push(entry);
  }
  if (moveScratch.length === 0) return -1;
  return rng.weighted(moveScratch);
}

/** §4.1: the `enemy:windup` word for a move kind — the two slams share `slam`. */
function windupKindOf(move: BossMove): WindupKind {
  return move.kind === 'slam_target' || move.kind === 'slam_self' ? 'slam' : move.kind;
}

/**
 * §4.1 — casting: face the target, draw the move's telegraphs on SPEC-038's
 * hooks (each landing `windup × windupScale`, which the hook stretches by
 * `windupMult`), cue the windup, and root. A refused telegraph cancels the
 * move into its recovery.
 */
function startCast(e: EnemyEntity, index: number, target: TargetInfo, hooks: AiHooks): void {
  const move = (e.def.moves as readonly BossMove[])[index] as BossMove;
  e.moveIndex = index;
  e.facing = Math.atan2(target.z - e.z, target.x - e.x);
  e.castX = e.x;
  e.castZ = e.z;
  e.vx = 0;
  e.vz = 0;
  const windup = move.windup * e.windupScale;
  let drawn = true;
  switch (move.kind) {
    case 'slam_target':
      e.castX = target.x;
      e.castZ = target.z;
      drawn = hooks.telegraphCircle(e, target.x, target.z, move.radius ?? 0, windup, move.damageMult);
      break;
    case 'slam_self':
      drawn = hooks.telegraphCircle(e, e.x, e.z, e.radius + (move.radius ?? 0), windup, move.damageMult);
      break;
    case 'lines': {
      // `count` lanes fanned `spread` apart around the facing, none of them
      // following: the hook reads the facing at draw time, so it is turned
      // to each lane and back.
      const count = move.count ?? 1;
      const facing = e.facing;
      for (let k = 0; k < count && drawn; k++) {
        e.facing = facing + (k - (count - 1) / 2) * (move.spread ?? 0);
        drawn = hooks.telegraphLine(e, move.length ?? 0, move.width ?? 0, windup, Infinity, move.damageMult, false);
      }
      e.facing = facing;
      break;
    }
    case 'ring':
      drawn = hooks.telegraphRing(e, e.x, e.z, move.ringMax ?? 0, move.ringSpeed ?? 0, move.band ?? 0, windup, move.damageMult);
      break;
    case 'charge':
      // As SPEC-038's rusher: the lane follows until `lock` s before the run
      // (the offset does not scale) and the body lands the hit.
      drawn = hooks.telegraphLine(e, move.length ?? 0, move.width ?? 0, windup, move.lock ?? 0, move.damageMult, true);
      break;
    case 'volley':
    case 'burrow':
      break;
  }
  if (!drawn) {
    hooks.cancelTelegraphs(e);
    e.moveIndex = -1;
    e.moveCd = move.cooldown;
    e.recoverFor = move.recover;
    enterState(e, 'attack');
    return;
  }
  enterState(e, 'cast');
  e.recoverFor = 0;
  hooks.windup(e, windupKindOf(move));
}

/**
 * §4.1 — one step of a cast: rooted, a charge or a volley turning toward its
 * target at `BOSS_TURN_RATE` until `lock` s before the end. Then a volley fires
 * its fan, a charge starts its run, and a slam, lines or a ring land through
 * the telegraphs drawn at the start — which resolve this same step, right
 * after the brains.
 */
function updateCast(e: EnemyEntity, world: CombatWorld, dt: number, hooks: AiHooks): void {
  const move = currentMove(e);
  if (move === null) {
    enterState(e, 'chase');
    return;
  }
  e.vx = 0;
  e.vz = 0;
  const windup = windupFor(move.windup, world, e);
  const target = targetOf(e, world);
  if ((move.kind === 'charge' || move.kind === 'volley') && e.stateTime < windup - (move.lock ?? 0)) {
    const wanted = Math.atan2(target.z - e.z, target.x - e.x);
    const most = BOSS_TURN_RATE * dt;
    e.facing += Math.max(-most, Math.min(most, angleDelta(e.facing, wanted)));
  }
  if (e.stateTime < windup) return;
  switch (move.kind) {
    case 'volley': {
      const count = move.count ?? 1;
      const spread = move.spread ?? 0;
      for (let k = 0; k < count; k++) {
        const angle = count > 1 ? e.facing + spread * (k / (count - 1) - 0.5) : e.facing;
        hooks.fireProjectile(
          e,
          Math.cos(angle),
          Math.sin(angle),
          move.projectileSpeed ?? 1,
          move.projectileRadius ?? 0.3,
          move.projectileRange ?? 1,
          move.damageMult,
        );
      }
      finishMove(e, move, e.x, e.z, hooks);
      return;
    }
    case 'charge':
      enterState(e, 'charge');
      e.chargeLeft = move.length ?? 0;
      e.chargeSpeed = move.speed ?? 0;
      // §4.1: `width / 2 + target radius` — the lane, not the body, lands it.
      e.chargeReach = (move.width ?? 0) / 2 + world.player.radius;
      e.chargeDamageMult = move.damageMult;
      e.chargeStops = false;
      e.chargeHit = false;
      updateCharge(e, world, dt, hooks);
      return;
    default:
      finishMove(e, move, e.castX, e.castZ, hooks);
  }
}

/** §4.1 — landing: `boss:move`, then `recover` s in `attack`, and the move cooldown. */
function finishMove(e: EnemyEntity, move: BossMove, x: number, z: number, hooks: AiHooks): void {
  hooks.bossMove(e, move, x, z);
  e.moveIndex = -1;
  e.moveCd = move.cooldown;
  e.recoverFor = move.recover;
  enterState(e, 'attack');
}

/**
 * §4.1 — the burrow, the one timed move: it digs for `dig × windupMult` s,
 * invulnerable and out of reach (`special`, `burrow_dig`), cueing `burrow`.
 */
function startBurrow(e: EnemyEntity, index: number, world: CombatWorld, hooks: AiHooks): void {
  const move = (e.def.moves as readonly BossMove[])[index] as BossMove;
  e.moveIndex = index;
  e.timedMoveAt = Infinity;
  e.invulnerable = true;
  e.vx = 0;
  e.vz = 0;
  e.chargeLeft = 0;
  enterState(e, 'special');
  e.specialKind = 'burrow_dig';
  e.specialUntil = world.time + windupFor(move.dig ?? 0, world, e);
  hooks.windup(e, 'burrow');
}

/** §4.1: the cast, the charge and the pending telegraphs go — a phase change, a leash reset, a despawn. */
function cancelMove(e: EnemyEntity, hooks: AiHooks): void {
  hooks.cancelTelegraphs(e);
  e.moveIndex = -1;
  e.chargeLeft = 0;
}

function bossPhases(e: EnemyEntity, world: CombatWorld, hooks: AiHooks): void {
  const phases = e.def.phases;
  if (phases === undefined || e.state === 'special') return;
  const next = phases[e.phase];
  if (next === undefined || e.hp / e.maxHp > next.hpFraction) return;
  // AC: each threshold triggers exactly once — `phase` only ever climbs.
  e.phase += 1;
  e.damage = e.def.damage * next.damageMult;
  e.speed = e.def.speed * next.speedMult;
  // SPEC-041 41-c: a threshold crossed mid-cast cancels the move and its telegraphs.
  cancelMove(e, hooks);
  hooks.phaseStarted(e, e.phase);
  if (next.summon !== undefined) hooks.summonRing(e, next.summon.enemy as EnemyId, next.summon.count, 6);
  // SPEC-041 §4.1: the phase that opens the timed move (the wurm's burrow at
  // phase 2) starts it in place of the 1.5 s special.
  const timed = timedMoveIndex(e);
  if (timed >= 0 && (e.def.moves as readonly BossMove[])[timed]?.phaseMin === e.phase) {
    startBurrow(e, timed, world, hooks);
    return;
  }
  e.invulnerable = true;
  enterState(e, 'special');
  e.specialKind = 'phase';
  e.specialUntil = world.time + PHASE_SPECIAL_SECONDS;
}

/**
 * The end of a special. A phase's turnover returns to the chase. The burrow's
 * dig samples the player where it stands and draws the move's circle there
 * (`burrow_telegraph`, still invulnerable and out of reach); when the circle
 * resolves the boss surfaces at its centre, lands the move, and is due again
 * `every` s later (§4.1).
 */
function updateSpecial(e: EnemyEntity, world: CombatWorld, hooks: AiHooks): void {
  if (world.time < e.specialUntil) return;
  const move = currentMove(e);
  if (e.specialKind === 'burrow_dig' && move !== null) {
    const p = world.player;
    e.castX = p.x;
    e.castZ = p.z;
    if (hooks.telegraphCircle(e, p.x, p.z, move.radius ?? 0, move.windup * e.windupScale, move.damageMult)) {
      e.specialKind = 'burrow_telegraph';
      e.specialUntil = world.time + windupFor(move.windup, world, e);
      return;
    }
    // A refused circle surfaces the boss at once, with nothing to land.
  }
  if ((e.specialKind === 'burrow_dig' || e.specialKind === 'burrow_telegraph') && move !== null) {
    e.x = e.castX;
    e.z = e.castZ;
    e.specialKind = 'none';
    e.invulnerable = false;
    finishMove(e, move, e.x, e.z, hooks);
    e.timedMoveAt = world.time + (move.every ?? Infinity);
    return;
  }
  e.specialKind = 'none';
  e.invulnerable = false;
  enterState(e, 'chase');
}

/** 11-e: the arena is the boss's leash — 8 s beyond `radius + 4` resets it. */
function bossArenaLeash(e: EnemyEntity, world: CombatWorld, dt: number, hooks: AiHooks): boolean {
  const arena = world.arena;
  if (arena === null) return false;
  const d = distance(e.x, e.z, arena.x, arena.z);
  if (d > arena.radius + ARENA_LEASH_MARGIN) e.outOfArenaTime += dt;
  else e.outOfArenaTime = 0;
  if (e.outOfArenaTime < ARENA_LEASH_SECONDS) return false;
  e.outOfArenaTime = 0;
  e.hp = e.maxHp;
  e.phase = 1;
  e.damage = e.def.damage;
  e.speed = e.def.speed;
  e.x = e.spawnX;
  e.z = e.spawnZ;
  e.aggro = false;
  e.invulnerable = false;
  e.specialKind = 'none';
  // SPEC-041 §4.1: the move and its telegraphs go, and the clocks start over.
  cancelMove(e, hooks);
  e.moveCd = BOSS_FIRST_MOVE_SECONDS;
  e.timedMoveAt = Infinity;
  e.recoverFor = 0;
  enterState(e, 'wander');
  hooks.toast(ARENA_RESET_TOAST);
  return true;
}

/**
 * §4.1, 41-d: the timed move is due and the boss is free — chasing, or in a
 * blow's short pause rather than a move's recovery.
 */
function timedMoveReady(e: EnemyEntity, world: CombatWorld): boolean {
  if (world.time < e.timedMoveAt || !e.aggro || !world.player.alive) return false;
  return e.state === 'chase' || (e.state === 'attack' && e.recoverFor === 0);
}

// ------------------------------------------------------------------- entry

/**
 * One brain step. Combat calls this for every live enemy, after building the
 * step's spatial hash and before the projectile pass.
 */
export function updateEnemy(e: EnemyEntity, world: CombatWorld, dt: number, rng: Rng, hooks: AiHooks): void {
  if (e.state === 'dead') return;
  const arch = e.def.archetype;
  if (arch === 'fighter' || arch === 'interceptor') return; // flight (SPEC-013)
  e.stateTime += dt;
  e.cooldown -= dt;
  e.hitFlash = Math.max(0, e.hitFlash - dt);

  // §4.5: static enemies idle forever — no aggro, no movement, no attack.
  if (arch === 'static') return;

  if (arch === 'boss') {
    e.moveCd -= dt;
    if (bossArenaLeash(e, world, dt, hooks)) return;
    bossPhases(e, world, hooks);
    // SPEC-041 §4.1: a due timed move pre-empts the weighted pick (41-d: it
    // waits out a cast and its recovery).
    if (e.state !== 'special' && timedMoveReady(e, world)) {
      const timed = timedMoveIndex(e);
      if (timed >= 0) startBurrow(e, timed, world, hooks);
    }
    if (e.state === 'special') {
      updateSpecial(e, world, hooks);
      return;
    }
  }

  // SPEC-038 §4.3 (38-f): a charge is committed from its windup to the end of
  // its run — it keeps its target, and hiding and a death apply after it.
  // SPEC-041 §4.1: so is a boss's cast.
  const committed = e.state === 'chargeWindup' || e.state === 'charge' || e.state === 'cast';
  if (e.aggro && !committed) selectTarget(e, world);

  // SPEC-030 §4.6: an aggroed enemy loses a hidden player it cannot see for
  // 3 s — back to wander, drifting home through wander points, no leash heal.
  // `lostTrack` resets on any step where the player is not hidden or the line
  // is clear (D-20); aggro gain and damage reset it in Combat.
  if (
    world.playerHidden === true &&
    e.aggro &&
    e.target === 'player' &&
    heedsHiding(e) &&
    e.state !== 'leash' &&
    !committed
  ) {
    if (world.obstacles.lineClear(e.x, e.z, world.player.x, world.player.z)) {
      e.lostTrack = 0;
    } else {
      e.lostTrack += dt;
      if (e.lostTrack >= LOSE_TRACK_SECONDS) {
        e.lostTrack = 0;
        e.aggro = false;
        e.stuckTime = 0;
        enterState(e, 'wander');
        e.wanderAt = world.time;
      }
    }
  } else {
    e.lostTrack = 0;
  }

  // De-aggro (§4.5): player dead → wander; target out of leashRadius → leash.
  if (e.aggro && !world.player.alive && !committed) {
    e.aggro = false;
    e.stuckTime = 0;
    enterState(e, 'wander');
    e.wanderAt = world.time;
  }
  if (e.state !== 'leash' && e.def.leashRadius > 0 && (arch !== 'boss' || world.arena === null)) {
    const target = targetOf(e, world);
    const outOfLeash =
      distance(e.spawnX, e.spawnZ, e.x, e.z) > e.def.leashRadius ||
      (e.aggro && distance(e.spawnX, e.spawnZ, target.x, target.z) > e.def.leashRadius);
    if (outOfLeash) {
      enterLeash(e);
      hooks.cancelTelegraphs(e); // SPEC-038 §4.2: a leash takes its lane with it
    }
  }

  switch (e.state) {
    case 'idle':
    case 'wander':
      updateWander(e, world, dt, rng, hooks);
      break;
    case 'chase':
      updateChase(e, world, dt, rng, hooks);
      break;
    case 'cast':
      updateCast(e, world, dt, hooks);
      break;
    case 'windup':
      updateWindup(e, world, dt, hooks);
      break;
    case 'chargeWindup':
      updateChargeWindup(e, world, dt, hooks);
      break;
    case 'charge':
      updateCharge(e, world, dt, hooks);
      break;
    case 'attack':
      updateAttack(e);
      break;
    case 'strafe':
      updateStrafe(e, world, dt, hooks);
      break;
    case 'leash':
      updateLeash(e, world, dt);
      break;
    case 'special':
      break;
  }
}
