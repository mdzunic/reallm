// SPEC-011's browser verification harness for the surface scene. The combat
// systems are pure and unit-proved in node; what only a browser can show is
// the *feel* the acceptance list names — skitters swarming and hopping,
// raiders keeping distance and telegraphing, wurmlings rushing, the boss
// burrowing, elites at the planet's rate, and the die → respawn round trip.
// This scene wires the real `Combat`/`EnemyAi`/`Projectiles` stack into the
// placeholder shell so those are observable on any planet before SPEC-012
// lands the real surface scene (terrain, POIs, missions, weather), which
// replaces this file wholesale.
//
// Division of labour per SPEC-011 §1: this scene owns movement (input →
// `player.vx/vz` and integration), the obstacle grid, the arena state, the
// spawn director (rolling `rollElite` with the planet's `eliteChance`), the
// pickup flow draining `Combat.drops`, and the death → respawn reset — combat
// owns everything between a trigger pull and a loot orb.
import * as THREE from 'three';
import type { EventBus } from '@/core/Events';
import type { InputState } from '@/core/Input';
import { Pool } from '@/core/Pool';
import type { Rng } from '@/core/Rng';
import { newSave, type CharacterCreation, type SaveV1 } from '@/core/Save';
import type { GameServices, GameEvents } from '@/core/Services';
import { ENEMIES, PLANETS, TUNING, type EnemyId } from '@/data/index';
import type { EnemyEntity } from '@/entities/Enemy';
import { makeEnemy } from '@/entities/Enemy';
import { makePlayer } from '@/entities/Player';
import { makeProjectile } from '@/entities/Projectile';
import { CircleObstacles, type ArenaState, type ObstacleCircle } from '@/entities/World';
import { Combat, computePlayerStats, rollElite, type CombatWorld, type LootDrop } from '@/systems/Combat';
import { Economy } from '@/systems/Economy';
import { Progression } from '@/systems/Progression';
import { PlaceholderScene } from '@/scenes/Placeholders';
import { SurfaceCombatView } from '@/views/SurfaceCombatView';
import type { SceneParams } from '@/core/StateMachine';

/** The stand-in pilot for a bare `?scene=surface` jump with no loaded save. */
const DEMO_CREATION: CharacterCreation = {
  name: 'Salvager',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  difficulty: 'normal',
};

/** Spawn director cadence and placement (initial tuning; SPEC-012 owns the real one). */
const SPAWN_INTERVAL = 0.75;
const SPAWN_RING_MIN = 14;
const SPAWN_RING_MAX = 26;
/** Non-aggroed enemies farther than this from the player are silently recycled. */
const CULL_DISTANCE = 70;
/** 11-h: an unclaimed loot orb stays this long. */
const ORB_SECONDS = 60;
/** The nest engagement zone: entering it arms `world.arena` for the boss leash. */
const NEST_ENGAGE_MARGIN = 0;
const NEST_DISENGAGE_DISTANCE = 45;

interface Orb {
  drop: LootDrop;
  kind: 'resource' | 'item' | 'gear';
  x: number;
  z: number;
  expiresAt: number;
}

export class SurfaceCombatDemo extends PlaceholderScene<'surface'> {
  #world: CombatWorld | null = null;
  #combat: Combat | null = null;
  #economy: Economy | null = null;
  #save: SaveV1 | null = null;
  #view: SurfaceCombatView | null = null;
  #input: InputState | null = null;
  #spawnRng: Rng | null = null;

  #halfSize = 100;
  #spawnTable: readonly { enemy: EnemyId; weight: number; maxAlive: number }[] = [];
  #population = 0;
  #eliteChance = 0;
  #nest: { x: number; z: number; boss: EnemyId } | null = null;
  #arena: ArenaState | null = null;
  #bossDefeated = false;

  #spawnTimer = 0;
  #spawned = 0;
  #elites = 0;
  #kills = 0;
  readonly #orbs: Orb[] = [];

