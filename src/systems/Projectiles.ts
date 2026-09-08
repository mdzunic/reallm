// The pooled projectile step (SPEC-011 §4.4). Every shot in the game — player,
// drone, enemy — integrates here with *swept* circle tests: the collision
// segment runs from the pre-step to the post-step position, so a 40 m/s bolt
// cannot pass through a 0.4 m enemy at 60 Hz (11-c), and a shot spawned inside
// a body hits on its first step (11-b).
//
// Ordering along the segment matters: enemy hits are sorted by their entry
// parameter t, an obstacle hit truncates the segment at its own t (11-j), and
// piercing consumes hits in flight order. `hitIds` remembers pierced bodies so
// no enemy is ever hit twice by the same shot.
import type { SpatialHash } from '@/core/SpatialHash';
import type { EnemyEntity } from '@/entities/Enemy';
import type { ProjectileEntity } from '@/entities/Projectile';
import type { CombatWorld } from '@/systems/Combat';

export interface ProjectileHooks {
  hitEnemy(p: ProjectileEntity, e: EnemyEntity): void;
  /** §4.4: i-frames do not block the projectile — it is consumed either way. */
  hitPlayer(p: ProjectileEntity): void;
  hitFollower(p: ProjectileEntity): void;
}

/**
 * The smallest t ∈ [0, 1] where the segment `(x0,z0) + t·(dx,dz)` enters the
 * circle at (cx, cz) with radius r, or `null`. A start inside the circle is
 * t = 0 (11-b). Exported for the swept tests of §6.
 */
export function sweptCircleT(
  x0: number,
  z0: number,
  dx: number,
  dz: number,
  cx: number,
  cz: number,
  r: number,
): number | null {
  const fx = x0 - cx;
  const fz = z0 - cz;
  if (fx * fx + fz * fz <= r * r) return 0;
  const a = dx * dx + dz * dz;
  if (a === 0) return null;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

// Scratch for the per-projectile hit list — module level, so the 60 Hz step
// never allocates (SPEC-001 §7).
const candidateIds: number[] = [];
const hitTs: number[] = [];
const hitIndices: number[] = [];

/** Broad-phase slack for movement since the hash snapshot (enemies moved this step). */
const QUERY_MARGIN = 1;

export function updateProjectiles(world: CombatWorld, hash: SpatialHash, dt: number, hooks: ProjectileHooks): void {
  const pool = world.projectiles;
  for (let i = pool.size - 1; i >= 0; i--) {
    const p = pool.at(i);
    const x0 = p.x;
    const z0 = p.z;
    const dx = p.vx * dt;
    const dz = p.vz * dt;
    p.x += dx;
    p.z += dz;
    p.ttl -= dt;
    let despawn = p.ttl <= 0;

    // 11-j: an obstacle truncates the flight; hits beyond it never land.
    const tObstacle = world.obstacles.lineHit(x0, z0, p.x, p.z);
    const tEnd = tObstacle ?? 1;

    if (p.owner === 'enemy') {
      if (enemyShotStep(world, p, x0, z0, dx, dz, tEnd, hooks)) despawn = true;
    } else if (playerShotStep(world, p, hash, x0, z0, dx, dz, tEnd, hooks)) {
      despawn = true;
    }

    if (tObstacle !== null) {
      p.x = x0 + dx * tObstacle;
      p.z = z0 + dz * tObstacle;
      despawn = true;
    }
    if (despawn) pool.free(i);
  }
}

/** Player/drone shot vs enemies, in flight order, honouring pierce (§4.4). */
function playerShotStep(
  world: CombatWorld,
  p: ProjectileEntity,
  hash: SpatialHash,
  x0: number,
  z0: number,
  dx: number,
  dz: number,
  tEnd: number,
  hooks: ProjectileHooks,
): boolean {
  const half = Math.hypot(dx, dz) / 2;
  hash.query(x0 + dx / 2, z0 + dz / 2, half + p.radius + QUERY_MARGIN, candidateIds);
  hitTs.length = 0;
  hitIndices.length = 0;
  for (let c = 0; c < candidateIds.length; c++) {
    const index = candidateIds[c] as number;
    const e = world.enemies.at(index);
    if (e.state === 'dead' || e.invulnerable) continue;
    if (p.hitIds !== null && p.hitIds.has(e.id)) continue;
    const t = sweptCircleT(x0, z0, dx, dz, e.x, e.z, e.radius + p.radius);
    if (t === null || t > tEnd) continue;
    // Insertion by t, so pierce consumes bodies in the order the shot meets them.
    let at = hitTs.length;
    while (at > 0 && (hitTs[at - 1] as number) > t) at--;
    hitTs.splice(at, 0, t);
    hitIndices.splice(at, 0, index);
  }
  for (let h = 0; h < hitIndices.length; h++) {
    const e = world.enemies.at(hitIndices[h] as number);
    if (e.state === 'dead') continue; // died to an earlier hit this step
    if (p.hitIds === null) p.hitIds = new Set();
    p.hitIds.add(e.id);
    hooks.hitEnemy(p, e);
    p.pierceLeft -= 1;
    if (p.pierceLeft < 0) {
      const t = hitTs[h] as number;
      p.x = x0 + dx * t;
      p.z = z0 + dz * t;
      return true;
    }
  }
  return false;
}

/** Enemy shot vs the player and the follower — whichever the flight meets first. */
function enemyShotStep(
  world: CombatWorld,
  p: ProjectileEntity,
  x0: number,
  z0: number,
  dx: number,
  dz: number,
  tEnd: number,
  hooks: ProjectileHooks,
): boolean {
  const player = world.player;
  const tPlayer = player.alive ? sweptCircleT(x0, z0, dx, dz, player.x, player.z, player.radius + p.radius) : null;
  const f = world.follower;
  const tFollower = f !== null && f.alive ? sweptCircleT(x0, z0, dx, dz, f.x, f.z, f.radius + p.radius) : null;
  const hitPlayerFirst = tPlayer !== null && tPlayer <= tEnd && (tFollower === null || tPlayer <= tFollower);
  if (hitPlayerFirst) {
    hooks.hitPlayer(p);
    return true;
  }
  if (tFollower !== null && tFollower <= tEnd) {
    hooks.hitFollower(p);
    return true;
  }
  return false;
}
