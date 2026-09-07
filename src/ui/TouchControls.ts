// The touch layer (SPEC-005 §4.3). A single full-screen pointer surface plus a
// row of DOM buttons, mounted into `#ui` and removed again on `hide()`.
//
// The surface is one element, not two: the zone a pointer belongs to is decided
// once, at `pointerdown`, by the pure `zoneFor` of `core/Input.ts` (AC-14,
// AC-30). That is what makes the mirrored left-handed layout a settings read
// rather than a second stylesheet, and what lets a thumb that slides across the
// middle of the screen keep the role it started with.
//
// Ownership is per `pointerId` (AC-14): one pointer drives the stick, another
// drives aim, and each is captured so a thumb that leaves the element keeps
// being tracked (AC-25). A second finger in a zone that is already owned is
// ignored until the first lifts (AC-15).
import {
  FLIGHT_STEER_FRACTION,
  FLOAT_DRIFT,
  JOYSTICK_RADIUS_PX,
  MOVE_ZONE_FRACTION,
  TAP_SLOP_PX,
  zoneFor,
  type Action,
  type Input,
  type InputMode,
} from '@/core/Input';
import type { SettingsStore } from '@/core/Settings';
import { el, testId } from '@/ui/dom';

/** The parts of the layout the player owns (SPEC-005 §3). */
export interface TouchLayout {
  joystickSide: 'left' | 'right';
  /** Multiplies the 56 px button base; the CSS reads it as `--touch-scale`. */
  buttonScale: number;
}

/** A pointer the surface has claimed, and what it was claimed for. */
interface ZonePointer {
  readonly id: number;
  readonly startX: number;
  readonly startY: number;
  originX: number;
  originY: number;
  /** Aim only: true once the pointer left the tap slop and became a drag (AC-13). */
  dragging: boolean;
}

/** Which buttons each mode shows (AC-27). */
const MODE_BUTTONS: Readonly<Record<InputMode, readonly Action[]>> = {
  surface: ['interact', 'useItem', 'pause'],
  flight: ['throttleUp', 'throttleDown', 'pause'],
};

const BUTTON_LABELS: Readonly<Record<Action, string>> = {
  fire: 'FIRE',
  interact: 'USE',
  useItem: 'ITEM',
  pause: 'II',
  throttleUp: '▲',
  throttleDown: '▼',
  map: 'MAP',
  debug: '`',
};

export class TouchControls {
  readonly #root: HTMLElement;
  readonly #layer: HTMLDivElement;
  readonly #surface: HTMLDivElement;
  readonly #stick: HTMLDivElement;
  readonly #knob: HTMLDivElement;
  readonly #reticle: HTMLDivElement;
  readonly #buttons = new Map<Action, HTMLButtonElement>();
  readonly #input: Input;
  readonly #settings: SettingsStore;
  readonly #teardown: Array<() => void> = [];

  #mode: InputMode | null = null;
  #move: ZonePointer | null = null;
  #aim: ZonePointer | null = null;
  #interactHint: string | null = null;
  #disposed = false;
  /** The surface box, measured at `pointerdown` so a move costs no DOM read. */
  #rect = { left: 0, top: 0, width: 0, height: 0 };

  constructor(root: HTMLElement, input: Input, settings: SettingsStore) {
    this.#root = root;
    this.#input = input;
    this.#settings = settings;

    this.#layer = testId(el('div', 'touch-controls'), 'touch-controls');
    this.#surface = testId(el('div', 'touch-surface'), 'touch-surface');
    this.#stick = testId(el('div', 'touch-stick'), 'touch-stick');
    this.#knob = el('div', 'touch-stick-knob');
    this.#stick.append(this.#knob);
    this.#reticle = testId(el('div', 'touch-reticle'), 'touch-reticle');
    const buttons = el('div', 'touch-buttons');
    for (const action of ['interact', 'useItem', 'throttleUp', 'throttleDown', 'pause'] as const) {
      const button = this.#makeButton(action);
      this.#buttons.set(action, button);
      buttons.append(button);
    }
    this.#layer.append(this.#surface, this.#stick, this.#reticle, buttons);

    this.#listen(this.#surface, 'pointerdown', (event) => this.#onDown(event as PointerEvent));
    this.#listen(this.#surface, 'pointermove', (event) => this.#onMove(event as PointerEvent));
    this.#listen(this.#surface, 'pointerup', (event) => this.#onUp(event as PointerEvent, false));
    this.#listen(this.#surface, 'pointercancel', (event) => this.#onUp(event as PointerEvent, true));
    // A long press on the play surface must not raise the callout (AC-16, AC-26).
    this.#listen(this.#layer, 'contextmenu', (event) => event.preventDefault());
    // AC-20: the layer follows the active scheme, whatever the scene asked for.
    this.#teardown.push(this.#input.onSchemeChanged(() => this.#sync()));
  }

