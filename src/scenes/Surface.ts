// The surface scene (SPEC-012) — the composition root that wires layout,
// camera and aim, combat (SPEC-011), the spawn director, pickups and nodes,
// weather, the mission runtime, death/respawn, the pad terminal, and the
// SPEC-014 HUD/overlay layer around one planet visit.
//
// Input discipline: no code here reads `buttons.*.justPressed` directly. The
// fixed-step loop runs 0..5 updates per frame while `justPressed` is a
// per-frame latch, so every press goes through `PressEdges`, which fires each
// press on exactly one step (the round-2 review's double-fire regression is
// pinned by tests/core/pressEdges.test.ts).
import * as THREE from 'three';
import type { EventBus, GameEvents } from '@/core/Events';
import { log } from '@/core/Log';
import { Pool } from '@/core/Pool';
import { PressEdges } from '@/core/PressEdges';
import { DEFAULT_LOOK, type Look } from '@/core/Quality';
import { newSave, type CharacterCreation, type SaveV1 } from '@/core/Save';
import type { GameServices } from '@/core/Services';
import type { SceneParams } from '@/core/StateMachine';
import type { Renderer } from '@/core/Renderer';
import {
  BOSS_REVEALS,
  DIALOGUE,
  ENEMIES,
  FOLLOWERS,
  ITEMS,
  MISSIONS,
  PLANETS,
  SURFACE_ASSETS,
  SURFACE_SHARED_ASSETS,
  TUNING,
  type BossRevealDef,
  type Dialogue,
  type DialogueId,
  type EnemyId,
  type Item,
  type ItemId,
  type MissionDef,
  type MissionId,
  type PlanetDef,
  type PoiId,
  type ResourceId,
  MESH_RECIPE_IDS,
} from '@/data/index';
import { makeEnemy, type EnemyEntity } from '@/entities/Enemy';
import { makeFollower } from '@/entities/Follower';
import { makePlayer } from '@/entities/Player';
import { makeProjectile } from '@/entities/Projectile';
import type { ArenaState } from '@/entities/World';
import { Combat, computePlayerStats, type CombatWorld } from '@/systems/Combat';
import { Economy } from '@/systems/Economy';
import { generateLayout, ObstacleGrid, type Layout, type LayoutPoi } from '@/systems/Layout';
import { Missions, type MissionContext } from '@/systems/Missions';
import { Nodes, Pickups } from '@/systems/Pickups';
import { cumulativeXp, Progression, xpToNext } from '@/systems/Progression';
import { SpawnDirector, type FrustumXZ } from '@/systems/Spawn';
import { Weather, WEATHER_EFFECTS, type WeatherEffects } from '@/systems/Weather';
import { revealCamera, revealDue, revealKey, stayReport, type Ending } from '@/systems/StoryBeats';
import { hasNodeRadar } from '@/systems/UiHelpers';
import { UiScene } from '@/scenes/base';
import { director } from '@/scenes/Director';
import { INSTANCES_PER_PART } from '@/views/ProceduralMeshes';
import { layerFromAssets } from '@/views/ProceduralTextures';
import { advanceViewTime, RESOURCE_COLORS, shakeOffset, SurfaceView, type ShakeState } from '@/views/SurfaceView';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { DamageNumbers } from '@/ui/DamageNumbers';
import { DeathOverlay } from '@/ui/DeathOverlay';
import { EndingOverlay } from '@/ui/EndingOverlay';
import { dialogueLayer, type DialogueUI } from '@/ui/DialogueUI';
import { el, h, testId } from '@/ui/dom';
import { Hud } from '@/ui/Hud';
import { Minimap, type MinimapPoi } from '@/ui/Minimap';
import { PauseMenu } from '@/ui/PauseMenu';
import { RevealOverlay } from '@/ui/RevealOverlay';
import { RotateOverlay } from '@/ui/RotateOverlay';
import { TouchControls } from '@/ui/TouchControls';

/** §4.3 — the fixed camera. */
const CAMERA_FOV = 40;
const CAMERA_PITCH = (55 * Math.PI) / 180;
const CAMERA_YAW = (45 * Math.PI) / 180;
const CAMERA_DISTANCE = 28;
/** §4.3: look-at bias, metres ahead of the player in the movement direction. */
const LOOK_AHEAD = 2;
/** Touch aim-drags point the shot this far ahead (matches SPEC-011's demo). */
const AIM_DRAG_DISTANCE = 12;

/** §4.12: a POI within this range of the player becomes discovered. */
const DISCOVER_RANGE = 40;
/** Hands-free scan: this long inside a scan POI's radius (§7, SPEC-011 e2e). */
const SCAN_SECONDS = 3;

/** §4.8 — the death round trip. */
const DEATH_OVERLAY_SECONDS = 2.5;
const DEATH_DESPAWN_RADIUS = 40;

/** 12-i: a storm forced by an active survive stage waits this long after enter. */
const FORCED_WEATHER_GRACE = 3;
/** §4.6: the fog/overlay/aggro response lerps over 3 s. */
const WEATHER_LERP_SECONDS = 3;

/** The boss arena disengages past this distance when the boss lost interest. */
const ARENA_DISENGAGE_DISTANCE = 45;
/** E13: the escort follower respawns at `from` this long after dying. */
const FOLLOWER_RESPAWN_SECONDS = 3;
/** Defend POIs take contact damage from enemies inside `radius + this`. */
const DEFEND_CONTACT_MARGIN = 2;

/** Music switching hysteresis, so a grazing shot cannot strobe the bed. */
const MUSIC_HOLD_SECONDS = 2;
/** AC-71: the glitch dialogue static burst. */
const STATIC_BURST_MS = 600;
/** The minimap repaints at 4 Hz — plenty for 1 px = 1 m. */
const MINIMAP_INTERVAL = 0.25;

// ------------------------------------------------------------- SPEC-019 §4.6

/** Player-hit shake and the heavy boss-phase / wurm-resurface shake (§4.7). */
const HIT_SHAKE_AMPLITUDE = 0.15;
const HIT_SHAKE_SECONDS = 0.25;
const HEAVY_SHAKE_AMPLITUDE = 0.5;
const HEAVY_SHAKE_SECONDS = 0.5;
/** The muzzle burst sits this far along `facing`, at the capsule's nose. */
const MUZZLE_OFFSET = 0.6;
/** Weather damage surfaces as one accumulated red number per second (19-m). */
const WEATHER_NUMBER_SECONDS = 1;
/** Burst colours: the player-hit red, the item-pickup and muzzle warm white. */
const HIT_BURST_COLOR = 0xff5533;
const ITEM_PICKUP_COLOR = 0xffe9a0;
const MUZZLE_COLOR = 0xffe9a0;

/** `'#rrggbb'` → the number `CombatFx.burst` takes; no allocation. */
function hexColor(color: string): number {
  return Number.parseInt(color.slice(1), 16);
}

/** The stand-in pilot for a bare `?scene=surface` jump with no loaded save. */
const JUMP_CREATION: CharacterCreation = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
};

const DIALOGUE_TABLE: Readonly<Record<DialogueId, Dialogue>> = DIALOGUE;
const ITEM_TABLE: Readonly<Record<ItemId, Item>> = ITEMS;
const MISSION_TABLE: Readonly<Record<MissionId, MissionDef>> = MISSIONS;

/**
 * Accept dialogues already shown for a save, page-lifetime (§4.1 step 5: the
 * ARIA `onAccept` line plays on landing for a mission accepted at the station
 * "if not yet shown"). Keyed by the save object like `DialogueUI`'s seen-set —
 * the save schema carries no seen list, so a reload replays at most once.
 */
const ACCEPT_SHOWN = new WeakMap<object, Set<MissionId>>();

function acceptShown(save: SaveV1): Set<MissionId> {
  let set = ACCEPT_SHOWN.get(save);
  if (set === undefined) {
    set = new Set();
    ACCEPT_SHOWN.set(save, set);
  }
  return set;
}

interface PoiRuntime {
  poi: LayoutPoi;
  discovered: boolean;
  inside: boolean;
  /** Seconds accumulated toward the hands-free scan. */
  scanFor: number;
  scanned: boolean;
}

/** A boss reveal in flight (SPEC-023 §4.4): the clock and the camera's two ends. */
interface RevealState {
  /** Seconds since the beat started; `revealCamera` reads it. */
  t: number;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  /** The hold's roar and words fire once, on the step that reaches it. */
  held: boolean;
  /** What `input.enabled` was before the beat took it. */
  inputWas: boolean;
}

/** §4.4: the longest frame the held view clock will believe (E23's cap, per beat). */
const HELD_FRAME_CAP = 0.1;

/**
 * `BOSS_REVEALS` read through a schema type, keyed by any enemy: the arena
 * hands over the stage's `EnemyId` and only the five bosses have a reveal
 * (the pattern `systems/Economy.ts` uses on the content tables).
 */
const BOSS_REVEAL_TABLE: Partial<Record<EnemyId, BossRevealDef>> = BOSS_REVEALS;

export class SurfaceScene extends UiScene<'surface'> {
  override readonly pausable = true;
  /**
   * SPEC-017 §4.5: `SurfaceView` brings its own hemisphere, key, rim and
   * torch, so the base's flat ambient would only wash them out.
   */
  protected override readonly ownsLighting = true;

  readonly #edges = new PressEdges();

  #planet: PlanetDef = PLANETS.cinder4;
  #save: SaveV1 | null = null;
  #layout: Layout | null = null;
  #world: CombatWorld | null = null;
  #combat: Combat | null = null;
  #economy: Economy | null = null;
  #missions: Missions | null = null;
  #spawn: SpawnDirector | null = null;
  #weather: Weather | null = null;
  #pickups: Pickups | null = null;
  #nodes: Nodes | null = null;
  #view: SurfaceView | null = null;
  #hud: Hud | null = null;
  #minimap: Minimap | null = null;
  #death: DeathOverlay | null = null;
  #dialogue: DialogueUI | null = null;
  #touch: TouchControls | null = null;
  #pauseMenu: PauseMenu | null = null;

  #pois: PoiRuntime[] = [];
  #pad: LayoutPoi | null = null;
  #arenaPoi: LayoutPoi | null = null;
  #arena: ArenaState | null = null;
  #bossId: number | null = null;

  // SPEC-023 §4.4 — the boss reveal. `#holds` is the beat-hold counter
  // SPEC-024's ending shares: while it is above zero the fixed step advances
  // the beat and nothing else, so nothing can touch the player (AC-40).
  #holds = 0;
  #reveal: RevealState | null = null;
  /** 23-b: the arena woke behind a modal dialogue; the reveal waits for it. */
  #revealPending: EnemyId | null = null;
  #revealOverlay: RevealOverlay | null = null;

  // Weather response state (§4.6): targets move on `weather:changed`, the
  // scene lerps `#stormIntensity` toward them over 3 s.
  #stormEffects: WeatherEffects = WEATHER_EFFECTS.sandstorm;
  #stormIntensity = 0;
  #stormTarget = 0;
  #stormOverlay: HTMLElement | null = null;

  #terminal: HTMLElement | null = null;
  #terminalOpen = false;

  #deathAt: number | null = null;
  #modalOpen = 0;
  #choiceFor: MissionId | null = null;
  #leaving = false;
  /** False from `dispose()`; what an awaited beat comes back to (SPEC-024 §4.1). */
  #alive = true;

