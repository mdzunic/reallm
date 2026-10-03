// The keyboard and mouse driver (SPEC-005 §4.2). It owns every DOM listener the
// desktop scheme needs and writes into `Input` through the driver API — it
// keeps no gameplay state of its own beyond the bookkeeping that turns physical
// keys and buttons into actions.
//
// Two rules shape it:
//   - bindings are keyed by `event.code`, the *physical* key, so WASD is the
//     same three fingers on QWERTY, AZERTY and QWERTZ without a layout table
//     (AC-4);
//   - a bound key is only swallowed while a gameplay scene is on screen and the
//     input is enabled (AC-6). Everything else — Ctrl-R, Ctrl-Shift-I, Tab, the
//     browser's own shortcuts — reaches the browser untouched, and so does
//     anything typed into a text field (AC-7).
//
// The targets are injected so the unit tests can drive the whole driver with
// plain objects, the way `core/Lifecycle.ts` does.
import type { Action, Input, InputDriver, MoveAxis, Scheme } from '@/core/Input';

/**
 * The physical-key table of AC-4. Anything absent from it is not the game's
 * key and is never touched.
 */
export const KEY_BINDINGS: Readonly<Record<string, Action | MoveAxis>> = {
  KeyW: 'moveUp',
  ArrowUp: 'moveUp',
  KeyS: 'moveDown',
  ArrowDown: 'moveDown',
  KeyA: 'moveLeft',
  ArrowLeft: 'moveLeft',
  KeyD: 'moveRight',
  ArrowRight: 'moveRight',
  Space: 'fire',
  KeyE: 'interact',
  KeyF: 'interact',
  // SPEC-028 §4.1: the digits are the weapon slots now; Q keeps the heal.
  KeyQ: 'useItem',
  Digit1: 'weapon1',
  Digit2: 'weapon2',
  Digit3: 'weapon3',
  KeyR: 'weaponNext',
  KeyG: 'throwItem',
  KeyC: 'useUtility',
  // SPEC-038 §4.1: the dash; the right mouse button holds it too.
  KeyV: 'dash',
  Escape: 'pause',
  KeyP: 'pause',
  KeyM: 'map',
  KeyT: 'track',
  ShiftLeft: 'throttleUp',
  // SPEC-034 §4.16: X, not Ctrl — Ctrl+W closes a Chrome or Edge tab, and Ctrl
  // sits right next to the steering keys.
  KeyX: 'throttleDown',
  Backquote: 'debug',
};

/**
 * SPEC-050 §4.5: the keys that mean something else on the surface, read only
 * while `input.mode` is `'surface'` — either Shift runs there, while in flight
 * `ShiftLeft` keeps `KEY_BINDINGS`' `throttleUp`. The wheel maps by mode the
 * same way; `KEY_BINDINGS` itself is unchanged.
 */
export const SURFACE_KEY_OVERRIDES: Readonly<Record<string, Action>> = {
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
};

/** SPEC-028 §4.1: wheel notches closer than this are one flick of the wheel. */
export const WHEEL_INTERVAL_MS = 120;

const MOVE_AXES: Readonly<Record<MoveAxis, { x: number; y: number }>> = {
  moveUp: { x: 0, y: 1 },
  moveDown: { x: 0, y: -1 },
  moveLeft: { x: -1, y: 0 },
  moveRight: { x: 1, y: 0 },
};

/** Mouse and keyboard are the same scheme: one player, one pair of hands (AC-19). */
const SCHEME: Scheme = 'keyboard';

function isMoveAxis(binding: Action | MoveAxis): binding is MoveAxis {
  return binding in MOVE_AXES;
}

/**
 * A text field, a textarea, a select or anything `contenteditable` (AC-7). Duck
 * typed rather than `instanceof HTMLElement`, because the tests hand the driver
 * plain objects and a cross-document element would fail the instance check
 * anyway.
 */
