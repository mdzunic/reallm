// The rail flight model (SPEC-013 §3–§4.8): constant forward motion, lateral
// steering on a bounded XY plane, hazards approaching along depth, shields and
// hull, ship weapons with aim assist, throttle-scaled waves, ion storms, the
// arrival rule with its 90 s holding cap, and recall on death. SPEC-066 §4.9
// adds the first trip's asteroid lane and the oil a big rock drops when shot.
// SPEC-069 (PLAN R29) opens the plane: the ship steers freely off the course
// line out to a nav limit, the fight spawns around it, the jump's oil fills a
// tank that straying drains (an empty tank is a tow home), the landing wants
// the ship on approach, and salvage signals fly in off the line.
//
// Pure per SPEC-001 §4: no `three`, no DOM, no `Math.random` — every draw goes
// through the `Rng` handed in (one per visit, SPEC-008), so a trip is
// reproducible from its seed. `scenes/Flight.ts` is the composition root that
// feeds `update()` from input and reads the state back into views and HUD.
//
// Axes: the ship steers on `{x, y}` (meters, y up); `depth` is meters ahead of
// the ship along the rail, positive away — hazards spawn deep and close in
// with a negative `vDepth`, player shots run positive. The trip itself is
// time, not distance: `duration = travelSeconds / engineSpeedMult / throttle`
// (§4.1), and progress integrates the *live* throttle so a mid-trip change
// bends the arrival time exactly as far as it bends the formula.
//
// Hot-path rules (SPEC-001 §7): pooled hazards/shots/bursts with swap-remove
// (all removal loops run backwards), no allocation per frame outside the rare
// event payloads every other system also allocates.
import type { EmitArgs, GameEvents } from '@/core/Events';
import { Pool } from '@/core/Pool';
import type { QualitySettings } from '@/core/Renderer';
import type { Rng } from '@/core/Rng';
import type { Save } from '@/core/Save';
import {
  COMPANIONS,
  DIFFICULTY_RULES,
  ENEMIES,
  LOOT_TABLES,
  MISSIONS,
  TUNING,
  UPGRADES,
  WAVES,
  type CompanionEffect,
  type DamageSource,
  type Difficulty,
  type EnemyDef,
  type EnemyId,
  type MissionId,
  type PlanetDef,
  type PlanetId,
} from '@/data/index';
import { containment } from '@/systems/Containment';
import type { Economy } from '@/systems/Economy';
import { FIRE_CARRY } from '@/systems/Loadout';
import { FLIGHT_MISSION_CONTEXT, type Missions } from '@/systems/Missions';
import type { Progression } from '@/systems/Progression';

/** The emit slice of the bus (SPEC-004 D-7); `EventBus<GameEvents>` satisfies it. */
export interface FlightEvents {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
}

// ------------------------------------------------------------------ interfaces

export interface ShipState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Visual bank in degrees: `−vx / lateralSpeed × 35` (§4.2). */
  bank: number;
  shield: number;
  hull: number;
  maxShield: number;
  maxHull: number;
  /** Sim time the regen delay ends; regen itself is ARIA's (§4.6). */
  shieldRegenAt: number;
  /** The chosen notch; the applied value lerps behind it (§4.1). */
  throttle: 0.8 | 1 | 1.2;
  fireCooldown: number;
  alive: boolean;
  /** SPEC-069 §4.2: 0…1 of the tank — full at launch, empty is a tow. */
  fuel: number;
  /** SPEC-070 §4.1: missiles in the rack, 0…`MISSILE.rack`. */
  missiles: number;
}

export interface Hazard {
  kind: 'asteroid' | 'fighter' | 'interceptor' | 'enemy_shot';
  /** SPEC-070 §4.3: a serial per spawn, so a missile never follows a reused pool slot. */
  id: number;
  x: number;
  y: number;
  depth: number;
  vx: number;
  vy: number;
  vDepth: number;
  radius: number;
  hp: number;
  def?: EnemyDef;
  elite?: false;
  /** Fighters: seconds left before they break off (§4.4). */
  ttl?: number;
  fireCooldown?: number;
  /** Fighters: figure-8 phase. Interceptors: 0 until the one re-aim at depth 60. */
  pattern?: number;
  /** Fighters: the depth they hold, drawn in [50, 70] (§4.4). */
  holdDepth?: number;
  /** SPEC-041 §4.9: seconds of white hit flash left after a hit that did not kill. */
  hitFlash?: number;
  /** SPEC-041 §4.8, fighters: rounds of the current burst still to fire. */
  burstLeft?: number;
  /** …and the sim time the next of them is due. */
  burstAt?: number;
  /** Enemy shots: what the round deals on reaching the ship (§4.8). */
  shotDamage?: number;
}

export interface Shot {
  x: number;
  y: number;
  depth: number;
  vDepth: number;
  damage: number;
  /** Lateral drift toward the reticle's depth-80 projection (§4.7). */
  vx: number;
  vy: number;
}

/** One explosion burst for the view to drain; the pool is cleared by the scene. */
export interface Burst {
  x: number;
  y: number;
  depth: number;
  size: number;
}

/** SPEC-069 §4.4: what a salvage signal or a drop holds. */
export type PickupKind = 'fuel' | 'oil' | 'missile';
/** A planned salvage signal (SPEC-069) or a downed ship's drop (SPEC-070). */
export type PickupSource = 'signal' | 'drop';

/** SPEC-069 §4.4: a canister closing along depth, taken by flying into it. */
export interface Pickup {
  kind: PickupKind;
  source: PickupSource;
  x: number;
  y: number;
  depth: number;
  vDepth: number;
}

/** SPEC-069 §4.2: why a trip ended at the station — the hull, or an empty tank. */
export type RecallCause = 'hull' | 'fuel';

export interface FlightConfig {
  planet: PlanetDef;
  ship: Save['ship'];
  companions: Save['companions'];
  quality: QualitySettings;
  /** Casual multiplies incoming damage by 0.7 (§4.6, 13-h); SPEC-038 §4.6 re-reads it on resume. */
  difficulty: Difficulty;
  /**
   * SPEC-058 §4.4: the save's `meta.iteration` — its containment's
   * `damageMult` scales incoming damage on top of the difficulty's. 1 when
   * absent. Flight enemies keep their HP at every iteration (58-k).
   */
  iteration?: number;
  /**
   * SPEC-039 §4.3: the pilot's `companionMult`, which scales ARIA's shield
   * regeneration — the flight scene passes `computePlayerStats(save)`'s. 1
   * when absent.
   */
  companionMult?: number;
  /**
   * SPEC-066 §4.9: the save has never landed on the destination (`visits ===
   * 0`, the test `firstLanding` uses). With the planet's `firstTripField`, the
   * trip carries its scripted asteroid lane. Absent reads as false.
   */
  firstTrip?: boolean;
}

export interface FlightInput {
  steerX: number;
  steerY: number;
  fire: boolean;
  /** Raw reticle position, in plane meters at the convergence depth (§4.7). */
  aimX: number;
  aimY: number;
  /** Edges (just-pressed), not levels: one notch per press (§4.1). */
  throttleUp: boolean;
  throttleDown: boolean;
  /** SPEC-005 §4.3: fire while a target sits under the cone (§4.7). */
  autoFire?: boolean;
  /** `settings.flightMouseSteer`: steer = `mouseSteerAxis(noseOffset)` (SPEC-069 §4.1). */
  mouseSteer?: boolean;
  /**
   * SPEC-069 §4.1: the pointer's offset from the ship's nose, in plane metres
   * at the convergence depth, read through the lens alone — never through the
   * cockpit's chase, pitch or roll, which follow the ship's own motion. Mouse
   * steer measures from here, not from the (possibly snapped) reticle. 0 when
   * absent.
   */
  noseOffsetX?: number;
  noseOffsetY?: number;
  /** SPEC-070 §4.5: an edge — one missile per press, and only with a lock. */
  missile?: boolean;
}

export type FlightPhase = 'launch' | 'cruise' | 'holding' | 'arrived' | 'recalled';

// ------------------------------------------------------------------- constants

/**
 * SPEC-069 §4.1: the combat window around the ship — hazards spawn in it and
 * fighters stay in it. It bounded the ship itself before PLAN R29.
 */
export const PLANE = { halfW: 12, halfH: 7 } as const;
export const RAIL = { baseSpeed: 60, lateralSpeed: 22, lateralAccel: 36, spawnDepth: 220, hitDepth: 2.5, laserSpeed: 120 } as const;

// ------------------------------------------------------------ SPEC-069

/** §4.1: a released axis coasts at e^(−COAST_DAMPING × dt) (*initial tuning*). */
export const COAST_DAMPING = 2.5;
/** §4.1: how far from the course line the ship may go, in metres. */
export const NAV_LIMIT = 220;
/**
 * The course line's bands, in metres from it: no extra burn inside the
 * corridor (§4.2), the landing only on approach (§4.3), and the course marker
 * drawn this far ahead on the line (§4.5).
 */
export const COURSE = { corridor: 16, approach: 30, markerDepth: 80 } as const;
/**
 * §4.2 (*initial tuning* but `reserve`, which the arrival test pins): the line
 * leaves `reserve` at arrival; past the corridor the tank burns `offlineBurn`
 * a second at `offlineRef` metres beyond it, growing with the square; ARIA
 * warns at `low`; story never falls below `storyFloor`; a fuel cell adds `cell`.
 */
export const FUEL = { reserve: 0.35, offlineBurn: 0.006, offlineRef: 50, low: 0.25, storyFloor: 0.05, cell: 0.2 } as const;
/**
 * §4.4 (*initial tuning*): `min`…`max` signals a trip, one per equal slot of
 * `from`…`to` of the trip, `offset` metres off the line on an ellipse
 * flattened by `vertical`, spawned `lead` trip seconds ahead; an oil pod holds
 * `oil`.
 */
export const SIGNALS = {
  min: 3,
  max: 5,
  from: 0.12,
  to: 0.88,
  offset: [40, 110],
  vertical: 0.6,
  lead: 12,
  oil: 4,
  weights: { fuel: 0.4, oil: 0.35, missile: 0.25 },
} as const;
/** §4.4: a pickup crossing within `radius` is taken; the tractor draws it in. */
export const PICKUP = { radius: 3, tractorRadius: 8, tractorDepth: 40, tractorSpeed: 16 } as const;
/** §4.5: how long the tow card holds the screen before the station. */
export const TOW_SECONDS = 2.5;

// ------------------------------------------------------------ SPEC-070

/**
 * The homing missiles (*initial tuning* but the rack): the rack holds `rack`
 * and launches with `loaded` (§4.1); the lock takes the enemy ship nearest the
 * reticle inside `lockConeDeg` between `lockMinDepth` and `lockMaxDepth`
 * (§4.2); a missile flies at `speed`, turns at `turnRate` rad/s, burns out
 * after `life` s or past `maxDepth`, hits within `hitRadius` of its target's
 * circle for `damage`, `splash` to others within `splashRadius`, and
 * retargets once inside `retargetConeDeg` (§4.3); a downed ship drops one
 * with `dropChance` (§4.4).
 */
