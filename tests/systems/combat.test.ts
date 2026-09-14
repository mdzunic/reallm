// systems/Combat (SPEC-011 §6): the pinned stat derivation, the §4.2 damage
// formulas, i-frames and weather, firing and auto-aim, swept projectiles,
// consumables and the medic, kills, loot streams and the inCombat signal.
import { describe, expect, it } from 'vitest';
import { Rng, RngRoot } from '@/core/Rng';
import { ITEMS, TUNING } from '@/data/index';
import { CircleObstacles } from '@/entities/World';
import {
  BLAST_KNOCKBACK,
  damageReduction,
  enemyHitDamage,
  EXPLOSIVE_FALLOFF,
  gearAt,
  rollElite,
  rollPlayerDamage,
  type PlayerStats,
  type WeaponDef,
} from '@/systems/Combat';
import { DEPLOYABLE_CAPACITY, MAX_ARMED_MINES } from '@/entities/Deployable';
import { STEP, harness, MARINE, SCOUT } from './combatFixtures';

const KINETIC = ITEMS.weapon_kinetic as WeaponDef;

function flatStats(patch: Partial<PlayerStats> = {}): PlayerStats {
  return {
    maxHp: 100,
    damageMult: 1,
    moveSpeed: 6,
    armor: 0,
    hazardResist: 0,
    critChance: 0,
    pickupRadius: 1.5,
    companionMult: 1,
    ...patch,
  };
}

// ------------------------------------------------------------- player stats

describe('computePlayerStats', () => {
  it('pins marine level 1 with +5 vigor at 184 max HP', () => {
    const h = harness({ creation: MARINE });
    expect(h.world.stats.maxHp).toBe(184); // 100 + 20 + 8×8
  });

  it('pins scout speed at 6 × 1.15 × 1.08', () => {
    const h = harness({ creation: SCOUT });
    expect(h.world.stats.moveSpeed).toBeCloseTo(6 * 1.15 * 1.08, 10);
  });

  it('crit chance is 5 % + 1 % per agility point', () => {
    expect(harness({ creation: MARINE }).world.stats.critChance).toBeCloseTo(0.06, 10);
    expect(harness({ creation: SCOUT }).world.stats.critChance).toBeCloseTo(0.09, 10);
  });

  it('reads armor and hazard resist from the equipped armor', () => {
    const h = harness({ patch: (s) => (s.equipped.armor = 'armor_reactive') });
    expect(h.world.stats.armor).toBe(30);
    expect(h.world.stats.hazardResist).toBe(0.5);
  });

  it('adds the scanner drone auto-collect radius to pickup radius', () => {
    const h = harness({
      patch: (s) => s.companions.push({ id: 'scanner_drone', level: 2, enabled: true }),
    });
    expect(h.world.stats.pickupRadius).toBeCloseTo(TUNING.PICKUP_RADIUS + 6, 10);
  });

  it('recomputes on level-up, equip, consumable and weather change', () => {
    const h = harness({ creation: MARINE });
    expect(h.world.stats.maxHp).toBe(184);
    h.progression.addXp(150, 'test'); // → level 2
    expect(h.world.stats.maxHp).toBe(188);

    h.save.equipped.armor = 'armor_composite';
    h.events.emit('gear:equipped', { slot: 'armor', itemId: 'armor_composite' });
    expect(h.world.stats.armor).toBe(15);

    const before = h.world.stats.damageMult;
    h.combat.applyConsumable({ kind: 'damage_boost', mult: 1.4, seconds: 20 });
    expect(h.world.stats.damageMult).toBeCloseTo(before * 1.4, 10);

    const speed = h.world.stats.moveSpeed;
    h.combat.setWeatherMoveMult(0.5);
    expect(h.world.stats.moveSpeed).toBeCloseTo(speed * 0.5, 10);
  });
});

// ------------------------------------------------------------------- damage

describe('damage formulas (§4.2)', () => {
  it('damageReduction is armor / (armor + 100)', () => {
    expect(damageReduction(15)).toBeCloseTo(0.1304, 4);
    expect(damageReduction(45)).toBeCloseTo(0.3103, 4);
    expect(damageReduction(0)).toBe(0);
  });

  it('applies ±10 % variance to weapon damage', () => {
    const rng = new Rng(11);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const { amount, crit } = rollPlayerDamage(KINETIC, flatStats(), rng);
      expect(crit).toBe(false);
      expect(amount).toBeGreaterThanOrEqual(Math.round(12 * 0.9));
      expect(amount).toBeLessThanOrEqual(Math.round(12 * 1.1));
      seen.add(amount);
    }
    expect(seen.size).toBeGreaterThan(1); // the variance really draws
  });

  it('crits at critChance for ×1.5', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 100; i++) {
      const { amount, crit } = rollPlayerDamage(KINETIC, flatStats({ critChance: 1 }), rng);
      expect(crit).toBe(true);
      expect(amount).toBeGreaterThanOrEqual(Math.round(12 * 0.9 * 1.5));
      expect(amount).toBeLessThanOrEqual(Math.round(12 * 1.1 * 1.5));
    }
    // The crit roll consumes the rng — two seeds agree, a shifted stream does not.
    const a = rollPlayerDamage(KINETIC, flatStats({ critChance: 0.5 }), new Rng(3));
    const b = rollPlayerDamage(KINETIC, flatStats({ critChance: 0.5 }), new Rng(3));
    expect(a).toEqual(b);
  });

  it('never rolls below 1 damage', () => {
    const rng = new Rng(1);
    for (let i = 0; i < 50; i++) {
      expect(rollPlayerDamage(KINETIC, flatStats({ damageMult: 0.0001 }), rng).amount).toBe(1);
    }
  });

  it('enemyHitDamage applies armor, elite ×1.5 and the casual ×0.7, minimum 1', () => {
    const h = harness();
    const wurmling = h.spawn('wurmling', 50, 0); // damage 9
    expect(enemyHitDamage(wurmling, flatStats({ armor: 45 }), 'normal')).toBe(Math.round(9 * (1 - 45 / 145)));
    expect(enemyHitDamage(wurmling, flatStats({ armor: 45 }), 'casual')).toBe(Math.round(9 * 0.7 * (1 - 45 / 145)));
    const elite = h.spawn('wurmling', 60, 0, true);
    expect(enemyHitDamage(elite, flatStats(), 'normal')).toBe(Math.round(9 * 1.5));
    const skitter = h.spawn('dust_skitter', 70, 0); // damage 4
    expect(enemyHitDamage(skitter, flatStats({ armor: 10_000 }), 'casual')).toBe(1);
  });
});

