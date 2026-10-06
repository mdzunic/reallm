// systems/Light (SPEC-054 §4.6, §6.1): the lit cone — its 24° edge, its 20 m
// reach, the switch and the 0.5 m rule — and what the light does to a swarm's
// and a rusher's aggro radius, with the initial tuning pinned.
import { describe, expect, it } from 'vitest';
import {
  DARK_AGGRO,
  DARK_RIM_SCALE,
  DARK_SIGHT,
  inLightCone,
  LIGHT_FEAR_SPEED,
  LIGHT_HALF_ANGLE,
  LIGHT_NEAR,
  LIGHT_RANGE,
  LIGHT_SEEK_AGGRO,
  lightAggroMult,
  lit,
  FLARE_RADIUS,
  inFlare,
  type FlareState,
} from '@/systems/Light';

const DEG = Math.PI / 180;

/** The point `d` m from (px, pz) at bearing `angle` (the `player.facing` convention). */
function at(px: number, pz: number, angle: number, d: number): [number, number] {
  return [px + Math.cos(angle) * d, pz + Math.sin(angle) * d];
}

describe('the constants (SPEC-054 §3, initial tuning)', () => {
  it('pins the light rules', () => {
    expect(LIGHT_RANGE).toBe(20);
    expect(LIGHT_HALF_ANGLE).toBe(0.42);
    expect(LIGHT_HALF_ANGLE / DEG).toBeCloseTo(24, 0); // "24°"
    expect(DARK_SIGHT).toBe(9);
    expect(DARK_AGGRO).toBe(0.6);
    expect(LIGHT_SEEK_AGGRO).toBe(1.6);
    expect(LIGHT_FEAR_SPEED).toBe(0.4);
    expect(DARK_RIM_SCALE).toBe(0.6);
    expect(LIGHT_NEAR).toBe(0.5);
  });
});

describe('lit (SPEC-054 §4.6)', () => {
  it('the cone’s edge at 24°: just inside is lit, just outside is not, on either side', () => {
    for (const side of [1, -1]) {
      expect(lit(0, 0, 0, true, ...at(0, 0, side * 24 * DEG, 10))).toBe(true);
      expect(lit(0, 0, 0, true, ...at(0, 0, side * (LIGHT_HALF_ANGLE - 0.001), 10))).toBe(true);
      expect(lit(0, 0, 0, true, ...at(0, 0, side * (LIGHT_HALF_ANGLE + 0.001), 10))).toBe(false);
      expect(lit(0, 0, 0, true, ...at(0, 0, side * 25 * DEG, 10))).toBe(false);
    }
  });

  it('the cone’s reach is 20 m: lit at 20 m on the edge, not past it', () => {
    expect(lit(0, 0, 0, true, LIGHT_RANGE, 0)).toBe(true);
    expect(lit(0, 0, 0, true, ...at(0, 0, 24 * DEG, LIGHT_RANGE))).toBe(true);
    expect(lit(0, 0, 0, true, LIGHT_RANGE + 0.01, 0)).toBe(false);
    expect(lit(0, 0, 0, true, 30, 0)).toBe(false);
  });

  it('follows the facing and the player’s position, across the ±π seam', () => {
    const px = 12;
    const pz = -7;
    expect(lit(px, pz, 2, true, ...at(px, pz, 2.4, 15))).toBe(true);
    expect(lit(px, pz, 2, true, ...at(px, pz, 2.45, 15))).toBe(false);
    expect(lit(px, pz, 2, true, ...at(px, pz, 2 + Math.PI, 5))).toBe(false); // behind
    // Facing just short of π, the target just past −π: 0.3 rad apart.
    expect(lit(px, pz, Math.PI - 0.1, true, ...at(px, pz, -Math.PI + 0.2, 8))).toBe(true);
  });

  it('the light off lights nothing, however close or central', () => {
    expect(lit(0, 0, 0, false, 5, 0)).toBe(false);
    expect(lit(0, 0, 0, false, 0.1, 0)).toBe(false);
    expect(lit(0, 0, 0, false, 0, 0)).toBe(false);
  });

  it('within 0.5 m counts as lit when on, whatever the bearing', () => {
    expect(lit(0, 0, 0, true, -0.4, 0)).toBe(true); // right behind
    expect(lit(0, 0, 0, true, 0, 0.5)).toBe(true); // square to the side, on the line
    expect(lit(0, 0, 0, true, 0, 0)).toBe(true);
    expect(lit(0, 0, 0, true, -0.6, 0)).toBe(false);
  });
});