export const MISSILE = {
  rack: 2,
  loaded: 1,
  speed: 75,
  turnRate: 4,
  life: 4,
  damage: 80,
  splash: 40,
  splashRadius: 4,
  hitRadius: 0.6,
  lockConeDeg: 20,
  lockMinDepth: 8,
  lockMaxDepth: 200,
  retargetConeDeg: 40,
  maxDepth: 260,
  dropChance: 0.15,
} as const;

/** SPEC-070 §3: a missile in flight; `target` is a hazard `id`, −1 for none. */
export interface Missile {
  x: number;
  y: number;
  depth: number;
  vx: number;
  vy: number;
  vDepth: number;
  target: number;
  retargeted: boolean;
  age: number;
}

/** The launch phase: cockpit shake, no hazards, HUD boot (§4.1). */
export const LAUNCH_SECONDS = 3;
/** SPEC-032 §4.5: how long the autopilot card covers a skipped run. */
export const AUTOPILOT_SECONDS = 1.2;
/** How long the recall explosion holds the screen before the station (§4.1). */
export const EXPLOSION_SECONDS = 1.5;
/** The skippable landing cutscene (§4.1). */
export const LANDING_SECONDS = 4;
/** The ship's own collision radius, added to every hazard's (§4.3). */
export const SHIP_RADIUS = 1.2;
/** Shots and the reticle converge here (§4.7). */
export const CONVERGE_DEPTH = 80;
/** The three throttle notches; changes lerp at one notch per second (§4.1). */
export const THROTTLES = [0.8, 1, 1.2] as const;
const THROTTLE_LERP_PER_S = 0.2;
/**
 * SPEC-069 §4.1 (*initial tuning*): mouse steer ignores a pointer this close
 * to the ship's nose, in plane metres at the convergence depth (about 2.9°;
 * some 30 px from the centre of a 900 px tall window).
 */
export const MOUSE_STEER_DEAD_ZONE = 4;
/**
 * SPEC-069 §4.1 (*initial tuning*): the metres past the dead zone at which
 * mouse steer reaches full deflection (about 17° off the nose in all; some
 * 190 px on a 900 px tall window). The mouse aims the guns too, so a short
 * aim off to the side must not throw the ship at full speed.
 */
export const MOUSE_STEER_RAMP = 20;

/**
 * Mouse steer on one axis, `clamp(past / MOUSE_STEER_RAMP)`, measured from
 * the edge of the dead zone — 0 inside it, so the axis coasts to rest.
 */
export function mouseSteerAxis(offset: number): number {
  const past = Math.abs(offset) - MOUSE_STEER_DEAD_ZONE;
  if (past <= 0) return 0;
  return clamp((Math.sign(offset) * past) / MOUSE_STEER_RAMP, -1, 1);
}

/** The asteroid threat box around the ship: 70 % of spawns land inside (§4.3). */
export const THREAT_BOX = 6;
const THREAT_BOX_CHANCE = 0.7;
/** ARIA L2+ aim assist: cone half-angle and reticle chase rate (§4.7). */
export const ASSIST_CONE_DEG = 6;
const ASSIST_LERP_PER_S = 20;
// -------------------------------------------------------- SPEC-035 §4.11

/** §4.11: the engine hum's volume floor, and the throttle span it rides. */
export const ENGINE_VOLUME_BASE = 0.6;
export const ENGINE_VOLUME_SPAN = 0.4;
const ENGINE_THROTTLE_MIN = 0.8;
const ENGINE_THROTTLE_SPAN = 0.4;

/**
 * SPEC-035 §4.11 — `0.6 + 0.4 × (throttle − 0.8) / 0.4`: the slowest notch hums
 * at 0.6, the fastest at 1.0. Clamped, so a throttle outside the three notches
 * cannot push the voice past full or below the floor.
 */
export function engineVolume(throttle: number): number {
  const t = (throttle - ENGINE_THROTTLE_MIN) / ENGINE_THROTTLE_SPAN;
  return ENGINE_VOLUME_BASE + ENGINE_VOLUME_SPAN * clamp(t, 0, 1);
}

/** Touch auto-fire also covers a near-miss asteroid inside this XY range (§4.7). */
export const AUTO_FIRE_ASTEROID_M = 3;
const GUN_OFFSET_X = 0.9;
const GUN_OFFSET_Y = -0.4;
/** Fighters: entry, hold band, break-off and approach rate (§4.4). */
const FIGHTER_ENTER_DEPTH = 90;
const FIGHTER_HOLD_MIN = 50;
const FIGHTER_HOLD_MAX = 70;
export const FIGHTER_LEAVE_SECONDS = 25;
const FIGHTER_APPROACH = 25;
/** Interceptors: entry, dive speed, and the single re-aim depth (§4.4). */
const INTERCEPTOR_ENTER_DEPTH = 160;
const INTERCEPTOR_DIVE = 55;
const REAIM_DEPTH = 60;
/**
 * A ram costs a flat 15 hull (the spec's acceptance line). §4.4's
 * `def.damage` formula cannot hold here: SPEC-009's chapter scaling pins
 * `hive_interceptor.damage` at 34 (content test), not the 12 §4.4 annotates.
 */
export const INTERCEPTOR_RAM_DAMAGE = 15;
const ENEMY_SHOT_VDEPTH = -45;
export const ENEMY_SHOT_RADIUS = 0.4;
/**
 * SPEC-041 §4.8: a fighter's cooldown opens a three-round burst, 0.12 s apart.
 * Round `k` aims at the ship plus `leads[k]` × its lateral velocity × the
 * round's time to impact — a bracket that hits a steady drift and a ship that
 * holds still, and misses a change of direction — and deals
 * `round(damage × damageMult)` (8 for `scav_fighter`).
 */
export const FIGHTER_BURST = { rounds: 3, interval: 0.12, leads: [1, 0.5, 0], damageMult: 0.45 } as const;
/** SPEC-041 §4.9: how long a hazard a shot hit without killing it flashes white. */
export const HAZARD_FLASH_SECONDS = 0.1;
/** Ion storms: window and gap bounds, and the hull tick while shields are down (§4.5). */
const STORM_LENGTH: readonly [number, number] = [15, 25];
const STORM_GAP: readonly [number, number] = [40, 70];
const STORM_TICK_SECONDS = 5;

// ------------------------------------------------------- SPEC-066 §4.9

/** The first trip's field: rocks a second, × the live throttle (*initial tuning*). */
export const FIELD_ROCKS_PER_SECOND = 2;
/** Half the lane's width: a field rock's centre keeps this plus its own radius from the lane's centre (*initial tuning*, metres). */
export const FIELD_LANE_HALF_WIDTH = 4.5;
/** How far the lane's centre swings either side of the middle (*initial tuning*, metres). */
export const FIELD_LANE_SWING = 4;
/** A field rock's radius, drawn uniformly in this range (*initial tuning*, metres). */
export const FIELD_ROCK_RADIUS = [2, 4] as const;
/** An asteroid at least this big drops oil when the ship's guns destroy it. */
export const ROCK_SALVAGE_RADIUS = 3;
/** …this much, as a pickup… */
export const ROCK_SALVAGE_OIL = 2;
/** …until the oil the rocks put in reaches this, each trip (E125). */
export const ROCK_SALVAGE_PER_TRIP = 20;

/**
 * SPEC-066 §4.9: the lane's centre at trip second `tripSecond` —
 * `FIELD_LANE_SWING × sin(2π (s − fromSecond) / (toSecond − fromSecond))`, one
 * full swing across the field's window.
 */
export function fieldLaneX(field: { fromSecond: number; toSecond: number }, tripSecond: number): number {
  return FIELD_LANE_SWING * Math.sin((2 * Math.PI * (tripSecond - field.fromSecond)) / (field.toSecond - field.fromSecond));
}

const DEG_TO_RAD = Math.PI / 180;
const ASSIST_CONE_COS = Math.cos(ASSIST_CONE_DEG * DEG_TO_RAD);
const LOCK_CONE_COS = Math.cos(MISSILE.lockConeDeg * DEG_TO_RAD);
const RETARGET_CONE_COS = Math.cos(MISSILE.retargetConeDeg * DEG_TO_RAD);

/** One scheduled wave group; `frac` is its place in the trip (§4.4). */
interface WaveGroup {
  enemy: EnemyId;
  count: number;
  frac: number;
  spawned: boolean;
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

// ------------------------------------------------- SPEC-041 §4.8: burst aim

/** Seconds an enemy round fired from `depth` takes to reach the ship's plane. */
export function enemyShotEta(depth: number): number {
  return (depth - RAIL.hitDepth) / -ENEMY_SHOT_VDEPTH;
}

/**
 * Where round `k` of a burst fired from `depth` aims — the ship's position
 * plus `FIGHTER_BURST.leads[k]` × its lateral velocity × the round's time to
 * impact — written into `out`. Fighters fire through it; the burst-geometry
 * test measures it.
 */
export function burstAim(
  k: number,
  depth: number,
  ship: Readonly<Pick<ShipState, 'x' | 'y' | 'vx' | 'vy'>>,
  out: { x: number; y: number },
): void {
  const lead = (FIGHTER_BURST.leads[k] ?? 0) * enemyShotEta(depth);
  out.x = ship.x + lead * ship.vx;
  out.y = ship.y + lead * ship.vy;
}

// ------------------------------------------------------ SPEC-032 §4.3: skips

export type SkipRefusal = 'never_flown' | 'flight_mission';
export interface SkipOptions {
  /** Service mode ignores both refusals (SPEC-032 §4.7). */
  readonly service?: boolean;
}
export type SkipResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SkipRefusal; readonly mission?: MissionId };

/**
 * The active mission that runs in the flight scene on the way to `planet`, if
 * any — `c4_s2` to Ferrum, `c5_m1` to the Hive (SPEC-009 §6).
 */
export function activeFlightMission(save: Save, planet: PlanetId): MissionId | null {
  for (const entry of save.progress.missionsActive) {
    const def = MISSIONS[entry.id] as (typeof MISSIONS)[MissionId] | undefined;
    if (def !== undefined && def.planet === planet && def.scene === 'flight') return entry.id;
  }
  return null;
}

/**
 * PLAN R31 (SPEC-074 §4.3): the star map's departure sheet opens unless it
 * has nothing to offer — a route never flown, where `Skip the run` can only
 * say "fly this run once" and the sheet's Depart was the one thing to press.
 * There Depart pays and leaves at once. Every route flown before keeps the
 * sheet, with its skip or the skip's refusal; a service-mode waiver keeps it.
 */
export function departSheetDue(skip: SkipResult, waived: boolean): boolean {
  return waived || skip.ok || skip.reason !== 'never_flown';
}

/**
 * SPEC-032 §4.3: may the run to `planet` be skipped? Only a route the save has
 * landed on (`visits ≥ 1`), and never one an active flight-scene mission for
 * that planet *is* — `c4_s2` and `c5_m1` would otherwise complete by not
 * being played (PLAN R10-2). Service mode waives both.
 */
export function runSkip(save: Save, planet: PlanetId, options?: SkipOptions): SkipResult {
  if (options?.service === true) return { ok: true };
  if ((save.progress.visits[planet] ?? 0) < 1) return { ok: false, reason: 'never_flown' };
  const mission = activeFlightMission(save, planet);
  if (mission !== null) return { ok: false, reason: 'flight_mission', mission };
  return { ok: true };
}