// -------------------------------------------------------- i-frames & death

describe('player damage, i-frames and death', () => {
  it('i-frames block a second direct hit within 0.3 s', () => {
    const h = harness();
    h.combat.damagePlayer(10, { kind: 'fall' });
    h.combat.damagePlayer(10, { kind: 'fall' });
    expect(h.world.player.hp).toBe(174);
    h.run(0.35);
    h.combat.damagePlayer(10, { kind: 'fall' });
    expect(h.world.player.hp).toBe(164);
  });

  it('weather damage ignores i-frames and accumulates fractional points', () => {
    const h = harness();
    h.combat.damagePlayer(10, { kind: 'fall' }); // arms i-frames
    h.combat.damagePlayer(0.4, { kind: 'weather', weather: 'sandstorm' }, true);
    h.combat.damagePlayer(0.4, { kind: 'weather', weather: 'sandstorm' }, true);
    expect(h.world.player.hp).toBe(174); // 0.8 accumulated, nothing applied yet
    h.combat.damagePlayer(0.4, { kind: 'weather', weather: 'sandstorm' }, true);
    expect(h.world.player.hp).toBe(173); // 1.2 → 1 whole point lands
    expect(h.of('player:damaged').at(-1)?.amount).toBe(1);
  });

  it('hazard immunity skips weather damage entirely', () => {
    const h = harness();
    h.combat.applyConsumable({ kind: 'hazard_immunity', seconds: 30 });
    h.combat.damagePlayer(5, { kind: 'weather', weather: 'heatwave' }, true);
    expect(h.world.player.hp).toBe(184);
  });

  it('hazard resist reduces weather damage before the accumulator (SPEC-012 §4.6)', () => {
    // armor_reactive: hazardResist 0.5 — a 4-point tick lands as 2.
    const h = harness({ patch: (s) => (s.equipped.armor = 'armor_reactive') });
    h.combat.damagePlayer(4, { kind: 'weather', weather: 'radiation_storm' }, true);
    expect(h.world.player.hp).toBe(182);
    // Fractional after resist: 0.8 × 0.5 = 0.4 per tick, whole points only.
    h.combat.damagePlayer(0.8, { kind: 'weather', weather: 'radiation_storm' }, true);
    expect(h.world.player.hp).toBe(182);
    h.combat.damagePlayer(0.8, { kind: 'weather', weather: 'radiation_storm' }, true);
    h.combat.damagePlayer(0.8, { kind: 'weather', weather: 'radiation_storm' }, true);
    expect(h.world.player.hp).toBe(181); // 1.2 accumulated → 1 lands
    // Non-weather damage is untouched by hazard resist.
    h.combat.damagePlayer(10, { kind: 'fall' });
    expect(h.world.player.hp).toBe(171);
  });

  it('HP persists into the save and never regenerates naturally', () => {
    const h = harness();
    h.combat.damagePlayer(50, { kind: 'fall' });
    expect(h.save.player.hp).toBe(134);
    h.run(5);
    expect(h.world.player.hp).toBe(134);
  });

  it('death sets alive = false, emits player:died and stops processing the player', () => {
    const h = harness();
    h.combat.damagePlayer(1000, { kind: 'weather', weather: 'sandstorm' }, true);
    expect(h.world.player.alive).toBe(false);
    const died = h.of('player:died');
    expect(died).toEqual([{ cause: { kind: 'weather', weather: 'sandstorm' }, scene: 'surface' }]);
    // No respawn method: further damage and firing are no-ops until the scene resets.
    h.combat.damagePlayer(10, { kind: 'fall' });
    expect(h.of('player:died')).toHaveLength(1);
    h.input.buttons.fire.down = true;
    h.aim = { x: 5, z: 0 };
    h.run(0.2);
    expect(h.world.projectiles.size).toBe(0);
  });

  it('clamps summed knockback to 1 m per step and consumes shots during i-frames', () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      h.shot({ x: -0.4, z: 0, vx: 40, owner: 'enemy', damage: 4, enemyId: 'dust_skitter', ttl: 1 });
    }
    h.step();
    expect(h.world.projectiles.size).toBe(0); // all five consumed (AC-51)
    expect(h.of('player:damaged')).toHaveLength(1); // only the first damages (11-a)
    expect(h.world.player.x).toBeCloseTo(1, 5); // 5 × 0.5 m clamped to 1 m
  });
});

// ----------------------------------------------------- firing & projectiles

