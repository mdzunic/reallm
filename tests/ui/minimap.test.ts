// SPEC-012 §4.12 — the minimap's pure math (AC-55..AC-59). The painter in
// `ui/Minimap.ts` only strokes what these functions decide; tests stay on the
// pure side per SPEC-001 §4.
import { describe, expect, it } from 'vitest';
import { newSave, type CharacterCreation, type SaveV1 } from '@/core/Save';
import {
  MINIMAP_ENEMY_RANGE,
  MINIMAP_RIM,
  MINIMAP_SIZE,
  hasNodeRadar,
  minimapProject,
  type MinimapPoint,
} from '@/systems/UiHelpers';

const point = (): MinimapPoint => ({ x: 0, y: 0, inside: true, angle: 0 });

function save(classId: 'marine' | 'scout'): SaveV1 {
  const creation: CharacterCreation = {
    name: 'T',
    classId,
    appearance: { portrait: 0, primary: '#fff', secondary: '#000' },
    attributes: { might: 3, vigor: 3, agility: 3, tech: 3 },
    difficulty: 'normal',
  };
  return newSave(0, creation, 7, 1_700_000_000_000);
}

describe('minimapProject (AC-55..AC-57)', () => {
  it('is 1 px = 1 m, centred on the player, north-up', () => {
    const p = minimapProject(10, -20, 10, -20, point());
    expect([p.x, p.y]).toEqual([MINIMAP_SIZE / 2, MINIMAP_SIZE / 2]);
    // 12 m north of the player (−z) is 12 px up the canvas (−y).
    const north = minimapProject(10, -20, 10, -32, point());
    expect(north.inside).toBe(true);
    expect([north.x, north.y]).toEqual([MINIMAP_SIZE / 2, MINIMAP_SIZE / 2 - 12]);
    // 30 m east (+x) is 30 px right.
    const east = minimapProject(10, -20, 40, -20, point());
    expect([east.x, east.y]).toEqual([MINIMAP_SIZE / 2 + 30, MINIMAP_SIZE / 2]);
  });

  it('clamps an off-window mark to the rim, keeping its bearing', () => {
    const p = minimapProject(0, 0, 300, 0, point());
    expect(p.inside).toBe(false);
    expect(p.x).toBeCloseTo(MINIMAP_SIZE / 2 + MINIMAP_RIM);
    expect(p.y).toBeCloseTo(MINIMAP_SIZE / 2);
    expect(p.angle).toBeCloseTo(0);

    const diagonal = minimapProject(0, 0, -200, -200, point());
    expect(diagonal.inside).toBe(false);
    expect(diagonal.angle).toBeCloseTo((-3 * Math.PI) / 4);
    expect(Math.hypot(diagonal.x - MINIMAP_SIZE / 2, diagonal.y - MINIMAP_SIZE / 2)).toBeCloseTo(MINIMAP_RIM);
  });

  it('a mark exactly on the window edge is still inside', () => {
    const p = minimapProject(0, 0, MINIMAP_SIZE / 2, 0, point());
    expect(p.inside).toBe(true);
  });
});

describe('hasNodeRadar (AC-58)', () => {
  it('is off for a fresh marine — nodes hidden until the drone learns to read ore', () => {
    expect(hasNodeRadar(save('marine'))).toBe(false);
  });

  it('is on for the scout class passive', () => {
    expect(hasNodeRadar(save('scout'))).toBe(true);
  });

  it('needs the scanner drone at level 2, enabled', () => {
    const s = save('marine');
    s.companions.push({ id: 'scanner_drone', level: 1, enabled: true });
    expect(hasNodeRadar(s)).toBe(false);
    (s.companions[s.companions.length - 1] as SaveV1['companions'][number]).level = 2;
    expect(hasNodeRadar(s)).toBe(true);
    (s.companions[s.companions.length - 1] as SaveV1['companions'][number]).enabled = false;
    expect(hasNodeRadar(s)).toBe(false);
  });
});

describe('minimap constants (§4.12)', () => {
  it('pins the 160 px / 25 m contract', () => {
    expect(MINIMAP_SIZE).toBe(160);
    expect(MINIMAP_ENEMY_RANGE).toBe(25);
  });
});
