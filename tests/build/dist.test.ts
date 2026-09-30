// SPEC-016 §11 / D-29 — `distFreshness` over a throwaway tree. Modification
// times are set with `utimesSync` rather than waited for, so nothing here
// depends on the clock or the file system's timestamp resolution.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { distFreshness, skipNote } from './dist';

/** Seconds since the epoch; far enough apart that no rounding can merge them. */
const OLD = 1_700_000_000;
const BUILT = OLD + 100;
const LATER = BUILT + 100;

let root = '';

function file(path: string, at: number): void {
  const full = join(root, path);
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, path);
  utimesSync(full, at, at);
}

function touch(path: string, at: number): void {
  utimesSync(join(root, path), at, at);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reallm-dist-'));
  for (const input of ['index.html', 'vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json']) file(input, OLD);
  file('src/main.ts', OLD);
  file('src/core/Game.ts', OLD);
  file('src/ui/Hud.ts', OLD);
  file('public/assets/LICENSES.md', OLD);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('distFreshness (SPEC-016 §11, D-29)', () => {
  it('is missing when there is no dist/', () => {
    expect(distFreshness(root)).toEqual({ ok: false, reason: 'missing' });
  });

  it('is missing when dist/ has no index.html', () => {
    file('dist/sw.js', BUILT);
    expect(distFreshness(root)).toEqual({ ok: false, reason: 'missing' });
  });

  it('is ok when dist/index.html is newer than every input', () => {
    file('dist/index.html', BUILT);
    expect(distFreshness(root)).toEqual({ ok: true });
  });

  it('is stale when a src/ file was touched after the build, and names it', () => {
    file('dist/index.html', BUILT);
    touch('src/core/Game.ts', LATER);
    expect(distFreshness(root)).toEqual({ ok: false, reason: 'stale', newer: 'src/core/Game.ts' });
  });

  it('does not count an input with the same modification time as the build', () => {
    file('dist/index.html', BUILT);
    touch('src/main.ts', BUILT);
    touch('package.json', BUILT);
    expect(distFreshness(root)).toEqual({ ok: true });
  });

  it('names the first newer input: the root files, then src/, then public/', () => {
    file('dist/index.html', BUILT);
    touch('public/assets/LICENSES.md', LATER);
    expect(distFreshness(root)).toEqual({ ok: false, reason: 'stale', newer: 'public/assets/LICENSES.md' });
    touch('src/ui/Hud.ts', LATER);
    expect(distFreshness(root)).toEqual({ ok: false, reason: 'stale', newer: 'src/ui/Hud.ts' });
    // Depth-first with entries sorted by name: `core/` comes before `main.ts`.
    touch('src/main.ts', LATER);
    touch('src/core/Game.ts', LATER);
    expect(distFreshness(root)).toEqual({ ok: false, reason: 'stale', newer: 'src/core/Game.ts' });
    touch('tsconfig.json', LATER);
    expect(distFreshness(root)).toEqual({ ok: false, reason: 'stale', newer: 'tsconfig.json' });
    touch('index.html', LATER);
    expect(distFreshness(root)).toEqual({ ok: false, reason: 'stale', newer: 'index.html' });
  });

  it('skips an input that does not exist', () => {
    rmSync(join(root, 'package-lock.json'));
    rmSync(join(root, 'public'), { recursive: true, force: true });
    file('dist/index.html', BUILT);
    expect(distFreshness(root)).toEqual({ ok: true });
  });
});

describe('the emitted-build title (AC-69, AC-70)', () => {
  it('says why it skips, and adds nothing when it runs', () => {
    expect(skipNote({ ok: false, reason: 'missing' })).toBe(' (skipped: dist/index.html is missing)');
    expect(skipNote({ ok: false, reason: 'stale', newer: 'src/main.ts' })).toBe(' (skipped: src/main.ts is newer than dist/)');
    expect(skipNote({ ok: true })).toBe('');
  });
});
