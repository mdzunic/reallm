// The import boundaries of SPEC-001 §4, as a test. The rule that matters most
// is the one the whole architecture rests on: gameplay logic (`systems`,
// `entities`, `data`, most of `core`) never imports `three`, so it stays
// unit-testable in node; Three.js appears only in `views`, `scenes` and the
// four named `core` modules.
//
// The "must not import" column is enforced. The "may import" column is
// descriptive and left to review, with one exception: `data/` may import
// nothing but `data/` — data files are plain objects.
//
// Source is read through Vite's `import.meta.glob` (`?raw`), so this needs no
// node APIs and no extra type packages.
import { describe, expect, it } from 'vitest';
import { stripComments } from './source';

type Folder = 'core' | 'data' | 'systems' | 'entities' | 'views' | 'scenes' | 'ui' | 'root';
type Target = Folder | 'three' | 'external';

/** Folder → import targets it must never reach. */
const FORBIDDEN: Record<Folder, readonly Target[]> = {
  core: ['scenes', 'systems', 'ui', 'three'],
  data: [], // handled by the allow-only rule below
  systems: ['three', 'ui', 'scenes'],
  entities: ['three'],
  views: ['systems'],
  scenes: [],
  ui: ['three'],
  root: [], // src/main.ts is a composition root, like a scene
};
/**
 * The `core` modules allowed to import `three` (SPEC-001 §4). PLAN R6-2 adds
 * `PostChain`; `core/Quality.ts` is deliberately *not* here — the whole point
 * of the render plan is that it reads without a GL context.
 */
const CORE_WITH_THREE = new Set(['Renderer', 'Assets', 'Disposer', 'Benchmark', 'PostChain']);
/** Tests may exercise pure code only (SPEC-001 §4, last row). */
const FORBIDDEN_FOR_TESTS: readonly Target[] = ['views', 'scenes', 'ui'];

const IMPORT_RE = /^\s*(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;

/** Every module specifier a source file imports or re-exports. */
export function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) out.push((m[1] ?? m[2]) as string);
  return out;
}

/** The src folder a file lives in, from its path (any prefix before `src/`). */
export function folderOf(file: string): Folder | null {
  const m = /(?:^|\/)src\/([^/]+)(\/|$)/.exec(file);
  if (!m) return null;
  if (!m[2]) return 'root'; // src/main.ts, src/vite-env.d.ts
  const seg = m[1] as string;
  return (['core', 'data', 'systems', 'entities', 'views', 'scenes', 'ui'] as const).find((f) => f === seg) ?? null;
}

/** Where an import points: a src folder, `three`, or some other package. */
export function targetOf(spec: string, fromFile: string): Target | null {
  if (spec === 'three' || spec.startsWith('three/')) return 'three';
  if (/\.(css|json|svg|png|glb|webm|mp3)(\?|$)/.test(spec)) return null; // assets, not code
  let pathInSrc: string | null = null;
  if (spec.startsWith('@/')) pathInSrc = spec.slice(2);
  else if (spec.startsWith('.')) {
    // Resolve the relative path against the importing file, then locate src/.
    const parts = fromFile.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    const joined = parts.join('/');
    const i = joined.indexOf('src/');
    pathInSrc = i >= 0 ? joined.slice(i + 4) : null;
    if (pathInSrc === null) return null; // a relative import that stays inside tests/
  } else {
    return 'external';
  }
  const folder = pathInSrc.split('/')[0] ?? '';
  if (!pathInSrc.includes('/')) return 'root';
  return (['core', 'data', 'systems', 'entities', 'views', 'scenes', 'ui'] as const).find((f) => f === folder) ?? 'root';
}

/**
 * Every boundary violation in a tree of `{ path: source }`. Pure, so the rule
 * set itself is tested below against a fake tree — the acceptance criterion is
 * that a `three` import under `src/systems/` FAILS, which the real tree cannot
 * demonstrate.
 */
export function violations(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    const isTest = /(?:^|\/)tests\//.test(file) && !/(?:^|\/)src\//.test(file);
    const folder = isTest ? null : folderOf(file);
    if (!isTest && folder === null) continue;
    for (const spec of specifiers(source)) {
      const target = targetOf(spec, file);
      if (target === null) continue;
      if (isTest) {
        if (FORBIDDEN_FOR_TESTS.includes(target)) out.push(`${file} imports ${spec} — tests exercise pure code only, never ${target}`);
        continue;
      }
      const f = folder as Folder;
      if (f === 'data' && target !== 'data') {
        out.push(`${file} imports ${spec} — data files are plain objects and import only data/`);
        continue;
      }
      if (!FORBIDDEN[f].includes(target)) continue;
      if (f === 'core' && target === 'three') {
        const base = file.split('/').pop()?.replace(/\.ts$/, '') ?? '';
        if (CORE_WITH_THREE.has(base)) continue;
      }
      out.push(`${file} imports ${spec} — ${f} must not import ${target} (SPEC-001 §4)`);
    }
  }
  return out;
}

/**
 * SPEC-048 §4.4: Command's rating grades the run and changes nothing in it, so
 * the gameplay modules may not read it. These are the modules, by file name.
 */
const RATING_FREE = ['Combat', 'Economy', 'Missions', 'Spawn', 'Progression', 'Loadout', 'EnemyAi'];
/** …and what they may not import: the rating and the count it is made of. */
const RATING_NAMES = ['commandRating', 'offTaskCount'];

