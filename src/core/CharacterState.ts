// The character animation state machine (SPEC-019 §4.1) — pure, so the clip
// choice pins in node without a mixer. The view derives everything from the
// player entity's own fields: an hp drop opens the hit window, a fireCooldown
// rise opens the attack window, and speed picks run over idle. No events —
// views are read-only over entity state (SPEC-019 §2).

export type CharacterAnim = 'idle' | 'run' | 'attack' | 'hit' | 'death';

/** What the view remembers between rendered frames; `characterState` mutates it. */
export interface CharacterPrev {
  alive: boolean;
  hp: number;
  fireCooldown: number;
  attackUntil: number;
  hitUntil: number;
}

/** The slice of `PlayerEntity` the state machine reads. */
export interface CharacterFrame {
  alive: boolean;
  vx: number;
  vz: number;
  hp: number;
  fireCooldown: number;
}

/** §4.1 — the reaction windows and the run threshold (*initial tuning*). */
const HIT_WINDOW = 0.3;
const ATTACK_WINDOW = 0.25;
const RUN_THRESHOLD = 0.3;

export function createCharacterPrev(frame: CharacterFrame): CharacterPrev {
  return { alive: frame.alive, hp: frame.hp, fireCooldown: frame.fireCooldown, attackUntil: 0, hitUntil: 0 };
}

/**
 * §4.1, evaluated once per rendered frame. Priority: death, hit, attack, run,
 * idle. `prev` is resynced after the decision even while dead, so the respawn
 * frame's hp jump opens no window (19-b).
 */
export function characterState(prev: CharacterPrev, frame: CharacterFrame, time: number): CharacterAnim {
  if (!prev.alive && frame.alive) {
    // The respawn edge (19-b): both windows clear, nothing reacts to the heal.
    prev.attackUntil = 0;
    prev.hitUntil = 0;
  }
  if (frame.alive) {
    if (frame.hp < prev.hp) prev.hitUntil = time + HIT_WINDOW;
    if (frame.fireCooldown > prev.fireCooldown) prev.attackUntil = time + ATTACK_WINDOW;
  }

  let anim: CharacterAnim;
  if (!frame.alive) anim = 'death';
  else if (time < prev.hitUntil) anim = 'hit';
  else if (time < prev.attackUntil) anim = 'attack';
  else if (Math.hypot(frame.vx, frame.vz) > RUN_THRESHOLD) anim = 'run';
  else anim = 'idle';

  prev.alive = frame.alive;
  prev.hp = frame.hp;
  prev.fireCooldown = frame.fireCooldown;
  return anim;
}

/**
 * §4.1: the clip names each animation answers to, most specific first. The
 * committed salvager (PLAN R7-1) uses the capitalised single words; the rest
 * cover the common export spellings so a swapped model still animates.
 */
export const CLIP_ALIASES: Record<CharacterAnim, readonly string[]> = {
  idle: ['idle', 'Idle', 'Idle_A'],
  run: ['run', 'Run', 'Running', 'Run_A', 'walk', 'Walk'],
  attack: ['attack', 'Attack', 'Punch', 'Shoot', 'Gun_Shoot', 'Sword_Slash', 'Attack_A'],
  hit: ['hit', 'Hit', 'HitReact', 'Hurt', 'Hit_A'],
  death: ['death', 'Death', 'Die', 'Death_A'],
};

/** The first alias present in `names` (exact, case-sensitive), else `null`. */
export function pickClip(names: readonly string[], anim: CharacterAnim): string | null {
  for (const alias of CLIP_ALIASES[anim]) {
    if (names.includes(alias)) return alias;
  }
  return null;
}
