// SPEC-041 §4.1–§4.2, §6.1 — the boss move runtime: the pick by weight, phase
// and range on the `ai` stream, the rooted cast, each kind's telegraph or
// volley, the charge that ends at the ring + 2 m, `boss:move` on landing, the
// cancel on a phase change, the wurm's burrow and the queen's acid. All of it
// at the fixed 60 Hz step through the real `Combat` and `EnemyAi`.
import { describe, expect, it } from 'vitest';
import { Rng, RngRoot } from '@/core/Rng';
import { ENEMIES, type BossMove, type Enemy, type EnemyId } from '@/data/index';
import type { EnemyEntity } from '@/entities/Enemy';
import type { ArenaState } from '@/entities/World';
import { BOSS_CHARGE_RING_MARGIN, BOSS_FIRST_MOVE_SECONDS, pickBossMove } from '@/systems/EnemyAi';
import { STEP, harness, type Harness } from './combatFixtures';

/** Steps until `predicate` holds, or -1; bounded by `seconds`. */
function runUntil(h: Harness, seconds: number, predicate: () => boolean): number {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    h.step();
    if (predicate()) return i + 1;
  }
  return -1;
}

/** A boss already in the fight: aggroed, chasing, its first move's wait spent. */
function fighting(h: Harness, id: EnemyId, x: number, z: number): EnemyEntity {
  const boss = h.spawn(id, x, z);
  boss.aggro = true;
  boss.state = 'chase';
  boss.stateTime = 0;
  boss.moveCd = 0;
  return boss;
}

function moveOf(id: EnemyId, move: BossMove['id']): BossMove {
  const found = ((ENEMIES[id] as Enemy).moves ?? []).find((m) => m.id === move);
  if (found === undefined) throw new Error(`${id} has no ${move}`);
  return found;
}

/** Every summon goes through the script path, so nothing else bites the player. */
function clearSummons(h: Harness): void {
  for (let i = h.world.enemies.size - 1; i >= 0; i--) {
    const e = h.world.enemies.at(i);
    if (e.def.archetype !== 'boss' && e.state !== 'dead') h.combat.killEnemy(e, 'script');
  }
}

const ARENA = (): ArenaState => ({ x: 0, z: 0, radius: 20, locked: true, sealed: false });

