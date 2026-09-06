// The `?debug` readout (SPEC-003 D-41). SPEC-002 owns the full stats overlay;
// what is here is the one line the memory-stability check reads: the live
// geometry and texture counts from `renderer.gl.info.memory`.
import { el, testId } from '@/ui/dom';

export class DebugOverlay {
  readonly #root: HTMLDivElement;
  readonly #memory: HTMLSpanElement;
  #last = '';

  constructor(root: HTMLElement) {
    this.#root = el('div', 'overlay-debug');
    this.#memory = testId(el('span', 'debug-memory'), 'debug-memory');
    this.#root.append(this.#memory);
    root.append(this.#root);
  }

  /** Called every frame; the DOM is only touched when the text actually changes. */
  setMemory(geometries: number, textures: number): void {
    const text = `geo ${geometries} tex ${textures}`;
    if (text === this.#last) return;
    this.#last = text;
    this.#memory.textContent = text;
  }
}
