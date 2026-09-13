// The scan progress ring (SPEC-027 §4.3, §4.9) — the three seconds SPEC-012
// already counts, drawn where the player is standing. It reports an action the
// player is performing rather than leading them anywhere, so it survives
// `guidance: 'off'` (D-5).
import { el, testId } from '@/ui/dom';

export class ScanRing {
  readonly #root: HTMLDivElement;
  #x = Number.NaN;
  #y = Number.NaN;
  #fraction = -1;
  #shown = false;

  constructor(root: HTMLElement) {
    this.#root = testId(el('div', 'scan-ring is-hidden'), 'scan-progress');
    this.#root.setAttribute('role', 'progressbar');
    this.#root.setAttribute('aria-label', 'Scan progress');
    this.#root.setAttribute('aria-hidden', 'true');
    root.append(this.#root);
  }

  /** `fraction` is 0..1 of `SCAN_SECONDS`; the conic fill is a CSS variable. */
  set(screenX: number, screenY: number, fraction: number): void {
    const clamped = Math.max(0, Math.min(1, fraction));
    const x = Math.round(screenX);
    const y = Math.round(screenY);
    if (x !== this.#x || y !== this.#y) {
      this.#x = x;
      this.#y = y;
      this.#root.style.transform = `translate(${x}px, ${y}px)`;
    }
    // Two decimals is a hundredth of a turn — finer than the ring can show.
    const rounded = Math.round(clamped * 100) / 100;
    if (rounded !== this.#fraction) {
      this.#fraction = rounded;
      this.#root.style.setProperty('--scan', String(rounded));
      this.#root.setAttribute('aria-valuenow', String(Math.round(rounded * 100)));
    }
    if (!this.#shown) {
      this.#shown = true;
      this.#root.classList.remove('is-hidden');
    }
  }

  hide(): void {
    if (!this.#shown) return;
    this.#shown = false;
    this.#root.classList.add('is-hidden');
  }

  dispose(): void {
    this.#root.remove();
  }
}