describe('the pick (SPEC-041 §4.1)', () => {
  it('a boss spawns with its first move 2 s away and no timed move due', () => {
    const h = harness();
    const boss = h.spawn('dune_wurm', 10, 0);
    expect(boss.moveCd).toBe(BOSS_FIRST_MOVE_SECONDS);
    expect(boss.timedMoveAt).toBe(Infinity);
    expect(boss.moveIndex).toBe(-1);
  });

  it('weighs the moves the phase and the distance allow, and never the others', () => {
    const h = harness();
    const queen = h.spawn('hive_queen', 0, 0);
    const moves = ENEMIES.hive_queen.moves;
    const counts = new Map<string, number>();
    const rng = new Rng(77);
    // At 10 m in phase 1: acid_volley (weight 3, 4–18 m) and royal_dive
    // (weight 2, 6–24 m); brood_burst waits for phase 2.
    for (let i = 0; i < 2000; i++) {
      const id = moves[pickBossMove(queen, 10, rng)]?.id ?? 'none';
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual(['acid_volley', 'royal_dive']);
    expect((counts.get('acid_volley') ?? 0) / 2000).toBeGreaterThan(0.55);
    expect((counts.get('acid_volley') ?? 0) / 2000).toBeLessThan(0.65);
    // Phase 2 opens brood_burst; at 20 m only royal_dive's band holds.
    queen.phase = 2;
    for (let i = 0; i < 200; i++) expect(moves[pickBossMove(queen, 20, rng)]?.id).toBe('royal_dive');
    expect(new Set(Array.from({ length: 300 }, () => moves[pickBossMove(queen, 2, rng)]?.id))).toEqual(new Set(['brood_burst']));
    // Out of every band: no move, and no draw taken.
    const before = new Rng(5);
    const after = new Rng(5);
    expect(pickBossMove(queen, 30, after)).toBe(-1);
    expect(after.next()).toBe(before.next());
  });

  it('draws on the ai stream only — the layout stream is untouched after 1,000 picks', () => {
    const root = new RngRoot(42);
    const layout = root.layout('cinder4');
    const fresh = root.layout('cinder4');
    const h = harness();
    const aiBefore = new Rng(h.rng.ai.seed);
    let picks = 0;
    for (let i = 0; i < 1000; i++) {
      const boss = fighting(h, 'hive_queen', 0, 10);
      h.step();
      if (boss.state === 'cast') picks++;
      h.combat.killEnemy(boss, 'script');
      h.step();
    }
    expect(picks).toBe(1000);
    // The picks moved the ai stream…
    expect(h.rng.ai.next()).not.toBe(aiBefore.next());
    // …and nothing else: the layout stream reads exactly as a fresh one.
    for (let i = 0; i < 16; i++) expect(layout.next()).toBe(fresh.next());
  });
});

describe('casting (SPEC-041 §4.1)', () => {
  it('is rooted for the move’s windup, cues its kind, then recovers and waits its cooldown', () => {
    const h = harness();
    // 3 m: only the titan's tremor (0–8 m) is in range.
    const titan = fighting(h, 'ash_titan', 3, 0);
    const tremor = moveOf('ash_titan', 'tremor');
    h.step();
    expect(titan.state).toBe('cast');
    expect(h.of('enemy:windup').at(-1)).toMatchObject({ enemyId: 'ash_titan', kind: 'slam' });
    const at = { x: titan.x, z: titan.z };
    const started = h.world.time;
    expect(runUntil(h, 3, () => titan.state !== 'cast')).toBeGreaterThan(0);
    expect(h.world.time - started).toBeCloseTo(tremor.windup, 1);
    expect(titan.x).toBe(at.x);
    expect(titan.z).toBe(at.z);
    expect(titan.state).toBe('attack');
    expect(titan.recoverFor).toBe(tremor.recover);
    expect(titan.moveCd).toBeCloseTo(tremor.cooldown, 6);
    expect(h.of('boss:move')).toEqual([{ boss: 'ash_titan', move: 'tremor', kind: 'slam_self', x: at.x, z: at.z }]);
  });

  it('on casual the windup and its telegraph stretch ×1.25 (41-l)', () => {
    const h = harness({ patch: (save) => void (save.meta.difficulty = 'casual') });
    const titan = fighting(h, 'ash_titan', 3, 0);
    h.step();
    const started = h.world.time - STEP;
    const t = h.combat.telegraphs.at(0);
    expect(t.hitAt - t.startAt).toBeCloseTo(1.1 * 1.25, 6);
    runUntil(h, 3, () => titan.state !== 'cast');
    expect(h.world.time - started).toBeCloseTo(1.1 * 1.25, 1);
  });
});

describe('each kind draws its telegraph or fires its volley (SPEC-041 §4.1)', () => {
  it('slam_target: a circle of `radius` where the target stood at cast start', () => {
    const h = harness();
    fighting(h, 'hive_broodlord', 3, 0);
    h.step();
    expect(h.combat.telegraphs.size).toBe(1);
    const t = h.combat.telegraphs.at(0);
    expect(t).toMatchObject({ kind: 'circle', x: 0, z: 0, radius: 3.5, source: 'hive_broodlord' });
    expect(t.hitAt - t.startAt).toBeCloseTo(1, 6);
  });

  it('slam_self: a circle on the boss reaching `radius` past its body', () => {
    const h = harness();
    const wurm = fighting(h, 'dune_wurm', 3, 0);
    h.step();
    const t = h.combat.telegraphs.at(0);
    expect(t).toMatchObject({ kind: 'circle', x: wurm.x, z: wurm.z });
    expect(t.radius).toBeCloseTo(wurm.radius + 3.5, 6);
  });

  it('lines: three lanes fanned 0.35 rad apart around the facing, none following, none body-resolved', () => {
    const h = harness();
    // 20 m: only the fissure (6–24 m).
    const titan = fighting(h, 'ash_titan', 20, 0);
    h.step();
    expect(h.combat.telegraphs.size).toBe(3);
    const offsets: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = h.combat.telegraphs.at(i);
      expect(t).toMatchObject({ kind: 'line', length: 16, width: 2, bodyResolved: false });
      expect(t.lockAt).toBeLessThan(t.startAt);
      // The lane's angle off the facing, in (−π, π].
      const off = Math.atan2(t.dirZ, t.dirX) - titan.facing;
      offsets.push(Math.atan2(Math.sin(off), Math.cos(off)));
    }
    offsets.sort((a, b) => a - b);
    expect(offsets[0] ?? 0).toBeCloseTo(-0.35, 6);
    expect(offsets[1] ?? 0).toBeCloseTo(0, 6);
    expect(offsets[2] ?? 0).toBeCloseTo(0.35, 6);
  });

  it('ring: a band growing from the boss at 9 m/s to 11 m (the matriarch’s nova, phase 2)', () => {
    const h = harness();
    const matriarch = fighting(h, 'frost_matriarch', 2, 0);
    matriarch.phase = 2;
    h.step();
    const t = h.combat.telegraphs.at(0);
    expect(t).toMatchObject({ kind: 'ring', x: matriarch.x, z: matriarch.z, ringMax: 11, ringSpeed: 9, band: 1.5 });
    expect(h.of('enemy:windup').at(-1)?.kind).toBe('ring');
  });

  it('charge: a body-resolved lane that follows its owner until `lock`', () => {
    const h = harness();
    // 15 m: only the sand rush (5–22 m).
    fighting(h, 'dune_wurm', 15, 0);
    h.step();
    expect(h.combat.telegraphs.size).toBe(1);
    const t = h.combat.telegraphs.at(0);
    expect(t).toMatchObject({ kind: 'line', length: 14, width: 3.2, bodyResolved: true });
    expect(t.hitAt - t.lockAt).toBeCloseTo(0.25, 6);
    expect(h.of('enemy:windup').at(-1)?.kind).toBe('charge');
  });

  it('volley: `count` shots evenly over `spread` around the facing, at damage × damageMult', () => {
    const h = harness();
    // 10 m, phase 1: only the matriarch's shard fan (4–20 m).
    const matriarch = fighting(h, 'frost_matriarch', -10, 0);
    h.step();
    expect(matriarch.state).toBe('cast');
    expect(h.of('enemy:windup').at(-1)?.kind).toBe('volley');
    expect(h.combat.telegraphs.size).toBe(0);
    expect(runUntil(h, 2, () => h.world.projectiles.size > 0)).toBeGreaterThan(0);
    expect(h.world.projectiles.size).toBe(5);
    const angles: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = h.world.projectiles.at(i);
      expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(15, 6);
      expect(p.radius).toBe(0.35);
      expect(p.damage).toBeCloseTo(ENEMIES.frost_matriarch.damage * 0.5, 6);
      // Fired this step, and already one step into its 20 m.
      expect((p.ttl + STEP) * 15).toBeCloseTo(20, 6);
      angles.push(Math.atan2(p.vz, p.vx));
    }
    angles.sort((a, b) => a - b);
    expect((angles[4] ?? 0) - (angles[0] ?? 0)).toBeCloseTo(0.9, 6);
    expect(h.of('boss:move').at(-1)).toMatchObject({ move: 'shard_fan', kind: 'volley' });
  });

  it('a charge or a volley turns at ≤ 4 rad/s while it winds up, and holds still for its last `lock` s', () => {
    const h = harness();
    const wurm = fighting(h, 'dune_wurm', 15, 0);
    h.step();
    const before = wurm.facing;
    // The player sidesteps a long way: the wurm turns, but no faster than 4 rad/s.
    h.world.player.z = 30;
    h.step();
    expect(Math.abs(wurm.facing - before)).toBeLessThanOrEqual(4 * STEP + 1e-9);
    runUntil(h, 0.9 - 0.25 - 2 * STEP, () => false);
    const locked = wurm.facing;
    runUntil(h, 0.2, () => wurm.state !== 'cast');
    expect(wurm.facing).toBe(locked);
  });
});

