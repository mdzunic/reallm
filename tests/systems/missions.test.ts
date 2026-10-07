// SPEC-012 §6 — the mission runtime (AC-28..AC-44). Runs over the real
// Economy/Progression stack so rewards, replay fractions and cargo behaviour
// are the shipped ones, with a synthetic layout context for POI queries.
//
// SPEC-024 §6 adds the campaign's last minute: the E24 lock that keeps one save
// to one ending, and the dev control that finishes a stage through the runtime.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { hash32 } from '@/core/Rng';
import { newSave, type Save } from '@/core/Save';
import { CONTRACT_IDS, CONTRACT_LITHIUM, MISSIONS, TUNING, type ContractId, type MissionId, type PlanetId } from '@/data/index';
import { Economy } from '@/systems/Economy';
import { contractFor, Missions, type MissionContext } from '@/systems/Missions';
import type { LayoutPoi } from '@/systems/Layout';
import { Progression } from '@/systems/Progression';
import { missionStatus } from '@/systems/UiHelpers';
import { MARINE } from './combatFixtures';

const STEP = 1 / 60;

/** Cinder-4's POIs, at synthetic positions the tests can walk to. */
const POIS: LayoutPoi[] = [
  { poi: 'landing_pad', instance: 0, x: 0, z: 0, radius: 6, kind: 'landing_pad' },
  { poi: 'dune_sea', instance: 0, x: 70, z: 0, radius: 5, kind: 'scan' },
  { poi: 'beacon', instance: 0, x: 50, z: 20, radius: 5, kind: 'deliver' },
  { poi: 'silo_ruin', instance: 0, x: 0, z: 80, radius: 5, kind: 'scan' },
  { poi: 'wurm_nest', instance: 0, x: 120, z: 0, radius: 22, kind: 'arena' },
];

interface Harness {
  save: Save;
  events: EventBus<GameEvents>;
  economy: Economy;
  missions: Missions;
  ctx: MissionContext & { player: { x: number; z: number; alive: boolean } };
  recorded: { name: string; payload: unknown }[];
  of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]>;
  run(seconds: number): void;
  saveRequests: string[];
}

function harness(
  patch?: (save: Save) => void,
  scene: 'surface' | 'flight' = 'surface',
  planet: PlanetId = 'cinder4',
): Harness {
  const save = newSave(0, MARINE, 42, 1_700_000_000_000);
  save.progress.currentPlanet = planet;
  patch?.(save);
  const events = new EventBus<GameEvents>({ dev: false });
  const recorded: { name: string; payload: unknown }[] = [];
  events.onAny((name, payload) => recorded.push({ name: name as string, payload }));
  const saveRequests: string[] = [];
  const requester = { request: (reason: string) => void saveRequests.push(reason) };
  const progression = new Progression(save, events);
  const economy = new Economy(save, events, progression, requester);
  const missions = new Missions(save, economy, events, scene, planet, requester);
  const ctx: Harness['ctx'] = {
    player: { x: 0, z: 0, alive: true },
    poiAt: (id) => POIS.filter((p) => p.poi === id),
    heldResource: (r) => save.resources[r],
    nearPoi: (id, radius) => {
      for (const poi of POIS) {
        if (poi.poi !== id) continue;
        if (Math.hypot(ctx.player.x - poi.x, ctx.player.z - poi.z) <= (radius ?? poi.radius)) return poi;
      }
      return null;
    },
    follower: null,
    // SPEC-054 §3: every harness run is on the surface unless a test flips it.
    level: 'surface',
  };
  return {
    save,
    events,
    economy,
    missions,
    ctx,
    recorded,
    saveRequests,
    of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]> {
      return recorded.filter((r) => r.name === name).map((r) => r.payload as GameEvents[K]);
    },
    run(seconds: number): void {
      const steps = Math.round(seconds / STEP);
      for (let i = 0; i < steps; i++) missions.update(STEP, ctx);
    },
  };
}

describe('Missions — accept and stages (AC-38)', () => {
  it('stages run sequentially and announce their starts', () => {
    const h = harness();
    expect(h.missions.accept('c1_m1')).toEqual({ ok: true });
    expect(h.of('mission:accepted')).toEqual([{ id: 'c1_m1' }]);
    expect(h.of('mission:stageStarted')).toEqual([{ id: 'c1_m1', stage: 0 }]);
    expect(h.saveRequests).toContain('stage');

    // Stage 1's scan does nothing while stage 0's reach is open.
    h.events.emit('poi:scanned', { poi: 'dune_sea', instance: 0 });
    expect(h.missions.active[0]?.stage).toBe(0);

    h.events.emit('poi:reached', { poi: 'landing_pad', instance: 0 });
    expect(h.missions.active[0]?.stage).toBe(1);
    expect(h.of('mission:stageStarted').at(-1)).toEqual({ id: 'c1_m1', stage: 1 });

    h.events.emit('poi:scanned', { poi: 'dune_sea', instance: 0 });
    expect(h.missions.active[0]?.stage).toBe(2);
  });

  it('objectives inside one stage complete in any order (AC-31, AC-30)', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1'));
    expect(h.missions.accept('c1_m2')).toEqual({ ok: true });
    // kill first, then collect — the reverse of the data order.
    for (let i = 0; i < 6; i++) {
      h.events.emit('enemy:killed', { enemyId: 'scav_raider', elite: false, x: 0, z: 0, xp: 10 });
    }
    const kills = h.missions.currentObjectives('c1_m2').find((o) => o.objective.kind === 'kill');
    expect(kills?.done).toBe(true);
    expect(h.missions.active).toHaveLength(1);
    h.economy.addResource('oil', 150, 'pickup');
    expect(h.missions.active).toHaveLength(0); // both done → mission complete
    // SPEC-043 §4.5: a clean surface run carries its clock — never under 1 s.
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_m2', replay: false, seconds: 1 }]);
  });

  it('accept refuses a wrong scene, unmet requirements, and doubles (12-j)', () => {
    const h = harness();
    expect(h.missions.accept('c1_m2').ok).toBe(false); // requires c1_m1
    expect(h.missions.accept('c1_m1').ok).toBe(true);
    expect(h.missions.accept('c1_m1').ok).toBe(false); // already active
    expect(h.missions.accept('c5_m1').ok).toBe(false); // another planet, flight scene
  });
});

describe('Missions — collect (AC-30)', () => {
  it('counts only while the stage is active and ignores blocked pickups', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1'));
    // A pickup before accepting counts for nothing.
    h.economy.addResource('oil', 50, 'pickup');
    h.missions.accept('c1_m2');
    const value = () => h.missions.currentObjectives('c1_m2').find((o) => o.objective.kind === 'collect')?.value;
    expect(value()).toBe(0);

    h.economy.addResource('oil', 40, 'pickup');
    expect(value()).toBe(40);

    // Fill the hold to the cap: blocked units add nothing to the counter.
    const cap = h.economy.cargoCap();
    const held = Object.values(h.save.resources).reduce((a, b) => a + b, 0);
    h.economy.addResource('oil', cap - held, 'pickup');
    const at = value() as number;
    h.economy.addResource('oil', 25, 'pickup'); // fully blocked
    expect(value()).toBe(at);
  });
});

describe('Missions — scan (AC-29)', () => {
  it('counts distinct instances only', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1'));
    h.missions.accept('c1_s1');
    const value = () => h.missions.currentObjectives('c1_s1').find((o) => o.objective.kind === 'scan')?.value;
    h.events.emit('poi:scanned', { poi: 'silo_ruin', instance: 0 });
    expect(value()).toBe(1);
    h.events.emit('poi:scanned', { poi: 'silo_ruin', instance: 0 });
    expect(value()).toBe(1); // the same instance again is not a second scan
  });
});

describe('Missions — survive (AC-33, AC-40, AC-44)', () => {
  it('completes on time and resets to zero on death', () => {
    const h = harness();
    h.missions.accept('c1_m1');
    h.events.emit('poi:reached', { poi: 'landing_pad', instance: 0 });
    h.events.emit('poi:scanned', { poi: 'dune_sea', instance: 0 });
    expect(h.missions.active[0]?.stage).toBe(2);
    expect(h.missions.requiredWeather()).toEqual({ weather: 'sandstorm', seconds: 60 });

    h.run(30);
    const timer = () => h.missions.currentObjectives('c1_m1').find((o) => o.objective.kind === 'survive')?.value ?? 0;
    expect(timer()).toBeGreaterThan(29);

    h.events.emit('player:died', { cause: { kind: 'fall' }, scene: 'surface' });
    expect(h.of('mission:stageReset').at(-1)).toEqual({ id: 'c1_m1', stage: 2, reason: 'death' });
    expect(timer()).toBe(0);

    // A dead player accrues nothing; alive again, the full 60 s completes it.
    h.ctx.player.alive = false;
    h.run(10);
    expect(timer()).toBe(0);
    h.ctx.player.alive = true;
    h.run(60.1);
    expect(h.missions.active).toHaveLength(0);
    // SPEC-043 §4.5: the clock ran through the death and the dead seconds: 30 + 10 + 60.
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_m1', replay: false, seconds: 100 }]);
    expect(h.missions.requiredWeather()).toBeNull();
  });
});

