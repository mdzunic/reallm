// The enemy brains (SPEC-011 §4.5): one `updateEnemy` per fixed step, driving
// the archetype state machines — swarm, rusher, ranged, static, boss — plus the
// §5 edge cases: stuck side-steps (11-d), the boss arena leash (11-e), the
// wurm's burrow and the queen's acid volley. Pure code over the entity pools;
// side effects that touch the player, projectiles or events go through
// `AiHooks`, which `systems/Combat.ts` implements — so this module never
// imports it at runtime.
import type { Rng } from '@/core/Rng';
import type { EnemyId } from '@/data/enemies';
import type { EnemyEntity } from '@/entities/Enemy';
import type { CombatWorld } from '@/systems/Combat';

// ------------------------------------------------------- tuning & constants

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
/** §4.5 dune wurm burrow: 4 s invulnerable = dig + 1 s telegraph; shockwave r 4. */
export const BURROW_DIG_SECONDS = 3;
export const BURROW_TELEGRAPH_SECONDS = 1;
export const BURROW_RESURFACE_DISTANCE = 5;
export const BURROW_SHOCKWAVE_RADIUS = 4;
/** §4.5 hive queen phase 2: acid volley — cooldown 2 s, 3-spread. Initial tuning. */
export const ACID_COOLDOWN = 2;
export const ACID_SPREAD_RADIANS = 0.3;
export const ACID_RANGE = 14;
export const ACID_SPEED = 12;
export const ACID_RADIUS = 0.3;
/** Wander: a point within 8 m of spawn every 2–4 s, at a stroll. */
export const WANDER_RADIUS = 8;
export const WANDER_SPEED_MULT = 0.4;
/** Enemy projectile flight allowance past the firing range. Initial tuning. */
export const ENEMY_PROJECTILE_RANGE_MULT = 1.5;

const TAU = Math.PI * 2;