/**
 * Every import of `commandRating` or `offTaskCount` — by name, aliased or
 * not, or through a namespace import of `systems/Clues` — into a module of
 * `RATING_FREE` under `src/systems/`. Comments are not imports.
 */
export function ratingViolations(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    const match = /(?:^|\/)src\/systems\/([A-Za-z]+)\.ts$/.exec(file);
    if (match === null || !RATING_FREE.includes(match[1] as string)) continue;
    const code = stripComments(source);
    for (const named of code.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
      for (const part of (named[1] as string).split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? '';
        if (RATING_NAMES.includes(name)) out.push(`${file} imports ${name} — the rating changes nothing in play (SPEC-048 §4.4)`);
      }
    }
    for (const spaced of code.matchAll(/\bimport\s+\*\s+as\s+[\w$]+\s+from\s*['"]([^'"]+)['"]/g)) {
      if (/(?:^|\/)Clues$/.test(spaced[1] as string)) out.push(`${file} imports systems/Clues whole — the rating changes nothing in play (SPEC-048 §4.4)`);
    }
  }
  return out;
}

const SRC = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
const TESTS = import.meta.glob<string>('../**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('import boundaries (SPEC-001 §4)', () => {
  it('the source tree respects the table', () => {
    expect(violations(SRC)).toEqual([]);
  });

  it('the tests exercise pure code only', () => {
    expect(violations(TESTS)).toEqual([]);
  });

  it('a three import under src/systems/ is a violation', () => {
    const bad = { 'src/systems/Combat.ts': "import { Vector3 } from 'three';\nexport const x = new Vector3();\n" };
    expect(violations(bad)).toEqual([
      "src/systems/Combat.ts imports three — systems must not import three (SPEC-001 §4)",
    ]);
  });

  it('the rest of the deny column holds, and the core exceptions are honoured', () => {
    expect(violations({ 'src/entities/Enemy.ts': "import * as THREE from 'three/webgpu';" })).toHaveLength(1);
    expect(violations({ 'src/ui/Hud.ts': "import { Mesh } from 'three';" })).toHaveLength(1);
    expect(violations({ 'src/views/EnemyView.ts': "import { hit } from '@/systems/Combat';" })).toHaveLength(1);
    expect(violations({ 'src/core/Loop.ts': "import { Timer } from 'three';" })).toHaveLength(1);
    expect(violations({ 'src/core/Renderer.ts': "import { WebGLRenderer } from 'three';" })).toEqual([]);
    expect(violations({ 'src/core/Game.ts': "import { SurfaceScene } from '../scenes/SurfaceScene';" })).toHaveLength(1);
    expect(violations({ 'src/data/enemies.ts': "import { TUNING } from './tuning';\nimport { log } from '@/core/Log';" })).toHaveLength(1);
    expect(violations({ 'src/scenes/Surface.ts': "import * as THREE from 'three';\nimport { hit } from '@/systems/Combat';" })).toEqual([]);
    expect(violations({ 'tests/systems/combat.test.ts': "import { EnemyView } from '@/views/EnemyView';" })).toHaveLength(1);
    expect(violations({ 'tests/core/log.test.ts': "import { log } from '@/core/Log';\nimport { it } from 'vitest';" })).toEqual([]);
  });
});

describe('the rating changes nothing in play (SPEC-048 §4.4)', () => {
  it('no gameplay module imports commandRating or offTaskCount', () => {
    expect(ratingViolations(SRC)).toEqual([]);
  });

  it('the economy reads isClueFlag from the same module, and that is allowed', () => {
    const economy = SRC['../../src/systems/Economy.ts'] as string;
    expect(economy).toMatch(/import \{ isClueFlag \} from '@\/systems\/Clues';/);
    expect(ratingViolations({ 'src/systems/Economy.ts': economy })).toEqual([]);
  });

  it('fails each forbidden import, aliased, typed or whole', () => {
    for (const module of ['Combat', 'Economy', 'Missions', 'Spawn', 'Progression', 'Loadout', 'EnemyAi']) {
      const file = `src/systems/${module}.ts`;
      expect(ratingViolations({ [file]: "import { commandRating } from '@/systems/Clues';" }), module).toHaveLength(1);
    }
    expect(ratingViolations({ 'src/systems/Combat.ts': "import { isClueFlag, offTaskCount as n } from './Clues';" })).toHaveLength(1);
    expect(ratingViolations({ 'src/systems/Spawn.ts': "import {\n  type RatingGrade,\n  commandRating,\n} from '@/systems/Clues';" })).toHaveLength(1);
    expect(ratingViolations({ 'src/systems/Missions.ts': "import * as clues from '@/systems/Clues';" })).toHaveLength(1);
    expect(ratingViolations({ 'src/systems/Missions.ts': "// import { commandRating } from '@/systems/Clues';" })).toEqual([]);
    // Everywhere else the rating is read freely: Notes, the station, the tests.
    expect(ratingViolations({ 'src/ui/NotesPanel.ts': "import { commandRating } from '@/systems/Clues';" })).toEqual([]);
    expect(ratingViolations({ 'src/systems/Clues.ts': 'export function commandRating() {}' })).toEqual([]);
  });
});
