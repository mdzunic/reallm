// The station hub (SPEC-014 §4.3). On enter — with a bound save — the fuel
// subsidy is applied and ARIA says so when it granted anything, the hull is
// restored, the save records where it is and asks for an autosave; an arrival
// from a planet debriefs the missions it finished, and an emergency recall is
// named in a banner. The backdrop is a slowly turning ring with the ship
// docked under it; the DOM is a tab rail — left on desktop, bottom on phones —
// over one panel container.
//
// Every enter effect is skipped, not crashed, when no save is bound: the e2e
// fleet cycles menu → station → starmap with nothing loaded, and D-19 makes
// a throwing `enter()` a fallback to the menu.
import * as THREE from 'three';
import { log } from '@/core/Log';
import { maxHp, type Save } from '@/core/Save';
import type { GameServices } from '@/core/Services';
import type { SceneParams } from '@/core/StateMachine';
import { DIALOGUE, MISSIONS, PLANET_IDS, PLANETS, type DialogueId, type MissionId } from '@/data/index';
import { Economy } from '@/systems/Economy';
import { Progression } from '@/systems/Progression';
import { endingPending, interludeToPlay, stayReport } from '@/systems/StoryBeats';
import { director } from '@/scenes/Director';
import { CharacterPanel } from '@/ui/CharacterPanel';
import { dialogueLayer } from '@/ui/DialogueUI';
import { el, h, testId } from '@/ui/dom';
import { clearEndingOverlays, EndingOverlay } from '@/ui/EndingOverlay';
import { MissionBoard } from '@/ui/MissionBoard';
import { SettingsPanel } from '@/ui/SettingsPanel';
import { ShopPanel } from '@/ui/ShopPanel';
import type { Look } from '@/core/Quality';
import { NEUTRAL_SKY } from '@/views/Environment';
import { addHubLights, hubSkyMesh, loadHubArt, proceduralDock, proceduralRing, swapModule } from '@/views/HubBackdrop';
import { UiScene } from '@/scenes/base';

/** Missions already debriefed this session, per save object (§4.3). */
const DEBRIEFED = new WeakMap<Save, Set<MissionId>>();

/** SPEC-017 §4.1 (*initial tuning*): the station reads cool and clean. */
const STATION_LOOK: Partial<Look> = { vignette: 0.35, bloomStrength: 0.3, tint: [0.96, 1, 1.04] };
const HUB_ENVIRONMENT_INTENSITY = 0.9;

type StationTab = 'missions' | 'shop' | 'character';

export class StationScene extends UiScene<'station'> {
  /** The three props that turn together; the lights and the window do not. */
  #spin: THREE.Group | null = null;
  #economy: Economy | null = null;
  #settings: SettingsPanel | null = null;
  #root: HTMLDivElement | null = null;
  #panelBox: HTMLDivElement | null = null;
  #rail: HTMLDivElement | null = null;
  #tab: StationTab = 'missions';
  #leaving = false;
  /** False from `dispose()`; what an awaited film comes back to (SPEC-023 §4.3). */
  #alive = true;

  constructor(services: GameServices) {
    super(services, 'station', 'station');
  }

  protected override look(): Partial<Look> {
    return STATION_LOOK;
  }

  protected onEnter(params: SceneParams['station']): void {
    this.useEnvironment(NEUTRAL_SKY, HUB_ENVIRONMENT_INTENSITY);
    this.disposer.add(() => {
      this.#alive = false;
    });
    this.#buildBackdrop();
    const data = this.services.save.current;
    if (data !== null) {
      const progression = new Progression(data, this.services.events);
      this.#economy = new Economy(data, this.services.events, progression, this.services.save);
      this.#enterEffects(data);
      // SPEC-023 §4.3: the story the entry owes — an interlude, then the
      // debrief — runs off `scene:entered` rather than here, so a film never
      // holds the transition open behind it.
      this.disposer.add(
        this.services.events.on(
          'scene:entered',
          (payload) => {
            if (payload.id === 'station') void this.#storyOnEntry(data, params);
          },
          this,
        ),
      );
    }
    this.#mountUi(params);
  }

