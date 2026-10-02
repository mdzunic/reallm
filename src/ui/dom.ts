// The DOM plumbing of the UI layer (SPEC-014 §3). Plain DOM: no framework, no
// `three` (SPEC-001 §4). `h()` is the whole templating story — a tag, an attrs
// bag, children — and `UiRoot` owns the three stacking layers inside `#ui`,
// the per-frame flush list, the shared fade, and the toast rack.
//
// `#ui` itself is `pointer-events: none`; anything interactive opts back in
// through the `.panel`/`pointer-events: auto` CSS, so the canvas keeps
// receiving gameplay pointers while panels receive theirs.
import { BackStack } from '@/core/BackGuard';
import {
  pruneToasts,
  pushToast,
  shiftToasts,
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

// ------------------------------------------------------- focus (SPEC-044)

/**
 * SPEC-044 §3: what keyboard focus can land on — the set `keepFocus` and
 * `openModal` count with. A roving tab (`tabindex="-1"`) is not in it.
 */
export const FOCUSABLE =
  'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';

/** Every `FOCUSABLE` match inside `root`, in document order. */
function focusablesIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/** …of which the ones that are laid out — a `display: none` control cannot take focus. */
function shownFocusablesIn(root: ParentNode): HTMLElement[] {
  return focusablesIn(root).filter((node) => node.getClientRects().length > 0);
}

/** The element under `root` whose `data-testid` is exactly `id`, compared as text (no selector escaping). */
function byTestId(root: HTMLElement, id: string): HTMLElement | null {
  for (const node of root.querySelectorAll<HTMLElement>('[data-testid]')) {
    if (node.dataset['testid'] === id) return node;
  }
  return null;
}

/**
 * A control focus may go back to: a `FOCUSABLE` match, or a tab of a roving
 * tablist — which is `tabindex="-1"` while another tab is selected, and is
 * still where the arrow keys left the player.
 */
function refocusable(node: HTMLElement): boolean {
  return node.matches(FOCUSABLE) || node.matches('[role="tab"]:not(:disabled)');
}

/**
 * Runs `render`; if focus was inside `container`, re-focuses by testid, then by
 * the row's testid, then by index (SPEC-044 §4.2):
 *   1. the element with the recorded `data-testid`, if it is a control;
 *   2. the first control inside the element named by the testid with its
 *      trailing `-<segment>`s dropped one at a time (`mission-c2_m1-accept`
 *      → `mission-c2_m1`) — Accept became Star Map, Pin and Abandon (44-d);
 *   3. the control at the recorded index, clamped to the last one — the
 *      neighbour of a control that is now disabled (44-c).
 * With nothing to land on, focus is left alone (44-f). Every call site is an
 * event handler or a scene's enter; nothing here runs per frame.
 */
export function keepFocus(container: HTMLElement, render: () => void): void {
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && active !== container && container.contains(active);
  const id = inside ? (active.dataset['testid'] ?? null) : null;
  const index = inside ? focusablesIn(container).indexOf(active) : -1;
  render();
  if (!inside) return;
  refocusTarget(container, id, index)?.focus({ preventScroll: true });
}

function refocusTarget(container: HTMLElement, id: string | null, index: number): HTMLElement | null {
  if (id !== null) {
    const same = byTestId(container, id);
    if (same !== null && refocusable(same)) return same;
    let row = id;
    for (let cut = row.lastIndexOf('-'); cut > 0; cut = row.lastIndexOf('-')) {
      row = row.slice(0, cut);
      const host = byTestId(container, row);
      if (host === null) continue;
      const first = focusablesIn(host)[0];
      if (first !== undefined) return first;
    }
  }
  if (index < 0) return null;
  const list = focusablesIn(container);
  return list[Math.min(index, list.length - 1)] ?? null;
}

export interface ModalOptions {
  /** The dialog's accessible name (`aria-label`). */
  label: string;
  /** What takes focus on open; the first control inside the root, else the root, when absent. */
  initialFocus?: HTMLElement | null;
  /** Put on SPEC-036's back-stack while open; omitted for layers SPEC-036 already registers. */
  onBack?: () => void;
}

/** The open modals, the top one last; only the top one traps Tab. */
const MODALS: { readonly root: HTMLElement }[] = [];

/** The attributes `openModal` writes, so its close can put each back as it found it. */
const MODAL_ATTRIBUTES = ['role', 'aria-modal', 'aria-label', 'tabindex'] as const;

/**
 * SPEC-044 §4.3: the root of the top open modal, or `null` with none open —
 * the layer a key belongs to. A root taken out of the page without its close
 * (a scene torn down under an ending card) is dropped first: it holds nothing
 * any more.
 */
export function topModal(): HTMLElement | null {
  for (let at = MODALS.length - 1; at >= 0; at--) {
    if (!(MODALS[at] as { readonly root: HTMLElement }).root.isConnected) MODALS.splice(at, 1);
  }
  return MODALS[MODALS.length - 1]?.root ?? null;
}

/**
 * SPEC-044 §4.3, §2: a Tab trap rather than `inert` — the toast rack's live
 * region sits beside the overlays, and `inert` on their layer would mute it
 * and disable a nested sheet. Tab and Shift+Tab cycle the top modal's shown
 * controls; focus found outside it goes to its first control.
 */
function trapTab(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
  const root = topModal();
  if (MODALS.length === 0) document.removeEventListener('keydown', trapTab, true);
  if (root === null) return;
  event.preventDefault();
  const list = shownFocusablesIn(root);
  const active = document.activeElement;
  const first = list[0];
  const last = list[list.length - 1];
  if (first === undefined || last === undefined) {
    root.focus({ preventScroll: true });
    return;
  }
  let next: HTMLElement;
  const at = active instanceof HTMLElement ? list.indexOf(active) : -1;
  if (at >= 0) {
    next = list[(at + (event.shiftKey ? list.length - 1 : 1)) % list.length] as HTMLElement;
  } else if (!(active instanceof Node) || !root.contains(active)) {
    next = first;
  } else if (event.shiftKey) {
    // On the root itself, or on a control outside the tab order: the
    // neighbour in document order, wrapping at the ends.
    next = [...list].reverse().find((node) => (active.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) !== 0) ?? last;
  } else {
    next = list.find((node) => (active.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) ?? first;
  }
  next.focus({ preventScroll: true });
}

/** The `UiRoot` whose back-stack a modal under `node` belongs to. */
function uiRootOf(node: HTMLElement): UiRoot | null {
  for (let at: HTMLElement | null = node; at !== null; at = at.parentElement) {
    const found = ROOTS.get(at);
    if (found !== undefined) return found;
  }
  const host = document.getElementById('ui');
  return host === null ? null : uiLayers(host);
}

/**
 * SPEC-044 §4.3: `root` takes focus as a dialog, keeps Tab inside while it is
 * the top modal, and gives focus back when it closes. Call it once `root` is
 * mounted and shown. Returns the close function — idempotent — which pops the
 * modal (the previous top's trap resumes), removes its back-stack entry, puts
 * back the attributes this call wrote, and restores the remembered focus while
 * that element is still in the page and not disabled.
 */
export function openModal(root: HTMLElement, options: ModalOptions): () => void {
  const saved = MODAL_ATTRIBUTES.map((name) => [name, root.getAttribute(name)] as const);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', options.label);
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const entry = { root };
  MODALS.push(entry);
  if (MODALS.length === 1) document.addEventListener('keydown', trapTab, true);
  const onBack = options.onBack;
  const releaseBack = onBack === undefined ? null : (uiRootOf(root)?.pushBack(onBack) ?? null);
  (options.initialFocus ?? shownFocusablesIn(root)[0] ?? root).focus({ preventScroll: true });

  let open = true;
  return (): void => {
    if (!open) return;
    open = false;
    const at = MODALS.indexOf(entry);
    if (at >= 0) MODALS.splice(at, 1);
    if (MODALS.length === 0) document.removeEventListener('keydown', trapTab, true);
    releaseBack?.();
    for (const [name, value] of saved) {
      if (value === null) root.removeAttribute(name);
      else root.setAttribute(name, value);
    }
    if (previous !== null && previous.isConnected && !previous.matches(':disabled')) previous.focus({ preventScroll: true });
  };
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
 *
 * The rack (55) and the fade (60) sit directly under `#ui`, next to the
 * layers rather than inside the overlay layer: SPEC-036 §4.3 puts the rotate
 * cover (51) over every layer and a chapter card (54) over the cover, and a
 * toast must still land over the card (SPEC-023 §4.2). Inside the overlay
 * layer the rack could never climb past its 50.
 */
export class UiRoot {
  readonly root: HTMLElement;
  /**
   * SPEC-036 §4.4: the layers Escape and the system Back close, top first.
   * Every panel, sheet and card that closes on "back" registers here while it
   * is open, and keeps no Escape listener of its own.
   */
  readonly backStack = new BackStack();
  readonly #layers: Record<UiLayer, HTMLDivElement>;
  readonly #flushables = new Set<Flushable>();
  readonly #fade: HTMLDivElement;
  readonly #toastRack: HTMLDivElement;
  #toasts: ToastEntry[] = [];
  #toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** SPEC-037 §4.3: when the rack was held for a dialogue, or `null` while it is not. */
  #heldAt: number | null = null;
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
    root.append(this.#toastRack, this.#fade);
  }

  /** §4.4: registers an open layer; the returned release is idempotent. */
  pushBack(onBack: () => void): () => void {
    return this.backStack.push(onBack);
  }

  /** §4.4: the top layer's `onBack`; false when no layer is open. */
  back(): boolean {
    return this.backStack.back();
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

  /**
   * §4.6: up to three, coalesced by text; the pure queue is unit-tested.
   * SPEC-037 §4.3: while the rack is held the toast still queues and coalesces,
   * on the clock as it stood when the hold began — so it expires nothing, and
   * shows for its whole time once the hold ends (37-e).
   */
  toast(text: string, kind: ToastKind = 'info', ms: number = TOAST_DEFAULT_MS): void {
    this.#toasts = pushToast(this.#toasts, text, kind, this.#heldAt ?? this.#now(), ms);
    this.#renderToasts();
    if (this.#heldAt === null) this.#armToastTimer();
  }

  /**
   * SPEC-037 §4.3: while held the rack is hidden, new toasts queue, and no
   * toast expires. On release every entry's expiry moves on by the time held;
   * then the rack renders and re-arms. The surface and the flight hold it for a
   * dialogue on a short screen, where the line docks under the top centre.
   */
  holdToasts(on: boolean): void {
    if (on === (this.#heldAt !== null)) return;
    if (on) {
      this.#heldAt = this.#now();
      if (this.#toastTimer !== null) clearTimeout(this.#toastTimer);
      this.#toastTimer = null;
      this.#toastRack.classList.add('is-held');
      return;
    }
    const heldMs = Math.max(0, this.#now() - (this.#heldAt as number));
    this.#heldAt = null;
    this.#toasts = shiftToasts(this.#toasts, heldMs);
    this.#toastRack.classList.remove('is-held');
    this.#renderToasts();
    this.#armToastTimer();
  }

  /** SPEC-037 §4.3: true while `holdToasts(true)` has the rack. */
  get toastsHeld(): boolean {
    return this.#heldAt !== null;
  }

  #renderToasts(): void {
    this.#toastRack.replaceChildren(
      ...this.#toasts.map((entry) =>
        h(
          'div',
          { class: `toast toast-${entry.kind}` },
          // AC-68: the warn pair is amber *and* ▲, never hue alone.
          entry.kind === 'warn' ? el('span', 'glyph', '▲') : null,
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
    this.#toastRack.remove();
    this.#fade.remove();
  }
}

/**
 * SPEC-037 §4.3: the height at which a dialogue line docks under the top
 * centre — where it meets the right-hand toasts, so the rack holds while it
 * is up. The same `max-height` the stylesheet's short-screen rules use.
 */
export const SHORT_SCREEN_QUERY = '(max-height: 500px)';

/** True on a short screen (SPEC-037 §4.3); false where there is no `matchMedia`. */
export function shortScreen(): boolean {
  return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(SHORT_SCREEN_QUERY).matches;
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
