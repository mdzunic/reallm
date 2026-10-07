// Review 2026-10 V-04 / P-06 — the waypoint keeps out of the HUD. SPEC-027 §4.3
// put the off-screen arrow on an ellipse inset 56 px from the viewport edge,
// which knew nothing of the quick bar (keyboard) or the thumb arc (touch), so
// a target behind the player drew the arrow and its distance on the bar.
//
// `placeWaypoint` is pure: the boxes are the ones `Waypoint.measure()` reads
// on resize, built here from the CSS that places them (`style.css`: `.hud-bc`
// at `bottom: 48px` holding 64 px slots; `.thumb-arc` 262 × 150 at 16 px from
// the corner). The e2e case (`e2e/review-2026-10-ui.spec.ts`) reads the real
// boxes in a browser.
import { describe, expect, it } from 'vitest';
import { placeWaypoint, waypointBounds, WAYPOINT_HUD_GAP, WAYPOINT_INSET, type WaypointBounds } from '@/ui/Waypoint';

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

const overlaps = (a: Box, b: Box): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

/** The 22 px mark with its 2 px outline, centred on the point. */
const markBox = (x: number, y: number): Box => ({ l: x - 13, t: y - 13, r: x + 13, b: y + 13 });

/**
 * The label as the CSS draws it: 22 px from the mark's centre, straight down
 * for the on-screen diamond and inward along the ray for the edge arrow; a
 * `120 m` line is about 40 × 17 px.
 */
function labelBox(x: number, y: number, cx: number, cy: number, onScreen: boolean): Box {
  let ux = 0;
  let uy = 1;
  if (!onScreen) {
    const len = Math.hypot(cx - x, cy - y);
    ux = (cx - x) / len;
    uy = (cy - y) / len;
  }
  const lx = x + ux * 22;
  const ly = y + uy * 22;
  return { l: lx - 20, t: ly - 8.5, r: lx + 20, b: ly + 8.5 };
}

/** The keyboard bar at 1280 × 720: seven 48 px cells and their gaps, 64 px tall, 48 px off the bottom. */
const BAR_720: Box = { l: 640 - 196, t: 720 - 48 - 64, r: 640 + 196, b: 720 - 48 };
/** The thumb arc at 844 × 390 (`right/bottom: 16px`, 262 × 150), and mirrored for `joystickSide: 'right'`. */
const ARC_844: Box = { l: 844 - 16 - 262, t: 390 - 16 - 150, r: 844 - 16, b: 390 - 16 };
const ARC_844_LEFT: Box = { l: 16, t: ARC_844.t, r: 16 + 262, b: ARC_844.b };

function keyboardBounds(height: number, bar: Box): WaypointBounds {
  const bounds = waypointBounds();
  bounds.bottom = Math.max(WAYPOINT_INSET, height - bar.t + WAYPOINT_HUD_GAP + 13);
  return bounds;
}

function touchBounds(arc: Box): WaypointBounds {
  const bounds = waypointBounds();
  bounds.boxes.push(arc.l, arc.t, arc.r, arc.b);
  return bounds;
}

/** A target far off along `angle` (screen radians, y down), placed. */
function place(angle: number, width: number, height: number, bounds: WaypointBounds, reach = 4000): { x: number; y: number; on: boolean } {
  const point = { x: width / 2 + Math.cos(angle) * reach, y: height / 2 + Math.sin(angle) * reach };
  const on = placeWaypoint(point, false, width, height, bounds);
  return { ...point, on };
}

/** SPEC-037 §4.11's phone matrix (`e2e/phone.ts`), landscape. */
const PHONE_VIEWPORTS = [
  { name: 'phone-844', width: 844, height: 390 },
  { name: 'phone-800', width: 800, height: 360 },
  { name: 'phone-750', width: 750, height: 342 },
  { name: 'phone-802', width: 802, height: 293 },
  { name: 'phone-667', width: 667, height: 375 },
  { name: 'tablet-1180', width: 1180, height: 820 },
] as const;

const ANGLES = Array.from({ length: 720 }, (_, i) => (i / 720) * Math.PI * 2);

