// The pause menu of a pausable scene (SPEC-003 §4.5, SPEC-014 §4.7). It is a
// UI layer inside the scene, never a scene of its own (D-1), and the game
// leaves it only on an explicit action: a tap on Resume, or Enter / Space
// while it holds focus — which a focused button gives us for free. While it is
// open it is an entry on the back-stack (SPEC-036 §4.4), so Escape and the
// system Back resume through the same path Resume does, once every layer above
// it has closed; P is the composition root's toggle, and the touch pause
// button and the app-hidden path arrive through the scene (AC-82).
//
// §4.7: Resume, Settings (the shared panel), Controls (a scheme-aware
// cheat-sheet, SPEC-005), Save & Quit (flush the save, back to the menu).
// The music duck while it is open stays the scene's (SPEC-006 AC-54, AC-83).
import type { BenchmarkOutcome } from '@/core/Benchmark';
import type { SaveStore } from '@/core/Save';
import type { SettingsStore } from '@/core/Settings';
import { confirmSheet } from '@/ui/ConfirmSheet';
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

/**
 * SPEC-032 §4.4: the flight scene's `Skip the run`. `allowed()` is asked on
 * every open, so the entry follows `runSkip` as it is now; `run()` is called
 * once per press, with the entry already disabled (32-d).
 */
export interface PauseSkip {
  allowed(): boolean;
  run(): void;
}

/**
 * SPEC-034 §4.2: the surface scene's `Recall to pad` — the universal way out of
 * a corner. `allowed()` is asked on every open, like `PauseSkip`'s; `run()` is
 * called once the confirm sheet is answered.
 */
export interface PauseRecall {
  allowed(): boolean;
  run(): void;
}

/** SPEC-034 §4.2: the confirm sheet a `Recall to pad` press opens. */
export const RECALL_TITLE = 'Recall to pad';
export const RECALL_BODY = 'Return to the landing pad? Timed objectives restart.';

