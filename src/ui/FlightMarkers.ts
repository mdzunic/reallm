// The flight's markers (SPEC-069 §4.5): the course marker on the line ahead and
// one marker per salvage signal in flight. Each is painted like SPEC-027's
// waypoint — a diamond on its target while that is on screen, an arrow on the
// inset ellipse pointing at it while it is not — through the same
// `placeWaypoint`, so the markers keep out of the HUD boxes the waypoint keeps
// out of. The scene projects the anchors through the camera; this file places
// and paints.
//
// Per-frame discipline (SPEC-027 AC-27): a marker moves through `transform`
// alone and rewrites its label only when the rounded text changes; the
// viewport is measured on `resize`, never in the loop.
import { distanceText } from '@/systems/Guidance';
import { el, testId } from '@/ui/dom';
import { placeWaypoint, waypointBounds, type WaypointBounds } from '@/ui/Waypoint';

/** SPEC-069 §4.5: the most signal markers drawn at once (a trip plans at most five). */
export const MAX_SIGNAL_MARKERS = 5;

export type SignalMarkerKind = 'fuel' | 'oil' | 'missile';

/** §4.5: each kind's glyph in a signal's label. */
export const SIGNAL_GLYPHS: Readonly<Record<SignalMarkerKind, string>> = {
  fuel: '⛽',
  oil: '◆',
  missile: '➤',
};

/** §4.5: the course marker's label — the destination, plus the metres back to the line outside the corridor. */
export function courseLabel(name: string, offLine: number, outside: boolean): string {
  return outside ? `${name} · ${distanceText(offLine)}` : name;
}

/** §4.5: a signal marker's label — its kind's glyph and the lateral gap to the ship. */
export function signalLabel(kind: SignalMarkerKind, gap: number): string {
  return `${SIGNAL_GLYPHS[kind]} ${distanceText(gap)}`;
}

/** One painted marker: its root, mark and label, and what was last written to them. */
class Marker {
  readonly root: HTMLDivElement;
  readonly #label: HTMLSpanElement;
  #state = 'off';
  #kind = '';
  #text = '';
  #x = Number.NaN;
  #y = Number.NaN;
  #angle = Number.NaN;

  constructor(host: HTMLElement, id: string) {
    this.root = testId(el('div', 'flight-marker is-hidden'), id);
    this.root.dataset['state'] = 'off';
    this.root.setAttribute('aria-hidden', 'true');
    this.#label = el('span', 'flight-marker-label');
    this.root.append(el('span', 'flight-marker-mark'), this.#label);
    host.append(this.root);
  }

  /** Place at a screen point already run through `placeWaypoint`. */
  set(kind: string, x: number, y: number, onScreen: boolean, centreX: number, centreY: number, text: string): void {
    const state = onScreen ? 'on' : 'edge';
    if (state !== this.#state) {
      this.#state = state;
      this.root.dataset['state'] = state;
      this.root.classList.remove('is-hidden');
    }
    if (kind !== this.#kind) {
      this.#kind = kind;
      this.root.dataset['kind'] = kind;
    }
    const angle = onScreen ? 0 : Math.atan2(y - centreY, x - centreX) + Math.PI / 2;
    const rx = Math.round(x);
    const ry = Math.round(y);
    if (rx !== this.#x || ry !== this.#y || angle !== this.#angle) {
      this.#x = rx;
      this.#y = ry;
      this.#angle = angle;
      this.root.style.transform = `translate(${rx}px, ${ry}px) rotate(${angle}rad)`;
      // The words stay upright however far the arrow has turned.
      this.#label.style.transform = `rotate(${-angle}rad)`;
    }
    if (text !== this.#text) {
      this.#text = text;
      this.#label.textContent = text;
    }
  }

  hide(): void {
    if (this.#state === 'off') return;
    this.#state = 'off';
    this.root.dataset['state'] = 'off';
    this.root.classList.add('is-hidden');
  }

  get shown(): boolean {
    return this.#state !== 'off';
  }

  get text(): string {
    return this.#text;
  }
}

export class FlightMarkers {
  readonly #course: Marker;
  readonly #signals: Marker[] = [];
  readonly #name: string;
  readonly #point = { x: 0, y: 0 };
  readonly bounds: WaypointBounds = waypointBounds();
  #width = 0;
  #height = 0;
  /** Signals placed since `beginSignals()`. */
  #used = 0;

  /** `name` is the destination's, for the course marker's label. */
  constructor(host: HTMLElement, name: string) {
    this.#name = name;
    this.#course = new Marker(host, 'flight-course');
    this.#course.root.classList.add('flight-course');
    for (let i = 0; i < MAX_SIGNAL_MARKERS; i++) {
      const marker = new Marker(host, 'flight-signal');
      marker.root.classList.add('flight-signal');
      this.#signals.push(marker);
    }
    this.measure();
    globalThis.addEventListener('resize', this.measure);
  }

  /**
   * §4.5: the course marker at a projected screen point. Inside the corridor
   * its label is the destination's name; outside, the name and the metres
   * back to the line.
   */
  setCourse(screenX: number, screenY: number, behind: boolean, offLine: number, outside: boolean): void {
    const point = this.#point;
    point.x = screenX;
    point.y = screenY;
    const onScreen = placeWaypoint(point, behind, this.#width, this.#height, this.bounds);
    this.#course.set('course', point.x, point.y, onScreen, this.#width / 2, this.#height / 2, courseLabel(this.#name, offLine, outside));
  }

  hideCourse(): void {
    this.#course.hide();
  }

  /** Start a frame's signal markers; `addSignal` fills them, `endSignals` hides the rest. */
  beginSignals(): void {
    this.#used = 0;
  }

  /** §4.5: one signal at a projected point, with its kind's glyph and the lateral gap. */
  addSignal(kind: SignalMarkerKind, screenX: number, screenY: number, behind: boolean, gap: number): void {
    if (this.#used >= this.#signals.length) return;
    const marker = this.#signals[this.#used] as Marker;
    this.#used++;
    const point = this.#point;
    point.x = screenX;
    point.y = screenY;
    const onScreen = placeWaypoint(point, behind, this.#width, this.#height, this.bounds);
    marker.set(kind, point.x, point.y, onScreen, this.#width / 2, this.#height / 2, signalLabel(kind, gap));
  }

  endSignals(): void {
    for (let i = this.#used; i < this.#signals.length; i++) (this.#signals[i] as Marker).hide();
  }

  /** For the tests: how many signal markers are up, and the course marker's text. */
  get shownSignals(): number {
    let count = 0;
    for (const marker of this.#signals) if (marker.shown) count++;
    return count;
  }

  get courseText(): string {
    return this.#course.text;
  }

  dispose(): void {
    globalThis.removeEventListener('resize', this.measure);
    this.#course.root.remove();
    for (const marker of this.#signals) marker.root.remove();
  }

  /** The viewport, measured on `resize` only. */
  readonly measure = (): void => {
    this.#width = globalThis.innerWidth;
    this.#height = globalThis.innerHeight;
  };
}
