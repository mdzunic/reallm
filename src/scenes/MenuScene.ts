// The real main menu (SPEC-014 §4.1). A slow procedural starfield behind the
// title, the five buttons, the two slot flows (New Game picks, Load manages),
// the credits reader and the shared settings panel. SPEC-007's `SavePanel`
// moves here as promised in the placeholder: it stays the storage banner and
// the corrupt-slot rescue surface, while this scene owns the play surface.
//
// The menu also keeps SPEC-002's asset spike (the rigged character and the
// ship with its sRGB map): the M0 acceptance suite reads `clip`, `clipTime`
// and `shipMap` off this scene's `debugInfo()`, and a salvager idling beside
// the ship is exactly what this screen wanted anyway.
import * as THREE from 'three';
import { log } from '@/core/Log';
import type { GameServices } from '@/core/Services';
import { SLOTS, type SaveV1, type SlotId } from '@/core/Save';
import type { SceneParams } from '@/core/StateMachine';
import { slotLine } from '@/systems/UiHelpers';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { el, h, testId } from '@/ui/dom';
import { SavePanel } from '@/ui/SavePanel';
import { SettingsPanel } from '@/ui/SettingsPanel';
import { UiScene, uiRootEl } from '@/scenes/base';

const STAR_COUNT = 420;

/** iPadOS reports MacIntel with touch; both are Safari without persist prompts. */
function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** `''` when the model carries no colour map at all (SPEC-002 AC-52). */
function colourMapSpace(root: THREE.Object3D): string {
  let space = '';
  root.traverse((node) => {
    if (space !== '') return;
    const material = (node as THREE.Mesh).material;
    for (const entry of Array.isArray(material) ? material : [material]) {
      const map = (entry as THREE.MeshStandardMaterial | undefined)?.map;
      if (map) space = map.colorSpace === THREE.SRGBColorSpace ? 'srgb' : (map.colorSpace || 'none');
    }
  });
  return space;
}

type SubPanel = 'new' | 'load' | 'credits' | null;

export class MenuScene extends UiScene<'menu'> {
  #stars: THREE.Points | null = null;
  #mixer: THREE.AnimationMixer | null = null;
  #action: THREE.AnimationAction | null = null;
  #clip = '';
  #shipMap = '';

  #root: HTMLDivElement | null = null;
  #buttons: HTMLDivElement | null = null;
  #sub: HTMLDivElement | null = null;
  #savePanel: SavePanel | null = null;
  #settings: SettingsPanel | null = null;
  #openSub: SubPanel = null;
  /** Which slot has its import paste field open in the Load list. */
  #importing: SlotId | null = null;
  #leaving = false;

  constructor(services: GameServices) {
    super(services, 'menu', 'menu');
  }

  protected onEnter(_params: SceneParams['menu']): void {
    // SPEC-006 AC-28: warm both tracks the menu can crossfade into next.
    void this.services.audio.preloadMusic(['menu', 'station']);
    this.#buildStars();
    if (this.services.assets.loaded) {
      try {
        this.#buildSpike();
      } catch (error) {
        log.warn('scene', 'the asset spike could not be built; the menu runs without it', error);
      }
    }
    this.#mountUi();
  }

  protected override onUpdate(dt: number): void {
    if (this.#stars) this.#stars.rotation.y = this.elapsed * 0.008;
    this.#mixer?.update(dt);
  }

  override debugInfo(): Record<string, number | string> {
    const info = super.debugInfo();
    // SPEC-002 D-I / AC-22: the menu's rotating object, readable from outside.
    // The starfield is that object now; the boot-gate suite watches it turn.
    if (this.#stars) info['spin'] = this.#stars.rotation.y;
    if (this.#clip !== '') {
      info['clip'] = this.#clip;
      info['clipTime'] = this.#action?.time ?? 0;
    }
    if (this.#shipMap !== '') info['shipMap'] = this.#shipMap;
    return info;
  }

  // ------------------------------------------------------------------ Three

  /** AC-1: the slow starfield. Deterministic scatter — no RNG, no asset. */
  #buildStars(): void {
    const positions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      // A fractional-part hash per axis: stable across runs, wart-free to test.
      const a = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
      const b = ((Math.sin(i * 78.233) * 12578.1459) % 1 + 1) % 1;
      const c = ((Math.sin(i * 39.425) * 26251.5439) % 1 + 1) % 1;
      positions[i * 3] = (a - 0.5) * 24;
      positions[i * 3 + 1] = (b - 0.5) * 14;
      positions[i * 3 + 2] = -2 - c * 20;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color: 0xbfd4e6, size: 0.05, sizeAttenuation: true });
    this.#stars = new THREE.Points(geometry, material);
    this.scene.add(this.#stars);
    this.props = 1;
  }

  /** SPEC-002 §4.5: the rigged character with its clip, and the mapped ship. */
  #buildSpike(): void {
    const assets = this.services.assets;
    const character = assets.model('character');
    character.position.set(-1.7, -0.9, 0);
    this.scene.add(character);
    const clip = assets.animations('character')[0];
    if (clip) {
      const mixer = new THREE.AnimationMixer(character);
      this.#mixer = mixer;
      this.#action = mixer.clipAction(clip);
      this.#action.play();
      this.#clip = clip.name;
      this.disposer.add(() => {
        mixer.stopAllAction();
        mixer.uncacheRoot(character);
      });
    }
    const ship = assets.model('ship');
    ship.position.set(1.7, 0, 0);
    ship.rotation.y = -0.6;
    this.scene.add(ship);
    this.#shipMap = colourMapSpace(ship);
  }

