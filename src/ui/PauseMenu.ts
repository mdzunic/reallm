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
//
// SPEC-044: the menu opens as a modal on Resume (§4.3); Controls docks the one
// controls sheet, `controls-sheet`, built from `CONTROL_ROWS` (§4.5); and with
// a quit hook, Save & Quit first says what the quit costs (§4.8).
//
// SPEC-045 §4.1: with a comms log — the surface's and the flight's dialogue
// layer's — `Comms log` follows Controls, so a line missed in a fight can be
// read again. §4.8: Resume is a plain `ui-btn`, styled like its neighbours.
//
// SPEC-048 §4.4: the log's sheet has the salvager's Notes as its second tab,
// and `Comms log` wears the `notes-new` dot while a clue found this session is
// unread there.
import type { BenchmarkOutcome } from '@/core/Benchmark';
import type { SaveStore } from '@/core/Save';
import type { SettingsStore } from '@/core/Settings';
import { storyContextOf } from '@/systems/StoryContext';
import { openCommsLog, type CommsLog } from '@/ui/CommsLog';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { dockedControlsSheet } from '@/ui/ControlsSheet';
import { el, h, openModal, testId, uiLayers } from '@/ui/dom';
import { notesFor, NOTES_UNSEEN, syncNotesDot } from '@/ui/NotesPanel';
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
  /** SPEC-045 §4.1: the dialogue layer's log; the surface and the flight pass it, and `Comms log` shows. */
  comms?: CommsLog;
  /**
   * SPEC-048 §4.4: the last chapter Notes lists — the planet's, in play.
   * Absent, the save's own (`storyContextOf`).
   */
  notesChapter?: () => number;
}

/**
 * SPEC-045 §4.1: `deps` with the dialogue layer's log beside it, for the
 * surface and the flight. Their deps are the services bag — the `Game`, whose
 * methods read private fields — so it is wrapped by delegation, not spread.
 * The copy names every key of `PauseDeps`, optional ones included: a field
 * added there and not carried here is a compile error, not a menu without it.
 */