describe('Missions — defend resets when the POI dies (AC-34, AC-42)', () => {
  it('poi:damaged at 0 hp restarts the timer, once (12-d)', () => {
    // c6_m2 is Eden's; drive a synthetic defend through the same machinery by
    // reusing its schema on this planet is impossible — so test via the real
    // Eden mission on an Eden runtime.
    const save = newSave(0, MARINE, 42, 1_700_000_000_000);
    save.progress.missionsDone.push('c6_m1');
    const events = new EventBus<GameEvents>({ dev: false });
    const recorded: { name: string; payload: unknown }[] = [];
    events.onAny((name, payload) => recorded.push({ name: name as string, payload }));
    const progression = new Progression(save, events);
    const economy = new Economy(save, events, progression);
    const missions = new Missions(save, economy, events, 'surface', 'eden');
    missions.accept('c6_m2');
    expect(missions.defendStage()).toEqual({ poi: 'survey_beacon', wave: 'eden_final', seconds: 240 });

    const ctx: MissionContext = {
      player: { x: 0, z: 0, alive: true },
      poiAt: () => [],
      heldResource: () => 0,
      nearPoi: () => null,
      follower: null,
      level: 'surface',
    };
    for (let i = 0; i < Math.round(30 / STEP); i++) missions.update(STEP, ctx);
    const timer = () => missions.currentObjectives('c6_m2').find((o) => o.objective.kind === 'defend')?.value ?? 0;
    expect(timer()).toBeGreaterThan(29);

    events.emit('poi:damaged', { poi: 'survey_beacon', hp: 0, max: 600 });
    expect(timer()).toBe(0);
    const resets = recorded.filter((r) => r.name === 'mission:stageReset');
    expect(resets).toHaveLength(1);
    expect((resets[0]?.payload as { reason: string }).reason).toBe('poi_destroyed');

    // 12-d: a second destruction while the timer is still at zero is one reset.
    events.emit('poi:damaged', { poi: 'survey_beacon', hp: 0, max: 600 });
    expect(recorded.filter((r) => r.name === 'mission:stageReset')).toHaveLength(1);

    // The full 240 s then completes the stage and surfaces the choice.
    for (let i = 0; i < Math.round(240.1 / STEP); i++) missions.update(STEP, ctx);
    expect(missions.choiceStage('c6_m2')).not.toBeNull();
  });
});

describe('Missions — deliver (AC-35)', () => {
  it('consumes atomically at the POI and refuses a short hold (E16)', () => {
    const h = harness((save) => {
      save.progress.missionsDone.push('c1_m1', 'c1_m2');
    });
    h.missions.accept('c1_m3');
    h.events.emit('boss:defeated', { boss: 'dune_wurm' });
    expect(h.missions.active[0]?.stage).toBe(1);

    // Not at the beacon: nothing happens however much oil is held.
    h.economy.addResource('oil', 100, 'reward');
    const oil = h.save.resources.oil;
    h.run(1);
    expect(h.save.resources.oil).toBe(oil);

    // At the beacon with too little: no partial delivery.
    h.save.resources.oil = 99;
    h.ctx.player.x = 50;
    h.ctx.player.z = 20;
    h.run(1);
    expect(h.save.resources.oil).toBe(99);
    expect(h.of('poi:delivered')).toHaveLength(0);

    // With enough: the exact amount leaves in one step. Completion then sets
    // `chapter1_done`, whose refuel voucher pays Vetra's 60 oil (SPEC-010
    // §4.6) — so the hold reads 120 − 100 + 60.
    h.save.resources.oil = 120;
    h.run(0.1);
    const spent = h.of('resource:spent').find((p) => p.reason === 'deliver:c1_m3');
    expect(spent).toEqual({ resource: 'oil', amount: 100, total: 20, reason: 'deliver:c1_m3' });
    expect(h.save.resources.oil).toBe(80);
    expect(h.of('poi:delivered')).toEqual([{ poi: 'beacon', resource: 'oil', amount: 100 }]);
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_m3', replay: false, seconds: 2 }]);
  });
});

describe('Missions — escort (AC-36, AC-41)', () => {
  it('completes on the follower reaching the target and resets on its death', () => {
    const save = newSave(0, MARINE, 42, 1_700_000_000_000);
    save.progress.missionsDone.push('c3_m1');
    const events = new EventBus<GameEvents>({ dev: false });
    const recorded: { name: string; payload: unknown }[] = [];
    events.onAny((name, payload) => recorded.push({ name: name as string, payload }));
    const progression = new Progression(save, events);
    const economy = new Economy(save, events, progression);
    const missions = new Missions(save, economy, events, 'surface', 'thessaly');
    missions.accept('c3_m2');
    for (let i = 0; i < 20; i++) {
      events.emit('enemy:killed', { enemyId: 'hive_drone', elite: false, x: 0, z: 0, xp: 5 });
    }
    expect(missions.escortStage()).toEqual({ from: 'probe_site', to: 'hive_mouth', follower: 'science_probe' });

    const hiveMouth: LayoutPoi = { poi: 'hive_mouth', instance: 0, x: 100, z: 0, radius: 20, kind: 'arena' };
    const follower = { x: 0, z: 0, alive: true };
    const ctx: MissionContext = {
      player: { x: 0, z: 0, alive: true },
      poiAt: (id) => (id === 'hive_mouth' ? [hiveMouth] : []),
      heldResource: () => 0,
      nearPoi: () => null,
      follower,
      level: 'surface',
    };

    // E13: the follower dying resets the stage.
    events.emit('follower:died', { follower: 'science_probe' });
    const resets = recorded.filter((r) => r.name === 'mission:stageReset');
    expect(resets).toHaveLength(1);
    expect((resets[0]?.payload as { reason: string }).reason).toBe('follower_died');

    // Far away: nothing. Inside the target radius: done.
    missions.update(STEP, ctx);
    expect(missions.active).toHaveLength(1);
    follower.x = 95;
    missions.update(STEP, ctx);
    expect(missions.active).toHaveLength(0);
  });
});

describe('Missions — choice (AC-37)', () => {
  it('choose() sets the option flags and completes the objective', () => {
    const save = newSave(0, MARINE, 42, 1_700_000_000_000);
    save.progress.missionsDone.push('c6_m1');
    save.progress.missionsActive.push({ id: 'c6_m2', stage: 1, counters: {} });
    const events = new EventBus<GameEvents>({ dev: false });
    const progression = new Progression(save, events);
    const economy = new Economy(save, events, progression);
    const missions = new Missions(save, economy, events, 'surface', 'eden');
    expect(missions.choiceStage('c6_m2')?.options).toHaveLength(2);

    missions.choose('c6_m2', 1);
    expect(save.progress.flags).toContain('ending_escape');
    expect(save.progress.flags).not.toContain('ending_stay');
    expect(missions.active).toHaveLength(0);
    expect(save.progress.missionsDone).toContain('c6_m2');
  });
});

describe('Missions — rewards and replay (AC-43)', () => {
  it('applies rewards once, and a replayed mission pays 50 % xp/tokens', () => {
    const h = harness();
    h.missions.accept('c1_m1');
    h.events.emit('poi:reached', { poi: 'landing_pad', instance: 0 });
    h.events.emit('poi:scanned', { poi: 'dune_sea', instance: 0 });
    h.run(60.1);
    const def = MISSIONS.c1_m1;
    expect(h.save.player.xp).toBe(def.rewards.xp);
    expect(h.save.player.tokens).toBe(def.rewards.tokens);
    expect(h.save.progress.missionsDone).toEqual(['c1_m1']);

    // The replay is derived from missionsDone — no flag is stored anywhere.
    expect(h.missions.isReplay('c1_m1')).toBe(true);
    h.missions.accept('c1_m1');
    h.events.emit('poi:reached', { poi: 'landing_pad', instance: 0 });
    h.events.emit('poi:scanned', { poi: 'dune_sea', instance: 0 });
    h.run(60.1);
    // Accepted again here, so clean: the replay carries its own 60 s.
    expect(h.of('mission:completed').at(-1)).toEqual({ id: 'c1_m1', replay: true, seconds: 60 });
    expect(h.save.player.xp).toBe(def.rewards.xp + Math.floor(def.rewards.xp * TUNING.REPLAY_REWARD_FRACTION));
    expect(h.save.progress.missionsDone).toEqual(['c1_m1']); // not listed twice
  });

  it('a mission resumed from the save completes as a replay when already done', () => {
    // The round trip of AC-51: accepted, completed once before, active again,
    // and the scene reloads — replay must derive from missionsDone.
    const h = harness((save) => {
      save.progress.missionsDone.push('c1_m1');
      save.progress.missionsActive.push({ id: 'c1_m1', stage: 2, counters: { '0:0': 1, '1:0': 1 } });
    });
    expect(h.missions.active).toHaveLength(1);
    h.run(60.1);
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_m1', replay: true }]);
  });
});

