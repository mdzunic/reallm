// The player's pooled combat state (SPEC-011 §3). Plain data on the XZ plane;
// Y is visual and lives in the view. The scene (SPEC-012) owns movement — it
// writes `vx/vz` from input and integrates position — while `systems/Combat.ts`
// owns hp, i-frames, facing while firing, knockback and the consumable timers.
// SPEC-038 adds the dash's clock and direction, which `systems/Dash.ts` writes.

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
  // SPEC-038 §3 — the dash. Reset by `makePlayer` and by the surface respawn.
  /** World time the current dash's movement ends; −Infinity when none ran. */
  dashUntil: number;
  /** World time the next dash may start (0 on a fresh or respawned player). */
  dashReadyAt: number;
  /** The current dash's unit direction on XZ. */
  dashX: number;
  dashZ: number;
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
    dashUntil: -Infinity,
    dashReadyAt: 0,
    dashX: 0,
    dashZ: 0,
  };
}
