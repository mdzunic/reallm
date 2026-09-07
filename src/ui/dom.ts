// The DOM plumbing of the UI layer (SPEC-014 §3). Plain DOM: no framework, no
// `three` (SPEC-001 §4). `h()` is the whole templating story — a tag, an attrs
// bag, children — and `UiRoot` owns the three stacking layers inside `#ui`,
// the per-frame flush list, the shared fade, and the toast rack.
//
// `#ui` itself is `pointer-events: none`; anything interactive opts back in
// through the `.panel`/`pointer-events: auto` CSS, so the canvas keeps
// receiving gameplay pointers while panels receive theirs.
import {
  pruneToasts,
  pushToast,
  TOAST_DEFAULT_MS,
  type ToastEntry,
  type ToastKind,
} from '@/systems/UiHelpers';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `#ui` itself is `pointer-events: none`; a test hook makes elements findable. */
export function testId<T extends HTMLElement>(node: T, id: string): T {
  node.dataset['testid'] = id;
  return node;
}

/**
 * The tiny element helper of §3. Attribute rules, in order:
 *   - a function value on an `onclick`-style key becomes a listener;
 *   - `class` writes `className`;
 *   - `true` sets an empty attribute, `false` sets nothing (so `disabled: flag`
 *     reads naturally);
 *   - everything else is `setAttribute`, stringified.
 * `null` children are skipped, so conditional markup stays an expression.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number | boolean | ((e: Event) => void)>,
  ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (typeof value === 'function') {
      node.addEventListener(key.startsWith('on') ? key.slice(2) : key, value);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else if (value !== false) {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child !== null) node.append(child);
  }
  return node;
}

/** What `UiRoot.flush()` drives once per frame; the HUD registers one. */
export interface Flushable {
  flush(): void;
}

const LAYERS = ['hud', 'panel', 'overlay'] as const;
export type UiLayer = (typeof LAYERS)[number];

/**
 * The `#ui` root of §3: three stacking layers (`hud` under `panel` under
 * `overlay`), a flush list the frame loop drives, the shared black fade, and
 * the toast rack of §4.6. One instance per `#ui` element — `uiLayers()` below
 * is how scenes reach the shared one without `core/` having to know the type.
 */
export class UiRoot {
  readonly root: HTMLElement;
  readonly #layers: Record<UiLayer, HTMLDivElement>;
  readonly #flushables = new Set<Flushable>();
  readonly #fade: HTMLDivElement;
  readonly #toastRack: HTMLDivElement;
  #toasts: ToastEntry[] = [];
  #toastTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #now: () => number;

  constructor(root: HTMLElement, now: () => number = Date.now) {
    this.root = root;
    this.#now = now;
    this.#layers = {} as Record<UiLayer, HTMLDivElement>;
    for (const layer of LAYERS) {
      const div = el('div', `ui-layer ui-layer-${layer}`);
      this.#layers[layer] = div;
      root.append(div);
    }
    this.#fade = el('div', 'overlay-fade ui-fade');
    this.#fade.setAttribute('aria-hidden', 'true');
    this.#toastRack = testId(el('div', 'toast-rack'), 'toasts');
    this.#toastRack.setAttribute('role', 'status');
    this.#toastRack.setAttribute('aria-live', 'polite');
    this.#layers.overlay.append(this.#toastRack, this.#fade);
  }

  mount(node: HTMLElement, layer: UiLayer): void {
    this.#layers[layer].append(node);
  }

  unmount(node: HTMLElement): void {
    node.remove();
  }

  /** HUD instances register here; `flush()` runs after render, once a frame. */
  register(flushable: Flushable): () => void {
    this.#flushables.add(flushable);
    return () => this.#flushables.delete(flushable);
  }

  flush(): void {
    for (const flushable of this.#flushables) flushable.flush();
  }

  // ------------------------------------------------------------------- fades

  /** A fade of the UI's own (the escape ending); scene fades stay SPEC-003's. */
  fadeOut(ms: number): Promise<void> {
    return this.#fadeTo(0, 1, ms);
  }

  async fadeIn(ms: number): Promise<void> {
    await this.#fadeTo(1, 0, ms);
    this.#fade.classList.remove('is-active');
  }

  async #fadeTo(from: number, to: number, ms: number): Promise<void> {
    this.#fade.classList.add('is-active');
    this.#fade.style.opacity = String(from);
    if (ms > 0) {
      const animation = this.#fade.animate([{ opacity: from }, { opacity: to }], {
        duration: ms,
        easing: 'linear',
        fill: 'forwards',
      });
      try {
        await animation.finished;
      } catch {
        // A cancelled animation still ends at `to` below.
      }
      animation.cancel();
    }
    this.#fade.style.opacity = String(to);
  }

  // ------------------------------------------------------------------ toasts

  /** §4.6: up to three, coalesced by text; the pure queue is unit-tested. */
  toast(text: string, kind: ToastKind = 'info', ms: number = TOAST_DEFAULT_MS): void {
    this.#toasts = pushToast(this.#toasts, text, kind, this.#now(), ms);
    this.#renderToasts();
    this.#armToastTimer();
  }

  #renderToasts(): void {
    this.#toastRack.replaceChildren(
      ...this.#toasts.map((entry) =>
        h(
          'div',
          { class: `toast toast-${entry.kind}` },
          entry.text,
          entry.count > 1 ? el('span', 'toast-count', `×${entry.count}`) : null,
        ),
      ),
    );
  }

  /** One timer, always for the earliest expiry; re-armed after every change. */
  #armToastTimer(): void {
    if (this.#toastTimer !== null) clearTimeout(this.#toastTimer);
    this.#toastTimer = null;
    if (this.#toasts.length === 0) return;
    const next = Math.min(...this.#toasts.map((entry) => entry.expiresAt));
    this.#toastTimer = setTimeout(() => {
      this.#toasts = pruneToasts(this.#toasts, this.#now());
      this.#renderToasts();
      this.#armToastTimer();
    }, Math.max(0, next - this.#now()) + 10);
  }

  dispose(): void {
    if (this.#toastTimer !== null) clearTimeout(this.#toastTimer);
    for (const layer of LAYERS) this.#layers[layer].remove();
    this.#fade.remove();
  }
}

const ROOTS = new WeakMap<HTMLElement, UiRoot>();

/**
 * The shared `UiRoot` for a `#ui` element. Scenes hold `services.uiRoot` (a
 * bare `HTMLElement`, because `core/` may not import `ui/`); this is the one
 * place that upgrades it, so toasts and layers survive scene swaps.
 */
export function uiLayers(root: HTMLElement): UiRoot {
  let instance = ROOTS.get(root);
  if (instance === undefined) {
    instance = new UiRoot(root);
    ROOTS.set(root, instance);
  }
  return instance;
}
