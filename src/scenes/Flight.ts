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
import { clampTexture } from '@/core/Assets';
import type { EventBus, GameEvents } from '@/core/Events';
import type { InputState } from '@/core/Input';
import { log } from '@/core/Log';
import { PressEdges } from '@/core/PressEdges';
import { holdWakeLock } from '@/core/WakeLock';
import { newSave, type CharacterCreation, type Save } from '@/core/Save';
import type { GameServices } from '@/core/Services';
import type { SceneParams } from '@/core/StateMachine';
import { cargoCap, maxHp } from '@/core/Save';
import { FLIGHT_ASSETS, PLANET_ART } from '@/data/assets';
import {
  CHAPTER_CARDS,
  CONTACTS,
  ENEMIES,
  MISSIONS,
  PLANETS,
  TIPS,
  type ClueDef,
  type ContactDef,
  type DialogueId,
  type EnemyDef,
  type EnemyId,
  type PlanetDef,
  type TipId,
} from '@/data/index';
import { ClueTracker, FlagView, type ClueScene } from '@/systems/Clues';
import { computePlayerStats } from '@/systems/Combat';
import { Economy } from '@/systems/Economy';
import { tipDue, tipKey } from '@/systems/Guidance';
import { CARD, cardDue, cardKey, contactDue, contactKey, flightEchoDue, LINE_LEDGER, missionLinePlays } from '@/systems/StoryBeats';
import { showChapterCard } from '@/ui/ChapterCard';
import { showContactCard } from '@/ui/ContactCard';
import { dialogueLayer } from '@/ui/DialogueUI';
import { director } from '@/scenes/Director';
import {
  AUTOPILOT_SECONDS,
  CONVERGE_DEPTH,
  EXPLOSION_SECONDS,
  engineVolume,
  Flight,
  LANDING_SECONDS,
  LAUNCH_SECONDS,
  runSkip,
  type FlightInput,
} from '@/systems/Flight';
import { Missions } from '@/systems/Missions';
import { cumulativeXp, LEVEL_CAP, Progression, xpToNext } from '@/systems/Progression';
import { watchRunStats } from '@/systems/RunStats';
import { completionLines, quitNote } from '@/systems/UiHelpers';
import { AriaHint } from '@/ui/AriaHint';
import { el, h, shortScreen, testId } from '@/ui/dom';
import { Hud } from '@/ui/Hud';
import { MissionBanner } from '@/ui/MissionBanner';
import { NOTES_UNSEEN } from '@/ui/NotesPanel';
import { PauseMenu, withComms } from '@/ui/PauseMenu';
import { RotateOverlay } from '@/ui/RotateOverlay';
import { TouchControls } from '@/ui/TouchControls';
import { FlightView } from '@/views/FlightView';
import { prewarm, prewarmPatches } from '@/views/ProceduralTextures';
import type { Look } from '@/core/Quality';
import type { Voice } from '@/core/Audio';
import { UiScene, uiRootEl } from '@/scenes/base';

// -------------------------------------------------------------- SPEC-035 §4.8

/** §4.8: how long a tip stays up, and how long after `flight_steer` the second one comes. */
const TIP_MS = 8000;
const THROTTLE_TIP_DELAY = 12;

// ------------------------------------------------------------- SPEC-035 §4.11

/** §4.11: the hum's volume is re-read this often, not every frame. */
const ENGINE_VOLUME_INTERVAL = 0.25;

// ------------------------------------------------------------- SPEC-041 §4.9

/** How long the reticle wears `is-hit` after a hit, and `is-kill` after a kill (sim seconds). */
const RETICLE_HIT_SECONDS = 0.1;
const RETICLE_KILL_SECONDS = 0.25;
type ReticleMark = '' | 'is-hit' | 'is-kill';

/** SPEC-063 §4.5 (E111): how often a contact card due under a late chapter card looks again, in ms. */
const CONTACT_RECHECK_MS = 50;

/** The stand-in pilot for a bare `?scene=flight` jump with no loaded save. */
const DEMO_CREATION: CharacterCreation = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
};

/**
 * The most a skip may simulate — past any trip's `travelSeconds` at the
 * slowest throttle notch, plus the 90 s holding cap. The dev button and the
 * player's `Skip the run` (SPEC-032 §4.5) share it.
 */
const DEV_SKIP_LIMIT_SECONDS = 1200;

/**
 * SPEC-032 §4.2: does this event end the launch shot? A tap, or a fresh key
 * press that is not Space (E33: Space never skips). A tap on a control — the
 * pause button, the dev skip — is that control's, and the pause keys belong to
 * the pause toggle, so a pause mid-shot holds the shot (32-e).
 */
function skipsLaunch(event: Event): boolean {
  if (event.type === 'pointerdown') {
    const target = event.target;
    return !(target instanceof Element && target.closest('button, a, input, select, textarea, [role="dialog"]') !== null);
  }
  if (!(event instanceof KeyboardEvent) || event.repeat) return false;
  return event.code !== 'Space' && event.key !== ' ' && event.key !== 'Escape' && event.key.toLowerCase() !== 'p';
}

/** SPEC-017 §4.1 (*initial tuning*): engine glow and shots carry the trip. */
const FLIGHT_LOOK: Partial<Look> = { bloomStrength: 0.55, bloomThreshold: 0.75, vignette: 0.3 };

/** Landed or recalled — read through a call, so a caller's earlier check cannot narrow it. */
function tripOver(flight: Flight): boolean {
  return flight.phase === 'arrived' || flight.phase === 'recalled';
}

export class FlightScene extends UiScene<'flight'> {
  override readonly pausable = true;
  /** FlightView brings its own key, rim and ambient (PLAN R8). */
  protected override readonly ownsLighting = true;

  #planet: PlanetDef = PLANETS.cinder4;
  #save: Save | null = null;
  /** SPEC-044 §4.8: `Economy.fuelCost` of this trip's destination, for the quit sheet. */
  #jumpFuelCost = 0;
  #ephemeralSave = false;
  #flight: Flight | null = null;
  #missions: Missions | null = null;
  #view: FlightView | null = null;
  #hud: Hud | null = null;
  /** SPEC-042 §4.1: the mission banner for a flight mission finished in flight. */
  #banner: MissionBanner | null = null;
  #pauseMenu: PauseMenu | null = null;
  /** SPEC-036 §4.3: the rotate block, read every step. */
  #rotate: RotateOverlay | null = null;
  #firstLanding = false;

  #landingT = -1;
  #landingSkipped = false;
  #explosionT = -1;
  #leaving = false;
  #explosionEl: HTMLDivElement | null = null;
  #skipHint: HTMLParagraphElement | null = null;