describe('Missions — load (AC-44, AC-51)', () => {
  it('zeroes timers, keeps counters, and announces the reload reset', () => {
    const h = harness((save) => {
      save.progress.missionsActive.push({ id: 'c1_m1', stage: 2, counters: { '0:0': 1, '1:0': 1 } });
    });
    expect(h.missions.active[0]?.stage).toBe(2);
    expect(h.missions.active[0]?.timers).toEqual({});
    const timer = h.missions.currentObjectives('c1_m1').find((o) => o.objective.kind === 'survive');
    expect(timer?.value).toBe(0);
    expect(h.of('mission:stageReset')).toEqual([{ id: 'c1_m1', stage: 2, reason: 'reload' }]);
  });

  it('keeps kill and collect counters across the round trip', () => {
    const h = harness((save) => {
      save.progress.missionsDone.push('c1_m1');
      save.progress.missionsActive.push({ id: 'c1_m2', stage: 0, counters: { '0:0': 120, '0:1': 4 } });
    });
    const objectives = h.missions.currentObjectives('c1_m2');
    expect(objectives.find((o) => o.objective.kind === 'collect')?.value).toBe(120);
    expect(objectives.find((o) => o.objective.kind === 'kill')?.value).toBe(4);
  });

  it('a flight mission on the same planet stays out of the surface runtime (12-j)', () => {
    const save = newSave(0, MARINE, 42, 1_700_000_000_000);
    save.progress.missionsDone.push('c4_m1');
    save.progress.missionsActive.push({ id: 'c4_s2', stage: 0, counters: {} });
    const events = new EventBus<GameEvents>({ dev: false });
    const progression = new Progression(save, events);
    const economy = new Economy(save, events, progression);
    const missions = new Missions(save, economy, events, 'surface', 'ferrum');
    expect(missions.active).toHaveLength(0);
    expect(missions.available().some((def) => def.id === 'c4_s2')).toBe(false);
  });
});

describe('Missions — available() (AC-43, 12-j)', () => {
  it('respects requirements, scene, and offers completed missions as replays', () => {
    const h = harness();
    let ids = h.missions.available().map((def) => def.id);
    expect(ids).toContain('c1_m1');
    expect(ids).not.toContain('c1_m2'); // requires c1_m1
    expect(ids).not.toContain('c2_m1'); // another planet

    h.save.progress.missionsDone.push('c1_m1');
    ids = h.missions.available().map((def) => def.id);
    expect(ids).toContain('c1_m1'); // replayable
    expect(ids).toContain('c1_m2');
    expect(ids).toContain('c1_s1');

    h.missions.accept('c1_m2');
    ids = h.missions.available().map((def) => def.id);
    expect(ids).not.toContain('c1_m2'); // active is not offered again
  });

  it('pinning cycles through the active set (E18)', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1'));
    h.missions.accept('c1_m2');
    h.missions.accept('c1_s1');
    expect(h.missions.pinned).toBe('c1_m2');
    h.missions.cyclePinned();
    expect(h.missions.pinned).toBe('c1_s1');
    h.missions.cyclePinned();
    expect(h.missions.pinned).toBe('c1_m2');
    h.missions.pin('c1_s1');
    expect(h.missions.pinned).toBe('c1_s1');
    h.missions.abandon('c1_s1');
    expect(h.missions.pinned).toBe('c1_m2');
    expect(h.of('mission:abandoned')).toEqual([{ id: 'c1_s1' }]);
  });
});

// SPEC-001 §9 / PLAN R16: the dev skip stands in for a whole trip, so it has to
// resolve the missions that trip was carrying — the Hive's surface is gated
// behind `c5_m1`, which a skipped flight can never finish on its own.
describe('Missions — forceComplete (dev skip)', () => {
  it('finishes an active mission the way its last objective would', () => {
    const h = harness((save) => save.progress.missionsActive.push({ id: 'c5_m1', stage: 0, counters: {} }), 'flight', 'hive');
    const tokens = h.save.player.tokens;
    expect(h.missions.forceComplete('c5_m1')).toBe(true);
    expect(h.save.progress.missionsDone).toContain('c5_m1');
    expect(h.save.progress.missionsActive.map((entry) => entry.id)).not.toContain('c5_m1');
    expect(h.missions.active).toEqual([]);
    expect(h.of('mission:completed')).toEqual([{ id: 'c5_m1', replay: false }]);
    // The ordinary reward path: the mission's own tokens, and its 350 XP on
    // top, which carries levels worth 25 tokens each (SPEC-010 §4.1).
    expect(h.save.player.tokens).toBeGreaterThanOrEqual(tokens + MISSIONS.c5_m1.rewards.tokens);
    expect(h.save.player.level).toBeGreaterThan(1);
    expect(h.saveRequests).toContain('mission');
  });

  it('answers false for a mission that is not running here', () => {
    const h = harness(undefined, 'flight', 'hive');
    expect(h.missions.forceComplete('c5_m1')).toBe(false);
    expect(h.save.progress.missionsDone).toEqual([]);
    expect(h.of('mission:completed')).toEqual([]);
  });
});

describe('Missions — objectiveEnemies and bossStage', () => {
  it('reports undone kill targets for the spawn director (E14)', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1'));
    expect(h.missions.objectiveEnemies()).toEqual([]);
    h.missions.accept('c1_m2');
    expect(h.missions.objectiveEnemies()).toEqual(['scav_raider']);
    for (let i = 0; i < 6; i++) {
      h.events.emit('enemy:killed', { enemyId: 'scav_raider', elite: false, x: 0, z: 0, xp: 10 });
    }
    expect(h.missions.objectiveEnemies()).toEqual([]);
  });

  it('bossStage() names the arena boss only while its objective is open', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1', 'c1_m2'));
    expect(h.missions.bossStage()).toBeNull();
    h.missions.accept('c1_m3');
    expect(h.missions.bossStage()).toBe('dune_wurm');
    h.events.emit('boss:defeated', { boss: 'dune_wurm' });
    expect(h.missions.bossStage()).toBeNull();
  });

  // SPEC-039 §3: the surface asks `isReplay` of the mission behind the boss.
  it('bossStageMission() names the boss mission while bossStage() does, and null with no boss stage', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1', 'c1_m2'));
    expect(h.missions.bossStageMission()).toBeNull();
    h.missions.accept('c1_m3');
    expect(h.missions.bossStageMission()).toBe('c1_m3');
    expect(h.missions.isReplay('c1_m3')).toBe(false);
    h.events.emit('boss:defeated', { boss: 'dune_wurm' });
    expect(h.missions.bossStageMission()).toBeNull();
  });

  it('bossStageMission() on a replay names a mission isReplay() confirms', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1', 'c1_m2', 'c1_m3'));
    h.missions.accept('c1_m3');
    const id = h.missions.bossStageMission();
    expect(id).toBe('c1_m3');
    expect(id !== null && h.missions.isReplay(id)).toBe(true);
  });
});

// --------------------------------------------------------------- SPEC-024 §6

/** Eden, chapter 6 open, `c6_m2` standing on its choice stage. */
function atTheVerdict(): Harness {
  return harness(
    (save) => {
      save.progress.missionsDone.push('c6_m1');
      save.progress.missionsActive.push({ id: 'c6_m2', stage: 1, counters: {} });
    },
    'surface',
    'eden',
  );
}