describe('inLightCone — the beam a hunter sees (SPEC-054 §4.6)', () => {
  it('is the same 24° test at any range, and true within 0.5 m', () => {
    expect(inLightCone(0, 0, 0, 30, 0)).toBe(true); // past LIGHT_RANGE
    expect(inLightCone(0, 0, 0, ...at(0, 0, 24 * DEG, 30))).toBe(true);
    expect(inLightCone(0, 0, 0, ...at(0, 0, 25 * DEG, 30))).toBe(false);
    expect(inLightCone(0, 0, 0, -0.3, 0)).toBe(true);
    expect(inLightCone(0, 0, 0, -3, 0)).toBe(false);
  });

  it('agrees with lit wherever the light is on and the range holds', () => {
    for (let k = 0; k < 360; k += 3) {
      for (const d of [0.2, 3, 9, 15, 19.9]) {
        const [x, z] = at(1, 2, k * DEG, d);
        expect(lit(1, 2, 0.7, true, x, z)).toBe(inLightCone(1, 2, 0.7, x, z));
      }
    }
  });
});

describe('lightAggroMult (SPEC-054 §4.6)', () => {
  it('the light off: ×0.6 for a swarm or a rusher, in the cone or not', () => {
    for (const inCone of [true, false]) {
      expect(lightAggroMult('swarm', { on: false }, inCone)).toBe(DARK_AGGRO);
      expect(lightAggroMult('rusher', { on: false }, inCone)).toBe(DARK_AGGRO);
    }
  });

  it('on: a rusher in the cone ×1.6, out of it ×1; a swarm ×1 either way', () => {
    expect(lightAggroMult('rusher', { on: true }, true)).toBe(LIGHT_SEEK_AGGRO);
    expect(lightAggroMult('rusher', { on: true }, false)).toBe(1);
    expect(lightAggroMult('swarm', { on: true }, true)).toBe(1);
    expect(lightAggroMult('swarm', { on: true }, false)).toBe(1);
  });

  it('a ranged enemy, a static and a boss read 1, on or off', () => {
    for (const archetype of ['ranged', 'static', 'boss'] as const) {
      for (const on of [true, false]) {
        for (const inCone of [true, false]) expect(lightAggroMult(archetype, { on }, inCone)).toBe(1);
      }
    }
  });

  it('undefined (the surface) reads 1 for everything', () => {
    for (const archetype of ['swarm', 'rusher', 'ranged', 'static', 'boss'] as const) {
      expect(lightAggroMult(archetype, undefined, true)).toBe(1);
      expect(lightAggroMult(archetype, undefined, false)).toBe(1);
    }
  });
});

describe('inFlare (SPEC-056 §4.5)', () => {
  const flares: FlareState[] = [
    { x: 10, z: 0, until: 60 },
    { x: -20, z: 5, until: 30 },
  ];

  it('is true within 12 m of a burning flare, on its edge included', () => {
    expect(FLARE_RADIUS).toBe(12);
    expect(inFlare(10, 0, flares, 0)).toBe(true);
    expect(inFlare(21.9, 0, flares, 0)).toBe(true);
    expect(inFlare(10, 12, flares, 0)).toBe(true);
    expect(inFlare(-20, -6.9, flares, 29)).toBe(true); // the second one
  });

  it('is false outside every flare', () => {
    expect(inFlare(22.1, 0, flares, 0)).toBe(false);
    expect(inFlare(0, 20, flares, 0)).toBe(false);
    expect(inFlare(0, 0, [], 0)).toBe(false);
  });

  it('is false once a flare is past its until — a burnt-out flare lights nothing', () => {
    expect(inFlare(-20, 5, flares, 30)).toBe(false);
    expect(inFlare(10, 0, flares, 59.99)).toBe(true);
    expect(inFlare(10, 0, flares, 60)).toBe(false);
    expect(inFlare(10, 0, [{ x: 10, z: 0, until: -Infinity }], 0)).toBe(false);
  });
});
