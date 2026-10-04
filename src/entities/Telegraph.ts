// Pooled ground telegraphs (SPEC-038 §4.2): the one primitive every committed
// attack draws — a circle that lands on an area, a line the attacker runs
// down, a ring that travels out from a centre. The pool lives in
// `systems/Combat.ts`, which resolves them against the player and the follower
// at `hitAt`; `views/TelegraphView.ts` draws them. Plain data on the XZ plane,
// so a pooled reset stays a field-by-field overwrite with no allocation.
import type { EnemyId } from '@/data/enemies';

export type TelegraphKind = 'circle' | 'line' | 'ring';

export interface TelegraphEntity {
  kind: TelegraphKind;
  /** Centre (circle, ring) or origin (line), metres on XZ. */
  x: number;
  z: number;
  /** A line's unit direction. */
  dirX: number;
  dirZ: number;
  /** Circle. */
  radius: number;
  /** Line. */
  length: number;
  /** Line, full width. */
  width: number;
  /** Ring: the band's width. */
  band: number;
  /** Ring: metres per second from `hitAt`. */
  ringSpeed: number;
  /** Ring: the last radius. */
  ringMax: number;
  /** Drawn from. */
  startAt: number;
  /** Lands at (a ring starts growing). */
  hitAt: number;
  /**
   * A line follows its owner's position and facing until then; SPEC-050 §4.4:
   * a `followsLoud` circle follows a loud player until then.
   */
  lockAt: number;
  /** SPEC-050 §4.4: the burrow's circle — its centre moves toward a loud player before `lockAt`. */
  followsLoud: boolean;
  /** SPEC-050 §4.4: how fast a `followsLoud` centre moves, m/s (the move's `trackLoud`). */
  trackSpeed: number;
  /** Outgoing damage before armour, difficulty and the elite ×1.5, applied at the hit like a melee blow. */
  damage: number;
  elite: boolean;
  /** The enemy entity id that drew it (0 for none). */
  ownerId: number;
  /** The species named in `player:damaged`. */
  source: EnemyId;
  /** A charge lane: the owner's body lands the hit, so it never resolves by itself. */
  bodyResolved: boolean;
  /** E60: whether the escort follower can be hit. */
  hitsFollower: boolean;
  /** Bit 1: the player has been hit; bit 2: the follower has. A circle or line is freed once resolved. */
  hitMask: number;
}

/** §4.2: the most telegraphs alive at once; a request past it is refused (38-c). */
export const TELEGRAPH_CAPACITY = 32;

/** SPEC-050 §4.4: seconds before `hitAt` a burrow circle stops following a loud player. */
export const LOUD_TRACK_LOCK = 0.4;

/** `hitMask` bits. */
export const HIT_PLAYER = 1;
export const HIT_FOLLOWER = 2;

export function makeTelegraph(): TelegraphEntity {
  return {
    kind: 'circle',
    x: 0,
    z: 0,
    dirX: 1,
    dirZ: 0,
    radius: 0,
    length: 0,
    width: 0,
    band: 0,
    ringSpeed: 0,
    ringMax: 0,
    startAt: 0,
    hitAt: 0,
    lockAt: 0,
    followsLoud: false,
    trackSpeed: 0,
    damage: 0,
    elite: false,
    ownerId: 0,
    source: 'dust_skitter',
    bodyResolved: false,
    hitsFollower: false,
    hitMask: 0,
  };
}

/** Every field back to `makeTelegraph()`'s value — a recycled slot trusts none (core/Pool.ts). */
export function resetTelegraph(t: TelegraphEntity): void {
  t.kind = 'circle';
  t.x = 0;
  t.z = 0;
  t.dirX = 1;
  t.dirZ = 0;
  t.radius = 0;
  t.length = 0;
  t.width = 0;
  t.band = 0;
  t.ringSpeed = 0;
  t.ringMax = 0;
  t.startAt = 0;
  t.hitAt = 0;
  t.lockAt = 0;
  t.followsLoud = false;
  t.trackSpeed = 0;
  t.damage = 0;
  t.elite = false;
  t.ownerId = 0;
  t.source = 'dust_skitter';
  t.bodyResolved = false;
  t.hitsFollower = false;
  t.hitMask = 0;
}

/** 0 at `startAt`, 1 at `hitAt`, clamped. */
export function telegraphProgress(t: TelegraphEntity, time: number): number {
  const span = t.hitAt - t.startAt;
  if (!(span > 0)) return time >= t.hitAt ? 1 : 0;
  return Math.max(0, Math.min(1, (time - t.startAt) / span));
}

/** A ring's band centre radius at `time`: 0 until `hitAt`, then `ringSpeed` m/s. */
export function ringRadius(t: TelegraphEntity, time: number): number {
  return Math.max(0, time - t.hitAt) * t.ringSpeed;
}

/**
 * Whether a circle of radius `r` at `(x, z)` overlaps the shape — for a ring,
 * its band at `time` (nothing before `hitAt`). A line is the rectangle from its
 * origin along `dir` for `length`, `width` across; the test is exact.
 */
export function telegraphCovers(t: TelegraphEntity, x: number, z: number, r: number, time: number): boolean {
  const dx = x - t.x;
  const dz = z - t.z;
  switch (t.kind) {
    case 'circle':
      return dx * dx + dz * dz <= (t.radius + r) * (t.radius + r);
    case 'line': {
      const along = dx * t.dirX + dz * t.dirZ;
      const across = dz * t.dirX - dx * t.dirZ;
      const half = t.width / 2;
      const nearAlong = Math.max(0, Math.min(t.length, along));
      const nearAcross = Math.max(-half, Math.min(half, across));
      const ga = along - nearAlong;
      const gc = across - nearAcross;
      return ga * ga + gc * gc <= r * r;
    }
    case 'ring': {
      if (time < t.hitAt) return false;
      const d = Math.hypot(dx, dz);
      return Math.abs(d - ringRadius(t, time)) <= t.band / 2 + r;
    }
  }
}
