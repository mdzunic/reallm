// Pooled enemy state (SPEC-011 §3). The named fields up to `invulnerable` are
// the canonical interface of the spec; the block after them is the per-entity
// scratch the §5 edge cases need (stuck detection 11-d, arena leash 11-e, the
// wurm's burrow and the queen's acid timer) — flat numbers, so a pooled reset
// stays a field-by-field overwrite with no allocation.
import type { Enemy as EnemyDef } from '@/data/enemies';

export type BrainState = 'idle' | 'wander' | 'chase' | 'windup' | 'attack' | 'strafe' | 'leash' | 'special' | 'dead';

/** What a boss `special` is currently doing; `none` outside one. */
export type SpecialKind = 'none' | 'phase' | 'burrow_dig' | 'burrow_telegraph';

export interface EnemyEntity {
  id: number;
  def: EnemyDef;
  elite: boolean;
  x: number;
  z: number;
  facing: number;
  vx: number;
  vz: number;
  radius: number;
  hp: number;
  maxHp: number;
  /**
   * Outgoing damage before the elite ×1.5, which `enemyHitDamage` applies at
   * hit time (§4.2); boss phases fold their cumulative `damageMult` in here.
   */
  damage: number;
  speed: number;
  state: BrainState;
  /** Seconds in the current state. */
  stateTime: number;
  /** Seconds until the next attack may start winding up. */
  cooldown: number;
  spawnX: number;
  spawnZ: number;
  target: 'player' | 'follower';
  aggro: boolean;
  /** Seconds of hit flash left, for the view. */
  hitFlash: number;
  /** 1-based boss phase; 1 for everything else. */
  phase: number;
  /** Wander destination — reused as the side-step target while `sideUntil` runs. */
  wanderX: number;
  wanderZ: number;
  /** World-clock end of the current special / leash invulnerability window. */
  specialUntil: number;
  invulnerable: boolean;

  // ------------------------------------------------- edge-case scratch (§5)
  specialKind: SpecialKind;
  /** 11-d: seconds spent under 0.3 m/s while chasing. */
  stuckTime: number;
  /** 11-d: world-clock end of the current side-step. */
  sideUntil: number;
  /** 11-e: seconds a boss has spent beyond `arena.radius + 4`. */
  outOfArenaTime: number;
  /** Hive queen phase 2+: seconds until the next acid volley. */
  acidCooldown: number;
  /** World-clock time to pick the next wander point (every 2–4 s, §4.5). */
  wanderAt: number;
}

export function makeEnemy(): EnemyEntity {
  return {
    id: 0,
    def: undefined as unknown as EnemyDef, // overwritten by every spawn (core/Pool.ts contract)
    elite: false,
    x: 0,
    z: 0,
    facing: 0,
    vx: 0,
    vz: 0,
    radius: 0,
    hp: 0,
    maxHp: 0,
    damage: 0,
    speed: 0,
    state: 'idle',
    stateTime: 0,
    cooldown: 0,
    spawnX: 0,
    spawnZ: 0,
    target: 'player',
    aggro: false,
    hitFlash: 0,
    phase: 1,
    wanderX: 0,
    wanderZ: 0,
    specialUntil: 0,
    invulnerable: false,
    specialKind: 'none',
    stuckTime: 0,
    sideUntil: 0,
    outOfArenaTime: 0,
    acidCooldown: 0,
    wanderAt: 0,
  };
}
