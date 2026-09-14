// Pooled projectile state (SPEC-011 §3, §4.4). All player weapons and every
// ranged enemy fire these; there is no hitscan (§2). `hitIds` is allocated once
// per pooled object and cleared on reuse, so piercing shots never allocate in
// the loop.
import type { EnemyId } from '@/data/enemies';

export type ProjectileOwner = 'player' | 'enemy' | 'drone';

export interface ProjectileEntity {
  x: number;
  z: number;
  vx: number;
  vz: number;
  radius: number;
  /**
   * Player/drone: the rolled amount, applied as-is. Enemy: the shooter's
   * outgoing damage — armor, difficulty and the elite ×1.5 land at hit time
   * through `enemyHitDamage` (§4.2).
   */
  damage: number;
  /** Enemies this shot may still pass through; despawn at −1 (§4.4). */
  pierceLeft: number;
  owner: ProjectileOwner;
  ttl: number;
  /** Enemy ids already hit while piercing; `null` until the first hit. */
  hitIds: Set<number> | null;
  /** The shooter, for the `player:damaged` source of an `'enemy'` shot. */
  enemyId: EnemyId | null;
  /** Whether the enemy shooter was elite, for `enemyHitDamage` at hit time. */
  elite: boolean;
  // SPEC-029 §3 — blasts and lobs (reset on every reuse).
  /** Blast radius on detonation; 0 means a plain shot. */
  blastRadius: number;
  blastFalloff: number;
  /** A lob ignores bodies and obstacles and explodes at its target (§4.6). */
  lob: boolean;
  targetX: number;
  targetZ: number;
  /** Total flight seconds of a lob; `ttl` counts it down (the view's arc). */
  flight: number;
}

export function makeProjectile(): ProjectileEntity {
  return {
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    radius: 0,
    damage: 0,
    pierceLeft: 0,
    owner: 'player',
    ttl: 0,
    hitIds: null,
    enemyId: null,
    elite: false,
    blastRadius: 0,
    blastFalloff: 0,
    lob: false,
    targetX: 0,
    targetZ: 0,
    flight: 0,
  };
}
