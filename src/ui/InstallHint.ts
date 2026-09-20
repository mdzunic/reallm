// The iOS "Add to Home Screen" explainer (SPEC-015 §10, AC-55).
//
// iOS Safari has no install prompt and no `beforeinstallprompt`, and it clears
// site data after seven unused days unless the game is on the Home Screen
// (SPEC-007 §4.7). The toast raised there says *why* it matters; this says
// *how*, in two taps, because "add to home screen" is not a thing the browser
// will do on anyone's behalf.
//
// It is a dismissible sheet, not a modal: the player can ignore it and keep
// playing, and it never shows more often than the hint that opens it does.
import type { EmitArgs, GameEvents } from '@/core/Events';
import { el, h, testId } from '@/ui/dom';

interface InstallEvents {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
  on<K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void, owner: object): () => void;
}

export const INSTALL_STEPS: readonly string[] = [
  'Tap the Share button in Safari’s toolbar.',
  'Choose “Add to Home Screen”.',
  'Open ReaLLM from the Home Screen — it runs full-screen and keeps your saves.',
];

export class InstallHintOverlay {
  readonly #root: HTMLDivElement;
  readonly #release: () => void;

  constructor(root: HTMLElement, events: InstallEvents) {
    this.#root = testId(el('div', 'install-hint panel is-hidden'), 'install-hint');
    this.#root.setAttribute('role', 'dialog');
    this.#root.setAttribute('aria-label', 'Add ReaLLM to your Home Screen');
    const close = testId(
      h('button', { class: 'ui-btn', type: 'button', click: () => this.hide() }, 'Got it'),
      'install-hint-close',
    );
    const steps = el('ol', 'install-hint-steps');
    for (const step of INSTALL_STEPS) steps.append(el('li', '', step));
    this.#root.append(el('p', 'install-hint-title', 'Add to Home Screen'), steps, close);
    root.append(this.#root);
    this.#release = events.on('app:install-hint', () => this.show(), this);
  }

  get open(): boolean {
    return !this.#root.classList.contains('is-hidden');
  }

  show(): void {
    this.#root.classList.remove('is-hidden');
  }

  hide(): void {
    this.#root.classList.add('is-hidden');
  }

  dispose(): void {
    this.#release();
    this.#root.remove();
  }
}
