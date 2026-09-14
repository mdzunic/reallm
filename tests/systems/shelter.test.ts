// SPEC-030 §4.5 — the pure shelter rules: `shelterAt` over the inset ellipse,
// inside, outside, in the doorway (30-h), and for a rotated wreck.
import { describe, expect, it } from 'vitest';
import type { LayoutShelter } from '@/systems/Layout';
import {
  HIDDEN_DETECT_RADIUS,
  LOSE_TRACK_SECONDS,
  REVEAL_AFTER_SHOT,
  SHELTER_INSET,
  STORM_SHELTER_FACTOR,
  shelterAt,
} from '@/systems/Shelter';

const CAVE: LayoutShelter = { kind: 'cave', index: 0, x: 50, z: -20, rx: 6, rz: 6, angle: 0, gapAngle: Math.PI, gapWidth: 4.5 };
/** A wreck rotated 45°: long axis along the (1, 1) diagonal. */
const WRECK: LayoutShelter = {
  kind: 'wreck',
  index: 1,
  x: -30,
  z: 40,
  rx: 6.5,
  rz: 3.2,
  angle: Math.PI / 4,
  gapAngle: Math.PI / 4 + Math.PI / 2,
  gapWidth: 4,
};

describe('SPEC-030 — the constants (AC-19)', () => {
  it('carry the §3 values', () => {
    expect(SHELTER_INSET).toBe(0.3);
    expect(HIDDEN_DETECT_RADIUS).toBe(5);
    expect(LOSE_TRACK_SECONDS).toBe(3);
    expect(REVEAL_AFTER_SHOT).toBe(1.5);
    expect(STORM_SHELTER_FACTOR).toBe(0.25);
  });
});

describe('shelterAt (AC-19)', () => {
  it('finds the shelter whose inset interior holds the point', () => {
    expect(shelterAt([CAVE, WRECK], 50, -20)).toBe(CAVE);
    expect(shelterAt([CAVE, WRECK], 50 + 5, -20)).toBe(CAVE); // inside 5.7
    expect(shelterAt([CAVE, WRECK], -30, 40)).toBe(WRECK);
  });

  it('returns null outside every shelter', () => {
    expect(shelterAt([CAVE, WRECK], 0, 0)).toBeNull();
    expect(shelterAt([], 50, -20)).toBeNull();
  });

  it('a player in the doorway counts as outside (30-h)', () => {
    // The interior ellipse is inset by 0.3: 5.8 m out is past 6 − 0.3 = 5.7.
    expect(shelterAt([CAVE], 50 + 5.8, -20)).toBeNull();
    expect(shelterAt([CAVE], 50 + 5.6, -20)).toBe(CAVE);
  });

  it('a rotated wreck tests in its own frame', () => {
    const cos = Math.SQRT1_2;
    // 5 m along the long axis (rotated 45°): inside rx − 0.3 = 6.2.
    expect(shelterAt([WRECK], WRECK.x + 5 * cos, WRECK.z + 5 * cos)).toBe(WRECK);
    // 5 m along the short axis: outside rz − 0.3 = 2.9.
    expect(shelterAt([WRECK], WRECK.x - 5 * cos, WRECK.z + 5 * cos)).toBeNull();
    // 2.5 m along the short axis: inside.
    expect(shelterAt([WRECK], WRECK.x - 2.5 * cos, WRECK.z + 2.5 * cos)).toBe(WRECK);
    // An axis-aligned test at the same distances would get the frame wrong:
    // 5 m straight +x crosses the tilted ellipse's boundary.
    expect(shelterAt([WRECK], WRECK.x + 5, WRECK.z)).toBeNull();
  });

  it('the first shelter that contains the point wins', () => {
    const twin: LayoutShelter = { ...CAVE, index: 1 };
    expect(shelterAt([CAVE, twin], 50, -20)).toBe(CAVE);
  });
});