describe('firing and aiming (§4.3)', () => {
  it('spawns projectiles per the weapon: muzzle, speed, ttl, pierce, cooldown', () => {
    const h = harness();
    h.input.buttons.fire.down = true;
    h.aim = { x: 10, z: 0 };
    h.step();
    expect(h.world.projectiles.size).toBe(1);
    const p = h.world.projectiles.at(0);
    expect(p.owner).toBe('player');
    expect(p.x).toBeCloseTo(0.6 + 22 * STEP, 6); // muzzle 0.6 + one integration
    expect(p.z).toBeCloseTo(0, 6);
    expect(p.vx).toBeCloseTo(22, 6);
    expect(p.pierceLeft).toBe(0);
    expect(p.ttl).toBeCloseTo(14 / 22 - STEP, 6);
    expect(h.world.player.facing).toBeCloseTo(0, 6); // instant to aim (AC)
    expect(h.world.player.fireCooldown).toBeCloseTo(1 / 3, 6);
    // Held fire refires only after 1/fireRate (one step of float slack).
    h.run(0.3);
    expect(h.world.projectiles.size).toBe(1);
    h.run(0.1);
    expect(h.world.projectiles.size).toBe(2);
  });

  // SPEC-025 §4.8: the weapon in hand is `equipped.primary`, and only that slot
  // moving re-reads it — a pistol going into the sidearm changes nothing that
  // fires until SPEC-028 lands switching.
  it('fires the primary, and re-reads it only when the primary slot moves', () => {
    const h = harness({ patch: (s) => (s.equipped.primary = 'weapon_laser') });
    h.aim = { x: 10, z: 0 };
    /** One shot, then long enough for the cooldown and the shot's ttl to run out. */
    const shotSpeed = (): number => {
      h.input.buttons.fire.down = true;
      h.step();
      const speed = h.world.projectiles.at(h.world.projectiles.size - 1).vx;
      h.input.buttons.fire.down = false;
      h.run(1);
      expect(h.world.projectiles.size).toBe(0);
      return speed;
    };

    expect(shotSpeed()).toBeCloseTo(40, 6); // the laser carbine's projectile

    // A sidearm equip leaves the barrel alone.
    h.save.equipped.sidearm = 'pistol_service';
    h.events.emit('gear:equipped', { slot: 'sidearm', itemId: 'pistol_service' });
    expect(shotSpeed()).toBeCloseTo(40, 6);

    // Moving the primary does change it.
    h.save.equipped.primary = 'weapon_kinetic';
    h.events.emit('gear:equipped', { slot: 'primary', itemId: 'weapon_kinetic' });
    expect(shotSpeed()).toBeCloseTo(22, 6);
  });

  // SPEC-028 §6.1: the barrel is whatever slot the loadout holds active.
  it('a save with the sidearm active fires the pistol\'s damage range and speed', () => {
    const h = harness({ patch: (s) => (s.activeWeapon = 'sidearm') });
    expect(h.combat.loadout.active).toBe('sidearm');
    h.input.buttons.fire.down = true;
    h.aim = { x: 10, z: 0 };
    h.step();
    const p = h.world.projectiles.at(0);
    expect(p.vx).toBeCloseTo(26, 5); // the Service Pistol's projectile speed
    // §4.2: ±10 % variance around damage 9 × the marine's damage multiplier.
    const mult = h.world.stats.damageMult;
    expect(p.damage).toBeGreaterThanOrEqual(Math.floor(9 * mult * 0.9));
    expect(p.damage).toBeLessThanOrEqual(Math.ceil(9 * mult * 1.1 * 1.5));
    expect(h.world.player.fireCooldown).toBeCloseTo(1 / 3, 6);
  });

  // SPEC-028 §4.2: a switch resets the per-shot cooldown; the 0.25 s switch
  // window is the gate that stops that from being a free rate-of-fire exploit.
  it('a switch resets fireCooldown', () => {
    const h = harness();
    h.input.buttons.fire.down = true;
    h.aim = { x: 10, z: 0 };
    h.step();
    expect(h.world.player.fireCooldown).toBeGreaterThan(0);
    h.combat.loadout.select('sidearm', h.world.time);
    expect(h.world.player.fireCooldown).toBe(0);
  });

  it('facing follows movement when not firing', () => {
    const h = harness();
    h.world.player.vx = 1;
    h.world.player.vz = 1;
    h.step();
    expect(h.world.player.facing).toBeCloseTo(Math.PI / 4, 6);
  });

  it('auto-fire targets the nearest enemy in weapon range', () => {
    const h = harness();
    h.spawn('hive_egg', 4, 0);
    h.spawn('hive_egg', 8, 0);
    h.spawn('hive_egg', 40, 0); // out of range
    h.input.autoFire = true;
    h.step();
    expect(h.world.projectiles.size).toBe(1);
    expect(h.world.projectiles.at(0).vx).toBeCloseTo(22, 5); // toward (4, 0)
  });

  it('does not fire when nothing is in range', () => {
    const h = harness();
    h.spawn('hive_egg', 40, 0);
    h.input.autoFire = true;
    h.run(0.5);
    expect(h.world.projectiles.size).toBe(0);
  });

  it('auto-aim prefers a target with a clear obstacle line (11-j)', () => {
    const h = harness({ obstacles: new CircleObstacles([{ x: 2, z: 0, radius: 1 }]) });
    h.spawn('hive_egg', 4, 0); // nearer, behind the rock
    h.spawn('hive_egg', 0, 6); // farther, clear
    h.input.autoFire = true;
    h.step();
    const p = h.world.projectiles.at(0);
    expect(p.vz).toBeCloseTo(22, 5); // aimed at the clear target
  });

  it('still fires at a blocked-only target; the shot hits the obstacle (11-j)', () => {
    const h = harness({ obstacles: new CircleObstacles([{ x: 2, z: 0, radius: 1 }]) });
    const egg = h.spawn('hive_egg', 4, 0);
    h.input.autoFire = true;
    h.run(1);
    expect(egg.hp).toBe(egg.maxHp); // every shot died on the rock
    expect(h.world.projectiles.size).toBe(0);
  });

  it('an aim-drag overrides auto-fire targeting', () => {
    const h = harness();
    h.spawn('hive_egg', 4, 0);
    h.input.autoFire = true;
    h.input.aim.dragging = true;
    h.aim = { x: -4, z: 0 };
    h.step();
    expect(h.world.projectiles.at(0).vx).toBeCloseTo(-22, 5);
  });
});