  // -------------------------------------------------------------------- DOM

  #mountUi(): void {
    const root = uiRootEl();
    // SPEC-007's panel: the storage banner (AC-10, E8) and the corrupt-slot
    // rescue keep their own surface and testids.
    this.#savePanel = new SavePanel(root, this.services.save);
    this.disposer.add(() => {
      this.#savePanel?.dispose();
      this.#savePanel = null;
    });

    this.#settings = new SettingsPanel(this.ui, {
      settings: this.services.settings,
      save: this.services.save,
      renderer: this.services.renderer,
      onReset: () => this.#refresh(),
    });
    this.disposer.add(() => {
      this.#settings?.dispose();
      this.#settings = null;
    });

    this.#buttons = el('div', 'menu-buttons');
    this.#sub = el('div', 'menu-sub');
    this.#root = testId(el('div', 'menu-root'), 'menu-root');
    this.#root.append(h('h1', { class: 'menu-title' }, 'ReaLLM'), this.#buttons, this.#sub);
    if (this.services.settings.get().persistGranted === false && isIos()) {
      // AC-11: iOS never granted persistence — remind before the run matters.
      const hint = testId(el('p', 'menu-hint', 'Backup your save'), 'backup-hint');
      this.#root.append(hint);
    }
    this.ui.mount(this.#root, 'panel');
    this.disposer.add(() => {
      if (this.#root) this.ui.unmount(this.#root);
      this.#root = null;
      this.#buttons = null;
      this.#sub = null;
    });

    // AC-12: arrow keys walk the menu's buttons; Enter clicks the focused one.
    const onKey = (event: KeyboardEvent): void => this.#onArrows(event);
    document.addEventListener('keydown', onKey);
    this.disposer.add(() => document.removeEventListener('keydown', onKey));

    // A save appearing while the menu is open — the dev bridge, an import, the
    // E8 memory-only create whose first flush reports `unavailable` — must
    // surface Continue without a reload (AC-2).
    this.disposer.add(this.services.events.on('save:written', () => this.#refresh(), this));
    this.disposer.add(this.services.events.on('save:failed', () => this.#refresh(), this));

    this.#refresh();
    this.#buttons.querySelector('button')?.focus();
  }

  /** Rebuilds the button column and the open sub-panel from the slots. */
  #refresh(): void {
    if (this.#buttons === null) return;
    const continueTarget = this.#continueTarget();
    const buttons = [
      // AC-2: hidden — not built at all — when there is nothing to continue.
      continueTarget === null
        ? null
        : testId(h('button', { class: 'ui-btn is-primary', type: 'button', click: () => this.#continue() }, 'Continue'), 'go-station'),
      testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#toggleSub('new') }, 'New Game'), 'menu-new'),
      testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#toggleSub('load') }, 'Load'), 'menu-load'),
      testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#settings?.show() }, 'Settings'), 'menu-settings'),
      testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#toggleSub('credits') }, 'Credits'), 'menu-credits'),
    ];
    this.#buttons.replaceChildren(...buttons.filter((button): button is HTMLButtonElement => button !== null));
    this.#renderSub();
    this.#savePanel?.refresh();
  }

  #toggleSub(panel: Exclude<SubPanel, null>): void {
    this.#openSub = this.#openSub === panel ? null : panel;
    this.#importing = null;
    this.#renderSub();
  }

  #renderSub(): void {
    if (this.#sub === null) return;
    switch (this.#openSub) {
      case null:
        this.#sub.replaceChildren();
        return;
      case 'new':
        this.#renderNew();
        return;
      case 'load':
        this.#renderLoad();
        return;
      case 'credits':
        this.#renderCredits();
        return;
    }
  }

  // -------------------------------------------------------------- continue

  /**
   * AC-2: the last save slot — the one SPEC-007 records in `lastSlot` when it
   * writes, falling back to the freshest `updatedAt`. A memory-only session
   * (E8) has a bound save and no readable slots; it continues too.
   */
  #continueTarget(): { slot: SlotId; data: SaveV1 } | 'bound' | null {
    if (this.services.save.current !== null) return 'bound';
    const loadable: { slot: SlotId; data: SaveV1 }[] = [];
    for (const slot of SLOTS) {
      const result = this.services.save.load(slot);
      if (result.ok) loadable.push({ slot, data: result.data });
    }
    if (loadable.length === 0) return null;
    const last = this.services.settings.get().lastSlot;
    return loadable.find((entry) => entry.slot === last) ?? loadable.reduce((a, b) => (b.data.meta.updatedAt > a.data.meta.updatedAt ? b : a));
  }

  #continue(): void {
    if (this.#leaving) return;
    const target = this.#continueTarget();
    if (target === null) return;
    if (target !== 'bound') this.services.save.bind(target.data);
    this.#leaving = true;
    void this.services.go('station', {}).then((went) => {
      if (!went) this.#leaving = false;
    });
  }

  // -------------------------------------------------------------- new game

  /** AC-3: three rows; an occupied one asks before it is overwritten. */
  #renderNew(): void {
    if (this.#sub === null) return;
    const rows = this.services.save.list().map((summary) => {
      const slot = summary.slot;
      const button = testId(
        h(
          'button',
          {
            class: 'ui-btn menu-slot',
            type: 'button',
            click: () => {
              if (summary.empty) {
                this.#startCreation(slot);
                return;
              }
              void confirmSheet(
                this.ui,
                { title: `Overwrite slot ${slot + 1}?`, body: 'The save in it is lost when the new game first writes.', confirmText: 'Overwrite', danger: true },
              ).then((yes) => {
                if (yes) this.#startCreation(slot);
              });
            },
          },
          `Slot ${slot + 1} · ${slotLine(summary)}`,
        ),
        `new-slot-${slot}`,
      );
      return h('div', { class: 'menu-row' }, button);
    });
    this.#sub.replaceChildren(h('div', { class: 'menu-list panel' }, h('p', { class: 'menu-list-title' }, 'New game — pick a slot'), ...rows));
  }

  #startCreation(slot: SlotId): void {
    if (this.#leaving) return;
    this.#leaving = true;
    void this.services.go('creation', { slot }).then((went) => {
      if (!went) this.#leaving = false;
    });
  }

  // ------------------------------------------------------------------ load

  /** AC-4..7: summaries with Load / Delete / Import, and the E9 special row. */
  #renderLoad(): void {
    if (this.#sub === null) return;
    const save = this.services.save;
    const rows = SLOTS.map((slot) => {
      const result = save.load(slot);
      const line = el('span', 'menu-slot-text');
      const actions = el('div', 'menu-slot-actions');
      if (result.ok) {
        const { player, progress, meta } = result.data;
        line.textContent = slotLine({
          slot,
          empty: false,
          name: player.name,
          classId: player.classId,
          level: player.level,
          planet: progress.currentPlanet,
          playtimeSec: meta.playtimeSec,
        });
        actions.append(
          testId(
            h(
              'button',
              {
                class: 'ui-btn is-primary',
                type: 'button',
                click: () => {
                  if (this.#leaving) return;
                  save.bind(result.data);
                  this.#leaving = true;
                  void this.services.go('station', {}).then((went) => {
                    if (!went) this.#leaving = false;
                  });
                },
              },
              'Load',
            ),
            `load-slot-${slot}`,
          ),
          this.#deleteButton(slot),
          ...this.#importButton(slot),
        );
      } else if (result.reason === 'newer_version') {
        // AC-7 / E9: named, and offered nothing but the way out.
        line.textContent = 'Save from a newer version';
        actions.append(this.#exportButton(slot));
      } else if (result.reason === 'corrupt') {
        line.textContent = 'Corrupt';
        actions.append(this.#deleteButton(slot), ...this.#importButton(slot));
      } else {
        line.textContent = 'Empty';
        actions.append(...this.#importButton(slot));
      }
      const row = testId(el('div', 'menu-row'), `load-row-${slot}`);
      row.append(el('span', 'menu-slot-label', `Slot ${slot + 1}`), line, actions);
      if (this.#importing === slot) row.append(this.#importField(slot));
      return row;
    });
    this.#sub.replaceChildren(h('div', { class: 'menu-list panel' }, h('p', { class: 'menu-list-title' }, 'Load'), ...rows));
  }

  #deleteButton(slot: SlotId): HTMLButtonElement {
    return testId(
      h(
        'button',
        {
          class: 'ui-btn is-danger',
          type: 'button',
          click: () => {
            // AC-5: never silently.
            void confirmSheet(this.ui, {
              title: `Delete slot ${slot + 1}?`,
              body: 'The backup copy is deleted with it.',
              confirmText: 'Delete',
              danger: true,
            }).then((yes) => {
              if (!yes) return;
              this.services.save.delete(slot);
              this.#refresh();
            });
          },
        },
        'Delete',
      ),
      `load-slot-${slot}-delete`,
    );
  }

  /** An array so call sites can spread it away on a code-less browser (07-f). */
  #importButton(slot: SlotId): HTMLButtonElement[] {
    // No codes on this browser — the entry point is not offered at all.
    if (!this.services.save.codesSupported) return [];
    return [
      testId(
        h(
          'button',
          {
            class: 'ui-btn',
            type: 'button',
            click: () => {
              this.#importing = this.#importing === slot ? null : slot;
              this.#renderSub();
              this.#sub?.querySelector<HTMLTextAreaElement>('.menu-code')?.focus();
            },
          },
          'Import code',
        ),
        `load-slot-${slot}-import`,
      ),
    ];
  }

  /** AC-6: paste → confirm → the slot holds the imported character. */
  #importField(slot: SlotId): HTMLDivElement {
    const field = testId(h('textarea', { class: 'menu-code', rows: 2, placeholder: 'Paste a save code (RLM1…)', 'aria-label': `Save code for slot ${slot + 1}` }), `load-slot-${slot}-code`);
    const restore = testId(
      h(
        'button',
        {
          class: 'ui-btn',
          type: 'button',
          click: () => {
            const code = field.value.trim();
            if (code === '') return;
            void confirmSheet(this.ui, {
              title: `Import this code into slot ${slot + 1}?`,
              body: 'Whatever the slot holds is replaced.',
              confirmText: 'Import',
              danger: true,
            }).then((yes) => {
              if (!yes) return;
              void this.services.save.importCode(code, slot).then((result) => {
                // Failures toast from `importCode` itself (SPEC-007 §4.6);
                // the field stays open for another paste.
                if (!result.ok) return;
                this.#importing = null;
                this.ui.toast('Save imported', 'good');
                this.#refresh();
              });
            });
          },
        },
        'Restore',
      ),
      `load-slot-${slot}-restore`,
    );
    return h('div', { class: 'menu-import' }, field, restore) as HTMLDivElement;
  }

  #exportButton(slot: SlotId): HTMLButtonElement {
    return testId(
      h(
        'button',
        {
          class: 'ui-btn',
          type: 'button',
          click: () => {
            void this.services.save.exportCode(slot).then(
              (code) =>
                void navigator.clipboard?.writeText(code).then(
                  () => this.ui.toast('Save code copied', 'good'),
                  () => this.ui.toast(code, 'info', 8000),
                ),
            );
          },
        },
        'Export',
      ),
      `load-slot-${slot}-export`,
    );
  }

  // --------------------------------------------------------------- credits

  /** AC-9: `LICENSES.md` as plain text; a missing file is named, not thrown. */
  #renderCredits(): void {
    if (this.#sub === null) return;
    const body = testId(el('pre', 'credits-text', 'Loading…'), 'credits-text');
    this.#sub.replaceChildren(h('div', { class: 'menu-list panel credits' }, h('p', { class: 'menu-list-title' }, 'Credits'), body));
    void fetch('assets/LICENSES.md')
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then(
        (text) => {
          body.textContent = text;
        },
        () => {
          body.textContent = 'Licenses file not found.';
        },
      );
  }

  // -------------------------------------------------------------- keyboard

  #onArrows(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const root = this.#root;
    if (root === null) return;
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = buttons[(at + step + buttons.length) % buttons.length];
    next?.focus();
    event.preventDefault();
  }
}
