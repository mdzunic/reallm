// The flight scene (SPEC-013): the composition root over the pure rail model.
// It builds the save-backed stack — Progression, Economy, Missions with
// `scene: 'flight'`, and the `Flight` system on the visit's own RNG stream —
// wires input into `Flight.update()`, feeds the shared HUD and the
// `FlightView`, and owns the three exits: the skippable 4 s landing cutscene
// into the surface (`firstLanding` on the first visit), the 1.5 s explosion
// into the station with `recalled: true`, and the pause menu's quit.
//
// Fuel was paid at the star map (SPEC-010); nothing here touches it — which is
// exactly why a crash costs the fuel once and only once (E5). The hull is not
// persisted: every trip starts at `maxHull`, which is §4.6's "restored at the
// station and on landing" with no bookkeeping to get wrong.
import * as THREE from 'three';
import type { InputState } from '@/core/Input';
import { newSave, type CharacterCreation, type SaveV1 } from '@/core/Save';
import type { GameServices } from '@/core/Services';
import type { SceneParams } from '@/core/StateMachine';
import { cargoCap, maxHp } from '@/core/Save';
import { PLANETS, type PlanetDef } from '@/data/index';
import { Economy } from '@/systems/Economy';
import {
  CONVERGE_DEPTH,
  EXPLOSION_SECONDS,
  Flight,
  LANDING_SECONDS,
  type FlightInput,
} from '@/systems/Flight';
import { Missions } from '@/systems/Missions';
import { cumulativeXp, Progression, xpToNext } from '@/systems/Progression';
import { el, testId } from '@/ui/dom';
import { Hud } from '@/ui/Hud';
import { PauseMenu } from '@/ui/PauseMenu';
import { RotateOverlay } from '@/ui/RotateOverlay';
import { TouchControls } from '@/ui/TouchControls';
import { FlightView } from '@/views/FlightView';
import { UiScene, uiRootEl } from '@/scenes/base';

/** The stand-in pilot for a bare `?scene=flight` jump with no loaded save. */
const DEMO_CREATION: CharacterCreation = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
};

export class FlightScene extends UiScene<'flight'> {
  override readonly pausable = true;

  #planet: PlanetDef = PLANETS.cinder4;
  #save: SaveV1 | null = null;
  #ephemeralSave = false;
  #flight: Flight | null = null;
  #missions: Missions | null = null;
  #view: FlightView | null = null;
  #hud: Hud | null = null;
  #pauseMenu: PauseMenu | null = null;
  #firstLanding = false;

  #landingT = -1;
  #landingSkipped = false;
  #explosionT = -1;
  #leaving = false;
  #explosionEl: HTMLDivElement | null = null;
  #skipHint: HTMLParagraphElement | null = null;