  // HUD nodes and their last-painted values, so the loop only writes deltas.
  #hpFill: HTMLElement | null = null;
  #hpText: HTMLElement | null = null;
  #counters: HTMLElement | null = null;
  #bossBar: HTMLElement | null = null;
  #bossFill: HTMLElement | null = null;
  #toast: HTMLElement | null = null;
  #death: HTMLElement | null = null;
  #deathCause: HTMLElement | null = null;
  #lastHp = -1;
  #lastCounters = '';
  #lastBossFrac = -1;
  #toastUntil = 0;
  #toastShown = false;

  readonly #aimScratch = new THREE.Vector3();
  readonly #aimPoint = { x: 0, z: 0 };
  readonly #weightScratch: { item: EnemyId; weight: number }[] = [];
  readonly #aliveCounts = new Map<EnemyId, number>();

  constructor(services: GameServices) {
    super(services, 'surface', { pausable: true });
  }

  override enter(params: SceneParams['surface']): void {
    super.enter(params);
    const planet = PLANETS[params.planet];
    const surface = planet.surface;
    this.#halfSize = surface.halfSize;
    this.#spawnTable = surface.spawn;
    this.#population = surface.population;
    this.#eliteChance = surface.eliteChance;

    // A bare `?scene=` jump has no loaded save; the demo runs on an in-memory
    // one seeded from the session root (never persisted — SPEC-007 owns slots).
    const save = this.services.save.current ?? newSave(0, DEMO_CREATION, this.services.rng.seed, Date.now());
    this.#save = save;

    // SPEC-008 streams: the world layout from the layout stream (same on every
    // landing), everything that happens in it from a visit stream.
    const layout = this.services.rng.layout(planet.id);
    const visit = this.services.rng.visit(planet.id, 1);
    this.#spawnRng = visit.fork('spawn');

    const nestPoi = surface.pois.find((poi) => poi.kind === 'arena');
    let nest: { x: number; z: number; radius: number } | null = null;
    if (nestPoi !== undefined && nestPoi.boss !== undefined) {
      const distance = Math.min(80, nestPoi.band[0]);
      const angle = layout.angle();
      nest = { x: Math.cos(angle) * distance, z: Math.sin(angle) * distance, radius: nestPoi.radius };
      this.#nest = { x: nest.x, z: nest.z, boss: nestPoi.boss };
      this.#arena = { x: nest.x, z: nest.z, radius: nestPoi.radius, locked: true };
    }

    const obstacles = this.#scatterRocks(layout, surface.obstacles, nest);

    // §4.8: landing sets HP to full (the save carries it between fights).
    const stats = computePlayerStats(save);
    save.player.hp = stats.maxHp;
    const world: CombatWorld = {
      player: makePlayer(0, 0, stats.maxHp),
      stats,
      enemies: new Pool(makeEnemy),
      projectiles: new Pool(makeProjectile),
      follower: null,
      obstacles: new CircleObstacles(obstacles),
      arena: null,
      time: 0,
    };
    this.#world = world;

    const bus = this.services.events as EventBus<GameEvents>;
    const progression = new Progression(save, bus);
    const economy = new Economy(save, bus, progression, this.services.save);
    this.#economy = economy;
    const combat = new Combat(world, save, economy, progression, bus, {
      loot: visit.fork('loot'),
      ai: visit.fork('ai'),
      combat: visit.fork('combat'),
    });
    this.#combat = combat;
    this.disposer.add(() => combat.dispose());

    // The demo always auto-fires so combat is observable hands-free; the
    // wrapper leaves the user's `autoFire` setting untouched.
    const raw = this.services.input.state;
    this.#input = {
      get move() {
        return raw.move;
      },
      get aim() {
        return raw.aim;
      },
      get buttons() {
        return raw.buttons;
      },
      get scheme() {
        return raw.scheme;
      },
      autoFire: true,
    };

