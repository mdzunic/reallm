// The icon box (SPEC-031 §4.14): a fixed-size span holding either the
// rendered picture or the glyph — the same space either way, so a missing
// file never shifts a layout (E49). `setItemIcon` mutates in place and writes
// only when the id or size changed, so the quick bar allocates nothing per
// frame (31-p).
import { el } from '@/ui/dom';
import { iconGlyph, itemIconSource, itemManifest, itemManifestNow, type IconId } from '@/ui/icons';

export type IconSize = 28 | 40 | 48 | 64 | 256;

function render(box: HTMLElement, id: IconId, size: IconSize): void {
  const source = itemIconSource(id, itemManifestNow());
  if (source.kind === 'image') {
    const img = document.createElement('img');
    img.className = 'icon-img';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    // E49: a file that will not decode swaps to the glyph once, never loops.
    img.addEventListener(
      'error',
      () => {
        if (box.dataset['iconId'] === id) box.replaceChildren(glyphNode(id, size));
      },
      { once: true },
    );
    img.src = source.url;
    box.replaceChildren(img);
  } else {
    box.replaceChildren(glyphNode(id, size));
  }
}

function glyphNode(id: IconId, size: IconSize): HTMLSpanElement {
  const glyph = el('span', 'icon-glyph', iconGlyph(id));
  glyph.style.fontSize = `${Math.round(size * 0.62)}px`;
  return glyph;
}

/**
 * §4.14: build a box. 31-n: when the manifest lands after the box has drawn,
 * the box re-renders in place — no screen has to wait for it.
 */
export function itemIcon(id: IconId, size: IconSize): HTMLElement {
  const box = el('span', 'icon');
  box.dataset['testid'] = `icon-${id}`;
  setItemIcon(box, id, size);
  return box;
}

/** Mutates an existing box; a write with the same id and size is a no-op. */
export function setItemIcon(box: HTMLElement, id: IconId | null, size: IconSize): void {
  const sized = box.dataset['iconSize'] !== String(size);
  if (sized) {
    box.dataset['iconSize'] = String(size);
    box.style.width = `${size}px`;
    box.style.height = `${size}px`;
  }
  if (box.dataset['iconId'] === (id ?? '') && !sized) return;
  box.dataset['iconId'] = id ?? '';
  if (id === null) {
    box.replaceChildren();
    return;
  }
  box.dataset['testid'] = `icon-${id}`;
  render(box, id, size);
  // 31-n: re-render in place once the manifest resolves — only if this box is
  // still on screen and still shows this id.
  if (itemManifestNow().size === 0) {
    void itemManifest().then((available) => {
      if (available.size === 0) return;
      if (!box.isConnected || box.dataset['iconId'] !== id) return;
      render(box, id, size);
    });
  }
}
