// SPEC-038 §6.1 — the threat suite. A kite bot with auto-fire on, in its
// chapter's reference kit, plays the real field of each combat planet for
// 3 minutes × 16 seeds on `medium`. Before SPEC-038 it took 0–12 % of its max HP
// a minute, all of it from projectiles: walking away erased every blow. Now the
// field has to cost something — and never more than a quarter a minute — and
// part of that cost has to come from blows and charges.
//
// SPEC-041 §6.1 extends it: every suite runs on the post-SPEC-039 reference
// kit (`referenceKit`, with the Rocket's rotation), the field's packs keep the
// kiter engaged, and each boss is fought in its sealed arena by four bots — the
// kiter must win, a bot that reads the telegraphs must barely be touched, and
// one that stands still must not survive on luck.
import { describe, expect, it } from 'vitest';
import { makeEnemy } from '@/entities/Enemy';
import { makePlayer } from '@/entities/Player';
import { Pool } from '@/core/Pool';
import { ENEMIES, PLANETS } from '@/data/index';
import { NO_OBSTACLES } from '@/entities/World';
import type { CombatWorld, PlayerStats } from '@/systems/Combat';
import {
  BOSSES,
  COMBAT_PLANETS,
  kite,
  referenceKit,
  runBoss,
  runField,
  summarize,
  type BossBot,
  type BossResult,
  type PlanetSummary,
} from './threatBots';

/**
 * §6.1: seeds 1–16. One planet's cost varies from 7 to 65 % a minute across
 * seeds, so a single death spiral decided the four-seed mean this began with.
 */
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;

/** A bare world for the kite rule on its own. */
function world(): CombatWorld {
  return {
    player: makePlayer(0, 0, 100),
    stats: {} as PlayerStats,
    enemies: new Pool(makeEnemy),
    projectiles: new Pool(makeEnemy) as unknown as CombatWorld['projectiles'],
    follower: null,
    obstacles: NO_OBSTACLES,
    arena: null,
    time: 0,
  };
}

function place(w: CombatWorld, id: keyof typeof ENEMIES, x: number, z: number, aggro: boolean): void {
  const e = w.enemies.alloc();
  Object.assign(e, makeEnemy(), { id: w.enemies.size, def: ENEMIES[id], x, z, aggro, state: aggro ? 'chase' : 'wander', radius: ENEMIES[id].radius });
}

describe('kite(world) (SPEC-038 §6.1)', () => {
  it('walks away from the weighted centroid of what can reach it', () => {
    const w = world();
    place(w, 'dust_skitter', 2, 0, true);
    place(w, 'dust_skitter', 0, 3, true);
    const out = { x: 0, z: 0 };
    kite(w, 14, out);
    expect(out.x).toBeLessThan(0);
    expect(out.z).toBeLessThan(0);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(1, 10);
  });

  it('a ranged enemy threatens only inside 5 m; an unaggroed one never', () => {
    const w = world();
    place(w, 'scav_raider', 6, 0, true);
    place(w, 'dust_skitter', 0, 1, false);
    const out = { x: 0, z: 0 };
    kite(w, 14, out);
    // Nothing threatens; the nearest (the idle skitter at 1 m) is inside
    // 0.75 × range, so the bot stands and shoots.
    expect(out).toEqual({ x: 0, z: 0 });
  });

  it('hunts the nearest enemy within 45 m that is out of 0.75 × range, and stands past 45 m', () => {
    const w = world();
    place(w, 'wurmling', 30, 0, false);
    const out = { x: 0, z: 0 };
    kite(w, 14, out);
    expect(out.x).toBeCloseTo(1, 10);
    const far = world();
    place(far, 'wurmling', 50, 0, false);
    kite(far, 14, out);
    expect(out).toEqual({ x: 0, z: 0 });
  });
});

describe('the reference kit (SPEC-041 §6.1)', () => {
  it('is the post-SPEC-039 player of each chapter, derived from RECOMMENDED_LOADOUT', () => {
    // Pinned, so a change to the recommendation — or to the Wurm's piece — is
    // a deliberate change to every suite below.
    expect(referenceKit(1)).toEqual({ level: 3, rifle: 'weapon_kinetic', armor: 'armor_scrap', drone: false, heavy: null });
    expect(referenceKit(2)).toEqual({ level: 7, rifle: 'weapon_laser', armor: 'armor_composite', drone: false, heavy: 'launcher_rocket' });
    expect(referenceKit(3)).toEqual({ level: 10, rifle: 'weapon_laser', armor: 'armor_composite', drone: false, heavy: 'launcher_rocket' });
    expect(referenceKit(4)).toEqual({ level: 13, rifle: 'weapon_laser', armor: 'armor_composite', drone: true, heavy: 'launcher_rocket' });
    expect(referenceKit(5)).toEqual({ level: 15, rifle: 'weapon_plasma', armor: 'armor_composite', drone: true, heavy: 'launcher_rocket' });
    expect(referenceKit(6)).toEqual({ level: 17, rifle: 'weapon_plasma', armor: 'armor_reactive', drone: true, heavy: 'launcher_rocket' });
  });
});

