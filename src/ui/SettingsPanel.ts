// The shared settings panel (SPEC-014 §4.8): one component, mounted by the
// menu, the station tab and the pause menu, so there is one place to test
// (§2). Everything writes through `SettingsStore.set*` — the stores own
// validation and persistence; this file owns only the controls.
//
// The quality row shows what the detector picked and re-runs it on demand.
// SPEC-015 §4 replaces `detect` with the real benchmark; until then the
// default is the boot rule of SPEC-002 D-G (the renderer's active preset).
import type { QualityPreset } from '@/core/Renderer';
import type { SettingsStore } from '@/core/Settings';
import type { SaveStore, SlotId } from '@/core/Save';
import { SLOTS } from '@/core/Save';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { el, h, testId, type UiRoot } from '@/ui/dom';

/** The slice of the renderer the quality row drives; structural, optional. */
export interface QualityTarget {
  readonly preset: QualityPreset;
  setQuality(preset: QualityPreset): void;
}

export interface SettingsDeps {
  settings: SettingsStore;
  save: SaveStore;
  renderer?: QualityTarget | null;
  /** SPEC-015 §4 injects the real benchmark here (AC-87). */
  detect?: () => QualityPreset;
  /** After a completed reset (AC-95) — the menu refreshes, the station quits. */
  onReset?: () => void;
}

const QUALITY_CHOICES = ['auto', 'low', 'medium', 'high'] as const;
const AUTO_FIRE_CHOICES = [
  ['on', 'On'],
  ['off', 'Off'],
  ['touch', 'Touch only'],
] as const;

