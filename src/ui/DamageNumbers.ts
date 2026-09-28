// Floating damage numbers (SPEC-019 §4.6) — 24 pooled `<span class="dmg">`
// nodes in the HUD layer. A number is anchored in screen pixels at the moment
// of the hit (it does not track the entity) and rises 40 px over 0.8 s while
// fading, through `transform` and `opacity` writes only: no DOM reads, no
// CSS-animation restarts, no allocation per frame. Under reduce motion it
// fades in place (19-g). Imports no `three` (SPEC-001 §4).

/** §4.6 (*initial tuning*): pool size, life and rise. */
const POOL_SIZE = 24;
const LIFE_SECONDS = 0.8;
const RISE_PX = 40;

export type DamageKind = 'enemy' | 'elite' | 'player';

interface Slot {
  readonly node: HTMLSpanElement;
  x: number;
  y: number;
  age: number;
  live: boolean;
}

export class DamageNumbers {
  readonly #slots: Slot[] = [];
  readonly #reduceMotion: boolean;

  constructor(root: HTMLElement, reduceMotion: boolean) {
    this.#reduceMotion = reduceMotion;
    for (let i = 0; i < POOL_SIZE; i++) {
      const node = document.createElement('span');
      node.className = 'dmg';
      node.style.opacity = '0';
      root.append(node);
      this.#slots.push({ node, x: 0, y: 0, age: 0, live: false });
    }
  }

  /** Claim a free slot, or recycle the oldest live number (19-e). */
  show(x: number, y: number, amount: number, kind: DamageKind): void {
    let slot: Slot | null = null;
    let oldest: Slot = this.#slots[0] as Slot;
    for (const candidate of this.#slots) {
      if (!candidate.live) {
        slot = candidate;
        break;
      }
      if (candidate.age > oldest.age) oldest = candidate;
    }
    slot ??= oldest;
    slot.x = x;
    slot.y = y;
    slot.age = 0;
    slot.live = true;
    slot.node.textContent = String(amount);
    slot.node.className = `dmg dmg--${kind}`;
    this.#place(slot);
  }

  /** Age every live number; writes only, from the scene's `update(dt)`. */
  update(dt: number): void {
    for (const slot of this.#slots) {
      if (!slot.live) continue;
      slot.age += dt;
      if (slot.age >= LIFE_SECONDS) {
        slot.live = false;
        slot.node.style.opacity = '0';
        continue;
      }
      this.#place(slot);
    }
  }

  #place(slot: Slot): void {
    const t = slot.age / LIFE_SECONDS;
    const rise = this.#reduceMotion ? 0 : RISE_PX * t;
    slot.node.style.transform = `translate3d(${slot.x}px, ${slot.y - rise}px, 0)`;
    slot.node.style.opacity = String(1 - t);
  }

  dispose(): void {
    for (const slot of this.#slots) slot.node.remove();
    this.#slots.length = 0;
  }
}