describe('the boss charge (SPEC-041 §4.1, 41-b)', () => {
  it('runs on through its one contact and ends at the arena ring + 2 m', () => {
    const h = harness({ arena: ARENA() });
    // The wurm at 8 m east of the centre, the player 10 m beyond it: the
    // 14 m rush would carry it to 22 m — past the ring's 20 + 2 − 2.5.
    const wurm = fighting(h, 'dune_wurm', 8, 0);
    h.world.player.x = 18;
    h.step();
    expect(wurm.state).toBe('cast');
    expect(runUntil(h, 3, () => wurm.state === 'attack')).toBeGreaterThan(0);
    const limit = 20 + BOSS_CHARGE_RING_MARGIN - wurm.radius;
    expect(Math.hypot(wurm.x, wurm.z)).toBeCloseTo(limit, 6);
    // One contact, ×1.2 through the lane — the body ran on through the player.
    const hits = h.of('player:damaged').filter((d) => d.source.kind === 'enemy');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.amount).toBeGreaterThan(0);
    expect(wurm.x).toBeGreaterThan(h.world.player.x);
    expect(h.of('boss:move').at(-1)).toMatchObject({ move: 'sand_rush', kind: 'charge' });
    expect(h.combat.telegraphs.size).toBe(0);
  });
});

