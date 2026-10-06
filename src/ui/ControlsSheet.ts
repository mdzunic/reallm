// The controls sheet (SPEC-044 §4.5): one table of what each scheme's controls
// do, and the two places that show it as `controls-sheet` — docked in the
// pause menu beside its actions, and over the screen from the settings panel.
// Two hand-kept sheets drifted (the pause sheet never listed the terminal,
// dialogue or the quick picker), so the rows live here once, and
// `tests/ui/controls.test.ts` fails when an action bound in `KEY_BINDINGS` or
// SPEC-050's `SURFACE_KEY_OVERRIDES` has no keyboard row.
import type { Scheme } from '@/core/Input';
import { h, openModal, testId, type UiRoot } from '@/ui/dom';

export interface ControlRow {
  readonly what: string;
  readonly how: string;
  /** The `KEY_BINDINGS` values this row explains; absent for a row that names no binding. */
  readonly actions?: readonly string[];
}

/**
 * §4.5: the keyboard rows in reading order, each with the bindings it covers.
 * Fire and Dash keep SPEC-038 §4.9's words — the gun fires on its own, and a
 * held button aims it. The touch rows are SPEC-036 §4.11's, unchanged.
 */
export const CONTROL_ROWS: Readonly<Record<'keyboard' | 'touch', readonly ControlRow[]>> = {
  keyboard: [
    { what: 'Move / steer', how: 'WASD or the arrow keys', actions: ['moveUp', 'moveDown', 'moveLeft', 'moveRight'] },
    { what: 'Aim', how: 'Mouse' },
    { what: 'Fire', how: 'Automatic — hold Space or Left mouse to aim', actions: ['fire'] },
    { what: 'Dash', how: 'Right mouse or V', actions: ['dash'] },
    // SPEC-050 §4.5: either Shift, through the surface's key overrides.
    { what: 'Run', how: 'Hold Shift (on the ground)', actions: ['sprint'] },
    { what: 'Interact · pad terminal', how: 'E or F', actions: ['interact'] },
    { what: 'Continue a transmission', how: 'Enter, Space or E' },
    { what: 'Answer a choice', how: '1 to 9' },
    // SPEC-028 §4.8: the loadout keys — the digits switch, Q heals.
    { what: 'Switch weapon', how: '1 / 2 / 3, R or the wheel', actions: ['weapon1', 'weapon2', 'weapon3', 'weaponNext'] },
    { what: 'Heal', how: 'Q', actions: ['useItem'] },
    { what: 'Throw / plant', how: 'G', actions: ['throwItem'] },
    { what: 'Gadget', how: 'C', actions: ['useUtility'] },
    { what: 'Choose what a slot holds', how: 'right-click the slot on the bar' },
    // SPEC-034 §4.16: X, not Ctrl — Ctrl+W closes the tab next to WASD.
    { what: 'Throttle (flight)', how: 'Shift up · X down', actions: ['throttleUp', 'throttleDown'] },
    // SPEC-026 §4.5, §4.7: M opens the surface map, + and − zoom it.
    { what: 'Map', how: 'M · zoom + / −', actions: ['map'] },
    { what: 'Track mission', how: 'T', actions: ['track'] },
    // SPEC-054 §4.5: the flashlight below, beside the interact key.
    { what: 'Flashlight (below)', how: 'L', actions: ['light'] },
    // SPEC-055 §4.9: a puzzle panel's own keys — read by the panel, bound to no action.
    { what: 'Puzzle', how: 'Arrows · Enter turns · H hint · Esc closes' },
    { what: 'Pause', how: 'Esc or P', actions: ['pause'] },
    // SPEC-036 §4.4: one back-stack — the top layer closes first.
    { what: 'Back / close', how: 'Esc' },
  ],
  // SPEC-036 §4.11: the words match the controls — a drag on the right is
  // the fire zone, never a throttle, and the launcher fires from its slot.
  touch: [
    { what: 'Move / steer', how: 'Drag on the left side' },
    { what: 'Aim & fire', how: 'Drag on the right side — auto-fire shoots for you' },
    // SPEC-038 §4.9: the thumb arc's corner cell.
    { what: 'Dash', how: 'DASH button' },
    // SPEC-050 §4.5: no button — the stick's own drawn ring.
    { what: 'Run', how: 'Push the stick past its ring' },
    // SPEC-045 §4.6: the buttons read + and −, as they are drawn.
    { what: 'Throttle (flight)', how: '+ / − buttons' },
    // SPEC-028 §4.5: the bar doubles as the touch buttons. SPEC-037 §4.10:
    // it is the only way now — the weapon-cycle and item buttons are gone.
    { what: 'Switch weapon', how: 'Tap a weapon on the bar' },
    { what: 'Launcher', how: 'Tap its slot to fire it' },
    { what: 'Heal', how: 'Tap the heal slot on the bar' },
    { what: 'Use a pack', how: 'Tap it on the bar; hold to choose' },
    { what: 'Interact', how: 'USE' },
    { what: 'Map', how: 'Tap the minimap' },
    { what: 'Track mission', how: 'Tap the tracker' },
    // SPEC-054 §4.5: LIGHT joins USE in the thumb arc, below only.
    { what: 'Flashlight', how: 'LIGHT (below)' },
    // SPEC-055 §4.9: a tap turns a tile or picks a choice; HINT asks ARIA.
    { what: 'Puzzle', how: 'tap a tile · HINT' },
    { what: 'Pause', how: 'Pause button, or the Back gesture' },
  ],
};

