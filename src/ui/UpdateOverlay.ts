// The update-available banner (SPEC-014 §4.9, AC-103; SPEC-015 §10, D-10).
//
// The signal is the typed `app:update-ready` event, not
// `serviceWorker.controllerchange`: in the plugin's `registerType: 'prompt'`
// mode a waiting worker never takes over on its own, so `controllerchange`
// never fires and the banner would never show (D-10). `main.ts` emits the event
// from `onNeedRefresh`.
//
// The banner only *says* an update exists. Applying it is a button on the menu
// and the station, and nowhere else: restarting mid-run would lose field
// progress, so the station is the safe moment (15-c, AC-52).
import type { EmitArgs, GameEvents } from '@/core/Events';
import { el, testId } from '@/ui/dom';

interface UpdateEvents {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
  on<K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void, owner: object): () => void;
}

export const UPDATE_BANNER_TEXT = 'Update ready — restart at the station to update';

export class UpdateOverlay {
  readonly #root: HTMLDivElement;
  readonly #release: () => void;

  constructor(root: HTMLElement, events: UpdateEvents) {
    this.#root = testId(el('div', 'update-banner'), 'update-overlay');
    this.#root.setAttribute('role', 'status');
    this.#root.textContent = UPDATE_BANNER_TEXT;
    root.append(this.#root);
    this.#release = events.on('app:update-ready', () => this.show(), this);
  }

  show(): void {
    this.#root.classList.add('is-visible');
  }

  hide(): void {
    this.#root.classList.remove('is-visible');
  }

  dispose(): void {
    this.#release();
    this.#root.remove();
  }
}