  // SPEC-024 §4.1 — the ending sequence. `#ending` is set before `choose()`, so
  // the `mission:completed` that follows knows to hold `c6_m2_done` back; it
  // goes back to null when the stay overlay hands the planet over to free roam.
  #ending: Ending | null = null;
  #endingFor: MissionId | null = null;

  #defendPoi: LayoutPoi | null = null;
  #defendHp = 0;
  #defendMax = 0;
  #defendWave: { id: number } | null = null;
  #defendDamageAccum = 0;
  #followerRespawnIn = 0;

  /** The view clock `SurfaceFrame.time` reads (SPEC-019 §4.7, SPEC-023 §4.4). */
  #viewTime = 0;
  /** The view time of the last rendered frame — what `SurfaceFrame.dt` spans. */
  #lastViewTime = 0;
  /**
   * View seconds that accrued while the simulation was held (SPEC-023 §4.4).
   * `world.time` stands still through a beat, so this is what keeps the boss
   * breathing; it only ever grows, so the view clock stays monotonic.
   */
  #heldViewTime = 0;
  /** `performance.now()` of the last rendered frame, in seconds; −1 before the first. */
  #lastRenderWall = -1;

  // SPEC-019 §4.6–§4.7 — hit feedback state, all scene-local (19-i).
  #numbers: DamageNumbers | null = null;
  readonly #shake: ShakeState = { amplitude: 0, until: 0, duration: 0 };
  readonly #hitStop = { frames: 0, time: 0 };
  /** Per-slot HP deltas for enemy damage numbers (§4.6, 19-f). */
  readonly #enemyHp = new Float32Array(INSTANCES_PER_PART * MESH_RECIPE_IDS.length);
  readonly #enemyHpId = new Int32Array(INSTANCES_PER_PART * MESH_RECIPE_IDS.length).fill(-1);
  /** Weather damage accumulates into one red number per second (19-m). */
  #weatherDamage = 0;
  #weatherNumberIn = WEATHER_NUMBER_SECONDS;
  /** ≥ 0: a pickup sparkle is pending for this frame, in this colour (§4.6). */
  #pickupColor = -1;
  /** The fire edge: `fireCooldown` rose since the last rendered frame. */
  #lastFireCooldown = 0;
  /** The wurm telegraph edge tracker (§4.6). */
  #telegraphWas = false;
  #telegraphX = 0;
  #telegraphZ = 0;
  /** The `palette.ground` burst colour, resolved once per planet. */
  #groundColor = 0xffffff;
  readonly #projectScratch = new THREE.Vector3();
  readonly #shakeScratch = new THREE.Vector3();
  readonly #screenPoint = { x: 0, y: 0 };

  #music: 'surface_calm' | 'surface_combat' | 'boss' = 'surface_calm';
  #musicHold = 0;
  #minimapIn = 0;
  #touchHint: string | null = null;

  // Debug-overlay counters (`?debug`, §4.5 observability; e2e reads them).
  #spawned = 0;
  #elites = 0;
  #kills = 0;
  /** What the last death sweep removed (AC-48; e2e reads it). */
  #despawnedAtDeath = 0;
  /** The last mouse/touch aim ground projection (AC-10/11; e2e reads it). */
  readonly #aimDebug = { x: 0, z: 0, has: false };

  // The per-step mission context, built once — closures over live state, no
  // per-step allocation (SPEC-001 §7). `player`/`follower` are mutable
  // snapshots refreshed in place each step.
  readonly #ctxPlayer = { x: 0, z: 0, alive: true };
  readonly #ctxFollower = { x: 0, z: 0, alive: true };
  #ctx: MissionContext | null = null;

  // HUD model scratch (SPEC-001 §7): `Hud.flush` diffs against a clone, so the
  // model may point at these reused objects.
  readonly #objScratch = { title: '', line: '', value: 0, target: 1 };
  #consumableScratch: { itemId: ItemId; qty: number } | null = null;

  // Defend/escort stages resync only when their identity changes — accepting
  // or completing an unrelated mission must not restart the wave or respawn
  // the follower (the adjudication round's nonblocking note).
  #defendKey: string | null = null;
  #escortKey: string | null = null;