/** Side effects the brain asks of combat (damage, projectiles, summons, UI). */
export interface AiHooks {
  /** The windup completed and the hit check passed against `e.target`. */
  meleeHit(e: EnemyEntity): void;
  fireProjectile(e: EnemyEntity, dirX: number, dirZ: number, speed: number, radius: number, range: number): void;
  summonRing(e: EnemyEntity, enemy: EnemyId, count: number, radius: number): void;
  phaseStarted(e: EnemyEntity, phase: number): void;
  /** The wurm resurfaced: hit the player within `radius` (§4.5). */
  shockwave(e: EnemyEntity, radius: number): void;
  toast(text: string): void;
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
  const beforeX = e.x;
  const beforeZ = e.z;
  const nx = e.x + vx * dt;
  const nz = e.z + vz * dt;
  // Axis slide: blocked on one axis still moves along the other. Enemy vs
  // enemy: no collision (§4.4) — separation is the only body force.
  if (!world.obstacles.hitsCircle(nx, e.z, e.radius)) e.x = nx;
  if (!world.obstacles.hitsCircle(e.x, nz, e.radius)) e.z = nz;
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

function updateWander(e: EnemyEntity, world: CombatWorld, dt: number, rng: Rng): void {
  // §4.5 de-aggro: a dead player ends combat outright — acquiring the live
  // follower here would undo the forced wander and flip states every step.
  if (world.player.alive) {
    selectTarget(e, world);
    const target = targetOf(e, world);
    if (target.alive) {
      const d = distance(e.x, e.z, target.x, target.z);
      if (e.aggro || (e.def.aggroRadius > 0 && d <= e.def.aggroRadius)) {
        e.aggro = true;
        enterState(e, 'chase');
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

function updateChase(e: EnemyEntity, world: CombatWorld, dt: number): void {
  const target = targetOf(e, world);
  const arch = e.def.archetype;
  const d = distance(e.x, e.z, target.x, target.z);

  if (arch === 'ranged') {
    if (e.def.attack.kind === 'ranged' && d <= e.def.attack.range * 0.8) {
      enterState(e, 'strafe');
      return;
    }
  } else if (d <= meleeReach(e, target) && e.cooldown <= 0) {
    enterState(e, 'windup');
    e.facing = Math.atan2(target.z - e.z, target.x - e.x);
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

function updateWindup(e: EnemyEntity, world: CombatWorld, hooks: AiHooks): void {
  const arch = e.def.archetype;
  if (arch === 'ranged') {
    if (e.stateTime < WINDUP_SECONDS.ranged) return;
    // §4.5: fire at the target's *current* position — no leading, by design.
    const target = targetOf(e, world);
    const d = Math.max(1e-6, distance(e.x, e.z, target.x, target.z));
    if (e.def.attack.kind === 'ranged' && target.alive) {
      const attack = e.def.attack;
      hooks.fireProjectile(
        e,
        (target.x - e.x) / d,
        (target.z - e.z) / d,
        attack.projectileSpeed,
        attack.projectileRadius,
        attack.range * ENEMY_PROJECTILE_RANGE_MULT,
      );
      e.cooldown = attack.cooldown;
    }
    enterState(e, 'strafe');
    return;
  }
  const windup = arch === 'boss' ? WINDUP_SECONDS.boss : arch === 'rusher' ? WINDUP_SECONDS.rusher : WINDUP_SECONDS.swarm;
  if (e.stateTime < windup) return;
  // §4.5: the hit check happens now, at range + 0.2 — a dodge steps outside it.
  const target = targetOf(e, world);
  const d = distance(e.x, e.z, target.x, target.z);
  if (target.alive && d <= meleeReach(e, target) + ATTACK_REACH_BONUS) hooks.meleeHit(e);
  if (e.def.attack.kind === 'melee') e.cooldown = e.def.attack.cooldown;
  enterState(e, 'attack');
}

/** The post-hit recover; the rusher's 0.4 s pause lives here (§4.5). */
function updateAttack(e: EnemyEntity): void {
  const arch = e.def.archetype;
  const pause = arch === 'rusher' ? POST_ATTACK_PAUSE.rusher : arch === 'boss' ? POST_ATTACK_PAUSE.boss : POST_ATTACK_PAUSE.swarm;
  if (e.stateTime >= pause) enterState(e, 'chase');
}

function updateStrafe(e: EnemyEntity, world: CombatWorld, dt: number): void {
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

function bossPhases(e: EnemyEntity, world: CombatWorld, hooks: AiHooks): void {
  const phases = e.def.phases;
  if (phases === undefined || e.state === 'special') return;
  const next = phases[e.phase];
  if (next === undefined || e.hp / e.maxHp > next.hpFraction) return;
  // AC: each threshold triggers exactly once — `phase` only ever climbs.
  e.phase += 1;
  e.damage = e.def.damage * next.damageMult;
  e.speed = e.def.speed * next.speedMult;
  hooks.phaseStarted(e, e.phase);
  if (next.summon !== undefined) hooks.summonRing(e, next.summon.enemy as EnemyId, next.summon.count, 6);
  e.invulnerable = true;
  enterState(e, 'special');
  if (e.def.id === 'dune_wurm' && e.phase === 2) {
    // §4.5: the wurm burrows on phase 2 entry — 4 s invulnerable in total.
    e.specialKind = 'burrow_dig';
    e.specialUntil = world.time + BURROW_DIG_SECONDS;
  } else {
    e.specialKind = 'phase';
    e.specialUntil = world.time + PHASE_SPECIAL_SECONDS;
  }
}

function updateSpecial(e: EnemyEntity, world: CombatWorld, rng: Rng, hooks: AiHooks): void {
  if (world.time < e.specialUntil) return;
  if (e.specialKind === 'burrow_dig') {
    // Resurface point: 5 m from the player's current position, then 1 s
    // telegraph. The distance is fixed; the angle re-rolls (a few times, so an
    // open field costs exactly one draw) rather than surfacing inside a rock.
    const p = world.player;
    let angle = rng.angle();
    for (let attempt = 0; attempt < 7; attempt++) {
      const x = p.x + Math.cos(angle) * BURROW_RESURFACE_DISTANCE;
      const z = p.z + Math.sin(angle) * BURROW_RESURFACE_DISTANCE;
      if (!world.obstacles.hitsCircle(x, z, e.radius)) break;
      angle = rng.angle();
    }
    e.wanderX = p.x + Math.cos(angle) * BURROW_RESURFACE_DISTANCE;
    e.wanderZ = p.z + Math.sin(angle) * BURROW_RESURFACE_DISTANCE;
    e.specialKind = 'burrow_telegraph';
    e.specialUntil = world.time + BURROW_TELEGRAPH_SECONDS;
    return;
  }
  if (e.specialKind === 'burrow_telegraph') {
    e.x = e.wanderX;
    e.z = e.wanderZ;
    hooks.shockwave(e, BURROW_SHOCKWAVE_RADIUS);
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
  enterState(e, 'wander');
  hooks.toast(ARENA_RESET_TOAST);
  return true;
}

/** AC: hive queen phase 2 gains the acid volley — cooldown 2 s, 3-spread. */
function queenAcid(e: EnemyEntity, world: CombatWorld, hooks: AiHooks): void {
  if (e.def.id !== 'hive_queen' || e.phase < 2 || !e.aggro) return;
  if (e.state === 'special' || e.acidCooldown > 0) return;
  const target = targetOf(e, world);
  if (!target.alive) return;
  const d = distance(e.x, e.z, target.x, target.z);
  if (d > ACID_RANGE || d < 1e-6) return;
  const base = Math.atan2(target.z - e.z, target.x - e.x);
  for (const spread of [-ACID_SPREAD_RADIANS, 0, ACID_SPREAD_RADIANS]) {
    hooks.fireProjectile(e, Math.cos(base + spread), Math.sin(base + spread), ACID_SPEED, ACID_RADIUS, ACID_RANGE * ENEMY_PROJECTILE_RANGE_MULT);
  }
  e.acidCooldown = ACID_COOLDOWN;
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
  e.acidCooldown -= dt;
  e.hitFlash = Math.max(0, e.hitFlash - dt);

  // §4.5: static enemies idle forever — no aggro, no movement, no attack.
  if (arch === 'static') return;

  if (arch === 'boss') {
    if (bossArenaLeash(e, world, dt, hooks)) return;
    bossPhases(e, world, hooks);
    queenAcid(e, world, hooks);
    if (e.state === 'special') {
      updateSpecial(e, world, rng, hooks);
      return;
    }
  }

  if (e.aggro) selectTarget(e, world);

  // De-aggro (§4.5): player dead → wander; target out of leashRadius → leash.
  if (e.aggro && !world.player.alive) {
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
    if (outOfLeash) enterLeash(e);
  }

  switch (e.state) {
    case 'idle':
    case 'wander':
      updateWander(e, world, dt, rng);
      break;
    case 'chase':
      updateChase(e, world, dt);
      break;
    case 'windup':
      updateWindup(e, world, hooks);
      break;
    case 'attack':
      updateAttack(e);
      break;
    case 'strafe':
      updateStrafe(e, world, dt);
      break;
    case 'leash':
      updateLeash(e, world, dt);
      break;
    case 'special':
      break;
  }
}