  readonly #frameInput: FlightInput = {
    steerX: 0,
    steerY: 0,
    fire: false,
    aimX: 0,
    aimY: 0,
    throttleUp: false,
    throttleDown: false,
    autoFire: false,
    mouseSteer: false,
  };
  readonly #aimScratch = new THREE.Vector3();

  constructor(services: GameServices) {
    super(services, 'flight', 'flight');
  }

  protected onEnter(params: SceneParams['flight']): void {
    this.#planet = PLANETS[params.destination];
    const services = this.services;
    // A dev `?scene=flight` jump has no save; the demo pilot flies in memory
    // and nothing is written back (same pattern as the SPEC-011 harness).
    const bound = services.save.current;
    this.#ephemeralSave = bound === null;
    const save = bound ?? newSave(0, DEMO_CREATION, services.rng.seed, Date.now());
    this.#save = save;

    const visits = save.progress.visits[this.#planet.id] ?? 0;
    this.#firstLanding = visits === 0;
    const visitRng = services.rng.visit(this.#planet.id, visits);
    const progression = new Progression(save, services.events);
    const economy = new Economy(save, services.events, progression, bound === null ? undefined : services.save);
    const missions = new Missions(save, { scene: 'flight', planet: this.#planet.id }, economy, services.events);
    this.#missions = missions;
    const flight = new Flight(
      {
        planet: this.#planet,
        ship: save.ship,
        companions: save.companions,
        quality: services.renderer.quality,
        difficulty: save.meta.difficulty,
      },
      economy,
      progression,
      missions,
      services.events,
      visitRng.fork('flight'),
    );
    this.#flight = flight;

    // 70° FOV, far enough for the starfield and the planet sphere (§4.9).
    this.camera.fov = 70;
    this.camera.far = 600;
    this.camera.updateProjectionMatrix();
    this.#view = new FlightView(this.scene, this.camera, {
      planet: this.#planet,
      quality: services.renderer.quality,
      reduceMotion: services.settings.get().reduceMotion,
      rng: visitRng.fork('flight_view'),
    });
    this.disposer.add(() => {
      this.#view?.dispose();
      this.#view = null;
    });

    this.#mountUi();

    // §4.1: ARIA names the destination during launch, first visit only (AC-53).
    if (this.#firstLanding) {
      this.ui.toast(`ARIA: ${this.#planet.name} on approach. ${this.#planet.blurb}`, 'info', 6000);
    }

    this.disposer.add(this.services.events.on('ship:damaged', () => {
      this.#hud?.damageFlash();
      this.#view?.kick();
    }, this));
    this.disposer.add(() => {
      this.#missions?.dispose();
      this.#missions = null;
      this.#flight = null;
      this.#save = null;
    });
  }

  #mountUi(): void {
    const services = this.services;
    const flight = this.#flight;
    // SPEC-014 §4.5: the shared HUD in flight trim; SPEC-013 feeds it.
    const hud = new Hud(this.ui, 'flight');
    this.#hud = hud;
    if (flight !== null) hud.setWaveMarkers(flight.waveMarkers());
    this.disposer.add(() => {
      this.#hud?.dispose();
      this.#hud = null;
    });

    const menu = new PauseMenu(services, () => services.requestResume());
    this.#pauseMenu = menu;
    this.disposer.add(() => {
      menu.dispose();
      this.#pauseMenu = null;
    });
    this.disposer.add(() => services.audio.duck(false));

    // §4.10: steer zone left 60 %, fire hold right, throttle and pause buttons.
    const touch = new TouchControls(uiRootEl(), services.input, services.settings);
    touch.show('flight');
    this.disposer.add(() => touch.dispose());

    const rotate = new RotateOverlay(uiRootEl(), services.events);
    this.disposer.add(() => rotate.dispose());

    // The recall flash and the landing skip hint are the scene's own layers —
    // flight shows no death panel and declines the shared overlay (SPEC-014).
    this.#explosionEl = testId(el('div', 'flight-explosion'), 'flight-explosion');
    this.#skipHint = testId(el('p', 'flight-skip-hint is-hidden', 'Tap or press any key to skip'), 'skip-landing');
    this.ui.mount(this.#explosionEl, 'overlay');
    this.ui.mount(this.#skipHint, 'hud');
    this.disposer.add(() => {
      if (this.#explosionEl) this.ui.unmount(this.#explosionEl);
      if (this.#skipHint) this.ui.unmount(this.#skipHint);
      this.#explosionEl = null;
      this.#skipHint = null;
    });

    // 13-f: the cutscene skips on any key or tap; the fade still runs (AC-102).
    const skip = (): void => {
      if (this.#landingT >= 0) this.#landingSkipped = true;
    };
    document.addEventListener('keydown', skip);
    document.addEventListener('pointerdown', skip);
    this.disposer.add(() => {
      document.removeEventListener('keydown', skip);
      document.removeEventListener('pointerdown', skip);
    });
  }

  // ------------------------------------------------------------------- update

  protected override onUpdate(dt: number): void {
    const flight = this.#flight;
    if (flight === null) return;
    const input = this.services.input.state;
    // SPEC-014 AC-82: the touch pause button pauses through the input action;
    // Escape/P stay with the composition root's toggle.
    if (input.scheme === 'touch' && input.buttons.pause.justPressed) {
      this.services.scenes.pause();
    }

    if (flight.phase !== 'arrived' && flight.phase !== 'recalled') {
      flight.update(dt, this.#readInput(input));
    }

    switch (flight.phase) {
      case 'arrived':
        this.#advanceLanding(dt);
        break;
      case 'recalled':
        this.#advanceRecall(dt);
        break;
      default:
        break;
    }

    this.#feedHud(flight);
    this.#view?.update(flight, dt);
  }

  /** The frame's `FlightInput`, written in place (no allocations in update). */
  #readInput(state: InputState): FlightInput {
    const flight = this.#flight as Flight;
    const frame = this.#frameInput;
    frame.steerX = state.move.x;
    frame.steerY = state.move.y;
    frame.fire = state.buttons.fire.down;
    frame.autoFire = state.autoFire;
    frame.throttleUp = state.buttons.throttleUp.justPressed;
    frame.throttleDown = state.buttons.throttleDown.justPressed;
    frame.mouseSteer = this.services.settings.flightMouseSteer && state.scheme === 'keyboard' && state.aim.hasPointer;
    if (state.aim.hasPointer) {
      // The pointer's ray, dropped onto the convergence plane (§4.7).
      const scratch = this.#aimScratch;
      scratch.set(state.aim.ndcX, state.aim.ndcY, 0.5).unproject(this.camera).sub(this.camera.position);
      const along = -CONVERGE_DEPTH - this.camera.position.z;
      const t = scratch.z !== 0 ? along / scratch.z : 0;
      frame.aimX = this.camera.position.x + scratch.x * t;
      frame.aimY = this.camera.position.y + scratch.y * t;
    } else {
      // Touch aims straight ahead; the assist and auto-fire do the rest (§4.7).
      frame.aimX = flight.ship.x;
      frame.aimY = flight.ship.y;
    }
    return frame;
  }

  #feedHud(flight: Flight): void {
    const hud = this.#hud;
    const save = this.#save;
    if (hud === null || save === null) return;
    const model = hud.model;
    const { player } = save;
    model.hp[0] = player.hp;
    model.hp[1] = maxHp(player.classId, player.attributes, player.level);
    model.xp[0] = player.xp - cumulativeXp(player.level);
    model.xp[1] = xpToNext(player.level);
    model.level = player.level;
    model.tokens = player.tokens;
    model.resources.oil = save.resources.oil;
    model.resources.wheat = save.resources.wheat;
    model.resources.water = save.resources.water;
    model.resources.lithium = save.resources.lithium;
    model.cargoCap = cargoCap(save.ship);

    const flightModel = model.flight;
    if (flightModel !== undefined) {
      flightModel.shield[0] = flight.ship.shield;
      flightModel.shield[1] = flight.ship.maxShield;
      flightModel.hull[0] = flight.ship.hull;
      flightModel.hull[1] = flight.ship.maxHull;
      flightModel.throttle = flight.ship.throttle;
      flightModel.progress = flight.progress;
      flightModel.hostiles = flight.hostiles;
      flightModel.storm = flight.stormActive;
      flightModel.holding = flight.phase === 'holding';
    }

    // §4.8: the objective row, with the throttle hint when the survive
    // objective cannot fit the remaining trip (13-b, AC-89).
    const missions = this.#missions;
    const objective = missions?.objective() ?? null;
    if (objective === null) {
      model.objective = null;
    } else {
      const survive = missions?.longestSurvive() ?? 0;
      const line =
        survive > 0 && survive > flight.duration()
          ? `Objective needs ${survive} s — throttle down or hold`
          : objective.line;
      model.objective = { title: objective.title, line, value: objective.value, target: objective.target };
    }

    // The reticle rides the system's (possibly snapped) aim point (§4.7).
    const scratch = this.#aimScratch;
    scratch.set(flight.reticle.x, flight.reticle.y, -CONVERGE_DEPTH).project(this.camera);
    hud.setReticle(scratch.x, scratch.y);
  }

  // -------------------------------------------------------------------- exits

  #advanceLanding(dt: number): void {
    if (this.#landingT < 0) {
      this.#landingT = 0;
      this.#skipHint?.classList.remove('is-hidden');
    }
    this.#landingT += dt;
    if (this.#landingSkipped) this.#landingT = LANDING_SECONDS; // 13-f: instant
    this.#view?.setLanding(this.#landingT / LANDING_SECONDS);
    if (this.#landingT < LANDING_SECONDS || this.#leaving) return;
    this.#leaving = true;
    const save = this.#save;
    if (save !== null && !this.#ephemeralSave) {
      // AC-35 / SPEC-008: the landing is the visit — count it and write at the
      // safe point; the surface scene reads `firstLanding` from its params.
      const visits = save.progress.visits[this.#planet.id] ?? 0;
      save.progress.visits[this.#planet.id] = visits + 1;
      save.progress.currentPlanet = this.#planet.id;
      save.progress.location = 'surface';
      this.services.save.request('landing');
    }
    void this.services.go('surface', { planet: this.#planet.id, firstLanding: this.#firstLanding });
  }

  #advanceRecall(dt: number): void {
    if (this.#explosionT < 0) {
      this.#explosionT = 0;
      this.#explosionEl?.classList.add('is-visible');
      this.#skipHint?.classList.add('is-hidden');
    }
    this.#explosionT += dt;
    if (this.#explosionT < EXPLOSION_SECONDS || this.#leaving) return;
    this.#leaving = true;
    // E5: fuel stays paid, cargo stays aboard; the station shows the banner.
    void this.services.go('station', { recalled: true });
  }

  // -------------------------------------------------------------- pause hooks

  pause(): void {
    this.#pauseMenu?.show();
    this.services.audio.duck(true);
  }

  resume(): void {
    this.#pauseMenu?.hide();
    this.services.audio.duck(false);
  }

  override debugInfo(): Record<string, number | string> {
    const info = super.debugInfo();
    const flight = this.#flight;
    if (flight !== null) {
      info['phase'] = flight.phase;
      info['progress'] = Number(flight.progress.toFixed(3));
      info['hazards'] = flight.hazards.size;
      info['shots'] = flight.shots.size;
      info['hostiles'] = flight.hostiles;
    }
    return info;
  }
}
