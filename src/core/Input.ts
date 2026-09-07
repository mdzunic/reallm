// The unified input system (SPEC-005). One action-level state object; every
// device writes into it through the driver API and nothing else. Scenes read
// `input.state` and never see a raw event, so one code path serves keyboard,
// mouse, touch and — later — a gamepad.
//
// Four properties the rest of the game leans on:
//   - edge detection is queue-based (§4.1, AC-2): a press and a release that
//     both land between two `beginFrame()` calls still produce `justPressed`
//     *and* `justReleased`, so a 30 fps sub-frame tap is never swallowed;
//   - `down` is live, not latched — it mirrors the set of sources holding the
//     action the moment they change (AC-22), which is what makes `releaseAll()`
//     and `setEnabled(false)` read as released immediately (AC-10, AC-21);
//   - every write carries the `Scheme` it came from, so the last-used device
//     owns the scheme (AC-19) and one action held by two devices only releases
//     when the last of them lets go (AC-22);
//   - nothing here needs a DOM. `new Input()` is a complete, testable input
//     system (AC-31); a canvas merely adds the keyboard/mouse driver.
//
// `core/` may not import `ui/` (SPEC-001 §4), so the touch layer imports the
// zone maths from here rather than the other way round.
import { KeyboardMouseDriver } from '@/core/KeyboardMouseDriver';
import { log } from '@/core/Log';
import type { EventBus } from '@/core/Services';
import type { AutoFireMode, SettingsStore } from '@/core/Settings';
import type { SceneId } from '@/core/StateMachine';

export type Action = 'fire' | 'interact' | 'useItem' | 'pause' | 'throttleUp' | 'throttleDown' | 'map' | 'debug';
export type Scheme = 'keyboard' | 'touch' | 'gamepad';
/** The four movement half-axes a key can bind to; they are not actions (AC-4). */
export type MoveAxis = 'moveUp' | 'moveDown' | 'moveLeft' | 'moveRight';
/** Surface plays with a joystick, flight with a steer zone (AC-27, AC-28). */
export type InputMode = 'surface' | 'flight';
/** Which half of the screen a touch pointer landed in (AC-30). */
export type TouchZone = 'move' | 'aim';

/** Iteration order for every per-action loop; the single list of actions (AC-1). */
export const ACTIONS = [
  'fire',
  'interact',
  'useItem',
  'pause',
  'throttleUp',
  'throttleDown',
  'map',
  'debug',
] as const satisfies readonly Action[];

// ------------------------------------------------------------------ tunables

/** Stick input below this magnitude reads as no input at all (AC-9). */
export const DEAD_ZONE = 0.15;
/** A pointer that never travels this far is a tap, not a drag (AC-12, AC-13). */
export const TAP_SLOP_PX = 12;
/** The move zone is the leading 45 % of the width on the surface (AC-11). */
export const MOVE_ZONE_FRACTION = 0.45;
/** …and the leading 60 % in flight, where the other 40 % is hold-to-fire (AC-28). */
export const FLIGHT_STEER_FRACTION = 0.6;
/** Full deflection at this many CSS px from the stick origin (initial tuning). */
export const JOYSTICK_RADIUS_PX = 56;
/** Past this multiple of the radius the origin follows the thumb (AC-11). */
export const FLOAT_DRIFT = 1.6;
/** The minimum hit size of a touch button, in CSS px (AC-16). */
export const TOUCH_BUTTON_PX = 56;
/** How far mouse aim pulls keyboard steering in flight (initial tuning, AC-29). */
export const FLIGHT_AIM_ASSIST = 0.35;

/** Only these two scenes are "gameplay" for the purposes of `preventDefault` (AC-6). */
export const GAMEPLAY_SCENES: readonly SceneId[] = ['surface', 'flight'];

// --------------------------------------------------------------------- state

export interface ButtonState {
  /** True while at least one source holds the action (AC-22). */
  down: boolean;
  justPressed: boolean;
  justReleased: boolean;
  /** Seconds held, summed from the `dt` given to `beginFrame` (AC-3). */
  heldFor: number;
}

export interface AimState {
  /** CSS px inside the canvas box. */
  screenX: number;
  screenY: number;
  /** Normalised device coordinates, y up (AC-24). */
  ndcX: number;
  ndcY: number;
  /** False until the first pointer move of the session (AC-24). */
  hasPointer: boolean;
  /** True while a touch aim-drag holds fire (AC-13). */
  dragging: boolean;
  /** The unit aim direction of that drag; y up. */
  dirX: number;
  dirY: number;
}

export interface InputState {
  /** Unit-clamped; `{x, y}` with y up — surface movement and flight steering. */
  move: { x: number; y: number };
  aim: AimState;
  buttons: Record<Action, ButtonState>;
  scheme: Scheme;
  autoFire: boolean;
}

