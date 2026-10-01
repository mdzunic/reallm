// The vibration layer (SPEC-042 §4.10). A phone in the hand feels the hits, a
// weapon lock, a death and a completion: each event of `HAPTIC_TABLE` names a
// pattern, and `Haptics` sends it through `navigator.vibrate` — on the touch
// scheme only, with `settings.haptics` on, and never where the API is missing.
// Desktop Chrome has the API and no motor, and a laptop's touch screen is not
// held, so the scheme is the gate rather than the API (42-n).
//
// It lives in `core/` beside `AudioReactions`, its sound-side twin: no DOM, no
// `systems/`. `navigator.vibrate` arrives as a function the composition root
// wraps, so the node suite drives the whole thing with a fake and a clock.
import type { EventBus, GameEvents, Unsubscribe } from '@/core/Events';
import type { Scheme } from '@/core/Input';
import type { Settings } from '@/core/Settings';
import { ENEMIES, type DamageSource } from '@/data/index';

/** One pulse in milliseconds, or an on/off/on… sequence. */
export type HapticPattern = number | readonly number[];

/** The events that can vibrate. */
export type HapticEvent =
  | 'player:damaged'
  | 'ship:damaged'
  | 'weapon:locked'
  | 'player:died'
  | 'quick:used'
  | 'mission:completed'
  | 'boss:phase';

/** An enemy or its shot, when that enemy is a boss. */
function fromBoss(source: DamageSource): boolean {
  return (source.kind === 'enemy' || source.kind === 'projectile') && ENEMIES[source.enemyId].archetype === 'boss';
}

/**
 * §4.10 — what each event feels like (*initial tuning*); `null` is no pulse.
 * Weather never pulses (42-o): a storm ticks every step on the surface and
 * every few tenths of a second in flight, and the vignette and the number
 * already say it — so `ship:damaged` from the ion storm, the ship's weather,
 * is as still as the suit's.
 */
export const HAPTIC_TABLE: { readonly [K in HapticEvent]: (p: GameEvents[K]) => HapticPattern | null } = {
  'player:damaged': (p) => (p.source.kind === 'weather' ? null : fromBoss(p.source) ? 30 : 15),
  'ship:damaged': (p) => (p.source === 'storm' ? null : p.shield > 0 ? 15 : 25),
  'weapon:locked': () => [12, 40, 12],
  'player:died': () => 60,
  'quick:used': () => 8,
  'mission:completed': () => [20, 60, 20],
  'boss:phase': () => [30, 50, 30],
};

/** §4.10: at most this many pulses in any 1000 ms. */
export const HAPTIC_MAX_PER_SECOND = 4;

/** The two moments that always get through the per-second cap. */
export const HAPTIC_ALWAYS: ReadonlySet<HapticEvent> = new Set<HapticEvent>(['player:died', 'mission:completed']);

const WINDOW_MS = 1000;
const HAPTIC_EVENTS = Object.keys(HAPTIC_TABLE) as HapticEvent[];

export interface HapticsDeps {
  events: Pick<EventBus<GameEvents>, 'on'>;
  settings: { get(): Readonly<Settings> };
  input: { readonly state: { readonly scheme: Scheme } };
  /** `(p) => navigator.vibrate(p)`, or null where the API is missing. */
  vibrate: ((pattern: number | number[]) => boolean) | null;
  /** Milliseconds. */
  now: () => number;
}

export class Haptics {
  readonly #deps: HapticsDeps;
  readonly #releases: Unsubscribe[] = [];
  /** When the last `HAPTIC_MAX_PER_SECOND` pulses went, as a ring; −∞ is never. */
  readonly #sentAt: number[] = Array.from({ length: HAPTIC_MAX_PER_SECOND }, () => -Infinity);
  /** The ring slot the next pulse writes — which also holds the oldest of them. */
  #ring = 0;

  constructor(deps: HapticsDeps) {
    this.#deps = deps;
    for (const event of HAPTIC_EVENTS) this.#subscribe(event);
  }

  dispose(): void {
    for (const release of this.#releases.splice(0)) release();
  }

  #subscribe<K extends HapticEvent>(event: K): void {
    const pattern = HAPTIC_TABLE[event] as (p: GameEvents[K]) => HapticPattern | null;
    this.#releases.push(this.#deps.events.on(event, (payload) => this.#pulse(event, pattern(payload)), this));
  }

  /** §4.10's gate: the setting, the scheme, the API, then the per-second cap. */
  #pulse(event: HapticEvent, pattern: HapticPattern | null): void {
    const vibrate = this.#deps.vibrate;
    if (pattern === null || vibrate === null) return;
    if (!this.#deps.settings.get().haptics || this.#deps.input.state.scheme !== 'touch') return;
    const now = this.#deps.now();
    // The ring's current slot holds the oldest of the last four pulses; a fifth
    // inside the window is refused unless the event always passes.
    if (now - (this.#sentAt[this.#ring] as number) < WINDOW_MS && !HAPTIC_ALWAYS.has(event)) return;
    this.#sentAt[this.#ring] = now;
    this.#ring = (this.#ring + 1) % HAPTIC_MAX_PER_SECOND;
    vibrate(pattern as number | number[]);
  }
}
