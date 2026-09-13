// The waypoint marker (SPEC-027 §4.3) — a gold diamond on the focus target
// while it is on screen, and an arrow on an inset ellipse pointing at it while
// it is not. The scene projects the anchor and decides which of the two it is;
// this file only paints.
//
// Per-frame discipline (AC-27): the element is moved with `transform` alone,
// the distance is rewritten only when its rounded text changes, and the
// viewport centre the edge rotation needs is measured on `resize`, never in the
// loop.
import { distanceText } from '@/systems/Guidance';
import { el, testId } from '@/ui/dom';

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

  constructor(root: HTMLElement) {
    this.#root = testId(el('div', 'waypoint is-hidden'), 'waypoint');
    this.#root.dataset['state'] = 'off';
    this.#root.setAttribute('aria-hidden', 'true');
    this.#mark = el('span', 'waypoint-mark');
    this.#label = el('span', 'waypoint-dist');
    this.#root.append(this.#mark, this.#label);
    root.append(this.#root);
    this.#measure();
    globalThis.addEventListener('resize', this.#measure);
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
    globalThis.removeEventListener('resize', this.#measure);
    this.#root.remove();
  }

  readonly #measure = (): void => {
    this.#centreX = globalThis.innerWidth / 2;
    this.#centreY = globalThis.innerHeight / 2;
  };
}