describe('Missions — the E24 lock (SPEC-024 §4.6)', () => {
  it('campaign_done takes c6_m2 off the board and refuses an accept', () => {
    const h = atTheVerdict();
    h.missions.choose('c6_m2', 0);
    expect(h.save.progress.flags).toContain('campaign_done');
    expect(h.save.progress.missionsDone).toContain('c6_m2');

    // The pad terminal and the board both read `available()`; the mission that
    // ended the campaign is not on it, and asking for it anyway is refused.
    expect(h.missions.available().map((def) => def.id)).not.toContain('c6_m2');
    expect(h.missions.accept('c6_m2')).toEqual({ ok: false, reason: 'locked' });
    expect(h.missions.active).toHaveLength(0);
    // The board row reads done rather than replayable, so it has no Replay.
    expect(missionStatus(h.save, MISSIONS.c6_m2, 'station')).toBe('done');

    // Only that mission: chapter 6's other work is still replayable.
    expect(h.missions.available().map((def) => def.id)).toContain('c6_m1');
    expect(missionStatus(h.save, MISSIONS.c6_m1, 'station')).toBe('replayable');
  });

  it('one save can never hold both ending flags (E24)', () => {
    for (const [index, taken, other] of [
      [0, 'ending_stay', 'ending_escape'],
      [1, 'ending_escape', 'ending_stay'],
    ] as const) {
      const h = atTheVerdict();
      h.missions.choose('c6_m2', index);
      expect(h.save.progress.flags).toContain(taken);
      expect(h.save.progress.flags).not.toContain(other);

      // Every door back into the mission, walked in turn: the terminal's list,
      // an accept by id, the board's row — and then the choice itself, which
      // has no state left to answer.
      expect(h.missions.available().map((def) => def.id)).not.toContain('c6_m2');
      expect(h.missions.accept('c6_m2').ok).toBe(false);
      expect(missionStatus(h.save, MISSIONS.c6_m2, 'station')).toBe('done');
      expect(h.missions.choiceStage('c6_m2')).toBeNull();
      h.missions.choose('c6_m2', index === 0 ? 1 : 0);

      expect(h.save.progress.flags).toContain(taken);
      expect(h.save.progress.flags).not.toContain(other);
      expect(h.save.progress.flags.filter((flag) => flag.startsWith('ending_'))).toHaveLength(1);
    }
  });
});

describe('Missions — debugFinishStage (SPEC-024 §4.8)', () => {
  /**
   * Everything the *runtime* put on the bus, in order. The events that drove a
   * played stage — a POI reached, a scan — are what the control replaces, so
   * they are dropped; every consequence of them has to match exactly.
   */
  const DRIVERS = new Set(['poi:reached', 'poi:scanned', 'enemy:killed', 'resource:collected']);
  /**
   * SPEC-043 §4.5: `mission:completed` carries the mission clock, which is the
   * one thing a forced stage cannot reproduce — the played run spent 60 s in
   * the storm and the forced one none — so `seconds` is compared on its own.
   */
  const stream = (h: Harness): { name: string; payload: unknown }[] =>
    h.recorded
      .filter((entry) => !DRIVERS.has(entry.name))
      .map((entry) => {
        if (entry.name !== 'mission:completed') return entry;
        const { seconds: _seconds, ...payload } = entry.payload as GameEvents['mission:completed'];
        return { name: entry.name, payload };
      });

  it('finishes a mission exactly as playing it does: same events, same rewards', () => {
    const played = harness();
    played.missions.accept('c1_m1');
    played.events.emit('poi:reached', { poi: 'landing_pad', instance: 0 });
    played.events.emit('poi:scanned', { poi: 'dune_sea', instance: 0 });
    played.run(60.1);
    expect(played.save.progress.missionsDone).toEqual(['c1_m1']);

    const forced = harness();
    forced.missions.accept('c1_m1');
    forced.missions.debugFinishStage('c1_m1'); // reach
    forced.missions.debugFinishStage('c1_m1'); // scan
    forced.missions.debugFinishStage('c1_m1'); // survive 60 s

    expect(stream(forced)).toEqual(stream(played));
    expect(played.of('mission:completed')[0]?.seconds).toBe(60);
    expect(forced.of('mission:completed')[0]?.seconds).toBe(1);
    expect(forced.saveRequests).toEqual(played.saveRequests);
    expect(forced.save.player.xp).toBe(played.save.player.xp);
    expect(forced.save.player.tokens).toBe(played.save.player.tokens);
    expect(forced.save.resources).toEqual(played.save.resources);
    expect(forced.save.progress.missionsDone).toEqual(['c1_m1']);
    expect(forced.save.progress.missionsActive).toEqual([]);
  });

  it('advances the four-minute defence it exists for, and leaves the choice alone', () => {
    const played = harness((save) => save.progress.missionsDone.push('c6_m1'), 'surface', 'eden');
    played.missions.accept('c6_m2');
    played.run(240.1);

    const forced = harness((save) => save.progress.missionsDone.push('c6_m1'), 'surface', 'eden');
    forced.missions.accept('c6_m2');
    forced.missions.debugFinishStage('c6_m2');

    expect(stream(forced)).toEqual(stream(played));
    expect(forced.missions.active[0]?.stage).toBe(1);
    expect(forced.missions.choiceStage('c6_m2')).not.toBeNull();

    // §4.8: the verdict is the player's. A second press finds a choice stage
    // and leaves it open rather than filing a report nobody chose (E24).
    forced.missions.debugFinishStage('c6_m2');
    expect(forced.missions.choiceStage('c6_m2')).not.toBeNull();
    expect(forced.save.progress.flags).not.toContain('campaign_done');
    expect(forced.save.progress.flags.filter((flag) => flag.startsWith('ending_'))).toHaveLength(0);
  });

  it('finishes a count stage at its target — c1_s2’s eight skitters (SPEC-038 §6.2)', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1'));
    h.missions.accept('c1_s2');
    h.missions.debugFinishStage('c1_s2');
    expect(h.missions.active[0]?.stage).toBe(1);
    expect(h.of('mission:progress').at(-1)).toEqual({ id: 'c1_s2', stage: 0, objective: 0, value: 8, target: 8 });
    expect(h.missions.surviveWave()).toEqual({ mission: 'c1_s2', stage: 1, wave: 'cinder4_storm' });
  });

  it('ignores a mission that is not running', () => {
    const h = harness();
    h.missions.debugFinishStage('c1_m1');
    expect(h.recorded).toHaveLength(0);
    expect(h.save.progress.missionsDone).toEqual([]);
  });
});

// ---------------------------------------------------------------- SPEC-034

/**
 * SPEC-034 §4.2, §4.9 — `player:recalled` and the escort restart.
 *
 * A recall costs exactly what a death costs in progress and nothing else, so it
 * cannot be used to skip a timed stage or a boss for free (34-c). And an escort
 * stage now restarts on a death the way a timed one always has (E4): it was the
 * one stage a death left half-finished with the follower gone and no way to
 * finish it.
 */
describe('Missions — recall and the escort restart (SPEC-034 §4.2, §4.9)', () => {
  it('a recall restarts a timed stage with reason `recall`, and takes nothing else', () => {
    const h = harness();
    h.missions.accept('c1_m1');
    h.events.emit('poi:reached', { poi: 'landing_pad', instance: 0 });
    h.events.emit('poi:scanned', { poi: 'dune_sea', instance: 0 });
    const timer = () => h.missions.currentObjectives('c1_m1').find((o) => o.objective.kind === 'survive')?.value ?? 0;
    h.run(30);
    expect(timer()).toBeGreaterThan(29);

    h.events.emit('player:recalled', {});
    expect(h.of('mission:stageReset').at(-1)).toEqual({ id: 'c1_m1', stage: 2, reason: 'recall' });
    expect(timer()).toBe(0);
    // The mission is still running, at the same stage, and nothing completed.
    expect(h.missions.active[0]?.stage).toBe(2);
    expect(h.of('mission:completed')).toEqual([]);
    // …and it can still be finished from zero. SPEC-043 43-a: the recall
    // forfeits nothing, and the clock kept running through it: 30 + 60.
    h.run(60.1);
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_m1', replay: false, seconds: 90 }]);
  });

  it('a recall restarts a defend stage with reason `recall`', () => {
    const save = newSave(0, MARINE, 42, 1_700_000_000_000);
    save.progress.flags.push('chapter5_done');
    save.progress.missionsDone.push('c6_m1');
    const events = new EventBus<GameEvents>({ dev: false });
    const recorded: { name: string; payload: unknown }[] = [];
    events.onAny((name, payload) => recorded.push({ name: name as string, payload }));
    const progression = new Progression(save, events);
    const economy = new Economy(save, events, progression);
    const missions = new Missions(save, economy, events, 'surface', 'eden');
    expect(missions.accept('c6_m2').ok).toBe(true);
    expect(missions.defendStage()).not.toBeNull();
    const ctx: MissionContext = {
      player: { x: 0, z: 0, alive: true },
      poiAt: () => [],
      heldResource: () => 0,
      nearPoi: () => null,
      level: 'surface',
    };
    for (let i = 0; i < 60 * 20; i++) missions.update(STEP, ctx);
    const timer = () => missions.currentObjectives('c6_m2').find((o) => o.objective.kind === 'defend')?.value ?? 0;
    expect(timer()).toBeGreaterThan(19);
    events.emit('player:recalled', {});
    expect(timer()).toBe(0);
    const resets = recorded.filter((r) => r.name === 'mission:stageReset').map((r) => r.payload);
    expect(resets.at(-1)).toEqual({ id: 'c6_m2', stage: 0, reason: 'recall' });
  });

  it('a death and a recall both restart an escort stage (E4)', () => {
    const save = newSave(0, MARINE, 42, 1_700_000_000_000);
    save.progress.missionsDone.push('c3_m1');
    const events = new EventBus<GameEvents>({ dev: false });
    const recorded: { name: string; payload: unknown }[] = [];
    events.onAny((name, payload) => recorded.push((({ name: name as string, payload }))));
    const progression = new Progression(save, events);
    const economy = new Economy(save, events, progression);
    const missions = new Missions(save, economy, events, 'surface', 'thessaly');
    missions.accept('c3_m2');
    for (let i = 0; i < 20; i++) {
      events.emit('enemy:killed', { enemyId: 'hive_drone', elite: false, x: 0, z: 0, xp: 5 });
    }
    expect(missions.escortStage()).not.toBeNull();
    const stage = missions.active[0]?.stage ?? -1;

    events.emit('player:died', { cause: { kind: 'fall' }, scene: 'surface' });
    let resets = recorded.filter((r) => r.name === 'mission:stageReset').map((r) => r.payload);
    expect(resets.at(-1)).toEqual({ id: 'c3_m2', stage, reason: 'death' });

    events.emit('player:recalled', {});
    resets = recorded.filter((r) => r.name === 'mission:stageReset').map((r) => r.payload);
    expect(resets.at(-1)).toEqual({ id: 'c3_m2', stage, reason: 'recall' });
    // The stage is still the escort's: a restart is not a rollback.
    expect(missions.active[0]?.stage).toBe(stage);
    expect(missions.escortStage()).not.toBeNull();
  });

  it('a recall in flight resets nothing — E5 already covers it', () => {
    const h = harness((save) => save.progress.missionsActive.push({ id: 'c5_m1', stage: 0, counters: {} }), 'flight', 'hive');
    h.events.emit('player:recalled', {});
    expect(h.of('mission:stageReset').filter((r) => r.reason === 'recall')).toEqual([]);
  });
});

