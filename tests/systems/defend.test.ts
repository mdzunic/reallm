// SPEC-034 §4.8, §6.1 — Eden's final defence, simulated.
//
// The review stood a player at the survey beacon through `c6_m2`'s 240 s and
// watched 0 of the 47 `eden_final` enemies come in: the wave spawned un-aggroed
// on a 30–55 m ring and leashed to its own spawn point, so the last fight of the
// campaign was a four-minute wait in which the beacon took no damage at all.
//
// This is the same simulation, over the real `Missions`, `SpawnDirector`,
// `Combat` and `EnemyAi` — only the scene's own defend accounting (`#updateDefend`,
// which is DOM-free arithmetic over the entity pool) is restated here, because
// the scene needs `three`.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { ACTIONS, type Action, type ButtonState, type InputState } from '@/core/Input';
import { Pool } from '@/core/Pool';
import { QUALITY } from '@/core/Renderer';
import { Rng, RngRoot, hash32 } from '@/core/Rng';
import { newSave, type CharacterCreation } from '@/core/Save';
import { PLANETS, WAVES } from '@/data/index';
import { makeEnemy } from '@/entities/Enemy';
import { makePlayer } from '@/entities/Player';
import { makeProjectile } from '@/entities/Projectile';
import { Combat, computePlayerStats, type CombatWorld, type EconomyPort } from '@/systems/Combat';
import { Economy } from '@/systems/Economy';
import { generateLayout, ObstacleGrid } from '@/systems/Layout';
import { Missions, type MissionContext } from '@/systems/Missions';
import { Progression } from '@/systems/Progression';
import { SpawnDirector, type FrustumXZ } from '@/systems/Spawn';

const STEP = 1 / 60;
/** The scene's own contact margin (`Surface.ts` DEFEND_CONTACT_MARGIN). */
const DEFEND_CONTACT_MARGIN = 2;
/** §4.8: an enemy counts as engaged once it is aggroed inside this of the beacon. */
const ENGAGE_RADIUS = 20;
const NOWHERE: FrustumXZ = { contains: () => false };

const MARINE: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  attributes: { might: 3, vigor: 8, agility: 1, tech: 1 },
  appearance: { portrait: 0, primary: '#b7472a', secondary: '#2a3b4c' },
  difficulty: 'normal',
};

function makeInput(): InputState {
  const buttons = {} as Record<Action, ButtonState>;
  for (const action of ACTIONS) {
    buttons[action] = { down: false, justPressed: false, justReleased: false, heldFor: 0 };
  }
  return {
    move: { x: 0, y: 0 },
    aim: { screenX: 0, screenY: 0, ndcX: 0, ndcY: 0, hasPointer: false, dragging: false, dirX: 0, dirY: 0 },
    buttons,
    scheme: 'keyboard',
    autoFire: true,
  };
}

describe("Eden's last wave reaches the beacon (SPEC-034 §4.8)", () => {
  it('at least 40 of the 47 enemies engage, and the beacon loses HP', () => {
    const planet = PLANETS.eden;
    const layout = generateLayout(planet, new RngRoot(9).layout('eden'));
    const beacon = layout.pois.find((p) => p.poi === 'survey_beacon');
    expect(beacon, 'the survey beacon').toBeDefined();
    const poi = beacon as NonNullable<typeof beacon>;
    const beaconMax = planet.surface.pois.find((p) => p.id === 'survey_beacon')?.hp ?? 0;
    expect(beaconMax).toBeGreaterThan(0);

    const save = newSave(0, MARINE, 9, 1_700_000_000_000);
    save.progress.currentPlanet = 'eden';
    save.progress.flags.push('chapter5_done');
    save.progress.missionsDone.push('c6_m1');

    const events = new EventBus<GameEvents>({ dev: false });
    const progression = new Progression(save, events);
    const economy = new Economy(save, events, progression);
    const missions = new Missions(save, economy, events, 'surface', 'eden');
    expect(missions.accept('c6_m2').ok).toBe(true);
    const stage = missions.defendStage();
    expect(stage).toEqual({ poi: 'survey_beacon', wave: 'eden_final', seconds: 240 });

    const port: EconomyPort = {
      addResource: () => ({ added: 0, shipped: 0, blocked: 0 }),
      addItem: () => ({ added: 0, blocked: 0 }),
    };
    const stats = computePlayerStats(save);
    const world: CombatWorld = {
      player: makePlayer(poi.x, poi.z, stats.maxHp),
      stats,
      enemies: new Pool(makeEnemy),
      projectiles: new Pool(makeProjectile),
      follower: null,
      obstacles: new ObstacleGrid(layout),
      arena: null,
      bounds: planet.surface.halfSize - 2,
      time: 0,
    };
    const rng = {
      loot: new Rng(hash32(9, 'loot')),
      ai: new Rng(hash32(9, 'ai')),
      combat: new Rng(hash32(9, 'combat')),
    };
    const combat = new Combat(world, save, port, progression, events, rng);
    const spawn = new SpawnDirector(planet, layout, world.enemies, QUALITY.medium, new Rng(hash32(9, 'spawn')), events, combat);
    const wave = spawn.startWave('eden_final', { x: poi.x, z: poi.z });

    // The player stands at the beacon and cannot die — this is a test of whether
    // the wave *arrives*, not of whether it can be survived.
    const input = makeInput();
    const ctx: MissionContext = {
      player: { x: poi.x, z: poi.z, alive: true },
      poiAt: (id) => layout.pois.filter((p) => p.poi === id),
      heldResource: (r) => save.resources[r],
      nearPoi: () => null,
    };

    /** Every wave enemy that has been aggroed inside `ENGAGE_RADIUS` of the beacon. */
    const engaged = new Set<number>();
    let beaconHp = beaconMax;
    let accum = 0;
    let damaged = 0;
    events.on('poi:damaged', () => damaged++, {});

    const steps = Math.round(240 / STEP);
    for (let i = 0; i < steps; i++) {
      world.player.x = poi.x;
      world.player.z = poi.z;
      world.player.hp = stats.maxHp;
      world.player.invulnUntil = world.time + 10;
      combat.update(STEP, input, null);
      spawn.update(STEP, world.player, NOWHERE, true);
      missions.update(STEP, ctx);

      let pressure = 0;
      for (let k = 0; k < world.enemies.size; k++) {
        const e = world.enemies.at(k);
        if (e.state === 'dead') continue;
        const d = Math.hypot(e.x - poi.x, e.z - poi.z);
        if (e.fromWave && e.aggro && d <= ENGAGE_RADIUS) engaged.add(e.id);
        if (d <= poi.radius + DEFEND_CONTACT_MARGIN) pressure += e.damage;
      }
      // The scene's own arithmetic: 20 % of the standing damage per second.
      if (pressure > 0) {
        accum += pressure * 0.2 * STEP;
        const whole = Math.floor(accum);
        if (whole > 0) {
          accum -= whole;
          beaconHp = Math.max(0, beaconHp - whole);
          events.emit('poi:damaged', { poi: poi.poi, hp: beaconHp, max: beaconMax });
        }
      }
    }

    const total = WAVES.eden_final.groups.reduce((sum, group) => sum + group.count, 0);
    expect(total).toBe(47);
    expect(engaged.size, `${engaged.size} of ${total} engaged`).toBeGreaterThanOrEqual(40);
    expect(damaged).toBeGreaterThan(0);
    expect(beaconHp).toBeLessThan(beaconMax);
    missions.dispose();
    combat.dispose();
  });
});