/**
 * What `Input` needs back from a driver: drop the physical bookkeeping behind
 * an action, re-measure, and let go of the DOM. A structural port rather than
 * the concrete class, so the touch layer or a later gamepad driver can be owned
 * the same way (AC-32).
 */
export interface InputDriver {
  forget(): void;
  refresh(): void;
  dispose(): void;
}

/** One action's live bookkeeping: its public state, its holders and its pending edges. */
interface ActionTrack {
  readonly button: ButtonState;
  /** Every scheme currently holding the action; `down` is `size > 0` (AC-22). */
  readonly sources: Set<Scheme>;
  /** A 0 → 1 transition waiting for the next `beginFrame` (AC-2). */
  press: boolean;
  /** A 1 → 0 transition waiting for the next `beginFrame` (AC-2). */
  release: boolean;
}

/**
 * The zone a touch pointer belongs to (AC-30). Pure, so the mirrored layout is
 * testable without a DOM. `fraction` is the leading share of the width the move
 * zone takes: 0.45 on the surface, 0.6 in flight.
 */
export function zoneFor(
  x: number,
  width: number,
  side: 'left' | 'right',
  fraction: number = MOVE_ZONE_FRACTION,
): TouchZone {
  if (!(width > 0)) return 'aim';
  const cut = width * fraction;
  if (side === 'left') return x < cut ? 'move' : 'aim';
  return x >= width - cut ? 'move' : 'aim';
}

/**
 * Radial dead zone and unit clamp, applied to whatever the drivers summed
 * (AC-8, AC-9). Inside the dead zone the vector is dropped entirely; outside it
 * the magnitude is rescaled from the edge of the zone, so a stick does not jump
 * to 0.15 the moment it leaves it. A digital (1, 1) still lands on length 1.
 */
function shapeMove(x: number, y: number, out: { x: number; y: number }): void {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= DEAD_ZONE) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const scale = Math.min(1, (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE)) / magnitude;
  out.x = x * scale;
  out.y = y * scale;
}

function makeButtons(): Record<Action, ButtonState> {
  const buttons = {} as Record<Action, ButtonState>;
  for (const action of ACTIONS) buttons[action] = { down: false, justPressed: false, justReleased: false, heldFor: 0 };
  return buttons;
}

export class Input {
  readonly #track: Record<Action, ActionTrack>;
  readonly #state: InputState;
  readonly #events: EventBus | null;
  readonly #settings: SettingsStore | null;
  /** Every attached driver, whoever built it (see `useDriver`). */
  readonly #drivers: InputDriver[] = [];
  readonly #teardown: Array<() => void> = [];
  readonly #schemeListeners = new Set<(scheme: Scheme) => void>();
  /** Raw, unshaped move per source; the state's `move` is the shaped sum. */
  readonly #rawMove = new Map<Scheme, { x: number; y: number }>();

  #enabled = true;
  #mode: InputMode = 'surface';
  #gameplay = false;
  #width = 0;
  #height = 0;
  #disposed = false;

  /**
   * Every argument is optional: `new Input()` is the null input `Game` falls
   * back to and the object the unit tests drive (AC-31). A `canvas` attaches
   * the keyboard/mouse driver, a bus carries `input:schemeChanged` and the
   * scene/resize signals, and a settings store supplies the control options.
   */
  constructor(canvas?: HTMLCanvasElement | null, events?: EventBus | null, settings?: SettingsStore | null) {
    this.#events = events ?? null;
    this.#settings = settings ?? null;

    const track = {} as Record<Action, ActionTrack>;
    const buttons = makeButtons();
    for (const action of ACTIONS) {
      track[action] = { button: buttons[action], sources: new Set<Scheme>(), press: false, release: false };
    }
    this.#track = track;

    // `autoFire` is a getter rather than a cached flag: it is one comparison,
    // and it can never go stale against a settings change no event announced
    // (AC-18).
    const self = this;
    this.#state = {
      move: { x: 0, y: 0 },
      aim: { screenX: 0, screenY: 0, ndcX: 0, ndcY: 0, hasPointer: false, dragging: false, dirX: 0, dirY: 0 },
      buttons,
      scheme: 'keyboard',
      get autoFire(): boolean {
        return self.#computeAutoFire();
      },
    };

