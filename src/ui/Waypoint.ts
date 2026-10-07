// The waypoint marker (SPEC-027 §4.3) — a gold diamond on the focus target
// while it is on screen, and an arrow on an inset ellipse pointing at it while
// it is not. The scene projects the anchor and decides which of the two it is;
// this file only paints.
//
// Per-frame discipline (AC-27): the element is moved with `transform` alone,
// the distance is rewritten only when its rounded text changes, and the
// viewport centre the edge rotation needs is measured on `resize`, never in the
// loop.
//
// Review 2026-10 V-04: the marker keeps out of the HUD it would otherwise sit
// on — the quick bar's band on the keyboard scheme, the thumb arc's corner on
// touch. Their boxes are read on `resize`, when either changes size, and when
// the scene says the UI scale or the stick's side moved them; `placeWaypoint`
// then works from those numbers alone, so the loop reads no DOM.
import { distanceText } from '@/systems/Guidance';
import { el, testId } from '@/ui/dom';

/** SPEC-027 §4.3: the ellipse's inset from the viewport edge, and its floor (27-k). */
export const WAYPOINT_INSET = 56;
export const WAYPOINT_MIN_AXIS = 40;
/** V-04: the clear gap the marker and its label keep from a HUD box. */
export const WAYPOINT_HUD_GAP = 12;
/** Half the 22 px mark, plus its 2 px outline. */
const MARK_HALF = 13;
/**
 * The distance label's centre sits this far inward along the ray from the
 * mark's (`.waypoint-dist`: 24 px under a 22 px box, a 17 px line), and below
 * the diamond when the target is on screen. The half extents cover the widest
 * label, `990 m` at 14 px.
 */
const LABEL_OFFSET = 22;
const LABEL_HALF_W = 24;
const LABEL_HALF_H = 10;
/** A clamp that would leave the mark nearer the centre than this gives up — there is no room. */
const MIN_REACH = WAYPOINT_MIN_AXIS;

/**
 * Where the marker may go: the ellipse's inset on each side, and the HUD boxes
 * it keeps out of, flattened as `left, top, right, bottom` per box (viewport
 * px). Written by `Waypoint.measure()`, read every frame.
 */
export interface WaypointBounds {
  top: number;
  right: number;
  bottom: number;
  left: number;
  readonly boxes: number[];
}

export function waypointBounds(): WaypointBounds {
  return { top: WAYPOINT_INSET, right: WAYPOINT_INSET, bottom: WAYPOINT_INSET, left: WAYPOINT_INSET, boxes: [] };
}

/**
 * The ray parameter at which `c + s·d` enters the box, when the point at `t`
 * lies inside it; `Infinity` when it does not. The ray starts at the viewport
 * centre, so every point before the entry is outside the (convex) box; an
 * entry at or below 0 means the centre itself is inside.
 */
function entry(cx: number, cy: number, dx: number, dy: number, t: number, l: number, top: number, r: number, b: number): number {
  const x = cx + t * dx;
  const y = cy + t * dy;
  if (x < l || x > r || y < top || y > b) return Number.POSITIVE_INFINITY;
  let s = Number.NEGATIVE_INFINITY;
  if (dx !== 0) s = Math.max(s, Math.min((l - cx) / dx, (r - cx) / dx));
  if (dy !== 0) s = Math.max(s, Math.min((top - cy) / dy, (b - cy) / dy));
  return s;
}

/**
 * §4.3, V-04 — where the marker goes, for a target projected at `point` (moved
 * in place) on a `width` × `height` viewport. Returns whether it is on screen:
 * inside the inset ellipse, in front of the camera, and clear of every HUD box
 * with its label. Otherwise the point is moved along the ray from the centre —
 * onto the ellipse, whose half-axes take each side's own inset, and then back
 * to where neither the mark nor its label (which sits inward along the ray)
 * meets a box. The bearing never changes, so the arrow still points true.
 * Allocates nothing.
 */