/** AC-84: the cheat-sheet rows, per scheme (bindings are SPEC-005's). */
const CONTROL_SHEETS = {
  keyboard: [
    ['Move / steer', 'WASD or Arrow keys'],
    ['Aim', 'Mouse'],
    // SPEC-038 §4.7, §4.9: the gun fires on its own; a held button aims it.
    ['Fire', 'Automatic — hold Space or Left mouse to aim'],
    ['Dash', 'Right mouse or V'],
    ['Interact', 'E or F'],
    // SPEC-028 §4.8: the loadout keys — the digits switch, Q heals.
    ['Switch weapon', '1 / 2 / 3, R or wheel'],
    ['Heal', 'Q'],
    ['Throw / plant', 'G'],
    ['Gadget', 'C'],
    // SPEC-034 §4.16: X, not Ctrl — Ctrl+W closes the tab next to WASD.
    ['Throttle (flight)', 'Shift up · X down'],
    // SPEC-026 §4.7: M opens the surface map; T cycles the tracked mission.
    ['Map', 'M'],
    ['Track mission', 'T'],
    ['Pause', 'Esc or P'],
  ],
  // SPEC-036 §4.11: the words match the controls — a drag on the right is
  // the fire zone, never a throttle, and the launcher fires from its slot.
  touch: [
    ['Move / steer', 'Drag on the left side'],
    ['Aim & fire', 'Drag on the right side — auto-fire shoots for you'],
    // SPEC-038 §4.9: the thumb arc's corner cell.
    ['Dash', 'DASH button'],
    ['Throttle (flight)', '▲ / ▼ buttons'],
    // SPEC-028 §4.5: the bar doubles as the touch buttons. SPEC-037 §4.10:
    // it is the only way now — the weapon-cycle and item buttons are gone.
    ['Switch weapon', 'Tap a weapon on the bar'],
    ['Launcher', 'Tap its slot to fire it'],
    ['Heal', 'Tap the heal slot on the bar'],
    ['Use a pack', 'Tap it on the bar; hold to choose'],
    ['Interact', 'USE'],
    ['Map', 'Tap the minimap'],
    ['Track mission', 'Tap the tracker'],
    ['Pause', 'Pause button, or the Back gesture'],
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
  readonly #skip: { readonly button: HTMLButtonElement; readonly hooks: PauseSkip } | null;
  readonly #recall: { readonly button: HTMLButtonElement; readonly hooks: PauseRecall } | null;
  readonly #onResume: () => void;
  /** SPEC-036 §4.4: this menu's back-stack entry while it is open. */
  #releaseBack: (() => void) | null = null;
  #quitting = false;

  constructor(deps: PauseDeps, onResume: () => void, skip?: PauseSkip, recall?: PauseRecall) {
    this.#deps = deps;
    this.#onResume = onResume;
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
      // SPEC-034 §4.13: an import into the slot in play rebinds the store, so
      // the run behind this menu is no longer the save — leave to the menu.
      onImported: () => {
        this.hide();
        void this.#deps.go('menu', { reason: 'quit' });
      },
    });

    this.#resume = testId(el('button', 'pause-resume ui-btn', 'Resume'), 'pause-resume');
    this.#resume.type = 'button';
    this.#resume.addEventListener('click', onResume);

    const settings = testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#settings.show() }, 'Settings'), 'pause-settings');
    const controls = testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#toggleControls() }, 'Controls'), 'pause-controls');
    const quit = testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#saveAndQuit() }, 'Save & Quit'), 'pause-quit');

    this.#controls = testId(el('div', 'pause-sheet is-hidden'), 'pause-sheet');

    // SPEC-032 §4.4: flight only, above Save & Quit, shown while it is allowed.
    let skipButton: HTMLButtonElement | null = null;
    if (skip !== undefined) {
      const button = testId(h('button', { class: 'ui-btn is-hidden', type: 'button' }, 'Skip the run'), 'pause-skip-run');
      button.addEventListener('click', () => {
        if (button.disabled) return;
        button.disabled = true; // 32-d: one press, one skip
        skip.run();
      });
      skipButton = button;
    }
    this.#skip = skipButton === null || skip === undefined ? null : { button: skipButton, hooks: skip };

    // SPEC-034 §4.2: the surface's `Recall to pad`, above Save & Quit, shown
    // while it is allowed. The flight menu never passes one.
    let recallButton: HTMLButtonElement | null = null;
    if (recall !== undefined) {
      const button = testId(h('button', { class: 'ui-btn is-hidden', type: 'button' }, RECALL_TITLE), 'pause-recall');
      button.addEventListener('click', () => {
        if (button.disabled) return;
        void confirmSheet(uiLayers(deps.uiRoot), {
          title: RECALL_TITLE,
          body: RECALL_BODY,
          confirmText: 'Recall',
          cancelText: 'Cancel',
        }).then((yes) => {
          if (!yes || !recall.allowed()) return;
          recall.run();
        });
      });
      recallButton = button;
    }
    this.#recall = recallButton === null || recall === undefined ? null : { button: recallButton, hooks: recall };

    this.#screen.body.append(
      h('div', { class: 'pause-actions' }, this.#resume, settings, controls, skipButton, recallButton, quit),
      this.#controls,
    );
    deps.uiRoot.append(this.#root);
  }

  get open(): boolean {
    return this.#root.classList.contains('is-visible');
  }

  show(): void {
    const skip = this.#skip;
    if (skip !== null) {
      const allowed = skip.hooks.allowed();
      skip.button.classList.toggle('is-hidden', !allowed);
      skip.button.disabled = !allowed;
    }
    // SPEC-034 §4.2: recall follows the same per-open predicate.
    const recall = this.#recall;
    if (recall !== null) {
      const allowed = recall.hooks.allowed();
      recall.button.classList.toggle('is-hidden', !allowed);
      recall.button.disabled = !allowed;
    }
    this.#root.classList.add('is-visible');
    // SPEC-036 §4.4: Escape and the system Back resume, as Resume does.
    this.#releaseBack ??= uiLayers(this.#deps.uiRoot).pushBack(() => this.#onResume());
    this.#resume.focus();
  }

  hide(): void {
    this.#root.classList.remove('is-visible');
    this.#controls.classList.add('is-hidden');
    this.#settings.hide();
    this.#releaseBack?.();
    this.#releaseBack = null;
  }

  dispose(): void {
    this.#releaseBack?.();
    this.#releaseBack = null;
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