describe('projectiles (§4.4)', () => {
  it('sweeps: a 40 m/s shot cannot pass through a 0.4 m enemy at 60 Hz (11-c)', () => {
    const h = harness();
    const egg = h.spawn('dust_skitter', 3, 0);
    egg.aggro = false;
    h.shot({ x: 0, z: 0, vx: 40, damage: 5, ttl: 0.5 });
    h.run(0.2);
    expect(egg.hp).toBeLessThan(egg.maxHp);
  });

  it('a shot spawned inside an enemy hits on its first step (11-b)', () => {
    const h = harness();
    const egg = h.spawn('hive_egg', 2, 0);
    h.shot({ x: 2, z: 0, vx: 40, damage: 5, ttl: 0.5 });
    h.step();
    expect(egg.hp).toBe(egg.maxHp - 5);
  });

  it('pierce hits N+1 distinct enemies and never the same one twice', () => {
    const h = harness();
    const eggs = [h.spawn('hive_egg', 2, 0), h.spawn('hive_egg', 4, 0), h.spawn('hive_egg', 6, 0), h.spawn('hive_egg', 8, 0)];
    h.shot({ x: 0, z: 0, vx: 40, damage: 5, pierceLeft: 2, ttl: 1 });
    h.run(0.5);
    expect(eggs.map((e) => e.maxHp - e.hp)).toEqual([5, 5, 5, 0]); // 3 hits, then gone
    expect(h.world.projectiles.size).toBe(0);
  });

  it('despawns on ttl and on obstacle hit', () => {
    const h = harness({ obstacles: new CircleObstacles([{ x: 5, z: 5, radius: 1 }]) });
    h.shot({ x: 0, z: 0, vx: 22, ttl: 0.4 });
    h.shot({ x: 0, z: 5, vx: 22, ttl: 10 }); // flies into the rock
    h.run(0.45);
    expect(h.world.projectiles.size).toBe(0);
  });

  it('pools and reuses projectile objects', () => {
    const h = harness();
    h.shot({ x: 0, z: 0, vx: 22, ttl: 0.05 });
    const first = h.world.projectiles.at(0);
    h.run(0.2);
    expect(h.world.projectiles.size).toBe(0);
    const again = h.shot({ x: 0, z: 0, vx: 22, ttl: 0.05 });
    expect(again).toBe(first); // same object, recycled
  });

  it('applies knockback along the shot to normal enemies but not bosses or static', () => {
    const h = harness();
    const skitter = h.spawn('dust_skitter', 5, 0);
    const egg = h.spawn('hive_egg', 3, 5);
    const boss = h.spawn('dune_wurm', 8, -8);
    h.shot({ x: 4.5, z: 0, vx: 40, damage: 1, ttl: 0.1 });
    h.shot({ x: 3, z: 4.5, vz: 40, damage: 1, ttl: 0.1 });
    h.step();
    expect(skitter.x).toBeCloseTo(5.3, 3); // +0.3 along the shot (first step: no chase movement yet)
    expect(egg.x).toBeCloseTo(3, 6);
    expect(egg.z).toBeCloseTo(5, 6);
    expect(boss.hitFlash).toBe(0); // untouched entirely
  });
});

// ----------------------------------------------------------- body collision

describe('bodies (§4.4)', () => {
  it('resolves player–enemy overlap by pushing the player out', () => {
    const h = harness();
    const egg = h.spawn('hive_egg', 0.5, 0);
    h.step();
    expect(egg.x).toBe(0.5); // enemies are never pushed
    const d = Math.hypot(h.world.player.x - 0.5, h.world.player.z);
    expect(d).toBeGreaterThanOrEqual(egg.radius + 0.5 - 1e-6);
  });
});

// -------------------------------------------------------------- consumables

describe('consumables and healing (§4.8)', () => {
  it('heals instantly when overSeconds is 0 and emits player:healed', () => {
    const h = harness();
    h.combat.damagePlayer(100, { kind: 'fall' });
    h.combat.applyConsumable({ kind: 'heal', fraction: 0.5, overSeconds: 0 });
    expect(h.world.player.hp).toBe(84 + 92);
    expect(h.of('player:healed')).toEqual([{ amount: 92, hp: 176 }]);
  });

  it('heals fraction × maxHp over overSeconds', () => {
    const h = harness();
    h.combat.damagePlayer(100, { kind: 'fall' });
    h.combat.applyConsumable({ kind: 'heal', fraction: 0.3, overSeconds: 5 });
    h.run(1);
    expect(h.world.player.hp).toBeCloseTo(84 + 0.3 * 184 * (1 / 5), 3);
    h.run(5);
    expect(h.world.player.hp).toBeCloseTo(84 + 0.3 * 184, 3);
  });

  it('caps healing at maxHp', () => {
    const h = harness();
    h.combat.damagePlayer(5, { kind: 'fall' });
    h.combat.applyConsumable({ kind: 'heal', fraction: 0.5, overSeconds: 0 });
    expect(h.world.player.hp).toBe(184);
  });

  it('stacked damage boosts use the max of multipliers, not the product', () => {
    const h = harness();
    const base = h.world.stats.damageMult;
    h.combat.applyConsumable({ kind: 'damage_boost', mult: 1.4, seconds: 5 });
    h.combat.applyConsumable({ kind: 'damage_boost', mult: 1.2, seconds: 60 });
    expect(h.world.stats.damageMult).toBeCloseTo(base * 1.4, 10);
    h.run(5.1); // the 1.4 boost expires; the 1.2 remains
    expect(h.world.stats.damageMult).toBeCloseTo(base * 1.2, 10);
    h.run(60);
    expect(h.world.stats.damageMult).toBeCloseTo(base, 10);
  });

  it('field medic regenerates out of combat per its level table', () => {
    const h = harness({ patch: (s) => s.companions.push({ id: 'field_medic', level: 1, enabled: true }) });
    h.combat.damagePlayer(100, { kind: 'fall' });
    h.run(2);
    expect(h.world.player.hp).toBeCloseTo(84 + 0.01 * 184 * 2, 2);
  });

  it('level 1 medic stops in combat; level 3 adds regenInCombat always', () => {
    const l1 = harness({ patch: (s) => s.companions.push({ id: 'field_medic', level: 1, enabled: true }) });
    l1.combat.damagePlayer(100, { kind: 'fall' });
    l1.spawn('dust_skitter', 17, 0); // aggroes within 20 m → inCombat
    l1.run(1);
    expect(l1.combat.inCombat).toBe(true);
    expect(l1.world.player.hp).toBeCloseTo(84, 1); // no regen in combat at L1

    const l3 = harness({ patch: (s) => s.companions.push({ id: 'field_medic', level: 3, enabled: true }) });
    l3.combat.damagePlayer(100, { kind: 'fall' });
    l3.spawn('dust_skitter', 17, 0);
    l3.run(1);
    expect(l3.combat.inCombat).toBe(true);
    // L3: 0.005/s in combat (out-of-combat share stops once aggro is close).
    expect(l3.world.player.hp).toBeGreaterThan(84);
  });

  it('medic regen never exceeds maxHp', () => {
    const h = harness({ patch: (s) => s.companions.push({ id: 'field_medic', level: 3, enabled: true }) });
    h.run(3);
    expect(h.world.player.hp).toBe(184);
  });
});

