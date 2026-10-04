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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

const MODULES = readdirSync(LIB, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.py'))
  .map((entry) => ({ name: entry.name, source: readFileSync(LIB + entry.name, 'utf8') }));

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

// SPEC-051 §4.8 — three more checks, read off the text the same way.
//
// 1. Attribute calls. `shots_interludes.shelter_light` called `P.shelter_room`
//    for months after R13 deleted it, and only a render would have raised the
//    AttributeError. Every `P.name`, `I.name`, `X.name`, `PL.name`, `FG.name`,
//    `E.name`, `F.name` and `C.name` a module reads must be a function, class or
//    constant the module behind that alias defines.
// 2. Plates on disk (51-a). A plate the films name but nobody committed fails
//    here, in CI, rather than an hour into a render on the Blender machine.
// 3. The card rule (§4.1). Cards 62 and 63 are the salvager's own: the visor,
//    never a face.

const BLENDER = new URL('../../scripts/assets/blender/', import.meta.url).pathname;
const PLATES = BLENDER + 'plates/';
const FILMS_PY = { name: 'films.py', source: readFileSync(BLENDER + 'films.py', 'utf8') };
const SCRIPTS = [...MODULES, FILMS_PY];

/** The aliases §4.8 checks. */
const CHECKED_ALIASES = ['P', 'I', 'X', 'PL', 'FG', 'E', 'F', 'C'] as const;

/** Comments and docstrings out, string literals kept — plate names and card pictures live in them. */
export function stripComments(source: string): string {
  return source
    .replace(/'''[\s\S]*?'''/g, "''")
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|#[^\n]*/g, (token) => (token.startsWith('#') ? '' : token));
}

/** `import common as C` anywhere in a module (functions import lazily too): alias → module name, for the checked aliases. */
export function moduleAliases(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of stripText(source).matchAll(/^[ \t]*import[ \t]+(\w+)[ \t]+as[ \t]+(\w+)/gm)) {
    const [, module, alias] = match as unknown as [string, string, string];
    if ((CHECKED_ALIASES as readonly string[]).includes(alias)) out.set(alias, module);
  }
  return out;
}

/** What a module defines at its top level: functions, classes, assignments and imports. */
export function definedNames(source: string): Set<string> {
  const out = new Set<string>();
  const add = (list: string): void => {
    for (const name of list.split(',')) {
      const bare = name.trim().split(/\s+as\s+/).pop()?.trim() ?? '';
      if (/^[A-Za-z_]\w*$/.test(bare)) out.add(bare);
    }
  };
  for (const line of stripText(source).split('\n')) {
    const def = /^(?:def|class)\s+(\w+)/.exec(line);
    if (def !== null) out.add(def[1] as string);
    const assign = /^([A-Za-z_][\w, ]*?)\s*(?::[^=]+)?=[^=]/.exec(line);
    if (assign !== null) add(assign[1] as string);
    const fromImport = /^from\s+\S+\s+import\s+(.+)$/.exec(line);
    if (fromImport !== null) add(fromImport[1] as string);
    const plainImport = /^import\s+(.+)$/.exec(line);
    if (plainImport !== null) add(plainImport[1] as string);
  }
  return out;
}

/**
 * `alias.name` references (calls, and the constants passed along) whose module
 * does not define `name`. `defines(module)` answers for a module by name, or
 * undefined for one outside `lib/` (never a checked alias).
 */
export function unknownAttributes(source: string, defines: (module: string) => Set<string> | undefined): string[] {
  const text = stripText(source);
  const aliases = moduleAliases(source);
  const missing = new Set<string>();
  for (const match of text.matchAll(/(?<![\w.])([A-Z]{1,2})\.([A-Za-z_]\w*)/g)) {
    const [whole, alias, name] = match as unknown as [string, string, string];
    const module = aliases.get(alias);
    if (module === undefined) continue;
    const names = defines(module);
    if (names !== undefined && !names.has(name)) missing.add(whole);
  }
  return [...missing].sort();
}

const DEFINED = new Map(MODULES.map(({ name, source }) => [name.replace(/\.py$/, ''), definedNames(source)]));
const PLATE_PY = MODULES.find((m) => m.name === 'plate.py')?.source ?? '';