  /** SPEC-032 §4.1: the launch shot has ended (run out, or skipped). */
  #launchDone = false;
  // SPEC-035 §4.8 — the two tips the first flight needs. The hint strip is the
  // surface's `AriaHint`, mounted here the same way; `flight_throttle` follows
  // `flight_steer` by 12 s on the same trip.
  #aria: AriaHint | null = null;
  #throttleTipIn = -1;
  // SPEC-035 §4.11 — `engine_hum` is shipped and was never played. It runs from
  // the end of the launch phase to the end of the scene, at priority 0.
  #engineVoice: Voice | null = null;
  #engineVolumeIn = 0;
  /** SPEC-032 §4.5: a skip asked for, run on the next update with the loop live. */
  #skipPending = false;
  /** Seconds the autopilot card has been up; −1 while there is none. */
  #autopilotT = -1;
  #autopilotEl: HTMLDivElement | null = null;
  /**
   * SPEC-041 §4.9: the HUD's reticle node, found once when the HUD mounts,
   * the mark it wears (`''` for none) and the sim seconds the mark has left.
   */
  #reticleEl: HTMLElement | null = null;
  #reticleMark: ReticleMark = '';
  #reticleMarkT = 0;
  /** SPEC-041 §4.7: the lead pip is up — `sceneInfo.lead`. */
  #leadShown = false;
  /**
   * SPEC-063 §4.5: when this trip's chapter card will have been removed, on
   * `performance.now()`'s clock — 0 when there is none — and the box it is
   * mounted in. A contact card due before that moment waits until then (E111).
   */
  #chapterCardGoneAt = 0;
  #chapterCardHost: HTMLElement | null = null;
  /** SPEC-063 §4.5: the enemies whose contact fired on this trip, in order — `sceneInfo.contacts`. */
  readonly #contacts: EnemyId[] = [];

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
  /**
   * SPEC-012 §4.3's press-edge sampler (review 2026-10, B-03): `justPressed`
   * is a per-frame latch, so read per step it moved the throttle two notches
   * on every two-step frame (the 30 fps phone floor).
   */
  readonly #edges = new PressEdges();

  constructor(services: GameServices) {
    super(services, 'flight', 'flight');
  }

  protected override look(): Partial<Look> {
    return FLIGHT_LOOK;
  }