// ------------------------------------------------------------------- drone

describe('combat drone (§4.3)', () => {
  it('fires at the nearest aggroed enemy within 12 m with the §4.3 damage', () => {
    const h = harness({ patch: (s) => s.companions.push({ id: 'combat_drone', level: 1, enabled: true }) });
    const egg = h.spawn('hive_egg', 6, 0);
    egg.aggro = true; // static enemies never aggro on their own
    h.step();
    expect(h.world.projectiles.size).toBe(1);
    const p = h.world.projectiles.at(0);
    expect(p.owner).toBe('drone');
    const stats = h.world.stats;
    expect(p.damage).toBe(Math.max(1, Math.round(12 * stats.damageMult * 0.5 * stats.companionMult)));
    // Every 1/droneFireRate seconds (L1: 1/s) — shots at t≈0 and t≈1 within 1.6 s.
    h.run(1.6);
    expect(h.of('enemy:spawned').length).toBe(1); // sanity: still just the egg
    // egg took two drone hits by now: spawn + one full cooldown
    expect(egg.maxHp - egg.hp).toBe(2 * p.damage);
  });

  it('ignores unaggroed enemies and ones beyond 12 m', () => {
    const h = harness({ patch: (s) => s.companions.push({ id: 'combat_drone', level: 1, enabled: true }) });
    h.spawn('hive_egg', 6, 0); // never aggroed
    const far = h.spawn('hive_egg', 20, 0);
    far.aggro = true;
    h.run(1);
    expect(h.world.projectiles.size).toBe(0);
  });

  // SPEC-028 §4.2: the drone is wired to the primary slot, not the hand.
  it('keeps the primary\'s damage while the sidearm is in hand', () => {
    const h = harness({
      patch: (s) => {
        s.companions.push({ id: 'combat_drone', level: 1, enabled: true });
        s.activeWeapon = 'sidearm';
      },
    });
    const egg = h.spawn('hive_egg', 6, 0);
    egg.aggro = true;
    h.step();
    const p = h.world.projectiles.at(0);
    expect(p.owner).toBe('drone');
    const stats = h.world.stats;
    // 12 is the Kinetic Repeater's damage — not the pistol's 9.
    expect(p.damage).toBe(Math.max(1, Math.round(12 * stats.damageMult * 0.5 * stats.companionMult)));
    expect(p.vx).toBeCloseTo(22, 5); // …and the repeater's projectile speed
  });
});

// ------------------------------------------------------------ kills & loot

describe('kills, elites and loot (§4.6, §4.7)', () => {
  it('kills emit enemy:killed and grant XP through progression', () => {
    const h = harness();
    const e = h.spawn('dust_skitter', 5, 5);
    h.combat.killEnemy(e, 'player');
    expect(h.of('enemy:killed')).toEqual([{ enemyId: 'dust_skitter', elite: false, x: 5, z: 5, xp: 4 }]);
    expect(h.save.player.xp).toBe(4);
    h.step();
    expect(h.world.enemies.size).toBe(0); // swept from the pool
  });

  it('elites carry ×3 HP, ×1.3 scale, ×1.1 speed, ×3 XP and ×1.5 hit damage', () => {
    const h = harness();
    const elite = h.spawn('dust_skitter', 5, 0, true);
    expect(elite.maxHp).toBe(18 * 3);
    expect(elite.radius).toBeCloseTo(0.4 * 1.3, 10);
    expect(elite.speed).toBeCloseTo(6.5 * 1.1, 10);
    expect(enemyHitDamage(elite, flatStats(), 'normal')).toBe(6);
    h.combat.killEnemy(elite, 'player');
    expect(h.of('enemy:killed')[0]?.xp).toBe(12);
  });

  it('never spawns an elite of a disallowed def', () => {
    const h = harness();
    expect(h.spawn('dune_wurm', 5, 0, true).elite).toBe(false);
    expect(rollElite(harness().spawn('dune_wurm', 0, 0).def, 1, new Rng(1))).toBe(false);
  });

  it('rollElite follows the planet chance', () => {
    const h = harness();
    const def = h.spawn('dust_skitter', 5, 0).def;
    const rng = new Rng(99);
    let elites = 0;
    for (let i = 0; i < 2000; i++) if (rollElite(def, 0.05, rng)) elites++;
    expect(elites).toBeGreaterThan(60);
    expect(elites).toBeLessThan(140);
  });

  it('elites roll elite_bonus on top, chapter-capped; owned gear still drops (11-h)', () => {
    const h = harness({ patch: (s) => (s.equipped.primary = 'weapon_laser') });
    for (let i = 0; i < 300; i++) {
      h.combat.killEnemy(h.spawn('dust_skitter', 5, 5, true), 'player');
      h.step();
    }
    const gear = h.combat.drops.filter((d) => d.kind === 'gear');
    expect(gear.length).toBeGreaterThan(0);
    for (const drop of gear) {
      // Chapter 1 caps elite_bonus tier 3 at tier 1 (§4.4 cap min(3, ceil(ch/2))).
      expect(['weapon_laser', 'armor_composite']).toContain(drop.itemId);
    }
    // The equipped weapon_laser is among them: duplicates spawn anyway.
    expect(gear.some((d) => d.itemId === 'weapon_laser')).toBe(true);
  });

  it('scatters loot orbs 0.5–1.5 m from the kill in units of 1–3', () => {
    const h = harness();
    for (let i = 0; i < 200; i++) h.combat.killEnemy(h.spawn('dust_skitter', 5, 5), 'player');
    const orbs = h.combat.drops.filter((d) => d.kind === 'resource');
    expect(orbs.length).toBeGreaterThan(0);
    for (const orb of orbs) {
      expect(orb.amount).toBeGreaterThanOrEqual(1);
      expect(orb.amount).toBeLessThanOrEqual(3);
      const d = Math.hypot(orb.x - 5, orb.z - 5);
      expect(d).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(d).toBeLessThanOrEqual(1.5 + 1e-9);
    }
  });

  it('rolls loot from the loot stream only: the layout stream is unchanged after 100 kills', () => {
    const root = new RngRoot(42);
    const layout = root.layout('cinder4');
    const before = Array.from({ length: 10 }, () => layout.next());

    const killer = harness({ seed: 5 });
    const idle = harness({ seed: 5 });
    for (let i = 0; i < 100; i++) killer.combat.killEnemy(killer.spawn('dust_skitter', 5, 5), 'player');

    const layoutAgain = root.layout('cinder4');
    const after = Array.from({ length: 10 }, () => layoutAgain.next());
    expect(after).toEqual(before);
    // The kills consumed only the loot stream: ai and combat streams still align
    // with the untouched twin, the loot stream does not.
    expect(killer.rng.ai.next()).toBe(idle.rng.ai.next());
    expect(killer.rng.combat.next()).toBe(idle.rng.combat.next());
    expect(killer.rng.loot.next()).not.toBe(idle.rng.loot.next());
  });

  it('boss death emits boss:defeated and unlocks the arena', () => {
    const h = harness({ arena: { x: 0, z: 0, radius: 24, locked: true } });
    const boss = h.spawn('dune_wurm', 10, 0);
    h.combat.killEnemy(boss, 'player');
    expect(h.of('boss:defeated')).toEqual([{ boss: 'dune_wurm' }]);
    expect(h.world.arena?.locked).toBe(false);
  });

  // SPEC-025 §4.2: tiers are unique per line, so the lookup is by line — the
  // rifle ladder and the handgun ladder both have a tier 0.
  it('gearAt resolves the unique item of a line per tier', () => {
    expect(gearAt('rifle', 0)).toBe('weapon_kinetic');
    expect(gearAt('rifle', 1)).toBe('weapon_laser');
    expect(gearAt('handgun', 0)).toBe('pistol_service');
    expect(gearAt('armor', 3)).toBe('armor_ablative');
  });
});

