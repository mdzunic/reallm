// SPEC-040 §4.4 — the HUD without garbage, as a test. SPEC-014's `Hud.flush()`
// took a `structuredClone` of the whole model on every frame that changed,
// which in a fight is every frame: a deep copy of arrays and nested objects
// sixty times a second, all of it garbage by the next one (SPEC-001 §7). The
// diff and the copy are in place now (`diffHudInto`, `copyHudInto`), and this
// keeps a deep clone from coming back anywhere the UI's per-frame work lives —
// every module under `src/ui/`, and `src/systems/UiHelpers.ts`, whose HUD
// helpers the flush calls.
//
// Only *code* counts: a comment naming the banned call must not trip it, so the
// scanner blanks comments first, as `noMathRandom.test.ts` does.
import { describe, expect, it } from 'vitest';
import { stripComments } from './source';

/** The files the rule covers: the UI layer and the HUD helpers it calls per frame. */
const HOT = /(?:^|\/)src\/(?:ui\/.+|systems\/UiHelpers)\.ts$/;
const DEEP_CLONE = /\bstructuredClone\s*\(/;

/** The covered files in `{ path: source }` that call `structuredClone`. */
export function cloneOffenders(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([file, source]) => HOT.test(file) && DEEP_CLONE.test(stripComments(source)))
    .map(([file]) => file);
}

const SRC = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('no deep clone on the HUD path (SPEC-040 §4.4, AC-21)', () => {
  it('nothing under src/ui/ and nothing in src/systems/UiHelpers.ts calls structuredClone', () => {
    expect(cloneOffenders(SRC)).toEqual([]);
  });

  it('every file it covers was actually read', () => {
    // A glob that matched nothing would make the assertion above vacuously true.
    const covered = Object.keys(SRC).filter((file) => HOT.test(file));
    expect(covered.length).toBeGreaterThan(20);
    expect(covered.some((file) => file.endsWith('/src/ui/Hud.ts'))).toBe(true);
    expect(covered.some((file) => file.endsWith('/src/systems/UiHelpers.ts'))).toBe(true);
  });

  it('reports a planted one, and leaves files outside the rule alone', () => {
    expect(
      cloneOffenders({
        'src/ui/Hud.ts': 'this.#last = structuredClone(this.model);',
        'src/ui/Tracker.ts': 'const rows = structuredClone (model.rows);',
        'src/systems/UiHelpers.ts': 'export function cloneHud(m: HudModel) { return structuredClone(m); }',
        'src/core/Save.ts': 'const copy = structuredClone(save);',
        'src/systems/Economy.ts': 'const copy = structuredClone(prices);',
        'src/ui/QuickBar.ts': 'copyHudInto(this.#last, model);',
      }),
    ).toEqual(['src/ui/Hud.ts', 'src/ui/Tracker.ts', 'src/systems/UiHelpers.ts']);
  });

  it('a mention in a comment is not a use', () => {
    expect(
      cloneOffenders({
        'src/ui/Hud.ts': '// no structuredClone(this.model) here any more\ncopyHudInto(this.#last, this.model);',
        'src/systems/UiHelpers.ts': '/** replaces structuredClone(model) */\nexport const x = 1;',
      }),
    ).toEqual([]);
  });
});
