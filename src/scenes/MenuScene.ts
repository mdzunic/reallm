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
import { applyUpdate, updateReady } from '@/core/Updates';
import { nextInstanceOffered, slotSummaryOf, SLOTS, type Save, type SlotId } from '@/core/Save';
import type { SceneParams } from '@/core/StateMachine';
import { COMMENDATION_IDS, CREDITS, CREDITS_VERSION_LINE } from '@/data/index';
import { bestTimeRows, recordsRows, recordsRowStatus, recordsTitle } from '@/systems/Commendations';
import { Economy } from '@/systems/Economy';
import { Progression } from '@/systems/Progression';
import { applySupplies, EMPTY_CODE, pushCode } from '@/systems/Service';
import { RECORDS, recordsOffText } from '@/systems/Records';
import { awayMs, previouslyCard, RESUME_WINDOW_MS, resumeTarget } from '@/systems/Resume';
import { shareAtMenu } from '@/systems/Share';
import { archiveLine, beginInstanceText, NEWER_SAVE_TEXT, nextInstanceSheet, restoreArchiveSheet, slotLine } from '@/systems/UiHelpers';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { installAvailable, onInstallChange, promptInstall } from '@/ui/InstallButton';
import { openResumeCard } from '@/ui/ResumeCard';
import { prepareSaveCard, shareButton } from '@/ui/ShareCard';
import { el, h, keepFocus, testId, topModal } from '@/ui/dom';
import { SavePanel } from '@/ui/SavePanel';
import { SettingsPanel } from '@/ui/SettingsPanel';
import type { Look } from '@/core/Quality';
import { NEUTRAL_SKY } from '@/views/Environment';
import { addHubLights, hubSkyMesh, loadHubSky } from '@/views/HubBackdrop';
import { UiScene, bindTouchScheme } from '@/scenes/base';
import { director } from '@/scenes/Director';
import { createScreen } from '@/ui/Screen';

const STAR_COUNT = 420;

/** SPEC-032 §4.6: how long the build label is held to toggle service mode. */
const SERVICE_PRESS_MS = 3_000;

/** SPEC-017 §4.1 (*initial tuning*): a deep, slightly cool title screen. */
const MENU_LOOK: Partial<Look> = { vignette: 0.45, bloomStrength: 0.5, bloomThreshold: 0.7, saturation: 0.95 };
/** The hub environment intensity of §4.4. */
const HUB_ENVIRONMENT_INTENSITY = 0.9;

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

/** SPEC-059 §4.4.5 adds `records`, the fourth. */
type SubPanel = 'new' | 'load' | 'credits' | 'records' | null;

export class MenuScene extends UiScene<'menu'> {
  /** §4.4: every mesh this screen draws hangs off this one group. */
  readonly #backdrop = new THREE.Group();
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
  /** SPEC-036 §4.4: the open sub-panel's back-stack entry. */
  #releaseSub: (() => void) | null = null;
  /** Which slot has its import paste field open in the Load list. */
  #importing: SlotId | null = null;
  #leaving = false;
  /** SPEC-059 §4.1.3: the "previously" card is up, waiting for its answer. */
  #asking = false;
  /** SPEC-059 §4.5.5: the escaped save's share, keyed by the save it was drawn for. */
  #share: { key: string; box: HTMLDivElement } | null = null;

  constructor(services: GameServices) {
    super(services, 'menu', 'menu');
  }

  protected override look(): Partial<Look> {
    return MENU_LOOK;
  }

  protected onEnter(_params: SceneParams['menu']): void {
    // SPEC-022 §4.11: the first director() call installs the dev film bridge,
    // and the menu is the boot scene on every path — including `?scene=`.
    director(this.services);
    // SPEC-006 AC-28: warm both tracks the menu can crossfade into next.
    void this.services.audio.preloadMusic(['menu', 'station']);
    this.useEnvironment(NEUTRAL_SKY, HUB_ENVIRONMENT_INTENSITY);
    this.#buildBackdrop();
    this.#buildStars();
    if (this.services.assets.loaded) {
      try {
        this.#buildSpike();
      } catch (error) {
        log.warn('scene', 'the asset spike could not be built; the menu runs without it', error);
      }
    }
    this.#mountUi();
    this.#watchServiceGestures();
    // SPEC-059 §4.1.4: a "previously" card still up when the menu goes leaves with it, loading nothing.
    this.disposer.add(() => {
      if (this.#asking) this.ui.root.querySelector<HTMLButtonElement>('[data-testid="resume-back"]')?.click();
    });
  }

  /**
   * SPEC-032 §4.6: the two ways into (and out of) service mode, alive only
   * while the menu is (32-g, 32-k). Typing `asdf` anywhere but a text field
   * (E53), or holding the build label for 3 s — a press that is then kept
   * from the stats overlay's five-tap counter.
   */
  #watchServiceGestures(): void {
    let code = EMPTY_CODE;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      const out = pushCode(code, event.key.toLowerCase(), performance.now());
      code = out.state;
      if (out.matched) this.#toggleServiceMode();
    };
    document.addEventListener('keydown', onKey);
    this.disposer.add(() => document.removeEventListener('keydown', onKey));