export function placeWaypoint(point: { x: number; y: number }, behind: boolean, width: number, height: number, bounds: WaypointBounds): boolean {
  const cx = width / 2;
  const cy = height / 2;
  let dx = point.x - cx;
  let dy = point.y - cy;
  // A point behind the camera projects mirrored; put it back on the side the
  // target actually lies, and treat it as off screen (§4.3).
  if (behind) {
    dx = -dx;
    dy = -dy;
  }
  const ax = Math.max(WAYPOINT_MIN_AXIS, cx - (dx >= 0 ? bounds.right : bounds.left));
  const by = Math.max(WAYPOINT_MIN_AXIS, cy - (dy >= 0 ? bounds.bottom : bounds.top));
  const norm = Math.hypot(dx / ax, dy / by);
  let onScreen = !behind && norm <= 1;
  const boxes = bounds.boxes;
  // On screen, the diamond's label hangs straight below it.
  if (onScreen) {
    for (let i = 0; i + 3 < boxes.length; i += 4) {
      const l = boxes[i] as number;
      const top = boxes[i + 1] as number;
      const r = boxes[i + 2] as number;
      const b = boxes[i + 3] as number;
      const hitsMark = point.x >= l - MARK_HALF && point.x <= r + MARK_HALF && point.y >= top - MARK_HALF && point.y <= b + MARK_HALF;
      const ly = point.y + LABEL_OFFSET;
      const hitsLabel = point.x >= l - LABEL_HALF_W && point.x <= r + LABEL_HALF_W && ly >= top - LABEL_HALF_H && ly <= b + LABEL_HALF_H;
      if (hitsMark || hitsLabel) {
        onScreen = false;
        break;
      }
    }
    if (onScreen) return true;
  }
  let t = norm > 1 || (behind && norm > 0) ? 1 / norm : 1;
  const len = Math.hypot(dx, dy);
  /** A box the ray cannot be backed out of — it reaches too near the centre. */
  let cornered = -1;
  if (len > 0) {
    // The label's centre is LABEL_OFFSET inward along the ray from the mark's.
    const ox = (-dx / len) * LABEL_OFFSET;
    const oy = (-dy / len) * LABEL_OFFSET;
    const g = WAYPOINT_HUD_GAP;
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (let i = 0; i + 3 < boxes.length; i += 4) {
        const l = boxes[i] as number;
        const top = boxes[i + 1] as number;
        const r = boxes[i + 2] as number;
        const b = boxes[i + 3] as number;
        const m = MARK_HALF + g;
        const markIn = entry(cx, cy, dx, dy, t, l - m, top - m, r + m, b + m);
        const labelIn = entry(
          cx,
          cy,
          dx,
          dy,
          t,
          l - LABEL_HALF_W - g - ox,
          top - LABEL_HALF_H - g - oy,
          r + LABEL_HALF_W + g - ox,
          b + LABEL_HALF_H + g - oy,
        );
        // Before whichever of the two the ray meets first, so both stay clear.
        const s = Math.min(markIn, labelIn);
        if (s >= t) continue;
        if (s * len >= MIN_REACH) {
          // Back along the ray to the box's edge, a hair outside it.
          t = Math.max(0, s - 0.5 / len);
          moved = true;
        } else {
          cornered = i;
        }
      }
      if (!moved) break;
    }
  }
  point.x = cx + t * dx;
  point.y = cy + t * dy;
  // On a narrow phone the arc can fill the whole quadrant past the player:
  // there the bearing gives a little, and the mark stands just above the box
  // (or below one in the top half) — its label, inward of it, is clear too.
  if (cornered >= 0) {
    const m = MARK_HALF + WAYPOINT_HUD_GAP;
    const top = boxes[cornered + 1] as number;
    const b = boxes[cornered + 3] as number;
    if (top > cy) point.y = Math.min(point.y, top - m);
    else point.y = Math.max(point.y, b + m);
  }
  return false;
}

/** The HUD boxes the marker avoids: the quick bar (keyboard) and the thumb arc (touch). */
const BAR_SELECTOR = '.hud .quickbar';
const ARC_SELECTOR = '.hud .thumb-arc';

export class Waypoint {
  readonly #root: HTMLDivElement;
  readonly #mark: HTMLSpanElement;
  readonly #label: HTMLSpanElement;
  #centreX = 0;
  #centreY = 0;
  #text = '';
  #x = Number.NaN;
  #y = Number.NaN;
  #angle = Number.NaN;
  #state = '';
  #pulse = false;
  /** V-04: the ellipse's insets and the HUD boxes, for `placeWaypoint`. */
  readonly bounds: WaypointBounds = waypointBounds();
  readonly #hud: ParentNode | null;
  #observer: ResizeObserver | null = null;

