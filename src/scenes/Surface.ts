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
import { holdWakeLock } from '@/core/WakeLock';
import { DEFAULT_LOOK, type Look } from '@/core/Quality';
import {
  DEPOT_KEEP_STEP,
  EXPLORE_CELL,
  LINEAGE_CLAIM_PATTERN,
  lineageClaimId,
  newSave,
  type CharacterCreation,
  type LineageEntry,
  type Save,
} from '@/core/Save';
import { ZONES_SHOWN_MAX, type GuidanceLevel } from '@/core/Settings';
import type { GameServices } from '@/core/Services';
import { fadeMs, type SceneParams } from '@/core/StateMachine';
import type { Renderer } from '@/core/Renderer';
import type { Voice } from '@/core/Audio';
import type { InputState, Scheme } from '@/core/Input';
import type { PerfStress } from '@/core/Perf';
import type { Rng } from '@/core/Rng';
import {
  BELOW_HALF_SIZE,
  BOSS_REVEALS,
  CACHES,
  CAVE_ASSETS,
  CLASSES,
  CLUES,
  CONTRACT_IDS,
  CONTRACTS,
  DIALOGUE,
  DIFFICULTY_RULES,
  ENEMIES,
  FOLLOWERS,
  HINTS,
  HINT_PLACEHOLDERS,
  ITEMS,
  MISSIONS,
  MISSION_HINTS,
  PLANETS,
  RESOURCE_IDS,
  SURFACE_ASSETS,
  SURFACE_SHARED_ASSETS,
  TIPS,
  TUNING,
  UNDERGROUND,
  WAVES,
  type BossRevealDef,
  type CacheId,
  type CacheReward,
  type ClassPassive,
  type ClueDef,
  type ContractId,
  type Dialogue,
  type DialogueId,
  type EnemyId,
  type HintPlaceholder,
  type Item,
  type ItemId,
  type MissionBonus,
  type MissionDef,
  type MissionId,
  type PlanetDef,
  type PlanetId,
  type ExplosiveEffect,
  type LightEffect,
  type PoiId,
  type QuickSlot,
  type ResourceId,
  type ShotLook,
  type TipId,
  type UndergroundDef,
  type WaveId,
  type WeaponSlot,
  MESH_RECIPE_IDS,
  QUICK_SLOTS,
  WEAPON_SLOTS,
} from '@/data/index';
import { isBuried, makeEnemy, type EnemyEntity } from '@/entities/Enemy';
import { makeFollower } from '@/entities/Follower';
import { makePlayer } from '@/entities/Player';
import { makeProjectile } from '@/entities/Projectile';
import { resetTelegraph, TELEGRAPH_CAPACITY } from '@/entities/Telegraph';
import { ARENA_RESPAWN_OUTSET, clampToSeal, type ArenaState } from '@/entities/World';
import { ClueTracker, clueFound, FlagView, type ClueScene } from '@/systems/Clues';
import { Combat, computePlayerStats, ELITE_SCALE, staminaFull, type CombatWorld, type HitMemory } from '@/systems/Combat';
import { containment, containmentSteps } from '@/systems/Containment';
import { DASH_DISTANCE, dashCooldown, isDashing, pressDash, stepDash } from '@/systems/Dash';
import { Economy } from '@/systems/Economy';
import { seconds, stage as stageText } from '@/systems/Format';
import { EXPLORE_RADIUS_BELOW, ExploreMask, REVEAL_CAPACITY } from '@/systems/Exploration';
import {
  bearingWord,
  buildPathGrid,
  distanceText,
  exitTarget,
  fillHint,
  findPath,
  focusObjective,
  objectiveTarget,
  padTarget,
  PATH_MAX_POINTS,
  StuckTracker,
  tipDue,
  tipKey,
  type GuideContext,
  type GuidePoi,
  type GuideTarget,
  type PathGrid,
} from '@/systems/Guidance';
import { nearestInteractable, type Interactable } from '@/systems/Interactables';
import { fillQuickFromPickup, quickEligible, refillQuick, type SlotView } from '@/systems/Loadout';
import {
  featurePieces,
  generateLayout,
  ObstacleGrid,
  tugObstacle,
  WALL_INSET,
  type Layout,
  type LayoutPoi,
  type LayoutShelter,
} from '@/systems/Layout';
import { DARK_RIM_SCALE, DARK_SIGHT, lit } from '@/systems/Light';
import { isHidden, SHELTER_INSET, shelterAt, STORM_SHELTER_FACTOR } from '@/systems/Shelter';
import { nodeIcon, poiIcon } from '@/systems/MapModel';
import { contractFor, Missions, type MissionContext, type ObjectiveProgress } from '@/systems/Missions';
import { nodeEconomy, Nodes, Pickups, SHIPPED_TOAST_TEXT } from '@/systems/Pickups';
import { cumulativeXp, LEVEL_CAP, Progression, xpToNext } from '@/systems/Progression';
import {
  PREDECESSOR_SEARCH_RADIUS,
  REMAINS_RECOVER_RADIUS,
  REMAINS_RETRY_SECONDS,
  dropRemains,
  placeRemains,
  predecessorStart,
  predecessorTag,
  recoverRemains,
  remainsHeld,
  remainsLook,
  remainsTag,
  type RemainsLook,
} from '@/systems/Remains';
import { RECORDS } from '@/systems/Records';
import { watchRunStats } from '@/systems/RunStats';
import { SpawnDirector, WAVE_CEILING_BONUS, type FrustumXZ, type SpawnRamp, type WaveHandle } from '@/systems/Spawn';
import {
  isHolstered,
  isLoud,
  resetStamina,
  spend,
  SPRINT_MULT,
  SPRINT_NOISE,
  STAMINA_MAX,
  staminaRegen,
  stepStamina,
} from '@/systems/Stamina';
import {
  BELOW_LEASH,
  BELOW_MAX_ALIVE,
  descentPoint,
  descentShelter,
  generateUnderground,
  type UndergroundLayout,
} from '@/systems/Underground';
import { Weather, WEATHER_EFFECTS, type WeatherEffects } from '@/systems/Weather';
import { HOME_SESSION, restartLine } from '@/systems/Home';
import { LINE_LEDGER, missionLinePlays, revealCamera, revealDue, revealKey, stayReport, type Ending } from '@/systems/StoryBeats';
import { instanceNumber } from '@/systems/StoryContext';
import {
  activeEffects,
  affixLine,
  blockedText,
  bossPhaseMarks,
  cameraDistance,
  cameraFov,
  acceptedText,
  cacheRewardText,
  completionLines,
  contractLabel,
  darkFogRange,
  descentRefusal,
  deathCause,
  deliveryNeedsText,
  firstSentence,
  deathTip,
  hasNodeRadar,
  HP_FULL_TEXT,
  occludes,
  OCCLUDER_OPACITY,
  padEmptyText,
  pickupText,
  predecessorCacheText,
  quitNote,
  remainsFullText,
  remainsLostText,
  remainsOverlayLine,
  remainsRecoveredText,
  remainsTrackerText,
  resumedText,
  rewardsText,
  SEARCH_BODY_TEXT,
  SEARCHED_TEXT,
  shipHomeText,
  shippedHomeText,
  stageResetText,
  STAMINA_FULL_HIDE_SECONDS,
  STAMINA_FULL_TEXT,
  staminaShown,
  swatchUnlockedText,
  holdIsIdle,
  surfaceFogRange,
  surfaceHoldReason,
  walletLit,
  type CompletionLines,
  type HudEffect,
  type HudModel,
  type HudTracker,
  type HudTrackerRow,
  type SurfaceHold,
  type SurfaceHoldState,
} from '@/systems/UiHelpers';
import { UiScene } from '@/scenes/base';
import type { Level, LevelId, PoiState } from '@/scenes/surface/Level';
import { PuzzleSites } from '@/scenes/surface/PuzzleSites';
import { director } from '@/scenes/Director';
import { INSTANCES_PER_PART, setHostileRim } from '@/views/ProceduralMeshes';
import { layerFromAssets } from '@/views/ProceduralTextures';
import { bearingToward, echoBodySpot, SCAV_BODY_RADIUS, SCAV_PAD_OFFSET } from '@/views/ScavBody';
import {
  advanceViewTime,
  cameraBob,
  RESOURCE_COLORS,
  shakeOffset,
  stepLookAhead,
  stormOverlayOpacity,
  SurfaceView,
  type ShakeState,
} from '@/views/SurfaceView';
import { UndergroundView } from '@/views/UndergroundView';
import { AriaHint } from '@/ui/AriaHint';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { DamageNumbers } from '@/ui/DamageNumbers';
import { ELITE_PLATE_SLOTS, ElitePlates } from '@/ui/ElitePlates';
import { RemainsTag } from '@/ui/RemainsTag';
import { prepareSaveCard } from '@/ui/ShareCard';
import { DeathOverlay } from '@/ui/DeathOverlay';
import { dialogueLayer, type DialogueUI } from '@/ui/DialogueUI';
import { el, h, keepFocus, openModal, shortScreen, testId } from '@/ui/dom';
import { clearEndingOverlays, EndingOverlay } from '@/ui/EndingOverlay';
import { Hud } from '@/ui/Hud';
import { MapLayers } from '@/ui/MapLayers';
import { MissionBanner } from '@/ui/MissionBanner';
import { MapScreen, type MapMissionRow } from '@/ui/MapScreen';
import { Minimap, type MapMark, type MinimapFrame } from '@/ui/Minimap';
import { NOTES_UNSEEN } from '@/ui/NotesPanel';
import { PauseMenu, withComms } from '@/ui/PauseMenu';
import { openQuickPicker, type QuickChoice } from '@/ui/QuickPicker';
import { RevealOverlay } from '@/ui/RevealOverlay';
import { RotateOverlay } from '@/ui/RotateOverlay';

import { ScanRing } from '@/ui/ScanRing';
import { StaminaRing } from '@/ui/StaminaRing';
import { TouchControls } from '@/ui/TouchControls';
import { Waypoint } from '@/ui/Waypoint';

/**
 * §4.3 — the fixed camera. Its distance is SPEC-035 §4.2's, by input scheme and,
 * since SPEC-037 §4.7, by the screen's short side; its field of view is
 * SPEC-037's Hor+ `cameraFov`, so an upright tablet sees the sides of the fight.
 */
const CAMERA_PITCH = (55 * Math.PI) / 180;
const CAMERA_YAW = (45 * Math.PI) / 180;
/** SPEC-035 §4.2: how long the distance takes to ease after a scheme change. */
const CAMERA_DISTANCE_EASE_SECONDS = 0.4;

// --------------------------------------------------------- SPEC-035 §4.11

/** §4.11: the storm loop fades in and out over half a second. */
const STORM_LOOP_FADE_SECONDS = 0.5;

// --------------------------------------------------------- SPEC-035 §4.6

/** §4.6: a hit from on screen and inside this range draws no edge wedge. */
const HIT_DIR_NEAR_RANGE = 8;

// --------------------------------------------------------- SPEC-035 §4.7

/** §4.7: the ramp runs on the first world, until its tutorial mission is done. */
const RAMP_PLANET: PlanetId = 'cinder4';
const RAMP_MISSION: MissionId = 'c1_m1';
/** §4.7: the ambient field the ramp keeps, and the archetype it drops. */
const RAMP: SpawnRamp = { populationScale: 0.5, excludeArchetypes: ['rusher'] };
/** SPEC-043 §4.3: the `swarm` contract's ramp — half as many hostiles again, nobody excluded. */
const SWARM_RAMP: SpawnRamp = { populationScale: CONTRACTS.swarm.populationScale, excludeArchetypes: [] };

// --------------------------------------------------------- SPEC-035 §4.5

/** §4.5: only props this close to the player can be hiding it. */
const OCCLUDER_RANGE = 30;
/** §4.5: the occlusion test runs at 10 Hz, not every frame. */
const OCCLUDER_TEST_SECONDS = 0.1;
/** SPEC-046 §4.8: where `surface-goto-pad` stands the salvager, from the pad's centre toward the spawn. */
const GOTO_PAD_DISTANCE = 5;
/** Touch aim-drags point the shot this far ahead (matches SPEC-011's demo). */
const AIM_DRAG_DISTANCE = 12;

// --------------------------------------------------------- SPEC-048 §4.8

/** §4.8: the scavengers lie on Cinder-4 only — the pad's while its first mission runs. */
const SCAV_PLANET: PlanetId = 'cinder4';
const SCAV_PAD_MISSION: MissionId = 'c1_m1';
/** §4.8: the line whose start lays the second, identical body down. */
const SCAV_ECHO_LINE: DialogueId = 'c1_s2_echo';

/** §4.12: a POI within this range of the player becomes discovered. */
const DISCOVER_RANGE = 40;
/** Hands-free scan: this long inside a scan POI's radius (§7, SPEC-011 e2e). */
const SCAN_SECONDS = 3;

/** §4.8 — the death round trip. */
const DEATH_OVERLAY_SECONDS = 2.5;
/**
 * SPEC-042 §4.5: a fire or interact press respawns only once the overlay has
 * been up this long — a held trigger used to skip the cause unread.
 */
const DEATH_SKIP_GUARD_SECONDS = 1.0;
const DEATH_DESPAWN_RADIUS = 40;
/** SPEC-042 §4.6: how long `▲ Wave incoming` stays up, in scene seconds. */
const WAVE_LINE_SECONDS = 3;
/** SPEC-042 §4.9: the target frame shows an enemy hit inside this many seconds. */
const TARGET_WINDOW_SECONDS = 3;
/** SPEC-042 §4.11 (dev): `surface-hp-low` leaves this share of max HP. */
const HP_LOW_DEBUG_FRACTION = 0.15;
/** SPEC-042 §4.11 (dev): `surface-hit-elite` puts its elite this far ahead. */
const HIT_ELITE_DISTANCE = 8;

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
/** SPEC-059 §4.1.3: how long the resumed landing's toast stays up. */
const RESUMED_TOAST_MS = 6000;

// --------------------------------------------------------------- SPEC-054

/** §4.2: the descent's interact circle (m); the exit's and a cache's are the same (§4.8). */
const DESCENT_RADIUS = 1.5;
const EXIT_RADIUS = 1.5;
const CACHE_RADIUS = 1.5;
/** §4.2: the seal — the tutorial a descent waits for. */
const DESCENT_SEAL: MissionId = 'c1_m1';
/** §4.2 (E86): surface loot within this many metres of the player at a descent is said to be left. */
const LOOT_LEFT_RADIUS = 10;
const LOOT_LEFT_TEXT = 'Loot left behind';
/** §4.2, §4.8: the prompts the level's interactables raise. */
const DESCEND_TEXT = 'Descend';
const ASCEND_TEXT = 'Climb up';
const OPEN_CACHE_TEXT = 'Open cache';
const LOCKED_TEXT = 'Locked';
/** §4.8: the good toast a claimed cache raises, before its reward line. */
const CACHE_OPENED_TEXT = 'Cache opened';
/** §4.10: the full map's title below. */
const UNDERGROUND_TITLE = 'Underground';
/** §4.4: how long the first descent of a visit waits, behind its fade, for the cave kit. */
const CAVE_KIT_WAIT_MS = 1500;
/** §4.4: the fog cache's key below, where the storm's multiplier means nothing. */
const DARK_FOG_KEY = -2;
/** §4.12: Eden's machine room hums on the weather-loop channel at this volume. */
const HUM_VOLUME = 0.5;
/** §4.4: the cave's dust motes — `min(60, quality.maxParticles)`. */
const CAVE_DUST_MOTES = 60;
/** §4.14 (dev): `surface-goto-cache` stands the salvager this far from the cache, toward its room. */
const GOTO_CACHE_DISTANCE = 1;
/** §4.12 (dev): `surface-goto-vault` stands the salvager this far in front of what the vault holds. */
const GOTO_VAULT_DISTANCE = 3;
/** §4.11: what `poiAt` answers below — no POI is ever under a cave position. */
const NO_POIS: LayoutPoi[] = [];
/** The cave's empty POI states and node list, shared and never written. */
const NO_POI_STATES: readonly PoiState[] = Object.freeze([]);
const NO_NODE_STATES: Nodes['states'] = Object.freeze([]) as unknown as Nodes['states'];

// ------------------------------------------------------------- SPEC-028 §4.4
// Quick slots: the empty texts, the per-text toast throttle, and the tip clock.

const QUICK_EMPTY_TEXT: Readonly<Record<QuickSlot, string>> = {
  heal: 'No healing items',
  explosive: 'No explosives',
  utility: 'No utility items',
};
/** §4.4: each refusal text toasts at most once per 3 s. */
const QUICK_TOAST_SECONDS = 3;
/** SPEC-036 §4.6: a launcher tap with no charge left says so, through the same throttle. */
const LAUNCHER_RECHARGING_TEXT = 'Launcher recharging';
/** SPEC-038 §4.9: the dash tip rides the first telegraph drawn this close to the player. */
const DASH_TIP_RANGE = 25;
/** SPEC-038 §4.9: the windup kinds that draw a ground telegraph (SPEC-041 adds the boss kinds). */
const TELEGRAPH_WINDUPS: ReadonlySet<GameEvents['enemy:windup']['kind']> = new Set([
  'charge',
  'slam',
  'lines',
  'ring',
  'burrow',
]);
/** SPEC-041 §4.1: the boss moves that hit the ground — a dust ring and a shake where they land. */
const GROUND_MOVE_KINDS: ReadonlySet<GameEvents['boss:move']['kind']> = new Set([
  'slam_target',
  'slam_self',
  'lines',
  'ring',
  'burrow',
]);
/** SPEC-041 §4.1: the ground move's shake — 0.3 for 0.3 s; Camera shake scales it (SPEC-045 §4.3). */
const BOSS_MOVE_SHAKE_AMPLITUDE = 0.3;
const BOSS_MOVE_SHAKE_SECONDS = 0.3;
/** SPEC-041 §4.6: the mender's pulse ring. */
const MENDER_RING_COLOR = 0x6fdc8c;
/** SPEC-041 §4.6: plates show over live elites this close, lifted this far over the ground. */
const ELITE_PLATE_RANGE = 25;
const ELITE_PLATE_LIFT = 2.2;
/** SPEC-041 §4.10: the debug elite pack — four of the swarm species, 10 m ahead. */
const ELITE_PACK_SIZE = 4;
const ELITE_PACK_DISTANCE = 10;
/** SPEC-057 §4.6: the remains' tag shows within this many metres, lifted this far over the ground. */
const REMAINS_TAG_RANGE = 30;
const REMAINS_TAG_LIFT = 1.4;
/** SPEC-057 §4.7 (dev): `surface-goto-remains` stands the salvager this far from the remains, toward the pad. */
const GOTO_REMAINS_DISTANCE = 1;
/** SPEC-058 §4.5: the predecessor's body stands under a grey pillar — its map icon's grey. */
const PREDECESSOR_PILLAR = '#8f99a3';
/** SPEC-058 §3 (dev): `surface-goto-body` stands the salvager this far from the body, toward the pad. */
const GOTO_BODY_DISTANCE = 1;
/** SPEC-058 §4.5: what the map says the body is. */
const PREDECESSOR_LABEL = "A salvager's body";
/** SPEC-038 §4.11: the debug charger stands this far along the player's facing. */
const CHARGER_DISTANCE = 8;
/** SPEC-064 §4.5: `surface-spawn-raider` stands its raider this far in front of the player. */
const RAIDER_DISTANCE = 8;
/** SPEC-038 §4.1: the dash streaks' colour — the salvager's cool white. */
const DASH_STREAK_COLOR = 0xbfe6ff;
/** SPEC-050 §4.2: an in-combat sprint shorter than this is a short one (`sceneInfo.sprintsShort`). */
const SHORT_SPRINT_SECONDS = 0.5;
/** SPEC-050 §4.6: the stamina ring is placed off the salvager's head, this far above the ground. */
const STAMINA_HEAD_LIFT = 1.6;
/** SPEC-029 §4.8: any explosive use waits this long after the last. */
const EXPLOSIVE_USE_SECONDS = 0.5;
/** SPEC-029 §4.12: the blast camera shake. */
const BLAST_SHAKE_AMPLITUDE = 0.3;
const BLAST_SHAKE_SECONDS = 0.3;
/** SPEC-029 §4.12: the blast burst is authored at radius 3.5, the scorch at 1.6 m. */
const BLAST_BURST_BASE_RADIUS = 3.5;
const BLAST_SCORCH_BASE = 1.6;
const BLAST_COLOR = 0xffa040;
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

/** Player-hit shake and the heavy boss-phase shake (§4.7). */
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

/** SPEC-042 §4.1: a banner waiting on a modal `onComplete` chain, followed link by link. */
interface BannerChain {
  /** The chain's line on screen, or the one due to start next. */
  link: DialogueId;
  lines: CompletionLines;
  /** `link` has started — so the banner waits for its end. */
  started: boolean;
}

/**
 * SPEC-042 §4.9: the remembered enemy while the memory holds — hit inside
 * `TARGET_WINDOW_SECONDS`, still under the same spawn id (42-l), and alive.
 */
function remembered(memory: HitMemory, time: number): EnemyEntity | null {
  const e = memory.entity;
  if (e === null || time - memory.at > TARGET_WINDOW_SECONDS || e.id !== memory.id || e.state === 'dead') return null;
  return e;
}

/** `'#rrggbb'` → the number `CombatFx.burst` takes; no allocation. */
function hexColor(color: string): number {
  return Number.parseInt(color.slice(1), 16);
}

