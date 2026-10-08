// SPEC-068 §3, §4.1 (PLAN R28): the hazard table and each planet's rows —
// one trap and two helpers per planet, every hazard on exactly one planet, and
// the shares and timings inside the bounds R28 decision 4 sets.
import { describe, expect, it } from 'vitest';
import { HAZARDS, PLANETS, PLANET_IDS, type HazardId } from '@/data/index';

const IDS = Object.keys(HAZARDS) as HazardId[];

describe('HAZARDS (§3)', () => {
  it('keeps every share, reach and timing inside R28’s bounds', () => {
    for (const id of IDS) {
      const def = HAZARDS[id];
      expect(def.player, id).toBeGreaterThan(0);
      expect(def.player, id).toBeLessThanOrEqual(0.3);
      expect(def.enemy, id).toBeGreaterThan(0);
      expect(def.enemy, id).toBeLessThanOrEqual(1);
      expect(def.boss, id).toBeGreaterThan(0);
      expect(def.boss, id).toBeLessThanOrEqual(0.04);
      expect(def.reach, id).toBeGreaterThan(def.radius);
      // The death line reads `Killed by a lava vent`.
      expect(def.name, id).toMatch(/^an? [a-z]/);
      switch (def.archetype) {
        case 'vent':
          expect(def.warn, id).toBeGreaterThanOrEqual(1.2);
          expect(def.period?.[0], id).toBeGreaterThanOrEqual(5);
          expect(def.period?.[1], id).toBeLessThanOrEqual(10);
          break;
        case 'mine':
          expect(def.warn, id).toBeGreaterThanOrEqual(0.9);
          break;
        case 'topple':
          expect(def.width, id).toBeGreaterThan(0);
          expect(def.chill, id).toBeDefined();
          expect(def.warn, id).toBeGreaterThanOrEqual(0.5);
          break;
        case 'volatile':
          expect(def.warn, id).toBeGreaterThanOrEqual(0.3);
          break;
      }
    }
  });

  it('gives every planet one trap, one toppler and one volatile, and every hazard to exactly one planet', () => {
    const seen = new Map<HazardId, string>();
    for (const planet of PLANET_IDS) {
      const rows = PLANETS[planet].surface.hazards;
      const archetypes = rows.map((row) => HAZARDS[row.id].archetype).sort();
      expect(archetypes.filter((a) => a === 'vent' || a === 'mine'), planet).toHaveLength(1);
      expect(archetypes.filter((a) => a === 'topple'), planet).toHaveLength(1);
      expect(archetypes.filter((a) => a === 'volatile'), planet).toHaveLength(1);
      for (const row of rows) {
        const def = HAZARDS[row.id];
        expect(seen.has(row.id), `${row.id} on ${planet} and ${seen.get(row.id)}`).toBe(false);
        seen.set(row.id, planet);
        expect(row.groups, row.id).toBeGreaterThan(0);
        expect(row.per[0], row.id).toBeGreaterThanOrEqual(1);
        expect(row.per[1], row.id).toBeGreaterThanOrEqual(row.per[0]);
        // Traps never stand in an arena; helpers do, in every boss fight.
        if (def.archetype === 'vent' || def.archetype === 'mine') expect(row.arena, row.id).toBe(0);
        else expect(row.arena, row.id).toBeGreaterThanOrEqual(1);
      }
    }
    expect(new Set(seen.keys())).toEqual(new Set(IDS));
  });
});