/**
 * SPEC-034 §4.12: what the active collect objectives still want, per resource —
 * the number a full hold ships home instead of bouncing (E56).
 */
describe('Missions.collectDemand (SPEC-034 §4.12)', () => {
  it('sums the current stages, drops what is already counted, and registers itself', () => {
    const demands: (((r: 'oil' | 'wheat' | 'water' | 'lithium') => number) | null)[] = [];
    const save = newSave(0, MARINE, 42, 1_700_000_000_000);
    save.progress.missionsDone.push('c3_m1');
    const events = new EventBus<GameEvents>({ dev: false });
    const progression = new Progression(save, events);
    const economy = new Economy(save, events, progression);
    // The registration seam of §4.12, recorded *and* passed through, so the
    // economy's own `collectDemand` answers from the real registration.
    const register = economy.setCollectDemand.bind(economy);
    economy.setCollectDemand = (demand): void => {
      demands.push(demand);
      register(demand);
    };
    const missions = new Missions(save, economy, events, 'surface', 'thessaly');
    // Construction registers exactly one demand function.
    expect(demands).toHaveLength(1);
    expect(demands[0]).toBeTypeOf('function');

    expect(missions.collectDemand('wheat')).toBe(0);
    missions.accept('c3_s2'); // collect 300 wheat
    expect(missions.collectDemand('wheat')).toBe(300);
    expect(missions.collectDemand('oil')).toBe(0);

    // Progress reduces what is still wanted, one for one — and the economy
    // answers from the registration, not from a copy of it.
    events.emit('resource:collected', { resource: 'wheat', amount: 120, total: 120, source: 'pickup' });
    expect(missions.collectDemand('wheat')).toBe(180);
    expect(economy.collectDemand('wheat')).toBe(180);

    // A finished objective asks for nothing.
    events.emit('resource:collected', { resource: 'wheat', amount: 180, total: 300, source: 'pickup' });
    expect(missions.collectDemand('wheat')).toBe(0);

    // A deliver objective is not a collect one: nothing is shipped for it.
    expect(missions.collectDemand('oil')).toBe(0);

    // `dispose()` releases it, and the economy stops answering.
    missions.dispose();
    expect(demands.at(-1)).toBeNull();
    expect(economy.collectDemandSource).toBeNull();
    expect(economy.collectDemand('wheat')).toBe(0);
  });
});

/**
 * SPEC-065 §4.2 (E117): what the pad terminal never ships below — the open
 * deliver objectives of the current stages, read as `collectDemand` reads
 * collect ones. A delivery is all or nothing (E16), so an open one needs its
 * whole amount.
 */
describe('Missions.deliverDemand (SPEC-065 §4.2, E117)', () => {
  it('counts an open deliver objective of the current stage, and not a later stage’s', () => {
    // c1_m3: stage 0 kills the dune wurm, stage 1 runs 100 oil to the beacon.
    const h = harness((save) => {
      save.progress.missionsDone.push('c1_m1', 'c1_m2');
      save.progress.missionsActive.push({ id: 'c1_m3', stage: 0, counters: {} });
    });
    expect(h.missions.deliverDemand('oil')).toBe(0);
    h.events.emit('boss:defeated', { boss: 'dune_wurm' });
    expect(h.missions.active[0]?.stage).toBe(1);
    expect(h.missions.deliverDemand('oil')).toBe(100);
    // Only the resource it names.
    for (const resource of ['wheat', 'water', 'lithium'] as const) expect(h.missions.deliverDemand(resource), resource).toBe(0);

    // A short hold changes nothing: the need is the objective's, not the shortfall.
    h.save.resources.oil = 40;
    expect(h.missions.deliverDemand('oil')).toBe(100);

    // Delivered, the mission is over and nothing is needed.
    h.save.resources.oil = 120;
    h.ctx.player.x = 50;
    h.ctx.player.z = 20;
    h.run(0.1);
    expect(h.of('poi:delivered')).toHaveLength(1);
    expect(h.missions.deliverDemand('oil')).toBe(0);
  });

  it('leaves out a finished deliver objective and a collect objective', () => {
    // Rebuilt with the stage-1 delivery already counted done.
    const finished = harness((save) => {
      save.progress.missionsDone.push('c1_m1', 'c1_m2');
      save.progress.missionsActive.push({ id: 'c1_m3', stage: 1, counters: { '1:0': 1 } });
    });
    expect(finished.missions.active[0]?.stage).toBe(1);
    expect(finished.missions.currentObjectives('c1_m3')[0]?.done).toBe(true);
    expect(finished.missions.deliverDemand('oil')).toBe(0);

    // c1_m2 collects 150 oil: a collect objective is not a deliver one.
    const collect = harness((save) => save.progress.missionsDone.push('c1_m1'));
    expect(collect.missions.accept('c1_m2').ok).toBe(true);
    expect(collect.missions.collectDemand('oil')).toBe(150);
    expect(collect.missions.deliverDemand('oil')).toBe(0);
  });

  it('reads only this planet’s missions, as the runtime does', () => {
    // c2_s1 delivers water on Vetra; a Cinder-4 runtime does not carry it.
    const h = harness((save) => {
      save.progress.missionsDone.push('c1_m1', 'c1_m2', 'c1_m3', 'c2_m1');
      save.progress.missionsActive.push({ id: 'c2_s1', stage: 1, counters: {} });
    });
    expect(h.missions.deliverDemand('water')).toBe(0);
    const vetra = harness(
      (save) => {
        save.progress.missionsDone.push('c1_m1', 'c1_m2', 'c1_m3', 'c2_m1');
        save.progress.missionsActive.push({ id: 'c2_s1', stage: 1, counters: {} });
      },
      'surface',
      'vetra',
    );
    expect(vetra.missions.deliverDemand('water')).toBe(40);
  });
});

/**
 * SPEC-034 §4.15: the pin lives in `progress.missionsActive` order, which the
 * runtime already reads on the next landing — so it survives a reload with no
 * save field. The board's badge follows the front entry.
 */
describe('Missions.pin and cyclePinned reorder missionsActive (SPEC-034 §4.15)', () => {
  it('moves the pinned mission to the front, and cycling moves the next one', () => {
    const h = harness((save) => {
      save.progress.missionsDone.push('c1_m1');
    });
    expect(h.missions.accept('c1_m2').ok).toBe(true);
    expect(h.missions.accept('c1_s1').ok).toBe(true);
    const order = (): string[] => h.save.progress.missionsActive.map((entry) => entry.id);
    expect(order()).toEqual(['c1_m2', 'c1_s1']);
    expect(h.missions.pinned).toBe('c1_m2');

    h.missions.pin('c1_s1');
    expect(h.missions.pinned).toBe('c1_s1');
    expect(order()).toEqual(['c1_s1', 'c1_m2']);
    expect(h.saveRequests).toContain('stage');

    // Cycling pins the next active mission and fronts it the same way.
    h.missions.cyclePinned();
    expect(order()[0]).toBe(h.missions.pinned);

    // A mission that is not running cannot be pinned.
    h.missions.pin('c6_m2');
    expect(order()[0]).toBe(h.missions.pinned);

    // The pin survives the reload: a new runtime reads the front entry.
    const pinned = h.missions.pinned;
    const reborn = new Missions(h.save, h.economy, h.events, 'surface', 'cinder4');
    expect(reborn.pinned).toBe(pinned);
    reborn.dispose();
  });
});