/** plate.py's named plates: `VISOR = os.path.join(DIR, 'selection', 'visor.webp')` → VISOR → selection/visor.webp. */
export function plateConstants(platePy: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of stripComments(platePy).matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*os\.path\.join\(\s*DIR\s*,([^)]*)\)/gm)) {
    const [, name, parts] = match as unknown as [string, string, string];
    out.set(name, [...parts.matchAll(/'([^']*)'|"([^"]*)"/g)].map((part) => part[1] ?? part[2]).join('/'));
  }
  return out;
}

/** The plate files a script names: `PL.path('x')` → x.jpg, `PL.face(n)`, and plate.py's constants (`VISOR`, `PL.VISOR`). */
export function namedPlates(source: string, constants: Map<string, string>): string[] {
  const text = stripComments(source);
  const out = new Set<string>();
  for (const match of text.matchAll(/\bPL\.path\(\s*(?:'([^']+)'|"([^"]+)")\s*\)/g)) out.add(`${match[1] ?? match[2]}.jpg`);
  for (const match of text.matchAll(/\bPL\.face\(\s*(\d+)\s*\)/g)) out.add(`selection/${(match[1] as string).padStart(2, '0')}.webp`);
  const code = stripText(source);
  for (const [name, file] of constants) if (new RegExp(`(?<![\\w])(?:PL\\.)?${name}(?![\\w])`).test(code)) out.add(file);
  return [...out].sort();
}

/** The argument text of each call of `fn` (as `fn(` or `M.fn(`), its own `def` skipped; balanced parentheses. */
export function callArguments(text: string, fn: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(new RegExp(`(?<![\\w])(?:\\w+\\.)?${fn}\\(`, 'g'))) {
    const at = match.index ?? 0;
    if (/\bdef\s+$/.test(text.slice(Math.max(0, at - 8), at))) continue;
    let depth = 1;
    let i = at + match[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    out.push(text.slice(start, i - 1));
  }
  return out;
}

/** A function's body: from its `def` to the next top-level statement. */
export function functionBody(text: string, fn: string): string | null {
  const at = text.search(new RegExp(`^def ${fn}\\(`, 'm'));
  if (at < 0) return null;
  const body = text.indexOf('\n', at) + 1;
  const next = body > 0 ? text.slice(body).search(/^\S/m) : -1;
  return next < 0 ? text.slice(at) : text.slice(at, body + next);
}

const VISORS = new Set(['PL.VISOR', 'VISOR', 'PL.VISOR_EMPTY', 'VISOR_EMPTY']);

/** §4.1's card rule over one shot module: every `selection_wall(` gives card 62 a visor, and so does wall_63's card 63. */
export function cardProblems(name: string, source: string): string[] {
  const text = stripComments(source);
  const problems: string[] = [];
  const keyword = (args: string, key: string): string | undefined =>
    new RegExp(`\\b${key}\\s*=\\s*([\\w.]+(?:\\([^()]*\\))?)`).exec(args)?.[1];
  for (const args of callArguments(text, 'selection_wall')) {
    const card62 = keyword(args, 'card62');
    const same = keyword(args, 'same');
    if (card62 === undefined && same === undefined) problems.push(`${name}: selection_wall(${args}) leaves card 62 a face`);
    for (const picture of [card62, same]) {
      if (picture !== undefined && !VISORS.has(picture)) problems.push(`${name}: selection_wall gives card 62 ${picture}`);
    }
    const to = /\bcard62_to\s*=\s*\(\s*[\d.]+\s*,\s*([\w.]+(?:\([^()]*\))?)\s*\)/.exec(args)?.[1];
    if (to !== undefined && !VISORS.has(to)) problems.push(`${name}: card 62 fades to ${to}`);
  }
  const wall = functionBody(text, 'wall_63');
  if (wall !== null) {
    const photo = /F\.textured\(\s*'Photo63'\s*,\s*([\w.]+(?:\([^()]*\))?)/.exec(wall)?.[1];
    if (photo === undefined || !VISORS.has(photo)) problems.push(`${name}: wall_63's card 63 shows ${photo ?? 'nothing found'}`);
  }
  return problems;
}

describe('the film scripts, read for SPEC-051 §4.8', () => {
  it('reads films.py and every shot module, each with its aliases', () => {
    expect(SCRIPTS.map((m) => m.name)).toEqual(expect.arrayContaining(['films.py', 'shots_prologue.py', 'shots_interludes.py', 'shots_endings.py']));
    expect([...moduleAliases(FILMS_PY.source)].sort()).toEqual([
      ['C', 'common'], ['E', 'earth'], ['F', 'film'], ['FG', 'figures'], ['I', 'shots_interludes'], ['P', 'shots_prologue'],
      ['PL', 'plate'], ['X', 'shots_endings'],
    ]);
  });

  it('1. calls no function, and reads no constant, that the aliased module does not define', () => {
    const problems: string[] = [];
    for (const { name, source } of SCRIPTS) {
      for (const missing of unknownAttributes(source, (module) => DEFINED.get(module))) problems.push(`${name}: ${missing}`);
    }
    expect(problems).toEqual([]);
    // …and the check bites: shelter_light's dead call, and an unknown helper.
    const deleted = 'import shots_prologue as P\n\ndef shelter_light(ctx):\n    P.shelter_room(ctx, lamp_steady_at=1.0)\n';
    expect(unknownAttributes(deleted, (module) => DEFINED.get(module))).toEqual(['P.shelter_room']);
    const typo = "import film as F\nimport plate as PL\nF.keys(a, 'b', [])\nPL.shot_plate('x')  # PL.nothing\n";
    expect(unknownAttributes(typo, (module) => DEFINED.get(module))).toEqual(['PL.shot_plate']);
  });

  it('2. names only plates committed under plates/ (51-a)', () => {
    const constants = plateConstants(PLATE_PY);
    expect(Object.fromEntries(constants)).toEqual({ VISOR: 'selection/visor.webp', VISOR_EMPTY: 'selection/visor_empty.webp' });
    // The check bites: a plate nobody committed is named, a commented-out one is not.
    const stray = "S('x', 0, 1, 0.5, PL.shot(PL.path('no_such_plate')))  # PL.path('commented_out')\n";
    expect(namedPlates(stray, constants)).toEqual(['no_such_plate.jpg']);
    expect(existsSync(PLATES + 'no_such_plate.jpg')).toBe(false);
    const named = new Set<string>([1, 2, 3, 4, 5, 6].map((n) => `selection/0${n}.webp`));
    for (const { source } of SCRIPTS) for (const file of namedPlates(source, constants)) named.add(file);
    // the five SPEC-051 plates are named, beside the six R11–R13 plates and the faces
    expect([...named].sort()).toEqual(expect.arrayContaining([
      'interlude_c3_greenhouse.jpg', 'prologue_liftoff.jpg', 'prologue_stranded.jpg', 'selection/visor.webp', 'selection/visor_empty.webp',
    ]));
    expect([...named].filter((file) => !existsSync(PLATES + file)).sort(), 'named plates missing under scripts/assets/blender/plates/').toEqual([]);
  });

  it('3. gives cards 62 and 63 the visor and never a face (§4.1)', () => {
    const shots = MODULES.filter((m) => /^shots_(prologue|interludes|endings)\.py$/.test(m.name));
    expect(shots).toHaveLength(3);
    expect(shots.flatMap(({ name, source }) => cardProblems(name, source))).toEqual([]);
    // every wall shot passes a picture for card 62: the prologue, chapter 5's board and both endings
    const walls = shots.flatMap(({ source }) => callArguments(stripComments(source), 'selection_wall'));
    expect(walls).toHaveLength(4);
    // …and the rule bites: a face on card 62, a wall with no card 62 at all, a face on card 63.
    expect(cardProblems('x', 'def selection(ctx):\n    cards = selection_wall(ctx, card62=PL.face(1))\n')).toEqual([
      'x: selection_wall gives card 62 PL.face(1)',
    ]);
    expect(cardProblems('x', 'def selection(ctx):\n    cards = P.selection_wall(ctx)\n')).toEqual(['x: selection_wall(ctx) leaves card 62 a face']);
    expect(cardProblems('x', "def wall_63(ctx):\n    F.textured('Photo63', PL.face(1), rough=0.6)\n")).toEqual([
      "x: wall_63's card 63 shows PL.face(1)",
    ]);
  });
});
