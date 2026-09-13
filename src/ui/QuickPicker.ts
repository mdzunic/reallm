// The quick-slot picker (SPEC-028 §4.6): a small panel above the bar listing
// every carried item eligible for one quick slot, plus Empty. The scene holds
// the simulation while it is open (a `#uiHolds` hold, SPEC-026) and closes it
// on Escape, a tap outside, or the scene pausing — all through the returned
// close function, which is idempotent.
import type { ItemId, QuickSlot } from '@/data/index';
import { el, h, testId, type UiRoot } from '@/ui/dom';

export interface QuickChoice {
  itemId: ItemId | null;
  label: string;
  qty: number;
}

/**
 * Mounts the picker into the `panel` layer and returns its close function.
 * `onChoose` fires before `onClose`; a dismissal fires `onClose` alone.
 */
export function openQuickPicker(
  ui: UiRoot,
  slot: QuickSlot,
  choices: readonly QuickChoice[],
  onChoose: (id: ItemId | null) => void,
  onClose: () => void,
): () => void {
  const root = testId(el('div', 'quick-picker panel'), 'quick-picker');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', `Choose the ${slot} slot`);

  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    globalThis.removeEventListener('keydown', onKey, true);
    globalThis.removeEventListener('pointerdown', onOutside, true);
    root.remove();
    onClose();
  };

  // Escape closes and stops there, captured the way the map does it, so the
  // pause handler in main.ts never sees the press (§4.6).
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  // A tap that lands outside the picker dismisses it.
  const onOutside = (event: Event): void => {
    if (event.target instanceof Node && root.contains(event.target)) return;
    close();
  };

  const choose = (id: ItemId | null): void => {
    onChoose(id);
    close();
  };

  root.append(el('p', 'quick-picker-title', `${slot} slot`));
  for (const choice of choices) {
    if (choice.itemId === null) continue;
    root.append(
      testId(
        h(
          'button',
          { class: 'ui-btn quick-pick', type: 'button', click: () => choose(choice.itemId) },
          `${choice.label} ×${choice.qty}`,
        ),
        `quick-pick-${choice.itemId}`,
      ),
    );
  }
  root.append(
    testId(h('button', { class: 'ui-btn quick-pick', type: 'button', click: () => choose(null) }, 'Empty'), 'quick-pick-empty'),
  );

  ui.mount(root, 'panel');
  globalThis.addEventListener('keydown', onKey, true);
  globalThis.addEventListener('pointerdown', onOutside, true);
  return close;
}
