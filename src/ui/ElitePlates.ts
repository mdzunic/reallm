// Elite nameplates (SPEC-041 §4.6) — six pooled `elite-plate` nodes in the HUD
// layer. Each rendered frame the surface scene picks the nearest live elites
// within 25 m, projects each 2.2 m above the ground and writes a slot: line one
// `Alpha <name>`, line two the affix names joined by ` · `. A plate is placed
// through `transform` writes only, its text is written only when it changes,
// and nothing is read from the DOM, so a frame allocates nothing (SPEC-001
// §7). The plates do not animate, so reduce motion leaves them as they are.
// They sit on SPEC-037's HUD plate and halo. Imports no `three` (SPEC-001 §4).
import { el, testId } from '@/ui/dom';

/** §4.6: the most plates shown at once. */
export const ELITE_PLATE_SLOTS = 6;

interface Slot {
  readonly root: HTMLDivElement;
  readonly name: HTMLSpanElement;
  readonly affixes: HTMLSpanElement;
  /** What the two lines say now — compared, never read back from the DOM. */
  nameText: string;
  affixText: string;
  shown: boolean;
}

export class ElitePlates {
  readonly #slots: Slot[] = [];
  #visible = 0;

  constructor(root: HTMLElement) {
    for (let i = 0; i < ELITE_PLATE_SLOTS; i++) {
      const plate = testId(el('div', 'elite-plate is-hidden'), 'elite-plate');
      plate.setAttribute('aria-hidden', 'true');
      const name = el('span', 'elite-plate__name');
      const affixes = el('span', 'elite-plate__affixes');
      plate.append(name, affixes);
      root.append(plate);
      this.#slots.push({ root: plate, name, affixes, nameText: '', affixText: '', shown: false });
    }
  }

  /** How many plates are showing (`sceneInfo.elitePlates`). */
  get visible(): number {
    return this.#visible;
  }

  /** Slot `slot` over screen pixel `(x, y)`, reading `name` over `affixes`. */
  show(slot: number, x: number, y: number, name: string, affixes: string): void {
    const s = this.#slots[slot];
    if (s === undefined) return;
    if (s.nameText !== name) {
      s.nameText = name;
      s.name.textContent = name;
    }
    if (s.affixText !== affixes) {
      s.affixText = affixes;
      s.affixes.textContent = affixes;
    }
    s.root.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -100%)`;
    if (!s.shown) {
      s.shown = true;
      s.root.classList.remove('is-hidden');
    }
    if (slot + 1 > this.#visible) this.#visible = slot + 1;
  }

  /** Hide every slot from `slot` on — the frame used the ones before it. */
  hideFrom(slot: number): void {
    for (let i = Math.max(0, slot); i < this.#slots.length; i++) {
      const s = this.#slots[i] as Slot;
      if (!s.shown) continue;
      s.shown = false;
      s.root.classList.add('is-hidden');
    }
    this.#visible = Math.min(this.#visible, Math.max(0, slot));
  }

  dispose(): void {
    for (const slot of this.#slots) slot.root.remove();
    this.#slots.length = 0;
    this.#visible = 0;
  }
}
