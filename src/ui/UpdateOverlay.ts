// The update-available banner (SPEC-014 §4.9, AC-103). The PWA half is M7's
// (`vite-plugin-pwa`); until it registers a service worker the listener below
// never fires and the banner never shows — which is the correct answer to
// "no update exists". The wording is the spec's: restarting mid-run would
// lose field progress, so the station is the safe moment.
import { el, testId } from '@/ui/dom';

export class UpdateOverlay {
  readonly #root: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.#root = testId(el('div', 'update-banner'), 'update-overlay');
    this.#root.setAttribute('role', 'status');
    this.#root.textContent = 'Update ready — restart at the station to update';
    root.append(this.#root);
    // M7's seam: the waiting worker taking over is the "update available" signal.
    navigator.serviceWorker?.addEventListener('controllerchange', this.#onUpdate);
  }

  readonly #onUpdate = (): void => this.show();

  show(): void {
    this.#root.classList.add('is-visible');
  }

  hide(): void {
    this.#root.classList.remove('is-visible');
  }

  dispose(): void {
    navigator.serviceWorker?.removeEventListener('controllerchange', this.#onUpdate);
    this.#root.remove();
  }
}
