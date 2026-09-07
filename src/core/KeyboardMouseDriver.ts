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
  KeyQ: 'useItem',
  Digit1: 'useItem',
  Escape: 'pause',
  KeyP: 'pause',
  KeyM: 'map',
  ShiftLeft: 'throttleUp',
  ControlLeft: 'throttleDown',
  Backquote: 'debug',
};

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
  /** The drawing surface: pointer buttons, aim and the context menu. */
  canvas?: PointerSurface | null;
  /** Key events, focus loss and pointer moves; `globalThis` by default. */
  win?: EventTarget | null;
  /** `visibilitychange` and `gesturestart`; `document` by default. */
  doc?: EventTarget | null;
}

interface Binding {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: (event: Event) => void;
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
  /** The canvas box, re-measured on resize rather than on every pointer move. */
  #left = 0;
  #top = 0;

  constructor(input: Input, targets: DriverTargets = {}) {
    this.#input = input;
    this.#canvas = targets.canvas ?? null;
    const win = targets.win === undefined ? defaultWin() : targets.win;
    const doc = targets.doc === undefined ? defaultDoc() : targets.doc;

    if (win !== null) {
      this.#bind(win, 'keydown', (event) => this.#onKeyDown(event as KeyboardEvent));
      this.#bind(win, 'keyup', (event) => this.#onKeyUp(event as KeyboardEvent));
      // E10: a key held when focus leaves would otherwise stay held forever.
      this.#bind(win, 'blur', () => this.#input.releaseAll());
      // AC-24: *every* pointer move updates the aim, including the ones that
      // pass over a HUD panel, so this sits above the canvas.
      this.#bind(win, 'pointermove', (event) => this.#onPointerMove(event as PointerEvent));
      this.#bind(win, 'pointerup', (event) => this.#onPointerUp(event as PointerEvent));
      this.#bind(win, 'pointercancel', () => this.#input.releaseAll());
    }
    if (doc !== null) {
      this.#bind(doc, 'visibilitychange', () => this.#onVisibility(doc));
      // AC-26: Safari's pinch gesture would otherwise zoom the whole page.
      this.#bind(doc, 'gesturestart', (event) => event.preventDefault());
    }
    if (this.#canvas !== null) {
      this.#bind(this.#canvas, 'pointerdown', (event) => this.#onPointerDown(event as PointerEvent));
      this.#bind(this.#canvas, 'contextmenu', (event) => event.preventDefault());
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
  }

  dispose(): void {
    for (const binding of this.#bindings.splice(0).reverse()) {
      binding.target.removeEventListener(binding.type, binding.handler);
    }
    this.forget();
  }

  // ------------------------------------------------------------------ keyboard

  #onKeyDown(event: KeyboardEvent): void {
    if (event.repeat) return; // AC-5: auto-repeat is not a new press
    if (isEditable(event.target)) return; // AC-7
    this.#input.setScheme(SCHEME); // AC-19: any key event, bound or not
    const binding = KEY_BINDINGS[event.code];
    if (binding === undefined) return; // AC-6: browser shortcuts keep working
    // AC-6/AC-21: only a live gameplay scene may swallow a key.
    if (this.#input.gameplayActive && this.#input.enabled) event.preventDefault();
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
    const binding = KEY_BINDINGS[event.code];
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
    // AC-23: button 0 fires, button 2 is reserved — it raises no action at all,
    // and the context menu it would open is already prevented above.
    if (event.button === 0) this.#hold('fire', 'mouse:0');
  }

  #onPointerUp(event: PointerEvent): void {
    if (event.pointerType !== 'mouse') return;
    if (event.button === 0) this.#drop('fire', 'mouse:0');
  }

  #onPointerMove(event: PointerEvent): void {
    const scheme = schemeOf(event);
    this.#input.setScheme(scheme); // AC-19, even while the input is suspended
    this.#input.setAimPointer(event.clientX - this.#left, event.clientY - this.#top, scheme);
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

  #bind(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler);
    this.#bindings.push({ target, type, handler });
  }
}

/** `mouse` is the keyboard scheme's other hand; touch and pen are the touch scheme (AC-19). */
function schemeOf(event: PointerEvent): Scheme {
  return event.pointerType === 'touch' || event.pointerType === 'pen' ? 'touch' : SCHEME;
}