// ---------------------------------------------------------------- inCombat

describe('inCombat signal (§2)', () => {
  it('is true while an aggroed enemy is within 20 m and for 4 s after', () => {
    const h = harness();
    expect(h.combat.inCombat).toBe(false);
    const skitter = h.spawn('dust_skitter', 10, 0);
    h.step();
    expect(h.combat.inCombat).toBe(true);
    h.combat.killEnemy(skitter, 'player');
    h.run(3.8);
    expect(h.combat.inCombat).toBe(true);
    h.run(0.4);
    expect(h.combat.inCombat).toBe(false);
  });

  it('an unaggroed enemy nearby does not raise it', () => {
    const h = harness();
    h.spawn('hive_egg', 5, 0);
    h.run(0.5);
    expect(h.combat.inCombat).toBe(false);
  });
});

// ---------------------------------------------------------------- follower

describe('follower (§4.9)', () => {
  it('trails the player at followDistance and dies to follower:died', () => {
    const h = harness({ follower: true });
    const f = h.world.follower;
    expect(f).not.toBeNull();
    if (f === null) return;
    h.world.player.x = 12;
    h.run(4);
    const d = Math.hypot(f.x - 12, f.z);
    expect(d).toBeCloseTo(f.def.followDistance, 1);
    h.shot({ x: f.x - 2, z: f.z, vx: 40, owner: 'enemy', damage: 500, enemyId: 'scav_raider', ttl: 1 });
    h.run(0.2);
    expect(f.alive).toBe(false);
    expect(h.of('follower:died')).toEqual([{ follower: 'science_probe' }]);
  });
});

// ------------------------------------------------------ SPEC-029: blasts

/** `explode` and mine triggers read the step's hash — build it, then repin. */
function hashStep(h: ReturnType<typeof harness>, pin: Array<[{ x: number; z: number }, number, number]>): void {
  h.step();
  for (const [e, x, z] of pin) {
    e.x = x;
    e.z = z;
  }
}

const FRAG = ITEMS.frag_grenade.effect as Extract<(typeof ITEMS.frag_grenade)['effect'], { kind: 'explosive' }>;
const MINE = ITEMS.landmine.effect as Extract<(typeof ITEMS.landmine)['effect'], { kind: 'explosive' }>;
const CHARGE = ITEMS.demo_charge.effect as Extract<(typeof ITEMS.demo_charge)['effect'], { kind: 'explosive' }>;