  protected override onUpdate(_dt: number): void {
    if (this.#spin) this.#spin.rotation.y = this.elapsed * 0.12;
  }

  // ------------------------------------------------------------------ Three

  /**
   * AC-26 / SPEC-020 §4.4: the docked ship under a slowly rotating ring, on
   * its landing pad, in front of the station's nebula window — all of it in
   * one `Group`, lit by the shared key + rim pair over SPEC-017's neutral
   * environment. `props` stays the three the stats overlay pins: the ring, the
   * pad and the ship, whether they are the GLBs or the procedural modules.
   */
  #buildBackdrop(): void {
    const group = new THREE.Group();
    addHubLights(group);
    // The three props turn together (AC-26); the lights and the window behind
    // them are the backdrop's furniture and stay put, so they hang off `group`
    // and the turning ones off `spin` — still one backdrop `Group` (AC-16).
    const spin = new THREE.Group();
    group.add(spin);
    const ring = proceduralRing();
    ring.rotation.x = Math.PI / 2.4;
    spin.add(ring);
    const pad = proceduralDock();
    pad.position.y = -1.05;
    spin.add(pad);
    this.props = 2;
    // The docked ship (AC-26): the real model when the assets are up, a hull
    // of primitives when they are not — the count stays three either way.
    let ship: THREE.Object3D | null = null;
    if (this.services.assets.loaded) {
      try {
        ship = this.services.assets.model('ship');
      } catch (error) {
        log.warn('scene', 'the station backdrop could not load the ship model', error);
      }
    }
    if (ship === null) {
      ship = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 1.4), new THREE.MeshStandardMaterial({ color: 0x8a97a3, roughness: 0.4 }));
    }
    ship.position.set(0, -0.75, 0.2);
    ship.rotation.y = 0.5;
    spin.add(ship);
    this.props = 3;
    this.scene.add(group);
    this.#spin = spin;
    this.camera.position.set(0, 0.6, 4.4);
    this.camera.lookAt(0, -0.2, 0);

    // §4.4: the modelled ring and pad, and the window behind them, arrive
    // lazily; each one replaces its module in place, so the group keeps its
    // shape and `props` its value.
    let alive = true;
    this.disposer.add(() => {
      alive = false;
    });
    loadHubArt(this.services.assets, () => alive, (art) => {
      if (art.sky !== null) group.add(hubSkyMesh(art.sky));
      if (art.ring !== null) swapModule(spin, ring, art.ring);
      if (art.dock !== null) swapModule(spin, pad, art.dock);
    });
  }

  // ---------------------------------------------------------- enter effects

  #enterEffects(data: Save): void {
    const economy = this.#economy;
    if (economy === null) return;
    // AC-21 / E1: the subsidy, and ARIA's line only when it granted oil.
    const granted = economy.applyStationSubsidy();
    if (granted > 0) {
      this.ui.toast(`ARIA: Docking subsidy logged — +${granted} oil. Try to bring some back this time.`, 'info', 5000);
    }
    // AC-22: the ship is docked; the hull comes back to full.
    data.player.hp = maxHp(data.player.classId, data.player.attributes, data.player.level);
    // AC-23: the save knows where it is, and writes at this safe point.
    data.progress.location = 'station';
    data.progress.currentPlanet = null;
    this.services.save.request('station_enter');
  }

  /**
   * SPEC-023 §4.3: the entry's story, in order — the chapter interlude the
   * flags still owe, then SPEC-014's debrief (AC-24: what finished out there
   * gets its line here, once per session).
   *
   * The trigger is the flags, not `arrivedFrom`: a Continue or a Load into the
   * station plays a pending interlude too (23-h). Skipping counts as seen, and
   * with `?films=off` the flags are left alone and only the debrief runs
   * (23-f). A catch-up marks every pending chapter, so an old save watches one
   * film rather than four (E30).
   */
  async #storyOnEntry(data: Save, params: SceneParams['station']): Promise<void> {
    // SPEC-024 §4.5: an ending the save still owes comes before everything
    // else — and after an escape there is no "else" at all.
    if (!(await this.#pendingEnding(data))) return;
    const economy = this.#economy;
    const beats = director(this.services);
    const interlude = interludeToPlay(new Set(data.progress.flags));
    if (interlude !== null && beats.enabled && economy !== null) {
      await beats.playFilm(interlude.film, { musicAfter: 'station' });
      // E29: the flags are written when the film settles — ended or skipped —
      // so a reload during one replays it at the next entry.
      for (const flag of interlude.markSeen) economy.setFlag(flag);
      this.services.save.request('mission');
    }
    // A transition during the film skips it (22-c) and disposes this scene;
    // the debrief that was owed belongs to the entry that is already over.
    if (!this.#alive) return;
    if (params.arrivedFrom !== undefined) this.#debrief(data, params.arrivedFrom);
  }

  /**
   * SPEC-024 §4.5: the ending replay. A reload anywhere inside the sequence —
   * the dialogue, the film, the overlay, the escape veil (24-a) — leaves
   * `campaign_done` set and `endingSeen` false, and every load enters the
   * station (SPEC-014 §4.1), so this is where the moment is given back.
   *
   * The dialogue is not replayed: the film carries it. Under `?films=off`
   * `playFilm` resolves at once and the overlay still runs, so the ending is
   * never silently skipped (24-b).
   *
   * Returns false when the entry is over — an escape has already asked for the
   * menu, and neither an interlude nor a debrief belongs to it any more.
   */
  async #pendingEnding(data: Save): Promise<boolean> {
    const ending = endingPending(new Set(data.progress.flags), data.progress.endingSeen);
    if (ending === null) return true;
    await director(this.services).playFilm(`ending_${ending}`, { musicAfter: ending === 'stay' ? 'station' : null });
    if (!this.#alive) return false;
    const overlay = new EndingOverlay(this.services.uiRoot);
    this.disposer.add(() => clearEndingOverlays(this.services.uiRoot));
    if (ending === 'stay') {
      await overlay.playStay(stayReport(data));
      if (!this.#alive) return false;
      data.progress.endingSeen = true;
      this.services.save.request('mission');
      return true;
    }
    await overlay.playEscape();
    if (!this.#alive) return false;
    data.progress.endingSeen = true;
    this.services.save.request('manual');
    void this.services.go('menu', { reason: 'quit' });
    return false;
  }

  /** Plays the `<mission>_done` dialogue of arrived-from missions not yet debriefed. */
  #debrief(data: Save, arrivedFrom: NonNullable<SceneParams['station']['arrivedFrom']>): void {
    let seen = DEBRIEFED.get(data);
    if (seen === undefined) {
      seen = new Set();
      DEBRIEFED.set(data, seen);
    }
    const dialogue = dialogueLayer(this.services.uiRoot, this.services.events, {
      input: this.services.input,
      saveKey: () => this.services.save.current,
    });
    for (const id of data.progress.missionsDone) {
      if (seen.has(id) || MISSIONS[id]?.planet !== arrivedFrom) continue;
      seen.add(id);
      const done = `${id}_done`;
      if (Object.hasOwn(DIALOGUE, done)) void dialogue.play(done as DialogueId);
    }
  }

  // -------------------------------------------------------------------- DOM

  #mountUi(params: SceneParams['station']): void {
    this.#settings = new SettingsPanel(this.ui, {
      settings: this.services.settings,
      save: this.services.save,
      renderer: this.services.renderer,
      onReset: () => this.#quit(false),
    });
    this.disposer.add(() => {
      this.#settings?.dispose();
      this.#settings = null;
    });

    const data = this.services.save.current;
    // AC-27: the containment level is the highest unlocked chapter — the
    // diegetic difficulty label of PLAN §5.
    let containment = 1;
    if (this.#economy !== null) {
      for (const planet of PLANET_IDS) {
        if (this.#economy.isUnlocked(planet)) containment = Math.max(containment, PLANETS[planet].chapter);
      }
    }
    const head = h(
      'div',
      { class: 'station-head' },
      h('p', { class: 'station-name' }, 'Command Relay'),
      testId(h('p', { class: 'station-containment' }, `Containment level ${containment}`), 'containment-level'),
    );

    this.#rail = testId(el('div', 'station-rail'), 'station-rail');
    this.#panelBox = el('div', 'station-panel panel');
    this.#root = testId(el('div', 'station-root'), 'station-root');
    this.#root.append(head, this.#rail, this.#panelBox);
    // AC-25: a recall is said out loud, over everything else on the screen.
    if (params.recalled === true) {
      this.#root.append(testId(el('p', 'station-recall', 'Emergency recall'), 'recall-banner'));
    }
    this.ui.mount(this.#root, 'panel');
    this.disposer.add(() => {
      if (this.#root) this.ui.unmount(this.#root);
      this.#root = null;
      this.#rail = null;
      this.#panelBox = null;
      this.#economy = null;
    });
    if (data === null) {
      this.#renderRail();
      this.#panelBox.replaceChildren(h('p', { class: 'settings-note station-empty' }, 'No save loaded.'));
      return;
    }
    this.#renderRail();
    this.#renderPanel();
  }

  /** AC-28: the six tabs; a rail on the left, a bar at the bottom on phones. */
  #renderRail(): void {
    if (this.#rail === null) return;
    const tab = (id: string, label: string, onTap: () => void, active = false): HTMLButtonElement =>
      testId(
        h(
          'button',
          { class: `ui-btn station-tab${active ? ' seg is-active' : ''}`, type: 'button', 'aria-pressed': String(active), click: onTap },
          label,
        ),
        `station-tab-${id}`,
      );
    this.#rail.replaceChildren(
      tab('missions', 'Missions', () => this.#openTab('missions'), this.#tab === 'missions'),
      tab('shop', 'Shop', () => this.#openTab('shop'), this.#tab === 'shop'),
      tab('character', 'Character', () => this.#openTab('character'), this.#tab === 'character'),
      tab('starmap', 'Star Map', () => this.#starmap()),
      tab('settings', 'Settings', () => this.#settings?.show()),
      tab('quit', 'Quit', () => this.#quit(true)),
    );
  }

  #openTab(tab: StationTab): void {
    this.#tab = tab;
    this.#renderRail();
    this.#renderPanel();
  }

  #renderPanel(): void {
    const box = this.#panelBox;
    const data = this.services.save.current;
    const economy = this.#economy;
    if (box === null || data === null || economy === null) return;
    const shared = { ui: this.ui, save: this.services.save, data, economy };
    switch (this.#tab) {
      case 'missions':
        new MissionBoard(box, { ...shared, events: this.services.events });
        return;
      case 'shop':
        new ShopPanel(box, shared);
        return;
      case 'character':
        new CharacterPanel(box, shared);
        return;
    }
  }

  #starmap(): void {
    if (this.#leaving) return;
    this.#leaving = true;
    void this.services.go('starmap', undefined).then((went) => {
      if (!went) this.#leaving = false;
    });
  }

  /** AC-29: Quit saves, then leaves. A reset (AC-95) leaves without asking twice more. */
  #quit(save: boolean): void {
    if (this.#leaving) return;
    this.#leaving = true;
    if (save && this.services.save.current !== null) {
      this.services.save.request('manual');
      this.services.save.flush();
    }
    void this.services.go('menu', { reason: 'quit' }).then((went) => {
      if (!went) this.#leaving = false;
    });
  }
}
