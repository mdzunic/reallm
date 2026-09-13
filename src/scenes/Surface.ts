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
import { EXPLORE_CELL, newSave, type CharacterCreation, type Save } from '@/core/Save';
import type { GuidanceLevel } from '@/core/Settings';
import type { GameServices } from '@/core/Services';
import type { SceneParams } from '@/core/StateMachine';
import type { Renderer } from '@/core/Renderer';
import {
  BOSS_REVEALS,
  DIALOGUE,
  ENEMIES,
  FOLLOWERS,
  HINTS,
  HINT_PLACEHOLDERS,
  ITEMS,
  MISSIONS,
  MISSION_HINTS,
  PLANETS,
  SURFACE_ASSETS,
  SURFACE_SHARED_ASSETS,
  TIPS,
  TUNING,
  type BossRevealDef,
  type Dialogue,
  type DialogueId,
  type EnemyId,
  type HintPlaceholder,
  type Item,
  type ItemId,
  type MissionDef,
  type MissionId,
  type PlanetDef,
  type PoiId,
  type QuickSlot,
  type ResourceId,
  type TipId,
  type WeaponSlot,
  MESH_RECIPE_IDS,
  QUICK_SLOTS,
  WEAPON_SLOTS,
} from '@/data/index';
import { makeEnemy, type EnemyEntity } from '@/entities/Enemy';
import { makeFollower } from '@/entities/Follower';
import { makePlayer } from '@/entities/Player';
import { makeProjectile } from '@/entities/Projectile';
import type { ArenaState } from '@/entities/World';
import { Combat, computePlayerStats, type CombatWorld } from '@/systems/Combat';
import { Economy } from '@/systems/Economy';
import { ExploreMask, REVEAL_CAPACITY } from '@/systems/Exploration';
import {
  bearingWord,
  buildPathGrid,
  distanceText,
  fillHint,
  findPath,
  focusObjective,
  objectiveTarget,
  padTarget,
  PATH_MAX_POINTS,
  StuckTracker,
  type GuideContext,
  type GuidePoi,
  type GuideTarget,
  type PathGrid,
} from '@/systems/Guidance';
import { fillQuickFromPickup, quickEligible, refillQuick, type SlotView } from '@/systems/Loadout';
import { generateLayout, ObstacleGrid, type Layout, type LayoutPoi } from '@/systems/Layout';
import { nodeIcon, poiIcon } from '@/systems/MapModel';
import { Missions, type MissionContext, type ObjectiveProgress } from '@/systems/Missions';
import { Nodes, Pickups } from '@/systems/Pickups';
import { cumulativeXp, Progression, xpToNext } from '@/systems/Progression';
import { SpawnDirector, type FrustumXZ } from '@/systems/Spawn';
import { Weather, WEATHER_EFFECTS, type WeatherEffects } from '@/systems/Weather';
import { revealCamera, revealDue, revealKey, stayReport, type Ending } from '@/systems/StoryBeats';
import { hasNodeRadar, type HudTracker, type HudTrackerRow } from '@/systems/UiHelpers';
import { UiScene } from '@/scenes/base';
import { director } from '@/scenes/Director';
import { INSTANCES_PER_PART } from '@/views/ProceduralMeshes';
import { layerFromAssets } from '@/views/ProceduralTextures';
import { advanceViewTime, RESOURCE_COLORS, shakeOffset, SurfaceView, type ShakeState } from '@/views/SurfaceView';
import { AriaHint } from '@/ui/AriaHint';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { DamageNumbers } from '@/ui/DamageNumbers';
import { DeathOverlay } from '@/ui/DeathOverlay';
import { dialogueLayer, type DialogueUI } from '@/ui/DialogueUI';
import { el, h, testId } from '@/ui/dom';
import { clearEndingOverlays, EndingOverlay } from '@/ui/EndingOverlay';
import { Hud } from '@/ui/Hud';
import { MapLayers } from '@/ui/MapLayers';
import { MapScreen, type MapMissionRow } from '@/ui/MapScreen';
import { Minimap, type MapMark, type MinimapFrame } from '@/ui/Minimap';
import { PauseMenu } from '@/ui/PauseMenu';
import { openQuickPicker, type QuickChoice } from '@/ui/QuickPicker';
import { RevealOverlay } from '@/ui/RevealOverlay';
import { RotateOverlay } from '@/ui/RotateOverlay';
import { ScanRing } from '@/ui/ScanRing';
import { TouchControls } from '@/ui/TouchControls';
import { Waypoint } from '@/ui/Waypoint';

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

// ------------------------------------------------------------- SPEC-028 §4.4
// Quick slots: the empty texts, the per-text toast throttle, and the tip clock.

const QUICK_EMPTY_TEXT: Readonly<Record<QuickSlot, string>> = {
  heal: 'No healing items',
  explosive: 'No explosives',
  utility: 'No utility items',
};
/** §4.4: each refusal text toasts at most once per 3 s. */
const QUICK_TOAST_SECONDS = 3;
/** §4.8: the quick-bar tip, ten seconds after the move tip on first landing. */
const QUICKBAR_TIP_SECONDS = 10;

/** §4.3: one quick-bar tap, waiting in the fixed ring for the next step. */
interface QuickBarCommand {
  kind: 'slot' | 'pick';
  slot: WeaponSlot | QuickSlot;
}

/** Music switching hysteresis, so a grazing shot cannot strobe the bed. */
const MUSIC_HOLD_SECONDS = 2;
/** AC-71: the glitch dialogue static burst. */
const STATIC_BURST_MS = 600;
/** The minimap repaints at 4 Hz — plenty for 1 px = 1 m. */
const MINIMAP_INTERVAL = 0.25;

// ------------------------------------------------------------- SPEC-027 §4.3
// Mission guidance: the waypoint's inset ellipse, the tip queue's clocks, the
// route's recompute rules, and the ranges the map marks and the tips watch.

/** §4.3: the ellipse's inset from the viewport edge, and its floor (27-k). */
const WAYPOINT_INSET = 56;
const WAYPOINT_MIN_AXIS = 40;
/** The marker sits this far above the ground at the target (§4.3). */
const WAYPOINT_LIFT = 1.6;
/** §4.5: a tip holds the line for 8 s, a stuck hint for 7 s. */
const TIP_MS = 8000;
const HINT_MS = 7000;
/** §4.5: one tip per 12 s, and at most three waiting behind it (D-27). */
const TIP_INTERVAL = 12;
const TIP_QUEUE_MAX = 3;
/** §4.5 triggers: surface seconds before the map tip, and the node range. */
const MAP_TIP_SECONDS = 20;
const HARVEST_TIP_RANGE = 6;
/** §4.7: at most one path search per 2 s, and what makes one worth running. */
const ROUTE_INTERVAL = 2;
const ROUTE_OFF_PATH_METRES = 8;
const ROUTE_TARGET_MOVED_METRES = 6;
/** §4.11: objective enemies inside this range ride the minimap (AC-39). */
const OBJECTIVE_ENEMY_RANGE = 60;

// ------------------------------------------------------------- SPEC-026 §4.4

/** The ground under the player is revealed at 4 Hz, like the minimap repaint. */
const EXPLORE_INTERVAL = 0.25;
/** …and the mask reaches the live save at most once a second, while it changes. */
const EXPLORE_SAVE_INTERVAL = 1;

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

/** SPEC-027: the rows of a scene with nothing tracked — shared, never written. */
const NO_ROWS: readonly ObjectiveProgress[] = Object.freeze([]);

