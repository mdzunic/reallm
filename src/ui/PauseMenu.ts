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
import type { BenchmarkOutcome } from '@/core/Benchmark';
import type { SaveStore } from '@/core/Save';
import type { SettingsStore } from '@/core/Settings';
import { el, h, testId, uiLayers } from '@/ui/dom';
import { createScreen, type Screen } from '@/ui/Screen';
import { SettingsPanel, type QualityTarget } from '@/ui/SettingsPanel';

/** What the menu needs from the services container; structural on purpose. */
export interface PauseDeps {
  uiRoot: HTMLElement;
  settings: SettingsStore;
  save: SaveStore;
  input: { readonly state: { readonly scheme: 'keyboard' | 'touch' | 'gamepad' } };
  renderer?: QualityTarget;
  /** SPEC-015 §4.7: the settings panel's `Re-detect`, where a `Game` supplies one. */
  detectQuality?(): Promise<BenchmarkOutcome>;
  go(id: 'menu', params: { reason?: 'start' | 'quit' | 'error' }): Promise<boolean>;
}

/** AC-84: the cheat-sheet rows, per scheme (bindings are SPEC-005's). */
const CONTROL_SHEETS = {
  keyboard: [
    ['Move / steer', 'WASD or Arrow keys'],
    ['Aim', 'Mouse'],
    ['Fire', 'Space or Left mouse'],
    ['Interact', 'E or F'],
    // SPEC-028 §4.8: the loadout keys — the digits switch, Q heals.
    ['Switch weapon', '1 / 2 / 3, R or wheel'],
    ['Heal', 'Q'],
    ['Throw / plant', 'G'],
    ['Gadget', 'C'],
    ['Throttle (flight)', 'Shift up · Ctrl down'],
    // SPEC-026 §4.7: M opens the surface map; T cycles the tracked mission.
    ['Map', 'M'],
    ['Track mission', 'T'],
    ['Pause', 'Esc or P'],
  ],
  touch: [
    ['Move / steer', 'Drag on the left side'],
    ['Aim & fire', 'Drag on the right side'],
    ['Throttle (flight)', 'Drag up / down on the right'],
    // SPEC-028 §4.5: the bar doubles as the touch buttons.
    ['Switch weapon', 'SWAP, or tap a weapon on the bar'],
    ['Use a pack', 'Tap it on the bar; hold to choose'],
    ['Interact / Use item', 'On-screen buttons'],
    ['Pause', 'Pause button'],
  ],
  gamepad: [['Controls', 'Gamepad bindings follow the keyboard sheet']],
} as const;

export class PauseMenu {
  readonly #deps: PauseDeps;
  readonly #screen: Screen;
  readonly #root: HTMLDivElement;
  readonly #resume: HTMLButtonElement;
  readonly #controls: HTMLDivElement;
  readonly #settings: SettingsPanel;
  #quitting = false;

  constructor(deps: PauseDeps, onResume: () => void) {
    this.#deps = deps;
    // SPEC-031 §4.4: the pause menu wears the console frame too — SYSTEM HOLD
    // on the channel — while staying a UI layer inside its scene, never a
    // scene of its own (D-1). Hidden until `show()`.
    this.#screen = createScreen({ id: 'pause' });
    this.#root = this.#screen.root;
    this.#root.classList.add('overlay-pause');
    this.#root.setAttribute('role', 'dialog');
    this.#root.setAttribute('aria-label', 'Paused');
    const frame = this.#root.querySelector('.screen-frame');
    if (frame instanceof HTMLElement) testId(frame, 'pause-menu');

    this.#settings = new SettingsPanel(uiLayers(deps.uiRoot), {
      settings: deps.settings,
      save: deps.save,
      renderer: deps.renderer ?? null,
      // SPEC-015 15-j: `Re-detect` from the pause menu draws the stress scene
      // for up to two seconds; the simulation stays paused behind it.
      redetect: deps.detectQuality?.bind(deps),
    });

    this.#resume = testId(el('button', 'pause-resume ui-btn', 'Resume'), 'pause-resume');
    this.#resume.type = 'button';
    this.#resume.addEventListener('click', onResume);

    const settings = testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#settings.show() }, 'Settings'), 'pause-settings');
    const controls = testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#toggleControls() }, 'Controls'), 'pause-controls');
    const quit = testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#saveAndQuit() }, 'Save & Quit'), 'pause-quit');

    this.#controls = testId(el('div', 'pause-sheet is-hidden'), 'pause-sheet');

    this.#screen.body.append(
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
    this.#screen.dispose();
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