/** §4.5: the rows `scheme` reads — the gamepad scheme reads the keyboard's. */
export function controlRowsFor(scheme: Scheme): readonly ControlRow[] {
  return CONTROL_ROWS[scheme === 'touch' ? 'touch' : 'keyboard'];
}

/** §4.5: the `pause-sheet-row` markup for `scheme`, in one box. */
export function controlsRows(scheme: Scheme): HTMLElement {
  return h(
    'div',
    { class: 'controls-rows' },
    ...controlRowsFor(scheme).map((row) =>
      h('div', { class: 'pause-sheet-row' }, h('span', { class: 'pause-sheet-what' }, row.what), h('span', {}, row.how)),
    ),
  );
}

/**
 * §4.5: the pause menu's Controls — the same sheet, `controls-sheet`, docked in
 * the menu's own `pause-sheet` beside its actions (SPEC-036 §4.8) rather than
 * over them, so Resume stays on screen and on top. The menu holds it only while
 * it is open, so the testid names one sheet at a time.
 */
export function dockedControlsSheet(scheme: Scheme): HTMLElement {
  return testId(controlsRows(scheme), 'controls-sheet');
}

/**
 * §4.5: the rows as a sheet of their own (`controls-sheet`), opened from the
 * settings panel over whatever holds it — the pause menu among them, which
 * closes its docked sheet first. A modal with its own back-stack entry
 * (§4.3): Escape, the system Back, `Close` and a tap outside all close it, and
 * focus goes back to the button that opened it. Returns the close function.
 */
export function openControlsSheet(ui: UiRoot, scheme: Scheme): () => void {
  const backdrop = h('div', { class: 'sheet-backdrop' });
  let closeModal: (() => void) | null = null;
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    backdrop.remove();
    closeModal?.();
  };
  const done = testId(h('button', { class: 'ui-btn', type: 'button', click: close }, 'Close'), 'controls-close');
  const sheet = testId(
    h(
      'div',
      { class: 'sheet panel controls-sheet' },
      h('p', { class: 'sheet-title' }, 'Controls'),
      controlsRows(scheme),
      h('div', { class: 'sheet-actions' }, done),
    ),
    'controls-sheet',
  );
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.append(sheet);
  ui.mount(backdrop, 'overlay');
  closeModal = openModal(sheet, { label: 'Controls', initialFocus: done, onBack: close });
  return close;
}