// ------------------------------------------------------------- SPEC-038 §4.5

describe('Missions — survive stages run their storm wave (SPEC-038 §4.5)', () => {
  it('surviveWave() names the stage’s wave, and null once the stage is done', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1'));
    expect(h.missions.accept('c1_s2').ok).toBe(true);
    // Stage 0 is the skitter cull: no survive objective yet.
    expect(h.missions.surviveWave()).toBeNull();
    for (let i = 0; i < 8; i++) h.events.emit('enemy:killed', { enemyId: 'dust_skitter', elite: false, x: 0, z: 0, xp: 4 });
    expect(h.missions.active[0]?.stage).toBe(1);
    expect(h.missions.surviveWave()).toEqual({ mission: 'c1_s2', stage: 1, wave: 'cinder4_storm' });
    expect(h.missions.requiredWeather()).toEqual({ weather: 'heatwave', seconds: 90 });

    // A death restarts the timer and keeps the wave the stage's.
    h.run(30);
    h.events.emit('player:died', { cause: { kind: 'fall' }, scene: 'surface' });
    expect(h.missions.surviveWave()).toEqual({ mission: 'c1_s2', stage: 1, wave: 'cinder4_storm' });

    h.run(90.1);
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_s2', replay: false, seconds: 120 }]);
    expect(h.missions.surviveWave()).toBeNull();
  });

  it('the tutorial’s sandstorm names no wave (SPEC-035’s ramp is the first landing)', () => {
    const h = harness();
    h.missions.accept('c1_m1');
    h.events.emit('poi:reached', { poi: 'landing_pad', instance: 0 });
    h.events.emit('poi:scanned', { poi: 'dune_sea', instance: 0 });
    expect(h.missions.requiredWeather()).toEqual({ weather: 'sandstorm', seconds: 60 });
    expect(h.missions.surviveWave()).toBeNull();
  });
});

// ------------------------------------------------------------- SPEC-043 §6.1

/** `c1_m3` from its boss stage on: the wurm dies, and 100 oil reaches the beacon. */
function finishWormSign(h: Harness): void {
  h.events.emit('boss:defeated', { boss: 'dune_wurm' });
  h.save.resources.oil = Math.max(h.save.resources.oil, 100);
  h.ctx.player.x = 50;
  h.ctx.player.z = 20;
  h.run(0.1);
}

/** `c1_s2`: the eight skitters, then the 90 s heatwave survived. */
function finishWaterless(h: Harness, shelterAt: number | null = null): void {
  for (let i = 0; i < 8; i++) h.events.emit('enemy:killed', { enemyId: 'dust_skitter', elite: false, x: 0, z: 0, xp: 4 });
  const steps = Math.round(90.1 / STEP);
  for (let i = 0; i < steps; i++) {
    h.ctx.sheltered = shelterAt !== null && i === shelterAt;
    h.missions.update(STEP, h.ctx);
  }
  h.ctx.sheltered = false;
}

/** `c3_s1` on Thessaly: three towers scanned, eight hounds down — `elites` of them elite. */
function finishOldTerraform(h: Harness, elites: number): void {
  for (let i = 0; i < 3; i++) h.events.emit('poi:scanned', { poi: 'terraform_tower', instance: i });
  for (let i = 0; i < 8; i++) h.events.emit('enemy:killed', { enemyId: 'spore_hound', elite: i < elites, x: 0, z: 0, xp: 6 });
}

/** The names of the recorded events, in order, from the first `mission:bonus` on. */
function namesFrom(h: Harness, first: string): string[] {
  const names = h.recorded.map((entry) => entry.name);
  return names.slice(names.indexOf(first));
}

describe('Missions — the mission clock and its counters (SPEC-043 §4.2)', () => {
  it('clock sums the seconds update stepped each active mission, from its accept', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1'));
    h.missions.accept('c1_m2');
    h.run(2.5);
    expect(h.missions.active[0]?.clock).toBeCloseTo(2.5, 6);
    h.missions.accept('c1_s1');
    h.run(1);
    expect(h.missions.active.map((state) => [state.id, Math.round(state.clock * 1000) / 1000])).toEqual([
      ['c1_m2', 3.5],
      ['c1_s1', 1],
    ]);
  });

  it('a fresh accept is clean with nothing counted; deaths, shelter and elites accrue while active', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1'));
    h.missions.accept('c1_m2');
    const state = h.missions.active[0];
    expect(state).toMatchObject({ clock: 0, deaths: 0, sheltered: false, elites: 0, clean: true });
    h.events.emit('player:died', { cause: { kind: 'fall' }, scene: 'surface' });
    h.events.emit('enemy:killed', { enemyId: 'dust_skitter', elite: true, x: 0, z: 0, xp: 4 });
    h.events.emit('enemy:killed', { enemyId: 'dust_skitter', elite: false, x: 0, z: 0, xp: 4 });
    h.ctx.sheltered = true;
    h.run(STEP);
    expect(state).toMatchObject({ deaths: 1, sheltered: true, elites: 1, clean: true });
  });

  it('a mission rebuilt at stage 1 is not clean; one at stage 0 with no counters is (E70, 43-b)', () => {
    const stage1 = harness((save) => {
      save.progress.missionsDone.push('c1_m1', 'c1_m2');
      save.progress.missionsActive.push({ id: 'c1_m3', stage: 1, counters: { '0:0': 1 } });
    });
    expect(stage1.missions.active[0]?.clean).toBe(false);
    const counted = harness((save) => {
      save.progress.missionsDone.push('c1_m1');
      save.progress.missionsActive.push({ id: 'c1_m2', stage: 0, counters: { '0:0': 40 } });
    });
    expect(counted.missions.active[0]?.clean).toBe(false);
    const untouched = harness((save) => {
      save.progress.missionsDone.push('c1_m1', 'c1_m2');
      save.progress.missionsActive.push({ id: 'c1_m3', stage: 0, counters: {} });
    });
    expect(untouched.missions.active[0]).toMatchObject({ clean: true, clock: 0 });
  });
});