describe('Combat.explode (SPEC-029 §4.5)', () => {
  it('applies the falloff formula at the centre, halfway and the rim, counting the body radius', () => {
    const h = harness();
    const centre = h.spawn('dust_skitter', 0.1, 0);
    const halfway = h.spawn('dust_skitter', 2.4, 0); // d = 2.4 − 0.4 = radius/2
    const rim = h.spawn('dust_skitter', 4.4, 0); // d = 4.0 = radius exactly
    const beyond = h.spawn('dust_skitter', 0, 4.5); // d = 4.1 > radius
    hashStep(h, [[centre, 0.1, 0], [halfway, 2.4, 0], [rim, 4.4, 0], [beyond, 0, 4.5]]);
    const mult = h.world.stats.damageMult;

    const hit = h.combat.explode(0, 0, 4, 10, 0.4);
    expect(hit).toBe(3);
    // k = 1 − (1 − falloff) · d / radius; damage = max(1, round(10 · mult · k)).
    expect(centre.maxHp - centre.hp).toBe(Math.max(1, Math.round(10 * mult * 1)));
    expect(halfway.maxHp - halfway.hp).toBe(Math.max(1, Math.round(10 * mult * 0.7)));
    expect(rim.maxHp - rim.hp).toBe(Math.max(1, Math.round(10 * mult * 0.4)));
    expect(beyond.hp).toBe(beyond.maxHp);
    expect(h.of('combat:blast')).toEqual([{ x: 0, z: 0, radius: 4 }]);
  });

  it('knocks enemies 1.2 m outward — but never bosses or statics — and spreads aggro', () => {
    const h = harness();
    const skitter = h.spawn('dust_skitter', 2, 0);
    const packmate = h.spawn('dust_skitter', 2, 6); // unhit, same species within 8 m
    const boss = h.spawn('dune_wurm', 0, 3);
    const egg = h.spawn('hive_egg', -3, 0);
    hashStep(h, [[skitter, 2, 0], [packmate, 2, 6], [boss, 0, 3], [egg, -3, 0]]);

    h.combat.explode(0, 0, 5, 10, 0.5);
    expect(skitter.x).toBeCloseTo(2 + BLAST_KNOCKBACK, 5);
    expect(boss.x).toBeCloseTo(0, 5);
    expect(boss.z).toBeCloseTo(3, 5);
    expect(egg.x).toBeCloseTo(-3, 5);
    // The egg takes blast damage all the same (29-i).
    expect(egg.hp).toBeLessThan(egg.maxHp);
    // §4.5: blast damage aggroes like any hit, same species within 8 m too.
    expect(skitter.aggro).toBe(true);
    expect(packmate.aggro).toBe(true);
  });

  it('kills through killEnemy, and never touches the player or the follower (E42)', () => {
    const h = harness({ follower: true });
    const f = h.world.follower;
    if (f === null) return;
    f.x = 1;
    f.z = 0;
    const skitter = h.spawn('dust_skitter', 0.5, 0.5);
    hashStep(h, [[skitter, 0.5, 0.5]]);
    const hpBefore = h.world.player.hp;

    const hit = h.combat.explode(0, 0, 4, 200, 0.5);
    expect(hit).toBe(1);
    expect(skitter.state).toBe('dead');
    expect(h.of('enemy:killed')).toHaveLength(1);
    expect(h.world.player.hp).toBe(hpBefore);
    expect(f.alive).toBe(true);
    expect(f.hp).toBe(f.def.hp);
  });

  it('ignores the invulnerable and the burrowed (29-b, 29-c)', () => {
    const h = harness();
    const shielded = h.spawn('dust_skitter', 1, 0);
    const burrowed = h.spawn('dust_skitter', -1, 0);
    hashStep(h, [[shielded, 1, 0], [burrowed, -1, 0]]);
    shielded.invulnerable = true;
    burrowed.specialKind = 'burrow_dig';

    expect(h.combat.explode(0, 0, 4, 100, 0.5)).toBe(0);
    expect(shielded.hp).toBe(shielded.maxHp);
    expect(burrowed.hp).toBe(burrowed.maxHp);
  });
});

// ------------------------------------------------- SPEC-029: rockets & lobs

describe('rockets and lobs (SPEC-029 §4.6)', () => {
  it('a rocket explodes at the first enemy it touches, pierce ignored', () => {
    const h = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_rocket') });
    h.combat.loadout.select('heavy', h.world.time);
    h.run(0.3); // past the switch
    const near = h.spawn('hive_egg', 5, 0); // static: it stays put
    const far = h.spawn('hive_egg', 9.5, 0);
    h.aim = { x: 10, z: 0 };
    h.input.buttons.fire.down = true;
    h.step();
    h.input.buttons.fire.down = false;
    h.run(1.5);
    expect(h.of('combat:blast')).toHaveLength(1);
    const blast = h.of('combat:blast')[0] as { x: number; radius: number };
    expect(blast.radius).toBe(3.5);
    expect(blast.x).toBeLessThan(5); // at the first body, not beyond it
    expect(near.hp).toBeLessThan(near.maxHp); // pierce ignored: one blast, no punch-through
    expect(far.hp).toBe(far.maxHp); // 9.5 − 0.8 sits outside the 3.5 m radius
  });

  it('a rocket explodes at an obstacle truncation (29-a) and at the end of its range', () => {
    const wall = new CircleObstacles([{ x: 6, z: 0, radius: 1 }]);
    const h = harness({ obstacles: wall, patch: (s) => void (s.equipped.heavy = 'launcher_rocket') });
    h.combat.loadout.select('heavy', h.world.time);
    h.run(0.3);
    h.aim = { x: 20, z: 0 };
    h.input.buttons.fire.down = true;
    h.run(0.5);
    const atWall = h.of('combat:blast')[0] as { x: number };
    expect(atWall.x).toBeCloseTo(5, 0); // the wall's near edge
    expect(h.world.player.hp).toBe(h.world.stats.maxHp); // 29-a: the player takes nothing

    // Range end: open ground, 22 m of range at 20 m/s.
    const open = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_rocket') });
    open.combat.loadout.select('heavy', open.world.time);
    open.run(0.3);
    open.aim = { x: 30, z: 0 };
    open.input.buttons.fire.down = true;
    open.run(1.5);
    const atRange = open.of('combat:blast')[0] as { x: number };
    expect(atRange.x).toBeCloseTo(0.6 + 22, 0); // muzzle + range
  });

  it('a grenade-launcher shell passes over bodies and explodes at the aim point', () => {
    const h = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_grenade') });
    h.combat.loadout.select('heavy', h.world.time);
    h.run(0.3);
    const blocker = h.spawn('hive_egg', 3, 0); // static, directly under the arc
    h.aim = { x: 10, z: 0 };
    h.input.buttons.fire.down = true;
    // One shot only, or the burst keeps firing.
    h.step();
    h.input.buttons.fire.down = false;
    h.run(1.2);
    const blasts = h.of('combat:blast');
    expect(blasts).toHaveLength(1);
    expect((blasts[0] as { x: number }).x).toBeCloseTo(10, 5);
    expect((blasts[0] as { radius: number }).radius).toBe(3);
    // The body under the arc was never hit in flight; only the blast reaches
    // it — and at 7 m from the target it is out of the 3 m radius entirely.
    expect(blocker.hp).toBe(blocker.maxHp);
  });

  it('a thrown grenade is a 14 m/s lob that explodes at its target', () => {
    const h = harness();
    const blocker = h.spawn('hive_egg', 4, 0); // static, directly on the path
    h.combat.throwExplosive(FRAG, 6, 0);
    expect(h.world.projectiles.size).toBe(1);
    const p = h.world.projectiles.at(0);
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(14, 5);
    expect(p.lob).toBe(true);
    h.run(1);
    const blasts = h.of('combat:blast');
    expect(blasts).toHaveLength(1);
    expect(blasts[0]).toEqual({ x: 6, z: 0, radius: FRAG.radius });
    // Passed over in flight; only the blast reaches it — d = 2 − 0.8 = 1.2.
    const expected = Math.max(1, Math.round(FRAG.damage * h.world.stats.damageMult * (1 - EXPLOSIVE_FALLOFF * (1.2 / FRAG.radius))));
    expect(blocker.maxHp - blocker.hp).toBe(expected);
  });

  it('spread turns the shot within ±spread on the combat stream, deterministically', () => {
    const fire = (seed: number): { vx: number; vz: number } => {
      const h = harness({ seed, patch: (s) => void (s.equipped.primary = 'mg_scrap') });
      h.aim = { x: 10, z: 0 };
      h.input.buttons.fire.down = true;
      h.step();
      expect(h.world.projectiles.size).toBe(1);
      const p = h.world.projectiles.at(0);
      return { vx: p.vx, vz: p.vz };
    };
    const a = fire(77);
    const b = fire(77);
    expect(a).toEqual(b); // same seed, same turn
    const speed = Math.hypot(a.vx, a.vz);
    expect(speed).toBeCloseTo(30, 5);
    const angle = Math.atan2(a.vz, a.vx);
    expect(Math.abs(angle)).toBeLessThanOrEqual(0.08 + 1e-9);
    expect(angle).not.toBe(0); // the turn actually happened for this seed
    const c = fire(78);
    expect(Math.atan2(c.vz, c.vx)).not.toBeCloseTo(angle, 10);
  });
});