export class SettingsPanel {
  readonly #ui: UiRoot;
  readonly #deps: SettingsDeps;
  readonly #root: HTMLDivElement;
  #open = false;

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
    this.#root.querySelector<HTMLElement>('[data-testid="settings-close"]')?.focus();
  }

  hide(): void {
    this.#open = false;
    this.#root.classList.add('is-hidden');
  }

  dispose(): void {
    this.#ui.unmount(this.#root);
  }

  /** Rebuilt on every `show()`: settings change rarely and never in a frame. */
  #render(): void {
    const s = this.#deps.settings;
    const close = testId(h('button', { class: 'ui-btn settings-close', type: 'button', click: () => this.hide() }, 'Close'), 'settings-close');
    this.#root.replaceChildren(
      // `h` skips null children, which is what lets the fullscreen row vanish
      // on iOS without a special case here (AC-92).
      h(
        'div',
        { class: 'settings-body' },
        h('div', { class: 'settings-head' }, h('p', { class: 'settings-title' }, 'Settings'), close),
        this.#audioRows(),
        this.#qualityRow(),
        this.#toggleRow('settings-reduce-motion', 'Reduce motion', s.get().reduceMotion, (on) => s.set({ reduceMotion: on })),
        this.#choiceRow('Auto-fire', AUTO_FIRE_CHOICES, s.autoFire, (mode) => s.setAutoFire(mode)),
        this.#choiceRow(
          'Joystick side',
          [
            ['left', 'Left'],
            ['right', 'Right'],
          ] as const,
          s.joystickSide,
          (side) => s.setJoystickSide(side),
        ),
        this.#toggleRow('settings-mouse-steer', 'Mouse steer (flight)', s.flightMouseSteer, (on) => s.setFlightMouseSteer(on)),
        this.#fullscreenRow(),
        this.#toggleRow('settings-show-fps', 'Show FPS', s.showFps, (on) => s.setShowFps(on)),
        this.#backupSection(),
        this.#resetRow(),
        h(
          'p',
          { class: 'settings-version' },
          `ReaLLM ${__APP_VERSION__} · `,
          h('a', { href: 'assets/LICENSES.md', target: '_blank', rel: 'noreferrer' }, 'Licenses'),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ audio

  #audioRows(): HTMLDivElement {
    const s = this.#deps.settings;
    const rows: readonly [string, string, number, (v: number) => void][] = [
      ['settings-master', 'Master', s.master, (v) => s.setMaster(v)],
      ['settings-music', 'Music', s.music, (v) => s.setMusic(v)],
      ['settings-sfx', 'Effects', s.sfx, (v) => s.setSfx(v)],
    ];
    const box = el('div', 'settings-section');
    for (const [id, label, value, write] of rows) {
      const slider = testId(
        h('input', { type: 'range', min: 0, max: 100, step: 1, value: Math.round(value * 100), 'aria-label': `${label} volume` }),
        id,
      );
      slider.addEventListener('input', () => write(Number(slider.value) / 100));
      box.append(h('label', { class: 'settings-row' }, h('span', {}, label), slider));
    }
    return box;
  }

  // ---------------------------------------------------------------- quality

  #detect(): QualityPreset {
    return this.#deps.detect?.() ?? this.#deps.renderer?.preset ?? 'medium';
  }

  #qualityRow(): HTMLDivElement {
    const s = this.#deps.settings;
    const active = s.quality ?? 'auto';
    const buttons = QUALITY_CHOICES.map((choice) =>
      testId(
        h(
          'button',
          {
            class: `ui-btn seg${choice === active ? ' is-active' : ''}`,
            type: 'button',
            'aria-pressed': String(choice === active),
            click: () => {
              if (choice === 'auto') {
                s.set({ quality: null });
                this.#deps.renderer?.setQuality(this.#detect());
              } else {
                s.setQuality(choice);
                this.#deps.renderer?.setQuality(choice);
              }
              this.#render();
            },
          },
          choice.charAt(0).toUpperCase() + choice.slice(1),
        ),
        `settings-quality-${choice}`,
      ),
    );
    const redetect = testId(
      h(
        'button',
        {
          class: 'ui-btn',
          type: 'button',
          click: () => {
            const picked = this.#detect();
            if (s.quality === null) this.#deps.renderer?.setQuality(picked);
            this.#ui.toast(`Detected quality: ${picked}`, 'info');
            this.#render();
          },
        },
        'Re-detect',
      ),
      'settings-redetect',
    );
    return h(
      'div',
      { class: 'settings-section' },
      h('div', { class: 'settings-row' }, h('span', {}, 'Quality'), h('div', { class: 'settings-seg' }, ...buttons)),
      h('div', { class: 'settings-row' }, h('span', { class: 'settings-note' }, `Benchmark: ${this.#detect()}`), redetect),
    ) as HTMLDivElement;
  }

  // ----------------------------------------------------------------- shared

  #toggleRow(id: string, label: string, value: boolean, write: (on: boolean) => void): HTMLLabelElement {
    const box = testId(h('input', { type: 'checkbox', 'aria-label': label }), id);
    box.checked = value;
    box.addEventListener('change', () => write(box.checked));
    return h('label', { class: 'settings-row' }, h('span', {}, label), box);
  }

  #choiceRow<T extends string>(
    label: string,
    choices: readonly (readonly [T, string])[],
    active: T,
    write: (choice: T) => void,
  ): HTMLDivElement {
    const seg = h(
      'div',
      { class: 'settings-seg' },
      ...choices.map(([value, text]) =>
        h(
          'button',
          {
            class: `ui-btn seg${value === active ? ' is-active' : ''}`,
            type: 'button',
            'aria-pressed': String(value === active),
            click: () => {
              write(value);
              this.#render();
            },
          },
          text,
        ),
      ),
    );
    return h('div', { class: 'settings-row' }, h('span', {}, label), seg) as HTMLDivElement;
  }

  /** AC-92: Android and desktop only — iOS reports `fullscreenEnabled` false. */
  #fullscreenRow(): HTMLLabelElement | null {
    if (!document.fullscreenEnabled) return null;
    const box = testId(h('input', { type: 'checkbox', 'aria-label': 'Fullscreen' }), 'settings-fullscreen');
    box.checked = document.fullscreenElement !== null;
    box.addEventListener('change', () => {
      if (box.checked) void document.documentElement.requestFullscreen().catch(() => (box.checked = false));
      else void document.exitFullscreen().catch(() => undefined);
    });
    return h('label', { class: 'settings-row' }, h('span', {}, 'Fullscreen'), box);
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
    const box = el('div', 'settings-section');
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
                if (result.ok) {
                  paste.value = '';
                  this.#ui.toast('Save imported', 'good');
                }
                // Failures toast from `importCode` itself (SPEC-007 §4.6).
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
