// SPEC-059 §4.3.4 — the surface's `hud-debug` strip is a dev build's alone.
// Every control on it changes the world, and Smite pays XP and loot, so a
// production `?debug` keeps the stats overlay's read-only rows and builds no
// strip and no control — including the ones later specs add to it.
//
// The rule, read off the real source with comments blanked first: every call
// of `#buildDebugStrip(` other than its definition sits on a line that also
// reads `import.meta.env.DEV`. A guard written in a comment is not a guard.
import { describe, expect, it } from 'vitest';
import { stripComments } from './source';

/** The definition's own line, which is not a call. */
const DEFINITION = /^\s*#buildDebugStrip\(\)\s*:\s*void\s*\{/;

/** Every line of `source` that calls `#buildDebugStrip(` without the dev guard on it. */
export function unguardedStripCalls(source: string): string[] {
  const out: string[] = [];
  for (const line of stripComments(source).split('\n')) {
    if (!line.includes('#buildDebugStrip(') || DEFINITION.test(line)) continue;
    if (!line.includes('import.meta.env.DEV')) out.push(line.trim());
  }
  return out;
}

const SURFACE = import.meta.glob<string>('../../src/scenes/Surface.ts', { query: '?raw', import: 'default', eager: true });

describe('the debug strip is built in dev builds only (SPEC-059 §4.3.4)', () => {
  const source = Object.values(SURFACE)[0] ?? '';

  it('every call in the surface scene is guarded by import.meta.env.DEV', () => {
    const calls = stripComments(source)
      .split('\n')
      .filter((line) => line.includes('#buildDebugStrip(') && !DEFINITION.test(line));
    expect(calls.length).toBeGreaterThan(0);
    expect(unguardedStripCalls(source)).toEqual([]);
  });

  it('reports a fake source whose call is unguarded, or guarded only in a comment', () => {
    const fake = [
      'class Scene {',
      '  enter(): void {',
      "    if (params.has('debug')) this.#buildDebugStrip();",
      '    this.#buildDebugStrip(); // import.meta.env.DEV',
      '  }',
      '  #buildDebugStrip(): void {',
      '    // import.meta.env.DEV && this.#buildDebugStrip();',
      '  }',
      '}',
    ].join('\n');
    expect(unguardedStripCalls(fake)).toEqual(["if (params.has('debug')) this.#buildDebugStrip();", 'this.#buildDebugStrip();']);
    const guarded = fake
      .replace("if (params.has('debug'))", "if (import.meta.env.DEV && params.has('debug'))")
      .replace('    this.#buildDebugStrip(); // import.meta.env.DEV', '    if (import.meta.env.DEV) this.#buildDebugStrip();');
    expect(unguardedStripCalls(guarded)).toEqual([]);
  });
});
