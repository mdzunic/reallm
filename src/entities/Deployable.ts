// Pooled deployable state (SPEC-029 §3, §4.7): proximity mines and fused
// demolition charges. The pool holds eight; mines arm one second after
// placement and at most six may be armed or arming at once. Deployables stay
// through a player death and respawn, and die with the scene (§4.7).
export interface DeployableEntity {
  kind: 'mine' | 'charge';
  x: number;
  z: number;
  /** Blast radius and damage, copied from the explosive effect. */
  radius: number;
  damage: number;
  /** Mine only: a live, non-static enemy this close sets it off. */
  trigger: number;
  /** World time the mine arms (`mine:armed`); a charge arms immediately. */
  armAt: number;
  /** World time a charge goes off; `Infinity` for a mine. */
  fuseAt: number;
  armed: boolean;
}

export const DEPLOYABLE_CAPACITY = 8;
export const MAX_ARMED_MINES = 6;
export const MINE_ARM_SECONDS = 1;

export function makeDeployable(): DeployableEntity {
  return {
    kind: 'mine',
    x: 0,
    z: 0,
    radius: 0,
    damage: 0,
    trigger: 0,
    armAt: 0,
    fuseAt: Infinity,
    armed: false,
  };
}