export function withComms(deps: PauseDeps, comms: CommsLog, notesChapter?: () => number): PauseDeps {
  const detect = deps.detectQuality;
  const wrapped: PauseDeps & Record<keyof PauseDeps, unknown> = {
    uiRoot: deps.uiRoot,
    settings: deps.settings,
    save: deps.save,
    input: deps.input,
    renderer: deps.renderer,
    detectQuality: detect === undefined ? undefined : () => detect.call(deps),
    go: (id, params) => deps.go(id, params),
    comms,
    notesChapter,
  };
  return wrapped;
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

/**
 * SPEC-044 §4.8: the surface's and the flight's Save & Quit. `note()` is asked
 * on every press — `quitNote` with the planet and its fuel — and becomes the
 * body of the sheet the press opens.
 */
export interface PauseQuit {
  note(): string;
}

/** SPEC-044 §4.8: the quit sheet's title. */
export const QUIT_TITLE = 'Quit to the main menu?';

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
  readonly #quit: PauseQuit | null;
  /** SPEC-036 §4.4: this menu's back-stack entry while it is open. */
  #releaseBack: (() => void) | null = null;
  /** SPEC-044 §4.3: the open modal's close, which gives focus back. */
  #closeModal: (() => void) | null = null;
  /** SPEC-045 §4.1: the open comms log's close, or `null`. */
  #closeComms: (() => void) | null = null;
  /** SPEC-048 §4.4: `pause-comms`, which wears the `notes-new` dot. */
  readonly #commsButton: HTMLButtonElement | null;
  #quitting = false;

  constructor(deps: PauseDeps, onResume: () => void, skip?: PauseSkip, recall?: PauseRecall, quit?: PauseQuit) {
    this.#deps = deps;
    this.#onResume = onResume;
    this.#quit = quit ?? null;
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
      // SPEC-045 §4.2: the rows follow the hands the player is using.
      scheme: () => deps.input.state.scheme,
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

    // SPEC-045 §4.8: a plain `ui-btn`, so it is styled like Settings beside it.
    this.#resume = testId(el('button', 'ui-btn', 'Resume'), 'pause-resume');
    this.#resume.type = 'button';
    this.#resume.addEventListener('click', onResume);

    const settings = testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#openSettings() }, 'Settings'), 'pause-settings');
    const controls = testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#toggleControls() }, 'Controls'), 'pause-controls');
    const log = deps.comms;
    const comms =
      log === undefined
        ? null
        : testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#openComms(log) }, 'Comms log'), 'pause-comms');
    this.#commsButton = comms;
    const quitButton = testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#quitPressed() }, 'Save & Quit'), 'pause-quit');

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
      h('div', { class: 'pause-actions' }, this.#resume, settings, controls, comms, skipButton, recallButton, quitButton),
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
    // SPEC-048 §4.4: the dot, as the menu opens.
    this.refreshNotes();
    this.#root.classList.add('is-visible');
    // SPEC-036 §4.4: Escape and the system Back resume, as Resume does.
    this.#releaseBack ??= uiLayers(this.#deps.uiRoot).pushBack(() => this.#onResume());
    // SPEC-044 §4.3: a modal on Resume, so Enter right away resumes.
    this.#closeModal ??= openModal(this.#root, { label: 'Paused', initialFocus: this.#resume });
  }

  hide(): void {
    this.#root.classList.remove('is-visible');
    this.#closeControls();
    this.#closeCommsLog();
    this.#settings.hide();
    this.#releaseBack?.();
    this.#releaseBack = null;
    this.#releaseModal();
  }

  dispose(): void {
    this.#closeCommsLog();
    this.#releaseBack?.();
    this.#releaseBack = null;
    this.#releaseModal();
    this.#settings.dispose();
    this.#screen.dispose();
  }

  #releaseModal(): void {
    const close = this.#closeModal;
    this.#closeModal = null;
    close?.();
  }

  /**
   * AC-84: rebuilt on each open, so it follows the scheme that is live now.
   * SPEC-044 §4.5: the sheet is the controls sheet, `controls-sheet`, the same
   * the settings panel opens; the gamepad scheme reads the keyboard's rows.
   */
  #toggleControls(): void {
    if (this.#controls.classList.toggle('is-hidden')) this.#controls.replaceChildren();
    else this.#controls.replaceChildren(dockedControlsSheet(this.#deps.input.state.scheme));
  }

  /** A closed sheet holds nothing, so `controls-sheet` names one sheet at a time. */
  #closeControls(): void {
    this.#controls.classList.add('is-hidden');
    this.#controls.replaceChildren();
  }

  /**
   * SPEC-045 §4.1: the comms log over the menu (45-f: a line's hold keeps
   * running behind the pause, and this is the recovery). Escape closes the
   * log first and focus comes back to `pause-comms`.
   */
  #openComms(log: CommsLog): void {
    this.#closeCommsLog();
    // SPEC-048 §4.4: Notes for the save in play; opening it takes the dot down.
    const save = this.#deps.save.current;
    const chapter = this.#deps.notesChapter;
    const notes =
      save === null
        ? null
        : notesFor(save, chapter ?? (() => storyContextOf(save).chapter), () => this.refreshNotes());
    const close = openCommsLog(uiLayers(this.#deps.uiRoot), log, notes?.notes ?? (() => null), notes?.fill);
    this.#closeComms = (): void => {
      this.#closeComms = null;
      close();
    };
  }

  #closeCommsLog(): void {
    this.#closeComms?.();
  }

  /**
   * SPEC-048 §4.4: `pause-comms` wears the `notes-new` dot while the save in
   * play has a clue found this session and unread in Notes. Asked on every
   * open, by the Notes tab when it opens, and by the scene on `story:clue`.
   */
  refreshNotes(): void {
    const save = this.#deps.save.current;
    syncNotesDot(this.#commsButton, save !== null && NOTES_UNSEEN.has(save));
  }

  /**
   * SPEC-044 §4.5: the settings panel opens over the menu with its own
   * Controls, so the docked sheet closes first; there is one controls sheet.
   */
  #openSettings(): void {
    this.#closeControls();
    this.#settings.show();
  }

  /**
   * SPEC-044 §4.8: with a quit hook — the surface and the flight — the press
   * first asks, naming what the quit costs, with `Keep playing` focused; only
   * `Quit` runs today's save-and-quit. Without one it quits at once.
   */
  #quitPressed(): void {
    if (this.#quitting) return;
    const quit = this.#quit;
    if (quit === null) {
      this.#saveAndQuit();
      return;
    }
    void confirmSheet(uiLayers(this.#deps.uiRoot), {
      title: QUIT_TITLE,
      body: quit.note(),
      confirmText: 'Quit',
      cancelText: 'Keep playing',
      focus: 'cancel',
    }).then((yes) => {
      if (yes) this.#saveAndQuit();
    });
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
