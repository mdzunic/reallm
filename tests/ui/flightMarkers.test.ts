// SPEC-069 §6.2 — the flight's markers. Placement is SPEC-027's
// `placeWaypoint`, pinned in `tests/ui/waypoint.test.ts`; what is new here is
// the labels and the course point's geometry: the line 80 m ahead leaves the
// screen at the offsets where the player needs the arrow, and the arrow then
// points back toward the line. The DOM painting is the e2e's
// (`e2e/SPEC-069.spec.ts`).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { COURSE } from '@/systems/Flight';
import { courseLabel, MAX_SIGNAL_MARKERS, SIGNAL_GLYPHS, signalLabel } from '@/ui/FlightMarkers';
import { placeWaypoint, waypointBounds } from '@/ui/Waypoint';

const W = 1280;
const H = 720;

/** The course point as the scene projects it, for a camera at the ship's offset. */
function coursePoint(shipX: number, shipY: number): { x: number; y: number; behind: boolean } {
  const camera = new THREE.PerspectiveCamera(70, W / H, 0.1, 600);
  camera.position.set(shipX, shipY, 2.5);
  camera.updateMatrixWorld(true);
  const p = new THREE.Vector3(0, 0, -COURSE.markerDepth).project(camera);
  return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H, behind: p.z > 1 };
}

describe('the course marker (SPEC-069 §4.5)', () => {
  it('reads the destination inside the corridor and adds the metres outside it', () => {
    expect(courseLabel('Vetra', 8, false)).toBe('Vetra');
    expect(courseLabel('Vetra', 48.4, true)).toBe('Vetra · 48 m');
    expect(courseLabel('Vetra', 134, true)).toBe('Vetra · 130 m');
  });

  it('sits at the screen centre on the line', () => {
    const p = coursePoint(0, 0);
    expect(p.x).toBeCloseTo(W / 2, 6);
    expect(p.y).toBeCloseTo(H / 2, 6);
    expect(placeWaypoint(p, p.behind, W, H, waypointBounds())).toBe(true);
  });

  it('is still on screen 40 m off, and an edge arrow pointing back to the line beyond 100 m across or 60 m up', () => {
    for (const [x, y] of [
      [40, 0],
      [0, 30],
    ] as const) {
      const near = coursePoint(x, y);
      expect(placeWaypoint(near, near.behind, W, H, waypointBounds()), `${x},${y}`).toBe(true);
    }
    for (const [x, y] of [
      [110, 0],
      [-110, 0],
      [0, 60],
      [0, -60],
    ] as const) {
      const p = coursePoint(x, y);
      const onScreen = placeWaypoint(p, p.behind, W, H, waypointBounds());
      expect(onScreen, `${x},${y}`).toBe(false);
      // The arrow sits on the side of the screen the line is on: opposite the ship's offset.
      if (x !== 0) expect(Math.sign(p.x - W / 2)).toBe(-Math.sign(x));
      // Screen y runs down, world y up: a ship above the line looks down to it.
      if (y !== 0) expect(Math.sign(p.y - H / 2)).toBe(Math.sign(y));
    }
  });
});

describe('the signal markers (SPEC-069 §4.5)', () => {
  it('label each kind with its glyph and the lateral gap', () => {
    expect(signalLabel('fuel', 63.2)).toBe(`${SIGNAL_GLYPHS.fuel} 63 m`);
    expect(signalLabel('oil', 7)).toBe(`${SIGNAL_GLYPHS.oil} 7 m`);
    expect(signalLabel('missile', 104)).toBe(`${SIGNAL_GLYPHS.missile} 100 m`);
    expect(new Set(Object.values(SIGNAL_GLYPHS)).size).toBe(3);
  });

  it('draw at most five, as many as a trip plans', () => {
    expect(MAX_SIGNAL_MARKERS).toBe(5);
  });
});