function isEditable(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const node = target as { tagName?: unknown; isContentEditable?: unknown };
  if (node.isContentEditable === true) return true;
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** The slice of `HTMLCanvasElement` the driver actually uses. */
export interface PointerSurface extends EventTarget {
  getBoundingClientRect?(): { left: number; top: number; width: number; height: number };
}

export interface DriverTargets {
  /** The drawing surface: pointer buttons, aim, the wheel and the context menu. */
  canvas?: PointerSurface | null;
  /** Key events, focus loss and pointer moves; `globalThis` by default. */
  win?: EventTarget | null;
  /** `visibilitychange` and `gesturestart`; `document` by default. */
  doc?: EventTarget | null;
  /** The wheel rate-limit clock, injectable for the tests; `performance.now` by default. */
  now?: () => number;
}

interface Binding {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: (event: Event) => void;
  readonly capture: boolean;
}

/** Node has neither of these, so both default to nothing outside a browser. */
function listenable(value: unknown): EventTarget | null {
  const target = value as EventTarget | undefined;
  return typeof target?.addEventListener === 'function' ? target : null;
}

function defaultWin(): EventTarget | null {
  return listenable(globalThis);
}

function defaultDoc(): EventTarget | null {
  return listenable((globalThis as { document?: Document }).document);
}

export class KeyboardMouseDriver implements InputDriver {
  readonly #input: Input;
  readonly #canvas: PointerSurface | null;
  readonly #bindings: Binding[] = [];
  /**
   * Which physical inputs hold each action. Space and mouse button 0 both map
   * to `fire`, and `Input` sees one `keyboard` source for both, so releasing
   * one of them may not end the hold (AC-22).
   */
  readonly #holders = new Map<Action, Set<string>>();
  /** The movement half-axes currently held, by binding name (AC-8). */
  readonly #axes = new Set<MoveAxis>();
  /**
   * SPEC-050 §4.5: what each held key pressed on key-down, by `event.code` — a
   * Shift pressed on the surface releases `sprint` even after the mode
   * changed to flight (E80).
   */
  readonly #pressed = new Map<string, Action | MoveAxis>();
  /** The canvas box, re-measured on resize rather than on every pointer move. */
  #left = 0;
  #top = 0;
  /** The wheel clock and the last accepted notch (SPEC-028 §4.1). */
  readonly #now: () => number;
  #wheelAt = -Infinity;

  constructor(input: Input, targets: DriverTargets = {}) {
    this.#input = input;
    this.#canvas = targets.canvas ?? null;
    this.#now = targets.now ?? ((): number => performance.now());
    const win = targets.win === undefined ? defaultWin() : targets.win;
    const doc = targets.doc === undefined ? defaultDoc() : targets.doc;

    if (win !== null) {
      this.#bind(win, 'keydown', (event) => this.#onKeyDown(event as KeyboardEvent));
      this.#bind(win, 'keyup', (event) => this.#onKeyUp(event as KeyboardEvent));
      // E10: a key held when focus leaves would otherwise stay held forever.
      this.#bind(win, 'blur', () => this.#input.releaseAll());
      // SPEC-036 §4.2: every press sets the scheme from its `pointerType` —
      // a tap on START, a menu button or a quick-bar slot counts, not only one
      // that reaches the canvas. Capture phase, so a control that stops the
      // event cannot hide the press from it.
      this.#bind(win, 'pointerdown', (event) => this.#input.setScheme(schemeOf(event as PointerEvent)), true);
      // AC-24: *every* mouse move updates the aim, including the ones that
      // pass over a HUD panel, so this sits above the canvas.
      this.#bind(win, 'pointermove', (event) => this.#onPointerMove(event as PointerEvent));
      this.#bind(win, 'pointerup', (event) => this.#onPointerUp(event as PointerEvent));
      this.#bind(win, 'pointercancel', (event) => this.#onPointerCancel(event as PointerEvent));
    }
    if (doc !== null) {
      this.#bind(doc, 'visibilitychange', () => this.#onVisibility(doc));
      // AC-26: Safari's pinch gesture would otherwise zoom the whole page.
      this.#bind(doc, 'gesturestart', (event) => event.preventDefault());
    }
    if (this.#canvas !== null) {
      this.#bind(this.#canvas, 'pointerdown', (event) => this.#onPointerDown(event as PointerEvent));
      this.#bind(this.#canvas, 'contextmenu', (event) => event.preventDefault());
      // SPEC-028 §4.1: only the canvas — a wheel over a DOM panel never
      // reaches it, so a scrolling terminal cannot switch weapons (28-h).
      this.#bind(this.#canvas, 'wheel', (event) => this.#onWheel(event as WheelEvent));
    }

    // AC-32: `input.dispose()` has to reach these listeners, and `releaseAll()`
    // has to reach the held-key set below, however this driver was built.
    input.useDriver(this);
    this.refresh();
  }

  /** Re-measure the canvas box; `Input` calls it on every `renderer:resized`. */
  refresh(): void {
    const rect = this.#canvas?.getBoundingClientRect?.();
    if (rect === undefined) return;
    this.#left = rect.left;
    this.#top = rect.top;
    this.#input.setViewport(rect.width, rect.height);
  }

  /** Drop the physical bookkeeping; `Input.releaseAll()` calls it (E10). */
  forget(): void {
    this.#holders.clear();
    this.#axes.clear();
    this.#pressed.clear();
  }

  dispose(): void {
    for (const binding of this.#bindings.splice(0).reverse()) {
      binding.target.removeEventListener(binding.type, binding.handler, binding.capture);
    }
    this.forget();
  }

  // ------------------------------------------------------------------ keyboard

  #onKeyDown(event: KeyboardEvent): void {
    if (event.repeat) return; // AC-5: auto-repeat is not a new press
    if (isEditable(event.target)) return; // AC-7
    this.#input.setScheme(SCHEME); // AC-19: any key event, bound or not
    // SPEC-050 §4.5: on the surface the overrides come first.
    const binding = (this.#input.mode === 'surface' ? SURFACE_KEY_OVERRIDES[event.code] : undefined) ?? KEY_BINDINGS[event.code];
    if (binding === undefined) return; // AC-6: browser shortcuts keep working
    // AC-6/AC-21: only a live gameplay scene may swallow a key.
    if (this.#input.gameplayActive && this.#input.enabled) event.preventDefault();
    this.#pressed.set(event.code, binding);
    if (isMoveAxis(binding)) {
      this.#axes.add(binding);
      this.#pushMove();
      return;
    }
    this.#hold(binding, `key:${event.code}`);
  }

  #onKeyUp(event: KeyboardEvent): void {
    if (isEditable(event.target)) return;
    this.#input.setScheme(SCHEME);
    // SPEC-050 §4.5: the key lets go of what it pressed, whatever the mode is now.
    const binding = this.#pressed.get(event.code) ?? KEY_BINDINGS[event.code];
    this.#pressed.delete(event.code);
    if (binding === undefined) return;
    if (this.#input.gameplayActive && this.#input.enabled) event.preventDefault();
    if (isMoveAxis(binding)) {
      this.#axes.delete(binding);
      this.#pushMove();
      return;
    }
    this.#drop(binding, `key:${event.code}`);
  }

  /** The summed half-axes; `Input` shapes and normalises them (AC-8). */
  #pushMove(): void {
    let x = 0;
    let y = 0;
    for (const axis of this.#axes) {
      const vector = MOVE_AXES[axis];
      x += vector.x;
      y += vector.y;
    }
    this.#input.setMove(x, y, SCHEME);
  }

  // ------------------------------------------------------------------- pointer

  #onPointerDown(event: PointerEvent): void {
    this.#input.setScheme(schemeOf(event));
    if (event.pointerType !== 'mouse') return; // the touch layer owns touch (AC-14)
    // AC-23: button 0 fires. SPEC-038 §4.1 ends button 2's reservation: it
    // holds `dash`, and the context menu it would open is already prevented above.
    if (event.button === 0) this.#hold('fire', 'mouse:0');
    else if (event.button === 2) this.#hold('dash', 'mouse:2');
  }

  #onPointerUp(event: PointerEvent): void {
    if (event.pointerType !== 'mouse') return;
    if (event.button === 0) this.#drop('fire', 'mouse:0');
    else if (event.button === 2) this.#drop('dash', 'mouse:2');
  }

  /**
   * SPEC-028 §4.1: a wheel notch is a press-and-release in the same frame —
   * down cycles forward on the surface, up backward; in flight the wheel
   * drives the throttle. Notches closer than 120 ms apart are dropped.
   */
  #onWheel(event: WheelEvent): void {
    if (event.deltaY === 0) return;
    this.#input.setScheme(SCHEME);
    if (!this.#input.enabled) return;
    if (this.#input.gameplayActive) event.preventDefault();
    const now = this.#now();
    if (now - this.#wheelAt < WHEEL_INTERVAL_MS) return;
    this.#wheelAt = now;
    const action: Action =
      this.#input.mode === 'flight'
        ? event.deltaY > 0
          ? 'throttleDown'
          : 'throttleUp'
        : event.deltaY > 0
          ? 'weaponNext'
          : 'weaponPrev';
    // Press and release together: the queued edges of `Input` publish both on
    // the next frame (SPEC-005 AC-2), so a notch is exactly one press.
    this.#input.pressAction(action, SCHEME);
    this.#input.releaseAction(action, SCHEME);
  }

  /**
   * SPEC-036 §4.1: a finger has no hover. A touch or pen move sets the scheme
   * and nothing else — its position is a steering or firing gesture the touch
   * layer owns, never a cursor — so only a mouse writes the hover aim.
   */
  #onPointerMove(event: PointerEvent): void {
    const scheme = schemeOf(event);
    this.#input.setScheme(scheme); // AC-19, even while the input is suspended
    if (event.pointerType !== 'mouse') return;
    this.#input.setAimPointer(event.clientX - this.#left, event.clientY - this.#top, scheme);
  }

  /**
   * SPEC-036 §4.7: a cancelled mouse pointer drops its own holder and nothing
   * else. A cancelled touch or pen pointer belongs to the touch layer, which
   * releases exactly the role that finger had; blur, a hidden page and scene
   * changes still release everything (E10).
   */
  #onPointerCancel(event: PointerEvent): void {
    if (event.pointerType !== 'mouse') return;
    this.#drop('fire', 'mouse:0');
    this.#drop('dash', 'mouse:2');
  }

  #onVisibility(doc: EventTarget): void {
    if ((doc as { hidden?: boolean }).hidden === false) return;
    this.#input.releaseAll();
  }

  // ------------------------------------------------------------------ plumbing

  /** One physical input takes hold of an action; the first of them presses it. */
  #hold(action: Action, holder: string): void {
    let holders = this.#holders.get(action);
    if (holders === undefined) {
      holders = new Set<string>();
      this.#holders.set(action, holders);
    }
    holders.add(holder);
    if (holders.size === 1) this.#input.pressAction(action, SCHEME);
  }

  /** …and only the last of them releases it, so Space and the mouse coexist. */
  #drop(action: Action, holder: string): void {
    const holders = this.#holders.get(action);
    if (holders === undefined || !holders.delete(holder)) return;
    if (holders.size > 0) return;
    this.#holders.delete(action);
    this.#input.releaseAction(action, SCHEME);
  }

  #bind(target: EventTarget, type: string, handler: (event: Event) => void, capture = false): void {
    target.addEventListener(type, handler, capture);
    this.#bindings.push({ target, type, handler, capture });
  }
}

/** `mouse` is the keyboard scheme's other hand; touch and pen are the touch scheme (AC-19). */
function schemeOf(event: PointerEvent): Scheme {
  return event.pointerType === 'touch' || event.pointerType === 'pen' ? 'touch' : SCHEME;
}
