// SPEC-047 §4.5, §6.1 — the run's statistics: what counts, what does not, and
// the ceiling every count stops at. The bus is the real one, so the
// subscriptions are released the way a scene's are.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { emptyRunStats, newSave, STAT_CEILING, type CharacterCreation, type Save } from '@/core/Save';
import { recordBoss, recordDeath, recordKill, watchRunStats } from '@/systems/RunStats';

const CREATION: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
};

const KILL: GameEvents['enemy:killed'] = { enemyId: 'dust_skitter', elite: false, x: 3, z: 4, xp: 10 };

describe('recordKill / recordBoss / recordDeath (§4.5)', () => {
  it('a kill raises kills by 1, and an elite raises elites too', () => {
    const stats = emptyRunStats();
    recordKill(stats, false);
    expect(stats).toEqual({ ...emptyRunStats(), kills: 1 });
    recordKill(stats, true);
    expect(stats).toEqual({ ...emptyRunStats(), kills: 2, elites: 1 });
  });

  it('a boss raises bosses by 1', () => {
    const stats = emptyRunStats();
    recordBoss(stats);
    recordBoss(stats);
    expect(stats).toEqual({ ...emptyRunStats(), bosses: 2 });
  });

  it('a surface death raises deaths and moves that planet’s lastDeath, rounded to 0.1 m', () => {
    const stats = emptyRunStats();
    recordDeath(stats, 'cinder4', { x: 12.345, z: -7.06 });
    expect(stats.deaths).toBe(1);
    expect(stats.lastDeath).toEqual({ cinder4: { x: 12.3, z: -7.1 } });
    // The next death on the same planet replaces it; another planet adds one.
    recordDeath(stats, 'cinder4', { x: -40.04, z: 0.05 });
    recordDeath(stats, 'vetra', { x: 1, z: 2 });
    expect(stats.deaths).toBe(3);
    expect(stats.lastDeath).toEqual({ cinder4: { x: -40, z: 0.1 }, vetra: { x: 1, z: 2 } });
  });

  it('47-f: a death with no ground raises deaths and leaves lastDeath alone', () => {
    const stats = emptyRunStats();
    stats.lastDeath.vetra = { x: 5, z: 6 };
    recordDeath(stats, null, null);
    expect(stats.deaths).toBe(1);
    expect(stats.lastDeath).toEqual({ vetra: { x: 5, z: 6 } });
  });

  it('47-h: a count at STAT_CEILING stays there', () => {
    const stats = { ...emptyRunStats(), deaths: STAT_CEILING, kills: STAT_CEILING, elites: STAT_CEILING, bosses: STAT_CEILING };
    recordKill(stats, true);
    recordBoss(stats);
    recordDeath(stats, 'eden', { x: 0, z: 0 });
    expect(stats).toMatchObject({ deaths: STAT_CEILING, kills: STAT_CEILING, elites: STAT_CEILING, bosses: STAT_CEILING });
    // One short of it still counts up to it, and no further.
    const almost = { ...emptyRunStats(), kills: STAT_CEILING - 1 };
    recordKill(almost, false);
    recordKill(almost, false);
    expect(almost.kills).toBe(STAT_CEILING);
  });
});

describe('watchRunStats (§4.5)', () => {
  function harness(where: () => { planet: 'cinder4'; x: number; z: number } | null): {
    bus: EventBus<GameEvents>;
    save: Save;
    owner: object;
    release: () => void;
  } {
    const bus = new EventBus<GameEvents>({ dev: false });
    const save = newSave(0, CREATION, 1, 0);
    const owner = {};
    return { bus, save, owner, release: watchRunStats(bus, save, owner, where) };
  }

  it('counts every kill, elite, boss and surface death into save.meta.stats', () => {
    let at = { planet: 'cinder4' as const, x: 10.04, z: -20.06 };
    const { bus, save } = harness(() => at);
    bus.emit('enemy:killed', KILL);
    bus.emit('enemy:killed', { ...KILL, elite: true });
    bus.emit('boss:defeated', { boss: 'dune_wurm' });
    bus.emit('player:died', { cause: { kind: 'fall' }, scene: 'surface' });
    at = { planet: 'cinder4', x: -3.25, z: 7 };
    bus.emit('player:died', { cause: { kind: 'fall' }, scene: 'surface' });
    expect(save.meta.stats).toEqual({
      deaths: 2,
      kills: 2,
      elites: 1,
      bosses: 1,
      recoveries: 0,
      lastDeath: { cinder4: { x: -3.2, z: 7 } },
    });
  });

  it('a flight death counts with no lastDeath (47-f)', () => {
    const { bus, save } = harness(() => null);
    bus.emit('enemy:killed', KILL);
    bus.emit('player:died', { cause: { kind: 'asteroid' }, scene: 'flight' });
    expect(save.meta.stats).toEqual({ ...emptyRunStats(), deaths: 1, kills: 1 });
  });

  it('a Recall, a dismissal and a mission completion change no count, and recoveries is never written', () => {
    const { bus, save } = harness(() => ({ planet: 'cinder4', x: 0, z: 0 }));
    bus.emit('player:recalled', {});
    bus.emit('enemy:dismissed', { enemyId: 'dust_skitter', x: 1, z: 1 });
    bus.emit('mission:completed', { id: 'c1_m1', replay: true });
    expect(save.meta.stats).toEqual(emptyRunStats());
    bus.emit('enemy:killed', KILL);
    bus.emit('player:died', { cause: { kind: 'fall' }, scene: 'surface' });
    expect(save.meta.stats.recoveries).toBe(0);
  });

  it('the release function unsubscribes every handler', () => {
    const { bus, save, owner, release } = harness(() => ({ planet: 'cinder4', x: 0, z: 0 }));
    bus.emit('enemy:killed', KILL);
    release();
    bus.emit('enemy:killed', KILL);
    bus.emit('boss:defeated', { boss: 'dune_wurm' });
    bus.emit('player:died', { cause: { kind: 'fall' }, scene: 'surface' });
    expect(save.meta.stats).toEqual({ ...emptyRunStats(), kills: 1 });
    // Nothing is left on the bus or on the owner.
    expect(bus.count()).toBe(0);
    expect(bus.releaseOwner(owner)).toBe(0);
  });
});
