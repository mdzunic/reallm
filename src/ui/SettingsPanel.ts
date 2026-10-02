// The shared settings panel (SPEC-014 §4.8): one component, mounted by the
// menu, the station tab and the pause menu, so there is one place to test
// (§2). Everything writes through `SettingsStore.set*` — the stores own
// validation and persistence; this file owns only the controls.
//
// The quality row shows what the benchmark measured and re-runs it on demand.
// SPEC-015 §4.7 replaced the placeholder detector with the real run, which
// lives in `core/Game.ts` because it needs the renderer: the panel calls
// `redetect()`, reads `settings.benchmark` back and toasts (AC-20).
//
// SPEC-045 §4.2: the panel is six titled sections, rendered from the row
// table in `ui/settingsRows.ts` — which rows, in which order, under which
// testid. This file renders each row by its control; the few that do more
// than write one key (quality, difficulty, fullscreen, service, backup and
// reset) keep a renderer of their own.
import type { BenchmarkOutcome } from '@/core/Benchmark';
import type { Scheme } from '@/core/Input';
import type { QualityPreset } from '@/core/Renderer';
import { BRIGHTNESS_LIMIT, reduceMotionPreset, type Settings, type SettingsStore } from '@/core/Settings';
import { log } from '@/core/Log';
import { offlineStatus, offlineText } from '@/core/Updates';
import type { SaveStore, SlotId } from '@/core/Save';
import { SLOTS } from '@/core/Save';
import type { Difficulty } from '@/data/index';
import { multPercent } from '@/systems/Format';
import { DIFFICULTY_LINES } from '@/systems/UiHelpers';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { openControlsSheet } from '@/ui/ControlsSheet';
import { el, h, keepFocus, openModal, testId, type UiRoot } from '@/ui/dom';
import { rowNote, SETTINGS_SECTIONS, visibleRows, type RowEnv, type SettingsChoice, type SettingsRowDef } from '@/ui/settingsRows';

/** The slice of the renderer the quality row drives; structural, optional. */
export interface QualityTarget {
  readonly preset: QualityPreset;
  setQuality(preset: QualityPreset): void;
}

export interface SettingsDeps {
  settings: SettingsStore;
  save: SaveStore;
  renderer?: QualityTarget | null;
  /**
   * SPEC-015 §4.7: the real benchmark, injected because it needs the renderer
   * (SPEC-014 AC-87). It persists the outcome, puts the quality setting back to
   * auto and applies the measured preset; the panel only shows the answer.
   */
  redetect?: () => Promise<BenchmarkOutcome>;
  /** After a completed reset (AC-95) — the menu refreshes, the station quits. */
  onReset?: () => void;
  /**
   * SPEC-034 §4.13: after an import that rebound the running slot. The panel
   * has already closed and toasted; the host leaves to the main menu, where
   * `Continue` offers the imported run.
   */
  onImported?: () => void;
  /**
   * SPEC-045 §4.2: the scheme the rows are chosen for, read on every render;
   * `'keyboard'` when absent.
   */
  scheme?: () => Scheme;
}

/** A settings key a row writes on its own: everything but the save's difficulty. */
type RowKey = Exclude<SettingsRowDef['key'], 'difficulty' | null>;

/** SPEC-034 §4.13: what an import into the slot in play says on its way out. */
export const IMPORT_REBOUND_TEXT = 'Save imported — returning to the main menu.';

export class SettingsPanel {
  readonly #ui: UiRoot;
  readonly #deps: SettingsDeps;
  readonly #root: HTMLDivElement;
  #open = false;
  /** SPEC-036 §4.4: this panel's back-stack entry while it is open. */
  #releaseBack: (() => void) | null = null;
  /** SPEC-044 §4.3: the open modal's close, which gives focus back. */
  #closeModal: (() => void) | null = null;

