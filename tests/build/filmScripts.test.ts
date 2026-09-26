// SPEC-034 §4.17 — the film shot scripts' upper-case names, read off their text.
//
// `CARD_NUMBERS` was deleted from `shots_prologue.py` in 5b7e57a while the
// Selection board went on reading it, so the prologue and endings films raised
// `NameError` on the first card and could not be rebuilt. Blender is not run in
// CI (SPEC-021 §5: the films are rendered by hand), so nothing caught it.
//
// A regex scan is enough for the shape of the defect: collect the upper-case
// names each module assigns at module level or imports, and fail any upper-case
// name it reads without providing. No Python runs.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LIB = new URL('../../scripts/assets/blender/lib/', import.meta.url).pathname;

/** `ALL_CAPS` and `A1`, but not `Vector`, `bpy` or a single letter. */
const UPPER = /\b[A-Z][A-Z0-9_]+\b/g;

/**
 * Built-ins and the constants Blender's own modules bring in. `__name__` and
 * friends are dunders, not upper-case names, so they never match `UPPER`.
 */
const ALLOWED = new Set([
  'TRUE',
  'FALSE',
  'NONE',
  'RGB',
  'RGBA',
  // Blender enum values written inline as string arguments are stripped below,
  // but a few appear as bare attributes on `bpy` types.
  'BLENDER_EEVEE_NEXT',
  'CYCLES',
]);

/** Strips comments, docstrings and string literals — enum values live there. */
export function stripText(source: string): string {
  return source
    .replace(/'''[\s\S]*?'''/g, "''")
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, '');
}

/**
 * The upper-case names a module provides: module-level assignments (including
 * tuple targets and augmented assignment), `for` targets, `global` statements,
 * and everything it imports by name.
 */
export function providedNames(source: string): Set<string> {
  const out = new Set<string>();
  const add = (list: string): void => {
    for (const name of list.split(',')) {
      const bare = name.trim().split(' as ').pop()?.trim() ?? '';
      if (UPPER.test(bare)) out.add(bare);
      UPPER.lastIndex = 0;
    }
  };
  for (const line of source.split('\n')) {
    const assign = /^([A-Za-z0-9_, ]+?)\s*(?::[^=]+)?=[^=]/.exec(line);
    if (assign !== null) add(assign[1] as string);
    const loop = /^\s*for\s+([A-Za-z0-9_, ]+?)\s+in\s/.exec(line);
    if (loop !== null) add(loop[1] as string);
    const global = /^\s*global\s+(.+)$/.exec(line);
    if (global !== null) add(global[1] as string);
    const fromImport = /^\s*from\s+\S+\s+import\s+(.+)$/.exec(line);
    if (fromImport !== null) add(fromImport[1] as string);
    const plainImport = /^\s*import\s+(.+)$/.exec(line);
    if (plainImport !== null) add(plainImport[1] as string);
  }
  return out;
}

/** Upper-case names a module reads but neither assigns nor imports. */
export function unresolvedNames(source: string): string[] {
  const text = stripText(source);
  const provided = providedNames(text);
  const missing = new Set<string>();
  for (const match of text.matchAll(UPPER)) {
    const name = match[0];
    if (provided.has(name) || ALLOWED.has(name)) continue;
    // `X.Y` and `.Y`: an attribute is the other module's to provide.
    const before = text.slice(Math.max(0, (match.index ?? 0) - 1), match.index);
    if (before === '.') continue;
    missing.add(name);
  }
  return [...missing].sort();
}

const MODULES = readdirSync(LIB)
  .filter((name) => name.endsWith('.py'))
  .map((name) => ({ name, source: readFileSync(LIB + name, 'utf8') }));

describe('the film shot scripts (SPEC-034 §4.17)', () => {
  it('reads the whole lib directory', () => {
    expect(MODULES.length).toBeGreaterThan(5);
    expect(MODULES.map((m) => m.name)).toContain('shots_prologue.py');
  });

  it('uses no upper-case name it does not assign or import', () => {
    const problems: string[] = [];
    for (const { name, source } of MODULES) {
      for (const missing of unresolvedNames(source)) problems.push(`${name}: ${missing}`);
    }
    expect(problems).toEqual([]);
  });

  it('keeps the Selection board its twelve card numbers', () => {
    const prologue = MODULES.find((m) => m.name === 'shots_prologue.py')?.source ?? '';
    const at = prologue.indexOf('CARD_NUMBERS = (62, 7, 13, 19, 24, 28, 33, 38, 41, 46, 50, 55)');
    expect(at, 'the CARD_NUMBERS assignment').toBeGreaterThan(-1);
    // §4.17: assigned at module level, before `selection` reads it.
    expect(at).toBeLessThan(prologue.indexOf('def selection'));
  });
});