export class Flight {
  readonly ship: ShipState;
  readonly hazards = new Pool<Hazard>(() => ({ kind: 'asteroid', id: 0, x: 0, y: 0, depth: 0, vx: 0, vy: 0, vDepth: 0, radius: 1, hp: 1 }));
  readonly shots = new Pool<Shot>(() => ({ x: 0, y: 0, depth: 0, vDepth: 0, damage: 0, vx: 0, vy: 0 }));
  /** Explosion bursts since the view last drained; the scene calls `bursts.clear()`. */
  readonly bursts = new Pool<Burst>(() => ({ x: 0, y: 0, depth: 0, size: 1 }));
  /** SPEC-069 §4.4: salvage canisters and drops in flight. */
  readonly pickups = new Pool<Pickup>(() => ({ kind: 'fuel', source: 'signal', x: 0, y: 0, depth: 0, vDepth: 0 }));
  /** SPEC-070 §4.3: missiles in flight. */
  readonly missiles = new Pool<Missile>(() => ({ x: 0, y: 0, depth: 0, vx: 0, vy: 0, vDepth: 0, target: -1, retargeted: false, age: 0 }));
  /**
   * SPEC-070 §4.2: the enemy ship nearest the reticle inside the lock cone —
   * its `id` and position — or `active: false`. The HUD's bracket sits on it.
   */
  readonly lock = { active: false, id: -1, x: 0, y: 0, depth: 0 };
  /** Where the shots actually go: the raw aim, or the assist's captured target (§4.7). */
  readonly reticle = { x: 0, y: 0 };
  /**
   * SPEC-041 §4.7: for the assist-cone target, where a shot fired now meets
   * it, projected to the convergence depth — plane metres, like the reticle.
   * `active` is false with no target in the cone. The scene draws the lead
   * pip here while ARIA is enabled; ARIA level 2 chases it with the reticle.
   */
  readonly lead = { x: 0, y: 0, active: false };
  /** Scratch for a burst round's aim point (no allocation per round). */
  readonly #aim = { x: 0, y: 0 };

  readonly economy: Economy;
  readonly #progression: Progression;
  readonly #missions: Missions;
  readonly #events: FlightEvents;
  readonly #rng: Rng;
  readonly #stormRng: Rng;
  /**
   * Review 2026-10 (G-20): a downed ship's salvage rolls here — a fork, so
   * the trip's hazards and waves draw exactly as they did before it.
   */
  readonly #salvageRng: Rng;
  /**
   * SPEC-066 §4.9: every draw of the first trip's field — a fork, so the
   * trip's other streams draw exactly as they would without it.
   */
  readonly #fieldRng: Rng;
  /** The planet's field when this is its first trip, else null. */
  readonly #field: { readonly fromSecond: number; readonly toSecond: number } | null;
  /** SPEC-069 §4.4: the trip's planned signals, drawn on a fork of their own. */
  readonly #signals: Array<{ at: number; x: number; y: number; kind: PickupKind; spawned: boolean }> = [];
  #signalsSpawned = 0;
  #signalsTaken = 0;
  /** SPEC-070 §4.4: the drop rolls — a fork, so every other stream draws as before. */
  readonly #missileRng: Rng;
  /** SPEC-070 §4.3: the next hazard's serial. */
  #nextId = 1;
  /** SPEC-069 §4.2: what ended the trip at the station, or null. */
  #recallCause: RecallCause | null = null;
  /** SPEC-069 §4.2: the extra burn per second on the last step. */
  #fuelBurn = 0;
  /** SPEC-069 §4.2: ARIA's low-fuel line has gone this trip. */
  #fuelLowSaid = false;
  /** SPEC-069 §4.2: `fastForward` flies the line and burns nothing. */
  #fastForwarding = false;
  /** Scratch for the missiles' steering (no allocation per step). */
  readonly #dir = { x: 0, y: 0, z: 0 };
  /** Scratch for a missile's splash victims, by id. */
  readonly #splash: number[] = [];
  readonly #cfg: FlightConfig;

  readonly #speedMult: number;
  readonly #ariaShieldRegen: number;
  readonly #ariaAutoAim: boolean;
  /** SPEC-041 §4.7, 41-k: ARIA aboard and enabled — the lead pip's gate. */
  readonly #ariaEnabled: boolean;
  /** SPEC-038 §4.6: never cached for the trip — `setDifficulty` moves it. */
  #damageMult = 1;
  readonly #asteroidCap: number;
  readonly #groups: WaveGroup[] = [];

  #phase: FlightPhase = 'launch';
  /** Sim seconds since construction — launch, cruise and holding all count. */
  #time = 0;
  #launchT = 0;
  /** Trip-progress integral, in `travelSeconds` units (§4.1). */
  #covered = 0;
  #holdT = 0;
  #throttleIndex = 1;
  #throttleLive = 1;
  #gun = 1;
  #stormActive = false;
  #stormEdgeAt: number;
  #stormClock = 0;
  #stormTick = 0;
  /** SPEC-066 §4.9: field rocks spawned this trip. */
  #fieldRocks = 0;
  /** SPEC-066 §4.9: oil the ship's guns have salvaged from rocks this trip. */
  #rockOil = 0;