    const label = document.querySelector('[data-testid="version-label"]');
    if (!(label instanceof HTMLElement)) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** The long press fired: its pointerup is not a tap. */
    let consumed = false;
    const clear = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const down = (): void => {
      clear();
      consumed = false;
      timer = setTimeout(() => {
        timer = null;
        consumed = true;
        this.#toggleServiceMode();
      }, SERVICE_PRESS_MS);
    };
    // Captured at the document, so the stats overlay's own `pointerup` on the
    // label never sees the press that toggled the mode (SPEC-002 §4.6).
    const up = (event: PointerEvent): void => {
      clear();
      if (!consumed) return;
      consumed = false;
      if (event.target instanceof Node && label.contains(event.target)) event.stopPropagation();
    };
    label.addEventListener('pointerdown', down);
    label.addEventListener('pointercancel', clear);
    label.addEventListener('pointerleave', clear);
    document.addEventListener('pointerup', up, true);
    // A long press on a phone would otherwise raise the text callout.
    const menu = (event: Event): void => {
      if (consumed || timer !== null) event.preventDefault();
    };
    label.addEventListener('contextmenu', menu);
    this.disposer.add(() => {
      clear();
      label.removeEventListener('pointerdown', down);
      label.removeEventListener('pointercancel', clear);
      label.removeEventListener('pointerleave', clear);
      label.removeEventListener('contextmenu', menu);
      document.removeEventListener('pointerup', up, true);
    });
  }

  /**
   * Flip the setting — the composition root raises the toast and the badge —
   * and, turning it on with a save bound, top the supplies up at once (§4.6).
   */
  #toggleServiceMode(): void {
    const settings = this.services.settings;
    const on = !settings.serviceMode;
    settings.setServiceMode(on);
    const data = this.services.save.current;
    if (!on || data === null) return;
    const economy = new Economy(data, this.services.events, new Progression(data, this.services.events), this.services.save);
    economy.serviceMode = true;
    applySupplies(data, economy);
    this.services.save.request('station_enter');
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

  /**
   * SPEC-020 §4.4: the menu's backdrop — the starfield and SPEC-002's spike —
   * under one `Group`, lit by the shared key + rim pair, in front of the
   * station's nebula window. `props` stays the 1 the stats overlay pins: the
   * starfield is still the scene's own prop, and the window arrives lazily.
   */
  #buildBackdrop(): void {
    const group = this.#backdrop;
    addHubLights(group);
    this.scene.add(group);
    let alive = true;
    this.disposer.add(() => {
      alive = false;
    });
    loadHubSky(this.services.assets, () => alive, (sky) => group.add(hubSkyMesh(sky)));
  }

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
    this.#backdrop.add(this.#stars);
    this.props = 1;
  }

  /** SPEC-002 §4.5: the rigged character with its clip, and the mapped ship. */
  #buildSpike(): void {
    const assets = this.services.assets;
    const character = assets.model('character');
    character.position.set(-1.7, -0.9, 0);
    this.#backdrop.add(character);
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
    this.#backdrop.add(ship);
    this.#shipMap = colourMapSpace(ship);
  }

  // -------------------------------------------------------------------- DOM

  #mountUi(): void {
    // SPEC-031 §4.4: the menu mounts one console frame; the wordmark is the
    // frame's own title, wearing the `.menu-title` treatment.
    const screen = createScreen({ id: 'menu' });
    screen.root.querySelector('.screen-title')?.classList.add('menu-title');
    bindTouchScheme(screen.root, this.services, this.disposer, this);

    this.#settings = new SettingsPanel(this.ui, {
      settings: this.services.settings,
      save: this.services.save,
      renderer: this.services.renderer,
      // SPEC-045 §4.2: the rows follow the hands the player is using.
      scheme: () => this.services.input.state.scheme,
      // SPEC-015 AC-20: `Re-detect` runs the real boot benchmark.
      redetect: this.services.detectQuality?.bind(this.services),
      onReset: () => this.#refresh(),
      // SPEC-034 §4.13: already at the menu — `Continue` re-reads the slot.
      onImported: () => this.#refresh(),
    });
    this.disposer.add(() => {
      this.#settings?.dispose();
      this.#settings = null;
    });

    this.#buttons = el('div', 'menu-buttons');
    this.#sub = el('div', 'menu-sub');
    this.#root = testId(el('div', 'menu-root'), 'menu-root');
    this.#root.append(this.#buttons, this.#sub);

    // SPEC-007's panel, as the body's Storage block (SPEC-031 §4.8): the
    // corrupt-slot rescue keeps its surface and testids, and the E8 banner
    // goes to the frame footer.
    const storage = testId(el('div', 'screen-block menu-storage'), 'menu-storage');
    storage.append(el('p', 'screen-block-title', 'Storage'));
    this.#savePanel = new SavePanel(storage, this.services.save, { bannerHost: screen.footer, ui: this.ui });
    this.disposer.add(() => {
      this.#savePanel?.dispose();
      this.#savePanel = null;
    });
    this.#root.append(storage);

    if (this.services.settings.get().persistGranted === false && isIos()) {
      // AC-11: iOS never granted persistence — remind before the run matters.
      const hint = testId(el('p', 'menu-hint', 'Backup your save'), 'backup-hint');
      this.#root.append(hint);
    }
    screen.body.append(this.#root);
    this.ui.mount(screen.root, 'panel');
    this.disposer.add(() => {
      this.#releaseSub?.();
      this.#releaseSub = null;
      this.#share = null;
      this.ui.unmount(screen.root);
      screen.dispose();
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
    // SPEC-015 §10: a build that lands while the menu is open adds its button
    // without the screen having to poll for it.
    this.disposer.add(this.services.events.on('app:update-ready', () => this.#refresh(), this));
    // SPEC-059 §4.6.5 (59-n): so does a kept install prompt, and an install takes it away.
    this.disposer.add(onInstallChange(() => this.#refresh()));

    this.#refresh();
    this.#buttons.querySelector('button')?.focus();
  }

  /**
   * Rebuilds the button column and the open sub-panel from the slots —
   * SPEC-044 §4.2: through `keepFocus` on the menu root, so a save landing
   * while a button holds focus does not throw it back to the page.
   */
  #refresh(): void {
    const root = this.#root;
    if (root === null) return;
    keepFocus(root, () => this.#rebuild());
  }

  #rebuild(): void {
    if (this.#buttons === null) return;
    const continueTarget = this.#continueTarget();
    this.#syncShare(continueTarget);
    const buttons = [
      // AC-2: hidden — not built at all — when there is nothing to continue.
      continueTarget === null
        ? null
        : testId(h('button', { class: 'ui-btn is-primary', type: 'button', click: () => this.#continue() }, 'Continue'), 'go-station'),
      testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#toggleSub('new') }, 'New Game'), 'menu-new'),
      testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#toggleSub('load') }, 'Load'), 'menu-load'),
      // SPEC-059 §4.4.5: this device's commendations and best times, after Load.
      testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#toggleSub('records') }, 'Records'), 'menu-records'),
      testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#settings?.show() }, 'Settings'), 'menu-settings'),
      testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#toggleSub('credits') }, 'Credits'), 'menu-credits'),
      // SPEC-059 §4.6.5: while the browser's install prompt is kept. A press
      // spends it, whatever the answer, and the button goes with it.
      installAvailable()
        ? testId(h('button', { class: 'ui-btn', type: 'button', click: () => void promptInstall() }, 'Install'), 'menu-install')
        : null,
      // SPEC-015 AC-52: offered here and at the station only, and only while a
      // build is actually waiting. `applyUpdate` is `updateSW(true)` — nothing
      // reloads the page on its own (15-c).
      updateReady()
        ? testId(h('button', { class: 'ui-btn is-primary', type: 'button', click: () => applyUpdate() }, 'Update'), 'menu-update')
        : null,
    ];
    this.#buttons.replaceChildren(...buttons.filter((button): button is HTMLButtonElement => button !== null));
    this.#renderSub();
    this.#savePanel?.refresh();
  }

  /**
   * SPEC-059 §4.5.5: `ending-share` under the button column while the save
   * Continue would enter has escaped and not yet played its restore lines
   * (`shareAtMenu`). The card is drawn on the first render that shows it and
   * kept while the same save is the one shown; the element is in the column
   * only while it shows, so the buttons never move for an empty slot.
   */
  #syncShare(target: { slot: SlotId; data: Save } | 'bound' | null): void {
    const data = target === null ? null : target === 'bound' ? this.services.save.current : target.data;
    const buttons = this.#buttons;
    if (data === null || buttons === null || !shareAtMenu(data)) {
      this.#share?.box.remove();
      this.#share = null;
      return;
    }
    const key = `${data.meta.slot}:${data.meta.updatedAt}`;
    if (this.#share?.key !== key) {
      this.#share?.box.remove();
      const card = prepareSaveCard(data, this.services.settings.get().commendations);
      const box = el('div', 'menu-share');
      box.append(shareButton('ending-share', card, this.ui));
      this.#share = { key, box };
    }
    if (this.#share.box.previousElementSibling !== buttons) buttons.after(this.#share.box);
  }

  /**
   * Opens `panel`, or closes it when it is the one open; `null` closes
   * whichever is. SPEC-036 §4.4: an open sub-panel is a back-stack entry, so
   * Escape and the system Back close it — and with none open, Back at the menu
   * root leaves the page.
   */
  #toggleSub(panel: SubPanel): void {
    this.#openSub = panel === null || this.#openSub === panel ? null : panel;
    this.#importing = null;
    if (this.#openSub === null) {
      this.#releaseSub?.();
      this.#releaseSub = null;
    } else {
      this.#releaseSub ??= this.ui.pushBack(() => this.#toggleSub(null));
    }
    this.#renderSub();
  }

  /** SPEC-044 §4.2: the open sub-panel, rebuilt through `keepFocus` on the menu root. */
  #renderSub(): void {
    const root = this.#root;
    if (root === null) return;
    keepFocus(root, () => this.#buildSub());
  }

  #buildSub(): void {
    if (this.#sub === null) return;
    // SPEC-035 §4.13: New Game opens its slot list as a sheet over the menu
    // body, so the button column does not move under the cursor. The storage
    // block goes `visibility: hidden` rather than out of flow — removing it
    // would re-centre the column, which is the very thing being fixed.
    const sheet = this.#openSub === 'new';
    this.#sub.classList.toggle('is-sheet', sheet);
    this.#root?.classList.toggle('is-sheet-open', sheet);
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
      case 'records':
        this.#renderRecords();
        return;
    }
  }

  // -------------------------------------------------------------- continue

  /**
   * AC-2: the last save slot — the one SPEC-007 records in `lastSlot` when it
   * writes, falling back to the freshest `updatedAt`. A memory-only session
   * (E8) has a bound save and no readable slots; it continues too.
   */
  #continueTarget(): { slot: SlotId; data: Save } | 'bound' | null {
    if (this.services.save.current !== null) return 'bound';
    const loadable: { slot: SlotId; data: Save }[] = [];
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
    const data = target === 'bound' ? this.services.save.current : target.data;
    if (data !== null) void this.#enterSave(data);
  }

  /**
   * SPEC-059 §4.1.3: Continue and `load-slot-<n>` share one path. The save's
   * resume target first; after a day away the "previously" card, whose Back
   * ends it with nothing bound (59-p); then the bind, and the planet's pad —
   * with the point cleared in memory, so a landing that fails to enter leaves
   * the next Continue at the station (59-e) — or the station, as before.
   */
  async #enterSave(data: Save): Promise<void> {
    if (this.#leaving || this.#asking) return;
    const services = this.services;
    const target = resumeTarget(data, services.settings.serviceMode);
    if (awayMs(data, Date.now()) >= RESUME_WINDOW_MS) {
      this.#asking = true;
      const go = await openResumeCard(this.ui, previouslyCard(data, target));
      this.#asking = false;
      if (!go || this.#root === null || this.#leaving) return;
    }
    if (services.save.current !== data) services.save.bind(data);
    this.#leaving = true;
    let went: Promise<boolean>;
    if (target.scene === 'surface') {
      data.progress.resume = null;
      went = services.go('surface', { planet: target.planet, firstLanding: false, resumed: true });
    } else {
      went = services.go('station', {});
    }
    void went.then((entered) => {
      if (!entered) this.#leaving = false;
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

  /**
   * SPEC-022 §4.9: New Game plays the prologue after the slot is chosen (and
   * after any overwrite confirm), then enters creation when it ends or is
   * skipped. The sub-panel closes as the film starts, so a second click
   * cannot start a second film; `?scene=creation` and the dev bridge enter
   * creation directly and never come through here.
   */
  #startCreation(slot: SlotId): void {
    if (this.#leaving) return;
    this.#leaving = true;
    this.#openSub = null;
    this.#renderSub();
    void director(this.services)
      .playFilm('prologue', { musicAfter: 'menu' })
      .then(() => this.services.go('creation', { slot }))
      .then((went) => {
        if (!went) this.#leaving = false;
      });
  }

  // ------------------------------------------------------------------ load

  /**
   * AC-4..7: summaries with Load / Delete / Import, and the E9 special row.
   * SPEC-058 §4.1, §4.3: an ended run's row offers `Begin instance/{next}`,
   * and a slot with an archive gains its line and `Archive` — the way to
   * restore it once.
   */
  #renderLoad(): void {
    if (this.#sub === null) return;
    const save = this.services.save;
    const rows = SLOTS.map((slot) => {
      const result = save.load(slot);
      const line = el('span', 'menu-slot-text');
      const actions = el('div', 'menu-slot-actions');
      let archived: HTMLElement | null = null;
      if (result.ok) {
        const archive = save.loadArchive(slot);
        const summary = slotSummaryOf(slot, result.data, archive.ok ? archive.data : null);
        line.textContent = slotLine(summary);
        if (summary.archive !== undefined) archived = testId(el('span', 'menu-slot-archive', archiveLine(summary.archive)), `load-slot-${slot}-archive-line`);
        actions.append(
          testId(
            h(
              'button',
              {
                class: 'ui-btn is-primary',
                type: 'button',
                // SPEC-059 §4.1.3: the same path as Continue.
                click: () => void this.#enterSave(result.data),
              },
              'Load',
            ),
            `load-slot-${slot}`,
          ),
          ...(nextInstanceOffered(result.data) ? [this.#nextInstanceButton(slot, result.data)] : []),
          ...(archive.ok ? [this.#archiveButton(slot, archive.data, result.data)] : []),
          this.#deleteButton(slot),
          ...this.#importButton(slot),
        );
      } else if (result.reason === 'newer_version') {
        // AC-7 / E9: named, and offered nothing but the way out.
        line.textContent = NEWER_SAVE_TEXT;
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
      if (archived !== null) row.append(archived);
      if (this.#importing === slot) row.append(this.#importField(slot));
      return row;
    });
    this.#sub.replaceChildren(h('div', { class: 'menu-list panel' }, h('p', { class: 'menu-list-title' }, 'Load'), ...rows));
  }

  /**
   * SPEC-058 §4.1: `Begin instance/{next}` — the station's `Next instance`
   * from the menu: the same sheet, in the slot save's own numbers, then
   * creation in next mode with no prologue. Cancel changes nothing.
   */
  #nextInstanceButton(slot: SlotId, data: Save): HTMLButtonElement {
    return testId(
      h(
        'button',
        {
          class: 'ui-btn',
          type: 'button',
          click: () => {
            if (this.#leaving) return;
            void confirmSheet(this.ui, nextInstanceSheet(data.meta.iteration)).then((yes) => {
              if (!yes || this.#leaving) return;
              this.#leaving = true;
              void this.services.go('creation', { slot, next: true }).then((went) => {
                if (!went) this.#leaving = false;
              });
            });
          },
        },
        beginInstanceText(data.meta.iteration),
      ),
      `load-slot-${slot}-next`,
    );
  }

  /**
   * SPEC-058 §4.3: `Archive` asks, with a danger confirm, before the archived
   * instance replaces the slot's save; it can be restored once. A damaged
   * archive is refused with a toast by the store, and nothing changes.
   */
  #archiveButton(slot: SlotId, archive: Save, current: Save): HTMLButtonElement {
    return testId(
      h(
        'button',
        {
          class: 'ui-btn',
          type: 'button',
          click: () => {
            void confirmSheet(this.ui, { ...restoreArchiveSheet(archive.meta.iteration, current.meta.iteration), danger: true }).then((yes) => {
              if (!yes) return;
              const restored = this.services.save.restoreArchive(slot);
              if (!restored.ok) return;
              this.ui.toast('Archive restored', 'good');
              this.#refresh();
            });
          },
        },
        'Archive',
      ),
      `load-slot-${slot}-archive`,
    );
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

  /**
   * AC-9, SPEC-044 §4.9: the credits a player reads, from `data/credits.ts` —
   * the game and its licence, the tools, how the pictures, the photographs
   * (Google Gemini, R12-6) and the sound were made. The licence file is for
   * maintainers and names the films' shots, so it sits behind a link.
   */
  #renderCredits(): void {
    if (this.#sub === null) return;
    const body = testId(el('div', 'credits-text'), 'credits-text');
    for (const section of CREDITS) {
      body.append(h('h3', { class: 'credits-heading' }, section.title));
      for (const line of section.lines) {
        body.append(h('p', { class: 'credits-line' }, line === CREDITS_VERSION_LINE ? `Version ${__APP_VERSION__}` : line));
      }
    }
    // SPEC-022 §4.10: the prologue replay, above the licence text. The film
    // plays over the menu; the open panel and the focus are there afterwards.
    const replay = testId(
      h(
        'button',
        {
          class: 'ui-btn',
          type: 'button',
          click: () => {
            void director(this.services)
              .playFilm('prologue', { musicAfter: 'menu' })
              .then(() => replay.focus());
          },
        },
        'Play prologue',
      ),
      'credits-prologue',
    );
    // SPEC-044 §4.9: the maintainers' file, one tap away in a tab of its own.
    const licences = testId(
      h('a', { class: 'ui-btn credits-licences', href: 'assets/LICENSES.md', target: '_blank', rel: 'noreferrer' }, 'Asset licences'),
      'credits-licences',
    );
    this.#sub.replaceChildren(
      h(
        'div',
        { class: 'menu-list panel credits' },
        h('p', { class: 'menu-list-title' }, 'Credits'),
        h('div', { class: 'credits-actions' }, replay, licences),
        body,
      ),
    );
  }

  // --------------------------------------------------------------- records

  /**
   * SPEC-059 §4.4.5: the Records panel — the title the slots and one
   * commendation decide (§4.4.6), the count, `records-off` while the page's
   * gate is closed, one row per commendation (a hidden one classified until
   * earned), and the best times. Per device, like the list itself (59-t).
   */
  #renderRecords(): void {
    if (this.#sub === null) return;
    const { commendations: earned, bestTimes } = this.services.settings.get();
    const saves: Save[] = [];
    for (const slot of SLOTS) {
      const result = this.services.save.load(slot);
      if (result.ok) saves.push(result.data);
    }
    const count = COMMENDATION_IDS.filter((id) => earned[id] !== undefined).length;
    const reason = RECORDS.reason;
    const rows = recordsRows(earned).map((row) => {
      const status = recordsRowStatus(row);
      return testId(
        h(
          'li',
          { class: `records-row${row.earnedAt !== null ? ' is-earned' : ''}` },
          h('span', { class: 'records-row-title' }, row.title),
          h('span', { class: 'records-row-detail' }, row.detail),
          status === null ? null : h('span', { class: 'records-row-status' }, status),
        ),
        `records-${row.id}`,
      );
    });
    const best = bestTimeRows(bestTimes);
    this.#sub.replaceChildren(
      testId(
        h(
          'div',
          { class: 'menu-list panel records' },
          testId(h('p', { class: 'menu-list-title' }, recordsTitle(saves, earned)), 'records-title'),
          testId(h('p', { class: 'records-count' }, `${count} of ${COMMENDATION_IDS.length}`), 'records-count'),
          reason === null ? null : testId(h('p', { class: 'records-off' }, recordsOffText(reason)), 'records-off'),
          h('ul', { class: 'records-list' }, ...rows),
          h('p', { class: 'records-heading' }, 'Best times'),
          best.length === 0
            ? h('p', { class: 'records-row-detail' }, 'No best times yet.')
            : h('ul', { class: 'records-list' }, ...best.map((row) => testId(h('li', { class: 'records-best' }, row.text), `records-best-${row.id}`))),
        ),
        'records-panel',
      ),
    );
  }

  // -------------------------------------------------------------- keyboard

  #onArrows(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    // The import-code textarea keeps its caret keys, and a confirm sheet
    // keeps its focus: neither may lose arrows to the button walk. Nor may any
    // open modal — the settings panel over the menu takes focus now, and an
    // arrow must not walk it out to the buttons behind (SPEC-044 §4.3).
    const target = event.target;
    if (target instanceof Element && target.closest('textarea, input, select, .sheet-backdrop') !== null) return;
    if (topModal() !== null) return;
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
