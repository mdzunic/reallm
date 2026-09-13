// SPEC-012 §4.12 — the minimap's remaining pure rules: who sees the node
// layer, and how near an enemy has to be to register (AC-58, AC-59).
//
// The projection that used to live here moved with SPEC-026: both maps now
// turn with the camera, and `tests/ui/map.test.ts` pins `mapProject` /
// `mapAngle` and the icon table the painter strokes.
import { describe, expect, it } from 'vitest';
import { newSave, type CharacterCreation, type Save } from '@/core/Save';
import { MINIMAP_RANGE } from '@/systems/MapModel';
import { MINIMAP_ENEMY_RANGE, hasNodeRadar } from '@/systems/UiHelpers';

function save(classId: 'marine' | 'scout'): Save {
  const creation: CharacterCreation = {
    name: 'T',
    classId,
    appearance: { portrait: 0, primary: '#fff', secondary: '#000' },
    attributes: { might: 3, vigor: 3, agility: 3, tech: 3 },
    difficulty: 'normal',
  };
  return newSave(0, creation, 7, 1_700_000_000_000);
}

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
    (s.companions[s.companions.length - 1] as Save['companions'][number]).level = 2;
    expect(hasNodeRadar(s)).toBe(true);
    (s.companions[s.companions.length - 1] as Save['companions'][number]).enabled = false;
    expect(hasNodeRadar(s)).toBe(false);
  });
});

describe('minimap constants (§4.12, SPEC-026 §4.3)', () => {
  it('pins the 25 m enemy range inside the 70 m window', () => {
    expect(MINIMAP_ENEMY_RANGE).toBe(25);
    expect(MINIMAP_ENEMY_RANGE).toBeLessThan(MINIMAP_RANGE);
  });
});