  // Scratch buffers — reused every frame (SPEC-001 §7).
  readonly #aimScratch = new THREE.Vector3();
  readonly #aimPoint = { x: 0, z: 0 };
  readonly #camTarget = { x: 0, z: 0 };
  readonly #frustum = new THREE.Frustum();
  readonly #frustumMatrix = new THREE.Matrix4();
  readonly #frustumSphere = new THREE.Sphere();
  readonly #frustumXZ: FrustumXZ = {
    contains: (x: number, z: number, margin = 0): boolean => {
      this.#frustumSphere.center.set(x, 0, z);
      this.#frustumSphere.radius = Math.max(0.001, margin);
      return this.#frustum.intersectsSphere(this.#frustumSphere);
    },
  };
  readonly #minimapPois: MinimapPoi[] = [];
  readonly #minimapNodes: { x: number; z: number }[] = [];
  readonly #minimapEnemies: { x: number; z: number }[] = [];
  readonly #objectivePois = new Set<PoiId>();

  constructor(services: GameServices) {
    super(services, 'surface', 'surface_calm');
  }

  protected override look(): Partial<Look> {
    return this.#view?.look ?? {};
  }

  protected onEnter(params: SceneParams['surface']): void {
    const services = this.services;
    const planet = PLANETS[params.planet];
    this.#planet = planet;
    // SPEC-024 §4.1: the ending sequence awaits a dialogue, a film and an
    // overlay in turn; each step comes back to this before it touches the scene.
    this.disposer.add(() => {
      this.#alive = false;
    });

    // A bare `?scene=` jump has no loaded save; run on an in-memory one seeded
    // from the session root (never persisted — SPEC-007 owns the slots).
    const save = services.save.current ?? newSave(0, JUMP_CREATION, services.rng.seed, Date.now());
    this.#save = save;

    // §4.1 step 1: the layout stream, then the per-visit runtime stream. This
    // is the one place the visit count moves (SPEC-008 §4.2): every route onto
    // a planet — the flight scene's landing and a forced `?scene=surface` jump
    // alike — arrives through this `onEnter`, so counting it here counts it
    // once and keeps the visit streams consecutive.
    const layout = generateLayout(planet, services.rng.layout(planet.id));
    this.#layout = layout;
    const visits = (save.progress.visits[planet.id] ?? 0) + 1;
    save.progress.visits[planet.id] = visits;
    const visit = services.rng.visit(planet.id, visits);

    save.progress.location = 'surface';
    save.progress.currentPlanet = planet.id;

    const grid = new ObstacleGrid(layout);

    // §4.1 step 3: landing always restores HP (SPEC-011 §4.8).
    const stats = computePlayerStats(save);
    save.player.hp = stats.maxHp;
    const world: CombatWorld = {
      player: makePlayer(layout.playerSpawn.x, layout.playerSpawn.z, stats.maxHp),
      stats,
      enemies: new Pool(makeEnemy),
      projectiles: new Pool(makeProjectile),
      follower: null,
      obstacles: grid,
      arena: null,
      time: 0,
    };
    world.player.facing = layout.playerSpawn.facing;
    this.#world = world;

    const bus = services.events as EventBus<GameEvents>;
    const progression = new Progression(save, bus);
    const economy = new Economy(save, bus, progression, services.save);
    this.#economy = economy;
    const combat = new Combat(world, save, economy, progression, bus, {
      loot: visit.fork('loot'),
      ai: visit.fork('ai'),
      combat: visit.fork('combat'),
    });
    this.#combat = combat;
    this.disposer.add(() => combat.dispose());

    // §4.1 step 4: the runtimes.
    const missions = new Missions(save, economy, bus, 'surface', planet.id, services.save);
    this.#missions = missions;
    this.disposer.add(() => missions.dispose());

    const spawn = new SpawnDirector(planet, layout, world.enemies, services.renderer.quality, visit.fork('spawn'), bus, combat);
    spawn.setObstacles(grid);
    spawn.setObjectiveEnemies(missions.objectiveEnemies());
    this.#spawn = spawn;

    const weather = new Weather(planet, visit.fork('weather'), bus);
    this.#weather = weather;

    const pickups = new Pickups(economy, bus);
    this.#pickups = pickups;
    const regenOf = (resource: ResourceId): number =>
      planet.surface.nodes.find((n) => n.resource === resource)?.regenPerSec ?? 0;
    this.#nodes = new Nodes(layout.nodes, regenOf, {
      addResource: (r, n, s) => economy.addResource(r, n, s),
      room: (r) => Math.max(0, economy.cargoCap() - (save.resources[r] ?? 0)),
    });

    // POI runtime state; discovery restores from the save (§4.12).
    this.#pois = layout.pois.map((poi) => ({
      poi,
      discovered:
        poi.kind === 'landing_pad' ||
        save.progress.poisDiscovered.includes(`${planet.id}:${poi.poi}:${poi.instance}`),
      inside: false,
      scanFor: 0,
      scanned: false,
    }));
    this.#pad = layout.pois.find((p) => p.kind === 'landing_pad') ?? null;
    this.#arenaPoi = layout.pois.find((p) => p.kind === 'arena') ?? null;

    // The mission context: one object for the scene's lifetime; `#missionCtx`
    // refreshes the player/follower snapshots in place each step.
    this.#ctx = {
      player: this.#ctxPlayer,
      poiAt: (id: PoiId) => layout.pois.filter((p) => p.poi === id),
      heldResource: (r: ResourceId) => save.resources[r] ?? 0,
      nearPoi: (id: PoiId, radius?: number) => {
        for (const p of layout.pois) {
          if (p.poi !== id) continue;
          const reach = radius ?? p.radius;
          if (Math.hypot(world.player.x - p.x, world.player.z - p.z) <= reach) return p;
        }
        return null;
      },
      follower: null,
    };

    // §4.1 step 2: the world view (SPEC-018: with the asset cache, so the
    // sculpted props can take the per-planet GLBs once they land; SPEC-019:
    // with the save's appearance, so the salvager wears the creation tint).
    const view = new SurfaceView(
      this.scene,
      layout,
      planet,
      services.renderer.quality,
      services.assets,
      { primary: save.player.appearance.primary, secondary: save.player.appearance.secondary },
    );
    view.reduceMotion = services.settings.get().reduceMotion;
    this.#view = view;
    this.disposer.add(() => view.dispose());
    this.#groundColor = hexColor(planet.surface.palette.ground);

    // SPEC-018 §4.10: the lazy per-planet drop, merged with the shared
    // surface set (SPEC-019 §4.8: the probe rides along; boot stays five
    // files). The shared promise dedupes by id; the `.then` checks disposal
    // before touching the view (18-m).
    const surfaceAssets = SURFACE_ASSETS[planet.biome];
    {
      let disposed = false;
      this.disposer.add(() => {
        disposed = true;
      });
      void services.assets
        .load({
          models: { ...surfaceAssets.models, ...SURFACE_SHARED_ASSETS.models },
          textures: { ...surfaceAssets.textures },
          audio: {},
        })
        .then(() => {
          if (disposed || Object.keys(surfaceAssets.textures).length === 0) return;
          const [layerA, layerB] = planet.surface.look.ground.layers;
          const [metresA, metresB] = planet.surface.look.ground.tileMetres;
          view.setGroundTextures(
            layerFromAssets(services.assets, layerA, metresA),
            layerFromAssets(services.assets, layerB, metresB),
          );
        })
        .catch((cause) => log.warn('surface', 'planet assets unavailable; procedural layers stay', cause));
    }
    // SPEC-017 §4.1: the planet's grade only exists once the view does, so the
    // base's `enter()` pass ran without it — rebuild it now, through the same
    // path, with `look()` below feeding it.
    this.applyLook();
    // §4.8 / 17-d: `setQuality` emits `renderer:resized` with `force`, so a
    // preset change from the pause menu reaches the shadow map and the
    // environment while the player is standing on the planet.
    this.disposer.add(
      services.events.on('renderer:resized', () => view.applyQuality(services.renderer.quality), this),
    );
    this.props = this.scene.children.length;

    // §4.3: the fixed perspective camera.
    this.camera.fov = CAMERA_FOV;
    this.camera.near = 1;
    this.camera.far = services.renderer.quality.drawDistance + 40;
    this.camera.updateProjectionMatrix();
    this.#camTarget.x = world.player.x;
    this.#camTarget.z = world.player.z;
    this.#placeCamera(0, 0);

    // The SPEC-014 UI layer (§4.12): shared HUD, overlays, touch, pause.
    const hud = new Hud(this.ui, 'surface');
    this.#hud = hud;
    this.disposer.add(() => hud.dispose());
    if (hud.minimapCanvas !== null) {
      const minimap = new Minimap(hud.minimapCanvas);
      this.#minimap = minimap;
      // E18: a tap on the map cycles the pinned mission, like the map key.
      const cycle = (): void => this.#missions?.cyclePinned();
      minimap.canvas.addEventListener('click', cycle);
      this.disposer.add(() => minimap.canvas.removeEventListener('click', cycle));
    }
    // SPEC-019 §4.6: the floating damage numbers, pooled in the HUD layer.
    const dmgLayer = el('div', 'dmg-layer');
    this.ui.mount(dmgLayer, 'hud');
    const numbers = new DamageNumbers(dmgLayer, services.settings.get().reduceMotion);
    this.#numbers = numbers;
    this.disposer.add(() => {
      numbers.dispose();
      this.ui.unmount(dmgLayer);
      this.#numbers = null;
    });
    this.#enemyHpId.fill(-1);

    const death = new DeathOverlay(services.uiRoot);
    this.#death = death;
    this.disposer.add(() => death.dispose());
    const touch = new TouchControls(services.uiRoot, services.input, services.settings);
    touch.show('surface');
    this.#touch = touch;
    this.disposer.add(() => touch.dispose());
    const pauseMenu = new PauseMenu(services, () => services.requestResume());
    this.#pauseMenu = pauseMenu;
    this.disposer.add(() => pauseMenu.dispose());
    // Quitting out of an open pause menu never calls resume(); the disposer is
    // what releases the duck (SPEC-006 AC-54).
    this.disposer.add(() => services.audio.duck(false));
    const rotate = new RotateOverlay(services.uiRoot, services.events);
    this.disposer.add(() => rotate.dispose());
    // SPEC-023 §4.4: the reveal's letterbox and words. Built with the scene so
    // a beat interrupted by a quit takes its key capture down with it.
    const reveal = new RevealOverlay(services.uiRoot);
    this.#revealOverlay = reveal;
    this.disposer.add(() => {
      // A beat still running when the scene goes ends the way a skip does, so
      // the input it took never leaves with it.
      this.#endReveal();
      reveal.dispose();
      this.#revealOverlay = null;
      this.#revealPending = null;
      this.#holds = 0;
    });
    this.#dialogue = dialogueLayer(services.uiRoot, services.events, {
      input: services.input,
      saveKey: () => this.services.save.current,
    });

    const overlay = el('div', 'hud-storm');
    services.uiRoot.append(overlay);
    this.#stormOverlay = overlay;
    this.disposer.add(() => overlay.remove());

    this.#buildTerminal();
    this.#subscribe(bus);
    this.#syncMissionStages();
    if (new URLSearchParams(globalThis.location.search).has('debug')) this.#buildDebugStrip();

    // §4.1 step 5: the landing save, and held-back accept dialogue.
    services.save.request('landing');
    const shown = acceptShown(save);
    for (const state of missions.active) {
      if (shown.has(state.id)) continue;
      shown.add(state.id);
      const id = MISSION_TABLE[state.id].dialogue.onAccept;
      if (id !== undefined) this.#playDialogue(id);
    }
  }

  override exit(): void {
    const world = this.#world;
    const save = this.#save;
    if (world !== null && save !== null && this.services.save.current === save) {
      save.player.hp = Math.max(1, Math.round(world.player.hp));
      this.services.save.flush();
    }
    this.#touch?.hide();
  }

  pause(): void {
    this.#pauseMenu?.show();
    this.services.audio.duck(true);
  }

  resume(): void {
    this.#pauseMenu?.hide();
    this.services.audio.duck(false);
  }

  protected override onUpdate(dt: number): void {
    const world = this.#world;
    const combat = this.#combat;
    const missions = this.#missions;
    const weather = this.#weather;
    const spawn = this.#spawn;
    const pickups = this.#pickups;
    if (world === null || combat === null || missions === null || weather === null || spawn === null || pickups === null) return;

    const input = this.services.input.state;
    this.#edges.beginStep(input.buttons, this.services.loop.stats.frame);
    this.services.save.addPlaytime(dt);

    // SPEC-023 §4.4: a held beat advances its own clock and returns before any
    // system update — no combat, projectiles, missions, arena, choice, spawn,
    // pickups, nodes or weather. The edges were sampled above and are dropped
    // unread, so a press made during the beat never fires after it. Playtime
    // still accrues; no `checkpoint` save is requested.
    if (this.#holds > 0) {
      this.#updateReveal(dt);
      return;
    }

    // The touch pause button; Escape/P live in main.ts (SPEC-014 AC-82).
    if (input.scheme === 'touch' && this.#edges.pressed('pause')) {
      void this.services.scenes.pause();
      return;
    }

    const modal = this.#modalOpen > 0;

    this.#deathTick(world, dt);
    if (!modal) {
      this.#movePlayer(world, dt);
      this.#updateConsumable();
      if (this.#edges.pressed('map')) missions.cyclePinned();
    } else {
      world.player.vx = 0;
      world.player.vz = 0;
    }
    combat.update(dt, input, modal ? null : this.#aimWorld(world));

    this.#updateWeather(world, dt);
    missions.update(dt, this.#missionContext(world));
    this.#updatePois(world, dt);
    this.#updateBossArena(world);
    this.#updateDefend(world, dt);
    this.#updateEscort(dt);
    this.#updateChoice(missions);

    // §4.5: spawning pauses for modal dialogue and the ending choice.
    spawn.update(dt, world.player, this.#frustumXZ, !modal);

    for (const drop of combat.drops) pickups.spawn(drop);
    combat.drops.length = 0;
    pickups.update(dt, world.player, world.stats.pickupRadius);
    this.#nodes?.update(dt, world.player);

    this.#followCamera(world, dt);
    this.#updateMusic(dt, world);
    this.#feedHud(world, dt);
    this.#minimapIn -= dt;

    // SPEC-019 §4.6: age the damage numbers, and flush the weather
    // accumulator into one red number per second (19-m).
    this.#numbers?.update(dt);
    this.#weatherNumberIn -= dt;
    if (this.#weatherNumberIn <= 0) {
      this.#weatherNumberIn = WEATHER_NUMBER_SECONDS;
      const amount = Math.round(this.#weatherDamage);
      this.#weatherDamage = 0;
      if (amount > 0 && world.player.alive && this.#numbers !== null) {
        this.#project(world.player.x, world.player.z, 1.6);
        this.#numbers.show(this.#screenPoint.x, this.#screenPoint.y, amount, 'player');
      }
    }
  }

  override render(renderer: Renderer): void {
    const world = this.#world;
    const view = this.#view;
    // SPEC-023 §4.4: a held beat freezes `world.time`, so the view clock runs
    // on this frame delta instead — the boss keeps breathing while nothing in
    // the simulation moves. Capped like the loop's own frame delta, so a
    // hitch or a hidden tab cannot jump the animation.
    const wall = performance.now() / 1000;
    const frameDelta = this.#lastRenderWall < 0 ? 0 : Math.min(HELD_FRAME_CAP, Math.max(0, wall - this.#lastRenderWall));
    this.#lastRenderWall = wall;
    if (this.#holds > 0) this.#heldViewTime += frameDelta;
    if (world !== null && view !== null) {
      // SPEC-019 §4.7: hit-stop freezes the view clock for ≤ 2 rendered
      // frames; the fixed-step simulation above never sees it (SPEC-002).
      const time = advanceViewTime(this.#hitStop, world.time) + this.#heldViewTime;
      this.#viewTime = time;
      const dt = Math.max(0, time - this.#lastViewTime);
      this.#lastViewTime = time;
      this.#renderFeedback(world, view);
      view.sync({
        player: world.player,
        follower: world.follower,
        enemies: world.enemies,
        projectiles: world.projectiles,
        pickups: (this.#pickups as Pickups).pool,
        nodes: (this.#nodes as Nodes).states,
        telegraph: this.#bossTelegraph(world),
        time,
        dt,
      });
      view.setArena(world.arena);
      this.#forwardGrade();
      if (this.#minimapIn <= 0) {
        this.#minimapIn = MINIMAP_INTERVAL;
        this.#drawMinimap(world);
      }
    }
    super.render(renderer);
  }

  // ------------------------------------------------- SPEC-019 hit feedback

  /**
   * §4.6 — the per-rendered-frame edges: the muzzle flash on the fire edge,
   * the wurm telegraph's start/resurface rings, the coalesced pickup sparkle,
   * and the enemy damage numbers off per-slot HP deltas. Runs before `sync`,
   * allocates nothing, and never touches the simulation.
   */
  #renderFeedback(world: CombatWorld, view: SurfaceView): void {
    const p = world.player;

    // The fire edge: `fireCooldown` rose since the last rendered frame.
    if (p.fireCooldown > this.#lastFireCooldown) {
      view.fx.burst(
        'muzzle',
        p.x + Math.cos(p.facing) * MUZZLE_OFFSET,
        p.z + Math.sin(p.facing) * MUZZLE_OFFSET,
        MUZZLE_COLOR,
      );
    }
    this.#lastFireCooldown = p.fireCooldown;

    // The wurm telegraph: one ring when it opens, one plus the heavy shake on
    // the resurface (§4.6). Positions are copied — `#bossTelegraph` returns a
    // reused scratch.
    const telegraph = this.#bossTelegraph(world);
    if (telegraph !== null && !this.#telegraphWas) {
      this.#telegraphWas = true;
      this.#telegraphX = telegraph.x;
      this.#telegraphZ = telegraph.z;
      view.fx.burst('dust_ring', telegraph.x, telegraph.z, this.#groundColor);
    } else if (telegraph !== null) {
      this.#telegraphX = telegraph.x;
      this.#telegraphZ = telegraph.z;
    } else if (this.#telegraphWas) {
      this.#telegraphWas = false;
      view.fx.burst('dust_ring', this.#telegraphX, this.#telegraphZ, this.#groundColor);
      this.#triggerShake(HEAVY_SHAKE_AMPLITUDE, HEAVY_SHAKE_SECONDS);
    }

    // At most one pickup sparkle per rendered frame (§4.6, Decisions #7).
    if (this.#pickupColor >= 0) {
      view.fx.burst('pickup', p.x, p.z, this.#pickupColor);
      this.#pickupColor = -1;
    }

    this.#enemyDamageNumbers(world);
  }

  /**
   * §4.6: enemy hit amounts from per-slot HP deltas — one walk over the pool,
   * typed arrays only. An id mismatch (swap-remove reused the slot) resets
   * silently (19-f); an index past the arrays is skipped, never a crash.
   */
  #enemyDamageNumbers(world: CombatWorld): void {
    const numbers = this.#numbers;
    if (numbers === null) return;
    const hp = this.#enemyHp;
    const ids = this.#enemyHpId;
    const cap = hp.length;
    const size = Math.min(world.enemies.size, cap);
    for (let i = 0; i < size; i++) {
      const e = world.enemies.at(i);
      if (ids[i] === e.id && (hp[i] as number) > e.hp) {
        const amount = Math.round((hp[i] as number) - e.hp);
        if (amount > 0) {
          this.#project(e.x, e.z, 1.2);
          numbers.show(
            this.#screenPoint.x,
            this.#screenPoint.y,
            amount,
            e.elite || e.def.archetype === 'boss' ? 'elite' : 'enemy',
          );
        }
      }
      hp[i] = e.hp;
      ids[i] = e.id;
    }
  }

  /** World XZ (+ a lift in metres) → screen pixels, through the camera. */
  #project(x: number, z: number, lift: number): void {
    const v = this.#projectScratch.set(x, lift + (this.#view?.field.heightAt(x, z) ?? 0), z);
    v.project(this.camera);
    this.#screenPoint.x = (v.x * 0.5 + 0.5) * this.services.renderer.width;
    this.#screenPoint.y = (-v.y * 0.5 + 0.5) * this.services.renderer.height;
  }

  /** §4.7: a new shake wins only if it is at least the amplitude still left. */
  #triggerShake(amplitude: number, duration: number): void {
    const time = this.#viewTimeNow();
    const shake = this.#shake;
    const remaining =
      time < shake.until && shake.duration > 0
        ? shake.amplitude * Math.min(1, Math.max(0, (shake.until - time) / shake.duration))
        : 0;
    if (amplitude < remaining) return;
    shake.amplitude = amplitude;
    shake.duration = duration;
    shake.until = time + duration;
  }

  /**
   * The view clock the shake and hit-stop share (§4.7) — the same one
   * `render()` hands the view, including the seconds a held beat added, so a
   * shake that outlives a beat decays on the clock it was started on.
   */
  #viewTimeNow(): number {
    if (this.#hitStop.frames > 0) return this.#hitStop.time + this.#heldViewTime;
    return (this.#world?.time ?? 0) + this.#heldViewTime;
  }

  override debugInfo(): Record<string, number | string> {
    const info = super.debugInfo();
    info['drawCalls'] = this.services.renderer.gl.info.render.calls;
    info['spawned'] = this.#spawned;
    info['elites'] = this.#elites;
    info['kills'] = this.#kills;
    // SPEC-023 §4.4: the beat-hold counter and the view clock it keeps running
    // while `world.time` stands still.
    info['held'] = this.#holds;
    info['viewTime'] = Math.round(this.#viewTime * 100) / 100;
    if (this.#world !== null) {
      const world = this.#world;
      info['enemies'] = world.enemies.size;
      info['px'] = Math.round(world.player.x * 10) / 10;
      info['pz'] = Math.round(world.player.z * 10) / 10;
      // The nearest live enemy's offset — the e2e patrol steers by it.
      let nearD = Infinity;
      for (let i = 0; i < world.enemies.size; i++) {
        const e = world.enemies.at(i);
        if (e.state === 'dead') continue;
        const d = Math.hypot(e.x - world.player.x, e.z - world.player.z);
        if (d < nearD) {
          nearD = d;
          info['nearDx'] = Math.round((e.x - world.player.x) * 10) / 10;
          info['nearDz'] = Math.round((e.z - world.player.z) * 10) / 10;
        }
      }
      const boss = this.#findBoss(world);
      info['boss'] = boss === null ? '-' : `p${boss.phase} ${boss.hp}/${boss.maxHp}`;
      // AC-48: how many the pad sweep can reach right now, and what the last
      // death sweep actually removed.
      const pad = this.#pad;
      if (pad !== null) {
        let near = 0;
        for (let i = 0; i < world.enemies.size; i++) {
          const e = world.enemies.at(i);
          if (e.state === 'dead' || e.def.archetype === 'boss') continue;
          if (Math.hypot(e.x - pad.x, e.z - pad.z) <= DEATH_DESPAWN_RADIUS) near++;
        }
        info['enemiesNearPad'] = near;
      }
      info['despawnedAtDeath'] = this.#despawnedAtDeath;
      // AC-10/11: the last aim ground projection.
      if (this.#aimDebug.has) {
        info['aimX'] = Math.round(this.#aimDebug.x * 10) / 10;
        info['aimZ'] = Math.round(this.#aimDebug.z * 10) / 10;
      }
      // AC-24: the nearest node's resource and fill fraction.
      const nodes = this.#nodes;
      if (nodes !== null) {
        let best: number | null = null;
        let bestD = Infinity;
        for (let i = 0; i < nodes.states.length; i++) {
          const node = nodes.states[i] as (typeof nodes.states)[number];
          const d = Math.hypot(node.x - world.player.x, node.z - world.player.z);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        if (best !== null) {
          const node = nodes.states[best] as (typeof nodes.states)[number];
          info['nodeRes'] = node.resource;
          info['nodeFill'] = Math.round(nodes.fill(node) * 1000) / 1000;
          info['nodeDist'] = Math.round(bestD * 10) / 10;
        }
      }
    }
    // AC-55..AC-59: what the minimap painter drew on its last repaint.
    const drawn = this.#minimap?.lastDrawn;
    if (drawn !== undefined) {
      info['mmPois'] = drawn.pois;
      info['mmObjectives'] = drawn.objectives;
      info['mmArrows'] = drawn.arrows;
      info['mmNodes'] = drawn.nodes;
      info['mmEnemies'] = drawn.enemies;
    }
    if (this.#layout !== null) info['layoutHash'] = this.#layout.hash;
    return info;
  }

  // ----------------------------------------------------------------- grade

  // SPEC-018 §4.9: the last forwarded grade and one reused partial — the
  // comparison and the call allocate nothing per frame (SPEC-001 §7).
  readonly #lastGrade = { vignette: -1, desaturate: -1, tint: [-1, -1, -1] as [number, number, number] };
  readonly #gradeLook: Partial<Look> = { vignette: 0, saturation: 1, tint: [1, 1, 1] };

  /** Forward the storm grade through `renderer.setLook` when it changed. */
  #forwardGrade(): void {
    const view = this.#view;
    if (view === null) return;
    const grade = view.grade;
    const last = this.#lastGrade;
    if (
      grade.vignette === last.vignette &&
      grade.desaturate === last.desaturate &&
      grade.tint[0] === last.tint[0] &&
      grade.tint[1] === last.tint[1] &&
      grade.tint[2] === last.tint[2]
    ) {
      return;
    }
    last.vignette = grade.vignette;
    last.desaturate = grade.desaturate;
    last.tint[0] = grade.tint[0];
    last.tint[1] = grade.tint[1];
    last.tint[2] = grade.tint[2];

    // On top of the planet's own grade: the base vignette widens, saturation
    // drains, and the storm tint multiplies the planet tint.
    const base = view.look;
    const look = this.#gradeLook;
    look.vignette = DEFAULT_LOOK.vignette + grade.vignette;
    look.saturation = (base.saturation ?? DEFAULT_LOOK.saturation) * (1 - grade.desaturate);
    const baseTint = base.tint ?? DEFAULT_LOOK.tint;
    const tint = look.tint as [number, number, number];
    tint[0] = baseTint[0] * grade.tint[0];
    tint[1] = baseTint[1] * grade.tint[1];
    tint[2] = baseTint[2] * grade.tint[2];
    this.services.renderer.setLook(look);
  }

  // ------------------------------------------------------- player & camera

  /** §4.3: movement is camera-relative — screen-up is world (−1,−1)/√2. */
  #movePlayer(world: CombatWorld, dt: number): void {
    const p = world.player;
    if (!p.alive) {
      p.vx = 0;
      p.vz = 0;
      return;
    }
    const move = this.services.input.state.move;
    const inv = Math.SQRT1_2;
    p.vx = (move.x - move.y) * inv * world.stats.moveSpeed;
    p.vz = (-move.x - move.y) * inv * world.stats.moveSpeed;
    const nx = p.x + p.vx * dt;
    const nz = p.z + p.vz * dt;
    if (!world.obstacles.hitsCircle(nx, p.z, p.radius)) p.x = nx;
    if (!world.obstacles.hitsCircle(p.x, nz, p.radius)) p.z = nz;
    const edge = this.#planet.surface.halfSize - 2;
    p.x = Math.max(-edge, Math.min(edge, p.x));
    p.z = Math.max(-edge, Math.min(edge, p.z));
  }

  /** §4.3: mouse unprojects onto y = 0; a touch drag rotates by the camera yaw. */
  #aimWorld(world: CombatWorld): { x: number; z: number } | null {
    const aim = this.services.input.state.aim;
    const p = world.player;
    if (aim.dragging) {
      // `aim.dir` is y-up; the same (−45°) rotation movement uses.
      const inv = Math.SQRT1_2;
      const wx = (aim.dirX - aim.dirY) * inv;
      const wz = (-aim.dirX - aim.dirY) * inv;
      this.#aimPoint.x = p.x + wx * AIM_DRAG_DISTANCE;
      this.#aimPoint.z = p.z + wz * AIM_DRAG_DISTANCE;
      return this.#noteAim(this.#aimPoint);
    }
    if (!aim.hasPointer) return null;
    const v = this.#aimScratch.set(aim.ndcX, aim.ndcY, 0.5).unproject(this.camera);
    v.sub(this.camera.position);
    if (v.y >= -1e-6) return null; // the ray misses the ground
    const t = -this.camera.position.y / v.y;
    this.#aimPoint.x = this.camera.position.x + v.x * t;
    this.#aimPoint.z = this.camera.position.z + v.z * t;
    return this.#noteAim(this.#aimPoint);
  }

  /** Mirrors the projection into a debug slot `#bossTelegraph` can't clobber. */
  #noteAim(point: { x: number; z: number }): { x: number; z: number } {
    this.#aimDebug.x = point.x;
    this.#aimDebug.z = point.z;
    this.#aimDebug.has = true;
    return point;
  }

  /** §4.3: smoothed follow at 1 − e^(−8·dt), fixed yaw/pitch offset. */
  #followCamera(world: CombatWorld, dt: number): void {
    const p = world.player;
    const k = 1 - Math.exp(-8 * dt);
    this.#camTarget.x += (p.x - this.#camTarget.x) * k;
    this.#camTarget.z += (p.z - this.#camTarget.z) * k;
    const speed = Math.hypot(p.vx, p.vz);
    const bx = speed > 0.01 ? (p.vx / speed) * LOOK_AHEAD : 0;
    const bz = speed > 0.01 ? (p.vz / speed) * LOOK_AHEAD : 0;
    this.#placeCamera(bx, bz);
  }

  #placeCamera(biasX: number, biasZ: number): void {
    const d = CAMERA_DISTANCE;
    const x = this.#camTarget.x + d * Math.cos(CAMERA_PITCH) * Math.sin(CAMERA_YAW);
    const y = d * Math.sin(CAMERA_PITCH);
    const z = this.#camTarget.z + d * Math.cos(CAMERA_PITCH) * Math.cos(CAMERA_YAW);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.#camTarget.x + biasX, 0, this.#camTarget.z + biasZ);
    this.camera.updateMatrixWorld();
    this.#frustumMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.#frustum.setFromProjectionMatrix(this.#frustumMatrix);
    // SPEC-019 §4.7: the shake lands after the frustum capture, so spawn
    // culling is bit-identical to an unshaken frame (AC-92). Camera and
    // look-at target move by the same vector, so only the position changes —
    // the orientation, and with it the aim ray, is untouched.
    shakeOffset(this.#shake, this.#viewTimeNow(), this.services.settings.get().reduceMotion, this.#shakeScratch);
    if (this.#shakeScratch.lengthSq() > 0) {
      this.camera.position.add(this.#shakeScratch);
      this.camera.updateMatrixWorld();
    }
  }

  // --------------------------------------------------------------- weather

  #updateWeather(world: CombatWorld, dt: number): void {
    const weather = this.#weather as Weather;
    const missions = this.#missions as Missions;

    // AC-26 / 12-i: an active survive stage forces its storm, after the grace.
    const required = missions.requiredWeather();
    if (
      required !== null &&
      this.elapsed >= FORCED_WEATHER_GRACE &&
      weather.current !== required.weather &&
      missions.bossStage() === null &&
      this.#bossId === null
    ) {
      weather.force(required.weather, required.seconds);
    }

    weather.update(dt);

    const dps = weather.dps;
    if (dps > 0 && world.player.alive && weather.current !== null) {
      // Combat applies hazardResist and the hazard-immunity window (§4.6).
      this.#combat?.damagePlayer(dps * dt, { kind: 'weather', weather: weather.current }, true);
    }

    // Lerp the visual/aggro response toward the current phase over 3 s.
    const step = dt / WEATHER_LERP_SECONDS;
    if (this.#stormIntensity < this.#stormTarget) this.#stormIntensity = Math.min(this.#stormTarget, this.#stormIntensity + step);
    else if (this.#stormIntensity > this.#stormTarget) this.#stormIntensity = Math.max(this.#stormTarget, this.#stormIntensity - step);
    this.#view?.setWeather(this.#stormEffects, this.#stormIntensity);
    if (this.#stormOverlay !== null) {
      const opacity = (1 - this.#stormEffects.visibility) * this.#stormIntensity;
      this.#stormOverlay.style.opacity = opacity < 0.02 ? '0' : String(Math.min(0.85, opacity));
    }
    // §4.6: visibility narrows enemy aggro.
    world.aggroMult = 1 - (1 - this.#stormEffects.visibility) * this.#stormIntensity;
  }

  // ------------------------------------------------------------------ POIs

  #missionContext(world: CombatWorld): MissionContext {
    const ctx = this.#ctx as MissionContext;
    this.#ctxPlayer.x = world.player.x;
    this.#ctxPlayer.z = world.player.z;
    this.#ctxPlayer.alive = world.player.alive;
    if (world.follower === null) {
      ctx.follower = null;
    } else {
      this.#ctxFollower.x = world.follower.x;
      this.#ctxFollower.z = world.follower.z;
      this.#ctxFollower.alive = world.follower.alive;
      ctx.follower = this.#ctxFollower;
    }
    return ctx;
  }

  #updatePois(world: CombatWorld, dt: number): void {
    const events = this.services.events;
    const save = this.#save as SaveV1;
    const player = world.player;
    const atPad = this.#atPad(world);

    for (const state of this.#pois) {
      const poi = state.poi;
      const d = Math.hypot(player.x - poi.x, player.z - poi.z);

      // §4.12: discovery within 40 m, once, persisted.
      if (!state.discovered && d <= DISCOVER_RANGE) {
        state.discovered = true;
        const key = `${this.#planet.id}:${poi.poi}:${poi.instance}`;
        if (!save.progress.poisDiscovered.includes(key)) save.progress.poisDiscovered.push(key);
        events.emit('poi:discovered', { poi: poi.poi, instance: poi.instance });
      }

      const inside = player.alive && d <= poi.radius;
      if (inside && !state.inside) events.emit('poi:reached', { poi: poi.poi, instance: poi.instance });
      state.inside = inside;

      // §4.7 scan: hands-free, 3 s inside the radius, distinct instances.
      if (poi.kind === 'scan') {
        if (inside) {
          if (!state.scanned) {
            state.scanFor += dt;
            if (state.scanFor >= SCAN_SECONDS) {
              state.scanned = true;
              events.emit('poi:scanned', { poi: poi.poi, instance: poi.instance });
            }
          }
        } else {
          state.scanFor = 0;
          state.scanned = false;
        }
      }
    }

    // The pad terminal (§4.1 step 5, §4.11): one toggle, one call site, and
    // the press comes through the sampler — one fire per press, any step count.
    if (this.#edges.pressed('interact') && this.#modalOpen === 0) {
      if (this.#terminalOpen) this.#closeTerminal();
      else if (atPad && player.alive) this.#openTerminal();
    }
    if (this.#terminalOpen && (!atPad || !player.alive)) this.#closeTerminal();
  }

  #atPad(world: CombatWorld): boolean {
    const pad = this.#pad;
    if (pad === null) return false;
    return Math.hypot(world.player.x - pad.x, world.player.z - pad.z) <= pad.radius;
  }

  // ------------------------------------------------------------ boss arena

  #updateBossArena(world: CombatWorld): void {
    const missions = this.#missions as Missions;
    const nest = this.#arenaPoi;
    const wanted = missions.bossStage();

    if (nest === null || wanted === null) {
      // Stage done or none: a live boss stays (its defeat handler cleans up),
      // but nothing arms the arena for a stage that no longer wants it.
      if (this.#bossId === null) {
        world.arena = null;
        this.#arena = null;
      }
      return;
    }

    const p = world.player;
    const d = Math.hypot(p.x - nest.x, p.z - nest.z);

    // §4.7: the arena spawns the boss on entry.
    if (this.#bossId === null && d <= nest.radius && p.alive) {
      const boss = this.#combat?.spawnEnemy(wanted, nest.x, nest.z, false);
      if (boss !== undefined) {
        this.#bossId = boss.id;
        this.#arena = { x: nest.x, z: nest.z, radius: nest.radius, locked: true };
        this.#weather?.suppress(true); // E15
        // SPEC-023 §4.4: the reveal rides the arena's own spawn, so it happens
        // exactly where the fight starts and never on the debug shortcut.
        this.#armReveal(wanted, boss);
      }
    }

    // 23-b: a reveal that waited for a modal dialogue starts on the first step
    // with none open — the boss spawned as usual and simply stood there. The
    // live boss is looked up again, because the wait may have outlived it.
    const pending = this.#revealPending;
    if (pending !== null && this.#modalOpen === 0) {
      this.#revealPending = null;
      const live = this.#findBoss(world);
      if (live !== null) this.#startReveal(pending, live);
    }

    const boss = this.#findBoss(world);
    if (this.#bossId !== null && boss === null) {
      // Swept without a defeat event (a silent despawn): disarm quietly.
      this.#bossId = null;
      world.arena = null;
      this.#arena = null;
      this.#weather?.suppress(false);
      return;
    }

    // The soft boundary drags every enemy toward an armed arena, so it arms
    // only while the fight is on (SPEC-011 11-e).
    if (this.#arena !== null && boss !== null) {
      if (world.arena === null) {
        if (d <= this.#arena.radius) world.arena = this.#arena;
      } else if (d > ARENA_DISENGAGE_DISTANCE && !boss.aggro) {
        world.arena = null;
      }
    }
  }

  // ----------------------------------------------------------- boss reveal

  /**
   * SPEC-023 §4.4: claim the beat, or park it behind an open dialogue (23-b).
   * The session key is taken here rather than at the start, so a reveal that
   * waits for a dialogue cannot be claimed twice by the steps in between.
   */
  #armReveal(boss: EnemyId, entity: EnemyEntity): void {
    const beats = director(this.services);
    if (!beats.enabled || !revealDue(boss, beats.session)) return;
    beats.session.add(revealKey(boss));
    if (this.#modalOpen > 0) {
      this.#revealPending = boss;
      return;
    }
    this.#startReveal(boss, entity);
  }

  /**
   * §4.4: hold the simulation, take the input, swing the camera onto the boss
   * and put the letterbox up. `music('boss')` lands here, at the start; the
   * roar and the words wait for the hold phase.
   */
  #startReveal(boss: EnemyId, entity: EnemyEntity): void {
    const world = this.#world;
    const overlay = this.#revealOverlay;
    const def = BOSS_REVEAL_TABLE[boss];
    if (world === null || overlay === null || def === undefined) return;
    this.#reveal = {
      t: 0,
      fromX: world.player.x,
      fromZ: world.player.z,
      toX: entity.x,
      toZ: entity.z,
      held: false,
      inputWas: this.services.input.enabled,
    };
    this.#holds++;
    this.services.input.setEnabled(false);
    // §4.4, Camera: no shake during a reveal — whatever was still decaying
    // ends here rather than jittering the pan.
    this.#shake.amplitude = 0;
    this.#shake.until = 0;
    // The bed the fight runs on, from the first frame of the beat. `#music`
    // and its hold move with it, so `#updateMusic` does not undo it after.
    this.#music = 'boss';
    this.#musicHold = MUSIC_HOLD_SECONDS;
    this.services.audio.music('boss');
    overlay.show(
      {
        name: ENEMIES[boss].name.toUpperCase(),
        epithet: def.epithet,
        speaker: def.speaker,
        line: def.line,
        glitch: def.glitch === true,
      },
      () => this.#endReveal(),
    );
  }

  /**
   * §4.4: one fixed step of a held beat. The camera rides `revealCamera`'s `k`
   * from the player to the boss and back; under reduce motion those are cuts.
   */
  #updateReveal(dt: number): void {
    const reveal = this.#reveal;
    if (reveal === null) {
      // A hold with nothing to run (a disposed overlay, say) must not wedge
      // the scene: release it rather than freezing the planet.
      //
      // SPEC-024 §4.7 holds the same counter for the ending sequence, which
      // has no per-step beat behind it at all — it is a chain of awaits on a
      // dialogue, a film and an overlay, and it releases its own hold at the
      // Continue. Releasing it here would hand Eden's last wave the ending.
      if (this.#ending === null) this.#holds = Math.max(0, this.#holds - 1);
      return;
    }
    reveal.t += dt;
    const pose = revealCamera(reveal.t, this.services.settings.get().reduceMotion);
    if (pose.phase === 'hold' && !reveal.held) {
      reveal.held = true;
      this.#revealOverlay?.hold();
      this.services.audio.play('boss_roar', { priority: 2 });
    }
    this.#camTarget.x = reveal.fromX + (reveal.toX - reveal.fromX) * pose.k;
    this.#camTarget.z = reveal.fromZ + (reveal.toZ - reveal.fromZ) * pose.k;
    this.#placeCamera(0, 0);
    if (pose.phase === 'done') this.#endReveal();
  }

  /**
   * §4.4, End — on the last phase or on Skip: the overlay goes, the hold is
   * released, input comes back, and the camera follows the player again from
   * the next frame (`#followCamera` eases `#camTarget` home).
   */
  #endReveal(): void {
    const reveal = this.#reveal;
    if (reveal === null) return;
    this.#reveal = null;
    this.#revealOverlay?.hide();
    this.#holds = Math.max(0, this.#holds - 1);
    this.services.input.setEnabled(reveal.inputWas);
  }

  #findBoss(world: CombatWorld): EnemyEntity | null {
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.def.archetype === 'boss' && e.state !== 'dead') return e;
    }
    return null;
  }

  /** The wurm's resurface ring while it digs (SPEC-011 §4.6). */
  #bossTelegraph(world: CombatWorld): { x: number; z: number } | null {
    const boss = this.#findBoss(world);
    if (boss === null || boss.specialKind !== 'burrow_telegraph') return null;
    this.#aimPoint.x = boss.x;
    this.#aimPoint.z = boss.z;
    return this.#aimPoint;
  }

  // ---------------------------------------------------------------- defend

  /** Wave + POI HP for an active defend stage (§4.7; none on Cinder-4). */
  #syncDefend(): void {
    const missions = this.#missions as Missions;
    const stage = missions.defendStage();
    const spawn = this.#spawn as SpawnDirector;
    if (stage === null) {
      if (this.#defendWave !== null) spawn.stopWave(this.#defendWave);
      this.#defendWave = null;
      this.#defendPoi = null;
      return;
    }
    const poi = (this.#layout as Layout).pois.find((p) => p.poi === stage.poi) ?? null;
    this.#defendPoi = poi;
    this.#defendMax = this.#planet.surface.pois.find((p) => p.id === stage.poi)?.hp ?? 100;
    this.#defendHp = this.#defendMax;
    if (this.#defendWave !== null) spawn.stopWave(this.#defendWave);
    this.#defendWave = spawn.startWave(stage.wave, poi === null ? 'player' : { x: poi.x, z: poi.z });
  }

  #updateDefend(world: CombatWorld, dt: number): void {
    const poi = this.#defendPoi;
    if (poi === null || this.#defendHp <= 0) return;
    let pressure = 0;
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.state === 'dead') continue;
      if (Math.hypot(e.x - poi.x, e.z - poi.z) <= poi.radius + DEFEND_CONTACT_MARGIN) pressure += e.damage;
    }
    if (pressure <= 0) return;
    this.#defendDamageAccum += pressure * 0.2 * dt;
    const whole = Math.floor(this.#defendDamageAccum);
    if (whole <= 0) return;
    this.#defendDamageAccum -= whole;
    this.#defendHp = Math.max(0, this.#defendHp - whole);
    this.services.events.emit('poi:damaged', { poi: poi.poi, hp: this.#defendHp, max: this.#defendMax });
  }

  // ---------------------------------------------------------------- escort

  /** E13: the follower spawns at `from` on stage start (none on Cinder-4). */
  #syncEscort(): void {
    const world = this.#world as CombatWorld;
    const stage = (this.#missions as Missions).escortStage();
    if (stage === null) {
      world.follower = null;
      this.#followerRespawnIn = 0;
      return;
    }
    const from = (this.#layout as Layout).pois.find((p) => p.poi === stage.from);
    const def = FOLLOWERS[stage.follower];
    world.follower = makeFollower(def, from?.x ?? 0, from?.z ?? 0);
  }

  #updateEscort(dt: number): void {
    if (this.#followerRespawnIn <= 0) return;
    this.#followerRespawnIn -= dt;
    if (this.#followerRespawnIn <= 0 && (this.#missions as Missions).escortStage() !== null) this.#syncEscort();
  }

  // ---------------------------------------------------------------- choice

  /** §4.7: a choice objective opens the modal prompt, once. */
  #updateChoice(missions: Missions): void {
    if (this.#choiceFor !== null) return;
    const dialogue = this.#dialogue;
    if (dialogue === null) return;
    for (const state of missions.active) {
      const choice = missions.choiceStage(state.id);
      if (choice === null) continue;
      // SPEC-024 §4.2: `playChoice` clears the queue, and the stage's own
      // intro (`c6_choice_intro`) was queued by the `mission:stageStarted` that
      // opened this stage — one step earlier, in this very update. Waiting for
      // the layer to go idle is what lets the intro play to its last line.
      if (dialogue.busy) return;
      this.#choiceFor = state.id;
      this.#modalOpen++;
      void dialogue.playChoice(choice.prompt, choice.options.map((o) => o.label)).then((index) => {
        this.#modalOpen = Math.max(0, this.#modalOpen - 1);
        const id = this.#choiceFor;
        this.#choiceFor = null;
        if (id === null) return;
        const flags: readonly string[] = choice.options[index]?.flags ?? [];
        const ending: Ending | null = flags.includes('ending_escape')
          ? 'escape'
          : flags.includes('ending_stay')
            ? 'stay'
            : null;
        if (ending === null) {
          this.#missions?.choose(id, index);
          return;
        }
        // §4.1: the ending is claimed *before* the choice completes the
        // mission, so the `mission:completed` it raises holds `c6_m2_done`
        // back, and the simulation is held for the whole sequence (24-c).
        this.#ending = ending;
        this.#endingFor = id;
        this.#holds++;
        this.#missions?.choose(id, index);
        void this.#runEnding(ending);
      });
      return;
    }
  }

  // ---------------------------------------------------------------- ending

  /**
   * SPEC-024 §4.1: the ending, in order — the dialogue that says the decision,
   * the film that shows what it cost, and the overlay that has the last word.
   * The simulation is held throughout, so Eden's last wave cannot interrupt it.
   *
   * Stay hands the planet back: `endingSeen` is written, the save is asked for,
   * the hold is released and free roam carries on. Escape ends the session:
   * the veil strips the HUD, the save is written immediately, and the menu
   * transition disposes this scene. Each await comes back to a scene that may
   * have been disposed under it (a quit, a recall), which is what `#alive`
   * answers.
   */
  async #runEnding(ending: Ending): Promise<void> {
    const services = this.services;
    const dialogue = this.#dialogue;
    const save = this.#save;
    if (dialogue === null || save === null) {
      this.#endEnding();
      return;
    }
    await dialogue.play(`ending_${ending}`, { modal: true });
    if (!this.#alive) return;
    // §4.11 of SPEC-022: with films off this resolves at once, so the endings
    // stay testable without the 36 s film (24-b).
    await director(services).playFilm(`ending_${ending}`, { musicAfter: ending === 'stay' ? 'surface_calm' : null });
    if (!this.#alive) return;
    const overlay = new EndingOverlay(services.uiRoot);
    if (ending === 'stay') {
      await overlay.playStay(stayReport(save));
      if (!this.#alive) return;
      save.progress.endingSeen = true;
      services.save.request('mission');
      this.#endEnding();
      return;
    }
    await overlay.playEscape();
    if (!this.#alive) return;
    save.progress.endingSeen = true;
    // The last write of the run, before the scene goes: `manual` skips the
    // autosave debounce, so the slot holds the ending even if the tab dies on
    // the way to the menu.
    services.save.request('manual');
    void services.go('menu', { reason: 'quit' });
  }

  /** Free roam again: the hold goes, and `c6_m2_done` is no longer held back. */
  #endEnding(): void {
    this.#ending = null;
    this.#endingFor = null;
    this.#holds = Math.max(0, this.#holds - 1);
  }

  // ------------------------------------------------------------ consumable

  /** One press, one stimpack — the press comes through the sampler. */
  #updateConsumable(): void {
    if (!this.#edges.pressed('useItem')) return;
    const world = this.#world as CombatWorld;
    if (!world.player.alive) return;
    const slot = this.#consumableSlot();
    if (slot === null) return;
    const result = (this.#economy as Economy).useConsumable(slot.itemId);
    if (result.ok) this.#combat?.applyConsumable(result.effect);
  }

  #consumableSlot(): { itemId: ItemId; qty: number } | null {
    const save = this.#save as SaveV1;
    for (const entry of save.inventory) {
      if (ITEM_TABLE[entry.itemId].kind === 'consumable' && entry.qty > 0) {
        // One lazily created scratch, reused per frame (SPEC-001 §7); the HUD
        // diffs against a clone, so in-place writes still register.
        let slot = this.#consumableScratch;
        if (slot === null) {
          slot = { itemId: entry.itemId, qty: entry.qty };
          this.#consumableScratch = slot;
        } else {
          slot.itemId = entry.itemId;
          slot.qty = entry.qty;
        }
        return slot;
      }
    }
    return null;
  }

  // ----------------------------------------------------------------- death

  /** §4.8 — runs every step, modal or not; the overlay is not a freeze. */
  #deathTick(world: CombatWorld, dt: number): void {
    if (this.#deathAt === null) return;
    this.#deathAt += dt;
    const tapped = this.#edges.pressed('interact') || this.#edges.pressed('fire');
    if (this.#deathAt >= DEATH_OVERLAY_SECONDS || tapped) this.#respawn(world);
  }

  #respawn(world: CombatWorld): void {
    const layout = this.#layout as Layout;
    this.#deathAt = null;
    if (this.#terminalOpen) this.#closeTerminal();

    // §4.8 step 2: the sweep, the boss reset, the timed stages (via the event).
    this.#despawnedAtDeath = this.#spawn?.despawnNear(layout.pad.x, layout.pad.z, DEATH_DESPAWN_RADIUS) ?? 0;
    const boss = this.#findBoss(world);
    if (boss !== null) boss.state = 'dead'; // silent — no loot, no defeat event
    this.#bossId = null;
    // E31: a reveal still waiting on a dialogue dies with the boss. Its session
    // key stays taken, so walking back in spawns the boss and nothing else.
    this.#revealPending = null;
    world.arena = null;
    this.#arena = null;
    this.#weather?.suppress(false);
    if (this.#defendPoi !== null) this.#syncDefend(); // wave restarts, HP refills

    // §4.8 step 3.
    const p = world.player;
    p.x = layout.playerSpawn.x;
    p.z = layout.playerSpawn.z;
    p.vx = 0;
    p.vz = 0;
    p.facing = layout.playerSpawn.facing;
    p.hp = world.stats.maxHp;
    p.alive = true;
    p.invulnUntil = world.time + TUNING.INVULN_AFTER_RESPAWN;
    p.fireCooldown = 0;
    p.healOverTime = null;
    p.boosts.length = 0;
    p.hazardImmuneUntil = 0;
    const save = this.#save as SaveV1;
    save.player.hp = p.hp;
    this.#camTarget.x = p.x;
    this.#camTarget.z = p.z;
    this.#placeCamera(0, 0);
    this.#death?.hide();
    this.services.events.emit('player:respawned');
  }

  // ----------------------------------------------------------- debug strip

  /** `?debug` only: shortcuts so the acceptance run fits a QA session. */
  #buildDebugStrip(): void {
    const strip = el('div', 'hud-debug');
    const button = (id: string, label: string, click: () => void): void => {
      // SPEC-023 §4.4: a held beat freezes the world, and these shortcuts are
      // shortcuts *through* it — a hurt or a smite during a reveal would touch
      // what the hold exists to protect (AC: no damage during a held beat).
      const guarded = (): void => {
        if (this.#holds > 0) return;
        click();
      };
      strip.append(testId(h('button', { class: 'hud-button', type: 'button', click: guarded }, label), id));
    };
    button('surface-hurt', 'Hurt me', () => this.#combat?.damagePlayer(60, { kind: 'fall' }));
    button('surface-goto-pad', 'To pad', () => {
      const world = this.#world;
      const pad = this.#pad;
      if (world === null || pad === null || !world.player.alive) return;
      world.player.x = pad.x;
      world.player.z = pad.z;
    });
    button('surface-spawn-boss', 'Wake boss', () => this.#debugSpawnBoss());
    button('surface-goto-boss', 'To boss', () => {
      const world = this.#world;
      const nest = this.#arenaPoi;
      if (world === null || nest === null || !world.player.alive) return;
      world.player.x = nest.x;
      world.player.z = nest.z + 12;
    });
    button('surface-wound-boss', 'Wound boss', () => {
      const world = this.#world;
      const boss = world === null ? null : this.#findBoss(world);
      // 11-f: a boss mid-special ignores damage, the shortcut included.
      if (boss !== null && !boss.invulnerable) boss.hp = Math.max(1, boss.hp - Math.round(boss.maxHp * 0.25));
    });
    // The acceptance run's time compressors: kills go through the real
    // `killEnemy(e, 'player')` path (loot, XP, mission counters), and travel
    // jumps to the pinned objective — nothing else is short-circuited.
    button('surface-smite', 'Smite', () => this.#debugSmite());
    button('surface-goto-objective', 'To objective', () => this.#debugGotoObjective());
    // SPEC-024 §4.8: stage 0 of `c6_m2` is a 240 s defence, and an acceptance
    // run cannot pay that per attempt. Dev builds only — `import.meta.env.DEV`
    // strips the control (and its handler) out of a production bundle.
    if (import.meta.env.DEV) {
      button('surface-finish-stage', 'Finish stage', () => this.#debugFinishStage());
    }
    this.services.uiRoot.append(strip);
    this.disposer.add(() => strip.remove());
  }

  /** §4.8: complete the pinned mission's current stage through the runtime. */
  #debugFinishStage(): void {
    const missions = this.#missions;
    const pinned = missions?.pinned ?? null;
    if (missions === null || pinned === null) return;
    missions.debugFinishStage(pinned);
  }

  /** Kill the nearest live enemy within 80 m through the real player-kill path. */
  #debugSmite(): void {
    const world = this.#world;
    const combat = this.#combat;
    if (world === null || combat === null || !world.player.alive) return;
    let best: EnemyEntity | null = null;
    let bestD = 80;
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      // 11-f: a boss mid-special ignores damage, the shortcut included.
      if (e.state === 'dead' || e.invulnerable) continue;
      const d = Math.hypot(e.x - world.player.x, e.z - world.player.z);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (best !== null) combat.killEnemy(best, 'player');
  }

  /** Teleport to the pinned mission's first undone objective's target. */
  #debugGotoObjective(): void {
    const world = this.#world;
    const missions = this.#missions;
    const layout = this.#layout;
    if (world === null || missions === null || layout === null || !world.player.alive) return;
    const pinned = missions.pinned;
    if (pinned === null) return;
    const next = missions.currentObjectives(pinned).find((o) => !o.done);
    if (next === undefined) return;
    const objective = next.objective;
    let target: { x: number; z: number } | null = null;
    if (objective.kind === 'collect') {
      // The nearest node that still holds the resource.
      let bestD = Infinity;
      for (const node of (this.#nodes as Nodes).states) {
        if (node.resource !== objective.resource || node.remaining < 1) continue;
        const d = Math.hypot(node.x - world.player.x, node.z - world.player.z);
        if (d < bestD) {
          bestD = d;
          target = node;
        }
      }
    } else if (objective.kind === 'boss') {
      const nest = this.#arenaPoi;
      if (nest !== null) target = { x: nest.x, z: nest.z + 6 };
    } else if (objective.kind === 'scan') {
      // A not-yet-scanned instance, so repeat visits progress the count.
      const state = this.#pois.find((p) => p.poi.poi === objective.poi && !p.scanned);
      if (state !== undefined) target = state.poi;
    } else if ('poi' in objective) {
      target = layout.pois.find((p) => p.poi === objective.poi) ?? null;
    } else if (objective.kind === 'escort') {
      target = layout.pois.find((p) => p.poi === objective.to) ?? null;
    }
    if (target === null) return;
    world.player.x = target.x;
    world.player.z = target.z;
  }

  /** The mission-less half of the SPEC-011 acceptance run: wake the nest boss. */
  #debugSpawnBoss(): void {
    const world = this.#world;
    const nest = this.#arenaPoi;
    if (world === null || nest === null || this.#findBoss(world) !== null) return;
    const def = this.#planet.surface.pois.find((p) => p.kind === 'arena');
    if (def?.boss === undefined) return;
    const boss = this.#combat?.spawnEnemy(def.boss, nest.x, nest.z, false);
    if (boss === undefined) return;
    this.#bossId = boss.id;
    this.#arena = { x: nest.x, z: nest.z, radius: nest.radius, locked: true };
    world.arena = this.#arena;
    this.#weather?.suppress(true);
  }

  // -------------------------------------------------------------- terminal

  #buildTerminal(): void {
    const terminal = testId(el('div', 'panel pad-terminal is-hidden'), 'pad-terminal');
    this.services.uiRoot.append(terminal);
    this.#terminal = terminal;
    this.disposer.add(() => terminal.remove());
  }

  #openTerminal(): void {
    const terminal = this.#terminal;
    if (terminal === null || this.#terminalOpen) return;
    this.#terminalOpen = true;
    this.#renderTerminal();
    terminal.classList.remove('is-hidden');
  }

  #closeTerminal(): void {
    this.#terminalOpen = false;
    this.#terminal?.classList.add('is-hidden');
  }

  #renderTerminal(): void {
    const terminal = this.#terminal;
    const missions = this.#missions;
    if (terminal === null || missions === null) return;
    const rows: HTMLElement[] = [];
    rows.push(el('p', 'terminal-title', 'PAD TERMINAL'));

    for (const def of missions.available()) {
      const replay = missions.isReplay(def.id as MissionId);
      const label = replay ? `${def.title} (replay · 50%)` : def.title;
      rows.push(
        h(
          'div',
          { class: 'terminal-row' },
          el('span', 'terminal-label', label),
          testId(
            h('button', {
              class: 'ui-btn',
              type: 'button',
              click: () => this.#acceptAtTerminal(def.id as MissionId),
            }, 'Accept'),
            `terminal-accept-${def.id}`,
          ),
        ),
      );
    }
    for (const state of missions.active) {
      const def = MISSION_TABLE[state.id];
      const pin = state.id === missions.pinned ? ' ◈' : '';
      rows.push(el('p', 'terminal-active', `${def.title} — stage ${state.stage + 1}/${def.stages.length}${pin}`));
    }

    rows.push(
      h(
        'div',
        { class: 'terminal-row' },
        testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#returnToShip() }, 'Return to ship'), 'terminal-return'),
        testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#closeTerminal() }, 'Close'), 'terminal-close'),
      ),
    );
    terminal.replaceChildren(...rows);
  }

  #acceptAtTerminal(id: MissionId): void {
    const missions = this.#missions;
    const save = this.#save;
    if (missions === null || save === null) return;
    const result = missions.accept(id);
    if (!result.ok) return;
    const shown = acceptShown(save);
    if (!shown.has(id)) {
      shown.add(id);
      const dialogueId = MISSION_TABLE[id].dialogue.onAccept;
      if (dialogueId !== undefined) this.#playDialogue(dialogueId);
    }
    this.#renderTerminal();
  }

  /** §4.11: confirm when a timed stage is running, then save and go. */
  #returnToShip(): void {
    if (this.#leaving) return;
    const missions = this.#missions as Missions;
    let timedRunning = false;
    for (const state of missions.active) {
      for (const { objective, done, value } of missions.currentObjectives(state.id)) {
        if ((objective.kind === 'survive' || objective.kind === 'defend') && !done && value > 0) timedRunning = true;
      }
    }
    const depart = (): void => {
      this.#leaving = true;
      const save = this.#save as SaveV1;
      save.progress.location = 'station';
      save.progress.currentPlanet = null;
      this.#closeTerminal();
      void this.services.go('station', { arrivedFrom: this.#planet.id });
    };
    if (!timedRunning) {
      depart();
      return;
    }
    void confirmSheet(
      this.ui,
      {
        title: 'Return to ship?',
        body: 'A timed objective is in progress; it will restart on your next landing.',
        confirmText: 'Return',
        danger: true,
      },
      () => {
        depart();
        return true;
      },
    );
  }

  // -------------------------------------------------------------- dialogue

  #playDialogue(id: DialogueId): void {
    const dialogue = this.#dialogue;
    if (dialogue === null) return;
    const def = DIALOGUE_TABLE[id];
    const modal = def.modal === true;
    if (modal) this.#modalOpen++;
    void dialogue.play(id).finally(() => {
      if (modal) this.#modalOpen = Math.max(0, this.#modalOpen - 1);
    });
  }

  // ------------------------------------------------------------------- HUD

  #feedHud(world: CombatWorld, _dt: number): void {
    const hud = this.#hud;
    const save = this.#save;
    const missions = this.#missions;
    const weather = this.#weather;
    if (hud === null || save === null || missions === null || weather === null) return;
    const m = hud.model;

    m.hp[0] = Math.max(0, Math.round(world.player.hp));
    m.hp[1] = world.stats.maxHp;
    m.xp[0] = save.player.xp - cumulativeXp(save.player.level);
    m.xp[1] = xpToNext(save.player.level);
    m.level = save.player.level;
    m.tokens = save.player.tokens;
    for (const key of Object.keys(m.resources) as ResourceId[]) m.resources[key] = save.resources[key] ?? 0;
    m.cargoCap = (this.#economy as Economy).cargoCap();

    // E18: the pinned mission's first undone objective, with progress. The
    // model reuses one scratch object — `Hud.flush` diffs against a clone, so
    // in-place writes still register (SPEC-001 §7: no per-frame allocation).
    const pinned = missions.pinned;
    if (pinned === null) {
      m.objective = null;
    } else {
      const def = MISSION_TABLE[pinned];
      const obj = this.#objScratch;
      const next = missions.currentObjectives(pinned).find((o) => !o.done);
      obj.title = def.title;
      if (next === undefined) {
        obj.line = 'Stage complete';
        obj.value = 1;
        obj.target = 1;
      } else {
        obj.line = this.#objectiveLine(next.objective);
        obj.value = Math.floor(next.value);
        obj.target = next.target;
      }
      m.objective = obj;
    }

    m.weather.active = weather.current;
    m.weather.warning = weather.phase === 'warning' ? weather.pending : null;
    m.weather.secondsLeft = weather.secondsLeft;

    const boss = this.#findBoss(world);
    m.boss = boss === null ? null : { name: boss.def.name, hp: Math.max(0, Math.round(boss.hp)), max: boss.maxHp };
    m.consumable = this.#consumableSlot();
    m.interact = this.#interactHint(world);
    // Only on change: `setInteractHint` re-applies the touch layout, which
    // resets the floating stick — calling it per frame would kill the stick
    // the moment a thumb raises it.
    const hint = m.interact === null ? null : 'USE';
    if (hint !== this.#touchHint) {
      this.#touchHint = hint;
      this.#touch?.setInteractHint(hint);
    }
  }

  /** The interact prompt (§4.12), including the deliver shortfall hint (E16). */
  #interactHint(world: CombatWorld): string | null {
    if (!world.player.alive) return null;
    if (this.#terminalOpen) return null;
    const missions = this.#missions as Missions;
    const save = this.#save as SaveV1;
    // E16: standing at a deliver POI without enough held resource.
    for (const state of missions.active) {
      for (const { objective, done } of missions.currentObjectives(state.id)) {
        if (objective.kind !== 'deliver' || done) continue;
        const poi = this.#pois.find((p) => p.poi.poi === objective.poi && p.inside);
        if (poi === undefined) continue;
        const held = save.resources[objective.resource] ?? 0;
        if (held < objective.amount) return `Need ${objective.amount - held} more ${objective.resource}`;
      }
    }
    if (this.#atPad(world)) return 'Open pad terminal';
    return null;
  }

  #objectiveLine(objective: MissionDef['stages'][number][number]): string {
    switch (objective.kind) {
      case 'reach':
        return `Reach ${this.#poiLabel(objective.poi)}`;
      case 'scan':
        return `Scan ${this.#poiLabel(objective.poi)}`;
      case 'collect':
        return `Collect ${objective.resource}`;
      case 'kill':
        return `Hunt ${ENEMIES[objective.enemy].name}`;
      case 'boss':
        return `Defeat ${ENEMIES[objective.enemy].name}`;
      case 'survive':
        return 'Survive';
      case 'defend':
        return `Defend ${this.#poiLabel(objective.poi)}`;
      case 'deliver':
        return `Deliver ${objective.amount} ${objective.resource}`;
      case 'escort':
        return `Escort to ${this.#poiLabel(objective.to)}`;
      case 'choice':
        return 'Decide';
    }
  }

  #poiLabel(id: PoiId): string {
    return this.#planet.surface.pois.find((p) => p.id === id)?.label ?? id;
  }

  // ----------------------------------------------------------------- music

  /** §4.1 step 4: calm/combat polls `combat.inCombat`; a live boss takes over. */
  #updateMusic(dt: number, world: CombatWorld): void {
    this.#musicHold -= dt;
    if (this.#musicHold > 0) return;
    const combat = this.#combat as Combat;
    const boss = this.#findBoss(world);
    const wanted = boss !== null && boss.aggro ? 'boss' : combat.inCombat ? 'surface_combat' : 'surface_calm';
    if (wanted === this.#music) return;
    this.#music = wanted;
    this.#musicHold = MUSIC_HOLD_SECONDS;
    this.services.audio.music(wanted);
  }

  // --------------------------------------------------------------- minimap

  #drawMinimap(world: CombatWorld): void {
    const minimap = this.#minimap;
    const missions = this.#missions;
    const save = this.#save;
    if (minimap === null || missions === null || save === null) return;

    // Which POIs the current objectives point at (edge arrows, §4.12).
    this.#objectivePois.clear();
    for (const state of missions.active) {
      for (const { objective, done } of missions.currentObjectives(state.id)) {
        if (done) continue;
        if ('poi' in objective) this.#objectivePois.add(objective.poi);
        if (objective.kind === 'escort') this.#objectivePois.add(objective.to);
        if (objective.kind === 'boss' && this.#arenaPoi !== null) this.#objectivePois.add(this.#arenaPoi.poi);
      }
    }

    this.#minimapPois.length = 0;
    for (const state of this.#pois) {
      this.#minimapPois.push({
        x: state.poi.x,
        z: state.poi.z,
        discovered: state.discovered,
        objective: this.#objectivePois.has(state.poi.poi),
        arenaRadius: state.poi.kind === 'arena' ? state.poi.radius : 0,
      });
    }

    this.#minimapNodes.length = 0;
    const nodesVisible = hasNodeRadar(save);
    if (nodesVisible) {
      for (const node of (this.#nodes as Nodes).states) this.#minimapNodes.push({ x: node.x, z: node.z });
    }

    this.#minimapEnemies.length = 0;
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.state !== 'dead') this.#minimapEnemies.push({ x: e.x, z: e.z });
    }

    minimap.draw({
      playerX: world.player.x,
      playerZ: world.player.z,
      facing: world.player.facing,
      pois: this.#minimapPois,
      nodes: nodesVisible ? this.#minimapNodes : null,
      enemies: this.#minimapEnemies,
    });
  }

  // ---------------------------------------------------------- subscriptions

  #subscribe(bus: EventBus<GameEvents>): void {
    const releases = [
      bus.on(
        'player:died',
        () => {
          this.#deathAt = 0;
          const lost = this.#economy?.applyDeathPenalty() ?? {};
          this.#death?.show(lost);
        },
        this,
      ),
      bus.on(
        'player:damaged',
        ({ amount, source }) => {
          this.#hud?.damageFlash();
          // SPEC-019 §4.6: weather ticks every fixed step — no burst, no
          // shake; the amounts pool into one red number per second (19-m).
          if (source.kind === 'weather') {
            this.#weatherDamage += amount;
            return;
          }
          const world = this.#world;
          if (world === null || this.#view === null) return;
          const p = world.player;
          this.#view.fx.burst('hit', p.x, p.z, HIT_BURST_COLOR);
          this.#triggerShake(HIT_SHAKE_AMPLITUDE, HIT_SHAKE_SECONDS);
          const shown = Math.round(amount);
          if (shown > 0 && this.#numbers !== null) {
            this.#project(p.x, p.z, 1.6);
            this.#numbers.show(this.#screenPoint.x, this.#screenPoint.y, shown, 'player');
          }
        },
        this,
      ),
      bus.on(
        'boss:defeated',
        () => {
          this.#bossId = null;
          if (this.#world !== null) this.#world.arena = null;
          this.#arena = null;
          this.#weather?.suppress(false); // E15: the cycle resumes
        },
        this,
      ),
      bus.on(
        'weather:changed',
        ({ weather }) => {
          const effects = weather === null ? null : WEATHER_EFFECTS[weather];
          if (effects !== null) this.#stormEffects = effects;
          this.#stormTarget = effects === null ? 0 : 1;
          this.#combat?.setWeatherMoveMult(effects === null ? 1 : effects.moveMult);
        },
        this,
      ),
      bus.on(
        'dialogue:started',
        ({ id }) => {
          if (DIALOGUE_TABLE[id].glitch === true) this.#hud?.staticBurst(STATIC_BURST_MS);
        },
        this,
      ),
      bus.on('mission:accepted', () => this.#syncMissionStages(), this),
      bus.on(
        'mission:stageStarted',
        ({ id, stage }) => {
          this.#syncMissionStages();
          // A reach objective for a POI the player is already standing in
          // completes now — entry is edge-triggered, and the edge is behind us
          // (accepting c1_m1 on the pad must not wait for a walk-out-and-back).
          for (const state of this.#pois) {
            if (state.inside) bus.emit('poi:reached', { poi: state.poi.poi, instance: state.poi.instance });
          }
          const dialogueId = MISSION_TABLE[id].dialogue.onStage?.[stage];
          if (dialogueId !== undefined) this.#playDialogue(dialogueId);
          // §4.6: forced mission weather ends when a boss stage starts.
          const missions = this.#missions;
          const weather = this.#weather;
          if (missions !== null && weather !== null && missions.bossStage() !== null && weather.current !== null) {
            weather.suppress(true);
            weather.suppress(false);
          }
        },
        this,
      ),
      bus.on(
        'mission:completed',
        ({ id }) => {
          this.#syncMissionStages();
          const dialogueId = MISSION_TABLE[id].dialogue.onComplete;
          // SPEC-024 §4.1: inside the ending sequence the mission's own
          // debrief is held back — "Verdict filed" contradicts the escape, and
          // the ending dialogue replaces it for the stay. The station plays it
          // on the next docking (SPEC-014's debrief), where it belongs.
          const held = this.#ending !== null && id === this.#endingFor;
          if (dialogueId !== undefined && !held) this.#playDialogue(dialogueId);
          if (this.#terminalOpen) this.#renderTerminal();
        },
        this,
      ),
      bus.on('mission:abandoned', () => this.#syncMissionStages(), this),
      bus.on(
        'mission:stageReset',
        ({ reason }) => {
          // Death already rebuilt the defend stage in `#respawn`; the POI
          // destruction reset rebuilds it here (12-d).
          if (reason === 'poi_destroyed') this.#syncDefend();
        },
        this,
      ),
      bus.on(
        'follower:died',
        () => {
          if (this.#world !== null) this.#world.follower = null;
          this.#followerRespawnIn = FOLLOWER_RESPAWN_SECONDS; // E13
        },
        this,
      ),
      bus.on(
        'enemy:spawned',
        ({ elite }) => {
          this.#spawned++;
          if (elite) this.#elites++;
          // SPEC-019 §4.6: the spawn puff, off the director's last-placed
          // entity — summons and hatches included; skipped when null (19-n).
          const spawned = this.#combat?.lastSpawned ?? null;
          if (spawned !== null) this.#view?.fx.burst('spawn', spawned.x, spawned.z, this.#groundColor);
        },
        this,
      ),
      bus.on(
        'enemy:killed',
        ({ enemyId, elite, x, z }) => {
          this.#kills++;
          // SPEC-019 §4.6: the death burst in the definition's tint, plus a
          // scorch; an elite or boss kill freezes the view for two frames.
          const def = ENEMIES[enemyId];
          const view = this.#view;
          if (view !== null) {
            view.fx.burst('death', x, z, hexColor(def.look.tint));
            view.fx.scorch(x, z);
          }
          if (elite || def.archetype === 'boss') this.#hitStop.frames = 2;
        },
        this,
      ),
      bus.on(
        'boss:phase',
        () => {
          // SPEC-019 §4.6: the heavy shake always; the ring only when the
          // boss entity is actually in the pool.
          this.#triggerShake(HEAVY_SHAKE_AMPLITUDE, HEAVY_SHAKE_SECONDS);
          const world = this.#world;
          const boss = world === null ? null : this.#findBoss(world);
          if (boss !== null) this.#view?.fx.burst('dust_ring', boss.x, boss.z, this.#groundColor);
        },
        this,
      ),
      bus.on(
        'resource:collected',
        ({ resource, blocked }) => {
          // SPEC-019 §4.6: no sparkle on a blocked pickup (cargo full);
          // otherwise flag one burst for this rendered frame at most.
          if (blocked === undefined) this.#pickupColor = hexColor(RESOURCE_COLORS[resource]);
        },
        this,
      ),
      bus.on(
        'inventory:changed',
        () => {
          this.#pickupColor = ITEM_PICKUP_COLOR;
        },
        this,
      ),
    ];
    for (const release of releases) this.disposer.add(release);
  }

  /**
   * Re-derive everything that hangs off the set of current stages. Defend and
   * escort rebuild only when their stage identity changes — `#syncDefend`
   * refills the POI and restarts the wave, `#syncEscort` respawns the
   * follower, and an unrelated mission event must not reset either.
   */
  #syncMissionStages(): void {
    const missions = this.#missions;
    const spawn = this.#spawn;
    if (missions === null || spawn === null) return;
    spawn.setObjectiveEnemies(missions.objectiveEnemies());
    const defend = missions.defendStage();
    const defendKey = defend === null ? null : `${defend.poi}:${defend.wave}:${defend.seconds}`;
    if (defendKey !== this.#defendKey) {
      this.#defendKey = defendKey;
      this.#syncDefend();
    }
    const escort = missions.escortStage();
    const escortKey = escort === null ? null : `${escort.from}:${escort.to}:${escort.follower}`;
    if (escortKey !== this.#escortKey) {
      this.#escortKey = escortKey;
      this.#syncEscort();
    }
  }
}
