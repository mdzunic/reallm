// The rail flight model (SPEC-013 §3–§4.8): constant forward motion, lateral
// steering on a bounded XY plane, hazards approaching along depth, shields and
// hull, ship weapons with aim assist, throttle-scaled waves, ion storms, the
// arrival rule with its 90 s holding cap, and recall on death.
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
import type { SaveV1 } from '@/core/Save';
import {
  COMPANIONS,
  ENEMIES,
  TUNING,
  UPGRADES,
  WAVES,
  type CompanionEffect,
  type DamageSource,
  type EnemyDef,
  type EnemyId,
  type PlanetDef,
} from '@/data/index';
import type { Economy } from '@/systems/Economy';
import type { Missions } from '@/systems/Missions';
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
}

export interface Hazard {
  kind: 'asteroid' | 'fighter' | 'interceptor' | 'enemy_shot';
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

export interface FlightConfig {
  planet: PlanetDef;
  ship: SaveV1['ship'];
  companions: SaveV1['companions'];
  quality: QualitySettings;
  /** Casual multiplies incoming damage by 0.7 (§4.6, 13-h). */
  difficulty: SaveV1['meta']['difficulty'];
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
  /** `settings.flightMouseSteer`: steer = clamp((reticle − ship) / 4) (§4.2). */
  mouseSteer?: boolean;
}

export type FlightPhase = 'launch' | 'cruise' | 'holding' | 'arrived' | 'recalled';

// ------------------------------------------------------------------- constants

export const PLANE = { halfW: 12, halfH: 7 } as const;
export const RAIL = { baseSpeed: 60, lateralSpeed: 14, lateralAccel: 40, spawnDepth: 220, hitDepth: 2.5, laserSpeed: 120 } as const;

/** The launch phase: cockpit shake, no hazards, HUD boot (§4.1). */
export const LAUNCH_SECONDS = 3;
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
/** The asteroid threat box around the ship: 70 % of spawns land inside (§4.3). */
export const THREAT_BOX = 6;
const THREAT_BOX_CHANCE = 0.7;
/** ARIA L2+ aim assist: cone half-angle and reticle chase rate (§4.7). */
export const ASSIST_CONE_DEG = 6;
const ASSIST_LERP_PER_S = 20;
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
const ENEMY_SHOT_VDEPTH = -45;
const ENEMY_SHOT_RADIUS = 0.4;
/** Ion storms: window and gap bounds, and the hull tick while shields are down (§4.5). */
const STORM_LENGTH: readonly [number, number] = [15, 25];
const STORM_GAP: readonly [number, number] = [40, 70];
const STORM_TICK_SECONDS = 5;
const CASUAL_DAMAGE_MULT = 0.7;

const DEG_TO_RAD = Math.PI / 180;
const ASSIST_CONE_COS = Math.cos(ASSIST_CONE_DEG * DEG_TO_RAD);

/** One scheduled wave group; `frac` is its place in the trip (§4.4). */
interface WaveGroup {
  enemy: EnemyId;
  count: number;
  frac: number;
  spawned: boolean;
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

export class Flight {
  readonly ship: ShipState;
  readonly hazards = new Pool<Hazard>(() => ({ kind: 'asteroid', x: 0, y: 0, depth: 0, vx: 0, vy: 0, vDepth: 0, radius: 1, hp: 1 }));
  readonly shots = new Pool<Shot>(() => ({ x: 0, y: 0, depth: 0, vDepth: 0, damage: 0, vx: 0, vy: 0 }));
  /** Explosion bursts since the view last drained; the scene calls `bursts.clear()`. */
  readonly bursts = new Pool<Burst>(() => ({ x: 0, y: 0, depth: 0, size: 1 }));
  /** Where the shots actually go: the raw aim, or the assist's captured target (§4.7). */
  readonly reticle = { x: 0, y: 0 };

  readonly economy: Economy;
  readonly #progression: Progression;
  readonly #missions: Missions;
  readonly #events: FlightEvents;
  readonly #rng: Rng;
  readonly #stormRng: Rng;
  readonly #cfg: FlightConfig;

  readonly #speedMult: number;
  readonly #ariaShieldRegen: number;
  readonly #ariaAutoAim: boolean;
  readonly #damageMult: number;
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