  /**
   * `hud` is where the quick bar and the thumb arc live (the UI root); with
   * none, the marker keeps SPEC-027's plain ellipse.
   */
  constructor(root: HTMLElement, hud: ParentNode | null = null) {
    this.#root = testId(el('div', 'waypoint is-hidden'), 'waypoint');
    this.#root.dataset['state'] = 'off';
    this.#root.setAttribute('aria-hidden', 'true');
    this.#mark = el('span', 'waypoint-mark');
    this.#label = el('span', 'waypoint-dist');
    this.#root.append(this.#mark, this.#label);
    root.append(this.#root);
    this.#hud = hud;
    this.measure();
    globalThis.addEventListener('resize', this.measure);
    // V-04: the bar changes size when it moves into the arc, and the arc when
    // it shows; a ResizeObserver callback is an event, not the loop.
    if (hud !== null && typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => this.measure());
      for (const selector of [BAR_SELECTOR, ARC_SELECTOR]) {
        const node = hud.querySelector(selector);
        if (node !== null) observer.observe(node);
      }
      this.#observer = observer;
    }
  }

  /**
   * §4.3 — place the marker at a screen point. `onScreen` is the scene's
   * ellipse test: inside it the point is the target itself, outside it the
   * point has already been clamped onto the ellipse, and the marker turns
   * outward along the ray from the centre.
   */
  set(screenX: number, screenY: number, distance: number, onScreen: boolean, pulse: boolean): void {
    const state = onScreen ? 'on' : 'edge';
    if (state !== this.#state) {
      this.#state = state;
      this.#root.dataset['state'] = state;
      this.#root.classList.remove('is-hidden');
    }
    // Rotation is the ray's bearing; an on-screen diamond never turns.
    const angle = onScreen ? 0 : Math.atan2(screenY - this.#centreY, screenX - this.#centreX) + Math.PI / 2;
    const x = Math.round(screenX);
    const y = Math.round(screenY);
    if (x !== this.#x || y !== this.#y || angle !== this.#angle) {
      this.#x = x;
      this.#y = y;
      this.#angle = angle;
      this.#root.style.transform = `translate(${x}px, ${y}px) rotate(${angle}rad)`;
      // The metres stay upright however far the arrow has turned.
      this.#label.style.transform = `rotate(${-angle}rad)`;
    }
    const text = distanceText(distance);
    if (text !== this.#text) {
      this.#text = text;
      this.#label.textContent = text;
    }
    if (pulse !== this.#pulse) {
      this.#pulse = pulse;
      this.#root.classList.toggle('is-stuck', pulse);
    }
  }

  /** D-17: `off` plus the class the HUD already styles `display: none`. */
  hide(): void {
    if (this.#state === 'off') return;
    this.#state = 'off';
    this.#root.dataset['state'] = 'off';
    this.#root.classList.add('is-hidden');
  }

  dispose(): void {
    globalThis.removeEventListener('resize', this.measure);
    this.#observer?.disconnect();
    this.#observer = null;
    this.#root.remove();
  }

  /**
   * The viewport centre, and V-04's bounds: on touch the arc's box, which the
   * mark and its label stay out of; on the keyboard the quick bar's band, which
   * lifts the ellipse's bottom to the bar's top less the gap. A box that is not
   * drawn (zero size) is not there. Called on `resize`, from the observer, and
   * by the scene when the UI scale or the stick's side moves the HUD.
   */
  readonly measure = (): void => {
    const width = globalThis.innerWidth;
    const height = globalThis.innerHeight;
    this.#centreX = width / 2;
    this.#centreY = height / 2;
    const bounds = this.bounds;
    bounds.top = WAYPOINT_INSET;
    bounds.right = WAYPOINT_INSET;
    bounds.bottom = WAYPOINT_INSET;
    bounds.left = WAYPOINT_INSET;
    bounds.boxes.length = 0;
    const hud = this.#hud;
    if (hud === null) return;
    const arc = hud.querySelector(ARC_SELECTOR)?.getBoundingClientRect();
    if (arc !== undefined && arc.width > 0 && arc.height > 0) {
      bounds.boxes.push(arc.left, arc.top, arc.right, arc.bottom);
      return;
    }
    const bar = hud.querySelector(BAR_SELECTOR)?.getBoundingClientRect();
    if (bar !== undefined && bar.width > 0 && bar.height > 0) {
      bounds.bottom = Math.max(WAYPOINT_INSET, height - bar.top + WAYPOINT_HUD_GAP + MARK_HALF);
    }
  };
}