describe('landing and cancelling (SPEC-041 §4.1)', () => {
  it('boss:move fires when a slam lands, with the hit through damagePlayer', () => {
    const h = harness();
    fighting(h, 'hive_broodlord', 3, 0);
    h.step();
    expect(h.of('boss:move')).toEqual([]);
    runUntil(h, 1.2, () => h.of('boss:move').length > 0);
    expect(h.of('boss:move')).toEqual([{ boss: 'hive_broodlord', move: 'brood_stomp', kind: 'slam_target', x: 0, z: 0 }]);
    expect(h.of('player:damaged').some((d) => d.source.kind === 'enemy' && d.source.enemyId === 'hive_broodlord')).toBe(true);
  });

  it('a phase change mid-cast cancels the move and its telegraphs (41-c)', () => {
    const h = harness();
    const brood = fighting(h, 'hive_broodlord', 3, 0);
    h.step();
    expect(brood.state).toBe('cast');
    expect(h.combat.telegraphs.size).toBe(1);
    brood.hp = brood.maxHp * 0.45;
    h.step();
    expect(brood.state).toBe('special');
    expect(brood.specialKind).toBe('phase');
    expect(brood.moveIndex).toBe(-1);
    expect(h.combat.telegraphs.size).toBe(0);
    clearSummons(h);
    h.run(2);
    expect(h.of('boss:move')).toEqual([]);
  });

  it('the boss’s death cancels its pending telegraphs and its move', () => {
    const h = harness();
    const brood = fighting(h, 'hive_broodlord', 3, 0);
    h.step();
    h.combat.killEnemy(brood, 'script');
    expect(brood.moveIndex).toBe(-1);
    expect(h.combat.telegraphs.size).toBe(0);
  });

  it('a leash reset cancels the cast and starts the clocks over', () => {
    const h = harness({ arena: ARENA() });
    const brood = fighting(h, 'hive_broodlord', 30, 0);
    h.world.player.x = 33;
    h.step();
    expect(brood.state).toBe('cast');
    // Hold it beyond radius + 4 for the 8 s the leash allows.
    for (let i = 0; i < Math.round(8.2 / STEP) && h.of('ui:toast').length === 0; i++) {
      brood.x = 30;
      brood.z = 0;
      h.step();
    }
    expect(brood.moveIndex).toBe(-1);
    expect(brood.moveCd).toBe(BOSS_FIRST_MOVE_SECONDS);
    expect(brood.timedMoveAt).toBe(Infinity);
    expect(h.combat.telegraphs.size).toBe(0);
  });
});

