// systems/Combat (SPEC-011 §6): the pinned stat derivation, the §4.2 damage
// formulas, i-frames and weather, firing and auto-aim, swept projectiles,
// consumables and the medic, kills, loot streams and the inCombat signal.
import { describe, expect, it } from 'vitest';
import { Rng, RngRoot } from '@/core/Rng';
import { maxHp, type Save } from '@/core/Save';
import {
  AFFIX_IDS,
  AFFIXES,
  BULWARK_DAMAGE_MULT,
  DRONE_SHOT,
  ENEMIES,
  FLARE_SHOT,
  ITEMS,
  MENDER_HEAL_FRACTION,
  MENDER_PULSE_SECONDS,
  SIGNATURE_FALLBACK_LITHIUM,
  SWIFT_SPEED_MULT,
  SWIFT_WINDUP_SCALE,
  THROWN_SHOT,
  TUNING,
  VOLATILE_DAMAGE_MULT,
  VOLLEY_SPEED_MULT,
  type AffixId,
  type EnemyId,
  type ItemId,
} from '@/data/index';
import { ARENA_SEAL_INSET, CircleObstacles, type ArenaState } from '@/entities/World';
import {
  BASE_CRIT_CHANCE,
  BLAST_KNOCKBACK,
  computePlayerStats,
  DAMAGE_PER_LEVEL,
  damageReduction,
  ELITE_XP_MULT,
  KILL_XP_GROWTH,
  killXp,
  enemyHitDamage,
  EXPLOSIVE_FALLOFF,
  gearAt,
  MEDIC_WEATHER_PAUSE,
  playerDamageMult,
  rollAffixes,
  rollElite,
  rollPlayerDamage,
  ELITE_SPEED_MULT,
  type PlayerStats,
  type WeaponDef,
  AUTO_LEAD_MAX,
  CASUAL_WEATHER_MULT,
  CASUAL_WINDUP_MULT,
  MAX_FLARES,
  MAX_LINGER_CLOUDS,
  staminaFull,
  THROW_SPEED,
  twistOf,
} from '@/systems/Combat';
import { DEPLOYABLE_CAPACITY, MAX_ARMED_MINES } from '@/entities/Deployable';
import { affixCount } from '@/entities/Enemy';
import { resetTelegraph } from '@/entities/Telegraph';
import { DARK_SIGHT, FLARE_RADIUS, inFlare } from '@/systems/Light';
import { cumulativeXp } from '@/systems/Progression';
import { SPRINT_DRAW_SECONDS, STAMINA_MAX, stepStamina } from '@/systems/Stamina';
import { SWITCH_SECONDS, type SlotView } from '@/systems/Loadout';
import { STEP, harness, MARINE, SCOUT, type Harness } from './combatFixtures';

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

  it('crit chance is 5 % + 2 % per agility point', () => {
    expect(harness({ creation: MARINE }).world.stats.critChance).toBeCloseTo(0.07, 10);
    expect(harness({ creation: SCOUT }).world.stats.critChance).toBeCloseTo(0.13, 10);
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
    // SPEC-039 §4.3: the radius is a companion effect, scaled by the marine's
    // companionMult of 1 × (1 + 0.10 × 1 tech) = 1.1.
    expect(h.world.stats.pickupRadius).toBeCloseTo(TUNING.PICKUP_RADIUS + 6 * 1.1, 10);
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
    expect(h.world.player.fireCooldown).toBeCloseTo(1 / 3 - 1 / 60, 6);
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
    expect(h.world.player.fireCooldown).toBeCloseTo(1 / 3 - 1 / 60, 6);
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
    // SPEC-039 §4.3: the rate is scaled by the marine's companionMult of 1.1.
    expect(h.world.player.hp).toBeCloseTo(84 + 0.01 * 1.1 * 184 * 2, 2);
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
    // SPEC-038 §4.4: the skitter's base HP is 26 now.
    expect(elite.maxHp).toBe(26 * 3);
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

  // SPEC-039 §4.1 replaced this case's rifle and armour rows (and their
  // chapter cap) with lithium and explosives: an elite still rolls
  // `elite_bonus` on top of its own table, and it never hands out a tier.
  it('elites roll elite_bonus on top: 6–12 lithium over 200 seeded kills, never a rifle or armour', () => {
    const h = harness({ seed: 39 });
    const lithium: number[] = [];
    for (let i = 0; i < 200; i++) {
      h.combat.drops.length = 0;
      h.combat.killEnemy(h.spawn('dust_skitter', 5, 5, true), 'player');
      h.step();
      let total = 0;
      for (const drop of h.combat.drops) {
        expect(drop.kind).not.toBe('gear');
        // The skitter's own table carries no item row: every item is the bonus's.
        if (drop.kind === 'item') expect(['frag_grenade', 'landmine', 'plasma_cell']).toContain(drop.itemId);
        if (drop.kind === 'resource' && drop.resource === 'lithium') total += drop.amount;
      }
      lithium.push(total);
    }
    // The bonus row pays 6–12 every time; the skitter's own table can add a
    // 1–2 trace on top at 5 % (SPEC-009 §4.4's lithium-everywhere rule).
    for (const total of lithium) {
      expect(total).toBeGreaterThanOrEqual(6);
      expect(total).toBeLessThanOrEqual(12 + 2);
    }
    expect(Math.min(...lithium)).toBe(6);
    expect(lithium.filter((total) => total <= 12).length).toBeGreaterThan(180);
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
    const h = harness({ arena: { x: 0, z: 0, radius: 24, locked: true, sealed: false } });
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

// -------------------------------------------------- kill XP by chapter

describe('kill XP by chapter (SPEC-066 §4.4)', () => {
  it('grows ×1.15 a chapter for a swarm, rusher, ranged and static enemy', () => {
    expect(KILL_XP_GROWTH).toBe(1.15);
    const byChapter = (id: EnemyId): number[] => [1, 2, 3, 4, 5, 6].map((c) => killXp(ENEMIES[id], c));
    expect(byChapter('dust_skitter')).toEqual([4, 5, 5, 6, 7, 8]);
    expect(byChapter('wurmling')).toEqual([8, 9, 11, 12, 14, 16]);
    expect(byChapter('scav_raider')).toEqual([10, 12, 13, 15, 17, 20]);
    expect(byChapter('hive_egg')).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it('a boss pays its def.xp at every chapter', () => {
    for (const boss of ['dune_wurm', 'frost_matriarch', 'hive_broodlord', 'ash_titan', 'hive_queen'] as const) {
      for (let c = 1; c <= 6; c++) expect(killXp(ENEMIES[boss], c)).toBe(ENEMIES[boss].xp);
    }
  });

  it('on the Hive (chapter 5) a drone pays 7, a warrior 14, a spitter 17 and an egg 9', () => {
    const h = harness();
    h.world.planetChapter = 5;
    for (const id of ['hive_drone', 'hive_warrior', 'hive_spitter', 'hive_egg'] as const) {
      h.combat.killEnemy(h.spawn(id, 5, 0), 'player');
    }
    expect(h.of('enemy:killed').map((k) => k.xp)).toEqual([7, 14, 17, 9]);
    expect(h.save.player.xp).toBe(7 + 14 + 17 + 9);
  });

  it('66-h: on Eden (chapter 6) a drone pays 8, a warrior 16, a spitter 20', () => {
    const h = harness();
    h.world.planetChapter = 6;
    for (const id of ['hive_drone', 'hive_warrior', 'hive_spitter'] as const) {
      h.combat.killEnemy(h.spawn(id, 5, 0), 'player');
    }
    expect(h.of('enemy:killed').map((k) => k.xp)).toEqual([8, 16, 20]);
  });

  it('66-g: an elite drone pays killXp × (3 + affixes), and a replay halves it after', () => {
    const h = harness();
    h.world.planetChapter = 5;
    const elite = h.combat.spawnEnemy('hive_drone', 5, 0, true, 'swift', 'mender');
    expect(affixCount(elite)).toBe(2);
    h.combat.killEnemy(elite, 'player');
    const replayed = h.combat.spawnEnemy('hive_drone', 5, 0, true, 'swift');
    replayed.replay = true;
    h.combat.killEnemy(replayed, 'player');
    expect(h.of('enemy:killed').map((k) => k.xp)).toEqual([7 * 5, Math.floor(7 * 4 * TUNING.REPLAY_REWARD_FRACTION)]);
  });

  it('an absent planetChapter pays def.xp, and a boss pays def.xp on any planet', () => {
    const h = harness();
    expect(h.world.planetChapter).toBeUndefined();
    h.combat.killEnemy(h.spawn('hive_drone', 5, 0), 'player');
    h.combat.killEnemy(h.spawn('hive_spitter', 5, 0), 'player');
    h.world.planetChapter = 5;
    h.combat.killEnemy(h.spawn('hive_queen', 10, 0), 'player');
    expect(h.of('enemy:killed').map((k) => k.xp)).toEqual([
      ENEMIES.hive_drone.xp,
      ENEMIES.hive_spitter.xp,
      ENEMIES.hive_queen.xp,
    ]);
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

// ---------------------------------------------- SPEC-030 §4.7: the bounds

describe('SPEC-030 — world bounds (AC-30..AC-32)', () => {
  it('enemy movement clamps x and z to ±bounds', () => {
    const h = harness();
    h.world.bounds = 10;
    const e = h.spawn('dust_skitter', 9.5, 9.5);
    e.aggro = true;
    e.state = 'chase';
    h.world.player.x = 30; // drags the chase toward the far corner…
    h.world.player.z = 30;
    h.run(2);
    expect(e.x).toBeLessThanOrEqual(10 + 1e-9); // …and the wall stops it
    expect(e.z).toBeLessThanOrEqual(10 + 1e-9);
  });

  it("the follower's step clamps to ±bounds like the player's", () => {
    const h = harness({ follower: true });
    h.world.bounds = 10;
    h.world.player.x = 30; // teleported past the wall by the harness
    h.run(5);
    const f = h.world.follower;
    expect(f).not.toBeNull();
    expect(f?.x).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('a projectile crossing |x| = bounds + 0.6 truncates there and despawns (AC-31)', () => {
    const h = harness();
    h.world.bounds = 10;
    // A static target past the wall: the shot must die at the line, not reach it.
    const egg = h.spawn('hive_egg', 14, 0);
    const before = egg.hp;
    h.shot({ x: 8, z: 0, vx: 60, vz: 0, ttl: 1, damage: 50 });
    h.run(0.5);
    expect(egg.hp).toBe(before);
    expect(h.world.projectiles.size).toBe(0);
  });

  it('a blast projectile explodes at the wall line (AC-31, E45)', () => {
    const h = harness();
    h.world.bounds = 10;
    h.shot({ x: 8, z: 0, vx: 60, vz: 0, ttl: 1, damage: 20, blastRadius: 3, blastFalloff: 0.5 });
    h.run(0.2);
    const blasts = h.of('combat:blast');
    expect(blasts).toHaveLength(1);
    expect(blasts[0]?.x).toBeCloseTo(10.6, 3);
    expect(blasts[0]?.z).toBeCloseTo(0, 6);
  });

  it('with bounds absent nothing clamps and no projectile truncates (AC-32, D-13)', () => {
    const h = harness();
    expect(h.world.bounds).toBeUndefined();
    const e = h.spawn('dust_skitter', 200, 0);
    e.aggro = true;
    e.state = 'chase';
    h.world.player.x = 300;
    h.run(1);
    expect(e.x).toBeGreaterThan(100); // nothing pulled it to a wall
    const shot = h.shot({ x: 195, z: 195, vx: 60, vz: 0, ttl: 0.5 });
    h.step();
    expect(shot.x).toBeCloseTo(196, 5); // flew on, no truncation at any edge
    expect(h.world.projectiles.size).toBe(1);
  });
});

// ---------------------------------------------------------------- SPEC-034

/**
 * SPEC-034 §4.1, §6.1 — the review's `stuck.test.ts`, turned into a regression.
 *
 * A raider shot knocks a player standing 0.2 m from a rock into it. Before this
 * spec they stayed in it: `#movePlayer` refuses every step that *ends* inside an
 * obstacle, so with the body already overlapping, every direction was refused
 * and the run was over. The knockback now runs through `resolveCircle`, and one
 * second of input away from the rock moves them at least a metre.
 */
describe('a knockback never leaves a body inside an obstacle (SPEC-034 §4.1)', () => {
  /** The surface's own axis slide (SPEC-012 §4.3), with §4.1's pre-step resolve. */
  function slide(h: ReturnType<typeof harness>, dirX: number, dirZ: number, seconds: number): void {
    const p = h.world.player;
    const out = { x: 0, z: 0 };
    const steps = Math.round(seconds / STEP);
    for (let i = 0; i < steps; i++) {
      if (h.world.obstacles.resolveCircle(p.x, p.z, p.radius, out)) {
        p.x = out.x;
        p.z = out.z;
      }
      const nx = p.x + dirX * h.world.stats.moveSpeed * STEP;
      const nz = p.z + dirZ * h.world.stats.moveSpeed * STEP;
      if (!h.world.obstacles.hitsCircle(nx, p.z, p.radius)) p.x = nx;
      if (!h.world.obstacles.hitsCircle(p.x, nz, p.radius)) p.z = nz;
    }
  }

  it('a shot that shoves the player at a rock leaves them outside it, and they can walk away', () => {
    // A 1.5 m rock at x = 2; the player stands 0.2 m clear of its edge.
    const h = harness({ obstacles: new CircleObstacles([{ x: 2, z: 0, radius: 1.5 }]) });
    const p = h.world.player;
    const raider = h.spawn('scav_raider', -4, 0);
    p.x = 2 - 1.5 - p.radius - 0.2;
    p.z = 0;
    const startX = p.x;
    // The raider's shot, travelling +x straight into the rock behind the player.
    h.shot({ x: p.x - 0.2, z: 0, vx: 40, vz: 0, owner: 'enemy', enemyId: raider.def.id, damage: 5, ttl: 1 });
    h.step();
    expect(h.of('player:damaged')).toHaveLength(1);
    // §4.1: knocked back, but not into the rock.
    expect(p.x).toBeGreaterThan(startX);
    expect(h.world.obstacles.hitsCircle(p.x, p.z, p.radius)).toBe(false);

    // …and one second of walking away covers ground.
    const shovedX = p.x;
    slide(h, -1, 0, 1);
    expect(shovedX - p.x).toBeGreaterThanOrEqual(1);
  });

  it('a player already inside a rock resolves out and moves on the next step', () => {
    const h = harness({ obstacles: new CircleObstacles([{ x: 0, z: 0, radius: 2 }]) });
    const p = h.world.player;
    p.x = 1.2; // well inside
    p.z = 0;
    slide(h, 1, 0, 1);
    expect(h.world.obstacles.hitsCircle(p.x, p.z, p.radius)).toBe(false);
    expect(p.x).toBeGreaterThan(2 + p.radius);
  });

  it('a projectile knockback resolves the enemy out of a rock too', () => {
    const h = harness({ obstacles: new CircleObstacles([{ x: 4, z: 0, radius: 2 }]) });
    // Standing just clear of the rock's near edge, shot straight into it.
    const e = h.spawn('dust_skitter', 4 - 2 - 0.4, 0);
    h.shot({ x: e.x - 0.5, z: 0, vx: 50, vz: 0, damage: 1, ttl: 1 });
    h.step();
    expect(h.world.obstacles.hitsCircle(e.x, e.z, e.radius)).toBe(false);
  });
});

/**
 * SPEC-034 §4.14, E20 (AC-59) — a level-up on the surface raises the *live* HP.
 *
 * `Progression.addXp` grows `save.player.hp`, but the body the surface draws
 * and damages is `world.player.hp`, a different number: before this spec the
 * grant landed in the save and the salvager walked on with the old bar. Combat
 * now listens for `player:leveledUp` and adds the same delta to the body.
 */
describe('a level-up raises the live HP by the max-HP delta (SPEC-034 §4.14)', () => {
  it('the body gains exactly what the maximum gained, and stays capped', () => {
    const h = harness({ creation: MARINE });
    const maxBefore = h.world.stats.maxHp;
    // Hurt, so the gain is visible as a gain rather than swallowed by the cap.
    h.world.player.hp = maxBefore - 30;

    const gained = h.progression.addXp(cumulativeXp(2), 'test').levelsGained;
    expect(gained).toBe(1);

    // §4.14's one formula: +4 max HP per level.
    const delta = h.world.stats.maxHp - maxBefore;
    expect(delta).toBe(4);
    expect(h.world.player.hp).toBe(maxBefore - 30 + delta);
    // The save's own grant is the same size, so the two HP fields stay in step.
    expect(h.save.player.hp).toBe(maxHp(h.save.player.classId, h.save.player.attributes, h.save.player.level));
  });

  it('a level-up at full HP tops out at the new maximum, never above it', () => {
    const h = harness({ creation: MARINE });
    h.world.player.hp = h.world.stats.maxHp;
    h.progression.addXp(cumulativeXp(2), 'test');
    expect(h.world.player.hp).toBe(h.world.stats.maxHp);
  });

  it('a dead body is not revived by a level-up', () => {
    const h = harness({ creation: MARINE });
    h.world.player.hp = 0;
    h.world.player.alive = false;
    h.progression.addXp(cumulativeXp(2), 'test');
    expect(h.world.player.hp).toBe(0);
  });
});

// ------------------------------------------------- SPEC-035: sound and origin

describe('SPEC-035 §4.11 — one event per shot and per landed hit', () => {
  it('names the fired weapon’s line and the muzzle it left from', () => {
    const h = harness();
    h.input.buttons.fire.down = true;
    h.aim = { x: 10, z: 0 };
    h.step();
    const fired = h.of('weapon:fired');
    expect(fired).toHaveLength(1);
    // The marine starts on `weapon_kinetic`, a rifle.
    expect(fired[0]?.line).toBe('rifle');
    expect(fired[0]?.x).toBeCloseTo(0.6, 6);
    expect(fired[0]?.z).toBeCloseTo(0, 6);
  });

  it('calls a machine gun `mg` and a pistol `handgun`', () => {
    const mg = harness({ patch: (s) => (s.equipped.primary = 'mg_scrap') });
    mg.input.buttons.fire.down = true;
    mg.aim = { x: 10, z: 0 };
    mg.step();
    expect(mg.of('weapon:fired')[0]?.line).toBe('mg');

    const pistol = harness({ patch: (s) => (s.activeWeapon = 'sidearm') });
    pistol.input.buttons.fire.down = true;
    pistol.aim = { x: 10, z: 0 };
    pistol.step();
    expect(pistol.of('weapon:fired')[0]?.line).toBe('handgun');
  });

  it('a projectile hit on a live enemy thuds at the enemy', () => {
    const h = harness();
    const e = h.spawn('dust_skitter', 4, 0);
    h.shot({ x: 3.4, z: 0, vx: 22, damage: 1, owner: 'player' });
    h.step();
    const hits = h.of('enemy:hit');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.enemyId).toBe('dust_skitter');
    expect(hits[0]?.x).toBeCloseTo(e.x, 3);
    expect(hits[0]?.z).toBeCloseTo(e.z, 3);
  });

  it('a blast hit on a live enemy thuds once per enemy', () => {
    const h = harness();
    const left = h.spawn('dust_skitter', 1, 0);
    const right = h.spawn('dust_skitter', -1, 0);
    hashStep(h, [
      [left, 1, 0],
      [right, -1, 0],
    ]);
    h.combat.explode(0, 0, 4, 1, 0.5);
    expect(h.of('enemy:hit')).toHaveLength(2);
    expect(h.of('combat:blast')).toHaveLength(1);
  });
});

describe('SPEC-035 §4.6 — player:damaged carries where the hit came from', () => {
  it('a melee blow points at the enemy that landed it', () => {
    const h = harness();
    const e = h.spawn('dust_skitter', 1, 0);
    e.aggro = true;
    // The skitter keeps moving after the blow, so its position is read inside
    // the emit rather than after the run.
    let at: { x: number; z: number } | null = null;
    h.events.on('player:damaged', (p) => {
      if (p.source.kind === 'enemy' && at === null) at = { x: e.x, z: e.z };
    }, h);
    h.run(4);
    const hit = h.of('player:damaged').find((p) => p.source.kind === 'enemy');
    expect(hit?.from).toBeDefined();
    expect(at).not.toBeNull();
    expect(hit?.from).toEqual(at);
  });

  it('a shot points 0.1 s back along its own flight, not at the bullet', () => {
    const h = harness();
    h.shot({ x: 0.3, z: 0, vx: -20, vz: 0, damage: 5, owner: 'enemy', enemyId: 'scav_raider' });
    h.step();
    const hit = h.of('player:damaged').find((p) => p.source.kind === 'projectile');
    expect(hit?.from?.x).toBeGreaterThan(1.5);
    expect(hit?.from?.z).toBeCloseTo(0, 6);
  });

  it('weather and falls carry none', () => {
    const h = harness();
    h.combat.damagePlayer(10, { kind: 'fall' });
    h.combat.damagePlayer(4, { kind: 'weather', weather: 'sandstorm' }, true);
    for (const hit of h.of('player:damaged')) expect(hit.from).toBeUndefined();
  });
});

// ------------------------------------------------ SPEC-036: the launcher tap

describe('fireSlotOnce — the launcher on touch (SPEC-036 §4.6)', () => {
  it('fires one charge at a skitter 8 m out and leaves the weapon in hand alone', () => {
    const h = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_grenade') });
    const skitter = h.spawn('dust_skitter', 8, 0);
    const before = h.combat.loadout.view('heavy', h.world.time, {
      itemId: null,
      state: 'ready',
      cd: 0,
      heat: 0,
      charges: 0,
      maxCharges: 0,
      cdSeconds: 0,
    }).charges;
    expect(h.combat.fireSlotOnce('heavy')).toBe('fired');
    const after = h.combat.loadout.view('heavy', h.world.time, {
      itemId: null,
      state: 'ready',
      cd: 0,
      heat: 0,
      charges: 0,
      maxCharges: 0,
      cdSeconds: 0,
    }).charges;
    expect(after).toBe(before - 1);
    const fired = h.of('weapon:fired');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.line).toBe('launcher');
    expect(h.combat.loadout.active).toBe('primary');
    expect(h.of('weapon:switched')).toHaveLength(0);
    // Aimed at the skitter: the lob's target is where it stood.
    expect(h.world.projectiles.size).toBe(1);
    const shell = h.world.projectiles.at(0);
    expect(shell.lob).toBe(true);
    expect(shell.targetX).toBeCloseTo(skitter.x, 6);
    expect(shell.targetZ).toBeCloseTo(skitter.z, 6);
    // Review 2026-10 (G-12): the gun in hand waits a switch's 0.25 s, the
    // desktop rotation's cost; the burst interval is the slot's own (below).
    expect(h.world.player.fireCooldown).toBeCloseTo(SWITCH_SECONDS, 6);
  });

  // Review 2026-10 (G-12): the tap set the shared cooldown to the launcher's
  // 1 / fireRate, so a Rocket tap held the primary for a whole second.
  it('a Rocket tap holds the primary for 0.25 s, not the Rocket\'s 1 s, and never cuts a longer wait short', () => {
    const h = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_rocket') });
    h.spawn('dust_skitter', 8, 0);
    expect(h.combat.fireSlotOnce('heavy')).toBe('fired');
    expect(h.world.player.fireCooldown).toBeCloseTo(0.25, 6);
    expect(h.world.player.fireCooldown).toBeLessThan(1 / ITEMS.launcher_rocket.fireRate);
    // A wait already longer than the switch stands.
    const slow = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_rocket') });
    slow.world.player.fireCooldown = 0.6;
    expect(slow.combat.fireSlotOnce('heavy')).toBe('fired');
    expect(slow.world.player.fireCooldown).toBeCloseTo(0.6, 6);
  });

  it('with no enemy in range, the shot lands 10 m along facing (36-k)', () => {
    const h = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_grenade') });
    h.world.player.facing = Math.PI / 2; // +z
    expect(h.combat.fireSlotOnce('heavy')).toBe('fired');
    const shell = h.world.projectiles.at(0);
    expect(shell.targetX).toBeCloseTo(0, 6);
    expect(shell.targetZ).toBeCloseTo(10, 6);

    // A rocket, which does not lob, flies along facing the same way.
    const rocket = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_rocket') });
    rocket.world.player.facing = Math.PI;
    expect(rocket.combat.fireSlotOnce('heavy')).toBe('fired');
    const shot = rocket.world.projectiles.at(0);
    expect(shot.vx).toBeLessThan(0);
    expect(shot.vz).toBeCloseTo(0, 6);
    expect(shot.blastRadius).toBe(3.5);
  });

  it('returns not-ready with no charge left, and empty with no heavy equipped (36-j)', () => {
    const h = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_rocket') });
    expect(h.combat.fireSlotOnce('heavy')).toBe('fired');
    expect(h.combat.fireSlotOnce('heavy')).toBe('not-ready');
    expect(h.of('weapon:fired')).toHaveLength(1);
    expect(h.world.projectiles.size).toBe(1);
    // It recharges holstered, as the loadout always did.
    h.run(6.1);
    expect(h.combat.fireSlotOnce('heavy')).toBe('fired');

    const bare = harness();
    expect(bare.combat.fireSlotOnce('heavy')).toBe('empty');
    expect(bare.world.projectiles.size).toBe(0);
  });

  it('inside the burst interval it is not ready either', () => {
    const h = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_grenade') });
    expect(h.combat.fireSlotOnce('heavy')).toBe('fired');
    expect(h.combat.fireSlotOnce('heavy')).toBe('not-ready');
    h.run(0.45);
    expect(h.combat.fireSlotOnce('heavy')).toBe('fired');
  });
});

// ------------------------------------------------------------- SPEC-038

describe('difficulty is read live (SPEC-038 §4.6)', () => {
  it('a switch to casual mid-harness changes the next hit', () => {
    const h = harness();
    const e = h.spawn('wurmling', 1.8, 0);
    e.aggro = true;
    e.state = 'windup';
    e.stateTime = 1;
    h.step();
    const normal = h.of('player:damaged')[0]?.amount ?? 0;
    expect(normal).toBe(9);
    h.save.meta.difficulty = 'casual';
    h.world.player.invulnUntil = 0;
    e.state = 'windup';
    e.stateTime = 1;
    e.x = h.world.player.x - 1.8;
    e.z = h.world.player.z;
    h.step();
    expect(h.of('player:damaged')[1]?.amount).toBe(Math.round(9 * 0.7));
    expect(h.world.windupMult).toBe(1.25);
  });

  it('casual weather is ×0.7 after hazardResist', () => {
    const patch = (s: Parameters<NonNullable<Parameters<typeof harness>[0]>['patch'] & object>[0]): void => {
      s.equipped.armor = 'armor_composite';
    };
    const normal = harness({ patch });
    const casual = harness({ patch });
    casual.save.meta.difficulty = 'casual';
    const resist = normal.world.stats.hazardResist;
    expect(resist).toBeGreaterThan(0);
    const hp0 = normal.world.player.hp;
    const hp1 = casual.world.player.hp;
    normal.combat.damagePlayer(100, { kind: 'weather', weather: 'heatwave' }, true);
    casual.combat.damagePlayer(100, { kind: 'weather', weather: 'heatwave' }, true);
    expect(hp0 - normal.world.player.hp).toBe(Math.floor(100 * (1 - resist)));
    expect(hp1 - casual.world.player.hp).toBe(Math.floor(100 * (1 - resist) * CASUAL_WEATHER_MULT));
  });
});

// ------------------------------------------------------------- SPEC-059

describe('the story difficulty (SPEC-059 §4.2.2)', () => {
  /** A harness on `difficulty`, with nothing but the player in it. */
  const on = (difficulty: Save['meta']['difficulty'], follower = false): Harness => {
    const h = harness({ follower });
    h.save.meta.difficulty = difficulty;
    return h;
  };
  /** What a hit may touch: HP, the i-frames and the events it emits. */
  const touched = (h: Harness): { hp: number; invulnUntil: number; events: number } => ({
    hp: h.world.player.hp,
    invulnUntil: h.world.player.invulnUntil,
    events: h.of('player:damaged').length + h.of('player:died').length,
  });

  it('a melee blow leaves HP, the i-frames and the events alone — and still pushes', () => {
    const blow = (h: Harness): void => {
      const e = h.spawn('wurmling', 1.8, 0);
      e.aggro = true;
      e.state = 'windup';
      e.stateTime = 1;
      h.step();
      h.step();
    };
    const story = on('story');
    const before = touched(story);
    blow(story);
    expect(touched(story)).toEqual(before);
    // Knockback is unchanged: a push is not damage.
    const normal = on('normal');
    blow(normal);
    expect(normal.of('player:damaged')).toHaveLength(1);
    expect(story.world.player.x).not.toBe(0);
    expect(story.world.player.x).toBeCloseTo(normal.world.player.x, 10);
  });

  it('an enemy shot and a telegraph hit change nothing either', () => {
    const story = on('story');
    const before = touched(story);
    story.shot({ x: -0.4, z: 0, vx: 40, owner: 'enemy', damage: 20, enemyId: 'dust_skitter', ttl: 1 });
    story.step();
    const t = story.combat.telegraphs.alloc();
    resetTelegraph(t);
    Object.assign(t, {
      kind: 'circle',
      x: 0.5,
      z: 0,
      radius: 1.5,
      startAt: story.world.time,
      hitAt: story.world.time + 0.1,
      lockAt: story.world.time + 0.1,
      damage: 20,
      source: 'wurmling',
    });
    for (let i = 0; i < 12; i++) story.step();
    expect(touched(story)).toEqual(before);
    // The same direct calls the debug strip and SPEC-041's moves make.
    story.combat.damagePlayer(30, { kind: 'enemy', enemyId: 'dune_wurm' });
    story.combat.damagePlayer(30, { kind: 'projectile', enemyId: 'scav_raider' });
    expect(touched(story)).toEqual(before);
  });

  it('ten seconds of weather deal nothing, and a fall still hurts', () => {
    const story = on('story');
    const before = touched(story);
    for (let i = 0; i < 600; i++) story.combat.damagePlayer(4 * STEP, { kind: 'weather', weather: 'heatwave' }, true);
    expect(touched(story)).toEqual(before);
    story.combat.damagePlayer(60, { kind: 'fall' });
    expect(story.world.player.hp).toBe(before.hp - 60);
  });

  it('the escort follower takes no enemy damage', () => {
    const story = on('story', true);
    const f = story.world.follower;
    if (f === null) throw new Error('follower missing');
    const hp = f.hp;
    story.shot({ x: f.x - 2, z: f.z, vx: 40, owner: 'enemy', damage: 500, enemyId: 'scav_raider', ttl: 1 });
    story.run(0.2);
    expect(f.alive).toBe(true);
    expect(f.hp).toBe(hp);
    expect(story.of('follower:died')).toEqual([]);
  });

  it('assists like casual: windups ×1.25, while normal and hard stay at 1', () => {
    for (const [difficulty, mult] of [
      ['story', CASUAL_WINDUP_MULT],
      ['casual', CASUAL_WINDUP_MULT],
      ['normal', 1],
      ['hard', 1],
    ] as const) {
      const h = on(difficulty);
      h.step();
      expect(h.world.windupMult, difficulty).toBe(mult);
    }
  });

  // Review 2026-10 (G-13): story kept normal's enemy HP, so a boss on the
  // starter rifle was one to two minutes of shooting at no risk.
  it('spawns surface enemies at round(hp × 0.6), and keeps casual and hard their hits', () => {
    expect(on('story').spawn('dune_wurm', 50, 0).maxHp).toBe(Math.round(ENEMIES.dune_wurm.hp * 0.6));
    expect(on('story').spawn('wurmling', 50, 0, true).maxHp).toBe(Math.round(ENEMIES.wurmling.hp * TUNING.ELITE_HP_MULT * 0.6));
    expect(on('normal').spawn('dune_wurm', 50, 0).maxHp).toBe(ENEMIES.dune_wurm.hp);
    expect(CASUAL_WEATHER_MULT).toBe(0.7);
    const casual = on('casual');
    casual.combat.damagePlayer(10, { kind: 'enemy', enemyId: 'dune_wurm' });
    expect(casual.of('player:damaged')).toHaveLength(1);
    const hard = on('hard');
    hard.combat.damagePlayer(10, { kind: 'projectile', enemyId: 'scav_raider' });
    expect(hard.of('player:damaged')[0]?.amount).toBe(10);
  });
});

describe('auto-fire leads a strafing target (SPEC-038 §4.7)', () => {
  /** The direction of the first player shot after one step. */
  function firstShot(h: ReturnType<typeof harness>): { x: number; z: number } {
    h.step();
    for (let i = 0; i < h.world.projectiles.size; i++) {
      const p = h.world.projectiles.at(i);
      if (p.owner === 'player') {
        const len = Math.hypot(p.vx, p.vz);
        return { x: p.vx / len, z: p.vz / len };
      }
    }
    throw new Error('no shot');
  }

  it('by its velocity × the shot’s flight time, and only in strafe', () => {
    const h = harness();
    h.input.autoFire = true;
    const e = h.spawn('scav_raider', 10, 0);
    e.aggro = true;
    e.state = 'strafe';
    e.vx = 0;
    e.vz = 3.5;
    const speed = ITEMS.weapon_kinetic.kind === 'weapon' ? ITEMS.weapon_kinetic.projectileSpeed : 0;
    const shot = firstShot(h);
    const lead = 3.5 * (10 / speed);
    expect(Math.atan2(shot.z, shot.x)).toBeCloseTo(Math.atan2(lead, 10), 2);

    // Winding up, it stands: aimed at as it stands.
    const g = harness();
    g.input.autoFire = true;
    const f = g.spawn('scav_raider', 10, 0);
    f.aggro = true;
    f.state = 'windup';
    f.stateTime = 0;
    f.vx = 0;
    f.vz = 3.5;
    expect(firstShot(g).z).toBeCloseTo(0, 5);
  });

  it('caps the lead at 3 m', () => {
    expect(AUTO_LEAD_MAX).toBe(3);
    const h = harness();
    h.input.autoFire = true;
    const e = h.spawn('scav_raider', 10, 0);
    e.aggro = true;
    e.state = 'strafe';
    e.vx = 0;
    e.vz = 50;
    const shot = firstShot(h);
    expect(Math.atan2(shot.z, shot.x)).toBeCloseTo(Math.atan2(3, 10), 2);
  });

  it('never leads a pointer’s aim', () => {
    const h = harness();
    const e = h.spawn('scav_raider', 10, 0);
    e.aggro = true;
    e.state = 'strafe';
    e.vz = 3.5;
    h.input.buttons.fire.down = true;
    h.aim = { x: 10, z: 0 };
    const shot = firstShot(h);
    expect(shot.z).toBeCloseTo(0, 5);
  });

  it('a standing Kinetic Repeater lands at least 35 % of 30 s of auto-fire on a strafing raider 10 m out (seed 1)', () => {
    const h = harness({ seed: 1 });
    h.input.autoFire = true;
    h.world.player.hp = 1e6; // the raider shoots back; this measures the gun
    const e = h.spawn('scav_raider', 10, 0);
    e.hp = e.maxHp = 1e9;
    e.aggro = true;
    e.state = 'strafe';
    h.run(30);
    const shots = h.of('weapon:fired').length;
    const hits = h.of('enemy:hit').length;
    expect(shots).toBeGreaterThan(60);
    expect(hits / shots).toBeGreaterThanOrEqual(0.35);
  });
});

describe('crits read on the hit (SPEC-038 §4.8)', () => {
  it('a crit projectile sets lastHitCrit and emits enemy:hit with crit: true', () => {
    const h = harness();
    const e = h.spawn('wurmling', 3, 0);
    h.shot({ x: 3, z: 0, vx: 40, damage: 5, crit: true });
    h.step();
    expect(e.lastHitCrit).toBe(true);
    expect(h.of('enemy:hit')).toEqual([{ enemyId: 'wurmling', x: e.x, z: e.z, crit: true }]);
    h.shot({ x: e.x, z: e.z, vx: 40, damage: 5, crit: false });
    h.step();
    expect(e.lastHitCrit).toBe(false);
    expect(h.of('enemy:hit')[1]).toEqual({ enemyId: 'wurmling', x: e.x, z: e.z });
  });

  it('the firing roll marks the shot; blasts never crit (38-n)', () => {
    const h = harness();
    h.world.stats.critChance = 1;
    h.input.autoFire = true;
    const e = h.spawn('wurmling', 6, 0);
    e.hp = e.maxHp = 1e6;
    h.run(0.6);
    expect(h.of('enemy:hit').length).toBeGreaterThan(0);
    expect(h.of('enemy:hit').every((hit) => hit.crit === true)).toBe(true);
    expect(e.lastHitCrit).toBe(true);
    h.combat.explode(e.x, e.z, 3, 10, 0.5);
    expect(e.lastHitCrit).toBe(false);
    expect(h.of('enemy:hit').at(-1)?.crit).toBeUndefined();
  });
});

describe('what the dash holds (SPEC-038 §4.1)', () => {
  it('no shot, no push-out and no knockback while it runs; cooldowns still tick', () => {
    const h = harness();
    h.input.autoFire = true;
    const p = h.world.player;
    const e = h.spawn('dust_skitter', 0.3, 0); // overlapping the player
    e.cooldown = 99;
    p.dashUntil = h.world.time + 0.2;
    p.fireCooldown = 0.1;
    h.step();
    expect(h.of('weapon:fired')).toHaveLength(0);
    expect(p.x).toBe(0); // not pushed out of the body
    expect(p.fireCooldown).toBeCloseTo(0.1 - STEP, 10);
    // Once it ends, push-out and auto-fire resume.
    h.run(0.25);
    expect(Math.hypot(p.x - e.x, p.z - e.z)).toBeGreaterThanOrEqual(e.radius + p.radius - 1e-6);
    expect(h.of('weapon:fired').length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ SPEC-039

/** The five bosses and the piece each one drops (SPEC-039 §4.1). */
const SIGNATURES: readonly [EnemyId, ItemId][] = [
  ['dune_wurm', 'launcher_rocket'],
  ['frost_matriarch', 'mg_scrap'],
  ['hive_broodlord', 'pistol_magnum'],
  ['ash_titan', 'launcher_grenade'],
  ['hive_queen', 'mg_rotary'],
];

/** Lithium orbs in the drops, summed. */
function lithiumIn(h: ReturnType<typeof harness>): number {
  let total = 0;
  for (const drop of h.combat.drops) if (drop.kind === 'resource' && drop.resource === 'lithium') total += drop.amount;
  return total;
}

describe('signature drops and replay kills (SPEC-039 §4.1)', () => {
  it('a first kill of each boss, its piece unowned, drops that piece as one gear drop', () => {
    for (const [boss, piece] of SIGNATURES) {
      const h = harness();
      h.combat.killEnemy(h.spawn(boss, 10, 0), 'player');
      const gear = h.combat.drops.filter((d) => d.kind === 'gear');
      expect(gear, boss).toHaveLength(1);
      expect(gear[0]?.itemId, boss).toBe(piece);
      expect(gear[0]?.kind === 'gear' ? gear[0].line : null, boss).toBe((ITEMS[piece] as WeaponDef).line);
      // Scattered 0.5–1.5 m from the kill like every other drop.
      const d = Math.hypot((gear[0]?.x ?? 0) - 10, gear[0]?.z ?? 0);
      expect(d).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(d).toBeLessThanOrEqual(1.5 + 1e-9);
      // No signature fallback rode along, and the frag pair is still there.
      expect(lithiumIn(h), boss).toBe(0);
      expect(h.combat.drops.some((drop) => drop.kind === 'item' && drop.itemId === 'frag_grenade' && drop.qty === 2)).toBe(true);
      expect([h.combat.signatureDrops, h.combat.signatureFallbacks]).toEqual([1, 0]);
    }
  });

  it('a carried piece, a worn piece and a replay each pay 25 lithium in orbs and never the piece (E69)', () => {
    for (const [boss, piece] of SIGNATURES) {
      const carried = harness({ patch: (s) => void s.inventory.push({ itemId: piece, qty: 1 }) });
      const worn = harness({
        patch: (s) => {
          const item = ITEMS[piece] as WeaponDef;
          s.equipped[item.slot] = piece;
        },
      });
      const replay = harness();
      for (const h of [carried, worn, replay]) {
        const e = h.spawn(boss, 10, 0);
        if (h === replay) e.replay = true;
        h.combat.killEnemy(e, 'player');
        expect(h.combat.drops.filter((d) => d.kind === 'gear'), boss).toEqual([]);
        expect(lithiumIn(h), boss).toBe(SIGNATURE_FALLBACK_LITHIUM);
        // By the orb rule: 1–3 units an orb.
        for (const drop of h.combat.drops) {
          if (drop.kind === 'resource') expect(drop.amount).toBeLessThanOrEqual(3);
        }
        expect([h.combat.signatureDrops, h.combat.signatureFallbacks]).toEqual([0, 1]);
      }
    }
    expect(SIGNATURE_FALLBACK_LITHIUM).toBe(25);
  });

  it('39-a: a piece bought and then discarded is not owned at the kill, so it drops', () => {
    const h = harness({ patch: (s) => void s.inventory.push({ itemId: 'launcher_rocket', qty: 1 }) });
    h.save.inventory = h.save.inventory.filter((entry) => entry.itemId !== 'launcher_rocket');
    h.combat.killEnemy(h.spawn('dune_wurm', 10, 0), 'player');
    expect(h.combat.drops.filter((d) => d.kind === 'gear').map((d) => d.itemId)).toEqual(['launcher_rocket']);
  });

  it('a replay kill emits enemy:killed.xp of floor(def.xp / 2), and adds that much', () => {
    for (const [boss] of SIGNATURES) {
      const h = harness();
      const e = h.spawn(boss, 10, 0);
      e.replay = true;
      const before = h.save.player.xp;
      h.combat.killEnemy(e, 'player');
      const xp = Math.floor(ENEMIES[boss].xp * TUNING.REPLAY_REWARD_FRACTION);
      expect(xp).toBe(Math.floor(ENEMIES[boss].xp / 2));
      expect(h.of('enemy:killed').map((k) => k.xp)).toEqual([xp]);
      expect(h.save.player.xp).toBe(before + xp);
    }
  });

  it('every other kill pays the XP it always did: common, elite, first-kill boss', () => {
    const h = harness();
    h.combat.killEnemy(h.spawn('dust_skitter', 5, 0), 'player');
    h.combat.killEnemy(h.spawn('dust_skitter', 5, 0, true), 'player');
    h.combat.killEnemy(h.spawn('dune_wurm', 10, 0), 'player');
    expect(h.of('enemy:killed').map((k) => k.xp)).toEqual([
      ENEMIES.dust_skitter.xp,
      ENEMIES.dust_skitter.xp * ELITE_XP_MULT,
      ENEMIES.dune_wurm.xp,
    ]);
  });

  it('spawnEnemy resets the replay flag of a reused pool slot (39-b: Wake boss is a first kill)', () => {
    const h = harness();
    const first = h.spawn('dune_wurm', 10, 0);
    first.replay = true;
    h.combat.killEnemy(first, 'player');
    h.step(); // the sweep frees the slot
    const again = h.spawn('dune_wurm', 10, 0);
    expect(again.replay).toBe(false);
  });
});

describe('classes and attributes (SPEC-039 §4.3)', () => {
  it('reads every per-point effect off ATTRIBUTE_EFFECTS', () => {
    expect(BASE_CRIT_CHANCE).toBe(0.05);
    expect(DAMAGE_PER_LEVEL).toBe(0.02);
    const h = harness({
      creation: { ...SCOUT, classId: 'scout', attributes: { might: 2, vigor: 1, agility: 9, tech: 1 } },
    });
    // Scout 2/1/9/1: crit 0.05 + 0.02 × 9 = 0.23; speed 6 × 1.15 × (1 + 0.02 × 9).
    expect(h.world.stats.critChance).toBeCloseTo(0.23, 10);
    expect(h.world.stats.moveSpeed).toBeCloseTo(6 * 1.15 * 1.18, 10);
    expect(h.world.stats.companionMult).toBeCloseTo(1.1, 10);
  });

  it('the engineer at tech 8 has a companionMult of 1.25 × 1.8 = 2.25', () => {
    const h = harness({ creation: { ...MARINE, classId: 'engineer', attributes: { might: 1, vigor: 2, agility: 2, tech: 8 } } });
    expect(h.world.stats.companionMult).toBeCloseTo(2.25, 10);
    expect(h.world.stats.critChance).toBeCloseTo(0.09, 10);
  });

  it('the marine hits for ×1.10, and playerDamageMult is the damage the stats carry', () => {
    const h = harness({ creation: { ...MARINE, attributes: { might: 6, vigor: 5, agility: 1, tech: 1 } } });
    expect(h.world.stats.damageMult).toBeCloseTo(1.1 * (1 + 0.04 * 6), 10);
    h.save.player.level = 17;
    expect(computePlayerStats(h.save).damageMult).toBeCloseTo(playerDamageMult('marine', h.save.player.attributes, 17), 12);
    expect(playerDamageMult('marine', h.save.player.attributes, 17)).toBeCloseTo(1.1 * 1.24 * 1.32, 12);
  });

  it('the scanner radius scales with companionMult', () => {
    const engineer = harness({
      creation: { ...MARINE, classId: 'engineer', attributes: { might: 1, vigor: 2, agility: 2, tech: 8 } },
      patch: (s) => s.companions.push({ id: 'scanner_drone', level: 1, enabled: true }),
    });
    expect(engineer.world.stats.pickupRadius).toBeCloseTo(TUNING.PICKUP_RADIUS + 4 * 2.25, 10);
    // 39-g: a disabled companion contributes nothing for the multiplier to scale.
    const off = harness({ patch: (s) => s.companions.push({ id: 'scanner_drone', level: 3, enabled: false }) });
    expect(off.world.stats.pickupRadius).toBeCloseTo(TUNING.PICKUP_RADIUS, 10);
  });

  it('the drone damage scales with companionMult, its fire rate does not', () => {
    const h = harness({
      creation: { ...MARINE, classId: 'engineer', attributes: { might: 1, vigor: 2, agility: 2, tech: 8 } },
      patch: (s) => s.companions.push({ id: 'combat_drone', level: 1, enabled: true }),
    });
    const egg = h.spawn('hive_egg', 6, 0);
    egg.aggro = true;
    h.step();
    const stats = h.world.stats;
    expect(h.world.projectiles.at(0).damage).toBe(Math.max(1, Math.round(12 * stats.damageMult * 0.5 * 2.25)));
    // One shot a second at L1, whatever the multiplier.
    h.run(1.5);
    expect(egg.maxHp - egg.hp).toBe(2 * h.world.projectiles.at(0).damage);
  });
});

describe('the Field Medic under weather (SPEC-039 §4.5)', () => {
  const MEDIC = (s: Save): void => void s.companions.push({ id: 'field_medic', level: 1, enabled: true });

  /** A step of a storm too thin to land a whole point in the checked window. */
  function drizzle(h: ReturnType<typeof harness>): void {
    h.combat.damagePlayer(0.1 * STEP, { kind: 'weather', weather: 'sandstorm' }, true);
    h.step();
  }

  it('regenerates nothing while weather is damaging the player', () => {
    const h = harness({ patch: MEDIC });
    h.combat.damagePlayer(100, { kind: 'fall' });
    for (let i = 0; i < 120; i++) drizzle(h);
    expect(h.world.player.hp).toBe(84);
  });

  it('waits MEDIC_WEATHER_PAUSE after the last tick, then resumes at its scaled rate', () => {
    expect(MEDIC_WEATHER_PAUSE).toBe(1);
    const h = harness({ patch: MEDIC });
    h.combat.damagePlayer(100, { kind: 'fall' });
    for (let i = 0; i < 60; i++) drizzle(h);
    h.run(0.9);
    expect(h.world.player.hp).toBe(84); // still inside the pause
    h.run(1.1); // 2 s after the last tick: 1 s of regeneration
    expect(h.world.player.hp).toBeCloseTo(84 + 0.01 * 1.1 * 184 * 1, 0);
    expect(h.world.player.hp).toBeGreaterThan(84);
  });

  it('heal-over-time items still heal during weather', () => {
    const h = harness({ patch: MEDIC });
    h.combat.damagePlayer(100, { kind: 'fall' });
    h.combat.applyConsumable({ kind: 'heal', fraction: 0.3, overSeconds: 5 });
    for (let i = 0; i < 60; i++) drizzle(h);
    // 1 s of a 5 s ration: 0.3 × 184 / 5 ≈ 11 HP, and nothing from the medic.
    expect(h.world.player.hp).toBeCloseTo(84 + (0.3 * 184) / 5, 0);
  });

  it('39-h: under a coolant pack no tick lands, so the medic keeps healing', () => {
    const h = harness({ patch: MEDIC });
    h.combat.damagePlayer(100, { kind: 'fall' });
    h.combat.applyConsumable({ kind: 'hazard_immunity', seconds: 30 });
    for (let i = 0; i < 60; i++) drizzle(h);
    expect(h.world.player.hp).toBeCloseTo(84 + 0.01 * 1.1 * 184, 0);
  });
});

describe('the fire-rate carry (SPEC-039 §4.4)', () => {
  it('600 held steps of the Laser Carbine fire exactly 40 shots', () => {
    const h = harness({ patch: (s) => void (s.equipped.primary = 'weapon_laser') });
    h.input.buttons.fire.down = true;
    h.aim = { x: 10, z: 0 };
    for (let i = 0; i < 600; i++) h.step();
    expect(h.of('weapon:fired')).toHaveLength(40);
  });

  it('a held trigger carries at most one step of the remainder', () => {
    const h = harness();
    h.input.buttons.fire.down = true;
    h.aim = { x: 10, z: 0 };
    h.step();
    // The first shot carried one whole step: the next is due 1/3 s after it.
    expect(h.world.player.fireCooldown).toBeCloseTo(1 / 3 - 1 / 60, 6);
  });

  it('39-j: released for 10 s, fireCooldown rests at −1/60 s, and the next press fires at once', () => {
    const h = harness();
    h.aim = { x: 10, z: 0 };
    h.input.buttons.fire.down = true;
    h.step();
    h.input.buttons.fire.down = false;
    h.run(10);
    expect(h.world.player.fireCooldown).toBeCloseTo(-1 / 60, 10);
    h.input.buttons.fire.down = true;
    h.step();
    expect(h.of('weapon:fired')).toHaveLength(2);
    expect(h.world.player.fireCooldown).toBeCloseTo(1 / 3 - 1 / 60, 6);
  });

  it('39-i: a switch zeroes the cooldown, so no remainder crosses it', () => {
    const h = harness();
    h.aim = { x: 10, z: 0 };
    h.input.buttons.fire.down = true;
    h.step();
    h.combat.loadout.select('sidearm', h.world.time);
    expect(h.world.player.fireCooldown).toBe(0);
  });
});

// ------------------------------------------------------- SPEC-041 §4.6

describe('elite affixes (SPEC-041 §4.6)', () => {
  const out: { a: AffixId | null; b: AffixId | null } = { a: null, b: null };

  it('rollAffixes draws one on chapters 1–3, two distinct on 4–6, from the archetype’s pool', () => {
    const rng = new Rng(17);
    for (const [id, archetype] of [
      ['dust_skitter', 'swarm'],
      ['wurmling', 'rusher'],
      ['scav_raider', 'ranged'],
    ] as const) {
      const pool = AFFIX_IDS.filter((affix) => (AFFIXES[affix].archetypes as readonly string[]).includes(archetype));
      const seen = new Set<AffixId>();
      for (let i = 0; i < 400; i++) {
        rollAffixes(ENEMIES[id], 1, rng, out);
        expect(out.a).not.toBeNull();
        expect(out.b).toBeNull();
        expect(pool).toContain(out.a);
        seen.add(out.a as AffixId);
        rollAffixes(ENEMIES[id], 5, rng, out);
        expect(out.a).not.toBeNull();
        expect(out.b).not.toBeNull();
        expect(out.a).not.toBe(out.b);
        expect(pool).toContain(out.a);
        expect(pool).toContain(out.b);
      }
      // Uniform over the pool: every entry comes up.
      expect([...seen].sort()).toEqual([...pool].sort());
    }
    // No pool serves a boss or a static egg, and that takes no draw.
    const before = new Rng(3);
    const after = new Rng(3);
    rollAffixes(ENEMIES.dune_wurm, 5, after, out);
    expect(out).toEqual({ a: null, b: null });
    rollAffixes(ENEMIES.hive_egg, 5, after, out);
    expect(out).toEqual({ a: null, b: null });
    expect(after.next()).toBe(before.next());
  });

  it('a non-elite carries no affix, whatever it is handed; the summons never roll', () => {
    const h = harness();
    const plain = h.combat.spawnEnemy('dust_skitter', 5, 0, false, 'swift', 'mender');
    expect(plain.affixA).toBeNull();
    expect(plain.affixB).toBeNull();
    const boss = h.spawn('dune_wurm', 10, 0);
    boss.aggro = true;
    boss.hp = boss.maxHp * 0.35;
    h.step();
    for (let i = 0; i < h.world.enemies.size; i++) {
      const e = h.world.enemies.at(i);
      expect(e.affixA).toBeNull();
      expect(e.elite).toBe(false);
    }
  });

  it('swift: speed ×1.35 on top of the elite ×1.1, and every windup ×0.8', () => {
    const h = harness();
    const swift = h.combat.spawnEnemy('dust_skitter', 1.5, 0, true, 'swift');
    expect(swift.speed).toBeCloseTo(ENEMIES.dust_skitter.speed * ELITE_SPEED_MULT * SWIFT_SPEED_MULT, 10);
    expect(swift.windupScale).toBe(SWIFT_WINDUP_SCALE);
    const steady = h.combat.spawnEnemy('dust_skitter', 30, 30, true, 'mender');
    expect(steady.windupScale).toBe(1);
    // The skitter's 0.25 s bite winds up in 0.2 s.
    let started = -1;
    for (let i = 0; i < 120 && h.of('player:damaged').length === 0; i++) {
      h.step();
      if (started < 0 && swift.state === 'windup') started = h.world.time;
    }
    expect(h.world.time - started).toBeCloseTo(0.25 * SWIFT_WINDUP_SCALE, 1);
  });

  it('bulwark: a shot from the front deals ×0.25 and shows guarded; from behind, piercing or a blast, full', () => {
    const h = harness();
    const guard = h.combat.spawnEnemy('wurmling', 10, 0, true, 'bulwark');
    guard.facing = Math.PI; // looking west, at the origin
    const front = () => h.shot({ x: guard.x - 1, z: 0, vx: 40, damage: 40, ttl: 0.2 });
    hashStep(h, [[guard, 10, 0]]);
    guard.facing = Math.PI;
    guard.state = 'idle';
    front();
    h.step();
    expect(guard.maxHp - guard.hp).toBe(Math.max(1, Math.round(40 * BULWARK_DAMAGE_MULT)));
    expect(guard.lastHitGuarded).toBe(true);

    // From behind: the shot comes from the east, travelling west.
    let hp = guard.hp;
    guard.facing = Math.PI;
    h.shot({ x: guard.x + 1, z: 0, vx: -40, damage: 40, ttl: 0.2 });
    h.step();
    expect(hp - guard.hp).toBe(40);
    expect(guard.lastHitGuarded).toBe(false);

    // Armour-piercing from the front: full.
    hp = guard.hp;
    guard.facing = Math.PI;
    const piercing = front();
    piercing.armorPiercing = true;
    h.step();
    expect(hp - guard.hp).toBe(40);

    // A blast: full, with no guard at all.
    hp = guard.hp;
    guard.facing = Math.PI;
    hashStep(h, [[guard, 10, 0]]);
    h.combat.explode(guard.x - 1, 0, 3, 20, 1);
    expect(hp - guard.hp).toBe(Math.max(1, Math.round(20 * h.world.stats.damageMult)));
    expect(guard.lastHitGuarded).toBe(false);
  });

  it('a weapon with pierce ≥ 1 spawns armour-piercing shots; one with none does not', () => {
    const piercing = (Object.values(ITEMS) as { kind: string; pierce?: number; id: ItemId }[]).find(
      (item) => item.kind === 'weapon' && (item.pierce ?? 0) >= 1,
    );
    expect(piercing).toBeDefined();
    for (const [weapon, expected] of [
      [piercing?.id as ItemId, true],
      ['weapon_kinetic', false],
    ] as const) {
      const h = harness({ patch: (save) => void (save.equipped.primary = weapon) });
      h.spawn('dust_skitter', 6, 0);
      h.input.autoFire = true;
      h.step();
      expect(h.world.projectiles.size).toBeGreaterThan(0);
      expect(h.world.projectiles.at(0).armorPiercing, weapon).toBe(expected);
    }
  });

  it('volley: a ranged elite fires three shots at 0 and ±0.25 rad, ×1.2 faster, each at full damage', () => {
    const h = harness();
    const gun = h.combat.spawnEnemy('scav_raider', -8, 0, true, 'volley');
    gun.aggro = true;
    gun.state = 'strafe';
    gun.cooldown = 0;
    for (let i = 0; i < 120 && h.world.projectiles.size === 0; i++) h.step();
    expect(h.world.projectiles.size).toBe(3);
    const angles: number[] = [];
    for (let i = 0; i < 3; i++) {
      const p = h.world.projectiles.at(i);
      expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(15 * VOLLEY_SPEED_MULT, 6);
      expect(p.damage).toBe(ENEMIES.scav_raider.damage);
      angles.push(Math.atan2(p.vz, p.vx));
    }
    angles.sort((a, b) => a - b);
    expect((angles[1] ?? 0) - (angles[0] ?? 0)).toBeCloseTo(0.25, 6);
    expect((angles[2] ?? 0) - (angles[1] ?? 0)).toBeCloseTo(0.25, 6);
  });

  it('mender: every 0.5 s, others within 8 m regain 1.5 % of their max — never itself, never a boss', () => {
    const h = harness();
    h.world.player.x = 200; // nothing aggroes
    const mender = h.combat.spawnEnemy('wurmling', 0, 0, true, 'mender');
    const near = h.spawn('dust_skitter', 5, 0);
    const far = h.spawn('dust_skitter', 9, 0);
    const boss = h.spawn('frost_matriarch', -6, 0);
    for (const e of [mender, near, far, boss]) {
      e.wanderAt = Infinity;
      e.wanderX = e.x;
      e.wanderZ = e.z;
    }
    mender.hp = mender.maxHp - 20;
    near.hp = 1;
    far.hp = 1;
    boss.hp = boss.maxHp - 100;
    h.run(MENDER_PULSE_SECONDS + STEP);
    expect(near.hp).toBeCloseTo(1 + MENDER_HEAL_FRACTION * near.maxHp, 6);
    expect(far.hp).toBe(1);
    expect(boss.hp).toBe(boss.maxHp - 100);
    expect(mender.hp).toBe(mender.maxHp - 20);
    expect(h.combat.menderPulseCount).toBe(1);
    expect(h.combat.menderPulses[0]).toEqual({ x: mender.x, z: mender.z });
    // Healing stops at the max.
    near.hp = near.maxHp - 0.1;
    h.run(MENDER_PULSE_SECONDS);
    expect(near.hp).toBe(near.maxHp);
  });

  it('mender pulses never stack: three menders out of phase mend a neighbour as fast as one (41-m)', () => {
    const h = harness();
    h.world.player.x = 200; // nothing aggroes
    const patient = h.spawn('dust_skitter', 0, 0);
    const menders = [];
    // Spawned 0.1 s apart, so their pulses fall at different steps.
    for (const [x, z] of [
      [3, 0],
      [-3, 0],
      [0, 3],
    ] as const) {
      menders.push(h.combat.spawnEnemy('wurmling', x, z, true, 'mender'));
      h.run(0.1);
    }
    for (const e of [patient, ...menders]) {
      e.wanderAt = Infinity;
      e.wanderX = e.x;
      e.wanderZ = e.z;
    }
    patient.hp = 1;
    h.run(2);
    // One heal per pulse period: 4 in these 2 s, where stacking gave 12.
    expect(patient.hp).toBeCloseTo(1 + 4 * MENDER_HEAL_FRACTION * patient.maxHp, 6);
    // Every mender still pulsed, so each still draws its ring.
    expect(h.combat.menderPulseCount).toBeGreaterThanOrEqual(12);
  });

  it('volatile: its death leaves a 3 m circle landing 1 s later for ×1.5, on the player only (41-f)', () => {
    const h = harness({ follower: true });
    const f = h.world.follower;
    if (f === null) throw new Error('follower missing');
    const bomb = h.combat.spawnEnemy('dust_skitter', 1, 0, true, 'volatile');
    f.x = 1;
    f.z = 1;
    h.combat.killEnemy(bomb, 'player');
    expect(h.combat.telegraphs.size).toBe(1);
    const t = h.combat.telegraphs.at(0);
    expect(t).toMatchObject({ kind: 'circle', x: 1, z: 0, radius: 3, elite: false, ownerId: 0, hitsFollower: false });
    expect(t.damage).toBeCloseTo(ENEMIES.dust_skitter.damage * VOLATILE_DAMAGE_MULT, 10);
    expect(t.hitAt - t.startAt).toBeCloseTo(1, 10);
    const followerHp = f.hp;
    h.run(1.1);
    expect(h.of('player:damaged').some((d) => d.source.kind === 'enemy' && d.source.enemyId === 'dust_skitter')).toBe(true);
    expect(f.hp).toBe(followerHp);
  });

  it('an elite’s kill pays floor(xp × (3 + affixes)), and a replay halves it', () => {
    const h = harness();
    h.combat.killEnemy(h.combat.spawnEnemy('dust_skitter', 5, 0, true, 'swift'), 'player');
    h.combat.killEnemy(h.combat.spawnEnemy('wurmling', 5, 0, true, 'swift', 'mender'), 'player');
    const replayed = h.combat.spawnEnemy('scav_raider', 5, 0, true, 'volley', 'mender');
    replayed.replay = true;
    h.combat.killEnemy(replayed, 'player');
    expect(ELITE_XP_MULT).toBe(3);
    expect(h.of('enemy:killed').map((k) => k.xp)).toEqual([
      ENEMIES.dust_skitter.xp * 4,
      ENEMIES.wurmling.xp * 5,
      Math.floor(ENEMIES.scav_raider.xp * 5 * TUNING.REPLAY_REWARD_FRACTION),
    ]);
  });
});

describe('the sealed arena (SPEC-041 §4.4, E62)', () => {
  const sealed = (): ArenaState => ({ x: 0, z: 0, radius: 10, locked: true, sealed: true });

  it('clamps knockback inside radius − 0.5', () => {
    const h = harness({ arena: sealed() });
    h.world.player.x = 9.3;
    const e = h.spawn('dust_skitter', 8.2, 0);
    e.aggro = true;
    e.state = 'chase';
    for (let i = 0; i < 120 && h.of('player:damaged').length === 0; i++) h.step();
    expect(h.of('player:damaged').length).toBeGreaterThan(0);
    expect(Math.hypot(h.world.player.x, h.world.player.z)).toBeLessThanOrEqual(10 - ARENA_SEAL_INSET + 1e-9);
  });

  it('clamps push-out inside radius − 0.5', () => {
    const h = harness({ arena: sealed() });
    h.world.player.x = 9.4;
    const e = h.spawn('wurmling', 9, 0); // overlapping, pushing the player out
    e.wanderAt = Infinity;
    e.state = 'idle';
    h.step();
    expect(Math.hypot(h.world.player.x, h.world.player.z)).toBeLessThanOrEqual(10 - ARENA_SEAL_INSET + 1e-9);
  });

  it('an unsealed arena clamps nothing, and the boss’s death opens the seal', () => {
    const open = harness({ arena: { x: 0, z: 0, radius: 10, locked: true, sealed: false } });
    open.world.player.x = 9.4;
    const e = open.spawn('wurmling', 9, 0);
    e.state = 'idle';
    e.wanderAt = Infinity;
    open.step();
    expect(open.world.player.x).toBeGreaterThan(10 - ARENA_SEAL_INSET);

    const h = harness({ arena: sealed() });
    const boss = h.spawn('dune_wurm', 0, 0);
    h.combat.killEnemy(boss, 'player');
    expect(h.world.arena?.sealed).toBe(false);
    expect(h.world.arena?.locked).toBe(false);
  });
});

// ------------------------------------------------- SPEC-042 §4.9: hit memory

describe('the target frame’s hit memory (SPEC-042 §4.9)', () => {
  it('a projectile hit writes lastHit; an elite hit writes lastEliteHit too', () => {
    const h = harness();
    expect(h.combat.lastHit.entity).toBeNull();
    const egg = h.spawn('hive_egg', 2, 0);
    h.shot({ x: 2, z: 0, vx: 40, damage: 5, ttl: 0.5 });
    h.step();
    expect(h.combat.lastHit).toEqual({ entity: egg, id: egg.id, at: h.world.time });
    expect(h.combat.lastEliteHit.entity).toBeNull();

    const elite = h.spawn('dust_skitter', 6, 6, true);
    expect(elite.elite).toBe(true);
    h.run(0.5);
    h.shot({ x: elite.x, z: elite.z, vx: 40, damage: 5, ttl: 0.5 });
    h.step();
    expect(h.combat.lastHit.entity).toBe(elite);
    expect(h.combat.lastEliteHit).toEqual({ entity: elite, id: elite.id, at: h.world.time });
  });

  it('a blast writes it as well — the player’s blasts are hits', () => {
    const h = harness();
    const egg = h.spawn('hive_egg', 4, 4);
    h.step();
    expect(h.combat.explode(4, 4, 1, 1, 0)).toBe(1);
    expect(h.combat.lastHit.entity).toBe(egg);
  });

  it('a boss hit writes neither — the boss has its own frame', () => {
    const h = harness();
    const boss = h.spawn('dune_wurm', 10, 10);
    h.step();
    const before = boss.hp;
    h.shot({ x: boss.x, z: boss.z, vx: 40, damage: 5, ttl: 0.5 });
    h.step();
    expect(boss.hp).toBeLessThan(before);
    expect(h.combat.lastHit.entity).toBeNull();
    expect(h.combat.lastEliteHit.entity).toBeNull();
  });

  it('drone damage writes neither', () => {
    const h = harness();
    const egg = h.spawn('hive_egg', 2, 0);
    const elite = h.spawn('dust_skitter', 6, 6, true);
    h.run(0.25);
    h.shot({ x: 2, z: 0, vx: 40, damage: 5, ttl: 0.5, owner: 'drone' });
    h.shot({ x: elite.x, z: elite.z, vx: 40, damage: 5, ttl: 0.5, owner: 'drone' });
    h.step();
    expect(egg.hp).toBeLessThan(egg.maxHp);
    expect(elite.hp).toBeLessThan(elite.maxHp);
    expect(h.combat.lastHit.entity).toBeNull();
    expect(h.combat.lastEliteHit.entity).toBeNull();
  });
});

// ------------------------------------------------------------- SPEC-043

describe('hard (SPEC-043 §4.4)', () => {
  it('a surface enemy spawns with round(hp × 1.25) on hard — elites and bosses too', () => {
    const h = harness({ patch: (s) => void (s.meta.difficulty = 'hard') });
    expect(h.spawn('wurmling', 40, 0).maxHp).toBe(Math.round(ENEMIES.wurmling.hp * 1.25));
    expect(h.spawn('wurmling', 50, 0).hp).toBe(Math.round(ENEMIES.wurmling.hp * 1.25));
    expect(h.spawn('wurmling', 60, 0, true).maxHp).toBe(Math.round(ENEMIES.wurmling.hp * TUNING.ELITE_HP_MULT * 1.25));
    expect(h.spawn('dune_wurm', 70, 0).maxHp).toBe(Math.round(ENEMIES.dune_wurm.hp * 1.25));
  });

  it('flight-domain enemies keep their HP on hard', () => {
    const h = harness({ patch: (s) => void (s.meta.difficulty = 'hard') });
    expect(ENEMIES.hive_interceptor.domain).toBe('flight');
    expect(h.spawn('hive_interceptor', 40, 0).maxHp).toBe(ENEMIES.hive_interceptor.hp);
    expect(h.spawn('scav_fighter', 50, 0).maxHp).toBe(ENEMIES.scav_fighter.hp);
  });

  it('casual and normal spawn at the table HP, as before', () => {
    for (const difficulty of ['casual', 'normal'] as const) {
      const h = harness({ patch: (s) => void (s.meta.difficulty = difficulty) });
      expect(h.spawn('wurmling', 40, 0).maxHp, difficulty).toBe(ENEMIES.wurmling.hp);
      expect(h.spawn('dune_wurm', 50, 0).maxHp, difficulty).toBe(ENEMIES.dune_wurm.hp);
    }
  });

  it('enemyHitDamage is ×1.3 on hard, ×0.7 on casual, and unchanged on normal', () => {
    const h = harness();
    const wurmling = h.spawn('wurmling', 50, 0); // damage 9
    expect(enemyHitDamage(wurmling, flatStats(), 'hard')).toBe(Math.round(9 * 1.3));
    expect(enemyHitDamage(wurmling, flatStats({ armor: 45 }), 'hard')).toBe(Math.round(9 * 1.3 * (1 - 45 / 145)));
    expect(enemyHitDamage(wurmling, flatStats(), 'casual')).toBe(Math.round(9 * 0.7));
    expect(enemyHitDamage(wurmling, flatStats(), 'normal')).toBe(9);
    const elite = h.spawn('wurmling', 60, 0, true);
    expect(enemyHitDamage(elite, flatStats(), 'hard')).toBe(Math.round(9 * 1.5 * 1.3));
  });

  it('a melee hit lands ×1.3 on hard, and leaves windups and weather at casual’s 1 (43-h)', () => {
    const h = harness({ patch: (s) => void (s.meta.difficulty = 'hard') });
    const e = h.spawn('wurmling', 1.8, 0);
    e.aggro = true;
    e.state = 'windup';
    e.stateTime = 1;
    h.step();
    expect(h.of('player:damaged')[0]?.amount).toBe(Math.round(9 * 1.3));
    expect(h.world.windupMult).toBe(1);
    const resist = h.world.stats.hazardResist;
    const hp = h.world.player.hp;
    h.world.player.invulnUntil = 0;
    h.combat.damagePlayer(100, { kind: 'weather', weather: 'heatwave' }, true);
    expect(hp - h.world.player.hp).toBe(Math.floor(100 * (1 - resist)));
  });

  it('a switch of difficulty applies from the next spawn; the living keep their HP (43-h)', () => {
    const h = harness();
    const before = h.spawn('wurmling', 40, 0);
    expect(before.maxHp).toBe(ENEMIES.wurmling.hp);
    h.save.meta.difficulty = 'hard';
    const after = h.spawn('wurmling', 50, 0);
    expect(after.maxHp).toBe(Math.round(ENEMIES.wurmling.hp * 1.25));
    expect(before.maxHp).toBe(ENEMIES.wurmling.hp);
    expect(before.hp).toBe(ENEMIES.wurmling.hp);
  });
});

// ------------------------------------------------------------- SPEC-050

/** One slot's view, through a fresh scratch. */
function slotView(h: Harness, slot: 'primary' | 'heavy'): SlotView {
  return h.combat.loadout.view(slot, h.world.time, {
    itemId: null,
    state: 'ready',
    cd: 0,
    heat: 0,
    charges: 0,
    maxCharges: 0,
    cdSeconds: 0,
  });
}

describe('the holstered gun (SPEC-050 §4.2)', () => {
  it('fires nothing while the player sprints: no auto-fire and no held fire', () => {
    const h = harness();
    h.spawn('hive_egg', 4, 0);
    h.input.autoFire = true;
    h.world.player.sprinting = true;
    h.run(1);
    expect(h.world.projectiles.size).toBe(0);
    h.input.buttons.fire.down = true;
    h.aim = { x: 10, z: 0 };
    h.run(0.5);
    expect(h.world.projectiles.size).toBe(0);
    expect(h.of('weapon:fired')).toHaveLength(0);
  });

  it('the first shot after a sprint ends comes no earlier than drawAt — the end + 0.25 s', () => {
    const h = harness();
    h.spawn('hive_egg', 4, 0);
    h.input.autoFire = true;
    const p = h.world.player;
    // The scene's order: the stamina step, then combat. Sprinting for 0.5 s…
    for (let i = 0; i < 30; i++) {
      stepStamina(p, true, true, false, 1, 20.6, h.world.time, STEP);
      h.step();
    }
    expect(h.of('weapon:fired')).toHaveLength(0);
    // …then the step it ends draws the gun.
    stepStamina(p, false, true, false, 1, 20.6, h.world.time, STEP);
    expect(p.drawAt).toBeCloseTo(h.world.time + SPRINT_DRAW_SECONDS, 9);
    let firstShot = -1;
    for (let i = 0; i < 60 && firstShot < 0; i++) {
      h.step();
      if (h.of('weapon:fired').length > 0) firstShot = h.world.time;
      stepStamina(p, false, true, false, 1, 20.6, h.world.time, STEP);
    }
    expect(firstShot).toBeGreaterThanOrEqual(p.drawAt - 1e-9);
    expect(firstShot).toBeLessThan(p.drawAt + 2 * STEP);
    expect(h.combat.lastShotAt).toBe(firstShot);
  });

  it('keeps ticking cooldowns, heat and charges while holstered', () => {
    const mg = harness({ patch: (s) => void (s.equipped.primary = 'mg_scrap') });
    mg.input.buttons.fire.down = true;
    mg.aim = { x: 10, z: 0 };
    mg.run(1);
    const hot = slotView(mg, 'primary').heat;
    expect(hot).toBeGreaterThan(0);
    mg.world.player.sprinting = true;
    mg.run(1);
    expect(slotView(mg, 'primary').heat).toBeLessThan(hot);

    const rocket = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_rocket') });
    expect(rocket.combat.fireSlotOnce('heavy')).toBe('fired');
    expect(slotView(rocket, 'heavy').charges).toBe(0);
    rocket.world.player.sprinting = true;
    rocket.run(6.1);
    expect(slotView(rocket, 'heavy').charges).toBe(1);
  });

  it('the combat drone keeps firing while the player runs', () => {
    const h = harness({ patch: (s) => s.companions.push({ id: 'combat_drone', level: 1, enabled: true }) });
    const egg = h.spawn('hive_egg', 6, 0);
    egg.aggro = true;
    h.world.player.sprinting = true;
    h.step();
    expect(h.world.projectiles.size).toBe(1);
    expect(h.world.projectiles.at(0).owner).toBe('drone');
  });

  it('fireSlotOnce returns holstered while sprinting or drawing, before any other check, and fires nothing (50-g)', () => {
    const h = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_rocket') });
    const p = h.world.player;
    p.sprinting = true;
    expect(h.combat.fireSlotOnce('heavy')).toBe('holstered');
    p.sprinting = false;
    p.drawAt = h.world.time + 0.1;
    expect(h.combat.fireSlotOnce('heavy')).toBe('holstered');
    expect(h.world.projectiles.size).toBe(0);
    expect(h.of('weapon:fired')).toHaveLength(0);
    expect(h.of('ui:toast')).toHaveLength(0);
    // Ahead of the empty slot's answer too.
    const bare = harness();
    bare.world.player.sprinting = true;
    expect(bare.combat.fireSlotOnce('heavy')).toBe('holstered');
    // Drawn: it fires.
    h.run(0.1 + STEP);
    expect(h.combat.fireSlotOnce('heavy')).toBe('fired');
  });

  it('walking with auto-fire fires as before — nothing holsters a walk', () => {
    const h = harness();
    h.spawn('hive_egg', 4, 0);
    h.input.autoFire = true;
    const p = h.world.player;
    stepStamina(p, false, true, true, 1, 20.6, h.world.time, STEP);
    h.step();
    expect(h.of('weapon:fired')).toHaveLength(1);
  });
});

// ------------------------------------------------------------- SPEC-054

describe('auto-fire in the dark (SPEC-054 §4.6)', () => {
  /** The scene's world below: the light's switch and the 9 m sight. */
  function below(on: boolean): Harness {
    const h = harness();
    h.world.light = { on };
    h.world.sight = DARK_SIGHT;
    h.world.player.facing = 0; // the beam points along +x
    return h;
  }

  it('skips a 12 m enemy outside the cone, and fires at it inside the cone', () => {
    const h = below(true);
    h.spawn('hive_egg', 0, 12); // 90° off the beam, inside the 14 m range
    h.input.autoFire = true;
    h.run(0.5);
    expect(h.of('weapon:fired')).toHaveLength(0);
    expect(h.world.projectiles.size).toBe(0);
    // The salvager turns the light onto it: now it is a target.
    h.world.player.facing = Math.PI / 2;
    h.step();
    expect(h.of('weapon:fired')).toHaveLength(1);
    expect(h.world.projectiles.at(0).vz).toBeCloseTo(22, 5);
  });

  it('with the light off nothing past 9 m is a target, and anything within 9 m still is', () => {
    const h = below(false);
    h.spawn('hive_egg', 12, 0); // dead ahead, but dark
    h.input.autoFire = true;
    h.run(0.5);
    expect(h.world.projectiles.size).toBe(0);
    h.spawn('hive_egg', -8.5, 0); // behind, but inside the sight
    h.step();
    expect(h.world.projectiles.size).toBe(1);
    expect(h.world.projectiles.at(0).vx).toBeCloseTo(-22, 5);
  });

  it('a nearer enemy in the dark past 9 m loses the shot to a farther lit one', () => {
    const h = below(true);
    h.spawn('hive_egg', 13, 0); // lit
    h.spawn('hive_egg', 0, -11); // nearer, unlit
    h.input.autoFire = true;
    h.step();
    expect(h.world.projectiles.size).toBe(1);
    expect(h.world.projectiles.at(0).vx).toBeCloseTo(22, 5); // at the lit one
  });

  it('a held pointer aim and an aim-drag are not restricted', () => {
    const h = below(false);
    h.spawn('hive_egg', 0, 12);
    h.input.buttons.fire.down = true;
    h.aim = { x: 0, z: 12 };
    h.step();
    expect(h.world.projectiles.size).toBe(1);
    expect(h.world.projectiles.at(0).vz).toBeCloseTo(22, 5);

    const drag = below(false);
    drag.spawn('hive_egg', 0, -12);
    drag.input.autoFire = true;
    drag.input.aim.dragging = true;
    drag.aim = { x: 0, z: -12 };
    drag.step();
    expect(drag.world.projectiles.at(0).vz).toBeCloseTo(-22, 5);
  });

  it('the launcher tap aims the same way: an unlit enemy past 9 m is not its target (36-k)', () => {
    const h = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_grenade') });
    h.world.light = { on: true };
    h.world.sight = DARK_SIGHT;
    h.world.player.facing = 0;
    h.spawn('hive_egg', 0, 11);
    expect(h.combat.fireSlotOnce('heavy')).toBe('fired');
    const shell = h.world.projectiles.at(0);
    expect(shell.targetX).toBeCloseTo(10, 6); // 10 m along facing, not at the egg
    expect(shell.targetZ).toBeCloseTo(0, 6);
  });

  it('below, an enemy behind rock is no target: no shot, and the facing (the beam) stays put (review B-02)', () => {
    // A wall between this room and the next, at x = 4.
    const wall = new CircleObstacles([{ x: 4, z: 0, radius: 1.5 }]);
    const dark = harness({ obstacles: wall });
    dark.world.light = { on: false };
    dark.world.sight = DARK_SIGHT;
    dark.world.player.facing = Math.PI;
    dark.spawn('hive_egg', 7.5, 0); // inside the 9 m sight, but through the wall
    dark.input.autoFire = true;
    dark.run(0.5);
    expect({ fired: dark.of('weapon:fired').length, facing: dark.world.player.facing }).toEqual({ fired: 0, facing: Math.PI });

    // The light on and on it, 15 m off through the same wall: still no shot.
    const lit = harness({ obstacles: wall });
    lit.world.light = { on: true };
    lit.world.sight = DARK_SIGHT;
    lit.world.player.facing = 0;
    lit.spawn('hive_egg', 15, 0);
    lit.input.autoFire = true;
    lit.run(0.5);
    expect(lit.of('weapon:fired')).toHaveLength(0);
    // One in the open beside it is still a target.
    lit.spawn('hive_egg', 0, 6);
    lit.step();
    expect(lit.of('weapon:fired')).toHaveLength(1);
    expect(lit.world.projectiles.at(0).vz).toBeCloseTo(22, 5);

    // The surface keeps 11-j: a blocked-only target is still fired at.
    const above = harness({ obstacles: wall });
    above.spawn('hive_egg', 7.5, 0);
    above.input.autoFire = true;
    above.step();
    expect(above.of('weapon:fired')).toHaveLength(1);
  });

  it('on the surface (light and sight unset) nothing changes: a 12 m enemy behind is a target', () => {
    const h = harness();
    expect(h.world.light).toBeUndefined();
    expect(h.world.sight).toBeUndefined();
    h.world.player.facing = 0;
    h.spawn('hive_egg', -12, 0);
    h.input.autoFire = true;
    h.step();
    expect(h.world.projectiles.size).toBe(1);
    expect(h.world.projectiles.at(0).vx).toBeCloseTo(-22, 5);
  });
});

describe('a level swap clears the field (SPEC-054 §4.2, 54-a)', () => {
  it('clearLevel frees every projectile, telegraph and deployable — no blast, no hit, no event', () => {
    const h = harness();
    // A shot in flight, a grenade in the air, an enemy bolt, a mine, a charge…
    h.input.buttons.fire.down = true;
    h.aim = { x: 10, z: 0 };
    h.step();
    h.input.buttons.fire.down = false;
    h.combat.throwExplosive(FRAG, 6, 0);
    h.shot({ owner: 'enemy', enemyId: 'scav_raider', x: 5, z: 0, vx: -15, damage: 7 });
    expect(h.combat.deploy(MINE, 3, 3)).toBe('ok');
    expect(h.combat.deploy(CHARGE, -3, 0)).toBe('ok');
    // …and a burst circle landing on the player in 0.5 s.
    const t = h.combat.telegraphs.alloc();
    resetTelegraph(t);
    t.radius = 3;
    t.startAt = h.world.time;
    t.hitAt = h.world.time + 0.5;
    t.lockAt = t.hitAt;
    t.damage = 30;
    expect(h.world.projectiles.size).toBe(3);
    const events = h.recorded.length;

    h.combat.clearLevel();
    expect(h.world.projectiles.size).toBe(0);
    expect(h.combat.telegraphs.size).toBe(0);
    expect(h.combat.deployables.size).toBe(0);
    expect(h.recorded.length).toBe(events); // clearing says nothing

    // A walk past where they stood: nothing arms, nothing goes off, nothing lands.
    const egg = h.spawn('hive_egg', 3, 3);
    h.run(5);
    expect(h.of('combat:blast')).toHaveLength(0);
    expect(h.of('mine:armed')).toHaveLength(0);
    expect(h.of('player:damaged')).toHaveLength(0);
    expect(h.of('enemy:hit')).toHaveLength(0);
    expect(egg.hp).toBe(egg.maxHp);
    expect(h.world.player.hp).toBe(h.world.stats.maxHp);
  });

  it('the cleared pools refill as before', () => {
    const h = harness();
    expect(h.combat.deploy(MINE, 3, 0)).toBe('ok');
    h.combat.clearLevel();
    for (let i = 0; i < MAX_ARMED_MINES; i++) expect(h.combat.deploy(MINE, i * 5, 40)).toBe('ok');
    expect(h.combat.deploy(MINE, 40, 40)).toBe('mine_limit');
    h.run(1.1);
    expect(h.of('mine:armed')).toHaveLength(MAX_ARMED_MINES);
  });
});

describe('every spawn leashes on its def (SPEC-054 §4.7)', () => {
  it('spawnEnemy resets placed and leash, a recycled slot included', () => {
    const h = harness();
    const e = h.spawn('wurmling', 30, 0);
    expect(e.placed).toBe(false);
    expect(e.leash).toBe(ENEMIES.wurmling.leashRadius);
    // A cave pack's stamp on the slot, then the slot goes back to the pool.
    e.placed = true;
    e.leash = 24;
    h.combat.killEnemy(e, 'script');
    h.step();
    expect(h.world.enemies.size).toBe(0);
    const next = h.spawn('dust_skitter', 30, 0);
    expect(next).toBe(e); // the same pooled object
    expect(next.placed).toBe(false);
    expect(next.leash).toBe(ENEMIES.dust_skitter.leashRadius);
  });
});

// ------------------------------------------------------------- SPEC-056

/** A relic's twist off the table, narrowed to its kind. */
function twistOfKind<K extends 'execute' | 'chill' | 'linger' | 'vent' | 'seek'>(id: ItemId, kind: K) {
  const twist = twistOf(id);
  if (twist === null || twist.kind !== kind) throw new Error(`${id} carries no ${kind}`);
  return twist as Extract<NonNullable<ReturnType<typeof twistOf>>, { kind: K }>;
}

/** A player shot from the origin along +x at an enemy on the x axis, carrying `twist` — run until it lands. */
function twistShot(h: Harness, damage: number, twist: ReturnType<typeof twistOf>): void {
  h.shot({ x: 0, z: 0, vx: 30, vz: 0, damage, twist, owner: 'player' });
  for (let k = 0; k < 60 && h.world.projectiles.size > 0; k++) h.step();
}

describe('the relic twists (SPEC-056 §4.4)', () => {
  it('only relics carry a twist, and the relic\'s own shot carries it', () => {
    for (const id of Object.keys(ITEMS) as ItemId[]) {
      const item = ITEMS[id];
      expect(twistOf(id) !== null, id).toBe(item.kind === 'weapon' && 'relic' in item);
    }
    const h = harness({ patch: (s) => void (s.equipped.sidearm = 'relic_last_word') });
    h.combat.loadout.select('sidearm', h.world.time);
    h.run(0.3);
    h.spawn('hive_egg', 6, 0);
    h.input.autoFire = true;
    h.step();
    expect(h.world.projectiles.size).toBe(1);
    expect(h.world.projectiles.at(0).twist).toEqual({ kind: 'execute', belowHp: 0.3, mult: 2 });
    // A non-relic's shot carries none.
    const plain = harness();
    plain.spawn('hive_egg', 6, 0);
    plain.input.autoFire = true;
    plain.step();
    expect(plain.world.projectiles.at(0).twist).toBeNull();
  });

  it('execute: a hit at 31 % of max HP is not doubled; at 30 % it is', () => {
    const execute = twistOfKind('relic_last_word', 'execute');
    const h = harness();
    const egg = h.spawn('hive_egg', 3, 0);
    egg.hp = 0.31 * egg.maxHp;
    let before = egg.hp;
    twistShot(h, 10, execute);
    expect(before - egg.hp).toBeCloseTo(10, 6);
    egg.hp = 0.3 * egg.maxHp;
    before = egg.hp;
    twistShot(h, 10, execute);
    expect(before - egg.hp).toBeCloseTo(20, 6);
    // Elites too.
    h.combat.killEnemy(egg, 'script');
    h.step();
    const elite = h.spawn('dust_skitter', 3, 0, true);
    expect(elite.elite).toBe(true);
    elite.hp = 0.25 * elite.maxHp;
    before = elite.hp;
    twistShot(h, 2, execute);
    expect(before - elite.hp).toBeCloseTo(4, 6);
  });

  it('chill: a hit sets slowUntil a second on and slowMult 0.75, a new hit refreshes it, and a boss gets 0.9', () => {
    const chill = twistOfKind('relic_cold_coil', 'chill');
    const h = harness();
    const egg = h.spawn('hive_egg', 3, 0);
    expect([egg.slowUntil, egg.slowMult]).toEqual([0, 1]);
    twistShot(h, 1, chill);
    expect(egg.slowMult).toBe(0.75);
    // Set at the hit: a second on from then, which is at most a few steps ago.
    expect(egg.slowUntil).toBeGreaterThan(h.world.time + 1 - 0.2);
    expect(egg.slowUntil).toBeLessThanOrEqual(h.world.time + 1);
    const first = egg.slowUntil;
    h.run(0.5);
    twistShot(h, 1, chill);
    expect(egg.slowUntil).toBeCloseTo(first + 0.5 + (egg.slowUntil - first - 0.5), 9);
    expect(egg.slowUntil - first).toBeGreaterThan(0.5);

    h.combat.killEnemy(egg, 'script');
    h.step();
    const boss = h.spawn('frost_matriarch', 3, 0);
    twistShot(h, 1, chill);
    expect(boss.slowMult).toBeCloseTo(0.9, 9);
    // A recycled slot starts unslowed (spawnEnemy resets both fields).
    h.combat.killEnemy(boss, 'script');
    h.step();
    const fresh = h.spawn('hive_egg', 5, 5);
    expect([fresh.slowUntil, fresh.slowMult]).toEqual([0, 1]);
  });

  it('linger: a Seed Drum shell leaves a 3 m cloud that deals 8 × damage multiplier a second for 3 s', () => {
    const h = harness({ patch: (s) => void (s.equipped.heavy = 'relic_seed_drum') });
    h.combat.loadout.select('heavy', h.world.time);
    h.run(0.3);
    const egg = h.spawn('hive_egg', 10, 0);
    h.aim = { x: 10, z: 0 };
    h.input.buttons.fire.down = true;
    h.step();
    h.input.buttons.fire.down = false;
    // The shell flies 9.4 m at 16 m/s, then bursts.
    let steps = 0;
    while (h.of('combat:blast').length === 0 && steps++ < 120) h.step();
    expect(h.combat.cloudsAlive).toBe(1);
    const cloud = h.combat.clouds.find((c) => c.until > h.world.time);
    expect(cloud).toMatchObject({ x: 10, z: 0, radius: 3, dps: 8 });
    expect((cloud?.until ?? 0) - h.world.time).toBeCloseTo(3, 6);
    const before = egg.hp;
    h.run(1);
    expect(before - egg.hp).toBeCloseTo(8 * h.world.stats.damageMult, 3);
    // It hurts nothing of the player's and lands no extra blast.
    expect(h.world.player.hp).toBe(h.world.stats.maxHp);
    expect(h.of('combat:blast')).toHaveLength(1);
    h.run(2.1);
    expect(h.combat.cloudsAlive).toBe(0);
    const after = egg.hp;
    h.run(0.5);
    expect(egg.hp).toBe(after);
  });

  it('linger: at most 6 clouds — a 7th replaces the oldest (56-e); a frag leaves none', () => {
    const linger = twistOfKind('relic_seed_drum', 'linger');
    const h = harness();
    for (let k = 0; k < 7; k++) {
      h.shot({ lob: true, x: 0, z: 0, vx: 1, vz: 0, targetX: k * 10, targetZ: 0, ttl: STEP / 2, flight: STEP / 2, blastRadius: 3, blastFalloff: 0.5, damage: 1, twist: linger });
      h.run(0.1);
    }
    expect(MAX_LINGER_CLOUDS).toBe(6);
    expect(h.combat.clouds).toHaveLength(6);
    expect(h.combat.cloudsAlive).toBe(6);
    const xs = h.combat.clouds.filter((c) => c.until > h.world.time).map((c) => c.x).sort((a, b) => a - b);
    expect(xs).toEqual([10, 20, 30, 40, 50, 60]); // the first, at 0, went
    const frag = harness();
    frag.combat.throwExplosive(FRAG, 6, 0);
    frag.run(1);
    expect(frag.of('combat:blast')).toHaveLength(1);
    expect(frag.combat.cloudsAlive).toBe(0);
  });

  it('vent: a Slag Vent lock blasts 3.5 m at the player — an enemy at 3 m takes 60 × damage multiplier with falloff, the player nothing', () => {
    const h = harness({ patch: (s) => void (s.equipped.primary = 'relic_slag_vent') });
    const egg = h.spawn('hive_egg', 3, 0);
    const far = h.spawn('hive_egg', 0, 6);
    h.events.emit('weapon:locked', { slot: 'primary', itemId: 'relic_slag_vent' });
    h.step();
    expect(h.of('combat:blast')).toEqual([{ x: 0, z: 0, radius: 3.5 }]);
    const d = 3 - egg.radius;
    const expected = Math.max(1, Math.round(60 * h.world.stats.damageMult * (1 - (1 - EXPLOSIVE_FALLOFF) * (d / 3.5))));
    expect(egg.maxHp - egg.hp).toBe(expected);
    expect(far.hp).toBe(far.maxHp);
    expect(h.world.player.hp).toBe(h.world.stats.maxHp);
  });

  it('vent: a held trigger that locks the Slag Vent vents once; a Rotary Cannon lock vents nothing', () => {
    const vent = harness({ patch: (s) => void (s.equipped.primary = 'relic_slag_vent') });
    vent.aim = { x: 0, z: -20 };
    vent.input.buttons.fire.down = true;
    vent.run(6);
    expect(vent.of('weapon:locked')).toEqual([{ slot: 'primary', itemId: 'relic_slag_vent' }]);
    expect(vent.of('combat:blast')).toHaveLength(1);
    expect(vent.world.player.hp).toBe(vent.world.stats.maxHp);

    const rotary = harness({ patch: (s) => void (s.equipped.primary = 'mg_rotary') });
    rotary.aim = { x: 0, z: -20 };
    rotary.input.buttons.fire.down = true;
    rotary.run(8);
    expect(rotary.of('weapon:locked')).toHaveLength(1);
    expect(rotary.of('combat:blast')).toHaveLength(0);
  });

  it('seek: the shot takes the nearest enemy within 0.7 rad and range, turns at most 2.1 rad/s, and flies straight once it dies', () => {
    const h = harness({ patch: (s) => void (s.equipped.heavy = 'relic_seeker') });
    h.combat.loadout.select('heavy', h.world.time);
    h.run(0.3);
    h.spawn('hive_egg', 0, 9); // 90° off the aim: outside the cone
    const quarry = h.spawn('hive_egg', 16, 6); // 0.36 rad off the aim
    h.aim = { x: 20, z: 0 };
    h.input.buttons.fire.down = true;
    h.step();
    h.input.buttons.fire.down = false;
    expect(h.world.projectiles.size).toBe(1);
    const rocket = h.world.projectiles.at(0);
    expect(rocket.seekTarget).toBe(quarry.id);
    expect(rocket.seekTurn).toBe(2.1);
    const launched = Math.atan2(rocket.vz, rocket.vx);
    let heading = launched;
    for (let k = 0; k < 20; k++) {
      h.step();
      const next = Math.atan2(rocket.vz, rocket.vx);
      // Toward the quarry, by at most 2.1 rad/s — none once it points at it.
      expect(next - heading).toBeGreaterThanOrEqual(-1e-12);
      expect(next - heading).toBeLessThanOrEqual(2.1 * STEP + 1e-9);
      expect(Math.hypot(rocket.vx, rocket.vz)).toBeCloseTo(18, 6); // the speed is kept
      heading = next;
    }
    expect(heading - launched).toBeGreaterThan(0.2);
    h.combat.killEnemy(quarry, 'script');
    h.step();
    expect(rocket.seekTarget).toBe(-1);
    heading = Math.atan2(rocket.vz, rocket.vx);
    h.step();
    expect(Math.atan2(rocket.vz, rocket.vx)).toBe(heading); // straight on (56-d)
  });

  it('seek: with nothing in the cone the shot seeks nothing', () => {
    const h = harness({ patch: (s) => void (s.equipped.heavy = 'relic_seeker') });
    h.combat.loadout.select('heavy', h.world.time);
    h.run(0.3);
    h.spawn('hive_egg', 0, 9);
    h.spawn('hive_egg', 30, 0); // in the cone, out of the 22 m range
    h.aim = { x: 20, z: 0 };
    h.input.buttons.fire.down = true;
    h.step();
    expect(h.world.projectiles.at(0).seekTarget).toBe(-1);
  });
});

describe('the flare and the stim (SPEC-056 §4.5)', () => {
  const FLARE = ITEMS.flare.effect;

  it('throwFlare lobs at 14 m/s to the aim point, clamped to 12 m, and lands burning 60 s', () => {
    const h = harness();
    expect(h.combat.throwFlare(FLARE, 20, 0)).toBe(true);
    const p = h.world.projectiles.at(0);
    expect(p.lob).toBe(true);
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(THROW_SPEED, 6);
    expect([p.targetX, p.targetZ]).toEqual([12, 0]);
    h.run(1);
    expect(h.world.projectiles.size).toBe(0);
    expect(h.of('combat:blast')).toHaveLength(0); // it lands; nothing blows up
    expect(h.combat.flaresBurning).toBe(1);
    const flare = h.combat.flares.find((f) => f.until > h.world.time);
    expect(flare).toMatchObject({ x: 12, z: 0 });
    expect((flare?.until ?? 0) - h.world.time).toBeGreaterThan(59);
    expect((flare?.until ?? 0) - h.world.time).toBeLessThanOrEqual(60);
    // A short throw lands where it was aimed.
    expect(h.combat.throwFlare(FLARE, 3, 4)).toBe(true);
    h.run(1);
    expect(h.combat.flares.some((f) => f.x === 3 && f.z === 4)).toBe(true);
    h.run(60);
    expect(h.combat.flaresBurning).toBe(0);
  });

  it('at most 2 flares burn — a third replaces the oldest (56-f); a downed player throws none', () => {
    const h = harness();
    expect(MAX_FLARES).toBe(2);
    for (const x of [4, 6, 8]) {
      h.combat.throwFlare(FLARE, x, 0);
      h.run(1);
    }
    expect(h.combat.flares).toHaveLength(2);
    expect(h.combat.flaresBurning).toBe(2);
    expect(h.combat.flares.map((f) => f.x).sort()).toEqual([6, 8]);
    h.world.player.alive = false;
    expect(h.combat.throwFlare(FLARE, 4, 0)).toBe(false);
    expect(h.world.projectiles.size).toBe(0);
  });

  it('below, an enemy within 12 m of a burning flare is lit for auto-fire; the surface ignores it', () => {
    const h = harness();
    h.world.light = { on: false };
    h.world.sight = DARK_SIGHT;
    h.spawn('hive_egg', 13, 0); // inside the 14 m range, past the 9 m sight
    h.input.autoFire = true;
    h.run(0.5);
    expect(h.world.projectiles.size).toBe(0);
    h.input.autoFire = false;
    h.combat.throwFlare(FLARE, 12, 0);
    h.run(1);
    expect(inFlare(13, 0, h.combat.flares, h.world.time)).toBe(true);
    h.input.autoFire = true;
    h.step();
    expect(h.of('weapon:fired')).toHaveLength(1);
  });

  it('a level swap puts the flares and the clouds out', () => {
    const h = harness();
    h.combat.throwFlare(FLARE, 5, 0);
    h.run(1);
    expect(h.combat.flaresBurning).toBe(1);
    h.combat.clearLevel();
    expect(h.combat.flaresBurning).toBe(0);
    expect(h.combat.cloudsAlive).toBe(0);
  });

  it('the stim fills the pool and clears exhaustion; a full pool that is not exhausted refuses it (56-g)', () => {
    const h = harness();
    const p = h.world.player;
    expect(STAMINA_MAX).toBe(100);
    expect(staminaFull(p)).toBe(true);
    p.stamina = 12;
    p.exhausted = true;
    expect(staminaFull(p)).toBe(false);
    h.combat.applyConsumable(ITEMS.stim.effect);
    expect([p.stamina, p.exhausted]).toEqual([STAMINA_MAX, false]);
    expect(staminaFull(p)).toBe(true);
    // Full but exhausted (a stale flag) still takes one.
    p.exhausted = true;
    expect(staminaFull(p)).toBe(false);
    expect(FLARE_RADIUS).toBe(ITEMS.flare.effect.radius);
  });
});

// ------------------------------------------------------------- SPEC-058 §4.4

describe('containment (SPEC-058 §4.4)', () => {
  /** A harness on a save of `iteration` — Combat reads its containment at construction. */
  const at = (iteration: number, difficulty: Save['meta']['difficulty'] = 'normal'): Harness =>
    harness({
      patch: (s) => {
        s.meta.iteration = iteration;
        s.meta.difficulty = difficulty;
      },
    });

  it('at iteration 2 a surface enemy spawns with round(hp × 1.15), and a boss too', () => {
    const h = at(2);
    expect(h.spawn('wurmling', 40, 0).maxHp).toBe(Math.round(ENEMIES.wurmling.hp * 1.15));
    expect(h.spawn('dune_wurm', 50, 0).maxHp).toBe(Math.round(ENEMIES.dune_wurm.hp * 1.15));
    expect(h.spawn('dune_wurm', 60, 0).hp).toBe(Math.round(ENEMIES.dune_wurm.hp * 1.15));
  });

  it('the elite ×3 and hard’s ×1.25 multiply under it, and it caps at three steps', () => {
    expect(at(2).spawn('wurmling', 40, 0, true).maxHp).toBe(Math.round(ENEMIES.wurmling.hp * TUNING.ELITE_HP_MULT * 1.15));
    expect(at(3, 'hard').spawn('dune_wurm', 40, 0).maxHp).toBe(Math.round(ENEMIES.dune_wurm.hp * 1.25 * 1.15 ** 2));
    const ceiling = Math.round(ENEMIES.dune_wurm.hp * 1.15 ** 3);
    expect(at(4).spawn('dune_wurm', 40, 0).maxHp).toBe(ceiling);
    expect(at(99).spawn('dune_wurm', 40, 0).maxHp).toBe(ceiling);
  });

  it('a flight-domain enemy keeps its HP at every iteration (58-k)', () => {
    for (const iteration of [2, 4]) {
      const h = at(iteration, 'hard');
      expect(h.spawn('hive_interceptor', 40, 0).maxHp).toBe(ENEMIES.hive_interceptor.hp);
      expect(h.spawn('scav_fighter', 50, 0).maxHp).toBe(ENEMIES.scav_fighter.hp);
    }
  });

  it('iteration 1 spawns at the table HP, as before', () => {
    const h = at(1);
    expect(h.spawn('wurmling', 40, 0).maxHp).toBe(ENEMIES.wurmling.hp);
    expect(h.spawn('dune_wurm', 50, 0).maxHp).toBe(ENEMIES.dune_wurm.hp);
  });

  it('a hit deals ×1.15 at iteration 2: a melee blow', () => {
    const blow = (h: Harness): number | undefined => {
      const e = h.spawn('wurmling', 1.8, 0); // damage 9
      e.aggro = true;
      e.state = 'windup';
      e.stateTime = 1;
      h.step();
      return h.of('player:damaged')[0]?.amount;
    };
    expect(blow(at(1))).toBe(9);
    expect(blow(at(2))).toBe(Math.round(9 * 1.15));
    // After SPEC-043's multiplier: hard is ×1.3, then ×1.15.
    expect(blow(at(2, 'hard'))).toBe(Math.round(9 * 1.3 * 1.15));
  });

  it('a hit deals ×1.15 at iteration 2: a projectile and a ground telegraph', () => {
    const shot = (h: Harness): number | undefined => {
      h.shot({ x: -0.4, z: 0, vx: 40, owner: 'enemy', damage: 20, enemyId: 'dust_skitter', ttl: 1 });
      h.step();
      return h.of('player:damaged')[0]?.amount;
    };
    const plate = (iteration: number): number => {
      const h = at(iteration);
      const reduction = 1 - h.world.stats.armor / (h.world.stats.armor + 100);
      return Math.round(20 * reduction * (iteration === 1 ? 1 : 1.15));
    };
    expect(shot(at(1))).toBe(plate(1));
    expect(shot(at(2))).toBe(plate(2));
    const slam = (h: Harness): number | undefined => {
      const t = h.combat.telegraphs.alloc();
      resetTelegraph(t);
      Object.assign(t, { kind: 'circle', x: 0.5, z: 0, radius: 1.5, startAt: h.world.time, hitAt: h.world.time + 0.1, lockAt: h.world.time + 0.1, damage: 20, source: 'wurmling' });
      for (let i = 0; i < 12; i++) h.step();
      return h.of('player:damaged')[0]?.amount;
    };
    expect(slam(at(1))).toBe(plate(1));
    expect(slam(at(2))).toBe(plate(2));
  });

  it('enemyHitDamage takes containment’s damageMult after the difficulty’s', () => {
    const h = at(1);
    const wurmling = h.spawn('wurmling', 50, 0);
    expect(enemyHitDamage(wurmling, flatStats(), 'normal', 1.15)).toBe(Math.round(9 * 1.15));
    expect(enemyHitDamage(wurmling, flatStats(), 'casual', 1.15)).toBe(Math.round(9 * 0.7 * 1.15));
    expect(enemyHitDamage(wurmling, flatStats(), 'normal')).toBe(9);
  });
});

// ------------------------------------------------------------- shot looks

describe('shot looks (SPEC-019 §4.5)', () => {
  it('a held trigger stamps the weapon\'s look on its shot and on lastShotLook', () => {
    const h = harness({ patch: (s) => void (s.equipped.primary = 'weapon_laser') });
    expect(h.combat.lastShotLook).toBeNull();
    h.input.buttons.fire.down = true;
    h.aim = { x: 10, z: 0 };
    h.step();
    expect(h.world.projectiles.size).toBe(1);
    expect(h.world.projectiles.at(0).shot).toBe(ITEMS.weapon_laser.shot);
    expect(h.combat.lastShotLook).toBe(ITEMS.weapon_laser.shot);
  });

  it('a launcher tap stamps the launcher\'s look, not the weapon in hand', () => {
    const h = harness({ patch: (s) => void (s.equipped.heavy = 'launcher_rocket') });
    expect(h.combat.fireSlotOnce('heavy')).toBe('fired');
    expect(h.world.projectiles.at(0).shot).toBe(ITEMS.launcher_rocket.shot);
    expect(h.combat.lastShotLook).toBe(ITEMS.launcher_rocket.shot);
  });

  it('the drone fires its own look, and a frag and a flare theirs', () => {
    const h = harness({ patch: (s) => s.companions.push({ id: 'combat_drone', level: 1, enabled: true }) });
    const egg = h.spawn('hive_egg', 6, 0);
    egg.aggro = true;
    h.step();
    expect(h.world.projectiles.at(0).owner).toBe('drone');
    expect(h.world.projectiles.at(0).shot).toBe(DRONE_SHOT);
    expect(h.combat.lastShotLook).toBeNull(); // the drone is not the player's muzzle

    const t = harness();
    t.combat.throwExplosive(FRAG, 6, 0);
    expect(t.world.projectiles.at(0).shot).toBe(THROWN_SHOT);
    expect(t.combat.throwFlare(ITEMS.flare.effect, 6, 0)).toBe(true);
    expect(t.world.projectiles.at(1).shot).toBe(FLARE_SHOT);
  });

  it('an enemy shot reusing a player shot\'s pooled slot carries no look', () => {
    const h = harness();
    h.input.buttons.fire.down = true;
    h.aim = { x: -10, z: 0 };
    h.step();
    h.input.buttons.fire.down = false;
    expect(h.world.projectiles.at(0).shot).not.toBeNull();
    h.run(1.5); // the repeater's shot runs out of range and returns to the pool
    expect(h.world.projectiles.size).toBe(0);
    h.spawn('scav_raider', 10, 0);
    for (let i = 0; i < 300 && h.world.projectiles.size === 0; i++) h.step();
    const p = h.world.projectiles.at(0);
    expect(p.owner).toBe('enemy');
    expect(p.shot).toBeNull();
  });
});
