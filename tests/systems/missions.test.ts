// SPEC-012 §6 — the mission runtime (AC-28..AC-44). Runs over the real
// Economy/Progression stack so rewards, replay fractions and cargo behaviour
// are the shipped ones, with a synthetic layout context for POI queries.
//
// SPEC-024 §6 adds the campaign's last minute: the E24 lock that keeps one save
// to one ending, and the dev control that finishes a stage through the runtime.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { newSave, type SaveV1 } from '@/core/Save';
import { MISSIONS, TUNING, type PlanetId } from '@/data/index';
import { Economy } from '@/systems/Economy';
import { Missions, type MissionContext } from '@/systems/Missions';
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
  save: SaveV1;
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
  patch?: (save: SaveV1) => void,
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
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_m2', replay: false }]);
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
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_m1', replay: false }]);
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
    expect(h.of('mission:completed')).toEqual([{ id: 'c1_m3', replay: false }]);
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
    expect(h.of('mission:completed').at(-1)).toEqual({ id: 'c1_m1', replay: true });
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
  const stream = (h: Harness): { name: string; payload: unknown }[] =>
    h.recorded.filter((entry) => !DRIVERS.has(entry.name));

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

  it('ignores a mission that is not running', () => {
    const h = harness();
    h.missions.debugFinishStage('c1_m1');
    expect(h.recorded).toHaveLength(0);
    expect(h.save.progress.missionsDone).toEqual([]);
  });
});
