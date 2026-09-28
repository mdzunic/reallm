// SPEC-038 §6.1 — the threat suite. A kite bot with auto-fire on, in its
// chapter's reference kit, plays the real field of each combat planet for
// 3 minutes × 4 seeds on `medium`. Before SPEC-038 it took 0–12 % of its max HP
// a minute, all of it from projectiles: walking away erased every blow. Now the
// field has to cost something — and never more than a quarter a minute — and
// part of that cost has to come from blows and charges.
import { describe, expect, it } from 'vitest';
import { makeEnemy } from '@/entities/Enemy';
import { makePlayer } from '@/entities/Player';
import { Pool } from '@/core/Pool';
import { ENEMIES, PLANETS } from '@/data/index';
import { NO_OBSTACLES } from '@/entities/World';
import type { CombatWorld, PlayerStats } from '@/systems/Combat';
import { COMBAT_PLANETS, kite, REFERENCE_KIT, runField, summarize, type PlanetSummary } from './threatBots';

const SEEDS = [1, 2, 3, 4] as const;

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

describe('the field suite (SPEC-038 §6.1, AC-22)', () => {
  const summaries: PlanetSummary[] = COMBAT_PLANETS.map((planet) =>
    summarize(
      planet,
      SEEDS.map((seed) => runField(planet, seed)),
    ),
  );
  const table = summaries.map((s) => `${s.planet}: ${s.perMinute.toFixed(1)} %/min, ${(s.enemyShare * 100).toFixed(0)} % blows`);

  it('uses the chapter reference kit of each planet', () => {
    for (const planet of COMBAT_PLANETS) expect(REFERENCE_KIT[PLANETS[planet].chapter]).toBeDefined();
    expect(REFERENCE_KIT[1]).toEqual({ level: 3, rifle: 'weapon_kinetic', armor: 'armor_scrap', drone: false });
    expect(REFERENCE_KIT[5]).toEqual({ level: 15, rifle: 'weapon_plasma', armor: 'armor_composite', drone: true });
  });

  it('costs 1–25 % of max HP a minute on at least four of the five, ≥ 5 % of it from blows and charges', () => {
    const passing = summaries.filter((s) => s.perMinute >= 1 && s.perMinute <= 25 && s.enemyShare >= 0.05);
    expect(passing.length, table.join('\n')).toBeGreaterThanOrEqual(4);
  });

  it('never costs more than 25 % a minute on any', () => {
    for (const s of summaries) expect(s.perMinute, table.join('\n')).toBeLessThanOrEqual(25);
  });
});