describe('Missions — judging a bonus (SPEC-043 §4.2)', () => {
  it('mission:bonus precedes the rewards and mission:completed, and an earned one pays through applyBonus', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1', 'c1_m2'));
    h.missions.accept('c1_m3');
    finishWormSign(h);
    expect(h.of('mission:bonus')).toEqual([{ id: 'c1_m3', bonus: 'no_death', earned: true }]);
    const after = namesFrom(h, 'mission:bonus');
    expect(after.indexOf('mission:bonus')).toBeLessThan(after.indexOf('tokens:changed'));
    expect(after.indexOf('mission:bonus')).toBeLessThan(after.indexOf('mission:completed'));
    // The demolition charge lands before mission:completed, from the bonus.
    expect(after.indexOf('inventory:changed')).toBeLessThan(after.indexOf('mission:completed'));
    expect(h.economy.count('demo_charge')).toBe(1);
    expect(after.at(-1)).toBe('mission:completed');
  });

  it('a death forfeits no_death, and the clock runs on through it (E70)', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1', 'c1_m2'));
    h.missions.accept('c1_m3');
    h.run(1);
    h.events.emit('player:died', { cause: { kind: 'fall' }, scene: 'surface' });
    finishWormSign(h);
    expect(h.of('mission:bonus')).toEqual([{ id: 'c1_m3', bonus: 'no_death', earned: false }]);
    expect(h.economy.count('demo_charge')).toBe(0);
    // A death is not a reload: the run is still clean, and its time still counts.
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_m3', replay: false, seconds: 1 }]);
  });

  it('a recall to the pad forfeits nothing (43-a)', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1', 'c1_m2'));
    h.missions.accept('c1_m3');
    h.events.emit('player:recalled', {});
    finishWormSign(h);
    expect(h.of('mission:bonus')).toEqual([{ id: 'c1_m3', bonus: 'no_death', earned: true }]);
    expect(h.economy.count('demo_charge')).toBe(1);
  });

  it('ctx.sheltered on any step forfeits no_shelter', () => {
    const sheltered = harness((save) => save.progress.missionsDone.push('c1_m1'));
    sheltered.missions.accept('c1_s2');
    finishWaterless(sheltered, 1200);
    expect(sheltered.of('mission:bonus')).toEqual([{ id: 'c1_s2', bonus: 'no_shelter', earned: false }]);
    expect(sheltered.economy.count('frag_grenade')).toBe(0);
    // §4.1: its own reward still pays.
    expect(sheltered.economy.count('landmine')).toBe(2);

    const open = harness((save) => save.progress.missionsDone.push('c1_m1'));
    open.missions.accept('c1_s2');
    finishWaterless(open);
    expect(open.of('mission:bonus')).toEqual([{ id: 'c1_s2', bonus: 'no_shelter', earned: true }]);
    expect(open.economy.count('frag_grenade')).toBe(2);
  });

  it('elite kills of any enemy count toward elites', () => {
    const none = harness((save) => save.progress.missionsDone.push('c3_m1'), 'surface', 'thessaly');
    none.missions.accept('c3_s1');
    finishOldTerraform(none, 0);
    expect(none.of('mission:bonus')).toEqual([{ id: 'c3_s1', bonus: 'elites', earned: false }]);
    // §4.1: c3_s1's own 30 lithium, and no bonus lithium.
    expect(none.save.resources.lithium).toBe(30);

    const one = harness((save) => save.progress.missionsDone.push('c3_m1'), 'surface', 'thessaly');
    one.missions.accept('c3_s1');
    // An elite that is no objective of the mission counts all the same.
    one.events.emit('enemy:killed', { enemyId: 'hive_drone', elite: true, x: 0, z: 0, xp: 5 });
    expect(one.missions.active[0]?.elites).toBe(1);
    finishOldTerraform(one, 0);
    expect(one.of('mission:bonus')).toEqual([{ id: 'c3_s1', bonus: 'elites', earned: true }]);
    expect(one.save.resources.lithium).toBe(30 + 20);
  });

  // Review 2026-10 (G-14): the surface forces this many pack leaders elite
  // at a stage start, so an `elites` bonus no longer pays on the roll.
  it('elitesOwed is what a clean, open elites bonus still wants, and 0 otherwise', () => {
    const h = harness((save) => save.progress.missionsDone.push('c3_m1'), 'surface', 'thessaly');
    expect(h.missions.elitesOwed()).toBe(0);
    h.missions.accept('c3_s1'); // elites ×1
    expect(h.missions.elitesOwed()).toBe(1);
    h.events.emit('enemy:killed', { enemyId: 'hive_drone', elite: true, x: 0, z: 0, xp: 5 });
    expect(h.missions.elitesOwed()).toBe(0);

    const ferrum = harness((save) => save.progress.missionsDone.push('c4_m1'), 'surface', 'ferrum');
    ferrum.missions.accept('c4_m2'); // elites ×2
    expect(ferrum.missions.elitesOwed()).toBe(2);
    // A mission without an elites bonus owes none.
    const cinder = harness((save) => save.progress.missionsDone.push('c1_m1'));
    cinder.missions.accept('c1_m2');
    expect(cinder.missions.elitesOwed()).toBe(0);
    // Rebuilt with progress, a mission is not clean and can earn no bonus.
    const rebuilt = harness(
      (save) => {
        save.progress.missionsDone.push('c3_m1');
        save.progress.missionsActive.push({ id: 'c3_s1', stage: 0, counters: { '0:1': 3 } });
      },
      'surface',
      'thessaly',
    );
    expect(rebuilt.missions.elitesOwed()).toBe(0);
  });

  it('par is earned inside its seconds and missed past them', () => {
    const outcome = (seconds: number): boolean | undefined => {
      const h = harness((save) => save.progress.missionsDone.push('c1_m1'));
      h.missions.accept('c1_m2');
      h.run(seconds);
      for (let i = 0; i < 6; i++) h.events.emit('enemy:killed', { enemyId: 'scav_raider', elite: false, x: 0, z: 0, xp: 10 });
      h.economy.addResource('oil', 150, 'pickup');
      expect(h.of('mission:completed').at(-1)?.id).toBe('c1_m2');
      return h.of('mission:bonus').at(-1)?.earned;
    };
    expect(outcome(10)).toBe(true);
    expect(outcome(239)).toBe(true);
    expect(outcome(241)).toBe(false);
  });

  it('a mission rebuilt with progress misses its bonus and carries no time (E70)', () => {
    const h = harness((save) => {
      save.progress.missionsDone.push('c1_m1', 'c1_m2');
      save.progress.missionsActive.push({ id: 'c1_m3', stage: 1, counters: { '0:0': 1 } });
    });
    h.save.resources.oil = 100;
    h.ctx.player.x = 50;
    h.ctx.player.z = 20;
    h.run(0.1);
    expect(h.of('mission:bonus')).toEqual([{ id: 'c1_m3', bonus: 'no_death', earned: false }]);
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_m3', replay: false }]);
    expect(h.economy.count('demo_charge')).toBe(0);
  });

  it('a mission with no bonus emits no mission:bonus', () => {
    const h = harness();
    h.missions.accept('c1_m1');
    h.events.emit('poi:reached', { poi: 'landing_pad', instance: 0 });
    h.events.emit('poi:scanned', { poi: 'dune_sea', instance: 0 });
    h.run(60.1);
    expect(h.of('mission:completed')).toHaveLength(1);
    expect(h.of('mission:bonus')).toEqual([]);
  });

  it('a bonus pays on a replay too', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1', 'c1_m2', 'c1_m3'));
    h.missions.accept('c1_m3');
    finishWormSign(h);
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_m3', replay: true, seconds: 1 }]);
    expect(h.of('mission:bonus')).toEqual([{ id: 'c1_m3', bonus: 'no_death', earned: true }]);
    expect(h.economy.count('demo_charge')).toBe(1);
  });
});

describe('contractFor (SPEC-043 §4.3)', () => {
  const finished = (patch?: (save: Save) => void): Save => {
    const save = newSave(0, MARINE, 42, 1_700_000_000_000);
    patch?.(save);
    return save;
  };

  it('is null for a first run, an unfinished chapter, a flight mission and Eden', () => {
    // A first run: the chapter is finished, but c1_m2 was never done.
    expect(contractFor(finished((s) => s.progress.flags.push('chapter1_done')), MISSIONS.c1_m2, 1)).toBeNull();
    // A replay of a chapter not yet finished.
    expect(contractFor(finished((s) => s.progress.missionsDone.push('c1_m1', 'c1_m2')), MISSIONS.c1_m2, 1)).toBeNull();
    // Flight replays: c4_s2 and c5_m1, their chapters finished (43-k).
    const flight = finished((s) => {
      s.progress.missionsDone.push('c4_s2', 'c5_m1');
      s.progress.flags.push('chapter4_done', 'chapter5_done');
    });
    expect(contractFor(flight, MISSIONS.c4_s2, 1)).toBeNull();
    expect(contractFor(flight, MISSIONS.c5_m1, 1)).toBeNull();
    // Eden: chapter 6 has no `chapter6_done`, and no enemies live there.
    const eden = finished((s) => {
      s.progress.missionsDone.push('c6_m1');
      s.progress.flags.push('chapter5_done', 'campaign_done');
    });
    expect(contractFor(eden, MISSIONS.c6_m1, 1)).toBeNull();
  });

  it('is deterministic per landing — hash32(seed, contract, id, landing) over the four on Cinder-4', () => {
    const save = finished((s) => {
      s.progress.missionsDone.push('c1_m1', 'c1_m2');
      s.progress.flags.push('chapter1_done');
    });
    const seen = new Set<ContractId>();
    for (let landing = 1; landing <= 40; landing++) {
      const contract = contractFor(save, MISSIONS.c1_m2, landing);
      expect(contract).toBe(CONTRACT_IDS[hash32(save.meta.seed, 'contract', 'c1_m2', landing) % CONTRACT_IDS.length]);
      expect(contractFor(save, MISSIONS.c1_m2, landing)).toBe(contract);
      if (contract !== null) seen.add(contract);
    }
    // A new landing is a new contract: forty landings meet all four.
    expect([...seen].sort()).toEqual([...CONTRACT_IDS].sort());
  });

  it('offers only the weather-free modifiers on the Hive', () => {
    const save = finished((s) => {
      s.progress.missionsDone.push('c5_m1', 'c5_m2');
      s.progress.flags.push('chapter5_done');
    });
    const seen = new Set<ContractId | null>();
    for (let landing = 1; landing <= 40; landing++) {
      const contract = contractFor(save, MISSIONS.c5_m2, landing);
      expect(contract).toBe((['elite_surge', 'swarm'] as const)[hash32(save.meta.seed, 'contract', 'c5_m2', landing) % 2]);
      seen.add(contract);
    }
    expect([...seen].sort()).toEqual(['elite_surge', 'swarm']);
  });
});