  constructor(ui: UiRoot, deps: SettingsDeps) {
    this.#ui = ui;
    this.#deps = deps;
    this.#root = testId(el('div', 'settings panel'), 'settings-panel');
    this.#root.setAttribute('role', 'dialog');
    this.#root.setAttribute('aria-label', 'Settings');
    this.#root.classList.add('is-hidden');
    ui.mount(this.#root, 'overlay');
  }

  get open(): boolean {
    return this.#open;
  }

  show(): void {
    this.#open = true;
    this.#render();
    this.#root.classList.remove('is-hidden');
    // SPEC-036 §4.4: Escape and the system Back close the panel, and only it.
    this.#releaseBack ??= this.#ui.pushBack(() => this.hide());
    // SPEC-044 §4.3: a modal on Close; closing gives focus back to what opened it.
    this.#closeModal ??= openModal(this.#root, {
      label: 'Settings',
      initialFocus: this.#root.querySelector<HTMLElement>('[data-testid="settings-close"]'),
    });
  }

  hide(): void {
    this.#open = false;
    this.#root.classList.add('is-hidden');
    this.#releaseBack?.();
    this.#releaseBack = null;
    this.#releaseModal();
  }

  dispose(): void {
    this.#releaseBack?.();
    this.#releaseBack = null;
    this.#releaseModal();
    this.#ui.unmount(this.#root);
  }

  #releaseModal(): void {
    const close = this.#closeModal;
    this.#closeModal = null;
    close?.();
  }

  /**
   * Rebuilt on every `show()`: settings change rarely and never in a frame.
   * SPEC-044 §4.2: through `keepFocus`, so a toggle pressed by keyboard keeps
   * its focus across the rebuild it causes.
   */
  #render(): void {
    keepFocus(this.#root, () => this.#build());
  }

  /** SPEC-045 §4.2: what decides the visible rows, read on every render. */
  #env(): RowEnv {
    return {
      scheme: this.#deps.scheme?.() ?? 'keyboard',
      vibrate: typeof navigator.vibrate === 'function',
      fullscreen: document.fullscreenEnabled === true,
      saveBound: this.#deps.save.current !== null,
      serviceMode: this.#deps.settings.serviceMode,
    };
  }

  /**
   * SPEC-045 §4.2: the six sections in order, each a titled `section` holding
   * its visible rows in table order; a section with none is left out. The
   * version line and its Licenses link close the Data section.
   */
  #build(): void {
    const env = this.#env();
    const rows = visibleRows(env);
    const close = testId(h('button', { class: 'ui-btn settings-close', type: 'button', click: () => this.hide() }, 'Close'), 'settings-close');
    const sections: HTMLElement[] = [];
    for (const section of SETTINGS_SECTIONS) {
      const mine = rows.filter((row) => row.section === section.id);
      if (mine.length === 0) continue;
      const titleId = `settings-section-title-${section.id}`;
      const box = testId(
        h(
          'section',
          { class: 'settings-section', 'aria-labelledby': titleId },
          h('h3', { class: 'settings-section-title', id: titleId }, section.title),
        ),
        `settings-section-${section.id}`,
      );
      for (const row of mine) {
        const node = this.#row(row, env);
        if (node === null) continue;
        box.append(node);
        const note = rowNote(row, env.scheme);
        if (note !== null) box.append(h('p', { class: 'settings-note' }, note));
      }
      if (section.id === 'data') {
        box.append(
          h(
            'p',
            { class: 'settings-version' },
            `ReaLLM ${__APP_VERSION__} · `,
            h('a', { href: 'assets/LICENSES.md', target: '_blank', rel: 'noreferrer' }, 'Licenses'),
          ),
        );
      }
      sections.push(box);
    }
    this.#root.replaceChildren(
      h(
        'div',
        { class: 'settings-body' },
        h('div', { class: 'settings-head' }, h('p', { class: 'settings-title' }, 'Settings'), h('div', { class: 'settings-head-actions' }, close)),
        ...sections,
      ),
    );
  }

  /** One row by its control; the rows that do more than write a key have their own renderer. */
  #row(row: SettingsRowDef, env: RowEnv): Node | null {
    const s = this.#deps.settings;
    switch (row.id) {
      case 'settings-quality':
        return this.#qualityRow(row);
      case 'settings-brightness':
        return this.#brightnessRow(row);
      case 'settings-fullscreen':
        return this.#fullscreenRow(row);
      case 'settings-controls':
        return this.#controlsButton(row, env.scheme);
      case 'settings-reset-tips':
        return this.#resetTipsRow(row);
      case 'settings-offline':
        // SPEC-040 §4.7: whether this device can play offline yet, read on
        // every render — the worker registers at the first station visit.
        return h('div', { class: 'settings-row' }, testId(h('span', { class: 'settings-note' }, offlineText(offlineStatus())), row.id));
      case 'settings-backup':
        return this.#backupSection();
      case 'settings-reset':
        return this.#resetRow();
      case 'settings-service':
        return this.#serviceSection(row);
      case 'settings-difficulty':
        return this.#difficultyRow(row);
      case 'settings-reduce-motion':
        // SPEC-045 §4.3: the preset — reduce motion and the four settings it
        // seeds, in one `set()`; the rebuild shows the four rows' new state.
        return this.#toggleRow(row, s.get().reduceMotion, (on) => {
          s.set(reduceMotionPreset(on));
          if (this.#open) this.#render();
        });
      default:
        break;
    }
    const key = row.key;
    if (key === null || key === 'difficulty') return null;
    switch (row.control) {
      case 'slider':
        return this.#volumeRow(row, key);
      case 'toggle':
        return this.#toggleRow(row, s.get()[key] === true, (on) => s.set({ [key]: on }));
      case 'choice':
        return this.#choiceRow(row, (choice) => s.get()[key] === choice.value, (choice) => s.set({ [key]: choice.value } as Partial<Settings>));
      default:
        return null;
    }
  }

  // ----------------------------------------------------------------- shared

  #toggleRow(row: SettingsRowDef, value: boolean, write: (on: boolean) => void): HTMLLabelElement {
    const box = testId(h('input', { type: 'checkbox', 'aria-label': row.label }), row.id);
    box.checked = value;
    box.addEventListener('change', () => write(box.checked));
    return h('label', { class: 'settings-row' }, h('span', {}, row.label), box);
  }

  /**
   * SPEC-045 §4.2: a segmented choice — the group `row.id` holding one button
   * per choice, `<row.id>-<suffix>`. A press writes, then the panel rebuilds
   * through `keepFocus`. A stored value no choice holds (a `buttonScale` of 2,
   * 45-l) leaves every segment unpressed.
   */
  #choiceRow(row: SettingsRowDef, active: (choice: SettingsChoice) => boolean, write: (choice: SettingsChoice) => void): HTMLDivElement {
    const buttons = (row.choices ?? []).map((choice) => {
      const on = active(choice);
      return testId(
        h(
          'button',
          {
            class: `ui-btn seg${on ? ' is-active' : ''}`,
            type: 'button',
            'aria-pressed': String(on),
            click: () => {
              write(choice);
              this.#render();
            },
          },
          choice.label,
        ),
        `${row.id}-${choice.suffix}`,
      );
    });
    return h(
      'div',
      { class: 'settings-row' },
      h('span', {}, row.label),
      testId(h('div', { class: 'settings-seg', role: 'group', 'aria-label': row.label }, ...buttons), row.id),
    ) as HTMLDivElement;
  }

  // ------------------------------------------------------------------ audio

  /** The volume buses, 0…100 % on the slider and 0…1 in the store; written on `input`. */
  #volumeRow(row: SettingsRowDef, key: RowKey): HTMLLabelElement {
    const s = this.#deps.settings;
    const value = s.get()[key];
    const slider = testId(
      h('input', {
        type: 'range',
        min: 0,
        max: 100,
        step: 1,
        value: Math.round((typeof value === 'number' ? value : 0) * 100),
        'aria-label': `${row.label} volume`,
      }),
      row.id,
    );
    slider.addEventListener('input', () => s.set({ [key]: Number(slider.value) / 100 }));
    return h('label', { class: 'settings-row' }, h('span', {}, row.label), slider);
  }

  // ------------------------------------------------------------- brightness

  /**
   * SPEC-045 §4.9: −30 … +30 % in steps of 5, written on `input`; the value
   * reads beside it as `+10 %`.
   */
  #brightnessRow(row: SettingsRowDef): HTMLLabelElement {
    const s = this.#deps.settings;
    const limit = Math.round(BRIGHTNESS_LIMIT * 100);
    const readout = h('span', { class: 'settings-value' }, multPercent(1 + s.get().brightness));
    const slider = testId(
      h('input', {
        type: 'range',
        min: -limit,
        max: limit,
        step: 5,
        value: Math.round(s.get().brightness * 100),
        'aria-label': row.label,
      }),
      row.id,
    );
    slider.addEventListener('input', () => {
      s.set({ brightness: Number(slider.value) / 100 });
      readout.textContent = multPercent(1 + s.get().brightness);
    });
    return h('label', { class: 'settings-row' }, h('span', {}, row.label), slider, readout);
  }

  // --------------------------------------------------------------- controls

  /**
   * SPEC-044 §4.5: the controls sheet, reachable outside the pause menu too,
   * spoken to the hands the player is using now; it opens the Controls
   * section (SPEC-045 §4.2). The gamepad reads the keyboard's rows.
   */
  #controlsButton(row: SettingsRowDef, scheme: Scheme): HTMLDivElement {
    const open = testId(
      h(
        'button',
        {
          class: 'ui-btn settings-controls',
          type: 'button',
          click: () => {
            openControlsSheet(this.#ui, scheme === 'touch' ? 'touch' : 'keyboard');
          },
        },
        'Show controls',
      ),
      row.id,
    );
    return h('div', { class: 'settings-row' }, h('span', {}, row.label), open) as HTMLDivElement;
  }

  // ---------------------------------------------------------------- quality

  /** The preset auto resolves to today: the stored measurement, else the active one. */
  #autoPreset(): QualityPreset {
    return this.#deps.settings.get().benchmark?.preset ?? this.#deps.renderer?.preset ?? 'medium';
  }

  /**
   * AC-20: the row reads the stored measurement — preset and ms/frame — and an
   * em dash where nothing has been measured yet.
   */
  #benchmarkNote(): string {
    const stored = this.#deps.settings.get().benchmark;
    if (stored === null) return 'Benchmark: —';
    return `Benchmark: ${stored.preset} · ${stored.msPerFrame.toFixed(1)} ms/frame`;
  }

  /**
   * AC-21: DPR and `targetFps` move with the call below; everything a view read
   * at `enter()` — particle pools, draw distance, shadow map — comes with the
   * next screen, which is what the toast says.
   */
  #applyPreset(preset: QualityPreset, label: string): void {
    this.#deps.renderer?.setQuality(preset);
    this.#ui.toast(`Quality: ${label} — resolution now, the rest at the next screen`, 'info');
  }

  /**
   * The quality choice — `Auto` stores `null` and applies what the benchmark
   * measured — with the benchmark's line and `Re-detect` under it.
   */
  #qualityRow(row: SettingsRowDef): DocumentFragment {
    const s = this.#deps.settings;
    const active = s.quality ?? 'auto';
    const choice = this.#choiceRow(
      row,
      (option) => option.value === active,
      (option) => {
        if (option.value === 'auto') {
          s.set({ quality: null });
          this.#applyPreset(this.#autoPreset(), `auto (${this.#autoPreset()})`);
        } else {
          const preset = option.value as QualityPreset;
          s.setQuality(preset);
          this.#applyPreset(preset, preset);
        }
      },
    );
    const redetect = testId(
      h(
        'button',
        {
          class: 'ui-btn',
          type: 'button',
          click: () => this.#redetect(redetect),
        },
        'Re-detect',
      ),
      'settings-redetect',
    );
    const rows = document.createDocumentFragment();
    rows.append(
      choice,
      h(
        'div',
        { class: 'settings-row' },
        testId(h('span', { class: 'settings-note' }, this.#benchmarkNote()), 'settings-benchmark'),
        redetect,
      ),
    );
    return rows;
  }

  /**
   * §4.7 / 15-j: the run draws its own stress scene for up to two seconds. The
   * button is disabled while it does, so a second press cannot start a second
   * measurement over the first.
   */
  #redetect(button: HTMLButtonElement): void {
    const run = this.#deps.redetect;
    if (run === undefined) {
      // No `Game` behind the panel (a unit harness): say so rather than lie.
      this.#ui.toast(`Quality: ${this.#autoPreset()}`, 'info');
      return;
    }
    button.disabled = true;
    button.textContent = 'Measuring…';
    void run().then(
      (outcome) => {
        const ms = outcome.msPerFrame > 0 ? ` · ${outcome.msPerFrame.toFixed(1)} ms/frame` : '';
        this.#ui.toast(`Detected quality: ${outcome.preset}${ms}`, 'info');
        if (this.#open) this.#render();
        else {
          button.disabled = false;
          button.textContent = 'Re-detect';
        }
      },
      (error: unknown) => {
        log.warn('settings', 'the quality benchmark could not run', error);
        this.#ui.toast('Could not measure this device', 'warn');
        button.disabled = false;
        button.textContent = 'Re-detect';
      },
    );
  }

  // --------------------------------------------------------------- gameplay

  /**
   * SPEC-027 D-16: the button that lets the first-time tips play again.
   * Clearing them destroys nothing a trigger cannot re-show, so it asks
   * nothing before it does it.
   */
  #resetTipsRow(row: SettingsRowDef): HTMLDivElement {
    const s = this.#deps.settings;
    const reset = testId(
      h(
        'button',
        {
          class: 'ui-btn',
          type: 'button',
          click: () => {
            s.set({ tipsSeen: [] });
            this.#ui.toast('Tips reset', 'info');
          },
        },
        'Reset tips',
      ),
      row.id,
    );
    return h('div', { class: 'settings-row' }, h('span', {}, row.label), reset) as HTMLDivElement;
  }

  /**
   * SPEC-038 §4.6: the run's difficulty, changeable mid-game (PLAN §4) — only
   * while a save is bound, so the main menu with no slot shows no row. A press
   * writes `save.meta.difficulty` and saves at once; combat reads it on the
   * next hit, the flight on its next resume, and the death penalty at death.
   * SPEC-045 §4.2: it opens the Gameplay section.
   */
  #difficultyRow(row: SettingsRowDef): DocumentFragment | null {
    const save = this.#deps.save;
    const current = save.current;
    if (current === null) return null;
    const active = current.meta.difficulty;
    const rows = document.createDocumentFragment();
    rows.append(
      this.#choiceRow(
        row,
        (option) => option.value === active,
        (option) => {
          const bound = save.current;
          if (bound === null) return;
          bound.meta.difficulty = option.value as Difficulty;
          save.request('manual');
        },
      ),
      testId(h('p', { class: 'settings-note' }, DIFFICULTY_LINES[active]), 'settings-difficulty-line'),
    );
    return rows;
  }

  // ---------------------------------------------------------------- service

  /**
   * SPEC-032 §4.8: the service override's switch — only while it is on, so
   * nothing here advertises it. It turns it off (the composition root toasts
   * and hides the badge); nothing granted is taken back (E52).
   */
  #serviceSection(row: SettingsRowDef): HTMLDivElement {
    const s = this.#deps.settings;
    return testId(
      h(
        'div',
        { class: 'settings-block' },
        this.#toggleRow(row, true, (on) => {
          s.setServiceMode(on);
          if (this.#open) this.#render();
        }),
        h(
          'p',
          { class: 'settings-note' },
          'Earth Command service override: every world reachable, the hold kept full, and any run skippable.',
        ),
      ),
      'settings-service-section',
    ) as HTMLDivElement;
  }

  // ------------------------------------------------------------- fullscreen

  /**
   * AC-92: Android and desktop only — iOS reports `fullscreenEnabled` false, and
   * the row is not built at all there (its `shown` rule).
   *
   * SPEC-015 AC-37: this toggle is the **only** writer of `settings.fullscreen`.
   * Entering fullscreen on the boot tap never writes it (AC-34), so the stored
   * value stays what the player chose: `null` until they choose, then `true` or
   * `false`. The box therefore shows the *setting*, falling back to whether the
   * page happens to be fullscreen right now when nothing has been chosen —
   * leaving fullscreen by a system gesture is not a preference (15-f, AC-36).
   */
  #fullscreenRow(row: SettingsRowDef): HTMLLabelElement {
    const s = this.#deps.settings;
    return this.#toggleRow(row, s.get().fullscreen ?? document.fullscreenElement !== null, (wanted) => {
      s.set({ fullscreen: wanted });
      if (wanted) void document.documentElement.requestFullscreen().catch(() => undefined);
      else void document.exitFullscreen().catch(() => undefined);
    });
  }

  // ----------------------------------------------------------------- backup

  /** The slot backup writes to: the bound run first, then the first occupied. */
  #backupSlot(): SlotId {
    const bound = this.#deps.save.current?.meta.slot;
    if (bound !== undefined) return bound;
    const occupied = this.#deps.save.list().find((summary) => !summary.empty);
    return occupied?.slot ?? SLOTS[0];
  }

  #backupSection(): HTMLDivElement {
    const save = this.#deps.save;
    const box = el('div', 'settings-block');
    box.append(h('p', { class: 'settings-subtitle' }, 'Backup'));
    if (!save.codesSupported) {
      // 07-f: no CompressionStream, no codes — say so instead of failing on tap.
      box.append(h('p', { class: 'settings-note' }, 'Save codes need a newer browser.'));
      return box;
    }
    const slot = this.#backupSlot();
    const out = testId(h('textarea', { class: 'settings-code', rows: 2, readonly: true, 'aria-label': 'Export code' }), 'settings-export-code');
    const exportBtn = testId(
      h(
        'button',
        {
          class: 'ui-btn',
          type: 'button',
          click: () => {
            void save.exportCode(slot).then((code) => {
              out.value = code;
              void navigator.clipboard?.writeText(code).then(
                () => this.#ui.toast('Save code copied', 'good'),
                () => this.#ui.toast('Copy the code from the field below', 'info'),
              );
            });
          },
        },
        'Copy code',
      ),
      'settings-export',
    );
    const actions = h('div', { class: 'settings-actions' }, exportBtn);
    // The share sheet exists only where the platform offers one (phones).
    if (typeof navigator.share === 'function') {
      actions.append(
        h(
          'button',
          {
            class: 'ui-btn',
            type: 'button',
            click: () => {
              void save.exportCode(slot).then((code) => {
                out.value = code;
                void navigator.share({ title: 'ReaLLM save', text: code }).catch(() => undefined);
              });
            },
          },
          'Share',
        ),
      );
    }
    const paste = testId(h('textarea', { class: 'settings-code', rows: 2, placeholder: 'Paste a save code (RLM1…)', 'aria-label': 'Import code' }), 'settings-import-code');
    const importBtn = testId(
      h(
        'button',
        {
          class: 'ui-btn',
          type: 'button',
          click: () => {
            const code = paste.value.trim();
            if (code === '') return;
            void confirmSheet(this.#ui, {
              title: `Import this code into slot ${slot + 1}?`,
              body: 'The slot is overwritten; its backup keeps one previous save.',
              confirmText: 'Import',
              danger: true,
            }).then((yes) => {
              if (!yes) return;
              void save.importCode(code, slot).then((result) => {
                if (!result.ok) return; // failures toast from `importCode` itself (SPEC-007 §4.6)
                paste.value = '';
                // SPEC-034 §4.13: an import into the slot in play has taken the
                // binding, so the character behind this panel is gone — say so
                // and leave, rather than let the menu's Continue lie.
                if (result.rebound === true) {
                  this.hide();
                  this.#ui.toast(IMPORT_REBOUND_TEXT, 'good');
                  this.#deps.onImported?.();
                  return;
                }
                this.#ui.toast('Save imported', 'good');
              });
            });
          },
        },
        'Import',
      ),
      'settings-import',
    );
    box.append(h('div', { class: 'settings-row' }, out, actions), h('div', { class: 'settings-row' }, paste, importBtn));
    return box;
  }

  // ------------------------------------------------------------------ reset

  /** AC-95: twice-asked, then the bound slot (or every slot) is gone. */
  #resetRow(): HTMLDivElement {
    const save = this.#deps.save;
    const reset = testId(
      h(
        'button',
        {
          class: 'ui-btn is-danger',
          type: 'button',
          click: () => {
            const bound = save.current?.meta.slot;
            const what = bound !== undefined ? `slot ${bound + 1}` : 'all three slots';
            void confirmSheet(this.#ui, { title: `Reset save — delete ${what}?`, danger: true, confirmText: 'Delete' }).then((first) => {
              if (!first) return;
              void confirmSheet(this.#ui, {
                title: 'Really delete? This cannot be undone.',
                body: 'The backup copy is deleted with it.',
                danger: true,
                confirmText: 'Delete forever',
              }).then((second) => {
                if (!second) return;
                if (bound !== undefined) save.delete(bound);
                else for (const slot of SLOTS) save.delete(slot);
                this.#ui.toast('Save deleted', 'warn');
                this.#deps.onReset?.();
              });
            });
          },
        },
        'Reset save',
      ),
      'settings-reset',
    );
    return h('div', { class: 'settings-row settings-reset-row' }, h('span', {}, 'Reset'), reset) as HTMLDivElement;
  }
}
