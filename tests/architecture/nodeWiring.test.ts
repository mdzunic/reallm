// One wiring for the resource nodes. SPEC-034 §4.12 (E56) has a node keep
// pumping at a full hold while a collect objective still wants its resource,
// which needs the economy's `collectDemand` passed through to `Nodes`. The
// surface scene built its own wiring and left it out, so a main-path collect
// stalled at a full hold, while `pickups.test.ts`, whose helper did pass it,
// stayed green (docs/review-2026-10, B-01). Now both build it with
// `nodeEconomy` from `systems/Pickups.ts`, and this keeps a hand-rolled wiring
// from coming back.
//
// Source is read through Vite's `import.meta.glob` (`?raw`), like the sibling
// architecture tests; comments are blanked first.
import { describe, expect, it } from 'vitest';
import { stripComments } from './source';

/** `new Nodes(` and everything up to the end of its statement. */
const CONSTRUCTION = /new\s+Nodes\s*\(([^;]*)\)\s*;/g;
const SHARED = /\bnodeEconomy\s*\(/;

/** `file:n` for every `new Nodes(…)` in `{ path: source }` that does not go through `nodeEconomy(…)`. */
export function handRolled(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    let n = 0;
    for (const match of stripComments(source).matchAll(CONSTRUCTION)) {
      n++;
      if (!SHARED.test(match[1] ?? '')) out.push(`${file}:${n}`);
    }
  }
  return out;
}

const SRC = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('the resource nodes have one economy wiring (SPEC-034 §4.12)', () => {
  it('every `new Nodes(…)` under src/ is wired through `nodeEconomy(…)`', () => {
    expect(handRolled(SRC)).toEqual([]);
  });

  it('the surface scene really does build its nodes', () => {
    const surface = Object.entries(SRC).find(([file]) => file.endsWith('/src/scenes/Surface.ts'));
    expect(surface).toBeDefined();
    expect([...stripComments((surface as [string, string])[1]).matchAll(CONSTRUCTION)]).toHaveLength(1);
  });

  it('a hand-rolled wiring is reported, and the shared one is not', () => {
    expect(
      handRolled({
        'src/scenes/A.ts': 'const nodes = new Nodes(layout.nodes, regenOf, { addResource, room });',
        'src/scenes/B.ts': 'const nodes = new Nodes(layout.nodes, regenOf, nodeEconomy(economy, save));',
        'src/scenes/C.ts': '// new Nodes(layout.nodes, regenOf, { room });\nconst x = 1;',
      }),
    ).toEqual(['src/scenes/A.ts:1']);
  });
});
