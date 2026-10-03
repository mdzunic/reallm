// The stamina ring (SPEC-050 §4.6) — a 30 px ring beside the salvager's head,
// where the eyes already are during a chase, rather than a bar in the top band
// the thumbs would have to leave the stick and the arc to read. It shows the
// same on both schemes, and hides when there is nothing to say: the scene
// passes `HudModel.stamina.shown`, false once a full pool has sat out of
// combat for a second, and the ring fades over 0.2 s (reduce motion snaps).
//
// The fill is a conic gradient on `--stamina` (0…1) with a notch at 30, where
// exhaustion ends; an exhausted ring is amber *and* dashed, so the state never
// rides on hue alone. Like the scan ring, the scene places it in `render()` and
// it writes the DOM only when a rounded value changes.
import type { HudModel } from '@/systems/UiHelpers';
import { el, testId } from '@/ui/dom';

/** §4.6: px from the projection of the salvager's head (y + 1.6 m). */
export const STAMINA_RING_OFFSET = { x: 24, y: -36 } as const;

export class StaminaRing {
  readonly #root: HTMLDivElement;
  #x = Number.NaN;
  #y = Number.NaN;
  #fraction = -1;
  #value = -1;
  #max = -1;
  #exhausted = false;
  #sprinting = false;
  /** Whether the model asked for the ring to be up; `null` before the first `set`. */
  #shown: boolean | null = null;
  /** `hide()`'s state: out of the layout at once, with no fade. */
  #hidden = true;

  constructor(root: HTMLElement) {
    this.#root = testId(el('div', 'stamina-ring is-hidden is-faded'), 'hud-stamina');
    // One per scene, so its testid doubles as its id.
    this.#root.id = 'hud-stamina';
    this.#root.setAttribute('role', 'meter');
    this.#root.setAttribute('aria-label', 'Stamina');
    this.#root.setAttribute('aria-valuemin', '0');
    this.#root.append(el('div', 'stamina-ring-fill'), el('span', 'stamina-ring-notch'));
    root.append(this.#root);
  }

  /** Places the ring at the head's projection plus `STAMINA_RING_OFFSET` and draws `model`. */
  set(screenX: number, screenY: number, model: NonNullable<HudModel['stamina']>): void {
    const root = this.#root;
    const x = Math.round(screenX + STAMINA_RING_OFFSET.x);
    const y = Math.round(screenY + STAMINA_RING_OFFSET.y);
    if (x !== this.#x || y !== this.#y) {
      this.#x = x;
      this.#y = y;
      root.style.transform = `translate(${x}px, ${y}px)`;
    }
    const max = Math.max(1, model.max);
    if (max !== this.#max) {
      this.#max = max;
      root.setAttribute('aria-valuemax', String(Math.round(max)));
    }
    // Two decimals is a hundredth of a turn — finer than 30 px can show.
    const fraction = Math.round(Math.max(0, Math.min(1, model.value / max)) * 100) / 100;
    if (fraction !== this.#fraction) {
      this.#fraction = fraction;
      root.style.setProperty('--stamina', String(fraction));
    }
    const value = Math.round(model.value);
    if (value !== this.#value) {
      this.#value = value;
      root.setAttribute('aria-valuenow', String(value));
    }
    if (model.exhausted !== this.#exhausted) {
      this.#exhausted = model.exhausted;
      root.classList.toggle('is-exhausted', model.exhausted);
    }
    if (model.sprinting !== this.#sprinting) {
      this.#sprinting = model.sprinting;
      root.classList.toggle('is-sprinting', model.sprinting);
    }
    if (model.shown !== this.#shown) {
      this.#shown = model.shown;
      root.classList.toggle('is-faded', !model.shown);
    }
    if (this.#hidden) {
      this.#hidden = false;
      root.classList.remove('is-hidden');
    }
  }

  /** Off at once — a dead salvager, or a beat or the map holding the screen. */
  hide(): void {
    if (this.#hidden) return;
    this.#hidden = true;
    this.#root.classList.add('is-hidden');
  }

  dispose(): void {
    this.#root.remove();
  }
}
