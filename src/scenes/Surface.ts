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
import { Pool } from '@/core/Pool';
import { PressEdges } from '@/core/PressEdges';
import { newSave, type CharacterCreation, type SaveV1 } from '@/core/Save';
import type { GameServices } from '@/core/Services';
import type { SceneParams } from '@/core/StateMachine';
import type { Renderer } from '@/core/Renderer';
import {
  DIALOGUE,
  ENEMIES,
  FOLLOWERS,
  ITEMS,
  MISSIONS,
  PLANETS,
  TUNING,
  type Dialogue,
  type DialogueId,
  type Item,
  type ItemId,
  type MissionDef,
  type MissionId,
  type PlanetDef,
  type PoiId,
  type ResourceId,
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
import { hasNodeRadar } from '@/systems/UiHelpers';
import { UiScene } from '@/scenes/base';
import { SurfaceView } from '@/views/SurfaceView';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { DeathOverlay } from '@/ui/DeathOverlay';
import { dialogueLayer, type DialogueUI } from '@/ui/DialogueUI';
import { el, h, testId } from '@/ui/dom';
import { Hud } from '@/ui/Hud';
import { Minimap, type MinimapPoi } from '@/ui/Minimap';
import { PauseMenu } from '@/ui/PauseMenu';
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

export class SurfaceScene extends UiScene<'surface'> {
  override readonly pausable = true;

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

  #defendPoi: LayoutPoi | null = null;
  #defendHp = 0;
  #defendMax = 0;
  #defendWave: { id: number } | null = null;
  #defendDamageAccum = 0;
  #followerRespawnIn = 0;

  #music: 'surface_calm' | 'surface_combat' | 'boss' = 'surface_calm';
  #musicHold = 0;
  #minimapIn = 0;
  #touchHint: string | null = null;

  // Debug-overlay counters (`?debug`, §4.5 observability; e2e reads them).
  #spawned = 0;
  #elites = 0;
  #kills = 0;

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

  protected onEnter(params: SceneParams['surface']): void {
    const services = this.services;
    const planet = PLANETS[params.planet];
    this.#planet = planet;

    // A bare `?scene=` jump has no loaded save; run on an in-memory one seeded
    // from the session root (never persisted — SPEC-007 owns the slots).
    const save = services.save.current ?? newSave(0, JUMP_CREATION, services.rng.seed, Date.now());
    this.#save = save;

    // §4.1 step 1: the layout stream, then the per-visit runtime stream.
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

    // §4.1 step 2: the world view.
    const view = new SurfaceView(this.scene, layout, planet);
    this.#view = view;
    this.disposer.add(() => view.dispose());
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
    const rotate = new RotateOverlay(services.uiRoot, services.events);
    this.disposer.add(() => rotate.dispose());
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
  }

  override render(renderer: Renderer): void {
    const world = this.#world;
    if (world !== null) {
      this.#view?.sync({
        player: world.player,
        follower: world.follower,
        enemies: world.enemies,
        projectiles: world.projectiles,
        pickups: (this.#pickups as Pickups).pool,
        nodes: (this.#nodes as Nodes).states,
        telegraph: this.#bossTelegraph(world),
        time: world.time,
      });
      this.#view?.setArena(world.arena);
      if (this.#minimapIn <= 0) {
        this.#minimapIn = MINIMAP_INTERVAL;
        this.#drawMinimap(world);
      }
    }
    super.render(renderer);
  }

  override debugInfo(): Record<string, number | string> {
    const info = super.debugInfo();
    info['drawCalls'] = this.services.renderer.gl.info.render.calls;
    info['spawned'] = this.#spawned;
    info['elites'] = this.#elites;
    info['kills'] = this.#kills;
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
    }
    if (this.#layout !== null) info['layoutHash'] = this.#layout.hash;
    return info;
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
      return this.#aimPoint;
    }
    if (!aim.hasPointer) return null;
    const v = this.#aimScratch.set(aim.ndcX, aim.ndcY, 0.5).unproject(this.camera);
    v.sub(this.camera.position);
    if (v.y >= -1e-6) return null; // the ray misses the ground
    const t = -this.camera.position.y / v.y;
    this.#aimPoint.x = this.camera.position.x + v.x * t;
    this.#aimPoint.z = this.camera.position.z + v.z * t;
    return this.#aimPoint;
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
    const layout = this.#layout as Layout;
    return {
      player: { x: world.player.x, z: world.player.z, alive: world.player.alive },
      poiAt: (id: PoiId) => layout.pois.filter((p) => p.poi === id),
      heldResource: (r: ResourceId) => (this.#save as SaveV1).resources[r] ?? 0,
      nearPoi: (id: PoiId, radius?: number) => {
        for (const p of layout.pois) {
          if (p.poi !== id) continue;
          const reach = radius ?? p.radius;
          if (Math.hypot(world.player.x - p.x, world.player.z - p.z) <= reach) return p;
        }
        return null;
      },
      follower:
        world.follower === null
          ? null
          : { x: world.follower.x, z: world.follower.z, alive: world.follower.alive },
    };
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
      }
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
    for (const state of missions.active) {
      const choice = missions.choiceStage(state.id);
      if (choice === null) continue;
      this.#choiceFor = state.id;
      this.#modalOpen++;
      void (this.#dialogue as DialogueUI).playChoice(choice.prompt, choice.options.map((o) => o.label)).then((index) => {
        this.#modalOpen = Math.max(0, this.#modalOpen - 1);
        const id = this.#choiceFor;
        this.#choiceFor = null;
        if (id !== null) this.#missions?.choose(id, index);
      });
      return;
    }
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
        return { itemId: entry.itemId, qty: entry.qty };
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
    this.#spawn?.despawnNear(layout.pad.x, layout.pad.z, DEATH_DESPAWN_RADIUS);
    const boss = this.#findBoss(world);
    if (boss !== null) boss.state = 'dead'; // silent — no loot, no defeat event
    this.#bossId = null;
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
      strip.append(testId(h('button', { class: 'hud-button', type: 'button', click }, label), id));
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
    this.services.uiRoot.append(strip);
    this.disposer.add(() => strip.remove());
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

    // E18: the pinned mission's first undone objective, with progress.
    const pinned = missions.pinned;
    if (pinned === null) {
      m.objective = null;
    } else {
      const def = MISSION_TABLE[pinned];
      const next = missions.currentObjectives(pinned).find((o) => !o.done);
      if (next === undefined) {
        m.objective = { title: def.title, line: 'Stage complete', value: 1, target: 1 };
      } else {
        m.objective = {
          title: def.title,
          line: this.#objectiveLine(next.objective),
          value: Math.floor(next.value),
          target: next.target,
        };
      }
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
      bus.on('player:damaged', () => this.#hud?.damageFlash(), this),
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
          if (dialogueId !== undefined) this.#playDialogue(dialogueId);
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
        },
        this,
      ),
      bus.on('enemy:killed', () => this.#kills++, this),
    ];
    for (const release of releases) this.disposer.add(release);
  }

  /** Re-derive everything that hangs off the set of current stages. */
  #syncMissionStages(): void {
    const missions = this.#missions;
    const spawn = this.#spawn;
    if (missions === null || spawn === null) return;
    spawn.setObjectiveEnemies(missions.objectiveEnemies());
    this.#syncDefend();
    this.#syncEscort();
  }
}