describe('placeWaypoint (review 2026-10 V-04)', () => {
  it('with no HUD boxes, is SPEC-027’s ellipse inset 56 px', () => {
    const width = 1280;
    const height = 720;
    const bounds = waypointBounds();
    for (const angle of ANGLES) {
      const p = place(angle, width, height, bounds);
      const ax = width / 2 - WAYPOINT_INSET;
      const by = height / 2 - WAYPOINT_INSET;
      expect(p.on).toBe(false);
      expect(Math.hypot((p.x - width / 2) / ax, (p.y - height / 2) / by)).toBeCloseTo(1, 6);
    }
    // Inside the ellipse it is the target itself.
    const near = { x: 700, y: 400 };
    expect(placeWaypoint(near, false, width, height, bounds)).toBe(true);
    expect(near).toEqual({ x: 700, y: 400 });
  });

  it('keeps the arrow and its label off the keyboard quick bar at 1280 × 720, at every bearing', () => {
    const bounds = keyboardBounds(720, BAR_720);
    for (const angle of ANGLES) {
      const p = place(angle, 1280, 720, bounds);
      expect(overlaps(markBox(p.x, p.y), BAR_720), `mark at ${angle.toFixed(3)}`).toBe(false);
      expect(overlaps(labelBox(p.x, p.y, 640, 360, p.on), BAR_720), `label at ${angle.toFixed(3)}`).toBe(false);
    }
    // Due south — the case the review saw: the arrow sits 12 px above the bar.
    const south = place(Math.PI / 2, 1280, 720, bounds);
    expect(south.x).toBeCloseTo(640, 6);
    expect(markBox(south.x, south.y).b).toBeCloseTo(BAR_720.t - WAYPOINT_HUD_GAP, 6);
  });

  it('keeps the arrow and its label out of the thumb arc at 844 × 390, either side, at every bearing', () => {
    for (const arc of [ARC_844, ARC_844_LEFT]) {
      const bounds = touchBounds(arc);
      for (const angle of ANGLES) {
        const p = place(angle, 844, 390, bounds);
        expect(overlaps(markBox(p.x, p.y), arc), `mark at ${angle.toFixed(3)}`).toBe(false);
        expect(overlaps(labelBox(p.x, p.y, 422, 195, p.on), arc), `label at ${angle.toFixed(3)}`).toBe(false);
      }
    }
    // The review's case: a target to the south-east, which drew at about (681, 293).
    const se = place(Math.atan2(293 - 195, 681 - 422), 844, 390, touchBounds(ARC_844));
    expect(se.x).toBeLessThan(ARC_844.l);
  });

  it('keeps the arrow and its label out of the arc on every phone of the SPEC-037 matrix', () => {
    for (const phone of PHONE_VIEWPORTS) {
      // §4.1: the arc is 262 × 150, and 246 × 122 on a screen 360 px tall or less.
      const [w, h] = phone.height <= 360 ? [246, 122] : [262, 150];
      const arc: Box = { l: phone.width - 16 - w, t: phone.height - 16 - h, r: phone.width - 16, b: phone.height - 16 };
      const bounds = touchBounds(arc);
      for (const angle of ANGLES) {
        const p = place(angle, phone.width, phone.height, bounds);
        const at = `${phone.name} at ${angle.toFixed(3)}`;
        expect(overlaps(markBox(p.x, p.y), arc), `mark, ${at}`).toBe(false);
        expect(overlaps(labelBox(p.x, p.y, phone.width / 2, phone.height / 2, p.on), arc), `label, ${at}`).toBe(false);
      }
    }
  });

  it('never turns the arrow where there is room: the placed point stays on the bearing from the centre', () => {
    const bounds = touchBounds(ARC_844);
    for (const angle of ANGLES) {
      const p = place(angle, 844, 390, bounds);
      const dx = p.x - 422;
      const dy = p.y - 195;
      const len = Math.hypot(dx, dy);
      expect(len).toBeGreaterThan(0);
      expect(dx / len).toBeCloseTo(Math.cos(angle), 6);
      expect(dy / len).toBeCloseTo(Math.sin(angle), 6);
    }
  });

  it('turns an on-screen target under the arc into an edge arrow beside it', () => {
    const bounds = touchBounds(ARC_844);
    const point = { x: 700, y: 300 };
    expect(placeWaypoint(point, false, 844, 390, bounds)).toBe(false);
    expect(overlaps(markBox(point.x, point.y), ARC_844)).toBe(false);
    // A target clear of every box is still the diamond on it.
    const clear = { x: 300, y: 150 };
    expect(placeWaypoint(clear, false, 844, 390, bounds)).toBe(true);
    expect(clear).toEqual({ x: 300, y: 150 });
  });

  it('mirrors a point behind the camera back to its side, then clamps it as an edge arrow', () => {
    const bounds = keyboardBounds(720, BAR_720);
    // Projected above the centre, but behind: the target lies below.
    const point = { x: 640, y: 300 };
    expect(placeWaypoint(point, true, 1280, 720, bounds)).toBe(false);
    expect(point.x).toBeCloseTo(640, 6);
    expect(point.y).toBeGreaterThan(360);
    expect(overlaps(markBox(point.x, point.y), BAR_720)).toBe(false);
  });
});