/** SPEC-019 §4.5: the muzzle flash in the last shot's colour, cached per look. */
const muzzleColors = new Map<ShotLook, number>();
function muzzleColor(look: ShotLook | null): number {
  if (look === null) return MUZZLE_COLOR;
  let color = muzzleColors.get(look);
  if (color === undefined) {
    color = hexColor(look.color);
    muzzleColors.set(look, color);
  }
  return color;
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

/** SPEC-016 D-21: the ring around the player a perf run's enemies are placed in (m). */
const PERF_SPAWN_MIN = 12;
const PERF_SPAWN_MAX = 24;
/** How far past the current step a perf run's immunity is kept, refreshed every step (s). */
const PERF_IMMUNE_AHEAD = 1;

/** SPEC-016 §8.2: a perf run's stress on this surface, while it runs. */
interface SurfaceStress {
  /** `quality.maxEnemies + WAVE_CEILING_BONUS`: the live enemies the run holds. */
  readonly ceiling: number;
  /** The visit stream's `fork('perf')`: where each enemy is placed. */
  readonly rng: Rng;
  /** The next row of `surface.spawn` to place, round-robin from row 0. */
  row: number;
  /** Combat's input for the run: the player's own, with auto-fire on. */
  readonly input: InputState;
}

/**
 * SPEC-016 §8.2: the player's own input, read live, with auto-fire on — built
 * once per run, so the step allocates nothing, and `settings.autoFire` is
 * never touched.
 */
function autoFireInput(real: InputState): InputState {
  return {
    get move() {
      return real.move;
    },
    get aim() {
      return real.aim;
    },
    get buttons() {
      return real.buttons;
    },
    get scheme() {
      return real.scheme;
    },
    autoFire: true,
  };
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
 * SPEC-040 §4.6 (PLAN R20 decision 1): how long `enter()` waits, behind the
 * transition's fade, for the planet's props and ground before it builds the
 * view — so a first landing, and a landing after the set was released, draw
 * the props from their GLBs. A set later than this swaps in through
 * `SurfaceView.setPropModels` (E72). *Initial tuning.*
 */
export const PROP_DROP_WAIT_MS = 1500;

/** Resolves when `promise` settles, or after `ms`, whichever is first; never rejects. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

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
  /**
   * SPEC-054 §4.1: the planet's surface, and the cave below it once this
   * visit has gone down; `#level` is the active one, which every read of the
   * layout, the POIs, the shelters, the nodes, the pad terminal, the mask, the
   * map layers and the clamp in the step goes through.
   */
  #levels: { surface: Level; underground: Level | null } | null = null;
  #level: Level | null = null;
  #world: CombatWorld | null = null;
  #combat: Combat | null = null;
  #economy: Economy | null = null;
  #missions: Missions | null = null;
  #spawn: SpawnDirector | null = null;
  #weather: Weather | null = null;
  #pickups: Pickups | null = null;
  #view: SurfaceView | null = null;
  #hud: Hud | null = null;
  #minimap: Minimap | null = null;
  // SPEC-026 — the full-screen map that holds the simulation while it is
  // open; the explored mask and the layers both maps draw are the level's.
  #mapScreen: MapScreen | null = null;
  #death: DeathOverlay | null = null;
  // SPEC-057 — the remains: the look chosen at entry (§4.6), the tag over them,
  // the placed point a death writes (§4.3), the reused record a recovery
  // writes into (§4.4), and the recovery's radius and retry clock (E93).
  #remainsLook: RemainsLook = 'pack';
  #remainsTag: RemainsTag | null = null;
  /** The remains lie on this surface, on the surface level — the view, the tag, the map and the tracker show them. */
  #remainsHere = false;
  readonly #remainsAt = { x: 0, z: 0 };
  readonly #remainsEntrance = { x: 0, z: 0, facing: 0 };
  /** E63's choice, made once at the death (`#placeRemains`) and kept for the respawn it decides. */
  #respawnAtArena = false;
  readonly #remainsTaken: Record<ResourceId, number> = { oil: 0, wheat: 0, water: 0, lithium: 0 };
  #remainsInside = false;
  #remainsRetryIn = 0;
  /** SPEC-057 §4.4 (B-21): the full hold was said on this stay inside the recovery circle. */
  #remainsFullSaid = false;
  /** The tracker row's text, rebuilt only when the whole metre changes. */
  #remainsRowText: string | null = null;
  #remainsRowMetres = -1;
  // SPEC-058 §4.5 — the predecessor's body: where it lies this visit (null:
  // nowhere on this planet), the lineage entry it is, its claim id, and its
  // own tag. Placed once at entry; the iteration and the lineage never change
  // mid-visit.
  #predecessor: { x: number; z: number; prior: LineageEntry; claim: string } | null = null;
  #predecessorTag: RemainsTag | null = null;
  #dialogue: DialogueUI | null = null;
  /** SPEC-042 §4.1: the mission banner, the top centre's last row. */
  #banner: MissionBanner | null = null;
  /**
   * SPEC-042 §4.1: banners waiting on a modal `onComplete` chain (`c5_m3`: the
   * Warden, then ARIA) — pushed when the chain's last line ends, or as soon as
   * one of its lines never starts (a `once` line already heard, a full queue).
   */
  readonly #chains: BannerChain[] = [];
  /** SPEC-042 §4.6: scene seconds `▲ Wave incoming` has left. */
  #waveLeft = 0;
  /** SPEC-042 §4.3: the three effect rows `activeEffects` writes into, made once. */
  readonly #effectPool: HudEffect[] = [
    { kind: 'heal', seconds: 0 },
    { kind: 'heal', seconds: 0 },
    { kind: 'heal', seconds: 0 },
  ];
  /** SPEC-042 §4.9: the one boss and target objects the HUD model is fed, reused every step. */
  readonly #bossScratch: NonNullable<HudModel['boss']> = { name: '', hp: 0, max: 1, phase: 1, marks: [] };
  readonly #targetScratch: NonNullable<HudModel['target']> = { name: '', elite: false, affixes: '', hp: 0, max: 1 };
  /** The spawn id the target scratch's name and affixes were written for. */
  #targetId = -1;
  /** SPEC-042 §4.5: a restarts line was set for this death — the pinned mission's wins. */
  #restartsSet = false;
  /** SPEC-042 §4.11 (dev): the elite `surface-hit-elite` hits on the next step, once the hash holds it. */
  #pendingHit: { entity: EnemyEntity; id: number } | null = null;
  #touch: TouchControls | null = null;
  #pauseMenu: PauseMenu | null = null;

  // SPEC-054 — the underground. The descent is derived from the surface's
  // shelters (§4.2); the cave, its view and the flashlight are built behind a
  // visit's first descent and kept for the visit (§4.3–§4.5, 54-d).
  #descent: { x: number; z: number; shelter: LayoutShelter } | null = null;
  #cave: UndergroundLayout | null = null;
  #caveDef: UndergroundDef = UNDERGROUND.cinder4;
  #caveView: UndergroundView | null = null;
  /** The surface's route grid, and the cave's — built once at the first descent (§4.10). */
  #surfaceGrid: PathGrid | null = null;
  #caveGrid: PathGrid | null = null;
  /** §4.2: true from a swap's start to its end — the `'level'` hold. */
  #swapping = false;
  /**
   * §4.2: true from a swap's change-over to the next draw. The `'level'` hold
   * paces at five frames a second (SPEC-040 §4.2), so without this the fade-in
   * could open on the level just left for up to 200 ms.
   */
  #swapUndrawn = false;
  /** §4.14 (dev): the debug strip's shortcuts for the surface only, and for below only. */
  readonly #debugAbove: HTMLElement[] = [];
  readonly #debugBelow: HTMLElement[] = [];
  /** §4.7: descents this visit — the `underground:<n>` fork the packs draw from. */
  #descents = 0;
  /** §4.5: the flashlight's state for the visit — on at its first descent. */
  #lightOn = true;
  /** §4.6: `CombatWorld.light` below — one object for the visit. */
  readonly #light = { on: true };
  /** §4.6: the hostile rim outside the lit cone below — one closure for the visit. */
  readonly #rimBelow = (e: EnemyEntity): number => {
    const world = this.#world;
    if (world === null) return 1;
    const p = world.player;
    return lit(p.x, p.z, p.facing, this.#lightOn, e.x, e.z) ? 1 : DARK_RIM_SCALE;
  };
  /** SPEC-054 §4.1: the active level's nodes — none below. */
  get #nodes(): Nodes | null {
    return this.#level?.nodes ?? null;
  }
  /** §4.4: the cave kit's load, started at the visit's first descent; `null` before. */
  #caveKit: Promise<void> | null = null;
  /** SPEC-055: the visit's puzzles — the relic above, the vault terminal and the world puzzle below. */
  #puzzles: PuzzleSites | null = null;
  /** SPEC-041 §4.4: the arena's radius — the ring, the seal and the entrance. */
  #arenaRadius = 0;
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
  /**
   * SPEC-044 §4.3: the open terminal's modal close — it removes the SPEC-036
   * §4.10 back-stack entry the modal carries and gives focus back.
   */
  #terminalModal: (() => void) | null = null;
  /** SPEC-044 §4.7: the offers whose whole brief the player has opened. */
  readonly #terminalBriefs = new Set<MissionId>();
  /** SPEC-036 §4.3: the rotate block, read every step. */
  #rotate: RotateOverlay | null = null;

  // SPEC-030 §4.5 — the shelter the player is inside, and the chip state.
  #insideShelter: LayoutShelter | null = null;
  #shelterState: 'none' | 'sheltered' | 'hidden' = 'none';
  #shelterDiscovered: boolean[] = [];

  // SPEC-048 §4.3, §4.8 — the clue tracker this visit feeds, the scene it
  // reads, and whether the echo's body is down yet (one per visit).
  #clues: ClueTracker | null = null;
  #clueScene: ClueScene | null = null;
  #echoBodyPlaced = false;

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
  /** SPEC-041 §4.6: the elite nameplates, and the nearest-first scratch that fills them. */
  #plates: ElitePlates | null = null;
  readonly #plateIndex = new Int32Array(ELITE_PLATE_SLOTS);
  readonly #plateDist = new Float64Array(ELITE_PLATE_SLOTS);
  /** `Alpha <name>` per species and the affix line per (a, b) pair — built once, never per frame. */
  readonly #plateNames = new Map<EnemyId, string>();
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
  /** The `palette.ground` burst colour, resolved once per planet. */
  #groundColor = 0xffffff;
  readonly #projectScratch = new THREE.Vector3();
  readonly #shakeScratch = new THREE.Vector3();
  /** The player's ground speed last frame — what the walk bob rides (SPEC-015 §9). */
  #camSpeed = 0;
  readonly #screenPoint = { x: 0, y: 0 };

  // SPEC-026 §4.6 — the UI hold. The full map takes one; while it is above
  // zero the fixed step runs the map's own presses and nothing else, so
  // `world.time` stands still and nothing can reach the player.
  #uiHolds = 0;
  /** SPEC-040 §4.2: `idle()`'s hold state, written in place — the pacer reads it every frame. */
  readonly #holdState: SurfaceHoldState = { beats: 0, rotate: false, ui: 0, modal: 0, level: false };
  #exploreIn = 0;
  #exploreSaveIn = EXPLORE_SAVE_INTERVAL;

  #music: 'surface_calm' | 'surface_combat' | 'boss' = 'surface_calm';
  #musicHold = 0;
  #minimapIn = 0;
  #touchHint: string | null = null;
  /** SPEC-037 §4.3: the interact prompt's reused result. */
  readonly #interactOut = { text: '', action: false };
  /** SPEC-037 §4.2: world time the wallet's counts last moved, and whether the baseline is in. */
  #walletChangedAt = -Infinity;
  #walletPrimed = false;

  // SPEC-038 §4.1 — the dash: a `qb-dash` click waiting for the next step,
  // how many dashes ran (sceneInfo), and the last one's cooldown (the ring).
  #dashQueued = false;
  #dashes = 0;
  #dashCooldown = 1;
  // SPEC-050 — the run: the keyboard toggle's latch, the value the touch
  // stick's ring last showed, the current sprint's start and whether it began
  // in combat, this visit's counts (sceneInfo), the player's speed over the
  // last step, how long the pool has sat full, and the ring by the head.
  #sprintLatch = false;
  #sprintShown = false;
  #sprintStartedAt = 0;
  #sprintInCombat = false;
  #sprints = 0;
  #sprintsShort = 0;
  #shots = 0;
  #speed = 0;
  /** Seconds the pool has sat full — a landing's has always been, so its ring starts hidden. */
  #staminaFullFor = STAMINA_FULL_HIDE_SECONDS;
  #staminaRing: StaminaRing | null = null;
  /** SPEC-050 §4.6: the one stamina object the HUD model is fed, reused every step. */
  readonly #staminaScratch: NonNullable<HudModel['stamina']> = {
    value: STAMINA_MAX,
    max: STAMINA_MAX,
    exhausted: false,
    sprinting: false,
    shown: false,
  };
  // SPEC-038 §4.5 — the storm wave of the current survive stage, keyed
  // `${mission}:${stage}:${wave}`, and its running handle (null while a death
  // has dismissed it and the respawn has not started it again).
  #stormKey: string | null = null;
  #storm: { mission: MissionId; stage: number; wave: WaveId } | null = null;
  #stormHandle: WaveHandle | null = null;

  /** The visit's runtime stream; a perf run forks its placements off it (SPEC-016 D-21). */
  #visitRng: Rng | null = null;
  /** SPEC-016 §8.2: the perf run's stress while it runs, else `null`. */
  #stress: SurfaceStress | null = null;

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
  readonly #loadoutScratch: { active: WeaponSlot; slots: Record<WeaponSlot, SlotView>; fallback: boolean } = {
    active: 'primary',
    fallback: false,
    slots: {
      sidearm: { itemId: null, state: 'empty', cd: 0, heat: 0, charges: 0, maxCharges: 0, cdSeconds: 0 },
      primary: { itemId: null, state: 'empty', cd: 0, heat: 0, charges: 0, maxCharges: 0, cdSeconds: 0 },
      heavy: { itemId: null, state: 'empty', cd: 0, heat: 0, charges: 0, maxCharges: 0, cdSeconds: 0 },
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
  /** SPEC-029 §4.8: world time the next explosive use is allowed. */
  #throwReadyAt = 0;
  /** SPEC-029 §4.8, SPEC-056 §4.5: where the last throw was aimed — `#throwTarget` writes it. */
  readonly #throwAt = { x: 0, z: 0 };
  /** SPEC-029 §4.13: scratch `SlotView` for the debug overlay reads. */
  readonly #debugSlotView: SlotView = { itemId: null, state: 'empty', cd: 0, heat: 0, charges: 0, maxCharges: 0, cdSeconds: 0 };

  // Defend/escort stages resync only when their identity changes — accepting
  // or completing an unrelated mission must not restart the wave or respawn
  // the follower (the adjudication round's nonblocking note).
  #defendKey: string | null = null;
  #escortKey: string | null = null;

  // Scratch buffers — reused every frame (SPEC-001 §7).
  readonly #aimScratch = new THREE.Vector3();
  readonly #aimPoint = { x: 0, z: 0 };
  /** SPEC-034 §4.1: the scratch the pre-step obstacle resolve writes into. */
  readonly #resolved = { x: 0, z: 0 };
  /** SPEC-034 §4.2: recalls taken this visit, and summons a boss death sent away. */
  #recalls = 0;
  /** SPEC-059 §4.1.3: entered from the menu on a resume point — no flight, no jump. */
  #resumed = false;
  #summonsDismissed = 0;
  /** SPEC-034 §4.12, 12-l: the resources the shipped-home toast has been said for since each last fit. */
  readonly #shippedWarned = new Set<ResourceId>();
  /** SPEC-034 §4.6: true while the next `#syncDefend` ends a *finished* defence. */
  #dismissDefendWave = false;
  /** SPEC-034 §4.8: the mission-level wave of each active mission that has one. */
  readonly #missionWaves = new Map<MissionId, WaveHandle>();
  readonly #camTarget = { x: 0, z: 0 };
  // SPEC-035 §4.2 — the camera's distance, by input scheme. It starts at the
  // target on entry and eases over 0.4 s when the scheme changes; pitch, yaw and
  // field of view are untouched.
  /** SPEC-035 §4.7: true while the first-landing ramp is in force. */
  #ramp = false;
  /**
   * SPEC-043 §4.3: the contract modifiers in force on this landing, each once,
   * in `CONTRACT_IDS` order — recomputed from `missions.activeContracts()` on
   * entry and on every accept, completion and abandon.
   */
  #contracts: ContractId[] = [];
  /** `elite_surge` in force: the director's `eliteMult` takes its ×4. */
  #eliteSurge = false;
  /** `no_cover` in force: shelters no longer keep the weather off. */
  #noCover = false;
  /** SPEC-043 §4.6: the last `mission:bonus` of each mission, for the banner it precedes. */
  readonly #judged = new Map<MissionId, { bonus: MissionBonus; earned: boolean }>();
  // SPEC-035 §4.11 — the storm loop. It is shipped and was never played; the
  // scene owns it, like the other continuous channels (SPEC-006 §4.2).
  #stormVoice: Voice | null = null;
  /** SPEC-054 §4.12: what the channel's voice plays — Eden's machine room hums on it below. */
  #stormSound: 'storm_loop' | 'film_hum' = 'storm_loop';
  #stormLoopVolume = 0;
  #stormLoopTarget = 0;
  #camDistance = 0;
  #camDistanceFrom = 0;
  #camDistanceTo = 0;
  #camEase = 1;
  /** SPEC-037 §4.7: the canvas's CSS size, from `renderer:resized` — the camera's screen. */
  #viewWidth = 1;
  #viewHeight = 1;
  // SPEC-035 §4.5 — the occluder flags, recomputed at 10 Hz over the view's own
  // candidate list. One buffer for the visit; nothing here allocates per frame.
  #occluderFlags = new Uint8Array(0);
  #occluderIn = 0;
  // SPEC-035 §4.4 — the last fog span pushed to the view, so the linear fog is
  // rewritten only when the storm or the camera distance actually moved.
  #fogMultApplied = -1;
  #fogCamApplied = -1;
  #fogNear = 0;
  readonly #frustum = new THREE.Frustum();
  /**
   * SPEC-046 §4.6: the camera `#frustum` was captured with — the look-at point
   * (the look-ahead included), the distance, the field of view and the aspect —
   * handed to `SurfaceView.setView` on the next render, never inside a step.
   */
  readonly #frustumView = { x: 0, z: 0, distance: 0, fov: 0, aspect: 1 };
  /** The look-ahead the camera was last placed with — `render()` re-places it after a resize. */
  readonly #camBias = { x: 0, z: 0 };
  /** The eased look-ahead `#followCamera` walks toward the player's heading (`stepLookAhead`). */
  readonly #camLead = { x: 0, z: 0 };
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
  #scanState: PoiState | null = null;
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
    remains: null,
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

  /** SPEC-040 §4.6: the planet's set, loading since `enter()`; `null` before it. */
  #planetAssets: Promise<void> | null = null;
  /** SPEC-053 §4.10 (dev): the trunk `surface-goto-grove` last stood the salvager beside — `sceneInfo.groveX/Z/R`. */
  #groveTree: { x: number; z: number; radius: number } | null = null;
  /** SPEC-053 §4.1.2: `SurfaceFrame.screen`, one object rewritten every rendered frame. */
  readonly #screenFrame: { camera: THREE.PerspectiveCamera; width: number; height: number } = {
    camera: this.camera,
    width: 0,
    height: 0,
  };

  constructor(services: GameServices) {
    super(services, 'surface', 'surface_calm');
  }

  /**
   * SPEC-040 §4.6: the planet's set starts loading before anything is built,
   * and the view waits up to `PROP_DROP_WAIT_MS` for it. The state machine
   * awaits `enter()` behind its fade, so the wait is hidden; a set from the
   * worker's cache lands in well under a second.
   */
  override async enter(params: SceneParams['surface']): Promise<void> {
    const load = this.#loadPlanetAssets(PLANETS[params.planet]);
    await settleWithin(load, PROP_DROP_WAIT_MS);
    super.enter(params);
  }

  /**
   * SPEC-018 §4.10: the lazy per-planet drop, merged with the shared surface
   * set (SPEC-019 §4.8: the probe rides along; boot stays five files). Started
   * once per visit. SPEC-040 §4.6: the planet's own set leaves with the
   * planet — the release is registered first, so the disposer's reverse order
   * runs it last, after the view and every mesh are gone, and it waits out a
   * load still in flight (40-i). `SURFACE_SHARED_ASSETS` is never released.
   */
  #loadPlanetAssets(planet: PlanetDef): Promise<void> {
    if (this.#planetAssets !== null) return this.#planetAssets;
    const assets = this.services.assets;
    const surfaceAssets = SURFACE_ASSETS[planet.biome];
    this.disposer.add(() => void assets.release(surfaceAssets));
    // SPEC-054 §4.4: the cave kit, if a descent loaded it, leaves with the planet's set.
    this.disposer.add(() => {
      if (this.#caveKit !== null) void assets.release(CAVE_ASSETS);
      this.#caveKit = null;
    });
    // SPEC-055 §4.1: the relic terminal's `cave_terminal` loads with the
    // surface's lazy set, and leaves with it; so does the descent's mouth,
    // SPEC-054 §4.2's `cave_shaft`.
    const terminal = {
      models: { cave_terminal: CAVE_ASSETS.models.cave_terminal, cave_shaft: CAVE_ASSETS.models.cave_shaft },
      textures: {},
    };
    this.disposer.add(() => void assets.release(terminal));
    // SPEC-053 §4.1: the shared set's atlas and detail normal ride along.
    this.#planetAssets = assets.load({
      models: { ...surfaceAssets.models, ...SURFACE_SHARED_ASSETS.models, ...terminal.models },
      textures: { ...surfaceAssets.textures, ...SURFACE_SHARED_ASSETS.textures },
      audio: {},
    });
    return this.#planetAssets;
  }

  protected override look(): Partial<Look> {
    const base = this.#view?.look ?? {};
    if (this.#level?.id !== 'underground') return base;
    // SPEC-054 §4.4: below, the dark look's grade — `lift` reaches `uLift`.
    const grade = this.#caveDef.look.grade;
    return {
      ...base,
      exposure: grade.exposure,
      bloomThreshold: grade.bloomThreshold,
      bloomStrength: grade.bloomStrength,
      vignette: grade.vignette,
      grain: grade.grain,
      lift: [grade.lift[0], grade.lift[1], grade.lift[2]],
    };
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
    const visits = (save.progress.visits[planet.id] ?? 0) + 1;
    save.progress.visits[planet.id] = visits;
    // SPEC-058 §4.4: a later instance's visits run on streams of their own.
    const visit = services.rng.visit(planet.id, visits, save.meta.iteration);
    this.#visitRng = visit;
    this.disposer.add(() => {
      this.#stress = null;
      this.#visitRng = null;
    });

    save.progress.location = 'surface';
    save.progress.currentPlanet = planet.id;
    // SPEC-059 §4.1.1: the resume point, so the landing save carries it — a
    // crash with no later write still lands the next Continue on this pad.
    this.#resumed = params.resumed === true;
    this.#markResume();

    // SPEC-046 §4.8: the combat world's grid holds the parked tug's hull too —
    // the layout, its hash, the map and the route grid never see it (46-l).
    const grid = new ObstacleGrid({ obstacles: [...layout.obstacles, tugObstacle(layout)], halfSize: layout.halfSize });

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
      // SPEC-030 §4.7: enemies, the follower and shots stop at the wall line.
      bounds: layout.halfSize - WALL_INSET,
    };
    world.player.facing = layout.playerSpawn.facing;
    this.#world = world;

    const bus = services.events as EventBus<GameEvents>;
    // SPEC-047 §4.5: this run's counts, ahead of every other subscriber, so a
    // death reads the salvager where they fell. SPEC-057 §4.3: where they fell
    // is where the remains lie — the placed point — so `lastDeath` and the
    // remains agree; the scene's own `player:died` reads the same point.
    this.disposer.add(
      watchRunStats(bus, save, this, () => {
        this.#placeRemains(world);
        return { planet: planet.id, x: this.#remainsAt.x, z: this.#remainsAt.z };
      }),
    );
    const progression = new Progression(save, bus);
    const economy = new Economy(save, bus, progression, services.save);
    // SPEC-032 §4.7: the service override, kept in step with the setting.
    economy.serviceMode = services.settings.serviceMode;
    this.disposer.add(
      bus.on(
        'settings:changed',
        ({ patch }) => {
          if (patch.serviceMode !== undefined) economy.serviceMode = patch.serviceMode;
        },
        this,
      ),
    );
    this.#economy = economy;
    const combat = new Combat(world, save, economy, progression, bus, {
      loot: visit.fork('loot'),
      ai: visit.fork('ai'),
      combat: visit.fork('combat'),
    });
    // SPEC-029 §4.4: combat mirrors the auto-swap setting (kept live in
    // #subscribe); the deployables pool dies with the combat instance (29-e).
    combat.weaponAutoSwap = services.settings.get().weaponAutoSwap;
    this.#combat = combat;
    this.disposer.add(() => combat.dispose());

    // SPEC-048 §4.3: the clue tracker subscribes before the missions do, so the
    // kill that completes a kill clue's mission still counts as made during it.
    this.#watchClues(save, layout, planet.id);

    // §4.1 step 4: the runtimes.
    const missions = new Missions(save, economy, bus, 'surface', planet.id, services.save);
    this.#missions = missions;
    this.disposer.add(() => missions.dispose());

    const spawn = new SpawnDirector(planet, layout, world.enemies, services.renderer.quality, visit.fork('spawn'), bus, combat);
    // SPEC-058 §4.4: the instance's containment adds to every ambient elite roll.
    spawn.eliteBonus = containment(save.meta.iteration).eliteBonus;
    spawn.setObstacles(grid);
    spawn.setObjectiveEnemies(missions.objectiveEnemies());
    this.#spawn = spawn;

    // SPEC-043 §4.3: a landing that starts under `storm_front` starts on a short calm.
    const stormFront = missions.activeContracts().includes('storm_front');
    const weather = new Weather(planet, visit.fork('weather'), bus, stormFront ? CONTRACTS.storm_front.calmScale : 1);
    this.#weather = weather;

    // SPEC-035 §4.7: the first landing on Cinder-4 ramps in — half the ambient
    // population, no rushers among them, and a weather cycle held in calm. It
    // ends with `c1_m1`, so it is observable and saved (35-e, 35-f).
    // SPEC-058 §4.4: on a first run only — a next instance has done this before.
    this.#ramp =
      save.meta.iteration === 1 &&
      planet.id === RAMP_PLANET &&
      !(save.progress.missionsDone as readonly string[]).includes(RAMP_MISSION);
    this.#applyRamp();
    // SPEC-043 §4.3: the contracts this landing's replays run as.
    this.#applyContracts();

    const pickups = new Pickups(economy, bus);
    this.#pickups = pickups;
    const regenOf = (resource: ResourceId): number =>
      planet.surface.nodes.find((n) => n.resource === resource)?.regenPerSec ?? 0;
    // SPEC-034 §4.12: through the shared wiring, so the collect demand reaches
    // the nodes and a full hold keeps pumping while an objective wants more.
    const nodes = new Nodes(layout.nodes, regenOf, nodeEconomy(economy, save));

    // POI runtime state; discovery restores from the save (§4.12).
    const pois: PoiState[] = layout.pois.map((poi) => ({
      poi,
      discovered:
        poi.kind === 'landing_pad' ||
        save.progress.poisDiscovered.includes(`${planet.id}:${poi.poi}:${poi.instance}`),
      inside: false,
      scanFor: 0,
      scanned: false,
    }));
    const pad = layout.pois.find((p) => p.kind === 'landing_pad') ?? null;
    const arena = layout.pois.find((p) => p.kind === 'arena') ?? null;
    // SPEC-041 §4.4: the fight's ring is the planet's arena — its POI's own
    // radius (Cinder-4's nest 20, the Queen's chamber 22) — not the layout's
    // placement footprint, which is 22 for every arena.
    this.#arenaRadius = planet.surface.pois.find((p) => p.kind === 'arena')?.radius ?? arena?.radius ?? 0;

    // SPEC-054 §4.2: the descent, derived from the shelters — never placed, so
    // no layout hash moves. A seed with no shelter has no underground (E87).
    const shelter = descentShelter(layout);
    this.#descent = shelter === null ? null : { ...descentPoint(shelter), shelter };
    this.#caveDef = UNDERGROUND[planet.id];

    // SPEC-026 §4.4: the explored mask comes off the save (SPEC-025 has
    // already dropped one of the wrong length, E37), and the two cached layers
    // are built from the layout.
    const mask = new ExploreMask(layout.halfSize, save.progress.explored[planet.id]);
    const layers = new MapLayers(layout, planet.surface.palette);

    // SPEC-054 §4.1: the surface level. The pad terminal is the `pad`
    // interactable, at the pad's radius, beside the descent.
    const interactables: Interactable[] = [];
    if (pad !== null) interactables.push({ kind: 'pad', id: 'pad', x: pad.x, z: pad.z, radius: pad.radius });
    const descent = this.#descent;
    if (descent !== null) interactables.push({ kind: 'descent', id: 'descent', x: descent.x, z: descent.z, radius: DESCENT_RADIUS });
    const surfaceLevel: Level = {
      id: 'surface',
      layout,
      grid,
      bounds: layout.halfSize - WALL_INSET,
      pois,
      shelters: layout.shelters,
      nodes,
      terminal: pad === null ? null : { x: pad.x, z: pad.z, radius: pad.radius },
      interactables,
      mask,
      layers,
      pad,
      arena,
    };
    this.#levels = { surface: surfaceLevel, underground: null };
    this.#level = surfaceLevel;
    // SPEC-058 §4.5: where the predecessor's body lies, and its search circle.
    this.#placePredecessor(save, planet.id, layout, grid, pad, interactables);
    this.disposer.add(() => {
      this.#levels = null;
      this.#level = null;
    });

    // SPEC-030 §4.10: shelter discovery restores from the save like POIs.
    this.#insideShelter = null;
    this.#shelterState = 'none';
    this.#shelterDiscovered = layout.shelters.map((s) =>
      save.progress.poisDiscovered.includes(`${planet.id}:shelter:${s.index}`),
    );

    // The mission context: one object for the scene's lifetime; `#missionCtx`
    // refreshes the player/follower snapshots in place each step.
    // SPEC-054 §4.11: both POI questions read the active level — below there
    // is no POI, so a cave position at a surface POI's coordinates reaches
    // nothing.
    this.#ctx = {
      player: this.#ctxPlayer,
      level: 'surface',
      poiAt: (id: PoiId) => (this.#level?.id !== 'surface' ? NO_POIS : layout.pois.filter((p) => p.poi === id)),
      heldResource: (r: ResourceId) => save.resources[r] ?? 0,
      nearPoi: (id: PoiId, radius?: number) => {
        if (this.#level?.id !== 'surface') return null;
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
    // SPEC-054 §4.2: a shaft mouth marks the descent, glowing in the colour of the cave below.
    view.setDescent(this.#descent, this.#caveDef.look.beacons.color);
    // SPEC-057 §4.6: the look is chosen here, at entry — a reveal mid-visit
    // changes it from the next landing on (57-g).
    this.#remainsLook = remainsLook(save);
    // SPEC-054 §4.4: the cave's view hangs under the view's root; it goes first.
    this.disposer.add(() => {
      this.#caveView?.dispose();
      this.#caveView = null;
      this.#cave = null;
    });
    // SPEC-055 §4.1: the visit's puzzles. Their views hang under the view's
    // root too, and go before it; the relic terminal joins the surface level.
    const puzzles = new PuzzleSites(
      {
        services,
        ui: this.ui,
        planet,
        save,
        economy,
        viewRoot: view.levelRoot,
        holdUi: (on) => this.#puzzleHold(on),
        free: () => this.#puzzleFree(),
        ariaLine: (text, ms) => this.#aria?.show(text, ms),
        cacheOpened: (cache, x, z, reward) => this.#cacheOpened(cache, x, z, reward),
        player: () => this.#world?.player ?? null,
        level: () => this.#level?.id ?? 'surface',
        lightOn: () => this.#level?.id === 'underground' && this.#lightOn,
        teleport: (x, z, facing) => this.#teleport(x, z, facing),
      },
      layout,
    );
    this.#puzzles = puzzles;
    interactables.push(...puzzles.surfaceInteractables());
    this.disposer.add(() => {
      puzzles.dispose();
      this.#puzzles = null;
    });
    this.#placePadBody(save, planet.id);
    // SPEC-058 §4.5: the predecessor's body, in its own colours, under the grey pillar.
    this.#syncPredecessor();
    // SPEC-045 §4.5: every hostile rim and non-elite telegraph reads one shared
    // uniform, set from the Colours preset now and on each change of it — the
    // next frame shows it, and no shader compiles (45-n).
    setHostileRim(services.settings.get().colourPreset);
    this.disposer.add(
      services.events.on(
        'settings:changed',
        ({ patch }) => {
          if (patch.colourPreset !== undefined) setHostileRim(patch.colourPreset);
        },
        this,
      ),
    );
    this.#groundColor = hexColor(planet.surface.palette.ground);

    // SPEC-018 §4.10: the lazy per-planet drop `enter()` started and waited
    // for. When it settles — at once if it already has — the ground takes its
    // textures and, SPEC-040 §4.6 (E72), any prop kind still drawing its
    // stand-in takes its GLB. The `.then` checks disposal before touching the
    // view (18-m); a set that fails keeps the stand-ins, with the warning.
    const surfaceAssets = SURFACE_ASSETS[planet.biome];
    {
      let disposed = false;
      this.disposer.add(() => {
        disposed = true;
      });
      void this.#loadPlanetAssets(planet)
        .then(() => {
          if (disposed) return;
          view.setPropModels(services.assets);
          this.#puzzles?.onAssets();
          if (Object.keys(surfaceAssets.textures).length === 0) return;
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
      services.events.on(
        'renderer:resized',
        () => {
          const mode = view.flashlightMode;
          view.applyQuality(services.renderer.quality);
          // SPEC-054 54-g: a flashlight rebuilt in the preset's mode may have
          // moved the light count — the programs recompile now, as at the
          // first descent, rather than at the next draw.
          if (mode !== null && view.flashlightMode !== mode) services.renderer.gl.compile(this.scene, this.camera);
        },
        this,
      ),
    );
    this.props = this.scene.children.length;

    // §4.3: the fixed perspective camera. SPEC-037 §4.7: its field of view and
    // distance follow the screen — set now, and again on every resize.
    this.#viewWidth = services.renderer.width;
    this.#viewHeight = services.renderer.height;
    // SPEC-053 §4.1.2: the scene's draw target in device pixels — the space of
    // `gl_FragCoord` the cut-out works in — now and on every resize (53-m).
    const size = services.renderer.size;
    this.#screenFrame.width = Math.round(size.width * size.dpr);
    this.#screenFrame.height = Math.round(size.height * size.dpr);
    this.camera.fov = cameraFov(this.#viewWidth / this.#viewHeight);
    // The base render sets the same on every frame; the first frustum — and
    // SPEC-046's first cull — already needs it.
    this.camera.aspect = this.#viewWidth / this.#viewHeight;
    this.camera.near = 1;
    this.camera.far = services.renderer.quality.drawDistance + 40;
    this.camera.updateProjectionMatrix();
    this.#camTarget.x = world.player.x;
    this.#camTarget.z = world.player.z;
    // SPEC-035 §4.2: the distance starts at the current scheme's, not eased in.
    this.#setCameraScheme(services.input.state.scheme, true);
    this.disposer.add(
      services.events.on(
        'renderer:resized',
        ({ width, height, dpr }) => {
          // SPEC-037 §4.7: the field of view snaps; the distance eases as a
          // scheme change does (and snaps under reduce motion).
          this.#viewWidth = width;
          this.#viewHeight = height;
          this.#screenFrame.width = Math.round(width * dpr);
          this.#screenFrame.height = Math.round(height * dpr);
          const fov = cameraFov(width / height);
          // The base render sets the aspect too, a frame later; SPEC-046's
          // cull recaptures the frustum as soon as the projection moves.
          const aspect = width / height;
          if (fov !== this.camera.fov || aspect !== this.camera.aspect) {
            this.camera.fov = fov;
            this.camera.aspect = aspect;
            this.camera.updateProjectionMatrix();
          }
          this.#setCameraScheme(this.services.input.state.scheme, false);
        },
        this,
      ),
    );
    this.#placeCamera(0, 0);
    // SPEC-035 §4.4: the linear fog's first span, before the first render.
    this.#applyFog();

    // The SPEC-014 UI layer (§4.12): shared HUD, overlays, touch, pause.
    // SPEC-027 AC-22: a tap on the tracker cycles the tracked mission, exactly
    // as `KeyT` does — the HUD owns the element, the runtime owns the pin.
    // SPEC-028 §4.3/§4.5: the quick bar's taps arrive as commands through the
    // fixed ring and are drained at the start of the next fixed step; the key
    // hints and the 56 px touch sizing follow the live scheme.
    const hud = new Hud(this.ui, 'surface', () => missions.cyclePinned(), {
      slot: (slot) => this.#pushQuickBar('slot', slot),
      pick: (slot) => this.#pushQuickBar('pick', slot),
      // SPEC-038 §4.1: a click on `qb-dash` dashes on the next step, as V does.
      dash: () => {
        this.#dashQueued = true;
      },
    });
    this.#hud = hud;
    this.disposer.add(() => hud.dispose());
    // SPEC-042 §4.7: the level before the first flush, so a landing never glows.
    hud.model.level = save.player.level;
    hud.setScheme(services.input.state.scheme);
    // SPEC-037 §4.1, §4.6: the arc's side and the flash's strength, from the
    // settings on entry and live after (37-b).
    hud.setSide(services.settings.joystickSide);
    hud.setDamageFlash(services.settings.get().damageFlash);
    this.disposer.add(
      services.events.on(
        'input:schemeChanged',
        ({ scheme }) => {
          hud.setScheme(scheme);
          // SPEC-037 §4.2: the minimap changed corners and sizes; its backing
          // store is measured off its new box (37-a).
          this.#minimap?.measure();
          // SPEC-035 §4.2: a touch laptop flipping mid-fight eases (35-a).
          this.#setCameraScheme(scheme, false);
        },
        this,
      ),
    );
    this.disposer.add(
      services.events.on(
        'settings:changed',
        ({ patch }) => {
          if (patch.joystickSide !== undefined) hud.setSide(patch.joystickSide);
          if (patch.damageFlash !== undefined) hud.setDamageFlash(patch.damageFlash);
          // SPEC-045 §4.4: a new UI scale redraws the minimap's corner at a new
          // size (`main.ts`, subscribed at boot, has already written
          // `--ui-scale`), so its backing store is measured off the new box.
          if (patch.uiScale !== undefined) this.#minimap?.measure();
        },
        this,
      ),
    );
    // SPEC-037 §4.3: `<html data-play="surface">` is what the in-play layout —
    // the toast dock, the short-screen dialogue, the hidden build label — and
    // SPEC-040 read. The scene that sets it takes it away.
    document.documentElement.dataset['play'] = 'surface';
    this.disposer.add(() => {
      delete document.documentElement.dataset['play'];
    });
    // SPEC-037 §4.3: a toast hold never outlives the scene that took it.
    this.disposer.add(() => this.ui.holdToasts(false));
    // §4.6: a picker still open when the scene goes releases its hold with it.
    this.disposer.add(() => this.#pickerClose?.());

    // SPEC-027 §4.11: the guidance layer over the canvas, the search grid the
    // route is found on, and the context the pure module reads. The context is
    // built once and refreshed in place every step (SPEC-001 §7).
    this.#buildGuidance(world, save, layout);

    // SPEC-026 §4.4: the ground under the landing spot is lit.
    mask.reveal(world.player.x, world.player.z, this.#revealOut);
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
      predecessor: this.#predecessor !== null,
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
    // SPEC-041 §4.6: the elite nameplates, pooled in the same HUD layer.
    const plates = new ElitePlates(dmgLayer);
    this.#plates = plates;
    this.disposer.add(() => {
      plates.dispose();
      this.#plates = null;
    });
    // SPEC-057 §4.6: the remains' tag, in the same layer.
    const remainsTagView = new RemainsTag(dmgLayer);
    this.#remainsTag = remainsTagView;
    this.disposer.add(() => {
      remainsTagView.dispose();
      this.#remainsTag = null;
    });
    // SPEC-058 §4.5: the predecessor's own tag, in the same style (58-f).
    const predecessor = this.#predecessor;
    if (predecessor !== null) {
      const tag = new RemainsTag(dmgLayer, 'predecessor-tag');
      tag.setText(predecessorTag(predecessor.prior));
      this.#predecessorTag = tag;
      this.disposer.add(() => {
        tag.dispose();
        this.#predecessorTag = null;
      });
    }
    // SPEC-050 §4.6: the stamina ring beside the salvager's head, on both
    // schemes, in a layer of its own so it can fade.
    const staminaLayer = el('div', 'stamina-layer');
    this.ui.mount(staminaLayer, 'hud');
    const staminaRing = new StaminaRing(staminaLayer);
    this.#staminaRing = staminaRing;
    this.disposer.add(() => {
      staminaRing.dispose();
      this.ui.unmount(staminaLayer);
      this.#staminaRing = null;
      // §4.5: the toggle's latch never outlives the scene.
      this.#sprintLatch = false;
    });

    const death = new DeathOverlay(services.uiRoot);
    this.#death = death;
    this.disposer.add(() => death.dispose());
    const touch = new TouchControls(services.uiRoot, services.input, services.settings);
    touch.show('surface');
    // SPEC-037 §4.1: USE lives in the thumb arc's action cell, under the layer's
    // rules; SPEC-038 §4.1 puts DASH in its corner cell the same way.
    if (hud.arc !== null) {
      touch.mountButton('interact', hud.arc.action);
      touch.mountButton('dash', hud.arc.primary);
      // SPEC-054 §4.5: LIGHT shares the action cell — shown below while USE is hidden.
      touch.mountButton('light', hud.arc.action);
    }
    touch.setLightAvailable(false);
    this.#touch = touch;
    this.disposer.add(() => touch.dispose());
    // SPEC-034 §4.2: the surface's way out of a corner. The flight menu never
    // passes one — there, Save & Quit and E5's recall already cover it.
    // SPEC-044 §4.8: Save & Quit says what it costs — Continue lands at the
    // station, so the way back here is the jump's fuel.
    const pauseMenu = new PauseMenu(
      // SPEC-045 §4.1: `Comms log` reads the shared dialogue layer's log.
      withComms(
        services,
        dialogueLayer(services.uiRoot, services.events, {
          input: services.input,
          saveKey: () => services.save.current,
          typewriter: () => services.settings.get().typewriter,
          speed: () => services.settings.get().dialogueSpeed,
        }).log,
        // SPEC-048 §4.4: Notes lists the chapters up to this planet's.
        () => this.#planet.chapter,
      ),
      () => services.requestResume(),
      undefined,
      {
        allowed: () => this.#recallAllowed(),
        run: () => this.#recallToPad(),
      },
      {
        note: () =>
          quitNote('surface', this.#planet.name, this.#economy?.fuelCost(this.#planet.id) ?? this.#planet.fuelCost),
      },
    );
    this.#pauseMenu = pauseMenu;
    this.disposer.add(() => pauseMenu.dispose());
    // Quitting out of an open pause menu never calls resume(); the disposer is
    // what releases the duck (SPEC-006 AC-54).
    this.disposer.add(() => services.audio.duck(false));
    // SPEC-015 §6 / E22: turning the phone to portrait mid-fight opens the
    // pause menu through the same path the pause button uses, so the player is
    // not killed while rotating. Returning to landscape leaves it open (AC-33).
    // SPEC-036 §4.3: the block also holds the world, read every step — a scene
    // entered upright holds from its first step, with no pause menu, and plays
    // the moment the phone is turned.
    const rotate = new RotateOverlay(services.uiRoot, services.events, {
      onBlocked: () => void services.scenes.pause(),
    });
    this.#rotate = rotate;
    this.disposer.add(() => {
      rotate.dispose();
      this.#rotate = null;
    });
    // SPEC-015 §7, AC-38: the gameplay scenes are the one wake-lock owner.
    this.disposer.add(holdWakeLock());
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
    const dialogue = dialogueLayer(services.uiRoot, services.events, {
      input: services.input,
      saveKey: () => this.services.save.current,
      typewriter: () => this.services.settings.get().typewriter,
      speed: () => this.services.settings.get().dialogueSpeed,
    });
    this.#dialogue = dialogue;
    // SPEC-042 §4.1: the mission banner, after the HUD so it is the top
    // centre's last row; it holds the shared dialogue queue while it is up.
    const banner = new MissionBanner(this.ui, {
      dialogue,
      reduceMotion: () => this.services.settings.get().reduceMotion,
      keepToasts: () => dialogue.busy,
      // Of the beats, only the ending plays lines of its own (SPEC-024 §4.1).
      beatSpeaks: () => this.#ending !== null,
    });
    this.#banner = banner;
    this.disposer.add(() => {
      banner.dispose();
      this.#banner = null;
      this.#chains.length = 0;
    });

    const overlay = el('div', 'hud-storm');
    services.uiRoot.append(overlay);
    this.#stormOverlay = overlay;
    this.disposer.add(() => overlay.remove());

    this.#buildTerminal();
    this.#subscribe(bus);
    this.#syncMissionStages();
    // SPEC-059 §4.3.4: a dev build only — every control changes the world, and
    // Smite pays XP and loot, so a production `?debug` keeps the stats overlay
    // and builds no strip (`tests/architecture/debugStrip.test.ts`).
    if (import.meta.env.DEV && new URLSearchParams(globalThis.location.search).has('debug')) this.#buildDebugStrip();

    // SPEC-036 §4.12: the first two touch landings show where the thumbs go —
    // never in a `?perf` run — and teach it in words with the `zones` tip.
    const zonesShown = services.settings.get().zonesShown;
    if (services.input.state.scheme === 'touch' && zonesShown < ZONES_SHOWN_MAX && services.perf !== true) {
      touch.showZones(true);
      services.settings.set({ zonesShown: zonesShown + 1 });
      this.#requestTip('zones');
    }

    // SPEC-029 §4.9: the first landing with a heavy weapon, and the first
    // with an explosive in the slot; `#requestTip` drops the ones seen.
    if (save.equipped.heavy !== null) this.#requestTip('heavy');
    if (save.quick.explosive !== null) this.#requestTip('explosives');

    // SPEC-057 §4.5: the remains this save carries, shown when they lie here.
    this.#syncRemains();

    // §4.1 step 5: the landing save, and held-back accept dialogue.
    services.save.request('landing');
    // SPEC-059 §4.1.3: a landing from the menu's resume says where it put the
    // salvager, and that the timed stages started again (E19).
    if (this.#resumed) services.events.emit('ui:toast', { kind: 'info', text: resumedText(planet.name), ms: RESUMED_TOAST_MS });
    // SPEC-034 §4.10: the ledger, not a set of its own, so the station's debrief
    // knows what the surface has already said. A mission already past stage 0
    // gets its *stage* line here — its accept was two scenes ago.
    // SPEC-048 §4.6 (E76): a replay plays its accept line only, so past stage 0
    // it plays nothing here.
    for (const state of missions.active) {
      const def = MISSION_TABLE[state.id];
      const replay = missions.isReplay(state.id);
      const stageLine = missionLinePlays('stage', replay)
        ? (def.dialogue.onStage as Record<number, DialogueId> | undefined)?.[state.stage]
        : undefined;
      const id = state.stage > 0 ? stageLine : missionLinePlays('accept', replay) ? def.dialogue.onAccept : undefined;
      if (id === undefined || LINE_LEDGER.played(save, id)) continue;
      this.#playDialogue(id);
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
    // SPEC-035 §4.11: the storm does not follow the player off the planet.
    this.#stormLoopTarget = 0;
    this.#stormLoopVolume = 0;
    this.#stopStormLoop();
  }

  /** SPEC-034 §4.6: why the step is holding, or `null` when it runs. */
  #holdReason(): SurfaceHold {
    return surfaceHoldReason({
      beats: this.#holds,
      rotate: this.#rotateBlocked(),
      ui: this.#uiHolds,
      modal: this.#modalOpen,
      level: this.#swapping,
    });
  }

  /**
   * SPEC-040 §4.2: idle while the step holds for the map, the picker, the
   * terminal, a modal line or the rotate block — never for a beat, whose
   * reveal moves the camera. The frame pacer asks every frame, so the same
   * decision as `#holdReason()` is read off a state written in place.
   */
  idle(): boolean {
    // SPEC-054 §4.2: the level a swap changed over to draws on the next frame,
    // so its fade-in opens on it and never on the level just left.
    if (this.#swapUndrawn) return false;
    const state = this.#holdState;
    state.beats = this.#holds;
    state.rotate = this.#rotateBlocked();
    state.ui = this.#uiHolds;
    state.modal = this.#modalOpen;
    state.level = this.#swapping;
    return holdIsIdle(surfaceHoldReason(state));
  }

  /** SPEC-036 §4.3: the phone is upright, and the rotate overlay covers the screen. */
  #rotateBlocked(): boolean {
    return this.#rotate?.blocked === true;
  }

  /**
   * SPEC-034 §4.2: `Recall to pad` is offered while the player is alive and not
   * already respawning, no film, reveal or ending is running, no modal line or
   * choice is open, and the scene is not leaving.
   */
  #recallAllowed(): boolean {
    const world = this.#world;
    if (world === null || !world.player.alive) return false;
    if (this.#deathAt !== null || this.#leaving || this.#swapping) return false;
    if (this.#holds > 0 || this.#modalOpen > 0) return false;
    return this.#ending === null;
  }

  /**
   * SPEC-034 §4.2, E55: E4's respawn without the death — the pad, full HP, the
   * i-frames, the sweep, the boss reset and the arena clear — and without its
   * price: no `player:died`, so nothing is taken and no death overlay shows.
   * `player:recalled` is what restarts the timed, escort and defend stages
   * (34-c: a survive stage at 170 of 180 s starts again, as a death would).
   */
  #recallToPad(): void {
    const world = this.#world;
    if (world === null || !this.#recallAllowed()) return;
    // SPEC-054 §4.9 (E84): below, the swap to the surface comes first, then E55 unchanged.
    if (this.#level?.id === 'underground') this.#applySwap(world, 'surface');
    this.#recalls++;
    this.services.events.emit('player:recalled', {});
    this.#respawn(world, 'pad');
    this.services.requestResume();
  }

  /**
   * SPEC-059 §4.1.1: the resume point — this planet's pad, stamped now. Set at
   * entry and at every pause, so Save & Quit's flush and a hidden tab's
   * `pagehide` save both carry it.
   */
  #markResume(): void {
    const save = this.#save;
    if (save === null) return;
    save.progress.resume = { planet: this.#planet.id, at: Date.now() };
  }

  /**
   * SPEC-026 §4.6: the map is not a second pause — it closes before this one.
   * SPEC-059 §4.1.1: the pause menu, `app:paused` from a hidden tab (before
   * `Game` requests its `pagehide` save) and SPEC-036's pause on blur all land
   * here, so each stamps the resume point first.
   */
  pause(): void {
    this.#markResume();
    this.#closeMap();
    // SPEC-055 §4.4: a puzzle panel closes with the scene pausing; the site keeps its board.
    this.#puzzles?.closePanel();
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

    // SPEC-042 §4.1: the banner runs on the step clock, so a pause freezes it;
    // a film, a reveal or the ending holds it through the beat counter.
    this.#banner?.tick(dt, this.#holds > 0);

    // SPEC-016 D-21: a perf run tops the enemies up at the start of every step.
    if (this.#stress !== null) this.#stressStep(this.#stress, world, combat);

    // SPEC-016 §8.2: a perf run hands the step the player's own input with
    // auto-fire on, so Combat fires at the nearest enemy as auto-fire does.
    const input = this.#stress?.input ?? this.services.input.state;
    this.#edges.beginStep(input.buttons, this.services.loop.stats.frame);
    this.services.save.addPlaytime(dt);

    // SPEC-023 §4.4: a held beat advances its own clock and returns before any
    // system update — no combat, projectiles, missions, arena, choice, spawn,
    // pickups, nodes or weather. The edges were sampled above and are dropped
    // unread, so a press made during the beat never fires after it. Playtime
    // still accrues; no `checkpoint` save is requested.
    if (this.#holds > 0) {
      this.#qbLength = 0; // taps made during the beat are dropped like the edges
      this.#dashQueued = false;
      this.#sprintLatch = false; // SPEC-050 §4.5 (50-b): any hold lets the run go
      this.#updateReveal(dt);
      return;
    }

    // SPEC-054 §4.2: a level swap holds the step through its two fades —
    // nothing moves, nothing is read, and `sceneInfo.held` reads 1.
    if (this.#swapping) {
      this.#qbLength = 0;
      this.#dashQueued = false;
      this.#sprintLatch = false;
      world.player.vx = 0;
      world.player.vz = 0;
      return;
    }

    // SPEC-036 §4.3, E65: the rotate block holds the world exactly as the map
    // does. A phone turned upright mid-fight also paused (E22); one entered
    // upright holds from its first step with no pause menu, and plays the
    // moment it is turned. Presses sampled above are dropped unread.
    if (this.#rotateBlocked()) {
      this.#qbLength = 0;
      this.#dashQueued = false;
      this.#sprintLatch = false;
      world.player.vx = 0;
      world.player.vz = 0;
      return;
    }

    // SPEC-026 §4.6: the full map's hold. Playtime still accrues (above) and
    // the map's own press is read; everything else — combat, missions,
    // weather, spawning, pickups, nodes, exploration — waits, so `world.time`
    // stands still and a swarm cannot bite a player who is reading a map.
    // SPEC-036 §4.10: the pad terminal takes the same hold, and E (or USE)
    // closes it from here, since the pad step does not run while held.
    if (this.#uiHolds > 0) {
      this.#qbLength = 0; // the bar is inert while the simulation is held
      this.#dashQueued = false;
      this.#sprintLatch = false;
      if (this.#edges.pressed('map')) this.#closeMap();
      if (this.#edges.pressed('interact') && this.#terminalOpen) this.#closeTerminal();
      // SPEC-055 §4.4, §4.5: the open panel's clocks run on the held step.
      this.#puzzles?.heldStep(dt);
      world.player.vx = 0;
      world.player.vz = 0;
      return;
    }

    // The touch pause button; Escape/P live in main.ts (SPEC-014 AC-82).
    if (input.scheme === 'touch' && this.#edges.pressed('pause')) {
      void this.services.scenes.pause();
      return;
    }

    // SPEC-034 §4.6, E57: a modal dialogue — or the verdict choice — holds the
    // world exactly as the full map does. The player cannot move, heal or fire
    // while one is up; nothing else may either, so the step returns before
    // `combat.update` and nothing after it runs: spawning, weather, mission
    // timers, pickups, nodes, regeneration or the guidance timers. The camera,
    // the HUD and the dialogue layer keep rendering. The death overlay's clock
    // is above this too — a held line does not run it out.
    if (this.#modalOpen > 0) {
      this.#qbLength = 0;
      this.#dashQueued = false; // 38-a: a dash pressed under a modal line is dropped
      this.#sprintLatch = false;
      world.player.vx = 0;
      world.player.vz = 0;
      return;
    }

    this.#deathTick(world, dt);
    this.#movePlayer(world, dt);
    this.#updateLoadout(world, combat);
    // SPEC-026 §4.5/§4.7: `map` opens the map, `track` cycles the pin.
    if (this.#edges.pressed('map')) this.#openMap();
    // SPEC-034 §4.15: `cyclePinned` moves the entry to the front of
    // `missionsActive`, which is what makes the pin survive a reload.
    if (this.#edges.pressed('track')) missions.cyclePinned();
    // SPEC-054 §4.5: `light` switches the flashlight below; above it does nothing (54-c).
    if (this.#edges.pressed('light')) this.#toggleLight(world);

    // §4.6 (28-d): a hold taken by this step's own presses — the picker or
    // the map — stops the rest of this step too, not just the next one, so
    // no combat, weather or spawning runs behind a freshly opened overlay.
    if (this.#uiHolds > 0) {
      this.#sprintLatch = false;
      world.player.vx = 0;
      world.player.vz = 0;
      return;
    }

    // SPEC-016 §8.2: under a perf run the swarm's shoves and knockback leave
    // the player where they stood — only their own input moves them — so the
    // run stays on the landing ground and never drifts into an arena.
    const heldX = world.player.x;
    const heldZ = world.player.z;
    combat.update(dt, input, this.#aimWorld(world));
    if (this.#stress !== null) {
      world.player.x = heldX;
      world.player.z = heldZ;
    }
    // SPEC-042 §4.11 (dev): `surface-hit-elite`'s one blast, now that this
    // step's hash holds the elite it spawned between steps.
    const hit = this.#pendingHit;
    if (hit !== null) {
      this.#pendingHit = null;
      if (hit.entity.id === hit.id && hit.entity.state !== 'dead') combat.explode(hit.entity.x, hit.entity.z, 1, 1, 0);
    }

    // SPEC-030 §4.5: after combat (so a shot this step ends hiding at once),
    // before weather (so the DPS skip sees this step's "inside").
    this.#updateShelter(world);
    // SPEC-048 §4.3: a shelter clue counts unbroken seconds inside.
    const clues = this.#clues;
    const clueScene = this.#clueScene;
    if (clues !== null && clueScene !== null) this.#playClue(clues.dwell(dt, this.#insideShelter?.kind ?? null, clueScene));
    this.#updateWeather(world, dt);
    missions.update(dt, this.#missionContext(world));
    this.#updatePois(world, dt);
    this.#updateBossArena(world);
    this.#updateDefend(world, dt);
    this.#updateEscort(dt);
    this.#updateChoice(missions);

    // §4.5: spawning runs — a modal line or the ending choice returned above.
    // SPEC-016 D-21: the ambient spawner adds nothing while a perf run holds
    // the population itself. SPEC-043 §4.4: the elite roll reads the difficulty
    // live — a switch in Settings reaches the next spawn — times the surge.
    spawn.eliteMult = this.#eliteMult();
    // SPEC-054 §4.7: below, the director adds no ambient enemy.
    if (this.#level?.id === 'surface') spawn.update(dt, world.player, this.#frustumXZ, this.#stress === null);
    else spawn.update(dt, world.player, this.#frustumXZ, false);

    for (const drop of combat.drops) pickups.spawn(drop);
    combat.drops.length = 0;
    pickups.update(dt, world.player, world.stats.pickupRadius);
    this.#nodes?.update(dt, world.player);
    // SPEC-057 §4.4: walking back to the remains takes them back.
    this.#stepRemains(world, dt);
    // SPEC-055 §4.5, §4.6: the plates underfoot, the beam with the light on,
    // and the world puzzle's clock in its room.
    this.#puzzles?.step(dt);

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
      // SPEC-053 §4.1.2, 53-c: the camera that draws and its target's device
      // pixels (`#screenFrame`, kept by `renderer:resized`) for the head
      // cut-out; reduce motion stills the wind the next frame it changes.
      const screen = this.#screenFrame;
      view.reduceMotion = this.services.settings.get().reduceMotion;
      view.sync({
        player: world.player,
        follower: world.follower,
        enemies: world.enemies,
        projectiles: world.projectiles,
        deployables: (this.#combat as Combat).deployables,
        pickups: (this.#pickups as Pickups).pool,
        // SPEC-054 §4.1: the crystals are the surface's environment, hidden below.
        nodes: (this.#levels?.surface.nodes as Nodes).states,
        // SPEC-038 §4.2: stamped on the world clock, which a held beat stops.
        telegraphs: { pool: (this.#combat as Combat).telegraphs, time: world.time },
        // SPEC-056 §4.4, §4.5: the flares and the spore clouds, on the same clock.
        treasure: { flares: (this.#combat as Combat).flares, clouds: (this.#combat as Combat).clouds, time: world.time },
        time,
        dt,
        screen,
        // SPEC-064 §4.3: the raiders' glint grows over the windup as the difficulty sets it.
        windupMult: world.windupMult ?? 1,
      });
      // SPEC-041 §4.4: the ring shows while the arena is armed — and so while sealed.
      view.setArena(world.arena ?? (this.#arena?.sealed === true ? this.#arena : null));
      // SPEC-030 D-22: the wall chunks against this frame's frustum.
      view.updateWallVisibility(this.#frustum);
      // SPEC-046 §4.6: the static layers draw what this camera sees; the view
      // refreshes them only when the camera has moved enough to matter. A
      // resize changes the projection without a step to re-place the camera —
      // paused, or held by the map or a beat — so the frustum is recaptured
      // here when it no longer matches the camera that draws.
      const seen = this.#frustumView;
      if (seen.fov !== this.camera.fov || seen.aspect !== this.camera.aspect) this.#placeCamera(this.#camBias.x, this.#camBias.z);
      view.setView(seen.x, seen.z, seen.distance, seen.fov, seen.aspect, this.#frustum);
      // SPEC-027 §4.11: the waypoint, the scan ring and the two view meshes.
      this.#renderGuidance(world, view);
      // SPEC-041 §4.6: the nameplates follow this frame's camera.
      this.#renderElitePlates(world);
      // SPEC-057 §4.6: so does the remains' tag.
      this.#renderRemainsTag(world);
      // SPEC-058 §4.5: and the predecessor's.
      this.#renderPredecessorTag(world);
      // SPEC-050 §4.6: so does the stamina ring.
      this.#renderStamina(world);
      // SPEC-055 §4.5: a hinted plate or mirror pulses on the view clock.
      this.#puzzles?.render(time, view.reduceMotion);
      this.#forwardGrade();
      if (this.#minimapIn <= 0) {
        this.#minimapIn = MINIMAP_INTERVAL;
        this.#drawMinimap(world);
      }
    }
    super.render(renderer);
    this.#swapUndrawn = false;
  }

  // ------------------------------------------------- SPEC-019 hit feedback

  /**
   * §4.6 — the per-rendered-frame edges: the muzzle flash on the fire edge,
   * the coalesced pickup sparkle, the menders' green rings (SPEC-041 §4.6) and
   * the enemy damage numbers off per-slot HP deltas. Runs before `sync`,
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
        // SPEC-019 §4.5: the flash takes the colour of the shot it fired.
        muzzleColor(this.#combat?.lastShotLook ?? null),
      );
    }
    this.#lastFireCooldown = p.fireCooldown;

    // SPEC-041 §4.6: a green ring at every mender pulse since the last frame.
    const combat = this.#combat;
    if (combat !== null && combat.menderPulseCount > 0) {
      for (let i = 0; i < combat.menderPulseCount; i++) {
        const pulse = combat.menderPulses[i] as { x: number; z: number };
        view.fx.burst('dust_ring', pulse.x, pulse.z, MENDER_RING_COLOR);
      }
      combat.menderPulseCount = 0;
    }

    // At most one pickup sparkle per rendered frame (§4.6, Decisions #7).
    if (this.#pickupColor >= 0) {
      view.fx.burst('pickup', p.x, p.z, this.#pickupColor);
      this.#pickupColor = -1;
    }

    this.#enemyDamageNumbers(world);
  }

  /**
   * SPEC-041 §4.6: up to six plates over the nearest live elites within 25 m —
   * a nearest-first insertion over typed scratch, the text from caches built
   * once per species and affix pair, so a frame allocates nothing.
   */
  #renderElitePlates(world: CombatWorld): void {
    const plates = this.#plates;
    if (plates === null) return;
    const p = world.player;
    const index = this.#plateIndex;
    const dist = this.#plateDist;
    let count = 0;
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (!e.elite || e.state === 'dead' || isBuried(e)) continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (d > ELITE_PLATE_RANGE) continue;
      let at = count < ELITE_PLATE_SLOTS ? count : ELITE_PLATE_SLOTS;
      while (at > 0 && (dist[at - 1] as number) > d) {
        if (at < ELITE_PLATE_SLOTS) {
          dist[at] = dist[at - 1] as number;
          index[at] = index[at - 1] as number;
        }
        at--;
      }
      if (at >= ELITE_PLATE_SLOTS) continue;
      dist[at] = d;
      index[at] = i;
      if (count < ELITE_PLATE_SLOTS) count++;
    }
    for (let slot = 0; slot < count; slot++) {
      const e = world.enemies.at(index[slot] as number);
      this.#project(e.x, e.z, ELITE_PLATE_LIFT);
      plates.show(slot, this.#screenPoint.x, this.#screenPoint.y, this.#plateName(e.def.id), affixLine(e));
    }
    plates.hideFrom(count);
  }

  /**
   * SPEC-050 §4.6: the stamina ring at the projected head of the salvager, off
   * the HUD model; off at once while they are down, or while a beat or the map
   * owns the screen — as the scan ring is.
   */
  #renderStamina(world: CombatWorld): void {
    const ring = this.#staminaRing;
    if (ring === null) return;
    const model = this.#hud?.model.stamina ?? null;
    if (model === null || !world.player.alive || this.#uiHolds > 0 || this.#holds > 0) {
      ring.hide();
      return;
    }
    this.#project(world.player.x, world.player.z, STAMINA_HEAD_LIFT);
    ring.set(this.#screenPoint.x, this.#screenPoint.y, model);
  }

  #plateName(id: EnemyId): string {
    let name = this.#plateNames.get(id);
    if (name === undefined) {
      name = `Alpha ${ENEMIES[id].name}`;
      this.#plateNames.set(id, name);
    }
    return name;
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
          // SPEC-038 §4.8: a critical hit reads on the number. SPEC-041 §4.6:
          // a hit a bulwark turned reads grey, whatever else it was.
          numbers.show(
            this.#screenPoint.x,
            this.#screenPoint.y,
            amount,
            e.lastHitGuarded ? 'guarded' : e.lastHitCrit ? 'crit' : e.elite || e.def.archetype === 'boss' ? 'elite' : 'enemy',
          );
        }
      }
      hp[i] = e.hp;
      ids[i] = e.id;
    }
  }

  /** World XZ (+ a lift in metres) → screen pixels, through the camera. */
  #project(x: number, z: number, lift: number): void {
    const v = this.#projectScratch.set(x, lift + (this.#view?.heightAt(x, z) ?? 0), z);
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

  /**
   * SPEC-016 §8.2 (D-21): what a perf run measures on the surface — the first
   * storm of the planet's cycle for the run (none on a weatherless planet),
   * the live enemies topped up to the wave ceiling 12–24 m around the player,
   * auto-fire through Combat's input, and a player neither the enemies nor
   * the storm can hurt. It never moves the player — nor lets the swarm shove
   * them — so the run stays on the landing ground. `stop()` ends the refill,
   * the auto-fire, the immunity and the hold; the enemies already alive stay.
   */
  perfStress(seconds: number): PerfStress | null {
    const world = this.#world;
    const weather = this.#weather;
    const visit = this.#visitRng;
    if (world === null || weather === null || visit === null) return null;
    const storm = this.#planet.surface.weather?.cycle[0] ?? null;
    if (storm !== null) weather.force(storm, seconds);
    const stress: SurfaceStress = {
      ceiling: this.services.renderer.quality.maxEnemies + WAVE_CEILING_BONUS,
      rng: visit.fork('perf'),
      row: 0,
      input: autoFireInput(this.services.input.state),
    };
    this.#stress = stress;
    this.#keepImmune(world);
    return {
      storm,
      enemyCeiling: stress.ceiling,
      enemies: () => this.#liveEnemies(),
      stop: () => {
        if (this.#stress === stress) this.#endStress();
      },
    };
  }

  /** D-21: immunity past the end of the step, then every enemy the ceiling is short of. */
  #stressStep(stress: SurfaceStress, world: CombatWorld, combat: Combat): void {
    this.#keepImmune(world);
    const rows = this.#planet.surface.spawn;
    if (rows.length === 0) return;
    const p = world.player;
    for (let alive = this.#liveEnemies(); alive < stress.ceiling; alive++) {
      const row = rows[stress.row % rows.length] as (typeof rows)[number];
      stress.row++;
      const angle = stress.rng.angle();
      const distance = stress.rng.float(PERF_SPAWN_MIN, PERF_SPAWN_MAX);
      combat.spawnEnemy(row.enemy, p.x + Math.cos(angle) * distance, p.z + Math.sin(angle) * distance, false);
    }
  }

  /** §8.2: neither a blow nor the storm lands while a perf run holds the player. */
  #keepImmune(world: CombatWorld): void {
    const p = world.player;
    p.invulnUntil = Math.max(p.invulnUntil, world.time + PERF_IMMUNE_AHEAD);
    p.hazardImmuneUntil = Math.max(p.hazardImmuneUntil, world.time + PERF_IMMUNE_AHEAD);
  }

  /** The stress's `stop()`: no refill, no auto-fire, and the player can be hurt again from now. */
  #endStress(): void {
    this.#stress = null;
    const world = this.#world;
    if (world === null) return;
    world.player.invulnUntil = Math.min(world.player.invulnUntil, world.time);
    world.player.hazardImmuneUntil = Math.min(world.player.hazardImmuneUntil, world.time);
  }

  /** Every enemy still alive, the way the spawn census counts them. */
  #liveEnemies(): number {
    const enemies = this.#world?.enemies;
    if (enemies === undefined) return 0;
    let alive = 0;
    for (let i = 0; i < enemies.size; i++) if (enemies.at(i).state !== 'dead') alive++;
    return alive;
  }

  override debugInfo(): Record<string, number | string> {
    const info = super.debugInfo();
    info['drawCalls'] = this.services.renderer.gl.info.render.calls;
    info['spawned'] = this.#spawned;
    info['elites'] = this.#elites;
    info['kills'] = this.#kills;
    // SPEC-023 §4.4 / SPEC-034 §4.6: 1 while the step is holding for anything —
    // a story beat, the full map, a modal line or the verdict choice — and the
    // view clock that keeps running while `world.time` stands still.
    info['held'] = this.#holdReason() === null ? 0 : 1;
    info['recalls'] = this.#recalls;
    // SPEC-059 §3: 1 on a landing the menu resumed, else 0.
    info['resumed'] = this.#resumed ? 1 : 0;
    info['summonsDismissed'] = this.#summonsDismissed;
    info['viewTime'] = Math.round(this.#viewTime * 100) / 100;
    // SPEC-015 AC-39: how far the shake and the walk bob actually moved the
    // camera on the last frame, for the same reason SPEC-020 20-g publishes
    // `skyTint` — Camera shake Off zeroes both (SPEC-045 §4.3), and that is
    // otherwise a claim about a Three.js vector nothing outside the renderer
    // can read.
    info['camShake'] = Math.round(this.#shakeScratch.length() * 1000) / 1000;
    info['camBob'] = Math.round(this.#shakeScratch.y * 1000) / 1000;
    // SPEC-035 §4.2, §4.4, §4.5, §4.7: the camera's distance, the linear fog's
    // near plane, how many props are faded out of the way, and whether the
    // first-landing ramp is running.
    info['camDistance'] = Math.round(this.#camDistance * 100) / 100;
    // How far the eased look-ahead leads the player — a tap of W moves it a
    // fraction of its 2 m, where it once jumped the whole way and back.
    info['camLead'] = Math.round(Math.hypot(this.#camLead.x, this.#camLead.z) * 100) / 100;
    // SPEC-037 §4.7: the Hor+ field of view in force, to one decimal.
    info['fov'] = Math.round(this.camera.fov * 10) / 10;
    info['fogNear'] = Math.round(this.#fogNear * 100) / 100;
    info['occluders'] = this.#view?.fadedOccluders ?? 0;
    // SPEC-040 §4.6: whether every modelled prop kind draws its GLB yet.
    info['propSource'] = this.#view?.propSource ?? 'procedural';
    // SPEC-054 §4.2: whether the descent's mouth draws `cave_shaft` yet.
    info['descentMouth'] = this.#view?.descentMouth ?? '-';
    // SPEC-046 §4.6, §4.8: the instances the culled layers draw, the last
    // refresh's cost, and whether the tug stands on the pad.
    info['instancesDrawn'] = this.#view?.instancesDrawn ?? 0;
    info['cullMs'] = this.#view?.cullMs ?? 0;
    info['tug'] = this.#view?.tugDrawn === true ? 1 : 0;
    // SPEC-053 §3: the foliage sub-budget, the canopy fade (E82), the cover,
    // the trees' LOD and source, the wind in force, and Eden's seam.
    const view = this.#view;
    if (view !== null) {
      info['foliageTris'] = view.foliageTris;
      info['foliageDraws'] = view.foliageDraws;
      info['canopyFaded'] = view.canopyFaded;
      info['canopyHolders'] = view.canopyHolders;
      info['coverDrawn'] = view.coverDrawn;
      info['treeLod'] = view.treeLod;
      info['treeSource'] = view.treeSource;
      info['wind'] = Math.round(view.wind * 10_000) / 10_000;
      if (view.seamAt !== null) info['seamAt'] = Math.round(view.seamAt * 100) / 100;
    }
    const grove = this.#groveTree;
    if (grove !== null) {
      info['groveX'] = Math.round(grove.x * 100) / 100;
      info['groveZ'] = Math.round(grove.z * 100) / 100;
      info['groveR'] = Math.round(grove.radius * 100) / 100;
    }
    // SPEC-035 §4.3: the surface's own bloom threshold, which the shared default
    // (0.85) is not — a whiteout is otherwise a claim about a post uniform
    // nothing outside the chain can read.
    info['bloomThreshold'] = this.#view?.look.bloomThreshold ?? DEFAULT_LOOK.bloomThreshold;
    info['ramp'] = this.#ramp ? 1 : 0;
    // §4.7: what the ramp is supposed to be holding down — the ambient weather
    // phase and how many rushers are alive. Without these the ramp is a claim
    // about two runtimes nothing outside the scene can see.
    info['weatherPhase'] = this.#weather?.phase ?? 'calm';
    let rushers = 0;
    if (this.#world !== null) {
      for (let i = 0; i < this.#world.enemies.size; i++) {
        const e = this.#world.enemies.at(i);
        if (e.state !== 'dead' && e.def.archetype === 'rusher') rushers++;
      }
    }
    info['rushers'] = rushers;
    // SPEC-028 §4.9: the weapon in hand and the quick-slot counts.
    const combat = this.#combat;
    const save = this.#save;
    const economy = this.#economy;
    // SPEC-039 §3: this visit's signature rows — dropped as the piece, and
    // paid as the fallback lithium.
    info['signatureDrops'] = combat?.signatureDrops ?? 0;
    info['signatureFallbacks'] = combat?.signatureFallbacks ?? 0;
    if (combat !== null && save !== null && economy !== null) {
      info['weapon'] = combat.loadout.activeWeapon().id;
      info['weaponSlot'] = combat.loadout.active;
      const countOf = (id: ItemId | null): number => (id === null ? 0 : economy.count(id));
      info['qHeal'] = countOf(save.quick.heal);
      info['qExplosive'] = countOf(save.quick.explosive);
      info['qUtility'] = countOf(save.quick.utility);
      // SPEC-029 §4.13: the cooldown states the e2e run reads.
      const time = this.#world?.time ?? 0;
      const view = this.#debugSlotView;
      combat.loadout.view('primary', time, view);
      info['weaponHeat'] = Math.round(view.heat * 100);
      combat.loadout.view('heavy', time, view);
      info['charges'] = view.itemId === null ? '-' : view.charges;
      combat.loadout.view(combat.loadout.active, time, view);
      info['weaponState'] = view.state;
      let mines = 0;
      for (let i = 0; i < combat.deployables.size; i++) {
        const d = combat.deployables.at(i);
        if (d.kind === 'mine' && d.armed) mines++;
      }
      info['mines'] = mines;
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
      const pad = this.#level?.pad ?? null;
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
      const nodes = this.#level?.nodes ?? null;
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
      // SPEC-057 §4.5: the remains' icon on the last repaint.
      info['mmRemains'] = drawn.remains;
    }
    // SPEC-026 §4.8: the explored share, the map's state, and the proof that
    // the terrain layer is built once per visit.
    const level = this.#level;
    if (level !== null) {
      info['mmExplored'] = Math.round(level.mask.fraction() * 1000) / 10;
      info['mmTerrainBuilds'] = level.layers.terrainBuilds;
    }
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
    // SPEC-054 §6.2 case 1: the surface's hash on every level; the cave's is `caveHash`.
    const levels = this.#levels;
    if (levels !== null) info['layoutHash'] = levels.surface.layout.hash;
    // SPEC-030 §4.12: the shelter state and the wall's visible chunk count.
    info['sheltered'] = this.#insideShelter === null ? 0 : 1;
    info['hidden'] = this.#shelterState === 'hidden' ? 1 : 0;
    info['shelters'] = level?.shelters.length ?? 0;
    info['wallVisible'] = this.#view?.wallVisible ?? 0;
    // SPEC-048 §4.3, §4.8: the bodies on the ground, the clues found and the
    // shelter clue's dwell, in seconds to one decimal.
    info['scavBodies'] = this.#view?.scavBodies ?? 0;
    // SPEC-064 §4.5: `{ live, falling, standIn, tracers }`, as compact JSON —
    // a row value carries no whitespace (`surface-env.spec.ts` pins the shape).
    const raiders = this.#view?.scavRaiders;
    info['scavRaiders'] = raiders === undefined ? '-' : JSON.stringify(raiders);
    // SPEC-057 §3, §4.6: where the remains lie (`-` with none), what they
    // hold, the look chosen at entry, what the view draws for them and
    // whether the tag is up.
    const remains = this.#save?.progress.remains ?? null;
    info['remains'] = remains === null ? '-' : `${remains.planet}:${Math.round(remains.x * 10) / 10},${Math.round(remains.z * 10) / 10}`;
    info['remainsHeld'] = remainsHeld(remains);
    info['remainsLook'] = this.#remainsLook;
    info['remainsDrawn'] = this.#view?.remainsDrawn ?? '-';
    info['remainsDraws'] = this.#view?.remainsDraws ?? 0;
    info['remainsTris'] = this.#view?.remainsTris ?? 0;
    info['remainsPosedAt'] = Math.round((this.#view?.remainsPosedAt ?? -1) * 1000) / 1000;
    info['remainsTag'] = this.#remainsTag?.shown === true ? 1 : 0;
    // SPEC-058 §3: the save's iteration, its containment steps, and where the
    // predecessor's body lies (`-` with none) — what the view draws for it and
    // whether its tag is up.
    info['iteration'] = this.#save?.meta.iteration ?? 1;
    info['containment'] = containmentSteps(this.#save?.meta.iteration ?? 1);
    const predecessor = this.#predecessor;
    info['predecessor'] = predecessor === null ? '-' : `${Math.round(predecessor.x * 10) / 10},${Math.round(predecessor.z * 10) / 10}`;
    info['predecessorDraws'] = this.#view?.predecessorDraws ?? 0;
    info['predecessorTris'] = this.#view?.predecessorTris ?? 0;
    info['predecessorTag'] = this.#predecessorTag?.shown === true ? 1 : 0;
    const clueScene = this.#clueScene;
    let cluesFound = 0;
    if (clueScene !== null) for (const def of CLUES) if (clueFound(def, clueScene.flags)) cluesFound++;
    info['cluesFound'] = cluesFound;
    info['clueDwell'] = Math.round((this.#clues?.dwellSeconds ?? 0) * 10) / 10;
    // SPEC-038 §3: the dash count, the live telegraphs (and their draws), the
    // storm wave running, what the weather deals in the open, the director's
    // target and the difficulty in force.
    info['dashes'] = this.#dashes;
    // SPEC-050 §3: the pool, the run and its noise, the step's speed, the
    // visit's shots and in-combat sprints, and how far the burrow's circle is.
    if (this.#world !== null) {
      const p = this.#world.player;
      info['stamina'] = Math.round(p.stamina);
      info['sprinting'] = p.sprinting ? 1 : 0;
      info['exhausted'] = p.exhausted ? 1 : 0;
      info['loud'] = isLoud(p, this.#world.time) ? 1 : 0;
      info['burrowRing'] = this.#burrowRing(this.#world);
    }
    info['speed'] = Math.round(this.#speed * 100) / 100;
    info['shots'] = this.#shots;
    info['sprints'] = this.#sprints;
    info['sprintsShort'] = this.#sprintsShort;
    info['telegraphs'] = this.#combat?.telegraphs.size ?? 0;
    info['telegraphDraws'] = this.#view?.telegraphDraws ?? 0;
    info['stormWave'] = this.#stormHandle === null || this.#storm === null ? '-' : this.#storm.wave;
    info['weatherDps'] = Math.round((this.#weather?.exposureDps ?? 0) * 100) / 100;
    info['population'] = this.#spawn?.populationTarget ?? 0;
    info['difficulty'] = this.#save?.meta.difficulty ?? 'normal';
    // SPEC-043 §4.3: the contract modifiers in force, e.g. `elite_surge+no_cover`.
    info['contract'] = this.#contracts.length === 0 ? '-' : this.#contracts.join('+');
    info['eliteChance'] = Math.round((this.#spawn?.eliteChance ?? 0) * 1000) / 1000;
    // SPEC-041 §3: the seal, the last boss move that landed, the live packs and
    // the elite plates on screen.
    info['sealed'] = this.#arena?.sealed === true ? 1 : 0;
    info['bossMove'] = this.#combat?.lastBossMove ?? '-';
    info['packs'] = this.#spawn?.packs ?? 0;
    info['elitePlates'] = this.#plates?.visible ?? 0;
    // The player's distance from the nest's centre, so a run can check the
    // seal's clamp and the arena respawn without knowing the layout.
    const nest = level?.arena ?? null;
    if (nest !== null && this.#world !== null) {
      info['arenaDist'] = Math.round(Math.hypot(this.#world.player.x - nest.x, this.#world.player.z - nest.z) * 10) / 10;
    }
    this.#underInfo(info, level);
    // SPEC-055 §3: the open site, the next move, the moves and the solves.
    info['puzzle'] = '-';
    info['puzzleHint'] = '-';
    info['puzzleMoves'] = 0;
    info['puzzlesSolved'] = 0;
    this.#puzzles?.info(info);
    // SPEC-056 §3: the flares burning, the spore clouds alive and the relics on the rack.
    info['flares'] = this.#combat?.flaresBurning ?? 0;
    info['clouds'] = this.#combat?.cloudsAlive ?? 0;
    info['relics'] = this.#economy?.relics().length ?? 0;
    // §4.1: the relic terminal on the map — `relic` once landmark 0 is discovered, `spent` once solved.
    info['relicMark'] = this.#relicMarked(level) ? ((this.#puzzles?.relicMark()?.spent ?? false) ? 'spent' : 'relic') : '-';
    return info;
  }

  /** SPEC-055 §4.1: the relic terminal shows on the surface's map once its landmark — instance 0 — is discovered. */
  #relicMarked(level: Level | null): boolean {
    if (level === null || level.id !== 'surface' || (this.#puzzles?.relicMark() ?? null) === null) return false;
    for (const state of level.pois) if (state.poi.kind === 'landmark' && state.poi.instance === 0 && state.discovered) return true;
    return false;
  }

  /** SPEC-054 §3: the level, the cave, the light, the caches and the descent. */
  #underInfo(info: Record<string, number | string>, level: Level | null): void {
    const below = level?.id === 'underground';
    const cave = this.#cave;
    info['level'] = level?.id ?? 'surface';
    info['caveHash'] = cave?.hash ?? 0;
    info['caveRooms'] = cave?.rooms.length ?? 0;
    let walls = 0;
    if (cave !== null) for (const o of cave.obstacles) if (o.kind === 'cave_wall') walls++;
    info['caveWalls'] = walls;
    info['caveEnemies'] = below ? this.#liveEnemies() : 0;
    info['light'] = below && this.#lightOn ? 1 : 0;
    info['flashlight'] = this.#view?.flashlightMode ?? '-';
    let lights = 0;
    this.scene.traverseVisible((node) => {
      if ((node as THREE.Light).isLight === true) lights++;
    });
    info['lights'] = lights;
    let claimed = 0;
    const save = this.#save;
    if (save !== null) {
      for (const id of save.progress.claimed) if (Object.hasOwn(CACHES, id) && CACHES[id as CacheId].planet === this.#planet.id) claimed++;
    }
    info['claimed'] = claimed;
    // SPEC-056 §4.8 (E89): a claimed cache draws opened on every later descent.
    info['cachesOpen'] = this.#caveView?.openCaches ?? 0;
    const descent = this.#descent;
    const world = this.#world;
    info['descentDist'] =
      descent === null || world === null || below ? -1 : Math.round(Math.hypot(world.player.x - descent.x, world.player.z - descent.z) * 10) / 10;
    info['cradles'] = this.#caveView?.cradles ?? 0;
    // §4.12: the machine room as drawn — the wall model, the cable trays and
    // the colours the cradles' suits wear — and the room the salvager stands
    // in (−1 above or in a corridor) beside the vault's.
    info['caveWallModel'] = this.#caveView?.wallModel ?? '-';
    info['caveTrays'] = this.#caveView?.trays ?? 0;
    info['cradleSuit'] = this.#caveView?.suit ?? '-';
    let room = -1;
    if (below && cave !== null && world !== null) {
      const p = world.player;
      room = cave.rooms.findIndex((r) => Math.hypot(p.x - r.x, p.z - r.z) <= r.r);
    }
    info['caveRoom'] = room;
    info['vaultRoom'] = cave?.vault.room ?? -1;
    // §4.12: the weather-loop channel — what it plays (`-` silent), how loud,
    // and whether its voice is sounding yet (its bank may still be decoding).
    info['weatherLoop'] = this.#stormVoice === null ? '-' : this.#stormSound;
    info['weatherLoopVolume'] = Math.round(this.#stormLoopVolume * 100) / 100;
    info['weatherLoopPlaying'] = this.#stormVoice?.playing === true ? 1 : 0;
  }

  /**
   * SPEC-050 §3: metres, to one decimal, from the burrow's circle — the one
   * telegraph that follows a loud player — to the player; −1 with none down.
   */
  #burrowRing(world: CombatWorld): number {
    const pool = this.#combat?.telegraphs;
    if (pool === undefined) return -1;
    for (let i = 0; i < pool.size; i++) {
      const t = pool.at(i);
      if (t.kind === 'circle' && t.followsLoud) return Math.round(Math.hypot(t.x - world.player.x, t.z - world.player.z) * 10) / 10;
    }
    return -1;
  }

  // ----------------------------------------------------------------- grade

  // SPEC-018 §4.9: the last forwarded grade and one reused partial — the
  // comparison and the call allocate nothing per frame (SPEC-001 §7).
  readonly #lastGrade = { vignette: -1, desaturate: -1, tint: [-1, -1, -1] as [number, number, number] };
  readonly #gradeLook: Partial<Look> = { vignette: 0, saturation: 1, tint: [1, 1, 1] };

  /** Forward the storm grade through `renderer.setLook` when it changed. */
  #forwardGrade(): void {
    const view = this.#view;
    // SPEC-054 §4.4: the storm grade is not forwarded below.
    if (view === null || this.#level?.id === 'underground') return;
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
    // SPEC-038 §4.1: the dash reads its press edge here, like `map`; a click on
    // `qb-dash` since the last step counts as one. A dead player's is dropped.
    const dashPressed = this.#edges.pressed('dash') || this.#dashQueued;
    this.#dashQueued = false;
    // SPEC-050 §4.1: the stamina step runs before the player moves — and while
    // dead, so a death ends the run.
    this.#stepSprint(world, dt);
    const fromX = p.x;
    const fromZ = p.z;
    if (!p.alive) {
      p.vx = 0;
      p.vz = 0;
      this.#speed = 0;
      return;
    }
    const move = this.services.input.state.move;
    const inv = Math.SQRT1_2;
    const moveX = (move.x - move.y) * inv;
    const moveZ = (-move.x - move.y) * inv;
    if (dashPressed) this.#tryDash(world, moveX, moveZ);
    if (isDashing(p, world.time)) {
      // SPEC-038 §4.1: the dash moves the salvager instead of the stick (E59),
      // at its own 25 m/s — SPEC-050 §4.2: the sprint multiplier is not its.
      stepDash(p, world.obstacles, (this.#level as Level).bounds, world.time, dt, this.#resolved);
      // SPEC-041 §4.4, E62: a sealed ring stops the dash like the wall does.
      if (clampToSeal(world.arena, p)) p.dashUntil = world.time;
      this.#speed = Math.hypot(p.x - fromX, p.z - fromZ) / dt;
      return;
    }
    // SPEC-050 §4.2: a sprint runs at ×1.35 the walk — the storm's slow is
    // already inside `moveSpeed`, so a blizzard sprint is slowed as well.
    const speed = world.stats.moveSpeed * (p.sprinting ? SPRINT_MULT : 1);
    p.vx = moveX * speed;
    p.vz = moveZ * speed;
    // SPEC-034 §4.1: resolve out of any obstacle *before* the slide, so a
    // player knocked into a rock can always walk away from it.
    if (world.obstacles.resolveCircle(p.x, p.z, p.radius, this.#resolved)) {
      p.x = this.#resolved.x;
      p.z = this.#resolved.z;
    }
    const nx = p.x + p.vx * dt;
    const nz = p.z + p.vz * dt;
    if (!world.obstacles.hitsCircle(nx, p.z, p.radius)) p.x = nx;
    if (!world.obstacles.hitsCircle(p.x, nz, p.radius)) p.z = nz;
    // SPEC-030 AC-30: the clamp margin is the shared WALL_INSET constant —
    // SPEC-054 §4.1: on the active level's edge.
    const edge = (this.#level as Level).bounds;
    p.x = Math.max(-edge, Math.min(edge, p.x));
    p.z = Math.max(-edge, Math.min(edge, p.z));
    // SPEC-041 §4.4, E62: while the boss lives, the sealed ring holds them in.
    clampToSeal(world.arena, p);
    // SPEC-050 §3: `sceneInfo.speed` — how far this step actually carried them.
    this.#speed = Math.hypot(p.x - fromX, p.z - fromZ) / dt;
  }

  /**
   * SPEC-050 §4.1 — one stamina step, before the player moves. What is wanted
   * (§4.5): with `sprintToggle` on the keyboard scheme the latch each `sprint`
   * press flips, otherwise the held action — and never while explicit fire is
   * held (Space, the left button, a touch aim-drag; auto-fire is not explicit,
   * §4.2). It then sets the step's noise (§4.3), counts in-combat sprints and
   * raises the `sprint` tip at the first (§4.2, §4.7), and keeps the touch
   * stick's ring in step (§4.5). Allocates nothing.
   */
  #stepSprint(world: CombatWorld, dt: number): void {
    const p = world.player;
    const save = this.#save as Save;
    const combat = this.#combat as Combat;
    const input = this.services.input.state;
    const toggle = this.services.settings.get().sprintToggle && input.scheme !== 'touch';
    if (!toggle) this.#sprintLatch = false;
    else if (this.#edges.pressed('sprint')) this.#sprintLatch = !this.#sprintLatch;
    const wanted = toggle ? this.#sprintLatch : input.buttons.sprint.down;
    const explicitFire = input.buttons.fire.down || input.aim.dragging;
    const moving = Math.hypot(input.move.x, input.move.y) > 0;
    const inCombat = combat.inCombat;
    // Widened to the interface: the concrete class passives are disjoint literals.
    const passive: ClassPassive = CLASSES[save.player.classId].passive;
    const wasSprinting = p.sprinting;
    const wasExhausted = p.exhausted;
    stepStamina(
      p,
      wanted && !explicitFire,
      moving,
      inCombat,
      passive.sprintDrainMult ?? 1,
      staminaRegen(save.player.attributes.agility, save.meta.difficulty),
      world.time,
      dt,
    );
    if (p.exhausted && !wasExhausted) this.#onExhausted();
    // §4.3: the noise the brains hear this step, set before `combat.update`.
    world.noiseMult = isLoud(p, world.time) ? SPRINT_NOISE : 1;
    // §4.2: an episode is a run of sprinting steps; it counts when combat was
    // on at its start, and is short under half a second.
    if (p.sprinting && !wasSprinting) {
      this.#sprintStartedAt = world.time;
      this.#sprintInCombat = inCombat;
      if (inCombat) {
        this.#sprints++;
        this.#requestTip('sprint');
      }
    } else if (!p.sprinting && wasSprinting && this.#sprintInCombat) {
      if (world.time - this.#sprintStartedAt < SHORT_SPRINT_SECONDS) this.#sprintsShort++;
    }
    if (p.sprinting !== this.#sprintShown) {
      this.#sprintShown = p.sprinting;
      this.#touch?.setSprinting(p.sprinting);
    }
  }

  /**
   * SPEC-050 §4.1: the step stamina reached 0 — by a sprint, a dash or the
   * debug strip — `player:exhausted` once, and the toggle's latch lets go
   * (§4.5): an exhausted player who still wants to run presses again.
   */
  #onExhausted(): void {
    this.#sprintLatch = false;
    this.services.events.emit('player:exhausted', {});
  }

  /**
   * SPEC-038 §4.1: start a dash along the camera-mapped move input — the same
   * rotation walking uses — or the facing when the stick and keys are idle. A
   * refused press (the cooldown) does nothing at all: no toast, no sound.
   * SPEC-050 §4.2: nor does one under 30 stamina or while exhausted; a dash
   * that starts spends its 30, and may exhaust (§4.1).
   */
  #tryDash(world: CombatWorld, moveX: number, moveZ: number): void {
    const p = world.player;
    const save = this.#save as Save;
    const moving = Math.hypot(moveX, moveZ) > 1e-3;
    const dirX = moving ? moveX : Math.cos(p.facing);
    const dirZ = moving ? moveZ : Math.sin(p.facing);
    const cooldown = dashCooldown(CLASSES[save.player.classId].passive, save.player.attributes.agility, save.meta.difficulty);
    const pressed = pressDash(p, dirX, dirZ, world.time, cooldown);
    if (pressed === 'refused') return;
    this.#dashes++;
    this.#dashCooldown = cooldown;
    this.services.events.emit('player:dashed', { x: p.x, z: p.z, dirX: p.dashX, dirZ: p.dashZ });
    if (pressed === 'exhausted') this.#onExhausted();
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

  /** Mirrors the projection into a debug slot nothing else writes. */
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
    // SPEC-015 §9: the walk bob rides the same speed the look-ahead does.
    this.#camSpeed = Math.hypot(p.vx, p.vz);
    // The look-ahead eases as well; set straight from the velocity, a tap of W
    // jerked the camera 2 m forward and back.
    stepLookAhead(this.#camLead, p.vx, p.vz, dt);
    // SPEC-035 §4.2, §4.4: the distance eases first, then the camera is placed
    // at it, then the fog's near plane follows it.
    this.#easeCameraDistance(dt);
    this.#placeCamera(this.#camLead.x, this.#camLead.z);
    this.#applyFog();
    // SPEC-035 §4.5: the occlusion test runs off the camera just placed.
    this.#updateOccluders(dt, p);
  }

  /**
   * SPEC-035 §4.7: push `#ramp` into the spawn director and the weather.
   * SPEC-043 §4.3: with no first-landing ramp, a `swarm` in force is the
   * director's ramp; `setRamp(null)` once it leaves.
   */
  #applyRamp(): void {
    this.#spawn?.setRamp(this.#ramp ? RAMP : this.#contracts.includes('swarm') ? SWARM_RAMP : null);
    this.#weather?.holdCalm(this.#ramp);
  }

  /**
   * SPEC-043 §4.3: the set in force, from the active replays' contracts — each
   * modifier once however many missions carry it (43-c), and gone when its
   * mission completes or is abandoned. `elite_surge` is read by the step's
   * `eliteMult`; `swarm` is the ramp; `storm_front` scales the calm windows
   * rolled from now on (43-e); `no_cover` opens the shelters to the weather.
   */
  #applyContracts(): void {
    const missions = this.#missions;
    if (missions === null) return;
    const active = missions.activeContracts();
    this.#contracts = CONTRACT_IDS.filter((id) => active.includes(id));
    this.#eliteSurge = this.#contracts.includes('elite_surge');
    const noCover = this.#contracts.includes('no_cover');
    const coverChanged = noCover !== this.#noCover;
    this.#noCover = noCover;
    this.#applyRamp();
    this.#weather?.setCalmScale(this.#contracts.includes('storm_front') ? CONTRACTS.storm_front.calmScale : 1);
    // A shelter the player stands in starts or stops pinning the storm's
    // slow-down the moment `no_cover` comes or goes.
    if (coverChanged && this.#insideShelter !== null) this.#combat?.setWeatherMoveMult(this.#weatherMoveMult());
  }

  /**
   * SPEC-030 D-6: the storm's move multiplier, pinned at 1 inside a shelter —
   * unless `no_cover` is in force (SPEC-043 §4.3), when the weather gets in.
   */
  #weatherMoveMult(): number {
    const current = this.#weather?.current ?? null;
    // SPEC-054 §4.4: below, the move multiplier is 1.
    if (this.#level?.id === 'underground') return 1;
    if (current === null || (this.#insideShelter !== null && !this.#noCover)) return 1;
    return WEATHER_EFFECTS[current].moveMult;
  }

  /**
   * SPEC-043 §4.5: a clean run's time, kept when it is this device's first or
   * its fastest (43-j). SPEC-059 §4.3.2: only while the page's records are open.
   */
  #recordBest(id: MissionId, seconds: number): void {
    if (!RECORDS.open) return;
    const settings = this.services.settings;
    const times = settings.get().bestTimes;
    const stored = times[id];
    if (stored !== undefined && stored <= seconds) return;
    settings.set({ bestTimes: { ...times, [id]: seconds } });
  }

  /**
   * SPEC-035 §4.4 — the linear fog's span, from `surfaceFogRange`. Rewritten
   * only when the storm's multiplier or the camera distance moved, so a steady
   * frame allocates nothing (SPEC-001 §7).
   */
  #applyFog(): void {
    const view = this.#view;
    if (view === null) return;
    // SPEC-054 §4.4: below, the linear fog runs from the camera distance over the dark look's span.
    const below = this.#level?.id === 'underground';
    const mult = below ? DARK_FOG_KEY : view.fogMult;
    if (mult === this.#fogMultApplied && this.#camDistance === this.#fogCamApplied) return;
    this.#fogMultApplied = mult;
    this.#fogCamApplied = this.#camDistance;
    const range = below
      ? darkFogRange(this.#camDistance, this.#caveDef.look.fogSpan)
      : surfaceFogRange(view.fogDensity, mult, this.#camDistance);
    this.#fogNear = range.near;
    view.setFogRange(range.near, range.far);
  }

  /**
   * SPEC-035 §4.5 — every 0.1 s, test the props within 30 m of the player with
   * the pure `occludes` and hand the flags to the view, which walks the fades.
   */
  #updateOccluders(dt: number, player: { x: number; z: number }): void {
    const view = this.#view;
    // SPEC-054 §4.4: the props are the surface's; below there is nothing to fade.
    if (view === null || this.#level?.id !== 'surface') return;
    const props = view.occluderProps;
    if (props.length === 0) return;
    if (this.#occluderFlags.length !== props.length) {
      this.#occluderFlags = new Uint8Array(props.length);
      view.setOccluding(this.#occluderFlags, OCCLUDER_OPACITY);
    }
    this.#occluderIn -= dt;
    if (this.#occluderIn > 0) return;
    this.#occluderIn = OCCLUDER_TEST_SECONDS;
    const camera = this.camera.position;
    for (let i = 0; i < props.length; i++) {
      const prop = props[i] as (typeof props)[number];
      const dx = prop.x - player.x;
      const dz = prop.z - player.z;
      const near = dx * dx + dz * dz <= OCCLUDER_RANGE * OCCLUDER_RANGE;
      this.#occluderFlags[i] = near && occludes(camera, player, prop) ? 1 : 0;
    }
  }

  /**
   * SPEC-035 §4.2 — walk `#camDistance` toward the scheme's distance over
   * `CAMERA_DISTANCE_EASE_SECONDS`. Reduce motion snaps (35-j).
   */
  #easeCameraDistance(dt: number): void {
    if (this.#camEase >= 1) return;
    this.#camEase = Math.min(1, this.#camEase + dt / CAMERA_DISTANCE_EASE_SECONDS);
    this.#camDistance = this.#camDistanceFrom + (this.#camDistanceTo - this.#camDistanceFrom) * this.#camEase;
  }

  /**
   * §4.2: a scheme change starts the ease; `snap` puts it there at once.
   * SPEC-037 §4.7: the distance is the scheme's *and* the screen's — a touched
   * tablet keeps the desktop's 22 m — so a resize runs through here too.
   */
  #setCameraScheme(scheme: Scheme, snap: boolean): void {
    const target = cameraDistance(scheme, Math.min(this.#viewWidth, this.#viewHeight));
    if (target === this.#camDistanceTo && this.#camEase >= 1) return;
    this.#camDistanceTo = target;
    if (snap || this.services.settings.get().reduceMotion) {
      this.#camDistanceFrom = target;
      this.#camDistance = target;
      this.#camEase = 1;
      return;
    }
    this.#camDistanceFrom = this.#camDistance;
    this.#camEase = 0;
  }

  #placeCamera(biasX: number, biasZ: number): void {
    const d = this.#camDistance;
    const x = this.#camTarget.x + d * Math.cos(CAMERA_PITCH) * Math.sin(CAMERA_YAW);
    const y = d * Math.sin(CAMERA_PITCH);
    const z = this.#camTarget.z + d * Math.cos(CAMERA_PITCH) * Math.cos(CAMERA_YAW);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.#camTarget.x + biasX, 0, this.#camTarget.z + biasZ);
    this.camera.updateMatrixWorld();
    this.#frustumMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.#frustum.setFromProjectionMatrix(this.#frustumMatrix);
    this.#camBias.x = biasX;
    this.#camBias.z = biasZ;
    const view = this.#frustumView;
    view.x = this.#camTarget.x + biasX;
    view.z = this.#camTarget.z + biasZ;
    view.distance = d;
    view.fov = this.camera.fov;
    view.aspect = this.camera.aspect;
    // SPEC-019 §4.7: the shake lands after the frustum capture, so spawn
    // culling is bit-identical to an unshaken frame (AC-92). Camera and
    // look-at target move by the same vector, so only the position changes —
    // the orientation, and with it the aim ray, is untouched.
    const time = this.#viewTimeNow();
    // SPEC-045 §4.3: both scale by Camera shake, and at 0 (which reduce motion
    // sets) both are exactly zero.
    const cameraShake = this.services.settings.get().cameraShake;
    shakeOffset(this.#shake, time, cameraShake, this.#shakeScratch);
    // SPEC-015 AC-41: the walk bob joins the shake on the same side of the
    // frustum capture.
    this.#shakeScratch.y += cameraBob(this.#camSpeed, time, cameraShake);
    if (this.#shakeScratch.lengthSq() > 0) {
      this.camera.position.add(this.#shakeScratch);
      this.camera.updateMatrixWorld();
    }
  }

  // --------------------------------------------------------------- shelter

  /**
   * SPEC-030 §4.5, each step: where the player stands, what that does to the
   * weather multiplier and the HUD chip, the roof lift, discovery, and the
   * first-entry tip. Death drops `inside` (the roof comes back, 30-e).
   */
  #updateShelter(world: CombatWorld): void {
    // SPEC-054 §4.1: the active level's shelters — none below.
    const level = this.#level as Level;
    const combat = this.#combat as Combat;
    const save = this.#save as Save;
    const p = world.player;
    const inside = p.alive ? shelterAt(level.shelters, p.x, p.z) : null;
    const was = this.#insideShelter;
    this.#insideShelter = inside;

    // D-6: entering pins the move multiplier at 1; leaving restores the storm
    // active at that moment (1 when calm) — never a value captured on entry.
    // SPEC-043 §4.3: under `no_cover` the pin is off, inside and out.
    if (inside !== null && was === null) {
      combat.setWeatherMoveMult(this.#weatherMoveMult());
      this.#requestTip('shelter'); // §4.11: once, on the first entry
    } else if (inside === null && was !== null) {
      combat.setWeatherMoveMult(this.#weatherMoveMult());
    }

    // AC-25: hidden ⇔ inside ∧ no shot for REVEAL_AFTER_SHOT — and SPEC-050
    // §4.3 (50-e): not loud; a player who runs into a cave is heard for 1.5 s.
    world.playerHidden = isHidden(inside !== null, world.time, combat.lastShotAt, p.loudUntil);
    this.#shelterState = inside === null ? 'none' : world.playerHidden ? 'hidden' : 'sheltered';
    this.#view?.setOccupiedShelter(inside?.index ?? null);

    // §4.10 (D-23): discovery — the POI check's 40 m, per step, persisted in
    // the same `poisDiscovered` array the autosaves already carry.
    for (let i = 0; i < level.shelters.length; i++) {
      if (this.#shelterDiscovered[i] === true) continue;
      const s = level.shelters[i] as LayoutShelter;
      if (Math.hypot(p.x - s.x, p.z - s.z) > DISCOVER_RANGE) continue;
      this.#shelterDiscovered[i] = true;
      const key = `${this.#planet.id}:shelter:${s.index}`;
      if (!save.progress.poisDiscovered.includes(key)) save.progress.poisDiscovered.push(key);
    }
  }

  // --------------------------------------------------------------- weather

  #updateWeather(world: CombatWorld, dt: number): void {
    const weather = this.#weather as Weather;
    const missions = this.#missions as Missions;

    // AC-26 / 12-i: an active survive stage forces its storm, after the grace.
    // SPEC-054 §4.9 (E83): not below — a stage that starts there forces its
    // storm on the ascent, with its waves and its clock. E15: an engaged
    // arena outranks it — not merely another mission's boss stage, which
    // once let a survive stage run (and its `no_shelter` bonus pay) in calm
    // weather (review 2026-10, B-09).
    const below = this.#level?.id === 'underground';
    const required = missions.requiredWeather();
    if (
      required !== null &&
      !below &&
      this.elapsed >= FORCED_WEATHER_GRACE &&
      weather.current !== required.weather &&
      this.#bossId === null
    ) {
      weather.force(required.weather, required.seconds);
    }

    weather.update(dt);

    // SPEC-038 §4.5: what the open deals — the forced storm's ramp and the
    // planet's multiplier on top of `dps`, which keeps its SPEC-012 meaning.
    const dps = weather.exposureDps;
    // SPEC-030 D-7: inside a shelter, weather damage is skipped entirely —
    // cycled storm, forced storm and avalanche burst alike (AC-20). SPEC-043
    // §4.3 (43-f): not under `no_cover` — the storm reaches the player inside.
    // SPEC-054 §4.4: below, nothing of the storm reaches the player; its clock runs on above.
    if (dps > 0 && world.player.alive && weather.current !== null && !below && (this.#insideShelter === null || this.#noCover)) {
      // Combat applies hazardResist and the hazard-immunity window (§4.6).
      this.#combat?.damagePlayer(dps * dt, { kind: 'weather', weather: weather.current }, true);
    }

    // Lerp the visual/aggro response toward the current phase over 3 s.
    const step = dt / WEATHER_LERP_SECONDS;
    if (this.#stormIntensity < this.#stormTarget) this.#stormIntensity = Math.min(this.#stormTarget, this.#stormIntensity + step);
    else if (this.#stormIntensity > this.#stormTarget) this.#stormIntensity = Math.max(this.#stormTarget, this.#stormIntensity - step);
    // SPEC-030 D-5: inside, the overlay and the view intensity are dampened
    // ×0.25 — cosmetic only; fog density and aggroMult keep their storm values.
    const shelterFactor = this.#insideShelter === null ? 1 : STORM_SHELTER_FACTOR;
    const shown = below ? 0 : this.#stormIntensity;
    this.#view?.setWeather(this.#stormEffects, shown * shelterFactor, shown);
    if (this.#stormOverlay !== null) {
      const mean = (1 - this.#stormEffects.visibility) * shown * shelterFactor;
      // SPEC-015 AC-43: the sheet breathes around that mean, and reduce motion
      // holds it exactly at the mean with the flicker term gone.
      const opacity = stormOverlayOpacity(mean, this.#viewTimeNow(), this.services.settings.get().reduceMotion);
      this.#stormOverlay.style.opacity = opacity < 0.02 ? '0' : String(opacity);
    }
    // §4.6: visibility narrows enemy aggro.
    world.aggroMult = 1 - (1 - this.#stormEffects.visibility) * shown;
    this.#stepStormLoop(dt);
  }

  /**
   * SPEC-035 §4.11 — `storm_loop` runs while a storm is active, fading in and
   * out over half a second. The voice is the scene's own continuous channel, so
   * it is stopped once the fade reaches zero and on the way out of the scene.
   */
  #stepStormLoop(dt: number): void {
    // SPEC-054 §4.4, §4.12: below, the storm loop stays at 0 — and on Eden the
    // channel carries the machine room's hum instead, which adds no sound.
    const below = this.#level?.id === 'underground';
    const hum = below && this.#caveDef.machineRoom === true;
    const target = below ? (hum ? HUM_VOLUME : 0) : this.#stormLoopTarget;
    const step = dt / STORM_LOOP_FADE_SECONDS;
    if (this.#stormLoopVolume < target) this.#stormLoopVolume = Math.min(target, this.#stormLoopVolume + step);
    else if (this.#stormLoopVolume > target) this.#stormLoopVolume = Math.max(target, this.#stormLoopVolume - step);
    if (this.#stormLoopVolume <= 0) {
      this.#stopStormLoop();
      return;
    }
    if (this.#stormVoice === null) {
      this.#stormSound = hum ? 'film_hum' : 'storm_loop';
      this.#stormVoice = this.services.audio.play(this.#stormSound, { loop: true, priority: 0, volume: this.#stormLoopVolume });
      return;
    }
    this.#stormVoice.setVolume(this.#stormLoopVolume);
  }

  #stopStormLoop(): void {
    this.#stormVoice?.stop();
    this.#stormVoice = null;
  }

  // ------------------------------------------------------------------ POIs

  #missionContext(world: CombatWorld): MissionContext {
    const ctx = this.#ctx as MissionContext;
    this.#ctxPlayer.x = world.player.x;
    this.#ctxPlayer.z = world.player.z;
    this.#ctxPlayer.alive = world.player.alive;
    // SPEC-043 §4.2: inside a cave or a wreck — what forfeits `no_shelter`.
    // SPEC-054 §4.11: below counts as sheltered, and its timers hold (E83).
    const below = this.#level?.id === 'underground';
    ctx.sheltered = below || this.#insideShelter !== null;
    ctx.level = below ? 'underground' : 'surface';
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

    // SPEC-054 §4.1: the active level's POIs — none below, so a cave position
    // at a surface POI's coordinates discovers and reaches nothing.
    for (const state of (this.#level as Level).pois) {
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
    // SPEC-054 §4.1: the press goes to the level's nearest interactable — the
    // pad, the descent, the exit or a cache.
    if (this.#edges.pressed('interact') && this.#modalOpen === 0) {
      if (this.#terminalOpen) this.#closeTerminal();
      else if (player.alive) this.#interact(world);
    }
    if (this.#terminalOpen && (!atPad || !player.alive)) this.#closeTerminal();
  }

  /** SPEC-054 §4.1: `interact` on the level's interactable under the player, if any. */
  #interact(world: CombatWorld): void {
    const level = this.#level;
    if (level === null || this.#deathAt !== null || this.#leaving) return;
    const p = world.player;
    const target = nearestInteractable(level.interactables, p.x, p.z);
    if (target === null) return;
    switch (target.kind) {
      case 'pad':
        this.#openTerminal();
        return;
      case 'descent':
        // §4.2: a refused descent is not an action — the prompt says why.
        if (this.#descentRefusal(false) === null) void this.#swapLevel('underground');
        return;
      case 'exit':
        void this.#swapLevel('surface');
        return;
      case 'cache':
        this.#openCache(target, world);
        return;
      // SPEC-058 §4.5: the predecessor's body pays its cache once.
      case 'body':
        this.#searchBody(world);
        return;
      // SPEC-055 §4.4, §4.6: a terminal opens its panel, a panel reads, a mirror turns.
      case 'vault':
      case 'relic':
      case 'mirror':
      case 'panel':
        this.#puzzles?.interact(target);
        return;
      default:
        return;
    }
  }

  #atPad(world: CombatWorld): boolean {
    // SPEC-054 §4.1: the active level's terminal — none below.
    const pad = this.#level?.terminal ?? null;
    if (pad === null) return false;
    return Math.hypot(world.player.x - pad.x, world.player.z - pad.z) <= pad.radius;
  }

  // ------------------------------------------------------------ boss arena

  #updateBossArena(world: CombatWorld): void {
    const missions = this.#missions as Missions;
    const nest = this.#level?.arena ?? null;
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
    if (this.#bossId === null && d <= this.#arenaRadius && p.alive) {
      const boss = this.#combat?.spawnEnemy(wanted, nest.x, nest.z, false);
      if (boss !== undefined) {
        // SPEC-039 §4.1: the boss of a replayed stage pays half its XP and the
        // fallback lithium instead of its piece (D6: no mission, no replay).
        const mission = missions.bossStageMission();
        boss.replay = mission !== null && missions.isReplay(mission);
        this.#bossId = boss.id;
        this.#arena = { x: nest.x, z: nest.z, radius: this.#arenaRadius, locked: true, sealed: false };
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
      } else if (d > ARENA_DISENGAGE_DISTANCE && !boss.aggro && !this.#arena.sealed) {
        world.arena = null;
      }
      // SPEC-041 §4.4: the first step the player's whole circle is inside the
      // ring while the boss lives, the ring seals — until the boss dies, the
      // player dies, or Recall takes them to the pad.
      if (!this.#arena.sealed && p.alive && d + p.radius <= this.#arena.radius) {
        this.#arena.sealed = true;
        world.arena = this.#arena;
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
    // SPEC-042 §4.1: a banner already up hides from this frame, not the next step's.
    this.#banner?.tick(0, true);
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

  // ---------------------------------------------------------------- defend

  /** Wave + POI HP for an active defend stage (§4.7; none on Cinder-4). */
  #syncDefend(): void {
    // SPEC-054 §4.9 (E83): a defence waits for the surface.
    if (this.#level?.id === 'underground') return;
    const missions = this.#missions as Missions;
    const stage = missions.defendStage();
    const spawn = this.#spawn as SpawnDirector;
    if (stage === null) {
      // SPEC-034 §4.6, E57: a defence that is over sends its survivors away, so
      // the line that follows it ("Rest") is not read over a straggler still
      // chewing on the beacon. A restart (`#dismissDefendWave` false) keeps them.
      if (this.#defendWave !== null) spawn.stopWave(this.#defendWave, { dismiss: this.#dismissDefendWave });
      this.#dismissDefendWave = false;
      this.#defendWave = null;
      this.#defendPoi = null;
      return;
    }
    this.#dismissDefendWave = false;
    // SPEC-054 §4.9: a defence is the surface's — it waits there while the player is below.
    const poi = (this.#levels as { surface: Level }).surface.layout.pois.find((p) => p.poi === stage.poi) ?? null;
    this.#defendPoi = poi;
    this.#defendMax = this.#planet.surface.pois.find((p) => p.id === stage.poi)?.hp ?? 100;
    this.#defendHp = this.#defendMax;
    if (this.#defendWave !== null) spawn.stopWave(this.#defendWave);
    this.#defendWave = spawn.startWave(stage.wave, poi === null ? 'player' : { x: poi.x, z: poi.z });
  }

  #updateDefend(world: CombatWorld, dt: number): void {
    const poi = this.#defendPoi;
    if (poi === null || this.#defendHp <= 0) return;
    // SPEC-059 §4.2.2: on story the structure takes no enemy damage.
    if (DIFFICULTY_RULES[this.#save?.meta.difficulty ?? 'normal'].allyDamageMult === 0) return;
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
    // SPEC-054 §4.9 (E83): the follower waits for the surface.
    if (this.#level?.id === 'underground') return;
    const world = this.#world as CombatWorld;
    const stage = (this.#missions as Missions).escortStage();
    if (stage === null) {
      world.follower = null;
      this.#followerRespawnIn = 0;
      return;
    }
    const from = (this.#levels as { surface: Level }).surface.layout.pois.find((p) => p.poi === stage.from);
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
        // SPEC-042 §4.1: a banner still up hides at once, and lets the
        // dialogue go for the ending's own line.
        this.#banner?.tick(0, true);
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
      // SPEC-058 §4.7: the Selection card stamps the next number with the
      // player's own name, and only after it is the ending seen — a reload
      // during it replays the film, the report and the card at the station.
      // SPEC-059 §4.5.5: with the run's own card to share, drawn as it mounts.
      await overlay.playSelectionCard(
        {
          number: instanceNumber(save.meta.iteration) + 1,
          name: save.player.name,
          portrait: save.player.appearance.portrait,
        },
        prepareSaveCard(save, services.settings.get().commendations),
      );
      if (!this.#alive) return;
      save.progress.endingSeen = true;
      services.save.request('mission');
      this.#endEnding();
      return;
    }
    // SPEC-058 §4.7: the veil names this run's own instance.
    await overlay.playEscape(save.meta.iteration);
    if (!this.#alive) return;
    save.progress.endingSeen = true;
    // SPEC-059 §4.1.1: the escape leaves no planet to resume on.
    save.progress.resume = null;
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
    const touch = this.services.input.state.scheme === 'touch';

    // The ring first, so a tap made between steps lands before this step's keys.
    const queued = this.#qbLength;
    this.#qbLength = 0;
    for (let i = 0; i < queued; i++) {
      const command = this.#qbRing[i] as QuickBarCommand;
      const slot = command.slot;
      if (command.kind === 'pick') {
        if (slot !== 'sidearm' && slot !== 'primary' && slot !== 'heavy') this.#openPicker(slot);
      } else if (slot === 'heavy' && touch) {
        // SPEC-036 §4.6: on touch the launcher's slot fires it — one charge,
        // the weapon in hand unchanged — instead of selecting a slot auto-fire
        // never reaches.
        this.#tapLauncher(combat);
      } else if (slot === 'sidearm' || slot === 'primary' || slot === 'heavy') {
        loadout.select(slot, time);
      } else {
        this.#useQuick(slot);
      }
    }

    if (this.#edges.pressed('weapon1')) loadout.select('sidearm', time);
    if (this.#edges.pressed('weapon2')) loadout.select('primary', time);
    if (this.#edges.pressed('weapon3')) loadout.select('heavy', time);
    // SPEC-036 §4.6: SWAP on touch walks past the heavy, which its tap fires.
    if (this.#edges.pressed('weaponNext')) loadout.cycle(1, time, touch);
    if (this.#edges.pressed('weaponPrev')) loadout.cycle(-1, time, touch);
    if (this.#edges.pressed('useItem')) this.#useQuick('heal');
    if (this.#edges.pressed('throwItem')) this.#useQuick('explosive');
    if (this.#edges.pressed('useUtility')) this.#useQuick('utility');
  }

  /**
   * SPEC-036 §4.6: the launcher tap on touch — one charge at the auto-target,
   * or 10 m ahead with none (36-k). A launcher with no charge fires nothing and
   * says so at most once per 3 s (36-j); no launcher at all is silence.
   */
  #tapLauncher(combat: Combat): void {
    if (combat.fireSlotOnce('heavy') === 'not-ready') this.#quickToast(LAUNCHER_RECHARGING_TEXT);
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
      this.#quickToast(HP_FULL_TEXT);
      return;
    }
    // SPEC-029 §4.8: the explosive slot throws or plants instead of applying.
    if (slot === 'explosive') {
      const item = ITEM_TABLE[id];
      if (item.kind !== 'consumable' || item.effect.kind !== 'explosive') return;
      this.#useExplosive(id, item.effect);
      return;
    }
    const gadget = ITEM_TABLE[id];
    if (gadget.kind === 'consumable') {
      // SPEC-056 §4.5: a flare is thrown as a frag is, not applied…
      if (gadget.effect.kind === 'light') {
        this.#throwFlare(id, gadget.effect);
        return;
      }
      // …and a stim at a full pool that is not exhausted is refused, unspent (56-g).
      if (gadget.effect.kind === 'stamina' && staminaFull(world.player)) {
        this.#quickToast(STAMINA_FULL_TEXT);
        return;
      }
    }

    const result = economy.useConsumable(id);
    if (!result.ok) return;
    combat.applyConsumable(result.effect);
    this.services.events.emit('quick:used', { slot, itemId: id });
    // §4.4: the id stays when nothing replaces it, so the bar reads `×0`.
    if (economy.count(id) === 0) save.quick[slot] = refillQuick(save, slot) ?? id;
  }

  /**
   * SPEC-029 §4.8: where a throw lands — the aim point (keyboard) or the
   * nearest enemy with a clear line (touch), else 8 m along the facing —
   * clamped to `range` along the aim direction (29-f). Into `#throwAt`.
   */
  #throwTarget(world: CombatWorld, range: number): { x: number; z: number } {
    const p = world.player;
    const out = this.#throwAt;
    const scheme = this.services.input.state.scheme;
    const aim = scheme === 'touch' ? null : this.#aimWorld(world);
    if (aim !== null) {
      out.x = aim.x;
      out.z = aim.z;
    } else {
      const target = scheme === 'touch' ? this.#clearThrowTarget(world, range) : null;
      if (target !== null) {
        out.x = target.x;
        out.z = target.z;
      } else {
        out.x = p.x + Math.cos(p.facing) * 8;
        out.z = p.z + Math.sin(p.facing) * 8;
      }
    }
    const dx = out.x - p.x;
    const dz = out.z - p.z;
    const len = Math.hypot(dx, dz);
    if (len > range) {
      out.x = p.x + (dx / len) * range;
      out.z = p.z + (dz / len) * range;
    }
    return out;
  }

  /**
   * SPEC-056 §4.5: a flare from the utility slot — aimed as a frag is
   * (`#throwTarget`, clamped to its 12 m), waiting out the same 0.5 s, and
   * spending one only when it flies.
   */
  #throwFlare(id: ItemId, effect: LightEffect): void {
    const world = this.#world;
    const combat = this.#combat;
    const economy = this.#economy;
    const save = this.#save;
    if (world === null || combat === null || economy === null || save === null) return;
    if (world.time < this.#throwReadyAt) return;
    const at = this.#throwTarget(world, effect.range);
    if (!combat.throwFlare(effect, at.x, at.z)) return;
    economy.useConsumable(id);
    this.#throwReadyAt = world.time + EXPLOSIVE_USE_SECONDS;
    this.services.events.emit('quick:used', { slot: 'utility', itemId: id });
    // §4.4: the id stays when nothing replaces it, so the bar reads `×0`.
    if (economy.count(id) === 0) save.quick.utility = refillQuick(save, 'utility') ?? id;
  }

  /**
   * SPEC-029 §4.8: throw toward the aim point (keyboard) or the nearest enemy
   * with a clear line (touch), clamped to range; plant a mine or a charge at
   * the player's feet. Any use waits 0.5 s after the last and spends exactly
   * one item — a refused deploy spends nothing.
   */
  #useExplosive(id: ItemId, effect: ExplosiveEffect): void {
    const world = this.#world;
    const combat = this.#combat;
    const economy = this.#economy;
    const save = this.#save;
    if (world === null || combat === null || economy === null || save === null) return;
    if (world.time < this.#throwReadyAt) return;
    const p = world.player;
    if (effect.mode === 'throw') {
      const at = this.#throwTarget(world, effect.range ?? 12);
      combat.throwExplosive(effect, at.x, at.z);
    } else {
      const result = combat.deploy(effect, p.x, p.z);
      if (result !== 'ok') {
        this.#quickToast(result === 'mine_limit' ? 'Mine limit reached' : 'Too many explosives placed');
        return;
      }
    }
    economy.useConsumable(id);
    this.#throwReadyAt = world.time + EXPLOSIVE_USE_SECONDS;
    this.services.events.emit('quick:used', { slot: 'explosive', itemId: id });
    // §4.4: the id stays when nothing replaces it, so the bar reads `×0`.
    if (economy.count(id) === 0) save.quick.explosive = refillQuick(save, 'explosive') ?? id;
  }

  /** §4.8 (touch): the nearest live enemy within `range` with a clear line. */
  #clearThrowTarget(world: CombatWorld, range: number): EnemyEntity | null {
    const p = world.player;
    let best: EnemyEntity | null = null;
    let bestD = Infinity;
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.state === 'dead' || isBuried(e)) continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (d > range || d >= bestD) continue;
      if (!world.obstacles.lineClear(p.x, p.z, e.x, e.z)) continue;
      best = e;
      bestD = d;
    }
    return best;
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
      // SPEC-037 §4.1: on touch it opens over the arc, on the arc's side.
      this.services.settings.joystickSide,
    );
  }

  // ----------------------------------------------------------------- death

  /** §4.8 — runs every step, modal or not; the overlay is not a freeze. */
  #deathTick(world: CombatWorld, dt: number): void {
    if (this.#deathAt === null) return;
    this.#deathAt += dt;
    // SPEC-042 §4.5: a press respawns only after the overlay has been up 1 s —
    // a held trigger no longer skips the cause unread. A press before that is
    // dropped with its step; the 2.5 s auto-respawn is unchanged.
    const tapped =
      this.#deathAt >= DEATH_SKIP_GUARD_SECONDS && (this.#edges.pressed('interact') || this.#edges.pressed('fire'));
    // SPEC-041 §4.4, E63: a death in an active boss stage comes back at the
    // arena's mouth instead of a 110–160 m walk from the pad.
    if (this.#deathAt >= DEATH_OVERLAY_SECONDS || tapped) {
      // SPEC-057 §4.3: read as it stood at the death, where the remains were
      // placed — a mine that kills the boss under the overlay must not send the
      // respawn to the pad while the remains wait at the arena's mouth.
      this.#respawn(world, this.#respawnAtArena ? 'arena' : 'pad');
    }
  }

  /**
   * SPEC-041 §4.4, E63: the arena entrance — on the line from the nest to the
   * pad, `radius + ARENA_RESPAWN_OUTSET` m out, on the corridor the layout
   * keeps clear (E17) — written into `out`, with the facing toward the nest.
   */
  #arenaEntrance(out: { x: number; z: number; facing: number }): boolean {
    // SPEC-054 §4.1: a respawn is always on the surface.
    const nest = this.#levels?.surface.arena ?? null;
    const pad = this.#levels?.surface.pad ?? null;
    if (nest === null || pad === null) return false;
    const dx = pad.x - nest.x;
    const dz = pad.z - nest.z;
    const len = Math.hypot(dx, dz);
    const ux = len > 1e-6 ? dx / len : 1;
    const uz = len > 1e-6 ? dz / len : 0;
    const reach = this.#arenaRadius + ARENA_RESPAWN_OUTSET;
    out.x = nest.x + ux * reach;
    out.z = nest.z + uz * reach;
    out.facing = Math.atan2(-uz, -ux);
    return true;
  }

  readonly #respawnAt = { x: 0, z: 0, facing: 0 };

  /**
   * §4.8: E4's respawn — the sweep, the boss reset and the arena clear, full
   * HP and 2 s of i-frames. SPEC-041 §4.4: `at` picks the pad, or the arena
   * entrance for a death in a boss stage (E63); a recall always takes the pad.
   * The sweep runs around wherever the player comes back.
   */
  #respawn(world: CombatWorld, at: 'pad' | 'arena'): void {
    // SPEC-054 §4.1, §4.9: the respawn reads the surface explicitly — a death
    // or a recall below has already brought the player up (E84).
    // E84: a death below comes up first — the swap's synchronous part, under the overlay.
    if (this.#level?.id === 'underground') this.#applySwap(world, 'surface');
    const layout = (this.#levels as { surface: Level }).surface.layout;
    this.#deathAt = null;
    if (this.#terminalOpen) this.#closeTerminal();
    const spot = this.#respawnAt;
    if (at !== 'arena' || !this.#arenaEntrance(spot)) {
      spot.x = layout.playerSpawn.x;
      spot.z = layout.playerSpawn.z;
      spot.facing = layout.playerSpawn.facing;
    }

    // §4.8 step 2: the sweep, the boss reset, the timed stages (via the event).
    this.#despawnedAtDeath = this.#spawn?.despawnNear(spot.x, spot.z, DEATH_DESPAWN_RADIUS) ?? 0;
    const boss = this.#findBoss(world);
    if (boss !== null) boss.state = 'dead'; // silent — no loot, no defeat event
    this.#bossId = null;
    // E31: a reveal still waiting on a dialogue dies with the boss. Its session
    // key stays taken, so walking back in spawns the boss and nothing else.
    this.#revealPending = null;
    // SPEC-041 §4.4: a death or a recall opens the seal with the arena.
    if (this.#arena !== null) this.#arena.sealed = false;
    world.arena = null;
    this.#arena = null;
    this.#weather?.suppress(false);
    if (this.#defendPoi !== null) this.#syncDefend(); // wave restarts, HP refills
    // SPEC-034 §4.8: a mission-level wave restarts with its mission's stage.
    this.#restartMissionWaves();
    // SPEC-038 §4.5 (38-i): the storm wave starts again with the stage.
    this.#restartStormWave();

    // §4.8 step 3.
    const p = world.player;
    p.x = spot.x;
    p.z = spot.z;
    p.vx = 0;
    p.vz = 0;
    p.facing = spot.facing;
    p.hp = world.stats.maxHp;
    p.alive = true;
    p.invulnUntil = world.time + TUNING.INVULN_AFTER_RESPAWN;
    p.fireCooldown = 0;
    p.healOverTime = null;
    p.boosts.length = 0;
    p.hazardImmuneUntil = 0;
    // SPEC-038 §4.1: a respawn or a recall resets the dash.
    p.dashReadyAt = 0;
    p.dashUntil = -Infinity;
    // SPEC-050 §4.1 (50-c): and the stamina — full, quiet, the gun drawn, and
    // no ring to show for it.
    resetStamina(p);
    this.#sprintLatch = false;
    this.#staminaFullFor = STAMINA_FULL_HIDE_SECONDS;
    const save = this.#save as Save;
    save.player.hp = p.hp;
    this.#camTarget.x = p.x;
    this.#camTarget.z = p.z;
    this.#placeCamera(0, 0);
    this.#death?.hide();
    this.#restartsSet = false;
    this.services.events.emit('player:respawned');
  }

  // ---------------------------------------------------- SPEC-057: remains

  /**
   * §4.3 (E92): where a death's remains lie, into `#remainsAt`. The start is
   * SPEC-054's descent for a death below (the handler runs while the level is
   * still `underground`; the swap waits for the respawn), else E63's arena
   * entrance while a boss stage is active — the respawn's own condition, so
   * the respawn stands on them — else where the salvager fell. Pushed clear of
   * the surface level's obstacles and clamped inside ±(halfSize − 3).
   */
  #placeRemains(world: CombatWorld): void {
    const surface = this.#levels?.surface ?? null;
    const missions = this.#missions;
    if (surface === null) {
      this.#respawnAtArena = false;
      this.#remainsAt.x = world.player.x;
      this.#remainsAt.z = world.player.z;
      return;
    }
    const descent = this.#level?.id === 'underground' ? this.#descent : null;
    // SPEC-041 E63's own test, taken once here and kept for `#deathTick`, so
    // the respawn always lands where the remains were placed (§4.3, §4.4).
    const boss = missions !== null && missions.bossStage() !== null && surface.arena !== null;
    this.#respawnAtArena = boss;
    const entrance = boss && this.#arenaEntrance(this.#remainsEntrance) ? this.#remainsEntrance : null;
    placeRemains(
      world.player,
      { obstacles: surface.grid, halfSize: surface.layout.halfSize, arenaEntrance: entrance, descent },
      this.#remainsAt,
    );
  }

  /**
   * §4.1 step 4 (E91): unless the difficulty takes nothing (casual, story),
   * forfeit whatever set lies anywhere — `remains:lost` and its toast — and
   * leave this death's loss at the placed point (`remains:created`). Returns
   * the overlay's line, or `null` when nothing was left (a zero `deathLoss`,
   * or an empty hold).
   */
  #dropRemains(lost: Partial<Record<ResourceId, number>>): string | null {
    const save = this.#save;
    const world = this.#world;
    if (save === null || world === null) return null;
    // §2: casual takes nothing, so nothing is at stake — neither created nor
    // forfeited. SPEC-059 §4.2.2: nor does story; a zero `deathLoss` leaves none.
    if (DIFFICULTY_RULES[save.meta.difficulty].deathLoss <= 0) return null;
    // `watchRunStats` placed it a moment ago; placing again reads the same inputs.
    this.#placeRemains(world);
    const planet = this.#planet.id;
    const look = this.#remainsLook;
    const { created, forfeited } = dropRemains(save, planet, this.#remainsAt, lost);
    const bus = this.services.events;
    if (forfeited !== null) {
      bus.emit('remains:lost', { planet: forfeited.planet, resources: forfeited.resources });
      bus.emit('ui:toast', { kind: 'warn', text: remainsLostText(look, forfeited.resources) });
    }
    if (created !== null) {
      bus.emit('remains:created', { planet, x: created.x, z: created.z, resources: created.resources });
    }
    this.#remainsInside = false;
    this.#syncRemains();
    return created === null ? null : remainsOverlayLine(look, created.resources);
  }

  /**
   * §4.5: the view, the tag's words and whether the map and the tracker show
   * the remains — only when they lie on this planet and the surface level is
   * the active one. Runs at entry, after a drop or a recovery, and at a swap.
   */
  #syncRemains(): void {
    const save = this.#save;
    const remains = save?.progress.remains ?? null;
    const here = save !== null && remains !== null && remains.planet === this.#planet.id && this.#level?.id !== 'underground';
    this.#remainsHere = here;
    if (!here) {
      this.#view?.setRemains(null);
      this.#remainsTag?.hide();
      this.#remainsRowText = null;
      this.#remainsRowMetres = -1;
      return;
    }
    const { primary, secondary } = save.player.appearance;
    this.#view?.setRemains({ x: remains.x, z: remains.z, look: this.#remainsLook, primary, secondary });
    this.#remainsTag?.setText(remainsTag(save, remains, this.#remainsLook));
  }

  /**
   * §4.4 (E93): a living player on the surface level of the remains' planet
   * recovers them on the step they come within `REMAINS_RECOVER_RADIUS`, then
   * every `REMAINS_RETRY_SECONDS` while inside if any are left. Allocates
   * nothing unless a recovery runs, and that writes into a reused record.
   */
  #stepRemains(world: CombatWorld, dt: number): void {
    const save = this.#save;
    const remains = save?.progress.remains ?? null;
    const p = world.player;
    if (save === null || remains === null || !this.#remainsHere || !p.alive) {
      this.#remainsInside = false;
      return;
    }
    const dx = p.x - remains.x;
    const dz = p.z - remains.z;
    if (dx * dx + dz * dz > REMAINS_RECOVER_RADIUS * REMAINS_RECOVER_RADIUS) {
      this.#remainsInside = false;
      return;
    }
    if (!this.#remainsInside) {
      this.#remainsInside = true;
      this.#remainsRetryIn = 0;
      this.#remainsFullSaid = false;
    }
    this.#remainsRetryIn -= dt;
    if (this.#remainsRetryIn > 0) return;
    this.#remainsRetryIn = REMAINS_RETRY_SECONDS;
    this.#recoverRemains(save);
  }

  /**
   * §4.4: the hold takes what fits (`'recovered'`: cap-charged, never shipped,
   * never `blocked`); a recovery that took a unit emits `remains:recovered` —
   * whose `pickup_generic` is the sound, and which `watchRunStats` counts into
   * `stats.recoveries` — toasts it, and checkpoints the save.
   */
  #recoverRemains(save: Save): void {
    const economy = this.#economy;
    const planet = save.progress.remains?.planet ?? null;
    if (economy === null || planet === null) return;
    const taken = this.#remainsTaken;
    if (!recoverRemains(save, economy, taken)) {
      // E93 (review 2026-10, B-21): nothing fit, and a 'recovered' unit never
      // flags `blocked`, so nothing else says why. Once per stay inside the
      // circle — the 1 s retries do not repeat it.
      const left = remainsHeld(save.progress.remains);
      if (left > 0 && !this.#remainsFullSaid) {
        this.#remainsFullSaid = true;
        this.services.events.emit('ui:toast', { kind: 'warn', text: remainsFullText(this.#remainsLook, left) });
      }
      return;
    }
    const rest = save.progress.remains !== null;
    const bus = this.services.events;
    bus.emit('remains:recovered', { planet, resources: taken });
    bus.emit('ui:toast', { kind: 'good', text: remainsRecoveredText(this.#remainsLook, taken, rest) });
    this.services.save.request('checkpoint');
    this.#syncRemains();
  }

  /**
   * §4.6: the tag over the remains while they are on screen and within 30 m —
   * hidden while a beat or the map owns the screen, as the stamina ring is.
   */
  #renderRemainsTag(world: CombatWorld): void {
    const tag = this.#remainsTag;
    const remains = this.#save?.progress.remains ?? null;
    if (tag === null) return;
    if (!this.#remainsHere || remains === null || this.#uiHolds > 0 || this.#holds > 0) {
      tag.hide();
      return;
    }
    const p = world.player;
    if (Math.hypot(remains.x - p.x, remains.z - p.z) > REMAINS_TAG_RANGE) {
      tag.hide();
      return;
    }
    // Behind the camera or off the canvas: no tag.
    const behind = this.#projectGuide(remains.x, remains.z, REMAINS_TAG_LIFT);
    const x = this.#screenPoint.x;
    const y = this.#screenPoint.y;
    if (behind || x < 0 || y < 0 || x > this.services.renderer.width || y > this.services.renderer.height) {
      tag.hide();
      return;
    }
    tag.show(x, y);
  }

  // ------------------------------------------- SPEC-058: the predecessor

  /**
   * §4.5 (58-d, 58-e): where `lineage[0]`'s body lies on this planet, on a
   * landing of iteration ≥ 2 — its last death here (SPEC-057 already placed
   * that at an arena's entrance or a descent), else on Cinder-4 6 m from the
   * pad toward the spawn, else nowhere — pushed clear of the surface level's
   * obstacles through SPEC-057's `placeRemains`, and its search circle. Only
   * `lineage[0]`'s bodies appear, and none is an obstacle.
   */
  #placePredecessor(
    save: Save,
    planet: PlanetId,
    layout: Layout,
    grid: ObstacleGrid,
    pad: LayoutPoi | null,
    interactables: Interactable[],
  ): void {
    this.#predecessor = null;
    const prior = save.meta.lineage[0];
    if (save.meta.iteration < 2 || prior === undefined) return;
    const start = { x: 0, z: 0 };
    if (!predecessorStart(prior, planet, pad, layout.playerSpawn, start)) return;
    const at = { x: 0, z: 0 };
    placeRemains(start, { obstacles: grid, halfSize: layout.halfSize, arenaEntrance: null, descent: null }, at);
    const claim = lineageClaimId(prior.iteration, planet);
    this.#predecessor = { x: at.x, z: at.z, prior, claim };
    interactables.push({ kind: 'body', id: claim, x: at.x, z: at.z, radius: PREDECESSOR_SEARCH_RADIUS });
  }

  /** §4.5: the body's view — SPEC-057's body look in `lineage[0]`'s colours, under the grey pillar. */
  #syncPredecessor(): void {
    const predecessor = this.#predecessor;
    if (predecessor === null) {
      this.#view?.setPredecessor(null);
      return;
    }
    const { primary, secondary } = predecessor.prior.appearance;
    this.#view?.setPredecessor({ x: predecessor.x, z: predecessor.z, look: 'body', primary, secondary, pillar: PREDECESSOR_PILLAR });
  }

  /**
   * §4.5: `interact` at the body. The first press claims
   * `lineage:<lineage[0].iteration>:<planet>`: `Economy.claimBody` pays
   * `PREDECESSOR_CACHE` through `addItem` — what does not fit spills at the
   * feet (E25) — and checkpoints, and the toast names what the predecessor
   * carried. The run's first search, the one before any lineage claim was on
   * the record, plays `ng_body`. Later presses pay nothing.
   */
  #searchBody(world: CombatWorld): void {
    const economy = this.#economy;
    const save = this.#save;
    const predecessor = this.#predecessor;
    if (economy === null || save === null || predecessor === null || !world.player.alive) return;
    const first = !save.progress.claimed.some((id) => LINEAGE_CLAIM_PATTERN.test(id));
    if (!economy.claimBody(predecessor.claim).ok) return;
    this.services.events.emit('ui:toast', { kind: 'good', text: predecessorCacheText(predecessor.prior) });
    if (first) void this.#playDialogue('ng_body');
  }

  /**
   * §4.5: the body's tag, as the remains' (SPEC-057 §4.6) — on screen and
   * within 30 m, on the surface level, hidden while a beat or the map owns
   * the screen.
   */
  #renderPredecessorTag(world: CombatWorld): void {
    const tag = this.#predecessorTag;
    const predecessor = this.#predecessor;
    if (tag === null || predecessor === null) return;
    if (this.#level?.id !== 'surface' || this.#uiHolds > 0 || this.#holds > 0) {
      tag.hide();
      return;
    }
    const p = world.player;
    if (Math.hypot(predecessor.x - p.x, predecessor.z - p.z) > REMAINS_TAG_RANGE) {
      tag.hide();
      return;
    }
    const behind = this.#projectGuide(predecessor.x, predecessor.z, REMAINS_TAG_LIFT);
    const x = this.#screenPoint.x;
    const y = this.#screenPoint.y;
    if (behind || x < 0 || y < 0 || x > this.services.renderer.width || y > this.services.renderer.height) {
      tag.hide();
      return;
    }
    tag.show(x, y);
  }

  /** §4.5: `Recover your pack — <d> m`, rebuilt only when the whole metre moves; `null` with no remains here. */
  #remainsRow(world: CombatWorld): string | null {
    const remains = this.#save?.progress.remains ?? null;
    if (!this.#remainsHere || remains === null) return null;
    const metres = Math.round(Math.hypot(remains.x - world.player.x, remains.z - world.player.z));
    if (metres !== this.#remainsRowMetres || this.#remainsRowText === null) {
      this.#remainsRowMetres = metres;
      this.#remainsRowText = remainsTrackerText(this.#remainsLook, metres);
    }
    return this.#remainsRowText;
  }

  // ------------------------------------------------------ SPEC-054: below

  /**
   * §4.2 — the gate: why a descent is refused, or `null` when it is not. In
   * order: the `c1_m1` seal (skipped by the debug descent), a current stage's
   * running clock, the boss, a follower, forced weather.
   */
  #descentRefusal(skipSeal: boolean): string | null {
    const save = this.#save;
    const missions = this.#missions;
    const world = this.#world;
    if (save === null || missions === null || world === null) return null;
    let clock: string | null = null;
    for (const state of missions.active) {
      for (const { objective, done } of missions.currentObjectives(state.id)) {
        if (done) continue;
        if (objective.kind === 'survive' || objective.kind === 'defend' || objective.kind === 'escort') {
          clock = MISSION_TABLE[state.id].title;
          break;
        }
      }
      if (clock !== null) break;
    }
    return descentRefusal({
      tutorialDone: skipSeal || (save.progress.missionsDone as readonly string[]).includes(DESCENT_SEAL),
      clockTitle: clock,
      bossAwake: missions.bossStage() !== null || world.arena?.locked === true || this.#arena?.locked === true,
      follower: world.follower !== null,
      stormForced: missions.requiredWeather() !== null,
    });
  }

  /** §4.5: `light` below flips the flashlight — intensities only — and says so. */
  #toggleLight(world: CombatWorld): void {
    if (this.#level?.id !== 'underground' || !world.player.alive) return;
    this.#setLight(!this.#lightOn);
    this.services.events.emit('light:toggled', { on: this.#lightOn });
  }

  #setLight(on: boolean): void {
    this.#lightOn = on;
    this.#light.on = on;
    this.#view?.setFlashlightOn(on);
    // SPEC-055 §4.6, 55-c: the beam draws only while the light is on.
    this.#puzzles?.onLight();
  }

  /**
   * §4.8: `interact` at a cache. A guarded cache waits for SPEC-055's puzzles;
   * an unclaimed loose one pays once, raises `cache:opened`, toasts what it
   * paid and draws open from now on.
   */
  #openCache(target: Interactable, world: CombatWorld): void {
    const economy = this.#economy;
    if (economy === null || !world.player.alive) return;
    const id = target.id as CacheId;
    if (CACHES[id].guard !== 'none') return;
    const result = economy.claimCache(id);
    if (!result.ok) return;
    this.#cacheOpened(id, target.x, target.z, result.reward);
  }

  /**
   * §4.8: a claimed cache raises `cache:opened`, toasts what it paid and draws
   * open from now on — a loose one here, a guarded one from SPEC-055's solve.
   */
  #cacheOpened(id: CacheId, x: number, z: number, reward: CacheReward): void {
    this.services.events.emit('cache:opened', { cache: id, x, z });
    // SPEC-056 §4.1: the treasure reads in the toast too — tokens first.
    const paid = cacheRewardText(reward);
    this.services.events.emit('ui:toast', { kind: 'good', text: paid === '' ? CACHE_OPENED_TEXT : `${CACHE_OPENED_TEXT} · ${paid}` });
    this.#caveView?.setClaimed(id);
    // SPEC-056 §4.6: a swatch is this device's from now on — once.
    const swatch = reward.swatch;
    if (swatch !== undefined) {
      const unlocks = this.services.settings.get().unlocks;
      if (!unlocks.includes(swatch)) {
        this.services.settings.set({ unlocks: [...unlocks, swatch] });
        this.services.events.emit('ui:toast', { kind: 'good', text: swatchUnlockedText(swatch) });
      }
    }
    // SPEC-056 §4.7: a vault's archive shard plays its log; the flag is set
    // as it starts (`#clueStarted`), and a shard already found never replays.
    const clues = this.#clues;
    const scene = this.#clueScene;
    if (clues !== null && scene !== null) this.#playClue(clues.onCache(id, scene));
  }

  /** SPEC-055 §4.4: a puzzle panel or ARIA's offer holds the world as the map does — and the touch layer goes with it. */
  #puzzleHold(on: boolean): void {
    if (on) {
      this.#uiHolds++;
      const world = this.#world;
      if (world !== null) {
        world.player.vx = 0;
        world.player.vz = 0;
      }
      this.#touch?.hide();
      return;
    }
    this.#uiHolds = Math.max(0, this.#uiHolds - 1);
    this.#touch?.show('surface');
  }

  /** SPEC-055 §4.4: a panel never opens during another hold, a modal line, a beat, a swap or a death. */
  #puzzleFree(): boolean {
    return (
      this.#uiHolds === 0 &&
      this.#modalOpen === 0 &&
      this.#holds === 0 &&
      !this.#swapping &&
      !this.#leaving &&
      this.#deathAt === null &&
      !this.#rotateBlocked() &&
      this.#world?.player.alive === true
    );
  }

  /** SPEC-055 §4.10 (dev): the salvager to (x, z), clear of obstacles, facing `facing`. */
  #teleport(x: number, z: number, facing?: number): void {
    const world = this.#world;
    if (world === null || !world.player.alive) return;
    const p = world.player;
    world.obstacles.resolveCircle(x, z, p.radius, this.#resolved);
    p.x = this.#resolved.x;
    p.z = this.#resolved.z;
    if (facing !== undefined) p.facing = facing;
  }

  /**
   * §4.4: SPEC-052's cave kit, loaded lazily at a visit's first descent. The
   * release is registered on enter, so it runs after the views have gone.
   */
  #loadCaveKit(): Promise<void> {
    if (this.#caveKit === null) this.#caveKit = this.services.assets.load(CAVE_ASSETS);
    return this.#caveKit;
  }

  /**
   * §4.2 — the swap: the `'level'` hold and the input released (54-h), the
   * fade out (0 ms under reduced motion), the swap itself, the fade in. A
   * scene disposed mid-swap stops at the next await. The first descent of a
   * visit also waits, behind the fade, for the cave kit.
   */
  async #swapLevel(to: LevelId): Promise<void> {
    const world = this.#world;
    if (world === null || this.#swapping || this.#level === null || this.#level.id === to) return;
    if (to === 'underground' && this.#descent === null) return;
    this.#swapping = true;
    this.services.input.releaseAll();
    const ms = fadeMs();
    const kit = to === 'underground' && this.#caveView === null ? this.#loadCaveKit() : null;
    await this.services.ui.fadeOut(ms);
    if (!this.#alive) return;
    if (kit !== null) {
      await settleWithin(kit, CAVE_KIT_WAIT_MS);
      if (!this.#alive) return;
    }
    const left = this.#applySwap(world, to);
    await this.services.ui.fadeIn(ms);
    if (!this.#alive) return;
    this.#swapping = false;
    // E86: said once the cave is in sight. A toast raised under the black
    // would spend its time where nobody can read it — on a slow device, all of
    // it, while the first frame with the flashlight's programs is drawn.
    if (to === 'underground' && left > 0) this.services.events.emit('ui:toast', { kind: 'warn', text: LOOT_LEFT_TEXT });
  }

  /**
   * §4.2–§4.9 — the synchronous part of a swap, which a death or a recall
   * below runs on its own (E84). Going down clears what the surface leaves
   * behind: its waves stop, its enemies go silently, every shot, telegraph and
   * deployable is freed with no blast and no refund (54-a), and its loot is
   * cleared. Coming up does the same for the cave. Then the level, the world,
   * the view, the light, the map and the grade change over, the player lands,
   * and `level:changed` fires. Returns how many pickups lay within 10 m — the
   * swap's caller toasts them going down (E86).
   */
  #applySwap(world: CombatWorld, to: LevelId): number {
    const levels = this.#levels;
    const view = this.#view;
    const spawn = this.#spawn;
    const combat = this.#combat;
    const pickups = this.#pickups;
    const save = this.#save;
    const from = this.#level;
    if (levels === null || view === null || spawn === null || combat === null || pickups === null || save === null) return 0;
    if (from === null || from.id === to) return 0;
    const p = world.player;
    if (to === 'underground') this.#stopMissionWaves();
    spawn.despawnNear(p.x, p.z, Infinity);
    combat.clearLevel();
    // Review 2026-10, B-22: the bursts and scorches belong to the floor they fell on.
    view.fx.clear();
    const left = pickups.clear(p.x, p.z, LOOT_LEFT_RADIUS);
    this.#closeTerminal();

    const level = to === 'underground' ? this.#ensureCave(levels, save) : levels.surface;
    this.#level = level;
    world.obstacles = level.grid;
    world.bounds = level.bounds;
    spawn.setObstacles(level.grid);
    this.#pathGrid = to === 'underground' ? this.#caveGrid : this.#surfaceGrid;
    this.#routeLength = 0;
    this.#routeIn = 0;
    this.#insideShelter = null;
    this.#shelterState = 'none';

    // §4.2: below, at the spawn by the exit, facing into room 0; above, at the
    // descent point, facing out of the shelter. The camera snaps.
    if (to === 'underground') {
      const u = level.layout as UndergroundLayout;
      p.x = u.playerSpawn.x;
      p.z = u.playerSpawn.z;
      p.facing = u.playerSpawn.facing;
    } else {
      const descent = this.#descent;
      if (descent !== null) {
        p.x = descent.x;
        p.z = descent.z;
        p.facing = descent.shelter.gapAngle;
      }
    }
    p.vx = 0;
    p.vz = 0;
    this.#camTarget.x = p.x;
    this.#camTarget.z = p.z;
    this.#placeCamera(0, 0);

    // §4.4, §4.5: the view, the flashlight and the light rules.
    if (to === 'underground') {
      view.setLevel('underground', this.#caveView, this.#caveDef.look);
      const built = view.ensureFlashlight(this.services.renderer.quality.flashlight, this.#caveDef.look.flashlight);
      this.#setLight(this.#lightOn);
      // §4.5: the light count moved once, behind this fade — compile now.
      if (built) this.services.renderer.gl.compile(this.scene, this.camera);
      world.light = this.#light;
      world.sight = DARK_SIGHT;
      view.enemies.rimOf = this.#rimBelow;
    } else {
      view.setLevel('surface', null, null);
      this.#setLight(this.#lightOn);
      world.light = undefined;
      world.sight = undefined;
      view.enemies.rimOf = null;
    }
    this.#touch?.setLightAvailable(to === 'underground');
    // SPEC-055: the relic shows above, the vault terminal and the world puzzle below.
    this.#puzzles?.onLevel(to);

    // §4.10: the maps follow the level.
    const title = to === 'underground' ? `${this.#planet.name} · ${UNDERGROUND_TITLE}` : this.#planet.name;
    this.#minimap?.setLayers(level.layers);
    this.#mapScreen?.setLevel({ layout: level.layout, layers: level.layers, title });
    const revealed = level.mask.reveal(p.x, p.z, this.#revealOut);
    if (revealed > 0) level.layers.reveal(this.#revealOut, revealed, EXPLORE_CELL);
    this.#minimapIn = 0;

    // §4.4: the grade and the fog. Below the storm grade is not forwarded;
    // coming up, the surface's is forwarded again on the next frame.
    this.applyLook();
    this.#lastGrade.vignette = -1;
    this.#fogMultApplied = Number.NaN;
    this.#applyFog();

    // §4.4: below the storm is muted — no slow-down, no loop (Eden hums).
    combat.setWeatherMoveMult(this.#weatherMoveMult());
    this.#stormLoopVolume = 0;
    this.#stopStormLoop();

    if (to === 'underground') {
      this.#descents++;
      this.#spawnCavePacks(level.layout as UndergroundLayout);
      // §4.5: the first descent teaches the light.
      this.#requestTip('dark');
    } else {
      // §4.9 (E83): what a stage started below waits for starts now.
      this.#syncMissionStages();
    }
    this.#swapUndrawn = true;
    this.#syncDebugStrip();
    // SPEC-057 §4.5: the remains show on the surface level only.
    this.#syncRemains();
    this.services.events.emit('level:changed', { planet: this.#planet.id, level: to });
    return left;
  }

  /**
   * §4.14 (dev): the strip shows the active level's own shortcuts — the
   * descent's above; the ascent, the vault and its corridor below — and hides
   * the other level's, which would do nothing there. The surface's strip is
   * the row it was, which the other suites' pointer clicks expect on screen.
   */
  #syncDebugStrip(): void {
    const below = this.#level?.id === 'underground';
    for (const element of this.#debugAbove) element.hidden = below;
    for (const element of this.#debugBelow) element.hidden = !below;
  }

  /**
   * §4.3: the cave — the same on every visit of the save, from the layout
   * stream's `underground` fork — its level, its route grid and its view,
   * built at the visit's first descent and kept (54-d, 54-e).
   */
  #ensureCave(levels: { surface: Level; underground: Level | null }, save: Save): Level {
    const existing = levels.underground;
    if (existing !== null) return existing;
    const planet = this.#planet;
    const def = this.#caveDef;
    const u = generateUnderground(def, planet.chapter, this.services.rng.layout(planet.id).fork('underground'));
    this.#cave = u;
    // §4.10: the second mask — 10 m reveals, persisted in `exploredBelow`.
    const mask = new ExploreMask(BELOW_HALF_SIZE, save.progress.exploredBelow[planet.id], EXPLORE_RADIUS_BELOW);
    const layers = new MapLayers(u, planet.surface.palette, { rooms: u.rooms, corridors: u.corridors, width: def.corridor });
    layers.syncFog(mask);
    const interactables: Interactable[] = [{ kind: 'exit', id: 'exit', x: u.exit.x, z: u.exit.z, radius: EXIT_RADIUS }];
    for (const cache of u.caches) interactables.push({ kind: 'cache', id: cache.id, x: cache.x, z: cache.z, radius: CACHE_RADIUS });
    // SPEC-055 §4.1, §4.6: the vault terminal, and the world puzzle's panel or mirrors.
    const puzzles = this.#puzzles?.buildCave(u, def.look.beacons.color) ?? [];
    interactables.push(...puzzles);
    const level: Level = {
      id: 'underground',
      layout: u,
      grid: new ObstacleGrid(u),
      bounds: u.halfSize - WALL_INSET,
      pois: [],
      shelters: [],
      nodes: null,
      terminal: null,
      interactables,
      mask,
      layers,
      pad: null,
      arena: null,
    };
    levels.underground = level;
    this.#caveGrid = buildPathGrid(u);
    const view = this.#view;
    if (view !== null && this.#caveView === null) {
      const caveView = new UndergroundView(
        view.levelRoot,
        u,
        def,
        planet.biome,
        this.services.assets,
        { primary: save.player.appearance.primary, secondary: save.player.appearance.secondary },
        Math.min(CAVE_DUST_MOTES, this.services.renderer.quality.maxParticles),
      );
      for (const cache of u.caches) if (save.progress.claimed.includes(cache.id)) caveView.setClaimed(cache.id);
      this.#caveView = caveView;
    }
    return level;
  }

  /**
   * §4.7: each descent's packs — a species per anchor from the planet's
   * surface roster (static archetypes excluded) on this descent's fork, at
   * SPEC-041's pack sizes, placed and leashed, never more than 12 alive.
   */
  #spawnCavePacks(u: UndergroundLayout): void {
    const spawn = this.#spawn;
    const visit = this.#visitRng;
    if (spawn === null || visit === null || u.packs.length === 0) return;
    // §4.11: contracts do not reach below. The swap runs between steps, so the
    // director still holds the surface step's multiplier — set it now
    // (review 2026-10, B-18).
    spawn.eliteMult = this.#eliteMult();
    const rows = this.#planet.surface.spawn
      .filter((row) => ENEMIES[row.enemy].archetype !== 'static')
      .map((row) => ({ item: row.enemy, weight: row.weight }));
    if (rows.length === 0) return;
    const rng = visit.fork(`underground:${this.#descents}`);
    for (const anchor of u.packs) {
      const enemy = rng.weighted(rows);
      const cap = BELOW_MAX_ALIVE - this.#liveEnemies();
      if (cap <= 0) break;
      spawn.spawnPackAt(enemy, anchor.x, anchor.z, { placed: true, leash: BELOW_LEASH, cap });
    }
  }

  /**
   * SPEC-043 §4.4: the elite roll's multiplier — the difficulty's, read live,
   * times `elite_surge`'s on the surface only. SPEC-054 §4.11: contracts do
   * not reach below, so a cave pack's leader rolls on the difficulty alone
   * (review 2026-10, B-18).
   */
  #eliteMult(): number {
    const difficulty = this.#save?.meta.difficulty ?? 'normal';
    const surge = this.#eliteSurge && this.#level?.id !== 'underground';
    return DIFFICULTY_RULES[difficulty].eliteChanceMult * (surge ? CONTRACTS.elite_surge.eliteChanceMult : 1);
  }

  /** §4.2: a descent stops the active missions' waves; the ascent's sync starts them again. */
  #stopMissionWaves(): void {
    const spawn = this.#spawn;
    if (spawn === null) return;
    for (const handle of this.#missionWaves.values()) spawn.stopWave(handle);
    this.#missionWaves.clear();
  }

  // ----------------------------------------------------------- debug strip

  /** `?debug` only: shortcuts so the acceptance run fits a QA session. */
  #buildDebugStrip(): void {
    const strip = el('div', 'hud-debug');
    const button = (id: string, label: string, click: () => void): HTMLElement => {
      // SPEC-023 §4.4: a held beat freezes the world, and these shortcuts are
      // shortcuts *through* it — a hurt or a smite during a reveal would touch
      // what the hold exists to protect (AC: no damage during a held beat).
      const guarded = (): void => {
        if (this.#holds > 0) return;
        click();
      };
      const element = testId(h('button', { class: 'hud-button', type: 'button', click: guarded }, label), id);
      strip.append(element);
      return element;
    };
    button('surface-hurt', 'Hurt me', () => this.#combat?.damagePlayer(60, { kind: 'fall' }));
    // SPEC-035 §4.6: a hit from off screen, which is the only kind that draws an
    // edge wedge — a skitter biting the player's ankle is inside the 8 m the
    // marker deliberately skips.
    button('surface-hurt-from', 'Hit from behind', () => {
      const world = this.#world;
      if (world === null || !world.player.alive) return;
      const p = world.player;
      const off = 28;
      this.#combat?.damagePlayer(
        12,
        { kind: 'enemy', enemyId: 'dust_skitter' },
        false,
        { x: p.x - Math.sin(CAMERA_YAW) * off, z: p.z - Math.cos(CAMERA_YAW) * off },
      );
    });
    // SPEC-046 §4.8: the tug's hull fills the pad's centre, so "to pad" is
    // 5 m out from it, toward the spawn — inside the 6 m terminal radius and
    // clear of the 3.5 m hull.
    button('surface-goto-pad', 'To pad', () => {
      const world = this.#world;
      const pad = this.#level?.pad ?? null;
      const layout = this.#level?.layout ?? null;
      if (world === null || pad === null || layout === null || !world.player.alive) return;
      const dx = layout.playerSpawn.x - pad.x;
      const dz = layout.playerSpawn.z - pad.z;
      const length = Math.hypot(dx, dz);
      world.player.x = pad.x + (length > 1e-6 ? dx / length : 1) * GOTO_PAD_DISTANCE;
      world.player.z = pad.z + (length > 1e-6 ? dz / length : 0) * GOTO_PAD_DISTANCE;
    });
    button('surface-spawn-boss', 'Wake boss', () => this.#debugSpawnBoss());
    button('surface-goto-boss', 'To boss', () => {
      const world = this.#world;
      const nest = this.#level?.arena ?? null;
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
    button('surface-stuck', 'Stuck +60 s', () => this.#stuck.advance(60));
    // SPEC-030 §4.12 (D-14): the shelter, edge and storm shortcuts are plain
    // `?debug` controls, so the packaged e2e run can press them.
    button('surface-goto-shelter', 'To shelter', () => {
      const world = this.#world;
      const level = this.#level;
      if (world === null || level === null || !world.player.alive) return;
      let best: LayoutShelter | null = null;
      let bestD = Infinity;
      for (const s of level.shelters) {
        const d = Math.hypot(s.x - world.player.x, s.z - world.player.z);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (best === null) return;
      world.player.x = best.x;
      world.player.z = best.z;
    });
    // SPEC-048 §4.3: the shelter and reach clues' places — the first cave, the
    // first wreck and the first landmark instance of the layout.
    button('surface-goto-cave', 'To cave', () => this.#debugGotoShelter('cave'));
    // SPEC-054 §4.14: the underground's shortcuts — beside the descent, down at
    // once (the gate still refuses, but for the seal), up at once, beside the
    // nearest unclaimed cache, and the level's (0, 0). Those that mean
    // something on one level only show on it, so the strip keeps one row.
    const above = this.#debugAbove;
    const below = this.#debugBelow;
    above.length = 0;
    below.length = 0;
    const toDescent = button('surface-goto-descent', 'To descent', () => {
      const world = this.#world;
      const descent = this.#descent;
      if (world === null || descent === null || this.#level?.id !== 'surface' || !world.player.alive) return;
      world.player.x = descent.x;
      world.player.z = descent.z;
    });
    const descend = button('surface-descend', 'Descend', () => {
      const world = this.#world;
      if (world === null || !world.player.alive || this.#holdReason() !== null || this.#level?.id !== 'surface') return;
      if (this.#descentRefusal(true) !== null) return;
      void this.#swapLevel('underground');
    });
    const ascend = button('surface-ascend', 'Ascend', () => {
      const world = this.#world;
      if (world === null || !world.player.alive || this.#holdReason() !== null) return;
      void this.#swapLevel('surface');
    });
    button('surface-goto-cache', 'To cache', () => this.#debugGotoCache());
    // SPEC-055 §4.10: beside the nearest unsolved puzzle (onto the next plate,
    // once the panel is read), and its solve — a beam still needs the light.
    button('surface-goto-puzzle', 'To puzzle', () => this.#puzzles?.debugGoto());
    button('surface-solve-puzzle', 'Solve puzzle', () => this.#puzzles?.debugSolve());
    // §4.12: the vault room lies at the end of the tree, a long walk through
    // the dark — on Eden, in front of the cradle row; and halfway down the
    // corridor into it, where Eden's cable tray runs.
    const toVault = button('surface-goto-vault', 'To vault', () => this.#debugGotoVault());
    const toCorridor = button('surface-goto-corridor', 'To corridor', () => this.#debugGotoCorridor());
    // SPEC-057 §4.7: 1 m from the remains, toward the pad — on the surface
    // level, where they lie — so the next step recovers them.
    const toRemains = button('surface-goto-remains', 'To remains', () => this.#debugGotoRemains());
    // SPEC-058 §3: 1 m from the predecessor's body, toward the pad — inside its search circle.
    const toBody = button('surface-goto-body', 'To body', () => this.#debugGotoBody());
    above.push(toDescent, descend, toRemains, toBody);
    below.push(ascend, toVault, toCorridor);
    this.#syncDebugStrip();
    button('surface-goto-origin', 'To origin', () => {
      const world = this.#world;
      if (world === null || !world.player.alive) return;
      world.obstacles.resolveCircle(0, 0, world.player.radius, this.#resolved);
      world.player.x = this.#resolved.x;
      world.player.z = this.#resolved.z;
    });
    button('surface-goto-wreck', 'To wreck', () => this.#debugGotoShelter('wreck'));
    button('surface-goto-landmark', 'To landmark', () => this.#debugGotoLandmark());
    // SPEC-035 §4.5: the fade needs a prop between the camera and the salvager,
    // which is a metre-precise placement at a fixed 55°/45° rig — not something
    // a QA session can reach by walking. This walks the view's own candidate
    // list and stops at the first spot the pure `occludes` says is behind one.
    button('surface-goto-occluder', 'Behind prop', () => {
      const world = this.#world;
      const view = this.#view;
      if (world === null || view === null || !world.player.alive) return;
      const p = world.player;
      const from = { x: p.x, z: p.z };
      // The camera always sits this way from its target, so "behind" is the
      // opposite bearing.
      const ux = Math.sin(CAMERA_YAW);
      const uz = Math.cos(CAMERA_YAW);
      for (let index = 0; index < view.occluderProps.length; index++) {
        // SPEC-053 §4.1: a tree drawn through the foliage seam is cut away
        // around the head, never faded — so it is not what this looks for.
        if (!view.occluderFades(index)) continue;
        const prop = view.occluderProps[index] as (typeof view.occluderProps)[number];
        for (const gap of [0.5, 1, 2, 3, 5, 8]) {
          const off = prop.radius + gap;
          const x = prop.x - ux * off;
          const z = prop.z - uz * off;
          if (world.obstacles.hitsCircle(x, z, p.radius)) continue;
          p.x = x;
          p.z = z;
          this.#camTarget.x = x;
          this.#camTarget.z = z;
          this.#placeCamera(0, 0);
          if (occludes(this.camera.position, p, prop)) return;
        }
      }
      p.x = from.x;
      p.z = from.z;
      this.#camTarget.x = from.x;
      this.#camTarget.z = from.z;
      this.#placeCamera(0, 0);
    });
    button('surface-goto-edge', 'To edge', () => {
      const world = this.#world;
      if (world === null || !world.player.alive) return;
      world.player.x = (this.#level as Level).bounds;
      world.player.z = 0;
    });
    // SPEC-053 §4.10: beside a tree of the biggest grove, orchard or cluster,
    // inside its canopy — where the foliage budget is measured.
    if (import.meta.env.DEV) {
      button('surface-goto-grove', 'To grove', () => this.#debugGotoGrove());
    }
    // D-15: the planet cycle's highest-dps storm, ties toward the earlier
    // entry; present and inert on a weatherless planet (30-g).
    button('surface-storm', 'Storm', () => {
      const cycle = this.#planet.surface.weather?.cycle ?? [];
      let pick: (typeof cycle)[number] | null = null;
      let pickDps = -Infinity;
      for (const id of cycle) {
        if (WEATHER_EFFECTS[id].dps > pickDps) {
          pick = id;
          pickDps = WEATHER_EFFECTS[id].dps;
        }
      }
      if (pick !== null) this.#weather?.force(pick, 60);
    });
    // SPEC-029 §4.13: the arsenal in one press, and a pack of skitters at the
    // aim point, so the acceptance run fits a QA session.
    if (import.meta.env.DEV) {
      button('surface-arsenal', 'Arsenal', () => this.#debugArsenal());
    }
    button('surface-spawn-pack', 'Spawn pack', () => this.#debugSpawnPack());
    // SPEC-041 §4.10: a pack of the planet's swarm species led by an elite
    // with the planet's affix count, so a plate is one press away.
    button('surface-spawn-elite', 'Spawn elite', () => this.#debugSpawnElite());
    // SPEC-038 §4.11: a charge on demand — the planet's rusher, aggroed.
    button('surface-spawn-charger', 'Spawn charger', () => this.#debugSpawnCharger());
    // SPEC-064 §4.5: a raider on demand, so the pool and its budget are a few presses away.
    button('surface-spawn-raider', 'Spawn raider', () => this.#debugSpawnRaider());
    // SPEC-050 §4.10: an empty pool, as a spend would leave it — exhausted,
    // with `player:exhausted` on the way in.
    button('surface-exhaust', 'Exhaust', () => {
      const world = this.#world;
      if (world === null || !world.player.alive) return;
      if (spend(world.player, world.player.stamina, world.time)) this.#onExhausted();
    });
    // SPEC-038 §4.11: the budget case needs all three kinds live at once, and
    // nothing in this spec draws a circle or a ring — so a long-fused pair.
    if (import.meta.env.DEV) {
      button('surface-telegraphs', 'Telegraphs', () => this.#debugTelegraphs());
    }
    // SPEC-024 §4.8: stage 0 of `c6_m2` is a 240 s defence, and an acceptance
    // run cannot pay that per attempt. Dev builds only — `import.meta.env.DEV`
    // strips the control (and its handler) out of a production bundle.
    if (import.meta.env.DEV) {
      button('surface-finish-stage', 'Finish stage', () => this.#debugFinishStage());
    }
    // SPEC-042 §4.11: the feedback suite's shortcuts — low HP, a wave, an elite
    // hit once and a coolant pack at the feet. Dev builds only, like the stage
    // shortcut: production carries neither the buttons nor their handlers.
    if (import.meta.env.DEV) {
      button('surface-hp-low', 'HP low', () => this.#debugHpLow());
      button('surface-start-wave', 'Start wave', () => this.#debugStartWave());
      button('surface-hit-elite', 'Hit elite', () => this.#debugHitElite());
      button('surface-drop-item', 'Drop item', () => {
        const world = this.#world;
        if (world === null || !world.player.alive) return;
        this.#pickups?.spawn({ kind: 'item', itemId: 'coolant_pack', qty: 1, x: world.player.x, z: world.player.z });
      });
    }
    this.services.uiRoot.append(strip);
    this.disposer.add(() => strip.remove());
  }

  /**
   * SPEC-029 §4.13: the chaingun and the rocket launcher into the inventory
   * and onto the body, three grenades, seven mines and a charge into the
   * hold, and the grenade into the explosive slot.
   */
  #debugArsenal(): void {
    const economy = this.#economy;
    const save = this.#save;
    if (economy === null || save === null) return;
    for (const id of ['mg_scrap', 'launcher_rocket'] as const) {
      if (economy.count(id) === 0 && save.equipped.primary !== id && save.equipped.heavy !== id) {
        economy.addItem(id, 1);
      }
      economy.equip(id);
    }
    economy.addItem('frag_grenade', 3);
    economy.addItem('landmine', 7);
    economy.addItem('demo_charge', 1);
    save.quick.explosive = 'frag_grenade';
  }

  /**
   * SPEC-057 §4.7: `GOTO_REMAINS_DISTANCE` from the remains toward the pad, on
   * the surface level of their planet — inside the recover radius, so the next
   * step takes them back. Nothing happens with none here, or below.
   */
  /** SPEC-058 §3 (dev): `GOTO_BODY_DISTANCE` from the predecessor's body, toward the pad. */
  #debugGotoBody(): void {
    const predecessor = this.#predecessor;
    const pad = this.#levels?.surface.pad ?? null;
    if (predecessor === null || this.#level?.id !== 'surface') return;
    const dx = pad === null ? 1 : pad.x - predecessor.x;
    const dz = pad === null ? 0 : pad.z - predecessor.z;
    const length = Math.hypot(dx, dz);
    const ux = length > 1e-6 ? dx / length : 1;
    const uz = length > 1e-6 ? dz / length : 0;
    this.#teleport(predecessor.x + ux * GOTO_BODY_DISTANCE, predecessor.z + uz * GOTO_BODY_DISTANCE);
  }

  #debugGotoRemains(): void {
    const remains = this.#save?.progress.remains ?? null;
    const pad = this.#levels?.surface.pad ?? null;
    if (remains === null || !this.#remainsHere) return;
    const dx = pad === null ? 1 : pad.x - remains.x;
    const dz = pad === null ? 0 : pad.z - remains.z;
    const length = Math.hypot(dx, dz);
    const ux = length > 1e-6 ? dx / length : 1;
    const uz = length > 1e-6 ? dz / length : 0;
    this.#teleport(remains.x + ux * GOTO_REMAINS_DISTANCE, remains.z + uz * GOTO_REMAINS_DISTANCE);
  }

  /** SPEC-054 §4.14: beside the nearest unclaimed cache of the active level — a loose one first — toward its room. */
  #debugGotoCache(): void {
    const world = this.#world;
    const save = this.#save;
    const level = this.#level;
    if (world === null || save === null || level === null || !world.player.alive) return;
    const p = world.player;
    let best: Interactable | null = null;
    let bestD = Infinity;
    // A loose cache — one that opens — wins over a guarded one, then the nearest.
    for (const entry of level.interactables) {
      if (entry.kind !== 'cache' || save.progress.claimed.includes(entry.id)) continue;
      const shut = CACHES[entry.id as CacheId].guard !== 'none';
      const d = Math.hypot(entry.x - p.x, entry.z - p.z) + (shut ? 1e6 : 0);
      if (d < bestD) {
        bestD = d;
        best = entry;
      }
    }
    if (best === null) return;
    // Toward the room the cache stands in, so the salvager is inside its circle and clear.
    let toX = 1;
    let toZ = 0;
    const cave = this.#cave;
    if (cave !== null) {
      let room = cave.rooms[0];
      let roomD = Infinity;
      for (const r of cave.rooms) {
        const d = Math.hypot(r.x - best.x, r.z - best.z);
        if (d < roomD) {
          roomD = d;
          room = r;
        }
      }
      if (room !== undefined && roomD > 1e-3) {
        toX = (room.x - best.x) / roomD;
        toZ = (room.z - best.z) / roomD;
      }
    }
    p.x = best.x + toX * GOTO_CACHE_DISTANCE;
    p.z = best.z + toZ * GOTO_CACHE_DISTANCE;
  }

  /**
   * §4.12 (dev): below, inside the vault room, facing what it holds — on Eden
   * the middle of the cradle row, elsewhere the vault's cache at the centre —
   * from `GOTO_VAULT_DISTANCE` toward the vault door.
   */
  #debugGotoVault(): void {
    const world = this.#world;
    const cave = this.#cave;
    if (world === null || cave === null || this.#level?.id !== 'underground' || !world.player.alive) return;
    const room = cave.rooms[cave.vault.room];
    if (room === undefined) return;
    let targetX = room.x;
    let targetZ = room.z;
    if (cave.cradles.length > 0) {
      targetX = 0;
      targetZ = 0;
      for (const c of cave.cradles) {
        targetX += c.x / cave.cradles.length;
        targetZ += c.z / cave.cradles.length;
      }
    }
    const doorX = cave.vault.doorX - room.x;
    const doorZ = cave.vault.doorZ - room.z;
    const length = Math.hypot(doorX, doorZ);
    const toX = length > 1e-6 ? doorX / length : 1;
    const toZ = length > 1e-6 ? doorZ / length : 0;
    const p = world.player;
    world.obstacles.resolveCircle(targetX + toX * GOTO_VAULT_DISTANCE, targetZ + toZ * GOTO_VAULT_DISTANCE, p.radius, this.#resolved);
    p.x = this.#resolved.x;
    p.z = this.#resolved.z;
    p.facing = Math.atan2(targetZ - p.z, targetX - p.x);
  }

  /**
   * §4.12 (dev): below, halfway along the vault's one corridor — rim to rim,
   * the stretch Eden's cable tray covers — facing the vault door.
   */
  #debugGotoCorridor(): void {
    const world = this.#world;
    const cave = this.#cave;
    if (world === null || cave === null || this.#level?.id !== 'underground' || !world.player.alive) return;
    const index = cave.vault.room;
    const corridor = cave.corridors.find((c) => c.a === index || c.b === index);
    const vault = cave.rooms[index];
    const other = corridor === undefined ? undefined : cave.rooms[corridor.a === index ? corridor.b : corridor.a];
    if (vault === undefined || other === undefined) return;
    const span = Math.hypot(other.x - vault.x, other.z - vault.z);
    if (span <= 1e-6) return;
    const along = (vault.r + span - other.r) / 2;
    const p = world.player;
    world.obstacles.resolveCircle(
      vault.x + ((other.x - vault.x) / span) * along,
      vault.z + ((other.z - vault.z) / span) * along,
      p.radius,
      this.#resolved,
    );
    p.x = this.#resolved.x;
    p.z = this.#resolved.z;
    p.facing = Math.atan2(cave.vault.doorZ - p.z, cave.vault.doorX - p.x);
  }

  /** SPEC-029 §4.13: 5 skitters in a 1.5 m ring at the aim point or 7 m ahead. */
  #debugSpawnPack(): void {
    const world = this.#world;
    const combat = this.#combat;
    if (world === null || combat === null) return;
    const p = world.player;
    // Project the aim on demand: the click can land between a pointer move
    // and the next update tick, when the cached `#aimDebug` is still stale —
    // and a pack spawned at the fallback point is a pack at the player's feet.
    const aimed = this.#aimWorld(world);
    const cx = aimed?.x ?? (this.#aimDebug.has ? this.#aimDebug.x : p.x + Math.cos(p.facing) * 7);
    const cz = aimed?.z ?? (this.#aimDebug.has ? this.#aimDebug.z : p.z + Math.sin(p.facing) * 7);
    for (let k = 0; k < 5; k++) {
      const angle = (k / 5) * Math.PI * 2;
      combat.spawnEnemy('dust_skitter', cx + Math.cos(angle) * 1.5, cz + Math.sin(angle) * 1.5, false);
    }
  }

  /**
   * SPEC-041 §4.10: four of the planet's swarm species (`hive_drone` on Eden)
   * 10 m along the facing — or the nearest clear bearing to it — whose leader
   * is an elite rolled on the director's stream with the planet's affix count.
   */
  #debugSpawnElite(): void {
    const world = this.#world;
    const spawn = this.#spawn;
    if (world === null || spawn === null || !world.player.alive) return;
    const row = this.#planet.surface.spawn.find((entry) => ENEMIES[entry.enemy].archetype === 'swarm');
    const id: EnemyId = row === undefined ? 'hive_drone' : row.enemy;
    const p = world.player;
    const radius = ENEMIES[id].radius;
    let x = p.x + Math.cos(p.facing) * ELITE_PACK_DISTANCE;
    let z = p.z + Math.sin(p.facing) * ELITE_PACK_DISTANCE;
    for (let k = 0; k < 16; k++) {
      const turn = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
      const cx = p.x + Math.cos(p.facing + turn) * ELITE_PACK_DISTANCE;
      const cz = p.z + Math.sin(p.facing + turn) * ELITE_PACK_DISTANCE;
      if (world.obstacles.hitsCircle(cx, cz, radius * ELITE_SCALE + 0.5)) continue;
      x = cx;
      z = cz;
      break;
    }
    spawn.spawnElitePack(id, x, z, ELITE_PACK_SIZE);
  }

  /**
   * SPEC-038 §4.11: the planet's rusher (`hive_warrior` on Eden and the Hive),
   * aggroed, 8 m along the player's facing — or the nearest bearing to it that
   * is clear of obstacles.
   */
  #debugSpawnCharger(): void {
    const world = this.#world;
    const combat = this.#combat;
    if (world === null || combat === null || !world.player.alive) return;
    const row = this.#planet.surface.spawn.find((entry) => ENEMIES[entry.enemy].archetype === 'rusher');
    const id: EnemyId = this.#planet.id === 'eden' || this.#planet.id === 'hive' || row === undefined ? 'hive_warrior' : row.enemy;
    const p = world.player;
    const radius = ENEMIES[id].radius;
    let x = p.x + Math.cos(p.facing) * CHARGER_DISTANCE;
    let z = p.z + Math.sin(p.facing) * CHARGER_DISTANCE;
    for (let k = 0; k < 16; k++) {
      const turn = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
      const cx = p.x + Math.cos(p.facing + turn) * CHARGER_DISTANCE;
      const cz = p.z + Math.sin(p.facing + turn) * CHARGER_DISTANCE;
      if (world.obstacles.hitsCircle(cx, cz, radius + 0.5)) continue;
      x = cx;
      z = cz;
      break;
    }
    const e = combat.spawnEnemy(id, x, z, false);
    e.aggro = true;
    e.state = 'chase';
    e.stateTime = 0;
  }

  /**
   * SPEC-064 §4.5: one `scav_raider` 8 m along the player's facing — or the
   * nearest bearing to it that is clear of obstacles — spawned as the director
   * spawns one. Inside its 22 m aggro radius, it takes the player up itself.
   */
  #debugSpawnRaider(): void {
    const world = this.#world;
    const combat = this.#combat;
    if (world === null || combat === null || !world.player.alive) return;
    const p = world.player;
    const radius = ENEMIES.scav_raider.radius;
    let x = p.x + Math.cos(p.facing) * RAIDER_DISTANCE;
    let z = p.z + Math.sin(p.facing) * RAIDER_DISTANCE;
    for (let k = 0; k < 16; k++) {
      const turn = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
      const cx = p.x + Math.cos(p.facing + turn) * RAIDER_DISTANCE;
      const cz = p.z + Math.sin(p.facing + turn) * RAIDER_DISTANCE;
      if (world.obstacles.hitsCircle(cx, cz, radius + 0.5)) continue;
      x = cx;
      z = cz;
      break;
    }
    combat.spawnEnemy('scav_raider', x, z, false);
  }

  /**
   * SPEC-038 §4.11, dev builds only: a circle and a ring 10 m to either side of
   * the player, landing in 20 s — with a charger's lane, every kind is live.
   */
  #debugTelegraphs(): void {
    const world = this.#world;
    const combat = this.#combat;
    if (world === null || combat === null) return;
    const p = world.player;
    for (const [kind, side] of [
      ['circle', 1],
      ['ring', -1],
    ] as const) {
      if (combat.telegraphs.size >= TELEGRAPH_CAPACITY) return;
      const t = combat.telegraphs.alloc();
      resetTelegraph(t);
      t.kind = kind;
      t.x = p.x + Math.cos(p.facing + (side * Math.PI) / 2) * 10;
      t.z = p.z + Math.sin(p.facing + (side * Math.PI) / 2) * 10;
      t.radius = 2.5;
      t.ringMax = 4;
      t.ringSpeed = 6;
      t.band = 1;
      t.startAt = world.time;
      t.hitAt = world.time + 20;
      t.lockAt = t.hitAt;
      t.damage = 1;
      t.source = 'dust_skitter';
    }
  }

  /** SPEC-042 §4.11: a fall that leaves 15 % of max HP — through the i-frames like `surface-hurt`. */
  #debugHpLow(): void {
    const world = this.#world;
    if (world === null || !world.player.alive) return;
    const amount = Math.round(world.player.hp - world.stats.maxHp * HP_LOW_DEBUG_FRACTION);
    if (amount > 0) this.#combat?.damagePlayer(amount, { kind: 'fall' });
  }

  /** SPEC-042 §4.11: the planet's SPEC-038 storm wave, started at the player; inert where there is none. */
  #debugStartWave(): void {
    const id = `${this.#planet.id}_storm`;
    if (!Object.hasOwn(WAVES, id)) return;
    this.#spawn?.startWave(id as WaveId, 'player');
  }

  /**
   * SPEC-042 §4.11: an elite dust skitter 8 m ahead — or along the nearest
   * clear bearing — hit once by a 1-damage blast at its centre. The blast runs
   * after the next step's `combat.update`, whose hash is the first to hold it.
   */
  #debugHitElite(): void {
    const world = this.#world;
    const spawn = this.#spawn;
    if (world === null || spawn === null || !world.player.alive) return;
    const p = world.player;
    const radius = ENEMIES.dust_skitter.radius * ELITE_SCALE + 0.5;
    let x = p.x + Math.cos(p.facing) * HIT_ELITE_DISTANCE;
    let z = p.z + Math.sin(p.facing) * HIT_ELITE_DISTANCE;
    for (let k = 0; k < 16; k++) {
      const turn = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
      const cx = p.x + Math.cos(p.facing + turn) * HIT_ELITE_DISTANCE;
      const cz = p.z + Math.sin(p.facing + turn) * HIT_ELITE_DISTANCE;
      if (world.obstacles.hitsCircle(cx, cz, radius)) continue;
      x = cx;
      z = cz;
      break;
    }
    if (spawn.spawnElitePack('dust_skitter', x, z, 1) === 0) return;
    const elite = this.#combat?.lastSpawned ?? null;
    if (elite !== null) this.#pendingHit = { entity: elite, id: elite.id };
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
    const nest = this.#level?.arena ?? null;
    if (world === null || nest === null || this.#findBoss(world) !== null) return;
    const def = this.#planet.surface.pois.find((p) => p.kind === 'arena');
    if (def?.boss === undefined) return;
    const boss = this.#combat?.spawnEnemy(def.boss, nest.x, nest.z, false);
    if (boss === undefined) return;
    this.#bossId = boss.id;
    // SPEC-041 41-a: armed, but unsealed until the player steps inside.
    this.#arena = { x: nest.x, z: nest.z, radius: this.#arenaRadius, locked: true, sealed: false };
    world.arena = this.#arena;
    this.#weather?.suppress(true);
  }

  // -------------------------------------------------------------- terminal

  #buildTerminal(): void {
    const terminal = testId(el('div', 'panel pad-terminal is-hidden'), 'pad-terminal');
    this.services.uiRoot.append(terminal);
    this.#terminal = terminal;
    this.disposer.add(() => {
      const close = this.#terminalModal;
      this.#terminalModal = null;
      close?.();
      terminal.remove();
    });
  }

  /**
   * SPEC-036 §4.10, 36-m: the terminal covers the centre of a phone, so it
   * holds the world as the map and the picker do — a storm warning or a swarm
   * waits for it. It is a back-stack entry too: E, Escape, the system Back and
   * its Close button all close it, and walking away is not possible while held.
   *
   * SPEC-044 §4.3: it opens as a modal — focus on its first Accept, else
   * Return to ship, Tab kept inside — and the modal carries its back entry.
   */
  #openTerminal(): void {
    const terminal = this.#terminal;
    if (terminal === null || this.#terminalOpen) return;
    this.#terminalOpen = true;
    this.#uiHolds++;
    const world = this.#world;
    if (world !== null) {
      world.player.vx = 0;
      world.player.vz = 0;
    }
    this.#renderTerminal();
    terminal.classList.remove('is-hidden');
    this.#terminalModal = openModal(terminal, {
      label: 'Pad terminal',
      initialFocus:
        terminal.querySelector<HTMLElement>('[data-testid^="terminal-accept-"]') ??
        terminal.querySelector<HTMLElement>('[data-testid="terminal-return"]'),
      onBack: () => this.#closeTerminal(),
    });
  }

  /** Idempotent: releases the hold, the back entry and the focus once, however it closes. */
  #closeTerminal(): void {
    if (!this.#terminalOpen) return;
    this.#terminalOpen = false;
    this.#uiHolds = Math.max(0, this.#uiHolds - 1);
    this.#terminal?.classList.add('is-hidden');
    const close = this.#terminalModal;
    this.#terminalModal = null;
    close?.();
  }

  /** SPEC-044 §4.2: rebuilt through `keepFocus`, so an accept by keyboard keeps its place. */
  #renderTerminal(): void {
    const terminal = this.#terminal;
    if (terminal === null) return;
    keepFocus(terminal, () => this.#fillTerminal(terminal));
  }

  #fillTerminal(terminal: HTMLElement): void {
    const missions = this.#missions;
    if (missions === null) return;
    const rows: HTMLElement[] = [];
    rows.push(el('p', 'terminal-title', 'PAD TERMINAL'));

    const save = this.#save;
    // SPEC-043 §4.3: a replay this landing runs as a contract says so — read
    // with `visits[planet]`, the landing the scene counted on entry.
    const landing = save?.progress.visits[this.#planet.id] ?? 0;
    // SPEC-044 §4.7: new work first, then replays — the board's order
    // (SPEC-035 §4.12) — so the first Accept, which takes focus, is new work.
    const offers = missions.available();
    const fresh = offers.filter((def) => !missions.isReplay(def.id as MissionId));
    for (const def of [...fresh, ...offers.filter((offer) => !fresh.includes(offer))]) {
      const id = def.id as MissionId;
      const replay = missions.isReplay(id);
      const contract = replay && save !== null ? contractLabel(save, def, landing) : null;
      const full = this.#terminalBriefs.has(id);
      // SPEC-044 §4.7: an offer says what it is — its type, a replay's half
      // pay (a contract keeps SPEC-043's label), its rewards and the first
      // sentence of its brief, which a tap on the title opens in full.
      rows.push(
        testId(
          h(
            'div',
            { class: 'terminal-row terminal-offer' },
            h(
              'div',
              { class: 'terminal-offer-head' },
              h(
                'button',
                {
                  class: 'terminal-offer-title',
                  type: 'button',
                  'aria-expanded': String(full),
                  click: () => {
                    if (!this.#terminalBriefs.delete(id)) this.#terminalBriefs.add(id);
                    this.#renderTerminal();
                  },
                },
                def.title,
              ),
              h('span', { class: `badge badge-${def.type}` }, def.type === 'main' ? 'Main' : 'Side'),
              contract !== null
                ? h('span', { class: 'badge badge-contract' }, contract)
                : replay
                  ? h('span', { class: 'badge badge-replay' }, 'Replay · 50 %')
                  : null,
            ),
            h('p', { class: 'terminal-rewards' }, rewardsText(def.rewards, replay, contract !== null) || '—'),
            testId(h('p', { class: 'terminal-brief' }, full ? def.brief : firstSentence(def.brief)), `terminal-brief-${def.id}`),
            testId(
              h('button', { class: 'ui-btn is-primary', type: 'button', click: () => this.#acceptAtTerminal(id) }, 'Accept'),
              `terminal-accept-${def.id}`,
            ),
          ),
          `terminal-row-${def.id}`,
        ),
      );
    }
    // SPEC-044 §4.7: what is running here, by stage, and the tracked one named.
    for (const state of missions.active) {
      const def = MISSION_TABLE[state.id];
      rows.push(
        h(
          'p',
          { class: 'terminal-active' },
          `${def.title} — ${stageText(state.stage + 1, def.stages.length)}`,
          state.id === missions.pinned ? h('span', { class: 'badge badge-pin' }, 'Tracked') : null,
        ),
      );
    }
    // 12-k: a terminal with nothing on it reads as a broken terminal. Say what
    // is holding the planet's work back, and where that work is taken.
    if (rows.length === 1 && save !== null) rows.push(el('p', 'terminal-empty', padEmptyText(save, this.#planet.id)));
    // SPEC-065 §4.5: the Cargo section sits above the footer row.
    const cargo = this.#terminalCargo(missions);
    if (cargo !== null) rows.push(cargo);

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

  /**
   * SPEC-065 §4.5: one row per resource, in `RESOURCE_IDS` order — what the
   * hold carries against its cap, the reserve between its two steps, and
   * `Ship N home` for everything above the reserve and above what this
   * planet's deliver objectives still need, which the row names while it is
   * the higher of the two (E117).
   */
  #terminalCargo(missions: Missions): HTMLElement | null {
    const economy = this.#economy;
    const save = this.#save;
    if (economy === null || save === null) return null;
    const cap = economy.cargoCap();
    const rows = RESOURCE_IDS.map((resource) => {
      // 65-a: a reserve above the hold's cap shows, and steps, at the cap; the
      // stored value is kept until the player steps it.
      const keep = Math.min(save.depot.keep[resource], cap);
      const need = missions.deliverDemand(resource);
      const ship = economy.shippable(resource, need);
      return testId(
        h(
          'div',
          { class: 'terminal-cargo-row' },
          testId(h('span', { class: 'terminal-cargo-held' }, `${resource} ${save.resources[resource]} / ${cap}`), `terminal-held-${resource}`),
          h(
            'div',
            { class: 'terminal-keep' },
            testId(
              h(
                'button',
                {
                  class: 'ui-btn attr-btn',
                  type: 'button',
                  'aria-label': `Keep less ${resource}`,
                  disabled: keep <= 0,
                  click: () => this.#stepKeep(resource, keep - DEPOT_KEEP_STEP),
                },
                '−',
              ),
              `terminal-keep-less-${resource}`,
            ),
            testId(h('span', { class: 'terminal-keep-value' }, `Keep ${keep}`), `terminal-keep-${resource}`),
            testId(
              h(
                'button',
                {
                  class: 'ui-btn attr-btn',
                  type: 'button',
                  'aria-label': `Keep more ${resource}`,
                  disabled: keep >= cap,
                  click: () => this.#stepKeep(resource, keep + DEPOT_KEEP_STEP),
                },
                '+',
              ),
              `terminal-keep-more-${resource}`,
            ),
          ),
          testId(
            h('button', { class: 'ui-btn', type: 'button', disabled: ship <= 0, click: () => this.#shipHome(resource) }, shipHomeText(ship)),
            `terminal-ship-${resource}`,
          ),
          need > keep ? h('p', { class: 'terminal-cargo-need' }, deliveryNeedsText(need)) : null,
        ),
        `terminal-cargo-${resource}`,
      );
    });
    // SPEC-045 §2: the heading is written in sentence case; the CSS capitalises it.
    return testId(h('section', { class: 'terminal-cargo', 'aria-label': 'Cargo' }, el('p', 'terminal-heading', 'Cargo'), ...rows), 'terminal-cargo');
  }

  /** SPEC-065 §4.5: one step of a reserve, inside [0, cap]; the economy stores it. */
  #stepKeep(resource: ResourceId, value: number): void {
    const economy = this.#economy;
    if (economy === null) return;
    economy.setKeep(resource, Math.max(0, Math.min(economy.cargoCap(), value)));
    this.#renderTerminal();
  }

  /**
   * SPEC-065 §4.5: a ship press sends the row's surplus to Command Relay, says
   * how much, and re-renders through `#renderTerminal`, so focus keeps its
   * place (SPEC-044 §4.2).
   */
  #shipHome(resource: ResourceId): void {
    const economy = this.#economy;
    const missions = this.#missions;
    if (economy === null || missions === null) return;
    const result = economy.shipHome(resource, missions.deliverDemand(resource));
    if (result.ok) this.ui.toast(shippedHomeText(result.shipped, resource), 'good');
    this.#renderTerminal();
  }

  /**
   * SPEC-034 §4.10 step 4: the `onAccept` line is queued *before* `accept()`, so
   * it plays ahead of any stage line the accept itself triggers — `c1_m1` taken
   * on the pad reads ARIA's landing line, then the scav.
   */
  #acceptAtTerminal(id: MissionId): void {
    const missions = this.#missions;
    const save = this.#save;
    if (missions === null || save === null) return;
    if (!missions.available().some((def) => def.id === id)) return;
    const def = MISSION_TABLE[id];
    // SPEC-044 §4.7: read before the accept — a replay is a replay of a mission
    // already done, and its contract is this landing's.
    const replay = missions.isReplay(id);
    const contract = replay ? contractFor(save, def, save.progress.visits[this.#planet.id] ?? 0) : null;
    const dialogueId = def.dialogue.onAccept;
    if (dialogueId !== undefined && !LINE_LEDGER.played(save, dialogueId)) this.#playDialogue(dialogueId);
    if (!missions.accept(id).ok) return;
    // SPEC-044 §4.7: the board's toast, at the pad too.
    this.ui.toast(acceptedText(def.title, replay, contract === null ? null : CONTRACTS[contract].name), 'good');
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

  /**
   * SPEC-034 §4.6: the hold is counted from `dialogue:started` / `dialogue:ended`
   * rather than around this call, so a modal line from anywhere — a `next` chain
   * link, another scene's queue, the dev bridge — holds the world too.
   */
  #playDialogue(id: DialogueId): Promise<void> {
    const dialogue = this.#dialogue;
    if (dialogue === null) return Promise.resolve();
    // SPEC-034 §4.10: every mission line the surface plays goes into the ledger,
    // so the station's debrief does not say it again a minute later.
    const save = this.#save;
    if (save !== null) LINE_LEDGER.markPlayed(save, id);
    return dialogue.play(id);
  }

  // ------------------------------------------------- SPEC-048: clues, bodies

  /**
   * SPEC-048 §4.3: this visit's clue tracker and the scene it reads. `flags`
   * is a live view over the save's list, rebuilt only when it grows, so the
   * per-step dwell allocates nothing; `firstRun` is "active here and not a
   * replay"; `hasShelter` reads the layout's shelters once.
   */
  #watchClues(save: Save, layout: Layout, planet: PlanetId): void {
    const tracker = new ClueTracker();
    const view = new FlagView();
    const caves = layout.shelters.some((shelter) => shelter.kind === 'cave');
    const wrecks = layout.shelters.some((shelter) => shelter.kind === 'wreck');
    this.#clues = tracker;
    this.#clueScene = {
      planet,
      get flags(): ReadonlySet<string> {
        return view.of(save.progress.flags);
      },
      firstRun: (mission) => {
        const missions = this.#missions;
        return missions !== null && missions.active.some((state) => state.id === mission) && !missions.isReplay(mission);
      },
      hasShelter: (kind) => (kind === 'cave' ? caves : wrecks),
    };
    this.#echoBodyPlaced = false;
    this.disposer.add(() => {
      this.#clues = null;
      this.#clueScene = null;
    });
    const bus = this.services.events as EventBus<GameEvents>;
    this.disposer.add(
      bus.on(
        'enemy:killed',
        ({ enemyId }) => {
          const scene = this.#clueScene;
          if (scene !== null) this.#playClue(tracker.onKill(enemyId, scene));
        },
        this,
      ),
    );
    // SPEC-049 §4.5: `clue_restart`'s trigger is the body's — a respawn.
    this.disposer.add(bus.on('player:respawned', () => this.#playRestart(save), this));
  }

  /**
   * SPEC-049 §4.5: the page session's first respawn for this save — E4's, or
   * a recall's (49-d) — plays its band's restart line, non-modal; later ones
   * play nothing (49-e). The lines are `clue_restart`'s, so the first that ever
   * starts finds it through `#clueStarted`, and a later session's sets nothing.
   */
  #playRestart(save: Save): void {
    const dialogue = this.#dialogue;
    if (dialogue === null || HOME_SESSION.restartPlayed(save)) return;
    HOME_SESSION.markRestart(save);
    void dialogue.play(restartLine(new Set(save.progress.flags)), { modal: false });
  }

  /**
   * SPEC-048 §4.3: a trigger fired — the clue's first line, non-modal and past
   * `LINE_LEDGER` (the flag gates it). Its pending mark settles when `play`
   * does, whether the line played or a full queue dropped it (E75); a line
   * that starts has set the flag by then, so it never fires twice.
   */
  #playClue(def: ClueDef | null): void {
    const clues = this.#clues;
    if (def === null || clues === null) return;
    const line = def.lines[0];
    const dialogue = this.#dialogue;
    if (line === undefined || dialogue === null) {
      clues.settle(def.id);
      return;
    }
    void dialogue.play(line, { modal: false }).then(() => clues.settle(def.id));
  }

  /**
   * SPEC-048 §4.3: on `dialogue:started`, the clue that line finds — its flag
   * through `Economy.setFlag` (which announces `story:clue`), a checkpoint save
   * and Notes' unread mark. A flag a reward already set finds nothing (48-e).
   * §4.8: `c1_s2_echo` starting lays the second body down.
   */
  #clueStarted(id: DialogueId): void {
    const clues = this.#clues;
    const scene = this.#clueScene;
    const economy = this.#economy;
    const save = this.#save;
    if (clues === null || scene === null || economy === null || save === null) return;
    const def = clues.started(id, scene.flags);
    if (def !== null) {
      // Unread first: `setFlag`'s `story:clue` is what dots `pause-comms`.
      NOTES_UNSEEN.mark(save);
      economy.setFlag(def.id);
      this.services.save.request('checkpoint');
    }
    if (id === SCAV_ECHO_LINE) this.#placeEchoBody();
  }

  /**
   * SPEC-048 §4.8: on a Cinder-4 landing while `c1_m1` is not done, a scav lies
   * at `SCAV_PAD_OFFSET` from the pad's centre — clear of SPEC-046's tug —
   * facing it. A completion during the visit leaves it; the next landing has none.
   */
  #placePadBody(save: Save, planet: PlanetId): void {
    const view = this.#view;
    const pad = this.#levels?.surface.pad ?? null;
    if (view === null || pad === null || planet !== SCAV_PLANET) return;
    if ((save.progress.missionsDone as readonly string[]).includes(SCAV_PAD_MISSION)) return;
    const x = pad.x + SCAV_PAD_OFFSET.x;
    const z = pad.z + SCAV_PAD_OFFSET.z;
    view.addScavBody(x, z, Math.atan2(pad.z - z, pad.x - x));
  }

  /**
   * SPEC-048 §4.8: the identical body, `SCAV_ECHO_DISTANCE` from the player on
   * the first of eight bearings — from the camera's side — whose circle is
   * clear of obstacles and inside the wall, else toward the pad. Once a visit,
   * on Cinder-4; it stays until the scene exits.
   */
  #placeEchoBody(): void {
    const view = this.#view;
    const world = this.#world;
    const layout = this.#levels?.surface.layout ?? null;
    if (this.#echoBodyPlaced || view === null || world === null || layout === null || this.#planet.id !== SCAV_PLANET) return;
    // SPEC-054 §4.1: the body lies on the surface, beside the salvager — never in a cave.
    if (this.#level?.id !== 'surface') return;
    this.#echoBodyPlaced = true;
    const p = world.player;
    const edge = layout.halfSize - WALL_INSET - 1;
    const clear = (x: number, z: number): boolean =>
      Math.abs(x) <= edge && Math.abs(z) <= edge && !world.obstacles.hitsCircle(x, z, SCAV_BODY_RADIUS);
    const pad = this.#levels?.surface.pad ?? null;
    const spot = echoBodySpot(p.x, p.z, CAMERA_YAW, clear, pad === null ? undefined : bearingToward(p.x, p.z, pad.x, pad.z));
    view.addScavBody(spot.x, spot.z, spot.facing);
  }

  /** SPEC-048 §4.3 (`?debug`): the player to the layout's first shelter of `kind`. */
  #debugGotoShelter(kind: 'cave' | 'wreck'): void {
    const world = this.#world;
    const shelter = this.#level?.shelters.find((entry) => entry.kind === kind) ?? null;
    if (world === null || shelter === null || !world.player.alive) return;
    world.player.x = shelter.x;
    world.player.z = shelter.z;
  }

  /**
   * SPEC-053 §4.10 (dev builds): beside a tree of the feature with the most
   * pieces (the first on a tie) — of its pieces, the one nearest its centre —
   * at `(x + radius + 1, z)`, stepped 0.5 m along +x while the salvager's
   * circle stands in an obstacle's. That ends inside the tree's canopy disc
   * unless more than three steps were needed. Inert with no features.
   */
  #debugGotoGrove(): void {
    const world = this.#world;
    // SPEC-054 §4.1: groves grow on the surface only.
    const layout = this.#level?.id === 'surface' ? (this.#level.layout as Layout) : null;
    if (world === null || layout === null || !world.player.alive) return;
    let feature: (typeof layout.features)[number] | null = null;
    for (const entry of layout.features) if (feature === null || entry.pieces > feature.pieces) feature = entry;
    if (feature === null) return;
    let tree: (typeof layout.obstacles)[number] | null = null;
    let nearest = Infinity;
    for (const o of featurePieces(layout, feature)) {
      const d = Math.hypot(o.x - feature.x, o.z - feature.z);
      if (d < nearest) {
        nearest = d;
        tree = o;
      }
    }
    if (tree === null) return;
    this.#groveTree = tree;
    const p = world.player;
    let x = tree.x + tree.radius + 1;
    for (let step = 0; step < 40 && world.obstacles.hitsCircle(x, tree.z, p.radius); step++) x += 0.5;
    p.x = x;
    p.z = tree.z;
  }

  /**
   * SPEC-048 §4.3 (`?debug`): the player into the layout's first landmark
   * instance — its centre, or the first clear spot on a ring inside its radius.
   */
  #debugGotoLandmark(): void {
    const world = this.#world;
    const poi = this.#level?.layout.pois.find((entry) => entry.kind === 'landmark') ?? null;
    if (world === null || poi === null || !world.player.alive) return;
    const p = world.player;
    let x = poi.x;
    let z = poi.z;
    for (let ring = 0; ring < poi.radius && world.obstacles.hitsCircle(x, z, p.radius); ring++) {
      for (let k = 0; k < 8; k++) {
        x = poi.x + Math.cos((k * Math.PI) / 4) * ring;
        z = poi.z + Math.sin((k * Math.PI) / 4) * ring;
        if (!world.obstacles.hitsCircle(x, z, p.radius)) break;
      }
    }
    p.x = x;
    p.z = z;
  }

  /**
   * SPEC-042 §4.1 (42-d): a modal `onComplete` plays first — the chain through
   * every `next` (the Warden, then ARIA) — and the banner is pushed when the
   * chain is over: at its last line's `dialogue:ended`, or as soon as one of
   * its lines never starts (a `once` line already heard, a full queue).
   */
  #playThenBanner(id: DialogueId, lines: CompletionLines): void {
    const chain: BannerChain = { link: id, lines, started: false };
    this.#chains.push(chain);
    // `play` settles at the first line's end — after the layer has started
    // its `next` — or at once when the line is dropped; a chain with no line
    // running by then is over.
    void this.#playDialogue(id).then(() => {
      if (!chain.started) this.#endChain(chain);
    });
  }

  /** SPEC-042 §4.1: a modal `onComplete` chain is over — its banner goes up, once. */
  #endChain(chain: BannerChain): void {
    const at = this.#chains.indexOf(chain);
    if (at < 0) return;
    this.#chains.splice(at, 1);
    this.#banner?.push(chain.lines);
  }

  /**
   * SPEC-042 §4.1: the banner's next line — the pad's first offer that is not
   * a replay, the one the tracker names — once no mission is left active.
   */
  #nextOffer(): MissionDef | null {
    const missions = this.#missions;
    if (missions === null || missions.active.length > 0) return null;
    return missions.available().find((def) => !missions.isReplay(def.id as MissionId)) ?? null;
  }

  /** SPEC-042 §4.5: heals in the pack — what Q, or the heal slot, could have reached. */
  #healsCarried(): number {
    const save = this.#save;
    if (save === null) return 0;
    let count = 0;
    for (const entry of save.inventory) if (quickEligible(entry.itemId, 'heal')) count += entry.qty;
    return count;
  }

  // ------------------------------------------------------------------- HUD

  #feedHud(world: CombatWorld, dt: number): void {
    const hud = this.#hud;
    const save = this.#save;
    const missions = this.#missions;
    const weather = this.#weather;
    if (hud === null || save === null || missions === null || weather === null) return;
    const m = hud.model;

    m.hp[0] = Math.max(0, Math.round(world.player.hp));
    m.hp[1] = world.stats.maxHp;
    // SPEC-042 42-p: at the cap the bar reads full.
    m.xp[1] = xpToNext(save.player.level);
    m.xp[0] = save.player.level >= LEVEL_CAP ? m.xp[1] : save.player.xp - cumulativeXp(save.player.level);
    m.level = save.player.level;
    // SPEC-042 §4.3: the running effects, into the pool made on construction —
    // the model's array holds references to it, so the step allocates nothing.
    const count = activeEffects(world.player, world.time, this.#effectPool);
    m.effects.length = count;
    for (let i = 0; i < count; i++) m.effects[i] = this.#effectPool[i] as HudEffect;
    // SPEC-042 §4.6: `▲ Wave incoming` for 3 s of scene time after a wave starts.
    if (this.#waveLeft > 0) this.#waveLeft = Math.max(0, this.#waveLeft - dt);
    m.wave = this.#waveLeft > 0;
    // SPEC-037 §4.2: any count that moves lights the wallet strip for 5 s. The
    // first feed of a visit only takes the baseline — a landing changes nothing.
    let moved = m.tokens !== save.player.tokens;
    m.tokens = save.player.tokens;
    for (const key of RESOURCE_IDS) {
      const value = save.resources[key] ?? 0;
      if (m.resources[key] !== value) moved = true;
      m.resources[key] = value;
    }
    if (moved && this.#walletPrimed) this.#walletChangedAt = world.time;
    this.#walletPrimed = true;
    m.walletLit = walletLit(this.#walletChangedAt, world.time, this.#collectOrDeliverOpen(missions));
    m.cargoCap = (this.#economy as Economy).cargoCap();

    // SPEC-027 AC-17/AC-18: on the surface the tracker replaces the
    // bottom-centre line — its focus row carries the same wording E18 put
    // there (D-3) — and `objective` stays flight's alone. The model reuses one
    // object; `Hud.flush` diffs against a clone, so in-place writes register
    // (SPEC-001 §7: no per-frame allocation).
    m.objective = null;
    m.tracker = this.#feedTracker(missions);

    // SPEC-054 §4.4: below, the storm is muted and `hud-weather` hidden.
    const below = this.#level?.id === 'underground';
    m.weather.active = below ? null : weather.current;
    m.weather.warning = !below && weather.phase === 'warning' ? weather.pending : null;
    m.weather.secondsLeft = weather.secondsLeft;
    // SPEC-054 §4.5: the light chip, below only.
    m.light = below ? this.#lightOn : null;
    // SPEC-030 D-11: the chip under the banner.
    m.shelter = this.#shelterState;

    // SPEC-042 §4.9: the boss frame and the target frame, through one reused
    // object each — a field read off the entities, no DOM, no allocation.
    const boss = this.#findBoss(world);
    if (boss === null) {
      m.boss = null;
    } else {
      const frame = this.#bossScratch;
      frame.name = boss.def.name;
      frame.hp = Math.max(0, Math.round(boss.hp));
      frame.max = boss.maxHp;
      frame.phase = boss.phase;
      frame.marks = bossPhaseMarks(boss.def.id as EnemyId);
      m.boss = frame;
    }
    this.#feedTarget(m, world);

    // SPEC-028 §4.5: the two halves of the quick bar, into reused scratch —
    // the flush diffs against a clone, so in-place writes still register.
    const combat = this.#combat;
    const economy = this.#economy;
    if (combat !== null && economy !== null) {
      const loadout = this.#loadoutScratch;
      loadout.active = combat.loadout.active;
      // SPEC-029 §4.11: the ↺ marker while the sidearm covers a locked primary.
      loadout.fallback = combat.loadout.fallback;
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

    // SPEC-038 §4.1: the ring runs from 1 at the press to 0 when ready.
    const dashLeft = world.player.dashReadyAt - world.time;
    m.dash = dashLeft > 0 ? Math.round(Math.min(1, dashLeft / Math.max(1e-6, this.#dashCooldown)) * 1000) / 1000 : 0;

    // SPEC-050 §4.6: the stamina ring's model, through one reused object, and
    // the holstered weapon slots — sprinting, or drawing after a sprint.
    const p = world.player;
    this.#staminaFullFor = p.stamina >= STAMINA_MAX ? this.#staminaFullFor + dt : 0;
    const stamina = this.#staminaScratch;
    stamina.value = Math.round(p.stamina);
    stamina.max = STAMINA_MAX;
    stamina.exhausted = p.exhausted;
    stamina.sprinting = p.sprinting;
    stamina.shown = staminaShown(p.stamina, combat?.inCombat === true, this.#staminaFullFor);
    m.stamina = stamina;
    m.holstered = p.alive && isHolstered(p, world.time);

    const interact = this.#interactHint(world);
    m.interact = interact === null ? null : interact.text;
    m.interactAction = interact !== null && interact.action;
    // Only on change: `setInteractHint` re-applies the touch layout, which
    // resets the floating stick — calling it per frame would kill the stick
    // the moment a thumb raises it. SPEC-037 §4.3: USE shows only for a prompt
    // it performs; a shortfall is words above the arc, not a button.
    const hint = m.interactAction ? 'USE' : null;
    if (hint !== this.#touchHint) {
      this.#touchHint = hint;
      this.#touch?.setInteractHint(hint);
    }
  }

  /**
   * SPEC-042 §4.9: the last non-boss enemy the player hit inside 3 s — an
   * elite in the window wins — while it still carries the id it was hit
   * with (a recycled slot does not, 42-l) and is alive. Its name and affixes
   * are written only when the id changes; an elite reads as its nameplate does.
   */
  #feedTarget(m: HudModel, world: CombatWorld): void {
    const combat = this.#combat;
    const target =
      combat === null ? null : (remembered(combat.lastEliteHit, world.time) ?? remembered(combat.lastHit, world.time));
    if (target === null) {
      m.target = null;
      return;
    }
    const frame = this.#targetScratch;
    if (target.id !== this.#targetId) {
      this.#targetId = target.id;
      frame.name = target.elite ? this.#plateName(target.def.id as EnemyId) : target.def.name;
      frame.elite = target.elite;
      frame.affixes = affixLine(target);
    }
    frame.hp = Math.max(0, Math.round(target.hp));
    frame.max = target.maxHp;
    m.target = frame;
  }

  /** SPEC-037 §4.2: a collect or deliver objective of the tracked stage is still open. */
  #collectOrDeliverOpen(missions: Missions): boolean {
    const pinned = missions.pinned;
    if (pinned === null) return false;
    for (const { objective, done } of missions.currentObjectives(pinned)) {
      if (!done && (objective.kind === 'collect' || objective.kind === 'deliver')) return true;
    }
    return false;
  }

  /**
   * The interact prompt (§4.12), including the deliver shortfall hint (E16).
   * SPEC-037 §4.3: with whether E / USE performs it — the pad terminal does;
   * `Need 20 more oil` is a statement, not an action. One reused object.
   */
  #interactHint(world: CombatWorld): { text: string; action: boolean } | null {
    const out = this.#interactOut;
    if (!world.player.alive) return null;
    if (this.#terminalOpen) return null;
    const missions = this.#missions as Missions;
    const save = this.#save as Save;
    // E16: standing at a deliver POI without enough held resource.
    for (const state of missions.active) {
      for (const { objective, done } of missions.currentObjectives(state.id)) {
        if (objective.kind !== 'deliver' || done) continue;
        const poi = (this.#level as Level).pois.find((p) => p.poi.poi === objective.poi && p.inside);
        if (poi === undefined) continue;
        const held = save.resources[objective.resource] ?? 0;
        if (held < objective.amount) {
          // SPEC-027 §4.5: the first shortfall is what teaches the rule.
          this.#requestTip('deliver');
          out.text = `Need ${objective.amount - held} more ${objective.resource}`;
          out.action = false;
          return out;
        }
      }
    }
    // SPEC-054 §4.1: the level's interactable under the player — the pad
    // terminal, the descent (or why not, §4.2), the exit or a cache (§4.8).
    const level = this.#level as Level;
    const target = nearestInteractable(level.interactables, world.player.x, world.player.z);
    if (target === null) return null;
    switch (target.kind) {
      case 'pad':
        out.text = 'Open pad terminal';
        out.action = true;
        return out;
      case 'descent': {
        const refusal = this.#descentRefusal(false);
        out.text = refusal ?? DESCEND_TEXT;
        out.action = refusal === null;
        if (refusal === null) this.#requestTip('descent');
        return out;
      }
      case 'exit':
        out.text = ASCEND_TEXT;
        out.action = true;
        return out;
      case 'cache': {
        const id = target.id as CacheId;
        // A claimed cache offers nothing; a guarded one is shut until SPEC-055.
        if (save.progress.claimed.includes(id)) return null;
        const open = CACHES[id].guard === 'none';
        out.text = open ? OPEN_CACHE_TEXT : LOCKED_TEXT;
        out.action = open;
        return out;
      }
      // SPEC-058 §4.5: `E Search the body`, then `Searched` — words only, nothing left to take.
      case 'body': {
        const searched = save.progress.claimed.includes(target.id);
        out.text = searched ? SEARCHED_TEXT : SEARCH_BODY_TEXT;
        out.action = !searched;
        return out;
      }
      // SPEC-055 §4.4, §4.6, §4.8: `Use terminal` or `Unlocked`, `Read the panel`, `Turn the mirror`.
      case 'vault':
      case 'relic':
      case 'mirror':
      case 'panel':
        return this.#puzzles?.prompt(target, out) ?? null;
      default:
        return null;
    }
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
    this.#surfaceGrid = this.#pathGrid;
    this.#guide = {
      player: this.#guidePlayer,
      pois: this.#guidePois,
      // `Nodes.states` is the live array; `remaining` moves in place (D-18).
      nodes: (this.#levels?.surface.nodes as Nodes).states,
      nearestEnemy: (id, maxRange) => this.#nearestEnemy(world, id, maxRange),
      follower: null,
      held: (resource) => save.resources[resource] ?? 0,
      arenaFor: (enemy) => this.#arenaFor(enemy),
      // SPEC-030 §4.11: the placed shelters, index = shelter index (D-3).
      shelters: layout.shelters.map((s) => ({
        x: s.x,
        z: s.z,
        label: s.kind === 'cave' ? 'Cave' : 'Wreck',
        radius: Math.min(s.rx, s.rz) - SHELTER_INSET,
      })),
      stormActive: false,
    };

    // D-28: the row pool is the campaign's widest stage plus the row that says
    // the stage is complete (27-p), so a step never allocates one.
    let widest = 1;
    for (const def of Object.values(MISSIONS)) {
      for (const stage of def.stages) widest = Math.max(widest, stage.length);
    }
    for (let i = 0; i <= widest; i++) this.#trackerRows.push({ text: '', done: false, focus: false, defendHp: null, count: -1 });
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
    const states = (this.#level as Level).pois;
    for (let i = 0; i < states.length; i++) {
      const state = states[i] as PoiState;
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
    pois.length = states.length;
    // `#ctxFollower` was refreshed for `missions.update` earlier this step.
    guide.follower = world.follower === null ? null : this.#ctxFollower;
    // SPEC-030 D-8: a cycled and a forced storm read the same.
    guide.stormActive = this.#weather?.phase === 'active';
    // SPEC-054 §4.10: below, the exit is the way — whatever the tracked objective.
    guide.exit = this.#level?.id === 'underground' ? (this.#cave?.exit ?? undefined) : undefined;
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
    // SPEC-054 §4.10: below, guidance points at the exit, labelled `Surface` (54-k).
    const exit = exitTarget(ctx);
    const target = exit !== null ? exit : pinned === null ? padTarget(ctx) : focus === null ? null : focus.target;
    this.#focusTarget = target;

    const player = world.player;
    if (target === null) {
      this.#focusDistance = null;
    } else {
      const dx = target.x - player.x;
      const dz = target.z - player.z;
      this.#focusDistance = Math.hypot(dx, dz);
      // The arrow beside the focus row turns clockwise from map-up (SPEC-026 §4.1).
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
    // PLAN R16 / 12-k: `none` promises the pad terminal has work. Where it has
    // none — the planet's work starts with a flight mission, or the campaign
    // is over — the line names the station board instead of walking the player
    // to an empty terminal.
    const kind = row !== null ? row.objective.kind : missions.available().length === 0 ? 'no_work' : 'none';
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
    // §4.5: the wording follows the scheme in use at the moment it shows, and
    // SPEC-036 §4.2 remembers that wording — so a tip queued on one scheme is
    // asked again on the live one, and a wording already seen is skipped.
    const settings = this.services.settings;
    const scheme = this.services.input.state.scheme;
    let id = this.#tipQueue.shift();
    // §4.12: only the touch wording of `zones` is ever shown.
    while (id !== undefined && (!tipDue(settings.get().tipsSeen, id, scheme) || (id === 'zones' && scheme !== 'touch'))) {
      id = this.#tipQueue.shift();
    }
    if (id === undefined) return;
    const text = scheme === 'touch' ? TIPS[id].touch : TIPS[id].keyboard;
    aria.show(text, TIP_MS);
    this.#tipCooldown = TIP_INTERVAL;
    // D-27: the id is recorded now — a tip dropped from a full queue can fire
    // again later, because it was never written down. SPEC-036 §4.2: under the
    // wording that showed; the `zones` line teaches what the touch `move` tip
    // does, so it records that one as well (§4.12).
    const seen = [...settings.get().tipsSeen, tipKey(id, scheme)];
    if (id === 'zones') seen.push(tipKey('move', 'touch'));
    settings.set({ tipsSeen: seen });
  }

  /**
   * SPEC-035 §4.6 — the HUD's red edge wedge, at the bearing of `from` clockwise
   * from screen-up. The map transform of SPEC-026 §4.1 is what puts a world
   * offset into screen space, so the wedge lands where the eye expects it.
   *
   * A hit from on screen and inside 8 m draws none: the red vignette has already
   * said it, and the source is in the frame anyway.
   */
  #showHitDirection(player: { x: number; z: number }, from: { x: number; z: number }): void {
    const dx = from.x - player.x;
    const dz = from.z - player.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= HIT_DIR_NEAR_RANGE && this.#frustumXZ.contains(from.x, from.z, 0.5)) return;
    if (distance < 1e-3) return;
    const u = (dx - dz) * Math.SQRT1_2;
    const v = (dx + dz) * Math.SQRT1_2;
    this.#hud?.showHitDirection(Math.atan2(u, -v), this.services.settings.get().reduceMotion);
  }

  /**
   * §4.5: queue a first-time tip, unless it has been seen or the queue is
   * full. SPEC-036 §4.2: "seen" is per wording — the one the live scheme would
   * show — so a phone that once saw the keyboard line still gets the touch one.
   */
  #requestTip(id: TipId): void {
    // SPEC-035 §4.8: a `?perf` run measures frames; a tip fading over one is
    // noise in the measurement and in the screenshot.
    if (this.services.perf === true) return;
    const settings = this.services.settings.get();
    if (settings.guidance !== 'full') return; // AC-47
    if (!tipDue(settings.tipsSeen, id, this.services.input.state.scheme)) return; // AC-44
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
    const nodes = this.#level?.nodes ?? null;
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
    let found: PoiState | null = null;
    if (world.player.alive) {
      for (const state of (this.#level as Level).pois) {
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
    const v = this.#projectScratch.set(x, lift + (this.#view?.heightAt(x, z) ?? 0), z);
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
    // SPEC-057 §4.5: the remains' row under the objectives, whatever they are.
    tracker.remains = this.#world === null ? null : this.#remainsRow(this.#world);
    tracker.distance = this.#focusDistance;
    tracker.bearing = this.#focusBearing;
    tracker.pulse = this.#stuck.level >= 1;
    const pinned = missions.pinned;
    // SPEC-054 §4.9 (E83): below, the focus row says the way out and how far.
    const below = this.#level?.id === 'underground';
    if (pinned === null) {
      if (below) this.#pushReturnRow(rows);
      // SPEC-035 §4.10: "No active mission" told the player nothing. Name the
      // next mission and where it is taken — the pad terminal's own list — and
      // fall back to R16's sentence when the pad has nothing to offer.
      // The pad's own list, in its own order — but a replay is not what "next"
      // means, so new work wins when the pad offers both (§4.10).
      const offers = missions.available();
      const next = offers.find((def) => !missions.isReplay(def.id as MissionId)) ?? offers[0];
      const save = this.#save;
      tracker.title =
        next !== undefined
          ? `Next: ${next.title} — at the pad terminal`
          : save === null
            ? 'No active mission'
            : padEmptyText(save, this.#planet.id);
      tracker.stage = '';
      return tracker;
    }
    const def = MISSION_TABLE[pinned];
    const count = def.stages.length;
    const stage = this.#stageOf(missions, pinned);
    tracker.title = def.title;
    // SPEC-045 §4.7: `Stage 2/3`, through the formatter.
    tracker.stage = stageText(Math.min(count, Math.max(1, stage + 1)), count);
    for (let i = 0; i < this.#guideRows.length && i < this.#trackerRows.length; i++) {
      const progress = this.#guideRows[i] as ObjectiveProgress;
      const row = this.#trackerRows[i] as HudTrackerRow;
      row.done = progress.done;
      row.focus = i === this.#focusIndex;
      row.text = row.focus ? (below ? this.#belowFocusText() : this.#focusRowText(def.title, progress)) : this.#rowText(progress);
      // SPEC-034 §4.9: a defend row carries the POI's health. `#defendHp` is
      // what `poi:damaged` was raised from, and `#syncDefend` puts it back to
      // full on a stage reset, so the bar follows both for free.
      row.defendHp =
        progress.objective.kind === 'defend' && this.#defendPoi?.poi === progress.objective.poi && this.#defendMax > 0
          ? Math.max(0, Math.min(1, this.#defendHp / this.#defendMax))
          : null;
      // SPEC-042 §4.6: what the row counts, for the bump — a timer counts nothing.
      const kind = progress.objective.kind;
      row.count = kind === 'kill' || kind === 'collect' || kind === 'scan' ? Math.floor(progress.value) : -1;
      rows.push(row);
    }
    // SPEC-054 §4.9: below with no focus row, one says the way out.
    if (below && this.#focusIndex < 0) {
      this.#pushReturnRow(rows);
      return tracker;
    }
    // 27-p: between stages every row is done, and the focus row says so.
    if (this.#focusIndex < 0 && rows.length < this.#trackerRows.length) {
      const row = this.#trackerRows[rows.length] as HudTrackerRow;
      row.done = false;
      row.focus = true;
      row.defendHp = null;
      row.count = -1;
      row.text = `${def.title} — Stage complete`;
      rows.push(row);
    }
    return tracker;
  }

  /** SPEC-054 §4.9 (E83): `Return to the surface — <n> m`, to the exit. */
  #returnText(): string {
    return `Return to the surface — ${Math.round(this.#focusDistance ?? 0)} m`;
  }

  /** SPEC-055 §4.6: below, the stones' order once the panel is read and until they are solved; else the way out. */
  #belowFocusText(): string {
    return this.#puzzles?.focusText() ?? this.#returnText();
  }

  /** SPEC-054 §4.9: the way-out row, from the pool, when the stage gives none. */
  #pushReturnRow(rows: HudTrackerRow[]): void {
    const row = this.#trackerRows[rows.length];
    if (row === undefined) return;
    row.done = false;
    row.focus = true;
    row.defendHp = null;
    row.count = -1;
    row.text = this.#belowFocusText();
    rows.push(row);
  }

  /**
   * D-3: the focus row keeps the wording the bottom-centre line used to have.
   * SPEC-045 §4.7: a survive or defend row counts down — `(48 s)`, never
   * `(12/60)` — as every other timer does (45-s: 0.3 s left reads `1 s`).
   */
  #focusRowText(title: string, progress: ObjectiveProgress): string {
    const line = this.#objectiveLine(progress.objective);
    const kind = progress.objective.kind;
    if (kind === 'survive' || kind === 'defend') return `${title} — ${line} (${seconds(progress.target - progress.value)})`;
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
        return `Survive ${seconds(objective.seconds - progress.value)}`;
      case 'defend':
        return `Defend ${this.#poiLabel(objective.poi)} ${seconds(objective.seconds - progress.value)}`;
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
    // SPEC-036 §4.11: Q means nothing on a phone.
    const hint = HINTS.death;
    const text = this.services.input.state.scheme === 'touch' && hint.touch !== undefined ? hint.touch : hint.nudge;
    this.#queueLine(text, HINT_MS);
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
        const arena = this.#level?.arena ?? null;
        if (objective.kind === 'boss' && arena !== null) this.#objectivePois.add(arena.poi);
      }
    }

    // 26-a: a discovered POI shows even under still-dark ground, and an
    // objective POI shows whether or not it was ever discovered (26-b).
    const level = this.#level as Level;
    for (const state of level.pois) {
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

    // SPEC-030 §4.10: discovered shelters draw with the SPEC-026 icons.
    const shelters = level.shelters;
    for (let i = 0; i < shelters.length; i++) {
      if (this.#shelterDiscovered[i] !== true) continue;
      const s = shelters[i] as LayoutShelter;
      const mark = this.#nextMark();
      mark.x = s.x;
      mark.z = s.z;
      mark.icon = s.kind === 'cave' ? 'shelter_cave' : 'shelter_wreck';
      mark.objective = false;
      mark.label = s.kind === 'cave' ? 'Cave' : 'Wreck';
      mark.ring = 0;
    }

    // SPEC-054 §4.10: the descent once its shelter is discovered; below, the
    // exit, the caches (hollow once claimed) and the vault door.
    const descent = this.#descent;
    if (level.id === 'surface' && descent !== null && this.#shelterDiscovered[descent.shelter.index] === true) {
      this.#markAt(descent.x, descent.z, 'descent', 'Descent');
    }
    // SPEC-057 §4.5: the remains, on this planet's surface level — not an
    // objective, so no ring, no rim arrow and no waypoint.
    const remains = save.progress.remains;
    if (this.#remainsHere && remains !== null) this.#markAt(remains.x, remains.z, 'remains', 'Your remains').label = null;
    // SPEC-058 §4.5: the predecessor's body, on the surface level — a mark, not an objective.
    const predecessor = this.#predecessor;
    if (level.id === 'surface' && predecessor !== null) this.#markAt(predecessor.x, predecessor.z, 'predecessor', PREDECESSOR_LABEL).label = null;
    // SPEC-055 §4.1: the relic terminal, once landmark instance 0 is discovered (hollow once spent).
    const relic = this.#puzzles?.relicMark() ?? null;
    if (relic !== null && this.#relicMarked(level)) this.#markAt(relic.x, relic.z, 'relic', 'Relic terminal').hollow = relic.spent;
    const cave = level.id === 'underground' ? this.#cave : null;
    if (cave !== null) {
      this.#markAt(cave.exit.x, cave.exit.z, 'descent', 'Surface');
      this.#markAt(cave.vault.doorX, cave.vault.doorZ, 'vault', 'Vault');
      for (const cache of cave.caches) {
        this.#markAt(cache.x, cache.z, 'cache', 'Cache').hollow = save.progress.claimed.includes(cache.id);
      }
    }

    // §4.3 step 5: nodes with radar, and — SPEC-027 AC-38 — every node of the
    // resource the *tracked* mission is collecting, radar or not. The guidance
    // half goes away at `guidance: 'off'` (D-6); the radar half is a companion
    // the player paid for and stays whatever the guidance level says.
    const guided = this.services.settings.get().guidance !== 'off';
    const radar = hasNodeRadar(save);
    for (const node of level.nodes?.states ?? NO_NODE_STATES) {
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
    mark.hollow = false;
    this.#marks.push(mark);
    return mark;
  }

  /** SPEC-054 §4.10: a plain mark — no ring, never an objective. */
  #markAt(x: number, z: number, icon: MapMark['icon'], label: string): MapMark {
    const mark = this.#nextMark();
    mark.x = x;
    mark.z = z;
    mark.icon = icon;
    mark.objective = false;
    mark.label = label;
    mark.ring = 0;
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
    // SPEC-054 §4.10: the active level's mask and layers — below, a 10 m reveal.
    const level = this.#level;
    if (level === null) return;
    const mask = level.mask;
    const layers = level.layers;
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

  /**
   * The masks into the live save, when they hold ground the save has not
   * seen — SPEC-054 §4.10: the surface's to `explored`, the cave's to
   * `exploredBelow`.
   */
  #writeMask(): void {
    const levels = this.#levels;
    const save = this.#save;
    if (levels === null || save === null) return;
    const surface = levels.surface.mask;
    if (surface.dirty) save.progress.explored[this.#planet.id] = surface.encode();
    const below = levels.underground?.mask ?? null;
    if (below !== null && below.dirty) save.progress.exploredBelow[this.#planet.id] = below.encode();
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
    screen.open(this.#mapFrame(world), this.#level?.mask.fraction() ?? 0);
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
        stage: stageText(state.stage + 1, def.stages.length),
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
    this.#mapScreen?.redraw(this.#mapFrame(world), this.#level?.mask.fraction() ?? 0);
  }

  // ---------------------------------------------------------- subscriptions

  #subscribe(bus: EventBus<GameEvents>): void {
    const releases = [
      bus.on(
        'player:died',
        ({ cause }) => {
          this.#deathAt = 0;
          // SPEC-050 §4.5: a death lets the toggle's latch go.
          this.#sprintLatch = false;
          // SPEC-041 §4.4: a death opens the seal at once; the respawn clears the arena.
          if (this.#arena !== null) this.#arena.sealed = false;
          const lost = this.#economy?.applyDeathPenalty() ?? {};
          // SPEC-057 §4.1 steps 3–4: what was taken stays where they fell.
          const remainsLine = this.#dropRemains(lost);
          // SPEC-042 §4.5: what killed the player, and the one tip that applies.
          // The cause names its species off the event, so an enemy that
          // despawned in the same step still has its name (42-j).
          const tip = deathTip(cause, {
            scheme: this.services.input.state.scheme,
            autoFire: this.services.settings.get().autoFire,
            healsCarried: this.#healsCarried(),
          });
          this.#death?.show(lost, deathCause(cause), tip);
          // SPEC-057 §4.1 step 5: and where it went.
          this.#death?.setRemains(remainsLine);
          this.#onDeath(); // SPEC-027 §4.6: the first-death tip, the repeat hint
          // SPEC-057 §4.1 step 6: the first remains this device has seen.
          if (remainsLine !== null) this.#requestTip('remains');
          // SPEC-055 55-k: the plates' progress resets; nothing else does.
          this.#puzzles?.onDeath();
        },
        this,
      ),
      // SPEC-042 §4.2: a pickup that went into the pack, and one a full pack refused.
      bus.on('item:collected', ({ itemId, qty }) => bus.emit('ui:toast', { kind: 'good', text: pickupText(itemId, qty) }), this),
      bus.on('item:blocked', ({ itemId }) => bus.emit('ui:toast', { kind: 'warn', text: blockedText(itemId) }), this),
      // SPEC-042 §4.6: `▲ Wave incoming` for 3 s; a second wave restarts the clock.
      bus.on(
        'wave:started',
        ({ wave }) => {
          this.#waveLeft = WAVE_LINE_SECONDS;
          // SPEC-048 §4.3: a wave clue — the Hive at Eden's beacon.
          const clues = this.#clues;
          const scene = this.#clueScene;
          if (clues !== null && scene !== null) this.#playClue(clues.onWave(wave, scene));
        },
        this,
      ),
      // SPEC-048 §4.3: a reach clue — a landmark entered.
      bus.on(
        'poi:reached',
        ({ poi }) => {
          const clues = this.#clues;
          const scene = this.#clueScene;
          if (clues !== null && scene !== null) this.#playClue(clues.onReach(poi, scene));
        },
        this,
      ),
      // SPEC-048 §4.4: a clue found while the menu is up dots `pause-comms`.
      bus.on('story:clue', () => this.#pauseMenu?.refreshNotes(), this),
      // SPEC-027 §4.5: the storm tip rides the ten-second warning itself.
      bus.on('weather:warning', () => this.#requestTip('storm'), this),
      // SPEC-029 §4.12: a blast bursts, scorches to its radius and shakes the
      // camera 0.3 — shakeOffset scales the shake by Camera shake (SPEC-045).
      bus.on(
        'combat:blast',
        ({ x, z, radius }) => {
          const view = this.#view;
          if (view === null) return;
          view.fx.burst('blast', x, z, BLAST_COLOR, radius / BLAST_BURST_BASE_RADIUS);
          view.fx.scorch(x, z, radius / BLAST_SCORCH_BASE);
          this.#triggerShake(BLAST_SHAKE_AMPLITUDE, BLAST_SHAKE_SECONDS);
        },
        this,
      ),
      // SPEC-029 §4.9: the first lock teaches the cover switch.
      bus.on('weapon:locked', () => this.#requestTip('overheat'), this),
      // SPEC-050 §3: the player's shots this visit (`sceneInfo.shots`) — every
      // trigger and launcher shot; the drone's carry no event.
      bus.on('weapon:fired', () => void this.#shots++, this),
      // SPEC-038 §4.1: three afterimage streaks along the path, once per dash;
      // under reduce motion there are none — the ring says it.
      bus.on(
        'player:dashed',
        ({ x, z, dirX, dirZ }) => {
          if (this.services.settings.get().reduceMotion) return;
          this.#view?.fx.dash(x, z, dirX, dirZ, DASH_DISTANCE, DASH_STREAK_COLOR);
        },
        this,
      ),
      // SPEC-038 §4.9: the first telegraph drawn within 25 m teaches the dash.
      bus.on(
        'enemy:windup',
        ({ kind, x, z }) => {
          const world = this.#world;
          if (world === null || !TELEGRAPH_WINDUPS.has(kind)) return;
          // SPEC-041 §4.1: the wurm going under kicks up a ring of sand, and
          // SPEC-050 §4.7: its first burrow says how to walk out of it.
          if (kind === 'burrow') {
            this.#view?.fx.burst('dust_ring', x, z, this.#groundColor);
            this.#requestTip('wurm');
          }
          if (Math.hypot(x - world.player.x, z - world.player.z) <= DASH_TIP_RANGE) this.#requestTip('dash');
        },
        this,
      ),
      // SPEC-041 §4.1: a ground move lands with a dust ring and a 0.3 s shake —
      // shakeOffset scales the shake by Camera shake (SPEC-045).
      bus.on(
        'boss:move',
        ({ kind, x, z }) => {
          if (!GROUND_MOVE_KINDS.has(kind)) return;
          this.#view?.fx.burst('dust_ring', x, z, this.#groundColor);
          this.#triggerShake(BOSS_MOVE_SHAKE_AMPLITUDE, BOSS_MOVE_SHAKE_SECONDS);
        },
        this,
      ),
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
          // SPEC-029 §4.4: combat mirrors the auto-swap mode, live.
          if (patch.weaponAutoSwap !== undefined && this.#combat !== null) {
            this.#combat.weaponAutoSwap = patch.weaponAutoSwap;
          }
        },
        this,
      ),
      bus.on(
        'player:damaged',
        ({ amount, source, from }) => {
          // SPEC-019 §4.6: weather ticks every fixed step — no burst, no
          // shake; the amounts pool into one red number per second (19-m).
          // SPEC-037 §4.6: and no flash — the storm vignette and the number say
          // it, and a weather tick is where the strobe came from (37-g).
          if (source.kind === 'weather') {
            this.#weatherDamage += amount;
            return;
          }
          this.#hud?.damageFlash();
          const world = this.#world;
          if (world === null || this.#view === null) return;
          const p = world.player;
          // SPEC-035 §4.8: the first hit an enemy lands teaches hold-to-fire.
          if (source.kind === 'enemy' || source.kind === 'projectile') this.#requestTip('combat');
          // SPEC-035 §4.6: point at where it came from, unless it came from
          // somewhere the player can already see.
          if (from !== undefined) this.#showHitDirection(p, from);
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
          // SPEC-034 §4.6, E57 / 34-d: the summons go with their boss — the
          // fight is over in the fiction, and the modal lines that follow
          // ("The Hive has gone quiet") disarm the player while a dozen drones
          // would otherwise keep biting. Each plays its burst; none is a kill.
          const bossEntity = this.#bossId;
          if (bossEntity !== null) this.#summonsDismissed += this.#spawn?.dismissSummons(bossEntity) ?? 0;
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
          // SPEC-030 30-m / D-6: a change while the player is inside keeps
          // the multiplier at 1; leaving restores the storm live then.
          // SPEC-043 §4.3: `no_cover` lets the storm's slow-down in too.
          const mult = effects === null || (this.#insideShelter !== null && !this.#noCover) ? 1 : effects.moveMult;
          // SPEC-054 §4.4: below, the storm changes nothing but its own clock.
          this.#combat?.setWeatherMoveMult(this.#level?.id === 'underground' ? 1 : mult);
          // SPEC-035 §4.11: the storm loop follows the storm, over a 0.5 s fade.
          this.#stormLoopTarget = weather === null ? 0 : 1;
        },
        this,
      ),
      bus.on(
        'dialogue:started',
        ({ id }) => {
          if (DIALOGUE_TABLE[id].glitch === true) this.#hud?.staticBurst(STATIC_BURST_MS);
          // SPEC-034 §4.6: a modal line holds the world for as long as it is up.
          if (DIALOGUE_TABLE[id].modal === true) this.#modalOpen++;
          // SPEC-037 §4.3: the tip strip holds for the line (37-f); on a short
          // screen, where the line docks under the top centre, the toasts do too.
          this.#aria?.hold(true);
          if (shortScreen()) this.ui.holdToasts(true);
          // SPEC-042 §4.1: a line of a modal `onComplete` chain is up; its banner waits for its end.
          for (const chain of this.#chains) if (chain.link === id) chain.started = true;
          // SPEC-048 §4.3, §4.8: a clue is found as its line starts; the echo lays its body down.
          this.#clueStarted(id);
        },
        this,
      ),
      bus.on(
        'dialogue:ended',
        ({ id }) => {
          if (DIALOGUE_TABLE[id].modal === true) this.#modalOpen = Math.max(0, this.#modalOpen - 1);
          this.#aria?.hold(false);
          // SPEC-042 §4.1: a banner up on a short screen keeps the rack held.
          if (this.#banner?.holdingToasts !== true) this.ui.holdToasts(false);
          // SPEC-042 §4.1 (42-d): the Warden, then ARIA — then the banner. The
          // layer starts a line's `next` in this same call, once this handler
          // returns; a `next` it drops (`once`, a full queue) never starts, and
          // the chain ends there instead of waiting for a line that never comes.
          for (let i = this.#chains.length - 1; i >= 0; i--) {
            const chain = this.#chains[i] as BannerChain;
            if (!chain.started || chain.link !== id) continue;
            const next = DIALOGUE_TABLE[id].next;
            if (next === undefined) {
              this.#endChain(chain);
              continue;
            }
            chain.link = next;
            chain.started = false;
            queueMicrotask(() => {
              if (!chain.started) this.#endChain(chain);
            });
          }
        },
        this,
      ),
      // SPEC-034 §4.15, E25: a reward item the pack could not take lands at the
      // player's feet as an ordinary pickup, with the 60 s lifetime every drop
      // has — it used to be lost outright.
      bus.on(
        'item:noRoom',
        ({ itemId, qty }) => {
          const world = this.#world;
          const pickups = this.#pickups;
          if (world === null || pickups === null || !world.player.alive) return;
          pickups.spawn({ kind: 'item', itemId, qty, x: world.player.x, z: world.player.z });
        },
        this,
      ),
      // SPEC-034 §4.6: a dismissal shows like a death and counts like nothing.
      bus.on(
        'enemy:dismissed',
        ({ enemyId, x, z }) => {
          this.#view?.fx.burst('death', x, z, hexColor(ENEMIES[enemyId].look.tint));
        },
        this,
      ),
      // SPEC-034 §4.12: the hold is full and a collect objective still wants it,
      // so it goes to Command Relay instead of bouncing. 12-l: said once per
      // resource, like CARGO FULL, until units of it go into the hold again.
      bus.on(
        'resource:collected',
        ({ resource, amount, shipped }) => {
          const sent = shipped ?? 0;
          if (amount - sent > 0) this.#shippedWarned.delete(resource);
          if (sent <= 0 || this.#shippedWarned.has(resource)) return;
          this.#shippedWarned.add(resource);
          this.services.events.emit('ui:toast', { kind: 'warn', text: SHIPPED_TOAST_TEXT });
        },
        this,
      ),
      bus.on(
        'mission:accepted',
        () => {
          this.#syncMissionStages();
          this.#applyContracts(); // SPEC-043 §4.3
        },
        this,
      ),
      // SPEC-043 §4.6: kept for the banner the completion right behind it builds.
      bus.on(
        'mission:bonus',
        ({ id, earned }) => {
          const bonus = MISSION_TABLE[id].bonus;
          if (bonus !== undefined) this.#judged.set(id, { bonus, earned });
        },
        this,
      ),
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
          // SPEC-034 §4.6: the previous stage finished; its wave is dismissed.
          if (stage > 0) this.#dismissDefendWave = true;
          this.#syncMissionStages();
          if (id === this.#missions?.pinned) this.#stuck.progress();
          // A reach objective for a POI the player is already standing in
          // completes now — entry is edge-triggered, and the edge is behind us
          // (accepting c1_m1 on the pad must not wait for a walk-out-and-back).
          for (const state of this.#level?.pois ?? NO_POI_STATES) {
            if (state.inside) bus.emit('poi:reached', { poi: state.poi.poi, instance: state.poi.instance });
          }
          // SPEC-048 §4.6: a replay's stages pass in silence.
          const dialogueId = MISSION_TABLE[id].dialogue.onStage?.[stage];
          if (dialogueId !== undefined && missionLinePlays('stage', this.#missions?.isReplay(id) ?? false)) {
            this.#playDialogue(dialogueId);
          }
          // SPEC-042 §4.6: a new stage of the tracked mission says what it
          // asks first — `Stage 2/3 — Scan Dune Sea`. Other missions say nothing.
          if (stage > 0 && id === this.#missions?.pinned) {
            const def = MISSION_TABLE[id];
            const first = def.stages[stage]?.[0];
            if (first !== undefined) {
              bus.emit('ui:toast', { kind: 'good', text: `${stageText(stage + 1, def.stages.length)} — ${this.#objectiveLine(first)}` });
            }
          }
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
        ({ id, replay, contract, seconds }) => {
          // SPEC-035 §4.7: the tutorial is over, so the ramp is too. A replay
          // does not bring it back — the mission is already in `missionsDone`.
          if (id === RAMP_MISSION && this.#ramp) {
            this.#ramp = false;
            this.#applyRamp();
          }
          // SPEC-034 §4.6: this stage is done, so a defend wave it was running
          // leaves rather than being restarted.
          this.#dismissDefendWave = true;
          this.#syncMissionStages();
          // SPEC-043 §4.3: its contract leaves with it — and a chapter flag it
          // set may have made another active replay one (43-d).
          this.#applyContracts();
          // SPEC-043 §4.5: a clean run's time, on this device.
          if (seconds !== undefined) this.#recordBest(id, seconds);
          const judged = this.#judged.get(id) ?? null;
          this.#judged.delete(id);
          // SPEC-034 §4.10: the trip's list the station debriefs from. SPEC-048
          // §4.6 (E76): a replay plays no completion line here and is not
          // debriefed there — its banner still shows.
          const data = this.#save;
          const speaks = missionLinePlays('complete', replay);
          if (data !== null && speaks) LINE_LEDGER.noteCompleted(data, id);
          const dialogueId = speaks ? MISSION_TABLE[id].dialogue.onComplete : undefined;
          // SPEC-024 §4.1: inside the ending sequence the mission's own
          // debrief is held back — "Verdict filed" contradicts the escape, and
          // the ending dialogue replaces it for the stay. The station plays it
          // on the next docking (SPEC-014's debrief), where it belongs.
          const held = this.#ending !== null && id === this.#endingFor;
          // SPEC-042 §4.1: the banner, in completion order — none for the
          // mission that starts the ending (42-e). A modal `onComplete` (the
          // Warden at the Queen's death, 42-d) plays first and the banner
          // follows its chain; otherwise the banner goes up first and the
          // line waits behind its hold.
          if (!held) {
            const lines = completionLines(MISSION_TABLE[id], replay, this.#nextOffer(), {
              contract: contract ?? null,
              bonus: judged,
              seconds: seconds ?? null,
            });
            if (dialogueId !== undefined && DIALOGUE_TABLE[dialogueId].modal === true) {
              this.#playThenBanner(dialogueId, lines);
            } else {
              this.#banner?.push(lines);
              if (dialogueId !== undefined) this.#playDialogue(dialogueId);
            }
          }
          if (this.#terminalOpen) this.#renderTerminal();
        },
        this,
      ),
      bus.on(
        'mission:abandoned',
        () => {
          this.#syncMissionStages();
          this.#applyContracts(); // SPEC-043 §4.3
        },
        this,
      ),
      bus.on(
        'mission:stageReset',
        ({ id, stage, reason }) => {
          // SPEC-038 §4.5 (38-i): a death or a recall on the storm's stage sends
          // its wave away; the respawn starts it again with the stage.
          const storm = this.#storm;
          if ((reason === 'death' || reason === 'recall') && storm !== null && storm.mission === id && storm.stage === stage) {
            this.#dismissStormWave();
          }
          // Death already rebuilt the defend stage in `#respawn`; the POI
          // destruction reset rebuilds it here (12-d).
          if (reason === 'poi_destroyed') this.#syncDefend();
          // SPEC-034 §4.9: an escort stage restarts like a timed one (E4), which
          // means putting the follower back at `from`.
          if (reason === 'death' || reason === 'recall') this.#syncEscort();
          // SPEC-042 §4.5: the death overlay says which stage the death
          // restarted, by its first objective — the tracked mission's wins.
          if (reason === 'death') {
            const first = MISSION_TABLE[id].stages[stage]?.[0];
            if (first !== undefined && (!this.#restartsSet || id === this.#missions?.pinned)) {
              this.#restartsSet = true;
              this.#death?.setRestarts(`Restarts: ${this.#objectiveLine(first)}`);
            }
          }
          // SPEC-034 §4.9: say why the stage went back to zero. A death, a
          // recall and a reload already announce themselves.
          const text = stageResetText(
            reason,
            this.#defendPoi?.poi ?? null,
            (this.#missions as Missions).escortStage()?.follower ?? null,
          );
          if (text !== null) this.services.events.emit('ui:toast', { kind: 'warn', text });
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
            // SPEC-064 §4.5: a skinned raider falls where it died. The event
            // names the species, not the entity; the body is still in the
            // pool — the end-of-step sweep reclaims it after this.
            const world = this.#world;
            if (def.look.recipe === 'scav' && world !== null) {
              for (let i = 0; i < world.enemies.size; i++) {
                const e = world.enemies.at(i);
                if (e.state === 'dead' && e.def === def && e.x === x && e.z === z) view.fallRaider(e.id);
              }
            }
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
    // SPEC-054 §4.9 (E83): below, a stage's defence, follower and waves wait
    // for the ascent, whose swap runs this again.
    if (this.#level?.id === 'underground') return;
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
    this.#syncMissionWaves(missions, spawn);
    this.#syncStormWave(missions, spawn);
  }

  /**
   * SPEC-038 §4.5: the current survive stage's storm wave, keyed
   * `${mission}:${stage}:${wave}`. When the key changes the old one is sent
   * away — dismissed with its burst and no XP (38-h) — and the new one starts
   * centred on the player. It never loops and never outlives its stage.
   */
  #syncStormWave(missions: Missions, spawn: SpawnDirector): void {
    const storm = missions.surviveWave();
    const key = storm === null ? null : `${storm.mission}:${storm.stage}:${storm.wave}`;
    if (key === this.#stormKey) return;
    this.#dismissStormWave();
    this.#stormKey = key;
    this.#storm = storm;
    if (storm !== null) this.#stormHandle = spawn.startWave(storm.wave, 'player');
  }

  /** SPEC-038 §4.5: the running storm wave's survivors leave; the key stays. */
  #dismissStormWave(): void {
    if (this.#stormHandle !== null) this.#spawn?.stopWave(this.#stormHandle, { dismiss: true });
    this.#stormHandle = null;
  }

  /** SPEC-038 §4.5 (38-i): the stage restarts, so its storm wave does too. */
  #restartStormWave(): void {
    const spawn = this.#spawn;
    const storm = this.#storm;
    if (spawn === null || storm === null) return;
    this.#dismissStormWave();
    this.#stormHandle = spawn.startWave(storm.wave, 'player');
  }

  /**
   * SPEC-034 §4.8: a mission whose definition carries `waves` (only `c3_s2`'s
   * `thessaly_reaping` today) has that wave running, centred on the player,
   * while it is active on this surface. PLAN §6 authored the field; nothing
   * started it, so the reaping never came. The wave stops — undismissed — when
   * the mission completes or is abandoned.
   */
  #syncMissionWaves(missions: Missions, spawn: SpawnDirector): void {
    const wanted = new Set<MissionId>();
    for (const state of missions.active) {
      if (MISSION_TABLE[state.id].waves !== undefined) wanted.add(state.id);
    }
    for (const [id, handle] of this.#missionWaves) {
      if (wanted.has(id)) continue;
      spawn.stopWave(handle);
      this.#missionWaves.delete(id);
    }
    for (const id of wanted) {
      if (this.#missionWaves.has(id)) continue;
      const wave = MISSION_TABLE[id].waves;
      if (wave === undefined) continue;
      this.#missionWaves.set(id, spawn.startWave(wave, 'player'));
    }
  }

  /** SPEC-034 §4.8: a death or a recall restarts the mission-level waves. */
  #restartMissionWaves(): void {
    const missions = this.#missions;
    const spawn = this.#spawn;
    if (missions === null || spawn === null) return;
    for (const handle of this.#missionWaves.values()) spawn.stopWave(handle);
    this.#missionWaves.clear();
    this.#syncMissionWaves(missions, spawn);
  }
}
