// SPEC-001 §7 rule 7: randomness flows only through an `Rng` instance, so every
// system is deterministic under a fixed seed and every test that uses
// randomness can pin one. `Math.random` is therefore banned everywhere in src/
// except `core/Rng.ts` (SPEC-008), the one place that may wrap it.
import { describe, expect, it } from 'vitest';

const ALLOWED = /(?:^|\/)src\/core\/Rng\.ts$/;
const BANNED = /Math\s*\.\s*random\b/;

/** The files in `{ path: source }` that use Math.random where they must not. */
export function offenders(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([file, source]) => !ALLOWED.test(file) && BANNED.test(source))
    .map(([file]) => file);
}

const SRC = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('Math.random is banned outside core/Rng.ts (SPEC-001 §7)', () => {
  it('the source tree is clean', () => {
    expect(offenders(SRC)).toEqual([]);
  });

  it('a stray Math.random is reported, and core/Rng.ts is allowed', () => {
    expect(offenders({
      'src/systems/Loot.ts': 'export const roll = () => Math.random();',
      'src/core/Rng.ts': 'export const seed = () => Math.random();',
      'src/systems/Spawn.ts': 'export const roll = (rng: { next(): number }) => rng.next();',
    })).toEqual(['src/systems/Loot.ts']);
  });
});