describe('the wurm’s burrow (SPEC-041 §4.1)', () => {
  it('digs 2.5 s, circles the player’s spot for 1.2 s at radius 3.5, surfaces there, and is due again 6 s later', () => {
    const h = harness();
    const wurm = fighting(h, 'dune_wurm', 10, 0);
    // Review 2026-10 (G-06): phase 2 starts at 55 % — it was 40 %, so half
    // its HP left would still have been phase 1.
    wurm.hp = wurm.maxHp * 0.5;
    h.step();
    // Phase-2 entry starts it in place of the 1.5 s special.
    expect(h.of('boss:phase')).toEqual([{ boss: 'dune_wurm', phase: 2 }]);
    expect(wurm.state).toBe('special');
    expect(wurm.specialKind).toBe('burrow_dig');
    expect(wurm.invulnerable).toBe(true);
    expect(h.of('enemy:windup').at(-1)).toMatchObject({ enemyId: 'dune_wurm', kind: 'burrow' });
    clearSummons(h);
    const dug = h.world.time - STEP;

    // Invulnerable under the sand (11-f).
    const hp = wurm.hp;
    h.shot({ x: wurm.x, z: wurm.z, vx: 40, damage: 100_000, ttl: 0.05 });
    h.run(0.2);
    expect(wurm.hp).toBe(hp);

    // The player moves while it digs; the circle lands where they stand when it ends.
    h.world.player.x = -4;
    h.world.player.z = 3;
    expect(runUntil(h, 3, () => wurm.specialKind === 'burrow_telegraph')).toBeGreaterThan(0);
    expect(h.world.time - dug).toBeCloseTo(2.5, 1);
    expect(h.combat.telegraphs.size).toBe(1);
    const circle = h.combat.telegraphs.at(0);
    expect(circle).toMatchObject({ kind: 'circle', x: -4, z: 3, radius: 3.5 });
    expect(circle.damage).toBeCloseTo(wurm.damage * 1.5, 6);
    expect(circle.hitAt - circle.startAt).toBeCloseTo(1.2, 6);
    expect(wurm.invulnerable).toBe(true);

    // Standing in it: the hit lands, and the wurm surfaces at the centre.
    const before = h.of('player:damaged').length;
    expect(runUntil(h, 1.5, () => wurm.specialKind === 'none')).toBeGreaterThan(0);
    const surfaced = h.world.time;
    expect(wurm.x).toBe(-4);
    expect(wurm.z).toBe(3);
    expect(wurm.invulnerable).toBe(false);
    expect(h.of('boss:move').at(-1)).toEqual({ boss: 'dune_wurm', move: 'burrow', kind: 'burrow', x: -4, z: 3 });
    h.step();
    expect(h.of('player:damaged').length).toBeGreaterThan(before);
    // Review 2026-10 (G-06): every 6 s — it was 9.
    expect(wurm.timedMoveAt).toBeCloseTo(surfaced + 6, 6);

    // Six seconds later it goes under again (after any cast in between, 41-d).
    expect(runUntil(h, 11, () => wurm.specialKind === 'burrow_dig')).toBeGreaterThan(0);
    expect(h.world.time).toBeGreaterThanOrEqual(surfaced + 6 - 1e-6);
  });
});

describe('the queen (SPEC-041 §4.1)', () => {
  it('fires her acid volley in phase 1: three 13 m/s shots over 0.6 rad at ×0.45', () => {
    const h = harness();
    // West of the player at 5 m: only the acid (4–18 m) is in range.
    const queen = fighting(h, 'hive_queen', -5, 0);
    expect(queen.phase).toBe(1);
    expect(runUntil(h, 2, () => h.world.projectiles.size > 0)).toBeGreaterThan(0);
    expect(h.world.projectiles.size).toBe(3);
    const angles: number[] = [];
    for (let i = 0; i < 3; i++) {
      const p = h.world.projectiles.at(i);
      expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(13, 6);
      expect(p.damage).toBeCloseTo(ENEMIES.hive_queen.damage * 0.45, 6);
      angles.push(Math.atan2(p.vz, p.vx));
    }
    expect(Math.max(...angles) - Math.min(...angles)).toBeCloseTo(0.6, 6);
    expect(h.of('boss:move')).toEqual([{ boss: 'hive_queen', move: 'acid_volley', kind: 'volley', x: queen.x, z: queen.z }]);
    expect(queen.moveCd).toBeCloseTo(2.4, 6);
  });
});

describe('the review 2026-10 boss retunes (initial tuning)', () => {
  // G-07: the Titan's phase 3 hit ×1.44, its worst blow 29 % of a chapter-4
  // player's HP — the spike of the curve.
  it('the Ash Titan hits ×1.2 below 60 % and ×1.3 below 30 %', () => {
    expect(ENEMIES.ash_titan.phases.map((phase) => [phase.hpFraction, phase.damageMult])).toEqual([
      [1, 1],
      [0.6, 1.2],
      [0.3, 1.3],
    ]);
  });
});
