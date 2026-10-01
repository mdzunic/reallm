// Pooled enemy state (SPEC-011 §3). The named fields up to `invulnerable` are
// the canonical interface of the spec; the block after them is the per-entity
// scratch the §5 edge cases need (stuck detection 11-d, arena leash 11-e) and
// what SPEC-038 and SPEC-041 add — the charge, boss moves, packs and affixes —
// flat values, so a pooled reset stays a field-by-field overwrite with no
// allocation.
import type { AffixId } from '@/data/affixes';
import type { Enemy as EnemyDef } from '@/data/enemies';

export type BrainState =
  | 'idle'
  | 'wander'
  | 'chase'
  | 'windup'
  | 'attack'
  | 'strafe'
  | 'leash'
  | 'special'
  | 'dead'
  // SPEC-038 §4.3: the rusher's committed charge — the rooted, telegraphed
  // windup, then the run down its locked lane.
  | 'chargeWindup'
  | 'charge'
  // SPEC-041 §4.1: a boss winding up one of its moves, rooted.
  | 'cast';

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
  /** World-clock time to pick the next wander point (every 2–4 s, §4.5). */
  wanderAt: number;
  /** SPEC-030 §4.6: seconds without a line to a hidden player. */
  lostTrack: number;
  /** SPEC-030 §4.6: set by the spawn director for wave groups; waves ignore hiding. */
  fromWave: boolean;
  /**
   * SPEC-034 §4.6, E57: the entity id of the boss whose phase summoned this
   * enemy, or 0. A boss's death dismisses its living summons, so the lines that
   * follow are not interrupted by drones the fight left behind.
   */
  summonedBy: number;

  // ------------------------------------------- SPEC-038 §3: charge and crits
  /** Metres of the current charge still to run. */
  chargeLeft: number;
  /** Metres per second of the current charge. */
  chargeSpeed: number;
  /** The centre distance at which the charge touches its target. */
  chargeReach: number;
  chargeDamageMult: number;
  /** Stops on its first contact (a rusher; SPEC-041's bosses do not). */
  chargeStops: boolean;
  /** The current charge has landed. */
  chargeHit: boolean;
  /** The current attack pause; 0 means `POST_ATTACK_PAUSE`. */
  recoverFor: number;
  /** The last player hit on it was a crit — the scene's damage number reads it. */
  lastHitCrit: boolean;
  /**
   * SPEC-039 §4.1: a boss spawned for the boss stage of a replayed mission —
   * half the XP, and its signature row pays the fallback lithium. Reset to
   * false in `spawnEnemy`; only the arena's own spawn sets it.
   */
  replay: boolean;

  // ------------------------------------------- SPEC-041 §3: moves, packs, affixes
  /** Index into def.moves of the move being cast, −1 for none. */
  moveIndex: number;
  /** Seconds until the next weighted move may start. */
  moveCd: number;
  /** World time the timed move (the burrow) is next due; Infinity when none. */
  timedMoveAt: number;
  /** Where the current move lands — a slam's centre, the burrow's surfacing point. */
  castX: number;
  castZ: number;
  /** SPEC-041 §4.5: shared by a pack's members, 0 for none. */
  packId: number;
  affixA: AffixId | null;
  affixB: AffixId | null;
  /** Multiplies this enemy's windups (swift 0.8). */
  windupScale: number;
  /** Mender pulse clock. */
  menderAt: number;
  /** The last player hit on it was turned by a bulwark — the damage number reads it. */
  lastHitGuarded: boolean;
}

/**
 * SPEC-041 §4.1: under the sand — the burrow's dig and its telegraph. Skipped by
 * auto-fire, projectiles, push-out, blasts and the view until it surfaces.
 */
export function isBuried(e: EnemyEntity): boolean {
  return e.specialKind === 'burrow_dig' || e.specialKind === 'burrow_telegraph';
}

/** SPEC-041 §4.6: how many affixes an elite carries (0, 1 or 2). */
export function affixCount(e: EnemyEntity): number {
  return (e.affixA === null ? 0 : 1) + (e.affixB === null ? 0 : 1);
}

/** SPEC-041 §4.6: whether `e` carries `affix`. */
export function hasAffix(e: EnemyEntity, affix: AffixId): boolean {
  return e.affixA === affix || e.affixB === affix;
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
    wanderAt: 0,
    lostTrack: 0,
    fromWave: false,
    summonedBy: 0,
    chargeLeft: 0,
    chargeSpeed: 0,
    chargeReach: 0,
    chargeDamageMult: 1,
    chargeStops: true,
    chargeHit: false,
    recoverFor: 0,
    lastHitCrit: false,
    replay: false,
    moveIndex: -1,
    moveCd: 0,
    timedMoveAt: Infinity,
    castX: 0,
    castZ: 0,
    packId: 0,
    affixA: null,
    affixB: null,
    windupScale: 1,
    menderAt: 0,
    lastHitGuarded: false,
  };
}
