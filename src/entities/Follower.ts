// The escort follower's combat state (SPEC-011 §3, §4.9). It trails the player
// at `def.followDistance`, can be targeted by enemies, and never attacks; when
// it dies SPEC-012 resets the mission stage.
import type { Follower as FollowerDef } from '@/data/followers';

export interface FollowerEntity {
  def: FollowerDef;
  x: number;
  z: number;
  facing: number;
  hp: number;
  alive: boolean;
  radius: number;
}

export function makeFollower(def: FollowerDef, x: number, z: number): FollowerEntity {
  return { def, x, z, facing: 0, hp: def.hp, alive: true, radius: def.radius };
}
