// One writer for `progress.visits`. SPEC-008 §4.2 numbers a planet's runtime
// streams by its visit count, so the count has to move exactly once per visit:
// two scenes each incrementing it on the same landing scores the trip twice and
// silently skips an `rng.visit` stream. The surface scene is the writer, because
// it is the scene being visited and every route in goes through its `onEnter` —
// the landing cutscene and a forced `?scene=surface` jump alike. The flight
// scene reads the count (for `firstLanding`) and never advances it.
//
// Source is read through Vite's `import.meta.glob` (`?raw`), like the sibling
// architecture tests; comments are blanked first so prose naming the rule —
// including the flight scene's own — is not read as a write.
import { describe, expect, it } from 'vitest';
import { stripComments } from './source';

const ALLOWED = /(?:^|\/)src\/scenes\/Surface\.ts$/;
/** `…progress.visits[…] = …`, but not a `==`/`===` comparison. */
const WRITE = /progress\s*\.\s*visits\s*\[[^\]]*\]\s*(?:\+\+|--|[+-]?=(?!=))/;

/** The files in `{ path: source }` that write the visit count and must not. */
export function writers(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([file, source]) => !ALLOWED.test(file) && WRITE.test(stripComments(source)))
    .map(([file]) => file);
}

const SRC = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('the visit count has a single writer (SPEC-008 §4.2)', () => {
  it('only the surface scene advances progress.visits', () => {
    expect(writers(SRC)).toEqual([]);
  });

  it('the surface scene really does advance it', () => {
    const surface = Object.entries(SRC).find(([file]) => ALLOWED.test(file));
    expect(surface).toBeDefined();
    expect(WRITE.test(stripComments((surface as [string, string])[1]))).toBe(true);
  });

  it('a second writer is reported, whatever shape it takes', () => {
    expect(
      writers({
        'src/scenes/Flight.ts': 'save.progress.visits[planet.id] = visits + 1;',
        'src/scenes/Station.ts': 'save.progress.visits[id] += 1;',
        'src/scenes/Starmap.ts': 'save.progress.visits[id]++;',
        'src/scenes/Surface.ts': 'save.progress.visits[planet.id] = visits;',
        'src/systems/Missions.ts': 'const seen = save.progress.visits[id] ?? 0;',
        'src/ui/Hud.ts': 'if (save.progress.visits[id] === 0) hint();',
      }),
    ).toEqual(['src/scenes/Flight.ts', 'src/scenes/Station.ts', 'src/scenes/Starmap.ts']);
  });

  it('a mention in a comment is not a write', () => {
    expect(
      writers({
        'src/scenes/Flight.ts': '// never: save.progress.visits[id] = n + 1;\nconst n = 0;',
      }),
    ).toEqual([]);
  });
});