  constructor(cfg: FlightConfig, economy: Economy, progression: Progression, missions: Missions, events: FlightEvents, rng: Rng) {
    this.#cfg = cfg;
    this.economy = economy;
    this.#progression = progression;
    this.#missions = missions;
    this.#events = events;
    this.#rng = rng;
    this.#stormRng = rng.fork('storm');
    this.#stormEdgeAt = this.#stormRng.float(STORM_GAP[0], STORM_GAP[1]);

    this.#speedMult = UPGRADES.engine.metrics['speedMult']?.[cfg.ship.engine] ?? 1;
    const aria = cfg.companions.find((entry) => entry.id === 'aria' && entry.enabled);
    // Through `CompanionEffect` (all keys optional) — the literal union of the
    // ARIA rows only carries a key on the levels that grant it.
    const effect: CompanionEffect | undefined = aria === undefined ? undefined : COMPANIONS.aria.levels[aria.level - 1];
    // §4.6: shield regen comes only from ARIA — disabled means none at all.
    this.#ariaShieldRegen = effect?.shieldRegen ?? 0;
    this.#ariaAutoAim = effect?.autoAim ?? false;
    const hullBonus = effect?.hullBonus ?? 0;
    this.#damageMult = cfg.difficulty === 'casual' ? CASUAL_DAMAGE_MULT : 1;
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

  /** Live enemy ships — the HUD's "hostiles: n" (§4.10). */
  get hostiles(): number {
    let count = 0;
    for (let i = 0; i < this.hazards.size; i++) {
      const kind = this.hazards.at(i).kind;
      if (kind === 'fighter' || kind === 'interceptor') count++;
    }
    return count;
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
      if (this.#launchT >= LAUNCH_SECONDS) this.#phase = 'cruise';
      return; // §4.1: no hazards, no weapons, no storms during launch
    }

    if (this.#phase === 'cruise') {
      this.#covered += dt * this.#speedMult * this.#throttleLive;
      if (this.progress >= 1) {
        // §4.1: every group spawned and no wave enemy alive → arrived, else hold.
        if (this.#waveClear()) {
          this.#arrive();
          return;
        }
        this.#phase = 'holding';
      }
    } else {
      // holding: asteroids stop spawning; after the cap, land anyway (E12).
      this.#holdT += dt;
      if (this.#waveClear() || this.#holdT >= TUNING.HOLD_PATTERN_MAX_SECONDS) {
        this.#arrive();
        return;
      }
    }

    const coneTarget = this.#updateReticle(dt, input);
    this.#steer(dt, input); // after the reticle, so mouse steer chases this frame's
    this.#updateWeapons(dt, input, coneTarget);
    this.#updateShots(dt);
    if (this.#phase === 'cruise') this.#spawn(dt);
    this.#updateHazards(dt);
    if (!this.ship.alive) return; // a ram or a collision above may have ended the trip
    this.#updateStorm(dt);
    if (!this.ship.alive) return;
    this.#regenShield(dt);
    // §4.8: survive timers are real seconds while alive — cruise and holding.
    this.#missions.update(dt);
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
      for (let i = 0; i < this.hazards.size; i++) {
        const hazard = this.hazards.at(i);
        if (hazard.kind === 'asteroid' || hazard.kind === 'enemy_shot') hazard.vDepth *= factor;
      }
    }
  }

  #steer(dt: number, input: FlightInput): void {
    const ship = this.ship;
    if (!ship.alive) return;
    let steerX: number;
    let steerY: number;
    if (input.mouseSteer === true) {
      // §4.2: mouse steer chases the reticle: clamp((reticle − ship) / 4).
      steerX = clamp((this.reticle.x - ship.x) / 4, -1, 1);
      steerY = clamp((this.reticle.y - ship.y) / 4, -1, 1);
    } else {
      steerX = clamp(input.steerX, -1, 1);
      steerY = clamp(input.steerY, -1, 1);
    }
    const damping = Math.exp(-6 * dt);
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
    // §4.2: clamped to the plane with a soft bounce (velocity × −0.3).
    if (ship.x > PLANE.halfW) {
      ship.x = PLANE.halfW;
      ship.vx *= -0.3;
    } else if (ship.x < -PLANE.halfW) {
      ship.x = -PLANE.halfW;
      ship.vx *= -0.3;
    }
    if (ship.y > PLANE.halfH) {
      ship.y = PLANE.halfH;
      ship.vy *= -0.3;
    } else if (ship.y < -PLANE.halfH) {
      ship.y = -PLANE.halfH;
      ship.vy *= -0.3;
    }
    ship.bank = (-ship.vx / RAIL.lateralSpeed) * 35;
  }

  // ----------------------------------------------------------- reticle & guns

