// Shared harness for the SPEC-011 suites (`combat.test.ts`, `enemyAi.test.ts`).
// Builds a minimal CombatWorld over the real pools, a real EventBus with an
// `onAny` recorder, and fixed-seed RNG streams — every test is deterministic.
import { EventBus, type GameEvents } from '@/core/Events';
import type { ButtonState, InputState } from '@/core/Input';
import { Pool } from '@/core/Pool';
import { Rng, hash32 } from '@/core/Rng';
import { newSave, type CharacterCreation, type Save } from '@/core/Save';
import type { EnemyId } from '@/data/index';
import { makeEnemy, type EnemyEntity } from '@/entities/Enemy';
import { makeFollower } from '@/entities/Follower';
import { makePlayer } from '@/entities/Player';
import { makeProjectile, type ProjectileEntity } from '@/entities/Projectile';
import { FOLLOWERS } from '@/data/followers';
import { NO_OBSTACLES, type ArenaState, type ObstacleGrid } from '@/entities/World';
import { Combat, computePlayerStats, type CombatWorld, type EconomyPort } from '@/systems/Combat';
import { Progression } from '@/systems/Progression';

export const STEP = 1 / 60;

export const MARINE: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  // Class base {3, 3, 1, 1} plus the five creation points on vigor (§6 pin).
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  difficulty: 'normal',
};

export const SCOUT: CharacterCreation = {
  name: 'Sable',
  classId: 'scout',
  // Class base, creation points elsewhere — the §6 speed pin uses agility 4.
  attributes: { might: 3, vigor: 3, agility: 4, tech: 1 },
  appearance: { portrait: 6, primary: '#3a7a5a', secondary: '#222222' },
  difficulty: 'normal',
};

function button(): ButtonState {
  return { down: false, justPressed: false, justReleased: false, heldFor: 0 };
}

export function makeInput(): InputState {
  return {
    move: { x: 0, y: 0 },
    aim: {
      screenX: 0,
      screenY: 0,
      ndcX: 0,
      ndcY: 0,
      hasPointer: false,
      dragging: false,
      dirX: 0,
      dirY: 0,
    },
    buttons: {
      fire: button(),
      interact: button(),
      useItem: button(),
      pause: button(),
      throttleUp: button(),
      throttleDown: button(),
      map: button(),
      debug: button(),
    },
    scheme: 'keyboard',
    autoFire: false,
  };
}

export interface Recorded {
  name: keyof GameEvents;
  payload: unknown;
}

export interface Harness {
  world: CombatWorld;
  combat: Combat;
  save: Save;
  events: EventBus<GameEvents>;
  progression: Progression;
  rng: { loot: Rng; ai: Rng; combat: Rng };
  input: InputState;
  aim: { x: number; z: number } | null;
  recorded: Recorded[];
  of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]>;
  /** Advance the world by whole 60 Hz steps covering `seconds`. */
  run(seconds: number): void;
  step(): void;
  spawn(id: EnemyId, x: number, z: number, elite?: boolean): EnemyEntity;
  /** A raw pooled projectile for collision tests; caller sets the fields. */
  shot(patch: Partial<ProjectileEntity>): ProjectileEntity;
}

export interface HarnessOptions {
  creation?: CharacterCreation;
  patch?: (save: Save) => void;
  obstacles?: ObstacleGrid;
  arena?: ArenaState | null;
  follower?: boolean;
  seed?: number;
}

export function harness(options: HarnessOptions = {}): Harness {
  const save = newSave(0, options.creation ?? MARINE, 42, 1_700_000_000_000);
  options.patch?.(save);
  const seed = options.seed ?? 1234;
  const rng = {
    loot: new Rng(hash32(seed, 'loot')),
    ai: new Rng(hash32(seed, 'ai')),
    combat: new Rng(hash32(seed, 'combat')),
  };
  const events = new EventBus<GameEvents>({ dev: false });
  const recorded: Recorded[] = [];
  events.onAny((name, payload) => recorded.push({ name, payload }));
  const progression = new Progression(save, events);
  const economy: EconomyPort = {
    addResource: () => ({ added: 0, blocked: 0 }),
    addItem: () => ({ added: 0, blocked: 0 }),
  };
  const stats = computePlayerStats(save);
  const world: CombatWorld = {
    player: makePlayer(0, 0, stats.maxHp),
    stats,
    enemies: new Pool(makeEnemy),
    projectiles: new Pool(makeProjectile),
    follower: options.follower === true ? makeFollower(FOLLOWERS.science_probe, 0, -2) : null,
    obstacles: options.obstacles ?? NO_OBSTACLES,
    arena: options.arena ?? null,
    time: 0,
  };
  const combat = new Combat(world, save, economy, progression, events, rng);
  const input = makeInput();
  const h: Harness = {
    world,
    combat,
    save,
    events,
    progression,
    rng,
    input,
    aim: null,
    recorded,
    of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]> {
      return recorded.filter((r) => r.name === name).map((r) => r.payload as GameEvents[K]);
    },
    run(seconds: number): void {
      const steps = Math.round(seconds / STEP);
      for (let i = 0; i < steps; i++) combat.update(STEP, input, h.aim);
    },
    step(): void {
      combat.update(STEP, input, h.aim);
    },
    spawn(id: EnemyId, x: number, z: number, elite = false): EnemyEntity {
      return combat.spawnEnemy(id, x, z, elite);
    },
    shot(patch: Partial<ProjectileEntity>): ProjectileEntity {
      const p = world.projectiles.alloc();
      Object.assign(p, {
        x: 0,
        z: 0,
        vx: 0,
        vz: 0,
        radius: 0.15,
        damage: 1,
        pierceLeft: 0,
        owner: 'player',
        ttl: 10,
        hitIds: null,
        enemyId: null,
        elite: false,
      });
      p.hitIds?.clear();
      Object.assign(p, patch);
      return p;
    },
  };
  return h;
}

/** The pool index of a live enemy, for direct inspection after swap-removes. */
export function findEnemy(world: CombatWorld, id: number): EnemyEntity | null {
  for (let i = 0; i < world.enemies.size; i++) {
    if (world.enemies.at(i).id === id) return world.enemies.at(i);
  }
  return null;
}