/** SPEC-027 D-13: a filled hint still holding a `{token}` cannot be shown. */
function hasPlaceholder(text: string): boolean {
  for (const placeholder of HINT_PLACEHOLDERS) {
    if (text.includes(placeholder)) return true;
  }
  return false;
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

function acceptShown(save: Save): Set<MissionId> {
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
  #save: Save | null = null;
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
  // SPEC-026 — the two maps: the explored mask, the cached layers both draw
  // from, and the full-screen map that holds the simulation while it is open.
  #mask: ExploreMask | null = null;
  #layers: MapLayers | null = null;
  #mapScreen: MapScreen | null = null;
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

  // SPEC-026 §4.6 — the UI hold. The full map takes one; while it is above
  // zero the fixed step runs the map's own presses and nothing else, so
  // `world.time` stands still and nothing can reach the player.
  #uiHolds = 0;
  #exploreIn = 0;
  #exploreSaveIn = EXPLORE_SAVE_INTERVAL;

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
  // model may point at these reused objects (SPEC-028 §4.5).
  readonly #loadoutScratch: { active: WeaponSlot; slots: Record<WeaponSlot, SlotView> } = {
    active: 'primary',
    slots: {
      sidearm: { itemId: null, state: 'empty', cd: 0, heat: 0, charges: 0, maxCharges: 0 },
      primary: { itemId: null, state: 'empty', cd: 0, heat: 0, charges: 0, maxCharges: 0 },
      heavy: { itemId: null, state: 'empty', cd: 0, heat: 0, charges: 0, maxCharges: 0 },
    },
  };
  readonly #quickScratch: Record<QuickSlot, { itemId: ItemId | null; qty: number }> = {
    heal: { itemId: null, qty: 0 },
    explosive: { itemId: null, qty: 0 },
    utility: { itemId: null, qty: 0 },
  };

  // SPEC-028 §4.3: quick-bar taps land in a fixed ring of 4 between steps and
  // are drained at the start of the next one; a full ring drops the tap.
  readonly #qbRing: QuickBarCommand[] = [
    { kind: 'slot', slot: 'sidearm' },
    { kind: 'slot', slot: 'sidearm' },
    { kind: 'slot', slot: 'sidearm' },
    { kind: 'slot', slot: 'sidearm' },
  ];
  #qbLength = 0;
  /** §4.4: `world.time` of the last toast per text — one per 3 s each. */
  readonly #quickToastAt = new Map<string, number>();
  /** §4.6: the open picker's close function, or `null`. */
  #pickerClose: (() => void) | null = null;

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
  // SPEC-026 §4.9: the frame both maps read is scene-owned and reused — the
  // marks are pooled by index and written in place, so a repaint allocates
  // nothing (SPEC-001 §7).
  readonly #markPool: MapMark[] = [];
  readonly #marks: MapMark[] = [];
  readonly #enemyPool: { x: number; z: number; kind: 'enemy' | 'elite' | 'boss' }[] = [];
  readonly #minimapEnemies: { x: number; z: number; kind: 'enemy' | 'elite' | 'boss' }[] = [];
  readonly #arrowPool: { x: number; z: number }[] = [];
  readonly #arrows: { x: number; z: number }[] = [];
  readonly #frame: MinimapFrame = {
    playerX: 0,
    playerZ: 0,
    facing: 0,
    marks: this.#marks,
    enemies: this.#minimapEnemies,
    arrows: this.#arrows,
    target: null,
    route: null,
    routeLength: 0,
  };
  readonly #revealOut = new Int32Array(REVEAL_CAPACITY);
  readonly #objectivePois = new Set<PoiId>();
  readonly #missionRows: MapMissionRow[] = [];

  // ------------------------------------------------------------- SPEC-027
  // Guidance. Everything here is scene-local and session-only (27-n): the
  // focus target and its distance, the escalation clock, the route, the tip
  // queue, and the three DOM pieces that sit over the canvas.
  #waypoint: Waypoint | null = null;
  #scanRing: ScanRing | null = null;
  #aria: AriaHint | null = null;
  readonly #stuck = new StuckTracker();
  #pathGrid: PathGrid | null = null;
  /** The context handed to the pure module, refreshed in place each step. */
  #guide: GuideContext | null = null;
  readonly #guidePlayer = { x: 0, z: 0 };
  readonly #guidePois: GuidePoi[] = [];
  readonly #enemyPoint = { x: 0, z: 0 };
  /** The tracked stage this step, and which of its rows the marker follows. */
  #guideRows: readonly ObjectiveProgress[] = [];
  #focusIndex = -1;
  #focusTarget: GuideTarget | null = null;
  #focusDistance: number | null = null;
  #focusBearing = 0;
  /** The scan POI the ring is filling for, or `null` (§4.3, AC-35). */
  #scanState: PoiRuntime | null = null;
  #waypointState: 'on' | 'edge' | 'off' = 'off';
  /** The route: the smoothed path, its length in points, and its clocks. */
  readonly #route = new Float32Array(PATH_MAX_POINTS * 2);
  #routeLength = 0;
  #routeIn = 0;
  #routeTargetX = 0;
  #routeTargetZ = 0;
  /** The line waiting for the screen (a hint outranks a tip, D-7). */
  #pendingLine: { text: string; ms: number } | null = null;
  readonly #tipQueue: TipId[] = [];
  #tipCooldown = 0;
  #surfaceTime = 0;
  /** Deaths per `${missionId}:${stage}`, and the stages already told (AC-69). */
  readonly #deathCounts = new Map<string, number>();
  readonly #deathHinted = new Set<string>();
  /** The HUD tracker model and its row pool, sized from the largest stage (D-28). */
  readonly #trackerRows: HudTrackerRow[] = [];
  readonly #tracker: HudTracker = {
    title: 'No active mission',
    stage: '',
    rows: [],
    distance: null,
    bearing: 0,
    pulse: false,
  };
  /** Reused points: the minimap's target, the view's pillar, hint values. */
  readonly #targetPoint = { x: 0, z: 0 };
  readonly #beaconPoint = { x: 0, z: 0 };
  readonly #guideFrame: {
    beacon: { x: number; z: number } | null;
    route: Float32Array | null;
    routeLength: number;
    pulse: boolean;
  } = { beacon: null, route: null, routeLength: 0, pulse: false };
  readonly #hintValues: Partial<Record<HintPlaceholder, string>> = {};

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
    // SPEC-027 AC-22: a tap on the tracker cycles the tracked mission, exactly
    // as `KeyT` does — the HUD owns the element, the runtime owns the pin.
    // SPEC-028 §4.3/§4.5: the quick bar's taps arrive as commands through the
    // fixed ring and are drained at the start of the next fixed step; the key
    // hints and the 56 px touch sizing follow the live scheme.
    const hud = new Hud(this.ui, 'surface', () => missions.cyclePinned(), {
      slot: (slot) => this.#pushQuickBar('slot', slot),
      pick: (slot) => this.#pushQuickBar('pick', slot),
    });
    this.#hud = hud;
    this.disposer.add(() => hud.dispose());
    hud.setScheme(services.input.state.scheme);
    this.disposer.add(services.events.on('input:schemeChanged', ({ scheme }) => hud.setScheme(scheme), this));
    // §4.6: a picker still open when the scene goes releases its hold with it.
    this.disposer.add(() => this.#pickerClose?.());

    // SPEC-027 §4.11: the guidance layer over the canvas, the search grid the
    // route is found on, and the context the pure module reads. The context is
    // built once and refreshed in place every step (SPEC-001 §7).
    this.#buildGuidance(world, save, layout);

    // SPEC-026 §4.4: the explored mask comes off the save (SPEC-025 has
    // already dropped one of the wrong length, E37), the ground under the
    // landing spot is lit, and the two cached layers are built from the layout.
    const mask = new ExploreMask(layout.halfSize, save.progress.explored[planet.id]);
    this.#mask = mask;
    mask.reveal(world.player.x, world.player.z, this.#revealOut);
    const layers = new MapLayers(layout, planet.surface.palette);
    this.#layers = layers;
    layers.syncFog(mask);

    if (hud.minimapCanvas !== null) {
      const minimap = new Minimap(hud.minimapCanvas, layers);
      this.#minimap = minimap;
      // §4.3: a tap on the minimap opens the full map (the pin moved to `T`).
      const open = (): void => this.#openMap();
      minimap.canvas.addEventListener('click', open);
      this.disposer.add(() => minimap.canvas.removeEventListener('click', open));
      // The box is sized in CSS, so a resize is what re-measures the backing.
      this.disposer.add(services.events.on('renderer:resized', () => minimap.measure(), this));
    }

    // §4.5: the full-screen map. It only draws and asks to be closed; the hold,
    // the touch layer and the pin are the scene's.
    const mapScreen = new MapScreen({
      ui: this.ui,
      layers,
      layout,
      planet,
      missions: () => this.#mapMissions(),
      track: (id) => this.#trackMission(id),
      close: () => this.#closeMap(),
    });
    this.#mapScreen = mapScreen;
    this.disposer.add(() => {
      mapScreen.dispose();
      this.#mapScreen = null;
      this.#uiHolds = 0;
    });
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
    // SPEC-026 §4.4: the ground walked this visit reaches the live save before
    // anything flushes it, so the next landing lights what this one lit.
    this.#writeMask();
    if (world !== null && save !== null && this.services.save.current === save) {
      save.player.hp = Math.max(1, Math.round(world.player.hp));
      this.services.save.flush();
    }
    this.#touch?.hide();
  }

  /** SPEC-026 §4.6: the map is not a second pause — it closes before this one. */
  pause(): void {
    this.#closeMap();
    // SPEC-028 §4.6: the quick picker closes with the scene pausing too.
    this.#pickerClose?.();
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
      this.#qbLength = 0; // taps made during the beat are dropped like the edges
      this.#updateReveal(dt);
      return;
    }

    // SPEC-026 §4.6: the full map's hold. Playtime still accrues (above) and
    // the map's own press is read; everything else — combat, missions,
    // weather, spawning, pickups, nodes, exploration — waits, so `world.time`
    // stands still and a swarm cannot bite a player who is reading a map.
    if (this.#uiHolds > 0) {
      this.#qbLength = 0; // the bar is inert while the simulation is held
      if (this.#edges.pressed('map')) this.#closeMap();
      world.player.vx = 0;
      world.player.vz = 0;
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
      this.#updateLoadout(world, combat);
      // SPEC-026 §4.5/§4.7: `map` opens the map, `track` cycles the pin.
      if (this.#edges.pressed('map')) this.#openMap();
      if (this.#edges.pressed('track')) missions.cyclePinned();
    } else {
      this.#qbLength = 0;
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

    // SPEC-027 §4.11: guidance runs after the mission runtime, so the rows it
    // reads — and the target it picks out of them — are this step's.
    this.#updateGuidance(world, dt);

    this.#followCamera(world, dt);
    this.#updateMusic(dt, world);
    this.#feedHud(world, dt);
    this.#explore(world, dt);
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
      // SPEC-027 §4.11: the waypoint, the scan ring and the two view meshes.
      this.#renderGuidance(world, view);
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
    // SPEC-028 §4.9: the weapon in hand and the quick-slot counts.
    const combat = this.#combat;
    const save = this.#save;
    const economy = this.#economy;
    if (combat !== null && save !== null && economy !== null) {
      info['weapon'] = combat.loadout.activeWeapon().id;
      info['weaponSlot'] = combat.loadout.active;
      const countOf = (id: ItemId | null): number => (id === null ? 0 : economy.count(id));
      info['qHeal'] = countOf(save.quick.heal);
      info['qExplosive'] = countOf(save.quick.explosive);
      info['qUtility'] = countOf(save.quick.utility);
    }
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
    // AC-55..AC-59: what the minimap painter drew on its last repaint. They
    // keep reporting that paint while the full map is open (SPEC-026 §4.8).
    const drawn = this.#minimap?.lastDrawn;
    if (drawn !== undefined) {
      info['mmPois'] = drawn.pois;
      info['mmObjectives'] = drawn.objectives;
      info['mmArrows'] = drawn.arrows;
      info['mmNodes'] = drawn.nodes;
      info['mmEnemies'] = drawn.enemies;
    }
    // SPEC-026 §4.8: the explored share, the map's state, and the proof that
    // the terrain layer is built once per visit.
    if (this.#mask !== null) info['mmExplored'] = Math.round(this.#mask.fraction() * 1000) / 10;
    if (this.#layers !== null) info['mmTerrainBuilds'] = this.#layers.terrainBuilds;
    info['mapOpen'] = this.#mapScreen?.isOpen === true ? 1 : 0;
    // SPEC-027 §4.11: what the guidance layer is pointing at, how far it is,
    // how stuck the player looks, and which form the marker is in. The label's
    // spaces become underscores: the `?debug` row is `key=value` pairs split on
    // whitespace, and `surface-env.spec.ts` pins that shape.
    const target = this.#focusTarget;
    info['guideTarget'] = target === null ? '-' : `${target.kind}:${target.label.replace(/\s+/g, '_')}`;
    info['guideDist'] = this.#focusDistance === null ? -1 : Math.round(this.#focusDistance * 10) / 10;
    info['stuckLevel'] = this.#stuck.level;
    info['waypoint'] = this.#waypointState;
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
    const save = this.#save as Save;
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
    // The overlay lives on the shared `#ui` root and takes itself down when it
    // resolves; a quit from the pause menu while the card is up has to take it
    // along too. `endingSeen` then stays false and the station replays it.
    this.disposer.add(() => clearEndingOverlays(services.uiRoot));
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

  // ---------------------------------------------------- SPEC-028: loadout

  /**
   * §4.3: the loadout presses, on the step they land, plus the quick-bar ring
   * drained at the start of the step. Skipped while held or modal (the caller
   * gates); a dead player switches and spends nothing.
   */
  #updateLoadout(world: CombatWorld, combat: Combat): void {
    if (!world.player.alive) {
      this.#qbLength = 0;
      return;
    }
    const loadout = combat.loadout;
    const time = world.time;

    // The ring first, so a tap made between steps lands before this step's keys.
    const queued = this.#qbLength;
    this.#qbLength = 0;
    for (let i = 0; i < queued; i++) {
      const command = this.#qbRing[i] as QuickBarCommand;
      const slot = command.slot;
      if (command.kind === 'pick') {
        if (slot !== 'sidearm' && slot !== 'primary' && slot !== 'heavy') this.#openPicker(slot);
      } else if (slot === 'sidearm' || slot === 'primary' || slot === 'heavy') {
        loadout.select(slot, time);
      } else {
        this.#useQuick(slot);
      }
    }

    if (this.#edges.pressed('weapon1')) loadout.select('sidearm', time);
    if (this.#edges.pressed('weapon2')) loadout.select('primary', time);
    if (this.#edges.pressed('weapon3')) loadout.select('heavy', time);
    if (this.#edges.pressed('weaponNext')) loadout.cycle(1, time);
    if (this.#edges.pressed('weaponPrev')) loadout.cycle(-1, time);
    if (this.#edges.pressed('useItem')) this.#useQuick('heal');
    if (this.#edges.pressed('throwItem')) this.#useQuick('explosive');
    if (this.#edges.pressed('useUtility')) this.#useQuick('utility');
  }

  /** §4.3: a quick-bar tap between steps; a full ring drops it. */
  #pushQuickBar(kind: 'slot' | 'pick', slot: WeaponSlot | QuickSlot): void {
    if (this.#qbLength >= this.#qbRing.length) return;
    const entry = this.#qbRing[this.#qbLength] as QuickBarCommand;
    entry.kind = kind;
    entry.slot = slot;
    this.#qbLength++;
  }

  /**
   * §4.4: spend one item from a quick slot — refill a run-out slot first,
   * refuse an empty one or a heal at full HP with a throttled toast, and keep
   * the id when the last one is spent so the bar reads `×0`.
   */
  #useQuick(slot: QuickSlot): void {
    const world = this.#world;
    const economy = this.#economy;
    const combat = this.#combat;
    const save = this.#save;
    if (world === null || economy === null || combat === null || save === null) return;
    if (!world.player.alive) return;

    let id = save.quick[slot];
    if (id === null || economy.count(id) === 0) {
      const refill = refillQuick(save, slot);
      if (refill !== null) {
        save.quick[slot] = refill;
        id = refill;
      }
    }
    if (id === null || economy.count(id) === 0) {
      this.#quickToast(QUICK_EMPTY_TEXT[slot]);
      return;
    }
    // E40: the most common waste on a phone — a heal at full HP spends nothing.
    if (slot === 'heal' && world.player.hp >= world.stats.maxHp) {
      this.#quickToast('HP full');
      return;
    }
    // SPEC-029 deploys the explosive; until then the slot only ever reads ×0.
    if (slot === 'explosive') return;

    const result = economy.useConsumable(id);
    if (!result.ok) return;
    combat.applyConsumable(result.effect);
    this.services.events.emit('quick:used', { slot, itemId: id });
    // §4.4: the id stays when nothing replaces it, so the bar reads `×0`.
    if (economy.count(id) === 0) save.quick[slot] = refillQuick(save, slot) ?? id;
  }

  /** §4.4: one toast per text per 3 s, on the world clock. */
  #quickToast(text: string): void {
    const time = this.#world?.time ?? 0;
    const last = this.#quickToastAt.get(text);
    if (last !== undefined && time - last < QUICK_TOAST_SECONDS) return;
    this.#quickToastAt.set(text, time);
    this.services.events.emit('ui:toast', { text, kind: 'warn' });
  }

  /**
   * §4.6: the picker over the bar. It takes a `#uiHolds` hold, so the
   * simulation stands still while it is open (28-d, 28-e); Escape, a tap
   * outside, the scene pausing and the scene going all close it.
   */
  #openPicker(slot: QuickSlot): void {
    if (this.#pickerClose !== null) return;
    const save = this.#save;
    const economy = this.#economy;
    const world = this.#world;
    if (save === null || economy === null || world === null) return;
    if (this.#modalOpen > 0 || this.#terminalOpen || this.#holds > 0 || this.#deathAt !== null) return;

    const choices: QuickChoice[] = [];
    for (const entry of save.inventory) {
      if (entry.qty > 0 && quickEligible(entry.itemId, slot)) {
        choices.push({ itemId: entry.itemId, label: ITEM_TABLE[entry.itemId].name, qty: entry.qty });
      }
    }
    this.#uiHolds++;
    world.player.vx = 0;
    world.player.vz = 0;
    this.#pickerClose = openQuickPicker(
      this.ui,
      slot,
      choices,
      (id) => {
        save.quick[slot] = id;
        this.services.save.request('purchase');
      },
      () => {
        this.#pickerClose = null;
        this.#uiHolds = Math.max(0, this.#uiHolds - 1);
      },
    );
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
    const save = this.#save as Save;
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
    // SPEC-027 AC-86: a minute of idle guidance time per press, so the whole
    // escalation is reachable in a QA session instead of in two and a half.
    button('surface-stuck', 'Stuck +60s', () => this.#stuck.advance(60));
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

  /**
   * Teleport to the pinned mission's first undone objective's target.
   *
   * SPEC-027 D-25: the row is chosen exactly as it always was — the first
   * undone one — but the destination now comes from `objectiveTarget`, so the
   * debug jump and the gold marker can never disagree. The boss case keeps its
   * `z + 6` offset, which is what lands the SPEC-011 and SPEC-012 suites
   * outside the arena ring rather than on the nest.
   */
  #debugGotoObjective(): void {
    const world = this.#world;
    const missions = this.#missions;
    if (world === null || missions === null || this.#guide === null || !world.player.alive) return;
    const pinned = missions.pinned;
    if (pinned === null) return;
    const next = missions.currentObjectives(pinned).find((o) => !o.done);
    if (next === undefined) return;
    const target = objectiveTarget(next.objective, next, this.#refreshGuide(world));
    if (target === null) return;
    world.player.x = target.x;
    world.player.z = target.z + (next.objective.kind === 'boss' ? 6 : 0);
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
      const save = this.#save as Save;
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

    // SPEC-027 AC-17/AC-18: on the surface the tracker replaces the
    // bottom-centre line — its focus row carries the same wording E18 put
    // there (D-3) — and `objective` stays flight's alone. The model reuses one
    // object; `Hud.flush` diffs against a clone, so in-place writes register
    // (SPEC-001 §7: no per-frame allocation).
    m.objective = null;
    m.tracker = this.#feedTracker(missions);

    m.weather.active = weather.current;
    m.weather.warning = weather.phase === 'warning' ? weather.pending : null;
    m.weather.secondsLeft = weather.secondsLeft;

    const boss = this.#findBoss(world);
    m.boss = boss === null ? null : { name: boss.def.name, hp: Math.max(0, Math.round(boss.hp)), max: boss.maxHp };

    // SPEC-028 §4.5: the two halves of the quick bar, into reused scratch —
    // the flush diffs against a clone, so in-place writes still register.
    const combat = this.#combat;
    const economy = this.#economy;
    if (combat !== null && economy !== null) {
      const loadout = this.#loadoutScratch;
      loadout.active = combat.loadout.active;
      for (const slot of WEAPON_SLOTS) combat.loadout.view(slot, world.time, loadout.slots[slot]);
      m.loadout = loadout;
      for (const slot of QUICK_SLOTS) {
        const id = save.quick[slot];
        const entry = this.#quickScratch[slot];
        entry.itemId = id;
        entry.qty = id === null ? 0 : economy.count(id);
      }
      m.quick = this.#quickScratch;
    }

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
    const save = this.#save as Save;
    // E16: standing at a deliver POI without enough held resource.
    for (const state of missions.active) {
      for (const { objective, done } of missions.currentObjectives(state.id)) {
        if (objective.kind !== 'deliver' || done) continue;
        const poi = this.#pois.find((p) => p.poi.poi === objective.poi && p.inside);
        if (poi === undefined) continue;
        const held = save.resources[objective.resource] ?? 0;
        if (held < objective.amount) {
          // SPEC-027 §4.5: the first shortfall is what teaches the rule.
          this.#requestTip('deliver');
          return `Need ${objective.amount - held} more ${objective.resource}`;
        }
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

  // ------------------------------------------------------------- SPEC-027
  // Mission guidance. The pure half is `systems/Guidance.ts`; what lives here
  // is the wiring: the context it reads, the clocks it drives, and the three
  // DOM pieces plus the two view meshes it drives back.

  /** §4.11: the guidance layer, the search grid, and the reusable context. */
  #buildGuidance(world: CombatWorld, save: Save, layout: Layout): void {
    const layer = el('div', 'guide-layer');
    this.ui.mount(layer, 'hud');
    const waypoint = new Waypoint(layer);
    const scanRing = new ScanRing(layer);
    const aria = new AriaHint(layer);
    this.#waypoint = waypoint;
    this.#scanRing = scanRing;
    this.#aria = aria;
    this.disposer.add(() => {
      waypoint.dispose();
      scanRing.dispose();
      aria.dispose();
      this.ui.unmount(layer);
      this.#waypoint = null;
      this.#scanRing = null;
      this.#aria = null;
    });

    this.#pathGrid = buildPathGrid(layout);
    this.#guide = {
      player: this.#guidePlayer,
      pois: this.#guidePois,
      // `Nodes.states` is the live array; `remaining` moves in place (D-18).
      nodes: (this.#nodes as Nodes).states,
      nearestEnemy: (id, maxRange) => this.#nearestEnemy(world, id, maxRange),
      follower: null,
      held: (resource) => save.resources[resource] ?? 0,
      arenaFor: (enemy) => this.#arenaFor(enemy),
    };

    // D-28: the row pool is the campaign's widest stage plus the row that says
    // the stage is complete (27-p), so a step never allocates one.
    let widest = 1;
    for (const def of Object.values(MISSIONS)) {
      for (const stage of def.stages) widest = Math.max(widest, stage.length);
    }
    for (let i = 0; i <= widest; i++) this.#trackerRows.push({ text: '', done: false, focus: false });
  }

  /** The nearest live enemy of one kind, as a reused point (§3, `GuideContext`). */
  #nearestEnemy(world: CombatWorld, id: EnemyId, maxRange: number): { x: number; z: number } | null {
    let bestD = maxRange;
    let found = false;
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.state === 'dead' || e.def.id !== id) continue;
      const d = Math.hypot(e.x - world.player.x, e.z - world.player.z);
      if (d >= bestD) continue;
      bestD = d;
      found = true;
      this.#enemyPoint.x = e.x;
      this.#enemyPoint.z = e.z;
    }
    return found ? this.#enemyPoint : null;
  }

  /** D-19: the arena POI whose `PoiDef.boss` is this enemy. */
  #arenaFor(enemy: EnemyId): GuidePoi | null {
    let arena: PoiId | null = null;
    for (const def of this.#planet.surface.pois) {
      if (def.boss === enemy) {
        arena = def.id;
        break;
      }
    }
    if (arena === null) return null;
    for (const poi of this.#guidePois) {
      if (poi.poi === arena) return poi;
    }
    return null;
  }

  /** The context, refreshed in place: one object for the scene's lifetime. */
  #refreshGuide(world: CombatWorld): GuideContext {
    const guide = this.#guide as GuideContext;
    this.#guidePlayer.x = world.player.x;
    this.#guidePlayer.z = world.player.z;
    const pois = this.#guidePois;
    for (let i = 0; i < this.#pois.length; i++) {
      const state = this.#pois[i] as PoiRuntime;
      let entry = pois[i];
      if (entry === undefined) {
        entry = { poi: state.poi.poi, instance: 0, kind: state.poi.kind, x: 0, z: 0, radius: 0, label: '', scanned: false };
        pois.push(entry);
      }
      entry.poi = state.poi.poi;
      entry.instance = state.poi.instance;
      entry.kind = state.poi.kind;
      entry.x = state.poi.x;
      entry.z = state.poi.z;
      entry.radius = state.poi.radius;
      entry.label = this.#poiLabel(state.poi.poi);
      entry.scanned = state.scanned;
    }
    pois.length = this.#pois.length;
    // `#ctxFollower` was refreshed for `missions.update` earlier this step.
    guide.follower = world.follower === null ? null : this.#ctxFollower;
    return guide;
  }

  /**
   * §4.11, each fixed step: the focus target, the escalation clock and what it
   * raises, the tip triggers and the route. Runs after `missions.update`, so
   * every row it reads is this step's.
   */
  #updateGuidance(world: CombatWorld, dt: number): void {
    const missions = this.#missions;
    const combat = this.#combat;
    if (missions === null || combat === null || this.#guide === null) return;
    this.#surfaceTime += dt;
    const guidance = this.services.settings.get().guidance;
    const ctx = this.#refreshGuide(world);

    // §4.1: the tracked stage decides; with nothing tracked the pad does.
    const pinned = missions.pinned;
    this.#guideRows = pinned === null ? NO_ROWS : missions.currentObjectives(pinned);
    const focus = pinned === null ? null : focusObjective(this.#guideRows, ctx);
    this.#focusIndex = focus === null ? -1 : focus.index;
    const target = pinned === null ? padTarget(ctx) : focus === null ? null : focus.target;
    this.#focusTarget = target;

    const player = world.player;
    if (target === null) {
      this.#focusDistance = null;
    } else {
      const dx = target.x - player.x;
      const dz = target.z - player.z;
      this.#focusDistance = Math.hypot(dx, dz);
      // The ▲ beside the focus row turns clockwise from map-up (SPEC-026 §4.1).
      const u = (dx - dz) * Math.SQRT1_2;
      const v = (dx + dz) * Math.SQRT1_2;
      this.#focusBearing = Math.atan2(u, -v);
    }

    // §4.6: arrival inside the radius is progress — which is also what keeps
    // the clock at zero while the player stands on the thing (27-l).
    if (target !== null && (this.#focusDistance as number) <= target.radius) this.#stuck.progress();
    this.#stuck.reset(target === null ? null : target.key, this.#focusDistance);
    const busy =
      combat.inCombat ||
      this.#dialogue?.busy === true ||
      this.#modalOpen > 0 ||
      this.#uiHolds > 0 ||
      this.#holds > 0 ||
      !player.alive;
    if (this.#stuck.update(dt, this.#focusDistance, busy) === 'nudge') this.#raiseNudge(missions, guidance);

    this.#updateScanRing(world, missions);
    this.#tipTriggers(world, missions, guidance);
    this.#pumpLines(dt, guidance);
    this.#updateRoute(world, dt, guidance);
  }

  /** §4.6: level 2 — one hint, unless the player asked for less guidance. */
  #raiseNudge(missions: Missions, guidance: GuidanceLevel): void {
    if (guidance !== 'full') return; // AC-60
    const text = this.#hintText(missions);
    if (text !== '') this.#queueLine(text, HINT_MS);
  }

  /**
   * §4.8 — the line for the focus row: the mission's own stage hint where there
   * is one, else the objective kind's. A template whose placeholders cannot all
   * be filled falls back to the kind's `fallback`, then to the reach wording,
   * and is dropped rather than printed with a `{token}` in it (D-13).
   */
  #hintText(missions: Missions): string {
    const target = this.#focusTarget;
    const pinned = missions.pinned;
    // D-11: nothing tracked and nowhere to walk — the player is on the pad.
    if (pinned === null && target === null) return '';
    const row = this.#focusIndex >= 0 ? (this.#guideRows[this.#focusIndex] ?? null) : null;
    const kind = row === null ? 'none' : row.objective.kind;
    const values = this.#fillValues(row, target);
    const hint = HINTS[kind];
    const stageHint = pinned === null ? undefined : MISSION_HINTS[pinned]?.[this.#stageOf(missions, pinned)];
    let text = fillHint(stageHint ?? hint.nudge, values);
    if (hasPlaceholder(text)) text = fillHint(hint.fallback ?? '', values);
    if (text === '' || hasPlaceholder(text)) text = fillHint(HINTS.reach.nudge, values);
    if (hasPlaceholder(text)) {
      log.warn('surface', `no guidance hint could be filled for ${kind}`);
      return '';
    }
    return text;
  }

  /** §4.8: the placeholder values, in one reused bag. */
  #fillValues(row: ObjectiveProgress | null, target: GuideTarget | null): Partial<Record<HintPlaceholder, string>> {
    const values = this.#hintValues;
    for (const placeholder of HINT_PLACEHOLDERS) values[placeholder] = undefined;
    if (target !== null) {
      values['{label}'] = target.label;
      values['{dir}'] = bearingWord(target.x - this.#guidePlayer.x, target.z - this.#guidePlayer.z);
      values['{dist}'] = distanceText(this.#focusDistance ?? 0);
    }
    if (row === null) return values;
    const objective = row.objective;
    if ('resource' in objective) values['{resource}'] = objective.resource;
    if ('amount' in objective) values['{amount}'] = String(objective.amount);
    if ('enemy' in objective) values['{enemy}'] = ENEMIES[objective.enemy].name;
    if (objective.kind === 'deliver') {
      const held = (this.#save as Save).resources[objective.resource] ?? 0;
      values['{need}'] = String(Math.max(0, objective.amount - held));
    } else if (objective.kind === 'survive' || objective.kind === 'defend') {
      values['{need}'] = String(Math.max(0, Math.ceil(row.target - row.value)));
    }
    return values;
  }

  #stageOf(missions: Missions, id: MissionId): number {
    for (const state of missions.active) {
      if (state.id === id) return state.stage;
    }
    return 0;
  }

  /** §4.5, §4.8: a hint replaces whatever was waiting; the screen takes it next. */
  #queueLine(text: string, ms: number): void {
    this.#pendingLine = { text, ms };
  }

  /**
   * §4.5 — one line at a time. A dialogue or a hold stops everything; a line
   * already up is never cut short (D-7); a waiting hint goes before a tip; and
   * a tip waits out the 12 s that follow the last one.
   */
  #pumpLines(dt: number, guidance: GuidanceLevel): void {
    this.#tipCooldown -= dt;
    const aria = this.#aria;
    if (aria === null) return;
    if (this.#dialogue?.busy === true || this.#modalOpen > 0 || this.#uiHolds > 0 || this.#holds > 0) return; // AC-70
    if (aria.visible) return; // AC-71
    const pending = this.#pendingLine;
    if (pending !== null) {
      this.#pendingLine = null;
      aria.show(pending.text, pending.ms);
      return;
    }
    if (this.#tipCooldown > 0 || guidance !== 'full') return;
    const id = this.#tipQueue.shift();
    if (id === undefined) return;
    // §4.5: the wording follows the scheme in use at the moment it shows.
    const text = this.services.input.state.scheme === 'touch' ? TIPS[id].touch : TIPS[id].keyboard;
    aria.show(text, TIP_MS);
    this.#tipCooldown = TIP_INTERVAL;
    // D-27: the id is recorded now — a tip dropped from a full queue can fire
    // again later, because it was never written down.
    const settings = this.services.settings;
    settings.set({ tipsSeen: [...settings.get().tipsSeen, id] });
  }

  /** §4.5: queue a first-time tip, unless it has been seen or the queue is full. */
  #requestTip(id: TipId): void {
    if (this.services.settings.get().guidance !== 'full') return; // AC-47
    if (this.services.settings.get().tipsSeen.includes(id)) return; // AC-44
    if (this.#tipQueue.includes(id)) return;
    if (this.#tipQueue.length >= TIP_QUEUE_MAX) return; // 27-r
    this.#tipQueue.push(id);
  }

  /** §4.5 — the triggers that are a matter of where the player is standing. */
  #tipTriggers(world: CombatWorld, missions: Missions, guidance: GuidanceLevel): void {
    if (guidance !== 'full') return;
    // The first fixed step of the first surface scene this device has seen.
    this.#requestTip('move');
    // SPEC-028 §4.8: the quick bar, ten seconds behind the move tip.
    if (this.#surfaceTime >= QUICKBAR_TIP_SECONDS) this.#requestTip('quickbar');
    if (this.#surfaceTime >= MAP_TIP_SECONDS) this.#requestTip('map');
    if (missions.active.length >= 2) this.#requestTip('track');
    if (this.#atPad(world) && !this.#terminalOpen) this.#requestTip('pad');
    if (missions.bossStage() !== null) this.#requestTip('boss');
    const nodes = this.#nodes;
    if (nodes === null) return;
    for (const node of nodes.states) {
      if (Math.hypot(node.x - world.player.x, node.z - world.player.z) <= HARVEST_TIP_RANGE) {
        this.#requestTip('harvest');
        return;
      }
    }
  }

  /**
   * §4.3 — the scan the ring is filling for: an unscanned `scan` POI the player
   * is standing in that a current objective actually wants. Entering one is
   * also the `scan` tip's trigger.
   */
  #updateScanRing(world: CombatWorld, missions: Missions): void {
    let found: PoiRuntime | null = null;
    if (world.player.alive) {
      for (const state of this.#pois) {
        if (state.poi.kind !== 'scan' || !state.inside || state.scanned) continue;
        if (!this.#scanWanted(missions, state.poi.poi)) continue;
        found = state;
        break;
      }
    }
    if (found !== null && this.#scanState === null) this.#requestTip('scan');
    this.#scanState = found;
  }

  /** True while any active mission's current stage still wants this scan. */
  #scanWanted(missions: Missions, poi: PoiId): boolean {
    for (const state of missions.active) {
      for (const { objective, done } of missions.currentObjectives(state.id)) {
        if (objective.kind === 'scan' && !done && objective.poi === poi) return true;
      }
    }
    return false;
  }

  /**
   * §4.7 — the route lives exactly as long as stuck level 3 does, so every
   * reset of the tracker (progress, arrival, a new focus key) clears it
   * (AC-68). It is recomputed at most every 2 s, and only when the player has
   * left it or the target has moved.
   */
  #updateRoute(world: CombatWorld, dt: number, guidance: GuidanceLevel): void {
    const target = this.#focusTarget;
    if (guidance !== 'full' || this.#stuck.level < 3 || target === null) {
      this.#routeLength = 0;
      this.#routeIn = 0;
      return;
    }
    if (this.#routeLength >= 2) {
      this.#routeIn -= dt;
      if (this.#routeIn > 0) return;
      if (!this.#routeStale(world, target)) return;
    }
    this.#routeIn = ROUTE_INTERVAL;
    this.#routeTargetX = target.x;
    this.#routeTargetZ = target.z;
    const grid = this.#pathGrid;
    const found = grid === null ? 0 : findPath(grid, world.player.x, world.player.z, target.x, target.z, this.#route);
    if (found >= 2) {
      this.#routeLength = found;
      return;
    }
    // D-21 / 27-a: nothing was found — the straight segment still says which
    // way to set off, and the ground markers lay themselves along it.
    this.#route[0] = world.player.x;
    this.#route[1] = world.player.z;
    this.#route[2] = target.x;
    this.#route[3] = target.z;
    this.#routeLength = 2;
  }

  #routeStale(world: CombatWorld, target: GuideTarget): boolean {
    if (Math.hypot(target.x - this.#routeTargetX, target.z - this.#routeTargetZ) > ROUTE_TARGET_MOVED_METRES) return true;
    let nearest = Infinity;
    for (let i = 0; i < this.#routeLength; i++) {
      const dx = (this.#route[i * 2] as number) - world.player.x;
      const dz = (this.#route[i * 2 + 1] as number) - world.player.z;
      nearest = Math.min(nearest, Math.hypot(dx, dz));
    }
    return nearest > ROUTE_OFF_PATH_METRES;
  }

  /**
   * §4.11, each rendered frame: the waypoint on its inset ellipse, the scan
   * ring, and the view's pillar and route markers.
   */
  #renderGuidance(world: CombatWorld, view: SurfaceView): void {
    const settings = this.services.settings.get();
    const guidance = settings.guidance;
    const target = this.#focusTarget;
    const distance = this.#focusDistance;
    // A held beat or the full map owns the screen; nothing guidance draws may
    // sit over either (§4.3).
    const held = this.#uiHolds > 0 || this.#holds > 0;
    const pulse = this.#stuck.level >= 1;

    const waypoint = this.#waypoint;
    if (waypoint !== null) {
      if (target === null || distance === null || guidance === 'off' || !world.player.alive || held || distance <= target.radius) {
        waypoint.hide();
        this.#waypointState = 'off';
      } else {
        const behind = this.#projectGuide(target.x, target.z, WAYPOINT_LIFT);
        const cx = this.services.renderer.width / 2;
        const cy = this.services.renderer.height / 2;
        let sx = this.#screenPoint.x;
        let sy = this.#screenPoint.y;
        // A point behind the camera projects mirrored; put it back on the side
        // the target actually lies, then treat it as off-screen (§4.3).
        if (behind) {
          sx = cx - (sx - cx);
          sy = cy - (sy - cy);
        }
        const ax = Math.max(WAYPOINT_MIN_AXIS, cx - WAYPOINT_INSET);
        const by = Math.max(WAYPOINT_MIN_AXIS, cy - WAYPOINT_INSET);
        const dx = sx - cx;
        const dy = sy - cy;
        const norm = Math.hypot(dx / ax, dy / by);
        const onScreen = !behind && norm <= 1;
        if (!onScreen && norm > 0) {
          sx = cx + dx / norm;
          sy = cy + dy / norm;
        }
        waypoint.set(sx, sy, distance, onScreen, pulse);
        this.#waypointState = onScreen ? 'on' : 'edge';
      }
    }

    // D-5: the ring reports the player's own action, so it survives `off`.
    const ring = this.#scanRing;
    if (ring !== null) {
      const scan = this.#scanState;
      if (scan === null || !world.player.alive || held) ring.hide();
      else {
        this.#project(scan.poi.x, scan.poi.z, 1.2);
        ring.set(this.#screenPoint.x, this.#screenPoint.y, scan.scanFor / SCAN_SECONDS);
      }
    }

    // §4.4: the pillar stands on POIs and shelters only (AC-32).
    const frame = this.#guideFrame;
    const lit = target !== null && guidance !== 'off' && (target.kind === 'poi' || target.kind === 'shelter');
    if (lit && target !== null) {
      this.#beaconPoint.x = target.x;
      this.#beaconPoint.z = target.z;
    }
    frame.beacon = lit ? this.#beaconPoint : null;
    frame.route = this.#routeLength >= 2 ? this.#route : null;
    frame.routeLength = this.#routeLength;
    frame.pulse = !settings.reduceMotion;
    view.setGuide(frame);
  }

  /** Like `#project`, but reporting a point behind the camera (§4.3). */
  #projectGuide(x: number, z: number, lift: number): boolean {
    const v = this.#projectScratch.set(x, lift + (this.#view?.field.heightAt(x, z) ?? 0), z);
    v.applyMatrix4(this.camera.matrixWorldInverse);
    const behind = v.z >= 0;
    v.applyMatrix4(this.camera.projectionMatrix);
    this.#screenPoint.x = (v.x * 0.5 + 0.5) * this.services.renderer.width;
    this.#screenPoint.y = (-v.y * 0.5 + 0.5) * this.services.renderer.height;
    return behind;
  }

  /**
   * §4.2 — the tracker model: the tracked mission's stage, one row per
   * objective in stage order, and the focus row carrying today's wording so the
   * SPEC-012 selectors keep reading what they always read (D-3).
   */
  #feedTracker(missions: Missions): HudTracker {
    const tracker = this.#tracker;
    const rows = tracker.rows;
    rows.length = 0;
    tracker.distance = this.#focusDistance;
    tracker.bearing = this.#focusBearing;
    tracker.pulse = this.#stuck.level >= 1;
    const pinned = missions.pinned;
    if (pinned === null) {
      tracker.title = 'No active mission';
      tracker.stage = '';
      return tracker;
    }
    const def = MISSION_TABLE[pinned];
    const count = def.stages.length;
    const stage = this.#stageOf(missions, pinned);
    tracker.title = def.title;
    tracker.stage = `stage ${Math.min(count, Math.max(1, stage + 1))}/${count}`;
    for (let i = 0; i < this.#guideRows.length && i < this.#trackerRows.length; i++) {
      const progress = this.#guideRows[i] as ObjectiveProgress;
      const row = this.#trackerRows[i] as HudTrackerRow;
      row.done = progress.done;
      row.focus = i === this.#focusIndex;
      row.text = row.focus ? this.#focusRowText(def.title, progress) : this.#rowText(progress);
      rows.push(row);
    }
    // 27-p: between stages every row is done, and the focus row says so.
    if (this.#focusIndex < 0 && rows.length < this.#trackerRows.length) {
      const row = this.#trackerRows[rows.length] as HudTrackerRow;
      row.done = false;
      row.focus = true;
      row.text = `${def.title} — Stage complete`;
      rows.push(row);
    }
    return tracker;
  }

  /** D-3: the focus row keeps the wording the bottom-centre line used to have. */
  #focusRowText(title: string, progress: ObjectiveProgress): string {
    const line = this.#objectiveLine(progress.objective);
    if (progress.target > 1) return `${title} — ${line} (${Math.floor(progress.value)}/${progress.target})`;
    return `${title} — ${line}`;
  }

  /** §4.2's row table — the wording of every non-focus row. */
  #rowText(progress: ObjectiveProgress): string {
    const objective = progress.objective;
    const value = Math.floor(progress.value);
    switch (objective.kind) {
      case 'reach':
        return `Reach ${this.#poiLabel(objective.poi)}`;
      case 'scan':
        return objective.count > 1
          ? `Scan ${this.#poiLabel(objective.poi)} ${value}/${objective.count}`
          : `Scan ${this.#poiLabel(objective.poi)}`;
      case 'collect':
        return `Collect ${objective.resource} ${value}/${objective.amount}`;
      case 'kill':
        return `Hunt ${ENEMIES[objective.enemy].name} ${value}/${objective.amount}`;
      case 'boss':
        return `Defeat ${ENEMIES[objective.enemy].name}`;
      case 'survive':
        return `Survive ${Math.max(0, Math.ceil(objective.seconds - progress.value))} s`;
      case 'defend':
        return `Defend ${this.#poiLabel(objective.poi)} ${Math.max(0, Math.ceil(objective.seconds - progress.value))} s`;
      case 'deliver': {
        const held = (this.#save as Save).resources[objective.resource] ?? 0;
        const line = `Deliver ${objective.amount} ${objective.resource} to ${this.#poiLabel(objective.poi)}`;
        return held >= objective.amount ? line : `${line} — need ${objective.amount - held} more`;
      }
      case 'escort':
        return `Escort the ${FOLLOWERS[objective.follower].name} to ${this.#poiLabel(objective.to)}`;
      case 'choice':
        return 'Decide';
    }
  }

  /**
   * §4.9: a guidance change takes effect on the next frame, and nothing the new
   * level forbids is left on the screen behind it (27-t).
   */
  #onGuidanceChanged(): void {
    this.#routeLength = 0;
    this.#routeIn = 0;
    this.#tipQueue.length = 0;
    this.#pendingLine = null;
    this.#waypoint?.hide();
    this.#waypointState = 'off';
    const frame = this.#guideFrame;
    frame.beacon = null;
    frame.route = null;
    frame.routeLength = 0;
    this.#view?.setGuide(frame);
  }

  /** §4.6: the second death on one stage says something once (AC-69). */
  #onDeath(): void {
    this.#requestTip('death');
    const missions = this.#missions;
    if (missions === null) return;
    const pinned = missions.pinned;
    const key = `${pinned ?? 'none'}:${pinned === null ? 0 : this.#stageOf(missions, pinned)}`;
    const count = (this.#deathCounts.get(key) ?? 0) + 1;
    this.#deathCounts.set(key, count);
    if (count < 2 || this.#deathHinted.has(key)) return;
    if (this.services.settings.get().guidance !== 'full') return;
    this.#deathHinted.add(key);
    this.#queueLine(HINTS.death.nudge, HINT_MS);
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

  // ------------------------------------------------------------------ maps

  /**
   * SPEC-026 §4.3/§4.5: the one frame both maps read. Marks are pooled by
   * index and written in place, so a 4 Hz repaint allocates nothing.
   */
  #mapFrame(world: CombatWorld): MinimapFrame {
    const missions = this.#missions;
    const save = this.#save;
    const frame = this.#frame;
    frame.playerX = world.player.x;
    frame.playerZ = world.player.z;
    frame.facing = world.player.facing;
    this.#marks.length = 0;
    this.#minimapEnemies.length = 0;
    this.#arrows.length = 0;
    if (missions === null || save === null) return frame;

    // Which POIs the current objectives point at (rings and edge arrows).
    this.#objectivePois.clear();
    for (const state of missions.active) {
      for (const { objective, done } of missions.currentObjectives(state.id)) {
        if (done) continue;
        if ('poi' in objective) this.#objectivePois.add(objective.poi);
        if (objective.kind === 'escort') this.#objectivePois.add(objective.to);
        if (objective.kind === 'boss' && this.#arenaPoi !== null) this.#objectivePois.add(this.#arenaPoi.poi);
      }
    }

    // 26-a: a discovered POI shows even under still-dark ground, and an
    // objective POI shows whether or not it was ever discovered (26-b).
    for (const state of this.#pois) {
      const objective = this.#objectivePois.has(state.poi.poi);
      if (!state.discovered && !objective) continue;
      const mark = this.#nextMark();
      mark.x = state.poi.x;
      mark.z = state.poi.z;
      mark.icon = poiIcon(state.poi.kind);
      mark.objective = objective;
      // §4.5: the full map labels discovered POIs. A landmark is scenery
      // rather than a destination and carries none, and an objective POI the
      // player has never reached shows its icon and ring without naming the
      // place (26-b).
      mark.label = state.discovered && state.poi.kind !== 'landmark' ? this.#poiLabel(state.poi.poi) : null;
      mark.ring = state.poi.kind === 'arena' ? state.poi.radius : 0;
    }

    // §4.3 step 5: nodes with radar, and — SPEC-027 AC-38 — every node of the
    // resource the *tracked* mission is collecting, radar or not. The guidance
    // half goes away at `guidance: 'off'` (D-6); the radar half is a companion
    // the player paid for and stays whatever the guidance level says.
    const guided = this.services.settings.get().guidance !== 'off';
    const radar = hasNodeRadar(save);
    for (const node of (this.#nodes as Nodes).states) {
      if (!radar && !(guided && this.#collecting(missions, node.resource))) continue;
      const mark = this.#nextMark();
      mark.x = node.x;
      mark.z = node.z;
      mark.icon = nodeIcon(node.resource);
      mark.objective = false;
      mark.label = null;
      mark.ring = 0;
    }

    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.state === 'dead') continue;
      const mark = this.#nextEnemy();
      mark.x = e.x;
      mark.z = e.z;
      mark.kind = e.def.archetype === 'boss' ? 'boss' : e.elite ? 'elite' : 'enemy';
    }

    // SPEC-027 AC-39: a kill objective's quarry inside 60 m rides the minimap
    // as a rim arrow at its bearing. An arrow rather than an objective mark
    // because 60 m is inside the 70 m window, where a mark would always paint
    // as a ringed icon and never as the arrow the spec asks for; the painter
    // pins it to the rim itself (`mapRimPoint`). The quarry is a moving enemy,
    // so a direction to sweep is the honest affordance anyway — the enemy layer
    // still draws it exactly where it stands once inside 25 m.
    if (guided) {
      const wanted = missions.objectiveEnemies();
      if (wanted.length > 0) {
        for (let i = 0; i < world.enemies.size; i++) {
          const e = world.enemies.at(i);
          if (e.state === 'dead' || !wanted.includes(e.def.id as EnemyId)) continue;
          if (Math.hypot(e.x - world.player.x, e.z - world.player.z) > OBJECTIVE_ENEMY_RANGE) continue;
          const arrow = this.#nextArrow();
          arrow.x = e.x;
          arrow.z = e.z;
        }
      }
    }

    // SPEC-027 AC-41: the focus target and the route, for the painters SPEC-026
    // already ships (D-29). Both are guidance, so both go at `off`.
    const target = this.#focusTarget;
    if (guided && target !== null) {
      this.#targetPoint.x = target.x;
      this.#targetPoint.z = target.z;
      frame.target = this.#targetPoint;
    } else {
      frame.target = null;
    }
    frame.route = guided && this.#routeLength >= 2 ? this.#route : null;
    frame.routeLength = frame.route === null ? 0 : this.#routeLength;
    return frame;
  }

  /** The next pooled mark; the pool only ever grows to the busiest frame. */
  #nextMark(): MapMark {
    const at = this.#marks.length;
    let mark = this.#markPool[at];
    if (mark === undefined) {
      mark = { x: 0, z: 0, icon: 'landmark', objective: false, label: null, ring: 0 };
      this.#markPool.push(mark);
    }
    this.#marks.push(mark);
    return mark;
  }

  /** The same pooling for the minimap's rim arrows (SPEC-027 AC-39). */
  #nextArrow(): { x: number; z: number } {
    const at = this.#arrows.length;
    let arrow = this.#arrowPool[at];
    if (arrow === undefined) {
      arrow = { x: 0, z: 0 };
      this.#arrowPool.push(arrow);
    }
    this.#arrows.push(arrow);
    return arrow;
  }

  /** The same pooling for the enemy list, which turns over every repaint. */
  #nextEnemy(): { x: number; z: number; kind: 'enemy' | 'elite' | 'boss' } {
    const at = this.#minimapEnemies.length;
    let mark = this.#enemyPool[at];
    if (mark === undefined) {
      mark = { x: 0, z: 0, kind: 'enemy' as const };
      this.#enemyPool.push(mark);
    }
    this.#minimapEnemies.push(mark);
    return mark;
  }

  /**
   * True while the *tracked* mission's current stage is collecting this
   * resource (§4.3 step 5, SPEC-027 AC-38). Tracked rather than any active
   * mission, because SPEC-027 ties the guidance marks to the tracker: they go
   * when the objective is done, and they go when the mission is untracked.
   */
  #collecting(missions: Missions, resource: ResourceId): boolean {
    const pinned = missions.pinned;
    if (pinned === null) return false;
    for (const { objective, done } of missions.currentObjectives(pinned)) {
      if (objective.kind === 'collect' && !done && objective.resource === resource) return true;
    }
    return false;
  }

  #drawMinimap(world: CombatWorld): void {
    this.#minimap?.draw(this.#mapFrame(world));
  }

  /**
   * §4.4: light the ground under the player at 4 Hz, repaint only the squares
   * that changed, and hand the mask to the live save at most once a second.
   * The autosaves the game already makes are what carry it to storage.
   */
  #explore(world: CombatWorld, dt: number): void {
    const mask = this.#mask;
    const layers = this.#layers;
    if (mask === null || layers === null) return;
    this.#exploreIn -= dt;
    if (this.#exploreIn <= 0) {
      this.#exploreIn = EXPLORE_INTERVAL;
      if (world.player.alive) {
        const count = mask.reveal(world.player.x, world.player.z, this.#revealOut);
        if (count > 0) layers.reveal(this.#revealOut, count, EXPLORE_CELL);
      }
    }
    this.#exploreSaveIn -= dt;
    if (this.#exploreSaveIn <= 0) {
      this.#exploreSaveIn = EXPLORE_SAVE_INTERVAL;
      this.#writeMask();
    }
  }

  /** The mask into the live save, when it holds ground the save has not seen. */
  #writeMask(): void {
    const mask = this.#mask;
    const save = this.#save;
    if (mask === null || save === null || !mask.dirty) return;
    save.progress.explored[this.#planet.id] = mask.encode();
  }

  // ------------------------------------------------------------- full map

  /** §4.5: open the map, unless a modal dialogue or the pad terminal owns the screen (26-c). */
  #openMap(): void {
    const screen = this.#mapScreen;
    const world = this.#world;
    if (screen === null || world === null || screen.isOpen) return;
    // A modal dialogue, the pad terminal (26-c) and a held beat all own the
    // screen already; so does the death overlay, whose respawn clock runs in
    // the step the hold would stop (§4.8).
    if (this.#modalOpen > 0 || this.#terminalOpen || this.#holds > 0 || this.#deathAt !== null) return;
    this.#uiHolds++;
    // The hold zeroes velocity every step; this is the step it starts on.
    world.player.vx = 0;
    world.player.vz = 0;
    this.#touch?.hide();
    screen.open(this.#mapFrame(world), this.#mask?.fraction() ?? 0);
  }

  #closeMap(): void {
    const screen = this.#mapScreen;
    if (screen === null || !screen.isOpen) return;
    screen.close();
    this.#uiHolds = Math.max(0, this.#uiHolds - 1);
    this.#touch?.show('surface');
  }

  /** The side panel's rows: title, `Stage N/M`, the current objective line. */
  #mapMissions(): readonly MapMissionRow[] {
    const missions = this.#missions;
    this.#missionRows.length = 0;
    if (missions === null) return this.#missionRows;
    for (const state of missions.active) {
      const def = MISSION_TABLE[state.id];
      const next = missions.currentObjectives(state.id).find((o) => !o.done);
      this.#missionRows.push({
        id: state.id,
        title: def.title,
        stage: `Stage ${state.stage + 1}/${def.stages.length}`,
        line: next === undefined ? 'Stage complete' : this.#objectiveLine(next.objective),
        tracked: state.id === missions.pinned,
      });
    }
    return this.#missionRows;
  }

  /** A Track button pins its mission (E18) and the panel redraws around it. */
  #trackMission(id: MissionId): void {
    const world = this.#world;
    this.#missions?.pin(id);
    if (world === null) return;
    this.#mapScreen?.redraw(this.#mapFrame(world), this.#mask?.fraction() ?? 0);
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
          this.#onDeath(); // SPEC-027 §4.6: the first-death tip, the repeat hint
        },
        this,
      ),
      // SPEC-027 §4.5: the storm tip rides the ten-second warning itself.
      bus.on('weather:warning', () => this.#requestTip('storm'), this),
      // SPEC-028 §4.4: a pickup of an eligible item fills an empty or run-out
      // quick slot (28-f: a reward spilled on the ground fills it on pickup).
      bus.on(
        'inventory:changed',
        ({ itemId, qty }) => {
          const save = this.#save;
          if (qty > 0 && save !== null) fillQuickFromPickup(save, itemId);
        },
        this,
      ),
      // SPEC-027 §4.9: a guidance change takes effect on the next frame, and
      // nothing the new level forbids survives it (27-t).
      bus.on(
        'settings:changed',
        ({ patch }) => {
          if (patch.guidance !== undefined) this.#onGuidanceChanged();
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
      // SPEC-027 §4.6: progress on the tracked mission is progress, so the
      // escalation clock and any route it drew start over (AC-52).
      bus.on(
        'mission:progress',
        ({ id }) => {
          if (id === this.#missions?.pinned) this.#stuck.progress();
        },
        this,
      ),
      bus.on(
        'mission:stageStarted',
        ({ id, stage }) => {
          this.#syncMissionStages();
          if (id === this.#missions?.pinned) this.#stuck.progress();
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
