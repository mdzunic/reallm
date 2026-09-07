// The pause menu of a pausable scene (SPEC-003 §4.5, SPEC-014 §4.7). It is a
// UI layer inside the scene, never a scene of its own (D-1), and the game
// leaves it only on an explicit action: a tap on Resume, or Enter / Space
// while it holds focus — which a focused button gives us for free. Escape and
// P are handled by the composition root, which toggles pause and resume; the
// touch pause button and the app-hidden path arrive through the scene (AC-82).
//
// §4.7: Resume, Settings (the shared panel), Controls (a scheme-aware
// cheat-sheet, SPEC-005), Save & Quit (flush the save, back to the menu).
// The music duck while it is open stays the scene's (SPEC-006 AC-54, AC-83).
import type { SaveStore } from '@/core/Save';
import type { SettingsStore } from '@/core/Settings';
import { el, h, testId, uiLayers } from '@/ui/dom';
import { SettingsPanel, type QualityTarget } from '@/ui/SettingsPanel';

/** What the menu needs from the services container; structural on purpose. */
export interface PauseDeps {
  uiRoot: HTMLElement;
  settings: SettingsStore;
  save: SaveStore;
  input: { readonly state: { readonly scheme: 'keyboard' | 'touch' | 'gamepad' } };
  renderer?: QualityTarget;
  go(id: 'menu', params: { reason?: 'start' | 'quit' | 'error' }): Promise<boolean>;
}

/** AC-84: the cheat-sheet rows, per scheme (bindings are SPEC-005's). */
const CONTROL_SHEETS = {
  keyboard: [
    ['Move / steer', 'WASD or Arrow keys'],
    ['Aim', 'Mouse'],
    ['Fire', 'Space or Left mouse'],
    ['Interact', 'E or F'],
    ['Use item', 'Q or 1'],
    ['Throttle (flight)', 'Shift up · Ctrl down'],
    ['Map', 'M'],
    ['Pause', 'Esc or P'],
  ],
  touch: [
    ['Move / steer', 'Drag on the left side'],
    ['Aim & fire', 'Drag on the right side'],
    ['Throttle (flight)', 'Drag up / down on the right'],
    ['Interact / Use item', 'On-screen buttons'],
    ['Pause', 'Pause button'],
  ],
  gamepad: [['Controls', 'Gamepad bindings follow the keyboard sheet']],
} as const;

export class PauseMenu {
  readonly #deps: PauseDeps;
  readonly #root: HTMLDivElement;
  readonly #resume: HTMLButtonElement;
  readonly #controls: HTMLDivElement;
  readonly #settings: SettingsPanel;
  #quitting = false;

  constructor(deps: PauseDeps, onResume: () => void) {
    this.#deps = deps;
    this.#root = testId(el('div', 'overlay-panel overlay-pause'), 'pause-menu');
    this.#root.setAttribute('role', 'dialog');
    this.#root.setAttribute('aria-label', 'Paused');

    this.#settings = new SettingsPanel(uiLayers(deps.uiRoot), {
      settings: deps.settings,
      save: deps.save,
      renderer: deps.renderer ?? null,
    });

    this.#resume = testId(el('button', 'pause-resume ui-btn', 'Resume'), 'pause-resume');
    this.#resume.type = 'button';
    this.#resume.addEventListener('click', onResume);

    const settings = testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#settings.show() }, 'Settings'), 'pause-settings');
    const controls = testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#toggleControls() }, 'Controls'), 'pause-controls');
    const quit = testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#saveAndQuit() }, 'Save & Quit'), 'pause-quit');

    this.#controls = testId(el('div', 'pause-sheet is-hidden'), 'pause-sheet');

    this.#root.append(
      el('p', 'pause-title', 'Paused'),
      h('div', { class: 'pause-actions' }, this.#resume, settings, controls, quit),
      this.#controls,
    );
    deps.uiRoot.append(this.#root);
  }

  get open(): boolean {
    return this.#root.classList.contains('is-visible');
  }

  show(): void {
    this.#root.classList.add('is-visible');
    this.#resume.focus();
  }

  hide(): void {
    this.#root.classList.remove('is-visible');
    this.#controls.classList.add('is-hidden');
    this.#settings.hide();
  }

  dispose(): void {
    this.#settings.dispose();
    this.#root.remove();
  }

  /** AC-84: rebuilt on each open, so it follows the scheme that is live now. */
  #toggleControls(): void {
    if (!this.#controls.classList.toggle('is-hidden')) {
      const scheme = this.#deps.input.state.scheme;
      this.#controls.replaceChildren(
        ...CONTROL_SHEETS[scheme].map(([what, how]) =>
          h('div', { class: 'pause-sheet-row' }, h('span', { class: 'pause-sheet-what' }, what), h('span', {}, how)),
        ),
      );
    }
  }

  /** AC-85: the save is flushed before the scene machine is asked to leave. */
  #saveAndQuit(): void {
    if (this.#quitting) return;
    this.#quitting = true;
    this.#deps.save.request('manual');
    this.#deps.save.flush();
    void this.#deps.go('menu', { reason: 'quit' }).then((went) => {
      if (!went) this.#quitting = false;
    });
  }
}
