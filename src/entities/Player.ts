// The player's pooled combat state (SPEC-011 §3). Plain data on the XZ plane;
// Y is visual and lives in the view. The scene (SPEC-012) owns movement — it
// writes `vx/vz` from input and integrates position — while `systems/Combat.ts`
// owns hp, i-frames, facing while firing, knockback and the consumable timers.

export interface PlayerEntity {
  x: number;
  z: number;
  /** Radians on the XZ plane; the facing direction is (cos, sin). */
  facing: number;
  vx: number;
  vz: number;
  radius: 0.5;
  hp: number;
  /** World-clock time until which direct hits are ignored (§4.2). */
  invulnUntil: number;
  alive: boolean;
  fireCooldown: number;
  healOverTime: { remaining: number; perSecond: number } | null;
  /** Active damage_boost consumables; the *max* multiplier applies (edge 11-i). */
  boosts: { damageMult: number; until: number }[];
  hazardImmuneUntil: number;
}

export function makePlayer(x: number, z: number, hp: number): PlayerEntity {
  return {
    x,
    z,
    facing: 0,
    vx: 0,
    vz: 0,
    radius: 0.5,
    hp,
    invulnUntil: 0,
    alive: true,
    fireCooldown: 0,
    healOverTime: null,
    boosts: [],
    hazardImmuneUntil: 0,
  };
}