  /** The layout the player chose; read fresh so a settings change lands on the next show. */
  get layout(): TouchLayout {
    return { joystickSide: this.#settings.joystickSide, buttonScale: this.#settings.buttonScale };
  }

  get mode(): InputMode | null {
    return this.#mode;
  }

  /** True while the layer is actually in the DOM (touch scheme only, AC-20). */
  get visible(): boolean {
    return this.#layer.isConnected;
  }

  /**
   * Ask for a layout (AC-27). It also tells `Input` which mode it is in, so the
   * flight steer split and the keyboard aim-assist agree with what is drawn
   * (AC-28, AC-29). Nothing is mounted unless the touch scheme is active.
   */
  show(mode: InputMode): void {
    if (this.#disposed) return;
    this.#mode = mode;
    this.#input.setMode(mode);
    this.#applyMode();
    this.#sync();
  }

  /** Take the controls off the screen and drop whatever they were holding. */
  hide(): void {
    this.#mode = null;
    this.#release();
    this.#layer.remove();
  }

  /** The interact button only exists while the scene offers something (AC-17). */
  setInteractHint(label: string | null): void {
    this.#interactHint = label;
    const button = this.#buttons.get('interact');
    if (button === undefined) return;
    button.textContent = label ?? BUTTON_LABELS.interact;
    this.#applyMode();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.hide();
    for (const release of this.#teardown.splice(0).reverse()) release();
    this.#buttons.clear();
  }

  // ------------------------------------------------------------------- layout

  /** Mount or unmount, purely on the scheme (AC-20). */
  #sync(): void {
    const wanted = this.#mode !== null && this.#input.state.scheme === 'touch';
    if (wanted === this.#layer.isConnected) return;
    if (!wanted) {
      this.#release();
      this.#layer.remove();
      return;
    }
    this.#applyMode();
    this.#root.append(this.#layer);
  }

  /** Which buttons this mode shows, plus the side and scale the player chose. */
  #applyMode(): void {
    const mode = this.#mode;
    const layout = this.layout;
    this.#layer.style.setProperty('--touch-scale', String(layout.buttonScale));
    this.#layer.dataset['side'] = layout.joystickSide;
    this.#layer.dataset['mode'] = mode ?? '';
    const shown = mode === null ? [] : MODE_BUTTONS[mode];
    for (const [action, button] of this.#buttons) {
      // AC-17: the interact button stays out of the way until a scene sets a hint.
      const visible = shown.includes(action) && (action !== 'interact' || this.#interactHint !== null);
      button.classList.toggle('is-hidden', !visible);
    }
    // AC-28: flight aims itself, and says so with a reticle; the surface aims by drag.
    this.#reticle.classList.toggle('is-hidden', mode !== 'flight');
    this.#stick.classList.add('is-hidden');
  }

  // ------------------------------------------------------------------ pointers

  /** The move zone's share of the width: 45 % on the surface, 60 % in flight. */
  #fraction(): number {
    return this.#mode === 'flight' ? FLIGHT_STEER_FRACTION : MOVE_ZONE_FRACTION;
  }

  #onDown(event: PointerEvent): void {
    if (this.#mode === null) return;
    this.#input.setScheme(event.pointerType === 'mouse' ? 'keyboard' : 'touch');
    const rect = this.#surface.getBoundingClientRect();
    this.#rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const zone = zoneFor(x, rect.width, this.layout.joystickSide, this.#fraction());
    // AC-15: one finger per zone; the second is ignored until the first lifts.
    if (zone === 'move' && this.#move !== null) return;
    if (zone === 'aim' && this.#aim !== null) return;
    event.preventDefault();
    // AC-25: the thumb keeps being tracked once it leaves the element. A
    // pointer id the browser no longer knows about throws rather than
    // returning, and losing capture must not cost the player the whole gesture.
    try {
      this.#surface.setPointerCapture(event.pointerId);
    } catch {
      // no capture: the pointer is tracked only while it stays on the surface
    }
    const claimed: ZonePointer = { id: event.pointerId, startX: x, startY: y, originX: x, originY: y, dragging: false };
    if (zone === 'move') {
      this.#move = claimed;
      // AC-11: the stick appears where the thumb landed. Flight steers without
      // one — the ship is the cursor (AC-28).
      if (this.#mode === 'surface') this.#showStick(x, y, 0, 0);
      return;
    }
    this.#aim = claimed;
    // AC-28: in flight the fire zone is hold-to-fire from the moment it is
    // touched; on the surface the press waits to see whether this is a tap or
    // a drag (AC-12, AC-13).
    if (this.#mode === 'flight') this.#input.pressAction('fire', 'touch');
  }

  #onMove(event: PointerEvent): void {
    const x = event.clientX - this.#rect.left;
    const y = event.clientY - this.#rect.top;
    const move = this.#move;
    if (move !== null && move.id === event.pointerId) {
      this.#steer(move, x, y);
      return;
    }
    const aim = this.#aim;
    if (aim === null || aim.id !== event.pointerId) return;
    const dx = x - aim.startX;
    const dy = y - aim.startY;
    if (!aim.dragging) {
      if (Math.hypot(dx, dy) <= TAP_SLOP_PX) return; // still a tap (AC-12)
      aim.dragging = true;
      // AC-13: a drag holds fire, pressed exactly once for the whole drag.
      if (this.#mode !== 'flight') this.#input.pressAction('fire', 'touch');
    }
    // Screen y grows downward and aim is y-up, so the sign flips.
    this.#input.setAimDrag(dx, -dy, true);
  }

  #onUp(event: PointerEvent, cancelled: boolean): void {
    const move = this.#move;
    if (move !== null && move.id === event.pointerId) {
      this.#move = null;
      this.#input.setMove(0, 0, 'touch'); // AC-28: the steer offset returns to 0
      this.#stick.classList.add('is-hidden');
    }
    const aim = this.#aim;
    if (aim !== null && aim.id === event.pointerId) {
      this.#aim = null;
      if (this.#mode === 'flight' || aim.dragging) {
        this.#input.releaseAction('fire', 'touch');
      } else if (!cancelled) {
        // AC-12: a tap is one shot — press and release inside the same frame,
        // which the queued edges of `Input` survive (AC-2).
        this.#input.pressAction('fire', 'touch');
        this.#input.releaseAction('fire', 'touch');
      }
      this.#input.setAimDrag(0, 0, false);
    }
    // AC-10: a cancelled pointer (a system gesture, a call) drops everything.
    if (cancelled) this.#input.releaseAll();
  }

  /** The floating stick of AC-11: full deflection at the radius, origin follows the drift. */
  #steer(pointer: ZonePointer, x: number, y: number): void {
    let dx = x - pointer.originX;
    let dy = y - pointer.originY;
    const distance = Math.hypot(dx, dy);
    const drift = JOYSTICK_RADIUS_PX * FLOAT_DRIFT;
    if (distance > drift) {
      // Drag the origin along behind the thumb so it sits exactly `drift` away.
      const keep = drift / distance;
      pointer.originX = x - dx * keep;
      pointer.originY = y - dy * keep;
      dx *= keep;
      dy *= keep;
    }
    this.#input.setMove(dx / JOYSTICK_RADIUS_PX, -dy / JOYSTICK_RADIUS_PX, 'touch');
    if (this.#mode === 'surface') this.#showStick(pointer.originX, pointer.originY, dx, dy);
  }

  #showStick(originX: number, originY: number, dx: number, dy: number): void {
    const distance = Math.hypot(dx, dy);
    const clamp = distance > JOYSTICK_RADIUS_PX ? JOYSTICK_RADIUS_PX / distance : 1;
    this.#stick.classList.remove('is-hidden');
    this.#stick.style.transform = `translate(${originX}px, ${originY}px)`;
    this.#knob.style.transform = `translate(${dx * clamp}px, ${dy * clamp}px)`;
  }

  /**
   * Let go of everything this layer holds — and nothing else. A full
   * `releaseAll()` here would drop the very key that switched the scheme away
   * from touch, so only the `touch` source is released.
   */
  #release(): void {
    this.#move = null;
    this.#aim = null;
    this.#stick.classList.add('is-hidden');
    this.#input.setMove(0, 0, 'touch');
    this.#input.setAimDrag(0, 0, false);
    this.#input.releaseAction('fire', 'touch');
    for (const action of this.#buttons.keys()) this.#input.releaseAction(action, 'touch');
  }

  // ------------------------------------------------------------------- buttons

  /**
   * A DOM button (AC-16). It is ≥ 56 px through `.touch-button` in the
   * stylesheet, which also carries the `touch-action`, `user-select` and
   * `-webkit-touch-callout` rules that stop a long press from selecting text or
   * opening the iOS callout.
   */
  #makeButton(action: Action): HTMLButtonElement {
    const button = testId(el('button', `touch-button touch-${action} is-hidden`), `touch-${action}`);
    button.type = 'button';
    button.textContent = BUTTON_LABELS[action];
    button.setAttribute('aria-label', action);
    const press = (event: Event): void => {
      event.preventDefault();
      this.#input.pressAction(action, 'touch');
    };
    const release = (): void => this.#input.releaseAction(action, 'touch');
    this.#listen(button, 'pointerdown', press);
    this.#listen(button, 'pointerup', release);
    this.#listen(button, 'pointerleave', release);
    this.#listen(button, 'pointercancel', release);
    this.#listen(button, 'contextmenu', (event) => event.preventDefault());
    return button;
  }

  #listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler);
    this.#teardown.push(() => target.removeEventListener(type, handler));
  }
}