// ------------------------------------------------- SPEC-029: deployables

describe('deployables (SPEC-029 §4.7)', () => {
  it('a mine arms 1 s after placement, emitting mine:armed', () => {
    const h = harness();
    expect(h.combat.deploy(MINE, 2, 0)).toBe('ok');
    const mine = h.combat.deployables.at(0);
    h.run(0.9);
    expect(mine.armed).toBe(false);
    expect(h.of('mine:armed')).toHaveLength(0);
    h.run(0.2);
    expect(mine.armed).toBe(true);
    expect(h.of('mine:armed')).toEqual([{ x: 2, z: 0 }]);
  });

  it('an armed mine explodes on a non-static enemy within its trigger; an egg never sets it off (29-i)', () => {
    const h = harness();
    expect(h.combat.deploy(MINE, 10, 0)).toBe('ok');
    const egg = h.spawn('hive_egg', 10.5, 0);
    h.run(2);
    expect(h.of('combat:blast')).toHaveLength(0); // armed, but the static did not trip it
    expect(egg.hp).toBe(egg.maxHp);

    const skitter = h.spawn('dust_skitter', 11, 0.5);
    h.run(1);
    expect(h.of('combat:blast')).toHaveLength(1);
    expect(h.combat.deployables.size).toBe(0); // freed after the burst
    expect(skitter.state).toBe('dead');
  });

  it('a charge explodes when its fuse ends, player death or not (29-j)', () => {
    const h = harness();
    expect(h.combat.deploy(CHARGE, 1, 1)).toBe('ok');
    h.combat.damagePlayer(10_000, { kind: 'fall' });
    expect(h.world.player.alive).toBe(false);
    expect(h.combat.deployables.size).toBe(1); // deployables outlive the player
    h.run(3.1);
    const blasts = h.of('combat:blast');
    expect(blasts).toEqual([{ x: 1, z: 1, radius: CHARGE.radius }]);
    expect(h.combat.deployables.size).toBe(0);
  });

  it('refuses a seventh mine with mine_limit and a ninth deployable with full', () => {
    const h = harness();
    for (let i = 0; i < MAX_ARMED_MINES; i++) {
      expect(h.combat.deploy(MINE, i * 5, 40)).toBe('ok');
    }
    expect(h.combat.deploy(MINE, 40, 40)).toBe('mine_limit');
    expect(h.combat.deployables.size).toBe(MAX_ARMED_MINES);
    // Charges still fit — until the pool of 8 is full.
    expect(h.combat.deploy(CHARGE, 50, 50)).toBe('ok');
    expect(h.combat.deploy(CHARGE, 55, 55)).toBe('ok');
    expect(h.combat.deployables.size).toBe(DEPLOYABLE_CAPACITY);
    expect(h.combat.deploy(CHARGE, 60, 60)).toBe('full');
  });

  it('blasts land with EXPLOSIVE_FALLOFF and the effect values', () => {
    const h = harness();
    expect(EXPLOSIVE_FALLOFF).toBe(0.5);
    const egg = h.spawn('hive_egg', 10.5, 0);
    hashStep(h, [[egg, 10.5, 0]]);
    // d = 0.5 − 0.8 → 0: the full max(1, round(80 · mult)) of the mine.
    expect(h.combat.explode(10, 0, MINE.radius, MINE.damage, EXPLOSIVE_FALLOFF)).toBe(1);
    expect(egg.maxHp - egg.hp).toBe(Math.max(1, Math.round(MINE.damage * h.world.stats.damageMult)));
  });
});