  /**
   * §4.7: the raw aim owns the reticle until an enemy ship sits inside the 6°
   * cone; then ARIA L2+ chases it at 20/s. Returns the cone target (or null) —
   * auto-fire keys off it whether or not the assist is bought (AC-32).
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
    if (target !== null && this.#ariaAutoAim) {
      // Snap to the target's projection at the convergence depth.
      const scale = CONVERGE_DEPTH / target.depth;
      const tx = ship.x + (target.x - ship.x) * scale;
      const ty = ship.y + (target.y - ship.y) * scale;
      const chase = Math.min(1, ASSIST_LERP_PER_S * dt);
      this.reticle.x += (tx - this.reticle.x) * chase;
      this.reticle.y += (ty - this.reticle.y) * chase;
    } else {
      this.reticle.x = input.aimX;
      this.reticle.y = input.aimY;
    }
    return target;
  }

  #updateWeapons(dt: number, input: FlightInput, coneTarget: Hazard | null): void {
    const ship = this.ship;
    ship.fireCooldown = Math.max(0, ship.fireCooldown - dt);
    if (!ship.alive) return;
    const wantsFire = input.fire || (input.autoFire === true && (coneTarget !== null || this.#asteroidNear()));
    if (!wantsFire || ship.fireCooldown > 0) return;
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
    ship.fireCooldown = 1 / fireRate;
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
        if (hazard.depth < from || hazard.depth > to) continue;
        const at = (hazard.depth - from) / (to - from);
        const sx = shot.x + shot.vx * dt * at;
        const sy = shot.y + shot.vy * dt * at;
        if (Math.hypot(sx - hazard.x, sy - hazard.y) >= hazard.radius + 0.3) continue;
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
    if (hazard.hp > 0) return;
    this.#burst(hazard.x, hazard.y, hazard.depth, hazard.radius);
    const def = hazard.def;
    if ((hazard.kind === 'fighter' || hazard.kind === 'interceptor') && def !== undefined) {
      // §4.4: kills pay XP and the event missions count.
      this.#events.emit('enemy:killed', { enemyId: def.id as EnemyId, elite: false, x: hazard.x, z: hazard.depth, xp: def.xp });
      this.#progression.addXp(def.xp, 'flight');
    }
    this.hazards.free(index);
  }

  // ------------------------------------------------------------------- spawns

  #spawn(dt: number): void {
    // §4.3: Poisson at `asteroidDensity × throttle` per second, capped per preset.
    const rate = this.#cfg.planet.flight.asteroidDensity * this.#throttleLive;
    if (this.#rng.next() < rate * dt && this.#asteroidCount() < this.#asteroidCap) this.spawnAsteroid();
    // §4.4: wave groups fire at their trip fraction — throttle-scaled seconds.
    for (const group of this.#groups) {
      if (group.spawned || this.progress < group.frac) continue;
      group.spawned = true;
      for (let i = 0; i < group.count; i++) this.#spawnShip(group.enemy);
    }
  }

  #asteroidCount(): number {
    let count = 0;
    for (let i = 0; i < this.hazards.size; i++) if (this.hazards.at(i).kind === 'asteroid') count++;
    return count;
  }

  /**
   * §4.3: 70 % inside the threat box around the ship, else uniform on the
   * plane. Public so the spawn-bias test can draw 1,000 without flying a trip.
   */
  spawnAsteroid(): Hazard {
    const rng = this.#rng;
    const hazard = this.hazards.alloc();
    hazard.kind = 'asteroid';
    if (rng.chance(THREAT_BOX_CHANCE)) {
      hazard.x = this.ship.x + rng.float(-THREAT_BOX, THREAT_BOX);
      hazard.y = this.ship.y + rng.float(-THREAT_BOX, THREAT_BOX);
    } else {
      hazard.x = rng.float(-PLANE.halfW, PLANE.halfW);
      hazard.y = rng.float(-PLANE.halfH, PLANE.halfH);
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
    return hazard;
  }

  #spawnShip(enemyId: EnemyId): void {
    const def = ENEMIES[enemyId];
    const rng = this.#rng;
    const hazard = this.hazards.alloc();
    hazard.def = def;
    hazard.elite = false; // §4.4: no elites in flight
    hazard.radius = def.radius;
    hazard.hp = def.hp;
    hazard.x = rng.float(-PLANE.halfW, PLANE.halfW);
    hazard.y = rng.float(-PLANE.halfH, PLANE.halfH);
    hazard.vx = 0;
    hazard.vy = 0;
    hazard.fireCooldown = undefined;
    hazard.ttl = undefined;
    hazard.holdDepth = undefined;
    if (def.archetype === 'interceptor') {
      hazard.kind = 'interceptor';
      hazard.depth = INTERCEPTOR_ENTER_DEPTH;
      hazard.pattern = 0; // not yet re-aimed
      this.#aimDive(hazard);
      return;
    }
    hazard.kind = 'fighter';
    hazard.depth = FIGHTER_ENTER_DEPTH;
    hazard.vDepth = -FIGHTER_APPROACH;
    hazard.holdDepth = rng.float(FIGHTER_HOLD_MIN, FIGHTER_HOLD_MAX);
    hazard.ttl = FIGHTER_LEAVE_SECONDS;
    hazard.pattern = rng.angle();
    hazard.fireCooldown = def.attack.kind === 'ranged' ? def.attack.cooldown : 2;
  }

