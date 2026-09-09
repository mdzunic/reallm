// SPEC-001 §7 rule 7 / SPEC-008 §4.3: randomness flows only through an `Rng`
// instance, so every system is deterministic under a fixed seed and every test
// that uses randomness can pin one. `Math.random` is therefore banned
// everywhere in src/ except `core/Rng.ts`, the one place that may wrap it.
//
// Only *code* counts. A comment that names the ban — this file's own prose, and
// the module header of `core/Save.ts` — must not trip it, or the rule would
// punish documenting itself (SPEC-008 §4.3).
import { describe, expect, it } from 'vitest';
import { stripComments } from './source';

const ALLOWED = /(?:^|\/)src\/core\/Rng\.ts$/;
const BANNED = /Math\s*\.\s*random\b/;

/** The files in `{ path: source }` that use Math.random where they must not. */
export function offenders(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([file, source]) => !ALLOWED.test(file) && BANNED.test(stripComments(source)))
    .map(([file]) => file);
}

const SRC = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('Math.random is banned outside core/Rng.ts (SPEC-001 §7, SPEC-008 §4.3)', () => {
  it('the source tree is clean', () => {
    expect(offenders(SRC)).toEqual([]);
  });

  it('every file under src/ was actually read', () => {
    // A glob that matched nothing would make the assertion above vacuously true.
    expect(Object.keys(SRC).length).toBeGreaterThan(20);
    expect(Object.keys(SRC).some((file) => file.endsWith('/src/core/Rng.ts'))).toBe(true);
  });

  it('a stray Math.random is reported, and core/Rng.ts is allowed', () => {
    expect(
      offenders({
        'src/systems/Loot.ts': 'export const roll = () => Math.random();',
        'src/core/Rng.ts': 'export const seed = () => Math.random();',
        'src/systems/Spawn.ts': 'export const roll = (rng: { next(): number }) => rng.next();',
      }),
    ).toEqual(['src/systems/Loot.ts']);
  });

  it('a mention in a comment is not a use', () => {
    expect(
      offenders({
        'src/systems/Loot.ts': '// Math.random is banned here.\nexport const roll = (rng: Rng) => rng.next();',
        'src/systems/Spawn.ts': '/**\n * Never Math.random(): use the seeded stream.\n */\nexport const n = 1;',
      }),
    ).toEqual([]);
  });

  it('code after a comment, and after a string that looks like one, still counts', () => {
    expect(
      offenders({
        'src/systems/A.ts': '// a note\nexport const roll = () => Math.random();',
        'src/systems/B.ts': "const url = 'https://example.test'; export const roll = () => Math.random();",
        'src/systems/C.ts': '/* a block */ export const roll = () => Math.random();',
      }),
    ).toEqual(['src/systems/A.ts', 'src/systems/B.ts', 'src/systems/C.ts']);
  });

  it('spacing tricks do not get past it', () => {
    expect(offenders({ 'src/systems/D.ts': 'export const roll = () => Math . random();' })).toEqual([
      'src/systems/D.ts',
    ]);
  });
});