    const view = new SurfaceCombatView(this.scene, {
      palette: surface.palette,
      fogDensity: surface.fogDensity,
      halfSize: surface.halfSize,
      obstacles,
      nest,
    });
    this.#view = view;
    this.disposer.add(() => view.dispose());

    if (this.#nest !== null) combat.spawnEnemy(this.#nest.boss, this.#nest.x, this.#nest.z, false);

    this.#mountHud();
    this.#subscribe();
  }

  override update(dt: number): void {
    super.update(dt);
    const world = this.#world;
    const combat = this.#combat;
    const input = this.#input;
    if (world === null || combat === null || input === null) return;

    this.#movePlayer(world, dt);
    combat.update(dt, input, this.#aimWorld(world));
    this.#updateArena(world);
    this.#spawnTick(world, dt);
    this.#cullFar(world);
    this.#collectOrbs(world);
    this.#followCamera(world);
    this.#view?.sync({
      player: world.player,
      enemies: world.enemies,
      projectiles: world.projectiles,
      orbs: this.#orbs,
      time: world.time,
    });
    this.#paintHud(world);
  }

  override debugInfo(): Record<string, number | string> {
    const info = super.debugInfo();
    const world = this.#world;
    if (world !== null) {
      info['enemies'] = world.enemies.size;
      info['spawned'] = this.#spawned;
      info['elites'] = this.#elites;
      const boss = this.#findBoss(world);
      info['boss'] = boss === null ? (this.#bossDefeated ? 'defeated' : '-') : `p${boss.phase} ${boss.hp}/${boss.maxHp}`;
    }
    return info;
  }

  // -------------------------------------------------------------- world gen

  /** Deterministic rocks off the layout stream, clear of the pad and the nest. */
  #scatterRocks(
    layout: Rng,
    spec: { minRadius: number; maxRadius: number },
    nest: { x: number; z: number; radius: number } | null,
  ): ObstacleCircle[] {
    const rocks: ObstacleCircle[] = [];
    for (let i = 0; i < 120 && rocks.length < 48; i++) {
      const at = layout.inDisc(this.#halfSize * 0.6);
      const radius = layout.float(spec.minRadius, spec.maxRadius);
      if (Math.hypot(at.x, at.z) < 12 + radius) continue; // the pad stays open
      if (nest !== null && Math.hypot(at.x - nest.x, at.z - nest.z) < nest.radius + radius + 2) continue;
      rocks.push({ x: at.x, z: at.z, radius });
    }
    return rocks;
  }

  // -------------------------------------------------------- player movement

  /** The scene owns movement (§1): input → `vx/vz`, axis-slide, world clamp. */
  #movePlayer(world: CombatWorld, dt: number): void {
    const p = world.player;
    if (!p.alive) {
      p.vx = 0;
      p.vz = 0;
      return;
    }
    const move = this.services.input.state.move;
    // `move.y` is up on screen; the camera looks down −z, so up is −z.
    p.vx = move.x * world.stats.moveSpeed;
    p.vz = -move.y * world.stats.moveSpeed;
    const nx = p.x + p.vx * dt;
    const nz = p.z + p.vz * dt;
    if (!world.obstacles.hitsCircle(nx, p.z, p.radius)) p.x = nx;
    if (!world.obstacles.hitsCircle(p.x, nz, p.radius)) p.z = nz;
    const edge = this.#halfSize - 2;
    p.x = Math.max(-edge, Math.min(edge, p.x));
    p.z = Math.max(-edge, Math.min(edge, p.z));
  }

  /** The ground-plane aim point: touch drag direction, or the pointer ray. */
  #aimWorld(world: CombatWorld): { x: number; z: number } | null {
    const aim = this.services.input.state.aim;
    const p = world.player;
    if (aim.dragging) {
      this.#aimPoint.x = p.x + aim.dirX * 12;
      this.#aimPoint.z = p.z - aim.dirY * 12;
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

  #followCamera(world: CombatWorld): void {
    const p = world.player;
    this.camera.position.set(p.x, 26, p.z + 16);
    this.camera.lookAt(p.x, 0, p.z);
  }

  // ------------------------------------------------------------------ arena

  /**
   * `world.arena` is armed only while the boss fight is on: the soft boundary
   * in the common AI steers *every* enemy toward a set arena, so an always-on
   * one would drag the whole field into the nest.
   */
  #updateArena(world: CombatWorld): void {
    if (this.#arena === null || this.#bossDefeated) {
      world.arena = null;
      return;
    }
    const p = world.player;
    const d = Math.hypot(p.x - this.#arena.x, p.z - this.#arena.z);
    const boss = this.#findBoss(world);
    if (world.arena === null) {
      if (boss !== null && d <= this.#arena.radius + NEST_ENGAGE_MARGIN) world.arena = this.#arena;
    } else if (d > NEST_DISENGAGE_DISTANCE && (boss === null || !boss.aggro)) {
      world.arena = null;
    }
  }

  #findBoss(world: CombatWorld): EnemyEntity | null {
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.def.archetype === 'boss' && e.state !== 'dead') return e;
    }
    return null;
  }

  // -------------------------------------------------------- spawn director

  /** Keeps the field at the planet's population, rolling elites at its rate. */
  #spawnTick(world: CombatWorld, dt: number): void {
    const rng = this.#spawnRng;
    if (rng === null || !world.player.alive) return;
    if (world.arena !== null) return; // no adds during the boss fight
    this.#spawnTimer -= dt;
    if (this.#spawnTimer > 0) return;
    this.#spawnTimer = SPAWN_INTERVAL;

    this.#aliveCounts.clear();
    let alive = 0;
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.state === 'dead' || e.def.archetype === 'boss') continue;
      alive++;
      this.#aliveCounts.set(e.def.id, (this.#aliveCounts.get(e.def.id) ?? 0) + 1);
    }
    if (alive >= this.#population) return;

    this.#weightScratch.length = 0;
    for (const row of this.#spawnTable) {
      if ((this.#aliveCounts.get(row.enemy) ?? 0) < row.maxAlive) {
        this.#weightScratch.push({ item: row.enemy, weight: row.weight });
      }
    }
    if (this.#weightScratch.length === 0) return;
    const id = rng.weighted(this.#weightScratch);
    const def = ENEMIES[id];

    const p = world.player;
    for (let attempt = 0; attempt < 6; attempt++) {
      const at = rng.onRing(SPAWN_RING_MIN, SPAWN_RING_MAX);
      const x = p.x + at.x;
      const z = p.z + at.z;
      if (Math.abs(x) > this.#halfSize - 4 || Math.abs(z) > this.#halfSize - 4) continue;
      if (world.obstacles.hitsCircle(x, z, def.radius + 0.5)) continue;
      if (this.#nest !== null && Math.hypot(x - this.#nest.x, z - this.#nest.z) < 28) continue;
      const elite = rollElite(def, this.#eliteChance, rng);
      this.#combat?.spawnEnemy(id, x, z, elite);
      return;
    }
  }

  /** Recycle far, disengaged enemies without loot or XP (a plain despawn). */
  #cullFar(world: CombatWorld): void {
    const p = world.player;
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.state === 'dead' || e.aggro || e.def.archetype === 'boss') continue;
      if (Math.hypot(e.x - p.x, e.z - p.z) > CULL_DISTANCE) e.state = 'dead';
    }
  }

  // ---------------------------------------------------------------- pickups

  /** Drain `Combat.drops` into orbs; collect within `pickupRadius` (11-h). */
  #collectOrbs(world: CombatWorld): void {
    const combat = this.#combat;
    const economy = this.#economy;
    if (combat === null || economy === null) return;
    for (const drop of combat.drops) {
      this.#orbs.push({ drop, kind: drop.kind, x: drop.x, z: drop.z, expiresAt: world.time + ORB_SECONDS });
    }
    combat.drops.length = 0;

    const p = world.player;
    const reach = world.stats.pickupRadius;
    for (let i = this.#orbs.length - 1; i >= 0; i--) {
      const orb = this.#orbs[i] as Orb;
      if (world.time >= orb.expiresAt) {
        this.#orbs.splice(i, 1);
        continue;
      }
      if (!p.alive || Math.hypot(orb.x - p.x, orb.z - p.z) > reach) continue;
      const drop = orb.drop;
      let taken: boolean;
      if (drop.kind === 'resource') {
        const result = economy.addResource(drop.resource, drop.amount, 'pickup');
        taken = result.added > 0 || result.blocked === 0;
      } else {
        // 11-h: a duplicate or a full inventory leaves the orb where it lies.
        const result = economy.addItem(drop.itemId, drop.kind === 'item' ? drop.qty : 1);
        taken = result.added > 0 || result.blocked === 0;
      }
      if (taken) this.#orbs.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------- HUD

  #subscribe(): void {
    const events = this.services.events;
    this.disposer.add(
      events.on(
        'player:died',
        (payload) => {
          if (this.#death !== null) this.#death.classList.add('is-visible');
          if (this.#deathCause !== null) {
            this.#deathCause.textContent =
              payload.cause.kind === 'enemy' || payload.cause.kind === 'projectile'
                ? `Killed by ${ENEMIES[payload.cause.enemyId].name}`
                : `Cause: ${payload.cause.kind}`;
          }
        },
        this,
      ),
    );
    this.disposer.add(
      events.on(
        'enemy:spawned',
        (payload) => {
          this.#spawned++;
          if (payload.elite) this.#elites++;
        },
        this,
      ),
    );
    this.disposer.add(events.on('enemy:killed', () => this.#kills++, this));
    this.disposer.add(events.on('boss:defeated', () => (this.#bossDefeated = true), this));
    this.disposer.add(
      events.on(
        'ui:toast',
        (payload) => {
          if (this.#toast !== null) this.#toast.textContent = payload.text;
          this.#toastShown = true;
          this.#toastUntil = (this.#world?.time ?? 0) + 3;
        },
        this,
      ),
    );
  }

  #mountHud(): void {
    const root = document.getElementById('ui');
    if (root === null) return;
    const hud = document.createElement('div');
    hud.className = 'combat-hud';

    const hp = document.createElement('div');
    hp.className = 'hud-hp';
    hp.dataset['testid'] = 'hud-hp';
    const hpFill = document.createElement('div');
    hpFill.className = 'hud-hp-fill';
    const hpText = document.createElement('span');
    hpText.className = 'hud-hp-text';
    hp.append(hpFill, hpText);

    const counters = document.createElement('p');
    counters.className = 'hud-counters';
    counters.dataset['testid'] = 'hud-counters';

    const bossBar = document.createElement('div');
    bossBar.className = 'hud-boss';
    bossBar.dataset['testid'] = 'hud-boss';
    const bossFill = document.createElement('div');
    bossFill.className = 'hud-boss-fill';
    bossBar.append(bossFill);

    const toast = document.createElement('p');
    toast.className = 'hud-toast';
    toast.dataset['testid'] = 'hud-toast';

    const death = document.createElement('div');
    death.className = 'hud-death';
    death.dataset['testid'] = 'hud-death';
    const deathTitle = document.createElement('p');
    deathTitle.className = 'hud-death-title';
    deathTitle.textContent = 'You died';
    const deathCause = document.createElement('p');
    deathCause.className = 'hud-death-cause';
    const respawn = document.createElement('button');
    respawn.type = 'button';
    respawn.className = 'hud-button';
    respawn.dataset['testid'] = 'demo-respawn';
    respawn.textContent = 'Respawn';
    respawn.addEventListener('click', () => this.#respawn());
    death.append(deathTitle, deathCause, respawn);

    hud.append(hp, counters, bossBar, toast, death);
    if (new URLSearchParams(globalThis.location.search).has('debug')) hud.append(this.#buildDebugStrip());
    root.append(hud);
    this.disposer.add(() => hud.remove());

    this.#hpFill = hpFill;
    this.#hpText = hpText;
    this.#counters = counters;
    this.#bossBar = bossBar;
    this.#bossFill = bossFill;
    this.#toast = toast;
    this.#death = death;
    this.#deathCause = deathCause;
  }

  /** `?debug` only: shortcuts so the acceptance run fits a QA session. */
  #buildDebugStrip(): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'hud-debug';
    const button = (testid: string, label: string, onClick: () => void): void => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'hud-button';
      el.dataset['testid'] = testid;
      el.textContent = label;
      el.addEventListener('click', onClick);
      strip.append(el);
    };
    button('demo-hurt', 'Hurt me', () => this.#combat?.damagePlayer(60, { kind: 'fall' }));
    button('demo-goto-boss', 'To boss', () => {
      const world = this.#world;
      if (world === null || this.#nest === null || !world.player.alive) return;
      world.player.x = this.#nest.x;
      world.player.z = this.#nest.z + 12;
    });
    button('demo-wound-boss', 'Wound boss', () => {
      const world = this.#world;
      const boss = world === null ? null : this.#findBoss(world);
      // 11-f: a boss mid-special ignores damage, the shortcut included.
      if (boss !== null && !boss.invulnerable) boss.hp = Math.max(1, boss.hp - Math.round(boss.maxHp * 0.25));
    });
    return strip;
  }

  #paintHud(world: CombatWorld): void {
    const p = world.player;
    const hp = Math.max(0, Math.round(p.hp));
    if (hp !== this.#lastHp && this.#hpFill !== null && this.#hpText !== null) {
      this.#lastHp = hp;
      this.#hpFill.style.width = `${Math.max(0, Math.min(100, (hp / world.stats.maxHp) * 100))}%`;
      this.#hpText.textContent = `HP ${hp}/${world.stats.maxHp}`;
    }
    const counters = `spawned ${this.#spawned} · elites ${this.#elites} · kills ${this.#kills}`;
    if (counters !== this.#lastCounters && this.#counters !== null) {
      this.#lastCounters = counters;
      this.#counters.textContent = counters;
    }
    const boss = this.#findBoss(world);
    const frac = boss !== null && boss.aggro ? boss.hp / boss.maxHp : -1;
    if (frac !== this.#lastBossFrac && this.#bossBar !== null && this.#bossFill !== null) {
      this.#lastBossFrac = frac;
      this.#bossBar.classList.toggle('is-visible', frac >= 0);
      this.#bossFill.style.width = `${Math.max(0, frac * 100)}%`;
    }
    if (this.#toastShown && world.time >= this.#toastUntil && this.#toast !== null) {
      this.#toast.textContent = '';
      this.#toastShown = false;
    }
  }

  // ---------------------------------------------------------------- respawn

  /**
   * The scene-side half of the death round trip (§4.8): Combat has no respawn
   * method by design (AC-45) — the scene resets the entity and announces it.
   */
  #respawn(): void {
    const world = this.#world;
    const save = this.#save;
    if (world === null || save === null || world.player.alive) return;
    const p = world.player;
    p.x = 0;
    p.z = 0;
    p.vx = 0;
    p.vz = 0;
    p.hp = world.stats.maxHp;
    p.alive = true;
    p.invulnUntil = world.time + TUNING.INVULN_AFTER_RESPAWN;
    p.fireCooldown = 0;
    p.healOverTime = null;
    p.boosts.length = 0;
    p.hazardImmuneUntil = 0;
    save.player.hp = p.hp; // §4.8: respawn sets the saved HP to full
    this.#lastHp = -1;
    this.#death?.classList.remove('is-visible');
    this.services.events.emit('player:respawned');
  }
}