  protected onEnter(params: SceneParams['flight']): void {
    this.#planet = PLANETS[params.destination];
    const services = this.services;
    // SPEC-018 §4.5: build the destination's procedural ground layers during
    // the trip, so the landing's `SurfaceView` construction has no hitch.
    prewarm(this.#planet.surface.look.ground.layers);
    // PLAN R28 / SPEC-067: and its ground patches' atlas tiles.
    prewarmPatches(this.#planet.surface.look.decals);
    // A dev `?scene=flight` jump has no save; the demo pilot flies in memory
    // and nothing is written back (same pattern as the SPEC-011 harness).
    const bound = services.save.current;
    this.#ephemeralSave = bound === null;
    const save = bound ?? newSave(0, DEMO_CREATION, services.rng.seed, Date.now());
    this.#save = save;

    const visits = save.progress.visits[this.#planet.id] ?? 0;
    this.#firstLanding = visits === 0;
    // SPEC-058 §4.4: a later instance's trips run on streams of their own.
    const visitRng = services.rng.visit(this.#planet.id, visits, save.meta.iteration);
    const progression = new Progression(save, services.events);
    const economy = new Economy(save, services.events, progression, bound === null ? undefined : services.save);
    // SPEC-044 §4.8: what this jump cost — the engine cannot change mid-flight.
    this.#jumpFuelCost = economy.fuelCost(this.#planet.id);
    // SPEC-032 §4.7: the service override, kept in step with the setting.
    economy.serviceMode = services.settings.serviceMode;
    this.disposer.add(
      services.events.on('settings:changed', ({ patch }) => {
        if (patch.serviceMode !== undefined) economy.serviceMode = patch.serviceMode;
      }, this),
    );
    // The runtime subscribes with an owner and releases the whole owner on
    // dispose, which the narrow structural bus in `Services` cannot express —
    // the same cast the surface scene makes for the same reason.
    const bus = services.events as EventBus<GameEvents>;
    // SPEC-047 §4.5: kills and deaths count in flight too; there is no ground
    // here, so a crash leaves `lastDeath` alone (47-f).
    this.disposer.add(watchRunStats(bus, save, this, () => null));
    // SPEC-048 §4.3: the clue tracker hears a kill before the missions do, so
    // the kill that completes a kill clue's mission still counts as made during it.
    this.#watchClues(save, economy, bus);
    const missions = new Missions(save, economy, bus, 'flight', this.#planet.id);
    this.#missions = missions;
    const flight = new Flight(
      {
        planet: this.#planet,
        ship: save.ship,
        companions: save.companions,
        quality: services.renderer.quality,
        difficulty: save.meta.difficulty,
        // SPEC-058 §4.4: incoming damage takes the instance's containment too.
        iteration: save.meta.iteration,
        // SPEC-039 §4.3: ARIA's shield regeneration is a companion effect.
        companionMult: computePlayerStats(save).companionMult,
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
    // SPEC-032 §4.1: the tug the launch shot opens on — the hull the station
    // docks. `ship.glb` is a boot-manifest model; a primitive stands in if not.
    let tug: THREE.Object3D | null = null;
    if (services.assets.loaded) {
      try {
        tug = services.assets.model('ship');
      } catch (error) {
        log.warn('scene', 'the launch shot could not load the ship model; the primitive hull flies it', error);
      }
    }
    this.#view = new FlightView(this.scene, this.camera, {
      planet: this.#planet,
      quality: services.renderer.quality,
      reduceMotion: services.settings.get().reduceMotion,
      rng: visitRng.fork('flight_view'),
      tug,
      msaa: services.renderer.post.samples > 0,
    });
    this.#view.setLaunch(0);
    // SPEC-032 §4.4: a run skipped at the star map starts on the first update.
    this.#skipPending = params.skipRun === true;
    this.disposer.add(() => {
      this.#view?.dispose();
      this.#view = null;
    });
    this.#dress();

    this.#mountUi();

    // §4.1: ARIA names the destination during launch, first visit only (AC-53).
    if (this.#firstLanding) {
      this.ui.toast(`ARIA: ${this.#planet.name} on approach. ${this.#planet.blurb}`, 'info', 6000);
    }
    this.#showChapterCard(save);
    this.#watchContacts(bus);

    this.disposer.add(this.services.events.on('ship:damaged', ({ source }) => {
      // SPEC-037 §4.6: an ion-storm tick never flashes — the storm pill and the
      // static already say it — but the view still kicks.
      if (source !== 'storm') this.#hud?.damageFlash();
      // SPEC-045 §4.3: the kick follows Camera shake — half at 0.5, and at 0
      // (which reduce motion sets) nothing moves.
      this.#view?.kick(this.services.settings.get().cameraShake);
    }, this));
    // SPEC-034 §4.10 step 2: a flight mission that finishes in flight is
    // debriefed in flight, and the ledger keeps the station from saying it again.
    // SPEC-042 §4.1: the banner goes up first, and the line waits behind its
    // hold — flight lines are never modal. There is no pad here, so no next.
    // SPEC-048 §4.6 (E76): a replay keeps its banner and loses its line, and
    // the station debriefs no replay.
    this.disposer.add(this.services.events.on('mission:completed', ({ id, replay }) => {
      const data = this.#save;
      if (data === null) return;
      this.#banner?.push(completionLines(MISSIONS[id], replay, null));
      if (!missionLinePlays('complete', replay)) return;
      LINE_LEDGER.noteCompleted(data, id);
      const line = MISSIONS[id].dialogue.onComplete;
      if (line !== undefined) this.#playLine(data, line);
    }, this));
    this.disposer.add(() => {
      this.#missions?.dispose();
      this.#missions = null;
      this.#flight = null;
      this.#save = null;
    });

    // The dev-only flight hook, next to `window.__reallm` (SPEC-002 §3.11):
    // a 90 s trip and a random crash are not things an e2e suite can wait
    // for, so it can warp the simulation and land a deterministic hit. Dev
    // builds only, removed with the scene.
    if (import.meta.env.DEV) {
      const idle: FlightInput = { ...this.#frameInput, aimX: 0, aimY: 0 };
      const scope = globalThis as { __reallmFlight?: unknown };
      scope.__reallmFlight = {
        phase: () => flight.phase,
        state: () => ({
          progress: flight.progress,
          shield: flight.ship.shield,
          hull: flight.ship.hull,
          throttle: flight.ship.throttle,
          storm: flight.stormActive,
          hostiles: flight.hostiles,
          holding: flight.phase === 'holding',
        }),
        hit: (amount: number) => flight.hit(amount, 'asteroid', { kind: 'asteroid' }),
        warp: (seconds: number) => {
          const dt = 1 / 60;
          for (let t = 0; t < seconds; t += dt) {
            if (flight.phase === 'arrived' || flight.phase === 'recalled') break;
            flight.update(dt, idle);
          }
        },
        // SPEC-020 AC-15: top the asteroid field up to the preset's cap
        // without flying the minutes of Poisson spawning it would take, so the
        // budget suite measures the worst case the criterion names.
        fillAsteroids: () => {
          const cap = this.services.renderer.quality.asteroidCap;
          for (let live = 0; live < cap; live++) {
            let rocks = 0;
            for (let i = 0; i < flight.hazards.size; i++) if (flight.hazards.at(i).kind === 'asteroid') rocks++;
            if (rocks >= cap) break;
            flight.spawnAsteroid();
          }
        },
        // A wave enemy that never leaves, so the arrival check keeps failing
        // and the holding pattern is reachable on a planet whose real waves
        // would ram an idle ship. SPEC-041 §6.2: it is a *still* fighter 60 m
        // dead ahead — it holds that depth, has no strafe (a speed-0 copy of
        // its definition flies the figure-8 with no amplitude), and its fire
        // cooldown never runs out — so it keeps a ship in frame, and a test
        // can see the lead pip on it with the pointer centred and shoot it down.
        blockArrival: () => {
          const def: EnemyDef = { ...ENEMIES.scav_fighter, speed: 0 };
          const hazard = flight.hazards.alloc();
          Object.assign(hazard, {
            kind: 'fighter',
            x: 0,
            y: 0,
            depth: 60,
            vx: 0,
            vy: 0,
            vDepth: 0,
            radius: def.radius,
            hp: def.hp,
            def,
            elite: false,
            ttl: Number.POSITIVE_INFINITY,
            fireCooldown: Number.POSITIVE_INFINITY,
            pattern: 0,
            holdDepth: 60,
            hitFlash: 0,
            burstLeft: 0,
            burstAt: 0,
            shotDamage: undefined,
          });
        },
        clearSky: () => flight.hazards.clear(),
      };
      this.disposer.add(() => {
        delete scope.__reallmFlight;
      });
    }
  }

  /**
   * SPEC-023 §4.2: the chapter card over the launch, on the first trip to a
   * world and once a page session (23-a). The launch phase has no hazards for
   * its first 3 s and the card is text over it, so nothing here waits for the
   * card and nothing about the flight's timeline changes — a trip that ends
   * early takes the card with it through the `Disposer`.
   */
  #showChapterCard(save: Save): void {
    const services = this.services;
    const planet = this.#planet.id;
    const beats = director(services);
    if (!beats.enabled || !cardDue(planet, save.progress.visits, beats.session)) return;
    beats.session.add(cardKey(planet));
    const reduceMotion = services.settings.get().reduceMotion;
    // §4.2, Mounting: directly under `#ui`, next to the reveals, films and
    // endings, so the card's z 54 reads against the rotate cover's 51 and
    // stays above it (SPEC-036 §4.3). The toast rack's 55 is in the same
    // stacking context, so a toast still lands over the card. The host is a
    // `display: contents` box, the pattern the damage-number layer uses.
    const host = el('div', 'chapter-card-host');
    uiRootEl().append(host);
    this.#chapterCardHost = host;
    let remove: (() => void) | null = null;
    const timer = setTimeout(() => {
      // SPEC-058 §4.4: the containment line reads the save's capped level.
      remove = showChapterCard(host, CHAPTER_CARDS[planet], reduceMotion, save.meta.iteration);
    }, CARD.delay * 1000);
    // SPEC-063 §4.5: the moment the card will be gone, for a contact card due under it.
    this.#chapterCardGoneAt = performance.now() + (CARD.delay + CARD.show + CARD.fade) * 1000;
    this.disposer.add(() => {
      clearTimeout(timer);
      remove?.();
      host.remove();
      this.#chapterCardHost = null;
    });
  }

  /**
   * SPEC-063 §4.5: the first group of a flight enemy on the first trip to its
   * contact planet, once a page session — the card over the live flight, and
   * the comms line through the shared layer. With films off the card stays
   * away and the line still plays (E109). Nothing here touches the flight's
   * step, the input, the music, the HUD or the save: no beat holds a flight
   * (SPEC-042), and the line queues behind any line in progress.
   */
  #watchContacts(bus: EventBus<GameEvents>): void {
    this.disposer.add(
      bus.on(
        'flight:groupSpawned',
        ({ enemy }) => {
          const save = this.#save;
          const def = (CONTACTS as Partial<Record<EnemyId, ContactDef>>)[enemy];
          if (save === null || def === undefined) return;
          const beats = director(this.services);
          if (!contactDue(enemy, this.#planet.id, save.progress.visits, beats.session)) return;
          beats.session.add(contactKey(enemy));
          this.#contacts.push(enemy);
          if (beats.enabled) this.#showContactCard(enemy, ENEMIES[enemy].name.toUpperCase(), def.epithet);
          this.#playLine(save, def.line);
        },
        this,
      ),
    );
  }

  /**
   * SPEC-063 §4.5: mounts the contact card like `#showChapterCard` — a
   * `display: contents` host directly under `#ui`, taken away by the
   * `Disposer` — once the chapter card has been removed (E111), else at once.
   * The group spawns inside the flight's step, so the mount always runs on a
   * timer of its own and the step builds no DOM.
   *
   * The chapter card's own timers run one after the other, so on a loaded
   * frame they land later than the moment recorded for them; at that moment
   * the card itself is looked for, and while it is still up the contact card
   * looks again every `CONTACT_RECHECK_MS`.
   */
  #showContactCard(enemy: EnemyId, name: string, epithet: string): void {
    const reduceMotion = this.services.settings.get().reduceMotion;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let host: HTMLElement | null = null;
    let remove: (() => void) | null = null;
    const mount = (): void => {
      if ((this.#chapterCardHost?.firstElementChild ?? null) !== null) {
        timer = setTimeout(mount, CONTACT_RECHECK_MS);
        return;
      }
      timer = null;
      host = el('div', 'contact-card-host');
      uiRootEl().append(host);
      remove = showContactCard(host, { enemy, name, epithet }, reduceMotion);
    };
    timer = setTimeout(mount, Math.max(0, this.#chapterCardGoneAt - performance.now()));
    this.disposer.add(() => {
      if (timer !== null) clearTimeout(timer);
      remove?.();
      host?.remove();
    });
  }

  #mountUi(): void {
    const services = this.services;
    const flight = this.#flight;
    // SPEC-014 §4.5: the shared HUD in flight trim; SPEC-013 feeds it.
    const hud = new Hud(this.ui, 'flight');
    this.#hud = hud;
    // SPEC-042 §4.7: the level before the first flush, so the trip's first
    // frame does not read as a level gained.
    hud.model.level = this.#save?.player.level ?? 1;
    if (flight !== null) hud.setWaveMarkers(flight.waveMarkers());
    this.disposer.add(() => {
      this.#hud?.dispose();
      this.#hud = null;
      this.#reticleEl = null;
    });
    // SPEC-042 §4.1: the mission banner, the top centre's last row, on the
    // shared dialogue layer — whose queue it holds while it is up.
    const dialogue = dialogueLayer(services.uiRoot, services.events, {
      input: services.input,
      saveKey: () => services.save.current,
      typewriter: () => services.settings.get().typewriter,
      speed: () => services.settings.get().dialogueSpeed,
    });
    const banner = new MissionBanner(this.ui, {
      dialogue,
      reduceMotion: () => services.settings.get().reduceMotion,
      keepToasts: () => dialogue.busy,
    });
    this.#banner = banner;
    this.disposer.add(() => {
      banner.dispose();
      this.#banner = null;
    });
    // SPEC-041 §4.9: every hit on a hazard marks the reticle — `is-hit`, or
    // `is-kill` for the kill. The node is looked up once, here, so the frame
    // that clears the mark reads nothing from the DOM.
    this.#reticleEl = services.uiRoot.querySelector<HTMLElement>('[data-testid="reticle"]');
    this.disposer.add(services.events.on('flight:hazardHit', ({ lethal }) => this.#markReticle(lethal), this));
    // SPEC-037 §4.2, §4.6: the HUD follows the scheme (the top centre spans the
    // gap on touch) and the flash follows its setting, now and live.
    hud.setScheme(services.input.state.scheme);
    hud.setDamageFlash(services.settings.get().damageFlash);
    this.disposer.add(services.events.on('input:schemeChanged', ({ scheme }) => hud.setScheme(scheme), this));
    this.disposer.add(
      services.events.on(
        'settings:changed',
        ({ patch }) => {
          if (patch.damageFlash !== undefined) hud.setDamageFlash(patch.damageFlash);
        },
        this,
      ),
    );
    // SPEC-037 §4.3: `<html data-play="flight">` while the trip is up.
    document.documentElement.dataset['play'] = 'flight';
    this.disposer.add(() => {
      delete document.documentElement.dataset['play'];
    });
    // SPEC-037 §4.3: while a line is up the tip strip holds, and on a short
    // screen the toasts do too; a hold never outlives the scene.
    this.disposer.add(
      services.events.on(
        'dialogue:started',
        () => {
          this.#aria?.hold(true);
          if (shortScreen()) this.ui.holdToasts(true);
        },
        this,
      ),
    );
    this.disposer.add(
      services.events.on(
        'dialogue:ended',
        () => {
          this.#aria?.hold(false);
          // SPEC-042 §4.1: a banner up on a short screen keeps the rack held.
          if (this.#banner?.holdingToasts !== true) this.ui.holdToasts(false);
        },
        this,
      ),
    );
    this.disposer.add(() => this.ui.holdToasts(false));

    // SPEC-032 §4.4: `Skip the run` under `runSkip`'s rule; it resumes the
    // scene and runs the skip on the next update, so the loop is live.
    // SPEC-044 §4.8: Save & Quit says what it costs — this jump's fuel is
    // spent, and Continue lands at the station (44-i: the landing too).
    const menu = new PauseMenu(
      // SPEC-045 §4.1: `Comms log` reads the shared dialogue layer's log.
      withComms(
        services,
        dialogueLayer(services.uiRoot, services.events, {
          input: services.input,
          saveKey: () => services.save.current,
          typewriter: () => services.settings.get().typewriter,
          speed: () => services.settings.get().dialogueSpeed,
        }).log,
        // SPEC-048 §4.4: Notes lists the chapters up to the destination's.
        () => this.#planet.chapter,
      ),
      () => services.requestResume(),
      {
        allowed: () => this.#canSkipRun(),
        run: () => {
          this.#skipPending = true;
          services.requestResume();
        },
      },
      undefined,
      { note: () => quitNote('flight', this.#planet.name, this.#jumpFuelCost) },
    );
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

    // SPEC-015 §6 / E22: the same auto-pause the surface takes on a rotation
    // into portrait, through the pause button's own path (AC-32).
    // SPEC-036 §4.3: the block also holds the trip — no `flight.update` while
    // the phone is upright, so a flight entered upright holds its launch until
    // the phone is turned.
    const rotate = new RotateOverlay(uiRootEl(), services.events, {
      onBlocked: () => void services.scenes.pause(),
    });
    this.#rotate = rotate;
    this.disposer.add(() => {
      rotate.dispose();
      this.#rotate = null;
    });
    // SPEC-015 §7, AC-38: held for the trip, released when the scene leaves.
    this.disposer.add(holdWakeLock());

    // The recall flash and the landing skip hint are the scene's own layers —
    // flight shows no death panel and declines the shared overlay (SPEC-014).
    this.#explosionEl = testId(el('div', 'flight-explosion'), 'flight-explosion');
    this.#skipHint = testId(el('p', 'flight-skip-hint is-hidden', 'Tap or press any key to skip'), 'skip-landing');
    this.ui.mount(this.#explosionEl, 'overlay');
    this.ui.mount(this.#skipHint, 'hud');
    // SPEC-035 §4.8: the same one-line hint strip the surface teaches with, in
    // the same `guide-layer` — which is what takes no pointer events and what
    // hides the strip between lines.
    const guide = el('div', 'guide-layer');
    this.ui.mount(guide, 'hud');
    const aria = new AriaHint(guide);
    this.#aria = aria;
    this.disposer.add(() => {
      aria.dispose();
      this.ui.unmount(guide);
      this.#aria = null;
    });
    // SPEC-035 §4.11: the hum runs until the scene does not.
    this.disposer.add(() => this.#stopEngineHum());
    // SPEC-032 §4.2: the hint shows over the launch shot as over the landing.
    this.#skipHint.classList.remove('is-hidden');
    // SPEC-032 §4.5: the autopilot card, over the fast-forwarded frame.
    this.#autopilotEl = testId(
      h(
        'div',
        { class: 'autopilot-card', role: 'status', 'aria-live': 'polite' },
        h('p', { class: 'autopilot-title' }, 'AUTOPILOT', h('span', { class: 'autopilot-sep' }, ' · ')),
        h('p', { class: 'autopilot-line' }, `arriving at ${this.#planet.name}`),
        h('div', { class: 'autopilot-bar' }, h('span', { class: 'autopilot-bar-fill' })),
      ),
      'autopilot-card',
    );
    this.ui.mount(this.#autopilotEl, 'overlay');
    this.disposer.add(() => {
      if (this.#explosionEl) this.ui.unmount(this.#explosionEl);
      if (this.#skipHint) this.ui.unmount(this.#skipHint);
      if (this.#autopilotEl) this.ui.unmount(this.#autopilotEl);
      this.#explosionEl = null;
      this.#skipHint = null;
      this.#autopilotEl = null;
    });

    // Dev builds only (SPEC-001 §9): a shortcut past the trip. Vite folds
    // `import.meta.env.DEV` to false in production, so neither the button nor
    // its handler ships.
    if (import.meta.env.DEV) {
      const skipTrip = testId(
        h('button', { class: 'ui-btn flight-dev-skip', type: 'button', onclick: () => this.#skipToPlanet() }, 'Skip to planet'),
        'dev-skip-flight',
      );
      this.ui.mount(skipTrip, 'hud');
      this.disposer.add(() => this.ui.unmount(skipTrip));
    }

    // 13-f: the cutscene skips on any key or tap; the fade still runs (AC-102).
    // SPEC-032 §4.2: the same listener ends the launch shot — a tap, or a
    // fresh key that is not Space — and leaves the simulation alone.
    const skip = (event: Event): void => {
      // SPEC-036 §4.3: a tap on the rotate overlay is not a skip.
      if (this.#rotate?.blocked === true) return;
      if (this.#landingT >= 0) this.#landingSkipped = true;
      else if (!this.#launchDone && this.#pauseMenu?.open !== true && skipsLaunch(event)) this.#endLaunch();
    };
    document.addEventListener('keydown', skip);
    document.addEventListener('pointerdown', skip);
    this.disposer.add(() => {
      document.removeEventListener('keydown', skip);
      document.removeEventListener('pointerdown', skip);
    });
  }

  /**
   * PLAN R8: the trip's art arrives after the scene is up — the shared models
   * and sprites through the asset cache (`FLIGHT_ASSETS`), the destination's
   * own sky and surface maps (`PLANET_ART`) through a loader this scene owns
   * and releases on exit. Until they land, and for good when they cannot, the
   * view keeps its primitives: never a blocking load, never an error screen.
   */
  #dress(): void {
    let alive = true;
    const owned: THREE.Texture[] = [];
    this.disposer.add(() => {
      alive = false;
      for (const texture of owned) texture.dispose();
      owned.length = 0;
    });
    const loader = new THREE.TextureLoader();
    const load = async (url: string | undefined, color: boolean): Promise<THREE.Texture | null> => {
      if (url === undefined) return null;
      try {
        const texture = await loader.loadAsync(url);
        texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        texture.anisotropy = 4; // three clamps to what the GPU offers
        // SPEC-015 §8, AC-8/AC-46: these maps never enter the asset cache — the
        // scene owns and releases them — but the texture budget is per preset,
        // not per loader. The destination sky is 2048 × 1536 and the planet
        // equirect 2048 × 1024, which is the whole of the flight scene's GPU
        // texture bill; uploading them at `medium`'s 1024 cap is what brings
        // that row back inside its ≤ 30 MB budget.
        clampTexture(texture, this.services.renderer.quality.textureMaxSize);
        if (!alive) {
          texture.dispose();
          return null;
        }
        owned.push(texture);
        return texture;
      } catch (error) {
        log.warn('scene', `flight art ${url} did not load; the primitive stays`, error);
        return null;
      }
    };
    const assets = this.services.assets;
    const shared = assets.load(FLIGHT_ASSETS).then(
      () => true,
      (error: unknown) => {
        log.warn('scene', 'the flight models did not load; the primitives stay', error);
        return false;
      },
    );
    const art = PLANET_ART[this.#planet.id];
    void Promise.all([shared, load(art.sky, true), load(art.surface, true), load(art.normal, false), load(art.emissive, true)]).then(
      ([ready, sky, surface, normal, emissive]) => {
        const view = this.#view;
        if (!alive || view === null) return;
        // A load that joined another pass in flight may not hold every id.
        const pick = <T>(get: () => T): T | null => {
          if (!ready) return null;
          try {
            return get();
          } catch {
            return null;
          }
        };
        view.useArt({
          sky,
          planet: surface === null ? null : { map: surface, normalMap: normal, emissiveMap: emissive },
          clouds: pick(() => assets.texture('clouds')),
          asteroid: pick(() => assets.model('asteroid')),
          fighter: pick(() => assets.model('fighter')),
          interceptor: pick(() => assets.model('interceptor')),
          cockpit: pick(() => assets.model('cockpit')),
          ember: pick(() => assets.texture('ember')),
          flare: pick(() => assets.texture('flare')),
        });
      },
    );
  }

  // ------------------------------------------------------------------- update

  protected override onUpdate(dt: number): void {
    const flight = this.#flight;
    if (flight === null) return;
    const input = this.services.input.state;
    this.#edges.beginStep(input.buttons, this.services.loop.stats.frame);
    // SPEC-014 AC-82: the touch pause button pauses through the input action;
    // Escape/P stay with the composition root's toggle.
    if (input.scheme === 'touch' && this.#edges.pressed('pause')) {
      this.services.scenes.pause();
    }
    // SPEC-036 §4.3, E65: the rotate block holds the trip — no `flight.update`,
    // and the launch shot and the view freeze with it.
    if (this.#rotate?.blocked === true) return;
    // SPEC-042 §4.1: the banner runs on this step; no beat holds a flight.
    this.#banner?.tick(dt, false);

    if (this.#skipPending) {
      this.#skipPending = false;
      this.#autopilot();
    }

    // SPEC-041 §4.9: the reticle's mark runs down before the step, so a mark
    // that step sets keeps its whole 0.1 s / 0.25 s.
    this.#stepReticleMark(dt);
    if (flight.phase !== 'arrived' && flight.phase !== 'recalled') {
      flight.update(dt, this.#readInput(input));
    }

    // SPEC-032 §4.1: the shot rides the launch phase's own clock (32-e) and
    // ends once, when the phase does or on a skip.
    if (!this.#launchDone) {
      if (flight.phase === 'launch') this.#view?.setLaunch(flight.time / LAUNCH_SECONDS);
      else this.#endLaunch();
    }

    switch (flight.phase) {
      case 'arrived':
        if (this.#autopilotT >= 0 && this.#autopilotT < AUTOPILOT_SECONDS) {
          // §4.5: the card holds for its 1.2 s, then the normal landing exit.
          this.#autopilotT += dt;
          if (this.#autopilotT >= AUTOPILOT_SECONDS) this.#landingSkipped = true;
          break;
        }
        this.#advanceLanding(dt);
        break;
      case 'recalled':
        this.#advanceRecall(dt);
        break;
      default:
        break;
    }

    // SPEC-035 §4.8: the throttle tip, 12 s after the steer tip, same trip.
    if (this.#throttleTipIn > 0) {
      this.#throttleTipIn -= dt;
      if (this.#throttleTipIn <= 0) this.#showTip('flight_throttle');
    }
    // SPEC-035 §4.11: the hum rides the throttle.
    this.#stepEngineHum(dt, flight.ship.throttle);

    this.#feedHud(flight);
    this.#view?.update(flight, dt);
  }

  /** The frame's `FlightInput`, written in place (no allocations in update). */
  #readInput(state: InputState): FlightInput {
    const flight = this.#flight as Flight;
    const frame = this.#frameInput;
    frame.steerX = state.move.x;
    // SPEC-045 §4.9: Invert flight up / down flips the keys' and the stick's
    // axis. Mouse steer chases the reticle instead and is unaffected (45-t).
    frame.steerY = this.services.settings.get().invertFlightY ? -state.move.y : state.move.y;
    frame.fire = state.buttons.fire.down;
    frame.autoFire = state.autoFire;
    frame.throttleUp = this.#edges.pressed('throttleUp');
    frame.throttleDown = this.#edges.pressed('throttleDown');
    frame.mouseSteer = this.services.settings.flightMouseSteer && state.scheme === 'keyboard' && state.aim.hasPointer;
    // SPEC-036 §4.1: only the keyboard scheme aims by the mouse. A finger has
    // no hover, so on touch the guns look down the ship's own lane — the
    // reticle, ARIA's assist cone and touch auto-fire all key off it.
    if (state.scheme === 'keyboard' && state.aim.hasPointer) {
      // The pointer's ray, dropped onto the convergence plane (§4.7).
      const scratch = this.#aimScratch;
      scratch.set(state.aim.ndcX, state.aim.ndcY, 0.5).unproject(this.camera).sub(this.camera.position);
      const along = -CONVERGE_DEPTH - this.camera.position.z;
      const t = scratch.z !== 0 ? along / scratch.z : 0;
      frame.aimX = this.camera.position.x + scratch.x * t;
      frame.aimY = this.camera.position.y + scratch.y * t;
    } else {
      // Straight ahead; the assist and auto-fire do the rest (§4.7).
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
    // SPEC-042 42-p: at the cap the bar reads full.
    model.xp[1] = xpToNext(player.level);
    model.xp[0] = player.level >= LEVEL_CAP ? model.xp[1] : player.xp - cumulativeXp(player.level);
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
          ? `Objective needs ${survive} s — throttle down, or the ship holds on arrival`
          : objective.line;
      model.objective = { title: objective.title, line, value: objective.value, target: objective.target };
    }

    // The reticle rides the system's (possibly snapped) aim point (§4.7).
    const scratch = this.#aimScratch;
    scratch.set(flight.reticle.x, flight.reticle.y, -CONVERGE_DEPTH).project(this.camera);
    hud.setReticle(scratch.x, scratch.y);

    // SPEC-041 §4.7: the lead pip, projected exactly like the reticle, while
    // ARIA is enabled and a ship sits in the cone — on every scheme. ARIA
    // disabled shows none (41-k).
    const lead = flight.lead;
    this.#leadShown = lead.active && flight.ariaEnabled;
    if (this.#leadShown) {
      scratch.set(lead.x, lead.y, -CONVERGE_DEPTH).project(this.camera);
      hud.setLeadPip(scratch.x, scratch.y);
    } else {
      hud.hideLeadPip();
    }
  }

  /**
   * SPEC-041 §4.9: a hit marks the reticle `is-hit` for 0.1 s, a kill `is-kill`
   * for 0.25 s — colour and scale only, so the marks stand under reduce motion.
   * A kill's mark is not cut short by a hit landing during it.
   */
  #markReticle(lethal: boolean): void {
    if (!lethal && this.#reticleMark === 'is-kill') return;
    const mark: ReticleMark = lethal ? 'is-kill' : 'is-hit';
    const node = this.#reticleEl;
    if (node !== null && this.#reticleMark !== mark) {
      if (this.#reticleMark !== '') node.classList.remove(this.#reticleMark);
      node.classList.add(mark);
    }
    this.#reticleMark = mark;
    this.#reticleMarkT = lethal ? RETICLE_KILL_SECONDS : RETICLE_HIT_SECONDS;
  }

  /** §4.9: run the reticle's mark down on the scene's clock; no DOM read, no allocation. */
  #stepReticleMark(dt: number): void {
    if (this.#reticleMark === '') return;
    this.#reticleMarkT -= dt;
    if (this.#reticleMarkT > 0) return;
    this.#reticleEl?.classList.remove(this.#reticleMark);
    this.#reticleMark = '';
  }

  // -------------------------------------------------------------------- exits

  #advanceLanding(dt: number): void {
    if (this.#landingT < 0) {
      this.#landingT = 0;
      if (this.#autopilotT < 0) this.#skipHint?.classList.remove('is-hidden');
    }
    this.#landingT += dt;
    if (this.#landingSkipped) this.#landingT = LANDING_SECONDS; // 13-f: instant
    this.#view?.setLanding(this.#landingT / LANDING_SECONDS);
    if (this.#landingT < LANDING_SECONDS || this.#leaving) return;
    this.#leaving = true;
    const save = this.#save;
    if (save !== null && !this.#ephemeralSave) {
      // AC-35: the landing commits the destination and writes at the safe
      // point; the surface scene reads `firstLanding` from its params. The
      // visit count itself belongs to the scene being visited — SPEC-012's
      // surface `onEnter` increments it on every route in (the landing, and a
      // forced `?scene=surface` jump alike), so counting it here as well would
      // score one landing twice and skip a `rng.visit` stream (SPEC-008 §4.2).
      save.progress.currentPlanet = this.#planet.id;
      save.progress.location = 'surface';
      this.services.save.request('landing');
    }
    void this.services.go('surface', { planet: this.#planet.id, firstLanding: this.#firstLanding });
  }

  /**
   * Dev builds only: fast-forward the trip through `Flight.fastForward` — the
   * one fast-forward path (SPEC-032 §4.5) — then land at once (13-f's instant
   * skip). The real `update()` runs throughout, so `flight:arrived`, the
   * missions' timers and the landing's save write are the ones a flown trip
   * makes. During the landing cutscene it just skips the cutscene.
   */
  #skipToPlanet(): void {
    const flight = this.#flight;
    if (flight === null || flight.phase === 'recalled') return;
    // The skip replaces the trip, so it resolves what the trip was carrying:
    // an accepted flight mission is finished, not left open in the air (PLAN
    // R16). Otherwise the Hive is landed on with `c5_m1` unflown and its whole
    // surface locked — and the landing gate would hold the sky for 90 s first.
    const missions = this.#missions;
    if (missions !== null) {
      for (const id of missions.active.map((state) => state.id)) missions.forceComplete(id);
    }
    this.#endLaunch();
    flight.fastForward(DEV_SKIP_LIMIT_SECONDS);
    this.#landingSkipped = true;
  }

  /**
   * SPEC-032 §4.3: may this run be skipped from the pause menu? The rule of
   * `runSkip` (service mode waives it), on a trip still under way and not
   * already on autopilot.
   */
  #canSkipRun(): boolean {
    const flight = this.#flight;
    const save = this.#save;
    if (flight === null || save === null || this.#ephemeralSave) return false;
    if (tripOver(flight) || this.#autopilotT >= 0 || this.#leaving) return false;
    return runSkip(save, this.#planet.id, { service: this.services.settings.serviceMode }).ok;
  }

  /**
   * SPEC-032 §4.5: the player's skip. The trip runs through `fastForward` —
   * the same `update` steps a flown trip takes, so nothing is credited that
   * flying would not credit and no flight mission is completed — under the
   * autopilot card, which holds for `AUTOPILOT_SECONDS` before the normal
   * landing exit. A recall during it (32-b) takes the explosion exit instead.
   */
  #autopilot(): void {
    const flight = this.#flight;
    if (flight === null || tripOver(flight) || this.#autopilotT >= 0) return;
    this.#endLaunch();
    this.#skipHint?.classList.add('is-hidden');
    flight.fastForward(DEV_SKIP_LIMIT_SECONDS);
    if (flight.phase !== 'arrived') return; // 32-b: recalled — no card
    this.#autopilotT = 0;
    this.#autopilotEl?.classList.add('is-visible');
  }

  /** SPEC-032 §4.2: end the launch shot once — the tug dropped, the cockpit in. */
  #endLaunch(): void {
    if (this.#launchDone) return;
    this.#launchDone = true;
    this.#view?.skipLaunch();
    if (this.#landingT < 0) this.#skipHint?.classList.add('is-hidden');
    this.#playAcceptLines();
    // SPEC-035 §4.8: the rail explained nothing at all. The steer tip lands the
    // moment the player has control, the throttle tip 12 s later.
    this.#showTip('flight_steer');
    // The throttle tip only ever follows the steer tip: a run with the tip
    // layer off (a `?perf` pass, guidance turned down) arms no timer at all,
    // so nothing can surface 12 s later without the steer tip having had its
    // turn first. A returning player who saw only the steer tip still gets it.
    if (this.#tipsOn()) this.#throttleTipIn = THROTTLE_TIP_DELAY;
    // SPEC-035 §4.11: the engine comes up with the cockpit.
    this.#startEngineHum();
  }

  /**
   * SPEC-035 §4.8 — one tip, once per device (`settings.tipsSeen`), never in a
   * `?perf` run and never when the player turned the guidance layer down. The
   * wording follows the scheme in use at the moment it shows.
   */
  #showTip(id: TipId): void {
    const aria = this.#aria;
    if (aria === null || !this.#tipsOn()) return;
    const settings = this.services.settings;
    // SPEC-036 §4.2: seen per wording — the live scheme's is the one asked.
    const scheme = this.services.input.state.scheme;
    if (!tipDue(settings.get().tipsSeen, id, scheme)) return;
    aria.show(scheme === 'touch' ? TIPS[id].touch : TIPS[id].keyboard, TIP_MS);
    settings.set({ tipsSeen: [...settings.get().tipsSeen, tipKey(id, scheme)] });
  }

  /** Whether this run shows tips at all (§4.8): never under `?perf`, never with guidance turned down. */
  #tipsOn(): boolean {
    return this.#aria !== null && this.services.perf !== true && this.services.settings.get().guidance === 'full';
  }

  /** SPEC-035 §4.11: the looping hum, at priority 0 so nothing else loses a voice. */
  #startEngineHum(): void {
    if (this.#engineVoice !== null) return;
    this.#engineVoice = this.services.audio.play('engine_hum', {
      loop: true,
      priority: 0,
      volume: engineVolume(this.#flight?.ship.throttle ?? 1),
    });
    this.#engineVolumeIn = ENGINE_VOLUME_INTERVAL;
  }

  /** §4.11: re-read the throttle four times a second, not every frame. */
  #stepEngineHum(dt: number, throttle: number): void {
    const voice = this.#engineVoice;
    if (voice === null) return;
    this.#engineVolumeIn -= dt;
    if (this.#engineVolumeIn > 0) return;
    this.#engineVolumeIn = ENGINE_VOLUME_INTERVAL;
    voice.setVolume(engineVolume(throttle));
  }

  #stopEngineHum(): void {
    this.#engineVoice?.stop();
    this.#engineVoice = null;
  }

  /**
   * SPEC-034 §4.10 step 2: the `onAccept` line of every active flight mission of
   * this destination, once the launch shot is out of the way. A flight mission's
   * brief was written to be heard on the way there, and nothing played it — the
   * station board accepts it and the trip started in silence.
   *
   * Lines are non-modal here: the flight never holds for one, so the rail keeps
   * moving underneath.
   */
  #playAcceptLines(): void {
    const save = this.#save;
    const missions = this.#missions;
    if (save === null || missions === null) return;
    for (const state of missions.active) {
      const id = MISSIONS[state.id].dialogue.onAccept;
      if (id === undefined) continue;
      this.#playLine(save, id);
    }
  }

  /**
   * SPEC-048 §4.3: the flight's clue tracker — kills in, the destination as its
   * planet. A clue's line is found as it starts (`dialogue:started`): its flag
   * through the flight's economy, a checkpoint, and Notes' unread mark; a clue
   * found under the pause menu dots `pause-comms` at once.
   */
  #watchClues(save: Save, economy: Economy, bus: EventBus<GameEvents>): void {
    const tracker = new ClueTracker();
    const flags = new FlagView();
    const scene: ClueScene = {
      planet: this.#planet.id,
      get flags(): ReadonlySet<string> {
        return flags.of(save.progress.flags);
      },
      firstRun: (mission) => {
        const missions = this.#missions;
        return missions !== null && missions.active.some((state) => state.id === mission) && !missions.isReplay(mission);
      },
      hasShelter: () => false,
    };
    this.disposer.add(bus.on('enemy:killed', ({ enemyId }) => this.#playClue(tracker, tracker.onKill(enemyId, scene)), this));
    // Review 2026-10 S-04: a flight echo — its clue's line on a group of its
    // enemy, one at a time, until the line's start finds the clue.
    let echoOut = false;
    this.disposer.add(
      bus.on(
        'flight:groupSpawned',
        ({ enemy }) => {
          if (echoOut) return;
          const line = flightEchoDue(enemy, this.#planet.id, scene.flags);
          if (line === null) return;
          echoOut = true;
          void dialogueLayer(this.services.uiRoot, this.services.events, {
            input: this.services.input,
            saveKey: () => this.services.save.current,
            typewriter: () => this.services.settings.get().typewriter,
            speed: () => this.services.settings.get().dialogueSpeed,
          })
            .play(line, { modal: false })
            .then(() => {
              echoOut = false;
            });
        },
        this,
      ),
    );
    this.disposer.add(
      bus.on(
        'dialogue:started',
        ({ id }) => {
          const def = tracker.started(id, scene.flags);
          if (def === null) return;
          // Unread first: `setFlag`'s `story:clue` is what dots `pause-comms`.
          NOTES_UNSEEN.mark(save);
          economy.setFlag(def.id);
          this.services.save.request('checkpoint');
        },
        this,
      ),
    );
    this.disposer.add(bus.on('story:clue', () => this.#pauseMenu?.refreshNotes(), this));
  }

  /**
   * SPEC-048 §4.3: a clue's first line on the flight's non-modal path, past the
   * ledger — the flag gates it — and its pending mark settled when `play` is,
   * played or dropped (E75).
   */
  #playClue(tracker: ClueTracker, def: ClueDef | null): void {
    if (def === null) return;
    const line = def.lines[0];
    if (line === undefined) {
      tracker.settle(def.id);
      return;
    }
    void dialogueLayer(this.services.uiRoot, this.services.events, {
      input: this.services.input,
      saveKey: () => this.services.save.current,
      typewriter: () => this.services.settings.get().typewriter,
      speed: () => this.services.settings.get().dialogueSpeed,
    })
      .play(line, { modal: false })
      .then(() => tracker.settle(def.id));
  }

  /** Plays a mission line once per save, through the shared ledger (§4.10). */
  #playLine(save: Save, id: DialogueId): void {
    if (LINE_LEDGER.played(save, id)) return;
    LINE_LEDGER.markPlayed(save, id);
    void dialogueLayer(this.services.uiRoot, this.services.events, {
      input: this.services.input,
      saveKey: () => this.services.save.current,
      typewriter: () => this.services.settings.get().typewriter,
      speed: () => this.services.settings.get().dialogueSpeed,
    }).play(id, { modal: false });
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
    // SPEC-038 §4.6: the pause menu is where Settings changes the difficulty,
    // so the trip picks it up here — it is never cached for the whole run.
    const save = this.#save;
    if (save !== null) this.#flight?.setDifficulty(save.meta.difficulty, save.meta.iteration);
  }

  /**
   * SPEC-040 §4.2: idle while the rotate block holds the trip — `flight.update`
   * is skipped then (E65), so nothing on screen moves and the pacer draws at
   * most five frames a second.
   */
  idle(): boolean {
    return this.#rotate?.blocked === true;
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
      // SPEC-020 20-g: how far the sky window has shifted toward the accent,
      // so the storm tint is readable from outside the renderer.
      info['skyTint'] = Number((this.#view?.stormTint ?? 0).toFixed(2));
      // SPEC-015 AC-39: the degrees the horizon is rolled by, after the
      // reduce-motion clamp — 8° is the ceiling the criterion names.
      info['roll'] = Number((this.#view?.cameraRollDeg ?? 0).toFixed(2));
      // SPEC-032 AC: how far through the launch shot, 1 once it is over.
      info['launch'] = this.#launchDone ? 1 : Number(Math.min(1, this.#view?.launch ?? 1).toFixed(3));
      info['cameraZ'] = Number(this.camera.position.z.toFixed(3));
      // SPEC-036 §4.1: where the guns look and where the ship is, in metres —
      // on touch the two agree, unless ARIA's cone captured a ship ahead.
      info['reticleX'] = Number(flight.reticle.x.toFixed(2));
      info['reticleY'] = Number(flight.reticle.y.toFixed(2));
      info['shipX'] = Number(flight.ship.x.toFixed(2));
      info['shipY'] = Number(flight.ship.y.toFixed(2));
      // SPEC-041 §4.7: 1 while the lead pip is up.
      info['lead'] = this.#leadShown ? 1 : 0;
      // SPEC-063 §4.5: the enemies whose contact fired on this trip, in order,
      // card or not — comma-separated, the row's values being flat, and '-'
      // before any has (the debug row has no empty values).
      info['contacts'] = this.#contacts.length === 0 ? '-' : this.#contacts.join(',');
    }
    return info;
  }
}
