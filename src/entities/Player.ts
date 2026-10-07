// The player's pooled combat state (SPEC-011 §3). Plain data on the XZ plane;
// Y is visual and lives in the view. The scene (SPEC-012) owns movement — it
// writes `vx/vz` from input and integrates position — while `systems/Combat.ts`
// owns hp, i-frames, facing while firing, knockback and the consumable timers.
// SPEC-038 adds the dash's clock and direction, which `systems/Dash.ts` writes;
// SPEC-050 the stamina pool, the sprint and its noise (`systems/Stamina.ts`);
// SPEC-066 the heal lock, which `Combat.applyConsumable` sets.

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
  // SPEC-050 §3 — stamina and the sprint. Reset by `makePlayer`, the respawn
  // and the recall (`resetStamina`).
  /** 0…100 (`STAMINA_MAX`). */
  stamina: number;
  /** World time of the last spend; −Infinity when none ran. */
  staminaSpentAt: number;
  exhausted: boolean;
  sprinting: boolean;
  /** World time the gun may fire again after a sprint (0 on a fresh or respawned player). */
  drawAt: number;
  /** World time the player stops being loud; −Infinity when quiet. */
  loudUntil: number;
  // SPEC-066 §3 — the heal lock. Reset by `makePlayer`, the respawn and the
  // recall; never saved, so a new scene starts unlocked (66-b).
  /** SPEC-066 §4.1: world time the heal slot unlocks; 0 from makePlayer, the respawn and the recall. */
  healLockUntil: number;
  /** SPEC-066 §4.1: the length of the lock that set healLockUntil — the ring's full sweep; 0 when none ran. */
  healLockSeconds: number;
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
    // `systems/Stamina.ts` `resetStamina`'s values: `STAMINA_MAX`, quiet, holstered by nothing.
    stamina: 100,
    staminaSpentAt: -Infinity,
    exhausted: false,
    sprinting: false,
    drawAt: 0,
    loudUntil: -Infinity,
    healLockUntil: 0,
    healLockSeconds: 0,
  };
}
