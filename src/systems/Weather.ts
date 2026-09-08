// The weather runtime (SPEC-012 §4.6). Pure: a state machine over the planet's
// cycle driven by a visit-stream RNG, so a seeded test can walk the phases.
//
// calm(random calmSeconds) → warning (10 s, `weather:warning`) → active (random
// stormSeconds, `weather:changed`) → calm. `force()` skips the warning for a
// survive stage; `suppress(true)` ends the storm now and pauses the cycle for
// a boss arena (E15). The avalanche's DPS runs in bursts — 10 s on, 20 s off —
// which lives here as `dps` so the effects table stays a constant.
import type { EventBus, GameEvents } from '@/core/Events';
import type { Rng } from '@/core/Rng';
import { TUNING, type PlanetDef, type WeatherId } from '@/data/index';

export type WeatherPhase = 'calm' | 'warning' | 'active';

export interface WeatherEffects {
  fogMult: number;
  moveMult: number;
  dps: number;
  visibility: number;
  particles: 'sand' | 'snow' | 'spores' | 'ash' | 'heat' | 'none';
}

/** §4.6 — the effects table, verbatim. */
export const WEATHER_EFFECTS: Record<WeatherId, WeatherEffects> = {
  sandstorm: { fogMult: 3.0, moveMult: 0.8, dps: 0, visibility: 0.4, particles: 'sand' },
  heatwave: { fogMult: 1.2, moveMult: 0.9, dps: 2, visibility: 0.9, particles: 'heat' },
  blizzard: { fogMult: 3.5, moveMult: 0.75, dps: 1, visibility: 0.35, particles: 'snow' },
  avalanche: { fogMult: 1.5, moveMult: 0.7, dps: 4, visibility: 0.7, particles: 'snow' },
  spore_storm: { fogMult: 2.5, moveMult: 0.85, dps: 2, visibility: 0.5, particles: 'spores' },
  radiation_storm: { fogMult: 1.8, moveMult: 0.9, dps: 4, visibility: 0.7, particles: 'ash' },
};

/** Calm weather, for the scene's lerp targets when nothing is active. */
export const CALM_EFFECTS: WeatherEffects = {
  fogMult: 1,
  moveMult: 1,
  dps: 0,
  visibility: 1,
  particles: 'none',
};

/** §4.6: the avalanche's burst pattern — damage 10 s on, 20 s off, repeating. */
export const BURST_ON_SECONDS = 10;
export const BURST_OFF_SECONDS = 20;

export class Weather {
  readonly #cycle: PlanetDef['surface']['weather'];
  readonly #rng: Rng;
  readonly #events: EventBus<GameEvents>;

  #phase: WeatherPhase = 'calm';
  #current: WeatherId | null = null;
  /** The storm the warning announced, which `active` then starts. */
  #pending: WeatherId | null = null;
  /** Seconds left in the current phase. */
  #left = 0;
  /** Seconds the current storm has been active, for the burst pattern. */
  #activeFor = 0;
  #suppressed = false;

  constructor(planet: PlanetDef, rng: Rng, events: EventBus<GameEvents>) {
    this.#cycle = planet.surface.weather;
    this.#rng = rng;
    this.#events = events;
    this.#left = this.#rollCalm();
  }

  get phase(): WeatherPhase {
    return this.#phase;
  }

  get current(): WeatherId | null {
    return this.#current;
  }

  /** The storm a warning announced, for the HUD banner. */
  get pending(): WeatherId | null {
    return this.#pending;
  }

  /** Seconds left in the current phase — the banner's countdown (§4.12). */
  get secondsLeft(): number {
    return Math.max(0, this.#left);
  }

  /** The active storm's table row, or calm — what the scene lerps toward. */
  get effects(): WeatherEffects {
    return this.#current === null ? CALM_EFFECTS : WEATHER_EFFECTS[this.#current];
  }

  /**
   * The damage per second applying *right now*: the table value, gated by the
   * avalanche's 10 s on / 20 s off bursts. This is the number the scene feeds
   * `combat.damagePlayer` — `effects.dps` stays the table constant.
   */
  get dps(): number {
    const effects = this.effects;
    if (this.#current !== 'avalanche') return effects.dps;
    return this.#activeFor % (BURST_ON_SECONDS + BURST_OFF_SECONDS) < BURST_ON_SECONDS ? effects.dps : 0;
  }

  update(dt: number): void {
    if (this.#suppressed) return; // E15: the cycle is paused, not running down
    if (this.#phase === 'active') this.#activeFor += dt;
    this.#left -= dt;
    if (this.#left > 0) return;
    switch (this.#phase) {
      case 'calm': {
        if (this.#cycle === null || this.#cycle.cycle.length === 0) {
          this.#left = Infinity; // a weatherless planet stays calm forever
          return;
        }
        this.#pending = this.#rng.pick(this.#cycle.cycle);
        this.#phase = 'warning';
        this.#left = TUNING.STORM_WARNING_SECONDS;
        this.#events.emit('weather:warning', { weather: this.#pending, inSeconds: TUNING.STORM_WARNING_SECONDS });
        return;
      }
      case 'warning': {
        this.#begin(this.#pending as WeatherId, this.#rollStorm());
        return;
      }
      case 'active': {
        this.#end();
        return;
      }
    }
  }

  /** §4.6: a survive stage's storm — immediately active for `seconds`, no warning. */
  force(weather: WeatherId, seconds: number): void {
    if (this.#suppressed) return; // a boss arena outranks a forced storm (E15)
    this.#begin(weather, seconds);
  }

  /** E15: `true` ends the storm now and pauses the cycle; `false` resumes it. */
  suppress(on: boolean): void {
    if (on === this.#suppressed) return;
    this.#suppressed = on;
    if (on) {
      if (this.#phase !== 'calm') this.#end();
    }
    // Resuming picks up the calm countdown where the suppression left it.
  }

  #begin(weather: WeatherId, seconds: number): void {
    this.#phase = 'active';
    this.#current = weather;
    this.#pending = null;
    this.#left = seconds;
    this.#activeFor = 0;
    this.#events.emit('weather:changed', { weather });
  }

  #end(): void {
    const wasActive = this.#current !== null;
    this.#phase = 'calm';
    this.#current = null;
    this.#pending = null;
    this.#activeFor = 0;
    this.#left = this.#rollCalm();
    if (wasActive) this.#events.emit('weather:changed', { weather: null });
  }

  #rollCalm(): number {
    if (this.#cycle === null) return Infinity;
    return this.#rng.float(this.#cycle.calmSeconds[0], this.#cycle.calmSeconds[1]);
  }

  #rollStorm(): number {
    if (this.#cycle === null) return 0;
    return this.#rng.float(this.#cycle.stormSeconds[0], this.#cycle.stormSeconds[1]);
  }
}
