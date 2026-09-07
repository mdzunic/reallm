// Page lifecycle (SPEC-002 §3.9, §4.4). One place that listens to
// `visibilitychange`, `blur` and `pagehide`, and fans each out to the hooks
// systems register — so a phone lock pauses the loop, releases held input,
// suspends audio and flushes the save without every one of those systems
// growing its own listener.
//
// `beforeunload` is deliberately absent (§4.4): it prompts on some browsers and
// is unreliable on mobile. `pagehide` is the one that fires when a phone
// browser discards the page.
//
// The document and window are injected so the unit tests drive them with fakes.
import { log } from '@/core/Log';

export interface LifecycleHooks {
  onHidden?(): void;
  onVisible?(): void;
  onBlur?(): void;
  onPageHide?(): void;
}

export interface LifecycleTarget {
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
}

interface Binding {
  readonly target: LifecycleTarget;
  readonly type: string;
  readonly handler: () => void;
}

export class PageLifecycle {
  readonly #doc: LifecycleTarget & { readonly hidden: boolean };
  readonly #win: LifecycleTarget;
  readonly #hooks: LifecycleHooks[] = [];
  readonly #bindings: Binding[] = [];

  constructor(opts: { doc: LifecycleTarget & { readonly hidden: boolean }; win: LifecycleTarget }) {
    this.#doc = opts.doc;
    this.#win = opts.win;
    this.#bind(this.#doc, 'visibilitychange', () => this.#run(this.#doc.hidden ? 'onHidden' : 'onVisible'));
    this.#bind(this.#win, 'blur', () => this.#run('onBlur'));
    this.#bind(this.#win, 'pagehide', () => this.#run('onPageHide'));
  }

  /** Register hooks; the returned function unsubscribes them and nothing else. */
  add(hooks: LifecycleHooks): () => void {
    this.#hooks.push(hooks);
    return () => {
      const at = this.#hooks.indexOf(hooks);
      if (at >= 0) this.#hooks.splice(at, 1);
    };
  }

  /** Remove every listener from `doc` and `win`, and forget every hook. */
  dispose(): void {
    for (const binding of this.#bindings) binding.target.removeEventListener(binding.type, binding.handler);
    this.#bindings.length = 0;
    this.#hooks.length = 0;
  }

  #bind(target: LifecycleTarget, type: string, handler: () => void): void {
    target.addEventListener(type, handler);
    this.#bindings.push({ target, type, handler });
  }

  /**
   * Registration order, and one broken hook never strands the ones behind it
   * (§3.9): a thrown error is logged and the run continues. The copy guards
   * against a hook that unsubscribes itself while the list is being walked.
   */
  #run(key: keyof LifecycleHooks): void {
    for (const hooks of [...this.#hooks]) {
      try {
        hooks[key]?.();
      } catch (error) {
        log.error('lifecycle', `a ${key} hook threw`, error);
      }
    }
  }
}