  constructor(cfg: FlightConfig, economy: Economy, progression: Progression, missions: Missions, events: FlightEvents, rng: Rng) {
    this.#cfg = cfg;
    this.economy = economy;
    this.#progression = progression;
    this.#missions = missions;
    this.#events = events;
    this.#rng = rng;
    this.#stormRng = rng.fork('storm');
    this.#salvageRng = rng.fork('salvage');
    this.#fieldRng = rng.fork('field');
    this.#missileRng = rng.fork('missile');
    this.#field = cfg.firstTrip === true ? (cfg.planet.flight.firstTripField ?? null) : null;
    this.#stormEdgeAt = this.#stormRng.float(STORM_GAP[0], STORM_GAP[1]);

    this.#speedMult = UPGRADES.engine.metrics['speedMult']?.[cfg.ship.engine] ?? 1;
    const aria = cfg.companions.find((entry) => entry.id === 'aria' && entry.enabled);
    // Through `CompanionEffect` (all keys optional) — the literal union of the
    // ARIA rows only carries a key on the levels that grant it.
    const effect: CompanionEffect | undefined = aria === undefined ? undefined : COMPANIONS.aria.levels[aria.level - 1];
    // §4.6: shield regen comes only from ARIA — disabled means none at all.
    // SPEC-039 §4.3: the regeneration is a companion effect, so it scales.
    this.#ariaShieldRegen = (effect?.shieldRegen ?? 0) * (cfg.companionMult ?? 1);
    this.#ariaAutoAim = effect?.autoAim ?? false;
    this.#ariaEnabled = effect !== undefined;
    const hullBonus = effect?.hullBonus ?? 0;
    this.setDifficulty(cfg.difficulty, cfg.iteration);
    this.#asteroidCap = cfg.quality.asteroidCap;

    const maxShield = UPGRADES.shield.metrics['shieldHp']?.[cfg.ship.shield] ?? 40;
    const maxHull = (UPGRADES.hull.metrics['hullHp']?.[cfg.ship.hull] ?? 100) * (1 + hullBonus);
    this.ship = {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      bank: 0,
      shield: maxShield,
      hull: maxHull,
      maxShield,
      maxHull,
      shieldRegenAt: 0,
      throttle: 1,
      fireCooldown: 0,
      alive: true,
      fuel: 1,
      missiles: MISSILE.loaded,
    };

    // The wave script, placed by trip fraction so throttle and engine scale it
    // together (§4.4): the scaled second is `atSecond / speedMult / throttle`.
    for (const waveId of cfg.planet.flight.waves) {
      for (const group of WAVES[waveId].groups) {
        this.#groups.push({
          enemy: group.enemy,
          count: group.count,
          frac: clamp(group.atSecond / cfg.planet.travelSeconds, 0, 1),
          spawned: false,
        });
      }
    }
    this.#planSignals(rng.fork('signals'));
  }

  /**
   * SPEC-069 §4.4: `min`…`max` signals, one per equal slot of `from`…`to` of
   * the trip, each `offset` metres off the line on a flattened ellipse, with a
   * weighted kind. Their own fork, so the trip's other streams are untouched.
   */
  #planSignals(rng: Rng): void {
    const count = rng.int(SIGNALS.min, SIGNALS.max);
    const slot = (SIGNALS.to - SIGNALS.from) / count;
    const weights = SIGNALS.weights;
    for (let i = 0; i < count; i++) {
      const frac = SIGNALS.from + slot * (i + rng.next());
      const angle = rng.angle();
      const r = rng.float(SIGNALS.offset[0], SIGNALS.offset[1]);
      const roll = rng.next();
      const kind: PickupKind = roll < weights.fuel ? 'fuel' : roll < weights.fuel + weights.oil ? 'oil' : 'missile';
      this.#signals.push({
        at: frac * this.#cfg.planet.travelSeconds,
        x: r * Math.cos(angle),
        y: r * Math.sin(angle) * SIGNALS.vertical,
        kind,
        spawned: false,
      });
    }
  }

  // ------------------------------------------------------------------ getters

  get phase(): FlightPhase {
    return this.#phase;
  }

  /** 0..1 of the trip (§4.1); pinned at 1 through holding. */
  get progress(): number {
    return clamp(this.#covered / this.#cfg.planet.travelSeconds, 0, 1);
  }

  get stormActive(): boolean {
    return this.#stormActive;
  }

  /** The lerped throttle actually applied to speeds and rates (§4.1). */
  get throttleLive(): number {
    return this.#throttleLive;
  }

  /** Seconds spent in the holding pattern, for the 90 s cap (§4.1, E12). */
  get holdSeconds(): number {
    return this.#holdT;
  }

  /** Sim seconds since launch started; the regen delay runs on this clock. */
  get time(): number {
    return this.#time;
  }

  /** SPEC-066 §4.9: field rocks spawned this trip; 0 on any trip without the field. */
  get fieldRocks(): number {
    return this.#fieldRocks;
  }

  /** SPEC-066 §4.9: the oil the rocks the guns destroyed put in this trip (E125: what entered the hold). */
  get rockSalvage(): number {
    return this.#rockOil;
  }

  /**
   * SPEC-041 §4.7, 41-k: whether ARIA is aboard and enabled. The lead pip is
   * hers — disabled, there is no pip and no snap, while the cone still keys
   * touch auto-fire.
   */
  get ariaEnabled(): boolean {
    return this.#ariaEnabled;
  }

  /** SPEC-069 §4.1: the ship's distance from the course line, in metres. */
  get offLine(): number {
    return Math.hypot(this.ship.x, this.ship.y);
  }

  /** SPEC-069 §4.3: close enough to the line to land. */
  get onApproach(): boolean {
    return this.offLine <= COURSE.approach;
  }

  /** SPEC-069 §4.2: the extra burn per second on the last step — 0 inside the corridor. */
  get fuelBurn(): number {
    return this.#fuelBurn;
  }

  /**
   * PLAN R31 (SPEC-074 §4.2): a trip that flies its planet's first-trip field
   * (SPEC-066 §4.9) is the tutorial trip. It burns no extra fuel off the line,
   * so nothing it does can tow it home before anything has said the tank drains.
   */
  get tutorialTrip(): boolean {
    return this.#field !== null;
  }

  /** SPEC-069 §4.2: what ended the trip at the station — `null` while it runs or after a landing. */
  get recallCause(): RecallCause | null {
    return this.#recallCause;
  }

  /** SPEC-069 §4.4: the trip's signals — planned, spawned so far, and taken. */
  get signalCounts(): { planned: number; spawned: number; taken: number } {
    return { planned: this.#signals.length, spawned: this.#signalsSpawned, taken: this.#signalsTaken };
  }

  /** SPEC-069 §4.5: the signals planned for this trip, for the dev hook and the tests. */
  get signalPlan(): ReadonlyArray<{ readonly at: number; readonly x: number; readonly y: number; readonly kind: PickupKind }> {
    return this.#signals;
  }

  /** Live enemy ships — the HUD's "hostiles: n" (§4.10). */
  get hostiles(): number {
    let count = 0;
    for (let i = 0; i < this.hazards.size; i++) {
      const kind = this.hazards.at(i).kind;
      if (kind === 'fighter' || kind === 'interceptor') count++;
    }
    return count;
  }

  /**
   * SPEC-070 §4.3: a fresh hazard serial, for a hazard allocated outside the
   * spawners (the dev hook's still fighter, the tests).
   */
  newHazardId(): number {
    return this.#nextId++;
  }

  /** Trip fractions of the wave groups, for the HUD's progress-bar markers. */
  waveMarkers(): number[] {
    return this.#groups.map((group) => group.frac);
  }

  /** `travelSeconds / engineSpeedMult / throttle` (§4.1) — the chosen notch, not the lerp. */
  duration(): number {
    return this.#cfg.planet.travelSeconds / this.#speedMult / (THROTTLES[this.#throttleIndex] as number);
  }

  // ------------------------------------------------------------------- update

  update(dt: number, input: FlightInput): void {
    if (this.#phase === 'arrived' || this.#phase === 'recalled' || !(dt > 0)) return;
    this.#time += dt;

    this.#updateThrottle(dt, input);

    if (this.#phase === 'launch') {
      this.#launchT += dt;
      this.#updateReticle(dt, input); // empty sky: the raw aim owns the reticle
      this.#steer(dt, input);
      // SPEC-069 §4.2: the launch steers, so straying burns in it too.
      this.#burn(dt);
      if (this.#phase !== 'launch') return; // towed
      // §4.8: survive timers are flight time while alive — launch counts too.
      this.#missions.update(dt, FLIGHT_MISSION_CONTEXT);
      if (this.#launchT >= LAUNCH_SECONDS) this.#phase = 'cruise';
      return; // §4.1: no hazards, no weapons, no storms during launch
    }

    if (this.#phase === 'cruise') {
      const from = this.progress;
      this.#covered += dt * this.#speedMult * this.#throttleLive;
      // SPEC-069 §4.2: the base burn follows the trip's progress, so the line
      // leaves `FUEL.reserve` at arrival whatever the throttle or the engine.
      if (!this.#fastForwarding) this.ship.fuel -= (1 - FUEL.reserve) * (this.progress - from);
      if (this.progress >= 1) {
        // A group placed at the trip's very end (frac 1) fires before the
        // arrival check, so it can never be skipped past.
        this.#spawnGroups();
        // §4.1: every group spawned, no wave enemy alive and no main flight
        // mission still open → arrived, else hold.
        if (this.#clearToLand()) {
          this.#arrive();
          return;
        }
        this.#phase = 'holding';
      }
    } else {
      // holding: asteroids stop spawning; after the cap, land anyway (E12).
      this.#holdT += dt;
      if (this.#clearToLand() || this.#holdT >= TUNING.HOLD_PATTERN_MAX_SECONDS) {
        this.#arrive();
        return;
      }
    }

    const coneTarget = this.#updateReticle(dt, input);
    this.#steer(dt, input); // after the reticle, so mouse steer chases this frame's
    this.#updateLock();
    this.#updateWeapons(dt, input, coneTarget);
    this.#fireMissile(input);
    this.#updateShots(dt);
    this.#updateMissiles(dt);
    if (this.#phase === 'cruise') this.#spawn(dt);
    this.#updateHazards(dt);
    if (!this.ship.alive) return; // a ram or a collision above may have ended the trip
    this.#updatePickups(dt);
    this.#updateStorm(dt);
    if (!this.ship.alive) return;
    this.#regenShield(dt);
    // SPEC-069 §4.2, 69-c: after the hazards, so a hull at 0 on the same step wins.
    this.#burn(dt);
    if (this.#recallCause !== null) return; // towed
    // §4.8: survive timers are real seconds while alive — cruise and holding.
    this.#missions.update(dt, FLIGHT_MISSION_CONTEXT);
  }

  /**
   * SPEC-069 §4.2: the extra burn past the corridor — `offlineBurn × e²` a
   * second, `e` the metres beyond the corridor over `offlineRef` — then
   * story's floor, ARIA's one low-fuel line, and the tow at empty. The base
   * burn is the cruise step's, where the progress is.
   */
  #burn(dt: number): void {
    const ship = this.ship;
    // PLAN R31 (SPEC-074 §4.2): the tutorial trip burns only its base fuel.
    const past = this.tutorialTrip ? 0 : Math.max(0, this.offLine - COURSE.corridor) / FUEL.offlineRef;
    this.#fuelBurn = FUEL.offlineBurn * past * past;
    if (this.#fastForwarding) return;
    ship.fuel -= this.#fuelBurn * dt;
    if (this.#cfg.difficulty === 'story' && ship.fuel < FUEL.storyFloor) ship.fuel = FUEL.storyFloor;
    if (!this.#fuelLowSaid && ship.fuel <= FUEL.low) {
      this.#fuelLowSaid = true;
      this.#events.emit('flight:fuelLow', {});
    }
    if (ship.fuel <= 0) {
      ship.fuel = 0;
      this.#tow();
    }
  }

  /**
   * SPEC-069 §4.2, E133: an empty tank is a tow, not a death. The jump's oil
   * stays spent and the cargo aboard (E5); the stage resets as on a recall;
   * no `player:died`, no burst — the engines simply die.
   */
  #tow(): void {
    this.#phase = 'recalled';
    this.#recallCause = 'fuel';
    this.lead.active = false;
    this.lock.active = false;
    this.missiles.clear();
    this.#events.emit('flight:recalled', { planet: this.#cfg.planet.id, cause: 'fuel' });
    this.#missions.resetStages('recall');
  }

  /**
   * SPEC-032 §4.5: fast-forward with idle input, the sky cleared and the
   * shield topped before every step — so no rock, ship or ion storm can end
   * the trip early — until it is over or `limitSeconds` of simulated time have
   * passed. The same `update` steps a flown trip takes, so `flight:arrived`,
   * the missions' timers and the arrival rule (E12) are the flown ones.
   * Returns the seconds simulated; 0 for a trip that is already over.
   */
  fastForward(limitSeconds: number): number {
    // SPEC-069 §4.2, 69-k: the autopilot flies the line and burns nothing,
    // so a skip from anywhere, on any tank, is never towed and lands on approach.
    const ship = this.ship;
    if (this.#phase !== 'arrived' && this.#phase !== 'recalled') {
      ship.x = 0;
      ship.y = 0;
      ship.vx = 0;
      ship.vy = 0;
    }
    const idle: FlightInput = {
      steerX: 0,
      steerY: 0,
      fire: false,
      aimX: 0,
      aimY: 0,
      throttleUp: false,
      throttleDown: false,
      autoFire: false,
      mouseSteer: false,
    };
    const dt = 1 / 60;
    let simulated = 0;
    this.#fastForwarding = true;
    while (simulated < limitSeconds && this.#phase !== 'arrived' && this.#phase !== 'recalled') {
      this.hazards.clear();
      // SPEC-069 §4.4: a skipped run collects nothing; SPEC-070: fires nothing.
      this.pickups.clear();
      this.missiles.clear();
      ship.shield = ship.maxShield; // storms only bite through an empty shield (§4.5)
      this.update(dt, idle);
      simulated += dt;
    }
    this.#fastForwarding = false;
    return simulated;
  }

  // ----------------------------------------------------------------- steering

  #updateThrottle(dt: number, input: FlightInput): void {
    if (input.throttleUp) this.#throttleIndex = Math.min(THROTTLES.length - 1, this.#throttleIndex + 1);
    if (input.throttleDown) this.#throttleIndex = Math.max(0, this.#throttleIndex - 1);
    this.ship.throttle = THROTTLES[this.#throttleIndex] as ShipState['throttle'];
    const target = this.ship.throttle;
    const before = this.#throttleLive;
    if (before !== target) {
      const step = THROTTLE_LERP_PER_S * dt;
      this.#throttleLive = before < target ? Math.min(target, before + step) : Math.max(target, before - step);
      // §4.1: the change scales hazard `vDepth` proportionally, so hazards per
      // second stay put while hazards per trip-meter thin out or thicken.
      const factor = this.#throttleLive / before;
      // SPEC-069 §4.4, 69-i: pickups close like field rocks, so they still
      // reach the plane at their planned trip second.
      for (let i = 0; i < this.pickups.size; i++) this.pickups.at(i).vDepth *= factor;
      for (let i = 0; i < this.hazards.size; i++) {
        const hazard = this.hazards.at(i);
        if (hazard.kind === 'asteroid' || hazard.kind === 'enemy_shot') {
          hazard.vDepth *= factor;
        } else if (hazard.kind === 'interceptor') {
          // The whole dive vector scales, so the aim line holds while the
          // closing speed follows the throttle. Fighters re-derive their
          // approach from the live throttle every frame instead.
          hazard.vx *= factor;
          hazard.vy *= factor;
          hazard.vDepth *= factor;
        }
      }
    }
  }

  #steer(dt: number, input: FlightInput): void {
    const ship = this.ship;
    if (!ship.alive) return;
    let steerX: number;
    let steerY: number;
    // SPEC-069 §4.1: a held steering key wins over mouse steer — before, a
    // mouse that had moved once (a click on Start) silenced the keys for good.
    const keyed = input.steerX !== 0 || input.steerY !== 0;
    if (input.mouseSteer === true && !keyed) {
      // §4.2: mouse steer leans toward the pointer, ramping up past a dead
      // zone (SPEC-069 §4.1), so a pointer near the centre holds the ship
      // still instead of creeping it off the line with no wall to stop it. The
      // offset is the pointer's from the nose: a reticle read through the
      // chasing, pitching camera led the ship's own motion and ran it away.
      steerX = mouseSteerAxis(input.noseOffsetX ?? 0);
      steerY = mouseSteerAxis(input.noseOffsetY ?? 0);
    } else {
      steerX = clamp(input.steerX, -1, 1);
      steerY = clamp(input.steerY, -1, 1);
    }
    // SPEC-069 §4.1: a released axis coasts; nothing pulls toward the line.
    const damping = Math.exp(-COAST_DAMPING * dt);
    if (steerX !== 0) ship.vx += steerX * RAIL.lateralAccel * dt;
    else ship.vx *= damping;
    if (steerY !== 0) ship.vy += steerY * RAIL.lateralAccel * dt;
    else ship.vy *= damping;
    const speed = Math.hypot(ship.vx, ship.vy);
    if (speed > RAIL.lateralSpeed) {
      const scale = RAIL.lateralSpeed / speed;
      ship.vx *= scale;
      ship.vy *= scale;
    }
    ship.x += ship.vx * dt;
    ship.y += ship.vy * dt;
    // SPEC-069 §4.1, E132: the nav limit stops outward motion with no bounce;
    // the tangential part stays, so the ship slides along the circle.
    const r = Math.hypot(ship.x, ship.y);
    if (r > NAV_LIMIT) {
      const nx = ship.x / r;
      const ny = ship.y / r;
      ship.x = nx * NAV_LIMIT;
      ship.y = ny * NAV_LIMIT;
      const outward = ship.vx * nx + ship.vy * ny;
      if (outward > 0) {
        ship.vx -= outward * nx;
        ship.vy -= outward * ny;
      }
    }
    ship.bank = (-ship.vx / RAIL.lateralSpeed) * 35;
  }

  // ----------------------------------------------------------- reticle & guns

  /**
   * §4.7: the raw aim owns the reticle until an enemy ship sits inside the 6°
   * cone; then ARIA L2+ chases it at 20/s. Returns the cone target (or null) —
   * auto-fire keys off it whether or not the assist is bought (AC-32).
   *
   * SPEC-041 §4.7: the cone target's lead — where a shot fired now meets it,
   * projected to the convergence depth — is written to `lead` on every level,
   * and it is the lead, not the target's current projection, that ARIA L2+
   * chases. Level 1 never moves the reticle.
   */
  #updateReticle(dt: number, input: FlightInput): Hazard | null {
    const ship = this.ship;
    let target: Hazard | null = null;
    const rx = input.aimX - ship.x;
    const ry = input.aimY - ship.y;
    const rlen = Math.hypot(rx, ry, CONVERGE_DEPTH);
    for (let i = 0; i < this.hazards.size; i++) {
      const hazard = this.hazards.at(i);
      // 13-i: only enemy ships are assist targets — never asteroids or shots.
      if (hazard.kind !== 'fighter' && hazard.kind !== 'interceptor') continue;
      if (hazard.depth <= 0) continue;
      const hx = hazard.x - ship.x;
      const hy = hazard.y - ship.y;
      const hlen = Math.hypot(hx, hy, hazard.depth);
      const cos = (rx * hx + ry * hy + CONVERGE_DEPTH * hazard.depth) / (rlen * hlen);
      if (cos < ASSIST_CONE_COS) continue;
      if (target === null || hazard.depth < target.depth) target = hazard;
    }
    const lead = this.lead;
    lead.active = target !== null;
    if (target !== null) {
      // The shot and the target close at `laserSpeed − vDepth`: they meet `t`
      // from now, `meet` metres out, where the target has moved by its
      // lateral velocity × t. Scaled from the ship to the convergence depth,
      // which is the plane the reticle — and so every shot — aims through.
      const t = target.depth / (RAIL.laserSpeed - target.vDepth);
      const scale = CONVERGE_DEPTH / (RAIL.laserSpeed * t);
      lead.x = ship.x + (target.x + target.vx * t - ship.x) * scale;
      lead.y = ship.y + (target.y + target.vy * t - ship.y) * scale;
    }
    if (target !== null && this.#ariaAutoAim) {
      // ARIA L2+: chase the lead point.
      const chase = Math.min(1, ASSIST_LERP_PER_S * dt);
      this.reticle.x += (lead.x - this.reticle.x) * chase;
      this.reticle.y += (lead.y - this.reticle.y) * chase;
    } else {
      this.reticle.x = input.aimX;
      this.reticle.y = input.aimY;
    }
    return target;
  }

  #updateWeapons(dt: number, input: FlightInput, coneTarget: Hazard | null): void {
    const ship = this.ship;
    ship.fireCooldown -= dt;
    // SPEC-039 §4.4: a step that does not fire banks at most one step of
    // remainder, so a released trigger carries nothing more.
    const wantsFire =
      ship.alive && (input.fire || (input.autoFire === true && (coneTarget !== null || this.#asteroidNear())));
    if (!wantsFire || ship.fireCooldown > 0) {
      if (ship.fireCooldown < -FIRE_CARRY) ship.fireCooldown = -FIRE_CARRY;
      return;
    }
    const fireRate = UPGRADES.weapon.metrics['fireRate']?.[this.#cfg.ship.weapon] ?? 4;
    const damage = UPGRADES.weapon.metrics['damage']?.[this.#cfg.ship.weapon] ?? 10;
    // §4.7: two guns alternate; each shot leaves its gun aimed at the reticle's
    // depth-80 projection, so both streams converge there.
    this.#gun = -this.#gun;
    const gx = ship.x + GUN_OFFSET_X * this.#gun;
    const gy = ship.y + GUN_OFFSET_Y;
    const flight = CONVERGE_DEPTH / RAIL.laserSpeed;
    const shot = this.shots.alloc();
    shot.x = gx;
    shot.y = gy;
    shot.depth = 0;
    shot.vDepth = RAIL.laserSpeed;
    shot.vx = (this.reticle.x - gx) / flight;
    shot.vy = (this.reticle.y - gy) / flight;
    shot.damage = damage;
    // SPEC-039 §4.4: the remainder of this interval carries into the next, at
    // most one step of it, so the guns deliver their stated rate at 60 Hz.
    ship.fireCooldown = Math.max(ship.fireCooldown, -FIRE_CARRY) + 1 / fireRate;
    // SPEC-035 §4.11: one event per shot. The rail has no XZ plane, so the
    // position is the gun's own — `AudioReactions` does not position `ship`.
    this.#events.emit('weapon:fired', { line: 'ship', x: gx, z: gy });
  }

  // ------------------------------------------------------- SPEC-070: missiles

  /**
   * §4.2: the enemy ship nearest the reticle's ray inside the lock cone,
   * between `lockMinDepth` and `lockMaxDepth`, or none.
   */
  #updateLock(): void {
    const lock = this.lock;
    lock.active = false;
    const ship = this.ship;
    const rx = this.reticle.x - ship.x;
    const ry = this.reticle.y - ship.y;
    const rlen = Math.hypot(rx, ry, CONVERGE_DEPTH);
    let best = LOCK_CONE_COS;
    for (let i = 0; i < this.hazards.size; i++) {
      const hazard = this.hazards.at(i);
      if (hazard.kind !== 'fighter' && hazard.kind !== 'interceptor') continue;
      if (hazard.depth < MISSILE.lockMinDepth || hazard.depth > MISSILE.lockMaxDepth) continue;
      const hx = hazard.x - ship.x;
      const hy = hazard.y - ship.y;
      const cos = (rx * hx + ry * hy + CONVERGE_DEPTH * hazard.depth) / (rlen * Math.hypot(hx, hy, hazard.depth));
      if (cos < best) continue;
      best = cos;
      lock.active = true;
      lock.id = hazard.id;
      lock.x = hazard.x;
      lock.y = hazard.y;
      lock.depth = hazard.depth;
    }
  }

  /** §4.1–§4.2, E136: one missile per press, with a lock and a missile in the rack. */
  #fireMissile(input: FlightInput): void {
    const ship = this.ship;
    if (input.missile !== true || !ship.alive) return;
    if (ship.missiles <= 0) {
      this.#events.emit('flight:missileRefused', { reason: 'empty' });
      return;
    }
    const lock = this.lock;
    if (!lock.active) {
      this.#events.emit('flight:missileRefused', { reason: 'no_lock' });
      return;
    }
    ship.missiles--;
    const missile = this.missiles.alloc();
    missile.x = ship.x;
    missile.y = ship.y - 0.5;
    missile.depth = 0;
    const dx = lock.x - missile.x;
    const dy = lock.y - missile.y;
    const length = Math.hypot(dx, dy, lock.depth) || 1;
    missile.vx = (dx / length) * MISSILE.speed;
    missile.vy = (dy / length) * MISSILE.speed;
    missile.vDepth = (lock.depth / length) * MISSILE.speed;
    missile.target = lock.id;
    missile.retargeted = false;
    missile.age = 0;
    this.#events.emit('flight:missileFired', { x: missile.x, y: missile.y });
  }

  /** The live hazard with serial `id`, as a pool index, or −1. */
  #hazardIndex(id: number): number {
    if (id < 0) return -1;
    for (let i = 0; i < this.hazards.size; i++) if (this.hazards.at(i).id === id) return i;
    return -1;
  }

  /** §4.3: the enemy ship nearest a missile's nose inside the retarget cone, as an id, or −1. */
  #retarget(missile: Missile): number {
    const speed = Math.hypot(missile.vx, missile.vy, missile.vDepth) || 1;
    let best = RETARGET_CONE_COS;
    let id = -1;
    for (let i = 0; i < this.hazards.size; i++) {
      const hazard = this.hazards.at(i);
      if (hazard.kind !== 'fighter' && hazard.kind !== 'interceptor') continue;
      const hx = hazard.x - missile.x;
      const hy = hazard.y - missile.y;
      const hz = hazard.depth - missile.depth;
      const cos = (missile.vx * hx + missile.vy * hy + missile.vDepth * hz) / (speed * (Math.hypot(hx, hy, hz) || 1));
      if (cos < best) continue;
      best = cos;
      id = hazard.id;
    }
    return id;
  }

  /**
   * §4.3: each missile turns toward its target by at most `turnRate × dt`,
   * moves, and sweeps the step's relative motion against the target's circle
   * — a diving interceptor closes at well over a hit diameter a step. A lost
   * target is replaced once; past its life or its depth the missile burns out.
   */
  #updateMissiles(dt: number): void {
    const dir = this.#dir;
    for (let m = this.missiles.size - 1; m >= 0; m--) {
      const missile = this.missiles.at(m);
      missile.age += dt;
      if (missile.age >= MISSILE.life || missile.depth > MISSILE.maxDepth || missile.depth < -10) {
        this.missiles.free(m);
        continue;
      }
      let index = this.#hazardIndex(missile.target);
      if (index < 0 && !missile.retargeted) {
        missile.retargeted = true;
        missile.target = this.#retarget(missile);
        index = this.#hazardIndex(missile.target);
      }
      if (index < 0) missile.target = -1;
      const target = index >= 0 ? this.hazards.at(index) : null;
      if (target !== null) {
        // Turn the velocity toward the target, at most `turnRate × dt` radians.
        const speed = MISSILE.speed;
        const vx = missile.vx / speed;
        const vy = missile.vy / speed;
        const vz = missile.vDepth / speed;
        const tx = target.x - missile.x;
        const ty = target.y - missile.y;
        const tz = target.depth - missile.depth;
        const tl = Math.hypot(tx, ty, tz) || 1;
        dir.x = tx / tl;
        dir.y = ty / tl;
        dir.z = tz / tl;
        const angle = Math.acos(clamp(vx * dir.x + vy * dir.y + vz * dir.z, -1, 1));
        const most = MISSILE.turnRate * dt;
        if (angle > most && Math.sin(angle) > 1e-6) {
          const sin = Math.sin(angle);
          const a = Math.sin(angle - most) / sin;
          const b = Math.sin(most) / sin;
          dir.x = a * vx + b * dir.x;
          dir.y = a * vy + b * dir.y;
          dir.z = a * vz + b * dir.z;
          const length = Math.hypot(dir.x, dir.y, dir.z) || 1;
          dir.x /= length;
          dir.y /= length;
          dir.z /= length;
        }
        missile.vx = dir.x * speed;
        missile.vy = dir.y * speed;
        missile.vDepth = dir.z * speed;
      }
      // The relative position before the step, then the step's relative motion.
      const r0x = target === null ? 0 : missile.x - target.x;
      const r0y = target === null ? 0 : missile.y - target.y;
      const r0z = target === null ? 0 : missile.depth - target.depth;
      missile.x += missile.vx * dt;
      missile.y += missile.vy * dt;
      missile.depth += missile.vDepth * dt;
      if (target === null || index < 0) continue;
      const dx = (missile.vx - target.vx) * dt;
      const dy = (missile.vy - target.vy) * dt;
      const dz = (missile.vDepth - target.vDepth) * dt;
      const span = dx * dx + dy * dy + dz * dz;
      const t = span > 0 ? clamp(-(r0x * dx + r0y * dy + r0z * dz) / span, 0, 1) : 0;
      const miss = Math.hypot(r0x + t * dx, r0y + t * dy, r0z + t * dz);
      if (miss > target.radius + MISSILE.hitRadius) continue;
      this.#missileHit(index);
      this.missiles.free(m);
    }
  }

  /**
   * §4.3: the target takes `damage`, every other hazard within `splashRadius`
   * of the impact `splash` — through `#damageHazard`, so kills, XP, salvage
   * and drops are a laser's. Victims are found by id, since a kill frees.
   */
  #missileHit(index: number): void {
    const target = this.hazards.at(index);
    const x = target.x;
    const y = target.y;
    const depth = target.depth;
    const id = target.id;
    const splash = this.#splash;
    splash.length = 0;
    for (let i = 0; i < this.hazards.size; i++) {
      const other = this.hazards.at(i);
      if (other.id === id) continue;
      if (Math.hypot(other.x - x, other.y - y, other.depth - depth) <= MISSILE.splashRadius) splash.push(other.id);
    }
    this.#damageHazard(index, MISSILE.damage);
    const kill = this.#hazardIndex(id) < 0;
    for (const victim of splash) {
      const at = this.#hazardIndex(victim);
      if (at >= 0) this.#damageHazard(at, MISSILE.splash);
    }
    this.#burst(x, y, depth, 2.5);
    this.#events.emit('flight:missileHit', { x, y, depth, kill });
  }

  // ------------------------------------------------------- SPEC-069: pickups

  /**
   * §4.4: the tractor draws a close canister in, then it closes along depth;
   * crossing the plane within `PICKUP.radius` of the ship takes it.
   */
  #updatePickups(dt: number): void {
    const ship = this.ship;
    for (let i = this.pickups.size - 1; i >= 0; i--) {
      const pickup = this.pickups.at(i);
      if (pickup.depth < PICKUP.tractorDepth) {
        const dx = ship.x - pickup.x;
        const dy = ship.y - pickup.y;
        const gap = Math.hypot(dx, dy);
        if (gap > 0 && gap < PICKUP.tractorRadius) {
          const step = Math.min(gap, PICKUP.tractorSpeed * dt);
          pickup.x += (dx / gap) * step;
          pickup.y += (dy / gap) * step;
        }
      }
      pickup.depth += pickup.vDepth * dt;
      if (pickup.depth <= RAIL.hitDepth && ship.alive && Math.hypot(ship.x - pickup.x, ship.y - pickup.y) <= PICKUP.radius) {
        this.#take(pickup);
        this.pickups.free(i);
        continue;
      }
      if (pickup.depth < -5) this.pickups.free(i); // missed — gone (E135)
    }
  }

  /**
   * §4.4, E135: a fuel cell tops the tank, an oil pod goes into the hold as a
   * pickup (the cargo cap applies), a missile into the rack. A full tank, a
   * full rack or a hold that took nothing reports `taken: false`.
   */
  #take(pickup: Pickup): void {
    const ship = this.ship;
    let taken = false;
    switch (pickup.kind) {
      case 'fuel':
        // A tank within 1 % of full has no room for a cell (E135).
        taken = ship.fuel < 0.99;
        ship.fuel = Math.min(1, ship.fuel + FUEL.cell);
        break;
      case 'oil': {
        const { added, shipped } = this.economy.addResource('oil', SIGNALS.oil, 'pickup');
        taken = added + shipped > 0;
        break;
      }
      case 'missile':
        taken = ship.missiles < MISSILE.rack;
        if (taken) ship.missiles++;
        break;
    }
    if (taken && pickup.source === 'signal') this.#signalsTaken++;
    this.#events.emit('flight:pickup', { kind: pickup.kind, source: pickup.source, taken });
  }

  /** SPEC-070 §4.4: a missile canister where a ship went down, closing like the rest. */
  #spawnDrop(x: number, y: number, depth: number): void {
    const pickup = this.pickups.alloc();
    pickup.kind = 'missile';
    pickup.source = 'drop';
    pickup.x = x;
    pickup.y = y;
    pickup.depth = depth;
    pickup.vDepth = -RAIL.baseSpeed * this.#throttleLive;
  }

  /**
   * SPEC-069 §4.4: each planned signal spawns once, `lead` trip seconds ahead,
   * at the depth that brings it to the plane at its planned trip second.
   */
  #spawnSignals(): void {
    if (this.#fastForwarding) return; // a skipped run collects none
    for (const signal of this.#signals) {
      if (signal.spawned || this.#covered < signal.at - SIGNALS.lead) continue;
      signal.spawned = true;
      this.#signalsSpawned++;
      const pickup = this.pickups.alloc();
      pickup.kind = signal.kind;
      pickup.source = 'signal';
      pickup.x = signal.x;
      pickup.y = signal.y;
      pickup.depth = RAIL.hitDepth + ((signal.at - this.#covered) * RAIL.baseSpeed) / this.#speedMult;
      pickup.vDepth = -RAIL.baseSpeed * this.#throttleLive;
      this.#events.emit('flight:signal', { kind: signal.kind });
    }
  }

  /** §4.7: touch auto-fire also covers an asteroid drifting within 3 m in XY. */
  #asteroidNear(): boolean {
    for (let i = 0; i < this.hazards.size; i++) {
      const hazard = this.hazards.at(i);
      if (hazard.kind !== 'asteroid') continue;
      if (Math.hypot(hazard.x - this.ship.x, hazard.y - this.ship.y) <= AUTO_FIRE_ASTEROID_M) return true;
    }
    return false;
  }

  #updateShots(dt: number): void {
    for (let s = this.shots.size - 1; s >= 0; s--) {
      const shot = this.shots.at(s);
      const from = shot.depth;
      const to = from + shot.vDepth * dt;
      let hit = false;
      // §4.7: sweep along depth — a shot cannot tunnel through a thin slice.
      for (let h = this.hazards.size - 1; h >= 0; h--) {
        const hazard = this.hazards.at(h);
        if (hazard.kind === 'enemy_shot') continue; // bullets do not duel
        // SPEC-034 §4.3: the gap closes from both ends — the hazard moves along
        // depth over the same step, so a closing target can no longer tunnel.
        const r = hazard.depth - from;
        const r1 = hazard.depth + hazard.vDepth * dt - to;
        if (r < 0 || r1 > 0) continue;
        const span = r - r1;
        const at = span === 0 ? 0 : r / span;
        const sx = shot.x + shot.vx * dt * at;
        const sy = shot.y + shot.vy * dt * at;
        const hx = hazard.x + hazard.vx * dt * at;
        const hy = hazard.y + hazard.vy * dt * at;
        if (Math.hypot(sx - hx, sy - hy) >= hazard.radius + 0.3) continue;
        hit = true;
        this.#damageHazard(h, shot.damage);
        break;
      }
      if (hit || to >= 200) {
        this.shots.free(s);
        continue;
      }
      shot.depth = to;
      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
    }
  }

  #damageHazard(index: number, damage: number): void {
    const hazard = this.hazards.at(index);
    hazard.hp -= damage;
    const lethal = hazard.hp <= 0;
    const kind = hazard.kind;
    // SPEC-041 §4.9: every player-shot hit is heard and seen — the reticle
    // marks it and `ship_hit_tick` plays. (Shots never hit an enemy shot.)
    if (kind !== 'enemy_shot') this.#events.emit('flight:hazardHit', { kind, x: hazard.x, y: hazard.y, lethal });
    if (!lethal) {
      hazard.hitFlash = HAZARD_FLASH_SECONDS; // counted down in `#updateHazards`
      return;
    }
    this.#burst(hazard.x, hazard.y, hazard.depth, hazard.radius);
    const def = hazard.def;
    if ((hazard.kind === 'fighter' || hazard.kind === 'interceptor') && def !== undefined) {
      // §4.4: kills pay XP and the event missions count.
      this.#events.emit('enemy:killed', { enemyId: def.id as EnemyId, elite: false, x: hazard.x, z: hazard.depth, xp: def.xp });
      this.#progression.addXp(def.xp, 'flight');
      this.#salvage(def);
      // SPEC-070 §4.4, E137: sometimes a missile canister, on a stream of its own.
      if (this.#missileRng.chance(MISSILE.dropChance)) this.#spawnDrop(hazard.x, hazard.y, hazard.depth);
    } else if (kind === 'asteroid' && hazard.radius >= ROCK_SALVAGE_RADIUS) {
      this.#rockSalvage();
    }
    this.hazards.free(index);
  }

  /**
   * SPEC-066 §4.9, E125: a big rock the guns destroyed drops
   * `ROCK_SALVAGE_OIL` into the hold as a pickup — the cargo cap applies —
   * until the oil it put in reaches `ROCK_SALVAGE_PER_TRIP` this trip. Only
   * what went in counts, so a full hold uses none of the 20. Separate from,
   * and unlike, the uncapped fighter salvage above. A collision never calls it.
   */
  #rockSalvage(): void {
    const want = Math.min(ROCK_SALVAGE_OIL, ROCK_SALVAGE_PER_TRIP - this.#rockOil);
    if (want <= 0) return;
    const { added, shipped } = this.economy.addResource('oil', want, 'pickup');
    this.#rockOil += added + shipped;
  }

  /**
   * Review 2026-10 (G-20): a downed fighter or interceptor rolls its `loot`
   * table (`flight_salvage`), and each resource it pays goes straight into the
   * hold as a pickup — the cargo cap applies, and `resource:collected` plays
   * the pickup chime. Flight kills paid XP only. A flight table holds resource
   * rows only (content invariant); any other row is skipped.
   */
  #salvage(def: EnemyDef): void {
    const rng = this.#salvageRng;
    for (const entry of LOOT_TABLES[def.loot]) {
      if (entry.kind !== 'resource' || !rng.chance(entry.chance)) continue;
      this.economy.addResource(entry.resource, rng.int(entry.min, entry.max), 'pickup');
    }
  }

  // ------------------------------------------------------------------- spawns

  #spawn(dt: number): void {
    // §4.3: Poisson at `asteroidDensity × throttle` per second, capped per preset.
    const rate = this.#cfg.planet.flight.asteroidDensity * this.#throttleLive;
    if (this.#rng.next() < rate * dt && this.#asteroidCount() < this.#asteroidCap) this.spawnAsteroid();
    // SPEC-066 §4.9: the first trip's field, on top of the ambient density and
    // on its own fork — inside its window of covered trip seconds.
    const field = this.#field;
    if (field !== null && this.#covered >= field.fromSecond && this.#covered <= field.toSecond) {
      const fieldRate = FIELD_ROCKS_PER_SECOND * this.#throttleLive;
      if (this.#fieldRng.next() < fieldRate * dt && this.#asteroidCount() < this.#asteroidCap) this.#spawnFieldRock(field);
    }
    this.#spawnGroups();
    this.#spawnSignals();
  }

  /**
   * SPEC-066 §4.9: one field rock. It closes at the bare rail speed and never
   * drifts, so it reaches the ship's plane at trip second
   * `s = covered + (spawnDepth − hitDepth) / baseSpeed × speedMult` whatever
   * the throttle does on the way (a change scales its `vDepth` and the trip's
   * progress alike, 66-k). It sits outside the lane around `fieldLaneX(s)` by
   * its own radius, on a side drawn in proportion to the room there.
   */
  #spawnFieldRock(field: { readonly fromSecond: number; readonly toSecond: number }): void {
    const rng = this.#fieldRng;
    const radius = rng.float(FIELD_ROCK_RADIUS[0], FIELD_ROCK_RADIUS[1]);
    const arrival = this.#covered + ((RAIL.spawnDepth - RAIL.hitDepth) / RAIL.baseSpeed) * this.#speedMult;
    const centre = fieldLaneX(field, arrival);
    const clear = FIELD_LANE_HALF_WIDTH + radius;
    // SPEC-069 §4.1: the lane stays on the line; the rocks fill the window
    // around the ship outside it (the old plane, with the ship at the origin).
    const windowLeft = this.ship.x - PLANE.halfW;
    const windowRight = this.ship.x + PLANE.halfW;
    const leftTo = Math.min(windowRight, centre - clear);
    const rightFrom = Math.max(windowLeft, centre + clear);
    const left = Math.max(0, leftTo - windowLeft);
    const right = Math.max(0, windowRight - rightFrom);
    if (left + right <= 0) return; // the window is all lane
    const pick = rng.float(0, left + right);
    const x = pick < left ? windowLeft + pick : rightFrom + (pick - left);
    const hazard = this.hazards.alloc();
    hazard.kind = 'asteroid';
    hazard.id = this.#nextId++;
    hazard.x = x;
    hazard.y = this.ship.y + rng.float(-PLANE.halfH, PLANE.halfH);
    hazard.depth = RAIL.spawnDepth;
    hazard.radius = radius;
    hazard.hp = Math.round(radius * 15);
    hazard.vDepth = -RAIL.baseSpeed * this.#throttleLive;
    hazard.vx = 0;
    hazard.vy = 0;
    hazard.def = undefined;
    hazard.ttl = undefined;
    hazard.fireCooldown = undefined;
    hazard.pattern = undefined;
    hazard.holdDepth = undefined;
    hazard.hitFlash = 0;
    hazard.burstLeft = undefined;
    hazard.burstAt = undefined;
    hazard.shotDamage = undefined;
    this.#fieldRocks++;
  }

  /**
   * §4.4: wave groups fire at their trip fraction — throttle-scaled seconds.
   * SPEC-063 §4.5: each group says so once, after its last ship is in.
   */
  #spawnGroups(): void {
    for (const group of this.#groups) {
      if (group.spawned || this.progress < group.frac) continue;
      group.spawned = true;
      for (let i = 0; i < group.count; i++) this.#spawnShip(group.enemy);
      this.#events.emit('flight:groupSpawned', { enemy: group.enemy, count: group.count });
    }
  }

  #asteroidCount(): number {
    let count = 0;
    for (let i = 0; i < this.hazards.size; i++) if (this.hazards.at(i).kind === 'asteroid') count++;
    return count;
  }

  /**
   * §4.3: 70 % inside the threat box around the ship, else uniform on the
   * window around it (SPEC-069 §4.1). Public so the spawn-bias test can draw
   * 1,000 without flying a trip.
   */
  spawnAsteroid(): Hazard {
    const rng = this.#rng;
    const hazard = this.hazards.alloc();
    hazard.kind = 'asteroid';
    hazard.id = this.#nextId++;
    if (rng.chance(THREAT_BOX_CHANCE)) {
      hazard.x = this.ship.x + rng.float(-THREAT_BOX, THREAT_BOX);
      hazard.y = this.ship.y + rng.float(-THREAT_BOX, THREAT_BOX);
    } else {
      // SPEC-069 §4.1: the window around the ship, wherever it is.
      hazard.x = this.ship.x + rng.float(-PLANE.halfW, PLANE.halfW);
      hazard.y = this.ship.y + rng.float(-PLANE.halfH, PLANE.halfH);
    }
    hazard.depth = RAIL.spawnDepth;
    hazard.radius = rng.float(1, 4);
    hazard.hp = Math.round(hazard.radius * 15);
    hazard.vDepth = -(RAIL.baseSpeed * this.#throttleLive + rng.float(0, 15));
    hazard.vx = rng.float(-1.5, 1.5);
    hazard.vy = rng.float(-1.5, 1.5);
    hazard.def = undefined;
    hazard.ttl = undefined;
    hazard.fireCooldown = undefined;
    hazard.pattern = undefined;
    hazard.holdDepth = undefined;
    hazard.hitFlash = 0;
    hazard.burstLeft = undefined;
    hazard.burstAt = undefined;
    hazard.shotDamage = undefined;
    return hazard;
  }

  #spawnShip(enemyId: EnemyId): void {
    const def = ENEMIES[enemyId];
    const rng = this.#rng;
    const hazard = this.hazards.alloc();
    hazard.id = this.#nextId++;
    hazard.def = def;
    hazard.elite = false; // §4.4: no elites in flight
    hazard.radius = def.radius;
    hazard.hp = def.hp;
    // SPEC-069 §4.1: ships enter in the window around the ship.
    hazard.x = this.ship.x + rng.float(-PLANE.halfW, PLANE.halfW);
    hazard.y = this.ship.y + rng.float(-PLANE.halfH, PLANE.halfH);
    hazard.vx = 0;
    hazard.vy = 0;
    hazard.fireCooldown = undefined;
    hazard.ttl = undefined;
    hazard.holdDepth = undefined;
    hazard.hitFlash = 0;
    hazard.burstLeft = undefined;
    hazard.burstAt = undefined;
    hazard.shotDamage = undefined;
    if (def.archetype === 'interceptor') {
      hazard.kind = 'interceptor';
      hazard.depth = INTERCEPTOR_ENTER_DEPTH;
      hazard.pattern = 0; // not yet re-aimed
      this.#aimDive(hazard);
      return;
    }
    hazard.kind = 'fighter';
    hazard.depth = FIGHTER_ENTER_DEPTH;
    hazard.vDepth = -FIGHTER_APPROACH * this.#throttleLive;
    hazard.holdDepth = rng.float(FIGHTER_HOLD_MIN, FIGHTER_HOLD_MAX);
    hazard.ttl = FIGHTER_LEAVE_SECONDS;
    hazard.pattern = rng.angle();
    hazard.fireCooldown = def.attack.kind === 'ranged' ? def.attack.cooldown : 2;
    hazard.burstLeft = 0;
    hazard.burstAt = 0;
  }

  /** §4.4: straight at the ship's position, sampled now; `vDepth` stays the dive. */
  #aimDive(hazard: Hazard): void {
    const dive = INTERCEPTOR_DIVE * this.#throttleLive;
    const eta = (hazard.depth - RAIL.hitDepth) / dive;
    hazard.vDepth = -dive;
    hazard.vx = (this.ship.x - hazard.x) / eta;
    hazard.vy = (this.ship.y - hazard.y) / eta;
  }

  // ------------------------------------------------------------------ hazards

  #updateHazards(dt: number): void {
    const ship = this.ship;
    for (let i = this.hazards.size - 1; i >= 0; i--) {
      const hazard = this.hazards.at(i);
      // SPEC-041 §4.9: a hit's white flash runs out on the sim clock.
      const flash = hazard.hitFlash;
      if (flash !== undefined && flash > 0) hazard.hitFlash = flash > dt ? flash - dt : 0;
      switch (hazard.kind) {
        case 'fighter': {
          hazard.ttl = (hazard.ttl ?? 0) - dt;
          if (hazard.ttl <= 0) {
            // §4.4: leaves alive — not killed, no event. SPEC-041 41-j: the
            // rounds of a burst it had not fired yet leave with it.
            this.hazards.free(i);
            continue;
          }
          const hold = hazard.holdDepth ?? FIGHTER_HOLD_MIN;
          if (hazard.depth > hold) {
            // §4.1: closing speed follows the live throttle, like every hazard.
            hazard.vDepth = -FIGHTER_APPROACH * this.#throttleLive;
            hazard.depth += hazard.vDepth * dt;
          } else {
            hazard.vDepth = 0;
            // §4.4: figure-8 strafe — a Lissajous velocity, so no center state.
            hazard.pattern = (hazard.pattern ?? 0) + dt;
            const def = hazard.def;
            const width = (def?.speed ?? 8) * 0.6;
            hazard.vx = width * 1.2 * Math.cos(1.2 * hazard.pattern);
            hazard.vy = width * 0.6 * 2.4 * Math.cos(2.4 * hazard.pattern);
            hazard.fireCooldown = (hazard.fireCooldown ?? 2) - dt;
            if (hazard.fireCooldown <= 0 && ship.alive) {
              // SPEC-041 §4.8: the cooldown opens a burst; its first round
              // goes this step, the rest `interval` apart.
              hazard.burstLeft = FIGHTER_BURST.rounds;
              hazard.burstAt = this.#time;
              hazard.fireCooldown = def?.attack.kind === 'ranged' ? def.attack.cooldown : 2;
            }
            this.#fireBurst(hazard);
          }
          // SPEC-069 §4.1: fighters stay in the window around the ship, which
          // drags them along when it strays.
          hazard.x = clamp(hazard.x + hazard.vx * dt, ship.x - PLANE.halfW, ship.x + PLANE.halfW);
          hazard.y = clamp(hazard.y + hazard.vy * dt, ship.y - PLANE.halfH, ship.y + PLANE.halfH);
          continue;
        }
        case 'interceptor': {
          if (hazard.pattern === 0 && hazard.depth <= REAIM_DEPTH) {
            hazard.pattern = 1;
            this.#aimDive(hazard); // §4.4: re-aims once at depth 60
          }
          hazard.x += hazard.vx * dt;
          hazard.y += hazard.vy * dt;
          hazard.depth += hazard.vDepth * dt;
          if (hazard.depth <= RAIL.hitDepth && ship.alive && Math.hypot(hazard.x - ship.x, hazard.y - ship.y) < hazard.radius + SHIP_RADIUS) {
            const def = hazard.def;
            this.#burst(hazard.x, hazard.y, hazard.depth, hazard.radius);
            const from = { x: hazard.x, y: hazard.y };
            this.hazards.free(i);
            // The ram costs a flat 15 and the interceptor with it (see the
            // constant for why §4.4's `def.damage` cannot apply).
            this.hit(INTERCEPTOR_RAM_DAMAGE, 'enemy', def === undefined ? { kind: 'asteroid' } : { kind: 'enemy', enemyId: def.id as EnemyId }, from);
            continue;
          }
          if (hazard.depth < -5) this.hazards.free(i);
          continue;
        }
        case 'enemy_shot': {
          hazard.x += hazard.vx * dt;
          hazard.y += hazard.vy * dt;
          hazard.depth += hazard.vDepth * dt;
          if (hazard.depth <= RAIL.hitDepth && ship.alive && Math.hypot(hazard.x - ship.x, hazard.y - ship.y) < hazard.radius + SHIP_RADIUS) {
            const def = hazard.def;
            // SPEC-041 §4.8: a burst round deals its own share; `hit()` still
            // applies casual's ×0.7 on top (41-l).
            const damage = hazard.shotDamage ?? def?.damage ?? 10;
            const from = { x: hazard.x, y: hazard.y };
            this.hazards.free(i);
            this.hit(damage, 'enemy', def === undefined ? { kind: 'asteroid' } : { kind: 'projectile', enemyId: def.id as EnemyId }, from);
            continue;
          }
          if (hazard.depth < -5) this.hazards.free(i);
          continue;
        }
        case 'asteroid': {
          hazard.x += hazard.vx * dt;
          hazard.y += hazard.vy * dt;
          hazard.depth += hazard.vDepth * dt;
          // §4.3: collide at `hitDepth` for `round(10 × radius)`; never split.
          if (hazard.depth <= RAIL.hitDepth && ship.alive && Math.hypot(hazard.x - ship.x, hazard.y - ship.y) < hazard.radius + SHIP_RADIUS) {
            this.#burst(hazard.x, hazard.y, hazard.depth, hazard.radius);
            const damage = Math.round(10 * hazard.radius);
            const from = { x: hazard.x, y: hazard.y };
            this.hazards.free(i);
            this.hit(damage, 'asteroid', { kind: 'asteroid' }, from);
            continue;
          }
          if (hazard.depth < -5) this.hazards.free(i); // passed — removed silently
          continue;
        }
      }
    }
  }

  /**
   * SPEC-041 §4.8: fire every round of `fighter`'s burst that is due — while
   * `burstLeft > 0` and the clock has reached `burstAt` — round `k` with
   * `FIGHTER_BURST.leads[k]`, each `interval` after the last.
   */
  #fireBurst(fighter: Hazard): void {
    let left = fighter.burstLeft ?? 0;
    let at = fighter.burstAt ?? 0;
    while (left > 0 && this.#time >= at && this.ship.alive) {
      this.#fireEnemyShot(fighter, FIGHTER_BURST.rounds - left);
      left--;
      at += FIGHTER_BURST.interval;
    }
    fighter.burstLeft = left;
    fighter.burstAt = at;
  }

  /**
   * Round `k` of a burst (§4.8): it flies at −45 m/s in depth toward
   * `burstAim` — where the ship will be when it arrives if it keeps
   * `leads[k]` of its lateral velocity, 1 being a perfect lead on a steady
   * drift and 0 its current position — and deals
   * `round(damage × FIGHTER_BURST.damageMult)`.
   */
  #fireEnemyShot(fighter: Hazard, k: number): void {
    const shot = this.hazards.alloc();
    shot.kind = 'enemy_shot';
    shot.id = this.#nextId++;
    shot.def = fighter.def;
    shot.elite = false;
    shot.x = fighter.x;
    shot.y = fighter.y;
    shot.depth = fighter.depth;
    shot.radius = ENEMY_SHOT_RADIUS;
    shot.hp = 1;
    const eta = enemyShotEta(fighter.depth);
    const aim = this.#aim;
    burstAim(k, fighter.depth, this.ship, aim);
    shot.vDepth = ENEMY_SHOT_VDEPTH;
    shot.vx = (aim.x - fighter.x) / eta;
    shot.vy = (aim.y - fighter.y) / eta;
    shot.shotDamage = Math.round((fighter.def?.damage ?? 10) * FIGHTER_BURST.damageMult);
    shot.hitFlash = 0;
    shot.ttl = undefined;
    shot.fireCooldown = undefined;
    shot.pattern = undefined;
    shot.holdDepth = undefined;
    shot.burstLeft = undefined;
    shot.burstAt = undefined;
  }

  // ----------------------------------------------------------- damage & storm

  /**
   * SPEC-038 §4.6: a difficulty changed in Settings mid-trip reaches the next
   * hit — the scene calls this when it resumes from its pause menu (38-g).
   * SPEC-043 §4.4: the multiplier is the difficulty's `enemyDamageMult` — 0.7,
   * 1 or 1.3, and 0 on story (SPEC-059 §4.2.2); flight enemies keep their HP
   * on every difficulty. SPEC-058 §4.4:
   * times the containment of the save's iteration (×1.15 a step, 1 on a first
   * run); the iteration never changes mid-trip, so the scene passes the same
   * one on every call.
   */
  setDifficulty(difficulty: Difficulty, iteration = 1): void {
    this.#damageMult = DIFFICULTY_RULES[difficulty].enemyDamageMult * containment(iteration).damageMult;
  }

  /**
   * §4.6: shield first, remainder to hull; ×0.7 on casual and ×1.3 on hard
   * (SPEC-043 §4.4); three seconds of no regen. Public — the storm tick and
   * the tests route through the same door. SPEC-059 §4.2.2: a hit worth
   * nothing (story's multiplier is 0) changes nothing and emits nothing, so
   * damage never recalls the ship.
   * SPEC-075 §4.4: `from` — where it struck, on the steering plane — rides
   * the event for the HUD's hit wedge.
   */
  hit(amount: number, source: 'asteroid' | 'enemy' | 'storm', cause: DamageSource, from?: { x: number; y: number }): void {
    const ship = this.ship;
    if (!ship.alive || amount <= 0) return;
    let damage = amount * this.#damageMult;
    if (damage <= 0) return;
    if (ship.shield > 0) {
      const absorbed = Math.min(ship.shield, damage);
      ship.shield -= absorbed;
      damage -= absorbed;
    }
    if (damage > 0) ship.hull = Math.max(0, ship.hull - damage);
    ship.shieldRegenAt = this.#time + TUNING.SHIELD_REGEN_DELAY;
    this.#events.emit('ship:damaged', from === undefined ? { shield: ship.shield, hull: ship.hull, source } : { shield: ship.shield, hull: ship.hull, source, from });
    if (ship.hull > 0) return;
    // §4.1: hull 0 → recall. Fuel stays spent, cargo stays aboard (E5); the
    // scene holds the explosion for 1.5 s before the station.
    ship.alive = false;
    this.#phase = 'recalled';
    this.#recallCause = 'hull';
    this.lead.active = false; // the trip is over: nothing left to lead
    this.lock.active = false;
    this.missiles.clear(); // SPEC-070 70-g: removed without effect
    this.#burst(ship.x, ship.y, 0, 4);
    this.#events.emit('player:died', { cause, scene: 'flight' });
    this.#events.emit('flight:recalled', { planet: this.#cfg.planet.id, cause: 'hull' });
    this.#missions.resetStages('death');
  }

  #updateStorm(dt: number): void {
    if (!this.#cfg.planet.flight.ionStorm) return;
    this.#stormClock += dt;
    if (!this.#stormActive) {
      if (this.#stormClock >= this.#stormEdgeAt) {
        this.#stormActive = true;
        this.#stormTick = 0;
        this.#stormEdgeAt = this.#stormClock + this.#stormRng.float(STORM_LENGTH[0], STORM_LENGTH[1]);
      }
      return;
    }
    if (this.#stormClock >= this.#stormEdgeAt) {
      this.#stormActive = false;
      this.#stormEdgeAt = this.#stormClock + this.#stormRng.float(STORM_GAP[0], STORM_GAP[1]);
      return;
    }
    // §4.5: 1 hull per 5 s while the shield is down. Weather resist does not
    // apply — this is the ship's problem, not the suit's.
    if (this.ship.shield <= 0) {
      this.#stormTick += dt;
      while (this.#stormTick >= STORM_TICK_SECONDS && this.ship.alive) {
        this.#stormTick -= STORM_TICK_SECONDS;
        this.hit(1, 'storm', { kind: 'storm' });
      }
    } else {
      this.#stormTick = 0;
    }
  }

  #regenShield(dt: number): void {
    const ship = this.ship;
    if (!ship.alive || ship.shield >= ship.maxShield) return;
    // §4.6: ARIA only, three seconds after the last hit, never in a storm.
    if (this.#ariaShieldRegen <= 0 || this.#stormActive || this.#time < ship.shieldRegenAt) return;
    ship.shield = Math.min(ship.maxShield, ship.shield + this.#ariaShieldRegen * dt);
  }

  // ------------------------------------------------------------------ arrival

  #waveClear(): boolean {
    for (const group of this.#groups) if (!group.spawned) return false;
    for (let i = 0; i < this.hazards.size; i++) {
      const kind = this.hazards.at(i).kind;
      if (kind === 'fighter' || kind === 'interceptor') return false;
    }
    return true;
  }

  /**
   * §4.1 / E12: the landing gate. The arrival wave has to be down *and* an
   * accepted main flight mission has to be finished — the trip is that mission
   * (PLAN R16), and on an upgraded engine the trip is far shorter than
   * `c5_m1`'s 180 s survive, so without this the Hive is landed on with the
   * gauntlet unfinished and every mission there still locked. A **side**
   * mission never holds a landing: it stays accepted for the next trip. The
   * 90 s holding cap above keeps the hold from becoming a softlock.
   */
  #clearToLand(): boolean {
    if (!this.#waveClear()) return false;
    // SPEC-069 §4.3, E134: the landing wants the ship on approach.
    if (!this.onApproach) return false;
    const active = this.#missions.active; // the scene's own list — no copy, no iterator
    for (let i = 0; i < active.length; i++) {
      const state = active[i];
      if (state !== undefined && MISSIONS[state.id].type === 'main') return false;
    }
    return true;
  }

  #arrive(): void {
    this.#phase = 'arrived';
    this.lead.active = false;
    this.lock.active = false;
    this.missiles.clear(); // SPEC-070 70-g
    this.#events.emit('flight:arrived', { planet: this.#cfg.planet.id });
  }

  #burst(x: number, y: number, depth: number, size: number): void {
    const burst = this.bursts.alloc();
    burst.x = x;
    burst.y = y;
    burst.depth = depth;
    burst.size = size;
  }
}