describe('Missions — contracts on the surface (SPEC-043 §4.3)', () => {
  /** Cinder-4 with chapter 1 finished, landed on for the `landing`-th time. */
  const chapterOne = (landing: number, active: MissionId[] = []) =>
    harness((save) => {
      save.progress.missionsDone.push('c1_m1', 'c1_m2', 'c1_m3', 'c1_s1');
      save.progress.flags.push('chapter1_done');
      save.progress.visits.cinder4 = landing;
      for (const id of active) save.progress.missionsActive.push({ id, stage: 0, counters: {} });
    });

  it('activeContracts names each active replay’s contract, read with this landing’s number', () => {
    const h = chapterOne(3, ['c1_m2', 'c1_s1']);
    expect(h.missions.activeContracts()).toEqual([
      contractFor(h.save, MISSIONS.c1_m2, 3),
      contractFor(h.save, MISSIONS.c1_s1, 3),
    ]);
    // A first run carries none: c1_s2 was never done.
    h.missions.accept('c1_s2');
    expect(h.missions.activeContracts()).toHaveLength(2);
    // Gone when the mission is.
    h.missions.abandon('c1_m2');
    expect(h.missions.activeContracts()).toEqual([contractFor(h.save, MISSIONS.c1_s1, 3)]);
  });

  it('activeContracts is always [] in flight', () => {
    const h = harness(
      (save) => {
        save.progress.missionsDone.push('c4_m1', 'c4_s2');
        save.progress.flags.push('chapter4_done');
        save.progress.missionsActive.push({ id: 'c4_s2', stage: 0, counters: {} });
      },
      'flight',
      'ferrum',
    );
    expect(h.missions.active).toHaveLength(1);
    expect(h.missions.activeContracts()).toEqual([]);
  });

  it('a contract completion pays 75 % and 20 lithium, and mission:completed carries contract and seconds', () => {
    const h = chapterOne(2);
    expect(h.missions.accept('c1_m2').ok).toBe(true);
    const contract = contractFor(h.save, MISSIONS.c1_m2, 2);
    expect(contract).not.toBeNull();
    const { xp, tokens } = h.save.player;
    const lithium = h.save.resources.lithium;
    h.run(5);
    for (let i = 0; i < 6; i++) h.events.emit('enemy:killed', { enemyId: 'scav_raider', elite: false, x: 0, z: 0, xp: 10 });
    h.economy.addResource('oil', 150, 'pickup');
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_m2', replay: true, contract, seconds: 5 }]);
    expect(h.save.player.xp - xp).toBe(Math.floor(MISSIONS.c1_m2.rewards.xp * 0.75));
    expect(h.save.player.tokens - tokens).toBe(Math.floor(MISSIONS.c1_m2.rewards.tokens * 0.75));
    expect(h.save.resources.lithium - lithium).toBe(CONTRACT_LITHIUM);
    // §4.3: a contract earns its bonus like any run — c1_m2's par.
    expect(h.of('mission:bonus')).toEqual([{ id: 'c1_m2', bonus: 'par', earned: true }]);
  });

  it('a plain replay before the chapter is finished carries no contract (43-k)', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1'));
    h.missions.accept('c1_m1');
    h.events.emit('poi:reached', { poi: 'landing_pad', instance: 0 });
    h.events.emit('poi:scanned', { poi: 'dune_sea', instance: 0 });
    h.run(60.1);
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_m1', replay: true, seconds: 60 }]);
  });

  it('a chapter flag set while a replay runs makes it a contract at completion (43-d)', () => {
    const h = harness((save) => {
      save.progress.missionsDone.push('c1_m1', 'c1_m2');
      save.progress.visits.cinder4 = 4;
    });
    h.missions.accept('c1_m2');
    expect(h.missions.activeContracts()).toEqual([]);
    h.save.progress.flags.push('chapter1_done');
    for (let i = 0; i < 6; i++) h.events.emit('enemy:killed', { enemyId: 'scav_raider', elite: false, x: 0, z: 0, xp: 10 });
    h.economy.addResource('oil', 150, 'pickup');
    expect(h.of('mission:completed').at(-1)?.contract).toBe(contractFor(h.save, MISSIONS.c1_m2, 4));
  });

  it('a flight mission carries no seconds, even clean', () => {
    const h = harness(
      (save) => {
        save.progress.missionsDone.push('c4_m1');
        save.progress.missionsActive.push({ id: 'c4_s2', stage: 0, counters: {} });
      },
      'flight',
      'ferrum',
    );
    h.run(3);
    for (let i = 0; i < 8; i++) h.events.emit('enemy:killed', { enemyId: 'scav_fighter', elite: false, x: 0, z: 0, xp: 8 });
    expect(h.of('mission:completed')).toEqual([{ id: 'c4_s2', replay: false }]);
    // §4.1: c4_s2's 60 oil arrives as a reward.
    expect(h.of('resource:collected').at(-1)).toMatchObject({ resource: 'oil', amount: 60, source: 'reward' });
  });
});

describe('Missions — only pickups advance a collect objective (SPEC-043 43-h)', () => {
  it('a reward, a bonus, a contract’s lithium, a voucher and the subsidy leave the counter; a pickup and a shipped-home pickup move it', () => {
    const h = harness((save) => save.progress.missionsDone.push('c4_m1'), 'surface', 'ferrum');
    h.missions.accept('c4_m2'); // collect 200 lithium
    const counter = () => h.missions.currentObjectives('c4_m2').find((o) => o.objective.kind === 'collect')?.value;
    expect(counter()).toBe(0);

    h.economy.addResource('lithium', 30, 'reward');
    h.economy.addResource('lithium', 25, 'voucher');
    h.economy.addResource('lithium', 15, 'subsidy');
    h.economy.applyBonus(MISSIONS.c4_s1); // c4_s1's bonus: lithium 30, as a reward
    h.events.emit('resource:collected', { resource: 'lithium', amount: CONTRACT_LITHIUM, total: 120, source: 'reward' });
    expect(h.save.resources.lithium).toBe(100);
    expect(counter()).toBe(0);

    h.economy.addResource('lithium', 10, 'pickup');
    expect(counter()).toBe(10);

    // A full hold ships the wanted surplus home, and that counts (SPEC-034 §4.12).
    h.save.resources.lithium = h.economy.cargoCap();
    expect(h.economy.addResource('lithium', 15, 'pickup')).toEqual({ added: 0, shipped: 15, blocked: 0 });
    expect(counter()).toBe(25);
  });

  it('SPEC-057 §4.4 (57-f): a recovery while c1_m2 is active fills the hold and leaves its oil counter', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1'));
    h.missions.accept('c1_m2');
    const counter = () => h.missions.currentObjectives('c1_m2').find((o) => o.objective.kind === 'collect')?.value;
    expect(counter()).toBe(0);
    const before = h.save.resources.oil;
    h.economy.addResource('oil', 20, 'recovered');
    expect(h.save.resources.oil).toBe(before + 20);
    expect(counter()).toBe(0);
    // The bus event alone, as the scene's recovery raises it, moves nothing either.
    h.events.emit('resource:collected', { resource: 'oil', amount: 20, total: before + 40, source: 'recovered' });
    expect(counter()).toBe(0);
    // A pickup still counts.
    h.economy.addResource('oil', 5, 'pickup');
    expect(counter()).toBe(5);
  });
});

// ------------------------------------------------------------- SPEC-054 §4.11

describe('Missions — below (SPEC-054 §4.11, E83)', () => {
  it('a kill still counts underground, and the survive timer that follows it holds at zero', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1'));
    h.missions.accept('c1_s2'); // stage 0: kill 8 skitters; stage 1: survive 90 s
    h.ctx.level = 'underground';
    for (let i = 0; i < 8; i++) h.events.emit('enemy:killed', { enemyId: 'dust_skitter', elite: false, x: 0, z: 0, xp: 4 });
    // The kill advanced the stage: nothing about `level` touches kill counting.
    expect(h.missions.active[0]?.stage).toBe(1);

    const timer = () => h.missions.currentObjectives('c1_s2').find((o) => o.objective.kind === 'survive')?.value ?? 0;
    h.run(30);
    expect(timer()).toBe(0); // held — the clock does not run below

    // Above, the same seconds move the clock (AC-33): the hold is `level`'s
    // doing, not a timer that stopped working.
    h.ctx.level = 'surface';
    h.run(30);
    expect(timer()).toBeGreaterThan(29);
  });

  it('a deliver objective makes no progress while nearPoi answers null, as the cave supplies it', () => {
    const h = harness((save) => save.progress.missionsDone.push('c1_m1', 'c1_m2'));
    h.missions.accept('c1_m3');
    h.events.emit('boss:defeated', { boss: 'dune_wurm' });
    expect(h.missions.active[0]?.stage).toBe(1); // the deliver stage

    h.ctx.level = 'underground';
    h.ctx.nearPoi = () => null; // §4.11: what the cave's context answers
    h.save.resources.oil = 150;
    h.ctx.player.x = 50;
    h.ctx.player.z = 20; // the beacon's position above — unreachable below
    h.run(1);
    expect(h.save.resources.oil).toBe(150); // no delivery: nothing is "near"
    expect(h.of('poi:delivered')).toEqual([]);
  });
});