  /** §4.4: straight at the ship's position, sampled now; `vDepth` stays the dive. */
  #aimDive(hazard: Hazard): void {
    const eta = (hazard.depth - RAIL.hitDepth) / INTERCEPTOR_DIVE;
    hazard.vDepth = -INTERCEPTOR_DIVE;
    hazard.vx = (this.ship.x - hazard.x) / eta;
    hazard.vy = (this.ship.y - hazard.y) / eta;
  }

  // ------------------------------------------------------------------ hazards

  #updateHazards(dt: number): void {
    const ship = this.ship;
    for (let i = this.hazards.size - 1; i >= 0; i--) {
      const hazard = this.hazards.at(i);
      switch (hazard.kind) {
        case 'fighter': {
          hazard.ttl = (hazard.ttl ?? 0) - dt;
          if (hazard.ttl <= 0) {
            this.hazards.free(i); // §4.4: leaves alive — not killed, no event
            continue;
          }
          const hold = hazard.holdDepth ?? FIGHTER_HOLD_MIN;
          if (hazard.depth > hold) {
            hazard.vDepth = -FIGHTER_APPROACH;
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
              this.#fireEnemyShot(hazard);
              hazard.fireCooldown = def?.attack.kind === 'ranged' ? def.attack.cooldown : 2;
            }
          }
          hazard.x = clamp(hazard.x + hazard.vx * dt, -PLANE.halfW, PLANE.halfW);
          hazard.y = clamp(hazard.y + hazard.vy * dt, -PLANE.halfH, PLANE.halfH);
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
            this.hazards.free(i);
            // §4.4: the ram costs `def.damage` and the interceptor with it.
            this.hit(def?.damage ?? 12, 'enemy', def === undefined ? { kind: 'asteroid' } : { kind: 'enemy', enemyId: def.id as EnemyId });
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
            this.hazards.free(i);
            this.hit(def?.damage ?? 10, 'enemy', def === undefined ? { kind: 'asteroid' } : { kind: 'projectile', enemyId: def.id as EnemyId });
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
            this.hazards.free(i);
            this.hit(damage, 'asteroid', { kind: 'asteroid' });
            continue;
          }
          if (hazard.depth < -5) this.hazards.free(i); // passed — removed silently
          continue;
        }
      }
    }
  }

  #fireEnemyShot(fighter: Hazard): void {
    const shot = this.hazards.alloc();
    shot.kind = 'enemy_shot';
    shot.def = fighter.def;
    shot.elite = false;
    shot.x = fighter.x;
    shot.y = fighter.y;
    shot.depth = fighter.depth;
    shot.radius = ENEMY_SHOT_RADIUS;
    shot.hp = 1;
    // §4.4: aimed at the ship's *current* position — lead it and it misses.
    const eta = (fighter.depth - RAIL.hitDepth) / -ENEMY_SHOT_VDEPTH;
    shot.vDepth = ENEMY_SHOT_VDEPTH;
    shot.vx = (this.ship.x - fighter.x) / eta;
    shot.vy = (this.ship.y - fighter.y) / eta;
    shot.ttl = undefined;
    shot.fireCooldown = undefined;
    shot.pattern = undefined;
    shot.holdDepth = undefined;
  }

  // ----------------------------------------------------------- damage & storm

  /**
   * §4.6: shield first, remainder to hull; casual ×0.7; three seconds of no
   * regen. Public — the storm tick and the tests route through the same door.
   */
  hit(amount: number, source: 'asteroid' | 'enemy' | 'storm', cause: DamageSource): void {
    const ship = this.ship;
    if (!ship.alive || amount <= 0) return;
    let damage = amount * this.#damageMult;
    if (ship.shield > 0) {
      const absorbed = Math.min(ship.shield, damage);
      ship.shield -= absorbed;
      damage -= absorbed;
    }
    if (damage > 0) ship.hull = Math.max(0, ship.hull - damage);
    ship.shieldRegenAt = this.#time + TUNING.SHIELD_REGEN_DELAY;
    this.#events.emit('ship:damaged', { shield: ship.shield, hull: ship.hull, source });
    if (ship.hull > 0) return;
    // §4.1: hull 0 → recall. Fuel stays spent, cargo stays aboard (E5); the
    // scene holds the explosion for 1.5 s before the station.
    ship.alive = false;
    this.#phase = 'recalled';
    this.#burst(ship.x, ship.y, 0, 4);
    this.#events.emit('player:died', { cause, scene: 'flight' });
    this.#events.emit('flight:recalled', { planet: this.#cfg.planet.id });
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

  #arrive(): void {
    this.#phase = 'arrived';
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