    this.#watchEvents();
    // The driver registers itself through `useDriver`, so an `Input` built
    // around a canvas and one built by a test around fake targets are owned the
    // same way.
    if (canvas) new KeyboardMouseDriver(this, { canvas });
  }

  /**
   * Adopt a driver: `releaseAll()` reaches its bookkeeping and `dispose()`
   * reaches its listeners (AC-32). Drivers call this from their constructor.
   */
  useDriver(driver: InputDriver): void {
    if (this.#drivers.includes(driver)) return;
    this.#drivers.push(driver);
  }

  // ------------------------------------------------------------------ reading

  get state(): Readonly<InputState> {
    return this.#state;
  }

  /** False while the input is suspended; the driver stops preventing keys (AC-21). */
  get enabled(): boolean {
    return this.#enabled;
  }

  get mode(): InputMode {
    return this.#mode;
  }

  /** True while a gameplay scene is on screen — the `preventDefault` gate (AC-6). */
  get gameplayActive(): boolean {
    return this.#gameplay;
  }

  /** The canvas box in CSS px, which the NDC of `setAimPointer` divides by. */
  get viewport(): { readonly width: number; readonly height: number } {
    return { width: this.#width, height: this.#height };
  }

  // -------------------------------------------------------------- frame hooks

  /**
   * Publish the edges queued since the last call and age the held buttons
   * (§4.1). Both edges of a press-and-release that happened inside one frame
   * surface together, with `down` already false (AC-2).
   */
  beginFrame(frameDt: number): void {
    for (const action of ACTIONS) {
      const track = this.#track[action];
      const button = track.button;
      button.justPressed = track.press;
      button.justReleased = track.release;
      track.press = false;
      track.release = false;
      button.heldFor = button.down ? button.heldFor + frameDt : 0;
    }
  }

  /** Clear the edges so the next frame starts clean (AC-2). */
  endFrame(): void {
    for (const action of ACTIONS) {
      const button = this.#track[action].button;
      button.justPressed = false;
      button.justReleased = false;
    }
  }

  /**
   * Drop everything: blur, hidden tab, `pointercancel` and every scene
   * transition come through here (AC-10, E10). Each held action queues its
   * `justReleased`, so a system that started something on the press still sees
   * the matching release.
   */
  releaseAll(): void {
    for (const action of ACTIONS) {
      const track = this.#track[action];
      track.button.heldFor = 0;
      if (track.sources.size === 0) continue;
      track.sources.clear();
      track.button.down = false;
      track.release = true;
    }
    // The driver keeps its own held-key and held-button sets to ref-count the
    // physical inputs behind one action; they have to go with the rest, or the
    // next key-up would recompute movement from keys nobody is holding.
    for (const driver of this.#drivers) driver.forget();
    this.#rawMove.clear();
    this.#state.move.x = 0;
    this.#state.move.y = 0;
    const aim = this.#state.aim;
    aim.dragging = false;
    aim.dirX = 0;
    aim.dirY = 0;
  }

  /**
   * Suspend or restore the whole system (AC-21). Suspending releases what was
   * held, so re-enabling cannot replay a key the player is no longer pressing;
   * while suspended every driver write is dropped and the keyboard driver stops
   * calling `preventDefault`, so browser shortcuts come back.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  // -------------------------------------------------------------- driver API

  /** Adds `source` to the action's holders; the first holder queues `justPressed`. */
  pressAction(action: Action, source: Scheme): void {
    if (!this.#enabled) return;
    const track = this.#track[action];
    if (track.sources.has(source)) return; // already holding: not a new edge
    if (track.sources.size === 0) track.press = true;
    track.sources.add(source);
    track.button.down = true;
  }

  /** Removes one holder; only the last one to let go queues `justReleased` (AC-22). */
  releaseAction(action: Action, source: Scheme): void {
    const track = this.#track[action];
    if (!track.sources.delete(source)) return;
    if (track.sources.size > 0) return;
    track.button.down = false;
    track.release = true;
  }

  /** The raw move vector of one source; the state's `move` is the shaped sum (AC-8). */
  setMove(x: number, y: number, source: Scheme): void {
    if (!this.#enabled) return;
    let raw = this.#rawMove.get(source);
    if (raw === undefined) {
      raw = { x: 0, y: 0 };
      this.#rawMove.set(source, raw);
    }
    raw.x = x;
    raw.y = y;
    this.#applyMove();
  }

  /** Screen aim in CSS px inside the canvas box, plus its NDC (AC-24). */
  setAimPointer(screenX: number, screenY: number, source: Scheme): void {
    if (!this.#enabled) return;
    this.setScheme(source);
    const aim = this.#state.aim;
    aim.screenX = screenX;
    aim.screenY = screenY;
    aim.ndcX = this.#width > 0 ? (screenX / this.#width) * 2 - 1 : 0;
    aim.ndcY = this.#height > 0 ? -((screenY / this.#height) * 2 - 1) : 0;
    aim.hasPointer = true;
    // Flight aim-assist reads the reticle, so a moved reticle re-steers (AC-29).
    if (this.#assisting()) this.#applyMove();
  }

  /** The direction of a touch aim-drag, and whether one is running (AC-13). */
  setAimDrag(dirX: number, dirY: number, active: boolean): void {
    if (!this.#enabled) return;
    const aim = this.#state.aim;
    aim.dragging = active;
    if (!active) {
      aim.dirX = 0;
      aim.dirY = 0;
      return;
    }
    const magnitude = Math.hypot(dirX, dirY);
    aim.dirX = magnitude > 0 ? dirX / magnitude : 0;
    aim.dirY = magnitude > 0 ? dirY / magnitude : 0;
  }

  /**
   * The last-used device wins (AC-19); a real change is announced once. Only
   * the drivers call this, and only from a real key or pointer event — the
   * writes above deliberately leave the scheme alone, so the touch layer can
   * let go of its own state while unmounting without claiming the scheme back.
   */
  setScheme(scheme: Scheme): void {
    if (scheme === this.#state.scheme) return;
    this.#state.scheme = scheme;
    this.#events?.emit('input:schemeChanged', { scheme });
    for (const listener of [...this.#schemeListeners]) {
      try {
        listener(scheme);
      } catch (error) {
        log.error('input', 'a scheme listener threw', error);
      }
    }
  }

  /**
   * The touch layer shows and hides itself on this rather than on the bus, so
   * an `Input` built without one still honours "touch controls render only
   * while the scheme is touch" (AC-20).
   */
  onSchemeChanged(listener: (scheme: Scheme) => void): () => void {
    this.#schemeListeners.add(listener);
    return () => void this.#schemeListeners.delete(listener);
  }

  /** Surface or flight; picks the zone split and the flight aim-assist (AC-27 … AC-29). */
  setMode(mode: InputMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#applyMove();
  }

  /** The canvas box the NDC of `setAimPointer` divides by; kept by `renderer:resized`. */
  setViewport(width: number, height: number): void {
    this.#width = width;
    this.#height = height;
  }

  /** Set from `scene:entered`; the `preventDefault` gate of AC-6. */
  setGameplayActive(active: boolean): void {
    this.#gameplay = active;
  }

  // -------------------------------------------------------------------- teardown

  /** Removes every listener the driver and the bus subscription hold (AC-32). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const driver of this.#drivers.splice(0)) driver.dispose();
    for (const release of this.#teardown.splice(0).reverse()) {
      try {
        release();
      } catch (error) {
        log.error('input', 'a tear-down callback threw', error);
      }
    }
    this.#schemeListeners.clear();
    this.releaseAll();
  }

  // -------------------------------------------------------------------- internals

  /**
   * A scene change is a hard reset: whatever was held belonged to the scene
   * that is going away (AC-10). The resize keeps the NDC divisor honest, and
   * the driver re-measures the canvas box on the same signal.
   */
  #watchEvents(): void {
    const events = this.#events;
    if (events === null) return;
    this.#teardown.push(
      events.on(
        'scene:transition',
        () => {
          this.#gameplay = false;
          this.releaseAll();
        },
        this,
      ),
      events.on('scene:entered', ({ id }) => this.setGameplayActive(GAMEPLAY_SCENES.includes(id)), this),
      events.on(
        'renderer:resized',
        ({ width, height }) => {
          this.setViewport(width, height);
          for (const driver of this.#drivers) driver.refresh();
        },
        this,
      ),
    );
  }

  #computeAutoFire(): boolean {
    if (!this.#enabled) return false;
    const mode: AutoFireMode = this.#settings?.autoFire ?? 'touch';
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return this.#state.scheme === 'touch';
  }

  /** True while flight steering should be pulled toward the mouse reticle (AC-29). */
  #assisting(): boolean {
    return (
      this.#mode === 'flight' &&
      this.#state.scheme === 'keyboard' &&
      this.#settings?.flightMouseSteer === true &&
      this.#state.aim.hasPointer
    );
  }

  /** Sum the sources, shape the result, then blend in the flight aim-assist. */
  #applyMove(): void {
    let x = 0;
    let y = 0;
    for (const raw of this.#rawMove.values()) {
      x += raw.x;
      y += raw.y;
    }
    const move = this.#state.move;
    shapeMove(x, y, move);
    if (!this.#assisting()) return;
    const aim = this.#state.aim;
    // The reticle's NDC is already in [-1, 1] with y up, which is exactly the
    // steer space; clamp its length so a corner reticle cannot exceed full
    // deflection on its own.
    const magnitude = Math.hypot(aim.ndcX, aim.ndcY);
    const scale = magnitude > 1 ? 1 / magnitude : 1;
    move.x += (aim.ndcX * scale - move.x) * FLIGHT_AIM_ASSIST;
    move.y += (aim.ndcY * scale - move.y) * FLIGHT_AIM_ASSIST;
  }
}

/**
 * The input `Game` falls back to when the composition root injects none: a real
 * `Input` with no canvas, so it holds no listeners and only ever reports the
 * neutral state (SPEC-002 §3.4).
 */
export function createNullInput(): Input {
  return new Input();
}
