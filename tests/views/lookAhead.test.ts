// SPEC-012 §4.3: the surface camera looks 2 m ahead of a moving player. The
// player's velocity is a step, so a look-ahead that followed it directly
// jerked the camera 2 m forward on the first frame of a single tap of W and
// straight back on the release. `stepLookAhead` eases it instead.
import { describe, expect, it } from 'vitest';
import { LOOK_AHEAD, stepLookAhead } from '@/views/SurfaceView';

const DT = 1 / 60;
const SPEED = 4;

/** Steps `frames` updates at velocity (vx, vz); returns the largest single-frame move of the lead. */
function run(lead: { x: number; z: number }, vx: number, vz: number, frames: number): number {
  let jump = 0;
  for (let i = 0; i < frames; i++) {
    const x = lead.x;
    const z = lead.z;
    stepLookAhead(lead, vx, vz, DT);
    jump = Math.max(jump, Math.hypot(lead.x - x, lead.z - z));
  }
  return jump;
}

describe('the camera look-ahead (SPEC-012 §4.3)', () => {
  it('stays on the player while the player stands still', () => {
    const lead = { x: 0, z: 0 };
    run(lead, 0, 0, 120);
    expect(lead).toEqual({ x: 0, z: 0 });
  });

  it('a tap of W swings the view a fraction of the look-ahead, a few centimetres a frame, and back', () => {
    const lead = { x: 0, z: 0 };
    // About 100 ms held, then released.
    const out = run(lead, 0, -SPEED, 6);
    expect(Math.abs(lead.z)).toBeLessThan(LOOK_AHEAD * 0.3);
    const back = run(lead, 0, 0, 180);
    expect(Math.max(out, back)).toBeLessThan(0.11);
    expect(Math.abs(lead.z)).toBeLessThan(0.01);
  });

  it('a held key settles on the full look-ahead in the movement direction', () => {
    const lead = { x: 0, z: 0 };
    run(lead, SPEED, 0, 120);
    expect(lead.x).toBeCloseTo(LOOK_AHEAD, 1);
    expect(lead.z).toBe(0);
  });

  it('turning round swings the lead through the player rather than snapping across', () => {
    const lead = { x: 0, z: 0 };
    run(lead, SPEED, 0, 240);
    const jump = run(lead, -SPEED, 0, 240);
    expect(jump).toBeLessThan(0.21);
    expect(lead.x).toBeCloseTo(-LOOK_AHEAD, 1);
  });
});