describe('the field suite (SPEC-038 §6.1, AC-22; SPEC-041 §6.1)', () => {
  const summaries: PlanetSummary[] = COMBAT_PLANETS.map((planet) =>
    summarize(
      planet,
      SEEDS.map((seed) => runField(planet, seed)),
    ),
  );
  const table = summaries.map(
    (s) => `${s.planet}: ${s.perMinute.toFixed(1)} %/min, ${(s.enemyShare * 100).toFixed(0)} % blows, ${s.engaged.toFixed(2)} engaged`,
  );

  it('plays every combat planet on its chapter’s reference kit', () => {
    for (const planet of COMBAT_PLANETS) expect(referenceKit(PLANETS[planet].chapter).level).toBeGreaterThan(0);
  });

  it('costs 1–25 % of max HP a minute on at least four of the five, ≥ 5 % of it from blows and charges', () => {
    const passing = summaries.filter((s) => s.perMinute >= 1 && s.perMinute <= 25 && s.enemyShare >= 0.05);
    expect(passing.length, table.join('\n')).toBeGreaterThanOrEqual(4);
  });

  it('never costs more than 25 % a minute on any', () => {
    for (const s of summaries) expect(s.perMinute, table.join('\n')).toBeLessThanOrEqual(25);
  });

  // SPEC-041 §4.5: packs make the field arrive together — a kiter averages
  // ≥ 0.6 aggroed enemies within 12 m (0.29–0.64 without packs).
  it('keeps the kiter engaged: ≥ 0.6 aggroed enemies within 12 m on average, on every planet', () => {
    for (const s of summaries) expect(s.engaged, table.join('\n')).toBeGreaterThanOrEqual(0.6);
  });
});

describe('the boss suite (SPEC-041 §6.1)', () => {
  /** §6.1: seeds 1–6 per boss and bot. */
  const BOSS_SEEDS = [1, 2, 3, 4, 5, 6] as const;
  const BOTS: readonly BossBot[] = ['kite', 'stand', 'reader', 'dasher'];
  const fights = new Map<string, BossResult[]>();
  for (const boss of BOSSES) {
    for (const bot of BOTS) fights.set(`${boss}/${bot}`, BOSS_SEEDS.map((seed) => runBoss(boss, bot, seed)));
  }
  const of = (boss: string, bot: BossBot): BossResult[] => fights.get(`${boss}/${bot}`) ?? [];
  const row = (runs: readonly BossResult[]): string =>
    runs.map((r) => `${r.seed}: ${r.won ? 'won' : r.died ? 'died' : 'timed out'} ${r.seconds.toFixed(0)} s, lost ${r.lost.toFixed(0)} %`).join('; ');

  for (const boss of BOSSES) {
    describe(ENEMIES[boss].name, () => {
      it('the kite bot wins every fight, with no death, in 30–70 s', () => {
        for (const run of of(boss, 'kite')) {
          expect(run.won, row(of(boss, 'kite'))).toBe(true);
          expect(run.died).toBe(false);
          expect(run.seconds, row(of(boss, 'kite'))).toBeGreaterThanOrEqual(30);
          expect(run.seconds, row(of(boss, 'kite'))).toBeLessThanOrEqual(70);
        }
      });

      it('the reader loses ≤ 25 % of its max HP', () => {
        for (const run of of(boss, 'reader')) expect(run.lost, row(of(boss, 'reader'))).toBeLessThanOrEqual(25);
      });

      it('the dasher loses ≤ 10 %', () => {
        for (const run of of(boss, 'dasher')) expect(run.lost, row(of(boss, 'dasher'))).toBeLessThanOrEqual(10);
      });

      it('the stand bot loses ≥ 100 %', () => {
        for (const run of of(boss, 'stand')) expect(run.lost, row(of(boss, 'stand'))).toBeGreaterThanOrEqual(100);
      });
    });
  }
});
